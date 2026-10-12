import { LaneError, withTimeout } from './openai.js';

/**
 * The Gemini key lane (docs/pictures-v0.md §6.2), with the user's own `api_key_makersuite`.
 *
 * First choice is the Interactions API, `POST /v1beta/interactions`. Measured live 2026-10-10 on
 * `gemini-nano-banana-2.1`: `response_format: {type: 'image', aspect_ratio, image_size}` (image_size
 * in uppercase K); `mime_type: 'image/png'` is refused ("Supported values: 'image/jpeg'"), so it is
 * left out; the picture comes back as `steps[type=model_output].content[type=image].data` (base64
 * JPEG), after a `thought` step whose signature runs to megabytes. No top-level `output_image` in the
 * raw answer (that is an SDK convenience).
 *
 * The fallback is `models/<model>:generateContent` with `generationConfig.responseModalities` and
 * `imageConfig: {aspectRatio, imageSize}` (the shape core's chat-completions.js already sends),
 * answering `candidates[0].content.parts[].inlineData`. It runs when Interactions is not there for
 * the key (404/405/501).
 *
 * No seed, no negative prompt, no transparent background. Every picture carries SynthID.
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 300_000;
const FALLBACK_STATUSES = new Set([404, 405, 501]);
const IMAGE_FINISH = Object.freeze({
    IMAGE_SAFETY: 'Gemini declined to draw this prompt (image safety).',
    IMAGE_PROHIBITED_CONTENT: 'Gemini declined to draw this prompt (prohibited content).',
    IMAGE_RECITATION: 'Gemini declined to draw this prompt (too close to an existing image).',
    IMAGE_OTHER: 'Gemini could not draw this prompt.',
    NO_IMAGE: 'Gemini answered without a picture.',
    SAFETY: 'Gemini declined this prompt (safety).',
    PROHIBITED_CONTENT: 'Gemini declined this prompt (prohibited content).',
});

/** @typedef {import('./openai.js').LaneJob} LaneJob */

/**
 * @param {string} mime Mime type
 * @returns {string} File extension
 */
function extensionOf(mime) {
    if (/png/i.test(mime)) return 'png';
    if (/webp/i.test(mime)) return 'webp';
    return 'jpg';
}

/**
 * The Interactions request for one picture.
 * @param {LaneJob} job Job
 * @returns {object} Body
 */
export function buildInteraction(job) {
    /** @type {any[]} */
    const input = [{ type: 'text', text: job.prompt }];
    if (job.reference) input.push({ type: 'image', mime_type: job.reference.mime, data: job.reference.bytes.toString('base64') });
    /** @type {Record<string, string>} */
    const format = { type: 'image' };
    if (job.aspect) format.aspect_ratio = job.aspect;
    if (job.size) format.image_size = job.size;
    return { model: job.model, input, response_format: format };
}

/**
 * The generateContent request for one picture.
 * @param {LaneJob} job Job
 * @returns {object} Body
 */
export function buildGenerateContent(job) {
    /** @type {any[]} */
    const parts = [{ text: job.prompt }];
    if (job.reference) parts.push({ inlineData: { mimeType: job.reference.mime, data: job.reference.bytes.toString('base64') } });
    /** @type {Record<string, string>} */
    const imageConfig = {};
    if (job.aspect) imageConfig.aspectRatio = job.aspect;
    if (job.size) imageConfig.imageSize = job.size;
    return {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
    };
}

/**
 * Pictures (and any words) in an Interactions answer.
 * @param {any} body Parsed answer
 * @returns {{pictures: {bytes: Buffer, ext: string}[], said: string}} Pictures in order, and text the model wrote
 */
export function readInteraction(body) {
    const steps = Array.isArray(body?.steps) ? body.steps : [];
    const blocks = steps.filter((/** @type {any} */ step) => step?.type === 'model_output')
        .flatMap((/** @type {any} */ step) => (Array.isArray(step.content) ? step.content : []));
    const pictures = blocks.filter((/** @type {any} */ block) => block?.type === 'image' && typeof block.data === 'string' && block.data)
        .map((/** @type {any} */ block) => ({ bytes: Buffer.from(block.data, 'base64'), ext: extensionOf(String(block.mime_type ?? '')) }));
    const said = blocks.filter((/** @type {any} */ block) => block?.type === 'text' && typeof block.text === 'string')
        .map((/** @type {any} */ block) => block.text.trim()).filter(Boolean).join(' ');
    return { pictures, said };
}

/**
 * Pictures (and why there are none) in a generateContent answer.
 * @param {any} body Parsed answer
 * @returns {{pictures: {bytes: Buffer, ext: string}[], said: string, finish: string}} Pictures, text, finish reason
 */
