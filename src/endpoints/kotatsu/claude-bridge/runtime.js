import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
    normalizeOpenAIMessages,
    selectPromptPath,
} from './session.js';

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SDK_ERROR_DETAIL_LIMIT = 1600;
const LOG_PREFIX = '[Claude bridge]';

let cachedSdk = null;

/**
 * Imports the Claude Agent SDK once per process.
 * @returns {Promise<object>} The SDK module namespace
 */
async function defaultSdkLoader() {
    if (!cachedSdk) {
        cachedSdk = import('@anthropic-ai/claude-agent-sdk').catch((error) => {
            cachedSdk = null;
            throw error;
        });
    }
    return cachedSdk;
}

/**
 * Collapses whitespace and truncates a value for error reporting.
 * @param {unknown} value Candidate text
 * @returns {string|null} Compacted text, or null when there is nothing useful
 */
function compactText(value) {
    if (typeof value !== 'string') return null;
    const compact = value.trim().replace(/\s+/g, ' ');
    return compact ? compact.slice(0, SDK_ERROR_DETAIL_LIMIT) : null;
}

/**
 * Walks an error (plus its causes and aggregated errors) for anything a human can act on.
 * @param {unknown} error The thrown value
 * @param {Set<unknown>} [seen] Cycle guard
 * @returns {string[]} Distinct detail strings
 */
function collectErrorDetails(error, seen = new Set()) {
    if (!error || seen.has(error)) return [];
    seen.add(error);
    const parts = [];
    const direct = compactText(error instanceof Error ? error.message : String(error));
    if (direct && direct !== '[object Object]') parts.push(direct);
    if (typeof error === 'object') {
        for (const key of ['stderr', 'stdout', 'details', 'detail', 'code', 'status']) {
            const value = compactText(error[key]);
            if (value) parts.push(`${key}: ${value}`);
        }
        if (Array.isArray(error.errors)) {
            for (const nested of error.errors) parts.push(...collectErrorDetails(nested, seen));
        }
        if (error.cause) parts.push(...collectErrorDetails(error.cause, seen));
    }
    return [...new Set(parts)];
}

/**
 * Renders an SDK failure, pointing at the login that actually owns the subscription.
 * @param {unknown} error The thrown value
 * @returns {string} Human-readable message
 */
export function formatClaudeError(error) {
    const details = collectErrorDetails(error);
    const message = details.length ? details.join(' | ') : String(error);
    if (/Claude Code request failed|authentication|not logged in|oauth/i.test(message)) {
        return `${message}. Confirm \`claude auth login\` was run by the same Windows account as Kotatsu. USERPROFILE=${process.env.USERPROFILE ?? 'unset'}.`;
    }
    return message;
}

/**
 * Builds the child environment for the Claude CLI. Anything that would reroute the
 * request onto API billing (or onto a different endpoint entirely) is stripped unless
 * the operator opted in — the whole point of this bridge is the subscription lane.
 * @param {NodeJS.ProcessEnv} [source] Environment to derive from
 * @param {boolean} [allowApiBilling] Keep API-billing variables
 * @returns {NodeJS.ProcessEnv} Child environment
 */
export function createSubscriptionEnvironment(source = process.env, allowApiBilling = false) {
    const env = {
        ...source,
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    };
    if (!allowApiBilling) {
        for (const key of [
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_BASE_URL',
            'CLAUDE_CODE_USE_BEDROCK',
            'CLAUDE_CODE_USE_VERTEX',
            'CLAUDE_CODE_USE_FOUNDRY',
        ]) {
            delete env[key];
        }
    }
    return env;
}

/**
 * Tests whether a model wants adaptive thinking rather than the legacy on/off switch.
 * @param {string} model Model id
 * @returns {boolean} True when the model is on the adaptive-thinking generation
 */
export function isClaudeAdaptiveModel(model) {
    const normalized = model.toLowerCase();
    return (
        /claude-opus-4-(?:[7-9]|\d{2,})/.test(normalized)
        || /claude-(?:opus|sonnet)-5(?:$|[-.])/.test(normalized)
        || normalized.includes('claude-fable-5')
        || normalized.includes('claude-mythos-5')
    );
}

/**
 * Tests whether a model refuses to run with thinking off. Opus 5.5, Sonnet 5.5 and the
 * Fable/Mythos 5 line return a 400 for `thinking: {type: 'disabled'}`; effort is the dial
 * they have, so a "disabled" request is honoured as adaptive + low effort. (Sonnet 5.5's own
 * off switch, `{type: 'between_tools'}`, is an API shape the SDK option isn't known to carry.)
 * @param {string} model Model id
 * @returns {boolean} True when thinking cannot be disabled on this model
 */
export function isThinkingAlwaysOnModel(model) {
    const normalized = model.toLowerCase();
    return (
        /claude-(?:opus|sonnet)-5-(?:[5-9]|\d{2,})(?:$|[-.])/.test(normalized)
        || normalized.includes('claude-fable-5')
        || normalized.includes('claude-mythos-5')
    );
}

