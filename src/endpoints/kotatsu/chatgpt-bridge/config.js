import { getConfigValue } from '../../../util.js';

/**
 * ChatGPT bridge config (docs/chatgpt-bridge-v0.md §1). The bridge answers through the user's own
 * ChatGPT plan, so like the Claude bridge it never leaves the loopback interface. It is on by
 * default but does nothing until the user signs in.
 */
export const CONFIG_PREFIX = 'kotatsu.chatgptBridge';
export const LOOPBACK_HOST = '127.0.0.1';

/** OpenAI's documented endpoints for the open-source token-sharing flow (docs/chatgpt-bridge-protocol.md). */
export const OPENAI = Object.freeze({
    issuer: 'https://auth.openai.com',
    authorize: 'https://auth.openai.com/api/accounts/authorize',
    token: 'https://auth.openai.com/api/accounts/oauth/token',
    discovery: 'https://auth.openai.com/.well-known/openid-configuration',
    jwks: 'https://auth.openai.com/.well-known/jwks.json',
    resource: 'https://api.openai.com/v1',
    responses: 'https://api.openai.com/v1/responses',
    models: 'https://api.openai.com/v1/models',
    manageUsage: 'https://chatgpt.com/settings/usage',
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    planScope: 'chatgpt.tokens.use.direct',
    registrationClientId: 'dynamic_agent_client',
    agentName: 'Kotatsu',
});

/**
 * @returns {{enabled: boolean, host: string, port: number, defaultModel: string, requestTimeoutMs: number, maxBodyBytes: number, trace: boolean}}
 */
export function readChatGPTBridgeConfig() {
    return {
        enabled: getConfigValue(`${CONFIG_PREFIX}.enabled`, true, 'boolean'),
        host: getConfigValue(`${CONFIG_PREFIX}.host`, LOOPBACK_HOST),
        port: getConfigValue(`${CONFIG_PREFIX}.port`, 5108, 'number'),
        // Empty = the first model OpenAI lists for the signed-in account.
        defaultModel: getConfigValue(`${CONFIG_PREFIX}.defaultModel`, ''),
        requestTimeoutMs: getConfigValue(`${CONFIG_PREFIX}.requestTimeoutMs`, 600000, 'number'),
        maxBodyBytes: getConfigValue(`${CONFIG_PREFIX}.maxBodyBytes`, 16777216, 'number'),
        // Off by default. On: one line per reply in DATA_ROOT/.kotatsu/chatgpt-trace.jsonl with a
        // fingerprint of each prompt item (role, length, short hash; never the text) and the usage.
        trace: getConfigValue(`${CONFIG_PREFIX}.trace`, false, 'boolean'),
    };
}

/**
 * @param {ReturnType<typeof readChatGPTBridgeConfig>} raw
 * @returns {ReturnType<typeof readChatGPTBridgeConfig>}
 */
export function validateChatGPTBridgeConfig(raw) {
    if (raw.host !== LOOPBACK_HOST) {
        throw new Error(`${CONFIG_PREFIX}.host must be ${LOOPBACK_HOST} (got ${JSON.stringify(raw.host)}); OpenAI only accepts a 127.0.0.1 callback and the bridge answers on the user's own plan`);
    }
    if (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535) {
        throw new Error(`${CONFIG_PREFIX}.port must be an integer between 1024 and 65535 (got ${JSON.stringify(raw.port)})`);
    }
    if (typeof raw.defaultModel !== 'string') {
        throw new Error(`${CONFIG_PREFIX}.defaultModel must be a string (empty = the first listed model)`);
    }
    if (!Number.isFinite(raw.requestTimeoutMs) || raw.requestTimeoutMs <= 0) {
        throw new Error(`${CONFIG_PREFIX}.requestTimeoutMs must be a positive number of milliseconds`);
    }
    if (!Number.isFinite(raw.maxBodyBytes) || raw.maxBodyBytes <= 0) {
        throw new Error(`${CONFIG_PREFIX}.maxBodyBytes must be a positive number of bytes`);
    }
    return raw;
}
