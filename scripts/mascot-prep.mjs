/**
 * Mikan-chan's served art, generated from the painted masters. Never hand-edit the outputs.
 *
 *   node scripts/mascot-prep.mjs [--preview <dir>]
 *
 * Reads `docs/design/mascot/<pose>.png` (Codex image_gen masters, 1024×1536 RGBA; prompts in
 * `docs/design/mascot/prompts.md`) and writes, per pose, into `public/kotatsu/brand/mascot/`:
 *   - `<pose>.webp`      full body, trimmed, FULL_HEIGHT tall (2× a ~450px display)
 *   - `<pose>-bust.webp` head-and-shoulders square, BUST_SIZE (2× a 128px display)
 * and, for the loader's chibi (`chibi.png` + `chibi-blink.png`, 1254² masters; docs/loader-v0.md):
 *   - `chibi.webp`       the sprite, CHIBI_HEIGHT tall (2× the 160px loader display)
 *   - `chibi-blink.webp` only her closed eyes, feathered ovals on the same canvas
 * It also fails if the blink master drifted off the open one, or if the glint positions in
 * `public/css/loader.css` no longer sit on the star pupils it measures.
 *
 * The generator paints the figure at alpha 253 and leaves its glow colors under alpha 0, so
 * cleaning snaps the body solid, zeroes hidden color, and drops stray specks. Every output is
 * decoded again and pixel-QA'd; any failure exits non-zero. `--preview` also writes contact
 * sheets on the Blue Hour and Sparkle grounds for an eyeball pass.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// The jsquash codecs fetch() their .wasm from file:// URLs; the server's patch serves those.
import '../src/fetch-patch.js';
import { Jimp } from '../src/jimp.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = path.join(REPO_ROOT, 'docs', 'design', 'mascot');
const OUTPUT = path.join(REPO_ROOT, 'public', 'kotatsu', 'brand', 'mascot');

const FULL_HEIGHT = 900;
const BUST_SIZE = 256;
const TRIM_PAD = 8;
/** At or above this the generator meant "solid"; below it is the anti-aliased edge. */
const SOLID_ALPHA = 240;
/** Detached opaque islands smaller than this are noise. Requested sparkles/steam/sweat are 600px+. */
const SPECK_PIXELS = 50;
const VISIBLE_ALPHA = 16;
/**
 * The generator also paints a ~1%-alpha glow up to 300px out. A faint (not visible) pixel this
 * far from anything visible is haze; thin strands' soft fringes sit next to visible pixels.
 */
const HAZE_ALPHA = VISIBLE_ALPHA + 1;
const HAZE_DISTANCE = 4;
const WEBP = { quality: 90, alphaQuality: 100, alphaCompression: 1, exact: 0 };

/**
 * Head-and-shoulders boxes in master pixels: `[x, y, side]`. Measured from each pose's hair
 * (union of large hair-colored blobs, side = 1.25 × its extent) with the top anchored to the
 * figure's top so the ahoge survives — except `ready`, whose top pixel is the raised pen.
 * Negative y is headroom; the canvas pads it transparent.
 * @type {Readonly<Record<string, readonly [number, number, number]>>}
 */
const BUST_BOXES = Object.freeze({
    welcome: [239, -24, 550],
    connect: [270, -12, 462],
    sauce: [292, -10, 443],
    persona: [262, -11, 480],
    card: [272, -11, 462],
    ready: [283, 28, 497],
    oops: [271, -11, 470],
    // The chalkboard sits left of her (easel wood is orange too, so this one was set from the
    // painting, not the hair-blob measure); the box keeps to her side of the board.
    teach: [395, -10, 455],
});

const GROUNDS = Object.freeze({ 'blue-hour': 0x0e1119ff, sparkle: 0x150e1bff });

/**
 * The chibi is the loader's Mikan-chan (docs/loader-v0.md). Two masters: `chibi.png` (eyes
 * open, star pupils) and `chibi-blink.png` (the same painting, eyes closed). The sprite displays
 * 160px tall; the blink ships only as feathered eye ovals laid over the sprite.
 */
