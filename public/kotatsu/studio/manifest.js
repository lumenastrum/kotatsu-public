/**
 * `<k-card-studio>`'s field manifest — v2, `docs/card-studio-v2.md` (v0: `docs/library-v0.md` §2.2).
 *
 * DOM-free by contract, exactly like `library/view-model.js`: this module says WHICH core
 * control belongs in WHICH chapter, what Kotatsu calls it, how "ready" a card is, what to do
 * next and what the card costs every turn. It never queries the document, never renders and
 * never imports core. `k-card-studio.js` is the only file in this folder that touches DOM. That
 * split is what lets `tests/studio-manifest.test.js` measure the partition instead of vibing it.
 *
 * Two invariants the unit test enforces, both of which are real bugs if they ever break:
 *
 * 1. **Exactly-once partition.** Every slot key appears in exactly one place across the hero,
 *    the chapters and the card menu, and every selector is relocated from exactly one slot. A
 *    control listed twice would be relocated twice — the second `relocate()` would find an
 *    anchor already recorded and quietly move the node again, and the restore would put it
 *    back in the FIRST slot's remembered home. One duplicate is one control that never goes
 *    home, which is the exact failure the restore gate exists to catch.
 * 2. **The wire format is never renamed.** The `name=` attributes are what
 *    `charaFormatData()` reads (`src/endpoints/characters.js:565-645`); nothing here carries a
 *    name, precisely so nothing here can rename one. The manifest addresses controls by ID —
 *    CONTRACT §1 lets a frozen id MOVE and forbids renaming it, which is the whole mechanism.
 *
 * ── Why a manifest at all ─────────────────────────────────────────────────────────────────
 * The studio does not build inputs. It borrows the REAL ones (doc §0 "Studio mechanism") and
 * gives them Kotatsu labels, so autosave, the token counters, the macro engine, the crop flow
 * and the tag bindings all keep working with no mirror to fall out of sync. A manifest is what
 * turns "borrow 28 controls" from prose into something a test can count.
 *
 * ── v2 in one paragraph ───────────────────────────────────────────────────────────────────
 * v0's four tabs mirrored ST's settings one for one. v2 is one scrolling page of CHAPTERS in
 * the order a character gets written (who, how it begins, how they look, how they talk), plus
 * two Advanced chapters (their world, under the hood) that a Simple reader never sees. Levels
 * are DATA here and an attribute in the sheet: the studio renders every chapter and every slot
 * on every pass and hides with `hidden`, because a conditional render would let lit-html tear a
 * borrowed control out of the document.
 */

/**
 * The open request. Bubbling + composed, like `k-open-library` and `k-open-branch-map`.
 *
 * It lives HERE, in the DOM-free module, rather than in `k-card-studio.js`, for one structural
 * reason: `<k-library>` dispatches it and `<k-card-studio>` imports `renderCard()` from
 * `<k-library>`. Declaring the name in the element would make those two files a cycle. This
 * module imports nothing, so both can depend on it and the graph stays one-directional.
 *
 * `detail.target` is `'create'` or a character index.
 */
export const OPEN_STUDIO_EVENT = 'k-open-card-studio';

/** `accountStorage` key for the reader's Simple / Advanced choice. */
export const STUDIO_VIEW_KEY = 'kotatsu-studio-view';

/** @typedef {'simple'|'advanced'} StudioLevel */

/**
 * One relocated control.
 * @typedef {object} StudioSlot
 * @property {string} key Unique across the whole manifest. Becomes `data-slot` in the sheet.
 * @property {string} selector What to relocate. An `#id` wherever core gives one; the one
 *   exception is documented at its entry.
 * @property {string} [counter] `data-token-counter` value whose `.extension_token_counter`
 *   block rides along into the same slot, so the count sits under the field it describes.
 * @property {boolean} [optional] True when core may legitimately not have this node in the
 *   current mode.
 */

