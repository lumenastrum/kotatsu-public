// The sprite cut stack (measured in docs/sprite-expression-recon-2026-10-10.md):
//   key colour (lime):  keyCut → keepFigure
//   white background:   ToonOut (a ComfyUI removal model, run elsewhere) → floodWhite → edgeMatte → keepFigure
// keyCut / unmixWhite / edgeMatte / floodWhite return a new image; keepFigure clears in place (as Touch-up uses it).

import { KEY_PERP, borderStats, cloneImage, createImage, dilate, isWhiteKey, keyChroma, keyShadowTester, keyTester, luma } from './image.js';

/** @typedef {import('./image.js').Img} Img */

/** Any pixel below full opacity: an input that already carries transparency was cut before. @param {Img} img */
export function hasTransparency(img) {
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) return true;
    return false;
}

/**
 * The colour cut: a sprite drawn on a flat key colour, cut by colour alone (no removal model).
 * 1. The key B = per-channel median of the border; tolerance from its spread (18..40 in RGB distance).
 * 2. Background: every pixel the key tester accepts, WHEREVER it is (gaps between strands, under a strand, between an
 *    arm and the body), the case no removal model and no white-background rule could settle.
 * 3. A key-hued pixel at lower chroma is the key mixed with a neutral: alpha from the chroma it lacks, colour un-mixed.
 * 4. Interior: a non-key pixel with no key pixel within 4 px is solid.
 * 5. Edge band: a pixel is a mix of the key and the solid colour F beside it. F = the solid pixel within 5 px whose
 *    line B→F explains it best; alpha = projection of (C − B) on (F − B); colour = F, so no key fringe survives.
 *    A dark band pixel with no key chroma is line art and may be F: a 1–2 px outline lies wholly inside the band, and
 *    barring it repainted the line as the skin behind it. A thin strand with no interior in reach uses the band pixel
 *    farthest from the key's hue as F.
 * 6. Protected region (`o.protect`, the face's features: eyes, brows, mouth): a key-coloured pixel there is background
 *    only when the key around it reaches the canvas edge, and a pixel there with no background within 4 px is solid,
 *    un-mixing included. Step 2 alone took the lit half of a green iris (Mara, 2026-10-23: her highlight was the key).
 * @param {Img} raw
 * @param {{ protect?: Uint8Array }} [o] protect: W × H, non-zero = protected
 * @returns {{ image: Img, key: number[], tol: number, spread: number, busy: number, shadowed: number, held: number }}
 *   busy = share of the border far (> 40) from the key, figure included; shadowed = cast-shadow pixels taken as key;
 *   held = key-coloured pixels kept as paint by the protected region
 */
