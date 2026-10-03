/**
 * The preset credits manifest, client side (docs/preset-bundle-v0.md §2, §5).
 *
 * `public/kotatsu/prompts/preset-credits.json` is a static file: one entry per bundled preset,
 * `default` naming the house preset. The tour's Sauce step and the preset dock's credit line both
 * read it, so a new bundled preset is one manifest entry and no code. Everything below the fetch
 * is pure (no DOM, Jest-covered).
 */

/** Where the static manifest is served from (`public/` is mounted at the site root). */
export const CREDITS_URL = '/kotatsu/prompts/preset-credits.json';

/**
 * @typedef {object} CreditEntry
 * @property {string} name Preset name exactly as core lists it (the manifest key).
 * @property {string} title Display title.
 * @property {string} author Who made it.
 * @property {string|null} url Where the author's work lives, or null.
 * @property {string} blurb One line about it.
 * @property {boolean} own Whether Kotatsu made it (`permission.status === 'own'`).
 */

/**
 * What the tour falls back to when the manifest can't be read: the house preset alone, which
 * ships in every install. Never a list of third-party presets; those only come from the file.
 * @type {Readonly<{version: number, default: string, presets: Record<string, any>}>}
 */
export const FALLBACK_MANIFEST = Object.freeze({
    version: 1,
    default: 'Kotatsu Nabe',
    presets: Object.freeze({
        'Kotatsu Nabe': Object.freeze({
            title: 'Kotatsu Nabe',
            author: 'Kotatsu',
            url: null,
            blurb: 'Kotatsu\'s own sauce: light, warm, and written to let you lead.',
            permission: Object.freeze({ status: 'own' }),
        }),
    }),
});

/** @type {Promise<any>|null} */
let loading = null;

/**
 * The manifest, fetched once per page. A failed or malformed fetch resolves to
 * {@link FALLBACK_MANIFEST} (and is not retried: a static file that fails once will fail again).
 * @param {typeof fetch} [fetcher] Fetch implementation (tests pass a stub).
 * @returns {Promise<any>} The manifest.
 */
export function loadPresetCredits(fetcher = globalThis.fetch) {
    loading ??= Promise.resolve()
        .then(() => fetcher(CREDITS_URL))
        .then(response => (response.ok ? response.json() : null))
        .then(body => (body && typeof body === 'object' && body.presets && typeof body.presets === 'object' ? body : FALLBACK_MANIFEST))
        .catch(() => FALLBACK_MANIFEST);
    return loading;
}

/** @returns {void} Forgets the fetched manifest (tests). */
export function resetPresetCredits() {
    loading = null;
}

/**
 * The manifest's entries, the house preset (`default`) first, the rest in manifest order.
 * Entries without a usable title are dropped.
 * @param {any} manifest The manifest.
 * @returns {CreditEntry[]} Entries.
 */
export function creditEntries(manifest) {
    const presets = manifest?.presets && typeof manifest.presets === 'object' ? manifest.presets : {};
    /** @type {CreditEntry[]} */
    const entries = Object.entries(presets)
        .filter(([, value]) => value && typeof value === 'object' && typeof value.title === 'string' && value.title)
        .map(([name, value]) => ({
            name,
            title: String(value.title),
            author: typeof value.author === 'string' ? value.author : '',
            url: typeof value.url === 'string' && /^https:\/\//i.test(value.url) ? value.url : null,
            blurb: typeof value.blurb === 'string' ? value.blurb : '',
            own: value.permission?.status === 'own',
        }));
    const first = entries.findIndex(entry => entry.name === manifest?.default);
    if (first > 0) entries.unshift(...entries.splice(first, 1));
    return entries;
}

/**
 * The dock's credit line for the active preset: only for a bundled preset someone else made.
 * Kotatsu's own and unknown presets (the person's own, imported ones, Default) get nothing.
 * @param {any} manifest The manifest.
 * @param {string} presetName The active Chat Completion preset.
 * @returns {{text: string, author: string, url: string|null}|null} The line, or null.
 */
export function presetCredit(manifest, presetName) {
    const entry = creditEntries(manifest).find(candidate => candidate.name === presetName);
    if (!entry || entry.own || !entry.author) return null;
    return { text: `${entry.title} by ${entry.author}`, author: entry.author, url: entry.url };
}
