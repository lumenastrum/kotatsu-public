/**
 * Kotatsu metrics — the DOM-free half (metrics native v0, `docs/metrics-native-v0.md` §2.3, §4).
 *
 * Everything here is a pure function of numbers. No DOM, no core state, no events — which is
 * what makes the whole readout unit-testable without jsdom and what keeps `bar.js` down to
 * "put these strings in these elements".
 *
 * The normalization arithmetic itself lives one module down in `public/scripts/usage-capture.js`
 * because CORE also needs it: `openai.js` folds SSE frames and `script.js` writes the normalized
 * shape into `extra.mm_usage` before `CHARACTER_MESSAGE_RENDERED` fires, and core may never
 * import kotatsu (CLAUDE.md). It is re-exported here so this module stays the subsystem's one
 * public door and the tests drive both halves through it.
 */
export { foldStreamingUsage, normalizeUsage, usageFromResponse } from '../../scripts/usage-capture.js';

/** @typedef {import('../../scripts/usage-capture.js').NormalizedUsage} NormalizedUsage */

/** Percent of the context window at which the gauge turns warm. */
export const CONTEXT_WARM_PCT = 60;
/** Percent of the context window at which the gauge turns critical. */
export const CONTEXT_CRIT_PCT = 85;

/**
 * Reads a message's stored usage. `mm_usage` is the native key (metrics native v0 adopted it
 * rather than migrating: chats annotated by the retired message-metrics extension keep their
 * bars for free). `ve_usage` is Voidlit Echoes' key and stays a READ-ONLY fallback — foreign
 * data we paint, never data we write (`docs/data-contract.md` §2.6).
 *
 * Anything that is not an object is treated as absent: a hand-edited `.jsonl` cannot crash the
 * renderer, and unknown-but-truthy junk paints nothing rather than a bar of `NaN`s.
 * @param {any} message a `chat[]` entry
 * @returns {NormalizedUsage?} its usage, or null
 */
export function readStoredUsage(message) {
    const extra = message?.extra;
    if (!extra || typeof extra !== 'object') return null;
    const stored = extra.mm_usage ?? extra.ve_usage ?? null;
    if (!stored || typeof stored !== 'object') return null;
    return /** @type {NormalizedUsage} */ (stored);
}

/**
 * Compact token count for the chip face: `999`, `1k`, `12.3k`, `200k`.
 *
 * One decimal below 100k and none above, so the numerator stays readable while the denominator
 * (always a round window size) stays short — `12.3k / 200k` rather than `12k / 200k`, which is
 * the difference between watching a context fill and watching it sit still.
 * @param {number?} value token count
 * @returns {string} the face
 */
export function formatTokens(value) {
    if (value == null || !Number.isFinite(value)) return '—';
    if (Math.abs(value) < 1000) return String(Math.round(value));
    const thousands = value / 1000;
    const face = Math.abs(thousands) >= 100
        ? String(Math.round(thousands))
        : thousands.toFixed(1).replace(/\.0$/, '');
    return `${face}k`;
}

/**
 * Percent of the context window a prompt occupied, clamped to 100 (a provider that reports more
 * prompt than the client's configured window is a settings mismatch, not a 340% gauge).
 * @param {number?} used prompt tokens
 * @param {number?} max the full context window
 * @returns {number?} 0-100, or null when either side is unknown
 */
export function contextPercent(used, max) {
    if (!used || !max || !Number.isFinite(used) || !Number.isFinite(max)) return null;
    return Math.min(100, Math.round((used / max) * 100));
}

/**
 * @param {number?} pct fill percentage
 * @returns {'ok'|'warm'|'crit'|'na'} the gauge's state, which is also its CSS token suffix
 */
export function contextState(pct) {
    if (pct == null) return 'na';
    if (pct >= CONTEXT_CRIT_PCT) return 'crit';
    if (pct >= CONTEXT_WARM_PCT) return 'warm';
    return 'ok';
}

