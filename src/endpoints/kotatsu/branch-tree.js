/**
 * Kotatsu branch engine — chat folder scanner, sidecar index, and the rename heal.
 *
 * Design: `docs/branch-panel-v0.md` (slice A). Contract: `docs/data-contract.md`
 * §2 (chat `.jsonl` format, header rule, integrity slug) and §7 (dotfolder policy).
 *
 * The sidecar at `chats/<char>/.kotatsu/tree.json` is a cache and nothing else:
 * it is rebuildable from the `.jsonl` files alone, discarded silently when it is
 * corrupt or carries the wrong version, and refreshed lazily from `{size, mtimeMs}`
 * provenance on every read.
 *
 * This module deliberately avoids `src/util.js` so it stays importable from Jest
 * without booting the server config system.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Buffer } from 'node:buffer';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

/** Dotfolder holding Kotatsu-owned per-character state (data-contract §7.1). */
export const KOTATSU_DIRECTORY = '.kotatsu';

/** Sidecar file name inside the dotfolder. */
export const TREE_FILE = 'tree.json';

/**
 * Pinned sidecar schema version. Anything else is discarded and rebuilt.
 * v2: leafPreview peels leading HTML banner elements (same shape as v1 — the
 * bump just invalidates cached previews built under the old rule).
 */
export const TREE_VERSION = 2;

/** Chat file extension, matching every core enumerator (data-contract §7.2). */
const CHAT_EXTENSION = '.jsonl';

/** Plain-text characters kept for the leaf preview. */
const PREVIEW_LENGTH = 200;

/** Messages read eagerly per file during orphan adoption before falling back to a full walk. */
const ADOPTION_HEAD_DEPTH = 16;

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * @typedef {object} BranchMarker
 * @property {string} name Referenced chat name (checkpoint target or branch child).
 * @property {number} mesIndex Index of the annotated message, header excluded.
 */

/**
 * @typedef {object} ChatFileEntry
 * @property {number} size Byte size at scan time (provenance).
 * @property {number} mtimeMs Modification time at scan time (provenance).
 * @property {number} messageCount Parseable message lines, header excluded.
 * @property {boolean} hasHeader Whether line 0 carries `chat_metadata` (data-contract §2.2).
 * @property {string|null} mainChat `chat_metadata.main_chat`, or null.
 * @property {string|null} lastMessageAt Last message `send_date`, ISO where parseable.
 * @property {string} leafPreview Last message `mes` as plain text, first 200 characters.
 * @property {BranchMarker[]} checkpoints `extra.bookmark_link` markers.
 * @property {BranchMarker[]} branchNotes `extra.branches[]` markers.
 */

/**
 * @typedef {object} BranchEdge
 * @property {string} child Child file id.
 * @property {string|null} parent Resolved parent file id, or null when unresolved.
 * @property {string} [orphanName] Set when `mainChat` names a missing file.
 * @property {number|null} forkIndex First-divergence index, or null when not yet computed.
 * @property {'header'|'adopted'} via How the edge was resolved.
 */

/**
 * @typedef {object} BranchTree
 * @property {number} version
 * @property {Record<string, ChatFileEntry>} files
 * @property {BranchEdge[]} edges
 */

/**
 * @typedef {object} BuildStats
 * @property {number} scannedFiles Files streamed during this maintenance pass.
 * @property {boolean} fromCache Whether the sidecar answered without any work.
 * @property {number} ms Wall time of the maintenance pass.
 */

/**
 * @typedef {object} MessageTriple
 * @property {any} send_date
 * @property {any} name
 * @property {any} mes
 */

/** @type {Map<string, Promise<void>>} */
const folderLocks = new Map();

/**
 * Serializes work per chat folder so two requests never scan or heal the same
 * folder concurrently.
 * @template T
 * @param {string} chatFolder Chat folder path.
 * @param {() => Promise<T>} task Work to run under the lock.
 * @returns {Promise<T>}
 */
