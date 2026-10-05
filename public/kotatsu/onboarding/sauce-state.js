/**
 * The welcome tour's Sauce step, as data (docs/onboarding-v0.md §2.2). Pure: which sauces to
 * offer, how a mode option reads, which dials the live connection actually honours, and which
 * segment a live value lands on. The component reads core and writes through core's own controls.
 */

import { creditEntries } from './preset-credits.js';

/**
 * @typedef {object} Sauce
 * @property {string} name The preset name exactly as core lists it.
 * @property {string} title Display title.
 * @property {string} blurb One line about it.
 * @property {string} author Who made it ('' for Plain).
 * @property {string|null} url The author's page (https), or null.
 * @property {boolean} own Whether Kotatsu made it.
 * @property {string} line Key of Mikan-chan's line for it (brand/mascot/lines.js).
 */

/**
 * Core's own preset, offered last as "Plain (Default)". It is core's, not the manifest's.
 * @type {Readonly<Sauce>}
 */
export const PLAIN = Object.freeze({
    name: 'Default',
    title: 'Plain (Default)',
    blurb: 'No extra instructions at all. For people who bring their own.',
    author: '',
    url: null,
    own: false,
    line: 'saucePlain',
});

/**
 * Mikan-chan's voice for a particular author, where she has something to say. A manifest entry
 * whose author isn't here simply gets her generic line, so adding a preset needs no code.
 * @type {Readonly<Record<string, string>>}
 */
const AUTHOR_LINES = Object.freeze({ Pyrxpia: 'sauceSola' });

/**
 * Which of her lines a manifest entry gets.
 * @param {{own: boolean, author: string}} entry Entry.
 * @returns {string} A key of LINES.
 */
export function sauceLineKey(entry) {
    if (entry.own) return 'sauceOwn';
    return AUTHOR_LINES[entry.author] ?? 'sauceBorrowed';
}

/**
 * Every sauce the tour could offer, from the credits manifest: the house preset first, the rest
 * in manifest order, then Plain.
 * @param {any} manifest The credits manifest.
 * @returns {Sauce[]} Sauces.
 */
export function buildSauces(manifest) {
    return [
        ...creditEntries(manifest).map(entry => ({ ...entry, line: sauceLineKey(entry) })),
        PLAIN,
    ];
}

/**
 * The sauces this install actually has: a preset the manifest names but core doesn't list
 * (renamed, deleted) is simply not offered.
 * @param {readonly string[]} presetNames Names core lists for Chat Completion.
 * @param {any} manifest The credits manifest.
 * @returns {Sauce[]} Offered sauces, in order.
 */
export function availableSauces(presetNames, manifest) {
    const names = new Set(presetNames);
    return buildSauces(manifest).filter(sauce => names.has(sauce.name));
}

/** The prompt identifier of Kotatsu Nabe's mature-content module (docs/house-preset-v0.md §0.7). */
export const MATURE_IDENTIFIER = 'nsfw';

/**
 * Whether one prompt in the active order is on, for the Mature content switch.
 * @param {ReadonlyArray<{identifier: string, enabled?: boolean}>} order The live order.
 * @param {string} identifier The prompt identifier.
 * @returns {{present: boolean, enabled: boolean}} Whether the preset has it, and whether it is on.
 */
export function promptState(order, identifier) {
    const entry = (Array.isArray(order) ? order : []).find(candidate => candidate?.identifier === identifier);
    return { present: !!entry, enabled: entry?.enabled === true };
}

/**
 * A mode option as a person reads it: "➊ Game Master" → "Game Master".
 * @param {string} label The prompt's label in the list.
 * @returns {string} Display label.
 */
export function modeLabel(label) {
    return String(label ?? '').replace(/^[\s\p{So}\p{No}━+\-–—:·.]+/u, '').trim() || String(label ?? '');
}

/** Group names that mean "how you like to play". Nabe says Mode; Sparkle-family presets said Type. */
const MODE_GROUP = /^(?:play\s*)?(?:mode|modes|type|style)$|^play$/i;

/**
 * The mode group to offer under "How do you like to play?": the first radio group with at least
 * two options whose NAME says it is a play mode. Not just the first group: Sola's first is
 * "User" (how much the AI may drive you), which read as a play style in the v0.2.0 walkthrough.
 * A preset without one gets no such row; its groups stay in "More seasoning" under their names.
 * @template {{label?: string, options: unknown[]}} G
 * @param {G[]} groups `<k-prompt-list>.radioGroups()`.
 * @returns {G|null} The group, or null (Plain and Sola have none).
 */
