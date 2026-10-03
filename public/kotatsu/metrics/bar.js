/**
 * Kotatsu metrics — the bar (metrics native v0, `docs/metrics-native-v0.md` §4, §5).
 *
 * `<k-mes-metrics variant="bar">`, a LIGHT-DOM custom element mounted as a `.mes_block` child
 * directly after `.ch_name`. Three deliberate constraints shape this file:
 *
 *  - **Light DOM, no shadow root.** CONTRACT §6.1 corollary 1: shadow DOM near the frozen
 *    message subtree is a break. jQuery selectors and `document.getElementById` must keep
 *    reaching everything, and the theme token layer styles this from the page's sheets.
 *  - **`variant` from day one.** SPEC §13 layer 3 — every new component ships with a variant
 *    attribute even when v1 has exactly one value, so a pack can add a look without adding JS.
 *  - **On demand only.** The bar is never in `#message_template`. A message with no usage gets
 *    no element at all, which is what keeps the parity baselines (a synthetic corpus carrying
 *    no usage) byte-identical and untouched by this slice.
 *
 * Nothing here reads core state or the DOM outside the row it was handed: the numbers arrive
 * pre-computed from `usage.js`. Nothing here touches `.mes_text` — `StreamingView` owns that
 * interior and writing into it during a stream is how the extension era produced ghosts.
 */
import { metricsViewModel } from './usage.js';

/** The element's tag. Also the selector `message-rows.js` sweeps on row reuse. */
export const METRICS_TAG = 'k-mes-metrics';

/** The v1 variant set (SPEC §13). A pack adds a look by styling one of these, never by code. */
export const METRICS_VARIANTS = Object.freeze(['bar']);

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The three icons, as stroke paths on a 16×16 box. Inline SVG rather than emoji or a webfont:
 * repo rule (CLAUDE.md, "No emoji-as-icons"), and the extension's `◰ ✦ ↑` were exactly the
 * violation. `currentColor` means each icon inherits its chip's state color for free.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const ICON_PATHS = Object.freeze({
    // Context: a gauge arc with a needle — a dial that fills, matching what the track does.
    // The baseline closes the dial: without it the arc reads as a clipped circle at 11px.
    context: Object.freeze(['M2.5 12a5.5 5.5 0 0 1 11 0', 'M2.5 12h11', 'M8 12 10.6 8.4']),
    // Cache: a four-point spark — the same "reused, not recomputed" idea the verdict names.
    cache: Object.freeze(['M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8 6.6 6.6Z']),
    // Output: tokens leaving.
    output: Object.freeze(['M8 13V3.6', 'M4.4 7.2 8 3.6l3.6 3.6']),
});

/**
 * @param {keyof typeof ICON_PATHS} name which icon
 * @returns {SVGElement} a detached stroke icon
 */
function buildIcon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'k-metrics__icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '11');
    svg.setAttribute('height', '11');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of ICON_PATHS[name]) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

/**
 * @param {string} modifier chip kind, e.g. `ctx`
 * @param {import('./usage.js').ChipCopy} copy state + label + title
 * @param {keyof typeof ICON_PATHS} icon which icon leads it
 * @returns {HTMLElement} a detached chip
 */
function buildChip(modifier, copy, icon) {
    const chip = document.createElement('span');
    chip.className = `k-metrics__chip k-metrics__${modifier}`;
    chip.dataset.state = copy.state;
    chip.title = copy.title;
    chip.append(buildIcon(icon));
    return chip;
}

/**
 * @param {string} text the chip face
 * @returns {HTMLElement} its text node holder
 */
function buildText(text) {
    const span = document.createElement('span');
    span.className = 'k-metrics__text';
    span.textContent = text;
    return span;
}

/**
 * The context gauge: icon, a fixed 64×4 track whose fill is the percentage, then the numbers.
 * The track is a fixed width on purpose — a proportional one would make two adjacent messages
 * incomparable at a glance, which is the entire job of the readout.
 * @param {import('./usage.js').ChipCopy} copy gauge copy
 * @param {number?} pct fill percentage, or null when unknown
 * @returns {HTMLElement}
 */
function buildContextChip(copy, pct) {
    const chip = buildChip('ctx', copy, 'context');
    const track = document.createElement('span');
    track.className = 'k-metrics__track';
    const fill = document.createElement('span');
    fill.className = 'k-metrics__fill';
    fill.style.width = `${pct == null ? 0 : pct}%`;
    track.append(fill);
    chip.append(track, buildText(copy.label));
    return chip;
}

