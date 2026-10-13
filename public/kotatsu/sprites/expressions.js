/**
 * Sprites — one expression per finished character message (Pictures slice F, step 1).
 *
 * Classified by stock's LOCAL classifier (`POST /api/extra/classify`, no API cost) when a reply
 * has finished (`CHARACTER_MESSAGE_RENDERED` fires after streaming ends), when a swipe shows an
 * existing reply, and after an edit; never on a timer and never while a reply is being written
 * (stock re-classifies every 2 s mid-stream: faces jitter, issue #3369). The answer is stored on
 * the message (`extra.kotatsu_expression`, per swipe through core's swipe sync) and the face is
 * resolved against the sprites on disk when shown (`expression-model.js`).
 *
 * Only characters WITH a sprite set are classified: without sprites there is nothing to show,
 * and the classifier's first use downloads its model (66 MB, measured 2026-10-10). Offline with
 * no model the route answers 500 at once; the classifier is then left alone until the chat
 * changes, and the messages stay unlabelled (the card art shows).
 */

import { chat, getRequestHeaders, is_send_press, saveChatDebounced, syncMesToSwipe } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { is_group_generating } from '../../scripts/group-chats.js';
import { isNarratorCard } from '../groups/narrator.js';
import { characterFor } from '../pictures/doors.js';
import { isPictureMessage } from '../pictures/picture-model.js';
import {
    EXPRESSION_EXTRA_KEY,
    buildStoredExpression,
    needsClassify,
    readStoredExpression,
    resolveExpression,
    sampleForClassify,
} from './expression-model.js';
import { SPRITES_EVENT, forgetSpriteSet, spriteSetFor, spriteFolderFor } from './sprite-sets.js';

/** Fired on `document` when a message's stored expression changes; `detail.messageId`. */
export const EXPRESSION_EVENT = 'kotatsu:expression';

let installed = false;
/**
 * Serial queue: one classify request at a time.
 * @type {Promise<unknown>}
 */
let queue = Promise.resolve();
/** Messages queued or in flight (object identity, like `rowFor`). */
const pending = new WeakSet();
/** Set when the route fails; cleared when the chat changes. */
let classifierDown = false;
/** Diagnostics for the door and the probe. */
const stats = { classified: 0, skippedNoSprites: 0, dropped: 0, failed: 0, lastMs: 0 };

/**
 * The character a message would put on stage, or null for the user, system lines, pictures and
 * the narrator (narration highlights no one).
 * @param {any} message a `chat[]` entry
 * @returns {any|null} a `characters[]` entry
 */
export function stageCharacterFor(message) {
    if (!message || message.is_user || message.is_system || isPictureMessage(message)) return null;
    const character = characterFor(message);
    if (!character || isNarratorCard(character)) return null;
    return character;
}

/**
 * @param {number} messageId
 * @returns {boolean} whether that message is the one being written right now
 */
function beingWritten(messageId) {
    return (is_send_press || is_group_generating) && messageId === chat.length - 1;
}

/**
 * Classifies one message if it needs it. Resolves to the stored entry, or null.
 * @param {any} message
 * @returns {Promise<import('./expression-model.js').StoredExpression | null>}
 */
async function classify(message) {
    const character = stageCharacterFor(message);
    if (!character || classifierDown) return readStoredExpression(message);
    const sample = sampleForClassify(message.mes);
    if (!needsClassify(message, sample)) return readStoredExpression(message);
    const set = await spriteSetFor(character);
    if (!set.labels.size) {
        stats.skippedNoSprites += 1;
        return null;
    }
    const started = performance.now();
    let answer;
    try {
        const response = await fetch('/api/extra/classify', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ text: sample }),
        });
        if (!response.ok) throw new Error(`classify answered ${response.status}`);
        answer = (await response.json())?.classification;
    } catch (error) {
        stats.failed += 1;
        classifierDown = true;
        console.warn('[Kotatsu sprites] The local classifier is unavailable; faces stay as they are until the chat changes.', error);
        return null;
    }
    stats.lastMs = Math.round(performance.now() - started);
    // A swipe or an edit while the classifier was reading: this answer is for other text.
    if (sampleForClassify(message.mes) !== sample) {
        stats.dropped += 1;
        return readStoredExpression(message);
    }
    const stored = buildStoredExpression(sample, answer);
    if (!stored) return null;
    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    message.extra[EXPRESSION_EXTRA_KEY] = stored;
    stats.classified += 1;
    const messageId = chat.indexOf(message);
    if (messageId >= 0) {
        syncMesToSwipe(messageId);
        saveChatDebounced();
        document.dispatchEvent(new CustomEvent(EXPRESSION_EVENT, { detail: { messageId } }));
    }
    return stored;
}

