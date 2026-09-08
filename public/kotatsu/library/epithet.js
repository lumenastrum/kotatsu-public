/**
 * The epithet chain — `docs/library-v0.md` §1.3.
 *
 * A card's kicker line is the one piece of copy the gallery INVENTS a slot for, so it is the
 * one piece that has to be provably honest. Everything here is pure: no DOM, no core imports,
 * no `power_user` read (the aux field NAME is passed in). That is what makes
 * `tests/library-epithet.test.js` able to measure the chain instead of vibing it.
 *
 * The chain, in order:
 *   1. `data.extensions.kotatsu_title` — authored for this slot. Truncated, never rejected:
 *      the user asked for those words.
 *   2. the first sentence of `creator_notes` / `creatorcomment` — DERIVED, so it is rejected
 *      rather than truncated when it will not fit (see {@link EPITHET_MAX}). When it is used,
 *      the body line shows the REMAINDER, so no sentence is printed twice.
 *   3. `data.creator`
 *   4. `data[power_user.aux_field || 'character_version']` — the same field core's own list
 *      subheader reads (`script.js:1031`).
 *   5. nothing. The kicker element is not rendered and the block reflows.
 *
 * The body line is the creator notes in every case EXCEPT (2), where it is what is left after
 * the kicker ate the opening sentence.
 */

/**
 * Longest kicker the poster can carry.
 *
 * The kicker is 11px micro-caps at `.14em` tracking inside a ~240px card: past roughly this
 * many characters it wraps to a third line and the copy block eats the portrait. An AUTHORED
 * value (`kotatsu_title`, `creator`, the aux field) is truncated at this length — the user
 * named those words and a visible `…` is honest about the clipping. A DERIVED first sentence
 * is dropped instead and the chain moves on, because half a sentence in small caps reads as a
 * rendering bug rather than as a title.
 */
export const EPITHET_MAX = 64;

/**
 * Shortest run of characters that may count as a sentence.
 *
 * Doubles as the cheap abbreviation guard: "Dr. Who is here." splits at the first `.` into a
 * two-character head, which is under this floor, so the scanner keeps going and returns the
 * whole line instead of the kicker "DR".
 */
export const SENTENCE_MIN = 3;

/** Characters that end a sentence. `\n` joins them — see {@link splitFirstSentence}. */
const TERMINATORS = '.!?';

/**
 * @typedef {object} EpithetSource
 * @property {string} [title] `data.extensions.kotatsu_title`.
 * @property {string} [notes] `data.creator_notes` (or the v1 `creatorcomment`).
 * @property {string} [creator] `data.creator`.
 * @property {string} [aux] `data[auxField]`.
 */

/**
 * @typedef {object} Epithet
 * @property {string} kicker Micro-caps line above the name. `''` when the chain found nothing.
 * @property {string} body Two-line clamped copy under the name. May be `''`.
 * @property {'title'|'notes'|'creator'|'aux'|'none'} source Which link answered. Test surface.
 */

/**
 * Collapses every run of whitespace (newlines included) to one space and trims.
 * @param {unknown} value Raw field value; anything at all.
 * @returns {string} A single-line string, possibly empty.
 */
