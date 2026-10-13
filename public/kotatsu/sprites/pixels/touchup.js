// Touch-up: hand fixes on a cut sprite. Every tool works on two images of the same sprite: `raw` (the drawing on its
// flat background, never changed) and `cut` (the transparent sprite being fixed, changed in place). The background
// colour comes from the raw border. Clearing reads the RAW colours, so "is this background?" is answered by what was
// drawn, not by what the remover guessed; a clear is followed by a local edge matte so a hole never leaves a pale
// (white) or green (lime) ring behind.

import { copyWhere, detectKey, dilate, keyTester, luma } from './image.js';
import { keepFigure } from './cut.js';

export { copyWhere, detectKey, dilate, keepFigure, keyTester };

/** @typedef {import('./image.js').Img} Img */
/** @typedef {{ test: (p: number) => boolean, key: number[] }} KeyTest */

/**
 * Magic wand: from (x, y), flood 4-connected through raw background-coloured pixels (or, `global`, take every one in
 * the image) and clear them in the cut, then matte the edge around the hole. `limit` (a mask) confines it.
 * Walks VISIBLE pixels only: through the already-clear background a click in one pocket reached every white region
 * touching the background (measured: 226 px changed outside the clicked pockets). A click on a shadow the model
 * painted in its own colour takes that patch instead (`shadowPatch`, `patch: true`).
 * @param {Img} raw @param {Img} cut @param {number} x @param {number} y
 * @param {KeyTest & { global?: boolean, limit?: Uint8Array }} o
 * @returns {{ cleared: number, matted: number, region?: Uint8Array, patch?: boolean, reason?: 'outside' | 'not-background' | 'already-clear' | 'too-large' }}
 */
export function wand(raw, cut, x, y, o) {
    const { width: W, height: H } = raw;
    const N = W * H;
    if (x < 0 || y < 0 || x >= W || y >= H) return { cleared: 0, matted: 0, reason: 'outside' };
    const p0 = y * W + x;
    if (!o.test(p0)) {
        if (!cut.data[p0 * 4 + 3]) return { cleared: 0, matted: 0, reason: 'already-clear' };
        return o.global ? { cleared: 0, matted: 0, reason: 'not-background' } : shadowPatch(raw, cut, p0, o);
    }
    if (!cut.data[p0 * 4 + 3]) return { cleared: 0, matted: 0, reason: 'already-clear' };
    const ok = (/** @type {number} */ p) => cut.data[p * 4 + 3] > 0 && o.test(p) && (!o.limit || !!o.limit[p]);
    const region = new Uint8Array(N);
    if (o.global) {
        for (let p = 0; p < N; p++) if (ok(p)) region[p] = 1;
    } else {
        const stack = new Int32Array(N);
        let top = 0;
        region[p0] = 1; stack[top++] = p0;
        while (top) {
            const q = stack[--top];
            const qx = q % W, qy = (q - qx) / W;
            if (qx > 0 && !region[q - 1] && ok(q - 1)) { region[q - 1] = 1; stack[top++] = q - 1; }
            if (qx < W - 1 && !region[q + 1] && ok(q + 1)) { region[q + 1] = 1; stack[top++] = q + 1; }
            if (qy > 0 && !region[q - W] && ok(q - W)) { region[q - W] = 1; stack[top++] = q - W; }
            if (qy < H - 1 && !region[q + W] && ok(q + W)) { region[q + W] = 1; stack[top++] = q + W; }
        }
    }
    const cleared = clearRegion(cut, region);
    const matted = matteBand(raw, cut, region, { test: o.test, key: o.key, limit: o.limit });
    return { cleared, matted, region };
}

/** Colour distance from the clicked pixel that still belongs to the clicked shadow patch. */
export const PATCH_TOL = 36;
/** Largest shadow patch the wand takes, as a share of the sprite's opaque pixels (a floor shadow measured 1.5 %). */
export const PATCH_MAX_SHARE = 0.04;

