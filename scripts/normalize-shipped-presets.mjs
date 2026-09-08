#!/usr/bin/env node
/**
 * Produces the shipped copies of the acceptance-fixture chat completion presets.
 *
 * Source of truth = the data-dir fixtures (docs/data-contract.md §4.5, referenced by
 * tests/util/openai-harness.js). Those files are NEVER written by this script. The shipped
 * copies under default/content/presets/openai/ differ from them in exactly three keys — the
 * stale connection state the fixtures carry — so a fresh install points at the local Claude
 * bridge instead of whatever endpoint the preset was last saved against.
 *
 * See docs/ship-v0.md decision 4.
 *
 * Serialization matches SillyTavern's own preset writer (`JSON.stringify(preset, null, 4)`,
 * see onExportPresetClick in public/scripts/openai.js): 4-space indent, LF, no trailing
 * newline. The script refuses to write unless the source file is byte-identical to that
 * round trip, which is what makes "every other byte equal" a provable claim rather than a
 * hopeful one.
 *
 * Idempotent: re-running with no upstream change rewrites nothing and says so.
 *
 * Usage: node scripts/normalize-shipped-presets.mjs [--check]
 *   --check  report what would change and exit 1 if anything would, without writing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'data', 'default-user', 'OpenAI Settings');
const TARGET_DIR = path.join(ROOT, 'default', 'content', 'presets', 'openai');

/** Fixture basenames (without extension) that ship with a fresh install. */
const PRESETS = [
    'Clio\'s Sparkle Sauce v1',
    'Marinara\'s Spaghetti Recipe 10',
];

/**
 * The only keys this script is allowed to change. Every one of them must already exist in
 * the source preset — assigning to an existing key preserves its position, so the key order
 * of the shipped copy is the key order of the fixture.
 * @type {Record<string, string>}
 */
const CONNECTION_OVERRIDES = {
    chat_completion_source: 'custom',
    custom_url: 'http://127.0.0.1:5107/v1',
    custom_model: 'claude-sonnet-4-6',
    // Both fixtures carry stream_openai: false and it is not a connection key, so selecting the
    // preset would flip streaming off under the seeded settings. A fresh install streams.
    stream_openai: true,
};

const checkOnly = process.argv.includes('--check');

/**
 * Serializes a preset the way SillyTavern does.
 * @param {object} preset Preset object
 * @returns {string} Serialized preset
 */
function serialize(preset) {
    return JSON.stringify(preset, null, 4);
}

/**
 * Compares two key lists for identical membership and identical order.
 * @param {string[]} a First key list
 * @param {string[]} b Second key list
 * @returns {boolean} Whether the lists match exactly
 */
function sameOrder(a, b) {
    return a.length === b.length && a.every((key, i) => key === b[i]);
}

/**
 * Collects the key-level differences between two presets.
 * @param {object} before Source preset
 * @param {object} after Normalized preset
 * @returns {{ key: string, from: unknown, to: unknown }[]} Differing keys
 */
function diffKeys(before, after) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const changes = [];
    for (const key of keys) {
        const from = JSON.stringify(before[key]);
        const to = JSON.stringify(after[key]);
        if (from !== to) {
            changes.push({ key, from: before[key], to: after[key] });
        }
    }
    return changes;
}

/**
 * Renders a value for the diff output, truncated so a prompt array cannot flood the log.
 * @param {unknown} value Value to render
 * @returns {string} Printable value
 */
function preview(value) {
    const text = JSON.stringify(value);
    if (text === undefined) {
        return '<absent>';
    }
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

let wrote = 0;
let wouldChange = 0;
let failed = 0;

fs.mkdirSync(TARGET_DIR, { recursive: true });

for (const name of PRESETS) {
    const filename = `${name}.json`;
    const sourcePath = path.join(SOURCE_DIR, filename);
    const targetPath = path.join(TARGET_DIR, filename);

    console.log(`\n=== ${filename} ===`);
    console.log(`source: ${path.relative(ROOT, sourcePath)}`);
    console.log(`target: ${path.relative(ROOT, targetPath)}`);

    if (!fs.existsSync(sourcePath)) {
        console.error('  FAIL: source fixture not found. This script never invents a preset.');
        failed++;
        continue;
    }

    const sourceBytes = fs.readFileSync(sourcePath);
    const source = JSON.parse(sourceBytes.toString('utf-8'));

    // Guard: our serializer must reproduce the fixture byte for byte, otherwise "only three
    // keys changed" would be unprovable — a formatting drift would hide inside the diff.
    const roundTrip = Buffer.from(serialize(source), 'utf-8');
    if (!roundTrip.equals(sourceBytes)) {
        console.error('  FAIL: fixture is not byte-stable under JSON.stringify(x, null, 4).');
        console.error(`        disk=${sourceBytes.length}B round-trip=${roundTrip.length}B`);
        console.error('        Refusing to write — fix the serializer, do not paper over it.');
        failed++;
        continue;
    }
    console.log(`  round-trip check: OK (${sourceBytes.length} B in, ${roundTrip.length} B out, byte-identical)`);

    // Guard: every override key must pre-exist, so key order is untouched.
    const missing = Object.keys(CONNECTION_OVERRIDES).filter(key => !Object.hasOwn(source, key));
    if (missing.length > 0) {
        console.error(`  FAIL: fixture lacks override key(s): ${missing.join(', ')}`);
        console.error('        Adding them would append to the end and change key order.');
        failed++;
        continue;
    }

    const normalized = JSON.parse(sourceBytes.toString('utf-8'));
    for (const [key, value] of Object.entries(CONNECTION_OVERRIDES)) {
        normalized[key] = value;
    }

    const sourceKeys = Object.keys(source);
    const normalizedKeys = Object.keys(normalized);
    if (!sameOrder(sourceKeys, normalizedKeys)) {
        console.error('  FAIL: key order drifted. Refusing to write.');
        failed++;
        continue;
    }
    console.log(`  key order: unchanged (${sourceKeys.length} top-level keys, same sequence)`);

    const changes = diffKeys(source, normalized);
    console.log(`  key-level diff vs fixture (${changes.length} key(s) changed):`);
    for (const change of changes) {
        console.log(`    ~ ${change.key}: ${preview(change.from)} -> ${preview(change.to)}`);
    }

    const unexpected = changes.filter(change => !Object.hasOwn(CONNECTION_OVERRIDES, change.key));
    if (unexpected.length > 0) {
        console.error(`  FAIL: unexpected key(s) changed: ${unexpected.map(c => c.key).join(', ')}`);
        failed++;
        continue;
    }

    // Byte-level proof: outside the three override values, the files are identical.
    const output = Buffer.from(serialize(normalized), 'utf-8');
    const untouched = JSON.parse(output.toString('utf-8'));
    for (const key of Object.keys(CONNECTION_OVERRIDES)) {
        untouched[key] = source[key];
    }
    const restored = Buffer.from(serialize(untouched), 'utf-8');
    if (!restored.equals(sourceBytes)) {
        console.error('  FAIL: reverting the three keys did not reproduce the fixture byte for byte.');
        failed++;
        continue;
    }
    console.log('  byte proof: reverting only those keys reproduces the fixture exactly');

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

console.log('');
if (failed > 0) {
    console.error(`normalize-shipped-presets: ${failed} preset(s) FAILED. Nothing usable was produced for them.`);
    process.exit(1);
}
if (checkOnly && wouldChange > 0) {
    console.error(`normalize-shipped-presets: ${wouldChange} preset(s) out of date.`);
    process.exit(1);
}
console.log(`normalize-shipped-presets: ${PRESETS.length} preset(s) checked, ${wrote} written.`);