function withFolderLock(chatFolder, task) {
    const key = path.resolve(chatFolder);
    const previous = folderLocks.get(key) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tracked = current.then(() => undefined, () => undefined);
    folderLocks.set(key, tracked);
    tracked.then(() => {
        if (folderLocks.get(key) === tracked) {
            folderLocks.delete(key);
        }
    });
    return current;
}

/**
 * Parses one `.jsonl` line. Malformed lines are skipped silently, exactly as
 * core does on load (`chats.js:503-513`).
 * @param {string} line Raw line.
 * @returns {Record<string, any> | null}
 */
function parseLine(line) {
    if (!line) {
        return null;
    }

    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The header test from data-contract §2.2. Line 0 is a header only when it
 * carries `chat_metadata`; otherwise it is a real message.
 * @param {Record<string, any> | null} value Parsed line 0.
 * @returns {boolean}
 */
function isHeaderLine(value) {
    return !!value && Object.hasOwn(value, 'chat_metadata');
}

/**
 * Compares two strings without locale sensitivity, so sidecar ordering is stable
 * across machines.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/**
 * Normalizes a message timestamp. Strings are kept verbatim; epoch numbers are
 * converted to ISO; anything else is null.
 * @param {any} value Raw `send_date`.
 * @returns {string|null}
 */
function toTimestamp(value) {
    if (typeof value === 'string' && value.trim()) {
        return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    return null;
}

/**
 * Block-level tags whose leading occurrence is chrome, not story. An inline
 * element at the head of a message (`<b>hello</b> there`) is formatted prose
 * and its text belongs in the preview — only block containers are peeled.
 */
const PREVIEW_BLOCK_TAGS = new Set([
    'div', 'p', 'table', 'blockquote', 'details', 'section', 'aside', 'figure',
    'pre', 'ul', 'ol', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'footer', 'article', 'center', 'hr',
]);

/**
 * Skips one leading block-level HTML element, nesting-aware. Presets commonly
 * open every message with a styled banner (scene/status trackers as a raw
 * `<div>…</div>`); a preview that starts there spends its whole budget on
 * chrome instead of story.
 * @param {string} text Text that may begin with an element.
 * @returns {string|null} The remainder after the element, or null when the
 *   text does not begin with a block element (or it never closes — malformed
 *   markup is left for the tag-stripper, never guessed at).
 */
function skipLeadingElement(text) {
    const open = text.match(/^<([a-zA-Z][\w-]*)\b[^>]*>/);
    if (!open || !PREVIEW_BLOCK_TAGS.has(open[1].toLowerCase())) {
        return null;
    }
    if (open[0].endsWith('/>') || open[1].toLowerCase() === 'hr') {
        return text.slice(open[0].length);
    }
    const scanner = new RegExp(`<(/?)${open[1]}(?=[\\s>/])[^>]*>`, 'gi');
    scanner.lastIndex = open[0].length;
    let depth = 1;
    for (let match = scanner.exec(text); match; match = scanner.exec(text)) {
        depth += match[1] === '/' ? -1 : 1;
        if (depth === 0) {
            return text.slice(match.index + match[0].length);
        }
    }
    return null;
}

/**
 * Reduces a message body to a plain-text preview. Leading HTML elements are
 * peeled first so the preview opens on prose; a message that is NOTHING BUT
 * banner keeps the banner text — an empty preview would be dishonest.
 * @param {any} value Raw `mes`.
 * @returns {string}
 */
function toPreview(value) {
    if (typeof value !== 'string' || !value) {
        return '';
    }

    let body = value.trimStart();
    for (;;) {
        const rest = skipLeadingElement(body);
        if (rest === null || !rest.trim()) {
            break;
        }
        body = rest.trimStart();
    }

    return body
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PREVIEW_LENGTH);
}

/**
 * Extracts the divergence triple used by the fork walk.
 * @param {Record<string, any>} message Parsed message.
 * @returns {MessageTriple}
 */
function toTriple(message) {
    return {
        send_date: message.send_date ?? null,
        name: message.name ?? null,
        mes: message.mes ?? null,
    };
}

/**
 * Compares two divergence triples.
 * @param {MessageTriple} left
 * @param {MessageTriple} right
 * @returns {boolean}
 */
function sameTriple(left, right) {
    return left.send_date === right.send_date
        && left.name === right.name
        && left.mes === right.mes;
}

/**
 * Builds a fresh streaming line reader. Written from scratch rather than reusing
 * core's `getChatInfo`, which never resolves for a non-empty file whose final
 * readline line is empty (`chats.js:415-428`).
 * @param {string} filePath Chat file path.
 * @returns {{ next: () => Promise<Record<string, any> | null>, close: () => void }}
 */
function createMessageReader(filePath) {
    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const iterator = rl[Symbol.asyncIterator]();
    let lineIndex = 0;

    return {
        async next() {
            for (;;) {
                const result = await iterator.next();
                if (result.done) {
                    return null;
                }

                lineIndex += 1;
                const parsed = parseLine(String(result.value));
                if (!parsed) {
                    continue;
                }

                if (lineIndex === 1 && isHeaderLine(parsed)) {
                    continue;
                }

                return parsed;
            }
        },
        close() {
            rl.close();
            stream.destroy();
        },
    };
}

/**
 * Streams one chat file and collects everything the tree needs.
 *
 * `messageCount` counts parseable message lines with the header excluded. For a
 * well-formed file that is exactly "lines minus header"; for a file with a blank
 * or malformed line it is the count the client would see after `getChatData`
 * filters, which is what `mesIndex` has to agree with.
 * @param {string} filePath Chat file path.
 * @returns {Promise<ChatFileEntry>}
 */
export async function scanChatFile(filePath) {
    const stats = await fs.promises.stat(filePath);

    /** @type {ChatFileEntry} */
    const entry = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        messageCount: 0,
        hasHeader: false,
        mainChat: null,
        lastMessageAt: null,
        leafPreview: '',
        checkpoints: [],
        branchNotes: [],
    };

    if (stats.size === 0) {
        return entry;
    }

    const stream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineIndex = 0;

    try {
        for await (const rawLine of rl) {
            lineIndex += 1;
            const parsed = parseLine(String(rawLine));
            if (!parsed) {
                continue;
            }

            if (lineIndex === 1 && isHeaderLine(parsed)) {
                entry.hasHeader = true;
                const metadata = parsed.chat_metadata;
                const mainChat = metadata && typeof metadata === 'object' ? metadata.main_chat : null;
                entry.mainChat = typeof mainChat === 'string' && mainChat ? mainChat : null;
                continue;
            }

            const mesIndex = entry.messageCount;
            entry.messageCount += 1;

            const extra = parsed.extra;
            if (extra && typeof extra === 'object') {
                if (typeof extra.bookmark_link === 'string' && extra.bookmark_link) {
                    entry.checkpoints.push({ name: extra.bookmark_link, mesIndex });
                }

                if (Array.isArray(extra.branches)) {
                    for (const name of extra.branches) {
                        if (typeof name === 'string' && name) {
                            entry.branchNotes.push({ name, mesIndex });
                        }
                    }
                }
            }

            entry.lastMessageAt = toTimestamp(parsed.send_date);
            entry.leafPreview = toPreview(parsed.mes);
        }
    } finally {
        rl.close();
        stream.destroy();
    }

    return entry;
}

