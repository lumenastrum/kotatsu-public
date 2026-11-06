/**
 * Persona variants and the prompt cache — `docs/persona-gallery-v0.md` §7.3.
 *
 * Providers reuse the part of a prompt that is byte-for-byte the same as last time (Kotatsu
 * turns that on everywhere, `docs/prompt-cache-v0.md`). A persona in the story setup sits AHEAD
 * of the whole chat, so changing its text means the next reply re-sends everything behind it.
 * Variants are stable within a chat by design (every trigger is fixed for its length), so the
 * only ways they cost anything are:
 *
 * - flipping or editing one mid-chat: ONE reply re-sends the chat, then it's warm again;
 * - a macro that changes every message (`{{time}}`, `{{random}}`, …): EVERY reply re-sends it.
 *
 * This module decides when to say so, and says it. PURE: no core, no DOM. The copy is written
 * for every reader — someone who knows what a prefix cache is, and someone who just wants their
 * roleplay to stay cheap — so it talks about re-sending the chat, not breakpoints.
 */

import { activeItems } from './persona-variants.js';

/** @typedef {import('./persona-variants.js').PersonaVariant} PersonaVariant */
/** @typedef {import('./persona-variants.js').VariantContext} VariantContext */

/**
 * Core macros whose value changes from one message to the next (core's macro definitions,
 * `public/scripts/macros/definitions/*`), lowercased, legacy spellings included. Left out on
 * purpose: `date` / `weekday` / `isodate` (once a day), `pick` (seeded per chat, stable), and
 * `getvar` (only changes when something writes the variable; the writers are listed).
 */
export const PER_TURN_MACROS = Object.freeze(new Set([
    'time', 'isotime', 'datetimeformat', 'idleduration', 'idle_duration', 'timediff', 'time_utc',
    'lastmessage', 'lastmessageid', 'lastusermessage', 'lastcharmessage',
    'firstincludedmessageid', 'firstdisplayedmessageid', 'lastswipeid', 'currentswipeid', 'allchatrange',
    'input', 'roll', 'random', 'lastgenerationtype',
    'setvar', 'addvar', 'incvar', 'decvar', 'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar',
]));

/**
 * The per-message macros a text uses, as written, de-duplicated, in order of first use.
 * Matches `{{name}}`, `{{name::args}}`, `{{name:args}}` and `{{time_UTC+2}}`-style suffixes.
 * @param {string} text Any persona or variant text.
 * @returns {string[]} e.g. `['time', 'random']`.
 */
export function perTurnMacros(text) {
    /** @type {string[]} */
    const found = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const match of String(text ?? '').matchAll(/\{\{\s*([A-Za-z_]+)/g)) {
        const name = match[1];
        const key = name.toLowerCase();
        if (PER_TURN_MACROS.has(key) && !seen.has(key)) {
            seen.add(key);
            found.push(name);
        }
    }
    return found;
}

/**
 * Whether a persona at this position sits ahead of the chat (where a change re-sends it all).
 * The story setup does (IN_PROMPT, and the deprecated AFTER_CHAR). At-depth and the author's
 * note ride in the part of the prompt that moves every turn anyway, and "None" sends nothing.
 * @param {number} position `persona_description_positions` value.
 * @returns {boolean} Whether a change costs a re-send.
 */
export function positionIsCached(position) {
    return position === 0 || position === 1;
}

/**
 * Whether flipping one entry's switch changes what folds in for what is open. Flipping a
 * variant that isn't (and wouldn't be) on here changes nothing, so it deserves no warning.
 * @param {PersonaVariant[]} variants Normalized list.
 * @param {string} id The entry being flipped (item or group).
 * @param {VariantContext} context What is open.
 * @returns {boolean} Whether the prompt here changes.
 */
export function flipChangesHere(variants, id, context) {
    const flip = (/** @type {PersonaVariant} */ variant) => (variant.id === id ? { ...variant, enabled: !variant.enabled } : variant);
    const flipped = variants.map(variant => (variant.kind === 'group'
        ? { ...flip(variant), children: variant.children.map(flip) }
        : flip(variant)));
    const before = activeItems(variants, context).map(item => item.id).join('|');
    const after = activeItems(flipped, context).map(item => item.id).join('|');
    return before !== after;
}

/**
 * The flip confirm, in words for everyone.
 * @param {{ messages: number, turningOn: boolean }} facts The open chat's length; the direction.
 * @returns {{ title: string, body: string, ok: string, cancel: string, remember: string }} The copy.
 */
export function flipConfirmCopy({ messages, turningOn }) {
    const size = messages > 0 ? ` (${messages} ${messages === 1 ? 'message' : 'messages'})` : '';
    return {
        title: turningOn ? 'Switch this variant on mid-chat?' : 'Switch this variant off mid-chat?',
        body: 'Heads up: this changes your persona partway through the roleplay, so your next reply '
            + `sends the whole chat${size} to your provider fresh, instead of reusing what it already has. `
            + 'That one reply costs more and may be a little slower. After that, it\'s back to normal.',
        ok: turningOn ? 'Switch it on' : 'Switch it off',
        cancel: 'Not now',
        remember: 'Don\'t ask me again',
    };
}

/**
 * The inline heads-up for per-message macros.
 * @param {string[]} names What {@link perTurnMacros} found.
 * @returns {string} One sentence or two; `''` when there is nothing to say.
 */
export function perTurnNoteCopy(names) {
    if (!names.length) return '';
    const listed = names.map(name => `{{${name}}}`);
    const which = listed.length === 1 ? `${listed[0]} changes` : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]} change`;
    return `Heads up: ${which} with every message, so every reply sends the whole chat to your provider fresh `
        + 'instead of reusing it. That costs more on every reply. Totally fine if you want it, just so you know.';
}
