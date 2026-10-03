/**
 * Settings sync — the client half of "save what changed" (docs/phone-v0.md §5.2).
 *
 * `settings.json` is one blob and every open tab used to POST its whole in-memory copy, so a
 * stale device erased whatever another device had changed. The client now keeps `base`, the
 * normalized copy of the last state the server acknowledged, and sends only the operations that
 * turn `base` into the current payload. The server applies them to whatever is on disk
 * (`src/settings-merge.js`), so leaves this tab never touched survive.
 *
 * Rules:
 * - **Normalize** = the JSON round trip, so `undefined`, functions and symbols vanish (and `NaN`
 *   becomes `null`) exactly as they would on the wire.
 * - **Plain objects recurse; arrays and scalars are leaves**, compared by value. An array is one
 *   leaf on purpose: merging inside arrays is not in v0 (§7).
 * - A key in `base` missing from the payload is a `del`; a key that differs or is new is a `set`
 *   carrying the whole new value.
 *
 * `createSerialQueue()` is the one-at-a-time promise chain `saveSettings()` runs through, here so
 * Jest can cover it.
 *
 * Pure leaf module: no imports, no DOM, no core state. Core may import it (house rule: core
 * never imports Kotatsu).
 */

/**
 * @typedef {object} SettingsOp
 * @property {'set'|'del'} op
 * @property {string[]} path Key segments from the root; never empty.
 * @property {any} [value] The new value, for `set`.
 */

/**
 * @param {any} value Any value.
 * @returns {boolean} True for a non-null, non-array object — the only thing the diff recurses into.
 */
export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The JSON round trip: what the server would receive for this value.
 * @template T
 * @param {T} value Any JSON-serializable value.
 * @returns {T} A deep, wire-shaped copy.
 */
export function normalizeSettings(value) {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
}

/**
 * Deep equality for normalized (JSON-shaped) values. Object key order does not matter; array
 * order does.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function jsonEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!jsonEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || !jsonEqual(a[key], b[key])) return false;
    }
    return true;
}

/**
 * A one-at-a-time queue: each job starts only after every job enqueued before it settled
 * (fulfilled or rejected), so a save that starts while one is in flight diffs against the base
 * the in-flight one leaves behind.
 * @returns {<T>(job: () => T | Promise<T>) => Promise<T>} Enqueue: resolves/rejects with the job's own outcome.
 */
export function createSerialQueue() {
    /** @type {Promise<void>} */
    let tail = Promise.resolve();
    return (job) => {
        const run = tail.then(job);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

/**
 * The operations that turn `base` into `next`. Both must already be normalized.
 * @param {any} base The last server-acknowledged state (normalized). `null`/non-object ⇒ `{}`.
 * @param {any} next The payload about to be saved (normalized).
 * @returns {SettingsOp[]} Empty when nothing changed.
 */
export function diffSettings(base, next) {
    /** @type {SettingsOp[]} */
    const ops = [];
    walk(isPlainObject(base) ? base : {}, isPlainObject(next) ? next : {}, [], ops);
    return ops;
}

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} next
 * @param {string[]} path
 * @param {SettingsOp[]} ops
 * @returns {void}
 */
function walk(base, next, path, ops) {
    for (const key of Object.keys(next)) {
        const nextValue = next[key];
        const keyPath = [...path, key];
        if (!Object.prototype.hasOwnProperty.call(base, key)) {
            ops.push({ op: 'set', path: keyPath, value: nextValue });
            continue;
        }
        const baseValue = base[key];
        if (isPlainObject(baseValue) && isPlainObject(nextValue)) {
            walk(baseValue, nextValue, keyPath, ops);
        } else if (!jsonEqual(baseValue, nextValue)) {
            ops.push({ op: 'set', path: keyPath, value: nextValue });
        }
    }
    for (const key of Object.keys(base)) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) {
            ops.push({ op: 'del', path: [...path, key] });
        }
    }
}
