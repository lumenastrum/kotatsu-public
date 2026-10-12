/**
 * `<k-picture-menu variant="tile">` — the menu on a picture Pictures drew (docs/pictures-v0.md §2.3).
 *
 * A small button over the picture opens: Again · Same seed, bigger (when the recipe has a hires
 * variant) · Edit prompt · Use as reference · Set as portrait (a later slice) · Delete this
 * picture. Every verb acts on the picture the gallery is showing (`media_index`).
 *
 * Mounted the way `<k-mes-metrics>` is (metrics native v0): a `.mes_block` child that exists only
 * on rows whose message carries `extra.kotatsu_picture`, painted by event drivers, never written
 * into `#message_template`. Core's `resetRowConditionals()` drops it before a reused row is
 * refilled, so a row can never wear another message's menu; the drivers put it back. It sits
 * right after `.mes_media_wrapper` as a zero-height anchor and the button rides up over the tile
 * (`css/pictures.css` §6), so it is never inside the wrapper core rebuilds on every media paint.
 *
 * The open menu itself is rendered into a host appended to `document.body`, the way core's own
 * popups and templates live (shell-v0 recon: popups were always body children). Measured
 * 2026-10-09 at the slice merge: a `position: fixed` menu left inside the row lost the hit test
 * to the composer (`.k-composer-reason`, `#send_textarea`) whenever it overhung the row near the
 * bottom — `#chat` and `#form_sheld` are static siblings whose `z-index` does nothing, so paint
 * order decided, not the menu's z-index. As a body child the menu's z-index competes in the root
 * stacking context and wins; the row's `.mes_block` overflow can never clip it either.
 */

import { LitElement, html, nothing, render } from '../shell/lit.js';
import { chat, getMediaIndex } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { rowFor } from '../../scripts/message-rows.js';
import { isSettingsModalOpen } from '../settings/k-settings-modal.js';
import { listRecipes } from './jobs-client.js';
import { railsActive, setPendingReference, toast } from './doors.js';
import { deletePicture, editPicturePrompt, rerollPicture } from './picture-actions.js';
import { isCaptionText, isPictureMessage, provenanceFor, variantId } from './picture-model.js';

export const PICTURE_MENU_TAG = 'k-picture-menu';

