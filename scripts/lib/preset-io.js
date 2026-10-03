import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Reads a preset JSON file (BOM tolerated).
 * @param {string} file
 * @returns {any}
 */
export function readPreset(file) {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

/**
 * @param {string} file
 * @returns {string[]}
 */
function pathsFrom(file) {
    if (!fs.existsSync(file)) return [];
    const data = readPreset(file);
    return Array.isArray(data?.paths) ? data.paths.map(String) : [];
}

/**
 * The default reference list: tracked `scripts/preset-references.json` (repo-relative fixture
 * paths), then the untracked `scripts/preset-references.local.json` (machine-specific absolute
 * paths), then `KOTATSU_PRESET_REFS` (path-delimiter separated). Relative paths resolve against
 * the repo root. Duplicates collapse.
 * @returns {string[]}
 */
export function defaultReferencePaths() {
    const all = [
        ...pathsFrom(path.join(ROOT, 'scripts', 'preset-references.json')),
        ...pathsFrom(path.join(ROOT, 'scripts', 'preset-references.local.json')),
        ...(process.env.KOTATSU_PRESET_REFS ?? '').split(path.delimiter).filter(Boolean),
    ];
    return [...new Set(all.map(p => path.resolve(ROOT, p)))];
}

/**
 * Expands directories to their *.json files (non-recursive); files pass through.
 * @param {string[]} inputs
 * @returns {string[]}
 */
export function expandPaths(inputs) {
    /** @type {string[]} */
    const out = [];
    for (const input of inputs) {
        const abs = path.resolve(input);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            for (const f of fs.readdirSync(abs).sort()) if (f.toLowerCase().endsWith('.json')) out.push(path.join(abs, f));
        } else {
            out.push(abs);
        }
    }
    return out;
}
