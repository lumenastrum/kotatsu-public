/**
 * The palette layer: a handful of friendly seed colours that grow into the full token set.
 *
 * A pack can still write any `--k-*` token by hand. The palette exists because nobody should have
 * to hand-tune forty related colours to make a theme: change `text` and the dim, muted, faint,
 * quote and reasoning greys follow it; change `background` and the deep stop, the scrim, the
 * chat tint and the borders follow; change `accent` and its bright twin and the ambient glows
 * follow. Every derived colour is a plain hex written into the resolved token map, so
 * `theme:check` measures exactly what the page paints.
 *
 * Three rules keep it predictable:
 *   1. **A colour you name yourself always wins.** Derivation never overwrites a token the same
 *      pack declares in `tokens`, nor one a palette key it lists writes (even a key left equal to
 *      the parent's colour); it reads them as inputs instead. A palette key whose token is ALSO
 *      written in `tokens` is overruled by it and reported as such, not as a change.
 *   2. **Only what you change moves.** A palette key whose colour equals the parent's (a fresh
 *      `theme:new` scaffold is pre-filled with the parent's colours) derives nothing, so the
 *      scaffold looks exactly like its parent until the author touches something.
 *   3. **Derived reading colours keep their contrast.** The dim/muted/quote/bright greys are
 *      nudged toward the strong text colour, step by step, until they clear WCAG AA against the
 *      panel surfaces. The author's own colours are never nudged; `theme:check` reports those.
 *
 * Pure and DOM-free: imported by core.js (browser) and by scripts/theme-check.mjs (Node).
 */

import { contrastRatio, parseColor } from './color.js';

/**
 * Each friendly palette key and the token it writes. Order is the order the guide and the
 * `theme:new` scaffold present them in.
 * @type {Readonly<Record<string, {token: string, about: string}>>}
 */
export const PALETTE_KEYS = Object.freeze({
    background: { token: '--k-ground', about: 'The room: the deepest colour, behind everything.' },
    panel: { token: '--k-surface', about: 'Panels, cards and popups that sit on the background.' },
    text: { token: '--k-text', about: 'Body text. The greys (dim, muted, faint) grow from this and the background.' },
    prose: { token: '--k-text-prose', about: 'The story text in messages. Leave it out to use `text`.' },
    accent: { token: '--k-accent', about: 'The main accent: links, buttons, focus rings, the user\'s name.' },
    dialogue: { token: '--k-rose', about: 'Quoted "dialogue" in messages, and the second accent (selected rows).' },
    actions: { token: '--k-italics', about: 'Italic *actions* in messages. Leave it out to use `accent`.' },
    border: { token: '--k-border', about: 'Hairlines around panels and cards. Grows from text + background if left out.' },
    'character-message': { token: '--k-bot-mes', about: 'The card behind the character\'s messages.' },
    'user-message': { token: '--k-user-mes', about: 'The card behind your own messages.' },
    shadow: { token: '--k-shadow', about: 'Shadows under floating things.' },
    'glow-top': { token: '--k-glow-dawn', about: 'Ambient glow in the top-right of the background.' },
    'glow-left': { token: '--k-glow-rose', about: 'Ambient glow in the bottom-left of the background.' },
    'glow-bottom': { token: '--k-glow-deep', about: 'Ambient glow along the bottom of the background.' },
    success: { token: '--k-success', about: 'Good news: saved, connected.' },
    warning: { token: '--k-warning', about: 'Careful: warnings.' },
    danger: { token: '--k-danger', about: 'Bad news and delete buttons.' },
});

/** The WCAG AA floor derived reading colours are nudged to clear, with a hair of headroom. */
const AA = 4.6;
/** Faint text (placeholders, code comments) is decoration-adjacent; it keeps a 3:1 floor. */
const FAINT_FLOOR = 3.1;
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

/**
 * @typedef {import('./color.js').ParsedColor} ParsedColor
 */

/**
 * @typedef {object} Recipe
 * @property {string} token Token the recipe writes.
 * @property {string[]} inputs Tokens it reads; it runs when any of them changed.
 * @property {(get: (token: string) => ParsedColor|null, light: boolean) => ParsedColor|string|null} derive
 * @property {{against: string[], floor: number}} [contrast] Nudge until it clears `floor` on each surface.
 */

/**
 * Mixes `amount` of `b` into `a` in sRGB, exactly like `color-mix(in srgb, a, b amount)`.
 * @param {ParsedColor} a
 * @param {ParsedColor} b
 * @param {number} amount 0..1
 * @returns {ParsedColor}
 */
export function mix(a, b, amount) {
    return {
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount,
        a: a.a + (b.a - a.a) * amount,
    };
}

