import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { applyPreset } from './families.js';

/**
 * Recipes (docs/pictures-v0.md §3.3): a ComfyUI API-format graph in `user/workflows/<id>.json`
 * plus an optional sidecar `<id>.recipe.json` holding what Kotatsu detected (bindings, model
 * slots, outputs) and what the user chose (name, tongue, sizes, variants, slot choices per
 * server). The sidecar is rebuildable: everything but the user's choices comes back from
 * `analyzeGraph()`.
 *
 * The first half of this file is pure graph analysis (no I/O); the second half reads and writes
 * the recipe files.
 *
 * Node ids are STRINGS everywhere. Subgraph exports flatten to colon ids (`"30:6"`), so an id is
 * never parsed as a number; ordering uses a numeric-aware string compare only for stable output.
 */

/** Sampler classes the detector anchors on. */
export const SAMPLER_TYPES = Object.freeze(['KSampler', 'KSamplerAdvanced', 'SamplerCustom', 'SamplerCustomAdvanced']);

/** Output classes whose images a job saves. */
export const OUTPUT_TYPES = Object.freeze(['SaveImage', 'PreviewImage']);

/**
 * Loader inputs that become model slots: class → [[inputName, slotName], ...]. The option list a
 * slot's dropdown draws from follows from the input name (see `SLOT_LISTS`).
 * @type {Readonly<Record<string, [string, string][]>>}
 */
export const LOADER_SLOTS = Object.freeze({
    UNETLoader: [['unet_name', 'unet']],
    UnetLoaderGGUF: [['unet_name', 'unet']],
    CheckpointLoaderSimple: [['ckpt_name', 'checkpoint']],
    CLIPLoader: [['clip_name', 'clip']],
    DualCLIPLoader: [['clip_name1', 'clip'], ['clip_name2', 'clip2']],
    TripleCLIPLoader: [['clip_name1', 'clip'], ['clip_name2', 'clip2'], ['clip_name3', 'clip3']],
    VAELoader: [['vae_name', 'vae']],
    LoraLoader: [['lora_name', 'lora']],
    LoraLoaderModelOnly: [['lora_name', 'lora']],
    UpscaleModelLoader: [['model_name', 'upscaler']],
    LoadBackgroundRemovalModel: [['bg_removal_name', 'remover']],
});

/** Loader input name → the `/check` `models` list that fills its dropdown. */
export const SLOT_LISTS = Object.freeze({
    unet_name: 'unet',
    ckpt_name: 'checkpoints',
    clip_name: 'clip',
    clip_name1: 'clip',
    clip_name2: 'clip',
    clip_name3: 'clip',
    vae_name: 'vae',
    lora_name: 'loras',
    model_name: 'upscalers',
    bg_removal_name: 'removers',
});

/** Stock `%placeholder%` names that become bindings. */
const PLACEHOLDER_BINDINGS = Object.freeze({
    prompt: 'prompt',
    negative_prompt: 'negative',
    seed: 'seed',
    width: 'width',
    height: 'height',
    char_avatar: 'reference',
    user_avatar: 'reference',
});

/**
 * Stock placeholders that are not Kotatsu bindings get a fixed value when a stock graph is
 * prepared. Values: the stock extension's defaults where they are valid ComfyUI values (steps 20,
 * cfg 7, denoise 0.7, clip skip 1 → -1 in ComfyUI's sign); `DDIM`, stock's sampler default, is
 * not a ComfyUI sampler name, so `euler` / `normal` stand in.
 */
export const PLACEHOLDER_DEFAULTS = Object.freeze({
    steps: 20,
    scale: 7,
    sampler: 'euler',
    scheduler: 'normal',
    denoise: 0.7,
    clip_skip: -1,
    model: '',
    vae: '',
});

const PLACEHOLDER_RE = /^%([a-z_]+)%$/;
const SWITCH_TYPES = /switch/i;
const TEXT_ENCODER_KEYS = ['text', 'prompt', 'text_g', 't5xxl'];
const TEXT_SOURCE_KEYS = ['text', 'prompt', 'value', 'string', 'source'];
const SEED_SOURCE_KEYS = ['seed', 'noise_seed', 'value', 'int'];
const LATENT_FOLLOW_KEYS = ['samples', 'latent_image', 'latent', 'pixels', 'image'];
const MAX_TRACE = 32;

