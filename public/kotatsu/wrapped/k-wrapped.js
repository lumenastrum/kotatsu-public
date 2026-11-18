/**
 * `<k-wrapped variant="sheet">` — Kotatsu Wrapped (docs/wrapped/README.md): your day, week or
 * month under the blanket as cards you can save and post.
 *
 * One card on screen at a time, beside the "what's on the card" step: card names can be
 * hidden or renamed and the latest-night line dropped BEFORE the picture is saved, because the
 * picture is the whole point and it is going somewhere public. The preview is the canvas that
 * gets saved (`draw.js`), so what you see is what you post.
 *
 * Numbers come fresh from `POST /api/kotatsu/wrapped/stats` each time the window changes: read
 * from the reader's own chat files, never stored, never sent anywhere else. The choices made
 * here live for as long as the sheet is open and are written nowhere.
 *
 * Light DOM, rails only, opened by `OPEN_WRAPPED_EVENT` (the library's Wrapped button).
 */

import { getRequestHeaders } from '../../script.js';
import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { OPEN_WRAPPED_EVENT } from './doors.js';
import { CARD_SIZES, ensureFonts, loadArt, paintCard, readTheme } from './draw.js';
import { SPANS, buildCards, describeCards, describeWindow } from './model.js';

const STATS_URL = '/api/kotatsu/wrapped/stats';
/** One rung under What's New (4070): a release note may sit over it, never the other way. */
export const WRAPPED_Z = Object.freeze({ scrim: 4060, sheet: 4061 });

const KINDS = /** @type {const} */ ([
    { id: 'story', label: 'Wrapped' },
    { id: 'nights', label: 'Calendar' },
    { id: 'report', label: 'Report card' },
    { id: 'faceoff', label: 'Face-off' },
    { id: 'phrases', label: 'Phrases' },
]);
const SPAN_LABELS = { day: 'Day', week: 'Week', month: 'Month' };

const stroke = (path, size = 16) => html`
    <svg viewBox="0 0 16 16" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
const icons = {
    close: stroke(svg`<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>`),
    prev: stroke(svg`<path d="M10 3.5 5.5 8l4.5 4.5"/>`),
    next: stroke(svg`<path d="M6 3.5 10.5 8 6 12.5"/>`),
    save: stroke(svg`<path d="M8 2.5v8"/><path d="M4.75 7.5 8 10.75 11.25 7.5"/><path d="M3 13.5h10"/>`),
    copy: stroke(svg`<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5h-1v-8h8v1"/>`),
};

/** @returns {boolean} */
function railsActive() {
    return document.body.dataset.kLayout === 'rails';
}

export class KWrapped extends LitElement {
    static properties = {
        _span: { state: true },
        _step: { state: true },
        _kind: { state: true },
        _stats: { state: true },
        _status: { state: true },
        _showNames: { state: true },
        _showNight: { state: true },
        _showArt: { state: true },
        _art: { state: true },
        _nicknames: { state: true },
        _said: { state: true },
    };