/**
 * Formats a colour as lowercase `#rrggbb`, or `#rrggbbaa` when it is translucent.
 * @param {ParsedColor} color
 * @returns {string}
 */
export function toHex(color) {
    const channel = (/** @type {number} */ value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0');
    const alpha = color.a >= 0.999 ? '' : channel(color.a * 255);
    return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${alpha}`;
}

/**
 * Light or dark? Whichever of black or white text would contrast more with it.
 * @param {ParsedColor} color
 * @returns {boolean} True when the colour reads as a light background.
 */
function isLightColor(color) {
    const hex = toHex({ ...color, a: 1 });
    return (contrastRatio(hex, '#000000') ?? 0) > (contrastRatio(hex, '#ffffff') ?? 0);
}

/**
 * The derivation recipes, in dependency order. Each recipe runs only when one of its inputs
 * changed in this pack (directly, through the palette, or through an earlier recipe).
 * @type {Recipe[]}
 */
const RECIPES = [
    { token: '--k-ground-deep', inputs: ['--k-ground', '--k-text'], derive: (get, light) => light ? mixOf(get('--k-ground'), get('--k-text'), 0.06) : mixOf(get('--k-ground'), BLACK, 0.12) },
    { token: '--k-scrim', inputs: ['--k-ground', '--k-text'], derive: (get, light) => light ? mixOf(get('--k-text'), BLACK, 0.15) : mixOf(get('--k-ground'), BLACK, 0.45) },
    { token: '--k-backdrop-top', inputs: ['--k-surface'], derive: get => get('--k-surface') },
    { token: '--k-surface-2', inputs: ['--k-surface', '--k-ground'], derive: get => mixOf(get('--k-surface'), get('--k-ground'), 0.45) },
    { token: '--k-surface-sunken', inputs: ['--k-surface', '--k-text'], derive: get => mixOf(get('--k-surface'), get('--k-text'), 0.035) },
    { token: '--k-chat-tint', inputs: ['--k-ground', '--k-surface'], derive: get => mixOf(get('--k-ground'), get('--k-surface'), 0.12) },
    { token: '--k-text-strong', inputs: ['--k-text'], derive: (get, light) => mixOf(get('--k-text'), light ? BLACK : WHITE, 0.45) },
    {
        token: '--k-text-quote', inputs: ['--k-text', '--k-ground'],
        derive: get => mixOf(get('--k-text'), get('--k-ground'), 0.1),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: AA },
    },
    {
        token: '--k-text-dim', inputs: ['--k-text', '--k-ground'],
        derive: get => mixOf(get('--k-text'), get('--k-ground'), 0.36),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: AA },
    },
    {
        token: '--k-text-muted', inputs: ['--k-text', '--k-ground', '--k-accent'],
        derive: get => mixOf(mixOf(get('--k-text'), get('--k-accent'), 0.15), get('--k-ground'), 0.4),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: AA },
    },
    {
        token: '--k-text-faint', inputs: ['--k-text', '--k-ground'],
        derive: get => mixOf(get('--k-text'), get('--k-ground'), 0.5),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: FAINT_FLOOR },
    },
    {
        token: '--k-text-reasoning', inputs: ['--k-text', '--k-accent', '--k-ground'],
        derive: get => mixOf(mixOf(get('--k-text'), get('--k-accent'), 0.35), get('--k-ground'), 0.22),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: AA },
    },
    {
        token: '--k-accent-bright', inputs: ['--k-accent', '--k-text-strong'],
        derive: get => mixOf(get('--k-accent'), get('--k-text-strong'), 0.35),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: AA },
    },
    {
        token: '--k-rose-bright', inputs: ['--k-rose', '--k-text-strong'],
        derive: get => mixOf(get('--k-rose'), get('--k-text-strong'), 0.3),
        contrast: { against: ['--k-surface', '--k-surface-sunken'], floor: AA },
    },
    { token: '--k-border', inputs: ['--k-text', '--k-ground'], derive: get => mixOf(get('--k-text'), get('--k-ground'), 0.64) },
    { token: '--k-chrome-border', inputs: ['--k-border'], derive: get => get('--k-border') },
    { token: '--k-elevation-shadow', inputs: ['--k-shadow'], derive: get => get('--k-shadow') },
    { token: '--k-bot-mes', inputs: ['--k-surface', '--k-text'], derive: get => mixOf(get('--k-surface'), get('--k-text'), 0.035) },
    { token: '--k-user-mes', inputs: ['--k-surface', '--k-text', '--k-accent'], derive: get => mixOf(mixOf(get('--k-surface'), get('--k-text'), 0.06), get('--k-accent'), 0.06) },
    { token: '--k-glow-dawn', inputs: ['--k-accent', '--k-ground'], derive: get => mixOf(get('--k-accent'), get('--k-ground'), 0.15) },
    { token: '--k-glow-rose', inputs: ['--k-rose', '--k-ground'], derive: get => mixOf(get('--k-rose'), get('--k-ground'), 0.35) },
    { token: '--k-glow-deep', inputs: ['--k-accent', '--k-ground'], derive: get => mixOf(get('--k-accent'), get('--k-ground'), 0.45) },
    // A light ground smudges under the global text halo (natsumikan-v0: "--k-shadow-strength: 0%
    // kills it"). Only ever switched OFF here; a dark ground leaves the parent's halo alone.
    { token: '--k-shadow-strength', inputs: ['--k-ground'], derive: (_get, light) => light ? '0%' : null },
];

/**
 * Palette keys whose colour a recipe grows when the key is left out (border, the message cards,
 * the glows). Listing one pins it (rule 1), so the `theme:new` scaffold leaves these out and they
 * keep following the colours the author does change.
 * @type {readonly string[]}
 */
export const GROWN_PALETTE_KEYS = Object.freeze(Object.keys(PALETTE_KEYS)
    .filter(key => RECIPES.some(recipe => recipe.token === PALETTE_KEYS[key].token)));

/**
 * Null-safe mix for recipes.
 * @param {ParsedColor|null} a
 * @param {ParsedColor|null} b
 * @param {number} amount
 * @returns {ParsedColor|null}
 */
function mixOf(a, b, amount) {
    return a && b ? mix(a, b, amount) : null;
}

/**
 * Resolves a token to a colour through plain `var(--k-x)` chains in a token map.
 * Anything more complex than a bare reference (color-mix, gradients) resolves to null.
 * @param {string} token
 * @param {Record<string, string>} tokens
 * @param {Set<string>} [seen]
 * @returns {ParsedColor|null}
 */
export function resolveTokenColor(token, tokens, seen = new Set()) {
    if (seen.has(token)) return null;
    const value = tokens[token];
    if (typeof value !== 'string') return null;
    const reference = value.trim().match(/^var\((--k-[a-z0-9-]+)\)$/);
    if (reference) {
        seen.add(token);
        return resolveTokenColor(reference[1], tokens, seen);
    }
    return parseColor(value);
}

/**
 * Validates a palette layer. Returns `[path, message]` pairs; empty when valid.
 * @param {unknown} palette
 * @returns {[string, string][]}
 */
export function validatePalette(palette) {
    /** @type {[string, string][]} */
    const errors = [];
    if (typeof palette !== 'object' || palette === null || Array.isArray(palette)) {
        errors.push(['$.palette', 'must be an object of colours, like { "background": "#140e0b" }']);
        return errors;
    }
    for (const [key, value] of Object.entries(palette)) {
        const path = `$.palette.${key}`;
        if (!Object.prototype.hasOwnProperty.call(PALETTE_KEYS, key)) {
            const known = Object.keys(PALETTE_KEYS);
            const close = known.find(name => name.replace(/-/g, '') === key.toLowerCase().replace(/[-_ ]/g, ''));
            errors.push([path, `is not a palette colour${close ? ` (did you mean "${close}"?)` : ''}. Palette colours: ${known.join(', ')}`]);
            continue;
        }
        const color = typeof value === 'string' ? parseColor(value) : null;
        if (!color) {
            errors.push([path, 'must be a colour written as #rrggbb (or #rgb, or rgb(r, g, b))']);
        } else if (color.a < 1) {
            errors.push([path, 'must be a solid colour; palette colours cannot be see-through']);
        }
    }
    return errors;
}

/**
 * Nudges a colour toward `toward` in 4% steps until it clears `floor` against every surface.
 * @param {ParsedColor} color
 * @param {ParsedColor|null} toward
 * @param {(ParsedColor|null)[]} surfaces
 * @param {number} floor
 * @returns {ParsedColor}
 */
function ensureContrast(color, toward, surfaces, floor) {
    const opaqueSurfaces = surfaces.filter(surface => surface !== null).map(surface => toHex(/** @type {ParsedColor} */ (surface)));
    if (!toward || opaqueSurfaces.length === 0) return color;
    let current = color;
    for (let step = 0; step < 25; step++) {
        const hex = toHex(current);
        if (opaqueSurfaces.every(surface => (contrastRatio(hex, surface) ?? 0) >= floor)) return current;
        current = mix(current, toward, 0.04 + step * 0.01);
    }
    return current;
}

/**
 * Grows a pack's palette into tokens.
 *
 * @param {Record<string, string>|undefined} palette The pack's own palette layer (already validated).
 * @param {Record<string, string>} parentTokens The parent's fully resolved tokens (empty for a root pack).
 * @param {Record<string, string>} ownTokens Tokens the pack writes by hand; never overwritten.
 * @returns {{tokens: Record<string, string>, changed: string[], overruled: string[], derived: string[]}}
 *   `tokens` = every token the palette writes (primaries + derived), `changed` = palette keys that
 *   differed from the parent and took effect, `overruled` = palette keys whose token the pack also
 *   writes by hand (the hand-written value won, so the key changed nothing), `derived` = tokens
 *   grown by recipes.
 */
export function derivePaletteTokens(palette, parentTokens, ownTokens) {
    /** @type {Record<string, string>} */
    const out = {};
    if (!palette || typeof palette !== 'object') return { tokens: out, changed: [], overruled: [], derived: [] };

    /** @type {Record<string, string>} working = parent, then own hand-written tokens, then the palette. */
    /** What the pack starts from: the parent's finished tokens under its own hand-written ones. */
    const inherited = { ...parentTokens, ...ownTokens };
    const working = { ...inherited };
    const dirty = new Set();
    /** Tokens the author named (a hand-written token, or a palette key listed at all): never re-grown. */
    const pinned = new Set(Object.keys(ownTokens));
    const changed = [];
    const overruled = [];
    // Whether the palette asked for anything at all (an overruled key still counts, as it did
    // before overruled keys were reported apart: it puts the palette "in play").
    let inPlay = false;

    for (const [key, value] of Object.entries(palette)) {
        const spec = PALETTE_KEYS[key];
        const color = spec && typeof value === 'string' ? parseColor(value) : null;
        if (!spec || !color) continue;
        const before = resolveTokenColor(spec.token, inherited);
        const differs = !(before && toHex(before) === toHex(color));
        if (Object.prototype.hasOwnProperty.call(ownTokens, spec.token)) { // rule 1
            overruled.push(key);
            inPlay ||= differs;
            continue;
        }
        // Listing a key is a decision, even when the colour equals the parent's: a recipe must
        // not re-grow it from something else the author changed (the theme:new scaffold lists
        // every key this way).
        pinned.add(spec.token);
        if (!differs) {
            // Rule 2: an unchanged key derives nothing. But a token the parent only LINKS to
            // another (prose -> var(--k-text), actions -> var(--k-accent)) would keep following
            // that link, so "kept exactly as written" needs the colour itself written down.
            if (/^var\(/.test(String(inherited[spec.token] ?? '').trim())) {
                out[spec.token] = toHex(color);
                working[spec.token] = out[spec.token];
            }
            continue;
        }
        inPlay = true;
        changed.push(key);
        dirty.add(spec.token);
        out[spec.token] = toHex(color);
        working[spec.token] = out[spec.token];
    }
    // Hand-written tokens are inputs too once a palette is in play: pinning --k-surface by hand
    // and changing `text` must still recompute the greys against the pinned surface.
    if (inPlay) {
        for (const token of Object.keys(ownTokens)) dirty.add(token);
    }

    const get = (/** @type {string} */ token) => resolveTokenColor(token, working);
    const ground = get('--k-ground');
    const light = ground ? isLightColor(ground) : false;
    /** @type {string[]} */
    const derived = [];

    for (const recipe of RECIPES) {
        if (!recipe.inputs.some(input => dirty.has(input))) continue;
        if (pinned.has(recipe.token)) continue; // rule 1: written by hand or listed in the palette
        const result = recipe.derive(get, light);
        if (result === null) continue;
        let value;
        if (typeof result === 'string') {
            value = result;
        } else {
            const nudged = recipe.contrast
                ? ensureContrast(result, get('--k-text-strong') ?? get('--k-text'), recipe.contrast.against.map(get), recipe.contrast.floor)
                : result;
            value = toHex(nudged);
        }
        out[recipe.token] = value;
        working[recipe.token] = value;
        dirty.add(recipe.token);
        derived.push(recipe.token);
    }

    return { tokens: out, changed, overruled, derived };
}

/**
 * Reads a pack's effective palette back out of resolved tokens: what `theme:new` pre-fills a
 * scaffold with, so the author starts from the parent's real colours.
 * @param {Record<string, string>} tokens Fully resolved tokens.
 * @returns {Record<string, string>}
 */
export function readPalette(tokens) {
    /** @type {Record<string, string>} */
    const palette = {};
    for (const [key, spec] of Object.entries(PALETTE_KEYS)) {
        // A token that is a plain reference (prose → text, actions → accent) is LINKED, and the
        // honest scaffold leaves it out so it keeps following what it points at.
        if (/^var\(/.test(String(tokens[spec.token] ?? '').trim())) continue;
        const color = resolveTokenColor(spec.token, tokens);
        if (color && color.a >= 1) palette[key] = toHex(color);
    }
    return palette;
}
