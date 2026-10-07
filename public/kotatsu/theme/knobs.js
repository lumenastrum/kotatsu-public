/**
 * Component knobs: the `--k-*` dials each Kotatsu sheet declares for its own component (the
 * library's card radius, the reading column's nameplate size, the chrome fills). Before knobs a
 * pack could reach these only by hand-writing scoped CSS in `sheet.css`. Now they are data: a pack
 * writes `"--k-lib-card-radius": "4px"` in `tokens` exactly like a core token, and the engine puts
 * the value wherever the component declares that dial.
 *
 * The catalog (`knobs.json`) is generated from the real stylesheets by `npm run theme:knobs` and
 * kept honest by a test that regenerates it and compares. Each knob lists every context
 * (selector + wrapping at-rules) that declares it. Applying a pack's value means re-declaring it in
 * each of those contexts, scoped to the pack:
 *   - a `:root` / `html` context → written inline on <html> with the core tokens (first-paint
 *     cached, outranks every sheet);
 *   - a `body…` context → the pack attribute merged into that compound:
 *     `body[data-k-layout="rails"]` → `body[data-k-theme="x"][data-k-layout="rails"]`;
 *   - anything else → prefixed: `k-library` → `body[data-k-theme="x"] k-library`.
 * Every scoped selector is strictly MORE specific than the one it shadows (it gains an attribute
 * selector), so the pack value wins on the same element regardless of sheet order.
 *
 * Pack values never become stylesheet TEXT: `planKnobRules` keeps them apart from the rule shapes
 * and `writeKnobRules` hands them to `style.setProperty()` one by one (see there).
 *
 * DOM-free except `writeKnobRules`, which takes the stylesheet it writes into: used by loader.js
 * (browser), theme-check and the tests (Node).
 */

/**
 * @typedef {object} KnobContext
 * @property {string} selector One selector (never a list) that declares the knob.
 * @property {string[]} at Wrapping conditional at-rule preludes, outermost first, e.g. `@media (max-width: 1000px)`.
 */

/**
 * @typedef {object} KnobEntry
 * @property {string} group Friendly component name, for the catalog.
 * @property {string} file Declaring stylesheet, relative to `public/`.
 * @property {string} default The first declared value, for the catalog.
 * @property {string} [note] The comment above the first declaration, when there is one.
 * @property {KnobContext[]} contexts Every declaring context. Empty = consumed with a fallback only.
 */

/**
 * @typedef {object} KnobRegistry
 * @property {Record<string, KnobEntry>} knobs
 */

/**
 * The catalog as the loader holds it: only what it needs to validate names and place values.
 * @typedef {object} RuntimeKnobRegistry
 * @property {Record<string, {contexts: KnobContext[]}>} knobs
 */

/**
 * The boot-time file (`knobs.runtime.json`, written by `npm run theme:knobs` beside `knobs.json`):
 * the few dozen distinct selectors and at-rules stored once, each context as
 * `[selectorIndex, ...atIndexes]`.
 * @typedef {object} PackedKnobRegistry
 * @property {string[]} selectors
 * @property {string[]} at
 * @property {Record<string, number[][]>} knobs
 */

/**
 * Unpacks `knobs.runtime.json` into the registry shape the rest of this module takes.
 * @param {PackedKnobRegistry} packed
 * @returns {RuntimeKnobRegistry}
 */
export function expandRuntimeRegistry(packed) {
    const lookup = (/** @type {string[]} */ list, /** @type {number} */ index) => {
        const value = list[index];
        if (typeof value !== 'string') throw new Error('The knob catalog is damaged; run `npm run theme:knobs`');
        return value;
    };
    /** @type {Record<string, {contexts: KnobContext[]}>} */
    const knobs = {};
    for (const [name, contexts] of Object.entries(packed.knobs)) {
        knobs[name] = {
            contexts: contexts.map(([selector, ...at]) => ({
                selector: lookup(packed.selectors, selector),
                at: at.map(index => lookup(packed.at, index)),
            })),
        };
    }
    return { knobs };
}

const ROOT_SELECTORS = new Set([':root', 'html']);

/**
 * True when a context declares the knob on the document root.
 * @param {KnobContext} context
 * @returns {boolean}
 */
export function isRootContext(context) {
    return context.at.length === 0 && ROOT_SELECTORS.has(context.selector.trim().toLowerCase());
}

/**
 * Scopes one selector to an active pack id (see the module comment for the three shapes).
 * Used for knob contexts and, since knobs landed, for pack `sheet.css` rules too: a sheet rule
 * written against `body` or `:root` now matches instead of silently becoming `body … body`.
 * @param {string} selector One selector.
 * @param {string} id Pack id (already validated as [a-z0-9-]+).
 * @returns {string}
 */
export function scopeSelector(selector, id) {
    const attribute = `[data-k-theme="${id}"]`;
    const source = selector.trim();
    const head = /^(body|html|:root)(?![\w-])/i.exec(source);
    if (!head) return `body${attribute} ${source}`;
    const rest = source.slice(head[1].length);
    if (head[1].toLowerCase() === 'body') return `body${attribute}${rest}`;
    return `:root:has(> body${attribute})${rest}`;
}

/**
 * Splits resolved pack overrides into what is written inline on <html> (core tokens, root-scoped
 * knobs, and knobs that are only ever consumed through a fallback) and what needs a scoped rule.
 * @param {Record<string, string>} overrides Resolved token overrides (core tokens + knobs).
 * @param {Set<string>} coreTokens Names declared in tokens.css `:root`.
 * @param {KnobRegistry|RuntimeKnobRegistry|null} registry
 * @returns {{root: Record<string, string>, scoped: Record<string, string>}}
 */
