/**
 * Pure logic for the Kotatsu Nabe clean-room overlap gate (docs/house-preset-v0.md §6).
 *
 * A candidate preset "overlaps" a reference when any n-word run (default 8) of normalized text
 * appears in both. No I/O here; scripts/preset-overlap.mjs does the file work.
 */

/** Stands in for every `{{macro}}`, so macros alone can never create or extend a match. */
export const MACRO_TOKEN = '';

/**
 * Words that carry no wording of their own. A run made only of these (and macro placeholders)
 * is ignored.
 */
export const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
    'with', 'from', 'as', 'into', 'than', 'then', 'that', 'this', 'these', 'those', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'am', 'it', 'its', 'if', 'not', 'no', 'do', 'does', 'did',
    'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'you', 'your', 'i',
    'me', 'my', 'we', 'our', 'he', 'she', 'they', 'them', 'their', 'his', 'her', 'who', 'what',
    'which', 'when', 'where', 'while', 'there', 'here', 'have', 'has', 'had', 'all', 'any', 'each',
    'every', 'some', 'more', 'most', 'also', 'just', 'only', 'very', 'about', 'up', 'out', 'over',
]);

/**
 * @typedef {{ name: string, content: string }} PromptText
 * @typedef {{ prompts?: Array<{ name?: string, identifier?: string, content?: unknown }> }} PresetLike
 */

/**
 * Every prompt's content string, enabled or not. Prompts with no string content (markers) are skipped.
 * @param {PresetLike} preset
 * @returns {PromptText[]}
 */
export function extractTexts(preset) {
    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    /** @type {PromptText[]} */
    const out = [];
    for (const p of prompts) {
        if (typeof p?.content !== 'string' || p.content.trim() === '') continue;
        out.push({ name: String(p.name ?? p.identifier ?? '(unnamed)'), content: p.content });
    }
    return out;
}

/**
 * Lowercase, curly quotes straightened, macros replaced by a placeholder, punctuation dropped
 * (apostrophes kept inside words), whitespace collapsed.
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
    return tokenize(text).join(' ');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    const flat = String(text)
        .replace(/\{\{[\s\S]*?\}\}/g, ` ${MACRO_TOKEN} `)
        .replace(/[‘’‛ʼ`´]/g, '\'')
        .replace(/[“”„]/g, '"')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}']+/gu, ' ');
    return flat
        .split(/\s+/)
        .map(w => w.replace(/^'+|'+$/g, ''))
        .filter(Boolean);
}

/**
 * @param {string[]} words
 * @returns {boolean}
 */
function isFiller(words) {
    return words.every(w => w === MACRO_TOKEN || STOPWORDS.has(w));
}

/**
 * The set of n-word runs in a text, minus runs that are only stopwords/placeholders.
 * @param {string} text
 * @param {number} [n]
 * @returns {Set<string>}
 */
export function shingles(text, n = 8) {
    const words = tokenize(text);
    /** @type {Set<string>} */
    const out = new Set();
    for (let i = 0; i + n <= words.length; i++) {
        const run = words.slice(i, i + n);
        if (isFiller(run)) continue;
        out.add(run.join(' '));
    }
    return out;
}

/**
 * @typedef {{ name: string, preset: PresetLike }} Reference
 * @typedef {{ referenceName: string, run: string, candidatePrompt: string, referencePrompt: string }} Overlap
 */

/**
 * Every distinct n-word run the candidate shares with each reference. A run is reported once per
 * reference (first candidate prompt, first reference prompt holding it). Placeholders are shown
 * as `{{macro}}`.
 * @param {PresetLike} candidatePreset
 * @param {Reference[]} referencePresets
 * @param {number} [n]
 * @param {{ commons?: Set<string> }} [options] `commons`: runs to ignore — text every fork
 *   inherits from SillyTavern's stock presets is shared ancestry, not anyone's authorship.
 * @returns {Overlap[]}
 */
/**
 * Every n-word run in a preset's prompts, for use as `commons`.
 * @param {PresetLike} preset
 * @param {number} [n]
 * @returns {Set<string>}
 */
export function presetShingles(preset, n = 8) {
    const out = new Set();
    for (const t of extractTexts(preset)) for (const g of shingles(t.content, n)) out.add(g);
    return out;
}

export function findOverlaps(candidatePreset, referencePresets, n = 8, { commons } = {}) {
    const cand = extractTexts(candidatePreset).map(t => ({ name: t.name, grams: shingles(t.content, n) }));
    /** @type {Overlap[]} */
    const hits = [];
    for (const ref of referencePresets) {
        /** @type {Map<string, string>} run -> reference prompt name */
        const index = new Map();
        for (const t of extractTexts(ref.preset)) {
            for (const g of shingles(t.content, n)) if (!index.has(g)) index.set(g, t.name);
        }
        const seen = new Set();
        for (const c of cand) {
            for (const g of c.grams) {
                if (seen.has(g) || !index.has(g) || commons?.has(g)) continue;
                seen.add(g);
                hits.push({
                    referenceName: ref.name,
                    run: g.split(MACRO_TOKEN).join('{{macro}}'),
                    candidatePrompt: c.name,
                    referencePrompt: /** @type {string} */ (index.get(g)),
                });
            }
        }
    }
    return hits;
}
