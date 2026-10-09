/**
 * Stage actions — what the stage strip, the member menu and the cast tab DO, through core's
 * exported paths only (`docs/group-chat-v0.md` G3/G4).
 *
 * - Speak: `Generate('normal', { force_chid })`, the stock Speak button's call
 *   (`group-chats.js:2016-2021`). Text already in the composer is sent first, exactly as the
 *   stock button does.
 * - Mute / leave / turn style: the live record in `groups[]`, saved with `editGroup(id, true)`
 *   (immediate — never the debounced path), then `GROUP_UPDATED` like core's member actions.
 * - Let them talk: core's `setGroupAutoMode()`.
 * - Sequencing: the cue queue, drained one member per round on `GROUP_WRAPPER_FINISHED`.
 * - The narrator seat (§13): never unmuted, kept last, and queued during Let them talk once the
 *   cast has carried the scene for the scene's pace.
 */

import { Generate, characters, chat, isGenerating } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import {
    editGroup,
    groups,
    is_group_automode_enabled,
    selected_group,
    setGroupAutoMode,
} from '../../scripts/group-chats.js';
import { Popup } from '../../scripts/popup.js';
import { cueQueue, forcedTurnFailed } from './cue-queue.js';
import {
    NARRATOR_PACE_KEY,
    isNarratorCard,
    narratorAvatarOf,
    narratorDue,
    narratorPace,
    seatNarratorLast,
} from './narrator.js';
import { rosterByAvatar } from './scene-model.js';

/** @returns {any|null} The open scene's live record. */
export function openScene() {
    return selected_group ? (groups.find(g => String(g.id) === String(selected_group)) ?? null) : null;
}

/**
 * @param {string} avatar Card filename.
 * @returns {number} Character index, -1 when the card is gone.
 */
function chidOf(avatar) {
    return Array.isArray(characters) ? characters.findIndex(c => c?.avatar === avatar) : -1;
}

/**
 * @param {string} avatar
 * @returns {string} Display name.
 */
function nameOf(avatar) {
    const index = chidOf(avatar);
    return index >= 0 ? String(characters[index].name ?? avatar) : avatar;
}

/**
 * The forced turn in flight, with the chat's length when it was fired, so the drain can tell a
 * turn that wrote nothing from one that wrote a reply (`forcedTurnFailed`).
 * @type {{avatar: string, length: number}|null}
 */
let turnInFlight = null;

/**
 * Fires one forced turn. Returns false when core is busy (the caller cues instead).
 * @param {string} avatar
 * @returns {boolean}
 */
function fire(avatar) {
    const chid = chidOf(avatar);
    if (chid < 0 || !selected_group || isGenerating()) {
        return false;
    }
    turnInFlight = { avatar, length: chat.length };
    void Generate('normal', { force_chid: chid }).catch(error => console.error('[stage] forced turn failed', error));
    return true;
}

/**
 * "Speak now": now if core is idle, otherwise first in line after the reply being written.
 * @param {string} avatar
 * @returns {void}
 */
export function speakNow(avatar) {
    if (!fire(avatar)) {
        cueQueue.pushFront(avatar);
    }
}

/**
 * "Speak after the next reply": always queued behind whatever is happening; when nothing is,
 * it is simply now.
 * @param {string} avatar
 * @returns {void}
 */
export function speakAfter(avatar) {
    if (isGenerating() || cueQueue.size > 0) {
        cueQueue.push(avatar);
        return;
    }
    fire(avatar);
}

/**
 * Cues several members in order — the @mention path (G6). The first goes now when core is idle.
 * @param {string[]} avatars
 * @returns {void}
 */
export function cueInOrder(avatars) {
    const list = avatars.filter(avatar => chidOf(avatar) >= 0);
    if (list.length === 0) return;
    if (!isGenerating() && cueQueue.size === 0 && fire(list[0])) {
        cueQueue.push(...list.slice(1));
        return;
    }
    cueQueue.push(...list);
}

/**
 * @param {any} group
 * @returns {Promise<void>}
 */
async function save(group) {
    await editGroup(group.id, true, false);
    await eventSource.emit(event_types.GROUP_UPDATED);
}

/**
 * Mutes or unmutes. A muted member stays in the room and can still be cued by hand; they just
 * never get drafted (core's `disabled_members`).
 * @param {string} avatar
 * @param {boolean} muted
 * @returns {Promise<void>}
 */
export async function setMuted(avatar, muted) {
    const group = openScene();
    if (!group) return;
    // The narrator's mute IS the mechanism (it speaks only when called), never a user choice.
    if (!muted && isNarratorCard(characters.find(c => c?.avatar === avatar))) return;
    const list = Array.isArray(group.disabled_members) ? group.disabled_members.slice() : [];
    const at = list.indexOf(avatar);
    if (muted && at < 0) list.push(avatar);
    else if (!muted && at >= 0) list.splice(at, 1);
    else return;
    group.disabled_members = list;
    await save(group);
}

/**
 * Takes a member out of the scene after a confirm. Their messages stay in the chat. Clears their
 * muted entry too, so a later return is not silently muted (S7).
 * @param {string} avatar
 * @returns {Promise<boolean>} True when they left.
 */
