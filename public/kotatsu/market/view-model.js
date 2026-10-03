/**
 * Browse Characters' view model — `docs/character-marketplace-v0.md` §5, §6, §8, §10.
 *
 * DOM-free and core-free by contract: it turns what `/api/kotatsu/marketplace/*` answers into
 * poster rows, preview facts and the words for every state. It never fetches, never renders
 * and never reads `characters` itself; the caller hands it the list. That is what lets
 * `tests/market-view-model.test.js` run with no mocks at all.
 *
 * Everything that arrives from a card site is untrusted text. Nothing here produces HTML; the
 * strings it returns are bound as text by the component.
 */

import { accentHue, toInitials } from '../library/card-identity.js';

/** Tag pills a poster prints, same as the library's. */
export const MARKET_TAG_MAX = 3;

/** How much of a creator's note a poster will show. The whole note is in the preview. */
const EXCERPT_MAX = 180;

/**
 * A card as the server's adapters describe it. Mirrors `CardSummary` in
 * `src/endpoints/kotatsu/marketplace/sources/chub.js`.
 * @typedef {object} CardSummary
 * @property {string} source
 * @property {string} id What detail and import take. Not unique on Chub.
 * @property {string} uid Unique within the source. Keys and installed-matching use this.
 * @property {string} name
 * @property {string} creator
 * @property {string} tagline
 * @property {string} blurb
 * @property {string[]} tags
 * @property {number|null} tokens
 * @property {string} avatarUrl
 * @property {string} artUrl The full-size card image, '' when there is none.
 * @property {string} pageUrl
 * @property {string} importUrl
 * @property {boolean} nsfwImage
 * @property {number} updatedAt
 * @property {number} createdAt
 * @property {Record<string, number>} stats
 */

/**
 * @typedef {object} CardDetailExtra
 * @property {string} firstMessage
 * @property {string[]} alternateGreetings
 * @property {string} description
 * @property {string} scenario
 * @property {boolean} hasExamples
 * @property {boolean} hasSystemPrompt
 * @property {boolean} hasPostHistory
 * @property {number} lorebookEntries
 * @property {Record<string, number>} tokenCounts Keyed by card field (`first_mes`, `total`, …).
 */

/** @typedef {CardSummary & CardDetailExtra} CardDetail */

/**
 * @typedef {object} InstalledIndex
 * @property {Map<string, string>} byUid `<source>:<uid>` → avatar filename.
 * @property {Map<string, string>} byPath `<source>:<lowercased path>` → avatar filename, only
 * for installed cards that carry no uid.
 */

/**
 * @typedef {object} MarketRow
 * @property {string} key Stable identity for keyed rendering: `<source>.<uid>`.
 * @property {string} source
 * @property {string} id
 * @property {string} uid
 * @property {string} name Untrusted text.
 * @property {string} initials For a poster with no portrait.
 * @property {string} portrait Avatar URL, `''` when there is none.
 * @property {number} hue Deterministic accent hue, 0-359.
 * @property {string} kicker `by <creator>`, or `''`.
 * @property {string} body One short paragraph of plain text. May be `''`.
 * @property {string[]} tags At most {@link MARKET_TAG_MAX}.
 * @property {number|null} tokens
 * @property {boolean} nsfwImage Whether the site flags the portrait as NSFW.
 * @property {boolean} blur Whether the portrait is drawn blurred: flagged, and the reader has
 * not switched blurring off.
 * @property {string} installed Avatar filename of the copy in the library, `''` when not installed.
 * @property {'uid'|'path'|''} installedVia How the installed copy was recognised.
 * @property {string} importUrl
 * @property {string} pageUrl
 * @property {number} updatedAt
 */

/**
 * How each source's stamp is read off an installed card. Chub's own API writes
 * `extensions.chub = { id, full_path }` into every card it serves, and core's importer keeps
 * it (measured 2026-10-02: 12 of 12).
 * @type {Record<string, (character: any) => { uid: string, path: string }>}
 */
