/**
 * `<k-market variant="browse">` — Browse Characters (`docs/character-marketplace-v0.md` §9).
 *
 * Lives inside `<k-library>` as its second view: the same search box, the same grid, the same
 * poster card, fed from a card site instead of the library. It is not a new screen language,
 * so it borrows the gallery's `.k-lib-*` rules and adds only what is its own
 * (`public/css/market.css`).
 *
 * What this file is responsible for:
 *
 * - **Nothing is asked of a card site until the reader has agreed to it.** The source list
 *   comes from our own server. For an 18+ site, one line says so, with a link to its terms; a
 *   search goes out only after that is acknowledged, once, per source.
 * - **Every state has words.** Loading, nothing found, and each failure the server or the
 *   store can name are drawn in the grid's place with the copy from `view-model.js`. A site
 *   that is down is a sentence here and cannot touch the library.
 * - **Card-site text is untrusted.** Everything is bound as text. Nothing becomes HTML.
 *
 * A card's click raises `k-market-open` (cancelable) and then opens the preview sheet
 * (`k-market-preview.js`), unless a listener cancelled the event to handle the card itself.
 *
 * Light DOM, `variant` attribute from day one (SPEC §13). The module is imported the first
 * time the library switches to this view, never before.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters, getRequestHeaders } from '../../script.js';
import { accountStorage } from '../../scripts/util/AccountStorage.js';
import { createMarketStore } from './store.js';
import { appendRows, buildInstalledIndex, compactCount, countCopy, emptyCopy, errorCopy, nsfwNotice } from './view-model.js';
import { MARKET_HOME_EVENT, MARKET_IMPORTED_EVENT } from './k-market-preview.js';
import { SHOW_VIEW_EVENT } from '../library/k-library.js';
import { blurEnabled, MARKET_NSFW_SETTING, MARKET_SETTINGS_EVENT, nsfwEnabled, setNsfw } from './settings.js';

/** Raised on the element when a card is chosen. `detail.row` is the {@link MarketRow}. */
export const MARKET_OPEN_EVENT = 'k-market-open';

/** `accountStorage` key prefix for the one-time 18+ acknowledgement; one key per source. */
const AGE_ACK_PREFIX = 'kotatsu_market_age_ack.';

/** Pause after the last keystroke before a search goes out. Enter sends at once. */
const SEARCH_DEBOUNCE_MS = 350;

/** How far below the fold the next page starts loading. */
const SENTINEL_MARGIN = '600px';

/**
 * Card size, as the token counts the site reports. Bounds are whole tokens.
 * @type {{ id: string, label: string, filters: { minTokens?: number, maxTokens?: number } }[]}
 */
const SIZE_OPTIONS = [
    { id: 'any', label: 'Any size', filters: {} },
    { id: 'small', label: 'Under 1,000 tokens', filters: { maxTokens: 999 } },
    { id: 'medium', label: '1,000 to 3,000 tokens', filters: { minTokens: 1000, maxTokens: 3000 } },
    { id: 'large', label: 'Over 3,000 tokens', filters: { minTokens: 3001 } },
];

/**
 * The yes/no filters, in the order they are drawn.
 * @type {{ key: 'hasAlternateGreetings'|'hasLorebook'|'hasExamples', label: string }[]}
 */
const TOGGLES = [
    { key: 'hasAlternateGreetings', label: 'Alternate greetings' },
    { key: 'hasLorebook', label: 'Lorebook' },
    { key: 'hasExamples', label: 'Example dialogue' },
];

/**
 * @typedef {import('./view-model.js').MarketRow} MarketRow
 * @typedef {import('./view-model.js').CardSummary} CardSummary
 * @typedef {import('./view-model.js').MarketErrorBody} MarketErrorBody
 * @typedef {import('./store.js').MarketSourceInfo} MarketSourceInfo
 */

/** Stroke-only icons, like the gallery's. No glyph fonts, no emoji (repo CLAUDE.md). */
const icons = {
    search: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.25"></circle><path d="M10.2 10.2 13.5 13.5"></path>
        </svg>`,
    out: html`
        <svg class="k-lib-icon k-lib-icon--arrow" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M5 11 11 5"></path><path d="M6 5h5v5"></path>
        </svg>`,
    check: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5"></path>
        </svg>`,
};

