import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

const DATA_URL_RE = /^data:(image\/[^;]+);base64,([A-Za-z0-9+/]+=*)$/;
const SYNTHETIC_START = '[Start]';

/**
 * @typedef {object} NormalizedMessage
 * @property {string} role One of system, user, assistant, tool
 * @property {string} content Flattened text content
 * @property {string[]} [images] Data URLs extracted from multi-part content
 * @property {string} [tool_call_id] Tool call this message answers
 * @property {object[]} [tool_calls] Assistant tool calls, normalized
 */

/**
 * @returns {string} A 24-character hex id for synthetic SDK message ids.
 */
function shortHex() {
    return randomUUID().replaceAll('-', '').slice(0, 24);
}

/**
 * Parses OpenAI tool-call arguments, which may arrive as a JSON string or an object.
 * @param {unknown} value Raw arguments
 * @returns {object} Parsed arguments, or an empty object when unusable
 */
function parseToolArguments(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Converts a base64 data URL into an Anthropic image block.
 * @param {unknown} url Candidate data URL
 * @returns {object|null} Image block, or null when the URL is not an inline image
 */
function imageBlockFromUrl(url) {
    if (typeof url !== 'string') return null;
    const match = url.match(DATA_URL_RE);
    if (!match) return null;
    return {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
    };
}

/**
 * Flattens OpenAI message content into plain text plus a list of image URLs.
 * @param {unknown} content String or multi-part content
 * @returns {{text: string, images: string[]}} Flattened content
 */
function contentToTextAndImages(content) {
    if (typeof content === 'string') {
        return { text: content, images: [] };
    }
    if (!Array.isArray(content)) {
        return { text: '', images: [] };
    }

    const text = [];
    const images = [];
    for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
            text.push(part.text);
            continue;
        }
        if (part.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (typeof url === 'string') images.push(url);
            continue;
        }
        if (part.type === 'image' && part.source?.type === 'base64') {
            const mediaType = part.source.media_type;
            const data = part.source.data;
            if (typeof mediaType === 'string' && typeof data === 'string') {
                images.push(`data:${mediaType};base64,${data}`);
            }
        }
    }
    return { text: text.join('\n'), images };
}

/**
 * Converts the client's final OpenAI-compatible message list into the narrow
 * message contract used by the Claude subscription runner.
 * @param {unknown} messages Raw OpenAI messages
 * @returns {NormalizedMessage[]} Normalized messages
 */
export function normalizeOpenAIMessages(messages) {
    if (!Array.isArray(messages)) {
        throw new TypeError('messages must be an array');
    }

    return messages.map((message, index) => {
        if (!message || typeof message !== 'object') {
            throw new TypeError(`messages[${index}] must be an object`);
        }
        let role = message.role;
        if (role === 'developer') role = 'system';
        if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
            throw new TypeError(`messages[${index}].role is unsupported: ${String(role)}`);
        }

        const normalizedContent = contentToTextAndImages(message.content);
        let text = normalizedContent.text;
        if (role !== 'system' && typeof message.name === 'string' && message.name.trim()) {
            const prefix = `${message.name.trim()}: `;
            if (!text.startsWith(prefix)) text = `${prefix}${text}`;
        }

        const normalized = {
            role,
            content: text,
            ...(normalizedContent.images.length ? { images: normalizedContent.images } : {}),
        };
        if (role === 'tool' && typeof message.tool_call_id === 'string') {
            normalized.tool_call_id = message.tool_call_id;
        }
        if (role === 'assistant' && Array.isArray(message.tool_calls)) {
            normalized.tool_calls = message.tool_calls
                .filter((call) => call?.type === 'function' && typeof call.id === 'string' && call.function)
                .map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: String(call.function.name ?? ''),
                        arguments: typeof call.function.arguments === 'string'
                            ? call.function.arguments
                            : JSON.stringify(call.function.arguments ?? {}),
                    },
                }));
        }
        return normalized;
    });
}

/**
 * Wraps a trailing assistant prefill into a continuation instruction the SDK can take
 * as a user turn, without letting the prefill close the wrapping tag.
 * @param {unknown} prefill The assistant text already written
 * @returns {string} Continuation prompt
 */
export function buildAssistantPrefillContinuationPrompt(prefill) {
    const normalized = String(prefill ?? '').trimEnd();
    if (!normalized.trim()) return 'Continue the assistant\'s reply.';
    const safePrefill = normalized.replaceAll('</assistant_prefill>', '&lt;/assistant_prefill&gt;');
    return [
        'Continue the assistant\'s reply as if it already began with the prefill below.',
        'The prefill is already part of the assistant message, so do not repeat it.',
        'Start with the very next text that should follow it, preserving the same voice, format, and momentum.',
        '',
        '<assistant_prefill>',
        safePrefill,
        '</assistant_prefill>',
    ].join('\n');
}

