/**
 * Describing and comparing regex scripts, with no imports and no DOM, so it can be unit-tested.
 *
 * Two questions the regex extension could not answer before it asked a person to decide:
 * what is in a set of scripts (the allow prompt for a preset's or a character's embedded
 * scripts), and which scripts in a pack are already installed (the import).
 *
 * @typedef {object} ScriptLike
 * @property {string} [scriptName]
 * @property {string} [findRegex]
 * @property {string} [replaceString]
 * @property {string[]} [trimStrings]
 * @property {number[]} [placement]
 * @property {boolean} [disabled]
 * @property {boolean} [markdownOnly]
 * @property {boolean} [promptOnly]
 * @property {boolean} [runOnEdit]
 * @property {number} [substituteRegex]
 * @property {number|null} [minDepth]
 * @property {number|null} [maxDepth]
 */

/**
 * What a set of scripts does, grouped by where each one bites. The grouping follows the engine's
 * own gate (engine.js `getRegexedString`): `promptOnly` runs on the text sent to the model,
 * `markdownOnly` runs on what is displayed, and a script with neither runs on the message text
 * itself, which is what gets saved to the chat. A script with both flags is in both groups.
 * Switched-off scripts are counted, never listed: allowing the set does not turn them on.
 *
 * @typedef {object} ScriptSummary
 * @property {number} total Every script in the set.
 * @property {number} enabled The ones that would run once allowed.
 * @property {number} disabled The ones switched off inside the set.
 * @property {string[]} prompt Names that change what is sent to the model.
 * @property {string[]} message Names that rewrite the message text saved to the chat.
 * @property {string[]} display Names that only change how messages look.
 */

/**
 * @param {ScriptLike[]|null|undefined} scripts
 * @returns {ScriptSummary}
 */
export function summarizeScripts(scripts) {
    const list = Array.isArray(scripts) ? scripts.filter(s => s && typeof s === 'object') : [];
    const live = list.filter(s => !s.disabled);
    const name = (/** @type {ScriptLike} */ s) => String(s.scriptName ?? '').trim() || '(unnamed)';
    return {
        total: list.length,
        enabled: live.length,
        disabled: list.length - live.length,
        prompt: live.filter(s => s.promptOnly).map(name),
        message: live.filter(s => !s.promptOnly && !s.markdownOnly).map(name),
        display: live.filter(s => s.markdownOnly).map(name),
    };
}

/**
 * What makes two scripts "the same script". The id is not part of it: every import assigns a
 * fresh one, so two copies of one pack never share ids. Neither is `disabled`: a copy the user
 * switched off is still that script. Everything that changes what the script DOES is.
 *
 * @param {ScriptLike} script
 * @returns {string}
 */
export function scriptFingerprint(script) {
    const s = script ?? {};
    return JSON.stringify([
        String(s.scriptName ?? ''),
        String(s.findRegex ?? ''),
        String(s.replaceString ?? ''),
        Array.isArray(s.trimStrings) ? s.trimStrings.map(String) : [],
        Array.isArray(s.placement) ? [...s.placement].map(Number).sort((a, b) => a - b) : [],
        Boolean(s.markdownOnly),
        Boolean(s.promptOnly),
        Boolean(s.runOnEdit),
        Number(s.substituteRegex ?? 0),
        s.minDepth ?? null,
        s.maxDepth ?? null,
    ]);
}

/**
 * Splits an incoming pack into what to add and what is already there.
 *
 * A script counts as present if an identical one exists in ANY of the given homes, not only the
 * import target: the measured failure was a pack imported to Global while the preset already
 * embedded the same twelve, which left two active copies of each. A script repeated inside the
 * pack itself is imported once.
 *
 * @template {ScriptLike} T
 * @param {T[]|null|undefined} incoming The parsed pack.
 * @param {Record<string, ScriptLike[]|null|undefined>} existing Installed scripts, keyed by a
 *     label for where they live (the label comes back in `duplicates[].where`).
 * @returns {{ toImport: T[], duplicates: { script: T, where: string }[], invalid: number }}
 */
export function planImport(incoming, existing) {
    /** @type {Map<string, string>} */
    const seen = new Map();
    for (const [where, scripts] of Object.entries(existing ?? {})) {
        for (const script of Array.isArray(scripts) ? scripts : []) {
            const key = scriptFingerprint(script);
            if (!seen.has(key)) seen.set(key, where);
        }
    }

    /** @type {T[]} */
    const toImport = [];
    /** @type {{ script: T, where: string }[]} */
    const duplicates = [];
    let invalid = 0;

    for (const script of Array.isArray(incoming) ? incoming : []) {
        if (!script || typeof script !== 'object' || typeof script.scriptName !== 'string' || !script.scriptName.trim()) {
            invalid++;
            continue;
        }
        const key = scriptFingerprint(script);
        const where = seen.get(key);
        if (where !== undefined) {
            duplicates.push({ script, where });
            continue;
        }
        seen.set(key, 'this file');
        toImport.push(script);
    }

    return { toImport, duplicates, invalid };
}

/**
 * Whether a parsed object is one regex script: it has a name and a pattern, which no preset does.
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeScript(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && typeof (/** @type {any} */ (value)).scriptName === 'string'
        && typeof (/** @type {any} */ (value)).findRegex === 'string';
}

/**
 * Tells a regex pack from a preset by shape, for an import that accepts both in one selection.
 * A pack is a script or a non-empty array of scripts. Anything else that is a plain object is
 * treated as a preset, which is what the preset import has always assumed of whatever it is given.
 *
 * @param {unknown} parsed The parsed JSON of one selected file.
 * @returns {'regex-pack'|'preset'|'unknown'}
 */
export function classifyImportFile(parsed) {
    if (Array.isArray(parsed)) {
        return parsed.length > 0 && parsed.every(looksLikeScript) ? 'regex-pack' : 'unknown';
    }
    if (looksLikeScript(parsed)) return 'regex-pack';
    return parsed && typeof parsed === 'object' ? 'preset' : 'unknown';
}

/**
 * Folds one or more regex packs into a preset body, in place, before it is saved (issue #6:
 * "import together"). The scripts land in `extensions.regex_scripts`, the field core already
 * reads as Preset Scripts, so the preset and its pack are one file from then on.
 *
 * Skips what the preset already embeds and what is installed globally: a global copy runs for
 * every preset, so embedding a second one would apply it twice. Each added script gets a fresh
 * id from `newId`, the same thing every other import does.
 *
 * @param {Record<string, any>} presetBody The preset about to be saved. Mutated.
 * @param {ScriptLike[]} packScripts Every script from the selected pack file(s), flattened.
 * @param {{ globalScripts?: ScriptLike[], newId: () => string }} options
 * @returns {{ added: number, skipped: number, invalid: number }}
 */
export function mergePackIntoPreset(presetBody, packScripts, { globalScripts = [], newId }) {
    const embedded = Array.isArray(presetBody?.extensions?.regex_scripts) ? presetBody.extensions.regex_scripts : [];
    const plan = planImport(packScripts, { preset: embedded, global: globalScripts });
    if (plan.toImport.length > 0) {
        if (!presetBody.extensions || typeof presetBody.extensions !== 'object') presetBody.extensions = {};
        presetBody.extensions.regex_scripts = [
            ...embedded,
            ...plan.toImport.map(script => ({ ...script, id: newId() })),
        ];
    }
    return { added: plan.toImport.length, skipped: plan.duplicates.length, invalid: plan.invalid };
}
