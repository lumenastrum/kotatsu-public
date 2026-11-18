/**
 * Kotatsu Wrapped — the starter phrase list.
 *
 * Shipped as v1 (Andres, 2026-11-12) and named "the usual suspects" (2026-11-18). Changing what is on
 * it is still his call (docs/wrapped/README.md). It started as a placeholder so the counter had
 * something real to count. The list's `name` is printed on the card, so two people comparing
 * numbers know they counted the same things; change the list, change the name.
 *
 * Counting only. Nothing here bans, rewrites or hides a phrase: presets own that.
 */

/** @type {{name: string, phrases: import('./engine.js').Phrase[]}} */
export const STARTER_PHRASES = Object.freeze({
    name: 'the usual suspects',
    phrases: [
        { id: 'not-x-but-y', label: 'not X, but Y', pattern: '\\bnot (?:just |merely |only |simply )?[^.,;!?\\n]{1,40}, but\\b' },
        { id: 'tell-me-to-stop', label: '“Tell me to stop”', pattern: 'tell me to stop' },
        { id: 'stay', label: '“Stay.”', pattern: '["“]Stay\\.?["”]', flags: 'g' },
        { id: 'white-knuckles', label: 'knuckles turning white', pattern: 'knuckles? (?:(?:turn(?:ed|ing|s)?|go(?:ing|ne|es)?|went|were|was|are|is) )?white|white[- ]knuckl' },
        { id: 'shivers-spine', label: 'shivers down the spine', pattern: 'shivers? (?:\\w+ ){0,2}(?:down|up) (?:\\w+ ){1,2}spine' },
        { id: 'barely-a-whisper', label: 'barely above a whisper', pattern: 'barely (?:above |more than )?a whisper' },
        { id: 'cant-help-but', label: 'can’t help but', pattern: '(?:can(?:[\'’]|no)?t|couldn[\'’]?t) help but' },
        { id: 'ozone', label: 'the smell of ozone', pattern: '\\bozone\\b' },
        { id: 'ministrations', label: 'ministrations', pattern: '\\bministrations?\\b' },
        { id: 'kaelen-elara', label: 'a character named Kaelen or Elara', pattern: '\\b(?:Kaelen|Elara)\\b', flags: 'g' },
    ],
});
