/**
 * Pictures v0, slice B — the browser's door to the picture server (docs/pictures-v0.md §3.2, §13.2).
 *
 * The server (slice A) owns every lane; the browser never talks to ComfyUI or a key lane itself.
 * This module is the only place that knows the HTTP surface: the sheet, the pending row and the
 * tile menu call these functions and never build a URL.
 *
 * Progress arrives as server-sent events. `EventSource` reconnects by itself after a dropped
 * stream; two errors in a row mean the stream is not coming back (a proxy that buffers, a server
 * that refuses), and the watcher falls back to polling the job list.
 */

import { getRequestHeaders } from '../../script.js';
import { API_BASE, JOB_EVENTS } from './contract.js';

/** Poll cadence for the fallback, ms. */
const POLL_MS = 1000;

/** Errors in a row before the event stream is given up for polling. */
const STREAM_ERRORS_BEFORE_POLLING = 2;

/** How long a recipe list stays fresh for the tile menu's variant lookups, ms. */
const RECIPES_TTL_MS = 30_000;

/** @type {{at: number, recipes: import('./contract.js').Recipe[]}|null} */
let recipesCache = null;

/**
 * @param {Response} response
 * @returns {Promise<string>} The server's message, or the status line.
 */
async function failureText(response) {
    let text = '';
    try {
        const body = await response.clone().json();
        // The picture server answers `{ error: { message, code?, slots? } }` (slice A, hand-off §1);
        // older/other routes use `{ message }` or `{ error: '…' }`.
        text = typeof body?.error?.message === 'string' ? body.error.message
            : typeof body?.message === 'string' ? body.message
                : typeof body?.error === 'string' ? body.error : '';
    } catch {
        try {
            text = (await response.text()).trim();
        } catch {
            text = '';
        }
    }
    return text || `${response.status} ${response.statusText}`.trim();
}

/**
 * @param {string} path Under `API_BASE`, leading slash included.
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
function call(path, init = {}) {
    return fetch(`${API_BASE}${path}`, {
        ...init,
        headers: { ...getRequestHeaders(), ...(init.headers ?? {}) },
        cache: 'no-cache',
    });
}

/**
 * Queues a picture.
 * @param {import('./contract.js').PictureRequest} request
 * @returns {Promise<{jobId: string, seed: number|null}>} `seed` null on a key lane (no seed there; `Number(null)` would be a fake 0)
 */
export async function startPicture(request) {
    const response = await call('/jobs', { method: 'POST', body: JSON.stringify(request) });
    if (!response.ok) {
        let code = '';
        try {
            code = String((await response.clone().json())?.error?.code ?? '');
        } catch {
            // not JSON
        }
        throw Object.assign(new Error(await failureText(response)), { code });
    }
    const body = await response.json();
    if (!body || typeof body.jobId !== 'string' || !body.jobId) throw new Error('The picture server did not return a job.');
    return { jobId: body.jobId, seed: typeof body.seed === 'number' && Number.isFinite(body.seed) ? body.seed : null };
}

/**
 * Asks the lane to stop a job. The job's own stream then ends with `cancelled`.
 * @param {string} jobId
 * @returns {Promise<void>}
 */
