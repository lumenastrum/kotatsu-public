/*
 * <k-model-menu> — the top bar's model pill, grown into a compact picker
 * (rails v0, smoke follow-up 2026-08-25; design canvas "Kotatsu Model Picker").
 *
 * The pill was the last inert promise in the top bar. It is now the trigger for
 * a popover that does exactly the two switches a session makes constantly —
 * connection profile and model — and defers everything deeper to the real API
 * drawer. No wizard is duplicated in a popover; nothing rendered here is dead.
 *
 * MIRRORS, NEVER A SECOND SOURCE OF TRUTH. Every list this menu shows and every
 * change it makes goes through DOM core (or the Connection Manager extension)
 * already owns:
 *
 *   - Profiles are read from `extension_settings.connectionManager.profiles`
 *     and APPLIED by setting `#connection_profiles` and dispatching a native
 *     `change` — which runs the extension's own handler
 *     (scripts/extensions/connection-manager/index.js:723-753): persistence,
 *     `applyConnectionProfile()`, and the `CONNECTION_PROFILE_LOADED` emit all
 *     happen exactly as if the drawer's select had been used. A hidden select
 *     still runs its listeners, so the parked rack needs no reveal.
 *   - Models are read from the ACTIVE API's own `#model_<api>_select` options
 *     and applied the same way — value + native `change`, straight into core's
 *     `onModelChange`. APIs whose model choice is not a static select (textgen
 *     types, kobold) simply do not get a model section; the picker never
 *     invents a list core does not have.
 *   - "Save current as profile" clicks `#create_connection_profile`, so the
 *     extension's naming popup and settings writes stay its own.
 *   - The footer opens the settings modal ON its Connection tab
 *     (`openSettings({ tab: 'connection' })`), which adopts `#rm_api_block`
 *     whole. Until settings v0.1 this was two moves — reveal the parked drawer
 *     rack behind a scrim, then synthesize a click on `#sys-settings-button`'s
 *     `.drawer-toggle` — because connection settings were not part of the
 *     modal's tabs. They are now, so the reveal retired and the click with it.
 *
 * Everything degrades by absence: no Connection Manager → no profiles section,
 * no mirror select → no model section, nothing at all → the footer alone still
 * reaches the wizard. The pill itself keeps slice E's job: status dot,
 * provider, model, truthfully or as an em-dash.
 *
 * Light DOM like <k-topbar>, and for the same three reasons (shell-topbar.css
 * reaches in, the layout gate holds, initDynamicStyles can audit the pairs).
 *
 * One-way imports: kotatsu → core only.
 */

import { LitElement, html, nothing } from '../lit.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { getGeneratingApi, getGeneratingModel, online_status } from '../../../script.js';
import { extension_settings } from '../../../scripts/extensions.js';
import { openSettings } from '../../settings/k-settings-modal.js';

/** Sentinel `setOnlineStatus()` (script.js:7126) writes when nothing is connected. */
const NO_CONNECTION = 'no_connection';

/** Placeholder for anything core has not told us yet. */
const EM_DASH = '—';

/** The popover's DOM id, for `aria-controls`. */
const POP_ID = 'k-model-menu-pop';

/**
 * Selects whose `<option>` labels are core's own human names for an API id —
 * the same list, in the same order, as <k-topbar> used before the pill moved
 * here. Read by VALUE, never by index; falls back to the raw id.
 */
const PROVIDER_LABEL_SELECTS = ['#chat_completion_source', '#textgen_type', '#main_api'];

/**
 * Events that mean "connection, model, or profile list may have moved".
 * Looked up by key and skipped when absent, so an upstream rename degrades to
 * one dead listener instead of a boot crash.
 */
const REFRESH_EVENTS = [
    'APP_READY',
    'SETTINGS_LOADED_AFTER',
    'SETTINGS_UPDATED',
    'ONLINE_STATUS_CHANGED',
    'CHATCOMPLETION_SOURCE_CHANGED',
    'CHATCOMPLETION_MODEL_CHANGED',
    'OAI_PRESET_CHANGED_AFTER',
    'PRESET_CHANGED',
    'CONNECTION_PROFILE_LOADED',
    'CONNECTION_PROFILE_CREATED',
    'CONNECTION_PROFILE_UPDATED',
    'CONNECTION_PROFILE_DELETED',
];

/** How long an apply may spin before the menu stops claiming progress. */
const APPLY_TIMEOUT_MS = 12000;

