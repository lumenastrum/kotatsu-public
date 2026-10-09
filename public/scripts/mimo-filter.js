/**
 * mimo-filter — Xiaomi MiMo's safety filter, told apart from the reply (Kotatsu docs/providers.md).
 *
 * MiMo answers a filtered turn with HTTP 200 and the refusal as ordinary assistant content:
 * `finish_reason: "content_filter"`, content "The request was rejected because it was considered
 * high risk". Streamed, that is the last delta, so it was appended to the reply mid-sentence and
 * saved as the character's words ("…and under it, salt. Not theThe request was rejected…", scene
 * smoke 2026-10-08, mimo-v2.6-pro, wire shape confirmed with a raw request the same day).
 *
 * The filter frame's content is never part of the reply. What streamed before it is kept, and the
 * person is told why the reply stops there.
 *
 * Dependency-free on purpose (like `group-nudge.js`): `openai.js` imports it, jest tests it.
 */

/** What MiMo's filter frame says, verbatim, for tests and for recognising it in old chats. */
export const MIMO_FILTER_TEXT = 'The request was rejected because it was considered high risk';

/**
 * @param {any} data One parsed stream frame or a whole non-streamed response.
 * @returns {boolean} Whether this is MiMo's safety filter stopping the reply.
 */
export function isMimoFilterStop(data) {
    return data?.choices?.[0]?.finish_reason === 'content_filter';
}