/**
 * @typedef {object} ChipCopy
 * @property {'ok'|'warm'|'crit'|'na'|'healthy'|'priming'|'busted'} state CSS token suffix
 * @property {string} label the chip face
 * @property {string} title its tooltip
 */

/**
 * The context gauge's copy.
 * @param {number?} used prompt tokens
 * @param {number?} max the full context window
 * @returns {ChipCopy}
 */
export function contextChip(used, max) {
    const pct = contextPercent(used, max);
    const label = `${formatTokens(used ?? null)} / ${max ? formatTokens(max) : '—'}${pct == null ? '' : ` · ${pct}%`}`;
    const title = pct == null
        ? 'Context: the prompt size or the window size is unknown for this message.'
        : `Context: ${used?.toLocaleString()} / ${max?.toLocaleString()} tokens (${pct}%) of the full window. `
          + 'Core reserves part of that window for the response, so the prompt budget is smaller than the denominator shown.';
    return { state: contextState(pct), label, title };
}

/**
 * The cache chip's verdict. Four states, and the fourth is the one the extension never styled:
 * a provider that reports no cache figures at all gets an honest `—`, not a silent "Busted".
 * @param {NormalizedUsage?} usage normalized usage
 * @returns {ChipCopy}
 */
export function cacheVerdict(usage) {
    if (!usage || !usage.cacheKnown) {
        return { state: 'na', label: '—', title: 'No cache data reported by this provider.' };
    }
    const prompt = usage.promptTokens || 0;
    const cached = usage.cachedTokens || 0;
    if (cached > 0) {
        const pct = prompt ? Math.round((cached / prompt) * 100) : 0;
        return {
            state: 'healthy',
            label: 'Healthy',
            title: `Cache hit — ${cached.toLocaleString()} of ${prompt.toLocaleString()} prompt tokens reused (${pct}%).`,
        };
    }
    if ((usage.cacheCreationTokens || 0) > 0) {
        return {
            state: 'priming',
            label: 'Priming',
            title: `Cache priming — ${usage.cacheCreationTokens.toLocaleString()} tokens written fresh. `
                + 'Normal on the first turn or right after editing the prompt.',
        };
    }
    return {
        state: 'busted',
        label: 'Busted',
        title: 'Cache miss — 0 tokens reused. The prompt prefix likely changed upstream '
            + '(an edit, a reorder, or cache TTL expiry).',
    };
}

/**
 * The output chip's copy. Returns null when there is nothing to say — a zero-token completion
 * gets no chip rather than a chip reading `0`.
 * @param {NormalizedUsage?} usage normalized usage
 * @returns {ChipCopy?}
 */
export function outputChip(usage) {
    const tokens = usage?.outputTokens || 0;
    if (!tokens) return null;
    return {
        state: 'ok',
        label: formatTokens(tokens),
        title: `Output: ${tokens.toLocaleString()} tokens.`,
    };
}

/**
 * Everything `bar.js` needs to paint one row, computed in one place so the painter never does
 * arithmetic. Returns null when the message has no usage — the caller's cue to paint NO BAR at
 * all rather than an empty one (`docs/metrics-native-v0.md` §1).
 * @param {any} message a `chat[]` entry
 * @param {number?} maxContext the full context window, from `getMaxContextTokens()`
 * @returns {{usage: NormalizedUsage, context: ChipCopy, cache: ChipCopy, output: ChipCopy?, pct: number?}?}
 */
export function metricsViewModel(message, maxContext) {
    const usage = readStoredUsage(message);
    if (!usage) return null;
    const used = Number(usage.promptTokens) || 0;
    const max = Number(maxContext) || 0;
    return {
        usage,
        context: contextChip(used || null, max || null),
        cache: cacheVerdict(usage),
        output: outputChip(usage),
        pct: contextPercent(used || null, max || null),
    };
}
