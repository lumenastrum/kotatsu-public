/**
 * Turns whatever a client posted into a query an adapter can trust. Pure; no I/O.
 * The interface is pinned in docs/character-marketplace-v0.md §5.
 */

/** Every filter the interface knows. A source honours a subset (`MarketSource.filters`). */
export const FILTER_KEYS = Object.freeze([
    'tags', 'excludeTags', 'minTokens', 'maxTokens', 'hasAlternateGreetings',
    'hasLorebook', 'hasExamples', 'maxDaysOld', 'creator', 'nsfw',
]);

const MAX_QUERY_LENGTH = 200;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;
const MAX_TOKEN_FILTER = 1_000_000;
const MAX_DAYS = 3650;

/**
 * @typedef {object} MarketFilters
 * @property {string[]} [tags]
 * @property {string[]} [excludeTags]
 * @property {number} [minTokens]
 * @property {number} [maxTokens]
 * @property {boolean} [hasAlternateGreetings]
 * @property {boolean} [hasLorebook]
 * @property {boolean} [hasExamples]
 * @property {number} [maxDaysOld]
 * @property {string} [creator]
 * @property {boolean} [nsfw]
 */

/**
 * @typedef {object} MarketQuery
 * @property {string} q
 * @property {string} sort One of the source's sort ids.
 * @property {MarketFilters} filters Only keys the source honours, only when set.
 * @property {string|null} next Opaque paging token from the previous page.
 */

/**
 * @param {unknown} value Anything.
 * @returns {string[]} Trimmed, non-empty, comma-free, de-duplicated tags.
 */
function cleanTags(value) {
    if (!Array.isArray(value)) return [];
    const tags = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const tag = item.trim().slice(0, MAX_TAG_LENGTH);
        // A comma would split into two tags upstream.
        if (!tag || tag.includes(',') || tags.includes(tag)) continue;
        tags.push(tag);
        if (tags.length >= MAX_TAGS) break;
    }
    return tags;
}

/**
 * @param {unknown} value Anything.
 * @param {number} max Upper bound.
 * @returns {number|undefined} A whole number in 1..max, or undefined.
 */
function cleanCount(value, max) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) return undefined;
    const whole = Math.floor(number);
    return whole >= 1 ? Math.min(whole, max) : undefined;
}

/**
 * @param {unknown} raw The posted `filters`.
 * @param {readonly string[]} honoured The source's filter list.
 * @returns {MarketFilters} Only what is set, valid and honoured. Key order is fixed, so the result is a stable cache key.
 */
export function normalizeFilters(raw, honoured) {
    const input = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    /** @type {MarketFilters} */
    const filters = {};
    const allows = (/** @type {string} */ key) => honoured.includes(key);

    if (allows('tags')) {
        const tags = cleanTags(input.tags);
        if (tags.length) filters.tags = tags;
    }
    if (allows('excludeTags')) {
        const tags = cleanTags(input.excludeTags);
        if (tags.length) filters.excludeTags = tags;
    }
    if (allows('minTokens')) {
        const count = cleanCount(input.minTokens, MAX_TOKEN_FILTER);
        if (count !== undefined) filters.minTokens = count;
    }
    if (allows('maxTokens')) {
        const count = cleanCount(input.maxTokens, MAX_TOKEN_FILTER);
        if (count !== undefined) filters.maxTokens = count;
    }
    for (const key of /** @type {const} */ (['hasAlternateGreetings', 'hasLorebook', 'hasExamples', 'nsfw'])) {
        if (allows(key) && input[key] === true) filters[key] = true;
    }
    if (allows('maxDaysOld')) {
        const count = cleanCount(input.maxDaysOld, MAX_DAYS);
        if (count !== undefined) filters.maxDaysOld = count;
    }
    if (allows('creator') && typeof input.creator === 'string') {
        const creator = input.creator.trim().slice(0, MAX_TAG_LENGTH);
        if (creator) filters.creator = creator;
    }
    return filters;
}

/**
 * @param {unknown} body The posted search body.
 * @param {{ sorts: { id: string }[], filters: readonly string[] }} source The source being searched.
 * @returns {MarketQuery} A query the adapter can use as is.
 */
export function normalizeQuery(body, source) {
    const input = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
    const q = typeof input.q === 'string' ? input.q.trim().slice(0, MAX_QUERY_LENGTH) : '';
    const sort = source.sorts.some(option => option.id === input.sort) ? String(input.sort) : source.sorts[0].id;
    const next = typeof input.next === 'string' && input.next.length > 0 && input.next.length <= 512 ? input.next : null;
    return { q, sort, filters: normalizeFilters(input.filters, source.filters), next };
}
