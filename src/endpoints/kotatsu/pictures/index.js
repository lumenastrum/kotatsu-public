import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import express from 'express';

import { serverDirectory } from '../../../server-directory.js';
import { ComfyError, createClientPool, describeServer, nodeOptions, normalizeServerUrl } from './comfy.js';
import { readLoraInfo } from './loras.js';
import { COMFY_INSTALL, FAMILIES, FILE_SOURCES, familyNeeds, publicFamilies, suggestModel } from './families.js';
import { JOB_EVENTS, createJobManager } from './jobs.js';
import {
    RecipeError,
    SLOT_LISTS,
    MAX_LORAS,
    deleteRecipe,
    fillRecipe,
    importRecipe,
    isValidRecipeId,
    listRecipes,
    readRecipe,
    refreshShippedRecipes,
    saveSlotChoices,
} from './recipes.js';
import { characterFolder } from './store.js';
import { drawOpenAI } from './openai.js';
import { drawGemini } from './gemini.js';

/**
 * `/api/kotatsu/pictures/*` — Pictures v0 (docs/pictures-v0.md §13.2). The ComfyUI lane (slice A)
 * and the key lanes, OpenAI and Gemini (slice E, §6), behind the same job interface.
 *
 * Errors are `{ error: { message, code?, slots?, nodeErrors? } }` with a 4xx/5xx status, except
 * `/check`, whose failure is an answer (`{ ok: false, message }`).
 */

/** `DEFAULT_SETTINGS.comfy.url` in public/kotatsu/pictures/contract.js. */
const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
const KEY_LANES = new Set(['openai', 'gemini']);
const MODEL_ID = /^[\w.:-]{1,80}$/;
const OPENAI_QUALITIES = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
const OPENAI_SIZE = /^(auto|\d{3,4}x\d{3,4})$/;
const GEMINI_SIZE = /^(1K|2K|4K|512px)$/;
const ASPECT = /^\d{1,2}:\d{1,2}$/;
const SEED_LIMIT = 2 ** 48;
const MIN_SIDE = 64;
const MAX_SIDE = 8192;
const REFERENCE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' });
const TERMINAL_EVENTS = new Set([JOB_EVENTS.DONE, JOB_EVENTS.ERROR, JOB_EVENTS.CANCELLED]);

/**
 * @param {import('express').Response} response Response
 * @param {number} status HTTP status
 * @param {string} message Message
 * @param {object} [extra] Extra error fields
 */
function sendError(response, status, message, extra = {}) {
    response.status(status).json({ error: { message, ...extra } });
}

/**
 * Wraps a handler: RecipeError → 400, ComfyError → its status, anything else → 500.
 * @param {(request: import('express').Request, response: import('express').Response) => Promise<any>|any} handler Route handler
 * @returns {import('express').RequestHandler} Express handler
 */
function handle(handler) {
    return async (request, response) => {
        try {
            await handler(request, response);
        } catch (error) {
            if (response.headersSent) {
                console.error('[Pictures]', error);
                return;
            }
            if (error instanceof RecipeError) {
                return sendError(response, 400, error.message, { code: error.code, ...(error.slots ? { slots: error.slots } : {}) });
            }
            if (error instanceof ComfyError) {
                return sendError(response, error.status, error.message, error.nodeErrors ? { nodeErrors: error.nodeErrors } : {});
            }
            console.error('[Pictures]', error);
            return sendError(response, 500, error instanceof Error ? error.message : String(error));
        }
    };
}

/**
 * @param {import('express').Request} request Request
 * @returns {import('../../../users.js').UserDirectoryList} The user's directories
 */
function directoriesOf(request) {
    return /** @type {any} */ (request).user.directories;
}

/**
 * @param {import('express').Request} request Request
 * @returns {string} The user's handle
 */
function handleOf(request) {
    return String(/** @type {any} */ (request).user?.profile?.handle ?? 'default-user');
}

