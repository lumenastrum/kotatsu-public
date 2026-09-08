/**
 * Kotatsu shell — view state: is the frame serving a chat, or serving home?
 *
 * Home is `getCurrentChatId() === undefined`. The rails exist to serve an
 * ACTIVE chat — the right rail docks chat tooling (prompt, world, trackers),
 * the left rail is the hallway between conversations. On home both are
 * redundant with the screen itself: the gallery IS the character list and the
 * continue strip IS recents, so every column of rail is real estate taken from
 * the cast. The frame hands the width back and the hearth runs full-bleed.
 *
 * The pattern is rail-collapse.js exactly: this module owns the STATE, and all
 * it ever does to the document is write `data-k-view` ("home" | "chat") on
 * `<body>`; `css/shell-frame.css` ("View state" section) owns the mechanism.
 * View state is deliberately a SEPARATE attribute from `data-k-rail-*`: hiding
 * rails on home must not write — or race — the user's persisted collapse
 * choice, so leaving home restores exactly the collapse state the user owns.
 *
 * "Chat" means a chat is LOADED, not that its pixels are frontmost: opening
 * the gallery over a live chat keeps `data-k-view="chat"`, so the frame does
 * not pump while browsing the cast mid-conversation.
 *
 * Installed by the rails layout's mount, removed by its unmount; classic never
 * carries the attribute.
 */

import { getCurrentChatId } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';

/** `document.body.dataset` key behind the `data-k-view` attribute. */
const DATASET_KEY = 'kView';

/**
 * The library's proven visibility set (k-library.js VISIBILITY_EVENTS): every
 * core event after which "is a chat loaded" may have a different answer.
 * SETTINGS_LOADED covers boot restoring an active chat before APP_READY.
 */
const VIEW_EVENTS = [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.SETTINGS_LOADED,
];

let installed = false;

/** @type {(() => void) | null} */
let onViewEvent = null;

/**
 * Reads core and writes the attribute. Idempotent; dataset writes of the same
 * value do not dirty the document.
 * @returns {void}
 */
function syncView() {
    document.body.dataset[DATASET_KEY] = getCurrentChatId() === undefined ? 'home' : 'chat';
}

/** @returns {void} */
export function installViewState() {
    if (installed) return;
    installed = true;

    onViewEvent = syncView;
    for (const event of VIEW_EVENTS) {
        eventSource.on(event, onViewEvent);
    }
    syncView();
}

/**
 * Removes the listeners and the body attribute. Symmetry for
 * {@link installViewState}: classic must not inherit a stray `data-k-view`.
 * @returns {void}
 */
export function uninstallViewState() {
    if (!installed) return;
    installed = false;

    if (onViewEvent) {
        for (const event of VIEW_EVENTS) {
            eventSource.removeListener(event, onViewEvent);
        }
        onViewEvent = null;
    }
    delete document.body.dataset[DATASET_KEY];
}
