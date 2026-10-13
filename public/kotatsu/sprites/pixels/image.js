// Pixel basics shared by the sprite cut, the generator's gates and Touch-up. Pure functions on RGBA images
// `{ width, height, data }`, no DOM and no Node APIs, so the browser (Studio) and the server (Jimp bitmaps) run the
// same code. A mask is a `Uint8Array` of width × height: 0 / 1 for hard masks, 0..255 for soft ones.

/** @typedef {{ width: number, height: number, data: Uint8Array | Uint8ClampedArray }} Img */

/** The lime the generator asks for (Anima "bright green background", 2026-10-10): the key-colour gate's reference. */
export const LIME = Object.freeze([175, 242, 76]);

/**
 * @param {number} width @param {number} height
 * @returns {Img}
 */
export function createImage(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** @param {Img} img @returns {Img} */
export function cloneImage(img) {
    return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Rec. 601 luma of the pixel at byte offset `i`. @param {ArrayLike<number>} d @param {number} i */
export function luma(d, i) {
    return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/** Chroma magnitude of an RGB triple: distance from its own grey. @param {ArrayLike<number>} c */
export function chromaOf(c) {
    const m = (c[0] + c[1] + c[2]) / 3;
    return Math.hypot(c[0] - m, c[1] - m, c[2] - m);
}

/**
 * Every second pixel of the four edges (corners may repeat): the samples the key is read from.
 * @param {number} W @param {number} H
 * @returns {number[]} pixel indices
 */
export function borderSamples(W, H) {
    const border = [];
    for (let x = 0; x < W; x += 2) border.push(x, (H - 1) * W + x);
    for (let y = 0; y < H; y += 2) border.push(y * W, y * W + W - 1);
    return border;
}

/**
 * The border's key colour: per-channel median of the border samples, and the median distance from it (spread).
 * @param {Img} img
 * @returns {{ key: number[], spread: number, dists: number[] }} dists = the samples' distances, ascending
 */
export function borderStats(img) {
    const { width: W, height: H, data: d } = img;
    const border = borderSamples(W, H);
    const median = (/** @type {number} */ c) => {
        const v = border.map(p => d[p * 4 + c]).sort((a, b) => a - b);
        return v[v.length >> 1];
    };
    const key = [median(0), median(1), median(2)];
    const dists = border.map(p => Math.hypot(d[p * 4] - key[0], d[p * 4 + 1] - key[1], d[p * 4 + 2] - key[2])).sort((a, b) => a - b);
    return { key, spread: dists[dists.length >> 1], dists };
}

/**
 * Whether a key colour reads as white (the ToonOut stack) rather than a colour key (the colour cut).
 * @param {number[]} key
 */
export function isWhiteKey(key) {
    return Math.min(...key) >= 235 && Math.max(...key) - Math.min(...key) <= 12;
}

/**
 * The background colour: border median, its spread, and a tolerance. White gets a tight tolerance (pure white is
 * also paint: eye whites, shine); a colour key a looser one (4 × spread, 18..40).
 * @param {Img} raw
 * @returns {{ key: number[], white: boolean, spread: number, tol: number }}
 */
export function detectKey(raw) {
    const { key, spread } = borderStats(raw);
    const white = isWhiteKey(key);
    const tol = white ? 14 : Math.round(Math.min(40, Math.max(18, 4 * spread)));
    return { key, white, spread: Math.round(spread * 10) / 10, tol };
}

/**
 * The key's chroma direction, for "is this pixel the key's hue at some strength?". `perp` = how far the pixel's chroma
 * leaves that direction, `ratio` = how much of the key's chroma it carries. A grey key has no direction: every pixel
 * reads ratio 0, perp Infinity (never key-hued).
 * @param {number[]} key
 * @returns {(r: number, g: number, b: number) => { ratio: number, perp: number }}
 */
export function keyChroma(key) {
    const mB = (key[0] + key[1] + key[2]) / 3;
    const cB = [key[0] - mB, key[1] - mB, key[2] - mB];
    const cBB = cB[0] ** 2 + cB[1] ** 2 + cB[2] ** 2;
    return (r, g, b) => {
        if (cBB < 1) return { ratio: 0, perp: Infinity };
        const m = (r + g + b) / 3;
        const c0 = r - m, c1 = g - m, c2 = b - m;
        const ratio = (c0 * cB[0] + c1 * cB[1] + c2 * cB[2]) / cBB;
        return { ratio, perp: Math.hypot(c0 - ratio * cB[0], c1 - ratio * cB[1], c2 - ratio * cB[2]) };
    };
}

/** Max chroma drift off the key's direction that still counts as the key's hue. */
export const KEY_PERP = 14;

/**
 * Is the RAW pixel p the background colour? Distance within `tol`; for a colour key also the key darkened or
 * lightened by shading (0.8–1.15 ×) and the key mixed with a neutral (same chroma direction, ≥ 80 % of it).
 * White uses distance only: a scaled white is a grey, and grey is hair.
 * @param {Img} raw @param {number[]} key @param {number} tol @param {boolean} white
 * @returns {(p: number) => boolean}
 */
export function keyTester(raw, key, tol, white) {
    const d = raw.data;
    const B = key;
    const BB = B[0] ** 2 + B[1] ** 2 + B[2] ** 2;
    const chroma = keyChroma(key);
    const hued = !white && chroma(B[0], B[1], B[2]).perp !== Infinity;
    return p => {
        const i = p * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (Math.hypot(r - B[0], g - B[1], b - B[2]) <= tol) return true;
        if (!hued) return false;
        const s = (r * B[0] + g * B[1] + b * B[2]) / BB;
        if (s >= 0.8 && s <= 1.15 && Math.hypot(r - s * B[0], g - s * B[1], b - s * B[2]) <= tol) return true;
        const k = chroma(r, g, b);
        return k.ratio >= 0.8 && k.perp <= KEY_PERP;
    };
}

/** Share of the key's chroma a darker pixel needs to read as the key in shadow. */
export const SHADOW_HUE = 0.3;

/**
 * A cast shadow on the key: the key's own hue (chroma along the key's direction, little off it), darker than the
 * key, but too dark for the shading rule's 0.8 ×. Anima paints these under standing feet (measured 2026-10-12 on a
 * full body: shadow pixels at 0.45–0.72 of the key's chroma, 3–8 off its direction, well below its luma). Per pixel
 * this is not enough to call it background (lime-ish shading inside a figure would pass too): keyCut only takes such
 * pixels when they connect to the key.
 * @param {Img} raw @param {number[]} key
 * @returns {(p: number) => boolean}
 */
export function keyShadowTester(raw, key) {
    const d = raw.data;
    const chroma = keyChroma(key);
    const keyLuma = luma(key, 0);
    const keyChromaSize = chromaOf(key);
    return p => {
        const i = p * 4;
        if (luma(d, i) >= keyLuma * 0.95) return false;
        const k = chroma(d[i], d[i + 1], d[i + 2]);
        // Within SHADOW_ANGLE of the key's hue: a shadow's core runs bluer than the key (measured 15–21 off its
        // direction at 0.6 of its chroma, ~18°), so the off-direction allowance grows with the chroma along it.
        return k.ratio >= SHADOW_HUE && k.perp <= Math.max(KEY_PERP, SHADOW_TAN * k.ratio * keyChromaSize);
    };
}

/** tan of the widest angle off the key's hue a shadow pixel may have (30°). */
const SHADOW_TAN = Math.tan(30 * Math.PI / 180);

/**
 * Grows a hard mask by `r` px (Chebyshev). Separable max filter: rows, then columns.
 * @param {Uint8Array} mask @param {number} W @param {number} H @param {number} r
 * @returns {Uint8Array}
 */
export function dilate(mask, W, H, r) {
    const tmp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        let last = -Infinity;
        for (let x = 0; x < W; x++) { if (mask[y * W + x]) last = x; if (x - last <= r) tmp[y * W + x] = 1; }
        last = Infinity;
        for (let x = W - 1; x >= 0; x--) { if (mask[y * W + x]) last = x; if (last - x <= r) tmp[y * W + x] = 1; }
    }
    const out = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
        let last = -Infinity;
        for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 1; }
        last = Infinity;
        for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) last = y; if (last - y <= r) out[y * W + x] = 1; }
    }
    return out;
}

