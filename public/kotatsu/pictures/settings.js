/**
 * Pictures v0 — the settings leaf (docs/pictures-v0.md §9, contract §13.3).
 *
 * One object leaf, `power_user.kotatsu_pictures` (contract `SETTINGS_KEY`). Since the settings
 * patch (repo CLAUDE.md, "settings.json multi-writer rule") plain objects recurse and arrays are
 * ONE leaf, so this module patches the same way: objects deep-merge, arrays (`styles`) are
 * replaced whole, scalars replace.
 *
 * The leaf is stored SPARSE: only what someone changed, plus `version` (the migration's guard,
 * `migrate.js`). Readers never see the sparse form — {@link getPicturesSettings} hands out
 * `DEFAULT_SETTINGS` with the stored leaf merged over it, frozen. Two reasons: an untouched
 * settings file stays untouched (the survival probe counts key paths, and the market and metrics
 * settings keep the same promise), and a default changed in a later version reaches everyone who
 * never chose otherwise. No `power-user.js` defaults entry, by settings-v0 §1 rule 4: new Kotatsu
 * keys are read `power_user?.[KEY] ?? DEFAULT` at their owning module.
 *
 * {@link onPicturesSettingsChanged} is a tiny emitter: it fires after every update and once more
 * when core's `SETTINGS_LOADED` lands (another tab's change arrives that way, after a reload).
 */

import { saveSettingsDebounced } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from './contract.js';

/** @typedef {import('./contract.js').PicturesSettings} PicturesSettings */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>} A non-null, non-array object — the only thing that recurses.
 */
export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A deep, JSON-shaped copy (what the wire would carry). `undefined` vanishes.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
    const text = JSON.stringify(value);
    return text === undefined ? value : JSON.parse(text);
}

/**
 * Merges `patch` into `base` and returns a NEW object; neither argument is touched.
 *
 * Plain objects recurse. Arrays and scalars replace whole (an array is one settings leaf). An
 * `undefined` in the patch means "no change", never "delete": deleting is not something a
 * settings panel does to this leaf.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} patch
 * @returns {Record<string, any>}
 */
export function mergeSettings(base, patch) {
    /** @type {Record<string, any>} */
    const out = isPlainObject(base) ? clone(base) : {};
    if (!isPlainObject(patch)) return out;
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (isPlainObject(value)) {
            out[key] = mergeSettings(isPlainObject(out[key]) ? out[key] : {}, value);
        } else {
            out[key] = clone(value);
        }
    }
    return out;
}

/**
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

/**
 * The view a reader gets: defaults with the stored leaf over them. Pure, for tests.
 * @param {unknown} stored What `power_user[SETTINGS_KEY]` holds (anything; junk reads as empty).
 * @returns {Readonly<PicturesSettings>}
 */
export function resolveSettings(stored) {
    return /** @type {Readonly<PicturesSettings>} */ (deepFreeze(mergeSettings(DEFAULT_SETTINGS, isPlainObject(stored) ? stored : {})));
}

/** @returns {Record<string, any>} The stored (sparse) leaf, or an empty object when there is none. */
export function readStoredLeaf() {
    const stored = power_user?.[SETTINGS_KEY];
    return isPlainObject(stored) ? stored : {};
}

/**
 * The settings every Pictures surface reads. A frozen snapshot: mutate through
 * {@link updatePicturesSettings}, never in place.
 * @returns {Readonly<PicturesSettings>}
 */
export function getPicturesSettings() {
    return resolveSettings(power_user?.[SETTINGS_KEY]);
}

/** @type {Set<(settings: Readonly<PicturesSettings>) => void>} */
const listeners = new Set();

/** Tells every listener, one at a time; a throwing listener costs only itself. */
function notify() {
    const settings = getPicturesSettings();
    for (const listener of [...listeners]) {
        try {
            listener(settings);
        } catch (error) {
            console.error('[Pictures] a settings listener threw', error);
        }
    }
}

/**
 * Writes a change into the stored leaf and schedules core's debounced save.
 *
 * The stored leaf gains `version` on its first write (the migration reads that as "done"), so a
 * reader who changes a setting before any migration ran never has one run later over their
 * choice.
 * @param {Record<string, any>} patch Any subset of {@link PicturesSettings}.
 * @returns {Readonly<PicturesSettings>} The new view.
 */
export function updatePicturesSettings(patch) {
    const next = mergeSettings(readStoredLeaf(), patch);
    if (typeof next.version !== 'number') next.version = DEFAULT_SETTINGS.version;
    power_user[SETTINGS_KEY] = next;
    saveSettingsDebounced();
    notify();
    return getPicturesSettings();
}

/**
 * Replaces the stored leaf outright. The migration's door: it builds a whole sparse leaf and
 * writes it once. Not for panels (they patch).
 * @param {Record<string, any>} leaf
 * @returns {void}
 */
export function writeStoredLeaf(leaf) {
    power_user[SETTINGS_KEY] = mergeSettings({}, leaf);
    saveSettingsDebounced();
    notify();
}

/**
 * @param {(settings: Readonly<PicturesSettings>) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function onPicturesSettingsChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let installed = false;

/**
 * Hooks `SETTINGS_LOADED`. Idempotent; called from the `firstLoadInit()` seam (via baggage) so it
 * is listening before `getSettings()` runs.
 * @returns {void}
 */
export function installPicturesSettings() {
    if (installed) return;
    installed = true;
    listeners.add(applyCaptionVisibility);
    applyCaptionVisibility(getPicturesSettings());
    eventSource.on(event_types.SETTINGS_LOADED, notify);
}

/**
 * `body[data-k-pic-captions]` = shown | hidden, read by pictures.css.
 * @param {Readonly<PicturesSettings>} settings
 */
function applyCaptionVisibility(settings) {
    const body = globalThis.document?.body;
    if (typeof body?.setAttribute === 'function') body.setAttribute('data-k-pic-captions', settings.captionLine ? 'shown' : 'hidden');
}
