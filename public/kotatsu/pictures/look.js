/**
 * Pictures v0 — the card-portable look (docs/pictures-v0.md §4, contract §13.3).
 *
 * A card's look is `data.extensions.kotatsu.picture = { positive, negative, tongue, reference }`
 * (contract `CARD_LOOK_PATH`), beside the narrator role flag in the same Kotatsu bag. It travels
 * with the card file, which is the whole point: stock kept the same text in
 * `extension_settings.sd.character_prompts`, keyed by file name, and it stayed behind whenever a
 * card was shared.
 *
 * Saves go through core's `/api/characters/merge-attributes`, which deep-merges server-side
 * (`src/endpoints/characters.js` `mergeCharacterUpdate`), so the rest of the bag (the narrator
 * flag) is never touched. The in-memory card is refreshed the way core's own
 * `writeExtensionField()` (`scripts/extensions.js`) does it: the object, its `json_data`, and the
 * stock form's `#character_json_data` when the card is the one open. That last one matters:
 * stock's edit route rebuilds the card from `json_data` (`charaFormatData`), so a stale copy in
 * the form would write the old look back on the next autosave.
 *
 * All five fields are always written ('' / [] = none), so a cleared field really clears: a deep merge
 * keeps any key the update leaves out (and replaces an array whole, `util.js` `deepMerge`).
 */

import { characters, getRequestHeaders, this_chid } from '../../script.js';
import { CARD_LOOK_PATH } from './contract.js';
import { normalizeLoras } from './picture-model.js';

/** @typedef {import('./contract.js').CardLook} CardLook */

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * A look in its stored shape: four strings and the LoRA list, nothing else.
 * @param {Partial<CardLook>|null|undefined} look
 * @returns {{ positive: string, negative: string, tongue: string, reference: string, loras: import('./contract.js').LoraChoice[] }}
 */
export function normalizeLook(look) {
    return {
        positive: text(look?.positive).trim(),
        negative: text(look?.negative).trim(),
        tongue: text(look?.tongue).trim(),
        reference: text(look?.reference).trim(),
        loras: normalizeLoras(look?.loras),
    };
}

/**
 * @param {CardLook|null|undefined} look
 * @returns {boolean} Whether there is no text and no LoRA in it (a reference alone is not a look).
 */
export function isLookEmpty(look) {
    return !look || (!text(look.positive).trim() && !text(look.negative).trim() && !normalizeLoras(look.loras).length);
}

/**
 * The card's look, or null when it has none.
 * @param {any} character A core character record (shallow records carry the Kotatsu bag too,
 *   `characters.js` `/all`).
 * @returns {CardLook|null}
 */
export function getLook(character) {
    /** @type {any} */
    let node = character;
    for (const key of CARD_LOOK_PATH) {
        node = node && typeof node === 'object' ? node[key] : undefined;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    return normalizeLook(node);
}

/**
 * The card's full-size art, the url the scenes draw portraits from (`k-scene-studio.js`).
 * @param {any} character
 * @returns {string} '' when the card has no avatar file.
 */
export function cardArtUrl(character) {
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    return avatar && avatar !== 'none' ? `/characters/${encodeURIComponent(avatar)}` : '';
}

/**
 * A blank look for a card: no text, its own art as the reference.
 * @param {any} character
 * @returns {CardLook}
 */
export function defaultLookFor(character) {
    return { positive: '', negative: '', tongue: '', reference: cardArtUrl(character), loras: [] };
}

/**
 * Sets `path` on `target`, creating plain objects on the way.
 * @param {any} target
 * @param {ReadonlyArray<string>} path
 * @param {any} value
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
 * Brings the in-memory card in line with what the server now holds.
 * @param {any} character
 * @param {ReturnType<typeof normalizeLook>} look
 */
function refreshInMemory(character, look) {
    setPath(character, CARD_LOOK_PATH, { ...look });
    if (typeof character.json_data === 'string' && character.json_data) {
        try {
            const json = JSON.parse(character.json_data);
            setPath(json, CARD_LOOK_PATH, { ...look });
            character.json_data = JSON.stringify(json);
            const open = this_chid !== undefined && Array.isArray(characters) ? characters[Number(this_chid)] : null;
            if (open === character) {
                const field = document.getElementById('character_json_data');
                if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) field.value = character.json_data;
            }
        } catch (error) {
            console.warn('[Pictures] the card\'s json_data did not parse; only the record was refreshed', error);
        }
    }
}

/**
 * Writes a card's look into the card file.
 * @param {any} character A core character record (the object in `characters[]`).
 * @param {Partial<CardLook>} look
 * @returns {Promise<CardLook>} What was saved.
 */
export async function saveLook(character, look) {
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    if (!avatar) throw new Error('This card has no file to save a look into.');
    const clean = normalizeLook(look);
    /** @type {Record<string, any>} */
    const data = {};
    setPath(data, CARD_LOOK_PATH.slice(1), clean);
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, data }),
    });
    if (!response.ok) {
        throw new Error(`The look could not be saved (${response.status}).`);
    }
    refreshInMemory(character, clean);
    return clean;
}
