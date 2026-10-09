/**
 * `<k-tab-rail>` — the rails-layout right rail (shell v0 slice C, slimmed by
 * settings v0.1 slice G).
 *
 * Two tabs: **Prompt · Trackers**. Exactly one of them is a DOCK, and it is not a
 * screen — nothing in this file renders a settings panel. It relocates the panel
 * core already has and hosts it node-for-node:
 *
 *   Prompt → `#ai-config-button`         (wraps `#left-nav-panel`)
 *
 * **Why one dock.** World (`#WI-SP-button`) and Ext (`#extensions-settings-button`)
 * docked here through shell v0 (`docs/shell-v0.md` §"The target", now errata'd).
 * Settings v0.1 made the modal the configuration home and this rail the LIVE
 * surface (`docs/settings-v0.md` §9, slice plan §10): lorebooks bind per-character
 * and extensions are set-and-forget, so both moved into the settings modal. Their
 * drawers are not deleted and are not this component's business any more — they
 * stay PARKED in `#top-settings-holder` wearing their stock classes, exactly like
 * every other offstage drawer, and the modal is their only holder (recon §5 G1:
 * two holders for one node has no reconstruction path). The memory engine's
 * in-the-moment tweaks are what joins the strip next.
 *
 * Contracts this component honours:
 *
 * - **The `.drawer` wrapper moves, not just the panel.** `doNavbarIconClick()`
 *   (script.js:11284) resolves icon↔content purely by DOM relationship
 *   (`$(this).parent().find('.drawer-content')`), and `personas.js:124`-style
 *   predicates read `#<wrapper> .drawer-content`. Moving the wrapper keeps every
 *   one of those reads true; moving only the panel would break them silently.
 *   The wrapper's `.drawer-toggle` is hidden by `css/shell-right.css` — the icon
 *   is furniture in a rail, and a hidden element is not a tab stop.
 *
 * - **Docked state is `.openDrawer.pinnedOpen.k-docked`** (docs/shell-v0.md
 *   §"Docking mechanics"). `openDrawer` keeps core's visibility predicates true,
 *   `pinnedOpen` makes the click-outside autoclose (script.js:12525 —
 *   `$('.openDrawer').not('.pinnedOpen')`) spare docked panels for free, and
 *   `.k-docked` is the marker the three fork-owned patches in
 *   `scripts/RossAscends-mods.js` exclude.
 *
 * - **Reversibility.** Every moved wrapper records `{ parent, nextSibling }` and
 *   every class this component adds is remembered, so `disconnectedCallback()`
 *   puts `#top-settings-holder` back to its nine `.drawer` children in their
 *   original order. `layouts/rails.js` clears `#k-rail-right` on unmount, which
 *   disconnects this element — the restore is therefore the ONLY thing standing
 *   between a layout switch and one lost drawer.
 *
 * - **A collapsed rail is still this component's problem.** Under rail collapse
 *   (variant wardrobe v0 §3) the rail's interior goes `visibility: hidden` — no
 *   node moves, no class changes, so the docks below need no special case. The
 *   one thing that does: an external request to bring a dock forward also asks
 *   for the rail back (`#requestRail()`), so a `.drawer-opener` click can never
 *   be a dead click.
 *
 * - **Tab switching is a class toggle, never a re-relocation.** A panel is moved
 *   exactly once per mount. Re-parenting on every tab click would re-run layout
 *   and, worse, would tear iframes/canvases inside extensions out of the document.
 *
 * - **Light DOM.** `createRenderRoot()` returns `this`, so `css/shell-right.css`
 *   reaches both the tab strip and the docked panels, and `initDynamicStyles()`
 *   (dynamic-styles.js:188-202) can see the hover/focus-visible pairs it audits.
 *   A shadow root would also cut the docked panels off from every core stylesheet
 *   they depend on, which alone rules it out.
 *
 * - **SPEC §13 variant attribute** — `variant="tabs"` is the only v0 variant; the
 *   attribute is present anyway so a pack can address a second one later.
 *
 * - **No fabricated data.** The "Active instruction payload" card from the mockup
 *   is NOT rendered. The only free total is `promptManager.tokenUsage`
 *   (`openai.js:530` exports the manager, `PromptManager.js:1589` sets the field),
 *   and it is `0` until the first dry run, absent entirely for every non-`openai`
 *   `main_api` (`PromptManager.js:863` bails early), and refreshed inside an
 *   un-awaited `.finally()` after a debounced dry run with no completion event —
 *   so any event a card could listen to fires *before* the number moves. Core
 *   already prints the same figure at the top of the docked Prompt panel
 *   ("Total Tokens:", `templates/promptManagerHeader.html`), so the rail loses
 *   nothing by declining to guess.
 *
 * Trackers hosts `<k-receipt-tracker>` (`docs/receipt-tracker-v0.md`) as an
 * ordinary Lit child of its page — nothing is docked, nothing is relocated, so
 * none of `#dockPage`'s static-part discipline applies here. The tracker owns
 * its own empty state; this file's job stops at giving it a page. The `stub`
 * mechanism that used to hold this seat is left in place for whatever lands
 * here next without a live surface of its own.
 */

