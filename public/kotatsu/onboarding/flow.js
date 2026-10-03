/**
 * Mikan-chan's welcome tour — the step machine (docs/onboarding-v0.md §2-3). No DOM, no core
 * imports: `<k-onboarding>` renders whatever this says, and Jest drives it directly.
 *
 * ── The flag ─────────────────────────────────────────────────────────────────────────────────
 * `power_user.kotatsu_onboarding`, a string that rides the settings contract like every other
 * `kotatsu_*` key:
 *   - absent      → no tour. Every install that predates the tour reads this way, so nobody
 *                   needs a backfill; only core's first-run gate ever writes `pending`.
 *   - `pending`   → open at the first step.
 *   - `step:<id>` → open at that step (a reload mid-tour resumes where it was).
 *   - `done`      → finished through Ready.
 *   - `skipped`   → ended early ("I know my way around", Escape).
 * Anything else is read as absent: a hand-edited or future value must never trap a profile in a
 * tour it cannot leave.
 */

/** The steps, in order. Every one is skippable (Andres, 2026-10-01). */
export const STEPS = Object.freeze(['welcome', 'connect', 'sauce', 'persona', 'card', 'ready']);

/** @typedef {typeof STEPS[number]} Step */

export const FLAG_PENDING = 'pending';
export const FLAG_DONE = 'done';
export const FLAG_SKIPPED = 'skipped';
const STEP_PREFIX = 'step:';

/**
 * Which mascot pose each step wears (`public/kotatsu/brand/mascot/<pose>.webp`).
 * @type {Readonly<Record<Step, string>>}
 */
export const STEP_POSES = Object.freeze({
    welcome: 'welcome',
    connect: 'connect',
    sauce: 'sauce',
    persona: 'persona',
    card: 'card',
    ready: 'ready',
});

/**
 * @param {unknown} value Candidate.
 * @returns {value is Step} Whether it names a step.
 */
export function isStep(value) {
    return typeof value === 'string' && /** @type {readonly string[]} */ (STEPS).includes(value);
}

/**
 * What the stored flag means for this boot.
 * @param {unknown} flag `power_user.kotatsu_onboarding`.
 * @returns {{open: boolean, step: Step}} Whether to open the tour, and where.
 */
export function tourState(flag) {
    if (flag === FLAG_PENDING) return { open: true, step: STEPS[0] };
    if (typeof flag === 'string' && flag.startsWith(STEP_PREFIX)) {
        const step = flag.slice(STEP_PREFIX.length);
        if (isStep(step)) return { open: true, step };
    }
    return { open: false, step: STEPS[0] };
}

/**
 * The flag that resumes at `step`.
 * @param {Step} step Step.
 * @returns {string} Flag value.
 */
export function flagFor(step) {
    return `${STEP_PREFIX}${step}`;
}

/**
 * @param {Step} step Current step.
 * @returns {Step|null} The next one, or null past the last.
 */
export function nextStep(step) {
    const index = STEPS.indexOf(step);
    return index > -1 && index < STEPS.length - 1 ? STEPS[index + 1] : null;
}

/**
 * @param {Step} step Current step.
 * @returns {Step|null} The previous one, or null at the first.
 */
export function previousStep(step) {
    const index = STEPS.indexOf(step);
    return index > 0 ? STEPS[index - 1] : null;
}

/**
 * Progress for the dots: 0-based position and the total.
 * @param {Step} step Current step.
 * @returns {{index: number, total: number}} Position.
 */
export function progress(step) {
    return { index: Math.max(0, STEPS.indexOf(step)), total: STEPS.length };
}
