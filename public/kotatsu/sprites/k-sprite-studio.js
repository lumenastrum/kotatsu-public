/**
 * `<k-sprite-studio variant="tab">` — Card Studio's Sprites tab (Pictures slice F, step 4).
 *
 * A character's expression sprites and their framing, for the Sprite look:
 * - **one slot per expression** (the main nine by default, all 28 on request, plus any other label the folder
 *   holds): upload / replace / delete, and for an empty slot, what the stage shows instead (`resolveExpression`:
 *   anger stands in for annoyance, joy for amusement, else neutral, else the card art);
 * - **add several images at once** (a file named after an expression goes to that slot) and **import a pack**
 *   (a ZIP of `<label>.png`, stock's format, through stock's route);
 * - **checks on every sprite** it shows: no transparency, touching the top edge (cut hair), touching a side;
 * - **framing knobs** saved on the card (`framing.js`): height and vertical position on the stage, where the
 *   face sits and how far the face chips zoom, with a live preview of the figure and of a face chip; and the
 *   **framing pin** (auto / bust / full body) for a card with both sets;
 * - **Generate…** (`<k-sprite-generate>`, slice G2): a whole set in two framings from one drawing; the bust lands in
 *   the `bust/` subfolder, and **Touch-up** opens on either set.
 *
 * Storage is stock's sprite folder (`sprite-sets.js`), so a set made here works in stock and a stock pack works
 * here. Light DOM; rules in css/sprites.css. Edit mode only: a card that does not exist yet has no folder.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { EXPRESSION_LABELS, EXPRESSION_VERSION, resolveExpression } from './expression-model.js';
import { DEFAULT_FRAMING, FRAMING_RANGE, faceStyle, readFraming, saveFraming } from './framing.js';
import { bustFolderOf, deleteSprite, forgetSpriteSet, readSpriteSet, spriteFolderFor, uploadSprite, uploadSpritePack } from './sprite-sets.js';
import { loadFrame } from './frame-measure.js';
import './k-sprite-touchup.js';
import './k-sprite-generate.js';
import { FRAMING_PINS, STAGE, cropFor } from './stage-model.js';

/** The pin control's words (framing.js `pin`). */
const PIN_WORDS = Object.freeze({ auto: 'Auto', bust: 'Bust', full: 'Full body' });

export const SPRITE_STUDIO_TAG = 'k-sprite-studio';

/** The slots shown by default: neutral and the roots the resolver falls back to. */
export const MAIN_LABELS = Object.freeze(['neutral', 'joy', 'love', 'anger', 'annoyance', 'sadness', 'surprise', 'fear', 'embarrassment']);


/**
 * Pixel checks on one sprite (same origin, so the canvas can be read).
 * @param {string} url
 * @returns {Promise<string[]>} human warnings, [] when clean
 */
export async function checkSprite(url) {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    try {
        await image.decode();
    } catch {
        return ['Could not be read as an image'];
    }
    const width = image.naturalWidth, height = image.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return [];
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, width, height).data;
    const alphaAt = (/** @type {number} */ x, /** @type {number} */ y) => data[(y * width + x) * 4 + 3];
    let transparent = false;
    for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 250) { transparent = true; break; }
    const warnings = [];
    if (!transparent) warnings.push('No transparent background: the stage will show a box');
    else {
        let top = 0, sides = 0;
        for (let x = 0; x < width; x++) if (alphaAt(x, 0) > 16) top++;
        for (let y = 0; y < height; y++) { if (alphaAt(0, y) > 16) sides++; if (alphaAt(width - 1, y) > 16) sides++; }
        if (top > 2) warnings.push('Touches the top edge: hair or head may be cut');
        if (sides > 2) warnings.push('Touches a side edge');
    }
    if (Math.min(width, height) < 256) warnings.push(`Small (${width}×${height}): may look soft on the stage`);
    return warnings;
}

/**
 * What the stage shows for an expression the set does not have.
 * @param {string} label
 * @param {Iterable<string>} have
 * @returns {string} a label, or 'the card art'
 */
