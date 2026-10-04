/**
 * `<k-bridge-card variant="card">` — the Claude Code card (docs/connections-v0.md, slice C1).
 *
 * The first thing on the Connection tab: Kotatsu's built-in route to Claude through the person's
 * own Claude Code login. Everything it shows is true at the moment it renders:
 *
 * - **Status** from the bridge's `/health` (listening, endpoint, models, its config) and
 *   `/doctor` (Claude Code installed, signed in, plan, engine running vs on disk).
 * - **Problems become cards with a fix**: not installed, not signed in (the command to copy, then
 *   Check again), an engine update waiting on a restart (Restart Kotatsu — offered only when a
 *   launcher will bring it back, `/health.supervised`), a bridge that stood down (its reason).
 * - **Model**: the bridge's own list, picked through core's controls (bridge.js setBridgeModel).
 * - **Effort**: Claude's five steps plus the bridge's default, owned by Kotatsu and sent only to
 *   the bridge (bridge.js applyBridgeEffort).
 * - **The bridge's own settings** (slice C4): show reasoning, prompt caching and fast mode as
 *   toggles that apply at once; default model, model list and port under "Bridge settings". All
 *   are written to config.yaml by the server (comments kept); the port waits for a restart and
 *   saved connections follow it (bridge.js moveBridgePort). A key an environment variable
 *   overrides is shown, never edited.
 *
 * Light DOM (css/kotatsu-connections.css paints it), `variant` attribute per SPEC §13. Mounted
 * as the first child of core's `#rm_api_block`, so it travels wherever that drawer is adopted.
 *
 * `variant="compact"` (onboarding v0 O2, the welcome tour's Connect step): status, problems with
 * their fixes, Use and Run diagnostics only. The model/effort grid and the bridge's own settings
 * are not rendered at all — first run is not the place for them, the tour's Sauce step owns
 * effort, and every fixed id this card stamps lives in those two sections, so a compact copy
 * beside the Connection tab's never duplicates one.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import {
    BRIDGE_CHANGE_EVENT,
    BRIDGE_STATUS_EVENT,
    EFFORTS,
    doctorProblems,
    selectionPill,
    getBridgeEffort,
    getBridgeModel,
    getDoctor,
    getHealth,
    isOnBridge,
    loadDoctor,
    modelLabel,
    moveBridgePort,
    refreshHealth,
    getRestartError,
    restartKotatsu,
    saveBridgeSettings,
    setBridgeEffort,
    setBridgeModel,
    useClaudeCode,
} from './bridge.js';
import { mountChatGPTCard } from './k-chatgpt-card.js';

const SIGN_IN_COMMAND = 'claude auth login';

/** The live toggles (C4): config key, label, what it does. */
const TOGGLES = Object.freeze([
    ['exposeReasoning', 'Show Claude’s reasoning', 'A summarized thinking block above each reply.'],
    ['resumeHistory', 'Prompt caching', 'Resumes the chat as a session, so long chats stay fast and light on your limits.'],
    ['fastMode', 'Fast mode', 'Faster replies when your plan allows it.'],
]);

/** A port taken by something else, in the bridge's stand-down reason. */
const PORT_TAKEN = /EADDRINUSE|already in use/i;

const icons = {
    // A prompt, not a burst: Claude Code is a terminal app, and a ring of rays read as a spinner.
    prompt: html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 8 4 4-4 4M12 17h7"/></svg>`,
    copy: html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h7"/></svg>`,
};

