/**
 * Phone card store (docs/phone-v0.md §4.2): fetches `/api/kotatsu/phone/status`, posts the
 * switch / pair / forget actions, and runs the pairing session.
 *
 * A pairing session is "a QR is showing": one minted code, its baseline of already-paired ids,
 * and a 2 s poll of `/status`. The poll exists ONLY for that: it starts when a code is shown and
 * stops when a new device appears, when the card closes or disconnects, or when Kotatsu stops
 * listening. A code that is about to expire is replaced while it is still showing.
 *
 * No imports: the CSRF headers come in through `getHeaders` (the card passes core's
 * `getRequestHeaders`), so Jest drives this with a fake fetch and fake timers.
 */

import { findNewDevice } from './view-model.js';

const API = '/api/kotatsu/phone';

/** How often `/status` is polled while a code is showing. */
export const POLL_MS = 2000;

/** A code this close to its expiry is replaced instead of shown. */
export const REMINT_BEFORE_MS = 15_000;

/**
 * @typedef {import('./view-model.js').PhoneStatus} PhoneStatus
 * @typedef {import('./view-model.js').PhoneDevice} PhoneDevice
 */

/**
 * @typedef {object} PairCode
 * @property {string} token
 * @property {number} expiresAt Epoch ms.
 * @property {string} path `/k-pair?t=…`
 */

/**
 * @typedef {object} PhoneState
 * @property {PhoneStatus|null} status
 * @property {string} error The last thing that went wrong, in words. '' when fine.
 * @property {string} busy '' | 'lan' | 'pair' | 'forget'
 * @property {PairCode|null} pair The code on screen, if any.
 * @property {PhoneDevice|null} justPaired The device that just paired through the code on screen.
 */

export class PhoneStore {
    /**
     * @param {{ fetchImpl?: typeof fetch, getHeaders?: () => Record<string, string>, now?: () => number, pollMs?: number }} [options]
     */
    constructor({ fetchImpl, getHeaders, now = () => Date.now(), pollMs = POLL_MS } = {}) {
        this._fetch = fetchImpl ?? ((...args) => fetch(...args));
        this._headers = getHeaders ?? (() => ({ 'Content-Type': 'application/json' }));
        this._now = now;
        this._pollMs = pollMs;
        /** @type {PhoneState} */
        this.state = { status: null, error: '', busy: '', pair: null, justPaired: null };
        /** @type {Set<(state: PhoneState) => void>} */
        this._listeners = new Set();
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._timer = null;
        this._session = 0;
        this._active = false;
        /** @type {Set<string>} */
        this._baseline = new Set();
    }

    /**
     * @param {(state: PhoneState) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    /** @param {Partial<PhoneState>} patch */
    _set(patch) {
        this.state = { ...this.state, ...patch };
        for (const listener of this._listeners) listener(this.state);
    }

    /**
     * @param {string} path
     * @param {unknown} [body] POSTed as JSON when given (a POST with no body still POSTs).
     * @param {'GET'|'POST'} [method]
     * @returns {Promise<{ ok: boolean, status: number, body: any }>}
     */
    async _call(path, body, method = 'GET') {
        const init = /** @type {RequestInit} */ ({ method, cache: 'no-store' });
        if (method === 'POST') {
            init.headers = this._headers();
            init.body = JSON.stringify(body ?? {});
        }
        const response = await this._fetch(`${API}${path}`, init);
        const parsed = await response.json().catch(() => null);
        return { ok: response.ok, status: response.status, body: parsed };
    }

    /**
     * Reads `/status`.
     * @returns {Promise<PhoneStatus|null>}
     */
    async refresh() {
        try {
            const result = await this._call('/status');
            if (!result.ok) throw new Error(result.body?.message ?? `HTTP ${result.status}`);
            this._set({ status: result.body, error: '' });
            return result.body;
        } catch (error) {
            this._set({ error: `Couldn’t reach Kotatsu: ${error instanceof Error ? error.message : String(error)}` });
            return null;
        }
    }

