/**
 * The Sprite view's backdrop, as data (docs/stage-backdrop-v0.md). Pure: backdrop.js reads the
 * chat and core's background keys, this decides what they mean, and Jest drives it directly.
 *
 * A backdrop is core's own per-chat background, not a new store: `chat_metadata.custom_background`
 * holds the locked CSS url and `chat_metadata.chat_backgrounds` lists the chat's images
 * (scripts/backgrounds.js), so a backdrop picked here is the chat's locked background in classic
 * too, and `/lockbg` / `/unlockbg` keep working on it. Under rails it is painted only in the
 * Sprite view (Andres, 2026-10-22: a stage set for the VN; the reading looks keep the pack's calm
 * backdrop).
 */

/** The purpose a generated picture of surroundings carries (pictures/contract.js PURPOSES.PLACE). */
export const PLACE = 'place';

/**
 * One spelling per image. Core's own upload (`saveBase64AsFile`, utils.js) answers
 * `/user/images/…` with a leading slash while Pictures stores `user/images/…`; both are the same
 * file under the page's `<base href="/">`, so paths are compared without it.
 * @param {unknown} path
 * @returns {string}
 */
export function normalPath(path) {
    return String(path ?? '').replace(/^\/+/, '');
}

/**
 * A path as core writes a chat background into `custom_background`
 * (`generateUrlParameter(bg, true)`, scripts/backgrounds.js).
 * @param {string} path e.g. `user/images/Seraphina/20261022-1830-42.png`
 * @returns {string}
 */
export function cssUrl(path) {
    return `url("${encodeURI(path)}")`;
}

/**
 * The path inside a locked background's CSS url, or '' when there is none or it isn't one.
 * @param {unknown} value `chat_metadata.custom_background`
 * @returns {string}
 */
export function pathOf(value) {
    const match = /^url\((["']?)(.*)\1\)$/.exec(String(value ?? '').trim());
    if (!match) return '';
    try {
        return normalPath(decodeURI(match[2]));
    } catch {
        return normalPath(match[2]);
    }
}

/**
 * @typedef {object} BackdropChoice
 * @property {string} path The image's path, as core stores it.
 * @property {'picture'|'upload'} from A picture generated in this chat, or an image added as a background.
 * @property {boolean} place Generated as "The place" (surroundings, no people): offered first.
 * @property {boolean} current The chat's backdrop now.
 */

/**
 * Every image this chat can use as its backdrop, newest first, pictures of a place before the rest,
 * each path once. Videos and images that aren't on this server (a pasted https URL) are left out:
 * a backdrop has to be a still the server can serve.
 * @param {{ messages: ReadonlyArray<any>, chatBackgrounds: unknown, locked: unknown }} facts
 *   `chat`; `chat_metadata.chat_backgrounds`; `chat_metadata.custom_background`.
 * @returns {BackdropChoice[]}
 */
export function backdropChoices({ messages, chatBackgrounds, locked }) {
    const current = pathOf(locked);
    /** @type {Map<string, BackdropChoice>} */
    const seen = new Map();
    /** @param {string} raw @param {'picture'|'upload'} from @param {boolean} place */
    const add = (raw, from, place) => {
        const path = normalPath(raw);
        if (!isServedImage(path) || seen.has(path)) return;
        seen.set(path, { path, from, place, current: path === current });
    };
    for (let index = messages.length - 1; index >= 0; index--) {
        const media = messages[index]?.extra?.media;
        if (!Array.isArray(media)) continue;
        for (let item = media.length - 1; item >= 0; item--) {
            const entry = media[item];
            if (entry?.type !== 'image' || typeof entry.url !== 'string') continue;
            add(entry.url, 'picture', entry.generation_type === PLACE);
        }
    }
    const list = Array.isArray(chatBackgrounds) ? chatBackgrounds : [];
    for (let index = list.length - 1; index >= 0; index--) {
        if (typeof list[index] === 'string') add(list[index], 'upload', false);
    }
    // A locked background from elsewhere (classic's global list, `/lockbg`) is still the current one.
    if (current && !seen.has(current) && isServedImage(current)) seen.set(current, { path: current, from: 'upload', place: false, current: true });
    return [...seen.values()].sort((a, b) => Number(b.place) - Number(a.place));
}

/**
 * Whether a path is an image the server serves from the user's data (not a data: URI, not another site).
 * @param {string} path
 * @returns {boolean}
 */
export function isServedImage(path) {
    return /^(user\/images|backgrounds)\//.test(normalPath(path)) && /\.(png|jpe?g|webp|gif|avif)$/i.test(path);
}