/**
 * One labelled row in a chapter.
 * @typedef {object} StudioField
 * @property {string} label Kotatsu's own label. `{name}` becomes the character's name.
 * @property {string} [stName] ST's own name for the field, printed beside ours in Advanced so
 *   a reader who knows ST (or a guide written for it) can find it.
 * @property {string} [hint] One line under the label. Says the thing the label cannot.
 * @property {'full'|'half'} [span] Grid width inside the chapter. Default `full`.
 * @property {'field'|'actions'|'opening'|'openings'} [kind] `actions` lays its slots out as a button row;
 *   `opening` is ②'s first message (its slot under a rendered preview, `<k-opening-preview>`);
 *   `openings` is an actions row with a tile per opening above it.
 * @property {StudioLevel} [level] `advanced` hides the row in Simple. Default `simple`.
 * @property {ReadonlyArray<StudioSlot>} slots The controls this row borrows.
 */

/**
 * One chapter of the page.
 * @typedef {object} StudioChapter
 * @property {string} id
 * @property {string} title `{name}` becomes the character's name. Never a pronoun: Kotatsu cannot
 *   know a character's.
 * @property {string} short The chapter bar's label (also `{name}`-templated).
 * @property {string} blurb One line under the chapter title.
 * @property {StudioLevel} level `advanced` chapters are hidden (and greyed in the bar) in Simple.
 * @property {ReadonlyArray<StudioField>} fields
 */

/**
 * The hero's borrowed controls: the character themselves, beside every chapter.
 *
 * `#avatar_div_div` is relocated as a WHOLE LABEL, not as its hidden `#add_avatar_button`
 * input: the create path replaces that input outright at
 * `$('#add_avatar_button').replaceWith($('#add_avatar_button').val('').clone(true))`
 * (`script.js:10195`, and again on the edit branch at `:10244`). An anchor recorded against the
 * input would be recorded against a node that no longer exists, and the clone would live in the
 * studio forever. The label survives both replacements because it is the clone's parent.
 *
 * `#name_div` is create-only. Edit mode has no name INPUT on purpose, and that is core's call:
 * `select_selected_character()` puts `.displayNone` on `#name_div` (`script.js:9168`), a
 * `display: none !important` class (`style.css:3154`), because renaming a character is a file
 * operation with its own flow. In edit mode the hero prints the name and proxies that flow.
 * @type {ReadonlyArray<StudioSlot & { only?: 'create'|'edit' }>}
 */
export const HERO_SLOTS = Object.freeze([
    { key: 'hero.portrait', selector: '#avatar_div_div' },
    { key: 'hero.fav', selector: '#favorite_button' },
    { key: 'hero.name', selector: '#name_div', only: 'create' },
    { key: 'hero.tags', selector: '#tags_div' },
]);

/**
 * The card menu's borrowed controls: the file operations, behind ⋯.
 *
 * Export, Duplicate and Delete are the REAL core buttons, relocated into the menu panel, so
 * core's own handlers (and Delete's confirm with its "also delete chats" box) stay the only
 * implementation. `#delete_button`'s display stays core's: `flex` in edit (`script.js:9109`),
 * `none` in create (`script.js:9205`); the menu never writes `display` on it.
 *
 * `#char-management-dropdown` is relocated and visually hidden: Kotatsu's own menu items and
 * chapter buttons are PROXIES that select one of its options and fire its change handler
 * (`script.js:12852`), see {@link DROPDOWN_ACTIONS}. Options an extension adds to it are
 * listed in the menu under "From extensions", so third-party entries keep working.
 * @type {ReadonlyArray<StudioSlot>}
 */
export const MENU_SLOTS = Object.freeze([
    { key: 'menu.export', selector: '#export_button' },
    { key: 'menu.dupe', selector: '#dupe_button' },
    { key: 'menu.more', selector: '#char-management-dropdown' },
    { key: 'menu.delete', selector: '#delete_button' },
]);

/**
 * The core dropdown options Kotatsu proxies, by option id. Each lands where it belongs instead of
 * in one "More…" list: rename beside the name, the lorebook in ⑤, chat overrides under the hood,
 * the persona in the card menu.
 */
export const DROPDOWN_ACTIONS = Object.freeze({
    rename: 'renameCharButton',
    linkWorld: 'set_character_world',
    importLore: 'import_character_info',
    chatOverrides: 'set_chat_character_settings',
    persona: 'convert_to_persona',
});

/**
 * The six chapters, in the order a character gets written.
 * @type {ReadonlyArray<StudioChapter>}
 */
