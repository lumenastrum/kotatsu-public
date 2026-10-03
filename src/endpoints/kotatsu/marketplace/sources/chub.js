import { MarketError } from '../errors.js';

/**
 * The Chub adapter. Everything here was measured against the live API on 2026-10-02
 * (docs/character-marketplace-v0.md §1): `/search` is in Chub's published spec with no
 * documented parameters, and the detail endpoint is the one core's importer has always used
 * (`content-manager.js` `downloadChubCharacter`). Neither is promised to us, so every field
 * this file needs is checked, and what is missing fails as a named error instead of rendering
 * as an empty grid.
 *
 * There is no downloader. `importUrl()` returns the card's page URL and core's importer does
 * the rest.
 */

const API_BASE = 'https://api.chub.ai';
const SITE_BASE = 'https://chub.ai';
const IMAGE_HOSTS = Object.freeze(['avatars.charhub.io']);
const PAGE_SIZE = 48;

/**
 * Chub's `count` tops out here. Measured 2026-10-02 from a region it does not gate: every
 * NSFW-inclusive search answered exactly 100,000, whatever the sort. A count at the ceiling is
 * reported as one, so the client does not print it as a number.
 */
export const COUNT_CEILING = 100_000;

/**
 * The tag Chub puts on every adult card. `nsfwServed()` asks for one card carrying it: zero
 * means this site is not serving NSFW to wherever the request came from.
 */
const NSFW_TAG = 'NSFW';

/** A path segment we are willing to put into an upstream URL. */
const SEGMENT = /^[^/\\?#\s\p{Cc}]+$/u;

/**
 * @typedef {import('../query.js').MarketQuery} MarketQuery
 * @typedef {{ fetchJson: import('../http.js').FetchJson, key?: string|null }} MarketContext
 */

/**
 * @typedef {object} CardSummary
 * @property {string} source Source id.
 * @property {string} id What `detail()` and the import take (Chub: `fullPath`). NOT unique:
 * measured 2026-10-02, two distinct Chub cards report the same path.
 * @property {string} uid Unique within the source (Chub: the numeric project id). Use this for
 * render keys and for matching a card that is already installed.
 * @property {string} name
 * @property {string} creator
 * @property {string} tagline One line. May be ''.
 * @property {string} blurb The creator's note. Untrusted text.
 * @property {string[]} tags
 * @property {number|null} tokens Total definition tokens as the site counts them.
 * @property {string} avatarUrl '' when missing or off-host.
 * @property {string} artUrl The full-size card image, '' when missing or off-host.
 * @property {string} pageUrl The card's page on the site.
 * @property {boolean} nsfwImage
 * @property {number} updatedAt Epoch ms, 0 when unknown.
 * @property {number} createdAt Epoch ms, 0 when unknown.
 * @property {Record<string, number>} stats Whatever the site counts, by the site's own name.
 */

/**
 * @typedef {object} CardDetailExtra
 * @property {string} firstMessage
 * @property {string[]} alternateGreetings
 * @property {string} description The card's description field (Chub: `personality`).
 * @property {string} scenario
 * @property {boolean} hasExamples
 * @property {boolean} hasSystemPrompt
 * @property {boolean} hasPostHistory
 * @property {number} lorebookEntries Embedded entries; 0 when none.
 * @property {Record<string, number>} tokenCounts Per field, when the site provides them.
 */

/** @typedef {CardSummary & CardDetailExtra} CardDetail */

/**
 * Splits an id into its two path segments, or refuses it. The id comes from the client and
 * goes into an upstream URL, so this is the gate that keeps `detail()` on the card endpoint.
 * @param {unknown} id A candidate `creator/slug`.
 * @returns {[string, string]|null} The segments, or null when the id is not a card path.
 */
export function splitCardId(id) {
    if (typeof id !== 'string' || id.length > 256) return null;
    const parts = id.split('/');
    if (parts.length !== 2) return null;
    const [creator, slug] = parts;
    if (!SEGMENT.test(creator) || !SEGMENT.test(slug)) return null;
    if (creator === '.' || creator === '..' || slug === '.' || slug === '..') return null;
    return [creator, slug];
}

/**
 * @param {unknown} value Anything.
 * @returns {string} The value when it is a string, else ''.
 */
const text = (value) => typeof value === 'string' ? value : '';

/**
 * @param {unknown} value An ISO date string.
 * @returns {number} Epoch ms, 0 when unreadable.
 */
function toEpoch(value) {
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) ? time : 0;
}

/**
 * @param {unknown} value A URL the site gave us.
 * @returns {string} The URL when it is https on one of the adapter's image hosts, else ''.
 */
function imageUrl(value) {
    if (typeof value !== 'string') return '';
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.host) ? url.href : '';
    } catch {
        return '';
    }
}

/**
 * Chub carries per-field token counts as a JSON string inside a label.
 * @param {any} node A search row or a detail node.
 * @returns {Record<string, number>} The counts; empty when absent or unreadable.
 */