const CHIBI_HEIGHT = 320;
/** Eye ovals for the blink patch, in master px around each measured star pupil. */
const CHIBI_EYE_RX = 100;
const CHIBI_EYE_RY = 90;
const CHIBI_EYE_FEATHER = 24;
/** The blink master must sit on the open master: silhouette overlap and color drift outside the eyes. */
const CHIBI_MIN_IOU = 0.98;
const CHIBI_MAX_DRIFT = 8;
/** Glint positions in loader.css may differ from the measured pupils by this much (% of sprite; ~0.5px at display size). */
const CHIBI_EYE_TOLERANCE = 0.35;
const LOADER_CSS = path.join(REPO_ROOT, 'public', 'css', 'loader.css');

/**
 * Labels 4-connected regions of visible alpha.
 * @param {Buffer} data RGBA bytes
 * @param {number} width Width
 * @param {number} height Height
 * @returns {{labels: Int32Array, sizes: number[]}} Label per pixel (0 = none) and size per label
 */
function visibleRegions(data, width, height) {
    const labels = new Int32Array(width * height);
    const sizes = [0];
    const stack = new Int32Array(width * height);
    for (let start = 0; start < labels.length; start++) {
        if (labels[start] || data[start * 4 + 3] <= VISIBLE_ALPHA) continue;
        const label = sizes.length;
        let top = 0;
        let size = 0;
        stack[top++] = start;
        labels[start] = label;
        while (top) {
            const index = stack[--top];
            size++;
            const x = index % width;
            for (const next of [index - width, index + width, x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1]) {
                if (next < 0 || next >= labels.length || labels[next] || data[next * 4 + 3] <= VISIBLE_ALPHA) continue;
                labels[next] = label;
                stack[top++] = next;
            }
        }
        sizes.push(size);
    }
    return { labels, sizes };
}

/**
 * Marks pixels within `radius` steps (8-connected) of a visible pixel.
 * @param {Buffer} data RGBA bytes
 * @param {number} width Width
 * @param {number} height Height
 * @param {number} radius Steps
 * @returns {Uint8Array} 1 = near something visible
 */
function nearVisible(data, width, height, radius) {
    const near = new Uint8Array(width * height);
    let frontier = [];
    for (let index = 0; index < near.length; index++) {
        if (data[index * 4 + 3] > VISIBLE_ALPHA) {
            near[index] = 1;
            frontier.push(index);
        }
    }
    for (let step = 0; step < radius; step++) {
        const next = [];
        for (const index of frontier) {
            const x = index % width;
            const y = (index - x) / width;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                    const neighbor = ny * width + nx;
                    if (near[neighbor]) continue;
                    near[neighbor] = 1;
                    next.push(neighbor);
                }
            }
        }
        frontier = next;
    }
    return near;
}

/**
 * Faint pixels away from the body: the generator's glow.
 * @param {Buffer} data RGBA bytes
 * @param {Uint8Array} near {@link nearVisible} mask
 * @param {number} index Pixel
 * @returns {boolean} Haze
 */
function isHaze(data, near, index) {
    const alpha = data[index * 4 + 3];
    return alpha > 0 && alpha < HAZE_ALPHA && !near[index];
}

/**
 * Snaps the body solid, drops specks and haze, zeroes color under full transparency. Mutates in place.
 * @param {import('@jimp/types').Bitmap} bitmap Master bitmap
 * @returns {number} Specks removed
 */
function clean(bitmap) {
    const { data, width, height } = bitmap;
    const { labels, sizes } = visibleRegions(data, width, height);
    let specks = 0;
    for (let index = 0; index < labels.length; index++) {
        const offset = index * 4;
        if (labels[index] && sizes[labels[index]] < SPECK_PIXELS) {
            data[offset + 3] = 0;
            specks++;
        }
        if (data[offset + 3] >= SOLID_ALPHA) data[offset + 3] = 255;
    }
    dropHaze(bitmap);
    return specks;
}

