import { OAuthError, REAUTH_ERRORS, refreshTokens } from './oauth.js';

/**
 * Fresh access tokens on demand (docs/chatgpt-bridge-v0.md §1). Refreshes a little before expiry,
 * and only ever one refresh at a time: the refresh token rotates, so a second concurrent refresh
 * would present a token the first one just retired (`refresh_token_reused`).
 */

const REFRESH_EARLY_MS = 2 * 60_000;

/** Thrown when the user has to sign in again. */
export class SignInRequired extends Error {
    constructor(message = 'Sign in with ChatGPT again to keep using your plan.') {
        super(message);
        this.name = 'SignInRequired';
    }
}

export class TokenManager {
    /** @type {import('./credentials.js').CredentialStore} */
    #store;
    /** @type {typeof fetch} */
    #fetch;
    /** @type {Promise<string>|null} */
    #inFlight = null;

    /**
     * @param {import('./credentials.js').CredentialStore} store
     * @param {{fetchImpl?: typeof fetch}} [options]
     */
    constructor(store, { fetchImpl = fetch } = {}) {
        this.#store = store;
        this.#fetch = fetchImpl;
    }

    /**
     * A usable access token, refreshing first if it's within two minutes of expiry.
     * @param {{force?: boolean, now?: number}} [options] `force` refreshes even if not due (after a 401)
     * @returns {Promise<string>}
     */
    async accessToken({ force = false, now = Date.now() } = {}) {
        const account = this.#store.account;
        if (!account || account.signedOut || !account.refreshToken) throw new SignInRequired('Sign in with ChatGPT to use your plan.');
        if (!force && account.accessToken && account.expiresAt - REFRESH_EARLY_MS > now) return account.accessToken;
        this.#inFlight ??= this.#refresh(account).finally(() => {
            this.#inFlight = null;
        });
        return this.#inFlight;
    }

    /**
     * @param {import('./credentials.js').Account} account
     * @returns {Promise<string>}
     */
    async #refresh(account) {
        try {
            const tokens = await refreshTokens({ clientId: account.clientId, refreshToken: /** @type {string} */ (account.refreshToken) }, this.#fetch);
            this.#store.updateTokens({
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                idToken: tokens.id_token,
                expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
                scope: tokens.scope,
            });
            return tokens.access_token;
        } catch (error) {
            if (error instanceof OAuthError && REAUTH_ERRORS.has(error.code)) {
                this.#store.signOut();
                throw new SignInRequired();
            }
            if (error instanceof OAuthError && error.code === 'invalid_client') {
                throw new Error('ChatGPT rejected Kotatsu\'s client registration. Disconnect and sign in again.');
            }
            // A network blip: keep the credentials, let the request fail.
            throw error;
        }
    }
}