export const CHAPTERS = Object.freeze(/** @type {StudioChapter[]} */ ([
    {
        id: 'who',
        title: 'Who {name} is',
        short: 'Who {name} is',
        blurb: 'Both fields travel with every message. Write them the way you would introduce {name} to a friend.',
        level: 'simple',
        fields: Object.freeze([
            {
                label: 'Description',
                stName: 'description',
                hint: 'Always in the story',
                slots: [{ key: 'who.description', selector: '#description_textarea', counter: 'description_textarea' }],
            },
            {
                label: 'In a few words',
                stName: 'personality',
                hint: 'A back-cover blurb, not a second description',
                slots: [{ key: 'who.personality', selector: '#personality_textarea', counter: 'personality_textarea' }],
            },
        ]),
    },
    {
        id: 'begin',
        title: 'How it begins',
        short: 'How it begins',
        blurb: 'What a player sees the moment a chat with {name} opens.',
        level: 'simple',
        fields: Object.freeze([
            {
                label: 'Where we are',
                stName: 'scenario',
                hint: 'Always in the story',
                slots: [{ key: 'begin.scenario', selector: '#scenario_pole', counter: 'scenario_pole' }],
            },
            {
                label: 'The first message',
                stName: 'first message',
                hint: 'Sent once, to open every new chat',
                kind: 'opening',
                slots: [{ key: 'begin.first', selector: '#firstmessage_textarea', counter: 'firstmessage_textarea' }],
            },
            {
                label: 'Other openings',
                stName: 'alternate greetings',
                hint: 'Players swipe between openings before they reply',
                kind: 'openings',
                // The one class selector in the manifest: core ships this button with no id
                // (`index.html:6287`) and its handler is delegated off the document
                // (`script.js:12673`), so the class IS its identity. `.data('chid')` is set on
                // it by both mode setters, which is how the popup knows whose greetings to
                // edit — relocation cannot disturb jQuery data, which lives in a WeakMap-alike
                // keyed on the element.
                slots: [{ key: 'begin.alts', selector: '.open_alternate_greetings' }],
            },
        ]),
    },
    {
        id: 'looks',
        title: 'How {name} looks',
        short: 'How {name} looks',
        blurb: 'Every face {name} makes on the stage, big enough to judge.',
        level: 'simple',
        // All Kotatsu markup (`<k-sprite-studio>` and the picture Look): nothing borrowed.
        fields: Object.freeze([]),
    },
    {
        id: 'talks',
        title: 'How {name} talks',
        short: 'How {name} talks',
        blurb: 'Show the model how {name} sounds. Two short scenes teach more than a paragraph of rules.',
        level: 'simple',
        fields: Object.freeze([
            {
                label: 'Example lines',
                stName: 'example dialogue',
                hint: 'Kept while there is room. Begin each scene with <START>',
                slots: [{ key: 'talks.examples', selector: '#mes_example_textarea', counter: 'mes_example_textarea' }],
            },
            {
                label: 'In a group scene, {name} speaks up…',
                stName: 'talkativeness',
                hint: 'Only used when {name} shares a scene',
                // The whole `#talkativeness_div`, not the bare slider: the Shy / Normal /
                // Chatty legend is a sibling `.slider_hint` with no id of its own, and a
                // slider with no legend is a number nobody can read.
                slots: [{ key: 'talks.talkativeness', selector: '#talkativeness_div' }],
            },
        ]),
    },
    {
        id: 'world',
        title: '{name}’s world',
        short: '{name}’s world',
        blurb: 'Lore that comes up when the chat mentions it. An entry only costs tokens on the turns it is triggered.',
        level: 'advanced',
        fields: Object.freeze([
            {
                label: 'Lorebook',
                stName: 'character lore',
                hint: 'Click to open it; shift-click (or the button beside it) to link another',
                kind: 'actions',
                level: 'advanced',
                slots: [{ key: 'world.book', selector: '#world_button' }],
            },
        ]),
    },
    {
        id: 'hood',
        title: 'Under the hood',
        short: 'Under the hood',
        blurb: 'Levers for people who steer the prompt. All optional: an empty lever means your preset decides.',
        level: 'advanced',
        fields: Object.freeze([
            {
                label: 'Character’s note',
                stName: 'character’s note',
                hint: 'Read close to the newest message, so it never drifts far',
                level: 'advanced',
                slots: [{ key: 'hood.depth', selector: '#depth_prompt_prompt', counter: 'depth_prompt_prompt' }],
            },
            {
                label: 'Messages from the newest',
                stName: 'depth',
                span: 'half',
                level: 'advanced',
                slots: [{ key: 'hood.depthdepth', selector: '#depth_prompt_depth' }],
            },
            {
                label: 'Speaks as',
                stName: 'role',
                span: 'half',
                level: 'advanced',
                slots: [{ key: 'hood.depthrole', selector: '#depth_prompt_role' }],
            },
            {
                label: 'Main prompt, just for {name}',
                stName: 'main prompt override',
                hint: 'Empty: your preset’s is used. {{original}} inserts it',
                level: 'advanced',
                slots: [{ key: 'hood.system', selector: '#system_prompt_textarea', counter: 'system_prompt_textarea' }],
            },
            {
                label: 'A last word, after the chat',
                stName: 'post-history instructions',
                hint: 'Empty: nothing is added. {{original}} inserts your preset’s',
                level: 'advanced',
                slots: [{ key: 'hood.posthistory', selector: '#post_history_instructions_textarea', counter: 'post_history_instructions_textarea' }],
            },
            {
                label: 'Pictures from the web in {name}’s messages',
                stName: 'external media',
                hint: 'Your default, always, or never',
                kind: 'actions',
                span: 'half',
                level: 'advanced',
                slots: [{ key: 'hood.media', selector: '#character_open_media_overrides' }],
            },
            {
                label: 'Who you are with {name}',
                stName: 'connected personas',
                hint: 'A persona that switches on with this character',
                kind: 'actions',
                span: 'half',
                level: 'advanced',
                slots: [{ key: 'hood.connections', selector: '#char_connections_button' }],
            },
            {
                label: 'Made by',
                stName: 'creator',
                span: 'half',
                level: 'advanced',
                slots: [{ key: 'hood.creator', selector: '#creator_textarea' }],
            },
            {
                label: 'Version',
                stName: 'character version',
                span: 'half',
                level: 'advanced',
                slots: [{ key: 'hood.version', selector: '#character_version_textarea' }],
            },
            {
                label: 'Notes for whoever gets the card',
                stName: 'creator’s notes',
                hint: 'Never sent to the model. The library card borrows its first sentence when there is no tagline',
                level: 'advanced',
                slots: [{ key: 'hood.notes', selector: '#creator_notes_textarea' }],
            },
            {
                label: 'Notes preview',
                hint: 'Styles and spoiler visibility',
                level: 'advanced',
                slots: [{ key: 'hood.spoiler', selector: '#spoiler_free_desc' }],
            },
            {
                label: 'Tags written into the file',
                stName: 'tags to embed',
                level: 'advanced',
                slots: [{ key: 'hood.embedtags', selector: '#tags_textarea' }],
            },
        ]),
    },
]));

