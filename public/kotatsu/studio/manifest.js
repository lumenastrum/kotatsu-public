/**
 * `<k-card-studio>`'s field manifest — `docs/library-v0.md` §2.2.
 *
 * DOM-free by contract, exactly like `library/view-model.js`: this module says WHICH core
 * control belongs in WHICH tab, what Kotatsu calls it, and how "ready" a card is. It never
 * queries the document, never renders and never imports core. `k-card-studio.js` is the only
 * file in this folder that touches DOM. That split is what lets
 * `tests/studio-manifest.test.js` measure the partition instead of vibing it.
 *
 * Two invariants the unit test enforces, both of which are real bugs if they ever break:
 *
 * 1. **Exactly-once partition.** Every slot key appears in exactly one place across the rail,
 *    the four tabs and the footer, and every selector is relocated from exactly one slot. A
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
 * turns "borrow 30-odd controls" from prose into something a test can count.
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

/**
 * One relocated control.
 * @typedef {object} StudioSlot
 * @property {string} key Unique across the whole manifest. Becomes `data-slot` in the sheet.
 * @property {string} selector What to relocate. An `#id` wherever core gives one; the two
 *   exceptions are documented at their entries.
 * @property {string} [counter] `data-token-counter` value whose `.extension_token_counter`
 *   block rides along into the same slot, so the count sits under the field it describes.
 * @property {boolean} [optional] True when core may legitimately not have this node in the
 *   current mode. Nothing is optional in v0; the flag exists so a future mode can say so
 *   rather than warning.
 */

/**
 * One labelled row in a tab.
 * @typedef {object} StudioField
 * @property {string} label Kotatsu's own micro-caps label. Never core's.
 * @property {string} [hint] Right-aligned, muted. Says the thing the label cannot.
 * @property {'full'|'half'} [span] Grid width inside the panel. Default `full`.
 * @property {'field'|'actions'|'readonly'} [kind] `actions` lays its slots out as a button row;
 *   `readonly` borrows nothing and prints a Kotatsu-owned value instead.
 * @property {'create'|'edit'} [only] Render this row in one mode only.
 * @property {ReadonlyArray<StudioSlot>} slots The controls this row borrows.
 */

/**
 * One tab of the right pane.
 * @typedef {object} StudioTab
 * @property {string} id
 * @property {string} label
 * @property {string} blurb One line under the tab strip. Narrative-stage disclosure needs to
 *   say what stage you are on.
 * @property {ReadonlyArray<StudioField>} fields
 */

/**
 * The left rail's borrowed controls (doc §2.2 "Left rail").
 *
 * `#avatar_div_div` is relocated as a WHOLE LABEL, not as its hidden `#add_avatar_button`
 * input: the create path replaces that input outright at
 * `$('#add_avatar_button').replaceWith($('#add_avatar_button').val('').clone(true))`
 * (`script.js:10195`, and again on the edit branch at `:10244`). An anchor recorded against the
 * input would be recorded against a node that no longer exists, and the clone would live in the
 * studio forever. The label survives both replacements because it is the clone's parent.
 * @type {ReadonlyArray<StudioSlot>}
 */
export const RAIL_SLOTS = Object.freeze([
    { key: 'rail.portrait', selector: '#avatar_div_div' },
    { key: 'rail.fav', selector: '#favorite_button' },
]);

/**
 * The footer's one borrowed control.
 *
 * Only `#delete_button` is real. Cancel is Kotatsu's own, and the primary PROXIES
 * `#create_button` with a real `.click()` rather than relocating it — a relocated
 * `<input type="submit">` inside a `<label id="create_button_label">` whose display core
 * toggles per mode (`script.js:9117` hides the label in edit, `:9204` shows it in create) would
 * have the studio fighting core for the button's visibility. Proxying leaves that fight
 * unfought and keeps `saveCharacterDebounced()` (`script.js:533`, a `.trigger('click')` on the
 * same node) pointed at a button nobody moved.
 *
 * `#delete_button`'s own display is likewise core's: `flex` in edit (`script.js:9109`), `none`
 * in create (`script.js:9205`). The footer never writes `display` on it — the mode drives it,
 * exactly as in the drawer.
 * @type {ReadonlyArray<StudioSlot>}
 */
export const FOOTER_SLOTS = Object.freeze([
    { key: 'foot.delete', selector: '#delete_button' },
]);

/**
 * The four tabs — narrative-stage disclosure (doc §2.2).
 *
 * Order is the order a card gets written: who they are, how the scene opens, how the model is
 * steered, what the file carries. It is not the order `index.html` happens to declare them in.
 * @type {ReadonlyArray<StudioTab>}
 */
