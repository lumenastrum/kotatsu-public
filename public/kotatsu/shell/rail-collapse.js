/**
 * Kotatsu shell — rail collapse / dismiss (variant wardrobe v0 slice C).
 *
 * Spec: `docs/variant-wardrobe-v0.md` §3. The reader-squish fix — on a vertical
 * monitor a fixed 280/1fr/340 grid leaves no prose width, so either rail can be
 * dismissed and the centre column takes the space back.
 *
 * This module owns the STATE and the AFFORDANCES; `css/shell-frame.css` §5 owns
 * the mechanism. All this file ever does to the document is write
 * `data-k-rail-left` / `data-k-rail-right` on `<body>`; the sheet turns that into
 * a width-token override, and the grid, `--sheldWidth` and the six
 * `(100vw - --sheldWidth) / 2` gutter call sites all follow for free.
 *
 * The state is TWO layers since the 2026-08-25 smoke test (docs/
 * rendering-smoke-2026-08-25.md P1): the PREFERRED pair — what the user chose,
 * the only thing persisted — and the EFFECTIVE pair — what is actually on
 * screen. A resolver compares the viewport against the open rail widths and
 * the readable floor — `--k-center-readable-min` (tokens.css) or the reading
 * column itself (shell-center.css), whichever is wider, since reader-polish v0
 * finding 2 — and, when a preferred-open pair would squeeze the centre track
 * below that floor, renders rails as effectively collapsed: right first, then
 * both. The body attributes always carry the
 * effective pair, so the handles' chevrons and `aria-expanded` describe the
 * screen, never the stored wish. Growing the window restores the preference by
 * arithmetic — nothing was overwritten. A handle or hotkey used while a side is
 * suppressed writes a session OVERRIDE instead of touching the preference;
 * overrides die whenever the suppression pair changes, because they were
 * answers to a viewport that no longer exists.
 *
 * Three things it deliberately does NOT do:
 *
 * - **It never touches drawer classes.** A docked panel (`.openDrawer.pinnedOpen
 *   .k-docked`) hides with its rail by inherited `visibility` and comes back
 *   unchanged. No class is added, removed or replayed, so the three RossAscends
 *   count-guards (`.openDrawer:not(.k-docked)`, scripts/RossAscends-mods.js:66)
 *   and the Escape cascade (:1223-1280) see exactly the document they saw
 *   before. There is no drawer state to lose because none is written.
 * - **It never runs under classic.** `layouts/rails.js` installs it on mount and
 *   uninstalls it on unmount, the same shape as the settings overlay. Classic
 *   renders no handle, binds no key, and `power_user.kotatsu_rails` simply
 *   round-trips untouched.
 * - **It never reloads.** Unlike the layout switch, a collapse applies live, so
 *   the settings write can stay debounced (see persistence.js `saveRails`).
 *
 * One-way imports: kotatsu → core only.
 */

import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import { PROSE_SCALE_EVENT } from '../theme/prose-scale.js';
import { VARIANT_AXIS_EVENT } from '../../scripts/message-rows.js';
import { EXT_DOCK_EVENT, getExtDockInsets } from './ext-dock.js';
import {
    RAIL_SIDES,
    mirrorRails,
    normalizeRailStates,
    readStoredRails,
    saveRails,
} from './persistence.js';

/**
 * Ask for a rail to be opened: `detail: { side: 'left' | 'right' }`. Bubbling +
 * composed, like `k-open-settings` and `k-open-branch-map`.
 *
 * The door exists for the docked-panel case the spec names: something brings a
 * dock forward (`<k-tab-rail>` mapping a `.drawer-opener` onto its tab — dormant
 * on shipped markup since the settings v0.1 slim left one dock no opener targets,
 * live again for the next one) while that rail is collapsed. Without this the
 * click is dead —
 * the tab changes behind a zero-width rail and nothing visible happens. The
 * requester stays ignorant of collapse state and simply says what it wants.
 */
export const EXPAND_RAIL_EVENT = 'k-rail-expand';

/** Class on both handles; `css/shell-frame.css` §5 styles them. */
const HANDLE_CLASS = 'k-rail-handle';

