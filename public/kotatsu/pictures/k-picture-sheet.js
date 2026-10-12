/**
 * `<k-picture-sheet variant="sheet">` — the Picture sheet (docs/pictures-v0.md §2.3).
 *
 * One sheet for every hand-started picture: the composer's wand item, a message's paintbrush
 * (prefilled with This moment for that message), `/imagine`, and the tile menu's Edit prompt.
 * Purpose chips, the prompt as the writer drafted it (editable), the negative (folded), recipe,
 * size, seed (random or pinned, the number visible), the reference switch when the recipe has a
 * reference slot, and Draw. It remembers the last choices through the settings leaf.
 *
 * On a key lane (OpenAI, Gemini; slice E) there is no recipe, seed or negative: the sheet names the
 * lane, model and what leaves the machine, offers the lane's own shapes, drafts in prose, and
 * always offers the reference.
 *
 * House patterns, copied from the portrait peek: light DOM (`css/pictures.css` owns every rule),
 * `display: contents` on the host so scrim and sheet carry page-level z-indices, Escape taken at
 * document capture and handed to the settings modal when that is up, a bottom sheet with a grip
 * at phone width. The sheet never starts a job itself: Draw hands the finished request to
 * `onDraw`, which the opener supplies.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { isSettingsModalOpen, openSettings } from '../settings/k-settings-modal.js';
import { characterArtUrl } from '../renderer/portrait-target.js';
import { LANES, PURPOSES } from './contract.js';
import { draftPrompt, getPendingReference, hasWriter, lookOf, picturesSettings, setPendingReference, storedKeyLane, updatePicturesSettings } from './doors.js';
import { listLoras, listModels, listRecipes } from './jobs-client.js';
import {
    LORA_BASE_NAMES, MAX_LORAS, PURPOSE_LABELS, cardLorasFor, groupLoras, isKeyLane, isPurpose, joinNegatives, keyLaneRequest, keyLaneShapes, loraRequest,
    confirmedByFamily, needsLine, normalizeLoras, parseSize, pickRecipe, pipelineLabel, pipelinesFor, recipeBase, shapeLabel, sizesFor,
    startingModel, withName, withTriggers, withoutTrigger,
} from './picture-model.js';
import { PRIVACY_LINES, serverKey } from './settings-model.js';

/** Largest seed the sheet rolls (ComfyUI accepts up to 2^64, every lane accepts this). */
const SEED_CEILING = 2 ** 32;

/** @returns {number} */
function rollSeed() {
    return Math.floor(Math.random() * SEED_CEILING);
}

