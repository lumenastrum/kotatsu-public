/**
 * The sprite generator's ComfyUI graphs (docs/handoffs/sprite-generator.md, build slice G1). Pure: engine table,
 * prompts and API graphs, core nodes only (plus the optional Impact face detector, which the pipeline only uses when
 * the server has it). Node ids are stable on purpose: `m` model, `t` text encoder, `v` VAE, `p` / `n` prompts, `s` the
 * one SaveImage, so LoRA injection and tests can find them.
 */

import { FAMILIES } from './families.js';
import { injectLoras } from './recipes.js';

/** @typedef {{ steps: number, cfg: number, sampler: string, scheduler: string }} Sampling */
/**
 * @typedef {object} Engine
 * @property {string} id
 * @property {string} label
 * @property {{ unet: string, clip: string, clipType: string, vae: string, upscaler: string, lllite: string | null }} models defaults
 * @property {Sampling} master
 * @property {Sampling} refine
 * @property {'lllite' | 'differential'} repaint   Anima: kohya inpainting LLLite at denoise 1; Krea family: no inpaint
 *   model, DifferentialDiffusion with a noise mask at `repaintDenoise`
 * @property {number} repaintDenoise
 * @property {string} quality   prefix of every prompt ('' = none)
 * @property {string | null} negative   null = CFG 1 with ConditioningZeroOut (CFG > 1 with it renders black)
 * @property {{ full: string, bust: string }} framing
 * @property {string} key   the background words
 * @property {string} neutral
 * @property {Record<string, { mild: string, strong: string }>} labels
 */

const ANIMA_MODELS = {
    unet: 'anima-base-v1.0.safetensors',
    clip: FAMILIES.anima.companions.clip.hint,
    clipType: 'stable_diffusion',
    vae: FAMILIES.anima.companions.vae.hint,
    upscaler: 'RealESRGAN_x4plus_anime_6B.pth',
    lllite: 'anima-lllite-inpainting-v2.safetensors',
};

// Expression words are rungs of vocabulary, not weights: weights change the whole picture even at 1.0. Strong rungs
// are the measured readable set; mild rungs follow the measured anger rung's shape (annoyed, slight frown, closed
// mouth) and are not yet measured for the other emotions.
const ANIMA_LABELS = {
    joy: { mild: 'smile, closed mouth', strong: 'happy, smile, open mouth' },
    anger: { mild: 'annoyed, slight frown, closed mouth', strong: 'angry, frown, clenched teeth' },
    surprise: { mild: 'surprised, closed mouth', strong: 'surprised, wide eyes, open mouth' },
    embarrassment: { mild: 'blush, embarrassed', strong: 'heavy blush, embarrassed' },
    sadness: { mild: 'sad, closed mouth', strong: 'sad, frown, teary eyes' },
};

/** @type {Readonly<Record<string, Engine>>} */
export const ENGINES = Object.freeze({
    anima: {
        id: 'anima',
        label: 'Anima (base)',
        models: ANIMA_MODELS,
        master: { steps: 30, cfg: 4, sampler: 'euler_ancestral', scheduler: 'normal' },
        refine: { steps: 30, cfg: 4, sampler: 'euler', scheduler: 'simple' },
        repaint: 'lllite',
        repaintDenoise: 1,
        quality: 'year 2025, newest, masterpiece, best quality, score_7, safe',
        negative: FAMILIES.anima.presets.base.negative,
        framing: { full: 'full body, standing', bust: 'upper body' },
        key: 'bright green background, simple background',
        neutral: 'light smile',
        labels: ANIMA_LABELS,
    },
    'anima-turbo': {
        id: 'anima-turbo',
        label: 'Anima (turbo)',
        models: { ...ANIMA_MODELS, unet: 'anima-turbo-v1.1.safetensors' },
        master: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
        refine: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
        repaint: 'lllite',
        repaintDenoise: 1,
        quality: 'year 2025, newest, masterpiece, best quality, score_7, safe',
        negative: null,
        framing: { full: 'full body, standing', bust: 'upper body' },
        key: 'bright green background, simple background',
        neutral: 'light smile',
        labels: ANIMA_LABELS,
    },
    kroma: {
        id: 'kroma',
        label: 'Kroma',
        models: {
            unet: 'kroma-v0.3.1-turbo-opd-int8-convrot.safetensors',
            clip: FAMILIES.krea2.companions.clip.hint,
            clipType: 'krea2',
            vae: FAMILIES.krea2.companions.vae.hint,
            upscaler: 'RealESRGAN_x4plus_anime_6B.pth',
            lllite: null,
        },
        master: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
        refine: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
        repaint: 'differential',
        repaintDenoise: 0.75,
        quality: '',
        negative: null,
        framing: { full: 'full body, standing, the whole figure from head to feet', bust: 'upper body portrait from the chest up' },
        key: 'flat solid bright lime green background, simple background',
        neutral: 'gentle light smile, closed mouth',
        labels: {
            joy: { mild: 'gentle smile, closed mouth', strong: 'happy, big smile, open mouth' },
            anger: { mild: 'annoyed, slight frown, closed mouth', strong: 'angry, furrowed brows, clenched teeth' },
            surprise: { mild: 'surprised, closed mouth', strong: 'surprised, wide eyes, small open mouth' },
            embarrassment: { mild: 'light blush on both cheeks, embarrassed', strong: 'deep red blush across both cheeks, embarrassed' },
            sadness: { mild: 'sad, closed mouth', strong: 'sad, teary eyes, trembling frown' },
        },
    },
});

