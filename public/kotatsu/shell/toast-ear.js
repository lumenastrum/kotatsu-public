/**
 * Records every toast core raises until `stop()`. The toasts are still shown.
 *
 * Core's ways of bringing a card in (`processDroppedFiles`, `importFromExternalUrl`) return
 * nothing and report through toasts, so anything that needs to know how an import went has to
 * listen to them. First written for the tour's First card step; the marketplace's preview
 * sheet listens the same way. `onboarding/card-state.js` turns the record into an outcome.
 *
 * @typedef {object} Toast A toast core raised while something was being brought in.
 * @property {'success'|'info'|'warning'|'error'} level
 * @property {string} message
 * @property {string} title
 */

/**
 * @param {{ quiet?: (toast: Toast) => boolean }} [options] `quiet` toasts are recorded but not
 *   shown: for a caller that already says the same thing in its own voice (the tour's Persona
 *   step, which core's "updated successfully" + "Persona Changed" used to cover, walkthrough F3).
 * @returns {{ toasts: Toast[], stop: () => void }} The record and its off switch. Calling `stop()` twice is fine.
 */
export function listenToToasts({ quiet } = {}) {
    /** @type {Toast[]} */
    const toasts = [];
    const toaster = /** @type {Record<string, any>} */ (/** @type {any} */ (globalThis).toastr ?? {});
    const levels = /** @type {const} */ (['success', 'info', 'warning', 'error']);
    const originals = levels.map(level => toaster[level]);
    levels.forEach((level, at) => {
        if (typeof originals[at] !== 'function') return;
        toaster[level] = (/** @type {unknown} */ message, /** @type {unknown} */ title, /** @type {unknown[]} */ ...rest) => {
            const toast = { level, message: String(message ?? ''), title: String(title ?? '') };
            toasts.push(toast);
            if (quiet?.(toast)) return undefined;
            return originals[at].call(toaster, message, title, ...rest);
        };
    });
    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        levels.forEach((level, at) => {
            if (typeof originals[at] === 'function') toaster[level] = originals[at];
        });
    };
    return { toasts, stop };
}
