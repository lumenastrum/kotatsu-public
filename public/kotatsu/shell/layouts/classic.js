/**
 * Kotatsu shell — the `classic` layout (shell v0 slice A).
 *
 * Today's SillyTavern UI, untouched, and the permanent fallback: switching back
 * to it must always work, which is easiest to guarantee when it does nothing at
 * all. It moves no nodes, sets no attributes and injects no markup — core's own
 * boot already produces exactly this. `#k-shell` stays `display: none` because
 * the frame sheet only lifts that under `body[data-k-layout="rails"]`, and no
 * shell sheet has a rule that matches without that attribute.
 *
 * The definition exists so the registry has something to unmount TO. Without a
 * registered `classic`, `applyLayout('classic')` from rails would refuse.
 *
 * @type {import('../registry.js').LayoutDefinition}
 */
export const classicLayout = {
    mount() {
        // Intentionally empty. See the file comment.
    },
    unmount() {
        // Intentionally empty. Nothing was mounted.
    },
};
