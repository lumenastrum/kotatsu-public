/**
 * streaming-view — the streaming display behind StreamingProcessor (renderer v0 slice D,
 * docs/renderer-v0.md §2 "Streaming display"; pipeline receipts in
 * docs/renderer-v0-recon-streaming.md).
 *
 * What this module is: the `<k-stream-text>` element mounted inside `.mes_text` for the
 * duration of a stream, an incremental formatter that keeps SETTLED paragraph blocks' DOM
 * stable across ticks (§2.5 — bubble-split pills must not flicker) and re-formats only the
 * live tail, the display-side bracket/quote balancer (stock computed it per tick with four
 * O(n) scans; it was never persisted to chat[].mes, so it is display state and lives here),
 * and the leading-edge paint scheduler that replaces the trailing-edge Stopwatch.
 *
 * Correctness spine, in order:
 *  1. `finalize()` ALWAYS runs one full stock-shape reformat and unmounts — any mid-stream
 *     divergence the block splitter could introduce is transient-visual and self-heals the
 *     moment the stream ends.
 *  2. The settled prefix self-verifies per tick (`text.startsWith(settledRaw)`) — if cleanup
 *     rewrote earlier text, everything rebuilds from scratch (stock cost, correct output).
 *  3. The incremental path additionally requires `formatCacheUsable()` (no formatter hooks, no
 *     macros in regex scripts — slice B's signature machinery) and stream_fade_in OFF;
 *     otherwise every tick is one full format + one full paint, exactly stock.
 *  4. Abort without finalize unwraps the element in place — `.mes_text` keeps the last painted
 *     nodes directly, matching stock's abandoned-innerHTML end state.
 *
 * Leaf module: everything stateful is injected at init (script.js is the only consumer).
 */

/** @type {{
 *  messageFormatting: Function,
 *  applyStreamFadeIn: Function,
 *  getPowerUser: () => any,
 *  beginFormatPass: (chat: any[]) => void,
 *  endFormatPass: () => void,
 *  formatCacheUsable: () => boolean,
 *  getChat: () => any[],
 * }?} */
let deps = null;

/**
 * Wires the module to core. script.js calls this once at boot.
 * @param {NonNullable<typeof deps>} injected
 * @returns {void}
 */
export function initStreamingView(injected) {
    deps = injected;
    if (!customElements.get('k-stream-text')) {
        customElements.define('k-stream-text', KStreamText);
        const style = document.createElement('style');
        style.textContent = 'k-stream-text { display: contents; }';
        document.head.appendChild(style);
    }
}

/** Node-importability shim: Jest imports this module for the pure functions; only the browser
 * ever constructs the element. */
const BaseElement = globalThis.HTMLElement ?? class {};

/**
 * The stream container. `display: contents` — zero layout impact, children lay out as direct
 * children of `.mes_text`, so every theme/extension descendant selector keeps matching.
 * Ships the §13 `variant` attribute (v0 has exactly one variant, per the house rule).
 */
export class KStreamText extends BaseElement {
    static get observedAttributes() { return ['variant']; }
    connectedCallback() {
        if (!this.hasAttribute('variant')) this.setAttribute('variant', 'plain');
    }
}

// ---------------------------------------------------------------------------- block splitting

const LIST_LINE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s/m;

/**
 * Splits stream text into paragraph blocks whose concatenation reproduces the input EXACTLY
 * (each block keeps its trailing blank-line separator). A blank-line run is a split point only
 * when it is outside code fences and <style>, and neither adjacent line is a list item (loose
 * lists span blank lines in markdown — splitting one changes its HTML).
 *
 * Reference-style link definitions are non-local (a def anywhere rewires links everywhere), so
 * their presence returns the whole text as a single block — the caller then reformats fully
 * per tick, which is stock behavior.
 *
 * Exported for Jest.
 * @param {string} text
 * @returns {string[]} blocks; the LAST one is the live tail
 */
