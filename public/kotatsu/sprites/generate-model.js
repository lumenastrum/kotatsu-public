/**
 * Sprite generator, the Studio side (docs/handoffs/sprite-generator.md §5, build slice G2): everything
 * `<k-sprite-generate>` needs that is not the DOM. The run routes (`/api/kotatsu/pictures/sprite-runs`, slice G1),
 * the run's stages and what each one shows, readable words for gates / needs / progress, the mask brush, the face
 * box, the labels a mask step sends, and which run a card was working on.
 *
 * No imports from core: `fetch`, the request headers, `EventSource` and the storage are passed in, so jest drives
 * this module without a browser.
 */

export const RUNS_API = '/api/kotatsu/pictures/sprite-runs';

/** The run's stages (sprite-runs.js `STAGES`). */
export const STAGES = Object.freeze({
    MASTERS: 'masters', PICK: 'pick', FACE: 'face', BUST: 'bust', MASKS: 'masks', EXPRESSIONS: 'expressions',
    REVIEW: 'review', ERROR: 'error', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted',
});
/** The server is working: show progress, offer Cancel. */
export const RUNNING_STAGES = new Set([STAGES.MASTERS, STAGES.BUST, STAGES.EXPRESSIONS]);
/** The run waits on the person. */
export const WAITING_STAGES = new Set([STAGES.PICK, STAGES.FACE, STAGES.MASKS, STAGES.REVIEW]);
/** Nothing more can happen to this run. */
export const ENDED_STAGES = new Set([STAGES.ERROR, STAGES.CANCELLED, STAGES.INTERRUPTED]);

/** The bust's side, px (sprite-runs.js `BUST_SIZE`): masks and marks live on it. */
export const BUST_SIZE = 1024;

/** The engines a run can draw with (sprite-graphs.js `ENGINES`), in the order the Start step offers them. */
export const ENGINE_CHOICES = Object.freeze([
    Object.freeze({ id: 'anima', label: 'Anima base', hint: 'The default: crisp eyes through every repaint, the most expressive faces.' }),
    Object.freeze({ id: 'anima-turbo', label: 'Anima turbo', hint: 'The fast lane, for smaller GPUs too: a whole set at a fraction of the steps. Its background colour wanders more, so expect to draw a few more masters.' }),
    Object.freeze({ id: 'kroma', label: 'Kroma', hint: 'A Krea-family alternative: softer pastel look; write colours into the tags (red fox ears).' }),
]);

/** Readable words for a master's gate failures (pixels/gates.js `gateMaster`). */
export const GATE_WORDS = Object.freeze({
    white: 'white background, not the key colour',
    chroma: 'background colour too dull',
    spread: 'background not flat',
    edge: 'figure runs off the top or a side',
    marks: 'stray marks or text',
});

/** The steps the overlay shows, in order. `face` only when the person draws the face box. */
export const STEPS = Object.freeze([
    Object.freeze({ key: 'start', title: 'Start' }),
    Object.freeze({ key: 'masters', title: 'Masters' }),
    Object.freeze({ key: 'face', title: 'Face' }),
    Object.freeze({ key: 'masks', title: 'Masks' }),
    Object.freeze({ key: 'expressions', title: 'Expressions' }),
    Object.freeze({ key: 'review', title: 'Review' }),
]);

/**
 * Which step a run is on.
 * @param {any} run the run (public view) or null before one starts
 * @returns {'start' | 'masters' | 'face' | 'masks' | 'expressions' | 'review' | 'ended'}
 */
export function stepOf(run) {
    const stage = run?.stage;
    if (!stage) return 'start';
    if (stage === STAGES.MASTERS || stage === STAGES.PICK) return 'masters';
    if (stage === STAGES.FACE) return 'face';
    if (stage === STAGES.BUST) return run.face?.masterFrom === 'person' ? 'face' : 'masters';
    if (stage === STAGES.MASKS) return 'masks';
    if (stage === STAGES.EXPRESSIONS) return 'expressions';
    if (stage === STAGES.REVIEW) return 'review';
    return 'ended';
}

/**
 * The stepper for a run: the steps with `done` / `current`, `face` left out when the detector found the face.
 * @param {any} run
 * @returns {{ key: string, title: string, state: 'done' | 'current' | 'next' }[]}
 */