/**
 * Core's human label for an API id, from the selects core already renders.
 * @param {string} id API id in `getGeneratingApi()` shape.
 * @returns {string} Display label, or the raw id when no select knows it.
 */
function labelForApi(id) {
    for (const selector of PROVIDER_LABEL_SELECTS) {
        const select = /** @type {HTMLSelectElement | null} */ (document.querySelector(selector));
        if (!select || !select.options) {
            continue;
        }
        const option = Array.from(select.options).find((o) => o.value === id);
        const text = option && option.textContent ? option.textContent.trim() : '';
        if (text) {
            return text;
        }
    }
    return id;
}

/**
 * The Connection Manager's profile select, or null when the extension is not
 * installed/enabled. Its presence IS the feature test for the profiles section.
 * @returns {HTMLSelectElement | null}
 */
function profileSelect() {
    const node = document.getElementById('connection_profiles');
    return node instanceof HTMLSelectElement ? node : null;
}

/**
 * The active API's own model select, or null when this API has none (textgen
 * types and kobold pick models elsewhere — that is the drawer's business).
 * @param {string} api API id in `getGeneratingApi()` shape.
 * @returns {HTMLSelectElement | null}
 */
function modelSelect(api) {
    if (!api || !/^[a-z0-9_]+$/.test(api)) {
        return null;
    }
    const node = document.getElementById(`model_${api}_select`);
    return node instanceof HTMLSelectElement ? node : null;
}

/**
 * Sets a select's value and runs its owner's listeners, exactly as a user
 * change would. Native `change` bubbles reach both addEventListener handlers
 * (the Connection Manager) and jQuery's direct bindings (core's onModelChange).
 * @param {HTMLSelectElement} select
 * @param {string} value
 * @returns {void}
 */
function commitSelect(select, value) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * @returns {unknown} Check glyph — selection marker.
 */
