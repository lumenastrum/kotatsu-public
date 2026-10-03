#!/usr/bin/env node
// Records the marketplace test fixtures from Chub's live API and scrubs them.
//
//   node scripts/market-fixtures.mjs            record into tests/fixtures/marketplace/chub
//   node scripts/market-fixtures.mjs --dry-run  fetch and scrub, print a summary, write nothing
//
// The fixtures keep the REAL response shape (every key, every type, every length) and none of
// the content: names, handles, ids and prose are replaced, so nobody's card is stored in this
// repo. Lengths, line breaks, `{{user}}` / `{{char}}` counts, tags, numbers, dates and flags
// survive, because those are what the adapter and its tests read.
//
// Six requests, spaced out. Design: docs/character-marketplace-v0.md (slice 0).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'tests', 'fixtures', 'marketplace', 'chub');
const API = 'https://api.chub.ai';
const IMAGE_HOST = 'avatars.charhub.io';
const USER_AGENT = 'Kotatsu-fixtures/0.1 (records scrubbed test fixtures)';
const DRY_RUN = process.argv.includes('--dry-run');
const EMPTY_SEARCH = 'no-such-card-kotatsu-fixture';

const WORDS = ['ember', 'lantern', 'quiet', 'river', 'stone', 'garden', 'paper', 'window',
    'winter', 'copper', 'thread', 'harbor', 'meadow', 'candle', 'orchard', 'velvet'];
const MACRO = /\{\{(?:user|char)\}\}/gi;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const KEEP_STRING_KEYS = new Set(['projectSpace', 'primaryFormat', 'permissions', 'title']);
const NAME_KEYS = new Set(['name', 'project_name']);
const PATH_KEYS = new Set(['fullPath', 'full_path']);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Deterministic filler of an exact length.
 * @param {number} length Characters wanted.
 * @param {number} seed Where in the word list to start.
 * @returns {string} Lowercase words, cut to length.
 */
function filler(length, seed) {
    let text = '';
    for (let i = seed; text.length < length; i++) {
        text += (text ? ' ' : '') + WORDS[i % WORDS.length];
    }
    return text.slice(0, length).replace(/ $/, 'a');
}

/**
 * Replaces prose with filler, line by line, keeping each line's length and its macros.
 * @param {string} text Original text.
 * @returns {string} Scrubbed text of the same length.
 */
function scrubText(text) {
    return text.split('\n').map((line, index) => {
        const macros = line.match(MACRO) ?? [];
        const macroLength = macros.reduce((sum, macro) => sum + macro.length, 0);
        const body = filler(line.length - macroLength, index);
        if (macros.length === 0) return body;
        // Spread the macros evenly through the filler.
        const step = Math.floor(body.length / (macros.length + 1));
        let out = '';
        for (let i = 0; i < macros.length; i++) {
            out += body.slice(i * step, (i + 1) * step) + macros[i];
        }
        return out + body.slice(macros.length * step);
    }).join('\n');
}

/** Real fullPath (lowercased) → alias. One card keeps one alias across every file. */
const aliases = new Map();

/**
 * @param {{ id?: number, fullPath: string }} node A search row or a detail node.
 * @returns {{ n: number, id: number, realId: number|undefined, fullPath: string, name: string }} Its alias.
 */
function aliasFor(node) {
    const key = String(node.fullPath).toLowerCase();
    let alias = aliases.get(key);
    if (!alias) {
        const n = aliases.size + 1;
        alias = { n, id: 1000 + n, realId: node.id, fullPath: `creator-${n}/card-${n}`, name: `Card ${n}` };
        aliases.set(key, alias);
    }
    return alias;
}

/**
 * Scrubs one value. Unknown strings are replaced by default; only what is listed survives.
 * @param {unknown} value The value.
 * @param {string} key Its key ('' for array items).
 * @param {ReturnType<typeof aliasFor>} alias The card it belongs to.
 * @param {{ depth: number, parentKey: string }} at Where it sits.
 * @returns {unknown} The scrubbed value.
 */
