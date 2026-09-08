/**
 * Kotatsu swipe-count marker — reader-polish v0 finding 5.
 *
 * Core prints a `.swipes-counter` ("1/1") on every row and, under
 * `show_swipe_num_all_messages`, shows it on every row too — so a long chat wears a column of
 * "1/1"s that say nothing. CSS cannot read text, so this marks each row with what its counter
 * says — `data-k-swipes="<total>"` on `.mes` — and css/shell-center.css §3 hides the counter
 * when the total is 1. It comes back the moment a second swipe exists, on the same walk.
 *
 * Event-driven, never per-token: it walks the rendered rows after the message lifecycle events
 * below, coalesced to one walk per frame, and touches nothing but the one attribute. The
 * counter text is core's own truth for the row (`swipes.length`, script.js), read where core
 * wrote it — the DOM-as-state read-back the renderer recon inventories, used here for a display
 * hint that cannot change behaviour. A row with no counter is left unmarked.
 *
 * Registered once at the `firstLoadInit()` seam (shell/index.js), the metadata-reveal shape:
 * `#chat`'s identity is frozen by CONTRACT §1.7, so one registration outlives every re-render
 * and every layout switch. Under classic the attribute is written and nothing reads it — the
 * hiding rule is rails-gated, so classic stays pixel-identical.
 *
 * One-way imports: kotatsu → core only.
 */

import { event_types, eventSource } from '../../scripts/events.js';

/** The row attribute the sheet keys on. */
export const SWIPES_ATTR = 'data-k-swipes';

/**
 * `event_types` KEYS after which a counter may have appeared, changed or gone. Looked up by
 * key and skipped when absent (the k-chat-header.js pattern). Deliberately excludes the
 * per-token streaming events — a counter only moves on these.
 */
const MARK_EVENTS = [
    'CHAT_CHANGED',
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_SWIPED',
    'MESSAGE_SWIPE_DELETED',
    'MESSAGE_DELETED',
    'MESSAGE_UPDATED',
    'MORE_MESSAGES_LOADED',
    'GENERATION_ENDED',
];

/** Pending walk, so a burst of render events coalesces to one pass per paint. */
let frame = 0;
let initialized = false;

/**
 * The swipe total a counter's text carries. Core prints `current/total` with a U+200B
 * zero-width space on each side of the slash so the counter can wrap (`formatSwipeCounter`,
 * script.js:10306), and `?` for a side it cannot count. A `?` total is not a number and reads
 * as null: the row is left unmarked rather than guessed at.
 * @param {string|null|undefined} text Counter text content.
 * @returns {number|null} The total, or null when the text is not a counter.
 */
export function readSwipeTotal(text) {
    // `\p{Cf}` (Unicode "format" characters) covers the U+200B–U+200D family without putting
    // an invisible character in the source (eslint no-irregular-whitespace).
    const match = /^[\s\p{Cf}]*\d+[\s\p{Cf}]*\/[\s\p{Cf}]*(\d+)[\s\p{Cf}]*$/u.exec(text ?? '');
    return match ? Number(match[1]) : null;
}

/**
 * One walk: every `.mes` with a counter gets `data-k-swipes` = its total; rows whose counter
 * no longer parses lose the attribute.
 * @param {ParentNode|null} [root] Defaults to `#chat`.
 * @returns {number} Rows whose attribute changed.
 */
export function markSwipeCounts(root = document.getElementById('chat')) {
    if (!root) return 0;
    let changed = 0;
    for (const counter of root.querySelectorAll('.mes .swipes-counter')) {
        const row = counter.closest('.mes');
        // Duck-typed rather than `instanceof HTMLElement`: the walk is unit-tested against
        // plain objects (tests/swipe-count.test.js), and only the attribute methods matter.
        if (!row || typeof row.setAttribute !== 'function') continue;
        const total = readSwipeTotal(counter.textContent);
        if (total === null) {
            if (row.hasAttribute(SWIPES_ATTR)) {
                row.removeAttribute(SWIPES_ATTR);
                changed += 1;
            }
            continue;
        }
        const value = String(total);
        if (row.getAttribute(SWIPES_ATTR) !== value) {
            row.setAttribute(SWIPES_ATTR, value);
            changed += 1;
        }
    }
    return changed;
}

/** @returns {void} */
function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        markSwipeCounts();
    });
}

/**
 * Subscribes the walk to the message lifecycle and runs it once. Idempotent.
 * @returns {void}
 */
export function initSwipeCountMarker() {
    if (initialized) return;
    initialized = true;
    for (const key of MARK_EVENTS) {
        const type = event_types ? event_types[key] : undefined;
        if (typeof type !== 'string') continue;
        eventSource.on(type, schedule);
    }
    schedule();
}
