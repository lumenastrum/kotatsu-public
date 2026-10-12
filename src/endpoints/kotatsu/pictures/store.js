import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';

/**
 * Where finished pictures land (docs/pictures-v0.md §13.2): `user/images/<character>/` — the
 * folder stock's gallery reads — as `<yyyymmdd-hhmmss>-<seed>[-n].<ext>`, bytes exactly as the
 * lane produced them (a ComfyUI PNG keeps its workflow and prompt tEXt chunks). The url handed
 * back is the stock-relative form `user/images/<character>/<file>`, which is what
 * `extra.media[].url` holds for stock-generated pictures.
 */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);

/**
 * The folder name for a character, sanitized the way `/api/images/upload` does (`images.js`).
 * @param {unknown} character Character name from the request
 * @returns {string} Folder name ('' when nothing usable is left)
 */
export function characterFolder(character) {
    return sanitize(String(character ?? '')).trim();
}

/**
 * @param {Date} date When
 * @returns {string} Local `yyyymmdd-hhmmss`
 */
export function timestamp(date) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * @param {string} filename A lane's filename (e.g. ComfyUI's `Kotatsu_00012_.png`)
 * @returns {string} The extension to keep, lowercase; `png` when unknown
 */
export function imageExtension(filename) {
    const ext = path.extname(String(filename ?? '')).slice(1).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext) ? ext : 'png';
}

/**
 * Writes one picture without overwriting anything. The first image of a job is
 * `<stamp>-<seed>.<ext>`; later ones (and name collisions) get `-2`, `-3`, ….
 * @param {object} params Inputs
 * @param {string} params.userImages `request.user.directories.userImages`
 * @param {string} params.character Character name (sanitized here)
 * @param {number} params.seed Seed of the job
 * @param {Buffer|Uint8Array} params.bytes Image bytes, written untouched
 * @param {string} [params.ext] Extension (default png)
 * @param {Date} [params.date] Stamp time (default now)
 * @param {number} [params.index] 0-based image index within the job
 * @returns {Promise<{url: string, file: string, filename: string}>} The url, absolute path and file name
 */
export async function saveImage({ userImages, character, seed, bytes, ext = 'png', date = new Date(), index = 0 }) {
    const folder = characterFolder(character);
    if (!folder) throw new Error('The character name leaves no usable folder name');
    const directory = path.join(userImages, folder);
    await fs.promises.mkdir(directory, { recursive: true });
    const stem = `${timestamp(date)}-${seed}`;
    const extension = IMAGE_EXTENSIONS.has(ext) ? ext : 'png';
    for (let n = index + 1; ; n++) {
        const filename = sanitize(n === 1 ? `${stem}.${extension}` : `${stem}-${n}.${extension}`);
        const file = path.join(directory, filename);
        try {
            // 'wx' fails when the file exists, so two jobs finishing in the same second never clobber.
            await fs.promises.writeFile(file, bytes, { flag: 'wx' });
            return { url: `user/images/${folder}/${filename}`, file, filename };
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
        }
    }
}
