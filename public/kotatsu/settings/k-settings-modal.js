/**
 * `<k-settings-modal variant="sheet">` — the rails settings surface (settings v0 slice B,
 * `docs/settings-v0.md` §2, §6; v0.1 slice F, §9-§10).
 *
 * ── The whole trick, in one paragraph ─────────────────────────────────────────────────────
 * The modal does not build a settings form. It BORROWS the one `index.html` already ships.
 * Activating a tab RELOCATES that tab's real controls out of the parked drawer rack and into
 * the tab body; switching tabs puts them back before it moves the next set. Nothing is cloned,
 * so no id is ever duplicated, no handler is ever rebound, and every `power_user` write still
 * happens inside the stock listener core attached to that exact node. On close the element is
 * removed, and `disconnectedCallback()` restores every borrowed control synchronously before
 * anything else can run. A mirrored settings form is the failure mode this design exists to
 * avoid — `docs/settings-recon-persistence.md` §7.2 rule 6 spells out the cost of the
 * alternative: a generated read against an absent control returns `undefined`, `JSON.stringify`
 * drops undefined-valued keys, and the setting is gone from `settings.json` with no error.
 *
 * Mount pattern = the CARD STUDIO precedent (`docs/settings-recon-supersession.md` §7,
 * `studio/k-card-studio.js`): body-level, created on open, own scrim, own Relocator ledger,
 * teardown-before-restore on close, Escape on **window capture**. Everything below that differs
 * from the studio is called out where it differs, with the reason.
 *
 * ── What the studio taught, and what this file does with it ───────────────────────────────
 * 1. **Escape on `window`, capture phase.** The library, the AN sheet and (until v0.1 retired
 *    it) the drawer-rack settings overlay all listen on `document` in capture, and the
 *    overlay's handler called `stopImmediatePropagation()` — a same-node sibling could never
 *    win against it (the 8/25 two-sheets lesson). Capture runs window → document, so a window
 *    listener is one rung above all of them regardless of install order.
 * 2. **A borrowed node must never sit inside a lit-html ChildPart.** A conditional `${…}` owns
 *    its subtree and tears it down on the next render — taking a borrowed core control out of
 *    the document with the ledger still claiming it is safely in a slot. So: all nine panels
 *    render on every pass and hide with `?hidden`; the per-entry row list is NEVER filtered
 *    (search hides rows, it does not remove them, because `Array.map` reuses template instances
 *    positionally and a shifted index would hand one entry's slot to another entry's control);
 *    and every adoption slot is a bare element with no binding inside it.
 *
 *    v0.1 nests that list — eyebrow groups, and inside them weave/ledger runs — which makes the
 *    rule *stricter*, not looser: the nesting is computed once per tab by `regionsFor()` from a
 *    frozen `getEntries()` array and memoised, so every render walks the same shape in the same
 *    order and lit never sees a different template at a given index. A run container is ONE
 *    template with a computed class, never two templates chosen by a ternary, so even the
 *    weave/ledger distinction cannot become a template-identity swap.
 * 3. **Anchor labels whole.** `#avatar_div_div` taught the studio that borrowing the inner
 *    control strands its label. Here the registry's `adopt` selector names the wrapper, and the
 *    default resolver walks up to `label.checkbox_label` — the dominant stock shape.
 * 4. **Delegated triggers do not travel.** `$('#container').on('input', '.child', …)` stops
 *    firing when `.child` leaves `#container`. Audited for this surface and clean: the only
 *    delegate over the settings rack is `setting-search.js:7`, which merely walks
 *    `#user-settings-block-content` when someone types in the parked stock search box — a box
 *    that is offstage under rails and which §4 replaces with this modal's own search anyway.
 * 5. **`setLayout()` reloads the page.** It is reused, never reimplemented: it is the one
 *    function that already obeys persistence rule 7 (`await saveSettings()` before
 *    `location.reload()`, never the debounce — the live 2026-08-24 bug).
 * 6. **A block has exactly one holder, and no reconstruction path.** v0.1's four new tabs are
 *    made of five adopted stock REGIONS (`control: 'block'`). `#extensions-settings-button`
 *    carries `#extensions_settings` / `#extensions_settings2` — two frozen ABI containers
 *    (CONTRACT.md:117-119) that third-party panels append into on their own schedule and that
 *    **nothing in the codebase ever re-creates** (recon §4.5). Strand that wrapper and the only
 *    recovery is `location.reload()`. So the tab rail dropped its Ext and WI docks in the same
 *    batch this tab landed (exactly one holder, ever — recon G1), and every path through the
 *    Relocator here is exception-safe: a borrow that throws un-records itself, a restore that
 *    throws still restores the rest, and a bad entry costs one row rather than a whole tab.
 *
 * ── The Hybrid (v0.1, `settings-v0.md` §9) ───────────────────────────────────────────────
 * Ledger rows (label + control) for heavyweight controls; a two-column weave only for
 * homogeneous checkbox clusters; eyebrow group headers from the registry's `group` field, which
 * is contiguous over `getEntries()` order by construction (registry.js's own guarantee, gated in
 * `tests/settings-registry.test.js`). Compact spans weave at four rows; see `region-plan.js`.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────────────────
 * A fixed, centred sheet over its OWN scrim, appended to `<body>` so no ancestor `filter` /
 * `transform` can turn `position: fixed` into a containing block under it. Light DOM,
 * `variant` attribute from day one (SPEC §13), every rule in
 * `public/kotatsu/settings/settings-modal.css` scoped `body[data-k-layout="rails"]`.
 *
 * Rails-only by construction: `openSettings()` refuses under any other layout, the rails
 * layout is the only caller of `installSettingsModal()`, and classic never sees a rule from the
 * sheet. Under classic the stock drawers are the settings surface, untouched and byte-stable.
 *
 * One-way imports: kotatsu → core. Nothing in core imports this file.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { DEFAULT_LAYOUT, setLayout } from '../shell/persistence.js';
import { toggleRail } from '../shell/rail-collapse.js';
import { glideIndicator } from '../shell/glide-indicator.js';
import { getEntries, getSections, searchEntries } from './registry.js';
import { regionsFor } from './region-plan.js';
import { OPEN_TOUR_EVENT } from '../onboarding/k-onboarding.js';
import '../phone/k-phone-card.js';

/** @typedef {import('./registry.js').Entry} Entry */
/** @typedef {import('./registry.js').Section} Section */
/** @typedef {import('./region-plan.js').Run} Run */
/** @typedef {import('./region-plan.js').Region} Region */

/**
 * Stacking rungs, declared here and consumed by `--k-set-z-*` in `settings-modal.css`.
 *
 * The measured ladder in this document: `#sheld` 30, `k-library` 31 (`library.css:141`), the
 * rail handles 40 (`shell-frame.css:404`), `#top-settings-holder` 3005
 * (`kotatsu-chrome.css`; the drawer-rack overlay's 2999 scrim retired with it), the Author's-Note
 * scrim 3999 and panel 4000 (`shell-panels.css:134`), `#character_popup` 4001
 * (`style.css:4665`), `#shadow_select_chat_popup` 4100 (`style.css:4743`), the card studio
 * 4100/4101 (`STUDIO_Z`), `k-branch-map` 30000, core popups 9999.
 *
 * 4090/4091 is the rung §2 pins, and the choice is directional rather than arbitrary: settings
 * must paint over the whole in-page family it curates (the rack it replaces, the gallery, the
 * chat, the AN panel) and UNDER the card studio, because the studio is a modal editing surface
 * that may legitimately be opened over settings and must own the screen when it is. `dialog.popup`
 * at 9999 wins over both — `showModal()` puts it in the top layer where no z-index reaches it.
 */
export const SETTINGS_Z = Object.freeze({ scrim: 4090, sheet: 4091 });

