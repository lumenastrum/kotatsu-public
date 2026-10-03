/**
 * Kotatsu shell — extension dock yield (ext gauntlet 2026-10-02, finding 1).
 *
 * Stock SillyTavern centres a ~55vw chat column and leaves empty margins either side, and
 * third-party extensions park side panels in them: `position: fixed`, hugging a viewport edge,
 * nearly full height. The rails layout fills those margins with its own rails, so the panels
 * landed on top of them. This module makes the shell YIELD: when a foreign panel is docked to
 * an edge, the frame gives that edge up, the panel keeps its margin, and the rails and the
 * centre column sit beside it.
 *
 * Two layers, like `rail-collapse.js`:
 *
 * - A PURE core (`classifyDock`, `measureDock`, `resolveInsets`) that knows nothing about the
 *   DOM and is unit-tested (`tests/ext-dock.test.js`).
 * - A DOM layer that finds candidate panels, measures them, and publishes the verdict as two
 *   inline custom properties on `<body>` (`--k-ext-inset-left` / `--k-ext-inset-right`) plus
 *   `body[data-k-ext-dock]`. `css/shell-ext-dock.css` turns those into a frame margin; the rail
 *   resolver reads {@link getExtDockInsets} and re-resolves on {@link EXT_DOCK_EVENT}.
 *
 * Cost discipline: the chat streams tokens into the DOM many times a second, so nothing here
 * observes `<body>` with `subtree`. Only body's direct `childList` is watched (a panel being
 * added or removed), plus a ResizeObserver and a `class`/`style`/`hidden` attribute observer on
 * each direct child alone. Every trigger coalesces into one measurement per animation frame.
 * Panels that animate open by CSS transition do not fire ResizeObserver, so `transitionend` and
 * a short trailing re-measure cover them.
 *
 * Never runs under classic: `layouts/rails.js` installs it on mount and uninstalls it on
 * unmount. One-way imports: this file imports nothing (so `rail-collapse.js` can import it
 * without a cycle).
 */

/** A panel must be at least this fraction of the viewport height to count as a dock. */
export const MIN_HEIGHT_RATIO = 0.6;

/** Narrower than this (px) is a button, toggle or dropdown, not a panel. */
export const MIN_DOCK_WIDTH = 120;

/** Wider than this fraction of the viewport is an overlay, modal or scrim, not a side panel. */
export const MAX_WIDTH_RATIO = 0.45;

/** How far (px) a rectangle may sit from a viewport edge and still count as flush to it. */
export const EDGE_TOLERANCE = 2;

/** Fallback for the frame floor when `--k-center-readable-min` is missing (tokens.css). */
const DEFAULT_MIN_FRAME = 560;

/** Trailing re-measure (ms) after any trigger, for transitions that end without an event. */
const TRAILING_MS = 400;

/** Fired on `document` when either published inset or the dock attribute changes. */
export const EXT_DOCK_EVENT = 'k-ext-dock-change';

/**
 * @typedef {{ left: number, right: number, width: number, height: number }} DockRect
 *   The slice of a `DOMRect` the pure core reads. Viewport coordinates.
 * @typedef {{ width: number, height: number }} DockViewport
 * @typedef {'left' | 'right'} DockSide
 * @typedef {{ side: DockSide, inset: number }} Dock
 *   `inset` is how much of that edge the panel occupies, flush gap included.
 * @typedef {{ left: number, right: number }} DockInsets
 */

/**
 * The part of a rectangle that is actually on screen, horizontally.
 * @param {DockRect} rect
 * @param {DockViewport} viewport
 * @returns {number}
 */
function visibleWidth(rect, viewport) {
    return Math.min(rect.right, viewport.width) - Math.max(rect.left, 0);
}

/**
 * Which edge, if any, a rectangle is docked to.
 *
 * A dock is tall (at least {@link MIN_HEIGHT_RATIO} of the viewport), mid-width (between
 * {@link MIN_DOCK_WIDTH} and {@link MAX_WIDTH_RATIO} of the viewport, measured on the part
 * that is on screen so a drawer parked past the edge never counts) and flush to an edge within
 * {@link EDGE_TOLERANCE}. Anything wider or shorter is chrome of some other kind.
 * @param {DockRect} rect
 * @param {DockViewport} viewport
 * @returns {DockSide | null}
 */
export function classifyDock(rect, viewport) {
    if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
    if (rect.height < viewport.height * MIN_HEIGHT_RATIO) return null;
    const shown = visibleWidth(rect, viewport);
    if (shown < MIN_DOCK_WIDTH || shown > viewport.width * MAX_WIDTH_RATIO) return null;
    if (rect.right >= viewport.width - EDGE_TOLERANCE) return 'right';
    if (rect.left <= EDGE_TOLERANCE) return 'left';
    return null;
}

