// The master gate: does a generated full body on a key colour make a clean sprite? Rules measured on 20 lime neutrals
// (docs/sprite-expression-recon-2026-10-10.md, "Gate rates") and the spec (docs/handoffs/sprite-generator.md §2.1).
// A failed master is a reroll, not an error: the caller tries the next seed.

import { borderSamples, chromaOf, isWhiteKey } from './image.js';
import { cutKey } from './cut.js';

/** @typedef {import('./image.js').Img} Img */

export const GATE_DEFAULTS = Object.freeze({
    /** Key chroma ≥ this share of the reference key's (a washed-out lime is a seed trait: reroll). */
    minChromaShare: 0.8,
    /** Median distance from the key over the key-ish border only (a figure framed off the edge is not a busy key). */
    maxSpread: 6,
    /** Figure pixels allowed on the top, left and right edges after the cut (a full body may stand on the bottom). */
    maxEdgePixels: 0,
    /** Opaque pixels keepFigure dropped (lettering, a signature, a second figure). Specks below this are noise. */
    maxDroppedPixels: 150,
});

/** Distance from the key under which a border sample counts as key-ish. */
const KEYISH = 60;

/**
 * The key, judged on the key-ish part of the border: its spread there, and the share of the border something else
 * covers (figure, decoration).
 * @param {Img} raw @param {number[]} key
 * @returns {{ spread: number, touch: number }}
 */
export function keyishBorder(raw, key) {
    const { width: W, height: H, data: d } = raw;
    const dk = borderSamples(W, H).map(p => Math.hypot(d[p * 4] - key[0], d[p * 4 + 1] - key[1], d[p * 4 + 2] - key[2]));
    const keyish = dk.filter(v => v <= KEYISH).sort((a, b) => a - b);
    return {
        spread: keyish.length ? Math.round(keyish[keyish.length >> 1] * 10) / 10 : 99,
        touch: Math.round((1 - keyish.length / dk.length) * 1000) / 1000,
    };
}

/**
 * Opaque (alpha > 16) cut pixels on each canvas edge.
 * @param {Img} cut
 * @returns {{ top: number, bottom: number, left: number, right: number }}
 */
export function edgeContact(cut) {
    const { width: W, height: H, data: d } = cut;
    const at = (/** @type {number} */ x, /** @type {number} */ y) => d[(y * W + x) * 4 + 3] > 16;
    const e = { top: 0, bottom: 0, left: 0, right: 0 };
    for (let x = 0; x < W; x++) { if (at(x, 0)) e.top++; if (at(x, H - 1)) e.bottom++; }
    for (let y = 0; y < H; y++) { if (at(0, y)) e.left++; if (at(W - 1, y)) e.right++; }
    return e;
}

/**
 * Gate a master (full body drawn on a key colour). Cuts it on the way, so a passing master's cut is ready.
 * @param {Img} raw
 * @param {{ reference?: number[] | null } & Partial<typeof GATE_DEFAULTS>} [o]
 *   reference = the key colour asked for (e.g. LIME); without one the chroma rule is skipped
 * @returns {{ ok: boolean, failures: ('white' | 'chroma' | 'spread' | 'edge' | 'marks')[], key: number[],
 *   chromaShare: number | null, spread: number, touch: number, edges: ReturnType<typeof edgeContact>, dropped: number[],
 *   cut: Img }}
 */
export function gateMaster(raw, o = {}) {
    const g = { ...GATE_DEFAULTS, ...o };
    const k = cutKey(raw);
    const border = keyishBorder(raw, k.key);
    const edges = edgeContact(k.image);
    const droppedPixels = k.dropped.reduce((a, b) => a + b, 0);
    const chromaShare = o.reference ? Math.round(chromaOf(k.key) / chromaOf(o.reference) * 100) / 100 : null;
    /** @type {('white' | 'chroma' | 'spread' | 'edge' | 'marks')[]} */
    const failures = [];
    if (isWhiteKey(k.key)) failures.push('white');
    if (chromaShare !== null && chromaShare < g.minChromaShare) failures.push('chroma');
    if (border.spread > g.maxSpread) failures.push('spread');
    if (edges.top + edges.left + edges.right > g.maxEdgePixels) failures.push('edge');
    if (droppedPixels > g.maxDroppedPixels) failures.push('marks');
    return { ok: !failures.length, failures, key: k.key, chromaShare, spread: border.spread, touch: border.touch, edges, dropped: k.dropped, cut: k.image };
}
