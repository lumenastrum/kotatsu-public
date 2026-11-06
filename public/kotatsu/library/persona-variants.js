/**
 * Persona variants — `docs/persona-gallery-v0.md` §7.
 *
 * A variant is a block of persona text that folds in after your description only where it
 * belongs: always, with certain characters or scenes, in certain chats, or when the character's
 * card matches a pattern. Every variant also has an on/off switch, which is what Persona
 * Library calls "Manual".
 *
 * GROUPS (one level deep): a group has a switch and a trigger of its own and gates its
 * children; each child is still evaluated on its own, so a child can be off inside an active
 * group. A group carries no text. Nested groups are flattened to items on read.
 *
 * FORMAT (per persona): the `joiner` between your description and each folded variant, and an
 * optional `wrapper` around the folded variants with a `{{PROMPT}}` placeholder (core has no
 * `{{PROMPT}}` macro, and the composer runs before core's macro pass anyway). Your description is
 * never wrapped: it stays exactly as you wrote it.
 *
 * PURE: no core import, no DOM. Core state arrives as a {@link VariantContext}; the composer
 * that core calls at prompt time (`registerPersonaDescriptionComposer`, power-user.js) is wired in
 * `persona-variants-runtime.js`. Nothing here ever writes a description: variants are COMPOSED
 * at read time, never swapped into stored state (doc §6, the reason we did not copy Persona
 * Library's mechanism).
 *
 * Storage: arrays and objects on core's own descriptor (`kotatsu_variants`,
 * `kotatsu_variant_format`), so core's persona Backup / Restore carries them. Always read through
 * {@link normalizeVariants} / {@link normalizeFormat}: the stored shape is whatever an older or
 * hand-edited file left there.
 */

/** Descriptor key for the list. */
export const VARIANTS_KEY = 'kotatsu_variants';

/** Descriptor key for the joiner + wrapper. */
export const FORMAT_KEY = 'kotatsu_variant_format';

/** The triggers, in the order the editor offers them. */
export const VARIANT_TRIGGERS = Object.freeze(['always', 'characters', 'chats', 'match']);

/** Longest pattern we will compile. A persona pattern is a phrase, not a program. */
export const PATTERN_MAX = 300;

/** The wrapper's placeholder. */
export const WRAPPER_PLACEHOLDER = '{{PROMPT}}';

/** @type {Readonly<VariantFormat>} */
export const DEFAULT_FORMAT = Object.freeze({ joiner: '\n\n', wrapper: '' });

/**
 * @typedef {'always'|'characters'|'chats'|'match'} VariantTrigger
 *
 * @typedef {object} PersonaVariant
 * @property {string} id Stable id, unique across the whole list (groups and children alike).
 * @property {'item'|'group'} kind An item folds text in; a group gates its children.
 * @property {string} title What the reader calls it ("At the office").
 * @property {string} text The block that folds in (items). Macros work: core resolves them later.
 * @property {boolean} enabled The switch. Off never folds, whatever the trigger says.
 * @property {VariantTrigger} when The trigger.
 * @property {string[]} characters Character avatar files and `group:<id>` keys, for `characters`.
 * @property {string[]} chats Chat ids (`getCurrentChatId()`), for `chats`.
 * @property {string} pattern Text or `/regex/flags`, for `match`.
 * @property {PersonaVariant[]} children A group's items, in order. Always `[]` on an item.
 * @property {boolean} collapsed A group folded shut in the editor. Saved, so it stays shut.
 *
 * @typedef {object} VariantFormat
 * @property {string} joiner Between your description and each folded variant.
 * @property {string} wrapper Around the folded variants; must contain `{{PROMPT}}` to apply.
 *
 * @typedef {object} VariantContext What is open, as plain data.
 * @property {string[]} characterKeys The open character's avatar, or the open scene's
 *   `group:<id>` key plus every member's avatar.
 * @property {string} chatId The open chat's id, `''` when none.
 * @property {string} cardText The open character's (or every member's) name + description, for `match`.
 */

/**
 * A fresh id. Not crypto: it only has to be unique within one persona's list.
 * @returns {string} An id.
 */