/**
 * Keeps a preset's in-chat placement. Only the system messages BEFORE the conversation starts
 * become the system prompt; a system message that appears later (post-history instructions, a
 * prompt injected at a chat depth) is turned into user-turn text where it stands and merged into
 * the neighbouring user message. This is what SillyTavern's own Claude converter does
 * (`convertClaudeMessages`), and it is how a depth-0 instruction stays next to the last message
 * instead of being hoisted to the top. Messages with no late system content come back unchanged.
 * @param {NormalizedMessage[]} messages Normalized messages
 * @returns {NormalizedMessage[]} Messages with late system content folded into user turns
 */
export function foldLateSystemMessages(messages) {
    const firstTurn = messages.findIndex((message) => message.role !== 'system');
    if (firstTurn === -1 || !messages.slice(firstTurn).some((message) => message.role === 'system')) {
        return messages;
    }
    /** @type {Array<NormalizedMessage & {late?: boolean}>} */
    const out = messages.slice(0, firstTurn);
    for (const message of messages.slice(firstTurn)) {
        const late = message.role === 'system';
        if (late && !message.content.trim()) continue;
        const next = late ? { role: 'user', content: message.content, late: true } : { ...message };
        const prev = out.length > firstTurn ? out.at(-1) : null;
        if (prev && prev.role === 'user' && next.role === 'user' && (prev.late || next.late)) {
            prev.content = `${prev.content}\n\n${next.content}`;
            if (next.images) prev.images = [...(prev.images ?? []), ...next.images];
            prev.late = prev.late && next.late;
            continue;
        }
        out.push(next);
    }
    return out.map(({ late, ...message }) => message);
}

/**
 * Splits normalized messages into replayable history plus the turn to send now.
 * @param {NormalizedMessage[]} messages Normalized messages
 * @returns {{history: NormalizedMessage[], current: NormalizedMessage, shape: string, assistantPrefillLength?: number}} Split
 */
export function splitHistoryForResume(messages) {
    const nonSystem = messages.filter((message) => message.role !== 'system');
    if (nonSystem.length === 0) {
        return {
            history: [],
            current: { role: 'user', content: SYNTHETIC_START },
            shape: 'synthetic-start',
        };
    }

    const trailing = nonSystem.at(-1);
    if (trailing.role === 'assistant') {
        return {
            history: nonSystem.slice(0, -1),
            current: { role: 'user', content: buildAssistantPrefillContinuationPrompt(trailing.content) },
            shape: 'trailing-assistant-continue',
            assistantPrefillLength: trailing.content.length,
        };
    }
    return {
        history: nonSystem.slice(0, -1),
        current: trailing,
        shape: trailing.role === 'tool' ? 'trailing-tool' : 'trailing-user',
    };
}

/**
 * Joins every system message into one system prompt.
 * @param {NormalizedMessage[]} messages Normalized messages
 * @returns {string|undefined} System prompt, or undefined when there is none
 */
export function extractSystemPrompt(messages) {
    const blocks = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content.trim())
        .filter(Boolean);
    return blocks.length ? blocks.join('\n\n') : undefined;
}

/**
 * Builds the SDK content for a user or tool message.
 * @param {NormalizedMessage} message Normalized message
 * @returns {string|object[]} SDK content
 */
function buildUserContent(message) {
    if (message.role === 'tool') {
        return [{
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: message.content ?? '',
        }];
    }

    const images = (message.images ?? []).map(imageBlockFromUrl).filter(Boolean);
    if (!images.length) return message.content ?? '';
    if (message.content) images.push({ type: 'text', text: message.content });
    return images;
}

/**
 * The session fields shared by every replayed transcript entry.
 * @param {object} meta Session metadata
 * @returns {object} Transcript metadata
 */
function transcriptMetadata(meta) {
    return {
        userType: 'external',
        entrypoint: 'cli',
        cwd: meta.cwd,
        sessionId: meta.sessionId,
        version: meta.version,
        gitBranch: meta.gitBranch,
    };
}

/**
 * Builds a transcript entry for a replayed user turn.
 * @param {{message: NormalizedMessage, parentUuid: string|null, meta: object}} params Entry inputs
 * @returns {object} Transcript entry
 */
function buildUserEntry({ message, parentUuid, meta }) {
    return {
        parentUuid,
        isSidechain: false,
        promptId: randomUUID(),
        type: 'user',
        message: { role: 'user', content: buildUserContent(message) },
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        permissionMode: meta.permissionMode,
        ...transcriptMetadata(meta),
    };
}

/**
 * Builds a transcript entry for a replayed assistant turn.
 * @param {{message: NormalizedMessage, parentUuid: string|null, meta: object, model: string}} params Entry inputs
 * @returns {object} Transcript entry
 */
function buildAssistantEntry({ message, parentUuid, meta, model }) {
    const blocks = [];
    if (message.content) blocks.push({ type: 'text', text: message.content });
    for (const toolCall of message.tool_calls ?? []) {
        blocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: parseToolArguments(toolCall.function.arguments),
        });
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '' });

    return {
        parentUuid,
        isSidechain: false,
        message: {
            model,
            id: `msg_${shortHex()}`,
            type: 'message',
            role: 'assistant',
            content: blocks,
            stop_reason: message.tool_calls?.length ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
        requestId: `req_${shortHex()}`,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...transcriptMetadata(meta),
    };
}

