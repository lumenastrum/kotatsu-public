/**
 * Prompt list view model — slice B of the prompt-manager rework
 * (`docs/prompt-manager-v0.md`).
 *
 * Pure, DOM-free, imports nothing. It turns slice A's section tree plus the LIVE preset state
 * into the exact shape `<k-prompt-list>` renders, and it is the only place row semantics are
 * decided. Slice C extends the same functions rather than re-deriving them in the component.
 *
 * ## The live-state rule
 *
 * `deriveSections()` stamps an `enabled` SNAPSHOT on every node and its own header says never
 * to trust it. This module obeys that literally: {@link buildListModel} takes the live
 * `promptOrder` array and reads `enabled` from THERE, indexing it once (O(n)) into a lookup.
 * Nothing here ever reads `node.enabled`. A toggle therefore only has to flip the order entry
 * and rebuild the model — the tree is untouched, and the component's DOM is patched, not rebuilt.
 *
 * ## Row semantics (core parity, receipts inline)
 *
 * The five row kinds are core's five discriminations at `PromptManager.js:1722-1728`, re-spelled
 * as one enum instead of five booleans. They are read off the RAW `serviceSettings.prompts`
 * record, never off a `new Prompt(...)` — that constructor drops `marker` and `enabled`
 * (`PromptManager.js:182`), which would silently erase every marker row's identity.
 *
 * ## Token-badge honesty
 *
 * `tokenHandler.counts` looks like a per-identifier map and is NOT one. Measured live on the
 * Sparkle Sauce fixture, 2026-08-24:
 *
 * - `TokenHandler`'s constructor seeds eight LEGACY BUCKET keys at zero — `start_chat`,
 *   `prompt`, `bias`, `nudge`, `jailbreak`, `impersonate`, `examples`, `conversation`
 *   (`openai.js:3322-3331`). One of them, `jailbreak`, is also a real prompt identifier, so on a
 *   cold boot that row's count reads `0` while nothing has been assembled at all.
 * - `resetCounts()` sets every EXISTING key to zero rather than clearing the object
 *   (`openai.js:3338-3340`), and `populateTokenCounts` then writes only the identifiers that
 *   contributed (`PromptManager.js:1582-1587`). So an identifier that contributed once and was
 *   later switched off keeps a stale `0` forever.
 *
 * A number in `counts` is therefore never on its own permission to draw a badge. The authority
 * is the last assembly's message collection — `promptManager.messages`, the same object
 * `handleInspect` reads — which contains exactly the identifiers that produced a collection.
 * Four rules follow, all implemented in {@link tokenBadge}:
 *
 * 1. **Not in the last assembly → no badge.** `contributed` is the identifier set from
 *    `promptManager.messages`; `null` means no assembly has run, and then NOTHING gets a badge.
 *    This is what kills both the legacy buckets and the stale zeros.
 * 2. **No usable entry → no badge.** Never a fabricated `0`, never core's `-` placeholder.
 *    `/setpromptentry` and core's own toggle write `counts[id] = null` to invalidate
 *    (`slash-commands.js:6535`, `PromptManager.js:448`), so `null` counts as "no entry".
 * 3. **In-chat prompts never get a badge.** An `injection_position === 1` prompt is injected
 *    into the chat history collection, so its tokens are attributed to `chatHistory` and it can
 *    never have an honest number of its own.
 * 4. **`main` when disabled is suppressed.** Assembly anchors an empty, zero-token collection
 *    for `main` even when its order entry is off (slice 0's characterization, "the disabled-main
 *    empty-anchor quirk") — so it passes rule 1 legitimately. Left alone it would be the only
 *    disabled row in the panel wearing a badge, and a `0` there reads as a measurement rather
 *    than as an absence.
 *
 * ## Counters
 *
 * A container's `(n/m)` answers *what is inside me*: its own header row is counted by its
 * PARENT, and a span's closing row counts here because it is part of the span's body. Section
 * totals therefore sum their children's whole subtrees, banner excluded, and the model's grand
 * total equals the number of order rows the tree renders.
 */