export class KBridgeCard extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _busy: { state: true },
        _copied: { state: true },
        _restarting: { state: true },
        _note: { state: true },
        _error: { state: true },
        _freePort: { state: true },
    };

    constructor() {
        super();
        this.variant = 'card';
        /** @type {string} */
        this._busy = '';
        this._copied = false;
        this._restarting = false;
        /** @type {string} what the last save did */
        this._note = '';
        /** @type {string} why the last save didn't happen */
        this._error = '';
        /** @type {number|null} a free port to offer when the bridge's own is taken */
        this._freePort = null;
        this._freePortAsked = false;
        this._onStatus = () => this.requestUpdate();
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        document.addEventListener(BRIDGE_STATUS_EVENT, this._onStatus);
        document.addEventListener(BRIDGE_CHANGE_EVENT, this._onStatus);
        // The card is mounted at boot but usually unseen; the doctor (which spawns the `claude`
        // CLI) is asked the first time it actually shows.
        this._observer = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) this.reveal();
        });
        this._observer.observe(this);
    }

    disconnectedCallback() {
        document.removeEventListener(BRIDGE_STATUS_EVENT, this._onStatus);
        document.removeEventListener(BRIDGE_CHANGE_EVENT, this._onStatus);
        this._observer?.disconnect();
        super.disconnectedCallback();
    }

    /**
     * The card came into view: ask the doctor once per page (shared with the boot check), never
     * on every render.
     * @returns {void}
     */
    reveal() {
        if (!getDoctor().doctor && !getDoctor().pending) void loadDoctor();
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

    async _copy() {
        try {
            await navigator.clipboard.writeText(SIGN_IN_COMMAND);
            this._copied = true;
            setTimeout(() => { this._copied = false; }, 1800);
        } catch {
            // Clipboard refused (insecure origin): the command is on screen to type.
        }
    }

    /**
     * Saves bridge settings and says what happened.
     * @param {Record<string, any>} patch
     * @param {string} note What to say when it worked
     */
    async _save(patch, note) {
        await this._run('save', async () => {
            this._error = '';
            const result = await saveBridgeSettings(patch);
            if (result.ok) this._note = note;
            else {
                this._note = '';
                this._error = result.error ?? 'Couldn’t save.';
            }
        });
    }

    /** @param {number} port */
    async _movePort(port) {
        await this._run('port', async () => {
            this._error = '';
            this._note = '';
            const result = await moveBridgePort(port);
            if (!result.ok) this._error = result.error ?? 'Couldn’t move the bridge.';
            else if (result.restarting) this._restarting = true;
            else this._note = `Saved. Restart Kotatsu to move the bridge to port ${port}; saved Claude Code connections follow on that start.`;
        });
    }

    /** Asks the server, once, for a free port to offer. */
    _askFreePort() {
        if (this._freePortAsked) return;
        this._freePortAsked = true;
        void fetch('/api/kotatsu/claude-bridge/free-port').then(r => r.json()).then((body) => {
            this._freePort = Number.isInteger(body?.port) ? body.port : null;
        }).catch(() => {});
    }

    /** @param {SubmitEvent} event */
    _submitModels(event) {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const data = new FormData(form);
        // One per line (or comma-separated). Never split on spaces: "claude opus" is a typo to refuse,
        // not two model ids to save (caught live).
        const models = String(data.get('models') ?? '').split(/[\n,]+/).map(id => id.trim()).filter(Boolean);
        const defaultModel = String(data.get('defaultModel') ?? '');
        void this._save({ models, defaultModel: models.includes(defaultModel) ? defaultModel : models[0] }, 'Models saved to config.yaml.');
    }

    /** @param {SubmitEvent} event @param {any} health */
    _submitPort(event, health) {
        event.preventDefault();
        const input = /** @type {HTMLFormElement} */ (event.currentTarget).querySelector('input[name="port"]');
        const port = Number(input instanceof HTMLInputElement ? input.value : NaN);
        if (port === health?.settings?.port && !health?.pendingRestart) return;
        void this._movePort(port);
    }

    /** @param {any} health */
    _settings(health) {
        const settings = health.settings ?? {};
        const locked = Array.isArray(settings.locked) ? settings.locked : [];
        const models = Array.isArray(health.models) ? health.models : [];
        const lockedHint = (/** @type {string} */ key) => (locked.includes(key) ? html`<small class="k-bc__locked">Set by an environment variable</small>` : nothing);
        return html`
            <details class="k-bc__advanced">
                <summary>Bridge settings</summary>
                <div class="k-bc__advgrid">
                <form class="k-bc__form" @submit=${(/** @type {SubmitEvent} */ e) => this._submitModels(e)}>
                    <label class="k-bc__label" for="k-bc-default-model">Default model ${lockedHint('defaultModel')}</label>
                    <select id="k-bc-default-model" name="defaultModel" ?disabled=${locked.includes('defaultModel')}>
                        ${models.map(id => html`<option value=${id} ?selected=${id === health.model}>${modelLabel(id)} · ${id}</option>`)}
                    </select>
                    <p class="k-bc__hint">Used when a chat doesn’t pick one, and by Effort’s “Default”.</p>
                    <label class="k-bc__label" for="k-bc-models">Models the bridge offers, one per line ${lockedHint('models')}</label>
                    <textarea id="k-bc-models" name="models" rows=${Math.min(10, Math.max(4, models.length))} spellcheck="false" ?disabled=${locked.includes('models')}>${models.join('\n')}</textarea>
                    <div class="k-bc__actions">
                        <button type="submit" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy) || (locked.includes('models') && locked.includes('defaultModel'))}>${this._busy === 'save' ? 'Saving…' : 'Save models'}</button>
                    </div>
                </form>
                <form class="k-bc__form" @submit=${(/** @type {SubmitEvent} */ e) => this._submitPort(e, health)}>
                    <label class="k-bc__label" for="k-bc-port">Port ${lockedHint('port')}</label>
                    <div class="k-bc__inline">
                        <input id="k-bc-port" name="port" type="number" min="1024" max="65535" step="1" required
                            .value=${String(health.pendingRestart?.port ?? settings.port ?? '')} ?disabled=${locked.includes('port')}>
                        <button type="submit" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy) || this._restarting || locked.includes('port')}>${this._busy === 'port' ? 'Moving…' : health.supervised ? 'Move and restart' : 'Save port'}</button>
                    </div>
                    <p class="k-bc__hint">${health.supervised
        ? 'Kotatsu restarts on the new port; saved Claude Code connections follow it.'
        : 'Takes effect the next time you start Kotatsu; saved Claude Code connections follow it then.'}</p>
                </form>
                </div>
            </details>`;
    }

    async _restart() {
        this._restarting = true;
        const ok = await restartKotatsu();
        if (!ok) {
            this._restarting = false;
            this._error = getRestartError();
        }
    }

    /**
     * @param {{ kind: string, detail: string }} problem
     * @param {any} health
     */
    _problem(problem, health) {
        switch (problem.kind) {
            case 'not-signed-in':
                return html`
                    <div class="k-bc__problem" data-tone="warning">
                        <strong>Claude Code isn’t signed in on this computer</strong>
                        <p>Kotatsu talks to Claude through the Claude Code app, as your user. Sign in once in a terminal; your subscription does the rest.</p>
                        <div class="k-bc__command">
                            <code>${SIGN_IN_COMMAND}</code>
                            <button type="button" class="k-bc__btn k-bc__btn--small" @click=${() => this._copy()}>${icons.copy}${this._copied ? 'Copied' : 'Copy'}</button>
                        </div>
                        <div class="k-bc__actions">
                            <button type="button" class="k-bc__btn k-bc__btn--primary" ?disabled=${Boolean(this._busy)} @click=${() => this._run('check', () => loadDoctor(true))}>${this._busy === 'check' ? 'Checking…' : 'Check again'}</button>
                        </div>
                    </div>`;
            case 'not-installed':
                return html`
                    <div class="k-bc__problem" data-tone="info">
                        <strong>Claude Code isn’t on this computer</strong>
                        <p>That’s fine if you connect another way. To use your Claude plan here, install Claude Code, sign in with <code>${SIGN_IN_COMMAND}</code>, then check again.</p>
                        <div class="k-bc__actions">
                            <a class="k-bc__btn" href="https://code.claude.com/docs/en/setup" target="_blank" rel="noopener">How to install Claude Code</a>
                            <button type="button" class="k-bc__btn k-bc__btn--primary" ?disabled=${Boolean(this._busy)} @click=${() => this._run('check', () => loadDoctor(true))}>${this._busy === 'check' ? 'Checking…' : 'Check again'}</button>
                        </div>
                    </div>`;
            case 'restart':
                return html`
                    <div class="k-bc__problem" data-tone="info">
                        <strong>Restart to finish updating Claude Code</strong>
                        <p>Claude Code’s engine was updated on disk (${problem.detail}). New models need it, and it loads on the next start. Your chats are saved.</p>
                        <div class="k-bc__actions">
                            ${health?.supervised
        ? html`<button type="button" class="k-bc__btn k-bc__btn--primary" ?disabled=${this._restarting} @click=${() => this._restart()}>${this._restarting ? 'Restarting…' : 'Restart Kotatsu'}</button>`
        : html`<p class="k-bc__hint">Restart Kotatsu from the window or terminal you started it in.</p>`}
                        </div>
                    </div>`;
            case 'standing-down':
            default:
                return html`
                    <div class="k-bc__problem" data-tone="danger">
                        <strong>${PORT_TAKEN.test(problem.detail) ? 'Something else is using the bridge’s port' : 'The bridge couldn’t start'}</strong>
                        <p>${problem.detail}</p>
                        ${PORT_TAKEN.test(problem.detail) && !(health?.settings?.locked ?? []).includes('port')
        ? (this._askFreePort(), this._freePort
            ? html`<div class="k-bc__actions">
                                <button type="button" class="k-bc__btn k-bc__btn--primary" ?disabled=${Boolean(this._busy) || this._restarting}
                                    @click=${() => this._movePort(/** @type {number} */ (this._freePort))}>${this._restarting ? 'Restarting…' : `Use port ${this._freePort}`}</button>
                            </div>
                            <p class="k-bc__hint">${health?.supervised ? 'Kotatsu restarts on it, and your saved Claude Code connections move with it.' : 'Saved for the next start; your saved Claude Code connections move with it then.'}</p>`
            : nothing)
        : html`<p class="k-bc__hint">Fix it in <code>config.yaml</code> under <code>kotatsu.claudeBridge</code>, then restart Kotatsu.</p>`}
                    </div>`;
        }
    }

    render() {
        const health = getHealth();
        const { doctor, pending } = getDoctor();
        const onBridge = isOnBridge();

        if (!health) {
            return html`<section class="k-bc" aria-label="Claude Code"><p class="k-bc__hint">Checking for Claude Code…</p></section>`;
        }

        const problems = health.enabled === false
            ? [{ kind: 'standing-down', detail: 'The Claude Code bridge is turned off (kotatsu.claudeBridge.enabled: false).' }]
            : doctorProblems(doctor ?? { standingDown: health.standingDown });
        const pill = selectionPill(onBridge, problems);
        const auth = doctor?.claudeAuth;
        const signedIn = auth && auth.available !== false && auth.loggedIn === true;
        const models = Array.isArray(health.models) ? health.models : [];
        const activeModel = getBridgeModel();
        const effort = getBridgeEffort();
        const settings = health.settings ?? {};
        const endpoint = typeof health.listener === 'string' ? health.listener.replace(/^https?:\/\//, '').replace(/\/v1$/, '') : '';

        return html`
            <section class="k-bc" aria-label="Claude Code" data-active=${onBridge ? 'true' : 'false'}>
                <header class="k-bc__head">
                    <div class="k-bc__mark">${icons.prompt}</div>
                    <div class="k-bc__title">
                        <div class="k-bc__name">
                            <h2>Claude Code</h2>
                            ${pill ? html`<span class="k-bc__pill" data-tone=${pill.tone}>${pill.tone ? html`<span class="k-bc__dot"></span>` : nothing}${pill.label}</span>` : nothing}
                        </div>
                        <p>Your Claude subscription, through the bridge built into Kotatsu. No API key, nothing billed per message.</p>
                        <div class="k-bc__pills">
                            <span class="k-bc__pill" data-tone=${health.listening ? 'success' : 'danger'}><span class="k-bc__dot"></span>${health.listening ? 'Bridge listening' : 'Bridge not running'}</span>
                            ${pending && !doctor
        ? html`<span class="k-bc__pill">Checking Claude Code…</span>`
        : signedIn
            ? html`<span class="k-bc__pill">Signed in${auth.subscriptionType ? html` · ${String(auth.subscriptionType).replace(/^./, c => c.toUpperCase())} plan` : nothing}</span>`
            : nothing}
                            ${doctor?.claudeCli?.version ? html`<span class="k-bc__pill k-bc__mono">Claude Code ${String(doctor.claudeCli.version).replace(/\s*\(.*\)$/, '')}</span>` : nothing}
                            ${endpoint ? html`<span class="k-bc__pill k-bc__mono">${endpoint}</span>` : nothing}
                        </div>
                    </div>
                    <div class="k-bc__headactions">
                        ${onBridge ? nothing : html`<button type="button" class="k-bc__btn k-bc__btn--primary" ?disabled=${!health.listening || Boolean(this._busy)} @click=${() => this._run('use', () => useClaudeCode())}>${this._busy === 'use' ? 'Switching…' : 'Use Claude Code'}</button>`}
                        <button type="button" class="k-bc__btn" ?disabled=${Boolean(this._busy)} @click=${() => this._run('check', async () => { await refreshHealth(); await loadDoctor(true); })}>${this._busy === 'check' ? 'Checking…' : 'Run diagnostics'}</button>
                    </div>
                </header>

                ${problems.map(problem => this._problem(problem, health))}

                ${health.pendingRestart?.port ? html`
                    <div class="k-bc__problem" data-tone="info">
                        <strong>Restart to move the bridge to port ${health.pendingRestart.port}</strong>
                        <p>It’s saved in config.yaml. The bridge keeps answering on its current port until Kotatsu restarts.</p>
                        <div class="k-bc__actions">
                            ${health.supervised
        ? html`<button type="button" class="k-bc__btn k-bc__btn--primary" ?disabled=${this._restarting} @click=${() => this._restart()}>${this._restarting ? 'Restarting…' : 'Restart Kotatsu'}</button>`
        : html`<p class="k-bc__hint">Restart Kotatsu from the window or terminal you started it in.</p>`}
                        </div>
                    </div>` : nothing}

                ${health.listening && this.variant !== 'compact' ? html`
                    <div class="k-bc__grid">
                        <div class="k-bc__field">
                            <span class="k-bc__cap" id="k-bc-model-label">Model</span>
                            <div class="k-bc__models" role="group" aria-labelledby="k-bc-model-label">
                                ${models.map(id => html`
                                    <button type="button" class="k-bc__model" aria-pressed=${onBridge && id === activeModel ? 'true' : 'false'}
                                        ?disabled=${!onBridge} title=${id} @click=${() => setBridgeModel(id)}>
                                        <span>${modelLabel(id)}</span>
                                        ${id === health.model ? html`<small>Bridge default</small>` : nothing}
                                    </button>`)}
                            </div>
                            ${onBridge ? nothing : html`<p class="k-bc__hint">Use Claude Code to pick a model.</p>`}
                        </div>
                        <div class="k-bc__field">
                            <span class="k-bc__cap" id="k-bc-effort-label">Effort</span>
                            <div class="k-bc__seg" role="group" aria-labelledby="k-bc-effort-label">
                                <button type="button" aria-pressed=${effort === '' ? 'true' : 'false'} @click=${() => setBridgeEffort('')}>Default</button>
                                ${EFFORTS.map(([id, label]) => html`<button type="button" aria-pressed=${effort === id ? 'true' : 'false'} @click=${() => setBridgeEffort(id)}>${label}</button>`)}
                            </div>
                            <p class="k-bc__hint">How hard Claude thinks before it writes. Default uses the bridge’s own setting${settings.reasoningEffort ? html` (${settings.reasoningEffort})` : nothing}. Some models always think; effort sets how much.</p>
                            <div class="k-bc__toggles">
                                ${TOGGLES.map(([key, label, hint]) => {
        const on = key === 'resumeHistory' ? settings[key] !== false : Boolean(settings[key]);
        const locked = (settings.locked ?? []).includes(key);
        return html`
                                    <label class="k-bc__toggle">
                                        <input type="checkbox" .checked=${on} ?disabled=${locked || Boolean(this._busy)}
                                            @change=${(/** @type {Event} */ e) => this._save({ [key]: /** @type {HTMLInputElement} */ (e.currentTarget).checked }, `${label}: ${/** @type {HTMLInputElement} */ (e.currentTarget).checked ? 'on' : 'off'}. Saved to config.yaml.`)}>
                                        <span><span>${label}</span><small>${locked ? 'Set by an environment variable' : hint}</small></span>
                                    </label>`;
    })}
                            </div>
                            ${settings.allowApiBilling ? html`<ul class="k-bc__facts"><li data-tone="warning"><span>API billing allowed (config.yaml)</span><b>On</b></li></ul>` : nothing}
                        </div>
                    </div>` : nothing}

                ${health.settings && this.variant !== 'compact' ? this._settings(health) : nothing}
                ${this._error ? html`<p class="k-bc__status" data-tone="danger" role="alert">${this._error}</p>`
        : this._note ? html`<p class="k-bc__status" role="status">${this._note}</p>` : nothing}
            </section>`;
    }
}

if (!customElements.get('k-bridge-card')) {
    customElements.define('k-bridge-card', KBridgeCard);
}

/**
 * Mounts the card as the first child of core's API connections block, once. The settings
 * modal's Connection tab adopts that block, so the card rides along; under classic the sheet
 * hides it. The ChatGPT card (chatgpt-bridge-v0 C2) is seated right after it.
 * @returns {void}
 */
export function mountBridgeCard() {
    const block = document.getElementById('rm_api_block');
    if (!block) return;
    const card = block.querySelector('k-bridge-card') ?? document.createElement('k-bridge-card');
    if (block.firstElementChild !== card) block.prepend(card);
    mountChatGPTCard();
}
