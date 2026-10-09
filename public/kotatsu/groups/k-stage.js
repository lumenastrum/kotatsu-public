/**
 * `<k-stage>` — the On-stage strip above the composer in a scene (`docs/group-chat-v0.md` G3,
 * board A).
 *
 * One seat per cast member in seating order, each wearing its identity hue and its live state:
 * writing (a ring that breathes), next, queued/cued, muted, missing. A click opens the member
 * menu — Speak now · Speak after the next reply · Peek card · Mute · Leave the scene. On the right:
 * the turn style ("Natural ▾") and **Let them talk** (core auto mode). A polite live region says
 * what is happening ("Aelirenn is writing · then Seraphina").
 *
 * Mounted once by the rails layout directly above `#send_form` (the composer-reason strip's
 * spot); draws nothing outside a scene. Reads `cast-state.js`, acts through `stage-actions.js`.
 * Light DOM, `variant="strip"` (SPEC §13); every rule is in css/scenes.css.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters, chat, getThumbnailUrl, isGenerating } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import { shouldSendOnEnter } from '../../scripts/RossAscends-mods.js';
import { openCharacterPeek } from '../renderer/k-portrait-peek.js';
import { seats, statusLine } from './cast-state.js';
import { completeMention, findMentions, mentionOrder, mentionQuery, rankCandidates, stripMentionSigns } from './mentions.js';
import { roundStore } from './round-store.js';
import { OPEN_SCENE_STUDIO_EVENT } from './doors.js';
import { TURN_STYLES, hueColor, turnStyle } from './scene-model.js';
import {
    cueInOrder,
    installCueDrain,
    leaveScene,
    openScene,
    setMuted,
    setTalking,
    setTurnStyle,
    speakAfter,
    speakNow,
    talking,
    uninstallCueDrain,
} from './stage-actions.js';

/** Core events after which the cast or the counts may have moved. Looked up by key. */
const REFRESH_EVENTS = [
    'APP_READY', 'CHAT_CHANGED', 'GROUP_UPDATED', 'CHARACTER_EDITED', 'CHARACTER_DELETED',
    'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
    // Core turns auto mode off by itself (typing, Stop); the switch must follow.
    'GROUP_AUTO_MODE_CHANGED',
];

const icons = {
    play: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true" focusable="false"><path d="M5 3.5v9l7.5-4.5z"/></svg>`,
    stop: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`,
    caret: html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"/></svg>`,
    plus: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10"/></svg>`,
    speak: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.5 3v10l8.5-5z"/></svg>`,
    after: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M3 5h10M3 8h7M3 11h4"/><path d="m11 10 2 1.5-2 1.5"/></svg>`,
    peek: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="8" cy="8" r="1.8"/></svg>`,
    mute: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="m11.5 6.5 3 3m0-3-3 3"/></svg>`,
    unmute: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 6a3 3 0 0 1 0 4"/></svg>`,
    leave: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10 3h3v10h-3M7 5 4 8l3 3M4 8h7"/></svg>`,
    check: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.8 8.6 6.3 12l6.9-8"/></svg>`,
    // The narrator seat's mark: a hand lantern (Kotatsu's hearth lantern, drawn small).
    lantern: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.5 4.5a2.5 2.5 0 0 1 5 0"/><path d="M8 6.5h8"/><path d="M8.5 6.5c-1.4 1.6-2 3.6-2 6s.6 4.4 2 6h7c1.4-1.6 2-3.6 2-6s-.6-4.4-2-6"/><path d="M12 10.5c1.1 1.1 1.6 2 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1 .5-1.9 1.6-3z"/><path d="M8 18.5h8"/></svg>`,
};

/**
 * A seat's colour: its identity hue, or the narrator's quiet ink (`--k-scene-narrator`).
 * @param {import('./cast-state.js').Seat} seat
 * @returns {string}
 */
function seatColor(seat) {
    return seat.narrator ? 'var(--k-scene-narrator)' : hueColor(seat.hue);
}

/**
 * @param {import('./cast-state.js').Seat} seat
 * @returns {unknown} The seat's face: the lantern for the narrator, the card art otherwise.
 */
function seatFace(seat) {
    if (seat.narrator) return html`<span class="k-stage-face k-stage-face--narrator">${icons.lantern}</span>`;
    return html`<img class="k-stage-face" src=${getThumbnailUrl('avatar', seat.avatar)} alt="" loading="lazy">`;
}

