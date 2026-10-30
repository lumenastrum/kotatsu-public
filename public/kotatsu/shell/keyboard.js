/**
 * Kotatsu shell — the on-screen keyboard (phone pass, 2026-10-22).
 *
 * index.html asks for `interactive-widget=resizes-content`, which Android Chrome honours: the
 * keyboard shrinks the layout viewport and the shell's `100dvh` follows it. iOS Safari ignores
 * the key. There the keyboard covers the bottom of a full-height shell, so the composer sits
 * under it, and Safari pans the window to reach the focused field; doc-scroll-pin.js puts the
 * window back at 0 the same frame, Safari pans again, and so on. On Andres's iPhone the
 * transcript could not scroll and shook on every frame of that fight.
 *
 * `visualViewport` is the one thing that knows how much screen the keyboard left. While the
 * keyboard covers more than {@link KEYBOARD_MIN}px this writes that height as `--k-vvh` on
 * <html> and `data-k-keyboard="open"` on <body>; `css/shell-frame.css` ("The keyboard") sizes
 * <html> and #k-shell to it, so the composer lands on top of the keyboard and the transcript
 * scrolls above it. With the field in view Safari has nothing to pan to, so the pin stops
 * fighting it (the pin still undoes the one pan that lands before this resize). A reader at the
 * bottom of the transcript stays at the bottom across the resize, the way a messaging app keeps
 * the latest line in view.
 *
 * Real iPhone, round two (Andres): it scrolled, but shook while the keyboard slid in, because
 * `visualViewport` only reports the keyboard's height once it has arrived, and until then Safari
 * still pans toward the field. So a tap on the composer is taken over: the touch is cancelled and
 * the field focused with `preventScroll` (still inside the tap, so the keyboard opens), and the
 * keyboard's height is applied in the same instant: the one this device last reported in this
 * orientation, or in portrait a measured first guess ({@link PORTRAIT_GUESS}). The composer is
 * already where the keyboard will stop, there is nothing to pan to, and the caret is live in one
 * motion. A focus with no on-screen keyboard behind it (an iPad with a hardware keyboard) is
 * re-read after {@link SETTLE_MS} and the shell given back.
 *
 * Every other text field (Card Studio, the scene studio, settings, popups) is sized the same way
 * before the keyboard arrives, but its tap is NOT cancelled: iOS keeps putting the caret where
 * the finger landed, which editing a long description needs, and with the sheet already sized to
 * what will be visible Safari scrolls the sheet's own scroller to the field instead of panning
 * the window. The overlays read the same `--k-vvh` (studio.css, scenes.css, kotatsu-phone.css).
 * Only taps count: a touch that travelled more than {@link TAP_SLOP}px was a scroll.
 *
 * Those fields are sized when the tap focuses them, never inside the touchend: the browser has not
 * hit-tested the tap yet, so a shell that moves there moves the field out from under the finger. The
 * tap landed on the background, the field lost focus, no keyboard opened, and the settle timer dropped
 * the shell back (public issue #3; Pixel 7 profile with real touch events, then Andres's iPhone).
 *
 * All of that tap handling is iOS only ({@link isIOS}): Android has no pan to get ahead of.
 *
 * A message opened for editing puts its caret at the end, and that end belongs just above the
 * composer. Left alone, iOS's own reveal overshot it and showed the top of the next message (Andres,
 * 2026-10-30). So for {@link SETTLE_MS} after the editor first takes focus, each resize of the viewport
 * re-places it ({@link placeEditEnd}), until the reader's finger comes down. After that it is theirs.
 *
 * Putting it away again, the messaging-app way: while the keyboard is up, a plain tap on the
 * transcript (not on a button, link or field) or a drag that pulls the story down by
 * {@link DISMISS_PULL}px blurs the field. iOS gives a web page no swipe on the keyboard itself
 * (Andres tried it, 2026-10-22: nothing), so the story is where the gesture lives. The pull stands
 * down for a field inside the transcript (a message being edited): there, dragging the story is how
 * you read what you are editing.
 *
 * Armed only on a coarse pointer: on a desktop a trackpad pinch also shrinks `visualViewport`,
 * and that must never shrink the shell. Where the layout viewport itself resizes (Android) the
 * covered height stays near zero and nothing is written.
 *
 * Installed by the rails layout's mount, removed by its unmount.
 */

/** Px of the layout viewport the keyboard must cover before the shell follows it. */
const KEYBOARD_MIN = 120;

