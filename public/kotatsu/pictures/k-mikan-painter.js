/**
 * `<k-mikan-painter variant="tile">` — Mikan-chan painting at her easel while a picture is drawn
 * (Pictures, 2026-10-10). Sits in the pending row's frame instead of the model's raw preview.
 *
 * The art is one sprite sheet, `brand/mascot/painter.webp` (+ `painter.json`): a MiniMax H3
 * first-to-last-frame clip of her painting the canvas from a quarter to full, green-screen keyed
 * and sampled to 62 frames (docs/design/mascot/prompts.md § Painter). A sheet scrubs on every
 * browser, Safari included; a video with alpha would not.
 *
 * - `progress` null (sending, queued): she dabs her palette, a ping-pong over the clip's first
 *   frames.
 * - `progress` 0..1 (drawing): the frame follows the job, never backwards (a hires recipe's second
 *   sampler starts its own count again), and GLIDES toward it at the clip's own frame rate, so a
 *   recipe with few big steps still paints continuously.
 * - `finishing` (the picture arrived): she paints the rest of the canvas quickly, at FINISH_FPS,
 *   then raises `k-mikan-finished`. A lane with no step count (OpenAI, Gemini) keeps her on the
 *   palette loop until then, so this is where its canvas gets painted (Andres's pick, 2026-10-10:
 *   honest about not knowing how far along it is).
 * - Reduced motion: no palette loop, and the frame jumps straight to the progress.
 *
 * Light DOM; rules in `css/pictures.css`.
 */
import { LitElement, html } from '../shell/lit.js';

/** Mirrors brand/mascot/painter.json (generated with the sheet; never edit one without the other). */
export const PAINTER_SHEET = Object.freeze({ src: 'kotatsu/brand/mascot/painter.webp', frames: 62, cols: 8, rows: 8, width: 277, height: 300, fps: 12 });

/** Frames the palette dab spans at the clip's start (0.7 s at 12 fps). */
const IDLE_LAST_FRAME = 8;
/** The palette loop runs slower than the clip: a calm mixing motion while waiting. */
const IDLE_FPS = 7;
/** The finishing flourish: the whole clip in about 1.4 s. */
const FINISH_FPS = 45;
/** Raised once she has painted the last frame after `finishing`. */
export const PAINTER_FINISHED = 'k-mikan-finished';

/** @returns {boolean} */
function reducedMotion() {
    try {
        return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/** @returns {boolean} Whether a theme pack hid the mascot (`--k-mascot-display: none`). */
export function mascotHidden() {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue('--k-mascot-display').trim() === 'none';
    } catch {
        return false;
    }
}

export class KMikanPainter extends LitElement {
    static properties = {
        /** SPEC §13 — `tile` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** null while waiting, else 0..1. */
        progress: { attribute: false },
        /** The picture arrived: paint to the end quickly, then raise `k-mikan-finished`. */
        finishing: { type: Boolean },
        _frame: { state: true },
    };

    /** Highest frame the job has reached. */
    #target = 0;
    /** Palette loop direction. */
    #idleStep = 1;
    /** @type {ReturnType<typeof setInterval>|null} */
    #timer = null;
    #timerFps = 0;

    constructor() {
        super();
        this.variant = 'tile';
        /** @type {number|null} */
        this.progress = null;
        this.finishing = false;
        this._frame = 0;
    }

    #finished = false;

    /** Light DOM: `public/css/pictures.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        this.#schedule();
    }

    disconnectedCallback() {
        this.#stop();
        super.disconnectedCallback();
    }

    /** @param {Map<string, unknown>} changed */
    willUpdate(changed) {
        if (changed.has('finishing') && this.finishing) {
            this.#target = PAINTER_SHEET.frames - 1;
            if (reducedMotion()) this._frame = this.#target;
            this.#schedule();
            this.#maybeFinished();
            return;
        }
        if (!changed.has('progress') || this.finishing) return;
        if (typeof this.progress === 'number' && Number.isFinite(this.progress)) {
            const frame = Math.round(Math.min(1, Math.max(0, this.progress)) * (PAINTER_SHEET.frames - 1));
            this.#target = Math.max(this.#target, frame);
            if (reducedMotion()) this._frame = this.#target;
        }
        this.#schedule();
    }

    #stop() {
        if (this.#timer !== null) clearInterval(this.#timer);
        this.#timer = null;
        this.#timerFps = 0;
    }

    /** One timer at the rate the current mode wants; none when nothing moves. */
    #schedule() {
        if (!this.isConnected) return;
        const drawing = this.finishing || typeof this.progress === 'number';
        let fps = 0;
        if (reducedMotion()) fps = 0;
        else if (!drawing) fps = IDLE_FPS;
        else if (this._frame < this.#target) fps = this.finishing ? FINISH_FPS : PAINTER_SHEET.fps;
        if (fps === this.#timerFps) return;
        this.#stop();
        if (!fps) return;
        this.#timerFps = fps;
        this.#timer = setInterval(() => this.#tick(), 1000 / fps);
    }

    /** Raises `k-mikan-finished` once, when finishing has reached the last frame. */
    #maybeFinished() {
        if (!this.finishing || this.#finished || this._frame < PAINTER_SHEET.frames - 1) return;
        this.#finished = true;
        this.dispatchEvent(new CustomEvent(PAINTER_FINISHED, { bubbles: true, composed: true }));
    }

    #tick() {
        if (!this.finishing && typeof this.progress !== 'number') {
            let next = this._frame + this.#idleStep;
            if (next > IDLE_LAST_FRAME || next < 0) {
                this.#idleStep = -this.#idleStep;
                next = this._frame + this.#idleStep;
            }
            this._frame = Math.min(IDLE_LAST_FRAME, Math.max(0, next));
            return;
        }
        // Drawing: from wherever the palette loop left her, glide forward to the job's frame.
        if (this._frame < this.#target) this._frame += 1;
        if (this._frame >= this.#target) {
            this.#schedule();
            this.#maybeFinished();
        }
    }

    render() {
        const { cols, rows } = PAINTER_SHEET;
        const col = this._frame % cols;
        const row = Math.floor(this._frame / cols);
        const x = cols > 1 ? (col / (cols - 1)) * 100 : 0;
        const y = rows > 1 ? (row / (rows - 1)) * 100 : 0;
        return html`<span class="k-mikan-painter" role="img" aria-label="Mikan-chan is painting your picture"
            style=${`background-position:${x.toFixed(4)}% ${y.toFixed(4)}%`}></span>`;
    }
}

if (!customElements.get('k-mikan-painter')) {
    customElements.define('k-mikan-painter', KMikanPainter);
}
