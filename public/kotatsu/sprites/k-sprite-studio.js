/**
 * `<k-sprite-studio>` — a character's expression sprites in Card Studio (Pictures slice F step 4; Card Studio v2 ③).
 *
 * Three variants (SPEC §13: a component grows variants, not forks), one engine:
 * - **`tab`** (v0's Sprites tab, the main nine or all 28 as slots): kept exactly as it was for anything still using it;
 * - **`strip`** (Simple ③, `docs/card-studio-v2.md`): the expressions ARE the page. Big tiles, a page at a time (five
 *   when there is room, two on a phone), the bust set by default; an index of the main nine under it, and the way to
 *   draw or add the missing ones;
 * - **`grid`** (Advanced ③): all 28 in a dense grid, per-tile replace / delete / upload, and the framing knobs.
 *
 * What every variant keeps:
 * - **one slot per expression**: upload / replace / delete, and for an empty slot, what the stage shows instead
 *   (`resolveExpression`: anger stands in for annoyance, joy for amusement, else neutral, else the card art);
 * - **add several images at once** (a file named after an expression goes to that slot) and **import a pack**
 *   (a ZIP of `<label>.png`, stock's format, through stock's route);
 * - **checks on every sprite** it shows: no transparency, touching the top edge (cut hair), touching a side;
 * - **framing knobs** saved on the card (`framing.js`): height and vertical position on the stage, where the
 *   face sits and how far the face chips zoom, with a live preview of the figure and of a face chip; and the
 *   **framing pin** (auto / bust / full body) for a card with both sets (`tab` and `grid`);
 * - **Generate…** (`<k-sprite-generate>`, slice G2): a whole set in two framings from one drawing; the bust lands in
 *   the `bust/` subfolder, and **Touch-up** opens on either set.
 *
 * The contract with the studio (strip and grid): attribute `set` (`bust` | `full`; unset = the bust when the card has
 * one), property `picked` (a label); a click on a filled tile picks it and fires `k-sprite-pick` (bubbling, composed)
 * with `{ label, set, url, fullUrl }`; `openTouchup(folder, label?)` opens Touch-up on a set, on one sprite when a label
 * is given. Uploads in strip and grid land in the set on show.
 *
 * Storage is stock's sprite folder (`sprite-sets.js`), so a set made here works in stock and a stock pack works
 * here. Light DOM; rules in css/sprites.css §5. Edit mode only: a card that does not exist yet has no folder.
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { EXPRESSION_LABELS } from './expression-model.js';
import { DEFAULT_FRAMING, FRAMING_RANGE, faceStyle, readFraming, saveFraming } from './framing.js';
import { bustFolderOf, deleteSprite, forgetSpriteSet, readSpriteSet, spriteFolderFor, uploadSprite, uploadSpritePack } from './sprite-sets.js';
import { loadFrame } from './frame-measure.js';
import './k-sprite-touchup.js';
import './k-sprite-generate.js';
import { FRAMING_PINS, STAGE, cropFor } from './stage-model.js';
import { MAIN_LABELS, countIn, effectiveSet, figureViewBox, gridOrder, pageOf, pageSlice, perPageFor, pickDetail, refitPage, standInFor, stripOrder } from './sprite-studio-model.js';

export { MAIN_LABELS } from './sprite-studio-model.js';

/** The pin control's words (framing.js `pin`). */
const PIN_WORDS = Object.freeze({ auto: 'Auto', bust: 'Bust', full: 'Full body' });

/** The set toggle's words. */
const SET_WORDS = Object.freeze({ bust: 'Bust', full: 'Full body' });

export const SPRITE_STUDIO_TAG = 'k-sprite-studio';

/** Fired (bubbling, composed) when a filled tile is picked; `detail` = `{ label, set, url, fullUrl }`. */
export const SPRITE_PICK_EVENT = 'k-sprite-pick';

/** What the file inputs take. */
const IMAGE_TYPES = 'image/png,image/webp,image/gif';

