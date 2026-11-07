/**
 * Generation watch (issue #28, layer 1): see ledger.js for the why.
 *
 * - `genWatchMiddleware` is mounted app-wide before the backend routers (server-startup.js).
 *   It does nothing unless the request is a POST carrying `X-Kotatsu-Gen-Id`; then it counts
 *   what the handler writes. The handlers themselves are untouched (provider merge lane).
 * - `router` (at /api/kotatsu/gen-watch) answers `GET /status?ids=a,b`, and (layer 2a)
 *   `GET /replay?id=&from=`: the raw bytes the page missed, so it can finish the reply.
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import { GenLedger, isValidGenId } from './ledger.js';

export { GenLedger };

export const ledger = new GenLedger();
export const GEN_ID_HEADER = 'x-kotatsu-gen-id';

/**
 * Flight recorder for real-device debugging (a phone's console is out of reach). Off unless
 * KOTATSU_GENWATCH_LOG is set; then server events and the page's breadcrumbs (POST /log) go
 * to <dataRoot>/.kotatsu/gen-watch.log. One line per event, no reply text, ever.
 */
const TRACE = Boolean(process.env.KOTATSU_GENWATCH_LOG);
const MAX_TRACE_BYTES = 2 * 1024 * 1024;

/** @param {string} line */
function trace(line) {
    if (!TRACE) return;
    try {
        const dir = path.join(globalThis.DATA_ROOT ?? 'data', '.kotatsu');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'gen-watch.log');
        try {
            if (fs.statSync(file).size > MAX_TRACE_BYTES) fs.renameSync(file, `${file}.1`);
        } catch { /* no file yet */ }
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch { /* tracing must never break a reply */ }
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function ownerOf(req) {
    return req.user?.profile?.handle ?? 'default-user';
}

/** @type {import('express').RequestHandler} */
export function genWatchMiddleware(req, res, next) {
    const id = req.method === 'POST' ? req.get(GEN_ID_HEADER) : undefined;
    if (!isValidGenId(id)) return next();

    // req.user is set app-wide (server-main.js setUserDataMiddleware) before any route mounts.
    const entry = ledger.start(ownerOf(req), id);
    trace(`srv start ${id} ${req.originalUrl}`);

    const write = res.write;
    const end = res.end;
    const writeHead = res.writeHead;
    // The head, for a page whose fetch failed before it arrived (iOS, a long thinking phase).
    // writeHead(status, {headers}) can bypass getHeader(), so read its argument too. Never
    // allowed to throw: this runs inside the handler's own write path.
    const noteHead = (status = res.statusCode, type = undefined) => {
        try {
            ledger.head(entry, Number(status) || res.statusCode, type ?? res.getHeader?.('content-type'));
        } catch { /* tracking must never break a reply */ }
    };
    if (typeof writeHead === 'function') {
        res.writeHead = /** @type {any} */ (function (status, ...rest) {
            try {
                const hdrs = rest.find(a => a && typeof a === 'object' && !Array.isArray(a));
                const type = hdrs ? Object.entries(hdrs).find(([k]) => k.toLowerCase() === 'content-type')?.[1] : undefined;
                noteHead(status, type);
            } catch { /* see noteHead */ }
            return writeHead.apply(this, arguments);
        });
    }
    // eslint-disable-next-line no-unused-vars
    res.write = /** @type {any} */ (function (chunk, encoding, cb) {
        noteHead();
        ledger.wroteChunk(entry, chunk, encoding);
        return write.apply(this, arguments);
    });
    // eslint-disable-next-line no-unused-vars
    res.end = /** @type {any} */ (function (chunk, encoding, cb) {
        noteHead();
        if (typeof chunk !== 'function') ledger.wroteChunk(entry, chunk, encoding);
        // "done" the moment the handler ends, not when the bytes flush: over a half-open
        // socket the flush (and 'finish') may never come, and that's the case we watch for.
        ledger.ended(entry);
        trace(`srv end ${id} bytes=${entry.bytes}`);
        return end.apply(this, arguments);
    });
    res.once('close', () => {
        trace(`srv close ${id} state=${entry.state} bytes=${entry.bytes}`);
        ledger.closed(entry);
    });
    next();
}

export const router = express.Router();

router.get('/status', (req, res) => {
    const raw = String(req.query.ids ?? '');
    const ids = raw.split(',').filter(isValidGenId).slice(0, 16);
    res.set('Cache-Control', 'no-store');
    const out = ledger.status(ownerOf(req), ids);
    trace(`srv status ${JSON.stringify(out)}`);
    res.json(out);
});

router.post('/log', express.json({ limit: '64kb' }), (req, res) => {
    if (TRACE && Array.isArray(req.body?.events)) {
        for (const e of req.body.events.slice(0, 200)) trace(`page ${JSON.stringify(e).slice(0, 600)}`);
    }
    res.sendStatus(204);
});

/**
 * Layer 2a. Body = the backend's own bytes from `from` on (its SSE, untouched), so the page
 * can feed them to the same stream parser. Headers say whether more may come:
 * `X-Kotatsu-Gen-State` running | done | closed, `X-Kotatsu-Gen-Bytes` total written so far,
 * and once the handler has written: `X-Kotatsu-Gen-Status` + `X-Kotatsu-Gen-Type` (the head).
 * 404 = never heard of it (restart, expired); 410 = too big to have kept a copy.
 */
router.get('/replay', (req, res) => {
    const id = req.query.id;
    if (!isValidGenId(id)) return res.sendStatus(400);
    const from = Number(req.query.from ?? 0);
    const got = ledger.read(ownerOf(req), id, Number.isFinite(from) ? from : 0);
    trace(`srv replay ${id} from=${from} -> ${got.state}${'data' in got ? ` +${got.data.length}/${got.bytes}` : ''}`);
    res.set('Cache-Control', 'no-store');
    if (got.state === 'unknown') return res.sendStatus(404);
    if (got.state === 'truncated') return res.sendStatus(410);
    res.set('X-Kotatsu-Gen-State', got.state);
    res.set('X-Kotatsu-Gen-Bytes', String(got.bytes));
    if (got.status !== null) res.set('X-Kotatsu-Gen-Status', String(got.status));
    if (got.type) res.set('X-Kotatsu-Gen-Type', got.type);
    res.type('application/octet-stream').send(got.data);
});