/**
 * The phone regime (blue-hour-polish-v0 §8). At or under this width the tracks
 * are zero (css/kotatsu-phone.css) and an open rail is an overlay sheet, so the
 * module adds three phone-only affordances: a scrim that closes it, a glyph that
 * says what the rail holds (a chevron in a header row reads as "back"), and a
 * close after a chat is picked — the overlay was a trip to the chat list, not a
 * place to stay. 600 rather than the 1000 core's mobile sheet uses: a 900-wide
 * portrait monitor keeps docked rails exactly as before.
 */
const PHONE_QUERY = '(max-width: 600px)';

/** Class on the phone scrim; css/kotatsu-phone.css shows it only under PHONE_QUERY. */
const SCRIM_CLASS = 'k-rail-scrim';

/** Which rail each side's handle drives, for `aria-controls`. */
const RAIL_SLOT_ID = { left: 'k-rail-left', right: 'k-rail-right' };

/** Human names, for the labels. */
const SIDE_LABEL = { left: 'left', right: 'right' };

/** The binding per side. Shift picks the right rail. */
const SIDE_HOTKEY = { left: 'Ctrl+\\', right: 'Ctrl+Shift+\\' };

/**
 * `KeyboardEvent.code` values that mean the physical backslash key.
 *
 * `code`, not `key`, for the reason core's own quick-reply editor gives at
 * `scripts/extensions/quick-reply/src/QuickReply.js:738` — it is layout-stable.
 * It is also the only correct read here: on a US layout Ctrl+Shift+Backslash
 * reports `key === '|'`, so a `key`-based match would miss the right rail's
 * binding entirely.
 */
const BACKSLASH_CODES = new Set(['Backslash', 'IntlBackslash']);

/** `key` values accepted only when a synthetic event carries no `code`. */
const BACKSLASH_KEYS = new Set(['\\', '|']);

let installed = false;

/**
 * The PREFERRED pair — the user's choice, and the only rail state that is ever
 * persisted (`saveRails` / `power_user.kotatsu_rails`).
 * @type {import('./persistence.js').RailStates}
 */
let preferred = { left: 'open', right: 'open' };

/**
 * The resolver's verdict, per side: `true` means this viewport cannot afford
 * the rail and a preferred-open side renders collapsed. Recomputed on resize
 * and after every preferred change (a rail opening can push the OTHER side
 * under the floor). Never persisted.
 * @type {{ left: boolean, right: boolean }}
 */
let suppressed = { left: false, right: false };

/**
 * Session overrides — a handle or hotkey used while that side is suppressed.
 * `null` follows the resolver; a state pins it for this viewport regime only.
 * Cleared in one move whenever the suppression pair changes.
 * @type {{ left: import('./persistence.js').RailState | null, right: import('./persistence.js').RailState | null }}
 */
let overrides = { left: null, right: null };

/**
 * Mirrors of the tokens the resolver reads, for a document where a token is
 * missing or unparsable (a half-loaded pack, a user.css typo). Values match
 * tokens.css:175-183.
 * @type {Record<string, number>}
 */
const TOKEN_FALLBACKS = {
    '--k-rail-left-width': 280,
    '--k-rail-right-width': 340,
    '--k-center-readable-min': 560,
    // Unitless; read off <body>, not :root — see readProseColumnPx().
    '--k-prose-scale': 1,
};

/** @type {Map<'left' | 'right', HTMLButtonElement>} */
const handles = new Map();

/** @type {((event: KeyboardEvent) => void) | null} */
let onKeyDown = null;

/** @type {(() => void) | null} */
let onResize = null;

/** Pending resize frame, so a drag storm coalesces to one resolve per paint. */
let resizeFrame = 0;

/** @type {((event: Event) => void) | null} */
let onExpandRequest = null;

/** @type {(() => void) | null} */
let onSettingsLoaded = null;
/** @type {(() => void) | null} Reading-size listener: the column grew or shrank. */
let onProseScale = null;
/** @type {(() => void) | null} Wardrobe listener: a look widened or narrowed the track. */
let onVariantChange = null;

