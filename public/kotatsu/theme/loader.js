import { saveSettingsDebounced } from '../../script.js';
import { applyVariantAxis, getVariantAxis, isVariantAxisValue } from '../../scripts/message-rows.js';
import { power_user } from '../../scripts/power-user.js';
import { eventSource, event_types } from '../../scripts/events.js';
import {
    getTokenOverrides,
    prefixSheet,
    readUserVariantAxes,
    readVariantAxes,
    reconcile,
    resolvePack,
    resolveVariantAxes,
    validateManifest,
    VARIANT_AXES,
    VARIANT_AXIS_SETTINGS,
} from './core.js';
import { initProseScale } from './prose-scale.js';
import { initWardrobePicker, renderWardrobePicker } from './wardrobe.js';

const CACHE_KEY = 'kotatsu.theme';
const PACK_VALUE_PREFIX = 'pack:';
const PACK_GROUP_LABEL = 'Kotatsu packs';
const BLUE_HOUR_ID = 'blue-hour';
const LEGACY_TOKEN_PINS = [
    '--k-text',
    '--k-italics',
    '--k-underline',
    '--k-quote',
    '--k-surface',
    '--k-chat-tint',
    '--k-user-mes',
    '--k-bot-mes',
    '--k-shadow',
    '--k-border',
];
const SMART_THEME_PINS = [
    '--SmartThemeBodyColor',
    '--SmartThemeEmColor',
    '--SmartThemeUnderlineColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeBlurTintColor',
    '--SmartThemeChatTintColor',
    '--SmartThemeUserMesBlurTintColor',
    '--SmartThemeBotMesBlurTintColor',
    '--SmartThemeShadowColor',
    '--SmartThemeBorderColor',
];
const ALL_LEGACY_PINS = [...LEGACY_TOKEN_PINS, ...SMART_THEME_PINS];

/**
 * @typedef {object} ThemeListing
 * @property {string} id
 * @property {string} name
 * @property {'builtin'|'user'} source
 * @property {string} [extends]
 */

/**
 * @typedef {object} ResolvedFont
 * @property {string} family
 * @property {string} src
 * @property {string} [weight]
 * @property {string} [style]
 */

/**
 * @typedef {object} ResolvedThemePack
 * @property {string} id
 * @property {string} name
 * @property {Record<string, string>} tokens
 * @property {ResolvedFont[]} fonts
 * @property {string|null} backdrop
 * @property {{id: string, css: string}[]} sheets
 * @property {Record<string, unknown>} [variants]
 */

/** @type {ThemeListing[]} */
let packListings = [];
/** @type {Set<string>} */
const activeTokenNames = new Set();
/** @type {Set<string>} */
const ignoredLayerNotices = new Set();
/** @type {import('./core.js').VariantAxisValues} Axes declared by the pack currently applied. */
let activePackVariants = readVariantAxes(null);
/** @type {Promise<Set<string>>|null} */
let knownTokensPromise = null;
/** @type {Promise<Record<string, string>>|null} */
let blueHourTokensPromise = null;
/** @type {string|null} */
let currentPackId = null;
/** @type {Map<string, {value: string, priority: string}>|null} */
let legacyPinSnapshot = null;
let loadRevision = 0;
let initialized = false;

/**
 * Escapes a value for a double-quoted CSS string.
 * @param {string} value
 * @returns {string}
 */
function escapeCssString(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/[\n\r\f]/g, '\\a ');
}

/**
 * Converts a validated pack-relative path to a URL below an asset base.
 * @param {string} base
 * @param {string} relativePath
 * @returns {string}
 */
