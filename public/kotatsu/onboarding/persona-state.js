/**
 * Mikan-chan's welcome tour — the Persona step's decisions (docs/onboarding-v0.md §2.3, slice
 * O4). No DOM, no core imports: `<k-onboarding>` reads the live persona, hands it here with what
 * the form holds, and does whatever this says through core's own `/persona-update` and
 * `/persona-create`.
 *
 * ── What a new profile actually has ──────────────────────────────────────────────────────────
 * Not "no persona". Core's `addMissingPersonas()` (personas.js) gives every avatar file without
 * an entry the name "[Unnamed Persona]", so a pristine profile has one persona slot on the
 * default avatar, unnamed, already selected. The stock first-run popup this step replaces does
 * not make a new persona: it names that slot (`doOnboarding()`, script.js). So does this. Making
 * a new one would leave every new user with an orphan "[Unnamed Persona]" beside their own.
 *
 * ── Replays ──────────────────────────────────────────────────────────────────────────────────
 * The tour can be taken again from Settings → System on a profile that has a named persona.
 * There the step shows who they already are and writes only what they changed. Either way it
 * edits the ACTIVE persona, and never mints a second one for someone who pressed Next.
 */

/** The name core gives a persona slot nobody has named. */
export const PLACEHOLDER_NAME = '[Unnamed Persona]';

/**
 * @typedef {object} PersonaNow The active persona, as core has it.
 * @property {string} avatarId `user_avatar`: the active persona's avatar file.
 * @property {boolean} exists Whether core has an entry for it at all.
 * @property {string} name Its name ('' when there is no entry).
 * @property {string} description Its description.
 */

/**
 * @typedef {object} PersonaForm What the step's fields hold.
 * @property {string} name
 * @property {string} description
 * @property {string} avatar A data URL of a newly picked image, '' for none.
 */

/**
 * @typedef {object} PersonaPlan
 * @property {'need-name'|'none'|'create'|'update'} action
 * @property {Record<string, string>} args Named arguments for the persona command. An update
 *   names no persona: core's `/persona-update` then edits the active one, which is the point.
 */

/** A persona name longer than this is a paragraph in the wrong box. */
export const NAME_LIMIT = 64;

/**
 * @param {PersonaNow|null|undefined} now The active persona.
 * @returns {boolean} Whether somebody has named it (a replay), as opposed to core's placeholder.
 */
export function isNamed(now) {
    const name = String(now?.name ?? '').trim();
    return Boolean(now?.exists) && name !== '' && name !== PLACEHOLDER_NAME;
}

/**
 * What the fields start as.
 * @param {PersonaNow|null|undefined} now The active persona.
 * @returns {PersonaForm} Who they already are, or blank when nobody has named the slot.
 */
export function initialForm(now) {
    return isNamed(now)
        ? { name: String(now?.name ?? ''), description: String(now?.description ?? ''), avatar: '' }
        : { name: '', description: '', avatar: '' };
}

/**
 * What pressing Next should do.
 * @param {PersonaNow|null|undefined} now The active persona.
 * @param {PersonaForm|null|undefined} form The form.
 * @returns {PersonaPlan} The action and its command arguments.
 */
export function personaPlan(now, form) {
    const name = String(form?.name ?? '').trim().slice(0, NAME_LIMIT);
    const description = String(form?.description ?? '').trim();
    const avatar = String(form?.avatar ?? '');
    if (!name) return { action: 'need-name', args: {} };

    // The crop dialog is a popup; the tour owns Escape while it is up, so a picture is taken as
    // it comes. Personas can re-crop it later.
    /** @type {Record<string, string>} */
    const picture = avatar ? { avatar, avatarPromptResize: 'false' } : {};

    if (!now?.exists) {
        return { action: 'create', args: { name, description, select: 'true', ...picture } };
    }

    /** @type {Record<string, string>} */
    const args = {};
    // An unnamed slot's "name" is core's placeholder, so any name at all is a change.
    if (name !== (isNamed(now) ? String(now.name).trim() : '')) args.name = name;
    if (description !== String(now.description ?? '').trim()) args.description = description;
    Object.assign(args, picture);
    if (Object.keys(args).length === 0) return { action: 'none', args: {} };
    return { action: 'update', args };
}