/**
 * Clears haze and zeroes color under full transparency. Run on the master and again on each
 * resized output, whose resampling (and crop edges) can leave fresh faint fringe.
 * @param {import('@jimp/types').Bitmap} bitmap Bitmap, mutated
 * @returns {void}
 */
function dropHaze({ data, width, height }) {
    const near = nearVisible(data, width, height, HAZE_DISTANCE);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        if (isHaze(data, near, index)) data[offset + 3] = 0;
        if (data[offset + 3] === 0) data.fill(0, offset, offset + 3);
    }
}

/**
 * Bounding box of visible pixels.
 * @param {import('@jimp/types').Bitmap} bitmap Bitmap
 * @returns {{x: number, y: number, w: number, h: number}} Box
 */
function visibleBox({ data, width, height }) {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] <= VISIBLE_ALPHA) continue;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Pixel QA on a decoded output. Returns problems; empty means pass.
 * @param {import('@jimp/types').Bitmap} bitmap Decoded output
 * @param {{edges: boolean}} options Whether the outer ring must be clear
 * @returns {string[]} Problems
 */
function qa(bitmap, { edges }) {
    const { data, width, height } = bitmap;
    const problems = [];
    const near = nearVisible(data, width, height, HAZE_DISTANCE);
    let visible = 0, solid = 0, haze = 0;
    for (let index = 0; index < width * height; index++) {
        const alpha = data[index * 4 + 3];
        if (alpha > VISIBLE_ALPHA) visible++;
        if (alpha === 255) solid++;
        if (isHaze(data, near, index)) haze++;
    }
    if (visible < width * height * 0.15) problems.push(`only ${visible} visible pixels`);
    // A see-through body: the generator's 253 must have been snapped to 255.
    if (solid < visible * 0.85) problems.push(`only ${solid}/${visible} visible pixels are solid: translucent body`);
    if (haze) problems.push(`${haze} faint pixels more than ${HAZE_DISTANCE}px from anything visible: halo`);
    if (edges) {
        let touching = 0;
        for (let x = 0; x < width; x++) {
            if (data[x * 4 + 3] > VISIBLE_ALPHA) touching++;
            if (data[((height - 1) * width + x) * 4 + 3] > VISIBLE_ALPHA) touching++;
        }
        for (let y = 0; y < height; y++) {
            if (data[(y * width) * 4 + 3] > VISIBLE_ALPHA) touching++;
            if (data[(y * width + width - 1) * 4 + 3] > VISIBLE_ALPHA) touching++;
        }
        if (touching) problems.push(`${touching} visible pixels on the outer ring (clipped)`);
        const { sizes } = visibleRegions(data, width, height);
        const largest = Math.max(...sizes);
        if (largest < visible * 0.97) problems.push(`main figure is ${largest}/${visible} visible pixels: detached pieces`);
    }
    return problems;
}

/**
 * Writes a contact sheet of every output over one ground.
 * @param {string} directory Preview directory
 * @param {string} name Ground name
 * @param {number} color RGBA ground
 * @param {Array<{pose: string, full: any, bust: any}>} outputs Decoded outputs
 * @returns {Promise<string>} Written path
 */
async function writePreview(directory, name, color, outputs) {
    const cell = 300;
    const sheet = new Jimp({ width: cell * outputs.length, height: cell * 2 + BUST_SIZE / 2, color });
    outputs.forEach(({ full, bust }, index) => {
        const figure = full.clone().resize({ h: cell * 2 - 20 });
        sheet.composite(figure, index * cell + Math.round((cell - figure.bitmap.width) / 2), 10);
        sheet.composite(bust.clone().resize({ w: BUST_SIZE / 2 }), index * cell + (cell - BUST_SIZE / 2) / 2, cell * 2);
    });
    const file = path.join(directory, `mascot-${name}.png`);
    await sheet.write(/** @type {`${string}.png`} */ (file));
    return file;
}

/**
 * Finds the chibi's two star-shaped pupil highlights: bright pale blobs in the top half of the
 * figure. A five-point star fills ~0.44 of its bounding box, a round catchlight ~0.77, so the
 * eyes are the most similar pair of star-filled blobs at roughly the same height.
 * @param {import('@jimp/types').Bitmap} bitmap Cleaned master
 * @returns {Array<{x: number, y: number}>} Left eye then right eye, master px; empty if not found
 */