export function readGenerateContent(body) {
    const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null;
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    const pictures = parts.filter((/** @type {any} */ part) => typeof part?.inlineData?.data === 'string' && part.inlineData.data)
        .map((/** @type {any} */ part) => ({ bytes: Buffer.from(part.inlineData.data, 'base64'), ext: extensionOf(String(part.inlineData.mimeType ?? '')) }));
    const said = parts.filter((/** @type {any} */ part) => typeof part?.text === 'string' && !part.thought)
        .map((/** @type {any} */ part) => part.text.trim()).filter(Boolean).join(' ');
    const finish = String(candidate?.finishReason ?? body?.promptFeedback?.blockReason ?? '');
    return { pictures, said, finish };
}

/**
 * The sentence for a failed answer.
 * @param {number} status HTTP status
 * @param {any} body Parsed answer, when it was JSON
 * @returns {LaneError} The error
 */
export function describeFailure(status, body) {
    // A bad key comes back wrapped in an array, `[{error: {…, status: 'INVALID_ARGUMENT'}}]`
    // (measured on the Interactions API 2026-10-10); other errors are a bare `{error}`.
    const error = (Array.isArray(body) ? body[0]?.error : body?.error) ?? {};
    const said = typeof error.message === 'string' ? error.message.trim() : '';
    const code = typeof error.status === 'string' ? error.status : (typeof error.code === 'string' ? error.code : undefined);
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(said)) {
        return new LaneError('Google did not accept the key. Check the Google AI Studio key under Connection.', { status, code });
    }
    if (status === 429) return new LaneError(`Google says slow down or top up: ${said || 'rate or quota limit reached'}`, { status, code });
    return new LaneError(`Gemini answered ${status}${said ? `: ${said}` : ''}`, { status, code });
}

/**
 * @param {typeof fetch} fetchImpl Fetch
 * @param {string} url Url
 * @param {string} key Key
 * @param {object} body Body
 * @param {AbortSignal} signal Signal
 * @returns {Promise<{status: number, ok: boolean, body: any}>} The answer
 */
async function post(fetchImpl, url, key, body, signal) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        // not JSON: the status speaks
    }
    return { status: response.status, ok: response.ok, body: parsed };
}

/**
 * Draws one picture on Gemini.
 * @param {object} params Inputs
 * @param {string} params.key `api_key_makersuite`
 * @param {LaneJob} params.job Job
 * @param {AbortSignal} params.signal Cancels the call
 * @param {'auto'|'interactions'|'generateContent'} [params.api] Which API (auto = Interactions, falling back)
 * @param {typeof fetch} [params.fetchImpl] Fetch (tests)
 * @param {string} [params.base] API base (tests)
 * @param {number} [params.timeoutMs] Timeout (tests)
 * @returns {Promise<{bytes: Buffer, ext: string}[]>} The pictures
 */
export async function drawGemini({ key, job, signal, api = 'auto', fetchImpl = fetch, base = GEMINI_BASE, timeoutMs = TIMEOUT_MS }) {
    const timed = withTimeout(signal, timeoutMs);
    try {
        if (api !== 'generateContent') {
            const answer = await post(fetchImpl, `${base}/interactions`, key, buildInteraction(job), timed.signal);
            if (answer.ok) {
                const { pictures, said } = readInteraction(answer.body);
                if (!pictures.length) throw new LaneError(said ? `Gemini answered without a picture: “${said}”` : 'Gemini answered without a picture.');
                return pictures;
            }
            if (api === 'interactions' || !FALLBACK_STATUSES.has(answer.status)) throw describeFailure(answer.status, answer.body);
        }
        const model = encodeURIComponent(job.model);
        const answer = await post(fetchImpl, `${base}/models/${model}:generateContent`, key, buildGenerateContent(job), timed.signal);
        if (!answer.ok) throw describeFailure(answer.status, answer.body);
        const { pictures, said, finish } = readGenerateContent(answer.body);
        if (pictures.length) return pictures;
        const reason = IMAGE_FINISH[/** @type {keyof typeof IMAGE_FINISH} */ (finish)];
        if (reason) throw new LaneError(reason, { code: finish });
        throw new LaneError(said ? `Gemini answered without a picture: “${said}”` : 'Gemini answered without a picture.');
    } catch (error) {
        if (timed.signal.aborted && !signal.aborted) throw new LaneError(`Gemini did not finish within ${Math.round(timeoutMs / 1000)} seconds`);
        throw error;
    } finally {
        timed.done();
    }
}
