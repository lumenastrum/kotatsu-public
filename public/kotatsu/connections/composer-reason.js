/**
 * The composer says why Claude Code isn't ready (docs/connections-v0.md, artboard 3, first run).
 *
 * Core's composer knows one sentence for every failure: "Not connected to API!". When the active
 * connection is the Claude Code bridge, Kotatsu knows the real reason — the bridge stood down,
 * Claude Code isn't installed, or it isn't signed in — and says it in two places:
 *
 * - **The placeholder.** Core rewrites `#send_textarea`'s placeholder from the textarea's own
 *   `no_connection_text` / `connected_text` attributes on every status check
 *   (RossAscends-mods.js `RA_checkOnlineStatus`). While there is a reason, both attributes carry
 *   it; when it clears, the originals come back. No core edit, and core stays the only writer of
 *   the placeholder's timing.
 * - **A strip above the composer** with the reason and "How to fix", which opens the Connection
 *   tab, where the Claude Code card shows the fix (the command to copy, Use port N, …). A
 *   placeholder can't hold a button.
 *
 * "Not signed in" is shown even while core reports a connection: the bridge's model list comes
 * from `/health`, which needs no login, so the status check passes and the first send would fail.
 *
 * One-way imports: kotatsu → core.
 */

import { online_status } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { BRIDGE_CHANGE_EVENT, BRIDGE_STATUS_EVENT, doctorProblems, getDoctor, getHealth, isOnBridge, loadDoctor } from './bridge.js';

/** Stashed originals of the textarea's two placeholder attributes. */
const ORIGINAL = Object.freeze({ no: 'kOriginalNoConnectionText', yes: 'kOriginalConnectedText' });

/**
 * Why the bridge can't answer, in the composer's words, or null when it can (or when the active
 * connection isn't the bridge). Pure.
 * @param {{ onBridge: boolean, health: any, doctor: any, online: string }} state
 * @returns {{ text: string, kind: string } | null}
 */
export function composerReason({ onBridge, health, doctor, online }) {
    if (!onBridge || !health) return null;
    if (health.enabled === false) return { kind: 'disabled', text: 'Claude Code is turned off in config.yaml.' };
    if (health.standingDown || health.listening === false) {
        const detail = String(health.standingDown ?? '');
        return /EADDRINUSE|already in use/i.test(detail)
            ? { kind: 'port', text: 'Something else is using Claude Code’s port.' }
            : { kind: 'standing-down', text: 'The Claude Code bridge isn’t running.' };
    }
    const problem = doctorProblems(doctor).find(p => p.kind === 'not-installed' || p.kind === 'not-signed-in');
    // Claude Code is optional (v0.2.3), so its absence is an invitation, not a fault to fix.
    if (problem?.kind === 'not-installed') return { kind: 'not-installed', text: 'Connect a model to start writing. Claude Code isn’t on this computer.' };
    if (problem?.kind === 'not-signed-in') return { kind: 'not-signed-in', text: 'Claude Code isn’t signed in.' };
    if (online === 'no_connection') return { kind: 'connecting', text: 'Connecting to Claude Code…' };
    return null;
}

/**
 * What the strip's button says. Both open the Connection tab; with no Claude Code there is
 * nothing to fix, only a connection to pick. Pure.
 * @param {string} kind A {@link composerReason} kind
 * @returns {string}
 */
export function fixLabel(kind) {
    return kind === 'not-installed' ? 'Connect a model' : 'How to fix';
}

let installed = false;
/** @type {HTMLElement|null} */
let strip = null;
let current = '';

/** @returns {HTMLElement|null} */
function ensureStrip() {
    const form = document.getElementById('send_form');
    if (!form?.parentElement) return null;
    if (!strip) {
        strip = document.createElement('div');
        strip.className = 'k-composer-reason';
        strip.setAttribute('role', 'status');
        strip.innerHTML = '<span class="k-composer-reason__text"></span><button type="button" class="k-composer-reason__fix">How to fix</button>';
        strip.querySelector('button')?.addEventListener('click', async () => {
            const { openSettings } = await import('../settings/k-settings-modal.js');
            openSettings({ tab: 'connection' });
        });
    }
    if (strip.nextElementSibling !== form) form.before(strip);
    return strip;
}

/** Re-derives the reason and paints it into the placeholder and the strip. */
function update() {
    const reason = composerReason({ onBridge: isOnBridge(), health: getHealth(), doctor: getDoctor().doctor, online: String(online_status ?? '') });
    const textarea = document.getElementById('send_textarea');
    if (textarea instanceof HTMLTextAreaElement) {
        const data = textarea.dataset;
        if (reason) {
            data[ORIGINAL.no] ??= textarea.getAttribute('no_connection_text') ?? '';
            data[ORIGINAL.yes] ??= textarea.getAttribute('connected_text') ?? '';
            textarea.setAttribute('no_connection_text', reason.text);
            if (reason.kind !== 'connecting') textarea.setAttribute('connected_text', reason.text);
            textarea.placeholder = reason.kind === 'connecting' && online_status !== 'no_connection' ? data[ORIGINAL.yes] ?? '' : reason.text;
        } else if (data[ORIGINAL.no] !== undefined) {
            textarea.setAttribute('no_connection_text', data[ORIGINAL.no] ?? '');
            textarea.setAttribute('connected_text', data[ORIGINAL.yes] ?? '');
            textarea.placeholder = online_status === 'no_connection' ? data[ORIGINAL.no] ?? '' : data[ORIGINAL.yes] ?? '';
            delete data[ORIGINAL.no];
            delete data[ORIGINAL.yes];
        }
    }
    // "Connecting…" is a moment, not a problem: placeholder only, no strip.
    const show = reason && reason.kind !== 'connecting' ? reason : null;
    const node = show ? ensureStrip() : strip;
    if (!node) return;
    node.hidden = !show;
    node.dataset.kind = show?.kind ?? '';
    const fix = node.querySelector('.k-composer-reason__fix');
    if (fix && show) fix.textContent = fixLabel(show.kind);
    const text = node.querySelector('.k-composer-reason__text');
    if (text && show && current !== show.text) text.textContent = show.text;
    current = show?.text ?? '';
}

/**
 * Wires the composer reason. Called once from the `firstLoadInit()` seam (shell/index.js).
 * @returns {void}
 */
export function installComposerReason() {
    if (installed) return;
    installed = true;
    document.addEventListener(BRIDGE_STATUS_EVENT, update);
    document.addEventListener(BRIDGE_CHANGE_EVENT, update);
    for (const type of [event_types.ONLINE_STATUS_CHANGED, event_types.APP_READY]) {
        if (typeof type === 'string') eventSource.on(type, update);
    }
    // On the bridge but not connected and no diagnosis yet: ask the doctor once, so the composer
    // can say why instead of "Connecting…" forever. It's off the boot path (APP_READY + a beat).
    eventSource.on(event_types.APP_READY, () => {
        setTimeout(() => {
            if (isOnBridge() && online_status === 'no_connection' && !getDoctor().doctor && !getDoctor().pending) void loadDoctor();
        }, 4000);
    });
}