/** A problem with a graph or a recipe the user can act on (HTTP 400 at the route). */
export class RecipeError extends Error {
    /**
     * @param {string} message What is wrong, in words a user can act on
     * @param {{code?: string, slots?: string[]}} [details] Machine-readable extras
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'RecipeError';
        this.code = details.code ?? 'invalid_recipe';
        this.slots = details.slots;
    }
}

/**
 * @typedef {[string, string]} Binding  `[nodeId, inputName]`
 * @typedef {{prompt: Binding|null, negative: Binding|null, seed: Binding|null, width: Binding|null, height: Binding|null, reference: Binding|null}} Bindings
 * @typedef {Record<string, {class_type: string, inputs: Record<string, any>, _meta?: object}>} ApiGraph
 * @typedef {{graph: ApiGraph, bind: Bindings, slots: Record<string, Binding>, needs: string[], outputs: string[], tongue: string, warnings: string[]}} Analysis
 */

/**
 * @param {string} a Node id
 * @param {string} b Node id
 * @returns {number} Numeric-aware order ("30:6" < "30:10"); ids stay strings
 */
export function compareIds(a, b) {
    return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * @param {unknown} value An input value
 * @returns {value is [string|number, number]} True for an API-format link `[sourceId, outputIndex]`
 */
export function isLink(value) {
    return Array.isArray(value)
        && value.length === 2
        && (typeof value[0] === 'string' || typeof value[0] === 'number')
        && Number.isInteger(value[1]);
}

/**
 * @param {unknown} value An input value
 * @returns {string|null} The placeholder name of a stock `%name%` value
 */
function placeholderName(value) {
    if (typeof value !== 'string') return null;
    const match = PLACEHOLDER_RE.exec(value);
    return match ? match[1] : null;
}

/**
 * Throws unless the value is an API-format graph (what ComfyUI's *Export (API)* writes).
 * @param {unknown} graph Candidate graph
 * @returns {asserts graph is ApiGraph}
 */
export function assertApiGraph(graph) {
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        throw new RecipeError('A recipe graph must be a JSON object of nodes');
    }
    const record = /** @type {Record<string, any>} */ (graph);
    if (Array.isArray(record.nodes) && Array.isArray(record.links)) {
        throw new RecipeError('This is a ComfyUI UI workflow. Save it with "Export (API)" in ComfyUI and import that file.', { code: 'ui_workflow' });
    }
    const ids = Object.keys(record);
    if (!ids.length) throw new RecipeError('The graph has no nodes');
    for (const id of ids) {
        const node = record[id];
        if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') {
            throw new RecipeError(`Node "${id}" is not an API-format node (needs class_type and inputs)`);
        }
    }
}

/**
 * The graph a recipe actually runs: a deep copy where the stock avatar's custom
 * `ETN_LoadImageBase64` reference node becomes core `LoadImage` (Pictures uploads references
 * instead of inlining base64, §3.1) and non-binding stock placeholders get their defaults.
 * Bindable placeholders (`%prompt%`, `%seed%`, …) are left for `fillRecipe()`.
 * @param {ApiGraph} graph API graph
 * @returns {ApiGraph} The prepared copy
 */
export function prepareGraph(graph) {
    assertApiGraph(graph);
    /** @type {ApiGraph} */
    const prepared = structuredClone(graph);
    for (const node of Object.values(prepared)) {
        if (node.class_type === 'ETN_LoadImageBase64' && PLACEHOLDER_BINDINGS[placeholderName(node.inputs.image)] === 'reference') {
            node.class_type = 'LoadImage';
            node.inputs = { image: node.inputs.image };
            node._meta = { ...(node._meta ?? {}), title: 'Load Image (reference)' };
        }
        for (const [key, value] of Object.entries(node.inputs)) {
            const name = placeholderName(value);
            if (name && Object.hasOwn(PLACEHOLDER_DEFAULTS, name)) {
                node.inputs[key] = PLACEHOLDER_DEFAULTS[/** @type {keyof typeof PLACEHOLDER_DEFAULTS} */ (name)];
            }
        }
    }
    return prepared;
}

/**
 * Detects a graph's bindings, model slots, outputs and needs. Pure.
 * @param {ApiGraph} input API graph (raw, or a stock `%placeholder%` graph)
 * @returns {Analysis} What a recipe sidecar records
 */
