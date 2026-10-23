/**
 * `<k-vn-history>` — the theatre's History chip (docs/vn-theatre-v0.md). In the Sprite look on a
 * phone the transcript shows only its latest line, as a textbox over the scene (css/sprites.css §9).
 * This chip, in the chat header beside the Background chip, lets the whole transcript back out
 * (`body[data-k-vn-history]`) and back in. Sending a message, changing chats or leaving the theatre
 * returns to the scene: the theatre is where a story is read, History is where it is looked back on.
 *
 * Light DOM; it wears the Background chip's rules (`.k-bd__chip`, sprites.css §8). It hides itself
 * (`hidden`) outside the theatre, so the header never needs to know which look is on.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { VARIANT_AXIS_EVENT } from '../../scripts/message-rows.js';
import { THEATRE_QUERY, theatreActive } from './k-sprite-stage.js';

/** The body attribute that lets the transcript out of the theatre. */
const HISTORY_ATTR = 'kVnHistory';

/** A page of lines with a back-arrow: the story so far. Stroke glyph, no icon set (repo CLAUDE.md). */
const historyIcon = html`<svg class="k-bd__icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>`;
const sceneIcon = html`<svg class="k-bd__icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.8-2.6 2.6-4 4.5-4s3.7 1.4 4.5 4"/></svg>`;

/** @returns {boolean} */
function historyOpen() {
    return HISTORY_ATTR in document.body.dataset;
}

/** @param {boolean} open */
function setHistory(open) {
    if (open) document.body.dataset[HISTORY_ATTR] = '';
    else delete document.body.dataset[HISTORY_ATTR];
}

export class KVnHistory extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _open: { state: true },
    };

    #media = window.matchMedia(THEATRE_QUERY);
    #sync = () => {
        const shown = theatreActive();
        this.hidden = !shown;
        if (!shown) setHistory(false);
        this._open = historyOpen();
    };
    #backToScene = () => {
        setHistory(false);
        this._open = false;
    };

    constructor() {
        super();
        /** @type {string} SPEC §13: every component ships a variant. */
        this.variant = 'chip';
        this._open = false;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        document.addEventListener(VARIANT_AXIS_EVENT, this.#sync);
        this.#media.addEventListener('change', this.#sync);
        eventSource.on(event_types.MESSAGE_SENT, this.#backToScene);
        eventSource.on(event_types.CHAT_CHANGED, this.#backToScene);
        this.#sync();
    }

    disconnectedCallback() {
        document.removeEventListener(VARIANT_AXIS_EVENT, this.#sync);
        this.#media.removeEventListener('change', this.#sync);
        eventSource.removeListener(event_types.MESSAGE_SENT, this.#backToScene);
        eventSource.removeListener(event_types.CHAT_CHANGED, this.#backToScene);
        super.disconnectedCallback();
    }

    #toggle() {
        setHistory(!historyOpen());
        this._open = historyOpen();
        // Opening History lands on the latest line, where the reader just was; the rest is above it.
        if (this._open) requestAnimationFrame(() => document.querySelector('#chat .last_mes')?.scrollIntoView({ block: 'end' }));
    }

    render() {
        if (this.hidden) return nothing;
        return html`
            <button type="button" class="k-bd__chip" aria-pressed=${this._open ? 'true' : 'false'}
                title=${this._open ? 'Back to the scene' : 'The story so far'} aria-label=${this._open ? 'Back to the scene' : 'History'}
                @click=${() => this.#toggle()}>${this._open ? sceneIcon : historyIcon}<span>${this._open ? 'Scene' : 'History'}</span></button>`;
    }
}

if (!customElements.get('k-vn-history')) {
    customElements.define('k-vn-history', KVnHistory);
}