/**
 * Walks two chats line-parallel and returns the first-divergence index — the
 * fork point. Each file is checked for its own header independently.
 * @param {string} parentPath Parent chat file path.
 * @param {string} childPath Child chat file path.
 * @returns {Promise<number|null>} Fork index, or null when a file is unreadable.
 */
export async function computeForkIndex(parentPath, childPath) {
    /** @type {{ next: () => Promise<Record<string, any> | null>, close: () => void } | null} */
    let parentReader = null;
    /** @type {{ next: () => Promise<Record<string, any> | null>, close: () => void } | null} */
    let childReader = null;

    try {
        parentReader = createMessageReader(parentPath);
        childReader = createMessageReader(childPath);

        let index = 0;
        for (;;) {
            const [parentMessage, childMessage] = await Promise.all([
                parentReader.next(),
                childReader.next(),
            ]);

            if (!parentMessage || !childMessage) {
                return index;
            }

            if (!sameTriple(toTriple(parentMessage), toTriple(childMessage))) {
                return index;
            }

            index += 1;
        }
    } catch {
        return null;
    } finally {
        parentReader?.close();
        childReader?.close();
    }
}

/**
 * Reads the first `limit` message triples of a file, used to eliminate adoption
 * candidates without opening a full parallel walk.
 * @param {string} filePath Chat file path.
 * @param {number} limit Maximum triples to read.
 * @returns {Promise<{ triples: MessageTriple[], complete: boolean }>}
 */