export function keyCut(raw, o = {}) {
    const { width: W, height: H, data: d } = raw;
    const N = W * H;
    const { key: B, spread, dists } = borderStats(raw);
    const tol = Math.min(40, Math.max(18, 4 * spread));
    const chroma = keyChroma(B);
    const test = keyTester(raw, B, tol, false);
    const isKey = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (test(p)) isKey[p] = 1;
    // A cast shadow on the key (a darker patch of the key's hue under standing feet) is background too. Two guards,
    // both measured on a green-eyed character (2026-10-12): (1) the flood starts from the BACKGROUND only, the key
    // connected to the canvas edge: a key-coloured highlight inside a green iris once seeded a flood that took the
    // whole iris; (2) a shadow is a region, not an edge: shadow pixels within 2 px of paint go back to the edge
    // band's matting, else a soft edge mixing the key with dark hair (also "the key, darker") lost its anti-aliasing.
    const shadow = keyShadowTester(raw, B);
    const queue = new Int32Array(N);
    const reach = new Uint8Array(N); // 1 = background key, 2 = shadow taken from it
    let head = 0, tail = 0;
    for (let p = 0; p < N; p++) {
        const x = p % W, y = (p - x) / W;
        if (isKey[p] && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) { reach[p] = 1; queue[tail++] = p; }
    }
    while (head < tail) {
        const q = queue[head++];
        const x = q % W, y = (q - x) / W;
        for (const r of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1]) {
            if (r < 0 || reach[r]) continue;
            if (isKey[r]) reach[r] = 1;
            else if (shadow(r)) reach[r] = 2;
            else continue;
            queue[tail++] = r;
        }
    }
    const protect = o.protect;
    let held = 0;
    if (protect) {
        for (let p = 0; p < N; p++) {
            if (!protect[p] || !isKey[p] || reach[p] === 1) continue;
            isKey[p] = 0;
            held++;
        }
    }
    const paint = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (!isKey[p] && reach[p] !== 2) paint[p] = 1;
    const nearPaint = dilate(paint, W, H, 2);
    let shadowed = 0;
    for (let p = 0; p < N; p++) {
        if (reach[p] !== 2 || nearPaint[p]) continue;
        isKey[p] = 1;
        shadowed++;
    }

    const REACH = 4;
    const near = new Uint8Array(N).fill(99);
    for (let p = 0; p < N; p++) if (isKey[p]) near[p] = 0;
    for (let step = 1; step <= REACH + 1; step++) {
        for (let p = 0; p < N; p++) {
            if (near[p] !== 99) continue;
            const x = p % W, y = (p - x) / W;
            let hit = false;
            for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                if (near[ny * W + nx] === step - 1) { hit = true; break; }
            }
            if (hit) near[p] = step;
        }
    }

    const image = createImage(W, H);
    const out = image.data;
    for (let p = 0; p < N; p++) {
        const i = p * 4;
        if (isKey[p]) { out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; out[i + 3] = 0; continue; }
        if (protect?.[p] && near[p] > REACH) { out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; out[i + 3] = 255; continue; }
        const k = chroma(d[i], d[i + 1], d[i + 2]);
        if (k.perp <= KEY_PERP && (k.ratio >= 0.45 || (near[p] <= REACH && k.ratio > 0.1))) {
            const a = Math.max(0, Math.min(1, 1 - k.ratio / 0.8));
            if (a < 0.03) { out[i + 3] = 0; continue; }
            for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((d[i + c] - (1 - a) * B[c]) / a)));
            out[i + 3] = Math.round(255 * a);
            continue;
        }
        if (near[p] > REACH) { out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; out[i + 3] = 255; continue; }
        const x = p % W, y = (p - x) / W;
        const C0 = d[i] - B[0], C1 = d[i + 1] - B[1], C2 = d[i + 2] - B[2];
        let best = -1, bestErr = Infinity, bestA = 1, far = -1, farD = Infinity;
        for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx;
            if (isKey[q]) continue;
            const j = q * 4;
            const F0 = d[j] - B[0], F1 = d[j + 1] - B[1], F2 = d[j + 2] - B[2];
            const ff = F0 * F0 + F1 * F1 + F2 * F2;
            const kq = chroma(d[j], d[j + 1], d[j + 2]).ratio;
            if (kq < farD) { farD = kq; far = q; }
            // Lime mixed with a purple can lose its chroma too, but stays bright: hence the luma bar.
            const lineArt = q !== p && kq <= 0.05 && luma(d, j) < 100;
            if ((near[q] <= REACH && !lineArt) || ff < 1) continue;
            const a = Math.max(0, Math.min(1, (C0 * F0 + C1 * F1 + C2 * F2) / ff));
            const err = Math.hypot(C0 - a * F0, C1 - a * F1, C2 - a * F2);
            if (err < bestErr) { bestErr = err; best = q; bestA = a; }
        }
        if (best < 0 && far >= 0) {
            const j = far * 4;
            const F0 = d[j] - B[0], F1 = d[j + 1] - B[1], F2 = d[j + 2] - B[2];
            const ff = F0 * F0 + F1 * F1 + F2 * F2;
            best = far;
            bestA = ff < 1 ? 1 : Math.max(0, Math.min(1, (C0 * F0 + C1 * F1 + C2 * F2) / ff));
        }
        const j = (best < 0 ? p : best) * 4;
        out[i] = d[j]; out[i + 1] = d[j + 1]; out[i + 2] = d[j + 2];
        out[i + 3] = Math.round(255 * (best < 0 ? 1 : bestA));
    }
    return {
        image,
        key: B,
        tol: Math.round(tol),
        spread: Math.round(spread * 10) / 10,
        busy: dists.filter(v => v > 40).length / dists.length,
        shadowed,
        held,
    };
}

/**
 * Un-mix white from a white-background cut's soft pixels: colour = (C − (1 − a) · 255) / a. A faint (< 50 %) pure
 * white pixel is background the remover half-kept: cleared.
 * @param {Img} cut @returns {Img}
 */
export function unmixWhite(cut) {
    const out = cloneImage(cut);
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        if (a <= 0.04 || a >= 0.96) continue;
        if (a < 0.5 && Math.min(d[i], d[i + 1], d[i + 2]) >= 245) {
            d[i + 3] = 0;
            continue;
        }
        for (let c = 0; c < 3; c++) d[i + c] = Math.max(0, Math.min(255, Math.round((d[i + c] - (1 - a) * 255) / a)));
    }
    return out;
}

/**
 * Two-colour edge matte on a white-background cut. At the silhouette a soft pixel mixes exactly the dark line beside
 * it and white, so alpha = (255 − L) / (255 − L_line) and colour = the line's. Applied to soft pixels within 2 px of a
 * clear one and lighter than their darkest solid neighbour; everything else gets `unmixWhite`.
 * @param {Img} cut @returns {Img}
 */
