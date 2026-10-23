/**
 * `<k-opening-preview variant="chat">` — Card Studio ②'s first message, shown the way the chat
 * will show it (#16, the first-message slice; design `docs/card-studio-v2.md`).
 *
 * It does not imitate a message. It asks core for one: `updateMessageElement()` builds a real row
 * from `#message_template` without appending it anywhere, from a TRANSIENT message
 * (`openings.js` `previewMessage`, messageId -1), and this element puts that row in a stage that
 * wears the reader's wardrobe attributes (`data-k-mes-*`, copied off `#chat`). Every Kotatsu rule
 * that styles a message through `#chat` is written `:is(#chat, .k-chat-stage)` (guarded by
 * `tests/chat-stage-selectors.test.js`), so the card look, bubbles, script, broadcast, the pack's
 * knobs and the *action* / "dialogue" colours all arrive as they do in chat, with nothing copied.
 *
 * What core's rules do NOT reach, said plainly: `style.css` and `toggle-dependent.css` key a few
 * rules on `#chat` too (ST's "document" chat style, a selected row); those are upstream sheets and
 * stay untouched, so a reader on ST's document style sees Kotatsu's look here.
 *
 * ── The stage is a quarantine ────────────────────────────────────────────────────────────
 * Core binds its message handlers on `document` (`.last_mes .swipe_right` swipes and may
 * GENERATE, `.mes_edit`, `.mes .avatar`, `.mes` in delete mode). A click inside the stage never
 * leaves it: the swipe arrows become the opening flipper (`k-opening-flip`), everything else is
 * swallowed. The row's action buttons are hidden by `css/studio.css`.
 *
 * Light DOM, `variant` from day one (SPEC §13). One-way imports: kotatsu → core.
 */

import { LitElement, html } from '../shell/lit.js';
import { substituteParams, updateMessageElement } from '../../script.js';
import { markSwipeCounts } from '../renderer/swipe-count.js';
import { macroOptions, previewMessage } from './openings.js';

/** The wardrobe axes the loader writes on `#chat` (`theme/loader.js`, the single DOM write site). */
const WARDROBE_ATTRIBUTES = Object.freeze(['data-k-mes-variant', 'data-k-mes-nameplate', 'data-k-mes-metadata']);

/** Emitted when the row's own swipe arrows are pressed. `detail.delta` is -1 or +1. */
export const OPENING_FLIP_EVENT = 'k-opening-flip';

export class KOpeningPreview extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        /** Every opening's RAW text, in order (macros are resolved here). */
        texts: { attribute: false },
        index: { type: Number },
        /** The character's name as the chat prints it, and `{{char}}`. */
        name: { type: String },
        /** `create` | `edit`: which macros may resolve (see `openings.js` `macroOptions`). */
        mode: { type: String },
        /** An avatar to force (fresh crop, create mode); '' = core's own pick, as in chat. */
        avatar: { type: String },
    };

    /** @type {string} What was last painted, so an unchanged refresh costs nothing. */
    #painted = '';

    constructor() {
        super();
        this.variant = 'chat';
        /** @type {string[]} */
        this.texts = [];
        this.index = 0;
        this.name = '';
        this.mode = 'edit';
        this.avatar = '';
        /** Stamped once: a greeting carries the moment the chat opened, and so does this. */
        this.sendDate = Date.now();
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
    }

    render() {
        // No child parts: lit-html never touches what #paint() puts inside the stage.
        return html`<div class="k-chat-stage" @click=${this.#onClick}></div>`;
    }

    updated() {
        this.#paint();
    }

    /** Re-reads the wardrobe and repaints, for a caller that knows the chat's look changed. */
    refresh() {
        this.#painted = '';
        this.#paint();
    }

    /** @returns {void} */
    #paint() {
        const stage = this.querySelector('.k-chat-stage');
        if (!(stage instanceof HTMLElement)) return;

        const chat = document.getElementById('chat');
        /** @type {[string, string|null][]} */
        const wardrobe = WARDROBE_ATTRIBUTES.map(name => [name, chat?.getAttribute(name) ?? null]);
        const key = JSON.stringify([this.texts, this.index, this.name, this.mode, this.avatar, wardrobe]);
        if (key === this.#painted) return;
        this.#painted = key;

        for (const [name, value] of wardrobe) {
            if (value === null) stage.removeAttribute(name);
            else stage.setAttribute(name, value);
        }

        const options = macroOptions({ name: this.name, mode: this.mode === 'create' ? 'create' : 'edit' });
        const texts = (this.texts ?? []).map(text => (text ? substituteParams(text, options) : ''));
        const message = previewMessage({ name: this.name, texts, index: this.index, avatar: this.avatar || undefined, sendDate: this.sendDate });

        if (!message.mes.trim()) {
            stage.replaceChildren(this.#empty());
            return;
        }
        try {
            const row = updateMessageElement(/** @type {any} */ (message), { messageId: -1 })[0];
            // A brand-new chat's greeting: the last row, with its swipes on show when it has some.
            row.classList.add('last_mes');
            row.classList.toggle('swipes_visible', texts.length > 1);
            const id = row.querySelector('.mesIDDisplay');
            if (id) id.textContent = '#0';
            stage.replaceChildren(row);
            markSwipeCounts(stage);
        } catch (error) {
            console.warn('[k-opening-preview] core could not render the opening', error);
            const note = document.createElement('p');
            note.className = 'k-opening-preview__note';
            note.textContent = 'This opening could not be previewed. The text is safe; the chat renders it on its own.';
            stage.replaceChildren(note);
        }
    }

    /** @returns {HTMLElement} What an opening with no words yet shows. */
    #empty() {
        const note = document.createElement('p');
        note.className = 'k-opening-preview__note';
        const who = this.name.trim() || 'Your character';
        note.textContent = this.index === 0
            ? `${who} has not said anything yet. Write the first message and it shows here the way the chat will.`
            : 'This opening is empty. Write it in Edit, or remove it there.';
        return note;
    }

    /** @param {MouseEvent} event */
    #onClick(event) {
        // Never out: core's document-level handlers would act on the real chat.
        event.stopPropagation();
        const target = event.target instanceof Element ? event.target : null;
        const delta = target?.closest('.swipe_left') ? -1 : target?.closest('.swipe_right') ? 1 : 0;
        if (delta) {
            this.dispatchEvent(new CustomEvent(OPENING_FLIP_EVENT, { detail: { delta }, bubbles: true }));
        }
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-opening-preview')) {
    customElements.define('k-opening-preview', KOpeningPreview);
}
