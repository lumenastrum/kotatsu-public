/**
 * Scenes — the DOM-free model behind every group surface (`docs/group-chat-v0.md`).
 *
 * Kotatsu calls a stock ST group a **scene** (decision D2, 2026-10-08) and its members the
 * **cast**. Code and data keep core's names: the record is still a `Group` in
 * `data/<user>/groups/<id>.json` (`public/global.d.ts:26-43`), written by core's `editGroup()`.
 * This module only reads records and turns them into what the rails draw, plus the
 * plain-language mapping onto core's enums.
 *
 * A leaf with no imports beyond the narrator's pure module, so the rail, the stage, the cast tab
 * and the scene studio share one tested reading of the record (`tests/scene-model.test.js`)
 * without dragging Lit or core into jest. `accentHue()` is the library's identity hash, copied in
 * the same spirit as `library/card-identity.js`'s own header explains.
 *
 * The narrator seat (§13) is a member here like any other, flagged `role: 'narrator'`; it is not
 * "the cast". Rows, faces, counts, hues and the studio form all leave it out, and the form carries
 * it as a switch (`narrator`) plus a pace instead of a seat.
 */

import { NARRATOR_PACE_DEFAULT, NARRATOR_PACE_KEY, isNarratorCard, narratorPace, seatNarratorLast } from './narrator.js';

/** Faces a scene row stacks before it stops (the rail draws ~20px chips). */
export const SCENE_FACES_MAX = 3;

/**
 * Core's activation strategies (`group-chats.js:122-127`) in the order the UI offers them,
 * worded for people rather than for the engine. `short` is the segmented-control label.
 * @type {ReadonlyArray<{ value: number, key: string, label: string, short: string, hint: string }>}
 */
export const TURN_STYLES = Object.freeze([
    Object.freeze({ value: 0, key: 'natural', label: 'Natural', short: 'Natural', hint: 'Whoever you name answers first, then anyone chatty enough joins in.' }),
    Object.freeze({ value: 1, key: 'turns', label: 'Take turns', short: 'In order', hint: 'Everyone answers, in seating order.' }),
    Object.freeze({ value: 3, key: 'pooled', label: 'One at a time', short: 'Each once', hint: 'One voice who hasn’t spoken yet this round, picked at random.' }),
    Object.freeze({ value: 2, key: 'manual', label: 'Only when I call', short: 'I choose', hint: 'Nobody speaks until you tap them or @ them.' }),
]);

/**
 * Core's generation modes (`group-chats.js:129-133`): what each speaker's prompt carries.
 * @type {ReadonlyArray<{ value: number, key: string, label: string, hint: string, advanced?: boolean }>}
 */
export const CARD_MODES = Object.freeze([
    Object.freeze({ value: 0, key: 'own', label: 'Their own card', hint: 'Sharper voices. Recommended.' }),
    Object.freeze({ value: 1, key: 'joined', label: 'The whole cast', hint: 'Every unmuted card joined into one.' }),
    Object.freeze({ value: 2, key: 'joined-all', label: 'The whole cast, muted too', hint: 'Joined cards include muted members.', advanced: true }),
]);

/**
 * @param {unknown} value A record's `activation_strategy`.
 * @returns {typeof TURN_STYLES[number]} The matching style; Natural for anything unknown, the
 *   same fallback core's wrapper takes (`group-chats.js:1002`, a switch with no default arm).
 */
export function turnStyle(value) {
    const n = Number(value);
    return TURN_STYLES.find(style => style.value === n) ?? TURN_STYLES[0];
}

/**
 * @param {unknown} value A record's `generation_mode`.
 * @returns {typeof CARD_MODES[number]} The matching mode; "own card" (SWAP) for anything unknown.
 */
export function cardMode(value) {
    const n = Number(value);
    return CARD_MODES.find(mode => mode.value === n) ?? CARD_MODES[0];
}

/**
 * `date_last_chat` off `/api/groups/all` is the newest chat mtime in ms (`groups.js:133-145`);
 * the client also writes `Date.now()` into it (`group-chats.js:630`, `:2205`). Old records may
 * carry a string. Anything unreadable is 0 — "unknown", never "1970".
 * @param {unknown} value Raw value.
 * @returns {number} Epoch ms, or 0.
 */
export function toEpochMs(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
            return numeric > 0 ? numeric : 0;
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    return 0;
}

