// Sprites (Kotatsu): the pixel routes behind Card Studio's Touch-up. Mounted at /api/kotatsu/sprites.
//
// A character's sprite folder is stock's (`characters/<folder>/<label>.png`, `folder/subfolder` allowed), resolved
// here exactly the way stock's `getSpritesPath` does. Each sprite may have a raw drawing beside it
// (`.kotatsu/raw/<file>`, see pixel-io.js). Pixels cross the wire as exact RGBA bytes: the browser never decodes a
// sprite through a canvas (premultiplied alpha loses the colour under alpha 0 that the cut keeps on purpose).
//
//   GET  /set?name=<folder>                    → { files: [{ file, label, width, height, hasRaw, touched }], skipped: [file] }
//   GET  /pixels?name&file&which=raw|cut       → RGBA bytes, X-Width / X-Height (raw: 404 when absent)
//   POST /save?name&file   (RGBA body)          → overwrite the sprite; the first time, the original is kept once in
//                                                 `<folder>/.kotatsu/touchup-original/<file>` and never replaced

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { decodeImage, rawPathFor, writePng } from './pixel-io.js';

export const router = express.Router();

export const ORIGINAL_DIR = path.join('.kotatsu', 'touchup-original');
const MAX_BODY = '256mb';

/**
 * The sprite folder for a name, stock's rule (src/endpoints/sprites.js `getSpritesPath`).
 * @param {import('../../../users.js').UserDirectoryList} directories
 * @param {unknown} name `folder` or `folder/subfolder`
 * @returns {string | null} null when the name is invalid
 */
export function spritesPathFor(directories, name) {
    const text = String(name ?? '');
    if (!text) return null;
    if (text.includes('/')) {
        const parts = text.split('/');
        const folder = sanitize(parts[0]);
        const sub = sanitize(parts[1]);
        if (!folder || !sub || parts.length > 2) return null;
        return path.join(directories.characters, folder, sub);
    }
    const folder = sanitize(text);
    return folder ? path.join(directories.characters, folder) : null;
}

/**
 * A plain PNG file name that exists at the top of the folder.
 * @param {string} dir @param {unknown} file
 * @returns {string | null} the absolute path
 */
function spriteFile(dir, file) {
    if (typeof file !== 'string' || !file || file !== path.basename(file) || file !== sanitize(file)) return null;
    if (!/\.png$/i.test(file)) return null;
    const full = path.join(dir, file);
    return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

/** @param {express.Response} response @param {number} status @param {string} error */
const refuse = (response, status, error) => response.status(status).json({ error });

router.get('/set', async (request, response) => {
    try {
        const dir = spritesPathFor(request.user.directories, request.query.name);
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return refuse(response, 404, 'no such sprite folder');
        const files = [];
        const skipped = [];
        for (const entry of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, entry);
            if (!fs.statSync(full).isFile() || !/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(entry)) continue;
            if (!/\.png$/i.test(entry)) { skipped.push(entry); continue; }
            try {
                const { width, height } = await decodeImage(full);
                files.push({ file: entry, label: entry.replace(/\.[^.]+$/, ''), width, height, hasRaw: fs.existsSync(rawPathFor(full)), touched: fs.existsSync(path.join(dir, ORIGINAL_DIR, entry)) });
            } catch {
                skipped.push(entry);
            }
        }
        return response.json({ files, skipped });
    } catch (error) {
        console.error(error);
        return refuse(response, 500, 'could not read the folder');
    }
});

router.get('/pixels', async (request, response) => {
    try {
        const dir = spritesPathFor(request.user.directories, request.query.name);
        const full = dir && spriteFile(dir, request.query.file);
        if (!dir || !full) return refuse(response, 404, 'no such sprite');
        const which = request.query.which === 'raw' ? 'raw' : request.query.which === 'cut' ? 'cut' : '';
        if (!which) return refuse(response, 400, 'which must be raw or cut');
        const source = which === 'raw' ? rawPathFor(full) : full;
        if (!fs.existsSync(source)) return refuse(response, 404, 'no raw drawing for this sprite');
        const img = await decodeImage(source);
        response.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Width': String(img.width), 'X-Height': String(img.height) });
        return response.send(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length));
    } catch (error) {
        console.error(error);
        return refuse(response, 500, 'could not read the sprite');
    }
});

router.post('/save', express.raw({ type: () => true, limit: MAX_BODY }), async (request, response) => {
    try {
        const dir = spritesPathFor(request.user.directories, request.query.name);
        const full = dir && spriteFile(dir, request.query.file);
        if (!dir || !full) return refuse(response, 404, 'no such sprite');
        const body = request.body;
        if (!Buffer.isBuffer(body) || !body.length) return refuse(response, 400, 'expected raw RGBA bytes');
        const stored = await decodeImage(full);
        if (body.length !== stored.width * stored.height * 4) return refuse(response, 400, `size mismatch: expected ${stored.width}x${stored.height} RGBA`);
        const original = path.join(dir, ORIGINAL_DIR, path.basename(full));
        let kept = false;
        if (!fs.existsSync(original)) {
            fs.mkdirSync(path.dirname(original), { recursive: true });
            fs.copyFileSync(full, original);
            kept = true;
        }
        await writePng(full, { width: stored.width, height: stored.height, data: new Uint8ClampedArray(body) }); // a copy: the wasm encoder reads the whole ArrayBuffer, and a request body is a view into a pooled one
        return response.json({ saved: path.basename(full), originalKept: kept });
    } catch (error) {
        console.error(error);
        return refuse(response, 500, 'could not save the sprite');
    }
});
