/**
 * Generation watchdog (issue #28, layer 1).
 *
 * The bug: on a phone, the screen locks mid-reply, the radio sleeps, and the connection goes
 * half-open. The server finishes the reply and writes it into nothing; the page's stream
 * loop (script.js StreamingProcessor.generate) waits forever with no timeout, so the send
 * button is stuck and the reply is never saved (only the page saves chats).
 *
 * What this does: tags every generate request with an id (X-Kotatsu-Gen-Id), counts the
 * bytes the page receives, and when a request goes quiet (or the page wakes up) asks the
 * server how far it got. If the server proves the connection is dead (gen-watch-rules.js),
 * it does what the Stop button does: the text that arrived is kept and saved, the button
 * resets.
 *
 * Layer 2a: before giving up, it asks the server for the bytes it missed
 * (`/api/kotatsu/gen-watch/replay`) and keeps feeding them into the SAME response body the
 * stream parser is reading, then follows the rest if the reply is still running. The parser
 * never knows the connection changed. That covers both ways a phone loses the stream: a
 * connection that just goes quiet (the watchdog notices) and one the browser errors out on
 * wake (iOS does this: the old stream loop then reset the button and saved nothing). Only
 * when the server has nothing to give back (restarted, too big to keep) does layer 1 run.
 *
 * A third way, seen on Andres's iPhone (the flight recorder, KOTATSU_GENWATCH_LOG): the
 * fetch itself fails, before any response head arrives (Gemini thinks for ~30 s and the
 * server sends nothing until then; Wi-Fi off 1 s in → "Load failed"). Then the whole response
 * is rebuilt from the server's copy: same status, same Content-Type, every byte from 0.
 *
 * Kotatsu → core only: wraps window.fetch for the generate routes, imports script.js.
 */

import { getRequestHeaders, stopGeneration, streamingProcessor } from '../../script.js';
import { judge, worthChecking } from './gen-watch-rules.js';

const GEN_ROUTE = /\/api\/(?:backends\/(?:chat-completions|text-completions|kobold)|novelai)\/generate(?:\?|$)/;
const TICK_MS = 5_000;
/** While replaying a reply that is still running, ask again this often. */
const FOLLOW_MS = 1_000;
/** How long a visible page keeps retrying a replay it can't reach (radio still waking up). */
const REPLAY_RETRY_BUDGET_MS = 30_000;

/**
 * @typedef {object} Tracked
 * @property {number} startedAt
 * @property {number} lastByteAt
 * @property {number} bytes
 * @property {AbortController} controller
 * @property {(() => void) | null} [recover] switch the body over to the replay (set once the body is wrapped)
 */

/**
 * Breadcrumbs for real-device debugging: sent to the server, which only writes them down when
 * started with KOTATSU_GENWATCH_LOG (see the server's gen-watch/index.js). Rare events only.
 * @type {object[]}
 */
const crumbs = [];
let flushing = false;

/**
 * @param {string} ev
 * @param {object} [data]
 */
function crumb(ev, data = {}) {
    crumbs.push({ t: Date.now(), ev, vis: document.visibilityState, ...data });
    if (crumbs.length > 100) crumbs.splice(0, crumbs.length - 100);
    setTimeout(() => void flushCrumbs(), 250);
}

async function flushCrumbs() {
    if (flushing || !crumbs.length) return;
    flushing = true;
    const batch = crumbs.splice(0, crumbs.length);
    try {
        const res = await originalFetch('/api/kotatsu/gen-watch/log', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ events: batch }),
        });
        if (!res.ok) throw new Error(String(res.status));
    } catch {
        crumbs.unshift(...batch); // offline: keep them for the next try
        if (crumbs.length > 100) crumbs.splice(0, crumbs.length - 100);
    } finally {
        flushing = false;
    }
}

/**
 * Is the chat's streaming reply in flight? Asked when it matters, not at fetch time: on a
 * send or swipe core starts the fetch before it has a streamingProcessor (seen on iOS).
 * @returns {boolean}
 */
function chatStreaming() {
    return Boolean(streamingProcessor && !streamingProcessor.isFinished && !streamingProcessor.isStopped);
}

/** @type {Map<string, Tracked>} */
const tracked = new Map();
let timer = null;
let checking = false;
let installed = false;

/** @returns {string} 32 hex chars; getRandomValues works over plain http (randomUUID doesn't). */
function newGenId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function ensureTimer() {
    if (tracked.size && !timer) timer = setInterval(() => void tick(), TICK_MS);
    if (!tracked.size && timer) {
        clearInterval(timer);
        timer = null;
    }
}

