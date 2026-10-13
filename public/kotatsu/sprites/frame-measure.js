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
 */

/** url → frame, as a promise so concurrent callers share one load. */
const frames = new Map();

/** Width the bottom row is sampled at: plenty to tell two feet from a torso, cheap to read. */
const SAMPLE_WIDTH = 256;

/**
 * @param {string} url
 * @returns {Promise<SpriteFrame>}
 */
export function loadFrame(url) {
    const unknown = { aspect: DEFAULT_ASPECT, bottomCoverage: null, leftCoverage: null, rightCoverage: null };
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
            });
        };
        image.onerror = () => resolve(unknown);
        image.src = url;
    });
    frames.set(url, pending);
    return pending;
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
