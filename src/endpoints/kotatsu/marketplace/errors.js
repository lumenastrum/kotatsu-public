/**
 * The five ways a card site can fail us (docs/character-marketplace-v0.md §10). Every upstream
 * failure becomes exactly one of these, so the UI never has to read a status code and a drift
 * in a site's API never renders as a silent empty grid.
 *
 * - `offline`: our server could not reach the site at all.
 * - `upstream`: the site answered, with an error (5xx, or a 4xx that is not about us).
 * - `rate_limited`: 429.
 * - `shape`: the body no longer has the fields the adapter needs.
 * - `auth`: a key was sent and the site refused it.
 */
export const ERROR_KINDS = Object.freeze(['offline', 'upstream', 'rate_limited', 'shape', 'auth']);

/**
 * @typedef {object} MarketErrorBody
 * @property {'offline'|'upstream'|'rate_limited'|'shape'|'auth'} kind
 * @property {string} source
 * @property {number} [status]
 * @property {number} [retryAfter] Seconds, when the site said so.
 */

export class MarketError extends Error {
    /**
     * @param {MarketErrorBody['kind']} kind Which of the five.
     * @param {string} source Source id.
     * @param {{ status?: number, retryAfter?: number, detail?: string }} [extra] What is known.
     */
    constructor(kind, source, { status, retryAfter, detail } = {}) {
        super(`${source}: ${kind}${status ? ` (${status})` : ''}${detail ? `: ${detail}` : ''}`);
        this.name = 'MarketError';
        this.kind = kind;
        this.source = source;
        this.status = status;
        this.retryAfter = retryAfter;
    }

    /**
     * What the client is told. `detail` stays in the server log.
     * @returns {MarketErrorBody} The wire shape.
     */
    toJSON() {
        /** @type {MarketErrorBody} */
        const body = { kind: this.kind, source: this.source };
        if (typeof this.status === 'number') body.status = this.status;
        if (typeof this.retryAfter === 'number') body.retryAfter = this.retryAfter;
        return body;
    }
}

/**
 * Reads a `Retry-After` header: seconds, or an HTTP date.
 * @param {string|null|undefined} value The header.
 * @param {number} [now] Epoch ms, for tests.
 * @returns {number|undefined} Whole seconds from now, or undefined when unreadable.
 */
export function parseRetryAfter(value, now = Date.now()) {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - now) / 1000));
    return undefined;
}
