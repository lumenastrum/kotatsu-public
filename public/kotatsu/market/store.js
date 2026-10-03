/**
 * `MarketStore` — how Browse Characters asks the server (`docs/character-marketplace-v0.md` §4).
 *
 * The component codes against this object and never against `fetch`. It talks only to
 * `/api/kotatsu/marketplace/*` on our own server; no request from the page ever goes to a card
 * site for data.
 *
 * Core-free on purpose: `fetch` and the request headers are handed in, so the store loads in a
 * test with no mocks. The component passes core's `getRequestHeaders`.
 *
 * Three things it settles so no caller has to:
 *
 * - **One answer shape.** Every call resolves (it never rejects) to `ok`, `error` or `stale`.
 * - **Our own failures are named too.** The server reports a card site's trouble as one of
 *   five kinds. Two more can only be seen from here: `disabled` (the marketplace is switched
 *   off, the routes answer 404) and `local` (our server did not answer, or answered 5xx).
 * - **A slow answer cannot overwrite a newer one.** A search result for a query that is no
 *   longer the latest resolves as `stale`, and the caller drops it. Loading the next page of
 *   the same query is the same query, so it is never stale against itself.
 */

/**
 * @typedef {import('./view-model.js').CardSummary} CardSummary
 * @typedef {import('./view-model.js').CardDetail} CardDetail
 * @typedef {import('./view-model.js').MarketErrorBody} MarketErrorBody
 */

/**
 * @typedef {object} MarketSourceInfo
 * @property {string} id
 * @property {string} label
 * @property {string} home
 * @property {string} terms
 * @property {boolean} adult
 * @property {{ id: string, label: string }[]} sorts
 * @property {string[]} filters
 * @property {boolean} connected
 */

/**
 * @typedef {object} MarketPage
 * @property {CardSummary[]} items
 * @property {number} total
 * @property {boolean} ceiling `total` is the site's cap, not a count.
 * @property {string|null} next
 * @property {number} dropped
 * @property {boolean|null} nsfwServed Only for a search that asked for NSFW: whether the site
 * serves any to this location. `null` when not asked, or when the side question failed.
 */

/**
 * @typedef {object} SearchRequest
 * @property {string} source
 * @property {string} [q]
 * @property {string} [sort]
 * @property {Record<string, unknown>} [filters]
 * @property {string|null} [next]
 */

/**
 * @template T
 * @typedef {{ status: 'ok', data: T } | { status: 'error', error: MarketErrorBody } | { status: 'stale' }} MarketAnswer
 */

const BASE = '/api/kotatsu/marketplace';

/**
 * The identity of a search, without its paging token: two requests with the same key are the
 * same list at different depths.
 * @param {SearchRequest} request A search.
 * @returns {string} The key.
 */
export function queryKey(request) {
    const filters = request.filters ?? {};
    const ordered = Object.keys(filters).sort().map(key => [key, filters[key]]);
    return JSON.stringify([request.source, request.q ?? '', request.sort ?? '', ordered]);
}

/**
 * @param {{ fetchImpl?: typeof fetch, getHeaders?: () => Record<string, string> }} [deps] `fetch` and the request headers (core's `getRequestHeaders`).
 * @returns {{ sources: () => Promise<MarketAnswer<{ enabled: boolean, sources: MarketSourceInfo[] }>>, search: (request: SearchRequest) => Promise<MarketAnswer<MarketPage>>, detail: (source: string, id: string) => Promise<MarketAnswer<CardDetail>>, reset: () => void }} The store.
 */
export function createMarketStore({ fetchImpl = globalThis.fetch.bind(globalThis), getHeaders = () => ({ 'Content-Type': 'application/json' }) } = {}) {
    /** @type {Map<string, Promise<MarketAnswer<any>>>} Identical requests in flight share one call. */
    const inFlight = new Map();
    /** @type {Promise<MarketAnswer<{ enabled: boolean, sources: MarketSourceInfo[] }>>|null} */
    let sourcesAnswer = null;
    let latestQuery = '';

    /**
     * @param {string} route Route under the marketplace base.
     * @param {object} body Request body.
     * @param {string} [source] Source id, for the error.
     * @returns {Promise<MarketAnswer<any>>} `ok` or `error`. Never rejects.
     */
    async function post(route, body, source) {
        const key = `${route} ${JSON.stringify(body)}`;
        const pending = inFlight.get(key);
        if (pending) return pending;

        const promise = (async () => {
            /** @type {Response} */
            let response;
            try {
                response = await fetchImpl(`${BASE}${route}`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
            } catch {
                return /** @type {MarketAnswer<any>} */ ({ status: 'error', error: { kind: 'local', source } });
            }
            if (response.status === 404) {
                return /** @type {MarketAnswer<any>} */ ({ status: 'error', error: { kind: 'disabled', source } });
            }
            if (!response.ok) {
                return /** @type {MarketAnswer<any>} */ ({ status: 'error', error: { kind: 'local', source, status: response.status } });
            }
            let data;
            try {
                data = await response.json();
            } catch {
                return /** @type {MarketAnswer<any>} */ ({ status: 'error', error: { kind: 'local', source, status: response.status } });
            }
            if (data && typeof data === 'object' && data.error && typeof data.error.kind === 'string') {
                return /** @type {MarketAnswer<any>} */ ({ status: 'error', error: data.error });
            }
            return /** @type {MarketAnswer<any>} */ ({ status: 'ok', data });
        })().finally(() => inFlight.delete(key));

        inFlight.set(key, promise);
        return promise;
    }

    return {
        /**
         * The enabled sources. Asked once; a failure is not remembered, so it is asked again.
         * @returns {Promise<MarketAnswer<{ enabled: boolean, sources: MarketSourceInfo[] }>>} The sources.
         */
        async sources() {
            if (!sourcesAnswer) {
                const asked = post('/sources', {});
                sourcesAnswer = asked;
                const answer = await asked;
                if (answer.status !== 'ok' && sourcesAnswer === asked) sourcesAnswer = null;
                return answer;
            }
            return sourcesAnswer;
        },

        /**
         * @param {SearchRequest} request The search. With `next`, the following page of the same query.
         * @returns {Promise<MarketAnswer<MarketPage>>} A page, an error, or `stale` when a newer query was asked meanwhile.
         */
        async search(request) {
            const key = queryKey(request);
            latestQuery = key;
            const answer = await post('/search', {
                source: request.source,
                q: request.q ?? '',
                sort: request.sort,
                filters: request.filters ?? {},
                next: request.next ?? null,
            }, request.source);
            return latestQuery === key ? answer : { status: 'stale' };
        },

        /**
         * @param {string} source Source id.
         * @param {string} id The card's id (not its uid).
         * @returns {Promise<MarketAnswer<CardDetail>>} The card, readable before import.
         */
        detail(source, id) {
            return post('/detail', { source, id }, source);
        },

        /** Forgets the remembered sources and the latest query (a source was connected, or the view closed). */
        reset() {
            sourcesAnswer = null;
            latestQuery = '';
        },
    };
}
