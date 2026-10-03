/**
 * Kotatsu ↔ the built-in ChatGPT bridge, in the browser (docs/chatgpt-bridge-v0.md, slice C2).
 *
 * The bridge (src/endpoints/kotatsu/chatgpt-bridge/) answers through the person's own ChatGPT
 * plan and, to core, is Chat Completion → custom → a loopback URL, exactly like the Claude Code
 * bridge. This module is everything the frontend adds:
 *
 * - **Status, models, sign-in, disconnect** over `/api/kotatsu/chatgpt-bridge/*`.
 * - **`useChatGPT()`** points the active connection at the bridge through bridge.js's shared
 *   `connectToBridge()` (the same path "Use Claude Code" takes), then picks the model.
 * - **Is the active connection ChatGPT?** `isOnChatGPT()` matches `oai_settings.custom_url`
 *   against the listener `/status` reports (never a hardcoded port). The answer is written as
 *   `body[data-k-chatgpt]`, announced as `k-chatgpt-change`, and drives the pill label and the
 *   "Using ChatGPT plan · Manage usage" line above the composer that OpenAI's UI guidelines
 *   require (protocol §8).
 * - **The one-time first-sign-in note** (protocol §8): remembered in `accountStorage`.
 *
 * No content disclaimers of any kind: Kotatsu passes requests and replies through as they are.
 * One-way imports: kotatsu → core.
 */

import { getRequestHeaders, main_api } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings } from '../../scripts/openai.js';
import { accountStorage } from '../../scripts/util/AccountStorage.js';
import { connectToBridge, isBridgeUrl, registerProviderLabel, setBridgeModel } from './bridge.js';

const BASE = '/api/kotatsu/chatgpt-bridge';

/** Bubbling `document` event fired when the "active connection is ChatGPT" answer changes. */
export const CHATGPT_CHANGE_EVENT = 'k-chatgpt-change';
/** Bubbling `document` event fired when a fresh `/status` answer lands. */
export const CHATGPT_STATUS_EVENT = 'k-chatgpt-status';

/** `accountStorage` key: the one-time "You're using your ChatGPT plan" note was acknowledged. */
export const NOTE_KEY = 'kotatsu_chatgpt_plan_note';
/** Sign-in polling: every two seconds, for as long as the bridge's own attempt lives. */
export const POLL_INTERVAL_MS = 2000;
export const POLL_CEILING_MS = 10 * 60 * 1000;

/** OpenAI's required copy (protocol §8), word for word. */
export const COPY = Object.freeze({
    signInLabel: 'Continue with ChatGPT',
    signInLine: 'Use your ChatGPT Plus or Pro plan in Kotatsu.',
    noteHeadline: 'You’re using your ChatGPT plan',
    noteBody: 'Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings.',
    noteAction: 'Got it',
    indicator: 'Using ChatGPT plan',
    manageUsage: 'Manage usage',
    computerOnly: 'Sign in with ChatGPT on the computer Kotatsu runs on.',
});

/**
 * @typedef {object} ChatGPTStatus `/status`
 * @property {boolean} enabled
 * @property {boolean} listening
 * @property {number} port
 * @property {string} url Listener, e.g. `http://127.0.0.1:5108/v1`
 * @property {string|null} error
 * @property {boolean} signedIn
 * @property {{ label: string }|null} account
 * @property {boolean} planGranted
 * @property {boolean} loginPending
 * @property {string} secretId
 * @property {string} manageUsage
 * @property {boolean} supervised
 */

/**
 * Which face the card shows. Pure.
 * @param {{ status: ChatGPTStatus|null, computerOnly: boolean, waiting: boolean }} input
 * @returns {'loading'|'not-running'|'signed-out'|'plan-missing'|'waiting'|'computer-only'|'signed-in'}
 */
export function cardState({ status, computerOnly, waiting }) {
    if (!status) return 'loading';
    if (!status.enabled || !status.listening) return 'not-running';
    if (status.signedIn && status.planGranted) return 'signed-in';
    if (computerOnly) return 'computer-only';
    if (waiting) return 'waiting';
    return status.signedIn ? 'plan-missing' : 'signed-out';
}