/** @param {string} id */
function untrack(id) {
    tracked.delete(id);
    ensureTimer();
}

/**
 * @param {string} id
 * @param {Tracked} rec
 */
function giveUp(id, rec) {
    untrack(id);
    crumb('dead', { id, bytes: rec.bytes, canRecover: Boolean(rec.recover) });
    if (rec.recover) {
        console.warn(`[Kotatsu gen-watch] ${id}: the connection is dead (server says so); fetching the rest from the server.`);
        rec.recover();
        return;
    }
    fallBack(id, rec);
}

/**
 * Layer 1's ending: what the Stop button does.
 * @param {string} id
 * @param {Tracked} rec
 */
function fallBack(id, rec) {
    crumb('fallback', { id, bytes: rec.bytes, main: chatStreaming() });
    console.warn(`[Kotatsu gen-watch] ${id}: the connection is dead and the server can't give the reply back; stopping like the Stop button would.`);
    if (chatStreaming()) {
        stopGeneration();
        toastr.warning('The connection dropped (screen off?). Kept what reached this page. Swipe to try again.', 'Reply cut off');
    }
    rec.controller.abort(new DOMException('Kotatsu gen-watch: connection lost', 'AbortError'));
}

async function tick() {
    if (checking || !tracked.size || document.visibilityState === 'hidden') return;
    const now = Date.now();
    const ids = [...tracked].filter(([, rec]) => worthChecking(rec, now)).map(([id]) => id);
    if (!ids.length) return;
    checking = true;
    try {
        const res = await originalFetch(`/api/kotatsu/gen-watch/status?ids=${ids.join(',')}`, {
            headers: getRequestHeaders({ omitContentType: true }),
            cache: 'no-store',
        });
        if (!res.ok) return;
        /** @type {Record<string, any>} */
        const status = await res.json();
        const at = Date.now();
        crumb('status', { ids: ids.map(i => [i.slice(0, 6), tracked.get(i)?.bytes]), status });
        for (const id of ids) {
            const rec = tracked.get(id);
            if (rec && judge(rec, status[id], at) === 'dead') giveUp(id, rec);
        }
    } catch (error) {
        crumb('status-failed', { msg: String(error?.message ?? error) });
        // The status check itself failed (server down, still offline): try again next tick.
    } finally {
        checking = false;
    }
}

