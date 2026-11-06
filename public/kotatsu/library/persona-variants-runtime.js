/**
 * Persona variants, wired to core — `docs/persona-gallery-v0.md` §7.
 *
 * The only file that reads core for variants. `persona-variants.js` stays pure; this reads
 * what is open into a {@link VariantContext}, reads and writes the descriptor's
 * `kotatsu_variants`, and registers the composer core calls at prompt time
 * (`registerPersonaDescriptionComposer`, power-user.js — the seam reads through
 * `getActivePersonaDescription()` in the four places core puts the persona in a prompt).
 *
 * Installed from `initKotatsuShell()`, so it runs under BOTH layouts: variants are data on the
 * persona, and a reader who switches to classic keeps them. Only the editor is rails-only.
 *
 * Byte-identity: with no variants, or none on here, the composer returns core's description
 * UNTOUCHED (not trimmed, not rejoined), so every existing prompt is exactly what it was.
 */

import { characters, chat, getCurrentChatId, saveSettingsDebounced, this_chid } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { groups, selected_group } from '../../scripts/group-chats.js';
import { user_avatar } from '../../scripts/personas.js';
import { power_user, registerPersonaDescriptionComposer } from '../../scripts/power-user.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../scripts/popup.js';
import { accountStorage } from '../../scripts/util/AccountStorage.js';
import { flipChangesHere, flipConfirmCopy, positionIsCached } from './variant-cache.js';
import { isNarratorCard } from '../groups/narrator.js';
import {
    FORMAT_KEY,
    VARIANTS_KEY,
    activeItems,
    cloneWithFreshIds,
    composeDescription,
    isDefaultFormat,
    normalizeFormat,
    normalizeVariants,
} from './persona-variants.js';

/** @typedef {import('./persona-variants.js').PersonaVariant} PersonaVariant */
/** @typedef {import('./persona-variants.js').VariantContext} VariantContext */
/** @typedef {import('./persona-variants.js').VariantFormat} VariantFormat */

/** Raised on `document` after a write, so an open editor and the gallery can re-read. */
export const VARIANTS_CHANGED_EVENT = 'k-persona-variants-changed';

/**
 * @param {any} character A `characters[]` entry.
 * @returns {string} Its name and description, for `match`.
 */
function cardText(character) {
    if (!character) return '';
    const description = character.description ?? character.data?.description ?? '';
    return `${character.name ?? ''}\n${description}`;
}

/**
 * What is open, as plain data.
 * @returns {VariantContext} The context.
 */
export function readVariantContext() {
    const chatId = String(getCurrentChatId() ?? '');
    if (selected_group) {
        const group = groups.find(entry => entry?.id === selected_group);
        const members = Array.isArray(group?.members) ? group.members.filter(member => typeof member === 'string') : [];
        const cards = members.map(member => characters.find(character => character?.avatar === member)).filter(Boolean);
        return {
            characterKeys: [`group:${selected_group}`, ...members],
            chatId,
            cardText: cards.map(cardText).join('\n\n'),
        };
    }
    const character = this_chid !== undefined ? characters[Number(this_chid)] : null;
    return {
        characterKeys: character?.avatar ? [character.avatar] : [],
        chatId,
        cardText: cardText(character),
    };
}

/**
 * @param {string} [id] Avatar id; defaults to the persona you're wearing.
 * @returns {PersonaVariant[]} Its variants, normalized.
 */
export function readVariants(id = user_avatar) {
    return normalizeVariants(power_user?.persona_descriptions?.[id]?.[VARIANTS_KEY]);
}

/**
 * Writes a persona's variants onto its descriptor and saves. An empty list removes the key, so
 * a persona that never used variants carries nothing new in settings.json.
 * @param {string} id Avatar id.
 * @param {PersonaVariant[]} variants The full list, in order.
 * @returns {boolean} Whether there was a descriptor to write to.
 */