export function modeGroup(groups) {
    return (Array.isArray(groups) ? groups : []).find(group => Array.isArray(group.options) && group.options.length >= 2
        && MODE_GROUP.test(modeLabel(group.label ?? ''))) ?? null;
}

/**
 * Kotatsu Nabe's play styles, said the way a person chooses between them. A reader on macOS
 * (r/SillyTavernAI, 2026-10-04) couldn't tell Roleplayer, Writer and Companion apart from the
 * names alone. Other sauces describe themselves: see {@link optionBlurb}.
 * @type {Readonly<Record<string, string>>}
 */
export const MODE_BLURBS = Object.freeze({
    'nabe-mode-roleplayer': 'Turn by turn. You play your character; the model plays everyone else and keeps the scene moving.',
    'nabe-mode-writer': 'A book written together. You give directions, the model writes the prose, your character included.',
    'nabe-mode-companion': 'Slower and closer. Continuity and the small things you share matter more than plot, and you play yourself.',
});

/**
 * One plain line under "How do you like to play?" for the selected option. Nabe's are written
 * for it; any other preset's option speaks for itself through the first sentence of its own
 * text (at least a few words, so a bare heading like "Game Master." runs on into the sentence
 * that explains it), with the macros read aloud and markup dropped. {{user}} reads as "your
 * character": presets write it with third-person verbs ("while {{user}} explores"), which "you"
 * would break. Empty when there is nothing readable to say.
 * @param {string} identifier The option's prompt identifier.
 * @param {string} content The option's prompt text.
 * @returns {string}
 */
export function optionBlurb(identifier, content) {
    if (Object.hasOwn(MODE_BLURBS, identifier)) return MODE_BLURBS[identifier];
    /** @type {Record<string, string>} */
    const spoken = { user: 'your character', char: 'the character' };
    // The two people become placeholders first, so a {{setvar::…}} value that mentions them
    // unwraps whole instead of ending at their inner "}}".
    const raw = String(content ?? '').replace(/\{\{\s*(user|char)\s*\}\}/gi, (_, who) => `\u0001${who.toLowerCase()}\u0002`);
    // A {{// comment}} is never sent to the model: it is the author describing the module to
    // people, which is exactly what this line is for (Sparkle: "Main prompt for fanfic writing.").
    const comment = (/\{\{\/\/\s*([\s\S]*?)\s*\}\}/.exec(raw)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    const source = comment.length >= 12
        ? comment
        // Otherwise the text itself, with {{setvar::name::value}} read as its value, not dropped.
        : raw.replace(/\{\{setvar::[^:}]*::([\s\S]*?)\}\}/gi, '$1');
    const text = source
        .replace(/\{\{[^}]*\}\}/g, '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[#*_`>[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        // Read the two people aloud, capitalized where a sentence starts.
        .replace(/\u0001(user|char)\u0002/g, (_, who, offset, whole) => {
            const said = spoken[who];
            const before = whole.slice(0, offset).trimEnd();
            return !before || /[.!?]$/.test(before) ? said.charAt(0).toUpperCase() + said.slice(1) : said;
        });
    // A scrap ("b", "v2") is not a description.
    if (text.length < 8) return '';
    const sentence = /^(.{12,220}?[.!?])(?:\s|$)/.exec(text);
    const first = sentence ? sentence[1] : text;
    const line = first.charAt(0).toUpperCase() + first.slice(1);
    return line.length > 200 ? `${line.slice(0, 197).trimEnd()}…` : line;
}

/**
 * An option as a person reads it inside its group: numbering glyphs dropped, and the group's own
 * name dropped when the preset repeats it ("User: Agency-Lite" in group User → "Agency-Lite").
 * @param {string} groupLabel The group's label.
 * @param {string} label The option's label in the list.
 * @returns {string} Display label.
 */
export function optionLabel(groupLabel, label) {
    const plain = modeLabel(label);
    const group = modeLabel(groupLabel);
    if (!group) return plain;
    const lower = plain.toLowerCase();
    if (!lower.startsWith(group.toLowerCase())) return plain;
    const rest = plain.slice(group.length).replace(/^\s*[:·–—-]\s*/, '');
    // Only a real separator counts: "Users" in a group "User" is not a prefix.
    return rest !== plain.slice(group.length) && rest.trim() ? rest.trim() : plain;
}

/** @typedef {'context'|'reply'|'creativity'|'effort'} DialId */

/**
 * The dials. Values are what core's own controls take. `reply` and `creativity` are never offered
 * on the Claude Code bridge: it ignores temperature and does not cap reply length
 * (claude-bridge/*.js; kotatsu-baggage.css hides the same two). `effort` is the bridge's own.
 * @type {Readonly<Record<DialId, {title: string, hint: string, options: ReadonlyArray<{value: number|string, label: string}>}>>}
 */