/**
 * The event the top bar's gear dispatches. Bubbling + composed, so it crosses the shadow boundary.
 *
 * ── The detail contract (v0.1) ────────────────────────────────────────────────────────────
 * `detail` is optional. With none, the event TOGGLES, which is what the gear wants. With
 * `{ tab: '<section id>' }` it OPENS on that tab (never closes — "open settings on Connection"
 * has no toggle reading), and the handler writes `detail.ready = modal.updateComplete` back onto
 * the caller's own object. Awaiting that promise is how a dispatcher knows the tab's controls
 * have been relocated into the sheet, which matters to anything that then wants to drive one of
 * them. Core uses this instead of an import — see `serveOpenRequest()`.
 */
export const OPEN_SETTINGS_EVENT = 'k-open-settings';

/** Set on `<body>` while the sheet is up: the scroll lock hangs off it, and probes read it. */
const OPEN_CLASS = 'k-settings-modal-open';

/**
 * Whether the modal DRAWS this control instead of borrowing it.
 *
 * `binding.runtime` is the registry's flag for "no such node exists in `index.html`" — the
 * migrated Classic/Rails switch here (the retired rails settings overlay used to build it and
 * append it to the drawer rack), rail collapse in slice A's registry. There is nothing to relocate for
 * one, so `#place()` skips it and `#renderRow()` draws it; the modal stamps `binding.ref` onto
 * what it builds, so the binding resolves for a probe either way.
 * @param {Entry} entry Registry entry.
 * @returns {boolean} Whether the modal owns this control's markup.
 */
function isRuntimeControl(entry) {
    return entry.binding?.runtime === true;
}

/**
 * The running search query, resolved once per render.
 * @typedef {object} Matches
 * @property {Set<string>} ids Entry ids to leave visible — hits, plus the block carrying a hit.
 * @property {Map<string, number>} counts section id → how many registry entries matched.
 * @property {Map<string, string[]>} folded block id → the labels of the folded rows it carries
 *   that matched, so the block can say why it is on screen.
 */

/** The two layouts, in the order the switch prints them. */
const LAYOUT_OPTIONS = Object.freeze([
    /** @type {[string, string]} */ (['classic', 'Classic']),
    /** @type {[string, string]} */ (['rails', 'Rails']),
]);

/**
 * The two rail sides, in the order the switch prints them, with the hotkey each one answers to.
 *
 * The bindings are restated rather than imported because `rail-collapse.js` keeps its
 * `SIDE_HOTKEY` map private and the modal only needs the STRING for a title attribute — a second
 * export for two literals would widen that module's surface for a tooltip.
 */
const RAIL_OPTIONS = Object.freeze([
    /** @type {['left'|'right', string, string]} */ (['left', 'Left', 'Ctrl+\\']),
    /** @type {['left'|'right', string, string]} */ (['right', 'Right', 'Ctrl+Shift+\\']),
]);

/**
 * Stroke-only icons. No Font Awesome, no emoji (repo CLAUDE.md). The borrowed stock controls
 * keep their own Font Awesome classes — those are core's markup and this file does not restyle
 * a glyph it did not draw.
 */
const icons = {
    close: html`
        <svg class="k-set-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    search: html`
        <svg class="k-set-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13.5 13.5" />
        </svg>`,
    lock: html`
        <svg class="k-set-icon" viewBox="0 0 16 16" width="11" height="11" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <rect x="3.5" y="7" width="9" height="6" rx="1.5" /><path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
        </svg>`,
};

/**
 * One 13px stroke icon per nav tab, keyed by the registry's section id — the facelift's nav
 * icons (`docs/design/settings-facelift/README.md` §3). Same discipline as `icons` above: no
 * Font Awesome, no emoji, `stroke="currentColor"` so both the resting muted tab colour and the
 * active rose paint it for free with no icon-specific rule. `stroke-width` is 1.4 rather than
 * `icons`' 1.5 — a hair thinner reads right at 13px sitting beside the label's 12.5px UI type,
 * where `icons`' close/search glyphs are drawn a size up and want the heavier stroke.
 *
 * A shape's fill is `none` at the SVG root, same as `icons`; the two shapes the brief describes
 * as "center dot" and "half-filled circle" override `fill` on the one child that carries it
 * (`stroke="none"` alongside, so that child never double-draws an outline).
 * @type {Readonly<Record<string, unknown>>}
 */
const TAB_ICONS = Object.freeze({
    connection: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
        </svg>`,
    personas: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="8" cy="5.3" r="2.4" /><path d="M2.6 13.5c0-3.1 2.4-5.3 5.4-5.3s5.4 2.2 5.4 5.3" />
        </svg>`,
    appearance: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
        </svg>`,
    chat: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"
             aria-hidden="true" focusable="false">
            <path d="M3 3.8h10a1 1 0 0 1 1 1V9a1 1 0 0 1-1 1H7.8L5 12.6V10H3a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z" />
        </svg>`,
    streaming: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M3 4.5h10" /><path d="M3 8h6.5" /><path d="M3 11.5h3.5" />
        </svg>`,
    worldinfo: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="5.5" /><ellipse cx="8" cy="8" rx="2.3" ry="5.5" /><path d="M2.6 8h10.8" />
        </svg>`,
    extensions: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" aria-hidden="true" focusable="false">
            <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.1" /><rect x="9" y="2.4" width="4.6" height="4.6" rx="1.1" />
            <rect x="2.4" y="9" width="4.6" height="4.6" rx="1.1" /><rect x="9" y="9" width="4.6" height="4.6" rx="1.1" />
        </svg>`,
    scripting: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M3.3 4.3 7 8l-3.7 3.7" /><path d="M8.7 12.3h4" />
        </svg>`,
    system: html`
        <svg class="k-set-tab-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 3.2V1.4M8 14.6v-1.8M3.2 8H1.4M14.6 8h-1.8M4.9 4.9 3.6 3.6M12.4 12.4l-1.3-1.3M11.1 4.9l1.3-1.3M3.6 12.4l1.3-1.3" />
        </svg>`,
});

/**
 * A node's position before the modal moved it.
 * @typedef {object} Anchor
 * @property {Node} parent
 * @property {Node | null} nextSibling
 */

/**
 * The modal's own relocation ledger.
 *
 * A THIRD instance of `shell/registry.js`'s semantics rather than a call into it, for the reason
 * `k-card-studio.js:131-144` states and which applies here word for word: the shell registry's
 * ledger belongs to the LAYOUT and is replayed by `applyLayout()` on every layout switch, so
 * borrowing it would mean a settings close could not restore anything without also unwinding
 * rails, and a layout switch would restore these controls at a moment this element still
 * believed it was holding them. One ledger per lifetime, and this lifetime is the shortest of
 * the three.
 *
 * The two subtleties that make restore honest are copied exactly: an anchor is recorded only on
 * the FIRST relocate of a node, and the recorded `nextSibling` is re-validated at restore time
 * because it may itself have moved or been removed meanwhile.
 */
class Relocator {
    /** @type {WeakMap<Element, Anchor>} */
    #anchors = new WeakMap();

    /** @type {Element[]} The questions the WeakMap holds the answers to; it cannot be iterated. */
    #order = [];

    /**
     * Moves a node into a slot, remembering where it was.
     * @param {Element | null | undefined} node What to borrow.
     * @param {Element | null | undefined} target Where to put it.
     * @returns {boolean} Whether the move happened.
     */
    relocate(node, target) {
        if (!(node instanceof Element) || !(target instanceof Element)) return false;
        if (node === target || node.contains(target)) return false;
        const fresh = !this.#anchors.has(node);
        if (fresh) {
            const parent = node.parentNode;
            if (!parent) return false;
            this.#anchors.set(node, { parent, nextSibling: node.nextSibling });
            this.#order.push(node);
        }
        try {
            target.appendChild(node);
        } catch (error) {
            // A borrow that threw left the node where it was, so the ledger must not claim it:
            // a phantom entry would "restore" an untouched node into a stale anchor later. Only
            // a FRESH record is dropped — an earlier successful borrow keeps its real anchor.
            if (fresh) {
                this.#anchors.delete(node);
                this.#order.pop();
            }
            console.warn('[k-settings-modal] a control could not be borrowed; it stays where it is.', error);
            return false;
        }
        return true;
    }

    /**
     * Puts every borrowed node back, newest move first.
     *
     * Per-node try/catch and a `finally` that empties the queue: this is the ONLY thing standing
     * between a close and a stranded stock region, and one region that cannot go home must not
     * take the other four with it. `#extensions-settings-button` is why the guard is here rather
     * than in the caller — nothing in the codebase re-creates `#extensions_settings` /
     * `#extensions_settings2`, so their recovery path is `location.reload()` (recon §4.5).
     * @returns {number} How many nodes went home.
     */
    restoreAll() {
        let restored = 0;
        try {
            for (let index = this.#order.length - 1; index >= 0; index--) {
                const node = this.#order[index];
                const anchor = this.#anchors.get(node);
                this.#anchors.delete(node);
                if (!anchor || !anchor.parent.isConnected) continue;
                // The original next sibling may have moved or been removed while we held the
                // node; appending to the recorded parent is the honest fallback.
                const before = anchor.nextSibling && anchor.nextSibling.parentNode === anchor.parent
                    ? anchor.nextSibling
                    : null;
                try {
                    anchor.parent.insertBefore(node, before);
                    restored += 1;
                } catch (error) {
                    console.error('[k-settings-modal] a borrowed region could not be restored.', error);
                }
            }
        } finally {
            this.#order = [];
        }
        return restored;
    }

    /** @returns {number} How many nodes are currently borrowed. */
    get size() {
        return this.#order.length;
    }
}

