/**
 * Branch-map forest, fixed-row layout, connector geometry and search.
 * Builds render data without touching the document or mutating the store tree.
 */

import { timestampToMoment } from '../../scripts/utils.js';

/** Corner radius of the SVG elbow joining a parent row to a child row. */
const ELBOW_RADIUS = 6;

/**
 * Half the twist/leaf marker's box (`.k-bm-twist` is 16px square). `--k-bm-stem`
 * is the x of a depth-0 marker's CENTRE, so a row's content starts one half-box
 * to the left of it and every connector can spring from a real marker instead of
 * from a gutter rail.
 */
export const MARKER_HALF = 8;

/** Gap between the end of a connector and the child row's marker box. */
const CONNECTOR_GAP = 4;

/**
 * A node of the rendered forest. Built from the store's frozen tree; every
 * field here belongs to us, so sorting and annotating never touches the shared
 * payload (`tree`, `tree.files` and `tree.edges` are all frozen — a mutation
 * would throw in strict mode, which module code always is).
 * @typedef {object} ForestNode
 * @property {string} id Extension-less chat id. Doubles as the display title.
 * @property {import('./store.js').BranchTreeFile} file The sidecar record.
 * @property {ForestNode|null} parent Resolved parent, or null for a root.
 * @property {ForestNode[]} children Sorted by subtree recency.
 * @property {number} depth 0 for roots.
 * @property {number|null} forkIndex First-divergence index on the parent edge.
 * @property {{ parent: string, child: string }|null} forkPreview What each side said at the
 *   fork, when the server has computed it (absent on sidecars it has not refreshed yet).
 * @property {'header'|'adopted'|null} via How the parent link was established.
 * @property {string|null} orphanName Ghost parent name, when the link dangles.
 * @property {number} lastMs This chat's own last activity, epoch ms, 0 = unknown.
 * @property {number} subtreeLastMs Newest `lastMs` in this node's subtree.
 * @property {string} haystack Lowercased search corpus for this node.
 */

/**
 * @typedef {object} Forest
 * @property {ForestNode[]} roots Sorted by subtree recency, newest first.
 * @property {Map<string, ForestNode>} byId Every node, keyed by chat id.
 * @property {ForestNode[]} order Pre-order walk of the sorted forest.
 */

/**
 * One rendered row inside a root section.
 * @typedef {object} MapRow
 * @property {ForestNode} node The chat this row shows.
 * @property {number} depth Depth relative to the section's root.
 * @property {number} index Row index inside the section (rows are fixed height).
 * @property {number} parentIndex Row index of the parent, or -1 for the root row.
 * @property {boolean} expandable Whether the node has children at all.
 * @property {boolean} expanded Whether those children are currently shown.
 */

/**
 * @typedef {object} MapSection
 * @property {ForestNode} root
 * @property {MapRow[]} rows
 * @property {number} top Pixel offset of the section inside the scroll canvas.
 * @property {number} height Pixel height including the trailing gap.
 * @property {number} maxDepth Deepest visible row, for the connector SVG's width.
 * @property {Array<{d: string, adopted: boolean}>|null} paths Lazily filled by
 *   the renderer, so a section that never enters the viewport never pays.
 */

/**
 * @typedef {object} MapLayout
 * @property {MapSection[]} sections
 * @property {number} total Canvas height in pixels.
 * @property {Map<string, [number, number]>} rowIndex id → [section, row].
 * @property {string[]} visibleOrder Every visible row id, top to bottom.
 */

/**
 * @typedef {object} MapGeometry
 * @property {number} rowHeight
 * @property {number} sectionGap
 * @property {number} indent
 * @property {number} stem
 */

/**
 * @typedef {object} SearchResult
 * @property {boolean} active Whether a query is in force.
 * @property {Set<string>} matches Ids that satisfy every term.
 * @property {Set<string>} expand Ancestors of matches, to be force-expanded.
 * @property {string|null} first First match in visible order.
 */

/** An inactive search — shared, so an empty query allocates nothing. */
export const NO_SEARCH = Object.freeze({
    active: false,
    matches: new Set(),
    expand: new Set(),
    first: null,
});

/** One formatter for the whole session; `toLocaleDateString` per row is not free. */
const dateFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
});

/**
 * Epoch ms for a sidecar `lastMessageAt`.
 *
 * The schema says "ISO where parseable", so `Date.parse` answers the common
 * case in nanoseconds. Only a value it rejects — an ST "humanized" `send_date`
 * that survived into the field — pays for core's moment-based parser, the same
 * one `k-rail-left` uses on `last_mes`.
 * @param {unknown} value Raw `lastMessageAt`.
 * @returns {number} Epoch ms, or 0 when there is nothing parseable.
 */