export function collapse(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * Truncates at {@link EPITHET_MAX}, on a word boundary when one is close enough.
 *
 * Only ever applied to AUTHORED values. The ellipsis is a real character, not three dots, so a
 * `text-transform: uppercase` kicker cannot turn it into ". . .".
 * @param {string} text Already-collapsed text.
 * @returns {string} Text no longer than {@link EPITHET_MAX} characters.
 */
export function cap(text) {
    if (text.length <= EPITHET_MAX) {
        return text;
    }
    const head = text.slice(0, EPITHET_MAX - 1);
    const lastSpace = head.lastIndexOf(' ');
    // Only honour a word boundary in the last third; otherwise a long first word would
    // truncate to almost nothing.
    const cut = lastSpace > EPITHET_MAX * 0.66 ? head.slice(0, lastSpace) : head.trimEnd();
    return `${cut}…`;
}

/**
 * True when the character at `index` genuinely closes a sentence.
 *
 * `.` inside `3.5`, `v1.2` or `example.com` is followed by a non-space, which is what this
 * rejects. A newline always closes one — creator notes are routinely a markdown heading on
 * line one and prose after it, and splitting only on `[.!?]` would glue the two together.
 * @param {string} text The full string.
 * @param {number} index Candidate terminator index.
 * @returns {boolean} Whether the sentence ends here.
 */
function closesSentence(text, index) {
    const char = text[index];
    if (char === '\n') {
        return true;
    }
    if (!TERMINATORS.includes(char)) {
        return false;
    }
    let next = index + 1;
    // Walk a run of terminators ("...", "?!") to the character after it.
    while (next < text.length && TERMINATORS.includes(text[next])) {
        next += 1;
    }
    return next >= text.length || /\s/.test(text[next]);
}

/**
 * Splits text into its opening sentence and everything after it.
 *
 * Both halves come back collapsed to one line. `first` has its trailing punctuation stripped:
 * the kicker is a label, not a sentence, and "A QUIET GIRL." in micro-caps reads as a typo.
 * @param {unknown} text Raw creator notes.
 * @returns {{ first: string, rest: string }} Opening sentence and remainder; either may be ''.
 */
export function splitFirstSentence(text) {
    const source = typeof text === 'string' ? text : '';
    if (!source.trim()) {
        return { first: '', rest: '' };
    }

    for (let index = 0; index < source.length; index += 1) {
        if (!closesSentence(source, index)) {
            continue;
        }
        const head = collapse(source.slice(0, index));
        if (head.length < SENTENCE_MIN) {
            continue;
        }
        let after = index + 1;
        while (after < source.length && (TERMINATORS.includes(source[after]) || /\s/.test(source[after]))) {
            after += 1;
        }
        return {
            first: head.replace(/[\s.,;:!?…-]+$/u, ''),
            rest: collapse(source.slice(after)),
        };
    }

    // No boundary anywhere: the whole thing is one sentence and there is no remainder.
    return { first: collapse(source).replace(/[\s.,;:!?…-]+$/u, ''), rest: '' };
}

/**
 * Runs the chain.
 * @param {EpithetSource} source Card fields, already extracted.
 * @returns {Epithet} Kicker, body and which link answered.
 */
export function buildEpithet(source) {
    const notes = collapse(source?.notes);

    const title = collapse(source?.title);
    if (title) {
        return { kicker: cap(title), body: notes, source: 'title' };
    }

    const { first, rest } = splitFirstSentence(source?.notes);
    if (first && first.length <= EPITHET_MAX) {
        return { kicker: first, body: rest, source: 'notes' };
    }

    const creator = collapse(source?.creator);
    if (creator) {
        return { kicker: cap(creator), body: notes, source: 'creator' };
    }

    const aux = collapse(source?.aux);
    if (aux) {
        return { kicker: cap(aux), body: notes, source: 'aux' };
    }

    return { kicker: '', body: notes, source: 'none' };
}

/**
 * Reads the chain's inputs off a character record and runs it.
 *
 * Every field read is inside the `toShallow()` floor (`src/endpoints/characters.js:369-394`)
 * except `data.extensions.kotatsu_title`, which is Kotatsu's own and absent on every card that
 * has not been through the studio — so the chain simply starts at link 2 there.
 * `creatorcomment` is the v1 spelling and is consulted only when the v2 field is empty.
 * @param {Record<string, any>|null|undefined} item A `characters[]` entry.
 * @param {string} [auxField] `power_user.aux_field`; defaults to core's own default.
 * @returns {Epithet} The resolved epithet.
 */
export function epithetForCharacter(item, auxField = 'character_version') {
    const data = item && typeof item === 'object' && typeof item.data === 'object' && item.data
        ? /** @type {Record<string, any>} */ (item.data)
        : {};
    const extensions = typeof data.extensions === 'object' && data.extensions
        ? /** @type {Record<string, any>} */ (data.extensions)
        : {};
    const field = auxField || 'character_version';
    return buildEpithet({
        title: extensions.kotatsu_title,
        notes: data.creator_notes || (item && item.creatorcomment) || '',
        creator: data.creator,
        aux: data[field],
    });
}
