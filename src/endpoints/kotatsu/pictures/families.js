/**
 * Model families (docs/pictures-v0.md §14): what Kotatsu knows about a kind of model, so one
 * pipeline (Plain, Bigger, Sprite) serves every model of the family and the chosen model's preset
 * fills its samplers. Pure data plus pure helpers; the routes hand the public view to the client.
 *
 * Every preset names where its numbers come from. Anima's are the CircleStone card's, read verbatim
 * 2026-10-10 (huggingface.co/circlestone-labs/Anima, raw README); KREA 2's are the shipped recipe's;
 * the SDXL entry is Kotatsu's generic default, labelled as such, until Illustrious/Pony presets are
 * researched. The owner's own A/B (2026-08-12, seed-locked): base Anima beat aesthetic-v1.1 3–0 on
 * his eyes, so base is Anima's default and turbo is offered as the fast option.
 */

const ANIMA_NEGATIVE = 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration';

/**
 * @typedef {object} Preset
 * @property {string} label
 * @property {number} steps
 * @property {number} cfg
 * @property {string} sampler
 * @property {string} scheduler
 * @property {string|null} negative  The preset's own negative; null = this preset ignores one (CFG 1)
 * @property {string} note           What the source says, in its words where we have them
 *
 * @typedef {object} Companion
 * @property {string} hint    The file the family's makers name
 * @property {string} folder  Where it goes under ComfyUI/
 *
 * @typedef {object} Family
 * @property {string} id
 * @property {string} name
 * @property {'unet'|'checkpoint'} loader   Which list its models come from (and which recipe slot they fill)
 * @property {'tags'|'prose'} tongue
 * @property {Record<string, Companion>} companions   slot name (`clip`, `vae`) → file
 * @property {{file: string, folder: string}} starter  The model a newcomer gets first
 * @property {Record<string, Preset>} presets
 * @property {string} defaultPreset
 * @property {{label: string, url?: string, read: string}} source
 */