/**
 * The plain words for a bridge that isn't running. Pure.
 * @param {ChatGPTStatus|null} status
 * @returns {string}
 */
export function notRunningText(status) {
    if (status?.error) return status.error;
    if (status && status.enabled === false) return 'The ChatGPT bridge is turned off (kotatsu.chatgptBridge.enabled: false in config.yaml).';
    return 'The ChatGPT bridge isn’t running. Restart Kotatsu, and check config.yaml under kotatsu.chatgptBridge if it stays down.';
}

/**
 * OpenAI's model list as the select wants it: `{ slug, name }`, names shown, slugs as values.
 * Drops anything without a slug, shows the slug when there is no name, keeps the first of a
 * repeated slug. Pure.
 * @param {any} body `/models` JSON
 * @returns {Array<{ slug: string, name: string }>}
 */
export function mapModels(body) {
    const list = Array.isArray(body?.models) ? body.models : [];
    /** @type {Array<{ slug: string, name: string }>} */
    const out = [];
    for (const entry of list) {
        const slug = typeof entry?.slug === 'string' ? entry.slug.trim() : '';
        if (!slug || out.some(model => model.slug === slug)) continue;
        const name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : slug;
        out.push({ slug, name });
    }
    return out;
}

/**
 * The model "Use ChatGPT" asks for: the one picked if it's listed, else the first listed. Pure.
 * @param {Array<{ slug: string }>} models
 * @param {string|null|undefined} picked
 * @returns {string} '' when nothing is listed
 */
export function chooseModel(models, picked) {
    if (picked && models.some(model => model.slug === picked)) return picked;
    return models[0]?.slug ?? '';
}

/**
 * Whether a Chat Completion custom URL is the ChatGPT bridge's listener. Pure.
 * @param {unknown} url `oai_settings.custom_url`
 * @param {string|null|undefined} listener `/status` `url`
 * @returns {boolean}
 */
export function isChatGPTUrl(url, listener) {
    return isBridgeUrl(url, listener);
}

/**
 * Whether this page is on the computer Kotatsu runs on, as far as the address says. The server
 * is the judge (login and logout answer 403 computer-only); this only saves a phone the trip.
 * Pure.
 * @param {string} hostname `location.hostname`
 * @returns {boolean}
 */
export function pageIsLocal(hostname) {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || hostname.endsWith('.localhost');
}

/**
 * What a stopped sign-in poll means. Pure.
 * @param {ChatGPTStatus|null} status
 * @param {{ sawPending: boolean }} seen
 * @returns {'signed-in'|'ended'|'waiting'}
 */
export function pollVerdict(status, seen) {
    if (status?.signedIn && status.planGranted) return 'signed-in';
    // The bridge's attempt lives ten minutes; once it's gone without a sign-in, nothing is coming.
    if (seen.sawPending && status && status.loginPending === false) return 'ended';
    return 'waiting';
}

/**
 * Polls `/status` until sign-in lands, ends, is cancelled, or the ceiling passes.
 * @param {object} options
 * @param {() => Promise<ChatGPTStatus|null>} options.fetchStatus
 * @param {AbortSignal} options.signal Cancel
 * @param {(status: ChatGPTStatus|null) => void} [options.onStatus]
 * @param {number} [options.interval]
 * @param {number} [options.ceiling]
 * @param {() => number} [options.now]
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [options.sleep]
 * @returns {Promise<'signed-in'|'ended'|'cancelled'|'timeout'>}
 */
export async function pollSignIn({ fetchStatus, signal, onStatus, interval = POLL_INTERVAL_MS, ceiling = POLL_CEILING_MS, now = Date.now, sleep = abortableSleep }) {
    const started = now();
    const seen = { sawPending: false };
    while (!signal.aborted) {
        await sleep(interval, signal);
        if (signal.aborted) break;
        const status = await fetchStatus();
        onStatus?.(status);
        if (status?.loginPending) seen.sawPending = true;
        const verdict = pollVerdict(status, seen);
        if (verdict !== 'waiting') return verdict;
        if (now() - started >= ceiling) return 'timeout';
    }
    return 'cancelled';
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done);
    });
}

