/**
 * Pictures v0, slice B — what happens when someone asks for a picture (docs/pictures-v0.md §2.3,
 * §3.2, §8, §13.3).
 *
 * - `openPictureSheet()` puts the sheet up (paintbrush, wand item, `/imagine`, Edit prompt).
 * - `drawPicture()` runs one job: a pending row at the end of `#chat`, the job's events into it,
 *   and on `done` the row leaves and the picture lands, either as a new message
 *   (`appendPictureMessage()`) or as new candidates on the message a re-roll came from.
 * - `rerollPicture()` / `deletePicture()` are the tile menu's verbs.
 *
 * The message is built the stock way so chats stay openable in stock SillyTavern and the gallery
 * keeps working: `chat.push` → `MESSAGE_RECEIVED` → `addOneMessage` → `CHARACTER_MESSAGE_RENDERED`
 * → `saveChat` → `scrollOnMediaLoad`, exactly the removed extension's order (its `sendMessage`),
 * plus the additive `extra.kotatsu_picture` (§8). The client appends, never the server (§3.2),
 * which keeps the settings-patch and multi-tab rules intact.
 */

import {
    addOneMessage,
    appendMediaToMessage,
    characters,
    chat,
    getCurrentChatId,
    getMediaIndex,
    getThumbnailUrl,
    name2,
    saveChatConditional,
    scrollChatToBottom,
    scrollOnMediaLoad,
    systemUserName,
} from '../../script.js';
import { deleteMediaFromServer } from '../../scripts/chats.js';
import { SCROLL_BEHAVIOR, debounce_timeout } from '../../scripts/constants.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { PROMPT_PROCESSING_EVENT, STOCK_GENERATION_TYPES } from './contract.js';
import { groups, selected_group } from '../../scripts/group-chats.js';
import { rowFor } from '../../scripts/message-rows.js';
import { POPUP_RESULT, Popup } from '../../scripts/popup.js';
import { openSettings } from '../settings/k-settings-modal.js';
import { getMessageTimeStamp } from '../../scripts/RossAscends-mods.js';
import { narratorAvatarOf } from '../groups/narrator.js';
import { DEFAULT_SIZES, INITIATORS, LANES, PURPOSES } from './contract.js';
import {
    characterFor,
    draftPrompt,
    imagesFolder,
    lookOf,
    picturesSettings,
    railsActive,
    storedKeyLane,
    toast,
    updatePicturesSettings,
} from './doors.js';
import { cancelJob, listModels, listRecipes, startPicture, watchJob } from './jobs-client.js';
import { serverKey } from './settings-model.js';
import { PENDING_EVENTS } from './k-picture-pending.js';
import { mascotHidden } from './k-mikan-painter.js';
import './k-picture-sheet.js';
import {
    PENDING_LINES,
    appendCandidates,
    buildPictureMessage,
    cardLorasFor,
    isKeyLane,
    joinNegatives,
    keyLaneRequest,
    keyLaneReroll,
    loraRequest,
    isPurpose,
    needsLine,
    parseSize,
    pickRecipe,
    provenanceFor,
    provenanceFromJob,
    removeCandidate,
    rerollRequest,
    sizesFor,
    familyName,
    openingPick,
    pairsWith,
    variantId,
    withName,
    withTriggers,
} from './picture-model.js';

/** Pending row tag. */
const PENDING_TAG = 'k-picture-pending';

/**
 * @typedef {object} PictureResult
 * @property {number} messageId Index in `chat` of the message the picture landed on.
 * @property {string} url First image's url.
 */

/**
 * @typedef {object} Job
 * @property {import('./contract.js').PictureRequest} request
 * @property {any} target The message a re-roll appends to; null = a new message.
 * @property {string} initiator
 * @property {string} chatId
 * @property {import('./k-picture-pending.js').KPicturePending} row
 * @property {string} jobId
 * @property {number|undefined} seed
 * @property {boolean} cancelRequested
 * @property {(() => void)|null} stop
 * @property {(result: PictureResult|null) => void} resolve
 */

/** @type {Set<Job>} Jobs this tab is following. */
const jobs = new Set();