export function stepper(run) {
    const current = stepOf(run);
    const showFace = current === 'face' || run?.face?.masterFrom === 'person';
    const steps = STEPS.filter(s => s.key !== 'face' || showFace);
    const at = current === 'ended' ? -1 : steps.findIndex(s => s.key === current);
    return steps.map((s, i) => ({ key: s.key, title: s.title, state: at < 0 ? 'next' : i < at ? 'done' : i === at ? 'current' : 'next' }));
}

/**
 * A master's gate in words.
 * @param {{ ok?: boolean, failures?: string[] } | null | undefined} gate
 * @returns {{ ok: boolean, words: string[] }}
 */
export function gateSummary(gate) {
    const failures = Array.isArray(gate?.failures) ? gate.failures : [];
    const ok = gate?.ok === true && !failures.length;
    return { ok, words: ok ? ['clean'] : failures.map(f => /** @type {Record<string, string>} */ (GATE_WORDS)[f] ?? f) };
}

/**
 * The server's needs list (sprite-graphs.js `spriteNeeds`) as lines a person can act on.
 * @param {unknown} needs
 * @returns {{ role: string, file: string, state: 'missing' | 'present' | 'optional' | 'unknown', text: string }[]}
 */
export function needsLines(needs) {
    if (!Array.isArray(needs)) return [];
    return needs.filter(n => n && typeof n.file === 'string').map(n => {
        const state = n.present === true ? 'present' : n.present === false ? (n.required ? 'missing' : 'optional') : 'unknown';
        const text = state === 'present' ? 'found'
            : state === 'missing' ? 'missing: needed'
                : state === 'optional' ? 'not installed (optional)'
                    : 'could not check';
        return { role: String(n.role ?? ''), file: n.file, state, text };
    });
}

/**
 * What a progress step is doing, from its job path (`masters/<seed>`, `bust/derived`, `bust/<label>`, `full/<label>`,
 * `faces/...`).
 * @param {string} step
 * @returns {string}
 */
export function stepWords(step) {
    const [head, rest = ''] = String(step ?? '').split('/');
    if (head === 'masters') return 'Drawing a master';
    if (head === 'faces') return 'Finding the face';
    if (head === 'bust' && rest === 'derived') return 'Deriving the bust';
    if (head === 'bust') return rest === 'neutral' ? 'Painting the neutral face' : `Painting ${rest}`;
    if (head === 'full') return `Pasting ${rest} into the full body`;
    return 'Working';
}

/**
 * One line for the live progress (SSE `progress`: `{stage, step, n?, of?, label?, queued?, progress?}`).
 * @param {any} progress
 * @returns {{ text: string, value: number | null, max: number | null }}
 */
