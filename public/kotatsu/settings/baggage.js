/**
 * Kotatsu baggage — the JS half of docs/baggage-audit-v0.md (css/kotatsu-baggage.css is the rest).
 *
 * Three jobs, all in service of HIDING inherited controls safely:
 *
 * 1. **Retire the Extras API (B2).** The separate SillyTavern-Extras server is discontinued, yet
 *    a fresh install pointed Summarize, Caption and Image Generation at it (Summarize then failed
 *    silently). `migrateExtrasSettings()` rewrites every saved Extras value to a working one —
 *    Decisions of 2026-10-01: caption → multimodal through the CURRENT connection, image
 *    generation → no source (honest "not available" toast), the rest to their own live
 *    defaults; Summarize lands on the main API PAUSED (decision 2026-10-03: pointed at the dead
 *    server it never ran, so a live auto-summarize every ten messages would be new behaviour,
 *    paid for on the user's own plan) — and clears the Extras key, which `doExtrasFetch` would otherwise keep sending as
 *    a Bearer token to Silero / XTTS / AllTalk servers. It runs on `EXTENSIONS_FIRST_LOAD`:
 *    after core has merged the saved `extension_settings` and BEFORE any extension activates
 *    (extensions.js `loadExtensionSettings`), so no extension ever reads an Extras value. ORDER
 *    IS THE POINT: an option removed while a saved value still points at it leaves the select
 *    blank, and Summarize's loader then saves '' and goes silent forever.
 * 2. **Prune the Extras options** from the extension selects once their templates exist — removed,
 *    not CSS-hidden (Safari ignores `hidden` on `<option>`), and only after (1), so nothing saved
 *    points at them. A small observer on the two extension panels catches selects that render
 *    later (TTS builds its provider list and Edge's sub-select on demand).
 * 3. **Say what the API is (B4).** `body[data-k-main-api]` mirrors core's `main_api`. (Its sibling
 *    `body[data-k-bridge]`, which the sheet's B3 hides key on, moved to kotatsu/connections/
 *    bridge.js with the rest of what the frontend knows about the Claude Code bridge.)
 *
 * Hide, never delete: no key is removed. One-way imports: kotatsu → core.
 */

