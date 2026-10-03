/**
 * Prompt order operations — slice C of the prompt-manager rework
 * (`docs/prompt-manager-v0.md`).
 *
 * Pure, DOM-free. It owns every decision slice C's interactions make ABOUT the order array;
 * `<k-prompt-list>` owns only the pointer plumbing and the two side effects (mutate the live
 * entries, hand the blob to the saver). Everything here is therefore unit-testable without a
 * browser, which is the point: the two bugs this slice exists to not repeat — core's drag
 * writing `undefined` into the order (`PromptManager.js:1923-1931`) and NemoPresetExt replaying
 * a batch as 94 sequential `.click()`s — are both order-array bugs, not UI bugs.
 *
 * ## Three rules everything below obeys
 *
 * 1. **The order is spliced, never regenerated.** No function here builds an order entry.
 *    {@link moveOrderBlock} returns a PERMUTATION of the array it was handed — the same entry
 *    OBJECTS, the same count, in a different sequence. That is what keeps `unknownOrder` entries
 *    (an order entry whose prompt record is gone — never rendered, therefore never in a block
 *    and never a drop anchor) alive across a reorder, and what makes `undefined` unreachable:
 *    an entry can only leave the array by being put back somewhere else.
 * 2. **First entry wins.** `getPromptOrderEntry` resolves an identifier with `.find()`
 *    (`PromptManager.js:1249`), so a duplicated identifier means core reads and writes the FIRST
 *    entry and ignores the rest. {@link firstIndexOf} is the single implementation of that rule;
 *    {@link resolveBatch} reports which identifiers were duplicated so the UI can say so.
 * 3. **A batch is one write.** {@link resolveBatch} resolves a whole plan — radio enforcement,
 *    a master toggle, a single row — into one list of entry writes, with redundant writes
 *    (already at the target state) and missing identifiers dropped and reported. An empty
 *    `writes` list means: change nothing, save nothing, announce nothing.
 *
 * ## Radio enforcement (decision 6, MANDATORY by default)
 *
 * Enabling an option disables its siblings in the SAME write ({@link planRadioEnable}).
 * Disabling never cascades — a group with every member off is legal, because "pick one" is a
 * constraint on how many can be on, not a promise that one always is. Groups come from slice A's
 * {@link exclusiveGroups}, which is the only authority on membership; this module adds the
 * per-container key (`identifier ?? id`, slice B's collapse-key rule, so a rename keeps the
 * state) and the member → group index.
 *
 * The default has one exception ({@link radioEnforcement}): a group that already has more than
 * one member on is not a radio group right now, whatever its banner says, and is left `open`
 * until the reader enforces it. Enforcing it by default turned one click into "switch off
 * everything else under this banner" on a preset whose "pick one" banner ran on past its options.
 */

import { exclusiveGroups } from './sections.js';

/**
 * `accountStorage` key prefix for relaxed groups. One key per preset holding a JSON array of
 * container keys — the same one-write-per-toggle shape slice B's collapse state uses.
 */
export const RELAX_KEY_PREFIX = 'kotatsu.promptList.relaxed.';

/**
 * `accountStorage` key prefix for groups the reader enforced by hand: the only way an `open`
 * group becomes enforced. Same shape as {@link RELAX_KEY_PREFIX}.
 */
export const ENFORCE_KEY_PREFIX = 'kotatsu.promptList.enforced.';

/** Preset name stand-in, identical to slice B's, so both keys land in the same bucket. */
const UNNAMED_PRESET = '(unnamed)';

/**
 * @typedef {import('./sections.js').Section} Section
 * @typedef {import('./sections.js').SectionNode} SectionNode
 * @typedef {import('./sections.js').OrderEntry} OrderEntry
 */

/**
 * One resolved entry write. `index` is the position in the LIVE order array, so the caller
 * mutates by index and never has to re-`find()`.
 * @typedef {object} EntryWrite
 * @property {string} identifier
 * @property {number} index Index in the order array — the FIRST entry for that identifier.
 * @property {boolean} enabled Target state.
 */

/**
 * @typedef {object} BatchPlan
 * @property {EntryWrite[]} writes In ascending index order; empty means "do nothing".
 * @property {string[]} missing Identifiers with no order entry at all.
 * @property {string[]} redundant Identifiers already at the requested state.
 * @property {string[]} duplicated Identifiers this order lists more than once (first was used).
 */