export function edgeMatte(cut) {
    const { width: W, height: H, data: d } = cut;
    const image = unmixWhite(cut);
    const out = image.data;
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        const i = (y * W + x) * 4, a = d[i + 3];
        if (a <= 10 || a >= 250) continue;
        let nearClear = false, darkL = 256, darkI = -1;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const j = ((y + dy) * W + x + dx) * 4;
            if (d[j + 3] <= 10) nearClear = true;
            if (d[j + 3] >= 200) { const l = luma(d, j); if (l < darkL) { darkL = l; darkI = j; } }
        }
        const L = luma(d, i);
        if (!nearClear || darkI < 0 || L <= darkL + 15 || darkL > 140) continue;
        const coverage = Math.max(0, Math.min(1, (255 - L) / (255 - darkL)));
        out[i + 3] = Math.min(a, Math.round(coverage * 255));
        for (let c = 0; c < 3; c++) out[i + c] = d[darkI + c];
    }
    return image;
}

/**
 * Trapped white on a white-background cut (ToonOut half-keeps pure white between an arm and the body).
 * Phase 1, guarded flood: from cleared pixels (alpha ≤ 10) and the canvas border, walk 4-connected pixels that are
 * pure white (min RGB ≥ 250) AND that the cut was unsure about (alpha < 250), and clear them. Solid white clothing sits
 * at alpha 255, so it is never cleared and never bridges the flood.
 * Phase 2, fenced regions (`trapped`): each remaining white region touching cleared background or the canvas edge is
 * cleared only if ≥ `trappedDark` of its opaque boundary has an outline-dark pixel (luma < 140) within `trappedR` px.
 * A background pocket is fenced by dark outlines; a white hair highlight touching the edge fades into light hair
 * (measured: pockets 0.89–1.00, the highlight 0.33). The radius steps over the 1–2 px anti-aliasing ring.
 * Runs before edgeMatte, so the new rims get matted.
 * @param {Img} cut
 * @param {{ trapped?: boolean, trappedDark?: number, trappedR?: number }} [o]
 * @returns {{ image: Img, cleared: number, trapped: { size: number, box: number[], touches: boolean, darkFrac: number, clear: boolean }[] }}
 *   trapped = the edge-touching white regions of ≥ 30 px, largest first (what phase 2 judged)
 */
export function floodWhite(cut, o = {}) {
    const TRAPPED = o.trapped ?? true;
    const TRAPPED_DARK = o.trappedDark ?? 0.6;
    const TRAPPED_R = o.trappedR ?? 3;
    const image = cloneImage(cut);
    const { width: W, height: H, data: d } = image;
    const N = W * H;
    const white = (/** @type {number} */ p) => Math.min(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]) >= 250;
    const walkable = (/** @type {number} */ p) => d[p * 4 + 3] < 250 && white(p);
    const seen = new Uint8Array(N);
    const stack = new Int32Array(N);
    let top = 0, cleared = 0;
    for (let p = 0; p < N; p++) {
        const x = p % W, y = (p - x) / W;
        const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        if (d[p * 4 + 3] <= 10 || (border && walkable(p))) { seen[p] = 1; stack[top++] = p; }
    }
    const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (top) {
        const q = stack[--top];
        const x = q % W, y = (q - x) / W;
        for (const [dx, dy] of STEPS) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const r = ny * W + nx;
            if (seen[r] || !walkable(r)) continue;
            seen[r] = 1;
            if (d[r * 4 + 3] > 0) cleared++;
            d[r * 4 + 3] = 0;
            stack[top++] = r;
        }
    }

    /** @type {{ size: number, box: number[], touches: boolean, darkFrac: number, clear: boolean }[]} */
    const regions = [];
    if (TRAPPED) {
        const nearDark = (/** @type {number} */ r) => {
            const x = r % W, y = (r - x) / W;
            for (let dy = -TRAPPED_R; dy <= TRAPPED_R; dy++) for (let dx = -TRAPPED_R; dx <= TRAPPED_R; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const j = ny * W + nx;
                if (d[j * 4 + 3] > 10 && luma(d, j * 4) < 140) return true;
            }
            return false;
        };
        const lab = new Int32Array(N).fill(-1);
        for (let p = 0; p < N; p++) {
            if (lab[p] !== -1 || d[p * 4 + 3] <= 10 || !white(p)) continue;
            const id = regions.length, members = [];
            let touches = false, dark = 0, fence = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
            top = 0; stack[top++] = p; lab[p] = id;
            while (top) {
                const q = stack[--top];
                members.push(q);
                const x = q % W, y = (q - x) / W;
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
                if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touches = true;
                for (const [dx, dy] of STEPS) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                    const r = ny * W + nx;
                    if (d[r * 4 + 3] <= 10) { touches = true; continue; }
                    if (white(r)) { if (lab[r] === -1) { lab[r] = id; stack[top++] = r; } continue; }
                    fence++;
                    if (nearDark(r)) dark++;
                }
            }
            const darkFrac = fence ? dark / fence : 0;
            const clear = touches && darkFrac >= TRAPPED_DARK;
            regions.push({ size: members.length, box: [x0, y0, x1, y1], touches, darkFrac: Math.round(darkFrac * 100) / 100, clear });
            if (clear) for (const q of members) { cleared++; d[q * 4 + 3] = 0; }
        }
    }
    const trapped = regions.filter(r => r.touches && r.size >= 30).sort((a, b) => b.size - a.size);
    return { image, cleared, trapped };
}