/** @param {ReturnType<typeof svg>} body */
const icon = body => html`<svg class="k-sprite-studio__icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = {
    prev: icon(svg`<path d="M10 3L5 8l5 5"/>`),
    next: icon(svg`<path d="M6 3l5 5-5 5"/>`),
    add: icon(svg`<path d="M8 3v10"/><path d="M3 8h10"/>`),
    replace: icon(svg`<path d="M8 11V3"/><path d="M5 6l3-3 3 3"/><path d="M3 11v2h10v-2"/>`),
    remove: icon(svg`<path d="M3 4.5h10"/><path d="M6.5 4.5V3h3v1.5"/><path d="M4.5 4.5l.7 8.5h5.6l.7-8.5"/>`),
    warn: icon(svg`<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3"/><path d="M8 11.5v.01"/>`),
};

/**
 * Pixel checks on one sprite (same origin, so the canvas can be read).
 * @param {string} url
 * @param {{sides?: boolean}} [options] `sides: false` for a bust, whose shoulders meet the sides by design
 * @returns {Promise<string[]>} human warnings, [] when clean
 */
export async function checkSprite(url, { sides: checkSides = true } = {}) {
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
        if (checkSides && sides > 2) warnings.push('Touches a side edge');
    }
    if (Math.min(width, height) < 256) warnings.push(`Small (${width}×${height}): may look soft on the stage`);
    return warnings;
}

/**
 * {@link checkSprite} on every sprite of a set.
 * @param {Map<string, string>} labels label → url
 * @param {{sides?: boolean}} [options]
 * @returns {Promise<Map<string, string[]>>} label → warnings
 */
async function checkSet(labels, options) {
    const entries = await Promise.all([...labels].map(async ([label, url]) => /** @type {[string, string[]]} */ ([label, await checkSprite(url, options)])));
    return new Map(entries);
}

/**
 * What the stage shows for an expression the set does not have.
 * @param {string} label
 * @param {Iterable<string>} have
 * @returns {string} a label, or 'the card art'
 */
function standIn(label, have) {
    return standInFor(label, have) ?? 'the card art';
}

/**
 * The files a change event chose, copied out before the input is cleared (so the same file can be chosen again).
 * @param {Event} e
 * @returns {File[]}
 */
function takeFiles(e) {
    const input = /** @type {HTMLInputElement} */ (e.target);
    const files = [...(input.files ?? [])];
    input.value = '';
    return files;
}

export class KSpriteStudio extends LitElement {
    static properties = {
        /** SPEC §13 — `tab` (v0), `strip` (Simple ③), `grid` (Advanced ③). */
        variant: { type: String, reflect: true },
        /** strip / grid: the set on show, `bust` | `full`; unset = the bust when the card has one, else the full body. */
        set: { type: String },
        /** strip / grid: the picked feeling (a label), highlighted; set by the studio or by a click on a tile. */
        picked: { type: String },
        /** The card being edited (a `characters[]` entry). */
        character: { attribute: false },
        _labels: { state: true },
        _bust: { state: true },
        _showAll: { state: true },
        _busy: { state: true },
        _error: { state: true },
        _note: { state: true },
        _checks: { state: true },
        _bustChecks: { state: true },
        _framing: { state: true },
        _touchup: { state: true },
        _touchupFolder: { state: true },
        _touchupStart: { state: true },
        _generate: { state: true },
        _bustCount: { state: true },
        _page: { state: true },
        _perPage: { state: true },
    };