/**
 * One exclusive group, ready for enforcement.
 * @typedef {object} RadioGroup
 * @property {string} key Persistence key — the container's prompt identifier, or its tree id.
 * @property {string} id Slice A's container id.
 * @property {string} label
 * @property {string[]} members Direct option identifiers, in render order.
 */

/**
 * @typedef {object} TreeIndex
 * @property {Map<string, string[]>} members Container key → identifiers INSIDE it (the same set
 *   its `(n/m)` counter describes: the subtree plus a span's closing row, its own row excluded).
 * @property {Map<string, string[]>} blocks Draggable identifier → the block it moves as. A span
 *   maps to `[open, …children…, close]`; a leaf or option maps to itself. Group and section
 *   header rows are absent, which is exactly what makes them undraggable.
 * @property {RadioGroup[]} groups Every exclusive container.
 * @property {Map<string, RadioGroup>} groupOfMember Option identifier → its group.
 * @property {string[]} rendered Every identifier the tree renders, in render order.
 */

/**
 * The `accountStorage` key for one preset's relaxed-group set.
 * @param {string} presetName Preset name from `serviceSettings.preset_settings_openai`.
 * @returns {string} Storage key.
 */
export function relaxStorageKey(presetName) {
    const name = typeof presetName === 'string' && presetName.trim() ? presetName.trim() : UNNAMED_PRESET;
    return `${RELAX_KEY_PREFIX}${name}`;
}

/**
 * The `accountStorage` key for one preset's hand-enforced group set.
 * @param {string} presetName Preset name from `serviceSettings.preset_settings_openai`.
 * @returns {string} Storage key.
 */
export function enforceStorageKey(presetName) {
    const name = typeof presetName === 'string' && presetName.trim() ? presetName.trim() : UNNAMED_PRESET;
    return `${ENFORCE_KEY_PREFIX}${name}`;
}

/**
 * Whether one exclusive group is being enforced right now.
 *
 * - `relaxed`: the reader turned enforcement off for it. Their choice wins.
 * - `enforced`: the reader turned it on by hand, or nothing says otherwise and the group is in a
 *   state a radio group can be in (at most one member on).
 * - `open`: nobody chose, and more than one member is already on. It is treated as plain toggles,
 *   because enforcing it would make the next click switch the others off.
 *
 * Read live, never cached: a group drops back to `enforced` by itself once it is down to one.
 * @param {RadioGroup} group The group.
 * @param {(identifier: string) => boolean} isEnabled Live enabled state.
 * @param {object} [choices] The reader's stored choices for this preset.
 * @param {Set<string>} [choices.relaxed] Keys relaxed by hand.
 * @param {Set<string>} [choices.enforced] Keys enforced by hand.
 * @returns {'enforced'|'relaxed'|'open'} The state.
 */
export function radioEnforcement(group, isEnabled, { relaxed, enforced } = {}) {
    if (relaxed?.has(group.key)) return 'relaxed';
    if (enforced?.has(group.key)) return 'enforced';
    let on = 0;
    for (const member of Array.isArray(group.members) ? group.members : []) {
        if (isEnabled(member) === true && ++on > 1) return 'open';
    }
    return 'enforced';
}

/**
 * True for a plain, non-array object safe to read keys off.
 * @param {unknown} value Candidate.
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Indexes an order array by identifier, FIRST entry wins — core's `.find()` semantics
 * (`PromptManager.js:1249`), spelled once.
 * @param {unknown} order The live order array.
 * @returns {Map<string, number>} identifier → index of its first entry.
 */
export function firstIndexOf(order) {
    /** @type {Map<string, number>} */
    const index = new Map();
    if (!Array.isArray(order)) return index;
    for (let at = 0; at < order.length; at++) {
        const entry = order[at];
        if (!isPlainObject(entry)) continue;
        const identifier = /** @type {Record<string, any>} */ (entry).identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        if (!index.has(identifier)) index.set(identifier, at);
    }
    return index;
}

/**
 * Identifiers an order lists more than once. Slice A reports the same set off the tree; this is
 * the order-side computation, so a batch write can flag it without a tree in hand.
 * @param {unknown} order The live order array.
 * @returns {Set<string>} Duplicated identifiers.
 */
