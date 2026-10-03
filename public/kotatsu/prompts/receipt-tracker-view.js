/**
 * Pure view helpers for `<k-receipt-tracker>` (`docs/receipt-tracker-v0.md`, decisions 3-6).
 *
 * Zero imports, same reasoning as `./view-model.js`: everything here takes plain data and
 * returns plain data, so it is testable without a DOM, without `customElements`, and without
 * mocking a single core module — `tests/receipt-tracker-view.test.js` imports this file
 * directly. `k-receipt-tracker.js` is the only caller; it supplies the live `oai_settings` /
 * `receiptStore` data these functions never touch themselves.
 */

/**
 * Identifiers a receipt entry can carry that are never rows in a preset's `prompts[]` —
 * they are engine-constructed collections (`openai.js:905-921`, `:1218-1234`), so no
 * capture-time snapshot and no current-preset lookup can ever resolve them. Named here,
 * once, because nothing else in `public/kotatsu/` authors an identifier→label map for them
 * (`docs/receipt-tracker-v0.md` "The rail substrate").
 * @type {Readonly<Record<string, string>>}
 */
export const ENGINE_SLOT_LABELS = Object.freeze({
    controlPrompts: 'Control prompts',
    continueNudge: 'Continue nudge',
});

/**
 * The chart's colour categories, in their FIXED order (receipt chart v0). The order is the
 * colour contract: `receipt-tracker.css` binds category N to `--k-viz-N`, and the stacked
 * "By source" bar lays segments out in this order, so every adjacent pair on screen is an
 * adjacent pair the palette was validated on. Never re-sorted by size — colour follows the
 * category, never its rank. `other` is deliberately last and neutral (`--k-viz-other`): it
 * is a bucket, not a series, and must not compete with the five that are.
 * @type {ReadonlyArray<Readonly<{key: string, label: string}>>}
 */
export const RECEIPT_CATEGORIES = Object.freeze([
    Object.freeze({ key: 'chat', label: 'Chat history' }),
    Object.freeze({ key: 'preset', label: 'Preset' }),
    Object.freeze({ key: 'character', label: 'Character' }),
    Object.freeze({ key: 'world', label: 'World info' }),
    Object.freeze({ key: 'persona', label: 'Persona' }),
    Object.freeze({ key: 'other', label: 'Engine & other' }),
]);

/**
 * Engine-assembled identifiers with a known home (`openai.js:1209-1260`, `:1373-1382`).
 * Checked BEFORE the preset lookup, because a preset's `prompts[]` also carries marker rows
 * for most of these (`chatHistory`, `charDescription`, …) — being in `prompts[]` makes an
 * identifier placeable, not preset-authored.
 * @type {Readonly<Record<string, string>>}
 */
const CATEGORY_BY_IDENTIFIER = Object.freeze({
    chatHistory: 'chat',
    main: 'preset',
    nsfw: 'preset',
    jailbreak: 'preset',
    enhanceDefinitions: 'preset',
    charDescription: 'character',
    charPersonality: 'character',
    scenario: 'character',
    dialogueExamples: 'character',
    worldInfoBefore: 'world',
    worldInfoAfter: 'world',
    personaDescription: 'persona',
    // Engine slots and extension prompts: real tokens, but no one the reader authored as a
    // "prompt" in the preset sense (`openai.js:1284-1287` for the extension four).
    controlPrompts: 'other',
    continueNudge: 'other',
    bias: 'other',
    impersonate: 'other',
    quietPrompt: 'other',
    groupNudge: 'other',
    summary: 'other',
    authorsNote: 'other',
    vectorsMemory: 'other',
    vectorsDataBank: 'other',
    smartContext: 'other',
});

/**
 * Which colour category one receipt entry belongs to. Known identifiers resolve from
 * {@link CATEGORY_BY_IDENTIFIER}; anything else is a preset prompt only when there is
 * evidence it IS one (a capture-time `name` snapshot, or a row in the current preset), and
 * falls to `other` otherwise — a v1 receipt's deleted custom prompt is honestly "unplaced",
 * not quietly claimed by the preset.
 * @param {{identifier?: unknown, name?: unknown}} entry A `ReceiptEntry`, or anything entry-shaped.
 * @param {Map<string, unknown>} [presetPrompts] identifier → current-preset prompt record.
 * @returns {string} A {@link RECEIPT_CATEGORIES} key.
 */
export function entryCategory(entry, presetPrompts) {
    const identifier = typeof entry?.identifier === 'string' ? entry.identifier : '';
    const known = Object.hasOwn(CATEGORY_BY_IDENTIFIER, identifier) ? CATEGORY_BY_IDENTIFIER[identifier] : null;
    if (known) {
        return known;
    }
    const hasSnapshot = typeof entry?.name === 'string' && entry.name.trim() !== '';
    if (identifier && (hasSnapshot || presetPrompts?.has(identifier))) {
        return 'preset';
    }
    return 'other';
}

