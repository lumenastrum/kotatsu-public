/**
 * Pictures v0 — the prompt writer's words (docs/pictures-v0.md §4).
 *
 * Prose is the source, the way Kotatsu Nabe's is (`scripts/presets/kotatsu-nabe.mjs`): every
 * instruction below is written in the register we want back, says what to do before what to
 * avoid, and gives its reason in the same breath. Nothing here is generated; edit these strings.
 *
 * Shape: one template per purpose × tongue (`PURPOSES` × `TONGUES`, contract.js), plus a face
 * close-up for `char` and a multimodal caption for `char` when the connection can see the card's
 * art (`generateQuietPrompt`'s `quietImage`). Every template opens with the same one-line system
 * instruction ({@link WRITER_SYSTEM_LINE}): the writer runs as a quiet generation that writes FOR
 * an image model, never as the character, and never with an "ignore previous instructions"
 * opener (the stock templates all had one; §4 retires them).
 *
 * Placeholders the writer fills before core's macro pass: `{message}` (the visible text of the
 * message a *This moment* picture is drawn from) and `{free}` (the line someone typed). `{{char}}`
 * and `{{user}}` are core macros, substituted by `Generate()` like every quiet prompt.
 *
 * Pure data and one lookup: no imports, so tests read it whole.
 */

/** Opens every template. A quiet generation with its own job, not a turn in the story. */
export const WRITER_SYSTEM_LINE = 'You are now writing a prompt for an image generator, not a reply in the story: answer with the prompt alone, no preamble, no quotes, no commentary.';

/**
 * How each tongue wants its answer shaped. Appended after the purpose's own instruction, so a
 * purpose says WHAT to draw and the tongue says HOW to write it down.
 */
/*
 * Tags, measured on Anima 2026-10-10 (Holo + the persona, same seeds): one flat list spread her wolf
 * ears, red eyes and fang onto him (2/2); one block per person kept the looks apart (2/2); position
 * tags still went to whoever the model liked (2/4 right), a short English phrase inside each block
 * placed them right 3/4 and carried "looks up at her" twice. CircleStone's card: name a character,
 * then their looks, "extra important when prompting for multiple characters"; tags and natural
 * language mix in any order.
 */
/**
 * Size words: KREA2 drew an unnamed "short young woman" with wolf ears child-like on 4 of 4 seeds
 * (2026-10-10). Pairing size with an adult noun keeps grown-ups grown.
 */
const GROWN_UPS = 'Describe a grown-up as a grown-up: whenever you mention height or size, pair it with woman, man or adult, never short or small on its own.';

const TONGUE_RULES = Object.freeze({
    tags: 'Write it as one line of danbooru-style tags separated by commas, the way anime image models were trained to read them. Begin with "masterpiece, best quality, score_7", then exactly one rating tag (safe, sensitive, nsfw or explicit) that honestly fits what is shown. Then one block per person, the most important person first: their count tag (1girl, 1boy or 1other), their character tag if they are a well-known character (name then work in parentheses, for example: holo (spice and wolf)), their looks and what they wear, and last where they are and what they are doing as one short plain-English phrase (for example: she stands in the bed of the open cart and leans over its side). Keep every tag about a person inside that person\'s own block, and give age as a word such as young or mature, never a number. With nobody in the picture, write no humans instead of the blocks. End with the place, the time of day and the light as tags. Use the plain lowercase tag words people actually search for, with spaces rather than underscores (score tags keep theirs), and no more than about sixty tags. ' + GROWN_UPS,
    prose: 'Write it as one paragraph of plain description, subject first: who or what is in the picture and what they are doing (pose, gesture, expression), then what they look like and wear, then where, then the light. Image models follow the start of a prompt most closely, so the action goes before the looks. Use concrete nouns and visible details a painter could act on, because image models draw nouns, not feelings. Leave out camera and lens jargon unless the story asks for it, and keep it under about a hundred words. A well-known character is named with their work where they first appear, for example: Holo from Spice and Wolf. ' + GROWN_UPS,
});

/**
 * What each purpose asks for, before the tongue's rules. `{{char}}` / `{{user}}` are core macros.
 */
/**
 * Names: image models know famous characters by name (and anime models by their danbooru tag), and
 * have never met an original one. So looks always, and a name only for a character from a published
 * work. Found 2026-10-10: a Holo card drew as "a young woman with long brown hair".
 */