function standIn(label, have) {
    const found = resolveExpression({ v: EXPRESSION_VERSION, key: '', ranked: [[label, 1]] }, have);
    return found ?? 'the card art';
}

export class KSpriteStudio extends LitElement {
    static properties = {
        /** SPEC §13 — `tab` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** The card being edited (a `characters[]` entry). */
        character: { attribute: false },
        _labels: { state: true },
        _showAll: { state: true },
        _busy: { state: true },
        _error: { state: true },
        _note: { state: true },
        _checks: { state: true },
        _framing: { state: true },
        _touchup: { state: true },
        _touchupFolder: { state: true },
        _generate: { state: true },
        _bustCount: { state: true },
    };

    constructor() {
        super();
        this.variant = 'tab';
        /** @type {any} */
        this.character = null;
        /** @type {Map<string, string>} label → url */
        this._labels = new Map();
        /** @type {Map<string, number>} preview url → the stage's crop for it (bust or knees up), once measured */
        this._crops = new Map();
        this._showAll = false;
        /** @type {string} a label being uploaded, 'pack', 'many', or '' */
        this._busy = '';
        this._error = '';
        this._note = '';
        /** @type {Map<string, string[]>} label → warnings */
        this._checks = new Map();
        this._framing = { ...DEFAULT_FRAMING };
        /** Whether Touch-up is open over the studio. */
        this._touchup = false;
        /** The set Touch-up opens on: the card's folder, or its bust subfolder. */
        this._touchupFolder = '';
        /** Whether Generate is open over the studio. */
        this._generate = false;
        /** Sprites in the card's bust set (`<folder>/bust`). */
        this._bustCount = 0;
        this._saveTimer = 0;
        this._loadedFor = '';
    }

    createRenderRoot() {
        return this;
    }

    /** @param {Map<string, unknown>} changed */
    updated(changed) {
        if (changed.has('character')) void this.reload();
    }

    get folder() {
        return spriteFolderFor(this.character);
    }

    /** Re-reads the folder and the card's framing, then checks every sprite. */
    async reload() {
        const folder = this.folder;
        if (!folder) return;
        forgetSpriteSet(folder);
        forgetSpriteSet(bustFolderOf(folder));
        const [set, bust] = await Promise.all([readSpriteSet(folder), readSpriteSet(bustFolderOf(folder))]);
        this._labels = new Map(set.labels);
        this._bustCount = bust.labels.size;
        if (this._loadedFor !== this.character?.avatar) {
            this._framing = readFraming(this.character);
            this._loadedFor = this.character?.avatar ?? '';
        }
        const checks = new Map();
        await Promise.all([...set.labels].map(async ([label, url]) => checks.set(label, await checkSprite(url))));
        this._checks = checks;
    }

    /**
     * @param {string} label
     * @param {File} file
     */
    async upload(label, file) {
        this._busy = label;
        this._error = '';
        try {
            const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
            await uploadSprite(this.folder, label, file, `${label}${ext}`);
            this._note = `${label}: uploaded`;
            await this.reload();
        } catch (error) {
            this._error = String(error?.message ?? error);
        } finally {
            this._busy = '';
        }
    }

    /** @param {string} label */
    async removeSprite(label) {
        this._busy = label;
        this._error = '';
        try {
            await deleteSprite(this.folder, label);
            this._note = `${label}: deleted`;
            await this.reload();
        } catch (error) {
            this._error = String(error?.message ?? error);
        } finally {
            this._busy = '';
        }
    }

    /**
     * Several images at once: each file named after a label (`joy.png`, `Anger.webp`) fills that slot; the rest
     * are reported, never guessed.
     * @param {FileList} files
     */
    async uploadMany(files) {
        this._busy = 'many';
        this._error = '';
        const placed = [], skipped = [];
        try {
            for (const file of [...files]) {
                const label = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
                if (!/^[a-z0-9_-]+$/.test(label)) { skipped.push(file.name); continue; }
                const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
                await uploadSprite(this.folder, label, file, `${label}${ext}`);
                placed.push(label);
            }
            this._note = `${placed.length} uploaded${placed.length ? ` (${placed.join(', ')})` : ''}${skipped.length ? `; skipped ${skipped.join(', ')}: name a file after its expression` : ''}`;
            await this.reload();
        } catch (error) {
            this._error = String(error?.message ?? error);
        } finally {
            this._busy = '';
        }
    }

