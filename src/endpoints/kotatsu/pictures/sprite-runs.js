/**
 * Sprite generator runs (docs/handoffs/sprite-generator.md, build slice G1): one character in, a set of expressions
 * out in two framings. A run is a sequence of ComfyUI jobs (each on the same job machinery as Pictures, saved into the
 * run's folder instead of the gallery) with pixel steps between them, and three stops where a person decides:
 *
 *   masters (gate each)  → pick (a master, or their own upload)
 *   → bust (face box: detector, or the person drags it on the master) → derive the bust
 *   → masks (the two proposed masks; nudge, protected marks) → expressions:
 *        neutral repaint, each label repaints the neutral, marks pasted back, every face pasted into the master,
 *        every sprite cut by colour → review (reroll one label at a time)
 *
 * Stages: `masters` → `pick`* → [`face`*] → `bust` → `masks`* → `expressions` → `review`* (* = waiting on a person);
 * also `error`, `cancelled`, `interrupted` (the server restarted mid-step).
 *
 * On disk, rebuildable working state: `user/images/<character>/.kotatsu/sprite-runs/<id>/` with `state.json`,
 * `masters/<seed>.png`, `master.png`, `bust/derived.png`, `masks/{features,flush,marks}.png`, `bust/<label>.png`,
 * `full/<label>.png`, `cut/{bust,full}/<label>.png`. Saving onto the card is the Studio's step (slice G3 decides where).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { createJobManager, JOB_EVENTS } from './jobs.js';
import { modelLists, nodeOptions } from './comfy.js';
import { characterFolder } from './store.js';
import { canonicalJson } from './recipes.js';
import {
    ENGINES, FLUSH_LABELS, LLLITE_STRENGTH,
    deriveGraph, detectGraph, hasFaceDetector, masterGraph, pasteGraph, repaintGraph, resolveModels, spriteNeeds,
} from './sprite-graphs.js';
import { decodeImage, encodePng, writePng } from '../sprites/pixel-io.js';
import { LIME, dilate, imageToMask, maskToImage } from '../../../../public/kotatsu/sprites/pixels/image.js';
import { gateMaster } from '../../../../public/kotatsu/sprites/pixels/gates.js';
import { cutKey } from '../../../../public/kotatsu/sprites/pixels/cut.js';
import { bustCrop, faceMasks, markRegion, maskBox, pasteMarks } from '../../../../public/kotatsu/sprites/pixels/face.js';
import { blurMask, cropScaleMask, hardMask, repaintRegion } from '../../../../public/kotatsu/sprites/pixels/inpaint.js';

/** @typedef {import('./sprite-graphs.js').Look} Look */
/** @typedef {import('./sprite-graphs.js').Models} Models */
/** @typedef {import('../../../../public/kotatsu/sprites/pixels/image.js').Img} Img */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box */
/** @typedef {{ label: string, rung: 'mild' | 'strong', tags: string, mask: 'features' | 'flush', seed: number, state: string, error?: string }} LabelState */

export const STAGES = Object.freeze({
    MASTERS: 'masters', PICK: 'pick', FACE: 'face', BUST: 'bust', MASKS: 'masks', EXPRESSIONS: 'expressions',
    REVIEW: 'review', ERROR: 'error', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted',
});
/** What a run shows and saves (never the client, its auth, the emitter or the folder path). */
const PUBLIC_FIELDS = Object.freeze(['id', 'character', 'server', 'engine', 'models', 'look', 'size', 'neutral', 'labels',
    'bustHeight', 'refine', 'detector', 'stage', 'masters', 'seed', 'face', 'crop', 'step', 'error', 'savedTo', 'savedAt', 'createdAt', 'updatedAt']);
const WAITING = new Set([STAGES.PICK, STAGES.FACE, STAGES.MASKS, STAGES.REVIEW]);
const ENDED = new Set([STAGES.ERROR, STAGES.CANCELLED, STAGES.INTERRUPTED]);

