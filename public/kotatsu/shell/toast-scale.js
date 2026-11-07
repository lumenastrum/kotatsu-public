/**
 * The toast size slider (Settings → Appearance → Wardrobe & Shell → "Notification size").
 * Andres, 2026-11-06: "a slide in Appearance Settings, with default 90% and the ability to make
 * them smaller or bigger".
 *
 * One `power_user` key, `kotatsu_toast_scale` (a fraction, 0.6–1.3, default 0.9). This module
 * writes it to `--k-mt-zoom` on <body>; css/kotatsu-manga-toasts.css scales the panel by it.
 * The slider lives in the User Settings drawer (`#kotatsu_toast_scale_row`, index.html) and the
 * settings modal adopts the row, like the reading size beside it. Letting go of the slider shows
 * a sample toast at the new size, so you see what you picked.
 */

import { saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import {
    normalizeToastScale,
    TOAST_SCALE_DEFAULT,
    TOAST_SCALE_KEY,
    TOAST_SCALE_MAX,
    TOAST_SCALE_MIN,
    TOAST_SCALE_STEP,
    toastScaleLabel,
} from './manga-toasts.js';

const SLIDER_ID = 'kotatsu_toast_scale';
const READOUT_ID = 'kotatsu_toast_scale_value';

/** @type {any} The last sample toast, so a new one replaces it instead of stacking. */
let sample = null;
let initialized = false;

/**
 * @param {number} scale
 * @returns {void}
 */
function render(scale) {
    const body = globalThis.document?.body;
    if (!body) return;
    if (scale === TOAST_SCALE_DEFAULT) body.style.removeProperty('--k-mt-zoom');
    else body.style.setProperty('--k-mt-zoom', String(scale));
    const slider = document.getElementById(SLIDER_ID);
    if (slider instanceof HTMLInputElement && Number(slider.value) !== scale) slider.value = String(scale);
    const readout = document.getElementById(READOUT_ID);
    if (readout) readout.textContent = toastScaleLabel(scale);
}

/**
 * The scale in settings (normalized).
 * @returns {number}
 */
export function getToastScale() {
    return normalizeToastScale(/** @type {Record<string, unknown>} */ (power_user)[TOAST_SCALE_KEY]);
}

/**
 * Persist and render a scale. Values outside the range are clamped, not refused.
 * @param {unknown} value
 * @returns {number} The scale that was applied.
 */
export function setToastScale(value) {
    const scale = normalizeToastScale(value);
    /** @type {Record<string, unknown>} */ (power_user)[TOAST_SCALE_KEY] = scale;
    render(scale);
    saveSettingsDebounced();
    return scale;
}

/** @returns {void} */
function showSample() {
    const toastr = /** @type {any} */ (globalThis).toastr;
    if (!toastr) return;
    if (sample) toastr.clear(sample);
    sample = toastr.info(`Notifications show at ${toastScaleLabel(getToastScale())}.`, 'Like this?', { timeOut: 3500 });
}

/**
 * Binds the slider, renders the stored size now and again after settings load. Called once from
 * initKotatsuShell(). Console door: `window.kotatsu.toastScale`.
 * @returns {void}
 */
export function initToastScale() {
    if (initialized) return;
    initialized = true;

    const slider = document.getElementById(SLIDER_ID);
    if (slider instanceof HTMLInputElement) {
        slider.min = String(TOAST_SCALE_MIN);
        slider.max = String(TOAST_SCALE_MAX);
        slider.step = String(TOAST_SCALE_STEP);
        // While dragging, the readout and any toast on screen follow; letting go saves and shows one.
        slider.addEventListener('input', () => render(normalizeToastScale(slider.value)));
        slider.addEventListener('change', () => {
            setToastScale(slider.value);
            showSample();
        });
    }
    const reset = document.getElementById('kotatsu_toast_scale_reset');
    reset?.addEventListener('click', () => {
        setToastScale(TOAST_SCALE_DEFAULT);
        showSample();
    });

    render(getToastScale());
    eventSource.on(event_types.SETTINGS_LOADED, () => render(getToastScale()));

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') targetWindow.kotatsu = {};
    targetWindow.kotatsu.toastScale = { get: getToastScale, set: setToastScale };
}
