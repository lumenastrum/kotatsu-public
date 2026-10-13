/**
 * The left rail's Chats section, v2: the shape of a character's (or a scene's) chat list.
 *
 * Three things the flat list of chat files does not say on its own:
 *   1. Branches fold under their parent (`foldBranches`). Core names a branch `<parent> - Branch #N`
 *      (bookmarks.js `buildBranchName`: a branch of a branch strips the old suffix first, so every
 *      branch of a family is named after the family's ROOT). A chat named that way whose parent is
 *      in the list rides under the parent as an offshoot instead of taking a row of its own.
 *   2. Pins (`splitPins`, `withPin`, `renamePin`): a shelf of chosen chats above everything else,
 *      kept in `power_user.kotatsu_chat_pins = { [ownerKey]: string[] }`.
 *   3. Folders from names (`buildFolders`): names are split on " - " (the only separator, after the
 *      branch suffix comes off) and any prefix two or more chats share becomes a folder, recursively.
 *      A stamped name (`Hana Kurogane - 2026-10-08@15h17m40s600ms`, `chat-label.js`) never splits:
 *      every core-named chat would otherwise land in one folder named after the character.
 *
 * Pure: no DOM, no core imports. Unit-tested under node (tests/chat-tree.test.js).
 */

import { chatLabel } from './chat-label.js';

/** Core's branch suffix, anchored at the end (bookmarks.js:211). */
const BRANCH_SUFFIX = / - Branch #(\d+)$/;

/** The one separator a folder path splits on. */
const SEP = ' - ';

/** Folder-state key of the "Not in a folder" group; no name prefix can produce it. */
export const LOOSE_KEY = '\u0000loose';

/**
 * @typedef {object} TreeRow The fields this module reads off a rail chat row.
 * @property {string} id Extension-less chat id.
 * @property {string} title The chat's name (today always the id).
 * @property {number} lastMs Last message, epoch ms, or 0.
 */

/**
 * A top-level row and the branches folded under it.
 * @template {TreeRow} T
 * @typedef {object} Thread
 * @property {T} row The chat itself.
 * @property {T[]} branches Folded offshoots, newest first. Empty for most chats.
 * @property {number} lastMs Newest activity in the thread: the row's own or any branch's.
 */

/**
 * @template {TreeRow} T
 * @typedef {object} FolderChat
 * @property {'chat'} kind
 * @property {Thread<T>} thread
 * @property {string} label What the row prints inside its folder: the rest of the name past the
 *   folder's path ("Main" in `Willam - Lady Blackwood`), or the last segment when the chat's path IS
 *   the folder's ("Thorne" inside Thorne).
 */

/**
 * @template {TreeRow} T
 * @typedef {object} FolderEntry
 * @property {'folder'} kind
 * @property {FolderNode<T>} folder
 */

/**
 * @template {TreeRow} T
 * @typedef {object} FolderNode
 * @property {string} key Stable id for open/closed state: the path joined with " - " (a segment can
 *   never contain the separator, so this is unambiguous).
 * @property {string} name The folder's own segment.
 * @property {string[]} path Every segment from the top.
 * @property {number} count Chats inside, at any depth, folded branches included.
 * @property {number} lastMs Newest activity inside.
 * @property {Array<FolderChat<T>|FolderEntry<T>>} items Chats whose path equals the folder's first,
 *   then subfolders and chats together, newest first.
 */

/**
 * @template {TreeRow} T
 * @typedef {object} FolderTree
 * @property {FolderNode<T>[]} folders Top-level folders, newest activity first.
 * @property {Thread<T>[]} loose Chats in no folder ("Not in a folder"), newest first.
 */

/**
 * The parent a branch's name points at, or null when the name is not a core branch name.
 * @param {string} title
 * @returns {string|null}
 */
export function branchParentName(title) {
    const text = String(title ?? '');
    const match = BRANCH_SUFFIX.exec(text);
    return match && match.index > 0 ? text.slice(0, match.index) : null;
}

/**
 * The branch number a name carries, or null.
 * @param {string} title
 * @returns {number|null}
 */
export function branchNumber(title) {
    const match = BRANCH_SUFFIX.exec(String(title ?? ''));
    return match && match.index > 0 ? Number(match[1]) : null;
}

