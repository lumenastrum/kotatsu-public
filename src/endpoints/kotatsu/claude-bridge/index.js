import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { color, keyToEnv } from '../../../util.js';
import { serverDirectory } from '../../../server-directory.js';
import { readBridgeConfig, validateBridgeConfig, CONFIG_PREFIX } from './config.js';
import { ensureBridgeToken, BRIDGE_SECRET_ID } from './secret.js';
import { createClaudeRunner, detectSdkVersion } from './runtime.js';
import { createOpenAIBridge } from './http.js';
import { buildDoctorReport } from './doctor.js';
import { EDITABLE, envLockedKeys, findFreePort, isPortFree, normalizeSettingsPatch, writeBridgeSettings } from './settings.js';

const LOG_PREFIX = '[Claude bridge]';
const LEGACY_PLUGIN_DIR = 'claude-code-rp';

/**
 * @typedef {object} BridgeState
 * @property {boolean} enabled Whether config asked for a listener
 * @property {boolean} listening Whether the listener is up
 * @property {string|null} standingDown Why the bridge is not serving, when it is not
 * @property {import('./config.js').BridgeConfig|null} config Configured values
 * @property {object|null} bridge The listener handle
 * @property {Set<AbortController>} activeControllers In-flight SDK calls
 * @property {string|null} scratchDir Session scratch directory
 * @property {string|null} sdkVersion SDK version this process booted with
 * @property {Record<string, any>} pending Saved to config.yaml, waiting on a restart (C4: the port)
 */

/** @type {BridgeState} */
const state = {
    enabled: false,
    listening: false,
    standingDown: null,
    config: null,
    bridge: null,
    activeControllers: new Set(),
    scratchDir: null,
    sdkVersion: null,
    pending: {},
};

/**
 * Resets the module state between starts.
 * @returns {void}
 */
function resetState() {
    state.enabled = false;
    state.listening = false;
    state.standingDown = null;
    state.config = null;
    state.bridge = null;
    state.activeControllers = new Set();
    state.scratchDir = null;
    state.sdkVersion = null;
    state.pending = {};
}

/**
 * Detects the retired SillyTavern server plugin.
 *
 * Kotatsu shipped this bridge as a gitignored `plugins/claude-code-rp` before it moved
 * into core. An install that pulls the core version while the plugin folder is still
 * there would run two bridges — and the plugin owns the port the profile points at, so
 * whichever loses the race is invisible. Finding the folder means the operator has not
 * done the migration yet, so core stands down and says exactly what to do.
 * @param {string} [serverDir] Server directory to probe
 * @returns {string|null} The offending path, or null when the folder is absent
 */
