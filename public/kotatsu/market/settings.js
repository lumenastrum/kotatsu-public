/**
 * Browse Characters' two settings (`docs/character-marketplace-v0.md` §7, as rewritten by §13
 * "the gate is region"): whether a search asks the site for NSFW cards, and whether portraits
 * the site flags as NSFW stay blurred until hovered.
 *
 * Both live in `power_user`, one flat key each, the way every other Kotatsu-native setting does
 * (`kotatsu_metrics`, `kotatsu_landing`, …). The design's first draft pinned one nested object;
 * the registry binds one key per control, so flat it is. Each is a string enum rather than a
 * boolean, for the reason the variant axes are: an unset key must mean "the shipped behaviour",
 * and the shipped behaviour differs (NSFW off, blur on), so neither can be a falsy default.
 *
 * The checkboxes are stock markup in the User Settings drawer (`index.html`, beside Message
 * metrics), adopted into the settings modal by the registry. This module is their only writer.
 * An open `<k-market>` learns of a change through {@link MARKET_SETTINGS_EVENT} on `document`
 * and re-searches or re-renders; it never writes the keys itself except through {@link setNsfw}.
 */
import { saveSettingsDebounced } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';

/** `power_user` key: ask the site for NSFW cards. Unset means OFF. */
export const MARKET_NSFW_SETTING = 'kotatsu_market_nsfw';

/** `power_user` key: blur portraits the site flags as NSFW. Unset means ON. */
export const MARKET_BLUR_SETTING = 'kotatsu_market_blur';

/** Values both keys take. */
export const MARKET_STATES = Object.freeze(['on', 'off']);

/** Raised on `document` after either setting changes. `detail.key` names which. */
export const MARKET_SETTINGS_EVENT = 'k-market-settings';

/** Checkbox ids in the drawer markup. */
const NSFW_CHECKBOX_ID = 'kotatsu_market_nsfw';
const BLUR_CHECKBOX_ID = 'kotatsu_market_blur';

let initialized = false;

/** @returns {boolean} Whether searches ask for NSFW. Default OFF: the reader opts in. */
export function nsfwEnabled() {
    return power_user?.[MARKET_NSFW_SETTING] === 'on';
}

/** @returns {boolean} Whether NSFW portraits blur. Default ON: the reader opts out. */
export function blurEnabled() {
    return power_user?.[MARKET_BLUR_SETTING] !== 'off';
}

/**
 * @param {string} id A checkbox id.
 * @returns {HTMLInputElement|null} The checkbox, when the drawer markup is present.
 */
function checkbox(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement ? element : null;
}

/** Renders the live settings back into their checkboxes. @returns {void} */
function syncCheckboxes() {
    const nsfw = checkbox(NSFW_CHECKBOX_ID);
    if (nsfw) nsfw.checked = nsfwEnabled();
    const blur = checkbox(BLUR_CHECKBOX_ID);
    if (blur) blur.checked = blurEnabled();
}

/**
 * @param {string} key The `power_user` key written.
 * @returns {void}
 */
function announce(key) {
    document.dispatchEvent(new CustomEvent(MARKET_SETTINGS_EVENT, { detail: { key } }));
}

/**
 * @param {string} key Which setting.
 * @param {boolean} on The new value.
 * @param {boolean} shippedOn What unset means for this key.
 * @returns {void}
 */
function write(key, on, shippedOn) {
    const value = on ? 'on' : 'off';
    // Write nothing when the value is the shipped one and the key was never set: an untouched
    // settings file stays untouched (survival probes count keys).
    if (power_user[key] === undefined && on === shippedOn) return;
    power_user[key] = value;
    saveSettingsDebounced();
    syncCheckboxes();
    announce(key);
}

/**
 * @param {boolean} on Whether searches should ask for NSFW.
 * @returns {void}
 */
export function setNsfw(on) {
    write(MARKET_NSFW_SETTING, on, false);
}

/**
 * @param {boolean} on Whether NSFW portraits should blur.
 * @returns {void}
 */
export function setBlur(on) {
    write(MARKET_BLUR_SETTING, on, true);
}

/**
 * Binds the drawer checkboxes. Called once from `initKotatsuShell()`, the `firstLoadInit()`
 * seam every Kotatsu subsystem rides.
 * @returns {void}
 */
export function initMarketSettings() {
    if (initialized) return;
    initialized = true;

    const nsfw = checkbox(NSFW_CHECKBOX_ID);
    if (nsfw) nsfw.addEventListener('input', () => setNsfw(nsfw.checked));
    const blur = checkbox(BLUR_CHECKBOX_ID);
    if (blur) blur.addEventListener('input', () => setBlur(blur.checked));

    // The seam runs before real settings exist; the first paint of the checkboxes is a guess
    // corrected once the file lands.
    syncCheckboxes();
    eventSource.on(event_types.SETTINGS_LOADED, syncCheckboxes);
}
