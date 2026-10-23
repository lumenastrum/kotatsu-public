/**
 * usage-capture — provider token-usage arithmetic for the metrics subsystem
 * (metrics native v0, `docs/metrics-native-v0.md` §2).
 *
 * Dependency-free ON PURPOSE, same discipline as `message-rows.js`. Two parties need this
 * arithmetic and they sit on opposite sides of the strangle:
 *
 *   - core capture sites (`openai.js`'s streaming generator, `script.js`'s two write sites) fold
 *     provider frames and normalize before `CHARACTER_MESSAGE_RENDERED` emits;
 *   - `public/kotatsu/metrics/*` reads the same shape back to paint the bar.
 *
 * Homing it here rather than under `public/kotatsu/` is what keeps CLAUDE.md's one-way import
 * rule intact: kotatsu imports core, core never imports kotatsu. The kotatsu metrics module
 * re-exports these so the subsystem still has ONE public door, and the unit tests drive them
 * through that door.
 *
 * Nothing in this file allocates on a non-usage frame: the hot path is two property reads.
 */

/**
 * The provider-neutral shape everything downstream speaks. Stored verbatim as
 * `chat[id].extra.mm_usage` (`docs/data-contract.md` §2.6).
 * @typedef {object} NormalizedUsage
 * @property {'anthropic'|'openai'} provider which dialect the numbers came from
 * @property {number} promptTokens total prompt tokens INCLUDING everything served from cache
 * @property {number} outputTokens completion tokens
 * @property {number} cachedTokens prompt tokens served from cache (0 when none were)
 * @property {number} cacheCreationTokens prompt tokens written INTO the cache this turn
 * @property {boolean} cacheKnown whether the provider reported cache figures at all
 * @property {'off'|'system'|'anchor'|'depth'} [cacheMode] what Kotatsu asked to cache (prompt cache v0)
 */

/** Values the server's `X-Kotatsu-Cache` header can carry (docs/prompt-cache-v0.md §4). */
const CACHE_MODES = ['off', 'system', 'anchor', 'depth'];

/**
 * Cache-write tokens from an OpenAI-dialect `prompt_tokens_details`, under either spelling, or
 * null when the provider reported none.
 * @param {any} details `prompt_tokens_details`
 * @returns {number?}
 */
function cacheWriteOf(details) {
    return details.cache_write_tokens ?? details.cache_creation_tokens ?? null;
}

/**
 * @param {{usage?: object}} state the streaming generator's per-request state bag
 * @returns {Record<string, any>} its raw usage accumulator, created on first use
 */
function accumulator(state) {
    if (!state.usage) state.usage = {};
    return /** @type {Record<string, any>} */ (state.usage);
}

/**
 * Folds one parsed SSE frame into `state.usage`, a RAW provider-shaped accumulator that
 * `normalizeUsage()` reads once at the end. Raw rather than pre-normalized so the arithmetic
 * has exactly one home and the streaming and non-streaming paths cannot drift.
 *
 * Cost discipline (`docs/metrics-native-v0.md` §2.1): a non-usage frame costs `frame.type` plus
 * `frame.usage` — two property reads, no allocation, no branch taken. OpenAI-compatible
 * backends send `usage: null` on every content chunk and the real object only in the final
 * frame; Anthropic sends it in `message_start` (prompt side) and `message_delta` (output side).
 *
 * @param {{usage?: object}} state the generator's state bag
 * @param {any} frame one parsed `data:` payload
 * @returns {void}
 */