import { LitElement, html } from '../lit.js';
import { glideIndicator } from '../glide-indicator.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { selected_group } from '../../../scripts/group-chats.js';
// Side-effect import: defines <k-cast-panel>, the Cast tab's view (group chat v0 G4).
import '../../groups/k-cast-panel.js';

/**
 * What a docked `.drawer-content` wears while it lives in the rail.
 * Order matters only for readability; `classList` is a set.
 */
const DOCK_CLASSES = ['openDrawer', 'pinnedOpen', 'k-docked'];

/** Core's "this drawer is shut" marker. Removed while docked, restored on undock. */
const CLOSED_CLASS = 'closedDrawer';

/** The tab shown when the rail first mounts. */
const DEFAULT_TAB = 'prompt';

/** Stroke-only icon set, 16px grid. No Font Awesome, no emoji (repo CLAUDE.md). */
const icons = {
    /** Sliders — the same idea as core's `fa-sliders` on the AI-config drawer. */
    prompt: html`
        <svg class="k-tr-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M2.5 5h11" />
            <path d="M2.5 11h11" />
            <circle cx="6" cy="5" r="1.8" />
            <circle cx="10" cy="11" r="1.8" />
        </svg>`,
    /** Plotted line over axes. */
    trackers: html`
        <svg class="k-tr-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M2.6 2.4v11h11" />
            <path d="M4.8 10.6 7.3 7.4l2.4 2 3.2-4.4" />
        </svg>`,
    /** A foreign drawer with no glyph of its own: a puzzle piece. */
    puzzle: html`
        <svg class="k-tr-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M6 2.5h3.5v2a1.5 1.5 0 1 0 2 0h2v3.5h-2a1.5 1.5 0 1 0 0 2h2V13.5H9.5v-2a1.5 1.5 0 1 0-2 0v2H4V10h2a1.5 1.5 0 1 0 0-2H4V4.5h2z" />
        </svg>`,
    /** Two heads — the cast of a scene. */
    cast: html`
        <svg class="k-tr-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <circle cx="6" cy="5.5" r="2.4" /><path d="M1.75 13a4.25 4.25 0 0 1 8.5 0" />
            <path d="M10.5 3.4a2.4 2.4 0 0 1 0 4.2" /><path d="M11.4 9.1a4.25 4.25 0 0 1 2.85 3.9" />
        </svg>`,
    /** Quiet-state bullet, matching the left rail's stub rows. */
    dot: html`
        <svg class="k-tr-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="2.5" />
        </svg>`,
};

/**
 * One tab. A tab with a `wrapper` is a dock; a tab without one is a stub page.
 * @typedef {object} TabSpec
 * @property {string} id Slug used for the tab/page element ids and the active key.
 * @property {string} label Visible label.
 * @property {unknown} icon Rendered glyph.
 * @property {string} [wrapper] Id of the `.drawer` wrapper to relocate.
 * @property {string} [content] Id of the `.drawer-content` inside that wrapper.
 * @property {string} [stub] Quiet line rendered when the page docks nothing.
 * @property {() => unknown} [view] Renders an ordinary Lit child instead of docking
 *   core DOM or showing a stub line — for a tab whose page is a live surface with its
 *   own empty state. Mutually exclusive with `wrapper`/`content` and with `stub`.
 * @property {boolean} [foreign] A third-party drawer found in `#top-settings-holder`
 *   (ext gauntlet 2026-10-02, finding 2). Docked like Prompt; dressed with `data-k-foreign`
 *   so `shell-right.css` can reset its geometry without a wildcard on every panel.
 */

