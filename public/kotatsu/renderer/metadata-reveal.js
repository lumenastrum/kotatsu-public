/**
 * Kotatsu metadata reveal — variant-wardrobe v0 slice B item 3.
 *
 * `metadata=click` needs a way to open one row's small chrome. ONE delegated listener on
 * `#chat` toggles `.k-meta-open` on the clicked row — never per-row listeners: the keyed row
 * engine reuses and rebuilds rows constantly, so a thousand listeners would be a thousand
 * rebinds. `#chat`'s node identity is frozen by CONTRACT §1.7 (moved, never replaced), so one
 * registration at the `firstLoadInit()` seam outlives every re-render and every layout switch.
 *
 * Inert unless the axis is live: the handler reads the axis on each click instead of being
 * added and removed, so pack switches and picker changes need no bookkeeping. A row left
 * carrying `.k-meta-open` after the axis moves off `click` is inert too — the wardrobe sheet
 * only matches that class under `#chat[data-k-mes-metadata="click"]`.
 *
 * This absorbs Moonlit's ~100-line `enableMessageDetails` checkbox (renderer v0 §2.5).
 *
 * The Sprite look uses the same tap (2026-10-22): a visual novel is read, so a row's controls
 * and readouts stay tucked until the person taps that message (mes-variants.css §8), whatever the
 * metadata axis says. See {@link revealActive}.
 */
import { getVariantAxis } from '../../scripts/message-rows.js';

/** The row class the wardrobe sheet's `metadata=click` rules key on. */
export const METADATA_OPEN_CLASS = 'k-meta-open';

/**
 * Clicks that belong to something else and must not double as a reveal toggle. `.mes_buttons`
 * lives INSIDE `.ch_name` (CONTRACT §1.7); the edit textarea is `#curEditTextarea.edit_textarea`
 * and is covered by the bare `textarea`; code blocks ship their own `.code-copy`; the avatar and
 * the reasoning `summary` already own their clicks.
 */
const IGNORED_SELECTORS = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[contenteditable="true"]',
    '.mes_buttons',
    '.mes_edit_buttons',
    '.swipe_left',
    '.swipe_right',
    '.avatar',
    '.code-copy',
    'summary',
].join(', ');

let installed = false;

/**
 * Decides which row (if any) a click should toggle. Pure apart from the target's own `closest`,
 * so the exclusion policy is unit-testable without a DOM.
 * @param {Element|null|undefined} target Click target.
 * @param {boolean} hasSelection Whether a non-collapsed selection exists — a drag, not a click.
 * @returns {Element|null} The row to toggle, or null when the click belongs to something else.
 */
export function revealTargetRow(target, hasSelection) {
    if (hasSelection || !target || typeof target.closest !== 'function') return null;
    if (target.closest(IGNORED_SELECTORS)) return null;
    return target.closest('.mes');
}

/**
 * Whether a tap on a row toggles its chrome: under `metadata=click`, and always in the Sprite look,
 * which tucks a row's controls and readouts for immersion (Andres, on his iPhone, 2026-10-22).
 * @param {{ metadata: string, message: string }} axes The live metadata and message axes.
 * @returns {boolean}
 */
export function revealActive({ metadata, message }) {
    return metadata === 'click' || message === 'sprite';
}

/**
 * @param {MouseEvent} event Delegated click.
 * @returns {void}
 */
function onChatClick(event) {
    if (!revealActive({ metadata: getVariantAxis('metadata'), message: getVariantAxis('message') })) return;

    const selection = typeof document.getSelection === 'function' ? document.getSelection() : null;
    const hasSelection = Boolean(selection && !selection.isCollapsed);
    const row = revealTargetRow(/** @type {*} */ (event.target), hasSelection);
    row?.classList.toggle(METADATA_OPEN_CLASS);
}

/**
 * Registers the delegated handler. Idempotent; called once from `initKotatsuShell()`.
 * @returns {void}
 */
export function initMetadataReveal() {
    if (installed) return;

    const chat = document.getElementById('chat');
    if (!chat) {
        console.warn('[Kotatsu renderer] #chat is missing; the metadata reveal handler was not installed.');
        return;
    }

    installed = true;
    chat.addEventListener('click', onChatClick);
}
