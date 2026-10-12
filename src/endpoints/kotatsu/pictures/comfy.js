import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import WebSocket from 'ws';

/**
 * ComfyUI client (docs/pictures-v0.md §3.1), server-side only: the browser never talks to
 * ComfyUI (CORS, auth, a paired phone whose 127.0.0.1 is not this machine).
 *
 * Message shapes are ComfyUI's own, read from its source (ComfyUI @ 73c9bad4, 2026-09-20):
 * - routes: server.py `/system_stats` :689, `/object_info` :803, `/history/{id}` :1062,
 *   `/queue` :1067 (GET) and :1149 (POST `{delete:[ids]}`), `/prompt` :1075, `/interrupt` :1163
 *   (optional `{prompt_id}` = targeted), `/upload/image` :464, `/view` :516, `/ws` :269.
 * - binary frames: server.py `encode_bytes` :1305 (4-byte big-endian event type, then payload);
 *   `send_image` :1314 (type 1 PREVIEW_IMAGE: 4-byte image type 1 JPEG / 2 PNG, then bytes);
 *   `send_image_with_metadata` :1338 (type 4 PREVIEW_IMAGE_WITH_METADATA: 4-byte metadata length,
 *   metadata JSON with `prompt_id`/`node_id`/`image_type`, then bytes). protocol.py names the types.
 *   Type 4 is sent instead of type 1 only to a socket that opened with the
 *   `{"type":"feature_flags","data":{"supports_preview_metadata":true}}` message
 *   (server.py :302, comfy_execution/progress.py :212, main.py :441), which this client sends.
 * - events go to the socket whose clientId submitted the running prompt (`server.client_id`), so
 *   one socket per server, shared by every job, sees all of Kotatsu's prompts on that server.
 */

/** ComfyUI binary event types (ComfyUI protocol.py). */
export const BINARY_EVENTS = Object.freeze({ PREVIEW_IMAGE: 1, UNENCODED_PREVIEW_IMAGE: 2, TEXT: 3, PREVIEW_IMAGE_WITH_METADATA: 4 });

/** A ComfyUI problem; `status` is what the route answers with, `nodeErrors` ComfyUI's verbatim. */
export class ComfyError extends Error {
    /**
     * @param {string} message Message for the user
     * @param {{status?: number, nodeErrors?: object, type?: string, cause?: unknown}} [details] Extras
     */
    constructor(message, details = {}) {
        super(message, details.cause ? { cause: details.cause } : undefined);
        this.name = 'ComfyError';
        this.status = details.status ?? 502;
        this.nodeErrors = details.nodeErrors;
        this.type = details.type;
    }
}

/**
 * The address a request names, checked and normalized: http(s) only, no credentials in the URL
 * (they go in `auth`), no query or hash, no trailing slash. This string is also the server key
 * of slot choices (contract.js `SERVER_KEY_RULE`).
 * @param {unknown} raw Address from the request
 * @returns {string} e.g. `http://127.0.0.1:8188`
 */
