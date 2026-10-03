/**
 * `<k-receipt-trend variant="popup">` — how one chat's prompt grew, message by message
 * (receipt trend v0, Andres 10/2: "a history trend chart would be amazing").
 *
 * One stacked column per LANDED receipt, ascending by message (`trendSeries()`), segments in
 * the fixed {@link RECEIPT_CATEGORIES} order bottom → top — Chat history first, so the
 * growth that usually drives the curve sits on the baseline where it reads cleanly, and every
 * vertical neighbour is a pair the palette was validated on. Same colour contract as
 * `<k-receipt-chart>` (`data-k-cat` → `--k-rc-cat`, css/receipt-tracker.css).
 *
 * - y: one shared scale to a nice ceiling (`niceCeiling()`), three recessive gridlines with
 *   compact labels; x: message numbers under every Nth column (≤ 8 labels).
 * - Each column is a BUTTON: the whole plot height is its hit target, hover/focus shows the
 *   breakdown, click opens that message's receipt as `<k-receipt-chart>` on top.
 * - Legend hover/focus emphasises one source across every column.
 * - "Show as table" swaps the plot for the exact numbers (the dataviz table-view rule).
 *
 * Light DOM, `.k-rtr-*`. One-way imports: kotatsu → core.
 */

import { html, LitElement, nothing } from '../shell/lit.js';
import { callGenericPopup, POPUP_TYPE } from '../../scripts/popup.js';
import { openReceiptChart } from './k-receipt-chart.js';
import {
    formatCompact,
    formatShare,
    niceCeiling,
    RECEIPT_CATEGORIES,
    trendSeries,
} from './receipt-tracker-view.js';

/** Most x-axis labels before they start colliding at the popup's 750px floor. */
const MAX_X_LABELS = 8;

/** @param {number} value @returns {string} */
const fmt = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : '0');