export function writeVariants(id, variants) {
    const descriptor = power_user?.persona_descriptions?.[id];
    if (!descriptor || typeof descriptor !== 'object') return false;
    // Plain, detached copies: the descriptor must never share arrays with the editor's state.
    const clean = JSON.parse(JSON.stringify(normalizeVariants(variants)));
    if (clean.length) descriptor[VARIANTS_KEY] = clean;
    else delete descriptor[VARIANTS_KEY];
    saveSettingsDebounced();
    document.dispatchEvent(new CustomEvent(VARIANTS_CHANGED_EVENT, { detail: { id } }));
    return true;
}

/**
 * Which of the wearing persona's variants are on right now.
 * @param {string} [id] Avatar id.
 * @param {VariantContext} [context] Defaults to what is open.
 * @returns {PersonaVariant[]} The active ones, in order.
 */
export function activeVariants(id = user_avatar, context = readVariantContext()) {
    return activeItems(readVariants(id), context);
}

/**
 * @param {string} [id] Avatar id; defaults to the persona you're wearing.
 * @returns {VariantFormat} Its joiner and wrapper, normalized.
 */
export function readFormat(id = user_avatar) {
    return normalizeFormat(power_user?.persona_descriptions?.[id]?.[FORMAT_KEY]);
}

/**
 * Writes a persona's joiner + wrapper. The default format removes the key.
 * @param {string} id Avatar id.
 * @param {VariantFormat} format The format.
 * @returns {boolean} Whether there was a descriptor to write to.
 */
export function writeFormat(id, format) {
    const descriptor = power_user?.persona_descriptions?.[id];
    if (!descriptor || typeof descriptor !== 'object') return false;
    const clean = normalizeFormat(format);
    if (isDefaultFormat(clean)) delete descriptor[FORMAT_KEY];
    else descriptor[FORMAT_KEY] = { ...clean };
    saveSettingsDebounced();
    document.dispatchEvent(new CustomEvent(VARIANTS_CHANGED_EVENT, { detail: { id } }));
    return true;
}

/**
 * The composer core calls (through `getActivePersonaDescription()`).
 * @param {string} description Core's description so far.
 * @returns {string} With the active variants folded in, or exactly what came in.
 */
export function composeForPrompt(description) {
    const variants = readVariants();
    if (!variants.length) return description;
    const context = readVariantContext();
    if (!activeItems(variants, context).length) return description;
    return composeDescription(description, variants, context, readFormat());
}

/**
 * Core's Duplicate copies the descriptor fields it knows and nothing else, but its
 * `PERSONA_CREATED` carries `duplicatedFromAvatarId` (personas.js duplicatePersona). So the copy
 * gets the source's variants (fresh ids) and format here, with no core edit.
 * @param {{ avatarId?: string, duplicatedFromAvatarId?: string }} data The event payload.
 * @returns {void}
 */
function onPersonaCreated(data) {
    const from = data?.duplicatedFromAvatarId;
    const to = data?.avatarId;
    if (!from || !to || from === to) return;
    const source = power_user?.persona_descriptions?.[from];
    const target = power_user?.persona_descriptions?.[to];
    if (!source || !target) return;
    const variants = normalizeVariants(source[VARIANTS_KEY]);
    if (variants.length) target[VARIANTS_KEY] = JSON.parse(JSON.stringify(cloneWithFreshIds(variants)));
    const format = normalizeFormat(source[FORMAT_KEY]);
    if (!isDefaultFormat(format)) target[FORMAT_KEY] = { ...format };
    // Core saves right after its own emit (`saveSettingsDebounced()` in duplicatePersona).
}

/**
 * Everyone a variant can be tied to, for the editor's picker: characters (narrator seats are
 * cards, not people) and scenes as `group:<id>`.
 * @returns {Array<{ key: string, name: string, kind: 'character'|'scene' }>} Sorted by name.
 */
