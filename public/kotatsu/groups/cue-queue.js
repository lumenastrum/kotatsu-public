/**
 * The cue queue — members the user asked to hear next (`docs/group-chat-v0.md` G3, G6).
 *
 * Core can force ONE speaker per round (`Generate('normal', { force_chid })`, the stock Speak
 * button's path, `group-chats.js:2016-2021`). Everything sequential on top of that — "speak
 * after the next reply", "@Seraphina @Aemeath" — is this small queue: avatars in order, fired
 * one per round, each as soon as core is idle again (`GROUP_WRAPPER_FINISHED`).
 *
 * Pure state machine here (`tests/cue-queue.test.js`); `stage-actions.js` drives it with core.
 * Rules:
 * - A cue is an avatar; cueing the same avatar twice in a row collapses (a double click is not
 *   two turns), but A, B, A is three turns.
 * - The user stopping a generation clears the queue — Stop means stop.
 * - Leaving the scene (or switching chats) clears it.
 */

export class CueQueue {
    /** @type {string[]} */
    #items = [];

    /** @type {Set<() => void>} */
    #listeners = new Set();

    /** @returns {string[]} A copy, in firing order. */
    get items() {
        return this.#items.slice();
    }

    /** @returns {number} */
    get size() {
        return this.#items.length;
    }

    /**
     * @param {() => void} listener Called after every change.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    #changed() {
        for (const listener of this.#listeners) {
            try {
                listener();
            } catch (error) {
                console.error('[cue-queue] listener failed', error);
            }
        }
    }

    /**
     * Adds avatars at the end, in order. Adjacent duplicates (including against the current tail)
     * collapse.
     * @param {...string} avatars
     * @returns {void}
     */
    push(...avatars) {
        let changed = false;
        for (const avatar of avatars) {
            if (typeof avatar !== 'string' || !avatar) continue;
            if (this.#items[this.#items.length - 1] === avatar) continue;
            this.#items.push(avatar);
            changed = true;
        }
        if (changed) this.#changed();
    }

    /**
     * Puts an avatar at the front ("speak now" while someone else is writing).
     * @param {string} avatar
     * @returns {void}
     */
    pushFront(avatar) {
        if (typeof avatar !== 'string' || !avatar || this.#items[0] === avatar) return;
        this.#items.unshift(avatar);
        this.#changed();
    }

    /** @returns {string} The next avatar, removed; '' when empty. */
    shift() {
        const next = this.#items.shift() ?? '';
        if (next) this.#changed();
        return next;
    }

    /**
     * Removes every cue for an avatar (muted or left the scene).
     * @param {string} avatar
     * @returns {void}
     */
    drop(avatar) {
        const before = this.#items.length;
        this.#items = this.#items.filter(item => item !== avatar);
        if (this.#items.length !== before) this.#changed();
    }

    /**
     * Moves a cue.
     * @param {number} from
     * @param {number} to
     * @returns {void}
     */
    move(from, to) {
        if (!Number.isInteger(from) || from < 0 || from >= this.#items.length) return;
        const target = Math.min(this.#items.length - 1, Math.max(0, Math.round(to)));
        if (target === from) return;
        const [item] = this.#items.splice(from, 1);
        this.#items.splice(target, 0, item);
        this.#changed();
    }

    /** @returns {void} */
    clear() {
        if (this.#items.length === 0) return;
        this.#items = [];
        this.#changed();
    }
}

/**
 * Whether a forced turn came back empty: its round finished and the chat is no longer than when
 * it was fired (a provider error, a refused request). The drain must never re-fire into that: a
 * seated narrator stays due until it gets a line in, so it would be cued again every round, and
 * a failing round finishes in milliseconds (measured: 2,774 rounds in seven minutes against a
 * switched-off bridge).
 * @param {{length: number}|null} turn The forced turn in flight, as the stage recorded it.
 * @param {number} chatLength The chat's length now.
 * @returns {boolean}
 */
export function forcedTurnFailed(turn, chatLength) {
    return Boolean(turn) && chatLength <= /** @type {{length: number}} */ (turn).length;
}

/** The one queue the stage, the cast tab and the composer share. */
export const cueQueue = new CueQueue();
