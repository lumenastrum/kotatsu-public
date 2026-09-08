/*
 * <k-chat-switcher> — the chat title, grown into the switcher (design canvas
 * "Kotatsu Chat Switcher", approved 2026-08-25; the model picker's sibling).
 *
 * The centre header used to print the chat's name twice: once as the title and
 * again inside a pre-BranchStore breadcrumb that faked a `main` trunk beside
 * it. This component replaces both with the name said ONCE, as a door — a
 * title button opening a popover that switches between every chat the card
 * has — plus a branch chip that only exists when the open chat really is a
 * branch. One name, three jobs: the header switches, the rail shortlists,
 * core's manage-files dialog stays the everything-view.
 *
 * MIRRORS, NEVER A SECOND SOURCE OF TRUTH (the <k-model-menu> contract):
 *
 *   - The list is `getPastCharacterChats()` — the same endpoint and the same
 *     fields the left rail and the manage dialog read (`file_id`,
 *     `chat_items`, `last_mes`). Fetched fresh on every open: opening is a
 *     user gesture, and a stale cache on THIS surface would lie about the
 *     thing it exists to switch.
 *   - Switching is `openCharacterChat(fileId)` — the rail's exact path.
 *   - "New chat" clicks `#option_start_new_chat`, keeping core's confirm
 *     flow, guards and group branch intact (the rail's reasoning, verbatim).
 *   - "All chats (N)" clicks `#option_select_chat` — the manage dialog keeps
 *     rename, delete, import and export; none of that is duplicated here.
 *   - Branch facts come from `branchStore.tree()`: the chip names the open
 *     chat's resolved parent (or the sidecar's ghost name for an orphan) and
 *     a row badge counts a chat's direct children. The chip dispatches
 *     `k-open-branch-map`, the same door the top bar and rail use.
 *
 * Everything degrades by absence: groups render the plain title (no fake list
 * is invented for a surface `getPastCharacterChats()` does not serve), a
 * missing options-menu item hides its row, an empty tree means no chip and no
 * badges. The filter field only renders once the card has 8+ chats — a search
 * over three rows is furniture.
 *
 * Light DOM like every shell component, and for the same reasons (the shell
 * sheet reaches in, the layout gate holds, initDynamicStyles audits pairs).
 * Styling lives in `css/shell-center.css` §1b. One-way imports: kotatsu →
 * core, kotatsu → kotatsu peers only.
 */

import { LitElement, html, nothing } from '../lit.js';
import {
    characters,
    getCurrentChatId,
    getPastCharacterChats,
    openCharacterChat,
    this_chid,
} from '../../../script.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { selected_group } from '../../../scripts/group-chats.js';
import { timestampToMoment } from '../../../scripts/utils.js';
import { branchStore } from '../../branches/store.js';

/** The popover's DOM id, for `aria-controls`. */
const POP_ID = 'k-chat-switcher-pop';

/** Chats before the filter field earns its place. */
const FILTER_MIN_CHATS = 8;

/**
 * Events after which the active chat, the character, or the forest may have
 * moved. Looked up by key and skipped when absent (the house pattern).
 */
const REFRESH_EVENTS = [
    'APP_READY',
    'CHAT_CHANGED',
    'CHAT_CREATED',
    'CHAT_DELETED',
    'CHAT_RENAMED',
    'CHARACTER_RENAMED',
    'GROUP_UPDATED',
];

/**
 * Normalises the `last_mes` field of a chat record — the chats endpoint hands
 * back either an ST "humanized" `send_date` string or an mtime in ms, so it
 * goes through core's parser (k-rail-left.js carries this same helper).
 * @param {unknown} value Raw `last_mes` value.
 * @returns {number} Epoch milliseconds, or 0 when unparseable.
 */
function toEpochMs(value) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }
    try {
        const moment = timestampToMoment(value);
        return moment && moment.isValid() ? moment.valueOf() : 0;
    } catch {
        return 0;
    }
}

