/**
 * message-format-cache — memoization for messageFormatting() plus the pass-scoped depth map.
 * Renderer v0 slice B (docs/renderer-v0.md §3; suspects #4/#5/#6 in renderer-v0-recon-streaming.md).
 *
 * Correctness before speed, in this order:
 *
 *  1. The cache is keyed on RAW call inputs (text hash + flags + name [+ depth when any active
 *     regex script is depth-scoped]). Everything the pipeline does downstream is a deterministic
 *     function of those inputs plus settings — so the settings become a SIGNATURE, and any
 *     signature change bumps the epoch, orphaning every stored entry at once.
 *  2. Anything that can make the pipeline non-deterministic hard-DISABLES the cache entirely
 *     (stock path, zero risk): a MessageFormatter hook registered by an extension, or a `{{`
 *     macro anywhere in an active regex script's find/replace/trim strings or in the
 *     user prompt bias — the regex engine substitutes macros per call ({{random}}, {{time}}…),
 *     so cached output would freeze a roll.
 *  3. Entries verify the FULL input string on hit (hash collisions cannot serve wrong text).
 *  4. Nothing here imports core state. events.js is the one (leaf) import; script.js injects
 *     the signature inputs at init, same pattern as message-rows.js.
 *
 * The depth map: messageFormatting's stock depth computation is an O(chat) scan with an object
 * allocation per message, per call — quadratic across a full render. beginFormatPass() computes
 * the whole map once; calls outside a pass keep the stock scan.
 */

import { event_types, eventSource } from './events.js';

const MAX_ENTRIES = 4096;

/** @type {Map<string, {mes: string, html: string, epoch: number}>} insertion-ordered LRU */
const entries = new Map();

let epoch = 0;
let signature = null;
let signatureDirty = true;
let cacheEnabled = false;
let depthSensitive = false;
/** @type {(() => object)?} */
let getSignatureInputs = null;
/** @type {(() => boolean)?} */
let isBypassed = null;

const stats = { hits: 0, misses: 0, stores: 0, epochBumps: 0, disabled: false };

/** @type {Int32Array[]} depth maps, one per open pass — passes NEST (a stream holds one open
 * for its whole duration while redisplays begin/end their own inside it; slice D). */
const passStack = [];

/**
 * Wires the cache to core. script.js calls this once.
 * @param {object} deps
 * @param {() => object} deps.signatureInputs returns every setting the pipeline's output
 *   depends on (regex scripts, the formatting power_user knobs, formatter hook count)
 * @param {() => boolean} [deps.bypassed] returns true while the cache must stand aside
 *   (a live StreamingProcessor: cumulative per-tick text would churn the LRU for zero hits)
 * @returns {void}
 */
export function initFormatCache({ signatureInputs, bypassed }) {
    getSignatureInputs = signatureInputs;
    isBypassed = bypassed ?? null;
    const markDirty = () => { signatureDirty = true; };
    eventSource.on(event_types.SETTINGS_UPDATED, markDirty);
    eventSource.on(event_types.SETTINGS_LOADED_AFTER, markDirty);
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, markDirty);
    eventSource.on(event_types.CHAT_CHANGED, markDirty); // character switch swaps scoped scripts
}

/** @param {unknown} v @returns {boolean} whether any string in the value carries a macro */
function containsMacro(v) {
    if (typeof v === 'string') return v.includes('{{');
    if (Array.isArray(v)) return v.some(containsMacro);
    return false;
}

/** Recomputes the signature; bumps the epoch when it changed. */
function refreshSignature() {
    signatureDirty = false;
    if (!getSignatureInputs) { cacheEnabled = false; return; }
    let inputs;
    try { inputs = getSignatureInputs(); } catch { cacheEnabled = false; return; }
    const next = JSON.stringify(inputs);
    if (next !== signature) {
        signature = next;
        epoch++;
        stats.epochBumps++;
    }
    const scripts = Array.isArray(inputs?.scripts) ? inputs.scripts : [];
    const nonDeterministic = Number(inputs?.hookCount) > 0
        || containsMacro(inputs?.promptBias)
        || scripts.some(s => containsMacro(s?.findRegex) || containsMacro(s?.replaceString) || containsMacro(s?.trimStrings));
    depthSensitive = scripts.some(s =>
        (s?.minDepth !== null && s?.minDepth !== undefined && !isNaN(s.minDepth) && s.minDepth >= -1) ||
        (s?.maxDepth !== null && s?.maxDepth !== undefined && !isNaN(s.maxDepth) && s.maxDepth >= 0));
    cacheEnabled = !nonDeterministic;
    stats.disabled = !cacheEnabled;
}