export const TABS = Object.freeze(/** @type {StudioTab[]} */ ([
    {
        id: 'identity',
        label: 'Identity',
        blurb: 'Who they are before anything happens.',
        fields: Object.freeze([
            {
                label: 'Name',
                hint: 'The card’s filename comes from this',
                only: 'create',
                slots: [{ key: 'identity.name', selector: '#name_div' }],
            },
            {
                // Edit mode has no name INPUT on purpose, and that is core's call, not ours:
                // `select_selected_character()` puts `.displayNone` on `#name_div`
                // (`script.js:9168`), a `display: none !important` class (`style.css:3154`),
                // because renaming a character is a file operation with its own flow rather
                // than a form field. The studio prints the name and points at that flow instead
                // of relocating a control core has deliberately hidden and then fighting an
                // `!important` to show it.
                label: 'Name',
                hint: 'Rename from Card data → More…',
                only: 'edit',
                kind: 'readonly',
                slots: [],
            },
            {
                label: 'Description',
                hint: 'Always in context',
                slots: [{
                    key: 'identity.description',
                    selector: '#description_textarea',
                    counter: 'description_textarea',
                }],
            },
            {
                label: 'Personality',
                hint: 'A summary, not a second description',
                slots: [{
                    key: 'identity.personality',
                    selector: '#personality_textarea',
                    counter: 'personality_textarea',
                }],
            },
            {
                label: 'Tags',
                hint: 'Yours — they live in this library, not in the card file',
                slots: [{ key: 'identity.tags', selector: '#tags_div' }],
            },
            {
                label: 'Created by',
                span: 'half',
                slots: [{ key: 'identity.creator', selector: '#creator_textarea' }],
            },
            {
                label: 'Card version',
                span: 'half',
                slots: [{ key: 'identity.version', selector: '#character_version_textarea' }],
            },
        ]),
    },
    {
        id: 'scene',
        label: 'Opening scene',
        blurb: 'The first thing that happens, every time.',
        fields: Object.freeze([
            {
                label: 'Scenario',
                hint: 'Circumstances and context',
                slots: [{ key: 'scene.scenario', selector: '#scenario_pole', counter: 'scenario_pole' }],
            },
            {
                label: 'First message',
                hint: 'Opens every new chat',
                slots: [{
                    key: 'scene.first',
                    selector: '#firstmessage_textarea',
                    counter: 'firstmessage_textarea',
                }],
            },
            {
                label: 'Alternate greetings',
                hint: 'Opens core’s editor — a popup in v0',
                kind: 'actions',
                // The one class selector in the manifest: core ships this button with no id
                // (`index.html:6287`) and its handler is delegated off the document
                // (`script.js:12673`), so the class IS its identity. `.data('chid')` is set on
                // it by both mode setters, which is how the popup knows whose greetings to
                // edit — relocation cannot disturb jQuery data, which lives in a WeakMap-alike
                // keyed on the element.
                slots: [{ key: 'scene.alts', selector: '.open_alternate_greetings' }],
            },
        ]),
    },
    {
        id: 'prompting',
        label: 'Prompting',
        blurb: 'How the model is steered while they talk.',
        fields: Object.freeze([
            {
                label: 'Main prompt override',
                hint: '{{original}} inserts the default',
                slots: [{
                    key: 'prompt.system',
                    selector: '#system_prompt_textarea',
                    counter: 'system_prompt_textarea',
                }],
            },
            {
                label: 'Post-history instructions',
                hint: '{{original}} inserts the default',
                slots: [{
                    key: 'prompt.posthistory',
                    selector: '#post_history_instructions_textarea',
                    counter: 'post_history_instructions_textarea',
                }],
            },
            {
                label: 'Character’s note',
                hint: 'Injected in-chat at a fixed depth',
                slots: [{
                    key: 'prompt.depth',
                    selector: '#depth_prompt_prompt',
                    counter: 'depth_prompt_prompt',
                }],
            },
            {
                label: 'At depth',
                span: 'half',
                slots: [{ key: 'prompt.depthdepth', selector: '#depth_prompt_depth' }],
            },
            {
                label: 'As role',
                span: 'half',
                slots: [{ key: 'prompt.depthrole', selector: '#depth_prompt_role' }],
            },
            {
                label: 'Talkativeness',
                hint: 'Group chats only',
                // The whole `#talkativeness_div`, not the bare slider: the Shy / Normal /
                // Chatty legend is a sibling `.slider_hint` with no id of its own, and a
                // slider with no legend is a number nobody can read.
                slots: [{ key: 'prompt.talkativeness', selector: '#talkativeness_div' }],
            },
            {
                label: 'Example dialogue',
                hint: 'Begin each example with <START>',
                slots: [{
                    key: 'prompt.examples',
                    selector: '#mes_example_textarea',
                    counter: 'mes_example_textarea',
                }],
            },
        ]),
    },
    {
        id: 'card',
        label: 'Card data',
        blurb: 'What travels with the file when you share it.',
        fields: Object.freeze([
            {
                label: 'Creator’s notes',
                hint: 'Never sent to the model — and the card’s epithet comes from here',
                slots: [{ key: 'card.notes', selector: '#creator_notes_textarea' }],
            },
            {
                label: 'Notes preview',
                hint: 'Styles and spoiler visibility',
                slots: [{ key: 'card.spoiler', selector: '#spoiler_free_desc' }],
            },
            {
                label: 'Tags to embed',
                hint: 'Written into the card file itself',
                slots: [{ key: 'card.embedtags', selector: '#tags_textarea' }],
            },
            {
                label: 'Attachments and links',
                kind: 'actions',
                slots: [
                    { key: 'card.world', selector: '#world_button' },
                    { key: 'card.media', selector: '#character_open_media_overrides' },
                    { key: 'card.connections', selector: '#char_connections_button' },
                    { key: 'card.export', selector: '#export_button' },
                    { key: 'card.dupe', selector: '#dupe_button' },
                ],
            },
            {
                label: 'More…',
                hint: 'Rename, convert, replace, link to source',
                slots: [{ key: 'card.more', selector: '#char-management-dropdown' }],
            },
        ]),
    },
]));