export class KReceiptTrend extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        receipts: { attribute: false },
        presetPrompts: { attribute: false },
        _emphasis: { state: true },
        _table: { state: true },
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'popup';
        /** @type {any[]} Landed receipts, any order. */
        this.receipts = [];
        /** @type {Map<string, {name?: unknown}>} */
        this.presetPrompts = new Map();
        /** @type {string|null} */
        this._emphasis = null;
        /** @type {boolean} */
        this._table = false;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
    }

    /** @param {string} key @returns {string} */
    #dim(key) {
        return this._emphasis && this._emphasis !== key ? ' is-dim' : '';
    }

    /**
     * @param {import('./receipt-tracker-view.js').TrendPoint[]} series
     * @returns {unknown} Title, hero (latest total) and the first → latest growth line.
     */
    #renderHead(series) {
        const first = series[0];
        const last = series[series.length - 1];
        const growth = last.total - first.total;
        const sign = growth > 0 ? '+' : growth < 0 ? '−' : '±';
        return html`
            <header class="k-rc-head">
                <div class="k-rc-title-row">
                    <h3 class="k-rc-title">Prompt growth</h3>
                </div>
                <div class="k-rc-meta">
                    <span>${series.length} landed receipts</span>
                    <span aria-hidden="true">·</span>
                    <span>mes ${first.mesId} – ${last.mesId}</span>
                </div>
                <div class="k-rc-hero">
                    <span class="k-rc-hero-value">${fmt(last.total)}</span>
                    <span class="k-rc-hero-unit">tokens at mes ${last.mesId}</span>
                    <span class="k-rc-hero-sub">${sign}${fmt(Math.abs(growth))} since mes ${first.mesId} (${fmt(first.total)})</span>
                </div>
            </header>`;
    }

    /**
     * Legend: only sources that appear somewhere in the series, fixed order.
     * @param {string[]} keys Present category keys.
     * @returns {unknown}
     */
    #renderLegend(keys) {
        return html`
            <div class="k-rtr-legend" @mouseleave=${() => { this._emphasis = null; }}>
                ${RECEIPT_CATEGORIES.filter((category) => keys.includes(category.key)).map((category) => html`
                    <span class="k-rtr-legend-item${this.#dim(category.key)}" data-k-cat=${category.key} tabindex="0"
                        @mouseenter=${() => { this._emphasis = category.key; }}
                        @focus=${() => { this._emphasis = category.key; }}
                        @blur=${() => { this._emphasis = null; }}>
                        <span class="k-rc-swatch" aria-hidden="true"></span>${category.label}
                    </span>`)}
            </div>`;
    }

    /**
     * One column: a button whose whole height is the hit target.
     * @param {import('./receipt-tracker-view.js').TrendPoint} point
     * @param {number} index Position in the series.
     * @param {number} count Series length.
     * @param {number} ceiling Axis ceiling.
     * @param {boolean} labelled Whether this column carries an x-axis label.
     * @returns {unknown}
     */
    #renderColumn(point, index, count, ceiling, labelled) {
        const height = ceiling > 0 ? (point.total / ceiling) * 100 : 0;
        // Tooltips open AWAY from the nearer edge so they never clip at either end.
        const side = index >= count / 2 ? 'is-left' : 'is-right';
        return html`
            <button type="button" class="k-rtr-col" data-mes=${point.mesId}
                aria-label=${`mes ${point.mesId}: ${fmt(point.total)} tokens. Open its receipt.`}
                @click=${() => void openReceiptChart(point.receipt, this.presetPrompts)}>
                <span class="k-rtr-bar" style=${`height:${height}%`}>
                    ${point.shares.map((share) => html`
                        <span class="k-rtr-seg${this.#dim(share.key)}" data-k-cat=${share.key}
                            style=${`flex-grow:${share.tokens}`}></span>`)}
                </span>
                ${labelled ? html`<span class="k-rtr-xlabel">${point.mesId}</span>` : nothing}
                <span class="k-rtr-tip ${side}" role="tooltip">
                    <span class="k-rc-tip-title">mes ${point.mesId} · ${fmt(point.total)} tokens</span>
                    ${point.presetName ? html`<span class="k-rc-tip-muted">${point.presetName}</span>` : nothing}
                    ${point.shares.slice().reverse().map((share) => html`
                        <span class="k-rtr-tip-row" data-k-cat=${share.key}>
                            <span class="k-rc-swatch" aria-hidden="true"></span>
                            <span class="k-rtr-tip-label">${share.label}</span>
                            <span class="k-rc-num">${fmt(share.tokens)}</span>
                            <span class="k-rc-num">${formatShare(share.share)}</span>
                        </span>`)}
                    <span class="k-rc-tip-muted">Click to open this receipt</span>
                </span>
            </button>`;
    }

    /**
     * @param {import('./receipt-tracker-view.js').TrendPoint[]} series
     * @returns {unknown} The plot: y labels + gridlines + columns.
     */
    #renderPlot(series) {
        const ceiling = niceCeiling(Math.max(...series.map((point) => point.total)));
        // ≤ MAX_X_LABELS evenly spaced indices that always include the first and last column
        // (a fixed "every Nth" plus a forced last label overshoots the cap and crowds the end).
        const labelCount = Math.min(series.length, MAX_X_LABELS);
        const labelled = new Set(Array.from({ length: labelCount }, (_, k) =>
            labelCount === 1 ? 0 : Math.round((k * (series.length - 1)) / (labelCount - 1))));
        const dense = series.length > 60 ? ' is-dense' : '';
        const ticks = [ceiling, ceiling / 2, 0];
        return html`
            <div class="k-rtr-plot" role="img"
                aria-label=${`Prompt tokens per landed message, mes ${series[0].mesId} to ${series[series.length - 1].mesId}. Use "Show as table" for exact values.`}>
                <div class="k-rtr-yaxis" aria-hidden="true">
                    ${ticks.map((tick) => html`<span>${formatCompact(tick)}</span>`)}
                </div>
                <div class="k-rtr-area">
                    <span class="k-rtr-grid is-top" aria-hidden="true"></span>
                    <span class="k-rtr-grid is-mid" aria-hidden="true"></span>
                    <span class="k-rtr-grid is-base" aria-hidden="true"></span>
                    <div class="k-rtr-cols${dense}">
                        ${series.map((point, index) => this.#renderColumn(point, index, series.length, ceiling, labelled.has(index)))}
                    </div>
                </div>
            </div>`;
    }

    /**
     * One table cell. A source absent from this receipt reads "—", never a fabricated 0.
     * @param {import('./receipt-tracker-view.js').TrendPoint} point
     * @param {string} key Category key.
     * @returns {unknown}
     */
    #renderCell(point, key) {
        const share = point.shares.find((candidate) => candidate.key === key);
        return html`<td class="k-rc-num">${share ? fmt(share.tokens) : '—'}</td>`;
    }

    /**
     * The table view: exact numbers, one row per landed message, present sources as columns.
     * @param {import('./receipt-tracker-view.js').TrendPoint[]} series
     * @param {string[]} keys Present category keys.
     * @returns {unknown}
     */
    #renderTable(series, keys) {
        const columns = RECEIPT_CATEGORIES.filter((category) => keys.includes(category.key));
        return html`
            <div class="k-rtr-table-wrap">
                <table class="k-rtr-table">
                    <thead>
                        <tr>
                            <th scope="col">Message</th>
                            <th scope="col" class="k-rc-num">Total</th>
                            ${columns.map((category) => html`
                                <th scope="col" class="k-rc-num" data-k-cat=${category.key}>
                                    <span class="k-rc-swatch" aria-hidden="true"></span>${category.label}
                                </th>`)}
                        </tr>
                    </thead>
                    <tbody>
                        ${series.map((point) => html`
                            <tr>
                                <th scope="row">mes ${point.mesId}</th>
                                <td class="k-rc-num k-rc-strong">${fmt(point.total)}</td>
                                ${columns.map((category) => this.#renderCell(point, category.key))}
                            </tr>`)}
                    </tbody>
                </table>
            </div>`;
    }

    render() {
        const series = trendSeries(this.receipts, this.presetPrompts);
        if (series.length < 2) {
            return html`<p class="k-rc-quiet">A trend needs at least two landed receipts in this chat.</p>`;
        }
        const keys = [...new Set(series.flatMap((point) => point.shares.map((share) => share.key)))];
        return html`
            ${this.#renderHead(series)}
            <section class="k-rc-section">
                <div class="k-rtr-toolbar">
                    <h4 class="k-rc-heading">Tokens per landed message</h4>
                    <button type="button" class="k-rc-empty-toggle" aria-pressed=${this._table ? 'true' : 'false'}
                        @click=${() => { this._table = !this._table; }}>
                        ${this._table ? 'Show as chart' : 'Show as table'}
                    </button>
                </div>
                ${this.#renderLegend(keys)}
                ${this._table ? this.#renderTable(series, keys) : this.#renderPlot(series)}
            </section>`;
    }
}

if (!customElements.get('k-receipt-trend')) {
    customElements.define('k-receipt-trend', KReceiptTrend);
}

/**
 * Opens one chat's landed receipts as the trend popup. Resolves when it closes.
 * @param {any[]} receipts Landed receipts (any order; non-landed ones are ignored).
 * @param {Map<string, {name?: unknown}>} presetPrompts identifier → current-preset record.
 * @returns {Promise<void>}
 */
export async function openReceiptTrend(receipts, presetPrompts) {
    const trend = /** @type {KReceiptTrend} */ (document.createElement('k-receipt-trend'));
    trend.receipts = receipts;
    trend.presetPrompts = presetPrompts ?? new Map();
    await callGenericPopup(trend, POPUP_TYPE.DISPLAY, '', {
        wider: true,
        allowVerticalScrolling: true,
        leftAlign: true,
    });
}