/** @type {typeof fetch} */
let originalFetch = globalThis.fetch.bind(globalThis);

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const t = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(undefined);
        }, ms);
        function onAbort() {
            clearTimeout(t);
            reject(signal.reason);
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** Resolves once the page is visible (a locked phone can't reach the server anyway). */
function whenVisible() {
    if (document.visibilityState !== 'hidden') return Promise.resolve();
    return new Promise(resolve => {
        const on = () => {
            if (document.visibilityState === 'hidden') return;
            document.removeEventListener('visibilitychange', on);
            resolve(undefined);
        };
        document.addEventListener('visibilitychange', on);
    });
}

/**
 * One replay step: the bytes after `from`, and whether more may come.
 * @param {string} id
 * @param {number} from
 * @param {AbortSignal} signal
 * @returns {Promise<{ data: Uint8Array, more: boolean, state: string, status: number|null, type: string|null } | null>} null = the server can't give it back
 */
async function replayStep(id, from, signal) {
    let spent = 0;
    for (;;) {
        await whenVisible();
        const t0 = Date.now();
        try {
            const res = await originalFetch(`/api/kotatsu/gen-watch/replay?id=${id}&from=${from}`, {
                headers: getRequestHeaders({ omitContentType: true }),
                cache: 'no-store',
                signal,
            });
            crumb('replay', { id: id.slice(0, 6), from, status: res.status, state: res.headers.get('X-Kotatsu-Gen-State') });
            if (res.status === 404 || res.status === 410 || res.status === 400) return null;
            if (!res.ok) throw new Error(`replay ${res.status}`);
            const state = res.headers.get('X-Kotatsu-Gen-State') ?? 'done';
            const data = new Uint8Array(await res.arrayBuffer());
            const status = Number(res.headers.get('X-Kotatsu-Gen-Status')) || null;
            return { data, more: state === 'running', state, status, type: res.headers.get('X-Kotatsu-Gen-Type') };
        } catch (error) {
            crumb('replay-failed', { id: id.slice(0, 6), from, msg: String(error?.message ?? error), aborted: signal.aborted, spent });
            if (signal.aborted) throw error;
            // Offline for a moment longer (radio waking up): retry, within a budget.
            spent += Date.now() - t0 + FOLLOW_MS;
            if (spent > REPLAY_RETRY_BUDGET_MS) return null;
            await sleep(FOLLOW_MS, signal);
        }
    }
}

/**
 * Wrap the response body: count what arrives (layer 1), and if the connection dies, keep the
 * same body going with the bytes from the server's copy (layer 2a).
 * @param {Response} res
 * @param {string} id
 * @param {Tracked} rec
 * @returns {Response}
 */
function countBody(res, id, rec) {
    if (!res.body) {
        untrack(id);
        return res;
    }
    return new Response(healingBody(res.body.getReader(), id, rec), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * The response for a fetch that failed before its head arrived, rebuilt from the server's
 * copy. Waits (visible-only, see replayStep) until the server has written the head.
 * @param {string} id
 * @param {Tracked} rec
 * @returns {Promise<Response | null>} null = the server can't give it back
 */
async function rebuildResponse(id, rec) {
    const signal = rec.controller.signal;
    for (;;) {
        const got = await replayStep(id, 0, signal);
        if (!got) return null;
        if (got.status !== null) {
            crumb('rebuilt', { id: id.slice(0, 6), status: got.status, type: got.type, first: got.data.byteLength, more: got.more });
            console.warn(`[Kotatsu gen-watch] ${id}: the request failed before its response arrived; rebuilt it from the server's copy.`);
            const headers = new Headers();
            if (got.type) headers.set('Content-Type', got.type);
            return new Response(healingBody(null, id, rec, got), { status: got.status, headers });
        }
        if (!got.more) return null; // ended without ever writing: nothing to rebuild
        await sleep(FOLLOW_MS, signal); // still thinking: the head isn't written yet
    }
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array> | null} reader the live body, or null to
 *   start in replay (a rebuilt response)
 * @param {string} id
 * @param {Tracked} rec
 * @param {{ data: Uint8Array, more: boolean, state: string }} [first] replay already fetched
 * @returns {ReadableStream<Uint8Array>}
 */
function healingBody(reader, id, rec, first) {
    const signal = rec.controller.signal;
    /** @type {'live' | 'replay'} */
    let mode = reader ? 'live' : 'replay';
    let recovered = !reader;
    let following = false;
    let pending = first ?? null;

    rec.recover = () => {
        if (mode === 'replay') return;
        mode = 'replay';
        untrack(id);
        // Unblocks a pull stuck on the dead connection (its read resolves as done).
        reader?.cancel(new DOMException('Kotatsu gen-watch: switching to replay', 'AbortError')).catch(() => {});
    };

    /**
     * @param {ReadableStreamDefaultController<Uint8Array>} controller
     * @param {unknown} error
     */
    function failWith(controller, error) {
        untrack(id);
        fallBack(id, rec);
        controller.error(error);
    }

    const body = new ReadableStream({
        async pull(controller) {
            for (;;) {
                if (mode === 'live' && reader) {
                    let step;
                    try {
                        step = await reader.read();
                    } catch (error) {
                        crumb('read-error', { id: id.slice(0, 6), bytes: rec.bytes, name: error?.name, msg: String(error?.message ?? error), aborted: signal.aborted });
                        // The Stop button (or core) aborted: not ours to save.
                        if (signal.aborted) {
                            untrack(id);
                            controller.error(error);
                            return;
                        }
                        // The browser gave up on the connection (iOS on wake): ask the server.
                        console.warn(`[Kotatsu gen-watch] ${id}: the stream errored (${error?.message ?? error}); fetching the rest from the server.`);
                        rec.recover?.();
                        continue;
                    }
                    if (/** @type {string} */ (mode) === 'replay') continue; // our own cancel (rec.recover flips mode across the await)
                    if (step.done) {
                        crumb('read-done', { id: id.slice(0, 6), bytes: rec.bytes });
                        untrack(id);
                        controller.close();
                        return;
                    }
                    rec.bytes += step.value.byteLength;
                    rec.lastByteAt = Date.now();
                    controller.enqueue(step.value);
                    return;
                }

                // Replay: the server's copy, from exactly where this page stopped. Following a
                // reply that is still running: one ask per FOLLOW_MS, not one per chunk.
                let got = pending;
                pending = null;
                try {
                    if (!got) {
                        if (following) await sleep(FOLLOW_MS, signal);
                        got = await replayStep(id, rec.bytes, signal);
                    }
                    following = got?.more ?? false;
                } catch (error) {
                    controller.error(error); // aborted (Stop) while replaying
                    return;
                }
                if (!got) {
                    failWith(controller, new DOMException('Kotatsu gen-watch: connection lost', 'AbortError'));
                    return;
                }
                if (got.data.byteLength) {
                    rec.bytes += got.data.byteLength;
                    rec.lastByteAt = Date.now();
                    if (!recovered) {
                        recovered = true;
                        console.info(`[Kotatsu gen-watch] ${id}: caught up from the server (${got.data.byteLength} bytes).`);
                    }
                    controller.enqueue(got.data);
                    if (!got.more) {
                        endReplay(controller, got.state);
                    }
                    return;
                }
                if (!got.more) {
                    endReplay(controller, got.state);
                    return;
                }
            }
        },
        cancel(reason) {
            crumb('body-cancel', { id: id.slice(0, 6), bytes: rec.bytes, reason: String(reason?.message ?? reason) });
            untrack(id);
            rec.recover = null;
            mode = 'live';
            return reader?.cancel(reason);
        },
    });

    /**
     * @param {ReadableStreamDefaultController<Uint8Array>} controller
     * @param {string} state
     */
    function endReplay(controller, state) {
        crumb('replay-end', { id: id.slice(0, 6), state, bytes: rec.bytes, recovered });
        rec.recover = null;
        if (state === 'closed' && chatStreaming()) {
            // The server cancelled when the connection closed: this is all of it there is.
            toastr.warning('The connection dropped (screen off?). Kept everything the server wrote. Swipe to try again.', 'Reply cut off');
        } else if (recovered && chatStreaming()) {
            toastr.info('The connection dropped, but the reply was saved on the server.', 'Reply recovered');
        }
        controller.close();
    }

    return body;
}

/** @type {typeof fetch} */
async function watchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (url === null || method !== 'POST' || !GEN_ROUTE.test(url)) return originalFetch(input, init);

    const id = newGenId();
    const headers = new Headers(init?.headers);
    headers.set('X-Kotatsu-Gen-Id', id);

    const controller = new AbortController();
    const outer = init?.signal;
    if (outer) {
        if (outer.aborted) controller.abort(outer.reason);
        else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }

    const now = Date.now();
    /** @type {Tracked} */
    const rec = {
        startedAt: now,
        lastByteAt: now,
        bytes: 0,
        controller,
    };
    tracked.set(id, rec);
    ensureTimer();
    crumb('gen-start', { id: id.slice(0, 6), main: chatStreaming() });

    try {
        const res = await originalFetch(input, { ...init, headers, signal: controller.signal });
        rec.lastByteAt = Date.now();
        return countBody(res, id, rec);
    } catch (error) {
        crumb('fetch-error', { id: id.slice(0, 6), name: error?.name, msg: String(error?.message ?? error), aborted: controller.signal.aborted });
        untrack(id);
        if (controller.signal.aborted) throw error; // Stop, or core's own abort
        // The request died before any response arrived. The server may still be writing it:
        // keep this fetch pending (Stop still works) and rebuild it from the server's copy.
        const rebuilt = await rebuildResponse(id, rec); // rejects only on Stop
        if (rebuilt) return rebuilt;
        crumb('rebuild-failed', { id: id.slice(0, 6) });
        throw error;
    }
}

/** @param {Event} [event] */
function onWake(event) {
    crumb(`wake:${event?.type ?? '?'}`, { tracked: tracked.size, persisted: /** @type {any} */ (event)?.persisted });
    void flushCrumbs();
    if (document.visibilityState !== 'hidden') void tick();
}

/** Idempotent. Called once from the shell entry. */
export function installGenWatch() {
    if (installed) return;
    installed = true;
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = watchedFetch;
    document.addEventListener('visibilitychange', onWake);
    document.addEventListener('resume', onWake);
    window.addEventListener('pageshow', onWake);
    window.addEventListener('online', onWake);
    document.addEventListener('freeze', () => crumb('freeze', { tracked: tracked.size }));
    window.addEventListener('offline', () => crumb('offline', { tracked: tracked.size }));
    crumb('installed', { since: Math.round(performance.now()), ua: navigator.userAgent.slice(0, 80) });
}
