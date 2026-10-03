/**
 * `<k-connection-more variant="split">` — "Saved connections" and "More ways to connect"
 * (docs/connections-v0.md, slice C3). Mounted after `<k-provider-cards>` in core's
 * `#rm_api_block`; the last of the three Kotatsu blocks on the Connection tab.
 *
 * **Saved connections** are Connection Manager profiles, shown with the person's own name and a
 * plain line ("Claude Code · Sonnet 4.6"). "In use" is computed against the live settings
 * (saved.js `profileMatches`), so it can't drift. Everything that changes a profile is the
 * extension's own control, pressed: its select to apply, its create / update / edit / delete
 * buttons with their own popups and confirmations. Those buttons act on the extension's
 * *selected* profile, so Edit and Delete sit on that row only, and a selected profile whose
 * settings have moved on offers Update.
 *
 * **More ways to connect** (D4):
 * - Local or self-hosted: Ollama, llama.cpp, KoboldCpp… and any OpenAI-compatible URL.
 * - Other providers & aggregators, collapsed: every other source core offers, read from its own
 *   selects.
 * - "SillyTavern connection panel": the stock drawer, untouched, behind a disclosure (D1).
 *
 * A way is picked through core's controls, then the stock panel opens at that API's form with
 * the next field to fill focused — the URL or key and Connect are core's, as upstream has them.
 *
 * **The stock panel is hidden, not moved.** `data-k-stock` on `#rm_api_block` drives one CSS
 * rule over the block's *direct* children (the profile row, the API title, the drawer body).
 * Nothing inside is written, so core's three per-API display writers keep sole authority
 * (registry-data.js, the `rm_api_block` entry).
 *
 * Light DOM (css/kotatsu-connections.css), `variant` per SPEC §13.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { online_status } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { BRIDGE_CHANGE_EVENT, BRIDGE_STATUS_EVENT, useSavedConnection } from './bridge.js';
import { PROVIDERS } from './providers.js';
import { currentWays, deleteSavedConnection, hasConnectionManager, isCurrentWay, renameSavedConnection, savedConnections, wayField } from './saved.js';
import { power_user } from '../../scripts/power-user.js';
import { saveSettingsDebounced } from '../../script.js';

/** `power_user` key: the stock panel's disclosure is open (remembered per install). */
export const STOCK_OPEN_KEY = 'kotatsu_stock_panel_open';

/** @typedef {import('./saved.js').Way} Way */

const REFRESH_EVENTS = [
    'APP_READY',
    'SETTINGS_LOADED_AFTER',
    'ONLINE_STATUS_CHANGED',
    'MAIN_API_CHANGED',
    'CHATCOMPLETION_SOURCE_CHANGED',
    'CHATCOMPLETION_MODEL_CHANGED',
    'OAI_PRESET_CHANGED_AFTER',
    'CONNECTION_PROFILE_LOADED',
    'CONNECTION_PROFILE_CREATED',
    'CONNECTION_PROFILE_UPDATED',
    'CONNECTION_PROFILE_DELETED',
];

/** Sources "Your API keys" already has a card for. */
const FIRST_PARTY = Object.freeze(PROVIDERS.map(provider => provider.source));

const chevron = html`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 4 4 4-4 4"/></svg>`;

/** @returns {HTMLElement|null} */
function apiBlock() {
    return document.getElementById('rm_api_block');
}

/** @returns {boolean} Whether the stock panel is showing. */
export function isStockPanelOpen() {
    return apiBlock()?.dataset.kStock === 'open';
}

/**
 * Shows or hides core's own connection panel (only ever an attribute on its container), and
 * remembers the choice.
 * @param {boolean} open
 * @param {boolean} [remember] false when restoring the remembered state
 * @returns {void}
 */
export function setStockPanelOpen(open, remember = true) {
    const block = apiBlock();
    if (!block) return;
    if (open) block.dataset.kStock = 'open';
    else delete block.dataset.kStock;
    if (remember && Boolean(/** @type {any} */ (power_user)[STOCK_OPEN_KEY]) !== open) {
        /** @type {Record<string, unknown>} */ (power_user)[STOCK_OPEN_KEY] = open;
        saveSettingsDebounced();
    }
}

/**
 * Sets a core control and fires the event core binds to it.
 * @param {string} id
 * @param {string} value
 * @returns {void}
 */