/**
 * A first tap in portrait, before this device has ever reported its keyboard: the share of the
 * layout viewport to give it. Measured on Andres's iPhone (iOS Safari, 2026-10-22): 349 of 796px,
 * accessory bar included. Close is enough; the real height replaces it the moment it arrives.
 */
const PORTRAIT_GUESS = 0.44;

/** A reader within this many px of the transcript's end is "at the bottom". */
const BOTTOM_SLACK = 48;

/** After a predicted open, re-read the real viewport once the keyboard has had time to land. */
const SETTLE_MS = 800;

/** Px of air between the end of a message being edited and the composer. */
const EDIT_END_GAP = 12;

/** localStorage key for the last keyboard height, per viewport shape (a per-device convenience). */
const HEIGHTS_KEY = 'kotatsu.keyboardHeights';

/** A touch that moved further than this between start and end was a scroll, not a tap. */
const TAP_SLOP = 10;

/** A finger pulling the transcript down this far, with the keyboard up, puts it away. */
const DISMISS_PULL = 60;

/** What a tap on the transcript must not land on to count as "tap the story". */
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [tabindex]:not([tabindex="-1"])';

/**
 * Whether a tap on `target` was meant for a control rather than the story. Core's message controls
 * are mostly plain divs (`.mes_edit`, the swipe arrows, the reasoning toggle), so besides the real
 * controls this counts anything core styles as clickable: every one of them wears
 * `cursor: pointer`, and prose never does.
 * @param {Element | null} target
 * @returns {boolean}
 */
function isControl(target) {
    if (!target) return false;
    if (target.closest(INTERACTIVE)) return true;
    for (let el = /** @type {Element | null} */ (target); el && el.id !== 'chat'; el = el.parentElement) {
        if (getComputedStyle(el).cursor === 'pointer') return true;
    }
    return false;
}

/** @returns {boolean} Whether this is iOS, iPads asking for the desktop site included. */
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Input types that raise the text keyboard. */
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password', '']);

/** @type {((event: TouchEvent) => void) | null} */
let onTouchStart = null;

/** @type {((event: TouchEvent) => void) | null} */
let onTouchEnd = null;

/** @type {((event: FocusEvent) => void) | null} */
let onFocusIn = null;

/** The field a tap is about to focus, to be sized when it does. */
let tappedField = /** @type {HTMLElement | null} */ (null);

/** The message editor still being placed, null once that is over. */
let placingEdit = /** @type {HTMLElement | null} */ (null);

/** Pending end of the placing window, 0 when idle. */
let placeTimer = 0;

/** Editors already placed: a later focus on one is the reader coming back to it. */
const placedEdits = new WeakSet();

/** Where the current single-finger touch began, and whether it began on the transcript. */
let touchFrom = { x: 0, y: 0, onStory: false };

/** Pending settle timer, 0 when idle. */
let settleTimer = 0;

/** @type {VisualViewport | null} */
let viewport = null;

/** Pending animation frame, 0 when idle. */
let frame = 0;

/** @type {(() => void) | null} */
let onViewportChange = null;

/**
 * The layout viewport's height: the page the keyboard is laid over. NOT `innerHeight`: measured on
 * Andres's iPhone (frame telemetry, 2026-10-22), iOS Safari shrinks `innerHeight` with the keyboard
 * (796 -> 447, the same as `visualViewport.height`), so `innerHeight - visualViewport.height` read 0
 * on every tap and the shell never followed. `documentElement.clientHeight` held at 796 throughout.
 * @returns {number}
 */
function layoutHeight() {
    return document.documentElement.clientHeight;
}

/** @returns {string} The shape a remembered keyboard height belongs to. */
function shapeKey() {
    return `${window.innerWidth}x${layoutHeight()}`;
}

/** @returns {number | null} This shape's last keyboard height, if it opened one before. */
function rememberedHeight() {
    try {
        const heights = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? '{}');
        const value = Number(heights?.[shapeKey()]);
        return Number.isFinite(value) && value > KEYBOARD_MIN ? value : null;
    } catch {
        return null;
    }
}

/** @param {number} covered */
function rememberHeight(covered) {
    try {
        const heights = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? '{}');
        heights[shapeKey()] = Math.round(covered);
        localStorage.setItem(HEIGHTS_KEY, JSON.stringify(heights));
    } catch {
        // Private mode or blocked storage: the next open measures again.
    }
}

