/**
 * `<k-receipt-tracker variant="card">` — the live surface for prompt receipts
 * (`docs/receipt-tracker-v0.md`, decisions 3-6 and 8; the view half of prompt-manager v0's
 * decision 9). Renders the assembly-order provenance `./receipts.js` already captures: a
 * live card for the active chat's most recent generation, and a compact, expandable history
 * of every landed receipt underneath it.
 *
 * Mounted as an ordinary Lit child of `k-tab-rail.js`'s Trackers page (its `view` branch) —
 * nothing here is docked or relocated, so none of that file's static-part discipline
 * applies. Light DOM (`createRenderRoot()` returns `this`) for the reason every Kotatsu
 * component gives: `public/css/receipt-tracker.css` has to reach these internals, and a
 * future theme pack's `sheet.css` needs the same access.
 *
 * Decisions this file implements literally:
 *
 * - **Decision 4 — assembly order is the display order.** Entries render in `entries[]`
 *   order, never re-sorted or grouped. Holes collapse into ONE quiet summary line
 *   ({@link holesSummaryLine}), never a fabricated row per empty slot.
 * - **Decision 5 — live card + landed history**, kept in sync two ways: `receiptStore`'s
 *   `subscribe()` for anything that happens to the ACTIVE chat while this element is
 *   mounted, and `CHAT_CHANGED` for a full resync when the chat itself changes. History
 *   loads are async (`receiptStore.all()`); a token counter plus a re-check of the active
 *   chat id after every `await` is what keeps a slow, stale load from ever clobbering what
 *   the user is looking at now ({@link KReceiptTracker#loadHistory}).
 * - **Decision 3 — the label-resolution fallback chain** lives in `./receipt-tracker-view.js`
 *   as a pure, unit-tested function ({@link resolveEntryLabel}) so it needs no DOM and no
 *   mocked core module to test — the same split `view-model.js` gives `k-prompt-list.js`.
 * - **Decision 6 — `messages[]` is never rendered.** `truncatedDetail` only ever produces a
 *   muted note; the per-message detail array itself — present or not — never reaches the
 *   template. There is no per-entry breakdown disclosure in v0.
 * - **Decision 8 — component contract.** `variant="card"` reflected (SPEC §13, even though
 *   v0 has one variant), classes `.k-rt-*`, sheet `public/css/receipt-tracker.css`.
 *   Registered from `shell/index.js` via {@link initReceiptTracker}; MOUNTED by
 *   `k-tab-rail.js`, not by this module — definition and placement are separate concerns on
 *   purpose, the same split `k-preset-pages.js` and its host use.
 *
 * One-way imports: kotatsu → core. Nothing in core imports this file.
 */

import { html, LitElement, nothing } from '../shell/lit.js';
import { getCurrentChatId } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings, promptManager } from '../../scripts/openai.js';
import { RECEIPT_CAVEATS, receiptStore } from './receipts.js';
import { indexPrompts } from './view-model.js';
import {
    holesSummaryLine,
    receiptStateBadge,
    resolveEntryLabel,
    tokenShare,
} from './receipt-tracker-view.js';

/**
 * Store-change reasons that mean "the active chat's landed history may have moved" —
 * `receipts.js`'s own list plus `'reindexed'`, the additive reason the parallel reindex
 * slice (`docs/receipt-tracker-v0.md` decision 2) notifies with. Treated exactly like
 * `'saved'`: both mean "re-read `all()`", and reindexing additionally invalidates any
 * expanded row, because the `mesId`s it was keyed against may have just shifted.
 * @type {ReadonlySet<string>}
 */
const HISTORY_RELOAD_REASONS = new Set(['saved', 'forgotten', 'reindexed']);

/** Reasons that only ever touch the live capture, never the persisted history. */
const LIVE_ONLY_REASONS = new Set(['captured', 'resolved', 'dry-run', 'landed']);

