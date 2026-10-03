import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { color } from '../../../util.js';
import { createOpenAIBridge } from '../claude-bridge/http.js';
import { ensureBridgeToken } from '../claude-bridge/secret.js';
import { isLoopbackRequest } from '../phone/access.js';
import { OPENAI, readChatGPTBridgeConfig, validateChatGPTBridgeConfig } from './config.js';
import { CredentialStore } from './credentials.js';
import { AttemptStore, OAuthError, buildAuthorizeUrl, exchangeCode, grantsPlanUsage, readCallback, revokeRefreshToken, verifyIdToken } from './oauth.js';
import { ModelCatalog, createChatGPTRunner } from './runtime.js';
import { TokenManager } from './tokens.js';

/**
 * The ChatGPT bridge (docs/chatgpt-bridge-v0.md): an OpenAI-compatible listener on 127.0.0.1 that
 * answers through the user's own ChatGPT plan, signed in with OpenAI's open-source/local flow.
 */

const LOG_PREFIX = '[ChatGPT bridge]';
export const CHATGPT_SECRET_ID = 'kotatsu-chatgpt';
const CHATGPT_SECRET_LABEL = 'Kotatsu ChatGPT bridge';

const state = {
    enabled: false,
    listening: false,
    port: 5108,
    error: null,
    /** @type {CredentialStore|null} */
    store: null,
    /** @type {TokenManager|null} */
    tokens: null,
    /** @type {ModelCatalog|null} */
    catalog: null,
    attempts: new AttemptStore(),
    bridge: null,
};

/**
 * A small self-contained page for the browser tab the sign-in ends in. No scripts, no assets.
 * @param {string} headline
 * @param {string} body
 * @returns {string}
 */