    constructor() {
        super();
        /** @type {import('./model.js').Span} */
        this._span = 'week';
        this._step = 0;
        /** @type {'story'|'nights'|'report'|'faceoff'|'phrases'} */
        this._kind = 'story';
        /** @type {any} */
        this._stats = null;
        /** @type {'loading'|'ready'|'error'} */
        this._status = 'loading';
        this._showNames = true;
        this._showNight = true;
        this._showArt = true;
        /** @type {import('./draw.js').CardArt|null} Mikan-chan's pictures, once they have loaded. */
        this._art = null;
        /** @type {Record<string, string>} */
        this._nicknames = {};
        /** The last thing a button did, said out loud ("Saved", "Copied"). */
        this._said = '';
        this._request = 0;
        this._fontsReady = false;
        this._onKeydown = (/** @type {KeyboardEvent} */ event) => this.#handleKeydown(event);
        /** @type {Element|null} */
        this._returnFocus = null;
        /** @type {MutationObserver|null} */
        this._lookWatch = null;
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        this._lookTimer = undefined;
        /** @type {(() => void)|null} */
        this._onLook = null;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        this._returnFocus = document.activeElement;
        document.addEventListener('keydown', this._onKeydown, true);
        // The card wears the pack that is on, so it is painted again whenever the page's look
        // changes under it: a pack applied (tokens land as attributes and style elements), or
        // one of its faces finishing its download after the first paint.
        this._onLook = () => {
            clearTimeout(this._lookTimer);
            this._lookTimer = setTimeout(() => this.requestUpdate(), 120);
        };
        this._lookWatch = new MutationObserver(this._onLook);
        for (const node of [document.documentElement, document.body]) this._lookWatch.observe(node, { attributes: true });
        this._lookWatch.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
        document.fonts?.addEventListener?.('loadingdone', this._onLook);
        // The pack's own faces: ask for them once, then paint again in them.
        void ensureFonts(readTheme()).then(() => { this._fontsReady = true; this.requestUpdate(); });
        void loadArt().then((art) => { this._art = art; });
        void this.#load();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener('keydown', this._onKeydown, true);
        this._lookWatch?.disconnect();
        clearTimeout(this._lookTimer);
        if (this._onLook) document.fonts?.removeEventListener?.('loadingdone', this._onLook);
        if (this._returnFocus instanceof HTMLElement && this._returnFocus.isConnected) this._returnFocus.focus();
    }

    firstUpdated() {
        /** @type {HTMLElement|null} */ (this.querySelector('.k-wr-close'))?.focus();
    }

