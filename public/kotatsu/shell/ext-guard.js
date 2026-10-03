/**
 * Kotatsu shell — the incompatible-extension guard (ext gauntlet 2026-10-02, finding 5 and
 * the tail of finding 1).
 *
 * Two extensions in the gauntlet took the layout instead of living in it, and Kotatsu said
 * nothing: ProbablyTooManyTabs re-parents `#sheld` (chat, composer, the Prompt dock's panel)
 * into its own pane grid behind the frame — the chat view is a hollow shell with zero console
 * errors; LandingPage puts a z-2000 layer over the whole home view, so the library's cards are
 * under it and only its own controls hit. Neither is a bug in the extension; stock's margins
 * and body-level `#sheld` are what they were written against. Under rails they are
 * incompatible, and the honest thing is to say so, by name, and offer the way out.
 *
 * What it watches (rails only, installed by `layouts/rails.js`):
 *
 * - **`#sheld` leaving `#k-center`.** Childlist observer on the centre; the node that holds
 *   `#sheld` now (its body-level ancestor) is the taker.
 * - **A foreign layer over the centre.** Hit-tests three points of `#k-center` with
 *   `elementFromPoint` — what the user's click would reach — and walks each hit up to its
 *   body-level ancestor. Ours and core's (the frame, the bar, any `k-*` element, popups, toasts)
 *   are fine; anything else is a cover. Two of three points must agree, so a floating button
 *   at the centre does not count. Re-checked on body childlist changes, on view changes
 *   (`data-k-view`) and once extensions have loaded (`APP_READY`), debounced.
 *
 * **Who did it** is read from the extension's own stylesheet: a `<link>` under
 * `/scripts/extensions/third-party/<folder>/` whose rules match the node or something in it.
 * Not a list of names — an extension written tomorrow is attributed the same way. The folder
 * is what `disableExtension()` wants; the display name comes from its manifest.
 *
 * The notice is `<k-ext-guard variant="banner">`, fixed under the top bar on stock's rung + 1
 * (3006), so the layer it is about cannot cover it. "Disable and reload" is core's own
 * `disableExtension(name, true)`. "Keep it" is remembered for the session.
 *
 * Console door: `window.kotatsu.extGuard` (`state`, `check()`).
 */

import { LitElement, html, nothing } from './lit.js';
import { disableExtension } from '../../scripts/extensions.js';
import { eventSource, event_types } from '../../scripts/events.js';

/** `sessionStorage` key: the takers the reader chose to keep this session. */
const DISMISSED_KEY = 'kotatsu.extguard.dismissed';

/** Stock's `#top-bar` rung is 3005; the bar sits there; the notice sits just above it. */
export const EXT_GUARD_Z = 3006;

const CHECK_DEBOUNCE_MS = 250;

/**
 * @typedef {object} Finding
 * @property {'sheld'|'cover'} kind
 * @property {Element} node The body-level node responsible.
 * @property {string} hint `#id` or `.class` of that node, for the sentence when no name is known.
 * @property {string|null} folder `third-party/<folder>`, when the stylesheet attribution found one.
 * @property {string} name The display name, the folder, or '' while unknown.
 */

let installed = false;
/** @type {MutationObserver|null} */
let bodyWatch = null;
/** @type {MutationObserver|null} */
let centerWatch = null;
/** @type {number} */
let timer = 0;
/** @type {Finding|null} */
let current = null;
/** @type {Map<string, string>} folder → display name, fetched once. */
const names = new Map();

/**
 * @param {Element} node Any element.
 * @returns {Element|null} Its ancestor that is a direct child of `<body>` (itself, if it is one).
 */
function bodyLevel(node) {
    let at = node;
    while (at && at.parentElement && at.parentElement !== document.body) at = at.parentElement;
    return at && at.parentElement === document.body ? at : null;
}

/**
 * Whether a body-level node is Kotatsu's or core's furniture, which a hit on is not a cover.
 * @param {Element} node A direct child of `<body>`.
 * @returns {boolean} True when it is ours or core's.
 */
function isOurs(node) {
    const id = node.id ?? '';
    const tag = node.tagName.toLowerCase();
    return tag.startsWith('k-') || id.startsWith('k-') || tag === 'dialog' || tag === 'script' || tag === 'style' || tag === 'link'
        || id === 'toast-container' || id === 'movingDivs' || id === 'sheld' || id === 'top-settings-holder' || id === 'top-bar'
        || id === 'bg1' || id === 'bg_custom' || id === 'character_popup' || id === 'shadow_popup' || id === 'dialogue_popup'
        || node.classList.contains('popup') || node.classList.contains('select2-container') || node.classList.contains('ui-widget')
        || node.classList.contains('k-onb-scrim') || node.classList.contains('k-studio-scrim');
}