export function duplicateIdentifiers(order) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {Set<string>} */
    const duplicated = new Set();
    if (!Array.isArray(order)) return duplicated;
    for (const entry of order) {
        if (!isPlainObject(entry)) continue;
        const identifier = /** @type {Record<string, any>} */ (entry).identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        if (seen.has(identifier)) duplicated.add(identifier);
        seen.add(identifier);
    }
    return duplicated;
}

/**
 * Resolves a plan into the entry writes it actually implies.
 *
 * A plan may name the same identifier twice (two groups claiming one option, say); the LAST
 * statement wins, because a plan is read top to bottom like the sentence it is. Redundant and
 * missing identifiers are dropped and reported rather than written: writing them would be
 * invisible in the settings blob but visible in the save traffic and in the token-count
 * invalidation, and a batch that "changed" nothing must not announce that it did.
 * @param {unknown} order The LIVE order array.
 * @param {Array<{identifier: string, enabled: boolean}>} changes The plan.
 * @returns {BatchPlan} What to write.
 */
export function resolveBatch(order, changes) {
    const source = Array.isArray(order) ? order : [];
    const index = firstIndexOf(source);
    const duplicates = duplicateIdentifiers(source);
    /** @type {Map<string, boolean>} */
    const wanted = new Map();
    for (const change of Array.isArray(changes) ? changes : []) {
        if (!isPlainObject(change)) continue;
        const identifier = /** @type {Record<string, any>} */ (change).identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        wanted.set(identifier, /** @type {Record<string, any>} */ (change).enabled === true);
    }

    /** @type {EntryWrite[]} */
    const writes = [];
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const redundant = [];
    /** @type {string[]} */
    const duplicated = [];
    for (const [identifier, enabled] of wanted) {
        const at = index.get(identifier);
        if (at === undefined) {
            missing.push(identifier);
            continue;
        }
        if (duplicates.has(identifier)) duplicated.push(identifier);
        const current = /** @type {Record<string, any>} */ (source[at]).enabled === true;
        if (current === enabled) {
            redundant.push(identifier);
            continue;
        }
        writes.push({ identifier, index: at, enabled });
    }
    writes.sort((a, b) => a.index - b.index);
    return { writes, missing, redundant, duplicated };
}

/**
 * Walks a derived tree ONCE and produces every lookup the interaction layer needs.
 *
 * Doing it per interaction would be a tree search per click; doing it per refresh is one O(rows)
 * pass next to the model build that already happens there.
 * @param {Section[]} sections Slice A's derived sections.
 * @returns {TreeIndex} The lookups.
 */
export function indexTree(sections) {
    // Filtered up front, and then used everywhere below: `exclusiveGroups` reads `.children` off
    // whatever it is handed, so a junk element would throw inside slice A rather than here.
    const list = (Array.isArray(sections) ? sections : []).filter(isPlainObject);
    /** @type {Map<string, string[]>} */
    const members = new Map();
    /** @type {Map<string, string[]>} */
    const blocks = new Map();
    /** @type {string[]} */
    const rendered = [];
    /** @type {Map<string, string>} */
    const keyOfId = new Map();

    /**
     * @param {SectionNode[]} nodes Nodes to walk.
     * @returns {string[]} Every identifier this list renders, in render order.
     */
    const walk = (nodes) => {
        /** @type {string[]} */
        const flat = [];
        for (const node of Array.isArray(nodes) ? nodes : []) {
            if (!isPlainObject(node)) continue;
            const identifier = typeof node.identifier === 'string' ? node.identifier : '';
            const close = typeof node.closeIdentifier === 'string' ? node.closeIdentifier : '';
            const container = node.kind === 'group' || node.kind === 'span';
            if (identifier) {
                rendered.push(identifier);
                flat.push(identifier);
            }
            const inner = container ? walk(node.children ?? []) : [];
            flat.push(...inner);
            if (close) {
                rendered.push(close);
                flat.push(close);
            }
            if (container) {
                const key = identifier || String(node.id ?? '');
                keyOfId.set(String(node.id ?? ''), key);
                members.set(key, close ? [...inner, close] : inner);
            }
            // Drag sources. A span moves as one block — its opening row, everything nested, and
            // its closing row — because both boundary rows are real prompts and a span whose
            // tags straddle other prompts is a different preset (slice A's handoff note).
            if (node.kind === 'span' && identifier) {
                blocks.set(identifier, close ? [identifier, ...inner, close] : [identifier, ...inner]);
            } else if ((node.kind === 'leaf' || node.kind === 'option') && identifier) {
                blocks.set(identifier, [identifier]);
            }
        }
        return flat;
    };

    for (const section of list) {
        const identifier = typeof section.identifier === 'string' ? section.identifier : '';
        if (identifier) rendered.push(identifier);
        const inner = walk(section.children ?? []);
        const key = identifier || String(section.id ?? '');
        keyOfId.set(String(section.id ?? ''), key);
        members.set(key, inner);
    }

    /** @type {RadioGroup[]} */
    const groups = exclusiveGroups(list).map(group => ({
        key: keyOfId.get(group.id) ?? group.id,
        id: group.id,
        label: group.label,
        members: group.memberIdentifiers.slice(),
    }));
    /** @type {Map<string, RadioGroup>} */
    const groupOfMember = new Map();
    for (const group of groups) {
        for (const member of group.members) {
            if (!groupOfMember.has(member)) groupOfMember.set(member, group);
        }
    }

    return { members, blocks, groups, groupOfMember, rendered };
}

