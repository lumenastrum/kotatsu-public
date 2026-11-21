/**
 * Kotatsu model info: which model and which preset wrote a reply, on demand.
 *
 * Since 1.0 every reply carries the preset that was selected when it was written
 * (`extra.kotatsu_preset`, stamped by `stampPreset()` in script.js for Wrapped). Wrapped only
 * shows it as totals. Targren asked (r/SillyTavernAI, 1.0 post, 2026-11-19) where to see it for
 * ONE message, on mobile, where the provider icon's hover tooltip never shows. So:
 *
 *  - the icon's tooltip names the preset too (createModelIcon in script.js), for desktop;
 *  - TAPPING the icon shows a toast with API, model and preset, which is how a phone sees it.
 *
 * Targren's follow-up (same thread): "make that mobile tap show all the mouseover stuff… ST
 * doesn't love us mobile users." So on touch screens (no hover) a tap on any OTHER hover-only
 * readout in a row's chrome shows its tooltip text the same way: the metrics chips, the
 * generation timer, the ghost mark. Buttons are left alone (a tap there is their action), and so
 * is the message prose (a tap there is reading, or the reveal). Desktop keeps plain hover.
 *
 * One delegated listener on `#chat` (the metadata-reveal shape: `#chat`'s identity is frozen by
 * CONTRACT §1.7, rows are reused constantly, so never per-row listeners). The message is read
 * from `chat[]` by the row's `mesid`, the same truth the icon was painted from. Core keeps the
 * shown swipe's facts on `message.extra`, so the toast follows the swipe on screen.
 *
 * One-way imports: kotatsu → core only.
 */
// `chat` (script.js) is imported lazily, on the first tap: a static import would drag the whole
// core into the unit test of the pure wording below. The module is already loaded by then.

/** The icon core paints beside a row's timestamp (`insertSVGIcon`, script.js). */
export const MODEL_ICON_SELECTOR = '.timestamp-icon';

/**
 * Where a tap means "do something", not "tell me": controls, the edit/action menus, the avatar,
 * links, and the message prose itself (user HTML may carry its own titles; a tap on text is
 * reading). Taps inside these never become a tooltip toast.
 */
const NOT_A_READOUT = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[contenteditable="true"]',
    '.mes_button',
    '.menu_button',
    '.mes_buttons',
    '.mes_edit_buttons',
    '.swipe_left',
    '.swipe_right',
    '.swipes-counter',
    '.avatar',
    '.mes_text',
    '.mes_reasoning',
].join(', ');

/**
 * The tooltip text a tap should show for a target inside a message row, or null.
 * Walks up from the target to the nearest element carrying a non-empty `title` (an injected SVG
 * keeps its tooltip as a `<title>` child instead), stopping at the row. Pure DOM reads, so the
 * policy is unit-testable with fake nodes.
 * @param {Element|null|undefined} target The tapped element.
 * @returns {string|null}
 */
export function readoutText(target) {
    if (!target || typeof target.closest !== 'function') return null;
    if (target.closest(NOT_A_READOUT)) return null;
    const row = target.closest('.mes');
    /** @type {Element|null} */
    let el = target;
    while (el && el !== row) {
        const own = el.getAttribute?.('title');
        if (own && own.trim()) return own.trim();
        const svgTitle = el.tagName?.toLowerCase() === 'svg' ? el.querySelector?.(':scope > title')?.textContent : null;
        if (svgTitle && svgTitle.trim()) return svgTitle.trim();
        el = el.parentElement;
    }
    return null;
}

/** @returns {boolean} Whether this screen has no hover (a phone or tablet), so tooltips never show. */
function touchOnly() {
    return typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;
}

let installed = false;

/**
 * What the toast says for a message's `extra`. Pure, so the wording is unit-testable.
 * Replies written before 1.0 have no preset stamp; the toast says so rather than going quiet,
 * because "no preset line" would read as "no preset was selected".
 * @param {any} extra A chat message's `extra`.
 * @returns {{ title: string, lines: string[] } | null} Null when nothing generated the message.
 */
export function modelInfo(extra) {
    const api = typeof extra?.api === 'string' ? extra.api : '';
    const model = typeof extra?.model === 'string' ? extra.model : '';
    if (!api && !model) return null;
    const preset = typeof extra?.kotatsu_preset === 'string' ? extra.kotatsu_preset : '';
    return {
        title: model || api,
        lines: [
            ...(model && api ? [`API: ${api}`] : []),
            preset ? `Preset: ${preset}` : 'Preset: not recorded (written before 1.0)',
        ],
    };
}

/**
 * @param {string} text Plain text.
 * @returns {string} The same text, safe inside toastr's HTML body.
 */
function escapeHtml(text) {
    /** @type {Record<string, string>} */
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
    return text.replace(/[&<>"']/g, (c) => entities[c]);
}

/**
 * @param {MouseEvent} event Delegated click.
 * @returns {void}
 */
async function onChatClick(event) {
    const target = /** @type {Element|null} */ (event.target);
    const icon = target && typeof target.closest === 'function' ? target.closest(MODEL_ICON_SELECTOR) : null;
    if (!icon) {
        if (!touchOnly()) return;
        const text = readoutText(target);
        if (!text) return;
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        toastr.info(lines.map(escapeHtml).join('<br>'), '', { escapeHtml: false, timeOut: 4000, preventDuplicates: true });
        return;
    }
    const row = icon.closest('.mes');
    const id = Number(row?.getAttribute('mesid'));
    const { chat } = await import('../../script.js');
    const info = Number.isInteger(id) ? modelInfo(chat[id]?.extra) : null;
    if (!info) return;
    toastr.info(info.lines.map(escapeHtml).join('<br>'), info.title, { escapeHtml: false, timeOut: 4000, preventDuplicates: true });
}

/**
 * Registers the delegated handler. Idempotent; called once from `initKotatsuShell()`.
 * @returns {void}
 */
export function initModelInfo() {
    if (installed) return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) {
        console.warn('[Kotatsu renderer] #chat is missing; the model info handler was not installed.');
        return;
    }
    installed = true;
    chatEl.addEventListener('click', onChatClick);
}
