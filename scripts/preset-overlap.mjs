#!/usr/bin/env node
/**
 * Clean-room overlap gate for the Kotatsu Nabe preset (docs/house-preset-v0.md §6, §7 gate 1).
 *
 * Fails (exit 1) when the candidate shares any n-word run (default 8, after normalizing case,
 * quotes, punctuation and whitespace) with any reference preset. Third-party text is never
 * printed except the minimal matched run in a failure report.
 *
 * Usage: node scripts/preset-overlap.mjs <candidate.json> [--refs <dir-or-files...>] [--n 8] [--json]
 *   Default refs: scripts/preset-references.json + scripts/preset-references.local.json
 *   (+ KOTATSU_PRESET_REFS). Missing files are skipped and listed as such.
 *   Third-party reference files are NOT in the repo (no license); the gate runs where they exist.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { findOverlaps, presetShingles } from './lib/preset-overlap.js';
import { defaultReferencePaths, expandPaths, readPreset } from './lib/preset-io.js';

const MAX_PRINT = 20;

/** @param {string[]} argv */
function parseArgs(argv) {
    /** @type {{ candidate: string | null, refs: string[] | null, n: number, json: boolean }} */
    const opts = { candidate: null, refs: null, n: 8, json: false, commons: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--n') opts.n = Number(argv[++i]);
        else if (a === '--no-commons') opts.commons = false;
        else if (a === '--refs') {
            opts.refs = [];
            while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts.refs.push(argv[++i]);
        } else if (!a.startsWith('--') && !opts.candidate) opts.candidate = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
    if (!opts.candidate) throw new Error('usage: preset-overlap.mjs <candidate.json> [--refs <dir-or-files...>] [--n 8] [--json]');
    if (!Number.isInteger(opts.n) || opts.n < 2) throw new Error('--n must be an integer >= 2');
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const candidatePath = path.resolve(/** @type {string} */ (opts.candidate));
    const candidate = readPreset(candidatePath);
    const refPaths = opts.refs ? expandPaths(opts.refs) : defaultReferencePaths();
    // SillyTavern's own stock preset is every fork's shared ancestry (AGPL, ours to carry): its
    // wording is never counted as overlap. --no-commons turns this off.
    const commonsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'default', 'content', 'presets', 'openai', 'Default.json');
    const commons = opts.commons && fs.existsSync(commonsPath) ? presetShingles(readPreset(commonsPath), opts.n) : new Set();

    /** @type {Array<{ name: string, path: string, status: 'checked' | 'missing' | 'self' | 'unreadable', overlaps: number, runs: any[] }>} */
    const results = [];
    for (const p of refPaths) {
        const name = path.basename(p, '.json');
        if (!fs.existsSync(p)) { results.push({ name, path: p, status: 'missing', overlaps: 0, runs: [] }); continue; }
        if (path.resolve(p).toLowerCase() === candidatePath.toLowerCase()) { results.push({ name, path: p, status: 'self', overlaps: 0, runs: [] }); continue; }
        let preset;
        try { preset = readPreset(p); } catch { results.push({ name, path: p, status: 'unreadable', overlaps: 0, runs: [] }); continue; }
        const runs = findOverlaps(candidate, [{ name, preset }], opts.n, { commons });
        results.push({ name, path: p, status: 'checked', overlaps: runs.length, runs });
    }

    const checked = results.filter(r => r.status === 'checked');
    const total = checked.reduce((a, r) => a + r.overlaps, 0);
    const failed = total > 0;

    if (opts.json) {
        console.log(JSON.stringify({ candidate: candidatePath, n: opts.n, pass: !failed, checkedCount: checked.length, results }, null, 2));
    } else {
        console.log(`preset-overlap: ${path.basename(candidatePath)}  (n=${opts.n}; commons: ${commons.size ? `SillyTavern stock, ${commons.size} runs ignored` : 'off'})`);
        for (const r of results) {
            const tag = r.status === 'checked' ? `${r.overlaps} shared run${r.overlaps === 1 ? '' : 's'}` : r.status;
            console.log(`  ${r.name.padEnd(60)} ${tag}`);
        }
        if (checked.length === 0) console.log('  (no reference files found: nothing was checked)');
        if (failed) {
            for (const r of checked.filter(x => x.overlaps > 0)) {
                console.log(`\n  ${r.name}: ${r.overlaps} shared run(s), showing up to ${MAX_PRINT}`);
                for (const h of r.runs.slice(0, MAX_PRINT)) {
                    console.log(`    "${h.run}"   [candidate: ${h.candidatePrompt} | reference: ${h.referencePrompt}]`);
                }
            }
            console.log(`\nFAIL: ${total} shared ${opts.n}-word run(s) across ${checked.filter(r => r.overlaps).length} reference(s).`);
        } else {
            console.log(`\nPASS: no shared ${opts.n}-word runs against ${checked.length} reference(s).`);
        }
    }
    process.exitCode = failed ? 1 : 0;
}

try { main(); } catch (e) { console.error(/** @type {Error} */ (e).message); process.exitCode = 2; }