function tokenCounts(node) {
    const label = Array.isArray(node?.labels) ? node.labels.find((/** @type {any} */ item) => item?.title === 'TOKEN_COUNTS') : null;
    if (typeof label?.description !== 'string') return {};
    try {
        const parsed = JSON.parse(label.description);
        /** @type {Record<string, number>} */
        const counts = {};
        for (const [key, value] of Object.entries(parsed ?? {})) {
            if (typeof value === 'number' && Number.isFinite(value)) counts[key] = value;
        }
        return counts;
    } catch {
        return {};
    }
}

/**
 * Maps one Chub node to the normalized summary. Unknown fields are dropped here, at the
 * boundary, so the client cannot come to depend on them.
 * @param {any} node A search row or a detail node.
 * @returns {CardSummary|null} The summary, or null when the node lacks what a card needs.
 */
export function toSummary(node) {
    const parts = splitCardId(node?.fullPath);
    if (!parts || typeof node.name !== 'string' || node.name.trim() === '') return null;

    /** @type {Record<string, number>} */
    const stats = {};
    for (const key of ['starCount', 'n_favorites', 'rating', 'ratingCount', 'nChats', 'nMessages']) {
        if (typeof node[key] === 'number' && Number.isFinite(node[key])) stats[key] = node[key];
    }

    return {
        source: 'chub',
        id: node.fullPath,
        uid: typeof node.id === 'number' && Number.isFinite(node.id) ? String(node.id) : node.fullPath,
        name: node.name,
        creator: parts[0],
        tagline: text(node.tagline),
        blurb: text(node.description),
        tags: Array.isArray(node.topics) ? node.topics.filter((/** @type {unknown} */ tag) => typeof tag === 'string') : [],
        tokens: typeof node.nTokens === 'number' && Number.isFinite(node.nTokens) ? node.nTokens : null,
        avatarUrl: imageUrl(node.avatar_url),
        // The full card image (Chub's avatars are 200×200; `max_res_url` is the real art).
        artUrl: imageUrl(node.max_res_url),
        pageUrl: `${SITE_BASE}/characters/${node.fullPath}`,
        nsfwImage: node.nsfw_image === true,
        updatedAt: toEpoch(node.lastActivityAt),
        createdAt: toEpoch(node.createdAt),
        stats,
    };
}

/**
 * @param {any} book `definition.embedded_lorebook`.
 * @returns {number} How many entries it has. Chub has served both an array and a keyed object.
 */
function lorebookEntryCount(book) {
    const entries = book?.entries;
    if (Array.isArray(entries)) return entries.length;
    if (entries && typeof entries === 'object') return Object.keys(entries).length;
    return 0;
}

/**
 * @param {any} node A detail node with its `definition`.
 * @returns {CardDetail|null} The detail, or null when the node is not a readable card.
 */
export function toDetail(node) {
    const summary = toSummary(node);
    const definition = node?.definition;
    if (!summary || !definition || typeof definition !== 'object') return null;

    return {
        ...summary,
        firstMessage: text(definition.first_message),
        alternateGreetings: Array.isArray(definition.alternate_greetings)
            ? definition.alternate_greetings.filter((/** @type {unknown} */ greeting) => typeof greeting === 'string')
            : [],
        // Chub's `personality` is the card's description; its `description` is the creator's note.
        description: text(definition.personality),
        scenario: text(definition.scenario),
        hasExamples: text(definition.example_dialogs).trim() !== '',
        hasSystemPrompt: text(definition.system_prompt).trim() !== '',
        hasPostHistory: text(definition.post_history_instructions).trim() !== '',
        lorebookEntries: lorebookEntryCount(definition.embedded_lorebook),
        tokenCounts: tokenCounts(node),
    };
}

/**
 * @param {MarketQuery} query A normalized query.
 * @returns {{ params: URLSearchParams, page: number }} The upstream query string and the page it asks for.
 */
export function buildSearchParams(query) {
    const page = Math.max(1, Number.parseInt(query.next ?? '1', 10) || 1);
    const { filters } = query;
    const params = new URLSearchParams({
        search: query.q,
        first: String(PAGE_SIZE),
        page: String(page),
        sort: query.sort,
        namespace: 'characters',
        // Measured 2026-10-02: Chub honours `nsfw=true` for an anonymous request, EXCEPT from
        // regions where it requires age verification, where both flags are ignored and the
        // NSFW cards 404 even by direct path. Neither an account nor a key changes that, and
        // Kotatsu does not route around it; `nsfwServed()` is how the view learns which case it
        // is in. NSFL is a separate, harsher flag and stays off (doc §13, "the gate is region").
        nsfw: String(filters.nsfw === true),
        nsfl: 'false',
    });
    if (filters.tags?.length) params.set('tags', filters.tags.join(','));
    if (filters.excludeTags?.length) params.set('exclude_tags', filters.excludeTags.join(','));
    if (filters.minTokens) params.set('min_tokens', String(filters.minTokens));
    if (filters.maxTokens) params.set('max_tokens', String(filters.maxTokens));
    if (filters.hasAlternateGreetings) params.set('require_alternate_greetings', 'true');
    if (filters.hasLorebook) params.set('require_lore_embedded', 'true');
    if (filters.hasExamples) params.set('require_example_dialogues', 'true');
    if (filters.maxDaysOld) params.set('max_days_ago', String(filters.maxDaysOld));
    if (filters.creator) params.set('username', filters.creator);
    return { params, page };
}