function callbackPage(headline, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kotatsu</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#141a26;color:#e6e9f2}
main{max-width:24rem;padding:2rem 1.5rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#b7bed0}
@media (prefers-color-scheme: light){body{background:#f7f3ea;color:#2a2622}p{color:#5a534b}}
</style></head><body><main><h1>${headline}</h1><p>${body}</p></main></body></html>`;
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string} headline
 * @param {string} body
 */
function sendPage(response, status, headline, body) {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(callbackPage(headline, body));
}

/**
 * OpenAI redirects here after sign-in (protocol §3): validate, exchange, verify, check the plan
 * scope, save. Runs before the listener's bearer check.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {Promise<boolean>}
 */
async function handleCallback(request, response, url) {
    if (request.method !== 'GET' || url.pathname !== '/auth/callback') return false;
    const outcome = readCallback(url.searchParams);
    // What came back, never a code or token: the outcome kind and OpenAI's own error words.
    const description = (url.searchParams.get('error_description') ?? '').slice(0, 300);
    console.info(`${LOG_PREFIX} Sign-in callback: ${outcome.kind}${outcome.kind === 'error' ? ` (${outcome.error}${description ? `: ${description}` : ''})` : ''}`);
    if (outcome.kind === 'malformed') {
        sendPage(response, 400, 'That link isn’t a sign-in response', 'Start again from Kotatsu’s Connection settings.');
        return true;
    }
    const attempt = state.attempts.take(outcome.state);
    if (!attempt) {
        console.info(`${LOG_PREFIX} Sign-in callback had no matching attempt (used already, or older than ten minutes).`);
        sendPage(response, 400, 'This sign-in link was already used', 'Start again from Kotatsu’s Connection settings. Each sign-in link works once, for ten minutes.');
        return true;
    }
    if (outcome.kind === 'error') {
        const escape = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
        const reason = outcome.error === 'access_denied'
            ? 'Nothing was connected. You can close this tab.'
            : `ChatGPT answered: ${escape(outcome.error)}${description ? ` — ${escape(description)}` : ''}. Nothing was connected.`;
        sendPage(response, 200, outcome.error === 'access_denied' ? 'Sign-in cancelled' : 'Sign-in didn’t go through', reason);
        return true;
    }
    const clientId = attempt.clientId || outcome.clientId;
    if (!clientId || clientId === OPENAI.registrationClientId) {
        sendPage(response, 502, 'ChatGPT didn’t finish registering Kotatsu', 'Try signing in again from Kotatsu.');
        return true;
    }
    try {
        const tokens = await exchangeCode({ clientId, code: outcome.code, verifier: attempt.verifier, port: attempt.port });
        const identity = await verifyIdToken(String(tokens.id_token ?? ''), { clientId, nonce: attempt.nonce });
        const scope = String(tokens.scope ?? outcome.scope ?? '');
        /** @type {CredentialStore} */ (state.store).setAccount({
            label: identity.email || identity.name || 'ChatGPT account',
            sub: identity.sub,
            clientId,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            idToken: tokens.id_token ?? null,
            expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
            scope,
            signedOut: false,
        });
        state.catalog?.clear();
        if (!grantsPlanUsage(scope) || !tokens.refresh_token) {
            sendPage(response, 200, 'Signed in, but without your ChatGPT plan', 'Kotatsu needs permission to use your plan. Start again from Kotatsu and allow ChatGPT plan usage.');
            return true;
        }
        console.info(color.green(`${LOG_PREFIX} Signed in.`));
        sendPage(response, 200, 'Connected to ChatGPT', 'You can close this tab and go back to Kotatsu.');
    } catch (error) {
        const message = error instanceof OAuthError ? error.message : 'Something went wrong finishing the sign-in.';
        console.warn(`${LOG_PREFIX} Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
        sendPage(response, 502, 'Sign-in didn’t finish', `${message} Try again from Kotatsu.`);
    }
    return true;
}

/**
 * @returns {object} What the Connection tab needs; never a token.
 */
export function getChatGPTBridgeStatus() {
    const account = state.store?.account ?? null;
    const signedIn = Boolean(account && !account.signedOut && account.refreshToken);
    return {
        enabled: state.enabled,
        listening: state.listening,
        port: state.port,
        url: `http://127.0.0.1:${state.port}/v1`,
        error: state.error,
        signedIn,
        account: account ? { label: account.label } : null,
        planGranted: Boolean(account && grantsPlanUsage(account.scope)),
        loginPending: state.attempts.pending,
        secretId: CHATGPT_SECRET_ID,
        manageUsage: OPENAI.manageUsage,
        supervised: process.env.KOTATSU_SUPERVISED === '1',
    };
}

/**
 * Starts the listener (server boot). Never fatal: a busy port or bad config is reported, Kotatsu runs on.
 * @param {{directories: import('../../../users.js').UserDirectoryList[]}} params
 * @returns {Promise<void>}
 */
export async function startChatGPTBridge({ directories }) {
    try {
        const config = validateChatGPTBridgeConfig(readChatGPTBridgeConfig());
        state.enabled = config.enabled;
        state.port = config.port;
        if (!config.enabled) {
            console.info(color.blue(`${LOG_PREFIX} Disabled (kotatsu.chatgptBridge.enabled: false); no listener started.`));
            return;
        }
        const { token } = ensureBridgeToken(directories, console, { id: CHATGPT_SECRET_ID, label: CHATGPT_SECRET_LABEL, name: 'ChatGPT' });
        state.store = new CredentialStore(globalThis.DATA_ROOT);
        state.store.ensureHostId();
        state.tokens = new TokenManager(state.store);
        state.catalog = new ModelCatalog(state.tokens);
        const catalog = state.catalog;
        const traceFile = path.join(globalThis.DATA_ROOT, '.kotatsu', 'chatgpt-trace.jsonl');
        const onTrace = config.trace ? (/** @type {object} */ entry) => fs.appendFileSync(traceFile, `${JSON.stringify(entry)}
`, 'utf8') : undefined;
        if (onTrace) console.info(`${LOG_PREFIX} Trace on: ${traceFile} (fingerprints and usage only, never prompt text)`);
        state.bridge = createOpenAIBridge({
            config: { ...config, apiToken: token, models: [] },
            runner: createChatGPTRunner({ tokens: state.tokens, catalog, onTrace }),
            service: 'kotatsu-chatgpt-bridge',
            label: 'ChatGPT',
            ownedBy: 'chatgpt-plan',
            listModels: async () => (await catalog.list()).map(model => model.slug),
            health: () => ({ signedIn: getChatGPTBridgeStatus().signedIn }),
            preAuth: handleCallback,
        });
        await state.bridge.listen();
        state.listening = true;
        state.error = null;
        const account = state.store.account;
        console.info(color.green(`${LOG_PREFIX} Listening on http://${config.host}:${config.port}/v1`), account && !account.signedOut ? '(signed in)' : '(not signed in yet)');
    } catch (error) {
        state.listening = false;
        state.error = error instanceof Error ? error.message : String(error);
        console.warn(color.yellow(`${LOG_PREFIX} Not started: ${state.error}`));
    }
}

/** Stops the listener (graceful-exit hook). */
export async function stopChatGPTBridge() {
    if (!state.bridge) return;
    try {
        await state.bridge.close();
    } finally {
        state.listening = false;
        state.bridge = null;
    }
}

export const router = express.Router();

router.get('/status', (_request, response) => {
    response.json(getChatGPTBridgeStatus());
});

router.get('/models', async (_request, response) => {
    if (!state.catalog) return response.status(409).json({ error: 'not-running' });
    try {
        response.json({ models: await state.catalog.list() });
    } catch (error) {
        response.status(/** @type {any} */ (error)?.status ?? 502).json({ error: 'models', message: error instanceof Error ? error.message : String(error) });
    }
});

router.post('/login', (request, response) => {
    if (!isLoopbackRequest(request)) {
        return response.status(403).json({ error: 'computer-only', message: 'Sign in with ChatGPT on the computer Kotatsu runs on.' });
    }
    if (!state.listening || !state.store) return response.status(409).json({ error: 'not-running', message: state.error ?? 'The ChatGPT bridge isn’t running.' });
    const account = state.store.account;
    const clientId = account?.clientId ?? null;
    const { state: oauthState, nonce, challenge } = state.attempts.begin({ clientId, port: state.port });
    const url = buildAuthorizeUrl({ hostId: state.store.hostId, port: state.port, state: oauthState, nonce, challenge, clientId, idTokenHint: clientId ? account?.idToken ?? null : null });
    response.json({ url });
});

router.post('/logout', async (request, response) => {
    if (!isLoopbackRequest(request)) {
        return response.status(403).json({ error: 'computer-only', message: 'Disconnect ChatGPT on the computer Kotatsu runs on.' });
    }
    const account = state.store?.account;
    let revoked = false;
    if (account?.refreshToken) revoked = await revokeRefreshToken({ clientId: account.clientId, refreshToken: account.refreshToken });
    state.store?.signOut();
    state.catalog?.clear();
    response.json({ ok: true, revoked, status: getChatGPTBridgeStatus() });
});