/**
 * `INJECTION_POSITION.ABSOLUTE` (`PromptManager.js:37-40`), mirrored rather than imported:
 * that module pulls in the whole core DOM surface, and this one must stay loadable by a test
 * with no mocks at all.
 */
const ABSOLUTE_INJECTION = 1;

/** Core's default injection depth (`PromptManager.js:31`), used when a record omits it. */
const DEFAULT_DEPTH = 4;

/** Roles that earn a chip. Core shows an icon for exactly these (`PromptManager.js:1732-1736`). */
const CHIPPED_ROLES = Object.freeze(['user', 'assistant']);

/**
 * @typedef {import('./sections.js').Section} Section
 * @typedef {import('./sections.js').SectionNode} SectionNode
 * @typedef {import('./sections.js').SectionTree} SectionTree
 */

/**
 * Budget inputs for the chat-history squeeze warning. Core computes this inline
 * (`PromptManager.js:1677-1690`); it is passed in so the model stays pure.
 * @typedef {object} BudgetInput
 * @property {number} [tokenUsage] Total of the last assembly.
 * @property {number} [maxContext] `openai_max_context`.
 * @property {number} [maxTokens] `openai_max_tokens`.
 * @property {number} [warningThreshold] Default 1500, core's `warningTokenThreshold`.
 * @property {number} [dangerThreshold] Default 500, core's `dangerTokenThreshold`.
 */

/**
 * One prompt row, fully resolved. Everything the component needs to paint a row is here; the
 * component reads nothing else off core per row.
 * @typedef {object} RowView
 * @property {string} identifier
 * @property {string} label Cleaned label from the tree, or the raw name when there is none,
 *   without a leading `[Tag]` (see `tag`).
 * @property {string} tag A leading `[Tag]` peeled off the label, '' when the name has none.
 * @property {string} name Raw `prompts[].name` — the search corpus, per slice A's note.
 * @property {boolean} enabled Read from the LIVE order, never from the tree snapshot.
 * @property {boolean} present False when `prompts[]` has no record for this identifier.
 * @property {'marker'|'global'|'important'|'preset'|'in-chat'} kind
 * @property {boolean} marker
 * @property {boolean} inChat `injection_position === 1`.
 * @property {number} depth Injection depth; meaningful only when `inChat`.
 * @property {string} role
 * @property {string} roleChip `user` / `assistant`, or '' when the role earns no chip.
 * @property {boolean} overridden Pulled from a character card this generation.
 * @property {string} source Friendly marker source label, '' when the identifier is not one.
 * @property {number|null} tokens Honest badge value; null means "show no badge".
 * @property {'warning'|'danger'|null} warn Chat-history squeeze level.
 * @property {string} sigil The leading token slice A stripped off the label.
 * @property {string} haystack Lowercased `name` + `content`, built once per model.
 */

/**
 * @typedef {object} Counter
 * @property {number} enabled
 * @property {number} total
 */

/**
 * A rendered node. Containers (`group`, `span`) carry children and a counter; `leaf` and
 * `option` carry only their row. `key` is the collapse-state key — the prompt identifier when
 * the container has one (so a rename cannot lose the state), the derived tree id otherwise.
 * @typedef {object} NodeView
 * @property {'group'|'span'|'leaf'|'option'} kind
 * @property {string} id Tree node id.
 * @property {string} key Collapse key.
 * @property {string} label
 * @property {number} depth
 * @property {boolean} exclusive Group only — the radio-group affordance (slice C enforces it).
 * @property {RowView|null} row This node's own prompt row.
 * @property {RowView|null} closeRow Span only — the closing prompt.
 * @property {NodeView[]} children
 * @property {Counter} counter What is inside this container.
 */

/**
 * @typedef {object} SectionView
 * @property {string} id
 * @property {string} key Collapse key, `identifier ?? id`.
 * @property {string} label
 * @property {'banner'|'flat'} kind
 * @property {boolean} exclusive
 * @property {boolean} collapsedDefault
 * @property {RowView|null} row The banner prompt, when the section came from one.
 * @property {NodeView[]} children
 * @property {Counter} counter Everything under the banner; the banner row itself excluded.
 */

