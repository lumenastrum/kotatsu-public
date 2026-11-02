/**
 * Folding the Connection tab's big cards down to one line (public issue #5: someone who will only
 * ever use a local server or an aggregator scrolled past all of them every time).
 *
 * The choice is `power_user.kotatsu_connections_folded`, the cards folded, so it follows the user.
 * A folded card still says where it stands, so an in-use connection is never hidden by accident.
 * Folded cards sit below the open ones (order.js `foldedLast`), which seat.js applies the next time
 * the tab shows: a card never moves under the hand that just folded it.
 *
 * Only the Connection tab's copy folds. The welcome tour mounts the same cards to connect someone
 * for the first time, and a folded card there would hide the step they came for.
 */

import { html, nothing } from '../shell/lit.js';
import { saveSettingsDebounced } from '../../script.js';
import { power_user } from '../../scripts/power-user.js';

/** @typedef {import('./order.js').ConnectionCard} ConnectionCard */

/** `power_user` key: the cards folded on the Connection tab. */
export const FOLD_KEY = 'kotatsu_connections_folded';

/** The words a folded card uses for its state. */
export const STATE_WORDS = Object.freeze({ 'in-use': 'In use', 'ready': 'Ready', 'not-set-up': 'Not set up' });

const chevron = html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4"/></svg>`;

/** @returns {ConnectionCard[]} The cards folded now. */
export function foldedCards() {
    const stored = /** @type {Record<string, unknown>} */ (power_user)[FOLD_KEY];
    return Array.isArray(stored) ? stored : [];
}

/**
 * @param {Element} host A card.
 * @returns {boolean} Whether this copy of it is the Connection tab's.
 */
function onConnectionTab(host) {
    return host.closest('#rm_api_block') !== null;
}

/**
 * @param {Element} host A card.
 * @param {ConnectionCard} card Which one.
 * @returns {boolean} Whether to draw it folded.
 */
export function isFolded(host, card) {
    return onConnectionTab(host) && foldedCards().includes(card);
}

/**
 * @param {import('../shell/lit.js').LitElement} host A card.
 * @param {ConnectionCard} card Which one.
 * @param {boolean} folded The new state.
 * @returns {void}
 */
function setFolded(host, card, folded) {
    const others = foldedCards().filter(other => other !== card);
    /** @type {Record<string, unknown>} */ (power_user)[FOLD_KEY] = folded ? [...others, card] : others;
    saveSettingsDebounced();
    host.requestUpdate();
}

/**
 * A card folded: its name, where it stands, and the way back open.
 * @param {import('../shell/lit.js').LitElement} host A card.
 * @param {ConnectionCard} card Which one.
 * @param {string} name What it is called.
 * @param {string} status Where it stands.
 * @returns {unknown} A Lit template.
 */
export function foldedRow(host, card, name, status) {
    return html`
        <div class="k-cm__way k-fold" data-open="false">
            <button type="button" class="k-cm__wayhead" aria-expanded="false" @click=${() => setFolded(host, card, false)}>
                <span class="k-cm__copy"><span class="k-cm__name">${name}</span><span class="k-bc__hint">${status}</span></span>
                <span class="k-cm__chevron">${chevron}</span>
            </button>
        </div>`;
}

/**
 * The control an open card folds itself with. Nothing on the tour's copy.
 * @param {import('../shell/lit.js').LitElement} host A card.
 * @param {ConnectionCard} card Which one.
 * @param {string} name What it is called.
 * @returns {unknown} A Lit template.
 */
export function foldButton(host, card, name) {
    if (!onConnectionTab(host)) return nothing;
    return html`
        <button type="button" class="k-fold-btn" aria-expanded="true" aria-label=${`Collapse ${name}`} title="Collapse"
            @click=${() => setFolded(host, card, true)}>${chevron}</button>`;
}
