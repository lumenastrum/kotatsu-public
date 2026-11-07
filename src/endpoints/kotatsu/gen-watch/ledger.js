/**
 * Generation watch ledger (issue #28, layer 1).
 *
 * The page tags each generate request with `X-Kotatsu-Gen-Id`. The server counts the bytes
 * the handler writes and notes when it ends, so a page that wakes up after the screen was
 * off can ask "did my reply finish without me?" and stop waiting on a dead connection,
 * without ever killing a live stream that is just quiet (a long thinking phase).
 *
 * Layer 2a (same issue): it also keeps a copy of those bytes, so a page whose connection died
 * mid-reply can fetch what it missed (`read()`) and finish the reply as if nothing happened.
 * The copy is bounded per reply and in total; past the cap the reply is only counted
 * (`truncated`), and the page falls back to layer 1. Pure module, no Express.
 */

/** Entries are forgotten this long after their request ends. */
export const ENDED_TTL_MS = 10 * 60 * 1000;
/** Hard cap so a misbehaving client can't grow the map without bound. */
export const MAX_ENTRIES = 500;
/** One reply's copy stops growing past this (long image replies); it is then `truncated`. */
export const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** All copies together. Ended replies give theirs up first, oldest first. */
export const MAX_TOTAL_BUFFER_BYTES = 64 * 1024 * 1024;
/** Ids are page-made: keep them short and boring. */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * @typedef {object} GenEntry
 * @property {'running'|'done'|'closed'} state running = handler still writing;
 *   done = the handler called end() (the backend finished, whether or not the bytes reached
 *   the page); closed = the connection closed before the handler ended.
 * @property {number} bytes Body bytes the handler wrote (before compression).
 * @property {number} startedAt
 * @property {number} lastWriteAt
 * @property {number|null} endedAt
 * @property {Buffer[]} chunks the bytes themselves, in order (layer 2a)
 * @property {number} held bytes in `chunks`
 * @property {number|null} status the response's HTTP status, once the handler wrote (a page
 *   whose fetch failed before the headers arrived rebuilds the response from this)
 * @property {string|null} type its Content-Type
 * @property {boolean} truncated the copy stopped short of `bytes`: a replay can't be trusted
 */

/**
 * @param {unknown} id
 * @returns {id is string}
 */