/**
 * @typedef {object} ListModel
 * @property {'override'|'sigil'|'legacy'|'flat'} tier
 * @property {SectionView[]} sections
 * @property {RowView[]} unlisted `prompts[]` entries with no order entry — the shelf.
 * @property {string[]} unknownOrder Order entries with no prompt record.
 * @property {string[]} duplicateOrder Identifiers the order lists more than once.
 * @property {Map<string, RowView>} rowsByIdentifier Every rendered row, order-listed ones only.
 * @property {Counter} totals Grand total across sections, banners included.
 */

/**
 * @typedef {object} SearchResult
 * @property {boolean} active
 * @property {string[]} terms
 * @property {Set<string>} matches Identifiers satisfying every term.
 * @property {Set<string>} expand Container keys to force open.
 * @property {number} count `matches.size`, for the honest "n of m" readout.
 * @property {number} scanned Rows the query was run over.
 */

/**
 * An inactive search. Shared, so an empty query allocates nothing — and frozen, so no caller
 * can mutate the sets that belong to no one.
 * @type {SearchResult}
 */
export const NO_PROMPT_SEARCH = Object.freeze({
    active: false,
    terms: /** @type {string[]} */ ([]),
    matches: new Set(),
    expand: new Set(),
    count: 0,
    scanned: 0,
});

/**
 * True for a plain, non-array object safe to read keys off.
 * @param {unknown} value Candidate.
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Core's five row discriminations (`PromptManager.js:1722-1726`) as one enum.
 *
 * Read off the RAW record — a `new Prompt(...)` has already lost `marker`.
 * @param {Record<string, any>|null|undefined} prompt Raw `serviceSettings.prompts` entry.
 * @returns {'marker'|'global'|'important'|'preset'|'in-chat'} The row kind.
 */
export function classifyPromptKind(prompt) {
    const record = isPlainObject(prompt) ? /** @type {Record<string, any>} */ (prompt) : {};
    if (Number(record.injection_position) === ABSOLUTE_INJECTION) return 'in-chat';
    if (record.marker === true) return 'marker';
    if (record.system_prompt === true) return record.forbid_overrides === true ? 'important' : 'global';
    return 'preset';
}

/**
 * The honest token badge for one row. See the module header for the four rules; `null` means
 * "render no badge", which is never the same statement as "0".
 * @param {object} input Input.
 * @param {string} input.identifier Prompt identifier.
 * @param {Record<string, any>|null|undefined} input.prompt Raw prompt record.
 * @param {boolean} input.enabled Live enabled state.
 * @param {Record<string, unknown>|null|undefined} input.counts `tokenHandler.counts`.
 * @param {Set<string>|null|undefined} input.contributed Identifiers the LAST assembly actually
 *   produced a message collection for (`promptManager.messages`). `null` / absent means no
 *   assembly has run, and then no row may claim a number.
 * @returns {number|null} Token count, or null when there is nothing honest to show.
 */
export function tokenBadge({ identifier, prompt, enabled, counts, contributed }) {
    if (!(contributed instanceof Set) || !contributed.has(identifier)) return null;
    if (classifyPromptKind(prompt) === 'in-chat') return null;
    if (!isPlainObject(counts)) return null;
    if (!Object.hasOwn(/** @type {object} */ (counts), identifier)) return null;
    const raw = /** @type {Record<string, unknown>} */ (counts)[identifier];
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    if (identifier === 'main' && !enabled && value === 0) return null;
    return value;
}

/**
 * The chat-history squeeze warning, exactly core's arithmetic (`PromptManager.js:1677-1690`):
 * it only fires on `chatHistory`, and only once the assembly has eaten 80% of the budget.
 * @param {string} identifier Prompt identifier.
 * @param {number|null} tokens The row's badge value.
 * @param {BudgetInput|null|undefined} budget Budget inputs.
 * @returns {'warning'|'danger'|null} Warning level.
 */
