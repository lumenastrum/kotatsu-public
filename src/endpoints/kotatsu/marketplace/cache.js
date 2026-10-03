/**
 * A small in-memory cache for card-site answers: time-limited, size-limited, and it shares
 * one in-flight request between identical callers. Nothing is written to disk
 * (docs/character-marketplace-v0.md §4, §14).
 *
 * Failures are never cached: a site that was down a moment ago is asked again.
 *
 * @template T
 * @param {{ ttlMs: number, max: number, now?: () => number }} options Lifetime, capacity, clock.
 * @returns {{ wrap: (key: string, produce: () => Promise<T>) => Promise<T>, size: () => number, clear: () => void }} The cache.
 */
export function createCache({ ttlMs, max, now = Date.now }) {
    /** @type {Map<string, { value: T, expires: number }>} Insertion order is recency. */
    const entries = new Map();
    /** @type {Map<string, Promise<T>>} */
    const inFlight = new Map();

    /**
     * @param {string} key Cache key.
     * @param {() => Promise<T>} produce Called on a miss.
     * @returns {Promise<T>} The cached or fresh value.
     */
    async function wrap(key, produce) {
        const hit = entries.get(key);
        if (hit && hit.expires > now()) {
            // Refresh recency.
            entries.delete(key);
            entries.set(key, hit);
            return hit.value;
        }
        if (hit) entries.delete(key);

        const pending = inFlight.get(key);
        if (pending) return pending;

        const promise = (async () => {
            try {
                const value = await produce();
                entries.set(key, { value, expires: now() + ttlMs });
                while (entries.size > max) {
                    entries.delete(entries.keys().next().value);
                }
                return value;
            } finally {
                inFlight.delete(key);
            }
        })();
        inFlight.set(key, promise);
        return promise;
    }

    return { wrap, size: () => entries.size, clear: () => { entries.clear(); inFlight.clear(); } };
}