/** @type {Readonly<Record<string, Family>>} */
export const FAMILIES = Object.freeze({
    anima: {
        id: 'anima',
        name: 'Anima',
        loader: 'unet',
        tongue: 'tags',
        companions: {
            clip: { hint: 'qwen_3_06b_base.safetensors', folder: 'models/text_encoders' },
            vae: { hint: 'qwen_image_vae.safetensors', folder: 'models/vae' },
        },
        starter: { file: 'anima-base-v1.0.safetensors', folder: 'models/diffusion_models' },
        presets: {
            base: { label: 'Base', steps: 30, cfg: 4, sampler: 'er_sde', scheduler: 'simple', negative: ANIMA_NEGATIVE, note: '"30-50 steps, CFG 4-5"; er_sde "a reasonable default"' },
            aesthetic: { label: 'Aesthetic', steps: 30, cfg: 4, sampler: 'er_sde', scheduler: 'simple', negative: 'worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration', note: 'base settings; "I recommend not using score_* tags in both the positive and negative prompt"' },
            turbo: { label: 'Turbo', steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', negative: null, note: '"Use at CFG 1 and 8-12 steps"; euler "Good with the Turbo and Aesthetic versions"; at CFG 1 a negative prompt does nothing' },
        },
        defaultPreset: 'base',
        source: { label: 'CircleStone Labs model card', url: 'https://huggingface.co/circlestone-labs/Anima', read: '2026-10-10' },
    },
    krea2: {
        id: 'krea2',
        name: 'KREA 2',
        loader: 'unet',
        tongue: 'prose',
        companions: {
            clip: { hint: 'qwen3vl_4b_fp8_scaled.safetensors', folder: 'models/text_encoders' },
            vae: { hint: 'qwen_image_vae.safetensors', folder: 'models/vae' },
        },
        starter: { file: 'krea2_turbo_fp8_scaled.safetensors', folder: 'models/diffusion_models' },
        presets: {
            turbo: { label: 'Turbo', steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple', negative: null, note: 'the shipped KREA 2 Turbo recipe; CFG 1, so no negative' },
        },
        defaultPreset: 'turbo',
        source: { label: 'Kotatsu\'s shipped KREA 2 Turbo recipe', read: '2026-10-09' },
    },
    sdxl: {
        id: 'sdxl',
        name: 'SDXL / Illustrious / Pony',
        loader: 'checkpoint',
        tongue: 'tags',
        companions: {},
        starter: { file: '', folder: 'models/checkpoints' },
        presets: {
            default: { label: 'Default', steps: 25, cfg: 6, sampler: 'euler', scheduler: 'normal', negative: '', note: 'Kotatsu\'s generic SDXL settings, not a maker\'s preset' },
        },
        defaultPreset: 'default',
        source: { label: 'Kotatsu default (Illustrious/Pony presets not researched yet)', read: '2026-10-10' },
    },
});

/**
 * Where each file Kotatsu may ask for comes from (§14.6): the official download, its ComfyUI
 * folder and size. Every url answered 200 to a HEAD on 2026-10-10 (Haiku research + Clio's own
 * check); sizes from the HuggingFace tree API / GitHub release. Anima's files sit under
 * `split_files/` in CircleStone's repo; saved locally without that prefix.
 * @type {Readonly<Record<string, {url: string, folder: string, bytes: number, list: string}>>}
 */
export const FILE_SOURCES = Object.freeze({
    'anima-base-v1.0.safetensors': { url: 'https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-base-v1.0.safetensors', folder: 'models/diffusion_models', bytes: 4_182_218_328, list: 'unet' },
    'qwen_3_06b_base.safetensors': { url: 'https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors', folder: 'models/text_encoders', bytes: 1_192_135_096, list: 'clip' },
    'qwen_image_vae.safetensors': { url: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors', folder: 'models/vae', bytes: 253_806_246, list: 'vae' },
    'krea2_turbo_fp8_scaled.safetensors': { url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors', folder: 'models/diffusion_models', bytes: 13_141_730_784, list: 'unet' },
    'qwen3vl_4b_fp8_scaled.safetensors': { url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors', folder: 'models/text_encoders', bytes: 5_242_467_968, list: 'clip' },
    'birefnet.safetensors': { url: 'https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors', folder: 'models/background_removal', bytes: 444_473_596, list: 'removers' },
    'RealESRGAN_x4plus_anime_6B.pth': { url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth', folder: 'models/upscale_models', bytes: 17_938_799, list: 'upscalers' },
});

/**
 * Where a newcomer gets ComfyUI itself (each answered 200 on 2026-10-10; the macOS and Linux guides on 2026-10-12,
 * the Linux one = Comfy Desktop's AppImage). The client keeps a copy for when ComfyUI is down (no `/models` answer).
 */
export const COMFY_INSTALL = Object.freeze({
    desktop: 'https://comfy.org/download',
    desktopDocs: 'https://docs.comfy.org/installation/desktop/windows',
    desktopDocsMac: 'https://docs.comfy.org/installation/desktop/macos',
    desktopDocsLinux: 'https://docs.comfy.org/installation/desktop/linux',
    portableDocs: 'https://docs.comfy.org/installation/comfyui_portable_windows',
});

/**
 * The files a family needs before it can draw, each marked present or not on a server.
 * @param {Family} family
 * @param {Record<string, string[]>} lists The server's model lists (`unet`, `checkpoints`, `clip`, `vae`, …)
 * @param {boolean} hasModel Whether any model of this family is set up or on the server
 * @returns {{role: string, file: string, present: boolean, source: typeof FILE_SOURCES[string]|null}[]}
 */
export function familyNeeds(family, lists, hasModel) {
    const has = (/** @type {string} */ list, /** @type {string} */ file) => Array.isArray(lists[list]) && lists[list].includes(file);
    /** @type {{role: string, file: string, present: boolean, source: typeof FILE_SOURCES[string]|null}[]} */
    const needs = [];
    if (family.starter.file && !hasModel) {
        needs.push({ role: 'model', file: family.starter.file, present: has('unet', family.starter.file) || has('checkpoints', family.starter.file), source: FILE_SOURCES[family.starter.file] ?? null });
    }
    for (const [slot, companion] of Object.entries(family.companions)) {
        const list = slot === 'vae' ? 'vae' : 'clip';
        needs.push({ role: slot === 'vae' ? 'VAE' : 'text encoder', file: companion.hint, present: has(list, companion.hint), source: FILE_SOURCES[companion.hint] ?? null });
    }
    return needs;
}

/** Name patterns per family, most specific first. Mirrors nothing: the client reads `/models`. */
const NAME_RULES = Object.freeze([
    ['krea2', /krea[-_ ]?2|^k2[-_]/i],
    ['anima', /anima(?!te|tion|l)/i],
    ['sdxl', /sdxl|sd[-_ ]?xl|illustrious|noob|pony/i],
]);

/** Layer-expanded Anima (Gazingstars123's 2.9B) needs its own loader node: never suggested as Anima. */
const UNSUPPORTED_RULES = Object.freeze([
    [/2[._]?9\s?b/i, 'Looks like a 2.9B layer-expanded Anima, which needs its own ComfyUI loader node. Not supported yet.'],
]);

/**
 * What Kotatsu thinks a model file is: a family and preset with the reason, or null with why not.
 * Never a guess the person has to undo: no family match = no suggestion.
 * @param {string} file As ComfyUI lists it
 * @param {Record<string, any>|null} metadata Its header (`/view_metadata`), or null
 * @returns {{family: string|null, preset: string|null, from: 'metadata'|'name'|null, why: string}}
 */
export function suggestModel(file, metadata) {
    const name = String(file ?? '');
    for (const [pattern, why] of UNSUPPORTED_RULES) {
        if (pattern.test(name)) return { family: null, preset: null, from: null, why };
    }
    const arch = String(metadata?.['modelspec.architecture'] ?? metadata?.ss_base_model_version ?? '');
    let family = null;
    /** @type {'metadata'|'name'|null} */
    let from = null;
    if (/stable-diffusion-xl/i.test(arch)) {
        family = 'sdxl';
        from = 'metadata';
    } else {
        for (const [id, pattern] of NAME_RULES) {
            if (pattern.test(arch)) {
                family = id;
                from = 'metadata';
                break;
            }
        }
    }
    if (!family) {
        for (const [id, pattern] of NAME_RULES) {
            if (pattern.test(name)) {
                family = id;
                from = 'name';
                break;
            }
        }
    }
    if (!family) return { family: null, preset: null, from: null, why: 'Nothing in its name or header says which family it is.' };
    const presets = FAMILIES[family].presets;
    const preset = Object.keys(presets).find(id => id !== FAMILIES[family].defaultPreset && new RegExp(id, 'i').test(name)) ?? FAMILIES[family].defaultPreset;
    return { family, preset, from, why: from === 'metadata' ? 'Its header names the architecture.' : 'Its file name says so.' };
}

/**
 * The sampler settings a preset puts on a graph, pass by pass. Full passes (denoise 1; or every
 * sampler when the graph has none, e.g. img2img) take the preset's steps; refine passes keep the
 * graph's ratio of their steps to the full pass's (Anima hires 20/30 → base 20, turbo 5). Every
 * pass takes cfg, sampler and scheduler.
 * @param {Record<string, {class_type: string, inputs: Record<string, any>}>} graph A filled graph (mutated)
 * @param {Preset} preset
 * @param {{steps?: number, cfg?: number}} [overrides] Per-model overrides from Settings
 * @returns {string[]} Ids of the samplers it set
 */
export function applyPreset(graph, preset, overrides = {}) {
    const steps = Number.isInteger(overrides.steps) && /** @type {number} */ (overrides.steps) > 0 ? /** @type {number} */ (overrides.steps) : preset.steps;
    const cfg = Number.isFinite(overrides.cfg) && /** @type {number} */ (overrides.cfg) > 0 ? /** @type {number} */ (overrides.cfg) : preset.cfg;
    const samplers = Object.entries(graph).filter(([, node]) => (node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced')
        && 'steps' in node.inputs && 'cfg' in node.inputs);
    if (!samplers.length) return [];
    const isFull = (/** @type {any} */ node) => node.inputs.denoise === undefined || Number(node.inputs.denoise) >= 1;
    const full = samplers.filter(([, node]) => isFull(node));
    const fullSteps = full.length ? Number(full[0][1].inputs.steps) : null;
    for (const [, node] of samplers) {
        const graphSteps = Number(node.inputs.steps);
        node.inputs.steps = !full.length || isFull(node) || !fullSteps
            ? steps
            : Math.max(1, Math.round(graphSteps * steps / fullSteps));
        node.inputs.cfg = cfg;
        node.inputs.sampler_name = preset.sampler;
        node.inputs.scheduler = preset.scheduler;
    }
    return samplers.map(([id]) => id);
}

/**
 * What the client is told about the families (everything; it is all public knowledge).
 * @returns {Record<string, Family>}
 */
export function publicFamilies() {
    return structuredClone(/** @type {Record<string, Family>} */ (FAMILIES));
}