/**
 * @param {Element} node Any element.
 * @returns {string} `#id`, else `.first-class`, else the tag.
 */
function hintFor(node) {
    if (node.id) return `#${node.id}`;
    const cls = [...node.classList][0];
    return cls ? `.${cls}` : node.tagName.toLowerCase();
}

/**
 * Which third-party extension styles this node: the first stylesheet under a third-party
 * folder with a rule that matches it or something inside it.
 * @param {Element} node A body-level node.
 * @returns {string|null} `third-party/<folder>`, or null.
 */
function attribute(node) {
    for (const sheet of document.styleSheets) {
        const href = sheet.href ?? '';
        const match = /\/extensions\/third-party\/([^/]+)\//.exec(href);
        if (!match) continue;
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of rules) {
            if (!(rule instanceof CSSStyleRule)) continue;
            try {
                if (node.matches(rule.selectorText) || node.querySelector(rule.selectorText)) return `third-party/${match[1]}`;
            } catch { /* a selector this engine cannot parse */ }
        }
    }
    return null;
}

/**
 * @param {string} folder `third-party/<folder>`.
 * @returns {Promise<string>} The manifest's display name, else the folder's last segment.
 */
async function displayName(folder) {
    const cached = names.get(folder);
    if (cached) return cached;
    const fallback = folder.split('/').pop() ?? folder;
    try {
        const response = await fetch(`/scripts/extensions/${folder}/manifest.json`, { cache: 'no-store' });
        const manifest = response.ok ? await response.json() : null;
        const name = typeof manifest?.display_name === 'string' && manifest.display_name.trim() ? manifest.display_name.trim() : fallback;
        names.set(folder, name);
        return name;
    } catch {
        names.set(folder, fallback);
        return fallback;
    }
}

/** @returns {string[]} Takers kept this session. */
function dismissed() {
    try {
        const raw = sessionStorage.getItem(DISMISSED_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/** @param {string} key Folder or hint. @returns {void} */
function dismiss(key) {
    try {
        sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...dismissed(), key])]));
    } catch { /* private window */ }
}

/** @returns {Finding|null} `#sheld` taken out of the centre, by whom. */
function findSheldTaken() {
    const sheld = document.getElementById('sheld');
    const center = document.getElementById('k-center');
    if (!sheld || !center || sheld.parentElement === center) return null;
    const taker = bodyLevel(sheld);
    if (!taker || taker === sheld || isOurs(taker)) return null;
    return { kind: 'sheld', node: taker, hint: hintFor(taker), folder: null, name: '' };
}

/** @returns {Finding|null} A foreign layer over the centre, which one. */
function findCover() {
    const center = document.getElementById('k-center');
    if (!center || typeof document.elementFromPoint !== 'function') return null;
    const box = center.getBoundingClientRect();
    if (box.width < 50 || box.height < 50) return null;
    const points = [[0.5, 0.5], [0.3, 0.3], [0.7, 0.7]];
    /** @type {Map<Element, number>} */
    const hits = new Map();
    for (const [fx, fy] of points) {
        const hit = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy);
        const top = hit ? bodyLevel(hit) : null;
        if (!top || isOurs(top) || center.contains(hit)) continue;
        hits.set(top, (hits.get(top) ?? 0) + 1);
    }
    for (const [node, count] of hits) {
        if (count >= 2) return { kind: 'cover', node, hint: hintFor(node), folder: null, name: '' };
    }
    return null;
}

/** @returns {HTMLElement|null} The banner, mounted on first need. */
function banner() {
    let element = document.querySelector('k-ext-guard');
    if (!element) {
        element = document.createElement('k-ext-guard');
        element.setAttribute('variant', 'banner');
        document.body.appendChild(element);
    }
    return element instanceof HTMLElement ? element : null;
}

/**
 * Looks, attributes, and shows or clears the notice.
 * @returns {Promise<void>}
 */
async function check() {
    if (!installed || document.body.dataset.kLayout !== 'rails') return;
    const finding = findSheldTaken() ?? findCover();
    if (!finding) {
        if (current) {
            current = null;
            /** @type {any} */ (banner()).finding = null;
        }
        return;
    }
    finding.folder = attribute(finding.node);
    const key = finding.folder ?? finding.hint;
    if (dismissed().includes(key)) {
        current = finding;
        /** @type {any} */ (banner()).finding = null;
        return;
    }
    finding.name = finding.folder ? await displayName(finding.folder) : '';
    if (!installed) return;
    current = finding;
    /** @type {any} */ (banner()).finding = finding;
}

