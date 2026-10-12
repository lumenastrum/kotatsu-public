/**
 * Pictures v0 — the contract the three parallel slices build against (docs/pictures-v0.md §13).
 *
 * Pure data and typedefs: no DOM, no imports from core. Slice A (server) implements the HTTP
 * surface named here, slice B (sheet, pending tile, tile menu) consumes it through
 * `jobs-client.js`, slice C (writer, card look, settings, migration) owns the settings leaf and
 * the look. Anything two slices share is declared HERE first, never invented in one of them.
 */

/** Mount point of the server (slice A): `src/endpoints/kotatsu/pictures/` → `/api/kotatsu/pictures`. */
export const API_BASE = '/api/kotatsu/pictures';

/** `power_user.kotatsu_pictures` — one object leaf (docs/pictures-v0.md §9). Slice C owns it. */
export const SETTINGS_KEY = 'kotatsu_pictures';

/** Per-attachment provenance on a message: `extra.kotatsu_picture[media_index]` (§8). */
export const PICTURE_EXTRA_KEY = 'kotatsu_picture';

/** The card-portable look: `character.data.extensions.kotatsu.picture` (§4). Slice C owns it. */
export const CARD_LOOK_PATH = ['data', 'extensions', 'kotatsu', 'picture'];

/**
 * ABI event (CONTRACT.md:413), fired ONCE per job by the draw seam (`picture-actions.js`), right
 * before the request leaves, never by the writer (decision 2026-10-09 at the A/B/C merge). The
 * payload is mutable and carries stock's keys plus ours:
 * `{ prompt, negative, purpose, generationType, message, trigger }`; what listeners leave in
 * `prompt` / `negative` is what goes out.
 */
export const PROMPT_PROCESSING_EVENT = 'sd_prompt_processing';

/**
 * Stock's `generationMode` numbers, carried as `generationType` on the event so third-party
 * listeners that compared numbers keep working (the removed extension's enum, slice 0).
 * @type {Readonly<Record<string, number>>}
 */
export const STOCK_GENERATION_TYPES = Object.freeze({ char: 0, me: 1, moment: 4, free: 6, place: 7 });

/** @enum {string} */
export const PURPOSES = Object.freeze({
    MOMENT: 'moment',   // the visible content of the last (or a chosen) message
    CHAR: 'char',       // the character, from the look
    ME: 'me',           // the persona
    PLACE: 'place',     // surroundings, no people
    FREE: 'free',       // a typed prompt
});

/**
 * Portraits are one-shots, not story events (Andres, 2026-10-10): the writer drafts them from the
 * card or persona alone, never the chat, and the picture message stays out of the chat model's
 * context (`is_system`). Found live: a "Me" portrait set Willam on a village road, and the next
 * "The place" drew that road as where the story was.
 */
/** @type {ReadonlyArray<string>} */
export const PORTRAIT_PURPOSES = Object.freeze([PURPOSES.CHAR, PURPOSES.ME]);

/** @enum {string} */
export const LANES = Object.freeze({ COMFY: 'comfy', OPENAI: 'openai', GEMINI: 'gemini' });

/** @enum {string} */
export const TONGUES = Object.freeze({ TAGS: 'tags', PROSE: 'prose' });

/** @enum {string} What started a picture (one visibility switch replaces stock's four). */
export const INITIATORS = Object.freeze({ HAND: 'hand', COMMAND: 'command', TOOL: 'tool', INTERACTIVE: 'interactive' });

/** Size presets the sheet offers when a recipe lists none of its own. `WxH`. */
export const DEFAULT_SIZES = Object.freeze(['1024x1024', '832x1216', '1216x832', '768x1344', '1344x768']);

/**
 * Defaults for the settings leaf. Slice C writes these on first run and migrates from
 * `extension_settings.sd` where the doc says (§9). Slice B reads them through C's
 * `settings.js` (`getPicturesSettings()`), never from `power_user` directly.
 * @type {PicturesSettings}
 */
