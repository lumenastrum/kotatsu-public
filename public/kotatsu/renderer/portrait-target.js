/**
 * Pure helpers for the portrait peek (docs/portrait-peek-v0.md).
 *
 * No core imports, so jest can load this file in node without a page. `k-portrait-peek.js` owns
 * every DOM and core read; this file only decides what a click on a row portrait means.
 */

/**
 * Reads the avatar file a row portrait points at.
 *
 * Rows render thumbnails as `/thumbnail?type=<avatar|persona>&file=<encoded name>` (core's
 * `getThumbnailUrl()`, root-absolutized by the renderer). Core's own zoom handler slices after the
 * last `=`, which breaks on a file name that contains one; reading the query string does not.
 * Anything else — a data URL, a `/img/` system portrait, an extension's own image — is not a
 * thumbnail and returns null, so the caller falls back to showing the source as it is.
 * @param {string|null|undefined} src The portrait `<img>`'s `src` attribute.
 * @returns {{type: string, file: string}|null} The thumbnail type and decoded file name.
 */
export function thumbnailTarget(src) {
    if (typeof src !== 'string' || src.length === 0) return null;
    let url;
    try {
        url = new URL(src, 'http://kotatsu.invalid/');
    } catch {
        return null;
    }
    if (url.pathname !== '/thumbnail') return null;
    const type = url.searchParams.get('type');
    const file = url.searchParams.get('file');
    if (!type || !file) return null;
    return { type, file };
}

/**
 * The full-size art path for a character avatar file — the same `/characters/<file>` route core's
 * zoom uses, encoded so a name with spaces or `#` survives.
 * @param {string} file Avatar file name, e.g. `default_Seraphina.png`.
 * @returns {string} Root-relative URL.
 */
export function characterArtUrl(file) {
    return `/characters/${encodeURIComponent(file)}`;
}

/**
 * Trims a card string field; non-strings and blanks become ''.
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * The facts the peek sheet shows, read off a character record.
 *
 * V2 cards keep creator, version and creator's notes under `data`; older V1 records only have the
 * top-level `creatorcomment`. Every field is optional, and an empty one is simply not drawn — the
 * sheet never invents a creator, a version or a note.
 * @param {any} character One entry of core's `characters` array.
 * @returns {{name: string, creator: string, version: string, note: string}}
 */
export function cardFacts(character) {
    const data = character && typeof character.data === 'object' && character.data ? character.data : {};
    return {
        name: text(character?.name) || text(data.name),
        creator: text(data.creator),
        version: text(data.character_version),
        note: text(data.creator_notes) || text(character?.creatorcomment),
    };
}

/**
 * The byline under the name: "by OtisAlejandro · v1.0.0", or whichever half exists.
 * A version that already starts with "v" is not given a second one.
 * @param {{creator: string, version: string}} facts
 * @returns {string} The byline, or '' when the card names neither.
 */
export function byline({ creator, version }) {
    const parts = [];
    if (creator) parts.push(`by ${creator}`);
    if (version) parts.push(/^v/i.test(version) ? version : `v${version}`);
    return parts.join(' · ');
}

/**
 * Decides what a portrait click opens.
 *
 * - A character portrait whose card is loaded → the peek sheet.
 * - Everything else (the user's persona, a system message, a character no longer in the list,
 *   a portrait that is not a thumbnail) → the art lightbox, which only needs an image.
 * @param {{isUser: boolean, target: {type: string, file: string}|null, charIndex: number}} input
 * @returns {'peek'|'art'}
 */
export function portraitMode({ isUser, target, charIndex }) {
    if (isUser) return 'art';
    if (!target || target.type !== 'avatar') return 'art';
    return Number.isInteger(charIndex) && charIndex >= 0 ? 'peek' : 'art';
}
