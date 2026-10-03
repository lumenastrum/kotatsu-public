/**
 * `<k-provider-cards variant="grid">` — "Your API keys" (docs/connections-v0.md, slice C2).
 *
 * First-party providers, one card each, under the Claude Code card: Anthropic API, OpenAI,
 * Google AI Studio, DeepSeek, xAI, OpenRouter. One aggregator earned a card (Andres, 2026-10-03:
 * OpenRouter is what roleplayers paste a key for); the rest live under "More ways to connect"
 * (slice C3), with Mistral.
 *
 * A card says whether a key is saved and which model that provider will use, and does ONE thing:
 * **Use** (switch to it and connect) or **Add key** (paste inline, then save and connect). It
 * never touches secrets itself. It drives core's own path, the same one the stock panel uses:
 * pick the Chat Completion source, put the pasted key in that source's own key field, press
 * core's Connect — which writes the key as a secret (openai.js `onConnectButtonClick`), clears
 * nothing it shouldn't, and runs the status check. The verdict is core's `online_status`, read
 * when ONLINE_STATUS_CHANGED lands. Key values are never read back or shown: only whether
 * `secret_state` holds one.
 *
 * Light DOM (css/kotatsu-connections.css), `variant` per SPEC §13. Mounted right after
 * `<k-bridge-card>` in core's `#rm_api_block`.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { main_api, online_status } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings } from '../../scripts/openai.js';
import { secret_state } from '../../scripts/secrets.js';
import { BRIDGE_CHANGE_EVENT, isOnBridge, modelLabel, pressConnect } from './bridge.js';
import { PROVIDERS } from './providers.js';

export { PROVIDERS };

/**
 * Bubbling event each connect attempt ends with: `detail = { ok, source, name }`. The welcome
 * tour's Connect step reads it to say which key didn't take (onboarding v0 O2).
 */
export const CONNECT_ATTEMPT_EVENT = 'k-connect-attempt';

/** Per-instance id prefixes: the Connection tab's copy and the tour's can both be in the DOM. */
let instances = 0;

/** @typedef {import('./providers.js').Provider} Provider */

/**
 * @param {string} secret Secret key id
 * @returns {boolean} Whether a key is saved for it (never its value)
 */
function hasKey(secret) {
    const entry = /** @type {Record<string, unknown>} */ (secret_state)[secret];
    return Array.isArray(entry) ? entry.length > 0 : Boolean(entry);
}

/** @param {Provider} provider @returns {string} */
function modelOf(provider) {
    const model = String(/** @type {Record<string, unknown>} */ (oai_settings ?? {})[provider.modelKey] ?? '');
    return model === provider.placeholderModel ? '' : model;
}

/** @param {Provider} provider @returns {boolean} */
function isActive(provider) {
    return main_api === 'openai' && oai_settings?.chat_completion_source === provider.source && !isOnBridge();
}

/**
 * Sets a core control and fires the event core binds to it.
 * @param {string} id Element id
 * @param {string} value Value
 * @param {'change'|'input'} type Event
 * @returns {boolean} Whether the control exists
 */
function commit(id, value, type) {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLSelectElement || element instanceof HTMLInputElement)) return false;
    element.value = value;
    element.dispatchEvent(new Event(type, { bubbles: true }));
    return true;
}

/**
 * Switches to a provider through core's own controls and connects; resolves with whether core
 * reports a live connection afterwards.
 * @param {Provider} provider
 * @param {string} [key] A key just pasted, handed to core's own field for Connect to save
 * @returns {Promise<boolean>}
 */
export async function connectProvider(provider, key = '') {
    if (main_api !== 'openai') commit('main_api', 'openai', 'change');
    commit('chat_completion_source', provider.source, 'change');
    if (key) commit(provider.keyField, key, 'input');
    await pressConnect();
    // Whatever Connect did with the typed key, it does not stay in the field.
    const field = document.getElementById(provider.keyField);
    if (field instanceof HTMLInputElement) field.value = '';
    return online_status !== 'no_connection';
}