/**
 * A scene's favourite flag. Core writes a boolean (`group-chats.js:1752`); older records and
 * the create path can carry `"true"` or nothing.
 * @param {unknown} value Raw `fav`.
 * @returns {boolean}
 */
export function isFav(value) {
    return value === true || value === 'true';
}

/**
 * @typedef {object} CastMember
 * @property {string} avatar Card filename — the member key in `members[]`.
 * @property {string} name Display name, or the filename stem when the card is missing.
 * @property {boolean} present True when the card exists in the roster.
 * @property {boolean} muted True when listed in `disabled_members`.
 * @property {'cast'|'narrator'} role The narrator seat, or a character of the cast.
 */

/**
 * @typedef {object} SceneRow
 * @property {string} id Group id (core keeps it a string; `getGroups` converts, GC:771).
 * @property {string} name Display name.
 * @property {CastMember[]} cast Members in seating order, missing cards included (flagged), the
 *   narrator seat included (role-flagged).
 * @property {string[]} faces Up to {@link SCENE_FACES_MAX} avatar filenames that resolve; never the
 *   narrator.
 * @property {number} memberCount Cast members whose card exists; the narrator doesn't count.
 * @property {boolean} narrator Whether the scene seats a narrator.
 * @property {number} chatCount Entries in `chats[]`.
 * @property {number} lastMs Newest chat activity, epoch ms, 0 when unknown.
 * @property {boolean} fav Favourite flag.
 * @property {string} chatId The scene's open chat id (`chat_id`).
 */

/**
 * Builds the cast of one record against the roster.
 * @param {any} group Core group record.
 * @param {Map<string, any>} byAvatar Roster keyed by avatar filename.
 * @returns {CastMember[]}
 */
export function castOf(group, byAvatar) {
    const members = Array.isArray(group?.members) ? group.members : [];
    const muted = new Set(Array.isArray(group?.disabled_members) ? group.disabled_members : []);
    /** @type {CastMember[]} */
    const cast = [];
    const seen = new Set();
    for (const raw of members) {
        if (typeof raw !== 'string' || !raw || seen.has(raw)) {
            continue;
        }
        seen.add(raw);
        const character = byAvatar.get(raw);
        cast.push({
            avatar: raw,
            name: String(character?.name ?? '').trim() || raw.replace(/\.[a-z0-9]+$/i, ''),
            present: Boolean(character),
            muted: muted.has(raw),
            role: isNarratorCard(character) ? 'narrator' : 'cast',
        });
    }
    return cast;
}

/**
 * @param {any[]} characters Core's `characters` array (shallow records are enough).
 * @returns {Map<string, any>} Roster keyed by avatar filename.
 */
export function rosterByAvatar(characters) {
    const map = new Map();
    for (const character of Array.isArray(characters) ? characters : []) {
        if (character && typeof character.avatar === 'string' && character.avatar) {
            map.set(character.avatar, character);
        }
    }
    return map;
}

/**
 * @param {any} group Core group record.
 * @param {Map<string, any>} byAvatar Roster keyed by avatar filename.
 * @returns {SceneRow}
 */
export function sceneRow(group, byAvatar) {
    const cast = castOf(group, byAvatar);
    const present = cast.filter(member => member.present && member.role === 'cast');
    return {
        id: String(group?.id ?? ''),
        name: String(group?.name ?? '').trim() || 'Unnamed scene',
        cast,
        faces: present.slice(0, SCENE_FACES_MAX).map(member => member.avatar),
        memberCount: present.length,
        narrator: cast.some(member => member.role === 'narrator'),
        chatCount: Array.isArray(group?.chats) ? group.chats.length : 0,
        lastMs: toEpochMs(group?.date_last_chat),
        fav: isFav(group?.fav),
        chatId: typeof group?.chat_id === 'string' ? group.chat_id : '',
    };
}

/**
 * Every scene, newest activity first; favourites are NOT floated (the rail is a recency list —
 * the library owns the favourites filter). Records without an id are skipped: core cannot open
 * them either.
 * @param {any[]} groups Core's `groups` array.
 * @param {any[]} characters Core's `characters` array.
 * @returns {SceneRow[]}
 */