/** The chapter that wears the gear instead of a number, and never shows in Simple's bar. */
export const HOOD_CHAPTER = 'hood';

/** @type {ReadonlyMap<string, number>} */
const CHAPTER_NUMBERS = new Map(CHAPTERS.filter(chapter => chapter.id !== HOOD_CHAPTER).map((chapter, index) => [chapter.id, index + 1]));

/**
 * The number a chapter wears, in the bar and on its heading: 1.. in page order, Under the hood
 * skipped (it wears the gear).
 * @param {string} id A chapter id.
 * @returns {number|null} null for Under the hood or an unknown id.
 */
export function chapterNumber(id) {
    return CHAPTER_NUMBERS.get(id) ?? null;
}

/**
 * The next-step keys each chapter's tick in the bar waits for. ② ticks without a second opening:
 * that step makes a card better, the tick says the chapter is written.
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const CHAPTER_DONE_KEYS = Object.freeze({
    who: Object.freeze(['name', 'description', 'personality']),
    begin: Object.freeze(['scenario', 'first_mes']),
    looks: Object.freeze(['sprites']),
    talks: Object.freeze(['examples']),
});

/**
 * Whether a chapter shows its tick in the bar.
 * @param {string} id A chapter id.
 * @param {ReadonlyArray<string>} missing `nextStep().missing`.
 * @param {boolean} hasSprites The card has any sprite: ③ never ticks for a card with none.
 * @returns {boolean} False for the chapters that have nothing to finish (⑤, Under the hood).
 */