    /**
     * The LAN switch.
     * @param {boolean} enabled
     * @returns {Promise<boolean>} Whether it was saved.
     */
    async setLan(enabled) {
        if (this.state.busy) return false;
        this._set({ busy: 'lan', error: '' });
        try {
            const result = await this._call('/lan', { enabled }, 'POST');
            if (result.ok) {
                this._set({ status: result.body, busy: '' });
                if (!result.body.listen?.effective) this.closePairing();
                return true;
            }
            // Re-read first: a good refresh clears the error, so the reason goes up after it.
            if (result.status === 409) await this.refresh();
            this._set({ busy: '', error: result.body?.message ?? `Couldn’t save (HTTP ${result.status}).` });
            return false;
        } catch (error) {
            this._set({ busy: '', error: `Couldn’t save: ${error instanceof Error ? error.message : String(error)}` });
            return false;
        }
    }

    /**
     * Mints a code. Failure is said in words and leaves no code showing.
     * @returns {Promise<PairCode|null>}
     */
    async _mint() {
        const result = await this._call('/pair', {}, 'POST');
        if (!result.ok) {
            if (result.status === 409) await this.refresh();
            this._set({
                pair: null,
                error: result.status === 409 ? 'Kotatsu isn’t listening on the network yet.' : (result.body?.message ?? `Couldn’t make a code (HTTP ${result.status}).`),
            });
            return null;
        }
        const code = { token: result.body.token, expiresAt: Number(result.body.expiresAt), path: result.body.path };
        this._set({ pair: code, error: '' });
        return code;
    }

    /**
     * A QR is showing: mint a code, remember who is already paired, start the 2 s poll.
     * Idempotent while a session is live.
     * @returns {Promise<void>}
     */
    async openPairing() {
        if (this._active || this.state.busy === 'pair') return;
        this._active = true;
        this._set({ busy: 'pair', justPaired: null });
        const session = ++this._session;
        try {
            const status = this.state.status ?? await this.refresh();
            this._baseline = new Set((status?.paired ?? []).map(device => device.id));
            const code = await this._mint();
            if (!code) {
                this._active = false;
                return;
            }
            if (session !== this._session) return;
            this._schedule(session);
        } catch (error) {
            this._active = false;
            this._set({ error: `Couldn’t make a code: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            this._set({ busy: this.state.busy === 'pair' ? '' : this.state.busy });
        }
    }

    /**
     * The QR is gone (card closed, tab hidden, disconnected): stop polling and drop the code.
     * @returns {void}
     */
    closePairing() {
        this._session++;
        this._active = false;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
        if (this.state.pair) this._set({ pair: null });
    }

    /**
     * @param {number} session
     */
    _schedule(session) {
        this._timer = setTimeout(() => void this._tick(session), this._pollMs);
    }

    /**
     * One poll: a new device ends the session with a success; an expiring code is replaced.
     * @param {number} session
     * @returns {Promise<void>}
     */
    async _tick(session) {
        if (session !== this._session) return;
        this._timer = null;
        const status = await this.refresh();
        if (session !== this._session) return;
        const arrived = status ? findNewDevice(this._baseline, status.paired) : null;
        if (arrived) {
            this._session++;
            this._active = false;
            this._set({ justPaired: arrived, pair: null });
            return;
        }
        if (status && !status.listen.effective) {
            this.closePairing();
            return;
        }
        const code = this.state.pair;
        if (status && (!code || this._now() >= code.expiresAt - REMINT_BEFORE_MS)) {
            try {
                await this._mint();
            } catch (error) {
                this._set({ error: `Couldn’t make a code: ${error instanceof Error ? error.message : String(error)}` });
            }
            if (session !== this._session) return;
            if (!this.state.pair) {
                this._session++;
                this._active = false;
                return;
            }
        }
        this._schedule(session);
    }

    /**
     * Forgets a paired device; its next request is refused.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async forget(id) {
        if (this.state.busy) return false;
        this._set({ busy: 'forget', error: '' });
        try {
            const result = await this._call('/forget', { id }, 'POST');
            if (!result.ok || !this.state.status) throw new Error(result.body?.message ?? `HTTP ${result.status}`);
            this._set({ status: { ...this.state.status, paired: result.body.paired }, busy: '' });
            return true;
        } catch (error) {
            this._set({ busy: '', error: `Couldn’t forget that device: ${error instanceof Error ? error.message : String(error)}` });
            return false;
        }
    }

    /** Clears the success line (the person wants another code). */
    clearJustPaired() {
        this._set({ justPaired: null });
    }
}