export function progressLine(progress) {
    if (!progress || typeof progress !== 'object') return { text: '', value: null, max: null };
    let text = stepWords(progress.step);
    if (String(progress.step ?? '').startsWith('masters/') && Number.isFinite(progress.n) && Number.isFinite(progress.of)) text = `Drawing master ${progress.n} of ${progress.of}`;
    const queued = progress.queued;
    const p = progress.progress;
    if (queued && typeof queued === 'object' && !p) {
        const position = Number(queued.position);
        return { text: `${text}: ${Number.isFinite(position) && position > 0 ? `waiting in ComfyUI's queue (position ${position})` : 'starting'}`, value: null, max: null };
    }
    if (p && Number.isFinite(p.value) && Number.isFinite(p.max) && p.max > 0) {
        return { text: `${text}: step ${p.value} of ${p.max}`, value: p.value, max: p.max };
    }
    return { text, value: null, max: null };
}

/**
 * The labels of a run and how far each one is (neutral first, always present once expressions start).
 * @param {any} run
 * @returns {{ label: string, rung: string, tags: string, mask: string, seed: number, state: string, error?: string }[]}
 */
export function reviewRows(run) {
    const labels = Array.isArray(run?.labels) ? run.labels : [];
    const neutralState = run?.stage === STAGES.REVIEW || labels.some((/** @type {any} */ l) => l.state !== 'waiting') ? 'done' : 'waiting';
    return [
        { label: 'neutral', rung: '', tags: String(run?.neutral ?? ''), mask: 'features', seed: Number(run?.seed ?? 0), state: neutralState },
        ...labels.map((/** @type {any} */ l) => ({ ...l })),
    ];
}

/**
 * The person's choices on the mask step, starting from the run's labels.
 * @param {any} run
 * @returns {Map<string, { on: boolean, rung: 'mild' | 'strong', mask: 'features' | 'flush' }>}
 */
export function labelChoices(run) {
    const choices = new Map();
    for (const l of Array.isArray(run?.labels) ? run.labels : []) {
        choices.set(l.label, { on: true, rung: l.rung === 'mild' ? 'mild' : 'strong', mask: l.mask === 'flush' ? 'flush' : 'features' });
    }
    return choices;
}

/**
 * The `labels` a mask step sends: the chosen ones, in the run's order, with rung and mask (the server fills the words).
 * @param {Map<string, { on: boolean, rung: string, mask: string }>} choices
 * @returns {{ label: string, rung: string, mask: string }[]}
 */
export function labelsPayload(choices) {
    return [...choices].filter(([, c]) => c.on).map(([label, c]) => ({ label, rung: c.rung, mask: c.mask }));
}

/**
 * A run file's url. `version` changes when the file is redrawn (a reroll), so the browser does not keep the old one.
 * @param {string} id @param {string} rel @param {string | number} [version]
 * @returns {string}
 */
export function fileUrl(id, rel, version = '') {
    return `${RUNS_API}/${encodeURIComponent(id)}/file?path=${encodeURIComponent(rel)}${version !== '' ? `&v=${encodeURIComponent(String(version))}` : ''}`;
}

/**
 * The version of one label's files: changes on every reroll (new seed) and when it finishes.
 * @param {{ seed?: number, state?: string, rung?: string }} row
 */
export const rowVersion = row => `${row.seed ?? ''}-${row.rung ?? ''}-${row.state ?? ''}`;

/**
 * A dragged face box in image pixels: corners in any order, clamped to the image, at least `min` px a side.
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} W @param {number} H
 * @param {number} [min]
 * @returns {{ x: number, y: number, w: number, h: number } | null} null when the drag is too small
 */
export function boxFromDrag(x0, y0, x1, y1, W, H, min = 8) {
    const clamp = (/** @type {number} */ v, /** @type {number} */ hi) => Math.min(hi, Math.max(0, v));
    const ax = clamp(Math.min(x0, x1), W), bx = clamp(Math.max(x0, x1), W);
    const ay = clamp(Math.min(y0, y1), H), by = clamp(Math.max(y0, y1), H);
    const w = Math.round(bx - ax), h = Math.round(by - ay);
    if (w < min || h < min) return null;
    return { x: Math.round(ax), y: Math.round(ay), w, h };
}

/**
 * Paints a disk into a soft mask (brush 255, eraser 0).
 * @param {Uint8Array} mask @param {number} W @param {number} H @param {number} cx @param {number} cy @param {number} r
 * @param {number} value
 * @returns {void}
 */
export function stampDisk(mask, W, H, cx, cy, r, value) {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) mask[y * W + x] = value;
    }
}

/**
 * A brush stroke from one point to the next: disks every quarter radius, so a fast drag leaves no gaps.
 * @param {Uint8Array} mask @param {number} W @param {number} H @param {number[]} from [x, y] @param {number[]} to [x, y]
 * @param {number} r @param {number} value
 * @returns {void}
 */
export function strokeDisk(mask, W, H, from, to, r, value) {
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(1, r / 2)));
    for (let k = 0; k <= steps; k++) stampDisk(mask, W, H, from[0] + (to[0] - from[0]) * k / steps, from[1] + (to[1] - from[1]) * k / steps, r, value);
}

/** Painted, the repaint's way (inpaint.js `hardMask`: any value above 25 is a full repaint). */
export const PAINTED = 25;

/**
 * How much of a mask is painted (for the "empty mask" guard before sending).
 * @param {Uint8Array} mask
 * @returns {number} painted pixels
 */
export function paintedCount(mask) {
    let n = 0;
    for (let p = 0; p < mask.length; p++) if (mask[p] > PAINTED) n++;
    return n;
}

