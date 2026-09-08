/**
 * message-rows — the keyed row engine under the message renderer.
 * Renderer v0 slice A (docs/renderer-v0.md §2, §2.5; recon receipts in docs/renderer-v0-recon-*.md).
 *
 * Dependency-free ON PURPOSE. script.js is the only intended consumer and passes everything
 * stateful in at init. Importing core modules from here would put the row engine inside
 * script.js's import cycles; keeping it a leaf keeps the strangle one-way.
 *
 * What lives here:
 *  - the native row factory: `#message_template .mes` is cloned with cloneNode (same output as
 *    jQuery .clone(), no data/event copying either way) and each row gets a one-pass ref map so
 *    fills never re-query
 *  - the row registry: WeakMap from the message OBJECT to its element. Identity, not mesid —
 *    mesid is a positional index that shifts on delete/move. External code may remove or
 *    replace nodes at any time (that is contract), so a disconnected row reads as absent and
 *    the registry self-heals instead of fighting.
 *  - §2.5 mechanisms: per-row `--k-mes-avatar*` custom properties and the validated
 *    `#chat[data-k-mes-*]` enumerated settings (three orthogonal axes)
 */

/** The fixed variant set (SPEC §13 layer 3, extended 2026-08-24). */
export const MESSAGE_VARIANTS = Object.freeze([
    'card', 'flat', 'bubble', 'script', 'bubble-split', 'portrait', 'portrait-column', 'broadcast',
]);

/** Where the name + timestamp row sits relative to the message surface. */
export const NAMEPLATE_VARIANTS = Object.freeze(['inline', 'above', 'margin']);

/** When a row's small chrome (timestamp, model icon, token counter, mesid) is visible. */
export const METADATA_VARIANTS = Object.freeze(['always', 'hover', 'click']);

/**
 * @typedef {object} RowAxis
 * @property {string} attribute the `#chat` attribute this axis publishes
 * @property {readonly string[]} values its known set
 * @property {string} fallback the value applied when the requested one is unknown
 */

/**
 * The three orthogonal variant axes (docs/variant-wardrobe-v0.md §2). Each is an enumerated
 * setting published on `#chat`, validated on write against its own known set, with its own
 * "today's look" default: a pack or user may set any combination, and the wardrobe sheet is
 * inert while all three sit on their defaults.
 * @type {Readonly<Record<string, RowAxis>>}
 */
export const ROW_AXES = Object.freeze({
    message: Object.freeze({ attribute: 'data-k-mes-variant', values: MESSAGE_VARIANTS, fallback: 'card' }),
    nameplate: Object.freeze({ attribute: 'data-k-mes-nameplate', values: NAMEPLATE_VARIANTS, fallback: 'inline' }),
    metadata: Object.freeze({ attribute: 'data-k-mes-metadata', values: METADATA_VARIANTS, fallback: 'always' }),
});

/**
 * Fired on `#chat` (bubbling) by {@link applyVariantAxis} when an axis VALUE actually changes:
 * `detail: { axis, value, previous }`. The shell's rail resolver listens — a look that widens
 * the reading track (css/mes-variants.css §6) moves the readable floor, and the floor is
 * otherwise only re-read on resize. Silent when the door re-applies the value already live.
 */
export const VARIANT_AXIS_EVENT = 'k-mes-variant-change';

/** @type {HTMLElement?} */ let chatEl = null;
/** @type {HTMLElement?} */ let templateEl = null;

/** @type {WeakMap<object, HTMLElement>} message object → its row element */
const rowsByMessage = new WeakMap();
/** @type {WeakMap<HTMLElement, MessageRowRefs>} row element → its ref map */
const refsByRow = new WeakMap();

/**
 * @typedef {object} MessageRowRefs
 * @property {HTMLImageElement?} avatarImg
 * @property {HTMLElement?} nameText
 * @property {HTMLElement?} timestamp
 * @property {HTMLElement?} mesIDDisplay
 * @property {HTMLElement?} tokenCounter
 * @property {HTMLElement?} mesTimer
 * @property {HTMLElement?} mesBias
 * @property {HTMLElement?} mesText
 * @property {HTMLElement?} mesPrompt
 * @property {HTMLElement?} mediaWrapper
 * @property {HTMLElement?} fileWrapper
 * @property {HTMLInputElement?} delCheckbox
 */

/**
 * Caches the chat container and the row template. Idempotent; call once from script.js after
 * the DOM exists (module-eval time is fine — ST loads script.js with the document parsed).
 * @param {object} deps
 * @param {HTMLElement?} deps.chatElement
 * @param {HTMLElement?} deps.templateElement
 * @returns {void}
 */
export function initMessageRows({ chatElement, templateElement }) {
    chatEl = chatElement ?? chatEl;
    templateEl = templateElement ?? templateEl;
    if (!chatEl) return;
    for (const { attribute, fallback } of Object.values(ROW_AXES)) {
        if (!chatEl.hasAttribute(attribute)) {
            chatEl.setAttribute(attribute, fallback);
        }
    }
}