const PROVENANCE = {
    chub: (character) => {
        const stamp = character?.data?.extensions?.chub;
        return {
            uid: typeof stamp?.id === 'number' || (typeof stamp?.id === 'string' && stamp.id) ? String(stamp.id) : '',
            path: typeof stamp?.full_path === 'string' ? stamp.full_path : '',
        };
    },
};

/**
 * Indexes the library by where each card came from, so a row can say "In your library".
 *
 * A path is indexed only for a card with no uid. Two distinct Chub cards can share one path,
 * so a path match is the weaker claim and is used only when it is all the card carries.
 * @param {readonly any[]} characters Core's `characters` array (or any array shaped like it).
 * @returns {InstalledIndex} The index.
 */
export function buildInstalledIndex(characters) {
    /** @type {InstalledIndex} */
    const index = { byUid: new Map(), byPath: new Map() };
    for (const character of Array.isArray(characters) ? characters : []) {
        const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
        if (!avatar) continue;
        for (const [source, read] of Object.entries(PROVENANCE)) {
            const { uid, path } = read(character);
            if (uid) {
                if (!index.byUid.has(`${source}:${uid}`)) index.byUid.set(`${source}:${uid}`, avatar);
            } else if (path) {
                const key = `${source}:${path.toLowerCase()}`;
                if (!index.byPath.has(key)) index.byPath.set(key, avatar);
            }
        }
    }
    return index;
}

/**
 * @param {Pick<CardSummary, 'source'|'id'|'uid'>} summary A card.
 * @param {InstalledIndex} index The library index.
 * @returns {{ avatar: string, via: 'uid'|'path' }|null} The installed copy, or null.
 */
export function installedMatch(summary, index) {
    const byUid = index.byUid.get(`${summary.source}:${summary.uid}`);
    if (byUid) return { avatar: byUid, via: 'uid' };
    const byPath = index.byPath.get(`${summary.source}:${String(summary.id).toLowerCase()}`);
    if (byPath) return { avatar: byPath, via: 'path' };
    return null;
}

/**
 * A creator's note as one short line of plain text. Notes are written in Markdown and HTML;
 * this only makes them readable as text, it is not a sanitizer (nothing here becomes HTML).
 * @param {unknown} text The note.
 * @param {number} [max] Longest result.
 * @returns {string} Collapsed, tag-free, truncated at a word where one is near.
 */