export async function cancelJob(jobId) {
    const response = await call(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    if (!response.ok && response.status !== 404) throw new Error(await failureText(response));
}

/**
 * The recipes on this install, with `missing[]` against the last checked server.
 * @param {{fresh?: boolean}} [options] `fresh` skips the short cache.
 * @returns {Promise<import('./contract.js').Recipe[]>}
 */
export async function listRecipes({ fresh = false } = {}) {
    if (!fresh && recipesCache && Date.now() - recipesCache.at < RECIPES_TTL_MS) return recipesCache.recipes;
    const response = await call('/recipes', { method: 'GET' });
    if (!response.ok) throw new Error(await failureText(response));
    const body = await response.json();
    const recipes = Array.isArray(body?.recipes) ? body.recipes.filter(r => r && typeof r.id === 'string') : [];
    recipesCache = { at: Date.now(), recipes };
    return recipes;
}

/**
 * The settings card's Check: version, queue, models, node count.
 * @param {{url: string, auth?: string}} server
 * @returns {Promise<any>} The server's reply (`ok:false` + `message` on failure).
 */
export async function checkServer(server) {
    const response = await call('/check', { method: 'POST', body: JSON.stringify(server) });
    if (!response.ok) return { ok: false, message: await failureText(response) };
    return response.json();
}

/** @type {{at: number, key: string, answer: {ok: boolean, loras?: import('./picture-model.js').LoraInfo[], message?: string}}|null} */
let lorasCache = null;
const LORAS_TTL_MS = 60_000;

/**
 * The LoRAs on a ComfyUI, with base model and trigger words (`POST /loras`). Cached for a minute
 * per server, so opening the sheet twice does not re-read the list.
 * @param {{url?: string, auth?: string}} [server] Absent = the saved server.
 * @param {{fresh?: boolean}} [options]
 * @returns {Promise<{ok: boolean, loras?: import('./picture-model.js').LoraInfo[], message?: string}>}
 */
export async function listLoras(server = {}, { fresh = false } = {}) {
    const key = JSON.stringify([server.url ?? '', server.auth ?? '']);
    if (!fresh && lorasCache && lorasCache.key === key && Date.now() - lorasCache.at < LORAS_TTL_MS) return lorasCache.answer;
    const response = await call('/loras', { method: 'POST', body: JSON.stringify(server) });
    if (!response.ok) return { ok: false, message: await failureText(response) };
    const answer = await response.json();
    if (answer?.ok) lorasCache = { at: Date.now(), key, answer };
    return answer;
}

/** @type {{at: number, key: string, answer: any}|null} */
let modelsCache = null;

/**
 * The model files on a ComfyUI with Kotatsu's suggestion for each, and the families (`POST /models`, §14).
 * Cached for a minute per server.
 * @param {{url?: string, auth?: string}} [server] Absent = the saved server.
 * @param {{fresh?: boolean}} [options]
 * @returns {Promise<{ok: boolean, families?: Record<string, import('./picture-model.js').FamilyInfo>, models?: import('./picture-model.js').ModelInfo[], setup?: Record<string, import('./picture-model.js').FileNeed[]>, extras?: import('./picture-model.js').FileNeed[], install?: Record<string, string>, message?: string}>}
 */
export async function listModels(server = {}, { fresh = false } = {}) {
    const key = JSON.stringify([server.url ?? '', server.auth ?? '']);
    if (!fresh && modelsCache && modelsCache.key === key && Date.now() - modelsCache.at < LORAS_TTL_MS) return modelsCache.answer;
    const response = await call('/models', { method: 'POST', body: JSON.stringify(server) });
    if (!response.ok) return { ok: false, message: await failureText(response) };
    const answer = await response.json();
    if (answer?.ok) modelsCache = { at: Date.now(), key, answer };
    return answer;
}

/**
 * @typedef {object} JobHandlers
 * @property {(data: {position: number}) => void} [queued]
 * @property {(data: {value: number, max: number, node?: string, nodeTitle?: string}) => void} [progress]
 * @property {(data: {jpegBase64: string, mime?: string}) => void} [preview]
 * @property {(data: {images: {url: string, width?: number, height?: number}[], seed: number, graphSha?: string, lane?: string, recipe?: string}) => void} [done]
 * @property {(data: {message: string, nodeErrors?: any}) => void} [error]
 * @property {(data: object) => void} [cancelled]
 */

/** @type {Set<string>} Events after which a job is over. */
const TERMINAL = new Set([JOB_EVENTS.DONE, JOB_EVENTS.ERROR, JOB_EVENTS.CANCELLED]);

/**
 * Follows one job until it ends. Returns a stop function (idempotent) that detaches without
 * cancelling the job.
 * @param {string} jobId
 * @param {JobHandlers} handlers Keyed by `JOB_EVENTS` values.
 * @returns {() => void}
 */
export function watchJob(jobId, handlers) {
    let stopped = false;
    /** @type {EventSource|null} */
    let source = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let pollTimer = null;
    let streamErrors = 0;
    let lastPolled = '';

    const stop = () => {
        stopped = true;
        source?.close();
        source = null;
        if (pollTimer !== null) clearTimeout(pollTimer);
        pollTimer = null;
    };

    /**
     * @param {string} name A `JOB_EVENTS` value.
     * @param {any} data
     */
    const deliver = (name, data) => {
        if (stopped) return;
        if (TERMINAL.has(name)) stop();
        const handler = /** @type {Record<string, ((data: any) => void)|undefined>} */ (handlers)[name];
        try {
            handler?.(data ?? {});
        } catch (error) {
            console.error(`[Pictures] the ${name} handler failed`, error);
        }
    };

    const poll = async () => {
        pollTimer = null;
        if (stopped) return;
        try {
            const response = await call('/jobs', { method: 'GET' });
            if (!response.ok) throw new Error(await failureText(response));
            const body = await response.json();
            const job = (Array.isArray(body?.jobs) ? body.jobs : []).find((/** @type {any} */ j) => j?.id === jobId);
            if (!job) {
                deliver(JOB_EVENTS.ERROR, { message: 'The picture server lost track of this picture.' });
                return;
            }
            const state = String(job.state ?? '');
            if (state === JOB_EVENTS.DONE) {
                // The job list carries no result. A fresh stream for a finished job is the only
                // other place the images are named; if it cannot say, the error says where they are.
                resubscribeForResult();
                return;
            }
            if (state === JOB_EVENTS.ERROR || state === JOB_EVENTS.CANCELLED) {
                deliver(state, state === JOB_EVENTS.ERROR ? { message: String(job.message ?? 'The picture could not be drawn.') } : {});
                return;
            }
            const progress = job.progress && typeof job.progress === 'object' ? job.progress : null;
            const signature = `${state}|${progress?.value ?? ''}|${progress?.max ?? ''}|${job.position ?? ''}`;
            if (signature !== lastPolled) {
                lastPolled = signature;
                if (state === JOB_EVENTS.QUEUED) deliver(JOB_EVENTS.QUEUED, { position: Number(job.position ?? 0) });
                else if (progress) deliver(JOB_EVENTS.PROGRESS, progress);
            }
        } catch (error) {
            console.warn('[Pictures] job poll failed; trying again', error);
        }
        if (!stopped) pollTimer = setTimeout(poll, POLL_MS);
    };

    const resubscribeForResult = () => {
        if (stopped) return;
        let settled = false;
        const replay = new EventSource(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/events`);
        const finish = (/** @type {string} */ name, /** @type {any} */ data) => {
            if (settled) return;
            settled = true;
            replay.close();
            deliver(name, data);
        };
        for (const name of TERMINAL) {
            replay.addEventListener(name, event => {
                if (isServerMessage(event)) finish(name, parseData(event.data));
            });
        }
        replay.addEventListener('error', event => !isServerMessage(event) && finish(JOB_EVENTS.ERROR, {
            message: 'The picture finished, but its details could not be read back. It is saved in the gallery.',
        }));
    };

    const startPolling = () => {
        source?.close();
        source = null;
        if (!stopped && pollTimer === null) pollTimer = setTimeout(poll, 0);
    };

    if (typeof EventSource !== 'function') {
        startPolling();
        return stop;
    }

    source = new EventSource(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/events`);
    for (const name of Object.values(JOB_EVENTS)) {
        source.addEventListener(name, event => {
            // `error` is both a job event the server sends and EventSource's own connection
            // signal. Only a message carries data; the bare one is handled below.
            if (!isServerMessage(event)) return;
            streamErrors = 0;
            deliver(name, parseData(event.data));
        });
    }
    source.addEventListener('error', event => {
        if (stopped || isServerMessage(event)) return;
        streamErrors += 1;
        if (streamErrors >= STREAM_ERRORS_BEFORE_POLLING) {
            console.warn(`[Pictures] the event stream for ${jobId} dropped twice; polling instead.`);
            startPolling();
        }
    });
    return stop;
}

/**
 * @param {Event} event
 * @returns {event is MessageEvent} Whether the server sent it (as opposed to EventSource's own
 * connection `error`, which carries no data).
 */
function isServerMessage(event) {
    return typeof (/** @type {any} */ (event)).data === 'string';
}

/**
 * @param {unknown} raw An SSE `data:` payload.
 * @returns {any}
 */
function parseData(raw) {
    if (typeof raw !== 'string' || raw === '') return {};
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}