export function chapterDone(id, missing, hasSprites) {
    const keys = CHAPTER_DONE_KEYS[id];
    if (!keys || (id === 'looks' && !hasSprites)) return false;
    return !keys.some(key => missing.includes(key));
}

/** Whitespace-only is empty: a field holding one space is not a written field. */
const isFilled = (/** @type {unknown} */ text) => typeof text === 'string' && text.trim().length > 0;

/**
 * Puts the character's name into a chapter or field template.
 *
 * Create mode has no name yet, and a pronoun is not a fallback Kotatsu can honestly use, so the
 * template reads "your character" there.
 * @param {string} template A title, label or blurb with `{name}`.
 * @param {string} [name] The character's name.
 * @returns {string}
 */
export function named(template, name) {
    const who = String(name ?? '').trim();
    if (!who) {
        // `{name}’s` reads "your character’s"; a bare `{name}` at the start of a sentence stays lower case
        // because every template that starts with it is a heading the sheet sets in display type.
        return String(template).replaceAll('{name}', 'your character');
    }
    return String(template).replaceAll('{name}', who);
}

/**
 * The name chapters and labels use: the first word of a long name ("How Hana looks", not "How
 * Hana Kurogane looks", which the chapter bar cannot fit), the whole name when it is short or when
 * its first word is an article ("The Westeros Chronicle" stays whole; "The" is not a name).
 * The hero always prints the full name.
 * @param {string} [name]
 * @returns {string}
 */
export function shortName(name) {
    const full = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (full.length <= 12) return full;
    const first = full.split(' ')[0];
    if (/^(the|a|an)$/i.test(first) || first.length < 2) return full;
    return first;
}

/**
 * The five fields the readiness count starts from (v0 §2.2), kept for the probe's `.state`.
 *
 * Honest by construction: core requires only a NAME (`script.js:10116` is the one hard gate),
 * so this is encouragement, not validation, and the copy in the sheet says so.
 * @type {ReadonlyArray<{ key: string, selector: string, label: string }>}
 */
export const READINESS_FIELDS = Object.freeze([
    { key: 'name', selector: '#character_name_pole', label: 'name' },
    { key: 'description', selector: '#description_textarea', label: 'description' },
    { key: 'personality', selector: '#personality_textarea', label: 'personality' },
    { key: 'scenario', selector: '#scenario_pole', label: 'scenario' },
    { key: 'first_mes', selector: '#firstmessage_textarea', label: 'first message' },
]);

/**
 * Counts a card's readiness from already-read field values.
 *
 * Takes VALUES, not elements, so it is testable without a document. Whitespace-only counts as
 * empty — a field holding one space is not a described character.
 * @param {Record<string, string|null|undefined>} values Keyed by {@link READINESS_FIELDS} key.
 * @returns {{ filled: number, total: number, missing: string[] }} Score and what is absent.
 */
export function readiness(values) {
    const source = values && typeof values === 'object' ? values : {};
    /** @type {string[]} */
    const missing = [];
    let filled = 0;
    for (const field of READINESS_FIELDS) {
        if (isFilled(source[field.key])) {
            filled += 1;
        } else {
            missing.push(field.label);
        }
    }
    return { filled, total: READINESS_FIELDS.length, missing };
}

/**
 * One step of the next-step strip.
 * @typedef {object} StudioStep
 * @property {string} key
 * @property {string} chapter Chapter id the step's button scrolls to.
 * @property {string} title "Next: …" copy, `{name}`-templated.
 * @property {string} why One sentence on why it helps.
 */

/**
 * The next-step checklist, in the order the strip offers it: the five load-bearing fields, then
 * what makes a card good rather than merely complete. Sprites count only when the card has some
 * (a card with none is not "missing" them; Pictures can draw a set, but that is a choice).
 * @type {ReadonlyArray<StudioStep>}
 */
