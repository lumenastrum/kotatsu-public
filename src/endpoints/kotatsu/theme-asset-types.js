/**
 * The files a theme pack may use, by extension, and the type each is served as. One list for the
 * server (themes.js serves nothing else from a user pack) and for `npm run theme:check` (which
 * fails a pack pointing at anything else, instead of letting it 404 in the app: a missing sheet
 * drops the whole pack). Pure data, no imports, so the scripts can load it.
 */

/** @type {Readonly<Record<string, string>>} */
export const FONT_TYPES = Object.freeze({
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
});

/** @type {Readonly<Record<string, string>>} */
export const IMAGE_TYPES = Object.freeze({
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
});

/** @type {Readonly<Record<string, string>>} */
export const SHEET_TYPES = Object.freeze({
    '.css': 'text/css; charset=utf-8',
});

/** @type {Readonly<Record<string, string>>} */
export const ASSET_TYPES = Object.freeze({ ...FONT_TYPES, ...IMAGE_TYPES, ...SHEET_TYPES });
