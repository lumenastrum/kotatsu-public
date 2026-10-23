/**
 * `<k-backdrop-chip>` — the chat header's Background chip, in the Sprite view only
 * (docs/stage-backdrop-v0.md). It opens a picker of this chat's images: pictures generated here
 * (places first), images already added as backgrounds, an upload, and "No background". A pick is
 * the chat's locked background in core's own keys (backdrop.js), so it sticks to the chat.
 *
 * Light DOM, `css/sprites.css` §5 owns every rule; the popover reuses the header's Scene peek
 * chassis. Rendered by `<k-chat-header>` beside the Scene chip; it hides itself (`hidden`)
 * outside the Sprite look, so the header never needs to know which look is on.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { VARIANT_AXIS_EVENT } from '../../scripts/message-rows.js';
import { BACKDROP_CHANGE_EVENT, canHoldBackdrop, clearBackdrop, installBackdrop, listBackdrops, setBackdrop, uploadBackdrop } from './backdrop.js';
import { spriteLookActive } from './k-sprite-stage.js';

/** How many images the picker shows: the newest, places first. Each is a full-size file. */
const SHOWN = 12;

/** A framed landscape over a stage floor. Stroke glyph, no icon set (repo CLAUDE.md). */
const backdropIcon = html`<svg class="k-bd__icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="11" height="8.5" rx="1.5"/><path d="M2.5 9l3-2.5 2.5 2 2-1.5 3.5 2.5"/><path d="M4.5 13.5h7"/></svg>`;

export class KBackdropChip extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _open: { state: true },
        _busy: { state: true },
        _note: { state: true },
    };

    #onChange = () => this.#sync();

    #onOutsidePress = (/** @type {PointerEvent} */ event) => {
        if (!event.composedPath().includes(this)) this.#close();
    };

    #onKey = (/** @type {KeyboardEvent} */ event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        this.#close();
        /** @type {HTMLElement|null} */ (this.querySelector('.k-bd__chip'))?.focus();
    };

    constructor() {
        super();
        /** @type {string} SPEC §13: every component ships a variant. */
        this.variant = 'chip';
        this._open = false;
        this._busy = false;
        this._note = '';
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        installBackdrop();
        document.addEventListener(BACKDROP_CHANGE_EVENT, this.#onChange);
        document.addEventListener(VARIANT_AXIS_EVENT, this.#onChange);
        this.#sync();
    }

    disconnectedCallback() {
        document.removeEventListener(BACKDROP_CHANGE_EVENT, this.#onChange);
        document.removeEventListener(VARIANT_AXIS_EVENT, this.#onChange);
        this.#close();
        super.disconnectedCallback();
    }

    /** Shown in the Sprite look with a chat open; closed and hidden otherwise. */
    #sync() {
        const shown = spriteLookActive() && canHoldBackdrop();
        this.hidden = !shown;
        if (!shown) this.#close();
        this.requestUpdate();
    }

    #toggle() {
        if (this._open) {
            this.#close();
            return;
        }
        this._note = '';
        this._open = true;
        document.addEventListener('pointerdown', this.#onOutsidePress, true);
        document.addEventListener('keydown', this.#onKey, true);
    }

    #close() {
        this._open = false;
        document.removeEventListener('pointerdown', this.#onOutsidePress, true);
        document.removeEventListener('keydown', this.#onKey, true);
    }

    /** @param {() => Promise<boolean>|boolean|void} action */
    async #run(action) {
        if (this._busy) return;
        this._busy = true;
        this._note = '';
        try {
            const ok = await action();
            if (ok === false) this._note = 'That didn’t take. Try another image.';
        } catch (error) {
            console.error('[k-backdrop-chip]', error);
            this._note = error instanceof Error ? error.message : String(error);
        } finally {
            this._busy = false;
        }
    }

    /** @param {Event} event */
    #onFile(event) {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            this._note = `"${file.name}" isn’t a picture. A PNG, JPG or WebP works.`;
            return;
        }
        void this.#run(() => uploadBackdrop(file));
    }

    #renderPicker() {
        const choices = listBackdrops();
        const current = choices.find(choice => choice.current);
        const shown = choices.slice(0, SHOWN);
        return html`
            <div class="k-bd__peek" id="k-bd-peek" role="dialog" aria-label="Background">
                <div class="k-bd__head">
                    <strong>Background</strong>
                    <span>Behind the characters, in this chat.</span>
                </div>
                ${shown.length ? html`
                    <div class="k-bd__grid" role="group" aria-label="This chat’s images">
                        ${shown.map(choice => html`
                            <button type="button" class="k-bd__thumb" aria-pressed=${choice.current ? 'true' : 'false'}
                                ?disabled=${this._busy} title=${choice.place ? 'A place from Pictures' : choice.from === 'picture' ? 'A picture from this chat' : 'An added image'}
                                @click=${() => this.#run(() => setBackdrop(choice.path))}>
                                <img src=${choice.path} alt="" loading="lazy" decoding="async" draggable="false">
                                ${choice.place ? html`<span class="k-bd__tag">Place</span>` : nothing}
                            </button>`)}
                    </div>` : html`
                    <p class="k-bd__empty">No images in this chat yet. Upload one, or make one in Pictures as <b>The place</b> and choose <b>Use as background</b> on it.</p>`}
                ${this._note ? html`<p class="k-bd__note" role="status">${this._note}</p>` : nothing}
                <div class="k-bd__actions">
                    <label class="k-bd__btn">
                        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" class="k-bd__file"
                            ?disabled=${this._busy} @change=${(/** @type {Event} */ event) => this.#onFile(event)}>
                        Upload an image
                    </label>
                    <button type="button" class="k-bd__btn" ?disabled=${this._busy || !current} @click=${() => this.#run(() => clearBackdrop())}>No background</button>
                </div>
            </div>`;
    }

    render() {
        if (this.hidden) return nothing;
        return html`
            <button type="button" class="k-bd__chip" aria-expanded=${String(this._open)} aria-controls="k-bd-peek"
                title="The background behind the characters" @click=${() => this.#toggle()}>
                ${backdropIcon}<span>Background</span>
            </button>
            ${this._open ? this.#renderPicker() : nothing}`;
    }
}

if (!customElements.get('k-backdrop-chip')) {
    customElements.define('k-backdrop-chip', KBackdropChip);
}
