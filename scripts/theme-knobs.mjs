// Builds the component-knob catalog (public/kotatsu/theme/knobs.json) from the real stylesheets,
// and its boot-time slice (knobs.runtime.json: knob name → contexts, nothing else), which is all
// the theme loader fetches. The full catalog is for authors and the authoring tools.
//
// A knob is any `--k-*` custom property a Kotatsu sheet declares for its own component that is not
// a core token in public/css/tokens.css. The catalog lists every context that declares each knob
// so the theme loader can re-declare a pack's value in exactly those places (theme/knobs.js).
//
// usage: npm run theme:knobs            regenerate both files
//        npm run theme:knobs -- --check fail if either committed file is stale (tests run this too)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@adobe/css-tools';

import { KNOBS_PATH, readCoreTokens, REPO_ROOT, RUNTIME_KNOBS_PATH } from './theme-lib.mjs';

const PUBLIC = path.join(REPO_ROOT, 'public');
const CONTAINER_AT_RULES = new Set(['media', 'supports', 'container', 'layer']);

/**
 * Custom properties that LOOK like knobs but belong to someone else. A pack must not set them.
 * @type {Record<string, string>}
 */
export const INTERNAL_PROPERTIES = {
    '--k-prose-scale': 'the reader\'s own Reading size setting',
    '--k-cc-track-extra': 'computed from the message look the reader picked',
    '--k-motion-gate': 'the reduced-motion switch',
    '--k-t1': 'the reduced-motion switch',
    '--k-t2': 'the reduced-motion switch',
    '--k-t3': 'the reduced-motion switch',
    '--k-ext-inset-left': 'measured by a script at runtime',
    '--k-ext-inset-right': 'measured by a script at runtime',
    '--k-ind-x': 'measured by a script at runtime',
    '--k-ind-y': 'measured by a script at runtime',
    '--k-ind-w': 'measured by a script at runtime',
    '--k-ind-h': 'measured by a script at runtime',
    '--k-jl-offset': 'measured by a script at runtime',
    '--k-mes-avatar': 'written per message by the renderer',
    '--k-mes-avatar-thumb': 'written per message by the renderer',
    '--k-mes-avatar-original': 'written per message by the renderer',
};

/** Friendly component names for the catalog, by stylesheet. */
const GROUPS = {
    'css/kotatsu-chrome.css': 'Chrome: fills, backdrop, inset cards',
    'css/shell-frame.css': 'Shell frame',
    'css/shell-topbar.css': 'Top bar',
    'css/shell-left.css': 'Left rail',
    'css/shell-right.css': 'Right rail',
    'css/shell-center.css': 'Reading column',
    'css/shell-panels.css': 'Docked panels',
    'css/shell-ext-dock.css': 'Extension dock',
    'css/mes-variants.css': 'Message looks (wardrobe)',
    'css/mes-metrics.css': 'Message metrics',
    'css/library.css': 'Library',
    'css/studio.css': 'Card studio',
    'css/market.css': 'Marketplace',
    'css/onboarding.css': 'Welcome tour',
    'css/branch-map.css': 'Branch map',
    'css/prompt-list.css': 'Prompt list',
    'css/preset-dock.css': 'Preset dock',
    'css/rechrome-controls.css': 'Controls',
    'css/rechrome-fields.css': 'Fields',
    'css/rechrome-popups.css': 'Popups',
    'css/rechrome-rack.css': 'Rack',
    'css/kotatsu-connections.css': 'Connections',
    'css/kotatsu-chatgpt.css': 'ChatGPT bridge',
    'css/receipt-tracker.css': 'Receipts',
    'css/kotatsu-motion.css': 'Motion',
    'css/kotatsu-phone.css': 'Phone',
    'css/phone-card.css': 'Phone card',
    'kotatsu/settings/settings-modal.css': 'Settings',
};

/**
 * Lists the stylesheets that can declare knobs, relative to public/.
 * @returns {Promise<string[]>}
 */
async function listSheets() {
    const css = (await fs.readdir(path.join(PUBLIC, 'css')))
        .filter(name => name.endsWith('.css') && !name.endsWith('.min.css') && name !== 'tokens.css' && name !== 'user.css')
        .map(name => `css/${name}`);
    /** @type {string[]} */
    const kotatsu = [];
    async function walk(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith('.css')) kotatsu.push(path.relative(PUBLIC, full).split(path.sep).join('/'));
        }
    }
    await walk(path.join(PUBLIC, 'kotatsu'));
    return ['style.css', ...css, ...kotatsu].sort();
}

/**
 * Collapses a CSS comment into one catalog line.
 * @param {string} comment
 * @returns {string}
 */