/**
 * @param {string} axis axis name
 * @returns {RowAxis} its descriptor
 */
function rowAxis(axis) {
    const descriptor = ROW_AXES[axis];
    if (!descriptor) {
        throw new Error(`[message-rows] Unknown variant axis "${axis}". Known: ${Object.keys(ROW_AXES).join(', ')}.`);
    }
    return descriptor;
}

/**
 * @param {string} axis axis name
 * @param {unknown} value candidate value
 * @returns {value is string} whether the value belongs to that axis's known set
 */
export function isVariantAxisValue(axis, value) {
    return typeof value === 'string' && rowAxis(axis).values.includes(value);
}

/**
 * Applies one variant axis to `#chat`. Invalid values fall back to that axis's default with one
 * warning — never a piggyback on a value nobody can apply (docs/renderer-v0.md §2.5 #2). A pack
 * authored against a newer known set therefore costs a warning, never a broken row.
 * @param {string} axis axis name
 * @param {unknown} value requested value
 * @returns {string} the value actually applied
 */
export function applyVariantAxis(axis, value) {
    const { attribute, values, fallback } = rowAxis(axis);
    const applied = isVariantAxisValue(axis, value) ? value : fallback;
    if (value !== undefined && value !== null && applied !== value) {
        console.warn(`[message-rows] Unknown ${axis} variant "${value}"; falling back to "${fallback}". Known: ${values.join(', ')}.`);
    }
    const previous = chatEl?.getAttribute(attribute) ?? null;
    chatEl?.setAttribute(attribute, applied);
    if (previous !== applied && chatEl && typeof chatEl.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        chatEl.dispatchEvent(new CustomEvent(VARIANT_AXIS_EVENT, { bubbles: true, detail: { axis, value: applied, previous } }));
    }
    return applied;
}

/**
 * @param {string} axis axis name
 * @returns {string} the value currently applied on that axis
 */
export function getVariantAxis(axis) {
    const { attribute, fallback } = rowAxis(axis);
    const value = chatEl?.getAttribute(attribute);
    return isVariantAxisValue(axis, value) ? value : fallback;
}

/**
 * Collects (or returns the cached) ref map for a row. Rows built elsewhere — a caller-passed
 * jQuery clone, a node adopted from the live DOM — get their refs collected on first touch.
 * @param {HTMLElement} el a `.mes` element
 * @returns {MessageRowRefs}
 */
export function rowRefs(el) {
    let refs = refsByRow.get(el);
    if (!refs) {
        refs = {
            avatarImg: el.querySelector('.avatar img'),
            nameText: el.querySelector('.ch_name .name_text'),
            timestamp: el.querySelector('.timestamp'),
            mesIDDisplay: el.querySelector('.mesIDDisplay'),
            tokenCounter: el.querySelector('.tokenCounterDisplay'),
            mesTimer: el.querySelector('.mes_timer'),
            mesBias: el.querySelector('.mes_bias'),
            mesText: el.querySelector('.mes_text'),
            mesPrompt: el.querySelector('.mes_prompt'),
            mediaWrapper: el.querySelector('.mes_media_wrapper'),
            fileWrapper: el.querySelector('.mes_file_wrapper'),
            delCheckbox: el.querySelector('.del_checkbox'),
        };
        refsByRow.set(el, refs);
    }
    return refs;
}

/**
 * Builds a fresh, detached row element from the template — byte-shaped to the stock clone by
 * construction, because it IS a clone of the same `#message_template .mes`.
 * @returns {HTMLElement}
 */
export function buildRowElement() {
    if (!templateEl) throw new Error('message-rows: initMessageRows was never called');
    const el = /** @type {HTMLElement} */ (templateEl.cloneNode(true));
    rowRefs(el);
    return el;
}

/**
 * Registers a row as the canonical element for a message object. Last write wins — a swapped
 * node (e.g. /messagerole builds a replacement) simply becomes the new canonical row while the
 * old one falls out via the isConnected check.
 * @param {object} mes the message object (the one living in `chat[]`)
 * @param {HTMLElement} el
 * @returns {void}
 */
export function registerRow(mes, el) {
    if (mes && typeof mes === 'object' && el instanceof HTMLElement) {
        rowsByMessage.set(mes, el);
    }
}

/**
 * The registry read. A disconnected row is treated as absent: external surgery on the list is
 * contract-legal, and the registry self-heals rather than trusting stale references.
 * @param {object} mes the message object
 * @returns {HTMLElement?} the mounted row, or null
 */
export function rowFor(mes) {
    const el = (mes && typeof mes === 'object') ? rowsByMessage.get(mes) : undefined;
    return (el && el.isConnected) ? el : null;
}

