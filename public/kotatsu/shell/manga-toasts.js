/**
 * Manga reaction toasts (Andres, 2026-11-06): every toast becomes a manga panel with a jagged
 * cut-out of Mikan-chan's eyes reacting to it, and a sound effect slapped over the corner.
 *
 * Core makes about a thousand `toastr.*` calls, so none of them change. `toastr.error()`,
 * `.warning()`, `.success()` and `.info()` each return the toast they built (a jQuery object);
 * we wrap those four once, call the original, and decorate what comes back. Toasts shown before
 * the shell installs keep the plain look. Everything added is decorative (`aria-hidden`): the
 * title and message toastr wrote stay exactly where screen readers already find them.
 *
 * Faces: `brand/mascot/reactions/*.webp`, strips cut from Codex-painted masters
 * (`docs/design/mascot/reactions/`, prompt beside them).
 */

/** @typedef {'error'|'warning'|'success'|'info'} ToastType */

/** @type {Readonly<Record<string, { face: string, sfx: string }>>} */
export const REACTIONS = Object.freeze({
    error: { face: 'shocked', sfx: 'ガーン!' },
    warning: { face: 'nervous', sfx: 'ギクッ' },
    success: { face: 'sparkle', sfx: 'キラッ' },
    info: { face: 'curious', sfx: 'ん?' },
    copied: { face: 'smug', sfx: 'ドヤッ' },
});

/**
 * Toast size (Andres 11/6: a slider in Appearance, 90% by default). Stored as a fraction in
 * `power_user.kotatsu_toast_scale` and written to `--k-mt-zoom` on <body>; the sheet scales the
 * whole panel by it (and the phone layout by it relative to the default).
 */
export const TOAST_SCALE_KEY = 'kotatsu_toast_scale';
export const TOAST_SCALE_DEFAULT = 0.9;
export const TOAST_SCALE_MIN = 0.6;
export const TOAST_SCALE_MAX = 1.3;
export const TOAST_SCALE_STEP = 0.05;

/**
 * A stored or typed value as a usable scale: a number inside the range, on the step. Anything
 * else (absent, NaN, a string from an old hand edit) reads as the default.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeToastScale(value) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return TOAST_SCALE_DEFAULT;
    const clamped = Math.min(TOAST_SCALE_MAX, Math.max(TOAST_SCALE_MIN, number));
    // toFixed: 18 × 0.05 is 0.9000000000000001 in floating point, and that would get saved.
    return Number((Math.round(clamped / TOAST_SCALE_STEP) * TOAST_SCALE_STEP).toFixed(2));
}

/**
 * @param {number} scale
 * @returns {string} "90%".
 */
export function toastScaleLabel(scale) {
    return `${Math.round(normalizeToastScale(scale) * 100)}%`;
}

/**
 * The switch (Andres 11/12: "a switch between Kotatsu toasts and stock toasts, in case anyone
 * doesn't wanna use Mikan-chan's eyes"). `power_user.kotatsu_manga_toasts`, the string enum
 * `'on'`/`'off'` like `kotatsu_metrics`, and unset means ON: the shipped look.
 */
export const MANGA_TOASTS_KEY = 'kotatsu_manga_toasts';

/**
 * @param {unknown} value The stored value.
 * @returns {boolean} Whether toasts wear the manga panel. Only an explicit `'off'` turns it off.
 */
export function mangaToastsOn(value) {
    return value !== 'off';
}

/** Whether new toasts get decorated. shell/toast-scale.js sets it from settings. */
let enabled = true;

/**
 * Turns the manga look on or off. Off also strips it from toasts already on screen, so the one
 * that was showing when settings loaded (or when the switch was flipped) goes plain too.
 * @param {boolean} on
 * @returns {void}
 */
export function setMangaToastsEnabled(on) {
    enabled = Boolean(on);
    if (enabled) return;
    for (const el of globalThis.document?.querySelectorAll('#toast-container .k-manga-toast') ?? []) undecorateToast(el);
}

/**
 * Takes the manga panel off one toast: what toastr built is left exactly as it was.
 * @param {Element} el
 * @returns {void}
 */
export function undecorateToast(el) {
    for (const part of el.querySelectorAll(':scope > .k-mt-cut, :scope > .k-mt-sfx')) part.remove();
    for (const name of [...el.classList]) if (name === 'k-manga-toast' || name.startsWith('k-mt--')) el.classList.remove(name);
}

const FACE_DIR = 'kotatsu/brand/mascot/reactions';
const TYPES = /** @type {const} */ (['error', 'warning', 'success', 'info']);
const COPIED = /\bcopied\b/i;

/**
 * Which reaction a toast gets. Pure, for tests.
 * @param {ToastType} type
 * @param {string} text The toast's title and message as plain text.
 * @returns {keyof typeof REACTIONS}
 */
export function reactionFor(type, text) {
    if ((type === 'info' || type === 'success') && COPIED.test(text)) return 'copied';
    return type;
}

/**
 * Decorates one toast element. Safe to call twice (the second call is a no-op).
 * @param {HTMLElement} el
 * @param {ToastType} type
 * @returns {void}
 */
export function decorateToast(el, type) {
    if (!(el instanceof HTMLElement) || el.classList.contains('k-manga-toast')) return;
    const key = reactionFor(type, el.textContent || '');
    const { face, sfx } = REACTIONS[key];

    const cut = document.createElement('div');
    cut.className = 'k-mt-cut';
    cut.setAttribute('aria-hidden', 'true');
    for (const part of ['edge', 'tone', 'lines']) {
        const layer = document.createElement('i');
        layer.className = `k-mt-${part}`;
        cut.append(layer);
    }
    const eyes = document.createElement('span');
    eyes.className = 'k-mt-eyes';
    const img = document.createElement('img');
    img.src = `${FACE_DIR}/${face}.webp`;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    eyes.append(img);
    cut.append(eyes);

    const label = document.createElement('span');
    label.className = 'k-mt-sfx';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = sfx;

    el.classList.add('k-manga-toast', `k-mt--${key}`);
    el.prepend(cut, label);
}

let installed = false;

/**
 * Wraps the four toastr methods. Idempotent; a missing `toastr` (tests, a broken lib load) is
 * a quiet no-op.
 * @returns {void}
 */
export function installMangaToasts() {
    const toastr = /** @type {any} */ (globalThis).toastr;
    if (installed || !toastr) return;
    installed = true;
    for (const type of TYPES) {
        const original = toastr[type];
        if (typeof original !== 'function') continue;
        toastr[type] = function (...args) {
            const result = original.apply(this, args);
            try {
                const el = result?.[0] ?? result;
                if (enabled && el instanceof HTMLElement) decorateToast(el, type);
            } catch (error) {
                console.warn('[manga-toasts] could not decorate a toast; it shows plain.', error);
            }
            return result;
        };
    }
}