/**
 * Short chip label + honest full explanation for each of `receipts.js`'s three structural
 * caveats (`receipts.js:170-190`), reproduced here rather than re-derived so the text a
 * reader hovers is drawn from the same source that decided whether the caveat fires.
 * @type {Readonly<Record<string, {label: string, title: string}>>}
 */
const CAVEAT_COPY = Object.freeze({
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
 * The live surface: a card for the active chat's latest capture, and its landed history.
 */
export class KReceiptTracker extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `card` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _live: { state: true },
        _history: { state: true },
        _historyReady: { state: true },
        _expandedMesId: { state: true },
    };

    /** @type {(() => void)|null} Unsubscribe from `receiptStore`. */
    #unsubscribeStore = null;

    /** @type {(() => void)|null} `CHAT_CHANGED` handler, so `disconnectedCallback` can remove exactly it. */
    #onChatChanged = null;

    /**
     * Bumped on every `#loadHistory` call. A resolve whose token no longer matches the
     * latest one started is a stale load — the chat moved again, or a reload was already
     * re-issued — and must be dropped rather than applied.
     * @type {number}
     */
    #historyToken = 0;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'card';
        /** @type {import('./receipts.js').PromptReceipt|null} */
        this._live = null;
        /** @type {import('./receipts.js').PromptReceipt[]} Newest-first. */
        this._history = [];
        /** @type {boolean} Whether the first `all()` load for the current chat has resolved. */
        this._historyReady = false;
        /** @type {number|null} `mesId` of the one open history row, or null. */
        this._expandedMesId = null;
    }

    /** Light DOM: `public/css/receipt-tracker.css` owns every rule. See the file header. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        this.#unsubscribeStore = receiptStore.subscribe((change) => this.#onStoreChange(change));
        this.#onChatChanged = () => this.#reload();
        eventSource.on(event_types.CHAT_CHANGED, this.#onChatChanged);
        this.#reload();
    }

    /**
     * Full unsubscribe — the rail unmounts this element on every layout switch, so a leaked
     * listener here would stack one more copy per switch for the life of the page.
     * @returns {void}
     */
    disconnectedCallback() {
        if (this.#unsubscribeStore) {
            this.#unsubscribeStore();
            this.#unsubscribeStore = null;
        }
        if (this.#onChatChanged) {
            eventSource.removeListener(event_types.CHAT_CHANGED, this.#onChatChanged);
            this.#onChatChanged = null;
        }
        super.disconnectedCallback();
    }

    /**
     * The live `serviceSettings`: `promptManager`'s own binding when a manager exists (the
     * same object `k-prompt-list.js:489` reads), falling back to the imported `oai_settings`
     * module binding. Settings can be populated before `promptManager` itself is constructed
     * (`receipts.js`'s own `#tryAttach` retry exists for exactly this ordering), and label
     * resolution should not go blind for that window.
     * @returns {any} The live settings object, or null.
     */
    get #settings() {
        return promptManager?.serviceSettings ?? oai_settings ?? null;
    }

    /** @returns {string} The active chat id, or `''`. Never throws. */
    #chatId() {
        try {
            return String(getCurrentChatId() ?? '');
        } catch {
            return '';
        }
    }

    /**
     * Full resync: the synchronous live capture, plus a fresh async history load. Called on
     * mount and on `CHAT_CHANGED` — the only two moments the ACTIVE chat itself can differ
     * from what this element last rendered.
     * @returns {void}
     */
    #reload() {
        const chatId = this.#chatId();
        this._live = receiptStore.latest(chatId);
        this._expandedMesId = null;
        void this.#loadHistory(chatId);
    }

    /**
     * Loads every persisted receipt for one chat, newest first.
     *
     * `receiptStore.all()` is async; nothing stops the user from switching chats again (or
     * this method being re-entered by a `'saved'` notification) before it resolves. The
     * token counter rejects a stale call outright, and the chat-id re-check after the await
     * is the second, independent guard — the two together are what "must guard against the
     * chat having changed by resolve time" means in the brief.
     * @param {string} chatId Chat this load is FOR — captured before the `await`.
     * @returns {Promise<void>}
     */
    async #loadHistory(chatId) {
        const token = ++this.#historyToken;
        const receipts = await receiptStore.all(chatId);
        if (token !== this.#historyToken || chatId !== this.#chatId()) {
            return;
        }
        this._history = receipts.slice().reverse();
        this._historyReady = true;
    }

    /**
     * Reacts to a `receiptStore` notification. Changes for a chat other than the active one
     * are not this element's business — `subscribe()` is store-wide, one instance per page,
     * and this component only ever shows the active chat.
     * @param {import('./receipts.js').ReceiptChange} change What moved.
     * @returns {void}
     */
    #onStoreChange(change) {
        const chatId = this.#chatId();
        if (change.chatId !== chatId) {
            return;
        }
        if (LIVE_ONLY_REASONS.has(change.reason)) {
            this._live = receiptStore.latest(chatId);
            return;
        }
        if (HISTORY_RELOAD_REASONS.has(change.reason)) {
            this._live = receiptStore.latest(chatId);
            if (change.reason !== 'saved') {
                // A save only ever upserts one record at its own mesId — whatever the user
                // has open is still the same receipt. Forgetting empties the chat outright,
                // and a reindex can shift the very mesId an open row is keyed on: both make
                // "leave it open" dishonest, so both close it instead.
                this._expandedMesId = null;
            }
            void this.#loadHistory(chatId);
        }
    }

    /**
     * @param {number|null} mesId The row's receipt id — matches `PromptReceipt.mesId`'s own
     *   type even though a persisted, landed receipt (the only kind `#renderHistoryRow` ever
     *   calls this with) always carries a real integer.
     * @returns {void}
     */
    #toggleHistory(mesId) {
        this._expandedMesId = this._expandedMesId === mesId ? null : mesId;
    }

    /**
     * One caveat chip. Silently renders nothing for a value outside {@link CAVEAT_COPY} —
     * `RECEIPT_CAVEATS`' own three are the only ones this file has honest copy for, and a
     * value this store never emits is not this view's business to invent text for.
     * @param {string} caveat One entry of a receipt's `caveats[]`.
     * @returns {unknown} The chip, or nothing.
     */
    #renderCaveat(caveat) {
        const copy = CAVEAT_COPY[caveat];
        return copy
            ? html`<span class="k-rt-caveat" title=${copy.title}>${copy.label}</span>`
            : nothing;
    }

    /**
     * @param {string[]|null|undefined} caveats A receipt's `caveats[]`.
     * @returns {unknown} The chip row, or nothing for a clean receipt.
     */
    #renderCaveats(caveats) {
        if (!Array.isArray(caveats) || caveats.length === 0) {
            return nothing;
        }
        return html`
            <div class="k-rt-caveats">
                ${caveats.map((caveat) => this.#renderCaveat(caveat))}
            </div>`;
    }

    /**
     * One entry's token badge, or its honest `emptyAnchor` replacement. Never both: a
     * collection that held messages but contributed nothing must never ALSO show "0" next to
     * a flat bar, which would read as a real, if small, contribution.
     * @param {import('./receipts.js').ReceiptEntry} entry One assembly-tree entry.
     * @param {number} share {@link tokenShare} for this entry against the receipt's total.
     * @returns {unknown} The metric cell.
     */
    #renderEntryMetric(entry, share) {
        if (entry.emptyAnchor) {
            return html`<span class="k-rt-entry-empty">contributed nothing</span>`;
        }
        return html`
            <div class="k-rt-entry-metric">
                <span class="k-rt-entry-tokens">${entry.tokens}</span>
                <div class="k-rt-bar"><div class="k-rt-bar-fill" style=${`width:${share}%`}></div></div>
                ${entry.messageCount > 1 ? html`<span class="k-rt-entry-count">×${entry.messageCount}</span>` : nothing}
                ${entry.truncatedDetail ? html`<span class="k-rt-entry-truncated">per-message detail elided</span>` : nothing}
            </div>`;
    }

    /**
     * One assembly-tree entry, in the order it appears in `entries[]` — never re-sorted,
     * never grouped (decision 4).
     * @param {import('./receipts.js').ReceiptEntry} entry One entry.
     * @param {Map<string, {name?: unknown}>} presetPrompts identifier → current-preset record.
     * @param {number} totalTokens The receipt's `totals.tokens`.
     * @returns {unknown} One entry row.
     */
    #renderEntry(entry, presetPrompts, totalTokens) {
        const resolved = resolveEntryLabel(entry, presetPrompts);
        const share = tokenShare(entry.tokens, totalTokens);
        return html`
            <div class="k-rt-entry">
                <div class="k-rt-entry-label">
                    <span class="k-rt-entry-name">${resolved.label}</span>
                    ${resolved.hint ? html`<span class="k-rt-entry-hint">${resolved.hint}</span>` : nothing}
                </div>
                ${entry.roles.length > 0 ? html`
                    <div class="k-rt-entry-roles">
                        ${entry.roles.map((role) => html`<span class="k-rt-role">${role}</span>`)}
                    </div>` : nothing}
                ${this.#renderEntryMetric(entry, share)}
            </div>`;
    }

    /**
     * The full entry table for one receipt — shared verbatim between the live card and an
     * expanded history row, per decision 5 ("the same row renderer as the live card").
     * @param {import('./receipts.js').PromptReceipt} receipt One receipt.
     * @returns {unknown} The entries block.
     */
    #renderEntries(receipt) {
        const presetPrompts = indexPrompts(this.#settings?.prompts);
        const totalTokens = Number(receipt.totals?.tokens) || 0;
        const holes = holesSummaryLine(receipt.totals?.holes);
        return html`
            <div class="k-rt-entries">
                ${receipt.entries.map((entry) => this.#renderEntry(entry, presetPrompts, totalTokens))}
            </div>
            ${holes ? html`<div class="k-rt-holes">${holes}</div>` : nothing}`;
    }

    /**
     * The live card: state badge, preset/type/time meta, totals, caveats, entries.
     * @param {import('./receipts.js').PromptReceipt} receipt The active chat's latest capture.
     * @returns {unknown} The card.
     */
    #renderLiveCard(receipt) {
        const badgeClass = Number.isInteger(receipt.mesId)
            ? 'is-landed'
            : receipt.dryRun === true ? 'is-dry' : 'is-pending';
        const capturedAt = Number.isFinite(receipt.capturedAt)
            ? new Date(receipt.capturedAt).toLocaleTimeString()
            : '';
        const totals = receipt.totals ?? { tokens: 0, collections: 0, messages: 0 };
        return html`
            <div class="k-rt-card">
                <div class="k-rt-card-header">
                    <span class="k-rt-badge ${badgeClass}">${receiptStateBadge(receipt)}</span>
                    <span class="k-rt-meta-item">${receipt.presetName || 'no preset recorded'}</span>
                    <span class="k-rt-meta-item">${receipt.generationType || 'unknown type'}</span>
                    ${capturedAt ? html`<span class="k-rt-meta-item k-rt-meta-time">${capturedAt}</span>` : nothing}
                </div>
                <div class="k-rt-totals">
                    ${totals.tokens} tokens · ${totals.collections} collections · ${totals.messages} messages
                </div>
                ${this.#renderCaveats(receipt.caveats)}
                ${this.#renderEntries(receipt)}
            </div>`;
    }

    /**
     * One compact history row (`mes N · preset · tokens`); expands into the full entries
     * block for that one receipt when clicked. Only ever one row expanded at a time —
     * `_expandedMesId` is a single value, not a set.
     * @param {import('./receipts.js').PromptReceipt} receipt One landed receipt.
     * @returns {unknown} The row, plus its detail block when expanded.
     */
    #renderHistoryRow(receipt) {
        const expanded = this._expandedMesId === receipt.mesId;
        const totals = receipt.totals ?? { tokens: 0 };
        return html`
            <div class="k-rt-history-item">
                <button
                    type="button"
                    class="k-rt-history-row${expanded ? ' is-expanded' : ''}"
                    aria-expanded=${expanded ? 'true' : 'false'}
                    @click=${() => this.#toggleHistory(receipt.mesId)}
                >
                    <span class="k-rt-history-mes">mes ${receipt.mesId}</span>
                    <span class="k-rt-history-sep" aria-hidden="true">·</span>
                    <span class="k-rt-history-preset">${receipt.presetName || 'no preset recorded'}</span>
                    <span class="k-rt-history-sep" aria-hidden="true">·</span>
                    <span class="k-rt-history-tokens">${totals.tokens} tokens</span>
                </button>
                ${expanded ? html`
                    <div class="k-rt-history-detail">
                        ${this.#renderCaveats(receipt.caveats)}
                        ${this.#renderEntries(receipt)}
                    </div>` : nothing}
            </div>`;
    }

    /**
     * @param {string} text The line to show.
     * @returns {unknown} One muted row, matching the rail's own quiet-state language.
     */
    #renderQuietLine(text) {
        return html`<div class="k-rt-quiet"><span class="k-rt-quiet-text">${text}</span></div>`;
    }

    /**
     * The history section: not-yet-loaded renders nothing (avoids a false "empty" flash
     * before the async read resolves even once), loaded-and-empty gets its own quiet line,
     * loaded-and-populated gets the list.
     * @returns {unknown} The section body.
     */
    #renderHistorySection() {
        if (!this._historyReady) {
            return nothing;
        }
        if (this._history.length === 0) {
            return this.#renderQuietLine('No landed receipts yet for this chat.');
        }
        return html`
            <div class="k-rt-history-list">
                ${this._history.map((receipt) => this.#renderHistoryRow(receipt))}
            </div>`;
    }

    /**
     * The Live section's body: the card when there is a capture, a quiet line otherwise.
     * @param {import('./receipts.js').PromptReceipt|null} live The active chat's latest capture.
     * @returns {unknown} The section body.
     */
    #renderLiveSection(live) {
        return live
            ? this.#renderLiveCard(live)
            : this.#renderQuietLine('No capture yet this session — the tab reads from history below.');
    }

    /** @returns {unknown} The tracker. */
    render() {
        // Captured into a local so TS can narrow it — reading `this._live` a second time
        // would still type as `PromptReceipt|null`.
        const live = this._live;
        const trulyEmpty = !live && this._historyReady && this._history.length === 0;
        if (trulyEmpty) {
            return this.#renderQuietLine('No receipts yet — they appear when a generation lands.');
        }
        return html`
            <section class="k-rt-section k-rt-live">
                <h3 class="k-rt-heading">Live</h3>
                ${this.#renderLiveSection(live)}
            </section>
            <section class="k-rt-section k-rt-history">
                <h3 class="k-rt-heading">History</h3>
                ${this.#renderHistorySection()}
            </section>`;
    }
}

if (!customElements.get('k-receipt-tracker')) {
    customElements.define('k-receipt-tracker', KReceiptTracker);
}

/**
 * Registration entry for the `firstLoadInit()` seam. Unlike `initPresetDock()`, mounting is
 * not this function's job: `k-tab-rail.js`'s `view` branch creates `<k-receipt-tracker>` as
 * an ordinary Lit child when the Trackers tab renders. This only has to guarantee the
 * element is defined before that happens — importing this module already does that at load
 * time — and exists so the shell has exactly one call site per subsystem, matching every
 * other `init*()` on this seam.
 * @returns {void}
 */
export function initReceiptTracker() {
    if (!customElements.get('k-receipt-tracker')) {
        customElements.define('k-receipt-tracker', KReceiptTracker);
    }
}