export function variantTargets() {
    /** @type {Array<{ key: string, name: string, kind: 'character'|'scene' }>} */
    const out = [];
    for (const character of characters) {
        if (!character?.avatar || isNarratorCard(character)) continue;
        out.push({ key: character.avatar, name: String(character.name ?? character.avatar), kind: 'character' });
    }
    for (const group of groups) {
        if (!group?.id) continue;
        out.push({ key: `group:${group.id}`, name: String(group.name ?? group.id), kind: 'scene' });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string} key A character avatar or `group:<id>`.
 * @returns {string} Its name, `''` when it's gone.
 */
export function targetName(key) {
    if (key.startsWith('group:')) {
        const id = key.slice('group:'.length);
        return String(groups.find(group => group?.id === id)?.name ?? '');
    }
    return String(characters.find(character => character?.avatar === key)?.name ?? '');
}

/** @type {(() => void)|null} */
let unregister = null;

/** Registers the composer. Idempotent. Called from `initKotatsuShell()`. @returns {void} */
export function installPersonaVariants() {
    if (unregister) return;
    const off = registerPersonaDescriptionComposer(composeForPrompt);
    eventSource.on(event_types.PERSONA_CREATED, onPersonaCreated);
    unregister = () => {
        off();
        eventSource.removeListener(event_types.PERSONA_CREATED, onPersonaCreated);
    };
}

/** @returns {void} */
export function uninstallPersonaVariants() {
    unregister?.();
    unregister = null;
}

/* ── the mid-chat flip warning (docs/persona-gallery-v0.md §7.3) ──────────────── */

/** `accountStorage` key: `'off'` once the reader ticked "Don't ask me again". */
export const FLIP_WARNING_KEY = 'kotatsu-variant-flip-warning';

/** @returns {boolean} Whether to ask before a mid-chat flip. */
export function flipWarningsOn() {
    try {
        return accountStorage.getItem(FLIP_WARNING_KEY) !== 'off';
    } catch {
        return true;
    }
}

/** @param {boolean} on Ask again, or not. @returns {void} */
export function setFlipWarnings(on) {
    try {
        accountStorage.setItem(FLIP_WARNING_KEY, on ? 'on' : 'off');
    } catch {
        // A convenience; a storage that refuses it means the reader gets asked again.
    }
    document.dispatchEvent(new CustomEvent(VARIANTS_CHANGED_EVENT, { detail: { id: user_avatar } }));
}

/**
 * Asks before a flip that would make the next reply re-send the whole chat. Says nothing (and
 * answers yes) when the flip costs nothing: warnings off, a persona that isn't the one being
 * worn (it composes nothing), a persona placed in the moving part of the prompt, no chat or a
 * chat with nothing to re-send yet, or a variant that wouldn't fold in here either way.
 * @param {string} id The persona.
 * @param {string} variantId The variant or group about to flip.
 * @returns {Promise<boolean>} Whether to go ahead.
 */
export async function confirmVariantFlip(id, variantId) {
    if (!flipWarningsOn() || id !== user_avatar) return true;
    if (!positionIsCached(Number(power_user?.persona_description_position ?? 0))) return true;
    const context = readVariantContext();
    const messages = Array.isArray(chat) ? chat.length : 0;
    if (!context.chatId || messages < 2) return true;
    const variants = readVariants(id);
    if (!flipChangesHere(variants, variantId, context)) return true;
    const target = variants.flatMap(variant => [variant, ...variant.children]).find(variant => variant.id === variantId);
    const copy = flipConfirmCopy({ messages, turningOn: !target?.enabled });

    // Built as nodes, not an HTML string: the copy is ours, but nothing here should ever parse.
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = copy.title;
    const body = document.createElement('p');
    body.textContent = copy.body;
    content.append(title, body);

    const rememberId = 'kotatsu_variant_flip_remember';
    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: copy.ok,
        cancelButton: copy.cancel,
        customInputs: [{ id: rememberId, label: copy.remember, type: 'checkbox' }],
    });
    const result = await popup.show();
    const yes = result === POPUP_RESULT.AFFIRMATIVE;
    if (yes && popup.inputResults?.get(rememberId) === true) setFlipWarnings(false);
    return yes;
}
