/**
 * The phone theatre's reading behaviour (docs/vn-theatre-v0.md). css/sprites.css §9 turns the
 * transcript into one textbox, the last row, and makes its PROSE BOX the scroller (capped at about a
 * third of the screen). `#chat` then holds a row of its natural height, so core's keep-at-the-bottom
 * scroll has nothing to move, and a fresh line opens at its start: the order a visual novel is read
 * in. (A first version scrolled `#chat` itself and raced core to put the line back at its start;
 * it lost, 2026-10-22.)
 *
 * What is left for script:
 * - **The box says when there is more** below: `.mes_text[data-k-more-below]` fades its foot. Checked
 *   on the box's scroll, its resize, and as a streaming reply grows it (one check per frame).
 * - **A swiped line starts over**: the same box gets new words, so it goes back to its first line.
 * - **A tap turns the page** (Andres, 2026-10-23, on medium-length replies: "The longer replies take away from the
 *   sprite itself"): while there is more below, a tap on the prose moves to the next page, breaking on whole lines
 *   (theatre-pages.js), and the row's tap-to-reveal waits for the last page. A finger can still scroll; links,
 *   buttons and an open editor keep their own taps. The row carries `data-k-vn-more` for the ▾ cue (css §9).
 *
 * Only while the theatre is on (`theatreActive()`); everywhere else the attributes are removed.
 */

import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import { theatreActive } from './k-sprite-stage.js';
import { nextPageOffset } from './theatre-pages.js';

let installed = false;
let frame = 0;

/** @returns {HTMLElement|null} the textbox's prose box */
function proseBox() {
    return /** @type {HTMLElement|null} */ (document.querySelector('#chat > .mes.last_mes .mes_text'));
}

/** Marks whether the prose box has more below; clears every stale mark. */
function markMore() {
    frame = 0;
    const box = proseBox();
    for (const other of document.querySelectorAll('#chat .mes_text[data-k-more-below]')) {
        if (other !== box) other.removeAttribute('data-k-more-below');
    }
    const row = /** @type {HTMLElement|null|undefined} */ (box?.closest('.mes'));
    for (const other of document.querySelectorAll('#chat .mes[data-k-vn-more]')) {
        if (other !== row) other.removeAttribute('data-k-vn-more');
    }
    if (!box || !row) return;
    const on = theatreActive() && !('kVnHistory' in document.body.dataset);
    const more = on && box.scrollTop + box.clientHeight < box.scrollHeight - 4;
    box.toggleAttribute('data-k-more-below', more);
    row.toggleAttribute('data-k-vn-more', more);
    // The cue sits on the row (the prose box scrolls and is masked), just above the box's bottom edge.
    if (more) row.style.setProperty('--vn-box-foot', `${Math.round(row.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom)}px`);
}

/** The prose box's line boxes, from the browser's own layout. @param {HTMLElement} box */
function lineBoxes(box) {
    const lines = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.trim()) continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) lines.push({ top: rect.top, bottom: rect.bottom });
    }
    return lines;
}

/**
 * A tap on the textbox while more waits below: the next page, instead of the row's tap-to-reveal.
 * Captured on #chat, so it runs before the reveal's own (bubbling) handler and can keep it from toggling.
 * @param {MouseEvent} event
 */
function onTap(event) {
    if (!theatreActive() || 'kVnHistory' in document.body.dataset) return;
    const box = proseBox();
    const target = /** @type {Element|null} */ (event.target instanceof Element ? event.target : null);
    if (!box || !target || !box.contains(target) || !box.hasAttribute('data-k-more-below')) return;
    if (target.closest('a, button, input, textarea, select, summary, label, [contenteditable="true"]')) return;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed) return;
    const style = getComputedStyle(box);
    const rect = box.getBoundingClientRect();
    const fade = parseFloat(style.getPropertyValue('--k-vn-fade-bottom')) || 0;
    const top = nextPageOffset(lineBoxes(box), {
        top: rect.top + parseFloat(style.paddingTop),
        readable: rect.bottom - Math.max(fade, parseFloat(style.paddingBottom)),
        scrollTop: box.scrollTop,
        maxScroll: box.scrollHeight - box.clientHeight,
        fallback: Math.max(1, box.clientHeight - fade),
    });
    if (top === null) return;
    event.stopPropagation();
    const still = power_user.reduced_motion || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ top, behavior: still ? 'auto' : 'smooth' });
}

function scheduleMark() {
    if (!frame) frame = requestAnimationFrame(markMore);
}

/**
 * Wires the theatre's reading behaviour. Once, from the rails mount (sprites/k-sprite-stage.js).
 * @returns {void}
 */
export function installTheatre() {
    if (installed) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    installed = true;
    // `scroll` does not bubble; captured on #chat it hears every prose box, including ones rendered later.
    chat.addEventListener('scroll', scheduleMark, { capture: true, passive: true });
    chat.addEventListener('click', onTap, { capture: true });
    new ResizeObserver(scheduleMark).observe(chat);
    // A streaming reply rewrites its prose box per token; one check per frame is enough.
    new MutationObserver(scheduleMark).observe(chat, { childList: true, subtree: true, characterData: true });
    new MutationObserver(scheduleMark).observe(document.body, { attributes: true, attributeFilter: ['data-k-vn-history'] });
    eventSource.on(event_types.MESSAGE_SWIPED, () => {
        requestAnimationFrame(() => {
            const box = proseBox();
            if (box && theatreActive()) box.scrollTop = 0;
            scheduleMark();
        });
    });
}
