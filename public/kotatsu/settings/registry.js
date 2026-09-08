/**
 * The settings registry — `docs/settings-v0.md` §2 (interface contract), §6 (slice A) and
 * §10 (slice E, the v0.1 configuration home).
 *
 * This is the map of the whole settings territory: one Entry per value-bearing control the
 * census found (`docs/settings-recon-census.md` §1.2, 110 rows), plus the Kotatsu-native
 * settings that live outside the stock drawer (§6.1), plus the four controls the design pins
 * into tabs 3 and 5 even though they render in other drawers (§3.3, §3.5), plus the five
 * adopted REGIONS the four v0.1 tabs are made of (§10 — the API drawer, the persona suite, the
 * two halves of the World Info drawer, and the extensions drawer).
 *
 * ── What this module is NOT ───────────────────────────────────────────────────────────────
 * It is data plus pure functions. It touches no DOM at module scope (or anywhere else), imports
 * nothing but its own data, persists nothing, and reads nothing from `power_user`. That is what
 * lets `<k-settings-modal>` and `tests/settings-registry.test.js` import the same file and get
 * the same answers. The rule is `settings-v0.md` §1.3: **tier metadata lives here and is never
 * persisted** — nothing in this folder may ever write a key.
 *
 * ── The one rule that reaches outside this file ───────────────────────────────────────────
 * Persistence §1.1: new settings live in SURVIVE lanes only. Every Kotatsu-owned entry here is
 * `store: 'power_user'`. Three stock entries carry a non-`power_user` store because that is
 * where stock already put them (`language` in localStorage, `swipes` at the settings root,
 * `background.animation` under `background`); the registry *describes* them, it does not adopt
 * that lane for anything new. See the `store` typedef note and the DIE-lane test.
 *
 * ── Adoption model ────────────────────────────────────────────────────────────────────────
 * `binding` says how to FIND the live node the modal relocates — never how to build one. Three
 * sliders listen by `name` and not by `id` (census #5.3), so `by` is part of the contract, not
 * a detail. `runtime: true` marks a control no static markup contains: the modal builds it and
 * claims `ref` as its id, so the static index.html check must skip it.
 *
 * ── Blocks and the one node rule (v0.1) ───────────────────────────────────────────────────
 * `control: 'block'` is a whole adopted stock REGION rather than one input — the four new tabs
 * of `settings-v0.md` §10 are made of five of them. A block declares `keys: []` and a REQUIRED
 * `adopt` selector, and everything inside it keeps its stock bindings and its stock lanes.
 *
 * Which creates the failure this file exists to prevent: **exactly one entry may claim any
 * given node.** A control that renders inside a block's subtree cannot also be a row of its
 * own — the block already carries it, and a second claim would move the node twice. One
 * control needs to be both carried and findable (`auto_connect`, whose checkbox sits at
 * `index.html:4165`, deep inside `#rm_api_block`), so it declares `withinBlock` naming the
 * block that carries it. Such an entry is **searchable but never independently adopted**:
 * `getEntries()` — the collection the modal renders rows from — leaves it out, while
 * `searchEntries()` and `getAllEntries()` keep it. Its `section` still routes a search hit to
 * the right tab; the modal decides how to present a hit whose row is inside a block.
 *
 * ── Surfaces ──────────────────────────────────────────────────────────────────────────────
 * `surface: 'none'` is a control Kotatsu chose not to adopt (the kill list + the Character
 * Handling drop, `settings-v0.md` §4). It is **never** deleted from the DOM or from storage —
 * it stays fully functional in the classic layout. It carries `rehome`, naming the Kotatsu
 * system that took the job. `getEntries()` and `searchEntries()` return surfaced entries only;
 * `getAllEntries()` returns the complete map, killed rows included. `getEntries()` drops one
 * more kind — the `withinBlock` rows — for a reason that has nothing to do with curation: see
 * "Blocks and the one node rule" above.
 */

import { AFFECTS, CONTROLS, ENTRIES, SECTIONS, STORES, TIERS } from './registry-data.js';

export { AFFECTS, CONTROLS, SECTIONS, STORES, TIERS };

/**
 * Where a setting's value actually lives in the saved blob.
 *
 * - `power_user` — the only lane Kotatsu may add to. Loaded with `Object.assign` onto the
 *   defaults (`power-user.js:1645`), so unknown keys survive forever.
 * - `settings` — a top-level `settings.json` field written by hand (`script.js:8402`). One
 *   stock control (`swipes`).
 * - `localStorage` — outside `settings.json` entirely (`i18n.js:290`). One stock control.
 * - `background` — `settings.background.*`, rebuilt field-by-field on load
 *   (`backgrounds.js:211-243`). A DIE lane for UNKNOWN keys; `animation` is one of the known
 *   fields, which is why the one stock entry that uses it is safe and why nothing new may
 *   ever be added here.
 * @typedef {'power_user'|'settings'|'localStorage'|'background'} EntryStore
 */

