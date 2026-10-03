/**
 * `<k-rail-left>` — the rails-layout left rail (shell v0 slice B; the Branches
 * section is branch panel v0 slice C).
 *
 * Three sections, per `docs/shell-v0.md` §"The target":
 *   1. Characters — roster rows (initials chip · name · last-chat recency).
 *   2. Chats      — the selected character's chat files (title · message count).
 *   3. Branches   — the open chat's lineage, its children, and the map door
 *                   (`docs/branch-panel-v0.md` §"The rail section").
 *
 * Contracts this component honours:
 *
 * - **Light DOM.** `createRenderRoot()` returns `this`, so every rule lives in
 *   `public/css/shell-left.css` and a theme pack's `sheet.css` can reach these
 *   rows. Shadow DOM would let `--k-*` custom properties through but would put
 *   the rail beyond the reach of both the shell sheet and the pack layer.
 * - **SPEC §13 variant attribute.** `variant="list"` is the only v0 variant; the
 *   attribute is present anyway so a second one can be added without a DOM change.
 * - **One-way imports.** kotatsu → core only. Nothing here is imported by core.
 *   `branches/store.js` is a kotatsu peer, so importing it keeps that rule.
 * - **No reimplemented side effects.** Every click drives the same exported core
 *   path the classic UI uses: `selectCharacterById()`, `openCharacterChat()`, and
 *   a real click on `#option_select_chat`. Create routes through the card
 *   studio's `OPEN_STUDIO_EVENT` (the gallery's route), whose open path fires
 *   the real `#rm_button_create.click()` — the three handlers hanging off that
 *   button (script.js:11152, RossAscends-mods.js:199, the delegated
 *   tags.js:2779) still all run. Branch navigation goes through
 *   `branchStore.switchTo()` for the same reason.
 * - **Read and navigate only.** Rename and delete are the map's (slice D); this
 *   rail never mutates the forest, so a misclick here cannot cost a chat file.
 * - **No fabricated data.** Message counts are `chat_items` off the chats endpoint;
 *   recency is `date_last_chat` (ms) off the character record; every branch number
 *   is a field the sidecar actually recorded. Where a number is missing the column
 *   is dropped, never invented — an orphaned ancestor shows the ghost NAME the
 *   sidecar kept and nothing else.
 *
 * Boot order: the element may mount before `getCharacters()` has resolved. Every
 * core read is guarded and the empty state is quiet; `APP_READY` is a sticky event
 * on core's emitter (`events.js:113`), so a late subscription still fires once.
 *
 * Footer slot (persona menu follow-up). The host used to be the ONE scrolling
 * box — `overflow-y: auto` lived directly on `k-rail-left[variant="list"]`
 * (`css/shell-left.css`) — which would have carried a bottom-pinned chip away
 * with the rest of the content the moment the roster or the branch chain grew
 * tall enough to scroll. The smallest fix that keeps a real footer OUTSIDE that
 * scroll: the three sections that used to be this component's whole render
 * output now render into an inner `.k-rl-scroll` wrapper (which inherits the
 * old scrolling behaviour verbatim), and a `.k-rl-footer` sibling sits below it,
 * pinned by flex layout rather than position — `css/shell-left.css` gives the
 * host `flex: 1 1 auto` / `min-height: 0` and puts `flex: 0 0 auto` on the
 * footer, the same "shrink the scroller, not the chrome" shape `#chat` already
 * uses in `css/shell-frame.css`. `<k-persona-menu>` mounts there via a
 * side-effect import — one peer component reading and driving core the same
 * way `branchStore` does, not a second layout slot: no change to `rails.js`'s
 * `COMPONENT_SLOTS`, no new placeholder-degradation path to maintain.
 */

import { toRelative } from '../relative-time.js';
import { LitElement, html, nothing } from '../lit.js';
import {
    characters,
    chat,
    getCurrentChatId,
    getPastCharacterChats,
    getThumbnailUrl,
    openCharacterChat,
    selectCharacterById,
    this_chid,
} from '../../../script.js';
import { EMPTY_TREE, branchStore } from '../../branches/store.js';
import { OPEN_STUDIO_EVENT } from '../../studio/manifest.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { selected_group } from '../../../scripts/group-chats.js';
import { timestampToMoment } from '../../../scripts/utils.js';
// Side-effect import: defines <k-persona-menu>, rendered in the footer below.
import './k-persona-menu.js';
import { chatLabelText } from '../chat-label.js';

/** @typedef {import('../../branches/store.js').BranchTree} BranchTree */
/** @typedef {import('../../branches/store.js').BranchTreeEdge} BranchTreeEdge */
/** @typedef {import('../../branches/store.js').BranchTreeFile} BranchTreeFile */

/** Visible roster rows before the list collapses into a "+N more" row. */
const ROSTER_VISIBLE_MAX = 8;

/** Visible chat rows before the list collapses into a "+N more" row. */
const CHATS_VISIBLE_MAX = 6;

/**
 * Lineage rows drawn before the chain elides its middle. The worst real
 * character folder measures a max depth of 9 (`docs/branch-panel-v0.md`
 * §"What ships in v0"), which is more chain than a 280px rail can spend on one
 * section — so the root, an elision row and the last four hops are kept, and the
 * rest is the map's job.
 */
const LINEAGE_VISIBLE_MAX = 6;

/** Visible child-branch rows before the list collapses into a "+N more" row. */
const BRANCH_CHILDREN_VISIBLE_MAX = 5;

/** Coalescing window for bursty core events (a chat switch fires several). */
const REFRESH_DEBOUNCE_MS = 80;

/**
 * Core events after which the rail's data may be stale.
 * Deliberately excludes the per-token streaming events; message counts are
 * refreshed from the in-memory `chat` array instead (see `#syncActiveChatCount`),
 * which costs nothing and keeps the network out of the generation loop.
 */
const REFRESH_EVENTS = [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.CHAT_CREATED,
    event_types.CHAT_DELETED,
    event_types.CHAT_RENAMED,
    event_types.CHARACTER_PAGE_LOADED,
    event_types.CHARACTER_EDITED,
    event_types.CHARACTER_DELETED,
    event_types.CHARACTER_DUPLICATED,
    event_types.CHARACTER_RENAMED,
    event_types.GROUP_UPDATED,
];

/**
 * The subset of {@link REFRESH_EVENTS} that invalidates the chat list itself.
 * Everything else (a roster reprint from a tag filter, say) may reuse the last
 * fetch, which keeps `printCharacters()` from firing a request per keystroke.
 */
const CHAT_LIFECYCLE_EVENTS = new Set([
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.CHAT_CREATED,
    event_types.CHAT_DELETED,
    event_types.CHAT_RENAMED,
    event_types.CHARACTER_DELETED,
    event_types.CHARACTER_RENAMED,
]);

