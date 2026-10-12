/**
 * Pictures v0 — the one-way move out of stock's image extension (docs/pictures-v0.md §9).
 *
 * Runs once, guarded by `version` on the settings leaf: a stored leaf with a numeric `version`
 * means "migrated, or someone already chose settings by hand", and either way nothing runs again.
 * It runs only when there is something to move (`extension_settings.sd` is an object); with no
 * old settings it writes nothing at all, so a fresh install's settings file stays untouched.
 *
 * What moves (decided 2026-10-09, slice C brief):
 * - `sd.comfy_url` → `comfy.url`; `sd.comfy_auth` → `comfy.auth` (stock never had an auth field;
 *   the line is here so a hand-added one is not lost).
 * - `sd.styles[]` `{name, prefix, negative}` → `styles[]` `{name, positive, negative}`; nameless
 *   entries drop, a repeated name keeps its first.
 * - `sd.comfy_workflow` → nothing. Recipes are server-side (slice A) and the workflow file stays
 *   where it is in `user/workflows/`; the migration only notes the name.
 * - `sd.character_prompts[key]` / `sd.character_negative_prompts[key]` → the matching loaded
 *   card's look, ONLY when that card has no look yet: it is the user's own text, and moving it
 *   into the card is the point. Stock keyed both by the avatar file name without its extension
 *   (`getCharaFilename`); a key that matches no file is tried as a card name, and used only when
 *   exactly one card has that name. The card's own stock field `data.extensions.sd_character_prompt`
 *   (stock's "share with the card" switch) is the fallback source for a card with no local entry.
 * - `sd.prompts.*` → nothing (new templates, §4).
 *
 * `extension_settings.sd` is never written: read-only here, on disk untouched.
 */

import { characters } from '../../script.js';
import { extension_settings } from '../../scripts/extensions.js';
import { DEFAULT_SETTINGS } from './contract.js';
import { defaultLookFor, getLook, isLookEmpty, saveLook } from './look.js';
import { isPlainObject, readStoredLeaf, writeStoredLeaf } from './settings.js';

/** @typedef {import('./contract.js').CardLook} CardLook */

/**
 * @typedef {object} MigrationPlan
 * @property {Record<string, any>} leaf The whole stored (sparse) settings leaf to write.
 * @property {{ character: any, look: CardLook }[]} looks Cards that receive a look.
 * @property {string[]} notes One line per thing that moved, or didn't, for the console.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {any} character
 * @returns {string} The avatar file name without its extension: stock's character key.
 */
function stockKey(character) {
    const avatar = typeof character?.avatar === 'string' ? character.avatar : '';
    return avatar.replace(/\.[^/.]+$/, '');
}

/**
 * Stock's styles in the new shape.
 * @param {unknown} styles `sd.styles`
 * @returns {{ name: string, positive: string, negative: string }[]}
 */
export function migrateStyles(styles) {
    if (!Array.isArray(styles)) return [];
    /** @type {Map<string, { name: string, positive: string, negative: string }>} */
    const byName = new Map();
    for (const style of styles) {
        if (!isPlainObject(style)) continue;
        const name = text(style.name);
        if (!name || byName.has(name)) continue;
        byName.set(name, {
            name,
            positive: text(style.prefix ?? style.positive),
            negative: text(style.negative),
        });
    }
    return [...byName.values()];
}

/**
 * Works out the migration without doing any of it. Pure over its arguments; never mutates `sd`.
 * @param {unknown} sd `extension_settings.sd`
 * @param {Record<string, any>} stored The stored (sparse) settings leaf.
 * @param {any[]} roster `characters`
 * @returns {MigrationPlan|null} null when there is nothing to do (already done, or no old settings).
 */
export function planPicturesMigration(sd, stored, roster) {
    if (isPlainObject(stored) && typeof stored.version === 'number') return null;
    if (!isPlainObject(sd)) return null;

    /** @type {Record<string, any>} */
    const leaf = isPlainObject(stored) ? JSON.parse(JSON.stringify(stored)) : {};
    leaf.version = DEFAULT_SETTINGS.version;
    /** @type {string[]} */
    const notes = [];

    const url = text(sd.comfy_url);
    const auth = text(sd.comfy_auth);
    if (url || auth) {
        leaf.comfy = { ...(isPlainObject(leaf.comfy) ? leaf.comfy : {}) };
        if (url) {
            leaf.comfy.url = url;
            notes.push(`ComfyUI address ${url}`);
        }
        if (auth) {
            leaf.comfy.auth = auth;
            notes.push('ComfyUI auth');
        }
    }

    const styles = migrateStyles(sd.styles);
    if (styles.length) {
        leaf.styles = styles;
        notes.push(`${styles.length} style${styles.length === 1 ? '' : 's'}`);
    }

    const workflow = text(sd.comfy_workflow);
    if (workflow) {
        notes.push(`workflow ${workflow} left in user/workflows (recipes are set up in Pictures)`);
    }

    /** @type {{ character: any, look: CardLook }[]} */
    const looks = [];
    const list = Array.isArray(roster) ? roster.filter(card => card && typeof card === 'object') : [];
    const positives = isPlainObject(sd.character_prompts) ? sd.character_prompts : {};
    const negatives = isPlainObject(sd.character_negative_prompts) ? sd.character_negative_prompts : {};

    /** @type {Map<any, { positive: string, negative: string }>} */
    const found = new Map();
    for (const key of new Set([...Object.keys(positives), ...Object.keys(negatives)])) {
        const positive = text(positives[key]);
        const negative = text(negatives[key]);
        if (!positive && !negative) continue;
        let card = list.find(candidate => stockKey(candidate) === key);
        if (!card) {
            const named = list.filter(candidate => candidate.name === key);
            card = named.length === 1 ? named[0] : undefined;
        }
        if (!card || found.has(card)) continue;
        found.set(card, { positive, negative });
    }
    for (const card of list) {
        if (found.has(card)) continue;
        const shared = card?.data?.extensions?.sd_character_prompt;
        if (!isPlainObject(shared)) continue;
        const positive = text(shared.positive);
        const negative = text(shared.negative);
        if (positive || negative) found.set(card, { positive, negative });
    }
    let kept = 0;
    for (const [card, texts] of found) {
        if (!isLookEmpty(getLook(card))) {
            kept += 1;
            continue;
        }
        looks.push({ character: card, look: { ...defaultLookFor(card), ...texts } });
    }
    if (looks.length) notes.push(looks.length === 1 ? '1 character look moved into its card' : `${looks.length} character looks moved into their cards`);
    if (kept) notes.push(`${kept} card${kept === 1 ? '' : 's'} already had a look and kept it`);

    return { leaf, looks, notes };
}

/** @type {Promise<MigrationPlan|null>|null} */
let running = null;

/**
 * Runs the migration against the live settings and roster. Safe to call more than once: the
 * leaf's `version` is written before any card is, so a second call finds it done.
 * @returns {Promise<MigrationPlan|null>}
 */
export function runPicturesMigration() {
    running ??= (async () => {
        const plan = planPicturesMigration(extension_settings?.sd, readStoredLeaf(), characters);
        if (!plan) return null;
        writeStoredLeaf(plan.leaf);
        for (const { character, look } of plan.looks) {
            try {
                await saveLook(character, look);
            } catch (error) {
                console.warn(`[Pictures] could not move ${character?.name ?? 'a card'}'s look into the card`, error);
            }
        }
        console.info(`[Pictures] moved from the old image extension: ${plan.notes.join('; ') || 'nothing to move'}. Its settings are left as they were.`);
        return plan;
    })().finally(() => {
        running = null;
    });
    return running;
}
