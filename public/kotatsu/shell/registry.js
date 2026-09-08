/**
 * Kotatsu shell — the layout registry (shell v0 slice A, docs/shell-v0.md).
 *
 * The shell is a registry of layouts, not one layout (SPEC §13). A layout is a
 * pair of functions over the SAME DOM: `mount` moves existing nodes into the
 * frame's slots, `unmount` puts them back exactly where they were. Nothing here
 * builds UI, nothing here knows about themes, and nothing here renames an id —
 * the 26 frozen ids of CONTRACT.md relocate, they never change, so every jQuery
 * handler in core keeps firing against the same nodes.
 *
 * Relocation is reversible by construction: every move records the node's
 * original `{ parent, nextSibling }` and `restoreAll()` replays them in reverse.
 * That reversibility is the whole safety story for `classic` staying a working
 * fallback.
 */

/**
 * A node's position in the document before the active layout moved it.
 * @typedef {object} Anchor
 * @property {Node} parent
 * @property {Node | null} nextSibling
 */

/**
 * The handle a layout's `mount`/`unmount` receives.
 * @typedef {object} LayoutContext
 * @property {string} id The layout being mounted or unmounted.
 * @property {(node: Element | null, target: Element | null) => boolean} relocate
 *   Appends `node` to `target`, recording where it came from. Returns false
 *   (and does nothing) if either side is missing, so a layout can be written
 *   without a null check per line.
 * @property {() => void} restoreAll Undoes every recorded relocation.
 */

/**
 * @typedef {object} LayoutDefinition
 * @property {(ctx: LayoutContext) => void | Promise<void>} [mount]
 * @property {(ctx: LayoutContext) => void | Promise<void>} [unmount]
 */

/** @type {Map<string, LayoutDefinition>} */
const layouts = new Map();

/**
 * Where each relocated node came from. Keyed weakly: a node that leaves the
 * document takes its record with it.
 * @type {WeakMap<Element, Anchor>}
 */
const anchors = new WeakMap();

/**
 * Relocation order. The WeakMap holds the answers but cannot be iterated, so
 * this array holds the questions. Restored in reverse so nested moves unwind
 * in the order they were made.
 * @type {Element[]}
 */
let relocated = [];

/** @type {string | null} */
let activeLayout = null;

/**
 * Registers a layout. Re-registering an id replaces it, which keeps a hot
 * module reload from stacking duplicates.
 * @param {string} id
 * @param {LayoutDefinition} definition
 * @returns {void}
 */
export function defineLayout(id, definition) {
    if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('defineLayout: id must be a non-empty string.');
    }
    if (!definition || typeof definition !== 'object') {
        throw new TypeError(`defineLayout: definition for "${id}" must be an object.`);
    }
    layouts.set(id, definition);
}

/**
 * The id of the layout currently mounted, or null before the first apply.
 * @returns {string | null}
 */
export function currentLayout() {
    return activeLayout;
}

/**
 * Whether a layout id has been registered.
 * @param {string} id
 * @returns {boolean}
 */
export function hasLayout(id) {
    return layouts.has(id);
}

/**
 * Moves a node into a slot, remembering where it was.
 * @param {Element | null} node
 * @param {Element | null} target
 * @returns {boolean} Whether the move happened.
 */
function relocate(node, target) {
    if (!(node instanceof Element) || !(target instanceof Element)) return false;
    if (node === target || node.contains(target)) return false;
    if (!anchors.has(node)) {
        const parent = node.parentNode;
        if (!parent) return false;
        anchors.set(node, { parent, nextSibling: node.nextSibling });
        relocated.push(node);
    }
    target.appendChild(node);
    return true;
}

/**
 * Puts every relocated node back where it came from, newest move first.
 * @returns {void}
 */
function restoreAll() {
    for (let i = relocated.length - 1; i >= 0; i--) {
        const node = relocated[i];
        const anchor = anchors.get(node);
        anchors.delete(node);
        if (!anchor || !anchor.parent.isConnected) continue;
        // The original next sibling may itself have moved or been removed while the
        // layout was mounted; appending to the recorded parent is the honest fallback.
        const before = anchor.nextSibling && anchor.nextSibling.parentNode === anchor.parent
            ? anchor.nextSibling
            : null;
        anchor.parent.insertBefore(node, before);
    }
    relocated = [];
}

/**
 * Builds the handle handed to a layout's mount/unmount.
 * @param {string} id
 * @returns {LayoutContext}
 */
function makeContext(id) {
    return { id, relocate, restoreAll };
}

/**
 * Unmounts the active layout (if any) and mounts `id`.
 *
 * A layout that throws on mount is not left half-applied: everything it moved
 * is restored and the registry falls back to reporting no active layout, so the
 * page degrades to core's own markup rather than to a broken frame.
 * @param {string} id
 * @returns {Promise<boolean>} Whether `id` is now the active layout.
 */
export async function applyLayout(id) {
    if (activeLayout === id) return true;

    const next = layouts.get(id);
    if (!next) {
        console.warn(`[Kotatsu shell] No layout registered as "${id}"; leaving "${activeLayout}" mounted.`);
        return false;
    }

    if (activeLayout !== null) {
        const previous = layouts.get(activeLayout);
        try {
            await previous?.unmount?.(makeContext(activeLayout));
        } catch (error) {
            console.error(`[Kotatsu shell] Layout "${activeLayout}" failed to unmount.`, error);
        }
        // Whatever unmount did or failed to do, the document goes back to core's shape
        // before the next layout starts moving nodes around.
        restoreAll();
        activeLayout = null;
    }

    try {
        await next.mount?.(makeContext(id));
    } catch (error) {
        console.error(`[Kotatsu shell] Layout "${id}" failed to mount; reverting to core markup.`, error);
        // Give the half-mounted layout its own chance to clean up what the registry
        // cannot see — body attributes, listeners, injected elements — before the
        // node positions are rolled back underneath it.
        try {
            await next.unmount?.(makeContext(id));
        } catch (cleanupError) {
            console.error(`[Kotatsu shell] Layout "${id}" also failed to clean up after a failed mount.`, cleanupError);
        }
        restoreAll();
        return false;
    }

    activeLayout = id;
    return true;
}