/** Labels that repaint with the flush mask (features + cheeks): a features mask leaves no room for a blush. */
export const FLUSH_LABELS = new Set(['embarrassment']);

/**
 * Labels whose mouth has to leave the neutral's. Over a resting grin they repaint with the flush mask too: the features
 * mask at full LLLite strength traces the grin's lines whatever the words say (Mara 2026-10-23: sadness kept the grin
 * on two seeds with a clean prompt; the flush mask at 0.7 drew a frown). Without a resting face the features mask
 * stays, the measured best for keeping the face (2026-10-12, masks per set).
 */
export const MOUTH_LABELS = new Set(['sadness', 'anger', 'surprise']);

/** LLLite strength per mask: flush 0.7 keeps the face; a features repaint draws at 1. */
export const LLLITE_STRENGTH = Object.freeze({ features: 1, flush: 0.7 });

/**
 * @typedef {object} Look   what the card says the character looks like (`data.extensions.kotatsu.picture`)
 * @property {string} positive   tags: who they are AND what they wear (a LoRA without its outfit tags drifts)
 * @property {string} [negative]
 * @property {{ file: string, strength: number, trigger?: string }[]} [loras]
 */

const join = (/** @type {(string | undefined | null)[]} */ parts) => parts.map(s => (s ?? '').trim().replace(/^,+|,+$/g, '').trim()).filter(Boolean).join(', ');

/**
 * A prompt: quality, LoRA triggers, the look, the framing, the expression, the key colour. Framing words belong to
 * the master and bust prompts only; labels carry no camera words (`looking down` turns the shot into a chibi).
 * @param {Engine} engine @param {Look} look @param {'full' | 'bust'} framing @param {string} expression
 */
export function spritePrompt(engine, look, framing, expression) {
    const triggers = (look.loras ?? []).map(l => l.trigger).filter(Boolean);
    return join([engine.quality, ...triggers, look.positive, engine.framing[framing], expression, engine.key]);
}

// A look may carry the character's resting face ("grin, confident" for a cocky captain). The master and the neutral keep
// it; every other expression drops it, or the emotion fights it (Andres, 2026-10-23: Mara's sadness was her smirk with
// one tear). Whole tags only, so traits that merely contain a word ("fangs", "tear-shaped earrings") stay.
const FACE_TAGS = new Set([
    'happy', 'sad', 'angry', 'annoyed', 'surprised', 'embarrassed', 'shy', 'nervous', 'scared', 'worried', 'confident',
    'serious', 'determined', 'calm', 'bored', 'sleepy', 'smug', 'seductive', 'expressionless', 'naughty face', 'crying',
    'laughing', 'tears', 'teary eyes', 'open mouth', 'closed mouth', 'parted lips', 'clenched teeth', 'wide eyes',
    'closed eyes', 'half-closed eyes', 'one eye closed', 'wink', 'raised eyebrow', 'furrowed brow', 'tongue out',
    ':d', ':)', ':(', ':o', ':3', ';d', ';)', '^_^', '>_<',
]);
// "light smile", "evil grin", "heavy blush", "slight frown": an optional qualifier, then the face word.
const FACE_TAIL = /^(?:[a-z-]+ )?(?:smile|smiling|grin|grinning|smirk|smirking|frown|frowning|pout|pouting|blush|blushing|scowl|sneer|laugh)$/;

/**
 * Whether one tag describes the face's expression rather than the character. Weights are read through: `(grin:1.2)`.
 * @param {string} tag @returns {boolean}
 */
export function isFaceTag(tag) {
    const t = tag.trim().toLowerCase().replace(/^\((.*?)(?::[\d.]+)?\)$/, '$1').trim();
    return FACE_TAGS.has(t) || FACE_TAIL.test(t);
}

