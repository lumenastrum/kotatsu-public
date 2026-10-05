/**
 * `BranchStore` — the client-side branch graph (branch panel v0, slice B).
 *
 * Every branch UI codes against this object, never against storage: the rail
 * section (slice C) and `<k-branch-map>` (slice D) read `tree()` / `lineage()`
 * and drive `fork()` / `switchTo()` / `rename()` / `delete()`. The sidecar
 * (`chats/<char>/.kotatsu/tree.json`) and its endpoints are slice A's; the
 * shapes consumed here are the ones pinned in `docs/branch-panel-v0.md`.
 *
 * Contracts this module honours:
 *
 * - **One-way imports.** kotatsu → core only (`script.js`, `scripts/*.js`).
 *   Nothing in core imports this file; registration rides the single sanctioned
 *   seam — `firstLoadInit()` → `initKotatsuShell()` → {@link initBranchStore}.
 * - **The stock repairs live here.** `fork()` persists the parent-side
 *   `extra.branches[]` annotation that stock ST builds in memory and then
 *   throws away (`bookmarks.js:233-241` pushes the name; its only caller
 *   `branchChat` navigates immediately and `openCharacterChat` → `clearChat`
 *   cancels the debounced save — so the array is empty on all existing data).
 *   `rename()` goes through `/api/kotatsu/branches/rename`, which heals the
 *   children's `chat_metadata.main_chat` that core's rename orphans. `delete()`
 *   finishes the active-chat case that `deleteCharacterChatByName` leaves half
 *   done (see the note on that method).
 * - **Quiet degradation.** The tree endpoint may be absent (slice A not landed),
 *   404 (character with no chat folder) or 500. Every one of those yields
 *   {@link EMPTY_TREE} and a single `console.error`; nothing throws into the UI.
 * - **No fabricated data.** An empty tree carries `build: null` rather than
 *   invented build stats, and `lineage()` stops at the last *resolved* ancestor —
 *   ghost names live on the edge records (`orphanName`) for slice C to render
 *   honestly, they are never smuggled into the id chain.
 * - **Group chats are out of v0** (doc decision 8). A group context reports no
 *   active character: empty tree, mutations decline.
 *
 * Invalidation: `CHAT_CHANGED` / `CHAT_CREATED` / `CHAT_RENAMED` / `CHAT_DELETED`,
 * debounced and cleaned up on `dispose()` the way `k-rail-left` does it. There is
 * deliberately **no branch-created event** in core (`saveChat` and `createBranch`
 * emit nothing), which is exactly why every mutation on this object refreshes
 * explicitly instead of trusting the event bus.
 *
 * `diff(a, b)` from SPEC §7A is deferred; the name stays reserved on this
 * interface and must not be claimed for anything else.
 */

import {
    characters,
    chat_metadata,
    createOrEditCharacter,
    deleteCharacterChatByName,
    getCurrentChatId,
    getRequestHeaders,
    openCharacterChat,
    reloadCurrentChat,
    saveChatConditional,
    saveItemizedPrompts,
    this_chid,
} from '../../script.js';
import { createBranch } from '../../scripts/bookmarks.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { selected_group } from '../../scripts/group-chats.js';
import { equalsIgnoreCaseAndAccents } from '../../scripts/utils.js';

/** Tree endpoint — body `{ avatar_url }`, response = tree.json plus `build`. */
const TREE_URL = '/api/kotatsu/branches/tree';

/** Heal-on-rename endpoint — body `{ avatar_url, original_file, renamed_file }`. */
const RENAME_URL = '/api/kotatsu/branches/rename';

/**
 * Coalescing window for bursty core events. Wider than the rail's 80 ms
 * (`k-rail-left.js:53`) on purpose: a tree read is a server-side stat sweep over
 * the whole chat folder (802 files on the worst live character), and a single
 * navigation fires `CHAT_CHANGED` plus whatever the caller emitted.
 */
const REFRESH_DEBOUNCE_MS = 150;

/** Core events after which the cached tree may be stale (doc decision 2). */
const INVALIDATION_EVENTS = [
    event_types.CHAT_CHANGED,
    event_types.CHAT_CREATED,
    event_types.CHAT_RENAMED,
    event_types.CHAT_DELETED,
];