function assetUrl(base, relativePath) {
    const suffixIndex = relativePath.search(/[?#]/);
    const pathname = suffixIndex === -1 ? relativePath : relativePath.slice(0, suffixIndex);
    const suffix = suffixIndex === -1 ? '' : relativePath.slice(suffixIndex);
    const encodedPath = pathname.split('/').map(segment => encodeURIComponent(segment)).join('/');
    return `${base}${encodedPath}${suffix}`;
}

/**
 * Gets the declaration block belonging to the first `:root` rule.
 * @param {string} css
 * @returns {string}
 */
function getRootBlock(css) {
    const rootRule = /^\s*:root\s*\{/m.exec(css);
    const openIndex = rootRule ? rootRule.index + rootRule[0].lastIndexOf('{') : -1;

    if (openIndex === -1) {
        throw new Error('tokens.css has no :root rule');
    }

    let depth = 1;
    for (let index = openIndex + 1; index < css.length; index++) {
        if (css[index] === '{') depth++;
        if (css[index] === '}') depth--;
        if (depth === 0) return css.slice(openIndex + 1, index);
    }

    throw new Error('tokens.css has an unterminated :root rule');
}

/**
 * Loads the canonical token-name allowlist from the Blue Hour root block.
 * @returns {Promise<Set<string>>}
 */
function getKnownTokens() {
    knownTokensPromise ??= fetch('/css/tokens.css')
        .then(response => {
            if (!response.ok) {
                throw new Error(`Could not load tokens.css (${response.status})`);
            }
            return response.text();
        })
        .then(css => {
            const names = new Set();
            const rootBlock = getRootBlock(css);
            for (const match of rootBlock.matchAll(/^\s*(--k-[\w-]+)\s*:/gm)) {
                names.add(match[1]);
            }
            return names;
        });

    return knownTokensPromise;
}

/**
 * Loads the unshadowable built-in Blue Hour token mirror used as the inline
 * override baseline. User packs may shadow API ids, so this uses static assets.
 * @returns {Promise<Record<string, string>>}
 */
function getBlueHourTokens() {
    blueHourTokensPromise ??= Promise.all([
        fetch(`/themes/${BLUE_HOUR_ID}/theme.json`).then(response => {
            if (!response.ok) {
                throw new Error(`Could not load the Blue Hour mirror (${response.status})`);
            }
            return response.json();
        }),
        getKnownTokens(),
    ]).then(([candidate, knownTokens]) => {
        const validation = validateManifest(candidate, knownTokens);
        if (!validation.ok) {
            const details = validation.errors.map(error => `${error.path}: ${error.message}`).join('; ');
            throw new Error(`Invalid Blue Hour mirror: ${details}`);
        }

        const manifest = /** @type {import('./core.js').ThemeManifest} */ (candidate);
        if (manifest.id !== BLUE_HOUR_ID) {
            throw new Error(`Invalid Blue Hour mirror: $.id must equal "${BLUE_HOUR_ID}"`);
        }
        return { ...manifest.tokens };
    });

    return blueHourTokensPromise;
}

/**
 * Gets one pack's server listing.
 * @param {string} id
 * @returns {ThemeListing|undefined}
 */
function getListing(id) {
    return packListings.find(pack => pack.id === id);
}

/**
 * Fetches the available pack list and refreshes the legacy theme select.
 * @returns {Promise<ThemeListing[]>}
 */
async function listPacks() {
    const response = await fetch('/api/kotatsu/themes');
    if (!response.ok) {
        throw new Error(`Could not list theme packs (${response.status})`);
    }

    const value = await response.json();
    if (!Array.isArray(value)) {
        throw new Error('Theme pack list response was not an array');
    }

    packListings = value.filter((/** @type {unknown} */ item) => {
        if (!item || typeof item !== 'object') return false;
        const pack = /** @type {Partial<ThemeListing>} */ (item);
        return typeof pack.id === 'string'
            && typeof pack.name === 'string'
            && (pack.source === 'builtin' || pack.source === 'user');
    });
    renderPackOptions();
    return [...packListings];
}

/**
 * Renders the pack optgroup without disturbing any legacy theme options.
 * @returns {void}
 */
function renderPackOptions() {
    const select = document.getElementById('themes');
    if (!(select instanceof HTMLSelectElement)) return;

    const selectedValue = select.value;
    select.querySelector('optgroup[data-k-theme-packs]')?.remove();
    const group = document.createElement('optgroup');
    group.label = PACK_GROUP_LABEL;
    group.dataset.kThemePacks = '';

    for (const pack of packListings) {
        const option = document.createElement('option');
        option.value = `${PACK_VALUE_PREFIX}${pack.id}`;
        option.textContent = pack.name;
        group.append(option);
    }

    select.append(group);
    select.value = selectedValue;
}

/**
 * Reports the still-reserved manifest layers once per pack. `variants` left this list when
 * the message component went live (renderer v0 slice E); `layout` stays reserved until the
 * shell's layout registry becomes pack-addressable.
 * @param {Record<string, unknown>} manifest
 * @param {string} id
 * @returns {void}
 */
function noteReservedLayers(manifest, id) {
    const layers = ['layout'].filter(layer => layer in manifest);
    if (layers.length === 0 || ignoredLayerNotices.has(id)) return;
    ignoredLayerNotices.add(id);
    console.info(`[Kotatsu theme] ${id} reserved ${layers.join('/')} data is ignored by the v0 loader.`);
}

/**
 * Fetches, validates, and supplies one manifest to the pure resolver.
 * @param {string} id
 * @returns {Promise<import('./core.js').FetchedThemePack|null>}
 */
async function fetchManifest(id) {
    const listing = getListing(id);
    if (!listing) {
        return null;
    }

    const response = await fetch(`/api/kotatsu/themes/${encodeURIComponent(id)}/manifest`);
    if (!response.ok) {
        throw new Error(`Could not load theme pack "${id}" (${response.status})`);
    }

    /** @type {import('./core.js').ThemeManifest} */
    let manifest;
    try {
        manifest = /** @type {import('./core.js').ThemeManifest} */ (await response.json());
    } catch {
        throw new Error(`Invalid theme pack "${id}": $ must be valid JSON`);
    }
    const validation = validateManifest(manifest, await getKnownTokens());
    if (!validation.ok) {
        const details = validation.errors.map(error => `${error.path}: ${error.message}`).join('; ');
        throw new Error(`Invalid theme pack "${id}": ${details}`);
    }
    if (manifest.id !== id) {
        throw new Error(`Invalid theme pack "${id}": $.id must match its folder id`);
    }

    noteReservedLayers(/** @type {Record<string, unknown>} */ (manifest), id);
    const assetBase = listing.source === 'builtin'
        ? `/themes/${encodeURIComponent(id)}/`
        : `/api/kotatsu/themes/${encodeURIComponent(id)}/assets/`;
    let sheetCss;
    if (typeof manifest.sheet === 'string') {
        const sheetResponse = await fetch(assetUrl(assetBase, manifest.sheet));
        if (!sheetResponse.ok) {
            throw new Error(`Could not load ${id}/${manifest.sheet} (${sheetResponse.status})`);
        }
        sheetCss = await sheetResponse.text();
    }

    return { manifest, sheetCss, assetBase };
}

/**
 * Removes the loader-owned DOM state. Only token keys actually written by the
 * loader are removed; legacy pins are handled by the snapshot functions below.
 * @param {boolean} removeCache
 * @returns {void}
 */
function resetAppliedState(removeCache) {
    const rootStyle = document.documentElement.style;
    for (const token of activeTokenNames) {
        rootStyle.removeProperty(token);
    }
    activeTokenNames.clear();
    rootStyle.removeProperty('--k-app-backdrop');
    document.body?.removeAttribute('data-k-theme');
    document.getElementById('k-pack-fonts')?.remove();
    document.getElementById('k-pack-sheet')?.remove();
    currentPackId = null;
    activePackVariants = readVariantAxes(null);

    if (removeCache) {
        try {
            localStorage.removeItem(CACHE_KEY);
        } catch (error) {
            console.warn('[Kotatsu theme] Could not clear the first-paint cache.', error);
        }
    }
}

/**
 * Captures the legacy inline substrate before any loader-owned declarations are
 * removed. On a legacy-to-pack apply or pack-first boot, an overlapping inline
 * key holds the legacy pin because applyThemeColor runs after cache replay. The
 * guard preserves that original snapshot across pack-to-pack switches.
 * @returns {void}
 */
function snapshotLegacyPins() {
    if (legacyPinSnapshot !== null) return;

    const rootStyle = document.documentElement.style;
    // A property the loader itself wrote (`activeTokenNames` — the cache replay adopts its
    // token names before any snapshot can run) is NOT a legacy pin, and must snapshot as
    // absent. Before applyThemeColor grew its pack guard this distinction was invisible:
    // core re-pinned the overlapping keys after replay, accidentally laundering the
    // snapshot into legacy values. With the guard, a pack-cached boot would otherwise
    // snapshot the loader's own writes and `clear()` would "restore" the pack it was
    // clearing (caught by the pack-probe's clear-drift leg, 2026-08-26).
    legacyPinSnapshot = new Map(ALL_LEGACY_PINS.map(property => [property, activeTokenNames.has(property)
        ? { value: '', priority: '' }
        : {
            value: rootStyle.getPropertyValue(property),
            priority: rootStyle.getPropertyPriority(property),
        }]));
}

/** Removes the 10 Kotatsu and 10 SmartTheme legacy inline pins. */
function stripLegacyPins() {
    const rootStyle = document.documentElement.style;
    for (const property of ALL_LEGACY_PINS) {
        rootStyle.removeProperty(property);
    }
}

/** Restores the exact legacy inline declarations captured before pack apply. */
function restoreLegacyPins() {
    if (legacyPinSnapshot === null) return;

    const rootStyle = document.documentElement.style;
    for (const property of ALL_LEGACY_PINS) {
        rootStyle.removeProperty(property);
        const saved = legacyPinSnapshot.get(property);
        if (saved?.value) {
            rootStyle.setProperty(property, saved.value, saved.priority);
        }
    }
    legacyPinSnapshot = null;
}

/**
 * Writes every variant axis that the current pack + user state resolve to.
 *
 * This is the one place the `variants` layer becomes DOM. Precedence, decided purely in
 * core.js and identical per axis: the active pack's `variants.<axis>` wins, then the user's own
 * persisted `power_user.kotatsu_mes_*`, then the door's own default. A pack's declaration is
 * NEVER written back into the user's setting, so clearing the pack — or selecting one that
 * declares nothing — restores whatever the user chose for themselves, axis by axis.
 *
 * Axis NAMES are not checked here. `applyVariantAxis` is the validator (and the single warning
 * site) for a bogus value, exactly as renderer v0 §2.5 #2 designed it.
 *
 * The wardrobe picker is refreshed from the same call, so the drawer is always a view of the
 * resolution that actually happened rather than a second source of truth.
 * @returns {import('./core.js').VariantAxisDecisions}
 */
export function applyResolvedVariants() {
    const decisions = resolveVariantAxes(activePackVariants, readUserVariantAxes(power_user));
    for (const axis of VARIANT_AXES) {
        applyVariantAxis(axis, decisions[axis].variant ?? undefined);
    }
    renderWardrobePicker(decisions, activePackName());
    return decisions;
}

/**
 * Persists the user's own choice for one axis and re-resolves.
 *
 * The write goes to `power_user` and nowhere else: whether that choice becomes visible is the
 * resolver's business, because a pack that pins the axis still outranks it. That is why the
 * picker disables a pinned axis rather than pretending the click did something — and it is why
 * this replaced slice E's force-applying `setVariant()`, which was a third precedence source.
 *
 * A value outside the axis's known set is refused rather than stored: unlike a PACK's
 * declaration — which must survive so a pack authored for a later Kotatsu still delivers its
 * tokens — a user setting nobody can apply would sit in settings.json warning on every boot.
 * @param {import('./core.js').VariantAxis} axis Axis being set.
 * @param {string} value Value the user picked.
 * @returns {string} The value live on `#chat` afterwards (a pack pin still outranks the user).
 */
export function setVariantAxis(axis, value) {
    const key = VARIANT_AXIS_SETTINGS[axis];
    if (!key) {
        throw new Error(`[Kotatsu theme] Unknown variant axis "${axis}". Known: ${VARIANT_AXES.join(', ')}.`);
    }

    if (!isVariantAxisValue(axis, value)) {
        console.warn(`[Kotatsu theme] Unknown ${axis} variant "${value}"; the wardrobe setting was left unchanged.`);
        return getVariantAxis(axis);
    }

    power_user[key] = value;
    saveSettingsDebounced();
    applyResolvedVariants();
    return getVariantAxis(axis);
}

/**
 * @returns {string|null} Display name of the active pack, for the picker's pinned-axis note.
 */
function activePackName() {
    if (!currentPackId) return null;
    return getListing(currentPackId)?.name ?? currentPackId;
}

/**
 * Builds the pack-owned `@font-face` sheet.
 * @param {ResolvedFont[]} fonts
 * @returns {string}
 */
function buildFontSheet(fonts) {
    return fonts.map(font => {
        const descriptors = [
            `font-family: "${escapeCssString(font.family)}";`,
            `src: url("${escapeCssString(font.src)}");`,
        ];
        if (font.weight) descriptors.push(`font-weight: ${font.weight};`);
        if (font.style) descriptors.push(`font-style: ${font.style};`);
        return `@font-face { ${descriptors.join(' ')} }`;
    }).join('\n');
}

/**
 * Applies an already validated and resolved pack to the document.
 * @param {ResolvedThemePack} resolved
 * @param {Record<string, string>} blueHourTokens
 * @returns {void}
 */
function commitPack(resolved, blueHourTokens) {
    const overrides = getTokenOverrides(resolved.tokens, blueHourTokens);
    snapshotLegacyPins();
    resetAppliedState(false);
    stripLegacyPins();
    const rootStyle = document.documentElement.style;

    for (const [token, value] of Object.entries(overrides)) {
        rootStyle.setProperty(token, value);
        activeTokenNames.add(token);
    }

    document.body.dataset.kTheme = resolved.id;
    if (resolved.fonts.length > 0) {
        const style = document.createElement('style');
        style.id = 'k-pack-fonts';
        style.textContent = buildFontSheet(resolved.fonts);
        document.head.append(style);
    }
    if (resolved.backdrop) {
        rootStyle.setProperty('--k-app-backdrop', `url("${escapeCssString(resolved.backdrop)}")`);
    }
    if (resolved.sheets.length > 0) {
        const style = document.createElement('style');
        style.id = 'k-pack-sheet';
        style.textContent = resolved.sheets
            .map(sheet => prefixSheet(sheet.css, resolved.id))
            .join('\n');
        document.head.append(style);
    }

    currentPackId = resolved.id;
    activePackVariants = readVariantAxes(resolved.variants);
    applyResolvedVariants();
    try {
        // The axes ride the same cache the tokens do so the next boot can apply them before the
        // first row exists (adoptFirstPaintCache). JSON.stringify drops an undefined value
        // entirely, so a wardrobe-free pack keeps the exact v0 cache shape — and the message
        // axis keeps the v0 key name `variant` so caches written before the wardrobe replay.
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            id: resolved.id,
            tokens: overrides,
            variant: activePackVariants.message ?? undefined,
            nameplate: activePackVariants.nameplate ?? undefined,
            metadata: activePackVariants.metadata ?? undefined,
        }));
    } catch (error) {
        console.warn('[Kotatsu theme] Could not update the first-paint cache.', error);
    }
}

