/**
 * `<k-picture-pending variant="row">` — a picture being drawn, at the end of the chat
 * (docs/pictures-v0.md §2.3).
 *
 * A message-shaped row: a progress ring where the portrait would sit, the purpose line, the queue
 * position or the step count, Mikan-chan painting the picture as the job runs (`k-mikan-painter`;
 * the lane's raw preview frames instead when `rawPreview` is on or a theme hides the mascot), and
 * Cancel. On an
 * error it keeps the message and offers Retry. It is a VIEW: `picture-actions.js` owns the job
 * and calls the methods below; the row only raises `k-picture-cancel` / `k-picture-retry` /
 * `k-picture-dismiss` (bubbling) for its buttons.
 *
 * It is a direct child of `#chat` and deliberately NOT a `.mes`: core's `#chat .mes` queries,
 * `mesid` arithmetic and the keyed row engine never see it, and `#chat` accepting foreign
 * non-`.mes` children is part of the frozen DOM promise (CONTRACT §1.7). Light DOM; every rule is
 * in `css/pictures.css`.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { PAINTER_FINISHED, mascotHidden } from './k-mikan-painter.js';

/** Preview frames applied at most this often, ms (the server already throttles to ~4/s). */
const PREVIEW_MIN_INTERVAL_MS = 250;
/** Longest the finished picture waits for Mikan-chan's last strokes. */
const FINISH_CAP_MS = 2500;

/** Ring geometry: r=20 in a 48 box. */
const RING_RADIUS = 20;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Events the row raises (bubbling) for its buttons. */
export const PENDING_EVENTS = Object.freeze({
    CANCEL: 'k-picture-cancel',
    RETRY: 'k-picture-retry',
    DISMISS: 'k-picture-dismiss',
    SETUP: 'k-picture-setup',
    KEY_LANE: 'k-picture-key-lane',
});

export class KPicturePending extends LitElement {
    static properties = {
        /** SPEC §13 — `row` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** `starting` · `queued` · `running` · `finishing` · `cancelling` · `error`. Reflected: the sheet keys on it. */
        state: { type: String, reflect: true },
        /** First line, e.g. "Drawing this moment". */
        line: { type: String },
        _position: { state: true },
        _value: { state: true },
        _max: { state: true },
        _node: { state: true },
        _preview: { state: true },
        _message: { state: true },
        _help: { state: true },
        /** Show the lane's raw preview frames instead of Mikan-chan (Settings → Pictures). */
        rawPreview: { type: Boolean },
    };

    /** Job id once the server has answered. */
    jobId = '';
    /** Chat this picture belongs to (`getCurrentChatId()` when it started). */
    chatId = '';

    /** Latest frame not yet applied. */
    #nextFrame = '';
    /** @type {ReturnType<typeof setTimeout>|null} */
    #frameTimer = null;

    constructor() {
        super();
        this.variant = 'row';
        this.state = 'starting';
        this.line = 'Drawing a picture';
        this._position = 0;
        this._value = 0;
        this._max = 0;
        this._node = '';
        this._preview = '';
        this._message = '';
        /** @type {{setup: boolean, keyLane: {lane: string, label: string}|null}} */
        this._help = { setup: false, keyLane: null };
        this.rawPreview = false;
    }

    /** Light DOM: `public/css/pictures.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
    }

    disconnectedCallback() {
        if (this.#frameTimer !== null) clearTimeout(this.#frameTimer);
        this.#frameTimer = null;
        super.disconnectedCallback();
    }

    /** Back to a fresh start (Retry reuses the row). */
    reset() {
        this.state = 'starting';
        this._position = 0;
        this._value = 0;
        this._max = 0;
        this._node = '';
        this._message = '';
        /** @type {{setup: boolean, keyLane: {lane: string, label: string}|null}} */
        this._help = { setup: false, keyLane: null };
    }

    /** @param {number} position Jobs ahead of this one. */
    queued(position) {
        if (this.state === 'cancelling') return;
        this.state = 'queued';
        this._position = Math.max(0, Number(position) || 0);
    }

    /** @param {{value?: number, max?: number, nodeTitle?: string, node?: string}} progress */
    progress(progress) {
        if (this.state === 'cancelling') return;
        this.state = 'running';
        const max = Number(progress?.max);
        const value = Number(progress?.value);
        if (Number.isFinite(max) && max > 0) this._max = max;
        if (Number.isFinite(value) && value >= 0) this._value = Math.min(value, this._max || value);
        this._node = String(progress?.nodeTitle ?? '');
    }

    /**
     * A live preview frame. Frames arriving faster than the minimum interval collapse to the
     * latest; none is ever stored anywhere but this element's `src`.
     * @param {string} jpegBase64
     */
    preview(jpegBase64) {
        if (typeof jpegBase64 !== 'string' || !jpegBase64) return;
        if (this.state !== 'cancelling') this.state = 'running';
        const src = jpegBase64.startsWith('data:') ? jpegBase64 : `data:image/jpeg;base64,${jpegBase64}`;
        if (this.#frameTimer !== null) {
            this.#nextFrame = src;
            return;
        }
        this._preview = src;
        this.#frameTimer = setTimeout(() => this.#flushFrame(), PREVIEW_MIN_INTERVAL_MS);
    }

    #flushFrame() {
        this.#frameTimer = null;
        if (!this.#nextFrame) return;
        const next = this.#nextFrame;
        this.#nextFrame = '';
        this.preview(next);
    }

    cancelling() {
        this.state = 'cancelling';
    }

