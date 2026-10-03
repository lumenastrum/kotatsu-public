/**
 * `<k-receipt-chart variant="popup">` — one prompt receipt as a colour-coded chart (receipt
 * chart v0, 10/2: the data was good but awkward to read).
 *
 * Opened from `<k-receipt-tracker>`'s live card or an expanded history row through
 * {@link openReceiptChart}, inside core's own `Popup` (DISPLAY, `wider`) — so Escape, focus
 * trapping, stacking and the house popup skin (css/rechrome-popups.css) all come free.
 *
 * Two views of the same receipt, both answering "where did my context go?":
 *
 * 1. **By source** — part-to-whole: ONE stacked horizontal bar, segments in the fixed
 *    {@link RECEIPT_CATEGORIES} order (never by size: colour follows the category, never its
 *    rank), plus a legend that doubles as the table view (swatch · source · prompts · tokens ·
 *    share). Hovering or focusing a legend row EMPHASISES that source across both views.
 * 2. **In assembly order** — one bar per entry, in `entries[]` order (receipt-tracker-v0
 *    decision 4: the wire order IS the story; never re-sorted). Bars scale to the LARGEST
 *    entry so a 300-token prompt stays visible beside a 20k chat history; the printed share
 *    is always of the whole receipt, and the caption says so.
 *
 * Honesty carried over from the rail verbatim: `emptyAnchor` renders "contributed nothing"
 * (never a zero-length bar that reads as "a little"). Those rows are FOLDED by default behind
 * one counted toggle ("Show 20 prompts that contributed nothing") — a toggle-heavy preset like
 * Sparkle Sauce carries ~20 zero-token headers that otherwise bury the bars (measured 10/2);
 * unfolded, they return in their assembly positions. Caveat chips come from the shared
 * `receipt-caveats.js`, holes collapse to one line, `messages[]` is never rendered (decision 6).
 *
 * Colour: `--k-viz-1…5` + `--k-viz-other` (tokens.css), bound to categories in
 * css/receipt-tracker.css. Validated with the dataviz validator against every shipped pack's
 * popup surface (Blue Hour #171b2c, Sparkle #23182e dark; Natsumikan #fffaf0 light — the
 * light steps sit under 3:1 for three slots, so every mark carries a visible text label: the
 * relief rule). Identity is never colour-alone: every bar is named in text.
 *
 * Light DOM, `.k-rc-*` classes — same reasoning every Kotatsu component gives.
 * One-way imports: kotatsu → core.
 */

import { html, LitElement, nothing } from '../shell/lit.js';
import { callGenericPopup, POPUP_TYPE } from '../../scripts/popup.js';
import { renderCaveats } from './receipt-caveats.js';
import {
    categoryBreakdown,
    entryCategory,
    formatShare,
    holesSummaryLine,
    RECEIPT_CATEGORIES,
    receiptStateBadge,
    resolveEntryLabel,
    tokenShare,
} from './receipt-tracker-view.js';

/** @type {ReadonlyMap<string, string>} category key → display label. */
const CATEGORY_LABEL = new Map(RECEIPT_CATEGORIES.map((category) => [category.key, category.label]));

/** @param {number} value @returns {string} Grouped integer for reading ("12,480"). */
const fmt = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : '0');

