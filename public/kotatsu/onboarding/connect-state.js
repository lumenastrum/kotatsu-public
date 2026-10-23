/**
 * The welcome tour's Connect step, as data (docs/onboarding-v0.md §2.1). Pure: the component
 * gathers the facts, this decides what they mean, and Jest drives it without a server.
 */

import { chatgptState, claudeState, keysState, tourLane } from '../connections/order.js';

/** @typedef {'claude'|'keys'|'other'} Lane */

/** The three ways to connect, in the order the lane switch shows them. Which one opens first is
 * {@link initialLane}'s call. */
export const LANES = Object.freeze(/** @type {const} */ (['claude', 'keys', 'other']));

/**
 * What the Connect step shows right now.
 *
 * Order matters:
 * 1. A bridge reason wins, even over "connected": core's status check passes on the bridge's
 *    model list, which needs no login, so "connected but not signed in" must still read as a
 *    problem — the first send would fail (composer-reason.js says the same).
 *    One bridge reason is not a problem: Claude Code not being on this computer. Since the
 *    installer made it optional (v0.2.3) that is a choice, so it reads `absent`: no failure
 *    line, no oops pose, and the other lanes are offered as equals. It still outranks
 *    "connected", for the same reason as above.
 * 2. Then a live connection.
 * 3. Then the last key that didn't take.
 * @param {{
 *   online: string,
 *   reason: { kind: string, text: string } | null,
 *   failed: string,
 *   label: string,
 * }} facts `online_status`; `composerReason()`'s answer; the provider name whose last attempt
 *   failed, or ''; what the live connection is called.
 * @returns {{ state: 'idle'|'absent'|'connected'|'problem', text: string }} `text` is the reason or label.
 */
export function connectState({ online, reason, failed, label }) {
    // A key that was just refused is the newer news, and it is a real failure.
    if (reason?.kind === 'not-installed') return failed ? { state: 'problem', text: `${failed} didn’t accept that key` } : { state: 'absent', text: '' };
    if (reason && reason.kind !== 'connecting') return { state: 'problem', text: reason.text };
    if (online && online !== 'no_connection') return { state: 'connected', text: label || 'your connection' };
    if (failed) return { state: 'problem', text: `${failed} didn’t accept that key` };
    return { state: 'idle', text: '' };
}

/**
 * Which lane to open on: the Connection tab's rule (connections/order.js), so the tour and the tab
 * never disagree about what comes first. The subscription lane holds both plans and opens first
 * only when one of them is in use, or set up while no key is; without Claude Code (a fresh install
 * still starts on the bridge) the tour opens on the API keys. A selected provider counts as the
 * keys being in use here even before it answers: the step opens on the lane the person's own
 * connection belongs to.
 * @param {{
 *   onBridge: boolean,
 *   onChatGPT: boolean,
 *   doctorKnown: boolean,
 *   problems: ReadonlyArray<{ kind: string }>,
 *   chatgptFace: string,
 *   source: string,
 *   providerSources: readonly string[],
 * }} facts `isOnBridge()`, `isOnChatGPT()`; whether `/doctor` has answered and `doctorProblems()`
 *   of it; the ChatGPT card's `cardState()`; core's chat-completion source; the providers' sources.
 * @returns {Lane}
 */
export function initialLane({ onBridge, onChatGPT, doctorKnown, problems, chatgptFace, source, providerSources }) {
    return tourLane({
        claude: claudeState({ onBridge, doctorKnown, problems }),
        chatgpt: chatgptState({ onChatGPT, face: chatgptFace }),
        keys: keysState({ keyInUse: !onBridge && !onChatGPT && providerSources.includes(source) }),
    });
}