/**
 * Whether a core popup owns the keyboard right now.
 *
 * Both spellings, because both exist: `dialog.popup[open]` is the modern `Popup` class
 * (`popup.js:623`) — every confirm, and the theme import/delete pickers this surface can open —
 * and `#shadow_popup` is the legacy one still used by a handful of paths.
 * @returns {boolean} Whether to stand down.
 */
function corePopupOpen() {
    if (document.querySelector('dialog.popup[open]')) return true;
    const shadowPopup = document.getElementById('shadow_popup');
    if (!shadowPopup) return false;
    return getComputedStyle(shadowPopup).display !== 'none';
}

/**
 * The node an entry's VALUE lives in.
 * @param {import('./registry.js').EntryBinding} binding Registry binding.
 * @returns {Element|null} The control, or null when the markup is absent.
 */
function bindingNode(binding) {
    if (!binding || typeof binding.ref !== 'string') return null;
    if (binding.by === 'name') {
        return document.querySelector(`[name="${CSS.escape(binding.ref)}"]`);
    }
    return document.getElementById(binding.ref);
}

/**
 * The node the modal should MOVE for an entry — which is not always the node the value lives in.
 *
 * `adopt` wins when the registry names a wrapper — a slider that must bring its number counter,
 * a `<label for=>` that is real hit area rather than decoration, one of Kotatsu's wardrobe rows
 * carrying its pack note, or `#auto_continue_target_length`, whose input lives INSIDE its own
 * label and would be torn out of it by the fallback. Seventeen of the surfaced rows name one
 * (`registry-data.js` header, "Adoption units"); the rest do not need to.
 * Otherwise the binding node is walked up to its `label.checkbox_label`, if it has one: that is
 * the dominant stock shape and the label IS the affordance — its `for=` association is what
 * makes the visible text clickable, so leaving it behind would strand both the words and half
 * the hit area. Anything else travels alone and the modal's own row label names it.
 * @param {Entry} entry Registry entry.
 * @returns {Element|null} The adoption unit, or null when nothing resolves.
 */
function adoptionUnit(entry) {
    if (typeof entry.adopt === 'string' && entry.adopt) {
        return document.querySelector(entry.adopt);
    }
    const node = bindingNode(entry.binding);
    if (!node) return null;
    return node.closest('label.checkbox_label') ?? node;
}

/**
 * The tabbed settings modal.
 */