export const DIALS = Object.freeze({
    // "Context", never "Memory": Kotatsu's memory engine (docs/memory-engine-v0.md) owns that word.
    context: {
        title: 'Context',
        hint: 'How much of the story is sent back each turn. More remembers further, and costs more on a paid key.',
        // A ceiling, not a fill: a short chat sends the same either way. 1M is the default window
        // for Claude Sonnet 4.5+ / Opus 4.6+ / Sonnet 5 / Opus 5 / Fable 5, GPT-5.4/5.5/4.1,
        // Gemini 2.5/3 and DeepSeek (core's own tables, openai.js); Claude Code reported
        // `contextWindow: 1000000` for claude-sonnet-5-5 on a Max login (2026-10-01). Options
        // above the live model's ceiling are disabled, never silently clamped.
        options: Object.freeze([
            { value: 64000, label: '64k' },
            { value: 200000, label: '200k' },
            { value: 500000, label: '500k' },
            { value: 1000000, label: '1M' },
        ]),
    },
    reply: {
        title: 'Reply length',
        hint: 'A ceiling, not a target. Thinking models spend part of it thinking.',
        options: Object.freeze([
            { value: 2048, label: 'Short' },
            { value: 4096, label: 'Medium' },
            { value: 8192, label: 'Long' },
        ]),
    },
    creativity: {
        title: 'Creativity',
        hint: 'Steady stays on script; lively takes chances.',
        options: Object.freeze([
            { value: 0.7, label: 'Steady' },
            { value: 0.9, label: 'Balanced' },
            { value: 1, label: 'Lively' },
        ]),
    },
    effort: {
        title: 'Effort',
        hint: 'How hard Claude thinks before it writes. Higher is smarter and slower.',
        options: Object.freeze([
            { value: '', label: 'Default' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'Extra high' },
            { value: 'max', label: 'Max' },
        ]),
    },
});

/**
 * The context ceiling for a model served by the Claude Code bridge. Core leaves the slider at its
 * 2M "unlocked" maximum for any custom endpoint, so the bridge's own model has to be asked.
 * Mirrors core's Claude table (openai.js, `/^claude-(sonnet-4-5|…|fable-5)/` → 1M, else 200k).
 * @param {string} model Bridge model id.
 * @returns {number} Tokens.
 */
export function bridgeContextCeiling(model) {
    return /^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7|opus-4-8|sonnet-5|opus-5|fable-5)/.test(String(model ?? '')) ? 1000000 : 200000;
}

/**
 * Which dials the live connection honours, in display order.
 * @param {{onBridge: boolean, mainApi: string}} facts
 * @returns {DialId[]} Dials to show; empty when the connection isn't Chat Completion.
 */
export function dialsFor({ onBridge, mainApi }) {
    if (onBridge) return ['context', 'effort'];
    if (mainApi === 'openai') return ['context', 'reply', 'creativity'];
    return [];
}

/**
 * The option a live value lands on, or null when it is something the tour doesn't offer (a
 * hand-tuned value stays untouched and simply shows no segment lit).
 * @param {DialId} dial Dial.
 * @param {unknown} value Live value.
 * @returns {number|string|null} The matching option's value.
 */
export function selectedOption(dial, value) {
    const options = DIALS[dial]?.options ?? [];
    if (dial === 'effort') return options.find(option => option.value === (value ?? ''))?.value ?? null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return options.find(option => Math.abs(Number(option.value) - number) < 1e-9)?.value ?? null;
}

/**
 * What the chosen sauce's tile says about the regex scripts embedded in the preset (Sola ships
 * 149). Core asks before allowing them, once, in its own popup; this keeps the tile honest
 * whichever way that went, and is the way back after "Not now".
 * @param {number} total Embedded scripts the active preset carries.
 * @param {boolean} allowed Whether core has them allowed.
 * @returns {{state: 'off'|'on', text: string, action: string}|null} The note, or null when there are none.
 */
export function regexNote(total, allowed) {
    const count = Number(total);
    if (!Number.isFinite(count) || count <= 0) return null;
    const noun = count === 1 ? 'regex script' : 'regex scripts';
    return allowed
        ? { state: 'on', text: `Its ${count} ${noun} ${count === 1 ? 'is' : 'are'} allowed.`, action: '' }
        : { state: 'off', text: `Brings ${count} ${noun}. ${count === 1 ? 'It stays' : 'They stay'} off until you allow ${count === 1 ? 'it' : 'them'}.`, action: 'Review' };
}