/**
 * @typedef {object} MarketPage
 * @property {CardSummary[]} items
 * @property {number} total
 * @property {boolean} ceiling `total` is the site's cap, not a count ({@link COUNT_CEILING}).
 * @property {string|null} next
 * @property {number} dropped Rows that failed the shape check.
 */

/** @type {import('./index.js').MarketSource} */
export const chub = {
    id: 'chub',
    label: 'Chub',
    home: SITE_BASE,
    terms: `${SITE_BASE}/tos`,
    adult: true,
    imageHosts: IMAGE_HOSTS,
    // Ids are values of the `SortEnum` in Chub's published spec.
    sorts: Object.freeze([
        { id: 'trending_downloads', label: 'Trending' },
        { id: 'download_count', label: 'Most downloaded' },
        { id: 'rating', label: 'Top rated' },
        { id: 'n_favorites', label: 'Most favorited' },
        { id: 'last_activity_at', label: 'Recently active' },
        { id: 'created_at', label: 'Newest' },
        { id: 'n_tokens', label: 'Largest' },
    ]),
    filters: Object.freeze(['tags', 'excludeTags', 'minTokens', 'maxTokens', 'hasAlternateGreetings',
        'hasLorebook', 'hasExamples', 'maxDaysOld', 'creator', 'nsfw']),
    secretId: null,

    /**
     * @param {MarketQuery} query A normalized query.
     * @param {MarketContext} ctx The fetch to use.
     * @returns {Promise<MarketPage>} One page of summaries.
     */
    async search(query, ctx) {
        const { params, page } = buildSearchParams(query);
        const body = await ctx.fetchJson(`${API_BASE}/search?${params}`, { source: 'chub' });

        const data = body?.data ?? body;
        if (!data || !Array.isArray(data.nodes)) {
            throw new MarketError('shape', 'chub', { detail: 'search: no nodes array' });
        }

        const items = [];
        for (const node of data.nodes) {
            const summary = toSummary(node);
            if (summary) items.push(summary);
        }
        const dropped = data.nodes.length - items.length;
        if (data.nodes.length > 0 && items.length === 0) {
            throw new MarketError('shape', 'chub', { detail: `search: all ${dropped} rows failed the shape check` });
        }

        const count = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : items.length;
        const ceiling = count >= COUNT_CEILING;
        const total = ceiling ? COUNT_CEILING : count;
        const next = data.nodes.length > 0 && page * PAGE_SIZE < total ? String(page + 1) : null;
        return { items, total, ceiling, next, dropped };
    },

    /**
     * Whether this site serves NSFW cards to wherever the request comes from. One cheap
     * question: a single card carrying the NSFW tag, with the flag on. Measured 2026-10-02:
     * 981 from Arizona, 0 from Utah, for the same request (doc §13, "the gate is region").
     * Asked only when the reader has switched NSFW on, so the view can say why the grid did
     * not change instead of letting them guess.
     * @param {MarketContext} ctx The fetch to use.
     * @returns {Promise<boolean>} True when at least one NSFW card is served.
     */
    async nsfwServed(ctx) {
        const params = new URLSearchParams({
            search: '',
            first: '1',
            page: '1',
            sort: this.sorts[0].id,
            namespace: 'characters',
            nsfw: 'true',
            nsfl: 'false',
            tags: NSFW_TAG,
        });
        const body = await ctx.fetchJson(`${API_BASE}/search?${params}`, { source: 'chub' });
        const data = body?.data ?? body;
        if (!data || !Array.isArray(data.nodes)) {
            throw new MarketError('shape', 'chub', { detail: 'nsfwServed: no nodes array' });
        }
        const count = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : data.nodes.length;
        return count > 0;
    },

    /**
     * @param {string} id `creator/slug`, already checked by the router with `splitCardId`.
     * @param {MarketContext} ctx The fetch to use.
     * @returns {Promise<CardDetail>} The card, readable before import.
     */
    async detail(id, ctx) {
        const parts = splitCardId(id);
        if (!parts) throw new MarketError('upstream', 'chub', { status: 404, detail: 'not a card id' });
        const [creator, slug] = parts;
        const url = `${API_BASE}/api/characters/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}?full=true`;
        const body = await ctx.fetchJson(url, { source: 'chub' });

        const detail = toDetail(body?.node);
        if (!detail) throw new MarketError('shape', 'chub', { detail: 'detail: node or definition missing' });
        return detail;
    },

    /**
     * @param {string} id `creator/slug`.
     * @returns {string} The card's page URL, which `importFromExternalUrl()` already accepts.
     */
    importUrl(id) {
        return `${SITE_BASE}/characters/${id}`;
    },

    isValidId: (id) => splitCardId(id) !== null,
};
