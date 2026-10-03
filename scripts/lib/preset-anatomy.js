/**
 * Pure logic for the Kotatsu Nabe budget check (docs/house-preset-v0.md §3, §7 gate 2).
 * Computes aggregates over the prompts a preset's default order enables. Never returns prompt text.
 */

export const DEFAULT_ORDER_CHARACTER_ID = 100001;

/** All-caps words that are plain acronyms, not shouting. Explicit on purpose. */
export const CAPS_ALLOWLIST = new Set([
    'NSFW', 'SFW', 'POV', 'HTML', 'JSON', 'XML', 'OOC', 'NPC', 'API', 'CSS', 'URL', 'ASCII', 'UTF',
    'LLM', 'RPG',
]);

const NEGATIVE_RE = new RegExp(
    '\\b(?:don\'t|do not|never|avoid|must not|mustn\'t|should not|shouldn\'t|refrain|forbid\\w*|'
    + 'ban(?:s|ned|ning)?|prohibit\\w*|cannot|can\'t|won\'t|stop)\\b', 'i');
const NEGATIVE_UPPER_RE = /\b(?:NO|NOT)\b/;
const REFRAME_RE = /\b(?:instead|rather than)\b/gi;
const MACRO_RE = /\{\{[\s\S]*?\}\}/g;

/**
 * The words the model actually receives. Comment macros are never sent, so they go; simple macros
 * ({{char}}, {{user}}) stand in as one word; a variable a preset sets ({{setvar::name::TEXT}},
 * {{addvar::…}}) contributes its TEXT, because presets that keep their prose inside variables
 * would otherwise measure as nearly empty. Anything left becomes a space.
 * @param {string} text
 * @returns {string}
 */
export function visibleText(text) {
    return text
        .replace(/\{\{\/\/[\s\S]*?\}\}/g, '')
        .replace(/\{\{\s*(?:char|user|persona|charIfNotGroup|group|model)\s*\}\}/gi, 'Someone')
        .replace(/\{\{[^{}:]*\}\}/g, ' ')
        .replace(/\{\{(?:setvar|addvar|setglobalvar|addglobalvar)::[^:{}]*::([\s\S]*?)\}\}/gi, '$1')
        .replace(MACRO_RE, ' ');
}

/** The Nabe budget (spec §3). */
export const NABE_BUDGET = Object.freeze({
    maxTokens: 2500,
    maxModuleWords: 90,
    maxNegativeShare: 0.08,
    maxCapsWords: 5,
    maxRegexScripts: 0,
    allowPrefill: false,
    minPrompts: 25,
    maxPrompts: 35,
});

/**
 * @typedef {{ identifier?: string, name?: string, role?: string, content?: unknown, marker?: boolean }} PromptLike
 * @typedef {{ prompts?: PromptLike[], prompt_order?: Array<{ character_id?: number, order?: Array<{ identifier: string, enabled?: boolean }> }>, extensions?: { regex_scripts?: unknown[] } }} PresetLike
 */

/**
 * The prompts the default order turns on, in order. Order list = character_id 100001, else the
 * last list. No prompt_order at all: every prompt counts as enabled.
 * @param {PresetLike} preset
 * @returns {PromptLike[]}
 */
export function enabledPrompts(preset) {
    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    if (orders.length === 0) return prompts;
    const list = orders.find(o => o?.character_id === DEFAULT_ORDER_CHARACTER_ID) ?? orders[orders.length - 1];
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    /** @type {PromptLike[]} */
    const out = [];
    for (const entry of list?.order ?? []) {
        if (!entry?.enabled) continue;
        const p = byId.get(entry.identifier);
        if (p) out.push(p);
    }
    return out;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function sentencesOf(text) {
    return visibleText(text)
        .replace(/[\u2018\u2019]/g, '\'')
        .split(/(?<=[.!?])\s+|\n+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * @param {string} s
 * @returns {number}
 */
function wordCount(s) {
    return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Aggregates only. Prompt names (never text) appear where a violation needs pointing at.
 * @param {PresetLike} preset
 */
export function analyze(preset) {
    const on = enabledPrompts(preset);
    const withContent = on.filter(p => typeof p.content === 'string' && p.content.trim() !== '');
    let chars = 0;
    let macros = 0;
    let caps = 0;
    let reframes = 0;
    let sentences = 0;
    let negatives = 0;
    let totalWords = 0;
    let maxModuleWords = 0;
    let maxModule = '';
    for (const p of withContent) {
        const text = /** @type {string} */ (p.content);
        chars += text.length;
        macros += (text.match(MACRO_RE) ?? []).length;
        const bare = visibleText(text);
        caps += (bare.match(/\b[A-Z]{4,}\b/g) ?? []).filter(w => !CAPS_ALLOWLIST.has(w)).length;
        reframes += (bare.match(REFRAME_RE) ?? []).length;
        const words = wordCount(bare);
        totalWords += words;
        if (words > maxModuleWords) {
            maxModuleWords = words;
            maxModule = String(p.name ?? p.identifier ?? '(unnamed)');
        }
        for (const s of sentencesOf(text)) {
            if (wordCount(s) < 4) continue;
            sentences++;
            if (NEGATIVE_RE.test(s) || NEGATIVE_UPPER_RE.test(s)) negatives++;
        }
    }
    const prefill = on.filter(p => p.role === 'assistant' && !p.marker && typeof p.content === 'string' && p.content.trim() !== '').length;
    return {
        totalPrompts: Array.isArray(preset?.prompts) ? preset.prompts.length : 0,
        enabledPrompts: on.length,
        enabledWithContent: withContent.length,
        tokens: Math.round(chars / 4),
        maxModuleWords,
        maxModule,
        avgModuleWords: withContent.length ? Math.round(totalWords / withContent.length) : 0,
        sentences,
        negativeSentences: negatives,
        negativeShare: sentences ? negatives / sentences : 0,
        reframes,
        capsWords: caps,
        macros,
        regexScripts: Array.isArray(preset?.extensions?.regex_scripts) ? preset.extensions.regex_scripts.length : 0,
        prefillPrompts: prefill,
    };
}

/**
 * @param {ReturnType<typeof analyze>} a
 * @param {typeof NABE_BUDGET} [budget]
 * @returns {string[]} one line per violation; empty = within budget
 */
export function checkBudget(a, budget = NABE_BUDGET) {
    /** @type {string[]} */
    const v = [];
    if (a.tokens > budget.maxTokens) v.push(`enabled tokens ${a.tokens} > ${budget.maxTokens}`);
    if (a.maxModuleWords > budget.maxModuleWords) v.push(`module "${a.maxModule}" has ${a.maxModuleWords} words > ${budget.maxModuleWords}`);
    if (a.negativeShare > budget.maxNegativeShare) v.push(`negative sentences ${(a.negativeShare * 100).toFixed(1)}% > ${(budget.maxNegativeShare * 100).toFixed(0)}%`);
    if (a.capsWords > budget.maxCapsWords) v.push(`all-caps words ${a.capsWords} > ${budget.maxCapsWords}`);
    if (a.regexScripts > budget.maxRegexScripts) v.push(`regex scripts ${a.regexScripts} > ${budget.maxRegexScripts}`);
    if (!budget.allowPrefill && a.prefillPrompts > 0) v.push(`${a.prefillPrompts} enabled assistant-role prompt(s) (prefill)`);
    if (a.totalPrompts < budget.minPrompts || a.totalPrompts > budget.maxPrompts) v.push(`total prompts ${a.totalPrompts} outside ${budget.minPrompts}-${budget.maxPrompts}`);
    return v;
}