/**
 * The custom element. Deliberately behaviourless: no shadow root, no lifecycle work, no
 * observed attributes. It exists so the bar has a NAME in the DOM (a tag a pack's `sheet.css`
 * and a future variant can target) rather than yet another anonymous `div.some-class`.
 */
class KotatsuMessageMetrics extends HTMLElement { }

let defined = false;

/**
 * Registers the tag. Idempotent, and tolerant of a double definition from a live-reload — a
 * telemetry readout may never be the thing that throws during boot.
 * @returns {void}
 */
export function defineMetricsElement() {
    if (defined) return;
    defined = true;
    if (typeof customElements === 'undefined' || customElements.get(METRICS_TAG)) return;
    try {
        customElements.define(METRICS_TAG, KotatsuMessageMetrics);
    } catch (error) {
        console.warn('[Kotatsu metrics] could not define <k-mes-metrics>:', error);
    }
}

/**
 * @param {HTMLElement} row a `.mes` element
 * @returns {HTMLElement?} its existing bar, if any
 */
function existingBar(row) {
    return /** @type {HTMLElement?} */ (row.querySelector(METRICS_TAG));
}

/**
 * Removes any bar from a row. Used by the setting's off switch and by the "message lost its
 * usage" path; row REUSE is handled in core by `resetRowConditionals()`.
 * @param {HTMLElement} row a `.mes` element
 * @returns {boolean} whether anything was removed
 */
export function removeMetricsBar(row) {
    const bar = existingBar(row);
    if (!bar) return false;
    bar.remove();
    return true;
}

/**
 * Paints (or repaints, or removes) one row's bar.
 *
 * Idempotent by construction: the host element is REUSED when it is already mounted and only
 * its children are rebuilt, so a sweep over a loaded chat does not churn nodes and a bar that
 * was already correct stays the same node.
 *
 * @param {HTMLElement?} row the `.mes` element, from `rowFor(chat[id])` — never a mesid query
 * @param {any} message the `chat[]` entry backing it
 * @param {number?} maxContext the full context window, from `getMaxContextTokens()`
 * @returns {boolean} whether a bar is mounted on the row afterwards
 */
export function paintMetricsBar(row, message, maxContext) {
    if (!row) return false;

    const model = metricsViewModel(message, maxContext);
    if (!model) {
        removeMetricsBar(row);
        return false;
    }

    const block = row.querySelector('.mes_block');
    if (!block) return false;

    let bar = existingBar(row);
    if (!bar) bar = document.createElement(METRICS_TAG);
    // Asserted on every paint, not just on creation: every rule in css/mes-metrics.css is gated
    // on `[variant]`, so an element that somehow reached the row without one would render as an
    // unstyled inline run of text rather than a bar — a failure mode worth one attribute write.
    if (bar.getAttribute('variant') !== METRICS_VARIANTS[0]) {
        bar.setAttribute('variant', METRICS_VARIANTS[0]);
    }

    /** @type {(HTMLElement)[]} */
    const chips = [buildContextChip(model.context, model.pct)];

    const cache = buildChip('cache', model.cache, 'cache');
    cache.append(buildText(model.cache.label));
    chips.push(cache);

    if (model.output) {
        const output = buildChip('out', model.output, 'output');
        output.append(buildText(model.output.label));
        chips.push(output);
    }

    bar.replaceChildren(...chips);
    // The state also lands on the host so a pack can restyle the whole bar off one attribute
    // (a crit-red hairline, say) without having to reach into the chip tree.
    bar.dataset.state = model.context.state;
    bar.dataset.provider = String(model.usage.provider ?? '');

    if (!bar.isConnected || bar.parentElement !== block) {
        // CONTRACT §1.7 names `.mes_block`'s CHILD LIST an imperative region and the metrics
        // bar as its example consumer. `.ch_name` carries the nameplate and `.mes_buttons`;
        // sitting directly under it is where the extension era put it and where the eye
        // already looks.
        const nameRow = block.querySelector(':scope > .ch_name');
        if (nameRow) nameRow.insertAdjacentElement('afterend', bar);
        else block.insertBefore(bar, block.firstChild);
    }
    return true;
}
