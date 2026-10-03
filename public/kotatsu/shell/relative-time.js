/**
 * Compact chat recency labels shared by the rail, switcher, library and branch map.
 * @param {number} ms Epoch milliseconds.
 * @returns {string} Relative label, or an empty string for an unknown timestamp.
 */
export function toRelative(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '';
    }
    const delta = Date.now() - ms;
    if (delta < 60_000) {
        return 'now';
    }
    const minutes = Math.floor(delta / 60_000);
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days}d`;
    }
    if (days < 365) {
        return `${Math.floor(days / 7)}w`;
    }
    return `${Math.floor(days / 365)}y`;
}
