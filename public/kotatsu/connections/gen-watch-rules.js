/**
 * The decision behind the generation watchdog (issue #28, layer 1). Pure, no DOM, so Jest
 * can pin it.
 *
 * A phone that sleeps mid-reply can leave the page waiting on a half-open connection
 * forever. The page alone can't tell "dead" from "quiet" (a long thinking phase sends
 * nothing for a minute and is perfectly healthy), so it asks the server, which counted
 * every byte it wrote (src/endpoints/kotatsu/gen-watch/).
 */

/** The server ended the response, but the page hasn't seen the end for this long → dead. */
export const ENDED_GRACE_MS = 5_000;
/** The server wrote bytes the page never got, and nothing has arrived for this long → dead. */
export const BEHIND_GRACE_MS = 15_000;
/** The server has never heard of the request this long after it was sent → dead. */
export const UNKNOWN_GRACE_MS = 15_000;
/** Don't bother asking the server about a request that got bytes this recently. */
export const QUIET_BEFORE_CHECK_MS = 5_000;

/**
 * @typedef {object} PageSide
 * @property {number} startedAt when the page sent the request
 * @property {number} lastByteAt last time a body byte (or the headers) arrived
 * @property {number} bytes body bytes the page has received
 */

/**
 * @typedef {{ state: 'running'|'done'|'closed', bytes: number, idleMs?: number } | { state: 'unknown' }} ServerSide
 */

/**
 * @param {PageSide} page
 * @param {ServerSide | undefined} server
 * @param {number} now
 * @returns {'alive' | 'dead'}
 */
export function judge(page, server, now) {
    const pageIdle = now - page.lastByteAt;
    if (!server || server.state === 'unknown') {
        return now - page.startedAt >= UNKNOWN_GRACE_MS && pageIdle >= UNKNOWN_GRACE_MS ? 'dead' : 'alive';
    }
    if (server.state === 'done' || server.state === 'closed') {
        // The handler is finished; a live connection delivers the rest within moments.
        return pageIdle >= ENDED_GRACE_MS ? 'dead' : 'alive';
    }
    // Running: quiet is fine as long as the page has everything the server sent.
    return server.bytes > page.bytes && pageIdle >= BEHIND_GRACE_MS ? 'dead' : 'alive';
}

/**
 * @param {PageSide} page
 * @param {number} now
 * @returns {boolean}
 */
export function worthChecking(page, now) {
    return now - page.lastByteAt >= QUIET_BEFORE_CHECK_MS;
}