    /** @param {File} zip */
    async importPack(zip) {
        this._busy = 'pack';
        this._error = '';
        try {
            const before = new Set(this._labels.keys());
            await uploadSpritePack(this.folder, zip, zip.name || 'sprites.zip');
            await this.reload();
            const added = [...this._labels.keys()].filter(label => !before.has(label));
            this._note = `Pack imported: ${this._labels.size} expression${this._labels.size === 1 ? '' : 's'}${added.length ? ` (${added.length} new)` : ''}`;
        } catch (error) {
            this._error = String(error?.message ?? error);
        } finally {
            this._busy = '';
        }
    }

    /**
     * A knob moved: preview now, save shortly after.
     * @param {import('./framing.js').FramingKnob} key
     * @param {number} value
     */
    setKnob(key, value) {
        this._framing = { ...this._framing, [key]: value };
        clearTimeout(this._saveTimer);
        this._saveTimer = window.setTimeout(() => void this.saveKnobs(), 450);
    }

    async saveKnobs() {
        try {
            this._framing = await saveFraming(this.character, this._framing);
            this._note = 'Framing saved';
            this._error = '';
        } catch (error) {
            this._error = String(error?.message ?? error);
        }
    }

    resetKnobs() {
        this._framing = { ...DEFAULT_FRAMING, pin: this._framing.pin };
        void this.saveKnobs();
    }

    /**
     * Which framing the stage shows for this card, saved now.
     * @param {string} pin `auto` | `bust` | `full`
     */
    setPin(pin) {
        if (this._framing.pin === pin) return;
        clearTimeout(this._saveTimer);
        this._framing = { ...this._framing, pin };
        void this.saveKnobs();
    }

    /** @param {string} folder the card's folder or its bust subfolder */
    openTouchup(folder) {
        this._touchupFolder = folder;
        this._touchup = true;
    }

    /** The sets line: what the card has in each framing. */
    renderSets() {
        const full = this._labels.size;
        const plural = (/** @type {number} */ n) => `${n} sprite${n === 1 ? '' : 's'}`;
        return html`<p class="k-sprite-studio__sets" data-full=${full} data-bust=${this._bustCount}>
            Full body: <b>${full ? plural(full) : 'none'}</b> · Bust: <b>${this._bustCount ? plural(this._bustCount) : 'none'}</b>
            ${this._bustCount ? html`<span class="k-sprite-studio__sets-hint">(in ${bustFolderOf(this.folder)})</span>` : nothing}
        </p>`;
    }

    /** @returns {string[]} the slots to show, in order */
    slotLabels() {
        const base = this._showAll ? [...EXPRESSION_LABELS] : [...MAIN_LABELS];
        for (const label of this._labels.keys()) if (!base.includes(label)) base.push(label);
        return base;
    }

