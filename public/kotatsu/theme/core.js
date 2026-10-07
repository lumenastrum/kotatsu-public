import { suggestName, scopeSelector } from './knobs.js';
import { derivePaletteTokens, validatePalette } from './palette.js';

export { contrastRatio, parseColor } from './color.js';

const PACK_ID_PATTERN = /^[a-z0-9-]+$/;
const TOKEN_PATTERN = /^--k-[a-z0-9-]+$/;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const FONT_DESCRIPTOR_PATTERN = /^[a-z0-9 .%+-]+$/i;
const MAX_EXTENDS_DEPTH = 4;
const PACK_VALUE_PREFIX = 'pack:';

/**
 * The component axes the `variants` layer can address (renderer v0 §2.5 #2, widened to three
 * orthogonal axes by variant-wardrobe v0 §2). Unknown KEYS beside these stay reserved and
 * ignored, exactly as `layout` is: a pack authored for a later Kotatsu must still deliver its
 * tokens, sheet, and assets.
 * @type {readonly VariantAxis[]}
 */
export const VARIANT_AXES = Object.freeze(['message', 'nameplate', 'metadata']);

/**
 * The `power_user` key each axis persists the USER's own choice in. A pack's declaration never
 * reaches these keys — `resolveVariantAxis` keeps the two layers apart on purpose, so clearing
 * a pack hands the user's own wardrobe straight back.
 * @type {Readonly<Record<VariantAxis, string>>}
 */
export const VARIANT_AXIS_SETTINGS = Object.freeze({
    message: 'kotatsu_mes_variant',
    nameplate: 'kotatsu_mes_nameplate',
    metadata: 'kotatsu_mes_metadata',
});

const TOP_LEVEL_KEYS = new Set([
    '$schema',
    'id',
    'name',
    'version',
    'extends',
    'tokens',
    'assets',
    'sheet',
    'layout',
    'variants',
    'palette',
    'author',
    'description',
]);
const REQUIRED_KEYS = ['id', 'name', 'version', 'tokens'];
const ASSET_KEYS = new Set(['fonts', 'backdrop']);
const FONT_KEYS = new Set(['family', 'src', 'weight', 'style', 'unicodeRange']);
// One or more U+ ranges: U+0000-00FF, U+0131, U+02??
const UNICODE_RANGE_PATTERN = /^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:\s*,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/i;
const RULE_CONTAINER_AT_RULES = new Set([
    'container',
    'document',
    'layer',
    'media',
    'scope',
    'starting-style',
    'supports',
]);

/**
 * @typedef {object} ThemeFont
 * @property {string} family
 * @property {string} src
 * @property {string} [weight]
 * @property {string} [style]
 * @property {string} [unicodeRange] CSS unicode-range for splitting a family across files.
 */

/**
 * @typedef {object} ThemeAssets
 * @property {ThemeFont[]} [fonts]
 * @property {string} [backdrop]
 */

/**
 * @typedef {object} ThemeManifest
 * @property {string} [$schema]
 * @property {string} id
 * @property {string} name
 * @property {1} version
 * @property {string} [extends]
 * @property {Record<string, string>} tokens
 * @property {ThemeAssets} [assets]
 * @property {string} [sheet]
 * @property {Record<string, unknown>} [layout]
 * @property {Record<string, unknown>} [variants]
 * @property {Record<string, string>} [palette] Friendly seed colours (palette.js `PALETTE_KEYS`).
 * @property {string} [author] Who made the pack.
 * @property {string} [description] One line about the pack.
 */

/**
 * @typedef {'message'|'nameplate'|'metadata'} VariantAxis
 */

/**
 * @typedef {object} VariantAxisDecision
 * @property {'pack'|'user'|'default'} source Which layer supplied the name.
 * @property {string|null} variant Requested variant name, or null for the door's own default.
 */

/**
 * @typedef {Record<VariantAxis, string|null>} VariantAxisValues
 */

/**
 * @typedef {Record<VariantAxis, VariantAxisDecision>} VariantAxisDecisions
 */

/**
 * @typedef {object} FetchedThemePack
 * @property {ThemeManifest} manifest
 * @property {string} [sheetCss]
 * @property {string} [assetBase]
 */

/**
 * @typedef {object} ValidationError
 * @property {string} path
 * @property {string} message
 */

/**
 * @typedef {object} ValidationResult
 * @property {boolean} ok
 * @property {ValidationError[]} errors
 */

/**
 * @typedef {object} ResolvedSheet
 * @property {string} id
 * @property {string} css
 */

/**
 * @typedef {object} ResolvedThemePack
 * @property {string} id
 * @property {string} name
 * @property {Record<string, string>} tokens
 * @property {ThemeFont[]} fonts
 * @property {string|null} backdrop
 * @property {ResolvedSheet[]} sheets
 * @property {Record<string, unknown>} variants
 * @property {{changed: string[], overruled: string[], derived: string[]}} [palette] What this pack's palette changed and grew (palette.js); absent without a palette.
 */

/**
 * @callback FetchManifest
 * @param {string} id
 * @returns {ThemeManifest|FetchedThemePack|null|undefined|Promise<ThemeManifest|FetchedThemePack|null|undefined>}
 */

/** @typedef {import('./color.js').ParsedColor} ParsedColor */

/**
 * @typedef {object} SheetUrlReference
 * @property {number} start First index of the URL target, excluding quotes.
 * @property {number} end First index after the URL target, excluding quotes.
 * @property {string} target Validated relative target.
 */

/**
 * Checks for a non-null, non-array object.
 *
 * @param {unknown} value Value to inspect.
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks whether an object owns a property.
 *
 * @param {object} value Object to inspect.
 * @param {PropertyKey} key Property name.
 * @returns {boolean}
 */
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Normalizes insignificant CSS whitespace for theme-token comparisons.
 *
 * @param {string} value Token value.
 * @returns {string}
 */
