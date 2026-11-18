/**
 * Kotatsu Wrapped — its door, as a name and nothing else. Anything may ask for the sheet by
 * dispatching this on `window`; `<k-wrapped>` itself is only imported at the shell seam
 * (`installWrapped()`), so the library can carry the button without carrying the painter.
 */
export const OPEN_WRAPPED_EVENT = 'k-open-wrapped';