/**
 * Classifies a rectangle and sizes the edge it takes. The inset runs from the viewport edge to
 * the panel's inner edge, so a panel that floats 2px off the edge still gets that gap back.
 * @param {DockRect} rect
 * @param {DockViewport} viewport
 * @returns {Dock | null}
 */
export function measureDock(rect, viewport) {
    const side = classifyDock(rect, viewport);
    if (!side) return null;
    const inset = side === 'right'
        ? viewport.width - Math.max(rect.left, 0)
        : Math.min(rect.right, viewport.width);
    return { side, inset: Math.round(inset) };
}

/**
 * The per-side insets the frame should give up.
 *
 * Per side the inset is the WIDEST dock on that side: overlapping panels share one column, and
 * stacking them is the extensions' own business. Then the pair is clamped so the frame keeps at
 * least `limits.minFrame` px. When both sides cannot fit, the RIGHT inset survives and the LEFT
 * yields first. That is a deliberate departure from `rail-collapse.js`, whose resolver
 * suppresses the right rail first (the right rail is the prompt dock, and the chat list on the
 * left is the primary navigation); here the right edge is where extension panels overwhelmingly
 * live, so it is the side worth protecting.
 * @param {Dock[]} docks
 * @param {DockViewport} viewport
 * @param {{ minFrame: number }} limits
 * @returns {DockInsets}
 */
export function resolveInsets(docks, viewport, limits) {
    let left = 0;
    let right = 0;
    for (const dock of docks) {
        const inset = Number.isFinite(dock.inset) ? Math.max(0, dock.inset) : 0;
        if (dock.side === 'left') left = Math.max(left, inset);
        else if (dock.side === 'right') right = Math.max(right, inset);
    }
    const room = Math.max(0, viewport.width - limits.minFrame);
    // A clamped sliver cannot hold a panel, so a side squeezed under the dock minimum yields
    // outright rather than leaving a dead strip (a 600px window with a 310px panel).
    right = Math.min(right, room);
    if (right < MIN_DOCK_WIDTH) right = 0;
    left = Math.min(left, room - right);
    if (left < MIN_DOCK_WIDTH) left = 0;
    return { left, right };
}

// ── DOM layer ───────────────────────────────────────────────────────────────

/** Direct children of `<body>` that are never candidates, by tag. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE', 'DIALOG']);

/** Direct children of `<body>` that are never candidates, by id (plus every `k-` id). */
const SKIP_IDS = new Set(['bg1', 'movingDivs', 'toast-container']);

/** Attributes whose change can move a panel or hide it. */
const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden'];

let installed = false;

/** @type {DockInsets} */
let insets = { left: 0, right: 0 };

/** @type {string | null} The `data-k-ext-dock` value last published. */
let published = null;

/** Whether the two properties have been written since install (the `0px` baseline). */
let written = false;

/** @type {ResizeObserver | null} */
let resizeObserver = null;

/** @type {MutationObserver | null} */
let childObserver = null;

/** Per-element attribute observers, so a removed panel can be let go of. @type {Map<Element, MutationObserver>} */
const attrObservers = new Map();

/** @type {(() => void) | null} */
let onWindowResize = null;

/** @type {((event: Event) => void) | null} */
let onTransitionEnd = null;

let frame = 0;
let trailing = 0;

/**
 * Whether a direct child of `<body>` could ever be an extension dock, judged by identity alone.
 * Position and visibility are judged at measure time, because a class toggle can change either.
 * @param {Element} el
 * @returns {boolean}
 */
function isCandidate(el) {
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.tagName.startsWith('K-')) return false;
    const id = el.id;
    return !(id && (id.startsWith('k-') || SKIP_IDS.has(id)));
}

/**
 * Whether a candidate is currently a positioned, visible element.
 * @param {Element} el
 * @returns {boolean}
 */
function isLive(el) {
    const style = getComputedStyle(el);
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return Number.parseFloat(style.opacity) !== 0;
}

/**
 * The widest frame squeeze the viewport allows: `--k-center-readable-min`, the same floor the
 * rail resolver protects, so a dock never eats the reading column on a narrow window.
 * @returns {number}
 */
function readMinFrame() {
    const parsed = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--k-center-readable-min'));
    return Number.isFinite(parsed) ? parsed : DEFAULT_MIN_FRAME;
}

/**
 * Starts or stops watching one direct child of `<body>`.
 * @param {Element} el
 * @param {boolean} watch
 * @returns {void}
 */
function setWatched(el, watch) {
    const has = attrObservers.has(el);
    if (watch && !has) {
        resizeObserver?.observe(el);
        const observer = new MutationObserver(trigger);
        observer.observe(el, { attributes: true, attributeFilter: WATCHED_ATTRIBUTES });
        attrObservers.set(el, observer);
    } else if (!watch && has) {
        resizeObserver?.unobserve(el);
        attrObservers.get(el)?.disconnect();
        attrObservers.delete(el);
    }
}

/**
 * Reconciles the watched set with body's current direct children.
 * @returns {void}
 */
