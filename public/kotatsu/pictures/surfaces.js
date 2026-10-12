/**
 * Pictures v0, slice B — the rails install for every client surface (docs/pictures-v0.md §2.3).
 *
 * Called from the rails layout's mount, right after the portrait peek; unmount takes it all back,
 * so the classic layout has none of it (the paintbrush node in `#message_template` stays, hidden
 * by `css/pictures.css`, and its click finds no listener).
 *
 * - the paintbrush (`.k-picture-gen` in `.extraMesButtons`): one delegated click listener on
 *   `#chat` → the sheet on This moment for that row's message;
 * - the composer's wand: a "Draw a picture" item in `#k_picture_wand_container`;
 * - `/imagine` (registered once; it stands down under classic);
 * - the tile menu's paint drivers and the pending rows' chat door.
 */

import { eventSource, event_types } from '../../scripts/events.js';
import { registerPictureCommands } from './commands.js';
import { PURPOSES } from './contract.js';
import { installPictureMenus, sweepPictureMenus, uninstallPictureMenus } from './k-picture-menu.js';
import { installPictureJobs, openPictureSheet, picturesJobsState, uninstallPictureJobs } from './picture-actions.js';

const WAND_CONTAINER_ID = 'k_picture_wand_container';
const WAND_ITEM_ID = 'k_picture_wand';

/** Inline stroke icon shared by the paintbrush and the wand item (a brush over a frame). */
export const PICTURE_ICON_SVG = '<svg class="k-pic-gen-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" '
    + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M13.5 9v3a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3"/>'
    + '<path d="M2.5 11l3-3 2.5 2.5"/><path d="M14 2l-4.5 4.5-1 2.5 2.5-1L15.5 3.5z"/></svg>';

/** @type {HTMLElement|null} */
let boundChat = null;

/**
 * The paintbrush, delegated: the template node is cloned into every row, the listener lives once.
 * @param {MouseEvent} event
 */
function onChatClick(event) {
    const target = /** @type {Element|null} */ (event.target);
    const button = target && typeof target.closest === 'function' ? target.closest('.k-picture-gen') : null;
    if (!(button instanceof HTMLElement) || !boundChat?.contains(button)) return;
    const row = button.closest('.mes');
    const mesid = Number(row?.getAttribute('mesid'));
    void openPictureSheet({
        purpose: PURPOSES.MOMENT,
        messageIndex: Number.isInteger(mesid) && mesid >= 0 ? mesid : undefined,
    });
}

/** Puts the wand item in its container (the wand menu is rendered by core's extension boot). */
function fillWand() {
    const container = document.getElementById(WAND_CONTAINER_ID);
    if (!container || container.querySelector(`#${WAND_ITEM_ID}`)) return;
    const item = document.createElement('div');
    item.id = WAND_ITEM_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.title = 'Draw a picture';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    const icon = document.createElement('div');
    icon.className = 'extensionsMenuExtensionButton k-picture-wand-icon';
    icon.innerHTML = PICTURE_ICON_SVG;
    const label = document.createElement('span');
    label.textContent = 'Draw a picture';
    item.append(icon, label);
    item.addEventListener('click', () => void openPictureSheet({}));
    item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void openPictureSheet({});
        }
    });
    container.append(item);
}

/** @returns {void} */
export function installPictureSurfaces() {
    const chat = document.getElementById('chat');
    if (chat && !boundChat) {
        boundChat = chat;
        chat.addEventListener('click', onChatClick);
    }
    // APP_READY auto-fires for late listeners, so this fills the wand now or when it exists.
    eventSource.on(event_types.APP_READY, fillWand);
    fillWand();
    registerPictureCommands();
    installPictureMenus();
    installPictureJobs();

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') targetWindow.kotatsu = {};
    targetWindow.kotatsu.pictures = {
        open: openPictureSheet,
        jobs: picturesJobsState,
        sweep: sweepPictureMenus,
    };
}

/** @returns {void} */
export function uninstallPictureSurfaces() {
    boundChat?.removeEventListener('click', onChatClick);
    boundChat = null;
    eventSource.removeListener(event_types.APP_READY, fillWand);
    document.getElementById(WAND_ITEM_ID)?.remove();
    uninstallPictureMenus();
    uninstallPictureJobs();
}
