import { chub } from './chub.js';

/**
 * One card site, behind one contract (docs/character-marketplace-v0.md §5). The rule for
 * admitting a source: it is reached cleanly, as the site serves an honest client, and core's
 * importer already understands its URLs, so the adapter needs no downloader of its own.
 *
 * @typedef {object} MarketSource
 * @property {string} id
 * @property {string} label
 * @property {string} home The site's front page.
 * @property {string} terms The site's terms page, linked from the 18+ line.
 * @property {boolean} adult The site is 18+ by its own terms.
 * @property {readonly string[]} imageHosts Hosts an avatar URL may point at.
 * @property {readonly { id: string, label: string }[]} sorts First one is the default.
 * @property {readonly string[]} filters Subset of `FILTER_KEYS` this source honours.
 * @property {string|null} secretId Named secret holding the user's key, or null.
 * @property {(query: import('../query.js').MarketQuery, ctx: import('./chub.js').MarketContext) => Promise<import('./chub.js').MarketPage>} search
 * @property {(id: string, ctx: import('./chub.js').MarketContext) => Promise<import('./chub.js').CardDetail>} detail
 * @property {(ctx: import('./chub.js').MarketContext) => Promise<boolean>} [nsfwServed] Whether the
 * site serves NSFW cards to this location. Only a source that honours the `nsfw` filter has one.
 * @property {(id: string) => string} importUrl A URL `importFromExternalUrl()` accepts.
 * @property {(id: unknown) => boolean} isValidId Whether an id from a client may reach `detail()`.
 */

/** @type {ReadonlyMap<string, MarketSource>} */
export const SOURCES = new Map([[chub.id, chub]]);
