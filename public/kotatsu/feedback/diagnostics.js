/**
 * What Send feedback can say about this install (docs/feedback-v0.md). Gathers the facts
 * report.js turns into the diagnostics block. Cheap and local: one call to Kotatsu's own version
 * route, nothing that spawns the `claude` CLI (the doctor's last answer is used only if something
 * already asked), and nothing from the chat, no names, no keys.
 */

import { main_api, online_status } from '../../script.js';
import { oai_settings } from '../../scripts/openai.js';
import { getBridgeModel, getDoctor, isOnBridge, modelLabel } from '../connections/bridge.js';
import { isOnChatGPT } from '../connections/chatgpt.js';
import { PROVIDERS } from '../connections/providers.js';
import { describeAgent } from './report.js';

/** How many recent page errors a report may carry. */
const KEEP_ERRORS = 5;

/** @type {string[]} The last errors this page saw, newest last. */
const errors = [];
let listening = false;

/**
 * One error as a line: its message and where it was thrown, no stack (a stack carries paths of
 * the person's machine and is long; the file and line are what a maintainer needs first).
 * @param {unknown} message
 * @param {string} [file]
 * @param {number} [line]
 * @returns {string}
 */
function errorLine(message, file = '', line = 0) {
    const text = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Unknown error';
    const where = file ? `${String(file).split(/[?#]/)[0].split('/').pop()}${line ? `:${line}` : ''}` : '';
    return where ? `${text} (${where})` : text;
}

/** @param {string} entry */
function remember(entry) {
    if (errors[errors.length - 1] === entry) return;
    errors.push(entry);
    if (errors.length > KEEP_ERRORS) errors.shift();
}

/**
 * Starts keeping the last few page errors, for reports. Once, at the shell seam.
 * @returns {void}
 */
export function listenForErrors() {
    if (listening) return;
    listening = true;
    window.addEventListener('error', (event) => {
        if (event.error || event.message) remember(errorLine(event.message || event.error, event.filename, event.lineno));
    });
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        remember(errorLine(reason instanceof Error ? `${reason.name}: ${reason.message}` : reason));
    });
}

/** @returns {Promise<string>} Kotatsu's version, '' when the server can't say. */
async function version() {
    try {
        const response = await fetch('/api/kotatsu/update/version', { cache: 'no-store' });
        if (!response.ok) return '';
        const data = await response.json();
        return typeof data?.kotatsuVersion === 'string' ? data.kotatsuVersion : '';
    } catch {
        return '';
    }
}

/** @returns {string} What answers the chat, in words. Never a key, never a URL. */
function connection() {
    if (isOnBridge()) {
        const model = getBridgeModel();
        return `Claude Code${model ? ` · ${modelLabel(model)}` : ''}`;
    }
    if (isOnChatGPT()) return 'ChatGPT plan';
    if (main_api === 'openai') {
        const source = String(oai_settings?.chat_completion_source ?? '');
        const provider = PROVIDERS.find(entry => entry.source === source);
        // A custom or local endpoint is described by its kind only: its URL may name a private host.
        const name = provider?.name ?? (source === 'custom' ? 'Custom endpoint' : source);
        const model = provider ? String(/** @type {Record<string, unknown>} */ (oai_settings ?? {})[provider.modelKey] ?? '') : '';
        return `${name || 'Chat completion'}${model ? ` · ${model}` : ''}`;
    }
    return main_api ? String(main_api) : '';
}

/** @returns {string} The doctor's last word on Claude Code, '' when it was never asked. */
function claudeCode() {
    const doctor = getDoctor().doctor;
    if (!doctor || typeof doctor !== 'object') return '';
    if (doctor.claudeCli?.available === false) return 'not installed';
    const version = doctor.claudeCli?.version ? ` (${String(doctor.claudeCli.version).replace(/\s*\(.*\)$/, '')})` : '';
    const auth = doctor.claudeAuth?.loggedIn === true ? 'signed in' : doctor.claudeAuth?.loggedIn === false ? 'not signed in' : 'sign-in unknown';
    return `installed${version}, ${auth}${doctor.standingDown ? ', bridge not running' : ''}`;
}

/**
 * Everything the diagnostics block says, gathered now.
 * @returns {Promise<import('./report.js').DiagnosticFacts>}
 */
export async function gatherFacts() {
    const kotatsu = /** @type {any} */ (window).kotatsu;
    return {
        version: await version(),
        agent: describeAgent(navigator.userAgent),
        screen: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
        layout: document.body.dataset.kLayout ?? '',
        pack: String(kotatsu?.theme?.current?.() ?? ''),
        look: document.getElementById('chat')?.dataset.kMesVariant ?? '',
        connection: connection(),
        connected: Boolean(online_status) && online_status !== 'no_connection',
        claudeCode: claudeCode(),
        errors: [...errors],
    };
}