export function isValidGenId(id) {
    return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * @param {unknown} chunk
 * @param {unknown} [encoding]
 * @returns {number}
 */
export function chunkBytes(chunk, encoding) {
    if (chunk == null) return 0;
    if (typeof chunk === 'string') {
        const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
        return Buffer.byteLength(chunk, /** @type {BufferEncoding} */ (enc));
    }
    if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
    if (chunk instanceof ArrayBuffer) return chunk.byteLength;
    return 0;
}

/**
 * The exact bytes `res.write(chunk, encoding)` sends, as a Buffer (copied: callers may reuse theirs).
 * @param {unknown} chunk
 * @param {unknown} [encoding]
 * @returns {Buffer|null}
 */
export function chunkBuffer(chunk, encoding) {
    if (chunk == null) return null;
    if (typeof chunk === 'string') {
        const enc = typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8';
        return Buffer.from(chunk, /** @type {BufferEncoding} */ (enc));
    }
    if (ArrayBuffer.isView(chunk)) return Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
    return null;
}

/**
 * @param {Buffer[]} chunks
 * @param {number} from byte offset
 * @returns {Buffer}
 */
function sliceFrom(chunks, from) {
    const out = [];
    let pos = 0;
    for (const c of chunks) {
        const end = pos + c.length;
        if (end > from) out.push(from > pos ? c.subarray(from - pos) : c);
        pos = end;
    }
    return Buffer.concat(out);
}

export class GenLedger {
    /** @param {() => number} [now] */
    constructor(now = Date.now) {
        this.now = now;
        /** @type {Map<string, GenEntry>} */
        this.entries = new Map();
        /** Sum of every entry's buffered bytes. */
        this.buffered = 0;
    }

    /**
     * @param {string} owner user handle (entries are only visible to their owner)
     * @param {string} id
     * @returns {string}
     */
    static key(owner, id) {
        return `${owner}\u0000${id}`;
    }

    /**
     * @param {string} owner
     * @param {string} id
     * @returns {GenEntry}
     */
    start(owner, id) {
        this.prune();
        const t = this.now();
        /** @type {GenEntry} */
        const entry = { state: 'running', bytes: 0, startedAt: t, lastWriteAt: t, endedAt: null, chunks: [], held: 0, truncated: false, status: null, type: null };
        const key = GenLedger.key(owner, id);
        const old = this.entries.get(key);
        if (old) this.drop(old);
        this.entries.set(key, entry);
        return entry;
    }

    /**
     * @param {GenEntry} entry
     * @param {number} n
     */
    wrote(entry, n) {
        if (n <= 0) return;
        entry.bytes += n;
        entry.lastWriteAt = this.now();
    }

    /**
     * Note the response head (first call wins).
     * @param {GenEntry} entry
     * @param {number} status
     * @param {unknown} type
     */
    head(entry, status, type) {
        if (entry.status !== null) return;
        entry.status = status;
        entry.type = typeof type === 'string' ? type : Array.isArray(type) ? String(type[0]) : null;
    }

    /**
     * Count AND keep a written chunk (layer 2a).
     * @param {GenEntry} entry
     * @param {unknown} chunk
     * @param {unknown} [encoding]
     */
    wroteChunk(entry, chunk, encoding) {
        const buf = chunkBuffer(chunk, encoding);
        if (!buf || !buf.length) return;
        this.wrote(entry, buf.length);
        if (entry.truncated) return;
        if (this.buffered + buf.length > MAX_TOTAL_BUFFER_BYTES) this.evictEnded(buf.length);
        if (entry.held + buf.length > MAX_BUFFER_BYTES || this.buffered + buf.length > MAX_TOTAL_BUFFER_BYTES) {
            this.drop(entry);
            return;
        }
        entry.chunks.push(buf);
        entry.held += buf.length;
        this.buffered += buf.length;
    }

    /**
     * What the page missed: the bytes from `from` on, and whether more may come.
     * @param {string} owner
     * @param {string} id
     * @param {number} from bytes the page already has
     * @returns {{ state: 'unknown' } | { state: 'truncated', bytes: number } | { state: 'running'|'done'|'closed', bytes: number, data: Buffer, status: number|null, type: string|null }}
     */
    read(owner, id, from) {
        this.prune();
        const entry = this.entries.get(GenLedger.key(owner, id));
        if (!entry) return { state: 'unknown' };
        if (entry.truncated) return { state: 'truncated', bytes: entry.bytes };
        const start = Math.max(0, Math.min(Math.floor(from) || 0, entry.bytes));
        return { state: entry.state, bytes: entry.bytes, data: sliceFrom(entry.chunks, start), status: entry.status, type: entry.type };
    }

    /**
     * Forget an entry's copy (it stays counted, as `truncated`).
     * @param {GenEntry} entry
     */
    drop(entry) {
        this.buffered -= entry.held;
        entry.chunks = [];
        entry.held = 0;
        entry.truncated = true;
    }

    /**
     * Make room by dropping ended replies' copies, oldest first.
     * @param {number} need
     */
    evictEnded(need) {
        for (const entry of this.entries.values()) {
            if (this.buffered + need <= MAX_TOTAL_BUFFER_BYTES) return;
            if (entry.endedAt !== null && entry.chunks.length) this.drop(entry);
        }
    }

    /** @param {GenEntry} entry */
    ended(entry) {
        if (entry.state !== 'running') return;
        entry.state = 'done';
        entry.endedAt = this.now();
    }

    /** @param {GenEntry} entry */
    closed(entry) {
        if (entry.state !== 'running') return;
        entry.state = 'closed';
        entry.endedAt = this.now();
    }

    /**
     * @param {string} owner
     * @param {string[]} ids
     * @returns {Record<string, (Omit<GenEntry, 'startedAt'|'lastWriteAt'|'endedAt'> & { idleMs: number }) | { state: 'unknown' }>}
     */
    status(owner, ids) {
        this.prune();
        const t = this.now();
        /** @type {Record<string, any>} */
        const out = {};
        for (const id of ids) {
            const entry = this.entries.get(GenLedger.key(owner, id));
            out[id] = entry
                ? { state: entry.state, bytes: entry.bytes, idleMs: t - entry.lastWriteAt }
                : { state: 'unknown' };
        }
        return out;
    }

    prune() {
        const t = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.endedAt !== null && t - entry.endedAt > ENDED_TTL_MS) {
                this.buffered -= entry.held;
                this.entries.delete(key);
            }
        }
        // Oldest first (Map keeps insertion order).
        while (this.entries.size >= MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            const entry = this.entries.get(oldest);
            if (entry) this.buffered -= entry.held;
            this.entries.delete(oldest);
        }
    }
}