    constructor() {
        super();
        this.variant = 'tab';
        /** @type {string} */
        this.set = '';
        /** @type {string} */
        this.picked = '';
        /** @type {any} */
        this.character = null;
        /** @type {Map<string, string>} label → url, the full body (the folder itself) */
        this._labels = new Map();
        /** @type {Map<string, string>} label → url, the bust set (`<folder>/bust`) */
        this._bust = new Map();
        /** @type {Map<string, number>} preview url → the stage's crop for it (bust or knees up), once measured */
        this._crops = new Map();
        this._showAll = false;
        /** @type {string} a label being uploaded, 'pack', 'many', or '' */
        this._busy = '';
        this._error = '';
        this._note = '';
        /** @type {Map<string, string[]>} label → warnings, the full body */
        this._checks = new Map();
        /** @type {Map<string, string[]>} label → warnings, the bust set */
        this._bustChecks = new Map();
        this._framing = { ...DEFAULT_FRAMING };
        /** Whether Touch-up is open over the studio. */
        this._touchup = false;
        /** The set Touch-up opens on: the card's folder, or its bust subfolder. */
        this._touchupFolder = '';
        /** The sprite Touch-up opens on (a label), '' = its first. */
        this._touchupStart = '';
        /** Whether Generate is open over the studio. */
        this._generate = false;
        /** Sprites in the card's bust set (`<folder>/bust`). */
        this._bustCount = 0;
        /** strip: the page on show, and how many tiles a page holds at this width. */
        this._page = 0;
        this._perPage = 5;
        /**
         * strip: the page the tiles last showed, the last turn's direction (`-1` back, `1` on, `0` none yet) and how many
         * turns have played. The count's parity alternates the tiles' keyframe between two identical ones, which is how CSS
         * restarts an animation.
         * @type {number | null}
         */
        this._shownPage = null;
        this._turnDir = 0;
        this._turn = 0;
        /** @type {Set<string> | undefined} strip: sprite urls already fetched ahead of a turn. */
        this._warmed = undefined;
        /** @type {Map<string, string>} strip: full-body url → the view box that frames its figure ('' = the canvas) */
        this._figures = new Map();
        this._saveTimer = 0;
        this._loadedFor = '';
        /** Bumped by every {@link reload}: a reload that finds it moved on was overtaken and writes nothing. */
        this._reloadSeq = 0;
        /** @type {ResizeObserver | null} */
        this._resize = null;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        // The strip pages by its own width, not the window's: the studio can sit beside a hero or alone on a phone.
        this._resize = new ResizeObserver(() => this._fitPage());
        this._resize.observe(this);
    }

    disconnectedCallback() {
        this._resize?.disconnect();
        this._resize = null;
        super.disconnectedCallback();
    }

    /** @param {Map<string, unknown>} changed */
    willUpdate(changed) {
        // A pick made elsewhere (the hero's feeling flipper) or a set switch brings the strip to the picked tile.
        if (changed.has('picked') || changed.has('set') || changed.has('variant')) {
            const at = this.picked ? pageOf(this.order(), this.picked, this._perPage) : -1;
            if (at >= 0) this._page = at;
            else if (changed.has('set') || changed.has('variant')) this._page = 0;
        }
        // A page turn from anywhere (‹ ›, a chip, the hero's flipper) plays the strip's turn, in its direction.
        if (this.variant === 'strip' && this._shownPage !== null && this._page !== this._shownPage) {
            this._turnDir = this._page > this._shownPage ? 1 : -1;
            this._turn += 1;
        }
        this._shownPage = this._page;
    }

    /** @param {Map<string, unknown>} changed */
    updated(changed) {
        if (changed.has('character')) void this.reload();
        if (changed.has('variant')) {
            this._fitPage();
            if (this.variant !== 'tab' && this._bust.size && !this._bustChecks.size) void this.checkBust();
        }
        if (this.variant === 'strip') this._warmNeighbours();
    }

    /**
     * strip: fetches the pages either side of the one on show, so a turn's tiles arrive with their pictures instead
     * of fading in empty and popping a moment later. Each url once.
     */
    _warmNeighbours() {
        const labels = this.setLabels;
        const order = stripOrder([...labels.keys()]);
        this._warmed ??= new Set();
        for (const page of [this._page - 1, this._page + 1]) {
            if (page < 0 || page * this._perPage >= order.length) continue;
            for (const label of pageSlice(order, page, this._perPage).labels) {
                const url = labels.get(label);
                if (!url || this._warmed.has(url)) continue;
                this._warmed.add(url);
                const img = new Image();
                img.decoding = 'async';
                img.src = url;
            }
        }
    }

    get folder() {
        return spriteFolderFor(this.character);
    }

    /** strip / grid: the set on show. */
    get currentSet() {
        return effectiveSet(this.set, this._bust.size);
    }

    /** strip / grid: the folder the set on show lives in (uploads land there). */
    get setFolder() {
        return this.currentSet === 'bust' ? bustFolderOf(this.folder) : this.folder;
    }

    /** @returns {Map<string, string>} the set on show, label → url */
    get setLabels() {
        return this.currentSet === 'bust' ? this._bust : this._labels;
    }

