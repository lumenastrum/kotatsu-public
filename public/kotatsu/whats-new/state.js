/**
 * What's New — when it opens and what it shows. No DOM, no core imports: `<k-whats-new>` renders
 * whatever this says, and Jest drives it directly (`tests/whats-new.test.js`).
 *
 * ── The flag ─────────────────────────────────────────────────────────────────────────────────
 * `power_user.kotatsu_whats_new_seen`: the Kotatsu version whose notes were last closed. Written
 * when the sheet closes, and silently when there is nothing to show, so it only ever moves
 * forward with the install.
 *   - equal to the running version → nothing to show.
 *   - older                        → show every release in between that has notes, newest first.
 *   - absent                       → an install from before What's New existed: show the running
 *                                    release's notes, once.
 *   - newer (a downgrade)          → nothing to show; the flag follows the install back down.
 * A brand-new install never sees it: the welcome tour is its first impression, so while the tour
 * is due the flag is just stamped with the running version.
 */

/** Releases shown in one sitting at most, so a long-idle install isn't handed a slideshow. */
export const MAX_RELEASES = 3;

/**
 * @typedef {object} Card
 * @property {string} id Stable key; also the clip's file name under `media/<version>/`.
 * @property {string} title
 * @property {string} body What it is and how to reach it, in the UI's own words.
 * @property {string} line Mikan-chan's line key in `brand/mascot/lines.js`.
 * @property {string} [wiki] The wiki page (and anchor) that explains it.
 */

/**
 * @typedef {object} Release
 * @property {string} version `major.minor.patch`
 * @property {string} title What the release is about, in a few words.
 * @property {Card[]} cards
 * @property {string[]} [notes] Smaller changes, one line each, under the last card.
 */

/**
 * @param {unknown} value
 * @returns {number[]|null} `[major, minor, patch]`, or null when it isn't a version.
 */
export function parseVersion(value) {
    const match = typeof value === 'string' ? /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim()) : null;
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} <0 when a is older, 0 when equal, >0 when newer. Unparseable sorts oldest.
 */
export function compareVersions(a, b) {
    const x = parseVersion(a);
    const y = parseVersion(b);
    if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) return x[i] - y[i];
    }
    return 0;
}

/**
 * What this boot should do.
 * @param {object} input
 * @param {unknown} input.seen `power_user.kotatsu_whats_new_seen`.
 * @param {unknown} input.current The running Kotatsu version.
 * @param {boolean} input.tourDue Whether the welcome tour opens this boot.
 * @param {readonly Release[]} input.releases Every release with notes.
 * @returns {{open: boolean, releases: Release[], stamp: string|null}} Whether to open, the
 *   releases to show (newest first), and the version to write to the flag now (null: leave it).
 */
export function whatsNewPlan({ seen, current, tourDue, releases }) {
    const none = (/** @type {string|null} */ stamp) => ({ open: false, releases: [], stamp });
    if (!parseVersion(current)) return none(null);
    const running = /** @type {string} */ (current);
    if (seen === running) return none(null);
    if (tourDue) return none(running);
    const known = parseVersion(seen) ? /** @type {string} */ (seen) : null;
    if (known && compareVersions(known, running) > 0) return none(running);
    const shown = releases
        .filter(release => parseVersion(release.version) && compareVersions(release.version, running) <= 0)
        .filter(release => known ? compareVersions(release.version, known) > 0 : compareVersions(release.version, running) === 0)
        .filter(release => Array.isArray(release.cards) && release.cards.length > 0)
        .sort((a, b) => compareVersions(b.version, a.version))
        .slice(0, MAX_RELEASES);
    return shown.length ? { open: true, releases: shown, stamp: null } : none(running);
}

/**
 * The newest release at or below the running version: what Settings' "show again" opens.
 * @param {unknown} current
 * @param {readonly Release[]} releases
 * @returns {Release|null}
 */
export function latestRelease(current, releases) {
    if (!parseVersion(current)) return null;
    return releases
        .filter(release => parseVersion(release.version) && compareVersions(release.version, /** @type {string} */ (current)) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

/**
 * One flat run of pages across the shown releases, so the sheet pages straight through them.
 * @param {readonly Release[]} releases Newest first.
 * @returns {{release: Release, card: Card, last: boolean}[]} `last` marks each release's final
 *   card, where its notes go.
 */
export function pagesOf(releases) {
    return releases.flatMap(release => release.cards.map((card, index) => ({
        release,
        card,
        last: index === release.cards.length - 1,
    })));
}