export function normalizeServerUrl(raw) {
    if (typeof raw !== 'string' || !raw.trim()) throw new ComfyError('The ComfyUI address is empty', { status: 400 });
    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new ComfyError(`"${raw}" is not a valid address`, { status: 400 });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ComfyError('The ComfyUI address must start with http:// or https://', { status: 400 });
    }
    if (url.username || url.password) {
        throw new ComfyError('Put ComfyUI credentials in the auth field, not in the address', { status: 400 });
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Basic auth header for `user:password` (same encoding as util.js `getBasicAuthHeader`, which
 * the removed stock extension used for ComfyUI behind a reverse proxy).
 * @param {string} auth `user:password`
 * @returns {string} Header value
 */
export function basicAuthHeader(auth) {
    return `Basic ${Buffer.from(String(auth)).toString('base64')}`;
}

/**
 * Parses a binary WebSocket frame.
 * @param {Buffer} buffer The frame
 * @returns {{event: number, mime: string|null, image: Buffer|null, metadata: any}|null} Null when too short
 */
export function parseBinaryFrame(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
    const event = buffer.readUInt32BE(0);
    if (event === BINARY_EVENTS.PREVIEW_IMAGE) {
        const imageType = buffer.readUInt32BE(4);
        return { event, mime: imageType === 2 ? 'image/png' : 'image/jpeg', image: buffer.subarray(8), metadata: null };
    }
    if (event === BINARY_EVENTS.PREVIEW_IMAGE_WITH_METADATA) {
        const length = buffer.readUInt32BE(4);
        if (8 + length > buffer.length) return null;
        let metadata = null;
        try {
            metadata = JSON.parse(buffer.subarray(8, 8 + length).toString('utf8'));
        } catch {
            return null;
        }
        const mime = metadata?.image_type === 'image/png' ? 'image/png' : 'image/jpeg';
        return { event, mime, image: buffer.subarray(8 + length), metadata };
    }
    return { event, mime: null, image: null, metadata: null };
}

/**
 * The options of a combo input from `/object_info`, in either schema: legacy
 * `[[...options], {...}]` or V3 `["COMBO", {options: [...]}]` (comfy_api/latest/_io.py `Combo`).
 * @param {unknown} spec Input spec
 * @returns {string[]} Options
 */
export function comboOptions(spec) {
    if (!Array.isArray(spec)) return [];
    if (Array.isArray(spec[0])) return spec[0].filter(v => typeof v === 'string');
    if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.filter(v => typeof v === 'string');
    return [];
}

/**
 * @param {any} objectInfo `/object_info` body
 * @param {string} classType Node class
 * @param {string} input Input name
 * @returns {string[]} The input's options, or [] when the node or input is absent
 */
export function nodeOptions(objectInfo, classType, input) {
    const inputs = objectInfo?.[classType]?.input;
    return comboOptions(inputs?.required?.[input] ?? inputs?.optional?.[input]);
}

/**
 * Model lists for slot dropdowns, keyed like the `/check` reply's `models`.
 * @param {any} objectInfo `/object_info` body
 * @returns {{unet: string[], checkpoints: string[], clip: string[], vae: string[], loras: string[], upscalers: string[], removers: string[]}} Lists
 */
export function modelLists(objectInfo) {
    const unique = (/** @type {string[]} */ list) => [...new Set(list)];
    return {
        unet: unique([...nodeOptions(objectInfo, 'UNETLoader', 'unet_name'), ...nodeOptions(objectInfo, 'UnetLoaderGGUF', 'unet_name')]),
        checkpoints: nodeOptions(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name'),
        clip: nodeOptions(objectInfo, 'CLIPLoader', 'clip_name'),
        vae: nodeOptions(objectInfo, 'VAELoader', 'vae_name'),
        loras: nodeOptions(objectInfo, 'LoraLoader', 'lora_name'),
        upscalers: nodeOptions(objectInfo, 'UpscaleModelLoader', 'model_name'),
        removers: nodeOptions(objectInfo, 'LoadBackgroundRemovalModel', 'bg_removal_name'),
    };
}

/**
 * One ComfyUI server. HTTP calls are stateless; the WebSocket is shared, opened while at least
 * one job holds the client (`retain()`), reconnecting with backoff, closed when the last job
 * lets go (`release()`).
 *
 * Events: `event` ({type, data} JSON messages), `preview` (parsed binary preview frames),
 * `open`, `close`.
 */
export class ComfyClient extends EventEmitter {
    /**
     * @param {object} options Options
     * @param {string} options.url Server address (normalized here)
     * @param {string} [options.auth] `user:password` for Basic auth
     * @param {typeof globalThis.fetch} [options.fetch] fetch implementation
     * @param {any} [options.WebSocketImpl] WebSocket class with the `ws` package's API
     * @param {string} [options.clientId] ComfyUI client id (one per server)
     * @param {number} [options.timeoutMs] Per-request timeout
     * @param {number} [options.reconnectMinMs] First reconnect delay
     * @param {number} [options.reconnectMaxMs] Reconnect delay cap
     * @param {{warn?: Function, debug?: Function}} [options.logger] Logger
     */
    constructor({ url, auth = '', fetch: fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, clientId = randomUUID(), timeoutMs = 30_000, reconnectMinMs = 500, reconnectMaxMs = 5_000, logger = console }) {
        super();
        this.base = normalizeServerUrl(url);
        this.auth = auth;
        this.clientId = clientId;
        this.fetchImpl = fetchImpl;
        this.WebSocketImpl = WebSocketImpl;
        this.timeoutMs = timeoutMs;
        this.reconnectMinMs = reconnectMinMs;
        this.reconnectMaxMs = reconnectMaxMs;
        this.logger = logger;
        /** @type {any} */
        this.socket = null;
        this.connected = false;
        this.refs = 0;
        this.reconnectDelay = reconnectMinMs;
        /** @type {NodeJS.Timeout|null} */
        this.reconnectTimer = null;
        /** prompt_id of the prompt ComfyUI is running for this client (from execution_start / executing). */
        this.currentPromptId = null;
        this.setMaxListeners(100);
    }

    /**
     * @param {Record<string, string>} [extra] Extra headers
     * @returns {Record<string, string>} Headers with auth
     */
    headers(extra = {}) {
        return this.auth ? { Authorization: basicAuthHeader(this.auth), ...extra } : { ...extra };
    }

    /**
     * @param {string} route Path under the server address
     * @param {{method?: string, json?: unknown, body?: any, expect?: 'json'|'buffer'|'none', timeoutMs?: number}} [options] Request options
     * @returns {Promise<any>} Parsed reply
     */
    async request(route, { method = 'GET', json, body, expect = 'json', timeoutMs = this.timeoutMs } = {}) {
        const headers = this.headers(json !== undefined ? { 'Content-Type': 'application/json' } : {});
        let response;
        try {
            response = await this.fetchImpl(`${this.base}${route}`, {
                method,
                headers,
                body: json !== undefined ? JSON.stringify(json) : body,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new ComfyError(`ComfyUI is not reachable at ${this.base}`, { status: 502, cause: error });
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch {
                // not JSON
            }
            const comfyError = parsed?.error && typeof parsed.error === 'object' ? parsed.error : null;
            const detail = comfyError?.message
                ? `${comfyError.message}${comfyError.details ? `: ${comfyError.details}` : ''}`
                : (text.slice(0, 200) || response.statusText);
            throw new ComfyError(`ComfyUI answered ${response.status} on ${route.split('?')[0]}: ${detail}`, {
                status: response.status === 401 || response.status === 403 ? 401 : 502,
                nodeErrors: parsed?.node_errors,
                type: comfyError?.type,
            });
        }
        if (expect === 'none') return null;
        if (expect === 'buffer') return Buffer.from(await response.arrayBuffer());
        return response.json();
    }

    /** @returns {Promise<any>} `/system_stats` */
    systemStats() {
        return this.request('/system_stats');
    }

    /** @returns {Promise<any>} `/object_info` */
    objectInfo() {
        return this.request('/object_info', { timeoutMs: Math.max(this.timeoutMs, 60_000) });
    }

    /**
     * A model file's safetensors header metadata (`/view_metadata/<folder>?filename=`). ComfyUI
     * answers 404 when the file has none (measured 2026-10-10), which is null here, not an error.
     * @param {string} folder Model folder (`loras`)
     * @param {string} filename File as ComfyUI lists it
     * @returns {Promise<Record<string, any>|null>} The metadata, or null
     */
    async viewMetadata(folder, filename) {
        try {
            return await this.request(`/view_metadata/${encodeURIComponent(folder)}?filename=${encodeURIComponent(filename)}`);
        } catch (error) {
            if (error instanceof ComfyError && /answered 404/.test(error.message)) return null;
            throw error;
        }
    }

    /** @returns {Promise<{queue_running: any[], queue_pending: any[]}>} `/queue` */
    queue() {
        return this.request('/queue');
    }

    /**
     * @param {string} promptId Prompt id
     * @returns {Promise<Record<string, any>>} `/history/<id>` (empty object until it finished)
     */
    history(promptId) {
        return this.request(`/history/${encodeURIComponent(promptId)}`);
    }

    /**
     * Queues a graph. Validation failures come back as a ComfyError carrying ComfyUI's
     * `node_errors` verbatim (server.py :1139 replies `{error, node_errors}` with 400).
     * @param {object} graph API graph
     * @param {string} [promptId] A client-chosen prompt id (honoured by builds that accept it)
     * @returns {Promise<{prompt_id: string, number: number, node_errors: object}>} The queue entry
     */
    async queuePrompt(graph, promptId) {
        try {
            return await this.request('/prompt', {
                method: 'POST',
                json: { prompt: graph, client_id: this.clientId, ...(promptId ? { prompt_id: promptId } : {}) },
            });
        } catch (error) {
            if (error instanceof ComfyError && error.type) {
                const message = error.message.replace(/^ComfyUI answered \d+ on \/prompt: /, '');
                throw new ComfyError(message, { status: 400, nodeErrors: error.nodeErrors, type: error.type, cause: error });
            }
            throw error;
        }
    }

    /**
     * @param {{filename: string, subfolder?: string, type?: string}} image An output entry
     * @returns {Promise<Buffer>} The file's bytes
     */
    view({ filename, subfolder = '', type = 'output' }) {
        const query = new URLSearchParams({ filename, subfolder, type });
        return this.request(`/view?${query}`, { expect: 'buffer', timeoutMs: Math.max(this.timeoutMs, 60_000) });
    }

    /**
     * Uploads a reference image into ComfyUI's input folder (core `LoadImage` reads it).
     * @param {Buffer} bytes Image bytes
     * @param {string} filename File name
     * @param {{subfolder?: string, overwrite?: boolean, mime?: string}} [options] Upload options
     * @returns {Promise<{name: string, subfolder: string, type: string}>} Where ComfyUI put it
     */
    uploadImage(bytes, filename, { subfolder = 'kotatsu', overwrite = true, mime = 'image/png' } = {}) {
        const form = new FormData();
        form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
        form.append('subfolder', subfolder);
        form.append('overwrite', overwrite ? 'true' : 'false');
        form.append('type', 'input');
        return this.request('/upload/image', { method: 'POST', body: form });
    }

    /**
     * Interrupts a running prompt. With `prompt_id`, current builds interrupt only that prompt
     * (server.py :1171); older builds ignore the body and interrupt whatever runs, so callers
     * only send this when they know their prompt is the running one.
     * @param {string} promptId Prompt id
     * @returns {Promise<null>} Done
     */
    interrupt(promptId) {
        return this.request('/interrupt', { method: 'POST', json: { prompt_id: promptId }, expect: 'none' });
    }

    /**
     * Removes pending prompts from the queue (server.py :1149).
     * @param {string[]} promptIds Prompt ids
     * @returns {Promise<null>} Done
     */
    deleteQueued(promptIds) {
        return this.request('/queue', { method: 'POST', json: { delete: promptIds }, expect: 'none' });
    }

    /** @returns {string} The WebSocket address */
    socketUrl() {
        const url = new URL(`${this.base}/ws`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('clientId', this.clientId);
        return url.toString();
    }

    /** Holds the socket open for one more job. */
    retain() {
        this.refs++;
        if (!this.socket && !this.reconnectTimer) this.connect();
    }

    /** Lets go of the socket for one job; the last one closes it. */
    release() {
        this.refs = Math.max(0, this.refs - 1);
        if (this.refs === 0) this.disconnect();
    }

    /**
     * Resolves once the socket is open, or after `timeoutMs` (jobs then lean on history polling).
     * @param {number} timeoutMs How long to wait
     * @returns {Promise<boolean>} True when open
     */
    waitOpen(timeoutMs) {
        if (this.connected) return Promise.resolve(true);
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.off('open', onOpen);
                resolve(false);
            }, timeoutMs);
            const onOpen = () => {
                clearTimeout(timer);
                resolve(true);
            };
            this.once('open', onOpen);
        });
    }

    /** Opens the socket. */
    connect() {
        this.reconnectTimer = null;
        let socket;
        try {
            socket = new this.WebSocketImpl(this.socketUrl(), { headers: this.headers() });
        } catch (error) {
            this.logger.warn?.(`[Pictures] ComfyUI socket at ${this.base} failed to open: ${error instanceof Error ? error.message : error}`);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        socket.on('open', () => {
            this.connected = true;
            this.reconnectDelay = this.reconnectMinMs;
            // Must be the first message: ComfyUI only negotiates feature flags on it (server.py :302).
            socket.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
            this.emit('open');
        });
        socket.on('message', (/** @type {Buffer|ArrayBuffer|Buffer[]} */ data, /** @type {boolean} */ isBinary) => {
            const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
            if (isBinary) {
                const frame = parseBinaryFrame(buffer);
                if (frame?.image) this.emit('preview', frame);
                return;
            }
            let message;
            try {
                message = JSON.parse(buffer.toString('utf8'));
            } catch {
                return;
            }
            if (!message || typeof message.type !== 'string') return;
            const promptId = message.data?.prompt_id;
            if (message.type === 'execution_start' && promptId) this.currentPromptId = promptId;
            if (message.type === 'executing' && promptId) this.currentPromptId = message.data.node === null ? null : promptId;
            this.emit('event', message);
        });
        socket.on('error', (/** @type {Error} */ error) => {
            this.logger.debug?.(`[Pictures] ComfyUI socket error at ${this.base}: ${error.message}`);
        });
        socket.on('close', () => {
            const wasConnected = this.connected;
            this.connected = false;
            if (this.socket === socket) this.socket = null;
            if (wasConnected) this.emit('close');
            if (this.refs > 0) this.scheduleReconnect();
        });
    }

    /** Schedules the next connection attempt with backoff. */
    scheduleReconnect() {
        if (this.reconnectTimer || this.refs === 0) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
        this.reconnectTimer.unref?.();
    }

    /** Closes the socket and stops reconnecting. */
    disconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        const socket = this.socket;
        this.socket = null;
        this.connected = false;
        if (socket) {
            socket.removeAllListeners('close');
            socket.on('error', () => {});
            try {
                socket.terminate?.() ?? socket.close?.();
            } catch {
                // already closed
            }
        }
    }
}

/**
 * One client per server address and auth: they share a ComfyUI client id, so every Kotatsu job
 * on that server arrives on the same socket.
 * @param {(options: {url: string, auth: string}) => ComfyClient} [factory] Builds a client
 * @returns {{get: (url: string, auth?: string) => ComfyClient, all: () => ComfyClient[], close: () => void}} The pool
 */
export function createClientPool(factory = options => new ComfyClient(options)) {
    /** @type {Map<string, ComfyClient>} */
    const clients = new Map();
    return {
        get(url, auth = '') {
            const key = `${normalizeServerUrl(url)}\u0000${auth}`;
            let client = clients.get(key);
            if (!client) {
                client = factory({ url, auth });
                clients.set(key, client);
            }
            return client;
        },
        all: () => [...clients.values()],
        close() {
            for (const client of clients.values()) {
                client.refs = 0;
                client.disconnect();
            }
            clients.clear();
        },
    };
}

/**
 * The `/check` reply (§13.2) plus the class types for `missing[]`.
 * @param {ComfyClient} client Client
 * @returns {Promise<{reply: object, classTypes: Set<string>, models: ReturnType<typeof modelLists>}>} Reply and facts kept for later
 */
export async function describeServer(client) {
    const [stats, info, queue] = await Promise.all([
        client.systemStats(),
        client.objectInfo(),
        client.queue().catch(() => null),
    ]);
    const models = modelLists(info);
    const classTypes = new Set(Object.keys(info ?? {}));
    return {
        reply: {
            ok: true,
            version: String(stats?.system?.comfyui_version ?? ''),
            device: String(stats?.devices?.[0]?.name ?? ''),
            queue: { running: queue?.queue_running?.length ?? 0, pending: queue?.queue_pending?.length ?? 0 },
            nodeTypes: classTypes.size,
            models,
            samplers: nodeOptions(info, 'KSampler', 'sampler_name'),
            schedulers: nodeOptions(info, 'KSampler', 'scheduler'),
        },
        classTypes,
        models,
    };
}