/** The default set: neutral plus five families the classifier's `LABEL_PARENT` maps every label onto. */
export const DEFAULT_LABELS = Object.freeze(['joy', 'anger', 'surprise', 'embarrassment', 'sadness']);
export const BUST_SIZE = 1024;
const SEED_LIMIT = 2 ** 32;
const LABEL_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export class SpriteRunError extends Error {
    /** @param {string} message @param {number} [status] @param {object} [extra] */
    constructor(message, status = 400, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

class Cancelled extends Error {}

/**
 * Job saves for sprite steps: into the run folder, at the step's own path (never the character's gallery).
 * @param {{ userImages: string, character: string, bytes: Buffer, ext?: string }} o  userImages = run folder,
 *   character = step path (e.g. `bust/joy`)
 */
async function saveStep({ userImages, character, bytes, ext = 'png' }) {
    const file = path.join(userImages, `${character}.${ext}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return { url: file };
}

/**
 * A job manager for sprite steps (same lifecycle as Pictures jobs; saves land in the run folder).
 * @param {Parameters<typeof createJobManager>[0]} [options]
 */
export function createSpriteJobManager(options = {}) {
    return createJobManager({ ...options, saveImage: saveStep });
}

/**
 * The run manager.
 * @param {object} [options]
 * @param {ReturnType<typeof createJobManager>} [options.jobs]   from `createSpriteJobManager`
 * @param {() => number} [options.random]
 * @param {{ warn?: Function }} [options.logger]
 */
export function createSpriteRuns({ jobs = createSpriteJobManager(), random = Math.random, logger = console } = {}) {
    /** @type {Map<string, any>} */
    const runs = new Map();
    /** @type {Map<string, { at: number, lists: Record<string, string[]>, classTypes: Set<string> }>} */
    const serverFacts = new Map();

    const file = (/** @type {any} */ run, /** @type {string} */ rel) => path.join(run.dir, rel);
    const exists = (/** @type {any} */ run, /** @type {string} */ rel) => fs.existsSync(file(run, rel));

    /** What GET shows (no client, no auth, no emitter). @param {any} run */
    function publicView(run) {
        return Object.fromEntries(PUBLIC_FIELDS.filter(k => run[k] !== undefined).map(k => [k, run[k]]));
    }

    /** @param {any} run */
    function persist(run) {
        try {
            writeFileAtomicSync(file(run, 'state.json'), `${JSON.stringify(publicView(run), null, 1)}\n`, 'utf8');
        } catch (error) {
            logger.warn?.('[Sprites] could not write run state', error);
        }
    }

    /** @param {any} run @param {string} event @param {object} data */
    function emit(run, event, data) {
        run.emitter.emit('event', event, data);
    }

    /** @param {any} run @param {Partial<any>} patch */
    function update(run, patch) {
        Object.assign(run, patch, { updatedAt: Date.now() });
        persist(run);
        emit(run, 'state', publicView(run));
    }

    /** @param {any} run @param {object} step */
    function progress(run, step) {
        run.step = step;
        emit(run, 'progress', step);
    }

    /**
     * What the server has, cached for a minute.
     * @param {any} client
     */
    async function factsOf(client) {
        const cached = serverFacts.get(client.base);
        if (cached && Date.now() - cached.at < 60_000) return cached;
        const info = await client.objectInfo();
        const lists = { ...modelLists(info), model_patches: nodeOptions(info, 'ModelPatchLoader', 'name'), detectors: nodeOptions(info, 'UltralyticsDetectorProvider', 'model_name') };
        const facts = { at: Date.now(), lists, classTypes: new Set(Object.keys(info ?? {})) };
        serverFacts.set(client.base, facts);
        return facts;
    }

    /**
     * Uploads an image to ComfyUI's input folder; returns the LoadImage value.
     * @param {any} run @param {string} name @param {Buffer} bytes
     */
    async function upload(run, name, bytes) {
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const reply = await run.client.uploadImage(bytes, `${run.id.slice(0, 8)}-${name}-${hash}.png`, { subfolder: 'kotatsu-sprites' });
        return reply?.subfolder ? `${reply.subfolder}/${reply.name}` : String(reply?.name ?? '');
    }
    /** @param {any} run @param {string} rel @param {string} [name] */
    const uploadFile = (run, rel, name = rel.replace(/[\\/]/g, '-').replace(/\.png$/, '')) => upload(run, name, fs.readFileSync(file(run, rel)));
    /** @param {any} run @param {string} name @param {Uint8Array} mask @param {number} W @param {number} H @param {boolean} soft */
    async function uploadMask(run, name, mask, W, H, soft) {
        return upload(run, name, await encodePng(maskToImage(mask, W, H, soft)));
    }

    /**
     * Runs one graph as a job and waits for it. Its first image lands at `<run>/<step>.png`.
     * @param {any} run @param {string} step @param {Record<string, any>} graph @param {object} [about] progress detail
     * @returns {Promise<string>} the saved file
     */
    async function runGraph(run, step, graph, about = {}) {
        if (run.cancelled) throw new Cancelled();
        const graphSha = createHash('sha256').update(canonicalJson(graph)).digest('hex');
        const job = jobs.create({
            client: run.client, graph, graphSha, seed: Number(graph.k?.inputs?.seed ?? 0), recipe: `sprite:${step}`,
            purpose: 'sprite', character: step, userImages: run.dir, owner: run.owner, outputsOrder: ['s'],
        });
        run.currentJob = job.id;
        try {
            const done = await new Promise((resolve, reject) => {
                jobs.subscribe(job.id, (event, data) => {
                    if (event === JOB_EVENTS.PROGRESS || event === JOB_EVENTS.QUEUED) progress(run, { ...about, step, [event]: data });
                    else if (event === JOB_EVENTS.DONE) resolve(data);
                    else if (event === JOB_EVENTS.ERROR) reject(new SpriteRunError(`${step}: ${/** @type {any} */ (data)?.message ?? 'failed'}`, 502));
                    else if (event === JOB_EVENTS.CANCELLED) reject(new Cancelled());
                });
            });
            return /** @type {any} */ (done).images[0].url;
        } finally {
            run.currentJob = null;
        }
    }

    /**
     * A step body with the run's error handling: cancelled → `cancelled`; anything else → `error`.
     * @param {any} run @param {() => Promise<void>} body
     */
    function launch(run, body) {
        const task = (async () => {
            try {
                await body();
            } catch (error) {
                if (error instanceof Cancelled || run.cancelled) update(run, { stage: STAGES.CANCELLED });
                else {
                    logger.warn?.(`[Sprites] run ${run.id} failed`, error);
                    update(run, { stage: STAGES.ERROR, error: error instanceof Error ? error.message : String(error) });
                }
            } finally {
                run.step = null;
            }
        })();
        Object.defineProperty(run, 'task', { value: task, enumerable: false, writable: true, configurable: true });
    }

    /** @param {any} run @param {string} stage */
    function expectStage(run, stage) {
        if (run.stage !== stage) throw new SpriteRunError(`The run is at "${run.stage}", not "${stage}"`, 409);
    }

    // ── steps ──────────────────────────────────────────────────────────────────────────────────────

    /** @param {any} run @param {number[]} seeds */
    async function drawMasters(run, seeds) {
        for (const [n, seed] of seeds.entries()) {
            const at = await runGraph(run, `masters/${seed}`, masterGraph({ engine: run.engineDef, models: run.models, look: run.look, seed, width: run.size.width, height: run.size.height, expression: run.neutral }), { stage: STAGES.MASTERS, n: n + 1, of: seeds.length });
            const gate = gateMaster(await decodeImage(at), { reference: [...LIME] });
            await writePng(file(run, `masters/${seed}.cut.png`), gate.cut);
            const summary = { ...gate, cut: undefined };
            run.masters = [...run.masters.filter((/** @type {any} */ m) => m.seed !== seed), { seed, file: `masters/${seed}.png`, cutFile: `masters/${seed}.cut.png`, gate: summary }];
            update(run, {});
        }
        update(run, { stage: STAGES.PICK });
    }

    /** @param {any} run @param {string} rel @returns {Promise<Box | null>} */
    async function detectFace(run, rel) {
        if (!run.detector) return null;
        // Optional by design: a detector that fails (a node update, a renamed model) costs the person a face box
        // drag, never the run. Off for the rest of the run, so it fails once.
        try {
            const name = await uploadFile(run, rel);
            const at = await runGraph(run, `faces/${rel.replace(/[\\/]/g, '-').replace(/\.png$/, '')}`, detectGraph({ image: name }), { stage: run.stage });
            const img = await decodeImage(at);
            return maskBox(imageToMask(img), img.width, img.height);
        } catch (error) {
            if (error instanceof Cancelled || run.cancelled) throw error;
            logger.warn?.(`[Sprites] run ${run.id}: the face detector failed, the face box is drawn by hand`, error);
            update(run, { detector: false });
            return null;
        }
    }

    /** The bust: crop on the master, derive, the bust's face box, the proposed masks. @param {any} run */
    async function deriveBust(run) {
        const master = await decodeImage(file(run, 'master.png'));
        const crop = bustCrop(master, run.face.master, { bustHeight: run.bustHeight });
        update(run, { stage: STAGES.BUST, crop });
        const masterName = await uploadFile(run, 'master.png');
        await runGraph(run, 'bust/derived', deriveGraph({ engine: run.engineDef, models: run.models, look: run.look, image: masterName, crop, seed: run.seed, refine: run.refine, size: BUST_SIZE, expression: run.neutral }), { stage: STAGES.BUST });
        const k = BUST_SIZE / crop.side;
        const moved = { x: (run.face.master.x - crop.x) * k, y: (run.face.master.y - crop.y) * k, w: run.face.master.w * k, h: run.face.master.h * k };
        const found = await detectFace(run, 'bust/derived.png');
        const bustFace = found ?? moved;
        const masks = faceMasks(bustFace, BUST_SIZE, BUST_SIZE);
        await writePng(file(run, 'masks/features.png'), maskToImage(masks.features, BUST_SIZE, BUST_SIZE, true));
        await writePng(file(run, 'masks/flush.png'), maskToImage(masks.flush, BUST_SIZE, BUST_SIZE, true));
        update(run, { stage: STAGES.MASKS, face: { ...run.face, bust: bustFace, bustFrom: found ? 'detector' : 'master' } });
    }

    /**
     * One face repaint on the bust from `base`, marks pasted back from the derived bust; writes `bust/<label>.png`.
     * @param {any} run @param {string} base rel @param {string} label @param {string} tags @param {'features' | 'flush'} type @param {number} seed
     */
    async function repaint(run, base, label, tags, type, seed) {
        const mask = imageToMask(await decodeImage(file(run, `masks/${type}.png`)));
        const region = repaintRegion(mask, BUST_SIZE, BUST_SIZE, { size: 1024 });
        if (!region) throw new SpriteRunError(`The ${type} mask is empty`);
        const [image, inner, blend] = await Promise.all([
            uploadFile(run, base),
            uploadMask(run, `${type}-inner`, region.inner, region.size, region.size, true),
            uploadMask(run, `${type}-blend`, region.blend, region.crop.side, region.crop.side, true),
        ]);
        const strength = run.engineDef.repaint === 'lllite' ? LLLITE_STRENGTH[type] : undefined;
        const at = await runGraph(run, `bust/${label}`, repaintGraph({ engine: run.engineDef, models: run.models, look: run.look, image, inner, blend, crop: region.crop, size: region.size, seed, expression: tags, strength }), { stage: run.stage, label });
        if (exists(run, 'masks/marks.png')) {
            const marks = hardMask(imageToMask(await decodeImage(file(run, 'masks/marks.png'))), 127);
            const out = await decodeImage(at);
            if (pasteMarks(await decodeImage(file(run, 'bust/derived.png')), out, marks)) await writePng(at, out);
        }
    }

    /**
     * Pastes `bust/<label>.png` into the master through the label's mask (grown 14 bust px, feathered), cuts both
     * framings.
     * @param {any} run @param {string} label @param {'features' | 'flush'} type
     */
    async function pasteAndCut(run, label, type) {
        const { side } = run.crop;
        const k = side / BUST_SIZE;
        const hard = hardMask(imageToMask(await decodeImage(file(run, `masks/${type}.png`))));
        const small = cropScaleMask(hard, BUST_SIZE, { x: 0, y: 0, side: BUST_SIZE }, side);
        const soft = blurMask(dilate(small, side, side, Math.max(1, Math.round(14 * k))), side, side, 7 * k);
        const [master, bust, mask] = await Promise.all([
            uploadFile(run, 'master.png'),
            uploadFile(run, `bust/${label}.png`),
            uploadMask(run, `paste-${type}`, soft, side, side, true),
        ]);
        await runGraph(run, `full/${label}`, pasteGraph({ master, bust, mask, crop: run.crop }), { stage: run.stage, label });
        for (const framing of ['bust', 'full']) {
            const cut = cutKey(await decodeImage(file(run, `${framing}/${label}.png`)));
            await writePng(file(run, `cut/${framing}/${label}.png`), cut.image);
        }
    }

    /** @param {any} run @param {LabelState} entry */
    async function makeLabel(run, entry) {
        entry.state = 'running';
        update(run, {});
        await repaint(run, 'bust/neutral.png', entry.label, entry.tags, entry.mask, entry.seed);
        await pasteAndCut(run, entry.label, entry.mask);
        entry.state = 'done';
        delete entry.error;
        update(run, {});
    }

    /** @param {any} run */
    async function makeExpressions(run) {
        update(run, { stage: STAGES.EXPRESSIONS });
        // The neutral is repainted too (the features mask, the neutral's words): a derived bust's face is softer than a
        // native bust's, and every expression starts from this neutral.
        await repaint(run, 'bust/derived.png', 'neutral', run.neutral, 'features', run.seed);
        await pasteAndCut(run, 'neutral', 'features');
        for (const entry of run.labels) {
            try {
                await makeLabel(run, entry);
            } catch (error) {
                if (error instanceof Cancelled || run.cancelled) throw error;
                entry.state = 'error';
                entry.error = error instanceof Error ? error.message : String(error);
                update(run, {});
            }
        }
        update(run, { stage: STAGES.REVIEW });
    }

    // ── the public API (routes call these) ────────────────────────────────────────────────────────

    /**
     * Reads the labels a run is asked for.
     * @param {any} engine @param {unknown} value @param {number} seed
     * @returns {LabelState[]}
     */
    function readLabels(engine, value, seed) {
        const list = value === undefined ? DEFAULT_LABELS.map(label => ({ label })) : value;
        if (!Array.isArray(list) || !list.length || list.length > 24) throw new SpriteRunError('labels must be a list of 1–24 entries');
        const seen = new Set();
        return list.map((/** @type {any} */ item) => {
            const label = typeof item === 'string' ? item : item?.label;
            if (typeof label !== 'string' || !LABEL_NAME.test(label) || label === 'neutral') throw new SpriteRunError(`Bad label "${label}"`);
            if (seen.has(label)) throw new SpriteRunError(`Label "${label}" twice`);
            seen.add(label);
            const rung = item?.rung === 'mild' ? 'mild' : 'strong';
            const tags = typeof item?.tags === 'string' && item.tags.trim() ? item.tags.trim() : engine.labels[label]?.[rung];
            if (!tags) throw new SpriteRunError(`Label "${label}" needs tags (no built-in words for it)`);
            const mask = item?.mask === 'flush' || item?.mask === 'features' ? item.mask : (FLUSH_LABELS.has(label) ? 'flush' : 'features');
            return { label, rung, tags, mask, seed: Number.isSafeInteger(item?.seed) ? item.seed : seed, state: 'waiting' };
        });
    }

    return {
        /**
         * Starts a run: checks the server has what the engine needs, then draws and gates the masters.
         * @param {{ owner: string, userImages: string, client: any, body: any }} o
         */
        async start({ owner, userImages, client, body }) {
            const character = characterFolder(body?.character);
            if (!character) throw new SpriteRunError('character must name a folder under user/images');
            const engineDef = ENGINES[body?.engine ?? 'anima'];
            if (!engineDef) throw new SpriteRunError(`Unknown engine "${body?.engine}"`);
            const look = body?.look;
            if (!look || typeof look.positive !== 'string' || !look.positive.trim()) throw new SpriteRunError('look.positive (the character\'s tags) is required');
            const loras = Array.isArray(look.loras) ? look.loras.filter((/** @type {any} */ l) => l && typeof l.file === 'string').map((/** @type {any} */ l) => ({ file: l.file, strength: Number.isFinite(l.strength) ? l.strength : 1, trigger: typeof l.trigger === 'string' ? l.trigger : '' })) : [];
            const cleanLook = { positive: look.positive.trim(), negative: typeof look.negative === 'string' ? look.negative : '', loras };
            const width = Number(body?.width ?? 832), height = Number(body?.height ?? 1216);
            for (const v of [width, height]) if (!Number.isInteger(v) || v < 512 || v > 2048 || v % 8) throw new SpriteRunError('width and height must be multiples of 8 between 512 and 2048');
            const count = Number(body?.masters ?? 4);
            if (!Number.isInteger(count) || count < 1 || count > 8) throw new SpriteRunError('masters must be 1–8');
            const seed0 = Number.isSafeInteger(body?.seed) && body.seed >= 0 ? body.seed : Math.floor(random() * SEED_LIMIT);
            const seeds = Array.isArray(body?.seeds) && body.seeds.length
                ? body.seeds.map(Number).filter((/** @type {number} */ s) => Number.isSafeInteger(s) && s >= 0).slice(0, 8)
                : Array.from({ length: count }, (_, i) => (seed0 + i) % SEED_LIMIT);
            if (!seeds.length) throw new SpriteRunError('seeds must be whole numbers');
            const models = resolveModels(engineDef, body?.models ?? {});
            const neutral = typeof body?.neutral === 'string' && body.neutral.trim() ? body.neutral.trim() : engineDef.neutral;
            const labels = readLabels(engineDef, body?.labels, seeds[0]);

            let facts;
            try {
                facts = await factsOf(client);
            } catch {
                // The same words and code as a picture job (a fresh install with no ComfyUI met a bare 502 here).
                throw new SpriteRunError(`ComfyUI isn’t answering at ${client.base}. It draws the sprites on your own computer: start it, or set it up in Settings → Pictures.`, 400, { code: 'server_unreachable' });
            }
            const needs = spriteNeeds(engineDef, models, facts.lists, facts.classTypes);
            const missing = needs.filter(n => n.required && n.present === false);
            if (missing.length) throw new SpriteRunError(`ComfyUI is missing ${missing.map(n => n.file).join(', ')}`, 400, { code: 'needs', needs });
            if (models.upscaler && !facts.lists.upscalers?.includes(models.upscaler)) models.upscaler = null;

            const id = randomUUID();
            const dir = path.join(userImages, character, '.kotatsu', 'sprite-runs', id);
            fs.mkdirSync(dir, { recursive: true });
            const run = {
                id, owner, character, dir, server: client.base, client, emitter: new EventEmitter(), cancelled: false, currentJob: null,
                engine: engineDef.id, engineDef: undefined, models, look: cleanLook, size: { width, height }, neutral, labels,
                bustHeight: Number.isFinite(body?.bustHeight) ? Math.min(3.2, Math.max(1.4, body.bustHeight)) : 2.1,
                refine: Number.isFinite(body?.refine) ? Math.min(0.6, Math.max(0, body.refine)) : 0.25,
                detector: hasFaceDetector(facts.lists, facts.classTypes) && body?.detector !== false,
                stage: STAGES.MASTERS, masters: [], seed: null, face: null, crop: null, step: null, error: null,
                createdAt: Date.now(), updatedAt: Date.now(),
            };
            Object.defineProperty(run, 'engineDef', { value: engineDef, enumerable: false, writable: true });
            run.emitter.setMaxListeners(50);
            runs.set(id, run);
            persist(run);
            launch(run, () => drawMasters(run, seeds));
            return { run: publicView(run), needs };
        },

        /** More masters for a run still choosing. @param {any} run @param {any} body */
        more(run, body) {
            expectStage(run, STAGES.PICK);
            const count = Math.min(8, Math.max(1, Number(body?.count ?? 2) || 2));
            const top = Math.max(...run.masters.map((/** @type {any} */ m) => m.seed));
            const seeds = Array.from({ length: count }, (_, i) => (top + 1 + i) % SEED_LIMIT);
            update(run, { stage: STAGES.MASTERS });
            launch(run, () => drawMasters(run, seeds));
        },

        /**
         * The person's master: a drawn seed, or their own PNG (bytes). Then the face box (detector, the request's
         * `faceBox`, or wait at `face`), then the bust.
         * @param {any} run @param {{ seed?: number, upload?: Buffer, faceBox?: Box }} pick
         */
        async pick(run, pick) {
            expectStage(run, STAGES.PICK);
            if (pick.upload) {
                const img = await decodeImage(pick.upload);
                await writePng(file(run, 'master.png'), { ...img, data: opaque(img.data) });
                run.seed = run.masters[0]?.seed ?? Math.floor(random() * SEED_LIMIT);
            } else {
                const master = run.masters.find((/** @type {any} */ m) => m.seed === pick.seed);
                if (!master) throw new SpriteRunError(`No master with seed ${pick.seed}`);
                fs.copyFileSync(file(run, master.file), file(run, 'master.png'));
                run.seed = master.seed;
            }
            const box = readBox(pick.faceBox);
            update(run, { stage: STAGES.BUST, face: box ? { master: box, masterFrom: 'person' } : null });
            launch(run, async () => {
                if (!run.face) {
                    const found = await detectFace(run, 'master.png');
                    if (!found) {
                        update(run, { stage: STAGES.FACE });
                        return;
                    }
                    run.face = { master: found, masterFrom: 'detector' };
                }
                await deriveBust(run);
            });
        },

        /** The face box dragged on the master (no detector, or it found nothing). @param {any} run @param {any} body */
        face(run, body) {
            expectStage(run, STAGES.FACE);
            const box = readBox(body?.faceBox);
            if (!box) throw new SpriteRunError('faceBox {x, y, w, h} is required');
            update(run, { stage: STAGES.BUST, face: { master: box, masterFrom: 'person' } }); // before answering: a second click is a 409, not a second derive
            launch(run, () => deriveBust(run));
        },

        /**
         * Masks confirmed (optionally nudged: PNG bytes, white = repaint), protected marks clicked on the bust; then
         * every expression.
         * @param {any} run @param {{ features?: Buffer, flush?: Buffer, marks?: {x: number, y: number}[], labels?: unknown }} body
         */
        async masks(run, body) {
            expectStage(run, STAGES.MASKS);
            for (const type of /** @type {const} */ (['features', 'flush'])) {
                const bytes = body[type];
                if (!bytes) continue;
                const img = await decodeImage(bytes);
                if (img.width !== BUST_SIZE || img.height !== BUST_SIZE) throw new SpriteRunError(`The ${type} mask must be ${BUST_SIZE}×${BUST_SIZE}`);
                if (!maskBox(imageToMask(img), BUST_SIZE, BUST_SIZE, 25)) throw new SpriteRunError(`The ${type} mask is empty`);
                await writePng(file(run, `masks/${type}.png`), maskToImage(imageToMask(img), BUST_SIZE, BUST_SIZE, true));
            }
            if (Array.isArray(body.marks) && body.marks.length) {
                const bust = await decodeImage(file(run, 'bust/derived.png'));
                const all = new Uint8Array(BUST_SIZE * BUST_SIZE);
                for (const m of body.marks.slice(0, 64)) {
                    if (!Number.isFinite(m?.x) || !Number.isFinite(m?.y)) continue;
                    const one = markRegion(bust, m.x, m.y);
                    for (let p = 0; p < all.length; p++) if (one[p]) all[p] = 1;
                }
                await writePng(file(run, 'masks/marks.png'), maskToImage(all, BUST_SIZE, BUST_SIZE));
            } else if (exists(run, 'masks/marks.png')) fs.rmSync(file(run, 'masks/marks.png'));
            if (body.labels !== undefined) run.labels = readLabels(run.engineDef, body.labels, run.seed);
            launch(run, () => makeExpressions(run));
        },

        /** Redraw one label (new seed by default, or other words / rung / mask). @param {any} run @param {any} body */
        reroll(run, body) {
            expectStage(run, STAGES.REVIEW);
            const entry = run.labels.find((/** @type {LabelState} */ l) => l.label === body?.label);
            if (!entry) throw new SpriteRunError(`No label "${body?.label}" in this run`);
            if (body.rung === 'mild' || body.rung === 'strong') {
                entry.rung = body.rung;
                entry.tags = run.engineDef.labels[entry.label]?.[body.rung] ?? entry.tags;
            }
            if (typeof body.tags === 'string' && body.tags.trim()) entry.tags = body.tags.trim();
            if (body.mask === 'features' || body.mask === 'flush') entry.mask = body.mask;
            entry.seed = Number.isSafeInteger(body.seed) && body.seed >= 0 ? body.seed : Math.floor(random() * SEED_LIMIT);
            update(run, { stage: STAGES.EXPRESSIONS });
            launch(run, async () => {
                await makeLabel(run, entry);
                update(run, { stage: STAGES.REVIEW });
            });
        },

        /**
         * Saves a reviewed run onto the card's sprite folder: the full body as the main set (`<folder>/<label>.png`),
         * the bust in `<folder>/bust/`, each with its raw drawing in `.kotatsu/raw/` (Touch-up reads it). Like stock's
         * upload, an existing image of the same label is replaced; a Touch-up original of a replaced sprite is dropped
         * (it belonged to the old drawing). Only labels that finished are saved; the neutral always is.
         * @param {any} run @param {string} charactersDir the user's `characters` folder @param {string} folder
         * @returns {{ folder: string, labels: string[] }}
         */
        save(run, charactersDir, folder) {
            expectStage(run, STAGES.REVIEW);
            const name = sanitizeName(folder);
            if (!name) throw new SpriteRunError('folder must name a sprite folder');
            const labels = ['neutral', ...run.labels.filter((/** @type {LabelState} */ l) => l.state === 'done').map((/** @type {LabelState} */ l) => l.label)];
            for (const [framing, dir] of /** @type {const} */ ([['full', path.join(charactersDir, name)], ['bust', path.join(charactersDir, name, 'bust')]])) {
                fs.mkdirSync(path.join(dir, '.kotatsu', 'raw'), { recursive: true });
                const present = fs.readdirSync(dir);
                for (const label of labels) {
                    const cut = file(run, `cut/${framing}/${label}.png`);
                    const raw = file(run, `${framing}/${label}.png`);
                    if (!fs.existsSync(cut) || !fs.existsSync(raw)) throw new SpriteRunError(`The ${framing} ${label} sprite is missing from the run`, 500);
                    for (const old of present) {
                        if (path.parse(old).name.toLowerCase() === label && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(old)) fs.rmSync(path.join(dir, old));
                    }
                    fs.copyFileSync(cut, path.join(dir, `${label}.png`));
                    fs.copyFileSync(raw, path.join(dir, '.kotatsu', 'raw', `${label}.png`));
                    fs.rmSync(path.join(dir, '.kotatsu', 'touchup-original', `${label}.png`), { force: true });
                }
            }
            update(run, { savedTo: name, savedAt: Date.now() });
            return { folder: name, labels };
        },

        /** @param {any} run */
        cancel(run) {
            if (ENDED.has(run.stage)) return;
            run.cancelled = true;
            if (run.currentJob) jobs.cancel(run.currentJob);
            else update(run, { stage: STAGES.CANCELLED });
        },

        /**
         * A run of this user: in memory, else read back from disk (a step that was running is `interrupted`).
         * @param {string} owner @param {string} userImages @param {string} id
         */
        get(owner, userImages, id) {
            const live = runs.get(id);
            if (live) return live.owner === owner ? live : undefined;
            if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
            for (const character of safeList(userImages)) {
                const dir = path.join(userImages, character, '.kotatsu', 'sprite-runs', id);
                const stateFile = path.join(dir, 'state.json');
                if (!fs.existsSync(stateFile)) continue;
                const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
                const run = { ...state, dir, owner, emitter: new EventEmitter(), cancelled: false, currentJob: null, client: null };
                if (!WAITING.has(run.stage) && !ENDED.has(run.stage)) run.stage = STAGES.INTERRUPTED;
                Object.defineProperty(run, 'engineDef', { value: ENGINES[run.engine], enumerable: false, writable: true });
                runs.set(id, run);
                return run;
            }
            return undefined;
        },

        /** Re-attach a client after a restart (waiting stages only need one to continue). @param {any} run @param {any} client */
        attachClient(run, client) {
            if (!run.client) run.client = client;
        },

        /** The absolute path of a run file, or null when outside the run folder / missing. @param {any} run @param {string} rel */
        resolveFile(run, rel) {
            const target = path.resolve(run.dir, String(rel ?? ''));
            if (!target.startsWith(path.resolve(run.dir) + path.sep) || !target.toLowerCase().endsWith('.png') || !fs.existsSync(target)) return null;
            return target;
        },

        /** @param {any} run @param {(event: string, data: any) => void} listener */
        subscribe(run, listener) {
            listener('state', publicView(run));
            if (run.step) listener('progress', run.step);
            run.emitter.on('event', listener);
            return () => run.emitter.off('event', listener);
        },

        /** Resolves when the run's current background step ends (tests). @param {any} run */
        idle: (run) => run.task ?? Promise.resolve(),
        publicView,
        STAGES,
        shutdown: () => jobs.shutdown(),
    };
}

/** @param {Uint8Array | Uint8ClampedArray} data */
function opaque(data) {
    const out = new Uint8ClampedArray(data);
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
}

/**
 * A sprite folder name, stock's rule (`sanitize-filename`, one level: the bust subfolder is added here).
 * @param {unknown} value
 */
function sanitizeName(value) {
    return typeof value === 'string' && !value.includes('/') && !value.includes('\\') ? sanitize(value).trim() : '';
}

/** @param {unknown} value @returns {Box | null} */
function readBox(value) {
    const b = /** @type {any} */ (value);
    if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w < 8 || b.h < 8) return null;
    return { x: b.x, y: b.y, w: b.w, h: b.h };
}

/** @param {string} dir */
function safeList(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    } catch {
        return [];
    }
}
