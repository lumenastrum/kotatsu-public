/**
 * Sprites — what `<k-sprite-studio>` shows, in which order, page by page (Card Studio v2 ③,
 * `docs/card-studio-v2.md` "③ and `<k-sprite-studio>`").
 *
 * Pure data and functions: no DOM, no imports from core, so jest imports it as-is. The element owns the folders,
 * the uploads and the pixels; this owns the arithmetic it would otherwise do inline in templates: the strip's
 * order and pages, the grid's order, the set counts, the stand-in for a missing feeling and the pick's detail.
 */

import { EXPRESSION_LABELS, EXPRESSION_VERSION, resolveExpression } from './expression-model.js';

/** The slots shown by default: neutral and the roots the resolver falls back to. */
export const MAIN_LABELS = Object.freeze(['neutral', 'joy', 'love', 'anger', 'annoyance', 'sadness', 'surprise', 'fear', 'embarrassment']);

/** The two framings a card can hold: the full body is the folder itself, the bust its `bust/` subfolder. */
export const SPRITE_SETS = Object.freeze(['bust', 'full']);

/** Tiles on one page of the strip: five when there is room, never fewer than two. */
export const STRIP_PAGE_MAX = 5;
export const STRIP_PAGE_MIN = 2;

/**
 * What the stage shows for an expression the set does not have (the real fallback chain).
 * @param {string} label
 * @param {Iterable<string>} have labels the set holds
 * @returns {string | null} a label, or null when nothing fits (the stage shows the card art)
 */
export function standInFor(label, have) {
    return resolveExpression({ v: EXPRESSION_VERSION, key: '', ranked: [[label, 1]] }, have);
}

/**
 * Which set a view opens on: the one asked for, else the bust when the card has one, else the full body.
 * @param {string | null | undefined} asked the `set` attribute
 * @param {number} bustCount sprites in the bust set
 * @returns {'bust' | 'full'}
 */
export function effectiveSet(asked, bustCount) {
    if (asked === 'bust' || asked === 'full') return asked;
    return bustCount > 0 ? 'bust' : 'full';
}

/**
 * How many of `universe` a set holds.
 * @param {Iterable<string>} have
 * @param {ReadonlyArray<string>} [universe] MAIN_LABELS by default
 * @returns {number}
 */
export function countIn(have, universe = MAIN_LABELS) {
    const set = new Set(have);
    return universe.filter(label => set.has(label)).length;
}

/**
 * The strip's order: the main labels the set HAS (main order), then any other label it has (alphabetical), then the
 * main labels it is missing (main order). The expressions a card has are the page; the gaps come after.
 * @param {Iterable<string>} have
 * @returns {string[]}
 */
export function stripOrder(have) {
    const held = new Set(have);
    const extras = [...held].filter(label => !MAIN_LABELS.includes(label)).sort();
    return [
        ...MAIN_LABELS.filter(label => held.has(label)),
        ...extras,
        ...MAIN_LABELS.filter(label => !held.has(label)),
    ];
}

/**
 * The grid's order: neutral, then the other 27 alphabetically, then any label outside the 28 the set holds
 * (alphabetical), so a hand-made pack's own names stay reachable.
 * @param {Iterable<string>} have
 * @returns {string[]}
 */
export function gridOrder(have) {
    const rest = EXPRESSION_LABELS.filter(label => label !== 'neutral').sort();
    const extras = [...new Set(have)].filter(label => !EXPRESSION_LABELS.includes(label)).sort();
    return ['neutral', ...rest, ...extras];
}

/**
 * Tiles per strip page for a given width: as many tiles of at least `minTile` px as fit, between two and five.
 * @param {number} width the strip's width in px
 * @param {{minTile?: number, gap?: number}} [options]
 * @returns {number}
 */
export function perPageFor(width, { minTile = 150, gap = 12 } = {}) {
    if (!Number.isFinite(width) || width <= 0) return STRIP_PAGE_MAX;
    const fit = Math.floor((width + gap) / (minTile + gap));
    return Math.max(STRIP_PAGE_MIN, Math.min(STRIP_PAGE_MAX, fit));
}

/**
 * @param {number} total
 * @param {number} perPage
 * @returns {number} at least 1
 */
export function pageCount(total, perPage) {
    return Math.max(1, Math.ceil(total / Math.max(1, perPage)));
}

/**
 * A page index brought back inside the pages that exist.
 * @param {number} page
 * @param {number} total
 * @param {number} perPage
 * @returns {number}
 */