/**
 * A mask as an opaque grey RGBA image (white = painted), for encoding and upload as a ComfyUI mask.
 * A hard mask (0 / 1) maps to 0 / 255; a soft one (`soft`, 0..255) keeps its value.
 * @param {Uint8Array} mask @param {number} W @param {number} H @param {boolean} [soft]
 * @returns {Img}
 */
export function maskToImage(mask, W, H, soft = false) {
    const img = createImage(W, H);
    for (let p = 0; p < mask.length; p++) {
        const v = soft ? mask[p] : (mask[p] ? 255 : 0);
        const i = p * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
    }
    return img;
}

/**
 * One channel of an image as a soft mask (0..255): a ComfyUI mask or a detector's mask saved as an image.
 * @param {Img} img @param {number} [channel] 0 = red
 * @returns {Uint8Array}
 */
export function imageToMask(img, channel = 0) {
    const N = img.width * img.height;
    const mask = new Uint8Array(N);
    for (let p = 0; p < N; p++) mask[p] = img.data[p * 4 + channel];
    return mask;
}

/**
 * Copies `src`'s pixels (RGBA) into `dst` inside `mask`, in place.
 * @param {Img} src @param {Img} dst @param {Uint8Array} mask
 * @returns {number} pixels changed
 */
export function copyWhere(src, dst, mask) {
    let n = 0;
    for (let p = 0; p < mask.length; p++) {
        if (!mask[p]) continue;
        const i = p * 4;
        if (dst.data[i] === src.data[i] && dst.data[i + 1] === src.data[i + 1] && dst.data[i + 2] === src.data[i + 2] && dst.data[i + 3] === src.data[i + 3]) continue;
        dst.data[i] = src.data[i]; dst.data[i + 1] = src.data[i + 1]; dst.data[i + 2] = src.data[i + 2]; dst.data[i + 3] = src.data[i + 3];
        n++;
    }
    return n;
}
