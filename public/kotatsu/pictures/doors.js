/**
 * Pictures v0, slice B — the doors to the other slices' modules and to shared client state.
 *
 * Slice C ships `settings.js` (the `power_user.kotatsu_pictures` leaf), `writer.js` (the prompt
 * writer) and `look.js` (the card's look) in parallel with this slice. Each is reached through a
 * dynamic import with a fallback, so the sheet works before C lands (contract §13.3: `draft`
 * returns the free text, settings are `DEFAULT_SETTINGS` held in memory) and picks C up the
 * moment the files exist, with no edit here. The specifiers live in constants so the type
 * checker treats the imports as dynamic (the rails layout's pattern for modules that may not
 * exist yet).
 */

import { characters, this_chid } from '../../script.js';
import { selected_group } from '../../scripts/group-chats.js';
import { SECRET_KEYS, secret_state } from '../../scripts/secrets.js';
import { DEFAULT_SETTINGS, LANES } from './contract.js';

const SETTINGS_MODULE = './settings.js';
const WRITER_MODULE = './writer.js';
const LOOK_MODULE = './look.js';

/** @type {Map<string, Promise<any|null>>} */
const modules = new Map();

/**
 * @param {string} specifier
 * @returns {Promise<any|null>} The module, or null when it is not there (yet).
 */
function optionalModule(specifier) {
    let pending = modules.get(specifier);
    if (!pending) {
        pending = import(specifier).catch(() => null);
        modules.set(specifier, pending);
    }
    return pending;
}

/** @type {import('./contract.js').PicturesSettings|null} In-memory settings until slice C lands. */
let memorySettings = null;

/**
 * @returns {import('./contract.js').PicturesSettings}
 */
function memoryCopy() {
    memorySettings ??= structuredClone(/** @type {any} */ (DEFAULT_SETTINGS));
    return /** @type {import('./contract.js').PicturesSettings} */ (memorySettings);
}

/**
 * The Pictures settings leaf, defaults filled in.
 * @returns {Promise<import('./contract.js').PicturesSettings>}
 */
export async function picturesSettings() {
    const mod = await optionalModule(SETTINGS_MODULE);
    if (typeof mod?.getPicturesSettings === 'function') {
        try {
            const value = mod.getPicturesSettings();
            if (value && typeof value === 'object') {
                return { ...structuredClone(/** @type {any} */ (DEFAULT_SETTINGS)), ...value };
            }
        } catch (error) {
            console.warn('[Pictures] settings could not be read; using the defaults', error);
        }
    }
    return memoryCopy();
}

/**
 * Writes part of the settings leaf (C debounces the save). Before C lands it only lives for the session.
 * @param {Partial<import('./contract.js').PicturesSettings>} patch
 * @returns {Promise<void>}
 */
export async function updatePicturesSettings(patch) {
    const mod = await optionalModule(SETTINGS_MODULE);
    if (typeof mod?.updatePicturesSettings === 'function') {
        try {
            await mod.updatePicturesSettings(patch);
            return;
        } catch (error) {
            console.warn('[Pictures] settings could not be saved', error);
            return;
        }
    }
    Object.assign(memoryCopy(), structuredClone(patch));
}

/**
 * The writer's draft. Without slice C: the free text as typed, no negative.
 * @param {Parameters<import('./contract.js').DraftFn>[0]} args
 * @returns {Promise<{prompt: string, negative: string, drafted: boolean}>} `drafted` false = fallback.
 */
export async function draftPrompt(args) {
    const mod = await optionalModule(WRITER_MODULE);
    if (typeof mod?.draft === 'function') {
        const result = await mod.draft(args);
        return { prompt: String(result?.prompt ?? ''), negative: String(result?.negative ?? ''), drafted: true };
    }
    return { prompt: String(args?.free ?? ''), negative: '', drafted: false };
}

/**
 * Whether the real writer is present (the sheet words its prompt hint by it).
 * @returns {Promise<boolean>}
 */
export async function hasWriter() {
    const mod = await optionalModule(WRITER_MODULE);
    return typeof mod?.draft === 'function';
}

/**
 * The card's look, when slice C's `look.js` is there.
 * @param {any} character A `characters[]` entry.
 * @returns {Promise<import('./contract.js').CardLook|null>}
 */
export async function lookOf(character) {
    if (!character) return null;
    const mod = await optionalModule(LOOK_MODULE);
    if (typeof mod?.getLook !== 'function') return null;
    try {
        return (await mod.getLook(character)) ?? null;
    } catch {
        return null;
    }
}

/** @type {string} A picture the tile menu marked "Use as reference", for the sheet's next job. */
let pendingReference = '';

/** @returns {string} */
export function getPendingReference() {
    return pendingReference;
}

/** @param {string} url `''` clears it. */
export function setPendingReference(url) {
    pendingReference = typeof url === 'string' ? url : '';
}

/** @returns {boolean} Whether the rails layout is up (every Pictures surface is rails-only). */
export function railsActive() {
    return document.body?.dataset.kLayout === 'rails';
}

/**
 * The character a picture is about: a message's speaker when it names one, else the open card.
 * @param {any} [message] A `chat[]` entry.
 * @returns {any|null} A `characters[]` entry.
 */
export function characterFor(message) {
    const list = Array.isArray(characters) ? characters : [];
    if (message && !message.is_user && typeof message.original_avatar === 'string') {
        const speaker = list.find(c => c?.avatar === message.original_avatar);
        if (speaker) return speaker;
    }
    if (this_chid !== undefined && list[Number(this_chid)]) return list[Number(this_chid)];
    return null;
}

/**
 * The folder under `user/images/` this chat's pictures go to: the group id in a scene, the
 * character's name otherwise (the stock extension's rule).
 * @returns {string}
 */
export function imagesFolder() {
    if (selected_group) return String(selected_group);
    const list = Array.isArray(characters) ? characters : [];
    return String(list[Number(this_chid)]?.name ?? '');
}

/**
 * Toasts through core's toastr when it is there.
 * @param {'info'|'success'|'warning'|'error'} kind
 * @param {string} message
 * @returns {void}
 */
export function toast(kind, message) {
    const toastr = /** @type {any} */ (globalThis).toastr;
    if (toastr && typeof toastr[kind] === 'function') toastr[kind](message);
}

/**
 * A key lane the person could draw with right now (§14.6): a stored Google AI Studio key (Gemini)
 * first, then an OpenAI key. Core's secret state says whether a key exists, never the key itself.
 * @returns {{lane: string, label: string}|null}
 */
export function storedKeyLane() {
    const has = (/** @type {string} */ key) => {
        const value = /** @type {any} */ (secret_state)?.[key];
        return Array.isArray(value) ? value.length > 0 : !!value;
    };
    if (has(SECRET_KEYS.MAKERSUITE)) return { lane: LANES.GEMINI, label: 'Gemini' };
    if (has(SECRET_KEYS.OPENAI)) return { lane: LANES.OPENAI, label: 'OpenAI' };
    return null;
}
