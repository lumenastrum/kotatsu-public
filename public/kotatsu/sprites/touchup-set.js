/**
 * Touch-up on a whole sprite set — the pure rules (no DOM, no network). The pixel tools live in
 * `pixels/touchup.js`; this file decides what an edit on one sprite does to the others and how it undoes.
 *
 * - **Apply to matching**: an edit's RESULT (not a replay) is copied to every other sprite whose RAW drawing is
 *   byte-identical over the edit's footprint (+6 px: the edge matte reaches 2 and looks 3 further). Same drawing
 *   there, same pixels. A sprite drawn in another pose differs there and is skipped by name.
 * - **Sync body**: this sprite's cut becomes every other sprite's cut wherever the drawings are the same picture,
 *   6 px clear of anything that differs (each repainted face keeps its own edges). A sprite less than half the same
 *   picture is another pose: skipped.
 * - **Linked undo**: an edit that landed on N sprites is one undo step. Undoing it where it was made takes it back
 *   everywhere it landed, while it is still the top of each sprite's history.
 *
 * A doc with no raw (`raw: null`, an uploaded set) can only be erased by hand; it never receives or sends a copy.
 */

import {
    copyWhere, detectKey, dilate, erase, keepFigure, keyTester, rawDiffers, restore, sameDrawing, smartClear, wand,
} from './pixels/touchup.js';

/** An image whose bytes are a Uint8ClampedArray (the core's Img also allows Uint8Array). @typedef {{ width: number, height: number, data: Uint8ClampedArray }} Img */

/** Footprint margin for apply-to-matching, in px. */
export const FOOTPRINT_MARGIN = 6;
/** Sync body: drawings closer than this to a difference are left alone. */
export const SYNC_MARGIN = 6;
/** Sync body: below this share of the canvas being the same picture, a sprite is another pose. */
export const SYNC_MIN_SHARE = 0.5;
/** Undo steps kept per sprite. */
export const UNDO_DEPTH = 40;

/**
 * @typedef {object} UndoEntry
 * @property {Uint8ClampedArray} data the cut before (undo) or after (redo) the step
 * @property {number} op the edit's id
 * @property {string[]} [linked] files the same edit landed on
 */
/**
 * @typedef {object} TouchupDoc
 * @property {string} file
 * @property {Img | null} raw the drawing on its flat background; null for a set with no raw
 * @property {Img} cut the sprite being fixed, changed in place
 * @property {{ key: number[], white: boolean, tol: number } | null} key
 * @property {number} tol
 * @property {((p: number) => boolean) | null} test
 * @property {UndoEntry[]} undo
 * @property {UndoEntry[]} redo
 * @property {boolean} dirty
 * @property {Uint8ClampedArray} loaded the cut as it was on disk
 */
/**
 * One edit. `wand`: click (shift = global). `mask`: a painted or lassoed mask with a mode.
 * @typedef {{ kind: 'wand', x: number, y: number, global?: boolean } | { kind: 'mask', mask: Uint8Array, mode: 'smart' | 'restore' | 'erase' }} Op
 */
/**
 * @typedef {object} RunResult
 * @property {number} changed pixels changed on the current sprite
 * @property {string} msg a one-line account for the user
 * @property {string[]} applied files the edit also landed on
 * @property {string[]} skipped files left alone (drawing differs there), by name
 */

/**
 * A doc for one sprite.
 * @param {string} file @param {Img | null} raw @param {Img} cut
 * @returns {TouchupDoc}
 */
export function makeDoc(file, raw, cut) {
    const key = raw ? detectKey(raw) : null;
    return {
        file, raw, cut, key, tol: key?.tol ?? 0,
        test: raw && key ? keyTester(raw, key.key, key.tol, key.white) : null,
        undo: [], redo: [], dirty: false, loaded: cut.data.slice(),
    };
}

/**
 * Change the tolerance of a doc's background test.
 * @param {TouchupDoc} d @param {number} tol
 */
export function setTolerance(d, tol) {
    if (!d.raw || !d.key) return;
    d.tol = tol;
    d.test = keyTester(d.raw, d.key.key, tol, d.key.white);
}

/**
 * Pixel-identical RGBA?
 * @param {Uint8ClampedArray} a @param {Uint8ClampedArray} b
 */
export function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** The label shown for a file: its name without `.png`. @param {string} file */
const nameOf = file => file.replace(/\.png$/i, '');

