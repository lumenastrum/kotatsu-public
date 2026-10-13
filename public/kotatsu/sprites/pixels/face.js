// Face geometry for the generator: the bust crop derived from a full-body master, the two repaint masks proposed from
// a face box (features / flush, docs/handoffs/sprite-generator.md §2.3), the paste-back shapes that carry a bust's
// face into the full body, and protected marks (a mole or scar pasted back pixel-exact after every repaint).
// A face box `{ x, y, w, h }` is what a face detector returns (it includes bangs and crown) or what the user drags.

import { copyWhere, dilate } from './image.js';

/** @typedef {import('./image.js').Img} Img */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box */
/** @typedef {{ cx: number, cy: number, rx: number, ry: number }} Ellipse */

/**
 * Feature shapes from a face box, measured on the detector's box (n = 3 faces): brows ≈ 0.32, eyes 0.40–0.47,
 * mouth 0.71–0.73, chin ≈ 0.85 of its height; the face spans about the middle 60 % of its width.
 * @param {Box} face
 * @returns {{ band: Ellipse, mouth: Ellipse, cheeks: Ellipse }}
 */
export function faceShapes(face) {
    const cx = face.x + face.w / 2;
    return {
        band: { cx, cy: face.y + face.h * 0.40, rx: face.w * 0.36, ry: face.h * 0.11 },
        mouth: { cx, cy: face.y + face.h * 0.72, rx: face.w * 0.13, ry: face.h * 0.07 },
        cheeks: { cx, cy: face.y + face.h * 0.60, rx: face.w * 0.30, ry: face.h * 0.17 },
    };
}

/**
 * Which shapes a mask type covers: `features` = eye/brow band + mouth (cheeks, nose and marks left out; most labels);
 * `flush` = features + cheeks (blush / embarrassment: a features mask leaves no room for the cheeks' colour).
 * @param {{ band: Ellipse, mouth: Ellipse, cheeks: Ellipse }} shapes @param {'features' | 'flush'} type
 * @returns {Ellipse[]}
 */
export function maskShapes(shapes, type) {
    return type === 'flush' ? [shapes.band, shapes.cheeks, shapes.mouth] : [shapes.band, shapes.mouth];
}

/**
 * A soft mask (0..255) of filled ellipses; the edge ramps over about `feather` px.
 * @param {number} W @param {number} H @param {Ellipse[]} ellipses @param {number} feather
 * @returns {Uint8Array}
 */
export function shapesMask(W, H, ellipses, feather) {
    const mask = new Uint8Array(W * H);
    for (const e of ellipses) {
        // v > 0 only where d < 1 + 0.5 / k, so only that scaled ellipse's box needs a visit (a flat ellipse's ramp
        // reaches farther along its long axis than feather / 2).
        const k = Math.min(e.rx, e.ry) / feather;
        const reach = 1 + 0.5 / k;
        const x0 = Math.max(0, Math.floor(e.cx - e.rx * reach) - 1), x1 = Math.min(W - 1, Math.ceil(e.cx + e.rx * reach) + 1);
        const y0 = Math.max(0, Math.floor(e.cy - e.ry * reach) - 1), y1 = Math.min(H - 1, Math.ceil(e.cy + e.ry * reach) + 1);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const d = Math.hypot((x + 0.5 - e.cx) / e.rx, (y + 0.5 - e.cy) / e.ry);
            const v = Math.round(Math.max(0, Math.min(1, (1 - d) * k + 0.5)) * 255);
            const p = y * W + x;
            if (v > mask[p]) mask[p] = v;
        }
    }
    return mask;
}

/**
 * The two repaint masks for a face, at the image's size. The repaint thresholds them (any painted pixel is a full
 * repaint), so the feather only shapes the edge the user sees and nudges.
 * @param {Box} face @param {number} W @param {number} H @param {number} [feather]
 */
export function faceMasks(face, W, H, feather = 10) {
    const shapes = faceShapes(face);
    return {
        shapes,
        features: shapesMask(W, H, maskShapes(shapes, 'features'), feather),
        flush: shapesMask(W, H, maskShapes(shapes, 'flush'), feather),
    };
}

/**
 * Bounding box of a soft mask's painted pixels (value > threshold). Null when nothing is painted.
 * @param {Uint8Array} mask @param {number} W @param {number} H @param {number} [threshold]
 * @returns {Box | null}
 */
