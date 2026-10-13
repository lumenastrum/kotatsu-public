/**
 * Sprites — each message row's face in the Sprite look (Pictures slice F, step 2).
 *
 * Every character row keeps ITS OWN expression (a face crop of that message's sprite) so history
 * stays readable while the stage shows only now. Painted as a row custom property
 * (`--k-mes-sprite`) plus `data-k-sprite="<label>"`, the same one-write mechanism as
 * `--k-mes-avatar` (`message-rows.js` `setRowAvatarProps`); `resetRowConditionals` clears both
 * when core reuses a row. A row with no face keeps the card avatar.
 *
 * In the Sprite look the rows on screen that have no label yet are queued for classifying (old
 * chats, messages written before a sprite set existed); each answer repaints its row and the
 * stage through `EXPRESSION_EVENT`.
 */

import { chat } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { VARIANT_AXIS_EVENT, rowFor } from '../../scripts/message-rows.js';
import { readStoredExpression } from './expression-model.js';
import { EXPRESSION_EVENT, expressionFor, scheduleClassify, stageCharacterFor } from './expressions.js';
import { spriteLookActive } from './k-sprite-stage.js';
import { FRAMING_EVENT, readFraming } from './framing.js';
import { SPRITES_EVENT, spriteSetFor } from './sprite-sets.js';

let installed = false;

/**
 * @param {HTMLElement} row
 * @returns {void}
 */
function clearRow(row) {
    row.removeAttribute('data-k-sprite');
    row.style.removeProperty('--k-mes-sprite');
    row.style.removeProperty('--k-sprite-face-y');
    row.style.removeProperty('--k-sprite-face-zoom');
}

/**
 * Paints one row's face (or clears it outside the Sprite look).
 * @param {number|string} id
 * @returns {Promise<void>}
 */
export async function paintRowFace(id) {
    const message = chat[Number(id)];
    const row = rowFor(message);
    if (!row) return;
    if (!spriteLookActive()) return clearRow(row);
    const face = await expressionFor(id);
    if (rowFor(message) !== row) return;
    if (!face?.url) return clearRow(row);
    row.dataset.kSprite = face.label;
    row.style.setProperty('--k-mes-sprite', `url("${face.url.replace(/"/g, '\\"')}")`);
    // The character's face spot (framing.js): the chip crops where their face actually sits.
    const framing = readFraming(stageCharacterFor(message));
    row.style.setProperty('--k-sprite-face-y', `${(framing.faceY * 100).toFixed(1)}%`);
    row.style.setProperty('--k-sprite-face-zoom', `${(framing.faceZoom * 100).toFixed(0)}%`);
}

/**
 * Paints every row on screen; in the Sprite look also queues the unlabelled ones whose
 * character has sprites.
 * @returns {Promise<void>}
 */
export async function sweepRowFaces() {
    const active = spriteLookActive();
    for (let id = 0; id < chat.length; id += 1) {
        const row = rowFor(chat[id]);
        if (!row) continue;
        if (!active) {
            clearRow(row);
            continue;
        }
        void paintRowFace(id);
        const character = stageCharacterFor(chat[id]);
        if (character && !readStoredExpression(chat[id]) && (await spriteSetFor(character)).labels.size) {
            void scheduleClassify(id);
        }
    }
}

/** @param {Event} event */
function onExpression(event) {
    const id = /** @type {CustomEvent} */ (event).detail?.messageId;
    if (Number.isInteger(id)) void paintRowFace(id);
}

/** @param {number|string} id */
function onRow(id) {
    void paintRowFace(id);
}

function onSweep() {
    void sweepRowFaces();
}

/** @returns {void} */
export function installRowFaces() {
    if (installed) return;
    installed = true;
    document.addEventListener(EXPRESSION_EVENT, onExpression);
    document.addEventListener(VARIANT_AXIS_EVENT, onSweep);
    document.addEventListener(FRAMING_EVENT, onSweep);
    document.addEventListener(SPRITES_EVENT, onSweep);
    for (const type of [event_types.CHARACTER_MESSAGE_RENDERED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED]) eventSource.on(type, onRow);
    for (const type of [event_types.CHAT_CHANGED, event_types.MORE_MESSAGES_LOADED]) eventSource.on(type, onSweep);
    void sweepRowFaces();
}

/** @returns {void} */
export function uninstallRowFaces() {
    if (!installed) return;
    installed = false;
    document.removeEventListener(EXPRESSION_EVENT, onExpression);
    document.removeEventListener(VARIANT_AXIS_EVENT, onSweep);
    document.removeEventListener(FRAMING_EVENT, onSweep);
    document.removeEventListener(SPRITES_EVENT, onSweep);
    for (const type of [event_types.CHARACTER_MESSAGE_RENDERED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED]) eventSource.removeListener(type, onRow);
    for (const type of [event_types.CHAT_CHANGED, event_types.MORE_MESSAGES_LOADED]) eventSource.removeListener(type, onSweep);
}