export function splitStreamBlocks(text) {
    if (!text) return [''];
    if (REF_DEF.test(text)) return [text];

    const blocks = [];
    let blockStart = 0;
    let inFence = false, inTilde = false, inStyle = false;
    const lines = text.split('\n');
    let offset = 0;

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lineStart = offset;
        offset += line.length + 1; // + '\n' (the last line has none; handled by slicing)

        const trimmed = line.trimStart();
        if (!inStyle && !inTilde && /^(`{3,})/.test(trimmed)) inFence = !inFence;
        else if (!inStyle && !inFence && /^(~{3,})/.test(trimmed)) inTilde = !inTilde;
        if (!inFence && !inTilde) {
            if (/<style[\s>]/i.test(line)) inStyle = true;
            if (/<\/style>/i.test(line)) inStyle = false;
        }

        // A split point is the END of a blank-line run: current line blank, next line not blank.
        if (line.trim() !== '' || inFence || inTilde || inStyle) continue;
        const next = lines[li + 1];
        if (next === undefined || next.trim() === '') continue;

        // list glue: find the last non-blank line before the gap
        let prev = '';
        for (let pi = li - 1; pi >= 0; pi--) {
            if (lines[pi].trim() !== '') { prev = lines[pi]; break; }
        }
        if (LIST_LINE.test(next) || LIST_LINE.test(prev)) continue;

        const end = lineStart + line.length + 1; // include this blank line + its newline
        blocks.push(text.slice(blockStart, end));
        blockStart = end;
    }
    blocks.push(text.slice(blockStart));
    return blocks;
}

// ---------------------------------------------------------------------------- balancer counts

/**
 * Occurrence counts for the processor's display-side closer balancing. One allocation-free
 * pass replacing four stock `countOccurrences` scans that allocated a substring per character
 * position (recon-streaming suspect #2). Counts are OVERLAPPING for the multi-char tokens,
 * matching stock's positional-substring semantics exactly (four backticks = two ``` hits).
 * Exported for Jest.
 * @param {string} text
 * @returns {{star: number, quote: number, fence: number, tilde: number}}
 */
export function countBalanceTokens(text) {
    let star = 0, quote = 0, fence = 0, tilde = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 42) star++;                 // *
        else if (c === 34) quote++;           // "
        else if (c === 96 && text.charCodeAt(i + 1) === 96 && text.charCodeAt(i + 2) === 96) fence++;   // ```
        else if (c === 126 && text.charCodeAt(i + 1) === 126 && text.charCodeAt(i + 2) === 126) tilde++; // ~~~
    }
    return { star, quote, fence, tilde };
}

// ---------------------------------------------------------------------------- paint scheduler

/**
 * Leading-edge, rAF-aligned paint throttle. Replaces the stock trailing-edge Stopwatch, whose
 * missing leading edge silently dropped the first token (recon-streaming §1b). The latest job
 * always wins; paints never exceed streaming_fps; a hidden tab falls back to setTimeout
 * because rAF pauses there (a measured footgun on this machine).
 */
export class PaintScheduler {
    /** @param {() => number} getFps */
    constructor(getFps) {
        this.getFps = getFps;
        this.lastPaint = 0;
        this.rafId = null;
        this.timerId = null;
        /** @type {(() => Promise<void>|void)?} */
        this.job = null;
        this.cancelled = false;
    }

    /** @param {() => Promise<void>|void} job the paint closure; later requests supersede it */
    request(job) {
        if (this.cancelled) return;
        this.job = job;
        if (this.rafId !== null || this.timerId !== null) return;
        const interval = 1000 / Math.max(1, this.getFps() || 30);
        const due = this.lastPaint + interval - performance.now();
        if (due <= 0) this.#fire();
        else this.timerId = setTimeout(() => { this.timerId = null; this.#fire(); }, due);
    }

    #fire() {
        const run = async () => {
            this.rafId = null;
            const job = this.job;
            this.job = null;
            this.lastPaint = performance.now();
            if (!this.cancelled && job) await job();
        };
        if (document.hidden) { this.timerId = setTimeout(() => { this.timerId = null; run(); }, 0); } else { this.rafId = requestAnimationFrame(() => run()); }
    }

    /** Runs a still-pending job immediately (finalize wants the last tokens on screen). */
    async flush() {
        if (this.timerId !== null) { clearTimeout(this.timerId); this.timerId = null; }
        if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        const job = this.job;
        this.job = null;
        this.lastPaint = performance.now();
        if (!this.cancelled && job) await job();
    }

    cancel() {
        this.cancelled = true;
        if (this.timerId !== null) { clearTimeout(this.timerId); this.timerId = null; }
        if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        this.job = null;
    }
}

// ---------------------------------------------------------------------------- the view

/**
 * @typedef {object} StreamMeta
 * @property {string} name
 * @property {boolean} isSystem
 * @property {boolean} isUser
 * @property {number} messageId
 */

/** One per generation. Owns every pixel the processor used to write into `.mes_text`. */
export class StreamingView {
    /** @param {HTMLElement} mesTextEl the row's `.mes_text` */
    constructor(mesTextEl) {
        this.mesTextEl = mesTextEl;
        /** @type {HTMLElement?} */
        this.host = null;
        /** @type {{raw: string, nodes: ChildNode[]}[]} */
        this.settled = [];
        this.settledRaw = '';
        /** @type {ChildNode[]} */
        this.tailNodes = [];
        this.passOpen = false;
        this.passLength = -1;
        this.scratch = document.createElement('template');
    }

    /** Formats one piece through the real pipeline, inside the stream's depth pass. */
    #format(text, meta) {
        this.#ensurePass();
        return deps.messageFormatting(text, meta.name, meta.isSystem, meta.isUser, meta.messageId, {}, false);
    }

