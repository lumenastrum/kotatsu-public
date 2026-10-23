/**
 * The card's tagline: `data.extensions.kotatsu_title`, the AUTHORED first link of the library
 * epithet chain (`library/epithet.js`). Before v2 nothing wrote it, so every card's library
 * kicker was borrowed from the first sentence of its creator's notes; Card Studio v2's hero gives
 * it a field (`docs/card-studio-v2.md` §Hero).
 *
 * Saved exactly the way the picture Look is (`pictures/look.js` `saveLook`): `/merge-attributes`
 * writes the one path into the card file, the in-memory record follows, and so does
 * `#character_json_data` — the stock submit that runs right after sends `json_data`, and a stale
 * one would write the old tagline straight back.
 */

import { characters, getRequestHeaders, this_chid } from '../../script.js';

/** Where the tagline lives in a card (`data.extensions.kotatsu_title`). */
export const TAGLINE_PATH = Object.freeze(['data', 'extensions', 'kotatsu_title']);

/** The library kicker's own limit (`library/epithet.js` EPITHET_MAX): past it the poster truncates. */
export const TAGLINE_MAX = 64;

/**
 * @param {any} character A core character record.
 * @returns {string} The authored tagline, or ''.
 */
export function getTagline(character) {
    const value = character?.data?.extensions?.kotatsu_title;
    return typeof value === 'string' ? value : '';
}

/**
 * @param {Record<string, any>} target
 * @param {ReadonlyArray<string>} path
 * @param {unknown} value
 */
function setPath(target, path, value) {
    let node = target;
    for (const key of path.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
    }
    node[path[path.length - 1]] = value;
}

/**
 * Writes the tagline into the card file.
 * @param {any} character A core character record (the object in `characters[]`).
 * @param {string} text Trimmed before saving; '' clears it, and the library goes back to borrowing.
 * @returns {Promise<string>} What was saved.
 */
export async function saveTagline(character, text) {
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    if (!avatar) throw new Error('This card has no file to save a tagline into.');
    const clean = String(text ?? '').trim();
    /** @type {Record<string, any>} */
    const data = {};
    setPath(data, TAGLINE_PATH.slice(1), clean);
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, data }),
    });
    if (!response.ok) {
        throw new Error(`The tagline could not be saved (${response.status}).`);
    }
    setPath(character, TAGLINE_PATH, clean);
    if (typeof character.json_data === 'string' && character.json_data) {
        try {
            const json = JSON.parse(character.json_data);
            setPath(json, TAGLINE_PATH, clean);
            character.json_data = JSON.stringify(json);
            const open = this_chid !== undefined && Array.isArray(characters) ? characters[Number(this_chid)] : null;
            if (open === character) {
                const field = document.getElementById('character_json_data');
                if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) field.value = character.json_data;
            }
        } catch (error) {
            console.warn('[k-card-studio] the card\'s json_data did not parse; only the record was refreshed', error);
        }
    }
    return clean;
}