/** cyrb53 — fast 53-bit string hash. Collisions are additionally guarded by full-string verify. */
function hash53(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * True while the cache may serve/store at all for this call.
 * @param {number} messageId raw messageId argument
 * @param {boolean} isSystem @param {boolean} isUser @param {boolean} isReasoning
 */
function usable(messageId, isSystem, isUser, isReasoning) {
    if (isBypassed?.()) return false;
    if (signatureDirty) refreshSignature();
    if (!cacheEnabled) return false;
    // Greeting path: stock substitutes macros and mutates chat[0].mes in place — must run.
    if (Number(messageId) === 0 && !isSystem && !isUser && !isReasoning) return false;
    return true;
}

/**
 * Builds the cache key, or null when this call must not be cached.
 * `depth` is included only while a depth-scoped regex script is active — otherwise every new
 * message would shift every older message's depth and orphan the whole cache each turn.
 * @returns {string?}
 */
export function formatCacheKey(mes, ch_name, isSystem, isUser, messageId, overridesKey, isReasoning, depth) {
    if (typeof mes !== 'string') return null;
    if (!usable(messageId, isSystem, isUser, isReasoning)) return null;
    const flags = `${isSystem ? 1 : 0}${isUser ? 1 : 0}${isReasoning ? 1 : 0}`;
    const depthKey = depthSensitive ? String(depth ?? '') : '';
    return `${flags}|${overridesKey}|${depthKey}|${ch_name ?? ''}|${mes.length}|${hash53(mes)}`;
}

/** @returns {boolean} whether the key must carry a resolved depth (a depth-scoped script is active) */
export function formatCacheNeedsDepth() {
    if (signatureDirty) refreshSignature();
    return cacheEnabled && depthSensitive;
}

/**
 * @param {string?} key from formatCacheKey
 * @param {string} mes the raw input, verified against the stored entry
 * @returns {string?} cached HTML, or null
 */
export function formatCacheGet(key, mes) {
    if (key === null) return null;
    const entry = entries.get(key);
    if (!entry || entry.epoch !== epoch || entry.mes !== mes) {
        if (entry) entries.delete(key);
        stats.misses++;
        return null;
    }
    entries.delete(key); // LRU touch
    entries.set(key, entry);
    stats.hits++;
    return entry.html;
}

/**
 * @param {string?} key from formatCacheKey
 * @param {string} mes the raw input string
 * @param {string} html the pipeline's output
 * @returns {void}
 */
export function formatCacheStore(key, mes, html) {
    if (key === null || typeof html !== 'string') return;
    if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(key, { mes, html, epoch });
    stats.stores++;
}

/**
 * Begins a render pass: computes the depth of every chat index in ONE walk (depth = number of
 * non-system messages after this one; system messages have none, matching the stock scan's
 * findIndex miss → undefined, encoded here as -1).
 * @param {Array<{is_system?: boolean}>} chatArray the live chat array
 * @returns {void}
 */
export function beginFormatPass(chatArray) {
    const depths = new Int32Array(chatArray.length);
    let seen = 0;
    for (let i = chatArray.length - 1; i >= 0; i--) {
        depths[i] = chatArray[i]?.is_system ? -1 : seen++;
    }
    passStack.push(depths);
}

/** Ends the innermost render pass. Always pair with beginFormatPass in a try/finally. */
export function endFormatPass() {
    passStack.pop();
}

/**
 * Pass-scoped depth lookup against the INNERMOST open pass. Outside any pass (or out of range)
 * returns undefined and the caller falls back to the stock scan.
 * @param {number} messageId
 * @returns {number|undefined} depth, undefined when unavailable, or undefined for system rows
 */
export function passDepthFor(messageId) {
    const passDepths = passStack.length ? passStack[passStack.length - 1] : null;
    if (!passDepths) return undefined;
    const i = Number(messageId);
    if (!Number.isInteger(i) || i < 0 || i >= passDepths.length) return undefined;
    const d = passDepths[i];
    return d === -1 ? undefined : d;
}

/** @returns {boolean} whether a format pass is currently open */
export function formatPassActive() {
    return passStack.length > 0;
}

/**
 * Whether cached/incremental formatting is currently sound (no formatter hooks, no macros in
 * active regex scripts or the prompt bias). Slice D's streaming prefix cache shares this gate.
 * @returns {boolean}
 */
export function formatCacheUsable() {
    if (signatureDirty) refreshSignature();
    return cacheEnabled;
}

/** Console/probe surface. */
export function formatCacheStats() {
    if (signatureDirty) refreshSignature();
    return { ...stats, entries: entries.size, epoch, enabled: cacheEnabled, depthSensitive };
}

/** Drops every entry (probes; not used by core paths). */
export function formatCacheClear() {
    entries.clear();
    stats.hits = 0; stats.misses = 0; stats.stores = 0;
}
