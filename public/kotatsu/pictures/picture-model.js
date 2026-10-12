/**
 * Pictures v0, slice B — the pure half (docs/pictures-v0.md §2, §8, §13).
 *
 * No DOM and no core imports, so jest loads it in node. Everything the client surfaces decide
 * about DATA lives here: the stock-shaped message a picture becomes, how re-rolls append to it,
 * where a candidate's provenance is found again, what `/imagine` words mean, which recipe the
 * sheet starts on. `picture-actions.js` does the core side effects with these results.
 */

import { DEFAULT_SETTINGS, DEFAULT_SIZES, LANES, PICTURE_EXTRA_KEY, PORTRAIT_PURPOSES, PURPOSES } from './contract.js';
import { GEMINI_ASPECTS, OPENAI_SIZES } from './settings-model.js';

/**
 * The chat-message text a picture carries: stock's template (the removed extension's default)
 * without its stray trailing period. The chat model reads it to know what the picture shows.
 */
export const CAPTION_TEMPLATE = '[{{char}} sends a picture that contains: {{prompt}}]';

/**
 * Joins negatives as comma tags, first spelling wins, duplicates dropped (case-insensitive).
 * @param {...string} parts
 * @returns {string}
 */
export function joinNegatives(...parts) {
    const seen = new Set();
    const tags = [];
    for (const part of parts) {
        for (const tag of String(part ?? '').split(',').map(t => t.trim()).filter(Boolean)) {
            const key = tag.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            tags.push(tag);
        }
    }
    return tags.join(', ');
}

/** Recognizes a caption line, ours or stock's (with its period), so edited text is never hidden. */
const CAPTION_PATTERN = /^\[[^\]\n]*? sends a picture that contains: [\s\S]*\]\.?$/;

/** A caption line anywhere in a text (a prompt names its speaker in front of it). Global: use with replace(). */
export const CAPTION_LINE_PATTERN = /\[[^\]\n]*? sends a picture that contains: [^\]]*\]\.?/g;

/**
 * @param {unknown} text Any text
 * @returns {string} The text with every picture caption line taken out, trimmed.
 */
export function stripCaptionLines(text) {
    return String(text ?? '').replace(CAPTION_LINE_PATTERN, '').trim();
}

/**
 * @param {unknown} text A message's `mes`.
 * @returns {boolean} Whether it is only a picture caption line.
 */
export function isCaptionText(text) {
    return typeof text === 'string' && CAPTION_PATTERN.test(text.trim());
}

/** Sheet chip labels. `{{char}}` is filled with the character's name by the sheet. */
export const PURPOSE_LABELS = Object.freeze({
    [PURPOSES.MOMENT]: 'This moment',
    [PURPOSES.CHAR]: '{{char}}',
    [PURPOSES.ME]: 'Me',
    [PURPOSES.PLACE]: 'The place',
    [PURPOSES.FREE]: 'Free',
});

/** The pending row's first line, per purpose. `{{char}}` as above. */
export const PENDING_LINES = Object.freeze({
    [PURPOSES.MOMENT]: 'Drawing this moment',
    [PURPOSES.CHAR]: 'Drawing {{char}}',
    [PURPOSES.ME]: 'Drawing you',
    [PURPOSES.PLACE]: 'Drawing the place',
    [PURPOSES.FREE]: 'Drawing a picture',
});

/**
 * `/imagine` purpose words: Kotatsu's five plus the stock extension's synonyms (its `triggerWords`
 * table), so muscle memory and old STscript keep landing on the closest purpose.
 * @type {Readonly<Record<string, string>>}
 */
export const PURPOSE_WORDS = Object.freeze({
    moment: PURPOSES.MOMENT,
    last: PURPOSES.MOMENT,
    char: PURPOSES.CHAR,
    you: PURPOSES.CHAR,
    yourself: PURPOSES.CHAR,
    face: PURPOSES.CHAR,
    me: PURPOSES.ME,
    place: PURPOSES.PLACE,
    background: PURPOSES.PLACE,
    scene: PURPOSES.PLACE,
    free: PURPOSES.FREE,
});

/**
 * @param {unknown} value
 * @returns {value is string} Whether it names one of the five purposes.
 */
export function isPurpose(value) {
    return typeof value === 'string' && /** @type {string[]} */ (Object.values(PURPOSES)).includes(value);
}

/**
 * Reads `/imagine`'s unnamed text: an optional purpose word first, then free text.
 * Free text with no purpose word means the Free purpose; nothing at all means "open the sheet".
 * @param {unknown} text
 * @returns {{purpose: string|null, free: string}} `purpose` null when nothing was typed.
 */