function syncWatched() {
    const present = new Set();
    for (const el of document.body.children) {
        if (!isCandidate(el)) continue;
        present.add(el);
        setWatched(el, true);
    }
    for (const el of [...attrObservers.keys()]) {
        if (!present.has(el)) setWatched(el, false);
    }
}

/**
 * Measures every live candidate and publishes the result.
 * @returns {void}
 */
function measure() {
    if (!installed) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    /** @type {Dock[]} */
    const docks = [];
    for (const el of attrObservers.keys()) {
        if (!isLive(el)) continue;
        const dock = measureDock(el.getBoundingClientRect(), viewport);
        if (dock) docks.push(dock);
    }
    publish(resolveInsets(docks, viewport, { minFrame: readMinFrame() }));
}

/**
 * Writes the insets to `<body>` and announces a change, only when something differs.
 * @param {DockInsets} next
 * @returns {void}
 */
function publish(next) {
    const attribute = next.left > 0 && next.right > 0 ? 'both' : next.left > 0 ? 'left' : next.right > 0 ? 'right' : null;
    const changed = next.left !== insets.left || next.right !== insets.right || attribute !== published;
    if (!changed && written) return;
    insets = next;
    published = attribute;
    const { body } = document;
    body.style.setProperty('--k-ext-inset-left', `${next.left}px`);
    body.style.setProperty('--k-ext-inset-right', `${next.right}px`);
    if (attribute) body.dataset.kExtDock = attribute;
    else delete body.dataset.kExtDock;
    // The first write only establishes the `0px` baseline; nothing changed for anyone to hear.
    const first = !written;
    written = true;
    if (first && !changed) return;
    document.dispatchEvent(new CustomEvent(EXT_DOCK_EVENT, { detail: { ...next } }));
}

/** One measurement on the next animation frame, however many callers ask. */
function scheduleFrame() {
    if (frame || !installed) return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
    });
}

/**
 * Any signal that a panel may have moved: measure next frame, and once more shortly after for
 * transitions that finish without telling anyone. The trailing call goes straight to the frame
 * scheduler, never back through here, so it cannot re-arm itself.
 * @returns {void}
 */
function trigger() {
    scheduleFrame();
    clearTimeout(trailing);
    trailing = window.setTimeout(scheduleFrame, TRAILING_MS);
}

/**
 * The current insets, in px. A copy. Zero when not installed.
 * @returns {DockInsets}
 */
export function getExtDockInsets() {
    return { ...insets };
}

/**
 * Re-scans body's children and measures now. The debug handle's `rescan()`.
 * @returns {DockInsets}
 */
export function rescanExtDock() {
    if (!installed) return getExtDockInsets();
    syncWatched();
    measure();
    return getExtDockInsets();
}

/**
 * Starts watching for docked extension panels. Rails layout only.
 * @returns {void}
 */
export function installExtDock() {
    if (installed) return;
    installed = true;

    resizeObserver = new ResizeObserver(trigger);
    childObserver = new MutationObserver(() => {
        syncWatched();
        trigger();
    });
    childObserver.observe(document.body, { childList: true });
    onWindowResize = trigger;
    window.addEventListener('resize', onWindowResize);
    // Transitions and animations on a panel itself bubble up to the document; a descendant's
    // own transition is not a panel moving, so only direct children of <body> count.
    onTransitionEnd = (event) => {
        const target = event.target;
        if (target instanceof Element && target.parentElement === document.body) trigger();
    };
    document.addEventListener('transitionend', onTransitionEnd, true);
    document.addEventListener('animationend', onTransitionEnd, true);

    syncWatched();
    measure();

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') {
        targetWindow.kotatsu = {};
    }
    targetWindow.kotatsu.extDock = { getInsets: getExtDockInsets, rescan: rescanExtDock };
}

/**
 * Disconnects every observer and listener and clears everything published. No event is fired:
 * the only caller is the layout unmount, which is also tearing down the listener.
 * @returns {void}
 */
export function uninstallExtDock() {
    if (!installed) return;
    installed = false;

    resizeObserver?.disconnect();
    resizeObserver = null;
    childObserver?.disconnect();
    childObserver = null;
    for (const observer of attrObservers.values()) observer.disconnect();
    attrObservers.clear();
    if (onWindowResize) {
        window.removeEventListener('resize', onWindowResize);
        onWindowResize = null;
    }
    if (onTransitionEnd) {
        document.removeEventListener('transitionend', onTransitionEnd, true);
        document.removeEventListener('animationend', onTransitionEnd, true);
        onTransitionEnd = null;
    }
    if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
    }
    clearTimeout(trailing);
    trailing = 0;

    insets = { left: 0, right: 0 };
    published = null;
    written = false;
    document.body.style.removeProperty('--k-ext-inset-left');
    document.body.style.removeProperty('--k-ext-inset-right');
    delete document.body.dataset.kExtDock;
    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (targetWindow.kotatsu) delete targetWindow.kotatsu.extDock;
}