/**
 * Applies an already validated and resolved pack to the document, including whatever its
 * `variants` layer declares.
 * @param {ResolvedThemePack} resolved
 * @param {Record<string, string>} blueHourTokens Canonical Blue Hour mirror.
 * @returns {void}
 */
export function applyPack(resolved, blueHourTokens) {
    loadRevision++;
    commitPack(resolved, blueHourTokens);
}

/**
 * Clears the active pack and returns the token substrate to Blue Hour.
 * @param {{persist?: boolean}} [options]
 * @returns {void}
 */
export function clearPack({ persist = true } = {}) {
    loadRevision++;
    resetAppliedState(true);
    restoreLegacyPins();
    // resetAppliedState dropped the pack's declarations; this hands the user's own back.
    applyResolvedVariants();
    if (persist) {
        power_user.theme = `${PACK_VALUE_PREFIX}${BLUE_HOUR_ID}`;
        const select = document.getElementById('themes');
        if (select instanceof HTMLSelectElement) select.value = power_user.theme;
        saveSettingsDebounced();
    }
}

/**
 * Loads and applies a pack by id, falling back cleanly on any error.
 * @param {string} value Pack id or `pack:<id>` select value.
 * @param {{persist?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
async function applyById(value, { persist = true } = {}) {
    const id = value.startsWith(PACK_VALUE_PREFIX) ? value.slice(PACK_VALUE_PREFIX.length) : value;
    const revision = ++loadRevision;

    try {
        if (!getListing(id)) await listPacks();
        const [resolved, blueHourTokens] = await Promise.all([
            resolvePack(id, fetchManifest),
            getBlueHourTokens(),
        ]);
        if (revision !== loadRevision) return false;
        commitPack(/** @type {ResolvedThemePack} */ (resolved), blueHourTokens);
        if (persist) {
            power_user.theme = `${PACK_VALUE_PREFIX}${id}`;
            const select = document.getElementById('themes');
            if (select instanceof HTMLSelectElement) select.value = power_user.theme;
            saveSettingsDebounced();
        }
        return true;
    } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (revision === loadRevision) {
            resetAppliedState(true);
            restoreLegacyPins();
            applyResolvedVariants();
            console.error('[Kotatsu theme]', failure);
            toastr.error(failure.message, 'Theme pack error', { escapeHtml: true });
        }
        throw failure;
    }
}