/** Coalesces the bursts the observers produce. @returns {void} */
function schedule() {
    if (timer !== 0) clearTimeout(timer);
    timer = window.setTimeout(() => { timer = 0; void check(); }, CHECK_DEBOUNCE_MS);
}

/** @returns {void} */
export function installExtGuard() {
    if (installed) return;
    installed = true;
    defineExtGuard();
    if (typeof MutationObserver === 'function') {
        bodyWatch = new MutationObserver(schedule);
        bodyWatch.observe(document.body, { childList: true, attributes: true, attributeFilter: ['data-k-view'] });
        const center = document.getElementById('k-center');
        if (center) {
            centerWatch = new MutationObserver(schedule);
            centerWatch.observe(center, { childList: true });
        }
    }
    eventSource.on(event_types.APP_READY, schedule);
    schedule();

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') targetWindow.kotatsu = {};
    targetWindow.kotatsu.extGuard = {
        get state() {
            return current ? { kind: current.kind, hint: current.hint, folder: current.folder, name: current.name, shown: !!document.querySelector('k-ext-guard[open]') } : null;
        },
        check,
    };
}

/** @returns {void} */
export function uninstallExtGuard() {
    if (!installed) return;
    installed = false;
    bodyWatch?.disconnect();
    bodyWatch = null;
    centerWatch?.disconnect();
    centerWatch = null;
    eventSource.removeListener(event_types.APP_READY, schedule);
    if (timer !== 0) { clearTimeout(timer); timer = 0; }
    current = null;
    document.querySelector('k-ext-guard')?.remove();
    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (targetWindow.kotatsu) delete targetWindow.kotatsu.extGuard;
}

/** The notice. Light DOM; `css/shell-ext-guard.css` owns every rule. */
export class KExtGuard extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        open: { type: Boolean, reflect: true },
        finding: { attribute: false },
        _busy: { state: true },
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'banner';
        /** @type {boolean} */
        this.open = false;
        /** @type {Finding|null} */
        this.finding = null;
        /** @type {boolean} */
        this._busy = false;
    }

    createRenderRoot() {
        return this;
    }

    /** @param {Map<string, unknown>} changed Changed properties. */
    willUpdate(changed) {
        if (changed.has('finding')) this.open = !!this.finding;
    }

    /** Core's own disable, then its own reload. @returns {Promise<void>} */
    async #disable() {
        if (!this.finding?.folder || this._busy) return;
        this._busy = true;
        try {
            await disableExtension(this.finding.folder, true);
        } catch (error) {
            console.error('[k-ext-guard] disable failed', error);
            this._busy = false;
        }
    }

    /** Remembered for the session. @returns {void} */
    #keep() {
        if (!this.finding) return;
        dismiss(this.finding.folder ?? this.finding.hint);
        this.finding = null;
    }

    /** @returns {void} */
    #openExtensions() {
        document.dispatchEvent(new CustomEvent('k-open-settings', { bubbles: true, composed: true, detail: { tab: 'extensions' } }));
    }

    render() {
        const finding = this.finding;
        if (!finding) return nothing;
        const who = finding.name ? html`<strong>${finding.name}</strong>` : html`An extension (<code>${finding.hint}</code>)`;
        const line = finding.kind === 'sheld'
            ? html`${who} has taken the chat out of Kotatsu's frame.`
            : html`${who} is covering the centre of the page.`;
        const why = finding.kind === 'sheld'
            ? 'The chat, the composer and the Prompt dock are inside it now; the rails layout and this extension cannot share the page.'
            : 'The library and the composer are under its layer, and only its own controls can be reached.';
        // With a name there is a way out; without one, the Extensions tab is the next best door.
        const primary = finding.folder
            ? html`<button type="button" class="k-eg-btn k-eg-btn--primary k-eg-disable" ?disabled=${this._busy} @click=${() => { void this.#disable(); }}>${this._busy ? 'Disabling…' : 'Disable and reload'}</button>`
            : html`<button type="button" class="k-eg-btn k-eg-btn--primary k-eg-open" @click=${() => this.#openExtensions()}>Open Extensions</button>`;
        return html`
            <div class="k-eg" role="alert">
                <p class="k-eg-line">${line} <span class="k-eg-why">${why}</span></p>
                <div class="k-eg-actions">
                    ${primary}
                    <button type="button" class="k-eg-btn k-eg-keep" ?disabled=${this._busy} @click=${() => this.#keep()}>Keep it</button>
                </div>
            </div>`;
    }
}

/** @returns {void} */
function defineExtGuard() {
    if (!customElements.get('k-ext-guard')) customElements.define('k-ext-guard', KExtGuard);
}