/**
 * Assembles a parent-chained transcript from replayable history.
 * @param {NormalizedMessage[]} history Messages to replay
 * @param {object} meta Session metadata (sessionId, cwd, version, gitBranch, permissionMode)
 * @param {string} model Model id stamped on assistant entries
 * @returns {object[]} Transcript entries
 */
export function assembleEntries(history, meta, model) {
    const entries = [];
    let parentUuid = null;
    for (const message of history) {
        if (message.role === 'system') continue;
        const entry = message.role === 'assistant'
            ? buildAssistantEntry({ message, parentUuid, meta, model })
            : buildUserEntry({ message, parentUuid, meta });
        entries.push(entry);
        parentUuid = entry.uuid;
    }
    return entries;
}

/**
 * Wraps the current turn as an SDK user message.
 * @param {NormalizedMessage} message The turn to send
 * @returns {object} SDK user message
 */
export function currentToSdkUserMessage(message) {
    return {
        type: 'user',
        message: { role: 'user', content: buildUserContent(message) },
        parent_tool_use_id: null,
    };
}

/**
 * Yields exactly one SDK message.
 * @param {object} message SDK message
 * @yields {object} The message
 */
async function* singleMessageIterable(message) {
    yield message;
}

/**
 * An in-memory session store that serves one synthetic transcript to the SDK's resume path.
 * Nothing is ever written back — the client stays the only owner of chat state.
 */
export class ResumeSessionStore {
    #sessionId;
    #entries;

    /**
     * @param {string} sessionId Session id the transcript belongs to
     * @param {object[]} entries Transcript entries
     */
    constructor(sessionId, entries) {
        this.#sessionId = sessionId;
        this.#entries = entries;
    }

    /**
     * @param {{sessionId: string}} key Session key requested by the SDK
     * @returns {Promise<object[]|null>} The transcript, or null for any other session
     */
    load(key) {
        return Promise.resolve(key.sessionId === this.#sessionId ? this.#entries : null);
    }

    /**
     * @returns {Promise<void>} Resolves immediately; the bridge never persists turns.
     */
    append() {
        return Promise.resolve();
    }
}

/**
 * Folds the whole conversation into a single prompt string (the no-resume fallback).
 * @param {NormalizedMessage[]} messages Normalized messages
 * @returns {{systemPrompt: string|undefined, prompt: string}} Folded prompt
 */
function renderTranscript(messages) {
    const systemPrompt = extractSystemPrompt(messages);
    const nonSystem = messages.filter((message) => message.role !== 'system');
    const trailingAssistant = nonSystem.at(-1)?.role === 'assistant' ? nonSystem.at(-1) : null;
    const turns = [];
    for (const message of nonSystem) {
        if (message === trailingAssistant) continue;
        if (!message.content.trim()) continue;
        turns.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
    }
    if (trailingAssistant) {
        turns.push(`User: ${buildAssistantPrefillContinuationPrompt(trailingAssistant.content)}`);
    }
    if (!turns.length) turns.push(`User: ${SYNTHETIC_START}`);
    return { systemPrompt, prompt: turns.join('\n\n') };
}

/**
 * Chooses between the resume path (replayed transcript, cached prefix) and the folded path.
 * @param {NormalizedMessage[]} messages Normalized messages
 * @param {{model: string, scratchDir: string, sdkVersion: string, useResume?: boolean}} options Selection inputs
 * @returns {object} The selected prompt, system prompt, resume session and shape
 */
export function selectPromptPath(rawMessages, { model, scratchDir, sdkVersion, useResume = true }) {
    const messages = foldLateSystemMessages(rawMessages);
    if (!useResume) {
        const folded = renderTranscript(messages);
        return {
            prompt: folded.prompt,
            systemPrompt: folded.systemPrompt,
            resumeSessionId: null,
            sessionStore: null,
            cwd: null,
            shape: 'folded',
        };
    }

    const split = splitHistoryForResume(messages);
    const systemPrompt = extractSystemPrompt(messages);
    if (!split.history.length) {
        return {
            prompt: singleMessageIterable(currentToSdkUserMessage(split.current)),
            systemPrompt,
            resumeSessionId: null,
            sessionStore: null,
            cwd: null,
            shape: split.shape,
        };
    }

    mkdirSync(scratchDir, { recursive: true });
    const sessionId = randomUUID();
    const meta = {
        sessionId,
        cwd: scratchDir,
        version: sdkVersion,
        gitBranch: 'main',
        permissionMode: 'bypassPermissions',
    };
    const entries = assembleEntries(split.history, meta, model);
    return {
        prompt: singleMessageIterable(currentToSdkUserMessage(split.current)),
        systemPrompt,
        resumeSessionId: sessionId,
        sessionStore: new ResumeSessionStore(sessionId, entries),
        cwd: scratchDir,
        shape: split.shape,
        entries,
    };
}
