/*
 * Kotatsu chat labels — blue-hour-polish-v0 §C5.
 *
 * Core names a new chat after the character plus a stamp (`humanizedDateTime()`,
 * RossAscends-mods.js:177): `Aelirenn - 2026-08-25@13h40m11s263ms`. Older installs wrote
 * `Seraphina - 2023-5-12 @21h 32m 29s 224ms`, and a core branch appends ` - Branch #N`. The
 * rails printed that id verbatim, in mono, everywhere a chat is named — the rail, the branch
 * lineage, the switcher. Andres's call (2026-10-01): show the date, keep the filename as the
 * hover tooltip.
 *
 * DISPLAY ONLY. The id stays the identity in every handler, filter, `title` and aria hook;
 * this module never sees a click. A name without a trailing stamp (a renamed chat — "Night
 * Raid - what if") comes back untouched, and so does anything the parser cannot read as a real
 * calendar date.
 *
 * Pure: no DOM, no core imports — unit-tested under node (tests/chat-label.test.js).
 */

/*
 * The stamp, anchored at the end, optionally followed by core's branch suffix. Both stamp
 * generations parse: `2026-08-25@13h40m11s263ms` and `2023-5-12 @21h 32m 29s 224ms`.
 */
const STAMP = /^(.*?)\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*\d{1,3}\s*ms)?(?:\s*-\s*Branch\s*#(\d+))?\s*$/;

/** The separator between label parts. */
const SEP = ' · ';

/**
 * @typedef {object} ChatLabel
 * @property {string} text What the UI prints.
 * @property {boolean} stamped True when a stamp was found and replaced.
 */

/**
 * @param {string} fileId Extension-less chat id, verbatim.
 * @param {object} [options]
 * @param {string} [options.characterName] The open character's name — a prefix equal to it is
 *   dropped, since every surface already says whose chat this is.
 * @param {Date} [options.now] "Today", for the same-year test (tests pin it).
 * @param {string|undefined} [options.locale] Intl locale; the browser's by default.
 * @returns {ChatLabel}
 */
export function chatLabel(fileId, { characterName = '', now = new Date(), locale = undefined } = {}) {
    const raw = String(fileId ?? '');
    const match = STAMP.exec(raw);
    if (!match) return { text: raw, stamped: false };

    const [, prefixRaw, y, mo, d, h, mi, s, branch] = match;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    // Reject what Date silently rolls over (month 13, Feb 30, hour 25): not a stamp, a name.
    if (Number.isNaN(date.getTime()) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)
        || date.getHours() !== Number(h) || date.getMinutes() !== Number(mi)) {
        return { text: raw, stamped: false };
    }

    const sameYear = date.getFullYear() === now.getFullYear();
    const day = new Intl.DateTimeFormat(locale, sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);

    const prefix = prefixRaw.replace(/\s*-\s*$/, '').trim();
    const parts = [];
    if (prefix && prefix !== characterName.trim()) parts.push(prefix);
    parts.push(day, time);
    if (branch) parts.push(`Branch ${branch}`);
    return { text: parts.join(SEP), stamped: true };
}

/**
 * Shorthand for templates: just the text.
 * @param {string} fileId
 * @param {string} [characterName]
 * @returns {string}
 */
export function chatLabelText(fileId, characterName = '') {
    return chatLabel(fileId, { characterName }).text;
}