/** @type {ChatGPTStatus|null} */
let status = null;
/** @type {Promise<ChatGPTStatus|null>|null} */
let statusRequest = null;
let onChatGPT = false;
let installed = false;
let computerOnlyLearned = false;

/** Announces fresh status to whoever is showing it. */
function announceStatus() {
    document.dispatchEvent(new CustomEvent(CHATGPT_STATUS_EVENT, { bubbles: true }));
}

/**
 * `/status`, fetched fresh (it is cheap and local) and remembered for the synchronous getters.
 * @returns {Promise<ChatGPTStatus|null>}
 */
export function fetchStatus() {
    statusRequest ??= fetch(`${BASE}/status`)
        .then(response => (response.ok ? response.json() : null))
        .catch(() => null)
        .then((value) => {
            statusRequest = null;
            status = value && typeof value === 'object' ? value : null;
            render();
            announceStatus();
            return status;
        });
    return statusRequest;
}

/** @returns {ChatGPTStatus|null} The last `/status`, or null. */
export function getStatus() {
    return status;
}

/** @returns {boolean} Whether the server has said sign-in must happen on the computer. */
export function isComputerOnly() {
    return computerOnlyLearned || (typeof location !== 'undefined' && !pageIsLocal(location.hostname));
}

/**
 * OpenAI's models for the signed-in account.
 * @returns {Promise<{ models: Array<{ slug: string, name: string }>, error: string }>}
 */
export async function fetchModels() {
    try {
        const response = await fetch(`${BASE}/models`);
        const body = await response.json().catch(() => null);
        if (!response.ok) return { models: [], error: String(body?.error?.message ?? body?.message ?? body?.error ?? 'ChatGPT didn’t list its models.') };
        return { models: mapModels(body), error: '' };
    } catch {
        return { models: [], error: 'Kotatsu didn’t answer. Is it still running?' };
    }
}

/**
 * Asks the server for the "Continue with ChatGPT" authorize URL and opens it in a new tab.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, computerOnly?: boolean }>}
 */