/**
 * §2.5 #1 — the per-message avatar custom properties (the Moonlit recon's "single best trick",
 * done as one write at fill time instead of a chat-wide MutationObserver). CSS reads
 * `var(--k-mes-avatar-original, var(--k-mes-avatar))` and the whole portrait family becomes
 * pure stylesheet work.
 *
 * §2.5 #3 — variant-aware resolution: the original is derived by reversing core's
 * `/thumbnail?type=avatar&file=…` URL; non-thumbnail sources (personas, forced avatars,
 * system) keep the resolved URL as their original.
 * @param {HTMLElement} el the row
 * @param {string} avatarUrl the resolved (thumbnail or direct) avatar URL
 * @returns {void}
 */
export function setRowAvatarProps(el, avatarUrl) {
    const url = String(avatarUrl ?? '');
    // Root-absolutize before writing: these properties are consumed by var() inside
    // STYLESHEET rules (mes-variants.css portrait family), and a relative url token
    // substituted there resolves against the stylesheet's base — `characters/x.png`
    // became /css/characters/x.png, a 404 (live-caught by the wardrobe gate). A
    // root-absolute URL is base-independent wherever it is consumed.
    const rootAbs = (u) => (/^(?:\/|data:|blob:|https?:)/.test(u) ? u : '/' + u);
    const cssUrl = (u) => `url("${rootAbs(u).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
    let original = url;
    if (url.startsWith('/thumbnail?')) {
        try {
            const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
            const file = params.get('file');
            const type = params.get('type');
            if (type === 'avatar' && file) {
                original = `characters/${encodeURIComponent(file)}`;
            } else if (type === 'persona' && file) {
                // Personas have the same thumb/original split as characters — the
                // full-res file is served from /User Avatars/. Without this branch a
                // persona's "original" stayed the 96px-class thumb, which portrait*
                // blew up into mush (live report: "persona images decimated").
                original = `User Avatars/${encodeURIComponent(file)}`;
            }
        } catch { /* malformed URL: keep the resolved value */ }
    }
    el.style.setProperty('--k-mes-avatar', cssUrl(url));
    el.style.setProperty('--k-mes-avatar-thumb', cssUrl(url));
    el.style.setProperty('--k-mes-avatar-original', cssUrl(original));
}

/**
 * Returns a reused row to the state of a fresh template clone for every CONDITIONAL write the
 * fill performs (stock only writes those fields when truthy, which is correct on a pristine
 * clone and stale on a lived-in node). Running this before the fill makes
 * reset + fill ≡ clone + fill, which is what DOM parity means for row reuse.
 * @param {HTMLElement} el a `.mes` element about to be refilled
 * @returns {void}
 */
export function resetRowConditionals(el) {
    const refs = rowRefs(el);
    el.removeAttribute('title');
    el.removeAttribute('bookmark_link');
    el.removeAttribute('data-media-display');
    el.classList.remove('smallSysMes', 'toolCall');
    if (refs.tokenCounter) refs.tokenCounter.textContent = '';
    if (refs.mesTimer) { refs.mesTimer.textContent = ''; refs.mesTimer.removeAttribute('title'); }
    if (refs.mesBias) refs.mesBias.replaceChildren();
    if (refs.mesPrompt) refs.mesPrompt.style.display = 'none';
    if (refs.mediaWrapper) refs.mediaWrapper.replaceChildren();
    if (refs.fileWrapper) refs.fileWrapper.replaceChildren();
    if (refs.mesText) refs.mesText.classList.remove('inline_media');
    if (refs.delCheckbox) refs.delCheckbox.checked = false;
    // insertSVGIcon appends these as siblings outside .mes_text; a fresh clone has neither.
    // `k-mes-metrics` (metrics native v0) joins them for the same reason and one more: the bar
    // is mounted ON DEMAND, only for messages that carry usage, so a reused row must never wear
    // the previous message's numbers. The metrics module puts it back on its own paint drivers.
    for (const conditional of el.querySelectorAll('.timestamp-icon, .thinking-icon, k-mes-metrics')) conditional.remove();
}

/**
 * Places rows so their sibling order matches the given array, repairing only where the order
 * is wrong. All-fresh batches (the common full render) take the fragment fast path.
 * @param {HTMLElement} container
 * @param {HTMLElement[]} rows in the order they must appear
 * @param {boolean} allFresh every row is detached (nothing to repair around)
 * @returns {void}
 */
export function placeRowsInOrder(container, rows, allFresh) {
    if (rows.length === 0) return;
    if (allFresh) {
        const fragment = document.createDocumentFragment();
        for (const el of rows) fragment.appendChild(el);
        container.appendChild(fragment);
        return;
    }
    /** @type {HTMLElement?} */
    let expectedNext = null;
    for (let i = rows.length - 1; i >= 0; i--) {
        const el = rows[i];
        if (el.parentElement !== container || el.nextElementSibling !== expectedNext) {
            container.insertBefore(el, expectedNext);
        }
        expectedNext = el;
    }
}
