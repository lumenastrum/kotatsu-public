/**
 * `<k-sprite-generate variant="sheet">` — Generate: a card's expression sprites in two framings, from one drawing
 * (docs/handoffs/sprite-generator.md §5, build slice G2). Opens over Card Studio → Sprites, like Touch-up.
 *
 * The steps follow the run on the server (`/api/kotatsu/pictures/sprite-runs`, slice G1):
 * - **Start**: engine, the card's look (prefilled from its Pictures data, editable), how many masters. A ComfyUI that
 *   lacks a model answers with its needs list, shown file by file.
 * - **Masters**: each full-body master cut on the stage colour with its gate in words; pick one, draw more, or upload
 *   your own.
 * - **Face**: only when ComfyUI has no face detector: drag a box around the face on the master.
 * - **Masks**: the derived bust with the proposed masks; brush / eraser nudge either mask, Mark clicks protect a mole
 *   or scar; the labels with their mild / strong rung and mask.
 * - **Expressions**: live progress (SSE); each label appears as it finishes.
 * - **Review**: both framings per label, cut, on the stage colour; reroll one label (new seed, or the other rung);
 *   save onto the card (full body = the card's set, the bust in its `bust/` subfolder).
 *
 * Cancel works while the server is drawing. Closing never stops a run: opening Generate again on the same card
 * reconnects to it (the run id is remembered per card). Network and state rules live in `generate-model.js`.
 * Light DOM; rules in css/sprites.css §7. `open` shows it; `generate-close` fires when it is dismissed,
 * `generate-saved` after a save, `generate-touchup` (`detail.folder`) when the person asks for Touch-up on a set.
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { getRequestHeaders } from '../../script.js';
import { getLook } from '../pictures/look.js';
import { getPicturesSettings } from '../pictures/settings.js';
import { listModels } from '../pictures/jobs-client.js';
import { openSettings } from '../settings/k-settings-modal.js';
import { bustFolderOf, refreshSpriteSets, spriteFolderFor } from './sprite-sets.js';
import {
    BUST_SIZE, ENDED_STAGES, ENGINE_CHOICES, RUNNING_STAGES, STAGES,
    boxFromDrag, createRunClient, fileUrl, forgetRun, gateSummary, labelChoices, labelsPayload, maskOverlay, maskToRgba,
    needsLines, paintedCount, parseColor, progressLine, recallRun, rememberRun, reviewRows, rgbaToMask, rowVersion,
    stepOf, stepper, strokeDisk, watchRun,
} from './generate-model.js';

export const SPRITE_GENERATE_TAG = 'k-sprite-generate';

/** What `/models` says when ComfyUI does not answer at all (server: `ComfyUI is not reachable at …`). */
const UNREACHABLE = /not reachable|isn’t answering|did not answer|ECONNREFUSED/i;

/** @param {ReturnType<typeof svg>} body */
const icon = body => html`<svg class="k-gen__icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = {
    close: icon(svg`<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>`),
    brush: icon(svg`<path d="M10.5 2.5l3 3-6.5 6.5-3.5.5.5-3.5z"/><path d="M9 4l3 3"/>`),
    erase: icon(svg`<path d="M9 3l4 4-5.5 5.5H4.5L2.5 10.5z"/><path d="M6 6l4 4"/><path d="M8 12.5h5.5"/>`),
    mark: icon(svg`<circle cx="8" cy="8" r="2.2"/><circle cx="8" cy="8" r="5.5"/>`),
    reroll: icon(svg`<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5v3h-3"/>`),
    check: icon(svg`<path d="M3.5 8.5l3 3 6-7"/>`),
    warn: icon(svg`<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3.2"/><path d="M8 11.6v.1"/>`),
    upload: icon(svg`<path d="M8 11V3"/><path d="M5 6l3-3 3 3"/><path d="M3 13h10"/>`),
};

/** @typedef {'brush' | 'erase' | 'mark'} MaskTool */
/** @typedef {'features' | 'flush'} MaskType */

export class KSpriteGenerate extends LitElement {
    static properties = {
        /** SPEC §13 — `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** The card (a `characters[]` entry). */
        character: { attribute: false },
        /** Shown while true. */
        open: { type: Boolean, reflect: true },
        _run: { state: true },
        _progress: { state: true },
        _needs: { state: true },
        _error: { state: true },
        _note: { state: true },
        _busy: { state: true },
        _engine: { state: true },
        _positive: { state: true },
        _negative: { state: true },
        _count: { state: true },
        _picked: { state: true },
        _faceBox: { state: true },
        _maskType: { state: true },
        _tool: { state: true },
        _size: { state: true },
        _marks: { state: true },
        _choices: { state: true },
        _masksReady: { state: true },
        _saved: { state: true },
        _confirmDiscard: { state: true },
        _edited: { state: true },
        _leaving: { state: true },
        /** The ComfyUI address that did not answer (Start shows the way to set it up), '' when it answers or is unknown. */
        _comfyDown: { state: true },
        _checking: { state: true },
    };