/**
 * The plan for enabling one member of an enforced radio group: it goes on, every sibling that is
 * currently on goes off, all in one write (decision 6).
 *
 * Siblings that are already off are not written — see {@link resolveBatch}'s note on redundant
 * writes. Disabling is NOT this function's business: it never cascades, and a group with nothing
 * enabled is a legal state.
 * @param {string[]} members The group's member identifiers.
 * @param {string} identifier The member being enabled.
 * @param {(identifier: string) => boolean} isEnabled Live enabled state.
 * @returns {Array<{identifier: string, enabled: boolean}>} The plan.
 */
export function planRadioEnable(members, identifier, isEnabled) {
    /** @type {Array<{identifier: string, enabled: boolean}>} */
    const changes = [{ identifier, enabled: true }];
    for (const member of Array.isArray(members) ? members : []) {
        if (typeof member !== 'string' || !member || member === identifier) continue;
        if (isEnabled(member) !== true) continue;
        changes.push({ identifier: member, enabled: false });
    }
    return changes;
}

/**
 * The plan for a container's master toggle.
 *
 * Nemo semantics for `auto`: if anything inside is off, turn everything on; otherwise turn
 * everything off. `clear` is the enforced-radio variant — "all on" is not a state a radio group
 * can be in, so its master control only ever empties the group.
 *
 * Under `auto`, an enforced group inside the scope keeps its invariant: exactly one member comes
 * on — the one that already was, or the first — and the rest go off. Without that, "enable all"
 * on a section would leave three options lit in a group whose whole promise is that one is.
 * A group is normally wholly inside the container being toggled; if an authored override bag
 * splits one across containers, the out-of-scope members that are ON are turned off too, because
 * the invariant is the thing being protected, not the scope.
 * @param {object} input Input.
 * @param {string[]} input.identifiers Identifiers inside the container, render order, already
 *   filtered to the ones this UI would let a reader toggle one at a time.
 * @param {(identifier: string) => boolean} input.isEnabled Live enabled state.
 * @param {RadioGroup[]} [input.groups] Groups whose enforcement is ON.
 * @param {'auto'|'clear'} [input.mode] Master semantics.
 * @returns {Array<{identifier: string, enabled: boolean}>} The plan.
 */
