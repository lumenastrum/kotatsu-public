// Shared helpers for the theme authoring scripts (theme:new, theme:check). Node only.
//
// Where packs live, in the order the server resolves them (src/endpoints/kotatsu/themes.js):
//   1. data/<user>/theme-packs/<id>/   your own packs: survive updates, zip the folder to share
//   2. public/themes/<id>/             packs that ship with Kotatsu
// A user pack with the same id as a built-in one wins, exactly as it does in the app. The scripts
// also find the documented examples in docs/theme-examples/<id>/ (last; the app never lists them).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@adobe/css-tools';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILTIN_DIRECTORY = path.join(REPO_ROOT, 'public', 'themes');
/** Documented example packs (docs/theme-examples/): not shipped as themes, only to learn from and copy. */
export const EXAMPLE_DIRECTORY = path.join(REPO_ROOT, 'docs', 'theme-examples');
export const TOKENS_PATH = path.join(REPO_ROOT, 'public', 'css', 'tokens.css');
export const KNOBS_PATH = path.join(REPO_ROOT, 'public', 'kotatsu', 'theme', 'knobs.json');
/** The loader's boot-time slice of the catalog (name → contexts), written beside it by theme:knobs. */
export const RUNTIME_KNOBS_PATH = path.join(REPO_ROOT, 'public', 'kotatsu', 'theme', 'knobs.runtime.json');
export const ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * The user-pack folder for a data user handle (default: default-user).
 * @param {string} [handle]
 * @returns {string}
 */
export function userPackDirectory(handle = 'default-user') {
    return path.join(REPO_ROOT, 'data', handle, 'theme-packs');
}

/**
 * Finds a pack folder by id: user packs first, then built-in ones, then (only when asked) the
 * documented examples. The app never lists an example, so an example can be read, checked and
 * COPIED (`theme:new --from`), but it can never be a parent (`extends`): the app would not find it.
 * @param {string} id
 * @param {string} [handle]
 * @param {{examples?: boolean}} [options] `examples: true` also looks in docs/theme-examples/.
 * @returns {Promise<{directory: string, source: 'user'|'builtin'|'example'}|null>}
 */
export async function findPack(id, handle, { examples = false } = {}) {
    /** @type {[string, 'user'|'builtin'|'example'][]} */
    const places = [[userPackDirectory(handle), 'user'], [BUILTIN_DIRECTORY, 'builtin']];
    if (examples) places.push([EXAMPLE_DIRECTORY, 'example']);
    for (const [base, source] of places) {
        const directory = path.join(base, id);
        try {
            await fs.access(path.join(directory, 'theme.json'));
            return { directory, source };
        } catch {
            // try the next location
        }
    }
    return null;
}

/**
 * Reads the canonical :root token declarations (name → value) and the comments above them.
 * @returns {Promise<{tokens: Record<string, string>, catalog: {token: string, value: string, comment: string, section: string}[]}>}
 */
export async function readCoreTokens() {
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

    /** @type {Record<string, string>} */
    const tokens = {};
    const catalog = [];
    let section = 'Tokens';
    /** @type {string[]} */
    let pending = [];
    for (const declaration of rootRule.declarations ?? []) {
        if (declaration.type === 'comment') {
            const text = declaration.comment.replace(/[─]+/g, ' ').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            if (declaration.comment.includes('──')) {
                section = text.split('.')[0].trim();
                pending = [text.slice(section.length).replace(/^\.\s*/, '')].filter(Boolean);
            } else {
                pending.push(text);
            }
            continue;
        }
        if (declaration.type !== 'declaration' || !declaration.property.startsWith('--k-')) continue;
        tokens[declaration.property] = declaration.value;
        catalog.push({ token: declaration.property, value: declaration.value.replace(/\s+/g, ' ').trim(), comment: pending.join(' '), section });
        pending = [];
    }
    return { tokens, catalog };
}

/**
 * Reads the component-knob catalog.
 * @returns {Promise<{knobs: Record<string, {group: string, file: string, default: string, note?: string, contexts: {selector: string, at: string[]}[]}>}>}
 */
export async function readKnobs() {
    return JSON.parse(await fs.readFile(KNOBS_PATH, 'utf8'));
}

/**
 * Says one at-rule condition (`@media (max-width: 600px)`) in plain words.
 * @param {string} prelude
 * @returns {string}
 */
export function describeCondition(prelude) {
    const parts = prelude.replace(/^@media\s+/i, '').replace(/^screen\s+and\s+/i, '').split(/\s+and\s+/i);
    const words = parts.map(part => {
        const media = /^\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/i.exec(part.trim());
        if (media) return media[1].toLowerCase() === 'max'
            ? `the window is ${media[2]} pixels wide or narrower`
            : `the window is at least ${media[2]} pixels wide`;
        if (/^\(\s*prefers-contrast\s*:\s*more\s*\)$/i.test(part.trim())) return 'the reader has asked their system for more contrast';
        if (/^\(\s*pointer\s*:\s*coarse\s*\)$/i.test(part.trim())) return 'on a touch screen';
        if (/^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i.test(part.trim())) return 'the reader has asked for less motion';
        return `"${part.trim()}" is true`;
    });
    return words.join(' and ');
}

/**
 * Where a component knob's value takes effect, in plain words. A pack's value is re-declared in
 * exactly the places the stylesheets declare the knob (public/kotatsu/theme/knobs.js), so:
 *   - declared only inside conditions (a phone-width rule) → the value only applies there;
 *   - declared plainly AND inside conditions → the pack value replaces the conditional ones too,
 *     so it no longer changes with the window (or setting);
 *   - declared plainly only → it simply applies.
 * @param {{contexts: {selector: string, at: string[]}[]}} entry
 * @returns {{reach: 'always'|'only'|'fixed', text: string}}
 */
export function describeKnobReach(entry) {
    const conditional = entry.contexts.filter(context => context.at.length > 0);
    const conditions = [...new Set(conditional.map(context => context.at.map(describeCondition).join(' and ')))];
    if (conditional.length === 0) return { reach: 'always', text: 'applies everywhere it is used' };
    if (conditional.length === entry.contexts.length) {
        return { reach: 'only', text: `only takes effect when ${conditions.join(', or when ')}; the rest of the time Kotatsu's own value is used` };
    }
    return { reach: 'fixed', text: `normally changes when ${conditions.join(', or when ')}; your value replaces that, so it stays the same all the time` };
}

/**
 * Turns a slug into a display name.
 * @param {string} id
 * @returns {string}
 */
export function displayName(id) {
    const name = id.split('-').filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
    return name || id;
}