export function toEpochMs(value) {
    if (typeof value !== 'string' || value === '') {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }
    const direct = Date.parse(value);
    if (Number.isFinite(direct)) {
        return direct;
    }
    try {
        const moment = timestampToMoment(value);
        return moment && moment.isValid() ? moment.valueOf() : 0;
    } catch {
        return 0;
    }
}

/**
 * `YYYY-MM-DD` in local time. Part of the search corpus so a user can type
 * `2026-08` and get that month, which the localized form cannot serve.
 * @param {number} ms Epoch milliseconds.
 * @returns {string} ISO day, or ''.
 */
export function toIsoDay(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '';
    }
    const date = new Date(ms);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The searchable text for one chat: title, leaf preview, checkpoint names and
 * both date spellings. Built once per node at forest time — a search keystroke
 * must never allocate per row (the Timelines cache-thrash lesson).
 * @param {string} id Chat id, which is also the display title.
 * @param {import('./store.js').BranchTreeFile} file Sidecar record.
 * @param {number} lastMs Parsed last-activity timestamp.
 * @returns {string} Lowercased corpus.
 */
function haystackFor(id, file, lastMs) {
    let text = id;
    const preview = file?.leafPreview;
    if (typeof preview === 'string' && preview) {
        text += ` ${preview}`;
    }
    const checkpoints = file?.checkpoints;
    if (Array.isArray(checkpoints)) {
        for (const checkpoint of checkpoints) {
            if (checkpoint && typeof checkpoint.name === 'string' && checkpoint.name) {
                text += ` ${checkpoint.name}`;
            }
        }
    }
    if (lastMs > 0) {
        text += ` ${toIsoDay(lastMs)} ${dateFormatter.format(new Date(lastMs))}`;
    }
    return text.toLowerCase();
}

/**
 * Sibling order: newest subtree first, ties broken by id so the forest is
 * stable across rebuilds (a chat with no parseable date must not shuffle).
 * @param {ForestNode} a
 * @param {ForestNode} b
 * @returns {number}
 */
