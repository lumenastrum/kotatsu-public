/**
 * The Sprite view's backdrop, against core (docs/stage-backdrop-v0.md). What a chat offers and how
 * its keys read are backdrop-state.js's; this file reads `chat` / `chat_metadata`, writes core's
 * own per-chat background keys, paints `#bg1`, and announces the change.
 *
 * Core's background drawer is parked under rails (docs/shell-v0.md), so nothing else here sets a
 * chat's background; core still applies a locked one on every chat change (backgrounds.js
 * `onChatChanged`), which is what makes a backdrop stick to its chat.
 */

import { chat, chat_metadata, getCurrentChatId } from '../../script.js';
import { background_settings } from '../../scripts/backgrounds.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { saveMetadataDebounced } from '../../scripts/extensions.js';
import { humanizedDateTime } from '../../scripts/RossAscends-mods.js';
import { getBase64Async, getFileExtension, saveBase64AsFile } from '../../scripts/utils.js';
import { imagesFolder } from '../pictures/doors.js';
import { backdropChoices, cssUrl, normalPath, pathOf } from './backdrop-state.js';

/** Fired on `document` whenever the chat's backdrop may have changed (a pick, a chat switch). */
export const BACKDROP_CHANGE_EVENT = 'k-backdrop-change';

/** Core's keys (scripts/backgrounds.js BG_METADATA_KEY / LIST_METADATA_KEY), read and written as core does. */
const LOCK_KEY = 'custom_background';
const LIST_KEY = 'chat_backgrounds';

let installed = false;

function announce() {
    document.dispatchEvent(new CustomEvent(BACKDROP_CHANGE_EVENT, { bubbles: true }));
}

/** @param {string} value A CSS `url(...)`, or '' */
function paint(value) {
    const bg = document.getElementById('bg1');
    if (bg) bg.style.backgroundImage = value;
}

/** @returns {boolean} Whether there is a chat to hold a backdrop. */
export function canHoldBackdrop() {
    return Boolean(getCurrentChatId());
}

/** @returns {string} The path of this chat's backdrop, or '' for none. */
export function backdropNow() {
    return pathOf(chat_metadata?.[LOCK_KEY]);
}

/** @returns {import('./backdrop-state.js').BackdropChoice[]} What this chat can use as its backdrop. */
export function listBackdrops() {
    return backdropChoices({ messages: Array.isArray(chat) ? chat : [], chatBackgrounds: chat_metadata?.[LIST_KEY], locked: chat_metadata?.[LOCK_KEY] });
}

/**
 * Makes an image this chat's backdrop. A path the chat has not listed yet goes through core's own
 * `FORCE_SET_BACKGROUND` (lock, list, paint — the stock image extension's hook); a listed one is
 * only re-locked, because core's handler appends without checking and would list it twice.
 * @param {string} path An image under `user/images/` or `backgrounds/`.
 * @returns {Promise<boolean>} Whether the chat now has it.
 */
export async function setBackdrop(path) {
    path = normalPath(path);
    if (!canHoldBackdrop() || !path) return false;
    const url = cssUrl(path);
    const list = Array.isArray(chat_metadata[LIST_KEY]) ? chat_metadata[LIST_KEY] : [];
    if (list.some(entry => normalPath(entry) === path)) {
        chat_metadata[LOCK_KEY] = url;
        paint(url);
        saveMetadataDebounced();
    } else {
        await eventSource.emit(event_types.FORCE_SET_BACKGROUND, { url, path });
    }
    announce();
    return true;
}

/**
 * No backdrop for this chat: core's unlock, back to the global background (if one was ever picked
 * in classic). The image stays in the chat's list.
 * @returns {void}
 */
export function clearBackdrop() {
    if (!canHoldBackdrop()) return;
    delete chat_metadata[LOCK_KEY];
    paint(background_settings?.url ?? '');
    saveMetadataDebounced();
    announce();
}

/**
 * Uploads an image into this chat's folder (where core's chat-background upload and Kotatsu's
 * pictures both go) and makes it the backdrop.
 * @param {File} file
 * @returns {Promise<boolean>}
 */
export async function uploadBackdrop(file) {
    if (!canHoldBackdrop() || !(file instanceof File) || !file.type.startsWith('image/')) return false;
    const folder = imagesFolder();
    if (!folder) return false;
    const base64 = String(await getBase64Async(file)).split(',')[1] ?? '';
    const path = await saveBase64AsFile(base64, folder, `${folder}_${humanizedDateTime()}`, getFileExtension(file));
    return typeof path === 'string' && path ? setBackdrop(path) : false;
}

/**
 * Tells the picker when a chat change or a new picture changes what it should show. Once.
 * @returns {void}
 */
export function installBackdrop() {
    if (installed) return;
    installed = true;
    for (const type of [event_types.CHAT_CHANGED, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_DELETED]) {
        if (typeof type === 'string') eventSource.on(type, announce);
    }
}
