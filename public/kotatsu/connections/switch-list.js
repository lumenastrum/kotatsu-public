/**
 * The rows of the top bar's "Switch to" list, and what pressing one does.
 *
 * Saved connections used to be the only picks, so a provider someone connects to with a key, or a
 * local server, was only ever reachable through "All connections". Now the list holds:
 *   - every saved connection;
 *   - every API key on file, unless a saved connection already goes to that provider;
 *   - Claude Code, when its bridge is up and nothing saved goes to it;
 *   - ChatGPT and the "more ways" (local servers, aggregators), once they have been used.
 * Newest use first (recent-order.js). A key on file is a pick from the start, with no history.
 *
 * Use is recorded when core reports a live connection, in `power_user.kotatsu_connections_recent`,
 * so it follows the user across devices. It holds ids and server URLs, never a key.
 */

import { online_status, saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings } from '../../scripts/openai.js';
import { power_user } from '../../scripts/power-user.js';
import { getHealth, isOnBridge, modelLabel, pressConnect, useClaudeCode } from './bridge.js';
import { isOnChatGPT, useChatGPT } from './chatgpt.js';
import { FIRST_PARTY, applyWay } from './k-connection-more.js';
import { connectProvider, hasKey, modelOf } from './k-provider-cards.js';
import { PROVIDERS } from './providers.js';
import { rankByRecent, rememberRecent } from './recent-order.js';
import { currentWays, hostOf, isCurrentWay, liveConnection, savedConnections } from './saved.js';

/** @typedef {import('./recent-order.js').RecentEntry} RecentEntry */

/**
 * @typedef {object} SwitchRow
 * @property {string} id `profile:<id>`, `key:<source>`, `way:<way id>`, `bridge` or `chatgpt`
 * @property {string} name
 * @property {string} micro The plain line under the name
 * @property {boolean} inUse The live connection is this one
 */

/** `power_user` key: the connections used, newest first. */
export const RECENT_KEY = 'kotatsu_connections_recent';

const NO_CONNECTION = 'no_connection';

let installed = false;

/** @returns {RecentEntry[]} */
function recentEntries() {
    const stored = /** @type {Record<string, unknown>} */ (power_user)[RECENT_KEY];
    return Array.isArray(stored) ? stored.filter(entry => typeof entry?.id === 'string') : [];
}

/** @returns {import('./saved.js').Way[]} Every way that is not a first-party provider. */
function allWays() {
    const { local, others } = currentWays(FIRST_PARTY);
    return [...local, ...others];
}

/** @returns {RecentEntry|null} What the live connection is, as a row's id. */
function liveEntry() {
    const profile = savedConnections().find(saved => saved.inUse);
    if (profile) return { id: `profile:${profile.id}` };
    if (isOnChatGPT()) return { id: 'chatgpt' };
    if (isOnBridge()) return { id: 'bridge' };
    const live = liveConnection();
    if (live.selected === 'openai' && PROVIDERS.some(provider => provider.source === live.source)) return { id: `key:${live.source}` };
    const way = allWays().find(isCurrentWay);
    return way ? { id: `way:${way.id}`, url: live.url || undefined } : null;
}

/** Records the live connection, when there is one and it is news. @returns {void} */
function record() {
    if (!online_status || online_status === NO_CONNECTION) return;
    const entry = liveEntry();
    if (!entry) return;
    const recent = recentEntries();
    if (recent[0]?.id === entry.id && recent[0]?.url === entry.url) return;
    /** @type {Record<string, unknown>} */ (power_user)[RECENT_KEY] = rememberRecent(recent, entry);
    saveSettingsDebounced();
}

/** Starts recording. Once. @returns {void} */
export function installRecents() {
    if (installed) return;
    installed = true;
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, record);
    record();
}

/** @returns {SwitchRow[]} The list, newest use first. */
export function switchRows() {
    const recent = recentEntries();
    const saved = savedConnections();
    const used = new Set(recent.map(entry => entry.id));
    /** @type {SwitchRow[]} */
    const rows = [];

    const onBridge = isOnBridge();
    if ((onBridge || getHealth()?.listening) && !saved.some(connection => connection.bridge)) {
        rows.push({ id: 'bridge', name: 'Claude Code', micro: 'Your Claude subscription, built in', inUse: onBridge });
    }
    for (const connection of saved) {
        rows.push({ id: `profile:${connection.id}`, name: connection.name, micro: connection.detail, inUse: connection.inUse });
    }
    const live = liveConnection();
    const anyProfileInUse = saved.some(connection => connection.inUse);
    for (const provider of PROVIDERS) {
        if (!hasKey(provider.secret) || saved.some(connection => connection.source === provider.source)) continue;
        const model = modelOf(provider);
        rows.push({
            id: `key:${provider.source}`,
            name: provider.name,
            micro: model ? modelLabel(model) : 'Your API key',
            inUse: !anyProfileInUse && !onBridge && !isOnChatGPT() && live.selected === 'openai' && live.source === provider.source,
        });
    }
    if (isOnChatGPT() || used.has('chatgpt')) {
        rows.push({ id: 'chatgpt', name: 'ChatGPT', micro: 'Your ChatGPT plan, built in', inUse: isOnChatGPT() });
    }
    const liveId = liveEntry()?.id;
    for (const way of allWays()) {
        const id = `way:${way.id}`;
        if (!used.has(id) && liveId !== id) continue;
        const url = recent.find(entry => entry.id === id)?.url;
        rows.push({ id, name: way.name, micro: hostOf(url) || way.note || 'Last used here', inUse: liveId === id });
    }
    return rankByRecent(rows, recent);
}

/**
 * Switches to a row that is not a saved connection, through the same calls the Connection tab uses.
 * @param {string} id The row's id.
 * @returns {Promise<void>}
 */
export async function useRow(id) {
    if (id === 'bridge') {
        await useClaudeCode();
        return;
    }
    if (id === 'chatgpt') {
        await useChatGPT();
        return;
    }
    if (id.startsWith('key:')) {
        const provider = PROVIDERS.find(candidate => `key:${candidate.source}` === id);
        if (provider) await connectProvider(provider);
        return;
    }
    const way = allWays().find(candidate => `way:${candidate.id}` === id);
    if (!way) return;
    applyWay(way);
    // Claude Code and ChatGPT ride the custom lane too and leave their own address in it, so the
    // local server someone was on is put back from what was remembered.
    const url = recentEntries().find(entry => entry.id === id)?.url;
    if (way.source === 'custom' && url && oai_settings?.custom_url !== url) {
        const field = document.getElementById('custom_api_url_text');
        if (field instanceof HTMLInputElement) {
            field.value = url;
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    await pressConnect();
}