/**
 * The folder path of a name: the branch suffix removed, then split on " - ".
 * @param {string} title
 * @returns {string[]}
 */
export function namePath(title) {
    const text = String(title ?? '');
    return (branchParentName(text) ?? text).split(SEP);
}

/**
 * What an offshoot prints under its parent: "Branch #3" when it carries the parent's own name, else
 * its name as the rail would print it anywhere else.
 * @param {string} childTitle
 * @param {string} parentTitle
 * @returns {string}
 */
export function branchLabel(childTitle, parentTitle) {
    const n = branchNumber(childTitle);
    if (n !== null && branchParentName(childTitle) === parentTitle) return `Branch #${n}`;
    return chatLabel(childTitle).text;
}

/**
 * Newest first, stable for ties.
 * @template {{ lastMs: number }} R
 * @param {R[]} list
 * @returns {R[]}
 */
function byRecency(list) {
    return list
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (b.item.lastMs - a.item.lastMs) || (a.index - b.index))
        .map(({ item }) => item);
}

/**
 * Folds branches under their parent.
 *
 * A row folds when its name is `<parent> - Branch #N` and `<parent>` is in the list. When the named
 * parent is NOT in the list (renamed through the healing path, which re-points the children's
 * `main_chat` but cannot rename them), `parentOf` — the branch tree's child → parent links — may
 * name the real one. Parentage is followed to the top, so a branch of a branch lands under the
 * family's root, one level deep. A chat in `keepTop` (a pinned chat) never folds: it is a row of its
 * own, and its parent does not count it.
 *
 * @template {TreeRow} T
 * @param {T[]} rows
 * @param {object} [options]
 * @param {ReadonlyMap<string, string>} [options.parentOf] Child id → parent id (branch tree edges).
 *   Consulted only for chats whose own name is a branch name.
 * @param {ReadonlySet<string>} [options.keepTop] Ids that never fold.
 * @returns {Thread<T>[]} Top-level threads, newest activity first.
 */
export function foldBranches(rows, { parentOf = undefined, keepTop = undefined } = {}) {
    /** @type {Map<string, T>} */
    const byId = new Map();
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);

    /**
     * The direct parent this row folds under, or null.
     * @param {T} row
     * @returns {string|null}
     */
    const directParent = (row) => {
        if (keepTop?.has(row.id)) return null;
        const named = branchParentName(row.title);
        if (named === null) return null;
        if (named !== row.id && byId.has(named)) return named;
        const linked = parentOf?.get(row.id);
        if (linked && linked !== row.id && byId.has(linked)) return linked;
        return null;
    };

    /** @type {Map<string, string>} child id → the top of its family */
    const rootOf = new Map();
    for (const row of byId.values()) {
        let current = row.id;
        const seen = new Set([current]);
        let parent = directParent(row);
        while (parent !== null && !seen.has(parent)) {
            seen.add(parent);
            current = parent;
            parent = directParent(/** @type {T} */ (byId.get(parent)));
        }
        // A cycle (a ← b ← a) has no top: every chat in it stays a row of its own.
        if (parent !== null) continue;
        if (current !== row.id) rootOf.set(row.id, current);
    }

    /** @type {Map<string, Thread<T>>} */
    const threads = new Map();
    for (const row of byId.values()) {
        if (!rootOf.has(row.id)) threads.set(row.id, { row, branches: [], lastMs: row.lastMs });
    }
    for (const row of byId.values()) {
        const root = rootOf.get(row.id);
        if (root === undefined) continue;
        const thread = threads.get(root);
        if (thread) thread.branches.push(row);
    }
    for (const thread of threads.values()) {
        thread.branches = byRecency(thread.branches);
        for (const branch of thread.branches) thread.lastMs = Math.max(thread.lastMs, branch.lastMs);
    }
    return byRecency([...threads.values()]);
}

/**
 * Splits threads into the pinned shelf and the rest. Pins naming a chat that is not in the list are
 * ignored. Order is kept (newest first) on both sides.
 * @template {TreeRow} T
 * @param {Thread<T>[]} threads
 * @param {Iterable<string>} pinIds
 * @returns {{ pinned: Thread<T>[], rest: Thread<T>[] }}
 */
