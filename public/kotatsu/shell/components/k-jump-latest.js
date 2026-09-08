/**
 * `<k-jump-latest>` — the rails reader's "back to latest" pill (reader-polish v0 finding 4).
 *
 * Deep in a long chat there was nothing that returned the reader to the composer, and nothing
 * that said a reply had landed while they were scrolled back; core has no such affordance
 * either. This is a small pill floating over the bottom of `#chat`, centred on the reading
 * column, that appears once the reader is more than a screen above the bottom and carries a
 * count of the messages that arrived while they were away. Activating it (it is a `<button>`,
 * so click, Enter and Space all work) scrolls `#chat` to the bottom and clears the count.
 *
 * Mounted by `layouts/rails.js`, which APPENDS it into `#k-center` after the relocated `#sheld`
 * (`#k-center` is `position: relative` — library.css — so the pill's absolute geometry resolves
 * against the centre track). Every rule that paints it lives in `public/css/shell-center.css`
 * §6; this file writes exactly one style, the `--k-jl-offset` anchor it measures.
 *
 * House patterns (k-chat-header.js):
 * - **Light DOM.** `createRenderRoot()` returns `this`.
 * - **SPEC §13 variant attribute.** `pill` is the only v0 variant.
 * - **One-way imports.** kotatsu → core only.
 * - **Never per-token.** The count moves on MESSAGE_RECEIVED / MESSAGE_SENT only; the scroll
 *   listener is passive and coalesced to one read per frame; the anchor is re-measured on
 *   composer resize (ResizeObserver) and window resize, not on scroll. `STREAM_TOKEN_RECEIVED`
 *   is deliberately not subscribed — the generation loop never pays for this element.
 * - **Never fabricates a bottom.** "Away" is measured off `#chat`'s own scroll metrics; with
 *   no chat open (`getCurrentChatId()` falsy) or no `#chat`, the pill is simply hidden.
 *
 * Core reads: `getCurrentChatId()` script.js:541. `#chat` is the scroll container under rails
 * (shell-frame.css §2 clears its viewport max-height; it keeps its own overflow), and its node
 * identity is frozen by CONTRACT §1.7, so binding it once per chat is enough.
 */

import { LitElement, html, nothing } from '../lit.js';
import { getCurrentChatId } from '../../../script.js';
import { event_types, eventSource } from '../../../scripts/events.js';

/** How far above the bottom, in `#chat` viewports, counts as "away". */
const AWAY_SCREENS = 1;
/**
 * Beyond this many `#chat` viewports the jump is instant. Measured 2026-09-02: a smooth
 * scroll over 24,000px (22 screens of the longform corpus) takes ~1.4s of unreadable blur;
 * within a few screens the motion is what tells the reader where they went.
 */
const SMOOTH_MAX_SCREENS = 4;
/** Breathing room between the pill and the composer's top edge, in px. */
const ANCHOR_GAP_PX = 10;

/**
 * `event_types` KEYS, looked up by key and skipped when absent (an upstream rename degrades to
 * one missing listener, never a boot-time crash — the k-topbar.js pattern).
 */
const ARRIVAL_EVENTS = ['MESSAGE_RECEIVED', 'MESSAGE_SENT'];
const RESET_EVENTS = ['CHAT_CHANGED'];
const MEASURE_EVENTS = [
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_DELETED',
    'MORE_MESSAGES_LOADED',
    'GENERATION_ENDED',
];

/**
 * The "back to latest" pill.
 */