/**
 * How the modal finds the live control to relocate.
 * @typedef {object} EntryBinding
 * @property {'id'|'name'} by Which attribute `ref` addresses. `name` exists because
 *   `font_scale`, `blur_strength` and `shadow_width` are bound `$('input[name="…"]')` and not
 *   by id (`power-user.js:3505, 3513, 3520`; census §5.3) — the id is the render target, the
 *   name is the listener.
 * @property {string} ref The attribute value. No `#`, no selector syntax.
 * @property {boolean} [runtime] True when no static markup carries this ref: the control is
 *   built in JS and this is the id it claims. Exempt from the static `index.html` check.
 */

/**
 * One setting.
 * @typedef {object} Entry
 * @property {string} id The control's element id, unique across the registry. For a
 *   `runtime` control it is the id that control claims once built.
 * @property {ReadonlyArray<string>} keys Key paths **relative to `store`'s root**, always an
 *   array. `['pin_examples', 'strip_examples']` is a real control (`power-user.js:3391-3403`).
 *   `[]` is legal for an affordance that persists nothing (the two MovingUI buttons) and is
 *   **mandatory** for a `block`: a region's controls keep their own stock lanes, several of
 *   which are DIE lanes, and naming one here would turn the zero-DIE-lane gate into a rule
 *   with exceptions. Relocation is DOM-only and safe; a key claim would not be.
 * @property {string} label What Kotatsu calls it. Two labels are deliberately not stock's:
 *   `chat_truncation` and `stream_fade_in` carry the `settings-v0.md` §5 truth fixes.
 * @property {string} section A `SECTIONS` id. Killed entries keep their natural home so the
 *   map stays readable; nothing renders them.
 * @property {string} [group] The eyebrow cluster this row sits in within its tab — the Hybrid
 *   layout's grouping metadata (`settings-v0.md` §9: ledger rows for heavyweight controls, a
 *   two-column weave only for homogeneous clusters). **The registry carries the string and
 *   nothing else**: which groups weave and which stay ledger is the modal's decision, read off
 *   the `control` kinds in the run. Groups are CONTIGUOUS runs of `getEntries()` order, because
 *   one eyebrow printed twice in one tab is a bug and the renderer cannot tell. Present on
 *   every row `getEntries()` hands out that is not a `block`; absent on blocks (a block is its
 *   own region and its `label` is its eyebrow), on `withinBlock` rows (they render no row at
 *   all) and on `surface: 'none'` rows (nothing renders them).
 * @property {ControlKind} control The input primitive, or `block` for a whole adopted region.
 * @property {EntryBinding} binding
 * @property {string} [withinBlock] The id of the `block` entry whose adopted subtree already
 *   contains this control's node. Searchable, never independently adopted: `getEntries()`
 *   excludes it, so no row and no slot is ever drawn for it and the node is claimed exactly
 *   once — by the block. Mutually exclusive with `adopt` (a row that names its own adoption
 *   unit is, by definition, not riding inside someone else's).
 * @property {string} [adopt] CSS selector overriding the adoption unit — what travels into
 *   the modal when the right unit is bigger than the binding node's own label row: a slider's
 *   wrapper so its number counter comes too, a `<label for=>` that is hit area rather than
 *   decoration, a Kotatsu wardrobe row carrying its pack note. Absent = the modal's
 *   closest-label fallback, which is right for 95 of the 112 rows a tab draws. Seventeen name
 *   one; the audit and its rules are in `registry-data.js`'s header under "Adoption units".
 *   **Required** when `control` is `block` — the region IS the unit, and there are five.
 * @property {ReadonlyArray<string>} affects Surfaces this setting reaches, from `AFFECTS`.
 *   Mined from `public/css/toggle-dependent.css` and the census read-site column — this is
 *   what decided each entry's `section`.
 * @property {ReadonlyArray<string>} keywords Search fodder: the stock label's words, the key
 *   name, and what a person would actually type instead.
 * @property {'simple'|'advanced'} tier **DORMANT.** Seeded from the measured 22
 *   (`settings-recon-simple-tier.md` §5). Nothing in the app may read it — the Simple view is
 *   a UI change for later, and a consumer today would ship an uncalibrated boundary.
 * @property {string} [lockedBy] An external authority that can disable this control. Exactly
 *   one entry has it (`reduced_motion`, `prefers-reduced-motion`; census §5.11).
 * @property {EntryStore} store
 * @property {'modal'|'none'} surface `none` = not adopted into the modal. Still in the DOM,
 *   still in storage, still working under classic.
 * @property {string} [rehome] Present exactly when `surface` is `none`: the Kotatsu system
 *   that replaced it, in words a person can read.
 */

/**
 * One tab.
 * @typedef {object} Section
 * @property {string} id
 * @property {string} label
 * @property {string} blurb One line under the tab strip.
 */

/** @typedef {import('./registry-data.js').ControlKind} ControlKind */