    /**
     * The picture arrived: Mikan-chan paints the rest of her canvas quickly before the row leaves.
     * Resolves when she is done, at once when she is not on screen, and never later than
     * FINISH_CAP_MS (a picture must not wait on a mascot).
     * @returns {Promise<void>}
     */
    finishing() {
        if (this.state === 'error' || this.state === 'cancelling') return Promise.resolve();
        this.state = 'finishing';
        return new Promise(resolve => {
            /** @type {ReturnType<typeof setTimeout>|null} */
            let cap = null;
            const done = () => {
                if (cap !== null) clearTimeout(cap);
                this.removeEventListener(PAINTER_FINISHED, done);
                resolve();
            };
            this.addEventListener(PAINTER_FINISHED, done);
            cap = setTimeout(done, FINISH_CAP_MS);
            void this.updateComplete.then(() => {
                if (!this.querySelector('k-mikan-painter')) done();
            });
        });
    }

    /**
     * @param {string} message
     * @param {{setup?: boolean, keyLane?: {lane: string, label: string}|null}} [help] Ways forward the
     *   row offers (§14.6): open the ComfyUI setup; draw this picture on a stored key instead.
     */
    fail(message, help = {}) {
        this.state = 'error';
        this._message = message || 'The picture could not be drawn.';
        this._help = { setup: !!help.setup, keyLane: help.keyLane ?? null };
    }

    /** @param {string} type */
    #raise(type) {
        this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: { jobId: this.jobId } }));
    }

    #status() {
        switch (this.state) {
            case 'starting': return 'Sending to the picture server…';
            case 'queued': return this._position > 0
                ? `In the queue, ${this._position} ahead`
                : 'Next in the queue';
            case 'running': {
                const step = this._max > 0 ? `Step ${Math.round(this._value)} of ${Math.round(this._max)}` : 'Drawing…';
                return this._node ? `${step} · ${this._node}` : step;
            }
            case 'finishing': return 'Done';
            case 'cancelling': return 'Stopping…';
            case 'error': return this._message;
            default: return '';
        }
    }

    render() {
        const finishing = this.state === 'finishing';
        const fraction = finishing ? 1 : this._max > 0 ? Math.min(1, this._value / this._max) : 0;
        const error = this.state === 'error';
        // Running with no step count (a key lane): no number to show; she keeps to her palette.
        const counted = this._max > 0;
        const indeterminate = this.state === 'running' && !counted;
        const painter = !error && !this.rawPreview && !mascotHidden();
        let frame;
        if (painter) {
            const drawing = counted && (this.state === 'running' || this.state === 'cancelling');
            frame = html`<k-mikan-painter variant="tile" .progress=${drawing ? fraction : null} ?finishing=${finishing}></k-mikan-painter>`;
        } else if (this._preview) {
            frame = html`<img class="k-pic-pend-preview" src=${this._preview} alt="Preview of the picture being drawn" draggable="false">`;
        } else {
            frame = html`<span class="k-pic-pend-nopreview">${error ? '' : 'The preview appears here when the server sends one'}</span>`;
        }
        const frameClass = painter ? ' has-painter' : this._preview ? ' has-preview' : '';
        return html`
            <div class="k-pic-pend" role="status" aria-live="polite">
                <div class="k-pic-pend-ring${indeterminate ? ' is-indeterminate' : ''}" aria-hidden="true">
                    <svg viewBox="0 0 48 48" width="48" height="48">
                        <circle class="k-pic-pend-track" cx="24" cy="24" r=${RING_RADIUS} fill="none" stroke-width="3" />
                        <circle class="k-pic-pend-arc" cx="24" cy="24" r=${RING_RADIUS} fill="none" stroke-width="3"
                                stroke-linecap="round" transform="rotate(-90 24 24)"
                                stroke-dasharray=${RING_LENGTH.toFixed(2)}
                                stroke-dashoffset=${(RING_LENGTH * (1 - (indeterminate ? 0.25 : fraction))).toFixed(2)} />
                    </svg>
                    <span class="k-pic-pend-pct">${error ? '!' : indeterminate ? '' : `${Math.round(fraction * 100)}`}</span>
                </div>
                <div class="k-pic-pend-body">
                    <p class="k-pic-pend-line">${this.line}</p>
                    <p class="k-pic-pend-status${error ? ' is-error' : ''}">${this.#status()}</p>
                    <div class="k-pic-pend-frame${frameClass}">${frame}</div>
                    <div class="k-pic-pend-actions">
                        ${error && this._help.keyLane ? html`
                            <button type="button" class="k-pic-btn k-pic-btn--primary k-pic-pend-keylane" @click=${() => this.#raise(PENDING_EVENTS.KEY_LANE)}>Draw with your ${this._help.keyLane.label} key</button>` : nothing}
                        ${error && this._help.setup ? html`
                            <button type="button" class="k-pic-btn k-pic-pend-setup" @click=${() => this.#raise(PENDING_EVENTS.SETUP)}>Set up ComfyUI</button>` : nothing}
                        ${error ? html`
                            <button type="button" class="k-pic-btn${this._help.keyLane ? '' : ' k-pic-btn--primary'} k-pic-pend-retry" @click=${() => this.#raise(PENDING_EVENTS.RETRY)}>Retry</button>
                            <button type="button" class="k-pic-btn k-pic-pend-dismiss" @click=${() => this.#raise(PENDING_EVENTS.DISMISS)}>Dismiss</button>` : html`
                            <button type="button" class="k-pic-btn k-pic-pend-cancel" ?disabled=${this.state === 'cancelling' || finishing}
                                    @click=${() => this.#raise(PENDING_EVENTS.CANCEL)}>Cancel</button>`}
                    </div>
                </div>
            </div>`;
    }
}

if (!customElements.get('k-picture-pending')) {
    customElements.define('k-picture-pending', KPicturePending);
}
