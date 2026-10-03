/**
 * Caveat chip copy, shared by `<k-receipt-tracker>` (the rail) and `<k-receipt-chart>` (the
 * popup) so the two surfaces can never word a receipt's limits differently
 * (`docs/receipt-tracker-v0.md` decision 5: "the difference between an inspector that is
 * trusted and one that quietly lies"). Moved out of `k-receipt-tracker.js` verbatim.
 */

import { html, nothing } from '../shell/lit.js';
import { RECEIPT_CAVEATS } from './receipts.js';

/**
 * Short chip label + honest full explanation for each of `receipts.js`'s three structural
 * caveats (`receipts.js:170-190`), reproduced here rather than re-derived so the text a
 * reader hovers is drawn from the same source that decided whether the caveat fires.
 * @type {Readonly<Record<string, {label: string, title: string}>>}
 */
export const CAVEAT_COPY = Object.freeze({
    [RECEIPT_CAVEATS.EXTENSION_INJECTION_INTO_MAIN]: {
        label: 'Extension injected into main',
        title: 'An extension (summarize, author\'s note, vectors, or smart context) inserted extra messages into the "main" collection. Their tokens are counted under main and cannot be separated back out.',
    },
    [RECEIPT_CAVEATS.IN_CHAT_INJECTIONS_UNDER_CHATHISTORY]: {
        label: 'In-chat injections folded into history',
        title: 'chatHistory may include prompts injected in-chat. The assembler renames every member of that collection chatHistory-<n>, so which messages were injected — and by which prompt — is not recoverable from this record.',
    },
    [RECEIPT_CAVEATS.TOKENS_ARE_PRE_SQUASH]: {
        label: 'Tokens pre-squash',
        title: 'squash_system_messages was on for this generation. The assembler later merged adjacent system messages and re-tokenized the result, so these per-entry token counts are what the assembler budgeted, not necessarily what the tokenizer finally saw.',
    },
});

/**
 * The caveat chip row. Silently skips a value outside {@link CAVEAT_COPY} — `RECEIPT_CAVEATS`'
 * own three are the only ones there is honest copy for, and a value the store never emits is
 * not a view's business to invent text for.
 * @param {string[]|null|undefined} caveats A receipt's `caveats[]`.
 * @returns {unknown} The chip row, or nothing for a clean receipt.
 */
export function renderCaveats(caveats) {
    if (!Array.isArray(caveats) || caveats.length === 0) {
        return nothing;
    }
    const chips = caveats.map((caveat) => {
        const copy = CAVEAT_COPY[caveat];
        return copy
            ? html`<span class="k-rt-caveat" title=${copy.title}>${copy.label}</span>`
            : nothing;
    });
    return html`<div class="k-rt-caveats">${chips}</div>`;
}