export function sceneRows(groups, characters) {
    const byAvatar = rosterByAvatar(characters);
    const rows = (Array.isArray(groups) ? groups : [])
        .filter(group => group && group.id !== undefined && group.id !== null && String(group.id) !== '')
        .map(group => sceneRow(group, byAvatar));
    // Stable sort: equal (or unknown) recency keeps core's order.
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => (b.row.lastMs - a.row.lastMs) || (a.index - b.index))
        .map(({ row }) => row);
}

/**
 * Deterministic accent hue for a card — FNV-1a over the avatar filename, the same function as
 * `library/card-identity.js` so a character wears the same hue on her poster and in a scene.
 * @param {unknown} key Avatar filename.
 * @returns {number} An integer in [0, 360).
 */
export function accentHue(key) {
    const text = typeof key === 'string' && key ? key : 'kotatsu';
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
    return hash % 360;
}

/**
 * @param {number} hue 0-359.
 * @returns {string} The identity colour, inside the theme's band (`--k-scene-hue-s/l` in
 *   css/scenes.css) — only the hue is per-member, so a pack retunes every cast colour at once.
 */
export function hueColor(hue) {
    return `hsl(${hue} var(--k-scene-hue-s) var(--k-scene-hue-l))`;
}

/**
 * The circular distance between two hues.
 * @param {number} a
 * @param {number} b
 * @returns {number} 0-180.
 */
function hueGap(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
}

/**
 * Identity hues for a cast, kept apart so speakers are told apart at a glance.
 *
 * Each member starts at their own {@link accentHue} — the hue their library poster already
 * wears. Members are placed in seating order; a member whose hue sits closer than `minGap` to
 * one already placed walks round the wheel in `step` increments (alternating directions, so
 * the nudge is as small as it can be) until it clears every placed hue. When the wheel is too
 * crowded for the gap (more members than `360 / minGap`), the gap halves and the walk repeats,
 * so the function always terminates and always returns one hue per member.
 *
 * Deterministic: the same cast in the same order always gets the same colours, and adding a
 * member never recolours the ones already seated.
 * @param {string[]} avatars Member avatar filenames in seating order.
 * @param {number} [minGap] Minimum separation in degrees.
 * @param {number} [step] Walk increment in degrees.
 * @returns {Map<string, number>} avatar → hue.
 */
export function castHues(avatars, minGap = 40, step = 7) {
    /** @type {Map<string, number>} */
    const out = new Map();
    const list = (Array.isArray(avatars) ? avatars : []).filter(a => typeof a === 'string' && a);
    let gap = Math.max(0, Math.min(minGap, 180));
    while (gap > 0 && list.length * gap > 360) {
        gap = Math.floor(gap / 2);
    }
    /** @type {number[]} */
    const placed = [];
    for (const avatar of list) {
        if (out.has(avatar)) {
            continue;
        }
        const home = accentHue(avatar);
        let hue = home;
        const clear = (/** @type {number} */ h) => placed.every(p => hueGap(p, h) >= gap);
        if (!clear(hue)) {
            for (let k = 1; k <= Math.ceil(360 / step); k += 1) {
                const up = (home + k * step) % 360;
                const down = (home - k * step + 360) % 360;
                if (clear(up)) { hue = up; break; }
                if (clear(down)) { hue = down; break; }
            }
        }
        placed.push(hue);
        out.set(avatar, hue);
    }
    return out;
}

/* ── the scene studio's form (docs/group-chat-v0.md G2) ─────────────────────────────────────── */

/** Core's default auto-mode delay in seconds (`DEFAULT_AUTO_MODE_DELAY`, `group-chats.js:135`). */
export const DEFAULT_AUTO_DELAY = 5;

/**
 * @typedef {object} SceneForm
 * @property {string} name What the user typed; '' means "use the suggestion".
 * @property {string[]} members Avatar filenames in seating order.
 * @property {number} activation_strategy Core enum (see {@link TURN_STYLES}).
 * @property {number} generation_mode Core enum (see {@link CARD_MODES}).
 * @property {boolean} allow_self_responses Natural only: the last speaker may go again.
 * @property {number} auto_mode_delay Seconds between "Let them talk" replies, 1-999.
 * @property {string} generation_mode_join_prefix Joined modes only.
 * @property {string} generation_mode_join_suffix Joined modes only.
 * @property {boolean} hideMutedSprites Expressions extension, visual-novel mode.
 * @property {boolean} fav Favourite flag.
 * @property {string} avatar_url Custom cover path, '' for the cast collage.
 * @property {boolean} narrator Whether the scene seats a narrator (§13). Never a seat in `members`.
 * @property {number} narrator_every The narrator's pace during Let them talk (`narrator.js`).
 */