/**
 * Core events that only change the active chat's message count. Handled from the
 * in-memory `chat` array instead of a refetch: `chat` holds every message (the
 * `power_user.chat_truncation` limit is a display slice — `script.js:1481`), and
 * all four fire after the array has settled (e.g. `script.js:5890-5892`).
 */
const COUNT_EVENTS = [
    event_types.MESSAGE_SENT,
    event_types.MESSAGE_RECEIVED,
    event_types.MESSAGE_DELETED,
    event_types.MESSAGE_SWIPE_DELETED,
];

/**
 * @typedef {object} RosterRow
 * @property {number} id Index into the live `characters` array — the argument
 *   `selectCharacterById()` expects (character index, NOT the avatar key).
 * @property {string} name Display name (user data; rendered as text only).
 * @property {string} initials Up to two uppercase letters for the fallback chip.
 * @property {string} avatar Card image filename, or '' when the record has none —
 *   rendered through core's own `getThumbnailUrl()`, never a raw characters/ path.
 * @property {number} lastChat `date_last_chat` in epoch ms, or 0 when unknown.
 */

/**
 * @typedef {object} ChatRow
 * @property {string} id Extension-less chat id (`file_id`) — what
 *   `openCharacterChat()` takes and what `getCurrentChatId()` returns.
 * @property {string} title Row label. The chat file's own name; nothing derived.
 * @property {number|null} count `chat_items` when the endpoint supplied it.
 * @property {number} lastMs Timestamp of the last message, epoch ms, or 0.
 */

/**
 * Two-letter chip text for a display name. Code-point safe (names carry emoji).
 * @param {string} name Character display name.
 * @returns {string} One or two uppercase characters, or `?` for an empty name.
 */
function toInitials(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return '?';
    }
    if (words.length === 1) {
        const letters = Array.from(words[0]).slice(0, 2).join('');
        return letters.toUpperCase();
    }
    const first = Array.from(words[0])[0] ?? '';
    const second = Array.from(words[words.length - 1])[0] ?? '';
    return (first + second).toUpperCase();
}


/**
 * Normalises the `last_mes` field of a chat record. The chats endpoint hands
 * back either an ST "humanized" `send_date` string or an mtime in ms
 * (`src/endpoints/chats.js:365-420`), so it goes through core's parser.
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

/** @returns {string} The active character's name, or '' in a group / with none selected. */
function activeCharacterName() {
    const index = activeCharacterIndex();
    return index >= 0 && Array.isArray(characters) ? String(characters[index]?.name ?? '').trim() : '';
}

/**
 * Child id → the edge that links it upwards, memoised per tree object.
 *
 * The cached tree is frozen and shared by every consumer (`store.js:242`), so
 * this only ever reads it. Memoising on the object mirrors the store's own
 * `parentMaps` (`store.js:167`): the rail re-renders on message counts and
 * roster churn too, and rebuilding an 800-edge index on each of those passes
 * would be work nobody asked for.
 * @type {WeakMap<BranchTree, Map<string, BranchTreeEdge>>}
 */
const edgeIndexes = new WeakMap();

/**
 * @param {BranchTree} tree Cached tree.
 * @returns {Map<string, BranchTreeEdge>} child id → its incoming edge.
 */
function edgesByChild(tree) {
    const memoised = edgeIndexes.get(tree);
    if (memoised) {
        return memoised;
    }
    /** @type {Map<string, BranchTreeEdge>} */
    const map = new Map();
    for (const edge of tree.edges) {
        const child = edge?.child;
        if (typeof child === 'string' && child && !map.has(child)) {
            map.set(child, edge);
        }
    }
    edgeIndexes.set(tree, map);
    return map;
}

/**
 * The file record for a chat id, or null when the tree has never seen it.
 * @param {BranchTree} tree Cached tree.
 * @param {string} fileId Extension-less chat id.
 * @returns {BranchTreeFile|null} The record, or null.
 */
function fileRecord(tree, fileId) {
    if (!fileId || !tree.files || !Object.hasOwn(tree.files, fileId)) {
        return null;
    }
    const record = tree.files[fileId];
    return record && typeof record === 'object' ? record : null;
}

/**
 * Recency for a scanned chat file.
 *
 * `lastMessageAt` is the last line's `send_date` — the honest "when was this
 * chat last written in" — and goes through core's parser because the scanner
 * only promises ISO "where parseable". `mtimeMs` is the fallback: it is the
 * provenance stamp the sidecar already keeps, so it is a measured number rather
 * than an invented one, and it is what the rail's own chat rows effectively
 * fall back to as well (`src/endpoints/chats.js:365-420`).
 * @param {BranchTreeFile|null} record Scanned file record.
 * @returns {number} Epoch milliseconds, or 0 when neither field is usable.
 */
function fileRecency(record) {
    if (!record) {
        return 0;
    }
    const parsed = toEpochMs(record.lastMessageAt);
    if (parsed > 0) {
        return parsed;
    }
    const mtime = Number(record.mtimeMs);
    return Number.isFinite(mtime) && mtime > 0 ? mtime : 0;
}

/**
 * Row tooltip. A dotted (`via: "adopted"`) row explains itself, and names the
 * dead link it stands in for: the sidecar keeps that string on the edge beside
 * the resolved parent as provenance (`src/endpoints/kotatsu/branch-tree.js:
 * 585-591`), so the glyph never has to be the only explanation.
 * @param {string} base What the row already says.
 * @param {BranchTreeEdge|undefined} edge The row's incoming edge.
 * @returns {string} Tooltip text.
 */
function rowTitle(base, edge) {
    if (edge?.via !== 'adopted') {
        return base;
    }
    const named = typeof edge.orphanName === 'string' && edge.orphanName ? edge.orphanName : '';
    return named
        ? `${base} — re-linked by content match; its stored link names "${named}"`
        : `${base} — re-linked by content match`;
}

/**
 * Persisted checkpoint markers on a chat file.
 *
 * Real on disk, unlike `branchNotes`: `saveChatConditional()` follows checkpoint
 * creation (`bookmarks.js:295`) while the fork annotation is dropped, which is
 * the stock bug `BranchStore.fork()` repairs going forward
 * (`docs/branch-panel-v0.md` §"Ground truth").
 * @param {BranchTreeFile|null} record Scanned file record.
 * @returns {number} Marker count, 0 when the record has none.
 */
function checkpointCount(record) {
    return Array.isArray(record?.checkpoints) ? record.checkpoints.length : 0;
}