/**
 * A grey RGBA image of a mask, opaque (white = repaint), ready for a canvas → PNG. Opaque, so a canvas's
 * premultiplication cannot change a value.
 * @param {Uint8Array} mask
 * @returns {Uint8ClampedArray}
 */
export function maskToRgba(mask) {
    const out = new Uint8ClampedArray(mask.length * 4);
    for (let p = 0; p < mask.length; p++) {
        const i = p * 4;
        out[i] = out[i + 1] = out[i + 2] = mask[p];
        out[i + 3] = 255;
    }
    return out;
}

/**
 * A mask from an opaque grey image's red channel (what `masks/{features,flush}.png` are).
 * @param {Uint8ClampedArray} rgba
 * @returns {Uint8Array}
 */
export function rgbaToMask(rgba) {
    const mask = new Uint8Array(rgba.length / 4);
    for (let p = 0; p < mask.length; p++) mask[p] = rgba[p * 4];
    return mask;
}

/**
 * The overlay a mask paints over the bust: its colour where painted, the soft edge as alpha.
 * @param {Uint8Array} mask @param {number[]} rgb @param {number} [alpha] 0..1 at full paint
 * @returns {Uint8ClampedArray}
 */
export function maskOverlay(mask, rgb, alpha = 0.5) {
    const out = new Uint8ClampedArray(mask.length * 4);
    for (let p = 0; p < mask.length; p++) {
        const v = mask[p];
        if (v <= PAINTED) continue;
        const i = p * 4;
        out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2];
        out[i + 3] = Math.round(alpha * 255 * Math.min(1, v / 200));
    }
    return out;
}

/**
 * A CSS colour (`#rgb`, `#rrggbb`, `rgb(…)`) as [r, g, b]; the fallback when it cannot be read.
 * @param {string} css @param {number[]} fallback
 * @returns {number[]}
 */
