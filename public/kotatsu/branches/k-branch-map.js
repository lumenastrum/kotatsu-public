/**
 * `<k-branch-map variant="overlay">` — the branch forest overlay (branch panel
 * v0, slice D). The native replacement for the SillyTavern-Timelines extension.
 *
 * Design: `docs/branch-panel-v0.md` §"The map". Decisions this file implements
 * literally, and must not quietly drift from:
 *
 * - **Nodes are chats** (decision 10). One row per chat file. Edges carry the
 *   fork index and, when the parent ever persisted one, the parent-side fork
 *   note. Message-level nodes are Phase B's, not v0's.
 * - **No cytoscape, no dagre, no markdown in hot paths** (decision 9). The
 *   layout is a hand-rolled tidy indent-tree: `buildForest` → `buildSections` →
 *   `sectionPaths`, all pure, all O(n), all exported so `tests/branch-map.test.js`
 *   can measure them against the budgets instead of vibing them. Previews are
 *   plain text straight off the sidecar.
 * - **Honest data.** `forkIndex` may be null — the label is then omitted, never
 *   invented. `branchNotes` is empty on every pre-Kotatsu chat (stock never
 *   persisted `extra.branches[]`, see the store's header), so the fork-context
 *   line is simply absent on existing data. That is expected, not a bug.
 *   `orphanName` renders as an "unlinked" badge with the ghost name muted
 *   (decision 5); `via: "adopted"` gets a dotted connector (decision 1).
 * - **Every listener subscribed is unsubscribed.** The Timelines autopsy's leak
 *   list is the anti-pattern checklist: no per-hover allocation, no renderer per
 *   row, no cache invalidated on every rendered message. The overlay element is
 *   *created on open and removed from the DOM on close*, so teardown is not a
 *   discipline question — the element stops existing.
 *
 * Virtualization: the forest is laid out in full (cheap: ≤ 802 rows) but only
 * the root sections intersecting the viewport are rendered. Rows are a fixed
 * height read from `--k-bm-row-h`, so section offsets are exact rather than
 * estimated and `scrollTop` math needs no measurement pass.
 *
 * Light DOM (`createRenderRoot()` returns `this`) for the same three reasons the
 * shell components give: `public/css/branch-map.css` reaches the internals, a
 * theme pack's `sheet.css` reaches them too, and `initDynamicStyles()`
 * (dynamic-styles.js:188-202) can see the hover / focus-visible pairs it audits.
 *
 * Layout-independent on purpose. The `--k-*` tokens live on `:root`
 * (css/tokens.css), not on `body[data-k-layout="rails"]`, so the overlay skins
 * correctly under classic too — and the keyboard door has to work wherever the
 * user is. Only the top-bar affordance is rails-only, because only rails has a
 * top bar.
 *
 * One-way imports: kotatsu → core (`script.js`, `scripts/*.js`) and → the store.
 * Nothing in core imports this file; it is reached from `initKotatsuShell()`.
 */

import {
    buildForest,
    buildSections,
    compileQuery,
    firstSectionAt,
    MARKER_HALF,
    NO_SEARCH,
    searchForest,
    sectionPaths,
} from './map-model.js';

export {
    buildForest,
    buildSections,
    compileQuery,
    firstSectionAt,
    flattenSection,
    searchForest,
    sectionPaths,
    toEpochMs,
    toIsoDay,
} from './map-model.js';

/** @typedef {import('./map-model.js').ForestNode} ForestNode */
/** @typedef {import('./map-model.js').Forest} Forest */
/** @typedef {import('./map-model.js').MapRow} MapRow */
/** @typedef {import('./map-model.js').MapSection} MapSection */
/** @typedef {import('./map-model.js').MapLayout} MapLayout */
/** @typedef {import('./map-model.js').MapGeometry} MapGeometry */
/** @typedef {import('./map-model.js').SearchResult} SearchResult */

import { toRelative } from '../shell/relative-time.js';
import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { characters, getCurrentChatId, this_chid } from '../../script.js';
import { selected_group } from '../../scripts/group-chats.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../scripts/popup.js';
import { EMPTY_TREE, branchStore } from './store.js';
import { STORY_GEOMETRY, displayName, layoutStory, rootOf, storyOrder } from './story-model.js';

/** Story-lines zoom: 1 = the story fits the pane's width; up to 6× for dense forks. */
const ZOOM_MIN = 1;
const ZOOM_MAX = 6;
const ZOOM_STEP = 1.25;

export { toRelative } from '../shell/relative-time.js';

/** Per-viewer convenience: which view the map opens in. Storage may be unavailable. */
const VIEW_STORAGE_KEY = 'kotatsu.branchMap.view';

/** @returns {'lines'|'list'} */
function readView() {
    try {
        return localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'lines';
    } catch {
        return 'lines';
    }
}

/** @param {'lines'|'list'} view */
function writeView(view) {
    try {
        localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
        /* a private window or blocked storage: the choice just doesn't stick */
    }
}

/** @returns {string} The active character's name, for trimming stock chat-id prefixes. */
function characterName() {
    const index = Number(this_chid);
    return Number.isInteger(index) && Array.isArray(characters) ? String(characters[index]?.name ?? '') : '';
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string} Trimmed at a word boundary, with an ellipsis when cut.
 */
function clip(text, max) {
    if (text.length <= max) {
        return text;
    }
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The open request. Bubbling + composed, like `k-open-settings`. */
export const OPEN_BRANCH_MAP_EVENT = 'k-open-branch-map';

/**
 * The keyboard door.
 *
 * Chosen after auditing every keydown handler core ships (receipts, all read in
 * this clone): `RossAscends-mods.js:1005-1302` (the global cascade — Ctrl+Enter,
 * Alt+Enter, Ctrl+Shift+Arrow, Ctrl+Arrow, bare Arrow, Escape, Ctrl+1-9),
 * `input-md-formatting.js:14-48` (Ctrl+B/I/U/K and Ctrl+Shift+Backquote, and
 * whose line 14 guard *explicitly returns on Ctrl+Shift+letter*),
 * `keyboard.js:214-220` (bare Enter on interactables), `popup.js:630-655`,
 * `chats.js:2260`, `autocomplete/AutoComplete.js:781-841`,
 * `quick-reply/src/QuickReply.js:649-736` (F9, Ctrl+Backslash),
 * `macros/engine/MacroBrowser.js:290` and
 * `slash-commands/SlashCommandBrowser.js:138` (both Ctrl+F, both scoped to their
 * own already-open browser). `grep -rn accesskey public/` returns nothing.
 * Ctrl+Shift+B is unclaimed by all of them.
 *
 * Browser-level, Ctrl+Shift+B toggles the Chromium bookmarks bar. That is a
 * page-preventable default (it is not on Chromium's reserved list, unlike
 * Ctrl+N/T/W), and the handler calls `preventDefault()`. Should a browser
 * reserve it anyway, the two non-keyboard doors — the rail's "Open map" event
 * and the top-bar affordance — are unaffected. Wants a live confirmation in E2.
 */
export const OPEN_HOTKEY = { key: 'b', ctrl: true, shift: true, label: 'Ctrl+Shift+B' };

/**
 * Stacking rung. Above every in-page core surface — `#shadow_select_chat_popup`
 * 4100 (style.css:4743), `#top-settings-holder` 4005/3005 (style.css:5501,
 * kotatsu-chrome.css), `#options` / `#extensionsMenu` 29999 (style.css:1097),
 * `#k-shell` 30 (shell-frame.css:70) and the settings modal's 4090/4091 — and
 * BELOW toastr and the boot loader (999999), which are notifications the user
 * must keep seeing. Core popups are `<dialog showModal()>` (popup.js:623,685):
 * the top layer beats any z-index, so a delete confirm always paints over us.
 * Declared here and consumed by `--k-bm-z` in css/branch-map.css.
 */
export const MAP_Z_INDEX = 30000;

/** Extra pixels rendered above and below the viewport, so a fling never tears. */
const OVERSCAN_PX = 400;

/**
 * Fallbacks when the sheet has not loaded. The live values come from CSS and
 * MUST match `css/branch-map.css`'s `--k-bm-*` defaults — a silent divergence
 * would put the connectors and the rows on different grids.
 */
const GEOMETRY_FALLBACK = Object.freeze({ rowHeight: 30, sectionGap: 14, indent: 20, stem: 20 });

/** Preview text is already capped at 200 chars by the scanner; this is the row's slice. */
const ROW_PREVIEW_CHARS = 120;

/** Same instance reasoning, for the node card's absolute timestamp. */
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

/** @returns {boolean} Whether a group chat is in context (out of v0 scope). */
function inGroupChat() {
    return Boolean(selected_group);
}

/** @returns {boolean} Whether a single character is selected. */
function hasCharacter() {
    if (inGroupChat()) {
        return false;
    }
    if (this_chid === undefined || this_chid === null || this_chid === '') {
        return false;
    }
    const index = Number(this_chid);
    return Number.isInteger(index) && index >= 0 && Array.isArray(characters) && Boolean(characters[index]);
}

/** @returns {string} The open chat's extension-less id, or ''. */
function activeChatId() {
    try {
        return String(getCurrentChatId() ?? '');
    } catch (error) {
        console.error('[k-branch-map] active chat read failed', error);
        return '';
    }
}

/**
 * Whether a core modal is on screen — the same two probes
 * `k-settings-modal.js:corePopupOpen()` uses, and for the same reason: this component's
 * capture-phase key handler must stand down whenever something is layered over
 * it, our own delete confirm included.
 * @returns {boolean} True while a core popup owns the screen.
 */
function corePopupOpen() {
    if (document.querySelector('dialog.popup[open]')) {
        return true;
    }
    const legacy = document.getElementById('shadow_popup');
    return Boolean(legacy) && getComputedStyle(/** @type {Element} */ (legacy)).display !== 'none';
}

/** @param {EventTarget|null} target @returns {boolean} Whether keys belong to a text field. */
function isTextEntry(target) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target.isContentEditable;
}

