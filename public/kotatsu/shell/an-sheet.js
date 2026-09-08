/**
 * Kotatsu shell — the Author's Note as a sheet (shell QoL v0 slice, Tier 1).
 * docs/shell-qol-v0.md §3.
 *
 * `#floatingPrompt` is a frozen id (CONTRACT.md §1.6) and a direct child of
 * `#movingDivs`. This module does not move it, wrap it, or rebuild it — the node
 * stays exactly where core put it, with every jQuery handler in
 * scripts/authors-note.js still bound to the same element. What it adds under
 * rails is the part core never had: a scrim, a way out, and a clean start.
 *
 * Three rules shape everything below.
 *
 * 1. **authors-note.js is the only writer of `display` and `opacity`.** It fades
 *    the panel in on `#option_toggle_AN` (`:401-412`) and hides it after the
 *    fade on `#ANClose` (`:491-498`). This module OBSERVES that inline state and
 *    never writes it. Closing goes through a real `#ANClose.click()` so core's
 *    own transition and hide still run; a class flip of our own would strand the
 *    panel half-faded and leave core's idea of the state wrong.
 * 2. **Escape is already spoken for.** RossAscends-mods.js:1262-1265 closes the
 *    Author's Note from a bubble-phase `$(document).on('keydown')` cascade, so a
 *    naive capture-phase handler on top of that fires `#ANClose` twice — the
 *    panel is still `:visible` during the fade. The handler here is capture
 *    phase so that the topmost surface (z 4000) answers Escape before anything
 *    downstream of it can, and it CONSUMES the key: `stopPropagation()` at
 *    document capture means the bubble listener on the same node never runs, so
 *    there is exactly one close. It stands down whenever something more
 *    immediate is open — the same discipline the settings modal's own handler
 *    takes (k-settings-modal.js:#handleEscape), and for the same reason.
 * 3. **Rails-only.** Installed by the rails layout's mount, removed by its
 *    unmount. Classic never sees a listener, a node or a body class from here.
 */

import { power_user } from '../../scripts/power-user.js';
import { isSettingsModalOpen } from '../settings/k-settings-modal.js';

/** Set on `<body>` while the Author's Note is up. css/shell-panels.css §2 does the rest. */
const OPEN_CLASS = 'k-an-open';

/** Our own scrim, at z 3999. The settings modal likewise draws its own, at 4090. */
const SCRIM_ID = 'k-an-scrim';

/**
 * Inline box properties a MovingUI session may have left on the panel.
 * Exactly core's own reset list (`resetMovablePanels()`, power-user.js:2755) —
 * and deliberately WITHOUT `display` and `opacity`, which are authors-note.js's.
 */
const MOVING_UI_PROPERTIES = ['top', 'left', 'right', 'bottom', 'height', 'width', 'margin'];

let installed = false;

/** @type {MutationObserver|null} */
let panelObserver = null;

/**
 * @returns {HTMLElement|null} The Author's Note panel, or null before core builds it.
 */
function getPanel() {
    return document.getElementById('floatingPrompt');
}

/**
 * Whether an element is rendered at all.
 * @param {Element|null} element
 * @returns {boolean}
 */
function isShown(element) {
    return element instanceof HTMLElement && getComputedStyle(element).display !== 'none';
}

/**
 * Reads the panel's visibility off the INLINE `display` rather than the computed
 * one.
 *
 * The inline value is the signal: core's base rule is `display: none`
 * (style.css:2957-2980) and authors-note.js writes `flex` inline to open and
 * `none` inline to close, so an empty inline value means "never opened this
 * session" — closed. Reading the inline string also costs nothing, which matters
 * because the observer below fires on every frame of core's opacity transition;
 * `getComputedStyle()` there would force a style recalc per frame.
 * @returns {boolean}
 */
export function isAuthorsNoteOpen() {
    const panel = getPanel();
    if (!panel) return false;
    return panel.style.display !== '' && panel.style.display !== 'none';
}

/**
 * Brings the body class (and so the scrim) in line with the panel.
 * @returns {void}
 */
function syncOpenState() {
    document.body.classList.toggle(OPEN_CLASS, isAuthorsNoteOpen());
}

/**
 * Closes the Author's Note through core's own path.
 * @returns {void}
 */
function closeAuthorsNote() {
    const close = document.getElementById('ANClose');
    if (!close) {
        console.warn('[k-an-sheet] #ANClose is missing; the Author\'s Note cannot be closed from the sheet.');
        return;
    }
    close.click();
}

/**
 * @param {MouseEvent} event
 * @returns {void}
 */
