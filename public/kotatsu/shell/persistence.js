/**
 * Kotatsu shell — persisted shell state: where it lives and how it changes.
 *
 * Two things live here, and both use the same two-store pattern: the LAYOUT
 * choice (shell v0 slice A) and the RAIL COLLAPSE state (variant wardrobe v0
 * slice C, docs/variant-wardrobe-v0.md §3).
 *
 * Two stores, on purpose, mirroring what the theme loader already does:
 *
 * - `power_user.kotatsu_layout` is the truth. It is a new key that rides the
 *   settings contract for free — loadPowerUserSettings() does
 *   `Object.assign(power_user, settings.power_user)` (power-user.js:1645) and the
 *   whole object is serialized back on save, so an unknown key round-trips
 *   without a single line in power-user.js.
 * - `localStorage['kotatsu.layout']` is the mirror the boot path can actually
 *   read. The shell registers at script.js:727, which runs long BEFORE
 *   getSettings(), so `power_user` is still at its defaults there. Same reason
 *   the theme loader keeps `kotatsu.theme` in localStorage, and the same store
 *   the first-paint script in index.html reads to set `data-k-layout` before a
 *   single pixel is drawn.
 *
 * Switching applies by reload (docs/shell-v0.md: "v0 applies the switch via
 * reload — honest and simple, hot-swap is a later refinement"). Reload also
 * means the mirror is always the value that painted, so the two stores cannot
 * drift within a session.
 */

import { saveSettings, saveSettingsDebounced } from '../../script.js';
import { power_user } from '../../scripts/power-user.js';

/** localStorage key holding the layout that should paint on the next load. */
export const LAYOUT_STORAGE_KEY = 'kotatsu.layout';

/**
 * The fallback when nothing is stored. Rails since 2026-08-26 (the move-in
 * flip: "once v0.1 lands, rails goes always-on") — a fresh profile boots into
 * the rails shell, and `classic` remains a stored CHOICE rather than the
 * default state. Classic is still the one layout that never carries a
 * `data-k-layout` attribute; it just has to be asked for now.
 */
export const DEFAULT_LAYOUT = 'rails';

/**
 * A layout id must be safe to write into an attribute selector and into the
 * first-paint script's `dataset` assignment.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isLayoutId(value) {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}

/**
 * The layout the boot path should apply.
 *
 * The `??` chain is ordered mirror-first because of the seam timing above:
 * `power_user.kotatsu_layout` is essentially always undefined this early, and is
 * read anyway so the chain stays correct if the seam ever moves later.
 * @returns {string}
 */
export function readStoredLayout() {
    /** @type {string | null} */
    let mirrored = null;
    try {
        mirrored = localStorage.getItem(LAYOUT_STORAGE_KEY);
    } catch {
        // Private-mode or a locked-down profile: fall through to settings, then default.
    }
    const candidate = mirrored ?? power_user?.kotatsu_layout ?? DEFAULT_LAYOUT;
    if (!isLayoutId(candidate)) return DEFAULT_LAYOUT;
    return candidate;
}

/**
 * Writes the mirror without touching settings. Used to reconcile the mirror to
 * a `power_user` value that arrived from another machine after boot.
 * @param {string} id
 * @returns {void}
 */
export function mirrorLayout(id) {
    try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, id);
    } catch {
        // A missing mirror costs one wrong first paint, not correctness.
    }
}

/**
 * Persists a layout choice and applies it.
 *
 * The settings save is AWAITED before the reload. The debounced variant loses a
 * race it cannot win: its ~1s timer dies with the page when `location.reload()`
 * runs, so `power_user.kotatsu_layout` never reached settings.json and every
 * OTHER browser kept booting classic (found live, 2026-08-24 — the QA browser
 * masked it with its own localStorage mirror). The mirror is still written
 * first, so even a failed save flips THIS browser; the await is what makes the
 * choice travel.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function setLayout(id) {
    if (!isLayoutId(id)) {
        console.warn(`[Kotatsu shell] "${id}" is not a valid layout id; ignoring.`);
        return;
    }
    power_user.kotatsu_layout = id;
    mirrorLayout(id);
    try {
        await saveSettings();
    } catch (error) {
        console.error('[Kotatsu shell] settings save failed; the layout choice is local to this browser for now.', error);
    }
    location.reload();
}

/* ═══════════════════════════════════════════════════════════════════════════
   RAIL COLLAPSE (variant wardrobe v0 slice C)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * localStorage key holding the rail state that should paint on the next load.
 * Same job as {@link LAYOUT_STORAGE_KEY} and for the same reason: the shell
 * registers long before getSettings(), so `power_user` is still at its defaults
 * when the rails mount. Read by the first-paint script in index.html.
 */
export const RAILS_STORAGE_KEY = 'kotatsu.rails';

/** Both rails start open. Anything unreadable resolves to this. */
export const DEFAULT_RAIL_STATE = 'open';

/**
 * The two sides, in DOM order.
 * @type {ReadonlyArray<'left' | 'right'>}
 */
export const RAIL_SIDES = ['left', 'right'];

/**
 * @typedef {'open' | 'collapsed'} RailState
 * @typedef {{ left: RailState, right: RailState }} RailStates
 */