export class KSettingsModal extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /**
         * The active tab's section id — a real ATTRIBUTE, not private state.
         *
         * v0.1 needs a door for "open settings ON this tab": the model menu's wizard footer wants
         * Connection (`settings-v0.md` §9 trap 4) and `openWorldInfoEditor()` wants World Info
         * (recon G6). Both go through `openSettings({ tab })`, which stamps this attribute BEFORE
         * the element is connected — so the first render already draws the right panel and
         * `firstUpdated()` borrows the right controls, with no second `#activate()` and no
         * flash of the default tab. Reflected so a probe (and a stylesheet) can read it.
         */
        tab: { type: String, reflect: true },
        _query: { state: true },
        _switching: { state: true },
    };

    /** @type {Relocator} */
    #relocator = new Relocator();

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onNavigation = null;

    /** @type {HTMLElement|null} */
    #opener = null;

    /** @type {Array<() => void>} Reversible presentation on borrowed buttons. */
    #actionCleanup = [];

    /**
     * Watches `<body>`'s rail attributes so the rails switch keeps describing the screen.
     *
     * The switch is not the only thing that moves those rails while this sheet is up: `Ctrl+\`
     * still works (bubble phase on `document`, `rail-collapse.js:handleKeyDown`), and the
     * viewport resolver collapses a side on its own when the window narrows past
     * `--k-center-readable-min`. Both write `data-k-rail-left` / `-right` through the same
     * `apply()`, so watching the attribute catches every writer without this file knowing any
     * of them — the same reason `#renderLayoutSwitch` asks the document rather than a caller.
     * @type {MutationObserver|null}
     */
    #railWatcher = null;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {string} The active tab's section id. */
        this.tab = getSections()[0]?.id ?? '';
        /** @type {string} The search box's raw text. */
        this._query = '';
        /** @type {boolean} True between a layout choice and the reload it triggers. */
        this._switching = false;
    }

    /** Light DOM: `settings-modal.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        this.#opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        // Window, capture phase — one rung above every other Escape listener in the document.
        // See rule 1 in the module header.
        this.#onEscape = (event) => this.#handleEscape(event);
        window.addEventListener('keydown', this.#onEscape, { capture: true });
        this.#onNavigation = (event) => this.#handleNavigation(event);
        window.addEventListener('keydown', this.#onNavigation, { capture: true });
        if (typeof MutationObserver === 'function') {
            this.#railWatcher = new MutationObserver(() => this.requestUpdate());
            this.#railWatcher.observe(document.body, {
                attributes: true,
                attributeFilter: ['data-k-rail-left', 'data-k-rail-right'],
            });
        }
        document.body.classList.add(OPEN_CLASS);
    }

    disconnectedCallback() {
        // SYNCHRONOUS, and deliberately before `super`: the rails layout removes this element
        // and then calls `ctx.restoreAll()`, so every borrowed control has to be back inside the
        // drawer rack by the time this call returns — otherwise the layout hands classic a rack
        // with holes in it. Same ordering lesson as `k-card-studio.js:325-333` and
        // `k-tab-rail.js:241-248` (the rail's own `disconnectedCallback`; the v0.1 slim moved it
        // up from `:253-260`).
        this.#teardown();
        super.disconnectedCallback();
    }

    /**
     * Undoes everything the element did to the document.
     *
     * Listeners first, then the ledger: an Escape arriving between the two would otherwise find
     * a half-restored surface. `restoreAll()` is the last thing that can fail and the only thing
     * that matters.
     * @returns {void}
     */
    #teardown() {
        try {
            if (this.#onEscape) {
                window.removeEventListener('keydown', this.#onEscape, { capture: true });
                this.#onEscape = null;
            }
            if (this.#railWatcher) {
                this.#railWatcher.disconnect();
                this.#railWatcher = null;
            }
            if (this.#onNavigation) {
                window.removeEventListener('keydown', this.#onNavigation, { capture: true });
                this.#onNavigation = null;
            }
        } finally {
            // In a `finally` because it is the only irreversible one: a listener that outlives
            // the element is a leak, a stock region that never goes home is a reload (rule 6).
            this.#restoreControls();
            document.body.classList.remove(OPEN_CLASS);
            if (this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
            this.#opener = null;
        }
    }

    /* ── lifecycle ──────────────────────────────────────────────────────────── */

    firstUpdated() {
        this.#place(this.tab);
        this.#focusSearch();
    }

    /** The section nav's pill follows the active tab (blue-hour-polish-v0 §4 M3). */
    updated() {
        glideIndicator(this.querySelector('.k-set-tabs'), '.k-set-tab.is-active');
        // A running search shows every match in place: the Connection tab's stock panel, folded
        // behind its disclosure otherwise (connections-v0 C3), stands open while one runs.
        this.toggleAttribute('data-searching', Boolean(this._query.trim()));
    }

    /**
     * Borrows every control the active tab curates, in registry order.
     *
     * Missing nodes are WARNED about, never thrown on: a core update that renames one control
     * must cost that one row, not the whole surface. The row is left empty and everything else
     * still works — the same degradation contract `k-card-studio.js:#place()` states.
     *
     * `getEntries()` has already dropped every `surface: 'none'` entry, which is what §0's "kill"
     * means and where it is enforced: not adopted into the modal, never deleted from the DOM,
     * never deleted from storage. Under classic those controls are still fully functional. The
     * `surface` check below is a belt against a registry that ever stops filtering, not the
     * mechanism. `getEntries()` also drops every `withinBlock` row, which is the one-node rule:
     * `auto_connect` renders inside `#rm_api_block` and the Connection BLOCK carries it, so this
     * loop must never be handed a second claim on that checkbox.
     *
     * Every entry is wrapped: one row that throws costs that row, never the rest of the tab.
     * The tab this matters most for is Extensions — its block carries two frozen ABI containers
     * that nothing re-creates (rule 6 in the module header), so a half-placed tab that then fails
     * to restore is the one failure with no recovery short of a reload.
     * @param {string} sectionId Tab to fill.
     * @returns {void}
     */
    #place(sectionId) {
        if (!this.isConnected) return;
        for (const entry of getEntries(sectionId)) {
            try {
                if (entry.surface !== 'modal') continue;
                if (isRuntimeControl(entry)) continue;
                const slot = this.querySelector(`[data-k-set-slot="${CSS.escape(entry.id)}"]`);
                if (!(slot instanceof Element)) {
                    console.warn(`[k-settings-modal] no slot rendered for "${entry.id}".`);
                    continue;
                }
                const node = adoptionUnit(entry);
                if (!(node instanceof Element)) {
                    console.warn(`[k-settings-modal] the control for "${entry.id}" is missing; that row is empty.`);
                    continue;
                }
                this.#relocator.relocate(node, slot);
                this.#labelThemeAction(node);
            } catch (error) {
                console.error(`[k-settings-modal] "${entry.id}" could not be placed; that row is empty.`, error);
            }
        }
    }

    /**
     * Switches tabs: the outgoing tab's controls go home BEFORE the incoming tab's arrive.
     *
     * The ordering is the whole point and it is the studio's lesson one level in. Restoring
     * first means the ledger is empty for one instant and every borrowed node is provably back
     * in the rack — so a close, a layout switch or an exception in the middle of a tab change
     * cannot strand anything. Borrowing first and restoring after would leave a window in which
     * two tabs both believe they hold the same node.
     *
     * `#place()` runs SYNCHRONOUSLY after the state write rather than after `updateComplete`,
     * and that is deliberate too: all five panels render on every pass (see rule 2 in the module
     * header), so the incoming tab's slots already exist in the DOM and there is nothing to wait
     * for. Waiting would open an await between restore and place during which an Escape could
     * tear the element down — and the pending `#place()` would then relocate live controls into
     * a DETACHED slot, removing them from the document with no ledger left to bring them back.
     * @param {string} sectionId Tab to activate.
     * @returns {void}
     */
    #activate(sectionId) {
        if (sectionId === this.tab) return;
        this.#restoreControls();
        this.tab = sectionId;
        this.#place(sectionId);
    }

    /** Restore stock presentation before returning the real controls. @returns {void} */
    #restoreControls() {
        for (const cleanup of this.#actionCleanup.splice(0)) cleanup();
        this.#relocator.restoreAll();
    }

    /** @param {Element} node Borrowed control. @returns {void} */
    #labelThemeAction(node) {
        const labels = new Map([
            ['ui_preset_import_button', 'Import'],
            ['ui_preset_export_button', 'Export'],
            ['ui-preset-update-button', 'Save changes'],
            ['ui-preset-save-button', 'Save as…'],
            ['ui-preset-delete-button', 'Delete'],
        ]);
        const text = labels.get(node.id);
        if (!text) return;
        const previous = node.getAttribute('aria-label');
        const label = document.createElement('span');
        label.className = 'k-set-action-label';
        label.textContent = text;
        node.append(label);
        node.setAttribute('aria-label', `${text} theme`);
        this.#actionCleanup.push(() => {
            label.remove();
            if (previous === null) node.removeAttribute('aria-label');
            else node.setAttribute('aria-label', previous);
        });
    }

    /**
     * The public "put me on this tab" door — `openSettings({ tab })` when the sheet is already up.
     *
     * Named rather than reached through `#activate` directly because the callers are other
     * modules (the model menu's wizard footer, the World Info editor route) and they are asking a
     * question about the SURFACE, not driving its private state machine. An unknown id is warned
     * about and ignored: a stale caller must not blank the sheet.
     * @param {string} sectionId Section id from the registry.
     * @returns {boolean} Whether that tab is now the active one.
     */
    activateTab(sectionId) {
        if (!getSections().some(section => section.id === sectionId)) {
            console.warn(`[k-settings-modal] "${sectionId}" is not a settings tab.`);
            return false;
        }
        this.#activate(sectionId);
        return true;
    }

    /** Puts the caret where a settings visitor most often starts. @returns {void} */
    #focusSearch() {
        const search = this.querySelector('.k-set-search-input');
        if (search instanceof HTMLElement) {
            search.focus({ preventScroll: true });
        }
    }

    /* ── doors ──────────────────────────────────────────────────────────────── */

    /**
     * Closes the modal, which restores every borrowed control.
     *
     * `remove()` is the whole implementation: `disconnectedCallback()` is what puts the controls
     * back, so there is exactly one close path and no way to close without restoring.
     * @returns {void}
     */
    close() {
        this.remove();
    }

    /** @returns {{ open: boolean, tab: string, borrowed: number, query: string, tabs: string[] }} The console door's state. */
    get state() {
        return {
            open: this.isConnected,
            tab: this.tab,
            borrowed: this.#relocator.size,
            query: this._query,
            tabs: getSections().map(section => section.id),
        };
    }

    /* ── interaction ────────────────────────────────────────────────────────── */

    /** Keyboard navigation yields to editing surfaces opened above settings.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleNavigation(event) {
        if (!this.isConnected || event.defaultPrevented || event.isComposing) return;
        if (corePopupOpen() || document.querySelector('k-card-studio, k-branch-map')) return;
        const target = event.composedPath()[0];
        const editing = target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
        if (event.key === '/' && !editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.#focusSearch();
            return;
        }
        if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
        // Include open shadow roots: the borrowed color pickers own their buttons there.
        /** @type {HTMLElement[]} */
        const focusable = [];
        /** @param {Element|ShadowRoot} root Subtree in composed tab order. */
        const visit = (root) => {
            for (const node of root.children) {
                if (!(node instanceof HTMLElement) || node.matches('[inert]')
                    || getComputedStyle(node).display === 'none') continue;
                if (node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length
                    && getComputedStyle(node).visibility === 'visible') focusable.push(node);
                visit(node.shadowRoot ?? node);
            }
        };
        const sheet = this.querySelector('.k-set-sheet');
        if (sheet) visit(sheet);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        let active = document.activeElement;
        const outside = !this.contains(active);
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        const destination = event.shiftKey && (active === first || outside) ? last
            : !event.shiftKey && (active === last || outside) ? first : null;
        if (destination instanceof HTMLElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
            destination.focus();
        }
    }

    /**
     * Escape closes the modal — but only when it is the outermost thing Escape could mean.
     *
     * Capture phase on `window`, so without a stand-down this would pre-empt core's whole Escape
     * cascade (`RossAscends-mods.js:1175-1265`, bubble phase) AND every surface that legitimately
     * paints over this one. It stands down for those, and only then consumes the key —
     * `stopImmediatePropagation()` rather than `stopPropagation()`, the lesson the retired
     * settings overlay paid for (the 8/25 two-sheets bug): consuming a key means all of it, later
     * siblings on this node included, or two surfaces close on one press.
     *
     * The stand-downs are presence checks rather than ordering assumptions on purpose: the card
     * studio's own Escape handler is also a window-capture listener and does not know about this
     * one, so which of the two fires first depends on which opened first. A presence check is
     * order-independent and always resolves in favour of the surface that paints on top.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleEscape(event) {
        if (event.key !== 'Escape' || !this.isConnected) {
            return;
        }
        // Popups opened from inside this surface (theme delete/import confirms) are ours to
        // wait for; a confirm dialog belongs to whatever asked for it.
        if (corePopupOpen()) return;
        // Both paint above this sheet — the studio at 4100/4101, the branch map at 30000.
        if (document.querySelector('k-card-studio')) return;
        if (document.querySelector('k-branch-map')) return;
        // A populated search box eats the first Escape, the way every search field does
        // (`k-library.js:786-793` sets the precedent in this codebase).
        if (this._query) {
            event.stopImmediatePropagation();
            event.preventDefault();
            this.#setQuery('');
            this.#focusSearch();
            return;
        }
        event.stopImmediatePropagation();
        event.preventDefault();
        this.close();
    }

    /**
     * @param {Event} event The search field's `input` event.
     * @returns {void}
     */
    #onSearchInput(event) {
        const input = event.target;
        this._query = input instanceof HTMLInputElement ? input.value : '';
    }

    /**
     * @param {string} value Raw search text.
     * @returns {void}
     */
    #setQuery(value) {
        this._query = value;
        const input = this.querySelector('.k-set-search-input');
        if (input instanceof HTMLInputElement && input.value !== value) {
            input.value = value;
        }
    }

    /**
     * Applies a layout choice through the shell's own persistence door.
     *
     * `setLayout()` is REUSED, never reimplemented: persistence rule 7 (`settings-v0.md` §1)
     * requires an awaited `saveSettings()` before the reload, and `shell/persistence.js:84-107`
     * is the function that already does exactly that — the debounced variant loses a race it
     * cannot win, because its timer dies with the page (found live 2026-08-24).
     *
     * The borrowed controls are deliberately NOT restored first. `setLayout()` reloads
     * unconditionally — the reload sits outside its try/catch — so the document this element is
     * holding nodes out of is about to stop existing, and `saveSettings()` serializes in-memory
     * objects rather than reading the DOM (`settings-recon-persistence.md` §7.1: there are zero
     * init-time DOM→`power_user` writes). `_switching` only stops a second click from queuing a
     * second save against a page that is already leaving.
     * @param {string} id Requested layout.
     * @param {string} active The layout currently painted.
     * @returns {void}
     */
    #chooseLayout(id, active) {
        if (this._switching || id === active) return;
        this._switching = true;
        void setLayout(id);
    }

    /**
     * Flips one rail through the shell's own door.
     *
     * `toggleRail()` is the EXACT function the chevron handles call
     * (`rail-collapse.js:buildHandle` → `click` → `toggleRail(side)`), which is the whole point:
     * there is one write path for `power_user.kotatsu_rails` and this button does not add a
     * second. Everything that makes rail state honest rides along for free — the toggle answers
     * the EFFECTIVE state rather than the stored wish, a side the viewport resolver has
     * suppressed takes a session override instead of overwriting the preference, focus is
     * rescued out of a rail that is about to disappear, and only a real preference change
     * reaches `saveRails()`. A parallel `power_user.kotatsu_rails = …` here would lose all four
     * and, being debounce-free, would also race the resolver.
     *
     * The re-render is explicit as well as watched: `#railWatcher` catches the attribute write,
     * but a toggle the shell declines (an unmounted rail module warning and returning) writes
     * nothing at all, and the switch must still settle back to what the screen actually says.
     * @param {'left'|'right'} side Which rail.
     * @returns {void}
     */
    #chooseRail(side) {
        toggleRail(side);
        this.requestUpdate();
    }

    /* ── render ─────────────────────────────────────────────────────────────── */

    render() {
        const sections = getSections();
        // ONE registry search per render, shared by the tab counts and the row filter. `null`
        // means "no query" and is distinct from an empty result, which means "a query that
        // matched nothing" — the two render very differently.
        const matches = this.#matches();
        return html`
            <div class="k-set-scrim" @click=${() => this.close()}></div>
            <div class="k-set-sheet" role="dialog" aria-modal="true" aria-label="Settings">
                ${this.#renderHead()}
                <div class="k-set-body">
                    ${this.#renderTabStrip(sections, matches)}
                    <div class="k-set-panels">
                        ${sections.map(section => this.#renderPanel(section, matches))}
                    </div>
                </div>
            </div>`;
    }

    /**
     * The current query, resolved once: what to show, what to count, and what a block is hiding.
     *
     * ── Why the counts come from `searchEntries()` and not from `getEntries()` ────────────────
     * Slice E folded `auto_connect` into the Connection block: the checkbox renders at
     * `index.html:4165`, INSIDE `#rm_api_block`, so the block already carries the node and a
     * second registry row would be a second claim on it. `getEntries()` therefore leaves
     * `withinBlock` rows out — and a per-tab count that walked `getEntries()` would report **0**
     * for a query the registry can plainly answer. Typing "auto connect" printed a dimmed
     * Connection tab and a lie. Counting `searchEntries()` hits by `entry.section` fixes it at
     * the source: the registry says which tab a hit belongs to, folded or not.
     *
     * Two consequences follow, and both are handled here rather than left to the reader:
     *   - **The carrier stays visible.** A folded hit adds its `withinBlock` id to `ids`, so the
     *     block that physically contains the matched control does not hide while its own count
     *     says 1. Otherwise the tab would claim a match and show an empty panel.
     *   - **The carrier says what it matched.** `folded` maps a block id to the labels of the
     *     rows inside it that matched, so the block region can print one line explaining why it
     *     is the only thing left on screen.
     * @returns {Matches|null} Resolved matches, or null when there is no query.
     */
    #matches() {
        const query = this._query.trim();
        if (!query) return null;
        /** @type {Set<string>} */
        const ids = new Set();
        /** @type {Map<string, number>} */
        const counts = new Map();
        /** @type {Map<string, string[]>} */
        const folded = new Map();
        for (const entry of searchEntries(query)) {
            ids.add(entry.id);
            counts.set(entry.section, (counts.get(entry.section) ?? 0) + 1);
            if (typeof entry.withinBlock !== 'string') continue;
            ids.add(entry.withinBlock);
            const carried = folded.get(entry.withinBlock);
            if (carried) carried.push(entry.label);
            else folded.set(entry.withinBlock, [entry.label]);
        }
        return { ids, counts, folded };
    }

    /**
     * @param {Matches|null} matches Resolved matches.
     * @param {string} sectionId Section to count.
     * @returns {number} How many of that section's entries match the running query.
     */
    #countMatches(matches, sectionId) {
        return matches?.counts.get(sectionId) ?? 0;
    }

    /**
     * One flex row: the serif title carrying its eyebrow inline, the search pill, close ×.
     *
     * The eyebrow used to stack above the title inside its own wrapper (`.k-set-head-copy`,
     * two rows, ~96px of header); the facelift's one-row header
     * (`docs/design/settings-facelift/README.md` §2) folds it into the title's own line box
     * instead — `.k-set-header-eyebrow` rides INSIDE `<h2>`, right after the text, so
     * `.k-set-head` keeps exactly three direct children (title, search, close) and no new
     * wrapper layer stands between its flex row and them.
     *
     * The `/` keycap names the search shortcut handled by #handleNavigation. It leaves text
     * editing alone and yields to popups above settings, independently of the Escape ladder.
     * @returns {unknown} A Lit template.
     */
    #renderHead() {
        return html`
            <header class="k-set-head">
                <h2 class="k-set-title">Settings<span class="k-set-header-eyebrow">Kotatsu</span></h2>
                <label class="k-set-search">
                    ${icons.search}
                    <input
                        type="search"
                        class="k-set-search-input"
                        placeholder="Search settings"
                        aria-label="Search settings"
                        .value=${this._query}
                        @input=${(/** @type {Event} */ event) => this.#onSearchInput(event)}
                    />
                    <span class="k-set-search-key" aria-hidden="true">/</span>
                </label>
                <button type="button" class="k-set-close" title="Close (Escape)" aria-label="Close settings"
                    @click=${() => this.close()}>${icons.close}</button>
            </header>`;
    }

    /**
     * The tab strip.
     *
     * While a search is running each tab carries the number of ITS entries that match, so a
     * query typed on Appearance still tells the reader that the answer is three tabs over —
     * which is §0's whole complaint about the stock search (it indexes 1 drawer of 9).
     * @param {ReadonlyArray<Section>} sections Ordered tabs.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template.
     */
    #renderTabStrip(sections, matches) {
        return html`
            <nav class="k-set-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
                ${sections.map(section => this.#renderTab(section, matches))}
            </nav>`;
    }

    /**
     * One tab button — its 13px `TAB_ICONS` glyph, then the label, then the search-count pill.
     * @param {Section} section The tab.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template.
     */
    #renderTab(section, matches) {
        const active = this.tab === section.id;
        // -1, not 0: "no query running" and "a query that matched nothing here" are different
        // states, and only the second one dims the tab.
        const hits = matches ? this.#countMatches(matches, section.id) : -1;
        return html`
            <button
                type="button"
                role="tab"
                id=${`k-set-tab-${section.id}`}
                class="k-set-tab${active ? ' is-active' : ''}${hits === 0 ? ' is-empty' : ''}"
                aria-selected=${active ? 'true' : 'false'}
                aria-controls=${`k-set-panel-${section.id}`}
                @click=${() => this.#activate(section.id)}
            >
                ${TAB_ICONS[section.id] ?? nothing}
                <span class="k-set-tab-label">${section.label}</span>
                ${hits > 0 ? html`<span class="k-set-tab-count">${hits}</span>` : nothing}
            </button>`;
    }

    /**
     * Renders one tab panel.
     *
     * ALL NINE panels are rendered on every pass and hidden with an attribute, never rendered
     * conditionally — rule 2 in the module header, and the load-bearing decision of this file.
     * The row list inside is likewise never filtered: `Array.map` reuses lit template instances
     * by INDEX, so removing a row while a search is running would slide every later row up one
     * slot and hand one entry's adoption slot to a different entry's control. Rows hide; they do
     * not leave.
     *
     * The Hybrid nests that list — regions, then runs, then rows — and the nesting comes from
     * `regionsFor()`, which is pure over a frozen array and memoised. So the index at every level
     * is as stable as the flat list was, and the only thing a search changes is a `hidden`
     * attribute.
     * @param {Section} section The section to draw.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template.
     */
    #renderPanel(section, matches) {
        const active = this.tab === section.id;
        const regions = regionsFor(section.id);
        const hits = matches ? this.#countMatches(matches, section.id) : getEntries(section.id).length;
        return html`
            <section
                class="k-set-panel"
                id=${`k-set-panel-${section.id}`}
                role="tabpanel"
                aria-labelledby=${`k-set-tab-${section.id}`}
                ?hidden=${!active}
            >
                <p class="k-set-blurb">${section.blurb}</p>
                <div class="k-set-rows">
                    ${regions.map(region => this.#renderRegion(region, matches))}
                </div>
                <p class="k-set-empty" ?hidden=${hits > 0}>
                    ${matches
        ? `Nothing in ${section.label} matches that.`
        : `${section.label} has no settings yet.`}
                </p>
                <div class="k-set-search-destinations" ?hidden=${!matches || hits > 0}>
                    ${getSections().filter(other => other.id !== section.id && this.#countMatches(matches, other.id) > 0)
        .map(other => html`<button type="button" class="k-set-result-link"
                            @click=${() => { this.#activate(other.id); this.#focusSearch(); }}
                        >${this.#countMatches(matches, other.id)} ${this.#countMatches(matches, other.id) === 1 ? 'match' : 'matches'} in ${other.label}</button>`)}
                </div>
            </section>`;
    }

    /**
     * One region of a tab — a block, or an eyebrow group.
     *
     * A method rather than a ternary inside the panel template, so the panel's row list stays
     * one `.map()` over one stable plan and the two region shapes are named where they are
     * drawn. Which branch a given index takes never changes: `regionsFor()` is pure over a
     * frozen array (rule 2).
     * @param {Region} region The region to draw.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template.
     */
    #renderRegion(region, matches) {
        return region.kind === 'block'
            ? this.#renderBlock(region.entry, matches)
            : this.#renderGroup(region, matches);
    }

    /**
     * One eyebrow group: a header, then its weave and ledger runs in registry order.
     *
     * The run container is ONE template with a computed class rather than a ternary between two
     * templates, so lit can never be handed a different template at the same index — the
     * strictest reading of rule 2, and free.
     * @param {{ kind: 'group', label: string, runs: Run[] }} region The group.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template.
     */
    #renderGroup(region, matches) {
        return html`
            <div class="k-set-group" ?hidden=${matches !== null && !region.runs.some(run => run.entries.some(entry => matches.ids.has(entry.id)))}>
                ${region.label
        ? html`<h3 class="k-set-group-eyebrow">${region.label}</h3>`
        : nothing}
                ${region.runs.map(run => html`
                    <div class=${run.actions ? 'k-set-run k-set-run--actions'
        : run.weave ? 'k-set-run k-set-run--weave' : 'k-set-run'}>
                        ${run.entries.map(entry => this.#renderRow(entry, matches))}
                    </div>`)}
            </div>`;
    }

    /**
     * One adopted stock REGION — `control: 'block'`, `settings-v0.md` §10.
     *
     * Full-bleed and chrome-less: no label column, no registry label printed, no row hover, no
     * padding of our own. The block's own UI carries itself — `#rm_api_block` opens with
     * `h3#title_api`, `#persona-suite` with the persona toolbar's `<h3>`,
     * `#extensions-settings-button` with the Extensions `<h3>` — and a second heading beside
     * theirs would just be Kotatsu talking over stock. The registry `label` still does its real
     * job: it is what search matches on.
     *
     * The slot is a bare element with no binding inside it, exactly like a row's. The one
     * conditional here is a SIBLING of the slot, never an ancestor, so no ChildPart ever owns a
     * borrowed region (rule 2 / rule 6).
     * @param {Entry} entry The block entry.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template.
     */
    #renderBlock(entry, matches) {
        const folded = matches?.folded.get(entry.id);
        return html`
            <section
                class="k-set-block"
                data-k-set-entry=${entry.id}
                aria-label=${entry.label}
                ?hidden=${matches ? !matches.ids.has(entry.id) : false}
            >
                ${folded && folded.length
        ? html`<p class="k-set-block-match">Matched inside: ${folded.join(' · ')}</p>`
        : nothing}
                <div class="k-set-slot k-set-slot--block" data-k-set-slot=${entry.id}></div>
            </section>`;
    }

    /**
     * One labelled row.
     *
     * A `surface: 'none'` entry renders as `nothing` — no row, no slot, so `#place()` has
     * nowhere to put it even if it tried. `getEntries()` already filters those out, so this is
     * belt on top of braces; between them, §0's "kill" definition holds mechanically rather
     * than by promise, and the control keeps working in the stock drawer under classic.
     *
     * The adoption slot is a BARE element with no binding inside it. A lit-html ChildPart in
     * there would own the subtree and clear it on the next render, taking the borrowed control
     * out of the document. Native controls are drawn as a SIBLING of the slot rather than inside
     * it, so the rule holds without a special case.
     *
     * A `checkbox` row prints NO label of its own. Stock's dominant shape is
     * `<label class="checkbox_label"><input id="X"><small>Its name</small></label>` and the
     * whole label is what gets borrowed, so a registry label beside it would say the same words
     * twice. The registry label still does its real job for that row — it is what search reads,
     * and it is where §5's truth fixes land.
     * @param {Entry} entry The setting.
     * @param {Matches|null} matches Resolved matches, or null when there is no query.
     * @returns {unknown} A Lit template, or nothing.
     */
    #renderRow(entry, matches) {
        if (entry.surface !== 'modal') {
            return nothing;
        }
        const native = isRuntimeControl(entry);
        // A button row prints no label either: it renders inside an actions strip
        // (.k-set-run--actions) where the adopted stock icon carries the meaning and the
        // registry label rides as title/aria — the canvas mock's compact file-op cluster.
        const action = entry.control === 'button';
        const inline = entry.control === 'checkbox' || action;
        return html`
            <div
                class="k-set-row${inline ? ' k-set-row--inline' : ''}${action ? ' k-set-row--action' : ''}"
                data-k-set-entry=${entry.id}
                title=${action ? entry.label : nothing}
                aria-label=${action ? entry.label : nothing}
                ?hidden=${matches ? !matches.ids.has(entry.id) : false}
            >
                ${inline ? nothing : html`
                    <div class="k-set-labelrow">
                        <span class="k-set-label">${entry.label}</span>
                    </div>`}
                <div class="k-set-control">
                    <div class="k-set-slot" data-k-set-slot=${entry.id}></div>
                    ${native ? this.#renderNative(entry) : nothing}
                    ${entry.lockedBy
        ? html`<span class="k-set-lock" title=${`Your system's ${entry.lockedBy} setting can override this.`}>
                                ${icons.lock}<span>${entry.lockedBy}</span>
                            </span>`
        : nothing}
                </div>
            </div>`;
    }

    /**
     * Draws a control the modal owns outright.
     *
     * The entry's `binding.ref` is stamped onto whatever gets built, so a `runtime` binding
     * resolves in a live DOM exactly like a stock one — which is what lets gate D2 ("every
     * `binding.ref` resolves") apply to natives without an exception clause.
     * @param {Entry} entry The setting.
     * @returns {unknown} A Lit template, or nothing for an unknown native kind.
     */
    #renderNative(entry) {
        if (entry.control === 'kotatsu-layout') {
            return this.#renderLayoutSwitch(entry.binding.ref);
        }
        if (entry.control === 'kotatsu-rails') {
            return this.#renderRailsSwitch(entry.binding.ref);
        }
        if (entry.control === 'kotatsu-tour') {
            return this.#renderTourReplay(entry.binding.ref);
        }
        if (entry.control === 'kotatsu-phone') {
            return html`<k-phone-card id=${entry.binding.ref} variant="settings"></k-phone-card>`;
        }
        console.warn(`[k-settings-modal] "${entry.control}" is not a native control kind this modal can draw.`);
        return nothing;
    }

    /**
     * The welcome tour's replay door (onboarding v0 §3). Settings closes first: the tour sits a
     * rung below this sheet (4080 vs 4090) and steps aside while settings is up, so opening it
     * underneath would show nothing. The tour owns `kotatsu_onboarding` from there.
     * @param {string} buttonId The id to stamp on the button — the entry's `binding.ref`.
     * @returns {unknown} A Lit template.
     */
    #renderTourReplay(buttonId) {
        const replay = () => {
            this.close();
            window.dispatchEvent(new CustomEvent(OPEN_TOUR_EVENT));
        };
        // No hint span: inside a control cell it wraps into a ladder (settings-modal.css, pixel QA
        // defect 3), and the button's own words say what it does.
        return html`<button id=${buttonId} type="button" class="menu_button" @click=${replay}>Take the welcome tour</button>`;
    }

    /**
     * The Classic/Rails switch, migrated out of the retiring settings overlay.
     *
     * The active layout is read off `<body>` rather than threaded in as a constructor argument:
     * `data-k-layout` is written by the rails mount (`layouts/rails.js:140`) and is the same
     * value `applyLayout()` acted on, so asking the document is asking the thing that actually
     * decided. The overlay had to be told, because it was installed before the attribute meant
     * anything to it; this element is created on open, long after.
     *
     * `.k-layout-option` is reused verbatim so the strip inherits the dressing
     * `shell-frame.css:334-356` already ships for it, and the strip keeps the `#k-layout-switch`
     * id it wore in the rack (the registry's `binding.ref`). Only the container's own GEOMETRY
     * moved on: the overlay's rules pinned it into the drawer icon row (`margin-left: 6px`,
     * `flex: 0 0 auto`), which means nothing inside a modal row, so those rules were deleted and
     * `.k-set-layout-switch` replaces them.
     *
     * One behaviour deliberately NOT carried over: clicking the already-active option used to
     * close the overlay. In a rack strip that was a reasonable "never mind"; in a radio group
     * inside a settings row it would be a surprise, so it is a no-op here.
     * @param {string} switchId The id to stamp on the strip — the entry's `binding.ref`.
     * @returns {unknown} A Lit template.
     */
    #renderLayoutSwitch(switchId) {
        const active = document.body?.dataset?.kLayout || DEFAULT_LAYOUT;
        return html`
            <div id=${switchId} class="k-set-layout-switch" role="group" aria-label="Layout">
                ${LAYOUT_OPTIONS.map(([id, label]) => html`
                    <button
                        type="button"
                        class="k-layout-option"
                        data-k-layout-option=${id}
                        aria-pressed=${id === active ? 'true' : 'false'}
                        ?disabled=${this._switching}
                        @click=${() => this.#chooseLayout(id, active)}
                    >${label}</button>`)}
                <span class="k-set-hint">Switching reloads the page.</span>
            </div>`;
    }

    /**
     * The rail-collapse pair — the first settings control the rails have ever had.
     *
     * Until now the only way to collapse a rail was the chevron handle pinned to its edge or
     * `Ctrl+\`; `power_user.kotatsu_rails` was a real persisted setting with no representation
     * on the settings surface at all (census §6.1 counts it as one of the two Kotatsu keys with
     * no drawer control). This is a segmented pair rather than the layout switch's radio group
     * because the two sides are INDEPENDENT: each button is a toggle for its own rail, and
     * `aria-pressed` means "this rail is open".
     *
     * ── What the buttons read, and why it is not the stored value ─────────────────────────
     * `data-k-rail-left` / `-right` on `<body>`, which carry the EFFECTIVE pair — what is on
     * screen — and not `power_user.kotatsu_rails`, which carries the PREFERRED pair. Those two
     * disagree on purpose: `rail-collapse.js:100-112` suppresses a preferred-open rail when the
     * viewport cannot afford it, restores the preference by arithmetic when the window grows,
     * and never persists the suppression. A switch that printed the stored wish would show
     * "open" beside a rail the reader can plainly see is gone, and clicking "collapse" on it
     * would be a no-op. Reading the body attribute makes this control say exactly what the
     * chevron says, because it is reading what the chevron reads (`refreshHandles()`).
     *
     * `.k-layout-option` is reused verbatim, the same borrow the layout switch makes, so both
     * strips wear one dressing (`shell-frame.css:334-356`); only the container class differs.
     * @param {string} switchId The id to stamp on the strip — the entry's `binding.ref`.
     * @returns {unknown} A Lit template.
     */
    #renderRailsSwitch(switchId) {
        /** @type {Record<string, string>} */
        const states = {
            left: document.body?.dataset?.kRailLeft || 'open',
            right: document.body?.dataset?.kRailRight || 'open',
        };
        // Resolved before the template rather than inside the map, so the map body stays a
        // single expression — the shape every other list in this file uses.
        const sides = RAIL_OPTIONS.map(([side, label, hotkey]) => {
            const open = states[side] === 'open';
            return { side, label, open, action: `${open ? 'Collapse' : 'Expand'} the ${side} rail (${hotkey})` };
        });
        return html`
            <div id=${switchId} class="k-set-rails-switch" role="group" aria-label="Rails">
                ${sides.map(rail => html`
                    <button
                        type="button"
                        class="k-layout-option"
                        data-k-rail-option=${rail.side}
                        aria-pressed=${rail.open ? 'true' : 'false'}
                        aria-label=${rail.action}
                        title=${rail.action}
                        @click=${() => this.#chooseRail(rail.side)}
                    >${rail.label}</button>`)}
                <span class="k-set-hint">A lit side is open.</span>
            </div>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-settings-modal')) {
    customElements.define('k-settings-modal', KSettingsModal);
}

/* ── the host: one document door, no permanently mounted element ──────────── */

/** @type {boolean} */
let installed = false;

/** @type {((event: Event) => void)|null} */
let onOpenRequest = null;

/** @returns {KSettingsModal|null} The mounted modal, or null. */
function currentModal() {
    const element = document.querySelector('k-settings-modal');
    return element instanceof KSettingsModal ? element : null;
}

/**
 * Whether the rails layout is the one on screen.
 *
 * The gate §2 pins: "Rails-only: classic never constructs the modal." `data-k-layout` is the
 * shell's own answer to that question — written by the rails mount, deleted by its unmount, and
 * already the gate every Kotatsu stylesheet and component keys on. Classic's settings surface is
 * the stock drawer rack, which stays byte-untouched precisely because this returns false there.
 * @returns {boolean} Whether the modal may exist.
 */
function railsActive() {
    return document.body?.dataset?.kLayout === 'rails';
}

/**
 * Opens the settings modal, optionally ON a given tab.
 *
 * The `tab` option is the whole v0.1 API addition, and it is one string rather than a second
 * exported function per destination: two callers want it today (`k-model-menu._openWizard` →
 * Connection, `settings-v0.md` §9 trap 4; the World Info editor route → World Info, recon G6) and
 * a third will want it tomorrow. The id is the registry's own section id, validated against
 * `getSections()` so a stale caller warns instead of blanking the sheet.
 *
 * The attribute is stamped BEFORE `appendChild`, so the element's first render already draws the
 * requested panel and `firstUpdated()` borrows that tab's controls — no default-tab flash, and no
 * second restore/place cycle. When the sheet is already up this switches tabs instead, because
 * "open settings on X" can never honestly mean "close settings".
 * @param {{ tab?: string }} [options] Where to land.
 * @returns {KSettingsModal|null} The mounted modal, or null if it could not open.
 */
export function openSettings(options = {}) {
    const tab = typeof options.tab === 'string' ? options.tab : '';
    const existing = currentModal();
    if (existing) {
        if (tab) existing.activateTab(tab);
        return existing;
    }
    if (!railsActive()) {
        console.warn('[k-settings-modal] the settings modal is a rails surface; classic uses the stock drawers.');
        return null;
    }
    const modal = /** @type {KSettingsModal} */ (document.createElement('k-settings-modal'));
    modal.setAttribute('variant', 'sheet');
    if (tab) {
        if (getSections().some(section => section.id === tab)) modal.setAttribute('tab', tab);
        else console.warn(`[k-settings-modal] "${tab}" is not a settings tab; opening on the first one.`);
    }
    document.body.appendChild(modal);
    return modal;
}

/** @returns {void} */
export function closeSettings() {
    currentModal()?.close();
}

/** @returns {boolean} Whether the modal is up. */
export function isSettingsModalOpen() {
    return currentModal() !== null;
}

/** @returns {object|null} The console door's `.state`. */
export function settingsState() {
    return currentModal()?.state ?? null;
}

/**
 * The `k-open-settings` door: opens the modal, or closes it if one is already up.
 *
 * The toggle is real for anything that DISPATCHES the event, but not for the gear that normally
 * sends it: the sheet's scrim is `position: fixed; inset: 0` at z 4090, so it covers the top bar
 * and a second press can never reach the button (slice D's modal probe, 2026-08-25). The gear is
 * a one-way door in practice; the ways back are the scrim, the close ×, and Escape. Kept as a
 * toggle rather than a plain `openSettings()` because the event is public and a caller that is
 * not under the scrim — a hotkey, a slash command — should get toggle semantics.
 * @returns {void}
 */
export function toggleSettings() {
    if (currentModal()) closeSettings();
    else openSettings();
}

/**
 * Serves one `k-open-settings` event.
 *
 * A bare event still toggles (see `toggleSettings`). An event carrying `detail.tab` is a REQUEST
 * for a destination, so it opens rather than toggles, and it answers back: `detail.ready` is set
 * to the modal's `updateComplete`, which resolves only after `firstUpdated()` — i.e. after
 * `#place()` has borrowed that tab's controls.
 *
 * That answer is the reason the detail is writable, and it exists for exactly one caller shape:
 * **core code, which may not import this module.** `public/scripts/world-info.js` has to open the
 * World Info tab and then drive `#world_editor_select`, and the editor render measures textarea
 * heights (`initScrollHeight`, `world-info.js:3564-3565`) — a measurement that returns 0 against
 * a node still parked in the `display:none` holder. The event carries the coupling instead of an
 * import, and the promise carries the ORDER. One-way imports hold (`CLAUDE.md`): core dispatches
 * a DOM event and reads a property off its own detail object; nothing in core reaches into
 * `public/kotatsu/`.
 * @param {Event} event The `k-open-settings` event.
 * @returns {void}
 */
function serveOpenRequest(event) {
    const detail = event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
        ? event.detail
        : null;
    const tab = typeof detail?.tab === 'string' ? detail.tab : '';
    if (!tab) {
        toggleSettings();
        return;
    }
    const modal = openSettings({ tab });
    if (detail && modal) {
        detail.ready = modal.updateComplete;
    }
}

/**
 * Wires the document-level open door. Called by the rails layout's `mount()`.
 *
 * Listeners only — the element is created on the first open request and removed from the DOM on
 * close, so nothing is mounted and no stock control is borrowed until someone asks. Idempotent:
 * a shell reload must not stack a second listener.
 * @returns {void}
 */
export function installSettingsModal() {
    if (installed) {
        return;
    }
    installed = true;
    onOpenRequest = (event) => serveOpenRequest(event);
    document.addEventListener(OPEN_SETTINGS_EVENT, onOpenRequest);
}

/**
 * Removes every listener and node this module added, and — critically — CLOSES an open modal,
 * which is what puts the borrowed controls back.
 *
 * Called by the rails layout's `unmount()` BEFORE `ctx.restoreAll()`: the layout is about to
 * hand the drawer rack back to classic, and it must hand it back whole.
 * @returns {void}
 */
export function uninstallSettingsModal() {
    closeSettings();
    if (!installed) {
        return;
    }
    installed = false;
    if (onOpenRequest) {
        document.removeEventListener(OPEN_SETTINGS_EVENT, onOpenRequest);
        onOpenRequest = null;
    }
}