/**
 * The one glyph, pointing left. `css/shell-frame.css` §5 mirrors it with
 * `scaleX(-1)` in the two states that need it pointing right, so the direction
 * is a pure function of the body attribute and never of what this file last
 * rendered. Inline stroke SVG, no icon font, no emoji (repo CLAUDE.md).
 * @returns {SVGSVGElement}
 */
function buildChevron() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'k-rail-handle__icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '10');
    svg.setAttribute('height', '10');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M10 3 5 8l5 5');
    svg.appendChild(path);
    return svg;
}

/**
 * The phone glyph: what the rail HOLDS, since on a phone the handle sits in the
 * chat header where a chevron reads as navigation. Left = the chat list (lines),
 * right = the prompt dock (sliders). Hidden off-phone by the sheet.
 * @param {'left' | 'right'} side
 * @returns {SVGSVGElement}
 */
function buildPhoneGlyph(side) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'k-rail-handle__phone');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', side === 'left'
        ? 'M4 5.5h12M4 10h12M4 14.5h8'
        : 'M4 6h5m4 0h3M4 14h2m4 0h6M11 4v4M8 12v4');
    svg.appendChild(path);
    return svg;
}

/** @returns {boolean} Whether the phone regime is live. */
function isPhone() {
    return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * Closes whichever rails are open as phone overlays. Goes through toggleRail so a
 * suppressed side writes its session override exactly as a handle tap would — no
 * preference is touched.
 * @returns {void}
 */
function closePhoneOverlays() {
    if (!isPhone()) return;
    for (const side of RAIL_SIDES) {
        if (effectiveState(side) === 'open') toggleRail(side);
    }
}

/** @type {HTMLElement|null} */
let scrim = null;

/** @type {(() => void) | null} */
let onChatChanged = null;

/** @type {((event: Event) => void) | null} */
let onRailPick = null;

/**
 * Rows in the left rail that mean "take me there". CHAT_CHANGED covers a real switch; a tap on
 * the chat that is already open fires nothing, and the sheet must still get out of the way.
 */
const PICK_SELECTOR = '.k-rl-row--chat, .k-rl-row--branch';

/**
 * One slim handle.
 *
 * A real `<button>`: it takes focus in tab order and activates on Enter or Space
 * with no key handling of our own, which matters more than usual here because a
 * collapsed rail's handle is the only way back to it.
 * @param {'left' | 'right'} side
 * @returns {HTMLButtonElement}
 */
function buildHandle(side) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = HANDLE_CLASS;
    button.dataset.kRailSide = side;
    button.setAttribute('aria-controls', RAIL_SLOT_ID[side]);
    button.appendChild(buildChevron());
    button.appendChild(buildPhoneGlyph(side));
    button.addEventListener('click', () => toggleRail(side));
    return button;
}

/**
 * What is actually on screen for one side: a session override if one is live,
 * else collapsed if the resolver suppressed the side, else the preference.
 * @param {'left' | 'right'} side
 * @returns {import('./persistence.js').RailState}
 */
function effectiveState(side) {
    const pinned = overrides[side];
    if (pinned !== null) return pinned;
    if (suppressed[side]) return 'collapsed';
    return preferred[side];
}

/**
 * One resolved token, in pixels.
 * @param {CSSStyleDeclaration} styles Computed style of `documentElement`.
 * @param {keyof typeof TOKEN_FALLBACKS} name
 * @returns {number}
 */
function readTokenPx(styles, name) {
    const parsed = Number.parseFloat(styles.getPropertyValue(name));
    return Number.isFinite(parsed) ? parsed : TOKEN_FALLBACKS[name];
}

/**
 * The rails reading column, in pixels — the width rails may never squeeze the
 * centre track under (reader-polish v0 finding 2).
 *
 * Base and scale are read as two plain numbers off `<body>`, where both live
 * (`body[data-k-layout="rails"]` in css/shell-center.css, `body[data-k-prose-scale]`
 * in css/kotatsu-chrome.css §3): the effective `--k-cc-column` is a calc(), and an
 * unregistered custom property's computed value is the calc TEXT, not a length,
 * so it cannot be parsed. Under classic the base is absent and this returns 0,
 * which the max() in computeSuppression() ignores.
 *
 * The third term is `--k-cc-track-extra`: a look that trades the avatar for an art
 * panel (`portrait-column`, css/mes-variants.css §6) widens the track by what the panel
 * costs so the measure holds. shell-center.css registers it as a <length>, so it computes
 * to pixels and parses; an engine without @property yields the calc text, NaN, 0 — the
 * floor is then a little low there, never wrong in the squeezing direction.
 * @returns {number}
 */