function onScrimClick(event) {
    if (!(event.target instanceof Element) || event.target.id !== SCRIM_ID) return;
    if (!isAuthorsNoteOpen()) return;
    closeAuthorsNote();
}

/**
 * Escape closes the sheet — but only when it is the outermost thing Escape could
 * mean.
 *
 * See rule 2 in the module header for why this is capture phase and why it stands
 * down. The checks mirror the head of core's own cascade: script.js owns Escape
 * while a message is being edited or a generation is streaming, and
 * RossAscends-mods.js:1193-1196 defers to it there; a popup layered over the
 * panel outranks the panel.
 *
 * The settings modal is the fourth standdown, and since v0.1 it is a BELT
 * rather than the mechanism. Its Escape handler is a **window**-capture
 * listener that calls `stopImmediatePropagation()`, and capture runs window →
 * document, so with both surfaces up this listener is never reached at all:
 * the modal closes, and the next press closes the note. The check stays anyway,
 * because "one Escape, one surface" is an invariant this file is responsible
 * for and not a conclusion it should have to re-derive from event phases if the
 * modal ever moves its listener. (Until v0.1 the fourth standdown was the
 * settings OVERLAY's, which listened on `document` in the same phase as this
 * one and really was load-bearing — `stopPropagation()` does not stop a sibling
 * listener on the same node.)
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function onEscapeCapture(event) {
    if (event.key !== 'Escape') return;
    if (!isAuthorsNoteOpen()) return;
    if (isShown(document.getElementById('curEditTextarea'))) return;
    if (isShown(document.getElementById('mes_stop'))) return;
    if (document.querySelector('dialog.popup[open]')) return;
    if (isShown(document.getElementById('shadow_popup'))) return;
    if (isSettingsModalOpen()) return;
    event.stopPropagation();
    event.preventDefault();
    closeAuthorsNote();
}

/**
 * Clears inline box geometry a MovingUI session may have left behind.
 *
 * `loadMovingUIState()` (power-user.js:1914-1937) only replays a stored box when
 * `power_user.movingUI` is true, so with the setting off any inline geometry on
 * the panel is residue from earlier in THIS session — the user dragged it, then
 * turned MovingUI off. Under rails that residue would be an invisible offset
 * nobody can correct, because the grab handle is hidden (css/shell-panels.css §3).
 * With the setting ON the stored box is a live preference and is left alone;
 * §1's `!important` geometry outranks it anyway.
 *
 * Timing, stated plainly: at the boot seam this is a no-op, because it runs
 * before getSettings() and nothing has written to the panel yet either. It earns
 * its keep on a live re-mount — `applyLayout()` unmounts and mounts without a
 * reload (registry.js:153-180), which is exactly when `power_user` is populated
 * and a real box may be sitting on the node.
 * @returns {void}
 */
function clearStaleMovingUIGeometry() {
    if (power_user?.movingUI) return;
    const panel = getPanel();
    if (!panel) return;
    for (const property of MOVING_UI_PROPERTIES) {
        panel.style.removeProperty(property);
    }
}

/**
 * Wires the sheet up: scrim node, panel observer, Escape.
 * @returns {void}
 */
export function installAnSheet() {
    if (installed) return;
    installed = true;

    clearStaleMovingUIGeometry();

    let scrim = document.getElementById(SCRIM_ID);
    if (!scrim) {
        scrim = document.createElement('div');
        scrim.id = SCRIM_ID;
        document.body.appendChild(scrim);
    }
    scrim.addEventListener('click', onScrimClick);

    const panel = getPanel();
    if (panel) {
        // `style` only, and observe-only: this module must never become a second
        // writer of the attribute it is reading.
        panelObserver = new MutationObserver(syncOpenState);
        panelObserver.observe(panel, { attributes: true, attributeFilter: ['style'] });
    } else {
        console.warn('[k-an-sheet] #floatingPrompt is missing; the Author\'s Note sheet is inert.');
    }

    document.addEventListener('keydown', onEscapeCapture, { capture: true });
    syncOpenState();
}

/**
 * Removes every listener, node and class this module added. The panel itself is
 * left exactly as core has it — including open, which classic renders correctly.
 * @returns {void}
 */
export function uninstallAnSheet() {
    if (!installed) return;
    installed = false;

    panelObserver?.disconnect();
    panelObserver = null;

    document.removeEventListener('keydown', onEscapeCapture, { capture: true });

    const scrim = document.getElementById(SCRIM_ID);
    scrim?.removeEventListener('click', onScrimClick);
    scrim?.remove();

    document.body.classList.remove(OPEN_CLASS);
}
