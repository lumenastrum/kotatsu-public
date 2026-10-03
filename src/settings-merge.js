/**
 * Settings sync — the server half (docs/phone-v0.md §5.3).
 *
 * `applyOps(object, ops)` applies the operations a client diffed against its last acknowledged
 * copy (`public/scripts/settings-diff.js`) to whatever `settings.json` holds now, so leaves the
 * client never touched — another device's changes — survive. Same leaf on two devices ⇒ the
 * later patch wins.
 *
 * - `set` creates intermediate objects; a `set` through a non-object (scalar, array, null)
 *   replaces it with an object.
 * - `del` of a missing path is a no-op, including a path through a non-object.
 * - A `__proto__` / `constructor` / `prototype` segment anywhere refuses the whole batch
 *   (throws before anything is applied).
 *
 * Pure leaf module: no imports, no I/O.
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Thrown for a malformed or refused op list; the endpoint answers 400. */
export class SettingsPatchError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'SettingsPatchError';
    }
}

/**
 * @param {any} value
 * @returns {boolean} True for a non-null, non-array object.
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks the shape of an op list without applying it.
 * @param {any} ops
 * @returns {asserts ops is Array<{op: 'set'|'del', path: string[], value?: any}>}
 */
export function validateOps(ops) {
    if (!Array.isArray(ops)) throw new SettingsPatchError('ops must be an array');
    ops.forEach((entry, index) => {
        if (!isPlainObject(entry)) throw new SettingsPatchError(`op ${index} is not an object`);
        if (entry.op !== 'set' && entry.op !== 'del') throw new SettingsPatchError(`op ${index} has unknown kind ${JSON.stringify(entry.op)}`);
        if (!Array.isArray(entry.path) || entry.path.length === 0) throw new SettingsPatchError(`op ${index} has an empty or missing path`);
        for (const segment of entry.path) {
            if (typeof segment !== 'string') throw new SettingsPatchError(`op ${index} has a non-string path segment`);
            if (FORBIDDEN_SEGMENTS.has(segment)) throw new SettingsPatchError(`op ${index} has a forbidden path segment "${segment}"`);
        }
        if (entry.op === 'set' && !Object.prototype.hasOwnProperty.call(entry, 'value')) throw new SettingsPatchError(`op ${index} is a set without a value`);
    });
}

/**
 * Applies ops in order, mutating and returning `object` (a non-object root becomes `{}`).
 * Validates the whole list first, so a refused list changes nothing.
 * @param {any} object The parsed settings.
 * @param {any} ops The op list from the client.
 * @returns {Record<string, any>} The patched object.
 */
export function applyOps(object, ops) {
    validateOps(ops);
    /** @type {Record<string, any>} */
    const root = isPlainObject(object) ? object : {};
    for (const { op, path, value } of ops) {
        const last = path[path.length - 1];
        /** @type {Record<string, any>} */
        let at = root;
        let reachable = true;
        for (const segment of path.slice(0, -1)) {
            const has = Object.prototype.hasOwnProperty.call(at, segment);
            if (has && isPlainObject(at[segment])) {
                at = at[segment];
                continue;
            }
            if (op === 'del') {
                reachable = false;
                break;
            }
            at[segment] = {};
            at = at[segment];
        }
        if (!reachable) continue;
        if (op === 'set') {
            at[last] = value;
        } else if (Object.prototype.hasOwnProperty.call(at, last)) {
            delete at[last];
        }
    }
    return root;
}
