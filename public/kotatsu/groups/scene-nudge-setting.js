/**
 * The scene nudge setting (`docs/group-chat-v0.md` §10): whether a preset with no group nudge of
 * its own gets Kotatsu's (`public/scripts/group-nudge.js`).
 *
 * One flat `power_user` key, a string enum where unset means the shipped behaviour (ON) — the
 * pattern `kotatsu_metrics` and the market settings use. The checkbox is stock markup in the User
 * Settings drawer beside the other group chat options, adopted into the settings modal by the
 * registry. This module is its only writer; `openai.js` reads the key when it builds a prompt.
 */
import { saveSettingsDebounced } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';

/** `power_user` key. Unset means ON. */
export const SCENE_NUDGE_SETTING = 'kotatsu_scene_nudge';

const CHECKBOX_ID = 'kotatsu_scene_nudge';

let initialized = false;

/** @returns {boolean} Whether presets without a nudge get the scene nudge. */
export function sceneNudgeEnabled() {
    return power_user?.[SCENE_NUDGE_SETTING] !== 'off';
}

/** @returns {HTMLInputElement|null} */
function checkbox() {
    const element = document.getElementById(CHECKBOX_ID);
    return element instanceof HTMLInputElement ? element : null;
}

function sync() {
    const box = checkbox();
    if (box) box.checked = sceneNudgeEnabled();
}

/**
 * @param {boolean} on
 * @returns {void}
 */
export function setSceneNudge(on) {
    // An untouched settings file stays untouched when the choice is the shipped one.
    if (power_user[SCENE_NUDGE_SETTING] === undefined && on) return;
    power_user[SCENE_NUDGE_SETTING] = on ? 'on' : 'off';
    saveSettingsDebounced();
    sync();
}

/** Binds the drawer checkbox. Called once from `initKotatsuShell()`. */
export function initSceneNudgeSetting() {
    if (initialized) return;
    initialized = true;
    const box = checkbox();
    if (box) box.addEventListener('input', () => setSceneNudge(box.checked));
    sync();
    eventSource.on(event_types.SETTINGS_LOADED, sync);
}