    /** @returns {string[]} strip / grid: the tiles, in order */
    order() {
        const have = [...this.setLabels.keys()];
        return this.variant === 'grid' ? gridOrder(have) : stripOrder(have);
    }

    /** Tiles per strip page for the element's width, keeping the picked tile (else the first tile on show) in view. */
    _fitPage() {
        if (this.variant !== 'strip') return;
        const per = perPageFor(this.clientWidth);
        if (per === this._perPage) return;
        this._page = refitPage(this.order(), this._page, this._perPage, per, this.picked);
        this._perPage = per;
        // Re-paging for a new width is not browsing: no turn.
        this._shownPage = this._page;
    }

    /** Re-reads the folder and the card's framing, then checks every sprite. */
    async reload() {
        const folder = this.folder;
        if (!folder) return;
        // Reloads overlap (an upload, Touch-up's save then its close, another card): only the latest one writes.
        const seq = ++this._reloadSeq;
        forgetSpriteSet(folder);
        forgetSpriteSet(bustFolderOf(folder));
        const [set, bust] = await Promise.all([readSpriteSet(folder), readSpriteSet(bustFolderOf(folder))]);
        if (seq !== this._reloadSeq) return;
        this._labels = new Map(set.labels);
        this._bust = new Map(bust.labels);
        this._bustCount = bust.labels.size;
        if (this._loadedFor !== this.character?.avatar) {
            this._framing = readFraming(this.character);
            this._loadedFor = this.character?.avatar ?? '';
        }
        const [checks, bustChecks] = await Promise.all([
            checkSet(set.labels),
            // The bust set shows only in strip and grid; v0's tab never read it.
            this.variant === 'tab' ? null : checkSet(this._bust, { sides: false }),
        ]);
        if (seq !== this._reloadSeq) return;
        this._checks = checks;
        if (bustChecks) this._bustChecks = bustChecks;
    }

    /** Checks every sprite of the bust set. */
    async checkBust() {
        const bust = this._bust;
        const checks = await checkSet(bust, { sides: false });
        // A reload that replaced the set meanwhile brings its own checks.
        if (bust === this._bust) this._bustChecks = checks;
    }

    /**
     * @param {string} label
     * @param {File} file
     * @param {string} [folder] the card's folder (default) or its bust subfolder
     */
    async upload(label, file, folder = this.folder) {
        this._busy = label;
        this._error = '';
        try {
            const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
            await uploadSprite(folder, label, file, `${label}${ext}`);
            this._note = `${label}: uploaded`;
            await this.reload();
        } catch (error) {
            this._error = String(error?.message ?? error);
        } finally {
            this._busy = '';
        }
    }

