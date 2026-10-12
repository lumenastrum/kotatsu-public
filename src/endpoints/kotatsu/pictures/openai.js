/**
 * The OpenAI key lane (docs/pictures-v0.md §6.1): `POST /v1/images/generations`, or
 * `/v1/images/edits` when the job has a reference picture, with the user's own `api_key_openai`.
 * Read off developers.openai.com on 2026-10-10: the answer is `data[].b64_json`; transparency is
 * `background: "transparent"` with a png or webp `output_format`; a refused prompt answers
 * `error.code: "moderation_blocked"`. No seed and no negative prompt on this endpoint.
 *
 * `buildRequest` and `readPictures` are pure so the tests can pin the wire shape; `drawOpenAI`
 * is the one call the job manager runs.
 */

export const OPENAI_BASE = 'https://api.openai.com/v1';
/** A picture at high quality can take minutes; past this the job fails instead of hanging. */
const TIMEOUT_MS = 300_000;

export class LaneError extends Error {
    /**
     * @param {string} message What the person reads
     * @param {{status?: number, code?: string}} [extra] Provider status and code
     */
    constructor(message, { status, code } = {}) {
        super(message);
        this.name = 'LaneError';
        this.status = status;
        this.code = code;
    }
}

/**
 * @typedef {object} LaneJob   What a key lane needs from `PictureRequest`, validated by the route.
 * @property {string} prompt
 * @property {string} model
 * @property {string} [quality]      openai
 * @property {string} [size]         openai `WxH` | `auto`; gemini `1K` | `2K` | `4K`
 * @property {string} [aspect]       gemini `W:H`
 * @property {boolean} [transparent] sprites
 * @property {{bytes: Buffer, mime: string, ext: string}|null} [reference]
 */

/**
 * The request for one picture.
 * @param {LaneJob} job Job
 * @returns {{path: string, json?: object, form?: Record<string, string>}} `json` for a generation,
 *   `form` (plus the reference as `image[]`) for an edit
 */
export function buildRequest(job) {
    /** @type {Record<string, string>} */
    const fields = {
        model: job.model,
        prompt: job.prompt,
        n: '1',
        output_format: 'png',
    };
    if (job.size) fields.size = job.size;
    if (job.quality) fields.quality = job.quality;
    if (job.transparent) fields.background = 'transparent';
    if (job.reference) return { path: '/images/edits', form: fields };
    return { path: '/images/generations', json: { ...fields, n: 1 } };
}

/**
 * The pictures in an Images API answer.
 * @param {any} body Parsed answer
 * @returns {{bytes: Buffer, ext: string}[]} Pictures, in order
 */
export function readPictures(body) {
    const data = Array.isArray(body?.data) ? body.data : [];
    return data
        .filter((/** @type {any} */ item) => typeof item?.b64_json === 'string' && item.b64_json)
        .map((/** @type {any} */ item) => ({ bytes: Buffer.from(item.b64_json, 'base64'), ext: 'png' }));
}

/**
 * The sentence for a failed answer.
 * @param {number} status HTTP status
 * @param {any} body Parsed answer, when it was JSON
 * @returns {LaneError} The error
 */
export function describeFailure(status, body) {
    const error = body?.error ?? {};
    const code = typeof error.code === 'string' ? error.code : undefined;
    const said = typeof error.message === 'string' ? error.message.trim() : '';
    if (status === 401) return new LaneError('OpenAI did not accept the key. Check it under Connection.', { status, code });
    if (code === 'moderation_blocked') return new LaneError(`OpenAI declined to draw this prompt.${said ? ` (${said})` : ''}`, { status, code });
    if (status === 429) return new LaneError(`OpenAI says slow down or top up: ${said || 'rate or quota limit reached'}`, { status, code });
    return new LaneError(`OpenAI answered ${status}${said ? `: ${said}` : ''}`, { status, code });
}

/**
 * An abort signal that fires on the job's signal or after `ms`.
 * @param {AbortSignal} signal Job signal
 * @param {number} ms Timeout
 * @returns {{signal: AbortSignal, done: () => void}} Combined signal and its cleanup
 */
export function withTimeout(signal, ms) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('timed out')), ms);
    timer.unref?.();
    return {
        signal: controller.signal,
        done: () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
        },
    };
}

/**
 * Draws one picture on OpenAI.
 * @param {object} params Inputs
 * @param {string} params.key `api_key_openai`
 * @param {LaneJob} params.job Job
 * @param {AbortSignal} params.signal Cancels the call
 * @param {typeof fetch} [params.fetchImpl] Fetch (tests)
 * @param {string} [params.base] API base (tests)
 * @param {number} [params.timeoutMs] Timeout (tests)
 * @returns {Promise<{bytes: Buffer, ext: string}[]>} The pictures
 */
export async function drawOpenAI({ key, job, signal, fetchImpl = fetch, base = OPENAI_BASE, timeoutMs = TIMEOUT_MS }) {
    const request = buildRequest(job);
    /** @type {RequestInit} */
    const init = { method: 'POST', headers: { Authorization: `Bearer ${key}` } };
    if (request.form) {
        const form = new FormData();
        for (const [name, value] of Object.entries(request.form)) form.append(name, value);
        const reference = /** @type {NonNullable<LaneJob['reference']>} */ (job.reference);
        form.append('image[]', new Blob([reference.bytes], { type: reference.mime }), `reference.${reference.ext}`);
        init.body = form;
    } else {
        init.headers = { ...init.headers, 'Content-Type': 'application/json' };
        init.body = JSON.stringify(request.json);
    }
    const timed = withTimeout(signal, timeoutMs);
    try {
        const response = await fetchImpl(`${base}${request.path}`, { ...init, signal: timed.signal });
        const text = await response.text();
        let body = null;
        try {
            body = JSON.parse(text);
        } catch {
            // not JSON: the status speaks
        }
        if (!response.ok) throw describeFailure(response.status, body);
        const pictures = readPictures(body);
        if (!pictures.length) throw new LaneError('OpenAI answered without a picture');
        return pictures;
    } catch (error) {
        if (timed.signal.aborted && !signal.aborted) throw new LaneError(`OpenAI did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
        throw error;
    } finally {
        timed.done();
    }
}
