/**
 * `<k-scene-studio>` — New scene / Edit scene (`docs/group-chat-v0.md` G2, board "New scene").
 *
 * The group editor, rebuilt. The stock panel (`#rm_group_chats_block`) is parked under rails and
 * is jQuery pagination over module-private state (`newGroupMembers`, `openGroupId`), so unlike the
 * card studio this one does NOT borrow core's controls. It edits the record core itself keeps —
 * the live object in `groups[]` — and saves through core's own `editGroup()`; create posts the
 * same `/api/groups/create` core's `createGroup()` posts. Classic keeps the stock panel, and both
 * write the same JSON. The record ⇄ form logic is `scene-model.js` (tested); this file is the
 * surface and the side effects.
 *
 * Contracts:
 * - **Light DOM**, `variant="sheet"` (SPEC §13). Every rule lives in `public/css/scenes.css`,
 *   rails-gated, with `--k-scene-*` knobs.
 * - **Stacking** matches the card studio (scrim 4100 / sheet 4101); the two never coexist —
 *   opening one closes nothing, but each refuses to open while the other is up.
 * - **Escape** is taken at window capture, like the card studio, so it closes this sheet first.
 * - **Side effects through core's exported paths:** `getCharacters()` (reloads groups too,
 *   `script.js:1377`), `openGroupById()`, `editGroup()`, `deleteGroup()`, `unshallowGroupMembers()`,
 *   `saveMetadata()`; the crop dialog is core's `POPUP_TYPE.CROP`.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import {
    characters,
    chat_metadata,
    getCharacters,
    getRequestHeaders,
    getThumbnailUrl,
    saveMetadata,
} from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import {
    deleteGroup,
    editGroup,
    groups,
    openGroupById,
    selected_group,
    unshallowGroupMembers,
} from '../../scripts/group-chats.js';
import { POPUP_TYPE, Popup, callGenericPopup } from '../../scripts/popup.js';
import { power_user } from '../../scripts/power-user.js';
import { humanizedDateTime } from '../../scripts/RossAscends-mods.js';
import { createThumbnail, getBase64Async, saveBase64AsFile } from '../../scripts/utils.js';
import { OPEN_SCENE_STUDIO_EVENT } from './doors.js';
import { NARRATOR_PACES, NARRATOR_PACE_KEY, isNarratorCard, narratorPace } from './narrator.js';
import { ensureNarratorCard, findNarratorCard } from './narrator-seat.js';
import {
    CARD_MODES,
    TURN_STYLES,
    blankSceneForm,
    castHues,
    createBody,
    formFromGroup,
    formProblems,
    formsDiffer,
    hueColor,
    isFav,
    moveSeat,
    rosterByAvatar,
    suggestedName,
    toggleSeat,
    applyForm,
} from './scene-model.js';

/** Mirrors `--k-scene-z-*` in css/scenes.css and the card studio's STUDIO_Z. */
export const SCENE_STUDIO_Z = Object.freeze({ scrim: 4100, sheet: 4101 });

/** Inline stroke glyphs (repo rule: no emoji, no Font Awesome). */
const icons = {
    close: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4 4 8 8M12 4l-8 8"/></svg>`,
    search: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>`,
    grip: html`<svg viewBox="0 0 10 16" width="8" height="13" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="3" cy="4" r="1.2"/><circle cx="7" cy="4" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="7" cy="8" r="1.2"/><circle cx="3" cy="12" r="1.2"/><circle cx="7" cy="12" r="1.2"/></svg>`,
    arrow: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 8h10M9 4l4 4-4 4"/></svg>`,
    check: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2.8 8.6 6.3 12l6.9-8"/></svg>`,
    image: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m3 12 3.5-4 2.5 3 1.5-1.5L13 12"/><circle cx="10.5" cy="6" r="1"/></svg>`,
    trash: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>`,
    remove: html`<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>`,
    lantern: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.5 4.5a2.5 2.5 0 0 1 5 0"/><path d="M8 6.5h8"/><path d="M8.5 6.5c-1.4 1.6-2 3.6-2 6s.6 4.4 2 6h7c1.4-1.6 2-3.6 2-6s-.6-4.4-2-6"/><path d="M12 10.5c1.1 1.1 1.6 2 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1 .5-1.9 1.6-3z"/><path d="M8 18.5h8"/></svg>`,
};


/**
 * @param {string} name Display name.
 * @returns {string} One or two letters.
 */
function initials(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    return ((Array.from(words[0])[0] ?? '') + (Array.from(words[words.length - 1])[0] ?? '')).toUpperCase();
}

