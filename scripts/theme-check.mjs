// npm run theme:check -- <id> [--drift] [--user <handle>]
//
// Checks one theme pack the way the app will load it, and says what to fix in plain words.
// Finds the pack in data/<user>/theme-packs/ first, then public/themes/ (scripts/theme-lib.mjs).
// Exit code 1 on any FAIL; WARN and INFO lines never fail the check.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from '@adobe/css-tools';

import {
    contrastRatio,
    parseColor,
    getSheetAssetPaths,
    normalizeTokenValue,
    prefixSheet,
    rebaseSheetUrls,
    resolvePack,
    validateManifest,
} from '../public/kotatsu/theme/core.js';
import { isRootContext } from '../public/kotatsu/theme/knobs.js';
import { FONT_TYPES, IMAGE_TYPES, SHEET_TYPES } from '../src/endpoints/kotatsu/theme-asset-types.js';
import { PALETTE_KEYS, resolveTokenColor, toHex } from '../public/kotatsu/theme/palette.js';
import { BUILTIN_DIRECTORY, describeKnobReach, findPack, ID_PATTERN, readCoreTokens, readKnobs } from './theme-lib.mjs';

const WCAG_AA_RATIO = 4.5;
const ATMOSPHERE_MOTIONS = new Set(['none', 'k-atmo-fall', 'k-atmo-drift', 'k-atmo-breathe']);
/**
 * What each kind of reference may point at: the server's own lists (it serves nothing else from a
 * user pack), so a file the app would 404 fails here instead.
 * @type {Record<'font'|'image'|'sheet'|'sheetUrl', {types: Record<string, string>, what: string, list: string}>}
 */
const ASSET_ROLES = (() => {
    const list = (/** @type {Record<string, string>} */ types) => {
        const names = Object.keys(types).map(extension => `a ${extension} file`);
        return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
    };
    const fontsAndImages = { ...FONT_TYPES, ...IMAGE_TYPES };
    return {
        font: { types: FONT_TYPES, what: 'a font file', list: list(FONT_TYPES) },
        image: { types: IMAGE_TYPES, what: 'a picture', list: list(IMAGE_TYPES) },
        sheet: { types: SHEET_TYPES, what: 'a stylesheet', list: list(SHEET_TYPES).replace(/^ or /, '') },
        sheetUrl: { types: fontsAndImages, what: 'a picture or font', list: list(fontsAndImages) },
    };
})();
/** Faces Kotatsu itself ships (public/webfonts/kotatsu + the Noto fallbacks). */
const BUNDLED_FAMILIES = new Set(['newsreader', 'ibm plex sans', 'ibm plex mono', 'noto sans', 'noto sans mono']);
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

/**
 * Contrast pairs, in reading order. `level: 'fail'` pairs are text people read for hours; the
 * rest are reported as warnings because their use is incidental (status colours, faint hints).
 * @type {{fg: string, bg: string, label: string, level: 'fail'|'warn', floor?: number}[]}
 */
const CONTRAST_PAIRS = [
    ...['--k-text', '--k-text-prose', '--k-text-dim', '--k-text-muted', '--k-text-strong', '--k-accent'].flatMap(fg => [
        { fg, bg: '--k-surface', label: 'on panels', level: /** @type {const} */ ('fail') },
        { fg, bg: '--k-surface-sunken', label: 'on sunken panels', level: /** @type {const} */ ('fail') },
    ]),
    { fg: '--k-text-prose', bg: '--k-bot-mes', label: 'story text on the character\'s message card', level: 'fail' },
    { fg: '--k-text-prose', bg: '--k-user-mes', label: 'story text on your message card', level: 'fail' },
    { fg: '--k-quote', bg: '--k-bot-mes', label: '"dialogue" on the character\'s message card', level: 'fail' },
    { fg: '--k-quote', bg: '--k-user-mes', label: '"dialogue" on your message card', level: 'fail' },
    { fg: '--k-italics', bg: '--k-bot-mes', label: '*actions* on the character\'s message card', level: 'fail' },
    { fg: '--k-italics', bg: '--k-user-mes', label: '*actions* on your message card', level: 'fail' },
    { fg: '--k-accent-bright', bg: '--k-surface', label: 'names and highlights on panels', level: 'fail' },
    { fg: '--k-accent-bright', bg: '--k-surface-2', label: 'names and highlights on the rails', level: 'warn' },
    { fg: '--k-text-faint', bg: '--k-surface', label: 'faint hints on panels', level: 'warn', floor: 3 },
    { fg: '--k-success', bg: '--k-surface', label: 'success colour on panels', level: 'warn' },
    { fg: '--k-warning', bg: '--k-surface', label: 'warning colour on panels', level: 'warn' },
    { fg: '--k-danger', bg: '--k-surface', label: 'danger colour on panels', level: 'warn' },
];

