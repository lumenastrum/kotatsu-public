/**
 * What a poster card derives from a name and an id, and nothing else: its initials and its
 * accent hue. A leaf with no imports, so anything that draws a poster (the library's rows, the
 * marketplace's rows) can share these two without pulling core into a DOM-free module.
 * `library/view-model.js` re-exports both; that is still the place library code imports from.
 */

/**
 * Two-letter chip text for a display name. Code-point safe (names carry emoji).
 *
 * Deliberately a local copy of `k-rail-left.js`'s helper rather than an import: that module
 * does not export it, and importing it would drag Lit and the whole rail into a DOM-free file.
 * Eleven lines of pure string work is the cheaper duplicate.
 * @param {unknown} name Character or group display name.
 * @returns {string} One or two uppercase characters, or `?` for an empty name.
 */
export function toInitials(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return '?';
    }
    if (words.length === 1) {
        return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    }
    const first = Array.from(words[0])[0] ?? '';
    const second = Array.from(words[words.length - 1])[0] ?? '';
    return (first + second).toUpperCase();
}

/**
 * Deterministic accent hue for a card.
 *
 * FNV-1a over the avatar filename (the only stable per-character identity — the index moves
 * whenever the roster is re-sorted, and the name is user-editable), folded to 0-359. The
 * saturation and lightness halves of the colour are NOT decided here: they come from the
 * `--k-lib-accent-s` / `--k-lib-accent-l` band tokens, so every accent sits inside Blue Hour's
 * register and a theme pack retunes the whole gallery by changing two values. Hue is the only
 * per-card freedom, and it is a pure function of the id.
 * @param {unknown} key Avatar filename, or any stable id.
 * @returns {number} An integer in [0, 360).
 */
export function accentHue(key) {
    const text = typeof key === 'string' && key ? key : 'kotatsu';
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        // FNV prime 16777619, via shifts so the intermediate stays inside 32 bits.
        hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
    return hash % 360;
}
