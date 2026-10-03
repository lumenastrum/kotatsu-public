import fs from 'node:fs';
import path from 'node:path';

import { MarketError, parseRetryAfter } from './errors.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} FetchJsonOptions
 * @property {string} source Source id, for the error.
 * @property {Record<string, string>} [headers] Extra request headers (a key, when there is one).
 * @property {boolean} [authed] Whether a key was sent. Only then is a 401/403 an `auth` error.
 */

/**
 * @typedef {(url: string, options: FetchJsonOptions) => Promise<any>} FetchJson
 */

/**
 * The one way an adapter talks to its site: GET a URL, get JSON back, or throw one of the
 * five named errors. One timeout, one retry on a network failure, none on an HTTP error.
 *
 * @param {{ fetch: Function, userAgent: string, timeoutMs?: number }} options The fetch to use (node-fetch, or the fixtures one), who we say we are, and how long we wait.
 * @returns {FetchJson} The function adapters receive as `ctx.fetchJson`.
 */
export function createFetchJson({ fetch, userAgent, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    /**
     * @param {string} url Upstream URL.
     * @param {Record<string, string>} headers Request headers.
     * @returns {Promise<any>} The fetch response.
     */
    async function attempt(url, headers) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { method: 'GET', headers, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    return async function fetchJson(url, { source, headers = {}, authed = false }) {
        const requestHeaders = { 'Accept': 'application/json', 'User-Agent': userAgent, ...headers };

        let response;
        try {
            response = await attempt(url, requestHeaders);
        } catch {
            try {
                response = await attempt(url, requestHeaders);
            } catch (error) {
                throw new MarketError('offline', source, { detail: error instanceof Error ? error.message : String(error) });
            }
        }

        const status = response.status;
        if (status === 429) {
            throw new MarketError('rate_limited', source, { status, retryAfter: parseRetryAfter(response.headers.get('retry-after')) });
        }
        if ((status === 401 || status === 403) && authed) {
            throw new MarketError('auth', source, { status });
        }
        if (!response.ok) {
            throw new MarketError('upstream', source, { status });
        }

        try {
            return JSON.parse(await response.text());
        } catch {
            throw new MarketError('shape', source, { status, detail: 'body is not JSON' });
        }
    };
}

/**
 * @typedef {object} FixtureEntry
 * @property {string} host Upstream host.
 * @property {string} path Exact pathname.
 * @property {Record<string, string>} [query] Query pairs that must all match.
 * @property {string} [file] Body to serve, relative to the fixtures directory.
 * @property {number} [status] Status to answer with (default 200).
 * @property {number} [retryAfter] `Retry-After` seconds to send with it.
 * @property {boolean} [offline] Fail as a network error instead of answering.
 */

/**
 * A stand-in for `fetch` that answers from recorded files instead of the network, so tests and
 * rig probes never load a card site. The manifest's first matching entry wins; a URL with no
 * entry answers 404. It goes through the same `createFetchJson` as the real thing, so status
 * handling is exercised, not bypassed.
 *
 * @param {string} directory Fixtures directory holding `manifest.json`.
 * @returns {(url: string) => Promise<{ ok: boolean, status: number, headers: { get: (name: string) => string|null }, text: () => Promise<string> }>} A fetch-shaped function.
 */
export function createFixtureFetch(directory) {
    /** @type {{ entries: FixtureEntry[] }} */
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

    return async function fixtureFetch(url) {
        const target = new URL(url);
        const entry = manifest.entries.find(candidate => candidate.host === target.host
            && candidate.path === decodeURIComponent(target.pathname)
            && Object.entries(candidate.query ?? {}).every(([key, value]) => target.searchParams.get(key) === value));

        if (entry?.offline) {
            throw new Error('fixture: offline');
        }

        const status = entry ? (entry.status ?? 200) : 404;
        const body = entry?.file ? fs.readFileSync(path.join(directory, entry.file), 'utf8') : '';
        const headers = new Map();
        if (entry?.retryAfter !== undefined) headers.set('retry-after', String(entry.retryAfter));

        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
            text: async () => body,
        };
    };
}
