/**
 * `<k-portrait-peek>` — what a click on a row portrait opens under rails (docs/portrait-peek-v0.md).
 *
 * Core's answer is a MovingUI-era draggable "zoomed avatar" appended to `<body>`
 * (`script.js` `$(document).on('click', '.mes .avatar')`). Under rails it lands as a 0×0 box
 * behind the left rail. This replaces it, rails-only, with two modes of one element:
 *
 * - **peek** — a sheet over the right rail (a bottom sheet on a phone): the portrait, name,
 *   byline, creator's note, her chats, and doors to the studio and a new chat.
 * - **art** — a lightbox with the full-size image. Reached from the peek's "Full art" button, or
 *   directly for any portrait that has no card to peek at (the user's persona, a system message).
 *
 * Interception: ONE capture-phase click listener on `#chat` (node identity frozen by CONTRACT
 * §1.7) claims portrait clicks and stops them, so core's delegated document handler never runs
 * under rails. Classic installs nothing and keeps core's zoom.
 *
 * House patterns: light DOM (`css/portrait-peek.css` owns every rule), `display: contents` on the
 * host so the scrim and sheet carry page-level z-indices (the studio's lesson), a `variant`
 * attribute (SPEC §13; `sheet` is the only v0 variant), one-way imports, and every side effect
 * routed through the same door the rest of the shell uses — the studio's open event, the
 * branch store's `switchTo()`, a real click on core's "Start new chat" item.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import {
    characters,
    getCurrentChatId,
    getPastCharacterChats,
    getThumbnailUrl,
    openCharacterChat,
    selectCharacterById,
    this_chid,
} from '../../script.js';
import { selected_group } from '../../scripts/group-chats.js';
import { getUserAvatar } from '../../scripts/personas.js';
import { timestampToMoment } from '../../scripts/utils.js';
import { branchStore } from '../branches/store.js';
import { chatLabelText } from '../shell/chat-label.js';
import { toRelative } from '../shell/relative-time.js';
import { isSettingsModalOpen } from '../settings/k-settings-modal.js';
import { OPEN_STUDIO_EVENT } from '../studio/manifest.js';
import { byline, cardFacts, characterArtUrl, portraitMode, thumbnailTarget } from './portrait-target.js';

/** Class on the clicked `.avatar` while the peek is open: the ring that says where it came from. */
const SOURCE_CLASS = 'k-pp-source';

/** Chats listed before the sheet stops; the left rail and "All chats" hold the rest. */
const MAX_CHATS = 4;