async function readMessageHead(filePath, limit) {
    const reader = createMessageReader(filePath);

    /** @type {MessageTriple[]} */
    const triples = [];
    let complete = false;

    try {
        while (triples.length < limit) {
            const message = await reader.next();
            if (!message) {
                complete = true;
                break;
            }

            triples.push(toTriple(message));
        }
    } catch {
        return { triples, complete: true };
    } finally {
        reader.close();
    }

    return { triples, complete };
}

/**
 * Computes the shared prefix length of two heads. `exact` is false when both
 * heads ran out while still matching, which means a full walk is required.
 * @param {{ triples: MessageTriple[], complete: boolean }} left
 * @param {{ triples: MessageTriple[], complete: boolean }} right
 * @returns {{ length: number, exact: boolean }}
 */
function headPrefix(left, right) {
    const shared = Math.min(left.triples.length, right.triples.length);

    for (let index = 0; index < shared; index++) {
        if (!sameTriple(left.triples[index], right.triples[index])) {
            return { length: index, exact: true };
        }
    }

    if (left.complete || right.complete) {
        return { length: shared, exact: true };
    }

    return { length: shared, exact: false };
}

/**
 * Resolves a file id to its path inside the chat folder.
 * @param {string} chatFolder Chat folder path.
 * @param {string} fileId Extension-less chat id.
 * @returns {string}
 */
function chatFilePath(chatFolder, fileId) {
    return path.join(chatFolder, `${fileId}${CHAT_EXTENSION}`);
}

/**
 * Sidecar path for a chat folder.
 * @param {string} chatFolder Chat folder path.
 * @returns {string}
 */
export function getTreePath(chatFolder) {
    return path.join(chatFolder, KOTATSU_DIRECTORY, TREE_FILE);
}

/**
 * Validates one cached file entry. A single bad entry discards the whole
 * sidecar; the rebuild costs one scan and is always correct.
 * @param {any} entry Candidate entry.
 * @returns {boolean}
 */
function isValidEntry(entry) {
    return !!entry
        && typeof entry === 'object'
        && typeof entry.size === 'number'
        && typeof entry.mtimeMs === 'number'
        && typeof entry.messageCount === 'number'
        && typeof entry.hasHeader === 'boolean'
        && (entry.mainChat === null || typeof entry.mainChat === 'string')
        && (entry.lastMessageAt === null || typeof entry.lastMessageAt === 'string')
        && typeof entry.leafPreview === 'string'
        && Array.isArray(entry.checkpoints)
        && Array.isArray(entry.branchNotes);
}

/**
 * Validates one cached edge.
 * @param {any} edge Candidate edge.
 * @returns {boolean}
 */
function isValidEdge(edge) {
    return !!edge
        && typeof edge === 'object'
        && typeof edge.child === 'string'
        && (edge.parent === null || typeof edge.parent === 'string')
        && (edge.forkIndex === null || typeof edge.forkIndex === 'number')
        && (edge.via === 'header' || edge.via === 'adopted');
}

