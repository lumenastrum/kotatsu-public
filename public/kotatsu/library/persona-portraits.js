/**
 * Persona portrait cache-busting — `docs/persona-gallery-v0.md` §1.4 "known v0 gap", closed.
 *
 * Core replaces a persona's image UNDER THE SAME FILENAME (`changeUserAvatar`, personas.js:
 * Replace image puts the persona id into `#avatar_upload_overwrite`, opens the file picker, then
 * uploads and re-renders the stock grid with `getUserAvatars(true, overwriteName)`). Core warms
 * the HTTP cache with `cache: 'reload'`, but an `<img>` that keeps the same `src` can keep
 * painting the old decoded image. So: note WHICH persona is being replaced when the file input
 * changes, and when core's grid re-render lands, stamp a buster for that persona alone. Posters,
 * the detail sheet and the studio hero append it as `?v=`; every other poster keeps its cache.
 *
 * Installed from `initKotatsuShell()`; layout-independent (the stock grid lives in both).
 */

/** Raised on `document` with `detail.id` when a persona's portrait was replaced. */
export const PORTRAIT_REPLACED_EVENT = 'k-persona-portrait-replaced';

/** @type {Map<string, number>} avatar id → when its image last changed (this session). */
const busts = new Map();

/** The persona whose image is being replaced, between the file pick and core's re-render. */
let pending = '';

/** @type {MutationObserver|null} */
let observer = null;

/**
 * @param {string} id Avatar id.
 * @returns {number} Its buster, 0 when its image hasn't changed this session.
 */
export function portraitBust(id) {
    return busts.get(id) ?? 0;
}

/**
 * Appends the buster to a URL when there is one.
 * @param {string} url An image URL (may already have a query).
 * @param {string} id Avatar id.
 * @returns {string} The URL, busted if its image changed.
 */
export function bustedUrl(url, id) {
    const bust = portraitBust(id);
    if (!url || !bust) return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${bust}`;
}

/** @param {Event} event A `change` anywhere (capture). @returns {void} */
function onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'avatar_upload_file') return;
    if (!target.files?.length) return;
    const overwrite = document.getElementById('avatar_upload_overwrite');
    // Empty for a NEW avatar upload (a new id, nothing cached): nothing to bust.
    pending = overwrite instanceof HTMLInputElement ? overwrite.value : '';
}

/** Core's grid re-render after an upload: the image is on disk now. @returns {void} */
function onGridRendered() {
    if (!pending) return;
    const id = pending;
    pending = '';
    busts.set(id, Date.now());
    document.dispatchEvent(new CustomEvent(PORTRAIT_REPLACED_EVENT, { detail: { id } }));
}

/** Idempotent. @returns {void} */
export function installPortraitWatch() {
    if (observer) return;
    document.addEventListener('change', onChange, { capture: true });
    observer = new MutationObserver(onGridRendered);
    const grid = document.getElementById('user_avatar_block');
    if (grid) observer.observe(grid, { childList: true });
}

/** @returns {void} */
export function uninstallPortraitWatch() {
    document.removeEventListener('change', onChange, { capture: true });
    observer?.disconnect();
    observer = null;
    pending = '';
}
