import _ from 'lodash';
import express from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';

import { getIpFromRequest } from '../../../express-common.js';
import { registerWhitelistAllow } from '../../../middleware/whitelist.js';
import { getConfig, getConfigValue, toBoolean } from '../../../util.js';
import { writeConfigValues } from '../config-yaml.js';
import { isLoopbackRequest, listenLock } from './access.js';
import { describeAddresses } from './network.js';
import { PairedStore } from './paired.js';
import { PairingTokens } from './tokens.js';

/**
 * Phone v0 (docs/phone-v0.md §3): the LAN switch, QR pairing, and the paired-device list.
 *
 * Two routers. `pairRouter` is mounted BEFORE the IP whitelist in server-main.js — a phone that
 * hasn't paired yet must reach `/k-pair` — and does nothing but spend a code. `router` is mounted
 * at `/api/kotatsu/phone` behind the whitelist, session and CSRF like every other Kotatsu route;
 * everything that changes access is loopback-only.
 */

export const PAIR_PATH = '/k-pair';

// Read once at import, which happens during boot — the same moment the middlewares read them.
// A later config.yaml write changes the configured value, never these.
const BOOT_HOST_WHITELIST = toBoolean(getConfigValue('hostWhitelist.enabled', false));

/** @type {PairedStore|null} */
let store = null;
const tokens = new PairingTokens();
/** @type {{ id: string, label: string, at: string } | null} */
let lastPaired = null;

/**
 * Opens the store for this data root and registers paired IPs with the whitelist. Called once from
 * server-main.js before the whitelist is mounted.
 * @param {string} dataRoot
 * @returns {void}
 */
export function installPhone(dataRoot) {
    if (store) return;
    store = new PairedStore(dataRoot);
    registerWhitelistAllow((ip) => {
        if (!store?.has(ip)) return false;
        store.touch(ip);
        return true;
    });
}

/**
 * @returns {PairedStore}
 */
function getStore() {
    if (!store) installPhone(globalThis.DATA_ROOT);
    return /** @type {PairedStore} */ (store);
}

/**
 * @param {import('express').Request} request
 * @returns {Promise<object>}
 */
async function buildStatus(request) {
    const args = globalThis.COMMAND_LINE_ARGS;
    const effective = Boolean(args?.listen);
    const configured = toBoolean(_.get(getConfig(), 'listen', false));
    const lockedBy = listenLock(process.argv, process.env);
    const ip = getIpFromRequest(request);
    const paired = getStore().list();
    const viewer = isLoopbackRequest(request) ? 'computer' : paired.some(device => device.ip === ip) ? 'paired' : 'other';
    return {
        viewer,
        viewerIp: viewer === 'computer' ? null : ip,
        listen: { effective, configured, lockedBy, pendingRestart: !lockedBy && configured !== effective },
        hostWhitelist: { effective: BOOT_HOST_WHITELIST, configured: toBoolean(_.get(getConfig(), 'hostWhitelist.enabled', false)) },
        supervised: process.env.KOTATSU_SUPERVISED === '1',
        scheme: args?.ssl ? 'https' : 'http',
        port: Number(args?.port) || null,
        pairPath: PAIR_PATH,
        addresses: await describeAddresses(),
        paired,
        pairing: { live: tokens.liveCount(), lastPaired },
    };
}

export const router = express.Router();

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @returns {boolean} Whether the request was refused
 */
function refuseUnlessComputer(request, response) {
    if (isLoopbackRequest(request)) return false;
    response.status(403).json({ error: 'computer-only', message: 'Manage phone access on the computer Kotatsu runs on.' });
    return true;
}

router.get('/status', async (request, response) => {
    try {
        response.json(await buildStatus(request));
    } catch (error) {
        console.error('Kotatsu phone: status failed', error);
        response.status(500).json({ error: 'status', message: String(error instanceof Error ? error.message : error) });
    }
});

router.post('/lan', async (request, response) => {
    if (refuseUnlessComputer(request, response)) return;
    const enabled = request.body?.enabled;
    if (typeof enabled !== 'boolean') return response.status(400).json({ error: 'bad-request', message: 'enabled must be true or false' });
    const lockedBy = listenLock(process.argv, process.env);
    if (lockedBy) {
        return response.status(409).json({ error: 'locked', lockedBy, message: lockedBy === 'cli' ? 'Set by a launch flag' : 'Set by an environment variable' });
    }
    try {
        /** @type {import('../config-yaml.js').PathValue[]} */
        const entries = [[['listen'], enabled]];
        // Host checks block DNS-rebinding pages; raw IPs and localhost always pass, so a phone
        // using the QR's address is never affected. Left on when the switch goes off.
        if (enabled) entries.push([['hostWhitelist', 'enabled'], true]);
        writeConfigValues(entries);
        response.json(await buildStatus(request));
    } catch (error) {
        console.error('Kotatsu phone: writing config.yaml failed', error);
        response.status(500).json({ error: 'write', message: String(error instanceof Error ? error.message : error) });
    }
});

router.post('/pair', (request, response) => {
    if (refuseUnlessComputer(request, response)) return;
    if (!globalThis.COMMAND_LINE_ARGS?.listen) {
        return response.status(409).json({ error: 'not-listening', message: 'Kotatsu isn’t listening on the network yet.' });
    }
    const { token, expiresAt } = tokens.mint();
    response.json({ token, expiresAt, path: `${PAIR_PATH}?t=${token}` });
});

router.post('/forget', (request, response) => {
    if (refuseUnlessComputer(request, response)) return;
    const id = request.body?.id;
    if (typeof id !== 'string') return response.status(400).json({ error: 'bad-request', message: 'id is required' });
    const removed = getStore().forget(id);
    if (lastPaired?.id === id) lastPaired = null;
    response.json({ ok: true, removed, paired: getStore().list() });
});

/**
 * A small self-contained page for a phone whose code didn't work. No scripts, no external assets.
 * @param {string} headline
 * @param {string} body
 * @returns {string}
 */
function pairPage(headline, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kotatsu</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#141a26;color:#e6e9f2}
main{max-width:22rem;padding:2rem 1.5rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#b7bed0}
@media (prefers-color-scheme: light){body{background:#f7f3ea;color:#2a2622}p{color:#5a534b}}
</style></head><body><main><h1>${headline}</h1><p>${body}</p></main></body></html>`;
}

const redeemLimiter = new RateLimiterMemory({ points: 10, duration: 60 });

export const pairRouter = express.Router();

pairRouter.get(PAIR_PATH, async (request, response) => {
    const ip = getIpFromRequest(request);
    // The computer is always allowed; spending a code on it would only waste the code.
    if (isLoopbackRequest(request)) return response.redirect(302, '/');
    try {
        await redeemLimiter.consume(ip);
    } catch {
        return response.status(429).type('html').send(pairPage('Too many tries', 'Wait a minute, then scan the code on your computer again.'));
    }
    const outcome = tokens.redeem(request.query.t);
    if (outcome === 'malformed') {
        return response.status(400).type('html').send(pairPage('That link isn’t a pairing code', 'Open Settings → System → Phone on your computer and scan the code there.'));
    }
    if (outcome === 'expired') {
        return response.status(410).type('html').send(pairPage('This code has expired', 'Show a new one on your computer and scan it again. Each code works once.'));
    }
    const device = getStore().add(ip, request.headers['user-agent']);
    lastPaired = { id: device.id, label: device.label, at: device.pairedAt };
    console.info(`Kotatsu phone: paired ${device.label} from ${ip}`);
    response.set('Cache-Control', 'no-store').redirect(302, '/');
});