export function splitOverrides(overrides, coreTokens, registry) {
    /** @type {Record<string, string>} */
    const root = {};
    /** @type {Record<string, string>} */
    const scoped = {};
    for (const [name, value] of Object.entries(overrides)) {
        const entry = coreTokens.has(name) ? null : registry?.knobs[name];
        if (!entry) {
            root[name] = value;
            continue;
        }
        if (entry.contexts.length === 0 || entry.contexts.some(isRootContext)) root[name] = value;
        if (entry.contexts.some(context => !isRootContext(context))) scoped[name] = value;
    }
    return { root, scoped };
}

/**
 * @typedef {object} KnobRule
 * @property {string[]} at Wrapping conditional at-rule preludes, outermost first (from the catalog).
 * @property {string} selector The scoped selector (from the catalog, scoped by `scopeSelector`).
 * @property {[string, string][]} declarations Knob name → pack value, in catalog order.
 */

/**
 * Plans the scoped rules that re-declare a pack's knob values in every non-root context that
 * declares them. Pure data: nothing here is CSS text yet. Rule SHAPES (at-rule preludes and
 * selectors) come only from the shipped catalog and the validated pack id; pack VALUES travel
 * separately, as `declarations`, and only ever reach the page through `style.setProperty()`
 * (`writeKnobRules`). Deterministic: contexts are grouped by (at-rules, selector) in catalog order.
 * @param {Record<string, string>} scoped Knob name → value.
 * @param {KnobRegistry|RuntimeKnobRegistry} registry
 * @param {string} id Pack id (already validated as [a-z0-9-]+).
 * @returns {KnobRule[]}
 */
export function planKnobRules(scoped, registry, id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid theme pack id "${id}"`);
    /** @type {Map<string, KnobRule>} */
    const blocks = new Map();
    for (const [name, value] of Object.entries(scoped)) {
        const entry = registry.knobs[name];
        if (!entry) continue;
        for (const context of entry.contexts) {
            if (isRootContext(context)) continue;
            const selector = scopeSelector(context.selector, id);
            const key = `${context.at.join('\u0000')}\u0001${selector}`;
            let block = blocks.get(key);
            if (!block) {
                block = { at: [...context.at], selector, declarations: [] };
                blocks.set(key, block);
            }
            block.declarations.push([name, value]);
        }
    }
    return [...blocks.values()];
}

/**
 * @typedef {object} KnobWriteResult
 * @property {string[]} cssText The browser's own serialization of every top-level rule written,
 *   one entry per rule: what the first-paint cache stores and index.html replays rule by rule.
 * @property {{name: string, value: string, reason?: string}[]} refused Values the browser would not accept for a
 *   custom property, or whose whole rule it refused (`reason`); left unset, never pasted anywhere.
 */

/**
 * Writes planned knob rules into a live stylesheet through the CSSOM. Each rule is created EMPTY
 * from catalog text (`insertRule('<selector> {}')`, at-rules the same way), and every pack value is
 * set with `rule.style.setProperty(name, value)`. A value is therefore parsed by the browser as one
 * custom-property value and nothing else: it cannot close its declaration or its rule, add a rule,
 * or reach outside the scoped selector, whatever characters it holds. (core.js
 * `validateTokenValue` still rejects hostile values first; this is the layer that does not depend
 * on it being right.)
 * @param {CSSStyleSheet} sheet An empty stylesheet (a connected `<style>`'s `.sheet`).
 * @param {KnobRule[]} rules From `planKnobRules`.
 * @returns {KnobWriteResult}
 */
export function writeKnobRules(sheet, rules) {
    /** @type {{name: string, value: string, reason?: string}[]} */
    const refused = [];
    for (const rule of rules) {
        // One rule the browser cannot take (a selector it does not support, say `:has()` in an
        // older engine) costs that rule's values, never the rest of the pack: each rule is
        // inserted on its own, and a half-built wrapper is taken back out.
        const top = sheet.cssRules.length;
        try {
            /** @type {CSSStyleSheet|CSSGroupingRule} */
            let parent = sheet;
            for (const prelude of rule.at) {
                const index = parent.insertRule(`${prelude} {}`, parent.cssRules.length);
                parent = /** @type {CSSGroupingRule} */ (parent.cssRules[index]);
            }
            const index = parent.insertRule(`${rule.selector} {}`, parent.cssRules.length);
            const style = /** @type {CSSStyleRule} */ (parent.cssRules[index]).style;
            for (const [name, value] of rule.declarations) {
                style.setProperty(name, value);
                if (style.getPropertyValue(name) === '' && value.trim() !== '') refused.push({ name, value });
            }
        } catch (error) {
            while (sheet.cssRules.length > top) sheet.deleteRule(sheet.cssRules.length - 1);
            const reason = `the browser refused the rule "${rule.selector}" (${error instanceof Error ? error.message : String(error)})`;
            for (const [name, value] of rule.declarations) refused.push({ name, value, reason });
        }
    }
    return { cssText: Array.from(sheet.cssRules, rule => rule.cssText), refused };
}

/**
 * Edit distance, for "did you mean" hints on misspelled token names.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function distance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
}

/**
 * Finds the closest known name to a misspelled one.
 * @param {string} name
 * @param {Iterable<string>} candidates
 * @returns {string|null}
 */
export function suggestName(name, candidates) {
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const score = distance(name, candidate);
        if (score < bestDistance) {
            best = candidate;
            bestDistance = score;
        }
    }
    return best !== null && bestDistance <= Math.max(2, Math.floor(name.length / 5)) ? best : null;
}