export function normalizeTokenValue(value) {
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * Returns only resolved token values that differ from the Blue Hour mirror.
 * Missing baseline values remain overrides so a future token cannot disappear.
 *
 * @param {Record<string, string>} tokens Resolved pack tokens.
 * @param {Record<string, string>} blueHourTokens Canonical Blue Hour mirror.
 * @returns {Record<string, string>}
 */
export function getTokenOverrides(tokens, blueHourTokens) {
    /** @type {Record<string, string>} */
    const overrides = {};

    for (const [token, value] of Object.entries(tokens)) {
        const blueHourValue = blueHourTokens[token];
        if (typeof blueHourValue !== 'string'
            || normalizeTokenValue(value) !== normalizeTokenValue(blueHourValue)) {
            overrides[token] = value;
        }
    }

    return overrides;
}

/**
 * Decides how settings should reconcile the synchronous first-paint cache.
 * A selected pack is always hydrated because the cache contains tokens only;
 * its fonts, sheet, and assets still need the full loader.
 *
 * @param {unknown} powerUserTheme Persisted power-user theme value.
 * @param {unknown} cachedId First-paint or currently applied pack id.
 * @returns {{action: 'apply'|'clear'|'noop', id: string|null}}
 */
export function reconcile(powerUserTheme, cachedId) {
    if (typeof powerUserTheme === 'string' && powerUserTheme.startsWith(PACK_VALUE_PREFIX)) {
        return { action: 'apply', id: powerUserTheme.slice(PACK_VALUE_PREFIX.length) };
    }

    if (typeof cachedId === 'string' && cachedId.length > 0) {
        return { action: 'clear', id: null };
    }

    return { action: 'noop', id: null };
}

/**
 * Reads one axis declaration out of a resolved `variants` layer.
 *
 * The variant NAME is deliberately not validated here. The renderer door owns each axis's known
 * set (`applyVariantAxis`, public/scripts/message-rows.js) and falls back with one warning, so a
 * bad name costs a warning rather than a rejected pack.
 *
 * @param {unknown} variants Resolved `variants` layer, when the pack has one.
 * @param {VariantAxis} axis Axis to read.
 * @returns {string|null} Declared name, or null when the pack declares nothing for that axis.
 */
export function readVariantAxis(variants, axis) {
    if (!isRecord(variants)) {
        return null;
    }

    const declared = variants[axis];
    return typeof declared === 'string' && declared.length > 0 ? declared : null;
}

/**
 * Reads every axis a pack declares. Axes it says nothing about read as null, never absent, so
 * callers can treat the record as total.
 *
 * @param {unknown} variants Resolved `variants` layer, when the pack has one.
 * @returns {VariantAxisValues}
 */
export function readVariantAxes(variants) {
    const values = /** @type {VariantAxisValues} */ ({});
    for (const axis of VARIANT_AXES) {
        values[axis] = readVariantAxis(variants, axis);
    }
    return values;
}

/**
 * Reads the user's own per-axis wardrobe out of a `power_user`-shaped settings object. Missing
 * keys read as null: an axis the user never chose is a default, not an empty string.
 *
 * @param {unknown} settings Persisted settings object (`power_user`).
 * @returns {VariantAxisValues}
 */
export function readUserVariantAxes(settings) {
    const values = /** @type {VariantAxisValues} */ ({});
    for (const axis of VARIANT_AXES) {
        const stored = isRecord(settings) ? settings[VARIANT_AXIS_SETTINGS[axis]] : null;
        values[axis] = typeof stored === 'string' && stored.length > 0 ? stored : null;
    }
    return values;
}

/**
 * Decides which value one axis should carry.
 *
 * Precedence, identical on every axis: the active pack's `variants.<axis>` outranks the user's
 * own persisted setting, which outranks the door's own default. A pack's declaration is a
 * property of the theme, so it is never written into `power_user.kotatsu_mes_*` — clearing the
 * pack, or selecting a pack/legacy theme that declares nothing, hands the user's own choice
 * straight back.
 *
 * Both inputs stay unvalidated on purpose: a `null` value means "apply the door's default", any
 * other string is handed to the door, which validates and warns.
 *
 * @param {unknown} packValue Value declared by the active pack, if any.
 * @param {unknown} userValue Persisted user setting, if any.
 * @returns {VariantAxisDecision}
 */
export function resolveVariantAxis(packValue, userValue) {
    if (typeof packValue === 'string' && packValue.length > 0) {
        return { source: 'pack', variant: packValue };
    }

    if (typeof userValue === 'string' && userValue.length > 0) {
        return { source: 'user', variant: userValue };
    }

    return { source: 'default', variant: null };
}

/**
 * Runs the same precedence over every axis. Axes are independent: a pack pinning `message` says
 * nothing about the user's `metadata` choice.
 *
 * @param {unknown} packValues Per-axis pack declarations (readVariantAxes).
 * @param {unknown} userValues Per-axis user settings (readUserVariantAxes).
 * @returns {VariantAxisDecisions}
 */
export function resolveVariantAxes(packValues, userValues) {
    const decisions = /** @type {VariantAxisDecisions} */ ({});
    for (const axis of VARIANT_AXES) {
        decisions[axis] = resolveVariantAxis(
            isRecord(packValues) ? packValues[axis] : null,
            isRecord(userValues) ? userValues[axis] : null,
        );
    }
    return decisions;
}

/**
 * Adds a validation failure.
 *
 * @param {ValidationError[]} errors Error accumulator.
 * @param {string} path Manifest path.
 * @param {string} message Failure description.
 */
function addError(errors, path, message) {
    errors.push({ path, message });
}

/**
 * Formats an arbitrary object key as a path segment.
 *
 * @param {string} base Parent path.
 * @param {string} key Object key.
 * @returns {string}
 */
function keyPath(base, key) {
    return /^[a-z_$][a-z0-9_$]*$/i.test(key)
        ? `${base}.${key}`
        : `${base}[${JSON.stringify(key)}]`;
}

/**
 * Returns whether a path remains inside its pack folder and is not a URL.
 * Pack paths use URL separators even when authoring on Windows.
 *
 * @param {unknown} value Candidate path.
 * @returns {value is string}
 */
function isLocalPackPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
        return false;
    }

    if (URI_SCHEME_PATTERN.test(value) || value.startsWith('/') || value.startsWith('\\')
        || value.includes('%') || /[\u0000-\u001f\u007f]/.test(value)) {
        return false;
    }

    if (value.includes('\\')) {
        return false;
    }

    const pathname = value.split(/[?#]/, 1)[0];
    return pathname.length > 0
        && pathname.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Validates a local pack path and appends a useful error if it is unsafe.
 *
 * @param {unknown} value Candidate path.
 * @param {string} path Manifest path.
 * @param {ValidationError[]} errors Error accumulator.
 */
function validateLocalPackPath(value, path, errors) {
    if (!isLocalPackPath(value)) {
        addError(errors, path, 'must be a relative path inside the pack; URLs, absolute paths, and traversal are not allowed');
    }
}

/**
 * Hand-written validation shared by the public validator and the resolver.
 * A null token set performs structural validation without inventing a token
 * registry for resolvePack(), whose callback intentionally only returns packs.
 *
 * @param {unknown} manifest Candidate manifest.
 * @param {Set<string>|null} knownTokens Allowed token names, or null to skip the registry check.
 * @returns {ValidationResult}
 */
function validateManifestShape(manifest, knownTokens) {
    /** @type {ValidationError[]} */
    const errors = [];

    if (!isRecord(manifest)) {
        addError(errors, '$', 'must be an object');
        return { ok: false, errors };
    }

    for (const key of Object.keys(manifest)) {
        if (!TOP_LEVEL_KEYS.has(key)) {
            addError(errors, keyPath('$', key), 'is not an allowed property');
        }
    }

    for (const key of REQUIRED_KEYS) {
        if (!hasOwn(manifest, key)) {
            addError(errors, keyPath('$', key), 'is required');
        }
    }

    if (hasOwn(manifest, '$schema') && (typeof manifest.$schema !== 'string' || manifest.$schema.length === 0)) {
        addError(errors, '$.$schema', 'must be a non-empty string');
    }

    if (hasOwn(manifest, 'id') && (typeof manifest.id !== 'string' || !PACK_ID_PATTERN.test(manifest.id))) {
        addError(errors, '$.id', 'must match [a-z0-9-]+');
    }

    if (hasOwn(manifest, 'name') && (typeof manifest.name !== 'string' || manifest.name.length === 0)) {
        addError(errors, '$.name', 'must be a non-empty string');
    }

    if (hasOwn(manifest, 'version') && manifest.version !== 1) {
        addError(errors, '$.version', 'must be 1');
    }

    if (hasOwn(manifest, 'extends')) {
        if (typeof manifest.extends !== 'string' || !PACK_ID_PATTERN.test(manifest.extends)) {
            addError(errors, '$.extends', 'must match [a-z0-9-]+');
        } else if (manifest.extends === manifest.id) {
            addError(errors, '$.extends', 'must not reference its own id (inheritance cycle)');
        }
    }

    if (hasOwn(manifest, 'tokens')) {
        if (!isRecord(manifest.tokens)) {
            addError(errors, '$.tokens', 'must be an object');
        } else {
            for (const [token, value] of Object.entries(manifest.tokens)) {
                const path = keyPath('$.tokens', token);
                if (!TOKEN_PATTERN.test(token)) {
                    addError(errors, path, 'must be a --k-* token name');
                } else if (knownTokens && !knownTokens.has(token)) {
                    const suggestion = suggestName(token, knownTokens);
                    addError(errors, path, `is not a known token${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`);
                }

                if (typeof value !== 'string' || value.length === 0) {
                    addError(errors, path, 'must have a non-empty string value');
                } else {
                    const problem = validateTokenValue(value);
                    if (problem) addError(errors, path, problem);
                }
            }
        }
    }

    if (hasOwn(manifest, 'palette')) {
        for (const [path, message] of validatePalette(manifest.palette)) addError(errors, path, message);
    }

    for (const key of ['author', 'description']) {
        if (hasOwn(manifest, key) && (typeof manifest[key] !== 'string' || manifest[key].length === 0)) {
            addError(errors, `$.${key}`, 'must be a non-empty string');
        }
    }

    if (hasOwn(manifest, 'assets')) {
        if (!isRecord(manifest.assets)) {
            addError(errors, '$.assets', 'must be an object');
        } else {
            for (const key of Object.keys(manifest.assets)) {
                if (!ASSET_KEYS.has(key)) {
                    addError(errors, keyPath('$.assets', key), 'is not an allowed property');
                }
            }

            if (hasOwn(manifest.assets, 'fonts')) {
                if (!Array.isArray(manifest.assets.fonts)) {
                    addError(errors, '$.assets.fonts', 'must be an array');
                } else {
                    manifest.assets.fonts.forEach((font, index) => {
                        const path = `$.assets.fonts[${index}]`;
                        if (!isRecord(font)) {
                            addError(errors, path, 'must be an object');
                            return;
                        }

                        for (const key of Object.keys(font)) {
                            if (!FONT_KEYS.has(key)) {
                                addError(errors, keyPath(path, key), 'is not an allowed property');
                            }
                        }

                        for (const key of ['family', 'src']) {
                            if (!hasOwn(font, key)) {
                                addError(errors, keyPath(path, key), 'is required');
                            }
                        }

                        if (hasOwn(font, 'family') && (typeof font.family !== 'string' || font.family.length === 0)) {
                            addError(errors, `${path}.family`, 'must be a non-empty string');
                        }

                        if (hasOwn(font, 'src')) {
                            validateLocalPackPath(font.src, `${path}.src`, errors);
                        }

                        for (const key of ['weight', 'style']) {
                            if (hasOwn(font, key) && (typeof font[key] !== 'string' || font[key].length === 0)) {
                                addError(errors, keyPath(path, key), 'must be a non-empty string');
                            } else if (hasOwn(font, key) && !FONT_DESCRIPTOR_PATTERN.test(/** @type {string} */ (font[key]))) {
                                addError(errors, keyPath(path, key), 'contains unsupported CSS descriptor characters');
                            }
                        }

                        // Lets one family be split across files by script (latin, latin-ext...), the
                        // way font services ship them; without it the last @font-face wins outright.
                        if (hasOwn(font, 'unicodeRange')
                            && (typeof font.unicodeRange !== 'string' || !UNICODE_RANGE_PATTERN.test(font.unicodeRange))) {
                            addError(errors, `${path}.unicodeRange`, 'must be a list of U+ ranges, like "U+0000-00FF, U+0131"');
                        }
                    });
                }
            }

            if (hasOwn(manifest.assets, 'backdrop')) {
                validateLocalPackPath(manifest.assets.backdrop, '$.assets.backdrop', errors);
            }
        }
    }

    if (hasOwn(manifest, 'sheet')) {
        validateLocalPackPath(manifest.sheet, '$.sheet', errors);
    }

    // `layout` is still reserved: any object shape is accepted and the loader ignores it.
    if (hasOwn(manifest, 'layout') && !isRecord(manifest.layout)) {
        addError(errors, '$.layout', 'must be an object');
    }

    // `variants` is live for all three axes (renderer v0 §2.5 #2, wardrobe v0 §2). Only the
    // SHAPE is checked here — an unknown variant NAME is not a manifest error, because the
    // renderer door owns each known set and already falls back with one warning. A pack
    // authored against a newer variant set must still deliver its tokens, sheet, and assets.
    // Unknown component keys stay allowed for the same reason.
    if (hasOwn(manifest, 'variants')) {
        if (!isRecord(manifest.variants)) {
            addError(errors, '$.variants', 'must be an object');
        } else {
            const variants = manifest.variants;
            for (const axis of VARIANT_AXES) {
                if (hasOwn(variants, axis)
                    && (typeof variants[axis] !== 'string'
                        || /** @type {string} */ (variants[axis]).length === 0)) {
                    addError(errors, `$.variants.${axis}`, 'must be a non-empty string');
                }
            }
        }
    }

    return { ok: errors.length === 0, errors };
}

/**
 * Validates a v0 theme manifest against its fixed shape and the core token ABI.
 *
 * @param {unknown} manifest Candidate manifest.
 * @param {Iterable<string>} knownTokens Token names declared by tokens.css.
 * @returns {ValidationResult}
 */
export function validateManifest(manifest, knownTokens) {
    const tokenSet = knownTokens instanceof Set ? knownTokens : new Set(knownTokens);
    return validateManifestShape(manifest, tokenSet);
}

/**
 * Narrows a callback result to the wrapper form.
 *
 * @param {ThemeManifest|FetchedThemePack} value Callback result.
 * @returns {value is FetchedThemePack}
 */
function isFetchedThemePack(value) {
    return isRecord(value) && hasOwn(value, 'manifest');
}

/**
 * Joins a validated relative asset path to the defining pack's asset base.
 * Root-relative URL bases are normalized without depending on document.location.
 *
 * @param {string} relativePath Validated pack-relative path.
 * @param {string|undefined} assetBase Base URL supplied by the callback.
 * @returns {string}
 */
function resolveAssetPath(relativePath, assetBase) {
    if (!assetBase) {
        return relativePath;
    }

    const base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;
    if (URI_SCHEME_PATTERN.test(base)) {
        const resolved = new URL(relativePath, base);
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    }

    if (base.startsWith('/')) {
        const resolved = new URL(relativePath, `https://kotatsu.invalid${base}`);
        return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    }

    return `${base}${relativePath.replace(/^\.\//, '')}`;
}

/**
 * Returns whether a URL is a normalized same-origin path. These paths only
 * appear after rebasing; authored sheet URLs still go through the stricter
 * pack-relative policy in rebaseSheetUrls().
 *
 * @param {string} value URL target.
 * @returns {boolean}
 */
function isSafeRootRelativeUrl(value) {
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
        return false;
    }

    const pathname = value.split(/[?#]/, 1)[0];
    let decodedPathname;
    try {
        decodedPathname = decodeURIComponent(pathname);
    } catch {
        return false;
    }

    if (decodedPathname.includes('%') || decodedPathname.includes('\\')) {
        return false;
    }

    return decodedPathname.slice(1).split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Resolves a pack and its single-inheritance chain. The callback may be sync or
 * async and may return a raw manifest when no sheet/base metadata is needed.
 *
 * Extends depth counts parent hops: the requested pack is depth 0, and up to
 * four parents are allowed. Assets are rebased before merging so inherited
 * assets continue to point at the pack that defines them, and the `variants`
 * layer merges per component the way tokens merge per token.
 *
 * A palette grows against the colours the page would really show underneath the pack: the
 * parent's resolved tokens over `baseline` (the core tokens every page falls back to, Blue Hour's
 * :root). Without it a pack with no `extends` grew against nothing, so every recipe reading the
 * ground or the panels got no colour and was skipped.
 *
 * @param {string} id Requested pack id.
 * @param {FetchManifest} fetchManifest Manifest/content provider.
 * @param {{baseline?: Record<string, string>}} [options] `baseline`: the core token values (tokens.css :root).
 * @returns {Promise<ResolvedThemePack>}
 */
export async function resolvePack(id, fetchManifest, { baseline = {} } = {}) {
    if (!PACK_ID_PATTERN.test(id)) {
        throw new Error(`Invalid theme pack id "${id}"`);
    }

    /** @type {string[]} */
    const stack = [];

    /**
     * @param {string} currentId Pack being resolved.
     * @param {number} depth Number of parent hops from the requested pack.
     * @param {string|null} requestedBy Child id, when resolving a parent.
     * @returns {Promise<ResolvedThemePack>}
     */
    async function visit(currentId, depth, requestedBy) {
        if (depth > MAX_EXTENDS_DEPTH) {
            throw new Error(`Invalid theme pack "${requestedBy ?? currentId}": $.extends inheritance exceeds ${MAX_EXTENDS_DEPTH} parent hops at "${currentId}"`);
        }

        const cycleStart = stack.indexOf(currentId);
        if (cycleStart !== -1) {
            const cycle = [...stack.slice(cycleStart), currentId].join(' -> ');
            throw new Error(`Invalid theme pack "${stack.at(-1) ?? currentId}": $.extends creates an inheritance cycle: ${cycle}`);
        }

        stack.push(currentId);
        try {
            const fetched = await fetchManifest(currentId);
            if (fetched == null) {
                if (requestedBy) {
                    throw new Error(`Invalid theme pack "${requestedBy}": $.extends: Unknown parent theme pack "${currentId}"`);
                }
                throw new Error(`Unknown theme pack "${currentId}"`);
            }

            const wrapped = isFetchedThemePack(fetched);
            const candidate = wrapped ? fetched.manifest : fetched;
            const sheetCss = wrapped ? fetched.sheetCss : undefined;
            const assetBase = wrapped ? fetched.assetBase : undefined;

            if (assetBase !== undefined && typeof assetBase !== 'string') {
                throw new Error(`Invalid manifest provider result for "${currentId}": assetBase must be a string`);
            }

            if (sheetCss !== undefined && typeof sheetCss !== 'string') {
                throw new Error(`Invalid manifest provider result for "${currentId}": sheetCss must be a string`);
            }

            const validation = validateManifestShape(candidate, null);
            if (!validation.ok) {
                const details = validation.errors.map(error => `${error.path}: ${error.message}`).join('; ');
                throw new Error(`Invalid theme pack "${currentId}": ${details}`);
            }

            const manifest = /** @type {ThemeManifest} */ (candidate);
            if (manifest.id !== currentId) {
                throw new Error(`Invalid theme pack "${currentId}": $.id must equal "${currentId}"`);
            }

            /** @type {ResolvedThemePack|null} */
            let parent = null;
            if (manifest.extends) {
                parent = await visit(manifest.extends, depth + 1, manifest.id);
            }

            /** @type {ThemeFont[]} */
            let fonts = parent ? parent.fonts.map(font => ({ ...font })) : [];
            /** @type {string|null} */
            let backdrop = parent?.backdrop ?? null;

            const ownFonts = manifest.assets?.fonts;
            if (ownFonts) {
                fonts = ownFonts.map(font => ({
                    ...font,
                    src: resolveAssetPath(font.src, assetBase),
                }));
            }

            const ownBackdrop = manifest.assets?.backdrop;
            if (ownBackdrop !== undefined) {
                backdrop = resolveAssetPath(ownBackdrop, assetBase);
            }

            const sheets = parent ? parent.sheets.map(sheet => ({ ...sheet })) : [];
            if (manifest.sheet) {
                if (sheetCss === undefined) {
                    throw new Error(`Invalid theme pack "${currentId}": $.sheet declares a file but its provider returned no sheetCss`);
                }

                try {
                    const rebasedSheetCss = rebaseSheetUrls(sheetCss, assetBase ?? '');
                    prefixSheet(rebasedSheetCss, manifest.id);
                    sheets.push({ id: manifest.id, css: rebasedSheetCss });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    throw new Error(`Invalid theme pack "${currentId}": $.sheet: ${message}`);
                }
            }

            // Tokens, in precedence order: the parent's finished tokens, then what this pack's
            // palette grows into (palette.js), then the tokens it writes by hand. url() values
            // are rebased to THIS pack's folder before anything inherits them, like assets are.
            const ownTokens = rebaseTokenUrls(manifest.tokens, assetBase);
            const grown = isRecord(manifest.palette)
                ? derivePaletteTokens(/** @type {Record<string, string>} */ (manifest.palette), { ...baseline, ...(parent?.tokens ?? {}) }, ownTokens)
                : null;

            return {
                id: manifest.id,
                name: manifest.name,
                tokens: { ...(parent?.tokens ?? {}), ...(grown?.tokens ?? {}), ...ownTokens },
                // Only present when this pack has a palette, so palette-free packs resolve to
                // exactly the shape they always did. theme:check reports from it.
                palette: grown ? { changed: grown.changed, overruled: grown.overruled, derived: grown.derived } : undefined,
                fonts,
                backdrop,
                sheets,
                // Per-component merge, exactly like tokens: a child that says nothing about a
                // component keeps its parent's declaration, and declaring one overrides it.
                variants: {
                    ...(parent?.variants ?? {}),
                    ...(isRecord(manifest.variants) ? manifest.variants : {}),
                },
            };
        } finally {
            stack.pop();
        }
    }

    return visit(id, 0, null);
}

/**
 * Skips a CSS block comment.
 *
 * @param {string} css Stylesheet text.
 * @param {number} start Index of the opening slash.
 * @returns {number} First index after the comment, or css.length when unclosed.
 */
function skipComment(css, start) {
    const end = css.indexOf('*/', start + 2);
    return end === -1 ? css.length : end + 2;
}

/**
 * Finds a top-level terminator while respecting strings, comments, brackets,
 * and functional notation.
 *
 * @param {string} css Stylesheet text.
 * @param {number} start Search start.
 * @returns {{ index: number, terminator: string|null }}
 */
function findPreludeEnd(css, start) {
    let quote = '';
    let parentheses = 0;
    let brackets = 0;

    for (let index = start; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '(') {
            parentheses++;
        } else if (character === ')') {
            parentheses = Math.max(0, parentheses - 1);
        } else if (character === '[') {
            brackets++;
        } else if (character === ']') {
            brackets = Math.max(0, brackets - 1);
        } else if (parentheses === 0 && brackets === 0 && (character === '{' || character === ';')) {
            return { index, terminator: character };
        }
    }

    return { index: css.length, terminator: null };
}

/**
 * Finds the brace matching an already-located opening brace.
 *
 * @param {string} css Stylesheet text.
 * @param {number} open Opening-brace index.
 * @returns {number}
 */
function findMatchingBrace(css, open) {
    let depth = 1;
    let quote = '';

    for (let index = open + 1; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '{') {
            depth++;
        } else if (character === '}') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }

    throw new Error('Malformed pack sheet: unclosed rule block');
}

/**
 * Splits a selector list without treating commas inside functions or attribute
 * selectors as list separators.
 *
 * @param {string} selectorText Selector prelude.
 * @returns {string[]}
 */
function splitSelectorList(selectorText) {
    /** @type {string[]} */
    const selectors = [];
    let start = 0;
    let quote = '';
    let parentheses = 0;
    let brackets = 0;

    for (let index = 0; index < selectorText.length; index++) {
        const character = selectorText[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && selectorText[index + 1] === '*') {
            index = skipComment(selectorText, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '(') {
            parentheses++;
        } else if (character === ')') {
            parentheses = Math.max(0, parentheses - 1);
        } else if (character === '[') {
            brackets++;
        } else if (character === ']') {
            brackets = Math.max(0, brackets - 1);
        } else if (character === ',' && parentheses === 0 && brackets === 0) {
            selectors.push(selectorText.slice(start, index).trim());
            start = index + 1;
        }
    }

    selectors.push(selectorText.slice(start).trim());
    if (selectors.some(selector => selector.length === 0)) {
        throw new Error('Malformed pack sheet: empty selector');
    }
    return selectors;
}

/**
 * Rejects CSS import at-rules outside strings/comments, including attempts nested in other
 * blocks. Imports are forbidden even when they point at a local URL.
 *
 * @param {string} css Stylesheet text.
 * @returns {boolean}
 */
function containsImport(css) {
    let quote = '';
    for (let index = 0; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }

        if (character === '@' && /^@import(?:\s|[('";]|$)/i.test(css.slice(index))) {
            return true;
        }
    }
    return false;
}

/**
 * Detects CSS escapes outside strings and comments. v0 rejects structural
 * escapes rather than attempting to decode disguised at-rules or functions.
 *
 * @param {string} css Stylesheet text.
 * @returns {boolean}
 */
function containsStructuralEscape(css) {
    let quote = '';
    for (let index = 0; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '\\') {
            return true;
        }
    }

    return false;
}

/**
 * Finds strings and comments the browser would read differently from the scanners in this file.
 * Every scanner here treats a quoted string as running to its closing quote, but CSS ends a
 * string at a raw line break (a "bad string"), and the text after it is parsed as CSS again: a
 * sheet could hide whole rules, and url()s the URL policy never sees, inside what looks like one
 * string here. So a string must close on the line it opens on, and neither a string nor a comment
 * may run off the end of the sheet.
 *
 * @param {string} css Stylesheet text.
 * @returns {string|null} A plain-language problem, or null.
 */
function findBrokenStringOrComment(css) {
    let quote = '';
    for (let index = 0; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                // An escaped line break is a legal continuation inside a CSS string.
                if (css[index + 1] === '\r' && css[index + 2] === '\n') index++;
                index++;
            } else if (character === quote) {
                quote = '';
            } else if (character === '\n' || character === '\r' || character === '\f') {
                return 'Pack sheets may not break a quoted string across lines; close the quote on the same line';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            const end = css.indexOf('*/', index + 2);
            if (end === -1) return 'Pack sheets may not end inside an unclosed /* comment';
            index = end + 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
        }
    }
    return quote ? 'Pack sheets may not end inside an unclosed quoted string' : null;
}

/**
 * Finds the closing parenthesis for a CSS function call.
 *
 * @param {string} css Stylesheet text.
 * @param {number} open Opening-parenthesis index.
 * @returns {number} Matching index, or -1 when the call is unclosed.
 */
function findClosingParenthesis(css, open) {
    let depth = 1;
    let quote = '';

    for (let index = open + 1; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
        } else if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

/**
 * Detects CSS image/source functions whose inputs can become fetchable without
 * a literal url(). v0 rejects the functions themselves so var() substitution
 * cannot smuggle a remote string past the URL scanner.
 *
 * @param {string} css Stylesheet text.
 * @returns {boolean}
 */
function containsDynamicSourceFunction(css) {
    let quote = '';
    for (let index = 0; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }

        const previous = css[index - 1] ?? '';
        if (/^(?:(?:-webkit-)?image-set|image|src)\s*\(/i.test(css.slice(index))
            && !/[-_a-z0-9]/i.test(previous)) return true;
    }

    return false;
}

/**
 * Finds and validates every URL function target in a sheet. Reusing the
 * manifest path policy rejects CSS escapes, empty segments, and traversal,
 * which prevents a sheet from disguising an external scheme. Fragment-only
 * references are validated but omitted because they must never be rebased.
 *
 * @param {string} css Stylesheet text.
 * @param {boolean} [allowRebased=false] Whether normalized root-relative outputs are accepted.
 * @returns {SheetUrlReference[]}
 */
function collectSheetUrls(css, allowRebased = false) {
    const brokenToken = findBrokenStringOrComment(css);
    if (brokenToken) {
        throw new Error(brokenToken);
    }
    if (containsStructuralEscape(css)) {
        throw new Error('Pack sheets may not use CSS escapes outside strings or comments');
    }
    if (containsDynamicSourceFunction(css)) {
        throw new Error('Pack sheets must use url() rather than dynamic image/source functions');
    }

    /** @type {SheetUrlReference[]} */
    const references = [];
    let quote = '';
    for (let index = 0; index < css.length; index++) {
        const character = css[index];
        if (quote) {
            if (character === '\\') {
                index++;
            } else if (character === quote) {
                quote = '';
            }
            continue;
        }

        if (character === '/' && css[index + 1] === '*') {
            index = skipComment(css, index) - 1;
            continue;
        }

        if (character === '"' || character === '\'') {
            quote = character;
            continue;
        }

        const previous = css[index - 1] ?? '';
        const match = /^url\s*\(/i.exec(css.slice(index));
        if (!match || /[-_a-z0-9]/i.test(previous)) {
            continue;
        }

        const open = index + match[0].lastIndexOf('(');
        const close = findClosingParenthesis(css, open);
        if (close === -1) {
            throw new Error('Pack sheets may only reference relative URLs inside the pack');
        }

        let targetStart = open + 1;
        let targetEnd = close;
        while (/\s/.test(css[targetStart] ?? '')) targetStart++;
        while (targetEnd > targetStart && /\s/.test(css[targetEnd - 1])) targetEnd--;

        const first = css[targetStart];
        const quoted = first === '"' || first === '\'';
        if (quoted) {
            if (css[targetEnd - 1] !== first) {
                throw new Error('Pack sheets may only reference relative URLs inside the pack');
            }
            targetStart++;
            targetEnd--;
        }

        const target = css.slice(targetStart, targetEnd);
        const invalidSyntax = target.includes('(')
            || target.includes(')')
            || target.includes('"')
            || target.includes('\'')
            || target.includes('/*')
            || target.includes('*/')
            || /[\r\n\f]/.test(target)
            || (!quoted && /\s/.test(target));
        const fragmentOnly = /^#[a-z0-9_.:-]+$/i.test(target);
        const localPath = fragmentOnly || isLocalPackPath(target);
        const rebasedPath = allowRebased && isSafeRootRelativeUrl(target);
        if (invalidSyntax || (!localPath && !rebasedPath)) {
            throw new Error('Pack sheets may only reference relative URLs inside the pack');
        }

        if (localPath && !fragmentOnly) {
            references.push({ start: targetStart, end: targetEnd, target });
        }
        index = close;
    }

    return references;
}

/**
 * Returns every validated pack-relative file referenced by url() in a sheet.
 * Fragment-only references are intentionally omitted.
 *
 * @param {string} css Pack sheet source.
 * @returns {string[]} Pack-relative asset paths in source order.
 */
export function getSheetAssetPaths(css) {
    if (typeof css !== 'string') {
        throw new TypeError('Pack sheet must be a string');
    }

    return collectSheetUrls(css).map(reference => reference.target.split(/[?#]/, 1)[0]);
}

/**
 * Rewrites validated relative URL targets against the defining pack's asset
 * base. Quote style and surrounding whitespace remain unchanged, while
 * fragment-only references are returned byte-for-byte.
 *
 * @param {string} css Pack sheet source.
 * @param {string} assetBase Defining pack's asset base URL, or an empty string to validate only.
 * @returns {string} Sheet with defining-pack asset URLs.
 */
export function rebaseSheetUrls(css, assetBase) {
    if (typeof css !== 'string') {
        throw new TypeError('Pack sheet must be a string');
    }
    if (typeof assetBase !== 'string') {
        throw new TypeError('Pack sheet asset base must be a string');
    }

    const references = collectSheetUrls(css);
    let output = css;
    for (let index = references.length - 1; index >= 0; index--) {
        const reference = references[index];
        const target = resolveAssetPath(reference.target, assetBase);
        output = `${output.slice(0, reference.start)}${target}${output.slice(reference.end)}`;
    }
    return output;
}

/**
 * Checks that a token or knob value is ONE CSS value and nothing more. Values only ever reach the
 * page through `style.setProperty()` (on <html>, or on a CSSOM rule for component knobs — see
 * knobs.js `writeKnobRules`), which already confines them to one declaration; this is the second
 * layer, and the one that speaks to authors. A value must not be able to close its declaration or
 * its rule, smuggle `!important`, or fetch anything but a file inside its own pack. `url()`
 * targets follow the sheet policy (relative, inside the pack, no escapes); they are rebased to the
 * pack's folder when the pack resolves.
 *
 * Control characters are checked before anything else. Line breaks and tabs are plain whitespace
 * to CSS outside quotes, so older packs that wrap a long value across lines keep working (Andres,
 * 2026-10-06). Inside a quoted string a raw line break ENDS the string in CSS, so a value scanned
 * as "one quoted string" here could be several tokens to the browser: refused there. Every other
 * control character is refused anywhere.
 *
 * @param {string} value Token value as written in the manifest.
 * @returns {string|null} A plain-language problem, or null when the value is safe.
 */
export function validateTokenValue(value) {
    if (value.length > 4000) return 'is too long for one value (4000 characters at most)';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
        return 'must not contain control characters (only spaces, tabs and line breaks are allowed)';
    }
    let openQuote = '';
    for (const character of value) {
        if (openQuote) {
            // Tabs don't end a CSS string, but no value needs one inside quotes: refused too, so the
            // only whitespace a quoted text can hold is a plain space.
            if (character === '\n' || character === '\r' || character === '\t') {
                return 'must not break a line inside quotes: keep each quoted text on one line';
            }
            if (character === openQuote) openQuote = '';
        } else if (character === '"' || character === '\'') {
            openQuote = character;
        }
    }
    if (/[;{}<>!@]/.test(value.replace(/"[^"]*"|'[^']*'/g, '""'))) {
        return 'must be a single CSS value: no ; { } < > ! or @ outside quotes';
    }
    if (value.includes('\\')) return 'must not contain backslashes';
    // An unclosed comment would swallow the rest of the generated knob sheet.
    if (value.includes('/*') || value.includes('*/')) return 'must not contain CSS comments (/* */)';
    let depth = 0;
    let quote = '';
    for (const character of value) {
        if (quote) {
            if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === '\'') quote = character;
        else if (character === '(') depth++;
        else if (character === ')' && --depth < 0) break;
    }
    if (quote || depth !== 0) return 'has an unclosed quote or bracket';
    try {
        collectSheetUrls(value);
    } catch {
        return 'may only use url() for files inside your pack folder, like url("textures/wood.svg")';
    }
    return null;
}

/**
 * Rebases every pack-relative `url()` in a token map to the defining pack's folder.
 *
 * @param {Record<string, string>} tokens Validated tokens.
 * @param {string|undefined} assetBase The defining pack's asset base.
 * @returns {Record<string, string>}
 */
function rebaseTokenUrls(tokens, assetBase) {
    if (!assetBase) return { ...tokens };
    /** @type {Record<string, string>} */
    const rebased = {};
    for (const [name, value] of Object.entries(tokens)) {
        rebased[name] = /url\s*\(/i.test(value) ? rebaseSheetUrls(value, assetBase) : value;
    }
    return rebased;
}

/**
 * Prefixes qualified rules in one stylesheet/rule-list level.
 *
 * @param {string} css Stylesheet or nested rule list.
 * @param {string} scope Pack id; each selector is scoped with knobs.js `scopeSelector`.
 * @returns {string}
 */
function prefixRuleList(css, scope) {
    let output = '';
    let cursor = 0;

    while (cursor < css.length) {
        const triviaStart = cursor;
        let advanced = true;
        while (advanced && cursor < css.length) {
            advanced = false;
            while (/\s/.test(css[cursor] ?? '')) {
                cursor++;
                advanced = true;
            }
            if (css[cursor] === '/' && css[cursor + 1] === '*') {
                cursor = skipComment(css, cursor);
                advanced = true;
            }
        }
        output += css.slice(triviaStart, cursor);

        if (cursor >= css.length) {
            break;
        }

        const ruleStart = cursor;
        const preludeEnd = findPreludeEnd(css, cursor);
        if (preludeEnd.terminator === null) {
            throw new Error('Malformed pack sheet: rule has no block');
        }

        if (css[cursor] === '@') {
            const nameMatch = /^@([-\w]+)/.exec(css.slice(cursor));
            if (!nameMatch) {
                throw new Error('Malformed pack sheet: invalid at-rule');
            }
            const name = nameMatch[1].toLowerCase();

            if (name === 'import') {
                throw new Error('Pack sheets may not contain @import');
            }

            if (preludeEnd.terminator === ';') {
                output += css.slice(ruleStart, preludeEnd.index + 1);
                cursor = preludeEnd.index + 1;
                continue;
            }

            const close = findMatchingBrace(css, preludeEnd.index);
            if (RULE_CONTAINER_AT_RULES.has(name)) {
                output += css.slice(ruleStart, preludeEnd.index + 1);
                output += prefixRuleList(css.slice(preludeEnd.index + 1, close), scope);
                output += '}';
            } else {
                output += css.slice(ruleStart, close + 1);
            }
            cursor = close + 1;
            continue;
        }

        if (preludeEnd.terminator !== '{') {
            throw new Error('Malformed pack sheet: qualified rule has no block');
        }

        const close = findMatchingBrace(css, preludeEnd.index);
        const selectorWithSpace = css.slice(ruleStart, preludeEnd.index);
        const trailingSpace = /\s*$/.exec(selectorWithSpace)?.[0] ?? '';
        const selectorText = selectorWithSpace.slice(0, selectorWithSpace.length - trailingSpace.length);
        const selectors = splitSelectorList(selectorText);
        output += selectors.map(selector => scopeSelector(selector, scope)).join(', ');
        output += trailingSpace;
        output += css.slice(preludeEnd.index, close + 1);
        cursor = close + 1;
    }

    return output;
}

/**
 * Scopes every qualified rule in a pack sheet to its active theme id. Rule-list
 * at-rules are traversed; font descriptors and all keyframe blocks are
 * preserved byte-for-byte. Any CSS import at-rule is rejected.
 *
 * @param {string} css Pack sheet source.
 * @param {string} id Pack id used by body[data-k-theme].
 * @returns {string} Scoped stylesheet.
 */
export function prefixSheet(css, id) {
    if (typeof css !== 'string') {
        throw new TypeError('Pack sheet must be a string');
    }
    if (!PACK_ID_PATTERN.test(id)) {
        throw new Error(`Invalid theme pack id "${id}"`);
    }
    if (containsImport(css)) {
        throw new Error('Pack sheets may not contain @import');
    }
    collectSheetUrls(css, true);

    return prefixRuleList(css, id);
}