export function maskBox(mask, W, H, threshold = 127) {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (mask[y * W + x] > threshold) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The figure's top between columns x0..x1: the first row with a pixel far (> 60) from the key. The key is read from
 * the top row (median). This finds ears, horns and hats above the face box, which the detector leaves out.
 * @param {Img} raw @param {number} x0 @param {number} x1
 * @returns {{ y: number, key: number[] }}
 */
export function figureTop(raw, x0, x1) {
    const { width: W, height: H, data: d } = raw;
    const top = [];
    for (let x = 0; x < W; x += 2) top.push(x);
    const med = (/** @type {number} */ c) => { const v = top.map(p => d[p * 4 + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
    const key = [med(0), med(1), med(2)];
    const from = Math.max(0, Math.floor(x0)), to = Math.min(W, Math.ceil(x1));
    for (let y = 0; y < H; y++) for (let x = from; x < to; x++) {
        const i = (y * W + x) * 4;
        if (Math.hypot(d[i] - key[0], d[i + 1] - key[1], d[i + 2] - key[2]) > 60) return { y, key };
    }
    return { y: 0, key };
}

/**
 * The bust's square on the master: from just above the figure's own top down to `bustHeight` face heights below the
 * face top, centred on the face, a multiple of 8, inside the canvas. Face size is the detail budget: 2.6 face heights
 * gave a 276 px face at 1024², 2.1 gives 311 px.
 * @param {Img} raw the master @param {Box} face on the master
 * @param {{ bustHeight?: number, headroom?: number }} [o]
 * @returns {{ x: number, y: number, side: number, top: number }} top = the figure's top found on the key
 */
export function bustCrop(raw, face, o = {}) {
    const bustHeight = o.bustHeight ?? 2.1;
    const headroom = o.headroom ?? 12;
    const { width: W, height: H } = raw;
    const top = figureTop(raw, face.x - face.w * 0.3, face.x + face.w * 1.3).y;
    const start = Math.max(0, top - headroom);
    let side = Math.round((face.y + face.h * bustHeight - start) / 8) * 8;
    side = Math.max(8, Math.min(side, W, H));
    const x = Math.max(0, Math.min(W - side, Math.round(face.x + face.w / 2 - side / 2)));
    const y = Math.max(0, Math.min(H - side, top - headroom));
    return { x, y, side, top };
}

/**
 * The paste-back shapes: a bust repaint's mask shapes grown by `grow` px (bust pixels) and scaled into the master's
 * bust square (`scale` = side / bust size). Composite through `shapesMask(side, side, ..., grow * scale)`.
 * @param {{ band: Ellipse, mouth: Ellipse, cheeks: Ellipse }} shapes on the bust
 * @param {'features' | 'flush'} type @param {number} scale @param {number} [grow]
 * @returns {Ellipse[]}
 */
export function pasteShapes(shapes, type, scale, grow = 14) {
    return maskShapes(shapes, type).map(e => ({
        cx: e.cx * scale, cy: e.cy * scale, rx: (e.rx + grow) * scale, ry: (e.ry + grow) * scale,
    }));
}

/**
 * A protected mark from one click: the blob around (x, y) that stands out from the skin around it, plus its
 * anti-aliased rim. Skin = the median colour of a ring at `radius`; the blob = pixels inside the disk farther than
 * `threshold` from it, 8-connected to the standing-out pixel nearest the click; then grown 2 px, inside the disk.
 * A click on nothing distinct marks a small disk (radius / 3), so the click is never lost.
 * @param {Img} img the neutral @param {number} x @param {number} y
 * @param {{ radius?: number, threshold?: number }} [o]
 * @returns {Uint8Array} hard mask (0 / 1)
 */
export function markRegion(img, x, y, o = {}) {
    const R = o.radius ?? 14;
    const T = o.threshold ?? 28;
    const { width: W, height: H, data: d } = img;
    const cx = Math.round(x), cy = Math.round(y);
    const mask = new Uint8Array(W * H);
    const inDisk = (/** @type {number} */ px, /** @type {number} */ py, /** @type {number} */ r) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
    /** @type {number[][]} */
    const ring = [[], [], []];
    for (let py = cy - R - 2; py <= cy + R + 2; py++) for (let px = cx - R - 2; px <= cx + R + 2; px++) {
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const dd = (px - cx) ** 2 + (py - cy) ** 2;
        if (dd < R * R || dd > (R + 2) ** 2) continue;
        const i = (py * W + px) * 4;
        ring[0].push(d[i]); ring[1].push(d[i + 1]); ring[2].push(d[i + 2]);
    }
    const disk = (/** @type {number} */ r) => {
        for (let py = cy - r; py <= cy + r; py++) for (let px = cx - r; px <= cx + r; px++) {
            if (px >= 0 && py >= 0 && px < W && py < H && inDisk(px, py, r)) mask[py * W + px] = 1;
        }
        return mask;
    };
    if (!ring[0].length) return disk(Math.max(2, Math.round(R / 3)));
    const skin = ring.map(v => v.sort((a, b) => a - b)[v.length >> 1]);
    const distinct = (/** @type {number} */ px, /** @type {number} */ py) => {
        if (px < 0 || py < 0 || px >= W || py >= H || !inDisk(px, py, R)) return false;
        const i = (py * W + px) * 4;
        return Math.hypot(d[i] - skin[0], d[i + 1] - skin[1], d[i + 2] - skin[2]) > T;
    };
    let seed = -1, seedD = Infinity;
    for (let py = cy - R; py <= cy + R; py++) for (let px = cx - R; px <= cx + R; px++) {
        if (!distinct(px, py)) continue;
        const dd = (px - cx) ** 2 + (py - cy) ** 2;
        if (dd < seedD) { seedD = dd; seed = py * W + px; }
    }
    if (seed < 0) return disk(Math.max(2, Math.round(R / 3)));
    const blob = new Uint8Array(W * H);
    const stack = [seed];
    blob[seed] = 1;
    while (stack.length) {
        const q = /** @type {number} */ (stack.pop());
        const qx = q % W, qy = (q - qx) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = qx + dx, ny = qy + dy;
            const r = ny * W + nx;
            if (!distinct(nx, ny) || blob[r]) continue;
            blob[r] = 1;
            stack.push(r);
        }
    }
    const grown = dilate(blob, W, H, 2);
    for (let p = 0; p < grown.length; p++) {
        if (!grown[p]) continue;
        const px = p % W, py = (p - px) / W;
        if (inDisk(px, py, R)) mask[p] = 1;
    }
    return mask;
}

/**
 * After a repaint: the neutral's pixels back inside the protected marks, pixel-exact (a flush-mask blush once redrew
 * a cheek scar as a star). In place on `repainted`.
 * @param {Img} neutral @param {Img} repainted @param {Uint8Array} marks
 * @returns {number} pixels restored
 */
export function pasteMarks(neutral, repainted, marks) {
    if (neutral.width !== repainted.width || neutral.height !== repainted.height) throw new Error('pasteMarks: sizes differ');
    return copyWhere(neutral, repainted, marks);
}