export const STEPS = Object.freeze([
    { key: 'name', chapter: 'who', title: 'give your character a name.', why: 'It is the only field a card must have.' },
    { key: 'description', chapter: 'who', title: 'say who {name} is.', why: 'The description travels with every message; it is most of what the model knows.' },
    { key: 'personality', chapter: 'who', title: 'sum {name} up in a few words.', why: 'A one-line blurb keeps the voice steady when the description is long.' },
    { key: 'scenario', chapter: 'begin', title: 'set the scene.', why: 'Where and when the story opens, so the first reply lands somewhere.' },
    { key: 'first_mes', chapter: 'begin', title: 'write the first message.', why: 'It is what a player reads before they type anything.' },
    { key: 'openings', chapter: 'begin', title: 'give players another way to begin.', why: 'A second opening lets a new chat start somewhere else, and a reroll at the very start has somewhere to go.' },
    { key: 'examples', chapter: 'talks', title: 'show how {name} talks.', why: 'Two short example scenes teach the voice better than any description.' },
    { key: 'sprites', chapter: 'looks', title: 'draw the missing faces.', why: 'The stage falls back to the nearest feeling when one is missing.' },
]);

/**
 * Works out the next step from already-read values.
 * @param {{ name?: string, description?: string, personality?: string, scenario?: string, first_mes?: string,
 *   openings?: number, mes_example?: string, spritesMissing?: number|null }} values `openings` = alternate
 *   greetings count; `spritesMissing` = missing main feelings, or null when the card has no sprites at all.
 * @returns {{ done: number, total: number, next: StudioStep|null, missing: string[] }}
 */
export function nextStep(values) {
    const v = values && typeof values === 'object' ? values : {};
    const steps = STEPS.filter(step => step.key !== 'sprites' || typeof v.spritesMissing === 'number');
    const done = (/** @type {StudioStep} */ step) => {
        switch (step.key) {
            case 'openings': return Number(v.openings ?? 0) > 0;
            case 'examples': return isFilled(v.mes_example);
            case 'sprites': return Number(v.spritesMissing ?? 0) === 0;
            default: return isFilled(/** @type {any} */ (v)[step.key]);
        }
    };
    const missing = steps.filter(step => !done(step)).map(step => step.key);
    return {
        done: steps.length - missing.length,
        total: steps.length,
        next: steps.find(step => !done(step)) ?? null,
        missing,
    };
}

/**
 * How core's per-field counters read in the token breakdown. Keyed by `data-token-counter`.
 * `group`: `always` = core marks it permanent (in the story every turn); `once` = the first
 * message; `room` = example lines (kept while there is room); `lever` = the two prompt overrides,
 * which REPLACE or add to the preset rather than sit in the story.
 */
export const TOKEN_FIELDS = Object.freeze({
    character_name_pole: { label: 'Name', group: 'always' },
    description_textarea: { label: 'Description', group: 'always' },
    personality_textarea: { label: 'In a few words', group: 'always' },
    scenario_pole: { label: 'Where we are', group: 'always' },
    depth_prompt_prompt: { label: 'Character’s note', group: 'always' },
    firstmessage_textarea: { label: 'First message', group: 'once' },
    mes_example_textarea: { label: 'Example lines', group: 'room' },
    system_prompt_textarea: { label: 'Main prompt override', group: 'lever' },
    post_history_instructions_textarea: { label: 'A last word', group: 'lever' },
});

/**
 * Turns core's counter readings into the chip's numbers.
 *
 * Core is the counter (`RA_CountCharTokens`, `RossAscends-mods.js:215`); this only sorts and sums
 * what it wrote, so the chip can never disagree with the numbers under the fields. A counter
 * core marks permanent counts toward the total whatever this table says, and a counter this
 * table does not know is listed under its own id rather than dropped.
 * @param {ReadonlyArray<{ id: string, count: number, permanent: boolean }>} readings
 * @returns {{ total: number, rows: Array<{ id: string, label: string, group: string, count: number }> }}
 */
