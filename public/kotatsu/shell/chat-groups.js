/**
 * The left rail's Chats section, by recency: Today, Yesterday, Previous 7 days, Previous 30 days, then one group per
 * month ("September"; "August 2025" in another year). A chat's time is its LAST message, the order the rail already
 * sorts by. A stamped chat name only says when the chat was created, so an unnamed chat is shown by what was last
 * said in it (`previewText`), and the row's right edge says when (`rowTime`).
 *
 * Pure: no DOM, no core imports. Unit-tested under node (tests/chat-groups.test.js).
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * Local midnight of a date.
 * @param {Date} d
 * @returns {number}
 */
function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The group a time belongs to.
 * @param {number} ms Epoch milliseconds of the chat's last message.
 * @param {Date} [now]
 * @param {string} [locale] Intl locale; the browser's by default.
 * @returns {{ key: string, label: string }}
 */
export function recencyGroup(ms, now = new Date(), locale = undefined) {
    if (!Number.isFinite(ms) || ms <= 0) return { key: 'older', label: 'Older' };
    const today = startOfDay(now);
    if (ms >= today) return { key: 'today', label: 'Today' };
    if (ms >= today - DAY) return { key: 'yesterday', label: 'Yesterday' };
    if (ms >= today - 7 * DAY) return { key: 'week', label: 'Previous 7 days' };
    if (ms >= today - 30 * DAY) return { key: 'month', label: 'Previous 30 days' };
    const d = new Date(ms);
    const sameYear = d.getFullYear() === now.getFullYear();
    const label = new Intl.DateTimeFormat(locale, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' }).format(d);
    return { key: `m${d.getFullYear()}-${d.getMonth()}`, label };
}

/**
 * Rows (already newest first) split into consecutive recency groups; order is kept.
 * @template {{ lastMs: number }} T
 * @param {T[]} rows
 * @param {Date} [now]
 * @param {string} [locale]
 * @returns {{ key: string, label: string, rows: T[] }[]}
 */
export function groupByRecency(rows, now = new Date(), locale = undefined) {
    /** @type {{ key: string, label: string, rows: T[] }[]} */
    const groups = [];
    for (const row of rows) {
        const { key, label } = recencyGroup(row.lastMs, now, locale);
        const last = groups[groups.length - 1];
        if (last && last.key === key) last.rows.push(row);
        else groups.push({ key, label, rows: [row] });
    }
    return groups;
}

/**
 * What the row's right edge says: the time on Today and Yesterday, the weekday within the week, else the date.
 * @param {number} ms
 * @param {Date} [now]
 * @param {string} [locale]
 * @returns {string}
 */
export function rowTime(ms, now = new Date(), locale = undefined) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const { key } = recencyGroup(ms, now, locale);
    if (key === 'today' || key === 'yesterday') return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d);
    if (key === 'week') return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
    const sameYear = d.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/**
 * What core puts in `mes` for a chat with nothing to show (`src/endpoints/chats.js` `getChatInfo`: an empty
 * file, a header-only file, an unreadable last line). Not a line anyone wrote, so not a preview.
 */
const CORE_PLACEHOLDERS = new Set(['[The chat is empty]', '[The message is empty]']);

/** How much of the last message core keeps behind "..." in a scene's `preview_message` (`chats.js` `getPreviewMessage`). */
const CORE_PREVIEW_CHARS = 400;

/**
 * A message as one plain line for a row: tags and markdown emphasis dropped, whitespace collapsed, cut at a word.
 * @param {unknown} raw The message text (`mes`, or a scene's `preview_message`).
 * @param {number} [max] Characters kept before the ellipsis (the row clamps visually too).
 * @param {object} [options]
 * @param {boolean} [options.tail] The text is the TAIL of a message behind "..." (`scenePreviewText`). Off for a
 *   whole message, which may well open with an ellipsis of its own ("...fine.").
 * @returns {string}
 */
export function previewText(raw, max = 140, { tail = false } = {}) {
    let text = String(raw ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[*_~`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (CORE_PLACEHOLDERS.has(text)) return '';
    if (tail) {
        // Cut mid-word: start at the next whole word. Cut on a space: the first word is whole and stays.
        const cut = /^(?:\.\.\.|…)(?:\s+|\S*\s+)/.exec(text);
        if (cut) text = `…${text.slice(cut[0].length)}`;
    }
    if (text.length > max) {
        const cut = text.slice(0, max);
        const space = cut.lastIndexOf(' ');
        text = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`;
    }
    return text;
}

/**
 * A scene's `preview_message` as one line. Core sends a message of up to 400 characters whole and a longer one as
 * "..." plus its last 400, so only the longer shape is read as a tail.
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string}
 */
export function scenePreviewText(raw, max = 140) {
    const text = String(raw ?? '');
    return previewText(text, max, { tail: text.startsWith('...') && text.length > CORE_PREVIEW_CHARS });
}
