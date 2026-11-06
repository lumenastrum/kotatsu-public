/**
 * The persona studio's manifest — `docs/persona-gallery-v0.md` §2. DOM-FREE: ids only, so
 * `tests/persona-studio-manifest.test.js` can hold it against `public/index.html` without a
 * browser.
 *
 * Two kinds of borrowing, both "borrow, never mirror":
 *
 * - **Slots** relocate a REAL core control into the studio and put it back on close. Every
 *   control here is bound by id in `initPersonas()` / `power-user.js` (`$('#id').on(...)`), so its
 *   handlers travel with the element. `unit: 'range-block'` borrows the control's
 *   `.range-block` wrapper, so a checkbox keeps its label.
 * - **Proxies** are Kotatsu buttons that fire a real `.click()` on a core button that stays
 *   home. Used for core's Font Awesome icon buttons (Kotatsu UI draws stroke SVG, never FA), and
 *   for anything whose handler reads where it lives.
 *
 * And what is NEVER borrowed (doc §2.1): the stock grid and its template (delegated handlers
 * are scoped to `#user_avatar_block`, `personas.js` initPersonas), the avatar upload form
 * (`changeUserAvatar` builds `new FormData(form_upload_avatar)`, and a form whose inputs left it
 * submits EMPTY with no error), and the two blocks the settings modal adopts whole.
 */

/**
 * @typedef {object} PersonaSlot
 * @property {string} key The `[data-slot]` it lands in.
 * @property {string} id The core control's id.
 * @property {'self'|'range-block'} [unit] What actually moves. Default: the element itself.
 */

/** @type {ReadonlyArray<PersonaSlot>} In placement order. */
export const PERSONA_SLOTS = Object.freeze([
    { key: 'desc', id: 'persona_description' },
    { key: 'position', id: 'persona_description_position' },
    { key: 'depth', id: 'persona_depth_position_settings' },
    { key: 'locks', id: 'persona_connections_buttons' },
    { key: 'conn-info', id: 'persona_connections_info_block' },
    { key: 'conn-list', id: 'persona_connections_list' },
    { key: 'notify', id: 'persona_show_notifications', unit: 'range-block' },
    { key: 'multi', id: 'persona_allow_multi_connections', unit: 'range-block' },
    { key: 'autolock', id: 'persona_auto_lock', unit: 'range-block' },
]);

/** Core buttons the studio clicks but never moves. */
export const PERSONA_PROXIES = Object.freeze({
    image: 'persona_set_image_button',
    rename: 'persona_rename_button',
    sync: 'sync_name_button',
    lore: 'persona_lore_button',
    dropdown: 'persona-management-dropdown',
    lorebookLink: 'persona_lorebook_link',
    duplicate: 'persona_duplicate_button',
    remove: 'persona_delete_button',
});

/** Read, never moved: core's token counter for the description. */
export const PERSONA_TOKEN_COUNTER_ID = 'persona_description_token_count';

/** Ids that must stay exactly where they are (doc §2.1 "Frozen, never relocated"). */
export const NEVER_BORROWED = Object.freeze([
    'persona-suite',
    'persona-management-block',
    'form_upload_avatar',
    'avatar_upload_file',
    'avatar_upload_overwrite',
    'user_avatar_block',
    'user_avatar_template',
]);

/** `accountStorage` key for Simple / Advanced, like the card studio's `kotatsu-studio-view`. */
export const PERSONA_STUDIO_VIEW_KEY = 'kotatsu-persona-studio-view';