export class TouchupSet {
    /**
     * @param {string[]} files the set's sprite files, in order
     * @param {(file: string) => Promise<{ raw: Img | null, cut: Img }>} load reads one sprite's pixels
     */
    constructor(files, load) {
        this.files = files;
        this.load = load;
        /** @type {Map<string, TouchupDoc>} */
        this.docs = new Map();
        /** @type {Map<string, Promise<TouchupDoc>>} */
        this.pending = new Map();
        this.opSeq = 0;
    }

    /**
     * A sprite's doc, loading it once.
     * @param {string} file
     * @returns {Promise<TouchupDoc>}
     */
    ensure(file) {
        const known = this.docs.get(file);
        if (known) return Promise.resolve(known);
        let pending = this.pending.get(file);
        if (!pending) {
            pending = this.load(file).then(({ raw, cut }) => {
                const doc = makeDoc(file, raw, cut);
                this.docs.set(file, doc);
                this.pending.delete(file);
                return doc;
            });
            this.pending.set(file, pending);
        }
        return pending;
    }

    /** @returns {TouchupDoc[]} loaded docs with unsaved edits */
    dirtyDocs() {
        return [...this.docs.values()].filter(d => d.dirty);
    }

    /**
     * @param {TouchupDoc} d @param {number} op
     */
    snapshot(d, op) {
        d.undo.push({ data: d.cut.data.slice(), op });
        if (d.undo.length > UNDO_DEPTH) d.undo.shift();
        d.redo.length = 0;
    }

    /**
     * One edit on one sprite.
     * @param {TouchupDoc} d @param {Op} op
     * @returns {{ changed: number, region: Uint8Array | undefined, msg: string }}
     */
    static applyOp(d, op) {
        if (op.kind === 'wand') {
            if (!d.raw || !d.test || !d.key) return { changed: 0, region: undefined, msg: 'the wand needs the raw drawing, and this set has none' };
            const r = wand(d.raw, d.cut, op.x, op.y, { test: d.test, key: d.key.key, global: op.global });
            /** @type {Record<string, string>} */
            const why = {
                'not-background': 'that pixel is not the background colour (raise Tolerance, or use the lasso)',
                'too-large': 'that patch is too big to be a shadow on the background: Shift + lasso erases it',
                'already-clear': 'already clear there',
                outside: '',
            };
            const what = r.patch ? 'cleared a shadow on the background,' : 'cleared';
            return {
                changed: r.cleared + r.matted, region: r.region,
                msg: r.cleared ? `wand: ${what} ${r.cleared} px, matted ${r.matted}` : why[r.reason ?? ''] ?? 'nothing to clear',
            };
        }
        let n = 0;
        let msg = '';
        if (op.mode === 'erase' || !d.raw) {
            n = erase(d.cut, op.mask).erased;
            msg = `erased ${n} px`;
        } else if (op.mode === 'restore') {
            n = restore(d.raw, d.cut, op.mask).restored;
            msg = `restored ${n} px`;
        } else if (d.test && d.key) {
            const r = smartClear(d.raw, d.cut, op.mask, { test: d.test, key: d.key.key });
            n = r.cleared + r.matted;
            msg = `cleared ${r.cleared} px, matted ${r.matted}`;
        }
        return { changed: n, region: op.mask, msg: n ? msg : 'nothing changed (no background-coloured pixels there)' };
    }

    /**
     * Runs an edit on `file`, then (apply to matching) copies the result to every other sprite whose raw drawing is
     * byte-identical over the edit's footprint. The undo step is linked across all of them.
     * @param {string} file @param {Op} op @param {boolean} applyAll
     * @returns {Promise<RunResult>}
     */
    async run(file, op, applyAll) {
        const d = await this.ensure(file);
        const id = ++this.opSeq;
        this.snapshot(d, id);
        const r = TouchupSet.applyOp(d, op);
        /** @type {string[]} */ const applied = [];
        /** @type {string[]} */ const skipped = [];
        if (!r.changed || !r.region) {
            d.undo.pop();
            return { changed: r.changed, msg: r.msg, applied, skipped };
        }
        d.dirty = true;
        let tail = '';
        if (applyAll && d.raw && this.files.length > 1) {
            const foot = dilate(r.region, d.raw.width, d.raw.height, FOOTPRINT_MARGIN);
            for (const other of this.files) {
                if (other === file) continue;
                const o = await this.ensure(other);
                if (!o.raw || rawDiffers(d.raw, o.raw, foot)) { skipped.push(nameOf(other)); continue; }
                this.snapshot(o, id);
                if (!copyWhere(d.cut, o.cut, foot)) { o.undo.pop(); continue; }
                o.dirty = true;
                applied.push(other);
            }
            d.undo[d.undo.length - 1].linked = applied;
            if (applied.length) tail += ` · also on ${applied.length} matching`;
            if (skipped.length) tail += ` · skipped ${skipped.join(', ')} (drawing differs here)`;
        }
        return { changed: r.changed, msg: r.msg + tail, applied, skipped };
    }

