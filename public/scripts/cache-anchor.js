/**
 * Prompt cache v0 (docs/prompt-cache-v0.md): where the history cache breakpoint goes.
 *
 * A provider prefix cache only pays off when the bytes up to a breakpoint are identical on the
 * next request. Chat history is append-only, but in-chat injections (Author's Note @ depth,
 * lorebook entries @ depth, extension prompts, and later Kotatsu memory) move forward every turn.
 * So the anchor is the newest chat-history message OLDER than the deepest volatile message: the
 * last point that the next turn's prompt is guaranteed to repeat byte for byte.
 *
 * Pure: entries in, index out. Core-side on purpose (openai.js may not import public/kotatsu).
 */

/**
 * @typedef {object} CacheAnchorEntry
 * @property {string} [identifier] Prompt identifier; chat history uses `chatHistory-<n>`
 * @property {boolean} [volatile] True when the message is re-placed or rewritten every turn
 */

/**
 * Picks the cache anchor.
 * @param {CacheAnchorEntry[]} entries One entry per sent message, in the sent order
 * @returns {number} Index of the anchor message, or -1 when there is no stable history to anchor
 */
export function pickCacheAnchor(entries) {
    if (!Array.isArray(entries)) return -1;
    let anchor = -1;
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry?.volatile) break;
        if (typeof entry?.identifier === 'string' && entry.identifier.startsWith('chatHistory-')) {
            anchor = i;
        }
    }
    return anchor;
}
