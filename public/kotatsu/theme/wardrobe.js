/**
 * Kotatsu wardrobe picker — variant-wardrobe v0 slice B item 4.
 *
 * Three native selects in the User Settings drawer, directly under the theme select, one per
 * variant axis. DOM only: this module never reads `power_user`, never persists, and never
 * writes `#chat` — it hands a chosen value back to the loader, which owns precedence and the
 * single DOM write site. That keeps the picker a VIEW of the resolution the loader already
 * performed, so a pack apply, a settings load, and a click on one of these selects all refresh
 * it through the same call.
 *
 * The option lists are built from the renderer's frozen known sets rather than hard-coded in
 * index.html: a new variant is a core change (SPEC §13) and the markup must not be able to
 * drift from it.
 */
import { ROW_AXES } from '../../scripts/message-rows.js';
import { VARIANT_AXES } from './core.js';

/** @typedef {import('./core.js').VariantAxis} VariantAxis */
/** @typedef {import('./core.js').VariantAxisDecisions} VariantAxisDecisions */

/**
 * @typedef {object} AxisUi
 * @property {string} selectId Element id of that axis's select.
 * @property {Record<string, string>} labels Human labels for its known set.
 */

/**
 * @typedef {object} WardrobeHandlers
 * @property {(axis: VariantAxis, value: string) => unknown} set Called when the user picks a value.
 */

/** @type {Readonly<Record<VariantAxis, AxisUi>>} */
const AXIS_UI = Object.freeze({
    message: {
        selectId: 'kotatsu_mes_variant',
        labels: {
            'card': 'Card',
            'flat': 'Flat',
            'bubble': 'Bubble',
            'script': 'Script',
            'bubble-split': 'Split bubbles',
            'portrait': 'Portrait',
            'portrait-column': 'Portrait column',
            'broadcast': 'Broadcast',
        },
    },
    nameplate: {
        selectId: 'kotatsu_mes_nameplate',
        labels: {
            'inline': 'Inline',
            'above': 'Above',
            'margin': 'Margin',
        },
    },
    metadata: {
        selectId: 'kotatsu_mes_metadata',
        labels: {
            'always': 'Always',
            'hover': 'On hover',
            'click': 'On click',
        },
    },
});

/** @type {WardrobeHandlers|null} */
let handlers = null;
let initialized = false;

/**
 * @param {VariantAxis} axis Axis whose select is wanted.
 * @returns {HTMLSelectElement|null} The select, or null when the drawer markup is absent.
 */
function getSelect(axis) {
    const element = document.getElementById(AXIS_UI[axis].selectId);
    return element instanceof HTMLSelectElement ? element : null;
}

/**
 * @param {VariantAxis} axis Axis whose pack note is wanted.
 * @returns {HTMLElement|null} The note line, or null when the drawer markup is absent.
 */
function getNote(axis) {
    return document.getElementById(`${AXIS_UI[axis].selectId}_note`);
}

/**
 * Fills one select from its axis's frozen known set.
 * @param {HTMLSelectElement} select Target select.
 * @param {VariantAxis} axis Axis being rendered.
 * @returns {void}
 */
function fillOptions(select, axis) {
    const { labels } = AXIS_UI[axis];
    select.replaceChildren();
    for (const value of ROW_AXES[axis].values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = labels[value] ?? value;
        select.append(option);
    }
}

/**
 * Builds the three selects and wires their change handlers. Called at the `firstLoadInit()`
 * seam, before the first resolution, so the very first render finds real options to select.
 * @param {WardrobeHandlers} options Callbacks into the loader.
 * @returns {void}
 */
export function initWardrobePicker(options) {
    if (initialized) return;
    initialized = true;
    handlers = options;

    for (const axis of VARIANT_AXES) {
        const select = getSelect(axis);
        if (!select) continue;
        fillOptions(select, axis);
        select.addEventListener('change', () => {
            handlers?.set(axis, select.value);
        });
    }
}

/**
 * Renders the resolution the loader just applied.
 *
 * A pack-pinned axis shows the pack's value, disabled, with the one-line note: the pack's
 * declaration is a property of the theme and must never become the user's setting, so the
 * honest UI is "you cannot edit this while that pack is on", not a silently overwritten choice.
 * An axis the pack pins to a name this build has never heard of shows the door's fallback —
 * what is actually live — rather than an option that does not exist.
 * @param {VariantAxisDecisions|null} decisions Per-axis decisions from the loader.
 * @param {string|null} packName Display name of the active pack, when one is applied.
 * @returns {void}
 */
export function renderWardrobePicker(decisions, packName) {
    for (const axis of VARIANT_AXES) {
        const decision = decisions?.[axis];
        if (!decision) continue;

        const { values, fallback } = ROW_AXES[axis];
        const select = getSelect(axis);
        if (select) {
            const requested = decision.variant;
            select.value = requested !== null && values.includes(requested) ? requested : fallback;
            select.disabled = decision.source === 'pack';
        }

        const note = getNote(axis);
        if (note) {
            const pinned = decision.source === 'pack';
            note.textContent = pinned
                ? `Set by ${packName ?? 'the active theme pack'} — clear the pack theme to choose.`
                : '';
            note.hidden = !pinned;
        }
    }
}
