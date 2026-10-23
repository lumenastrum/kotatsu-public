/**
 * Kotatsu shell — the bars step aside while you read, on a phone (reader polish, 2026-10-22).
 *
 * On a 390-wide phone the top bar and the chat header strip are 88px of a ~660px Safari window,
 * every one of them above the story. While the reader scrolls DOWN through the transcript they
 * step aside (`data-k-reading-bar="hidden"` on <body>, css/kotatsu-phone.css §7), and the first
 * scroll UP brings them back: the pattern every phone reader and browser uses for its own bars.
 *
 * The bars float over the story on a phone (the transcript runs under them, padded), so hiding
 * them is a transform and nothing in the layout moves: the line under the reader's eye cannot
 * jump. (Collapsing real rows and correcting the scroll fought the browser's own touch scrolling
 * and flickered every 10px; probe, 2026-10-22.)
 *
 * Only the reader's own scrolling counts: a scroll while a finger is down, or within
 * {@link GLIDE_MS} ms of lifting a finger that WAS scrolling (the momentum after a flick). A tap
 * opens no window: tapping a chat in the rail and core's scroll to its latest message would
 * otherwise read as the reader scrolling down and hide the bars on arrival. A streaming reply's auto-scroll
 * and a jump to the latest message never flip the bars. Finger-down is read from touchstart and
 * touchend, NOT touchmove: iOS Safari stops sending touchmove once its own scrolling takes the
 * drag, so mid-transcript every scroll looked programmatic and the bars only hid on a drag that
 * started at the very top (Andres's iPhone, 2026-10-22; the emulator always sends touchmove). They always show near the top of the transcript,
 * while a keyboard is up (keyboard.js), while a rail sheet is open, and on a chat switch.
 *
 * Phones only: `(max-width: 600px)`, the line kotatsu-phone.css draws. Installed by the rails
 * layout's mount, removed by its unmount.
 */

import { event_types, eventSource } from '../../scripts/events.js';

const PHONE_QUERY = '(max-width: 600px)';

/** Px of finger-driven travel in one direction before the bars move. */
const TRAVEL = 24;

/** Within this many px of the transcript's top the bars always show. */
const NEAR_TOP = 80;

/** After the finger lifts, the momentum glide still counts as the reader's own for this long. */
const GLIDE_MS = 1000;

/** @type {MediaQueryList | null} */
let phone = null;

/** @type {HTMLElement | null} */
let scroller = null;

let lastTop = 0;
let travel = 0;
let fingerDown = false;
let lifted = 0;
/** Whether the current (or last) touch moved the transcript. */
let touchScrolled = false;

/** @type {Array<[EventTarget, string, EventListener, AddEventListenerOptions | boolean | undefined]>} */
let bound = [];

/** @type {(() => void) | null} */
let onChatChanged = null;

/** @returns {boolean} */
function isHidden() {
    return document.body.dataset.kReadingBar === 'hidden';
}

/** @returns {boolean} Whether something on screen needs the bars. */
function barsWanted() {
    const body = document.body;
    return body.dataset.kKeyboard === 'open'
        || body.dataset.kRailLeft === 'open'
        || body.dataset.kRailRight === 'open'
        || body.dataset.kView !== 'chat';
}

/**
 * @param {boolean} hidden
 * @returns {void}
 */
function setHidden(hidden) {
    travel = 0;
    if (hidden === isHidden()) return;
    if (hidden) document.body.dataset.kReadingBar = 'hidden';
    else delete document.body.dataset.kReadingBar;
}

function onScroll() {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const delta = top - lastTop;
    lastTop = top;
    if (!phone?.matches) return;
    if (top < NEAR_TOP || barsWanted()) {
        setHidden(false);
        return;
    }
    // Not the reader's hand: a streaming reply, a jump to the latest, a programmatic scroll.
    if (fingerDown) touchScrolled = true;
    else if (!touchScrolled || performance.now() - lifted > GLIDE_MS) return;
    travel = Math.sign(delta) === Math.sign(travel) ? travel + delta : delta;
    if (travel > TRAVEL) setHidden(true);
    else if (travel < -TRAVEL) setHidden(false);
}

/** @param {TouchEvent} event */
function onTouchStart(event) {
    fingerDown = event.touches.length > 0;
    touchScrolled = false;
}

/** @param {TouchEvent} event */
function onTouchEnd(event) {
    fingerDown = event.touches.length > 0;
    lifted = performance.now();
}

/** Bars back whenever something needs them, or the layout leaves the phone. */
function onStateChange() {
    if (!phone?.matches || barsWanted()) setHidden(false);
}

/**
 * @param {EventTarget} target
 * @param {string} type
 * @param {EventListener} listener
 * @param {AddEventListenerOptions | boolean} [options]
 */
function listen(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    bound.push([target, type, listener, options]);
}

/** @type {MutationObserver | null} */
let bodyWatch = null;

/** @returns {void} */
export function installReadingBar() {
    if (phone) return;
    const chatElement = document.getElementById('chat');
    if (!(chatElement instanceof HTMLElement)) return;
    scroller = chatElement;
    phone = window.matchMedia(PHONE_QUERY);
    lastTop = scroller.scrollTop;

    listen(scroller, 'scroll', onScroll, { passive: true });
    listen(document, 'touchstart', /** @type {EventListener} */ (onTouchStart), { capture: true, passive: true });
    listen(document, 'touchend', /** @type {EventListener} */ (onTouchEnd), { capture: true, passive: true });
    listen(document, 'touchcancel', /** @type {EventListener} */ (onTouchEnd), { capture: true, passive: true });
    listen(phone, 'change', onStateChange);
    // Keyboard, rails and view all live as <body> attributes: one watcher covers them.
    bodyWatch = new MutationObserver(onStateChange);
    bodyWatch.observe(document.body, { attributes: true, attributeFilter: ['data-k-keyboard', 'data-k-rail-left', 'data-k-rail-right', 'data-k-view'] });
    onChatChanged = () => setHidden(false);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

/** @returns {void} */
export function uninstallReadingBar() {
    if (!phone) return;
    for (const [target, type, listener, options] of bound) target.removeEventListener(type, listener, options);
    bound = [];
    bodyWatch?.disconnect();
    bodyWatch = null;
    if (onChatChanged) eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    onChatChanged = null;
    delete document.body.dataset.kReadingBar;
    phone = null;
    scroller = null;
}