export function detectLegacyPlugin(serverDir = serverDirectory) {
    const pluginPath = path.join(serverDir, 'plugins', LEGACY_PLUGIN_DIR);
    try {
        return fs.statSync(pluginPath).isDirectory() ? pluginPath : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} pluginPath The legacy plugin folder
 * @returns {string} The stand-down reason
 */
function legacyStandDownReason(pluginPath) {
    return `The retired server plugin is still installed at ${pluginPath}. Two bridges cannot own the same port, so the built-in one is standing down. Migration (docs/ship-v0.md decision 7): remove that folder, set enableServerPlugins: false, and set ${CONFIG_PREFIX}.port to the port the plugin used so the existing connection profile keeps working.`;
}

/**
 * The current bridge status, as served by GET /health.
 * @returns {object} Status payload
 */
export function getBridgeStatus() {
    const config = state.config;
    return {
        ok: !state.standingDown && (!state.enabled || state.listening),
        enabled: state.enabled,
        listening: state.listening,
        listener: config ? `http://${config.host}:${config.port}/v1` : null,
        model: config?.defaultModel ?? null,
        models: Array.isArray(config?.models) ? config.models : [],
        inFlight: state.bridge?.inFlight ?? 0,
        sdkVersion: state.sdkVersion,
        standingDown: state.standingDown,
        // Connections v0 C1: what the Claude Code card shows. Read-only here — the write path is
        // slice C4. `supervised` = a launcher (Start.bat / start.sh) relaunches on exit code 75,
        // so the card may offer "Restart Kotatsu"; a hand-started `node server.js` would just stop.
        supervised: process.env.KOTATSU_SUPERVISED === '1',
        settings: config ? {
            reasoningEffort: config.reasoningEffort,
            thinking: config.thinking,
            exposeReasoning: Boolean(config.exposeReasoning),
            resumeHistory: config.resumeHistory !== false,
            fastMode: Boolean(config.fastMode),
            allowApiBilling: Boolean(config.allowApiBilling),
            port: config.port,
            // C4: keys an environment variable overrides; the card shows them, never edits them.
            locked: envLockedKeys(),
        } : null,
        // C4: saved to config.yaml but not running yet (the port binds at startup).
        pendingRestart: Object.keys(state.pending).length ? { ...state.pending } : null,
    };
}

/**
 * Starts the loopback bridge for the given user directories.
 *
 * Never throws: a bridge that cannot start (port taken, SDK missing, bad config, an
 * unreadable secrets file) logs why and lets Kotatsu boot without it. Losing the Claude
 * lane is a bad afternoon; losing the whole server over it is a worse one.
 * @param {object} options Options
 * @param {import('../../../users.js').UserDirectoryList[]} options.directories User directories (single-user mode = one entry)
 * @returns {Promise<void>} Resolves once the bridge is listening or has stood down
 */
export async function startClaudeBridge({ directories }) {
    resetState();

    try {
        const config = readBridgeConfig();
        state.config = config;
        state.enabled = config.enabled === true;

        if (!state.enabled) {
            console.info(color.blue(`${LOG_PREFIX} Disabled (${CONFIG_PREFIX}.enabled: false); no listener started.`));
            return;
        }

        const legacyPlugin = detectLegacyPlugin();
        if (legacyPlugin) {
            state.standingDown = legacyStandDownReason(legacyPlugin);
            console.warn(color.yellow(`${LOG_PREFIX} ${state.standingDown}`));
            return;
        }

        validateBridgeConfig(config);

        const { token, users } = ensureBridgeToken(directories);
        config.apiToken = token;

        state.sdkVersion = detectSdkVersion();
        config.sdkVersion = state.sdkVersion;

        // Dotfolder under the data root, never inside the repo: the SDK writes resume
        // transcripts here and they must not land in a working tree or a git status.
        const dataRoot = globalThis.DATA_ROOT;
        if (typeof dataRoot !== 'string' || !dataRoot) {
            throw new Error('DATA_ROOT is not set; the bridge has nowhere to keep its session scratch directory');
        }
        state.scratchDir = path.join(dataRoot, '.kotatsu', 'claude-bridge');

        const runner = createClaudeRunner({
            config,
            scratchDir: state.scratchDir,
            activeControllers: state.activeControllers,
        });
        state.bridge = createOpenAIBridge({ config, runner });
        await state.bridge.listen();
        state.listening = true;

        const adopted = users.filter(user => user.adopted).length;
        console.info(color.green(`${LOG_PREFIX} Listening on http://${config.host}:${config.port}/v1`), `(model ${config.defaultModel}, SDK ${state.sdkVersion}, secret ${BRIDGE_SECRET_ID} ${adopted ? `adopted for ${adopted}/${users.length} user(s)` : `provisioned for ${users.length} user(s)`})`);
    } catch (error) {
        state.listening = false;
        state.bridge = null;
        state.standingDown = error instanceof Error ? error.message : String(error);
        console.error(color.red(`${LOG_PREFIX} Not started:`), state.standingDown);
    }
}

/**
 * Stops the bridge listener and aborts anything still in flight (graceful-exit hook).
 * @returns {Promise<void>} Resolves once the listener is closed
 */
export async function stopClaudeBridge() {
    const bridge = state.bridge;
    const controllers = state.activeControllers;

    state.bridge = null;
    state.listening = false;

    for (const controller of controllers) {
        try {
            controller.abort(new Error('The Claude bridge is shutting down'));
        } catch {
            // Best-effort: a controller that is already aborted is fine.
        }
    }
    controllers.clear();

    if (!bridge) return;

    try {
        await bridge.close();
    } catch (error) {
        console.warn(color.yellow(`${LOG_PREFIX} Failed to close the listener cleanly:`), error);
    }
}

export const router = express.Router();

router.get('/health', (_request, response) => {
    return response.json(getBridgeStatus());
});

router.get('/doctor', async (_request, response) => {
    try {
        return response.json(await buildDoctorReport(getBridgeStatus()));
    } catch (error) {
        console.error(`${LOG_PREFIX} Doctor failed:`, error);
        return response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
});

/*
 * Connections v0 C4: the Claude Code card's write path. Validates a patch, refuses keys an
 * environment variable overrides (the file would never be read for them), checks the merged
 * result against the same rules the bridge boots with, writes config.yaml keeping its comments,
 * then applies the live keys to the running bridge — the runner and the HTTP layer read them per
 * request from the one shared config object. The port only takes effect on a restart; it is held
 * in `pendingRestart` until then.
 */
router.post('/settings', async (request, response) => {
    const { patch, errors } = normalizeSettingsPatch(request.body);
    if (errors.length) return response.status(400).json({ ok: false, error: errors.join('; ') });
    const locked = envLockedKeys().filter(key => key in patch);
    if (locked.length) {
        return response.status(409).json({ ok: false, error: `Set by an environment variable, so config.yaml can't change it: ${locked.map(key => keyToEnv(`${CONFIG_PREFIX}.${key}`)).join(', ')}` });
    }
    const current = state.config ?? readBridgeConfig();
    const merged = { ...current, ...state.pending, ...patch };
    try {
        validateBridgeConfig(merged);
    } catch (error) {
        return response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    if ('port' in patch && patch.port !== current.port && !(await isPortFree(patch.port))) {
        return response.status(409).json({ ok: false, error: `Something is already listening on port ${patch.port}` });
    }
    try {
        writeBridgeSettings(patch);
    } catch (error) {
        console.error(`${LOG_PREFIX} Settings write failed:`, error);
        return response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    /** @type {string[]} */
    const applied = [];
    for (const [key, value] of Object.entries(patch)) {
        if (EDITABLE[key].live) {
            if (state.config) /** @type {Record<string, any>} */ (state.config)[key] = value;
            applied.push(key);
        } else if (state.config && value === state.config[key]) {
            delete state.pending[key];
        } else {
            state.pending[key] = value;
        }
    }
    console.info(color.blue(`${LOG_PREFIX} Settings saved to config.yaml: ${Object.keys(patch).join(', ')}${Object.keys(state.pending).length ? ` (restart pending: ${Object.keys(state.pending).join(', ')})` : ''}`));
    return response.json({ ok: true, applied, health: getBridgeStatus() });
});

// C4: "Use port N" — the first free loopback port after the configured one.
router.get('/free-port', async (_request, response) => {
    const from = state.config?.port ?? readBridgeConfig().port;
    return response.json({ port: await findFreePort(Number(from) || 5107) });
});
