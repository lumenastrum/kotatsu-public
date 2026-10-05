/**
 * Story lines — the branch map's transit-map view (exploration, 2026-10-04).
 *
 * One story = one root chat and every branch under it. The x axis is the
 * message index, so a branch leaves its parent's line exactly at its fork point
 * and runs as far as it has been written; each chat gets its own row. Pure and
 * DOM-free like `map-model.js`, so the geometry is pinned by Jest instead of
 * eyeballed.
 *
 * The layout is four passes, each one a collision rule:
 *   1. rows and anchors — a fork inside inherited messages leaves from the
 *      ancestor whose line owns that message;
 *   2. lanes — every branch drops down a vertical trunk; a trunk that would run
 *      alongside another (vertical overlap, closer than `trunkGap`) moves right,
 *      while siblings leaving one line at one message share a single trunk;
 *   3. pills — the fork quote sits in the widest free gap between the trunks
 *      crossing its band, or moves into the station card when no gap fits;
 *   4. stations — each end-of-line card nudges a little up or down to clear
 *      pills, lines, trunks and the cards already placed.
 *
 * Honest-data rules carry over from the list view: an unknown fork point is
 * drawn as such (dashed, from the parent's first message), never guessed; a
 * branch nobody continued yet gets a short stub and says so.
 */

/** @typedef {import('./map-model.js').ForestNode} ForestNode */

/** How many line colours the sheet defines (`is-hue-0` … `is-hue-5`). */
export const STORY_HUES = 6;

/**
 * Layout metrics, px at zoom 1. `stationW` is the room kept to the right of the
 * furthest message for the end-of-line cards; `stationCardW`/`stationH` are the
 * card box the collision pass reasons about (the sheet's `.k-bm-station`).
 */
export const STORY_GEOMETRY = Object.freeze({
    padStart: 32,
    stationW: 300,
    stationGap: 18,
    stationCardW: 270,
    stationH: 104,
    rowH: 116,
    // Clears the message axis: the first row's station card is centred on this.
    top: 104,
    // Corner radius of the transit elbows.
    radius: 14,
    // Closest two unrelated trunks may run side by side.
    trunkGap: 12,
    stub: 28,
    minSpan: 120,
    // The pill band under a line, relative to the line's y.
    chipTop: 11,
    chipH: 26,
    // Clearance kept between a pill and a trunk crossing its band.
    chipClear: 9,
    chipMin: 150,
    chipMax: 380,
    // How many rows make a map dense enough for the rulers to step back.
    denseRows: 9,
});

/** Vertical nudges a station may take, in order of preference. */
const STATION_NUDGES = [0, -12, 12, -24, 24];

/**
 * @typedef {object} StoryCheckpoint
 * @property {number} x
 * @property {number} mesIndex
 * @property {string} name
 */

/**
 * @typedef {object} StoryLine
 * @property {ForestNode} node The chat this line draws.
 * @property {number} row Row index, 0 = the story's root.
 * @property {number} hue Colour slot, 0 … STORY_HUES - 1.
 * @property {number} y The line's own row.
 * @property {number|null} parentY The row the line leaves from, or null for the root.
 * @property {number} x0 Where the line starts: the fork point on the parent, or message 0.
 * @property {number|null} trunkX The vertical trunk's x, or null for the root.
 * @property {number} xBend Where the line reaches its own row (x0 for the root).
 * @property {number} x1 Where the line ends.
 * @property {string} d SVG path.
 * @property {boolean} unknownFork The fork index was never computed.
 * @property {boolean} uncontinued Nothing was written after the fork yet.
 * @property {StoryCheckpoint[]} checkpoints Checkpoints on this line's own stretch.
 * @property {{ x: number, w: number }|null} chip The fork pill's slot, or null when the quote rides the station.
 * @property {number} stationX Left edge of the station card.
 * @property {number} stationY Vertical centre of the station card (y plus any nudge).
 * @property {boolean} leader The card slid right to clear a trunk; a leader joins it to the end dot.
 */

/**
 * @typedef {object} StoryTrunk
 * @property {number} x
 * @property {number} top
 * @property {number} bottom
 * @property {string} key `anchor id + fork index`: equal keys share the trunk.
 */

/**
 * @typedef {object} StoryLayout
 * @property {StoryLine[]} lines Pre-order; `lines[0]` is the root.
 * @property {StoryTrunk[]} trunks Every trunk, after lane allocation.
 * @property {number} width
 * @property {number} extent Width actually used: `width`, or more when a card slid past a trunk.
 * @property {number} height
 * @property {number} maxMessages
 * @property {boolean} dense Enough rows that the rulers should step back.
 * @property {{ x: number, label: string }[]} ticks Message-index gridlines.
 */