export function splitPins(threads, pinIds) {
    const pins = new Set(pinIds);
    /** @type {Thread<T>[]} */
    const pinned = [];
    /** @type {Thread<T>[]} */
    const rest = [];
    for (const thread of threads) (pins.has(thread.row.id) ? pinned : rest).push(thread);
    return { pinned, rest };
}

/**
 * Folders from names.
 * @template {TreeRow} T
 * @param {Thread<T>[]} threads Top-level threads (`foldBranches`, pins already taken out).
 * @param {object} [options]
 * @param {(title: string) => boolean} [options.isStamped] True for a core-stamped name, which never
 *   splits. Defaults to `chatLabel(title).stamped`.
 * @returns {FolderTree<T>}
 */
export function buildFolders(threads, { isStamped = title => chatLabel(title).stamped } = {}) {
    /** @type {Thread<T>[]} */
    const loose = [];
    /** @type {Array<{ thread: Thread<T>, path: string[] }>} */
    const pathed = [];
    for (const thread of threads) {
        if (isStamped(thread.row.title)) loose.push(thread);
        else pathed.push({ thread, path: namePath(thread.row.title) });
    }

    /** @type {FolderNode<T>[]} */
    const folders = [];
    for (const item of level(pathed, [])) {
        if (item.kind === 'folder') folders.push(item.folder);
        else loose.push(item.thread);
    }
    return { folders: byRecency(folders), loose: byRecency(loose) };
}

/**
 * One level of the folder tree: every entry's path starts with `prefix`.
 * @template {TreeRow} T
 * @param {Array<{ thread: Thread<T>, path: string[] }>} entries
 * @param {string[]} prefix
 * @returns {Array<FolderChat<T>|FolderEntry<T>>}
 */
function level(entries, prefix) {
    const depth = prefix.length;
    /** @type {FolderChat<T>[]} */
    const own = [];
    /** @type {Map<string, Array<{ thread: Thread<T>, path: string[] }>>} */
    const bySegment = new Map();
    for (const entry of entries) {
        if (entry.path.length === depth) {
            own.push({ kind: 'chat', thread: entry.thread, label: chatInFolderLabel(entry, prefix) });
            continue;
        }
        const segment = entry.path[depth];
        const group = bySegment.get(segment);
        if (group) group.push(entry);
        else bySegment.set(segment, [entry]);
    }

    /** @type {Array<{ item: FolderChat<T>|FolderEntry<T>, lastMs: number }>} */
    const mixed = [];
    for (const [segment, group] of bySegment) {
        if (group.length >= 2) {
            const path = [...prefix, segment];
            /** @type {FolderNode<T>} */
            const folder = {
                key: path.join(SEP),
                name: segment,
                path,
                count: group.reduce((sum, { thread }) => sum + 1 + thread.branches.length, 0),
                lastMs: group.reduce((max, { thread }) => Math.max(max, thread.lastMs), 0),
                items: level(group, path),
            };
            mixed.push({ item: { kind: 'folder', folder }, lastMs: folder.lastMs });
        } else {
            const [entry] = group;
            mixed.push({ item: { kind: 'chat', thread: entry.thread, label: chatInFolderLabel(entry, prefix) }, lastMs: entry.thread.lastMs });
        }
    }

    const ownSorted = byRecency(own.map(item => ({ item, lastMs: item.thread.lastMs })));
    return [...ownSorted, ...byRecency(mixed)].map(({ item }) => item);
}

/**
 * The rest of a chat's name past its folder's path, the branch suffix kept.
 * @template {TreeRow} T
 * @param {{ thread: Thread<T>, path: string[] }} entry
 * @param {string[]} prefix
 * @returns {string}
 */
function chatInFolderLabel(entry, prefix) {
    const title = entry.thread.row.title;
    const n = branchNumber(title);
    const rest = entry.path.slice(prefix.length).join(SEP);
    if (!rest) return n === null ? entry.path[entry.path.length - 1] : `Branch #${n}`;
    if (prefix.length === 0) return title;
    return n === null ? rest : `${rest}${SEP}Branch #${n}`;
}