export function tokenBudget(readings) {
    const rows = [];
    let total = 0;
    for (const reading of readings ?? []) {
        const count = Number.isFinite(reading?.count) ? Math.max(0, Math.round(reading.count)) : 0;
        const known = /** @type {Record<string, {label: string, group: string}>} */ (TOKEN_FIELDS)[reading.id];
        const group = reading.permanent ? 'always' : (known?.group ?? 'other');
        if (reading.permanent) total += count;
        rows.push({ id: reading.id, label: known?.label ?? reading.id, group, count });
    }
    return { total, rows };
}

/**
 * The sheet's title (the dialog's accessible name).
 *
 * Create mode never interpolates a name — the field is empty by definition and "Edit " reads
 * as a bug. Edit mode with no resolvable name falls back to the generic rather than printing
 * "Edit undefined".
 * @param {'create'|'edit'} mode Which mode the form is in.
 * @param {string} [name] The character's name, in edit mode.
 * @returns {string}
 */
export function modeTitle(mode, name) {
    if (mode !== 'edit') {
        return 'Create a character';
    }
    const trimmed = String(name ?? '').trim();
    return trimmed ? `Edit ${trimmed}` : 'Edit this character';
}

/**
 * Every slot in the manifest — hero, chapters, menu — in relocation order.
 *
 * Relocation order matters for one reason and it is not cosmetic: `restoreAll()` replays the
 * list in REVERSE, so a slot whose anchor sits inside another relocated node must be recorded
 * after it. Nothing nests that way (every anchor parent stays in `#rm_ch_create_block` or
 * `#character_popup`), but the ordering is preserved so that when one does, the reverse replay
 * is already correct.
 * @param {'create'|'edit'} [mode] Drops `only:` slots for the other mode.
 * @returns {StudioSlot[]} A fresh array; the frozen manifest is untouched.
 */
export function allSlots(mode) {
    /** @type {StudioSlot[]} */
    const slots = HERO_SLOTS.filter(slot => !mode || !slot.only || slot.only === mode);
    for (const chapter of CHAPTERS) {
        for (const field of chapter.fields) {
            slots.push(...field.slots);
        }
    }
    slots.push(...MENU_SLOTS);
    return slots;
}

/**
 * Every slot key in the manifest, unconditionally (mode filters do not apply).
 *
 * The test surface for invariant 1. Returned with duplicates intact so a caller can measure
 * them; `new Set(slotKeys()).size === slotKeys().length` is the assertion.
 * @returns {string[]} Keys in manifest order, duplicates included.
 */
export function slotKeys() {
    return allSlots().map(slot => slot.key);
}

/**
 * Every selector the manifest relocates, unconditionally.
 * @returns {string[]} Selectors in manifest order, duplicates included.
 */
export function slotSelectors() {
    return allSlots().map(slot => slot.selector);
}

/**
 * Where a slot key lives.
 * @param {string} key A slot key.
 * @returns {string|null} `'hero'`, `'menu'`, a chapter id, or null when the key is unknown.
 */
export function ownerOf(key) {
    if (HERO_SLOTS.some(slot => slot.key === key)) return 'hero';
    if (MENU_SLOTS.some(slot => slot.key === key)) return 'menu';
    for (const chapter of CHAPTERS) {
        for (const field of chapter.fields) {
            if (field.slots.some(slot => slot.key === key)) return chapter.id;
        }
    }
    return null;
}

/**
 * The level a field is shown at: its own, else its chapter's.
 * @param {StudioChapter} chapter
 * @param {StudioField} field
 * @returns {StudioLevel}
 */
export function levelOf(chapter, field) {
    return field.level ?? chapter.level ?? 'simple';
}

/**
 * Which ADVANCED-only levers are set, so Simple can say so ("Simple never hides something that
 * is ON", doc §Simple and Advanced). Takes values, not elements.
 * @param {{ depth_prompt?: string, system_prompt?: string, post_history?: string, world?: string }} values
 * @returns {string[]} Human names of the set levers, in chapter order.
 */
export function advancedInUse(values) {
    const v = values && typeof values === 'object' ? values : {};
    /** @type {string[]} */
    const set = [];
    if (isFilled(v.world)) set.push('a lorebook');
    if (isFilled(v.depth_prompt)) set.push('a character’s note');
    if (isFilled(v.system_prompt)) set.push('a main prompt override');
    if (isFilled(v.post_history)) set.push('a last word after the chat');
    return set;
}