function readProseColumnPx() {
    if (!document.body) return 0;
    const styles = getComputedStyle(document.body);
    const base = Number.parseFloat(styles.getPropertyValue('--k-cc-column-base'));
    if (!Number.isFinite(base)) return 0;
    const scale = Number.parseFloat(styles.getPropertyValue('--k-prose-scale'));
    const extra = Number.parseFloat(styles.getPropertyValue('--k-cc-track-extra'));
    return Math.round(base * (Number.isFinite(scale) ? scale : TOKEN_FALLBACKS['--k-prose-scale']) + (Number.isFinite(extra) ? extra : 0));
}

/**
 * The suppression pair this viewport demands, given the current preferences.
 *
 * Tokens are read off `documentElement`, deliberately: the rail widths live on
 * `:root` (tokens.css) and the pack loader writes pack values there too, while
 * the collapse override in `css/shell-frame.css` §5 lives on `<body>` — so this
 * read always sees the OPEN widths, even mid-collapse, and can never feed the
 * resolver its own output (a collapsed 0px width reading back as "plenty of
 * room" would oscillate).
 *
 * A preferred-collapsed rail contributes 0 and is never "suppressed" — there is
 * nothing to take away — which is what keeps a lone open rail alive at widths
 * where the pair would not fit: only the arithmetic that is actually failing
 * gets repaired.
 * @returns {{ left: boolean, right: boolean }}
 */
function computeSuppression() {
    const styles = getComputedStyle(document.documentElement);
    // The larger of the pack-raisable floor and the reading column itself: rails never
    // squeeze the prose. At reading size M that is 760px, so a 900-wide portrait yields
    // BOTH rails to the column instead of one (426px of text, 55 CPL, measured 2026-09-02).
    const minCenter = Math.max(readTokenPx(styles, '--k-center-readable-min'), readProseColumnPx());
    const leftWidth = preferred.left === 'open' ? readTokenPx(styles, '--k-rail-left-width') : 0;
    const rightWidth = preferred.right === 'open' ? readTokenPx(styles, '--k-rail-right-width') : 0;
    const next = { left: false, right: false };
    // A docked extension panel owns its edge (ext-dock.js), so the frame — and the usable
    // width — is the viewport minus the insets.
    const dock = getExtDockInsets();
    let center = window.innerWidth - dock.left - dock.right - leftWidth - rightWidth;
    if (center >= minCenter) return next;
    if (rightWidth > 0) {
        next.right = true;
        center += rightWidth;
    }
    if (center < minCenter && leftWidth > 0) {
        next.left = true;
    }
    return next;
}

/**
 * Re-resolves suppression for the current viewport and applies any change.
 *
 * Overrides are cleared on a pair change — they answered a viewport regime that
 * has ended — and focus is rescued from any rail the change closes, exactly as
 * a manual collapse would.
 * @returns {void}
 */
function updateSuppression() {
    const next = computeSuppression();
    if (next.left === suppressed.left && next.right === suppressed.right) return;
    const before = { left: effectiveState('left'), right: effectiveState('right') };
    suppressed = next;
    overrides = { left: null, right: null };
    for (const side of RAIL_SIDES) {
        if (before[side] === 'open' && effectiveState(side) === 'collapsed') {
            rescueFocus(side);
        }
    }
    apply();
}

/**
 * Keeps each handle's label and `aria-expanded` in step with the EFFECTIVE
 * state it drives — the screen, not the stored preference (smoke 2026-08-25
 * acceptance: `aria-expanded` must describe what is rendered).
 * @returns {void}
 */
