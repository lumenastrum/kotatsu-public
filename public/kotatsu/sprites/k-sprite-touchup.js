/**
 * `<k-sprite-touchup variant="sheet">` — Touch-up: fix what the background cut missed, by hand, on a character's
 * sprite set (Card Studio → Sprites → Touch-up). Port of the standalone prototype onto the pixel core
 * (`pixels/touchup.js`) and the set rules (`touchup-set.js`).
 *
 * - **Tools**: wand (click a leftover chunk of background; Shift = every visible background-coloured pixel), lasso
 *   (smart: only background-coloured pixels inside go; Alt = restore inside, Shift = hard erase), smart brush,
 *   restore (paint the raw drawing back), erase, pan. Compare to raw (hold C), suspects overlay (S), alpha view (M).
 * - **Apply to matching sprites** (A, on by default) and **Sync body** copy an edit / this cut onto the other
 *   sprites that share the drawing; a different pose is skipped by name. One undo reaches every copy.
 * - **No-raw mode**: a set with no `.kotatsu/raw/` (an uploaded set) has no drawing to measure against, so only
 *   erase / lasso-erase / undo / save are on.
 *
 * Pixels cross the wire as exact RGBA (`/api/kotatsu/sprites/pixels`); the browser never decodes a sprite through a
 * canvas and never reads pixels back from one (a canvas premultiplies alpha). `putImageData` is display only.
 * Light DOM; rules in css/sprites.css §6. Opens over Card Studio; `open` shows it, `touchup-close` fires when it is dismissed, `touchup-saved` after a save.
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { getRequestHeaders } from '../../script.js';
import { polygonMask, stampCircle, suspects } from './pixels/touchup.js';
import { TouchupSet, setTolerance } from './touchup-set.js';

export const SPRITE_TOUCHUP_TAG = 'k-sprite-touchup';

const API = '/api/kotatsu/sprites';

/** @typedef {import('./touchup-set.js').Img} Img */
/** @typedef {'wand' | 'lasso' | 'smart' | 'restore' | 'erase' | 'pan'} Tool */
/** @typedef {{ file: string, label: string, width: number, height: number, hasRaw: boolean, touched: boolean }} SetFile */

/** Tools that read the raw drawing. */
const RAW_TOOLS = new Set(['wand', 'smart', 'restore']);

