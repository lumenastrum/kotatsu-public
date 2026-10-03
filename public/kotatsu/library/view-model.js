/**
 * `<k-library>`'s view model — `docs/library-v0.md` §1.4.
 *
 * DOM-free by contract: this module builds plain row objects out of core state and answers
 * questions about them (filter, sort, counts, accent). It never queries the document, never
 * renders and never mutates a character. `k-library.js` is the only file that touches DOM.
 * That split is what lets `tests/library-view-model.test.js` measure the shapes directly.
 *
 * Three rules the recon pinned, each observable here:
 *
 * - **The `toShallow()` field floor and nothing below it.** Every character read
 *   (`src/endpoints/characters.js:369-394`) is `name`, `avatar`, `fav`, `date_last_chat`,
 *   `chat_size`, `data.creator`, `data.creator_notes`, `data.character_version`,
 *   `data.extensions.fav`. If `lazyLoadCharacters` ever flips on, the gallery keeps working
 *   because it never asked for a field the shallow record does not carry.
 * - **We do NOT drive `entitiesFilter`.** Its callback reprints the stock list and its chip
 *   selectors are `#rm_characters_block`-scoped, so borrowing it would make the library's
 *   search box silently rewrite the classic surface. `getEntitiesList({ doFilter: false })`
 *   asks for the unfiltered truth and the filtering below is our own.
 * - **No fabricated numbers.** A character record carries `chat_size` in BYTES, not a chat
 *   COUNT (`calculateChatSize`, `src/endpoints/characters.js:342-357`), so character cards
 *   print recency alone. Groups carry a real `chats[]` and print its length. See §"Card
 *   footer" in the sheet header of `public/css/library.css`.
 *
 * One import note: `sortEntitiesList()` is core's exported comparator and it is reused rather
 * than reimplemented (doc §1.2 item 4). It reads one jQuery selector of its own —
 * `#character_sort_order option[data-field="search"]` (`power-user.js:2435`) — so while the
 * user has the STOCK search bar populated, core's temporary "search" sort is selected there
 * and the comparator switches to fuzzy scores our rows were never scored under, leaving the
 * order as-built. That is a real edge, it costs an unsorted gallery and nothing else, and the
 * alternative (a second comparator) is the drift this project refuses.
 */

import { getEntitiesList, getThumbnailUrl } from '../../script.js';
import { power_user, sortEntitiesList } from '../../scripts/power-user.js';
import { getTagKeyForEntity, getTagsList } from '../../scripts/tags.js';
import { timestampToMoment } from '../../scripts/utils.js';
import { getPermanentAssistantAvatar } from '../../scripts/welcome-screen.js';
import { accentHue, toInitials } from './card-identity.js';
import { epithetForCharacter } from './epithet.js';

/** Tag pills a card will print. Anything past this is in the studio, not on the poster. */
export const CARD_TAG_MAX = 3;

/**
 * @typedef {object} LibraryRow
 * @property {'character'|'group'} type Entity kind. Tag folders never reach here.
 * @property {string|number} id The id `selectCharacterById()` / `openGroupById()` expects —
 *   a character INDEX or a group id string.
 * @property {string} key Stable identity for keyed rendering: `character.<avatar>` / `group.<id>`.
 * @property {string} name Display name. User data; rendered as text only.
 * @property {string} initials Up to two uppercase characters, for a portrait-less tile.
 * @property {string} avatar Character avatar filename, `''` for a group.
 * @property {string} portrait Full-res `/characters/<avatar>` URL, `''` when there is none.
 * @property {string[]} members Group member thumbnail URLs (stacked). Empty for characters.
 * @property {number} memberCount Group members that resolve to a real character.
 * @property {number} chatCount Group chat files. `-1` for characters — see the header.
 * @property {number} lastChat `date_last_chat` in epoch ms, 0 when unknown.
 * @property {number} hue Deterministic accent hue, 0-359.
 * @property {boolean} fav Normalized favourite state.
 * @property {boolean} assistant Whether this is the welcome-page assistant.
 * @property {string} kicker Epithet line. `''` when the chain found nothing.
 * @property {string} body Two-line clamped copy. May be `''`.
 * @property {string} epithetSource Which link of the chain answered. Probe surface.
 * @property {string[]} tags Visible tag names, hidden-on-card tags already dropped.
 * @property {string} search Lowercased haystack: name + epithet + notes + tags.
 * @property {*} item The raw entity item — `sortEntitiesList()` reads its fields.
 */

// `toInitials()` and `accentHue()` live in the `card-identity.js` leaf so the marketplace's
// rows can share them; they are re-exported here, where library code has always found them.
export { accentHue, toInitials };

/**
 * Core's favourite flag, normalized.
 *
 * `fav` arrives as a boolean from the group list, as the string `"true"` from older character
 * cards (the form serializes it), and as `undefined` from a card that has never been
 * favourited. `item.fav || item.fav == 'true'` is the exact test core's own list uses; this is
 * that test with a boolean return.
 * @param {unknown} value Raw `fav` field.
 * @returns {boolean} Whether the entity is favourited.
 */
export function normalizeFav(value) {
    return Boolean(value) || value === 'true';
}