    /**
     * Sync body: this sprite's cut becomes the cut of every other sprite wherever their drawings are the same
     * picture. One undo here takes it back everywhere.
     * @param {string} file
     * @returns {Promise<{ applied: string[], skipped: string[], px: number, msg: string }>}
     */
    async syncBody(file) {
        const d = await this.ensure(file);
        /** @type {string[]} */ const applied = [];
        /** @type {string[]} */ const skipped = [];
        let px = 0;
        if (!d.raw) return { applied, skipped, px, msg: 'sync needs the raw drawings, and this set has none' };
        const id = ++this.opSeq;
        this.snapshot(d, id);
        for (const other of this.files) {
            if (other === file) continue;
            const o = await this.ensure(other);
            const same = o.raw ? sameDrawing(d.raw, o.raw, SYNC_MARGIN) : null;
            if (!same || same.share < SYNC_MIN_SHARE) { skipped.push(nameOf(other)); continue; }
            this.snapshot(o, id);
            const n = copyWhere(d.cut, o.cut, same.mask);
            if (!n) { o.undo.pop(); continue; }
            o.dirty = true;
            px += n;
            applied.push(other);
        }
        const note = skipped.length ? ` · skipped ${skipped.join(', ')} (another drawing)` : '';
        if (!applied.length) {
            d.undo.pop();
            return { applied, skipped, px, msg: `nothing to sync${note}` };
        }
        d.undo[d.undo.length - 1].linked = applied;
        d.dirty = true;
        return { applied, skipped, px, msg: `synced this body onto ${applied.length} sprite${applied.length > 1 ? 's' : ''} (${px} px brought in line)${note}` };
    }

    /**
     * Keep the figure: drop specks (largest piece plus anything within 6 px).
     * @param {string} file
     * @returns {Promise<{ dropped: number[], msg: string }>}
     */
    async keepFigure(file) {
        const d = await this.ensure(file);
        this.snapshot(d, ++this.opSeq);
        const { dropped } = keepFigure(d.cut);
        if (!dropped.length) { d.undo.pop(); return { dropped, msg: 'no specks' }; }
        d.dirty = true;
        return { dropped, msg: `dropped ${dropped.length} speck(s): ${dropped.slice(0, 6).join(', ')} px` };
    }

    /**
     * Back to the cut as loaded from disk (undo brings the edits back).
     * @param {string} file
     */
    async revert(file) {
        const d = await this.ensure(file);
        this.snapshot(d, ++this.opSeq);
        d.cut.data.set(d.loaded);
        d.dirty = true;
    }

    /**
     * @param {string} file @param {'undo' | 'redo'} from
     * @returns {Promise<{ stepped: boolean, linked: number }>} linked = other sprites that stepped with it
     */
    async step(file, from) {
        const to = from === 'undo' ? 'redo' : 'undo';
        const d = await this.ensure(file);
        const entry = d[from].pop();
        if (!entry) return { stepped: false, linked: 0 };
        d[to].push({ data: d.cut.data.slice(), op: entry.op, linked: entry.linked });
        d.cut.data.set(entry.data);
        d.dirty = true;
        let n = 0;
        for (const name of entry.linked ?? []) {
            const o = this.docs.get(name);
            const top = o?.[from][o[from].length - 1];
            if (!o || !top || top.op !== entry.op) continue;
            o[from].pop();
            o[to].push({ data: o.cut.data.slice(), op: entry.op });
            o.cut.data.set(top.data);
            o.dirty = true;
            n++;
        }
        return { stepped: true, linked: n };
    }

    undo(/** @type {string} */ file) { return this.step(file, 'undo'); }
    redo(/** @type {string} */ file) { return this.step(file, 'redo'); }
}