/**
 * How many characters' trees stay warm. Insertion-ordered eviction keeps a
 * long session from pinning every visited character's forest in memory.
 */
const CACHE_MAX_CHARACTERS = 8;

/**
 * @typedef {object} BranchCheckpoint
 * @property {string} name Checkpoint chat name (`extra.bookmark_link`).
 * @property {number} mesIndex Index of the annotated message.
 */

/**
 * @typedef {object} BranchTreeFile
 * @property {number} size Bytes on disk — provenance.
 * @property {number} mtimeMs Modification time in epoch ms — provenance.
 * @property {number} messageCount Lines minus the header line.
 * @property {boolean} hasHeader False for the legal headerless files of §2.2.
 * @property {string|null} mainChat `chat_metadata.main_chat`, or null.
 * @property {string|null} lastMessageAt Last line `send_date`, ISO where parseable.
 * @property {string|null} leafPreview Last line `mes`, plain text, first 200 chars.
 * @property {BranchCheckpoint[]} checkpoints Persisted `extra.bookmark_link` markers.
 * @property {BranchCheckpoint[]} branchNotes `extra.branches[]` entries (sparse today).
 */

/**
 * @typedef {object} BranchTreeEdge
 * @property {string} child Child `file_id`.
 * @property {string|null} parent Resolved parent `file_id`, or null when unresolved.
 * @property {string|null} [orphanName] Set when `mainChat` names a missing file.
 * @property {number|null} [forkIndex] First-divergence index, or null when uncomputed.
 * @property {{ parent: string, child: string }|null} [forkPreview] Each side's line at the fork.
 * @property {'header'|'adopted'} [via] `header` = `main_chat`; `adopted` = prefix re-link.
 */

/**
 * @typedef {object} BranchTreeBuild
 * @property {number} scannedFiles Files the server re-read on this request.
 * @property {boolean} fromCache Whether the sidecar answered without a rescan.
 * @property {number} ms Server-side build duration.
 */

/**
 * The tree payload for one character.
 * Treat it as read-only: the top level, `files` and `edges` are frozen, and the
 * same object is handed to every caller until the cache is refreshed.
 * @typedef {object} BranchTree
 * @property {number} version Sidecar schema version the server reported.
 * @property {Readonly<Record<string, BranchTreeFile>>} files Keyed by extension-less `file_id`.
 * @property {ReadonlyArray<BranchTreeEdge>} edges Child → parent links.
 * @property {BranchTreeBuild|null} build Build stats, or null when there are none
 *   to report honestly (empty and degraded trees).
 */

/**
 * @typedef {object} BranchStoreChange
 * @property {string} reason What moved: an event type, or `fork`/`rename`/`delete`.
 * @property {string} avatarUrl Avatar of the character in context, '' when none.
 */

/**
 * @callback BranchStoreListener
 * @param {BranchStoreChange} change What changed.
 * @returns {void}
 */

/**
 * The tree handed back when there is nothing honest to show: no character, a
 * group chat, or a failed request. Frozen so a consumer cannot poison the
 * shared instance.
 * @type {BranchTree}
 */
export const EMPTY_TREE = Object.freeze({
    version: 0,
    files: Object.freeze({}),
    edges: Object.freeze([]),
    build: null,
});

/**
 * Child → parent maps, memoised per tree object. `lineage()` is called once per
 * rendered row; rebuilding the map from `edges` every time would make a rail
 * repaint O(rows × edges).
 * @type {WeakMap<BranchTree, Map<string, string>>}
 */
const parentMaps = new WeakMap();