/** Stroke-only icon set. No Font Awesome, no emoji (repo CLAUDE.md rule). */
const icons = {
    plus: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M8 3.25v9.5" />
            <path d="M3.25 8h9.5" />
        </svg>`,
    branch: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <circle cx="4.5" cy="3" r="1.75" />
            <circle cx="4.5" cy="13" r="1.75" />
            <circle cx="11.5" cy="6" r="1.75" />
            <path d="M4.5 4.75v6.5" />
            <path d="M9.75 6h-1.5A3.75 3.75 0 0 0 4.5 9.75" />
        </svg>`,
    dot: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="2.5" />
        </svg>`,
    /** Rename — routes through the healing endpoint, never core's raw rename. */
    pencil: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M11.1 2.4a1.6 1.6 0 0 1 2.26 2.26L5.75 12.3l-3 .75.75-3z" />
        </svg>`,
    /** A chat that hangs off the row above it — the `via: "header"` link. */
    elbow: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M5.25 2.5v5a3 3 0 0 0 3 3h3.5" />
        </svg>`,
    /**
     * The same link, dashed: `via: "adopted"` — a re-link the server inferred
     * from a shared content prefix, not from a `main_chat` string
     * (`docs/branch-panel-v0.md` decision 1). Worth telling apart on sight.
     */
    elbowAdopted: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             stroke-dasharray="2 2" aria-hidden="true" focusable="false">
            <path d="M5.25 2.5v5a3 3 0 0 0 3 3h3.5" />
        </svg>`,
    /** A broken link: the chain ran into a name with no file behind it. */
    ghost: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M6.5 4.25H5a3.75 3.75 0 0 0 0 7.5h1.5" />
            <path d="M9.5 4.25H11a3.75 3.75 0 0 1 0 7.5H9.5" />
        </svg>`,
    /** Checkpoint markers — `extra.bookmark_link`, persisted by stock ST. */
    flag: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M4.25 2.25v11.5" />
            <path d="M4.25 3.25h7l-1.5 2.5 1.5 2.5h-7" />
        </svg>`,
    /** The door to `<k-branch-map>` — a folded map, not a graph. */
    map: html`
        <svg class="k-rl-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M2 4.25 6 2.75l4 1.5 4-1.5v9L10 13.25l-4-1.5-4 1.5z" />
            <path d="M6 2.75v9" />
            <path d="M10 4.25v9" />
        </svg>`,
};

/**
 * The left rail: roster, chats, branches.
 */