/** @type {StoryLayout} */
export const EMPTY_STORY = Object.freeze({ lines: [], trunks: [], width: 0, extent: 0, height: 0, maxMessages: 0, dense: false, ticks: [] });

/**
 * @param {ForestNode} root Story root.
 * @returns {ForestNode[]} The root and its subtree, pre-order (children keep the forest's recency sort).
 */
export function storyOrder(root) {
    /** @type {ForestNode[]} */
    const out = [];
    /** @type {ForestNode[]} */
    const stack = [root];
    while (stack.length > 0) {
        const node = /** @type {ForestNode} */ (stack.pop());
        out.push(node);
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]);
        }
    }
    return out;
}

/**
 * Gridline step giving roughly five ticks.
 * @param {number} max Longest chat, in messages.
 * @returns {number}
 */
export function niceStep(max) {
    const target = max / 5;
    const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000];
    return steps.find(step => step >= target) ?? steps[steps.length - 1];
}

/**
 * The pill's natural width: padding and border, the `#N` label, and the quote
 * (the renderer clips quotes to 64 characters). An estimate on purpose — the
 * renderer caps the pill at the slot width, so a long guess only ever ellipsizes.
 * @param {string} text The child's line at the fork ('' = not continued yet).
 * @param {number|null} fork Fork index.
 * @returns {number}
 */
export function chipWidth(text, fork) {
    const label = 10 + 7 * String(fork ?? 0).length;
    const body = text ? Math.min(text.length, 64) * 6.6 + 14 : 104;
    return Math.min(STORY_GEOMETRY.chipMax, Math.ceil(28 + label + body));
}

/**
 * @param {ForestNode} node
 * @returns {number} Message count, 0 when unknown.
 */
function messagesOf(node) {
    const count = node.file?.messageCount;
    return Number.isFinite(count) && count > 0 ? Number(count) : 0;
}

/**
 * @typedef {{ x0: number, x1: number, y0: number, y1: number }} Box
 */