/**
 * @typedef {object} RosterTile
 * @property {string} avatar Card filename.
 * @property {string} name Display name.
 * @property {boolean} fav Favourite.
 * @property {boolean} hasArt False for 'none' / missing avatars.
 */

export class KSceneStudio extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        mode: { type: String, reflect: true },
        groupId: { type: String, attribute: 'group-id' },
        _form: { state: true },
        _query: { state: true },
        _favOnly: { state: true },
        _cover: { state: true },
        _scene: { state: true },
        _busy: { state: true },
        _dragFrom: { state: true },
        _tried: { state: true },
    };

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** @type {(() => void)|null} */
    #onRosterChange = null;

    /** @type {import('./scene-model.js').SceneForm} The form as opened, for "anything changed?". */
    #initial = blankSceneForm();

    /** @type {string} The scene text as opened. */
    #initialScene = '';

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {'create'|'edit'} */
        this.mode = 'create';
        /** @type {string} */
        this.groupId = '';
        /** @type {import('./scene-model.js').SceneForm} */
        this._form = blankSceneForm();
        /** @type {string} */
        this._query = '';
        /** @type {boolean} */
        this._favOnly = false;
        /**
         * A freshly cropped cover not yet on disk (data URL), or '' for none. Written as a file
         * only on save — in create mode the scene's id (its image folder) does not exist yet.
         * @type {string}
         */
        this._cover = '';
        /** @type {string} The scene text (the open chat's `chat_metadata.scenario`). */
        this._scene = '';
        /** @type {boolean} */
        this._busy = false;
        /** @type {number} Seat index being dragged, -1 when none. */
        this._dragFrom = -1;
        /** @type {boolean} Save was attempted, so problems are shown. */
        this._tried = false;
    }

    /** Light DOM: css/scenes.css owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        if (this.mode === 'edit') {
            const group = this.#group();
            this._form = group ? formFromGroup(group, rosterByAvatar(characters)) : blankSceneForm();
        } else {
            this._form = blankSceneForm();
        }
        this.#initial = { ...this._form, members: this._form.members.slice() };
        this._scene = this.#sceneEditable() ? String(chat_metadata?.scenario ?? '') : '';
        this.#initialScene = this._scene;

        this.#onEscape = (event) => {
            if (event.key !== 'Escape' || document.querySelector('dialog[open]')) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            this.close();
        };
        window.addEventListener('keydown', this.#onEscape, { capture: true });
        // A card deleted or a scene changed elsewhere while the sheet is up: repaint the roster
        // and, in edit mode, close if the scene itself is gone.
        this.#onRosterChange = () => {
            if (this.mode === 'edit' && !this.#group()) {
                this.close();
                return;
            }
            this.requestUpdate();
        };
        for (const key of ['CHARACTER_DELETED', 'CHARACTER_EDITED', 'GROUP_UPDATED']) {
            const name = event_types[key];
            if (name) eventSource.on(name, this.#onRosterChange);
        }
        document.body.classList.add('k-scene-studio-open');
    }

    disconnectedCallback() {
        if (this.#onEscape) {
            window.removeEventListener('keydown', this.#onEscape, { capture: true });
            this.#onEscape = null;
        }
        if (this.#onRosterChange) {
            for (const key of ['CHARACTER_DELETED', 'CHARACTER_EDITED', 'GROUP_UPDATED']) {
                const name = event_types[key];
                if (name) eventSource.removeListener(name, this.#onRosterChange);
            }
            this.#onRosterChange = null;
        }
        document.body.classList.remove('k-scene-studio-open');
        super.disconnectedCallback();
    }

    firstUpdated() {
        const target = this.mode === 'create'
            ? this.querySelector('.k-scene-search input')
            : this.querySelector('#k-scene-name');
        if (target instanceof HTMLElement) {
            target.focus({ preventScroll: true });
        }
    }

    /** @returns {void} */
    close() {
        this.remove();
    }

    /** @returns {any|null} The live record being edited. */
    #group() {
        return this.groupId ? (groups.find(g => String(g.id) === String(this.groupId)) ?? null) : null;
    }

    /**
     * The scene text is a property of a CHAT (`chat_metadata.scenario`), not of the record. It is
     * editable here when creating (it lands in the first chat) or when the scene being edited is
     * the one on screen. Anything else would mean loading another chat's file behind the reader.
     * @returns {boolean}
     */
    #sceneEditable() {
        return this.mode === 'create' || (Boolean(selected_group) && String(selected_group) === String(this.groupId));
    }

    /** @returns {RosterTile[]} Every card, A–Z. The narrator is a switch, not a tile. */
    #roster() {
        const list = Array.isArray(characters) ? characters : [];
        return list
            .filter(c => c && typeof c.avatar === 'string' && c.avatar && !isNarratorCard(c))
            .map(c => ({
                avatar: c.avatar,
                name: String(c.name ?? '').trim() || c.avatar,
                fav: isFav(c.fav),
                hasArt: c.avatar !== 'none',
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** @returns {string[]} Seated members' names, in seating order. */
    #memberNames() {
        const byAvatar = rosterByAvatar(characters);
        return this._form.members.map(a => String(byAvatar.get(a)?.name ?? a.replace(/\.[a-z0-9]+$/i, '')));
    }

    /**
     * @param {Partial<import('./scene-model.js').SceneForm>} patch
     * @returns {void}
     */
    #patch(patch) {
        this._form = { ...this._form, ...patch };
    }

    /* ── seats ─────────────────────────────────────────────────────────────── */

    /** @param {string} avatar */
    #toggle(avatar) {
        this.#patch({ members: toggleSeat(this._form.members, avatar) });
    }

    /**
     * @param {number} from
     * @param {number} to
     */
    #move(from, to) {
        this.#patch({ members: moveSeat(this._form.members, from, to) });
    }

    /**
     * Arrow keys move a focused seat; Delete/Backspace unseats it. Focus follows the seat.
     * @param {KeyboardEvent} event
     * @param {number} index
     */
    #onSeatKey(event, index) {
        const last = this._form.members.length - 1;
        let to = -1;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = Math.max(0, index - 1);
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = Math.min(last, index + 1);
        else if (event.key === 'Home') to = 0;
        else if (event.key === 'End') to = last;
        else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            this.#toggle(this._form.members[index]);
            return;
        }
        if (to < 0 || to === index) {
            return;
        }
        event.preventDefault();
        this.#move(index, to);
        void this.updateComplete.then(() => {
            const chip = this.querySelectorAll('.k-scene-seat')[to];
            if (chip instanceof HTMLElement) chip.focus();
        });
    }

    /* ── cover ─────────────────────────────────────────────────────────────── */

    /**
     * Upload → core's crop dialog (unless the user turned resizing off) → a 300px JPEG thumbnail,
     * the same pipeline `uploadGroupAvatar()` runs (`group-chats.js:1896-1935`). Held in memory
     * until save.
     * @param {Event} event
     * @returns {Promise<void>}
     */
    async #onCoverFile(event) {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.files?.length) {
            return;
        }
        const file = input.files[0];
        input.value = '';
        try {
            const dataUrl = await getBase64Async(file);
            const cropped = power_user.never_resize_avatars
                ? dataUrl
                : await callGenericPopup('Set the crop position of the cover', POPUP_TYPE.CROP, '', { cropImage: dataUrl });
            if (!cropped) {
                return;
            }
            this._cover = await createThumbnail(String(cropped), 300, 300);
        } catch (error) {
            console.error('[k-scene-studio] cover read failed', error);
            toastr.error('That picture could not be read.', 'Kotatsu');
        }
    }

    /** Back to the cast collage. The old picture stays on disk (core never deletes it either). */
    #useCollage() {
        this._cover = '';
        this.#patch({ avatar_url: '' });
    }

    /**
     * Writes a pending cover into the scene's own image folder.
     * @param {string} id Group id.
     * @returns {Promise<string>} The stored path, or '' when there was nothing pending.
     */
    async #storeCover(id) {
        if (!this._cover) {
            return '';
        }
        const base64 = this._cover.replace(/^data:image\/[a-z]+;base64,/, '');
        return await saveBase64AsFile(base64, id, `${id}_${humanizedDateTime()}`, 'jpg');
    }

    /* ── save / delete ─────────────────────────────────────────────────────── */

    /** @returns {Promise<void>} */
    async #onSave() {
        this._tried = true;
        if (this._busy || formProblems(this._form).length > 0) {
            return;
        }
        this._busy = true;
        try {
            if (this.mode === 'edit') {
                await this.#saveEdit();
            } else {
                await this.#saveCreate();
            }
        } catch (error) {
            console.error('[k-scene-studio] save failed', error);
            toastr.error('The scene could not be saved. See the console.', 'Kotatsu');
            this._busy = false;
        }
    }

    /**
     * Create: post the record, store a cover under the new id, reload, then open the scene —
     * which is what writes the greetings (`getGroupChat()` on a fresh chat, GC:286). The scene
     * text lands in that first chat once it is on screen.
     * @returns {Promise<void>}
     */
    async #saveCreate() {
        const chatId = humanizedDateTime();
        // First, so its roster reload happens before anything below holds a record.
        const narratorAvatar = this._form.narrator ? await ensureNarratorCard() : '';
        const response = await fetch('/api/groups/create', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(createBody(this._form, this.#memberNames(), chatId, { narratorAvatar })),
        });
        if (!response.ok) {
            throw new Error(`create failed: ${response.status}`);
        }
        const created = await response.json();
        const id = String(created.id);
        const cover = await this.#storeCover(id);
        await getCharacters();
        if (cover || narratorAvatar) {
            const group = groups.find(g => String(g.id) === id);
            if (group) {
                if (cover) group.avatar_url = cover;
                // Not in the create whitelist (groups.js:156-188), so it rides an edit.
                if (narratorAvatar) group[NARRATOR_PACE_KEY] = narratorPace(this._form.narrator_every);
                await editGroup(group.id, true, false);
            }
        }
        const scene = this._scene.trim();
        this.close();
        await openGroupById(id);
        if (scene && String(selected_group) === id) {
            chat_metadata.scenario = scene;
            await saveMetadata();
            // The banner read the chat before the scene text existed; tell it to look again.
            await eventSource.emit(event_types.GROUP_UPDATED);
        }
        toastr.success(`${created.name} is set.`, 'New scene');
    }

    /**
     * Edit: write the form onto the live record and save it through core. A changed cast on the
     * open scene needs its members' full cards before the next reply (core's own add path does
     * the same, GC:1423-1452).
     * @returns {Promise<void>}
     */
    async #saveEdit() {
        // Provisioning reloads the roster (and `groups[]` with it), so it goes before the record
        // is looked up. Switching the narrator off still needs its avatar, to take the seat away.
        const narratorAvatar = this._form.narrator ? await ensureNarratorCard() : findNarratorCard();
        const group = this.#group();
        if (!group) {
            this.close();
            return;
        }
        const before = JSON.stringify(group.members);
        const cover = await this.#storeCover(String(group.id));
        const form = cover ? { ...this._form, avatar_url: cover } : this._form;
        applyForm(group, form, this.#memberNames(), { narratorAvatar });
        const castChanged = before !== JSON.stringify(group.members);
        await editGroup(group.id, true, true);
        const open = Boolean(selected_group) && String(selected_group) === String(group.id);
        if (open && castChanged) {
            await unshallowGroupMembers(String(group.id));
        }
        if (open && this.#sceneEditable() && this._scene !== this.#initialScene) {
            chat_metadata.scenario = this._scene.trim();
            await saveMetadata();
        }
        await eventSource.emit(event_types.GROUP_UPDATED);
        this.close();
    }

    /** @returns {Promise<void>} */
    async #onDelete() {
        const group = this.#group();
        if (!group || this._busy) {
            return;
        }
        const chats = Array.isArray(group.chats) ? group.chats.length : 0;
        const ok = await Popup.show.confirm(
            `Delete “${group.name}”?`,
            `Its ${chats === 1 ? 'chat' : `${chats} chats`} will be deleted too. The characters stay.`,
        );
        if (!ok) {
            return;
        }
        this._busy = true;
        this.close();
        try {
            await deleteGroup(group.id);
        } catch (error) {
            console.error('[k-scene-studio] delete failed', error);
            toastr.error('The scene could not be deleted. See the console.', 'Kotatsu');
        }
    }

    /* ── render ────────────────────────────────────────────────────────────── */

    render() {
        const editing = this.mode === 'edit';
        const group = editing ? this.#group() : null;
        return html`
            <div class="k-scene-scrim" @click=${() => this.close()}></div>
            <section class="k-scene-sheet" role="dialog" aria-modal="true"
                aria-label=${editing ? `Edit scene ${group?.name ?? ''}` : 'New scene'}>
                ${this.#renderHead(editing, group)}
                <div class="k-scene-body">
                    ${this.#renderPicker()}
                    ${this.#renderPanel(editing)}
                </div>
                ${this.#renderFoot(editing)}
            </section>`;
    }

    /**
     * @param {boolean} editing
     * @param {any} group
     * @returns {unknown}
     */
    #renderHead(editing, group) {
        return html`
            <header class="k-scene-head">
                <div class="k-scene-head-copy">
                    <span class="k-scene-eyebrow">${editing ? 'Edit scene' : 'New scene'}</span>
                    <h2 class="k-scene-title">${editing ? (group?.name ?? 'Scene') : 'Who’s in the room?'}</h2>
                </div>
                <label class="k-scene-search">
                    ${icons.search}
                    <input type="search" placeholder="Search your cast…" aria-label="Search your cast"
                        .value=${this._query}
                        @input=${(/** @type {InputEvent} */ e) => { this._query = /** @type {HTMLInputElement} */ (e.target).value; }}>
                </label>
                <button type="button" class="k-scene-close" title="Close (Escape)" aria-label="Close the scene studio"
                    @click=${() => this.close()}>${icons.close}</button>
            </header>`;
    }

    /** @returns {unknown} The cast grid and the seating order. */
    #renderPicker() {
        const roster = this.#roster();
        const favCount = roster.filter(r => r.fav).length;
        const query = this._query.trim().toLowerCase();
        const shown = roster.filter(r => (!this._favOnly || r.fav) && (!query || r.name.toLowerCase().includes(query)));
        const hues = castHues(this._form.members);
        return html`
            <div class="k-scene-picker">
                <div class="k-scene-picker-bar">
                    <span class="k-scene-hint">Click to seat someone. The number is when they speak if they take turns.</span>
                    <div class="k-scene-seg" role="group" aria-label="Show">
                        <button type="button" class=${this._favOnly ? '' : 'is-on'} aria-pressed=${String(!this._favOnly)}
                            @click=${() => { this._favOnly = false; }}>All <span>${roster.length}</span></button>
                        <button type="button" class=${this._favOnly ? 'is-on' : ''} aria-pressed=${String(this._favOnly)}
                            ?disabled=${favCount === 0}
                            @click=${() => { this._favOnly = true; }}>Favorites <span>${favCount}</span></button>
                    </div>
                </div>
                ${shown.length === 0 ? html`
                    <p class="k-scene-empty">${roster.length === 0 ? 'No characters yet. Make or import one first.' : 'Nobody matches.'}</p>
                ` : html`
                    <div class="k-scene-grid">
                        ${shown.map(tile => this.#renderTile(tile, hues))}
                    </div>`}
                ${this.#renderSeats(hues)}
            </div>`;
    }

    /**
     * @param {RosterTile} tile
     * @param {Map<string, number>} hues
     * @returns {unknown}
     */
    #renderTile(tile, hues) {
        const seat = this._form.members.indexOf(tile.avatar);
        const seated = seat >= 0;
        const hue = hues.get(tile.avatar);
        const style = seated && hue !== undefined ? `--seat: ${hueColor(hue)};` : '';
        return html`
            <button type="button" class="k-scene-tile${seated ? ' is-seated' : ''}" style=${style}
                aria-pressed=${String(seated)}
                aria-label=${seated ? `${tile.name}, seat ${seat + 1}. Click to unseat.` : `Seat ${tile.name}`}
                @click=${() => this.#toggle(tile.avatar)}>
                ${tile.hasArt
        // Full-res: a tile is poster-sized, well past core's 96px avatar thumbnail.
        ? html`<img class="k-scene-tile-art" src=${`/characters/${encodeURIComponent(tile.avatar)}`} alt="" loading="lazy" decoding="async">`
        : html`<span class="k-scene-tile-initials" aria-hidden="true">${initials(tile.name)}</span>`}
                <span class="k-scene-tile-shade" aria-hidden="true"></span>
                <span class="k-scene-tile-name">${tile.name}</span>
                <span class="k-scene-tile-seat" aria-hidden="true">${seated ? seat + 1 : ''}</span>
            </button>`;
    }

    /**
     * @param {Map<string, number>} hues
     * @returns {unknown}
     */
    #renderSeats(hues) {
        const byAvatar = rosterByAvatar(characters);
        const members = this._form.members;
        const problem = this._tried ? formProblems(this._form)[0] : '';
        return html`
            <div class="k-scene-seating">
                <span class="k-scene-label" id="k-scene-seating-label">Seating order</span>
                ${members.length === 0 ? html`
                    <p class="k-scene-seats-empty${problem ? ' is-problem' : ''}" role=${problem ? 'alert' : nothing}>
                        ${problem || 'Nobody seated yet.'}
                    </p>
                ` : html`
                    <ol class="k-scene-seats" aria-labelledby="k-scene-seating-label">
                        ${members.map((avatar, index) => {
        const character = byAvatar.get(avatar);
        const name = String(character?.name ?? avatar);
        const hue = hues.get(avatar) ?? 0;
        return html`
                            <li class="k-scene-seat${this._dragFrom === index ? ' is-dragging' : ''}"
                                style=${`--seat: ${hueColor(hue)};`}
                                tabindex="0" draggable="true"
                                aria-label=${`${name}, seat ${index + 1} of ${members.length}. Arrow keys move, Delete unseats.`}
                                @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onSeatKey(e, index)}
                                @dragstart=${(/** @type {DragEvent} */ e) => { this._dragFrom = index; e.dataTransfer?.setData('text/plain', String(index)); }}
                                @dragend=${() => { this._dragFrom = -1; }}
                                @dragover=${(/** @type {DragEvent} */ e) => { if (this._dragFrom >= 0) e.preventDefault(); }}
                                @drop=${(/** @type {DragEvent} */ e) => { e.preventDefault(); if (this._dragFrom >= 0) this.#move(this._dragFrom, index); this._dragFrom = -1; }}>
                                <span class="k-scene-seat-grip">${icons.grip}</span>
                                ${character && avatar !== 'none'
        ? html`<img class="k-scene-seat-face" src=${getThumbnailUrl('avatar', avatar)} alt="">`
        : html`<span class="k-scene-seat-face k-scene-seat-face--initials">${initials(name)}</span>`}
                                <span class="k-scene-seat-name">${name}</span>
                                <button type="button" class="k-scene-seat-x" tabindex="-1" aria-label=${`Unseat ${name}`}
                                    @click=${() => this.#toggle(avatar)}>${icons.remove}</button>
                            </li>`;
    })}
                    </ol>`}
            </div>`;
    }

    /**
     * @param {boolean} editing
     * @returns {unknown}
     */
    #renderPanel(editing) {
        const form = this._form;
        const names = this.#memberNames();
        const joined = form.generation_mode !== 0;
        return html`
            <aside class="k-scene-panel">
                <div class="k-scene-identity">
                    ${this.#renderCover()}
                    <div class="k-scene-field k-scene-field--name">
                        <label class="k-scene-label" for="k-scene-name">Name the scene</label>
                        <input id="k-scene-name" type="text" autocomplete="off" spellcheck="false"
                            placeholder=${suggestedName(names)} .value=${form.name}
                            @input=${(/** @type {InputEvent} */ e) => this.#patch({ name: /** @type {HTMLInputElement} */ (e.target).value })}>
                    </div>
                </div>
                <div class="k-scene-cover-actions">
                    <label class="k-scene-link">
                        ${icons.image}<span>${this._cover || form.avatar_url ? 'Change picture' : 'Use a picture'}</span>
                        <input type="file" accept="image/*" hidden @change=${(/** @type {Event} */ e) => this.#onCoverFile(e)}>
                    </label>
                    ${this._cover || form.avatar_url ? html`
                        <button type="button" class="k-scene-link" @click=${() => this.#useCollage()}>Use the cast collage</button>
                    ` : html`<span class="k-scene-hint">The cover is a collage of the cast.</span>`}
                </div>

                <fieldset class="k-scene-options">
                    <legend class="k-scene-label">Who speaks after you</legend>
                    ${TURN_STYLES.map(style => this.#radio('k-scene-turns', style.value, form.activation_strategy, style.label, style.hint,
        () => this.#patch({ activation_strategy: style.value })))}
                </fieldset>

                ${this.#renderNarrator()}

                <fieldset class="k-scene-options k-scene-options--pair">
                    <legend class="k-scene-label">What each character reads</legend>
                    ${CARD_MODES.filter(mode => !mode.advanced || form.generation_mode === mode.value).map(mode => this.#radio('k-scene-cards', mode.value,
        form.generation_mode, mode.label, mode.hint, () => this.#patch({ generation_mode: mode.value })))}
                </fieldset>

                <div class="k-scene-field">
                    <label class="k-scene-label" for="k-scene-text">Set the scene · optional</label>
                    ${this.#sceneEditable() ? html`
                        <textarea id="k-scene-text" rows="3" placeholder="Where are they, and what’s going on?"
                            .value=${this._scene}
                            @input=${(/** @type {InputEvent} */ e) => { this._scene = /** @type {HTMLTextAreaElement} */ (e.target).value; }}></textarea>
                        <span class="k-scene-hint">Belongs to ${editing ? 'the chat on screen' : 'the first chat'}; every member reads it instead of their own scenario.</span>
                    ` : html`
                        <p class="k-scene-hint">The scene text belongs to a chat. Open the scene to change it.</p>`}
                </div>

                <details class="k-scene-advanced">
                    <summary>Advanced</summary>
                    <div class="k-scene-advanced-body">
                        <label class="k-scene-check${form.activation_strategy === 0 ? '' : ' is-off'}">
                            <input type="checkbox" .checked=${form.allow_self_responses} ?disabled=${form.activation_strategy !== 0}
                                @change=${(/** @type {Event} */ e) => this.#patch({ allow_self_responses: /** @type {HTMLInputElement} */ (e.target).checked })}>
                            <span><b>Let someone answer themselves</b><small>Natural only: the last speaker can go again.</small></span>
                        </label>
                        <label class="k-scene-check">
                            <input type="checkbox" .checked=${form.generation_mode === 2}
                                @change=${(/** @type {Event} */ e) => this.#patch({ generation_mode: /** @type {HTMLInputElement} */ (e.target).checked ? 2 : (form.generation_mode === 2 ? 1 : form.generation_mode) })}>
                            <span><b>Joined cards include muted members</b><small>Only matters when everyone reads the whole cast.</small></span>
                        </label>
                        <div class="k-scene-field k-scene-field--inline">
                            <label class="k-scene-label" for="k-scene-delay">“Let them talk” pace</label>
                            <span class="k-scene-number">
                                <input id="k-scene-delay" type="number" min="1" max="999" step="1" .value=${String(form.auto_mode_delay)}
                                    @change=${(/** @type {Event} */ e) => this.#patch({ auto_mode_delay: Number(/** @type {HTMLInputElement} */ (e.target).value) })}>
                                <span>seconds between replies</span>
                            </span>
                        </div>
                        ${joined ? html`
                            <div class="k-scene-field">
                                <label class="k-scene-label" for="k-scene-prefix">Before each joined card</label>
                                <input id="k-scene-prefix" type="text" placeholder="e.g. [{{char}}'s <FIELDNAME>]" .value=${form.generation_mode_join_prefix}
                                    @input=${(/** @type {InputEvent} */ e) => this.#patch({ generation_mode_join_prefix: /** @type {HTMLInputElement} */ (e.target).value })}>
                            </div>
                            <div class="k-scene-field">
                                <label class="k-scene-label" for="k-scene-suffix">After each joined card</label>
                                <input id="k-scene-suffix" type="text" .value=${form.generation_mode_join_suffix}
                                    @input=${(/** @type {InputEvent} */ e) => this.#patch({ generation_mode_join_suffix: /** @type {HTMLInputElement} */ (e.target).value })}>
                            </div>` : nothing}
                        <label class="k-scene-check">
                            <input type="checkbox" .checked=${form.hideMutedSprites}
                                @change=${(/** @type {Event} */ e) => this.#patch({ hideMutedSprites: /** @type {HTMLInputElement} */ (e.target).checked })}>
                            <span><b>Hide muted members’ sprites</b><small>Character Expressions, visual-novel mode.</small></span>
                        </label>
                    </div>
                </details>
            </aside>`;
    }

    /**
     * The narrator seat (§13): a switch, not a tile, plus its pace during Let them talk.
     * @returns {unknown}
     */
    #renderNarrator() {
        const form = this._form;
        const pace = narratorPace(form.narrator_every);
        return html`
            <fieldset class="k-scene-options k-scene-narrator${form.narrator ? ' is-on' : ''}">
                <legend class="k-scene-label">Narrator</legend>
                <label class="k-scene-check">
                    <input type="checkbox" .checked=${form.narrator}
                        @change=${(/** @type {Event} */ e) => this.#patch({ narrator: /** @type {HTMLInputElement} */ (e.target).checked })}>
                    <span><b><span class="k-scene-narrator-mark">${icons.lantern}</span>Seat a narrator</b><small>Voices the world and anyone outside the cast: strangers, passers-by, whoever the story brings in. It never speaks for the cast.</small></span>
                </label>
                ${form.narrator ? html`
                    <div class="k-scene-seg k-scene-pace" role="radiogroup" aria-label="When the narrator steps in while they talk">
                        ${NARRATOR_PACES.map(option => html`
                            <button type="button" role="radio" aria-checked=${String(option.value === pace)}
                                class=${option.value === pace ? 'is-on' : ''} title=${option.long} aria-label=${option.long}
                                @click=${() => this.#patch({ narrator_every: option.value })}>${option.label}</button>`)}
                    </div>
                    <span class="k-scene-hint">How often it steps in while they talk on their own. You can always call it: tap its seat, or write @Narrator.</span>
                ` : nothing}
            </fieldset>`;
    }

    /** @returns {unknown} Cover preview: the pending crop, the stored picture, or the collage. */
    #renderCover() {
        const form = this._form;
        if (this._cover || form.avatar_url) {
            return html`<img class="k-scene-cover" src=${this._cover || form.avatar_url} alt="Scene cover">`;
        }
        const faces = form.members.slice(0, 4);
        if (faces.length === 0) {
            return html`<span class="k-scene-cover k-scene-cover--empty" aria-hidden="true"></span>`;
        }
        return html`
            <span class="k-scene-cover k-scene-cover--collage" data-count=${faces.length} aria-hidden="true">
                ${faces.map(avatar => html`<img src=${getThumbnailUrl('avatar', avatar)} alt="">`)}
            </span>`;
    }

    /**
     * One radio card. Real `<input type="radio">` inside a label, so arrows move within the group.
     * @param {string} name Group name.
     * @param {number} value This option's value.
     * @param {number} current The form's value.
     * @param {string} label
     * @param {string} hint
     * @param {() => void} pick
     * @returns {unknown}
     */
    #radio(name, value, current, label, hint, pick) {
        const on = value === current;
        return html`
            <label class="k-scene-option${on ? ' is-on' : ''}">
                <input type="radio" name=${name} .checked=${on} @change=${pick}>
                <span class="k-scene-option-copy"><b>${label}</b><small>${hint}</small></span>
            </label>`;
    }

    /**
     * @param {boolean} editing
     * @returns {unknown}
     */
    #renderFoot(editing) {
        const problems = formProblems(this._form);
        const dirty = editing
            ? formsDiffer(this.#initial, this._form) || Boolean(this._cover) || this._scene !== this.#initialScene
            : true;
        return html`
            <footer class="k-scene-foot">
                ${editing ? html`
                    <button type="button" class="k-lib-btn k-lib-btn--ghost k-scene-delete" ?disabled=${this._busy}
                        @click=${() => this.#onDelete()}>${icons.trash}<span>Delete scene</span></button>
                ` : nothing}
                <span class="k-scene-foot-spacer"></span>
                <button type="button" class="k-lib-btn k-lib-btn--ghost" @click=${() => this.close()}>Cancel</button>
                <button type="button" class="k-lib-btn k-lib-btn--primary k-scene-save${problems.length ? ' is-blocked' : ''}"
                    ?disabled=${this._busy || (editing && !dirty)}
                    title=${problems[0] ?? ''}
                    @click=${() => this.#onSave()}>
                    ${editing ? html`${icons.check}<span>Save changes</span>` : html`<span>Start the scene</span>${icons.arrow}`}
                </button>
            </footer>`;
    }

    /** @returns {{ mode: string, groupId: string, members: string[], name: string }} */
    get state() {
        return { mode: this.mode, groupId: this.groupId, members: this._form.members.slice(), name: this._form.name };
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-scene-studio')) {
    customElements.define('k-scene-studio', KSceneStudio);
}

/* ── the host: one document door ─────────────────────────────────────────── */

let installed = false;

/** @type {((event: Event) => void)|null} */
let onOpenRequest = null;

/** @returns {KSceneStudio|null} */
function current() {
    const el = document.querySelector('k-scene-studio');
    return el instanceof KSceneStudio ? el : null;
}

/**
 * Opens the studio. Refuses while the card studio is up (they share a stacking rung) or while a
 * reply is generating in the scene being edited.
 * @param {'create'|string} [target] `'create'` or a group id.
 * @returns {KSceneStudio|null}
 */
export function openSceneStudio(target = 'create') {
    const existing = current();
    if (existing) {
        return existing;
    }
    if (document.body.classList.contains('k-studio-open')) {
        return null;
    }
    const studio = /** @type {KSceneStudio} */ (document.createElement('k-scene-studio'));
    studio.setAttribute('variant', 'sheet');
    if (target !== 'create') {
        const id = String(target);
        if (!groups.some(g => String(g.id) === id)) {
            console.warn(`[k-scene-studio] no scene with id "${id}"`);
            return null;
        }
        studio.mode = 'edit';
        studio.groupId = id;
    }
    document.body.appendChild(studio);
    return studio;
}

/** @returns {void} */
export function closeSceneStudio() {
    current()?.close();
}

/** @returns {object|null} */
export function sceneStudioState() {
    return current()?.state ?? null;
}

/** Wires the document door. Called by the rails layout's mount; idempotent. */
export function installSceneStudio() {
    if (installed) {
        return;
    }
    installed = true;
    onOpenRequest = (event) => {
        const detail = /** @type {CustomEvent} */ (event).detail;
        openSceneStudio(detail?.target ?? 'create');
    };
    document.addEventListener(OPEN_SCENE_STUDIO_EVENT, onOpenRequest);
}

/** Closes an open studio and removes the door. Called by the rails layout's unmount. */
export function uninstallSceneStudio() {
    closeSceneStudio();
    if (!installed) {
        return;
    }
    installed = false;
    if (onOpenRequest) {
        document.removeEventListener(OPEN_SCENE_STUDIO_EVENT, onOpenRequest);
        onOpenRequest = null;
    }
}