    constructor() {
        super();
        this.variant = 'sheet';
        /** @type {any} */
        this.character = null;
        this.open = false;
        /** @type {any} the run's public view, null before one starts */
        this._run = null;
        /** @type {any} the latest SSE progress */
        this._progress = null;
        /** @type {any[]} a missing-models answer */
        this._needs = [];
        this._error = '';
        this._note = '';
        this._busy = false;
        this._engine = 'anima';
        this._comfyDown = '';
        this._checking = false;
        this._positive = '';
        this._negative = '';
        /** @type {{ file: string, strength: number, trigger: string }[]} */
        this._loras = [];
        this._count = 4;
        /** @type {number | null} */
        this._picked = null;
        /** @type {{ x: number, y: number, w: number, h: number } | null} */
        this._faceBox = null;
        /** @type {MaskType} */
        this._maskType = 'features';
        /** @type {MaskTool} */
        this._tool = 'brush';
        this._size = 24;
        /** @type {{ x: number, y: number }[]} */
        this._marks = [];
        /** @type {Map<string, { on: boolean, rung: 'mild' | 'strong', mask: 'features' | 'flush' }>} */
        this._choices = new Map();
        this._masksReady = false;
        /** @type {{ folder: string, labels: string[] } | null} */
        this._saved = null;
        this._confirmDiscard = false;
        /** The stage an accepted action is leaving (its buttons stay off until the run moves on); '' = none. */
        this._leaving = '';
        this._leavingRun = '';
        /** @type {Record<MaskType, Uint8Array | null>} */
        this._masks = { features: null, flush: null };
        /** @type {Record<MaskType, boolean>} */
        this._edited = { features: false, flush: false };
        /** The run the masks were loaded for. */
        this._masksFor = '';
        /** @type {(() => void) | null} */
        this._stopWatch = null;
        this._loadedFor = null;
        /** @type {{ kind: 'face', x: number, y: number } | { kind: 'brush', last: number[] } | null} */
        this._drag = null;
        /** @type {number[] | null} */
        this._hover = null;
        this._paintQueued = 0;
        this._client = createRunClient({ headers: () => getRequestHeaders() });
        this._onKey = (/** @type {KeyboardEvent} */ e) => {
            if (!this.open || e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            this.close();
        };
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('keydown', this._onKey, true);
    }

    disconnectedCallback() {
        window.removeEventListener('keydown', this._onKey, true);
        this._unwatch();
        super.disconnectedCallback();
    }

    // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

    /** The card's avatar file: what a run is remembered by. */
    get _card() {
        return typeof this.character?.avatar === 'string' ? this.character.avatar : '';
    }

    /** @param {Map<string, unknown>} changed */
    updated(changed) {
        if (changed.has('character') && this._loadedFor !== this.character) {
            this._loadedFor = this.character;
            this._resetForCard();
        }
        // Opening with no run: ask ComfyUI up front, so a fresh install meets the way to set it up before Draw.
        if (changed.has('open') && this.open) void this._connect().then(() => { if (this.open && !this._run) void this._probeComfy(); });
        if (changed.has('open') && !this.open) this._unwatch();
        if (['_run', '_maskType', '_marks', '_masksReady'].some(k => changed.has(k))) this._paintSoon();
    }

    /** A new card: its look in the Start form, no run. */
    _resetForCard() {
        this._unwatch();
        const look = getLook(this.character);
        this._positive = look?.positive ?? '';
        this._negative = look?.negative ?? '';
        this._loras = look?.loras ?? [];
        this._run = null;
        this._progress = null;
        this._needs = [];
        this._error = '';
        this._note = '';
        this._saved = null;
        this._masksFor = '';
        this._masksReady = false;
    }

    /** Opening: reconnect to this card's run, if it has one the server still knows. */
    async _connect() {
        this._confirmDiscard = false;
        const id = this._run?.id || recallRun(this._storage(), this._card);
        if (!id) return;
        try {
            const run = await this._client.get(id);
            if (!this.open) return;
            this._setRun(run);
            if (!ENDED_STAGES.has(run.stage)) this._watch(run.id);
        } catch (error) {
            if (/** @type {any} */ (error)?.status === 404) {
                forgetRun(this._storage(), this._card);
                this._run = null;
            } else this._error = this._message(error);
        }
    }

    /** @returns {Storage | null} */
    _storage() {
        try {
            return window.localStorage;
        } catch {
            return null;
        }
    }

    /** @param {string} id */
    _watch(id) {
        this._unwatch();
        this._stopWatch = watchRun(id, {
            state: run => this._setRun(run),
            progress: step => { this._progress = step; },
            lost: () => { this._error = 'The server no longer knows this run.'; },
        }, { get: runId => this._client.get(runId) });
    }

    _unwatch() {
        this._stopWatch?.();
        this._stopWatch = null;
    }

    /** @param {any} run */
    _setRun(run) {
        if (!run?.id) return;
        const before = this._run?.stage;
        this._run = run;
        if (this._leaving && (run.stage !== this._leaving || run.id !== this._leavingRun)) this._leaving = '';
        if (run.stage !== before) {
            this._confirmDiscard = false;
            if (!RUNNING_STAGES.has(run.stage)) this._progress = null;
            if (run.stage === STAGES.PICK && !run.masters?.some((/** @type {any} */ m) => m.seed === this._picked)) this._picked = null;
            if (run.stage === STAGES.FACE) this._faceBox = null;
        }
        if (run.stage === STAGES.MASKS && this._masksFor !== run.id) void this._loadMasks(run);
        if (ENDED_STAGES.has(run.stage)) this._unwatch();
    }

    // ── actions ──────────────────────────────────────────────────────────────────────────────────

    /**
     * Whether the person's ComfyUI answers (the picture sheet's check: its model list). Only "not reachable" marks it
     * down; any other failure leaves the Start step as it is and lets Draw speak for itself.
     * @param {boolean} [fresh]
     */
    async _probeComfy(fresh = false) {
        const comfy = this._comfy();
        this._checking = true;
        try {
            const answer = await listModels(comfy, { fresh });
            this._comfyDown = !answer?.ok && UNREACHABLE.test(String(answer?.message ?? '')) ? (comfy.url || 'its address') : '';
        } catch {
            this._comfyDown = '';
        } finally {
            this._checking = false;
        }
    }

    /** Settings → Pictures sits under Card Studio: both close first (the run, if any, keeps going on the server). */
    async _setUpComfy() {
        this.close();
        const { closeStudio } = await import('../studio/k-card-studio.js');
        closeStudio();
        openSettings({ tab: 'pictures' });
    }

    /** The person's ComfyUI (Pictures settings), sent with every request like the picture sheet's jobs. */
    _comfy() {
        const comfy = getPicturesSettings()?.comfy;
        return { url: comfy?.url ?? '', auth: comfy?.auth ?? '' };
    }

    /** @param {unknown} error */
    _message(error) {
        return String(/** @type {any} */ (error)?.message ?? error);
    }

    /**
     * Runs one request with the busy flag and the error line.
     * @param {() => Promise<void>} job
     */
    async _do(job) {
        if (this._busy) return;
        this._busy = true;
        this._error = '';
        try {
            await job();
        } catch (error) {
            this._error = this._message(error);
        } finally {
            this._busy = false;
        }
    }

    async start() {
        await this._do(async () => {
            this._needs = [];
            this._saved = null;
            const name = typeof this.character?.name === 'string' ? this.character.name : '';
            try {
                const { run } = await this._client.start({
                    character: name,
                    engine: this._engine,
                    look: { positive: this._positive.trim(), negative: this._negative.trim(), loras: this._loras },
                    masters: this._count,
                    comfy: this._comfy(),
                });
                rememberRun(this._storage(), this._card, run.id);
                this._masksFor = '';
                this._masksReady = false;
                this._marks = [];
                this._picked = null;
                this._progress = null;
                this._setRun(run);
                this._watch(run.id);
            } catch (error) {
                if (/** @type {any} */ (error)?.code === 'server_unreachable') this._comfyDown = this._comfy().url || 'its address';
                if (/** @type {any} */ (error)?.code === 'needs') {
                    this._needs = /** @type {any} */ (error).needs;
                    throw new Error('This ComfyUI is missing files the engine needs (listed below).');
                }
                throw error;
            }
        });
    }

    /**
     * @param {'more' | 'pick' | 'face' | 'masks' | 'reroll'} action
     * @param {any} body
     */
    async _act(action, body) {
        const run = this._run;
        if (!run) return;
        await this._do(async () => {
            const from = run.stage;
            const next = await this._client.act(run.id, action, { ...body, comfy: this._comfy() });
            // An accepted action can answer before its stage moves (`face`: the derive moves it after its first
            // await); until it does, the step's buttons stay off so a second click cannot start the step twice.
            if (next?.stage === from) {
                this._leaving = from;
                this._leavingRun = run.id;
            }
            this._setRun(next);
            this._watch(run.id);
        });
    }

    more() {
        void this._act('more', { count: 2 });
    }

    pick() {
        if (this._picked === null) return;
        void this._act('pick', { seed: this._picked });
    }

    /** @param {File} file a PNG of the person's own master */
    async uploadMaster(file) {
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
            reader.readAsDataURL(file);
        });
        await this._act('pick', { upload: data });
    }

    sendFace() {
        if (!this._faceBox) return;
        void this._act('face', { faceBox: this._faceBox });
    }

    async sendMasks() {
        /** @type {Record<string, any>} */
        const body = { marks: this._marks, labels: labelsPayload(this._choices) };
        if (!body.labels.length) {
            this._error = 'Pick at least one expression.';
            return;
        }
        for (const type of /** @type {MaskType[]} */ (['features', 'flush'])) {
            const mask = this._masks[type];
            if (!this._edited[type] || !mask) continue;
            if (paintedCount(mask) < 200) {
                this._error = `The ${type} mask is empty: paint the eyes, brows and mouth back in.`;
                return;
            }
            body[type] = this._maskPng(mask);
        }
        await this._act('masks', body);
    }

    /**
     * @param {string} label
     * @param {{ rung?: string }} [change]
     */
    reroll(label, change = {}) {
        void this._act('reroll', { label, ...change });
    }

    async save() {
        const run = this._run;
        const folder = spriteFolderFor(this.character);
        if (!run || !folder) return;
        await this._do(async () => {
            const answer = await this._client.save(run.id, folder);
            this._setRun(answer.run);
            this._saved = answer.saved;
            refreshSpriteSets(folder);
            this._note = `Saved ${answer.saved.labels.length} expressions to ${answer.saved.folder} (full body) and ${bustFolderOf(answer.saved.folder)} (bust).`;
            this.dispatchEvent(new CustomEvent('generate-saved', { bubbles: true, detail: { folder: answer.saved.folder, labels: answer.saved.labels } }));
        });
    }

    async cancel() {
        const run = this._run;
        if (!run) return;
        await this._do(async () => {
            await this._client.cancel(run.id);
            this._note = 'Cancelled.';
            try {
                this._setRun(await this._client.get(run.id));
            } catch {
                // the stream says it too
            }
        });
    }

    /** A new set: forget the current run (the server keeps its files), back to Start. */
    startOver() {
        this._unwatch();
        forgetRun(this._storage(), this._card);
        this._run = null;
        this._progress = null;
        this._saved = null;
        this._error = '';
        this._note = '';
        this._needs = [];
        this._masksFor = '';
        this._masksReady = false;
        this._marks = [];
        this._confirmDiscard = false;
    }

    close() {
        this._unwatch();
        this.open = false;
        this.dispatchEvent(new CustomEvent('generate-close', { bubbles: true }));
    }

    // ── masks ────────────────────────────────────────────────────────────────────────────────────

    /** @param {any} run */
    async _loadMasks(run) {
        this._masksFor = run.id;
        this._masksReady = false;
        this._edited = { features: false, flush: false };
        this._marks = [];
        this._choices = labelChoices(run);
        try {
            const [features, flush] = await Promise.all(['features', 'flush'].map(t => this._readMask(fileUrl(run.id, `masks/${t}.png`, run.updatedAt))));
            this._masks = { features, flush };
            this._masksReady = true;
        } catch (error) {
            this._masksFor = '';
            this._error = `The proposed masks could not be read: ${this._message(error)}`;
        }
    }

    /**
     * An opaque grey PNG → a mask (opaque, so the canvas's premultiplication changes nothing).
     * @param {string} url
     * @returns {Promise<Uint8Array>}
     */
    async _readMask(url) {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = BUST_SIZE;
        canvas.height = BUST_SIZE;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('no canvas');
        context.drawImage(image, 0, 0, BUST_SIZE, BUST_SIZE);
        return rgbaToMask(context.getImageData(0, 0, BUST_SIZE, BUST_SIZE).data);
    }

    /** @param {Uint8Array} mask @returns {string} a PNG data url (opaque grey, white = repaint) */
    _maskPng(mask) {
        const canvas = document.createElement('canvas');
        canvas.width = BUST_SIZE;
        canvas.height = BUST_SIZE;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no canvas');
        context.putImageData(new ImageData(/** @type {Uint8ClampedArray<ArrayBuffer>} */ (maskToRgba(mask)), BUST_SIZE, BUST_SIZE), 0, 0);
        return canvas.toDataURL('image/png');
    }

    resetMasks() {
        const run = this._run;
        if (!run) return;
        this._masksFor = '';
        void this._loadMasks(run);
    }

    /** @param {string} name a theme token @param {number[]} fallback */
    _token(name, fallback) {
        return parseColor(getComputedStyle(this).getPropertyValue(name), fallback);
    }

    _paintSoon() {
        if (this._paintQueued) return;
        this._paintQueued = requestAnimationFrame(() => {
            this._paintQueued = 0;
            this._paint();
        });
    }

    /** The mask being edited, tinted, and the protected marks. Display only. */
    _paint() {
        const canvas = /** @type {HTMLCanvasElement | null} */ (this.querySelector('.k-gen__overlay'));
        const mask = this._masks[this._maskType];
        if (!canvas || !mask || !this._masksReady) return;
        const context = canvas.getContext('2d');
        if (!context) return;
        const rgb = this._maskType === 'flush' ? this._token('--k-rose', [255, 122, 184]) : this._token('--k-accent', [120, 160, 255]);
        context.putImageData(new ImageData(/** @type {Uint8ClampedArray<ArrayBuffer>} */ (maskOverlay(mask, rgb, 0.55)), BUST_SIZE, BUST_SIZE), 0, 0);
        const markRgb = this._token('--k-warning', [255, 200, 90]);
        for (const m of this._marks) {
            context.beginPath();
            context.arc(m.x, m.y, 9, 0, Math.PI * 2);
            context.fillStyle = `rgb(${markRgb.join(',')})`;
            context.fill();
            context.lineWidth = 3;
            context.strokeStyle = '#000';
            context.stroke();
        }
        this._paintCursor();
    }

    /** The brush ring under the pointer. */
    _paintCursor() {
        const canvas = /** @type {HTMLCanvasElement | null} */ (this.querySelector('.k-gen__cursor'));
        const context = canvas?.getContext('2d');
        if (!canvas || !context) return;
        context.clearRect(0, 0, BUST_SIZE, BUST_SIZE);
        if (!this._hover || this._tool === 'mark') return;
        const [x, y] = this._hover;
        context.lineWidth = 2.5;
        context.strokeStyle = '#000';
        context.beginPath();
        context.arc(x, y, this._size / 2 + 2, 0, Math.PI * 2);
        context.stroke();
        context.strokeStyle = '#fff';
        context.beginPath();
        context.arc(x, y, this._size / 2, 0, Math.PI * 2);
        context.stroke();
    }

    /**
     * Pointer → bust pixels.
     * @param {PointerEvent} e
     * @returns {number[]}
     */
    _toBust(e) {
        const box = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
        return [(e.clientX - box.left) * BUST_SIZE / box.width, (e.clientY - box.top) * BUST_SIZE / box.height];
    }

    /** @param {PointerEvent} e */
    _maskDown(e) {
        if (e.button !== 0 || !this._masksReady || this._busy) return;
        const [x, y] = this._toBust(e);
        if (this._tool === 'mark') {
            const near = this._marks.findIndex(m => Math.hypot(m.x - x, m.y - y) < 14);
            this._marks = near >= 0 ? this._marks.filter((_, i) => i !== near) : [...this._marks, { x: Math.round(x), y: Math.round(y) }];
            return;
        }
        const mask = this._masks[this._maskType];
        if (!mask) return;
        /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
        strokeDisk(mask, BUST_SIZE, BUST_SIZE, [x, y], [x, y], this._size / 2, this._tool === 'erase' ? 0 : 255);
        this._edited = { ...this._edited, [this._maskType]: true };
        this._drag = { kind: 'brush', last: [x, y] };
        this._paintSoon();
    }

    /** @param {PointerEvent} e */
    _maskMove(e) {
        const [x, y] = this._toBust(e);
        this._hover = [x, y];
        const drag = this._drag;
        const mask = this._masks[this._maskType];
        if (drag?.kind === 'brush' && mask) {
            strokeDisk(mask, BUST_SIZE, BUST_SIZE, drag.last, [x, y], this._size / 2, this._tool === 'erase' ? 0 : 255);
            drag.last = [x, y];
            this._paintSoon();
        } else this._paintCursor();
    }

    _maskUp() {
        this._drag = null;
    }

    // ── the face box ─────────────────────────────────────────────────────────────────────────────

    /**
     * Pointer → master pixels (the image's natural size).
     * @param {PointerEvent} e
     * @returns {number[]}
     */
    _toMaster(e) {
        const frame = /** @type {HTMLElement} */ (e.currentTarget);
        const img = /** @type {HTMLImageElement | null} */ (frame.querySelector('img'));
        const box = frame.getBoundingClientRect();
        const W = img?.naturalWidth || this._run?.size?.width || 832, H = img?.naturalHeight || this._run?.size?.height || 1216;
        return [(e.clientX - box.left) * W / box.width, (e.clientY - box.top) * H / box.height, W, H];
    }

    /** @param {PointerEvent} e */
    _faceDown(e) {
        if (e.button !== 0 || this._busy) return;
        /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
        const [x, y] = this._toMaster(e);
        this._drag = { kind: 'face', x, y };
    }

    /** @param {PointerEvent} e */
    _faceMove(e) {
        const drag = this._drag;
        if (drag?.kind !== 'face') return;
        const [x, y, W, H] = this._toMaster(e);
        this._faceBox = boxFromDrag(drag.x, drag.y, x, y, W, H) ?? this._faceBox;
    }

    _faceUp() {
        this._drag = null;
    }

    // ── render ───────────────────────────────────────────────────────────────────────────────────

    render() {
        if (!this.open) return nothing;
        const run = this._run;
        const step = stepOf(run);
        const running = !!run && (RUNNING_STAGES.has(run.stage) || this._leaving === run.stage);
        const line = progressLine(this._progress);
        const status = this._error ? html`<span class="k-gen__error" role="alert">${this._error}</span>`
            : running ? html`<span class="k-gen__progress-text">${line.text || 'Starting…'}</span>
                <progress class="k-gen__bar" max=${line.max ?? 1} value=${line.value ?? nothing}></progress>`
                : this._note ? html`<span class="k-gen__note">${this._note}</span>`
                    : step === 'start' && !this._comfyDown && !this._positive.trim() ? html`<span class="k-gen__note" data-why="look">Type who they are first: this card has no Pictures look yet.</span>` : nothing;
        return html`
            <div class="k-gen__scrim" @click=${() => this.close()}></div>
            <section class="k-gen" role="dialog" aria-modal="true" aria-label="Generate sprites" data-step=${step} ?data-busy=${this._busy}>
                <header class="k-gen__head">
                    <h2 class="k-gen__title">Generate sprites</h2>
                    <span class="k-gen__who">${this.character?.name ?? ''}</span>
                    <ol class="k-gen__steps" aria-label="Steps">
                        ${stepper(run).map(s => html`<li class="k-gen__stepdot" data-state=${s.state} aria-current=${s.state === 'current' ? 'step' : nothing}>${s.title}</li>`)}
                    </ol>
                    <button type="button" class="k-gen__btn k-gen__btn--quiet" data-act="close" aria-label="Close Generate" title="Close (the run keeps going)" @click=${() => this.close()}>${ICONS.close}</button>
                </header>
                <div class="k-gen__body">${this.renderStep(step)}</div>
                <footer class="k-gen__foot">
                    <div class="k-gen__status" role="status" aria-live="polite">${status}</div>
                    <div class="k-gen__actions">${this.renderActions(step, running)}</div>
                </footer>
            </section>`;
    }

    /** @param {string} step */
    renderStep(step) {
        switch (step) {
            case 'start': return this.renderStart();
            case 'masters': return this.renderMasters();
            case 'face': return this.renderFace();
            case 'masks': return this.renderMasks();
            case 'expressions':
            case 'review': return this.renderReview();
            default: return this.renderEnded();
        }
    }

    /**
     * @param {string} step
     * @param {boolean} running
     */
    renderActions(step, running) {
        const run = this._run;
        const busy = this._busy;
        const discard = run && !running && !ENDED_STAGES.has(run.stage) ? (this._confirmDiscard
            ? html`<button type="button" class="k-gen__btn k-gen__btn--danger" data-act="discard-confirm" @click=${() => { void this.cancel().then(() => this.startOver()); }}>Discard this run?</button>`
            : html`<button type="button" class="k-gen__btn k-gen__btn--quiet" data-act="discard" ?disabled=${busy} @click=${() => { this._confirmDiscard = true; }}>Discard</button>`) : nothing;
        const cancel = running ? html`<button type="button" class="k-gen__btn" data-act="cancel" ?disabled=${busy} @click=${() => void this.cancel()}>Cancel</button>` : nothing;
        switch (step) {
            case 'start':
                return html`<button type="button" class="k-gen__btn k-gen__btn--primary" data-act="start" ?disabled=${busy || !this._positive.trim() || !!this._comfyDown} @click=${() => void this.start()}>Draw masters</button>`;
            case 'masters':
                return html`${cancel}${discard}
                    <button type="button" class="k-gen__btn" data-act="more" ?disabled=${busy || running} @click=${() => this.more()}>Draw 2 more</button>
                    <label class="k-gen__btn" ?data-disabled=${busy || running}>
                        <input type="file" accept="image/png" hidden ?disabled=${busy || running}
                            @change=${(/** @type {Event} */ e) => { const input = /** @type {HTMLInputElement} */ (e.target); const file = input.files?.[0]; if (file) void this.uploadMaster(file); input.value = ''; }}>
                        ${ICONS.upload}<span>Use my own…</span>
                    </label>
                    <button type="button" class="k-gen__btn k-gen__btn--primary" data-act="pick" ?disabled=${busy || running || this._picked === null} @click=${() => this.pick()}>Use this master</button>`;
            case 'face':
                return html`${cancel}${discard}<button type="button" class="k-gen__btn k-gen__btn--primary" data-act="face" ?disabled=${busy || running || !this._faceBox} @click=${() => this.sendFace()}>Use this face box</button>`;
            case 'masks':
                return html`${discard}<button type="button" class="k-gen__btn k-gen__btn--primary" data-act="generate" ?disabled=${busy || !this._masksReady || !labelsPayload(this._choices).length} @click=${() => void this.sendMasks()}>Paint the expressions</button>`;
            case 'expressions':
                return cancel;
            case 'review':
                return html`${this._saved ? html`
                        <button type="button" class="k-gen__btn" data-act="touchup-full" @click=${() => this._touchup(spriteFolderFor(this.character))}>Touch-up full body…</button>
                        <button type="button" class="k-gen__btn" data-act="touchup-bust" @click=${() => this._touchup(bustFolderOf(spriteFolderFor(this.character)))}>Touch-up bust…</button>
                        <button type="button" class="k-gen__btn" data-act="new" @click=${() => this.startOver()}>New set</button>` : discard}
                    <button type="button" class="k-gen__btn k-gen__btn--primary" data-act="save" ?disabled=${busy} @click=${() => void this.save()}>${this._saved ? 'Save again' : 'Save onto the card'}</button>`;
            default:
                return html`<button type="button" class="k-gen__btn k-gen__btn--primary" data-act="new" @click=${() => this.startOver()}>Start over</button>`;
        }
    }

    /** @param {string} folder */
    _touchup(folder) {
        this.close();
        this.dispatchEvent(new CustomEvent('generate-touchup', { bubbles: true, detail: { folder } }));
    }

    renderStart() {
        const needs = needsLines(this._needs);
        return html`
            ${this._comfyDown ? html`
                <div class="k-gen__warn" role="status" data-why="comfy">
                    <p>Sprites are drawn by ComfyUI on your own computer, and it isn’t answering at <code>${this._comfyDown}</code>. Start it, or set it up first. (An OpenAI or Gemini key can draw pictures, but not a sprite set.)</p>
                    <div class="k-gen__warn-actions">
                        <button type="button" class="k-gen__btn k-gen__btn--primary" data-act="setup-comfy" @click=${() => void this._setUpComfy()}>Set up ComfyUI</button>
                        <button type="button" class="k-gen__btn" data-act="recheck-comfy" ?disabled=${this._checking} @click=${() => void this._probeComfy(true)}>${this._checking ? 'Checking…' : 'Check again'}</button>
                    </div>
                </div>` : nothing}
            <div class="k-gen__start">
                <fieldset class="k-gen__engines">
                    <legend class="k-gen__h">Engine</legend>
                    ${ENGINE_CHOICES.map(e => html`
                        <label class="k-gen__engine" ?data-on=${this._engine === e.id}>
                            <input type="radio" name="k-gen-engine" value=${e.id} .checked=${this._engine === e.id} @change=${() => { this._engine = e.id; this._needs = []; this._error = ''; }}>
                            <span class="k-gen__engine-name">${e.label}</span>
                            <span class="k-gen__engine-hint">${e.hint}</span>
                        </label>`)}
                </fieldset>
                <div class="k-gen__look">
                    <label class="k-gen__field">
                        <span class="k-gen__h">Who they are and what they wear</span>
                        <textarea data-field="positive" rows="4" spellcheck="false" .value=${this._positive}
                            placeholder="1girl, solo, kitsune, red hair, fox ears, yellow eyes, kimono"
                            @input=${(/** @type {Event} */ e) => { this._positive = /** @type {HTMLTextAreaElement} */ (e.target).value; }}></textarea>
                        <span class="k-gen__hint">From the card's Pictures look. Tags for the character and the outfit; framing and background words are added for you.</span>
                    </label>
                    <label class="k-gen__field">
                        <span class="k-gen__h">Leave out</span>
                        <textarea data-field="negative" rows="2" spellcheck="false" .value=${this._negative}
                            @input=${(/** @type {Event} */ e) => { this._negative = /** @type {HTMLTextAreaElement} */ (e.target).value; }}></textarea>
                    </label>
                    ${this._loras.length ? html`<p class="k-gen__loras"><span class="k-gen__h">LoRAs</span>
                        ${this._loras.map(l => html`<span class="k-gen__chip">${l.file.replace(/\.safetensors$/, '')} <b>${l.strength}</b></span>`)}</p>` : nothing}
                    <label class="k-gen__field k-gen__field--row">
                        <span class="k-gen__h">Masters to draw</span>
                        <input type="number" data-field="masters" min="1" max="8" step="1" .value=${String(this._count)}
                            @change=${(/** @type {Event} */ e) => { this._count = Math.min(8, Math.max(1, Math.round(Number(/** @type {HTMLInputElement} */ (e.target).value) || 4))); }}>
                    </label>
                    <p class="k-gen__hint">Each master is a full-body drawing on a lime background, checked for a clean cut. You pick one; the bust and every expression are painted from it, so both framings are the same drawing.</p>
                </div>
                ${needs.length ? html`
                    <div class="k-gen__needs" role="group" aria-label="What this engine needs">
                        <h3 class="k-gen__h">What this engine needs</h3>
                        <ul>${needs.map(n => html`<li data-state=${n.state}>${n.state === 'present' ? ICONS.check : ICONS.warn}<span class="k-gen__needs-role">${n.role}</span><code>${n.file}</code><span class="k-gen__needs-state">${n.text}</span></li>`)}</ul>
                    </div>` : nothing}
            </div>`;
    }

    renderMasters() {
        const run = this._run;
        const masters = Array.isArray(run?.masters) ? run.masters : [];
        const p = this._progress;
        const pending = run?.stage === STAGES.MASTERS ? (Number.isFinite(p?.of) && Number.isFinite(p?.n) ? p.of - p.n + 1 : 1) : 0;
        const picking = run?.stage === STAGES.PICK;
        const deriving = run?.stage === STAGES.BUST;
        const lead = deriving ? 'Deriving the bust from the master you picked…'
            : picking ? 'Pick the master the set is painted from. A clean badge means the cut came out clean; a warning names what to look at.'
                : 'Drawing the masters…';
        return html`
            <p class="k-gen__lead">${lead}</p>
            <div class="k-gen__masters" role="listbox" aria-label="Masters">
                ${masters.map((/** @type {any} */ m) => this.renderMaster(m, picking, (deriving ? run.seed : this._picked) === m.seed))}
                ${Array.from({ length: Math.max(0, pending) }, () => html`
                    <div class="k-gen__master" data-pending aria-hidden="true"><span class="k-gen__art k-gen__art--full"></span><span class="k-gen__seed">drawing…</span></div>`)}
            </div>`;
    }

    /**
     * One master: its cut on the stage colour and its gate in words.
     * @param {any} m `run.masters[]` @param {boolean} picking @param {boolean} picked
     */
    renderMaster(m, picking, picked) {
        const gate = gateSummary(m.gate);
        return html`
            <button type="button" class="k-gen__master" role="option" data-seed=${m.seed} aria-selected=${picked ? 'true' : 'false'} ?data-picked=${picked}
                ?disabled=${!picking} @click=${() => { this._picked = m.seed; }}>
                <span class="k-gen__art k-gen__art--full" style=${`--k-gen-art:url("${fileUrl(this._run.id, m.cutFile, m.seed)}")`}></span>
                <span class="k-gen__gate" ?data-ok=${gate.ok}>${gate.ok ? ICONS.check : ICONS.warn}<span>${gate.words.join('; ')}</span></span>
                <span class="k-gen__seed">seed ${m.seed}</span>
            </button>`;
    }

    renderFace() {
        const run = this._run;
        const box = this._faceBox;
        const W = run?.size?.width ?? 832, H = run?.size?.height ?? 1216;
        const img = /** @type {HTMLImageElement | null} */ (this.querySelector('.k-gen__faceimg'));
        const nw = img?.naturalWidth || W, nh = img?.naturalHeight || H;
        const style = box ? `left:${box.x / nw * 100}%;top:${box.y / nh * 100}%;width:${box.w / nw * 100}%;height:${box.h / nh * 100}%` : '';
        return html`
            <div class="k-gen__face">
                <p class="k-gen__lead">This ComfyUI has no face detector, so the face box is yours: drag a box from the top of the head (bangs and crown in) to just past the chin. The masks are placed from it.</p>
                <div class="k-gen__faceframe" data-cursor="crosshair"
                    @pointerdown=${(/** @type {PointerEvent} */ e) => this._faceDown(e)}
                    @pointermove=${(/** @type {PointerEvent} */ e) => this._faceMove(e)}
                    @pointerup=${() => this._faceUp()}>
                    <img class="k-gen__faceimg" src=${fileUrl(run.id, 'master.png', run.seed)} alt="The master" draggable="false" @load=${() => this.requestUpdate()}>
                    ${box ? html`<div class="k-gen__facebox" style=${style}></div>` : nothing}
                </div>
            </div>`;
    }

    renderMasks() {
        const run = this._run;
        const types = /** @type {Array<[MaskType, string, string]>} */ ([
            ['features', 'Features', 'Eyes, brows and mouth: what most expressions repaint.'],
            ['flush', 'Flush', 'Features plus the cheeks: for blushes and embarrassment.'],
        ]);
        const tools = /** @type {Array<[MaskTool, string, any]>} */ ([['brush', 'Brush', ICONS.brush], ['erase', 'Eraser', ICONS.erase], ['mark', 'Mark', ICONS.mark]]);
        return html`
            <div class="k-gen__masks">
                <div class="k-gen__canvasbox" data-tool=${this._tool}
                    @pointerdown=${(/** @type {PointerEvent} */ e) => this._maskDown(e)}
                    @pointermove=${(/** @type {PointerEvent} */ e) => this._maskMove(e)}
                    @pointerup=${() => this._maskUp()}
                    @pointerleave=${() => { this._hover = null; this._paintCursor(); }}>
                    <img class="k-gen__bust" src=${fileUrl(run.id, 'bust/derived.png', run.crop?.side ?? '')} alt="The derived bust" draggable="false">
                    <canvas class="k-gen__overlay" width=${BUST_SIZE} height=${BUST_SIZE}></canvas>
                    <canvas class="k-gen__cursor" width=${BUST_SIZE} height=${BUST_SIZE}></canvas>
                    ${this._masksReady ? nothing : html`<p class="k-gen__empty">Loading the masks…</p>`}
                </div>
                <aside class="k-gen__side">
                    <h3 class="k-gen__h">Mask</h3>
                    <div class="k-gen__seg" role="radiogroup" aria-label="Mask">
                        ${types.map(([type, label]) => html`<button type="button" role="radio" class="k-gen__btn" data-mask=${type} aria-checked=${this._maskType === type ? 'true' : 'false'} ?data-on=${this._maskType === type}
                            @click=${() => { this._maskType = type; }}>${label}${this._edited[type] ? html`<span class="k-gen__dot" title="nudged"></span>` : nothing}</button>`)}
                    </div>
                    <p class="k-gen__hint">${types.find(t => t[0] === this._maskType)?.[2]} Anything painted is redrawn; the rest of the drawing stays exactly as it is.</p>
                    <h3 class="k-gen__h">Tool</h3>
                    <div class="k-gen__seg" role="radiogroup" aria-label="Tool">
                        ${tools.map(([tool, label, glyph]) => html`<button type="button" role="radio" class="k-gen__btn" data-tool=${tool} aria-checked=${this._tool === tool ? 'true' : 'false'} ?data-on=${this._tool === tool}
                            @click=${() => { this._tool = tool; }}>${glyph}<span>${label}</span></button>`)}
                    </div>
                    <label class="k-gen__row"><span>Size</span><input type="range" min="6" max="96" .value=${String(this._size)}
                        @input=${(/** @type {Event} */ e) => { this._size = Number(/** @type {HTMLInputElement} */ (e.target).value); }}><output>${this._size}</output></label>
                    <p class="k-gen__hint"><b>Mark</b>: click a mole, scar or tattoo to keep it pixel-exact on every expression (click it again to remove).</p>
                    <div class="k-gen__row k-gen__row--wrap">
                        <span class="k-gen__count" data-marks=${this._marks.length}>${this._marks.length} protected mark${this._marks.length === 1 ? '' : 's'}</span>
                        <button type="button" class="k-gen__btn k-gen__btn--quiet" ?disabled=${!this._marks.length} @click=${() => { this._marks = []; }}>Clear marks</button>
                        <button type="button" class="k-gen__btn k-gen__btn--quiet" data-act="reset-masks" ?disabled=${!this._edited.features && !this._edited.flush} @click=${() => this.resetMasks()}>Reset masks</button>
                    </div>
                    <h3 class="k-gen__h">Expressions</h3>
                    <ul class="k-gen__labels">
                        ${[...this._choices].map(([label, c]) => html`
                            <li class="k-gen__label" data-label=${label} ?data-off=${!c.on}>
                                <label class="k-gen__label-name"><input type="checkbox" .checked=${c.on} @change=${(/** @type {Event} */ e) => this._choose(label, { on: /** @type {HTMLInputElement} */ (e.target).checked })}><span>${label}</span></label>
                                <span class="k-gen__seg k-gen__seg--small" role="radiogroup" aria-label=${`${label}: strength`}>
                                    ${['mild', 'strong'].map(rung => html`<button type="button" role="radio" class="k-gen__btn" data-rung=${rung} aria-checked=${c.rung === rung ? 'true' : 'false'} ?data-on=${c.rung === rung} ?disabled=${!c.on}
                                        @click=${() => this._choose(label, { rung: /** @type {'mild' | 'strong'} */ (rung) })}>${rung}</button>`)}
                                </span>
                                <select class="k-gen__select" aria-label=${`${label}: mask`} ?disabled=${!c.on} .value=${c.mask}
                                    @change=${(/** @type {Event} */ e) => this._choose(label, { mask: /** @type {'features' | 'flush'} */ (/** @type {HTMLSelectElement} */ (e.target).value) })}>
                                    <option value="features" ?selected=${c.mask === 'features'}>features</option>
                                    <option value="flush" ?selected=${c.mask === 'flush'}>flush</option>
                                </select>
                            </li>`)}
                    </ul>
                </aside>
            </div>`;
    }

    /**
     * @param {string} label
     * @param {Partial<{ on: boolean, rung: 'mild' | 'strong', mask: 'features' | 'flush' }>} change
     */
    _choose(label, change) {
        const current = this._choices.get(label);
        if (!current) return;
        const next = new Map(this._choices);
        next.set(label, { ...current, ...change });
        this._choices = next;
    }

    renderReview() {
        const run = this._run;
        const rows = reviewRows(run);
        const reviewing = run.stage === STAGES.REVIEW;
        const done = rows.filter(r => r.state === 'done').length;
        const lead = reviewing
            ? `Both framings of every expression, cut, on the stage colour. Reroll any one: a new seed, or its other strength.${run.savedTo ? ` Saved to ${run.savedTo}.` : ''}`
            : `Painting the expressions: ${done} of ${rows.length} done.`;
        return html`
            <p class="k-gen__lead">${lead}</p>
            <div class="k-gen__review">${rows.map(row => this.renderRow(row, reviewing))}</div>`;
    }

    /**
     * One label: both framings, cut, side by side, with its reroll buttons.
     * @param {ReturnType<typeof reviewRows>[number]} row @param {boolean} reviewing
     */
    renderRow(row, reviewing) {
        const run = this._run;
        const ready = row.state === 'done';
        const v = row.label === 'neutral' ? `${run.seed}-${ready}` : rowVersion(row);
        const shot = (/** @type {'bust' | 'full'} */ framing, /** @type {string} */ caption) => html`
            <figure class="k-gen__shot k-gen__shot--${framing}">
                <span class="k-gen__art k-gen__art--${framing}" style=${ready ? `--k-gen-art:url("${fileUrl(run.id, `cut/${framing}/${row.label}.png`, v)}")` : ''}></span>
                <figcaption>${caption}</figcaption>
            </figure>`;
        const otherRung = row.rung === 'mild' ? 'strong' : 'mild';
        const stateWords = { running: 'painting…', error: 'failed', waiting: 'waiting' };
        return html`
            <article class="k-gen__row-card" data-label=${row.label} data-state=${row.state}>
                <header class="k-gen__row-head">
                    <b>${row.label}</b>
                    ${row.rung ? html`<span class="k-gen__tag">${row.rung}</span>` : nothing}
                    <span class="k-gen__words" title=${row.tags}>${row.tags}</span>
                    <span class="k-gen__state" data-state=${row.state}>${/** @type {Record<string, string>} */ (stateWords)[row.state] ?? ''}</span>
                </header>
                <div class="k-gen__pair">${shot('bust', 'Bust')}${shot('full', 'Full body')}</div>
                ${row.error ? html`<p class="k-gen__error">${row.error}</p>` : nothing}
                ${row.label !== 'neutral' && reviewing ? html`
                    <div class="k-gen__row-acts">
                        <button type="button" class="k-gen__btn" data-act="reroll" ?disabled=${this._busy} @click=${() => this.reroll(row.label)}>${ICONS.reroll}<span>New seed</span></button>
                        <button type="button" class="k-gen__btn k-gen__btn--quiet" data-act="rung" ?disabled=${this._busy} @click=${() => this.reroll(row.label, { rung: otherRung })}>Try ${otherRung}</button>
                    </div>` : nothing}
            </article>`;
    }

    renderEnded() {
        const stage = this._run?.stage;
        const text = stage === STAGES.CANCELLED ? 'This run was cancelled.'
            : stage === STAGES.INTERRUPTED ? 'This run stopped when the server restarted in the middle of a step.'
                : `This run stopped: ${this._run?.error ?? 'something went wrong'}.`;
        return html`<div class="k-gen__ended"><p class="k-gen__lead">${text}</p><p class="k-gen__hint">Its files stay in the character's images folder. Start over to draw a new set.</p></div>`;
    }
}

if (!customElements.get(SPRITE_GENERATE_TAG)) customElements.define(SPRITE_GENERATE_TAG, KSpriteGenerate);
