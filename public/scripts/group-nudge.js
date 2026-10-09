/**
 * group-nudge — the instruction a scene's speaker reads last (Kotatsu docs/group-chat-v0.md §10).
 *
 * In a group chat every reply is written by one model for one character, with the whole cast in
 * the transcript. SillyTavern closes the chat history with the preset's `group_nudge_prompt`
 * (`openai.js`, inserted at the end of chatHistory). Measured on 2026-10-08:
 * - the most-used presets ship it EMPTY (Marinara 10, Sparkle Sauce), so their scenes get
 *   no instruction at all;
 * - the rest carry stock's one-liner, which names the speaker but never says "and nobody else";
 * and a live reply duly wrote two other members' lines and actions — the #1 group-chat complaint.
 *
 * So when the preset has no nudge of its own (empty, or stock's unedited line), Kotatsu supplies
 * the scene nudge. A nudge a preset author actually wrote is theirs and is sent as-is. The
 * fallback is a setting (`power_user.kotatsu_scene_nudge`, `'on'` | `'off'`, unset means on).
 *
 * Dependency-free on purpose (like `message-rows.js`): `openai.js` imports it, jest tests it.
 */

/** Stock SillyTavern's group nudge, verbatim. Presets that carry it never chose it. */
export const LEGACY_GROUP_NUDGE = '[Write the next reply only as {{char}}.]';

/** Kotatsu's scene nudge. Macros resolve per speaker (`{{notChar}}` = the others, user included). */
export const SCENE_NUDGE = '[Scene turn: {{char}} only.\n{{char}} shares this scene with {{notChar}}. Write {{char}}\'s words, movements, thoughts and choices, and nobody else\'s. {{char}} can see the others\' faces and whatever they are already doing; anything they say or do next is theirs to write in their own turn, so don\'t skip ahead past them or sum up what they would say. {{char}} may speak to, tease, argue with or turn toward any of them, not just {{user}}. End where someone else would naturally answer.]';

/* ── the narrator seat (docs/group-chat-v0.md §12–13) ─────────────────────────────────────────── */

/**
 * A scene's narrator is a Kotatsu-provisioned card flagged `data.extensions.kotatsu.role`. It is
 * seated (always last, always muted) like any member, so stock ST reads it as a muted character;
 * Kotatsu gives it its own seat and its own nudge.
 */
export const NARRATOR_ROLE = 'narrator';

/**
 * @param {any} character A card record from core's `characters`.
 * @returns {boolean} Whether it is a scene narrator.
 */
export function isNarratorCard(character) {
    return character?.data?.extensions?.kotatsu?.role === NARRATOR_ROLE;
}

/**
 * The narrator's own turn — "NARR3" (docs/group-chat-v0.md §12–13). NARR2 kept the cast still
 * when an extra was waiting (Claude 0 of 8 moved anyone), but at an opening with nobody outside
 * the cast DeepSeek's narrator had no job and wrote the cast (2 of 3, incl. a line of Mireille's).
 * NARR3 adds the "nobody outside the cast → only the world" sentence: opening 0 of 4 on DeepSeek
 * and Claude, extras still answered (Claude 8 of 8). `{{cast}}` is filled by
 * {@link composeGroupNudge}; `{{user}}` is core's macro.
 */
export const NARRATOR_NUDGE = '[Narrator\'s turn.\nThe Narrator is not a character in this scene. Write the world around the cast: the place, the weather, the sounds, and every person who is not {{cast}} or {{user}}. When the cast has asked something of such a person, that person answers now, in their own words. When nobody outside the cast is in the scene, write only the world: the place, the light, the weather, a sound, in a few lines, and stop there.\nThe cast are not yours to move. {{cast}} and {{user}} stay exactly where and as they were: no words, no footsteps, no hands reaching for anything, not even out of sight or as a sound from another room. The world may act on them; how they respond is theirs to write in their own turn. Keep it brief, and end where one of the cast would naturally respond.]';

/** Added to a cast member's nudge while a narrator is seated (measured as "NCAST", §12). */
export const NARRATOR_OWNS_EXTRAS = '\nPeople outside the cast (strangers, passers-by, anyone the story brings in) belong to the Narrator, who gives them their words and actions in its own turn. Don\'t write them, and don\'t stop for them either: carry on with what you do.';

/**
 * The group nudge for one turn, with the narrator layered on top of {@link resolveGroupNudge}'s
 * answer (never folded into it: `SCENE_NUDGE` is byte-pinned by the Nabe migration).
 * - The narrator speaking: its own nudge, whatever the preset carries — a cast nudge ("{{char}}
 *   only") would contradict its job.
 * - A cast member speaking with a narrator seated: their nudge plus {@link NARRATOR_OWNS_EXTRAS}.
 * - Anything else: the resolved nudge unchanged.
 * @param {string} resolved {@link resolveGroupNudge}'s answer (macros unresolved).
 * @param {{ speakerIsNarrator?: boolean, narratorSeated?: boolean, castNames?: string[] }} [scene]
 * @returns {string} The template to send (`{{user}}`/`{{char}}` still unresolved).
 */
export function composeGroupNudge(resolved, { speakerIsNarrator = false, narratorSeated = false, castNames = [] } = {}) {
    const text = typeof resolved === 'string' ? resolved : '';
    if (speakerIsNarrator) {
        const cast = (Array.isArray(castNames) ? castNames : []).map(name => String(name ?? '').trim()).filter(Boolean);
        return NARRATOR_NUDGE.replaceAll('{{cast}}', cast.length ? cast.join(', ') : 'the cast');
    }
    if (narratorSeated) {
        return text ? text + NARRATOR_OWNS_EXTRAS : NARRATOR_OWNS_EXTRAS.trim();
    }
    return text;
}

/**
 * @param {unknown} presetText The active preset's `group_nudge_prompt`.
 * @param {{ sceneNudge?: unknown }} [options] `sceneNudge`: the power_user setting; only `'off'`
 *   turns the fallback off.
 * @returns {string} The template to send (macros unresolved).
 */
export function resolveGroupNudge(presetText, { sceneNudge } = {}) {
    const text = typeof presetText === 'string' ? presetText : '';
    if (sceneNudge === 'off') {
        return text;
    }
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === LEGACY_GROUP_NUDGE) {
        return SCENE_NUDGE;
    }
    return text;
}