/**
 * Whether the look gives the character a resting face (any face tag).
 * @param {Look} look @returns {boolean}
 */
export function hasRestingFace(look) {
    return look.positive.split(',').some(tag => tag.trim() && isFaceTag(tag));
}

/**
 * The mask a label repaints with when the run doesn't name one.
 * @param {string} label @param {Look} look @returns {'features' | 'flush'}
 */
export function defaultMask(label, look) {
    return FLUSH_LABELS.has(label) || (MOUTH_LABELS.has(label) && hasRestingFace(look)) ? 'flush' : 'features';
}

/**
 * The look an expression other than the neutral is drawn with: the same character, minus the resting face's words.
 * @param {Look} look @returns {Look}
 */
export function lookForExpression(look) {
    const positive = look.positive.split(',').filter(tag => tag.trim() && !isFaceTag(tag)).map(tag => tag.trim()).join(', ');
    return { ...look, positive };
}

/**
 * The negative: the engine's (the model maker's) plus the card's; `fangs` on every repaint (Anima adds fangs to open
 * mouths). Null on a CFG 1 engine.
 * @param {Engine} engine @param {Look} look @param {boolean} repaint
 * @returns {string | null}
 */
export function spriteNegative(engine, look, repaint) {
    if (engine.negative === null) return null;
    return join([engine.negative, look.negative, repaint ? 'fangs' : '']);
}

/**
 * @typedef {object} Models   resolved file names (engine defaults overridden by what the person picked)
 * @property {string} unet @property {string} clip @property {string} clipType @property {string} vae
 * @property {string | null} upscaler   null = lanczos only
 * @property {string | null} lllite
 */

/**
 * @param {Engine} engine @param {Partial<Models>} [picked]
 * @returns {Models}
 */
export function resolveModels(engine, picked = {}) {
    const m = { ...engine.models };
    for (const key of /** @type {(keyof Models)[]} */ (['unet', 'clip', 'clipType', 'vae', 'upscaler', 'lllite'])) {
        if (picked[key] !== undefined) /** @type {any} */ (m)[key] = picked[key];
    }
    return /** @type {Models} */ (m);
}

/**
 * The files a run needs on the server, each with whether it is there.
 * @param {Engine} engine @param {Models} models
 * @param {Record<string, string[]>} lists the server's model lists (`unet`, `clip`, `vae`, `upscalers`, …)
 * @param {Set<string> | null} classTypes the server's node types (null = unknown)
 * @returns {{ role: string, file: string, present: boolean | null, required: boolean }[]}
 */
export function spriteNeeds(engine, models, lists, classTypes) {
    const has = (/** @type {string} */ list, /** @type {string} */ file) => (Array.isArray(lists[list]) ? lists[list].includes(file) : null);
    const node = (/** @type {string} */ type) => (classTypes ? classTypes.has(type) : null);
    /** @type {{ role: string, file: string, present: boolean | null, required: boolean }[]} */
    const needs = [
        { role: 'model', file: models.unet, present: has('unet', models.unet), required: true },
        { role: 'text encoder', file: models.clip, present: has('clip', models.clip), required: true },
        { role: 'VAE', file: models.vae, present: has('vae', models.vae), required: true },
    ];
    if (models.upscaler) needs.push({ role: 'upscaler (falls back to lanczos)', file: models.upscaler, present: has('upscalers', models.upscaler), required: false });
    if (engine.repaint === 'lllite') {
        needs.push({ role: 'inpainting LLLite (models/model_patches)', file: models.lllite ?? '', present: has('model_patches', models.lllite ?? ''), required: true });
        needs.push({ role: 'node AnimaLLLiteApply (ComfyUI ≥ 0.37)', file: 'AnimaLLLiteApply', present: node('AnimaLLLiteApply'), required: true });
    } else {
        needs.push({ role: 'node DifferentialDiffusion', file: 'DifferentialDiffusion', present: node('DifferentialDiffusion'), required: true });
    }
    needs.push({ role: 'face detector (optional: else drag the face box)', file: 'UltralyticsDetectorProvider', present: node('UltralyticsDetectorProvider'), required: false });
    // The node without its face model would fail the detect graph: list the model too, once the node is there.
    if (node('UltralyticsDetectorProvider') !== false) {
        needs.push({ role: 'face detector model (models/ultralytics)', file: FACE_MODEL, present: has('detectors', FACE_MODEL), required: false });
    }
    return needs;
}

/**
 * Whether the face detector can run: the Impact node AND its face model (a node without the model fails the graph).
 * @param {Record<string, string[]>} lists the server's model lists (`detectors` = the node's model options)
 * @param {Set<string> | null} classTypes the server's node types
 * @returns {boolean}
 */
