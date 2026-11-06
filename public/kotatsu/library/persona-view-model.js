/**
 * The persona shelf's view model — `docs/persona-gallery-v0.md` §1.
 *
 * PURE by contract, stricter than the cast's `view-model.js`: this module imports no core
 * module at all. `<k-persona-shelf>` reads core state (`power_user.personas`,
 * `power_user.persona_descriptions`, `user_avatar`, `chat_metadata.persona`, the connection
 * test) into a plain {@link PersonaSnapshot} and hands it here, so
 * `tests/persona-view-model.test.js` can measure every shape without mocking a single file.
 *
 * Rows come out as complete {@link import('./view-model.js').LibraryRow}s with `type: 'persona'`,
 * so `renderCard()` draws them with the same poster as the cast — doc §0 "one gallery idiom".
 * The persona-only facts ride on extra fields (`current`, `isDefault`, `chatLocked`,
 * `charLocked`, `tied`, `thumb`).
 *
 * Copy the data, never keep a second copy: nothing here stores state between calls.
 */

import { accentHue, toInitials } from './card-identity.js';
import { buildEpithet } from './epithet.js';
import { VARIANTS_KEY, activeItems, countVariants, normalizeVariants } from './persona-variants.js';

/**
 * @typedef {object} PersonaDescriptor The slice of `power_user.persona_descriptions[id]` read.
 * @property {string} [description] The persona description (may hold `{{user}}`).
 * @property {string} [title] Core's optional display-only persona title.
 * @property {number} [position] `persona_description_positions` value.
 * @property {number} [depth] Injection depth, read when position is AT_DEPTH.
 * @property {number} [role] `extension_prompt_roles` value, read when position is AT_DEPTH.
 * @property {string} [lorebook] Linked persona lorebook name, `''` when none.
 * @property {Array<{ type: string, id: string }>} [connections] Character / group links.
 */

/**
 * @typedef {object} PersonaSnapshot Everything the shelf read off core, as plain data.
 * @property {Record<string, string>} personas `power_user.personas`: avatarId → name.
 * @property {Record<string, PersonaDescriptor>} descriptions `power_user.persona_descriptions`.
 * @property {string} current `user_avatar`.
 * @property {string} defaultId `power_user.default_persona` (`''`/null when none).
 * @property {string} chatPersona `chat_metadata.persona`, the chat lock (`''` when none).
 * @property {string[]} tiedIds Personas connected to the open character or group
 *   (`getConnectedPersonas()`); empty when nothing is open.
 * @property {(connection: { type: string, id: string }) => boolean} [isLockedHere] Core's
 *   `isPersonaConnectionLocked`: is this connection the open character / group.
 * @property {import('./persona-variants.js').VariantContext} [variantContext] What is open, for
 *   counting the variants that fold in here. Omitted: nothing counts as on here.
 * @property {(id: string) => number} [bustFor] A persona's portrait cache-buster (0 = none):
 *   core replaces images under the same filename (`persona-portraits.js`).
 */

/**
 * @typedef {import('./view-model.js').LibraryRow & {
 *   current: boolean,
 *   isDefault: boolean,
 *   chatLocked: boolean,
 *   charLocked: boolean,
 *   tied: boolean,
 *   thumb: string,
 *   title: string,
 *   description: string,
 *   rawDescription: string,
 *   position: number,
 *   depth: number,
 *   role: number,
 *   lorebook: string,
 *   connections: Array<{ type: string, id: string }>,
 *   variants: { items: number, groups: number, here: number },
 *   variantsHere: string[],
 * }} PersonaRow
 */

/**
 * `persona_description_positions` (`personas.js:88`), mirrored as numbers: core exports the
 * object, but importing it would cost this module its no-core-imports contract. The test pins
 * the values against core's source.
 */
export const PERSONA_POSITIONS = Object.freeze({
    IN_PROMPT: 0,
    AFTER_CHAR: 1,
    TOP_AN: 2,
    BOTTOM_AN: 3,
    AT_DEPTH: 4,
    NONE: 9,
});

/** Core's defaults for a descriptor that never set them (`personas.js:104-105`). */
export const PERSONA_DEFAULT_DEPTH = 2;
export const PERSONA_DEFAULT_ROLE = 0;

/** The two sorts core's own persona grid knows (`power_user.persona_sort_order`). */
export const PERSONA_SORTS = Object.freeze(['asc', 'desc']);

/**
 * The full-resolution portrait URL — `getUserAvatar()` (`personas.js:137`) is
 * `User Avatars/{id}`, served from the user's own `avatars` dir (`src/constants.js:24`).
 * Absolute and encoded, because the gallery can be reached from any route and an avatar id
 * is a filename that may hold anything a filename may.
 * @param {string} id Avatar id.
 * @returns {string} The URL, `''` for an empty id.
 */