export function analyzeGraph(input) {
    const graph = prepareGraph(input);
    const ids = Object.keys(graph).sort(compareIds);
    const warnings = [];
    const node = (/** @type {string} */ id) => graph[id];
    const linkSource = (/** @type {unknown} */ value) => (isLink(value) && graph[String(value[0])] ? String(value[0]) : null);

    const outputs = ids.filter(id => OUTPUT_TYPES.includes(node(id).class_type));
    if (!outputs.length) throw new RecipeError('The graph has no SaveImage or PreviewImage node, so it would draw nothing');

    const samplers = ids.filter(id => SAMPLER_TYPES.includes(node(id).class_type));
    if (!samplers.length) {
        throw new RecipeError('No sampler in the graph (KSampler, KSamplerAdvanced, SamplerCustom or SamplerCustomAdvanced)');
    }

    /**
     * @param {string} start Node id
     * @returns {Set<string>} Every node upstream of it
     */
    const ancestors = (start) => {
        const seen = new Set();
        const stack = [start];
        while (stack.length) {
            const current = graph[stack.pop()];
            for (const value of Object.values(current.inputs)) {
                const source = linkSource(value);
                if (source && !seen.has(source)) {
                    seen.add(source);
                    stack.push(source);
                }
            }
        }
        return seen;
    };

    /**
     * Follows a sampler's latent input upstream to the node that sets the picture's size.
     * @param {string} samplerId Sampler node id
     * @returns {{id: string|null, empty: boolean}} The size node (null = img2img at the source's size)
     */
    const latentSource = (samplerId) => {
        let source = linkSource(node(samplerId).inputs.latent_image);
        for (let depth = 0; source && depth < MAX_TRACE; depth++) {
            const current = node(source);
            if (/^Empty.*Latent/i.test(current.class_type)) return { id: source, empty: true };
            if ('width' in current.inputs && 'height' in current.inputs) return { id: source, empty: false };
            if (SAMPLER_TYPES.includes(current.class_type)) return { id: null, empty: false };
            const key = LATENT_FOLLOW_KEYS.find(k => linkSource(current.inputs[k]));
            source = key ? linkSource(current.inputs[key]) : null;
        }
        return { id: null, empty: false };
    };

    // The primary sampler is the first pass: not downstream of another sampler. A hires graph
    // has two (base + refine); the base is the one whose latent starts from an empty latent.
    const roots = samplers.filter(id => {
        const upstream = ancestors(id);
        return !samplers.some(other => other !== id && upstream.has(other));
    });
    const primary = roots.find(id => latentSource(id).empty) ?? roots[0];
    if (roots.length > 1) warnings.push(`Several first-pass samplers; bound to ${primary}`);

    /**
     * The conditioning links a sampler reads.
     * @param {string} samplerId Sampler node id
     * @returns {{positive: unknown, negative: unknown}} Link values (or undefined)
     */
    const samplerConditioning = (samplerId) => {
        const sampler = node(samplerId);
        if (sampler.class_type !== 'SamplerCustomAdvanced') {
            return { positive: sampler.inputs.positive, negative: sampler.inputs.negative };
        }
        const guiderId = linkSource(sampler.inputs.guider);
        if (!guiderId) return { positive: undefined, negative: undefined };
        const guider = node(guiderId);
        if ('conditioning' in guider.inputs) return { positive: guider.inputs.conditioning, negative: undefined };
        if ('cond1' in guider.inputs) return { positive: guider.inputs.cond1, negative: guider.inputs.negative };
        return { positive: guider.inputs.positive, negative: guider.inputs.negative };
    };

    /**
     * Walks a conditioning link up to its text encoder.
     * @param {unknown} value Link value
     * @returns {{zero: true}|{id: string, key: string}|null} The encoder input, ZeroOut, or nothing found
     */
    const encoderOf = (value) => {
        let source = linkSource(value);
        for (let depth = 0; source && depth < MAX_TRACE; depth++) {
            const current = node(source);
            if (current.class_type === 'ConditioningZeroOut') return { zero: true };
            const textKey = TEXT_ENCODER_KEYS.find(k => k in current.inputs);
            if (textKey && /encode/i.test(current.class_type)) return { id: source, key: textKey };
            const conditioningKeys = Object.keys(current.inputs).filter(k => k.startsWith('conditioning') && linkSource(current.inputs[k]));
            source = conditioningKeys.length === 1 ? linkSource(current.inputs[conditioningKeys[0]]) : null;
        }
        return null;
    };

    /**
     * Picks the branch of a switch node whose condition is known in the graph.
     * @param {string} switchId Switch node id
     * @returns {string|null} `on_true` / `on_false`, or null when the condition is not a literal
     */
    const switchBranch = (switchId) => {
        const inputs = node(switchId).inputs;
        if (!('on_true' in inputs) || !('on_false' in inputs)) return null;
        let condition = inputs.switch;
        const conditionSource = linkSource(condition);
        if (conditionSource) condition = node(conditionSource).inputs.value;
        if (typeof condition !== 'boolean') return null;
        return condition ? 'on_true' : 'on_false';
    };

    /**
     * Follows an input upstream through pass-through nodes (primitives, style wrappers, active
     * switch branches) to the literal the user's text should replace. When the chain is
     * ambiguous (a concatenation, an unknown node) the input itself is the binding: filling it
     * with a literal cuts the link.
     * @param {string} id Node id
     * @param {string} key Input name
     * @param {string[]} sourceKeys Input names a pass-through node may carry the value in
     * @returns {Binding} The binding
     */
    const traceValue = (id, key, sourceKeys) => {
        let binding = /** @type {Binding} */ ([id, key]);
        const seen = new Set([id]);
        for (let depth = 0; depth < MAX_TRACE; depth++) {
            const source = linkSource(node(binding[0]).inputs[binding[1]]);
            if (!source || seen.has(source)) return binding;
            seen.add(source);
            const current = node(source);
            let nextKey = null;
            if (SWITCH_TYPES.test(current.class_type)) {
                nextKey = switchBranch(source);
            } else {
                nextKey = sourceKeys.find(k => k in current.inputs) ?? null;
            }
            if (!nextKey) return binding;
            binding = [source, nextKey];
        }
        return binding;
    };

    /** @type {Bindings} */
    const bind = { prompt: null, negative: null, seed: null, width: null, height: null, reference: null };

    // Prompt and negative.
    const conditioning = samplerConditioning(primary);
    const positive = encoderOf(conditioning.positive);
    if (positive && 'id' in positive) bind.prompt = traceValue(positive.id, positive.key, TEXT_SOURCE_KEYS);
    const negative = encoderOf(conditioning.negative);
    if (negative && 'id' in negative) {
        const binding = traceValue(negative.id, negative.key, TEXT_SOURCE_KEYS);
        if (!bind.prompt || binding[0] !== bind.prompt[0] || binding[1] !== bind.prompt[1]) bind.negative = binding;
    }

    // Seed.
    const sampler = node(primary);
    if (sampler.class_type === 'SamplerCustomAdvanced') {
        const noiseId = linkSource(sampler.inputs.noise);
        if (noiseId && 'noise_seed' in node(noiseId).inputs) bind.seed = traceValue(noiseId, 'noise_seed', SEED_SOURCE_KEYS);
    } else {
        const seedKey = 'seed' in sampler.inputs ? 'seed' : ('noise_seed' in sampler.inputs ? 'noise_seed' : null);
        if (seedKey) bind.seed = traceValue(primary, seedKey, SEED_SOURCE_KEYS);
    }

    // Size: the node the latent starts from. A linked width (a resolution picker) is bound
    // directly; filling it with a number cuts the link and leaves the picker unused.
    const size = latentSource(primary);
    if (size.id) {
        bind.width = [size.id, 'width'];
        bind.height = [size.id, 'height'];
    }

    // Reference: core LoadImage nodes.
    const loadImages = ids.filter(id => node(id).class_type === 'LoadImage');
    if (loadImages.length) bind.reference = [loadImages[0], 'image'];
    if (loadImages.length > 1) warnings.push(`Several LoadImage nodes; the reference is ${loadImages[0]}`);

    // Stock placeholders are explicit: they win over structure (the first one per binding).
    const fromPlaceholder = new Set();
    for (const id of ids) {
        for (const [key, value] of Object.entries(node(id).inputs)) {
            const target = /** @type {keyof Bindings|undefined} */ (PLACEHOLDER_BINDINGS[placeholderName(value)]);
            if (target && !fromPlaceholder.has(target)) {
                fromPlaceholder.add(target);
                bind[target] = [id, key];
            }
        }
    }

    if (!bind.prompt) throw new RecipeError('Could not find where the prompt goes (no text encoder feeds the sampler)');

    // Model slots, in node order; a second loader of the same kind gets a number.
    /** @type {Record<string, Binding>} */
    const slots = {};
    for (const id of ids) {
        for (const [inputName, slotName] of LOADER_SLOTS[node(id).class_type] ?? []) {
            if (!(inputName in node(id).inputs)) continue;
            let name = slotName;
            for (let n = 2; Object.hasOwn(slots, name); n++) name = `${slotName}${n}`;
            slots[name] = [id, inputName];
        }
    }

    const needs = [...new Set(ids.map(id => node(id).class_type))].sort();
    // A guess the user can change: graphs whose negative does something (an encoder AND cfg
    // above 1) are the tag-prompted families (SD1.5/SDXL/Pony/Anima); KREA2, Flux and Z-Image
    // run at cfg 1 or without a negative and read prose.
    const cfg = sampler.inputs.cfg;
    const tongue = bind.negative && !(typeof cfg === 'number' && cfg <= 1) ? 'tags' : 'prose';

    return { graph, bind, slots, needs, outputs, tongue, warnings };
}

