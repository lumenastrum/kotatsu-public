/**
 * Stable settings render plans. Search hides rows without changing this nesting, so Lit never
 * removes an adoption slot while it holds a borrowed core control. Plans are cached for the
 * lifetime of the frozen registry (docs/settings-v0.md §9–§10).
 */

import { getEntries } from './registry.js';

/** @typedef {import('./registry.js').Entry} Entry */

/**
 * @typedef {object} Run
 * @property {boolean} weave Two-column compact controls
 * @property {boolean} [actions] A horizontal button strip
 * @property {Entry[]} entries
 */

/** @typedef {{ kind: 'block', entry: Entry } | { kind: 'group', label: string, runs: Run[] }} Region */

/** Minimum compact span for a two-column weave (settings-v0.md §9). */
const WEAVE_MIN = 4;

/** Heavy controls need a full row; buttons use their own actions strip. */
const COMPACT_KINDS = new Set(['checkbox', 'select', 'buttongroup', 'kotatsu-layout', 'kotatsu-rails']);

/** @type {Map<string, ReadonlyArray<Region>>} */
const REGIONS = new Map();

/**
 * Appends to the trailing ledger run or opens one after a weave.
 * @param {Run[]} runs
 * @param {ReadonlyArray<Entry>} entries
 * @returns {void}
 */
function pushLedger(runs, entries) {
    if (entries.length === 0) return;
    const last = runs[runs.length - 1];
    if (last && !last.weave) {
        last.entries.push(...entries);
        return;
    }
    runs.push({ weave: false, entries: [...entries] });
}

/**
 * @param {Entry} entry
 * @returns {'actions'|'compact'|'ledger'}
 */
function spanKind(entry) {
    if (entry.control === 'button') return 'actions';
    return COMPACT_KINDS.has(entry.control) ? 'compact' : 'ledger';
}

/**
 * Splits consecutive control spans into weave, actions and ledger runs. Short compact spans
 * join the ledger; theme transfer and save buttons keep separate actions runs.
 * @param {ReadonlyArray<Entry>} entries
 * @returns {Run[]}
 */
function planRuns(entries) {
    /** @type {Run[]} */
    const runs = [];
    let index = 0;
    while (index < entries.length) {
        const kind = spanKind(entries[index]);
        let end = index;
        while (end < entries.length && spanKind(entries[end]) === kind) end += 1;
        const span = entries.slice(index, end);
        if (kind === 'actions') {
            // File transfer and saving are separate, stable runs; keyboard order stays intact.
            const saveIndex = span.findIndex(entry => entry.id === 'ui-preset-update-button');
            if (saveIndex > 0) runs.push({ weave: false, actions: true, entries: span.slice(0, saveIndex) });
            runs.push({ weave: false, actions: true, entries: saveIndex > 0 ? span.slice(saveIndex) : span });
        } else if (kind === 'compact' && span.length >= WEAVE_MIN) runs.push({ weave: true, entries: span });
        else pushLedger(runs, span);
        index = end;
    }
    return runs;
}

/**
 * Returns one tab's cached regions in registry order. Blocks interrupt groups and carry their
 * own headings. The same plan objects are returned on every call to preserve Lit's slot tree.
 * @param {string} sectionId
 * @returns {ReadonlyArray<Region>}
 */
export function regionsFor(sectionId) {
    const cached = REGIONS.get(sectionId);
    if (cached) return cached;

    /** @type {Region[]} */
    const regions = [];
    /** @type {Entry[]} */
    let pending = [];
    /** @type {string} */
    let label = '';

    const flush = () => {
        if (pending.length === 0) return;
        regions.push({ kind: 'group', label, runs: planRuns(pending) });
        pending = [];
    };

    for (const entry of getEntries(sectionId)) {
        if (entry.control === 'block') {
            flush();
            label = '';
            regions.push({ kind: 'block', entry });
            continue;
        }
        const group = entry.group ?? '';
        // Groups are CONTIGUOUS runs of registry order (registry.js `getEntries` contract), so a
        // change of string is a new eyebrow and the same string can never appear twice in a tab.
        if (group !== label) {
            flush();
            label = group;
        }
        pending.push(entry);
    }
    flush();

    const frozen = Object.freeze(regions);
    REGIONS.set(sectionId, frozen);
    return frozen;
}