/**
 * The wand on a pixel that is not the key colour: a cast shadow the model painted in its own colour (measured
 * 2026-10-12: a teal floor shadow, 36,133,101 on a 152,255,1 key, 77° off the key's hue, so neither the cut's shadow
 * rule nor the key test takes it). The person pointed at it, so the wand takes the 4-connected patch of the clicked
 * colour (within PATCH_TOL), when it is a shadow ON the background:
 * - it touches the already-clear background (an iris or a pattern inside the art never does);
 * - its colour leans the key's way: the key's strongest channel is its strongest too (a floor shadow on lime is
 *   green; skin, hair and shoes are not);
 * - it is small: at most PATCH_MAX_SHARE of the opaque pixels (a whole green cloak is refused: use the lasso).
 * The edge is matted against the patch colour, so the shoe beside it keeps its anti-aliasing. White keys never take
 * a patch: a shadow on white is grey, and grey is hair.
 * @param {Img} raw @param {Img} cut @param {number} p0 @param {KeyTest & { limit?: Uint8Array }} o
 * @returns {{ cleared: number, matted: number, region?: Uint8Array, patch?: boolean, reason?: 'not-background' | 'too-large' }}
 */
function shadowPatch(raw, cut, p0, o) {
    const { width: W, height: H } = raw;
    const N = W * H;
    const d = raw.data, c = cut.data;
    const seed = [d[p0 * 4], d[p0 * 4 + 1], d[p0 * 4 + 2]];
    const strongest = (/** @type {number[]} */ v) => v.indexOf(Math.max(v[0], v[1], v[2]));
    const keySpread = Math.max(...o.key) - Math.min(...o.key);
    const ch = strongest(o.key);
    const others = [0, 1, 2].filter(i => i !== ch);
    const leans = keySpread >= 60 && strongest(seed) === ch && seed[ch] - Math.max(seed[others[0]], seed[others[1]]) >= 16;
    if (!leans) return { cleared: 0, matted: 0, reason: 'not-background' };
    const near = (/** @type {number} */ p) => {
        const i = p * 4;
        return Math.hypot(d[i] - seed[0], d[i + 1] - seed[1], d[i + 2] - seed[2]) <= PATCH_TOL;
    };
    const ok = (/** @type {number} */ p) => c[p * 4 + 3] > 0 && near(p) && (!o.limit || !!o.limit[p]);
    const region = new Uint8Array(N);
    const stack = new Int32Array(N);
    const neighbours = (/** @type {number} */ q) => {
        const qx = q % W, qy = (q - qx) / W;
        return [qx > 0 ? q - 1 : -1, qx < W - 1 ? q + 1 : -1, qy > 0 ? q - W : -1, qy < H - 1 ? q + W : -1];
    };
    let top = 0, size = 0;
    region[p0] = 1; stack[top++] = p0;
    while (top) {
        const q = stack[--top];
        size++;
        for (const r of neighbours(q)) if (r >= 0 && !region[r] && ok(r)) { region[r] = 1; stack[top++] = r; }
    }
    // The patch's own anti-aliased rim: pixels that are a mix of the patch colour and the key (on the line between
    // them, within 24) belong to it, else they stay as a faint ghost outline once the patch is gone (measured on the
    // teal floor shadow: a 1–2 px lime-teal ring the cut kept half-opaque).
    const K = o.key, dir = [K[0] - seed[0], K[1] - seed[1], K[2] - seed[2]];
    const dd = dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2;
    const onMix = (/** @type {number} */ p) => {
        const i = p * 4, v = [d[i] - seed[0], d[i + 1] - seed[1], d[i + 2] - seed[2]];
        const t = (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / dd;
        return t >= 0 && t <= 1 && Math.hypot(v[0] - t * dir[0], v[1] - t * dir[1], v[2] - t * dir[2]) <= 24;
    };
    for (let pass = 0; pass < 3; pass++) {
        const grow = [];
        for (let p = 0; p < N; p++) {
            if (region[p] || !c[p * 4 + 3] || (o.limit && !o.limit[p]) || !onMix(p)) continue;
            if (neighbours(p).some(r => r >= 0 && region[r])) grow.push(p);
        }
        for (const p of grow) region[p] = 1; // the cap below weighs the clicked patch (`size`), not its thin rim
        if (!grow.length) break;
    }
    // ON the background: the patch (rim included) comes within 3 px of the clear background or the canvas edge.
    const reach = dilate(region, W, H, 3);
    let touches = false;
    for (let p = 0; p < N && !touches; p++) {
        if (!reach[p]) continue;
        const x = p % W, y = (p - x) / W;
        if (!c[p * 4 + 3] || x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
    }
    if (!touches) return { cleared: 0, matted: 0, reason: 'not-background' };
    let opaque = 0;
    for (let p = 0; p < N; p++) if (c[p * 4 + 3]) opaque++;
    if (size > PATCH_MAX_SHARE * opaque) return { cleared: 0, matted: 0, reason: 'too-large' };
    const cleared = clearRegion(cut, region);
    const matted = matteBand(raw, cut, region, { test: near, key: seed, limit: o.limit });
    return { cleared, matted, region, patch: true };
}

/**
 * How many pixels inside `mask` differ between two raw drawings (RGB). 0 means an edit there is provably the same
 * edit on both: same input pixels, same answer. This makes "apply to matching sprites" safe across a set whose
 * expressions only repainted the face (measured on a hand-made set: 96 % of every sprite byte-identical to the
 * neutral, every difference inside one face box), and a no-op for a sprite drawn in another pose.
 * @param {Img} a @param {Img} b @param {Uint8Array} mask
 * @returns {number} differing pixels (Infinity when the sizes differ)
 */
export function rawDiffers(a, b, mask) {
    if (a.width !== b.width || a.height !== b.height) return Infinity;
    let n = 0;
    for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        const i = p * 4;
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
    }
    return n;
}

/**
 * Where two drawings are the same picture: identical RAW pixels, kept `margin` px away from any pixel that differs
 * (a repainted face's edges belong to that face's own cut). A remover cuts an identical body differently per
 * expression (419–1,164 px of one hair strip, alpha gaps up to 248): "sync body" copies one approved cut over this.
 * @param {Img} a @param {Img} b @param {number} [margin]
 * @returns {{ mask: Uint8Array, share: number } | null} share = fraction of the canvas that is the same picture
 */
export function sameDrawing(a, b, margin = 6) {
    if (a.width !== b.width || a.height !== b.height) return null;
    const N = a.width * a.height;
    const differs = new Uint8Array(N);
    for (let p = 0; p < N; p++) {
        const i = p * 4;
        if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differs[p] = 1;
    }
    const near = dilate(differs, a.width, a.height, margin);
    const mask = new Uint8Array(N);
    let n = 0;
    for (let p = 0; p < N; p++) if (!near[p]) { mask[p] = 1; n++; }
    return { mask, share: n / N };
}

/**
 * Smart clear inside a mask (lasso, smart brush): only background-coloured pixels inside go, art inside stays, and
 * the matte stays inside the mask too.
 * @param {Img} raw @param {Img} cut @param {Uint8Array} mask @param {KeyTest} o
 * @returns {{ cleared: number, matted: number }}
 */
export function smartClear(raw, cut, mask, o) {
    const N = raw.width * raw.height;
    const region = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (mask[p] && o.test(p)) region[p] = 1;
    const cleared = clearRegion(cut, region);
    const matted = matteBand(raw, cut, region, { test: o.test, key: o.key, limit: mask });
    return { cleared, matted };
}

/**
 * Restore: the raw drawing back at full opacity inside the mask (the remover ate something real).
 * @param {Img} raw @param {Img} cut @param {Uint8Array} mask
 * @returns {{ restored: number }}
 */
export function restore(raw, cut, mask) {
    let n = 0;
    for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        const i = p * 4;
        if (cut.data[i + 3] !== 255 || cut.data[i] !== raw.data[i] || cut.data[i + 1] !== raw.data[i + 1] || cut.data[i + 2] !== raw.data[i + 2]) n++;
        cut.data[i] = raw.data[i]; cut.data[i + 1] = raw.data[i + 1]; cut.data[i + 2] = raw.data[i + 2]; cut.data[i + 3] = 255;
    }
    return { restored: n };
}