/**
 * The five fields the readiness meter counts (doc §2.2).
 *
 * Honest by construction: core requires only a NAME (`script.js:10116` is the one hard gate),
 * so this is encouragement, not validation, and the copy in the sheet says so. The set is the
 * doc's and is frozen here so the meter, the missing-field list and the unit all read one list.
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
        const value = source[field.key];
        if (typeof value === 'string' && value.trim().length > 0) {
            filled += 1;
        } else {
            missing.push(field.label);
        }
    }
    return { filled, total: READINESS_FIELDS.length, missing };
}

/**
 * The sheet's title.
 *
 * Create mode never interpolates a name — the field is empty by definition and "Edit " reads
 * as a bug. Edit mode with no resolvable name falls back to the generic rather than printing
 * "Edit undefined".
 * @param {'create'|'edit'} mode Which mode the form is in.
 * @param {string} [name] The character's name, in edit mode.
 * @returns {string} The serif title.
 */
export function modeTitle(mode, name) {
    if (mode !== 'edit') {
        return 'Create a character';
    }
    const trimmed = String(name ?? '').trim();
    return trimmed ? `Edit ${trimmed}` : 'Edit this character';
}

/**
 * Every slot in the manifest, rail and footer included, in relocation order.
 *
 * Relocation order matters for one reason and it is not cosmetic: `restoreAll()` replays the
 * list in REVERSE, so a slot whose anchor sits inside another relocated node must be recorded
 * after it. Nothing in v0 nests that way (every anchor parent stays in `#rm_ch_create_block`
 * or `#character_popup`), but the ordering is preserved so that when one does, the reverse
 * replay is already correct.
 * @param {'create'|'edit'} [mode] Drops `only:` rows for the other mode.
 * @returns {StudioSlot[]} A fresh array; the frozen manifest is untouched.
 */
export function allSlots(mode) {
    /** @type {StudioSlot[]} */
    const slots = [...RAIL_SLOTS];
    for (const tab of TABS) {
        for (const field of tab.fields) {
            if (mode && field.only && field.only !== mode) {
                continue;
            }
            slots.push(...field.slots);
        }
    }
    slots.push(...FOOTER_SLOTS);
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
 * Which tab a slot key lives in.
 * @param {string} key A slot key.
 * @returns {string|null} `'rail'`, `'footer'`, a tab id, or null when the key is unknown.
 */
export function ownerOf(key) {
    if (RAIL_SLOTS.some(slot => slot.key === key)) return 'rail';
    if (FOOTER_SLOTS.some(slot => slot.key === key)) return 'footer';
    for (const tab of TABS) {
        for (const field of tab.fields) {
            if (field.slots.some(slot => slot.key === key)) return tab.id;
        }
    }
    return null;
}
