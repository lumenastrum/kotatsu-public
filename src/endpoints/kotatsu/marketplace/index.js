import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import express from 'express';
import fetch from 'node-fetch';

import { serverDirectory } from '../../../server-directory.js';
import { getConfigValue } from '../../../util.js';
import { createCache } from './cache.js';
import { MarketError } from './errors.js';
import { createFetchJson, createFixtureFetch } from './http.js';
import { normalizeQuery } from './query.js';
import { SOURCES } from './sources/index.js';

/**
 * `/api/kotatsu/marketplace/*`: search and read card sites on the user's behalf, so the
 * browser never talks to one for data and a key never reaches page code. Design and receipts:
 * docs/character-marketplace-v0.md.
 *
 * This is not a proxy. A client names a source and sends query fields; the adapter builds the
 * upstream URL against a fixed host. No client-supplied URL is ever fetched.
 *
 * A card site failing is an answer, not a failure of ours: it comes back as 200 with
 * `{ error: { kind, source, … } }`. 400 is a bad request, 404 is the marketplace switched off.
 */

const SEARCH_TTL_MS = 5 * 60 * 1000;
const DETAIL_TTL_MS = 15 * 60 * 1000;
// Whether a site serves NSFW here changes with the network, not the minute.
const NSFW_SERVED_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;

/**
 * @returns {string} The Kotatsu version, for the User-Agent. 'dev' when package.json is unreadable.
 */
function readVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'package.json'), 'utf8'));
        return typeof pkg?.kotatsu?.version === 'string' ? pkg.kotatsu.version : 'dev';
    } catch {
        return 'dev';
    }
}

/**
 * @param {import('./sources/index.js').MarketSource} source A source.
 * @returns {object} What a client may know about it. Never a key; only whether one is set.
 */
function describeSource(source) {
    return {
        id: source.id,
        label: source.label,
        home: source.home,
        terms: source.terms,
        adult: source.adult,
        sorts: source.sorts,
        filters: source.filters,
        connected: false,
    };
}

/**
 * @param {import('express').Request} request The request.
 * @returns {string} The user the answer is cached for.
 */
function userHandle(request) {
    return String(/** @type {any} */ (request).user?.profile?.handle ?? 'default-user');
}

/**
 * Builds the router. A factory so tests can hand it a fixtures directory and a config.
 *
 * @param {{ fixturesDirectory?: string, isEnabled?: () => boolean, userAgent?: string }} [options] Overrides. By default: fixtures from `KOTATSU_MARKET_FIXTURES`, the switch from `kotatsu.marketplace.enabled`, and `Kotatsu/<version>`.
 * @returns {import('express').Router} The router.
 */
export function createMarketplaceRouter({
    fixturesDirectory = process.env.KOTATSU_MARKET_FIXTURES,
    isEnabled = () => !!getConfigValue('kotatsu.marketplace.enabled', true, 'boolean'),
    userAgent = `Kotatsu/${readVersion()}`,
} = {}) {
    const router = express.Router();

    if (fixturesDirectory) {
        console.info(`[marketplace] answering from fixtures in ${fixturesDirectory}; no card site will be contacted.`);
    }
    const fetchJson = createFetchJson({
        fetch: fixturesDirectory ? createFixtureFetch(fixturesDirectory) : fetch,
        userAgent,
    });
    const searchCache = createCache({ ttlMs: SEARCH_TTL_MS, max: CACHE_MAX });
    const detailCache = createCache({ ttlMs: DETAIL_TTL_MS, max: CACHE_MAX });
    const nsfwServedCache = createCache({ ttlMs: NSFW_SERVED_TTL_MS, max: CACHE_MAX });

    /**
     * Whether the source serves NSFW to this location, for a search that asked for it. A
     * failure of this side question is not a failure of the search: it answers `null`
     * (unknown) and the page still goes out.
     * @param {import('./sources/index.js').MarketSource} source The source searched.
     * @param {string} handle The user, for the cache key.
     * @returns {Promise<boolean|null>} Served, not served, or unknown.
     */
    async function nsfwServed(source, handle) {
        if (typeof source.nsfwServed !== 'function') return null;
        const cacheKey = JSON.stringify([handle, 'anonymous', source.id, 'nsfw-served']);
        try {
            return await nsfwServedCache.wrap(cacheKey, () => /** @type {NonNullable<typeof source.nsfwServed>} */ (source.nsfwServed)({ fetchJson, key: null }));
        } catch (error) {
            console.warn(`[marketplace] ${source.id} nsfwServed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Runs one adapter call and answers: the result, a named card-site error, or a 500 of ours.
     * @param {import('express').Response} response The response.
     * @param {string} label For the log.
     * @param {() => Promise<object>} run The call.
     * @returns {Promise<void>}
     */
    async function answer(response, label, run) {
        try {
            response.json(await run());
        } catch (error) {
            if (error instanceof MarketError) {
                console.warn(`[marketplace] ${label}: ${error.message}`);
                response.json({ error: error.toJSON() });
                return;
            }
            console.error(`[marketplace] ${label} failed`, error);
            response.sendStatus(500);
        }
    }

    router.post('/sources', (_request, response) => {
        const enabled = isEnabled();
        response.json({ enabled, sources: enabled ? [...SOURCES.values()].map(describeSource) : [] });
    });

    router.post('/search', async (request, response) => {
        if (!isEnabled()) return response.sendStatus(404);
        const source = SOURCES.get(request.body?.source);
        if (!source) return response.sendStatus(400);

        const query = normalizeQuery(request.body, source);
        // Keyed by user and by whether a key rode along, so one user's signed-in answer is
        // never served to another. No key is sent yet; the slot is here so it cannot be forgotten.
        const handle = userHandle(request);
        const cacheKey = JSON.stringify([handle, 'anonymous', source.id, query]);
        await answer(response, `${source.id} search`, async () => {
            // The side question rides alongside the search, not after it: one round trip for
            // the client, and a wrong "not served here" can never come from a search that was
            // itself the failure.
            const [page, served] = await Promise.all([
                searchCache.wrap(cacheKey, () => source.search(query, { fetchJson, key: null })),
                query.filters.nsfw === true ? nsfwServed(source, handle) : Promise.resolve(null),
            ]);
            return {
                ...page,
                items: page.items.map(item => ({ ...item, importUrl: source.importUrl(item.id) })),
                nsfwServed: served,
            };
        });
    });

    router.post('/detail', async (request, response) => {
        if (!isEnabled()) return response.sendStatus(404);
        const source = SOURCES.get(request.body?.source);
        const id = request.body?.id;
        if (!source || !source.isValidId(id)) return response.sendStatus(400);

        const cacheKey = JSON.stringify([userHandle(request), 'anonymous', source.id, id]);
        await answer(response, `${source.id} detail`, async () => {
            const detail = await detailCache.wrap(cacheKey, () => source.detail(id, { fetchJson, key: null }));
            return { ...detail, importUrl: source.importUrl(detail.id) };
        });
    });

    return router;
}

export const router = createMarketplaceRouter();