/**
 * Seeds cleanup bookkeeping from the synchronous first-paint cache.
 *
 * The cached axes are applied here rather than in index.html's inline replay for one
 * structural reason: `data-k-mes-*` lives on `#chat`, which the parser has not reached when
 * that script runs right after `<body>`. This runs at the `firstLoadInit()` seam, which is
 * still long before `printMessages()` builds the first row — so a pack's wardrobe is on the
 * container before any `.mes` exists and there is no card-then-flip flash to see. A stale
 * cache is corrected by the SETTINGS_LOADED reconciliation below, exactly as the tokens are.
 * @returns {void}
 */
function adoptFirstPaintCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
        if (!cached || typeof cached !== 'object'
            || typeof cached.id !== 'string' || cached.id.length === 0
            || !cached.tokens || typeof cached.tokens !== 'object' || Array.isArray(cached.tokens)) return;
        for (const token of Object.keys(cached.tokens)) activeTokenNames.add(token);
        currentPackId = cached.id;
        // `variant` is the message axis's v0 key name; the other two use their axis names.
        const cachedAxes = {
            message: cached.variant,
            nameplate: cached.nameplate,
            metadata: cached.metadata,
        };
        let declared = false;
        for (const axis of VARIANT_AXES) {
            const value = cachedAxes[axis];
            if (typeof value === 'string' && value.length > 0) {
                activePackVariants[axis] = value;
                declared = true;
            }
        }
        if (declared) applyResolvedVariants();
    } catch {
        // The inline first-paint path is equally defensive; settings reconciliation clears it.
    }
}

