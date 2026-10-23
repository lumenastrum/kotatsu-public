/**
 * Card Studio ② "How it begins": the openings of a card, as data (#16, the first-message slice).
 *
 * DOM-free and core-free so it is unit-tested (`tests/studio-openings.test.js`): which openings a
 * card has (the first message, then the alternate greetings), how the flipper names them, what a
 * tile shows, and the TRANSIENT chat message `<k-opening-preview>` hands to core's own row builder
 * (`updateMessageElement`). In the chat the openings are the greeting's swipes, so the transient
 * message carries them as swipes too: core's counter then reads "2/3" exactly as it will in chat.
 */

/**
 * One opening.
 * @typedef {object} Opening
 * @property {number} index 0 = the first message, 1.. = the alternate greetings in order.
 * @property {string} text The raw text, macros unresolved.
 * @property {'first'|'alternate'} kind
 */

/**
 * Every opening of a card, first message first. Core keeps alternates as a plain string array
 * (`data.alternate_greetings`, `create_save.alternate_greetings`); anything that is not a string
 * is skipped rather than rendered as "undefined".
 * @param {string} first The first message's current text (the borrowed textarea's value).
 * @param {unknown} alternates The card's alternate greetings.
 * @returns {Opening[]}
 */
export function listOpenings(first, alternates) {
    /** @type {Opening[]} */
    const out = [{ index: 0, text: String(first ?? ''), kind: 'first' }];
    if (Array.isArray(alternates)) {
        for (const text of alternates) {
            if (typeof text === 'string') out.push({ index: out.length, text, kind: 'alternate' });
        }
    }
    return out;
}

/**
 * The flipper's step: wraps around both ends, the way swiping a greeting does.
 * @param {number} index Current opening.
 * @param {number} delta -1 or +1.
 * @param {number} total How many openings there are.
 * @returns {number}
 */
export function flipOpening(index, delta, total) {
    if (!Number.isFinite(total) || total < 1) return 0;
    const next = (Math.trunc(index) + Math.trunc(delta)) % total;
    return next < 0 ? next + total : next;
}

/**
 * Keeps a remembered index valid after the openings changed under it (one was deleted in core's
 * popup, or the card switched).
 * @param {number} index
 * @param {number} total
 * @returns {number}
 */
export function clampOpening(index, total) {
    if (!Number.isFinite(index) || total < 1) return 0;
    return Math.min(Math.max(0, Math.trunc(index)), total - 1);
}

/**
 * "Opening 2 of 3". A single opening is still "Opening 1 of 1": the label says what a player gets.
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
export function openingLabel(index, total) {
    return `Opening ${index + 1} of ${Math.max(1, total)}`;
}

/** Markdown and HTML that a plain-text tile should not show as characters. */
const MARKUP = /<[^>]*>|[*_~`#>]+/g;

/**
 * A tile's text: one line of plain prose, cut at a word boundary.
 * @param {string} text The opening, macros already resolved by the caller.
 * @param {number} [max=160] Characters before the cut.
 * @returns {string}
 */
export function openingExcerpt(text, max = 160) {
    const plain = String(text ?? '').replace(MARKUP, '').replace(/\s+/g, ' ').trim();
    if (plain.length <= max) return plain;
    const cut = plain.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '')}…`;
}

/**
 * The macro context for the preview, as `substituteParams()`'s options object.
 *
 * `{{char}}` is the name being written (create mode included, before the card exists), `{{user}}`
 * stays core's: the reader's persona. Card macros (`{{description}}`, `{{scenario}}` …) read the
 * ACTIVE character, which is this card only in edit mode; in create mode the active character is
 * whoever was open behind the sheet, so card macros are left alone rather than resolved wrongly.
 * @param {{ name: string, mode: 'create'|'edit' }} card
 * @returns {{ name2Override?: string, replaceCharacterCard: boolean }}
 */
export function macroOptions({ name, mode }) {
    const trimmed = String(name ?? '').trim();
    return {
        ...(trimmed ? { name2Override: trimmed } : {}),
        replaceCharacterCard: mode === 'edit',
    };
}

/**
 * The transient message core's `updateMessageElement()` renders for the preview.
 *
 * Never pushed to `chat`: it is rendered with messageId -1, the id core itself uses for transient
 * messages, because id 0 is the greeting path and that path WRITES the substituted text back into
 * `chat[0].mes` (`messageFormatting`, script.js) — the studio would edit the open chat. Macros are
 * therefore resolved by the caller, before this. `swipes`, `swipe_id` AND one `swipe_info` per
 * swipe are set so core's `ensureSwipes()` finds nothing to backfill: anything it backfills, it
 * then syncs against `chat[-1]` (found 2026-10-19 as a `[syncMesToSwipe] Invalid message ID: -1`
 * warning on every preview render while `swipe_info` was missing).
 * @param {object} input
 * @param {string} input.name The character's name, as the chat prints it.
 * @param {string[]} input.texts Every opening, macros resolved, in order.
 * @param {number} input.index The one to show.
 * @param {string} [input.avatar] An avatar to force (a fresh crop, or create mode); omitted =
 *   core picks the active character's, exactly as in chat.
 * @param {number} [input.sendDate] Timestamp the row prints; the chat stamps a greeting with now.
 * @returns {{ name: string, is_user: false, is_system: false, mes: string, send_date: number, swipes: string[], swipe_id: number, swipe_info: { send_date: number, extra: object }[], extra: object, force_avatar?: string }}
 */
export function previewMessage({ name, texts, index, avatar, sendDate = Date.now() }) {
    // Strings only: `ensureSwipes()` backfills a non-string swipe too, and then syncs chat[-1].
    const swipes = texts.length ? texts.map(text => (typeof text === 'string' ? text : '')) : [''];
    const swipe_id = clampOpening(index, swipes.length);
    return {
        name,
        is_user: false,
        is_system: false,
        mes: swipes[swipe_id],
        send_date: sendDate,
        swipes,
        swipe_id,
        // The shape core's own `createSwipeInfo()` gives a greeting's swipe (script.js `ensureSwipes`).
        swipe_info: swipes.map(() => ({ send_date: sendDate, extra: {} })),
        extra: {},
        ...(avatar ? { force_avatar: avatar } : {}),
    };
}