function scrub(value, key, alias, at) {
    if (typeof value === 'number') {
        if (alias.realId !== undefined && value === alias.realId) return alias.id;
        if (key === 'creatorId') return alias.n;
        return value;
    }
    if (typeof value === 'string') {
        if (value === '') return value;
        if (PATH_KEYS.has(key)) return alias.fullPath;
        if (NAME_KEYS.has(key)) return at.depth <= 2 ? alias.name : scrubText(value);
        if (ISO_DATE.test(value)) return value;
        if (KEEP_STRING_KEYS.has(key)) return value;
        if (at.parentKey === 'topics') return value;
        if (/^https?:\/\//i.test(value)) {
            let host = '';
            let base = 'asset';
            try {
                const url = new URL(value);
                host = url.host;
                base = url.pathname.split('/').pop() || base;
            } catch { /* not a URL after all */ }
            return host === IMAGE_HOST
                ? `https://${IMAGE_HOST}/avatars/${alias.fullPath}/${base}`
                : 'https://example.invalid/asset';
        }
        return scrubText(value);
    }
    if (Array.isArray(value)) {
        if (key === 'labels') {
            // Only the token-count label is read; it is numbers in a JSON string.
            return value.filter(label => label?.title === 'TOKEN_COUNTS');
        }
        return value.map(item => scrub(item, '', alias, { depth: at.depth + 1, parentKey: key }));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [childKey, child] of Object.entries(value)) {
            out[childKey] = scrub(child, childKey, alias, { depth: at.depth + 1, parentKey: key });
        }
        return out;
    }
    return value;
}

/**
 * @param {string} pathAndQuery Path with query string.
 * @returns {Promise<any>} Parsed JSON.
 */