/** @returns {number} Active character index, or -1 (group chat included). */
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
 * The active character's avatar — the cache key and the `avatar_url` both
 * endpoints take (core's own rename uses the same field, `script.js:10637`).
 * @returns {string} Avatar filename, or '' when there is no character context.
 */
function activeAvatarUrl() {
    const index = activeCharacterIndex();
    if (index < 0 || !Array.isArray(characters)) {
        return '';
    }
    const avatar = characters[index]?.avatar;
    return typeof avatar === 'string' ? avatar : '';
}

/** @returns {string} The open chat's extension-less id, or ''. */
function activeChatId() {
    try {
        return String(getCurrentChatId() ?? '');
    } catch (error) {
        console.error('[kotatsu branches] active chat read failed', error);
        return '';
    }
}

/**
 * Normalises a `build` block. Absent or malformed stats become null rather than
 * zeroes, so "0 files scanned" always means the server actually said so.
 * @param {unknown} raw Raw `build` value from the response.
 * @returns {BranchTreeBuild|null} Stats, or null.
 */
function normalizeBuild(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const value = /** @type {Record<string, unknown>} */ (raw);
    const scannedFiles = Number(value.scannedFiles);
    const ms = Number(value.ms);
    if (!Number.isFinite(scannedFiles) || !Number.isFinite(ms)) {
        return null;
    }
    return { scannedFiles, fromCache: value.fromCache === true, ms };
}

/**
 * Shapes an endpoint response into a {@link BranchTree}. Defensive because the
 * response may be anything at all when a proxy or an error page answers instead
 * of the endpoint; malformed edges are dropped, never guessed at.
 * @param {unknown} payload Parsed response body.
 * @returns {BranchTree} A frozen tree (never null).
 */
function normalizeTree(payload) {
    if (!payload || typeof payload !== 'object') {
        return EMPTY_TREE;
    }
    const value = /** @type {Record<string, unknown>} */ (payload);
    const rawFiles = value.files;
    const files = rawFiles && typeof rawFiles === 'object' && !Array.isArray(rawFiles)
        ? /** @type {Record<string, BranchTreeFile>} */ (rawFiles)
        : {};
    const rawEdges = Array.isArray(value.edges) ? value.edges : [];
    const edges = rawEdges.filter(edge => edge && typeof edge === 'object' && typeof edge.child === 'string');
    return Object.freeze({
        version: Number(value.version) || 0,
        files: Object.freeze(files),
        edges: Object.freeze(edges),
        build: normalizeBuild(value.build),
    });
}

/**
 * Builds (and memoises) the child → parent map for a tree.
 *
 * Only edges whose parent is a file the tree actually knows about become links:
 * an unresolved parent (`parent: null`, `orphanName` set — doc decision 5) is a
 * lineage terminator, not a hop.
 * @param {BranchTree} tree Cached tree.
 * @returns {Map<string, string>} child id → parent id.
 */
function parentMapFor(tree) {
    const memoised = parentMaps.get(tree);
    if (memoised) {
        return memoised;
    }
    /** @type {Map<string, string>} */
    const map = new Map();
    for (const edge of tree.edges) {
        const child = edge?.child;
        const parent = typeof edge?.parent === 'string' ? edge.parent : '';
        if (typeof child !== 'string' || !child || !parent || parent === child) {
            continue;
        }
        if (!Object.hasOwn(tree.files, parent) || map.has(child)) {
            continue;
        }
        map.set(child, parent);
    }
    parentMaps.set(tree, map);
    return map;
}

/**
 * Pure lineage walk — root → … → `fileId`. Exported so a caller that already
 * holds a tree (and the Jest fixture) can walk it without the store's cache.
 *
 * Returns `[]` for an unknown id: a chat the tree has never heard of has no
 * honest ancestry, and an empty array is the documented "uncached/unknown"
 * answer. A file with no resolvable parent is its own root, so `[fileId]`.
 * A cycle (only reachable through a corrupt sidecar) terminates the walk at the
 * repeat instead of hanging.
 * @param {BranchTree|null|undefined} tree Tree to walk.
 * @param {string} fileId Extension-less chat id.
 * @returns {string[]} Ancestor chain ending at `fileId`, or `[]`.
 */
export function lineageOf(tree, fileId) {
    const id = String(fileId ?? '');
    if (!id || !tree || typeof tree !== 'object') {
        return [];
    }
    if (!tree.files || typeof tree.files !== 'object' || !Array.isArray(tree.edges)) {
        return [];
    }
    if (!Object.hasOwn(tree.files, id)) {
        return [];
    }
    const parents = parentMapFor(tree);
    const chain = [id];
    const seen = new Set(chain);
    let cursor = id;
    for (;;) {
        const parent = parents.get(cursor);
        if (!parent || seen.has(parent)) {
            break;
        }
        seen.add(parent);
        chain.push(parent);
        cursor = parent;
    }
    chain.reverse();
    return chain;
}

/**
 * The branch graph for the active character. One instance per page; see
 * {@link branchStore}.
 */
export class BranchStore {
    /** @type {Map<string, BranchTree>} Warm trees, keyed by avatar_url. */
    #cache = new Map();

    /** @type {Map<string, Promise<BranchTree>>} In-flight fetch per avatar. */
    #inflight = new Map();

    /** @type {Map<string, number>} Newest issued fetch token per avatar. */
    #issued = new Map();

    /** Monotonic fetch token: a slow reply may never overwrite a newer one. */
    #token = 0;

    /** @type {Set<BranchStoreListener>} */
    #listeners = new Set();

    /** @type {Array<{ type: string, handler: () => void }>} */
    #subscriptions = [];

    /** @type {number} `setTimeout` handle for the coalesced refresh, 0 = idle. */
    #refreshTimer = 0;

    /** @type {Set<string>} Failure keys already reported — one error line each. */
    #loggedFailures = new Set();

    /**
     * Subscribes to the core events that can invalidate a cached tree.
     * Idempotent: the seam may run once, but a reload of the shell must not
     * stack a second set of handlers.
     * @returns {void}
     */
    init() {
        if (this.#subscriptions.length > 0) {
            return;
        }
        for (const type of INVALIDATION_EVENTS) {
            const handler = () => this.#scheduleRefresh(type);
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
    }

    /**
     * Drops every subscription, timer and in-flight fetch. Symmetry for
     * {@link init} — used by tests and by anything that tears the shell down.
     * @returns {void}
     */
    dispose() {
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
        if (this.#refreshTimer !== 0) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = 0;
        }
        this.#issued.clear();
        this.#inflight.clear();
        this.#cache.clear();
        this.#listeners.clear();
        this.#loggedFailures.clear();
    }

    /**
     * The cached tree for the active character.
     *
     * No character, or a group chat (out of v0 scope), yields {@link EMPTY_TREE}
     * — not an error. So does any failure of the endpoint: this method never
     * rejects.
     * @param {boolean} [force] Refetch even when a warm tree is cached.
     * @returns {Promise<BranchTree>} The tree; `EMPTY_TREE` when there is none.
     */
    async tree(force = false) {
        const avatar = activeAvatarUrl();
        if (!avatar) {
            return EMPTY_TREE;
        }
        if (!force) {
            const cached = this.#cache.get(avatar);
            if (cached) {
                return cached;
            }
            const pending = this.#inflight.get(avatar);
            if (pending) {
                return pending;
            }
        }
        return this.#fetchTree(avatar);
    }

    /**
     * Branches the active chat at `mesId` and opens the new chat.
     *
     * The stock-bug fix is the ordering: core's `createBranch` annotates the
     * parent's fork message in memory (`bookmarks.js:233-241`) and its only
     * caller navigates straight away, so the annotation dies with the debounced
     * save `clearChat` cancels. Persisting it with `saveChatConditional()`
     * *before* `openCharacterChat()` writes the exact record stock ST already
     * intends — same format, no schema change (doc decision 3).
     *
     * `saveItemizedPrompts(name)` keeps parity with core's `branchChat`
     * (`bookmarks.js:460`), which carries the prompt-inspector data over to the
     * new chat id.
     * @param {number} mesId Message index to branch at.
     * @param {{swipeId?: number|null}} [options] Branch options.
     * @returns {Promise<string|null>} The new chat name, or null when nothing
     *   was created (core declined, no character, group chat, or an error —
     *   core toasts its own refusals).
     */
    async fork(mesId, { swipeId = null } = {}) {
        if (!activeAvatarUrl()) {
            return null;
        }
        try {
            const name = await createBranch(mesId, { swipeId });
            if (!name) {
                return null;
            }
            await saveChatConditional();
            await saveItemizedPrompts(name);
            await openCharacterChat(name);
            await this.#refresh('fork');
            return name;
        } catch (error) {
            console.error('[kotatsu branches] fork failed', error);
            return null;
        }
    }

    /**
     * Opens another chat of the active character.
     * @param {string} fileId Extension-less chat id.
     * @returns {Promise<boolean>} True when a navigation actually happened.
     */
    async switchTo(fileId) {
        const id = String(fileId ?? '');
        if (!id || !activeAvatarUrl()) {
            return false;
        }
        if (activeChatId() === id) {
            return false;
        }
        try {
            await openCharacterChat(id);
            return true;
        } catch (error) {
            console.error('[kotatsu branches] chat open failed', error);
            return false;
        }
    }

    /**
     * Renames a chat through the healing endpoint, then replays core's
     * client-side bookkeeping.
     *
     * The bookkeeping mirrors `renameGroupOrCharacterChat`
     * (`script.js:10633-10699`): identical-name and accent-insensitive guards,
     * adopt the server's `sanitizedFileName`, and — when the renamed file is the
     * open chat — patch `characters[chid].chat`, `#selected_chat_pole` and
     * persist through `createOrEditCharacter()` before reloading.
     *
     * Two deliberate divergences from that function, both flagged in the slice
     * report:
     *   1. `reloadCurrentChat()` fires only when the *renamed* chat is the open
     *      one. Core reloads whenever any chat is open (`script.js:10687`),
     *      which from a forest view would jolt the reader for a rename that did
     *      not touch their chat.
     *   2. `CHAT_RENAMED` carries the **sanitized** new name. Core emits
     *      `body.renamed_file`, built at `script.js:10639` before the sanitized
     *      name is adopted at `:10676`, so its listeners (e.g. the pinned-chats
     *      manager, `welcome-screen.js:946-948`) can be handed a name that is
     *      not on disk. Same detail shape, honest value.
     * @param {string} fileId Current extension-less chat id.
     * @param {string} newName Requested new name, no extension.
     * @returns {Promise<string|null>} The name the file actually has now, or
     *   null when nothing was renamed.
     */
    async rename(fileId, newName) {
        const avatar = activeAvatarUrl();
        const chid = activeCharacterIndex();
        if (!avatar || chid < 0) {
            return null;
        }
        const oldFileName = String(fileId ?? '');
        const requested = String(newName ?? '').trim();
        if (!oldFileName || !requested) {
            return null;
        }
        const body = {
            avatar_url: avatar,
            original_file: `${oldFileName}.jsonl`,
            renamed_file: `${requested}.jsonl`,
        };
        if (body.original_file === body.renamed_file) {
            console.debug('[kotatsu branches] rename cancelled, old and new names are the same');
            return null;
        }
        if (equalsIgnoreCaseAndAccents(body.original_file, body.renamed_file)) {
            console.debug('[kotatsu branches] rename cancelled, names differ only by case or accents');
            return null;
        }

        const wasActive = activeChatId() === oldFileName;
        let finalName = requested;
        try {
            const response = await fetch(RENAME_URL, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                this.#reportFailure(`rename:${response.status}`, `rename endpoint answered ${response.status}`);
                return null;
            }
            const data = await response.json();
            if (!data || data.error) {
                this.#reportFailure('rename:error', 'rename endpoint returned an error payload');
                return null;
            }
            if (typeof data.sanitizedFileName === 'string' && data.sanitizedFileName) {
                finalName = data.sanitizedFileName;
            }
        } catch (error) {
            this.#reportFailure('rename:throw', 'rename request failed', error);
            return null;
        }

        try {
            if (wasActive && characters[chid]?.chat === oldFileName) {
                characters[chid].chat = finalName;
                const pole = document.getElementById('selected_chat_pole');
                if (pole instanceof HTMLInputElement) {
                    // Same write as core's `$('#selected_chat_pole').val(...)`
                    // (script.js:10683) — a hidden input (index.html:6221), and
                    // `createOrEditCharacter()` reads it off the form.
                    pole.value = finalName;
                }
                await createOrEditCharacter();
            }
            if (wasActive) {
                await reloadCurrentChat();
            } else if (chat_metadata && chat_metadata.main_chat === oldFileName) {
                // The open chat is a CHILD of the renamed one. The server just
                // healed its on-disk `main_chat`, but this tab's in-memory copy
                // still holds the old name — and a client save is a whole-file
                // rewrite from memory (data-contract §2.5), so the next autosave
                // would silently un-heal it. Patch memory to match disk.
                chat_metadata.main_chat = finalName;
            }
            await eventSource.emit(event_types.CHAT_RENAMED, {
                avatarId: avatar,
                groupId: undefined,
                oldFileName: body.original_file,
                newFileName: `${finalName}.jsonl`,
            });
        } catch (error) {
            console.error('[kotatsu branches] rename bookkeeping failed after a successful rename', error);
        }

        await this.#refresh('rename');
        return finalName;
    }

    /**
     * Deletes a chat of the active character through the core export
     * (`script.js:1365`), which also picks a replacement chat when the open one
     * is the victim and emits `CHAT_DELETED` itself.
     *
     * Children of the deleted chat are *not* reparented (doc decision 5); they
     * surface as orphan roots on the next tree read.
     *
     * Deleting the **open** chat needs one step core's export does not take, and
     * it is a data-safety step, not a cosmetic one — see the inline note.
     * @param {string} fileId Extension-less chat id.
     * @returns {Promise<boolean>} True when the delete call completed.
     */
    async delete(fileId) {
        const chid = activeCharacterIndex();
        const id = String(fileId ?? '');
        if (chid < 0 || !id) {
            return false;
        }
        const wasActive = activeChatId() === id;
        try {
            await deleteCharacterChatByName(String(chid), id);
        } catch (error) {
            console.error('[kotatsu branches] delete failed', error);
            return false;
        }
        try {
            // When the victim was the open chat, core picks a replacement and
            // persists it (`updateRemoteChatName`, script.js:1390-1399) but stops
            // there: `chat` in memory and the DOM still hold the deleted chat.
            // `replaceCurrentChat` (script.js:1405-1431) — the path core's own
            // "delete current chat" button takes — finishes with the chat pole
            // and a load, so this does the same. Without it the next
            // `saveChatConditional()` writes the dead chat's messages under the
            // replacement's name and trips the integrity guard (script.js:7383,
            // 7430) with a data-loss popup.
            //
            // `characters[chid].chat !== id` is the only honest success signal
            // available: the export returns void and logs its own failures.
            const replacement = characters[chid]?.chat;
            if (wasActive && typeof replacement === 'string' && replacement && replacement !== id) {
                const pole = document.getElementById('selected_chat_pole');
                if (pole instanceof HTMLInputElement) {
                    pole.value = replacement;
                }
                await reloadCurrentChat();
            }
        } catch (error) {
            console.error('[kotatsu branches] post-delete reload failed', error);
        }
        await this.#refresh('delete');
        return true;
    }

    /**
     * Synchronous ancestry of a chat, over the tree already in cache.
     * Never fetches: a render pass must not be able to start network traffic.
     * @param {string} fileId Extension-less chat id.
     * @returns {string[]} `[rootId, …, fileId]`, or `[]` when the tree is not
     *   cached or does not know the id.
     */
    lineage(fileId) {
        const avatar = activeAvatarUrl();
        if (!avatar) {
            return [];
        }
        return lineageOf(this.#cache.get(avatar), fileId);
    }

    /**
     * Registers a change listener. Fires after every store mutation and after
     * every event-driven refresh — including refreshes that produced no change,
     * because the *active* chat may have moved even when the forest did not.
     * @param {BranchStoreListener} listener Called with the change reason.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => { };
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Fetches and caches one character's tree.
     * @param {string} avatar `avatar_url` of the character.
     * @returns {Promise<BranchTree>} The tree, or `EMPTY_TREE` on any failure.
     */
    #fetchTree(avatar) {
        const token = ++this.#token;
        this.#issued.set(avatar, token);
        const promise = this.#requestTree(avatar, token);
        this.#inflight.set(avatar, promise);
        return promise;
    }

    /**
     * @param {string} avatar `avatar_url` of the character.
     * @param {number} token Fetch token issued by {@link BranchStore.#fetchTree}.
     * @returns {Promise<BranchTree>} The tree, or `EMPTY_TREE` on any failure.
     */
    async #requestTree(avatar, token) {
        try {
            const response = await fetch(TREE_URL, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            if (!response.ok) {
                // 404 = no chat folder for this character, and everything else is
                // a server-side problem. Both are "no tree", reported once.
                this.#reportFailure(`tree:${avatar}:${response.status}`, `tree endpoint answered ${response.status}`);
                return EMPTY_TREE;
            }
            const tree = normalizeTree(await response.json());
            if (this.#issued.get(avatar) === token) {
                this.#loggedFailures.clear();
                this.#cache.set(avatar, tree);
                this.#evictOldTrees();
            }
            return tree;
        } catch (error) {
            this.#reportFailure(`tree:${avatar}:throw`, 'tree request failed', error);
            return EMPTY_TREE;
        } finally {
            // Only the newest request owns the in-flight slot; a superseded one
            // that lands late must not clear its successor's entry.
            if (this.#issued.get(avatar) === token) {
                this.#inflight.delete(avatar);
            }
        }
    }

    /** Trims the warm-tree cache back to {@link CACHE_MAX_CHARACTERS}. */
    #evictOldTrees() {
        while (this.#cache.size > CACHE_MAX_CHARACTERS) {
            const oldest = this.#cache.keys().next();
            if (oldest.done) {
                return;
            }
            this.#cache.delete(oldest.value);
        }
    }

    /**
     * Coalesces the burst a single navigation produces (`CHAT_CHANGED` plus
     * whatever the caller emitted).
     * @param {string} reason Event type that asked for the refresh.
     * @returns {void}
     */
    #scheduleRefresh(reason) {
        if (this.#refreshTimer !== 0) {
            return;
        }
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = 0;
            void this.#refresh(reason);
        }, REFRESH_DEBOUNCE_MS);
    }

    /**
     * Refetches the active character's tree and tells subscribers.
     *
     * Cancels any pending debounced refresh first, so a mutation that emitted
     * its own core event (rename, or core's `CHAT_DELETED`) pays for exactly one
     * round trip instead of two. Skips the fetch entirely when nobody is
     * subscribed and no tree is warm — the first `tree()` call will pay for it.
     * @param {string} reason What moved.
     * @returns {Promise<void>}
     */
    async #refresh(reason) {
        if (this.#refreshTimer !== 0) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = 0;
        }
        const avatar = activeAvatarUrl();
        if (avatar && (this.#listeners.size > 0 || this.#cache.has(avatar))) {
            await this.tree(true);
        }
        this.#notify(reason, avatar);
    }

    /**
     * @param {string} reason What moved.
     * @param {string} [avatarUrl] Character in context; read live when omitted.
     * @returns {void}
     */
    #notify(reason, avatarUrl) {
        const detail = { reason, avatarUrl: avatarUrl ?? activeAvatarUrl() };
        for (const listener of [...this.#listeners]) {
            try {
                listener(detail);
            } catch (error) {
                console.error('[kotatsu branches] listener threw', error);
            }
        }
    }

    /**
     * One `console.error` per distinct failure; the set is cleared by the next
     * successful tree read so a recovered server re-arms the reporting.
     * @param {string} key Dedupe key.
     * @param {string} message What went wrong.
     * @param {unknown} [error] Optional cause.
     * @returns {void}
     */
    #reportFailure(key, message, error) {
        if (this.#loggedFailures.has(key)) {
            return;
        }
        this.#loggedFailures.add(key);
        if (error === undefined) {
            console.error(`[kotatsu branches] ${message}`);
        } else {
            console.error(`[kotatsu branches] ${message}`, error);
        }
    }
}

/** The page-wide branch store — SPEC §7A's `BranchStore`. */
export const branchStore = new BranchStore();

/**
 * Registration entry for the `firstLoadInit()` seam, invoked from
 * `initKotatsuShell()` the way `initKotatsuTheme()` calls `initThemeLoader()`.
 * Wiring only — no fetch happens until a UI asks for a tree.
 * @returns {void}
 */
export function initBranchStore() {
    branchStore.init();
}