/**
 * The transcript on screen, picked by what is laid out rather than by id alone. A query string on
 * the page once made core's Backgrounds tabs load a hidden second copy of the whole app (fixed in
 * scripts/backgrounds.js, 2026-10-22), and `getElementById` answered with that copy's 0x0 #chat;
 * an id is not proof of the element on screen.
 * @returns {HTMLElement | null}
 */
function visibleChat() {
    for (const el of document.querySelectorAll('#chat')) {
        if (el instanceof HTMLElement && el.clientHeight > 0) return el;
    }
    return null;
}

/**
 * Sizes the shell to `visible` px (or gives it back with null) and keeps a reader who was at the
 * end of the transcript at the end.
 * @param {number | null} visible
 * @returns {void}
 */
function applyVisible(visible) {
    const root = document.documentElement;
    const chatElement = visibleChat();
    const wasAtBottom = chatElement instanceof HTMLElement
        && chatElement.scrollHeight - chatElement.scrollTop - chatElement.clientHeight <= BOTTOM_SLACK;

    if (visible === null) {
        root.style.removeProperty('--k-vvh');
        delete document.body.dataset.kKeyboard;
    } else {
        root.style.setProperty('--k-vvh', `${Math.round(visible)}px`);
        document.body.dataset.kKeyboard = 'open';
    }

    if (wasAtBottom && chatElement instanceof HTMLElement) {
        // Now, so the frame that shows the new height already shows the end.
        chatElement.scrollTop = chatElement.scrollHeight;
    }
}

/**
 * Puts the end of the message being edited just above the composer, unless all of it already shows.
 * @returns {void}
 */
function placeEditEnd() {
    const chatElement = visibleChat();
    if (!placingEdit?.isConnected || !chatElement || !viewport) return;
    const view = chatElement.getBoundingClientRect();
    const box = placingEdit.getBoundingClientRect();
    const composerTop = document.getElementById('form_sheld')?.getBoundingClientRect().top ?? Infinity;
    const limit = Math.min(view.bottom, composerTop, viewport.offsetTop + viewport.height) - EDIT_END_GAP;
    if (box.bottom > limit || box.top < view.top) chatElement.scrollTop += box.bottom - limit;
}

/** Ends the placing window, whether it ran out or the reader took over. */
function stopPlacingEdit() {
    if (placeTimer !== 0) clearTimeout(placeTimer);
    placeTimer = 0;
    placingEdit = null;
}

/**
 * Applies what the visual viewport says now. Runs at most once a frame.
 * @returns {void}
 */
function sync() {
    frame = 0;
    if (!viewport) return;
    const covered = layoutHeight() - viewport.height;
    if (covered > KEYBOARD_MIN) {
        rememberHeight(covered);
        applyVisible(viewport.height);
    } else {
        applyVisible(null);
    }
    placeEditEnd();
}

/**
 * @param {EventTarget | null} target
 * @returns {target is HTMLElement} Whether a tap on it raises the text keyboard.
 */
function isTextField(target) {
    if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
    if (target instanceof HTMLInputElement) return TEXT_INPUTS.has(target.type) && !target.disabled && !target.readOnly;
    return target instanceof HTMLElement && target.isContentEditable;
}

/** Sizes the shell for the keyboard that is about to open, and re-reads the truth once it has. */
function presize() {
    const layout = layoutHeight();
    const portrait = layout > window.innerWidth;
    const predicted = rememberedHeight() ?? (portrait ? Math.round(layout * PORTRAIT_GUESS) : null);
    if (predicted !== null) applyVisible(layout - predicted);

    if (settleTimer !== 0) clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        sync();
    }, SETTLE_MS);
}

/** @param {TouchEvent} event */
function noteTouchStart(event) {
    const touch = event.touches[0];
    const target = event.target instanceof Element ? event.target : null;
    tappedField = null;
    stopPlacingEdit();
    if (touch) touchFrom = { x: touch.clientX, y: touch.clientY, onStory: Boolean(target?.closest('#chat')) };
}

/**
 * With the keyboard up, a tap on the story or a pull down through it puts the keyboard away.
 * @param {TouchEvent} event
 * @returns {boolean} Whether it did.
 */