export function historyWarning(identifier, tokens, budget) {
    if (identifier !== 'chatHistory' || tokens === null || !isPlainObject(budget)) return null;
    const spec = /** @type {BudgetInput} */ (budget);
    const maxContext = Number(spec.maxContext);
    const maxTokens = Number(spec.maxTokens);
    const usage = Number(spec.tokenUsage);
    if (!Number.isFinite(maxContext) || !Number.isFinite(maxTokens) || !Number.isFinite(usage)) return null;
    const available = maxContext - maxTokens;
    if (!(usage > available * 0.8)) return null;
    const danger = Number.isFinite(Number(spec.dangerThreshold)) ? Number(spec.dangerThreshold) : 500;
    const warning = Number.isFinite(Number(spec.warningThreshold)) ? Number(spec.warningThreshold) : 1500;
    if (tokens <= danger) return 'danger';
    if (tokens <= warning) return 'warning';
    return null;
}

/**
 * Indexes the live order once. O(n), and the ONLY place enabled state is read from.
 * @param {unknown} promptOrder The resolved `100001` order array.
 * @returns {Map<string, boolean>} identifier → enabled.
 */
export function indexOrder(promptOrder) {
    /** @type {Map<string, boolean>} */
    const index = new Map();
    if (!Array.isArray(promptOrder)) return index;
    for (const entry of promptOrder) {
        if (!isPlainObject(entry)) continue;
        const identifier = /** @type {Record<string, any>} */ (entry).identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        // First entry wins, matching `getPromptOrderEntry`'s `.find()` (`PromptManager.js:1249`)
        // — a duplicated identifier is reported by the tree, never silently re-read.
        if (!index.has(identifier)) index.set(identifier, entry.enabled === true);
    }
    return index;
}

/**
 * Indexes `prompts[]` by identifier, first record wins (slice A does the same).
 * @param {unknown} prompts The preset's `prompts[]`.
 * @returns {Map<string, Record<string, any>>} identifier → raw record.
 */
export function indexPrompts(prompts) {
    /** @type {Map<string, Record<string, any>>} */
    const index = new Map();
    if (!Array.isArray(prompts)) return index;
    for (const prompt of prompts) {
        if (!isPlainObject(prompt)) continue;
        const record = /** @type {Record<string, any>} */ (prompt);
        const identifier = record.identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        if (!index.has(identifier)) index.set(identifier, record);
    }
    return index;
}

/**
 * Build context threaded through the walk. Assembled once per {@link buildListModel} call.
 * @typedef {object} BuildContext
 * @property {Map<string, Record<string, any>>} prompts
 * @property {Map<string, boolean>} enabled
 * @property {Record<string, unknown>} counts
 * @property {Set<string>|null} contributed
 * @property {Set<string>} overridden
 * @property {Record<string, string>} sources
 * @property {BudgetInput|null} budget
 * @property {Map<string, RowView>} rows
 */

/** A bracketed tag in front of a name: `[Module] Voice: Idiolect`. The tag is kept short on purpose. */
const LEADING_TAG = /^\[([^\][]{1,24})\]\s*(\S[\s\S]*)$/;
/** Sola V2's "this is one of a set" marker, written into each option's own name. */
const PICK_ONE_TAG = /\s*\(\s*pick\s*(?:1|one)\s*\)/i;

/**
 * Splits a label into the words that tell rows apart and the tag in front of them.
 *
 * Sola V2 opens all 70 of its names with `[Core]` or `[Module]`. In a narrow dock the tag is the
 * first thing drawn and the last thing anyone needs, so the row shows it as a chip that can step
 * aside and starts the name at the first real word. A row that is one option of a pick-one group
 * also drops its "(Pick 1)": the group header already says so.
 *
 * Display only. `name` stays raw, which is what search and the tooltip read.
 * @param {string} label The label so far.
 * @param {boolean} option Whether the row is an option of a pick-one group.
 * @returns {{label: string, tag: string}} The label to draw and the tag peeled off it.
 */
