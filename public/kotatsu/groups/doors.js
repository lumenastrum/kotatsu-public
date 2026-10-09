/**
 * Scene doors — the event names other surfaces use to reach the scene studio, kept in a
 * DOM-free, import-free module for the same reason `studio/manifest.js` holds
 * `OPEN_STUDIO_EVENT`: the rail and the library can import the name without importing the
 * studio (and Lit, and core) along with it.
 */

/**
 * Bubbling, composed CustomEvent on `document`. `detail.target` is `'create'` or a group id;
 * `detail.source` names the surface that asked. Unheard (classic layout) it is a no-op.
 */
export const OPEN_SCENE_STUDIO_EVENT = 'k-open-scene-studio';