/**
 * Normalises a `date_last_chat` field to epoch milliseconds.
 *
 * Characters carry an mtime in ms (`calculateChatSize`); groups carry an ST "humanized"
 * timestamp string. Both go through core's own parser rather than `Date.parse`, which is what
 * `k-rail-left.js` does for the same two shapes.
 * @param {unknown} value Raw field value.
 * @returns {number} Epoch milliseconds, or 0 when there is nothing honest to show.
 */
export function toEpochMs(value) {
    if (value === undefined || value === null || value === '') {
        return 0;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
    }
    try {
        const moment = timestampToMoment(value);
        return moment && moment.isValid() ? moment.valueOf() : 0;
    } catch {
        return 0;
    }
}

/**
 * Visible tag names for an entity, honouring `is_hidden_on_character_card`.
 *
 * Goes through `getTagKeyForEntity()` + `getTagsList()` — core's own pair — so a group's id
 * key and a character's avatar key resolve the same way they do in the stock list.
 * @param {{ id: string|number, type: string, item: any }} entity A core entity.
 * @returns {string[]} Tag names, sorted by core's ordering, hidden ones dropped.
 */
function tagNamesFor(entity) {
    try {
        const key = getTagKeyForEntity(entity.type === 'character' ? entity.item?.avatar : entity.id);
        if (key === undefined) {
            return [];
        }
        return getTagsList(key)
            .filter(tag => tag && !tag.is_hidden_on_character_card)
            .map(tag => String(tag.name ?? '').trim())
            .filter(Boolean);
    } catch (error) {
        console.warn('[k-library] tag read failed', error);
        return [];
    }
}

/**
 * Builds one card row from a character entity.
 * @param {{ id: string|number, item: any }} entity Core entity with a character item.
 * @param {string} assistantAvatar The welcome-page assistant's avatar filename.
 * @returns {LibraryRow} The row.
 */
function characterRow(entity, assistantAvatar) {
    const item = entity.item ?? {};
    const avatar = typeof item.avatar === 'string' ? item.avatar : '';
    const name = String(item.name ?? '').trim() || 'Unnamed';
    const epithet = epithetForCharacter(item, power_user?.aux_field);
    const tags = tagNamesFor({ id: entity.id, type: 'character', item });
    const notes = String(item?.data?.creator_notes ?? item?.creatorcomment ?? '');

    return {
        type: 'character',
        id: entity.id,
        key: `character.${avatar || name}`,
        name,
        initials: toInitials(name),
        avatar,
        // Full-res, not `getThumbnailUrl()`: a 2/3 poster at ~240px wide is well past what
        // core's 96px avatar thumbnail can carry (doc §1.3). `loading="lazy"` is what keeps
        // that affordable, and it is set at the img.
        portrait: avatar && avatar !== 'none' ? `/characters/${encodeURIComponent(avatar)}` : '',
        members: [],
        memberCount: 0,
        chatCount: -1,
        lastChat: toEpochMs(item.date_last_chat),
        hue: accentHue(avatar || name),
        fav: normalizeFav(item.fav ?? item?.data?.extensions?.fav),
        assistant: Boolean(avatar) && avatar === assistantAvatar,
        kicker: epithet.kicker,
        body: epithet.body,
        epithetSource: epithet.source,
        tags,
        search: `${name} ${epithet.kicker} ${notes} ${tags.join(' ')}`.toLowerCase(),
        item,
    };
}

/**
 * Builds one card row from a group entity.
 *
 * Groups are entities and the landing has to reach them (doc §1.3 "Groups"), but they are a
 * simple variant: stacked member portraits instead of one poster, a member count, and the
 * stock open path. No group creation surface in v0.
 * @param {{ id: string|number, item: any }} entity Core entity with a group item.
 * @param {Map<string, any>} byAvatar Character lookup for resolving members.
 * @returns {LibraryRow} The row.
 */
function groupRow(entity, byAvatar) {
    const item = entity.item ?? {};
    const name = String(item.name ?? '').trim() || 'Unnamed group';
    const rawMembers = Array.isArray(item.members) ? item.members : [];
    const resolved = rawMembers.filter(member => byAvatar.has(member));
    const tags = tagNamesFor({ id: entity.id, type: 'group', item });

    return {
        type: 'group',
        id: entity.id,
        key: `group.${entity.id}`,
        name,
        initials: toInitials(name),
        avatar: '',
        portrait: '',
        // Thumbnails here, not full-res: the stack draws these at ~44px, which is exactly what
        // core's avatar thumbnail is sized for.
        members: resolved.slice(0, 4).map(member => getThumbnailUrl('avatar', member)),
        memberCount: resolved.length,
        chatCount: Array.isArray(item.chats) ? item.chats.length : 0,
        lastChat: toEpochMs(item.date_last_chat),
        hue: accentHue(String(entity.id)),
        fav: normalizeFav(item.fav),
        assistant: false,
        kicker: '',
        body: '',
        epithetSource: 'none',
        tags,
        search: `${name} ${tags.join(' ')}`.toLowerCase(),
        item,
    };
}