import { main_api, saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { extension_settings } from '../../scripts/extensions.js';

/**
 * Rewrites every saved Extras value. Pure over the object it is given; returns what changed, so
 * the caller can save only when something did and log it once.
 * @param {Record<string, any>} es An `extension_settings`-shaped object.
 * @returns {string[]} One line per rewrite.
 */
export function migrateExtrasSettings(es) {
    /** @type {string[]} */
    const changes = [];
    if (!es || typeof es !== 'object') return changes;

    if (es.autoConnect === true) {
        es.autoConnect = false;
        changes.push('autoConnect → false');
    }
    if (typeof es.apiKey === 'string' && es.apiKey !== '') {
        es.apiKey = '';
        changes.push('apiKey cleared');
    }

    // Caption: core's own migration writes 'extras' into an EMPTY source when the extension
    // activates (caption/index.js), so empty is claimed here too. Multimodal through the
    // current connection — but only over upstream's untouched multimodal defaults; a captioner
    // somebody configured on purpose is theirs.
    const caption = es.caption;
    if (caption && typeof caption === 'object' && (caption.source === 'extras' || !caption.source)) {
        caption.source = 'multimodal';
        changes.push('caption.source → multimodal');
        const untouched = (!caption.multimodal_api || caption.multimodal_api === 'openai')
            && (!caption.multimodal_model || caption.multimodal_model === 'gpt-4-turbo');
        if (untouched) {
            caption.multimodal_api = 'custom';
            caption.multimodal_model = 'custom_current';
            changes.push('caption.multimodal → custom / current model');
        }
    }

    if (es.expressions && Number(es.expressions.api) === 1) {
        es.expressions.api = 99;
        changes.push('expressions.api → none');
    }
    // Pointed at Extras, Summarize never ran. Moving it to the main API alone would switch on an
    // extra generation every ten messages on the user's own connection (it did, 2026-10-01 →
    // 10-03, on a ChatGPT plan), so it moves paused: off, as it effectively was.
    if (es.memory?.source === 'extras') {
        es.memory.source = 'main';
        es.memory.memoryFrozen = true;
        changes.push('memory.source → main, paused');
    }
    if (es.sd?.source === 'extras') {
        es.sd.source = '';
        changes.push('sd.source → none');
    }
    if (es.tts && typeof es.tts === 'object') {
        if (es.tts.currentProvider === 'Coqui') {
            es.tts.currentProvider = 'System';
            changes.push('tts.currentProvider → System');
        }
        if (es.tts.Edge?.provider === 'extras') {
            es.tts.Edge.provider = 'plugin';
            changes.push('tts.Edge.provider → plugin');
        }
    }
    if (es.vectors?.summary_source === 'extras') {
        es.vectors.summary_source = 'main';
        changes.push('vectors.summary_source → main');
    }
    return changes;
}

/**
 * Options removed from the extension selects once (1) has run. `[selector, value]`.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const EXTRAS_OPTIONS = Object.freeze([
    ['#caption_source', 'extras'],
    ['#expression_api', '1'],
    ['#summary_source', 'extras'],
    ['#sd_source', 'extras'],
    ['#vectors_summary_source', 'extras'],
    ['#edge_tts_provider', 'extras'],
    ['#tts_provider', 'Coqui'],
]);

/**
 * Removes every Extras option present in the document, and gives the image-generation source a
 * real "nothing chosen" state so a blank source reads as a choice to make, not a broken select.
 * Idempotent.
 * @returns {void}
 */
function pruneExtrasOptions() {
    for (const [selector, value] of EXTRAS_OPTIONS) {
        const select = document.querySelector(selector);
        if (!(select instanceof HTMLSelectElement)) continue;
        for (const option of Array.from(select.options)) {
            if (option.value === value) option.remove();
        }
    }
    const sd = document.querySelector('#sd_source');
    if (sd instanceof HTMLSelectElement && !Array.from(sd.options).some(option => option.value === '')) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose a source…';
        placeholder.disabled = true;
        sd.prepend(placeholder);
        if (!extension_settings.sd?.source) sd.value = '';
    }
}

let installed = false;

/** Writes the API attribute the baggage sheet keys on. */
function renderConnection() {
    if (document.body) document.body.dataset.kMainApi = String(main_api ?? '');
}

/**
 * Wires all three jobs. Called once from the `firstLoadInit()` seam (shell/index.js), which runs
 * before `getSettings()` — early enough to be listening when EXTENSIONS_FIRST_LOAD fires.
 * @returns {void}
 */
export function installBaggage() {
    if (installed) return;
    installed = true;

    eventSource.on(event_types.EXTENSIONS_FIRST_LOAD, () => {
        const changes = migrateExtrasSettings(extension_settings);
        if (changes.length === 0) return;
        // loadExtensionSettings filled these two fields from the old values a moment ago.
        const keyField = document.getElementById('extensions_api_key');
        if (keyField instanceof HTMLInputElement) keyField.value = extension_settings.apiKey ?? '';
        const autoConnect = document.getElementById('extensions_autoconnect');
        if (autoConnect instanceof HTMLInputElement) autoConnect.checked = Boolean(extension_settings.autoConnect);
        console.info(`[Kotatsu baggage] Extras API retired: ${changes.join('; ')}`);
        saveSettingsDebounced();
    });

    eventSource.on(event_types.APP_READY, () => {
        pruneExtrasOptions();
        let frame = 0;
        const observer = new MutationObserver(() => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                pruneExtrasOptions();
            });
        });
        for (const id of ['extensions_settings', 'extensions_settings2']) {
            const panel = document.getElementById(id);
            if (panel) observer.observe(panel, { childList: true, subtree: true });
        }
    });

    for (const type of [event_types.SETTINGS_LOADED, event_types.MAIN_API_CHANGED, event_types.CONNECTION_PROFILE_LOADED]) {
        eventSource.on(type, renderConnection);
    }
    document.addEventListener('change', (event) => {
        if (event.target instanceof Element && event.target.matches('#main_api')) queueMicrotask(renderConnection);
    });
    renderConnection();
}