/**
 * Pipelines the product doesn't offer yet. A recipe with one stays on disk, seeded and refreshed
 * like any shipped recipe, and still draws when a job names it; it just isn't listed, so neither
 * the sheet nor Settings shows it, and the setup guide doesn't ask for its files. `sprite` waits for
 * Sprite mode (docs/handoffs/pictures-slice-f.md): take it out of here when that ships.
 * @type {ReadonlySet<string>}
 */
export const HIDDEN_PIPELINES = new Set(['sprite']);

/**
 * Ids of the recipes Kotatsu ships (content index entries of type `picture_recipe`).
 * @returns {Set<string>} Recipe ids
 */
export function readShippedIds() {
    try {
        const index = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default/content/index.json'), 'utf8'));
        return new Set(index
            .filter((/** @type {any} */ item) => item?.type === 'picture_recipe' && typeof item.filename === 'string' && !item.filename.endsWith('.recipe.json'))
            .map((/** @type {any} */ item) => path.basename(item.filename, '.json')));
    } catch {
        return new Set();
    }
}

/**
 * A stored API key (`SECRET_KEYS.OPENAI` / `.MAKERSUITE` in secrets.js), the active one when the
 * user keeps several. secrets.js reads the server config as it loads, so it is imported on first
 * use, not at the top (the router's tests run without a config).
 * @param {import('../../../users.js').UserDirectoryList} directories User directories
 * @param {string} key Secret key name
 * @returns {Promise<string|undefined>} The key, or undefined
 */
async function readStoredKey(directories, key) {
    const { readSecret } = await import('../../secrets.js');
    return readSecret(directories, key) || undefined;
}

/**
 * The saved `power_user.kotatsu_pictures.comfy` leaf (slice C writes it), read from disk.
 * @param {import('../../../users.js').UserDirectoryList} directories User directories
 * @returns {{url?: string, auth?: string}|null} The leaf, or null
 */