async function get(pathAndQuery) {
    const response = await fetch(API + pathAndQuery, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
    if (!response.ok) throw new Error(`${pathAndQuery} -> ${response.status}`);
    const json = await response.json();
    await sleep(500);
    return json;
}

/**
 * @param {any} body A raw search response.
 * @returns {any} The scrubbed response.
 */
function scrubSearch(body) {
    const data = body.data ?? body;
    const nodes = (data.nodes ?? []).map(node => scrub(node, '', aliasFor(node), { depth: 0, parentKey: '' }));
    const scrubbed = { ...data, nodes, cursor: data.cursor ? 'fixture-cursor' : data.cursor, previous_cursor: data.previous_cursor ? 'fixture-cursor' : data.previous_cursor };
    return body.data ? { ...body, data: scrubbed } : scrubbed;
}

/**
 * @param {any} body A raw detail response.
 * @returns {any} The scrubbed response, reduced to the `node` the importer and adapter read.
 */
function scrubDetail(body) {
    const alias = aliasFor(body.node);
    return { errors: body.errors ?? null, node: scrub(body.node, '', alias, { depth: 0, parentKey: '' }) };
}

const common = 'page=1&namespace=characters&nsfw=false&nsfl=false';
const files = new Map();
const entries = [];

const page = await get(`/search?search=&first=6&sort=default&${common}`);
const rows = (page.data ?? page).nodes ?? [];
files.set('search-default.json', scrubSearch(page));

const rich = await get(`/search?search=&first=1&sort=download_count&require_lore_embedded=true&require_alternate_greetings=true&${common}`);
const richRow = ((rich.data ?? rich).nodes ?? [])[0];

// Chub's text search is fuzzy: a nonsense term still returns rows. An anonymous request for
// the NSFW tag is what measured zero (2026-10-02), so that is the empty page we record. The
// manifest serves it for the magic search term below.
const empty = await get(`/search?search=&tags=NSFW&first=6&sort=default&${common}`);
if (((empty.data ?? empty).nodes ?? []).length !== 0) {
    throw new Error('The request meant to come back empty returned rows; pick another one before recording.');
}
files.set('search-empty.json', scrubSearch(empty));

for (const row of [rows[0], rows[1], richRow].filter(Boolean)) {
    const [creator, slug] = String(row.fullPath).split('/');
    const detail = scrubDetail(await get(`/api/characters/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}?full=true`));
    const alias = aliasFor(row);
    const file = `detail-card-${alias.n}.json`;
    files.set(file, detail);
    entries.push({ host: 'api.chub.ai', path: `/api/characters/${alias.fullPath}`, file });
}

// A second page, so a probe can watch the grid grow. Recorded last, so the cards above keep
// their numbers. Page 3 has no entry and falls through to page 1, whose rows are already on
// screen: that is the "a page that adds nothing ends the list" case.
files.set('search-page-2.json', scrubSearch(await get(`/search?search=&first=6&sort=default&page=2&namespace=characters&nsfw=false&nsfl=false`)));

files.set('search-shape.json', { unexpected: true });

// The anonymous slice carries no `nsfw_image: true` rows, so the blur rules would go
// unexercised. Derived, not recorded: the default page with its first row flagged. Served for
// the magic search `kotatsu-fixture-flagged`. Nothing else differs, so the row keys match.
files.set('search-flagged.json', flagFirstRow(files.get('search-default.json')));

/**
 * @param {any} search A scrubbed search body.
 * @returns {any} A deep copy with the first row's `nsfw_image` set.
 */
function flagFirstRow(search) {
    const copy = JSON.parse(JSON.stringify(search));
    const nodes = copy?.data?.nodes;
    if (Array.isArray(nodes) && nodes[0]) nodes[0].nsfw_image = true;
    return copy;
}

const manifest = {
    note: 'Recorded and scrubbed by scripts/market-fixtures.mjs. Real shape, no real content. First match wins.',
    recordedAt: new Date().toISOString().slice(0, 10),
    entries: [
        // Magic searches so a probe can reach every state without touching the network.
        { host: 'api.chub.ai', path: '/search', query: { search: EMPTY_SEARCH }, file: 'search-empty.json' },
        { host: 'api.chub.ai', path: '/search', query: { search: 'kotatsu-fixture-429' }, status: 429, retryAfter: 30 },
        { host: 'api.chub.ai', path: '/search', query: { search: 'kotatsu-fixture-500' }, status: 500 },
        { host: 'api.chub.ai', path: '/search', query: { search: 'kotatsu-fixture-shape' }, file: 'search-shape.json' },
        { host: 'api.chub.ai', path: '/search', query: { search: 'kotatsu-fixture-offline' }, offline: true },
        { host: 'api.chub.ai', path: '/search', query: { search: 'kotatsu-fixture-flagged' }, file: 'search-flagged.json' },
        { host: 'api.chub.ai', path: '/search', query: { page: '2' }, file: 'search-page-2.json' },
        // The adapter's nsfwServed() question. Zero = this location is not served NSFW, which
        // is what the recording machine measured (Utah); a test that wants "served" points this
        // entry at search-default.json in a scratch copy. Must sit before the default entry.
        {
            note: 'The adapter\'s nsfwServed() question. Zero = this location is not served NSFW, which is what the recording machine (Utah) measured; a test that wants \'served\' points this entry at search-default.json.',
            host: 'api.chub.ai', path: '/search', query: { tags: 'NSFW', first: '1', nsfw: 'true' }, file: 'search-empty.json',
        },
        { host: 'api.chub.ai', path: '/search', file: 'search-default.json' },
        ...entries,
    ],
};
files.set('manifest.json', manifest);

// The scrub checks itself: no recorded card's real path, handle or slug may survive anywhere.
const serialized = [...files.values()].map(body => JSON.stringify(body).toLowerCase()).join('\n');
const leaks = [];
for (const realPath of aliases.keys()) {
    for (const needle of [realPath, ...realPath.split('/')]) {
        if (needle.length >= 4 && serialized.includes(needle)) leaks.push(needle);
    }
}
if (leaks.length > 0) {
    throw new Error(`Scrub left real identifiers in the fixtures: ${[...new Set(leaks)].join(', ')}`);
}
console.log(`scrub verified: ${aliases.size} real paths, handles and slugs absent from every file`);

for (const [name, body] of files) {
    const text = JSON.stringify(body, null, 2) + '\n';
    console.log(`${DRY_RUN ? 'would write' : 'wrote'} ${name} (${text.length} B)`);
    if (!DRY_RUN) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(path.join(OUT_DIR, name), text);
    }
}
console.log(`cards aliased: ${aliases.size}; rows on the default page: ${rows.length}; rich card found: ${Boolean(richRow)}`);