/**
 * Reads the sidecar. Corrupt, wrong-version, and structurally invalid sidecars
 * are discarded silently and rebuilt (data-contract §7.3).
 * @param {string} chatFolder Chat folder path.
 * @returns {BranchTree|null}
 */
export function readSidecar(chatFolder) {
    try {
        const parsed = JSON.parse(fs.readFileSync(getTreePath(chatFolder), 'utf8'));

        if (!parsed || typeof parsed !== 'object' || parsed.version !== TREE_VERSION) {
            return null;
        }

        if (!parsed.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
            return null;
        }

        if (!Array.isArray(parsed.edges)) {
            return null;
        }

        if (!Object.values(parsed.files).every(isValidEntry) || !parsed.edges.every(isValidEdge)) {
            return null;
        }

        return /** @type {BranchTree} */ (parsed);
    } catch {
        return null;
    }
}

/**
 * Writes the sidecar atomically. A cache that cannot be written must never fail
 * the request that produced it.
 * @param {string} chatFolder Chat folder path.
 * @param {BranchTree} tree Tree payload.
 * @returns {boolean} Whether the sidecar was written.
 */
export function writeSidecar(chatFolder, tree) {
    try {
        const treePath = getTreePath(chatFolder);
        fs.mkdirSync(path.dirname(treePath), { recursive: true });
        writeFileAtomicSync(treePath, JSON.stringify(tree), 'utf8');
        return true;
    } catch (error) {
        console.warn(`Kotatsu: could not write the branch sidecar for "${chatFolder}":`, error);
        return false;
    }
}

/**
 * Rebuilds the edge list from `main_chat` links, carrying forward cached
 * resolutions whose endpoints did not change.
 * @param {Record<string, ChatFileEntry>} files Current file entries.
 * @param {BranchEdge[]} cachedEdges Edges from the sidecar.
 * @param {Set<string>} refreshed Ids re-scanned in this pass.
 * @returns {BranchEdge[]}
 */
function buildEdges(files, cachedEdges, refreshed) {
    /** @type {Map<string, BranchEdge>} */
    const cachedByChild = new Map(cachedEdges.map(edge => [edge.child, edge]));

    /** @type {BranchEdge[]} */
    const edges = [];

    for (const child of Object.keys(files).sort(compareStrings)) {
        const mainChat = files[child].mainChat;
        if (!mainChat || mainChat === child) {
            continue;
        }

        const cached = cachedByChild.get(child);

        if (Object.hasOwn(files, mainChat)) {
            const staleFork = refreshed.has(child) || refreshed.has(mainChat);
            const forkIndex = !staleFork && cached && cached.via === 'header' && cached.parent === mainChat
                ? cached.forkIndex
                : null;

            edges.push({ child, parent: mainChat, forkIndex, via: 'header' });
            continue;
        }

        // The link names a missing file. Keep a confirmed adoption alive while both
        // of its endpoints are unchanged; otherwise the edge returns to orphan state
        // and the adoption pass gets another look at it.
        if (cached && cached.via === 'adopted' && cached.orphanName === mainChat
            && typeof cached.parent === 'string' && Object.hasOwn(files, cached.parent)
            && !refreshed.has(child) && !refreshed.has(cached.parent)) {
            edges.push({
                child,
                parent: cached.parent,
                orphanName: mainChat,
                forkIndex: cached.forkIndex,
                via: 'adopted',
            });
            continue;
        }

        edges.push({ child, parent: null, orphanName: mainChat, forkIndex: null, via: 'header' });
    }

    return edges;
}

/**
 * Walks resolved edges upward to test whether a candidate already descends from
 * a child, which would make adopting it a cycle.
 * @param {Map<string, BranchEdge>} edgesByChild Edge lookup.
 * @param {string} candidate Candidate parent id.
 * @param {string} descendant Child id being adopted.
 * @param {number} depthLimit Hard stop, in case cached edges already contain a cycle.
 * @returns {boolean}
 */