export class KProviderCards extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _adding: { state: true },
        _busy: { state: true },
        _failed: { state: true },
    };

    constructor() {
        super();
        this.variant = 'grid';
        /** @type {string} prefix for this instance's ids */
        this._uid = `k-pc${++instances}`;
        /** @type {string} source whose inline key form is open */
        this._adding = '';
        /** @type {string} source connecting right now */
        this._busy = '';
        /** @type {string} source whose last connect failed */
        this._failed = '';
        this._refresh = () => {
            // A failure is about one attempt; once some other connection is live it is stale.
            if (this._failed && !this._busy && online_status !== 'no_connection') {
                this._failed = '';
                this._adding = '';
            }
            this.requestUpdate();
        };
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        for (const type of [event_types.ONLINE_STATUS_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED, event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SETTINGS_LOADED_AFTER]) {
            if (typeof type === 'string') eventSource.on(type, this._refresh);
        }
        document.addEventListener(BRIDGE_CHANGE_EVENT, this._refresh);
    }

    disconnectedCallback() {
        for (const type of [event_types.ONLINE_STATUS_CHANGED, event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED, event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SETTINGS_LOADED_AFTER]) {
            if (typeof type === 'string') eventSource.removeListener(type, this._refresh);
        }
        document.removeEventListener(BRIDGE_CHANGE_EVENT, this._refresh);
        super.disconnectedCallback();
    }

    /** @param {Provider} provider @param {string} [key] */
    async _connect(provider, key = '') {
        if (this._busy) return;
        this._busy = provider.source;
        this._failed = '';
        const ok = await connectProvider(provider, key);
        this._busy = '';
        this.dispatchEvent(new CustomEvent(CONNECT_ATTEMPT_EVENT, { bubbles: true, detail: { ok, source: provider.source, name: provider.name } }));
        if (ok) {
            this._adding = '';
        } else {
            this._failed = provider.source;
        }
    }

    /** @param {SubmitEvent} event @param {Provider} provider */
    _submit(event, provider) {
        event.preventDefault();
        const form = /** @type {HTMLFormElement} */ (event.currentTarget);
        const input = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="key"]'));
        const key = input?.value.trim() ?? '';
        if (input) input.value = '';
        if (key) void this._connect(provider, key);
    }

    /** @param {Provider} provider */
    _card(provider) {
        const saved = hasKey(provider.secret);
        const active = isActive(provider) && online_status !== 'no_connection';
        const model = modelOf(provider);
        const busy = this._busy === provider.source;
        const failed = this._failed === provider.source;
        const adding = this._adding === provider.source;
        const status = busy ? 'Connecting…'
            : failed ? (saved ? 'Couldn’t connect. Check the key or try again.' : 'Couldn’t connect.')
                : active ? `In use${model ? ` · ${modelLabel(model)}` : ''}`
                    : saved ? `Key saved${model ? ` · ${modelLabel(model)}` : ''}`
                        : 'No key yet';
        const tone = failed ? 'danger' : active ? 'active' : saved ? 'saved' : 'none';

        return html`
            <div class="k-pc__card" data-tone=${tone}>
                <div class="k-pc__row">
                    <div class="k-pc__copy">
                        <span class="k-pc__name">${provider.name}</span>
                        <span class="k-pc__status" role="status">${status}</span>
                    </div>
                    ${active ? nothing : adding ? nothing : saved
        ? html`<button type="button" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy)} @click=${() => this._connect(provider)}>Use</button>`
        : html`<button type="button" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy)} @click=${() => { this._adding = provider.source; this._failed = ''; }}>Add key</button>`}
                </div>
                ${adding ? html`
                    <form class="k-pc__form" @submit=${(/** @type {SubmitEvent} */ event) => this._submit(event, provider)}>
                        <label class="k-pc__label" for=${`${this._uid}-key-${provider.source}`}>${provider.name} API key</label>
                        <input id=${`${this._uid}-key-${provider.source}`} name="key" type="password" autocomplete="off" spellcheck="false"
                            placeholder=${`From ${provider.hint}`} required>
                        <p class="k-bc__hint">Saved in Kotatsu’s secrets on this computer and never shown again. Billed by ${provider.name}.</p>
                        <div class="k-bc__actions">
                            <button type="submit" class="k-bc__btn k-bc__btn--small k-bc__btn--primary" ?disabled=${Boolean(this._busy)}>${busy ? 'Connecting…' : 'Save and connect'}</button>
                            <button type="button" class="k-bc__btn k-bc__btn--small" @click=${() => { this._adding = ''; }}>Cancel</button>
                        </div>
                    </form>` : nothing}
            </div>`;
    }

    render() {
        return html`
            <section class="k-pc" aria-labelledby=${`${this._uid}-title`}>
                <div class="k-pc__head">
                    <h3 class="k-bc__cap" id=${`${this._uid}-title`}>Your API keys</h3>
                    <span class="k-bc__hint">Billed by each provider. Keys stay on this computer.</span>
                </div>
                <div class="k-pc__grid">${PROVIDERS.map(provider => this._card(provider))}</div>
            </section>`;
    }
}

if (!customElements.get('k-provider-cards')) {
    customElements.define('k-provider-cards', KProviderCards);
}

/**
 * Mounts the cards right after `<k-bridge-card>` in core's API connections block, once.
 * @returns {void}
 */
export function mountProviderCards() {
    const block = document.getElementById('rm_api_block');
    const bridge = block?.querySelector('k-bridge-card');
    if (!block || !bridge) return;
    const cards = block.querySelector('k-provider-cards') ?? document.createElement('k-provider-cards');
    // The ChatGPT card (chatgpt-bridge-v0 C2) sits between the Claude card and "Your API keys".
    const anchor = block.querySelector('k-chatgpt-card') ?? bridge;
    if (anchor.nextElementSibling !== cards) anchor.after(cards);
}