    /**
     * @param {string} label
     * @param {string} [folder] the card's folder (default) or its bust subfolder
     */
    async removeSprite(label, folder = this.folder) {
        this._busy = label;
        this._error = '';
        try {
            await deleteSprite(folder, label);
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
     * @param {FileList | File[]} files
     * @param {string} [folder] the card's folder (default) or its bust subfolder
     */
    async uploadMany(files, folder = this.folder) {
        this._busy = 'many';
        this._error = '';
        const placed = [], skipped = [];
        try {
            for (const file of [...files]) {
                const label = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
                if (!/^[a-z0-9_-]+$/.test(label)) { skipped.push(file.name); continue; }
                const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
                await uploadSprite(folder, label, file, `${label}${ext}`);
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

    /**
     * @param {File} zip
     * @param {string} [folder] the card's folder (default) or its bust subfolder
     */
    async importPack(zip, folder = this.folder) {
        this._busy = 'pack';
        this._error = '';
        const labelsIn = () => (folder === this.folder ? this._labels : this._bust);
        try {
            const before = new Set(labelsIn().keys());
            await uploadSpritePack(folder, zip, zip.name || 'sprites.zip');
            await this.reload();
            const after = labelsIn();
            const added = [...after.keys()].filter(label => !before.has(label));
            this._note = `Pack imported: ${after.size} expression${after.size === 1 ? '' : 's'}${added.length ? ` (${added.length} new)` : ''}`;
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

    /**
     * Opens Touch-up on a set; on one sprite of it when a label is given (the hero's Fix holes).
     * @param {string} folder the card's folder or its bust subfolder
     * @param {string} [label] the sprite to start on
     */
    openTouchup(folder, label = '') {
        this._touchupFolder = folder;
        this._touchupStart = label;
        this._touchup = true;
    }

    /**
     * strip / grid: picks a filled tile and tells the studio.
     * @param {string} label
     */
    pick(label) {
        this.picked = label;
        this.dispatchEvent(new CustomEvent(SPRITE_PICK_EVENT, {
            bubbles: true,
            composed: true,
            detail: pickDetail(label, this.currentSet, this._labels, this._bust),
        }));
    }

    /**
     * strip / grid: shows the other set.
     * @param {'bust' | 'full'} set
     */
    showSet(set) {
        if (this.currentSet === set) return;
        this.set = set;
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

    /** @returns {string} the sprite the framing preview shows: the full body's neutral, else its first, else '' */
    _previewUrl() {
        return this._labels.get('neutral') ?? this._labels.values().next().value ?? '';
    }

    /** @returns {string[]} the slots to show, in order */
    slotLabels() {
        const base = this._showAll ? [...EXPRESSION_LABELS] : [...MAIN_LABELS];
        for (const label of this._labels.keys()) if (!base.includes(label)) base.push(label);
        return base;
    }

    render() {
        if (!this.character) return nothing;
        if (this.variant === 'strip') return this.renderStrip();
        if (this.variant === 'grid') return this.renderGrid();
        const have = [...this._labels.keys()];
        const previewUrl = this._previewUrl();
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
                ${this.renderMessages()}
                <div class="k-sprite-studio__grid">${this.slotLabels().map(label => this.renderSlot(label, have))}</div>
                ${this.renderFraming(previewUrl)}
                ${this.renderSheets()}
            </section>`;
    }

    renderMessages() {
        return html`
            ${this._error ? html`<p class="k-sprite-studio__error" role="alert">${this._error}</p>` : nothing}
            ${this._note && !this._error ? html`<p class="k-sprite-studio__note" role="status">${this._note}</p>` : nothing}`;
    }

    /** Touch-up and Generate, over the studio. */
    renderSheets() {
        return html`
            <k-sprite-touchup variant="sheet" .folder=${this._touchupFolder || this.folder} .start=${this._touchupStart} ?open=${this._touchup}
                @touchup-saved=${() => void this.reload()} @touchup-close=${() => { this._touchup = false; void this.reload(); }}></k-sprite-touchup>
            <k-sprite-generate variant="sheet" .character=${this.character} ?open=${this._generate}
                @generate-saved=${() => void this.reload()} @generate-close=${() => { this._generate = false; void this.reload(); }}
                @generate-touchup=${(/** @type {CustomEvent} */ e) => this.openTouchup(e.detail.folder)}></k-sprite-generate>`;
    }

    /**
     * The set toggle: "Bust n/m | Full body n/m".
     * @param {ReadonlyArray<string>} universe what the counts are over (the main nine, or all 28)
     */
    renderSetToggle(universe) {
        const on = this.currentSet;
        /** @type {Array<'bust' | 'full'>} */
        const sets = ['bust', 'full'];
        const option = (/** @type {'bust' | 'full'} */ set) => html`<button type="button" role="radio" class="k-sprite-sets__option" data-set=${set}
            aria-checked=${on === set ? 'true' : 'false'} ?data-on=${on === set} @click=${() => this.showSet(set)}>
            ${SET_WORDS[set]} <span class="k-sprite-sets__count">${countIn((set === 'bust' ? this._bust : this._labels).keys(), universe)}/${universe.length}</span></button>`;
        return html`<div class="k-sprite-sets" role="radiogroup" aria-label="Which framing">${sets.map(option)}</div>`;
    }

    /**
     * "Add pictures…": several files at once, into the set on show.
     * @param {'bust' | 'full'} set
     * @param {string} folder
     */
    renderAddMany(set, folder) {
        return this.renderFileButton({
            label: 'Add pictures…', act: 'many', accept: IMAGE_TYPES, multiple: true, busy: this._busy === 'many',
            title: `Name each file after its feeling (joy.png); they go to the ${SET_WORDS[set].toLowerCase()} set`,
            onFiles: files => void this.uploadMany(files, folder),
        });
    }

    /**
     * A header button that takes files (keyboard reachable: the input is visually hidden, never `hidden`).
     * @param {{ label: string, act: string, accept: string, multiple?: boolean, busy: boolean, title?: string, onFiles: (files: File[]) => void }} options
     */
    renderFileButton({ label, act, accept, multiple = false, busy, title = '', onFiles }) {
        return html`<label class="k-sprite-studio__button" data-act=${act} ?data-busy=${busy} title=${title || nothing}>
            <input type="file" class="k-sprite-studio__file" accept=${accept} ?multiple=${multiple} ?disabled=${!!this._busy}
                @change=${(/** @type {Event} */ e) => { const files = takeFiles(e); if (files.length) onFiles(files); }}>
            <span>${label}</span>
        </label>`;
    }

    // ── strip (Simple ③) ─────────────────────────────────────────────────────────────────────────

    renderStrip() {
        const set = this.currentSet;
        const labels = this.setLabels;
        const have = [...labels.keys()];
        const order = stripOrder(have);
        const page = pageSlice(order, this._page, this._perPage);
        const missing = MAIN_LABELS.length - countIn(have);
        const folder = this.setFolder;
        return html`
            <section class="k-sprite-studio k-sprite-studio--strip" aria-label="Sprites">
                <div class="k-sprite-studio__bar">
                    ${this.renderSetToggle(MAIN_LABELS)}
                    ${this.renderMessages()}
                </div>
                <div class="k-sprite-strip" data-set=${set} style=${`--strip-per:${this._perPage}`}>
                    <button type="button" class="k-sprite-strip__nav" data-act="prev" aria-label="Previous feelings" ?disabled=${page.page === 0}
                        @click=${() => { this._page = page.page - 1; }}>${ICONS.prev}</button>
                    <div class="k-sprite-strip__tiles" role="list" aria-label=${`Feelings, ${page.words}`}
                        data-turn=${this._turn ? this._turn % 2 : nothing} data-dir=${this._turnDir < 0 ? 'back' : 'on'}>
                        ${page.labels.map(label => this.renderStripTile(label, set, labels, have, folder))}
                    </div>
                    <button type="button" class="k-sprite-strip__nav" data-act="next" aria-label="Next feelings" ?disabled=${page.page >= page.pages - 1}
                        @click=${() => { this._page = page.page + 1; }}>${ICONS.next}</button>
                </div>
                <div class="k-sprite-strip__foot">
                    <div class="k-sprite-strip__index">
                        <span class="k-sprite-strip__range" aria-live="polite">${page.words}</span>
                        <div class="k-sprite-strip__chips" role="group" aria-label="Jump to a feeling">
                            ${MAIN_LABELS.map(label => html`<button type="button" class="k-sprite-chip" data-label=${label} ?data-filled=${labels.has(label)} ?data-picked=${this.picked === label}
                                aria-label=${`${label}${labels.has(label) ? '' : ', missing'}`} aria-current=${page.labels.includes(label) ? 'true' : nothing}
                                @click=${() => { this._page = pageOf(order, label, this._perPage); }}>${label}</button>`)}
                        </div>
                    </div>
                    <div class="k-sprite-studio__actions">
                        <button type="button" class="k-sprite-studio__button k-sprite-studio__button--primary" data-act="generate" ?disabled=${!!this._busy}
                            title="Draw a whole set, full body and bust, from one drawing (ComfyUI)" @click=${() => { this._generate = true; }}>
                            ${missing ? `Draw the missing ${missing}…` : 'Draw a new set…'}</button>
                        ${this.renderAddMany(set, folder)}
                        <button type="button" class="k-sprite-studio__button" data-act="touchup" ?disabled=${!have.length || !!this._busy}
                            title="Fix leftover background by hand, on every sprite of this set" @click=${() => this.openTouchup(folder, this.picked && labels.has(this.picked) ? this.picked : '')}>Touch-up…</button>
                    </div>
                </div>
                ${this.renderSheets()}
            </section>`;
    }

    /**
     * @param {string} label
     * @param {'bust' | 'full'} set
     * @param {Map<string, string>} labels the set on show
     * @param {string[]} have
     * @param {string} folder where an upload lands
     */
    renderStripTile(label, set, labels, have, folder) {
        const url = labels.get(label);
        const busy = this._busy === label;
        if (!url) {
            const stand = standInFor(label, have);
            const ghost = stand ? labels.get(stand) : '';
            return html`
                <div class="k-sprite-tile" role="listitem" data-label=${label} data-set=${set} data-empty ?data-busy=${busy}>
                    <div class="k-sprite-tile__frame">
                        ${ghost ? html`<img class="k-sprite-tile__ghost" src=${ghost} alt="" draggable="false" decoding="async" style=${this._figureStyle(ghost, set)}>` : nothing}
                        <span class="k-sprite-tile__standin">Shows <b>${stand ?? 'the card art'}</b> for now</span>
                        <label class="k-sprite-studio__button k-sprite-tile__add">
                            <input type="file" class="k-sprite-studio__file" accept=${IMAGE_TYPES} ?disabled=${!!this._busy} aria-label=${`Add ${label}`}
                                @change=${(/** @type {Event} */ e) => { const file = takeFiles(e)[0]; if (file) void this.upload(label, file, folder); }}>
                            ${ICONS.add}<span>Add</span>
                        </label>
                    </div>
                    <span class="k-sprite-tile__name">${label}</span>
                </div>`;
        }
        const warnings = (set === 'bust' ? this._bustChecks : this._checks).get(label) ?? [];
        return html`
            <div class="k-sprite-tile" role="listitem" data-label=${label} data-set=${set} ?data-picked=${this.picked === label} ?data-busy=${busy}>
                <button type="button" class="k-sprite-tile__pick" aria-pressed=${this.picked === label ? 'true' : 'false'} @click=${() => this.pick(label)}>
                    <span class="k-sprite-tile__frame"><img class="k-sprite-tile__art" src=${url} alt="" draggable="false" decoding="async" style=${this._figureStyle(url, set)}></span>
                    <span class="k-sprite-tile__name">${label}</span>
                </button>
                ${warnings.length ? html`<ul class="k-sprite-tile__warnings">${warnings.map(w => html`<li>${w}</li>`)}</ul>` : nothing}
            </div>`;
    }

    /**
     * strip: a full-body tile frames the FIGURE, not the canvas (`figureViewBox`), measured once per url
     * (`frame-measure.js`, shared with the stage). Until the measure lands the tile shows the canvas as before. The bust
     * set and the grid (whose full-body frame is the canvas's own shape) are left as they are.
     * @param {string} url
     * @param {'bust' | 'full'} set
     * @returns {string} an inline style, or ''
     */
    _figureStyle(url, set) {
        if (set !== 'full' || !url) return '';
        if (!this._figures.has(url)) {
            this._figures.set(url, '');
            void loadFrame(url).then(frame => {
                this._figures.set(url, figureViewBox(frame.box));
                this.requestUpdate();
            });
        }
        const view = this._figures.get(url);
        return view ? `object-view-box: ${view};` : '';
    }

    // ── grid (Advanced ③) ────────────────────────────────────────────────────────────────────────

    renderGrid() {
        const set = this.currentSet;
        const labels = this.setLabels;
        const have = [...labels.keys()];
        const folder = this.setFolder;
        const previewUrl = this._previewUrl();
        const pack = this.renderFileButton({
            label: 'Import a pack (.zip)', act: 'pack', accept: '.zip,application/zip', busy: this._busy === 'pack',
            title: `A ZIP of <feeling>.png, into the ${SET_WORDS[set].toLowerCase()} set`,
            onFiles: files => void this.importPack(files[0], folder),
        });
        return html`
            <section class="k-sprite-studio k-sprite-studio--grid" aria-label="Sprites">
                <div class="k-sprite-studio__actions">
                    ${this.renderSetToggle(EXPRESSION_LABELS)}
                    <button type="button" class="k-sprite-studio__button k-sprite-studio__button--primary" data-act="generate" ?disabled=${!!this._busy}
                        title="Draw a whole set, full body and bust, from one drawing (ComfyUI)" @click=${() => { this._generate = true; }}>Generate…</button>
                    ${this.renderAddMany(set, folder)}
                    ${pack}
                    <button type="button" class="k-sprite-studio__button" data-act="touchup" ?disabled=${!this._labels.size || !!this._busy}
                        title="Fix leftover background by hand, on every sprite of the full-body set" @click=${() => this.openTouchup(this.folder)}>Touch-up…</button>
                    ${this._bust.size ? html`<button type="button" class="k-sprite-studio__button" data-act="touchup-bust" ?disabled=${!!this._busy}
                        title="Touch-up on the bust set" @click=${() => this.openTouchup(bustFolderOf(this.folder))}>Touch-up bust…</button>` : nothing}
                </div>
                <p class="k-sprite-studio__lead">Every feeling the story can show. An empty one shows the closest there is: anger stands in for annoyance, joy for amusement, else neutral.</p>
                ${this.renderMessages()}
                <div class="k-sprite-grid" role="list" data-set=${set}>
                    ${gridOrder(have).map(label => this.renderGridTile(label, set, labels, have, folder))}
                </div>
                ${this.renderFraming(previewUrl)}
                ${this.renderSheets()}
            </section>`;
    }

    /**
     * @param {string} label
     * @param {'bust' | 'full'} set
     * @param {Map<string, string>} labels the set on show
     * @param {string[]} have
     * @param {string} folder where an upload lands
     */
    renderGridTile(label, set, labels, have, folder) {
        const url = labels.get(label);
        const busy = this._busy === label;
        const onFile = (/** @type {Event} */ e) => { const file = takeFiles(e)[0]; if (file) void this.upload(label, file, folder); };
        if (!url) {
            return html`
                <div class="k-sprite-tile" role="listitem" data-label=${label} data-set=${set} data-empty ?data-busy=${busy}>
                    <label class="k-sprite-tile__pick" title=${`${label}: upload a picture`}>
                        <input type="file" class="k-sprite-studio__file" accept=${IMAGE_TYPES} ?disabled=${!!this._busy} aria-label=${`Upload ${label}`} @change=${onFile}>
                        <span class="k-sprite-tile__frame">
                            <span class="k-sprite-tile__standin">shows ${standIn(label, have)}</span>
                            <span class="k-sprite-tile__upload">${ICONS.add}<span class="k-sprite-tile__upload-word">Upload</span></span>
                        </span>
                        <span class="k-sprite-tile__name">${label}</span>
                    </label>
                </div>`;
        }
        const warnings = (set === 'bust' ? this._bustChecks : this._checks).get(label) ?? [];
        return html`
            <div class="k-sprite-tile" role="listitem" data-label=${label} data-set=${set} ?data-picked=${this.picked === label} ?data-busy=${busy}>
                <button type="button" class="k-sprite-tile__pick" aria-pressed=${this.picked === label ? 'true' : 'false'} title=${label} @click=${() => this.pick(label)}>
                    <span class="k-sprite-tile__frame">
                        <img class="k-sprite-tile__art" src=${url} alt="" draggable="false" loading="lazy" decoding="async">
                        ${warnings.length ? html`<span class="k-sprite-tile__warn" title=${warnings.join('\n')}>${ICONS.warn}<span class="k-sprite-studio__sr">${warnings.join('. ')}</span></span>` : nothing}
                    </span>
                    <span class="k-sprite-tile__name">${label}</span>
                </button>
                <div class="k-sprite-tile__tools">
                    <label class="k-sprite-tile__tool" title=${`Replace ${label}`}>
                        <input type="file" class="k-sprite-studio__file" accept=${IMAGE_TYPES} ?disabled=${!!this._busy} aria-label=${`Replace ${label}`} @change=${onFile}>
                        ${ICONS.replace}
                    </label>
                    <button type="button" class="k-sprite-tile__tool" data-act="delete" title=${`Delete ${label}`} aria-label=${`Delete ${label}`} ?disabled=${!!this._busy}
                        @click=${() => void this.removeSprite(label, folder)}>${ICONS.remove}</button>
                </div>
            </div>`;
    }

    // ── tab (v0) ─────────────────────────────────────────────────────────────────────────────────

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