export function splitLabel(label, option = false) {
    let text = String(label ?? '');
    let tag = '';
    const tagged = LEADING_TAG.exec(text);
    if (tagged) {
        tag = tagged[1].trim();
        text = tagged[2];
    }
    if (option) {
        const stripped = text.replace(PICK_ONE_TAG, '').trim();
        if (stripped) text = stripped;
    }
    return { label: text, tag };
}

/**
 * Builds one row.
 * @param {string} identifier Prompt identifier.
 * @param {string} label Cleaned label from the tree, when the tree had one.
 * @param {string} sigil Leading token the tree stripped.
 * @param {BuildContext} ctx Build context.
 * @param {boolean} [option] Whether the row is an option of a pick-one group.
 * @returns {RowView} The row.
 */
function buildRow(identifier, label, sigil, ctx, option = false) {
    const prompt = ctx.prompts.get(identifier) ?? null;
    const name = prompt && typeof prompt.name === 'string' ? prompt.name : '';
    const shown = splitLabel(label || name || identifier, option);
    const enabled = ctx.enabled.get(identifier) === true;
    const kind = classifyPromptKind(prompt);
    const tokens = tokenBadge({ identifier, prompt, enabled, counts: ctx.counts, contributed: ctx.contributed });
    const role = prompt && typeof prompt.role === 'string' ? prompt.role : 'system';
    const content = prompt && typeof prompt.content === 'string' ? prompt.content : '';
    const depthRaw = Number(prompt?.injection_depth);
    /** @type {RowView} */
    const row = {
        identifier,
        label: shown.label,
        tag: shown.tag,
        name,
        enabled,
        present: prompt !== null,
        kind,
        marker: prompt?.marker === true,
        inChat: kind === 'in-chat',
        depth: Number.isFinite(depthRaw) ? depthRaw : DEFAULT_DEPTH,
        role,
        roleChip: CHIPPED_ROLES.includes(role) ? role : '',
        overridden: ctx.overridden.has(identifier),
        source: typeof ctx.sources[identifier] === 'string' ? ctx.sources[identifier] : '',
        tokens,
        warn: historyWarning(identifier, tokens, ctx.budget),
        sigil,
        // Built once here, not per keystroke: search is fragment-AND over name AND content
        // (decision 7), and lowercasing 94 prompt bodies on every input event is the exact
        // O(n²)-on-a-timer shape the Nemo autopsy condemned.
        haystack: `${name}\n${content}`.toLowerCase(),
    };
    ctx.rows.set(identifier, row);
    return row;
}

/** @type {Counter} */
const ZERO_COUNTER = Object.freeze({ enabled: 0, total: 0 });

/**
 * Adds `b` into `a` and returns a new counter.
 * @param {Counter} a Left.
 * @param {Counter} b Right.
 * @returns {Counter} Sum.
 */
function addCounter(a, b) {
    return { enabled: a.enabled + b.enabled, total: a.total + b.total };
}

/**
 * A row's own contribution to its parent's counter.
 * @param {RowView|null} row Row.
 * @returns {Counter} 0/0 for no row.
 */
function rowCounter(row) {
    if (!row) return ZERO_COUNTER;
    return { enabled: row.enabled ? 1 : 0, total: 1 };
}

/**
 * Walks a node list, building views and the counter the PARENT should add.
 * @param {SectionNode[]|undefined} nodes Tree nodes.
 * @param {BuildContext} ctx Build context.
 * @returns {{views: NodeView[], counter: Counter}} Views plus their combined subtree counter.
 */
