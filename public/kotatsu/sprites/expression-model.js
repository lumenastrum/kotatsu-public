/**
 * Sprites — the expression model (Pictures slice F, `docs/handoffs/pictures-slice-f.md`).
 *
 * Pure data and functions: no DOM, no imports from core, so jest and the rig import it as-is.
 *
 * One expression per FINISHED character message, from stock's local classifier
 * (`POST /api/extra/classify`, go-emotions, 28 labels), stored on the message per swipe as the
 * classifier's ranked answer, never as a single label. A sprite set holds a handful of those 28
 * (a generated set is six to nine), so the face is RESOLVED at show time against whatever the
 * character has on disk: a set that grows later shows better faces for old messages without
 * re-classifying anything.
 */

/** Stock's 28 labels, in stock's order (`expressions/index.js` `DEFAULT_EXPRESSIONS`). */
/** @type {ReadonlyArray<string>} */
export const EXPRESSION_LABELS = Object.freeze([
    'admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity',
    'desire', 'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear',
    'gratitude', 'grief', 'joy', 'love', 'nervousness', 'optimism', 'pride', 'realization', 'relief',
    'remorse', 'sadness', 'surprise', 'neutral',
]);

/** `message.extra.<key>`; core copies `extra` into `swipe_info[].extra`, so it is per swipe. */
export const EXPRESSION_EXTRA_KEY = 'kotatsu_expression';

/** Bump when the stored shape or the sampling changes; an older entry is classified again. */
export const EXPRESSION_VERSION = 1;

/** How many ranked labels are kept (the route answers five). */
export const RANKED_KEEP = 5;

/** Characters of prose the classifier reads, taken from the END of the message (see below). */
export const SAMPLE_CHARS = 400;

/**
 * Where a label falls back when its own sprite is missing, one step at a time, ending at nothing
 * (`neutral` is the resolver's last resort, never a parent). Chains stay inside one feeling, so a
 * set of six (neutral, joy, anger, surprise, embarrassment, sadness) catches every label with a
 * face that belongs, and `curiosity` stays calm rather than borrowing a gasp.
 * @type {Readonly<Record<string, string>>}
 */
export const LABEL_PARENT = Object.freeze({
    admiration: 'joy',
    amusement: 'joy',
    approval: 'joy',
    excitement: 'joy',
    gratitude: 'joy',
    optimism: 'joy',
    pride: 'joy',
    relief: 'joy',
    caring: 'love',
    love: 'joy',
    desire: 'love',
    annoyance: 'anger',
    disapproval: 'annoyance',
    disgust: 'anger',
    grief: 'sadness',
    remorse: 'sadness',
    disappointment: 'sadness',
    nervousness: 'fear',
    fear: 'surprise',
    realization: 'surprise',
    confusion: 'curiosity',
});

/**
 * Removes what is not the character speaking: HTML comments, code fences, `<style>`/`<script>`,
 * every `<details>` block (trackers, status panels, dice; innermost first, so nesting goes too),
 * then the remaining tags, markdown emphasis and quote marks. Measured 2026-10-10 on dev chats:
 * a Seraphina reply that ends in three tracker `<details>` blocks classified as the tracker
 * ("Physics: … animals entering/exiting") until these were stripped.
 * @param {string} text
 * @returns {string}
 */
