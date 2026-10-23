/**
 * Seats the Connection tab's cards in core's #rm_api_block, in the order order.js decides, and
 * keeps that order as the connections change (Andres, 2026-10-22: "Let's make it reactive").
 *
 * ── Never under your hands ──────────────────────────────────────────────────────────────────
 * A card that moves while someone is using the tab moves the thing they are reaching for. So a
 * new order is applied at once while the tab is not on screen, and while it is on screen only
 * until the person first touches it (a press, a key, a scroll, focus inside). After that a new
 * order waits for the next time the tab shows. The tab may settle as it opens; it never shifts
 * under the person's hands. Connecting with a key, for one, moves the keys to the top the next
 * time the tab opens, not while the key is still being typed.
 *
 * ── Knowing early ───────────────────────────────────────────────────────────────────────────
 * Whether Claude Code is set up is the doctor's answer, and the doctor spawns the `claude` CLI,
 * so nothing asks it on the boot path for someone on an API key. The tab showing is the moment
 * it is worth asking, which is when the Claude Code card asked before it could be seated lower.
 *
 * ── The Connection Manager ──────────────────────────────────────────────────────────────────
 * Its profile block is inserted at the top of #rm_api_block when extensions activate, after the
 * shell's first seat, so the cards re-seat at APP_READY (shell/index.js) to sit above it.
 */

import { main_api, online_status } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings } from '../../scripts/openai.js';
import { BRIDGE_CHANGE_EVENT, BRIDGE_STATUS_EVENT, doctorProblems, getDoctor, isOnBridge, loadDoctor } from './bridge.js';
import { CHATGPT_CHANGE_EVENT, CHATGPT_STATUS_EVENT, cardState, getStatus, isComputerOnly, isOnChatGPT } from './chatgpt.js';
import { mountBridgeCard } from './k-bridge-card.js';
import { mountConnectionMore } from './k-connection-more.js';
import { mountProviderCards } from './k-provider-cards.js';
import { chatgptState, claudeState, connectionOrder, keysState, sameOrder } from './order.js';
import { PROVIDERS } from './providers.js';

/** @type {Readonly<Record<import('./order.js').ConnectionCard, string>>} */
const TAGS = Object.freeze({ claude: 'k-bridge-card', chatgpt: 'k-chatgpt-card', keys: 'k-provider-cards' });

let installed = false;
let onScreen = false;
let touched = false;
/** @type {IntersectionObserver|null} */
let observer = null;

/** @returns {HTMLElement|null} */
function apiBlock() {
    return document.getElementById('rm_api_block');
}

/** @returns {import('./order.js').ConnectionCard[]} The order the connections call for now. */
function wantedOrder() {
    const { doctor } = getDoctor();
    const keyInUse = main_api === 'openai'
        && PROVIDERS.some(provider => provider.source === oai_settings?.chat_completion_source)
        && !isOnBridge()
        && online_status !== 'no_connection';
    return connectionOrder({
        claude: claudeState({ onBridge: isOnBridge(), doctorKnown: Boolean(doctor), problems: doctorProblems(doctor) }),
        chatgpt: chatgptState({ onChatGPT: isOnChatGPT(), face: cardState({ status: getStatus(), computerOnly: isComputerOnly(), waiting: false }) }),
        keys: keysState({ keyInUse }),
    });
}

/**
 * Puts the cards at the top of the block in `order`, "More ways to connect" right after them.
 * Moves only what is out of place, so a seat that changes nothing touches nothing.
 * @param {HTMLElement} block
 * @param {import('./order.js').ConnectionCard[]} order
 * @returns {void}
 */
function place(block, order) {
    /** @type {Element|null} */
    let previous = null;
    for (const card of order) {
        const element = block.querySelector(TAGS[card]);
        if (!element) continue;
        if (previous ? previous.nextElementSibling !== element : block.firstElementChild !== element) {
            if (previous) previous.after(element);
            else block.prepend(element);
            // A move disconnects the card, and a card unhooks its listeners when disconnected. When
            // the move is itself answering a status event, the card's own listener for that event is
            // removed mid-dispatch and never runs, so it would keep showing the old state: re-render.
            /** @type {any} */ (element).requestUpdate?.();
        }
        previous = element;
    }
    const more = block.querySelector('k-connection-more');
    if (more && previous && previous.nextElementSibling !== more) previous.after(more);
}

/** @returns {import('./order.js').ConnectionCard[]} The order the block shows now. */
function shownOrder(block) {
    return /** @type {import('./order.js').ConnectionCard[]} */ ([...block.children]
        .map(element => Object.entries(TAGS).find(([, tag]) => element.localName === tag)?.[0])
        .filter(Boolean));
}

/**
 * Re-seats if the order changed and nobody is in the middle of using the tab.
 * @returns {void}
 */
function reseat() {
    const block = apiBlock();
    if (!block || (onScreen && touched)) return;
    const order = wantedOrder();
    if (!sameOrder(shownOrder(block), order)) place(block, order);
}

/** Someone reached into the tab: from now until it hides, nothing moves. */
function markTouched() {
    if (onScreen) touched = true;
}

/**
 * Watches the block: showing asks the doctor once and re-seats; hiding clears the hands-off mark.
 * @param {HTMLElement} block
 * @returns {void}
 */
function watch(block) {
    if (observer) return;
    observer = new IntersectionObserver((entries) => {
        const visible = entries.some(entry => entry.isIntersecting);
        if (visible === onScreen) return;
        onScreen = visible;
        touched = false;
        if (!visible) return;
        if (!getDoctor().doctor && !getDoctor().pending) void loadDoctor();
        reseat();
    });
    observer.observe(block);
    for (const type of ['pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart']) {
        block.addEventListener(type, markTouched, { passive: true });
    }
}

/**
 * Creates the cards (each mount function seats its card in the house order) and then puts them
 * in the order the connections call for. Safe to call again: the shell does at APP_READY.
 * @returns {void}
 */
export function seatConnectionCards() {
    mountBridgeCard();
    mountProviderCards();
    mountConnectionMore();
    const block = apiBlock();
    if (!block) return;
    // A fresh seat from the mount functions is the house order, so the wanted order is applied
    // over it regardless of hands: on the first seat nothing is on screen anyway, and at
    // APP_READY the mount functions only move cards the Connection Manager pushed down.
    place(block, wantedOrder());
    watch(block);
    install();
}

/** Listens for every change that can reorder the cards. Once. */
function install() {
    if (installed) return;
    installed = true;
    for (const type of [BRIDGE_STATUS_EVENT, BRIDGE_CHANGE_EVENT, CHATGPT_STATUS_EVENT, CHATGPT_CHANGE_EVENT]) {
        document.addEventListener(type, reseat);
    }
    for (const type of [event_types.ONLINE_STATUS_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.MAIN_API_CHANGED]) {
        if (typeof type === 'string') eventSource.on(type, reseat);
    }
}