export function parseColor(css, fallback) {
    const s = String(css ?? '').trim();
    const short = s.match(/^#([0-9a-f]{3})$/i);
    if (short) return [...short[1]].map(c => parseInt(c + c, 16));
    const long = s.match(/^#([0-9a-f]{6})/i);
    if (long) return [0, 2, 4].map(i => parseInt(long[1].slice(i, i + 2), 16));
    const fn = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (fn) return [fn[1], fn[2], fn[3]].map(v => Math.round(Number(v)));
    return fallback;
}

// ── which run a card was working on ─────────────────────────────────────────────────────────────

const MEMORY_PREFIX = 'kotatsu.spriteRun.';
/** @type {Map<string, string>} also kept here, for a browser whose storage refuses */
const memory = new Map();

/**
 * @param {Storage | null | undefined} storage @param {string} card the card's avatar file @param {string} id
 * @returns {void}
 */
export function rememberRun(storage, card, id) {
    if (!card) return;
    memory.set(card, id);
    try {
        storage?.setItem(MEMORY_PREFIX + card, id);
    } catch {
        // storage refused (private window, quota): the in-memory copy still reconnects in this tab
    }
}

/**
 * @param {Storage | null | undefined} storage @param {string} card
 * @returns {string} '' when none
 */
export function recallRun(storage, card) {
    if (!card) return '';
    try {
        const stored = storage?.getItem(MEMORY_PREFIX + card);
        if (stored) return stored;
    } catch {
        // fall through to memory
    }
    return memory.get(card) ?? '';
}

/**
 * @param {Storage | null | undefined} storage @param {string} card
 * @returns {void}
 */
export function forgetRun(storage, card) {
    memory.delete(card);
    try {
        storage?.removeItem(MEMORY_PREFIX + card);
    } catch {
        // nothing stored
    }
}

// ── the routes ─────────────────────────────────────────────────────────────────────────────────

/** An error from the run routes; `code: 'needs'` carries the server's needs list. */
export class RunError extends Error {
    /** @param {string} message @param {number} status @param {string} [code] @param {any[]} [needs] */
    constructor(message, status, code = '', needs = []) {
        super(message);
        this.status = status;
        this.code = code;
        this.needs = needs;
    }
}

/**
 * The run routes over `fetch`.
 * @param {{ fetchImpl?: typeof fetch, headers?: () => Record<string, string> }} [o]
 */
export function createRunClient({ fetchImpl = (...a) => fetch(...a), headers = () => ({ 'Content-Type': 'application/json' }) } = {}) {
    /**
     * @param {string} route @param {string} method @param {any} [body]
     * @returns {Promise<any>}
     */
    async function call(route, method, body) {
        const response = await fetchImpl(`${RUNS_API}${route}`, {
            method,
            headers: method === 'GET' ? {} : { ...headers(), 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: 'no-cache',
        });
        if (response.status === 204) return {};
        let answer = null;
        try {
            answer = await response.json();
        } catch {
            answer = null;
        }
        if (!response.ok) {
            const error = answer?.error;
            const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : `The sprite run answered ${response.status}`;
            throw new RunError(message, response.status, typeof error?.code === 'string' ? error.code : '', Array.isArray(error?.needs) ? error.needs : []);
        }
        return answer ?? {};
    }
    const id = (/** @type {string} */ runId) => `/${encodeURIComponent(runId)}`;
    return {
        /** @param {any} body `{character, look, engine?, masters?, comfy?, …}` @returns {Promise<{ run: any, needs: any[] }>} */
        start: body => call('', 'POST', body),
        /** @param {string} runId @returns {Promise<any>} the run */
        get: async runId => (await call(id(runId), 'GET')).run,
        /**
         * One action: `more`, `pick`, `face`, `masks`, `reroll`.
         * @param {string} runId @param {'more' | 'pick' | 'face' | 'masks' | 'reroll'} action @param {any} body
         * @returns {Promise<any>} the run as it stands
         */
        act: async (runId, action, body) => (await call(`${id(runId)}/${action}`, 'POST', body)).run,
        /** @param {string} runId @param {string} folder @returns {Promise<{ run: any, saved: { folder: string, labels: string[] } }>} */
        save: (runId, folder) => call(`${id(runId)}/save`, 'POST', { folder }),
        /** @param {string} runId */
        cancel: async runId => { await call(`${id(runId)}/cancel`, 'POST', {}); },
    };
}

/**
 * Follows a run live: SSE `state` / `progress`; after two stream errors in a row, polls `GET /:id` instead.
 * @param {string} runId
 * @param {{ state?: (run: any) => void, progress?: (step: any) => void, lost?: (error: Error) => void }} on
 * @param {{ EventSourceImpl?: typeof EventSource | null, get?: (id: string) => Promise<any>, pollMs?: number }} [o]
 * @returns {() => void} stop
 */
export function watchRun(runId, on, { EventSourceImpl = typeof EventSource === 'function' ? EventSource : null, get, pollMs = 1500 } = {}) {
    let stopped = false;
    /** @type {EventSource | null} */
    let source = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let errors = 0;
    const parse = (/** @type {any} */ raw) => {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    };
    const poll = async () => {
        timer = null;
        if (stopped || !get) return;
        try {
            const run = await get(runId);
            if (stopped) return;
            on.state?.(run);
            if (ENDED_STAGES.has(run?.stage)) return;
        } catch (error) {
            if (/** @type {any} */ (error)?.status === 404) {
                on.lost?.(/** @type {Error} */ (error));
                return;
            }
        }
        if (!stopped) timer = setTimeout(poll, pollMs);
    };
    const startPolling = () => {
        source?.close();
        source = null;
        if (!stopped && timer === null) timer = setTimeout(poll, 0);
    };
    if (!EventSourceImpl) startPolling();
    else {
        source = new EventSourceImpl(`${RUNS_API}/${encodeURIComponent(runId)}/events`);
        source.addEventListener('state', event => {
            errors = 0;
            const run = parse(/** @type {MessageEvent} */ (event).data);
            if (run && !stopped) on.state?.(run);
        });
        source.addEventListener('progress', event => {
            errors = 0;
            const step = parse(/** @type {MessageEvent} */ (event).data);
            if (step && !stopped) on.progress?.(step);
        });
        source.addEventListener('error', () => {
            if (stopped) return;
            errors += 1;
            if (errors >= 2) startPolling();
        });
    }
    return () => {
        stopped = true;
        source?.close();
        source = null;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
}