export function foldStreamingUsage(state, frame) {
    if (!frame || typeof frame !== 'object') return;

    if (frame.type === 'message_start') {
        const usage = frame.message?.usage;
        if (!usage) return;
        const accumulated = accumulator(state);
        if (usage.input_tokens != null) accumulated.input_tokens = usage.input_tokens;
        if (usage.cache_read_input_tokens != null) accumulated.cache_read_input_tokens = usage.cache_read_input_tokens;
        if (usage.cache_creation_input_tokens != null) accumulated.cache_creation_input_tokens = usage.cache_creation_input_tokens;
        if (usage.output_tokens != null) accumulated.output_tokens = usage.output_tokens;
        return;
    }

    if (frame.type === 'message_delta') {
        const usage = frame.usage;
        if (!usage) return;
        const accumulated = accumulator(state);
        // The delta carries the RUNNING output total, not an increment — assign, never add.
        if (usage.output_tokens != null) accumulated.output_tokens = usage.output_tokens;
        // Newer Anthropic builds repeat the prompt-side figures here; take them if they come,
        // never require them.
        if (usage.input_tokens != null) accumulated.input_tokens = usage.input_tokens;
        if (usage.cache_read_input_tokens != null) accumulated.cache_read_input_tokens = usage.cache_read_input_tokens;
        if (usage.cache_creation_input_tokens != null) accumulated.cache_creation_input_tokens = usage.cache_creation_input_tokens;
        return;
    }

    const usage = frame.usage;
    if (!usage || typeof usage !== 'object') return;
    const accumulated = accumulator(state);
    if (usage.prompt_tokens != null) accumulated.prompt_tokens = usage.prompt_tokens;
    if (usage.completion_tokens != null) accumulated.completion_tokens = usage.completion_tokens;
    const details = usage.prompt_tokens_details;
    // Kept under its ORIGINAL key, not flattened: the accumulator is raw provider shape and
    // `normalizeUsage` is the only place that knows either spelling. Flattening it here is
    // exactly the drift this file exists to prevent (and did, live, before the arithmetic was
    // exercised end to end).
    if (details && (details.cached_tokens != null || cacheWriteOf(details) != null)) {
        accumulated.prompt_tokens_details = {
            ...(details.cached_tokens != null ? { cached_tokens: details.cached_tokens } : {}),
            ...(details.cache_write_tokens != null ? { cache_write_tokens: details.cache_write_tokens } : {}),
            ...(details.cache_creation_tokens != null ? { cache_creation_tokens: details.cache_creation_tokens } : {}),
        };
    }
    if (usage.prompt_cache_hit_tokens != null) accumulated.prompt_cache_hit_tokens = usage.prompt_cache_hit_tokens;
    if (usage.prompt_cache_miss_tokens != null) accumulated.prompt_cache_miss_tokens = usage.prompt_cache_miss_tokens;
    if (usage.cached_tokens != null) accumulated.cached_tokens = usage.cached_tokens;
}

/**
 * Turns a raw provider usage object into the neutral shape. Total: junk in, `null` out, never a
 * throw — telemetry may not be able to break a generation.
 *
 * The two dialects disagree about what "prompt tokens" means and getting it wrong silently
 * halves the context gauge on a cached turn:
 *
 *   - **Anthropic** `input_tokens` EXCLUDES everything served from or written to cache, so the
 *     real prompt size is `input + cache_read + cache_creation`.
 *   - **OpenAI** `prompt_tokens` INCLUDES the cached part already; `cached_tokens` is a
 *     breakdown of it, not an addend.
 *
 * @param {any} usage raw `usage` object from a response or an SSE accumulator
 * @returns {NormalizedUsage?} the neutral shape, or null when nothing parseable was there
 */
export function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;

    // Prompt cache v0 (docs/prompt-cache-v0.md §4): what Kotatsu ASKED the provider to cache,
    // from the server's X-Kotatsu-Cache header. Absent for providers Kotatsu doesn't steer.
    const cacheMode = CACHE_MODES.includes(usage.kotatsu_cache_mode) ? { cacheMode: usage.kotatsu_cache_mode } : {};

    if (usage.input_tokens != null || usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null) {
        const cacheRead = usage.cache_read_input_tokens || 0;
        const cacheCreation = usage.cache_creation_input_tokens || 0;
        return {
            provider: 'anthropic',
            promptTokens: (usage.input_tokens || 0) + cacheRead + cacheCreation,
            outputTokens: usage.output_tokens || 0,
            cachedTokens: cacheRead,
            cacheCreationTokens: cacheCreation,
            cacheKnown: true,
            ...cacheMode,
        };
    }

    if (usage.prompt_tokens != null || usage.completion_tokens != null) {
        const details = usage.prompt_tokens_details;
        // Three spellings in the wild: OpenAI nests it, DeepSeek puts hit/miss at the top
        // level, Moonshot puts `cached_tokens` at the top level (live-captured 2026-08-26 —
        // and omits every cache field entirely on a zero-cache turn, which correctly stays
        // `cacheKnown: false` rather than a fabricated verdict).
        const cached = (details && details.cached_tokens) || usage.prompt_cache_hit_tokens || usage.cached_tokens || 0;
        // Cache WRITES in this dialect: OpenRouter's `cache_write_tokens` (Claude via OpenRouter),
        // the Kotatsu Claude bridge's `cache_creation_tokens`. Both are already inside prompt_tokens.
        const cacheWrite = details ? cacheWriteOf(details) : null;
        const cacheKnown = (details && details.cached_tokens != null)
            || cacheWrite != null
            || usage.prompt_cache_hit_tokens != null
            || usage.prompt_cache_miss_tokens != null
            || usage.cached_tokens != null;
        return {
            provider: 'openai',
            promptTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
            cachedTokens: cached,
            cacheCreationTokens: cacheWrite || 0,
            cacheKnown: !!cacheKnown,
            ...cacheMode,
        };
    }

    return null;
}

/**
 * The non-streaming door: a whole response object in, the neutral shape out. Providers that
 * never send `usage` (and the text-completion APIs, which share this call site) yield null and
 * therefore no bar — a missing readout, never a fabricated one.
 * @param {any} data the parsed response body
 * @returns {NormalizedUsage?}
 */
export function usageFromResponse(data) {
    return normalizeUsage(data && typeof data === 'object' ? data.usage : null);
}
