/**
 * The welcome tour's Connect step, as data (docs/onboarding-v0.md §2.1). Pure: the component
 * gathers the facts, this decides what they mean, and Jest drives it without a server.
 */

/** @typedef {'claude'|'keys'|'other'} Lane */

/** The three ways to connect, in the order the step offers them (Claude Code first). */
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
 * Which lane to open on: the one the live (or selected) connection already belongs to.
 * @param {{ onBridge: boolean, source: string, providerSources: readonly string[] }} facts
 * @returns {Lane}
 */
export function initialLane({ onBridge, source, providerSources }) {
    if (onBridge) return 'claude';
    if (providerSources.includes(source)) return 'keys';
    return 'claude';
}
