/**
 * `<k-pictures-settings variant="panel">` — Settings → Pictures (docs/pictures-v0.md §9).
 *
 * Drawn by the settings modal (`#renderNative`, control kind `kotatsu-pictures`); owns the whole
 * `power_user.kotatsu_pictures` leaf through `settings.js` and nothing else. Lane switch; the
 * ComfyUI address with Check, its recipes and their model slots, a default recipe per purpose;
 * the two key lanes' choices with one privacy line each; the chat behaviour switches.
 *
 * Talks to slice A's routes (`API_BASE`: `POST /check`, `GET /recipes`, `POST /recipes/:id/slots`)
 * and says honestly when they don't answer. The last Check result is kept for the session at
 * module scope, so the slot dropdowns stay filled across tab switches and a reopened modal.
 *
 * Light DOM (`css/pictures-settings.css`, `k-pics__*` classes and `--k-pics-*` knobs). Plain
 * `<select>` and `<input>` on purpose: inside `.k-set-control` the modal's own field rules dress
 * them like every other row. `variant` per SPEC §13 (v0 has one: "panel").
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { getRequestHeaders } from '../../script.js';
import { API_BASE, LANES, PURPOSES, TONGUES } from './contract.js';
import { getPicturesSettings, onPicturesSettingsChanged, updatePicturesSettings } from './settings.js';
import { listModels } from './jobs-client.js';
import { modelRows, setupSteps, sizeLabel } from './picture-model.js';
import {
    GEMINI_ASPECTS,
    GEMINI_MODELS,
    GEMINI_SIZES,
    LANE_OPTIONS,
    OPENAI_MODELS,
    OPENAI_QUALITIES,
    OPENAI_SIZES,
    PRICES_READ,
    PRICING_URLS,
    PRIVACY_LINES,
    PURPOSE_LABELS,
    describeCheck,
    describeHttpFailure,
    modelsForSlot,
    priceLine,
    serverKey,
} from './settings-model.js';

/** @typedef {import('./contract.js').Recipe} Recipe */

/** House icon recipe: viewBox 24, stroke currentColor, 1.5. */
const svgIcon = (/** @type {unknown} */ paths) => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const icons = {
    check: svgIcon(svg`<path d="m5 12.5 4.5 4.5L19 7.5"></path>`),
    warning: svgIcon(svg`<path d="M12 4 2.8 19.5h18.4L12 4Z"></path><path d="M12 10v4.2M12 17h.01"></path>`),
    lock: svgIcon(svg`<rect x="5" y="10.5" width="14" height="9.5" rx="2"></rect><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"></path>`),
};

/**
 * The last Check, for the session. `url` is the address it checked, so a changed address reads as
 * unchecked rather than wearing another server's models.
 * @type {{ state: 'idle'|'checking'|'ok'|'error', url: string, result?: any, message?: string }}
 */
let lastCheck = { state: 'idle', url: '' };

/**
 * @param {Response} response
 * @returns {Promise<any>} The parsed body, or null.
 */
async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