/** @type {string[]} */
const failures = [];
let warnings = 0;

const pass = (/** @type {string} */ message) => console.log(`PASS  ${message}`);
const info = (/** @type {string} */ message) => console.log(`INFO  ${message}`);
const fail = (/** @type {string} */ message) => {
    failures.push(message);
    console.log(`FAIL  ${message}`);
};
const warn = (/** @type {string} */ message) => {
    warnings++;
    console.log(`WARN  ${message}`);
};

/**
 * @param {string[]} args
 * @returns {{id: string, drift: boolean, handle: string|undefined}}
 */
function parseArguments(args) {
    let id = '';
    let drift = false;
    /** @type {string|undefined} */
    let handle;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--drift') {
            drift = true;
        } else if (argument === '--user') {
            handle = args[++index];
            if (!handle) throw new Error('--user needs a data user handle, like --user default-user');
        } else if (argument.startsWith('--')) {
            throw new Error(`Unknown option: ${argument}`);
        } else if (id) {
            throw new Error(`Unexpected argument: ${argument}`);
        } else {
            id = argument;
        }
    }
    if (!id) throw new Error('Usage: npm run theme:check -- <id> [--drift] [--user <handle>]');
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid theme id "${id}"; use lowercase letters, digits and dashes only`);
    return { id, drift, handle };
}

/**
 * @param {string} filename
 * @returns {Promise<unknown>}
 */
async function readJson(filename) {
    const source = await fs.readFile(filename, 'utf8');
    try {
        return JSON.parse(source);
    } catch (error) {
        throw new Error(`${path.basename(filename)} is not valid JSON (${error instanceof Error ? error.message : error}). A missing comma or an extra one after the last line is the usual cause.`);
    }
}

/**
 * Tests whether a pack-owned asset path is safely relative.
 * @param {string} assetPath
 * @returns {boolean}
 */
function isSafeRelativePath(assetPath) {
    if (!assetPath || assetPath.includes('%') || assetPath.includes('\\') || assetPath.startsWith('/')
        || /[\u0000-\u001f\u007f]/.test(assetPath)) {
        return false;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(assetPath) || assetPath.startsWith('//')) {
        return false;
    }
    return assetPath.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Counts authored style rules recursively (sheet debt).
 * @param {unknown[]} rules
 * @returns {number}
 */
function countStyleRules(rules) {
    let count = 0;
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        if ('type' in rule && rule.type === 'rule') count += 1;
        if ('rules' in rule && Array.isArray(rule.rules)) count += countStyleRules(rule.rules);
    }
    return count;
}

/**
 * The first family named in a font stack, lowercased and unquoted.
 * @param {string} stack
 * @returns {string}
 */
function firstFamily(stack) {
    return stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

/**
 * @param {string} id
 * @param {boolean} checkDrift
 * @param {string|undefined} handle
 */
async function checkTheme(id, checkDrift, handle) {
    const { tokens: rootTokens } = await readCoreTokens();
    const coreNames = new Set(Object.keys(rootTokens));
    const knobs = (await readKnobs()).knobs;
    const allowedNames = new Set([...coreNames, ...Object.keys(knobs)]);

    /** @type {Map<string, Promise<{id: string, directory: string, source: string, manifest: any, sheetCss?: string}>>} */
    const packCache = new Map();
    /**
     * @param {string} packId
     */
    function loadPack(packId, allowExample = false) {
        if (!ID_PATTERN.test(packId)) return Promise.reject(new Error(`Invalid inherited theme id "${packId}"`));
        const key = allowExample ? `example:${packId}` : packId;
        if (!packCache.has(key)) {
            packCache.set(key, (async () => {
                const found = await findPack(packId, handle, { examples: allowExample });
                if (!found) {
                    if (!allowExample && await findPack(packId, handle, { examples: true })) {
                        throw new Error(`"${packId}" is an example from docs/theme-examples/. The app does not list examples, so it cannot be a parent and Kotatsu would refuse this theme. Copy it instead: npm run theme:new -- my-theme --from ${packId}`);
                    }
                    throw new Error(`no folder named "${packId}" with a theme.json in data/<user>/theme-packs/ or public/themes/`);
                }
                const manifest = await readJson(path.join(found.directory, 'theme.json'));
                let sheetCss;
                if (manifest && typeof manifest === 'object' && typeof manifest.sheet === 'string' && isSafeRelativePath(manifest.sheet)) {
                    try {
                        sheetCss = await fs.readFile(path.resolve(found.directory, ...manifest.sheet.split('/')), 'utf8');
                    } catch {
                        // checkAsset below reports the missing file by name.
                    }
                }
                return { id: packId, directory: found.directory, source: found.source, manifest, sheetCss };
            })());
        }
        return /** @type {Promise<{id: string, directory: string, source: string, manifest: any, sheetCss?: string}>} */ (packCache.get(key));
    }

    /** @type {{id: string, directory: string, source: string, manifest: any, sheetCss?: string}[]} */
    const chain = [];
    const seen = new Set();
    let nextId = id;
    while (nextId) {
        if (seen.has(nextId)) {
            fail(`inheritance cycle: ${[...chain.map(pack => pack.id), nextId].join(' -> ')}`);
            break;
        }
        seen.add(nextId);
        try {
            const pack = await loadPack(nextId, chain.length === 0); // only the checked pack may be an example
            chain.push(pack);
            const parentId = typeof pack.manifest?.extends === 'string' ? pack.manifest.extends : '';
            if (parentId && chain.length >= 5) {
                fail('inheritance exceeds four parent hops');
                break;
            }
            nextId = parentId;
        } catch (error) {
            fail(`cannot load theme "${nextId}": ${error instanceof Error ? error.message : String(error)}`);
            break;
        }
    }
    if (chain[0]) {
        const where = path.relative(path.resolve(BUILTIN_DIRECTORY, '..', '..'), chain[0].directory).split(path.sep).join('/');
        const about = [chain[0].manifest?.name, chain[0].manifest?.author && `by ${chain[0].manifest.author}`].filter(Boolean).join(' ');
        info(`checking ${about || id} (${where})`);
    }

    for (const pack of chain) {
        const validation = validateManifest(pack.manifest, allowedNames);
        if (validation.ok) {
            pass(`${pack.id}/theme.json is a valid pack manifest`);
        } else {
            for (const error of validation.errors) fail(`${pack.id}/theme.json ${error.path.replace(/^\$\.?/, '') || '(top level)'}: ${error.message}`);
        }
        if (pack.manifest?.id !== pack.id) fail(`${pack.id}/theme.json "id" must be "${pack.id}", the same as its folder name`);
    }

    let resolved;
    try {
        resolved = await resolvePack(id, async packId => {
            const pack = await loadPack(packId, packId === id);
            return { manifest: pack.manifest, sheetCss: pack.sheetCss };
        }, { baseline: rootTokens });
        pass(`inheritance resolved (${[...chain].reverse().map(pack => pack.id).join(' -> ')})`);
    } catch (error) {
        fail(`inheritance resolution: ${error instanceof Error ? error.message : String(error)}`);
    }

    let checkedAssetCount = 0;
    let sheetDebt = 0;
    /**
     * @param {{id: string, directory: string}} pack
     * @param {string} assetPath
     * @param {string} label
     */
    async function checkAsset(pack, assetPath, label, role) {
        if (!isSafeRelativePath(assetPath)) {
            fail(`${pack.id} ${label} must be a relative path inside the pack folder`);
            return;
        }
        const pathname = assetPath.split(/[?#]/, 1)[0];
        // The server only serves these kinds of file from a pack (src/endpoints/kotatsu/
        // theme-asset-types.js); anything else would 404 in the app, and a missing sheet drops the
        // whole pack.
        const extension = path.extname(pathname).toLowerCase();
        const kinds = ASSET_ROLES[role];
        if (!Object.hasOwn(kinds.types, extension)) {
            fail(`${pack.id} ${label} "${pathname}" is not ${kinds.what} Kotatsu can use. Use ${kinds.list}.${role === 'font' ? ' (A Google Fonts download has .ttf files; unzip it first.)' : ''}`);
            return;
        }
        const filename = path.resolve(pack.directory, ...pathname.split('/'));
        try {
            const [packRoot, realFilename] = await Promise.all([fs.realpath(pack.directory), fs.realpath(filename)]);
            const realRelative = path.relative(packRoot, realFilename);
            if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
                fail(`${pack.id} ${label} escapes its pack folder`);
                return;
            }
            if (!(await fs.stat(realFilename)).isFile()) {
                fail(`${pack.id} ${label} is not a file: ${pathname}`);
                return;
            }
            checkedAssetCount += 1;
        } catch {
            fail(`${pack.id} ${label} points at a file that does not exist: ${pathname}`);
        }
    }

    /** @type {Set<string>} */
    const packFamilies = new Set();
    for (const pack of [...chain].reverse()) {
        const fonts = pack.manifest?.assets?.fonts;
        if (Array.isArray(fonts)) {
            for (const [index, font] of fonts.entries()) {
                if (font && typeof font.src === 'string') await checkAsset(pack, font.src, `assets.fonts[${index}].src`, 'font');
                if (font && typeof font.family === 'string') packFamilies.add(font.family.toLowerCase());
            }
        }
        if (typeof pack.manifest?.assets?.backdrop === 'string') await checkAsset(pack, pack.manifest.assets.backdrop, 'assets.backdrop', 'image');
        for (const [name, value] of Object.entries(pack.manifest?.tokens ?? {})) {
            if (typeof value !== 'string' || !/url\s*\(/i.test(value)) continue;
            try {
                for (const assetPath of new Set(getSheetAssetPaths(value))) await checkAsset(pack, assetPath, `${name} url(${JSON.stringify(assetPath)})`, 'image');
            } catch {
                // validateManifest already reported the unsafe url().
            }
        }
        if (typeof pack.manifest?.sheet === 'string') {
            await checkAsset(pack, pack.manifest.sheet, 'sheet', 'sheet');
            if (typeof pack.sheetCss === 'string') {
                try {
                    prefixSheet(pack.sheetCss, pack.id);
                    for (const assetPath of new Set(getSheetAssetPaths(pack.sheetCss))) await checkAsset(pack, assetPath, `sheet url(${JSON.stringify(assetPath)})`, 'sheetUrl');
                    sheetDebt += countStyleRules(parse(pack.sheetCss, { source: path.join(pack.directory, pack.manifest.sheet) }).stylesheet.rules);
                } catch (error) {
                    fail(`${pack.id} sheet: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }
    pass(`${checkedAssetCount} referenced file${checkedAssetCount === 1 ? '' : 's'} exist`);
    info(`sheet.css rules: ${sheetDebt}${sheetDebt ? ' (each one is CSS a token or knob could not express yet)' : ''}`);

    if (!resolved) return;
    const own = chain[0]?.manifest ?? {};
    const ownTokens = own.tokens && typeof own.tokens === 'object' ? own.tokens : {};

    // ── What the pack changes ────────────────────────────────────────────────────────────
    if (resolved.palette) {
        const { changed, overruled = [], derived } = resolved.palette;
        if (changed.length === 0) {
            info(overruled.length
                ? 'palette: changes no colour yet; the rest match the parent, and the WARN below explains the overruled ones'
                : 'palette: every colour matches the parent, so it changes nothing yet');
        } else {
            info(`palette: you changed ${changed.join(', ')}; ${derived.length} more colour${derived.length === 1 ? '' : 's'} grew from ${changed.length === 1 ? 'it' : 'them'}`);
            if (derived.length) console.log(`      ${derived.join(', ')}`);
        }
        const unchanged = Object.keys(own.palette ?? {}).filter(key => !changed.includes(key) && !overruled.includes(key));
        if (unchanged.length && changed.length) info(`palette: still the parent's colour: ${unchanged.join(', ')}`);
    }
    const ownNames = Object.keys(ownTokens);
    const ownKnobs = ownNames.filter(name => !coreNames.has(name) && knobs[name]);
    info(`tokens written by hand: ${ownNames.length} (${ownNames.length - ownKnobs.length} core, ${ownKnobs.length} component knob${ownKnobs.length === 1 ? '' : 's'})`);
    for (const name of ownKnobs) {
        const entry = knobs[name];
        const reach = describeKnobReach(entry);
        if (reach.reach !== 'always') info(`${name} (${entry.group}) ${reach.text}`);
        if (entry.contexts.length > 0 && entry.contexts.every(isRootContext) === false && entry.contexts.some(isRootContext)) {
            info(`${name} is set on the page and inside ${entry.group}; both get your value`);
        }
    }

    // A url() means a file in the folder of the pack that wrote it (url()s are rebased per pack),
    // so the same text in a child and a parent can name two different files. Compare values with
    // every url() resolved to the file it really is.
    /**
     * @param {string} value
     * @param {string} directory The defining pack's folder.
     * @returns {string}
     */
    const asWritten = (value, directory) => {
        if (!/url\s*\(/i.test(value)) return normalizeTokenValue(value);
        try {
            return normalizeTokenValue(rebaseSheetUrls(value, `${pathToFileURL(directory).href}/`));
        } catch {
            return `${directory}\u0000${value}`; // unsafe url(): validateManifest reports it
        }
    };
    /** @type {Record<string, string>} */
    const inherited = {};
    for (const pack of chain.slice(1).reverse()) {
        for (const [token, value] of Object.entries(pack.manifest?.tokens ?? {})) {
            if (typeof value === 'string') inherited[token] = asWritten(value, pack.directory);
        }
    }
    const ownDirectory = chain[0]?.directory ?? '';
    const redundant = Object.entries(ownTokens)
        .filter(([token, value]) => typeof value === 'string' && typeof inherited[token] === 'string'
            && asWritten(value, ownDirectory) === inherited[token])
        .map(([token]) => token);
    if (redundant.length) {
        warn(`${redundant.length} token${redundant.length === 1 ? '' : 's'} repeat${redundant.length === 1 ? 's' : ''} the parent's value and can be deleted: ${redundant.join(', ')}`);
    }

    const effective = { ...rootTokens, ...resolved.tokens };

    // ── Motion and atmosphere ───────────────────────────────────────────────────────────
    const motion = normalizeTokenValue(effective['--k-atmosphere-motion'] ?? 'none');
    if (!ATMOSPHERE_MOTIONS.has(motion) && !(chain.some(pack => pack.sheetCss?.includes(`@keyframes ${motion}`)))) {
        fail(`--k-atmosphere-motion "${motion}" is not a motion Kotatsu has. Use one of: ${[...ATMOSPHERE_MOTIONS].join(', ')}`);
    } else if (motion !== 'none') {
        const travel = normalizeTokenValue(effective['--k-atmosphere-travel'] ?? '0px');
        if (motion !== 'k-atmo-breathe' && /^0(px)?$/.test(travel)) {
            warn(`--k-atmosphere-motion is ${motion} but --k-atmosphere-travel is 0, so nothing moves. Set it to your texture's ${motion === 'k-atmo-fall' ? 'height' : 'width'}.`);
        } else {
            pass(`atmosphere moves with ${motion} (stops for reduced motion)`);
            // Say the motion in numbers people can tune: how far each hop goes, how often.
            const pixels = /^(\d+(?:\.\d+)?)px$/.exec(travel);
            const period = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(normalizeTokenValue(effective['--k-atmosphere-period'] ?? '60s'));
            const steps = Number(normalizeTokenValue(effective['--k-atmosphere-steps'] ?? '600'));
            if (motion !== 'k-atmo-breathe' && pixels && period && steps > 0) {
                const seconds = Number(period[1]) / (period[2] === 'ms' ? 1000 : 1);
                const hop = Number(pixels[1]) / steps;
                const rate = steps / seconds;
                info(`the atmosphere moves ${hop.toFixed(1)} pixels at a time, ${rate.toFixed(1)} times a second`);
                if (hop > 3) warn(`each atmosphere hop is ${hop.toFixed(1)} pixels, which reads as jumping. Raise --k-atmosphere-steps to about ${Math.ceil(Number(pixels[1]) / 2)} (2 pixels a hop).`);
                if (rate > 6) warn(`the atmosphere moves ${rate.toFixed(1)} times a second; every hop redraws the blurred reading area. Lengthen --k-atmosphere-period or lower --k-atmosphere-steps to stay near 2 to 4 hops a second.`);
            }
        }
    }
    for (const [name, durationToken] of [['--k-dur-1', 120], ['--k-dur-2', 180], ['--k-dur-3', 240]]) {
        const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(normalizeTokenValue(String(effective[name] ?? '')));
        if (!match) continue;
        const ms = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
        if (ms > 260) warn(`${name} is ${ms}ms; keep interface motion within 260ms so nothing feels like it is in the way (Blue Hour uses ${durationToken}ms)`);
    }
    // A material is image layers laid over a surface's colour; a plain colour is not a layer, and
    // where a material shares one layer list with its surface's fill (the composer) it would wipe
    // the whole background out.
    for (const [name, value] of Object.entries(ownTokens)) {
        if (/^--k-material-/.test(name) && typeof value === 'string' && parseColor(value)) {
            fail(`${name} is a plain colour, but a material is pictures and gradients laid over the surface's colour. Set the colour with the palette (or a gradient of one colour), and use "none" for no material.`);
        }
    }
    if (typeof own.assets?.backdrop === 'string' && typeof ownTokens['--k-app-backdrop'] === 'string') {
        warn('this pack sets both assets.backdrop and --k-app-backdrop; the assets.backdrop picture wins, so the token is ignored');
    }

    // ── Fonts ───────────────────────────────────────────────────────────────────────────
    for (const token of ['--k-font-ui', '--k-font-prose', '--k-font-display', '--k-font-name', '--k-font-label', '--k-font-mono']) {
        const value = ownTokens[token];
        if (typeof value !== 'string' || /^var\(|^initial$/.test(value.trim())) continue;
        const family = firstFamily(value);
        if (!packFamilies.has(family) && !BUNDLED_FAMILIES.has(family) && !GENERIC_FAMILIES.has(family)) {
            warn(`${token} asks for "${family}", but no font file in this pack provides it; people without it installed see the next font in the list`);
        }
    }

    // ── Contrast ────────────────────────────────────────────────────────────────────────
    for (const pair of CONTRAST_PAIRS) {
        const fg = resolveTokenColor(pair.fg, effective);
        const bg = resolveTokenColor(pair.bg, effective);
        const floor = pair.floor ?? WCAG_AA_RATIO;
        const label = `contrast ${pair.fg} on ${pair.bg} (${pair.label})`;
        if (!fg || !bg) {
            info(`${label}: not a plain colour, so it cannot be measured here; check it by eye`);
            continue;
        }
        const ratio = contrastRatio(toHex(fg), toHex(bg)) ?? 0;
        if (ratio >= floor) {
            pass(`${label}: ${ratio.toFixed(2)}:1`);
        } else if (pair.level === 'fail') {
            fail(`${label}: ${ratio.toFixed(2)}:1, needs ${floor}:1. Make one of them lighter or darker.`);
        } else {
            warn(`${label}: ${ratio.toFixed(2)}:1 (below ${floor}:1)`);
        }
    }

    // ── Blue Hour mirror ────────────────────────────────────────────────────────────────
    if (checkDrift) {
        const blueHour = await loadPack('blue-hour');
        const manifestTokens = blueHour.manifest?.tokens ?? {};
        const allNames = new Set([...coreNames, ...Object.keys(manifestTokens)]);
        let driftCount = 0;
        for (const token of allNames) {
            const cssValue = rootTokens[token];
            const manifestValue = manifestTokens[token];
            if (typeof cssValue !== 'string' || typeof manifestValue !== 'string'
                || normalizeTokenValue(cssValue) !== normalizeTokenValue(manifestValue)) {
                driftCount += 1;
                fail(`Blue Hour drift at ${token}: tokens.css=${JSON.stringify(cssValue)} manifest=${JSON.stringify(manifestValue)}`);
            }
        }
        if (driftCount === 0) pass(`Blue Hour mirrors all ${coreNames.size} :root tokens`);
    }

    // Keep a tidy palette: the authoring guide promises theme:check notices a palette key that
    // writes a token the pack also writes by hand (the hand-written one wins, so the palette
    // entry is dead weight).
    for (const [key, spec] of Object.entries(PALETTE_KEYS)) {
        if (own.palette && key in own.palette && spec.token in ownTokens) {
            warn(`palette.${key} changes nothing: ${spec.token} in tokens sets that colour too, and tokens win. Delete one of them.`);
        }
    }
}

try {
    const { id, drift, handle } = parseArguments(process.argv.slice(2));
    await checkTheme(id, drift, handle);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}

if (failures.length) {
    console.error(`\n${failures.length} problem${failures.length === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}. Fix every FAIL before you share the pack.`);
    process.exitCode = 1;
} else {
    console.log(`\nTheme check passed${warnings ? ` with ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`);
}