/**
 * Compact relative time ("now", "5m", "3h", "2d", "2w") — the rail's exact
 * semantics, so the two surfaces never disagree about the same chat.
 * @param {number} ms Epoch milliseconds.
 * @returns {string} Compact label, or '' when there is nothing honest to show.
 */
function toRelative(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '';
    }
    const delta = Date.now() - ms;
    if (delta < 60_000) {
        return 'now';
    }
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days}d`;
    }
    if (days < 365) {
        return `${Math.floor(days / 7)}w`;
    }
    return `${Math.floor(days / 365)}y`;
}

/** @returns {number} The active character index, or -1 when none is selected. */
function activeCharacterIndex() {
    if (selected_group) {
        return -1;
    }
    if (this_chid === undefined || this_chid === null || this_chid === '') {
        return -1;
    }
    const index = Number(this_chid);
    return Number.isInteger(index) && index >= 0 ? index : -1;
}

/**
 * @returns {unknown} Branch glyph — the chip and the row badges.
 */
function branchIcon() {
    return html`
        <svg class="k-cs__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <circle cx="4.5" cy="3.25" r="1.6"></circle>
            <circle cx="4.5" cy="12.75" r="1.6"></circle>
            <circle cx="11.5" cy="6.25" r="1.6"></circle>
            <path d="M4.5 4.85v6.3"></path>
            <path d="M9.9 6.25H8.4A3.9 3.9 0 0 0 4.5 10.15"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Caret — the trigger's tell.
 */