/**
 * Hard erase: alpha 0 inside the mask, whatever is there.
 * @param {Img} cut @param {Uint8Array} mask
 * @returns {{ erased: number }}
 */
export function erase(cut, mask) {
    let n = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p] && cut.data[p * 4 + 3]) { cut.data[p * 4 + 3] = 0; n++; }
    return { erased: n };
}

/** @param {Img} cut @param {Uint8Array} region @returns {number} */
function clearRegion(cut, region) {
    let n = 0;
    for (let p = 0; p < region.length; p++) if (region[p] && cut.data[p * 4 + 3]) { cut.data[p * 4 + 3] = 0; n++; }
    return n;
}

/**
 * Local edge matte around a freshly cleared region. A pixel on the new edge (opaque, within `reach` px of the region)
 * is a mix of the background colour B and the solid art F beside it: a = projection of (C − B) on (F − B), colour = F.
 * F = the solid, non-background pixel within 3 px that explains C best; a pixel no line B→F explains (error > 48) is
 * art and stays. A dark band pixel is line art and may be F (a 1–2 px outline lies wholly inside the band; barring it
 * repainted the line as the fill behind it). Alpha only ever goes down.
 * @param {Img} raw @param {Img} cut @param {Uint8Array} region
 * @param {KeyTest & { limit?: Uint8Array, reach?: number }} o
 * @returns {number} pixels changed
 */