function descendsFrom(edgesByChild, candidate, descendant, depthLimit) {
    let current = candidate;

    for (let hop = 0; hop < depthLimit; hop++) {
        const edge = edgesByChild.get(current);
        if (!edge || !edge.parent) {
            return false;
        }

        if (edge.parent === descendant) {
            return true;
        }

        current = edge.parent;
    }

    return true;
}

/**
 * One adoption pass. For every edge whose `main_chat` names a missing file,
 * candidates are prefiltered by first-message triple equality and the longest
 * confirmed shared prefix wins.
 * @param {string} chatFolder Chat folder path.
 * @param {Record<string, ChatFileEntry>} files Current file entries.
 * @param {BranchEdge[]} edges Edges to mutate in place.
 * @returns {Promise<number>} Number of edges adopted.
 */
async function adoptOrphans(chatFolder, files, edges) {
    const orphans = edges.filter(edge => edge.parent === null && typeof edge.orphanName === 'string');
    if (!orphans.length) {
        return 0;
    }

    const ids = Object.keys(files).sort(compareStrings);

    /** @type {Map<string, { triples: MessageTriple[], complete: boolean }>} */
    const heads = new Map();
    for (const id of ids) {
        heads.set(id, await readMessageHead(chatFilePath(chatFolder, id), ADOPTION_HEAD_DEPTH));
    }

    /** @type {Map<string, BranchEdge>} */
    const edgesByChild = new Map(edges.map(edge => [edge.child, edge]));
    let adopted = 0;

    for (const orphan of orphans) {
        const childHead = heads.get(orphan.child);
        if (!childHead || !childHead.triples.length) {
            continue;
        }

        /** @type {string|null} */
        let bestId = null;
        let bestPrefix = 0;

        for (const candidate of ids) {
            if (candidate === orphan.child) {
                continue;
            }

            const candidateHead = heads.get(candidate);
            if (!candidateHead || !candidateHead.triples.length) {
                continue;
            }

            const probe = headPrefix(candidateHead, childHead);
            if (probe.length < 1) {
                continue;
            }

            if (descendsFrom(edgesByChild, candidate, orphan.child, ids.length)) {
                continue;
            }

            const prefix = probe.exact
                ? probe.length
                : await computeForkIndex(chatFilePath(chatFolder, candidate), chatFilePath(chatFolder, orphan.child));

            if (typeof prefix === 'number' && prefix > bestPrefix) {
                bestPrefix = prefix;
                bestId = candidate;
            }
        }

        if (bestId) {
            orphan.parent = bestId;
            orphan.via = 'adopted';
            orphan.forkIndex = bestPrefix;
            adopted += 1;
        }
    }

    return adopted;
}

/**
 * Lists the chat file ids in a folder, sorted. Dotfolders and non-`.jsonl`
 * entries are invisible here exactly as they are to core (data-contract §7.2).
 * @param {string} chatFolder Chat folder path.
 * @returns {Promise<string[]>}
 */
async function listChatIds(chatFolder) {
    const entries = await fs.promises.readdir(chatFolder, { withFileTypes: true });

    return entries
        .filter(entry => entry.isFile() && path.extname(entry.name) === CHAT_EXTENSION)
        .map(entry => path.parse(entry.name).name)
        .sort(compareStrings);
}

/**
 * Lazy maintenance pass: stat the folder, re-scan only changed or new files,
 * drop vanished ones, recompute edges, and persist the sidecar when anything
 * moved.
 * @param {string} chatFolder Chat folder path.
 * @returns {Promise<{ tree: BranchTree, build: BuildStats }>}
 */
