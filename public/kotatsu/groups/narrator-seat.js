/**
 * The narrator seat — provisioning (`docs/group-chat-v0.md` §13).
 *
 * Every scene that seats a narrator seats the same card: one per user, created the first time
 * someone switches a narrator on, and found afterwards by its role flag (never by its name — a
 * user's own character may well be called "Narrator"). The create goes through core's own
 * `/api/characters/create`, the welcome screen's FormData path, so the card is an ordinary V2 card
 * stock ST can open; its flag rides `data.extensions.kotatsu`, which the server deep-merges on
 * create and keeps on every later edit.
 */

import { characters, getCharacters, getRequestHeaders } from '../../script.js';
import { NARRATOR_FILE_NAME, isNarratorCard, narratorCardFields } from './narrator.js';

/** The narrator card's portrait: the stage seat's lantern (generated, docs/brand.md). */
const PORTRAIT_URL = 'kotatsu/brand/narrator.png';

/**
 * The lantern portrait as a file for the create form, or null when it can't be fetched (the
 * card is then created without one and wears the default avatar, as before).
 * @returns {Promise<Blob|null>}
 */
async function narratorPortrait() {
    try {
        const response = await fetch(PORTRAIT_URL, { cache: 'force-cache' });
        return response.ok ? await response.blob() : null;
    } catch {
        return null;
    }
}

/** @returns {string} The narrator card's avatar, '' when this user has none yet. */
export function findNarratorCard() {
    const card = (Array.isArray(characters) ? characters : []).find(isNarratorCard);
    return typeof card?.avatar === 'string' ? card.avatar : '';
}

/** @type {Promise<string>|null} One create at a time, however many saves race for it. */
let pending = null;

/**
 * The narrator card's avatar, creating the card first when there is none.
 * @returns {Promise<string>}
 */
export function ensureNarratorCard() {
    const existing = findNarratorCard();
    if (existing) return Promise.resolve(existing);
    pending ??= (async () => {
        try {
            const form = new FormData();
            for (const [key, value] of Object.entries(narratorCardFields())) {
                form.append(key, value);
            }
            const portrait = await narratorPortrait();
            if (portrait) form.append('avatar', portrait, `${NARRATOR_FILE_NAME}.png`);
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: form,
                cache: 'no-cache',
            });
            if (!response.ok) {
                throw new Error(`narrator card create failed: ${response.status}`);
            }
            const created = (await response.text()).trim();
            await getCharacters();
            const found = findNarratorCard();
            if (!found) {
                // The server took the card but the roster doesn't show the flag: refuse rather
                // than seat a card Kotatsu can't tell from a character.
                throw new Error(`narrator card ${created} has no role flag after reload`);
            }
            return found;
        } finally {
            pending = null;
        }
    })();
    return pending;
}
