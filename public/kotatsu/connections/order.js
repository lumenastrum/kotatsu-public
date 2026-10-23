/**
 * Which way to connect comes first on the Connection tab (and which lane the welcome tour opens
 * on). Pure: seat.js gathers the facts and moves the cards, Jest drives this directly.
 *
 * Andres, 2026-10-22: "If Claude Code isn't set up, the API connections should be the ones at
 * the top. Today, even if Claude Code's bridge isn't configured for RP, it dominates the top of
 * the connections. It's one of our features, but it feels like we're giving it special
 * treatment. Let's make it reactive."
 *
 * So every way in is in one of three states, and the tab sorts by them:
 *   - `in-use`      the connection Kotatsu sends through right now;
 *   - `ready`       set up and one press away;
 *   - `not-set-up`  needs installing, signing in, or a bridge that is running.
 * Ties keep the house order (Claude Code, ChatGPT, API keys), so Claude Code still leads when it
 * is in use, or set up while nothing else is. "More ways to connect" is always last and is not
 * sorted here.
 */

/** @typedef {'claude'|'chatgpt'|'keys'} ConnectionCard */
/** @typedef {'in-use'|'ready'|'not-set-up'} CardState */

/** The house order, used to break ties. */
export const CARDS = Object.freeze(/** @type {const} */ (['claude', 'chatgpt', 'keys']));

/** @type {Readonly<Record<CardState, number>>} */
const RANK = Object.freeze({ 'in-use': 0, 'ready': 1, 'not-set-up': 2 });

/**
 * Claude Code's state, from the bridge detector and the doctor.
 * - Not installed is never "in use", even while the bridge is the selected connection: a fresh
 *   install starts on the bridge, and `selectionPill()` (bridge.js) already refuses to call that
 *   "In use" for the same reason.
 * - Otherwise the selected bridge is in use, problems and all: someone who chose Claude Code and
 *   is not signed in needs that card in front of them, with its fix.
 * - Ready needs the doctor's word and no problem of any kind. Not asked yet counts as not set up;
 *   seat.js asks as soon as the tab shows.
 * @param {{ onBridge: boolean, doctorKnown: boolean, problems: ReadonlyArray<{ kind: string }> }} facts
 *   `isOnBridge()`; whether `/doctor` has answered; `doctorProblems()` of that answer.
 * @returns {CardState}
 */
export function claudeState({ onBridge, doctorKnown, problems }) {
    if (problems.some(problem => problem.kind === 'not-installed')) return 'not-set-up';
    if (onBridge) return 'in-use';
    return doctorKnown && problems.length === 0 ? 'ready' : 'not-set-up';
}

/**
 * The ChatGPT plan's state.
 * @param {{ onChatGPT: boolean, face: string }} facts `isOnChatGPT()`; `cardState()` (chatgpt.js).
 * @returns {CardState}
 */
export function chatgptState({ onChatGPT, face }) {
    if (onChatGPT) return 'in-use';
    return face === 'signed-in' ? 'ready' : 'not-set-up';
}

/**
 * The API keys card is always one paste away, so it is never "not set up".
 * @param {{ keyInUse: boolean }} facts Whether a provider key is the live, online connection.
 * @returns {CardState}
 */
export function keysState({ keyInUse }) {
    return keyInUse ? 'in-use' : 'ready';
}

/**
 * The cards in the order the tab shows them. Stable: equal states keep {@link CARDS}' order.
 * @param {Record<ConnectionCard, CardState>} states
 * @returns {ConnectionCard[]}
 */
export function connectionOrder(states) {
    return [...CARDS].sort((a, b) => RANK[states[a]] - RANK[states[b]] || CARDS.indexOf(a) - CARDS.indexOf(b));
}

/**
 * The welcome tour's first lane. Its "Your subscription" lane holds both plans, so it opens there
 * only when one of them comes before the API keys; otherwise on the keys.
 * @param {Record<ConnectionCard, CardState>} states
 * @returns {'claude'|'keys'}
 */
export function tourLane(states) {
    return connectionOrder(states)[0] === 'keys' ? 'keys' : 'claude';
}

/**
 * Whether two orders differ, so a re-seat that changes nothing moves nothing.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
export function sameOrder(a, b) {
    return a.length === b.length && a.every((card, index) => card === b[index]);
}