    render() {
        if (!this.character) return nothing;
        const have = [...this._labels.keys()];
        const previewUrl = this._labels.get('neutral') ?? this._labels.values().next().value ?? '';
        return html`
            <section class="k-sprite-studio" aria-label="Sprites">
                <p class="k-sprite-studio__lead">One picture per feeling for the Sprite look, transparent, full body or bust. The stage shows the closest one there is: anger stands in for annoyance, joy for amusement, else neutral.</p>
                <div class="k-sprite-studio__actions">
                    <button type="button" class="k-sprite-studio__button k-sprite-studio__button--primary" data-act="generate" ?disabled=${!!this._busy}
                        title="Draw a whole set, full body and bust, from one drawing (ComfyUI)" @click=${() => { this._generate = true; }}>Generate…</button>
                    <label class="k-sprite-studio__button" ?data-busy=${this._busy === 'many'}>
                        <input type="file" accept="image/png,image/webp,image/gif" multiple hidden ?disabled=${!!this._busy}
                            @change=${(/** @type {Event} */ e) => { const input = /** @type {HTMLInputElement} */ (e.target); if (input.files?.length) void this.uploadMany(input.files); input.value = ''; }}>
                        <span>Add images…</span>
                    </label>
                    <label class="k-sprite-studio__button" ?data-busy=${this._busy === 'pack'}>
                        <input type="file" accept=".zip,application/zip" hidden ?disabled=${!!this._busy}
                            @change=${(/** @type {Event} */ e) => { const input = /** @type {HTMLInputElement} */ (e.target); const file = input.files?.[0]; if (file) void this.importPack(file); input.value = ''; }}>
                        <span>Import a pack (.zip)</span>
                    </label>
                    <button type="button" class="k-sprite-studio__button" data-act="touchup" ?disabled=${!have.length || !!this._busy}
                        title="Fix leftover background by hand, on every sprite of the set" @click=${() => this.openTouchup(this.folder)}>Touch-up…</button>
                    ${this._bustCount ? html`<button type="button" class="k-sprite-studio__button" data-act="touchup-bust" ?disabled=${!!this._busy}
                        title="Touch-up on the bust set" @click=${() => this.openTouchup(bustFolderOf(this.folder))}>Touch-up bust…</button>` : nothing}
                    <button type="button" class="k-sprite-studio__button k-sprite-studio__button--quiet" @click=${() => { this._showAll = !this._showAll; }}>
                        ${this._showAll ? 'Show the main nine' : `Show all ${EXPRESSION_LABELS.length}`}
                    </button>
                    <span class="k-sprite-studio__count">${have.length} of ${EXPRESSION_LABELS.length}</span>
                </div>
                ${this.renderSets()}
                ${this._error ? html`<p class="k-sprite-studio__error" role="alert">${this._error}</p>` : nothing}
                ${this._note && !this._error ? html`<p class="k-sprite-studio__note" role="status">${this._note}</p>` : nothing}
                <div class="k-sprite-studio__grid">${this.slotLabels().map(label => this.renderSlot(label, have))}</div>
                ${this.renderFraming(previewUrl)}
                <k-sprite-touchup variant="sheet" .folder=${this._touchupFolder || this.folder} ?open=${this._touchup}
                    @touchup-saved=${() => void this.reload()} @touchup-close=${() => { this._touchup = false; void this.reload(); }}></k-sprite-touchup>
                <k-sprite-generate variant="sheet" .character=${this.character} ?open=${this._generate}
                    @generate-saved=${() => void this.reload()} @generate-close=${() => { this._generate = false; void this.reload(); }}
                    @generate-touchup=${(/** @type {CustomEvent} */ e) => this.openTouchup(e.detail.folder)}></k-sprite-generate>
            </section>`;
    }

    /**
     * @param {string} label
     * @param {string[]} have
     */
    renderSlot(label, have) {
        const url = this._labels.get(label);
        const warnings = this._checks.get(label) ?? [];
        const busy = this._busy === label;
        return html`
            <div class="k-sprite-slot" data-label=${label} ?data-empty=${!url} ?data-busy=${busy}>
                <div class="k-sprite-slot__art" style=${url ? `--k-sprite-slot-art:url("${url}")` : ''}>
                    ${url ? nothing : html`<span class="k-sprite-slot__standin">Shows ${standIn(label, have)}</span>`}
                </div>
                <div class="k-sprite-slot__name">${label}</div>
                ${warnings.length ? html`<ul class="k-sprite-slot__warnings">${warnings.map(w => html`<li>${w}</li>`)}</ul>` : nothing}
                <div class="k-sprite-slot__actions">
                    <label class="k-sprite-slot__button">
                        <input type="file" accept="image/png,image/webp,image/gif" hidden ?disabled=${!!this._busy}
                            @change=${(/** @type {Event} */ e) => { const input = /** @type {HTMLInputElement} */ (e.target); const file = input.files?.[0]; if (file) void this.upload(label, file); input.value = ''; }}>
                        <span>${url ? 'Replace' : 'Upload'}</span>
                    </label>
                    ${url ? html`<button type="button" class="k-sprite-slot__button k-sprite-slot__button--quiet" ?disabled=${!!this._busy}
                        aria-label=${`Delete ${label}`} @click=${() => void this.removeSprite(label)}>Delete</button>` : nothing}
                </div>
            </div>`;
    }