function refreshHandles() {
    for (const side of RAIL_SIDES) {
        const button = handles.get(side);
        if (!button) continue;
        const open = effectiveState(side) === 'open';
        const label = `${open ? 'Collapse' : 'Expand'} ${SIDE_LABEL[side]} rail (${SIDE_HOTKEY[side]})`;
        button.setAttribute('aria-expanded', String(open));
        button.setAttribute('aria-label', label);
        button.title = label;
    }
}

/**
 * Writes the current EFFECTIVE pair onto `<body>` and refreshes the handles.
 *
 * Both attributes are always written, never omitted for the default: the sheet
 * reads `open` as a real state (the right handle's chevron points right while
 * its rail is open), and an attribute that is sometimes absent would make every
 * selector in §5 carry a `:not()` twin.
 * @returns {void}
 */
function apply() {
    document.body.dataset.kRailLeft = effectiveState('left');
    document.body.dataset.kRailRight = effectiveState('right');
    refreshHandles();
}

/**
 * Moves focus out of a rail that is about to disappear.
 *
 * `visibility: hidden` drops the subtree out of the tab order but does not, by
 * itself, take focus off a node that already had it — and a focused invisible
 * element is a keyboard dead end. Handing focus to that side's handle is also
 * what dismisses anything the focused control had spawned into `<body>` (a
 * select2 dropdown, a Popper menu): those close on focusout, so the orphaned
 * overlay never happens rather than being cleaned up afterwards.
 * @param {'left' | 'right'} side
 * @returns {void}
 */
function rescueFocus(side) {
    const rail = document.getElementById(RAIL_SLOT_ID[side]);
    const active = document.activeElement;
    if (!rail || !(active instanceof HTMLElement) || !rail.contains(active)) {
        return;
    }
    const handle = handles.get(side);
    if (handle) {
        handle.focus({ preventScroll: true });
    } else {
        active.blur();
    }
}

/**
 * The current EFFECTIVE pair — what is on screen. A copy — callers must not be
 * able to edit the live state.
 * @returns {import('./persistence.js').RailStates}
 */
export function getRailStates() {
    return { left: effectiveState('left'), right: effectiveState('right') };
}

/**
 * Requests one rail state. A no-op when the screen already shows it, so a
 * repeated expand request costs nothing.
 *
 * Two regimes, split by the resolver: on a side it has suppressed, the request
 * becomes a session OVERRIDE — applied live, never persisted, gone when the
 * viewport regime changes — because "resizing a window should not destroy the
 * user's desktop preference" cuts both ways: neither should a cramped-window
 * expand overwrite it. On a free side it is the plain preference change it
 * always was, persisted via `saveRails`.
 * @param {'left' | 'right'} side
 * @param {import('./persistence.js').RailState} state
 * @returns {void}
 */
export function setRail(side, state) {
    // Classic has no rails. Writing `data-k-rail-*` there would describe a layout
    // that is not on screen and would persist a choice the user never made in a
    // place they cannot see or undo — spec §3.6: classic ignores the setting.
    if (!installed) {
        console.warn('[Kotatsu shell] rail collapse is a rails-layout feature; the current layout has no rails.');
        return;
    }
    if (side !== 'left' && side !== 'right') {
        console.warn(`[Kotatsu shell] "${side}" is not a rail side; ignoring.`);
        return;
    }
    if (state !== 'open' && state !== 'collapsed') {
        console.warn(`[Kotatsu shell] "${state}" is not a rail state; ignoring.`);
        return;
    }
    if (suppressed[side]) {
        if (effectiveState(side) === state) return;
        if (state === 'collapsed') {
            rescueFocus(side);
        }
        overrides = { ...overrides, [side]: state };
        apply();
        return;
    }
    if (preferred[side] === state) return;
    if (state === 'collapsed') {
        rescueFocus(side);
    }
    const before = { left: effectiveState('left'), right: effectiveState('right') };
    preferred = { ...preferred, [side]: state };
    // Re-resolve before painting: opening a rail can push the OTHER side under
    // the readable floor (and collapsing one can hand a suppressed side its
    // width back). Same pair-change contract as a resize.
    const next = computeSuppression();
    if (next.left !== suppressed.left || next.right !== suppressed.right) {
        suppressed = next;
        overrides = { left: null, right: null };
    }
    for (const other of RAIL_SIDES) {
        if (other !== side && before[other] === 'open' && effectiveState(other) === 'collapsed') {
            rescueFocus(other);
        }
    }
    apply();
    saveRails(preferred);
}

