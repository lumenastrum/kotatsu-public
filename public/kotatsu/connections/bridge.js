/**
 * Kotatsu ↔ the built-in Claude Code bridge, in the browser (docs/connections-v0.md, slice C0).
 *
 * The bridge (src/endpoints/kotatsu/claude-bridge/) is, to core, just Chat Completion → custom →
 * a loopback URL. This module is the one place the frontend knows better:
 *
 * - **Is the active connection the bridge?** `isBridgeUrl()` matches `oai_settings.custom_url`
 *   against the listener `/api/kotatsu/claude-bridge/health` reports — never a hardcoded port
 *   (an existing install may run on 5109). The answer is written as `body[data-k-bridge]` (the
 *   baggage sheet hides what the bridge ignores) and announced as `k-bridge-change` on
 *   `document` (the model pill relabels itself "Claude Code").
 * - **First run connects by itself.** Measured 2026-10-01 on a pristine install: bridge healthy,
 *   profile selected, settings right — and still `no_connection`, Send hidden, because
 *   auto-connect defaults off and nothing applies the profile at boot. When the active
 *   connection IS the bridge and its health is ok, this presses core's own Connect once at
 *   APP_READY. Local and free, so there is nothing to ask. Any other connection keeps core's
 *   `auto_connect` behaviour untouched.
 * - **Say why, when it can't.** `/doctor` knows what the toast never said: not signed in to
 *   Claude Code, or an engine update waiting on a restart. Checked once in the background after
 *   connecting (it spawns the `claude` CLI, so never on the boot path), surfaced as one toast
 *   with the fix. A bridge that stood down says so with its reason instead of connecting.
 *
 * One-way imports: kotatsu → core.
 */

