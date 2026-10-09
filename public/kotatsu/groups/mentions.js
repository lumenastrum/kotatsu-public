/**
 * @mentions in a scene's composer (`docs/group-chat-v0.md` G6, decision D3: chips cue in order).
 *
 * "@Seraphina @Aemeath what did we miss?" sends the message, then Seraphina answers, then
 * Aemeath — exactly those two, in that order, whatever the scene's turn style. Core's own
 * Natural-order mention matching (ASCII words, first member whose name contains the word,
 * `group-chats.js:1242-1316`, S11) is left alone for messages without an at sign.
 *
 * Pure: no DOM, no core (`tests/mentions.test.js`).
 */

/** A character that may end a mention: end of text, whitespace, or punctuation. */
const BOUNDARY = /^(?:$|[\s.,!?;:)\]}"'’”…—–-])/u;

/** A character that may precede the `@`: start of text, whitespace, or an opening mark. */
const BEFORE = /(?:^|[\s(["'‘“])$/u;

/**
 * @typedef {object} Mention
 * @property {string} name The cast name as written in the roster.
 * @property {number} start Index of the `@`.
 * @property {number} end Index just past the name.
 */

/**
 * Finds every @mention of a cast member. Matching is case-insensitive and Unicode-safe; longer
 * names win ("@Hinata QA" is Hinata QA, not Hinata) and a mention must end at a boundary
 * ("@Seraphinas" mentions nobody).
 * @param {string} text Draft text.
 * @param {string[]} names Cast names.
 * @returns {Mention[]} In order of appearance.
 */
export function findMentions(text, names) {
    const source = String(text ?? '');
    const sorted = [...new Set((Array.isArray(names) ? names : []).map(n => String(n ?? '').trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length);
    const lower = source.toLocaleLowerCase();
    /** @type {Mention[]} */
    const found = [];
    for (let i = source.indexOf('@'); i >= 0; i = source.indexOf('@', i + 1)) {
        if (!BEFORE.test(source.slice(0, i))) continue;
        for (const name of sorted) {
            const end = i + 1 + name.length;
            if (lower.slice(i + 1, end) === name.toLocaleLowerCase() && BOUNDARY.test(source.slice(end, end + 1))) {
                found.push({ name, start: i, end });
                break;
            }
        }
    }
    return found;
}

/**
 * The cue order a draft asks for: each mentioned member once, first mention wins the slot.
 * @param {Mention[]} mentions
 * @returns {string[]} Names.
 */
export function mentionOrder(mentions) {
    const order = [];
    for (const mention of mentions) {
        if (!order.includes(mention.name)) order.push(mention.name);
    }
    return order;
}

/**
 * The message as sent: the `@` signs come off, the names stay where the user put them
 * ("@Seraphina what did she miss?" → "Seraphina what did she miss?"). The model reads a
 * sentence, not a UI token.
 * @param {string} text
 * @param {Mention[]} mentions
 * @returns {string}
 */
export function stripMentionSigns(text, mentions) {
    let out = String(text ?? '');
    for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
        out = out.slice(0, mention.start) + out.slice(mention.start + 1);
    }
    return out;
}

/**
 * The at-query the caret is in, for the suggestion list: an at sign at a word start, then no
 * whitespace before the caret. Spaces end a query (names with spaces are still reachable by
 * typing their first word).
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, query: string }|null}
 */
export function mentionQuery(text, caret) {
    const source = String(text ?? '');
    const at = source.lastIndexOf('@', Math.max(0, caret - 1));
    if (at < 0 || at >= caret) return null;
    const query = source.slice(at + 1, caret);
    if (/\s/u.test(query)) return null;
    if (!BEFORE.test(source.slice(0, at))) return null;
    return { start: at, query };
}

/**
 * Suggestions for a query: names that start with it, then names containing it, roster order
 * kept within each group. An empty query lists everyone.
 * @param {string} query
 * @param {string[]} names
 * @returns {string[]}
 */
export function rankCandidates(query, names) {
    const q = String(query ?? '').toLocaleLowerCase();
    const list = (Array.isArray(names) ? names : []).filter(Boolean);
    if (!q) return list.slice();
    const starts = list.filter(n => n.toLocaleLowerCase().startsWith(q));
    const contains = list.filter(n => !starts.includes(n) && n.toLocaleLowerCase().includes(q));
    return [...starts, ...contains];
}

/**
 * Replaces the active query with a completed mention and a trailing space.
 * @param {string} text
 * @param {{ start: number, query: string }} active
 * @param {string} name
 * @returns {{ text: string, caret: number }}
 */
export function completeMention(text, active, name) {
    const source = String(text ?? '');
    const end = active.start + 1 + active.query.length;
    const after = source.slice(end);
    const insert = `@${name}${after.startsWith(' ') ? '' : ' '}`;
    const next = source.slice(0, active.start) + insert + after;
    return { text: next, caret: active.start + insert.length + (after.startsWith(' ') ? 1 : 0) };
}
