/**
 * A scene's chat files, for the rail and the chat switcher (`docs/group-chat-v0.md` G1).
 *
 * One request: `/api/chats/search` with `group_id` (`src/endpoints/chats.js:952-1050`), the
 * endpoint core's own "Manage chat files" view uses for groups (`displayPastChats`,
 * `script.js:9000-9060`). Core also exports `getGroupPastChats()` (`group-chats.js:2162`), but
 * that one makes a request per chat and nothing in core calls it.
 *
 * Navigation and rename go through core's exported paths only — `openGroupChat()` and
 * `renameGroupOrCharacterChat()` — so the group record's `chat_id`/`chats[]` bookkeeping and
 * the CHAT_CHANGED / CHAT_RENAMED events stay core's.
 */

import { getCurrentChatId, getRequestHeaders, renameGroupOrCharacterChat } from '../../script.js';
import { groups, openGroupChat, selected_group } from '../../scripts/group-chats.js';
import { timestampToMoment } from '../../scripts/utils.js';

/**
 * @typedef {object} SceneChatRow
 * @property {string} id Extension-less chat id — what `openGroupChat()` takes.
 * @property {string} title The chat file's own name.
 * @property {number|null} count `message_count` when the endpoint supplied one.
 * @property {number} lastMs Last message time, epoch ms, 0 when unknown.
 * @property {string} preview The last message, trimmed by the server.
 */

/**
 * `last_mes` is either a humanized `send_date` or an mtime (`chats.js:413-421`).
 * @param {unknown} value Raw value.
 * @returns {number}
 */
function lastMs(value) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }
    try {
        const moment = timestampToMoment(value);
        return moment && moment.isValid() ? moment.valueOf() : 0;
    } catch {
        return 0;
    }
}

/**
 * @param {string} groupId Group id.
 * @returns {Promise<SceneChatRow[]>} Newest first. Throws on a network or server failure so the
 *   caller can tell "none" from "couldn't read".
 */
export async function loadSceneChats(groupId) {
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ query: '', group_id: String(groupId) }),
    });
    if (!response.ok) {
        throw new Error(`chat search failed: ${response.status}`);
    }
    const data = await response.json();
    /** @type {SceneChatRow[]} */
    const rows = (Array.isArray(data) ? data : [])
        .filter(entry => entry && typeof entry.file_name === 'string' && entry.file_name)
        .map(entry => ({
            id: String(entry.file_name),
            title: String(entry.file_name),
            count: Number.isFinite(Number(entry.message_count)) ? Number(entry.message_count) : null,
            lastMs: lastMs(entry.last_mes),
            preview: typeof entry.preview_message === 'string' ? entry.preview_message : '',
        }));
    rows.sort((a, b) => b.lastMs - a.lastMs);
    return rows;
}

/** @returns {string} The open scene's id, or '' when no group chat is open. */
export function activeSceneId() {
    return selected_group ? String(selected_group) : '';
}

/** @returns {any|null} The open scene's live record, or null. */
export function activeScene() {
    const id = activeSceneId();
    return id ? (groups.find(group => String(group.id) === id) ?? null) : null;
}

/**
 * Opens another chat of the open scene. No-op when it is already on screen.
 * @param {string} chatId Extension-less chat id.
 * @returns {Promise<boolean>} True when a switch was made.
 */
export async function openSceneChat(chatId) {
    const id = activeSceneId();
    if (!id || !chatId || String(getCurrentChatId() ?? '') === chatId) {
        return false;
    }
    await openGroupChat(id, chatId);
    return true;
}

/**
 * Renames one of the open scene's chats through core (`script.js:11130`), which also moves the
 * id inside the record (`renameGroupChat`, `group-chats.js:2219`) and emits CHAT_RENAMED.
 * @param {string} oldId Current chat id.
 * @param {string} newId Requested name.
 * @returns {Promise<void>}
 */
export async function renameSceneChat(oldId, newId) {
    const id = activeSceneId();
    if (!id || !oldId || !newId.trim() || newId.trim() === oldId) {
        return;
    }
    await renameGroupOrCharacterChat({ groupId: id, oldFileName: oldId, newFileName: newId.trim(), loader: false });
}