export const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    lane: LANES.COMFY,
    comfy: { url: 'http://127.0.0.1:8188', auth: '', previews: true },
    recipeByPurpose: {},          // purpose → recipe id; empty = the sheet asks
    slotChoices: {},              // serverKey → recipeId → slot → filename
    models: {},                   // serverKey → model file → { family, preset } (confirmed; null = not set up), §14
    lastModel: {},                // serverKey → { file, preset, pipeline } the sheet last drew with
    openai: { model: 'gpt-image-2.5-flare', quality: 'medium', size: '1024x1024' },
    gemini: { model: 'gemini-nano-banana-2.1', size: '1K', aspect: '1:1' },
    styles: [],                   // [{ name, positive, negative }]
    captionLine: false,           // show "[{{char}} sends a picture …]" under the tile (always written)
    rawPreview: false,            // the pending tile shows the lane's raw preview instead of Mikan-chan painting
    interactive: false,           // regex trigger on the user's own text (slice G)
    tool: false,                  // generate_picture function tool (slice G)
    lastSheet: { purpose: PURPOSES.MOMENT, recipe: '', size: '', seedPinned: false, useReference: false },
});

/** Server-sent events on `GET ${API_BASE}/jobs/:id/events`. */
export const JOB_EVENTS = Object.freeze({
    QUEUED: 'queued',       // { position }   prompts ahead of this one on the lane (0 = next); null = queue unreadable
    PROGRESS: 'progress',   // { value, max, node, nodeTitle? }
    PREVIEW: 'preview',     // { jpegBase64, mime }   (throttled ≤ 4/s; never stored; `mime` is image/png when ComfyUI previews in PNG)
    DONE: 'done',           // { images: [{ url, width, height }], seed, graphSha, lane, recipe } — key lanes: seed null, model in place of recipe
    ERROR: 'error',         // { message, nodeErrors? }
    CANCELLED: 'cancelled', // {}
});

/**
 * @typedef {object} RecipeBinding  A node input the server fills: `[nodeId, inputName]`; ids are
 * STRINGS (subgraph exports flatten to `"30:6"`), never parsed as numbers.
 */

/**
 * @typedef {object} Recipe
 * @property {string} id            File stem in `user/workflows/` (`<id>.json` graph, `<id>.recipe.json` sidecar)
 * @property {string} name
 * @property {string} tongue        `tags` | `prose`
 * @property {string[]} needs       Node class types the graph uses
 * @property {string[]} missing     Those absent on the last checked server (empty when fine)
 * @property {Record<string, [string, string]>} slots   Model slots: slotName → [nodeId, inputName]
 * @property {{prompt: [string,string]|null, negative: [string,string]|null, seed: [string,string]|null, width: [string,string]|null, height: [string,string]|null, reference: [string,string]|null}} bind
 * @property {string[]} outputs     Output node ids (SaveImage / PreviewImage)
 * @property {Record<string, string>} variants   e.g. `{ hires: 'krea2-turbo-hires' }`
 * @property {string[]} sizes       `WxH` presets; empty = DEFAULT_SIZES
 * @property {boolean} shipped      Came from `default/content/pictures/`
 * @property {Record<string, Record<string, string>>} choices   Saved slot choices: serverKey → slotName → filename
 *   (written by `POST /recipes/:id/slots`; serverKey = see SERVER_KEY_RULE)
 * @property {string} [negative]  The model's own default negative; the sheet starts its negative box with it
 * @property {string|null} [family]  The model family it is a pipeline for (`anima`, `krea2`, `sdxl`); null = an own workflow
 * @property {'plain'|'bigger'|'sprite'|null} [pipeline]  What kind of pipeline (§14.2)
 */

/**
 * How a ComfyUI address becomes the key of `Recipe.choices` and `slotChoices`: the URL's origin plus
 * its path without trailing slashes, query and hash dropped (`http://127.0.0.1:8188/` →
 * `http://127.0.0.1:8188`). The server normalizes whatever it is sent; clients that key their own
 * maps should apply the same rule.
 */
export const SERVER_KEY_RULE = 'origin + path, no trailing slash';

