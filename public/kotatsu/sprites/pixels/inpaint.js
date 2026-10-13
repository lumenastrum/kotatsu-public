// The repaint region for a face repaint with core ComfyUI nodes only: what ArtVenture's
// `PrepareImageAndMaskForInpaint` / `OverlayInpaintedImage` did, as plain pixel math. The graph crops the square
// around the mask (+ padding), scales it to the model's size, repaints inside the hard mask, scales back and
// composites through a blurred copy of that mask.

import { dilate } from './image.js';

/**
 * Any painted pixel is a full repaint (the graph's old `ThresholdMask 0.1`): a soft brush once saved a 50–75 % mask
 * that blended the old face back in and blocked the change.
 * @param {Uint8Array} mask 0..255 @param {number} [threshold] 0..255, painted above it
 * @returns {Uint8Array} 0 / 1
 */
export function hardMask(mask, threshold = 25) {
    const out = new Uint8Array(mask.length);
    for (let p = 0; p < mask.length; p++) if (mask[p] > threshold) out[p] = 1;
    return out;
}

/**
 * Box blur of a 0 / 1 mask into 0..255, radius r (three passes ≈ gaussian), for the composite's soft edge.
 * @param {Uint8Array} mask 0 / 1 @param {number} W @param {number} H @param {number} r
 * @returns {Uint8Array} 0..255
 */
export function blurMask(mask, W, H, r) {
    let a = new Float32Array(mask.length);
    for (let p = 0; p < mask.length; p++) a[p] = mask[p] ? 255 : 0;
    if (r < 1) return Uint8Array.from(a, v => Math.round(v));
    const k = Math.max(1, Math.round(r / Math.sqrt(3)));
    for (let pass = 0; pass < 3; pass++) {
        const b = new Float32Array(a.length);
        for (let y = 0; y < H; y++) {
            let sum = 0;
            for (let x = -k; x <= k; x++) sum += a[y * W + Math.min(W - 1, Math.max(0, x))];
            for (let x = 0; x < W; x++) {
                b[y * W + x] = sum / (2 * k + 1);
                sum += a[y * W + Math.min(W - 1, x + k + 1)] - a[y * W + Math.max(0, x - k)];
            }
        }
        const c = new Float32Array(a.length);
        for (let x = 0; x < W; x++) {
            let sum = 0;
            for (let y = -k; y <= k; y++) sum += b[Math.min(H - 1, Math.max(0, y)) * W + x];
            for (let y = 0; y < H; y++) {
                c[y * W + x] = sum / (2 * k + 1);
                sum += b[Math.min(H - 1, y + k + 1) * W + x] - b[Math.max(0, y - k) * W + x];
            }
        }
        a = c;
    }
    return Uint8Array.from(a, v => Math.round(v));
}

/**
 * Nearest-neighbour crop + scale of a mask: the `side`² square at (x, y) drawn at `size`².
 * @param {Uint8Array} mask @param {number} W @param {{x: number, y: number, side: number}} crop @param {number} size
 * @returns {Uint8Array}
 */
export function cropScaleMask(mask, W, crop, size) {
    const out = new Uint8Array(size * size);
    const k = crop.side / size;
    for (let y = 0; y < size; y++) {
        const sy = crop.y + Math.min(crop.side - 1, Math.floor((y + 0.5) * k));
        for (let x = 0; x < size; x++) {
            const sx = crop.x + Math.min(crop.side - 1, Math.floor((x + 0.5) * k));
            out[y * size + x] = mask[sy * W + sx];
        }
    }
    return out;
}

/**
 * The repaint region of a mask on a W × H image: the square around its painted pixels plus `pad`, a multiple of 8,
 * inside the image; the hard mask inside that square drawn at `size`² (what the model repaints); and the composite
 * mask at the square's own size (the hard mask grown by `grow` and blurred by `blur`, what the result is pasted
 * through). Null when nothing is painted.
 * @param {Uint8Array} mask 0..255 (soft or hard) @param {number} W @param {number} H
 * @param {{ threshold?: number, pad?: number, size?: number, blur?: number, grow?: number }} [o]
 * @returns {{ crop: {x: number, y: number, side: number}, inner: Uint8Array, blend: Uint8Array, size: number } | null}
 *   inner = 0 / 255 at size², blend = 0..255 at side²
 */
export function repaintRegion(mask, W, H, o = {}) {
    const pad = o.pad ?? 64;
    const size = o.size ?? 1024;
    const blur = o.blur ?? 8;
    const grow = o.grow ?? 0;
    const hard = hardMask(mask, o.threshold ?? 25);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!hard[y * W + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    let side = Math.max(x1 - x0 + 1, y1 - y0 + 1) + 2 * pad;
    side = Math.min(Math.ceil(side / 8) * 8, Math.floor(Math.min(W, H) / 8) * 8);
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
    const x = Math.max(0, Math.min(W - side, Math.round(cx - side / 2)));
    const y = Math.max(0, Math.min(H - side, Math.round(cy - side / 2)));
    const crop = { x, y, side };
    const inner = cropScaleMask(hard, W, crop, size);
    for (let p = 0; p < inner.length; p++) inner[p] = inner[p] ? 255 : 0;
    const local = cropScaleMask(grow > 0 ? dilate(hard, W, H, grow) : hard, W, crop, side);
    return { crop, inner, blend: blurMask(local, side, side, blur), size };
}