export async function startSignIn() {
    const response = await fetch(`${BASE}/login`, { method: 'POST', headers: getRequestHeaders(), body: '{}' }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (!response?.ok || typeof body?.url !== 'string') {
        if (response?.status === 403 && body?.error === 'computer-only') {
            computerOnlyLearned = true;
            return { ok: false, computerOnly: true, error: COPY.computerOnly };
        }
        return { ok: false, error: String(body?.message ?? body?.error ?? 'Kotatsu didn’t answer. Is it still running?') };
    }
    window.open(body.url, '_blank', 'noopener');
    return { ok: true };
}

/**
 * Disconnects: revokes the refresh token and clears the account.
 * @returns {Promise<{ ok: boolean, error?: string, computerOnly?: boolean }>}
 */
export async function signOut() {
    const response = await fetch(`${BASE}/logout`, { method: 'POST', headers: getRequestHeaders(), body: '{}' }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (response?.status === 403 && body?.error === 'computer-only') {
        computerOnlyLearned = true;
        return { ok: false, computerOnly: true, error: String(body?.message ?? 'Disconnect ChatGPT on the computer Kotatsu runs on.') };
    }
    if (!response?.ok || !body?.ok) return { ok: false, error: String(body?.message ?? body?.error ?? 'Kotatsu didn’t answer. Is it still running?') };
    if (body.status && typeof body.status === 'object') status = body.status;
    render();
    announceStatus();
    return { ok: true };
}

/**
 * Makes ChatGPT the active connection: custom source, the bridge's URL, the named secret, then
 * the model (the one asked for, else the first the bridge lists).
 * @param {string} [model] A model slug
 * @returns {Promise<void>}
 */
export async function useChatGPT(model = '') {
    const current = await fetchStatus();
    if (!current?.listening || !current.url) return;
    await connectToBridge({ listener: current.url, secretId: current.secretId || 'kotatsu-chatgpt' });
    let slug = model;
    if (!slug) {
        const listed = await fetchModels();
        slug = chooseModel(listed.models, '');
    }
    if (slug) setBridgeModel(slug);
    render();
}

/** @returns {boolean} Whether the active connection is the ChatGPT bridge right now. */
export function isOnChatGPT() {
    return onChatGPT;
}

/** Re-derives the answer, writes the attribute, and announces a change. */
function render() {
    const next = main_api === 'openai'
        && oai_settings?.chat_completion_source === 'custom'
        && isChatGPTUrl(oai_settings.custom_url, status?.url);
    const body = document.body;
    if (body) {
        if (next) body.dataset.kChatgpt = '';
        else delete body.dataset.kChatgpt;
    }
    if (next !== onChatGPT) {
        onChatGPT = next;
        document.dispatchEvent(new CustomEvent(CHATGPT_CHANGE_EVENT, { bubbles: true, detail: { onChatGPT: next } }));
    }
    updateIndicator();
}

/** @returns {boolean} Whether the one-time "You're using your ChatGPT plan" note is still owed. */
export function noteOwed() {
    try {
        return accountStorage.getItem(NOTE_KEY) !== '1';
    } catch {
        return false;
    }
}

/** The note was shown and acknowledged; never again. @returns {void} */
export function markNoteSeen() {
    try {
        accountStorage.setItem(NOTE_KEY, '1');
    } catch {
        // Nowhere to remember it: showing it again is the safe failure.
    }
}

/** @type {HTMLElement|null} */
let indicator = null;

/** @returns {HTMLElement|null} */
function ensureIndicator() {
    const form = document.getElementById('send_form');
    if (!form?.parentElement) return null;
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'k-gc-using';
        indicator.setAttribute('role', 'status');
        indicator.innerHTML = '<span class="k-gc-using__text"></span><span class="k-gc-using__sep" aria-hidden="true">·</span><a class="k-gc-using__link" target="_blank" rel="noopener"></a>';
        const text = indicator.querySelector('.k-gc-using__text');
        const link = indicator.querySelector('.k-gc-using__link');
        if (text) text.textContent = COPY.indicator;
        if (link instanceof HTMLAnchorElement) {
            link.textContent = COPY.manageUsage;
            link.href = 'https://chatgpt.com/settings/usage';
        }
    }
    if (indicator.nextElementSibling !== form) form.before(indicator);
    return indicator;
}

/** Shows the persistent "Using ChatGPT plan · Manage usage" line while ChatGPT is the connection. */
function updateIndicator() {
    const node = onChatGPT ? ensureIndicator() : indicator;
    if (!node) return;
    node.hidden = !onChatGPT;
    const link = node.querySelector('.k-gc-using__link');
    if (link instanceof HTMLAnchorElement && status?.manageUsage) link.href = status.manageUsage;
}

/**
 * Wires the detector, the pill label and the indicator. Idempotent; called from the Connection
 * card's mount and the composer-reason install, both on the boot path.
 * @returns {void}
 */
export function installChatGPTLink() {
    if (installed) return;
    installed = true;
    registerProviderLabel(() => (onChatGPT ? 'ChatGPT' : null));
    void fetchStatus();
    for (const type of [
        event_types.SETTINGS_LOADED,
        event_types.SETTINGS_LOADED_AFTER,
        event_types.ONLINE_STATUS_CHANGED,
        event_types.MAIN_API_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.CONNECTION_PROFILE_LOADED,
        event_types.APP_READY,
    ]) {
        if (typeof type === 'string') eventSource.on(type, render);
    }
    for (const type of ['input', 'change']) {
        document.addEventListener(type, (event) => {
            if (event.target instanceof Element && event.target.matches('#custom_api_url_text, #main_api')) queueMicrotask(render);
        });
    }
    render();
}
