import crypto from 'node:crypto';

import { HttpError } from '../claude-bridge/http.js';
import { OPENAI } from './config.js';
import { SignInRequired } from './tokens.js';

/**
 * The ChatGPT bridge's engine (docs/chatgpt-bridge-v0.md §1): chat completions in, the Responses
 * API out, through the user's own plan. The request body is built from scratch, so the fields this
 * route rejects (temperature, top_p, max_output_tokens, … — protocol §5) can never leak through;
 * `store: false` and `stream: true` are always set; only `response.completed` counts as success.
 */

/** Messages shown to the user, in OpenAI's own words where they gave them (protocol §7). */
export const MESSAGES = Object.freeze({
    limit: `Usage limit reached. Review your plan or this app's limit in ChatGPT settings: ${OPENAI.manageUsage}`,
    notEligible: 'This ChatGPT account can\'t use its plan in other apps. ChatGPT Plus or Pro is required.',
    unavailable: 'ChatGPT is unavailable right now. Try again in a moment.',
    endedEarly: 'ChatGPT\'s reply stopped before it finished.',
    noModels: 'ChatGPT didn\'t list any models for this account.',
});

/**
 * @param {unknown} content OpenAI chat content: a string or an array of parts
 * @param {'user'|'assistant'|'developer'} role
 * @returns {string|Array<object>}
 */
function translateContent(content, role) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return String(content ?? '');
    if (role !== 'user') return content.map(part => (part?.type === 'text' ? part.text : '')).join('');
    return content.flatMap((part) => {
        if (part?.type === 'text') return [{ type: 'input_text', text: String(part.text ?? '') }];
        if (part?.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            return url ? [{ type: 'input_image', image_url: url }] : [];
        }
        return [];
    });
}

/**
 * Chat messages → `{instructions, input}`. Leading system messages become `instructions`; a system
 * message after the conversation starts becomes a `developer` message where it stands (this route
 * rejects `system` items); a `name` is kept as a "Name: " prefix like the Claude bridge does. Pure.
 * @param {Array<{role: string, content: unknown, name?: string}>} messages
 * @returns {{instructions: string, input: Array<{role: string, content: string|Array<object>}>}}
 */
export function toResponsesInput(messages) {
    const instructions = [];
    const input = [];
    let started = false;
    for (const message of messages ?? []) {
        const role = message?.role === 'developer' ? 'system' : message?.role;
        if (role === 'system' && !started) {
            const text = translateContent(message.content, 'developer');
            if (String(text).trim()) instructions.push(String(text).trim());
            continue;
        }
        if (role === 'tool') continue;
        started = true;
        const mapped = role === 'system' ? 'developer' : role === 'assistant' ? 'assistant' : 'user';
        let content = translateContent(message.content, mapped);
        if (mapped !== 'developer' && typeof message.name === 'string' && message.name.trim() && typeof content === 'string') {
            const prefix = `${message.name.trim()}: `;
            if (!content.startsWith(prefix)) content = `${prefix}${content}`;
        }
        if (typeof content === 'string' && !content.trim()) continue;
        if (Array.isArray(content) && !content.length) continue;
        input.push({ role: mapped, content });
    }
    return { instructions: instructions.join('\n\n'), input };
}

/**
 * The Responses request body. Only these fields are ever sent. Pure.
 * @param {{model: string, messages: Array<object>}} body Chat completions body
 * @returns {object}
 */
export function buildResponsesBody({ model, messages }) {
    const { instructions, input } = toResponsesInput(messages);
    return {
        model,
        ...(instructions ? { instructions } : {}),
        input,
        store: false,
        stream: true,
    };
}

/**
 * Turns an OpenAI error (status + body) into the HttpError the chat client sees. Pure.
 * @param {number} status
 * @param {any} body
 * @returns {HttpError}
 */