export class KJumpLatest extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `pill` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** Reflected so the sheet keys the fade and the pointer gate on it. */
        visible: { type: Boolean, reflect: true },
        _count: { state: true },
    };

    /** @type {HTMLElement|null} The bound scroll container. */
    #chat = null;
    /** @type {ResizeObserver|null} */
    #composerObserver = null;
    /** @type {number} Pending measure frame, 0 = idle. */
    #frame = 0;
    /** @type {boolean} Whether the pending frame should also re-anchor. */
    #anchorPending = false;
    /** @type {Array<{ type: string, handler: () => void }>} */
    #subscriptions = [];
    #onScroll = () => this.#schedule(false);
    #onResize = () => this.#schedule(true);

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'pill';
        /** @type {boolean} */
        this.visible = false;
        /** @type {number} Messages that arrived while the reader was away. */
        this._count = 0;
    }

    /** Light DOM: `public/css/shell-center.css` §6 owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        this.#bindChat();
        this.#observeComposer();
        this.#subscribe(ARRIVAL_EVENTS, () => this.#onArrival());
        this.#subscribe(RESET_EVENTS, () => this.#onReset());
        this.#subscribe(MEASURE_EVENTS, () => this.#schedule(false));
        window.addEventListener('resize', this.#onResize);
        this.#schedule(true);
    }

    disconnectedCallback() {
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
        this.#chat?.removeEventListener('scroll', this.#onScroll);
        this.#chat = null;
        this.#composerObserver?.disconnect();
        this.#composerObserver = null;
        window.removeEventListener('resize', this.#onResize);
        if (this.#frame !== 0) {
            cancelAnimationFrame(this.#frame);
            this.#frame = 0;
        }
        super.disconnectedCallback();
    }

    /**
     * @param {string[]} keys `event_types` keys.
     * @param {() => void} handler
     */
    #subscribe(keys, handler) {
        for (const key of keys) {
            const type = event_types ? event_types[key] : undefined;
            if (typeof type !== 'string') {
                continue;
            }
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
    }

    /** Binds (or re-binds) the passive scroll listener to the live `#chat`. */
    #bindChat() {
        const chat = document.getElementById('chat');
        if (chat === this.#chat) {
            return;
        }
        this.#chat?.removeEventListener('scroll', this.#onScroll);
        this.#chat = chat;
        chat?.addEventListener('scroll', this.#onScroll, { passive: true });
    }

    /** Follows the composer's height so the pill never sits on the field. */
    #observeComposer() {
        if (typeof ResizeObserver !== 'function') {
            return;
        }
        const composer = document.getElementById('form_sheld');
        if (!composer) {
            return;
        }
        this.#composerObserver = new ResizeObserver(() => this.#schedule(true));
        this.#composerObserver.observe(composer);
    }

    /**
     * Distance from the bottom of `#chat`, in px; null when there is nothing to measure.
     * @returns {number|null}
     */
    #distanceFromBottom() {
        const chat = this.#chat;
        if (!chat) {
            return null;
        }
        return chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    }

    /** @returns {boolean} Whether the reader is more than a screen above the bottom. */
    #isAway() {
        const chat = this.#chat;
        const distance = this.#distanceFromBottom();
        return !!chat && distance !== null && distance > chat.clientHeight * AWAY_SCREENS;
    }

    /**
     * Coalesces measures to one per frame. A scroll asks for the cheap read; a resize asks for
     * the anchor too.
     * @param {boolean} anchor
     */
    #schedule(anchor) {
        this.#anchorPending = this.#anchorPending || anchor;
        if (this.#frame !== 0) {
            return;
        }
        this.#frame = requestAnimationFrame(() => {
            this.#frame = 0;
            const reanchor = this.#anchorPending;
            this.#anchorPending = false;
            if (reanchor) {
                this.#anchor();
            }
            this.#measure();
        });
    }

    /** Re-reads the scroll state. Never throws (a crash here would land in Lit's update). */
    #measure() {
        let hasChat = false;
        try {
            hasChat = Boolean(getCurrentChatId());
        } catch {
            hasChat = false;
        }
        const away = hasChat && this.#isAway();
        if (!away && this._count !== 0) {
            // Back at the bottom: everything that arrived has been seen.
            this._count = 0;
        }
        this.visible = away;
    }

    /** Writes the one geometry var: how far above the track's bottom the composer's top sits. */
    #anchor() {
        const center = this.parentElement;
        const composer = document.getElementById('form_sheld');
        if (!center || !composer) {
            return;
        }
        const offset = Math.max(0, Math.round(center.getBoundingClientRect().bottom - composer.getBoundingClientRect().top));
        this.style.setProperty('--k-jl-offset', `${offset + ANCHOR_GAP_PX}px`);
    }

    /** A message landed at the bottom. Counts it only if the reader is away to see it. */
    #onArrival() {
        if (this.#isAway()) {
            this._count += 1;
        }
        this.#schedule(false);
    }

    /** A different chat: nothing that was counted applies. */
    #onReset() {
        this._count = 0;
        this.#bindChat();
        this.#schedule(true);
    }

    /** Scrolls `#chat` to its bottom; smooth when close, instant when far or under reduced motion. */
    #jump() {
        const chat = this.#chat;
        if (!chat) {
            return;
        }
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const distance = this.#distanceFromBottom() ?? 0;
        const far = distance > chat.clientHeight * SMOOTH_MAX_SCREENS;
        chat.scrollTo({ top: chat.scrollHeight, behavior: reduce || far ? 'auto' : 'smooth' });
        this._count = 0;
    }

    render() {
        const count = this._count;
        const label = count > 0
            ? `${count} new ${count === 1 ? 'message' : 'messages'} — jump to latest`
            : 'Jump to latest';
        return html`
            <button
                type="button"
                class="k-jl__button"
                aria-label=${label}
                title=${label}
                tabindex=${this.visible ? '0' : '-1'}
                @click=${() => this.#jump()}
            >
                ${count > 0 ? html`<span class="k-jl__count" aria-live="polite">${count} new</span>` : nothing}
                <span class="k-jl__text">Latest</span>
                <svg class="k-jl__glyph" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                    <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
            </button>
        `;
    }
}

customElements.define('k-jump-latest', KJumpLatest);