/**
 * Toggles from the EFFECTIVE state — the handle the user just clicked shows the
 * screen's chevron, so the toggle must answer the screen.
 * @param {'left' | 'right'} side
 * @returns {void}
 */
export function toggleRail(side) {
    setRail(side, effectiveState(side) === 'open' ? 'collapsed' : 'open');
}

/**
 * `Ctrl+\` toggles the left rail, `Ctrl+Shift+\` the right (spec §3.2 — the top
 * bar gets no new buttons, it is full).
 *
 * Bubble phase on `document`, NOT capture, and that is the whole conflict story.
 * Core's quick-reply editor binds `Ctrl+Backslash` to "toggle block comment" on
 * its own textarea (`QuickReply.js:736`) and calls `stopImmediatePropagation()`
 * plus `preventDefault()`. From the bubble phase that handler has already run
 * and the event never reaches us — an element-scoped editor binding wins over a
 * global chrome binding for free, with no allowlist to maintain. The
 * `defaultPrevented` check is the same deference for any future claimant that
 * prevents without stopping. Nothing else in core takes the key: the audit
 * behind `OPEN_HOTKEY` (kotatsu/branches/k-branch-map.js:58-80) covers every
 * keydown handler core ships, and `input-md-formatting.js:14-48` only ever
 * matches KeyB/KeyI/KeyU/KeyK and Ctrl+Shift+Backquote.
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function handleKeyDown(event) {
    if (event.defaultPrevented) return;
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    const isBackslash = event.code
        ? BACKSLASH_CODES.has(event.code)
        : BACKSLASH_KEYS.has(event.key);
    if (!isBackslash) return;
    event.preventDefault();
    toggleRail(event.shiftKey ? 'right' : 'left');
}

/**
 * @param {Event} event
 * @returns {void}
 */
function handleExpandRequest(event) {
    const detail = event instanceof CustomEvent ? event.detail : null;
    const side = detail && typeof detail === 'object' ? detail.side : null;
    if (side === 'left' || side === 'right') {
        setRail(side, 'open');
    }
}

/**
 * Settles the rails once real settings exist.
 *
 * The install runs at the `firstLoadInit()` seam, before getSettings(), so what
 * painted came from the localStorage mirror. If `power_user.kotatsu_rails`
 * arrives later disagreeing — a settings file synced from another machine, a
 * fresh profile on this one — it is applied LIVE and the mirror corrected. This
 * is the one place rail state is friendlier than the layout choice: collapsing
 * needs no reload, so the settings value wins immediately instead of on the next
 * load, and no save is triggered (the value came FROM settings; writing it back
 * would be laundering, and would arm a debounce for nothing).
 * @returns {void}
 */
function reconcileWithSettings() {
    const stored = power_user?.kotatsu_rails;
    if (!stored || typeof stored !== 'object') return;
    const next = normalizeRailStates(stored);
    if (next.left === preferred.left && next.right === preferred.right) return;
    preferred = next;
    const pair = computeSuppression();
    if (pair.left !== suppressed.left || pair.right !== suppressed.right) {
        suppressed = pair;
        overrides = { left: null, right: null };
    }
    apply();
    mirrorRails(preferred);
}

/**
 * Mounts the handles, binds the key, and applies the stored pair.
 *
 * Handles are appended to `#k-shell` rather than to the rails they drive: a
 * collapsed rail's interior is `visibility: hidden`, so a handle living inside
 * it would vanish with the thing it is supposed to bring back. `#k-shell` is
 * already `position: fixed`, so hosting them there adds no containing block that
 * anything in the centre track could accidentally resolve against.
 * @returns {void}
 */
