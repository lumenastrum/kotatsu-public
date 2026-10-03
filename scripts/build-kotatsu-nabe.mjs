#!/usr/bin/env node
/**
 * Builds Kotatsu Nabe (docs/house-preset-v0.md) from `scripts/presets/kotatsu-nabe.mjs` onto
 * SillyTavern's stock Default preset, and writes it to `tests/fixtures/presets/` (the canonical
 * copy; `normalize-shipped-presets.mjs` ships fixtures). Deterministic: same source, same bytes.
 *
 *   node scripts/build-kotatsu-nabe.mjs           write the fixture
 *   node scripts/build-kotatsu-nabe.mjs --check   exit 1 if the fixture is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAYOUT, NAME, SETTINGS, VERSION } from './presets/kotatsu-nabe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stockPath = path.join(root, 'default', 'content', 'presets', 'openai', 'Default.json');
const outPath = path.join(root, 'tests', 'fixtures', 'presets', `${NAME}.json`);

/**
 * @returns {object} The preset
 */
export function buildNabe() {
    const stock = JSON.parse(fs.readFileSync(stockPath, 'utf8'));
    const stockPrompts = new Map(stock.prompts.map(p => [p.identifier, p]));

    const prompts = [];
    const order = [];
    /** @type {Record<string, any>} */
    const sections = {};
    const sectionOrder = [];

    for (const group of LAYOUT) {
        const members = [];
        for (const m of group.modules) {
            const base = stockPrompts.get(m.id);
            let prompt;
            if (m.marker) {
                prompt = { ...base, name: m.name };
            } else if (m.stock) {
                prompt = { ...base };
            } else {
                prompt = {
                    identifier: m.id,
                    name: m.name,
                    // Stock identifiers keep SillyTavern's flags; ours are plain custom prompts.
                    system_prompt: base ? base.system_prompt : false,
                    marker: false,
                    role: m.role ?? 'system',
                    content: m.content,
                    // `depth` puts a module in the chat itself, that many messages from the end
                    // (0 = right after the last message, the strongest recency SillyTavern offers).
                    injection_position: m.depth === undefined ? 0 : 1,
                    injection_depth: m.depth ?? 4,
                    injection_order: 100,
                    injection_trigger: [],
                    forbid_overrides: false,
                };
            }
            prompts.push(prompt);
            order.push({ identifier: m.id, enabled: m.on });
            members.push(m.id);
        }
        if (group.section) {
            sections[group.section.id] = {
                label: group.section.label,
                exclusive: Boolean(group.section.exclusive),
                collapsedDefault: false,
                members,
            };
            sectionOrder.push(group.section.id);
        }
    }

    // Every stock prompt must be present exactly once (SillyTavern expects its identifiers).
    for (const id of stockPrompts.keys()) {
        if (!prompts.some(p => p.identifier === id)) throw new Error(`stock prompt ${id} missing from the layout`);
    }

    const preset = {
        ...stock,
        ...SETTINGS,
        prompts,
        prompt_order: [
            // 100000 = the dummy/global list SillyTavern keeps for new characters; mirror ours.
            { character_id: 100000, order: order.map(o => ({ ...o })) },
            { character_id: 100001, order },
        ],
        extensions: {
            ...(stock.extensions ?? {}),
            kotatsu: {
                preset: { name: NAME, version: VERSION },
                sections: { version: 1, unassigned: 'append', order: sectionOrder, sections },
            },
        },
    };
    return preset;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    // SillyTavern's own preset serialization: 4 spaces, no trailing newline, so
    // normalize-shipped-presets.mjs can prove the shipped copy byte for byte.
    const text = JSON.stringify(buildNabe(), null, 4);
    if (process.argv.includes('--check')) {
        const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : '';
        if (current !== text) {
            console.error(`${path.relative(root, outPath)} is out of date — run node scripts/build-kotatsu-nabe.mjs`);
            process.exit(1);
        }
        console.log(`${NAME} ${VERSION}: up to date`);
    } else {
        fs.writeFileSync(outPath, text);
        console.log(`wrote ${path.relative(root, outPath)} (${Buffer.byteLength(text)} B, ${buildNabe().prompts.length} prompts)`);
    }
}
