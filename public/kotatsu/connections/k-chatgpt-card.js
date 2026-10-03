/**
 * `<k-chatgpt-card variant="card">` — the ChatGPT card (docs/chatgpt-bridge-v0.md, slice C2).
 *
 * Kotatsu's built-in route to ChatGPT through the person's own Plus or Pro plan, signed in with
 * OpenAI's "Continue with ChatGPT" flow. Faces, from what `/status` says (chatgpt.js `cardState`):
 *
 * - **Not running**: the bridge's own error, plainly.
 * - **Signed out**: OpenAI's required button label and one line. Opens the sign-in in a new tab.
 * - **Waiting**: "Finish signing in in the new tab…" and Cancel; `/status` is polled every two
 *   seconds for up to ten minutes.
 * - **Signed in**: the account, a model select (names shown, slugs as values), Use ChatGPT
 *   (hidden while it is the connection), Manage usage, Disconnect.
 * - **Computer only**: sign-in and disconnect happen on the computer Kotatsu runs on; the buttons
 *   are not shown anywhere else.
 *
 * Plus OpenAI's one-time note after the first sign-in (a modal dialog, "Got it", never again).
 * No content disclaimers. Light DOM (css/kotatsu-chatgpt.css), `variant` per SPEC §13. Mounted
 * right after `<k-bridge-card>` in core's `#rm_api_block`.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { BRIDGE_CHANGE_EVENT, getBridgeModel } from './bridge.js';
import {
    CHATGPT_CHANGE_EVENT,
    CHATGPT_STATUS_EVENT,
    COPY,
    cardState,
    chooseModel,
    fetchModels,
    fetchStatus,
    getStatus,
    installChatGPTLink,
    isComputerOnly,
    isOnChatGPT,
    markNoteSeen,
    noteOwed,
    notRunningText,
    pollSignIn,
    signOut,
    startSignIn,
    useChatGPT,
} from './chatgpt.js';

const icons = {
    // A chat bubble: ChatGPT's own mark is OpenAI's to supply, and v0 ships without it.
    chat: html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z"/></svg>`,
    out: html`<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5"/></svg>`,
};

let cardCount = 0;

export class KChatGPTCard extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _busy: { state: true },
        _waiting: { state: true },
        _models: { state: true },
        _modelsError: { state: true },
        _picked: { state: true },
        _error: { state: true },
        _note: { state: true },
    };

    constructor() {
        super();
        this.variant = 'card';
        // Two copies can be up at once (the Connection tab's and the welcome tour's), so the ids
        // a label or dialog points at are per card.
        this._uid = `k-gc-${++cardCount}`;
        /** @type {string} */
        this._busy = '';
        this._waiting = false;
        /** @type {Array<{ slug: string, name: string }>} */
        this._models = [];
        this._modelsError = '';
        this._modelsFor = '';
        this._picked = '';
        this._error = '';
        this._note = false;
        /** @type {AbortController|null} */
        this._poll = null;
        this._onStatus = () => this._sync();
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        document.addEventListener(CHATGPT_STATUS_EVENT, this._onStatus);
        document.addEventListener(CHATGPT_CHANGE_EVENT, this._onStatus);
        document.addEventListener(BRIDGE_CHANGE_EVENT, this._onStatus);
        // Mounted at boot but usually unseen: the models (a call to OpenAI) and the first-sign-in
        // note wait for the card to actually show.
        this._observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) this.reveal();
        });
        this._observer.observe(this);
    }

    disconnectedCallback() {
        document.removeEventListener(CHATGPT_STATUS_EVENT, this._onStatus);
        document.removeEventListener(CHATGPT_CHANGE_EVENT, this._onStatus);
        document.removeEventListener(BRIDGE_CHANGE_EVENT, this._onStatus);
        this._observer?.disconnect();
        this._poll?.abort();
        super.disconnectedCallback();
    }

    updated() {
        const dialog = this.querySelector('dialog.k-gc__note');
        if (dialog instanceof HTMLDialogElement && this._note && !dialog.open) dialog.showModal();
    }

    /** The card came into view. @returns {void} */
    reveal() {
        void fetchStatus().then(() => this._sync());
    }

    /** Re-reads what the status implies: models once signed in, the note once owed. */
    _sync() {
        const status = getStatus();
        const state = cardState({ status, computerOnly: isComputerOnly(), waiting: this._waiting });
        if (state === 'signed-in') {
            const label = status?.account?.label ?? '';
            if (this._modelsFor !== label) {
                this._modelsFor = label;
                void this._loadModels();
            }
            if (!this._note && this.isConnected && this.offsetParent !== null && noteOwed()) this._note = true;
        } else {
            this._modelsFor = '';
            this._models = [];
        }
        this.requestUpdate();
    }

    async _loadModels() {
        const { models, error } = await fetchModels();
        this._models = models;
        this._modelsError = error;
        this.requestUpdate();
    }

    /** @param {string} name @param {() => Promise<unknown>} work */
    async _run(name, work) {
        if (this._busy) return;
        this._busy = name;
        try {
            await work();
        } finally {
            this._busy = '';
        }
    }

    async _signIn() {
        await this._run('signin', async () => {
            this._error = '';
            const result = await startSignIn();
            if (!result.ok) {
                this._error = result.error;
                this._sync();
                return;
            }
            this._waiting = true;
            this._sync();
            void this._watch();
        });
    }

    /** Polls until the sign-in lands, ends, or is cancelled. */
    async _watch() {
        this._poll?.abort();
        const controller = new AbortController();
        this._poll = controller;
        const outcome = await pollSignIn({ fetchStatus, signal: controller.signal, onStatus: () => this.requestUpdate() });
        if (this._poll !== controller) return;
        this._poll = null;
        this._waiting = false;
        if (outcome === 'ended' || outcome === 'timeout') this._error = 'That sign-in ended before it finished. Try again.';
        this._sync();
    }

    _cancel() {
        this._poll?.abort();
        this._poll = null;
        this._waiting = false;
        this._sync();
    }

    async _disconnect() {
        await this._run('disconnect', async () => {
            this._error = '';
            const result = await signOut();
            if (!result.ok) this._error = result.error ?? 'Couldn’t disconnect.';
            this._sync();
        });
    }

    /** @param {string} slug */
    _pick(slug) {
        this._picked = slug;
        if (isOnChatGPT()) void this._run('model', () => useChatGPT(slug));
    }

    _dismissNote() {
        markNoteSeen();
        this._note = false;
        const dialog = this.querySelector('dialog.k-gc__note');
        if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close();
    }

    /** @returns {unknown} */
    _noteDialog() {
        return html`
            <dialog class="k-gc__note" aria-labelledby=${`${this._uid}-note-title`} @cancel=${() => this._dismissNote()}>
                <h3 id=${`${this._uid}-note-title`}>${COPY.noteHeadline}</h3>
                <p>${COPY.noteBody}</p>
                <div class="k-gc__actions">
                    <button type="button" class="k-gc__btn k-gc__btn--primary" @click=${() => this._dismissNote()}>${COPY.noteAction}</button>
                </div>
            </dialog>`;
    }

    render() {
        const status = getStatus();
        const state = cardState({ status, computerOnly: isComputerOnly(), waiting: this._waiting });
        const onChatGPT = isOnChatGPT();
        const active = chooseModel(this._models, this._picked || (onChatGPT ? getBridgeModel() : ''));
        const manage = status?.manageUsage ?? 'https://chatgpt.com/settings/usage';

        if (state === 'loading') {
            return html`<section class="k-gc" aria-label="ChatGPT"><p class="k-gc__hint">Checking for ChatGPT…</p></section>`;
        }

        const blurb = {
            'not-running': 'Your ChatGPT Plus or Pro plan, through the bridge built into Kotatsu.',
            'signed-out': COPY.signInLine,
            'plan-missing': COPY.signInLine,
            waiting: COPY.signInLine,
            'computer-only': COPY.signInLine,
            'signed-in': 'Your ChatGPT plan, through the bridge built into Kotatsu. No API key, nothing billed per message.',
        }[state];

        return html`
            <section class="k-gc" aria-label="ChatGPT" data-state=${state} data-active=${onChatGPT ? 'true' : 'false'}>
                <header class="k-gc__head">
                    <div class="k-gc__mark">${icons.chat}</div>
                    <div class="k-gc__title">
                        <div class="k-gc__name">
                            <h2>ChatGPT</h2>
                            ${onChatGPT ? html`<span class="k-gc__pill" data-tone="success"><span class="k-gc__dot"></span>In use</span>` : nothing}
                        </div>
                        <p>${blurb}</p>
                        ${state === 'signed-in' ? html`
                            <div class="k-gc__pills">
                                <span class="k-gc__pill" data-tone="success"><span class="k-gc__dot"></span>Signed in</span>
                                ${status?.account?.label ? html`<span class="k-gc__pill k-gc__account">${status.account.label}</span>` : nothing}
                            </div>` : nothing}
                    </div>
                    ${state === 'signed-out' || state === 'plan-missing' ? html`
                        <div class="k-gc__headactions">
                            <button type="button" class="k-gc__btn k-gc__btn--primary" ?disabled=${Boolean(this._busy)} @click=${() => this._signIn()}>${COPY.signInLabel}</button>
                        </div>` : nothing}
                </header>

                ${state === 'not-running' ? html`
                    <div class="k-gc__problem" data-tone="danger">
                        <strong>The ChatGPT bridge isn’t running</strong>
                        <p>${notRunningText(status)}</p>
                    </div>` : nothing}

                ${state === 'plan-missing' ? html`
                    <div class="k-gc__problem" data-tone="warning">
                        <strong>Signed in, but without your ChatGPT plan</strong>
                        <p>Kotatsu needs permission to use your plan. Continue with ChatGPT again and allow ChatGPT plan usage.</p>
                    </div>` : nothing}

                ${state === 'waiting' ? html`
                    <div class="k-gc__waiting" role="status">
                        <span class="k-gc__spinner" aria-hidden="true"></span>
                        <span>Finish signing in in the new tab…</span>
                        <button type="button" class="k-gc__btn k-gc__btn--small" @click=${() => this._cancel()}>Cancel</button>
                    </div>` : nothing}

                ${state === 'computer-only' ? html`
                    <p class="k-gc__hint">${COPY.computerOnly}</p>` : nothing}

                ${state === 'signed-in' ? html`
                    <div class="k-gc__row">
                        <div class="k-gc__field">
                            <label class="k-gc__cap" for=${`${this._uid}-model`}>Model</label>
                            ${this._models.length ? html`
                                <select id=${`${this._uid}-model`} ?disabled=${Boolean(this._busy)}
                                    @change=${(/** @type {Event} */ e) => this._pick(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
                                    ${this._models.map(model => html`<option value=${model.slug} ?selected=${model.slug === active}>${model.name}</option>`)}
                                </select>` : html`<p class="k-gc__hint">${this._modelsError || 'Loading ChatGPT’s models…'}</p>`}
                        </div>
                        <div class="k-gc__actions">
                            ${onChatGPT ? nothing : html`<button type="button" class="k-gc__btn k-gc__btn--primary" ?disabled=${!status?.listening || Boolean(this._busy)} @click=${() => this._run('use', () => useChatGPT(active))}>${this._busy === 'use' ? 'Switching…' : 'Use ChatGPT'}</button>`}
                            <a class="k-gc__btn" href=${manage} target="_blank" rel="noopener">Manage usage${icons.out}</a>
                            ${isComputerOnly() ? nothing : html`<button type="button" class="k-gc__btn" ?disabled=${Boolean(this._busy)} @click=${() => this._disconnect()}>${this._busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>`}
                        </div>
                    </div>` : nothing}

                ${this._error ? html`<p class="k-gc__status" data-tone="danger" role="alert">${this._error}</p>` : nothing}
                ${this._note ? this._noteDialog() : nothing}
            </section>`;
    }
}

if (!customElements.get('k-chatgpt-card')) {
    customElements.define('k-chatgpt-card', KChatGPTCard);
}

/**
 * Mounts the card right after the Claude Code card in core's API connections block, once, and
 * starts the connection detector. Under classic the sheet hides it.
 * @returns {void}
 */
export function mountChatGPTCard() {
    installChatGPTLink();
    const block = document.getElementById('rm_api_block');
    if (!block) return;
    const card = block.querySelector('k-chatgpt-card') ?? document.createElement('k-chatgpt-card');
    const claude = block.querySelector('k-bridge-card');
    if (claude) {
        if (claude.nextElementSibling !== card) claude.after(card);
    } else if (block.firstElementChild !== card) {
        block.prepend(card);
    }
}