function findStarPupils({ data, width, height }) {
    const box = visibleBox({ data, width, height });
    const bright = new Uint8Array(width * height);
    for (let index = 0; index < bright.length; index++) {
        const o = index * 4;
        const y = Math.floor(index / width);
        bright[index] = Number(data[o + 3] === 255 && data[o] > 230 && data[o + 1] > 200 && data[o + 2] > 130 && y < box.y + box.h / 2);
    }
    const labels = new Int32Array(width * height);
    const stack = new Int32Array(width * height);
    const blobs = [];
    for (let start = 0; start < labels.length; start++) {
        if (labels[start] || !bright[start]) continue;
        const label = blobs.length + 1;
        let top = 0, n = 0, sx = 0, sy = 0, x0 = width, x1 = -1, y0 = height, y1 = -1;
        stack[top++] = start;
        labels[start] = label;
        while (top) {
            const index = stack[--top];
            const x = index % width, y = (index - x) / width;
            n++; sx += x; sy += y;
            x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            for (const next of [index - width, index + width, x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1]) {
                if (next < 0 || next >= labels.length || labels[next] || !bright[next]) continue;
                labels[next] = label;
                stack[top++] = next;
            }
        }
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        blobs.push({ x: sx / n, y: sy / n, n, aspect: w / h, fill: n / (w * h) });
    }
    const stars = blobs.filter((b) => b.n >= 200 && b.n <= 5000 && b.aspect > 0.75 && b.aspect < 1.33 && b.fill > 0.3 && b.fill < 0.6);
    let pair = [], best = Infinity;
    for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
            const a = stars[i], b = stars[j];
            if (Math.abs(a.y - b.y) > 120 || Math.abs(a.x - b.x) < 80) continue;
            const cost = Math.abs(Math.log(a.n / b.n)) + Math.abs(a.y - b.y) / 400;
            if (cost < best) { best = cost; pair = [a, b].sort((p, q) => p.x - q.x); }
        }
    }
    return pair.map(({ x, y }) => ({ x, y }));
}

/**
 * Feathered eye-oval weight: 1 inside either oval, fading to 0 across the feather.
 * @param {Array<{x: number, y: number}>} eyes Pupils, master px
 * @param {number} x Master x
 * @param {number} y Master y
 * @returns {number} 0..1
 */
function eyeWeight(eyes, x, y) {
    const edge = CHIBI_EYE_FEATHER / Math.min(CHIBI_EYE_RX, CHIBI_EYE_RY);
    let weight = 0;
    for (const eye of eyes) {
        const d = Math.hypot((x - eye.x) / CHIBI_EYE_RX, (y - eye.y) / CHIBI_EYE_RY);
        weight = Math.max(weight, d <= 1 ? 1 : d >= 1 + edge ? 0 : 1 - (d - 1) / edge);
    }
    return weight;
}

/**
 * How well the blink master sits on the open one: silhouette IoU and mean color drift
 * (0–255 per channel) over solid pixels away from the eyes.
 * @param {import('@jimp/types').Bitmap} open Cleaned open master
 * @param {import('@jimp/types').Bitmap} blink Cleaned blink master
 * @param {Array<{x: number, y: number}>} eyes Pupils, master px
 * @returns {{iou: number, drift: number}} Registration
 */
function blinkRegistration(open, blink, eyes) {
    const o = open.data, b = blink.data, { width, height } = open;
    let both = 0, either = 0, sum = 0, n = 0;
    for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
            const i = (y * width + x) * 4;
            const oa = o[i + 3] > 128, ba = b[i + 3] > 128;
            if (oa && ba) both++;
            if (oa || ba) either++;
            if (o[i + 3] < 200 || b[i + 3] < 200) continue;
            if (eyes.some((eye) => Math.hypot((x - eye.x) / (CHIBI_EYE_RX * 1.6), (y - eye.y) / (CHIBI_EYE_RY * 1.6)) < 1)) continue;
            sum += Math.abs(o[i] - b[i]) + Math.abs(o[i + 1] - b[i + 1]) + Math.abs(o[i + 2] - b[i + 2]);
            n++;
        }
    }
    return { iou: both / either, drift: sum / n / 3 };
}

