/**
 * Presets stop switching the connection (docs/connections-v0.md, decision D3).
 *
 * Upstream binds Chat Completion presets to the connection by default (`bind_preset_to_connection:
 * true`, openai.js default_settings): picking a preset also applies its 55 `isConnection` keys —
 * source, models, URLs, reverse proxy — so the shipped "Default" preset silently moves a person
 * from the Claude Code bridge to OpenAI gpt-4-turbo. In Kotatsu, presets shape the prompt and
 * connections pick the model.
 *
 * This unbinds ONCE per install, not on every load: core's own link toggle stays, and a person
 * who turns binding back on keeps it. The marker lives in `power_user` (oai_settings drops keys
 * it doesn't know). Core's default is left alone on purpose — the preset byte-identity tests
 * characterize the bound mode as the module default.
 *
 * **The seeded preset is applied once** (2026-10-01). A fresh install's settings.json names
 * Sparkle Sauce as the selected preset but carries core's eleven stock prompts: core applies a
 * preset's prompts only when the preset select CHANGES, and on first boot nothing changes it.
 * Measured live: fresh boot = 12 prompts, no ➊ Game Master; re-selecting the same preset = 94
 * prompts and its six radio groups. Core's first-run gate (script.js `getSettings()`) leaves
 * `kotatsu_seed_preset: 'pending'`; at APP_READY this fires the select's own change once, which
 * is exactly a person re-picking it. D3 has already unbound presets by then, so the connection
 * is untouched. Existing installs never carry the marker.
 *
 * One-way imports: kotatsu → core.
 */

import { saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings } from '../../scripts/openai.js';
import { power_user } from '../../scripts/power-user.js';

/** `power_user` marker: the D3 unbinding has run on this install. */
export const UNBIND_MARKER = 'kotatsu_preset_unbound_v1';

/** `power_user` marker core's first-run gate leaves: apply the seeded preset once. */
export const SEED_MARKER = 'kotatsu_seed_preset';

/**
 * Takes the first-run marker, once. Pure over `power_user`.
 * @param {Record<string, any>} pu `power_user`
 * @returns {boolean} Whether the seeded preset should be applied now
 */
export function takeSeedPreset(pu) {
    if (!pu || pu[SEED_MARKER] !== 'pending') return false;
    delete pu[SEED_MARKER];
    return true;
}

/**
 * Unbinds presets from the connection once. Pure over the two settings objects it is handed.
 * @param {Record<string, any>} oai `oai_settings`
 * @param {Record<string, any>} pu `power_user`
 * @returns {boolean} Whether anything changed (and so wants a save)
 */
export function migratePresetBinding(oai, pu) {
    if (!oai || !pu || pu[UNBIND_MARKER]) return false;
    pu[UNBIND_MARKER] = true;
    if (oai.bind_preset_to_connection !== false) oai.bind_preset_to_connection = false;
    return true;
}

let installed = false;

/**
 * Runs the migration when core has loaded both settings objects. Called once from the
 * `firstLoadInit()` seam (shell/index.js), before settings load.
 * @returns {void}
 */
export function installPresetBinding() {
    if (installed) return;
    installed = true;
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, () => {
        const wasBound = oai_settings?.bind_preset_to_connection !== false;
        if (!migratePresetBinding(/** @type {any} */ (oai_settings), /** @type {any} */ (power_user))) return;
        // loadOpenAISettings already painted core's link toggle from the old value.
        const toggle = document.getElementById('bind_preset_to_connection');
        if (toggle instanceof HTMLInputElement) toggle.checked = false;
        if (wasBound) console.info('[Kotatsu] Presets no longer switch the connection (connections-v0 D3).');
        saveSettingsDebounced();
    });
    eventSource.on(event_types.APP_READY, () => {
        if (!takeSeedPreset(/** @type {any} */ (power_user))) return;
        const select = document.getElementById('settings_preset_openai');
        if (select instanceof HTMLSelectElement && select.value !== '') {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            console.info(`[Kotatsu] First run: applied the seeded preset "${select.selectedOptions[0]?.textContent ?? select.value}".`);
        }
        saveSettingsDebounced();
    });
}