/**
 * @typedef {object} PictureRequest   `POST ${API_BASE}/jobs`
 * @property {string} lane
 * @property {string} [recipe]        comfy lane
 * @property {string} prompt
 * @property {string} [negative]
 * @property {number} [seed]          absent = server picks and returns it
 * @property {number} width
 * @property {number} height
 * @property {string} [reference]     a `user/images/...` or `/characters/...` url the server uploads to the lane
 * @property {string} purpose
 * @property {string} character       folder under `user/images/` the result is saved into
 * @property {string} [model]         key lanes: the provider model; comfy lane: the model file picked for a family pipeline (§14)
 * @property {string} [family]        comfy lane: the picked model's family
 * @property {string} [preset]        comfy lane: the family preset the model draws with
 * @property {string} [quality]       openai
 * @property {string} [size]          openai `WxH`|`auto`; gemini `1K`|`2K`|`4K`
 * @property {string} [aspect]        gemini `W:H`
 * @property {boolean} [transparent]  sprites
 * @property {{file: string, strength: number}[]} [loras]   comfy lane: chained after the model loader, in order
 * @property {{url: string, auth?: string}} [comfy]   comfy lane: the server to draw on (the client sends
 *   its `comfy` settings); absent = the saved `power_user.kotatsu_pictures.comfy`, then the default address
 */

/**
 * @typedef {object} PictureProvenance   `extra.kotatsu_picture[media_index]`
 * @property {string} lane
 * @property {string} [recipe]
 * @property {string} [graphSha]
 * @property {number} seed
 * @property {string} size            `WxH`
 * @property {string} prompt          the final substituted prompt
 * @property {string} negative
 * @property {string} purpose
 * @property {string} [reference]
 * @property {string} [model]
 * @property {string} [quality]       openai
 * @property {string} [aspect]        gemini `W:H`
 * @property {string} [resolution]    gemini `1K`|`2K`|`4K` (`size` holds the drawn `WxH`)
 * @property {{file: string, strength: number}[]} [loras]   comfy lane
 * @property {string} [family]        comfy lane: family of `model` (§14)
 * @property {string} [preset]        comfy lane: the preset it drew with
 */

/**
 * @typedef {object} CardLook   `character.data.extensions.kotatsu.picture`
 * @property {string} positive
 * @property {string} negative
 * @property {string} [tongue]
 * @property {string} [reference]   a `/characters/<avatar>` or `user/images/...` url
 * @property {LoraChoice[]} [loras]  the character's LoRAs (ComfyUI lane), with their trigger words
 */

/**
 * @typedef {object} LoraChoice   one LoRA on a card or in the sheet's stack
 * @property {string} file        as ComfyUI lists it
 * @property {number} strength    −10..10, 1 = as trained
 * @property {string} trigger     words the prompt carries while it is on ('' = none)
 */

/**
 * @typedef {object} PicturesSettings
 * @property {number} version
 * @property {string} lane
 * @property {{url: string, auth: string, previews: boolean}} comfy
 * @property {Record<string, string>} recipeByPurpose
 * @property {Record<string, Record<string, Record<string, string>>>} slotChoices
 * @property {Record<string, Record<string, {family: string, preset: string}|null>>} models   confirmed models per server (§14)
 * @property {Record<string, {file: string, preset: string, pipeline: string}>} lastModel   the sheet's last pick per server
 * @property {{model: string, quality: string, size: string}} openai
 * @property {{model: string, size: string, aspect: string}} gemini
 * @property {{name: string, positive: string, negative: string}[]} styles
 * @property {boolean} captionLine
 * @property {boolean} rawPreview
 * @property {boolean} interactive
 * @property {boolean} tool
 * @property {{purpose: string, recipe: string, size: string, seedPinned: boolean, useReference: boolean}} lastSheet
 */

/**
 * The writer's door (slice C exports it from `writer.js`; slice B calls it from the sheet).
 * @typedef {(args: {purpose: string, tongue: string, messageIndex?: number, free?: string, look?: CardLook|null, style?: {positive: string, negative: string}|null}) => Promise<{prompt: string, negative: string}>} DraftFn
 */

export {};
