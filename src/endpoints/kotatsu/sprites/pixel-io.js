// Exact pixels between disk and the pure pixel core (public/kotatsu/sprites/pixels/). PNGs are decoded and encoded
// here with Jimp, never in a browser canvas: a canvas premultiplies alpha, which rounds every soft edge pixel and
// loses the colour under alpha 0 that the cut keeps on purpose (Touch-up reads it).
//
// Where the raw drawings live: a sprite's raw (the drawing on its flat background, before the cut) sits beside it in
// a Kotatsu dotfolder, `<sprite dir>/.kotatsu/raw/<same file name>`. Stock's sprite listing reads image files at the
// top level only and static serving ignores dotfiles, so stock never sees them.

import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { Jimp } from '../../../jimp.js';

/** @typedef {import('../../../../public/kotatsu/sprites/pixels/image.js').Img} Img */

export const RAW_DIR = path.join('.kotatsu', 'raw');

/**
 * The raw drawing's path for a sprite file.
 * @param {string} spriteFile absolute path of `<sprite dir>/<file>.png`
 */
export function rawPathFor(spriteFile) {
    return path.join(path.dirname(spriteFile), RAW_DIR, path.basename(spriteFile));
}

/**
 * Decode an image (file path or bytes) to RGBA.
 * @param {string | Buffer} source
 * @returns {Promise<Img>}
 */
export async function decodeImage(source) {
    const img = await Jimp.read(source);
    const { width, height, data } = img.bitmap;
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
}

/**
 * Encode RGBA as PNG, colour under alpha 0 kept.
 * @param {Img} img
 * @returns {Promise<Buffer>}
 */
export async function encodePng(img) {
    // Jimp's wasm encoder reads the whole ArrayBuffer behind the view: a view into a bigger buffer (an Express request
    // body, or any small Buffer, which Node carves out of its shared 8 KB pool) is copied into an ArrayBuffer of its own.
    const whole = img.data.byteOffset === 0 && img.data.buffer.byteLength === img.data.length;
    const data = Buffer.from(whole ? img.data.buffer : new Uint8Array(img.data).buffer, 0, img.data.length);
    return Jimp.fromBitmap({ width: img.width, height: img.height, data }).getBuffer('image/png');
}

/**
 * Write an image as PNG, atomically, creating the folder.
 * @param {string} file @param {Img} img
 */
export async function writePng(file, img) {
    const bytes = await encodePng(img);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, bytes);
}