/**
 * Reads the whole cast off core state.
 *
 * `doFilter: false` because the library owns its own filtering; `doSort: false` because
 * {@link sortRows} applies the sort explicitly and a `random` sort order would otherwise
 * reshuffle on every rebuild, including the ones a keystroke causes.
 * @returns {LibraryRow[]} One row per character and group, in core's list order.
 */
export function buildRows() {
    /** @type {LibraryRow[]} */
    const rows = [];
    try {
        const entities = getEntitiesList({ doFilter: false, doSort: false });
        const assistantAvatar = getPermanentAssistantAvatar();
        /** @type {Map<string, any>} */
        const byAvatar = new Map();
        for (const entity of entities) {
            if (entity?.type === 'character' && typeof entity.item?.avatar === 'string') {
                byAvatar.set(entity.item.avatar, entity.item);
            }
        }
        for (const entity of entities) {
            // Tag folders are entities too; v0 has no folder tree (doc §4 non-goals).
            if (entity?.type === 'character') {
                rows.push(characterRow(entity, assistantAvatar));
            } else if (entity?.type === 'group') {
                rows.push(groupRow(entity, byAvatar));
            }
        }
    } catch (error) {
        console.error('[k-library] roster read failed', error);
        return [];
    }
    return rows;
}

/**
 * Applies the sort the user chose, through core's exported comparator.
 *
 * Sorts IN PLACE, like core's own call sites, and returns the same array for chaining. The
 * rows carry `item` / `type` / `id`, which is the entity shape `sortEntitiesList()` reads.
 * @param {LibraryRow[]} rows Rows to order.
 * @returns {LibraryRow[]} The same array, ordered.
 */
export function sortRows(rows) {
    try {
        sortEntitiesList(rows, false);
    } catch (error) {
        console.warn('[k-library] sort failed; leaving list order', error);
    }
    return rows;
}

/**
 * @typedef {object} LibraryQuery
 * @property {string} [search] Raw search box contents.
 * @property {'all'|'favorites'} [tab] Which tab is active.
 */

/**
 * Filters rows by the search box and the active tab.
 *
 * Substring, lowercased, over the pre-built haystack — not fuzzy. Fuzzy matching is
 * `entitiesFilter`'s, and reaching for it is what would reprint the stock list.
 * @param {LibraryRow[]} rows Every row.
 * @param {LibraryQuery} query Current tools-row state.
 * @returns {LibraryRow[]} A new array; `rows` is untouched.
 */
export function filterRows(rows, query) {
    const needle = String(query?.search ?? '').trim().toLowerCase();
    const favouritesOnly = query?.tab === 'favorites';
    return rows.filter((row) => {
        if (favouritesOnly && !row.fav) {
            return false;
        }
        return !needle || row.search.includes(needle);
    });
}

/**
 * Builds a complete {@link LibraryRow} out of whatever fields a caller has.
 *
 * **This is the slice-D seam**, paired with `renderCard()` in `k-library.js`. The card studio's
 * live preview is driven from `input` events on the real core form controls, so it has a name,
 * an avatar URL and a title but no entity, no tag map and no `date_last_chat`. Rather than
 * teach the renderer about half-rows — the shape that always rots — this fills the gaps with
 * honest defaults and hands back a row the gallery renderer would accept unchanged.
 *
 * `hue` is derived from `avatar` unless the caller pins one, so a studio preview lights up with
 * the same accent the finished card will wear.
 * @param {Partial<LibraryRow> & { name?: string }} fields Whatever is known so far.
 * @returns {LibraryRow} A complete row.
 */
export function previewRow(fields = {}) {
    const name = String(fields.name ?? '').trim() || 'Unnamed';
    const avatar = typeof fields.avatar === 'string' ? fields.avatar : '';
    return {
        type: fields.type === 'group' ? 'group' : 'character',
        id: fields.id ?? -1,
        key: fields.key ?? `preview.${avatar || name}`,
        name,
        initials: fields.initials ?? toInitials(name),
        avatar,
        portrait: fields.portrait ?? (avatar && avatar !== 'none' ? `/characters/${encodeURIComponent(avatar)}` : ''),
        members: fields.members ?? [],
        memberCount: fields.memberCount ?? 0,
        chatCount: fields.chatCount ?? -1,
        lastChat: fields.lastChat ?? 0,
        hue: fields.hue ?? accentHue(avatar || name),
        fav: normalizeFav(fields.fav),
        assistant: Boolean(fields.assistant),
        kicker: fields.kicker ?? '',
        body: fields.body ?? '',
        epithetSource: fields.epithetSource ?? 'none',
        tags: fields.tags ?? [],
        search: fields.search ?? name.toLowerCase(),
        item: fields.item ?? null,
    };
}

/**
 * Tab counts. Always over the UNFILTERED set — a tab label that changed as you typed would be
 * describing the search, not the library.
 * @param {LibraryRow[]} rows Every row.
 * @returns {{ all: number, favorites: number }} Counts for the two tabs.
 */
export function countRows(rows) {
    let favorites = 0;
    for (const row of rows) {
        if (row.fav) {
            favorites += 1;
        }
    }
    return { all: rows.length, favorites };
}