/**
 * Handles both pack and legacy selections before core's bubbling handler runs.
 * @param {Event} event
 * @returns {void}
 */
function onThemeChange(event) {
    if (!(event.currentTarget instanceof HTMLSelectElement)) return;
    const value = event.currentTarget.value;
    if (value.startsWith(PACK_VALUE_PREFIX)) {
        event.stopImmediatePropagation();
        void applyById(value).catch(() => {});
    } else {
        clearPack({ persist: false });
    }
}

/**
 * Exposes the loader and registers its UI/settings hooks.
 * @returns {Promise<void>}
 */
export async function initThemeLoader() {
    if (initialized) return;
    initialized = true;
    // Before the cache replay: the picker must own real options by the time the first
    // resolution renders into it, and building them touches nothing but its own markup.
    initWardrobePicker({ set: setVariantAxis });
    // Reading size rides the same seam: its select is filled before settings load and the
    // module re-renders itself on SETTINGS_LOADED (theme/prose-scale.js).
    initProseScale();
    adoptFirstPaintCache();

    const select = document.getElementById('themes');
    select?.addEventListener('change', onThemeChange, { capture: true });
    eventSource.on(event_types.SETTINGS_LOADED, async () => {
        renderPackOptions();
        const selected = typeof power_user.theme === 'string' ? power_user.theme : '';
        const themeSelect = document.getElementById('themes');
        if (themeSelect instanceof HTMLSelectElement) themeSelect.value = selected;
        const observedPackId = currentPackId ?? document.body?.dataset.kTheme ?? null;
        const decision = reconcile(selected, observedPackId);
        if (decision.action === 'apply') {
            try {
                await applyById(/** @type {string} */ (decision.id), { persist: false });
            } catch {
                // applyById already reports and returns the document to its baseline.
            }
        } else if (decision.action === 'clear') {
            clearPack({ persist: false });
        }
    });

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') {
        targetWindow.kotatsu = {};
    }
    targetWindow.kotatsu.theme = {
        list: listPacks,
        apply: applyById,
        clear: clearPack,
        current: () => currentPackId,
    };
    // The wardrobe's console door, and the one the picker's selects go through. `set` is the
    // ONLY way a value reaches `power_user.kotatsu_mes_*`, which is what keeps a pack's
    // declaration out of the user's settings.
    targetWindow.kotatsu.wardrobe = {
        axes: VARIANT_AXES,
        get: (/** @type {import('./core.js').VariantAxis} */ axis) => getVariantAxis(axis),
        set: setVariantAxis,
        apply: applyResolvedVariants,
    };

    try {
        await listPacks();
    } catch (error) {
        console.error('[Kotatsu theme] Could not initialize pack discovery.', error);
    }
}