/** @param {Box} a @param {Box} b @returns {boolean} */
function overlaps(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Lays one story out as transit lines.
 * @param {ForestNode|null|undefined} root Story root (any node works; it is treated as the top).
 * @param {number} width Drawable width in px.
 * @param {typeof STORY_GEOMETRY} [geometry]
 * @returns {StoryLayout}
 */
export function layoutStory(root, width, geometry = STORY_GEOMETRY) {
    if (!root) {
        return EMPTY_STORY;
    }
    const nodes = storyOrder(root);
    const maxMessages = Math.max(1, ...nodes.map(messagesOf));
    const span = Math.max(geometry.minSpan, width - geometry.padStart - geometry.stationW);
    /** @param {number} index @returns {number} */
    const xOf = index => geometry.padStart + (Math.min(Math.max(index, 0), maxMessages) / maxMessages) * span;
    const r = geometry.radius;

    // 1 — rows and anchors.
    /** @type {Map<string, number>} */
    const rowOf = new Map();
    const draft = nodes.map((node, row) => {
        rowOf.set(node.id, row);
        const y = geometry.top + row * geometry.rowH;
        const parentRow = node !== root && node.parent ? rowOf.get(node.parent.id) : undefined;
        if (parentRow === undefined) {
            return { node, row, y, fork: 0, unknownFork: false, parentY: /** @type {number|null} */ (null), anchorId: '' };
        }
        const unknownFork = node.forkIndex === null;
        const fork = unknownFork ? 0 : /** @type {number} */ (node.forkIndex);
        // A branch that shares only messages its parent inherited — it forks at or
        // before the parent's own split — leaves from the ancestor whose line owns them.
        let anchor = /** @type {ForestNode} */ (node.parent);
        while (anchor !== root && anchor.parent && anchor.forkIndex !== null && fork <= anchor.forkIndex && rowOf.has(anchor.parent.id)) {
            anchor = anchor.parent;
        }
        const parentY = geometry.top + /** @type {number} */ (rowOf.get(anchor.id)) * geometry.rowH;
        return { node, row, y, fork, unknownFork, parentY, anchorId: anchor.id };
    });

    // 2 — lanes.
    /** @type {StoryTrunk[]} */
    const trunks = [];
    /** @type {StoryLine[]} */
    const lines = draft.map(item => {
        const { node, row, y, fork, unknownFork, parentY } = item;
        const hue = row % STORY_HUES;
        const count = messagesOf(node);
        const marks = Array.isArray(node.file?.checkpoints) ? node.file.checkpoints : [];

        if (parentY === null) {
            const x0 = xOf(0);
            const x1 = Math.max(xOf(count), x0 + geometry.stub);
            return {
                node, row, hue, y, parentY: null, x0, trunkX: null, xBend: x0, x1,
                d: `M${round(x0)} ${y} L${round(x1)} ${y}`,
                unknownFork: false,
                uncontinued: false,
                checkpoints: checkpointsFrom(marks, 0, x0, xOf),
                chip: null, stationX: 0, stationY: y, leader: false,
            };
        }

        const x0 = xOf(fork);
        const key = `${item.anchorId}\u0000${fork}`;
        const shared = trunks.find(trunk => trunk.key === key);
        let trunkX;
        if (shared) {
            trunkX = shared.x;
            shared.bottom = Math.max(shared.bottom, y);
        } else {
            trunkX = x0 + r;
            for (let guard = 0; guard < 1000; guard++) {
                const clash = trunks.filter(trunk => Math.abs(trunk.x - trunkX) < geometry.trunkGap && trunk.top < y && trunk.bottom > parentY);
                if (clash.length === 0) {
                    break;
                }
                trunkX = Math.max(...clash.map(trunk => trunk.x)) + geometry.trunkGap;
            }
            trunks.push({ x: trunkX, top: parentY, bottom: y, key });
        }
        const xBend = trunkX + r;
        const x1 = Math.max(xOf(count), xBend + geometry.stub);
        // A trunk pushed right runs along the parent's row to reach its lane.
        const reach = trunkX - r > x0 + 0.05 ? ` L${round(trunkX - r)} ${parentY}` : '';
        return {
            node, row, hue, y, parentY, x0, trunkX, xBend, x1,
            d: `M${round(x0)} ${parentY}${reach} Q${round(trunkX)} ${parentY} ${round(trunkX)} ${parentY + r}`
                + ` L${round(trunkX)} ${y - r} Q${round(trunkX)} ${y} ${round(xBend)} ${y} L${round(x1)} ${y}`,
            unknownFork,
            uncontinued: count <= fork,
            // A branch file carries a copy of its parent's prefix, bookmarks
            // included; only the stretch after the fork is this line's own.
            checkpoints: checkpointsFrom(marks, fork, xBend, xOf),
            chip: null, stationX: 0, stationY: y, leader: false,
        };
    });

    // 3 — pills.
    for (const line of lines) {
        if (line.parentY === null || line.unknownFork) {
            continue;
        }
        const bandTop = line.y + geometry.chipTop;
        const bandBottom = bandTop + geometry.chipH;
        const start = line.xBend + 10;
        const end = line.x1 + 8;
        const crossing = trunks
            .filter(trunk => trunk.top < bandBottom && trunk.bottom > bandTop
                && trunk.x > start - geometry.chipClear && trunk.x < end + geometry.chipClear)
            .map(trunk => trunk.x)
            .sort((a, b) => a - b);
        /** @type {Array<[number, number]>} */
        const gaps = [];
        let from = start;
        for (const x of crossing) {
            if (x - geometry.chipClear > from) {
                gaps.push([from, x - geometry.chipClear]);
            }
            from = Math.max(from, x + geometry.chipClear);
        }
        if (end > from) {
            gaps.push([from, end]);
        }
        const want = chipWidth(line.node.forkPreview?.child ?? '', line.node.forkIndex);
        let slot = gaps.find(([a, b]) => b - a >= want);
        if (!slot) {
            slot = gaps.reduce((best, gap) => (!best || gap[1] - gap[0] > best[1] - best[0] ? gap : best), /** @type {[number, number]|undefined} */ (undefined));
        }
        if (slot && slot[1] - slot[0] >= geometry.chipMin) {
            line.chip = { x: round(slot[0]), w: Math.floor(Math.min(want, slot[1] - slot[0])) };
        }
    }

    // 4 — stations.
    /** @type {Box[]} */
    const obstacles = [];
    for (const line of lines) {
        if (line.chip) {
            const top = line.y + geometry.chipTop;
            obstacles.push({ x0: line.chip.x, x1: line.chip.x + line.chip.w, y0: top, y1: top + geometry.chipH });
        }
        obstacles.push({ x0: line.xBend, x1: line.x1, y0: line.y - 5, y1: line.y + 5 });
    }
    for (const trunk of trunks) {
        obstacles.push({ x0: trunk.x - 4, x1: trunk.x + 4, y0: trunk.top + r, y1: trunk.bottom - r });
    }
    const half = geometry.stationH / 2;
    let extent = width;
    for (const line of lines) {
        /** @param {number} x @param {number} dy @returns {Box} */
        const boxAt = (x, dy) => ({ x0: x, x1: x + geometry.stationCardW, y0: line.y + dy - half, y1: line.y + dy + half });
        // A small vertical nudge first; when something still blocks every nudge (a long trunk
        // dropping past this row can't be dodged vertically) the card slides right past it.
        // The end dot never moves — it marks the line's true last message — and a leader
        // connects it to the card.
        let x = line.x1 + geometry.stationGap;
        let chosen = 0;
        for (let guard = 0; guard < 400; guard++) {
            const dy = STATION_NUDGES.find(nudge => !obstacles.some(obstacle => overlaps(boxAt(x, nudge), obstacle)));
            if (dy !== undefined) {
                chosen = dy;
                break;
            }
            const blockers = obstacles.filter(obstacle => overlaps(boxAt(x, 0), obstacle));
            x = Math.max(x + 1, ...blockers.map(obstacle => obstacle.x1 + 8));
        }
        line.stationX = round(x);
        line.stationY = line.y + chosen;
        line.leader = x > line.x1 + geometry.stationGap + 0.5;
        obstacles.push(boxAt(x, chosen));
        // Only a card that really runs past the pane widens the canvas; an unmoved card ends
        // inside `width` by construction, so the canvas never overflows by a hair (a phantom
        // horizontal scrollbar is half of a scrollbar feedback loop).
        extent = Math.max(extent, x + geometry.stationCardW + 4);
    }

    const step = niceStep(maxMessages);
    /** @type {{ x: number, label: string }[]} */
    const ticks = [];
    for (let index = 0; index <= maxMessages; index += step) {
        ticks.push({ x: round(xOf(index)), label: `#${index}` });
    }

    return {
        lines,
        trunks,
        width,
        extent: Math.ceil(extent),
        height: geometry.top + nodes.length * geometry.rowH,
        maxMessages,
        dense: nodes.length >= geometry.denseRows,
        ticks,
    };
}

/**
 * @param {any[]} marks `file.checkpoints`.
 * @param {number} from First message index that belongs to this line.
 * @param {number} minX Keep markers off the fork curve.
 * @param {(index: number) => number} xOf
 * @returns {StoryCheckpoint[]}
 */
function checkpointsFrom(marks, from, minX, xOf) {
    /** @type {StoryCheckpoint[]} */
    const out = [];
    for (const mark of marks) {
        if (!mark || !Number.isInteger(mark.mesIndex) || mark.mesIndex < from) {
            continue;
        }
        out.push({ x: round(Math.max(xOf(mark.mesIndex), minX)), mesIndex: mark.mesIndex, name: typeof mark.name === 'string' ? mark.name : '' });
    }
    return out;
}

/** @param {number} value @returns {number} */
function round(value) {
    return Math.round(value * 10) / 10;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})@(\d{2})h(\d{2})m\d{2}s\d{3}ms(?: - Branch #(\d+))?$/;

const dayFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * A chat id as a person would say it. Stock ids are `<Character> - <timestamp>`
 * (plus ` - Branch #N` for branches); a renamed chat keeps the name it was given.
 * @param {string} id Chat id.
 * @param {string} [characterName] Active character's name, stripped as a prefix.
 * @returns {string}
 */
export function displayName(id, characterName = '') {
    let rest = String(id ?? '');
    if (characterName && rest.startsWith(`${characterName} - `)) {
        rest = rest.slice(characterName.length + 3);
    }
    const stamp = STAMP.exec(rest);
    if (!stamp) {
        return rest || String(id ?? '');
    }
    if (stamp[6]) {
        return `Branch #${stamp[6]}`;
    }
    const date = new Date(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]));
    return Number.isNaN(date.getTime()) ? rest : `Chat from ${dayFormatter.format(date)}`;
}

/**
 * @param {ForestNode} node Any node.
 * @returns {ForestNode} Its root.
 */
export function rootOf(node) {
    let current = node;
    // Bounded: the forest builder already cut cycles, this is belt and braces.
    for (let hops = 0; current.parent && hops < 10000; hops++) {
        current = current.parent;
    }
    return current;
}