import { restartAndWait } from '../shell/restart.js';
import { getGeneratingApi, getRequestHeaders, main_api, online_status, saveSettings, saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { extension_settings } from '../../scripts/extensions.js';
import { oai_settings } from '../../scripts/openai.js';
import { power_user } from '../../scripts/power-user.js';

/** Bubbling `document` event fired when the "on the bridge" answer changes. */
export const BRIDGE_CHANGE_EVENT = 'k-bridge-change';
/** Bubbling `document` event fired when a fresh `/health` or `/doctor` answer lands. */
export const BRIDGE_STATUS_EVENT = 'k-bridge-status';

/**
 * Claude Code's effort, owned by Kotatsu (connections-v0 C1). Claude's scale has five steps and
 * core's "Reasoning Effort" select has neither Extra high nor a "use the bridge's default", so
 * the card owns its own `power_user` key and the value rides the outgoing request only while the
 * active connection is the bridge. '' = the bridge's own `config.yaml` default.
 */
export const EFFORT_KEY = 'kotatsu_bridge_effort';
/** @type {ReadonlyArray<readonly [string, string]>} */
export const EFFORTS = Object.freeze([
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max'],
]);

/**
 * Whether a Chat Completion custom URL is the bridge's own listener: a loopback host on the
 * listener's port. Pure.
 * @param {unknown} url `oai_settings.custom_url`
 * @param {string|null|undefined} listener `/health` `listener`, e.g. `http://127.0.0.1:5107/v1`
 * @returns {boolean}
 */
export function isBridgeUrl(url, listener) {
    if (typeof url !== 'string' || !url || !listener) return false;
    try {
        const a = new URL(url);
        const b = new URL(listener);
        const loopback = (/** @type {string} */ host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
        return loopback(a.hostname) && loopback(b.hostname) && (a.port || '80') === (b.port || '80');
    } catch {
        return false;
    }
}

/**
 * What one `/doctor` report means for the person at the keyboard: a toast to show, or null.
 * Pure, so the wording is tested without a server.
 * @param {any} doctor `/api/kotatsu/claude-bridge/doctor` JSON
 * @returns {{ level: 'warning'|'info'|'error', title: string, message: string } | null}
 */
export function describeDoctor(doctor) {
    if (!doctor || typeof doctor !== 'object') return null;
    if (doctor.standingDown) {
        return { level: 'error', title: 'Claude Code bridge isn’t running', message: String(doctor.standingDown) };
    }
    if (doctor.claudeCli && doctor.claudeCli.available === false) {
        return { level: 'warning', title: 'Claude Code isn’t installed', message: 'Kotatsu talks to Claude through the Claude Code app on this computer. Install it, run “claude auth login” in a terminal, then reload Kotatsu.' };
    }
    if (doctor.claudeAuth && doctor.claudeAuth.available !== false && doctor.claudeAuth.loggedIn === false) {
        return { level: 'warning', title: 'Claude Code isn’t signed in', message: 'Run “claude auth login” in a terminal on this computer, then send again.' };
    }
    if (doctor.restartRequired) {
        return { level: 'info', title: 'Restart Kotatsu to finish updating Claude Code', message: String(doctor.restartRequired) };
    }
    return null;
}

/** @type {any} */
let health = null;
/** @type {Promise<any>|null} */
let healthRequest = null;
/** @type {any} */
let doctor = null;
/** @type {Promise<any>|null} */
let doctorRequest = null;
let doctorCheckedAt = 0;
let installed = false;
let onBridge = false;
let autoConnectTried = false;

/** @returns {Promise<any>} The bridge's `/health`, fetched once per page. */
function loadHealth() {
    healthRequest ??= fetch('/api/kotatsu/claude-bridge/health')
        .then(response => (response.ok ? response.json() : null))
        .catch(() => null)
        .then((value) => {
            health = value;
            return value;
        });
    return healthRequest;
}

/** Announces fresh status to whoever is showing it. */
function announceStatus() {
    document.dispatchEvent(new CustomEvent(BRIDGE_STATUS_EVENT, { bubbles: true }));
}

/**
 * Re-fetches `/health` (Check again, after a restart).
 * @returns {Promise<any>}
 */
export function refreshHealth() {
    healthRequest = null;
    return loadHealth().then((value) => {
        render();
        announceStatus();
        return value;
    });
}

/** @returns {any} The last `/health` answer, or null. */
export function getHealth() {
    return health;
}

/**
 * `/doctor`, shared: the boot check and the card never spawn the CLI twice at once.
 * @param {boolean} [force] Ask again even if an answer is cached (Check again)
 * @returns {Promise<any>}
 */
export function loadDoctor(force = false) {
    if (force || (!doctorRequest && !doctor)) {
        doctorRequest = fetch('/api/kotatsu/claude-bridge/doctor')
            .then(response => response.json())
            .catch(() => null)
            .then((value) => {
                doctor = value;
                doctorCheckedAt = Date.now();
                doctorRequest = null;
                announceStatus();
                return value;
            });
    }
    return doctorRequest ?? Promise.resolve(doctor);
}

/** @returns {{ doctor: any, checkedAt: number, pending: boolean }} */
export function getDoctor() {
    return { doctor, checkedAt: doctorCheckedAt, pending: Boolean(doctorRequest) };
}

/**
 * Every problem one `/doctor` report holds, most blocking first, for the card. Pure.
 * @param {any} report `/doctor` JSON
 * @returns {Array<{ kind: 'standing-down'|'not-installed'|'not-signed-in'|'restart', detail: string }>}
 */
export function doctorProblems(report) {
    if (!report || typeof report !== 'object') return [];
    /** @type {Array<{ kind: 'standing-down'|'not-installed'|'not-signed-in'|'restart', detail: string }>} */
    const problems = [];
    if (report.standingDown) problems.push({ kind: 'standing-down', detail: String(report.standingDown) });
    if (report.claudeCli && report.claudeCli.available === false) problems.push({ kind: 'not-installed', detail: String(report.claudeCli.error ?? '') });
    else if (report.claudeAuth && report.claudeAuth.available !== false && report.claudeAuth.loggedIn === false) problems.push({ kind: 'not-signed-in', detail: '' });
    if (report.restartRequired) problems.push({ kind: 'restart', detail: String(report.restartRequired) });
    return problems;
}

/**
 * The pill beside the card's title: is Claude Code the connection Kotatsu will send through?
 * "In use" (green) promises an answer, so it is only said when Claude Code is on this computer.
 * Without it the connection is still the selected one, and the pill says only that. Pure.
 * @param {boolean} onBridge Whether the Claude Code connection is the selected one
 * @param {ReadonlyArray<{ kind: string }>} problems {@link doctorProblems}' answer
 * @returns {{ label: string, tone: 'success'|'' } | null}
 */
export function selectionPill(onBridge, problems) {
    if (!onBridge) return null;
    return problems.some(problem => problem.kind === 'not-installed')
        ? { label: 'Selected', tone: '' }
        : { label: 'In use', tone: 'success' };
}

/**
 * A model id as a person reads it: `claude-opus-5-5` → "Opus 5.5". Pure.
 * @param {string} id Model id
 * @returns {string}
 */
export function modelLabel(id) {
    const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(String(id));
    if (!match) return String(id);
    const [, family, major, minor] = match;
    return `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

/** @returns {string} The effort the card shows: a Claude effort, or '' for the bridge default. */
export function getBridgeEffort() {
    const value = /** @type {Record<string, unknown>} */ (power_user)[EFFORT_KEY];
    return typeof value === 'string' && EFFORTS.some(([id]) => id === value) ? value : '';
}

/**
 * @param {string} value A Claude effort, or '' for the bridge default
 * @returns {void}
 */
export function setBridgeEffort(value) {
    if (value !== '' && !EFFORTS.some(([id]) => id === value)) return;
    /** @type {Record<string, unknown>} */ (power_user)[EFFORT_KEY] = value;
    saveSettingsDebounced();
    announceStatus();
}

/** @returns {string} The model the active custom connection asks for. */
export function getBridgeModel() {
    return String(oai_settings?.custom_model ?? '');
}

/**
 * Picks a model through core's own controls, never around them: the custom model select when
 * the bridge's list has loaded, else the free-text model field. Both fire the events core binds.
 * @param {string} id Model id
 * @returns {void}
 */
export function setBridgeModel(id) {
    const select = document.getElementById('model_custom_select');
    if (select instanceof HTMLSelectElement && Array.from(select.options).some(option => option.value === id)) {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        const field = document.getElementById('custom_model_id');
        if (field instanceof HTMLInputElement) {
            field.value = id;
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    announceStatus();
}

/**
 * Presses core's Connect and resolves when core's own status check has finished, success or not.
 * The signal is core's: `startStatusLoading()` puts `disabled` on every `.api_button` and
 * `stopStatusLoading()` takes it off (script.js). A failed check never fires
 * ONLINE_STATUS_CHANGED when the status was already `no_connection`, so that event alone would
 * leave a card saying "Connecting…" forever (caught live, 2026-10-01). No loading within a beat
 * means Connect returned early (no key saved), which is also an answer.
 * @returns {Promise<void>}
 */
export function pressConnect() {
    const button = document.getElementById('api_button_openai');
    if (!button) return Promise.resolve();
    return new Promise((resolve) => {
        let sawLoading = false;
        const finish = () => {
            observer.disconnect();
            clearTimeout(quiet);
            clearTimeout(ceiling);
            resolve();
        };
        const observer = new MutationObserver(() => {
            if (button.classList.contains('disabled')) sawLoading = true;
            else if (sawLoading) finish();
        });
        observer.observe(button, { attributes: true, attributeFilter: ['class'] });
        const quiet = setTimeout(() => { if (!sawLoading) finish(); }, 1500);
        const ceiling = setTimeout(finish, 20000);
        button.click();
    });
}

/**
 * Applies a saved connection through the Connection Manager's own select and resolves once it
 * reports CONNECTION_PROFILE_LOADED (or gives up waiting). Picking the profile that is already
 * selected re-applies it: the extension's change handler doesn't compare.
 * @param {string} id Profile id
 * @returns {Promise<boolean>} false when the extension isn't there
 */
async function applyProfile(id) {
    const select = document.getElementById('connection_profiles');
    if (!(select instanceof HTMLSelectElement)) return false;
    const loaded = new Promise((resolve) => {
        const timer = setTimeout(() => done(), 12000);
        const done = () => {
            clearTimeout(timer);
            eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, done);
            resolve(undefined);
        };
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, done);
    });
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await loaded;
    return true;
}

/**
 * Switches to a saved connection and connects it (connections-v0 C3).
 * @param {string} id Profile id
 * @returns {Promise<void>}
 */
export async function useSavedConnection(id) {
    if (!await applyProfile(id)) return;
    await settleConnection();
}

/**
 * Applying a connection configures it; it does not always connect it (measured: source, URL and
 * profile all switched, and core never started a status check). Connect explicitly.
 * @returns {Promise<void>}
 */
async function settleConnection() {
    render();
    if (online_status === 'no_connection') await pressConnect();
}

/**
 * Points the active connection at a loopback bridge (the shared half of "Use Claude Code" and
 * "Use ChatGPT"). A saved connection that already points at the listener is applied through the
 * Connection Manager's own select (it carries the bridge token and the preset); with none, core's
 * own slash commands set API, URL and token, then connect.
 * @param {{ listener: string, secretId: string }} bridge The listener URL and the named secret that authenticates to it
 * @returns {Promise<void>}
 */
export async function connectToBridge({ listener, secretId }) {
    const profiles = /** @type {any[]} */ (extension_settings?.connectionManager?.profiles ?? []);
    const saved = profiles.find(profile => isBridgeUrl(profile?.['api-url'], listener));
    if (!saved || !await applyProfile(saved.id)) {
        const { executeSlashCommandsWithOptions } = await import('../../scripts/slash-commands.js');
        await executeSlashCommandsWithOptions(`/api custom | /api-url ${listener} | /secret-id ${secretId}`, { handleParserErrors: true, handleExecutionErrors: true });
    }
    await settleConnection();
}

/**
 * Makes Claude Code the active connection.
 * @returns {Promise<void>}
 */
export async function useClaudeCode() {
    await loadHealth();
    const listener = getBridgeListener();
    if (!listener) return;
    await connectToBridge({ listener, secretId: 'kotatsu-ccrp' });
}

/** Why the last `restartKotatsu()` returned false; '' after a success. */
let restartError = '';

/**
 * The reason the last `restartKotatsu()` failed, in words a person can act on.
 * @returns {string}
 */
export function getRestartError() {
    return restartError;
}

/**
 * Restarts Kotatsu under its launcher and reloads the page once it answers again (shared
 * `restartAndWait`). Only offered when `/health` says `supervised` — a hand-started server
 * would just stop. Resolves true only when the reload is under way; false when the restart was
 * refused OR the server never came back (see `getRestartError()` for which).
 * @returns {Promise<boolean>}
 */
export async function restartKotatsu() {
    restartError = '';
    const result = await restartAndWait({
        onState: (state, detail) => {
            if (state !== 'failed') return;
            restartError = detail === 'timeout'
                ? 'Kotatsu did not come back on its own. Start it again from the window or terminal you started it in (Start.bat).'
                : 'Kotatsu refused to restart. Restart it from the window or terminal you started it in.';
        },
    });
    return result === 'reloading';
}

/**
 * `power_user` key: a bridge port move waiting for the bridge to come up on its new port
 * (connections-v0 C4). `{ from, to }` listener URLs.
 */
export const PORT_MOVE_KEY = 'kotatsu_bridge_port_move';

/**
 * Saves bridge settings to config.yaml through the server's C4 route. Live keys apply to the
 * running bridge at once; the port waits for a restart (`/health.pendingRestart`).
 * @param {Record<string, any>} patch
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function saveBridgeSettings(patch) {
    const response = await fetch('/api/kotatsu/claude-bridge/settings', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(patch) }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!response?.ok || !body?.ok) {
        return { ok: false, error: String(body?.error ?? 'Kotatsu didn’t answer. Is it still running?') };
    }
    health = body.health;
    healthRequest = Promise.resolve(health);
    render();
    announceStatus();
    return { ok: true };
}

/**
 * Moves the bridge to another port: saves it, notes the move so saved connections follow once
 * the bridge is really listening there, and restarts Kotatsu when a launcher will bring it back.
 * Nothing is repointed before that — a connection aimed at a port nobody listens on yet would
 * strand a hand-started Kotatsu until its next start.
 * @param {number} port
 * @returns {Promise<{ ok: boolean, error?: string, restarting?: boolean }>}
 */
export async function moveBridgePort(port) {
    const from = getBridgeListener();
    const result = await saveBridgeSettings({ port });
    if (!result.ok) return result;
    if (from) {
        const to = new URL(from);
        to.port = String(port);
        /** @type {Record<string, unknown>} */ (power_user)[PORT_MOVE_KEY] = { from, to: to.toString() };
        await saveSettings();
    }
    if (!health?.supervised) return { ok: true, restarting: false };
    const restarting = await restartKotatsu();
    return restarting ? { ok: true, restarting: true } : { ok: false, error: getRestartError() };
}

/**
 * Where a URL that pointed at the old listener should point now, or null if it didn't. Pure.
 * @param {unknown} url
 * @param {{ from: string, to: string }} move
 * @returns {string|null}
 */
export function movedUrl(url, move) {
    if (!isBridgeUrl(url, move.from)) return null;
    const next = new URL(/** @type {string} */ (url));
    next.port = new URL(move.to).port;
    return next.toString().replace(/\/$/, '');
}

/**
 * Finishes a port move once the bridge is listening on its new port: saved connections and the
 * live URL that pointed at the old listener now point at the new one. Run at APP_READY, before
 * the first-run connect looks at whether the active connection is the bridge.
 * @returns {void}
 */
function finishPortMove() {
    const move = /** @type {any} */ (power_user)[PORT_MOVE_KEY];
    const listener = getBridgeListener();
    if (!move || typeof move.from !== 'string' || typeof move.to !== 'string' || !health?.listening || !listener) return;
    if (!isBridgeUrl(move.to, listener)) return; // not restarted yet, or moved again since
    const profiles = /** @type {any[]} */ (extension_settings?.connectionManager?.profiles ?? []);
    let moved = 0;
    for (const profile of profiles) {
        const next = movedUrl(profile?.['api-url'], move);
        if (next) {
            profile['api-url'] = next;
            moved++;
        }
    }
    const live = movedUrl(oai_settings?.custom_url, move);
    const field = document.getElementById('custom_api_url_text');
    if (live && field instanceof HTMLInputElement) {
        field.value = live;
        field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    delete /** @type {Record<string, unknown>} */ (power_user)[PORT_MOVE_KEY];
    console.info(`[Kotatsu] Claude Code bridge moved to ${listener}: ${moved} saved connection(s)${live ? ' and the active one' : ''} follow.`);
    saveSettingsDebounced();
}

/** @returns {string|null} The listener URL, once health is known. */
export function getBridgeListener() {
    return typeof health?.listener === 'string' ? health.listener : null;
}

/** @returns {boolean} Whether the active connection is the bridge right now. */
export function isOnBridge() {
    return onBridge;
}

/** Re-derives the answer, writes the attribute, and announces a change. */
function render() {
    const next = main_api === 'openai'
        && oai_settings?.chat_completion_source === 'custom'
        && isBridgeUrl(oai_settings.custom_url, getBridgeListener());
    const body = document.body;
    if (body) {
        if (next) body.dataset.kBridge = '';
        else delete body.dataset.kBridge;
    }
    if (next !== onBridge) {
        onBridge = next;
        document.dispatchEvent(new CustomEvent(BRIDGE_CHANGE_EVENT, { bubbles: true, detail: { onBridge: next } }));
    }
}

/**
 * @param {{ level: 'warning'|'info'|'error', title: string, message: string }} note
 * @returns {void}
 */
function toast(note) {
    const t = /** @type {any} */ (globalThis).toastr;
    if (!t) return;
    // The welcome tour's Connect step shows the doctor's findings itself, and a toast at 999999
    // would paint over the tour (onboarding v0 O2). A class, not an import: kotatsu → core only.
    if (document.body.classList.contains('k-onboarding-open')) return;
    t[note.level](note.message, note.title, { timeOut: 15000, extendedTimeOut: 10000, preventDuplicates: true });
}

/** Background `/doctor` check: one toast if something needs the person, else silence. */
async function checkDoctor() {
    const note = describeDoctor(await loadDoctor());
    if (note) toast(note);
}

/**
 * The effort rides the outgoing request only on the bridge: the card's value, or nothing so the
 * bridge's `config.yaml` default applies. Core's own Reasoning Effort is hidden there
 * (kotatsu-baggage.css), so there is exactly one knob.
 * @param {Record<string, any>} data `generate_data`, mutable by contract
 * @returns {void}
 */
function applyBridgeEffort(data) {
    if (!onBridge || !data || typeof data !== 'object') return;
    const effort = getBridgeEffort();
    if (effort) data.reasoning_effort = effort;
    else delete data.reasoning_effort;
}

/**
 * At most once per page: when the active connection is the bridge and nothing has connected,
 * connect — or, if the bridge stood down, say why instead.
 */
async function maybeAutoConnect() {
    if (autoConnectTried) return;
    await loadHealth();
    finishPortMove();
    render();
    if (!onBridge || online_status !== 'no_connection') return;
    autoConnectTried = true;
    if (!health?.ok || !health.listening) {
        toast(describeDoctor({ standingDown: health?.standingDown || 'The bridge is turned off in config.yaml (kotatsu.claudeBridge.enabled).' }) ?? { level: 'error', title: 'Claude Code bridge isn’t running', message: '' });
        return;
    }
    const button = document.getElementById('api_button_openai');
    if (button) button.click();
    void checkDoctor();
}

/**
 * Wires the detector, the first-run connect and the doctor check. Called once from the
 * `firstLoadInit()` seam (shell/index.js), before settings load.
 * @returns {void}
 */
export function installBridgeLink() {
    if (installed) return;
    installed = true;

    void loadHealth().then(render);
    // SETTINGS_LOADED fires before core has set `main_api`; SETTINGS_LOADED_AFTER and the first
    // ONLINE_STATUS_CHANGED are where the full picture first exists.
    for (const type of [
        event_types.SETTINGS_LOADED,
        event_types.SETTINGS_LOADED_AFTER,
        event_types.ONLINE_STATUS_CHANGED,
        event_types.MAIN_API_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.CONNECTION_PROFILE_LOADED,
    ]) {
        eventSource.on(type, render);
    }
    // The custom URL field saves on input with no core event of its own.
    for (const type of ['input', 'change']) {
        document.addEventListener(type, (event) => {
            if (event.target instanceof Element && event.target.matches('#custom_api_url_text, #main_api')) {
                queueMicrotask(render);
            }
        });
    }
    eventSource.on(event_types.APP_READY, () => void maybeAutoConnect());
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, applyBridgeEffort);
    render();
}

/**
 * The provider label the shell shows for the active API: "Claude Code" on the bridge, else
 * whatever core's own selects call it (resolved by the caller).
 * @returns {string|null} "Claude Code", or null when the caller should use core's label.
 */
export function bridgeProviderLabel() {
    let api = '';
    try {
        api = String(getGeneratingApi() ?? '');
    } catch {
        api = '';
    }
    if (api !== 'custom') return null;
    if (onBridge) return 'Claude Code';
    for (const label of extraProviderLabels) {
        const text = label();
        if (text) return text;
    }
    return null;
}

/** @type {Array<() => string|null>} */
const extraProviderLabels = [];

/**
 * Lets another Kotatsu bridge (the ChatGPT one) name itself in the model pill without bridge.js
 * knowing about it.
 * @param {() => string|null} label Returns the label while that bridge is the active connection
 * @returns {void}
 */
export function registerProviderLabel(label) {
    extraProviderLabels.push(label);
}
