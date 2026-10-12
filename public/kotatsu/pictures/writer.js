/**
 * Pictures v0 — the prompt writer (docs/pictures-v0.md §4, contract `DraftFn`, §13.3).
 *
 * `draft(args)` turns a purpose into a picture prompt:
 *   1. the template for (purpose, tongue) — `templates.js`, filled with the message text
 *      (`moment`) or the typed line (`free` when asked to expand);
 *   2. one quiet generation on the main connection: `generateQuietPrompt({ quietPrompt,
 *      quietToLoud: false, skipWIAN: true, removeReasoning: true, quietImage? })` — the summarize
 *      route, with the template's own system line, never the character speaking;
 *   3. post-processing ({@link postProcess}): trimmed, whitespace collapsed, a stray label or
 *      wrapping quotes dropped; `tags` deduped and capped at {@link MAX_TAGS}, `prose` capped at
 *      {@link MAX_WORDS} words;
 *   4. assembly ({@link assemble}): the card's look in front (purposes `char` and `moment`), the
 *      drafted text, the style behind; negatives = look + style.
 *
 * The ABI event `sd_prompt_processing` (CONTRACT.md:413) is NOT fired here: the draw seam in
 * `picture-actions.js` fires it once per job, right before the request leaves, so a typed prompt,
 * a re-roll and a drafted prompt all fire it exactly once (decision 2026-10-09 at the merge).
 *
 * `free` without `expand` skips 1–3: the typed line goes out untouched (a passed style is still
 * appended).
 *
 * One-way imports: kotatsu → core.
 */

import { characters, chat, generateQuietPrompt, generateRaw, getCharacterCardFields, name1, online_status, substituteParams, this_chid } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { removeReasoningFromString } from '../../scripts/reasoning.js';
import { CAPTION_LINE_PATTERN, stripCaptionLines } from './picture-model.js';
import { PORTRAIT_PURPOSES, PURPOSES, TONGUES } from './contract.js';
import { cardArtUrl, getLook } from './look.js';
import { templateFor } from './templates.js';

/** @typedef {import('./contract.js').CardLook} CardLook */

/**
 * A reason the writer could not draft, worded for the person at the sheet. The sheet shows the
 * message of an error with this name; anything else gets its generic line.
 */
export class WriterError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'WriterError';
    }
}

/**
 * True while the writer's own quiet generation is being assembled: the prompt-ready hooks below
 * take the picture caption lines out of THAT request only. The chat model's replies keep them
 * (they are how it knows what a picture shows). Found 2026-10-10: with an earlier caption in the
 * chat the writer copied its own old prompt instead of following the current rule.
 */
let writerRequest = false;
let captionFilterInstalled = false;

/** @param {{chat?: any[], dryRun?: boolean}} data CHAT_COMPLETION_PROMPT_READY payload */
function stripCaptionsFromMessages(data) {
    if (!writerRequest || data?.dryRun || !Array.isArray(data?.chat)) return;
    for (let i = data.chat.length - 1; i >= 0; i--) {
        const message = data.chat[i];
        if (typeof message?.content !== 'string' || !message.content.includes(' sends a picture that contains: ')) continue;
        const kept = stripCaptionLines(message.content);
        // "Holo: " alone is what a caption-only message leaves behind with names in content.
        if (!kept || /^[^\n:]{1,60}:$/.test(kept)) data.chat.splice(i, 1);
        else message.content = kept;
    }
}

/** @param {{prompt?: string, dryRun?: boolean}} data GENERATE_AFTER_COMBINE_PROMPTS payload */
function stripCaptionsFromText(data) {
    if (!writerRequest || data?.dryRun || typeof data?.prompt !== 'string') return;
    data.prompt = data.prompt.replace(CAPTION_LINE_PATTERN, '');
}

function installCaptionFilter() {
    if (captionFilterInstalled) return;
    captionFilterInstalled = true;
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, stripCaptionsFromMessages);
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, stripCaptionsFromText);
}