export function newVariantId() {
    return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * @param {unknown} value Anything.
 * @returns {string[]} The strings in it, trimmed, de-duplicated, empty ones dropped.
 */
function stringList(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

/**
 * @param {unknown} raw A stored entry.
 * @param {boolean} allowGroup Whether this level may hold groups (only the top one).
 * @param {Set<string>} seen Ids already used anywhere in the list.
 * @returns {PersonaVariant|null} The clean entry, or null for garbage.
 */
function normalizeOne(raw, allowGroup, seen) {
    if (!raw || typeof raw !== 'object') return null;
    const item = /** @type {Record<string, unknown>} */ (raw);
    let id = typeof item.id === 'string' && item.id ? item.id : newVariantId();
    while (seen.has(id)) id = newVariantId();
    seen.add(id);
    const when = VARIANT_TRIGGERS.includes(/** @type {any} */ (item.when)) ? /** @type {VariantTrigger} */ (item.when) : 'always';
    const group = allowGroup && item.kind === 'group';
    /** @type {PersonaVariant[]} */
    const children = [];
    if (group && Array.isArray(item.children)) {
        for (const child of item.children) {
            const clean = normalizeOne(child, false, seen);
            if (clean) children.push(clean);
        }
    }
    return {
        id,
        kind: group ? 'group' : 'item',
        title: typeof item.title === 'string' ? item.title : '',
        text: group ? '' : typeof item.text === 'string' ? item.text : '',
        enabled: item.enabled !== false,
        when,
        characters: stringList(item.characters),
        chats: stringList(item.chats),
        pattern: typeof item.pattern === 'string' ? item.pattern : '',
        children,
        collapsed: group && item.collapsed === true,
    };
}

/**
 * Reads a stored list into well-formed variants. Garbage entries are dropped, missing fields
 * defaulted, unknown triggers read as `always`, nested groups flattened to items, duplicate ids
 * re-minted. Never throws.
 * @param {unknown} raw Whatever the descriptor holds.
 * @returns {PersonaVariant[]} Clean variants, in stored order.
 */
export function normalizeVariants(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {PersonaVariant[]} */
    const out = [];
    for (const entry of raw) {
        const clean = normalizeOne(entry, true, seen);
        if (clean) out.push(clean);
    }
    return out;
}

/**
 * @param {unknown} raw Whatever the descriptor's format key holds.
 * @returns {VariantFormat} A clean format; defaults where the stored one is missing or wrong.
 */
export function normalizeFormat(raw) {
    const item = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    return {
        joiner: typeof item.joiner === 'string' ? item.joiner : DEFAULT_FORMAT.joiner,
        wrapper: typeof item.wrapper === 'string' ? item.wrapper : DEFAULT_FORMAT.wrapper,
    };
}

/**
 * @param {VariantFormat} format A normalized format.
 * @returns {boolean} Whether it is the default (so nothing needs storing).
 */
export function isDefaultFormat(format) {
    return format.joiner === DEFAULT_FORMAT.joiner && format.wrapper === DEFAULT_FORMAT.wrapper;
}

/**
 * A blank item for the editor's "Add".
 * @returns {PersonaVariant} The variant.
 */
export function blankVariant() {
    return { id: newVariantId(), kind: 'item', title: '', text: '', enabled: true, when: 'always', characters: [], chats: [], pattern: '', children: [], collapsed: false };
}

/**
 * A blank group for the editor's "Add a group".
 * @returns {PersonaVariant} The group.
 */
export function blankGroup() {
    return { ...blankVariant(), kind: 'group' };
}

/**
 * A deep copy with every id re-minted (Duplicate persona: the copy must not share ids).
 * @param {PersonaVariant[]} variants Normalized variants.
 * @returns {PersonaVariant[]} The copy.
 */
export function cloneWithFreshIds(variants) {
    return variants.map(variant => ({
        ...variant,
        id: newVariantId(),
        characters: [...variant.characters],
        chats: [...variant.chats],
        children: variant.children.map(child => ({ ...child, id: newVariantId(), characters: [...child.characters], chats: [...child.chats], children: [] })),
    }));
}

/**
 * Compiles a `match` pattern. `/body/flags` is a regex (an invalid one compiles to null, so it
 * matches nothing rather than everything); anything else is a case-insensitive phrase.
 * @param {string} pattern The pattern as typed.
 * @returns {RegExp|null} The matcher, or null when there is nothing to match.
 */
export function compilePattern(pattern) {
    const source = String(pattern ?? '').trim();
    if (!source || source.length > PATTERN_MAX) return null;
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(source);
    if (literal) {
        const flags = [...new Set(literal[2].replace(/[gy]/g, ''))].join('');
        try {
            return new RegExp(literal[1], flags);
        } catch {
            return null;
        }
    }
    return new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * Whether a variant's switch and trigger say yes here. Says nothing about text or children.
 * @param {PersonaVariant} variant A normalized variant or group.
 * @param {VariantContext} context What is open.
 * @returns {boolean} Whether the gate is open.
 */
export function triggerMatches(variant, context) {
    if (!variant.enabled) return false;
    switch (variant.when) {
        case 'always':
            return true;
        case 'characters': {
            const open = new Set(context?.characterKeys ?? []);
            return variant.characters.some(key => open.has(key));
        }
        case 'chats':
            return Boolean(context?.chatId) && variant.chats.includes(context.chatId);
        case 'match': {
            const matcher = compilePattern(variant.pattern);
            return matcher !== null && matcher.test(String(context?.cardText ?? ''));
        }
        default:
            return false;
    }
}

/**
 * Whether a variant contributes here. An item: its gate is open and it has text. A group: its
 * gate is open and at least one child contributes.
 * @param {PersonaVariant} variant A normalized variant or group.
 * @param {VariantContext} context What is open.
 * @returns {boolean} Whether it is on here.
 */
export function isVariantActive(variant, context) {
    if (!triggerMatches(variant, context)) return false;
    if (variant.kind === 'group') return variant.children.some(child => isVariantActive(child, context));
    return Boolean(variant.text.trim());
}

/**
 * Every item that folds in here, groups flattened, in list order.
 * @param {PersonaVariant[]} variants Normalized variants.
 * @param {VariantContext} context What is open.
 * @returns {PersonaVariant[]} The contributing items.
 */
export function activeItems(variants, context) {
    /** @type {PersonaVariant[]} */
    const out = [];
    for (const variant of variants) {
        if (variant.kind === 'group') {
            if (!triggerMatches(variant, context)) continue;
            for (const child of variant.children) {
                if (isVariantActive(child, context)) out.push(child);
            }
        } else if (isVariantActive(variant, context)) {
            out.push(variant);
        }
    }
    return out;
}

/**
 * The description core will read: yours, then the folded variants. With the default format that
 * is one blank line between each part. A wrapper with `{{PROMPT}}` wraps the folded variants
 * (never your description); a wrapper without it is ignored. An empty description with an
 * active variant is just the variant.
 * @param {string} base The stored description.
 * @param {PersonaVariant[]} variants Normalized variants.
 * @param {VariantContext} context What is open.
 * @param {VariantFormat} [format] Joiner and wrapper.
 * @returns {string} The composed description.
 */
export function composeDescription(base, variants, context, format = DEFAULT_FORMAT) {
    const joiner = format.joiner;
    const texts = activeItems(variants, context).map(variant => variant.text.trim());
    let block = texts.join(joiner);
    if (block && format.wrapper.includes(WRAPPER_PLACEHOLDER)) {
        block = format.wrapper.split(WRAPPER_PLACEHOLDER).join(block);
    }
    return [String(base ?? '').trim(), block].filter(Boolean).join(joiner);
}

/**
 * Shows a joiner so its whitespace is visible and typeable: newline as `\n`, tab as `\t`,
 * a backslash as `\\`.
 * @param {string} joiner The stored joiner.
 * @returns {string} What the editor shows.
 */
export function escapeJoiner(joiner) {
    return String(joiner ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/**
 * The reverse of {@link escapeJoiner}: what someone typed into the joiner field.
 * @param {string} typed The field's text.
 * @returns {string} The joiner to store.
 */
export function unescapeJoiner(typed) {
    return String(typed ?? '').replace(/\\(\\|n|t)/g, (_, code) => (code === 'n' ? '\n' : code === 't' ? '\t' : '\\'));
}

/**
 * Counts, for posters and the detail sheet.
 * @param {PersonaVariant[]} variants Normalized variants.
 * @param {VariantContext} [context] When given, also counts what folds in here.
 * @returns {{ items: number, groups: number, here: number }} Items (children included), groups, items on here.
 */
export function countVariants(variants, context) {
    let items = 0;
    let groups = 0;
    for (const variant of variants) {
        if (variant.kind === 'group') {
            groups += 1;
            items += variant.children.length;
        } else {
            items += 1;
        }
    }
    return { items, groups, here: context ? activeItems(variants, context).length : 0 };
}

/**
 * The editor's one-line summary of a trigger.
 * @param {PersonaVariant} variant A normalized variant.
 * @param {(key: string) => string} [nameOf] Resolves a character / scene key to a name.
 * @returns {string} e.g. "With Hana, Tea party", "In 2 chats", "When the card matches “dragon”".
 */
export function triggerSummary(variant, nameOf = key => key) {
    switch (variant.when) {
        case 'always':
            return 'Always';
        case 'characters':
            return variant.characters.length
                ? `With ${variant.characters.map(key => nameOf(key) || key).join(', ')}`
                : 'With… (pick someone)';
        case 'chats':
            return variant.chats.length === 1 ? 'In 1 chat' : `In ${variant.chats.length} chats`;
        case 'match':
            return variant.pattern.trim()
                ? `When the card matches ${compilePattern(variant.pattern) ? `“${variant.pattern.trim()}”` : 'an invalid pattern'}`
                : 'When the card matches… (add a pattern)';
        default:
            return '';
    }
}