/**
 * Queues a message for classifying (deduplicated; skipped while it is being written).
 * @param {number|string} id
 * @param {{finished?: boolean}} [options] `finished`: the caller KNOWS the reply is done (core's
 *   `CHARACTER_MESSAGE_RENDERED`, which fires only for finished replies), so the "being written" guard is skipped.
 *   In a scene `is_group_generating` stays up for the whole round, and the guard used to hold every member's face
 *   until the last one had spoken (product call, 2026-10-12).
 * @returns {Promise<import('./expression-model.js').StoredExpression | null>}
 */
export function scheduleClassify(id, { finished = false } = {}) {
    const messageId = Number(id);
    const message = Number.isInteger(messageId) ? chat[messageId] : null;
    if (!message || (!finished && beingWritten(messageId)) || !stageCharacterFor(message)) return Promise.resolve(readStoredExpression(message));
    if (pending.has(message)) return queue.then(() => readStoredExpression(message));
    pending.add(message);
    const run = queue.then(() => classify(message)).finally(() => pending.delete(message));
    queue = run.catch(() => null);
    return run;
}

/**
 * Makes sure each on-stage character's LATEST message is classified: what the stage shows when a
 * chat opens. Older messages are classified when something asks for them (the Sprite look's rows).
 * @returns {Promise<void>}
 */
export async function classifyLatestPerSpeaker() {
    const seen = new Set();
    const jobs = [];
    for (let id = chat.length - 1; id >= 0; id -= 1) {
        const character = stageCharacterFor(chat[id]);
        if (!character || seen.has(character.avatar)) continue;
        seen.add(character.avatar);
        if (!beingWritten(id)) jobs.push(scheduleClassify(id));
    }
    await Promise.all(jobs);
}

/**
 * The face to show for a message: the resolved label and its image, or null (the card art).
 * @param {number|string} id
 * @returns {Promise<{label: string, url: string, folder: string} | null>}
 */
export async function expressionFor(id) {
    const message = chat[Number(id)];
    const character = stageCharacterFor(message);
    if (!character) return null;
    const set = await spriteSetFor(character);
    const label = resolveExpression(readStoredExpression(message), set.labels.keys());
    return label ? { label, url: set.labels.get(label) ?? '', folder: set.folder } : null;
}

/**
 * Core emits `CHARACTER_MESSAGE_RENDERED` only for a finished reply: once at the end of streaming (never for the
 * empty bubble a stream starts with), for a non-streamed reply, a greeting, a slash-command line, or what a stream
 * left when it errored. So it classifies at once, even mid-round in a scene: each member's face changes when SHE
 * finishes, not when the round does.
 * @param {number|string} id
 */
function onFinished(id) {
    void scheduleClassify(id, { finished: true });
}

/**
 * A swipe or an edit: the message may be the one a new generation is writing into, so the guard applies.
 * @param {number|string} id
 */
function onRendered(id) {
    void scheduleClassify(id);
}

/**
 * A scene's round has ended: a safety net that classifies every speaker's latest (finished replies were classified
 * as each one rendered; anything already labelled is skipped by `needsClassify`).
 */
function onGroupRoundFinished() {
    void classifyLatestPerSpeaker();
}

function onChatChanged() {
    classifierDown = false;
    forgetSpriteSet();
    void classifyLatestPerSpeaker();
}

/**
 * Binds the classify drivers. Called by the rails install (Sprite mode is a rails look).
 * @returns {void}
 */
export function installExpressions() {
    if (installed) return;
    installed = true;
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onFinished);
    eventSource.on(event_types.MESSAGE_SWIPED, onRendered);
    eventSource.on(event_types.MESSAGE_UPDATED, onRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onGroupRoundFinished);
    // A character who just gained sprites (the studio's upload or pack import) starts getting faces now.
    document.addEventListener(SPRITES_EVENT, onGroupRoundFinished);
    void classifyLatestPerSpeaker();

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, any>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') targetWindow.kotatsu = {};
    targetWindow.kotatsu.sprites = {
        get state() {
            return { ...stats, classifierDown, labelled: chat.filter(m => readStoredExpression(m)).length };
        },
        classify: scheduleClassify,
        latest: classifyLatestPerSpeaker,
        expressionFor,
        folderFor: spriteFolderFor,
        forget: forgetSpriteSet,
    };
}

/** @returns {void} */
export function uninstallExpressions() {
    if (!installed) return;
    installed = false;
    eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onFinished);
    eventSource.removeListener(event_types.MESSAGE_SWIPED, onRendered);
    eventSource.removeListener(event_types.MESSAGE_UPDATED, onRendered);
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.removeListener(event_types.GROUP_WRAPPER_FINISHED, onGroupRoundFinished);
    document.removeEventListener(SPRITES_EVENT, onGroupRoundFinished);
}
