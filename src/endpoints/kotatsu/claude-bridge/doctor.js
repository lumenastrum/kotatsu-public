import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { detectSdkVersion } from './runtime.js';

const CLI_TIMEOUT_MS = 20000;

/**
 * The only fields of `claude auth status` that ever leave this process. The CLI also
 * prints the account email, org id and org name; those are the user's identity, not
 * bridge health, so they are dropped here rather than filtered downstream.
 */
const AUTH_STATUS_FIELDS = ['loggedIn', 'authMethod', 'subscriptionType'];

let cachedBinary;

/**
 * Finds the `claude` executable on PATH.
 *
 * Resolved here rather than handed to a shell: the doctor runs a fixed argument list
 * with nothing from the request in it, and keeping `shell: false` means there is no
 * command string for anything to be injected into, now or after a future edit.
 * @returns {string|null} Absolute path to the executable, or null when it is not on PATH
 */
export function resolveClaudeBinary() {
    if (cachedBinary !== undefined) return cachedBinary;

    const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const extensions = process.platform === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
        : [''];

    for (const entry of entries) {
        for (const extension of extensions) {
            const candidate = path.join(entry, `claude${extension}`);
            try {
                if (fs.statSync(candidate).isFile()) {
                    cachedBinary = candidate;
                    return cachedBinary;
                }
            } catch {
                // Not here; keep looking.
            }
        }
    }

    cachedBinary = null;
    return cachedBinary;
}

/**
 * Runs the Claude CLI with a fixed argument list.
 * @param {string[]} args Arguments
 * @returns {{ok: boolean, stdout: string, stderr: string, status: number|null, error?: string}} Result
 */
function runClaude(args) {
    const binary = resolveClaudeBinary();
    if (!binary) {
        return { ok: false, stdout: '', stderr: '', status: null, error: 'claude was not found on PATH; install Claude Code and run `claude auth login` as the same OS user that runs Kotatsu' };
    }

    const result = spawnSync(binary, args, {
        shell: false,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
    });

    if (result.error) {
        return { ok: false, stdout: '', stderr: '', status: null, error: String(result.error.message ?? result.error) };
    }
    return {
        ok: result.status === 0,
        stdout: String(result.stdout ?? '').trim(),
        stderr: String(result.stderr ?? '').trim(),
        status: result.status,
    };
}

/**
 * Reads `claude --version`.
 * @returns {{available: boolean, version: string|null, error?: string}} CLI version report
 */
export function readClaudeCliVersion() {
    const result = runClaude(['--version']);
    if (!result.ok) {
        return { available: false, version: null, error: result.error ?? result.stderr ?? `claude --version exited ${result.status}` };
    }
    return { available: true, version: result.stdout };
}

/**
 * Reads `claude auth status` and keeps only {@link AUTH_STATUS_FIELDS}.
 * @returns {object} Reduced auth status
 */
export function readClaudeAuthStatus() {
    const result = runClaude(['auth', 'status']);
    if (!result.ok) {
        return { available: false, error: result.error ?? result.stderr ?? `claude auth status exited ${result.status}` };
    }

    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        return { available: false, error: 'claude auth status did not return JSON' };
    }

    const reduced = { available: true };
    for (const field of AUTH_STATUS_FIELDS) {
        reduced[field] = parsed?.[field] ?? null;
    }
    return reduced;
}

/**
 * Builds the /doctor payload: the health block plus the two drift checks that have
 * actually bitten us — an SDK upgraded underneath a running listener, and a CLI too old
 * for the models the bridge advertises.
 * @param {object} health The /health payload
 * @returns {object} The doctor report
 */
export function buildDoctorReport(health) {
    const sdkOnDisk = detectSdkVersion();
    const sdkRunning = health?.sdkVersion ?? null;
    // A listener that booted before the SDK on disk changed keeps serving the old one
    // until Kotatsu restarts, which shows up as confusing upstream 400s on new models.
    const restartRequired = Boolean(health?.listening) && sdkRunning !== null && sdkRunning !== sdkOnDisk;
    const cli = readClaudeCliVersion();
    const auth = readClaudeAuthStatus();

    return {
        ...health,
        ok: Boolean(health?.ok) && !restartRequired,
        sdkOnDisk,
        sdkRunning,
        ...(restartRequired
            ? { restartRequired: `listener is on ${sdkRunning}, disk has ${sdkOnDisk}` }
            : {}),
        claudeCli: cli,
        claudeAuth: auth,
    };
}
