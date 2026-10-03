import net from 'node:net';

import { keyToEnv } from '../../../util.js';
import { applyPathsToYaml, writeConfigValues } from '../config-yaml.js';
import { CONFIG_PREFIX, LOOPBACK_HOST } from './config.js';

/**
 * The bridge settings the Connection tab may change (connections-v0 C4), and whether a change
 * applies to the running bridge or waits for a restart. Everything live is read per request from
 * the one `config` object the runner and the HTTP layer share; the port is bound at startup.
 * Host, enabled, thinking, billing, timeouts and body caps stay config.yaml-only on purpose.
 * @type {Readonly<Record<string, { kind: 'boolean'|'model'|'models'|'port', live: boolean }>>}
 */
export const EDITABLE = Object.freeze({
    exposeReasoning: { kind: 'boolean', live: true },
    resumeHistory: { kind: 'boolean', live: true },
    fastMode: { kind: 'boolean', live: true },
    defaultModel: { kind: 'model', live: true },
    models: { kind: 'models', live: true },
    port: { kind: 'port', live: false },
});

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Validates a settings patch from the client, key by key. Pure.
 * @param {unknown} body Request body
 * @returns {{ patch: Record<string, any>, errors: string[] }}
 */
export function normalizeSettingsPatch(body) {
    /** @type {Record<string, any>} */
    const patch = {};
    /** @type {string[]} */
    const errors = [];
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { patch, errors: ['Expected an object of bridge settings'] };
    }
    for (const [key, value] of Object.entries(body)) {
        const spec = EDITABLE[key];
        if (!spec) {
            errors.push(`${key} can't be changed from Kotatsu`);
            continue;
        }
        switch (spec.kind) {
            case 'boolean':
                if (typeof value === 'boolean') patch[key] = value;
                else errors.push(`${key} must be true or false`);
                break;
            case 'model':
                if (typeof value === 'string' && MODEL_ID.test(value.trim())) patch[key] = value.trim();
                else errors.push(`${key} must be a model id`);
                break;
            case 'models': {
                const list = Array.isArray(value) ? value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean) : [];
                const bad = list.find(id => !MODEL_ID.test(id));
                if (!list.length) errors.push('models must list at least one model id');
                else if (bad) errors.push(`"${bad}" isn't a model id`);
                else patch[key] = [...new Set(list)];
                break;
            }
            case 'port':
                if (Number.isInteger(value) && value >= 1024 && value <= 65535) patch[key] = value;
                else errors.push('port must be a whole number between 1024 and 65535');
                break;
        }
    }
    return { patch, errors };
}

/**
 * Keys an environment variable overrides: a value written to config.yaml would never be read.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function envLockedKeys(env = process.env) {
    return Object.keys(EDITABLE).filter(key => keyToEnv(`${CONFIG_PREFIX}.${key}`) in env);
}

/**
 * Writes keys under `kotatsu.claudeBridge` into YAML text as surgical edits (the shared writer,
 * `../config-yaml.js`): only the named values' bytes change, a key the block lacks is appended
 * inside it, and a config with no bridge block gets one. Pure over the text.
 * @param {string} text config.yaml contents
 * @param {Record<string, any>} patch Validated keys
 * @returns {string}
 */
export function applyPatchToYaml(text, patch) {
    return applyPathsToYaml(text, toPaths(patch));
}

/**
 * Writes a validated patch to config.yaml (atomically) and to the process's cached config, so a
 * later `getConfigValue()` agrees with the file.
 * @param {Record<string, any>} patch
 * @returns {void}
 */
export function writeBridgeSettings(patch) {
    writeConfigValues(toPaths(patch));
}

/**
 * @param {Record<string, any>} patch
 * @returns {import('../config-yaml.js').PathValue[]}
 */
function toPaths(patch) {
    const base = CONFIG_PREFIX.split('.');
    return Object.entries(patch).map(([key, value]) => [[...base, key], value]);
}

/**
 * Whether nothing is listening on a loopback port right now.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.once('listening', () => probe.close(() => resolve(true)));
        probe.listen(port, LOOPBACK_HOST);
    });
}

/**
 * The first free loopback port after `from`, for "Use port N" when the bridge's port is taken.
 * @param {number} from
 * @param {number} [span]
 * @returns {Promise<number|null>}
 */
export async function findFreePort(from, span = 20) {
    for (let port = from + 1; port <= Math.min(65535, from + span); port++) {
        if (await isPortFree(port)) return port;
    }
    return null;
}