export function clampPage(page, total, perPage) {
    const last = pageCount(total, perPage) - 1;
    return Math.max(0, Math.min(last, Math.trunc(page) || 0));
}

/**
 * The page that holds a label in an order.
 * @param {ReadonlyArray<string>} order
 * @param {string} label
 * @param {number} perPage
 * @returns {number} -1 when the label is not in the order
 */
export function pageOf(order, label, perPage) {
    const index = order.indexOf(label);
    return index < 0 ? -1 : Math.floor(index / Math.max(1, perPage));
}

/**
 * The page to show once a page holds a different number of tiles (the strip got wider or narrower): the picked
 * tile's page when the picked tile is on show, else the page that holds the first tile that was on show. Re-paging
 * by the first tile alone could push the picked tile off the page; that happens on every mount at phone width, where
 * the first layout pages by five before the strip is measured.
 * @param {ReadonlyArray<string>} order
 * @param {number} page the page on show
 * @param {number} perPage tiles per page until now
 * @param {number} nextPerPage tiles per page from now on
 * @param {string} [picked] the picked label, '' for none
 * @returns {number}
 */
export function refitPage(order, page, perPage, nextPerPage, picked = '') {
    const per = Math.max(1, perPage), next = Math.max(1, nextPerPage);
    const start = clampPage(page, order.length, per) * per;
    const at = picked ? order.indexOf(picked) : -1;
    const keep = at >= start && at < start + per ? at : start;
    return clampPage(Math.floor(keep / next), order.length, next);
}

/**
 * One page's slice and its index words ("1–5 of 9").
 * @param {ReadonlyArray<string>} order
 * @param {number} page
 * @param {number} perPage
 * @returns {{labels: string[], from: number, to: number, total: number, page: number, pages: number, words: string}}
 */
export function pageSlice(order, page, perPage) {
    const total = order.length;
    const at = clampPage(page, total, perPage);
    const start = at * perPage;
    const labels = order.slice(start, start + perPage);
    const from = labels.length ? start + 1 : 0;
    const to = start + labels.length;
    const words = !total ? 'none' : from === to ? `${from} of ${total}` : `${from}–${to} of ${total}`;
    return { labels, from, to, total, page: at, pages: pageCount(total, perPage), words };
}

/**
 * The `k-sprite-pick` detail for a label.
 * @param {string} label
 * @param {'bust' | 'full'} set the set the tile was picked in
 * @param {Map<string, string>} full the full-body set (label → url)
 * @param {Map<string, string>} bust the bust set (label → url)
 * @returns {{label: string, set: 'bust' | 'full', url: string, fullUrl: string}}
 */
export function pickDetail(label, set, full, bust) {
    const url = (set === 'bust' ? bust : full).get(label) ?? '';
    return { label, set, url, fullUrl: full.get(label) ?? '' };
}

/** Room left around a full-body figure when its tile is framed on it, as fractions of the canvas. */
export const FIGURE_PAD = Object.freeze({ top: 0.04, side: 0.03, bottom: 0.015 });

/**
 * The `object-view-box` a full-body tile frames its sprite with: the figure's box plus {@link FIGURE_PAD}, so the
 * tile fits the FIGURE rather than the canvas. A slim pose on an 832 × 1216 canvas fit by the canvas stands two
 * thirds tall at the bottom of a narrower tile (measured on Hana 2026-10-19: figure 42% of the canvas wide, 90% tall);
 * fit by the figure it fills the tile's height, and a wide pose still fits whole by its width. '' = leave the canvas
 * as it is (unmeasured, or a figure that already fills its canvas).
 * @param {{top: number, bottom: number, left: number, right: number} | null | undefined} box 0..1 of the canvas
 * @returns {string} `inset(t% r% b% l%)` or ''
 */
export function figureViewBox(box) {
    if (!box) return '';
    const edges = [box.top, box.bottom, box.left, box.right];
    if (!edges.every(Number.isFinite) || box.bottom <= box.top || box.right <= box.left) return '';
    const inset = {
        top: Math.max(0, box.top - FIGURE_PAD.top),
        right: Math.max(0, 1 - box.right - FIGURE_PAD.side),
        bottom: Math.max(0, 1 - box.bottom - FIGURE_PAD.bottom),
        left: Math.max(0, box.left - FIGURE_PAD.side),
    };
    if (Object.values(inset).every(value => value < 0.01)) return '';
    const pct = (/** @type {number} */ value) => `${(Math.min(value, 0.49) * 100).toFixed(1)}%`;
    return `inset(${pct(inset.top)} ${pct(inset.right)} ${pct(inset.bottom)} ${pct(inset.left)})`;
}
