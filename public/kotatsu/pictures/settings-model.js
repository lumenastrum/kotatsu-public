/**
 * Pictures v0 — what the settings panel shows, decided without a DOM (docs/pictures-v0.md §9).
 *
 * `<k-pictures-settings>` is markup and wiring; the words and the choices it draws live here so
 * Jest can read them whole. Import-free apart from the contract.
 */

import { LANES, PURPOSES } from './contract.js';

/** The three lanes, in the order the switch prints them. */
export const LANE_OPTIONS = Object.freeze([
    Object.freeze({ id: LANES.COMFY, label: 'ComfyUI', hint: 'Your own ComfyUI, on this computer or your network. The prompt stays on your machines.' }),
    Object.freeze({ id: LANES.OPENAI, label: 'OpenAI key', hint: 'Draws with the OpenAI key you added under Connection.' }),
    Object.freeze({ id: LANES.GEMINI, label: 'Gemini key', hint: 'Draws with the Google AI Studio key you added under Connection.' }),
]);

/** One line per key lane (§6): what leaves the machine, and to whom. */
export const PRIVACY_LINES = Object.freeze({
    [LANES.OPENAI]: 'The prompt, which may quote the chat, and any reference picture are sent to OpenAI.',
    [LANES.GEMINI]: 'The prompt, which may quote the chat, and any reference picture are sent to Google.',
});

/** Purposes as the defaults list names them. */
export const PURPOSE_LABELS = Object.freeze({
    [PURPOSES.MOMENT]: 'This moment',
    [PURPOSES.CHAR]: 'The character',
    [PURPOSES.ME]: 'Me',
    [PURPOSES.PLACE]: 'The place',
    [PURPOSES.FREE]: 'Free',
});