async function maintainTreeUnlocked(chatFolder) {
    const started = Date.now();
    const cached = readSidecar(chatFolder);

    /** @type {Record<string, ChatFileEntry>} */
    const files = {};
    /** @type {Set<string>} */
    const refreshed = new Set();
    let scannedFiles = 0;
    let mutated = !cached;

    for (const id of await listChatIds(chatFolder)) {
        const filePath = chatFilePath(chatFolder, id);

        /** @type {fs.Stats} */
        let stats;
        try {
            stats = await fs.promises.stat(filePath);
        } catch {
            continue;
        }

        const previous = cached?.files?.[id];
        if (previous && previous.size === stats.size && previous.mtimeMs === stats.mtimeMs) {
            files[id] = previous;
            continue;
        }

        files[id] = await scanChatFile(filePath);
        refreshed.add(id);
        scannedFiles += 1;
        mutated = true;
    }

    if (cached && Object.keys(cached.files).some(id => !Object.hasOwn(files, id))) {
        mutated = true;
    }

    const edges = buildEdges(files, cached?.edges ?? [], refreshed);

    // Adoption is a one-pass, cached repair. A warm request that changed nothing
    // keeps the cached resolutions and never re-probes.
    if (mutated) {
        await adoptOrphans(chatFolder, files, edges);
    }

    for (const edge of edges) {
        if (typeof edge.parent === 'string' && edge.forkIndex === null) {
            edge.forkIndex = await computeForkIndex(
                chatFilePath(chatFolder, edge.parent),
                chatFilePath(chatFolder, edge.child),
            );
            mutated = true;
        }
    }

    /** @type {BranchTree} */
    const tree = { version: TREE_VERSION, files, edges };

    if (mutated) {
        writeSidecar(chatFolder, tree);
    }

    return {
        tree,
        build: { scannedFiles, fromCache: !mutated, ms: Date.now() - started },
    };
}

/**
 * Reads the branch tree for a chat folder, refreshing the sidecar as needed.
 * @param {string} chatFolder Chat folder path.
 * @returns {Promise<{ tree: BranchTree, build: BuildStats }>}
 */
export function maintainTree(chatFolder) {
    return withFolderLock(chatFolder, () => maintainTreeUnlocked(chatFolder));
}

/**
 * Reads the `chat_metadata.integrity` slug from a file's first line, the same
 * way core's `checkChatIntegrity` does (`chats.js:316-335`).
 * @param {string} filePath Chat file path.
 * @returns {any} The on-disk slug, or undefined.
 */