/**
 * The glint positions loader.css carries (`--k-chibi-eye-{l,r}-{x,y}`, % of the sprite).
 * @returns {Promise<Record<string, number>>} Values by name, e.g. `l-x`
 */
async function readLoaderEyes() {
    const css = await fs.readFile(LOADER_CSS, 'utf8');
    const values = {};
    for (const [, key, value] of css.matchAll(/--k-chibi-eye-([lr]-[xy]):\s*([\d.]+)%/g)) values[key] = Number(value);
    return values;
}

/**
 * Writes `chibi.webp` and `chibi-blink.webp` (eye ovals only, same canvas) and checks them.
 * @returns {Promise<boolean>} True when everything passed
 */
async function prepChibi() {
    const open = await Jimp.read(path.join(MASTERS, 'chibi.png'));
    const blink = await Jimp.read(path.join(MASTERS, 'chibi-blink.png'));
    const specks = clean(open.bitmap);
    clean(blink.bitmap);
    let ok = true;
    const fail = (message) => { console.log(`       ${message}`); ok = false; };

    const eyes = findStarPupils(open.bitmap);
    if (eyes.length !== 2) {
        console.log('FAIL chibi: could not find two star pupils in chibi.png');
        return false;
    }
    if (blink.bitmap.width !== open.bitmap.width || blink.bitmap.height !== open.bitmap.height) {
        console.log('FAIL chibi: chibi-blink.png is not the same size as chibi.png');
        return false;
    }
    const { iou, drift } = blinkRegistration(open.bitmap, blink.bitmap, eyes);
    console.log(`${iou >= CHIBI_MIN_IOU && drift <= CHIBI_MAX_DRIFT ? 'ok  ' : 'FAIL'} chibi blink registration: silhouette ${(iou * 100).toFixed(1)}%, drift ${drift.toFixed(1)}/255 outside the eyes`);
    if (iou < CHIBI_MIN_IOU) fail(`silhouettes overlap ${(iou * 100).toFixed(1)}% < ${CHIBI_MIN_IOU * 100}%: the blink frame moved`);
    if (drift > CHIBI_MAX_DRIFT) fail(`color drift ${drift.toFixed(1)} > ${CHIBI_MAX_DRIFT}: the blink frame was repainted`);

    // Eye ovals from the blink master, never outside the open silhouette.
    const patch = new Jimp({ width: open.bitmap.width, height: open.bitmap.height, color: 0x00000000 });
    const { data: o } = open.bitmap, { data: b } = blink.bitmap, { data: p, width } = patch.bitmap;
    for (let y = 0; y < patch.bitmap.height; y++) {
        for (let x = 0; x < width; x++) {
            const weight = eyeWeight(eyes, x, y);
            if (!weight) continue;
            const i = (y * width + x) * 4;
            p[i] = b[i]; p[i + 1] = b[i + 1]; p[i + 2] = b[i + 2];
            p[i + 3] = Math.round(Math.min(b[i + 3], o[i + 3]) * weight);
        }
    }

    const box = visibleBox(open.bitmap);
    const paddedW = box.w + TRIM_PAD * 2, paddedH = box.h + TRIM_PAD * 2;
    const measured = {};
    eyes.forEach((eye, index) => {
        const side = index ? 'r' : 'l';
        measured[`${side}-x`] = (eye.x - box.x + TRIM_PAD) / paddedW * 100;
        measured[`${side}-y`] = (eye.y - box.y + TRIM_PAD) / paddedH * 100;
    });

    for (const [name, source, edges] of [['chibi', open, true], ['chibi-blink', patch, false]]) {
        const padded = new Jimp({ width: paddedW, height: paddedH, color: 0x00000000 });
        padded.composite(source.clone().crop(box), TRIM_PAD, TRIM_PAD);
        padded.resize({ h: CHIBI_HEIGHT });
        dropHaze(padded.bitmap);
        const file = path.join(OUTPUT, `${name}.webp`);
        await fs.writeFile(file, await padded.getBuffer('image/webp', WEBP));
        const decoded = await Jimp.read(file);
        const size = (await fs.stat(file)).size;
        // The blink patch is two small ovals by design: only the halo check applies to it.
        const problems = edges ? qa(decoded.bitmap, { edges }) : qa(decoded.bitmap, { edges }).filter((problem) => problem.includes('halo'));
        console.log(`${problems.length ? 'FAIL' : 'ok  '} ${path.relative(REPO_ROOT, file)} ${decoded.bitmap.width}×${decoded.bitmap.height} ${(size / 1024).toFixed(0)}KB${edges ? `, ${specks} speck px dropped` : ''}`);
        for (const problem of problems) fail(problem);
    }

    const authored = await readLoaderEyes();
    const fmt = (v) => `${v.toFixed(2)}%`;
    const off = Object.entries(measured).filter(([key, value]) => !(Math.abs((authored[key] ?? NaN) - value) <= CHIBI_EYE_TOLERANCE));
    console.log(`${off.length ? 'FAIL' : 'ok  '} chibi glints in loader.css sit on the measured pupils`);
    if (off.length) {
        fail(`loader.css is off on ${off.map(([key]) => key).join(', ')}; measured: ${Object.entries(measured).map(([key, value]) => `--k-chibi-eye-${key}: ${fmt(value)}`).join('; ')}`);
    }
    return ok;
}