/**
 * @typedef {object} NarratorSeat
 * @property {string} [narratorAvatar] The provisioned narrator card's avatar; '' (the default)
 *   seats no narrator whatever the form says.
 */

/** @returns {SceneForm} A blank create form. */
export function blankSceneForm() {
    return {
        name: '',
        members: [],
        narrator: false,
        narrator_every: NARRATOR_PACE_DEFAULT,
        activation_strategy: 0,
        generation_mode: 0,
        allow_self_responses: false,
        auto_mode_delay: DEFAULT_AUTO_DELAY,
        generation_mode_join_prefix: '',
        generation_mode_join_suffix: '',
        hideMutedSprites: false,
        fav: false,
        avatar_url: '',
    };
}

/**
 * Core's create path stores `default_avatar` (`img/ai4.png`) when no picture was chosen
 * (`group-chats.js:2108`), and `getGroupAvatar()` treats anything that is not a data URL or a
 * `user/…` path as "no custom image". This mirrors that test, so a stock group created in
 * classic reads as "collage" here too.
 * @param {unknown} url Raw `avatar_url`.
 * @returns {boolean}
 */
export function isCustomCover(url) {
    if (typeof url !== 'string' || !url) {
        return false;
    }
    return url.startsWith('data:image') || url.startsWith('user') || url.startsWith('/user');
}

/**
 * @param {any} group Core group record.
 * @param {Map<string, any>} [byAvatar] Roster keyed by avatar filename — how a seated narrator is
 *   told apart from the cast. Without it every member reads as cast.
 * @returns {SceneForm} The form for editing it. Members are de-duplicated; the delay is clamped.
 */
export function formFromGroup(group, byAvatar = new Map()) {
    const base = blankSceneForm();
    const members = [];
    let narrator = false;
    for (const raw of Array.isArray(group?.members) ? group.members : []) {
        if (typeof raw !== 'string' || !raw || members.includes(raw)) continue;
        if (isNarratorCard(byAvatar.get(raw))) {
            narrator = true;
            continue;
        }
        members.push(raw);
    }
    return {
        ...base,
        name: String(group?.name ?? ''),
        members,
        narrator,
        narrator_every: narratorPace(group?.[NARRATOR_PACE_KEY]),
        activation_strategy: turnStyle(group?.activation_strategy).value,
        generation_mode: cardMode(group?.generation_mode).value,
        allow_self_responses: Boolean(group?.allow_self_responses),
        auto_mode_delay: clampDelay(group?.auto_mode_delay),
        generation_mode_join_prefix: typeof group?.generation_mode_join_prefix === 'string' ? group.generation_mode_join_prefix : '',
        generation_mode_join_suffix: typeof group?.generation_mode_join_suffix === 'string' ? group.generation_mode_join_suffix : '',
        hideMutedSprites: Boolean(group?.hideMutedSprites),
        fav: isFav(group?.fav),
        avatar_url: isCustomCover(group?.avatar_url) ? group.avatar_url : '',
    };
}

/**
 * @param {unknown} value Seconds.
 * @returns {number} An integer in 1-999 (the stock field's own bounds, `index.html:6519`).
 */
export function clampDelay(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) {
        return DEFAULT_AUTO_DELAY;
    }
    return Math.min(999, Math.max(1, n));
}

/**
 * The name a scene gets when the user leaves the field blank — the cast, said the way a person
 * would. Core's own fallback is `Group: A, B, C` (`group-chats.js:2096-2098`).
 * @param {string[]} names Member names in seating order.
 * @returns {string}
 */
export function suggestedName(names) {
    const list = (Array.isArray(names) ? names : []).map(n => String(n ?? '').trim()).filter(Boolean);
    if (list.length === 0) {
        return 'New scene';
    }
    if (list.length === 1) {
        return list[0];
    }
    if (list.length === 2) {
        return `${list[0]} & ${list[1]}`;
    }
    if (list.length === 3) {
        return `${list[0]}, ${list[1]} & ${list[2]}`;
    }
    return `${list[0]}, ${list[1]} & ${list.length - 2} more`;
}