function walkNodes(nodes, ctx) {
    /** @type {NodeView[]} */
    const views = [];
    let counter = ZERO_COUNTER;
    for (const node of Array.isArray(nodes) ? nodes : []) {
        if (!isPlainObject(node)) continue;
        const identifier = typeof node.identifier === 'string' ? node.identifier : '';
        const row = identifier ? buildRow(identifier, node.label ?? '', node.sigil ?? '', ctx, node.kind === 'option') : null;
        const isContainer = node.kind === 'group' || node.kind === 'span';
        const inner = isContainer ? walkNodes(node.children, ctx) : { views: [], counter: ZERO_COUNTER };
        const closeIdentifier = node.kind === 'span' && typeof node.closeIdentifier === 'string'
            ? node.closeIdentifier
            : '';
        const closeRow = closeIdentifier ? buildRow(closeIdentifier, node.label ?? '', node.sigil ?? '', ctx) : null;
        // "What is inside me": children plus, for a span, its closing boundary row. The node's
        // OWN row is counted by the parent, one line below.
        const own = addCounter(inner.counter, rowCounter(closeRow));
        /** @type {NodeView} */
        const view = {
            kind: node.kind === 'group' || node.kind === 'span' || node.kind === 'option' ? node.kind : 'leaf',
            id: String(node.id ?? identifier),
            key: identifier || String(node.id ?? ''),
            label: node.label ?? '',
            depth: Number.isFinite(node.depth) ? Number(node.depth) : 0,
            exclusive: node.exclusive === true,
            row,
            closeRow,
            children: inner.views,
            counter: own,
        };
        views.push(view);
        counter = addCounter(counter, addCounter(own, rowCounter(row)));
    }
    return { views, counter };
}

/**
 * Builds the whole render model from a derived tree plus LIVE preset state.
 *
 * Cheap enough to re-run on every toggle (one pass over ~93 rows), which is what lets the
 * component patch the DOM instead of rebuilding it: same model shape in, same Lit template
 * parts out, only the changed bindings written.
 * @param {object} input Input.
 * @param {SectionTree} input.tree Slice A's derived tree.
 * @param {unknown} [input.prompts] The preset's `prompts[]`.
 * @param {unknown} [input.promptOrder] The LIVE resolved `100001` order array.
 * @param {Record<string, unknown>|null} [input.counts] `tokenHandler.counts` (NOT sparse — see
 *   the module header; it needs `contributed` alongside it to mean anything).
 * @param {Iterable<string>|null} [input.contributed] Identifiers the last assembly produced a
 *   collection for, from `promptManager.messages`. Absent = no assembly = no badges.
 * @param {unknown} [input.overridden] `promptManager.overriddenPrompts`.
 * @param {Record<string, string>|null} [input.promptSources] `promptManager.promptSources`.
 * @param {BudgetInput|null} [input.budget] Budget inputs for the history warning.
 * @returns {ListModel} The render model.
 */
export function buildListModel({
    tree,
    prompts,
    promptOrder,
    counts = null,
    contributed = null,
    overridden = null,
    promptSources = null,
    budget = null,
} = /** @type {any} */ ({})) {
    /** @type {BuildContext} */
    const ctx = {
        prompts: indexPrompts(prompts),
        enabled: indexOrder(promptOrder),
        counts: isPlainObject(counts) ? /** @type {Record<string, unknown>} */ (counts) : {},
        contributed: contributed === null || contributed === undefined ? null : new Set(contributed),
        overridden: new Set(Array.isArray(overridden) ? overridden.filter(id => typeof id === 'string') : []),
        sources: isPlainObject(promptSources) ? /** @type {Record<string, string>} */ (promptSources) : {},
        budget: isPlainObject(budget) ? /** @type {BudgetInput} */ (budget) : null,
        rows: new Map(),
    };

    const safeTree = isPlainObject(tree) ? tree : /** @type {SectionTree} */ ({});
    /** @type {SectionView[]} */
    const sections = [];
    let totals = ZERO_COUNTER;
    for (const section of Array.isArray(safeTree.sections) ? safeTree.sections : []) {
        if (!isPlainObject(section)) continue;
        const identifier = typeof section.identifier === 'string' ? section.identifier : '';
        const row = identifier ? buildRow(identifier, section.label ?? '', section.sigil ?? '', ctx) : null;
        const inner = walkNodes(section.children, ctx);
        sections.push({
            id: String(section.id ?? ''),
            key: identifier || String(section.id ?? ''),
            label: section.label ?? '',
            kind: section.kind === 'banner' ? 'banner' : 'flat',
            exclusive: section.exclusive === true,
            collapsedDefault: section.collapsedDefault === true,
            row,
            children: inner.views,
            counter: inner.counter,
        });
        totals = addCounter(totals, addCounter(inner.counter, rowCounter(row)));
    }

    // The shelf. These have no order entry at all, so they are never `enabled` and never carry
    // a token badge — the model reports them, it does not invent an order entry for them
    // (slice A: "the model never invents an order entry").
    /** @type {RowView[]} */
    const unlisted = [];
    for (const identifier of Array.isArray(safeTree.unlisted) ? safeTree.unlisted : []) {
        if (typeof identifier !== 'string' || !identifier) continue;
        const prompt = ctx.prompts.get(identifier) ?? null;
        const name = prompt && typeof prompt.name === 'string' ? prompt.name : '';
        unlisted.push(buildRow(identifier, name, '', ctx));
    }

    return {
        tier: safeTree.tier === 'override' || safeTree.tier === 'sigil' || safeTree.tier === 'legacy'
            ? safeTree.tier
            : 'flat',
        sections,
        unlisted,
        unknownOrder: Array.isArray(safeTree.unknownOrder) ? safeTree.unknownOrder.slice() : [],
        duplicateOrder: Array.isArray(safeTree.duplicateOrder) ? safeTree.duplicateOrder.slice() : [],
        rowsByIdentifier: ctx.rows,
        totals,
    };
}