export function installRailCollapse() {
    if (installed) return;
    installed = true;

    preferred = readStoredRails();
    // Resolve before the first apply(): a window that boots at 768px must never
    // paint the stored open/open literally (smoke 2026-08-25 P1 acceptance).
    // The first-paint script in index.html only mirrors COLLAPSED sides, so
    // this is also where a too-narrow boot first learns to let go.
    suppressed = computeSuppression();

    const shell = document.getElementById('k-shell');
    if (shell) {
        for (const side of RAIL_SIDES) {
            const handle = buildHandle(side);
            handles.set(side, handle);
            shell.appendChild(handle);
        }
        scrim = document.createElement('div');
        scrim.className = SCRIM_CLASS;
        scrim.setAttribute('aria-hidden', 'true');
        scrim.addEventListener('click', closePhoneOverlays);
        shell.appendChild(scrim);
    } else {
        console.warn('[Kotatsu shell] #k-shell is missing; rail handles were not mounted. The keyboard toggles still work.');
    }

    apply();

    onKeyDown = handleKeyDown;
    document.addEventListener('keydown', onKeyDown);
    onExpandRequest = handleExpandRequest;
    document.addEventListener(EXPAND_RAIL_EVENT, onExpandRequest);
    onSettingsLoaded = reconcileWithSettings;
    eventSource.on(event_types.SETTINGS_LOADED, onSettingsLoaded);
    onResize = () => {
        if (resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
            resizeFrame = 0;
            updateSuppression();
        });
    };
    window.addEventListener('resize', onResize);
    // The reading column is part of the floor; a size change is a resize in disguise.
    onProseScale = () => updateSuppression();
    document.addEventListener(PROSE_SCALE_EVENT, onProseScale);
    // So is a look that widens the track (`--k-cc-track-extra`): the door bubbles this
    // off #chat whenever an axis value changes, and only then.
    onVariantChange = () => updateSuppression();
    document.addEventListener(VARIANT_AXIS_EVENT, onVariantChange);
    // A foreign panel docking or leaving an edge changes the usable width the same way.
    document.addEventListener(EXT_DOCK_EVENT, onVariantChange);
    onChatChanged = closePhoneOverlays;
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    onRailPick = (event) => {
        if (event.target instanceof Element && event.target.closest(PICK_SELECTOR)) {
            closePhoneOverlays();
        }
    };
    document.getElementById(RAIL_SLOT_ID.left)?.addEventListener('click', onRailPick);
}

/**
 * Removes every listener, node and body attribute this module added. Symmetry
 * for {@link installRailCollapse}: classic must not inherit a stray
 * `data-k-rail-*`, because the sheet's `:not([data-k-rail-right="collapsed"])`
 * reading would then describe a layout that is not on screen.
 * @returns {void}
 */
export function uninstallRailCollapse() {
    if (!installed) return;
    installed = false;

    if (onKeyDown) {
        document.removeEventListener('keydown', onKeyDown);
        onKeyDown = null;
    }
    if (onExpandRequest) {
        document.removeEventListener(EXPAND_RAIL_EVENT, onExpandRequest);
        onExpandRequest = null;
    }
    if (onSettingsLoaded) {
        eventSource.removeListener(event_types.SETTINGS_LOADED, onSettingsLoaded);
        onSettingsLoaded = null;
    }
    if (onResize) {
        window.removeEventListener('resize', onResize);
        onResize = null;
    }
    if (onProseScale) {
        document.removeEventListener(PROSE_SCALE_EVENT, onProseScale);
        onProseScale = null;
    }
    if (onVariantChange) {
        document.removeEventListener(VARIANT_AXIS_EVENT, onVariantChange);
        document.removeEventListener(EXT_DOCK_EVENT, onVariantChange);
        onVariantChange = null;
    }
    if (onChatChanged) {
        eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
        onChatChanged = null;
    }
    if (onRailPick) {
        document.getElementById(RAIL_SLOT_ID.left)?.removeEventListener('click', onRailPick);
        onRailPick = null;
    }
    scrim?.remove();
    scrim = null;
    if (resizeFrame) {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = 0;
    }
    suppressed = { left: false, right: false };
    overrides = { left: null, right: null };

    for (const handle of handles.values()) {
        handle.remove();
    }
    handles.clear();

    delete document.body.dataset.kRailLeft;
    delete document.body.dataset.kRailRight;
}