/**
 * Seats or unseats a character. A new seat goes to the END — the order people are picked in is
 * the order they speak in "Take turns" (core's own add puts them at the top, GC:1423, which
 * surprised nobody only because nobody could see the order).
 * @param {string[]} members Current seating.
 * @param {string} avatar Card filename.
 * @returns {string[]} A new array.
 */
export function toggleSeat(members, avatar) {
    const list = Array.isArray(members) ? members.slice() : [];
    const at = list.indexOf(avatar);
    if (at >= 0) {
        list.splice(at, 1);
    } else if (typeof avatar === 'string' && avatar) {
        list.push(avatar);
    }
    return list;
}

/**
 * Moves a seat. Out-of-range moves are clamped; a no-op returns a copy.
 * @param {string[]} members Current seating.
 * @param {number} from Index to move.
 * @param {number} to Destination index.
 * @returns {string[]} A new array.
 */
export function moveSeat(members, from, to) {
    const list = Array.isArray(members) ? members.slice() : [];
    if (!Number.isInteger(from) || from < 0 || from >= list.length) {
        return list;
    }
    const target = Math.min(list.length - 1, Math.max(0, Math.round(Number(to)) || 0));
    const [item] = list.splice(from, 1);
    list.splice(target, 0, item);
    return list;
}

/**
 * @param {SceneForm} form
 * @returns {string[]} What stops the form from being saved, in reading order. Empty when it can.
 */
export function formProblems(form) {
    const problems = [];
    if (!Array.isArray(form?.members) || form.members.length === 0) {
        problems.push('Seat at least one character.');
    }
    return problems;
}

/**
 * The record fields a form writes. Shared by create and edit so both paths always agree on what
 * a scene is. `name` falls back to the suggestion; joined-mode text is kept even when the mode
 * is "own card" (core keeps it too, and switching back should not lose it).
 * The narrator, when the form seats one and its card exists, goes last; its pace is written only
 * for a scene that seats it.
 * @param {SceneForm} form
 * @param {string[]} memberNames Names for the seated members, for the fallback name.
 * @param {NarratorSeat} [seat]
 * @returns {Record<string, unknown>}
 */
export function recordFields(form, memberNames, { narratorAvatar = '' } = {}) {
    const cast = (Array.isArray(form.members) ? form.members : []).filter(avatar => avatar !== narratorAvatar);
    const narrator = form.narrator && narratorAvatar ? narratorAvatar : '';
    return {
        name: String(form.name ?? '').trim() || suggestedName(memberNames),
        members: seatNarratorLast(cast, narrator),
        ...(narrator ? { [NARRATOR_PACE_KEY]: narratorPace(form.narrator_every) } : {}),
        activation_strategy: turnStyle(form.activation_strategy).value,
        generation_mode: cardMode(form.generation_mode).value,
        allow_self_responses: Boolean(form.allow_self_responses),
        auto_mode_delay: clampDelay(form.auto_mode_delay),
        generation_mode_join_prefix: String(form.generation_mode_join_prefix ?? ''),
        generation_mode_join_suffix: String(form.generation_mode_join_suffix ?? ''),
        hideMutedSprites: Boolean(form.hideMutedSprites),
        fav: Boolean(form.fav),
        avatar_url: isCustomCover(form.avatar_url) ? form.avatar_url : '',
    };
}

/**
 * The body for `POST /api/groups/create` (`src/endpoints/groups.js:156-188`).
 * @param {SceneForm} form
 * @param {string[]} memberNames Names for the seated members.
 * @param {string} chatId The first chat's id (core uses `humanizedDateTime()`).
 * @param {NarratorSeat} [seat]
 * @returns {Record<string, unknown>} A seated narrator is muted from the start. The pace is not in
 *   the create whitelist (`groups.js:156-188`); the studio writes it with an edit right after.
 */
export function createBody(form, memberNames, chatId, { narratorAvatar = '' } = {}) {
    const fields = recordFields(form, memberNames, { narratorAvatar });
    const seated = Array.isArray(fields.members) && narratorAvatar && fields.members.includes(narratorAvatar);
    return {
        ...fields,
        disabled_members: seated ? [narratorAvatar] : [],
        chat_id: chatId,
        chats: [chatId],
    };
}