function compareNodes(a, b) {
    if (b.subtreeLastMs !== a.subtreeLastMs) {
        return b.subtreeLastMs - a.subtreeLastMs;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Builds the render forest from a store tree.
 *
 * O(files + edges). The tree object is frozen and shared with every other
 * consumer, so nothing here writes to it: the sort happens on arrays this
 * function allocated.
 *
 * Edge resolution mirrors `store.js#parentMapFor` so the map and the rail agree
 * on ancestry: a parent link counts only when the parent is a file the tree
 * actually knows, is not the child itself, and is the first such edge for that
 * child. An unresolved edge contributes `orphanName` instead — a lineage
 * terminator, not a hop (doc decision 5).
 *
 * A cycle is only reachable through a corrupt sidecar, but it would make its
 * members unrenderable (every node in a cycle has a parent, so none is a root).
 * The colouring pass below cuts the back-edge and the node becomes a root.
 * @param {import('./store.js').BranchTree|null|undefined} tree Store payload.
 * @returns {Forest} Roots, index and pre-order walk.
 */
export function buildForest(tree) {
    /** @type {Map<string, ForestNode>} */
    const byId = new Map();
    const files = tree && tree.files && typeof tree.files === 'object' ? tree.files : {};
    for (const id of Object.keys(files)) {
        const file = files[id];
        const lastMs = toEpochMs(file?.lastMessageAt);
        byId.set(id, {
            id,
            file,
            parent: null,
            children: [],
            depth: 0,
            forkIndex: null,
            forkPreview: null,
            via: null,
            orphanName: null,
            lastMs,
            subtreeLastMs: lastMs,
            haystack: haystackFor(id, file, lastMs),
        });
    }

    const edges = tree && Array.isArray(tree.edges) ? tree.edges : [];
    for (const edge of edges) {
        const child = byId.get(typeof edge?.child === 'string' ? edge.child : '');
        if (!child || child.parent) {
            continue;
        }
        const parentId = typeof edge.parent === 'string' ? edge.parent : '';
        const parent = parentId && parentId !== child.id ? byId.get(parentId) : undefined;
        if (parent) {
            child.parent = parent;
            child.via = edge.via === 'adopted' ? 'adopted' : 'header';
            child.forkIndex = Number.isInteger(edge.forkIndex) ? Number(edge.forkIndex) : null;
            const preview = edge.forkPreview;
            if (preview && typeof preview.parent === 'string' && typeof preview.child === 'string') {
                child.forkPreview = { parent: preview.parent, child: preview.child };
                // The line where the story split is the most searchable thing a branch has.
                if (preview.child) {
                    child.haystack += ` ${preview.child.toLowerCase()}`;
                }
            }
            child.orphanName = null;
            continue;
        }
        if (child.orphanName === null && typeof edge.orphanName === 'string' && edge.orphanName) {
            child.orphanName = edge.orphanName;
        }
    }

    // Cycle cut, before children are attached so a severed link leaves no
    // dangling entry in a parent's array. 0 = unseen, 1 = on the current walk,
    // 2 = settled.
    /** @type {Map<ForestNode, number>} */
    const state = new Map();
    for (const start of byId.values()) {
        if (state.get(start) === 2) {
            continue;
        }
        /** @type {ForestNode[]} */
        const path = [];
        /** @type {ForestNode|null} */
        let cursor = start;
        while (cursor && state.get(cursor) !== 2) {
            if (state.get(cursor) === 1) {
                cursor.parent = null;
                break;
            }
            state.set(cursor, 1);
            path.push(cursor);
            cursor = cursor.parent;
        }
        for (const node of path) {
            state.set(node, 2);
        }
    }

    /** @type {ForestNode[]} */
    const roots = [];
    for (const node of byId.values()) {
        if (node.parent) {
            node.parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    // Subtree recency, bottom-up over an iterative post-order. Every node is
    // reachable from some root now, so this visits each exactly once.
    /** @type {ForestNode[]} */
    const post = [];
    /** @type {ForestNode[]} */
    const stack = roots.slice();
    while (stack.length > 0) {
        const node = /** @type {ForestNode} */ (stack.pop());
        post.push(node);
        for (const child of node.children) {
            stack.push(child);
        }
    }
    for (let i = post.length - 1; i >= 0; i--) {
        const node = post[i];
        let newest = node.lastMs;
        for (const child of node.children) {
            if (child.subtreeLastMs > newest) {
                newest = child.subtreeLastMs;
            }
        }
        node.subtreeLastMs = newest;
    }

    for (const node of byId.values()) {
        if (node.children.length > 1) {
            node.children.sort(compareNodes);
        }
    }
    roots.sort(compareNodes);

    /** @type {ForestNode[]} */
    const order = [];
    /** @type {ForestNode[]} */
    const walk = [];
    for (let i = roots.length - 1; i >= 0; i--) {
        walk.push(roots[i]);
    }
    while (walk.length > 0) {
        const node = /** @type {ForestNode} */ (walk.pop());
        node.depth = node.parent ? node.parent.depth + 1 : 0;
        order.push(node);
        for (let i = node.children.length - 1; i >= 0; i--) {
            walk.push(node.children[i]);
        }
    }

    return { roots, byId, order };
}

/**
 * Flattens one root section into fixed-height rows, honouring the expansion set.
 * @param {ForestNode} root Section root.
 * @param {Set<string>} expanded Ids whose children are shown.
 * @returns {MapRow[]} Rows in visual order.
 */
export function flattenSection(root, expanded) {
    /** @type {MapRow[]} */
    const rows = [];
    /** @type {Array<{node: ForestNode, parentIndex: number}>} */
    const stack = [{ node: root, parentIndex: -1 }];
    while (stack.length > 0) {
        const { node, parentIndex } = /** @type {{node: ForestNode, parentIndex: number}} */ (stack.pop());
        const index = rows.length;
        const expandable = node.children.length > 0;
        const open = expandable && expanded.has(node.id);
        rows.push({
            node,
            depth: node.depth - root.depth,
            index,
            parentIndex,
            expandable,
            expanded: open,
        });
        if (!open) {
            continue;
        }
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ node: node.children[i], parentIndex: index });
        }
    }
    return rows;
}

/**
 * The whole scroll canvas: one section per root, exact pixel offsets, plus the
 * two indexes the keyboard and the scroller need.
 *
 * Laying every section out (rather than only the visible ones) is what makes
 * the virtualization exact: fixed-height rows plus a real row count per section
 * means `top` is measured, not guessed, so `scrollTop` never has to be corrected
 * after a paint. It costs one pass over the visible rows — at most 802 of them.
 * @param {ForestNode[]} roots Sorted roots.
 * @param {Set<string>} expanded Effective expansion set.
 * @param {MapGeometry} geometry Row metrics read from CSS.
 * @returns {MapLayout} Sections and indexes.
 */
export function buildSections(roots, expanded, geometry) {
    /** @type {MapSection[]} */
    const sections = [];
    /** @type {Map<string, [number, number]>} */
    const rowIndex = new Map();
    /** @type {string[]} */
    const visibleOrder = [];
    let top = 0;
    for (let s = 0; s < roots.length; s++) {
        const rows = flattenSection(roots[s], expanded);
        let maxDepth = 0;
        for (let r = 0; r < rows.length; r++) {
            rowIndex.set(rows[r].node.id, [s, r]);
            visibleOrder.push(rows[r].node.id);
            if (rows[r].depth > maxDepth) {
                maxDepth = rows[r].depth;
            }
        }
        const height = rows.length * geometry.rowHeight + geometry.sectionGap;
        sections.push({ root: roots[s], rows, top, height, maxDepth, paths: null });
        top += height;
    }
    return { sections, total: top, rowIndex, visibleOrder };
}

/**
 * SVG elbows from each parent row down to each child row, in section-local
 * coordinates. One path per non-root row; computed only for sections that are
 * actually rendered, and cached on the section for the life of the layout.
 * @param {MapRow[]} rows Section rows.
 * @param {MapGeometry} geometry Row metrics.
 * @returns {Array<{d: string, adopted: boolean}>} Path data plus the dotted flag.
 */
export function sectionPaths(rows, geometry) {
    const { rowHeight, indent, stem } = geometry;
    const half = rowHeight / 2;
    /** @type {Array<{d: string, adopted: boolean}>} */
    const paths = [];
    for (const row of rows) {
        if (row.parentIndex < 0) {
            continue;
        }
        // Down from the parent marker's centre, then right to the child's box.
        const x = stem + (row.depth - 1) * indent;
        const yTop = row.parentIndex * rowHeight + half;
        const yBottom = row.index * rowHeight + half;
        const xEnd = stem + row.depth * indent - MARKER_HALF - CONNECTOR_GAP;
        const radius = Math.min(ELBOW_RADIUS, (yBottom - yTop) / 2, Math.max(xEnd - x, 0));
        const d = radius > 0
            ? `M${x} ${yTop}V${yBottom - radius}Q${x} ${yBottom} ${x + radius} ${yBottom}H${xEnd}`
            : `M${x} ${yTop}V${yBottom}H${xEnd}`;
        paths.push({ d, adopted: row.node.via === 'adopted' });
    }
    return paths;
}

/**
 * Splits a query into fragment-AND terms: whitespace-separated, all required,
 * order-independent, case-insensitive (Timelines' one good idea, widened past
 * message text per the doc).
 * @param {string} query Raw input value.
 * @returns {string[]} Lowercased terms.
 */
export function compileQuery(query) {
    const text = String(query ?? '').trim().toLowerCase();
    return text ? text.split(/\s+/) : [];
}

/**
 * Runs the compiled query over the forest.
 *
 * Single pass in pre-order, so `first` is the first match a reader would *see*
 * rather than the first one a map iteration happens to reach. Ancestors of a
 * match are collected for forced expansion; the walk up stops as soon as it
 * hits an ancestor already collected, which keeps the whole thing linear.
 * @param {Forest} forest The built forest.
 * @param {string[]} terms Compiled terms.
 * @returns {SearchResult} Matches, forced expansions, first hit.
 */
export function searchForest(forest, terms) {
    if (terms.length === 0) {
        return /** @type {SearchResult} */ (NO_SEARCH);
    }
    /** @type {Set<string>} */
    const matches = new Set();
    /** @type {Set<string>} */
    const expand = new Set();
    /** @type {string|null} */
    let first = null;
    for (const node of forest.order) {
        let hit = true;
        for (const term of terms) {
            if (!node.haystack.includes(term)) {
                hit = false;
                break;
            }
        }
        if (!hit) {
            continue;
        }
        matches.add(node.id);
        if (first === null) {
            first = node.id;
        }
        for (let ancestor = node.parent; ancestor && !expand.has(ancestor.id); ancestor = ancestor.parent) {
            expand.add(ancestor.id);
        }
    }
    return { active: true, matches, expand, first };
}

/**
 * Index of the first section whose bottom edge is past `y`. Binary search, so a
 * scroll event is O(log roots) instead of a walk over 535 sections.
 * @param {MapSection[]} sections Laid-out sections.
 * @param {number} y Pixel offset in the canvas.
 * @returns {number} Section index, `sections.length` when past the end.
 */
export function firstSectionAt(sections, y) {
    let low = 0;
    let high = sections.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (sections[mid].top + sections[mid].height > y) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return low;
}
