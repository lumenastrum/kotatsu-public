/**
 * Kotatsu reading size — reader-polish v0 finding 1.
 *
 * One user setting, `power_user.kotatsu_prose_scale` ('auto' | 's' | 'm' | 'l' | 'xl'), written
 * to the document as `body[data-k-prose-scale]`. The sheets do the rest: css/kotatsu-chrome.css §2/§3
 * turn the attribute into `--k-prose-scale` and multiply `.mes_text` / `.mes_reasoning`'s
 * font-size by it; css/shell-center.css multiplies the rails reading column by the same number.
 * So the type grows and the measure holds at ~75 characters per line. That is the whole point:
 * on a 3440 monitor the prose was a 760px column of 15px type — 22% of the track — and the
 * honest fix is bigger type at the same measure, not a wider measure (75 CPL was already the
 * top of the comfortable range).
 *
 * Deliberately NOT a wardrobe axis: the wardrobe is per-row shape and a pack may pin it; how
 * large a person reads is theirs alone, so there is no pack precedence, no `#chat` attribute
 * and no pack note. Core's `font_scale` stays what it is — the whole-UI knob.
 *
 * DOM + persistence in one small module, the shell/rail-collapse.js shape: reads `power_user`,
 * writes one body attribute, saves through core's debounce. `auto` is the default and writes NO
 * attribute: the sheet (kotatsu-chrome.css §3) reads Large on a monitor-wide viewport and Medium
 * on a laptop, with no JS in the loop — rails re-resolve on the resize that crosses the line, as
 * they already do (blue-hour-polish-v0 §B1, Andres's call 2026-10-01). Picking a size, Medium
 * included, writes it and pins it. No
 * first-paint cache is needed: the attribute lands at the `firstLoadInit()` seam and again on
 * SETTINGS_LOADED, both long before `printMessages()` builds the first row.
 *
 * One-way imports: kotatsu → core only.
 */

import { saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';

/** @typedef {'auto' | 's' | 'm' | 'l' | 'xl'} ProseScale */

/** The `power_user` key. */
export const PROSE_SCALE_KEY = 'kotatsu_prose_scale';
/** Element id of the select in the User Settings drawer (adopted by the settings modal). */
export const PROSE_SCALE_SELECT_ID = 'kotatsu_prose_scale';
/**
 * Bubbling document event fired after the body attribute changes. `detail.scale` carries the
 * new size. shell/rail-collapse.js re-resolves on it: the reading column is part of the floor
 * rails may not squeeze, so a size change is a resize in disguise.
 */
export const PROSE_SCALE_EVENT = 'k-prose-scale-change';
/** @type {ProseScale} */
export const PROSE_SCALE_DEFAULT = 'auto';

/**
 * The known sizes and their labels, in select order. The numbers themselves live in the sheet
 * (kotatsu-chrome.css §3: 0.933 / 1 / 1.2 / 1.333 over `--mainFontSize`, and the `auto`
 * breakpoint) — this module never writes a style.
 * @type {ReadonlyArray<readonly [ProseScale, string]>}
 */
export const PROSE_SCALES = Object.freeze([
    ['auto', 'Auto — Large on monitors, Medium on laptops'],
    ['s', 'Small'],
    ['m', 'Medium'],
    ['l', 'Large'],
    ['xl', 'Extra large'],
]);

/**
 * @param {unknown} value
 * @returns {value is ProseScale}
 */
export function isProseScale(value) {
    return typeof value === 'string' && PROSE_SCALES.some(([id]) => id === value);
}

/**
 * The stored choice, or the default when the key is absent or unknown.
 * @param {unknown} settings A `power_user`-shaped object.
 * @returns {ProseScale}
 */
export function readProseScale(settings) {
    const stored = settings && typeof settings === 'object'
        ? /** @type {Record<string, unknown>} */ (settings)[PROSE_SCALE_KEY]
        : null;
    return isProseScale(stored) ? stored : PROSE_SCALE_DEFAULT;
}

let initialized = false;

/**
 * @returns {HTMLSelectElement|null} The drawer select, or null when the markup is absent.
 */
function getSelect() {
    const element = document.getElementById(PROSE_SCALE_SELECT_ID);
    return element instanceof HTMLSelectElement ? element : null;
}

/**
 * Writes the body attribute for one size, mirrors it into the select, and tells the shell when
 * the size actually changed. The default writes no attribute.
 * @param {ProseScale} scale
 * @returns {void}
 */
function render(scale) {
    // `globalThis.document?.` rather than a bare `document`: the persistence path is
    // unit-tested under node (tests/prose-scale.test.js), where there is no document and
    // nothing to render — the setting still has to be written and saved.
    const body = globalThis.document?.body;
    if (!body) return;
    const before = isProseScale(body.dataset.kProseScale) ? body.dataset.kProseScale : PROSE_SCALE_DEFAULT;
    if (scale === PROSE_SCALE_DEFAULT) {
        delete body.dataset.kProseScale;
    } else {
        body.dataset.kProseScale = scale;
    }
    const select = getSelect();
    if (select && select.value !== scale) select.value = scale;
    if (before !== scale) {
        document.dispatchEvent(new CustomEvent(PROSE_SCALE_EVENT, { bubbles: true, detail: { scale } }));
    }
}

/**
 * The size on screen.
 * @returns {ProseScale}
 */
export function getProseScale() {
    const live = globalThis.document?.body?.dataset.kProseScale;
    return isProseScale(live) ? live : PROSE_SCALE_DEFAULT;
}

/**
 * The user picked a size: persist it, render it. Unknown values are ignored, not coerced.
 * @param {ProseScale} scale
 * @returns {void}
 */
export function setProseScale(scale) {
    if (!isProseScale(scale)) return;
    /** @type {Record<string, unknown>} */ (power_user)[PROSE_SCALE_KEY] = scale;
    render(scale);
    saveSettingsDebounced();
}

/**
 * Fills and binds the select, renders the stored size now, and renders it again after settings
 * load. Called once at the `firstLoadInit()` seam from theme/loader.js, beside the wardrobe
 * picker. Exposes `window.kotatsu.proseScale` as a console door, the wardrobe's shape.
 * @returns {void}
 */
export function initProseScale() {
    if (initialized) return;
    initialized = true;

    const select = getSelect();
    if (select) {
        select.replaceChildren();
        for (const [id, label] of PROSE_SCALES) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = label;
            select.append(option);
        }
        select.addEventListener('change', () => {
            if (isProseScale(select.value)) setProseScale(select.value);
        });
    }

    render(readProseScale(power_user));
    eventSource.on(event_types.SETTINGS_LOADED, () => render(readProseScale(power_user)));

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') {
        targetWindow.kotatsu = {};
    }
    targetWindow.kotatsu.proseScale = {
        get: getProseScale,
        set: setProseScale,
        sizes: PROSE_SCALES.map(([id]) => id),
    };
}