export function mapOpenAIError(status, body) {
    const error = body?.error ?? body ?? {};
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? error.message : (typeof body?.detail === 'string' ? body.detail : '');
    switch (code) {
        case 'subscription_sharing_usage_limit_exceeded': return new HttpError(429, MESSAGES.limit);
        case 'subscription_sharing_user_not_eligible': return new HttpError(403, MESSAGES.notEligible);
        case 'subscription_sharing_usage_unavailable':
        case 'subscription_sharing_user_unavailable': return new HttpError(503, MESSAGES.unavailable);
        case 'subscription_sharing_unsupported_capability':
            return new HttpError(400, `ChatGPT can't take ${error.param ? `"${error.param}"` : 'part of this request'} through a shared plan.`);
        case 'subscription_sharing_invalid_user': return new HttpError(401, new SignInRequired().message);
        default:
            if (status === 401) return new HttpError(401, new SignInRequired().message);
            if (status === 503) return new HttpError(503, MESSAGES.unavailable);
            return new HttpError(status >= 400 ? status : 502, message ? `ChatGPT: ${message}` : `ChatGPT answered ${status}.`);
    }
}

/**
 * A fingerprint of a Responses body for the trace: role, length and a short hash per item, never
 * the text. Two turns' fingerprints show where their prompts stop sharing a prefix. Pure.
 * @param {{instructions?: string, input: Array<{role: string, content: unknown}>}} body
 * @returns {{instructions: {chars: number, sha: string}, input: Array<{role: string, chars: number, sha: string}>}}
 */
export function fingerprintResponsesBody(body) {
    const print = (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
        return { chars: text.length, sha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) };
    };
    return {
        instructions: print(body.instructions ?? ''),
        input: (body.input ?? []).map(item => ({ role: item.role, ...print(item.content) })),
    };
}

/**
 * Splits a Server-Sent Events byte stream into parsed JSON events.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<any>}
 */
export async function* readSseEvents(stream) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of /** @type {any} */ (stream)) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
            const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            try {
                yield JSON.parse(data);
            } catch {
                // A malformed event is skipped; the missing `response.completed` will fail the reply.
            }
        }
    }
}

/**
 * Responses usage → chat completions usage. The cache and reasoning figures ride along in OpenAI's
 * nested spelling, and only when the route reported them, so the metrics bar's `cacheKnown` stays
 * honest. Live-captured 2026-10-03 on a Pro plan: `input_tokens_details.cached_tokens` is real
 * (5,504 of 5,631 on a hit), but hits are routing luck (~1 in 5 repeats of an identical prefix).
 * The route overwrites `prompt_cache_key` with a random id per request, so a key can't steer it;
 * `cache_write_tokens` always reads 0. Pure.
 * @param {any} usage Responses usage
 * @returns {object|undefined} Chat completions usage
 */
export function toChatUsage(usage) {
    if (!usage) return undefined;
    const prompt = Number(usage.input_tokens ?? 0);
    const completion = Number(usage.output_tokens ?? 0);
    const cached = usage.input_tokens_details?.cached_tokens;
    const reasoning = usage.output_tokens_details?.reasoning_tokens;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: Number(usage.total_tokens ?? prompt + completion),
        ...(cached != null ? { prompt_tokens_details: { cached_tokens: Number(cached) } } : {}),
        ...(reasoning != null ? { completion_tokens_details: { reasoning_tokens: Number(reasoning) } } : {}),
    };
}

/**
 * Folds Responses stream events into text/reasoning chunks; throws unless `response.completed`.
 * @param {AsyncIterable<any>} events
 * @returns {AsyncGenerator<{type: 'text'|'reasoning', data: string}, {actualModel?: string, usage?: object}>}
 */
export async function* foldResponseEvents(events) {
    for await (const event of events) {
        switch (event?.type) {
            case 'response.output_text.delta':
                if (event.delta) yield { type: 'text', data: event.delta };
                break;
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta':
                if (event.delta) yield { type: 'reasoning', data: event.delta };
                break;
            case 'response.completed':
                return { actualModel: event.response?.model, usage: toChatUsage(event.response?.usage) };
            case 'response.failed':
                throw mapOpenAIError(502, { error: event.response?.error });
            case 'response.incomplete':
                throw new HttpError(502, `${MESSAGES.endedEarly}${event.response?.incomplete_details?.reason ? ` (${event.response.incomplete_details.reason})` : ''}`);
            case 'error':
                throw mapOpenAIError(502, { error: event.error ?? event });
            default:
                break;
        }
    }
    throw new HttpError(502, MESSAGES.endedEarly);
}