/**
 * Registry order, by id — the tiebreaker that makes search deterministic.
 * @type {Map<string, number>}
 */
const ORDER = new Map();

/**
 * id → entry.
 * @type {Map<string, Entry>}
 */
const BY_ID = new Map();

ENTRIES.forEach((entry, index) => {
    ORDER.set(entry.id, index);
    BY_ID.set(entry.id, entry);
});

/**
 * section id → the entries that section RENDERS.
 *
 * Two exclusions, and they are different in kind. `surface: 'none'` is a control Kotatsu chose
 * not to adopt — it is still in the DOM and still works under classic. `withinBlock` is a
 * control Kotatsu adopts *inside a block*: the block's `adopt` already carries the node, so a
 * row here would be a second claim on it. The first is a curation decision, the second is the
 * one-node rule.
 * @type {Map<string, ReadonlyArray<Entry>>}
 */
const BY_SECTION = new Map();

for (const section of SECTIONS) {
    BY_SECTION.set(section.id, Object.freeze(
        ENTRIES.filter(entry => entry.section === section.id
            && entry.surface === 'modal'
            && !entry.withinBlock),
    ));
}

/** The shared empty result. Returning one frozen array keeps every miss identical. */
const EMPTY = /** @type {ReadonlyArray<Entry>} */ (Object.freeze([]));

/**
 * The tabs, in order.
 * @returns {ReadonlyArray<Section>}
 */
export function getSections() {
    return SECTIONS;
}

/**
 * The entries one tab renders, in order. Surfaced entries only — a killed control is map data,
 * not something a tab may put on screen — and `withinBlock` rows are left out too, because the
 * block that carries them is already in this list and a node may be claimed exactly once.
 * `group` is contiguous over this list, so a renderer can start a new eyebrow whenever it
 * changes and never print the same one twice. Unknown section id returns empty.
 * @param {string} sectionId
 * @returns {ReadonlyArray<Entry>}
 */
export function getEntries(sectionId) {
    return BY_SECTION.get(sectionId) ?? EMPTY;
}

/**
 * The complete map, killed rows included, in registry order.
 * @returns {ReadonlyArray<Entry>}
 */
export function getAllEntries() {
    return ENTRIES;
}

/**
 * One entry by id, or undefined.
 * @param {string} id
 * @returns {Entry | undefined}
 */
export function getEntry(id) {
    return BY_ID.get(id);
}

/**
 * How well one entry answers one already-lowercased term. `0` means "not a match", and one
 * unmatched term disqualifies the entry — multi-word queries are AND, so "message id" narrows
 * instead of widening.
 *
 * The ladder is deliberately coarse. Precision here would be false precision: what makes search
 * work is the `keywords` authoring, not the arithmetic.
 * @param {Entry} entry
 * @param {string} term
 * @returns {number}
 */
function scoreTerm(entry, term) {
    const label = entry.label.toLowerCase();
    if (label === term) return 100;
    if (label.startsWith(term)) return 60;
    if (label.includes(term)) return 40;

    let best = 0;
    for (const keyword of entry.keywords) {
        const candidate = keyword.toLowerCase();
        if (candidate === term) best = Math.max(best, 30);
        else if (candidate.startsWith(term)) best = Math.max(best, 20);
        else if (candidate.includes(term)) best = Math.max(best, 12);
    }
    for (const key of entry.keys) {
        if (key.toLowerCase().includes(term)) best = Math.max(best, 10);
    }
    if (entry.id.toLowerCase().includes(term)) best = Math.max(best, 8);
    return best;
}

/**
 * Modal-wide search. Replaces `#settingsSearch`, which only ever walked one drawer of nine
 * (`setting-search.js:6-10`; census §2.0).
 *
 * Case-insensitive, whitespace-split, AND across terms, surfaced entries only. Ties break on
 * registry order, so the same query always returns the same list in the same order.
 *
 * `withinBlock` rows ARE searchable here — that is the half of the fold that survives. They do
 * not render a row (`getEntries()` drops them), so a consumer that resolves a hit to a slot has
 * to handle a hit whose control is inside a block: `entry.withinBlock` names the block entry,
 * and `entry.section` still names the tab.
 * @param {string} query
 * @returns {ReadonlyArray<Entry>}
 */
export function searchEntries(query) {
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return EMPTY;

    /** @type {{ entry: Entry, score: number, order: number }[]} */
    const hits = [];
    for (const entry of ENTRIES) {
        if (entry.surface !== 'modal') continue;
        let score = 0;
        let matched = true;
        for (const term of terms) {
            const termScore = scoreTerm(entry, term);
            if (termScore === 0) {
                matched = false;
                break;
            }
            score += termScore;
        }
        if (!matched) continue;
        hits.push({ entry, score, order: ORDER.get(entry.id) ?? 0 });
    }

    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    return Object.freeze(hits.map(hit => hit.entry));
}
