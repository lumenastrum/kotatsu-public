/**
 * Where the phone theatre's textbox turns its page (docs/vn-theatre-v0.md §5). Pure: theatre.js measures the prose
 * box's line boxes and hands them here, Jest drives it directly.
 *
 * A page ends at the last line that is wholly readable: above the box's bottom edge AND above its fade (the foot that
 * says there is more). The next page starts at the first line that wasn't, so no line is ever sliced in half or read
 * twice. Paragraph gaps and mixed line heights don't matter: these are the browser's own line boxes.
 */

/**
 * @typedef {object} PageView
 * @property {number} top Viewport y of the box's content top (border box top + padding top).
 * @property {number} readable Viewport y below which a line isn't fully readable (box bottom − the fade's height).
 * @property {number} scrollTop The box's current scroll offset.
 * @property {number} maxScroll scrollHeight − clientHeight.
 * @property {number} fallback How far to move when no line can be measured (about a page).
 */

/**
 * The scroll offset of the next page, or null when this is the last page.
 * @param {{ top: number, bottom: number }[]} lines Line boxes in viewport coordinates (any order, any count).
 * @param {PageView} view
 * @returns {number | null}
 */
export function nextPageOffset(lines, view) {
    if (view.scrollTop >= view.maxScroll - 1) return null;
    let next = Infinity;
    for (const line of lines) {
        if (line.bottom - line.top < 1) continue;
        // The first line that isn't wholly readable, and starts below the top (a tall line that already began is read).
        if (line.bottom > view.readable + 0.5 && line.top > view.top + 0.5 && line.top < next) next = line.top;
    }
    const target = Number.isFinite(next) ? view.scrollTop + (next - view.top) : view.scrollTop + view.fallback;
    // Always move forward, never past the end.
    return Math.min(view.maxScroll, Math.max(view.scrollTop + 1, Math.round(target)));
}