/**
 * The model catalog for the signed-in account (protocol §6): `models[]`, keep `visibility ==
 * "list"`, server order. Cached briefly.
 */
export class ModelCatalog {
    #tokens;
    #fetch;
    /** @type {{at: number, models: Array<{slug: string, name: string}>}|null} */
    #cache = null;

    /**
     * @param {import('./tokens.js').TokenManager} tokens
     * @param {{fetchImpl?: typeof fetch}} [options]
     */
    constructor(tokens, { fetchImpl = fetch } = {}) {
        this.#tokens = tokens;
        this.#fetch = fetchImpl;
    }

    clear() {
        this.#cache = null;
    }

    /**
     * @returns {Promise<Array<{slug: string, name: string}>>}
     */
    async list() {
        if (this.#cache && Date.now() - this.#cache.at < 5 * 60_000) return this.#cache.models;
        const response = await authorizedFetch(this.#tokens, this.#fetch, OPENAI.models, { method: 'GET' });
        const body = await response.json();
        const models = (Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : [])
            .filter(model => (model.visibility ?? 'list') === 'list' && (model.slug || model.id))
            .map(model => ({ slug: String(model.slug ?? model.id), name: String(model.display_name ?? model.slug ?? model.id) }));
        this.#cache = { at: Date.now(), models };
        return models;
    }
}

/**
 * A fetch with the plan's bearer. A 401 refreshes once and retries; still 401 → sign in again.
 * Non-OK answers become mapped HttpErrors.
 * @param {import('./tokens.js').TokenManager} tokens
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export async function authorizedFetch(tokens, fetchImpl, url, init) {
    let token;
    try {
        token = await tokens.accessToken();
    } catch (error) {
        if (error instanceof SignInRequired) throw new HttpError(401, error.message);
        throw error;
    }
    const send = (bearer) => fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${bearer}` } });
    let response = await send(token);
    if (response.status === 401) {
        try {
            response = await send(await tokens.accessToken({ force: true }));
        } catch (error) {
            if (error instanceof SignInRequired) throw new HttpError(401, error.message);
            throw error;
        }
    }
    if (!response.ok) {
        const text = await response.text();
        let body = {};
        try { body = JSON.parse(text); } catch { body = { detail: text.slice(0, 300) }; }
        throw mapOpenAIError(response.status, body);
    }
    return response;
}

/**
 * The runner `createOpenAIBridge` drives.
 * @param {{tokens: import('./tokens.js').TokenManager, catalog: ModelCatalog, fetchImpl?: typeof fetch, onTrace?: (entry: object) => void}} deps
 * @returns {(body: any, signal: AbortSignal) => AsyncGenerator<{type: string, data: string}, {actualModel?: string, usage?: object}>}
 */
export function createChatGPTRunner({ tokens, catalog, fetchImpl = fetch, onTrace }) {
    return async function* runChatGPT(body, signal) {
        let model = typeof body.model === 'string' ? body.model.trim() : '';
        if (!model) {
            const models = await catalog.list();
            if (!models.length) throw new HttpError(502, MESSAGES.noModels);
            model = models[0].slug;
        }
        const request = buildResponsesBody({ model, messages: body.messages });
        const response = await authorizedFetch(tokens, fetchImpl, OPENAI.responses, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(request),
            signal,
        });
        if (!response.body) throw new HttpError(502, MESSAGES.endedEarly);
        const result = yield* foldResponseEvents(readSseEvents(response.body));
        if (onTrace) {
            try {
                onTrace({ at: new Date().toISOString(), model: result.actualModel ?? model, usage: result.usage ?? null, ...fingerprintResponsesBody(request) });
            } catch {
                // The trace is a diagnostic; it never costs a reply.
            }
        }
        return { ...result, actualModel: result.actualModel ?? model };
    };
}
