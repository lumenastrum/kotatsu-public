import fs from 'node:fs';

import _ from 'lodash';
import yaml from 'yaml';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfig, getConfigFilePath } from '../../util.js';

/**
 * Surgical config.yaml writes, shared by every Kotatsu surface that may change a config key
 * (the bridge's Connection-tab settings, the phone card's LAN switch). Born in connections-v0 C4
 * as the bridge's `applyPatchToYaml`; generalized to any key path for phone-v0 §3.5.
 *
 * The parsed document only *locates* each value's source range, and just those bytes are
 * replaced. Every other byte — comments, their alignment, indentation, flow lists — stays exactly
 * as the person wrote it (re-serializing the whole document restyled untouched sections; caught
 * in a live diff). A key the file doesn't have yet is added at the end of its parent block, or at
 * the end of the file for a top-level key. The result is re-parsed and checked before it is
 * returned.
 */

/** @typedef {[string[], any]} PathValue A key path from the document root, and its new value. */

/**
 * A value as YAML source: plain where that's unambiguous, quoted otherwise. Pure.
 * @param {unknown} value
 * @returns {string}
 */
export function yamlScalar(value) {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    const text = String(value);
    return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) && !/^(true|false|null|yes|no|on|off|~|[-+]?[0-9.]+)$/i.test(text) ? text : JSON.stringify(text);
}

/**
 * Writes values at key paths into YAML text as surgical edits. Pure over the text.
 * @param {string} text config.yaml contents
 * @param {PathValue[]} entries
 * @returns {string}
 */
export function applyPathsToYaml(text, entries) {
    const doc = yaml.parseDocument(text);
    if (doc.errors.length) throw new Error(`config.yaml has a syntax error: ${doc.errors[0].message}`);
    // New lines are written in the file's own line ending: a Windows checkout's config.yaml is
    // CRLF, and bare LFs left it mixed.
    const eol = text.match(/\r?\n/)?.[0] ?? '\n';
    /** @type {Array<[number, number, string]>} */
    const edits = [];
    /** @type {Map<string, { parent: string[], items: Array<[string, any]> }>} */
    const missing = new Map();
    for (const [path, value] of entries) {
        if (!path.length) throw new Error('A config path needs at least one key');
        const node = doc.getIn(path, true);
        const range = /** @type {any} */ (node)?.range;
        if (yaml.isScalar(node) && Array.isArray(range) && !Array.isArray(value)) {
            edits.push([range[0], range[1], yamlScalar(value)]);
        } else if (yaml.isSeq(node) && Array.isArray(range) && Array.isArray(value)) {
            if (node.flow) {
                edits.push([range[0], range[1], `[${value.map(yamlScalar).join(', ')}]`]);
            } else {
                const lineStart = text.lastIndexOf('\n', range[0] - 1) + 1;
                const indent = text.slice(lineStart, range[0]);
                // A block sequence's range runs to the end of its last line; keep that newline.
                const tail = /\r?\n$/.exec(text.slice(range[0], range[1]))?.[0].length ?? 0;
                edits.push([range[0], range[1] - tail, value.map(item => `- ${yamlScalar(item)}`).join(`${eol}${indent}`)]);
            }
        } else {
            const parent = path.slice(0, -1);
            const key = JSON.stringify(parent);
            if (!missing.has(key)) missing.set(key, { parent, items: [] });
            missing.get(key)?.items.push([path[path.length - 1], value]);
        }
    }
    let next = text;
    for (const [start, end, replacement] of edits.sort((x, y) => y[0] - x[0])) {
        next = next.slice(0, start) + replacement + next.slice(end);
    }
    for (const { parent, items } of missing.values()) {
        next = appendMissing(next, parent, items, eol);
    }
    const check = yaml.parse(next);
    for (const [path, value] of entries) {
        if (!_.isEqual(_.get(check, path), value)) throw new Error(`Writing ${path.join('.')} to config.yaml didn't take; nothing was saved`);
    }
    return next;
}

/**
 * Adds keys a block lacks, at the block's own indentation. Re-parses the (already edited) text so
 * the block's end is measured where it is now.
 * @param {string} text
 * @param {string[]} parent Path of the block; `[]` is the document root
 * @param {Array<[string, any]>} items
 * @param {string} eol
 * @returns {string}
 */
function appendMissing(text, parent, items, eol) {
    const doc = yaml.parseDocument(text);
    const block = parent.length ? doc.getIn(parent, true) : doc.contents;
    const blockRange = /** @type {any} */ (block)?.range;
    if (yaml.isMap(block) && !block.flow && Array.isArray(blockRange) && block.items.length) {
        const firstKey = /** @type {any} */ (block.items[0].key).range[0];
        const indent = text.slice(text.lastIndexOf('\n', firstKey - 1) + 1, firstKey);
        const lines = items.map(([key, value]) => (Array.isArray(value)
            ? `${indent}${key}:${eol}${value.map(item => `${indent}  - ${yamlScalar(item)}`).join(eol)}`
            : `${indent}${key}: ${yamlScalar(value)}`)).join(eol);
        // A top-level key goes at the very end of the file, after any trailing comments.
        const end = parent.length ? blockRange[1] : text.length;
        const head = text.slice(0, end);
        return `${head}${head.endsWith('\n') || !head.length ? '' : eol}${lines}${eol}${text.slice(end)}`;
    }
    // No block to extend: the only case that lets the serializer write it.
    for (const [key, value] of items) doc.setIn([...parent, key], value);
    let next = doc.toString();
    if (eol !== '\n') next = next.replace(/\r?\n/g, eol);
    return next;
}

/**
 * Writes values to config.yaml (atomically) and to the process's cached config, so a later
 * `getConfigValue()` agrees with the file. Boot-time readers (listen, whitelists) still need a
 * restart; that is the caller's to say.
 * @param {PathValue[]} entries
 * @returns {void}
 */
export function writeConfigValues(entries) {
    const file = getConfigFilePath();
    if (!file) throw new Error('No config.yaml path is set');
    const next = applyPathsToYaml(fs.readFileSync(file, 'utf8'), entries);
    writeFileAtomicSync(file, next, 'utf8');
    const cached = getConfig();
    for (const [path, value] of entries) _.set(cached, path, value);
}