const icons = {
    close: html`
        <svg class="k-pp-icon" viewBox="0 0 16 16" width="16" height="16" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    expand: html`
        <svg class="k-pp-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M10 2.5h3.5V6" /><path d="M6 13.5H2.5V10" /><path d="M13.5 2.5 9 7" /><path d="M2.5 13.5 7 9" />
        </svg>`,
};

/**
 * @param {unknown} value A `last_mes` timestamp in any of core's formats.
 * @returns {number} Epoch ms, or 0 when unreadable.
 */
function toEpochMs(value) {
    if (value === undefined || value === null || value === '') return 0;
    try {
        const moment = timestampToMoment(value);
        return moment && moment.isValid() ? moment.valueOf() : 0;
    } catch {
        return 0;
    }
}

/**
 * @typedef {object} ChatRow
 * @property {string} id Extension-less chat id.
 * @property {number|null} count Message count.
 * @property {number} lastMs Last message, epoch ms.
 */

export class KPortraitPeek extends LitElement {
    static properties = {
        /** SPEC §13 — `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** `peek` or `art`. Reflected: the stylesheet keys on it. */
        mode: { type: String, reflect: true },
        _chats: { state: true },
        _chatsPending: { state: true },
    };

    /** Character index the peek is about; -1 in a bare art view. */
    charIndex = -1;
    /** Full-size image for the art view. */
    artUrl = '';
    /** Fallback when the full-size image fails: the row's own thumbnail. */
    thumbUrl = '';
    /** Name for alt text and the art caption. */
    artName = '';
    /** Whether the art view was opened from the peek, so closing it goes back there. */
    #artFromPeek = false;
    /** @type {HTMLElement|null} */
    #source = null;
    #onKeydown = (/** @type {KeyboardEvent} */ event) => this.#handleKeydown(event);

    constructor() {
        super();
        this.variant = 'sheet';
        this.mode = 'peek';
        /** @type {ChatRow[]} */
        this._chats = [];
        this._chatsPending = false;
    }

    /** Light DOM: `public/css/portrait-peek.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        // Capture at the document, like the Author's Note sheet: the topmost surface answers
        // Escape before RossAscends-mods' bubble-phase cascade can also act on it.
        document.addEventListener('keydown', this.#onKeydown, true);
    }

    disconnectedCallback() {
        document.removeEventListener('keydown', this.#onKeydown, true);
        this.#source?.classList.remove(SOURCE_CLASS);
        this.#source = null;
        super.disconnectedCallback();
    }

    /**
     * @param {HTMLElement|null} source The clicked `.avatar`.
     */
    set source(source) {
        this.#source?.classList.remove(SOURCE_CLASS);
        this.#source = source;
        if (this.mode === 'peek') source?.classList.add(SOURCE_CLASS);
    }

    firstUpdated() {
        if (this.mode === 'peek') void this.#loadChats();
        this.#focusClose();
    }

    close() {
        this.remove();
    }

    #focusClose() {
        void this.updateComplete.then(() => {
            /** @type {HTMLElement|null} */ (this.querySelector('.k-pp-close'))?.focus({ preventScroll: true });
        });
    }

    /** @param {KeyboardEvent} event */
    #handleKeydown(event) {
        if (event.key !== 'Escape' || event.isComposing) return;
        // Something more immediate is up (the settings modal rides above us): let it answer.
        if (isSettingsModalOpen()) return;
        event.stopPropagation();
        event.preventDefault();
        this.#back();
    }

    /** Escape, the scrim and the art's own click all step back one level. */
    #back() {
        if (this.mode === 'art' && this.#artFromPeek) {
            this.#artFromPeek = false;
            this.mode = 'peek';
            this.#source?.classList.add(SOURCE_CLASS);
            this.#focusClose();
            return;
        }
        this.close();
    }

    #showArt() {
        this.#artFromPeek = true;
        this.mode = 'art';
        this.#focusClose();
    }

    get #character() {
        return Array.isArray(characters) ? characters[this.charIndex] : undefined;
    }

    /** Whether the peeked character owns the chat on screen (and it is not a group chat). */
    get #isActive() {
        return !selected_group && String(this_chid) === String(this.charIndex);
    }

    async #loadChats() {
        const index = this.charIndex;
        this._chatsPending = true;
        try {
            const raw = await getPastCharacterChats(index);
            if (index !== this.charIndex) return;
            this._chats = (Array.isArray(raw) ? raw : [])
                .filter(entry => entry && typeof entry.file_id === 'string' && entry.file_id.length > 0)
                .map(entry => ({
                    id: String(entry.file_id),
                    count: Number.isFinite(Number(entry.chat_items)) ? Number(entry.chat_items) : null,
                    lastMs: toEpochMs(entry.last_mes),
                }))
                .sort((a, b) => b.lastMs - a.lastMs);
        } catch (error) {
            console.error('[k-portrait-peek] chat list read failed', error);
            this._chats = [];
        } finally {
            this._chatsPending = false;
        }
    }

    /** @param {string} fileId */
    async #openChat(fileId) {
        const index = this.charIndex;
        const wasActive = this.#isActive;
        this.close();
        if (wasActive) {
            await branchStore.switchTo(fileId);
            return;
        }
        // A group member, or a character whose chat is not on screen: select her first — the
        // same thing the left rail's character list does — then open the file if it is not the
        // one selecting landed on.
        try {
            await selectCharacterById(index);
            if (getCurrentChatId() !== fileId) await openCharacterChat(fileId);
        } catch (error) {
            console.error('[k-portrait-peek] could not open the chat', error);
        }
    }

    #openStudio() {
        const index = this.charIndex;
        this.close();
        document.dispatchEvent(new CustomEvent(OPEN_STUDIO_EVENT, {
            bubbles: true,
            composed: true,
            detail: { target: index, source: 'k-portrait-peek' },
        }));
    }

    /**
     * A real click on core's "Start new chat" item, as the left rail does: the `is_send_press`
     * guard and the confirm with its delete-current checkbox live in that handler.
     */
    #newChat() {
        this.close();
        document.getElementById('option_start_new_chat')?.click();
    }

    #allChats() {
        this.close();
        document.getElementById('option_select_chat')?.click();
    }

    /** @param {Event} event */
    #onArtError(event) {
        const img = /** @type {HTMLImageElement} */ (event.currentTarget);
        if (this.thumbUrl && img.getAttribute('src') !== this.thumbUrl) img.src = this.thumbUrl;
    }

    render() {
        return this.mode === 'art' ? this.#renderArt() : this.#renderPeek();
    }

    #renderArt() {
        return html`
            <div class="k-pp-scrim k-pp-scrim--art" @click=${() => this.#back()}></div>
            <figure class="k-pp-art" role="dialog" aria-modal="true" aria-label=${this.artName || 'Portrait'}>
                <img class="k-pp-art-img" src=${this.artUrl} alt=${this.artName || 'Portrait'}
                     draggable="false" @error=${this.#onArtError} @click=${() => this.#back()}>
                <figcaption class="k-pp-art-caption">
                    ${this.artName ? html`<span class="k-pp-art-name">${this.artName}</span>` : nothing}
                    <span class="k-pp-art-hint">Esc or click outside to close</span>
                </figcaption>
            </figure>
            <button type="button" class="k-pp-close k-pp-close--art" aria-label="Close"
                    @click=${() => this.#back()}>${icons.close}</button>`;
    }

    #renderPeek() {
        const character = this.#character;
        if (!character) return nothing;
        const facts = cardFacts(character);
        const by = byline(facts);
        const active = this.#isActive;

        return html`
            <div class="k-pp-scrim" @click=${() => this.close()}></div>
            <aside class="k-pp-sheet" role="dialog" aria-modal="true" aria-label=${facts.name}>
                <span class="k-pp-grip" aria-hidden="true"></span>
                <div class="k-pp-hero">
                    <img class="k-pp-hero-img" src=${this.artUrl} alt="" draggable="false" @error=${this.#onArtError}>
                    <button type="button" class="k-pp-full" aria-label=${`Full art of ${facts.name}`}
                            @click=${() => this.#showArt()}>${icons.expand}<span class="k-pp-full-label">Full art</span></button>
                </div>
                <div class="k-pp-head">
                    <h2 class="k-pp-name">${facts.name}</h2>
                    ${by ? html`<p class="k-pp-byline">${by}</p>` : nothing}
                </div>
                <div class="k-pp-body">
                    ${facts.note ? html`
                        <section class="k-pp-note">
                            <h3 class="k-pp-label">Creator's note</h3>
                            <p class="k-pp-note-text">${facts.note}</p>
                        </section>` : nothing}
                    ${this.#renderChats(facts.name, active)}
                </div>
                <div class="k-pp-actions">
                    <button type="button" class="k-pp-btn k-pp-btn--primary" @click=${() => this.#openStudio()}>Edit in Studio</button>
                    ${active ? html`
                        <button type="button" class="k-pp-btn" @click=${() => this.#newChat()}>New chat</button>` : nothing}
                </div>
                <button type="button" class="k-pp-close" aria-label="Close" @click=${() => this.close()}>${icons.close}</button>
            </aside>`;
    }

    /**
     * @param {string} name Character name, for chat labels.
     * @param {boolean} active Whether her chat is the one on screen.
     */
    #renderChats(name, active) {
        const current = active ? getCurrentChatId() : '';
        let body;
        if (this._chatsPending && this._chats.length === 0) {
            body = html`<p class="k-pp-quiet">Loading chats…</p>`;
        } else if (this._chats.length === 0) {
            body = html`<p class="k-pp-quiet">No chats yet</p>`;
        } else {
            body = this._chats.slice(0, MAX_CHATS).map(row => {
                const here = row.id === current;
                const meta = [here ? 'here' : '', row.count ?? ''].filter(part => part !== '').join(' · ');
                const when = row.lastMs ? toRelative(row.lastMs) : '';
                return html`
                    <button type="button" class="k-pp-chat${here ? ' is-here' : ''}"
                            aria-current=${here ? 'true' : 'false'} title=${when ? `${row.id} · ${when}` : row.id}
                            @click=${() => here ? this.close() : this.#openChat(row.id)}>
                        <span class="k-pp-chat-name">${chatLabelText(row.id, name)}</span>
                        ${meta ? html`<span class="k-pp-chat-meta">${meta}</span>` : nothing}
                    </button>`;
            });
        }
        const more = active && this._chats.length > MAX_CHATS;
        return html`
            <section class="k-pp-chats">
                <h3 class="k-pp-label">Chats</h3>
                ${body}
                ${more ? html`
                    <button type="button" class="k-pp-more" @click=${() => this.#allChats()}>All ${this._chats.length} chats</button>` : nothing}
            </section>`;
    }
}

if (!customElements.get('k-portrait-peek')) {
    customElements.define('k-portrait-peek', KPortraitPeek);
}

/** @type {HTMLElement|null} */
let boundChat = null;

/**
 * Claims portrait clicks before they reach core's delegated zoom handler.
 * @param {MouseEvent} event
 */
function onChatClickCapture(event) {
    const target = /** @type {Element|null} */ (event.target);
    const avatar = target && typeof target.closest === 'function' ? target.closest('.mes .avatar') : null;
    if (!(avatar instanceof HTMLElement) || !boundChat?.contains(avatar)) return;
    const row = avatar.closest('.mes');
    const img = avatar.querySelector('img');
    if (!row || !img) return;

    event.stopPropagation();
    event.preventDefault();
    openPortrait(avatar, row, img);
}

/**
 * Opens the peek (or the art view) for one row portrait.
 * @param {HTMLElement} avatar The clicked `.avatar`.
 * @param {Element} row Its `.mes` row.
 * @param {HTMLImageElement} img The portrait image.
 */
function openPortrait(avatar, row, img) {
    document.querySelector('k-portrait-peek')?.remove();

    const src = img.getAttribute('src') ?? '';
    const target = thumbnailTarget(src);
    const isUser = row.getAttribute('is_user') === 'true';
    const charIndex = target && target.type === 'avatar' && Array.isArray(characters)
        ? characters.findIndex(c => c?.avatar === target.file)
        : -1;
    const mode = portraitMode({ isUser, target, charIndex });

    let artUrl = src;
    if (target?.type === 'avatar' && charIndex >= 0) artUrl = characterArtUrl(target.file);
    else if (target?.type === 'persona') artUrl = getUserAvatar(target.file);

    const peek = /** @type {KPortraitPeek} */ (document.createElement('k-portrait-peek'));
    peek.setAttribute('variant', 'sheet');
    peek.mode = mode;
    peek.charIndex = mode === 'peek' ? charIndex : -1;
    peek.artUrl = artUrl;
    peek.thumbUrl = src;
    peek.artName = mode === 'peek'
        ? cardFacts(characters[charIndex]).name
        : (row.querySelector('.name_text')?.textContent ?? '').trim();
    document.body.appendChild(peek);
    peek.source = avatar;
}

/**
 * Opens the peek for a character by card filename, from anywhere — the scene stage's member
 * menu (`docs/group-chat-v0.md` G3) has a seat, not a chat row. Same sheet, same mode rules.
 * @param {string} file Card filename (`characters[i].avatar`).
 * @param {HTMLElement|null} [source] The control that asked, ringed while the peek is open.
 * @returns {boolean} False when there is no such card.
 */
export function openCharacterPeek(file, source = null) {
    const charIndex = Array.isArray(characters) ? characters.findIndex(c => c?.avatar === file) : -1;
    if (charIndex < 0) {
        return false;
    }
    document.querySelector('k-portrait-peek')?.remove();
    const peek = /** @type {KPortraitPeek} */ (document.createElement('k-portrait-peek'));
    peek.setAttribute('variant', 'sheet');
    peek.mode = 'peek';
    peek.charIndex = charIndex;
    peek.artUrl = characterArtUrl(file);
    peek.thumbUrl = getThumbnailUrl('avatar', file);
    peek.artName = cardFacts(characters[charIndex]).name;
    document.body.appendChild(peek);
    if (source) peek.source = source;
    return true;
}

/**
 * Binds the capture listener. Called by the rails layout's `mount()`; idempotent.
 * @returns {void}
 */
export function installPortraitPeek() {
    if (boundChat) return;
    const chat = document.getElementById('chat');
    if (!chat) {
        console.warn('[k-portrait-peek] #chat is missing; portrait clicks keep core\'s zoom.');
        return;
    }
    boundChat = chat;
    chat.addEventListener('click', onChatClickCapture, true);
}

/**
 * Unbinds and closes. Called by the rails layout's `unmount()`, so classic gets core's zoom back.
 * @returns {void}
 */
export function uninstallPortraitPeek() {
    document.querySelector('k-portrait-peek')?.remove();
    boundChat?.removeEventListener('click', onChatClickCapture, true);
    boundChat = null;
}