/** @type {MutationObserver|null} Keeps pending rows last in `#chat` while any is mounted. */
let pinObserver = null;

/** @returns {HTMLElement|null} */
function chatElement() {
    return document.getElementById('chat');
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * Core's media painter takes a jQuery row.
 * @param {Element} element
 * @returns {any}
 */
function jq(element) {
    return /** @type {any} */ (globalThis).jQuery(element);
}

/**
 * Moves pending rows back to the end of `#chat` when something lands after them (a new message,
 * a streamed reply, a re-print). Only runs while a row is mounted; never touches a `.mes`.
 * @returns {void}
 */
function pinRows() {
    const chatEl = chatElement();
    if (!chatEl) return;
    const rows = [...jobs].map(job => job.row).filter(row => row.parentElement === chatEl);
    if (rows.length === 0) return;
    const misplaced = rows.some(row => {
        const next = row.nextElementSibling;
        return next !== null && next.localName !== PENDING_TAG;
    });
    if (misplaced) chatEl.append(...rows);
}

/** Connects or drops the pin observer to match what is mounted. */
function syncPinObserver() {
    const chatEl = chatElement();
    const mounted = chatEl && [...jobs].some(job => job.row.parentElement === chatEl);
    if (!mounted) {
        pinObserver?.disconnect();
        pinObserver = null;
        return;
    }
    if (!pinObserver && chatEl) {
        pinObserver = new MutationObserver(pinRows);
        pinObserver.observe(chatEl, { childList: true });
    }
}

/**
 * Mounts a job's row at the end of `#chat` when its chat is the one on screen.
 * @param {Job} job
 */
function mountRow(job) {
    const chatEl = chatElement();
    if (!chatEl || job.chatId !== getCurrentChatId()) return;
    if (job.row.parentElement !== chatEl) {
        chatEl.append(job.row);
        scrollChatToBottom({ waitForFrame: true });
    }
    syncPinObserver();
}

/**
 * `CHAT_CHANGED`: core's `clearChat()` removed every child of `#chat`, rows included. A row whose
 * chat is back on screen (a reload, a return) goes back at the end; the others wait unmounted —
 * their jobs keep running and land only in their own chat.
 */
function onChatChanged() {
    for (const job of jobs) mountRow(job);
    syncPinObserver();
}

/**
 * @param {Job} job
 * @param {PictureResult|null} result
 */
function finish(job, result) {
    job.stop?.();
    job.stop = null;
    job.row.remove();
    jobs.delete(job);
    syncPinObserver();
    job.resolve(result);
}

/** @param {Job} job */
async function requestCancel(job) {
    job.row.cancelling();
    try {
        await cancelJob(job.jobId);
    } catch (error) {
        job.row.fail(`Could not stop the picture: ${messageOf(error)}`);
    }
}

/**
 * The job's `done`: the row leaves, the picture lands.
 * @param {Job} job
 * @param {any} done
 */
async function complete(job, done) {
    const images = (Array.isArray(done?.images) ? done.images : []).filter((/** @type {any} */ image) => image && typeof image.url === 'string' && image.url);
    if (images.length === 0) {
        job.row.fail('The server finished without a picture.');
        return;
    }
    const provenance = provenanceFromJob(job.request, done, job.seed);
    if (getCurrentChatId() !== job.chatId) {
        finish(job, null);
        toast('info', 'A picture finished after you left its chat. It is saved in the gallery.');
        return;
    }
    await job.row.finishing();
    if (getCurrentChatId() !== job.chatId) {
        finish(job, null);
        toast('info', 'A picture finished after you left its chat. It is saved in the gallery.');
        return;
    }
    job.row.remove();
    try {
        let messageId;
        if (job.target && chat.includes(job.target)) {
            await addCandidates(job.target, images, provenance);
            messageId = chat.indexOf(job.target);
        } else {
            messageId = await appendPictureMessage({ images, provenance, initiator: job.initiator });
        }
        finish(job, { messageId, url: images[0].url });
    } catch (error) {
        console.error('[Pictures] the picture could not be added to the chat', error);
        toast('error', `The picture was drawn but could not be added to the chat: ${messageOf(error)}`);
        finish(job, null);
    }
}

/** @param {Job} job */
async function run(job) {
    job.row.reset();
    job.jobId = '';
    job.row.jobId = '';
    // The frozen extension ABI (CONTRACT.md `SD_PROMPT_PROCESSING`): fired once per job, right
    // before the request leaves, with a MUTABLE payload — stock let listeners rewrite
    // `eventData.prompt` and read it back (`stable-diffusion/index.js:3055-3057` before slice 0).
    // Single owner decided 2026-10-09 at the A/B/C merge: this seam, not the writer, so a prompt
    // typed by hand, a re-roll and a drafted prompt all fire it exactly once.
    const eventData = {
        prompt: job.request.prompt,
        negative: job.request.negative ?? '',
        purpose: job.request.purpose,
        generationType: STOCK_GENERATION_TYPES[job.request.purpose] ?? STOCK_GENERATION_TYPES.free,
        message: job.request.prompt,
        trigger: job.initiator,
    };
    try {
        await eventSource.emit(PROMPT_PROCESSING_EVENT, eventData);
        if (typeof eventData.prompt === 'string') job.request.prompt = eventData.prompt;
        if (typeof eventData.negative === 'string') job.request.negative = eventData.negative;
    } catch (error) {
        console.warn('[Pictures] a prompt-processing listener threw; drawing with the prompt as it was', error);
    }
    try {
        // A stock ComfyUI sends no preview frames unless a prompt asks (its default method is none). Ask only when
        // this tile will show them (the model's live preview in Settings, or a theme without the mascot): Mikan-chan
        // paints from the step count alone, so frames she would hide are not drawn for nothing.
        const settings = await picturesSettings();
        const previews = (job.request.lane ?? LANES.COMFY) === LANES.COMFY && (settings.rawPreview === true || mascotHidden());
        const started = await startPicture(previews ? { ...job.request, previews: true } : job.request);
        job.jobId = started.jobId;
        job.seed = typeof started.seed === 'number' ? started.seed : undefined;
        job.row.jobId = started.jobId;
    } catch (error) {
        if (/** @type {any} */ (error)?.code === 'server_unreachable') {
            // §14.6: say what ComfyUI is and offer a way forward, not a dead end.
            const settings = await picturesSettings();
            job.row.fail(`ComfyUI isn’t answering at ${settings.comfy?.url || 'its address'}. It draws pictures on your own computer: start it, or set it up in Settings → Pictures.`, { setup: true, keyLane: storedKeyLane() });
        } else if (/** @type {any} */ (error)?.code === 'no_family') {
            // Issue #10: a model picked for a recipe with no model family is refused, never drawn with the recipe's own model.
            job.row.fail(`${messageOf(error).replace(/\.?$/, '.')} Pick a pipeline made for that model in the sheet, or draw with the recipe as it is.`);
        } else {
            job.row.fail(`The picture server did not take it: ${messageOf(error)}`);
        }
        return;
    }
    if (job.cancelRequested) {
        job.cancelRequested = false;
        void requestCancel(job);
    }
    job.stop = watchJob(job.jobId, {
        queued: data => job.row.queued(data?.position ?? 0),
        progress: data => job.row.progress(data),
        preview: data => job.row.preview(data?.jpegBase64 ? `data:${data.mime || 'image/jpeg'};base64,${data.jpegBase64}` : ''),
        done: data => void complete(job, data),
        error: data => job.row.fail(String(data?.message ?? 'The picture could not be drawn.')),
        cancelled: () => finish(job, null),
    });
}

/**
 * The first line of a pending row.
 * @param {string} purpose
 * @param {string} name
 * @returns {string}
 */
function pendingLine(purpose, name) {
    return withName(PENDING_LINES[purpose] ?? PENDING_LINES[PURPOSES.FREE], name);
}

/**
 * Starts one picture: a pending row now, the picture when it is done.
 * @param {import('./contract.js').PictureRequest} request
 * @param {{target?: any, initiator?: string}} [options] `target` = the message a re-roll appends to.
 * @returns {Promise<PictureResult|null>} Resolves when the picture lands (null: cancelled, dismissed, or left its chat).
 */
export function drawPicture(request, { target = null, initiator = INITIATORS.HAND } = {}) {
    const row = /** @type {import('./k-picture-pending.js').KPicturePending} */ (document.createElement(PENDING_TAG));
    row.setAttribute('variant', 'row');
    row.line = pendingLine(request.purpose, characterFor(target)?.name ?? name2);
    row.chatId = getCurrentChatId();
    void picturesSettings().then(settings => { row.rawPreview = settings.rawPreview === true; });
    return new Promise(resolve => {
        /** @type {Job} */
        const job = {
            request,
            target,
            initiator,
            chatId: row.chatId,
            row,
            jobId: '',
            seed: undefined,
            cancelRequested: false,
            stop: null,
            resolve,
        };
        row.addEventListener(PENDING_EVENTS.CANCEL, () => {
            if (!job.jobId) {
                job.cancelRequested = true;
                row.cancelling();
                return;
            }
            void requestCancel(job);
        });
        row.addEventListener(PENDING_EVENTS.RETRY, () => {
            job.stop?.();
            job.stop = null;
            void run(job);
        });
        row.addEventListener(PENDING_EVENTS.DISMISS, () => finish(job, null));
        row.addEventListener(PENDING_EVENTS.SETUP, () => {
            openSettings({ tab: 'pictures' });
        });
        // Draw this same picture on the stored key: switch the lane, re-ask for the prompt as it stands.
        row.addEventListener(PENDING_EVENTS.KEY_LANE, async () => {
            const keyLane = storedKeyLane();
            if (!keyLane) return;
            await updatePicturesSettings({ lane: keyLane.lane });
            const settings = await picturesSettings();
            job.request = keyLaneRequest(settings, {
                prompt: job.request.prompt,
                purpose: job.request.purpose,
                character: job.request.character,
                ...(job.request.reference ? { reference: job.request.reference } : {}),
            });
            job.stop?.();
            job.stop = null;
            void run(job);
        });
        jobs.add(job);
        mountRow(job);
        void run(job);
    });
}

/**
 * Who sends a picture: the character in a one-on-one chat; in a scene, the narrator seat when one
 * is seated (§2.3, the lantern face), else stock's system name.
 * @returns {{name: string, force_avatar?: string, original_avatar?: string}}
 */
function pictureSender() {
    if (!selected_group) return { name: name2 };
    const list = Array.isArray(characters) ? characters : [];
    const byAvatar = new Map(list.map(c => [c?.avatar, c]));
    const group = (Array.isArray(groups) ? groups : []).find(g => g?.id === selected_group);
    const avatar = group ? narratorAvatarOf(group, byAvatar) : '';
    const narrator = avatar ? byAvatar.get(avatar) : null;
    if (narrator) {
        return { name: String(narrator.name), force_avatar: getThumbnailUrl('avatar', avatar), original_avatar: avatar };
    }
    return { name: systemUserName };
}

/**
 * Appends a finished picture as a new message, the stock way (see the module header).
 * @param {object} args
 * @param {{url: string, width?: number, height?: number}[]} args.images
 * @param {import('./contract.js').PictureProvenance} args.provenance
 * @param {string} [args.initiator] What started it (`INITIATORS`); recorded in the log only.
 * @returns {Promise<number>} The new message's index.
 */
export async function appendPictureMessage({ images, provenance, initiator = INITIATORS.HAND }) {
    const message = buildPictureMessage({
        sender: pictureSender(),
        images,
        provenance,
        sendDate: getMessageTimeStamp(),
    });
    chat.push(message);
    const messageId = chat.length - 1;
    console.debug(`[Pictures] picture message ${messageId} (${initiator})`);
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await saveChatConditional();
    setTimeout(() => scrollOnMediaLoad(), debounce_timeout.short);
    return messageId;
}

/**
 * Re-roll candidates land on the message they came from; stock's gallery arrows walk them.
 * @param {any} message
 * @param {{url: string, width?: number, height?: number}[]} images
 * @param {import('./contract.js').PictureProvenance} provenance
 */
async function addCandidates(message, images, provenance) {
    appendCandidates(message, images, provenance);
    const row = rowFor(message);
    if (row) appendMediaToMessage(message, jq(row), SCROLL_BEHAVIOR.KEEP);
    await saveChatConditional();
}

/**
 * Opens the Picture sheet.
 * @param {object} [options]
 * @param {string} [options.purpose] A `PURPOSES` value; default: the last one used.
 * @param {number} [options.messageIndex] The message This moment is about.
 * @param {import('./k-picture-sheet.js').SheetPrefill} [options.prefill]
 * @param {any} [options.target] Re-roll target (Edit prompt): the result appends to this message.
 * @param {string} [options.initiator]
 * @param {string} [options.heading]
 * @returns {Promise<import('./k-picture-sheet.js').KPictureSheet|null>}
 */
export async function openPictureSheet({ purpose, messageIndex, prefill, target = null, initiator = INITIATORS.HAND, heading } = {}) {
    if (!railsActive()) {
        toast('info', 'Pictures are part of the rails layout.');
        return null;
    }
    document.querySelector('k-picture-sheet')?.remove();
    const settings = await picturesSettings();
    const index = Number.isInteger(messageIndex) ? Number(messageIndex) : undefined;
    const message = index !== undefined ? chat[index] : undefined;
    const character = characterFor(message);
    const sheet = /** @type {import('./k-picture-sheet.js').KPictureSheet} */ (document.createElement('k-picture-sheet'));
    sheet.setAttribute('variant', 'sheet');
    const lastPurpose = settings.lastSheet?.purpose;
    sheet.purpose = isPurpose(purpose) ? purpose : isPurpose(lastPurpose) ? lastPurpose : PURPOSES.MOMENT;
    sheet.messageIndex = index;
    sheet.prefill = prefill ?? {};
    sheet.character = character;
    sheet.characterName = String(character?.name ?? name2 ?? '');
    sheet.imagesFolder = imagesFolder();
    if (heading) sheet.heading = heading;
    sheet.onDraw = request => void drawPicture(request, { target, initiator });
    document.body.appendChild(sheet);
    return sheet;
}

/**
 * `/imagine … quiet=true`: draws without the sheet, from the purpose's recipe and the writer.
 * @param {{purpose: string, free?: string}} args
 * @returns {Promise<PictureResult|null>}
 */
export async function quickPicture({ purpose, free = '' }) {
    const settings = await picturesSettings();
    if (isKeyLane(settings.lane)) {
        const character = characterFor(undefined);
        const draft = await draftPrompt({ purpose, tongue: 'prose', free, look: await lookOf(character), style: null });
        if (!draft.prompt.trim()) throw new Error('Nothing to draw yet: give the picture a description.');
        return drawPicture(keyLaneRequest(settings, {
            prompt: draft.prompt.trim(),
            purpose,
            character: imagesFolder(),
            shape: settings.lastSheet?.size,
        }), { initiator: INITIATORS.COMMAND });
    }
    const recipes = await listRecipes();
    const recipeId = pickRecipe(recipes, { purpose, recipeByPurpose: settings.recipeByPurpose, last: settings.lastSheet?.recipe });
    let recipe = recipes.find(r => r.id === recipeId);
    // With models set up, the sheet's rule (issue #10): the last model used, with its pipeline and preset; a model
    // only ever draws with a pipeline of its own family, and a family with none here stops with words.
    const server = serverKey(settings.comfy?.url ?? '');
    const saved = settings.models?.[server];
    /** @type {Record<string, import('./picture-model.js').FamilyInfo>} */
    let families = {};
    /** @type {{file: string, family: string, preset: string}|null} */
    let model = null;
    if (Object.values(saved ?? {}).some(Boolean)) {
        try {
            families = (await listModels({ url: settings.comfy?.url, auth: settings.comfy?.auth })).families ?? {};
        } catch {
            // without the families the recipe draws with its own slot choice
        }
        if (Object.keys(families).length) {
            const pick = openingPick({ purposeRecipe: recipe, recipes, saved, families, last: settings.lastModel?.[server] });
            if (pick.model && !pick.recipe) {
                throw new Error(`No ${familyName(families, pick.model.family)} pipeline installed, so ${pick.model.file} can't draw here yet.`);
            }
            model = pick.model;
            recipe = recipes.find(r => r.id === pick.recipe) ?? recipe;
        }
    }
    if (!recipe) throw new Error('There is no recipe to draw with yet.');
    const needs = needsLine(recipe);
    if (needs) throw new Error(`${recipe.name || recipe.id}: ${needs}`);
    const character = characterFor(undefined);
    const look = await lookOf(character);
    const draft = await draftPrompt({ purpose, tongue: recipe.tongue ?? 'prose', free, look, style: null });
    if (!draft.prompt.trim()) throw new Error('Nothing to draw yet: give the picture a description.');
    const sizes = sizesFor(recipe);
    const size = parseSize(sizes.includes(settings.lastSheet?.size) ? settings.lastSheet.size : sizes[0]);
    if (!size) throw new Error('The recipe has no usable size.');
    // The card's LoRAs ride the purposes that draw the character, their triggers in front.
    const loras = cardLorasFor(purpose, look?.loras);
    /** @type {import('./contract.js').PictureRequest} */
    const request = {
        lane: LANES.COMFY,
        recipe: recipe.id,
        prompt: withTriggers(draft.prompt.trim(), loras.map(l => l.trigger).filter(Boolean)),
        negative: joinNegatives(draft.negative, recipe.negative ?? ''),
        width: size.width,
        height: size.height,
        purpose,
        character: imagesFolder(),
    };
    if (loras.length) request.loras = loraRequest(loras);
    if (model && pairsWith(model, recipe)) {
        const family = families[model.family];
        const presetId = family?.presets?.[model.preset] ? model.preset : family?.defaultPreset ?? model.preset;
        const preset = family?.presets?.[presetId] ?? null;
        request.model = model.file;
        request.family = model.family;
        request.preset = presetId;
        if (preset) request.negative = preset.negative === null ? '' : joinNegatives(draft.negative, preset.negative);
    }
    return drawPicture(request, { initiator: INITIATORS.COMMAND });
}

/**
 * The provenance for a message's shown picture, or a stand-in built from the stock attachment
 * when the message predates Pictures (§8: absent = Again falls back to a new seed from the title).
 * @param {any} message
 * @param {number} index
 * @returns {Promise<import('./contract.js').PictureProvenance|null>}
 */
async function replayableProvenance(message, index) {
    const stored = provenanceFor(message, index);
    if (stored) return stored;
    const media = message?.extra?.media?.[index];
    if (!media || typeof media.title !== 'string' || !media.title) return null;
    const settings = await picturesSettings();
    return {
        lane: LANES.COMFY,
        recipe: settings.lastSheet?.recipe || '',
        seed: NaN,
        size: settings.lastSheet?.size || DEFAULT_SIZES[0],
        prompt: media.title,
        negative: String(media.negative ?? ''),
        purpose: isPurpose(media.generation_type) ? media.generation_type : PURPOSES.FREE,
    };
}

/**
 * The tile menu's Again (new seed) and Same seed, bigger (the recipe's hires variant).
 * @param {any} message
 * @param {'again'|'bigger'} mode
 * @returns {Promise<PictureResult|null>}
 */
export async function rerollPicture(message, mode) {
    const index = getMediaIndex(message);
    const provenance = await replayableProvenance(message, index);
    if (!provenance) {
        toast('warning', 'This picture has no prompt to draw from.');
        return null;
    }
    if (isKeyLane(provenance.lane)) {
        // No seed on these lanes: Again is the same ask once more; there is no "bigger" (the menu hides it).
        const request = mode === 'again' ? keyLaneReroll(provenance, imagesFolder()) : null;
        if (!request) {
            toast('warning', 'This picture cannot be drawn again.');
            return null;
        }
        return drawPicture(request, { target: message, initiator: INITIATORS.HAND });
    }
    let recipe = provenance.recipe ?? '';
    if (mode === 'bigger') {
        const recipes = await listRecipes();
        recipe = variantId(recipes.find(r => r.id === provenance.recipe), 'hires');
        if (!recipe) {
            toast('info', 'This recipe has no bigger version.');
            return null;
        }
    } else if (!recipe) {
        const settings = await picturesSettings();
        recipe = pickRecipe(await listRecipes(), { purpose: provenance.purpose, recipeByPurpose: settings.recipeByPurpose, last: settings.lastSheet?.recipe });
    }
    const request = rerollRequest(provenance, { mode, character: imagesFolder(), recipe });
    if (!request) {
        toast('warning', 'This picture cannot be drawn again.');
        return null;
    }
    return drawPicture(request, { target: message, initiator: INITIATORS.HAND });
}

/**
 * The tile menu's Edit prompt: the sheet, prefilled from the shown picture, drawing onto this message.
 * @param {any} message
 * @returns {Promise<void>}
 */
export async function editPicturePrompt(message) {
    const index = getMediaIndex(message);
    const provenance = await replayableProvenance(message, index);
    const messageIndex = chat.indexOf(message);
    /** @type {import('./k-picture-sheet.js').SheetPrefill} */
    const prefill = provenance ? {
        prompt: provenance.prompt,
        negative: provenance.negative ?? '',
        recipe: provenance.recipe ?? '',
        // A Gemini picture's shape is its aspect; its drawn size would not be on the menu.
        size: provenance.aspect || provenance.size,
        ...(Array.isArray(provenance.loras) ? { loras: provenance.loras } : {}),
        ...(provenance.lane === LANES.COMFY && provenance.model ? { model: provenance.model, preset: provenance.preset } : {}),
    } : {};
    if (provenance && Number.isFinite(Number(provenance.seed))) prefill.seed = Number(provenance.seed);
    await openPictureSheet({
        purpose: provenance?.purpose,
        messageIndex: messageIndex >= 0 ? messageIndex : undefined,
        prefill,
        target: message,
        heading: 'Edit and draw again',
    });
}

/**
 * The tile menu's Delete: removes the shown picture from the message, the way stock's own trash
 * button does (`chats.js` `deleteMessageMedia`: confirm, splice, clamp `media_index`, optionally
 * delete the file, save, repaint), and keeps `extra.kotatsu_picture` aligned with the array.
 * @param {any} message
 * @returns {Promise<boolean>} Whether a picture was removed.
 */
export async function deletePicture(message) {
    const index = getMediaIndex(message);
    if (!Array.isArray(message?.extra?.media) || !message.extra.media[index]) return false;
    const fileBoxId = 'k_picture_delete_file';
    let deleteFile = true;
    const answer = await Popup.show.confirm('Delete this picture?', 'The message keeps its other pictures.', {
        okButton: 'Delete',
        cancelButton: 'Cancel',
        customInputs: [{ type: 'checkbox', label: 'Also delete the file', id: fileBoxId, defaultState: true }],
        onClose: popup => {
            deleteFile = Boolean(popup.inputResults?.get(fileBoxId) ?? false);
        },
    });
    if (answer !== POPUP_RESULT.AFFIRMATIVE) return false;
    const url = removeCandidate(message, index);
    if (deleteFile && url) await deleteMediaFromServer(url, true);
    await saveChatConditional();
    const row = rowFor(message);
    if (row) appendMediaToMessage(message, jq(row), SCROLL_BEHAVIOR.KEEP);
    return true;
}

/**
 * Binds the chat-change door. Called by the rails install.
 * @returns {void}
 */
export function installPictureJobs() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

/**
 * Unmounts every pending row and stops following their jobs (the jobs keep running server-side).
 * @returns {void}
 */
export function uninstallPictureJobs() {
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    for (const job of [...jobs]) finish(job, null);
    pinObserver?.disconnect();
    pinObserver = null;
    document.querySelector('k-picture-sheet')?.remove();
}

/** Diagnostics for the console door and the probe. */
export function picturesJobsState() {
    return [...jobs].map(job => ({
        jobId: job.jobId,
        chatId: job.chatId,
        state: job.row.state,
        mounted: job.row.isConnected,
        target: job.target ? chat.indexOf(job.target) : null,
    }));
}
