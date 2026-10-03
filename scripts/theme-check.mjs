import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@adobe/css-tools';

import {
    contrastRatio,
    getSheetAssetPaths,
    normalizeTokenValue,
    prefixSheet,
    resolvePack,
    validateManifest,
} from '../public/kotatsu/theme/core.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIRECTORY = path.join(REPO_ROOT, 'public', 'themes');
const TOKENS_PATH = path.join(REPO_ROOT, 'public', 'css', 'tokens.css');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public', 'kotatsu', 'theme', 'theme.schema.json');
const ID_PATTERN = /^[a-z0-9-]+$/;
const TEXT_TOKENS = ['--k-text', '--k-text-prose', '--k-text-dim', '--k-text-muted', '--k-text-strong', '--k-accent'];
const SURFACE_TOKENS = ['--k-surface', '--k-surface-sunken'];
const WCAG_AA_RATIO = 4.5;

/** @type {string[]} */
const failures = [];

/**
 * Prints a successful check.
 * @param {string} message
 */
function pass(message) {
    console.log(`PASS  ${message}`);
}

/**
 * Records and prints a failed check.
 * @param {string} message
 */
function fail(message) {
    failures.push(message);
    console.error(`FAIL  ${message}`);
}

/**
 * Prints a non-failing authoring warning.
 * @param {string} message
 */
function warn(message) {
    console.warn(`WARN  ${message}`);
}

/**
 * Parses the command-line arguments.
 * @param {string[]} args
 * @returns {{ id: string, drift: boolean }}
 */
function parseArguments(args) {
    let id = '';
    let drift = false;

    for (const argument of args) {
        if (argument === '--drift') {
            drift = true;
            continue;
        }

        if (argument.startsWith('--')) {
            throw new Error(`Unknown option: ${argument}`);
        }

        if (id) {
            throw new Error(`Unexpected argument: ${argument}`);
        }

        id = argument;
    }

    if (!id) {
        throw new Error('Usage: npm run theme:check -- <id> [--drift]');
    }

    if (!ID_PATTERN.test(id)) {
        throw new Error(`Invalid theme id "${id}"; expected [a-z0-9-]+`);
    }

    return { id, drift };
}

/**
 * Reads and parses a JSON file.
 * @param {string} filename
 * @returns {Promise<unknown>}
 */
async function readJson(filename) {
    const source = await fs.readFile(filename, 'utf8');
    return JSON.parse(source);
}

/**
 * Reads the canonical :root token declarations.
 * @returns {Promise<{ css: string, tokens: Record<string, string> }>}
 */
async function readRootTokens() {
    const css = await fs.readFile(TOKENS_PATH, 'utf8');
    const ast = parse(css, { source: TOKENS_PATH });
    const rootRule = ast.stylesheet.rules.find(rule => (
        rule.type === 'rule'
        && rule.selectors?.length === 1
        && rule.selectors[0] === ':root'
    ));

    if (!rootRule || rootRule.type !== 'rule') {
        throw new Error('public/css/tokens.css has no standalone :root rule');
    }

    const declarations = rootRule.declarations ?? [];
    const tokens = Object.fromEntries(declarations
        .filter(declaration => declaration.type === 'declaration' && declaration.property.startsWith('--k-'))
        .map(declaration => [declaration.property, declaration.value]));

    return { css, tokens };
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
 * Counts authored style rules recursively. At-rules themselves are not debt;
 * the style rules nested inside conditional at-rules are.
 * @param {unknown[]} rules
 * @returns {number}
 */
function countStyleRules(rules) {
    let count = 0;

    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') {
            continue;
        }

        if ('type' in rule && rule.type === 'rule') {
            count += 1;
        }

        if ('rules' in rule && Array.isArray(rule.rules)) {
            count += countStyleRules(rule.rules);
        }
    }

    return count;
}

/**
 * Resolves a token whose entire value is another token reference.
 * More complex CSS expressions deliberately remain unresolved.
 * @param {string} tokenName
 * @param {Record<string, string>} tokens
 * @param {Set<string>} [seen]
 * @returns {string|null}
 */
function resolveColorToken(tokenName, tokens, seen = new Set()) {
    if (seen.has(tokenName)) {
        return null;
    }

    const value = tokens[tokenName];
    if (typeof value !== 'string') {
        return null;
    }

    const reference = value.trim().match(/^var\((--k-[a-z0-9-]+)\)$/);
    if (!reference) {
        return value;
    }

    seen.add(tokenName);
    return resolveColorToken(reference[1], tokens, seen);
}