/** @param {ReturnType<typeof svg>} body */
const icon = body => html`<svg class="k-tu__icon" viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = {
    wand: icon(svg`<path d="M3 13L10 6"/><path d="M11 2v2"/><path d="M11 8v2"/><path d="M8 5h2"/><path d="M12 5h2"/>`),
    lasso: icon(svg`<ellipse cx="8" cy="6.5" rx="5.5" ry="3.5" stroke-dasharray="2.5 2"/><path d="M5 9.5c-1 1.5 0 3 2 3.5"/>`),
    smart: icon(svg`<path d="M10.5 2.5l3 3-6.5 6.5-3.5.5.5-3.5z"/><path d="M9 4l3 3"/>`),
    restore: icon(svg`<path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/>`),
    erase: icon(svg`<path d="M9 3l4 4-5.5 5.5H4.5L2.5 10.5z"/><path d="M6 6l4 4"/><path d="M8 12.5h5.5"/>`),
    pan: icon(svg`<path d="M8 2v12"/><path d="M2 8h12"/><path d="M6 4l2-2 2 2"/><path d="M6 12l2 2 2-2"/>`),
    close: icon(svg`<path d="M4 4l8 8"/><path d="M12 4l-8 8"/>`),
};

/**
 * Pointer / key state kept outside Lit: it changes on every mouse move and must not re-render.
 * @typedef {{ pan: true, x: number, y: number } | { lasso: true, pts: number[][] } | { brush: true, mask: Uint8Array, mode: Tool, pts: number[][] }} Drag
 */

export class KSpriteTouchup extends LitElement {
    static properties = {
        /** SPEC §13 — `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** The sprite folder to open (stock's rule: `name` or `name/subfolder`). */
        folder: { type: String },
        /** Shown while true. */
        open: { type: Boolean, reflect: true },
        _files: { state: true },
        _skippedImages: { state: true },
        _cur: { state: true },
        _tool: { state: true },
        _size: { state: true },
        _tol: { state: true },
        _showSus: { state: true },
        _susCount: { state: true },
        _maskView: { state: true },
        _compare: { state: true },
        _applyAll: { state: true },
        _bd: { state: true },
        _msg: { state: true },
        _error: { state: true },
        _busy: { state: true },
        _confirmClose: { state: true },
        _rev: { state: true },
    };

    constructor() {
        super();
        this.variant = 'sheet';
        this.folder = '';
        this.open = false;
        /** @type {SetFile[]} */
        this._files = [];
        /** @type {string[]} */
        this._skippedImages = [];
        this._cur = '';
        /** @type {Tool} */
        this._tool = 'wand';
        this._size = 14;
        this._tol = 14;
        this._showSus = false;
        this._susCount = 0;
        this._maskView = false;
        this._compare = false;
        this._applyAll = true;
        this._bd = 'checker';
        this._msg = '';
        this._error = '';
        this._busy = false;
        this._confirmClose = false;
        /** Bumped after every pixel change so the canvas repaints. */
        this._rev = 0;
        /** @type {TouchupSet | null} */
        this._set = null;
        this._view = { z: 1, tx: 0, ty: 0 };
        /** @type {Drag | null} */
        this._drag = null;
        /** @type {number[] | null} */
        this._hover = null;
        this._space = false;
        /** Edits run one at a time: a copy to other sprites may need to load them first. */
        this._queue = Promise.resolve();
        this._loadedFolder = '';
        this._onKey = (/** @type {KeyboardEvent} */ e) => this._key(e, true);
        this._onKeyUp = (/** @type {KeyboardEvent} */ e) => this._key(e, false);
        this._onResize = () => { this._drawUi(); };
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        window.addEventListener('keydown', this._onKey, true);
        window.addEventListener('keyup', this._onKeyUp, true);
        window.addEventListener('resize', this._onResize);
    }

    disconnectedCallback() {
        window.removeEventListener('keydown', this._onKey, true);
        window.removeEventListener('keyup', this._onKeyUp, true);
        window.removeEventListener('resize', this._onResize);
        super.disconnectedCallback();
    }

    // ── elements ─────────────────────────────────────────────────────────────────────────────────

    /** @param {string} cls @returns {HTMLElement | null} */
    _el(cls) { return /** @type {HTMLElement | null} */ (this.querySelector(`.${cls}`)); }
    get _canvas() { return /** @type {HTMLCanvasElement | null} */ (this._el('k-tu__art')); }
    get _susCanvas() { return /** @type {HTMLCanvasElement | null} */ (this._el('k-tu__sus')); }
    get _uiCanvas() { return /** @type {HTMLCanvasElement | null} */ (this._el('k-tu__ui')); }

    /** @returns {import('./touchup-set.js').TouchupDoc | undefined} */
    get _doc() { return this._set?.docs.get(this._cur); }

    /** Whether the current sprite has its raw drawing. */
    get _hasRaw() { return !!this._doc?.raw; }

    // ── lifecycle ────────────────────────────────────────────────────────────────────────────────

    /** @param {Map<string, unknown>} changed */
    updated(changed) {
        if ((changed.has('open') || changed.has('folder')) && this.open && this.folder && this._loadedFolder !== this.folder) {
            void this._openFolder();
        }
        if (changed.has('open') && this.open) {
            this._confirmClose = false;
        }
        if (changed.has('_bd')) this._applyBackdrop();
        if (['_cur', '_rev', '_maskView', '_compare', '_showSus', '_tol'].some(k => changed.has(k))) this._paint();
    }

    async _openFolder() {
        this._loadedFolder = this.folder;
        this._error = '';
        this._msg = '';
        this._set = null;
        this._cur = '';
        try {
            const response = await fetch(`${API}/set?name=${encodeURIComponent(this.folder)}`);
            if (!response.ok) throw new Error(`The sprite folder could not be read (${response.status}).`);
            const body = await response.json();
            this._files = body.files;
            this._skippedImages = body.skipped ?? [];
            this._set = new TouchupSet(this._files.map(f => f.file), file => this._loadSprite(file));
            if (!this._files.length) { this._error = 'No PNG sprites in this set yet.'; return; }
            await this._openDoc(this._files[0].file);
        } catch (error) {
            this._error = String(/** @type {Error} */ (error)?.message ?? error);
        }
    }

    /**
     * Reads one sprite's exact pixels (cut, and raw when the set has it).
     * @param {string} file
     * @returns {Promise<{ raw: Img | null, cut: Img }>}
     */
    async _loadSprite(file) {
        const info = this._files.find(f => f.file === file);
        const [cut, raw] = await Promise.all([this._pixels(file, 'cut'), info?.hasRaw ? this._pixels(file, 'raw') : Promise.resolve(null)]);
        if (raw && (raw.width !== cut.width || raw.height !== cut.height)) throw new Error(`${file}: the raw drawing and the sprite differ in size`);
        return { raw, cut };
    }

    /**
     * @param {string} file @param {'raw' | 'cut'} which
     * @returns {Promise<Img>}
     */
    async _pixels(file, which) {
        const response = await fetch(`${API}/pixels?name=${encodeURIComponent(this.folder)}&file=${encodeURIComponent(file)}&which=${which}`);
        if (!response.ok) throw new Error(`${file}: could not read the ${which} pixels (${response.status})`);
        const width = Number(response.headers.get('X-Width')), height = Number(response.headers.get('X-Height'));
        const data = new Uint8ClampedArray(await response.arrayBuffer());
        if (data.length !== width * height * 4) throw new Error(`${file}: the ${which} pixels came back the wrong size`);
        return { width, height, data };
    }

    /** @param {string} file */
    async _openDoc(file) {
        if (!this._set) return;
        try {
            const doc = await this._set.ensure(file);
            const previous = this._doc;
            const first = !previous || previous.cut.width !== doc.cut.width || previous.cut.height !== doc.cut.height;
            this._cur = file;
            this._tol = doc.tol;
            if (!doc.raw && RAW_TOOLS.has(this._tool)) this._tool = 'lasso';
            if (!doc.raw) { this._showSus = false; this._compare = false; }
            await this.updateComplete;
            const canvas = this._canvas, sus = this._susCanvas, stage = this._el('k-tu__stage');
            if (canvas && sus && stage) {
                canvas.width = sus.width = doc.cut.width;
                canvas.height = sus.height = doc.cut.height;
                stage.style.width = `${doc.cut.width}px`;
                stage.style.height = `${doc.cut.height}px`;
            }
            if (first) this._fit();
            this._applyBackdrop();
            this._rev++;
        } catch (error) {
            this._error = String(/** @type {Error} */ (error)?.message ?? error);
        }
    }

    // ── view ─────────────────────────────────────────────────────────────────────────────────────

    _applyView() {
        const stage = this._el('k-tu__stage');
        if (!stage) return;
        const { z, tx, ty } = this._view;
        stage.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
        stage.toggleAttribute('data-pixelated', z >= 2);
        const zoom = this._el('k-tu__zoom');
        if (zoom) zoom.textContent = `${Math.round(z * 100)}%`;
        this._drawUi();
    }

    _fit() {
        const d = this._doc, view = this._el('k-tu__view');
        if (!d || !view) return;
        const r = view.getBoundingClientRect();
        const z = Math.min((r.width - 40) / d.cut.width, (r.height - 40) / d.cut.height);
        this._view = { z, tx: (r.width - d.cut.width * z) / 2, ty: (r.height - d.cut.height * z) / 2 };
        this._applyView();
    }

    /** @param {number} f @param {number} cx @param {number} cy */
    _zoomAt(f, cx, cy) {
        const v = this._view;
        const nz = Math.min(32, Math.max(0.1, v.z * f));
        this._view = { z: nz, tx: cx - (cx - v.tx) * (nz / v.z), ty: cy - (cy - v.ty) * (nz / v.z) };
        this._applyView();
    }

    _oneToOne() {
        const view = this._el('k-tu__view');
        if (!view) return;
        const r = view.getBoundingClientRect();
        this._zoomAt(1 / this._view.z, r.width / 2, r.height / 2);
    }

    _applyBackdrop() {
        const stage = this._el('k-tu__stage');
        if (!stage) return;
        stage.style.background = this._bd === 'checker'
            ? 'repeating-conic-gradient(#8a8a8a 0 25%, #c8c8c8 0 50%) 0 0 / 16px 16px'
            : this._bd;
    }

    /** Draws the sprite (or its raw, or its alpha) and the suspects overlay. Display only. */
    _paint() {
        const d = this._doc, canvas = this._canvas, sus = this._susCanvas;
        if (!d || !canvas || !sus) return;
        const context = canvas.getContext('2d');
        const sctx = sus.getContext('2d');
        if (!context || !sctx) return;
        const W = d.cut.width, H = d.cut.height;
        /** @type {Uint8ClampedArray} */
        let src = this._compare && d.raw ? d.raw.data : d.cut.data;
        if (this._maskView && !this._compare) {
            const m = new Uint8ClampedArray(d.cut.data.length);
            for (let i = 0; i < m.length; i += 4) { const a = d.cut.data[i + 3]; m[i] = m[i + 1] = m[i + 2] = a; m[i + 3] = 255; }
            src = m;
        }
        context.putImageData(new ImageData(/** @type {Uint8ClampedArray<ArrayBuffer>} */ (src), W, H), 0, 0);
        sctx.clearRect(0, 0, W, H);
        let count = 0;
        if (this._showSus && !this._compare && d.raw && d.test) {
            const s = suspects(d.raw, d.cut, d.test);
            count = s.count;
            const image = sctx.createImageData(W, H);
            for (let p = 0; p < s.mask.length; p++) if (s.mask[p]) { const i = p * 4; image.data[i] = 255; image.data[i + 1] = 0; image.data[i + 2] = 170; image.data[i + 3] = 230; }
            sctx.putImageData(image, 0, 0);
        }
        if (count !== this._susCount) this._susCount = count;
    }

    // ── edits ────────────────────────────────────────────────────────────────────────────────────

    /**
     * @template T
     * @param {() => Promise<T>} job
     * @returns {Promise<T | undefined>}
     */
    _enqueue(job) {
        const next = this._queue.then(async () => {
            this._busy = true;
            try { return await job(); } catch (error) {
                this._error = String(/** @type {Error} */ (error)?.message ?? error);
                return undefined;
            } finally { this._busy = false; }
        });
        this._queue = next.then(() => undefined, () => undefined);
        return next;
    }

    /** @param {import('./touchup-set.js').Op} op */
    _runOp(op) {
        const set = this._set, file = this._cur;
        if (!set || !file) return Promise.resolve();
        return this._enqueue(async () => {
            this._error = '';
            const r = await set.run(file, op, this._applyAll && this._hasRaw);
            this._msg = r.msg;
            this._rev++;
        });
    }

    _undo() { void this._step('undo'); }
    _redo() { void this._step('redo'); }

    /** @param {'undo' | 'redo'} way */
    _step(way) {
        const set = this._set, file = this._cur;
        if (!set || !file) return Promise.resolve();
        return this._enqueue(async () => {
            const r = await set.step(file, way);
            if (r.stepped) this._msg = r.linked ? `${way === 'undo' ? 'undid' : 'redid'} it on ${r.linked} matching sprite${r.linked > 1 ? 's' : ''} too` : '';
            this._rev++;
        });
    }

    _keep() {
        const set = this._set, file = this._cur;
        if (!set || !file) return;
        void this._enqueue(async () => { this._msg = (await set.keepFigure(file)).msg; this._rev++; });
    }

    _sync() {
        const set = this._set, file = this._cur;
        if (!set || !file) return;
        void this._enqueue(async () => { this._msg = (await set.syncBody(file)).msg; this._rev++; });
    }

    _revert() {
        const set = this._set, file = this._cur;
        if (!set || !file) return;
        void this._enqueue(async () => { await set.revert(file); this._msg = 'reverted to the sprite on disk (Undo brings your edits back)'; this._rev++; });
    }

    /** @param {number} tol */
    _setTol(tol) {
        const d = this._doc;
        if (!d?.raw) return;
        setTolerance(d, tol);
        this._tol = tol;
        this._rev++;
    }

    // ── save ─────────────────────────────────────────────────────────────────────────────────────

    /** @param {import('./touchup-set.js').TouchupDoc} d */
    async _saveDoc(d) {
        const response = await fetch(`${API}/save?name=${encodeURIComponent(this.folder)}&file=${encodeURIComponent(d.file)}`, {
            method: 'POST',
            headers: { ...getRequestHeaders({ omitContentType: true }), 'Content-Type': 'application/octet-stream' },
            body: /** @type {BodyInit} */ (/** @type {unknown} */ (d.cut.data)),
        });
        if (!response.ok) throw new Error(`${d.file}: save failed (${response.status})`);
        const body = await response.json();
        d.dirty = false;
        d.loaded = d.cut.data.slice();
        const info = this._files.find(f => f.file === d.file);
        if (info && body.originalKept) info.touched = true;
        return body;
    }

    /** @param {boolean} all */
    _save(all) {
        const set = this._set;
        if (!set) return Promise.resolve(false);
        return this._enqueue(async () => {
            const targets = all ? set.dirtyDocs() : [this._doc].filter(d => d?.dirty);
            let kept = 0;
            for (const d of targets) if (d && (await this._saveDoc(d)).originalKept) kept++;
            this._msg = targets.length
                ? `saved ${targets.length} sprite${targets.length > 1 ? 's' : ''}${kept ? ` (the original of ${kept} kept in .kotatsu/touchup-original)` : ''}`
                : 'nothing to save';
            this._files = [...this._files];
            this._rev++;
            if (targets.length) this.dispatchEvent(new CustomEvent('touchup-saved', { bubbles: true, detail: { folder: this.folder, files: targets.map(d => d?.file) } }));
            return true;
        });
    }

    _dirtyCount() { return this._set?.dirtyDocs().length ?? 0; }

    // ── closing ──────────────────────────────────────────────────────────────────────────────────

    _requestClose() {
        if (this._dirtyCount()) { this._confirmClose = true; return; }
        this._close();
    }

    _close() {
        this._confirmClose = false;
        this._loadedFolder = '';
        this._set = null;
        this.open = false;
        this.dispatchEvent(new CustomEvent('touchup-close', { bubbles: true }));
    }

    // ── pointer ──────────────────────────────────────────────────────────────────────────────────

    /** @param {PointerEvent} e @returns {number[]} image coordinates */
    _toImg(e) {
        const r = /** @type {HTMLElement} */ (this._el('k-tu__view')).getBoundingClientRect();
        const v = this._view;
        return [(e.clientX - r.left - v.tx) / v.z, (e.clientY - r.top - v.ty) / v.z];
    }

    /** @param {PointerEvent} e */
    _down(e) {
        const d = this._doc, view = this._el('k-tu__view');
        if (!d || !view || this._busy) return;
        view.setPointerCapture(e.pointerId);
        if (e.button === 1 || this._space || this._tool === 'pan') { this._drag = { pan: true, x: e.clientX, y: e.clientY }; return; }
        if (e.button !== 0) return;
        const [x, y] = this._toImg(e);
        if (this._tool === 'wand') { void this._runOp({ kind: 'wand', x: Math.floor(x), y: Math.floor(y), global: e.shiftKey }); return; }
        if (this._tool === 'lasso') { this._drag = { lasso: true, pts: [[x, y]] }; return; }
        const mask = new Uint8Array(d.cut.width * d.cut.height);
        stampCircle(mask, d.cut.width, d.cut.height, x, y, this._size / 2);
        this._drag = { brush: true, mask, mode: this._tool, pts: [[x, y]] };
        this._drawUi();
    }

    /** @param {PointerEvent} e */
    _move(e) {
        const d = this._doc;
        const [x, y] = this._toImg(e);
        this._hover = [x, y];
        if (d) {
            const px = Math.floor(x), py = Math.floor(y);
            const W = d.cut.width;
            if (px >= 0 && py >= 0 && px < W && py < d.cut.height) {
                const i = (py * W + px) * 4;
                const pos = this._el('k-tu__pos'), pix = this._el('k-tu__pix');
                if (pos) pos.textContent = `${px}, ${py}`;
                if (pix) {
                    const rgb = d.raw ? `raw ${d.raw.data[i]},${d.raw.data[i + 1]},${d.raw.data[i + 2]}` : `rgb ${d.cut.data[i]},${d.cut.data[i + 1]},${d.cut.data[i + 2]}`;
                    pix.textContent = `${rgb}  alpha ${d.cut.data[i + 3]}${d.test?.(py * W + px) ? '  (background colour)' : ''}`;
                }
            }
        }
        const g = this._drag;
        if (g && 'pan' in g) {
            this._view = { ...this._view, tx: this._view.tx + e.clientX - g.x, ty: this._view.ty + e.clientY - g.y };
            g.x = e.clientX; g.y = e.clientY;
            this._applyView();
            return;
        }
        if (g && 'lasso' in g) g.pts.push([x, y]);
        if (g && 'brush' in g && d) {
            const [lx, ly] = g.pts[g.pts.length - 1];
            const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(1, this._size / 4)));
            for (let k = 1; k <= steps; k++) stampCircle(g.mask, d.cut.width, d.cut.height, lx + (x - lx) * k / steps, ly + (y - ly) * k / steps, this._size / 2);
            g.pts.push([x, y]);
        }
        this._drawUi();
    }

    /** @param {PointerEvent} e */
    _up(e) {
        const d = this._doc;
        const g = this._drag;
        this._drag = null;
        if (!g || !d) { this._drawUi(); return; }
        if ('lasso' in g && g.pts.length > 2) {
            const mask = polygonMask(d.cut.width, d.cut.height, g.pts);
            void this._runOp({ kind: 'mask', mask, mode: e.altKey ? 'restore' : e.shiftKey || !d.raw ? 'erase' : 'smart' });
        }
        if ('brush' in g) void this._runOp({ kind: 'mask', mask: g.mask, mode: /** @type {'smart' | 'restore' | 'erase'} */ (g.mode) });
        this._drawUi();
    }

    _drawUi() {
        const view = this._el('k-tu__view'), ui = this._uiCanvas;
        if (!view || !ui) return;
        const r = view.getBoundingClientRect();
        if (ui.width !== Math.round(r.width) || ui.height !== Math.round(r.height)) { ui.width = Math.round(r.width); ui.height = Math.round(r.height); }
        const c = ui.getContext('2d');
        if (!c) return;
        c.clearRect(0, 0, ui.width, ui.height);
        const { z, tx, ty } = this._view;
        const sx = (/** @type {number} */ x) => tx + x * z, sy = (/** @type {number} */ y) => ty + y * z;
        c.lineWidth = 1.5;
        const g = this._drag;
        if (g && 'lasso' in g) {
            c.strokeStyle = '#ff7ab8'; c.setLineDash([6, 4]);
            c.beginPath();
            g.pts.forEach(([x, y], k) => k ? c.lineTo(sx(x), sy(y)) : c.moveTo(sx(x), sy(y)));
            c.closePath(); c.stroke(); c.setLineDash([]);
        }
        if (g && 'brush' in g) {
            c.strokeStyle = g.mode === 'restore' ? 'rgba(123,224,166,.55)' : g.mode === 'erase' ? 'rgba(255,155,107,.55)' : 'rgba(255,122,184,.55)';
            c.lineCap = c.lineJoin = 'round'; c.lineWidth = this._size * z;
            c.beginPath();
            g.pts.forEach(([x, y], k) => k ? c.lineTo(sx(x), sy(y)) : c.moveTo(sx(x), sy(y)));
            if (g.pts.length === 1) c.lineTo(sx(g.pts[0][0]) + 0.1, sy(g.pts[0][1]));
            c.stroke(); c.lineWidth = 1.5;
        }
        if (this._hover && ['smart', 'restore', 'erase'].includes(this._tool) && !this._space) {
            const [hx, hy] = this._hover;
            c.strokeStyle = '#fff'; c.beginPath(); c.arc(sx(hx), sy(hy), this._size / 2 * z, 0, Math.PI * 2); c.stroke();
            c.strokeStyle = '#000'; c.beginPath(); c.arc(sx(hx), sy(hy), this._size / 2 * z + 1.5, 0, Math.PI * 2); c.stroke();
        }
    }

    // ── keys ─────────────────────────────────────────────────────────────────────────────────────

    /**
     * @param {KeyboardEvent} e @param {boolean} down
     */
    _key(e, down) {
        if (!this.open) return;
        const k = e.key.toLowerCase();
        if (!down) {
            if (k === ' ') { this._space = false; this._syncCursor(); }
            if (k === 'c' && this._compare) { this._compare = false; }
            return;
        }
        const target = e.target;
        if (target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'color' && target.type !== 'checkbox') return;
        const mod = e.ctrlKey || e.metaKey;
        const own = () => { e.preventDefault(); e.stopPropagation(); };
        if (k === 'escape') { own(); this._requestClose(); return; }
        if (mod && k === 's') { own(); void this._save(e.shiftKey); return; }
        if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { own(); this._redo(); return; }
        if (mod && k === 'z') { own(); this._undo(); return; }
        if (mod || e.altKey) return;
        const raw = this._hasRaw;
        /** @type {Record<string, Tool>} */
        const tools = { w: 'wand', l: 'lasso', b: 'smart', r: 'restore', e: 'erase', h: 'pan' };
        if (k === ' ') { own(); this._space = true; this._syncCursor(); return; }
        if (k === 'c' && !e.repeat) { if (raw) { own(); this._compare = true; } return; }
        if (tools[k]) { own(); this._pickTool(tools[k]); return; }
        if (k === '[') { own(); this._size = Math.max(2, this._size - 2); this._drawUi(); return; }
        if (k === ']') { own(); this._size = Math.min(80, this._size + 2); this._drawUi(); return; }
        if (k === 's' && raw) { own(); this._showSus = !this._showSus; return; }
        if (k === 'm') { own(); this._maskView = !this._maskView; return; }
        if (k === 'f') { own(); this._fit(); return; }
        if (k === '1') { own(); this._oneToOne(); return; }
        if (k === 'k') { own(); this._keep(); return; }
        if (k === 'a' && raw) {
            own();
            this._applyAll = !this._applyAll;
            this._msg = this._applyAll ? 'edits also land on matching sprites' : 'edits stay on this sprite';
            return;
        }
        if (k === 'arrowdown' || k === 'arrowup') {
            const i = this._files.findIndex(f => f.file === this._cur);
            const next = this._files[i + (k === 'arrowdown' ? 1 : -1)];
            if (next) { own(); void this._openDoc(next.file); }
        }
    }

    _syncCursor() {
        const view = this._el('k-tu__view');
        if (view) view.dataset.cursor = this._space || this._tool === 'pan' ? 'grab' : 'crosshair';
    }

    /** @param {Tool} tool */
    _pickTool(tool) {
        if (RAW_TOOLS.has(tool) && !this._hasRaw) return;
        this._tool = tool;
        this._syncCursor();
        this._drawUi();
    }

    // ── render ───────────────────────────────────────────────────────────────────────────────────

    /** @param {SetFile} f */
    renderFile(f) {
        const doc = this._set?.docs.get(f.file);
        const badge = doc?.dirty ? 'edited' : f.touched ? 'touched' : '';
        return html`<button type="button" class="k-tu__file" ?data-cur=${f.file === this._cur} @click=${() => void this._openDoc(f.file)}>
            <span>${f.label}</span>${badge ? html`<span class="k-tu__badge" data-kind=${badge}>${badge}</span>` : nothing}
        </button>`;
    }

    render() {
        const d = this._doc;
        const raw = !!d?.raw;
        const dirty = this._dirtyCount();
        const noRawHint = d && !raw ? 'This set has no raw drawings (an uploaded set), so only Erase, Lasso (erases), Undo and Save work here.' : '';
        /** @type {Array<[Tool, string, string, boolean]>} */
        const tools = [
            ['wand', 'Wand', 'W', true],
            ['lasso', 'Lasso', 'L', false],
            ['smart', 'Smart brush', 'B', true],
            ['restore', 'Restore', 'R', true],
            ['erase', 'Erase', 'E', false],
            ['pan', 'Pan', 'H', false],
        ];
        return html`
            <div class="k-tu__scrim" @click=${() => this._requestClose()}></div>
            <section class="k-tu" role="dialog" aria-modal="true" aria-label="Touch-up" data-no-raw=${raw ? nothing : ''} ?data-busy=${this._busy}>
                <header class="k-tu__head">
                    <h2 class="k-tu__title">Touch-up</h2>
                    <span class="k-tu__folder">${this.folder}</span>
                    <span class="k-tu__spacer"></span>
                    <button type="button" class="k-tu__btn k-tu__btn--primary" ?disabled=${!d?.dirty} @click=${() => void this._save(false)} title="Ctrl+S">Save</button>
                    <button type="button" class="k-tu__btn" ?disabled=${!dirty} @click=${() => void this._save(true)} title="Ctrl+Shift+S">Save all${dirty ? ` (${dirty})` : ''}</button>
                    <button type="button" class="k-tu__btn k-tu__btn--quiet" aria-label="Close Touch-up" @click=${() => this._requestClose()}>${ICONS.close}</button>
                </header>
                ${this._confirmClose ? html`
                    <div class="k-tu__confirm" role="alertdialog" aria-label="Unsaved edits">
                        <span>${dirty} sprite${dirty > 1 ? 's' : ''} with unsaved edits.</span>
                        <button type="button" class="k-tu__btn k-tu__btn--primary" @click=${async () => { if (await this._save(true)) this._close(); }}>Save all and close</button>
                        <button type="button" class="k-tu__btn" @click=${() => this._close()}>Discard</button>
                        <button type="button" class="k-tu__btn k-tu__btn--quiet" @click=${() => { this._confirmClose = false; }}>Keep editing</button>
                    </div>` : nothing}
                <nav class="k-tu__files" aria-label="Sprites">
                    ${this._files.map(f => this.renderFile(f))}
                    ${this._skippedImages.length ? html`<p class="k-tu__note">Not editable here (not PNG): ${this._skippedImages.join(', ')}</p>` : nothing}
                </nav>
                <main class="k-tu__view" data-cursor="crosshair"
                    @pointerdown=${(/** @type {PointerEvent} */ e) => this._down(e)}
                    @pointermove=${(/** @type {PointerEvent} */ e) => this._move(e)}
                    @pointerup=${(/** @type {PointerEvent} */ e) => this._up(e)}
                    @pointerleave=${() => { this._hover = null; this._drawUi(); }}
                    @contextmenu=${(/** @type {Event} */ e) => e.preventDefault()}
                    @wheel=${(/** @type {WheelEvent} */ e) => { e.preventDefault(); const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect(); this._zoomAt(Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top); }}>
                    <div class="k-tu__stage"><canvas class="k-tu__art"></canvas><canvas class="k-tu__sus"></canvas></div>
                    <canvas class="k-tu__ui"></canvas>
                    ${this._error ? html`<p class="k-tu__empty" role="alert">${this._error}</p>` : !this._cur ? html`<p class="k-tu__empty">Loading the set…</p>` : nothing}
                </main>
                <aside class="k-tu__tools" aria-label="Tools">
                    ${noRawHint ? html`<p class="k-tu__hint" role="status">${noRawHint}</p>` : nothing}
                    <h3 class="k-tu__h">Tools</h3>
                    <div class="k-tu__grid">
                        ${tools.map(([tool, label, hot, needsRaw]) => html`
                            <button type="button" class="k-tu__btn" data-tool=${tool} ?data-on=${this._tool === tool} ?disabled=${needsRaw && !raw}
                                title=${needsRaw && !raw ? 'Needs the raw drawing' : label} @click=${() => this._pickTool(tool)}>
                                ${ICONS[tool]}<span>${label}</span><kbd>${hot}</kbd>
                            </button>`)}
                        <button type="button" class="k-tu__btn k-tu__wide" data-act="apply-all" ?data-on=${this._applyAll && raw} ?disabled=${!raw} aria-pressed=${this._applyAll && raw ? 'true' : 'false'}
                            title="Copy each edit to every other sprite whose drawing is pixel-identical where you edited (a set that only repainted faces). Other poses are skipped by name."
                            @click=${() => { this._applyAll = !this._applyAll; }}>
                            <span>Apply to matching sprites</span><kbd>A</kbd>
                        </button>
                    </div>
                    <label class="k-tu__row"><span>Brush</span><input type="range" min="2" max="80" .value=${String(this._size)} @input=${(/** @type {Event} */ e) => { this._size = Number(/** @type {HTMLInputElement} */ (e.target).value); this._drawUi(); }}><output>${this._size}</output></label>
                    <label class="k-tu__row"><span>Tolerance</span><input type="range" min="2" max="60" .value=${String(this._tol)} ?disabled=${!raw} @input=${(/** @type {Event} */ e) => this._setTol(Number(/** @type {HTMLInputElement} */ (e.target).value))}><output>${this._tol}</output></label>
                    ${d?.key ? html`<div class="k-tu__row"><span>Background</span><span class="k-tu__swatch" style=${`background:rgb(${d.key.key.join(',')})`}></span><span class="k-tu__dim">${d.key.white ? 'white' : 'key colour'} ${d.key.key.join(',')}</span></div>` : nothing}

                    <h3 class="k-tu__h">View</h3>
                    <div class="k-tu__backdrops">
                        ${[['checker', 'Checker'], ['#181e3a', 'Navy'], ['#000000', 'Black'], ['#ffffff', 'White'], ['#ff00c8', 'Magenta']].map(([value, label]) => html`
                            <button type="button" class="k-tu__bd" data-bd=${value} ?data-on=${this._bd === value} aria-label=${`${label} backdrop`} title=${label}
                                style=${value === 'checker' ? 'background:repeating-conic-gradient(#888 0 25%,#ccc 0 50%) 0 0/10px 10px' : `background:${value}`}
                                @click=${() => { this._bd = value; }}></button>`)}
                        <input type="color" class="k-tu__bd" value="#3a7d5c" aria-label="Custom backdrop colour" @input=${(/** @type {Event} */ e) => { this._bd = /** @type {HTMLInputElement} */ (e.target).value; }}>
                    </div>
                    <div class="k-tu__grid">
                        <button type="button" class="k-tu__btn" data-act="suspects" ?data-on=${this._showSus} ?disabled=${!raw} @click=${() => { this._showSus = !this._showSus; }}><span>Suspects${this._showSus ? ` ${this._susCount}` : ''}</span><kbd>S</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="alpha" ?data-on=${this._maskView} @click=${() => { this._maskView = !this._maskView; }}><span>Alpha</span><kbd>M</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="compare" ?data-on=${this._compare} ?disabled=${!raw} @click=${() => { this._compare = !this._compare; }}><span>Compare to raw</span><kbd>C</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="fit" @click=${() => this._fit()}><span>Fit</span><kbd>F</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="one" @click=${() => this._oneToOne()}><span>100%</span><kbd>1</kbd></button>
                    </div>

                    <h3 class="k-tu__h">Fix</h3>
                    <div class="k-tu__grid">
                        <button type="button" class="k-tu__btn" data-act="undo" ?disabled=${!d?.undo.length} @click=${() => this._undo()}><span>Undo</span><kbd>Ctrl Z</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="redo" ?disabled=${!d?.redo.length} @click=${() => this._redo()}><span>Redo</span><kbd>Ctrl Y</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="keep" title="Drop specks: keep the largest piece and anything within 6 px of it" @click=${() => this._keep()}><span>Keep figure</span><kbd>K</kbd></button>
                        <button type="button" class="k-tu__btn" data-act="revert" title="Back to the sprite as loaded from disk" @click=${() => this._revert()}><span>Revert</span></button>
                        <button type="button" class="k-tu__btn k-tu__wide" data-act="sync" ?disabled=${!raw} @click=${() => this._sync()}
                            title="Copy THIS sprite's edges to every other sprite wherever their drawings are the same picture (each repainted face keeps its own). Stops the hair shimmering when the face changes on stage."><span>Sync body to matching sprites</span></button>
                    </div>

                    <h3 class="k-tu__h">How</h3>
                    <div class="k-tu__help">
                        <p><b>Wand</b>: click a leftover chunk of background, or a shadow left on it under the feet; it clears that pocket only and mattes the edge. <b>Shift</b>-click takes every visible background-coloured pixel.</p>
                        <p><b>Lasso</b> and <b>Smart brush</b>: only background-coloured pixels inside go, the art stays. Lasso with <b>Alt</b> restores inside, with <b>Shift</b> erases.</p>
                        <p><b>Restore</b> paints the raw drawing back; <b>Erase</b> clears anything.</p>
                        <p><b>Apply to matching</b>: an edit also lands on the other sprites whose drawing is identical where you edited; different poses are skipped by name. Undo reaches all of them.</p>
                        <p>Hold <b>C</b> to see the raw. <b>Space</b>-drag pans, the wheel zooms, <b>[ ]</b> sizes the brush, <b>Up / Down</b> change sprite.</p>
                    </div>
                </aside>
                <footer class="k-tu__foot">
                    <span class="k-tu__pos">–</span><span class="k-tu__pix">–</span><span class="k-tu__zoom">–</span>
                    <span class="k-tu__msg" role="status" aria-live="polite">${this._msg}</span>
                </footer>
            </section>`;
    }
}

if (!customElements.get(SPRITE_TOUCHUP_TAG)) customElements.define(SPRITE_TOUCHUP_TAG, KSpriteTouchup);
