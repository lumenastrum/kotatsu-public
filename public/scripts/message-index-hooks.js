/**
 * message-index-hooks — a core-owned notification point for `chat[]` index mutations
 * (receipt tracker v0, `docs/receipt-tracker-v0.md` decision 1).
 *
 * ## Why this leaf exists
 *
 * `MESSAGE_DELETED` (`public/scripts/events.js`) cannot carry a reindex fix: every one of its
 * four emit sites passes **post-op `chat.length`**, never the deleted index —
 * `deleteMessage(id, …)` already ran `chat.splice(id, 1)` thirteen lines earlier
 * (`script.js:1801` → emit at `:1816`), so by the time the event fires the id is gone and the
 * arg is just the new array length. The bulk `#dialogue_del_mes_ok` handler emits the
 * truncation point, which happens to be usable, but only because it is a tail case; a
 * mid-chat `deleteMessage` gives no usable signal at all. `messageEditMove`
 * (`script.js:8696-8745`) swaps two adjacent `chat[]` entries and emits **nothing** — core
 * repairs itemization inline via `swapItemizedPrompts(sourceId, targetId)`
 * (`script.js:8740` → `itemized-prompts.js:365-382`), which is this leaf's prior art for the
 * same problem class.
 *
 * Rather than widen a frozen event's payload (breaking every existing listener's
 * assumptions) or have kotatsu re-derive index math it cannot see, core calls this leaf at
 * the exact sites that already maintain itemization, with the exact values itemization
 * already needed: the real deleted id, the real truncation length, the real swapped pair.
 * `MESSAGE_DELETED` itself is untouched — still emitted exactly as before, for every listener
 * that only ever needed "something changed, chat is now this long".
 *
 * ## The one-way-import rule this leaf honours
 *
 * Core leaves are the one exception CLAUDE.md's "kotatsu → core, never core → kotatsu" rule
 * already carves out: a core leaf may be imported BY core (this one is, from `script.js`) and
 * separately by kotatsu, without kotatsu ever importing anything kotatsu-owned back into
 * core. `public/scripts/usage-capture.js` is the standing precedent — dependency-free for the
 * same reason: two parties on opposite sides of the strangle (core's write sites, kotatsu's
 * readers) need the exact same small piece of logic, and putting it under `public/kotatsu/`
 * would make core import kotatsu to reach it. This file has zero imports of its own, so
 * nothing it does can turn into an accidental import cycle no matter which side reaches for
 * it first.
 *
 * ## The contract subscribers get
 *
 * A subscriber can never break a delete: every notify wraps every handler in its own
 * try/catch, logs at most once per throw, and keeps calling the rest. This module has no
 * opinion on what a handler does with the event — it exists purely to hand core's index truth
 * to whoever asks, safely.
 */

/**
 * @typedef {{type: 'deleted', index: number}} MessageDeletedIndexEvent
 * The message that occupied `index` is gone; every later message shifted down by one.
 */

/**
 * @typedef {{type: 'truncated', newLength: number}} MessagesTruncatedIndexEvent
 * Every message at index `newLength` and beyond is gone; `chat.length` is now `newLength`.
 */

/**
 * @typedef {{type: 'swapped', a: number, b: number}} MessagesSwappedIndexEvent
 * The messages at `a` and `b` (always adjacent — `messageEditMove` enforces it) traded places.
 */

/**
 * @typedef {MessageDeletedIndexEvent|MessagesTruncatedIndexEvent|MessagesSwappedIndexEvent} MessageIndexEvent
 */

/**
 * @callback MessageIndexHookHandler
 * @param {MessageIndexEvent} event What happened to `chat[]`.
 * @returns {void}
 */

/** @type {Set<MessageIndexHookHandler>} Registered subscribers. */
const handlers = new Set();

/**
 * Runs every subscriber against one event. A throwing handler is reported once and skipped;
 * it can never stop the handlers registered after it, and it can never propagate back into
 * whichever core delete path is calling the `notify*` function.
 * @param {MessageIndexEvent} event The event to dispatch.
 * @returns {void}
 */
function dispatch(event) {
    for (const handler of [...handlers]) {
        try {
            handler(event);
        } catch (error) {
            console.error('[message-index-hooks] a subscriber threw and was skipped', error);
        }
    }
}

/**
 * Registers a handler for `chat[]` index mutations.
 * @param {MessageIndexHookHandler} handler Called with each {@link MessageIndexEvent}.
 * @returns {() => void} Unsubscribe. Safe to call more than once.
 */
export function subscribeMessageIndexHooks(handler) {
    if (typeof handler !== 'function') {
        return () => { };
    }
    handlers.add(handler);
    return () => {
        handlers.delete(handler);
    };
}

/**
 * Call beside the existing itemization delete call, with the message's own id — NOT
 * `chat.length` — so the deleted index is still recoverable. Because `chat.splice` has
 * usually already run by this point, callers must capture the id BEFORE the splice, not read
 * it back off anything that could have shifted.
 * @param {number} index The id of the message that was deleted.
 * @returns {void}
 */
export function notifyMessageDeleted(index) {
    dispatch({ type: 'deleted', index });
}

/**
 * Call beside the existing itemization truncation loop, with the chat's new length (the same
 * value `chat.length` was just set to).
 * @param {number} newLength `chat.length` after the truncation.
 * @returns {void}
 */
export function notifyMessagesTruncated(newLength) {
    dispatch({ type: 'truncated', newLength });
}

/**
 * Call beside `swapItemizedPrompts`, with the same two ids.
 * @param {number} a One swapped message's id.
 * @param {number} b The other swapped message's id.
 * @returns {void}
 */
export function notifyMessagesSwapped(a, b) {
    dispatch({ type: 'swapped', a, b });
}