function checkIcon() {
    return html`
        <svg class="k-mm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <path d="M2.8 8.6 6.3 12l6.9-8"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Plus glyph — the save-as-profile row.
 */
function plusIcon() {
    return html`
        <svg class="k-mm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M8 3.2v9.6M3.2 8h9.6"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Magnifier glyph — the filter field.
 */
function filterIcon() {
    return html`
        <svg class="k-mm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.2"></circle>
            <path d="m13.4 13.4-3.3-3.3"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Sliders glyph — the wizard footer.
 */
function slidersIcon() {
    return html`
        <svg class="k-mm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"></path>
            <circle cx="10.5" cy="4.5" r="1.6"></circle>
            <circle cx="5.5" cy="11.5" r="1.6"></circle>
        </svg>
    `;
}

/**
 * @returns {unknown} Chevron glyph — the wizard footer's trailing arrow.
 */
function chevronIcon() {
    return html`
        <svg class="k-mm__glyph k-mm__glyph--chevron" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m6 3 5 5-5 5"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Spinner glyph — an apply in flight.
 */
function spinnerIcon() {
    return html`
        <svg class="k-mm__glyph k-mm__spinner" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
            aria-hidden="true" focusable="false">
            <path d="M8 1.8a6.2 6.2 0 1 1-6.2 6.2"></path>
        </svg>
    `;
}

/**
 * The model pill and its picker popover.
 */
export class KModelMenu extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _status: { state: true },
        _provider: { state: true },
        _model: { state: true },
        _open: { state: true },
        _query: { state: true },
        _applyingId: { state: true },
    };

    constructor() {
        super();
        /** @type {string} Theme-pack variant hook (SPEC §13). v0 ships one: `popover`. */
        this.variant = 'popover';
        /** @type {string} Last known `online_status`. */
        this._status = NO_CONNECTION;
        /** @type {string} Human provider label. */
        this._provider = '';
        /** @type {string} Model id as core reports it. */
        this._model = '';
        /** @type {boolean} Whether the popover is up. */
        this._open = false;
        /** @type {string} Live model filter text. */
        this._query = '';
        /** @type {string | null} Profile id currently being applied, for the spinner. */
        this._applyingId = null;
        /** @type {number} Timeout handle that stops a stuck apply from spinning forever. */
        this._applyTimer = 0;
        /** @type {() => void} */
        this._onCoreChange = () => this.refresh();
        /** @type {() => void} Clears the apply spinner when the extension reports done. */
        this._onProfileLoaded = () => this._settleApply();
        /** @type {(event: PointerEvent) => void} */
        this._onOutsidePointer = (event) => {
            if (this._open && event.target instanceof Node && !this.contains(event.target)) {
                this._close({ restoreFocus: false });
            }
        };
        /** @type {string[]} Event names actually bound, for symmetric teardown. */
        this._boundEvents = [];
    }

    /**
     * Light DOM — see the file header.
     * @returns {*} This element, used as the render root.
     */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        for (const key of REFRESH_EVENTS) {
            const name = event_types ? event_types[key] : undefined;
            if (typeof name !== 'string' || this._boundEvents.includes(name)) {
                continue;
            }
            eventSource.on(name, this._onCoreChange);
            this._boundEvents.push(name);
        }
        const loaded = event_types ? event_types.CONNECTION_PROFILE_LOADED : undefined;
        if (typeof loaded === 'string') {
            eventSource.on(loaded, this._onProfileLoaded);
        }
        document.addEventListener('pointerdown', this._onOutsidePointer);
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this._boundEvents) {
            eventSource.removeListener(name, this._onCoreChange);
        }
        this._boundEvents = [];
        const loaded = event_types ? event_types.CONNECTION_PROFILE_LOADED : undefined;
        if (typeof loaded === 'string') {
            eventSource.removeListener(loaded, this._onProfileLoaded);
        }
        document.removeEventListener('pointerdown', this._onOutsidePointer);
        if (this._applyTimer) {
            clearTimeout(this._applyTimer);
            this._applyTimer = 0;
        }
        super.disconnectedCallback();
    }

    /**
     * Re-reads connection state from core. Never throws — same contract as the
     * bar it lives in.
     */
    refresh() {
        this._status = typeof online_status === 'string' ? online_status : NO_CONNECTION;
        let api = '';
        try {
            const value = getGeneratingApi();
            api = typeof value === 'string' ? value : '';
        } catch {
            api = '';
        }
        this._provider = api ? labelForApi(api) : '';
        let model = '';
        try {
            const value = getGeneratingModel();
            model = typeof value === 'string' ? value.trim() : '';
        } catch {
            model = '';
        }
        // kobold/textgen report the model THROUGH online_status, so the sentinel leaks in.
        this._model = model === NO_CONNECTION ? '' : model;
        // Lists are rebuilt from their mirrors on every render; a state write is
        // all a core event needs to reach them.
        this.requestUpdate();
    }

    /**
     * @returns {boolean} True when core reports any connection at all.
     */
    get _connected() {
        return Boolean(this._status) && this._status !== NO_CONNECTION;
    }

    /**
     * The profiles the Connection Manager knows, newest shape tolerated loosely:
     * anything without an id cannot be applied and is skipped.
     * @returns {Array<{ id: string, name: string, micro: string }>}
     */
    get _profiles() {
        const manager = extension_settings ? extension_settings.connectionManager : null;
        const raw = manager && Array.isArray(manager.profiles) ? manager.profiles : [];
        return raw
            .filter((p) => p && typeof p.id === 'string' && p.id)
            .map((p) => ({
                id: p.id,
                name: typeof p.name === 'string' && p.name ? p.name : p.id,
                micro: [p.api, p.model, p.preset]
                    .filter((part) => typeof part === 'string' && part)
                    .join(' · '),
            }));
    }

    /**
     * @returns {string | null} The selected profile id, per the extension.
     */
    get _selectedProfileId() {
        const manager = extension_settings ? extension_settings.connectionManager : null;
        const id = manager ? manager.selectedProfile : null;
        return typeof id === 'string' && id ? id : null;
    }

    /**
     * The active API's model options, filtered by the live query. Empty when
     * this API keeps its models somewhere a static select is not.
     * @returns {{ api: string, models: Array<{ value: string, selected: boolean }> }}
     */
    get _modelList() {
        let api = '';
        try {
            const value = getGeneratingApi();
            api = typeof value === 'string' ? value : '';
        } catch {
            api = '';
        }
        const select = modelSelect(api);
        if (!select) {
            return { api, models: [] };
        }
        const query = this._query.trim().toLowerCase();
        const models = Array.from(select.options)
            .filter((o) => typeof o.value === 'string' && o.value)
            .filter((o) => !query || o.value.toLowerCase().includes(query))
            .map((o) => ({ value: o.value, selected: o.value === select.value }));
        return { api, models };
    }

    /**
     * Opens or closes the popover from the pill.
     * @returns {void}
     */
    _toggle() {
        if (this._open) {
            this._close({ restoreFocus: true });
        } else {
            this._query = '';
            this._open = true;
        }
    }

    /**
     * @param {{ restoreFocus: boolean }} options Whether the pill takes focus back.
     * @returns {void}
     */
    _close({ restoreFocus }) {
        if (!this._open) {
            return;
        }
        const active = document.activeElement;
        const focusWasInside = active instanceof HTMLElement && this.contains(active);
        this._open = false;
        if (restoreFocus || focusWasInside) {
            const pill = this.querySelector('.k-mm__trigger');
            if (pill instanceof HTMLElement) {
                pill.focus({ preventScroll: true });
            }
        }
    }

    /**
     * Escape closes the popover before core's document-level cascade can read
     * the key as meaning anything else; every other key passes through.
     * @param {KeyboardEvent} event
     * @returns {void}
     */
    _onKeyDown(event) {
        if (event.key !== 'Escape' || !this._open) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this._close({ restoreFocus: true });
    }

    /**
     * Applies a profile through the extension's own select. The spinner runs
     * until `CONNECTION_PROFILE_LOADED` lands or the timeout gives up claiming
     * progress — an apply is a chain of slash commands and can take a moment.
     * @param {string} id Profile id.
     * @returns {void}
     */
    _applyProfile(id) {
        if (this._applyingId) {
            return;
        }
        const select = profileSelect();
        if (!select) {
            return;
        }
        if (this._selectedProfileId === id) {
            return;
        }
        this._applyingId = id;
        if (this._applyTimer) {
            clearTimeout(this._applyTimer);
        }
        this._applyTimer = window.setTimeout(() => this._settleApply(), APPLY_TIMEOUT_MS);
        commitSelect(select, id);
    }

    /**
     * Clears the in-flight marker; state re-reads from the mirrors either way.
     * @returns {void}
     */
    _settleApply() {
        if (this._applyTimer) {
            clearTimeout(this._applyTimer);
            this._applyTimer = 0;
        }
        if (this._applyingId !== null) {
            this._applyingId = null;
        }
        this.refresh();
    }

    /**
     * Selects a model on the current API, through core's own select.
     * @param {string} value Model id.
     * @returns {void}
     */
    _applyModel(value) {
        let api = '';
        try {
            api = getGeneratingApi();
        } catch {
            return;
        }
        const select = modelSelect(api);
        if (!select || select.value === value) {
            return;
        }
        commitSelect(select, value);
        this.refresh();
    }

    /**
     * Hands profile creation to the extension's own button — its naming popup
     * and settings writes stay its own. The popover closes first so the popup
     * is not fighting a floating surface for focus.
     * @returns {void}
     */
    _saveCurrent() {
        const button = document.getElementById('create_connection_profile');
        if (!(button instanceof HTMLElement)) {
            return;
        }
        this._close({ restoreFocus: false });
        button.click();
    }

    /**
     * The escape hatch: the settings modal, on its Connection tab.
     *
     * One call now. The old route revealed the parked drawer rack and then
     * synthesized a `.drawer-toggle` click so core's `doNavbarIconClick`
     * (script.js:11285-11287) would open `#rm_api_block` by DOM relationship —
     * two surfaces and a click into furniture, because the API drawer had no
     * home in the modal. Settings v0.1 gave it one: the Connection tab adopts
     * `#rm_api_block` whole, so asking for the tab IS asking for the drawer.
     *
     * The overlay's two-Escape behaviour goes with it (settings-v0.md §8.3,
     * §9 trap 4). The modal's window-capture Escape governs from here: one
     * press, one surface.
     * @returns {void}
     */
    _openWizard() {
        this._close({ restoreFocus: false });
        openSettings({ tab: 'connection' });
    }

    render() {
        const connected = this._connected;
        const provider = this._provider || EM_DASH;
        const model = this._model || EM_DASH;
        const state = connected ? 'Connected' : 'Not connected';
        return html`
            <button type="button" class="k-pill k-pill--model k-mm__trigger"
                title="${state} · ${provider} · ${model}"
                aria-haspopup="true" aria-expanded=${this._open ? 'true' : 'false'}
                aria-controls="${POP_ID}"
                @click=${() => this._toggle()} @keydown=${this._onKeyDown}>
                <span class="k-pill__dot" data-online=${connected ? 'yes' : 'no'}
                    aria-hidden="true"></span>
                <span class="k-pill__provider">${provider}</span>
                <span class="k-pill__model">${model}</span>
            </button>
            ${this._open ? this._renderPopover() : nothing}
        `;
    }

    /**
     * @returns {unknown} The popover.
     */
    _renderPopover() {
        return html`
            <div id="${POP_ID}" class="k-mm__pop" role="group" aria-label="Model and connection"
                @keydown=${this._onKeyDown}>
                ${this._connected ? nothing : html`
                    <div class="k-mm__banner">
                        <svg class="k-mm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
                            aria-hidden="true" focusable="false">
                            <path d="M8 5.5v3.5M8 11.4v.1"></path>
                            <circle cx="8" cy="8" r="6.2"></circle>
                        </svg>
                        <span>Not connected — pick a profile or open setup</span>
                    </div>
                `}
                ${this._renderProfiles()}
                ${this._renderModels()}
                <div class="k-mm__divider" role="presentation"></div>
                <button type="button" class="k-mm__foot" @click=${() => this._openWizard()}>
                    ${slidersIcon()}
                    <span class="k-mm__foot-label">Open connection setup</span>
                    ${chevronIcon()}
                </button>
            </div>
        `;
    }

    /**
     * The profiles section — absent entirely when the Connection Manager is,
     * empty-state copy when it is present with nothing saved.
     * @returns {unknown}
     */
    _renderProfiles() {
        if (!profileSelect()) {
            return nothing;
        }
        const profiles = this._profiles;
        const selectedId = this._selectedProfileId;
        const applyingId = this._applyingId;
        const canSave = document.getElementById('create_connection_profile') !== null;
        return html`
            <div class="k-mm__label">Connection profiles</div>
            ${profiles.length === 0 ? html`
                <div class="k-mm__empty">Nothing saved yet. A profile bundles API, model and preset into one click.</div>
            ` : profiles.map((profile) => {
        const isApplying = applyingId === profile.id;
        const isSelected = applyingId === null && profile.id === selectedId;
        return html`
                    <button type="button"
                        class="k-mm__row ${isSelected || isApplying ? 'k-mm--selected' : ''} ${applyingId !== null && !isApplying ? 'k-mm--dimmed' : ''}"
                        aria-pressed=${isSelected ? 'true' : 'false'}
                        @click=${() => this._applyProfile(profile.id)}>
                        <span class="k-mm__mark">${isApplying ? spinnerIcon() : (isSelected ? checkIcon() : nothing)}</span>
                        <span class="k-mm__copy">
                            <span class="k-mm__name">${profile.name}</span>
                            <span class="k-mm__micro">${isApplying ? 'Applying — switching API and preset…' : (profile.micro || EM_DASH)}</span>
                        </span>
                    </button>
                `;
    })}
            ${canSave ? html`
                <button type="button" class="k-mm__row k-mm__row--quiet" @click=${() => this._saveCurrent()}>
                    <span class="k-mm__mark">${plusIcon()}</span>
                    <span class="k-mm__copy"><span class="k-mm__name k-mm__name--quiet">Save current as profile</span></span>
                </button>
            ` : nothing}
        `;
    }

    /**
     * The model section — only when the active API mirrors its models into a
     * select this menu can honestly re-present.
     * @returns {unknown}
     */
    _renderModels() {
        const { api, models } = this._modelList;
        const hasMirror = modelSelect(api) !== null;
        if (!hasMirror) {
            return nothing;
        }
        const hasProfiles = profileSelect() !== null;
        return html`
            ${hasProfiles ? html`<div class="k-mm__divider" role="presentation"></div>` : nothing}
            <div class="k-mm__label k-mm__label--split">
                <span>Model</span>
                <span class="k-mm__label-api">${labelForApi(api)}</span>
            </div>
            <div class="k-mm__filter">
                ${filterIcon()}
                <input type="text" class="k-mm__filter-input" placeholder="Filter models…"
                    aria-label="Filter models" .value=${this._query}
                    @input=${(/** @type {InputEvent} */ event) => {
        const target = event.target;
        this._query = target instanceof HTMLInputElement ? target.value : '';
    }}>
            </div>
            <div class="k-mm__models">
                ${models.length === 0 ? html`
                    <div class="k-mm__empty">${this._query ? 'No models match.' : 'No models listed for this API.'}</div>
                ` : models.map((entry) => html`
                    <button type="button" class="k-mm__mrow ${entry.selected ? 'k-mm--selected' : ''}"
                        aria-pressed=${entry.selected ? 'true' : 'false'}
                        @click=${() => this._applyModel(entry.value)}>
                        <span class="k-mm__mark">${entry.selected ? checkIcon() : nothing}</span>
                        <span class="k-mm__mname">${entry.value}</span>
                    </button>
                `)}
            </div>
        `;
    }
}

if (!customElements.get('k-model-menu')) {
    customElements.define('k-model-menu', KModelMenu);
}
