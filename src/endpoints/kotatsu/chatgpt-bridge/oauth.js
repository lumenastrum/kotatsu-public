import crypto from 'node:crypto';

import { createRemoteJWKSet, jwtVerify } from 'jose';

import { OPENAI } from './config.js';

/**
 * Sign in with ChatGPT, open-source/local flow (docs/chatgpt-bridge-protocol.md §1–§4): PKCE,
 * implicit registration through `dynamic_agent_client`, a loopback callback on
 * `http://127.0.0.1:{port}/auth/callback`, code exchange, refresh, ID-token verification and
 * revocation. Network calls take an injectable `fetch` so tests never reach OpenAI.
 */

const ATTEMPT_TTL_MS = 10 * 60_000;

/** @param {Buffer} bytes @returns {string} */
const base64url = (bytes) => bytes.toString('base64url');

/**
 * A PKCE pair (RFC 7636, S256). Pure apart from randomness.
 * @param {Buffer} [entropy] 32 random bytes (tests inject them)
 * @returns {{verifier: string, challenge: string}}
 */
export function pkcePair(entropy = crypto.randomBytes(32)) {
    const verifier = base64url(entropy);
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

/**
 * @param {number} port The bridge's listener port
 * @returns {string} The exact redirect URI OpenAI requires (host 127.0.0.1, path /auth/callback)
 */
export function redirectUriFor(port) {
    return `http://127.0.0.1:${port}/auth/callback`;
}

/**
 * Builds the authorize URL. First sign-in registers through `dynamic_agent_client`; later ones use
 * the issued `oaiapp_…` id with the previous ID token as a hint. Pure.
 * @param {object} p
 * @param {string} p.hostId Install-scoped `ext_agent_host_id`
 * @param {number} p.port Listener port
 * @param {string} p.state
 * @param {string} p.nonce
 * @param {string} p.challenge PKCE challenge
 * @param {string|null} [p.clientId] Issued client id, if this install already registered
 * @param {string|null} [p.idTokenHint] Previous ID token (reauth only)
 * @returns {string}
 */
export function buildAuthorizeUrl({ hostId, port, state, nonce, challenge, clientId = null, idTokenHint = null }) {
    const url = new URL(OPENAI.authorize);
    const params = {
        client_id: clientId || OPENAI.registrationClientId,
        ...(clientId ? {} : { agent_name_hint: OPENAI.agentName }),
        ext_agent_host_id: hostId,
        ...(clientId && idTokenHint ? { id_token_hint: idTokenHint } : {}),
        response_type: 'code',
        redirect_uri: redirectUriFor(port),
        scope: OPENAI.scope,
        resource: OPENAI.resource,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
}

/**
 * One sign-in attempt at a time: state, nonce, PKCE verifier and expiry, kept in memory only.
 */
export class AttemptStore {
    /** @type {null|{state: string, nonce: string, verifier: string, clientId: string|null, port: number, expiresAt: number}} */
    #attempt = null;

    /**
     * @param {{clientId: string|null, port: number}} p
     * @param {number} [now]
     * @returns {{state: string, nonce: string, challenge: string}}
     */
    begin({ clientId, port }, now = Date.now()) {
        const { verifier, challenge } = pkcePair();
        const state = base64url(crypto.randomBytes(24));
        const nonce = base64url(crypto.randomBytes(24));
        this.#attempt = { state, nonce, verifier, clientId, port, expiresAt: now + ATTEMPT_TTL_MS };
        return { state, nonce, challenge };
    }

    /**
     * Takes the pending attempt if `state` matches and it hasn't expired. One use.
     * @param {unknown} state
     * @param {number} [now]
     * @returns {null|{state: string, nonce: string, verifier: string, clientId: string|null, port: number}}
     */
    take(state, now = Date.now()) {
        const attempt = this.#attempt;
        if (!attempt || typeof state !== 'string' || state.length !== attempt.state.length) return null;
        if (!crypto.timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) return null;
        this.#attempt = null;
        if (attempt.expiresAt <= now) return null;
        return attempt;
    }

    get pending() {
        return Boolean(this.#attempt && this.#attempt.expiresAt > Date.now());
    }
}

/**
 * Reads the callback query into an outcome. Pure.
 * @param {URLSearchParams} query
 * @returns {{kind: 'code', code: string, state: string, clientId: string|null, scope: string}|{kind: 'error', error: string, state: string|null}|{kind: 'malformed'}}
 */
export function readCallback(query) {
    const state = query.get('state');
    const error = query.get('error');
    if (error) return { kind: 'error', error, state };
    const code = query.get('code');
    if (!code || !state) return { kind: 'malformed' };
    return { kind: 'code', code, state, clientId: query.get('client_id'), scope: query.get('scope') ?? '' };
}

/**
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readJson(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { detail: text.slice(0, 300) };
    }
}

/**
 * An OAuth error the caller can act on (`code` is OpenAI's `error` value).
 */
export class OAuthError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {number} [status]
     */
    constructor(code, message, status) {
        super(message);
        this.name = 'OAuthError';
        this.code = code;
        this.status = status;
    }
}

/** Refresh/exchange errors that mean "run sign-in again" (protocol §4). */
export const REAUTH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

/**
 * POSTs a form to the token endpoint.
 * @param {Record<string, string>} form
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{access_token: string, refresh_token?: string, id_token?: string, expires_in: number, scope?: string}>}
 */
async function tokenRequest(form, fetchImpl) {
    const response = await fetchImpl(OPENAI.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
    });
    const body = await readJson(response);
    if (!response.ok || !body.access_token) {
        const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
        throw new OAuthError(code, body.error_description || body.detail || `Token request failed (${response.status})`, response.status);
    }
    return body;
}

/**
 * Exchanges an authorization code (standard `authorization_code` grant, no client secret).
 * @param {{clientId: string, code: string, verifier: string, port: number}} p
 * @param {typeof fetch} [fetchImpl]
 */
export function exchangeCode({ clientId, code, verifier, port }, fetchImpl = fetch) {
    return tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUriFor(port),
        resource: OPENAI.resource,
    }, fetchImpl);
}

