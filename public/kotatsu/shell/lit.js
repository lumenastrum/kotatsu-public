/**
 * Lit facade for shell components. The single import point for Lit in Kotatsu code:
 * components import from './lit.js' (or '../lit.js' from components/), never from
 * lib.js directly — so the vendoring mechanism can change without touching components.
 * Backed by the webpack vendor bundle (public/lib.js exports these names from 'lit').
 *
 * `css` is aliased on the way through: public/lib.js already exports `css` as the
 * @adobe/css-tools parser (scripts/chats.js imports it under that name), a core
 * export that cannot be renamed. Lit's tagged stylesheet template is vendored
 * there as `litCss` and restored to its canonical name here, so components keep
 * importing `{ css }` from this facade and never learn about the collision.
 */
export { LitElement, html, litCss as css, svg, nothing, render } from '../../lib.js';