export function hasFaceDetector(lists, classTypes) {
    return Boolean(classTypes?.has('UltralyticsDetectorProvider')) && Array.isArray(lists.detectors) && lists.detectors.includes(FACE_MODEL);
}

/** @param {Models} models @param {string} positive @param {string | null} negative */
function head(models, positive, negative) {
    return {
        m: { class_type: 'UNETLoader', inputs: { unet_name: models.unet, weight_dtype: 'default' } },
        t: { class_type: 'CLIPLoader', inputs: { clip_name: models.clip, type: models.clipType, device: 'default' } },
        v: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
        p: { class_type: 'CLIPTextEncode', inputs: { clip: ['t', 0], text: positive } },
        n: negative === null
            ? { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['p', 0] } }
            : { class_type: 'CLIPTextEncode', inputs: { clip: ['t', 0], text: negative } },
    };
}

/** @param {string} prefix @param {[string, number]} images */
const save = (prefix, images) => ({ class_type: 'SaveImage', inputs: { images, filename_prefix: `kotatsu-sprites/${prefix}` } });

/**
 * @param {Record<string, any>} graph @param {Look} look
 * @returns {Record<string, any>}
 */
const withLoras = (graph, look) => injectLoras(graph, (look.loras ?? []).map(l => ({ file: l.file, strength: l.strength })));

/**
 * 1. The master: a full body on the key colour.
 * @param {{ engine: Engine, models: Models, look: Look, seed: number, width: number, height: number, expression?: string }} o
 */
export function masterGraph(o) {
    const s = o.engine.master;
    return withLoras({
        ...head(o.models, spritePrompt(o.engine, o.look, 'full', o.expression ?? o.engine.neutral), spriteNegative(o.engine, o.look, false)),
        l: { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } },
        k: { class_type: 'KSampler', inputs: { model: ['m', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['l', 0], seed: o.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: 1 } },
        d: { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } },
        s: save('master', ['d', 0]),
    }, o.look);
}

/** The Impact face model the detect graph asks for (`UltralyticsDetectorProvider` lists it as `model_name`). */
export const FACE_MODEL = 'bbox/face_yolov8m.pt';

/**
 * Face box proposal (Impact Pack + its face model). Saves the combined mask as an image; `maskBox` reads the box.
 * @param {{ image: string }} o an uploaded image name
 */
export function detectGraph(o) {
    return {
        i: { class_type: 'LoadImage', inputs: { image: o.image } },
        dp: { class_type: 'UltralyticsDetectorProvider', inputs: { model_name: FACE_MODEL } },
        b: { class_type: 'BboxDetectorSEGS', inputs: { bbox_detector: ['dp', 0], image: ['i', 0], threshold: 0.3, dilation: 0, crop_factor: 1, drop_size: 10, labels: 'all' } },
        cm: { class_type: 'SegsToCombinedMask', inputs: { segs: ['b', 0] } },
        x: { class_type: 'MaskToImage', inputs: { mask: ['cm', 0] } },
        s: save('face', ['x', 0]),
    };
}

/**
 * 2. The bust, derived from the master: crop → anime ×4 upscale (or lanczos) → size² → light refine (bust prompt).
 * @param {{ engine: Engine, models: Models, look: Look, image: string, crop: {x: number, y: number, side: number},
 *   seed: number, refine?: number, size?: number, expression?: string }} o
 */
export function deriveGraph(o) {
    const size = o.size ?? 1024;
    const s = o.engine.refine;
    /** @type {Record<string, any>} */
    const g = {
        ...head(o.models, spritePrompt(o.engine, o.look, 'bust', o.expression ?? o.engine.neutral), spriteNegative(o.engine, o.look, false)),
        src: { class_type: 'LoadImage', inputs: { image: o.image } },
        cr: { class_type: 'ImageCrop', inputs: { image: ['src', 0], width: o.crop.side, height: o.crop.side, x: o.crop.x, y: o.crop.y } },
    };
    let scaled = /** @type {[string, number]} */ (['cr', 0]);
    if (o.models.upscaler) {
        g.um = { class_type: 'UpscaleModelLoader', inputs: { model_name: o.models.upscaler } };
        g.up = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['um', 0], image: ['cr', 0] } };
        scaled = ['up', 0];
    }
    g.sc = { class_type: 'ImageScale', inputs: { image: scaled, upscale_method: 'lanczos', width: size, height: size, crop: 'disabled' } };
    g.en = { class_type: 'VAEEncode', inputs: { pixels: ['sc', 0], vae: ['v', 0] } };
    g.k = { class_type: 'KSampler', inputs: { model: ['m', 0], positive: ['p', 0], negative: ['n', 0], latent_image: ['en', 0], seed: o.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: o.refine ?? 0.25 } };
    g.d = { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } };
    g.s = save('bust', ['d', 0]);
    return withLoras(g, o.look);
}

