/**
 * Reconnects a local or LAN server at startup, when it is the connection that was used last.
 *
 * Core's own auto-connect (RossAscends-mods.js `RA_autoconnect`) is off by default, so someone
 * on Ollama, KoboldCpp or LM Studio came back to "not connected" and a hidden Send after every
 * reload (Reddit report, 2026-10-14). A server on this computer or this network costs nothing to
 * ask and needs no key, so Kotatsu presses core's own Connect for it once at APP_READY, the way
 * bridge.js already does for Claude Code. Hosted APIs keep core's opt-in setting; the bridges
 * keep their own startup path.
 *
 * One-way imports: kotatsu → core.
 */

import { main_api, online_status } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { extension_settings } from '../../scripts/extensions.js';
import { oai_settings } from '../../scripts/openai.js';
import { power_user } from '../../scripts/power-user.js';
import { getTextGenServer, textgenerationwebui_settings } from '../../scripts/textgen-settings.js';
import { getBridgeListener, isKotatsuBridgeUrl } from './bridge.js';
import { getStatus as getChatGPTStatus } from './chatgpt.js';
import { LOCAL_TEXTGEN_TYPES } from './saved.js';

/**
 * Whether a server URL is on this computer or this network: loopback, private IPv4 ranges,
 * link-local, the CGNAT range Tailscale hands out, and the names local networks use. Pure.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isLocalServerUrl(url) {
    if (typeof url !== 'string' || !url.trim()) return false;
    let host;
    try {
        host = new URL(url.trim()).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (host === 'localhost' || host === '[::1]' || host.endsWith('.localhost')) return true;
    if (/\.(local|lan|home\.arpa|internal|ts\.net)$/.test(host)) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!v4) return false;
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 169 && b === 254)
        || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Which Connect button to press for the connection that was used last, or null. Pure.
 * @param {{ mainApi: string, source: string, customUrl: unknown, textgenType: string, textgenUrl: unknown, isBridge: boolean }} facts
 * @returns {'api_button_openai'|'api_button_textgenerationwebui'|null}
 */
export function localConnectButton({ mainApi, source, customUrl, textgenType, textgenUrl, isBridge }) {
    if (mainApi === 'openai' && source === 'custom' && !isBridge && isLocalServerUrl(customUrl)) return 'api_button_openai';
    if (mainApi === 'textgenerationwebui' && LOCAL_TEXTGEN_TYPES.includes(textgenType) && isLocalServerUrl(textgenUrl)) return 'api_button_textgenerationwebui';
    return null;
}

let installed = false;

/** Presses Connect once, when the last connection is a local server and nothing connected yet. */
function maybeConnectLocal() {
    if (online_status !== 'no_connection' || power_user.auto_connect) return;
    const profiles = /** @type {any[]} */ (extension_settings?.connectionManager?.profiles ?? []);
    const button = localConnectButton({
        mainApi: String(main_api ?? ''),
        source: String(oai_settings?.chat_completion_source ?? ''),
        customUrl: oai_settings?.custom_url,
        textgenType: String(textgenerationwebui_settings?.type ?? ''),
        textgenUrl: getTextGenServer(),
        isBridge: isKotatsuBridgeUrl(oai_settings?.custom_url, [getBridgeListener(), getChatGPTStatus()?.url], profiles),
    });
    if (button) document.getElementById(button)?.click();
}

/**
 * Wires the startup reconnect. Called once from the `firstLoadInit()` seam (shell/index.js).
 * @returns {void}
 */
export function installLocalAutoConnect() {
    if (installed) return;
    installed = true;
    eventSource.once(event_types.APP_READY, maybeConnectLocal);
}
