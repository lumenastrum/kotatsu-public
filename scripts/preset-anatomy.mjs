#!/usr/bin/env node
/**
 * Budget checker for Kotatsu Nabe (docs/house-preset-v0.md §3, §7 gate 2).
 *
 * Measures the prompts enabled by the preset's default order (prompt_order entry for
 * character_id 100001, else the last list). Prints aggregates only, never prompt text.
 *
 * Usage: node scripts/preset-anatomy.mjs <preset.json> [--budget nabe] [--json]
 *   --budget nabe  also enforce the Nabe limits and exit 1 listing each violation.
 */

import path from 'node:path';
import { analyze, checkBudget, NABE_BUDGET } from './lib/preset-anatomy.js';
import { readPreset } from './lib/preset-io.js';

/** @param {string[]} argv */
function parseArgs(argv) {
    /** @type {{ file: string | null, budget: string | null, json: boolean }} */
    const opts = { file: null, budget: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--budget') opts.budget = argv[++i] ?? '';
        else if (!a.startsWith('--') && !opts.file) opts.file = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
    if (!opts.file) throw new Error('usage: preset-anatomy.mjs <preset.json> [--budget nabe] [--json]');
    if (opts.budget !== null && opts.budget !== 'nabe') throw new Error(`unknown budget "${opts.budget}" (known: nabe)`);
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const file = path.resolve(/** @type {string} */ (opts.file));
    const a = analyze(readPreset(file));
    const violations = opts.budget ? checkBudget(a, NABE_BUDGET) : [];

    if (opts.json) {
        console.log(JSON.stringify({ file, anatomy: a, budget: opts.budget, violations, pass: violations.length === 0 }, null, 2));
    } else {
        console.log(`preset-anatomy: ${path.basename(file)}`);
        console.log(`  prompts            ${a.totalPrompts} total, ${a.enabledPrompts} enabled (${a.enabledWithContent} with text)`);
        console.log(`  enabled tokens     ~${a.tokens}`);
        console.log(`  words per module   avg ${a.avgModuleWords}, max ${a.maxModuleWords} (${a.maxModule || 'n/a'})`);
        console.log(`  negative sentences ${a.negativeSentences}/${a.sentences} = ${(a.negativeShare * 100).toFixed(1)}%`);
        console.log(`  instead/rather     ${a.reframes}`);
        console.log(`  all-caps words     ${a.capsWords}`);
        console.log(`  macros             ${a.macros}`);
        console.log(`  regex scripts      ${a.regexScripts}`);
        console.log(`  prefill prompts    ${a.prefillPrompts}`);
        if (opts.budget) {
            if (violations.length) {
                console.log(`\nFAIL (${opts.budget} budget):`);
                for (const v of violations) console.log(`  - ${v}`);
            } else {
                console.log(`\nPASS (${opts.budget} budget)`);
            }
        }
    }
    process.exitCode = violations.length ? 1 : 0;
}

try { main(); } catch (e) { console.error(/** @type {Error} */ (e).message); process.exitCode = 2; }