export class KReceiptChart extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `popup` is the only v0 variant. */
        variant: { type: String, reflect: true },
        receipt: { attribute: false },
        presetPrompts: { attribute: false },
        _emphasis: { state: true },
        _showEmpty: { state: true },
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'popup';
        /** @type {import('./receipts.js').PromptReceipt|null} */
        this.receipt = null;
        /** @type {Map<string, {name?: unknown}>} */
        this.presetPrompts = new Map();
        /** @type {string|null} Category key the reader is pointing at, or null. */
        this._emphasis = null;
        /** @type {boolean} Whether `emptyAnchor` rows are unfolded (default: folded). */
        this._showEmpty = false;
    }

    /** Light DOM: css/receipt-tracker.css owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
    }

    /**
     * @param {string|null} key Category to emphasise, or null to clear.
     * @returns {void}
     */
    #emphasise(key) {
        this._emphasis = key;
    }

    /**
     * @param {string} key A row's or segment's category.
     * @returns {string} `' is-dim'` when another category holds the emphasis, else `''`.
     */
    #dim(key) {
        return this._emphasis && this._emphasis !== key ? ' is-dim' : '';
    }

    /**
     * Title row: badge, preset, generation type, time — the live card's header vocabulary.
     * @param {import('./receipts.js').PromptReceipt} receipt
     * @returns {unknown}
     */
    #renderHead(receipt) {
        const badgeClass = Number.isInteger(receipt.mesId)
            ? 'is-landed'
            : receipt.dryRun === true ? 'is-dry' : 'is-pending';
        const capturedAt = Number.isFinite(receipt.capturedAt)
            ? new Date(receipt.capturedAt).toLocaleTimeString()
            : '';
        const totals = receipt.totals ?? { tokens: 0, collections: 0, messages: 0 };
        return html`
            <header class="k-rc-head">
                <div class="k-rc-title-row">
                    <h3 class="k-rc-title">Prompt receipt</h3>
                    <span class="k-rt-badge ${badgeClass}">${receiptStateBadge(receipt)}</span>
                </div>
                <div class="k-rc-meta">
                    <span>${receipt.presetName || 'no preset recorded'}</span>
                    <span aria-hidden="true">·</span>
                    <span>${receipt.generationType || 'unknown type'}</span>
                    ${capturedAt ? html`<span aria-hidden="true">·</span><span>${capturedAt}</span>` : nothing}
                </div>
                <div class="k-rc-hero">
                    <span class="k-rc-hero-value">${fmt(Number(totals.tokens))}</span>
                    <span class="k-rc-hero-unit">tokens</span>
                    <span class="k-rc-hero-sub">${totals.collections} prompts · ${totals.messages} messages</span>
                </div>
            </header>`;
    }

    /**
     * "By source": the stacked bar + the legend-as-table.
     * @param {import('./receipt-tracker-view.js').CategoryShare[]} shares
     * @returns {unknown}
     */
    #renderBySource(shares) {
        if (shares.length === 0) {
            return html`<p class="k-rc-quiet">Nothing in this receipt contributed tokens.</p>`;
        }
        const summary = shares.map((share) => `${share.label} ${formatShare(share.share)}`).join(', ');
        return html`
            <section class="k-rc-section">
                <h4 class="k-rc-heading">By source</h4>
                <div class="k-rc-stack" role="img" aria-label=${`Token share by source: ${summary}`}>
                    ${shares.map((share) => html`
                        <span class="k-rc-seg${this.#dim(share.key)}" data-k-cat=${share.key}
                            style=${`flex-grow:${share.tokens}`}
                            title=${`${share.label} · ${fmt(share.tokens)} tokens · ${formatShare(share.share)}`}></span>`)}
                </div>
                <div class="k-rc-legend" role="table" aria-label="Token share by source"
                    @mouseleave=${() => this.#emphasise(null)}>
                    <div class="k-rc-legend-row k-rc-legend-head" role="row">
                        <span role="columnheader">Source</span>
                        <span role="columnheader" class="k-rc-num">Prompts</span>
                        <span role="columnheader" class="k-rc-num">Tokens</span>
                        <span role="columnheader" class="k-rc-num">Share</span>
                    </div>
                    ${shares.map((share) => html`
                        <div class="k-rc-legend-row${this.#dim(share.key)}" role="row" tabindex="0"
                            data-k-cat=${share.key}
                            @mouseenter=${() => this.#emphasise(share.key)}
                            @focus=${() => this.#emphasise(share.key)}
                            @blur=${() => this.#emphasise(null)}>
                            <span role="cell" class="k-rc-legend-name">
                                <span class="k-rc-swatch" aria-hidden="true"></span>${share.label}
                            </span>
                            <span role="cell" class="k-rc-num">${share.entries}</span>
                            <span role="cell" class="k-rc-num">${fmt(share.tokens)}</span>
                            <span role="cell" class="k-rc-num k-rc-strong">${formatShare(share.share)}</span>
                        </div>`)}
                </div>
            </section>`;
    }

    /**
     * One entry bar in assembly order, with its hover/focus tooltip.
     * @param {import('./receipts.js').ReceiptEntry} entry
     * @param {number} totalTokens The receipt's total.
     * @param {number} maxTokens The largest entry's tokens — the bar scale.
     * @returns {unknown}
     */
    #renderEntryRow(entry, totalTokens, maxTokens) {
        const category = entryCategory(entry, this.presetPrompts);
        const resolved = resolveEntryLabel(entry, this.presetPrompts);
        const share = tokenShare(entry.tokens, totalTokens);
        const length = tokenShare(entry.tokens, maxTokens);
        const roles = Array.isArray(entry.roles) ? entry.roles.join(', ') : '';
        const tokens = fmt(Number(entry.tokens));
        const metric = entry.emptyAnchor
            ? html`<span class="k-rc-row-empty">contributed nothing</span>`
            : html`
                <span class="k-rc-track" aria-hidden="true">
                    ${length > 0 ? html`<span class="k-rc-fill" style=${`width:${length}%`}></span>` : nothing}
                </span>
                <span class="k-rc-num">${tokens}</span>
                <span class="k-rc-num k-rc-strong">${formatShare(share)}</span>`;
        const tipValue = entry.emptyAnchor
            ? 'Held messages but contributed nothing'
            : `${tokens} tokens · ${formatShare(share)} of the receipt`;
        return html`
            <div class="k-rc-row${this.#dim(category)}" data-k-cat=${category} tabindex="0">
                <span class="k-rc-row-name" title=${resolved.label}>
                    <span class="k-rc-swatch" aria-hidden="true"></span>
                    <span class="k-rc-row-label">${resolved.label}</span>
                    ${resolved.hint ? html`<span class="k-rt-entry-hint">${resolved.hint}</span>` : nothing}
                </span>
                ${metric}
                <span class="k-rc-tip" role="tooltip">
                    <span class="k-rc-tip-title">${resolved.label}</span>
                    <span>${CATEGORY_LABEL.get(category) ?? category}</span>
                    <span>${tipValue}</span>
                    <span>${entry.messageCount} message${entry.messageCount === 1 ? '' : 's'}${roles ? ` · ${roles}` : ''}</span>
                    ${entry.truncatedDetail ? html`<span class="k-rc-tip-muted">per-message detail elided</span>` : nothing}
                </span>
            </div>`;
    }

    /**
     * "In assembly order": every entry, wire order, one shared scale.
     * @param {import('./receipts.js').PromptReceipt} receipt
     * @returns {unknown}
     */
    #renderAssembly(receipt) {
        const entries = Array.isArray(receipt.entries) ? receipt.entries : [];
        const totalTokens = Number(receipt.totals?.tokens) || 0;
        const maxTokens = entries.reduce((max, entry) => Math.max(max, Number(entry.tokens) || 0), 0);
        const holes = holesSummaryLine(receipt.totals?.holes);
        const emptyCount = entries.filter((entry) => entry.emptyAnchor).length;
        const shown = this._showEmpty ? entries : entries.filter((entry) => !entry.emptyAnchor);
        const emptyNoun = `prompt${emptyCount === 1 ? '' : 's'} that contributed nothing`;
        return html`
            <section class="k-rc-section">
                <h4 class="k-rc-heading">In assembly order</h4>
                <p class="k-rc-caption">Bars scale to the largest prompt; shares are of the whole receipt.</p>
                <div class="k-rc-rows">
                    ${shown.map((entry) => this.#renderEntryRow(entry, totalTokens, maxTokens))}
                </div>
                ${emptyCount > 0 ? html`
                    <button type="button" class="k-rc-empty-toggle" aria-expanded=${this._showEmpty ? 'true' : 'false'}
                        @click=${() => { this._showEmpty = !this._showEmpty; }}>
                        ${this._showEmpty ? `Hide the ${emptyCount} ${emptyNoun}` : `Show ${emptyCount} ${emptyNoun}`}
                    </button>` : nothing}
                ${holes ? html`<div class="k-rt-holes">${holes}</div>` : nothing}
            </section>`;
    }

    /** @returns {unknown} */
    render() {
        const receipt = this.receipt;
        if (!receipt) {
            return nothing;
        }
        const shares = categoryBreakdown(receipt.entries, this.presetPrompts, receipt.totals?.tokens);
        return html`
            ${this.#renderHead(receipt)}
            ${renderCaveats(receipt.caveats)}
            ${this.#renderBySource(shares)}
            ${this.#renderAssembly(receipt)}`;
    }
}

if (!customElements.get('k-receipt-chart')) {
    customElements.define('k-receipt-chart', KReceiptChart);
}

/**
 * Opens one receipt as a chart in core's DISPLAY popup. Resolves when the popup closes.
 * @param {import('./receipts.js').PromptReceipt} receipt The receipt to chart (a snapshot —
 *   the element holds this object; nothing mutates it while open).
 * @param {Map<string, {name?: unknown}>} presetPrompts identifier → current-preset record,
 *   for label resolution and the preset-vs-other category call.
 * @returns {Promise<void>}
 */
export async function openReceiptChart(receipt, presetPrompts) {
    const chart = /** @type {KReceiptChart} */ (document.createElement('k-receipt-chart'));
    chart.receipt = receipt;
    chart.presetPrompts = presetPrompts ?? new Map();
    await callGenericPopup(chart, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
}
