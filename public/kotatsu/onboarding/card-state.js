/**
 * Mikan-chan's welcome tour — the First card step's decisions (docs/onboarding-v0.md §2.4,
 * slice O5). No DOM, no core imports.
 *
 * ── Why there is anything to decide ──────────────────────────────────────────────────────────
 * None of core's ways in says what happened. `processDroppedFiles()` and
 * `importFromExternalUrl()` return nothing; the card studio has no "done" event. Success and
 * failure both end in a toast. So the step takes the library's avatars before, takes them again
 * after, listens to what core's toasts said in between, and this module turns those three into
 * one answer: a card landed (which one), something went wrong (core's own words), or nothing
 * happened at all (the studio was closed without making anyone).
 */

/** The card every install is seeded with (`default/content/index.json`). */
export const SEEDED_AVATAR = 'default_Seraphina.png';

/**
 * @typedef {object} Toast A toast core raised while the step was bringing a card in.
 * @property {'success'|'info'|'warning'|'error'} level
 * @property {string} message
 * @property {string} title
 */

/**
 * @typedef {{state: 'landed', avatar: string} | {state: 'problem', text: string} | {state: 'nothing'}} CardOutcome
 */

/**
 * Avatars that are in `after` and were not in `before`, in `after`'s order.
 * @param {readonly string[]} before Avatars before.
 * @param {readonly string[]} after Avatars after.
 * @returns {string[]} The new ones.
 */
export function newAvatars(before, after) {
    const known = new Set(Array.isArray(before) ? before : []);
    return (Array.isArray(after) ? after : []).filter(avatar => typeof avatar === 'string' && avatar !== '' && !known.has(avatar));
}

/**
 * A toast as one sentence: its title, then what it said. Core puts the useful half in either.
 * @param {Toast} toast Toast.
 * @returns {string} Text, '' when it said nothing.
 */
export function toastText(toast) {
    const clean = (/** @type {unknown} */ value) => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = clean(toast?.title).replace(/[.:]+$/, '');
    const message = clean(toast?.message);
    if (title && message) return `${title}: ${message}`;
    return title || message;
}

/** Core's two success toasts for an import: "Character Created: Name" / "Character Replaced: Name". */
const IMPORTED = /^Character (?:Created|Replaced):\s*(.+)$/i;

/**
 * What bringing a card in came to.
 * @param {object} input Input.
 * @param {readonly string[]} input.before The library's avatars before.
 * @param {readonly string[]} input.after The library's avatars after.
 * @param {readonly Toast[]} [input.toasts] Toasts core raised in between.
 * @returns {CardOutcome} The outcome.
 */
export function cardOutcome({ before, after, toasts = [] }) {
    const fresh = newAvatars(before, after);
    // Several files dropped at once: the last one in is the one core selects too.
    if (fresh.length > 0) return { state: 'landed', avatar: fresh[fresh.length - 1] };

    const list = Array.isArray(toasts) ? toasts : [];
    // A card imported over itself adds no avatar; core's own toast is the only witness.
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.level !== 'success') continue;
        const named = IMPORTED.exec(String(list[i].message ?? '').trim());
        const avatar = named ? `${named[1].trim()}.png` : '';
        if (avatar && (after ?? []).includes(avatar)) return { state: 'landed', avatar };
    }

    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.level === 'success') continue;
        const text = toastText(list[i]);
        if (text) return { state: 'problem', text };
    }
    return { state: 'nothing' };
}

/**
 * The link field's text, ready to hand to core, or '' when there is nothing to try. Core takes
 * a web address or a bare character id (it tries the id against Chub and friends), so this does
 * not insist on `https://`.
 * @param {unknown} text Field value.
 * @returns {string} The link.
 */
export function cleanLink(text) {
    return String(text ?? '').trim().replace(/\s+/g, '');
}

/**
 * @param {readonly string[]} avatars The library's avatars.
 * @returns {string} The seeded card's avatar when she is still in the library, else ''.
 */
export function findSeeded(avatars) {
    return Array.isArray(avatars) && avatars.includes(SEEDED_AVATAR) ? SEEDED_AVATAR : '';
}