export function readSavedComfySettings(directories) {
    try {
        const settings = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
        const comfy = settings?.power_user?.kotatsu_pictures?.comfy;
        return comfy && typeof comfy === 'object' ? comfy : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} parent Directory
 * @param {string} child Path
 * @returns {boolean} True when child is inside parent
 */
function isInside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolves a reference url (`user/images/...` or `/characters/...`, as `PictureRequest.reference`
 * allows) to a file of this user.
 * @param {import('../../../users.js').UserDirectoryList} directories User directories
 * @param {unknown} reference Url from the request
 * @returns {{file: string, ext: string}} The file and its extension
 */
export function resolveReference(directories, reference) {
    if (typeof reference !== 'string' || !reference.trim()) throw new RecipeError('reference must be an image url');
    let relative = reference.trim().split(/[?#]/)[0].replace(/^\/+/, '');
    try {
        relative = decodeURIComponent(relative);
    } catch {
        throw new RecipeError('reference is not a valid url');
    }
    let file;
    if (relative.startsWith('user/images/')) file = path.join(directories.userImages, relative.slice('user/images/'.length));
    else if (relative.startsWith('characters/')) file = path.join(directories.characters, relative.slice('characters/'.length));
    else throw new RecipeError('reference must be a user/images/… or /characters/… url');
    const root = relative.startsWith('user/images/') ? directories.userImages : directories.characters;
    if (!isInside(root, file)) throw new RecipeError('reference points outside the image folders');
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!Object.hasOwn(REFERENCE_TYPES, ext)) throw new RecipeError('reference must be a PNG, JPEG or WebP image');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new RecipeError('The reference image does not exist', { code: 'reference_missing' });
    return { file, ext };
}

/**
 * @param {unknown} value Candidate side
 * @param {string} name Field name
 * @returns {number|undefined} The side, undefined when absent
 */
function readSide(value, name) {
    if (value === undefined || value === null) return undefined;
    if (!Number.isInteger(value) || /** @type {number} */ (value) < MIN_SIDE || /** @type {number} */ (value) > MAX_SIDE) {
        throw new RecipeError(`${name} must be a whole number of pixels between ${MIN_SIDE} and ${MAX_SIDE}`);
    }
    return /** @type {number} */ (value);
}

/**
 * The request's LoRAs, checked: at most MAX_LORAS of `{file, strength}`. Whether the file is on
 * the server is ComfyUI's call (its "value not in list" comes back as node errors).
 * @param {unknown} value `body.loras`
 * @returns {{file: string, strength: number}[]} The LoRAs, in order
 */
export function readLoras(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new RecipeError('loras must be a list');
    if (value.length > MAX_LORAS) throw new RecipeError(`At most ${MAX_LORAS} LoRAs on one picture`);
    return value.map((/** @type {any} */ lora) => {
        const file = typeof lora?.file === 'string' ? lora.file.trim() : '';
        if (!file || file.length > 255 || /(^|[\\/])\.\.([\\/]|$)/.test(file)) throw new RecipeError('Each LoRA needs a file name');
        const strength = lora.strength === undefined ? 1 : Number(lora.strength);
        if (!Number.isFinite(strength) || strength < -10 || strength > 10) throw new RecipeError(`The strength of ${file} must be a number between -10 and 10`);
        return { file, strength };
    });
}

/**
 * The model a request picks for a family pipeline (§14): `{model, family?, preset?, steps?, cfg?}`
 * on the body. Null when the recipe is not a family pipeline or no model was picked (it draws
 * with its slot choice, as before). A model from another family, or a preset the family does not
 * have, is a 400 in words.
 * @param {any} body Request body
 * @param {{family?: string|null, slots: Record<string, [string, string]>}} recipe The recipe
 * @returns {{file: string, slot: string, preset: import('./families.js').Preset, overrides: {steps?: number, cfg?: number}}|null}
 */
export function readModelPick(body, recipe) {
    const family = recipe.family ? FAMILIES[recipe.family] : undefined;
    if (!family || body.model === undefined || body.model === null || body.model === '') return null;
    if (typeof body.model !== 'string' || body.model.length > 255 || /(^|[\\/])\.\.([\\/]|$)/.test(body.model)) throw new RecipeError('model must be a file name');
    if (body.family !== undefined && body.family !== family.id) {
        const named = FAMILIES[body.family]?.name ?? body.family;
        throw new RecipeError(`This pipeline draws ${family.name} models; ${body.model} is set up as ${named}`, { code: 'family_mismatch' });
    }
    const presetId = body.preset ?? family.defaultPreset;
    const preset = family.presets[presetId];
    if (!preset) throw new RecipeError(`${family.name} has no preset "${presetId}"`);
    const slot = family.loader === 'checkpoint' ? 'checkpoint' : 'unet';
    if (!recipe.slots[slot]) throw new RecipeError(`This pipeline has no ${slot} slot for a model`);
    /** @type {{steps?: number, cfg?: number}} */
    const overrides = {};
    if (body.steps !== undefined) {
        if (!Number.isInteger(body.steps) || body.steps < 1 || body.steps > 200) throw new RecipeError('steps must be a whole number from 1 to 200');
        overrides.steps = body.steps;
    }
    if (body.cfg !== undefined) {
        if (!Number.isFinite(body.cfg) || body.cfg <= 0 || body.cfg > 30) throw new RecipeError('cfg must be a number above 0, up to 30');
        overrides.cfg = body.cfg;
    }
    return { file: body.model, slot, preset, overrides };
}

/**
 * Builds the router. A factory so tests can hand it a job manager, a client pool and a
 * settings reader.
 * @param {object} [options] Overrides
 * @param {ReturnType<typeof createJobManager>} [options.jobs] Job manager
 * @param {ReturnType<typeof createClientPool>} [options.clients] ComfyUI client pool
 * @param {() => Set<string>} [options.shippedIds] Ids of shipped recipes
 * @param {string} [options.shippedDir] Where the shipped recipes live (`default/content/pictures`)
 * @param {ReadonlySet<string>} [options.hiddenPipelines] Pipelines left out of listings (`HIDDEN_PIPELINES`)
 * @param {(directories: any) => {url?: string, auth?: string}|null} [options.savedComfy] Saved comfy settings
 * @param {() => number} [options.random] Random source for seeds
 * @param {number} [options.pingMs] SSE comment ping interval
 * @param {(directories: any, key: string) => Promise<string|undefined>|string|undefined} [options.readKey] Reads a stored API key
 * @param {typeof fetch} [options.fetchImpl] Fetch for the key lanes
 * @param {{openai?: string, gemini?: string}} [options.bases] Key-lane API bases (tests point them at a fake)
 * @returns {import('express').Router} The router
 */
export function createPicturesRouter({
    jobs = createJobManager(),
    clients = createClientPool(),
    shippedIds = readShippedIds,
    shippedDir = path.join(serverDirectory, 'default/content/pictures'),
    hiddenPipelines = HIDDEN_PIPELINES,
    savedComfy = readSavedComfySettings,
    random = Math.random,
    pingMs = 15_000,
    readKey = readStoredKey,
    fetchImpl = fetch,
    bases = {},
} = {}) {
    const router = express.Router();
    /** @type {Map<string, Set<string>>} user handle → class types of the server they last checked */
    const classTypesByUser = new Map();
    /** @type {Map<string, Record<string, string[]>>} server key → model lists from its last check */
    const modelsByServer = new Map();
    /** @type {Map<string, Map<string, ReturnType<typeof readLoraInfo>>>} server key → LoRA file → what its header says */
    const loraInfoByServer = new Map();
    /** @type {Map<string, Map<string, ReturnType<typeof suggestModel>>>} server key → model file → suggestion */
    const modelInfoByServer = new Map();

    const recipeContext = (/** @type {import('express').Request} */ request) => ({
        shipped: shippedIds(),
        nodeTypes: classTypesByUser.get(handleOf(request)) ?? null,
    });

    /** @type {Set<string>} workflow folders brought up to the shipped recipe revisions in this process */
    const refreshedDirs = new Set();
    router.use((request, _response, next) => {
        const dir = /** @type {any} */ (request).user?.directories?.comfyWorkflows;
        if (typeof dir === 'string' && !refreshedDirs.has(dir)) {
            refreshedDirs.add(dir);
            try {
                const ids = refreshShippedRecipes(dir, shippedDir, shippedIds());
                if (ids.length) console.info(`Pictures: shipped recipes refreshed (${ids.join(', ')})`);
            } catch (error) {
                console.warn('Pictures: could not refresh the shipped recipes', error);
            }
        }
        next();
    });

    router.post('/check', handle(async (request, response) => {
        const { url, auth } = request.body ?? {};
        let server;
        try {
            server = normalizeServerUrl(url);
        } catch (error) {
            return response.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
        try {
            const { reply, classTypes, models } = await describeServer(clients.get(server, typeof auth === 'string' ? auth : ''));
            classTypesByUser.set(handleOf(request), classTypes);
            modelsByServer.set(server, models);
            return response.json(reply);
        } catch (error) {
            return response.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
    }));

    /**
     * The LoRAs a ComfyUI has, with what the picker shows for each (base model, trigger words),
     * read from each file's header. `{url?, auth?}` like `/check` (absent = the saved server).
     * Headers are cached per server and file: they do not change under the same name.
     */
    /**
     * The model files a ComfyUI has (§14.5), with what Kotatsu suggests each one is, and the
     * families it knows. `{url?, auth?}` like `/check`. A file listed by both loaders (one folder
     * mapped twice, measured on the owner's box) is one row with both lists.
     */
    router.post('/models', handle(async (request, response) => {
        const body = request.body ?? {};
        const saved = savedComfy(directoriesOf(request));
        let server;
        try {
            server = normalizeServerUrl(body.url || saved?.url || DEFAULT_COMFY_URL);
        } catch (error) {
            return response.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
        const auth = typeof body.auth === 'string' ? body.auth : (typeof saved?.auth === 'string' ? saved.auth : '');
        const client = clients.get(server, auth);
        try {
            const [unetInfo, ckptInfo] = await Promise.all([
                client.request('/object_info/UNETLoader'),
                client.request('/object_info/CheckpointLoaderSimple'),
            ]);
            /** @type {Map<string, Set<string>>} */
            const lists = new Map();
            for (const [list, files] of /** @type {[string, string[]][]} */ ([['unet', nodeOptions(unetInfo, 'UNETLoader', 'unet_name')], ['checkpoints', nodeOptions(ckptInfo, 'CheckpointLoaderSimple', 'ckpt_name')]])) {
                for (const file of files) lists.set(file, (lists.get(file) ?? new Set()).add(list));
            }
            const cache = modelInfoByServer.get(server) ?? new Map();
            modelInfoByServer.set(server, cache);
            const files = [...lists.keys()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
            for (let i = 0; i < files.length; i += 6) {
                await Promise.all(files.slice(i, i + 6).map(async file => {
                    if (cache.has(file)) return;
                    const folder = lists.get(file)?.has('unet') ? 'diffusion_models' : 'checkpoints';
                    const metadata = await client.viewMetadata(folder, file).catch(() => null);
                    cache.set(file, suggestModel(file, metadata));
                }));
            }
            const models = files.map(file => ({ file, lists: [...(lists.get(file) ?? [])].sort(), suggestion: cache.get(file) }));
            // What each family still needs on this server, with where to get it (§14.6).
            const [clipInfo, vaeInfo, upInfo, rmInfo] = await Promise.all([
                client.request('/object_info/CLIPLoader').catch(() => ({})),
                client.request('/object_info/VAELoader').catch(() => ({})),
                client.request('/object_info/UpscaleModelLoader').catch(() => ({})),
                client.request('/object_info/LoadBackgroundRemovalModel').catch(() => ({})),
            ]);
            const fileLists = {
                unet: nodeOptions(unetInfo, 'UNETLoader', 'unet_name'),
                checkpoints: nodeOptions(ckptInfo, 'CheckpointLoaderSimple', 'ckpt_name'),
                clip: nodeOptions(clipInfo, 'CLIPLoader', 'clip_name'),
                vae: nodeOptions(vaeInfo, 'VAELoader', 'vae_name'),
                upscalers: nodeOptions(upInfo, 'UpscaleModelLoader', 'model_name'),
                removers: nodeOptions(rmInfo, 'LoadBackgroundRemovalModel', 'bg_removal_name'),
            };
            /** @type {Record<string, ReturnType<typeof familyNeeds>>} */
            const setup = {};
            for (const family of Object.values(FAMILIES)) {
                const hasModel = models.some(m => m.suggestion?.family === family.id);
                setup[family.id] = familyNeeds(family, fileLists, hasModel);
            }
            const extras = [
                { role: 'upscaler, for the Bigger pipelines', file: 'RealESRGAN_x4plus_anime_6B.pth', list: 'upscalers', pipeline: 'bigger' },
                { role: 'background remover, for Sprite', file: 'birefnet.safetensors', list: 'removers', pipeline: 'sprite' },
            ].filter(extra => !hiddenPipelines.has(extra.pipeline)).map(({ role, file, list }) => ({
                role,
                file,
                present: /** @type {string[]} */ (fileLists[/** @type {keyof typeof fileLists} */ (list)]).length > 0,
                source: FILE_SOURCES[file] ?? null,
            }));
            return response.json({ ok: true, server, families: publicFamilies(), models, setup, extras, install: COMFY_INSTALL });
        } catch (error) {
            return response.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
    }));

    router.post('/loras', handle(async (request, response) => {
        const body = request.body ?? {};
        const saved = savedComfy(directoriesOf(request));
        let server;
        try {
            server = normalizeServerUrl(body.url || saved?.url || DEFAULT_COMFY_URL);
        } catch (error) {
            return response.status(400).json({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
        const auth = typeof body.auth === 'string' ? body.auth : (typeof saved?.auth === 'string' ? saved.auth : '');
        const client = clients.get(server, auth);
        try {
            const objectInfo = await client.request('/object_info/LoraLoader');
            const files = nodeOptions(objectInfo, 'LoraLoader', 'lora_name');
            const cache = loraInfoByServer.get(server) ?? new Map();
            loraInfoByServer.set(server, cache);
            const loras = [];
            // A few at a time: ComfyUI reads each header from disk.
            for (let i = 0; i < files.length; i += 6) {
                const batch = await Promise.all(files.slice(i, i + 6).map(async file => {
                    if (!cache.has(file)) {
                        const metadata = await client.viewMetadata('loras', file).catch(() => null);
                        cache.set(file, readLoraInfo(file, metadata));
                    }
                    return cache.get(file);
                }));
                loras.push(...batch);
            }
            return response.json({ ok: true, server, loras });
        } catch (error) {
            return response.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
    }));

    router.get('/recipes', handle(async (request, response) => {
        const { recipes, skipped } = listRecipes(directoriesOf(request).comfyWorkflows, recipeContext(request));
        return response.json({ recipes: recipes.filter(recipe => !recipe.pipeline || !hiddenPipelines.has(recipe.pipeline)), skipped });
    }));

    router.post('/recipes/import', handle(async (request, response) => {
        const { name, graph } = request.body ?? {};
        const recipe = importRecipe(directoriesOf(request).comfyWorkflows, { name, graph });
        const context = recipeContext(request);
        recipe.missing = context.nodeTypes ? recipe.needs.filter(type => !context.nodeTypes.has(type)) : [];
        return response.json(recipe);
    }));

    router.post('/recipes/:id/slots', handle(async (request, response) => {
        const { server, choices } = request.body ?? {};
        const key = normalizeServerUrl(server);
        const recipe = saveSlotChoices(directoriesOf(request).comfyWorkflows, request.params.id, key, choices, recipeContext(request));
        if (!recipe) return sendError(response, 404, `No recipe "${request.params.id}"`);
        return response.json(recipe);
    }));

    router.delete('/recipes/:id', handle(async (request, response) => {
        const id = request.params.id;
        if (!isValidRecipeId(id)) return sendError(response, 404, `No recipe "${id}"`);
        if (shippedIds().has(id)) return sendError(response, 409, 'Shipped recipes cannot be deleted');
        if (!deleteRecipe(directoriesOf(request).comfyWorkflows, id)) return sendError(response, 404, `No recipe "${id}"`);
        return response.sendStatus(204);
    }));

    /**
     * A job on a key lane (§6): the key from the user's secrets, the reference read here, one
     * provider call in the job manager. Validates what the lane reads; the rest is ignored
     * (no recipe, no seed, no negative on these lanes).
     * @param {import('express').Request} request Request
     * @param {import('express').Response} response Response
     * @param {string} lane `openai` | `gemini`
     * @param {any} body Request body
     * @param {string} character Character folder
     */
    const startKeyJob = async (request, response, lane, body, character) => {
        const openai = lane === 'openai';
        const name = openai ? 'OpenAI' : 'Gemini';
        if (typeof body.model !== 'string' || !MODEL_ID.test(body.model)) throw new RecipeError(`model is required for the ${name} lane`);
        if (openai) {
            if (body.quality !== undefined && !OPENAI_QUALITIES.has(body.quality)) throw new RecipeError(`quality must be one of ${[...OPENAI_QUALITIES].join(', ')}`);
            if (body.size !== undefined && !OPENAI_SIZE.test(body.size)) throw new RecipeError('size must be WIDTHxHEIGHT or auto');
        } else {
            if (body.size !== undefined && !GEMINI_SIZE.test(body.size)) throw new RecipeError('size must be 1K, 2K, 4K or 512px');
            if (body.aspect !== undefined && !ASPECT.test(body.aspect)) throw new RecipeError('aspect must look like 3:4');
        }
        const directories = directoriesOf(request);
        const key = await readKey(directories, openai ? 'api_key_openai' : 'api_key_makersuite');
        if (!key) {
            return sendError(response, 400, openai
                ? 'Add an OpenAI key under Connection first.'
                : 'Add a Google AI Studio key under Connection first.', { code: 'key_missing' });
        }
        let reference = null;
        if (body.reference) {
            const { file, ext } = resolveReference(directories, body.reference);
            reference = { bytes: fs.readFileSync(file), ext, mime: REFERENCE_TYPES[/** @type {keyof typeof REFERENCE_TYPES} */ (ext)] };
        }
        /** @type {import('./openai.js').LaneJob} */
        const laneJob = {
            prompt: body.prompt.trim(),
            model: body.model,
            ...(typeof body.size === 'string' ? { size: body.size } : {}),
            ...(openai && typeof body.quality === 'string' ? { quality: body.quality } : {}),
            ...(!openai && typeof body.aspect === 'string' ? { aspect: body.aspect } : {}),
            transparent: openai && body.transparent === true,
            reference,
        };
        // What was asked, with the reference as its hash: provenance can tell two jobs apart.
        const requestSha = createHash('sha256').update(JSON.stringify({
            lane,
            ...laneJob,
            reference: reference ? createHash('sha256').update(reference.bytes).digest('hex') : null,
        })).digest('hex');
        const job = jobs.start({
            lane,
            model: body.model,
            requestSha,
            run: signal => (openai
                ? drawOpenAI({ key, job: laneJob, signal, fetchImpl, base: bases.openai })
                : drawGemini({ key, job: laneJob, signal, fetchImpl, base: bases.gemini })),
            purpose: body.purpose,
            character,
            userImages: directories.userImages,
            owner: handleOf(request),
        });
        return response.status(202).json({ jobId: job.id, seed: null });
    };

    router.post('/jobs', handle(async (request, response) => {
        const body = request.body ?? {};
        const lane = body.lane ?? 'comfy';
        if (lane !== 'comfy' && !KEY_LANES.has(lane)) return sendError(response, 400, `Unknown lane "${lane}"`);
        if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new RecipeError('prompt is required');
        if (body.negative !== undefined && typeof body.negative !== 'string') throw new RecipeError('negative must be text');
        if (typeof body.purpose !== 'string' || !body.purpose) throw new RecipeError('purpose is required');
        const character = characterFolder(body.character);
        if (!character) throw new RecipeError('character must name a folder under user/images');
        if (KEY_LANES.has(lane)) return startKeyJob(request, response, lane, body, character);
        const width = readSide(body.width, 'width');
        const height = readSide(body.height, 'height');
        let seed = body.seed;
        if (seed === undefined || seed === null) seed = Math.floor(random() * SEED_LIMIT);
        else if (!Number.isSafeInteger(seed) || seed < 0) throw new RecipeError('seed must be a whole number of at least 0');

        const directories = directoriesOf(request);
        if (!isValidRecipeId(body.recipe)) throw new RecipeError('recipe is required for the ComfyUI lane');
        const entry = readRecipe(directories.comfyWorkflows, body.recipe, recipeContext(request));
        if (!entry) return sendError(response, 404, `No recipe "${body.recipe}"`);
        const { recipe, graph } = entry;

        const saved = savedComfy(directories);
        const comfy = body.comfy && typeof body.comfy === 'object' ? body.comfy : {};
        const server = normalizeServerUrl(comfy.url || saved?.url || DEFAULT_COMFY_URL);
        const auth = typeof comfy.auth === 'string' ? comfy.auth : (typeof saved?.auth === 'string' ? saved.auth : '');

        // Slot choices: what the user saved for this server; else the recipe's hint, when that
        // exact file is in the server's last-checked list and the graph names no model.
        const choices = { ...(recipe.choices[server] ?? {}) };
        // A family pipeline (§14) draws the model picked in the sheet, with that model's preset.
        const picked = readModelPick(body, recipe);
        if (picked) choices[picked.slot] = picked.file;
        let models = modelsByServer.get(server);
        const wantsHint = Object.entries(recipe.slots).some(([slot, binding]) =>
            !choices[slot] && /** @type {any} */ (recipe).hints?.[slot] && !(/** @type {any} */ (graph)[binding[0]]?.inputs?.[binding[1]]));
        if (!models && wantsHint) {
            // A fresh process has never looked at this server: look once now, so a shipped recipe
            // draws with no setup on a server that has its files (found live 2026-10-09: without
            // this, the first Draw after a restart was a 400 until someone pressed Check).
            try {
                const { classTypes, models: found } = await describeServer(clients.get(server, auth));
                classTypesByUser.set(handleOf(request), classTypes);
                modelsByServer.set(server, found);
                models = found;
            } catch (error) {
                throw new RecipeError(`ComfyUI at ${server} did not answer: ${error instanceof Error ? error.message : String(error)}`, { code: 'server_unreachable' });
            }
        }
        for (const [slot, binding] of Object.entries(recipe.slots)) {
            const hint = /** @type {any} */ (recipe).hints?.[slot];
            const current = /** @type {any} */ (graph)[binding[0]]?.inputs?.[binding[1]];
            const list = models?.[/** @type {keyof typeof SLOT_LISTS} */ (SLOT_LISTS[binding[1]])];
            if (!choices[slot] && hint && !current && Array.isArray(list) && list.includes(hint)) choices[slot] = hint;
        }

        let reference = null;
        let referenceValue = null;
        if (body.reference && recipe.bind.reference) {
            const { file, ext } = resolveReference(directories, body.reference);
            const bytes = fs.readFileSync(file);
            // Content-addressed: the same picture is the same input file, so ComfyUI's cache holds.
            const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${ext}`;
            reference = { bytes, name, subfolder: 'kotatsu', mime: REFERENCE_TYPES[/** @type {keyof typeof REFERENCE_TYPES} */ (ext)] };
            referenceValue = `kotatsu/${name}`;
        }

        const filled = fillRecipe(graph, recipe, {
            prompt: body.prompt,
            negative: body.negative ?? '',
            seed,
            width,
            height,
            reference: referenceValue,
            choices,
            loras: readLoras(body.loras),
            preset: picked ? { ...picked.preset, overrides: picked.overrides } : undefined,
        });

        const job = jobs.create({
            client: clients.get(server, auth),
            graph: filled.graph,
            graphSha: filled.graphSha,
            seed,
            recipe: recipe.id,
            purpose: body.purpose,
            character,
            userImages: directories.userImages,
            owner: handleOf(request),
            outputsOrder: recipe.outputs,
            reference,
        });
        return response.status(202).json({ jobId: job.id, seed });
    }));

    /**
     * A job of the requesting user (another user's job is "no such job").
     * @param {import('express').Request} request Request
     * @returns {any} The job, or undefined
     */
    const ownJob = (request) => {
        const job = jobs.get(request.params.id);
        return job && job.owner === handleOf(request) ? job : undefined;
    };

    router.get('/jobs', handle(async (request, response) => {
        return response.json({ jobs: jobs.list(handleOf(request)) });
    }));

    router.get('/jobs/:id/events', (request, response) => {
        const job = ownJob(request);
        if (!job) return sendError(response, 404, 'No such job (finished jobs are kept for an hour)');

        response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            // no-transform also keeps the compression middleware from buffering the stream.
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const write = (/** @type {string} */ chunk) => {
            if (response.writableEnded || response.destroyed) return;
            response.write(chunk);
            /** @type {any} */ (response).flush?.();
        };
        write(': connected\n\n');

        let ended = false;
        /** @type {(() => void)|null} */
        let unsubscribe = null;
        const ping = setInterval(() => write(': ping\n\n'), pingMs);
        ping.unref?.();
        const end = () => {
            if (ended) return;
            ended = true;
            clearInterval(ping);
            unsubscribe?.();
            if (!response.writableEnded) response.end();
        };
        // The client going away ends the stream, never the job (POST /jobs/:id/cancel does that).
        // (`response` 'close', not `request`: a GET's request stream closes as soon as it is read.)
        response.on('close', end);
        unsubscribe = jobs.subscribe(job.id, (event, data) => {
            write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            if (TERMINAL_EVENTS.has(event)) end();
        });
        if (ended) unsubscribe?.();
    });

    router.post('/jobs/:id/cancel', handle(async (request, response) => {
        if (!ownJob(request) || !jobs.cancel(request.params.id)) return sendError(response, 404, 'No such job');
        return response.sendStatus(204);
    }));

    return router;
}

export const router = createPicturesRouter();