/** @type {Record<string, string>} The word a seat wears for its state; '' wears none. */
const STATE_WORD = { writing: 'writing', next: 'next', queued: 'soon', cued: 'cued', muted: 'muted', missing: 'gone', idle: '' };

export class KStage extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _seats: { state: true },
        _talking: { state: true },
        _menu: { state: true },
        _styleOpen: { state: true },
        _strategy: { state: true },
        _suggest: { state: true },
        _draft: { state: true },
    };

    /** @type {string[]} */
    #bound = [];

    /** @type {(() => void)|null} */
    #offRound = null;

    /** @type {ResizeObserver|null} Re-measures the seat row's hidden edges when the strip resizes. */
    #seatsObserver = null;

    /** @type {(event: PointerEvent) => void} */
    #onOutside = (event) => {
        if ((this._menu || this._styleOpen) && event.target instanceof Node && !this.contains(event.target)) {
            this.#closeMenus(false);
        }
    };

    /** @type {() => void} */
    #onCore = () => this.refresh();

    /** Core turns auto mode off when the user types; the button has to notice. Also @mentions. */
    #onComposerInput = () => {
        if (this._talking !== talking()) this._talking = talking();
        this.#syncMentions();
    };

    /** Caret moves (click, arrows) change which at-word is active. */
    #onComposerCaret = () => this.#syncMentions();

    /**
     * Window capture, so it runs before core's document-level hotkeys (RossAscends-mods.js) and
     * before the textarea's own listeners: the suggestion list owns arrows / Enter / Tab / Escape
     * while it is open, and an Enter that would send a draft with @mentions sends it our way.
     * @param {KeyboardEvent} event
     */
    #onKeyCapture = (event) => {
        if (this.hidden || event.target !== document.getElementById('send_textarea')) return;
        const suggest = this._suggest;
        if (suggest) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const step = event.key === 'ArrowDown' ? 1 : -1;
                this._suggest = { ...suggest, index: (suggest.index + step + suggest.items.length) % suggest.items.length };
            } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                this.#pick(suggest.items[suggest.index]);
            } else if (event.key === 'Escape') {
                this._suggest = null;
            } else {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
            && !event.isComposing && shouldSendOnEnter() && this.#sendWithMentions()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };

    /** @param {MouseEvent} event */
    #onClickCapture = (event) => {
        if (this.hidden || !(event.target instanceof Element) || !event.target.closest('#send_but')) return;
        if (this.#sendWithMentions()) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'strip';
        /** @type {import('./cast-state.js').Seat[]} */
        this._seats = [];
        /** @type {boolean} */
        this._talking = false;
        /** @type {string} Avatar whose member menu is open, '' for none. */
        this._menu = '';
        /** @type {boolean} */
        this._styleOpen = false;
        /** @type {number} */
        this._strategy = 0;
        /** @type {{ start: number, query: string, items: string[], index: number }|null} The @ suggestion list. */
        this._suggest = null;
        /** @type {string[]} Avatars the draft's @mentions will cue, in order. */
        this._draft = [];
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        for (const key of REFRESH_EVENTS) {
            const name = event_types[key];
            if (typeof name === 'string') {
                eventSource.on(name, this.#onCore);
                this.#bound.push(name);
            }
        }
        roundStore.acquire();
        this.#offRound = roundStore.subscribe(() => this.refresh());
        document.addEventListener('pointerdown', this.#onOutside, true);
        const textarea = document.getElementById('send_textarea');
        textarea?.addEventListener('input', this.#onComposerInput);
        textarea?.addEventListener('click', this.#onComposerCaret);
        textarea?.addEventListener('keyup', this.#onComposerCaret);
        window.addEventListener('keydown', this.#onKeyCapture, true);
        window.addEventListener('click', this.#onClickCapture, true);
        installCueDrain();
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this.#bound) eventSource.removeListener(name, this.#onCore);
        this.#bound = [];
        this.#offRound?.();
        this.#offRound = null;
        roundStore.release();
        document.removeEventListener('pointerdown', this.#onOutside, true);
        const textarea = document.getElementById('send_textarea');
        textarea?.removeEventListener('input', this.#onComposerInput);
        textarea?.removeEventListener('click', this.#onComposerCaret);
        textarea?.removeEventListener('keyup', this.#onComposerCaret);
        window.removeEventListener('keydown', this.#onKeyCapture, true);
        window.removeEventListener('click', this.#onClickCapture, true);
        uninstallCueDrain();
        this.#seatsObserver?.disconnect();
        this.#seatsObserver = null;
        super.disconnectedCallback();
    }

    firstUpdated() {
        const seats = this.querySelector('.k-stage-seats');
        if (seats && typeof ResizeObserver === 'function') {
            this.#seatsObserver = new ResizeObserver(() => this.#measureSeats());
            this.#seatsObserver.observe(seats);
        }
    }

    updated() {
        this.#measureSeats();
    }

    /**
     * Marks the seat row's hidden edges so CSS can fade them: a crowded stage scrolls sideways
     * with its scrollbar hidden, and a hard clip reads as a cut-off name, not as "more this way".
     * @returns {void}
     */
    #measureSeats() {
        const seats = this.querySelector('.k-stage-seats');
        if (!(seats instanceof HTMLElement)) return;
        const hidden = seats.scrollWidth - seats.clientWidth;
        seats.toggleAttribute('data-more-start', hidden > 1 && seats.scrollLeft > 1);
        seats.toggleAttribute('data-more-end', hidden > 1 && seats.scrollLeft < hidden - 1);
    }

    /** Re-reads the open scene. Never throws. */
    refresh() {
        try {
            const group = openScene();
            this.hidden = !group;
            document.body.toggleAttribute('data-k-scene', Boolean(group));
            if (!group) {
                this._seats = [];
                this._menu = '';
                this._styleOpen = false;
                return;
            }
            this._seats = seats(group, characters, chat, roundStore.round);
            this._strategy = turnStyle(group.activation_strategy).value;
            this._talking = talking();
            // The writing ring breathes forever; core folds the OS preference into this flag
            // (power-user.js:512-517) and only gates finite transitions, so the strip asks it.
            this.toggleAttribute('data-still', Boolean(power_user.reduced_motion));
            if (this._menu && !this._seats.some(seat => seat.avatar === this._menu)) this._menu = '';
        } catch (error) {
            console.error('[k-stage] refresh failed', error);
        }
    }

    /** @returns {string[]} Names of the members who can be mentioned (their card exists). */
    #castNames() {
        return this._seats.filter(seat => seat.present).map(seat => seat.name);
    }

    /**
     * Everything a member answers to: their full name, and their first name when no one else in
     * the scene shares it ("@Hana" for Hana Kurogane). Key → avatar.
     * @returns {Map<string, string>}
     */
    #callNames() {
        /** @type {Map<string, string>} */
        const map = new Map();
        const present = this._seats.filter(seat => seat.present);
        for (const seat of present) map.set(seat.name, seat.avatar);
        for (const seat of present) {
            const shared = present.filter(other => other.short.toLocaleLowerCase() === seat.short.toLocaleLowerCase()).length > 1;
            if (!shared && seat.short && !map.has(seat.short)) map.set(seat.short, seat.avatar);
        }
        return map;
    }

    /**
     * @param {string} text
     * @returns {{ mentions: import('./mentions.js').Mention[], avatars: string[] }} Who the draft
     *   calls, in order, each member once whichever name was used.
     */
    #called(text) {
        const calls = this.#callNames();
        const mentions = findMentions(text, [...calls.keys()]);
        const avatars = [];
        for (const name of mentionOrder(mentions)) {
            const avatar = calls.get(name);
            if (avatar && !avatars.includes(avatar)) avatars.push(avatar);
        }
        return { mentions, avatars };
    }

    /** Re-reads the draft: the active at-word's suggestions and the cue order it asks for. */
    #syncMentions() {
        const textarea = document.getElementById('send_textarea');
        if (this.hidden || !(textarea instanceof HTMLTextAreaElement)) {
            this._suggest = null;
            this._draft = [];
            return;
        }
        const names = this.#castNames();
        const text = textarea.value;
        const draft = this.#called(text).avatars;
        if (draft.join('\u0000') !== this._draft.join('\u0000')) this._draft = draft;
        const active = textarea.selectionStart === textarea.selectionEnd ? mentionQuery(text, textarea.selectionStart) : null;
        const items = active ? rankCandidates(active.query, names) : [];
        // A finished mention ("@Seraphina" exactly) needs no list.
        const done = active && items.length === 1 && items[0].toLocaleLowerCase() === active.query.toLocaleLowerCase();
        if (!active || items.length === 0 || done) {
            this._suggest = null;
        } else {
            const index = this._suggest && this._suggest.start === active.start ? Math.min(this._suggest.index, items.length - 1) : 0;
            this._suggest = { ...active, items, index };
        }
        this.#syncAria(textarea);
    }

    /** @param {HTMLTextAreaElement} textarea */
    #syncAria(textarea) {
        if (this._suggest) {
            textarea.setAttribute('aria-controls', 'k-stage-mentions');
            textarea.setAttribute('aria-activedescendant', `k-stage-mention-${this._suggest.index}`);
            textarea.setAttribute('aria-autocomplete', 'list');
        } else if (textarea.hasAttribute('aria-activedescendant')) {
            textarea.removeAttribute('aria-controls');
            textarea.removeAttribute('aria-activedescendant');
            textarea.removeAttribute('aria-autocomplete');
        }
    }

    /**
     * Completes the active at-word.
     * @param {string|undefined} name
     */
    #pick(name) {
        const textarea = document.getElementById('send_textarea');
        if (!name || !this._suggest || !(textarea instanceof HTMLTextAreaElement)) return;
        // Insert the first name when it is unique in the scene: it reads like a person talking.
        const seat = this._seats.find(s => s.name === name);
        const calls = this.#callNames();
        const insert = seat && calls.get(seat.short) === seat.avatar ? seat.short : name;
        const next = completeMention(textarea.value, this._suggest, insert);
        textarea.value = next.text;
        textarea.setSelectionRange(next.caret, next.caret);
        textarea.focus();
        this._suggest = null;
        // Core listens to input (autosize, auto-mode stop); so does #syncMentions.
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * Sends a draft that at-mentions cast members: the at signs come off, then the mentioned
     * members are cued in order — the first speaks to the message (core sends the composer text
     * with that forced turn), the rest follow one per round. Anything without a cast mention, a
     * slash command, or a send while a reply is already being written stays core's.
     * @returns {boolean} True when the send was taken.
     */
    #sendWithMentions() {
        const textarea = document.getElementById('send_textarea');
        if (!(textarea instanceof HTMLTextAreaElement) || isGenerating()) return false;
        const text = textarea.value;
        if (text.trimStart().startsWith('/')) return false;
        const { mentions, avatars } = this.#called(text);
        if (mentions.length === 0 || avatars.length === 0) return false;
        textarea.value = stripMentionSigns(text, mentions);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        this._draft = [];
        cueInOrder(avatars);
        return true;
    }

    /**
     * @param {boolean} restoreFocus
     */
    #closeMenus(restoreFocus) {
        const was = this._menu;
        this._menu = '';
        this._styleOpen = false;
        if (restoreFocus && was) {
            void this.updateComplete.then(() => {
                const seat = this.querySelector(`.k-stage-seat[data-avatar="${CSS.escape(was)}"]`);
                if (seat instanceof HTMLElement) seat.focus();
            });
        }
    }

    /**
     * Escape closes a menu; arrows walk its items.
     * @param {KeyboardEvent} event
     */
    #onMenuKey(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.#closeMenus(true);
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const menu = /** @type {HTMLElement} */ (event.currentTarget);
        const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].filter(el => el instanceof HTMLElement && !el.hasAttribute('disabled'));
        const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        const next = items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        if (next instanceof HTMLElement) {
            event.preventDefault();
            next.focus();
        }
    }

    /**
     * @param {string} avatar
     */
    #toggleMenu(avatar) {
        this._styleOpen = false;
        this._menu = this._menu === avatar ? '' : avatar;
        if (this._menu) {
            void this.updateComplete.then(() => {
                const first = this.querySelector('.k-stage-menu [role="menuitem"]');
                if (first instanceof HTMLElement) first.focus();
            });
        }
    }

    /**
     * Runs a menu action and closes the menu.
     * @param {() => unknown} action
     */
    #act(action) {
        this.#closeMenus(false);
        Promise.resolve().then(action).catch(error => console.error('[k-stage] action failed', error));
    }

    #openStudio() {
        const group = openScene();
        if (!group) return;
        this.dispatchEvent(new CustomEvent(OPEN_SCENE_STUDIO_EVENT, {
            bubbles: true, composed: true, detail: { target: String(group.id), source: 'k-stage' },
        }));
    }

    render() {
        if (this.hidden || this._seats.length === 0 && !openScene()) {
            return nothing;
        }
        const live = statusLine(this._seats, roundStore.round);
        // Nothing happening yet, but the draft names people: say who will answer, in order.
        const shortOf = (/** @type {string} */ avatar) => this._seats.find(seat => seat.avatar === avatar)?.short ?? '';
        const status = live || (this._draft.length ? `You → ${this._draft.map(shortOf).join(' → ')}` : '');
        const style = turnStyle(this._strategy);
        return html`
            <div class="k-stage-bar" role="toolbar" aria-label="On stage">
                <span class="k-stage-label" aria-hidden="true">On stage</span>
                <div class="k-stage-seats" @scroll=${() => this.#measureSeats()}>
                    ${this._seats.map(seat => this.#renderSeat(seat))}
                </div>
                <button type="button" class="k-stage-invite" title="Edit the cast" aria-label="Edit the cast"
                    @click=${() => this.#openStudio()}>${icons.plus}</button>
                <span class="k-stage-status" role="status" aria-live="polite">${status}</span>
                <div class="k-stage-tools">
                    <button type="button" class="k-stage-style" aria-haspopup="menu" aria-expanded=${String(this._styleOpen)}
                        title=${style.hint}
                        @click=${() => { this._menu = ''; this._styleOpen = !this._styleOpen; }}>
                        <span>${style.label}</span>${icons.caret}
                    </button>
                    <button type="button" class="k-stage-talk${this._talking ? ' is-on' : ''}" aria-pressed=${String(this._talking)}
                        title=${this._talking ? 'They keep talking until you type or press this' : 'Let the cast carry the scene on its own'}
                        @click=${() => { setTalking(!this._talking); this._talking = talking(); }}>
                        ${this._talking ? icons.stop : icons.play}<span class="k-stage-talk-long">${this._talking ? 'Talking' : 'Let them talk'}</span><span class="k-stage-talk-short" aria-hidden="true">${this._talking ? 'Stop' : 'Auto'}</span>
                    </button>
                </div>
            </div>
            ${this._menu ? this.#renderMenu(this._menu) : nothing}
            ${this._styleOpen ? this.#renderStyleMenu() : nothing}
            ${this._suggest ? this.#renderSuggestions(this._suggest) : nothing}`;
    }

    /**
     * @param {import('./cast-state.js').Seat} seat
     * @returns {unknown}
     */
    #renderSeat(seat) {
        const word = STATE_WORD[seat.state] ?? '';
        const label = `${seat.name}${word ? `, ${word}` : ''}. Open ${seat.name}'s menu.`;
        return html`
            <button type="button" class="k-stage-seat${seat.narrator ? ' k-stage-seat--narrator' : ''}" data-state=${seat.state} data-avatar=${seat.avatar}
                style=${`--seat: ${seatColor(seat)};`} title=${seat.narrator ? seat.name : nothing}
                aria-haspopup="menu" aria-expanded=${String(this._menu === seat.avatar)} aria-label=${label}
                @click=${() => this.#toggleMenu(seat.avatar)}>
                ${seat.present
        ? seatFace(seat)
        : html`<span class="k-stage-face k-stage-face--gone" aria-hidden="true">?</span>`}
                <span class="k-stage-name">${seat.short}</span>
                ${word ? html`<span class="k-stage-word">${word}</span>` : nothing}
            </button>`;
    }

    /**
     * @param {string} avatar
     * @returns {unknown}
     */
    #renderMenu(avatar) {
        const seat = this._seats.find(s => s.avatar === avatar);
        if (!seat) return nothing;
        const total = this._seats.reduce((sum, s) => sum + s.turns, 0);
        const word = STATE_WORD[seat.state];
        const replies = total ? `${seat.turns} of ${total} replies` : 'No replies yet';
        const facts = seat.narrator
            ? ['Voices the world and everyone outside the cast', replies].join(' · ')
            : [word ? word[0].toUpperCase() + word.slice(1) : '', replies].filter(Boolean).join(' · ');
        const anchor = this.querySelector(`.k-stage-seat[data-avatar="${CSS.escape(avatar)}"]`);
        const left = anchor instanceof HTMLElement ? anchor.offsetLeft : 0;
        return html`
            <div class="k-stage-menu" role="menu" aria-label=${seat.name} style=${`--seat: ${seatColor(seat)}; --menu-left: ${left}px;`}
                @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onMenuKey(e)}>
                <div class="k-stage-menu-head">
                    ${seat.present ? seatFace(seat) : nothing}
                    <span class="k-stage-menu-copy"><b>${seat.name}</b><small>${facts}</small></span>
                </div>
                <button type="button" role="menuitem" class="k-stage-item k-stage-item--lead" ?disabled=${!seat.present}
                    @click=${() => this.#act(() => speakNow(avatar))}>${icons.speak}<span>Speak now</span></button>
                <button type="button" role="menuitem" class="k-stage-item" ?disabled=${!seat.present}
                    @click=${() => this.#act(() => speakAfter(avatar))}>${icons.after}<span>Speak after the next reply</span></button>
                ${seat.narrator ? nothing : html`
                <button type="button" role="menuitem" class="k-stage-item" ?disabled=${!seat.present}
                    @click=${(/** @type {Event} */ e) => this.#act(() => openCharacterPeek(avatar, /** @type {HTMLElement} */ (e.currentTarget)))}>${icons.peek}<span>Peek card</span></button>
                <button type="button" role="menuitem" class="k-stage-item"
                    @click=${() => this.#act(() => setMuted(avatar, !seat.muted))}>
                    ${seat.muted ? html`${icons.unmute}<span>Unmute</span>` : html`${icons.mute}<span>Mute <small>stays, doesn’t speak</small></span>`}
                </button>`}
                <button type="button" role="menuitem" class="k-stage-item k-stage-item--danger"
                    @click=${() => this.#act(() => leaveScene(avatar))}>${icons.leave}<span>${seat.narrator ? 'Remove the narrator' : 'Leave the scene'}</span></button>
            </div>`;
    }

    /**
     * The @ suggestion list. Focus stays in the composer (aria-activedescendant); a mouse pick
     * keeps it there too by cancelling the mousedown.
     * @param {{ items: string[], index: number }} suggest
     * @returns {unknown}
     */
    #renderSuggestions(suggest) {
        const bySeat = new Map(this._seats.map(seat => [seat.name, seat]));
        return html`
            <ul class="k-stage-menu k-stage-mentions" id="k-stage-mentions" role="listbox" aria-label="Mention someone">
                ${suggest.items.map((name, index) => {
        const seat = bySeat.get(name);
        return html`
                    <li id=${`k-stage-mention-${index}`} role="option" aria-selected=${String(index === suggest.index)}
                        class="k-stage-item${index === suggest.index ? ' is-active' : ''}"
                        style=${seat ? `--seat: ${seatColor(seat)};` : ''}
                        @mousedown=${(/** @type {MouseEvent} */ e) => { e.preventDefault(); this.#pick(name); }}>
                        ${seat ? seatFace(seat) : nothing}
                        <span class="k-stage-mention-name">${name}</span>
                        ${seat?.narrator ? html`<small>the world, and everyone outside the cast</small>` : seat?.muted ? html`<small>muted · answers when called</small>` : nothing}
                    </li>`;
    })}
                <li class="k-stage-mentions-hint" role="presentation">Tab or Enter to pick · they answer in the order you name them</li>
            </ul>`;
    }

    /** @returns {unknown} */
    #renderStyleMenu() {
        return html`
            <div class="k-stage-menu k-stage-menu--style" role="menu" aria-label="Who speaks after you"
                @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onMenuKey(e)}>
                <div class="k-stage-menu-head"><span class="k-stage-menu-copy"><b>Who speaks after you</b></span></div>
                ${TURN_STYLES.map(style => html`
                    <button type="button" role="menuitemradio" aria-checked=${String(style.value === this._strategy)}
                        class="k-stage-item k-stage-item--radio${style.value === this._strategy ? ' is-on' : ''}"
                        @click=${() => this.#act(() => setTurnStyle(style.value))}>
                        <span class="k-stage-check">${style.value === this._strategy ? icons.check : nothing}</span>
                        <span class="k-stage-item-copy"><b>${style.label}</b><small>${style.hint}</small></span>
                    </button>`)}
            </div>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-stage')) {
    customElements.define('k-stage', KStage);
}

/** @type {KStage|null} */
let mounted = null;

/**
 * Mounts the strip above the composer. Called by the rails layout's mount; idempotent. The
 * element is permanent while rails is up and hides itself outside a scene.
 * @returns {void}
 */
export function installStage() {
    if (mounted) return;
    const form = document.getElementById('send_form');
    if (!form?.parentElement) {
        console.warn('[k-stage] #send_form is missing; no stage strip.');
        return;
    }
    mounted = /** @type {KStage} */ (document.createElement('k-stage'));
    mounted.setAttribute('variant', 'strip');
    form.before(mounted);
}

/** @returns {void} */
export function uninstallStage() {
    mounted?.remove();
    mounted = null;
    document.body.removeAttribute('data-k-scene');
}