function dismissFromStory(event) {
    if (document.body.dataset.kKeyboard !== 'open' || !touchFrom.onStory || event.touches.length > 0) return false;
    const active = document.activeElement;
    if (!isTextField(active)) return false;
    const lifted = event.changedTouches[0];
    if (!lifted) return false;
    const travelled = Math.hypot(lifted.clientX - touchFrom.x, lifted.clientY - touchFrom.y);
    const pulledDown = lifted.clientY - touchFrom.y >= DISMISS_PULL && !active.closest('#chat');
    const target = event.target instanceof Element ? event.target : null;
    const plainTap = travelled <= TAP_SLOP && !isControl(target);
    if (!pulledDown && !plainTap) return false;
    active.blur();
    return true;
}

/**
 * A tap that will open the keyboard: size first, so Safari has nothing to pan to.
 * @param {TouchEvent} event
 * @returns {void}
 */
function takeFieldTap(event) {
    if (dismissFromStory(event)) return;
    if (!isIOS()) return;
    // The field touched, not `getElementById`'s answer (see visibleChat for why an id can lie).
    const field = event.target;
    if (!isTextField(field)) return;
    if (event.touches.length > 0) return;
    const lifted = event.changedTouches[0];
    if (lifted && Math.hypot(lifted.clientX - touchFrom.x, lifted.clientY - touchFrom.y) > TAP_SLOP) return;
    // Already typing: the tap moves the caret, which is the browser's job. But a field can stay
    // focused with its keyboard put away (measured on Andres's iPhone, 2026-10-22), and Safari's tap on it then
    // reopened the keyboard with the full 349px pan. That tap is ours too.
    const reopening = document.activeElement === field;
    if (reopening && document.body.dataset.kKeyboard === 'open') return;

    const composer = field instanceof HTMLTextAreaElement && field.id === 'send_textarea';
    if (!composer) {
        // The browser focuses it and puts the caret under the finger; size it when that happens.
        // A field already focused fires nothing: its keyboard's own resize sizes the shell.
        tappedField = field;
        return;
    }
    if (!event.cancelable) return;

    // The composer is taken whole: cancel the tap and focus without the scroll, caret at the end.
    // A focus() on a focused field opens nothing, so a reopen blurs first, inside the same tap.
    event.preventDefault();
    presize();
    if (reopening) field.blur();
    field.focus({ preventScroll: true });
    const end = field.value.length;
    field.setSelectionRange(end, end);
}

/** @returns {void} */
export function installKeyboard() {
    if (viewport || !window.visualViewport) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;

    viewport = window.visualViewport;
    onViewportChange = () => {
        if (frame === 0) frame = requestAnimationFrame(sync);
    };
    viewport.addEventListener('resize', onViewportChange);
    viewport.addEventListener('scroll', onViewportChange);
    onTouchStart = noteTouchStart;
    onTouchEnd = takeFieldTap;
    onFocusIn = (event) => {
        const field = event.target;
        if (field instanceof HTMLElement && field.id === 'curEditTextarea' && !placedEdits.has(field)) {
            placedEdits.add(field);
            stopPlacingEdit();
            placingEdit = field;
            placeTimer = window.setTimeout(() => {
                placeEditEnd();
                stopPlacingEdit();
            }, SETTLE_MS);
        }
        if (field !== tappedField) return;
        tappedField = null;
        presize();
    };
    document.addEventListener('focusin', onFocusIn, { capture: true });
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    // Not passive: cancelling the touch is what stops Safari's own focus-and-scroll.
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
    sync();
}

/**
 * Removes the listeners, the custom property and the body attribute, so classic inherits none.
 * @returns {void}
 */
export function uninstallKeyboard() {
    if (!viewport) return;
    if (onViewportChange) {
        viewport.removeEventListener('resize', onViewportChange);
        viewport.removeEventListener('scroll', onViewportChange);
    }
    if (onTouchStart) document.removeEventListener('touchstart', onTouchStart, { capture: true });
    if (onTouchEnd) document.removeEventListener('touchend', onTouchEnd, { capture: true });
    if (onFocusIn) document.removeEventListener('focusin', onFocusIn, { capture: true });
    onTouchStart = null;
    onTouchEnd = null;
    onFocusIn = null;
    tappedField = null;
    stopPlacingEdit();
    if (settleTimer !== 0) clearTimeout(settleTimer);
    settleTimer = 0;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    viewport = null;
    onViewportChange = null;
    document.documentElement.style.removeProperty('--k-vvh');
    delete document.body.dataset.kKeyboard;
}
