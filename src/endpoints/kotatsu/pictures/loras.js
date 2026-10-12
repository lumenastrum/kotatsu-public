/**
 * LoRA facts for the picker (Pictures, 2026-10-10): which base model a LoRA was trained for and
 * the trigger words it was trained on, read from the safetensors header ComfyUI serves at
 * `/view_metadata/loras?filename=` (404 when the file has none).
 *
 * Measured on the owner's 21 LoRAs: kohya/sd-scripts writes `ss_base_model_version` (`anima`,
 * `krea2`) and `ss_tag_frequency` (dataset → tag → count); `modelspec.architecture` sometimes names
 * the base (`anima/lora`); some files carry nothing (`{"format": "pt"}` or a 404). Then the file
 * name is the only hint, and the answer says so (`baseFrom: 'name'`).
 *
 * Pure: no I/O. The route caches the answers per server and file.
 */

/** Bases Kotatsu tells apart, and how a name or a metadata value points at each. */
const BASE_PATTERNS = Object.freeze([
    ['anima', /anima(?!te|tion|l)/i], // not AnimateLCM (an SD 1.5 motion LoRA on the owner's disk)
    ['krea2', /krea[-_ ]?2|\bk2[-_]/i],
    ['flux', /flux/i],
    ['qwen-image', /qwen[-_ ]?image/i],
    ['sdxl', /sdxl|sd[-_ ]?xl|illustrious|noob|pony/i],
    ['sd15', /sd[-_ ]?1[._]?5|sd15|\bsd_?v1\b|stable-diffusion-v1/i],
]);

/**
 * Booru tags too general to be a trigger (they sit in nearly every caption of a character set).
 * Lowercase, as kohya stores them.
 */
const GENERIC_TAGS = new Set([
    '1girl', '1boy', '2girls', '2boys', 'solo', 'multiple girls', 'multiple boys', 'looking at viewer',
    'smile', 'open mouth', 'closed mouth', 'blush', 'simple background', 'white background', 'upper body',
    'full body', 'cowboy shot', 'portrait', 'standing', 'sitting', 'long hair', 'short hair', 'medium hair',
    'very long hair', 'breasts', 'large breasts', 'medium breasts', 'small breasts', 'bangs', 'blunt bangs',
    'hair between eyes', 'jewelry', 'earrings', 'dress', 'shirt', 'skirt', 'gloves', 'hat', 'masterpiece',
    'best quality', 'highres', 'absurdres', 'official art', 'anime coloring', 'outdoors', 'indoors', 'day', 'night',
]);

/** Hair/eye colour tags are features, not triggers. */
const FEATURE_TAG = /^(?:[a-z]+ )?(?:hair|eyes)$|^(?:aqua|black|blonde|blue|brown|green|grey|orange|pink|purple|red|silver|white|yellow|multicolored|two-tone|streaked) (?:hair|eyes)$/;

/**
 * @param {unknown} text
 * @returns {string|null} The base a string names, or null
 */
export function baseFromText(text) {
    const value = String(text ?? '');
    if (!value) return null;
    for (const [base, pattern] of BASE_PATTERNS) {
        if (pattern.test(value)) return base;
    }
    return null;
}

/**
 * The trigger words a LoRA was trained on: the tags present in (nearly) every caption, minus the
 * generic and colour tags, most frequent first, at most `limit`.
 * @param {unknown} tagFrequency `ss_tag_frequency` (a JSON string or its parsed object)
 * @param {number} [limit] Most to return
 * @returns {string[]}
 */
export function triggersFrom(tagFrequency, limit = 2) {
    let parsed = tagFrequency;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed);
        } catch {
            return [];
        }
    }
    if (!parsed || typeof parsed !== 'object') return [];
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const dataset of Object.values(parsed)) {
        if (!dataset || typeof dataset !== 'object') continue;
        for (const [tag, count] of Object.entries(dataset)) {
            const key = tag.trim();
            if (!key || !Number.isFinite(Number(count))) continue;
            counts.set(key, (counts.get(key) ?? 0) + Number(count));
        }
    }
    if (!counts.size) return [];
    const top = Math.max(...counts.values());
    return [...counts.entries()]
        .filter(([tag, count]) => count >= top * 0.9 && !GENERIC_TAGS.has(tag.toLowerCase()) && !FEATURE_TAG.test(tag.toLowerCase()))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([tag]) => tag);
}

/**
 * What the picker shows for one LoRA.
 * @param {string} file The file as ComfyUI lists it (may include a subfolder)
 * @param {Record<string, any>|null} metadata `/view_metadata` answer, or null for none
 * @returns {{file: string, base: string|null, baseFrom: 'metadata'|'name'|null, triggers: string[], title: string}}
 */
export function readLoraInfo(file, metadata) {
    const meta = metadata && typeof metadata === 'object' ? metadata : {};
    const fromMeta = baseFromText(meta.ss_base_model_version) ?? baseFromText(meta['modelspec.architecture']) ?? baseFromText(meta.ss_sd_model_name);
    const fromName = fromMeta ? null : baseFromText(file);
    const explicit = typeof meta['modelspec.trigger_phrase'] === 'string' && meta['modelspec.trigger_phrase'].trim()
        ? meta['modelspec.trigger_phrase'].split(',').map(s => s.trim()).filter(Boolean)
        : null;
    const stem = file.split(/[\\/]/).pop()?.replace(/\.(safetensors|ckpt|pt|bin)$/i, '') ?? file;
    const title = typeof meta['modelspec.title'] === 'string' && meta['modelspec.title'].trim() ? meta['modelspec.title'].trim() : stem;
    return {
        file,
        base: fromMeta ?? fromName,
        baseFrom: fromMeta ? 'metadata' : fromName ? 'name' : null,
        triggers: explicit ?? triggersFrom(meta.ss_tag_frequency),
        title,
    };
}
