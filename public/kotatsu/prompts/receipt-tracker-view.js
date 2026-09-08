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