export function personaPortraitUrl(id) {
    return id ? `/User%20Avatars/${encodeURIComponent(id)}` : '';
}

/**
 * Appends a cache-buster, when there is one.
 * @param {string} url An image URL.
 * @param {number} bust The buster; 0 for none.
 * @returns {string} The URL.
 */
export function withBust(url, bust) {
    if (!url || !bust) return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${bust}`;
}

/**
 * Resolves `{{user}}` to the persona's own name for display, case-insensitively, the way
 * core's macro does. Nothing else is substituted: `{{char}}` depends on the chat, and a card
 * at rest has none.
 * @param {string} text Raw description.
 * @param {string} name The persona's name.
 * @returns {string} Display text.
 */
export function resolveUserMacro(text, name) {
    return String(text ?? '').replace(/\{\{user\}\}/gi, name);
}

/**
 * Builds every persona row from a snapshot.
 *
 * Keys come from `power_user.personas` (core backfills it for every avatar file on disk at
 * boot, `addMissingPersonas()`), so a descriptor with no name entry is not a persona yet and
 * is not drawn — same as core's grid.
 * @param {PersonaSnapshot} snapshot Core state, already read.
 * @param {(id: string) => string} [thumbFor] Thumbnail URL builder (`getThumbnailUrl`), the
 *   portrait's first fallback.
 * @returns {PersonaRow[]} One row per persona, in key order.
 */
export function buildPersonaRows(snapshot, thumbFor = () => '') {
    const personas = snapshot?.personas && typeof snapshot.personas === 'object' ? snapshot.personas : {};
    const descriptions = snapshot?.descriptions && typeof snapshot.descriptions === 'object' ? snapshot.descriptions : {};
    const tied = new Set(Array.isArray(snapshot?.tiedIds) ? snapshot.tiedIds : []);
    const isLockedHere = typeof snapshot?.isLockedHere === 'function' ? snapshot.isLockedHere : () => false;
    const bustOf = typeof snapshot?.bustFor === 'function' ? snapshot.bustFor : () => 0;

    /** @type {PersonaRow[]} */
    const rows = [];
    for (const id of Object.keys(personas)) {
        if (!id) continue;
        const rawName = personas[id];
        const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : id;
        const descriptor = descriptions[id] && typeof descriptions[id] === 'object' ? descriptions[id] : {};
        const description = resolveUserMacro(descriptor.description ?? '', name);
        const title = typeof descriptor.title === 'string' ? descriptor.title : '';
        // The cast's chain, persona-fed: core's display title first, then the first sentence of
        // the description, and the rest of the description as the two-line body.
        const epithet = buildEpithet({ title, notes: description });
        const connections = Array.isArray(descriptor.connections) ? descriptor.connections : [];
        const rawDescription = typeof descriptor.description === 'string' ? descriptor.description : '';
        const variantList = normalizeVariants(/** @type {Record<string, unknown>} */ (descriptor)[VARIANTS_KEY]);
        const context = snapshot?.variantContext;

        rows.push({
            type: 'persona',
            id,
            key: `persona.${id}`,
            name,
            // Core's placeholder is "[Unnamed Persona]": punctuation is not a face.
            initials: toInitials(name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim() || name),
            avatar: id,
            portrait: withBust(personaPortraitUrl(id), bustOf(id)),
            members: [],
            memberCount: 0,
            chatCount: -1,
            lastChat: 0,
            hue: accentHue(id),
            fav: false,
            assistant: false,
            kicker: epithet.kicker,
            body: epithet.body,
            epithetSource: epithet.source,
            tags: [],
            search: `${name} ${title} ${description}`.toLowerCase(),
            item: null,
            current: id === snapshot?.current,
            isDefault: Boolean(snapshot?.defaultId) && id === snapshot.defaultId,
            chatLocked: Boolean(snapshot?.chatPersona) && id === snapshot.chatPersona,
            charLocked: connections.some(connection => connection && isLockedHere(connection)),
            tied: tied.has(id),
            thumb: thumbFor(id) || '',
            // The detail sheet's fields (doc §1.1): the description as the sheet shows it, the
            // raw one for core's tokenizer (core counts the raw text, `personas.js:614-617`),
            // and where it goes.
            title,
            description,
            rawDescription,
            position: Number.isFinite(descriptor.position) ? Number(descriptor.position) : PERSONA_POSITIONS.IN_PROMPT,
            depth: Number.isFinite(descriptor.depth) ? Number(descriptor.depth) : PERSONA_DEFAULT_DEPTH,
            role: Number.isFinite(descriptor.role) ? Number(descriptor.role) : PERSONA_DEFAULT_ROLE,
            lorebook: typeof descriptor.lorebook === 'string' ? descriptor.lorebook : '',
            connections: connections.filter(connection => connection && typeof connection.id === 'string'),
            variants: countVariants(variantList, context),
            variantsHere: context ? activeItems(variantList, context).map(variant => variant.title || 'Untitled') : [],
        });
    }
    return rows;
}

/**
 * Orders rows by name, the way core's persona grid does (`sortPersonas`, `personas.js:186`):
 * `localeCompare` on the display name, `asc` or `desc`. A new array; `rows` is untouched.
 * @param {PersonaRow[]} rows Rows to order.
 * @param {string} [order] `power_user.persona_sort_order`; anything unknown reads as `asc`.
 * @returns {PersonaRow[]} The ordered copy.
 */
export function sortPersonaRows(rows, order = 'asc') {
    const direction = order === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => direction * a.name.localeCompare(b.name));
}

/**
 * Substring filter over name + title + description, lowercased. Our own: driving core's
 * `personasFilter` would re-render the stock grid (doc §1.1).
 * @param {PersonaRow[]} rows Every row.
 * @param {string} [search] Raw search box contents.
 * @returns {PersonaRow[]} A new array.
 */
export function filterPersonaRows(rows, search = '') {
    const needle = String(search ?? '').trim().toLowerCase();
    return needle ? rows.filter(row => row.search.includes(needle)) : [...rows];
}

/**
 * The "Tied to {char}" strip: personas connected to whatever is open, in the given order.
 * @param {PersonaRow[]} rows Rows, already sorted and filtered.
 * @returns {PersonaRow[]} The tied subset.
 */
export function tiedPersonaRows(rows) {
    return rows.filter(row => row.tied);
}

/**
 * Where the description goes, in words (doc §3). AFTER_CHAR is deprecated and core treats it
 * as IN_PROMPT, so it reads the same. An unknown position says so instead of guessing.
 * @param {number} position `persona_description_positions` value.
 * @param {number} [depth] Depth, for AT_DEPTH.
 * @param {number} [role] `extension_prompt_roles` value, for AT_DEPTH.
 * @returns {string} One sentence.
 */
export function placementWords(position, depth = PERSONA_DEFAULT_DEPTH, role = PERSONA_DEFAULT_ROLE) {
    switch (position) {
        case PERSONA_POSITIONS.IN_PROMPT:
        case PERSONA_POSITIONS.AFTER_CHAR:
            return 'In the story setup, beside the character\'s card.';
        case PERSONA_POSITIONS.TOP_AN:
            return 'At the top of the author\'s note.';
        case PERSONA_POSITIONS.BOTTOM_AN:
            return 'At the bottom of the author\'s note.';
        case PERSONA_POSITIONS.AT_DEPTH: {
            const n = Number.isFinite(depth) && depth >= 0 ? Math.floor(depth) : PERSONA_DEFAULT_DEPTH;
            const speaker = role === 1 ? 'as if you said it' : role === 2 ? 'as if the character said it' : 'as a system note';
            const where = n === 0 ? 'After the last message' : `${n} ${n === 1 ? 'message' : 'messages'} up from the end`;
            return `${where}, ${speaker}.`;
        }
        case PERSONA_POSITIONS.NONE:
            return 'Nowhere: this description is switched off.';
        default:
            return 'Somewhere Kotatsu doesn\'t know how to describe yet.';
    }
}

/**
 * The persona's connections as names, in their stored order. A connection whose character or
 * scene is gone keeps its id (core keeps the connection too) and says so.
 * @param {Array<{ type: string, id: string }>} connections Descriptor connections.
 * @param {(connection: { type: string, id: string }) => string} nameOf Resolver: `''` = gone.
 * @returns {string[]} Labels.
 */
export function connectionLabels(connections, nameOf) {
    return (Array.isArray(connections) ? connections : []).map((connection) => {
        const name = String(nameOf(connection) ?? '').trim();
        const kind = connection.type === 'group' ? 'scene' : 'character';
        return name ? (kind === 'scene' ? `${name} (scene)` : name) : `${connection.id} (${kind} not found)`;
    });
}

/**
 * Prev/next inside an ordered list of ids, wrapping. `null` when the id isn't in the list or
 * the list has one entry (no arrows to draw).
 * @param {string[]} order Ids in on-screen order.
 * @param {string} id The open one.
 * @returns {{ prev: string, next: string, index: number, total: number }|null} Neighbours.
 */
export function neighbours(order, id) {
    const index = order.indexOf(id);
    if (index < 0 || order.length < 2) return null;
    return {
        prev: order[(index - 1 + order.length) % order.length],
        next: order[(index + 1) % order.length],
        index,
        total: order.length,
    };
}