/**
 * The nine drawers stock ships in `#top-settings-holder` (CONTRACT.md's frozen ids). Anything
 * else that turns up there is an extension's, and under rails it would be a zero-size node in
 * a hidden holder with no other way in — Horae's whole UI lives that way. It becomes a tab.
 */
const STOCK_DRAWERS = new Set([
    'ai-config-button', 'sys-settings-button', 'advanced-formatting-button', 'WI-SP-button',
    'user-settings-button', 'backgrounds-button', 'extensions-settings-button',
    'persona-management-button', 'rightNavHolder',
]);

/** Marker on a foreign `.drawer-content` while it is docked here; removed on undock. */
const FOREIGN_ATTR = 'data-k-foreign';

let foreignSerial = 0;

/**
 * Reads a foreign drawer into a tab. Label and glyph come from the extension's own
 * `.drawer-icon` (its `title`, and its Font Awesome classes — the extension's identity, not
 * ours, so the house rule on glyph fonts does not apply to it); a drawer with neither gets its
 * id spelled out and a generic puzzle piece.
 * @param {Element} wrapper The `.drawer` in the holder.
 * @returns {TabSpec} The tab.
 */
function foreignTab(wrapper) {
    if (!wrapper.id) wrapper.id = `k-ext-drawer-${++foreignSerial}`;
    const iconNode = wrapper.querySelector('.drawer-icon');
    const fa = iconNode ? [...iconNode.classList].filter(name => /^fa[srlb]?-|^fa-/.test(name)) : [];
    // A toggle's title names an action ("Open Horae panel"); a tab names a place ("Horae").
    const title = (iconNode?.getAttribute('title') ?? iconNode?.getAttribute('aria-label') ?? '')
        .replace(/^(open|toggle|show|click to open)\s+(the\s+)?/i, '')
        .replace(/\s+(panel|drawer|menu|settings)$/i, '')
        .trim();
    const label = title || wrapper.id.replace(/[_-]+/g, ' ').replace(/\b(drawer|button|holder)\b/gi, '').replace(/\s+/g, ' ').trim() || 'Extension';
    const icon = fa.length
        ? html`<i class="k-tr-icon k-tr-icon--fa ${fa.join(' ')}" aria-hidden="true"></i>`
        : icons.puzzle;
    return { id: `ext-${wrapper.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label, icon, wrapper: wrapper.id, foreign: true };
}

/**
 * The strip. Prompt is the only dock left (see the header); Trackers keeps the
 * position the mockup gave it, empty or not — the order is the spec's, not a
 * function of what happens to be implemented. A tab is declared here and nowhere
 * else: docking, undocking, opener mapping and both render paths all iterate
 * `TABS`.
 * @type {TabSpec[]}
 */
const TABS = [
    {
        id: 'prompt',
        label: 'Prompt',
        icon: icons.prompt,
        wrapper: 'ai-config-button',
        content: 'left-nav-panel',
    },
    {
        id: 'trackers',
        label: 'Trackers',
        icon: icons.trackers,
        view: () => html`<k-receipt-tracker></k-receipt-tracker>`,
    },
];

/**
 * The Cast tab (group chat v0 G4, `docs/group-chat-v0.md`). Present only while a scene is open.
 *
 * Its PAGE is appended after every dock page, never before: dock pages are static template
 * elements matched by position, and a page inserted ahead of them would shift a docked drawer
 * into a different template and destroy it. Only the stateless tab BUTTONS show Cast first.
 * @type {TabSpec}
 */
const CAST_TAB = {
    id: 'cast',
    label: 'Cast',
    icon: icons.cast,
    view: () => html`<k-cast-panel variant="rail"></k-cast-panel>`,
};

/** Core events after which "is a scene open?" may have changed. */
const SCENE_EVENTS = ['APP_READY', 'CHAT_CHANGED', 'GROUP_UPDATED'];

/**
 * What has to be undone to put one docked wrapper back.
 * @typedef {object} DockRecord
 * @property {Element} wrapper The relocated `.drawer`.
 * @property {Node} parent Where it came from (`#top-settings-holder`).
 * @property {Node | null} nextSibling The node it sat before, for order-exact restore.
 * @property {Element | null} content Its `.drawer-content`, when it has one.
 * @property {string[]} addedClasses Only the classes THIS component added.
 * @property {boolean} restoreClosedDrawer Whether `closedDrawer` was removed on dock.
 * @property {boolean} foreign Whether the `data-k-foreign` marker was set on the content.
 */

/**
 * @param {string} id Tab slug.
 * @returns {string} Element id of that tab's button.
 */
function tabElementId(id) {
    return `k-tr-tab-${id}`;
}

/**
 * @param {string} id Tab slug.
 * @returns {string} Element id of that tab's page.
 */
function pageElementId(id) {
    return `k-tr-page-${id}`;
}

/**
 * The right rail: tab strip over one dock and one stub.
 */
export class KTabRail extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `tabs` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _active: { state: true },
        _foreign: { state: true },
        _inScene: { state: true },
    };

    /**
     * Docked wrappers, keyed by tab slug, in the order they were docked.
     * A `Map` because restore runs newest-first and insertion order is the record.
     * @type {Map<string, DockRecord>}
     */
    #docked = new Map();

    /**
     * Watches `#top-settings-holder` for drawers that are not stock's. Extensions add theirs
     * after boot (`extensions.js` loads them late), so a one-time scan would miss most.
     * @type {MutationObserver|null}
     */
    #holderWatch = null;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'tabs';
        /** @type {string} */
        this._active = DEFAULT_TAB;
        /** @type {TabSpec[]} Third-party drawers found in the holder, in discovery order. */
        this._foreign = [];
        /** @type {boolean} A scene (group chat) is open, so the Cast tab exists. */
        this._inScene = false;
        /**
         * Entering a scene brings Cast forward; leaving one while Cast is showing goes back to
         * the default tab. Anything the user picked inside a scene is left alone.
         * @type {() => void}
         */
        this._onSceneChange = () => {
            const inScene = Boolean(selected_group);
            if (inScene === this._inScene) return;
            this._inScene = inScene;
            if (inScene) this._active = CAST_TAB.id;
            else if (this._active === CAST_TAB.id) this._active = DEFAULT_TAB;
        };
        /**
         * Core's welcome screen offers `.drawer-opener` buttons that target a drawer
         * by wrapper id (`templates/welcome.html:11, :22, :49`). When that drawer is
         * docked here, `doDrawerOpenClick()` (script.js:11270) sees `openDrawer`
         * already set and returns without doing anything — correct, but from the
         * user's side the button looks dead. Bringing the tab forward is what "open
         * that drawer" now means. Bubble phase, non-capturing: core's own handler is
         * a harmless no-op and there is nothing to pre-empt.
         *
         * DORMANT since the v0.1 slim, and kept deliberately. The three shipped
         * openers target `sys-settings-button`, `rightNavHolder` and
         * `extensions-settings-button` — none of which docks here any more — and no
         * opener has ever targeted `ai-config-button`. This is the mechanism, not a
         * mapping: the next dock to land inherits it for free, as does any
         * third-party `.drawer-opener` (delegated at script.js:12484).
         * @type {(event: Event) => void}
         */
        this._onDrawerOpener = (event) => this.#onDrawerOpener(event);
    }

    /** Light DOM: `public/css/shell-right.css` owns every rule. See the file header. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        document.addEventListener('click', this._onDrawerOpener);
        for (const key of SCENE_EVENTS) {
            const name = event_types[key];
            if (typeof name === 'string') eventSource.on(name, this._onSceneChange);
        }
        this._onSceneChange();
        this.#watchHolder();
        void this.#dockWhenRendered();
    }

    disconnectedCallback() {
        document.removeEventListener('click', this._onDrawerOpener);
        for (const key of SCENE_EVENTS) {
            const name = event_types[key];
            if (typeof name === 'string') eventSource.removeListener(name, this._onSceneChange);
        }
        this.#holderWatch?.disconnect();
        this.#holderWatch = null;
        // Synchronous, and deliberately before super: rails.js clears #k-rail-right
        // and then calls restoreAll(), so the drawers have to be back in the holder
        // by the time this call returns.
        this.#undockAll();
        this._foreign = [];
        super.disconnectedCallback();
    }

    /**
     * Every tab in PAGE order: the spec's, the foreign ones, then Cast when a scene is open.
     * Page order must only ever grow at the end (see {@link CAST_TAB}).
     * @returns {TabSpec[]}
     */
    #allTabs() {
        return this._inScene ? [...TABS, ...this._foreign, CAST_TAB] : [...TABS, ...this._foreign];
    }

    /** @returns {TabSpec[]} Every tab in STRIP order: Cast first in a scene, then the rest. */
    #stripTabs() {
        return this._inScene ? [CAST_TAB, ...TABS, ...this._foreign] : [...TABS, ...this._foreign];
    }

    /**
     * Scans the holder for drawers that are not stock's and makes a tab for each new one.
     * Docking happens on the render that follows, through the same `#dockAll()`.
     * @returns {void}
     */
    #discoverForeign() {
        const holder = document.getElementById('top-settings-holder');
        if (!holder) return;
        const known = new Set(this._foreign.map(tab => tab.wrapper));
        /** @type {TabSpec[]} */
        const found = [];
        for (const child of holder.children) {
            if (!child.classList.contains('drawer') || STOCK_DRAWERS.has(child.id) || known.has(child.id)) continue;
            // Our own parked nodes never wear `.drawer`; anything else here is an extension's.
            found.push(foreignTab(child));
        }
        if (found.length === 0) return;
        this._foreign = [...this._foreign, ...found];
        void this.#dockWhenRendered();
    }

    /** Scans now and on every later change to the holder's children. @returns {void} */
    #watchHolder() {
        this.#discoverForeign();
        const holder = document.getElementById('top-settings-holder');
        if (!holder || typeof MutationObserver !== 'function') return;
        this.#holderWatch = new MutationObserver(() => this.#discoverForeign());
        this.#holderWatch.observe(holder, { childList: true });
    }

    /**
     * Docks once the pages exist.
     *
     * Lit renders asynchronously, so the page containers are not in the DOM during
     * `connectedCallback()`. On a re-connect `updateComplete` is already settled and
     * resolves on the next microtask, which is exactly the retry the docks need
     * after an unmount/mount cycle.
     * @returns {Promise<void>}
     */
    async #dockWhenRendered() {
        await this.updateComplete;
        if (!this.isConnected) {
            // Torn down while we waited; disconnectedCallback already ran with
            // nothing docked, so there is nothing to undo and nothing to do.
            return;
        }
        this.#dockAll();
    }

    /**
     * Relocates each dock's `.drawer` wrapper into its page and marks it docked.
     * Idempotent: a wrapper already recorded is skipped.
     * @returns {void}
     */
    #dockAll() {
        for (const tab of this.#allTabs()) {
            if (!tab.wrapper || this.#docked.has(tab.id)) {
                continue;
            }

            const wrapper = document.getElementById(tab.wrapper);
            const page = this.querySelector(`#${pageElementId(tab.id)}`);
            if (!wrapper || !page) {
                console.warn(`[k-tab-rail] cannot dock "${tab.id}": #${tab.wrapper} or its page is missing`);
                continue;
            }

            const parent = wrapper.parentNode;
            if (!parent) {
                console.warn(`[k-tab-rail] cannot dock "${tab.id}": #${tab.wrapper} is detached`);
                continue;
            }

            // A foreign drawer's panel has whatever id its author gave it, or none: it is
            // found by shape, the way core itself resolves icon↔content.
            const content = tab.foreign
                ? wrapper.querySelector(':scope > .drawer-content')
                : tab.content ? document.getElementById(tab.content) : null;
            if (tab.content && !content) {
                console.warn(`[k-tab-rail] #${tab.content} is missing; docking #${tab.wrapper} without its panel state`);
            }

            /** @type {DockRecord} */
            const record = {
                wrapper,
                parent,
                nextSibling: wrapper.nextSibling,
                content,
                addedClasses: [],
                restoreClosedDrawer: false,
                foreign: tab.foreign === true,
            };

            page.appendChild(wrapper);

            if (content) {
                for (const className of DOCK_CLASSES) {
                    if (!content.classList.contains(className)) {
                        content.classList.add(className);
                        record.addedClasses.push(className);
                    }
                }
                if (content.classList.contains(CLOSED_CLASS)) {
                    content.classList.remove(CLOSED_CLASS);
                    record.restoreClosedDrawer = true;
                }
                if (record.foreign) content.setAttribute(FOREIGN_ATTR, '');
            }

            this.#docked.set(tab.id, record);
        }
    }

    /**
     * Puts every docked wrapper back where it came from, newest move first, and
     * removes only the classes this component added.
     *
     * The recorded `nextSibling` may itself have moved while the rail was mounted
     * (the settings modal borrows controls out of the same holder, and until
     * settings v0 slice B the settings overlay also appended `#k-layout-switch`
     * to it), so it is re-validated before use and appending is the honest
     * fallback — the same contract `shell/registry.js:restoreAll()` states.
     * @returns {void}
     */
    #undockAll() {
        const records = Array.from(this.#docked.values()).reverse();
        this.#docked.clear();

        for (const record of records) {
            const { content } = record;
            if (content) {
                for (const className of record.addedClasses) {
                    content.classList.remove(className);
                }
                if (record.restoreClosedDrawer) {
                    content.classList.add(CLOSED_CLASS);
                }
                if (record.foreign) content.removeAttribute(FOREIGN_ATTR);
            }

            if (!record.parent.isConnected) {
                console.warn('[k-tab-rail] original drawer parent is gone; leaving the wrapper in place');
                continue;
            }
            // A foreign drawer its extension has since removed must not be put back into the
            // holder by us: a detached wrapper stays detached.
            if (!record.wrapper.isConnected) continue;
            const before = record.nextSibling && record.nextSibling.parentNode === record.parent
                ? record.nextSibling
                : null;
            record.parent.insertBefore(record.wrapper, before);
        }
    }

    /**
     * Brings a tab forward. Pure state — no node ever moves on a tab change.
     * @param {string} id Tab slug.
     * @param {boolean} [focus] Whether to move focus onto the tab button.
     * @returns {void}
     */
    #select(id, focus = false) {
        if (!this.#allTabs().some(tab => tab.id === id)) {
            return;
        }
        this._active = id;
        if (!focus) {
            return;
        }
        void this.updateComplete.then(() => {
            const button = this.querySelector(`#${tabElementId(id)}`);
            if (button instanceof HTMLElement) {
                button.focus();
            }
        });
    }

    /**
     * Arrow / Home / End movement across the strip, per the ARIA tabs pattern.
     * Selection follows focus, which is the right call here: every panel is
     * already in the DOM, so there is no cost to showing one.
     * @param {KeyboardEvent} event Key event from a tab button.
     * @param {number} index Index of the tab the event came from.
     * @returns {void}
     */
    #onTabKeydown(event, index) {
        const tabs = this.#stripTabs();
        /** @type {number | null} */
        let next = null;
        switch (event.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                next = (index + 1) % tabs.length;
                break;
            case 'ArrowLeft':
            case 'ArrowUp':
                next = (index - 1 + tabs.length) % tabs.length;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = tabs.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        this.#select(tabs[next].id, true);
    }

    /**
     * Maps a core `.drawer-opener` click onto the tab now hosting that drawer.
     *
     * Also the one place that can produce a DEAD CLICK once the right rail can
     * collapse (variant wardrobe v0 §3.4): the tab would come forward behind a
     * zero-width rail and the user would see nothing happen. Asking for the rail
     * back is part of what "open that drawer" means here, so the request goes out
     * unconditionally — `rail-collapse.js` no-ops when the rail is already open,
     * and nothing listens at all under classic.
     * @param {Event} event Document-level click.
     * @returns {void}
     */
    #onDrawerOpener(event) {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const opener = target.closest('.drawer-opener');
        if (!opener) {
            return;
        }
        const wanted = opener.getAttribute('data-target');
        if (!wanted) {
            return;
        }
        const tab = this.#allTabs().find(entry => entry.wrapper === wanted);
        if (tab && this.#docked.has(tab.id)) {
            this.#select(tab.id);
            this.#requestRail();
        }
    }

    /**
     * Asks whoever owns rail collapse to bring this rail back.
     *
     * Dispatched from the element rather than from `document` so it bubbles the
     * normal way, and `composed` for the same reason `k-open-settings` is: the
     * request must survive a shadow boundary if a future host ever introduces
     * one. A hidden element dispatches events perfectly well, which is what makes
     * this work while the rail is collapsed.
     * @returns {void}
     */
    #requestRail() {
        this.dispatchEvent(new CustomEvent('k-rail-expand', {
            bubbles: true,
            composed: true,
            detail: { side: 'right' },
        }));
    }

    /**
     * @param {TabSpec} tab Tab to render.
     * @param {number} index Position in the strip, for keyboard movement.
     * @returns {unknown} One tab button.
     */
    #tab(tab, index) {
        const active = tab.id === this._active;
        return html`
            <button
                type="button"
                role="tab"
                id=${tabElementId(tab.id)}
                class="k-tr-tab${active ? ' is-active' : ''}"
                aria-selected=${active ? 'true' : 'false'}
                aria-controls=${pageElementId(tab.id)}
                tabindex=${active ? '0' : '-1'}
                title=${tab.label}
                @click=${() => this.#select(tab.id)}
                @keydown=${(/** @type {KeyboardEvent} */ event) => this.#onTabKeydown(event, index)}
            >
                ${tab.icon}
                <span class="k-tr-tab-label">${tab.label}</span>
            </button>`;
    }

    /**
     * One dock page — deliberately childless in the template.
     *
     * The element is a STATIC part of the template: only its class, `hidden` and
     * aria attributes are bound. Lit reuses static elements across renders and
     * never walks their children, which is what lets a relocated `.drawer` live
     * inside one and survive every subsequent update. A child binding here — even
     * an empty one — would put a lit part inside the page for no reason, so the
     * stub page gets its own template below instead of a ternary.
     *
     * No `tabindex` on the panel: it hosts focusable controls, so the ARIA tabs
     * pattern says the panel itself must not add a tab stop.
     * @param {TabSpec} tab Tab to render.
     * @returns {unknown} One page.
     */
    #dockPage(tab) {
        const active = tab.id === this._active;
        return html`
            <div
                id=${pageElementId(tab.id)}
                class="k-tr-page${active ? ' is-active' : ''}"
                role="tabpanel"
                aria-labelledby=${tabElementId(tab.id)}
                ?hidden=${!active}
            ></div>`;
    }

    /**
     * A page that docks nothing: one muted line, no fake content.
     * @param {TabSpec} tab Tab to render.
     * @param {string} stub Quiet line.
     * @returns {unknown} One page.
     */
    #stubPage(tab, stub) {
        const active = tab.id === this._active;
        return html`
            <div
                id=${pageElementId(tab.id)}
                class="k-tr-page k-tr-page--stub${active ? ' is-active' : ''}"
                role="tabpanel"
                aria-labelledby=${tabElementId(tab.id)}
                ?hidden=${!active}
            >
                <div class="k-tr-quiet">
                    ${icons.dot}
                    <span class="k-tr-quiet-text">${stub}</span>
                </div>
            </div>`;
    }

    /**
     * A page whose content is an ordinary Lit child — a live surface, not a dock and not
     * a stub. Unlike {@link #dockPage} this page's body IS a reactive part: Lit is free to
     * diff and re-render it on every update, which is correct here because nothing foreign
     * is ever relocated inside it (contrast the wrapper-move contract {@link #dockPage}'s
     * doc comment explains).
     * @param {TabSpec} tab Tab to render.
     * @param {() => unknown} view Renders the page's content.
     * @returns {unknown} One page.
     */
    #viewPage(tab, view) {
        const active = tab.id === this._active;
        return html`
            <div
                id=${pageElementId(tab.id)}
                class="k-tr-page${active ? ' is-active' : ''}"
                role="tabpanel"
                aria-labelledby=${tabElementId(tab.id)}
                ?hidden=${!active}
            >${view()}</div>`;
    }

    /**
     * Picks the one render path a tab wants: a live view, a quiet stub, or a dock.
     * @param {TabSpec} tab Tab to render.
     * @returns {unknown} One page.
     */
    #page(tab) {
        if (tab.view) return this.#viewPage(tab, tab.view);
        if (tab.stub) return this.#stubPage(tab, tab.stub);
        return this.#dockPage(tab);
    }

    /** The strip's pill follows the active tab (blue-hour-polish-v0 §4 M2). */
    updated() {
        glideIndicator(this.querySelector('.k-tr-strip'), '.k-tr-tab.is-active');
    }

    /** @returns {unknown} The rail. */
    render() {
        return html`
            <div class="k-tr-strip" role="tablist" aria-label="Right rail panels">
                ${this.#stripTabs().map((tab, index) => this.#tab(tab, index))}
            </div>
            <div class="k-tr-pages">
                ${this.#allTabs().map(tab => this.#page(tab))}
            </div>`;
    }
}

if (!customElements.get('k-tab-rail')) {
    customElements.define('k-tab-rail', KTabRail);
}