/**
 * Runs all checks for one built-in pack.
 * @param {string} id
 * @param {boolean} checkDrift
 */
async function checkTheme(id, checkDrift) {
    await readJson(SCHEMA_PATH);
    pass('manifest schema is readable JSON');

    const { tokens: rootTokens } = await readRootTokens();
    const knownTokens = new Set(Object.keys(rootTokens));
    /** @type {Map<string, Promise<{ id: string, directory: string, manifest: any, sheetCss?: string }>>} */
    const packCache = new Map();

    /**
     * Loads one built-in pack and its optional sheet.
     * @param {string} packId
     */
    function loadPack(packId) {
        if (!ID_PATTERN.test(packId)) {
            return Promise.reject(new Error(`Invalid inherited theme id "${packId}"`));
        }

        if (!packCache.has(packId)) {
            packCache.set(packId, (async () => {
                const directory = path.join(THEMES_DIRECTORY, packId);
                const manifestPath = path.join(directory, 'theme.json');
                const manifest = await readJson(manifestPath);
                let sheetCss;

                if (manifest && typeof manifest === 'object'
                    && typeof manifest.sheet === 'string'
                    && isSafeRelativePath(manifest.sheet)) {
                    try {
                        sheetCss = await fs.readFile(path.resolve(directory, ...manifest.sheet.split('/')), 'utf8');
                    } catch {
                        // Asset checking below emits the path-specific error.
                    }
                }

                return { id: packId, directory, manifest, sheetCss };
            })());
        }

        return /** @type {Promise<{ id: string, directory: string, manifest: any, sheetCss?: string }>} */ (packCache.get(packId));
    }

    /** @type {{ id: string, directory: string, manifest: any, sheetCss?: string }[]} */
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
            const pack = await loadPack(nextId);
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

    for (const pack of chain) {
        const validation = validateManifest(pack.manifest, knownTokens);

        if (validation.ok) {
            pass(`${pack.id}/theme.json matches the v0 manifest contract`);
        } else {
            for (const error of validation.errors) {
                fail(`${pack.id}${error.path}: ${error.message}`);
            }
        }

        if (pack.manifest?.id !== pack.id) {
            fail(`${pack.id}/theme.json id must match its folder name`);
        }
    }

    let resolved;

    try {
        resolved = await resolvePack(id, async packId => {
            const pack = await loadPack(packId);
            return { manifest: pack.manifest, sheetCss: pack.sheetCss };
        });
        pass(`inheritance resolved (${[...chain].reverse().map(pack => pack.id).join(' -> ')})`);
    } catch (error) {
        fail(`inheritance resolution: ${error instanceof Error ? error.message : String(error)}`);
    }

    let checkedAssetCount = 0;
    let sheetDebt = 0;

    /**
     * Checks one referenced pack file.
     * @param {{ id: string, directory: string }} pack
     * @param {string} assetPath
     * @param {string} label
     */
    async function checkAsset(pack, assetPath, label) {
        if (!isSafeRelativePath(assetPath)) {
            fail(`${pack.id} ${label} must be a relative path inside the pack`);
            return;
        }

        const pathname = assetPath.split(/[?#]/, 1)[0];
        if (!pathname) {
            fail(`${pack.id} ${label} must name a file inside the pack`);
            return;
        }

        const filename = path.resolve(pack.directory, ...pathname.split('/'));
        const relative = path.relative(pack.directory, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            fail(`${pack.id} ${label} escapes its pack directory`);
            return;
        }

        try {
            const [packRoot, realFilename] = await Promise.all([
                fs.realpath(pack.directory),
                fs.realpath(filename),
            ]);
            const realRelative = path.relative(packRoot, realFilename);
            if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
                fail(`${pack.id} ${label} escapes its pack directory`);
                return;
            }

            const stats = await fs.stat(realFilename);
            if (!stats.isFile()) {
                fail(`${pack.id} ${label} is not a file: ${pathname}`);
                return;
            }
            checkedAssetCount += 1;
        } catch {
            fail(`${pack.id} ${label} does not exist: ${pathname}`);
        }
    }

    for (const pack of [...chain].reverse()) {
        const fonts = pack.manifest?.assets?.fonts;
        if (Array.isArray(fonts)) {
            for (const [index, font] of fonts.entries()) {
                if (font && typeof font.src === 'string') {
                    await checkAsset(pack, font.src, `assets.fonts[${index}].src`);
                }
            }
        }

        if (typeof pack.manifest?.assets?.backdrop === 'string') {
            await checkAsset(pack, pack.manifest.assets.backdrop, 'assets.backdrop');
        }

        if (typeof pack.manifest?.sheet === 'string') {
            await checkAsset(pack, pack.manifest.sheet, 'sheet');

            if (typeof pack.sheetCss === 'string') {
                try {
                    prefixSheet(pack.sheetCss, pack.id);
                    for (const assetPath of new Set(getSheetAssetPaths(pack.sheetCss))) {
                        await checkAsset(pack, assetPath, `sheet url(${JSON.stringify(assetPath)})`);
                    }
                    const sheetAst = parse(pack.sheetCss, { source: path.join(pack.directory, pack.manifest.sheet) });
                    sheetDebt += countStyleRules(sheetAst.stylesheet.rules);
                } catch (error) {
                    fail(`${pack.id} sheet: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
    }

    pass(`${checkedAssetCount} referenced asset${checkedAssetCount === 1 ? '' : 's'} exist`);
    console.log(`INFO  sheet debt: ${sheetDebt} rule${sheetDebt === 1 ? '' : 's'}`);

    if (resolved) {
        const selectedTokens = chain[0]?.manifest?.tokens ?? {};
        const directTokens = new Set(Object.keys(selectedTokens));
        const inheritedDefaults = [...knownTokens].filter(token => !directTokens.has(token));
        console.log(`INFO  inherited defaults: ${inheritedDefaults.length}/${knownTokens.size}`);
        if (inheritedDefaults.length) {
            console.log(`      ${inheritedDefaults.join(', ')}`);
        }

        const inheritedTokens = {};
        for (const pack of chain.slice(1).reverse()) {
            Object.assign(inheritedTokens, pack.manifest?.tokens ?? {});
        }
        const redundantTokens = Object.entries(selectedTokens)
            .filter(([token, value]) => typeof value === 'string'
                && typeof inheritedTokens[token] === 'string'
                && normalizeTokenValue(value) === normalizeTokenValue(inheritedTokens[token]))
            .map(([token]) => token);
        if (redundantTokens.length > 0) {
            warn(`${redundantTokens.length} tokens re-declare the inherited value`);
            console.warn(`      ${redundantTokens.join(', ')}`);
        } else {
            pass('0 tokens re-declare the inherited value');
        }

        const effectiveTokens = { ...rootTokens, ...resolved.tokens };
        for (const foregroundToken of TEXT_TOKENS) {
            for (const backgroundToken of SURFACE_TOKENS) {
                const foreground = resolveColorToken(foregroundToken, effectiveTokens);
                const background = resolveColorToken(backgroundToken, effectiveTokens);
                const ratio = foreground && background ? contrastRatio(foreground, background) : null;
                const label = `${foregroundToken} on ${backgroundToken}`;

                if (ratio === null) {
                    console.log(`INFO  contrast ${label}: unresolved (${foreground ?? 'missing'} / ${background ?? 'missing'})`);
                } else if (ratio < WCAG_AA_RATIO) {
                    fail(`contrast ${label}: ${ratio.toFixed(2)}:1 (WCAG AA requires ${WCAG_AA_RATIO}:1)`);
                } else {
                    pass(`contrast ${label}: ${ratio.toFixed(2)}:1`);
                }
            }
        }
    }

    if (checkDrift) {
        try {
            const blueHour = await loadPack('blue-hour');
            const manifestTokens = blueHour.manifest?.tokens;
            if (!manifestTokens || typeof manifestTokens !== 'object' || Array.isArray(manifestTokens)) {
                fail('Blue Hour drift: manifest has no token object');
            } else {
                const allNames = new Set([...knownTokens, ...Object.keys(manifestTokens)]);
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

                if (driftCount === 0) {
                    pass(`Blue Hour mirrors all ${knownTokens.size} :root tokens`);
                }
            }
        } catch (error) {
            fail(`Blue Hour drift check: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

try {
    const { id, drift } = parseArguments(process.argv.slice(2));
    await checkTheme(id, drift);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}

if (failures.length) {
    console.error(`\n${failures.length} theme check${failures.length === 1 ? '' : 's'} failed.`);
    process.exitCode = 1;
} else {
    console.log('\nTheme check passed.');
}