/**
 * 3–4. A face repaint on the bust, core nodes only: crop the region's square, scale to `size`², repaint inside the hard
 * mask (Anima: LLLite at denoise 1; Krea family: DifferentialDiffusion at the engine's denoise), scale back, composite
 * through the blurred mask. Masks are uploaded images (`repaintRegion` makes them).
 * @param {{ engine: Engine, models: Models, look: Look, image: string, inner: string, blend: string,
 *   crop: {x: number, y: number, side: number}, size: number, seed: number, expression: string, strength?: number }} o
 */
export function repaintGraph(o) {
    const s = o.engine.refine;
    /** @type {Record<string, any>} */
    const g = {
        ...head(o.models, spritePrompt(o.engine, o.look, 'bust', o.expression), spriteNegative(o.engine, o.look, true)),
        src: { class_type: 'LoadImage', inputs: { image: o.image } },
        cr: { class_type: 'ImageCrop', inputs: { image: ['src', 0], width: o.crop.side, height: o.crop.side, x: o.crop.x, y: o.crop.y } },
        up: { class_type: 'ImageScale', inputs: { image: ['cr', 0], upscale_method: 'lanczos', width: o.size, height: o.size, crop: 'disabled' } },
        mi: { class_type: 'LoadImageMask', inputs: { image: o.inner, channel: 'red' } },
        mb: { class_type: 'LoadImageMask', inputs: { image: o.blend, channel: 'red' } },
    };
    let model = /** @type {[string, number]} */ (['m', 0]);
    if (o.engine.repaint === 'lllite') {
        g.lp = { class_type: 'ModelPatchLoader', inputs: { name: o.models.lllite } };
        g.la = { class_type: 'AnimaLLLiteApply', inputs: { model, model_patch: ['lp', 0], image: ['up', 0], strength: o.strength ?? 1, start_percent: 0, end_percent: 1, mask: ['mi', 0] } };
        model = ['la', 0];
    } else {
        g.la = { class_type: 'DifferentialDiffusion', inputs: { model } };
        model = ['la', 0];
    }
    g.en = { class_type: 'VAEEncode', inputs: { pixels: ['up', 0], vae: ['v', 0] } };
    g.nm = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['en', 0], mask: ['mi', 0] } };
    g.k = { class_type: 'KSampler', inputs: { model, positive: ['p', 0], negative: ['n', 0], latent_image: ['nm', 0], seed: o.seed, steps: s.steps, cfg: s.cfg, sampler_name: s.sampler, scheduler: s.scheduler, denoise: o.engine.repaintDenoise } };
    g.d = { class_type: 'VAEDecode', inputs: { samples: ['k', 0], vae: ['v', 0] } };
    g.dn = { class_type: 'ImageScale', inputs: { image: ['d', 0], upscale_method: 'lanczos', width: o.crop.side, height: o.crop.side, crop: 'disabled' } };
    g.cp = { class_type: 'ImageCompositeMasked', inputs: { destination: ['src', 0], source: ['dn', 0], x: o.crop.x, y: o.crop.y, resize_source: false, mask: ['mb', 0] } };
    g.s = save('face', ['cp', 0]);
    return withLoras(g, o.look);
}

/**
 * 5. Paste a bust face back into the master: the bust shrunk to the bust square's side, composited at its place
 * through the paste mask (the repaint shapes grown and feathered, `pasteShapes`).
 * @param {{ master: string, bust: string, mask: string, crop: {x: number, y: number, side: number} }} o
 */
export function pasteGraph(o) {
    return {
        dst: { class_type: 'LoadImage', inputs: { image: o.master } },
        src: { class_type: 'LoadImage', inputs: { image: o.bust } },
        dn: { class_type: 'ImageScale', inputs: { image: ['src', 0], upscale_method: 'lanczos', width: o.crop.side, height: o.crop.side, crop: 'disabled' } },
        mk: { class_type: 'LoadImageMask', inputs: { image: o.mask, channel: 'red' } },
        cp: { class_type: 'ImageCompositeMasked', inputs: { destination: ['dst', 0], source: ['dn', 0], x: o.crop.x, y: o.crop.y, resize_source: false, mask: ['mk', 0] } },
        s: save('full', ['cp', 0]),
    };
}