function readIntegritySlug(filePath) {
    try {
        const buffer = fs.readFileSync(filePath);
        const header = parseLine(sliceHeaderText(buffer).headText);
        return isHeaderLine(header) && header?.chat_metadata && typeof header.chat_metadata === 'object'
            ? header.chat_metadata.integrity
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Splits a chat file buffer into its line-0 text and the raw remainder. The
 * remainder starts at the newline byte, so lines 1..N — and the file's trailing
 * newline convention — are carried across as bytes.
 * @param {Buffer} buffer Whole file.
 * @returns {{ headText: string, tail: Buffer, hasCarriageReturn: boolean }}
 */
function sliceHeaderText(buffer) {
    const newlineIndex = buffer.indexOf(LINE_FEED);
    const tailStart = newlineIndex === -1 ? buffer.length : newlineIndex;

    let headEnd = tailStart;
    let hasCarriageReturn = false;
    if (headEnd > 0 && buffer[headEnd - 1] === CARRIAGE_RETURN) {
        headEnd -= 1;
        hasCarriageReturn = true;
    }

    return {
        headText: buffer.subarray(0, headEnd).toString('utf8'),
        tail: buffer.subarray(tailStart),
        hasCarriageReturn,
    };
}

/**
 * Repoints one child's `chat_metadata.main_chat` at a renamed parent.
 *
 * This is the sanctioned narrow exception to "all `.jsonl` writes go through
 * `trySaveChat`" (design decision 4): only line 0 is parsed and re-serialized,
 * lines 1..N are carried as raw bytes, the on-disk integrity slug is read and
 * carried through untouched, the file is re-checked against the provenance and
 * slug seen at read time, and the write is atomic.
 * @param {string} filePath Child chat file path.
 * @param {string} oldName Parent chat name currently on the link.
 * @param {string} newName Parent chat name to write.
 * @returns {boolean} Whether the child was healed.
 */
function healChildHeader(filePath, oldName, newName) {
    /** @type {fs.Stats} */
    let statsBefore;
    /** @type {Buffer} */
    let buffer;

    try {
        statsBefore = fs.statSync(filePath);
        buffer = fs.readFileSync(filePath);
    } catch {
        return false;
    }

    const { headText, tail, hasCarriageReturn } = sliceHeaderText(buffer);
    const header = parseLine(headText);

    // Headerless children carry no `main_chat` at all (data-contract §2.2) and are skipped.
    if (!isHeaderLine(header) || !header) {
        return false;
    }

    const metadata = header.chat_metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return false;
    }

    if (metadata.main_chat !== oldName) {
        return false;
    }

    const integritySlug = metadata.integrity;
    metadata.main_chat = newName;

    /** @type {fs.Stats} */
    let statsNow;
    try {
        statsNow = fs.statSync(filePath);
    } catch {
        return false;
    }

    // Lost-update guard, the same job `integrity` does for `trySaveChat`: refuse
    // to write when the file moved under us between the read and the write.
    if (statsNow.size !== statsBefore.size || statsNow.mtimeMs !== statsBefore.mtimeMs) {
        return false;
    }

    if (readIntegritySlug(filePath) !== integritySlug) {
        return false;
    }

    const headBuffer = Buffer.from(JSON.stringify(header) + (hasCarriageReturn ? '\r' : ''), 'utf8');

    try {
        writeFileAtomicSync(filePath, Buffer.concat([headBuffer, tail]));
    } catch (error) {
        console.error(`Kotatsu: could not heal the branch link in "${filePath}":`, error);
        return false;
    }

    return true;
}

/**
 * Heals every child in a folder whose `main_chat` names `oldName`.
 * @param {string} chatFolder Chat folder path.
 * @param {string} oldName Previous parent chat name.
 * @param {string} newName New parent chat name.
 * @returns {Promise<number>} Number of children healed.
 */
export async function healChildren(chatFolder, oldName, newName) {
    let healed = 0;

    for (const id of await listChatIds(chatFolder)) {
        if (id === newName || id === oldName) {
            continue;
        }

        if (healChildHeader(chatFilePath(chatFolder, id), oldName, newName)) {
            healed += 1;
        }
    }

    return healed;
}

/**
 * @typedef {object} RenameResult
 * @property {boolean} ok
 * @property {string} [reason] Failure reason: `source-missing` or `target-exists`.
 * @property {string} [sanitizedFileName] Extension-less new chat name.
 * @property {number} [healedChildren] Children whose `main_chat` was repointed.
 */

/**
 * Renames a chat file and heals the children that pointed at its old name.
 * Guards mirror core's rename route (`chats.js:546-577`); the caller is
 * responsible for sanitizing both names and confining them to the folder.
 * @param {string} chatFolder Chat folder path.
 * @param {string} originalFile Sanitized `.jsonl` source file name.
 * @param {string} renamedFile Sanitized `.jsonl` destination file name.
 * @returns {Promise<RenameResult>}
 */
export function renameChatWithHeal(chatFolder, originalFile, renamedFile) {
    return withFolderLock(chatFolder, async () => {
        const originalPath = path.join(chatFolder, originalFile);
        const renamedPath = path.join(chatFolder, renamedFile);

        if (!fs.existsSync(originalPath)) {
            return { ok: false, reason: 'source-missing' };
        }

        if (fs.existsSync(renamedPath)) {
            return { ok: false, reason: 'target-exists' };
        }

        const oldName = path.parse(originalFile).name;
        const sanitizedFileName = path.parse(renamedFile).name;

        fs.renameSync(originalPath, renamedPath);

        const healedChildren = await healChildren(chatFolder, oldName, sanitizedFileName);
        await maintainTreeUnlocked(chatFolder);

        return { ok: true, sanitizedFileName, healedChildren };
    });
}
