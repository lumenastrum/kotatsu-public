/**
 * Sprites — reading a character's sprite set (Pictures slice F).
 *
 * Storage is stock's: `characters/<folder>/<label>.png` through `GET /api/sprites/get`
 * (`src/endpoints/sprites.js`), so a stock pack works unchanged and a set made here works in stock.
 * The folder is stock's rule too (`expressions/index.js` `getSpriteFolderName`): the character's
 * name, unless `extension_settings.expressionOverrides` maps the card's avatar file to another
 * folder. Read here rather than imported: the stock module has load-time side effects.
 */

import { getRequestHeaders } from '../../script.js';
import { extension_settings } from '../../scripts/extensions.js';

/**
 * @typedef {object} SpriteSet
 * @property {string} folder
 * @property {Map<string, string>} labels label → image url (the label's main file)
 */

/** @type {Map<string, Promise<SpriteSet>>} */
const cache = new Map();

/**
 * The sprite folder for a character, stock's rule.
 * @param {{name?: string, avatar?: string} | null | undefined} character a `characters[]` entry
 * @returns {string} '' when there is no character
 */
export function spriteFolderFor(character) {
    const name = typeof character?.name === 'string' ? character.name : '';
    if (!name) return '';
    const avatarBase = typeof character?.avatar === 'string' ? character.avatar.replace(/\.[^/.]+$/, '') : '';
    const overrides = Array.isArray(extension_settings?.expressionOverrides) ? extension_settings.expressionOverrides : [];
    const override = avatarBase ? overrides.find(entry => entry?.name === avatarBase) : null;
    return typeof override?.path === 'string' && override.path ? override.path : name;
}

/**
 * Groups the route's answer (`[{label, path}]`, several files per label allowed: `joy.png`,
 * `joy-2.png`) into one url per label, preferring the file named exactly after the label.
 * @param {unknown} answer
 * @returns {Map<string, string>}
 */
export function labelsFromAnswer(answer) {
    /** @type {Map<string, string>} */
    const labels = new Map();
    if (!Array.isArray(answer)) return labels;
    for (const sprite of answer) {
        const label = typeof sprite?.label === 'string' ? sprite.label.toLowerCase() : '';
        const url = typeof sprite?.path === 'string' ? sprite.path : '';
        if (!label || !url) continue;
        const file = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '').replace(/\.[^/.]+$/, '').toLowerCase();
        if (!labels.has(label) || file === label) labels.set(label, url);
    }
    return labels;
}

/**
 * A folder's set, fetched once and cached until {@link forgetSpriteSet}.
 * @param {string} folder
 * @returns {Promise<SpriteSet>} an empty set when the folder is missing or the read fails
 */
export function readSpriteSet(folder) {
    const key = String(folder ?? '');
    if (!key) return Promise.resolve({ folder: '', labels: new Map() });
    const known = cache.get(key);
    if (known) return known;
    const pending = (async () => {
        try {
            const response = await fetch(`/api/sprites/get?name=${encodeURIComponent(key)}`);
            return { folder: key, labels: labelsFromAnswer(response.ok ? await response.json() : []) };
        } catch {
            return { folder: key, labels: new Map() };
        }
    })();
    cache.set(key, pending);
    return pending;
}

/**
 * A character's set (the full body, or whatever framing a hand-made set is drawn in).
 * @param {{name?: string, avatar?: string} | null | undefined} character
 * @returns {Promise<SpriteSet>}
 */
export function spriteSetFor(character) {
    return readSpriteSet(spriteFolderFor(character));
}

/**
 * A card's second framing lives in a subfolder of its sprite folder (stock's sprite-pack convention, so stock and
 * other extensions still see one clean set): the full body is the folder itself, the bust is `<folder>/bust`.
 */
export const BUST_SUBFOLDER = 'bust';

/**
 * @param {string} folder a sprite folder
 * @returns {string} its bust folder ('' when there is no folder)
 */
export function bustFolderOf(folder) {
    return folder ? `${folder}/${BUST_SUBFOLDER}` : '';
}

/**
 * Both of a character's sets.
 * @param {{name?: string, avatar?: string} | null | undefined} character
 * @returns {Promise<{full: SpriteSet, bust: SpriteSet}>}
 */
export async function spriteSetsFor(character) {
    const folder = spriteFolderFor(character);
    const [full, bust] = await Promise.all([readSpriteSet(folder), readSpriteSet(bustFolderOf(folder))]);
    return { full, bust };
}

/**
 * Drops a cached set (after an upload or delete), or all of them.
 * @param {string} [folder]
 * @returns {void}
 */
export function forgetSpriteSet(folder) {
    if (folder === undefined) cache.clear();
    else cache.delete(String(folder));
}

/** Fired on `document` after a folder's sprites change; `detail.folder`. */
export const SPRITES_EVENT = 'kotatsu:sprites-changed';

/**
 * @param {string} folder
 * @returns {void}
 */
function changed(folder) {
    forgetSpriteSet(folder);
    document.dispatchEvent(new CustomEvent(SPRITES_EVENT, { detail: { folder } }));
}

/**
 * After something wrote both framings of a folder (the generator's save): forgets both sets and tells the stage.
 * @param {string} folder the card's sprite folder (the full body; its bust subfolder is included)
 * @returns {void}
 */
export function refreshSpriteSets(folder) {
    if (!folder) return;
    changed(folder);
    changed(bustFolderOf(folder));
}

/**
 * Uploads one expression's sprite (stock's route: replaces the label's file, keeps its other files).
 * @param {string} folder
 * @param {string} label
 * @param {Blob} file a PNG / WebP / GIF
 * @param {string} [fileName]
 * @returns {Promise<void>}
 */
export async function uploadSprite(folder, label, file, fileName = `${label}.png`) {
    const form = new FormData();
    form.set('name', folder);
    form.set('label', label);
    form.set('avatar', file, fileName);
    const response = await fetch('/api/sprites/upload', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
    if (!response.ok) throw new Error(`The sprite could not be uploaded (${response.status}).`);
    changed(folder);
}

/**
 * Deletes one expression's main sprite file.
 * @param {string} folder
 * @param {string} label
 * @returns {Promise<void>}
 */
export async function deleteSprite(folder, label) {
    const response = await fetch('/api/sprites/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: folder, label }) });
    if (!response.ok) throw new Error(`The sprite could not be deleted (${response.status}).`);
    changed(folder);
}

/**
 * Imports a sprite pack: a ZIP of `<label>.png` files (stock's format; existing labels are replaced).
 * @param {string} folder
 * @param {Blob} zip
 * @param {string} [fileName]
 * @returns {Promise<void>}
 */
export async function uploadSpritePack(folder, zip, fileName = 'sprites.zip') {
    const form = new FormData();
    form.set('name', folder);
    form.set('avatar', zip, fileName);
    const response = await fetch('/api/sprites/upload-zip', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
    if (!response.ok) throw new Error(`The pack could not be imported (${response.status}).`);
    changed(folder);
}