function cleanComment(comment) {
    return comment.replace(/[─═]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Finds the fallback text of the var() call starting at `open` (index of its '(').
 * @param {string} css
 * @param {number} comma Index of the comma that starts the fallback.
 * @returns {string}
 */
function readFallback(css, comma) {
    let depth = 1;
    for (let index = comma + 1; index < css.length; index++) {
        if (css[index] === '(') depth++;
        else if (css[index] === ')' && --depth === 0) return css.slice(comma + 1, index).trim();
    }
    return '';
}

/**
 * Builds the catalog object (deterministic: knobs sorted by name, contexts in source order).
 * @returns {Promise<{generated: string, knobs: Record<string, import('../public/kotatsu/theme/knobs.js').KnobEntry>}>}
 */
export async function buildKnobRegistry() {
    const core = new Set(Object.keys((await readCoreTokens()).tokens));
    /** @type {Map<string, import('../public/kotatsu/theme/knobs.js').KnobEntry>} */
    const knobs = new Map();
    /** @type {Map<string, {file: string, fallback: string}>} */
    const consumed = new Map();

    for (const file of await listSheets()) {
        const source = await fs.readFile(path.join(PUBLIC, file), 'utf8');
        const ast = parse(source, { source: file, silent: true });

        /**
         * @param {any[]} rules
         * @param {string[]} at
         */
        const visit = (rules, at) => {
            for (const rule of rules) {
                if (rule.type === 'rule') {
                    let pendingComment = '';
                    for (const declaration of rule.declarations ?? []) {
                        if (declaration.type === 'comment') {
                            pendingComment = cleanComment(declaration.comment);
                            continue;
                        }
                        const name = declaration.property;
                        if (declaration.type !== 'declaration' || !name?.startsWith('--k-')
                            || core.has(name) || name in INTERNAL_PROPERTIES) {
                            pendingComment = '';
                            continue;
                        }
                        let entry = knobs.get(name);
                        if (!entry) {
                            entry = {
                                group: GROUPS[file] ?? file,
                                file,
                                default: declaration.value.replace(/\s+/g, ' ').trim(),
                                ...(pendingComment ? { note: pendingComment } : {}),
                                contexts: [],
                            };
                            knobs.set(name, entry);
                        }
                        for (const selector of rule.selectors) {
                            const clean = selector.replace(/\s+/g, ' ').trim();
                            if (!entry.contexts.some(c => c.selector === clean && c.at.join() === at.join())) {
                                entry.contexts.push({ selector: clean, at: [...at] });
                            }
                        }
                        pendingComment = '';
                    }
                } else if (CONTAINER_AT_RULES.has(rule.type) && Array.isArray(rule.rules)) {
                    const prelude = rule.type === 'layer' ? null : `@${rule.type} ${String(rule[rule.type] ?? '').replace(/\s+/g, ' ').trim()}`;
                    visit(rule.rules, prelude ? [...at, prelude] : at);
                }
            }
        };
        visit(ast.stylesheet.rules, []);

        for (const match of source.matchAll(/var\(\s*(--k-[a-z0-9-]+)\s*,/g)) {
            const name = match[1];
            if (!consumed.has(name)) consumed.set(name, { file, fallback: readFallback(source, match.index + match[0].length - 1) });
        }
    }

    for (const [name, use] of consumed) {
        if (knobs.has(name) || core.has(name) || name in INTERNAL_PROPERTIES) continue;
        knobs.set(name, {
            group: GROUPS[use.file] ?? use.file,
            file: use.file,
            default: use.fallback.replace(/\s+/g, ' '),
            note: 'Not declared anywhere: the sheet reads it with a built-in fallback, so setting it applies everywhere.',
            contexts: [],
        });
    }

    return {
        generated: 'by `npm run theme:knobs` from the stylesheets in public/. Do not edit by hand.',
        knobs: Object.fromEntries([...knobs.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
}

/**
 * Serializes the catalog the way it is committed.
 * @param {object} registry
 * @returns {string}
 */
export function serializeRegistry(registry) {
    return `${JSON.stringify(registry, null, 1)}\n`;
}

/**
 * Serializes the boot-time slice: each knob's contexts and nothing else, with the few dozen
 * distinct selectors and at-rules stored once (public/kotatsu/theme/knobs.js
 * `expandRuntimeRegistry` reads it back).
 * @param {{knobs: Record<string, {contexts: {selector: string, at: string[]}[]}>}} registry
 * @returns {string}
 */
export function serializeRuntimeRegistry(registry) {
    /** @type {string[]} */
    const selectors = [];
    /** @type {string[]} */
    const at = [];
    const indexOf = (/** @type {string[]} */ list, /** @type {string} */ value) => {
        let index = list.indexOf(value);
        if (index === -1) index = list.push(value) - 1;
        return index;
    };
    const knobs = Object.fromEntries(Object.entries(registry.knobs).map(([name, entry]) => [
        name,
        entry.contexts.map(context => [indexOf(selectors, context.selector), ...context.at.map(prelude => indexOf(at, prelude))]),
    ]));
    return `${JSON.stringify({ generated: 'by `npm run theme:knobs` with knobs.json, for the theme loader. Do not edit by hand.', selectors, at, knobs })}\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const registry = await buildKnobRegistry();
    const count = Object.keys(registry.knobs).length;
    const files = [[KNOBS_PATH, serializeRegistry(registry)], [RUNTIME_KNOBS_PATH, serializeRuntimeRegistry(registry)]];
    for (const [file, text] of files) {
        const name = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        if (process.argv.includes('--check')) {
            const current = (await fs.readFile(file, 'utf8').catch(() => '')).replace(/\r\n/g, '\n');
            if (current !== text) {
                console.error(`${name} is stale: a stylesheet added, removed or moved a --k-* knob. Run \`npm run theme:knobs\`.`);
                process.exitCode = 1;
            } else {
                console.log(`${name} is current (${count} knobs).`);
            }
        } else {
            await fs.writeFile(file, text, 'utf8');
            console.log(`Wrote ${name} (${count} knobs).`);
        }
    }
}