/**
 * Splits a query into fragment-AND terms: whitespace-separated, all required, order-independent,
 * case-insensitive. Same contract as the branch map's `compileQuery`, widened to prompt content.
 * @param {string} query Raw input value.
 * @returns {string[]} Lowercased terms.
 */
export function compilePromptQuery(query) {
    const text = String(query ?? '').trim().toLowerCase();
    return text ? text.split(/\s+/) : [];
}

/**
 * True when every term appears in the haystack.
 * @param {string} haystack Lowercased corpus.
 * @param {string[]} terms Compiled terms.
 * @returns {boolean} Whether the row matches.
 */
export function matchesTerms(haystack, terms) {
    for (const term of terms) {
        if (!haystack.includes(term)) return false;
    }
    return true;
}

/**
 * Runs a compiled query over a model.
 *
 * Single pass over the sections, bottom-up, so a container is force-expanded exactly when one
 * of its descendants matched — no ancestor walk per hit, no observers, no timers. Rows on the
 * unlisted shelf participate: a search that finds nothing in the order but something on the
 * shelf must say so.
 * @param {ListModel} model The render model.
 * @param {string[]} terms Compiled terms.
 * @returns {SearchResult} Matches, forced expansions, honest counts.
 */
export function searchModel(model, terms) {
    if (!Array.isArray(terms) || terms.length === 0) {
        return NO_PROMPT_SEARCH;
    }
    /** @type {Set<string>} */
    const matches = new Set();
    /** @type {Set<string>} */
    const expand = new Set();
    let scanned = 0;

    /**
     * @param {RowView|null} row Row to test.
     * @returns {boolean} Whether it matched.
     */
    const test = (row) => {
        if (!row) return false;
        scanned++;
        if (!matchesTerms(row.haystack, terms)) return false;
        matches.add(row.identifier);
        return true;
    };

    /**
     * @param {NodeView[]} nodes Nodes to walk.
     * @returns {boolean} Whether anything in this list matched.
     */
    const walk = (nodes) => {
        let hit = false;
        for (const node of nodes) {
            // Every branch is evaluated: `||` would short-circuit and leave later siblings
            // unscanned, which is how a "working" search quietly stops finding things.
            const self = test(node.row);
            const close = test(node.closeRow);
            const inner = walk(node.children);
            if (inner || close) expand.add(node.key);
            if (self || close || inner) hit = true;
        }
        return hit;
    };

    for (const section of model.sections) {
        const self = test(section.row);
        const inner = walk(section.children);
        if (self || inner) expand.add(section.key);
    }
    for (const row of model.unlisted) test(row);

    return { active: true, terms: terms.slice(), matches, expand, count: matches.size, scanned };
}