/**
 * @typedef {object} CategoryShare
 * @property {string} key {@link RECEIPT_CATEGORIES} key.
 * @property {string} label Display label.
 * @property {number} tokens Summed tokens of the category's contributing entries.
 * @property {number} entries How many of the receipt's entries landed in it.
 * @property {number} share Percent of the receipt's total, `[0, 100]` (via {@link tokenShare}).
 */

/**
 * Rolls a receipt's entries up into its colour categories, in {@link RECEIPT_CATEGORIES}
 * order, omitting categories that contributed no tokens (an `emptyAnchor` entry counts
 * toward nothing — it contributed nothing, so it must not mint a zero-width segment).
 * @param {Array<{identifier?: unknown, name?: unknown, tokens?: unknown, emptyAnchor?: unknown}>} entries
 * @param {Map<string, unknown>|undefined} presetPrompts See {@link entryCategory}.
 * @param {unknown} totalTokens The receipt's `totals.tokens`.
 * @returns {CategoryShare[]} The non-empty categories, in fixed order.
 */
export function categoryBreakdown(entries, presetPrompts, totalTokens) {
    /** @type {Map<string, {tokens: number, entries: number}>} */
    const sums = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const tokens = Number(entry?.tokens);
        if (entry?.emptyAnchor || !Number.isFinite(tokens) || tokens <= 0) {
            continue;
        }
        const key = entryCategory(entry, presetPrompts);
        const sum = sums.get(key) ?? { tokens: 0, entries: 0 };
        sum.tokens += tokens;
        sum.entries += 1;
        sums.set(key, sum);
    }
    return RECEIPT_CATEGORIES
        .filter((category) => sums.has(category.key))
        .map((category) => {
            const sum = /** @type {{tokens: number, entries: number}} */ (sums.get(category.key));
            return { ...category, ...sum, share: tokenShare(sum.tokens, totalTokens) };
        });
}

/**
 * @typedef {object} TrendPoint
 * @property {number} mesId The message the receipt landed on.
 * @property {number} total The receipt's `totals.tokens`.
 * @property {string|null} presetName Preset at capture.
 * @property {CategoryShare[]} shares Its {@link categoryBreakdown}, fixed category order.
 * @property {any} receipt The source record, for "open this one" drill-downs.
 */

/**
 * One chat's landed receipts as a trend series (receipt trend v0): only records bound to a
 * real message (a pending/dry-run capture has no place on a message axis), ascending by
 * `mesId` whatever order the caller holds them in (the tracker keeps history newest-first).
 * @param {any[]} receipts `PromptReceipt`s, any order.
 * @param {Map<string, unknown>|undefined} presetPrompts See {@link entryCategory}.
 * @returns {TrendPoint[]} The series, oldest message first.
 */
export function trendSeries(receipts, presetPrompts) {
    return (Array.isArray(receipts) ? receipts : [])
        .filter((receipt) => Number.isInteger(receipt?.mesId))
        .slice()
        .sort((a, b) => a.mesId - b.mesId)
        .map((receipt) => {
            const total = Number(receipt.totals?.tokens);
            const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
            return {
                mesId: receipt.mesId,
                total: safeTotal,
                presetName: typeof receipt.presetName === 'string' ? receipt.presetName : null,
                shares: categoryBreakdown(receipt.entries, presetPrompts, safeTotal),
                receipt,
            };
        });
}

/**
 * The axis ceiling for a value: the next "nice" number at or above it (1, 2, 2.5, 5 × 10ⁿ),
 * so gridlines land on round labels (10k, 25k) instead of 23,817.
 * @param {number} value The largest value on the axis.
 * @returns {number} The ceiling, or 0 for nothing to plot.
 */
export function niceCeiling(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    const magnitude = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5]) {
        if (step * magnitude >= value) {
            return step * magnitude;
        }
    }
    return 10 * magnitude;
}

/**
 * Compact axis label: `950`, `1.2k`, `12k`, `1.5M`. Axis ticks only — every exact value is
 * printed in full in tooltips and the table view.
 * @param {number} value A non-negative number.
 * @returns {string} The label.
 */
export function formatCompact(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return '0';
    }
    const trim = (/** @type {string} */ text) => text.replace(/\.0$/, '');
    if (value < 1000) {
        return String(Math.round(value));
    }
    if (value < 1e6) {
        return `${trim((value / 1000).toFixed(value < 10000 ? 1 : 0))}k`;
    }
    return `${trim((value / 1e6).toFixed(1))}M`;
}

/**
 * A share as reading text: whole percents, with `<1%` for a real-but-tiny contribution so a
 * prompt that cost 40 tokens of 30,000 never reads as "0%" (which would say it cost nothing).
 * @param {number} share Percent in `[0, 100]`, e.g. from {@link tokenShare}.
 * @returns {string} The label.
 */
