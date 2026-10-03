import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * The ChatGPT bridge's credentials (docs/chatgpt-bridge-v0.md §1): one file under
 * `DATA_ROOT/.kotatsu/`, written atomically and owner-only where the OS honours it. Never in
 * `secrets.json` (the UI can read that), never sent to the browser, never logged.
 *
 * Shape: { version, hostId, account: null | { label, sub, clientId, accessToken, refreshToken,
 * idToken, expiresAt, scope, signedOut } }. `hostId` is install-scoped and survives sign-out;
 * `clientId` survives sign-out too, so signing back in reuses the registration (protocol §1).
 */

/**
 * @typedef {object} Account
 * @property {string} label What the user sees (email, else name)
 * @property {string} sub Verified account id
 * @property {string} clientId Issued `oaiapp_…` id
 * @property {string|null} accessToken
 * @property {string|null} refreshToken
 * @property {string|null} idToken
 * @property {number} expiresAt Access-token expiry, ms epoch
 * @property {string} scope Granted scopes
 * @property {boolean} signedOut Tokens cleared or no longer valid; registration kept
 */

export class CredentialStore {
    /** @type {string} */
    #file;
    /** @type {{version: number, hostId: string, account: Account|null}} */
    #data;

    /**
     * @param {string} dataRoot
     */
    constructor(dataRoot) {
        this.#file = path.join(dataRoot, '.kotatsu', 'chatgpt-credentials.json');
        this.#data = this.#load();
    }

    #load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
            if (data && typeof data.hostId === 'string') return { version: 1, hostId: data.hostId, account: data.account ?? null };
        } catch {
            // Missing or unreadable: start fresh with a new host id (it's opaque, not a credential).
        }
        return { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, account: null };
    }

    #save() {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
        writeFileAtomicSync(this.#file, JSON.stringify(this.#data, null, 4), { encoding: 'utf8', mode: 0o600 });
    }

    /** Persists the host id before the first sign-in, as the protocol asks. */
    ensureHostId() {
        if (!fs.existsSync(this.#file)) this.#save();
        return this.#data.hostId;
    }

    get hostId() {
        return this.#data.hostId;
    }

    /** @returns {Account|null} */
    get account() {
        return this.#data.account ? { ...this.#data.account } : null;
    }

    /**
     * @param {Account} account
     */
    setAccount(account) {
        this.#data.account = { ...account, signedOut: false };
        this.#save();
    }

    /**
     * @param {{accessToken: string, refreshToken?: string, idToken?: string, expiresAt: number, scope?: string}} tokens
     */
    updateTokens(tokens) {
        const account = this.#data.account;
        if (!account) return;
        account.accessToken = tokens.accessToken;
        if (tokens.refreshToken) account.refreshToken = tokens.refreshToken;
        if (tokens.idToken) account.idToken = tokens.idToken;
        account.expiresAt = tokens.expiresAt;
        if (tokens.scope) account.scope = tokens.scope;
        account.signedOut = false;
        this.#save();
    }

    /** Clears tokens but keeps the registration (client id, label) and the host id. */
    signOut() {
        const account = this.#data.account;
        if (!account) return;
        account.accessToken = null;
        account.refreshToken = null;
        account.signedOut = true;
        this.#save();
    }
}
