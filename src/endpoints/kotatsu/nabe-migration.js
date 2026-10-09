/**
 * Kotatsu Nabe 0.3 → 0.4, in place, for installs that never touched it (docs/group-chat-v0.md
 * §10, decided 2026-10-08).
 *
 * Seeding never overwrites a preset file (docs/preset-bundle-v0.md §4), so an install that got
 * Nabe 0.3 keeps it. 0.4 changed three strings, all for scenes:
 * - the Last word stopped asking for "a new line or action from someone else"; it is the final
 *   instruction a scene's speaker reads, and with it still in place an installed 0.3 measured 2/6
 *   major bleed against 0.4's 0/6;
 * - `group_nudge_prompt` became Kotatsu's scene nudge;
 * - `new_group_chat_prompt` became a scene opener.
 *
 * The rule: a field is replaced only when it is byte-identical to what 0.3 shipped. Anything a
 * person edited stays theirs. The preset's recorded version moves to 0.4 only when all three now
 * read as 0.4. Both places the preset lives are patched: the preset file, and — when Nabe is the
 * active Chat Completion preset — its live copy in settings.json (`oai_settings`), which is what
 * a running client actually sends until the preset is reselected. Originals are copied to
 * `backups/_nabe_0.4/` first. Runs at boot, before the server takes a request, so no tab races it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { SETTINGS_FILE } from '../../constants.js';
import { color, tryParse } from '../../util.js';
import { SCENE_NUDGE } from '../../../public/scripts/group-nudge.js';

export const NABE_NAME = 'Kotatsu Nabe';

/** What Nabe 0.3 shipped, verbatim (git: tests/fixtures/presets/Kotatsu Nabe.json at 8ea0c2baf). */
export const NABE_03 = Object.freeze({
    lastWord: '{{user}}\'s last message has already happened, and everyone in the scene heard and saw it. Begin the reply with what comes next: a reaction, a consequence, a new line or action from someone else. Now write the next reply, keeping to the choices above.',
    groupNudge: '[Write the next reply only as {{char}}.]',
    groupOpener: '[Start a new group chat. Group members: {{group}}]',
});

/** What Nabe 0.4 ships (tests/nabe-migration.test.js pins these to the shipped fixture). */
export const NABE_04 = Object.freeze({
    lastWord: '{{user}}\'s last message has already happened, and everyone in the scene heard and saw it. Begin the reply with what comes next: a reaction, a consequence, a new line or action. Now write the next reply, keeping to the choices above.',
    groupNudge: SCENE_NUDGE,
    groupOpener: '[A new scene opens. Present: {{group}}. Begin inside a moment that is already underway, with each of them somewhere in the room, and let whoever speaks first open it with something they do or say.]',
});

/**
 * Patches one Nabe-shaped object (a preset file's JSON, or settings.json's `oai_settings`) in
 * place. Pure apart from mutating `target`.
 * @param {any} target
 * @param {{ checkIdentity: boolean }} options `checkIdentity`: require the preset's own
 *   `extensions.kotatsu.preset` to say Nabe 0.3 (true for the file; the live copy carries no
 *   extensions block, so its identity comes from `preset_settings_openai` instead).
 * @returns {{ changed: string[], complete: boolean }} Which fields were replaced, and whether all
 *   three now read as 0.4.
 */
export function patchNabe(target, { checkIdentity }) {
    const result = { changed: /** @type {string[]} */ ([]), complete: false };
    if (!target || typeof target !== 'object') return result;
    const identity = target.extensions?.kotatsu?.preset;
    if (checkIdentity && (identity?.name !== NABE_NAME || identity?.version !== '0.3')) return result;

    const jailbreak = Array.isArray(target.prompts) ? target.prompts.find((/** @type {any} */ p) => p?.identifier === 'jailbreak') : null;
    if (jailbreak && jailbreak.content === NABE_03.lastWord) {
        jailbreak.content = NABE_04.lastWord;
        result.changed.push('lastWord');
    }
    if (target.group_nudge_prompt === NABE_03.groupNudge) {
        target.group_nudge_prompt = NABE_04.groupNudge;
        result.changed.push('groupNudge');
    }
    if (target.new_group_chat_prompt === NABE_03.groupOpener) {
        target.new_group_chat_prompt = NABE_04.groupOpener;
        result.changed.push('groupOpener');
    }
    result.complete = jailbreak?.content === NABE_04.lastWord
        && target.group_nudge_prompt === NABE_04.groupNudge
        && target.new_group_chat_prompt === NABE_04.groupOpener;
    if (result.complete && identity?.name === NABE_NAME) {
        identity.version = '0.4';
    }
    return result;
}

/**
 * @param {string} file
 * @param {string} backupDir
 */
function backup(file, backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
}

/**
 * Migrates every user's untouched Nabe 0.3. Never throws: a failure is logged and the files are
 * left as they were.
 * @param {import('../../users.js').UserDirectoryList[]} directoriesList
 * @returns {{ presets: number, settings: number }} How many files were rewritten.
 */
export function migrateNabePresets(directoriesList) {
    const counts = { presets: 0, settings: 0 };
    for (const dirs of directoriesList) {
        const backupDir = path.join(dirs.backups, '_nabe_0.4');
        try {
            const presetFile = path.join(dirs.openAI_Settings, `${NABE_NAME}.json`);
            if (fs.existsSync(presetFile)) {
                const preset = tryParse(fs.readFileSync(presetFile, 'utf8'));
                const before = JSON.stringify(preset);
                const { changed } = patchNabe(preset, { checkIdentity: true });
                if (changed.length && JSON.stringify(preset) !== before) {
                    backup(presetFile, backupDir);
                    // SillyTavern's preset serialization: four spaces.
                    writeFileAtomicSync(presetFile, JSON.stringify(preset, null, 4), 'utf8');
                    counts.presets += 1;
                    console.log(color.green(`Kotatsu Nabe: updated ${changed.join(', ')} for scenes (${dirs.root}).`));
                }
            }

            const settingsFile = path.join(dirs.root, SETTINGS_FILE);
            if (fs.existsSync(settingsFile)) {
                const settings = tryParse(fs.readFileSync(settingsFile, 'utf8'));
                const live = settings?.oai_settings;
                if (live && live.preset_settings_openai === NABE_NAME) {
                    const { changed } = patchNabe(live, { checkIdentity: false });
                    if (changed.length) {
                        backup(settingsFile, backupDir);
                        writeFileAtomicSync(settingsFile, JSON.stringify(settings, null, 4), 'utf8');
                        counts.settings += 1;
                    }
                }
            }
        } catch (error) {
            console.warn(color.yellow(`Kotatsu Nabe 0.4 migration skipped for ${dirs.root}:`), error);
        }
    }
    return counts;
}