export function parseImagineArgs(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) return { purpose: null, free: '' };
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw);
    const word = (match?.[1] ?? '').toLowerCase();
    if (Object.hasOwn(PURPOSE_WORDS, word)) {
        return { purpose: PURPOSE_WORDS[word], free: (match?.[2] ?? '').trim() };
    }
    return { purpose: PURPOSES.FREE, free: raw };
}

/**
 * @param {unknown} size `WxH`.
 * @returns {{width: number, height: number}|null}
 */
export function parseSize(size) {
    const match = typeof size === 'string' ? /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(size) : null;
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The sizes a recipe offers: its own list, or the shared defaults.
 * @param {{sizes?: string[]}|null|undefined} recipe
 * @returns {string[]}
 */
export function sizesFor(recipe) {
    const own = Array.isArray(recipe?.sizes) ? recipe.sizes.filter(size => parseSize(size)) : [];
    return own.length > 0 ? own : [...DEFAULT_SIZES];
}

/**
 * The recipe id a variant name points at. The contract names ids (`{ hires: 'krea2-turbo-hires' }`);
 * the design doc's example names a file, so a trailing `.json` is tolerated.
 * @param {{variants?: Record<string, string>}|null|undefined} recipe
 * @param {string} name e.g. `hires`
 * @returns {string} '' when the recipe has no such variant.
 */
export function variantId(recipe, name) {
    const value = recipe?.variants?.[name];
    return typeof value === 'string' && value.trim() ? value.trim().replace(/\.json$/i, '') : '';
}

/**
 * @param {{missing?: string[]}|null|undefined} recipe
 * @returns {string} "Needs: X, Y" when the last checked server lacks node types, else ''.
 */
export function needsLine(recipe) {
    const missing = Array.isArray(recipe?.missing) ? recipe.missing.filter(Boolean) : [];
    return missing.length > 0 ? `Needs: ${missing.join(', ')}` : '';
}

/**
 * Which recipe the sheet starts on: the purpose's default, else the last one used, else the first
 * recipe that can run, else the first at all.
 * @param {{id: string, missing?: string[]}[]} recipes
 * @param {{purpose?: string, recipeByPurpose?: Record<string, string>, last?: string}} [hints]
 * @returns {string} '' when there are none.
 */
export function pickRecipe(recipes, { purpose = '', recipeByPurpose = {}, last = '' } = {}) {
    const list = Array.isArray(recipes) ? recipes.filter(r => r && typeof r.id === 'string') : [];
    const has = (/** @type {string} */ id) => !!id && list.some(r => r.id === id);
    const byPurpose = purpose ? recipeByPurpose?.[purpose] ?? '' : '';
    if (has(byPurpose)) return byPurpose;
    if (has(last)) return last;
    const runnable = list.find(r => !needsLine(r));
    return runnable?.id ?? list[0]?.id ?? '';
}

/**
 * The seed a saved file carries in its name (`<yyyymmdd-hhmmss>-<seed>.png`, docs §13.2).
 * @param {unknown} url
 * @returns {number|null}
 */
export function seedFromUrl(url) {
    if (typeof url !== 'string') return null;
    const file = url.split(/[\\/]/).pop() ?? '';
    const match = /-(\d+)\.(?:png|jpe?g|webp|gif)$/i.exec(file);
    if (!match) return null;
    const seed = Number(match[1]);
    return Number.isSafeInteger(seed) ? seed : null;
}

/**
 * A stock media attachment for one generated image (the removed extension's shape, verbatim keys).
 * @param {{url: string, prompt: string, negative?: string, purpose: string}} args
 * @returns {{url: string, type: string, title: string, generation_type: string, negative: string, source: string}}
 */
export function buildAttachment({ url, prompt, negative = '', purpose }) {
    return {
        url,
        type: 'image',
        title: prompt,
        generation_type: purpose,
        negative,
        source: 'generated',
    };
}

/**
 * Fills stock's `{{char}}`/`{{prompt}}` caption template without core's macro engine (the caller
 * may still pass the result through it; nothing else in the line is a macro).
 * @param {string} name Sender name.
 * @param {string} prompt
 * @returns {string}
 */
export function captionText(name, prompt) {
    return CAPTION_TEMPLATE.replace('{{char}}', () => name).replace('{{prompt}}', () => prompt);
}

/**
 * @typedef {object} PictureImage
 * @property {string} url
 * @property {number} [width]
 * @property {number} [height]
 */

/**
 * One provenance entry per image. The size is the image's own when the lane reported it.
 * @param {import('./contract.js').PictureProvenance} provenance
 * @param {PictureImage} image
 * @returns {import('./contract.js').PictureProvenance}
 */
function provenanceForImage(provenance, image) {
    const entry = { ...provenance };
    if (Number(image?.width) > 0 && Number(image?.height) > 0) entry.size = `${image.width}x${image.height}`;
    const fileSeed = seedFromUrl(image?.url);
    if (fileSeed !== null && !Number.isFinite(entry.seed)) entry.seed = fileSeed;
    for (const key of Object.keys(entry)) {
        if (entry[key] === undefined) delete entry[key];
    }
    return entry;
}

/**
 * Builds the message a finished picture becomes: stock's generated-picture shape exactly
 * (`extra.media[]`, `media_display: 'gallery'`, `media_index`, `inline_image: false`) plus the
 * additive `extra.kotatsu_picture` keyed by media index (§8).
 *
 * The message always carries the caption text and is an ordinary message (stock's "visible" mode),
 * so the chat model knows what the picture shows on later turns — except a portrait
 * (`PORTRAIT_PURPOSES`), a one-shot kept out of the chat model's context as `is_system`. Whether a reader SEES the line is
 * the `captionLine` setting, applied by CSS to rows marked `data-k-pic-caption` (k-picture-menu.js).
 * @param {object} args
 * @param {{name: string, force_avatar?: string, original_avatar?: string}} args.sender
 * @param {PictureImage[]} args.images
 * @param {import('./contract.js').PictureProvenance} args.provenance
 * @param {string} args.sendDate core's `getMessageTimeStamp()`
 * @param {(text: string) => string} [args.substitute] macro pass for the caption (core's)
 * @returns {any} A `chat[]` entry.
 */
export function buildPictureMessage({ sender, images, provenance, sendDate, substitute }) {
    const list = (Array.isArray(images) ? images : []).filter(image => image && typeof image.url === 'string' && image.url);
    if (list.length === 0) throw new Error('A picture message needs at least one image.');
    const prompt = String(provenance?.prompt ?? '');
    const text = captionText(sender.name, prompt);
    /** @type {Record<string, import('./contract.js').PictureProvenance>} */
    const provenanceByIndex = {};
    list.forEach((image, index) => {
        provenanceByIndex[index] = provenanceForImage(provenance, image);
    });

    /** @type {any} */
    const message = {
        name: sender.name,
        is_user: false,
        is_system: PORTRAIT_PURPOSES.includes(String(provenance?.purpose ?? '')),
        send_date: sendDate,
        mes: text && typeof substitute === 'function' ? substitute(text) : text,
        extra: {
            media: list.map(image => buildAttachment({
                url: image.url,
                prompt,
                negative: String(provenance?.negative ?? ''),
                purpose: String(provenance?.purpose ?? PURPOSES.FREE),
            })),
            media_display: 'gallery',
            media_index: 0,
            inline_image: false,
            [PICTURE_EXTRA_KEY]: provenanceByIndex,
        },
    };
    if (sender.force_avatar) message.force_avatar = sender.force_avatar;
    if (sender.original_avatar) message.original_avatar = sender.original_avatar;
    return message;
}

/**
 * Appends re-roll candidates to an existing picture message: new media at the end, provenance at
 * the new indices, `media_index` on the first new one, so stock's gallery arrows walk them.
 * @param {any} message A `chat[]` entry (mutated).
 * @param {PictureImage[]} images
 * @param {import('./contract.js').PictureProvenance} provenance
 * @returns {number} The new `media_index`, or -1 when nothing was added.
 */
export function appendCandidates(message, images, provenance) {
    const list = (Array.isArray(images) ? images : []).filter(image => image && typeof image.url === 'string' && image.url);
    if (!message || typeof message !== 'object' || list.length === 0) return -1;
    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    const extra = message.extra;
    if (!Array.isArray(extra.media)) extra.media = [];
    if (!extra[PICTURE_EXTRA_KEY] || typeof extra[PICTURE_EXTRA_KEY] !== 'object') extra[PICTURE_EXTRA_KEY] = {};
    const first = extra.media.length;
    const prompt = String(provenance?.prompt ?? '');
    list.forEach((image, offset) => {
        extra.media.push(buildAttachment({
            url: image.url,
            prompt,
            negative: String(provenance?.negative ?? ''),
            purpose: String(provenance?.purpose ?? PURPOSES.FREE),
        }));
        extra[PICTURE_EXTRA_KEY][first + offset] = provenanceForImage(provenance, image);
    });
    extra.media_display ??= 'gallery';
    extra.inline_image ??= false;
    extra.media_index = first;
    return first;
}

/**
 * @param {any} message
 * @returns {boolean} Whether this message was drawn by Pictures (and still shows media).
 */
export function isPictureMessage(message) {
    const extra = message?.extra;
    return !!extra
        && !!extra[PICTURE_EXTRA_KEY] && typeof extra[PICTURE_EXTRA_KEY] === 'object'
        && Array.isArray(extra.media) && extra.media.length > 0;
}

/**
 * The provenance of one media entry. Keys are media indices (§8), but stock's own trash button
 * splices `extra.media` without knowing about this map, so a key can point at the wrong picture
 * afterwards. The file name carries the seed (§13.2), which tells the right entry apart from its
 * siblings — re-rolls share the prompt, never the seed.
 * @param {any} message
 * @param {number} index Media index.
 * @returns {import('./contract.js').PictureProvenance|null}
 */
export function provenanceFor(message, index) {
    const map = message?.extra?.[PICTURE_EXTRA_KEY];
    const media = message?.extra?.media?.[index];
    if (!map || typeof map !== 'object' || !media) return null;
    const direct = map[index] ?? null;
    const fileSeed = seedFromUrl(media.url);
    if (fileSeed === null) return direct;
    if (direct && Number(direct.seed) === fileSeed) return direct;
    const bySeed = Object.values(map).find(entry => entry && Number(entry.seed) === fileSeed);
    return bySeed ?? direct;
}

/**
 * Removes one media entry and keeps the provenance map aligned with the array: entries above the
 * removed index move down one. `media_index` follows stock's delete rule (`chats.js`).
 * @param {any} message A `chat[]` entry (mutated).
 * @param {number} index
 * @returns {string|null} The removed media url, or null when the index was out of range.
 */
export function removeCandidate(message, index) {
    const extra = message?.extra;
    if (!extra || !Array.isArray(extra.media) || index < 0 || index >= extra.media.length) return null;
    const [removed] = extra.media.splice(index, 1);
    const map = extra[PICTURE_EXTRA_KEY];
    if (map && typeof map === 'object') {
        /** @type {Record<string, any>} */
        const next = {};
        for (const [key, value] of Object.entries(map)) {
            const at = Number(key);
            if (!Number.isInteger(at) || at === index) continue;
            next[at > index ? at - 1 : at] = value;
        }
        extra[PICTURE_EXTRA_KEY] = next;
    }
    if (extra.media_index === index) {
        const newIndex = index > 0 ? index - 1 : 0;
        extra.media_index = Math.min(Math.max(newIndex, 0), Math.max(extra.media.length - 1, 0));
    } else if (typeof extra.media_index === 'number' && extra.media_index > index) {
        extra.media_index -= 1;
    }
    return typeof removed?.url === 'string' ? removed.url : null;
}

/**
 * The request a re-roll sends, from a stored provenance entry.
 * @param {import('./contract.js').PictureProvenance} provenance
 * @param {object} options
 * @param {'again'|'bigger'} options.mode `again` = new seed, same recipe; `bigger` = same seed, the hires recipe
 * @param {string} options.character Folder under `user/images/`.
 * @param {string} [options.recipe] Override (the hires variant's id for `bigger`).
 * @returns {import('./contract.js').PictureRequest|null} null when the entry cannot be replayed.
 */
export function rerollRequest(provenance, { mode, character, recipe }) {
    if (!provenance || typeof provenance.prompt !== 'string') return null;
    const size = parseSize(provenance.size) ?? parseSize(DEFAULT_SIZES[0]);
    if (!size) return null;
    /** @type {import('./contract.js').PictureRequest} */
    const request = {
        lane: provenance.lane,
        prompt: provenance.prompt,
        negative: provenance.negative ?? '',
        width: size.width,
        height: size.height,
        purpose: provenance.purpose,
        character,
    };
    const recipeId = recipe || provenance.recipe;
    if (recipeId) request.recipe = recipeId;
    if (provenance.reference) request.reference = provenance.reference;
    if (provenance.model) request.model = provenance.model;
    if (provenance.family) request.family = provenance.family;
    if (provenance.preset) request.preset = provenance.preset;
    if (Array.isArray(provenance.loras) && provenance.loras.length) request.loras = loraRequest(provenance.loras);
    if (mode === 'bigger') {
        if (!Number.isFinite(Number(provenance.seed))) return null;
        request.seed = Number(provenance.seed);
    }
    return request;
}

/**
 * The provenance a finished job leaves on the message.
 * @param {import('./contract.js').PictureRequest} request What was sent.
 * @param {{seed?: number, graphSha?: string, lane?: string, recipe?: string}} done The `done` event.
 * @param {number|undefined} startedSeed The seed `POST /jobs` returned.
 * @returns {import('./contract.js').PictureProvenance}
 */
export function provenanceFromJob(request, done, startedSeed) {
    const numeric = (/** @type {unknown} */ value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
    const seed = numeric(done?.seed) ? Number(done?.seed)
        : numeric(startedSeed) ? Number(startedSeed)
            : numeric(request.seed) ? Number(request.seed) : NaN;
    // A key lane is sent no width/height (the provider picks from its own sizes): the drawn size is the picture's.
    const drawn = /** @type {any} */ (done)?.images?.[0];
    const size = Number.isFinite(request.width) && Number.isFinite(request.height) ? `${request.width}x${request.height}`
        : Number(drawn?.width) > 0 && Number(drawn?.height) > 0 ? `${drawn.width}x${drawn.height}`
            : String(request.size ?? '');
    /** @type {import('./contract.js').PictureProvenance} */
    const provenance = {
        lane: done?.lane || request.lane,
        seed,
        size,
        prompt: request.prompt,
        negative: request.negative ?? '',
        purpose: request.purpose,
    };
    const recipe = done?.recipe || request.recipe;
    if (recipe) provenance.recipe = recipe;
    if (done?.graphSha) provenance.graphSha = done.graphSha;
    if (request.reference) provenance.reference = request.reference;
    const model = /** @type {any} */ (done)?.model || request.model;
    if (model) provenance.model = model;
    if (request.family) provenance.family = request.family;
    if (request.preset) provenance.preset = request.preset;
    if (request.quality) provenance.quality = request.quality;
    if (request.aspect) provenance.aspect = request.aspect;
    if (provenance.lane === LANES.GEMINI && request.size) provenance.resolution = request.size;
    if (Array.isArray(request.loras) && request.loras.length) provenance.loras = loraRequest(request.loras);
    return provenance;
}

/**
 * @param {unknown} lane
 * @returns {boolean} Whether the lane is a key lane (OpenAI, Gemini): no recipe, no seed, no negative.
 */
export function isKeyLane(lane) {
    return lane === LANES.OPENAI || lane === LANES.GEMINI;
}

/**
 * The shapes the sheet offers on a key lane, and the one it starts on.
 * OpenAI: its sizes (`WxH` or `auto`); Gemini: aspect ratios (the resolution is a setting).
 * @param {import('./contract.js').PicturesSettings} settings
 * @param {string} [last] The sheet's last size, kept when it fits.
 * @returns {{shapes: readonly string[], shape: string}}
 */
export function keyLaneShapes(settings, last = '') {
    const openai = settings.lane === LANES.OPENAI;
    const shapes = openai ? OPENAI_SIZES : GEMINI_ASPECTS;
    const preferred = openai ? settings.openai?.size : settings.gemini?.aspect;
    const shape = [last, preferred].find(s => s && shapes.includes(s)) ?? shapes[0];
    return { shapes, shape };
}

/**
 * How a key-lane shape reads in the size menu.
 * @param {string} shape
 * @returns {string}
 */
export function shapeLabel(shape) {
    if (shape === 'auto') return 'Let the model choose';
    return shape.includes('x') ? shape.replace('x', ' × ') : shape;
}

/**
 * The request a key lane sends from the sheet or `/imagine`.
 * @param {import('./contract.js').PicturesSettings} settings
 * @param {{prompt: string, purpose: string, character: string, shape?: string, reference?: string}} job
 * @returns {import('./contract.js').PictureRequest}
 */
export function keyLaneRequest(settings, { prompt, purpose, character, shape, reference }) {
    const lane = settings.lane;
    const chosen = shape || keyLaneShapes(settings).shape;
    /** @type {import('./contract.js').PictureRequest} */
    const request = /** @type {any} */ ({ lane, prompt, purpose, character });
    if (lane === LANES.OPENAI) {
        request.model = settings.openai?.model || DEFAULT_SETTINGS.openai.model;
        request.quality = settings.openai?.quality || DEFAULT_SETTINGS.openai.quality;
        request.size = chosen;
    } else {
        request.model = settings.gemini?.model || DEFAULT_SETTINGS.gemini.model;
        request.size = settings.gemini?.size || DEFAULT_SETTINGS.gemini.size;
        request.aspect = chosen;
    }
    if (reference) request.reference = reference;
    return request;
}

/**
 * The request Again sends for a key-lane picture: same model, prompt and shape (no seed to keep).
 * @param {import('./contract.js').PictureProvenance} provenance
 * @param {string} character
 * @returns {import('./contract.js').PictureRequest|null}
 */
export function keyLaneReroll(provenance, character) {
    if (!provenance || typeof provenance.prompt !== 'string' || !provenance.model) return null;
    /** @type {any} */
    const request = { lane: provenance.lane, model: provenance.model, prompt: provenance.prompt, purpose: provenance.purpose, character };
    if (provenance.lane === LANES.OPENAI) {
        if (provenance.quality) request.quality = provenance.quality;
        if (parseSize(provenance.size)) request.size = provenance.size;
    } else {
        if (provenance.resolution) request.size = provenance.resolution;
        if (provenance.aspect) request.aspect = provenance.aspect;
    }
    if (provenance.reference) request.reference = provenance.reference;
    return request;
}

// ─── LoRAs (ComfyUI lane, 2026-10-10) ────────────────────────────────────────

/** At most this many LoRAs on one picture (the server's MAX_LORAS). */
export const MAX_LORAS = 8;

/** How each family reads in the sheet. */
/** @type {Readonly<Record<string, string>>} */
export const LORA_BASE_NAMES = Object.freeze({ anima: 'Anima', krea2: 'KREA 2', flux: 'Flux', 'qwen-image': 'Qwen-Image', sdxl: 'SDXL', sd15: 'SD 1.5' });

/**
 * Model families a name or a recipe can point at. Mirrors `BASE_PATTERNS` in
 * src/endpoints/kotatsu/pictures/loras.js (a test pins the two together).
 * @type {ReadonlyArray<[string, RegExp]>}
 */
export const LORA_BASE_PATTERNS = Object.freeze([
    ['anima', /anima(?!te|tion|l)/i],
    ['krea2', /krea[-_ ]?2|\bk2[-_]/i],
    ['flux', /flux/i],
    ['qwen-image', /qwen[-_ ]?image/i],
    ['sdxl', /sdxl|sd[-_ ]?xl|illustrious|noob|pony/i],
    ['sd15', /sd[-_ ]?1[._]?5|sd15|\bsd_?v1\b|stable-diffusion-v1/i],
]);

/**
 * @param {unknown} text
 * @returns {string|null} The family a string names, or null.
 */
export function baseFromText(text) {
    const value = String(text ?? '');
    if (!value) return null;
    for (const [base, pattern] of LORA_BASE_PATTERNS) {
        if (pattern.test(value)) return base;
    }
    return null;
}

/**
 * The family a recipe draws with: its own `base`, else what its id, name and model hints say.
 * (Shipped recipes are seeded once, so an install from before `base` existed reads the name.)
 * @param {import('./contract.js').Recipe|null|undefined} recipe
 * @returns {string|null}
 */
export function recipeBase(recipe) {
    if (!recipe) return null;
    const named = recipe.family ?? /** @type {any} */ (recipe).base;
    if (typeof named === 'string' && named) return named;
    const hints = /** @type {any} */ (recipe).hints ?? {};
    return baseFromText([recipe.id, recipe.name, hints.unet, hints.checkpoint].filter(Boolean).join(' '));
}

/**
 * @typedef {object} LoraInfo   one row of `POST /loras`
 * @property {string} file
 * @property {string|null} base
 * @property {'metadata'|'name'|null} baseFrom
 * @property {string[]} triggers
 * @property {string} title
 */

/**
 * Splits the server's LoRAs for a recipe's family (Andres, 2026-10-10: hide mismatches): those made
 * for it, those whose family is unknown, and those made for another (shown only on "Show all").
 * With no family for the recipe, everything is `unknown`.
 * @param {LoraInfo[]} loras
 * @param {string|null} base
 * @returns {{matching: LoraInfo[], unknown: LoraInfo[], other: LoraInfo[]}}
 */
export function groupLoras(loras, base) {
    const list = Array.isArray(loras) ? loras : [];
    const byTitle = (/** @type {LoraInfo} */ a, /** @type {LoraInfo} */ b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
    if (!base) return { matching: [], unknown: [...list].sort(byTitle), other: [] };
    return {
        matching: list.filter(l => l.base === base).sort(byTitle),
        unknown: list.filter(l => !l.base).sort(byTitle),
        other: list.filter(l => l.base && l.base !== base).sort(byTitle),
    };
}

/** Purposes that draw the card's character, so its LoRAs ride along (Andres, 2026-10-10). Not Me: that is the persona. */
export const CARD_LORA_PURPOSES = Object.freeze([PURPOSES.MOMENT, PURPOSES.CHAR]);

/**
 * The card's LoRAs for a purpose: all of them when it draws the character, none otherwise
 * (Me, The place, Free start bare; the sheet can still add them).
 * @param {string} purpose
 * @param {unknown} cardLoras The look's `loras`
 * @returns {import('./contract.js').LoraChoice[]}
 */
export function cardLorasFor(purpose, cardLoras) {
    return /** @type {readonly string[]} */ (CARD_LORA_PURPOSES).includes(purpose) ? normalizeLoras(cardLoras) : [];
}

/**
 * LoRAs in their stored shape (a card's look, a request, provenance): `{file, strength, trigger}`,
 * at most MAX_LORAS, strength a number in −10..10 (default 1), trigger trimmed ('' = none).
 * @param {unknown} value
 * @returns {import('./contract.js').LoraChoice[]}
 */
export function normalizeLoras(value) {
    if (!Array.isArray(value)) return [];
    /** @type {import('./contract.js').LoraChoice[]} */
    const out = [];
    for (const item of value) {
        const file = typeof item?.file === 'string' ? item.file.trim() : '';
        if (!file || out.some(l => l.file === file)) continue;
        const raw = item.strength === undefined || item.strength === null || item.strength === '' ? 1 : Number(item.strength);
        const strength = Number.isFinite(raw) ? Math.min(10, Math.max(-10, Math.round(raw * 100) / 100)) : 1;
        out.push({ file, strength, trigger: typeof item.trigger === 'string' ? item.trigger.trim() : '' });
        if (out.length === MAX_LORAS) break;
    }
    return out;
}

/**
 * @param {string} text
 * @returns {string[]} The comma-separated items, trimmed.
 */
function commaItems(text) {
    return String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * The prompt with each trigger in front unless it is already one of the prompt's comma items
 * (Andres, 2026-10-10: triggers go in on their own, visible and editable).
 * @param {string} prompt
 * @param {string[]} triggers Each may itself hold several comma-separated words.
 * @returns {string}
 */
export function withTriggers(prompt, triggers) {
    const have = new Set(commaItems(prompt).map(s => s.toLowerCase()));
    const missing = [];
    for (const trigger of triggers) {
        for (const word of commaItems(trigger)) {
            if (!have.has(word.toLowerCase())) {
                have.add(word.toLowerCase());
                missing.push(word);
            }
        }
    }
    if (!missing.length) return prompt;
    const rest = String(prompt ?? '').trim();
    return rest ? `${missing.join(', ')}, ${rest}` : missing.join(', ');
}

/**
 * The prompt without a trigger's words, when they stand as their own comma items (a word inside a
 * sentence stays put).
 * @param {string} prompt
 * @param {string} trigger
 * @returns {string}
 */
export function withoutTrigger(prompt, trigger) {
    const words = new Set(commaItems(trigger).map(s => s.toLowerCase()));
    if (!words.size) return prompt;
    const parts = String(prompt ?? '').split(',');
    const kept = parts.filter(part => !words.has(part.trim().toLowerCase()));
    if (kept.length === parts.length) return prompt;
    return kept.map(s => s.trim()).filter(Boolean).join(', ');
}

/**
 * The LoRA rows a request carries (the trigger stays on the card; the prompt already holds it).
 * @param {unknown} loras LoraChoice-shaped rows (a trigger is allowed and dropped)
 * @returns {{file: string, strength: number}[]}
 */
export function loraRequest(loras) {
    return normalizeLoras(loras).map(({ file, strength }) => ({ file, strength }));
}

// ─── Models and pipelines (§14) ──────────────────────────────────────────────

/**
 * @typedef {object} ModelSuggestion
 * @property {string|null} family
 * @property {string|null} preset
 * @property {'metadata'|'name'|null} from
 * @property {string} why
 *
 * @typedef {object} ModelInfo   one row of `POST /models`
 * @property {string} file
 * @property {string[]} lists      `unet` and/or `checkpoints`
 * @property {ModelSuggestion} suggestion
 *
 * @typedef {object} FamilyPreset
 * @property {string} label
 * @property {number} steps
 * @property {number} cfg
 * @property {string} sampler
 * @property {string} scheduler
 * @property {string|null} negative
 * @property {string} note
 *
 * @typedef {object} FamilyInfo   one entry of `POST /models` `families`
 * @property {string} id
 * @property {string} name
 * @property {'unet'|'checkpoint'} loader
 * @property {string} tongue
 * @property {Record<string, {hint: string, folder: string}>} companions
 * @property {{file: string, folder: string}} starter
 * @property {Record<string, FamilyPreset>} presets
 * @property {string} defaultPreset
 * @property {{label: string, url?: string, read: string}} source
 */

/**
 * @typedef {object} FileNeed   a file a family (or a pipeline) needs on the server (§14.6)
 * @property {string} role       `model`, `text encoder`, `VAE`, or a pipeline extra
 * @property {string} file
 * @property {boolean} present
 * @property {{url: string, folder: string, bytes: number}|null} source
 */

/**
 * The three setup steps for local pictures and whether each is done (§14.6): ComfyUI answers;
 * one family has every file it needs; one model is set up.
 * @param {{reachable: boolean, setup: Record<string, FileNeed[]>, confirmed: number}} state
 * @returns {{id: 'install'|'files'|'confirm', done: boolean}[]}
 */
export function setupSteps({ reachable, setup, confirmed }) {
    const ready = reachable && Object.values(setup ?? {}).some(needs => needs.length > 0 && needs.every(n => n.present));
    return [
        { id: 'install', done: reachable },
        { id: 'files', done: ready },
        { id: 'confirm', done: reachable && confirmed > 0 },
    ];
}

/**
 * @param {number} bytes
 * @returns {string} `4.2 GB`, `254 MB`
 */
export function sizeLabel(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** How each pipeline kind reads in the sheet. */
export const PIPELINE_LABELS = Object.freeze({ plain: 'Plain', bigger: 'Bigger (hires)', sprite: 'Sprite' });
const PIPELINE_ORDER = Object.freeze(['plain', 'bigger', 'sprite']);

/**
 * The Models list a server shows: each file with its saved record and where it stands.
 * `confirmed` = set up by the person; `suggested` = Kotatsu has a family for it, not yet confirmed;
 * `unknown` = no family (it waits to be told, and is never drawn with).
 * @param {ModelInfo[]} models
 * @param {Record<string, {family: string, preset: string}|null>|undefined} saved This server's `models` leaf
 * @param {Record<string, FamilyInfo>} families
 * @returns {{file: string, lists: string[], suggestion: ModelSuggestion, record: {family: string, preset: string}|null, state: 'confirmed'|'suggested'|'unknown'}[]}
 */
export function modelRows(models, saved, families) {
    return (Array.isArray(models) ? models : []).map(model => {
        const stored = saved?.[model.file];
        const record = stored && families[stored.family]?.presets?.[stored.preset] ? { family: stored.family, preset: stored.preset } : null;
        const state = record ? 'confirmed' : model.suggestion?.family ? 'suggested' : 'unknown';
        return { file: model.file, lists: model.lists ?? [], suggestion: model.suggestion, record, state };
    });
}

/**
 * The models the sheet offers: confirmed ones, grouped by family in the families' order.
 * @param {Record<string, {family: string, preset: string}|null>|undefined} saved This server's `models` leaf
 * @param {Record<string, FamilyInfo>} families
 * @returns {{family: FamilyInfo, models: {file: string, preset: string}[]}[]}
 */
export function confirmedByFamily(saved, families) {
    /** @type {{family: FamilyInfo, models: {file: string, preset: string}[]}[]} */
    const groups = [];
    for (const family of Object.values(families ?? {})) {
        const models = Object.entries(saved ?? {})
            .filter(([, record]) => record?.family === family.id && family.presets[record.preset])
            .map(([file, record]) => ({ file, preset: /** @type {{preset: string}} */ (record).preset }))
            .sort((a, b) => a.file.localeCompare(b.file, 'en', { sensitivity: 'base' }));
        if (models.length) groups.push({ family, models });
    }
    return groups;
}

/**
 * A family's pipelines, Plain first.
 * @param {import('./contract.js').Recipe[]} recipes
 * @param {string} family
 * @returns {import('./contract.js').Recipe[]}
 */
export function pipelinesFor(recipes, family) {
    const rank = (/** @type {import('./contract.js').Recipe} */ r) => {
        const at = PIPELINE_ORDER.indexOf(String(r.pipeline ?? ''));
        return at < 0 ? PIPELINE_ORDER.length : at;
    };
    return (Array.isArray(recipes) ? recipes : []).filter(r => r.family === family).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The model a family pipeline starts with: the last one drawn with on this server when it is of
 * that family and still set up, else the family's set-up models on its default preset first (Anima:
 * base, the owner's pick over aesthetic and turbo), by name. Null when the family has none.
 * @param {string|null|undefined} family
 * @param {Record<string, {family: string, preset: string}|null>|undefined} saved This server's `models` leaf
 * @param {{file?: string, preset?: string}|undefined} last This server's `lastModel`
 * @param {string} [defaultPreset] The family's default preset
 * @returns {{file: string, family: string, preset: string}|null}
 */
export function startingModel(family, saved, last, defaultPreset) {
    if (!family) return null;
    const record = last?.file ? saved?.[last.file] : null;
    if (record && record.family === family) return { file: /** @type {string} */ (last?.file), family, preset: last?.preset || record.preset };
    const rank = (/** @type {any} */ r) => (defaultPreset && r?.preset === defaultPreset ? 0 : 1);
    const first = Object.entries(saved ?? {})
        .filter(([, r]) => r?.family === family)
        .sort(([a, ra], [b, rb]) => rank(ra) - rank(rb) || a.localeCompare(b, 'en', { sensitivity: 'base' }))[0];
    return first ? { file: first[0], family, preset: /** @type {{preset: string}} */ (first[1]).preset } : null;
}

/**
 * @param {import('./contract.js').Recipe|null|undefined} recipe
 * @returns {string}
 */
export function pipelineLabel(recipe) {
    const kind = /** @type {keyof typeof PIPELINE_LABELS} */ (recipe?.pipeline ?? '');
    return PIPELINE_LABELS[kind] ?? recipe?.name ?? recipe?.id ?? '';
}

/**
 * Fills `{{char}}` in a label.
 * @param {string} label
 * @param {string} name
 * @returns {string}
 */
export function withName(label, name) {
    return label.replace('{{char}}', () => name || 'the character');
}