    /** @param {string} previewUrl */
    renderFraming(previewUrl) {
        const f = this._framing;
        /** @type {Array<[import('./framing.js').FramingKnob, string, string, (v: number) => string]>} */
        const knobs = [
            ['scale', 'Height on stage', 'Sizes them against the rest of the cast', v => `${Math.round(v * 100)} %`],
            ['offset', 'Vertical position', 'Up or down on the stage', v => `${v > 0 ? '+' : ''}${Math.round(v * 100)} %`],
            ['faceY', 'Face position', 'Where the face sits, for the face chips', v => `${Math.round(v * 100)} % from the top`],
            ['faceZoom', 'Face zoom', 'How close the face chips crop', v => `${v.toFixed(1)}×`],
        ];
        // The stage's own crop for this character (stage-model.js `cropFor`), so a bust previews whole here too.
        if (previewUrl && !this._crops.has(previewUrl)) {
            this._crops.set(previewUrl, STAGE.crop);
            void loadFrame(previewUrl).then(frame => { this._crops.set(previewUrl, cropFor(frame.bottomCoverage)); this.requestUpdate(); });
        }
        const crop = this._crops.get(previewUrl) ?? STAGE.crop;
        const figure = previewUrl
            ? `background-image:url("${previewUrl}");--crop:${(crop * 100).toFixed(1)}%;--s:${f.scale};--dy:${(f.offset * 100).toFixed(1)}%;`
            : '';
        return html`
            <section class="k-sprite-framing" aria-label="Framing">
                <h3 class="k-sprite-framing__head">Framing</h3>
                <div class="k-sprite-framing__body">
                    <div class="k-sprite-framing__knobs">
                        <div class="k-sprite-framing__knob" data-knob="pin">
                            <span class="k-sprite-framing__label" id="k-sprite-pin-label">Framing on stage</span>
                            <div class="k-sprite-framing__pin" role="radiogroup" aria-labelledby="k-sprite-pin-label">
                                ${FRAMING_PINS.map(pin => html`<button type="button" role="radio" data-pin=${pin} aria-checked=${f.pin === pin ? 'true' : 'false'} ?data-on=${f.pin === pin}
                                    @click=${() => this.setPin(pin)}>${/** @type {Record<string, string>} */ (PIN_WORDS)[pin] ?? pin}</button>`)}
                            </div>
                            <span class="k-sprite-framing__hint">For a card with both sets. Auto: the bust in Stage and Duet, the full body in the Wings.${this._bustCount ? '' : ' This card has no bust set yet.'}</span>
                        </div>
                        ${knobs.map(([key, label, hint, show]) => html`
                            <label class="k-sprite-framing__knob">
                                <span class="k-sprite-framing__label">${label} <output>${show(f[key])}</output></span>
                                <input type="range" data-knob=${key} min=${FRAMING_RANGE[key].min} max=${FRAMING_RANGE[key].max} step=${FRAMING_RANGE[key].step}
                                    .value=${String(f[key])}
                                    @input=${(/** @type {Event} */ e) => this.setKnob(key, Number(/** @type {HTMLInputElement} */ (e.target).value))}>
                                <span class="k-sprite-framing__hint">${hint}</span>
                            </label>`)}
                        <button type="button" class="k-sprite-studio__button k-sprite-studio__button--quiet" @click=${() => this.resetKnobs()}>Reset</button>
                    </div>
                    <div class="k-sprite-framing__preview" aria-hidden="true">
                        <div class="k-sprite-framing__stage">
                            <div class="k-sprite-framing__figure" style=${figure}></div>
                            <div class="k-sprite-framing__ground"></div>
                        </div>
                        <div class="k-sprite-framing__chip" style=${previewUrl ? `background-image:url("${previewUrl}");${faceStyle(f)}` : ''}></div>
                    </div>
                </div>
            </section>`;
    }
}

if (!customElements.get(SPRITE_STUDIO_TAG)) customElements.define(SPRITE_STUDIO_TAG, KSpriteStudio);