const NAMING = 'Describe everyone by their looks. If someone is a well-known character from a published work (an anime, manga, game, novel, film or show) and you are sure of it, also name them and the work, because image models often know them; never name an original character.';

const PURPOSE_ASKS = Object.freeze({
    moment: `Describe the picture of this moment from the story, drawn from the message below. Show only what could be seen in a single still frame at that instant: who is there, how they look, what they are doing with their hands and bodies, and where they are. ${NAMING} Leave out thoughts, feelings that do not show on a face, sounds and dialogue.\n\nThe message:\n{message}`,
    char: 'Describe {{char}} as a full-body picture, standing or posed the way they naturally would be: body, face, hair, eyes, what they are wearing from head to toe, and anything they usually carry. Take it only from their description below. A plain portrait against a simple background: no setting, scene or action from any story. Leave out personality and history; only what a still picture can show. ' + NAMING + '\n\nThe description:\n{description}',
    face: 'Describe a close-up picture of {{char}}\'s face and shoulders: face shape, eyes, expression, hair and anything in it, and what they wear at the neck and shoulders. Take it only from their description below, against a simple background, with nothing from any story. Leave out everything below the shoulders and everything a face cannot show. ' + NAMING + '\n\nThe description:\n{description}',
    me: 'Describe {{user}} as a full-body portrait, taken only from {{user}}\'s own persona description below: body, face, hair, eyes, clothes from head to toe. A plain portrait against a simple background: no setting, scene or action from any story. Describe them as {{user}} would want to be drawn. ' + NAMING + '\n\nThe description:\n{description}',
    place: 'Describe the place where the story is happening right now, as an empty scene with no people in it: what kind of place it is, the time of day, the weather, the light, and the objects and textures that make it this place and not another.',
    free: `Turn this line into a full picture prompt, keeping everything it asks for and filling in only the visible details it leaves open. If it mentions {{char}} or {{user}}, describe them as the story shows them. ${NAMING}\n\nThe line:\n{free}`,
});

/**
 * The multimodal caption for `char`: the connection is SHOWN the card's art (`quietImage`) and
 * describes what it sees. Face variant included, for the same close-up flag.
 */
const MULTIMODAL_ASKS = Object.freeze({
    char: 'The attached picture is {{char}}. Describe what you see in it as a full-body picture of them: body, face, hair, eyes, and everything they are wearing from head to toe. Describe the picture itself rather than the story, and leave out the background. ' + NAMING,
    face: 'The attached picture is {{char}}. Describe their face and shoulders as you see them in it: face shape, eyes, expression, hair and anything in it, and what they wear at the neck. Describe the picture itself rather than the story, and leave out the background. ' + NAMING,
});

/**
 * Every template the writer can send, built once. Keyed `purpose` → `tongue` → text, with the
 * two `char` variants beside it under `face` and `multimodal` / `multimodalFace`.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const TEMPLATES = Object.freeze(Object.fromEntries(
    [...Object.keys(PURPOSE_ASKS), 'multimodal', 'multimodalFace'].map(key => {
        const ask = key === 'multimodal' ? MULTIMODAL_ASKS.char
            : key === 'multimodalFace' ? MULTIMODAL_ASKS.face
                : PURPOSE_ASKS[/** @type {keyof typeof PURPOSE_ASKS} */ (key)];
        return [key, Object.freeze(Object.fromEntries(
            Object.entries(TONGUE_RULES).map(([tongue, rule]) => [tongue, `${WRITER_SYSTEM_LINE}\n\n${ask}\n\n${rule}`]),
        ))];
    }),
));

/**
 * The template for one request.
 *
 * `face` and `multimodal` only change `char`; every other purpose ignores them (stock had a
 * multimodal `me` too, but the persona's avatar is a chat icon far more often than a body, so v0
 * keeps that one on the text path). An unknown tongue falls back to `tags`, the stock register.
 * @param {string} purpose One of `PURPOSES`.
 * @param {string} tongue One of `TONGUES`.
 * @param {{ face?: boolean, multimodal?: boolean }} [options]
 * @returns {string} The quiet prompt, placeholders unfilled. '' for an unknown purpose.
 */
export function templateFor(purpose, tongue, { face = false, multimodal = false } = {}) {
    let key = purpose;
    if (purpose === 'char') {
        key = multimodal ? (face ? 'multimodalFace' : 'multimodal') : (face ? 'face' : 'char');
    }
    const byTongue = TEMPLATES[key];
    if (!byTongue) return '';
    return byTongue[tongue] ?? byTongue.tags;
}
