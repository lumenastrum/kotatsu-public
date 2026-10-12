/**
 * The live round — one listener set for core's group wrapper events, shared by every scene
 * surface (`docs/group-chat-v0.md` G3/G4). The stage strip and the cast tab both read
 * `roundStore.round`, so they can never disagree about who is writing.
 *
 * - `GROUP_WRAPPER_STARTED` → `queue` (Kotatsu's addition to the payload, `group-chats.js`)
 * - `GROUP_MEMBER_DRAFTED`  → `writing` (a character index → its avatar)
 * - `GROUP_WRAPPER_FINISHED` / `GENERATION_STOPPED` → idle
 * - the cue queue → `cued`
 *
 * A quiet run (`type: 'quiet'`: the picture writer's draft, a summary, any extension's quiet
 * prompt) also goes through the group wrapper, which drafts a member to borrow their card. Nobody
 * is speaking, so the round ignores it from start to finish.
 *
 * Reference-counted install: the first surface to mount binds, the last to unmount unbinds.
 */

import { characters } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { idleRound } from './cast-state.js';
import { cueQueue } from './cue-queue.js';

/** @type {import('./cast-state.js').LiveRound} */
let round = idleRound();

/** @type {Set<() => void>} */
const listeners = new Set();

let users = 0;

/** @type {(() => void)|null} */
let offCue = null;

/** True between the start and finish of a quiet run. */
let quietRun = false;

function changed() {
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.error('[round-store] listener failed', error);
        }
    }
}

/** @param {any} payload */
function onStarted(payload) {
    quietRun = payload?.type === 'quiet';
    if (quietRun) return;
    const queue = Array.isArray(payload?.queue) ? payload.queue.filter((/** @type {unknown} */ a) => typeof a === 'string') : [];
    round = { ...round, queue, writing: '' };
    changed();
}

/** @param {unknown} chid */
function onDrafted(chid) {
    if (quietRun) return;
    const avatar = characters?.[Number(chid)]?.avatar ?? '';
    round = { ...round, writing: String(avatar) };
    changed();
}

/** @param {any} [payload] */
function onFinished(payload) {
    if (quietRun || payload?.type === 'quiet') {
        quietRun = false;
        return;
    }
    round = { ...idleRound(), cued: cueQueue.items };
    changed();
}

export const roundStore = {
    /** @returns {import('./cast-state.js').LiveRound} */
    get round() {
        return round;
    },

    /**
     * @param {() => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    /** Binds core's events (first user only). */
    acquire() {
        users += 1;
        if (users > 1) return;
        eventSource.on(event_types.GROUP_WRAPPER_STARTED, onStarted);
        eventSource.on(event_types.GROUP_MEMBER_DRAFTED, onDrafted);
        eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onFinished);
        eventSource.on(event_types.GENERATION_STOPPED, onFinished);
        offCue = cueQueue.subscribe(() => {
            round = { ...round, cued: cueQueue.items };
            changed();
        });
    },

    /** Unbinds when the last user leaves. */
    release() {
        users = Math.max(0, users - 1);
        if (users > 0) return;
        eventSource.removeListener(event_types.GROUP_WRAPPER_STARTED, onStarted);
        eventSource.removeListener(event_types.GROUP_MEMBER_DRAFTED, onDrafted);
        eventSource.removeListener(event_types.GROUP_WRAPPER_FINISHED, onFinished);
        eventSource.removeListener(event_types.GENERATION_STOPPED, onFinished);
        offCue?.();
        offCue = null;
        quietRun = false;
        round = idleRound();
    },
};