export function cleanForClassify(text) {
    if (typeof text !== 'string' || !text) return '';
    let t = text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ');
    let previous;
    do {
        previous = t;
        t = t.replace(/<details\b(?:(?!<details\b)[\s\S])*?<\/details>/gi, ' ');
    } while (t !== previous);
    return t
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~"“”«»]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * The text the classifier reads: the cleaned message's last `max` characters, starting at a
 * sentence when one starts in the first half of the window. The stage shows the character NOW,
 * and in a long reply that is how it ends, not how it opened (stock reads the first and last 250).
 * @param {string} text the raw message
 * @param {number} [max]
 * @returns {string}
 */
export function sampleForClassify(text, max = SAMPLE_CHARS) {
    const clean = cleanForClassify(text);
    if (clean.length <= max) return clean;
    const tail = clean.slice(-max);
    const start = tail.search(/[.!?…]\s/);
    return start >= 0 && start < max / 2 ? tail.slice(start + 1).trim() : tail.trim();
}

/**
 * FNV-1a of the sampled text, base 36. Lets an edit re-classify only when what the classifier
 * would read actually changed.
 * @param {string} text
 * @returns {string}
 */
export function sampleKey(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * @typedef {object} StoredExpression
 * @property {number} v EXPRESSION_VERSION when written
 * @property {string} key sampleKey of the text that was classified
 * @property {Array<[string, number]>} ranked label and score, best first
 */

/**
 * Builds the stored entry from the classify route's answer (`[{label, score}]`).
 * @param {string} sample what was classified
 * @param {unknown} classification
 * @returns {StoredExpression | null} null when the answer has no known label
 */
export function buildStoredExpression(sample, classification) {
    if (!Array.isArray(classification)) return null;
    /** @type {Array<[string, number]>} */
    const ranked = [];
    for (const item of classification) {
        const label = typeof item?.label === 'string' ? item.label.toLowerCase() : '';
        const score = Number(item?.score);
        if (!EXPRESSION_LABELS.includes(label) || !Number.isFinite(score)) continue;
        if (ranked.some(([seen]) => seen === label)) continue;
        ranked.push([label, Math.round(score * 1000) / 1000]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    return { v: EXPRESSION_VERSION, key: sampleKey(sample), ranked: ranked.slice(0, RANKED_KEEP) };
}

/**
 * Reads a message's stored entry, or null when absent, malformed or from an older version.
 * @param {{extra?: Record<string, any>} | null | undefined} message
 * @returns {StoredExpression | null}
 */
export function readStoredExpression(message) {
    const stored = message?.extra?.[EXPRESSION_EXTRA_KEY];
    if (!stored || typeof stored !== 'object' || stored.v !== EXPRESSION_VERSION) return null;
    if (typeof stored.key !== 'string' || !Array.isArray(stored.ranked) || !stored.ranked.length) return null;
    const ok = stored.ranked.every(entry => Array.isArray(entry) && EXPRESSION_LABELS.includes(entry[0]) && Number.isFinite(entry[1]));
    return ok ? stored : null;
}

/**
 * Whether a message needs (re)classifying: no valid entry, or one made from different text.
 * @param {{extra?: Record<string, any>} | null | undefined} message
 * @param {string} sample
 * @returns {boolean}
 */
export function needsClassify(message, sample) {
    if (!sample) return false;
    const stored = readStoredExpression(message);
    return !stored || stored.key !== sampleKey(sample);
}

/**
 * Below this top score the face stays `neutral`. Measured 2026-10-10 on dev chats (the shipped
 * sampler, 287 replies): the classifier is unsure on roleplay prose, median top score 0.088, the
 * middle half between 0.077 and 0.102; clear lines score well above it ("Rest now, you're safe
 * here" = caring 0.37). A guess that weak moving a face reads as noise. Tuned in the app.
 */
export const CONFIDENT_SCORE = 0.1;

/**
 * Follows a label up its family chain to the first label the character has a sprite for.
 * @param {string} label
 * @param {Set<string>} have
 * @returns {string | null}
 */
function walkFamily(label, have) {
    const seen = new Set();
    let current = label;
    while (current && !seen.has(current)) {
        if (have.has(current)) return current;
        seen.add(current);
        current = LABEL_PARENT[current];
    }
    return null;
}

/**
 * Picks the sprite label to show. The TOP label decides: its own sprite or the nearest one up its
 * family chain, else `neutral`. Lower ranks are only tried when the character has no `neutral`:
 * with scores this flat, rank two is mostly noise (measured: a dry "confusion" line fell through
 * to a second-rank "disapproval" and showed anger). A top score under `floor` shows `neutral`.
 * Null means no sprite fits: show the card art.
 * @param {StoredExpression | null} stored
 * @param {Iterable<string>} available labels the character has sprites for
 * @param {{floor?: number}} [options]
 * @returns {string | null}
 */
export function resolveExpression(stored, available, { floor = CONFIDENT_SCORE } = {}) {
    const have = new Set([...available].map(label => String(label).toLowerCase()));
    if (!have.size) return null;
    const ranked = stored?.ranked ?? [];
    const neutral = have.has('neutral') ? 'neutral' : null;
    if (!ranked.length) return neutral;
    const [topLabel, topScore] = ranked[0];
    if (neutral && topScore < floor) return neutral;
    const top = walkFamily(topLabel, have);
    if (top || neutral) return top ?? neutral;
    for (const [label] of ranked.slice(1)) {
        const found = walkFamily(label, have);
        if (found) return found;
    }
    return null;
}