export function matteBand(raw, cut, region, o) {
    const { width: W, height: H } = raw;
    const N = W * H;
    const R = o.reach ?? 2;
    const d = raw.data, c = cut.data, B = o.key;
    const band = new Uint8Array(N);
    let any = false;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!region[p]) continue;
        any = true;
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx;
            if (!region[q] && c[q * 4 + 3] > 0 && (!o.limit || o.limit[q])) band[q] = 1;
        }
    }
    if (!any) return 0;
    const updates = [];
    for (let p = 0; p < N; p++) {
        if (!band[p]) continue;
        const x = p % W, y = (p - x) / W, i = p * 4;
        const C0 = d[i] - B[0], C1 = d[i + 1] - B[1], C2 = d[i + 2] - B[2];
        let best = -1, bestErr = Infinity, bestA = 1;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx;
            if (region[q] || c[q * 4 + 3] < 250 || o.test(q)) continue;
            const j = q * 4;
            if (band[q] && (q === p || luma(d, j) >= 100)) continue;
            const F0 = d[j] - B[0], F1 = d[j + 1] - B[1], F2 = d[j + 2] - B[2];
            const ff = F0 * F0 + F1 * F1 + F2 * F2;
            if (ff < 1) continue;
            const a = Math.max(0, Math.min(1, (C0 * F0 + C1 * F1 + C2 * F2) / ff));
            const err = Math.hypot(C0 - a * F0, C1 - a * F1, C2 - a * F2);
            if (err < bestErr) { bestErr = err; best = q; bestA = a; }
        }
        if (best < 0 || bestErr > 48 || bestA >= 0.97) continue;
        updates.push(p, best, bestA);
    }
    let n = 0;
    for (let k = 0; k < updates.length; k += 3) {
        const p = updates[k], q = updates[k + 1], a = updates[k + 2];
        const i = p * 4, j = q * 4;
        const alpha = a < 0.03 ? 0 : Math.min(c[i + 3], Math.round(a * 255));
        if (alpha === c[i + 3] && c[i] === d[j]) continue;
        c[i] = d[j]; c[i + 1] = d[j + 1]; c[i + 2] = d[j + 2]; c[i + 3] = alpha;
        n++;
    }
    return n;
}

/**
 * Suspects: still-visible pixels whose RAW colour is the background colour (leftover lime, trapped white).
 * On a white background this also lights eye whites and shine: it points, you judge.
 * @param {Img} raw @param {Img} cut @param {(p: number) => boolean} test
 * @returns {{ mask: Uint8Array, count: number }}
 */
export function suspects(raw, cut, test) {
    const N = raw.width * raw.height;
    const out = new Uint8Array(N);
    let n = 0;
    for (let p = 0; p < N; p++) if (cut.data[p * 4 + 3] > 32 && test(p)) { out[p] = 1; n++; }
    return { mask: out, count: n };
}

/**
 * Stamp a filled circle into a mask (brushes).
 * @param {Uint8Array} mask @param {number} W @param {number} H @param {number} cx @param {number} cy @param {number} r
 */
export function stampCircle(mask, W, H, cx, cy, r) {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) mask[y * W + x] = 1;
    }
}

/**
 * Fill a polygon (image coords) into a mask, even-odd scanline.
 * @param {number} W @param {number} H @param {number[][]} pts [x, y] pairs
 * @returns {Uint8Array}
 */
export function polygonMask(W, H, pts) {
    const mask = new Uint8Array(W * H);
    if (pts.length < 3) return mask;
    let minY = H, maxY = 0;
    for (const [, y] of pts) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(H - 1, Math.ceil(maxY)); y++) {
        const sy = y + 0.5, xs = [];
        for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
            const [xa, ya] = pts[k], [xb, yb] = pts[j];
            if ((ya > sy) !== (yb > sy)) xs.push(xa + (sy - ya) * (xb - xa) / (yb - ya));
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
            for (let x = a; x <= b; x++) mask[y * W + x] = 1;
        }
    }
    return mask;
}