/** OpenAI image models as of 2026-10-09 (§6.1), newest first. */
export const OPENAI_MODELS = Object.freeze(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini']);
export const OPENAI_QUALITIES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
export const OPENAI_SIZES = Object.freeze(['1024x1024', '1024x1536', '1536x1024', 'auto']);

/** Gemini image models as read 2026-10-09 (§6.2); the legacy 2.5 model is left off on purpose. */
export const GEMINI_MODELS = Object.freeze(['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image']);
export const GEMINI_SIZES = Object.freeze(['1K', '2K', '4K']);
export const GEMINI_ASPECTS = Object.freeze(['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9']);

/**
 * The providers' own prices (§6.1: quote them, never estimate), as their pricing pages listed them
 * on PRICES_READ. Per picture at 1024 × 1024 where OpenAI lists one; the 2.5 pair had only a
 * token rate. Gemini per picture by resolution.
 */
export const PRICES_READ = '2026-10-10';
export const PRICING_URLS = Object.freeze({
    [LANES.OPENAI]: 'https://developers.openai.com/api/docs/pricing',
    [LANES.GEMINI]: 'https://ai.google.dev/gemini-api/docs/pricing',
});
/** @type {Readonly<Record<string, Readonly<Record<string, number>>>>} dollars per picture, 1024 × 1024 */
const OPENAI_PER_PICTURE = Object.freeze({
    'gpt-image-2': Object.freeze({ low: 0.006, medium: 0.053, high: 0.211 }),
    'gpt-image-1.5': Object.freeze({ low: 0.009, medium: 0.034, high: 0.133 }),
    'gpt-image-1-mini': Object.freeze({ low: 0.005, medium: 0.011, high: 0.036 }),
});
/** @type {Readonly<Record<string, number>>} dollars per million image-output tokens */
const OPENAI_OUTPUT_RATE = Object.freeze({
    'gpt-image-2.5-flare': 30,
    'gpt-image-2.5-sunburst': 30,
    'gpt-image-2': 30,
    'gpt-image-1.5': 32,
    'gpt-image-1-mini': 8,
});
/** @type {Readonly<Record<string, Readonly<Record<string, number>>>>} dollars per picture */
const GEMINI_PER_PICTURE = Object.freeze({
    'gemini-nano-banana-2.1': Object.freeze({ '1K': 0.0336, '2K': 0.0504, '4K': 0.113 }),
    'gemini-3.1-flash-image': Object.freeze({ '1K': 0.067, '2K': 0.101, '4K': 0.151 }),
    'gemini-3.1-flash-lite-image': Object.freeze({ '1K': 0.0336 }),
    'gemini-3-pro-image': Object.freeze({ '1K': 0.134, '2K': 0.134, '4K': 0.24 }),
});

/**
 * @param {number} dollars
 * @returns {string} `$0.006`, `$0.0336`, `$0.24`
 */
function money(dollars) {
    return `$${dollars < 0.1 ? String(Number(dollars.toPrecision(3))) : dollars.toFixed(2)}`;
}

/**
 * The cost line under a key lane's choices: the provider's own listed price for what is chosen.
 * @param {string} lane
 * @param {{model?: string, quality?: string, size?: string}} choice
 * @returns {string}
 */
export function priceLine(lane, choice) {
    const model = String(choice?.model ?? '');
    if (lane === LANES.OPENAI) {
        const quality = String(choice?.quality ?? '');
        const each = OPENAI_PER_PICTURE[model]?.[quality];
        if (each !== undefined) return `OpenAI lists ${money(each)} a picture for ${model} at ${quality} quality, 1024 × 1024; larger sizes cost more.`;
        const rate = OPENAI_OUTPUT_RATE[model];
        if (rate !== undefined) {
            const at = OPENAI_PER_PICTURE[model] ? ` at ${quality || 'this'} quality` : '';
            return `OpenAI lists no per-picture price for ${model}${at}: it bills $${rate} per million image tokens, more for higher quality and larger sizes.`;
        }
        return 'OpenAI bills each picture to your key at its own image rates.';
    }
    if (lane === LANES.GEMINI) {
        const size = String(choice?.size ?? '');
        const each = GEMINI_PER_PICTURE[model]?.[size];
        if (each !== undefined) return `Google lists ${money(each)} a picture for ${model} at ${size}, plus the thinking it does first.`;
        return 'Google bills each picture to your key at its own image rates.';
    }
    return '';
}

/**
 * The key `slotChoices` is filed under: the address as typed, trimmed, without a trailing slash.
 * @param {string} url
 * @returns {string}
 */
export function serverKey(url) {
    return String(url ?? '').trim().replace(/\/+$/, '');
}

/**
 * Which `/check` model list fills a loader input.
 * @type {ReadonlyArray<[RegExp, string]>}
 */
const INPUT_LISTS = Object.freeze([
    [/^unet_name$/, 'unet'],
    [/^ckpt_name$/, 'checkpoints'],
    [/^clip_name\d*$/, 'clip'],
    [/^vae_name$/, 'vae'],
    [/^lora_name$/, 'loras'],
    [/^model_name$/, 'upscalers'],
    [/^bg_removal_name$/, 'removers'],
]);

/**
 * Fallback by slot name, for loaders with unusual input names.
 * @type {ReadonlyArray<[RegExp, string]>}
 */
const SLOT_LISTS = Object.freeze([
    [/unet|diffusion|model/i, 'unet'],
    [/ckpt|checkpoint/i, 'checkpoints'],
    [/clip|text.?encoder|te\b/i, 'clip'],
    [/vae/i, 'vae'],
    [/lora/i, 'loras'],
    [/upscal/i, 'upscalers'],
    [/remov/i, 'removers'],
]);

/**
 * The model list a recipe's slot picks from.
 * @param {{ slots?: Record<string, [string, string]> }} recipe
 * @param {string} slot
 * @param {Record<string, string[]>|null|undefined} models The last check's `models`.
 * @returns {string[]} Empty when there is no check yet or no list fits.
 */
export function modelsForSlot(recipe, slot, models) {
    if (!models || typeof models !== 'object') return [];
    const input = String(recipe?.slots?.[slot]?.[1] ?? '');
    const byInput = INPUT_LISTS.find(([pattern]) => pattern.test(input));
    const byName = SLOT_LISTS.find(([pattern]) => pattern.test(slot));
    const list = (byInput ?? byName)?.[1];
    const found = list ? models[list] : null;
    return Array.isArray(found) ? found.filter(name => typeof name === 'string') : [];
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
function plural(count, one, many = `${one}s`) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/**
 * The words under the Check button.
 * @param {{ state: 'idle'|'checking'|'ok'|'error', url?: string, result?: any, message?: string }} check
 * @returns {{ tone: 'idle'|'busy'|'ok'|'error', lead: string, detail: string }}
 */
export function describeCheck(check) {
    if (check.state === 'checking') return { tone: 'busy', lead: 'Checking…', detail: '' };
    if (check.state === 'error') {
        const detail = String(check.message ?? '').trim();
        return { tone: 'error', lead: `Couldn’t reach ${check.url || 'that address'}.`, detail };
    }
    if (check.state !== 'ok' || !check.result) {
        return { tone: 'idle', lead: 'Check the address to see the models it has.', detail: '' };
    }
    const result = check.result;
    const version = result.version ? ` ${result.version}` : '';
    const device = result.device ? ` on ${result.device}` : '';
    const models = result.models && typeof result.models === 'object' ? result.models : {};
    const count = (/** @type {string} */ key) => (Array.isArray(models[key]) ? models[key].length : 0);
    const parts = [];
    if (typeof result.nodeTypes === 'number') parts.push(plural(result.nodeTypes, 'node type'));
    if (result.queue && typeof result.queue === 'object') {
        parts.push(`queue ${Number(result.queue.running ?? 0)} running, ${Number(result.queue.pending ?? 0)} waiting`);
    }
    const listed = [
        [count('unet'), 'diffusion model'],
        [count('checkpoints'), 'checkpoint'],
        [count('clip'), 'text encoder'],
        [count('vae'), 'VAE', 'VAEs'],
        [count('loras'), 'LoRA', 'LoRAs'],
    ].filter(([n]) => Number(n) > 0).map(([n, one, many]) => plural(Number(n), String(one), many ? String(many) : undefined));
    if (listed.length) parts.push(listed.join(', '));
    return { tone: 'ok', lead: `Connected to ComfyUI${version}${device}.`, detail: parts.join(' · ') };
}

/**
 * The honest message for a failed request to Kotatsu's own pictures routes.
 * @param {number} status
 * @param {any} body Parsed JSON body, when there was one.
 * @returns {string}
 */
export function describeHttpFailure(status, body) {
    if (body && typeof body.message === 'string' && body.message.trim()) return body.message.trim();
    if (status === 404) return 'This Kotatsu has no pictures service yet (it answered 404).';
    return `Kotatsu answered ${status}.`;
}
