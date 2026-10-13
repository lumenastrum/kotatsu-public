/**
 * Sprites — a character's framing knobs (Pictures slice F, step 4), stored WITH THE CARD so they
 * travel when it is shared: `data.extensions.kotatsu.sprites = { scale, offset, faceY, faceZoom, pin }`.
 *
 * - `pin`    which framing the stage shows when the card has two sets (`auto` | `bust` | `full`; stage-model's
 *            `pickFraming`). `auto` = bust in Stage / Duet, full body in the Wings.
 *
 * - `scale`  height on stage, × the fitted height (1 = as drawn). Height-fitting alone does not make
 *            characters the same size (prototype v5: Velina's heavier build loomed at 1, sat right at 0.82).
 * - `offset` vertical shift on stage, as a fraction of the figure's height (+ = down).
 * - `faceY`  where the face sits in the sprite, as a fraction of its height from the top: the face
 *            chips (rows, bench, phone spotlight) crop there. The fixed 3 % showed only hair on sprites
 *            whose head sits at the canvas top or under big hair (step 3, Aemeath and Cissia).
 * - `faceZoom` how far the face chips zoom, × the chip's width (3 = the sprite drawn 3× the chip).
 *
 * Saved through `/api/characters/merge-attributes` (a server-side deep merge), and the in-memory card
 * refreshed the way `pictures/look.js` does it, the form's `#character_json_data` included, so an
 * autosave never writes the old knobs back.
 */

import { characters, getRequestHeaders, this_chid } from '../../script.js';
import { FRAMING_PINS } from './stage-model.js';

/** Where the knobs live on a card. */
export const FRAMING_PATH = Object.freeze(['data', 'extensions', 'kotatsu', 'sprites']);

/** Fired on `document` after a card's knobs change; `detail.avatar`. */
export const FRAMING_EVENT = 'kotatsu:sprite-framing';

/** @typedef {{scale: number, offset: number, faceY: number, faceZoom: number, pin: string}} Framing */
/** @typedef {'scale' | 'offset' | 'faceY' | 'faceZoom'} FramingKnob   the numeric knobs (the studio's sliders) */

/** @type {Readonly<Framing>} */
export const DEFAULT_FRAMING = Object.freeze({ scale: 1, offset: 0, faceY: 0.03, faceZoom: 3, pin: 'auto' });

/** The knobs' ranges (the studio's sliders use them; anything stored outside is clamped). */
export const FRAMING_RANGE = Object.freeze({
    scale: Object.freeze({ min: 0.5, max: 1.5, step: 0.01 }),
    offset: Object.freeze({ min: -0.3, max: 0.3, step: 0.005 }),
    faceY: Object.freeze({ min: 0, max: 0.5, step: 0.005 }),
    faceZoom: Object.freeze({ min: 1.5, max: 6, step: 0.05 }),
});

/**
 * @param {unknown} value
 * @param {{min: number, max: number}} range
 * @param {number} fallback
 */
function clampNumber(value, range, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(range.max, Math.max(range.min, number));
}

/**
 * @param {unknown} raw anything stored on a card
 * @returns {Framing}
 */
export function normalizeFraming(raw) {
    const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    return {
        scale: clampNumber(source.scale, FRAMING_RANGE.scale, DEFAULT_FRAMING.scale),
        offset: clampNumber(source.offset, FRAMING_RANGE.offset, DEFAULT_FRAMING.offset),
        faceY: clampNumber(source.faceY, FRAMING_RANGE.faceY, DEFAULT_FRAMING.faceY),
        faceZoom: clampNumber(source.faceZoom, FRAMING_RANGE.faceZoom, DEFAULT_FRAMING.faceZoom),
        pin: FRAMING_PINS.includes(/** @type {string} */ (source.pin)) ? /** @type {string} */ (source.pin) : DEFAULT_FRAMING.pin,
    };
}

/**
 * @param {any} character a `characters[]` entry
 * @returns {Framing}
 */
export function readFraming(character) {
    let node = character;
    for (const key of FRAMING_PATH) node = node?.[key];
    return normalizeFraming(node);
}

/**
 * The CSS custom properties a face chip uses for this framing.
 * @param {Framing} framing
 * @returns {string} a style fragment
 */
export function faceStyle(framing) {
    return `--k-sprite-face-y:${(framing.faceY * 100).toFixed(1)}%;--k-sprite-face-zoom:${(framing.faceZoom * 100).toFixed(0)}%;`;
}

/**
 * @param {Record<string, any>} target
 * @param {readonly string[]} path
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
 * Writes a card's knobs into the card file and refreshes the in-memory card.
 * @param {any} character a `characters[]` entry
 * @param {Partial<Framing>} framing
 * @returns {Promise<Framing>} what was saved
 */
export async function saveFraming(character, framing) {
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    if (!avatar) throw new Error('This card has no file to save the framing into.');
    const clean = normalizeFraming({ ...readFraming(character), ...framing });
    /** @type {Record<string, any>} */
    const data = {};
    setPath(data, FRAMING_PATH.slice(1), clean);
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar, data }),
    });
    if (!response.ok) throw new Error(`The framing could not be saved (${response.status}).`);
    setPath(character, FRAMING_PATH, { ...clean });
    if (typeof character.json_data === 'string' && character.json_data) {
        try {
            const json = JSON.parse(character.json_data);
            setPath(json, FRAMING_PATH, { ...clean });
            character.json_data = JSON.stringify(json);
            const open = this_chid !== undefined && Array.isArray(characters) ? characters[Number(this_chid)] : null;
            if (open === character) {
                const field = document.getElementById('character_json_data');
                if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) field.value = character.json_data;
            }
        } catch (error) {
            console.warn('[Sprites] the card\'s json_data did not parse; only the record was refreshed', error);
        }
    }
    document.dispatchEvent(new CustomEvent(FRAMING_EVENT, { detail: { avatar } }));
    return clean;
}