/**
 * Refreshes with the rotating refresh token (the returned one replaces it).
 * @param {{clientId: string, refreshToken: string}} p
 * @param {typeof fetch} [fetchImpl]
 */
export function refreshTokens({ clientId, refreshToken }, fetchImpl = fetch) {
    return tokenRequest({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource: OPENAI.resource,
    }, fetchImpl);
}

let jwks = null;

/**
 * Verifies an ID token against OpenAI's published keys: issuer, audience (the issued client id),
 * expiry, nonce, 5 s tolerance.
 * @param {string} idToken
 * @param {{clientId: string, nonce?: string}} p
 * @param {Parameters<typeof jwtVerify>[1]} [keySet] Injected key set (tests)
 * @returns {Promise<{sub: string, email?: string, name?: string}>}
 */
export async function verifyIdToken(idToken, { clientId, nonce }, keySet) {
    jwks ??= createRemoteJWKSet(new URL(OPENAI.jwks));
    const { payload } = await jwtVerify(idToken, keySet ?? jwks, { issuer: OPENAI.issuer, audience: clientId, clockTolerance: 5 });
    if (nonce !== undefined && payload.nonce !== nonce) throw new OAuthError('invalid_nonce', 'The sign-in response did not match this attempt.');
    if (typeof payload.sub !== 'string' || !payload.sub) throw new OAuthError('invalid_id_token', 'The sign-in response had no account id.');
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined, name: typeof payload.name === 'string' ? payload.name : undefined };
}

/**
 * Revokes a refresh token through the discovery document's revocation endpoint. Best effort:
 * returns false when OpenAI doesn't publish one or the call fails.
 * @param {{clientId: string, refreshToken: string}} p
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<boolean>}
 */
export async function revokeRefreshToken({ clientId, refreshToken }, fetchImpl = fetch) {
    try {
        const discovery = await readJson(await fetchImpl(OPENAI.discovery, { headers: { Accept: 'application/json' } }));
        if (typeof discovery.revocation_endpoint !== 'string') return false;
        const response = await fetchImpl(discovery.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * @param {string} scope Space-separated granted scopes
 * @returns {boolean} Whether ChatGPT plan usage was granted
 */
export function grantsPlanUsage(scope) {
    return String(scope ?? '').split(/\s+/).includes(OPENAI.planScope);
}