/**
 * Clipboard write with the documented fallback. `navigator.clipboard` is absent
 * on insecure origins, which a self-hosted ST on a LAN address routinely is.
 * @param {string} text Text to copy.
 * @returns {Promise<boolean>} Whether anything reached the clipboard.
 */
async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        console.debug('[k-branch-map] clipboard API refused, falling back', error);
    }
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.opacity = '0';
    scratch.style.pointerEvents = 'none';
    document.body.appendChild(scratch);
    try {
        scratch.select();
        return document.execCommand('copy');
    } catch (error) {
        console.error('[k-branch-map] clipboard fallback failed', error);
        return false;
    } finally {
        scratch.remove();
    }
}

/** Stroke-only icon set — no Font Awesome, no emoji (repo CLAUDE.md). */
const icons = {
    chevron: svg`<path d="M6 4l4 4-4 4" />`,
    close: html`
        <svg class="k-bm-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    search: html`
        <svg class="k-bm-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2L13.5 13.5" />
        </svg>`,
    checkpoint: html`
        <svg class="k-bm-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M4.5 2.5h7v11l-3.5-2.5-3.5 2.5z" />
        </svg>`,
    unlinked: html`
        <svg class="k-bm-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M6.4 9.6L4.9 11.1a2.3 2.3 0 0 1-3.2-3.2l1.5-1.5" />
            <path d="M9.6 6.4l1.5-1.5a2.3 2.3 0 0 1 3.2 3.2l-1.5 1.5" />
            <path d="M2 2l12 12" />
        </svg>`,
    branch: html`
        <svg class="k-bm-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <circle cx="4.5" cy="3" r="1.75" /><circle cx="4.5" cy="13" r="1.75" /><circle cx="11.5" cy="6" r="1.75" />
            <path d="M4.5 4.75v6.5" /><path d="M9.75 6h-1.5A3.75 3.75 0 0 0 4.5 9.75" />
        </svg>`,
};

/**
 * The forest overlay.
 */
export class KBranchMap extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `overlay` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _query: { state: true },
        _selectedId: { state: true },
        _status: { state: true },
        _revision: { state: true },
        _winStart: { state: true },
        _winEnd: { state: true },
        _renaming: { state: true },
        _renameError: { state: true },
        _busy: { state: true },
        _build: { state: true },
        _view: { state: true },
        _storyId: { state: true },
        _linesW: { state: true },
        _zoom: { state: true },
    };

    /** @type {{ id: number, x: number, y: number, left: number, top: number }|null} A drag-to-pan in progress. */
    #pan = null;

    /** @type {ResizeObserver|null} Watches the story-lines pane's width. */
    #linesObserver = null;

    /** @type {Element|null} The pane that observer is attached to. */
    #linesObserved = null;

    /** @type {number} The width before the last accepted change, for the flip-flop guard. */
    #linesPrevW = 0;

    /** @type {number} When the last width change was seen (performance.now()). */
    #linesChangedAt = 0;

    /** @type {Forest} The rendered forest. Rebuilt whenever the tree changes. */
    #forest = { roots: [], byId: new Map(), order: [] };

    /** @type {MapLayout} */
    #layout = { sections: [], total: 0, rowIndex: new Map(), visibleOrder: [] };

    /** @type {SearchResult} */
    #search = /** @type {SearchResult} */ (NO_SEARCH);

    /** @type {Set<string>} Ids the reader expanded (or the lineage seeded). */
    #expanded = new Set();

    /** @type {MapGeometry|null} Cached CSS metrics; dropped on every open. */
    #geometry = null;

    /** @type {(() => void)|null} BranchStore unsubscribe. */
    #unsubscribe = null;

    /** @type {ResizeObserver|null} Watches the scroller's height. */
    #resizeObserver = null;

    /** @type {number} Last known scroll offset of the canvas. */
    #scrollTop = 0;

    /** @type {number} Last known scroller height; seeded so the first paint fills. */
    #viewportH = 0;

    /** @type {number} Monotonic load token — a slow tree may not overwrite a newer one. */
    #loadToken = 0;

    /** @type {string} Active chat whose lineage has already been auto-expanded. */
    #seededLineage = '';

    /** @type {string} Active chat id at the last load, for highlighting. */
    #activeId = '';

    /** @type {string[]} Lineage of the active chat, for the highlight chain. */
    #lineage = [];

    /** @type {string|null} Id whose row must be scrolled into view after the next paint. */
    #pendingReveal = null;

    /** @type {Element|null} Focus owner from before the overlay opened. */
    #returnFocus = null;

    /** @type {boolean} Whether the press that started this click landed on the backdrop. */
    #pressedBackdrop = false;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'overlay';
        /** @type {string} */
        this._query = '';
        /** @type {string} */
        this._selectedId = '';
        /** @type {'loading'|'ready'|'unavailable'|'empty'|'nocharacter'|'group'} */
        this._status = 'loading';
        /** @type {number} Bumped to publish a change made to the non-reactive layout. */
        this._revision = 0;
        /** @type {number} */
        this._winStart = 0;
        /** @type {number} */
        this._winEnd = 0;
        /** @type {boolean} */
        this._renaming = false;
        /** @type {string} The node card's one status line — rename and copy failures both land here. */
        this._renameError = '';
        /** @type {boolean} */
        this._busy = false;
        /** @type {import('./store.js').BranchTreeBuild|null} */
        this._build = null;
        /** @type {'lines'|'list'} */
        this._view = readView();
        /** @type {string} Root of the story the lines view draws. */
        this._storyId = '';
        /** @type {number} Measured width of the lines pane; 0 until the first measure. */
        this._linesW = 0;
        /** @type {number} Story-lines horizontal zoom, {@link ZOOM_MIN} … {@link ZOOM_MAX}. */
        this._zoom = 1;
        /** @type {(event: KeyboardEvent) => void} */
        this._onKeyDown = (event) => this.#handleKey(event);
        /** @type {(event: MouseEvent) => void} */
        this._onPointerDown = (event) => { this.#pressedBackdrop = event.target === this; };
        /** @type {(event: MouseEvent) => void} */
        this._onClick = (event) => this.#onBackdrop(event);
    }

    /** Light DOM: `public/css/branch-map.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        this.setAttribute('role', 'dialog');
        this.setAttribute('aria-modal', 'true');
        this.setAttribute('aria-label', 'Branch map');
        this.#returnFocus = document.activeElement;
        this.#viewportH = window.innerHeight;
        // Capture phase, so the keys this overlay owns never reach core's
        // bubble-phase cascade (`$(document).on('keydown')`,
        // RossAscends-mods.js:993) — a bare ArrowUp there edits the last message.
        document.addEventListener('keydown', this._onKeyDown, { capture: true });
        // Backdrop dismissal. Bound on the host rather than declared in the
        // template because the host IS the backdrop — `createRenderRoot()`
        // returns `this`, so there is no wrapper element to hang `@click` on.
        this.addEventListener('mousedown', this._onPointerDown);
        this.addEventListener('click', this._onClick);
        this.#unsubscribe = branchStore.subscribe(() => {
            void this.#load(false);
        });
        void this.#load(true);
    }

    disconnectedCallback() {
        document.removeEventListener('keydown', this._onKeyDown, { capture: true });
        this.removeEventListener('mousedown', this._onPointerDown);
        this.removeEventListener('click', this._onClick);
        if (this.#unsubscribe) {
            this.#unsubscribe();
            this.#unsubscribe = null;
        }
        if (this.#resizeObserver) {
            this.#resizeObserver.disconnect();
            this.#resizeObserver = null;
        }
        if (this.#linesObserver) {
            this.#linesObserver.disconnect();
            this.#linesObserver = null;
            this.#linesObserved = null;
        }
        // Invalidate anything still in flight; a re-mount starts cold.
        this.#loadToken++;
        this.#forest = { roots: [], byId: new Map(), order: [] };
        this.#layout = { sections: [], total: 0, rowIndex: new Map(), visibleOrder: [] };
        this.#search = /** @type {SearchResult} */ (NO_SEARCH);
        this.#expanded.clear();
        this.#lineage = [];
        this.#pendingReveal = null;
        const focusTarget = this.#returnFocus;
        this.#returnFocus = null;
        if (focusTarget instanceof HTMLElement && focusTarget.isConnected) {
            focusTarget.focus({ preventScroll: true });
        }
        super.disconnectedCallback();
    }

    firstUpdated() {
        const scroller = this.querySelector('.k-bm-scroll');
        if (scroller instanceof HTMLElement) {
            this.#viewportH = scroller.clientHeight || window.innerHeight;
            if (typeof ResizeObserver === 'function') {
                this.#resizeObserver = new ResizeObserver((entries) => {
                    const height = entries[0]?.contentRect?.height ?? 0;
                    if (height > 0 && height !== this.#viewportH) {
                        this.#viewportH = height;
                        this.#syncWindow(true);
                    }
                });
                this.#resizeObserver.observe(scroller);
            }
            this.#syncWindow(true);
        }
        this.focusSearch();
    }

    updated() {
        this.#observeLines();
        if (this.#pendingReveal !== null) {
            const id = this.#pendingReveal;
            this.#pendingReveal = null;
            this.#scrollRowIntoView(id);
        }
    }

    /**
     * The lines pane is created and destroyed with the view, so its width
     * observer follows whichever pane element currently exists.
     * @returns {void}
     */
    #observeLines() {
        const pane = this.querySelector('.k-bm-lines');
        if (pane === this.#linesObserved) {
            return;
        }
        this.#linesObserver?.disconnect();
        this.#linesObserved = pane;
        if (!pane || typeof ResizeObserver !== 'function') {
            return;
        }
        this.#linesObserver ??= new ResizeObserver((entries) => {
            const width = Math.floor(entries[0]?.contentRect?.width ?? 0);
            if (width <= 0 || width === this._linesW) {
                return;
            }
            // Safety net under `scrollbar-gutter: stable`: a width that returns to the value it
            // left moments ago is the signature of a layout <-> scrollbar loop, not a resize.
            // Hold the current width instead of feeding it.
            const now = performance.now();
            const flipBack = width === this.#linesPrevW && now - this.#linesChangedAt < 500;
            this.#linesPrevW = this._linesW;
            this.#linesChangedAt = now;
            if (flipBack) {
                console.debug('[k-branch-map] story-lines width flip-flop held at', this._linesW);
                return;
            }
            this._linesW = width;
        });
        this.#linesObserver.observe(pane);
    }

    /**
     * @param {'lines'|'list'} view
     * @returns {void}
     */
    #setView(view) {
        if (this._view === view) {
            return;
        }
        this._view = view;
        writeView(view);
        if (view === 'list' && this._selectedId) {
            this.#pendingReveal = this._selectedId;
        }
    }

    /** @returns {ForestNode|undefined} The story the lines view draws. */
    #storyRoot() {
        return this._storyId ? this.#forest.byId.get(this._storyId) : undefined;
    }

    /** @returns {string} A sensible story to open on: the active chat's, else the newest that branched. */
    #defaultStory() {
        if (this.#lineage.length > 0 && this.#forest.byId.has(this.#lineage[0])) {
            return this.#lineage[0];
        }
        const branched = this.#forest.roots.find(root => root.children.length > 0);
        return (branched ?? this.#forest.roots[0])?.id ?? '';
    }

    /** Moves focus to the search box. Also the `/` and Ctrl+F destination. */
    focusSearch() {
        const input = this.querySelector('.k-bm-search-input');
        if (input instanceof HTMLInputElement) {
            input.focus({ preventScroll: true });
            input.select();
        }
    }

    /**
     * Reads the store and rebuilds everything downstream of the tree.
     * @param {boolean} force Refetch instead of trusting the warm cache.
     * @returns {Promise<void>}
     */
    async #load(force) {
        if (inGroupChat()) {
            this.#applyEmptyState('group');
            return;
        }
        if (!hasCharacter()) {
            this.#applyEmptyState('nocharacter');
            return;
        }
        const token = ++this.#loadToken;
        if (this.#forest.order.length === 0) {
            this._status = 'loading';
        }
        const tree = await branchStore.tree(force);
        if (token !== this.#loadToken || !this.isConnected) {
            return;
        }
        this._build = tree.build;
        if (tree === EMPTY_TREE) {
            // The store hands back this exact frozen object for every failure
            // path *and* for "no character" — which we ruled out above. So here
            // it means the endpoint 404'd (no chat folder) or errored; either
            // way there is no index to show, and saying "no chats" would be a
            // guess. Identity comparison is the only signal available.
            this.#applyEmptyState('unavailable');
            return;
        }
        this.#forest = buildForest(tree);
        this.#geometry = null;
        this.#activeId = activeChatId();
        this.#lineage = this.#activeId ? branchStore.lineage(this.#activeId) : [];
        if (this.#activeId && this.#seededLineage !== this.#activeId) {
            this.#seededLineage = this.#activeId;
            // Only ever ADD: a reader who collapsed a branch keeps it collapsed
            // across a refresh; the active chain simply has to be visible once.
            for (let i = 0; i < this.#lineage.length - 1; i++) {
                this.#expanded.add(this.#lineage[i]);
            }
        }
        if (this._selectedId && !this.#forest.byId.has(this._selectedId)) {
            this._selectedId = '';
            this._renaming = false;
        }
        const story = this.#forest.byId.get(this._storyId);
        if (!story || story.parent) {
            // Gone, or a rename/adoption made it someone's child: draw from its root.
            this._storyId = story ? rootOf(story).id : this.#defaultStory();
        }
        this._status = this.#forest.order.length === 0 ? 'empty' : 'ready';
        this.#applySearch();
    }

    /**
     * @param {'unavailable'|'empty'|'nocharacter'|'group'} status Quiet state.
     * @returns {void}
     */
    #applyEmptyState(status) {
        this.#forest = { roots: [], byId: new Map(), order: [] };
        this.#layout = { sections: [], total: 0, rowIndex: new Map(), visibleOrder: [] };
        this.#search = /** @type {SearchResult} */ (NO_SEARCH);
        this._selectedId = '';
        this._renaming = false;
        this._status = status;
        this._revision++;
    }

    /** Recompiles the query, then relays out. Called per keystroke. */
    #applySearch() {
        this.#search = searchForest(this.#forest, compileQuery(this._query));
        this.#recompute();
        if (this.#search.active && this.#search.first) {
            this.#pendingReveal = this.#search.first;
            // In the lines view a hit in another story brings that story up.
            const hit = this.#forest.byId.get(this.#search.first);
            const story = this.#storyRoot();
            const storyHasMatch = story ? storyOrder(story).some(node => this.#search.matches.has(node.id)) : false;
            if (this._view === 'lines' && hit && !storyHasMatch) {
                this._storyId = rootOf(hit).id;
            }
        }
    }

    /** @returns {Set<string>} User expansions plus whatever the search forces open. */
    #effectiveExpanded() {
        if (!this.#search.active || this.#search.expand.size === 0) {
            return this.#expanded;
        }
        const merged = new Set(this.#expanded);
        for (const id of this.#search.expand) {
            merged.add(id);
        }
        return merged;
    }

    /** @returns {MapGeometry} Row metrics, read from CSS so packs can restyle. */
    #readGeometry() {
        if (this.#geometry) {
            return this.#geometry;
        }
        /** @type {MapGeometry} */
        let geometry = { ...GEOMETRY_FALLBACK };
        try {
            const style = getComputedStyle(this);
            /**
             * @param {string} name
             * @param {number} fallback
             * @returns {number}
             */
            const read = (name, fallback) => {
                const value = Number.parseFloat(style.getPropertyValue(name));
                return Number.isFinite(value) && value > 0 ? value : fallback;
            };
            geometry = {
                rowHeight: read('--k-bm-row-h', GEOMETRY_FALLBACK.rowHeight),
                sectionGap: read('--k-bm-section-gap', GEOMETRY_FALLBACK.sectionGap),
                indent: read('--k-bm-indent', GEOMETRY_FALLBACK.indent),
                stem: read('--k-bm-stem', GEOMETRY_FALLBACK.stem),
            };
        } catch (error) {
            console.debug('[k-branch-map] CSS metrics unavailable, using fallbacks', error);
        }
        this.#geometry = geometry;
        return geometry;
    }

    /** Rebuilds the section layout and republishes it to the renderer. */
    #recompute() {
        this.#layout = buildSections(this.#forest.roots, this.#effectiveExpanded(), this.#readGeometry());
        this.#syncWindow(true);
        this._revision++;
    }

    /**
     * Recomputes which sections are inside the viewport.
     * @param {boolean} force Publish even when the range did not move.
     * @returns {void}
     */
    #syncWindow(force) {
        const sections = this.#layout.sections;
        const start = firstSectionAt(sections, this.#scrollTop - OVERSCAN_PX);
        const limit = this.#scrollTop + this.#viewportH + OVERSCAN_PX;
        let end = start;
        while (end < sections.length && sections[end].top < limit) {
            end++;
        }
        if (force || start !== this._winStart || end !== this._winEnd) {
            this._winStart = start;
            this._winEnd = end;
        }
    }

    /**
     * @param {Event} event Scroll event from the canvas.
     * @returns {void}
     */
    #onScroll(event) {
        const scroller = event.currentTarget;
        if (!(scroller instanceof HTMLElement)) {
            return;
        }
        this.#scrollTop = scroller.scrollTop;
        this.#syncWindow(false);
    }

    /**
     * Puts a row on screen without measuring the DOM: fixed row heights make the
     * target offset arithmetic, which is also why this works for a row that is
     * not currently rendered.
     * @param {string} id Chat id.
     * @returns {void}
     */
    #scrollRowIntoView(id) {
        const place = this.#layout.rowIndex.get(id);
        const scroller = this.querySelector('.k-bm-scroll');
        if (!place || !(scroller instanceof HTMLElement)) {
            return;
        }
        const geometry = this.#readGeometry();
        const section = this.#layout.sections[place[0]];
        const top = section.top + place[1] * geometry.rowHeight;
        const bottom = top + geometry.rowHeight;
        const viewTop = scroller.scrollTop;
        const viewBottom = viewTop + scroller.clientHeight;
        if (top < viewTop + geometry.rowHeight) {
            scroller.scrollTop = Math.max(0, top - geometry.rowHeight * 2);
        } else if (bottom > viewBottom - geometry.rowHeight) {
            scroller.scrollTop = bottom - scroller.clientHeight + geometry.rowHeight * 2;
        } else {
            return;
        }
        this.#scrollTop = scroller.scrollTop;
        this.#syncWindow(false);
    }

    /**
     * @param {string} id Chat id.
     * @param {boolean} [reveal] Scroll the row into view.
     * @returns {void}
     */
    #select(id, reveal = false) {
        if (this._selectedId !== id) {
            this._selectedId = id;
            this._renaming = false;
            this._renameError = '';
        }
        if (reveal) {
            this.#pendingReveal = id;
        }
    }

    /**
     * @param {string} id Chat id.
     * @param {boolean} [open] Force a state instead of toggling.
     * @returns {void}
     */
    #toggle(id, open) {
        const node = this.#forest.byId.get(id);
        if (!node || node.children.length === 0) {
            return;
        }
        const next = open ?? !this.#effectiveExpanded().has(id);
        if (next) {
            this.#expanded.add(id);
        } else {
            this.#expanded.delete(id);
            // A search-forced expansion has to be released too, or a collapse
            // would visibly do nothing while a query is in force. Guarded on
            // `active` because the inactive result is the shared NO_SEARCH
            // singleton, whose sets belong to no one.
            if (this.#search.active) {
                this.#search.expand.delete(id);
            }
        }
        this.#recompute();
    }

    /**
     * @param {number} delta -1 for the row above, +1 for the row below.
     * @returns {void}
     */
    #move(delta) {
        const story = this._view === 'lines' ? this.#storyRoot() : undefined;
        const order = story ? storyOrder(story).map(node => node.id) : this.#layout.visibleOrder;
        if (order.length === 0) {
            return;
        }
        const current = order.indexOf(this._selectedId);
        const next = current === -1
            ? (delta > 0 ? 0 : order.length - 1)
            : Math.min(order.length - 1, Math.max(0, current + delta));
        this.#select(order[next], true);
    }

    /**
     * Escape / arrows / Enter / F2 / Delete / `/` / Ctrl+F.
     *
     * Runs in the capture phase on `document`, so it must be a good citizen:
     * it stands down entirely while a core popup (our own delete confirm
     * included) is on screen, and it only consumes keys it actually acts on.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleKey(event) {
        if (!this.isConnected || corePopupOpen()) {
            return;
        }
        const target = event.target;
        const inRename = target instanceof HTMLInputElement && target.classList.contains('k-bm-rename-input');
        const inText = isTextEntry(target);

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (this._renaming) {
                this._renaming = false;
                this._renameError = '';
                return;
            }
            if (this._selectedId) {
                this._selectedId = '';
                return;
            }
            this.close();
            return;
        }

        if (inRename) {
            // The rename input owns everything else, Enter included (its own
            // handler commits); nothing here may steal a Delete keypress from it.
            return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            this.#move(event.key === 'ArrowDown' ? 1 : -1);
            return;
        }

        if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            const id = this._selectedId || (this.#search.active ? this.#search.first : '');
            if (id) {
                event.preventDefault();
                event.stopPropagation();
                void this.#openChat(id);
            }
            return;
        }

        if (inText) {
            // Everything below would eat a character out of the search box.
            if ((event.key === 'f' || event.key === 'F') && event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                event.stopPropagation();
                this.focusSearch();
            }
            return;
        }

        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            this.#walk(event.key === 'ArrowRight');
            return;
        }

        if (this.#showingLines() && !event.ctrlKey && !event.altKey && !event.metaKey
            && (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '0')) {
            event.preventDefault();
            event.stopPropagation();
            this.#setZoom(event.key === '0' ? 1 : this._zoom * (event.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP));
            return;
        }

        if (event.key === 'F2') {
            if (this._selectedId) {
                event.preventDefault();
                event.stopPropagation();
                this.#startRename();
            }
            return;
        }

        if (event.key === 'Delete') {
            if (this._selectedId) {
                event.preventDefault();
                event.stopPropagation();
                void this.#deleteChat(this._selectedId);
            }
            return;
        }

        if (event.key === '/' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            event.stopPropagation();
            this.focusSearch();
            return;
        }

        if ((event.key === 'f' || event.key === 'F') && event.ctrlKey && !event.shiftKey && !event.altKey) {
            // The forest is virtualized, so the browser's own find would only
            // ever search the ~40 rows currently in the DOM. Claiming the key
            // for a search that covers all 800 is the honest trade.
            event.preventDefault();
            event.stopPropagation();
            this.focusSearch();
        }
    }

    /**
     * Left/Right: expand or step in, collapse or step out.
     * @param {boolean} forward True for ArrowRight.
     * @returns {void}
     */
    #walk(forward) {
        const node = this._selectedId ? this.#forest.byId.get(this._selectedId) : undefined;
        if (!node) {
            this.#move(forward ? 1 : -1);
            return;
        }
        if (this._view === 'lines') {
            // No expand state to toggle on a map that draws everything: step along the tree.
            const next = forward ? node.children[0] : node.parent;
            if (next) {
                this.#select(next.id);
            }
            return;
        }
        const expanded = this.#effectiveExpanded().has(node.id);
        if (forward) {
            if (node.children.length > 0 && !expanded) {
                this.#toggle(node.id, true);
            } else if (node.children.length > 0) {
                this.#select(node.children[0].id, true);
            }
            return;
        }
        if (node.children.length > 0 && expanded) {
            this.#toggle(node.id, false);
        } else if (node.parent) {
            this.#select(node.parent.id, true);
        }
    }

    /**
     * @param {string} id Chat id.
     * @returns {Promise<void>}
     */
    async #openChat(id) {
        if (!id || this._busy) {
            return;
        }
        this._busy = true;
        try {
            await branchStore.switchTo(id);
        } finally {
            this._busy = false;
        }
        this.close();
    }

    /** Puts the card's title into an inline text input. */
    #startRename() {
        if (!this._selectedId) {
            return;
        }
        this._renameError = '';
        this._renaming = true;
        this.updateComplete.then(() => {
            const input = this.querySelector('.k-bm-rename-input');
            if (input instanceof HTMLInputElement) {
                input.focus();
                input.select();
            }
        }).catch(() => { /* the card went away mid-render; nothing to focus */ });
    }

    /**
     * @param {string} value Requested name.
     * @returns {Promise<void>}
     */
    async #commitRename(value) {
        const id = this._selectedId;
        const requested = String(value ?? '').trim();
        if (!id || this._busy) {
            return;
        }
        if (!requested || requested === id) {
            this._renaming = false;
            this._renameError = '';
            return;
        }
        this._busy = true;
        let finalName = null;
        try {
            finalName = await branchStore.rename(id, requested);
        } finally {
            this._busy = false;
        }
        if (!finalName) {
            // The store already logged the cause once; the reader gets the
            // quiet version rather than a toast stack.
            this._renameError = 'Rename declined. The name may be taken, or differ only by case.';
            return;
        }
        this._renaming = false;
        this._renameError = '';
        if (this.#expanded.delete(id)) {
            this.#expanded.add(finalName);
        }
        this._selectedId = finalName;
        this.#seededLineage = '';
        this.#pendingReveal = finalName;
        // The store's own refresh notifies us; nothing to reload by hand.
    }

    /**
     * Delete behind core's confirm popup.
     *
     * The popup content is built as an ELEMENT, not a string: `Popup` assigns a
     * string body straight to `innerHTML` (popup.js:534), and a chat name is
     * user data that can legally contain markup.
     * @param {string} id Chat id.
     * @returns {Promise<void>}
     */
    async #deleteChat(id) {
        const node = this.#forest.byId.get(id);
        if (!node || this._busy) {
            return;
        }
        const body = document.createElement('div');
        const heading = document.createElement('h3');
        heading.textContent = 'Delete chat';
        const name = document.createElement('p');
        name.className = 'k-bm-confirm-name';
        name.textContent = id;
        const note = document.createElement('p');
        note.textContent = node.children.length > 0
            ? `${node.children.length} branch${node.children.length === 1 ? '' : 'es'} of this chat will survive as unlinked roots.`
            : 'This cannot be undone.';
        body.append(heading, name, note);

        const result = await callGenericPopup(body, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Delete',
            cancelButton: 'Cancel',
            defaultResult: POPUP_RESULT.NEGATIVE,
        });
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        this._busy = true;
        try {
            await branchStore.delete(id);
        } finally {
            this._busy = false;
        }
        this._selectedId = '';
    }

    /**
     * @param {string} id Chat id.
     * @returns {Promise<void>}
     */
    async #copyName(id) {
        const ok = await copyText(id);
        this._renameError = ok ? '' : 'Copy failed; the browser refused clipboard access.';
    }

    /** Removes the overlay. `disconnectedCallback` is the whole teardown. */
    close() {
        this.remove();
    }

    /**
     * Backdrop click.
     *
     * Both ends of the gesture must have been on the backdrop. A click's target
     * is the nearest common ancestor of press and release, so a drag that starts
     * on a row and releases past the sheet's edge — the ordinary way a reader
     * selects text — would otherwise report the host and close the map under
     * them.
     * @param {MouseEvent} event Click on the host.
     * @returns {void}
     */
    #onBackdrop(event) {
        const pressed = this.#pressedBackdrop;
        this.#pressedBackdrop = false;
        if (pressed && event.target === this) {
            this.close();
        }
    }

    render() {
        return html`
            <div class="k-bm-sheet">
                ${this.#renderHeader()}
                <div class="k-bm-body">
                    ${this.#renderForest()}
                    ${this.#showingLines() ? this.#renderLines() : nothing}
                    ${this.#renderCard()}
                </div>
                ${this.#renderFooter()}
            </div>`;
    }

    /** @returns {unknown} Title row, search box, close button. */
    #renderHeader() {
        return html`
            <header class="k-bm-head">
                <span class="k-bm-title">${icons.branch}<span class="k-bm-title-text">Branch map</span></span>
                <label class="k-bm-search" aria-label="Search branches">
                    ${icons.search}
                    <input
                        class="k-bm-search-input"
                        type="search"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="Filter by name, preview, checkpoint or date"
                        .value=${this._query}
                        @input=${(/** @type {Event} */ e) => this.#onQuery(e)}
                    >
                </label>
                ${this.#showingLines() ? this.#renderStoryPicker() : html`<span class="k-bm-count">${this.#renderCount()}</span>`}
                <div class="k-bm-views" role="group" aria-label="View">
                    <button type="button" class="k-bm-view${this._view === 'lines' ? ' is-on' : ''}"
                        aria-pressed=${this._view === 'lines' ? 'true' : 'false'}
                        @click=${() => this.#setView('lines')}>Story lines</button>
                    <button type="button" class="k-bm-view${this._view === 'list' ? ' is-on' : ''}"
                        aria-pressed=${this._view === 'list' ? 'true' : 'false'}
                        @click=${() => this.#setView('list')}>List</button>
                </div>
                <button type="button" class="k-bm-close" title="Close (Escape)" aria-label="Close branch map"
                    @click=${() => this.close()}>${icons.close}</button>
            </header>`;
    }

    /** @returns {boolean} Whether the story-lines pane replaces the list right now. */
    #showingLines() {
        return this._view === 'lines' && this._status === 'ready' && Boolean(this.#storyRoot());
    }

    /** @returns {unknown} Which story the lines view draws: every root that ever branched. */
    #renderStoryPicker() {
        const name = characterName();
        const current = this._storyId;
        const roots = this.#forest.roots.filter(root => root.children.length > 0 || root.id === current);
        return html`
            <label class="k-bm-story">
                <span class="k-bm-story-label">Story</span>
                <select class="k-bm-story-select" aria-label="Story to draw"
                    @change=${(/** @type {Event} */ e) => {
        const target = e.target;
        if (target instanceof HTMLSelectElement) {
            this._storyId = target.value;
            this._selectedId = '';
        }
    }}>
                    ${roots.map(root => {
        const size = storyOrder(root).length;
        return html`<option value=${root.id} ?selected=${root.id === current}>${displayName(root.id, name)} · ${size} chat${size === 1 ? '' : 's'}</option>`;
    })}
                </select>
            </label>`;
    }

    /** @returns {unknown} Honest node/match counts, or nothing. */
    #renderCount() {
        const total = this.#forest.order.length;
        if (total === 0) {
            return nothing;
        }
        if (this.#search.active) {
            return html`${this.#search.matches.size} of ${total}`;
        }
        return html`${total} chat${total === 1 ? '' : 's'} · ${this.#forest.roots.length} root${this.#forest.roots.length === 1 ? '' : 's'}`;
    }

    /**
     * @param {Event} event Input event from the search box.
     * @returns {void}
     */
    #onQuery(event) {
        const input = event.target;
        this._query = input instanceof HTMLInputElement ? input.value : '';
        this.#applySearch();
    }

    /**
     * The virtualized scroll canvas, or a quiet state.
     *
     * ONE template for both, with the state expressed as a class rather than as
     * a second `html` tag. Two templates would make Lit tear the scroller out
     * and build a new one on every status flip, which would leave the
     * `ResizeObserver` from `firstUpdated()` watching a detached node — the
     * viewport height would then freeze at its boot value and the windowing
     * would quietly render the wrong band.
     * @returns {unknown} The scroller.
     */
    #renderForest() {
        const ready = this._status === 'ready';
        // Hidden, never removed, in the lines view: the ResizeObserver from
        // `firstUpdated()` must keep watching this exact node (see above).
        return html`
            <div class="k-bm-scroll${ready ? '' : ' k-bm-scroll--quiet'}" ?hidden=${this.#showingLines()}
                @scroll=${(/** @type {Event} */ e) => this.#onScroll(e)}>
                ${ready ? html`
                    <div class="k-bm-canvas" role="tree" aria-label="Branch forest"
                        style="height:${this.#layout.total}px">
                        ${this.#layout.sections.slice(this._winStart, this._winEnd).map(section => this.#renderSection(section))}
                    </div>` : this.#renderQuiet()}
            </div>`;
    }

    /** @returns {unknown} Loading / empty / unavailable / out-of-scope copy. */
    #renderQuiet() {
        if (this._status === 'group') {
            return this.#quiet('Not available for group chats.', 'Branching is a single-character feature in v0.');
        }
        if (this._status === 'nocharacter') {
            return this.#quiet('No character selected.', 'Pick a character to see its branch forest.');
        }
        if (this._status === 'unavailable') {
            return html`
                <div class="k-bm-quiet">
                    <span class="k-bm-quiet-title">Branch index unavailable.</span>
                    <span class="k-bm-quiet-note">The tree endpoint did not answer for this character.</span>
                    <button type="button" class="k-bm-action" @click=${() => this.#load(true)}>Retry</button>
                </div>`;
        }
        if (this._status === 'empty') {
            return this.#quiet('No chats yet.', 'The forest fills in as soon as this character has a chat file.');
        }
        // Loading. The only file count we may print is one the server reported
        // on a previous build; before that there is no number to be honest with.
        const cold = this._build && !this._build.fromCache ? this._build.scannedFiles : 0;
        return this.#quiet(
            cold > 0 ? `Indexing ${cold} files…` : 'Reading branch index…',
            'First build streams every chat file once; later opens are a stat sweep.');
    }

    /**
     * @param {string} title Headline.
     * @param {string} note Supporting line.
     * @returns {unknown} A muted, non-interactive block.
     */
    #quiet(title, note) {
        return html`
            <div class="k-bm-quiet">
                <span class="k-bm-quiet-title">${title}</span>
                <span class="k-bm-quiet-note">${note}</span>
            </div>`;
    }

    /**
     * The story-lines pane: one story as transit lines. The x axis is the
     * message index, so a branch leaves its parent's line exactly at its fork.
     * @returns {unknown}
     */
    #renderLines() {
        const root = this.#storyRoot();
        const name = characterName();
        const width = Math.round((this._linesW || 960) * this._zoom);
        const layout = layoutStory(root, width);
        const searching = this.#search.active;
        const active = layout.lines.find(line => line.node.id === this.#activeId);
        /** @param {string} id @returns {string} */
        const dim = id => (searching && !this.#search.matches.has(id) ? ' is-dim' : '');

        return html`
            <div class="k-bm-lines-wrap">
            <div class="k-bm-lines" role="group" aria-label="Story lines" tabindex="-1"
                @pointerdown=${(/** @type {PointerEvent} */ e) => this.#panStart(e)}
                @pointermove=${(/** @type {PointerEvent} */ e) => this.#panMove(e)}
                @pointerup=${(/** @type {PointerEvent} */ e) => this.#panEnd(e)}
                @pointercancel=${(/** @type {PointerEvent} */ e) => this.#panEnd(e)}
                @contextmenu=${(/** @type {MouseEvent} */ e) => this.#onLinesMenu(e)}
                @wheel=${{ handleEvent: (/** @type {WheelEvent} */ e) => this.#onLinesWheel(e), passive: false }}>
                <div class="k-bm-lines-canvas${layout.dense ? ' is-dense' : ''}" style="width:${layout.extent}px;height:${layout.height}px">
                    <div class="k-bm-lines-axis" aria-hidden="true">
                        ${layout.ticks.map(tick => html`<span class="k-bm-lines-tick" style="left:${tick.x}px">${tick.label}</span>`)}
                    </div>
                    <svg class="k-bm-lines-svg" width=${layout.extent} height=${layout.height}
                        viewBox="0 0 ${layout.extent} ${layout.height}" aria-hidden="true" focusable="false">
                        ${layout.ticks.map(tick => svg`<path class="k-bm-lines-grid" d="M${tick.x} 34V${layout.height}" />`)}
                        ${active ? svg`<path class="k-bm-line-glow is-hue-${active.hue}" d=${active.d} />` : nothing}
                        ${layout.lines.map(line => svg`<path class="k-bm-line is-hue-${line.hue}${line.unknownFork ? ' is-unknown' : ''}${dim(line.node.id)}" d=${line.d} />`)}
                        ${layout.lines.map(line => line.parentY === null
        ? svg`<circle class="k-bm-stop is-hue-${line.hue}${dim(line.node.id)}" cx=${line.x0} cy=${line.y} r="6" />`
        : svg`<circle class="k-bm-fork-dot is-hue-${line.hue}${dim(line.node.id)}" cx=${line.x0} cy=${line.parentY} r="5.5" />`)}
                        ${layout.lines.flatMap(line => line.checkpoints.map(cp => svg`
                            <rect class="k-bm-cp-mark${dim(line.node.id)}" x=${cp.x - 5} y=${line.y - 5} width="10" height="10"
                                transform="rotate(45 ${cp.x} ${line.y})"><title>${cp.name || 'Checkpoint'} · #${cp.mesIndex}</title></rect>`))}
                        ${layout.lines.filter(line => line.leader).map(line => svg`<path class="k-bm-leader is-hue-${line.hue}${dim(line.node.id)}" d="M${line.x1 + 9} ${line.y} L${line.stationX - 2} ${line.stationY}" />`)}
                        ${layout.lines.map(line => svg`<circle class="k-bm-end is-hue-${line.hue}${line.node.id === this.#activeId ? ' is-active' : ''}${dim(line.node.id)}" cx=${line.x1} cy=${line.y} r="8" />`)}
                    </svg>
                    ${layout.lines.map(line => this.#renderForkChip(line, dim(line.node.id)))}
                    ${layout.lines.map(line => this.#renderStation(line, name, dim(line.node.id)))}
                </div>
            </div>
            <div class="k-bm-zoom" role="group" aria-label="Zoom">
                <button type="button" class="k-bm-zoom-btn" aria-label="Zoom out" title="Zoom out (-)"
                    ?disabled=${this._zoom <= ZOOM_MIN} @click=${() => this.#setZoom(this._zoom / ZOOM_STEP)}>−</button>
                <button type="button" class="k-bm-zoom-btn k-bm-zoom-level" title="Fit to width (0)"
                    @click=${() => this.#setZoom(1)}>${Math.round(this._zoom * 100)}%</button>
                <button type="button" class="k-bm-zoom-btn" aria-label="Zoom in" title="Zoom in (+)"
                    ?disabled=${this._zoom >= ZOOM_MAX} @click=${() => this.#setZoom(this._zoom * ZOOM_STEP)}>+</button>
            </div>
            </div>`;
    }

    /**
     * Stretches the message axis. Keeps the point under the cursor (or the
     * pane's centre) where it was, so zooming reads as moving in, not jumping.
     * @param {number} next Requested zoom.
     * @param {number} [anchorClientX] Viewport x to hold still.
     * @returns {void}
     */
    #setZoom(next, anchorClientX) {
        const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
        if (zoom === this._zoom) {
            return;
        }
        const pane = this.querySelector('.k-bm-lines');
        const before = this._zoom;
        let held = -1;
        let offset = 0;
        if (pane instanceof HTMLElement) {
            const rect = pane.getBoundingClientRect();
            offset = (anchorClientX ?? rect.left + rect.width / 2) - rect.left;
            held = pane.scrollLeft + offset;
        }
        this._zoom = zoom;
        this.updateComplete.then(() => {
            if (pane instanceof HTMLElement && pane.isConnected && held >= 0) {
                pane.scrollLeft = Math.max(0, held * (zoom / before) - offset);
            }
        }).catch(() => { /* the pane went away mid-zoom */ });
    }

    /**
     * Ctrl+wheel zooms (and keeps the browser's page zoom out of it); a plain
     * wheel scrolls as usual, Shift+wheel sideways.
     * @param {WheelEvent} event
     * @returns {void}
     */
    #onLinesWheel(event) {
        if (!event.ctrlKey) {
            return;
        }
        event.preventDefault();
        this.#setZoom(this._zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), event.clientX);
    }

    /** @param {EventTarget|null} target @returns {boolean} Whether a press there belongs to a control, not the map. */
    #isControl(target) {
        return target instanceof Element && Boolean(target.closest('.k-bm-station, .k-bm-forkchip, .k-bm-zoom, button, a, input, select'));
    }

    /**
     * Drag-to-pan from the map's background, with the left or right button.
     * Only scroll offsets move: no relayout, no re-render.
     * @param {PointerEvent} event
     * @returns {void}
     */
    #panStart(event) {
        if ((event.button !== 0 && event.button !== 2) || this.#isControl(event.target)) {
            return;
        }
        const pane = event.currentTarget;
        if (!(pane instanceof HTMLElement)) {
            return;
        }
        this.#pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: pane.scrollLeft, top: pane.scrollTop };
        pane.setPointerCapture(event.pointerId);
        // Grabbing the map hands it the keyboard (+ / − / 0 zoom), which the
        // search box otherwise keeps: there those keys are just characters.
        pane.focus({ preventScroll: true });
        pane.classList.add('is-panning');
        event.preventDefault();
    }

    /** @param {PointerEvent} event */
    #panMove(event) {
        const pan = this.#pan;
        const pane = event.currentTarget;
        if (!pan || pan.id !== event.pointerId || !(pane instanceof HTMLElement)) {
            return;
        }
        pane.scrollLeft = pan.left - (event.clientX - pan.x);
        pane.scrollTop = pan.top - (event.clientY - pan.y);
    }

    /** @param {PointerEvent} event */
    #panEnd(event) {
        const pane = event.currentTarget;
        if (!this.#pan || this.#pan.id !== event.pointerId) {
            return;
        }
        this.#pan = null;
        if (pane instanceof HTMLElement) {
            pane.classList.remove('is-panning');
            if (pane.hasPointerCapture(event.pointerId)) {
                pane.releasePointerCapture(event.pointerId);
            }
        }
    }

    /**
     * The map's background is a canvas you drag, so its right button pans
     * instead of opening the browser menu. Stations and pills keep theirs.
     * @param {MouseEvent} event
     * @returns {void}
     */
    #onLinesMenu(event) {
        if (!this.#isControl(event.target)) {
            event.preventDefault();
        }
    }

    /**
     * The line the reader wrote where this branch left its parent.
     * @param {import('./story-model.js').StoryLine} line
     * @param {string} dim
     * @returns {unknown}
     */
    #renderForkChip(line, dim) {
        if (!line.chip) {
            return nothing;
        }
        const text = line.node.forkPreview?.child ?? '';
        const fork = line.node.forkIndex;
        return html`
            <span class="k-bm-forkchip is-hue-${line.hue}${dim}${text ? '' : ' is-empty'}"
                style="left:${line.chip.x}px;top:${line.y + STORY_GEOMETRY.chipTop}px;max-inline-size:${line.chip.w}px"
                title=${text ? `Message #${fork} on this path` : 'Nothing written after the split yet'}>
                <span class="k-bm-forkchip-at">#${fork}</span>
                ${text ? html`<span class="k-bm-forkchip-text">“${clip(text, 64)}”</span>` : html`<span class="k-bm-forkchip-text">not continued yet</span>`}
            </span>`;
    }

    /**
     * End-of-line card: where this path is now.
     * @param {import('./story-model.js').StoryLine} line
     * @param {string} name Character name, for the display title.
     * @param {string} dim
     * @returns {unknown}
     */
    #renderStation(line, name, dim) {
        const node = line.node;
        const active = node.id === this.#activeId;
        const selected = node.id === this._selectedId;
        const count = Number.isFinite(node.file?.messageCount) ? node.file.messageCount : null;
        const relative = toRelative(node.lastMs);
        const preview = typeof node.file?.leafPreview === 'string' ? node.file.leafPreview : '';
        const meta = [count === null ? '' : `${count} message${count === 1 ? '' : 's'}`, relative].filter(Boolean).join(' · ');
        // A branch too short for its chip carries the fork line in its card instead.
        const forkInCard = line.parentY !== null && !line.unknownFork && !line.chip;
        const forkText = forkInCard ? (node.forkPreview?.child ?? '') : '';
        return html`
            <button type="button"
                class="k-bm-station is-hue-${line.hue}${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${dim}"
                style="left:${line.stationX}px;top:${line.stationY}px"
                title=${node.id}
                aria-pressed=${selected ? 'true' : 'false'}
                @click=${() => this.#select(node.id)}
                @dblclick=${() => this.#openChat(node.id)}>
                <span class="k-bm-station-head">
                    <span class="k-bm-station-title">${displayName(node.id, name)}</span>
                    ${active ? html`<span class="k-bm-here">You are here</span>` : nothing}
                    ${line.parentY === null && node.children.length > 0 ? html`<span class="k-bm-station-tag">original</span>` : nothing}
                </span>
                ${forkInCard ? html`
                    <span class="k-bm-station-fork">
                        <span class="k-bm-forkchip-at">#${node.forkIndex}</span>
                        <span class="k-bm-station-fork-text">${forkText ? `“${clip(forkText, 60)}”` : 'not continued yet'}</span>
                    </span>` : nothing}
                ${preview ? html`<span class="k-bm-station-preview${forkInCard ? ' is-short' : ''}">${clip(preview, 96)}</span>` : nothing}
                ${meta ? html`<span class="k-bm-station-meta">${meta}</span>` : nothing}
            </button>`;
    }

    /**
     * @param {MapSection} section One root's subtree.
     * @returns {unknown} An absolutely positioned section block.
     */
    #renderSection(section) {
        const geometry = this.#readGeometry();
        if (section.paths === null) {
            section.paths = sectionPaths(section.rows, geometry);
        }
        const height = section.rows.length * geometry.rowHeight;
        const width = geometry.stem + (1 + section.maxDepth) * geometry.indent;
        return html`
            <section class="k-bm-section" style="top:${section.top}px;height:${height}px">
                ${section.paths.length > 0 ? html`
                    <svg class="k-bm-links" width=${width} height=${height} viewBox="0 0 ${width} ${height}"
                        aria-hidden="true" focusable="false">
                        ${section.paths.map(path => svg`<path class="k-bm-link${path.adopted ? ' is-adopted' : ''}" d=${path.d} />`)}
                    </svg>` : nothing}
                ${section.rows.map(row => this.#renderRow(row, geometry))}
            </section>`;
    }

    /**
     * @param {MapRow} row Flattened row.
     * @param {MapGeometry} geometry Row metrics.
     * @returns {unknown} One chat row.
     */
    #renderRow(row, geometry) {
        const node = row.node;
        const active = node.id === this.#activeId;
        const lineage = this.#lineage.includes(node.id);
        const selected = node.id === this._selectedId;
        const dim = this.#search.active && !this.#search.matches.has(node.id);
        const hit = this.#search.active && this.#search.matches.has(node.id);
        const classes = [
            'k-bm-row',
            active ? 'is-active' : '',
            lineage ? 'is-lineage' : '',
            selected ? 'is-selected' : '',
            dim ? 'is-dim' : '',
            hit ? 'is-hit' : '',
        ].filter(Boolean).join(' ');
        const count = Number.isFinite(node.file?.messageCount) ? node.file.messageCount : null;
        const relative = toRelative(node.lastMs);
        const checkpoints = Array.isArray(node.file?.checkpoints) ? node.file.checkpoints.length : 0;
        const preview = typeof node.file?.leafPreview === 'string' ? node.file.leafPreview.slice(0, ROW_PREVIEW_CHARS) : '';

        return html`
            <div
                class=${classes}
                style="top:${row.index * geometry.rowHeight}px;padding-inline-start:${geometry.stem + row.depth * geometry.indent - MARKER_HALF}px"
                role="treeitem"
                aria-selected=${selected ? 'true' : 'false'}
                aria-expanded=${row.expandable ? String(row.expanded) : 'false'}
                title=${preview || node.id}
                @click=${() => this.#select(node.id)}
                @dblclick=${() => this.#openChat(node.id)}
            >
                ${row.expandable ? html`
                    <button type="button" class="k-bm-twist${row.expanded ? ' is-open' : ''}"
                        aria-label=${row.expanded ? 'Collapse' : 'Expand'}
                        @click=${(/** @type {MouseEvent} */ e) => { e.stopPropagation(); this.#toggle(node.id); }}>
                        <svg class="k-bm-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
                            stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
                            aria-hidden="true" focusable="false">${icons.chevron}</svg>
                    </button>` : html`<span class="k-bm-twist k-bm-twist--leaf" aria-hidden="true"></span>`}
                <span class="k-bm-name">${node.id}</span>
                ${node.forkIndex !== null ? html`<span class="k-bm-fork" title="Forked from the parent at message ${node.forkIndex}">@${node.forkIndex}</span>` : nothing}
                ${this.#renderForkNote(node)}
                ${node.via === 'adopted' ? html`<span class="k-bm-chip k-bm-chip--adopted" title="Re-linked by content match, not by a stored name">adopted</span>` : nothing}
                ${node.orphanName ? html`
                    <span class="k-bm-chip k-bm-chip--unlinked" title="Its stored parent name is not on disk">
                        ${icons.unlinked}unlinked<span class="k-bm-ghost">${node.orphanName}</span>
                    </span>` : nothing}
                ${checkpoints > 0 ? html`<span class="k-bm-chip k-bm-chip--checkpoint" title="${checkpoints} checkpoint${checkpoints === 1 ? '' : 's'}">${icons.checkpoint}${checkpoints}</span>` : nothing}
                ${count === null ? nothing : html`<span class="k-bm-meta k-bm-meta--count">${count}</span>`}
                ${relative ? html`<span class="k-bm-meta">${relative}</span>` : nothing}
            </div>`;
    }

    /**
     * The parent-side fork note, when one was ever persisted.
     *
     * Stock ST never saved `extra.branches[]` (see the store's header), so this
     * is absent on every pre-Kotatsu chat — expected, not a bug. Kotatsu's own
     * `fork()` starts populating it, and this line lights up for those.
     * @param {ForestNode} node Child node.
     * @returns {unknown} The note chip, or nothing.
     */
    #renderForkNote(node) {
        const note = this.#forkNote(node);
        return note ? html`<span class="k-bm-forknote" title="Parent-side fork note">${note}</span>` : nothing;
    }

    /**
     * @param {ForestNode} node Child node.
     * @returns {string} The parent's `branchNotes` entry at the fork index, or ''.
     */
    #forkNote(node) {
        if (!node.parent || node.forkIndex === null) {
            return '';
        }
        const notes = node.parent.file?.branchNotes;
        if (!Array.isArray(notes)) {
            return '';
        }
        for (const entry of notes) {
            if (entry && entry.mesIndex === node.forkIndex && typeof entry.name === 'string' && entry.name) {
                return entry.name;
            }
        }
        return '';
    }

    /** @returns {unknown} The node card, or nothing when no row is selected. */
    #renderCard() {
        const node = this._selectedId ? this.#forest.byId.get(this._selectedId) : undefined;
        if (!node) {
            return nothing;
        }
        const file = node.file;
        const count = Number.isFinite(file?.messageCount) ? file.messageCount : null;
        const checkpoints = Array.isArray(file?.checkpoints) ? file.checkpoints : [];
        const relative = toRelative(node.lastMs);
        const absolute = node.lastMs > 0 ? dateTimeFormatter.format(new Date(node.lastMs)) : '';
        const forkNote = this.#forkNote(node);

        return html`
            <aside class="k-bm-card" aria-label="Chat details">
                <div class="k-bm-card-head">
                    ${this._renaming ? html`
                        <input
                            class="k-bm-rename-input"
                            type="text"
                            .value=${node.id}
                            aria-label="New chat name"
                            @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onRenameKey(e)}
                            @blur=${(/** @type {FocusEvent} */ e) => this.#onRenameBlur(e)}
                        >` : html`<span class="k-bm-card-title">${node.id}</span>`}
                    <button type="button" class="k-bm-close" title="Close details" aria-label="Close details"
                        @click=${() => { this._selectedId = ''; this._renaming = false; }}>${icons.close}</button>
                </div>

                ${this._renameError ? html`<p class="k-bm-card-error" role="status">${this._renameError}</p>` : nothing}

                <dl class="k-bm-facts">
                    ${count === null ? nothing : html`<dt>Messages</dt><dd>${count}</dd>`}
                    ${file?.hasHeader === false ? html`<dt>Header</dt><dd>none (headerless file)</dd>` : nothing}
                    ${absolute ? html`<dt>Last activity</dt><dd>${absolute}${relative ? html` <span class="k-bm-dim">(${relative})</span>` : nothing}</dd>` : nothing}
                    ${node.parent ? html`
                        <dt>Forked from</dt>
                        <dd>
                            <button type="button" class="k-bm-link-btn" @click=${() => this.#select(node.parent ? node.parent.id : '', true)}>${node.parent.id}</button>
                            ${node.forkIndex !== null ? html` <span class="k-bm-dim">at message ${node.forkIndex}</span>` : nothing}
                            ${forkNote ? html`<span class="k-bm-forknote">${forkNote}</span>` : nothing}
                        </dd>` : nothing}
                    ${node.via === 'adopted' ? html`<dt>Provenance</dt><dd>adopted — re-linked by a shared content prefix, not by a stored name</dd>` : nothing}
                    ${node.orphanName ? html`<dt>Unlinked</dt><dd>Its stored parent <span class="k-bm-ghost">${node.orphanName}</span> is not on disk.</dd>` : nothing}
                    ${!node.parent && !node.orphanName ? html`<dt>Provenance</dt><dd>root chat</dd>` : nothing}
                    ${node.children.length > 0 ? html`<dt>Branches</dt><dd>${node.children.length}</dd>` : nothing}
                </dl>

                ${node.parent && node.forkPreview ? html`
                    <div class="k-bm-forkcmp">
                        <span class="k-bm-card-label">The fork${node.forkIndex !== null ? html` · #${node.forkIndex}` : nothing}</span>
                        <div class="k-bm-forkcmp-side">
                            <span class="k-bm-forkcmp-who">${displayName(node.parent.id, characterName())}</span>
                            <p class="k-bm-forkcmp-text">${node.forkPreview.parent || html`<span class="k-bm-dim">the story ended here</span>`}</p>
                        </div>
                        <div class="k-bm-forkcmp-side is-this">
                            <span class="k-bm-forkcmp-who">This path</span>
                            <p class="k-bm-forkcmp-text">${node.forkPreview.child || html`<span class="k-bm-dim">not continued yet</span>`}</p>
                        </div>
                    </div>` : nothing}

                ${checkpoints.length > 0 ? html`
                    <div class="k-bm-checkpoints">
                        <span class="k-bm-card-label">Checkpoints</span>
                        <ul>
                            ${checkpoints.map(cp => html`<li>${icons.checkpoint}<span class="k-bm-cp-name">${cp?.name ?? ''}</span><span class="k-bm-dim">@${cp?.mesIndex ?? '?'}</span></li>`)}
                        </ul>
                    </div>` : nothing}

                ${file?.leafPreview ? html`<p class="k-bm-preview">${file.leafPreview}</p>` : nothing}

                <div class="k-bm-actions">
                    <button type="button" class="k-bm-action k-bm-action--primary" ?disabled=${this._busy}
                        @click=${() => this.#openChat(node.id)}>Open</button>
                    <button type="button" class="k-bm-action" ?disabled=${this._busy}
                        @click=${() => this.#startRename()}>Rename</button>
                    <button type="button" class="k-bm-action k-bm-action--danger" ?disabled=${this._busy}
                        @click=${() => this.#deleteChat(node.id)}>Delete</button>
                    <button type="button" class="k-bm-action" @click=${() => this.#copyName(node.id)}>Copy name</button>
                </div>
            </aside>`;
    }

    /**
     * @param {KeyboardEvent} event Key inside the rename input.
     * @returns {void}
     */
    #onRenameKey(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            const input = event.target;
            if (input instanceof HTMLInputElement) {
                void this.#commitRename(input.value);
            }
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this._renaming = false;
            this._renameError = '';
        }
    }

    /**
     * @param {FocusEvent} event Blur of the rename input.
     * @returns {void}
     */
    #onRenameBlur(event) {
        // Commit-on-blur would rename on an accidental click; the reader gets
        // the input back the way they left it instead.
        const input = event.target;
        if (input instanceof HTMLInputElement && input.value.trim() === this._selectedId) {
            this._renaming = false;
        }
    }

    /** @returns {unknown} Build stats and the key legend. */
    #renderFooter() {
        const build = this._build;
        // Both spellings quote numbers the SERVER reported; neither is derived.
        const stats = !build
            ? ''
            : build.fromCache
                ? `index warm · ${build.ms} ms`
                : `indexed ${build.scannedFiles} file${build.scannedFiles === 1 ? '' : 's'} · ${build.ms} ms`;
        return html`
            <footer class="k-bm-foot">
                <span class="k-bm-foot-keys">
                    ${this.#showingLines()
        ? '↑↓ move · ←→ parent/branch · Enter open · F2 rename · Ctrl+wheel or +/− zoom · drag to pan · / search · Esc close'
        : '↑↓ move · ←→ collapse/expand · Enter open · F2 rename · Del delete · / search · Esc close'}
                </span>
                ${stats ? html`<span class="k-bm-foot-build" title="Reported by the tree endpoint">${stats}</span>` : nothing}
            </footer>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-branch-map')) {
    customElements.define('k-branch-map', KBranchMap);
}

/* ── The host: one document-level door, no permanently mounted element ────── */

/** @type {boolean} */
let installed = false;

/** @type {((event: Event) => void)|null} */
let onOpenRequest = null;

/** @type {((event: KeyboardEvent) => void)|null} */
let onHotkey = null;

/** @returns {KBranchMap|null} The mounted overlay, or null. */
function currentMap() {
    const element = document.querySelector('k-branch-map');
    return element instanceof KBranchMap ? element : null;
}

/**
 * Mounts the overlay. Creating it here (rather than parking a hidden element in
 * the document) is the leak answer: everything the component owns is torn down
 * by `disconnectedCallback`, and `close()` is a `remove()`.
 * @returns {void}
 */
export function openBranchMap() {
    if (currentMap()) {
        return;
    }
    const map = document.createElement('k-branch-map');
    map.setAttribute('variant', 'overlay');
    document.body.appendChild(map);
}

/** @returns {void} */
export function closeBranchMap() {
    currentMap()?.close();
}

/** @returns {void} */
export function toggleBranchMap() {
    const map = currentMap();
    if (map) {
        map.close();
    } else {
        openBranchMap();
    }
}

/**
 * Wires the two document-level doors: the `k-open-branch-map` event (the rail's
 * "Open map" row and the top bar both dispatch it) and {@link OPEN_HOTKEY}.
 * Idempotent — a shell reload must not stack a second pair.
 * @returns {void}
 */
export function installBranchMap() {
    if (installed) {
        return;
    }
    installed = true;
    onOpenRequest = () => toggleBranchMap();
    onHotkey = (event) => {
        if (event.key?.toLowerCase() !== OPEN_HOTKEY.key || !event.ctrlKey || !event.shiftKey || event.altKey) {
            return;
        }
        if (corePopupOpen()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        toggleBranchMap();
    };
    document.addEventListener(OPEN_BRANCH_MAP_EVENT, onOpenRequest);
    document.addEventListener('keydown', onHotkey, { capture: true });
}

/**
 * Removes every listener and node this module added. Symmetry for
 * {@link installBranchMap}; used by teardown paths and tests.
 * @returns {void}
 */
export function uninstallBranchMap() {
    if (!installed) {
        return;
    }
    installed = false;
    closeBranchMap();
    if (onOpenRequest) {
        document.removeEventListener(OPEN_BRANCH_MAP_EVENT, onOpenRequest);
        onOpenRequest = null;
    }
    if (onHotkey) {
        document.removeEventListener('keydown', onHotkey, { capture: true });
        onHotkey = null;
    }
}
