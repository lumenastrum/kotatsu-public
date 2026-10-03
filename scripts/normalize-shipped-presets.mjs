#!/usr/bin/env node
/**
 * Produces the shipped copies of every bundled chat completion preset.
 *
 * The list is the credits manifest, public/kotatsu/prompts/preset-credits.json
 * (docs/preset-bundle-v0.md): each entry names its source — Kotatsu Nabe's tracked fixture, or an
 * author's file kept byte-exact under default/presets-upstream/. Sources are NEVER written by this
 * script. The shipped copy under default/content/presets/openai/ differs from its source in the
 * connection keys alone, so a fresh install points at the local Claude bridge instead of whatever
 * endpoint the preset was last saved against (docs/ship-v0.md decision 4).
 *
 * Every other byte is proven equal. The script detects how the source was written (SillyTavern's
 * own writer uses 4 spaces and no trailing newline; some authors save with 2), refuses any source
 * that doesn't round-trip byte for byte in that style, writes the shipped copy in the same style,
 * and checks that reverting the override keys reproduces the source exactly. An upstream file must
 * also still be the file its author published: its git blob hash must equal the manifest's.
 *
 * The shipped folder holds exactly the manifest's presets plus SillyTavern's own Default.json; a
 * stray file fails the run, so a preset can't ship without an entry (and a permission) by accident.
 *
 * Idempotent: re-running with no upstream change rewrites nothing and says so.
 *
 * Usage: node scripts/normalize-shipped-presets.mjs [--check]
 *   --check  report what would change and exit 1 if anything would, without writing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'public', 'kotatsu', 'prompts', 'preset-credits.json');
const TARGET_DIR = path.join(ROOT, 'default', 'content', 'presets', 'openai');
/** SillyTavern's own preset ships untouched and isn't credited. */
const STOCK = new Set(['Default.json']);

/**
 * The only keys this script is allowed to change. Every one of them must already exist in
 * the source preset — assigning to an existing key preserves its position, so the key order
 * of the shipped copy is the key order of the source.
 * @type {Record<string, string|number|boolean>}
 */
const CONNECTION_OVERRIDES = {
    chat_completion_source: 'custom',
    custom_url: 'http://127.0.0.1:5107/v1',
    custom_model: 'claude-sonnet-5-5',
    // Presets often carry stream_openai: false, and it is not a connection key, so selecting the
    // preset would flip streaming off under the seeded settings. A fresh install streams.
    stream_openai: true,
    // Decision 2026-10-01: default context is 1M; users lower it if they want. Core clamps to each model's real
    // ceiling on its own (openai.js), so smaller models stay honest.
    openai_max_context: 1000000,
};

const checkOnly = process.argv.includes('--check');

/** @typedef {{ indent: number|string, newline: string }} Format */

/**
 * Finds the serialization a file was written with, by round trip. Pure.
 * @param {Buffer} bytes File contents
 * @param {object} parsed The parsed preset
 * @returns {Format|null} The format that reproduces the file byte for byte, if any
 */
export function detectFormat(bytes, parsed) {
    // 0 = compact, everything on one line (how NemoEngine publishes Vivarium).
    for (const indent of [4, 2, '\t', 0]) {
        for (const newline of ['', '\n']) {
            if (Buffer.from(JSON.stringify(parsed, null, indent) + newline, 'utf-8').equals(bytes)) return { indent, newline };
        }
    }
    return null;
}

/**
 * Serializes a preset in a given format.
 * @param {object} preset Preset object
 * @param {Format} format Format
 * @returns {Buffer} Serialized preset
 */
function serialize(preset, format) {
    return Buffer.from(JSON.stringify(preset, null, format.indent) + format.newline, 'utf-8');
}

/**
 * Git's blob hash of some bytes (what `git hash-object` and GitHub's tree API report).
 * @param {Buffer} bytes File contents
 * @returns {string} 40-hex blob id
 */