/**
 * The keys of the folders holding a chat, outermost first; `[LOOSE_KEY]` when it is in no folder;
 * `[]` when it is not in the tree at all. A folded branch counts as where its parent is.
 * @template {TreeRow} T
 * @param {FolderTree<T>} tree
 * @param {string} chatId
 * @returns {string[]}
 */
export function folderKeysOf(tree, chatId) {
    if (!chatId) return [];
    /** @param {Thread<T>} thread */
    const holds = thread => thread.row.id === chatId || thread.branches.some(branch => branch.id === chatId);
    /**
     * @param {FolderNode<T>} folder
     * @returns {string[]|null}
     */
    const walk = (folder) => {
        for (const item of folder.items) {
            if (item.kind === 'chat') {
                if (holds(item.thread)) return [folder.key];
            } else {
                const inner = walk(item.folder);
                if (inner) return [folder.key, ...inner];
            }
        }
        return null;
    };
    for (const folder of tree.folders) {
        const found = walk(folder);
        if (found) return found;
    }
    return tree.loose.some(holds) ? [LOOSE_KEY] : [];
}

/**
 * The thread a chat is shown in (its own, or its parent's when it is a folded branch).
 * @template {TreeRow} T
 * @param {Thread<T>[]} threads
 * @param {string} chatId
 * @returns {Thread<T>|undefined}
 */
export function threadOf(threads, chatId) {
    if (!chatId) return undefined;
    return threads.find(thread => thread.row.id === chatId || thread.branches.some(branch => branch.id === chatId));
}

/**
 * @typedef {Record<string, string[]>} PinStore `power_user.kotatsu_chat_pins`.
 */

/**
 * The pins of one owner, from whatever the settings hold.
 * @param {unknown} store
 * @param {string} owner
 * @returns {string[]}
 */
export function pinsFor(store, owner) {
    if (!owner || !store || typeof store !== 'object') return [];
    const list = /** @type {Record<string, unknown>} */ (store)[owner];
    return Array.isArray(list) ? list.filter(id => typeof id === 'string' && id.length > 0) : [];
}

/**
 * The store with one chat pinned or unpinned. The owner's list is pruned to `liveIds` on the way
 * (pins of chats that are gone), and an owner with no pins left is dropped.
 * @param {unknown} store
 * @param {string} owner
 * @param {string} chatId
 * @param {boolean} pinned
 * @param {Iterable<string>} liveIds Every chat id the owner has now.
 * @returns {PinStore}
 */
export function withPin(store, owner, chatId, pinned, liveIds) {
    const live = new Set(liveIds);
    const list = pinsFor(store, owner).filter(id => live.has(id) && id !== chatId);
    if (pinned) list.push(chatId);
    return withOwnerList(store, owner, list);
}

/**
 * The store with a renamed chat's pin following it. Returns null when the chat was not pinned.
 * @param {unknown} store
 * @param {string} owner
 * @param {string} oldId
 * @param {string} newId
 * @returns {PinStore|null}
 */
export function renamePin(store, owner, oldId, newId) {
    const list = pinsFor(store, owner);
    if (!list.includes(oldId) || !newId || oldId === newId) return null;
    const next = [];
    for (const id of list) {
        const mapped = id === oldId ? newId : id;
        if (!next.includes(mapped)) next.push(mapped);
    }
    return withOwnerList(store, owner, next);
}

/**
 * @param {unknown} store
 * @param {string} owner
 * @param {string[]} list
 * @returns {PinStore}
 */
function withOwnerList(store, owner, list) {
    /** @type {PinStore} */
    const next = {};
    if (store && typeof store === 'object' && !Array.isArray(store)) {
        for (const [key, value] of Object.entries(store)) {
            if (Array.isArray(value)) next[key] = value.filter(id => typeof id === 'string');
        }
    }
    if (list.length) next[owner] = list;
    else delete next[owner];
    return next;
}

/**
 * The view a section opens in when the reader has not picked one for this owner yet.
 * @param {number} chatCount
 * @returns {'recent'|'folders'}
 */
export function defaultView(chatCount) {
    return chatCount >= 30 ? 'folders' : 'recent';
}