/**
 * Serializes with sorted keys so the same graph always hashes the same.
 * @param {unknown} value JSON value
 * @returns {string} Canonical JSON
 */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * Fills a recipe for one job: bindings, slot choices, seed. Pure.
 * @param {ApiGraph} graph The recipe's graph
 * @param {{bind: Bindings, slots: Record<string, Binding>}} recipe Its bindings and slots
 * @param {{prompt: string, negative?: string, seed: number, width?: number, height?: number, reference?: string|null, choices?: Record<string, string>, loras?: {file: string, strength: number}[], preset?: import('./families.js').Preset & {overrides?: {steps?: number, cfg?: number}}}} values What to put in (loras: chained after the model loader, `injectLoras`; preset: the picked model's sampler settings, `applyPreset`)
 * @returns {{graph: ApiGraph, graphSha: string}} The filled graph and the sha256 of its canonical JSON
 */
export function fillRecipe(graph, recipe, values) {
    const filled = prepareGraph(graph);
    /**
     * @param {Binding|null} binding Where
     * @param {unknown} value What
     */
    const set = (binding, value) => {
        if (!binding) return;
        const target = filled[binding[0]];
        if (!target) throw new RecipeError(`The recipe binds node "${binding[0]}", which is not in its graph`);
        target.inputs[binding[1]] = value;
    };

    if (!recipe.bind.prompt) throw new RecipeError('The recipe has no prompt binding');
    set(recipe.bind.prompt, values.prompt);
    set(recipe.bind.negative, values.negative ?? '');
    set(recipe.bind.seed, values.seed);
    if (Number.isInteger(values.width)) set(recipe.bind.width, values.width);
    if (Number.isInteger(values.height)) set(recipe.bind.height, values.height);

    if (recipe.bind.reference) {
        if (values.reference) {
            set(recipe.bind.reference, values.reference);
        } else {
            const current = filled[recipe.bind.reference[0]]?.inputs[recipe.bind.reference[1]];
            if (typeof current !== 'string' || !current || placeholderName(current)) {
                throw new RecipeError('This recipe draws from a reference image; pick one first', { code: 'reference_required' });
            }
        }
    }

    const unfilled = [];
    for (const [slot, binding] of Object.entries(recipe.slots ?? {})) {
        const choice = values.choices?.[slot];
        if (typeof choice === 'string' && choice) {
            set(binding, choice);
            continue;
        }
        const current = filled[binding[0]]?.inputs[binding[1]];
        if (typeof current !== 'string' || !current || placeholderName(current)) unfilled.push(slot);
    }
    if (unfilled.length) {
        throw new RecipeError(`Pick a model for ${unfilled.map(s => `"${s}"`).join(', ')} in Settings → Pictures first`, { code: 'slots_unfilled', slots: unfilled });
    }

    for (const [id, current] of Object.entries(filled)) {
        for (const [key, value] of Object.entries(current.inputs)) {
            const name = placeholderName(value);
            if (name) throw new RecipeError(`Node "${id}" input "${key}" still holds the unknown placeholder %${name}%`);
        }
    }

    // A family pipeline's samplers take the picked model's preset (§14).
    if (values.preset) applyPreset(filled, values.preset, values.preset.overrides);
    const final = Array.isArray(values.loras) && values.loras.length ? injectLoras(filled, values.loras) : filled;
    const graphSha = createHash('sha256').update(canonicalJson(final)).digest('hex');
    return { graph: final, graphSha };
}

// ─── LoRAs ───────────────────────────────────────────────────────────────────

/** Loaders whose output 0 is the diffusion MODEL a LoRA patches; CheckpointLoaderSimple's 1 is its CLIP. */
const MODEL_LOADER_TYPES = Object.freeze(['UNETLoader', 'UnetLoaderGGUF', 'CheckpointLoaderSimple']);
/** Loaders whose output 0 is a CLIP. */
const CLIP_LOADER_TYPES = Object.freeze(['CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'CLIPLoaderGGUF', 'DualCLIPLoaderGGUF']);
/** At most this many LoRAs on one picture. */
export const MAX_LORAS = 8;

/**
 * Adds a LoRA chain to a filled graph (Pictures, 2026-10-10), so any recipe takes LoRAs without
 * holding LoRA nodes itself: `loader → LoraLoader(1) → … → LoraLoader(n) → every node that read the
 * loader's MODEL (and CLIP)`. Measured on the shipped graphs: one model loader each, the CLIP from
 * a `CLIPLoader` (KREA2, Anima) or the checkpoint's output 1. A graph with a CLIP source gets
 * `LoraLoader` (one strength for both); one without gets `LoraLoaderModelOnly`. Hires variants
 * work unchanged: both samplers read the same loader, so both are rewired.
 *
 * Node ids are `kotatsu_lora_<n>`; the input graph is not touched.
 * @param {ApiGraph} graph A filled graph
 * @param {{file: string, strength: number}[]} loras LoRAs, applied in order
 * @returns {ApiGraph} A new graph
 */
export function injectLoras(graph, loras) {
    if (!loras.length) return graph;
    const out = /** @type {ApiGraph} */ (structuredClone(graph));
    const models = Object.entries(out).filter(([, node]) => MODEL_LOADER_TYPES.includes(node.class_type));
    if (models.length !== 1) {
        throw new RecipeError(models.length
            ? 'This recipe loads more than one model, so Kotatsu cannot tell which one a LoRA belongs to'
            : 'This recipe has no model loader for a LoRA to attach to', { code: 'lora_unsupported' });
    }
    const [modelId, modelNode] = models[0];
    /** @type {[string, number]|null} */
    let clipSource = modelNode.class_type === 'CheckpointLoaderSimple' ? [modelId, 1] : null;
    if (!clipSource) {
        const clips = Object.entries(out).filter(([, node]) => CLIP_LOADER_TYPES.includes(node.class_type));
        if (clips.length === 1) clipSource = [clips[0][0], 0];
    }
    const isFrom = (/** @type {unknown} */ value, /** @type {[string, number]} */ [id, index]) => isLink(value) && String(value[0]) === id && value[1] === index;

    /** @type {[string, number]} */
    let model = [modelId, 0];
    /** @type {[string, number]|null} */
    let clip = clipSource;
    const added = [];
    for (const [n, lora] of loras.entries()) {
        const id = `kotatsu_lora_${n + 1}`;
        if (out[id]) throw new RecipeError(`The recipe already has a node "${id}"`);
        out[id] = clip
            ? { class_type: 'LoraLoader', inputs: { model, clip, lora_name: lora.file, strength_model: lora.strength, strength_clip: lora.strength }, _meta: { title: `LoRA ${n + 1}` } }
            : { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: lora.file, strength_model: lora.strength }, _meta: { title: `LoRA ${n + 1}` } };
        added.push(id);
        model = [id, 0];
        if (clip) clip = [id, 1];
    }
    const chain = new Set(added);
    for (const [id, node] of Object.entries(out)) {
        if (chain.has(id)) continue;
        for (const [key, value] of Object.entries(node.inputs ?? {})) {
            if (isFrom(value, [modelId, 0])) node.inputs[key] = [...model];
            else if (clipSource && clip && isFrom(value, clipSource)) node.inputs[key] = [...clip];
        }
    }
    // The first link of the chain reads the loaders themselves.
    out[added[0]].inputs.model = [modelId, 0];
    if (clipSource) out[added[0]].inputs.clip = [...clipSource];
    return out;
}

// ─── Recipe files ────────────────────────────────────────────────────────────

const SIDECAR_SUFFIX = '.recipe.json';
const BIND_KEYS = /** @type {const} */ (['prompt', 'negative', 'seed', 'width', 'height', 'reference']);

/**
 * @typedef {object} Recipe   Mirrors `Recipe` in public/kotatsu/pictures/contract.js
 * @property {string} id
 * @property {string} name
 * @property {string} tongue
 * @property {string[]} needs
 * @property {string[]} missing
 * @property {Record<string, Binding>} slots
 * @property {Bindings} bind
 * @property {string[]} outputs
 * @property {Record<string, string>} variants
 * @property {string[]} sizes
 * @property {boolean} shipped
 * @property {Record<string, Record<string, string>>} choices
 * @property {Record<string, string>} hints   slot → the filename the recipe was made with; used
 *   for a job when that exact file is on the server and no choice was saved
 * @property {string} negative   the model's own default negative; the sheet starts its negative box
 *   with it (empty = none)
 * @property {string|null} family   the model family it is a pipeline for (`anima`, `krea2`, `sdxl`; families.js); null = an own workflow with baked settings
 * @property {'plain'|'bigger'|'sprite'|null} pipeline   what kind of pipeline it is (§14.2)
 */

/**
 * @param {unknown} id Candidate recipe id
 * @returns {boolean} True when it is a safe file stem (not a sidecar, no path parts)
 */
export function isValidRecipeId(id) {
    return typeof id === 'string'
        && id.length > 0
        && id.length <= 120
        && sanitize(id) === id
        && !id.startsWith('.')
        && !id.toLowerCase().endsWith('.recipe');
}

/**
 * @param {string} name A display name
 * @returns {string} A file stem for it
 */
export function slugify(name) {
    const slug = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return slug || 'recipe';
}

/**
 * @param {unknown} value Candidate binding
 * @returns {value is Binding} True for `[nodeId, inputName]` strings
 */
function isBinding(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string';
}

/**
 * @param {string} file Path
 * @returns {any} Parsed JSON, or undefined when the file does not exist
 */
function readJson(file) {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} file Path
 * @param {unknown} value JSON value
 */
function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomicSync(file, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

/**
 * Merges a sidecar over a fresh analysis: the user's fields win, detection fills the rest.
 * @param {string} id Recipe id
 * @param {Analysis} analysis Fresh analysis of the graph
 * @param {any} sidecar Parsed sidecar (or undefined)
 * @param {{shipped: boolean, nodeTypes?: Set<string>|null}} context Shipped flag, class types of the last checked server
 * @returns {Recipe} The recipe
 */
export function buildRecipe(id, analysis, sidecar, { shipped, nodeTypes = null }) {
    const side = sidecar && typeof sidecar === 'object' ? sidecar : {};
    /** @type {Bindings} */
    const bind = { ...analysis.bind };
    if (side.bind && typeof side.bind === 'object') {
        for (const key of BIND_KEYS) {
            if (side.bind[key] === null || isBinding(side.bind[key])) bind[key] = side.bind[key];
        }
    }
    const slots = side.slots && typeof side.slots === 'object' && Object.values(side.slots).every(isBinding)
        ? side.slots
        : analysis.slots;
    const outputs = Array.isArray(side.outputs) && side.outputs.every(o => typeof o === 'string') ? side.outputs : analysis.outputs;
    return {
        id,
        name: typeof side.name === 'string' && side.name.trim() ? side.name : id,
        tongue: side.tongue === 'tags' || side.tongue === 'prose' ? side.tongue : analysis.tongue,
        needs: analysis.needs,
        missing: nodeTypes ? analysis.needs.filter(type => !nodeTypes.has(type)) : [],
        slots,
        bind,
        outputs,
        variants: side.variants && typeof side.variants === 'object' ? { ...side.variants } : {},
        sizes: Array.isArray(side.sizes) ? side.sizes.filter(s => typeof s === 'string' && /^\d+x\d+$/.test(s)) : [],
        shipped,
        choices: side.choices && typeof side.choices === 'object' ? structuredClone(side.choices) : {},
        hints: side.hints && typeof side.hints === 'object' ? { ...side.hints } : {},
        negative: typeof side.negative === 'string' ? side.negative.trim() : '',
        family: [side.family, side.base].find(v => typeof v === 'string' && v.trim())?.trim() ?? null,
        pipeline: ['plain', 'bigger', 'sprite'].includes(side.pipeline) ? side.pipeline : null,
    };
}

/**
 * The sidecar a recipe writes: everything but the computed fields.
 * @param {Recipe} recipe The recipe
 * @returns {object} Sidecar JSON
 */
function toSidecar(recipe) {
    return {
        version: 1,
        name: recipe.name,
        tongue: recipe.tongue,
        needs: recipe.needs,
        slots: recipe.slots,
        bind: recipe.bind,
        outputs: recipe.outputs,
        variants: recipe.variants,
        sizes: recipe.sizes,
        hints: recipe.hints,
        negative: recipe.negative,
        ...(recipe.family ? { family: recipe.family } : {}),
        ...(recipe.pipeline ? { pipeline: recipe.pipeline } : {}),
        choices: recipe.choices,
    };
}

/**
 * Reads one recipe.
 * @param {string} dir `user/workflows`
 * @param {string} id Recipe id
 * @param {{shipped?: Set<string>, nodeTypes?: Set<string>|null}} [context] Shipped ids, last checked class types
 * @returns {{recipe: Recipe, graph: ApiGraph, warnings: string[]}|null} Null when there is no such graph
 */
export function readRecipe(dir, id, { shipped = new Set(), nodeTypes = null } = {}) {
    if (!isValidRecipeId(id)) return null;
    const graph = readJson(path.join(dir, `${id}.json`));
    if (graph === undefined) return null;
    const analysis = analyzeGraph(graph);
    const sidecar = readJson(path.join(dir, `${id}${SIDECAR_SUFFIX}`));
    return { recipe: buildRecipe(id, analysis, sidecar, { shipped: shipped.has(id), nodeTypes }), graph, warnings: analysis.warnings };
}

/**
 * Lists every recipe in the folder. Files that are not API graphs (UI exports, other JSON) come
 * back in `skipped` with the reason, never as recipes.
 * @param {string} dir `user/workflows`
 * @param {{shipped?: Set<string>, nodeTypes?: Set<string>|null}} [context] Shipped ids, last checked class types
 * @returns {{recipes: Recipe[], skipped: {id: string, message: string}[]}} Recipes sorted by name
 */
export function listRecipes(dir, context = {}) {
    const recipes = [];
    const skipped = [];
    if (!fs.existsSync(dir)) return { recipes, skipped };
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json') && !f.toLowerCase().endsWith(SIDECAR_SUFFIX) && !f.startsWith('.'));
    for (const file of files) {
        const id = file.slice(0, -'.json'.length);
        try {
            const entry = readRecipe(dir, id, context);
            if (entry) recipes.push(entry.recipe);
        } catch (error) {
            skipped.push({ id, message: error instanceof Error ? error.message : String(error) });
        }
    }
    recipes.sort((a, b) => a.name.localeCompare(b.name));
    return { recipes, skipped };
}

/**
 * Imports a graph as a new recipe (`POST /recipes/import`). A stock `%placeholder%` graph is
 * stored prepared (its avatar node already core `LoadImage`, its non-binding placeholders filled).
 * @param {string} dir `user/workflows`
 * @param {{name: string, graph: unknown}} input Display name and graph (object or JSON text)
 * @returns {Recipe} The saved recipe
 */
export function importRecipe(dir, { name, graph }) {
    if (typeof name !== 'string' || !name.trim()) throw new RecipeError('A recipe needs a name');
    let parsed = graph;
    if (typeof graph === 'string') {
        try {
            parsed = JSON.parse(graph);
        } catch {
            throw new RecipeError('The graph is not valid JSON');
        }
    }
    assertApiGraph(parsed);
    const analysis = analyzeGraph(parsed);
    const base = slugify(name);
    let id = base;
    for (let n = 2; fs.existsSync(path.join(dir, `${id}.json`)); n++) id = `${base}-${n}`;
    const recipe = buildRecipe(id, analysis, { name: name.trim() }, { shipped: false });
    writeJson(path.join(dir, `${id}.json`), analysis.graph);
    writeJson(path.join(dir, `${id}${SIDECAR_SUFFIX}`), toSidecar(recipe));
    return recipe;
}

/**
 * Saves slot choices for one server (`POST /recipes/:id/slots`). An empty filename clears that
 * slot's choice.
 * @param {string} dir `user/workflows`
 * @param {string} id Recipe id
 * @param {string} server Normalized server key
 * @param {Record<string, unknown>} choices slot → filename
 * @param {{shipped?: Set<string>, nodeTypes?: Set<string>|null}} [context] Shipped ids, last checked class types
 * @returns {Recipe|null} The updated recipe, null when there is no such recipe
 */
export function saveSlotChoices(dir, id, server, choices, context = {}) {
    const entry = readRecipe(dir, id, context);
    if (!entry) return null;
    if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new RecipeError('choices must be an object of slot → filename');
    const recipe = entry.recipe;
    const forServer = { ...(recipe.choices[server] ?? {}) };
    for (const [slot, filename] of Object.entries(choices)) {
        if (!Object.hasOwn(recipe.slots, slot)) throw new RecipeError(`The recipe has no slot "${slot}"`);
        if (typeof filename !== 'string') throw new RecipeError(`The choice for "${slot}" must be a filename`);
        if (filename) forServer[slot] = filename;
        else delete forServer[slot];
    }
    if (Object.keys(forServer).length) recipe.choices[server] = forServer;
    else delete recipe.choices[server];
    const sidecarFile = path.join(dir, `${id}${SIDECAR_SUFFIX}`);
    // A shipped recipe's revision rides along, or the next refresh would think it stale.
    const revision = revisionOf(readJson(sidecarFile));
    writeJson(sidecarFile, { ...toSidecar(recipe), ...(revision ? { revision } : {}) });
    return recipe;
}

/**
 * @param {any} sidecar Parsed sidecar (or undefined)
 * @returns {number} Its shipped revision; 0 when it has none (seeded before revisions existed, or
 *   not a shipped recipe)
 */
function revisionOf(sidecar) {
    const revision = sidecar && typeof sidecar === 'object' ? sidecar.revision : undefined;
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

/**
 * Brings the user's copies of shipped recipes up to the shipped revision. The content seeder copies
 * a shipped recipe once (`content.log`), so without this a fix to a shipped graph or sidecar never
 * reaches an install that already has it. A copy whose sidecar `revision` is lower than the shipped
 * one gets the shipped graph and sidecar back, keeping only the user's slot `choices`. Recipes the
 * user doesn't have (never seeded) are left to the seeder.
 * @param {string} dir `user/workflows`
 * @param {string} shippedDir `default/content/pictures`
 * @param {Iterable<string>} ids Shipped recipe ids
 * @returns {string[]} Ids that were refreshed
 */
export function refreshShippedRecipes(dir, shippedDir, ids) {
    const refreshed = [];
    for (const id of ids) {
        if (!isValidRecipeId(id)) continue;
        const shippedGraph = path.join(shippedDir, `${id}.json`);
        const graphFile = path.join(dir, `${id}.json`);
        if (!fs.existsSync(shippedGraph) || !fs.existsSync(graphFile)) continue;
        const shippedSidecar = readJson(path.join(shippedDir, `${id}${SIDECAR_SUFFIX}`));
        const revision = revisionOf(shippedSidecar);
        if (!revision) continue;
        const sidecarFile = path.join(dir, `${id}${SIDECAR_SUFFIX}`);
        let sidecar;
        try {
            sidecar = readJson(sidecarFile);
        } catch {
            sidecar = undefined; // unreadable: the shipped one replaces it
        }
        if (revisionOf(sidecar) >= revision) continue;
        const choices = sidecar?.choices && typeof sidecar.choices === 'object' && !Array.isArray(sidecar.choices) ? sidecar.choices : {};
        writeFileAtomicSync(graphFile, fs.readFileSync(shippedGraph));
        writeJson(sidecarFile, { ...shippedSidecar, choices });
        refreshed.push(id);
    }
    return refreshed;
}

/**
 * Deletes a recipe's graph and sidecar.
 * @param {string} dir `user/workflows`
 * @param {string} id Recipe id
 * @returns {boolean} False when there was no such recipe
 */
export function deleteRecipe(dir, id) {
    if (!isValidRecipeId(id)) return false;
    const graphFile = path.join(dir, `${id}.json`);
    if (!fs.existsSync(graphFile)) return false;
    fs.rmSync(graphFile);
    fs.rmSync(path.join(dir, `${id}${SIDECAR_SUFFIX}`), { force: true });
    return true;
}
