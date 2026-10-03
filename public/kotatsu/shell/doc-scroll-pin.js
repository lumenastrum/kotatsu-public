/**
 * Kotatsu shell — the document never scrolls (ext gauntlet 2026-10-02, finding 7).
 *
 * Under rails the whole frame is `position: fixed` and the only scrollers are inside it, so
 * the document has no business scrolling. It still can: `html` is `overflow: visible`, and the
 * moment anything makes the page taller than the viewport (Character Library's closed launcher
 * dropdown did, by 25px) a programmatic `scrollIntoView` scrolls the viewport and the frame
 * slides up with it — fixed elements ride the layout viewport.
 *
 * Measured 2026-10-02 (`playwright-rig/scripts/kotatsu-doc-scroll-diag.mjs`): no CSS guard
 * stops it. `overflow: clip` or `hidden` on `html`, on `body`, or on both all propagate to the
 * viewport as `hidden`, and a hidden viewport is still scrollable by script (the spec says so;
 * the measurement agrees: y=25 every time). So the guard is a pin: whatever scrolled the
 * document, put it back. Scroll events dispatch in the "update the rendering" step before
 * paint, so the reset lands in the same frame and nothing is ever drawn off (sampled at every
 * animation frame: y=0 throughout).
 *
 * Only the document is pinned. A `scrollIntoView` aimed at a message still scrolls `#chat`,
 * its own scroller; this undoes just the viewport's share.
 */

/** @type {(() => void)|null} */
let listener = null;

/** @returns {void} */
export function installDocScrollPin() {
    if (listener) return;
    listener = () => {
        if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    window.addEventListener('scroll', listener, { passive: true });
    // Whatever happened before the layout mounted.
    listener();
}

/** @returns {void} */
export function uninstallDocScrollPin() {
    if (!listener) return;
    window.removeEventListener('scroll', listener);
    listener = null;
}
