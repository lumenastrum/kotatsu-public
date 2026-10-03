import crypto from 'node:crypto';

/**
 * One-time pairing codes (docs/phone-v0.md §3.1). In memory only: a restart forgets them, which is
 * the right failure — the card shows a fresh code.
 */

export const TOKEN_TTL_MS = 5 * 60_000;
export const MAX_LIVE_TOKENS = 4;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32}$/;

export class PairingTokens {
    /** @type {Map<string, number>} token → expiresAt (ms) */
    #live = new Map();

    /**
     * @param {number} now
     */
    #prune(now) {
        for (const [token, expiresAt] of this.#live) {
            if (expiresAt <= now) this.#live.delete(token);
        }
    }

    /**
     * Mints a code. The oldest live code is dropped past the cap.
     * @param {number} [now]
     * @returns {{ token: string, expiresAt: number }}
     */
    mint(now = Date.now()) {
        this.#prune(now);
        while (this.#live.size >= MAX_LIVE_TOKENS) {
            const oldest = this.#live.keys().next().value;
            if (oldest === undefined) break;
            this.#live.delete(oldest);
        }
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = now + TOKEN_TTL_MS;
        this.#live.set(token, expiresAt);
        return { token, expiresAt };
    }

    /**
     * Spends a code. True once per code, before it expires.
     * @param {unknown} token
     * @param {number} [now]
     * @returns {'ok'|'malformed'|'expired'}
     */
    redeem(token, now = Date.now()) {
        if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return 'malformed';
        const expiresAt = this.#live.get(token);
        this.#live.delete(token);
        if (expiresAt === undefined || expiresAt <= now) return 'expired';
        return 'ok';
    }

    /**
     * @param {number} [now]
     * @returns {number}
     */
    liveCount(now = Date.now()) {
        this.#prune(now);
        return this.#live.size;
    }
}