export function formatShare(share) {
    if (!Number.isFinite(share) || share <= 0) {
        return '0%';
    }
    if (share < 1) {
        return '<1%';
    }
    return `${Math.round(share)}%`;
}

/**
 * One resolved label plus an honesty hint, never a bare string — a caller must not lose the
 * distinction between "this is what the preset calls it" and "this identifier could not be
 * placed", which is exactly the `present` honesty `view-model.js:339` pins for the prompt list.
 * @typedef {object} ResolvedLabel
 * @property {string} label The text to render.
 * @property {string|null} hint A muted qualifier to render alongside it, or null for none.
 */

/**
 * Resolves one entry's identifier to a display label, honestly, per
 * `docs/receipt-tracker-v0.md` decision 3's fallback chain:
 *
 * 1. The entry's own v2 capture-time `name` snapshot — a receipt that says "Main Prompt"
 *    forever beats one that decays to a UUID after a rename.
 * 2. The identifier's name in the CURRENT preset's `prompts[]` (a v1 record, or a v2 record
 *    an old capture never snapshotted, falls back to whatever the preset calls it today).
 * 3. The authored engine-slot label ({@link ENGINE_SLOT_LABELS}), for identifiers that are
 *    never preset rows.
 * 4. The raw identifier, with `hint: 'not in current preset'` — the last case is the only one
 *    that ever sets a hint, because it is the only one where the label might be misleading.
 * @param {{identifier?: unknown, name?: unknown}} entry A `ReceiptEntry`
 *   ({@link import('./receipts.js').ReceiptEntry}), or anything entry-shaped.
 * @param {Map<string, {name?: unknown}>} presetPrompts identifier → current-preset prompt
 *   record, e.g. `indexPrompts(oai_settings.prompts)` from `./view-model.js`.
 * @returns {ResolvedLabel} The label to render, honestly qualified.
 */
export function resolveEntryLabel(entry, presetPrompts) {
    const identifier = typeof entry?.identifier === 'string' && entry.identifier ? entry.identifier : '(unknown)';

    const snapshot = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (snapshot) {
        return { label: snapshot, hint: null };
    }

    const presetRecord = presetPrompts?.get(identifier);
    const presetName = typeof presetRecord?.name === 'string' ? presetRecord.name.trim() : '';
    if (presetName) {
        return { label: presetName, hint: null };
    }

    const engineLabel = ENGINE_SLOT_LABELS[identifier];
    if (engineLabel) {
        return { label: engineLabel, hint: null };
    }

    return { label: identifier, hint: 'not in current preset' };
}

/**
 * One entry's proportional share of a receipt's total tokens, as a CSS-ready percent.
 * Guards the divide-by-zero a receipt with no contributing tokens can produce (every entry
 * `emptyAnchor`, or a hole-only tree) — such a receipt must render a flat, honest empty bar,
 * never `NaN%` or `Infinity%`.
 * @param {unknown} tokens The entry's token count.
 * @param {unknown} totalTokens The receipt's `totals.tokens`.
 * @returns {number} A percent in `[0, 100]`.
 */
export function tokenShare(tokens, totalTokens) {
    const entryTokens = Number(tokens);
    const total = Number(totalTokens);
    if (!Number.isFinite(entryTokens) || entryTokens <= 0 || !Number.isFinite(total) || total <= 0) {
        return 0;
    }
    return Math.min(100, (entryTokens / total) * 100);
}

/**
 * The live card's state badge text, per `docs/receipt-tracker-v0.md` decision 5: a landed
 * `mesId` outranks everything else (a landed receipt is never re-labelled "dry run" just
 * because `dryRun` also happens to be readable on it), then an authoritative dry run, then
 * "still assembling" for a pending capture with `dryRun` unresolved.
 * @param {{mesId?: unknown, dryRun?: unknown}|null} receipt A `PromptReceipt`
 *   ({@link import('./receipts.js').PromptReceipt}), or null for no capture at all.
 * @returns {string} The badge text, or `''` when there is nothing to badge.
 */
export function receiptStateBadge(receipt) {
    if (!receipt) {
        return '';
    }
    if (Number.isInteger(receipt.mesId)) {
        return `Landed · mes ${receipt.mesId}`;
    }
    if (receipt.dryRun === true) {
        return 'Dry run';
    }
    return 'Assembling…';
}

/**
 * The one quiet line a receipt's empty root slots collapse into, per decision 4 — never a
 * fabricated row per hole. Returns null for a receipt with no holes, so a caller can omit the
 * line entirely rather than branch on an empty string.
 * @param {unknown} holeCount The receipt's `holes.length`.
 * @returns {string|null} The summary line, or null when there is nothing to summarize.
 */
export function holesSummaryLine(holeCount) {
    const count = Number(holeCount);
    if (!Number.isFinite(count) || count <= 0) {
        return null;
    }
    return `${count} slots empty — disabled or non-contributing`;
}
