import { timingSafeEqual, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';

import { detectSdkVersion } from './runtime.js';

const LOG_PREFIX = '[Claude bridge]';

/**
 * An error carrying the HTTP status the client should see.
 */
class HttpError extends Error {
    /**
     * @param {number} status HTTP status code
     * @param {string} message Error message
     */
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/**
 * Writes a JSON response with no-store caching.
 * @param {import('node:http').ServerResponse} response Response
 * @param {number} status HTTP status
 * @param {unknown} value JSON body
 * @returns {void}
 */
function jsonResponse(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

/**
 * @param {string} message Error message
 * @param {string} [type] OpenAI error type
 * @returns {object} OpenAI-shaped error body
 */
function openAIError(message, type = 'invalid_request_error') {
    return { error: { message, type } };
}

/**
 * Constant-time bearer token comparison.
 * @param {unknown} header The Authorization header
 * @param {string} expected The expected token
 * @returns {boolean} True when the header carries the expected bearer token
 */
function tokenMatches(header, expected) {
    if (!expected) return true;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const actual = Buffer.from(header.slice(7), 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * Reads and parses a JSON body, enforcing the size cap before and during the read.
 * @param {import('node:http').IncomingMessage} request Request
 * @param {number} maxBodyBytes Size cap
 * @returns {Promise<object>} Parsed body
 */
async function readJsonBody(request, maxBodyBytes) {
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        throw new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes`);
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBodyBytes) {
            throw new HttpError(413, `Request body exceeds ${maxBodyBytes} bytes`);
        }
        chunks.push(chunk);
    }
    if (!chunks.length) throw new HttpError(400, 'Request body is required');
    try {
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
        throw new HttpError(400, 'Request body must be valid JSON');
    }
}

/**
 * Rejects request shapes this bridge deliberately does not serve.
 * @param {unknown} body Parsed body
 * @returns {void}
 */
function validateCompletionBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be a JSON object');
    }
    if (!Array.isArray(body.messages)) {
        throw new HttpError(400, 'messages must be an array');
    }
    if (body.n !== undefined && Number(body.n) !== 1) {
        throw new HttpError(400, 'The Claude bridge supports n=1 only');
    }
    if (Array.isArray(body.tools) && body.tools.length) {
        throw new HttpError(400, 'The Claude bridge is an isolated text/RP provider; live tools are disabled');
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        throw new HttpError(400, 'stream must be a boolean');
    }
}

/**
 * Writes to the response, waiting for drain when the socket is backed up.
 * @param {import('node:http').ServerResponse} response Response
 * @param {string} value Chunk to write
 * @returns {Promise<boolean>} True when the response is still writable
 */
async function writeWithBackpressure(response, value) {
    if (response.destroyed || response.writableEnded) return false;
    if (response.write(value)) return true;
    await Promise.race([
        once(response, 'drain'),
        once(response, 'close'),
    ]);
    return !response.destroyed && !response.writableEnded;
}

/**
 * @returns {string} A completion id in the OpenAI shape
 */
function completionId() {
    return `chatcmpl-claude-code-${randomUUID().replaceAll('-', '')}`;
}

/**
 * Drains an async generator, handing each yielded chunk to a callback and returning
 * the generator's return value.
 * @param {AsyncGenerator} generator The runner
 * @param {Function} onChunk Chunk handler
 * @returns {Promise<any>} The generator's return value
 */
async function consumeGenerator(generator, onChunk) {
    for (;;) {
        const next = await generator.next();
        if (next.done) return next.value;
        await onChunk(next.value);
    }
}

/**
 * @param {{id: string, created: number, model: string, delta?: object, finishReason?: string|null, usage?: object}} params Chunk fields
 * @returns {object} An OpenAI SSE chunk
 */
function streamChunk({ id, created, model, delta = {}, finishReason = null, usage }) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    };
}

/**
 * @param {unknown} error Abort reason
 * @returns {Error} An Error carrying that reason
 */
function abortReason(error) {
    return error instanceof Error ? error : new Error(String(error ?? 'Request aborted'));
}

/**
 * Creates the loopback OpenAI-compatible listener in front of the Claude runner.
 * @param {{config: object, runner: Function, logger?: object}} params Inputs
 * @returns {object} The bridge handle (server, address, inFlight, listen, close)
 */
export function createOpenAIBridge({
    config,
    runner,
    logger = console,
}) {
    const requestControllers = new Set();
    let listeningAddress = null;

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        response.setHeader('X-Content-Type-Options', 'nosniff');

        if (request.method === 'GET' && url.pathname === '/health') {
            return jsonResponse(response, 200, {
                ok: true,
                service: 'kotatsu-claude-bridge',
                inFlight: requestControllers.size,
                model: config.defaultModel,
                // The version this RUNNING process loaded. Reinstalling the SDK
                // does not change it — only a restart does. /doctor compares
                // this against what's on disk so a stale listener can't sit
                // there rejecting new models with a confusing upstream 400.
                sdkVersion: config.sdkVersion ?? detectSdkVersion(),
            });
        }
        if (request.method === 'OPTIONS') {
            response.writeHead(204, { Allow: 'GET, POST, OPTIONS' });
            return response.end();
        }
        if (!tokenMatches(request.headers.authorization, config.apiToken)) {
            return jsonResponse(response, 401, openAIError('Unauthorized', 'authentication_error'));
        }
        if (request.method === 'GET' && url.pathname === '/v1/models') {
            return jsonResponse(response, 200, {
                object: 'list',
                data: config.models.map((id) => ({
                    id,
                    object: 'model',
                    created: 0,
                    owned_by: 'claude-subscription',
                })),
            });
        }
        if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
            return jsonResponse(response, 404, openAIError('Not found'));
        }

        const requestAbort = new AbortController();
        requestControllers.add(requestAbort);
        const timeout = setTimeout(() => {
            requestAbort.abort(new Error(`Claude request timed out after ${config.requestTimeoutMs}ms`));
        }, config.requestTimeoutMs);
        timeout.unref?.();

        const abortOnClientClose = () => {
            if (!response.writableEnded) requestAbort.abort(new Error('The client disconnected'));
        };
        request.once('aborted', abortOnClientClose);
        response.once('close', abortOnClientClose);

        try {
            const body = await readJsonBody(request, config.maxBodyBytes);
            validateCompletionBody(body);

            const id = completionId();
            const created = Math.floor(Date.now() / 1000);
            const requestedModel = typeof body.model === 'string' && body.model.trim()
                ? body.model.trim()
                : config.defaultModel;
            const generator = runner({ ...body, model: requestedModel }, requestAbort.signal);

            if (body.stream === true) {
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
                await writeWithBackpressure(response, `data: ${JSON.stringify(streamChunk({
                    id,
                    created,
                    model: requestedModel,
                    delta: { role: 'assistant' },
                }))}\n\n`);

                const result = await consumeGenerator(generator, async (chunk) => {
                    const delta = chunk.type === 'reasoning'
                        ? { reasoning_content: chunk.data }
                        : { content: chunk.data };
                    await writeWithBackpressure(response, `data: ${JSON.stringify(streamChunk({
                        id,
                        created,
                        model: requestedModel,
                        delta,
                    }))}\n\n`);
                });
                if (!requestAbort.signal.aborted) {
                    await writeWithBackpressure(response, `data: ${JSON.stringify(streamChunk({
                        id,
                        created,
                        model: result?.actualModel ?? requestedModel,
                        finishReason: 'stop',
                        usage: result?.usage,
                    }))}\n\n`);
                    await writeWithBackpressure(response, 'data: [DONE]\n\n');
                    response.end();
                }
                return;
            }

            let content = '';
            let reasoning = '';
            const result = await consumeGenerator(generator, async (chunk) => {
                if (chunk.type === 'reasoning') reasoning += chunk.data;
                else content += chunk.data;
            });
            return jsonResponse(response, 200, {
                id,
                object: 'chat.completion',
                created,
                model: result?.actualModel ?? requestedModel,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content,
                        ...(reasoning ? { reasoning_content: reasoning } : {}),
                    },
                    finish_reason: 'stop',
                }],
                usage: result?.usage,
            });
        } catch (error) {
            if (requestAbort.signal.aborted || error?.name === 'AbortError') {
                if (!response.headersSent && !response.destroyed) {
                    jsonResponse(response, 499, openAIError(abortReason(requestAbort.signal.reason).message, 'request_aborted'));
                } else if (!response.writableEnded && !response.destroyed) {
                    response.end();
                }
                return;
            }

            const status = error instanceof HttpError ? error.status : 500;
            const message = error instanceof Error ? error.message : String(error);
            logger.error?.(`${LOG_PREFIX} ${message}`);
            if (!response.headersSent) {
                return jsonResponse(response, status, openAIError(message, status >= 500 ? 'server_error' : 'invalid_request_error'));
            }
            if (!response.writableEnded && !response.destroyed) {
                await writeWithBackpressure(response, `data: ${JSON.stringify(openAIError(message, 'server_error'))}\n\n`);
                await writeWithBackpressure(response, 'data: [DONE]\n\n');
                response.end();
            }
        } finally {
            clearTimeout(timeout);
            request.removeListener('aborted', abortOnClientClose);
            response.removeListener('close', abortOnClientClose);
            requestControllers.delete(requestAbort);
        }
    });

    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    return {
        server,
        get address() {
            return listeningAddress;
        },
        get inFlight() {
            return requestControllers.size;
        },
        /**
         * @param {number} [port] Port to bind
         * @param {string} [host] Host to bind
         * @returns {Promise<object>} The bound address
         */
        async listen(port = config.port, host = config.host) {
            if (listeningAddress) return listeningAddress;
            server.listen(port, host);
            await once(server, 'listening');
            listeningAddress = server.address();
            return listeningAddress;
        },
        /**
         * Aborts every in-flight request, then closes the listener.
         * @returns {Promise<void>} Resolves once the listener is closed
         */
        async close() {
            for (const controller of requestControllers) {
                controller.abort(new Error('The Claude bridge is shutting down'));
            }
            if (!listeningAddress) return;
            server.close();
            await once(server, 'close');
            listeningAddress = null;
        },
    };
}