    /** The window on screen, in the reader's own zone. */
    get #window() {
        return describeWindow(this._span, Date.now(), new Date().getTimezoneOffset(), this._step);
    }

    get #view() {
        return buildCards(this._stats, this.#window, { showNames: this._showNames, nicknames: this._nicknames, showNight: this._showNight });
    }

    /**
     * The card on screen. A window with no model in it has no report card to show, so the
     * chosen card falls back to the first one rather than to an empty frame.
     * @returns {'story'|'nights'|'report'|'faceoff'|'phrases'}
     */
    get #kind() {
        const view = this.#view;
        return this._kind !== 'story' && this._kind !== 'phrases' && !view[this._kind] ? 'story' : this._kind;
    }

    /** Asks the server for this window. A slower, older answer never overwrites a newer one. */
    async #load() {
        const ticket = ++this._request;
        const { from, to, previous } = this.#window;
        this._status = 'loading';
        try {
            const response = await fetch(STATS_URL, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ from, to, tzOffsetMin: new Date().getTimezoneOffset(), previous: { from: previous.from, to: previous.to } }),
            });
            if (!response.ok) throw new Error(`stats answered ${response.status}`);
            const stats = await response.json();
            if (ticket !== this._request) return;
            this._stats = stats;
            this._status = 'ready';
        } catch (error) {
            if (ticket !== this._request) return;
            console.warn('[wrapped] could not load the numbers', error);
            this._status = 'error';
        }
    }

    /** @param {import('./model.js').Span} span */
    #setSpan(span) {
        if (span === this._span) return;
        this._span = span;
        this._step = 0;
        void this.#load();
    }

    /** @param {number} delta +1 = further back. */
    #walk(delta) {
        const step = Math.max(0, this._step + delta);
        if (step === this._step) return;
        this._step = step;
        void this.#load();
    }

    #close() {
        this.remove();
    }

    /**
     * Escape closes; Tab stays inside the sheet.
     * @param {KeyboardEvent} event
     */
    #handleKeydown(event) {
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.#close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = /** @type {HTMLElement[]} */ ([...this.querySelectorAll('.k-wr-sheet :is(button, input):not([disabled])')]);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && this.contains(active);
        if (event.shiftKey && (active === first || !inside)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !inside)) {
            event.preventDefault();
            first.focus();
        }
    }

    /** @returns {HTMLCanvasElement|null} */
    get #canvas() {
        const canvas = this.querySelector('.k-wr-canvas');
        return canvas instanceof HTMLCanvasElement ? canvas : null;
    }

    /** @returns {Promise<Blob|null>} The card on screen, as a PNG. */
    #blob() {
        const canvas = this.#canvas;
        if (!canvas) return Promise.resolve(null);
        return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }

    get #fileName() {
        const when = this.#window.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return `kotatsu-wrapped-${this.#kind}-${when}.png`;
    }

    async #save() {
        const blob = await this.#blob();
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = this.#fileName;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        // In the Android app the click opens Android's own save screen, where the person picks the
        // folder or cancels; the app says "Saved" itself once the file is really written.
        this._said = /** @type {any} */ (window).KotatsuAndroid ? '' : 'Saved to your downloads.';
    }

    async #copy() {
        try {
            const blob = await this.#blob();
            if (!blob || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('no image clipboard here');
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            this._said = 'Copied. Paste it wherever you post.';
        } catch (error) {
            console.warn('[wrapped] could not copy the picture', error);
            this._said = 'The picture couldn’t be copied here. Save it instead.';
        }
    }

    /** Repaints the preview from the current view; the canvas is the picture that gets saved. */
    updated() {
        const canvas = this.#canvas;
        if (!canvas || this._status !== 'ready') return;
        // Read fresh each paint, so a card always wears the pack that is on right now.
        paintCard(this.#kind, this.#view, readTheme(), canvas, this._showArt ? this._art : null);
    }

    #renderChoices(view) {
        const cards = /** @type {any[]} */ (this._stats?.cards ?? []).slice(0, 3);
        const night = Boolean(this._stats?.latestNight);
        return html`
            <section class="k-wr-choices" aria-labelledby="k-wr-choices-title">
                <h3 id="k-wr-choices-title" class="k-wr-choices-title">What’s on the card</h3>
                <p class="k-wr-choices-sub">Check it before it goes anywhere. Nothing here is saved or sent; only the picture you save leaves this screen.</p>
                <label class="k-wr-check">
                    <input type="checkbox" id="k-wr-show-names" .checked=${this._showNames}
                        @change=${(/** @type {Event} */ e) => { this._showNames = /** @type {HTMLInputElement} */ (e.target).checked; }}>
                    <span>Show card names</span>
                </label>
                ${this._showNames && cards.length ? html`
                    <div class="k-wr-names">
                        <span class="k-wr-names-hint">Or print something else instead:</span>
                        ${cards.map((card, index) => html`
                            <label class="k-wr-name">
                                <span class="k-wr-name-rank">${index + 1}</span>
                                <input type="text" class="k-wr-name-input" maxlength="40" spellcheck="false"
                                    aria-label=${`What to print for ${card.name}`}
                                    placeholder=${card.name}
                                    .value=${this._nicknames[card.name] ?? ''}
                                    @input=${(/** @type {Event} */ e) => { this._nicknames = { ...this._nicknames, [card.name]: /** @type {HTMLInputElement} */ (e.target).value }; }}>
                            </label>`)}
                    </div>` : nothing}
                ${!this._showNames ? html`<p class="k-wr-note">Cards print as “Card 1”, “Card 2”, and so on.</p>` : nothing}
                ${night ? html`
                    <label class="k-wr-check">
                        <input type="checkbox" id="k-wr-show-night" .checked=${this._showNight}
                            @change=${(/** @type {Event} */ e) => { this._showNight = /** @type {HTMLInputElement} */ (e.target).checked; }}>
                        <span>Show my latest night</span>
                    </label>` : nothing}
                <label class="k-wr-check">
                    <input type="checkbox" id="k-wr-show-art" .checked=${this._showArt}
                        @change=${(/** @type {Event} */ e) => { this._showArt = /** @type {HTMLInputElement} */ (e.target).checked; }}>
                    <span>Mikan-chan on the card</span>
                </label>
                <div class="k-wr-actions">
                    <button type="button" class="k-wr-button" data-kind="primary" id="k-wr-save"
                        @click=${() => this.#save()}>${icons.save}<span>Save picture</span></button>
                    <button type="button" class="k-wr-button" data-kind="ghost" id="k-wr-copy"
                        @click=${() => this.#copy()}>${icons.copy}<span>Copy</span></button>
                </div>
                <p class="k-wr-said" role="status" aria-live="polite">${this._said}</p>
            </section>`;
    }

    render() {
        const window = this.#window;
        const view = this.#view;
        // A card is offered only when this window has something for it to say.
        const kinds = KINDS.filter((kind) => kind.id === 'story' || kind.id === 'phrases' || view[kind.id]);
        const kind = this.#kind;
        const size = CARD_SIZES[kind];
        return html`
            <div class="k-wr-scrim" @click=${() => this.#close()}></div>
            <section class="k-wr-sheet" role="dialog" aria-modal="true" aria-labelledby="k-wr-title">
                <header class="k-wr-head">
                    <div class="k-wr-heading">
                        <span class="k-wr-eyebrow">Kotatsu Wrapped</span>
                        <h2 id="k-wr-title" class="k-wr-title">${window.label}</h2>
                    </div>
                    <button type="button" class="k-wr-close" aria-label="Close" title="Close" @click=${() => this.#close()}>${icons.close}</button>
                </header>
                <div class="k-wr-bar">
                    <div class="k-wr-seg" role="group" aria-label="Time span">
                        ${SPANS.map((span) => html`
                            <button type="button" class="k-wr-seg-button" data-span=${span} aria-pressed=${String(span === this._span)}
                                @click=${() => this.#setSpan(span)}>${SPAN_LABELS[span]}</button>`)}
                    </div>
                    <div class="k-wr-walk">
                        <button type="button" class="k-wr-icon-button" id="k-wr-earlier" aria-label="Earlier" title="Earlier" @click=${() => this.#walk(1)}>${icons.prev}</button>
                        <button type="button" class="k-wr-icon-button" id="k-wr-later" aria-label="Later" title="Later" ?disabled=${this._step === 0} @click=${() => this.#walk(-1)}>${icons.next}</button>
                    </div>
                    <div class="k-wr-seg" role="group" aria-label="Which card">
                        ${kinds.map((k) => html`
                            <button type="button" class="k-wr-seg-button" data-card=${k.id} aria-pressed=${String(k.id === kind)}
                                @click=${() => { this._kind = k.id; this._said = ''; }}>${k.label}</button>`)}
                    </div>
                </div>
                <div class="k-wr-body" data-status=${this._status}>
                    <div class="k-wr-stage" data-card=${kind}>
                        ${this._status === 'error' ? html`<p class="k-wr-message">Couldn’t read your chats just now. Close this and try again.</p>` : nothing}
                        ${this._status === 'loading' && !this._stats ? html`<p class="k-wr-message">Counting…</p>` : nothing}
                        ${this._stats && this._status !== 'error' ? html`
                            <canvas class="k-wr-canvas" width=${size.width} height=${size.height} role="img"
                                style=${`aspect-ratio: ${size.width} / ${size.height}`}
                                aria-label=${describeCards(view).join(' ')}></canvas>` : nothing}
                    </div>
                    ${this._stats && this._status !== 'error' ? this.#renderChoices(view) : nothing}
                </div>
            </section>`;
    }
}

customElements.define('k-wrapped', KWrapped);

/**
 * Opens the sheet (or keeps the open one). Rails only.
 * @returns {KWrapped|null}
 */
export function openWrapped() {
    if (!railsActive()) return null;
    const existing = document.querySelector('k-wrapped');
    if (existing instanceof KWrapped) return existing;
    const sheet = /** @type {KWrapped} */ (document.createElement('k-wrapped'));
    sheet.setAttribute('variant', 'sheet');
    document.body.appendChild(sheet);
    return sheet;
}

/**
 * Registration at the shell seam: answer the door. Console door: `window.kotatsu.wrapped`.
 * @returns {void}
 */
export function installWrapped() {
    window.addEventListener(OPEN_WRAPPED_EVENT, () => { openWrapped(); });
    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const target = window;
    if (!target.kotatsu || typeof target.kotatsu !== 'object') target.kotatsu = {};
    target.kotatsu.wrapped = { open: openWrapped };
}
