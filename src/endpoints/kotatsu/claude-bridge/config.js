import { getConfigValue } from '../../../util.js';

export const CONFIG_PREFIX = 'kotatsu.claudeBridge';
export const LOOPBACK_HOST = '127.0.0.1';

/**
 * @typedef {object} BridgeConfig
 * @property {boolean} enabled Whether the listener should start at all
 * @property {string} host Bind address; only the loopback address is accepted
 * @property {number} port Bind port
 * @property {string} defaultModel Model used when a request names none
 * @property {string[]} models Models advertised on /v1/models
 * @property {boolean} resumeHistory Replay history as a resumed session (prompt-prefix caching)
 * @property {string} thinking adaptive | disabled | auto
 * @property {string} reasoningEffort low | medium | high | xhigh | max
 * @property {boolean} exposeReasoning Emit thinking as reasoning_content
 * @property {boolean} fastMode Ask the CLI for its fast lane
 * @property {boolean} allowApiBilling Keep API-billing env vars (defeats the subscription lane)
 * @property {number} requestTimeoutMs Per-request timeout
 * @property {number} maxBodyBytes Request body cap
 * @property {string} [apiToken] Bearer token; injected from the kotatsu-ccrp secret at boot
 * @property {string} [sdkVersion] SDK version this process booted with
 */

/**
 * Reads the bridge block out of config.yaml. Every key is read through
 * {@link getConfigValue}, so a `SILLYTAVERN_KOTATSU_CLAUDEBRIDGE_*` environment
 * variable overrides the file the same way it does for core settings.
 * @returns {BridgeConfig} The raw configured values
 */
export function readBridgeConfig() {
    return {
        enabled: getConfigValue(`${CONFIG_PREFIX}.enabled`, false, 'boolean'),
        host: getConfigValue(`${CONFIG_PREFIX}.host`, LOOPBACK_HOST),
        port: getConfigValue(`${CONFIG_PREFIX}.port`, 5107, 'number'),
        defaultModel: getConfigValue(`${CONFIG_PREFIX}.defaultModel`, 'claude-sonnet-4-6'),
        models: getConfigValue(`${CONFIG_PREFIX}.models`, []),
        resumeHistory: getConfigValue(`${CONFIG_PREFIX}.resumeHistory`, true, 'boolean'),
        thinking: getConfigValue(`${CONFIG_PREFIX}.thinking`, 'adaptive'),
        reasoningEffort: getConfigValue(`${CONFIG_PREFIX}.reasoningEffort`, 'high'),
        exposeReasoning: getConfigValue(`${CONFIG_PREFIX}.exposeReasoning`, true, 'boolean'),
        fastMode: getConfigValue(`${CONFIG_PREFIX}.fastMode`, false, 'boolean'),
        allowApiBilling: getConfigValue(`${CONFIG_PREFIX}.allowApiBilling`, false, 'boolean'),
        requestTimeoutMs: getConfigValue(`${CONFIG_PREFIX}.requestTimeoutMs`, 600000, 'number'),
        maxBodyBytes: getConfigValue(`${CONFIG_PREFIX}.maxBodyBytes`, 16777216, 'number'),
    };
}

/**
 * Validates the bridge block. Anything that would put the listener somewhere it does
 * not belong — a non-loopback bind, a privileged port, a default model the listener
 * would not advertise — throws here so the caller can stand the bridge down loudly
 * instead of serving a surprise.
 * @param {BridgeConfig} raw Raw configured values
 * @returns {BridgeConfig} The validated config
 */
export function validateBridgeConfig(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`${CONFIG_PREFIX} is missing from config.yaml`);
    }
    if (raw.host !== LOOPBACK_HOST) {
        throw new Error(`${CONFIG_PREFIX}.host must be ${LOOPBACK_HOST} (got ${JSON.stringify(raw.host)}); the bridge answers on the machine's own Claude login and must never leave the loopback interface`);
    }
    if (!Number.isInteger(raw.port) || raw.port < 1024 || raw.port > 65535) {
        throw new Error(`${CONFIG_PREFIX}.port must be an integer between 1024 and 65535 (got ${JSON.stringify(raw.port)})`);
    }
    if (typeof raw.defaultModel !== 'string' || !raw.defaultModel.trim()) {
        throw new Error(`${CONFIG_PREFIX}.defaultModel must be a non-empty string`);
    }
    if (!Array.isArray(raw.models) || !raw.models.length || raw.models.some((model) => typeof model !== 'string' || !model.trim())) {
        throw new Error(`${CONFIG_PREFIX}.models must be a non-empty list of model ids`);
    }
    if (!raw.models.includes(raw.defaultModel)) {
        throw new Error(`${CONFIG_PREFIX}.models must include defaultModel (${raw.defaultModel})`);
    }
    if (!Number.isFinite(raw.requestTimeoutMs) || raw.requestTimeoutMs <= 0) {
        throw new Error(`${CONFIG_PREFIX}.requestTimeoutMs must be a positive number of milliseconds`);
    }
    if (!Number.isFinite(raw.maxBodyBytes) || raw.maxBodyBytes <= 0) {
        throw new Error(`${CONFIG_PREFIX}.maxBodyBytes must be a positive number of bytes`);
    }
    return raw;
}