export async function leaveScene(avatar) {
    const group = openScene();
    if (!group) return false;
    const name = nameOf(avatar);
    const ok = await Popup.show.confirm(`${name} leaves ${group.name}?`, 'Their lines stay in the chat. You can seat them again from Edit scene.');
    if (!ok) return false;
    group.members = (Array.isArray(group.members) ? group.members : []).filter((/** @type {string} */ a) => a !== avatar);
    group.disabled_members = (Array.isArray(group.disabled_members) ? group.disabled_members : []).filter((/** @type {string} */ a) => a !== avatar);
    cueQueue.drop(avatar);
    await save(group);
    return true;
}

/**
 * @param {number} value Core activation strategy.
 * @returns {Promise<void>}
 */
export async function setTurnStyle(value) {
    const group = openScene();
    if (!group || Number(group.activation_strategy) === value) return;
    group.activation_strategy = value;
    await save(group);
}

/** @returns {boolean} Whether "Let them talk" is on. */
export function talking() {
    return Boolean(is_group_automode_enabled);
}

/**
 * Turns "Let them talk" on or off (core auto mode). Turning it off also clears the cue queue:
 * the user is taking the floor back.
 * @param {boolean} [value]
 * @returns {void}
 */
export function setTalking(value = !talking()) {
    setGroupAutoMode(value);
    if (!value) cueQueue.clear();
}

/* ── the drain ───────────────────────────────────────────────────────────── */

let drainInstalled = false;

/**
 * The open scene's narrator avatar, '' when it seats none.
 * @param {any} [group]
 * @returns {string}
 */
export function sceneNarrator(group = openScene()) {
    return group ? narratorAvatarOf(group, rosterByAvatar(characters)) : '';
}

/**
 * Let them talk: once the cast has carried the scene for the pace, the narrator goes next.
 * Only while auto mode is on — in a scene the user is driving, the narrator waits to be called.
 */
function queueNarratorIfDue() {
    if (!is_group_automode_enabled) return;
    const group = openScene();
    const narrator = sceneNarrator(group);
    if (!narrator || cueQueue.items.includes(narrator)) return;
    if (narratorDue(chat, narrator, narratorPace(group?.[NARRATOR_PACE_KEY]))) {
        cueQueue.push(narrator);
    }
}

/**
 * Keeps a seated narrator muted and last, whatever changed the record (stock `/member-enable`,
 * the classic panel, a hand-edited file). Muted is what keeps core's strategies from drafting it;
 * last keeps core's quiet path and swipe fallback (both take `members[0]`) off it.
 * @returns {Promise<void>}
 */
async function keepNarratorInPlace() {
    const group = openScene();
    const narrator = sceneNarrator(group);
    if (!group || !narrator) return;
    const members = seatNarratorLast(group.members, narrator);
    const disabled = Array.isArray(group.disabled_members) ? group.disabled_members : [];
    const moved = JSON.stringify(members) !== JSON.stringify(group.members);
    if (!moved && disabled.includes(narrator)) return;
    group.members = members;
    group.disabled_members = disabled.includes(narrator) ? disabled : [...disabled, narrator];
    await editGroup(group.id, true, false);
}

/** @returns {void} */
function onSceneTouched() {
    void keepNarratorInPlace().catch(error => console.error('[stage] narrator seat repair failed', error));
}

/** One cued turn per finished round, once core is idle. */
function onRoundFinished() {
    const turn = turnInFlight;
    turnInFlight = null;
    if (forcedTurnFailed(turn, chat.length)) {
        // A cued turn wrote nothing. Core has already shown why; firing the rest of the queue
        // (or the narrator, who is still due) into the same failure would spin, so the room
        // goes quiet until the user acts.
        cueQueue.clear();
        if (is_group_automode_enabled) {
            setTalking(false);
            toastr.warning('A reply failed, so Let them talk stopped. Switch it back on when the connection works.', 'Kotatsu');
        }
        return;
    }
    queueNarratorIfDue();
    if (cueQueue.size === 0) return;
    // `finally` in the wrapper resets its flags before emitting, but Generate's own send flag
    // can trail it by a tick; a short delay keeps a cue from bouncing off a busy core.
    setTimeout(() => {
        const group = openScene();
        while (cueQueue.size > 0) {
            const next = cueQueue.items[0];
            if (!group || !group.members.includes(next) || chidOf(next) < 0) {
                cueQueue.shift();
                continue;
            }
            if (fire(next)) cueQueue.shift();
            break;
        }
    }, 120);
}

/** Stop means stop: the user aborted, so nothing queued fires after. */
function onStopped() {
    // A stop before the first token writes nothing too, but that is the user's choice, not a failure.
    turnInFlight = null;
    cueQueue.clear();
}

/** A different chat is a different room. */
function onChatChanged() {
    turnInFlight = null;
    cueQueue.clear();
}

/** @returns {void} Idempotent. Called by the stage strip's mount. */
export function installCueDrain() {
    if (drainInstalled) return;
    drainInstalled = true;
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onRoundFinished);
    eventSource.on(event_types.GENERATION_STOPPED, onStopped);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.CHAT_CHANGED, onSceneTouched);
    eventSource.on(event_types.GROUP_UPDATED, onSceneTouched);
}

/** @returns {void} */
export function uninstallCueDrain() {
    if (!drainInstalled) return;
    drainInstalled = false;
    eventSource.removeListener(event_types.GROUP_WRAPPER_FINISHED, onRoundFinished);
    eventSource.removeListener(event_types.GENERATION_STOPPED, onStopped);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.CHAT_CHANGED, onSceneTouched);
    eventSource.removeListener(event_types.GROUP_UPDATED, onSceneTouched);
    cueQueue.clear();
}