async function main() {
    const previewAt = process.argv.indexOf('--preview');
    const previewDirectory = previewAt > -1 ? path.resolve(process.argv[previewAt + 1] ?? '.') : null;
    await fs.mkdir(OUTPUT, { recursive: true });

    let failed = false;
    const outputs = [];
    for (const [pose, [bx, by, side]] of Object.entries(BUST_BOXES)) {
        const master = await Jimp.read(path.join(MASTERS, `${pose}.png`));
        const specks = clean(master.bitmap);

        const box = visibleBox(master.bitmap);
        const padded = new Jimp({ width: box.w + TRIM_PAD * 2, height: box.h + TRIM_PAD * 2, color: 0x00000000 });
        padded.composite(master.clone().crop(box), TRIM_PAD, TRIM_PAD);
        padded.resize({ h: FULL_HEIGHT });

        const bust = new Jimp({ width: side, height: side, color: 0x00000000 });
        bust.composite(master, -bx, -by);
        bust.resize({ w: BUST_SIZE, h: BUST_SIZE });

        const written = {};
        for (const [suffix, image, edges] of [['', padded, true], ['-bust', bust, false]]) {
            dropHaze(image.bitmap);
            const file = path.join(OUTPUT, `${pose}${suffix}.webp`);
            await fs.writeFile(file, await image.getBuffer('image/webp', WEBP));
            const decoded = await Jimp.read(file);
            const problems = qa(decoded.bitmap, { edges });
            const size = (await fs.stat(file)).size;
            console.log(`${problems.length ? 'FAIL' : 'ok  '} ${path.relative(REPO_ROOT, file)} ${decoded.bitmap.width}×${decoded.bitmap.height} ${(size / 1024).toFixed(0)}KB${suffix ? '' : `, ${specks} speck px dropped`}`);
            for (const problem of problems) console.log(`       ${problem}`);
            failed ||= problems.length > 0;
            written[suffix || 'full'] = decoded;
        }
        outputs.push({ pose, full: written.full, bust: written['-bust'] });
    }
    failed ||= !(await prepChibi());

    if (previewDirectory) {
        await fs.mkdir(previewDirectory, { recursive: true });
        for (const [name, color] of Object.entries(GROUNDS)) {
            console.log(`preview ${await writePreview(previewDirectory, name, color, outputs)}`);
        }
    }
    if (failed) {
        console.error('mascot-prep: pixel QA failed');
        process.exitCode = 1;
    }
}

await main();