export function plainExcerpt(text, max = EXCERPT_MAX) {
    const plain = String(text ?? '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (plain.length <= max) return plain;
    const cut = plain.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * @typedef {object} RowOptions
 * @property {boolean} [blurNsfw] Whether flagged portraits are drawn blurred. Default true, the
 * shipped behaviour (doc §7).
 */

/**
 * @param {CardSummary} summary A card from the server.
 * @param {InstalledIndex} index The library index.
 * @param {RowOptions} [options] The reader's settings.
 * @returns {MarketRow} The poster row.
 */
export function toMarketRow(summary, index, { blurNsfw = true } = {}) {
    const match = installedMatch(summary, index);
    const key = `${summary.source}.${summary.uid}`;
    return {
        key,
        source: summary.source,
        id: summary.id,
        uid: summary.uid,
        name: summary.name,
        initials: toInitials(summary.name),
        portrait: summary.avatarUrl,
        hue: accentHue(key),
        kicker: summary.creator ? `by ${summary.creator}` : '',
        body: plainExcerpt(summary.tagline) || plainExcerpt(summary.blurb),
        tags: summary.tags.slice(0, MARKET_TAG_MAX),
        tokens: summary.tokens,
        nsfwImage: summary.nsfwImage === true,
        blur: summary.nsfwImage === true && blurNsfw,
        installed: match?.avatar ?? '',
        installedVia: match?.via ?? '',
        importUrl: summary.importUrl,
        pageUrl: summary.pageUrl,
        updatedAt: summary.updatedAt,
    };
}

/**
 * Appends a page to the rows already shown, never showing one card twice. Paging over a live
 * list can hand back a row that was on the previous page.
 * @param {readonly MarketRow[]} rows Rows on screen.
 * @param {readonly CardSummary[]} items The next page.
 * @param {InstalledIndex} index The library index.
 * @param {RowOptions} [options] The reader's settings.
 * @returns {MarketRow[]} The combined rows.
 */
export function appendRows(rows, items, index, options = {}) {
    const seen = new Set(rows.map(row => row.key));
    const out = [...rows];
    for (const item of items) {
        const row = toMarketRow(item, index, options);
        if (seen.has(row.key)) continue;
        seen.add(row.key);
        out.push(row);
    }
    return out;
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat('en');

/**
 * @param {unknown} value A count.
 * @returns {string} `1.2K`, `37.8K`; `''` when it is not a number.
 */
export function compactCount(value) {
    return typeof value === 'number' && Number.isFinite(value) ? COMPACT.format(value) : '';
}

/**
 * @param {number} count How many.
 * @param {string} one Singular.
 * @param {string} many Plural.
 * @returns {string} `1 entry`, `29 entries`.
 */
const plural = (count, one, many) => `${WHOLE.format(count)} ${count === 1 ? one : many}`;

/**
 * @typedef {object} GreetingFacts
 * @property {string[]} greetings The first message, then the alternates, in order.
 * @property {number|null} totalTokens
 * @property {number|null} firstMessageTokens
 * @property {number} alternateGreetings
 * @property {number} lorebookEntries
 * @property {boolean} hasExamples
 * @property {boolean} hasSystemPrompt
 * @property {boolean} hasPostHistory
 * @property {number} userMentions How many times the first message names `{{user}}`.
 */

/**
 * What can be said about a card before importing it. Facts only. "Names {{user}} 4 times" is a
 * count; whether a greeting writes the user's part is for the reader, who has the greeting in
 * front of them (doc §6: no verdict in v0).
 * @param {CardDetail} detail A card detail from the server.
 * @returns {GreetingFacts} The facts.
 */
export function greetingFacts(detail) {
    const counts = detail.tokenCounts ?? {};
    const first = String(detail.firstMessage ?? '');
    const alternates = Array.isArray(detail.alternateGreetings) ? detail.alternateGreetings : [];
    const number = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    return {
        greetings: [first, ...alternates].filter(greeting => greeting.trim() !== ''),
        totalTokens: number(counts.total) ?? number(detail.tokens),
        firstMessageTokens: number(counts.first_mes),
        alternateGreetings: alternates.length,
        lorebookEntries: detail.lorebookEntries > 0 ? detail.lorebookEntries : 0,
        hasExamples: detail.hasExamples === true,
        hasSystemPrompt: detail.hasSystemPrompt === true,
        hasPostHistory: detail.hasPostHistory === true,
        userMentions: (first.match(/\{\{user\}\}/gi) ?? []).length,
    };
}

/**
 * The fact row of the preview, as short labels in reading order.
 * @param {GreetingFacts} facts From {@link greetingFacts}.
 * @returns {{ id: string, label: string }[]} Chips. Absent facts are left out, never shown as zero.
 */
export function factChips(facts) {
    /** @type {{ id: string, label: string }[]} */
    const chips = [];
    if (facts.totalTokens !== null) chips.push({ id: 'tokens', label: plural(facts.totalTokens, 'token', 'tokens') });
    if (facts.firstMessageTokens !== null) chips.push({ id: 'greeting', label: `Greeting ${plural(facts.firstMessageTokens, 'token', 'tokens')}` });
    if (facts.alternateGreetings > 0) chips.push({ id: 'alternates', label: plural(facts.alternateGreetings, 'alternate greeting', 'alternate greetings') });
    if (facts.lorebookEntries > 0) chips.push({ id: 'lorebook', label: `Lorebook, ${plural(facts.lorebookEntries, 'entry', 'entries')}` });
    if (facts.hasExamples) chips.push({ id: 'examples', label: 'Example dialogue' });
    if (facts.hasSystemPrompt) chips.push({ id: 'system', label: 'System prompt' });
    if (facts.hasPostHistory) chips.push({ id: 'post-history', label: 'Post-history instructions' });
    if (facts.userMentions > 0) chips.push({ id: 'user', label: `Names {{user}} ${plural(facts.userMentions, 'time', 'times')}` });
    return chips;
}

/**
 * The site's counters as short labels, in a fixed order, using only what the site gave.
 * Chub's names are kept where their meaning is not verified (`starCount` is not called
 * "downloads" here; see the design doc).
 * @param {Record<string, number>} stats The summary's `stats`.
 * @param {number} updatedAt Epoch ms, 0 when unknown.
 * @returns {{ id: string, label: string }[]} Chips. Absent counters are left out.
 */
export function statChips(stats, updatedAt) {
    /** @type {{ id: string, label: string }[]} */
    const chips = [];
    const number = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
    const rating = number(stats?.rating);
    const ratingCount = number(stats?.ratingCount);
    if (rating !== null && ratingCount !== null && ratingCount > 0) chips.push({ id: 'rating', label: `Rated ${rating.toFixed(1)} by ${plural(ratingCount, 'reader', 'readers')}` });
    const favorites = number(stats?.n_favorites);
    if (favorites !== null && favorites > 0) chips.push({ id: 'favorites', label: `${compactCount(favorites)} ${favorites === 1 ? 'favorite' : 'favorites'}` });
    const chats = number(stats?.nChats);
    if (chats !== null && chats > 0) chips.push({ id: 'chats', label: `${compactCount(chats)} ${chats === 1 ? 'chat' : 'chats'}` });
    if (updatedAt > 0) chips.push({ id: 'updated', label: `Updated ${new Date(updatedAt).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })}` });
    return chips;
}

/**
 * Two distinct Chub cards can share one path, and the detail call answers for whichever the
 * site serves at that path. When that is not the card that was clicked, the reader is told.
 * @param {Pick<CardSummary, 'uid'>} clicked The row that was opened.
 * @param {Pick<CardSummary, 'uid'>} served The detail that came back.
 * @param {string} label The source's display name.
 * @returns {string} A sentence, or '' when they are the same card.
 */
export function twinNotice(clicked, served, label) {
    if (!clicked?.uid || !served?.uid || clicked.uid === served.uid) return '';
    return `${label} has two cards at this address. This is the one it serves; the one you clicked is not reachable by its link.`;
}

/**
 * What the preview offers for a card, given what the library holds.
 * @param {{ installed: string }} row The row, with its installed avatar or ''.
 * @returns {{ primary: 'import'|'open', secondary: 'update'|null }} The actions.
 */
export function previewActions(row) {
    return row.installed ? { primary: 'open', secondary: 'update' } : { primary: 'import', secondary: null };
}

/**
 * @typedef {object} MarketErrorBody
 * @property {'offline'|'upstream'|'rate_limited'|'shape'|'auth'|'disabled'|'local'} kind The
 * server's five kinds, plus two only the client can see: `disabled` (the marketplace is switched
 * off) and `local` (our own server did not answer).
 * @property {string} [source]
 * @property {number} [status]
 * @property {number} [retryAfter]
 */

/**
 * @typedef {object} StateCopy
 * @property {string} title
 * @property {string} body
 * @property {'retry'|'site'|'settings'|'none'} action What the state offers.
 */

/**
 * The words for a failure, in the grid's place (doc §10). Each kind says what happened, that
 * the library is unaffected where that is the worry, and what to do next.
 * @param {MarketErrorBody} error The error.
 * @param {{ label?: string, context?: 'search'|'detail' }} [options] The source's display name, and where it happened.
 * @returns {StateCopy} Title, body and the one action offered.
 */
export function errorCopy(error, { label = 'the site', context = 'search' } = {}) {
    switch (error?.kind) {
        case 'offline':
            return {
                title: `Couldn't reach ${label}.`,
                body: 'Your library is fine. The site just isn\'t answering from here. Check your connection, or try again in a moment.',
                action: 'retry',
            };
        case 'rate_limited':
            return {
                title: `${label} asked us to slow down.`,
                body: typeof error.retryAfter === 'number' && error.retryAfter > 0
                    ? `Try again in about ${plural(error.retryAfter, 'second', 'seconds')}.`
                    : 'Give it a minute, then try again.',
                action: 'retry',
            };
        case 'shape':
            return {
                title: `${label} changed something.`,
                body: `This version of Kotatsu doesn't understand the site's answer yet. You can still browse on ${label} and import a card by its link.`,
                action: 'site',
            };
        case 'auth':
            return {
                title: `${label} didn't accept the key.`,
                body: 'Check the key in Settings, or remove it to browse without an account.',
                action: 'settings',
            };
        case 'disabled':
            return {
                title: 'Browse Characters is switched off.',
                body: 'It is turned off in this install\'s config.yaml (kotatsu.marketplace.enabled).',
                action: 'none',
            };
        case 'local':
            return {
                title: 'Kotatsu\'s server didn\'t answer.',
                body: 'The request never reached a card site. Check that Kotatsu is still running, then try again.',
                action: 'retry',
            };
        case 'upstream':
        default:
            if (context === 'detail' && error?.status === 404) {
                return {
                    title: `That card isn't on ${label} any more.`,
                    body: 'It may have been removed or made private since this list was loaded.',
                    action: 'none',
                };
            }
            return {
                title: `${label} is having trouble.`,
                body: `The site answered with an error${typeof error?.status === 'number' ? ` (${error.status})` : ''}. Nothing is wrong on your side.`,
                action: 'retry',
            };
    }
}

/**
 * The count line under the tools. A site's count can be a cap rather than a count (Chub
 * answers exactly 100,000 for NSFW-inclusive searches, measured 2026-10-02); a cap is said as
 * "over", never printed as the number.
 * @param {number} total The page's `total`.
 * @param {boolean} ceiling The page's `ceiling`.
 * @returns {string} `1 card`, `37.8K cards`, `over 100K cards`.
 */
export function countCopy(total, ceiling) {
    const count = compactCount(total);
    if (!count) return '';
    if (ceiling) return `over ${count} cards`;
    return `${count} ${total === 1 ? 'card' : 'cards'}`;
}

/**
 * Why the grid did not change when NSFW was switched on. Said only when the site answered the
 * question with zero; silence when it was not asked or could not be answered. There is no
 * region list of our own in it (doc §13): the site's list will change, a measured zero will
 * not go stale.
 * @param {{ nsfwOn: boolean, nsfwServed: boolean|null, label?: string }} state The switch, the answer, the source's display name.
 * @returns {string} One sentence, or ''.
 */
export function nsfwNotice({ nsfwOn, nsfwServed, label = 'the site' }) {
    if (!nsfwOn || nsfwServed !== false) return '';
    return `${label} isn't serving NSFW cards to this location, so the switch changes nothing here. That is the site's own gate, and Kotatsu doesn't go around it.`;
}

/**
 * The words for a search that found nothing. Its own state, distinct from every error.
 * @param {{ label?: string, filtered?: boolean }} [options] The source's display name, and whether any filter is set.
 * @returns {StateCopy} Title and body.
 */
export function emptyCopy({ label = 'the site', filtered = false } = {}) {
    return {
        title: `Nobody on ${label} answers that description.`,
        body: filtered ? 'Try loosening a filter, or search for something else.' : 'Try another search.',
        action: 'none',
    };
}