const icons = {
    close: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="16" height="16" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    redo: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M12.5 6.5A5 5 0 1 0 13 9.5" /><path d="M13 3v3.5H9.5" />
        </svg>`,
    dice: html`
        <svg class="k-pic-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
            <circle cx="5.75" cy="5.75" r=".6" fill="currentColor" /><circle cx="10.25" cy="10.25" r=".6" fill="currentColor" />
            <circle cx="8" cy="8" r=".6" fill="currentColor" />
        </svg>`,
};

/**
 * @typedef {object} SheetPrefill
 * @property {string} [prompt]
 * @property {string} [negative]
 * @property {string} [recipe]
 * @property {string} [size]
 * @property {number} [seed]   pins the seed
 * @property {string} [free]   free text handed to the writer (or kept, without it)
 * @property {{file: string, strength: number}[]} [loras]   the stack to start with (Edit prompt: the picture's own)
 * @property {string} [model]    the model to start with (Edit prompt: the picture's own, §14)
 * @property {string} [preset]   its preset
 */

export class KPictureSheet extends LitElement {
    static properties = {
        /** SPEC §13 — `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        purpose: { type: String, reflect: true },
        _settings: { state: true },
        _recipes: { state: true },
        _recipesError: { state: true },
        _recipeId: { state: true },
        _size: { state: true },
        _seedPinned: { state: true },
        _seed: { state: true },
        _useReference: { state: true },
        _reference: { state: true },
        _prompt: { state: true },
        _negative: { state: true },
        _retongue: { state: true },
        _families: { state: true },
        _model: { state: true },
        _drafting: { state: true },
        _draftError: { state: true },
        _writer: { state: true },
        _loras: { state: true },
        _loraList: { state: true },
        _loraError: { state: true },
        _showAllLoras: { state: true },
    };

    /** @type {number|undefined} Message the picture is about (This moment). */
    messageIndex = undefined;
    /** @type {SheetPrefill} */
    prefill = {};
    /** Character name for the `{{char}}` chip. */
    characterName = '';
    /** @type {any} The `characters[]` entry the look and the reference come from. */
    character = null;
    /** Sheet title: "Draw a picture", or "Edit and draw again" from the tile menu. */
    heading = 'Draw a picture';
    /** @type {(request: import('./contract.js').PictureRequest) => void} */
    onDraw = () => {};
    /** Folder under `user/images/` the result is saved into. */
    imagesFolder = '';

    /** Whether the user has typed in the prompt since the last draft (a redraft must not eat it). */
    #dirty = false;
    /** Bumps on every draft so a late answer for an older purpose is dropped. */
    #draftTicket = 0;
    /** Whether the user has typed in the negative box (a recipe switch must not eat it). */
    #negativeEdited = false;
    /** The writer's negative (a look's or style's), kept so a recipe switch can re-join it. */
    #draftNegative = '';
    /** The tongue the prompt in the box was drafted in ('' = typed, or nothing drafted yet). */
    #draftTongue = '';
    #onKeydown = (/** @type {KeyboardEvent} */ event) => this.#handleKeydown(event);

    constructor() {
        super();
        this.variant = 'sheet';
        /** @type {string} */
        this.purpose = PURPOSES.MOMENT;
        /** @type {import('./contract.js').PicturesSettings|null} */
        this._settings = null;
        /** @type {import('./contract.js').Recipe[]|null} null while loading */
        this._recipes = null;
        this._recipesError = '';
        this._recipeId = '';
        this._size = '';
        this._seedPinned = false;
        this._seed = rollSeed();
        this._useReference = false;
        this._reference = '';
        this._prompt = '';
        this._negative = '';
        this._drafting = false;
        this._draftError = '';
        this._writer = false;
        /** @type {import('./contract.js').LoraChoice[]} The LoRA stack this picture draws with (ComfyUI lane). */
        this._loras = [];
        /** @type {import('./picture-model.js').LoraInfo[]|null} The server's LoRAs; null while loading. */
        this._loraList = null;
        this._loraError = '';
        this._showAllLoras = false;
        /** The recipe's tongue when it differs from the drafted prompt's: shows the rewrite offer. */
        this._retongue = '';
        /** @type {Record<string, import('./picture-model.js').FamilyInfo>} Families, once models are set up (§14); empty = recipe mode. */
        this._families = {};
        /** @type {{file: string, family: string, preset: string}|null} The model picked for a family pipeline; null = recipe mode or an own workflow. */
        this._model = null;
    }

    /** Light DOM: `public/css/pictures.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        document.addEventListener('keydown', this.#onKeydown, true);
    }

    disconnectedCallback() {
        document.removeEventListener('keydown', this.#onKeydown, true);
        super.disconnectedCallback();
    }

    firstUpdated() {
        void this.#load();
        void this.updateComplete.then(() => {
            /** @type {HTMLElement|null} */ (this.querySelector('.k-pic-prompt'))?.focus({ preventScroll: true });
        });
    }

    close() {
        this.remove();
    }

    /** @param {KeyboardEvent} event */
    #handleKeydown(event) {
        if (event.key !== 'Escape' || event.isComposing) return;
        // Something more immediate is up (the settings modal rides above the sheet): let it answer.
        if (isSettingsModalOpen()) return;
        event.stopPropagation();
        event.preventDefault();
        this.close();
    }

    async #load() {
        const prefill = this.prefill ?? {};
        if (!isPurpose(this.purpose)) this.purpose = PURPOSES.MOMENT;
        this._reference = getPendingReference();
        const [settings, writer] = await Promise.all([picturesSettings(), hasWriter()]);
        this._settings = settings;
        this._writer = writer;
        const last = settings.lastSheet ?? { purpose: '', recipe: '', size: '', seedPinned: false, useReference: false };
        this._useReference = !!last.useReference;
        if (Number.isFinite(prefill.seed)) {
            this._seedPinned = true;
            this._seed = Number(prefill.seed);
        } else {
            this._seedPinned = !!last.seedPinned;
        }
        if (typeof prefill.prompt === 'string') {
            this._prompt = prefill.prompt;
            this._negative = prefill.negative ?? '';
            this.#negativeEdited = typeof prefill.negative === 'string';
            this.#dirty = true;
        } else if (typeof prefill.free === 'string') {
            this._prompt = prefill.free;
        }

        try {
            this._recipes = await listRecipes({ fresh: true });
        } catch (error) {
            this._recipes = [];
            this._recipesError = error instanceof Error ? error.message : String(error);
        }
        const recipes = this._recipes ?? [];
        this._recipeId = prefill.recipe && recipes.some(r => r.id === prefill.recipe)
            ? prefill.recipe
            : pickRecipe(recipes, { purpose: this.purpose, recipeByPurpose: settings.recipeByPurpose, last: last.recipe });
        if (this.#keyLane) {
            this._size = keyLaneShapes(settings, prefill.size || last.size).shape;
        } else {
            const sizes = sizesFor(this.#recipe);
            this._size = [prefill.size, last.size].find(size => size && sizes.includes(size)) ?? sizes[0];
        }
        this.#syncNegative();

        if (!this.#keyLane) await this.#loadModelPick(settings, prefill);
        if (!this.#keyLane) await this.#loadLoras(settings, prefill);
        if (typeof prefill.prompt !== 'string' && this.purpose !== PURPOSES.FREE) void this.#draft();
    }

    /** @returns {string} This sheet's server key (models are set up per server). */
    get #server() {
        return serverKey(this._settings?.comfy?.url ?? '');
    }

    /** @returns {boolean} Whether models are set up, so the sheet picks a model (§14.3). */
    get #modelMode() {
        return !this.#keyLane && Object.keys(this._families).length > 0;
    }

    /**
     * Model mode starts on: the picture's own model (Edit prompt), else an own workflow when the
     * purpose's recipe is one, else the recipe family's last-used or first set-up model, else any
     * family's. With no model set up anywhere the sheet stays in recipe mode.
     * @param {import('./contract.js').PicturesSettings} settings
     * @param {SheetPrefill} prefill
     */
    async #loadModelPick(settings, prefill) {
        const saved = settings.models?.[this.#server];
        if (!Object.values(saved ?? {}).some(Boolean)) return;
        try {
            const answer = await listModels({ url: settings.comfy?.url, auth: settings.comfy?.auth });
            if (!answer?.ok || !answer.families) return;
            this._families = answer.families;
        } catch {
            return;
        }
        const recipes = this._recipes ?? [];
        const recipe = this.#recipe;
        const last = settings.lastModel?.[this.#server];
        /** @type {{file: string, family: string, preset: string}|null} */
        let pick = null;
        const record = prefill.model ? saved?.[prefill.model] : null;
        if (prefill.model && record) {
            pick = { file: prefill.model, family: record.family, preset: prefill.preset && this._families[record.family]?.presets[prefill.preset] ? prefill.preset : record.preset };
        } else if (recipe && !recipe.family) {
            return; // an own workflow: drawn as it is
        } else {
            const defaultOf = (/** @type {string|null|undefined} */ f) => (f ? this._families[f]?.defaultPreset : undefined);
            const lastFamily = last?.file ? saved?.[last.file]?.family : null;
            const firstFamily = confirmedByFamily(saved, this._families)[0]?.family.id ?? null;
            pick = startingModel(recipe?.family, saved, last, defaultOf(recipe?.family))
                ?? startingModel(lastFamily, saved, last, defaultOf(lastFamily))
                ?? startingModel(firstFamily, saved, last, defaultOf(firstFamily));
        }
        if (!pick) return;
        this._model = pick;
        if (this.#recipe?.family !== pick.family) {
            const pipelines = pipelinesFor(recipes, pick.family);
            const next = pipelines.find(p => p.id === last?.pipeline) ?? pipelines.find(p => p.pipeline === this.#recipe?.pipeline) ?? pipelines[0];
            if (next) this.#chooseRecipe(next.id);
        }
        this.#syncNegative();
    }

    /**
     * "Draw with": a set-up model (`model:<file>`) or an own workflow (`recipe:<id>`).
     * @param {string} value
     */
    #chooseDrawWith(value) {
        if (value.startsWith('recipe:')) {
            this._model = null;
            this.#chooseRecipe(value.slice('recipe:'.length));
            return;
        }
        const file = value.slice('model:'.length);
        const record = this._settings?.models?.[this.#server]?.[file];
        if (!record) return;
        this._model = { file, family: record.family, preset: record.preset };
        const pipelines = pipelinesFor(this._recipes ?? [], record.family);
        const next = (this.#recipe?.family === record.family ? this.#recipe : null)
            ?? pipelines.find(p => p.pipeline === this.#recipe?.pipeline) ?? pipelines[0];
        if (next) this.#chooseRecipe(next.id);
        else this.#syncNegative();
    }

    /** @returns {boolean} Whether ComfyUI did not answer when the sheet asked for its LoRAs (§14.6). */
    get #unreachable() {
        return !this.#keyLane && /not reachable|did not answer|ECONNREFUSED/i.test(this._loraError);
    }

    /**
     * Draws on a stored key instead of an unreachable ComfyUI: the lane switches for good (it is the
     * same switch as in Settings), the sheet becomes the key lane's, LoRA triggers come back out.
     * @param {string} lane
     */
    async #switchToKeyLane(lane) {
        await updatePicturesSettings({ lane });
        this._settings = await picturesSettings();
        for (const lora of this._loras) {
            if (lora.trigger) this._prompt = withoutTrigger(this._prompt, lora.trigger);
        }
        this._loras = [];
        this._model = null;
        this._families = {};
        this._loraError = '';
        this._size = keyLaneShapes(this._settings, '').shape;
    }

    #renderUnreachable() {
        const key = storedKeyLane();
        return html`
            <p class="k-pic-hint k-pic-hint--warn k-pic-unreachable" role="status">
                <span>ComfyUI isn’t answering at ${this._settings?.comfy?.url || 'its address'}.</span>
                <button type="button" class="k-pic-link" @click=${() => { openSettings({ tab: 'pictures' }); }}>Set it up</button>
                ${key ? html`<button type="button" class="k-pic-link k-pic-use-key" @click=${() => void this.#switchToKeyLane(key.lane)}>Draw with your ${key.label} key</button>` : nothing}
            </p>`;
    }

    /** @param {string} preset */
    #choosePreset(preset) {
        if (!this._model) return;
        this._model = { ...this._model, preset };
        this.#syncNegative();
    }

    /** @returns {import('./picture-model.js').FamilyPreset|null} The picked model's preset. */
    get #preset() {
        return this._model ? this._families[this._model.family]?.presets?.[this._model.preset] ?? null : null;
    }

    /** The card's LoRAs, as its look stores them. */
    #cardLoras = /** @type {import('./contract.js').LoraChoice[]} */ ([]);
    /** Whether the stack was changed by hand (a purpose switch then leaves it alone). */
    #lorasEdited = false;

    /**
     * The stack to start with (the picture's own on Edit prompt, else the card's for a purpose that
     * draws the character), then the server's list for the picker.
     * @param {import('./contract.js').PicturesSettings} settings
     * @param {SheetPrefill} prefill
     */
    async #loadLoras(settings, prefill) {
        try {
            this.#cardLoras = normalizeLoras((await lookOf(this.character))?.loras);
        } catch {
            this.#cardLoras = [];
        }
        if (Array.isArray(prefill.loras)) {
            const triggerOf = (/** @type {string} */ file) => this.#cardLoras.find(l => l.file === file)?.trigger ?? '';
            this._loras = normalizeLoras(prefill.loras.map(l => ({ ...l, trigger: triggerOf(l.file) })));
            this.#lorasEdited = true;
        } else {
            this._loras = cardLorasFor(this.purpose, this.#cardLoras);
        }
        this.#applyTriggers();
        void listLoras({ url: settings.comfy?.url, auth: settings.comfy?.auth }).then(answer => {
            if (answer?.ok && Array.isArray(answer.loras)) {
                this._loraList = answer.loras;
                // A card LoRA saved before its trigger was known picks up the file's own words.
                const filled = this._loras.map(l => (l.trigger ? l : { ...l, trigger: (answer.loras ?? []).find(i => i.file === l.file)?.triggers.join(', ') ?? '' }));
                if (filled.some((l, i) => l.trigger !== this._loras[i].trigger)) {
                    this._loras = filled;
                    this.#applyTriggers();
                }
            } else {
                this._loraList = [];
                this._loraError = answer?.message || 'The picture server did not list its LoRAs.';
            }
        }).catch(error => {
            this._loraList = [];
            this._loraError = error instanceof Error ? error.message : String(error);
        });
    }

    /** Every active LoRA's trigger goes into the prompt (Andres, 2026-10-10: on their own, visible). */
    #applyTriggers() {
        if (this.#keyLane) return;
        const triggers = this._loras.map(l => l.trigger).filter(Boolean);
        if (triggers.length) this._prompt = withTriggers(this._prompt, triggers);
    }

    /** @param {import('./picture-model.js').LoraInfo} info */
    #addLora(info) {
        if (this._loras.some(l => l.file === info.file) || this._loras.length >= MAX_LORAS) return;
        // The card's own settings for this LoRA when it has them, else the file's.
        const card = this.#cardLoras.find(l => l.file === info.file);
        const trigger = card?.trigger || info.triggers.join(', ');
        this._loras = [...this._loras, { file: info.file, strength: card?.strength ?? 1, trigger }];
        this.#lorasEdited = true;
        this.#applyTriggers();
    }

    /** @param {string} file */
    #removeLora(file) {
        const gone = this._loras.find(l => l.file === file);
        this._loras = this._loras.filter(l => l.file !== file);
        this.#lorasEdited = true;
        if (gone?.trigger) this._prompt = withoutTrigger(this._prompt, gone.trigger);
    }

    /**
     * @param {string} file
     * @param {Event} event
     */
    #setStrength(file, event) {
        const value = Number(/** @type {HTMLInputElement} */ (event.currentTarget).value);
        if (!Number.isFinite(value)) return;
        this._loras = normalizeLoras(this._loras.map(l => (l.file === file ? { ...l, strength: value } : l)));
        this.#lorasEdited = true;
    }

    /** @returns {import('./contract.js').Recipe|null} */
    get #recipe() {
        return (this._recipes ?? []).find(r => r.id === this._recipeId) ?? null;
    }

    /** @returns {boolean} Whether the configured lane is OpenAI or Gemini: no recipe, seed or negative; prose prompts. */
    get #keyLane() {
        return isKeyLane(this._settings?.lane);
    }

    /** @returns {string} The tongue the writer drafts in: the recipe's on ComfyUI, prose on a key lane. */
    get #tongue() {
        return this.#keyLane ? 'prose' : (this.#recipe?.tongue ?? 'prose');
    }

    /**
     * Asks the writer for a prompt for the current purpose. A prompt the user has typed is kept
     * unless they asked for the draft themselves.
     * @param {{force?: boolean}} [options]
     */
    async #draft({ force = false } = {}) {
        if (this.#dirty && !force) return;
        const ticket = ++this.#draftTicket;
        this._drafting = true;
        this._draftError = '';
        try {
            const look = await lookOf(this.character);
            const free = this.purpose === PURPOSES.FREE ? this._prompt : (this.prefill?.free ?? '');
            const tongue = this.#tongue;
            const result = await draftPrompt({
                purpose: this.purpose,
                tongue,
                messageIndex: this.messageIndex,
                free,
                look,
                style: null,
            });
            if (ticket !== this.#draftTicket) return;
            if (result.drafted || force || !this._prompt) {
                this._prompt = result.prompt;
                this.#applyTriggers();
                this.#draftTongue = result.drafted ? tongue : '';
                this._retongue = '';
                this.#draftNegative = result.negative;
                this.#syncNegative();
                this.#dirty = false;
            }
        } catch (error) {
            if (ticket !== this.#draftTicket) return;
            console.warn('[Pictures] the writer could not draft a prompt', error);
            // writer.js's WriterError carries a reason worded for the sheet (by name: the writer is an optional module).
            this._draftError = error instanceof Error && error.name === 'WriterError'
                ? error.message
                : 'The writer could not draft a prompt. Type one instead.';
        } finally {
            if (ticket === this.#draftTicket) this._drafting = false;
        }
    }

    /** @param {string} purpose */
    #choosePurpose(purpose) {
        if (purpose === this.purpose) return;
        this.purpose = purpose;
        // The card's LoRAs ride the purposes that draw the character, until the stack is edited by hand.
        if (!this.#lorasEdited && !this.#keyLane) {
            const next = cardLorasFor(purpose, this.#cardLoras);
            for (const gone of this._loras.filter(l => !next.some(n => n.file === l.file))) {
                if (gone.trigger) this._prompt = withoutTrigger(this._prompt, gone.trigger);
            }
            this._loras = next;
        }
        // Free is the reader's own page: an untouched draft from another purpose does not ride along
        // (found 2026-10-10: Free re-drew the place's prompt byte for byte). Typed words stay.
        if (purpose === PURPOSES.FREE && !this.#dirty) {
            this._prompt = '';
            this.#draftTongue = '';
            this._retongue = '';
            this.#draftNegative = '';
            this.#syncNegative();
            void this.updateComplete.then(() => /** @type {HTMLElement|null} */ (this.querySelector('.k-pic-prompt'))?.focus({ preventScroll: true }));
        }
        const byPurpose = this._settings?.recipeByPurpose?.[purpose];
        const target = (this._recipes ?? []).find(r => r.id === byPurpose);
        // In model mode a purpose's recipe only switches the pipeline within the picked model's family.
        if (target && (!this.#modelMode || (this._model ? target.family === this._model.family : !target.family))) this.#chooseRecipe(target.id);
        if (purpose !== PURPOSES.FREE) void this.#draft();
    }

    /** @param {string} id */
    #chooseRecipe(id) {
        this._recipeId = id;
        if (this.#keyLane) return; // the recipe is not drawn with; the key lane's shapes stay
        const sizes = sizesFor(this.#recipe);
        if (!sizes.includes(this._size)) this._size = sizes[0];
        this.#syncNegative();
        const tongue = this.#recipe?.tongue ?? '';
        this._retongue = this.#draftTongue && this._prompt.trim() && tongue && tongue !== this.#draftTongue ? tongue : '';
    }

    /**
     * The negative box = the writer's negative + the model preset's (§14) or else the recipe's own,
     * until someone edits it.
     */
    #syncNegative() {
        if (this.#negativeEdited) return;
        const own = this._model ? (this.#preset?.negative ?? '') : (this.#recipe?.negative ?? '');
        this._negative = joinNegatives(this.#draftNegative, own);
    }

    /** @returns {boolean} Whether the picked preset ignores a negative prompt (CFG 1). */
    get #ignoresNegative() {
        return !!this._model && this.#preset?.negative === null;
    }

    /** @param {Event} event */
    #onPromptInput(event) {
        this._prompt = /** @type {HTMLTextAreaElement} */ (event.currentTarget).value;
        this.#dirty = true;
    }

    #pinSeed() {
        this._seedPinned = true;
    }

    /** @param {Event} event */
    #onSeedInput(event) {
        const value = Number(/** @type {HTMLInputElement} */ (event.currentTarget).value);
        if (Number.isSafeInteger(value) && value >= 0) this._seed = value;
    }

    /** @returns {string} Why Draw is off, or '' when it is on. */
    get #blocker() {
        if (this._settings === null) return 'loading';
        if (this.#keyLane) {
            if (!this._prompt.trim()) return 'prompt';
            if (!keyLaneShapes(this._settings).shapes.includes(this._size)) return 'size';
            return '';
        }
        if (this._recipes === null) return 'loading';
        if (!this.#recipe) return 'recipe';
        if (needsLine(this.#recipe)) return 'needs';
        if (!this._prompt.trim()) return 'prompt';
        if (!parseSize(this._size)) return 'size';
        return '';
    }

    /** The reference this job would send, '' for none. */
    get #referenceUrl() {
        if (!this.#takesReference) return '';
        if (this._reference) return this._reference;
        if (this._useReference && this.character?.avatar) return characterArtUrl(this.character.avatar);
        return '';
    }

    /** @returns {boolean} Whether this job can carry a reference (every key lane can; a recipe needs the slot). */
    get #takesReference() {
        return this.#keyLane || !!this.#recipe?.bind?.reference;
    }

    #draw() {
        if (this.#blocker) return;
        if (this.#keyLane) {
            const settings = /** @type {import('./contract.js').PicturesSettings} */ (this._settings);
            const reference = this.#referenceUrl;
            const request = keyLaneRequest(settings, {
                prompt: this._prompt.trim(),
                purpose: this.purpose,
                character: this.imagesFolder,
                shape: this._size,
                reference,
            });
            if (this._reference && reference === this._reference) setPendingReference('');
            void updatePicturesSettings({
                lastSheet: {
                    ...settings.lastSheet,
                    purpose: this.purpose,
                    size: this._size,
                    useReference: this._useReference,
                },
            });
            this.close();
            this.onDraw(request);
            return;
        }
        const recipe = /** @type {import('./contract.js').Recipe} */ (this.#recipe);
        const size = /** @type {{width: number, height: number}} */ (parseSize(this._size));
        /** @type {import('./contract.js').PictureRequest} */
        const request = {
            lane: LANES.COMFY,
            recipe: recipe.id,
            prompt: this._prompt.trim(),
            negative: this.#ignoresNegative ? '' : this._negative.trim(),
            width: size.width,
            height: size.height,
            purpose: this.purpose,
            character: this.imagesFolder,
        };
        if (this._seedPinned) request.seed = this._seed;
        const loras = loraRequest(this._loras);
        if (loras.length) request.loras = loras;
        const reference = this.#referenceUrl;
        if (reference) request.reference = reference;
        if (this._reference && reference === this._reference) setPendingReference('');
        if (this._model) {
            request.model = this._model.file;
            request.family = this._model.family;
            request.preset = this._model.preset;
        }

        void updatePicturesSettings({
            lastSheet: {
                purpose: this.purpose,
                recipe: recipe.id,
                size: this._size,
                seedPinned: this._seedPinned,
                useReference: this._useReference,
            },
            ...(this._model ? { lastModel: { [this.#server]: { file: this._model.file, preset: this._model.preset, pipeline: recipe.id } } } : {}),
        });
        this.close();
        this.onDraw(request);
    }

    render() {
        const settings = this._settings;
        return html`
            <div class="k-pic-scrim" @click=${() => this.close()}></div>
            <aside class="k-pic-sheet" role="dialog" aria-modal="true" aria-label=${this.heading}>
                <span class="k-pic-grip" aria-hidden="true"></span>
                <header class="k-pic-head">
                    <h2 class="k-pic-title">${this.heading}</h2>
                    <button type="button" class="k-pic-close" aria-label="Close" @click=${() => this.close()}>${icons.close}</button>
                </header>
                <div class="k-pic-body">
                    ${this.#renderPurposes()}
                    ${this.#renderPrompt()}
                    ${this.#unreachable ? this.#renderUnreachable() : nothing}
                    ${settings && this.#keyLane ? this.#renderLaneNote(settings) : this.#modelMode ? this.#renderDrawWith() : this.#renderRecipe()}
                    ${settings && !this.#keyLane ? this.#renderLoras() : nothing}
                    ${settings && this.#keyLane ? this.#renderShape(settings) : this.#renderSizeAndSeed()}
                    ${this.#renderReference()}
                </div>
                <footer class="k-pic-actions">
                    ${this.#renderBlockerLine()}
                    <button type="button" class="k-pic-btn k-pic-btn--primary k-pic-draw"
                            ?disabled=${!!this.#blocker} @click=${() => this.#draw()}>Draw</button>
                </footer>
            </aside>`;
    }

    #renderPurposes() {
        return html`
            <div class="k-pic-chips" role="radiogroup" aria-label="What to draw">
                ${Object.values(PURPOSES).map(purpose => html`
                    <button type="button" class="k-pic-chip${purpose === this.purpose ? ' is-on' : ''}"
                            role="radio" aria-checked=${purpose === this.purpose ? 'true' : 'false'}
                            data-purpose=${purpose}
                            @click=${() => this.#choosePurpose(purpose)}>${withName(PURPOSE_LABELS[purpose], this.characterName)}</button>`)}
            </div>`;
    }

    #renderPrompt() {
        const free = this.purpose === PURPOSES.FREE;
        let hint = '';
        if (this._drafting) hint = 'Writing a prompt…';
        else if (this._draftError) hint = this._draftError;
        else if (!this._writer && !free) hint = 'Describe the picture. The prompt writer arrives in a later update.';
        return html`
            <section class="k-pic-field">
                <div class="k-pic-label-row">
                    <label class="k-pic-label" for="k-pic-prompt">Prompt</label>
                    ${this._writer ? html`
                        <button type="button" class="k-pic-link" ?disabled=${this._drafting}
                                @click=${() => this.#draft({ force: true })}>${icons.redo}<span>Write it again</span></button>` : nothing}
                </div>
                <textarea id="k-pic-prompt" class="k-pic-prompt" rows="5"
                          placeholder=${free ? 'What should the picture show?' : ''}
                          aria-busy=${this._drafting ? 'true' : 'false'}
                          .value=${this._prompt} @input=${this.#onPromptInput}></textarea>
                ${hint ? html`<p class="k-pic-hint" aria-live="polite">${hint}</p>` : nothing}
                ${this._retongue && !this._drafting ? this.#renderRetongue() : nothing}
                ${this.#ignoresNegative ? html`<p class="k-pic-hint k-pic-no-negative">This preset ignores a negative prompt (CFG 1).</p>` : nothing}
                ${this.#keyLane || this.#ignoresNegative ? nothing : html`<details class="k-pic-negative" ?open=${!!this._negative}>
                    <summary class="k-pic-summary">Negative prompt</summary>
                    <textarea class="k-pic-negative-text" rows="2" aria-label="Negative prompt"
                              .value=${this._negative}
                              @input=${(/** @type {Event} */ e) => { this._negative = /** @type {HTMLTextAreaElement} */ (e.currentTarget).value; this.#negativeEdited = true; }}></textarea>
                </details>`}
            </section>`;
    }

    /** The offer after a switch to a recipe that reads the other tongue (prose ↔ tags). */
    #renderRetongue() {
        const name = this.#recipe?.name || this.#recipe?.id || 'This recipe';
        const tags = this._retongue === 'tags';
        return html`
            <p class="k-pic-retongue" role="status">
                <span>${name} reads ${tags ? 'tags' : 'plain description'}; this prompt is ${tags ? 'plain description' : 'tags'}.</span>
                <button type="button" class="k-pic-link" data-k-pic-retongue="rewrite"
                        @click=${() => void this.#draft({ force: true })}>${icons.redo}<span>Rewrite as ${tags ? 'tags' : 'description'}${this.#dirty ? ' (replaces your edits)' : ''}</span></button>
                <button type="button" class="k-pic-link" data-k-pic-retongue="keep"
                        @click=${() => { this._retongue = ''; this.#draftTongue = this.#recipe?.tongue ?? this.#draftTongue; }}>Keep</button>
            </p>`;
    }

    /** @param {import('./contract.js').PicturesSettings} settings */
    #renderLaneNote(settings) {
        const lane = settings.lane;
        const name = lane === LANES.OPENAI ? 'OpenAI' : lane === LANES.GEMINI ? 'Gemini' : lane;
        const model = lane === LANES.OPENAI ? settings.openai?.model : lane === LANES.GEMINI ? settings.gemini?.model : '';
        const privacy = PRIVACY_LINES[/** @type {keyof typeof PRIVACY_LINES} */ (lane)] ?? '';
        return html`
            <section class="k-pic-field k-pic-lane">
                <span class="k-pic-label">Drawn with</span>
                <p class="k-pic-lane-model">${name}${model ? html` · <span class="k-pic-mono">${model}</span>` : nothing}</p>
                ${privacy ? html`<p class="k-pic-hint">${privacy}</p>` : nothing}
            </section>`;
    }

    /**
     * The key lane's shape menu: OpenAI's sizes, or Gemini's aspect ratios (its resolution is a setting).
     * @param {import('./contract.js').PicturesSettings} settings
     */
    #renderShape(settings) {
        const { shapes } = keyLaneShapes(settings);
        const gemini = settings.lane === LANES.GEMINI;
        return html`
            <section class="k-pic-field">
                <label class="k-pic-label" for="k-pic-size">${gemini ? `Shape · ${settings.gemini?.size ?? ''}` : 'Size'}</label>
                <select id="k-pic-size" class="k-pic-select k-pic-size"
                        @change=${(/** @type {Event} */ e) => { this._size = /** @type {HTMLSelectElement} */ (e.currentTarget).value; }}>
                    ${shapes.map(shape => html`<option value=${shape} ?selected=${shape === this._size}>${shapeLabel(shape)}</option>`)}
                </select>
            </section>`;
    }

    /**
     * Model mode (§14.3): "Draw with" a set-up model (grouped by family) or an own workflow, then
     * the model family's pipeline and preset.
     */
    #renderDrawWith() {
        const groups = confirmedByFamily(this._settings?.models?.[this.#server], this._families);
        const own = (this._recipes ?? []).filter(r => !r.family);
        const value = this._model ? `model:${this._model.file}` : `recipe:${this._recipeId}`;
        const family = this._model ? this._families[this._model.family] : null;
        const pipelines = family ? pipelinesFor(this._recipes ?? [], family.id) : [];
        const needs = needsLine(this.#recipe);
        return html`
            <section class="k-pic-field">
                <label class="k-pic-label" for="k-pic-model">Draw with</label>
                <select id="k-pic-model" class="k-pic-select k-pic-model" @change=${(/** @type {Event} */ e) => this.#chooseDrawWith(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
                    ${groups.map(group => html`
                        <optgroup label=${group.family.name}>
                            ${group.models.map(m => html`<option value=${`model:${m.file}`} ?selected=${value === `model:${m.file}`}>${m.file.replace(/\.(safetensors|sft|ckpt|gguf)$/i, '')}</option>`)}
                        </optgroup>`)}
                    ${own.length ? html`
                        <optgroup label="Your own workflows">
                            ${own.map(r => html`<option value=${`recipe:${r.id}`} ?selected=${value === `recipe:${r.id}`}>${r.name || r.id}</option>`)}
                        </optgroup>` : nothing}
                </select>
            </section>
            ${family ? html`
                <div class="k-pic-pair">
                    <section class="k-pic-field">
                        <label class="k-pic-label" for="k-pic-pipeline">Pipeline</label>
                        <select id="k-pic-pipeline" class="k-pic-select k-pic-pipeline" @change=${(/** @type {Event} */ e) => this.#chooseRecipe(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
                            ${pipelines.map(p => html`<option value=${p.id} ?selected=${p.id === this._recipeId}>${pipelineLabel(p)}${needsLine(p) ? ' (needs a node)' : ''}</option>`)}
                        </select>
                    </section>
                    <section class="k-pic-field">
                        <label class="k-pic-label" for="k-pic-preset">Preset</label>
                        <select id="k-pic-preset" class="k-pic-select k-pic-preset" @change=${(/** @type {Event} */ e) => this.#choosePreset(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
                            ${Object.entries(family.presets).map(([id, p]) => html`<option value=${id} ?selected=${id === this._model?.preset}>${p.label} · ${p.steps} steps, CFG ${p.cfg}</option>`)}
                        </select>
                    </section>
                </div>` : nothing}
            ${needs ? html`<p class="k-pic-hint k-pic-hint--warn k-pic-needs">${needs}</p>` : nothing}`;
    }

    #renderRecipe() {
        const recipes = this._recipes;
        let body;
        if (recipes === null) {
            body = html`<p class="k-pic-quiet">Loading recipes…</p>`;
        } else if (this._recipesError) {
            body = html`<p class="k-pic-hint k-pic-hint--warn">Could not reach the picture server: ${this._recipesError}</p>`;
        } else if (recipes.length === 0) {
            body = html`<p class="k-pic-quiet">No recipes yet. Add one in Settings, under Pictures.</p>`;
        } else {
            const needs = needsLine(this.#recipe);
            body = html`
                <select id="k-pic-recipe" class="k-pic-select k-pic-recipe"
                        @change=${(/** @type {Event} */ e) => this.#chooseRecipe(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
                    ${recipes.map(recipe => html`
                        <option value=${recipe.id} ?selected=${recipe.id === this._recipeId}>${recipe.name || recipe.id}${needsLine(recipe) ? ' (needs a node)' : ''}</option>`)}
                </select>
                ${needs ? html`<p class="k-pic-hint k-pic-hint--warn k-pic-needs">${needs}</p>` : nothing}`;
        }
        return html`
            <section class="k-pic-field">
                <label class="k-pic-label" for="k-pic-recipe">Recipe</label>
                ${body}
            </section>`;
    }

    /**
     * The LoRA stack (ComfyUI lane): each active LoRA with its strength and a remove button, then
     * a picker listing the ones made for this recipe's model first, unknown ones after, and the
     * rest only on "Show all" (Andres, 2026-10-10).
     */
    #renderLoras() {
        const base = recipeBase(this.#recipe);
        const list = this._loraList;
        const infoOf = (/** @type {string} */ file) => list?.find(l => l.file === file);
        const groups = groupLoras((list ?? []).filter(l => !this._loras.some(a => a.file === l.file)), base);
        const hiddenCount = groups.other.length;
        const baseName = (/** @type {string|null} */ b) => (b ? LORA_BASE_NAMES[b] ?? b : '');
        const option = (/** @type {import('./picture-model.js').LoraInfo} */ l) => html`<option value=${l.file}>${l.title}${l.base && l.base !== base ? ` (${baseName(l.base)})` : ''}</option>`;
        const full = this._loras.length >= MAX_LORAS;
        return html`
            <section class="k-pic-field k-pic-loras" aria-labelledby="k-pic-loras-label">
                <div class="k-pic-label-row">
                    <span class="k-pic-label" id="k-pic-loras-label">LoRAs</span>
                    ${hiddenCount ? html`
                        <button type="button" class="k-pic-link" aria-pressed=${this._showAllLoras ? 'true' : 'false'}
                                @click=${() => { this._showAllLoras = !this._showAllLoras; }}>${this._showAllLoras ? 'Hide other models' : `Show all (${hiddenCount} more)`}</button>` : nothing}
                </div>
                ${this._loras.length ? html`
                    <ul class="k-pic-lora-list">${this._loras.map(lora => this.#renderLoraRow(lora, infoOf(lora.file), base))}</ul>` : nothing}
                ${list === null && !this._loraError ? html`<p class="k-pic-quiet">Reading the server's LoRAs…</p>` : nothing}
                ${this._loraError && !this.#unreachable ? html`<p class="k-pic-hint k-pic-hint--warn">Couldn’t read the LoRAs: ${this._loraError}</p>` : nothing}
                ${list && list.length && !full ? html`
                    <select class="k-pic-select k-pic-lora-add" aria-label="Add a LoRA" @change=${this.#onAddLora}>
                        <option value="" selected>Add a LoRA…</option>
                        ${groups.matching.length ? html`<optgroup label=${`For ${baseName(base)}`}>${groups.matching.map(option)}</optgroup>` : nothing}
                        ${groups.unknown.length ? html`<optgroup label=${base ? 'Base unknown' : 'LoRAs'}>${groups.unknown.map(option)}</optgroup>` : nothing}
                        ${this._showAllLoras && groups.other.length ? html`<optgroup label="Made for other models">${groups.other.map(option)}</optgroup>` : nothing}
                    </select>` : nothing}
                ${list && !list.length && !this._loraError ? html`<p class="k-pic-quiet">This ComfyUI has no LoRAs.</p>` : nothing}
            </section>`;
    }

    /**
     * @param {import('./contract.js').LoraChoice} lora
     * @param {import('./picture-model.js').LoraInfo|undefined} info
     * @param {string|null} base The recipe's family
     */
    #renderLoraRow(lora, info, base) {
        const title = info?.title ?? lora.file.replace(/\.(safetensors|ckpt|pt)$/i, '');
        const mismatch = Boolean(base && info?.base && info.base !== base);
        return html`
            <li class="k-pic-lora" data-k-lora=${lora.file}>
                <span class="k-pic-lora-name" title=${lora.file}>${title}</span>
                ${mismatch ? html`<span class="k-pic-lora-warn">Made for ${LORA_BASE_NAMES[info?.base ?? ''] ?? info?.base}</span>` : nothing}
                <input type="number" class="k-pic-lora-strength" step="0.05" min="-10" max="10" inputmode="decimal"
                       aria-label=${`Strength of ${title}`} .value=${String(lora.strength)}
                       @change=${(/** @type {Event} */ e) => this.#setStrength(lora.file, e)}>
                <button type="button" class="k-pic-iconbtn" aria-label=${`Remove ${title}`} title="Remove"
                        @click=${() => this.#removeLora(lora.file)}>${icons.close}</button>
            </li>`;
    }

    /** @param {Event} event The picker's change */
    #onAddLora = (event) => {
        const select = /** @type {HTMLSelectElement} */ (event.currentTarget);
        const info = this._loraList?.find(l => l.file === select.value);
        if (info) this.#addLora(info);
        select.value = '';
    };

    #renderSizeAndSeed() {
        const sizes = sizesFor(this.#recipe);
        return html`
            <div class="k-pic-pair">
                <section class="k-pic-field">
                    <label class="k-pic-label" for="k-pic-size">Size</label>
                    <select id="k-pic-size" class="k-pic-select k-pic-size"
                            @change=${(/** @type {Event} */ e) => { this._size = /** @type {HTMLSelectElement} */ (e.currentTarget).value; }}>
                        ${sizes.map(size => html`<option value=${size} ?selected=${size === this._size}>${size.replace('x', ' × ')}</option>`)}
                    </select>
                </section>
                <section class="k-pic-field">
                    <span class="k-pic-label" id="k-pic-seed-label">Seed</span>
                    <div class="k-pic-seed" role="group" aria-labelledby="k-pic-seed-label">
                        <div class="k-pic-segment">
                            <button type="button" class="k-pic-seg${this._seedPinned ? '' : ' is-on'}" aria-pressed=${this._seedPinned ? 'false' : 'true'}
                                    @click=${() => { this._seedPinned = false; }}>Random</button>
                            <button type="button" class="k-pic-seg${this._seedPinned ? ' is-on' : ''}" aria-pressed=${this._seedPinned ? 'true' : 'false'}
                                    @click=${() => this.#pinSeed()}>Pinned</button>
                        </div>
                        ${this._seedPinned ? html`
                            <div class="k-pic-seed-row">
                                <input type="number" class="k-pic-seed-input" min="0" step="1" inputmode="numeric"
                                       aria-label="Seed" .value=${String(this._seed)} @input=${this.#onSeedInput}>
                                <button type="button" class="k-pic-iconbtn" aria-label="Roll a new seed" title="Roll a new seed"
                                        @click=${() => { this._seed = rollSeed(); }}>${icons.dice}</button>
                            </div>` : nothing}
                    </div>
                </section>
            </div>`;
    }

    #renderReference() {
        const slot = this.#takesReference;
        const parts = [];
        if (this._reference) {
            parts.push(html`
                <div class="k-pic-ref">
                    <img class="k-pic-ref-thumb" src=${this._reference} alt="" draggable="false">
                    <span class="k-pic-ref-text">${slot ? 'Reference: a picture from this chat' : 'This recipe takes no reference, so the marked picture waits for one that does'}</span>
                    <button type="button" class="k-pic-iconbtn" aria-label="Forget this reference" title="Forget this reference"
                            @click=${() => { setPendingReference(''); this._reference = ''; }}>${icons.close}</button>
                </div>`);
        }
        if (slot && !this._reference) {
            parts.push(html`
                <label class="k-pic-switch">
                    <input type="checkbox" class="k-pic-switch-input" .checked=${this._useReference}
                           ?disabled=${!this.character?.avatar}
                           @change=${(/** @type {Event} */ e) => { this._useReference = /** @type {HTMLInputElement} */ (e.currentTarget).checked; }}>
                    <span class="k-pic-switch-track" aria-hidden="true"></span>
                    <span class="k-pic-switch-text">Use the card's art as reference</span>
                </label>`);
        }
        return parts.length ? html`<section class="k-pic-field k-pic-refs">${parts}</section>` : nothing;
    }

    #renderBlockerLine() {
        const blocker = this.#blocker;
        /** @type {Record<string, string>} */
        const lines = {
            needs: 'This recipe needs a node the server does not have.',
            recipe: this._recipes && this._recipes.length === 0 ? '' : 'Choose a recipe.',
            prompt: this._drafting ? '' : 'Write a prompt first.',
        };
        const line = blocker ? lines[blocker] ?? '' : '';
        return line ? html`<p class="k-pic-blocker">${line}</p>` : nothing;
    }
}

if (!customElements.get('k-picture-sheet')) {
    customElements.define('k-picture-sheet', KPictureSheet);
}
