/**
 * Saved connections and "More ways to connect" — the logic behind `<k-connection-more>`
 * (docs/connections-v0.md, slice C3). Also feeds the topbar model menu's profile list.
 *
 * A saved connection IS a Connection Manager profile, same data shape (`extension_settings.
 * connectionManager.profiles`); nothing here writes one. Two things are new:
 *
 * - **"In use" means in use.** The Connection Manager's `selectedProfile` only says which profile
 *   was last picked; change the model or source by hand and its check mark stays put (the drift
 *   §0.7 names). `profileMatches()` compares a profile to the live connection — API, server URL,
 *   model — so a profile is in use only while the settings actually are its settings.
 * - **Plain names.** `describeProfile()` turns `custom · claude-sonnet-4-6 · Clio's Sparkle Sauce
 *   v1` into "Claude Code · Sonnet 4.6": the bridge by its listener, first-party providers by
 *   name, everything else by the label core's own select gives it.
 *
 * The pure functions take what they need as arguments so the tests pin them without a page.
 * One-way imports: kotatsu → core.
 */

import { DOMPurify } from '../../lib.js';
import { main_api, saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { extension_settings } from '../../scripts/extensions.js';
import { getChatCompletionModel, oai_settings } from '../../scripts/openai.js';
import { CONNECT_API_MAP } from '../../scripts/slash-commands.js';
import { getTextGenModel, getTextGenServer, SERVER_INPUTS, textgenerationwebui_settings } from '../../scripts/textgen-settings.js';
import { getBridgeListener, isBridgeUrl, modelLabel } from './bridge.js';
import { PROVIDER_NAMES } from './providers.js';

/**
 * @typedef {object} ApiTarget What one `/api` name selects (`CONNECT_API_MAP` entry shape)
 * @property {string} selected `main_api` value
 * @property {string} [source] Chat Completion source
 * @property {string} [type] Text Completion type
 */

/**
 * @typedef {object} LiveConnection The connection core has right now
 * @property {string} selected `main_api`
 * @property {string} [source] Chat Completion source
 * @property {string} [type] Text Completion type
 * @property {string} [url] Server URL, where the API has one
 * @property {string} [model] Model id, where the API has one
 */

/** The stock APIs that are neither Chat nor Text Completion, by `main_api`. */
const MAIN_API_NAMES = Object.freeze({
    novel: 'NovelAI',
    koboldhorde: 'AI Horde',
    kobold: 'KoboldAI Classic',
});

/**
 * Text Completion types that run on your own machine or server. Everything else in core's
 * `#textgen_type` is a hosted service and goes under "Other providers & aggregators".
 */
export const LOCAL_TEXTGEN_TYPES = Object.freeze(['ollama', 'llamacpp', 'koboldcpp', 'ooba', 'tabby', 'vllm', 'aphrodite', 'generic']);

/**
 * A URL as a person reads it: `http://127.0.0.1:5001/api` → "127.0.0.1:5001". Pure.
 * @param {unknown} url
 * @returns {string}
 */
export function hostOf(url) {
    if (typeof url !== 'string' || !url) return '';
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/**
 * Two server URLs point at the same place: loopback spellings are one host, a trailing slash
 * and letter case don't count. Pure.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameServer(a, b) {
    /** @param {string} url */
    const norm = (url) => {
        try {
            const parsed = new URL(url.trim());
            const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
            const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
            return `${loopback ? 'loopback' : parsed.hostname.toLowerCase()}:${port}${parsed.pathname.replace(/\/+$/, '')}`;
        } catch {
            return url.trim().replace(/\/+$/, '').toLowerCase();
        }
    };
    return norm(a) === norm(b);
}

/**
 * Whether a saved connection talks to the same API as the live connection — the same source or
 * server type — whatever its URL or model. A selected profile that does but no longer matches has
 * drifted (Update makes sense); one on another API simply isn't in use (Update would overwrite it
 * with a different API's settings). Pure.
 * @param {any} profile Connection Manager profile
 * @param {LiveConnection} live
 * @param {Record<string, ApiTarget>} apiMap `CONNECT_API_MAP`
 * @returns {boolean}
 */
export function sameApi(profile, live, apiMap) {
    if (!profile || typeof profile.api !== 'string' || !live) return false;
    const target = apiMap[profile.api.toLowerCase()];
    if (!target || target.selected !== live.selected) return false;
    if (target.source && target.source !== live.source) return false;
    if (target.type && target.type !== live.type) return false;
    return true;
}

/**
 * Whether a saved connection is the live one: the same API, and — where the profile pins them
 * — the same server and model. A field core can't report yet (a model list still loading)
 * doesn't count against it. Pure.
 * @param {any} profile Connection Manager profile
 * @param {LiveConnection} live
 * @param {Record<string, ApiTarget>} apiMap `CONNECT_API_MAP`
 * @returns {boolean}
 */
export function profileMatches(profile, live, apiMap) {
    if (!sameApi(profile, live, apiMap)) return false;
    const url = profile['api-url'];
    if (typeof url === 'string' && url && live.url && !sameServer(url, live.url)) return false;
    const model = profile.model;
    if (typeof model === 'string' && model && live.model && model !== live.model) return false;
    return true;
}

/**
 * The plain line under a saved connection's name: what it talks to, then the model (or the
 * server, when there's no model to name). Pure.
 * @param {any} profile Connection Manager profile
 * @param {object} context
 * @param {string|null} context.listener The bridge's listener URL, from `/health`
 * @param {(target: ApiTarget, api: string) => string} context.label Core's name for an API
 * @param {Record<string, ApiTarget>} context.apiMap `CONNECT_API_MAP`
 * @returns {string}
 */
export function describeProfile(profile, { listener, label, apiMap }) {
    const api = typeof profile?.api === 'string' ? profile.api.toLowerCase() : '';
    const target = apiMap[api];
    const url = typeof profile?.['api-url'] === 'string' ? profile['api-url'] : '';
    const model = typeof profile?.model === 'string' ? profile.model : '';
    let what;
    if (target?.source === 'custom' && isBridgeUrl(url, listener)) {
        what = 'Claude Code';
    } else if (target?.source && target.source in PROVIDER_NAMES) {
        what = PROVIDER_NAMES[target.source];
    } else if (target) {
        what = label(target, api);
    } else {
        what = api || 'Unknown API';
    }
    const detail = model ? modelLabel(model) : hostOf(url);
    return detail ? `${what} · ${detail}` : what;
}

/**
 * Which saved connection is in use: the Connection Manager's own pick when it still matches,
 * else the first that does, else none. Pure.
 * @param {any[]} profiles
 * @param {string|null} selectedId
 * @param {(profile: any) => boolean} matches
 * @returns {string|null} Profile id
 */
export function pickInUse(profiles, selectedId, matches) {
    const selected = profiles.find(profile => profile?.id === selectedId);
    if (selected && matches(selected)) return selected.id;
    return profiles.find(profile => matches(profile))?.id ?? null;
}

/**
 * Core's own text for an option, tidied for a list: "Custom (OpenAI-compatible)" →
 * "OpenAI-compatible", the "[LM Studio, LiteLLM, etc.]" tail dropped. Pure.
 * @param {string} text
 * @returns {string}
 */
export function tidyOptionLabel(text) {
    const trimmed = String(text).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    return trimmed === 'Custom (OpenAI-compatible)' ? 'OpenAI-compatible' : trimmed;
}

/**
 * @param {string} selectId Core select id
 * @param {string} value Option value
 * @returns {string} The option's tidied label, or '' when core has no such option
 */
function optionLabel(selectId, value) {
    const select = document.getElementById(selectId);
    if (!(select instanceof HTMLSelectElement)) return '';
    const option = Array.from(select.options).find(o => o.value === value);
    return option ? tidyOptionLabel(option.textContent ?? '') : '';
}

/**
 * Core's name for an API, from its own selects.
 * @param {ApiTarget} target
 * @param {string} api The `/api` name, the last resort
 * @returns {string}
 */
export function apiLabel(target, api) {
    if (target.source) return optionLabel('chat_completion_source', target.source) || api;
    if (target.type) return optionLabel('textgen_type', target.type) || api;
    return MAIN_API_NAMES[/** @type {keyof typeof MAIN_API_NAMES} */ (target.selected)] ?? api;
}

/** @returns {LiveConnection} The connection core has right now. */
export function liveConnection() {
    const selected = String(main_api ?? '');
    try {
        if (selected === 'openai') {
            const source = String(oai_settings?.chat_completion_source ?? '');
            return { selected, source, url: source === 'custom' ? String(oai_settings.custom_url ?? '') : '', model: String(getChatCompletionModel() ?? '') };
        }
        if (selected === 'textgenerationwebui') {
            const type = String(textgenerationwebui_settings.type ?? '');
            // getTextGenModel() toasts and throws for Ollama with no model picked yet — on every
            // render this ran, measured as a stack of "No Ollama model selected" toasts.
            const model = type === 'ollama' ? textgenerationwebui_settings.ollama_model : getTextGenModel();
            return { selected, type, url: String(getTextGenServer() ?? ''), model: String(model ?? '') };
        }
    } catch {
        // A half-loaded page: compare on the API alone.
    }
    return { selected };
}

/** @returns {boolean} Whether the Connection Manager extension is present (its select is). */
export function hasConnectionManager() {
    return document.getElementById('connection_profiles') instanceof HTMLSelectElement;
}

/**
 * @typedef {object} SavedConnection
 * @property {string} id
 * @property {string} name The person's own name for it
 * @property {string} detail The plain line: "Claude Code · Sonnet 4.6"
 * @property {boolean} inUse The live connection is this one
 * @property {boolean} selected The Connection Manager's own pick (its buttons act on this one)
 * @property {boolean} drifted Selected, same API, but the URL or model has moved since it was saved
 * @property {boolean} bridge It talks to the Claude Code bridge
 */

/** @returns {SavedConnection[]} Every saved connection, by name, with its live state. */
export function savedConnections() {
    const manager = extension_settings?.connectionManager;
    const raw = /** @type {any[]} */ (Array.isArray(manager?.profiles) ? manager.profiles : []).filter(p => p && typeof p.id === 'string' && p.id);
    const selectedId = typeof manager?.selectedProfile === 'string' ? manager.selectedProfile : null;
    const live = liveConnection();
    const apiMap = /** @type {Record<string, ApiTarget>} */ (CONNECT_API_MAP);
    const inUse = pickInUse(raw, selectedId, profile => profileMatches(profile, live, apiMap));
    const listener = getBridgeListener();
    return raw
        .map(profile => ({
            id: profile.id,
            name: typeof profile.name === 'string' && profile.name ? profile.name : profile.id,
            detail: describeProfile(profile, { listener, label: apiLabel, apiMap }),
            inUse: profile.id === inUse,
            selected: profile.id === selectedId,
            drifted: profile.id === selectedId && profile.id !== inUse && sameApi(profile, live, apiMap),
            bridge: apiMap[String(profile.api ?? '').toLowerCase()]?.source === 'custom' && isBridgeUrl(profile['api-url'], listener),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @typedef {object} Way One "more ways to connect" choice
 * @property {string} id Stable key
 * @property {string} name core's label for it
 * @property {string} mainApi `main_api` value
 * @property {string} [source] Chat Completion source
 * @property {string} [type] Text Completion type
 * @property {string} [note] A second word when the name alone is ambiguous
 */

/**
 * The two lists under "More ways to connect", built from core's own selects so an upstream
 * source shows up here the day it lands. Pure over the option lists it is handed.
 * @param {Array<{ value: string, text: string }>} sources `#chat_completion_source` options
 * @param {Array<{ value: string, text: string }>} types `#textgen_type` options
 * @param {ReadonlyArray<string>} firstParty Sources that already have a card
 * @returns {{ local: Way[], others: Way[] }}
 */
export function buildWays(sources, types, firstParty) {
    /** @type {Way[]} */
    const local = [];
    /** @type {Way[]} */
    const others = [];
    for (const { value, text } of sources) {
        if (!value || firstParty.includes(value)) continue;
        const way = { id: `cc:${value}`, name: tidyOptionLabel(text), mainApi: 'openai', source: value };
        if (value === 'custom') local.unshift({ ...way, note: 'Chat Completion' });
        else others.push(way);
    }
    for (const { value, text } of types) {
        if (!value) continue;
        const way = { id: `tc:${value}`, name: tidyOptionLabel(text), mainApi: 'textgenerationwebui', type: value };
        if (LOCAL_TEXTGEN_TYPES.includes(value)) local.push(value === 'generic' ? { ...way, note: 'Text Completion' } : way);
        else others.push({ ...way, note: 'Text Completion' });
    }
    others.push(
        { id: 'novel', name: MAIN_API_NAMES.novel, mainApi: 'novel' },
        { id: 'koboldhorde', name: MAIN_API_NAMES.koboldhorde, mainApi: 'koboldhorde' },
    );
    const byLocalOrder = (/** @type {Way} */ way) => (way.type ? LOCAL_TEXTGEN_TYPES.indexOf(way.type) : -1);
    local.sort((a, b) => byLocalOrder(a) - byLocalOrder(b));
    others.sort((a, b) => a.name.localeCompare(b.name));
    return { local, others };
}

/**
 * @param {string} selectId
 * @returns {Array<{ value: string, text: string }>} A core select's options, as they stand now
 */
function optionsOf(selectId) {
    const select = document.getElementById(selectId);
    if (!(select instanceof HTMLSelectElement)) return [];
    return Array.from(select.options).map(option => ({ value: option.value, text: option.textContent ?? '' }));
}

/**
 * @param {ReadonlyArray<string>} firstParty Sources "Your API keys" already covers
 * @returns {{ local: Way[], others: Way[] }}
 */
export function currentWays(firstParty) {
    return buildWays(optionsOf('chat_completion_source'), optionsOf('textgen_type'), firstParty);
}

/**
 * Whether a way is the API core has selected right now.
 * @param {Way} way
 * @returns {boolean}
 */
export function isCurrentWay(way) {
    const live = liveConnection();
    if (way.mainApi !== live.selected) return false;
    if (way.source) return way.source === live.source;
    if (way.type) return way.type === live.type;
    return true;
}

/**
 * The field a person fills next for a way: the server URL for local servers, otherwise the
 * first visible field of that API's block in the stock panel.
 * @param {Way} way
 * @returns {HTMLElement|null}
 */
export function wayField(way) {
    if (way.source === 'custom') return document.getElementById('custom_api_url_text');
    const selector = way.type ? /** @type {Record<string, string>} */ (SERVER_INPUTS)[way.type] : '';
    const direct = selector ? document.querySelector(selector) : null;
    if (direct instanceof HTMLElement && direct.offsetParent !== null) return direct;
    const block = document.getElementById({ openai: 'openai_api', textgenerationwebui: 'textgenerationwebui_api', novel: 'novel_api', koboldhorde: 'kobold_horde' }[way.mainApi] ?? '');
    if (!block) return null;
    const fields = Array.from(block.querySelectorAll('input.text_pole, input[type="text"], input[type="password"], textarea.text_pole'));
    return /** @type {HTMLElement|undefined} */ (fields.find(field => field instanceof HTMLElement && field.offsetParent !== null)) ?? block;
}

/**
 * A new name for a saved connection, checked by the Connection Manager's own rules (sanitized,
 * not empty, not `<None>`, not taken by another). Pure.
 * @param {unknown} raw What was typed
 * @param {string} id The connection being renamed
 * @param {Array<{ id: string, name: string }>} profiles
 * @param {(text: string) => string} sanitize DOMPurify.sanitize
 * @returns {{ name: string } | { error: string }}
 */
export function checkRename(raw, id, profiles, sanitize) {
    const name = sanitize(String(raw ?? '')).trim();
    if (!name) return { error: 'Name cannot be empty.' };
    if (name === '<None>' || profiles.some(p => p.id !== id && p.name === name)) return { error: 'A profile with the same name already exists.' };
    return { name };
}

/** @returns {any} The Connection Manager's settings block, or null. */
function manager() {
    return extension_settings?.connectionManager ?? null;
}

/**
 * Renames a saved connection without using it (connections-v0 C3 follow-up). The extension's own
 * Edit button acts on its *selected* profile, and its "Save and Update" snapshots the LIVE settings
 * into that profile — pointed at one that isn't in use, it would overwrite it with the current
 * connection. A rename is only the name, so it is done here the way the extension's edit does a
 * rename-only save: set the name, save, emit CONNECTION_PROFILE_UPDATED(old, new), and relabel the
 * extension's own option so its select agrees without a reload.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function renameSavedConnection(id) {
    const profiles = /** @type {any[]} */ (manager()?.profiles ?? []);
    const profile = profiles.find(p => p?.id === id);
    if (!profile) return;
    const { callGenericPopup, POPUP_TYPE } = await import('../../scripts/popup.js');
    const raw = await callGenericPopup('Rename this saved connection', POPUP_TYPE.INPUT, profile.name);
    if (!raw) return;
    const result = checkRename(raw, id, profiles, text => DOMPurify.sanitize(text));
    if ('error' in result) {
        /** @type {any} */ (globalThis).toastr?.error(result.error);
        return;
    }
    if (result.name === profile.name) return;
    const before = structuredClone(profile);
    profile.name = result.name;
    saveSettingsDebounced();
    const option = document.querySelector(`#connection_profiles option[value="${CSS.escape(id)}"]`);
    if (option) option.textContent = result.name;
    await eventSource.emit(event_types.CONNECTION_PROFILE_UPDATED, before, profile);
}

/**
 * Deletes a saved connection without using it: the extension's own Delete (its confirm, its
 * splice, its events), pointed at this profile for the moment it takes. Selecting through the
 * extension's select would APPLY the profile, so only its `selectedProfile` and the select's
 * value are moved — no change event — and the person's own selection comes back afterwards. The
 * extension's delete handler always ends with CONNECTION_PROFILE_LOADED, confirmed or cancelled.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteSavedConnection(id) {
    const cm = manager();
    const select = document.getElementById('connection_profiles');
    const button = document.getElementById('delete_connection_profile');
    if (!cm || !(select instanceof HTMLSelectElement) || !button) return;
    const previous = cm.selectedProfile ?? null;
    const done = new Promise((resolve) => {
        const timer = setTimeout(() => finish(), 300000);
        const finish = () => {
            clearTimeout(timer);
            eventSource.removeListener(event_types.CONNECTION_PROFILE_LOADED, finish);
            resolve(undefined);
        };
        eventSource.on(event_types.CONNECTION_PROFILE_LOADED, finish);
    });
    cm.selectedProfile = id;
    select.value = id;
    button.classList.remove('disabled');
    button.click();
    await done;
    // Confirmed or cancelled, the selection goes back to the person's own (or none): the profile
    // aimed at was never applied, so it must not stay selected.
    const restored = previous && previous !== id && cm.profiles.some((/** @type {any} */ p) => p?.id === previous) ? previous : null;
    cm.selectedProfile = restored;
    select.value = restored ?? '';
    for (const action of ['update', 'reload', 'delete']) {
        document.getElementById(`${action}_connection_profile`)?.classList.toggle('disabled', !restored);
    }
    saveSettingsDebounced();
}