export class KRailLeft extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `list` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _roster: { state: true },
        _activeChid: { state: true },
        _chats: { state: true },
        _activeChatId: { state: true },
        _chatsPending: { state: true },
        _rosterReady: { state: true },
        _groupActive: { state: true },
        _tree: { state: true },
        _renamingChatId: { state: true },
    };

    /** Monotonic token so a slow chats fetch cannot overwrite a newer one. */
    #chatsToken = 0;

    /** Monotonic token so a slow tree read cannot overwrite a newer one. */
    #treeToken = 0;

    /** Character index `_tree` was read for, -1 when there is none. */
    #treeChid = -1;

    /** @type {(() => void)|null} `branchStore.subscribe()` handle while mounted. */
    #unsubscribeBranches = null;

    /** @type {number} `setTimeout` handle for the coalesced refresh, 0 = idle. */
    #refreshTimer = 0;

    /** True once a core event has fired — before that, "loading", not "empty". */
    #coreReady = false;

    /** Identity of the last successful chats fetch: `<chid>\0<active chat id>`. */
    #chatsKey = '';

    /** Set when the pending refresh must refetch the chat list regardless. */
    #forceChats = true;

    /**
     * Avatar filenames whose thumbnail request failed, so the row falls back to
     * the initials chip once and stays there — a broken-image glyph is worse
     * than no art. Session-lived on purpose: a re-mount retries honestly.
     * @type {Set<string>}
     */
    #thumbFailed = new Set();

    /** @type {Array<{ type: string, handler: () => void }>} */
    #subscriptions = [];

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'list';
        /** @type {RosterRow[]} */
        this._roster = [];
        /** @type {number} */
        this._activeChid = -1;
        /** @type {ChatRow[]} */
        this._chats = [];
        /** @type {string} */
        this._activeChatId = '';
        /** @type {boolean} */
        this._chatsPending = false;
        /** @type {boolean} */
        this._rosterReady = false;
        /** @type {boolean} */
        this._groupActive = false;
        /**
         * The active character's branch forest. `null` means "not read yet" —
         * the loading state; `EMPTY_TREE` (by identity) means the store had
         * nothing honest to hand over. See {@link KRailLeft.#loadTree}.
         * @type {BranchTree|null}
         */
        this._tree = null;
        /**
         * Chat id currently wearing the inline rename input, '' when none.
         * @type {string}
         */
        this._renamingChatId = '';
    }

    /** Light DOM: `public/css/shell-left.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        for (const type of REFRESH_EVENTS) {
            const handler = () => {
                this.#coreReady = true;
                if (CHAT_LIFECYCLE_EVENTS.has(type)) {
                    this.#forceChats = true;
                }
                this.#scheduleRefresh();
            };
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
        for (const type of COUNT_EVENTS) {
            const handler = () => this.#syncActiveChatCount();
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
        // Branch data rides the store's notifications, NOT this component's
        // event loop. The store already listens to the same four chat events,
        // coalesces them behind its own 150 ms debounce and refetches exactly
        // once per burst (store.js:73, 735-765); a second subscription here
        // would buy nothing and cost a duplicate tree read per navigation.
        this.#unsubscribeBranches = branchStore.subscribe(() => {
            void this.#loadTree();
        });
        this.#scheduleRefresh();
        // The store only notifies after something moves, so the first read is
        // ours to ask for. `tree()` answers from cache when the character is
        // already warm, so a re-mount is usually free.
        void this.#loadTree();
    }

    disconnectedCallback() {
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
        if (this.#unsubscribeBranches) {
            this.#unsubscribeBranches();
            this.#unsubscribeBranches = null;
        }
        if (this.#refreshTimer !== 0) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = 0;
        }
        // Invalidate any fetch still in flight; a re-mount starts cold.
        this.#chatsToken++;
        this.#chatsKey = '';
        this.#forceChats = true;
        this.#treeToken++;
        this.#treeChid = -1;
        this._tree = null;
        super.disconnectedCallback();
    }

    /** Coalesces the burst of core events a single chat switch produces. */
    #scheduleRefresh() {
        if (this.#refreshTimer !== 0) {
            return;
        }
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = 0;
            this.#syncRoster();
            void this.#loadChats();
        }, REFRESH_DEBOUNCE_MS);
    }

    /**
     * Reads the roster straight off core state. Sorted by recency when the data
     * supports it (`date_last_chat` is server-supplied per character —
     * `src/endpoints/characters.js:423`, the same field the roster's "Recent"
     * sort option uses at `index.html:6385`); otherwise the roster's own order
     * is left alone rather than imposing an invented one.
     */
    #syncRoster() {
        /** @type {RosterRow[]} */
        let rows = [];
        try {
            const list = Array.isArray(characters) ? characters : [];
            rows = list.map((character, index) => ({
                id: index,
                name: String(character?.name ?? '').trim() || 'Unnamed',
                initials: toInitials(character?.name),
                // 'none' is core's no-avatar sentinel (script.js default_avatar
                // handling); treat it as absent rather than requesting a
                // thumbnail that cannot exist.
                avatar: typeof character?.avatar === 'string' && character.avatar && character.avatar !== 'none'
                    ? character.avatar
                    : '',
                lastChat: Number(character?.date_last_chat) || 0,
            }));
            if (rows.some(row => row.lastChat > 0)) {
                rows.sort((a, b) => b.lastChat - a.lastChat);
            }
            // "No characters yet" is only honest once core has said something.
            this._rosterReady = this.#coreReady || rows.length > 0;
        } catch (error) {
            console.error('[k-rail-left] roster read failed', error);
            rows = [];
        }
        this._roster = rows;
        this._activeChid = activeCharacterIndex();
        // Tracked separately from `_activeChid` because both a group chat and no
        // selection at all read as -1, and the Branches section owes those two
        // different sentences (`docs/branch-panel-v0.md` decision 8). Written
        // here, next to `_activeChid`, so the two can never disagree about the
        // same core snapshot.
        this._groupActive = Boolean(selected_group);
    }

    /**
     * Fetches the selected character's chat files through the core export.
     * `getPastCharacterChats()` (script.js:8480) hits `/api/characters/chats`,
     * whose records carry `file_id` (extension-less — the id every open/compare
     * path uses), `file_name` (with `.jsonl`), `chat_items` (message count),
     * `mes`, `last_mes` and `file_size`.
     * @returns {Promise<void>}
     */
    async #loadChats() {
        const chid = activeCharacterIndex();
        this._activeChatId = this.#readActiveChatId();

        if (chid < 0 || !Array.isArray(characters) || !characters[chid]) {
            this.#chatsToken++;
            this.#chatsKey = '';
            this.#forceChats = true;
            this._chats = [];
            this._chatsPending = false;
            return;
        }

        const key = `${chid} ${this._activeChatId}`;
        if (!this.#forceChats && key === this.#chatsKey) {
            return;
        }
        this.#forceChats = false;

        const token = ++this.#chatsToken;
        this._chatsPending = true;
        try {
            const raw = await getPastCharacterChats(chid);
            if (token !== this.#chatsToken) {
                return;
            }
            const rows = (Array.isArray(raw) ? raw : [])
                .filter(entry => entry && typeof entry.file_id === 'string' && entry.file_id.length > 0)
                .map(entry => ({
                    id: String(entry.file_id),
                    title: String(entry.file_id),
                    count: Number.isFinite(Number(entry.chat_items)) ? Number(entry.chat_items) : null,
                    lastMs: toEpochMs(entry.last_mes),
                }));
            rows.sort((a, b) => b.lastMs - a.lastMs);
            this._chats = rows;
            this._activeChatId = this.#readActiveChatId();
            this.#chatsKey = `${chid} ${this._activeChatId}`;
        } catch (error) {
            if (token === this.#chatsToken) {
                this._chats = [];
                // Force a retry on the next event rather than caching the failure.
                this.#chatsKey = '';
                this.#forceChats = true;
            }
            console.error('[k-rail-left] chat list read failed', error);
        } finally {
            if (token === this.#chatsToken) {
                this._chatsPending = false;
            }
        }
    }

    /**
     * Reads the active character's branch forest off the store.
     *
     * The store owns the network: `tree()` answers from its warm per-character
     * cache and coalesces event bursts itself (store.js:398-414), so this is a
     * read, not a fetch loop — nothing here ever asks for `force`.
     *
     * Three outcomes, all distinguishable without the store inventing an error
     * field:
     *   - `null` — never read for this character yet ⇒ "Loading branches…".
     *   - `EMPTY_TREE` **by identity** — the store's single frozen fallback for a
     *     non-OK response, a throw, or a body that was not an object at all
     *     (store.js:696, 707, 233) ⇒ "Branches unavailable". A real answer is
     *     always a fresh object out of `normalizeTree()`, so the identity test
     *     cannot mistake a genuinely empty forest for a failure.
     *   - anything else — a real tree, however small.
     * @returns {Promise<void>}
     */
    async #loadTree() {
        const chid = activeCharacterIndex();
        this._activeChatId = this.#readActiveChatId();
        if (chid < 0) {
            this.#treeToken++;
            this.#treeChid = -1;
            this._tree = null;
            return;
        }
        if (chid !== this.#treeChid) {
            // A different character: drop the old forest rather than show it
            // under the new name while the read is in flight.
            this.#treeChid = chid;
            this._tree = null;
        }
        const token = ++this.#treeToken;
        const tree = await branchStore.tree();
        // `tree()` resolves for whoever is active when it settles, so the
        // character is re-checked as well as the token. A switch that lands
        // mid-read fires its own CHAT_CHANGED, which the store turns into the
        // notification that starts the correct read.
        if (token !== this.#treeToken || activeCharacterIndex() !== chid) {
            return;
        }
        this._tree = tree;
        this._activeChatId = this.#readActiveChatId();
    }

    /** @returns {string} The open chat's extension-less id, or ''. */
    #readActiveChatId() {
        try {
            return String(getCurrentChatId() ?? '');
        } catch (error) {
            console.error('[k-rail-left] active chat read failed', error);
            return '';
        }
    }

    /**
     * Keeps the open chat's count honest during a session without a round trip:
     * `chat` holds exactly the message lines the endpoint counts as `chat_items`
     * (`src/endpoints/chats.js:418` counts lines minus the header line).
     */
    #syncActiveChatCount() {
        const activeId = this.#readActiveChatId();
        if (!activeId || !Array.isArray(chat)) {
            return;
        }
        const index = this._chats.findIndex(row => row.id === activeId);
        if (index === -1) {
            return;
        }
        const count = chat.length;
        if (this._chats[index].count === count) {
            this._activeChatId = activeId;
            return;
        }
        const next = this._chats.slice();
        next[index] = { ...next[index], count, lastMs: Date.now() };
        this._chats = next;
        this._activeChatId = activeId;
    }

    /**
     * Bubbles the v0 route to the full library / settings rack. Slice A's
     * overlay listens for this; if nothing is listening yet the click is inert
     * rather than broken.
     * @param {string} reason Why the overlay is being asked for.
     */
    #requestSettings(reason) {
        this.dispatchEvent(new CustomEvent('k-open-settings', {
            bubbles: true,
            composed: true,
            detail: { source: 'k-rail-left', reason },
        }));
    }

    /**
     * Bubbles the "open the cast gallery" route — SPEC §14's named hook, now real
     * (`docs/library-v0.md` §0). The roster's `+N more` row used to ask for the settings rack;
     * `<k-library>` is the surface that actually holds the whole cast, so it goes there.
     *
     * Same inert-when-unlistened contract as {@link KRailLeft.#requestSettings} and
     * {@link KRailLeft.#requestBranchMap}: under classic nothing is mounted to hear it and the
     * click is a no-op rather than an error. `composed` so it still crosses a shadow boundary.
     * @returns {void}
     */
    #requestLibrary() {
        this.dispatchEvent(new CustomEvent('k-open-library', {
            bubbles: true,
            composed: true,
            detail: { source: 'k-rail-left' },
        }));
    }

    /**
     * The roster's gallery door goes to the LANDING, not to the sheet-over-chat:
     * the chat is closed through core's own menu item first (the same guarded
     * path the hamburger takes), which flips `data-k-view` to `home`, zeroes
     * both rail tracks (shell-frame.css §"home runs full-bleed") and lets the
     * landing take the whole hearth. The library request still fires — when the
     * landing IS the library it is already up and the open is a no-op; when the
     * landing is the hearth, the request is what honours the row's label.
     * @returns {void}
     */
    #goToGallery() {
        const close = document.getElementById('option_close_chat');
        if (close instanceof HTMLElement && this.#readActiveChatId()) {
            close.click();
        }
        this.#requestLibrary();
    }

    /**
     * Create character — straight into `<k-card-studio>`, the same route the
     * gallery takes (`k-library.js` slice D). This button predates the studio:
     * it used to ask for the rack and click `#rm_button_create` raw, which
     * post-slice-D revealed the parked drawer strip over a scrim with the
     * create form nowhere on screen (found 2026-08-25, "+ from a chat opens
     * settings"). The studio's own open path still fires the real
     * `#rm_button_create.click()`, so core's three create handlers run exactly
     * as they always did — routing change, not a flow change.
     * @returns {void}
     */
    #onCreateCharacter() {
        this.dispatchEvent(new CustomEvent(OPEN_STUDIO_EVENT, {
            bubbles: true,
            composed: true,
            detail: { target: 'create', source: 'k-rail-left' },
        }));
    }

    /**
     * @param {number} id Character index.
     * @returns {Promise<void>}
     */
    async #onSelectCharacter(id) {
        try {
            await selectCharacterById(id);
        } catch (error) {
            console.error('[k-rail-left] character select failed', error);
        }
    }

    /**
     * @param {string} fileId Extension-less chat id.
     * @returns {Promise<void>}
     */
    async #onOpenChat(fileId) {
        if (!fileId || activeCharacterIndex() < 0) {
            return;
        }
        if (this.#readActiveChatId() === fileId) {
            return;
        }
        try {
            await openCharacterChat(fileId);
        } catch (error) {
            console.error('[k-rail-left] chat open failed', error);
        }
    }

    /**
     * Focus lands in the inline rename input on the update that mounted it —
     * a rAF-less focus() here would race Lit's commit.
     * @param {Map<string, unknown>} changed Changed reactive properties.
     */
    updated(changed) {
        super.updated(changed);
        if (changed.has('_renamingChatId') && this._renamingChatId) {
            const input = this.querySelector('.k-rl-rename-input');
            if (input instanceof HTMLInputElement) {
                input.focus();
                input.select();
            }
        }
    }

    /**
     * Swaps a chat row for the inline rename input.
     * @param {string} fileId Extension-less chat id.
     * @param {Event} event The pencil click — must not bubble into row open.
     */
    #onStartRename(fileId, event) {
        event.stopPropagation();
        this._renamingChatId = fileId;
    }

    /**
     * Commits the inline rename through the store — the healing path, which
     * repairs children's `main_chat` server-side and (when the open chat is a
     * child of this one) patches its in-memory metadata too. Core's raw rename
     * does neither; the rail must never offer it.
     * @param {string} fileId Extension-less chat id being renamed.
     * @param {HTMLInputElement} input The inline input.
     * @returns {Promise<void>}
     */
    async #onCommitRename(fileId, input) {
        const requested = input.value.trim();
        this._renamingChatId = '';
        if (!requested || requested === fileId) {
            return;
        }
        const finalName = await branchStore.rename(fileId, requested);
        if (finalName === null) {
            // The store logged the cause; the reader just needs to know it
            // didn't take. toastr is ST's native surface for exactly this.
            toastr.warning('Rename failed — the name may already be taken.', 'Kotatsu');
        }
    }

    /**
     * @param {KeyboardEvent} event Keydown inside the rename input.
     * @param {string} fileId Extension-less chat id being renamed.
     * @returns {void}
     */
    #onRenameKeydown(event, fileId) {
        if (event.key === 'Enter') {
            event.preventDefault();
            const input = event.target;
            if (input instanceof HTMLInputElement) {
                void this.#onCommitRename(fileId, input);
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this._renamingChatId = '';
        }
    }

    /**
     * Bubbles the "open the branch map" route. Slice D's `<k-branch-map>`
     * overlay listens for it; while nothing is listening the click is inert
     * rather than broken — the same contract `k-open-settings` already has
     * (see {@link KRailLeft.#requestSettings}). `composed` so it still crosses a
     * shadow boundary if a future layout mounts the rail inside one.
     *
     * The detail is exactly the shape pinned in `docs/branch-panel-v0.md`
     * §"The rail section"; every call site here dispatches the same one, so the
     * map opens the same way from the footer and from either overflow row.
     * @returns {void}
     */
    #requestBranchMap() {
        this.dispatchEvent(new CustomEvent('k-open-branch-map', {
            bubbles: true,
            composed: true,
            detail: { source: 'k-rail-left' },
        }));
    }

    /**
     * Navigates to another chat in the forest.
     *
     * Through the store, not `openCharacterChat()` directly: `switchTo()` owns
     * the "already active" and "no character" guards and logs its own failures
     * once (store.js:460-475). A falsy return means nothing moved, which is not
     * an error the reader needs told about — the rail stays quiet and the next
     * store notification repaints it if anything did change.
     * @param {string} fileId Extension-less chat id.
     * @returns {Promise<void>}
     */
    async #onOpenBranch(fileId) {
        await branchStore.switchTo(fileId);
    }

    /** Opens the classic "Manage chat files" view — the real all-chats route. */
    #onBrowseChats() {
        const option = document.getElementById('option_select_chat');
        if (!option) {
            console.warn('[k-rail-left] #option_select_chat is missing; chat browser unavailable');
            return;
        }
        option.click();
    }

    /**
     * Starts a new chat — the same route the options menu takes.
     *
     * A real click on the menu item rather than an import of `doNewChat()`:
     * the handler at script.js:11897-11912 is where the whole flow lives — the
     * `is_send_press` guard, the "Start new chat?" confirm with its
     * delete-current checkbox, the group branch, and the no-character
     * `newAssistantChat()` fallback. `doNewChat()` is the confirm-less,
     * guard-less inner call; reaching for it here would reimplement the wrapper,
     * which is exactly what this component's "no reimplemented side effects"
     * contract forbids (see the module header).
     */
    #onNewChat() {
        const option = document.getElementById('option_start_new_chat');
        if (!option) {
            console.warn('[k-rail-left] #option_start_new_chat is missing; new chat unavailable');
            return;
        }
        option.click();
    }

    /**
     * @param {string} label Section label (rendered uppercase by CSS).
     * @param {unknown} action Optional header control.
     * @param {unknown} body Section rows.
     * @returns {unknown} A rendered section.
     */
    #section(label, action, body) {
        return html`
            <section class="k-rl-section" aria-label=${label}>
                <div class="k-rl-head">
                    <span class="k-rl-head-label">${label}</span>
                    ${action ?? nothing}
                </div>
                <div class="k-rl-body">${body}</div>
            </section>`;
    }

    /**
     * @param {string} text Quiet one-line state.
     * @param {unknown} [glyph] Optional leading icon.
     * @returns {unknown} A muted, non-interactive row.
     */
    #quietRow(text, glyph) {
        return html`
            <div class="k-rl-quiet">
                ${glyph ?? nothing}
                <span class="k-rl-quiet-text">${text}</span>
            </div>`;
    }

    /**
     * @param {RosterRow} row Roster entry.
     * @returns {unknown} One character row.
     */
    #characterRow(row) {
        const active = row.id === this._activeChid;
        const relative = toRelative(row.lastChat);
        // Card art through core's own thumbnail endpoint; the initials chip is
        // the FALLBACK, not the default — for a record with no avatar or a
        // thumbnail that 404s (the error handler remembers, so a broken image
        // icon never renders twice).
        const showArt = row.avatar && !this.#thumbFailed.has(row.avatar);
        return html`
            <button
                type="button"
                class="k-rl-row k-rl-row--char${active ? ' is-active' : ''}"
                aria-current=${active ? 'true' : 'false'}
                title=${row.name}
                @click=${() => this.#onSelectCharacter(row.id)}
            >
                ${showArt ? html`
                    <img class="k-rl-chip k-rl-chip--art" aria-hidden="true" alt=""
                        loading="lazy" src=${getThumbnailUrl('avatar', row.avatar)}
                        @error=${() => { this.#thumbFailed.add(row.avatar); this.requestUpdate(); }}>
                ` : html`
                    <span class="k-rl-chip" aria-hidden="true">${row.initials}</span>
                `}
                <span class="k-rl-name">${row.name}</span>
                ${relative ? html`<span class="k-rl-meta">${relative}</span>` : nothing}
            </button>`;
    }

    /**
     * @param {ChatRow} row Chat entry.
     * @returns {unknown} One chat row.
     */
    #chatRow(row) {
        if (row.id === this._renamingChatId) {
            return html`
                <div class="k-rl-rowwrap k-rl-rowwrap--renaming">
                    <input
                        class="k-rl-rename-input"
                        type="text"
                        .value=${row.id}
                        spellcheck="false"
                        aria-label=${`Rename chat ${row.title}`}
                        @keydown=${(/** @type {KeyboardEvent} */ event) => this.#onRenameKeydown(event, row.id)}
                        @blur=${() => { this._renamingChatId = ''; }}
                    />
                </div>`;
        }
        const active = row.id === this._activeChatId;
        // `chat_items` is the honest count; when a record lacks one, fall back to
        // recency rather than printing a made-up number.
        const meta = row.count === null ? toRelative(row.lastMs) : String(row.count);
        return html`
            <div class="k-rl-rowwrap">
                <button
                    type="button"
                    class="k-rl-row k-rl-row--chat${active ? ' is-active' : ''}"
                    aria-current=${active ? 'true' : 'false'}
                    title=${row.title}
                    @click=${() => this.#onOpenChat(row.id)}
                >
                    <span class="k-rl-name">${chatLabelText(row.title, activeCharacterName())}</span>
                    ${meta ? html`<span class="k-rl-meta">${meta}</span>` : nothing}
                </button>
                <button
                    type="button"
                    class="k-rl-act"
                    title="Rename chat"
                    aria-label=${`Rename chat ${row.title}`}
                    @click=${(/** @type {Event} */ event) => this.#onStartRename(row.id, event)}
                >${icons.pencil}</button>
            </div>`;
    }

    /** @returns {unknown} The Characters section. */
    #renderCharacters() {
        const action = html`
            <button
                type="button"
                class="k-rl-head-action"
                title="Create new character"
                aria-label="Create new character"
                @click=${() => this.#onCreateCharacter()}
            >${icons.plus}</button>`;

        if (this._roster.length === 0) {
            const text = this._rosterReady ? 'No characters yet' : 'Loading roster…';
            return this.#section('Characters', action, this.#quietRow(text, icons.dot));
        }

        const visible = this._roster.slice(0, ROSTER_VISIBLE_MAX);
        const hidden = this._roster.length - visible.length;

        // The gallery door is ALWAYS offered — the Library is the landing and the
        // whole cast lives there, not only its overflow. When the cap hides rows,
        // the door carries the count so nothing is silently truncated (the old
        // "+N more" row's one job, folded in). Same grammar as "All chats (N)".
        return this.#section('Characters', action, html`
            ${visible.map(row => this.#characterRow(row))}
            <button
                type="button"
                class="k-rl-row k-rl-row--more"
                title="Back to the character gallery"
                @click=${() => this.#goToGallery()}
            >
                <span class="k-rl-name">Character gallery${hidden > 0 ? ` (+${hidden} more)` : ''}</span>
            </button>`);
    }

    /** @returns {unknown} The Chats section. */
    #renderChats() {
        // The header "+" is offered in all three branches — "no chats yet" is
        // precisely when it is most wanted — but it is DISABLED with neither a
        // character nor a group selected. Core's menu handler falls through to
        // `newAssistantChat()` in that case (script.js:11909-11912), which creates
        // a chat this section cannot list: the rail reads `characters[chid]`, and
        // the assistant chat belongs to no roster entry. A control that silently
        // produces something invisible is worse than one that is plainly off.
        //
        // `_groupActive` is read rather than `_activeChid`, because a group chat
        // and no selection at all both read as chid -1 (see `#syncRoster`), and
        // core's new-chat path handles a group perfectly well.
        const canStart = this._activeChid >= 0 || this._groupActive;
        const action = html`
            <button
                type="button"
                class="k-rl-head-action"
                title="New chat"
                aria-label="New chat"
                ?disabled=${!canStart}
                @click=${() => this.#onNewChat()}
            >${icons.plus}</button>`;

        if (this._activeChid < 0) {
            return this.#section('Chats', action, this.#quietRow('No character selected', icons.dot));
        }
        if (this._chats.length === 0) {
            const text = this._chatsPending ? 'Loading chats…' : 'No chats yet';
            return this.#section('Chats', action, this.#quietRow(text, icons.dot));
        }

        const visible = this._chats.slice(0, CHATS_VISIBLE_MAX);
        const hidden = this._chats.length - visible.length;

        return this.#section('Chats', action, html`
            ${visible.map(row => this.#chatRow(row))}
            ${hidden > 0 ? html`
                <button
                    type="button"
                    class="k-rl-row k-rl-row--more"
                    title="Open the chat manager"
                    @click=${() => this.#onBrowseChats()}
                >
                    <span class="k-rl-name">All chats (${this._chats.length})</span>
                </button>` : nothing}`);
    }

    /**
     * The chain's dead end: the top of the lineage names a parent that is not on
     * disk. Core's rename is a `copyFileSync` + `unlinkSync` with no JSONL
     * awareness (`src/endpoints/chats.js:569-570`) and its delete cleans up
     * nothing, so this is common on real folders — 59 of 267 links point at a
     * missing name on the worst one. The sidecar keeps the ghost NAME on the
     * edge; the store refuses to smuggle it into the id chain, so the rail draws
     * it as what it is: a row you cannot open.
     * @param {string} name Ghost name, verbatim off `edges[].orphanName`.
     * @returns {unknown} A muted, non-interactive row.
     */
    #ghostRow(name) {
        return html`
            <div class="k-rl-ghost" title=${`${name} — named as the parent, but no such chat file exists`}>
                ${icons.ghost}
                <span class="k-rl-name">${chatLabelText(name, activeCharacterName())}</span>
                <span class="k-rl-meta">missing</span>
            </div>`;
    }

    /**
     * @param {number} count Persisted checkpoint markers on the row's chat.
     * @returns {unknown} A quiet count with a flag glyph.
     */
    #checkpointBadge(count) {
        const label = count === 1 ? '1 checkpoint' : `${count} checkpoints`;
        return html`
            <span class="k-rl-flag" title=${label} aria-label=${label}>
                ${icons.flag}<span class="k-rl-flag-count">${count}</span>
            </span>`;
    }

    /**
     * One ancestor (or the open chat itself) in the lineage chain.
     * @param {BranchTree} tree Cached tree.
     * @param {string} fileId Extension-less chat id.
     * @param {BranchTreeEdge|undefined} edge The edge linking it upwards, if any.
     * @param {boolean} connected Whether a row is drawn directly above this one,
     *   which is what the elbow glyph claims; a chain top with nothing above it
     *   gets the neutral dot instead of an elbow pointing at empty space.
     * @returns {unknown} One lineage row.
     */
    #lineageRow(tree, fileId, edge, connected) {
        const active = fileId === this._activeChatId;
        const adopted = edge?.via === 'adopted';
        const glyph = connected ? (adopted ? icons.elbowAdopted : icons.elbow) : icons.dot;
        // Only the open chat carries the badge: the doc asks for the active
        // chat's count, and a flag on every ancestor would out-shout the chain.
        const checkpoints = active ? checkpointCount(fileRecord(tree, fileId)) : 0;
        return html`
            <button
                type="button"
                class="k-rl-row k-rl-row--branch${active ? ' is-active' : ''}"
                aria-current=${active ? 'true' : 'false'}
                title=${rowTitle(fileId, edge)}
                @click=${() => this.#onOpenBranch(fileId)}
            >
                <span class="k-rl-glyph" aria-hidden="true">${glyph}</span>
                <span class="k-rl-name">${chatLabelText(fileId, activeCharacterName())}</span>
                ${checkpoints > 0 ? this.#checkpointBadge(checkpoints) : nothing}
            </button>`;
    }

    /**
     * One chat branched off the open one.
     * @param {BranchTree} tree Cached tree.
     * @param {BranchTreeEdge} edge An edge whose parent is the open chat.
     * @returns {unknown} One child row.
     */
    #childRow(tree, edge) {
        const fileId = edge.child;
        const record = fileRecord(tree, fileId);
        const adopted = edge.via === 'adopted';
        // `forkIndex` is null until the server has walked the two files
        // (`docs/branch-panel-v0.md` §"The sidecar"), and 0 is a real answer —
        // hence the explicit integer test rather than a truthiness check.
        const rawFork = edge.forkIndex;
        const forkIndex = typeof rawFork === 'number' && Number.isInteger(rawFork) ? rawFork : null;
        const relative = toRelative(fileRecency(record));
        const label = forkIndex === null ? fileId : `${fileId}, forked at message ${forkIndex}`;
        return html`
            <button
                type="button"
                class="k-rl-row k-rl-row--branch k-rl-row--child"
                title=${rowTitle(label, edge)}
                aria-label=${label}
                @click=${() => this.#onOpenBranch(fileId)}
            >
                <span class="k-rl-glyph" aria-hidden="true">${adopted ? icons.elbowAdopted : icons.elbow}</span>
                <span class="k-rl-name">${chatLabelText(fileId, activeCharacterName())}</span>
                ${forkIndex === null ? nothing : html`<span class="k-rl-fork">forked @${forkIndex}</span>`}
                ${relative ? html`<span class="k-rl-meta">${relative}</span>` : nothing}
            </button>`;
    }

    /**
     * @param {number} count Rows the rail is not showing.
     * @param {string} label Accessible noun for what is hidden.
     * @returns {unknown} An overflow row that routes to the map.
     */
    #branchMoreRow(count, label) {
        return html`
            <button
                type="button"
                class="k-rl-row k-rl-row--more"
                title="Open the branch map"
                aria-label=${`Show ${count} more ${label} on the branch map`}
                @click=${() => this.#requestBranchMap()}
            >
                <span class="k-rl-name">+${count} more</span>
            </button>`;
    }

    /**
     * The section footer: how many branch links this character has, and the door
     * to the map that can actually show them all.
     * @param {number} count `edges.length` — one edge per chat that names a
     *   parent, orphaned links included. Not a file count, and not derived.
     * @returns {unknown} The footer row.
     */
    #mapRow(count) {
        const label = count === 1 ? '1 branch link' : `${count} branch links`;
        return html`
            <button
                type="button"
                class="k-rl-row k-rl-row--map"
                title=${`Open the branch map — ${label} for this character`}
                aria-label=${`Open the branch map, ${label}`}
                @click=${() => this.#requestBranchMap()}
            >
                ${icons.map}
                <span class="k-rl-name">Open map</span>
                <span class="k-rl-meta">${count}</span>
            </button>`;
    }

    /**
     * Root → … → open chat, with the ghost row on top when the chain ran out of
     * resolvable ancestry.
     * @param {BranchTree} tree Cached tree.
     * @returns {unknown} The lineage rows, or a quiet state.
     */
    #renderLineage(tree) {
        const activeId = this._activeChatId;
        if (!activeId) {
            return this.#quietRow('No chat open', icons.dot);
        }
        // The pinned read (SPEC §7A), and deliberately synchronous: a render
        // pass must not be able to start network traffic (store.js:637-649). It
        // walks the same cached tree and stops at the last RESOLVED ancestor.
        const chain = branchStore.lineage(activeId);
        if (chain.length === 0) {
            return this.#quietRow('Open chat is not indexed yet', icons.dot);
        }
        const edges = edgesByChild(tree);
        const topEdge = edges.get(chain[0]);
        // `orphanName` alone does NOT mean orphaned: a successful adoption keeps
        // the dead name on the edge as provenance next to a RESOLVED parent
        // (`src/endpoints/kotatsu/branch-tree.js:585-591`). The ghost row is owed
        // only where the parent is genuinely unresolvable, which is the same test
        // the store's own lineage walk terminates on (store.js:266-276) — so the
        // row appears exactly where the chain actually stopped.
        const topParent = topEdge?.parent;
        const topResolved = typeof topParent === 'string' && topParent !== ''
            && Object.hasOwn(tree.files, topParent);
        const ghostName = !topResolved && typeof topEdge?.orphanName === 'string' && topEdge.orphanName
            ? topEdge.orphanName
            : '';

        let visible = chain.map((id, index) => ({ id, index }));
        let hidden = 0;
        if (chain.length > LINEAGE_VISIBLE_MAX) {
            // Root, an elision row, then the last hops — the two ends of a deep
            // chain are the ones that orient a reader.
            hidden = chain.length - LINEAGE_VISIBLE_MAX + 1;
            visible = [visible[0], ...visible.slice(chain.length - (LINEAGE_VISIBLE_MAX - 2))];
        }

        /** @type {unknown[]} */
        const rows = [];
        for (const [position, entry] of visible.entries()) {
            rows.push(this.#lineageRow(tree, entry.id, edges.get(entry.id), entry.index > 0 || Boolean(ghostName)));
            if (position === 0 && hidden > 0) {
                rows.push(this.#branchMoreRow(hidden, 'ancestors'));
            }
        }

        return html`
            <div class="k-rl-branch-group" role="group" aria-label="Lineage of the open chat">
                ${ghostName ? this.#ghostRow(ghostName) : nothing}
                ${rows}
            </div>`;
    }

    /**
     * The chats branched off the open one, newest first.
     * @param {BranchTree} tree Cached tree.
     * @returns {unknown} The child rows, or nothing when there are none — the
     *   lineage already says where the reader is standing, so a "no children"
     *   row would only be noise.
     */
    #renderChildren(tree) {
        const activeId = this._activeChatId;
        if (!activeId) {
            return nothing;
        }
        // `.filter()` over the FROZEN `edges` array (store.js:242) hands back a
        // fresh, mutable array, so the sort below never touches the shared tree.
        const children = tree.edges
            .filter(edge => typeof edge.child === 'string' && edge.child && edge.parent === activeId)
            .map(edge => ({ edge, lastMs: fileRecency(fileRecord(tree, edge.child)) }))
            .sort((a, b) => b.lastMs - a.lastMs);
        if (children.length === 0) {
            return nothing;
        }
        const visible = children.slice(0, BRANCH_CHILDREN_VISIBLE_MAX);
        const hidden = children.length - visible.length;
        return html`
            <div class="k-rl-branch-group" role="group" aria-label="Branches of the open chat">
                ${visible.map(row => this.#childRow(tree, row.edge))}
                ${hidden > 0 ? this.#branchMoreRow(hidden, 'branches') : nothing}
            </div>`;
    }

    /**
     * The Branches section (`docs/branch-panel-v0.md` §"The rail section").
     *
     * The state ladder, in order, and why each rung exists:
     *   1. group chat — out of v0 by decision 8, and said out loud rather than
     *      rendered as an empty section a reader would read as "no branches";
     *   2. no character — nothing to have a forest for;
     *   3. `_tree === null` — never read for this character yet;
     *   4. `_tree === EMPTY_TREE` — the store's frozen failure fallback;
     *   5. no edges — a real forest of roots, honestly empty of branches;
     *   6. the section proper.
     * @returns {unknown} The Branches section.
     */
    #renderBranches() {
        if (this._groupActive) {
            return this.#section('Branches', null, this.#quietRow('Not available in group chats', icons.branch));
        }
        if (this._activeChid < 0) {
            return this.#section('Branches', null, this.#quietRow('No character selected', icons.dot));
        }
        const tree = this._tree;
        if (tree === null) {
            return this.#section('Branches', null, this.#quietRow('Loading branches…', icons.dot));
        }
        if (tree === EMPTY_TREE) {
            return this.#section('Branches', null, this.#quietRow('Branches unavailable', icons.branch));
        }
        if (tree.edges.length === 0) {
            // The map still has something to show — every chat file is a root —
            // so the door stays open even with nothing branched.
            return this.#section('Branches', null, html`
                ${this.#quietRow('No branches yet', icons.branch)}
                ${this.#mapRow(0)}`);
        }
        return this.#section('Branches', null, html`
            ${this.#renderLineage(tree)}
            ${this.#renderChildren(tree)}
            ${this.#mapRow(tree.edges.length)}`);
    }

    /** @returns {unknown} The rail: scrolling content, then the pinned persona footer. */
    render() {
        return html`
            <div class="k-rl-scroll">
                ${this.#renderCharacters()}
                ${this.#renderChats()}
                ${this.#renderBranches()}
            </div>
            <div class="k-rl-footer">
                <k-persona-menu></k-persona-menu>
            </div>`;
    }
}

if (!customElements.get('k-rail-left')) {
    customElements.define('k-rail-left', KRailLeft);
}