export function gitBlobHash(bytes) {
    return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * @param {string[]} a First key list
 * @param {string[]} b Second key list
 * @returns {boolean} Whether the lists match exactly
 */
function sameOrder(a, b) {
    return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * @param {object} before Source preset
 * @param {object} after Normalized preset
 * @returns {{ key: string, from: unknown, to: unknown }[]} Differing keys
 */
function diffKeys(before, after) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys
        .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        .map(key => ({ key, from: before[key], to: after[key] }));
}

/**
 * @param {unknown} value Value to render
 * @returns {string} Printable value, truncated
 */
function preview(value) {
    const text = JSON.stringify(value);
    if (text === undefined) return '<absent>';
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const entries = Object.entries(manifest.presets ?? {});
    let wrote = 0;
    let wouldChange = 0;
    let failed = 0;

    fs.mkdirSync(TARGET_DIR, { recursive: true });

    for (const [name, entry] of entries) {
        const filename = `${name}.json`;
        const sourcePath = path.join(ROOT, entry.source);
        const targetPath = path.join(TARGET_DIR, filename);

        console.log(`\n=== ${filename} ===`);
        console.log(`source: ${entry.source}`);
        console.log(`target: ${path.relative(ROOT, targetPath)}`);

        if (!['own', 'granted'].includes(entry.permission?.status)) {
            console.error(`  FAIL: permission is "${entry.permission?.status}", not granted. Only "own" and "granted" presets ship.`);
            failed++;
            continue;
        }
        if (!fs.existsSync(sourcePath)) {
            console.error('  FAIL: source not found. This script never invents a preset.');
            failed++;
            continue;
        }

        const sourceBytes = fs.readFileSync(sourcePath);
        if (entry.upstream?.blob) {
            const blob = gitBlobHash(sourceBytes);
            if (blob !== entry.upstream.blob) {
                console.error(`  FAIL: source is not the author's published file (blob ${blob.slice(0, 12)}, manifest says ${entry.upstream.blob.slice(0, 12)}).`);
                failed++;
                continue;
            }
            console.log(`  provenance: git blob ${blob.slice(0, 12)} matches ${entry.upstream.repo}/${entry.upstream.path}`);
        }

        const source = JSON.parse(sourceBytes.toString('utf-8'));
        const format = detectFormat(sourceBytes, source);
        if (!format) {
            console.error('  FAIL: source is not byte-stable under JSON.stringify in any indent (4, 2, tab), with or without a final newline.');
            console.error('        Refusing to write — "only the connection keys changed" would be unprovable.');
            failed++;
            continue;
        }
        console.log(`  round-trip check: OK (${sourceBytes.length} B, indent ${JSON.stringify(format.indent)}, final newline ${format.newline ? 'yes' : 'no'})`);

        // A key the source doesn't carry stays absent: adding it would append to the end and change
        // key order, and a preset without (say) a connection source can't move the user's
        // connection when it's selected anyway.
        const overrides = Object.fromEntries(Object.entries(CONNECTION_OVERRIDES).filter(([key]) => Object.hasOwn(source, key)));
        const absent = Object.keys(CONNECTION_OVERRIDES).filter(key => !Object.hasOwn(source, key));
        if (absent.length > 0) console.log(`  left absent (the source doesn't carry them): ${absent.join(', ')}`);

        const normalized = JSON.parse(sourceBytes.toString('utf-8'));
        for (const [key, value] of Object.entries(overrides)) normalized[key] = value;

        if (!sameOrder(Object.keys(source), Object.keys(normalized))) {
            console.error('  FAIL: key order drifted. Refusing to write.');
            failed++;
            continue;
        }

        const changes = diffKeys(source, normalized);
        console.log(`  key-level diff vs source (${changes.length} key(s) changed):`);
        for (const change of changes) console.log(`    ~ ${change.key}: ${preview(change.from)} -> ${preview(change.to)}`);
        const unexpected = changes.filter(change => !Object.hasOwn(CONNECTION_OVERRIDES, change.key));
        if (unexpected.length > 0) {
            console.error(`  FAIL: unexpected key(s) changed: ${unexpected.map(c => c.key).join(', ')}`);
            failed++;
            continue;
        }

        const output = serialize(normalized, format);
        const untouched = JSON.parse(output.toString('utf-8'));
        for (const key of Object.keys(overrides)) untouched[key] = source[key];
        if (!serialize(untouched, format).equals(sourceBytes)) {
            console.error('  FAIL: reverting the override keys did not reproduce the source byte for byte.');
            failed++;
            continue;
        }
        console.log('  byte proof: reverting only those keys reproduces the source exactly');

        const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath) : null;
        if (existing && existing.equals(output)) {
            console.log(`  result: already up to date (${output.length} B) — nothing written`);
            continue;
        }
        if (checkOnly) {
            console.log(`  result: WOULD ${existing ? 'update' : 'create'} (${output.length} B) — --check, not written`);
            wouldChange++;
            continue;
        }
        fs.writeFileSync(targetPath, output);
        console.log(`  result: ${existing ? 'updated' : 'created'} (${output.length} B)`);
        wrote++;
    }

    // No strays: everything shipped is in the manifest (or is SillyTavern's own Default).
    const expected = new Set([...entries.map(([name]) => `${name}.json`), ...STOCK]);
    const strays = fs.readdirSync(TARGET_DIR).filter(file => file.endsWith('.json') && !expected.has(file));
    if (strays.length > 0) {
        console.error(`\nFAIL: shipped preset(s) with no manifest entry: ${strays.join(', ')}`);
        console.error('      Add an entry with a granted permission, or remove the file.');
        failed += strays.length;
    }

    console.log('');
    if (failed > 0) {
        console.error(`normalize-shipped-presets: ${failed} problem(s). Nothing usable was produced for them.`);
        process.exit(1);
    }
    if (checkOnly && wouldChange > 0) {
        console.error(`normalize-shipped-presets: ${wouldChange} preset(s) out of date.`);
        process.exit(1);
    }
    console.log(`normalize-shipped-presets: ${entries.length} preset(s) checked, ${wrote} written.`);
}