export function planMasterToggle({ identifiers, isEnabled, groups = [], mode = 'auto' }) {
    /** @type {string[]} */
    const scope = [];
    /** @type {Set<string>} */
    const inScope = new Set();
    for (const identifier of Array.isArray(identifiers) ? identifiers : []) {
        if (typeof identifier !== 'string' || !identifier || inScope.has(identifier)) continue;
        inScope.add(identifier);
        scope.push(identifier);
    }
    const target = mode === 'clear' ? false : scope.some(identifier => isEnabled(identifier) !== true);
    if (!target) return scope.map(identifier => ({ identifier, enabled: false }));

    /** @type {Map<string, boolean>} */
    const decided = new Map();
    for (const group of Array.isArray(groups) ? groups : []) {
        const covered = group.members.filter(member => inScope.has(member));
        if (covered.length === 0) continue;
        const winner = covered.find(member => isEnabled(member) === true) ?? covered[0];
        for (const member of group.members) decided.set(member, member === winner);
    }

    /** @type {Array<{identifier: string, enabled: boolean}>} */
    const changes = scope.map(identifier => ({
        identifier,
        enabled: decided.has(identifier) ? decided.get(identifier) === true : true,
    }));
    for (const [identifier, enabled] of decided) {
        if (inScope.has(identifier) || enabled) continue;
        if (isEnabled(identifier) === true) changes.push({ identifier, enabled: false });
    }
    return changes;
}

/**
 * Where a dragged block lands.
 * @typedef {object} DropAnchor
 * @property {string} [identifier] A RENDERED identifier to land beside.
 * @property {'before'|'after'} [edge] Which side of it.
 * @property {'start'|'end'} [at] Or: the ends of the whole order.
 */

/**
 * @typedef {object} MoveResult
 * @property {any[]} next The new order — a permutation of `order`, same entry objects.
 * @property {boolean} moved False when nothing would change; the caller then saves nothing.
 * @property {'ok'|'noop'|'empty-block'|'no-anchor'|'anchor-in-block'|'anchor-missing'} reason
 */

/**
 * Moves a block of identifiers to a new position — the whole drag write.
 *
 * The result is a PERMUTATION, proved by construction: the block's entries are lifted out BY
 * INDEX, the rest keep their relative order untouched, and the two lists are concatenated. No
 * entry is created, none is dropped, and no DOM id is ever mapped through the order (which is
 * exactly how core's sortable ends up writing `undefined`, `PromptManager.js:1927`). Entries the
 * tree never rendered — an order entry with no prompt record — are never in a block and never an
 * anchor, so they ride along in the residual list with their neighbours intact.
 *
 * The landed run follows `block`'s own sequence (render order), not the array's. For a span
 * whose rows are contiguous — every derived tree produces exactly that — the two are the same.
 * @param {unknown} order The LIVE order array. Not mutated.
 * @param {string[]} block Identifiers to move, in the order they must land.
 * @param {DropAnchor} anchor Where to land.
 * @returns {MoveResult} The new order and whether it differs.
 */
export function moveOrderBlock(order, block, anchor) {
    const source = Array.isArray(order) ? order : [];
    const index = firstIndexOf(source);
    /** @type {Set<number>} */
    const taken = new Set();
    /** @type {number[]} */
    const picked = [];
    for (const identifier of Array.isArray(block) ? block : []) {
        const at = typeof identifier === 'string' ? index.get(identifier) : undefined;
        if (at === undefined || taken.has(at)) continue;
        taken.add(at);
        picked.push(at);
    }
    if (picked.length === 0) return { next: source.slice(), moved: false, reason: 'empty-block' };

    const entries = picked.map(at => source[at]);
    const residual = source.filter((_, at) => !taken.has(at));

    let insertAt;
    if (anchor?.at === 'start') {
        insertAt = 0;
    } else if (anchor?.at === 'end') {
        insertAt = residual.length;
    } else {
        const identifier = anchor?.identifier;
        if (typeof identifier !== 'string' || !identifier) {
            return { next: source.slice(), moved: false, reason: 'no-anchor' };
        }
        const anchorAt = index.get(identifier);
        if (anchorAt !== undefined && taken.has(anchorAt)) {
            return { next: source.slice(), moved: false, reason: 'anchor-in-block' };
        }
        const at = residual.findIndex(entry => isPlainObject(entry)
            && /** @type {Record<string, any>} */ (entry).identifier === identifier);
        if (at === -1) return { next: source.slice(), moved: false, reason: 'anchor-missing' };
        insertAt = anchor?.edge === 'after' ? at + 1 : at;
    }

    const next = residual.slice(0, insertAt).concat(entries, residual.slice(insertAt));
    const moved = next.some((entry, at) => entry !== source[at]);
    return { next, moved, reason: moved ? 'ok' : 'noop' };
}
