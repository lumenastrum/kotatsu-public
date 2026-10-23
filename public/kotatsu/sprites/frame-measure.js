/**
 * Sprites — what a sprite file looks like, measured once per URL: its aspect and how much of its bottom row is
 * opaque. The stage and the studio's framing preview both use it, so the preview shows what the stage will.
 * The decision itself is pure and lives in stage-model.js (`cropFor`).
 */
import { DEFAULT_ASPECT } from './stage-model.js';

/**
 * @typedef {object} SpriteFrame
 * @property {number} aspect width / height
 * @property {number|null} bottomCoverage opaque share (alpha > 128) of the bottom row, 0..1; null when unreadable
 * @property {number|null} leftCoverage opaque share of the leftmost column (art cut by the canvas edge)
 * @property {number|null} rightCoverage opaque share of the rightmost column
 * @property {FigureBox|null} box where the figure is (alpha > 32), as fractions of the canvas; null when unreadable or empty
 */

/**
 * @typedef {object} FigureBox
 * @property {number} top @property {number} bottom @property {number} left @property {number} right 0..1, bottom/right exclusive
 */

/** url → frame, as a promise so concurrent callers share one load. */
const frames = new Map();

/** Width the bottom row is sampled at: plenty to tell two feet from a torso, cheap to read. */
const SAMPLE_WIDTH = 256;

/** Width the whole sprite is read at for its figure box: about 1% of the canvas per pixel, a few dozen KB to scan. */
const BOX_WIDTH = 96;

/**
 * @param {string} url
 * @returns {Promise<SpriteFrame>}
 */
export function loadFrame(url) {
    const unknown = { aspect: DEFAULT_ASPECT, bottomCoverage: null, leftCoverage: null, rightCoverage: null, box: null };
    if (!url) return Promise.resolve(unknown);
    const known = frames.get(url);
    if (known) return known;
    const pending = new Promise(resolve => {
        const image = new Image();
        image.onload = () => {
            const w = image.naturalWidth, h = image.naturalHeight;
            if (!(w > 0 && h > 0)) return resolve(unknown);
            resolve({
                aspect: w / h,
                bottomCoverage: edgeCoverage(image, 0, h - 1, w, 1),
                leftCoverage: edgeCoverage(image, 0, 0, 1, h),
                rightCoverage: edgeCoverage(image, w - 1, 0, 1, h),
                box: figureBox(image),
            });
        };
        image.onerror = () => resolve(unknown);
        image.src = url;
    });
    frames.set(url, pending);
    return pending;
}

/**
 * Where the figure is: the box around every pixel with alpha > 32, read from a {@link BOX_WIDTH}-wide copy (so it is
 * accurate to about one percent, plenty for framing a tile). The card studio frames full-body tiles on it: a slim pose
 * on a wide canvas otherwise stands small at the bottom of a tall tile (Andres, 2026-10-19).
 * @param {HTMLImageElement} image
 * @returns {FigureBox|null} null when unreadable or fully transparent
 */
function figureBox(image) {
    try {
        const w = BOX_WIDTH;
        const h = Math.max(1, Math.round(BOX_WIDTH * image.naturalHeight / image.naturalWidth));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        let top = h, bottom = -1, left = w, right = -1;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (data[(y * w + x) * 4 + 3] <= 32) continue;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
                if (x < left) left = x;
                if (x > right) right = x;
            }
        }
        if (bottom < 0) return null;
        return { top: top / h, bottom: (bottom + 1) / h, left: left / w, right: (right + 1) / w };
    } catch {
        return null;
    }
}

/**
 * Opaque share (alpha > 128) of a one-pixel edge strip of the image (a row or a column), sampled at up to
 * {@link SAMPLE_WIDTH} points along it.
 * @param {HTMLImageElement} image
 * @param {number} sx @param {number} sy @param {number} sw @param {number} sh the strip in source pixels
 * @returns {number|null} null when unreadable
 */
function edgeCoverage(image, sx, sy, sw, sh) {
    try {
        const along = Math.min(SAMPLE_WIDTH, Math.max(sw, sh));
        const canvas = document.createElement('canvas');
        canvas.width = sw > sh ? along : 1;
        canvas.height = sw > sh ? 1 : along;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        const strip = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = 0;
        for (let i = 3; i < strip.length; i += 4) if (strip[i] > 128) opaque++;
        return opaque / along;
    } catch {
        // A tainted canvas (a cross-origin URL) reads nothing: fall back to the full-body defaults.
        return null;
    }
}