/** Longest model error quoted back to the sheet. */
const REASON_CHARS = 200;

/** A `tags` draft keeps at most this many tags (the look and style are added after). */
export const MAX_TAGS = 75;

/** A `prose` draft keeps at most this many words. */
export const MAX_WORDS = 120;

/** The message text the writer quotes is cut to this many characters, from the end. */
const MESSAGE_CHARS = 4000;

/**
 * @typedef {object} DraftArgs
 * @property {string} purpose One of `PURPOSES`.
 * @property {string} tongue One of `TONGUES` (the recipe's; key lanes write `prose`).
 * @property {number} [messageIndex] `moment`: the chat index; default = the last non-system message.
 * @property {string} [free] `free`: the typed line.
 * @property {CardLook|null} [look] The look to prefix. `undefined` = the current card's own;
 *   `null` = none.
 * @property {{positive: string, negative: string}|null} [style]
 * @property {boolean} [face] `char`: a close-up instead of full body. (Beyond the contract's
 *   `DraftFn`; see the slice C hand-off.)
 * @property {boolean} [expand] `free`: run the writer over the typed line. Without it the line
 *   is returned untouched. (Beyond the contract.)
 * @property {boolean} [multimodal] `char`: show the connection the reference picture and caption
 *   it, instead of describing from the card. (Beyond the contract.)
 * @property {string} [reference] With `multimodal`: the picture to show. Default = the look's
 *   reference, then the card's art.
 */

/* ── pure helpers ─────────────────────────────────────────────────────────────────────────── */

/**
 * The visible text of a message, without the formatting that means nothing to an image model:
 * HTML, markdown emphasis and code marks, quote and heading markers, reasoning blocks.
 * @param {string} value
 * @returns {string}
 */
