/**
 * Cast state — who is on stage and what each member is doing right now
 * (`docs/group-chat-v0.md` G3/G4). DOM-free and import-free apart from the scene model, so the
 * stage strip and the cast tab share one tested reading (`tests/cast-state.test.js`).
 *
 * Live inputs come from core's group wrapper events:
 * - `GROUP_WRAPPER_STARTED` carries `queue` (drafted avatars in speaking order — a Kotatsu
 *   addition to the payload, `group-chats.js`);
 * - `GROUP_MEMBER_DRAFTED` names the member now writing (a character index);
 * - `GROUP_WRAPPER_FINISHED` ends the round.
 * The cue queue (`cue-queue.js`) adds the members the user asked to hear next.
 */

import { castHues, castOf, rosterByAvatar } from './scene-model.js';

/**
 * @typedef {'writing'|'next'|'queued'|'cued'|'idle'|'muted'|'missing'} SeatState
 */

/**
 * @typedef {object} Seat
 * @property {string} avatar Card filename.
 * @property {string} name Display name.
 * @property {string} short First name — what a stage seat and its caption say ("Hana" for
 *   "Hana Kurogane"); the full name stays in the cast tab, menus and labels.
 * @property {number} hue Identity hue, 0-359.
 * @property {boolean} present Card exists.
 * @property {boolean} muted In `disabled_members`.
 * @property {boolean} narrator The narrator seat (§13): always muted by design, so it never shows
 *   "muted"; it speaks when called.
 * @property {SeatState} state What the seat shows.
 * @property {number} turns Replies this member has in the chat.
 * @property {number} share Share of all character replies, 0-1.
 */

/**
 * @typedef {object} LiveRound
 * @property {string[]} queue Drafted avatars in order, as the wrapper announced them.
 * @property {string} writing The avatar now generating, '' when none.
 * @property {string[]} cued Avatars the user cued to speak after this round, in order.
 */

/** @returns {LiveRound} */
export function idleRound() {
    return { queue: [], writing: '', cued: [] };
}

/**
 * Replies per member, counted from the chat array. Only character messages with an
 * `original_avatar` count (that is how core marks a group speaker, `script.js:7153`); user,
 * system and narrator lines never do.
 * @param {any[]} chat Core's `chat` array.
 * @returns {Map<string, number>} avatar → replies.
 */
export function turnCounts(chat) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const message of Array.isArray(chat) ? chat : []) {
        if (!message || message.is_user || message.is_system) {
            continue;
        }
        const avatar = typeof message.original_avatar === 'string' ? message.original_avatar : '';
        if (!avatar) {
            continue;
        }
        counts.set(avatar, (counts.get(avatar) ?? 0) + 1);
    }
    return counts;
}

/**
 * The seat a member shows. Writing beats everything; a muted member who is writing (forced to
 * speak) still shows writing, because that is what is happening.
 * @param {string} avatar
 * @param {boolean} muted
 * @param {boolean} present
 * @param {LiveRound} round
 * @returns {SeatState}
 */
export function seatState(avatar, muted, present, round) {
    if (!present) return 'missing';
    if (round.writing === avatar) return 'writing';
    const at = round.queue.indexOf(avatar);
    const writingAt = round.writing ? round.queue.indexOf(round.writing) : -1;
    if (at > writingAt && at >= 0) {
        return at === writingAt + 1 ? 'next' : 'queued';
    }
    if (round.cued.includes(avatar)) {
        // The first cue is "next" once the wrapper has nobody left after the writer.
        const remaining = round.queue.slice(writingAt + 1);
        return remaining.length === 0 && round.cued[0] === avatar ? 'next' : 'cued';
    }
    return muted ? 'muted' : 'idle';
}

/**
 * @param {string} name A display name.
 * @returns {string} Its first word, or the whole name when it is one word or the first word is
 *   only a title ("Dr", "Lady").
 */
export function firstName(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) return words[0] ?? '';
    return /^(dr|mr|mrs|ms|miss|sir|lady|lord|the)\.?$/i.test(words[0]) ? words.slice(0, 2).join(' ') : words[0];
}

/**
 * Every seat on stage, in seating order.
 * @param {any} group Core group record.
 * @param {any[]} characters Core roster.
 * @param {any[]} chat Core chat array.
 * @param {LiveRound} round Live state.
 * @returns {Seat[]}
 */
export function seats(group, characters, chat, round) {
    const cast = castOf(group, rosterByAvatar(characters));
    // The narrator takes no slot on the hue wheel, so seating one never recolours the cast.
    const hues = castHues(cast.filter(member => member.role === 'cast').map(member => member.avatar));
    const counts = turnCounts(chat);
    let total = 0;
    for (const member of cast) total += counts.get(member.avatar) ?? 0;
    return cast.map(member => {
        const turns = counts.get(member.avatar) ?? 0;
        const narrator = member.role === 'narrator';
        return {
            avatar: member.avatar,
            name: member.name,
            short: firstName(member.name),
            hue: hues.get(member.avatar) ?? 0,
            present: member.present,
            muted: member.muted && !narrator,
            narrator,
            state: seatState(member.avatar, member.muted && !narrator, member.present, round),
            turns,
            share: total > 0 ? turns / total : 0,
        };
    });
}

/**
 * The one-line status the strip prints: "Aelirenn is writing · then Seraphina", "Seraphina is
 * up next", or '' when nothing is happening.
 * @param {Seat[]} list
 * @param {LiveRound} round
 * @returns {string}
 */
export function statusLine(list, round) {
    const name = (/** @type {string} */ avatar) => list.find(seat => seat.avatar === avatar)?.short ?? '';
    const writing = round.writing ? name(round.writing) : '';
    const writingAt = round.writing ? round.queue.indexOf(round.writing) : -1;
    const after = [...round.queue.slice(writingAt + 1), ...round.cued].map(name).filter(Boolean);
    if (writing) {
        return after.length ? `${writing} is writing · then ${after[0]}${after.length > 1 ? ` +${after.length - 1}` : ''}` : `${writing} is writing`;
    }
    if (after.length) {
        return `${after[0]} is up next`;
    }
    return '';
}