/**
 * @param {unknown} value
 * @returns {value is RailState}
 */
export function isRailState(value) {
    return value === 'open' || value === 'collapsed';
}

/**
 * Coerces anything at all into a complete, valid pair.
 *
 * Deliberately total rather than validating: a half-written mirror, a settings
 * file from an older Kotatsu, or a hand-edited `{ left: 3 }` all resolve to a
 * usable pair with the bad half defaulted. A rail that will not open because
 * its stored state is malformed is a trap with no exit.
 * @param {unknown} value
 * @returns {RailStates}
 */
export function normalizeRailStates(value) {
    const source = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {};
    return {
        left: isRailState(source.left) ? source.left : DEFAULT_RAIL_STATE,
        right: isRailState(source.right) ? source.right : DEFAULT_RAIL_STATE,
    };
}

/**
 * The rail states the boot path should apply.
 *
 * Mirror-first for the same seam-timing reason {@link readStoredLayout} is:
 * `power_user.kotatsu_rails` is essentially always undefined this early, and is
 * consulted anyway so the chain stays correct if the seam ever moves later.
 * @returns {RailStates}
 */
export function readStoredRails() {
    /** @type {unknown} */
    let mirrored = null;
    try {
        const raw = localStorage.getItem(RAILS_STORAGE_KEY);
        mirrored = raw ? JSON.parse(raw) : null;
    } catch {
        // Private mode, a locked-down profile, or a corrupted mirror: fall through.
        mirrored = null;
    }
    return normalizeRailStates(mirrored ?? power_user?.kotatsu_rails);
}

/**
 * Writes the mirror without touching settings. Used to reconcile the mirror to
 * a `power_user` value that arrived from another machine after boot.
 * @param {RailStates} states
 * @returns {void}
 */
export function mirrorRails(states) {
    try {
        localStorage.setItem(RAILS_STORAGE_KEY, JSON.stringify(states));
    } catch {
        // A missing mirror costs one wrong first paint, not correctness.
    }
}

/**
 * Persists a rail-state pair.
 *
 * Debounced, unlike {@link setLayout}: collapsing a rail applies live, so there
 * is no `location.reload()` to race the timer against — the exact hazard that
 * forced the layout switch to await a full save. The mirror is written first
 * either way, so this browser is correct even if the settings write never lands.
 * @param {RailStates} states
 * @returns {void}
 */
export function saveRails(states) {
    const normalized = normalizeRailStates(states);
    power_user.kotatsu_rails = normalized;
    mirrorRails(normalized);
    saveSettingsDebounced();
}

/* ═══════════════════════════════════════════════════════════════════════════
   LANDING (library v0 slice C, docs/library-v0.md §0)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * What owns the centre column when no chat is open.
 *
 * `library` is the cast gallery (`<k-library>`); `hearth` is core's own welcome screen, left
 * byte-identical to what it is today. Rails-only either way — under classic the setting is
 * inert and the stock welcome always runs.
 * @typedef {'library'|'hearth'} LandingId
 */

/** The shipped default. Andres asked for the gallery as the landing; hearth is one toggle away. */
export const DEFAULT_LANDING = 'library';

/** @type {ReadonlyArray<LandingId>} */
export const LANDING_IDS = Object.freeze(['library', 'hearth']);

/**
 * NO localStorage MIRROR, unlike the layout and the rails.
 *
 * Those two exist because the first PAINT depends on them — index.html's boot scripts read
 * them before a pixel is drawn, and `power_user` is still at its defaults at the shell seam.
 * The landing is different: nothing about it is painted at boot. `<k-library>` decides whether
 * to show itself on `APP_READY` / `CHAT_CHANGED`, both of which fire long after
 * `getSettings()` has filled `power_user` — so settings alone are enough, and a second store
 * would just be a second thing that can disagree.
 * @param {unknown} value
 * @returns {value is LandingId}
 */
export function isLandingId(value) {
    return value === 'library' || value === 'hearth';
}

/**
 * The landing the shell should honour right now.
 * @returns {LandingId} A valid id; anything unreadable resolves to {@link DEFAULT_LANDING}.
 */
export function readLanding() {
    const stored = power_user?.kotatsu_landing;
    return isLandingId(stored) ? stored : DEFAULT_LANDING;
}

/**
 * Event fired on `document` after the landing choice changes, so `<k-library>` can apply it
 * without polling. Bubbling is irrelevant (it is dispatched at the document) but `composed` is
 * kept for symmetry with the other kotatsu events.
 */
export const LANDING_CHANGED_EVENT = 'k-landing-changed';

/**
 * Persists a landing choice and announces it.
 *
 * Debounced like {@link saveRails} and for the same reason: the change applies live, so there
 * is no `location.reload()` for the timer to lose a race against.
 * @param {string} id Requested landing.
 * @returns {void}
 */
export function setLanding(id) {
    if (!isLandingId(id)) {
        console.warn(`[Kotatsu shell] "${id}" is not a landing id; ignoring.`);
        return;
    }
    power_user.kotatsu_landing = id;
    saveSettingsDebounced();
    document.dispatchEvent(new CustomEvent(LANDING_CHANGED_EVENT, { composed: true, detail: { landing: id } }));
}