/**
 * Splits text into alternating plain / matched segments so the component can wrap hits in
 * `<mark>` without ever assembling HTML from user data.
 *
 * Longest term first, so `pick` inside `pick one` cannot cut the longer match into pieces.
 * @param {string} text Text to light up.
 * @param {string[]} terms Compiled (lowercased) terms.
 * @returns {Array<{text: string, hit: boolean}>} Segments in order.
 */
export function highlightSegments(text, terms) {
    const source = String(text ?? '');
    if (!source || !Array.isArray(terms) || terms.length === 0) {
        return source ? [{ text: source, hit: false }] : [];
    }
    const needles = terms.filter(term => typeof term === 'string' && term.length > 0)
        .slice()
        .sort((a, b) => b.length - a.length);
    if (needles.length === 0) return [{ text: source, hit: false }];

    const lower = source.toLowerCase();
    /** @type {Array<{text: string, hit: boolean}>} */
    const out = [];
    let cursor = 0;
    let plainFrom = 0;
    while (cursor < source.length) {
        let width = 0;
        for (const needle of needles) {
            if (lower.startsWith(needle, cursor)) {
                width = needle.length;
                break;
            }
        }
        if (width === 0) {
            cursor++;
            continue;
        }
        if (cursor > plainFrom) out.push({ text: source.slice(plainFrom, cursor), hit: false });
        out.push({ text: source.slice(cursor, cursor + width), hit: true });
        cursor += width;
        plainFrom = cursor;
    }
    if (plainFrom < source.length) out.push({ text: source.slice(plainFrom), hit: false });
    return out;
}

/**
 * Percentage a `(n/m)` counter fills, clamped and rounded — the section header's thin progress
 * bar. An empty container reads as 0, never as NaN.
 * @param {Counter} counter Counter.
 * @returns {number} 0-100.
 */
export function counterPercent(counter) {
    if (!isPlainObject(counter)) return 0;
    const total = Number(counter.total);
    const enabled = Number(counter.enabled);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(enabled)) return 0;
    return Math.max(0, Math.min(100, Math.round((enabled / total) * 100)));
}

/**
 * The header chip for the regex scripts a preset carries (issue #6).
 *
 * A preset can embed regex scripts that stay inert until its owner allows them, and nothing on
 * the preset's own surface said so: declining core's one-time prompt left a half-working preset
 * with no sign of why and no way back short of knowing where the switch is. The chip is that
 * sign and that way back. No badge without a number: a preset with no scripts gets no chip.
 *
 * @typedef {object} RegexChip
 * @property {string} label The chip's text.
 * @property {'on'|'off'} state Whether the scripts are allowed to run.
 * @property {string} title The tooltip: what is there, whether it runs, what a click does.
 *
 * @param {{ total?: number, prompt?: number }} counts `total` scripts in the preset, of which
 *     `prompt` change what is sent to the model.
 * @param {boolean} allowed Whether this preset's scripts are allowed.
 * @returns {RegexChip|null} The chip, or null when the preset carries no scripts.
 */
export function regexChip(counts, allowed) {
    const total = Number(counts?.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    const prompt = Math.max(0, Number(counts?.prompt) || 0);
    const noun = total === 1 ? 'regex script' : 'regex scripts';
    const reach = prompt > 0 ? ` ${prompt} of them change${prompt === 1 ? 's' : ''} what is sent to the model.` : '';
    if (!allowed) {
        return {
            label: `regex ${total} off`,
            state: 'off',
            title: `This preset carries ${total} ${noun}, and they are off.${reach} Click to see them and decide.`,
        };
    }
    return {
        label: `regex ${total}`,
        state: 'on',
        title: `This preset's ${total} ${noun} ${total === 1 ? 'is' : 'are'} allowed.${reach} Click to manage them in the Regex settings.`,
    };
}