/**
 * Applies a form to a live record IN PLACE (core's `editGroup()` saves the object it finds in
 * `groups[]`, so the edit has to land on that object). Also drops muted entries for members who
 * left the scene — core's remove leaves them behind, so a re-seated character came back muted
 * (`docs/group-chat-v0.md` S7).
 * @param {any} group The live record.
 * @param {SceneForm} form
 * @param {string[]} memberNames Names for the seated members.
 * @param {NarratorSeat} [seat]
 * @returns {any} The same record. A seated narrator is always in `disabled_members`.
 */
export function applyForm(group, form, memberNames, { narratorAvatar = '' } = {}) {
    Object.assign(group, recordFields(form, memberNames, { narratorAvatar }));
    const seated = new Set(group.members);
    const muted = (Array.isArray(group.disabled_members) ? group.disabled_members : [])
        .filter((/** @type {unknown} */ avatar) => typeof avatar === 'string' && seated.has(avatar));
    if (narratorAvatar && seated.has(narratorAvatar) && !muted.includes(narratorAvatar)) {
        muted.push(narratorAvatar);
    }
    group.disabled_members = muted;
    return group;
}

/**
 * @param {SceneForm} a
 * @param {SceneForm} b
 * @returns {boolean} True when the two forms would write different records.
 */
export function formsDiffer(a, b) {
    const left = recordFields(a, []);
    const right = recordFields(b, []);
    // The fallback name is the same for both sides here, so a blank name compares as blank.
    left.name = String(a?.name ?? '').trim();
    right.name = String(b?.name ?? '').trim();
    // The narrator is a switch, not a seat: compare it (and its pace while it is on) directly.
    left.narrator = Boolean(a?.narrator);
    right.narrator = Boolean(b?.narrator);
    left.narrator_every = left.narrator ? narratorPace(a?.narrator_every) : 0;
    right.narrator_every = right.narrator ? narratorPace(b?.narrator_every) : 0;
    return JSON.stringify(left) !== JSON.stringify(right);
}

/* ── speaker colour in the transcript (docs/group-chat-v0.md G5) ─────────────────────────────── */

/**
 * A CSS string literal for an attribute selector value. Names are user data: quotes, backslashes
 * and line breaks must not break out of the selector.
 * @param {string} value
 * @returns {string} The value, quoted.
 */
export function cssString(value) {
    const escaped = String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\A ')
        .replace(/\r/g, '\\D ');
    return `"${escaped}"`;
}

/**
 * The stylesheet that gives each cast member's rows their identity colour. Core marks a group
 * row with `ch_name` = the speaker's name (`script.js:2893`) and nothing about which card spoke
 * that the cascade can read, so rules key on the name. Three rules a member:
 * - the row: `--k-speaker`, the broadcast rail token, and the stripe (`kotatsu-chrome.css` §15
 *   draws every character's stripe rose);
 * - the broadcast look's full-strength rail;
 * - the nameplate.
 * Each outranks the wardrobe's own name rules (`mes-variants.css`, `body #chat[data-k-mes-variant]
 * .mes:not(.smallSysMes) .name_text`) by carrying more attribute selectors, with no !important.
 *
 * The narrator wears no identity hue: its rows take `--k-scene-narrator` (a quiet ink, css/
 * scenes.css), so the world's voice never reads as one more person.
 * @param {Array<{ name: string, hue: number, narrator?: boolean }>} cast Members with their
 *   identity hues.
 * @returns {string} The sheet text; '' for an empty cast.
 */
export function speakerSheet(cast) {
    const scope = 'body[data-k-layout="rails"]';
    const seen = new Set();
    const rules = [];
    for (const member of Array.isArray(cast) ? cast : []) {
        const name = String(member?.name ?? '');
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const hue = Number.isFinite(member.hue) ? Math.round(member.hue) % 360 : 0;
        const color = member.narrator ? 'var(--k-scene-narrator)' : hueColor(hue);
        const row = `.mes[is_user="false"][ch_name=${cssString(name)}]:not(.smallSysMes)`;
        rules.push(
            `${scope} #chat ${row} { --k-speaker: ${color}; --k-broadcast-rail-color: var(--k-speaker); border-left-color: color-mix(in srgb, var(--k-speaker) 60%, transparent); }`,
            `${scope} #chat[data-k-mes-variant="broadcast"] ${row} { border-left-color: var(--k-speaker); }`,
            `${scope} #chat ${row} .name_text { color: var(--k-speaker); }`,
        );
    }
    return rules.join('\n');
}