export function plainMessageText(value) {
    let out = String(value ?? '');
    out = out.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ' ');
    out = out.replace(/```[\s\S]*?```/g, ' ');
    out = out.replace(/<[^>]+>/g, ' ');
    out = out.replace(/^\s{0,3}(#{1,6}|>+)\s*/gm, '');
    out = out.replace(/(\*{1,3}|_{2,3}|~~|`)/g, '');
    out = out.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    return out.length > MESSAGE_CHARS ? out.slice(out.length - MESSAGE_CHARS) : out;
}

/**
 * Splits a tag string into tags: commas and newlines separate, whitespace inside a tag collapses.
 * @param {string} value
 * @returns {string[]}
 */
export function splitTags(value) {
    return String(value ?? '')
        .split(/[,\n]/)
        .map(tag => tag.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

/**
 * Drops repeated tags, case- and underscore-insensitively; the first spelling wins.
 * @param {string[]} tags
 * @returns {string[]}
 */
export function dedupeTags(tags) {
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    for (const tag of tags) {
        const key = tag.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/**
 * Cuts prose to `max` words, ending on a sentence when one ends in the last third.
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
function capWords(value, max) {
    const words = value.split(' ').filter(Boolean);
    if (words.length <= max) return words.join(' ');
    const cut = words.slice(0, max).join(' ');
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    if (stop > cut.length * (2 / 3)) return cut.slice(0, stop + 1);
    return cut.replace(/[,;:]$/, '');
}

/**
 * Cleans what the writer sent back.
 * @param {string} raw The model's reply.
 * @param {string} tongue `tags` | `prose`
 * @returns {string}
 */
export function postProcess(raw, tongue) {
    let out = String(raw ?? '').trim();
    // A label the model added in front ("Prompt:", "Tags -"), and quotes around the whole answer.
    out = out.replace(/^(image\s+)?(prompt|tags|description)\s*[:\-–]\s*/i, '');
    out = out.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
    if (tongue === TONGUES.TAGS) {
        return dedupeTags(splitTags(out)).slice(0, MAX_TAGS).join(', ');
    }
    out = out.replace(/\s+/g, ' ').trim();
    return capWords(out, MAX_WORDS);
}

/**
 * Joins prompt parts in the tongue's grammar. `tags`: one comma list, deduped (an earlier part's
 * tag wins, so the look's spelling beats the draft's). `prose`: sentences, each part ending in a
 * full stop before the next starts.
 * @param {string[]} parts
 * @param {string} tongue
 * @returns {string}
 */
export function joinParts(parts, tongue) {
    const present = parts.map(part => String(part ?? '').trim()).filter(Boolean);
    if (tongue === TONGUES.TAGS) {
        return dedupeTags(present.flatMap(splitTags)).join(', ');
    }
    return present
        .map((part, index) => (index < present.length - 1 && !/[.!?]$/.test(part) ? `${part.replace(/[,;:]$/, '')}.` : part))
        .join(' ');
}

/**
 * Puts the final prompt together.
 * @param {object} parts
 * @param {string} parts.purpose
 * @param {string} parts.tongue
 * @param {string} parts.drafted The post-processed draft (or the untouched free line).
 * @param {CardLook|null} [parts.look]
 * @param {{positive: string, negative: string}|null} [parts.style]
 * @returns {{ prompt: string, negative: string }}
 */
export function assemble({ purpose, tongue, drafted, look = null, style = null }) {
    const useLook = Boolean(look) && (purpose === PURPOSES.CHAR || purpose === PURPOSES.MOMENT);
    const prompt = joinParts([useLook ? look?.positive ?? '' : '', drafted, style?.positive ?? ''], tongue);
    // Negatives are tag lists in every recipe that has one (prose recipes have none at all).
    const negative = joinParts([useLook ? look?.negative ?? '' : '', style?.negative ?? ''], TONGUES.TAGS);
    return { prompt, negative };
}

/**
 * The chat index a *This moment* picture is drawn from.
 * @param {any[]} list Core's `chat`.
 * @param {number} [messageIndex]
 * @returns {number} -1 when there is none.
 */
export function momentIndex(list, messageIndex) {
    const messages = Array.isArray(list) ? list : [];
    if (typeof messageIndex === 'number' && Number.isInteger(messageIndex) && messageIndex >= 0 && messageIndex < messages.length) {
        return messageIndex;
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index] && !messages[index].is_system) return index;
    }
    return -1;
}

/**
 * What a reader saw in a message: `extra.display_text` when a script rewrote it, else `mes`.
 * @param {any} message
 * @returns {string}
 */
export function visibleText(message) {
    const shown = message?.extra?.display_text;
    return plainMessageText(typeof shown === 'string' ? shown : String(message?.mes ?? ''));
}

/**
 * Fills the writer's placeholders. Single-brace, so core's `{{macro}}` pass never sees them.
 * @param {string} template
 * @param {{ message?: string, free?: string, description?: string }} values
 * @returns {string}
 */
export function fillTemplate(template, { message = '', free = '', description = '' } = {}) {
    return template.replaceAll('{message}', message).replaceAll('{free}', free).replaceAll('{description}', description);
}

/* ── the door ─────────────────────────────────────────────────────────────────────────────── */

/**
 * The card a draft is about: for a moment, the character who sent the message (groups); else
 * the open character.
 * @param {any} [message]
 * @returns {any|null}
 */
function cardFor(message) {
    const list = Array.isArray(characters) ? characters : [];
    const avatar = message && !message.is_user && typeof message.original_avatar === 'string' ? message.original_avatar : '';
    if (avatar) {
        const sender = list.find(card => card?.avatar === avatar);
        if (sender) return sender;
    }
    return this_chid !== undefined ? list[Number(this_chid)] ?? null : null;
}

/**
 * The writer's door (contract `DraftFn`). Throws a {@link WriterError} when there is no chat model
 * connected, no message to draw, or the model fails or writes nothing back.
 * @param {DraftArgs} args
 * @returns {Promise<{ prompt: string, negative: string }>}
 */
export async function draft(args) {
    const purpose = String(args?.purpose ?? PURPOSES.MOMENT);
    const tongue = args?.tongue === TONGUES.PROSE ? TONGUES.PROSE : TONGUES.TAGS;
    const style = args?.style ?? null;

    if (purpose === PURPOSES.FREE && !args?.expand) {
        const line = String(args?.free ?? '');
        return { prompt: style?.positive ? joinParts([line, style.positive], tongue) : line, negative: joinParts([style?.negative ?? ''], TONGUES.TAGS) };
    }

    const index = purpose === PURPOSES.MOMENT ? momentIndex(chat, args?.messageIndex) : -1;
    const message = index >= 0 ? chat[index] : null;
    if (purpose === PURPOSES.MOMENT && !message) {
        throw new WriterError('There is no message to draw yet.');
    }
    const card = cardFor(message);
    const look = args?.look === undefined ? (card ? getLook(card) : null) : args.look;
    const messageText = message ? visibleText(message) : '';

    const multimodal = purpose === PURPOSES.CHAR && Boolean(args?.multimodal);
    const quietImage = multimodal ? (args?.reference || look?.reference || cardArtUrl(card)) : '';
    const template = templateFor(purpose, tongue, { face: Boolean(args?.face), multimodal: multimodal && Boolean(quietImage) });
    if (!template) throw new Error(`"${purpose}" is not a picture purpose.`);
    // Without a connection generateQuietPrompt sends nothing and resolves empty (measured
    // 2026-10-10), which read as "came back empty".
    if (online_status === 'no_connection') {
        throw new WriterError('Connect a chat model to use the writer, or type the prompt yourself.');
    }
    // A portrait is a one-shot: drafted from the card (or persona) alone through generateRaw, which
    // sends only this prompt, so no scene from the chat can leak in. The multimodal caption still
    // rides the quiet route, which is the one that carries an image.
    const portrait = PORTRAIT_PURPOSES.includes(purpose) && !quietImage;
    let description = '';
    if (portrait) {
        const chid = card ? characters.indexOf(card) : -1;
        const fields = getCharacterCardFields(chid >= 0 ? { chid } : {});
        description = String((purpose === PURPOSES.ME ? fields.persona : fields.description) ?? '').trim();
        if (!description) {
            throw new WriterError(purpose === PURPOSES.ME
                ? `${name1 || 'Your persona'} has no description to draw from yet. Add one, or type the prompt yourself.`
                : `${card?.name || 'This character'} has no description to draw from yet. Type the prompt yourself.`);
        }
    }

    let raw;
    try {
        if (portrait) {
            raw = removeReasoningFromString(await generateRaw({ prompt: fillTemplate(substituteParams(template), { description }), trimNames: false }));
        } else {
            const quietPrompt = fillTemplate(template, { message: messageText, free: String(args?.free ?? '') });
            /** @type {import('../../script.js').GenerateQuietPromptParams} */
            const params = { quietPrompt, quietToLoud: false, skipWIAN: true, removeReasoning: true };
            if (quietImage) params.quietImage = quietImage;
            installCaptionFilter();
            writerRequest = true;
            try {
                raw = await generateQuietPrompt(params);
            } finally {
                writerRequest = false;
            }
        }
    } catch (error) {
        const reason = String(error instanceof Error ? error.message : error ?? '').trim().slice(0, REASON_CHARS);
        throw new WriterError(`The model couldn't draft${reason ? `: ${reason.replace(/[.\s]+$/, '')}.` : '.'} Try again, or type the prompt yourself.`);
    }
    const drafted = postProcess(raw, tongue);
    if (!drafted) throw new WriterError('The writer came back empty. Try again, or type the prompt yourself.');

    return assemble({ purpose, tongue, drafted, look, style });
}
