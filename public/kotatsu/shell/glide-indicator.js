/**
 * Kotatsu glide indicator — blue-hour-polish-v0 §4 M2/M3.
 *
 * A tab strip's "you are here" pill used to jump: the active button painted its own fill, so
 * a click swapped which button was lit. Now the strip paints ONE pill (`::before`, css/
 * kotatsu-motion.css §3) and this module tells it where the active button is, as four custom
 * properties on the strip — `--k-ind-x/-y/-w/-h`, in pixels relative to the strip's padding
 * box (scroll offset included, so a scrolling strip carries its pill with its content). The
 * sheet transitions `translate` / `width` / `height` between two writes, which is the glide.
 *
 * Why JS at all: anchor positioning can place a pill on the active tab, but when the anchor
 * changes to another element the computed value (`anchor(...)`) does not, so nothing
 * transitions. Two measured numbers do.
 *
 * `data-k-ind` on the strip is the CSS handshake: absent → the buttons keep painting their own
 * active fill (no JS, no flash); `ready` → the pill paints at its first position WITHOUT a
 * transition (no slide-in from 0,0 on mount); `live` → one frame later, transitions are on.
 * A ResizeObserver re-measures when the strip reflows (rail resize, font load, a label change).
 *
 * Pure DOM, no core imports. Callers: k-tab-rail, k-preset-pages, k-settings-modal — each from
 * its own `updated()`, which is exactly when the active button may have moved.
 */

/** @type {WeakMap<HTMLElement, ResizeObserver>} */
const observers = new WeakMap();
/** @type {WeakMap<HTMLElement, string>} strip → active selector, for the observer's re-measure */
const selectors = new WeakMap();

/**
 * @param {HTMLElement} strip
 * @param {string} activeSelector
 * @returns {void}
 */
function measure(strip, activeSelector) {
    const active = strip.querySelector(activeSelector);
    if (!(active instanceof HTMLElement) || !strip.isConnected) return;
    const s = strip.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    // A hidden strip measures 0×0; writing that would park the pill at the corner and slide it
    // out from there on the next show.
    if (a.width === 0 || a.height === 0) return;
    const x = a.left - s.left - strip.clientLeft + strip.scrollLeft;
    const y = a.top - s.top - strip.clientTop + strip.scrollTop;
    strip.style.setProperty('--k-ind-x', `${Math.round(x * 100) / 100}px`);
    strip.style.setProperty('--k-ind-y', `${Math.round(y * 100) / 100}px`);
    strip.style.setProperty('--k-ind-w', `${Math.round(a.width * 100) / 100}px`);
    strip.style.setProperty('--k-ind-h', `${Math.round(a.height * 100) / 100}px`);
    if (!strip.dataset.kInd) {
        strip.dataset.kInd = 'ready';
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (strip.dataset.kInd === 'ready') strip.dataset.kInd = 'live';
        }));
    }
}

/**
 * Point the strip's pill at its active button. Idempotent; cheap enough for every `updated()`.
 * @param {Element|null|undefined} strip The strip element (its `::before` is the pill).
 * @param {string} activeSelector Selector for the active button, relative to the strip.
 * @returns {void}
 */
export function glideIndicator(strip, activeSelector) {
    if (!(strip instanceof HTMLElement)) return;
    selectors.set(strip, activeSelector);
    measure(strip, activeSelector);
    if (!observers.has(strip) && typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => {
            const selector = selectors.get(strip);
            if (selector) measure(strip, selector);
        });
        observer.observe(strip);
        observers.set(strip, observer);
    }
}
