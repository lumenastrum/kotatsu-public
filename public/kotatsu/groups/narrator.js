/**
 * The narrator seat — the DOM-free half (`docs/group-chat-v0.md` §12–13).
 *
 * A scene's narrator voices the world and every person outside the cast. It is a card Kotatsu
 * provisions once (`narrator-seat.js`), flagged `data.extensions.kotatsu.role = 'narrator'`, and
 * seated like a member with two rules that keep stock ST's engine doing the right thing:
 * - **always muted** (`disabled_members`): core's strategies never draft a muted member, and every
 *   cue path (`force_chid`) ignores mute, so the narrator speaks exactly when called;
 * - **always last**: core's quiet generations and its swipe fallback take `members[0]` without
 *   asking about mute (`group-chats.js` quiet branch, `activateSwipe`).
 * Stock ST opening the same data sees an ordinary muted member.
 *
 * During "Let them talk" the narrator steps in after every N cast replies, N being the scene's
 * pace. The pace lives on the group record (`kotatsu_narrator_every`); unset means the default.
 *
 * Import-free apart from the core leaf that owns the role flag, so jest can test it whole.
 */

import { NARRATOR_ROLE, isNarratorCard } from '../../scripts/group-nudge.js';

export { NARRATOR_ROLE, isNarratorCard };

/** The provisioned card's display name. */
export const NARRATOR_NAME = 'Narrator';

/** `file_name` for the provisioning create, so the card's avatar key is stable. */
export const NARRATOR_FILE_NAME = 'kotatsu-narrator';

/** Group record key for the pace. Written by the scene studio; stock ST ignores it. */
export const NARRATOR_PACE_KEY = 'kotatsu_narrator_every';

/** Cast replies between the narrator's turns when the scene says nothing. */
export const NARRATOR_PACE_DEFAULT = 3;

/**
 * The paces the studio offers. 0 = only when someone calls it. `label` is the pill (the four fit
 * one row of the studio panel; the hint under them names the unit), `long` its tooltip and
 * accessible name.
 * @type {ReadonlyArray<{ value: number, label: string, long: string }>}
 */
export const NARRATOR_PACES = Object.freeze([
    Object.freeze({ value: 0, label: 'Only when called', long: 'Only when called' }),
    Object.freeze({ value: 2, label: 'Every 2', long: 'Every 2 replies' }),
    Object.freeze({ value: 3, label: 'Every 3', long: 'Every 3 replies' }),
    Object.freeze({ value: 5, label: 'Every 5', long: 'Every 5 replies' }),
]);

/**
 * @param {unknown} value A record's `kotatsu_narrator_every`.
 * @returns {number} One of {@link NARRATOR_PACES}' values; the default for anything else.
 */
export function narratorPace(value) {
    const n = Number(value);
    return NARRATOR_PACES.some(pace => pace.value === n) && value !== null && value !== '' ? n : NARRATOR_PACE_DEFAULT;
}

/**
 * @param {any} group Core group record.
 * @param {Map<string, any>} byAvatar Roster keyed by avatar filename.
 * @returns {string} The seated narrator's avatar, '' when the scene has none.
 */
export function narratorAvatarOf(group, byAvatar) {
    for (const avatar of Array.isArray(group?.members) ? group.members : []) {
        if (typeof avatar === 'string' && isNarratorCard(byAvatar.get(avatar))) {
            return avatar;
        }
    }
    return '';
}

/**
 * Cast replies since the narrator last spoke (or since the chat began). User and system lines
 * don't count, and don't reset the count either: the pace is about the cast carrying the scene.
 * @param {any[]} chat Core's `chat` array.
 * @param {string} narratorAvatar
 * @returns {number}
 */
export function repliesSinceNarrator(chat, narratorAvatar) {
    let count = 0;
    const list = Array.isArray(chat) ? chat : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        const message = list[index];
        if (!message || message.is_user || message.is_system) continue;
        const avatar = typeof message.original_avatar === 'string' ? message.original_avatar : '';
        if (!avatar) continue;
        if (avatar === narratorAvatar) break;
        count += 1;
    }
    return count;
}

/**
 * @param {any[]} chat Core's `chat` array.
 * @param {string} narratorAvatar '' when the scene has no narrator.
 * @param {number} pace {@link narratorPace}.
 * @returns {boolean} Whether the narrator's turn has come round.
 */
export function narratorDue(chat, narratorAvatar, pace) {
    return Boolean(narratorAvatar) && pace > 0 && repliesSinceNarrator(chat, narratorAvatar) >= pace;
}

/**
 * The seating with the narrator last (and once), whatever order it arrived in.
 * @param {string[]} members
 * @param {string} narratorAvatar '' to leave the list as it is.
 * @returns {string[]} A new array.
 */
export function seatNarratorLast(members, narratorAvatar) {
    const list = (Array.isArray(members) ? members : []).filter(avatar => avatar !== narratorAvatar);
    if (narratorAvatar) list.push(narratorAvatar);
    return list;
}

/**
 * The `/api/characters/create` form fields for the narrator card. The description is neutral on
 * purpose: in the "whole cast, muted too" card mode every cast member reads it as a member's card.
 * No greeting, so a new scene chat doesn't open on the narrator; talkativeness 0 in case anything
 * ever unmutes it. The picture is uploaded beside these fields (`narrator-seat.js`): the lantern
 * portrait, so its rows wear the glyph its stage seat shows.
 * @returns {Record<string, string>}
 */
export function narratorCardFields() {
    return {
        ch_name: NARRATOR_NAME,
        file_name: NARRATOR_FILE_NAME,
        description: 'The Narrator is the voice of the world around the cast: the place, the weather, the sounds, and every person who is not one of the cast. It is not a person in the story and never speaks as "I".',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: 'Kotatsu\'s scene narrator. Seat it from Edit scene; it stays muted and speaks when called or at the scene\'s pace.',
        talkativeness: '0',
        fav: 'false',
        extensions: JSON.stringify({ kotatsu: { role: NARRATOR_ROLE } }),
    };
}