function commit(id, value) {
    const element = document.getElementById(id);
    if (!(element instanceof HTMLSelectElement) || element.value === value) return;
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Presses one of the Connection Manager's own buttons.
 * @param {'create'|'update'|'edit'|'delete'} action
 * @returns {void}
 */
function pressManager(action) {
    document.getElementById(`${action}_connection_profile`)?.click();
}

export class KConnectionMore extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _busy: { state: true },
        _open: { state: true },
    };

    constructor() {
        super();
        this.variant = 'split';
        /** @type {string} profile id being switched to */
        this._busy = '';
        /** @type {''|'local'|'others'} which "more ways" group is open */
        this._open = '';
        this._refresh = () => this.requestUpdate();
        // Typing a URL or model in the stock panel moves the live connection with no core event.
        this._onInput = (/** @type {Event} */ event) => {
            if (event.target instanceof Element && event.target.closest('#rm_api_block')) this.requestUpdate();
        };
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        for (const key of REFRESH_EVENTS) {
            const type = /** @type {Record<string, string>} */ (event_types)[key];
            if (typeof type === 'string') eventSource.on(type, this._refresh);
        }
        document.addEventListener(BRIDGE_CHANGE_EVENT, this._refresh);
        document.addEventListener(BRIDGE_STATUS_EVENT, this._refresh);
        document.addEventListener('change', this._onInput);
    }

    disconnectedCallback() {
        for (const key of REFRESH_EVENTS) {
            const type = /** @type {Record<string, string>} */ (event_types)[key];
            if (typeof type === 'string') eventSource.removeListener(type, this._refresh);
        }
        document.removeEventListener(BRIDGE_CHANGE_EVENT, this._refresh);
        document.removeEventListener(BRIDGE_STATUS_EVENT, this._refresh);
        document.removeEventListener('change', this._onInput);
        super.disconnectedCallback();
    }

    /** @param {string} id */
    async _use(id) {
        if (this._busy) return;
        this._busy = id;
        try {
            await useSavedConnection(id);
        } finally {
            this._busy = '';
        }
    }

    /**
     * Runs a rename or delete, then re-renders: the selection is restored AFTER the extension's
     * own events have already redrawn this list (caught live: a cancelled delete left the wrong
     * row drawn as selected).
     * @param {(id: string) => Promise<void>} action
     * @param {string} id
     */
    async _manage(action, id) {
        try {
            await action(id);
        } finally {
            this.requestUpdate();
        }
    }

    /**
     * Picks a way through core's controls, then opens the stock panel at its form.
     * @param {Way} way
     */
    _pick(way) {
        commit('main_api', way.mainApi);
        if (way.source) commit('chat_completion_source', way.source);
        if (way.type) commit('textgen_type', way.type);
        this._toggleStock(true);
        // Core shows the API's block in the same task as the change; wait a frame for layout.
        requestAnimationFrame(() => {
            const field = wayField(way);
            if (!field) return;
            field.scrollIntoView({ block: 'center', behavior: 'smooth' });
            field.focus({ preventScroll: true });
        });
    }

    /** @param {boolean} [force] */
    _toggleStock(force) {
        setStockPanelOpen(force ?? !isStockPanelOpen());
        this.requestUpdate();
    }

    /** @param {import('./saved.js').SavedConnection} saved */
    _row(saved) {
        const connected = online_status !== 'no_connection';
        const busy = this._busy === saved.id;
        const changed = saved.drifted;
        const tone = saved.inUse ? 'active' : changed ? 'changed' : 'idle';
        const state = busy ? 'Switching…'
            : saved.inUse ? (connected ? 'In use' : 'Selected · not connected')
                : changed ? 'Changed since saved' : '';
        const showUse = !busy && !(saved.inUse && connected);
        return html`
            <li class="k-cm__row" data-tone=${tone}>
                <span class="k-cm__dot" aria-hidden="true"></span>
                <span class="k-cm__copy">
                    <span class="k-cm__name">${saved.name}</span>
                    <span class="k-cm__detail">${saved.detail}</span>
                </span>
                ${state ? html`<span class="k-cm__state" role="status">${state}</span>` : nothing}
                ${showUse ? html`<button type="button" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy)}
                    aria-label=${`${saved.inUse ? 'Connect' : 'Use'} ${saved.name}`}
                    @click=${() => this._use(saved.id)}>${saved.inUse ? 'Connect' : 'Use'}</button>` : nothing}
                <span class="k-cm__manage">
                    ${saved.selected ? html`
                        ${changed ? html`<button type="button" class="k-bc__btn k-bc__btn--small" title="Save the settings you have now into this connection" @click=${() => pressManager('update')}>Update</button>` : nothing}
                        <button type="button" class="k-bc__btn k-bc__btn--small" @click=${() => pressManager('edit')}>Edit</button>
                        <button type="button" class="k-bc__btn k-bc__btn--small" @click=${() => pressManager('delete')}>Delete</button>`
        : html`
                        <button type="button" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy)} aria-label=${`Rename ${saved.name}`} @click=${() => this._manage(renameSavedConnection, saved.id)}>Rename</button>
                        <button type="button" class="k-bc__btn k-bc__btn--small" ?disabled=${Boolean(this._busy)} aria-label=${`Delete ${saved.name}`} @click=${() => this._manage(deleteSavedConnection, saved.id)}>Delete</button>`}
                </span>
            </li>`;
    }

    _saved() {
        if (!hasConnectionManager()) return nothing;
        const list = savedConnections();
        return html`
            <section class="k-cm__saved" aria-labelledby="k-cm-saved-title">
                <h3 class="k-bc__cap" id="k-cm-saved-title">Saved connections</h3>
                ${list.length
        ? html`<ul class="k-cm__list">${list.map(saved => this._row(saved))}</ul>`
        : html`<p class="k-bc__hint">Nothing saved yet. Save the connection you’re using to come back to it in one click.</p>`}
                <div class="k-bc__actions">
                    <button type="button" class="k-bc__btn k-bc__btn--small" @click=${() => pressManager('create')}>Save current as a connection</button>
                </div>
            </section>`;
    }

    /**
     * @param {'local'|'others'} id
     * @param {string} name
     * @param {string} hint
     * @param {Way[]} ways
     */
    _group(id, name, hint, ways) {
        const open = this._open === id;
        return html`
            <div class="k-cm__way" data-open=${open ? 'true' : 'false'}>
                <button type="button" class="k-cm__wayhead" aria-expanded=${open ? 'true' : 'false'} aria-controls=${`k-cm-${id}`}
                    @click=${() => { this._open = open ? '' : id; }}>
                    <span class="k-cm__copy"><span class="k-cm__name">${name}</span><span class="k-bc__hint">${hint}</span></span>
                    <span class="k-cm__chevron">${chevron}</span>
                </button>
                ${open ? html`
                    <div class="k-cm__choices" id=${`k-cm-${id}`}>
                        ${ways.map(way => html`
                            <button type="button" class="k-cm__choice" aria-pressed=${isCurrentWay(way) ? 'true' : 'false'} @click=${() => this._pick(way)}>
                                ${way.name}${way.note ? html`<small>${way.note}</small>` : nothing}
                            </button>`)}
                    </div>` : nothing}
            </div>`;
    }

    _more() {
        const { local, others } = currentWays(FIRST_PARTY);
        // Name the aggregators people actually reach for, where core still offers them.
        const named = ['cc:nanogpt', 'cc:chutes', 'cc:mistralai'].map(id => others.find(way => way.id === id)?.name).filter(Boolean);
        const othersHint = named.length ? `${named.join(', ')} and ${others.length - named.length} more` : '';
        const stockOpen = isStockPanelOpen();
        return html`
            <section class="k-cm__more" aria-labelledby="k-cm-more-title">
                <h3 class="k-bc__cap" id="k-cm-more-title">More ways to connect</h3>
                ${this._group('local', 'Local or self-hosted', 'Ollama, llama.cpp, KoboldCpp, any OpenAI-compatible URL', local)}
                ${this._group('others', 'Other providers & aggregators', othersHint, others)}
                <div class="k-cm__way" data-open=${stockOpen ? 'true' : 'false'}>
                    <button type="button" class="k-cm__wayhead" aria-expanded=${stockOpen ? 'true' : 'false'} @click=${() => this._toggleStock()}>
                        <span class="k-cm__copy"><span class="k-cm__name">SillyTavern connection panel</span><span class="k-bc__hint">Every stock setting, exactly as upstream has it</span></span>
                        <span class="k-cm__chevron">${chevron}</span>
                    </button>
                </div>
            </section>`;
    }

    render() {
        return html`<div class="k-cm">${this._saved()}${this._more()}</div>`;
    }
}

if (!customElements.get('k-connection-more')) {
    customElements.define('k-connection-more', KConnectionMore);
}

/**
 * Mounts the block right after `<k-provider-cards>` in core's API connections block, once.
 * @returns {void}
 */
export function mountConnectionMore() {
    const block = apiBlock();
    const cards = block?.querySelector('k-provider-cards');
    if (!block || !cards) return;
    const more = block.querySelector('k-connection-more') ?? document.createElement('k-connection-more');
    if (cards.nextElementSibling !== more) cards.after(more);
    // The disclosure remembers where it was left (settings load before APP_READY re-seats this).
    setStockPanelOpen(Boolean(/** @type {any} */ (power_user)[STOCK_OPEN_KEY]), false);
}