/**
 * Reads the Claude Agent SDK version from disk.
 * @returns {string} Version string, or 'unknown' when it cannot be resolved
 */
export function detectSdkVersion() {
    try {
        const require = createRequire(import.meta.url);
        const mainPath = require.resolve('@anthropic-ai/claude-agent-sdk');
        const packagePath = join(dirname(mainPath), 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        if (typeof packageJson.version === 'string') return packageJson.version;
    } catch {
        // Diagnostic stamp only. The SDK accepts arbitrary version strings.
    }
    return 'unknown';
}

/**
 * @param {string} [reason] Message for the abort error
 * @returns {Error} An AbortError
 */
function makeAbortError(reason = 'Claude request aborted') {
    const error = new Error(reason);
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

/**
 * @param {unknown} requested Effort from the request body
 * @param {string} fallback Configured effort
 * @returns {string} A valid effort level
 */
function normalizeEffort(requested, fallback) {
    const candidate = typeof requested === 'string' ? requested.toLowerCase() : fallback;
    return VALID_EFFORTS.has(candidate) ? candidate : 'high';
}

/**
 * Resolves the thinking mode for a request.
 * @param {object} body Request body
 * @param {object} config Bridge config
 * @param {string} model Model id
 * @returns {'adaptive'|'disabled'|'auto'} Thinking mode
 */
function requestedThinking(body, config, model) {
    const explicit = body?.thinking?.type;
    if (explicit === 'disabled' && isThinkingAlwaysOnModel(model)) return 'adaptive';
    if (explicit === 'disabled' || explicit === 'adaptive') return explicit;
    if (isClaudeAdaptiveModel(model)) return 'adaptive';
    return config.thinking === 'disabled' ? 'disabled' : config.thinking === 'adaptive' ? 'adaptive' : 'auto';
}

/**
 * Builds the SDK query options: no tools, no skills, no settings sources, one turn.
 * @param {{body: object, config: object, model: string, abortController: AbortController, selection: object}} params Inputs
 * @returns {object} SDK options
 */
export function buildSdkOptions({ body, config, model, abortController, selection }) {
    const options = {
        abortController,
        model,
        includePartialMessages: body.stream !== false,
        tools: [],
        skills: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        settings: { fastMode: Boolean(config.fastMode) },
        env: createSubscriptionEnvironment(process.env, Boolean(config.allowApiBilling)),
    };
    if (selection.systemPrompt !== undefined) options.systemPrompt = selection.systemPrompt;

    const thinking = requestedThinking(body, config, model);
    if (thinking === 'adaptive') {
        options.thinking = {
            type: 'adaptive',
            ...(config.exposeReasoning ? { display: 'summarized' } : {}),
        };
        // A caller who asked for thinking OFF on a model that cannot turn it off gets the
        // cheapest thing that model offers instead of an upstream 400.
        const wantedOff = body?.thinking?.type === 'disabled' && isThinkingAlwaysOnModel(model);
        options.effort = wantedOff && !body.reasoning_effort
            ? 'low'
            : normalizeEffort(body.reasoning_effort, config.reasoningEffort);
    } else if (thinking === 'disabled' && /claude-(?:opus|sonnet)-5(?:$|[-.])/i.test(model)) {
        options.thinking = { type: 'disabled' };
    }

    if (selection.resumeSessionId && selection.cwd && selection.sessionStore) {
        options.resume = selection.resumeSessionId;
        options.cwd = selection.cwd;
        options.sessionStore = selection.sessionStore;
    }
    return options;
}

/**
 * Converts SDK usage into OpenAI usage, counting cache reads and writes as prompt tokens.
 * @param {object|null} message SDK result message
 * @returns {object} OpenAI usage block
 */
function usageFromResult(message) {
    const raw = message?.usage ?? {};
    const fresh = Number(raw.input_tokens ?? 0);
    const cached = Number(raw.cache_read_input_tokens ?? 0);
    const cacheWrite = Number(raw.cache_creation_input_tokens ?? 0);
    const output = Number(raw.output_tokens ?? 0);
    const prompt = fresh + cached + cacheWrite;
    return {
        prompt_tokens: prompt,
        completion_tokens: output,
        total_tokens: prompt + output,
        prompt_tokens_details: {
            cached_tokens: cached,
            cache_creation_tokens: cacheWrite,
            fresh_tokens: fresh,
        },
    };
}

/**
 * Creates the Claude Code runner. Each invocation gets a fresh synthetic session;
 * the chat client remains the only owner of chat state.
 * @param {{config: object, scratchDir: string, sdkLoader?: Function, activeControllers?: Set<AbortController>, logger?: object}} params Inputs
 * @returns {Function} An async generator function taking (body, upstreamSignal)
 */
export function createClaudeRunner({
    config,
    scratchDir,
    sdkLoader = defaultSdkLoader,
    activeControllers = new Set(),
    logger = console,
}) {
    const sdkVersion = detectSdkVersion();

    return async function* runClaude(body, upstreamSignal) {
        const model = typeof body.model === 'string' && body.model.trim()
            ? body.model.trim()
            : config.defaultModel;
        if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
            throw new TypeError('model contains unsupported characters');
        }

        const messages = normalizeOpenAIMessages(body.messages);
        let selection;
        try {
            selection = selectPromptPath(messages, {
                model,
                scratchDir,
                sdkVersion,
                useResume: config.resumeHistory !== false,
            });
        } catch (error) {
            logger.warn?.(`${LOG_PREFIX} Resume setup failed; using folded transcript:`, error.message);
            selection = selectPromptPath(messages, {
                model,
                scratchDir,
                sdkVersion,
                useResume: false,
            });
        }

        const abortController = new AbortController();
        const abortFromUpstream = () => abortController.abort(upstreamSignal?.reason);
        if (upstreamSignal?.aborted) abortFromUpstream();
        else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
        activeControllers.add(abortController);

        let queryHandle = null;
        let emittedText = false;
        let success = false;
        let resultUsage = usageFromResult(null);
        let actualModels = [];
        let fastModeState = null;

        try {
            const { query } = await sdkLoader();
            const options = buildSdkOptions({ body, config, model, abortController, selection });
            queryHandle = query({ prompt: selection.prompt, options });

            for await (const message of queryHandle) {
                if (message.type === 'stream_event') {
                    const event = message.event;
                    if (event?.type !== 'content_block_delta' || !event.delta) continue;
                    if (event.delta.type === 'text_delta' && event.delta.text) {
                        emittedText = true;
                        yield { type: 'text', data: event.delta.text };
                    } else if (
                        config.exposeReasoning
                        && event.delta.type === 'thinking_delta'
                        && event.delta.thinking
                    ) {
                        yield { type: 'reasoning', data: event.delta.thinking };
                    }
                    continue;
                }

                if (message.type === 'system' && message.subtype === 'init') {
                    const tools = Array.isArray(message.tools) ? message.tools : [];
                    const mcpServers = Array.isArray(message.mcp_servers) ? message.mcp_servers : [];
                    const leakedMcpTools = tools.filter((tool) => String(tool).startsWith('mcp__'));
                    if (mcpServers.length || leakedMcpTools.length) {
                        logger.warn?.(`${LOG_PREFIX} SDK exposed MCP surface despite isolation settings.`);
                    }
                    continue;
                }

                if (message.type === 'assistant' && body.stream === false) {
                    for (const block of message.message?.content ?? []) {
                        if (block.type === 'text' && block.text) {
                            emittedText = true;
                            yield { type: 'text', data: block.text };
                        } else if (config.exposeReasoning && block.type === 'thinking' && block.thinking) {
                            yield { type: 'reasoning', data: block.thinking };
                        }
                    }
                    continue;
                }

                if (message.type === 'result') {
                    if (message.subtype !== 'success') {
                        const details = Array.isArray(message.errors) && message.errors.length
                            ? `: ${message.errors.join('; ')}`
                            : '';
                        throw new Error(`Claude Code request failed (${message.subtype})${details}`);
                    }
                    success = true;
                    resultUsage = usageFromResult(message);
                    actualModels = Object.keys(message.modelUsage ?? {});
                    fastModeState = message.fast_mode_state ?? null;
                    if (!emittedText && typeof message.result === 'string' && message.result.trim()) {
                        emittedText = true;
                        yield { type: 'text', data: message.result };
                    }
                }
            }
        } catch (error) {
            if (abortController.signal.aborted || upstreamSignal?.aborted) {
                throw makeAbortError();
            }
            throw new Error(`Claude subscription request failed: ${formatClaudeError(error)}`, { cause: error });
        } finally {
            upstreamSignal?.removeEventListener('abort', abortFromUpstream);
            activeControllers.delete(abortController);
            if (abortController.signal.aborted && typeof queryHandle?.close === 'function') {
                try {
                    await queryHandle.close();
                } catch {
                    // Abort is already authoritative; close is best-effort cleanup.
                }
            }
        }

        if (!emittedText) {
            throw new Error(
                `Claude subscription returned no content (model=${model}, success=${success}, USERPROFILE=${process.env.USERPROFILE ?? 'unset'}).`,
            );
        }
        if (actualModels.length && !actualModels.includes(model)) {
            logger.warn?.(`${LOG_PREFIX} Requested ${model}, billed model(s): ${actualModels.join(', ')}.`);
        }
        if (fastModeState && fastModeState !== 'off') {
            logger.warn?.(`${LOG_PREFIX} fast_mode_state=${fastModeState}; model routing may differ.`);
        }

        return {
            requestedModel: model,
            actualModel: actualModels.length === 1 ? actualModels[0] : model,
            usage: resultUsage,
            sessionId: selection.resumeSessionId,
            promptShape: selection.shape,
        };
    };
}