/**
 * Keep the figure: the largest opaque component (alpha > 16, 8-connected) and anything within `reach` px of it;
 * clear the rest (corner specks, floating fragments, a stray signature). Clears IN PLACE.
 * @param {Img} cut @param {number} [reach]
 * @returns {{ dropped: number[] }} sizes of the dropped components, largest first
 */
export function keepFigure(cut, reach = 6) {
    const { width: W, height: H, data } = cut;
    const N = W * H;
    const label = new Int32Array(N).fill(-1);
    /** @type {number[]} */
    const sizes = [];
    const stack = new Int32Array(N);
    for (let p = 0; p < N; p++) {
        if (label[p] !== -1 || data[p * 4 + 3] <= 16) continue;
        const id = sizes.length;
        let top = 0, size = 0;
        stack[top++] = p; label[p] = id;
        while (top) {
            const q = stack[--top];
            size++;
            const x = q % W, y = (q - x) / W;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const r = ny * W + nx;
                if (label[r] === -1 && data[r * 4 + 3] > 16) { label[r] = id; stack[top++] = r; }
            }
        }
        sizes.push(size);
    }
    if (sizes.length <= 1) return { dropped: [] };
    let main = 0;
    for (let id = 1; id < sizes.length; id++) if (sizes[id] > sizes[main]) main = id;
    const dist = new Int16Array(N).fill(-1);
    /** @type {number[]} */
    let frontier = [];
    for (let p = 0; p < N; p++) if (label[p] === main) { dist[p] = 0; frontier.push(p); }
    const keep = new Set([main]);
    for (let s = 1; s <= reach && frontier.length; s++) {
        /** @type {number[]} */
        const next = [];
        for (const q of frontier) {
            const x = q % W, y = (q - x) / W;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const r = ny * W + nx;
                if (dist[r] !== -1) continue;
                dist[r] = s;
                if (label[r] !== -1) keep.add(label[r]);
                next.push(r);
            }
        }
        frontier = next;
    }
    const dropped = [];
    for (let id = 0; id < sizes.length; id++) if (!keep.has(id)) dropped.push(sizes[id]);
    if (!dropped.length) return { dropped };
    for (let p = 0; p < N; p++) if (label[p] !== -1 && !keep.has(label[p])) data[p * 4 + 3] = 0;
    return { dropped: dropped.sort((a, b) => b - a) };
}

/**
 * The key-colour stack: keyCut → keepFigure.
 * @param {Img} raw
 * @param {{ protect?: Uint8Array }} [o] see keyCut
 */
export function cutKey(raw, o = {}) {
    const k = keyCut(raw, o);
    const kept = keepFigure(k.image);
    return { ...k, dropped: kept.dropped };
}

/**
 * The rest of the white stack, after the removal model: floodWhite → edgeMatte → keepFigure.
 * @param {Img} removerCut the remover's RGBA output (raw colours, its alpha)
 * @param {{ flood?: boolean, trapped?: boolean, trappedDark?: number, trappedR?: number }} [o]
 */
export function finishWhiteCut(removerCut, o = {}) {
    const flood = (o.flood ?? true) ? floodWhite(removerCut, o) : { image: removerCut, cleared: 0, trapped: [] };
    const image = edgeMatte(flood.image);
    const kept = keepFigure(image);
    return { image, cleared: flood.cleared, trapped: flood.trapped, dropped: kept.dropped };
}

/**
 * Which stack a raw sprite wants: a white border → the remover stack; any other flat border → the colour cut.
 * @param {Img} raw @returns {'white' | 'key'}
 */
export function cutMode(raw) {
    return isWhiteKey(borderStats(raw).key) ? 'white' : 'key';
}
