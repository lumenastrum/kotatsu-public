/**
 * Type-only view of the Lit facade.
 *
 * At RUNTIME `lit.js` re-exports Lit from `public/lib.js`, the webpack vendor
 * bundle. The type checker cannot follow that: `noResolve` (public/kotatsu/
 * jsconfig.json) deliberately keeps core's `public/` tree out of the program, and
 * `lib.js` lives there. This declaration shadows `lit.js` for tsc only and points
 * it at the real package, so components extending `LitElement` inherit the whole
 * HTMLElement surface instead of nothing.
 *
 * It must stay a pure re-export. Hand-written Lit types would drift, silently, in
 * the direction of being wrong.
 */
export * from 'lit';
