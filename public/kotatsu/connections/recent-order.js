/**
 * The order behind the top bar's "Switch to" list: most recently used first (Andres, 2026-11-01:
 * he had used the Anthropic API on recent chats and it was not a pick until "All connections").
 * Pure: switch-list.js gathers the facts, Jest drives this directly.
 */

/**
 * @typedef {object} RecentEntry
 * @property {string} id The row's id: `profile:<id>`, `key:<source>`, `way:<way id>`, `bridge`, `chatgpt`
 * @property {string} [url] The server a `way:` row was on, because a shared lane forgets it
 */

/** How many connections are remembered. */
export const RECENT_MAX = 12;

/**
 * Moves a connection to the front, or adds it there.
 * @param {readonly RecentEntry[]} recent Newest first.
 * @param {RecentEntry} entry The connection used now.
 * @returns {RecentEntry[]}
 */
export function rememberRecent(recent, entry) {
    return [entry, ...recent.filter(other => other.id !== entry.id)].slice(0, RECENT_MAX);
}

/**
 * Sorts rows newest use first. Rows never used keep their own order, after the ones that were.
 * @template {{ id: string }} Row
 * @param {readonly Row[]} rows
 * @param {readonly RecentEntry[]} recent Newest first.
 * @returns {Row[]}
 */
export function rankByRecent(rows, recent) {
    const rank = (/** @type {Row} */ row) => {
        const index = recent.findIndex(entry => entry.id === row.id);
        return index === -1 ? recent.length : index;
    };
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
        .map(({ row }) => row);
}