function caretIcon() {
    return html`
        <svg class="k-cs__glyph k-cs__glyph--caret" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m3.5 6 4.5 4.5L12.5 6"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Check glyph — selection marker.
 */
function checkIcon() {
    return html`
        <svg class="k-cs__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <path d="M2.8 8.6 6.3 12l6.9-8"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Plus glyph — the new-chat row.
 */
function plusIcon() {
    return html`
        <svg class="k-cs__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M8 3.2v9.6M3.2 8h9.6"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Magnifier glyph — the filter field.
 */
function filterIcon() {
    return html`
        <svg class="k-cs__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.2"></circle>
            <path d="m13.4 13.4-3.3-3.3"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Folder glyph — the all-chats footer.
 */
function folderIcon() {
    return html`
        <svg class="k-cs__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <path d="M1.8 4.8c0-.7.5-1.2 1.2-1.2h3.4l1.4 1.6h5.2c.7 0 1.2.5 1.2 1.2v5.8c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2Z"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Chevron glyph — the footer's trailing arrow.
 */
function chevronIcon() {
    return html`
        <svg class="k-cs__glyph k-cs__glyph--chevron" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m6 3 5 5-5 5"></path>
        </svg>
    `;
}

/**
 * @typedef {object} SwitcherRow
 * @property {string} id Extension-less `file_id` — what `openCharacterChat()` takes.
 * @property {number|null} count `chat_items` when the endpoint supplied it.
 * @property {string} micro The "N msg · 2d" line, built from honest fields only.
 * @property {number} branchCount Direct children in the branch tree.
 */

/**
 * The chat title button and its switcher popover.
 */
export class KChatSwitcher extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _chatId: { state: true },
        _open: { state: true },
        _query: { state: true },
        _rows: { state: true },
        _pending: { state: true },
        _parentName: { state: true },
    };

    constructor() {
        super();
        /** @type {string} Theme-pack variant hook (SPEC §13). v0 ships one: `popover`. */
        this.variant = 'popover';
        /** @type {string} The open chat's extension-less id — also its title. */
        this._chatId = '';
        /** @type {boolean} Whether the popover is up. */
        this._open = false;
        /** @type {string} Live filter text. */
        this._query = '';
        /** @type {SwitcherRow[]} Rows for the popover, newest first. */
        this._rows = [];
        /** @type {boolean} A fetch is in flight for the current open. */
        this._pending = false;
        /** @type {string} Resolved (or ghost) parent name when the open chat is a branch. */
        this._parentName = '';
        /** @type {number} Guards a stale fetch from painting over a newer open. */
        this._fetchToken = 0;
        /** @type {(() => void) | null} `branchStore.subscribe()` handle. */
        this._unsubscribeBranches = null;
        /** @type {() => void} */
        this._onCoreChange = () => this.refresh();
        /** @type {(event: PointerEvent) => void} */
        this._onOutsidePointer = (event) => {
            if (this._open && event.target instanceof Node && !this.contains(event.target)) {
                this._close({ restoreFocus: false });
            }
        };
        /** @type {string[]} Event names actually bound, for symmetric teardown. */
        this._boundEvents = [];
    }

    /** Light DOM: `public/css/shell-center.css` §1b owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        for (const key of REFRESH_EVENTS) {
            const name = event_types ? event_types[key] : undefined;
            if (typeof name !== 'string' || this._boundEvents.includes(name)) {
                continue;
            }
            eventSource.on(name, this._onCoreChange);
            this._boundEvents.push(name);
        }
        this._unsubscribeBranches = branchStore.subscribe(() => this._syncParentChip());
        document.addEventListener('pointerdown', this._onOutsidePointer);
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this._boundEvents) {
            eventSource.removeListener(name, this._onCoreChange);
        }
        this._boundEvents = [];
        if (this._unsubscribeBranches) {
            this._unsubscribeBranches();
            this._unsubscribeBranches = null;
        }
        document.removeEventListener('pointerdown', this._onOutsidePointer);
        super.disconnectedCallback();
    }

    /**
     * Re-reads the active chat and the chip. Never throws — a header child that
     * crashes at boot takes the strip with it.
     */
    refresh() {
        let chatId = '';
        try {
            chatId = String(getCurrentChatId() ?? '');
        } catch {
            chatId = '';
        }
        const moved = chatId !== this._chatId;
        this._chatId = chatId;
        if (moved && this._open) {
            // The chat under the popover changed (a switch we made, or core's):
            // the list's checkmark is stale — re-pull rather than repaint a lie.
            void this._loadChats();
        }
        this._syncParentChip();
    }

    /**
     * Resolves the open chat's parent from the branch tree — the chip's one
     * fact. An unresolved edge with a ghost name shows the ghost: the sidecar
     * recorded it, and "branched from a file that no longer exists" is still
     * true lineage.
     * @returns {Promise<void>}
     */
    async _syncParentChip() {
        const chatId = this._chatId;
        if (!chatId || activeCharacterIndex() < 0) {
            this._parentName = '';
            return;
        }
        try {
            const tree = await branchStore.tree();
            if (chatId !== this._chatId) {
                return;
            }
            const edge = (tree?.edges ?? []).find((e) => e.child === chatId);
            this._parentName = edge ? String(edge.parent ?? edge.orphanName ?? '') : '';
        } catch {
            this._parentName = '';
        }
    }

    /**
     * Fetches the card's chats — fresh on every open, see the file header.
     * @returns {Promise<void>}
     */
    async _loadChats() {
        const chid = activeCharacterIndex();
        if (chid < 0 || !Array.isArray(characters) || !characters[chid]) {
            this._rows = [];
            this._pending = false;
            return;
        }
        const token = ++this._fetchToken;
        this._pending = true;
        try {
            const [raw, tree] = await Promise.all([
                getPastCharacterChats(chid),
                branchStore.tree().catch(() => null),
            ]);
            if (token !== this._fetchToken) {
                return;
            }
            /** @type {Map<string, number>} */
            const childCounts = new Map();
            for (const edge of tree?.edges ?? []) {
                if (typeof edge.parent === 'string' && edge.parent) {
                    childCounts.set(edge.parent, (childCounts.get(edge.parent) ?? 0) + 1);
                }
            }
            const rows = (Array.isArray(raw) ? raw : [])
                .filter((entry) => entry && typeof entry.file_id === 'string' && entry.file_id.length > 0)
                .map((entry) => {
                    const count = Number.isFinite(Number(entry.chat_items)) ? Number(entry.chat_items) : null;
                    const lastMs = toEpochMs(entry.last_mes);
                    const micro = [
                        count === null ? '' : `${count} msg`,
                        toRelative(lastMs),
                    ].filter(Boolean).join(' · ');
                    return {
                        id: String(entry.file_id),
                        count,
                        micro,
                        branchCount: childCounts.get(String(entry.file_id)) ?? 0,
                        lastMs,
                    };
                });
            rows.sort((a, b) => b.lastMs - a.lastMs);
            this._rows = rows;
        } catch (error) {
            if (token === this._fetchToken) {
                this._rows = [];
            }
            console.error('[k-chat-switcher] chat list read failed', error);
        } finally {
            if (token === this._fetchToken) {
                this._pending = false;
            }
        }
    }

    /**
     * Opens or closes the popover from the title button.
     * @returns {void}
     */
    _toggle() {
        if (this._open) {
            this._close({ restoreFocus: true });
            return;
        }
        this._query = '';
        this._open = true;
        void this._loadChats();
    }

    /**
     * @param {{ restoreFocus: boolean }} options Whether the title takes focus back.
     * @returns {void}
     */
    _close({ restoreFocus }) {
        if (!this._open) {
            return;
        }
        const active = document.activeElement;
        const focusWasInside = active instanceof HTMLElement && this.contains(active);
        this._open = false;
        if (restoreFocus || focusWasInside) {
            const trigger = this.querySelector('.k-cs__trigger');
            if (trigger instanceof HTMLElement) {
                trigger.focus({ preventScroll: true });
            }
        }
    }

    /**
     * Escape closes the popover before core's document-level cascade reads the
     * key as meaning anything else; every other key passes through.
     * @param {KeyboardEvent} event
     * @returns {void}
     */
    _onKeyDown(event) {
        if (event.key !== 'Escape' || !this._open) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this._close({ restoreFocus: true });
    }

    /**
     * Switches to a chat through core's own path, then closes.
     * @param {string} fileId Extension-less chat file id.
     * @returns {void}
     */
    _pick(fileId) {
        if (fileId === this._chatId) {
            this._close({ restoreFocus: true });
            return;
        }
        this._close({ restoreFocus: false });
        void openCharacterChat(fileId);
    }

    /**
     * New chat — the options-menu item, with all of core's guards.
     * @returns {void}
     */
    _newChat() {
        const option = document.getElementById('option_start_new_chat');
        if (!option) {
            return;
        }
        this._close({ restoreFocus: false });
        option.click();
    }

    /**
     * The everything-view: core's manage-chat-files dialog.
     * @returns {void}
     */
    _allChats() {
        const option = document.getElementById('option_select_chat');
        if (!option) {
            return;
        }
        this._close({ restoreFocus: false });
        option.click();
    }

    /**
     * The chip's door — the same event the top bar and rail dispatch.
     * @returns {void}
     */
    _openMap() {
        this.dispatchEvent(new CustomEvent('k-open-branch-map', { bubbles: true, composed: true }));
    }

    render() {
        if (!this._chatId) {
            return nothing;
        }
        // Groups: no chat list exists on the character-chats endpoint, so the
        // title stays plain text — no dead button, no fake list.
        if (activeCharacterIndex() < 0) {
            return html`<span class="k-cs__plain" title=${this._chatId}>${this._chatId}</span>`;
        }
        return html`
            ${this._parentName ? html`
                <button type="button" class="k-cs__chip"
                    title="Branched from ${this._parentName} — open the branch map"
                    @click=${() => this._openMap()}>
                    ${branchIcon()}
                    <span class="k-cs__chip-name">${this._parentName}</span>
                </button>
            ` : nothing}
            <button type="button" class="k-cs__trigger" title=${this._chatId}
                aria-haspopup="true" aria-expanded=${this._open ? 'true' : 'false'}
                aria-controls="${POP_ID}"
                @click=${() => this._toggle()} @keydown=${this._onKeyDown}>
                <span class="k-cs__title">${this._chatId}</span>
                ${caretIcon()}
            </button>
            ${this._open ? this._renderPopover() : nothing}
        `;
    }

    /**
     * @returns {unknown} The popover.
     */
    _renderPopover() {
        const query = this._query.trim().toLowerCase();
        const rows = query
            ? this._rows.filter((row) => row.id.toLowerCase().includes(query))
            : this._rows;
        const characterName = (() => {
            const index = activeCharacterIndex();
            return index >= 0 && Array.isArray(characters)
                ? String(characters[index]?.name ?? '').trim()
                : '';
        })();
        const canNew = document.getElementById('option_start_new_chat') !== null;
        const canBrowse = document.getElementById('option_select_chat') !== null;
        return html`
            <div id="${POP_ID}" class="k-cs__pop" role="group" aria-label="Switch chat"
                @keydown=${this._onKeyDown}>
                <div class="k-cs__label">
                    <span>Chats</span>
                    ${characterName ? html`<span class="k-cs__label-char">${characterName}</span>` : nothing}
                </div>
                ${this._rows.length >= FILTER_MIN_CHATS ? html`
                    <div class="k-cs__filter">
                        ${filterIcon()}
                        <input type="text" class="k-cs__filter-input" placeholder="Filter chats…"
                            aria-label="Filter chats" .value=${this._query}
                            @input=${(/** @type {InputEvent} */ event) => {
        const target = event.target;
        this._query = target instanceof HTMLInputElement ? target.value : '';
    }}>
                    </div>
                ` : nothing}
                <div class="k-cs__list">
                    ${this._pending && this._rows.length === 0 ? html`
                        <div class="k-cs__empty">Loading chats…</div>
                    ` : rows.length === 0 ? html`
                        <div class="k-cs__empty">${query ? 'No chats match.' : 'No chats yet.'}</div>
                    ` : rows.map((row) => html`
                        <button type="button" class="k-cs__row ${row.id === this._chatId ? 'k-cs--selected' : ''}"
                            aria-pressed=${row.id === this._chatId ? 'true' : 'false'}
                            @click=${() => this._pick(row.id)}>
                            <span class="k-cs__mark">${row.id === this._chatId ? checkIcon() : nothing}</span>
                            <span class="k-cs__copy">
                                <span class="k-cs__name">${row.id}</span>
                                ${row.micro ? html`<span class="k-cs__micro">${row.micro}</span>` : nothing}
                            </span>
                            ${row.branchCount > 0 ? html`
                                <span class="k-cs__badge" title="${row.branchCount === 1 ? '1 branch' : `${row.branchCount} branches`}">
                                    ${branchIcon()}
                                    <span>${row.branchCount}</span>
                                </span>
                            ` : nothing}
                        </button>
                    `)}
                </div>
                ${canNew ? html`
                    <button type="button" class="k-cs__row k-cs__row--quiet" @click=${() => this._newChat()}>
                        <span class="k-cs__mark">${plusIcon()}</span>
                        <span class="k-cs__copy"><span class="k-cs__name k-cs__name--quiet">New chat</span></span>
                    </button>
                ` : nothing}
                ${canBrowse ? html`
                    <div class="k-cs__divider" role="presentation"></div>
                    <button type="button" class="k-cs__foot" @click=${() => this._allChats()}>
                        ${folderIcon()}
                        <span class="k-cs__foot-label">All chats (${this._rows.length})</span>
                        ${chevronIcon()}
                    </button>
                ` : nothing}
            </div>
        `;
    }
}

if (!customElements.get('k-chat-switcher')) {
    customElements.define('k-chat-switcher', KChatSwitcher);
}