export class KMarket extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `browse` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** Anything that changes when the library does; a new value re-reads what is installed. */
        revision: { attribute: false },
        /** Reflected for the probe and the sheet: gate, sources, loading, ready, empty, error. */
        phase: { type: String, reflect: true },
        _source: { state: true },
        _q: { state: true },
        _sort: { state: true },
        _size: { state: true },
        _toggles: { state: true },
        _rows: { state: true },
        _total: { state: true },
        _ceiling: { state: true },
        _nsfwServed: { state: true },
        _next: { state: true },
        _error: { state: true },
        _more: { state: true },
        _broken: { state: true },
    };

    #store = createMarketStore({ getHeaders: getRequestHeaders });

    /** @type {CardSummary[]} Every summary on screen, so rows can be rebuilt when the library changes. */
    #items = [];

    /** @type {number} `setTimeout` handle for the debounced search, 0 = idle. */
    #searchTimer = 0;

    /** @type {IntersectionObserver|null} */
    #observer = null;

    /**
     * The preview sheet, mounted on `document.body` and not inside this element: the gallery's
     * sheet is a stacking context, and a fixed overlay rendered inside it would sit under the
     * top bar (measured by the probe: the scrim could not be clicked at the top of the page).
     * The card studio mounts the same way, for the same reason.
     * @type {import('./k-market-preview.js').KMarketPreview|null}
     */
    #preview = null;

    /** @type {(() => void)|null} */
    #onImportedBound = null;

    /** @type {(() => void)|null} */
    #onHomeBound = null;

    /** @type {((event: Event) => void)|null} */
    #onSettingsBound = null;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'browse';
        /** @type {unknown} */
        this.revision = undefined;
        /** @type {'sources'|'gate'|'loading'|'ready'|'empty'|'error'} */
        this.phase = 'sources';
        /** @type {MarketSourceInfo|null} */
        this._source = null;
        /** @type {string} */
        this._q = '';
        /** @type {string} */
        this._sort = '';
        /** @type {string} */
        this._size = 'any';
        /** @type {Set<string>} */
        this._toggles = new Set();
        /** @type {MarketRow[]} */
        this._rows = [];
        /** @type {number} */
        this._total = 0;
        /** @type {boolean} The total is the site's cap, not a count. */
        this._ceiling = false;
        /** @type {boolean|null} For a search that asked for NSFW: whether the site serves any here. */
        this._nsfwServed = null;
        /** @type {string|null} */
        this._next = null;
        /** @type {{ error: MarketErrorBody, context: 'search'|'more' }|null} */
        this._error = null;
        /** @type {boolean} Whether the next page is being fetched. */
        this._more = false;
        /** @type {Set<string>} Row keys whose portrait failed to load. */
        this._broken = new Set();
    }

    /** Light DOM: `public/css/library.css` and `public/css/market.css` own every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        const preview = /** @type {import('./k-market-preview.js').KMarketPreview} */ (document.createElement('k-market-preview'));
        preview.setAttribute('variant', 'sheet');
        preview.store = this.#store;
        this.#onImportedBound = () => this.#onImported();
        preview.addEventListener(MARKET_IMPORTED_EVENT, this.#onImportedBound);
        // "Back to your cast" from the sheet: the sheet is a body child, so the request is
        // re-raised from here, where it bubbles to the gallery that owns the views.
        this.#onHomeBound = () => this.dispatchEvent(new CustomEvent(SHOW_VIEW_EVENT, { detail: { view: 'cast', top: true }, bubbles: true, composed: true }));
        preview.addEventListener(MARKET_HOME_EVENT, this.#onHomeBound);
        document.body.appendChild(preview);
        this.#preview = preview;
        // The two settings can change from the settings modal while this view is open: NSFW
        // changes the question, blur only the drawing.
        this.#onSettingsBound = (event) => this.#onSettings(event);
        document.addEventListener(MARKET_SETTINGS_EVENT, this.#onSettingsBound);
        void this.#begin();
    }

    disconnectedCallback() {
        if (this.#searchTimer !== 0) {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = 0;
        }
        this.#observer?.disconnect();
        this.#observer = null;
        if (this.#onSettingsBound) {
            document.removeEventListener(MARKET_SETTINGS_EVENT, this.#onSettingsBound);
            this.#onSettingsBound = null;
        }
        if (this.#preview) {
            if (this.#onImportedBound) this.#preview.removeEventListener(MARKET_IMPORTED_EVENT, this.#onImportedBound);
            if (this.#onHomeBound) this.#preview.removeEventListener(MARKET_HOME_EVENT, this.#onHomeBound);
            this.#preview.remove();
            this.#preview = null;
            this.#onImportedBound = null;
            this.#onHomeBound = null;
        }
        // A result that lands after the view closed must not repaint a detached element's state.
        this.#store.reset();
        super.disconnectedCallback();
    }

    /**
     * @param {Map<string, unknown>} changed Changed properties.
     * @returns {void}
     */
    willUpdate(changed) {
        if (changed.has('revision') && this.#items.length > 0) {
            this.#rebuildRows();
        }
    }

    updated() {
        this.#watchSentinel();
    }

    /** What the probe reads. @returns {object} A plain snapshot. */
    get state() {
        return {
            phase: this.phase,
            source: this._source?.id ?? null,
            q: this._q,
            sort: this._sort,
            rows: this._rows.length,
            installed: this._rows.filter(row => row.installed).length,
            blurred: this._rows.filter(row => row.blur).length,
            flagged: this._rows.filter(row => row.nsfwImage).length,
            total: this._total,
            ceiling: this._ceiling,
            nsfw: nsfwEnabled(),
            nsfwServed: this._nsfwServed,
            blurNsfw: blurEnabled(),
            next: this._next,
            error: this._error?.error.kind ?? null,
        };
    }

    /** @returns {import('./view-model.js').RowOptions} The reader's settings, read fresh. */
    #rowOptions() {
        return { blurNsfw: blurEnabled() };
    }

    /** Redraws the rows on screen from the summaries held, re-reading the library and the settings. @returns {void} */
    #rebuildRows() {
        this._rows = appendRows([], this.#items, buildInstalledIndex(characters), this.#rowOptions());
    }

    /**
     * A Browse Characters setting changed, from the modal or from the switch here.
     * @param {Event} event The settings event; `detail.key` names the key.
     * @returns {void}
     */
    #onSettings(event) {
        const key = /** @type {CustomEvent<{ key: string }>} */ (event).detail?.key;
        if (key === MARKET_NSFW_SETTING) {
            // A different question for the site. The answer carries whether it serves NSFW here.
            if (this.phase !== 'gate' && this.phase !== 'sources') void this.#search();
            else this.requestUpdate();
        } else {
            this.#rebuildRows();
        }
    }

    /* ── asking ─────────────────────────────────────────────────────────── */

    /** Reads the sources from our own server, then gates or searches. @returns {Promise<void>} */
    async #begin() {
        this.phase = 'sources';
        this._error = null;
        const answer = await this.#store.sources();
        if (!this.isConnected) return;
        if (answer.status !== 'ok') {
            this.#fail(answer.status === 'error' ? answer.error : { kind: 'local' }, 'search');
            return;
        }
        const source = answer.data.enabled ? answer.data.sources[0] : undefined;
        if (!source) {
            this.#fail({ kind: 'disabled' }, 'search');
            return;
        }
        this._source = source;
        this._sort = source.sorts[0]?.id ?? '';
        if (source.adult && accountStorage.getItem(AGE_ACK_PREFIX + source.id) !== '1') {
            this.phase = 'gate';
            return;
        }
        void this.#search();
    }

    /** The reader has said they are an adult and accept the site's terms. @returns {void} */
    #acknowledge() {
        if (!this._source) return;
        accountStorage.setItem(AGE_ACK_PREFIX + this._source.id, '1');
        void this.#search();
    }

    /** @returns {Record<string, unknown>} The filters as the server's interface names them. */
    #filters() {
        /** @type {Record<string, unknown>} */
        const filters = { ...(SIZE_OPTIONS.find(option => option.id === this._size)?.filters ?? {}) };
        for (const key of this._toggles) filters[key] = true;
        // The NSFW switch is a setting, not a chip: it is remembered, and it is only sent when
        // the source honours it (the server would drop it anyway; this keeps the wire honest).
        if (nsfwEnabled() && this._source?.filters.includes('nsfw')) filters.nsfw = true;
        return filters;
    }

    /**
     * Runs the current query from its first page.
     * @returns {Promise<void>}
     */
    async #search() {
        if (!this._source) return;
        if (this.#searchTimer !== 0) {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = 0;
        }
        this.phase = 'loading';
        this._error = null;
        this._more = false;
        const answer = await this.#store.search({ source: this._source.id, q: this._q, sort: this._sort, filters: this.#filters() });
        if (!this.isConnected || answer.status === 'stale') return;
        if (answer.status === 'error') {
            this.#fail(answer.error, 'search');
            return;
        }
        this.#items = answer.data.items;
        this.#rebuildRows();
        this._total = answer.data.total;
        this._ceiling = answer.data.ceiling === true;
        this._nsfwServed = typeof answer.data.nsfwServed === 'boolean' ? answer.data.nsfwServed : null;
        this._next = answer.data.next;
        this.phase = this._rows.length > 0 ? 'ready' : 'empty';
    }

    /**
     * Appends the next page of the current query.
     * @returns {Promise<void>}
     */
    async #loadMore() {
        if (!this._source || !this._next || this._more || this.phase !== 'ready') return;
        this._more = true;
        this._error = null;
        const answer = await this.#store.search({ source: this._source.id, q: this._q, sort: this._sort, filters: this.#filters(), next: this._next });
        if (!this.isConnected || answer.status === 'stale') return;
        this._more = false;
        if (answer.status === 'error') {
            // The rows already on screen stay. Only the tail says something went wrong.
            this._error = { error: answer.error, context: 'more' };
            return;
        }
        const before = this._rows.length;
        this.#items = [...this.#items, ...answer.data.items];
        this._rows = appendRows(this._rows, answer.data.items, buildInstalledIndex(characters), this.#rowOptions());
        this._total = answer.data.total;
        this._ceiling = answer.data.ceiling === true;
        // A page that adds nothing new ends the list. Without this, a site that keeps handing
        // back rows already on screen would keep the tail in view and the requests coming.
        this._next = this._rows.length > before ? answer.data.next : null;
    }

    /**
     * @param {MarketErrorBody} error What went wrong.
     * @param {'search'|'more'} context Where.
     * @returns {void}
     */
    #fail(error, context) {
        this._error = { error, context };
        this._rows = [];
        this.#items = [];
        this._next = null;
        this.phase = 'error';
    }

    /** Starts over from wherever it failed. @returns {void} */
    #retry() {
        if (!this._source) {
            void this.#begin();
        } else if (this._error?.context === 'more') {
            void this.#loadMore();
        } else {
            void this.#search();
        }
    }

    /** Observes the tail so the next page loads as it nears the fold. @returns {void} */
    #watchSentinel() {
        const sentinel = this.querySelector('.k-mkt-sentinel');
        this.#observer?.disconnect();
        if (!sentinel || typeof IntersectionObserver !== 'function') return;
        this.#observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) void this.#loadMore();
        }, { root: this.closest('.k-lib-sheet'), rootMargin: SENTINEL_MARGIN });
        this.#observer.observe(sentinel);
    }

    /* ── input ──────────────────────────────────────────────────────────── */

    /**
     * @param {Event} event Input event from the search box.
     * @returns {void}
     */
    #onSearchInput(event) {
        if (!(event.target instanceof HTMLInputElement)) return;
        this._q = event.target.value;
        if (this.#searchTimer !== 0) clearTimeout(this.#searchTimer);
        this.#searchTimer = window.setTimeout(() => { void this.#search(); }, SEARCH_DEBOUNCE_MS);
    }

    /**
     * @param {KeyboardEvent} event Keydown in the search box.
     * @returns {void}
     */
    #onSearchKey(event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void this.#search();
    }

    /**
     * @param {Event} event Change event from the sort select.
     * @returns {void}
     */
    #onSortChange(event) {
        if (!(event.target instanceof HTMLSelectElement)) return;
        this._sort = event.target.value;
        void this.#search();
    }

    /**
     * @param {Event} event Change event from the size select.
     * @returns {void}
     */
    #onSizeChange(event) {
        if (!(event.target instanceof HTMLSelectElement)) return;
        this._size = event.target.value;
        void this.#search();
    }

    /**
     * @param {string} key A toggle filter key.
     * @returns {void}
     */
    #onToggle(key) {
        const next = new Set(this._toggles);
        if (next.has(key)) next.delete(key); else next.add(key);
        this._toggles = next;
        void this.#search();
    }

    /**
     * @param {MarketRow} row The chosen card.
     * @returns {void}
     */
    #onOpen(row) {
        const event = new CustomEvent(MARKET_OPEN_EVENT, { detail: { row }, bubbles: true, composed: true, cancelable: true });
        if (!this.dispatchEvent(event)) return;
        if (this.#preview) {
            this.#preview.label = this._source?.label ?? 'the site';
            void this.#preview.openCard(row);
        } else {
            // No sheet to show: the honest fallback is the card's own page.
            window.open(row.pageUrl, '_blank', 'noopener,noreferrer');
        }
    }

    /**
     * A card landed through the preview: re-read which rows are installed.
     * @returns {void}
     */
    #onImported() {
        this.revision = {};
    }

    /**
     * @param {MarketRow} row The row whose portrait failed.
     * @returns {void}
     */
    #onPortraitError(row) {
        if (this._broken.has(row.key)) return;
        this._broken = new Set(this._broken).add(row.key);
    }

    /* ── render ─────────────────────────────────────────────────────────── */

    render() {
        const label = this._source?.label ?? 'the site';
        if (this.phase === 'sources') {
            return html`<p class="k-lib-quiet">Opening the door…</p>`;
        }
        if (this.phase === 'gate' && this._source) {
            return this.#renderGate(this._source);
        }
        if (this.phase === 'error' && !this._source) {
            return this.#renderError(label);
        }
        return html`
            ${this.#renderTools(label)}
            ${this.#renderNote()}
            ${this.#renderBody(label)}`;
    }

    /**
     * @param {MarketSourceInfo} source The 18+ source.
     * @returns {unknown} The one-time line, in the grid's place.
     */
    #renderGate(source) {
        return html`
            <div class="k-lib-empty k-mkt-gate">
                <p class="k-lib-empty-title">${source.label} is an 18+ site.</p>
                <p class="k-lib-empty-sub">
                    Browse Characters shows cards from ${source.label}. Going on means you are 18 or older and accept
                    <a class="k-mkt-link" href=${source.terms} target="_blank" rel="noopener noreferrer">its terms</a>.
                    Kotatsu will not ask again.
                </p>
                <div class="k-lib-empty-actions">
                    <button type="button" class="k-lib-btn k-lib-btn--primary k-mkt-gate-go"
                        @click=${() => this.#acknowledge()}><span>I am 18 or older. Browse ${source.label}</span></button>
                </div>
            </div>`;
    }

    /**
     * @param {string} label The source's display name.
     * @returns {unknown} Search box, sort, size and the yes/no filters.
     */
    #renderTools(label) {
        const sorts = this._source?.sorts ?? [];
        const honoured = this._source?.filters ?? [];
        const sizes = honoured.includes('minTokens') && honoured.includes('maxTokens');
        return html`
            <div class="k-lib-tools k-mkt-tools">
                <label class="k-lib-search">
                    ${icons.search}
                    <input
                        class="k-lib-search-input k-mkt-search-input"
                        type="search"
                        placeholder=${`Search ${label}…`}
                        aria-label=${`Search ${label}`}
                        .value=${this._q}
                        @input=${(/** @type {Event} */ event) => this.#onSearchInput(event)}
                        @keydown=${(/** @type {KeyboardEvent} */ event) => this.#onSearchKey(event)}
                    />
                </label>
                <select class="k-lib-sort k-mkt-sort" aria-label="Sort order" @change=${(/** @type {Event} */ event) => this.#onSortChange(event)}>
                    ${sorts.map(option => html`<option value=${option.id} .selected=${option.id === this._sort}>${option.label}</option>`)}
                </select>
                ${sizes ? html`
                    <select class="k-lib-sort k-mkt-size" aria-label="Card size" @change=${(/** @type {Event} */ event) => this.#onSizeChange(event)}>
                        ${SIZE_OPTIONS.map(option => html`<option value=${option.id} .selected=${option.id === this._size}>${option.label}</option>`)}
                    </select>` : nothing}
                <div class="k-mkt-chips" role="group" aria-label="Must have">
                    ${TOGGLES.filter(toggle => honoured.includes(toggle.key)).map(toggle => html`
                        <button
                            type="button"
                            class="k-mkt-chip${this._toggles.has(toggle.key) ? ' is-on' : ''}"
                            aria-pressed=${this._toggles.has(toggle.key) ? 'true' : 'false'}
                            @click=${() => this.#onToggle(toggle.key)}
                        >${toggle.label}</button>`)}
                </div>
                ${honoured.includes('nsfw') ? html`
                    <label class="k-mkt-switch" title="Ask ${label} for its NSFW cards too. Remembered in Settings.">
                        <input type="checkbox" class="k-mkt-nsfw" .checked=${nsfwEnabled()}
                            @input=${(/** @type {Event} */ event) => setNsfw(/** @type {HTMLInputElement} */ (event.target).checked)} />
                        <span>Include NSFW</span>
                    </label>` : nothing}
            </div>`;
    }

    /**
     * One quiet line: how many. A site's count can be a cap (`countCopy` says "over"). The only
     * reason ever printed under it is a measured one: when NSFW is on and the site answered
     * that it serves none to this location (doc §13). Anything else would be a guess.
     * @returns {unknown} The count line, and the sentence when there is one.
     */
    #renderNote() {
        if ((this.phase !== 'ready' && this.phase !== 'empty') || !this._source) return nothing;
        const label = this._source.label;
        const notice = nsfwNotice({ nsfwOn: nsfwEnabled(), nsfwServed: this._nsfwServed, label });
        const count = this.phase === 'ready' ? countCopy(this._total, this._ceiling) : '';
        if (!count && !notice) return nothing;
        return html`
            ${count ? html`<p class="k-mkt-note"><span class="k-mkt-note-count">${count}</span></p>` : nothing}
            ${notice ? html`
                <p class="k-mkt-nsfw-notice" role="status">
                    <span>${notice}</span>
                    <a class="k-mkt-link" href=${this._source.home} target="_blank" rel="noopener noreferrer">Open ${label}${icons.out}</a>
                </p>` : nothing}`;
    }

    /**
     * @param {string} label The source's display name.
     * @returns {unknown} The grid, or the words for the state it is in.
     */
    #renderBody(label) {
        if (this.phase === 'loading') {
            return html`<p class="k-lib-quiet">Asking ${label}…</p>`;
        }
        if (this.phase === 'error') {
            return this.#renderError(label);
        }
        if (this.phase === 'empty') {
            const copy = emptyCopy({ label, filtered: this._size !== 'any' || this._toggles.size > 0 });
            return html`
                <div class="k-lib-empty k-mkt-empty">
                    <p class="k-lib-empty-title">${copy.title}</p>
                    <p class="k-lib-empty-sub">${copy.body}</p>
                </div>`;
        }
        return html`
            <div class="k-lib-grid k-mkt-grid">
                ${this._rows.map(row => this.#renderCard(row, label))}
            </div>
            ${this.#renderTail(label)}`;
    }

    /**
     * @param {string} label The source's display name.
     * @returns {unknown} The words for a failure, with the one action that helps.
     */
    #renderError(label) {
        if (!this._error) return nothing;
        const copy = errorCopy(this._error.error, { label, context: 'search' });
        const action = copy.action === 'retry'
            ? html`<button type="button" class="k-lib-btn k-lib-btn--ghost k-mkt-retry" @click=${() => this.#retry()}><span>Try again</span></button>`
            : copy.action === 'site' && this._source
                ? html`<a class="k-lib-btn k-lib-btn--ghost" href=${this._source.home} target="_blank" rel="noopener noreferrer"><span>Open ${label}</span>${icons.out}</a>`
                : nothing;
        return html`
            <div class="k-lib-empty k-mkt-error" data-kind=${this._error.error.kind} role="status">
                <p class="k-lib-empty-title">${copy.title}</p>
                <p class="k-lib-empty-sub">${copy.body}</p>
                ${action === nothing ? nothing : html`<div class="k-lib-empty-actions">${action}</div>`}
            </div>`;
    }

    /**
     * @param {string} label The source's display name.
     * @returns {unknown} What follows the grid: the next page's trigger, its progress, or its failure.
     */
    #renderTail(label) {
        if (this._error?.context === 'more') {
            const copy = errorCopy(this._error.error, { label, context: 'search' });
            return html`
                <div class="k-mkt-tail k-mkt-tail--error" data-kind=${this._error.error.kind} role="status">
                    <span>${copy.title} ${copy.body}</span>
                    <button type="button" class="k-lib-btn k-lib-btn--ghost k-mkt-retry" @click=${() => this.#retry()}><span>Try again</span></button>
                </div>`;
        }
        if (this._more) {
            return html`<p class="k-lib-quiet k-mkt-tail">Asking ${label} for more…</p>`;
        }
        if (this._next) {
            // A real button as well as the observer: the keyboard reaches it, and it still
            // works where IntersectionObserver does not exist.
            return html`
                <div class="k-mkt-tail k-mkt-sentinel">
                    <button type="button" class="k-lib-btn k-lib-btn--ghost k-mkt-more" @click=${() => { void this.#loadMore(); }}><span>More characters</span></button>
                </div>`;
        }
        return nothing;
    }

    /**
     * The library's poster, fed from a card site. Same classes, so a theme pack that restyles
     * the gallery restyles this with it.
     * @param {MarketRow} row The row to draw.
     * @param {string} label The source's display name.
     * @returns {unknown} A Lit template.
     */
    #renderCard(row, label) {
        /** @param {KeyboardEvent} event */
        const cardKey = (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this.#onOpen(row);
        };
        const art = row.portrait && !this._broken.has(row.key)
            ? html`<img class="k-lib-card-portrait" src=${row.portrait} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error=${() => this.#onPortraitError(row)} />`
            : html`<div class="k-lib-card-initials" aria-hidden="true">${row.initials}</div>`;
        const owned = row.installed
            ? html`<span class="k-mkt-card-owned" title="Already in your library">${icons.check}<span>In your library</span></span>`
            : nothing;
        const tagList = row.tags.length
            ? html`<ul class="k-lib-card-tags">${row.tags.map(tag => html`<li class="k-lib-card-tag">${tag}</li>`)}</ul>`
            : nothing;
        const tokens = row.tokens !== null
            ? html`<span class="k-lib-card-count">${compactCount(row.tokens)} tokens</span>`
            : nothing;
        return html`
            <article
                class="k-lib-card k-mkt-card${row.blur ? ' k-mkt-card--blur' : ''}${row.installed ? ' k-mkt-card--owned' : ''}"
                style=${`--card-accent: hsl(${row.hue} var(--k-lib-accent-s) var(--k-lib-accent-l));`}
                data-key=${row.key}
                role="button"
                tabindex="0"
                aria-label=${`${row.name}, on ${label}`}
                @click=${() => this.#onOpen(row)}
                @keydown=${cardKey}
            >
                <div class="k-lib-card-art">
                    ${art}
                    <div class="k-lib-card-scrim" aria-hidden="true"></div>
                </div>
                <div class="k-lib-card-chrome k-mkt-card-chrome">${owned}</div>
                <div class="k-lib-card-copy">
                    ${row.kicker ? html`<span class="k-lib-card-kicker">${row.kicker}</span>` : nothing}
                    <h3 class="k-lib-card-name">${row.name}</h3>
                    <p class="k-lib-card-body">${row.body}</p>
                    ${tagList}
                    <div class="k-lib-card-foot">
                        <span class="k-lib-card-stat">${tokens}</span>
                        <span class="k-lib-card-open">Read the card${icons.out}</span>
                    </div>
                </div>
            </article>`;
    }
}

if (!customElements.get('k-market')) {
    customElements.define('k-market', KMarket);
}