export class KPicturesSettings extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _settings: { state: true },
        _check: { state: true },
        _recipes: { state: true },
        _slotSaving: { state: true },
        _models: { state: true },
    };

    constructor() {
        super();
        this.variant = 'panel';
        this._settings = getPicturesSettings();
        this._check = lastCheck;
        /** @type {{ state: 'idle'|'loading'|'ok'|'error', list: Recipe[], message: string }} */
        this._recipes = { state: 'idle', list: [], message: '' };
        /** @type {string} `recipeId/slot` while that slot's save is in flight. */
        this._slotSaving = '';
        /** @type {{ state: 'idle'|'loading'|'ok'|'error', list: import('./picture-model.js').ModelInfo[], families: Record<string, import('./picture-model.js').FamilyInfo>, message: string, onlyUnset: boolean, setup: Record<string, import('./picture-model.js').FileNeed[]>, extras: import('./picture-model.js').FileNeed[], install: Record<string, string> }} */
        this._models = { state: 'idle', list: [], families: {}, message: '', onlyUnset: false, setup: {}, extras: [], install: {} };
        this._unsubscribe = () => { };
        /** @type {IntersectionObserver|null} */
        this._observer = null;
        /** Whether the panel has been on screen yet (recipes load then, not before). */
        this._seen = false;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        this._unsubscribe = onPicturesSettingsChanged((settings) => {
            this._settings = settings;
        });
        this._settings = getPicturesSettings();
        // The modal renders every tab's panel on each pass (hidden ones too), so the recipes
        // are asked for the first time the panel is actually on screen, not on every open.
        if (typeof IntersectionObserver === 'function') {
            this._observer = new IntersectionObserver((entries) => {
                if (!entries.some(entry => entry.isIntersecting)) return;
                this._observer?.disconnect();
                this._observer = null;
                this.#onFirstSeen();
            });
            this._observer.observe(this);
        } else {
            this.#onFirstSeen();
        }
    }

    disconnectedCallback() {
        this._observer?.disconnect();
        this._observer = null;
        this._unsubscribe();
        super.disconnectedCallback();
    }

    #onFirstSeen() {
        this._seen = true;
        if (this._settings.lane === LANES.COMFY && this._recipes.state === 'idle') void this.#loadRecipes();
        if (this._settings.lane === LANES.COMFY && this._models.state === 'idle') void this.#loadModels();
    }

    /* ── doors ──────────────────────────────────────────────────────────────── */

    /** @param {Record<string, any>} patch */
    #update(patch) {
        this._settings = updatePicturesSettings(patch);
    }

    /** @param {string} lane */
    #chooseLane(lane) {
        if (lane === this._settings.lane) return;
        this.#update({ lane });
        if (lane === LANES.COMFY && this._seen && this._recipes.state === 'idle') void this.#loadRecipes();
    }

    /** Reads the two address fields straight off the DOM (they commit on change). */
    #readAddress() {
        const url = this.querySelector('[data-k-pics="comfy-url"]');
        const auth = this.querySelector('[data-k-pics="comfy-auth"]');
        return {
            url: url instanceof HTMLInputElement ? url.value.trim() : this._settings.comfy.url,
            auth: auth instanceof HTMLInputElement ? auth.value : this._settings.comfy.auth,
        };
    }

    /** @param {Event} event */
    #commitUrl(event) {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const url = input.value.trim();
        if (url === this._settings.comfy.url) return;
        this.#update({ comfy: { url } });
    }

    /** @param {Event} event */
    #commitAuth(event) {
        const input = /** @type {HTMLInputElement} */ (event.target);
        if (input.value === this._settings.comfy.auth) return;
        this.#update({ comfy: { auth: input.value } });
    }

    /** Asks slice A's `/check` about the address in the field. */
    async #runCheck() {
        const { url, auth } = this.#readAddress();
        if (url !== this._settings.comfy.url || auth !== this._settings.comfy.auth) {
            this.#update({ comfy: { url, auth } });
        }
        lastCheck = { state: 'checking', url };
        this._check = lastCheck;
        try {
            const response = await fetch(`${API_BASE}/check`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(auth ? { url, auth } : { url }),
            });
            const body = await readJson(response);
            if (!response.ok || !body || body.ok === false) {
                lastCheck = { state: 'error', url, message: describeHttpFailure(response.status, body) };
            } else {
                lastCheck = { state: 'ok', url, result: body };
            }
        } catch (error) {
            lastCheck = { state: 'error', url, message: error instanceof Error ? error.message : String(error) };
        }
        this._check = lastCheck;
        if (lastCheck.state === 'ok') {
            void this.#loadRecipes();
            void this.#loadModels({ fresh: true });
        }
    }

    async #loadRecipes() {
        this._recipes = { ...this._recipes, state: 'loading', message: '' };
        try {
            const response = await fetch(`${API_BASE}/recipes`, { headers: getRequestHeaders() });
            const body = await readJson(response);
            if (!response.ok || !body || !Array.isArray(body.recipes)) {
                this._recipes = { state: 'error', list: [], message: describeHttpFailure(response.status, body) };
                return;
            }
            this._recipes = { state: 'ok', list: body.recipes, message: '' };
        } catch (error) {
            this._recipes = { state: 'error', list: [], message: error instanceof Error ? error.message : String(error) };
        }
    }

    /** @param {{fresh?: boolean}} [options] */
    async #loadModels({ fresh = false } = {}) {
        this._models = { ...this._models, state: 'loading', message: '' };
        const { url, auth } = this._settings.comfy;
        try {
            const answer = await listModels(auth ? { url, auth } : { url }, { fresh });
            if (!answer?.ok) {
                this._models = { ...this._models, state: 'error', list: [], message: answer?.message || 'The picture server did not list its models.' };
                return;
            }
            this._models = { ...this._models, state: 'ok', list: answer.models ?? [], families: answer.families ?? {}, message: '', setup: answer.setup ?? {}, extras: answer.extras ?? [], install: answer.install ?? {} };
        } catch (error) {
            this._models = { ...this._models, state: 'error', list: [], message: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * Sets a model up (or un-sets it with null) for this server.
     * @param {string} file
     * @param {{family: string, preset: string}|null} record
     */
    #setModel(file, record) {
        const server = serverKey(this._settings.comfy.url);
        this.#update({ models: { [server]: { [file]: record } } });
    }

    /** Confirms every suggestion still waiting, in one save. */
    #confirmSuggestions() {
        const server = serverKey(this._settings.comfy.url);
        const rows = modelRows(this._models.list, this._settings.models?.[server], this._models.families);
        /** @type {Record<string, {family: string, preset: string}>} */
        const patch = {};
        for (const row of rows) {
            if (row.state === 'suggested' && row.suggestion.family && row.suggestion.preset) patch[row.file] = { family: row.suggestion.family, preset: row.suggestion.preset };
        }
        if (Object.keys(patch).length) this.#update({ models: { [server]: patch } });
    }

    /**
     * Saves one slot choice on the server (per recipe per server) and mirrors it in settings.
     * @param {Recipe} recipe
     * @param {string} slot
     * @param {string} filename
     */
    async #chooseSlot(recipe, slot, filename) {
        const server = serverKey(this._settings.comfy.url);
        this.#update({ slotChoices: { [server]: { [recipe.id]: { [slot]: filename } } } });
        this._slotSaving = `${recipe.id}/${slot}`;
        try {
            const response = await fetch(`${API_BASE}/recipes/${encodeURIComponent(recipe.id)}/slots`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ server, choices: { [slot]: filename } }),
            });
            const body = await readJson(response);
            if (response.ok && body && typeof body === 'object' && body.id) {
                this._recipes = { ...this._recipes, list: this._recipes.list.map(item => (item.id === body.id ? body : item)) };
            } else if (!response.ok) {
                console.warn(`[Pictures] the slot choice was kept here but the server said: ${describeHttpFailure(response.status, body)}`);
            }
        } catch (error) {
            console.warn('[Pictures] the slot choice was kept here but could not reach the server', error);
        } finally {
            this._slotSaving = '';
        }
    }

    /* ── render ─────────────────────────────────────────────────────────────── */

    render() {
        const settings = this._settings;
        const lane = LANE_OPTIONS.find(option => option.id === settings.lane) ?? LANE_OPTIONS[0];
        return html`
            <div class="k-pics" data-k-pics-lane=${lane.id}>
                <section class="k-pics__group" aria-labelledby="k-pics-lane-head">
                    <h4 class="k-pics__head" id="k-pics-lane-head">Where pictures are drawn</h4>
                    <div class="k-pics__seg" role="radiogroup" aria-labelledby="k-pics-lane-head">
                        ${LANE_OPTIONS.map(option => html`
                            <button type="button" class="k-pics__seg-option" role="radio"
                                data-k-pics-lane-option=${option.id}
                                aria-checked=${option.id === lane.id ? 'true' : 'false'}
                                @click=${() => this.#chooseLane(option.id)}>${option.label}</button>`)}
                    </div>
                    <p class="k-pics__hint">${lane.hint}</p>
                </section>
                ${lane.id === LANES.COMFY ? this.#renderComfy() : nothing}
                ${lane.id === LANES.OPENAI ? this.#renderOpenAI() : nothing}
                ${lane.id === LANES.GEMINI ? this.#renderGemini() : nothing}
                ${this.#renderBehaviour()}
            </div>`;
    }

    #renderComfy() {
        const settings = this._settings;
        const check = this._check.url && serverKey(this._check.url) !== serverKey(settings.comfy.url) && this._check.state !== 'checking'
            ? { state: /** @type {'idle'} */ ('idle'), url: '' }
            : this._check;
        const said = describeCheck(check);
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-comfy-head">
                <h4 class="k-pics__head" id="k-pics-comfy-head">ComfyUI</h4>
                <div class="k-pics__field">
                    <label class="k-pics__label" for="k-pics-comfy-url">Address</label>
                    <input id="k-pics-comfy-url" class="k-pics__input text_pole" type="text" inputmode="url" spellcheck="false"
                        autocomplete="off" data-k-pics="comfy-url" placeholder="http://127.0.0.1:8188"
                        .value=${settings.comfy.url} @change=${(/** @type {Event} */ e) => this.#commitUrl(e)}>
                    <button type="button" class="k-pics__button" data-k-pics="check"
                        ?disabled=${check.state === 'checking'} @click=${() => this.#runCheck()}>Check</button>
                </div>
                <div class="k-pics__field">
                    <label class="k-pics__label" for="k-pics-comfy-auth">Sign-in</label>
                    <input id="k-pics-comfy-auth" class="k-pics__input text_pole" type="password" spellcheck="false"
                        autocomplete="off" data-k-pics="comfy-auth" placeholder="Only if your ComfyUI asks for one"
                        .value=${settings.comfy.auth} @change=${(/** @type {Event} */ e) => this.#commitAuth(e)}>
                </div>
                <div class="k-pics__result" data-k-pics="check-result" data-tone=${said.tone} role="status" aria-live="polite">
                    ${said.tone === 'ok' ? icons.check : said.tone === 'error' ? icons.warning : nothing}
                    <div class="k-pics__result-text">
                        <p class="k-pics__result-lead">${said.lead}</p>
                        ${said.detail ? html`<p class="k-pics__result-detail">${said.detail}</p>` : nothing}
                    </div>
                </div>
            </section>
            ${this.#renderSetup()}
            ${this.#renderModels()}
            ${this.#renderRecipes(check)}
            ${this.#renderDefaults()}`;
    }

    /**
     * Settings → Pictures → Models (§14.5): every model file the server has, what Kotatsu thinks it
     * is, and the person's word on it. Only confirmed models are offered in the sheet.
     */
    /**
     * "Setting up local pictures" (§14.6): three steps that tick themselves from what the server
     * says, with ComfyUI's own download pages and, per family, the files still missing.
     */
    #renderSetup() {
        const models = this._models;
        const server = serverKey(this._settings.comfy.url);
        const confirmed = Object.values(this._settings.models?.[server] ?? {}).filter(Boolean).length;
        const reachable = models.state === 'ok';
        const steps = setupSteps({ reachable, setup: models.setup, confirmed });
        if (models.state === 'loading' || models.state === 'idle' || steps.every(s => s.done)) return nothing;
        const done = (/** @type {string} */ id) => steps.find(s => s.id === id)?.done;
        const install = { desktop: 'https://comfy.org/download', desktopDocs: 'https://docs.comfy.org/installation/desktop/windows', ...models.install };
        const tick = (/** @type {boolean|undefined} */ ok) => (ok ? icons.check : html`<span class="k-pics__step-dot" aria-hidden="true"></span>`);
        return html`
            <section class="k-pics__group k-pics__setup" aria-labelledby="k-pics-setup-head" data-k-pics="setup">
                <h4 class="k-pics__head" id="k-pics-setup-head">Setting up local pictures</h4>
                <ol class="k-pics__steps">
                    <li class="k-pics__step" data-done=${done('install') ? 'yes' : 'no'}>
                        ${tick(done('install'))}
                        <div>
                            <p class="k-pics__step-lead">Install ComfyUI and start it</p>
                            ${done('install') ? html`<p class="k-pics__hint">ComfyUI answers at ${this._settings.comfy.url}.</p>` : html`
                                <p class="k-pics__hint">ComfyUI draws the pictures on your own computer. Get <a href=${install.desktop} target="_blank" rel="noopener noreferrer">ComfyUI Desktop</a> (<a href=${install.desktopDocs} target="_blank" rel="noopener noreferrer">install guide</a>), start it, then press Check above. It usually answers at http://127.0.0.1:8188.</p>
                                <p class="k-pics__hint">No GPU for it? An OpenAI or Google key draws too: switch the lane above.</p>`}
                        </div>
                    </li>
                    <li class="k-pics__step" data-done=${done('files') ? 'yes' : 'no'}>
                        ${tick(done('files'))}
                        <div>
                            <p class="k-pics__step-lead">Get a model family's files</p>
                            ${reachable && !done('files') ? this.#renderFamilyNeeds() : nothing}
                        </div>
                    </li>
                    <li class="k-pics__step" data-done=${done('confirm') ? 'yes' : 'no'}>
                        ${tick(done('confirm'))}
                        <div>
                            <p class="k-pics__step-lead">Set up your models below</p>
                            ${reachable && !done('confirm') ? html`<p class="k-pics__hint">Confirm what Kotatsu suggests for each model; the sheet offers the ones you confirm.</p>` : nothing}
                        </div>
                    </li>
                </ol>
            </section>`;
    }

    /** Per family: the files still missing, each with its folder, size and download. */
    #renderFamilyNeeds() {
        const models = this._models;
        const fileRow = (/** @type {import('./picture-model.js').FileNeed} */ need) => html`
            <li class="k-pics__need" data-k-pics-need=${need.file} data-present=${need.present ? 'yes' : 'no'}>
                <span class="k-pics__need-file">${need.present ? icons.check : nothing}${need.file}</span>
                <span class="k-pics__hint">${need.role}${need.source ? html` · ${need.source.folder} · ${sizeLabel(need.source.bytes)}` : nothing}</span>
                ${!need.present && need.source ? html`<a class="k-pics__need-get" href=${need.source.url} target="_blank" rel="noopener noreferrer">Download</a>` : nothing}
            </li>`;
        return html`
            <p class="k-pics__hint">Put each file in the folder named under your ComfyUI folder, then press Check again. Anima is the easier start (about 5.6 GB in all); KREA 2 is larger.</p>
            ${Object.entries(models.setup).filter(([, needs]) => needs.length).map(([id, needs]) => html`
                <div class="k-pics__family-needs" data-k-pics-family-needs=${id}>
                    <p class="k-pics__step-sub">${models.families[id]?.name ?? id}${needs.every(n => n.present) ? ' · ready' : ''}</p>
                    <ul class="k-pics__needs-list">${needs.map(fileRow)}</ul>
                </div>`)}
            ${models.extras.some(n => !n.present) ? html`
                <div class="k-pics__family-needs">
                    <p class="k-pics__step-sub">Optional</p>
                    <ul class="k-pics__needs-list">${models.extras.filter(n => !n.present).map(fileRow)}</ul>
                </div>` : nothing}
            <button type="button" class="k-pics__button" data-k-pics="setup-recheck" @click=${() => void this.#loadModels({ fresh: true })}>Check again</button>`;
    }

    #renderModels() {
        const models = this._models;
        let body;
        if (models.state === 'loading' || models.state === 'idle') {
            body = html`<p class="k-pics__hint">Reading the server's models…</p>`;
        } else if (models.state === 'error') {
            body = html`<p class="k-pics__hint" data-k-pics="models-error">Couldn’t read the models. ${models.message}</p>`;
        } else if (!models.list.length) {
            body = html`<p class="k-pics__hint">This ComfyUI has no models yet.</p>`;
        } else {
            const server = serverKey(this._settings.comfy.url);
            const rows = modelRows(models.list, this._settings.models?.[server], models.families);
            const waiting = rows.filter(row => row.state === 'suggested').length;
            const unset = rows.filter(row => row.state !== 'confirmed').length;
            const shown = models.onlyUnset ? rows.filter(row => row.state !== 'confirmed') : rows;
            body = html`
                <p class="k-pics__hint">Pick a family for each model you draw with. Kotatsu suggests one from the file's name or header; the sheet only offers models you have confirmed.</p>
                <div class="k-pics__models-bar">
                    ${waiting ? html`<button type="button" class="k-pics__button" data-k-pics="models-confirm-all" @click=${() => this.#confirmSuggestions()}>Confirm ${waiting} suggestion${waiting === 1 ? '' : 's'}</button>` : nothing}
                    <label class="k-pics__check">
                        <input type="checkbox" .checked=${models.onlyUnset} @change=${(/** @type {Event} */ e) => { this._models = { ...this._models, onlyUnset: /** @type {HTMLInputElement} */ (e.target).checked }; }}>
                        <span>Only models not set up (${unset})</span>
                    </label>
                </div>
                <div class="k-pics__models" role="list">${shown.map(row => this.#renderModelRow(row, models.families))}</div>`;
        }
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-models-head" data-k-pics="models">
                <h4 class="k-pics__head" id="k-pics-models-head">Models</h4>
                ${body}
            </section>`;
    }

    /**
     * @param {ReturnType<typeof modelRows>[number]} row
     * @param {Record<string, import('./picture-model.js').FamilyInfo>} families
     */
    #renderModelRow(row, families) {
        const shown = row.record ?? (row.suggestion.family ? { family: row.suggestion.family, preset: row.suggestion.preset ?? '' } : null);
        const family = shown ? families[shown.family] : null;
        const id = `k-pics-model-${row.file.replace(/[^\w-]/g, '_')}`;
        const onFamily = (/** @type {Event} */ e) => {
            const value = /** @type {HTMLSelectElement} */ (e.target).value;
            this.#setModel(row.file, value ? { family: value, preset: families[value].defaultPreset } : null);
        };
        const onPreset = (/** @type {Event} */ e) => {
            if (!shown) return;
            this.#setModel(row.file, { family: shown.family, preset: /** @type {HTMLSelectElement} */ (e.target).value });
        };
        return html`
            <div class="k-pics__model" role="listitem" data-k-pics-model=${row.file} data-state=${row.state}>
                <div class="k-pics__model-head">
                    <span class="k-pics__model-name" title=${row.file}>${row.file}</span>
                    <span class="k-pics__chip" data-state=${row.state}>${row.state === 'confirmed' ? 'Set up' : row.state === 'suggested' ? 'Suggested' : 'Not set up'}</span>
                </div>
                ${row.state === 'unknown' ? html`<p class="k-pics__hint">${row.suggestion.why}</p>` : nothing}
                <div class="k-pics__model-fields">
                    <select id=${`${id}-family`} class="k-pics__select" aria-label=${`Family of ${row.file}`} data-k-pics-model-family @change=${onFamily}>
                        <option value="" ?selected=${!shown}>Not set up</option>
                        ${Object.values(families).map(f => html`<option value=${f.id} ?selected=${shown?.family === f.id}>${f.name}</option>`)}
                    </select>
                    <select class="k-pics__select" aria-label=${`Preset of ${row.file}`} data-k-pics-model-preset ?disabled=${!family} @change=${onPreset}>
                        ${family ? Object.entries(family.presets).map(([pid, preset]) => html`<option value=${pid} ?selected=${shown?.preset === pid}>${preset.label} · ${preset.steps} steps, CFG ${preset.cfg}</option>`) : html`<option>—</option>`}
                    </select>
                    ${row.state === 'suggested' && shown ? html`
                        <button type="button" class="k-pics__button" data-k-pics-model-confirm
                            @click=${() => this.#setModel(row.file, { family: shown.family, preset: shown.preset || (family?.defaultPreset ?? '') })}>Confirm</button>` : nothing}
                </div>
            </div>`;
    }

    /** @param {{ state: string, result?: any }} check */
    #renderRecipes(check) {
        const recipes = this._recipes;
        const models = check.state === 'ok' ? check.result?.models : null;
        let body;
        if (recipes.state === 'loading' || recipes.state === 'idle') {
            body = html`<p class="k-pics__hint">Loading the recipes…</p>`;
        } else if (recipes.state === 'error') {
            body = html`<p class="k-pics__hint" data-k-pics="recipes-error">Couldn’t load the recipes. ${recipes.message}</p>`;
        } else if (recipes.list.length === 0) {
            body = html`<p class="k-pics__hint">No recipes yet. A ComfyUI workflow exported for the API, dropped into your workflows folder, becomes one.</p>`;
        } else {
            body = html`<div class="k-pics__recipes">${recipes.list.map(recipe => this.#renderRecipe(recipe, models))}</div>`;
        }
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-recipes-head">
                <h4 class="k-pics__head" id="k-pics-recipes-head">Recipes</h4>
                ${body}
            </section>`;
    }

    /**
     * @param {Recipe} recipe
     * @param {Record<string, string[]>|null} models
     */
    #renderRecipe(recipe, models) {
        const server = serverKey(this._settings.comfy.url);
        const chosen = this._settings.slotChoices?.[server]?.[recipe.id] ?? {};
        const missing = Array.isArray(recipe.missing) ? recipe.missing : [];
        const slots = Object.keys(recipe.slots ?? {});
        return html`
            <article class="k-pics__recipe" data-k-pics-recipe=${recipe.id}>
                <header class="k-pics__recipe-head">
                    <span class="k-pics__recipe-name">${recipe.name || recipe.id}</span>
                    <span class="k-pics__chip">${recipe.tongue === TONGUES.PROSE ? 'Writes prose' : 'Writes tags'}</span>
                </header>
                ${missing.length
        ? html`<p class="k-pics__needs">${icons.warning}<span>Needs: ${missing.join(', ')}</span></p>`
        : nothing}
                ${slots.map(slot => {
        const list = modelsForSlot(recipe, slot, models);
        const current = chosen[slot] ?? '';
        const options = current && !list.includes(current) ? [current, ...list] : list;
        const id = `k-pics-slot-${recipe.id}-${slot}`;
        return html`
                    <div class="k-pics__field">
                        <label class="k-pics__label" for=${id}>${slot}</label>
                        <select id=${id} class="k-pics__select" ?disabled=${!models || this._slotSaving === `${recipe.id}/${slot}`}
                            @change=${(/** @type {Event} */ e) => this.#chooseSlot(recipe, slot, /** @type {HTMLSelectElement} */ (e.target).value)}>
                            <option value="" ?selected=${!current}>${models ? 'Choose a file' : 'Check the address first'}</option>
                            ${options.map(name => html`<option value=${name} ?selected=${name === current}>${name}</option>`)}
                        </select>
                    </div>`;
    })}
            </article>`;
    }

    #renderDefaults() {
        const settings = this._settings;
        const recipes = this._recipes.list;
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-defaults-head">
                <h4 class="k-pics__head" id="k-pics-defaults-head">Default recipe for each kind of picture</h4>
                ${Object.values(PURPOSES).map(purpose => {
        const id = `k-pics-default-${purpose}`;
        const current = settings.recipeByPurpose?.[purpose] ?? '';
        const known = recipes.some(recipe => recipe.id === current);
        return html`
                    <div class="k-pics__field">
                        <label class="k-pics__label" for=${id}>${PURPOSE_LABELS[purpose] ?? purpose}</label>
                        <select id=${id} class="k-pics__select" data-k-pics-default=${purpose}
                            @change=${(/** @type {Event} */ e) => this.#update({ recipeByPurpose: { [purpose]: /** @type {HTMLSelectElement} */ (e.target).value } })}>
                            <option value="" ?selected=${!current}>Ask each time</option>
                            ${current && !known ? html`<option value=${current} selected>${current}</option>` : nothing}
                            ${recipes.map(recipe => html`<option value=${recipe.id} ?selected=${recipe.id === current}>${recipe.name || recipe.id}</option>`)}
                        </select>
                    </div>`;
    })}
            </section>`;
    }

    /**
     * One labelled select over a fixed list.
     * @param {string} id
     * @param {string} label
     * @param {ReadonlyArray<string>} values
     * @param {string} current
     * @param {(value: string) => void} onChange
     */
    #select(id, label, values, current, onChange) {
        const options = current && !values.includes(current) ? [current, ...values] : values;
        return html`
            <div class="k-pics__field">
                <label class="k-pics__label" for=${id}>${label}</label>
                <select id=${id} class="k-pics__select"
                    @change=${(/** @type {Event} */ e) => onChange(/** @type {HTMLSelectElement} */ (e.target).value)}>
                    ${options.map(value => html`<option value=${value} ?selected=${value === current}>${value}</option>`)}
                </select>
            </div>`;
    }

    /**
     * The provider's own listed price for the current choice, with the date it was read.
     * @param {string} lane
     * @param {{model?: string, quality?: string, size?: string}} choice
     */
    #price(lane, choice) {
        const url = PRICING_URLS[/** @type {keyof typeof PRICING_URLS} */ (lane)];
        return html`
            <p class="k-pics__hint" data-k-pics="price">${priceLine(lane, choice)}
                <a href=${url} target="_blank" rel="noopener noreferrer">Their pricing</a>, as read ${PRICES_READ}.</p>`;
    }

    /** @param {string} lane */
    #privacy(lane) {
        return html`<p class="k-pics__privacy" data-k-pics="privacy">${icons.lock}<span>${PRIVACY_LINES[lane]}</span></p>`;
    }

    #renderOpenAI() {
        const openai = this._settings.openai;
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-openai-head">
                <h4 class="k-pics__head" id="k-pics-openai-head">OpenAI</h4>
                ${this.#select('k-pics-openai-model', 'Model', OPENAI_MODELS, openai.model, value => this.#update({ openai: { model: value } }))}
                ${this.#select('k-pics-openai-quality', 'Quality', OPENAI_QUALITIES, openai.quality, value => this.#update({ openai: { quality: value } }))}
                ${this.#select('k-pics-openai-size', 'Size', OPENAI_SIZES, openai.size, value => this.#update({ openai: { size: value } }))}
                ${this.#price(LANES.OPENAI, openai)}
                ${this.#privacy(LANES.OPENAI)}
            </section>`;
    }

    #renderGemini() {
        const gemini = this._settings.gemini;
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-gemini-head">
                <h4 class="k-pics__head" id="k-pics-gemini-head">Gemini</h4>
                ${this.#select('k-pics-gemini-model', 'Model', GEMINI_MODELS, gemini.model, value => this.#update({ gemini: { model: value } }))}
                ${this.#select('k-pics-gemini-size', 'Size', GEMINI_SIZES, gemini.size, value => this.#update({ gemini: { size: value } }))}
                ${this.#select('k-pics-gemini-aspect', 'Shape', GEMINI_ASPECTS, gemini.aspect, value => this.#update({ gemini: { aspect: value } }))}
                ${this.#price(LANES.GEMINI, gemini)}
                <p class="k-pics__hint">Every picture Gemini draws carries Google’s SynthID watermark.</p>
                ${this.#privacy(LANES.GEMINI)}
            </section>`;
    }

    /**
     * A switch row.
     * @param {string} key Data hook for probes.
     * @param {string} label
     * @param {boolean} on
     * @param {(() => void)|null} toggle Null = disabled.
     * @param {string} [note]
     */
    #switch(key, label, on, toggle, note = '') {
        return html`
            <div class="k-pics__switchrow">
                <button type="button" class="k-pics__switch" role="switch" data-k-pics-switch=${key}
                    aria-checked=${on ? 'true' : 'false'} ?disabled=${!toggle}
                    @click=${() => toggle?.()}>
                    <span class="k-pics__track" aria-hidden="true"><span class="k-pics__thumb"></span></span>
                    <span>${label}</span>
                </button>
                ${note ? html`<span class="k-pics__note">${note}</span>` : nothing}
            </div>`;
    }

    #renderBehaviour() {
        const settings = this._settings;
        return html`
            <section class="k-pics__group" aria-labelledby="k-pics-behaviour-head">
                <h4 class="k-pics__head" id="k-pics-behaviour-head">In the chat</h4>
                ${this.#switch('captionLine', 'Show the caption line under pictures', settings.captionLine,
        () => this.#update({ captionLine: !settings.captionLine }), 'The chat model reads it either way.')}
                ${this.#switch('rawPreview', 'Show the model\'s live preview while drawing', settings.rawPreview,
        () => this.#update({ rawPreview: !settings.rawPreview }), 'Instead of Mikan-chan painting it.')}
                ${this.#switch('interactive', 'Draw when my message asks for a picture', false, null, 'Coming later')}
                ${this.#switch('tool', 'Let the model draw on its own', false, null, 'Coming later')}
            </section>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-pictures-settings')) {
    customElements.define('k-pictures-settings', KPicturesSettings);
}