    /** Keeps a format pass open for the stream; rebuilt when chat length shifts under it. */
    #ensurePass() {
        const chat = deps.getChat();
        if (this.passOpen && this.passLength === chat.length) return;
        if (this.passOpen) deps.endFormatPass();
        deps.beginFormatPass(chat);
        this.passOpen = true;
        this.passLength = chat.length;
    }

    #closePass() {
        if (this.passOpen) { deps.endFormatPass(); this.passOpen = false; }
    }

    #ensureMounted() {
        if (this.host?.isConnected) return;
        this.host = document.createElement('k-stream-text');
        this.mesTextEl.replaceChildren(this.host);
        this.settled = [];
        this.settledRaw = '';
        this.tailNodes = [];
    }

    /** @param {string} html @returns {ChildNode[]} parsed nodes */
    #parse(html) {
        this.scratch.innerHTML = html;
        return [...this.scratch.content.childNodes];
    }

    /**
     * The per-tick paint. `processedText` is the post-cleanUpMessage, post-balancer cumulative
     * text — exactly the string the processor persists to chat[].mes on this tick (stock
     * persists the appended closers on non-final ticks too; the recon's claim that closers
     * were display-only was a miscall, corrected here).
     * @param {string} processedText
     * @param {StreamMeta} meta
     * @returns {void}
     */
    setBody(processedText, meta) {
        if (!processedText) {
            // Preserve the `.mes_text:empty` pre-first-token state the shell CSS keys on.
            if (this.host?.isConnected) this.host.replaceChildren();
            else this.mesTextEl.replaceChildren();
            return;
        }
        this.#ensureMounted();

        const powerUser = deps.getPowerUser();
        const incremental = deps.formatCacheUsable() && !powerUser.stream_fade_in;

        if (!incremental) {
            // Stock path: one full format + one full paint per tick.
            const html = this.#format(processedText, meta);
            if (powerUser.stream_fade_in) deps.applyStreamFadeIn(this.host, html);
            else this.host.innerHTML = html;
            this.settled = []; this.settledRaw = ''; this.tailNodes = [];
            return;
        }

        // Self-verify: cleanup may rewrite earlier text; when the settled prefix no longer
        // prefixes the input, rebuild everything (stock cost, correct output).
        if (this.settledRaw && !processedText.startsWith(this.settledRaw)) {
            this.settled = [];
            this.settledRaw = '';
        }

        const blocks = splitStreamBlocks(processedText);
        // Re-anchor: how many leading blocks are already settled with identical raw text?
        let keep = 0;
        while (keep < this.settled.length && keep < blocks.length - 1 && this.settled[keep].raw === blocks[keep]) keep++;
        if (keep < this.settled.length) {
            // A previously settled block changed (splitter re-drew boundaries): drop it and
            // everything after it from the DOM and re-settle.
            for (let i = keep; i < this.settled.length; i++) for (const n of this.settled[i].nodes) n.remove();
            this.settled.length = keep;
            this.settledRaw = this.settled.map(b => b.raw).join('');
        }

        // Settle every completed block that is not yet settled.
        for (let i = this.settled.length; i < blocks.length - 1; i++) {
            const raw = blocks[i];
            const nodes = this.#parse(this.#format(raw, meta));
            for (const n of this.tailNodes) n.remove();
            this.tailNodes = [];
            this.host.append(...nodes);
            this.settled.push({ raw, nodes });
            this.settledRaw += raw;
        }

        // The live tail: format only the tail, replace only the tail nodes. Settled DOM is
        // never touched — §2.5's stable-paragraph requirement (bubble-split pills don't
        // flicker). Closers already live in the tail: the processor balanced before calling.
        const tailRaw = blocks[blocks.length - 1];
        const newTail = tailRaw ? this.#parse(this.#format(tailRaw, meta)) : [];
        for (const n of this.tailNodes) n.remove();
        this.host.append(...newTail);
        this.tailNodes = newTail;
    }

    /**
     * Stream end: one full stock-shape reformat written straight into `.mes_text`, element
     * unmounted — the DOM ends byte-shaped exactly as stock left it.
     * @param {string} finalText @param {StreamMeta} meta
     * @returns {string} the final HTML (the caller assigns nothing; provided for symmetry)
     */
    finalize(finalText, meta) {
        const html = this.#format(finalText, meta);
        this.#closePass();
        this.host?.remove();
        this.host = null;
        this.mesTextEl.innerHTML = html;
        return html;
    }

    /** Abort without finalize: unwrap in place — the last painted nodes stay in `.mes_text`. */
    detach() {
        this.#closePass();
        if (this.host?.isConnected) {
            this.host.replaceWith(...this.host.childNodes);
        }
        this.host = null;
    }
}