const icons = {
    menu: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z" /><path d="M12.5 11v3M11 12.5h3" />
        </svg>`,
    again: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M12.5 6.5A5 5 0 1 0 13 9.5" /><path d="M13 3v3.5H9.5" />
        </svg>`,
    bigger: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M9.5 2.5h4v4" /><path d="M6.5 13.5h-4v-4" /><path d="M13.5 2.5 9 7" /><path d="M2.5 13.5 7 9" />
        </svg>`,
    edit: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M10.5 2.5l3 3-8 8h-3v-3z" /><path d="M9 4l3 3" />
        </svg>`,
    reference: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 10.5l3-3 3 3 2-2 3 3" /><circle cx="10.5" cy="6" r="1" />
        </svg>`,
    portrait: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <circle cx="8" cy="6" r="2.5" /><path d="M3.5 13.5c.8-2.4 2.5-3.5 4.5-3.5s3.7 1.1 4.5 3.5" />
        </svg>`,
    delete: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 4.5h10" /><path d="M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5l.7 9h5.6l.7-9" />
        </svg>`,
};

export class KPictureMenu extends LitElement {
    static properties = {
        /** SPEC §13 — `tile` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _open: { state: true },
        _hires: { state: true },
        _place: { state: true },
    };

    /** @type {any} The `chat[]` entry this menu acts on (identity, never a mesid). */
    message = null;

    #onDocKeydown = (/** @type {KeyboardEvent} */ event) => {
        if (event.key !== 'Escape' || event.isComposing || isSettingsModalOpen()) return;
        event.stopPropagation();
        event.preventDefault();
        this.#close(true);
    };

    #onDocPointer = (/** @type {Event} */ event) => {
        if (event.target instanceof Node && (this.contains(event.target) || this.#host?.contains(event.target))) return;
        this.#close(false);
    };

    /** @type {HTMLElement|null} The body child the open menu is rendered into. */
    #host = null;

    /** The body host, created on first open. */
    #ensureHost() {
        if (this.#host?.isConnected) return this.#host;
        const host = document.createElement('div');
        host.className = 'k-pic-menu-host';
        document.body.append(host);
        this.#host = host;
        return host;
    }

    /** Paints (or clears) the menu into the body host; called from `updated()` so Lit state drives it. */
    #paintMenu() {
        if (!this._open || !this.message) {
            if (this.#host) {
                render(nothing, this.#host);
                this.#host.remove();
                this.#host = null;
            }
            return;
        }
        render(this.#menuTemplate(this.message), this.#ensureHost());
    }

    #onScroll = () => this.#close(false);

    constructor() {
        super();
        this.variant = 'tile';
        this._open = false;
        this._hires = '';
        /** @type {{top: number, left: number}} */
        this._place = { top: 0, left: 0 };
    }

    /** Light DOM: `public/css/pictures.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
    }

    disconnectedCallback() {
        this.#unbind();
        this._open = false;
        this.#paintMenu();
        super.disconnectedCallback();
    }

    /** @param {Map<string, unknown>} changed */
    updated(changed) {
        super.updated(changed);
        if (changed.has('_open') || changed.has('_hires') || changed.has('_place')) this.#paintMenu();
    }

    #bind() {
        document.addEventListener('keydown', this.#onDocKeydown, true);
        document.addEventListener('pointerdown', this.#onDocPointer, true);
        document.getElementById('chat')?.addEventListener('scroll', this.#onScroll, { passive: true });
    }

    #unbind() {
        document.removeEventListener('keydown', this.#onDocKeydown, true);
        document.removeEventListener('pointerdown', this.#onDocPointer, true);
        document.getElementById('chat')?.removeEventListener('scroll', this.#onScroll);
    }

    /** @param {boolean} refocus */
    #close(refocus) {
        if (!this._open) return;
        this._open = false;
        this.#unbind();
        if (refocus) /** @type {HTMLElement|null} */ (this.querySelector('.k-pic-tile-btn'))?.focus({ preventScroll: true });
    }

    async #toggle() {
        if (this._open) {
            this.#close(false);
            return;
        }
        const button = /** @type {HTMLElement|null} */ (this.querySelector('.k-pic-tile-btn'));
        const rect = button?.getBoundingClientRect();
        if (rect) {
            // Fixed, so the row's clipping never cuts it; flips above the button near the bottom.
            const menuHeight = 280;
            const below = rect.bottom + 6;
            const top = below + menuHeight > window.innerHeight ? Math.max(8, rect.top - 6 - menuHeight) : below;
            const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 248));
            this._place = { top, left };
        }
        this._open = true;
        this.#bind();
        this._hires = '';
        const provenance = provenanceFor(this.message, getMediaIndex(this.message));
        if (provenance?.recipe) {
            try {
                const recipes = await listRecipes();
                this._hires = variantId(recipes.find(r => r.id === provenance.recipe), 'hires');
            } catch {
                this._hires = '';
            }
        }
        void this.updateComplete.then(() => {
            /** @type {HTMLElement|null} */ (this.#host?.querySelector('.k-pic-menu-item:not([disabled])'))?.focus({ preventScroll: true });
        });
    }

    /** @param {() => unknown} action */
    #run(action) {
        this.#close(false);
        try {
            const result = action();
            if (result instanceof Promise) {
                result.catch(error => {
                    console.error('[Pictures] tile menu action failed', error);
                    toast('error', error instanceof Error ? error.message : String(error));
                });
            }
        } catch (error) {
            console.error('[Pictures] tile menu action failed', error);
        }
    }

    #useAsReference() {
        const media = this.message?.extra?.media?.[getMediaIndex(this.message)];
        if (typeof media?.url !== 'string') return;
        setPendingReference(media.url);
        toast('info', 'The next picture will use this one as its reference.');
    }

    render() {
        return html`
            <button type="button" class="k-pic-tile-btn" aria-haspopup="menu" aria-expanded=${this._open ? 'true' : 'false'}
                    aria-label="Picture options" title="Picture options" @click=${() => this.#toggle()}>${icons.menu}</button>`;
    }

    /**
     * The menu, rendered into the body host (see the header).
     * @param {any} message
     */
    #menuTemplate(message) {
        return html`
                <div class="k-pic-menu" role="menu" aria-label="Picture options"
                     style=${`top: ${this._place.top}px; left: ${this._place.left}px;`}>
                    <button type="button" class="k-pic-menu-item" role="menuitem" data-action="again"
                            @click=${() => this.#run(() => rerollPicture(message, 'again'))}>${icons.again}<span>Again</span></button>
                    ${this._hires ? html`
                        <button type="button" class="k-pic-menu-item" role="menuitem" data-action="bigger"
                                @click=${() => this.#run(() => rerollPicture(message, 'bigger'))}>${icons.bigger}<span>Same seed, bigger</span></button>` : nothing}
                    <button type="button" class="k-pic-menu-item" role="menuitem" data-action="edit"
                            @click=${() => this.#run(() => editPicturePrompt(message))}>${icons.edit}<span>Edit prompt</span></button>
                    <button type="button" class="k-pic-menu-item" role="menuitem" data-action="reference"
                            @click=${() => this.#run(() => this.#useAsReference())}>${icons.reference}<span>Use as reference</span></button>
                    <button type="button" class="k-pic-menu-item" role="menuitem" data-action="portrait" disabled
                            title="Coming in a later update">${icons.portrait}<span>Set as portrait</span><span class="k-pic-menu-later">Later</span></button>
                    <button type="button" class="k-pic-menu-item k-pic-menu-item--danger" role="menuitem" data-action="delete"
                            @click=${() => this.#run(() => deletePicture(message))}>${icons.delete}<span>Delete this picture</span></button>
                </div>`;
    }
}

if (!customElements.get(PICTURE_MENU_TAG)) {
    customElements.define(PICTURE_MENU_TAG, KPictureMenu);
}

/**
 * Paints (or removes) one message's menu. Idempotent: an existing host is reused.
 * @param {any} message A `chat[]` entry.
 * @returns {boolean} Whether a menu is mounted afterwards.
 */
export function paintPictureMenu(message) {
    if (!message || typeof message !== 'object') return false;
    const row = rowFor(message);
    if (!row) return false;
    // Marks the row whose text is only the caption line; pictures.css hides it unless the
    // `captionLine` setting shows it (the text stays in the message for the chat model).
    row.toggleAttribute('data-k-pic-caption', isPictureMessage(message) && isCaptionText(message.mes));
    const block = row.querySelector(':scope > .mes_block');
    let host = /** @type {KPictureMenu|null} */ (block?.querySelector(`:scope > ${PICTURE_MENU_TAG}`) ?? null);
    if (!railsActive() || !isPictureMessage(message)) {
        host?.remove();
        return false;
    }
    const wrapper = block?.querySelector(':scope > .mes_media_wrapper');
    if (!wrapper) return false;
    if (!host) {
        host = /** @type {KPictureMenu} */ (document.createElement(PICTURE_MENU_TAG));
        host.setAttribute('variant', 'tile');
    }
    host.message = message;
    if (host.previousElementSibling !== wrapper || !host.isConnected) wrapper.after(host);
    return true;
}

/**
 * The sweep: walks `chat[]` (the data), lets `rowFor()` say which messages own a mounted row.
 * @returns {number} Menus mounted afterwards.
 */
export function sweepPictureMenus() {
    if (!Array.isArray(chat)) return 0;
    let painted = 0;
    for (const message of chat) {
        if (message?.extra && paintPictureMenu(message)) painted++;
    }
    return painted;
}

/** @param {number|string} messageId */
function onMessageRendered(messageId) {
    const message = Array.isArray(chat) ? chat[Number(messageId)] : null;
    if (message) paintPictureMenu(message);
}

/** Drivers: the single-row render event, and the chat-wide sweeps after (re)prints. */
const DRIVERS = /** @type {const} */ ([
    ['CHARACTER_MESSAGE_RENDERED', onMessageRendered],
    ['MESSAGE_UPDATED', onMessageRendered],
    ['MESSAGE_SWIPED', onMessageRendered],
    ['CHAT_CHANGED', sweepPictureMenus],
    ['MORE_MESSAGES_LOADED', sweepPictureMenus],
]);

/** @returns {void} */
export function installPictureMenus() {
    for (const [key, handler] of DRIVERS) {
        const name = /** @type {Record<string, string>} */ (event_types)[key];
        if (name) eventSource.on(name, handler);
    }
    sweepPictureMenus();
}

/** @returns {void} */
export function uninstallPictureMenus() {
    for (const [key, handler] of DRIVERS) {
        const name = /** @type {Record<string, string>} */ (event_types)[key];
        if (name) eventSource.removeListener(name, handler);
    }
    for (const host of document.querySelectorAll(`#chat ${PICTURE_MENU_TAG}`)) host.remove();
}
