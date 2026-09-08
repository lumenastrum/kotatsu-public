/**
 * `<k-card-studio variant="sheet">` — the creation/edit surface (library v0 slice D,
 * `docs/library-v0.md` §2). Slice C's gallery is the way in; this is what opens on top of it.
 *
 * ── The whole trick, in one paragraph ─────────────────────────────────────────────────────
 * The studio does not build a form. It BORROWS core's. HTML form association is ID-based and
 * position-independent (`form="form_create"`), which the 22 Advanced-Definitions controls
 * already prove from inside `#k-offstage` — so a control can be moved anywhere in the document
 * and still submit through `new FormData($('#form_create')[0])` (`script.js:10103`). On open the
 * studio RELOCATES the real controls into its layout; on close it puts every one of them back
 * exactly where it found it. One source of truth: autosave (`script.js:533`), the per-field
 * `input` binds (`script.js:11784-11812`), the token counters, the macro engine, the crop
 * popup, the tag bindings and the `name=` wire format (`charaFormatData`,
 * `src/endpoints/characters.js:565-645`) all keep working because none of them was reimplemented.
 * A mirrored copy is the failure mode this design exists to avoid.
 *
 * The two frozen BLOCKS never move. `#rm_ch_create_block` stays a descendant of
 * `#right-nav-panel` because `selectRightMenuWithAnimation()` iterates
 * `#right-nav-panel .right_menu` (`script.js:8980`) and a block outside that query is a block
 * core can no longer reveal; `#character_popup` stays in `#k-offstage` for the same class of
 * reason. We relocate CONTROLS, never blocks (doc §2.1 item 3, CONTRACT §1.3).
 *
 * ── What relocation does NOT carry, and what we do about it ───────────────────────────────
 * Two core behaviours are scoped to those blocks by SELECTOR rather than by binding, and both
 * were found by reading rather than by the doc:
 *
 * 1. **Token counting.** The trigger is delegated on the blocks themselves —
 *    `$('#rm_ch_create_block').on('input', …)` and `$('#character_popup').on('input', …)`
 *    (`RossAscends-mods.js:211-213`). Relocate the textareas out and typing stops re-counting,
 *    even though `RA_CountCharTokens()` itself is entirely id-based
 *    (`RossAscends-mods.js:221-228`) and would happily count them where they now stand. The
 *    studio therefore runs its OWN debounced call on its own `input` listener. This is the one
 *    piece of core behaviour the studio re-hosts, and it re-hosts the trigger, never the work.
 * 2. **Spoiler-free peeking.** `peekSpoilerMode()` toggles `#descriptionWrapper` /
 *    `#firstMessageWrapper` (`power-user.js:997-1000`), and the studio borrows the textareas
 *    rather than those wrappers, so the eye button hides the wrapper it left behind. Accepted
 *    for v0 and stated out loud: the studio is the surface you open in order to READ those
 *    fields, and hiding them inside an editor is a browsing affordance, not an editing one.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────────────────
 * A fixed, centred modal sheet over a scrim — the branch-map overlay pattern, appended to
 * `<body>` so no ancestor `filter` / `transform` can turn `position: fixed` into a containing
 * block under it. Created on open, removed on close: teardown is not a discipline question
 * because the element stops existing, and `disconnectedCallback()` restores every borrowed
 * control synchronously before anything else can run. Light DOM, `variant` attribute from day
 * one (SPEC §13), every rule in `public/css/studio.css` scoped `body[data-k-layout="rails"]`.
 *
 * One-way imports: kotatsu → core. Nothing in core imports this file; the rails layout installs
 * it and the library opens it.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import {
    characters,
    selectCharacterById,
    this_chid,
} from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { RA_CountCharTokens } from '../../scripts/RossAscends-mods.js';
import { power_user } from '../../scripts/power-user.js';
import { debounce } from '../../scripts/utils.js';
import { debounce_timeout } from '../../scripts/constants.js';
import { buildEpithet } from '../library/epithet.js';
import { renderCard } from '../library/k-library.js';
import { accentHue, previewRow } from '../library/view-model.js';
import {
    FOOTER_SLOTS,
    OPEN_STUDIO_EVENT,
    RAIL_SLOTS,
    TABS,
    allSlots,
    modeTitle,
    readiness,
} from './manifest.js';

export { OPEN_STUDIO_EVENT } from './manifest.js';

/**
 * Stacking rungs, declared here and consumed by `--k-studio-z-*` in `public/css/studio.css`.
 *
 * The ladder in this document, measured rather than assumed: `#sheld` 30 (`style.css`),
 * `k-library` 31 (`library.css:141`), the rail handles 40 (`shell-frame.css:404`), the settings
 * scrim 2999 (`shell-frame.css:261`), `#top-settings-holder` 3005 (`kotatsu-chrome.css`), the
 * Author's-Note scrim 3999 and the panel itself 4000 (`shell-panels.css:134`),
 * `#character_popup` 4001 (`style.css:4665`), `#shadow_select_chat_popup` 4100
 * (`style.css:4743`), core popups 9999.
 *
 * The studio is a MODAL EDITING surface, not a panel: while it is up it owns the screen, and
 * every one of those in-page surfaces must paint under it — including `#character_popup`, whose
 * children the studio is currently holding, and the settings rack, which is the only other way
 * to reach this form. So it sits above the whole Author's-Note / advanced-popup family at
 * 4100/4101 rather than threading between them.
 *
 * It stays BELOW `dialog.popup` (9999) on purpose and by necessity: the crop popup and the
 * alternate-greetings editor are `<dialog showModal()>` (`popup.js:623,685`), they open OVER the
 * studio as part of its own flows, and the top layer beats any z-index anyway. Also below toastr
 * and the boot loader (999999) — those are notifications the user must keep seeing.
 */
export const STUDIO_Z = Object.freeze({ scrim: 4100, sheet: 4101 });

/** How long the preview coalesces a burst of keystrokes. One frame's worth, not a debounce. */
const PREVIEW_THROTTLE_MS = 60;

/**
 * Stroke-only icons. No Font Awesome, no emoji (repo CLAUDE.md). The borrowed core controls
 * keep their own Font Awesome classes — those are core's markup and the studio does not restyle
 * a glyph it did not draw.
 */
const icons = {
    close: html`
        <svg class="k-studio-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    check: html`
        <svg class="k-studio-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>`,
};

/**
 * A node's position before the studio moved it.
 * @typedef {object} Anchor
 * @property {Node} parent
 * @property {Node | null} nextSibling
 */

/**
 * The studio's own relocation ledger.
 *
 * Deliberately a SECOND instance of `shell/registry.js`'s semantics rather than a call into it:
 * the registry's ledger belongs to the LAYOUT and is replayed by `applyLayout()` on every
 * layout switch. Borrowing it would mean a studio close could not restore anything without
 * also unwinding the rails layout, and a layout switch would restore the studio's controls at a
 * moment the studio still believed it was holding them. One ledger per lifetime, and the
 * studio's lifetime is shorter than the layout's.
 *
 * The semantics are copied exactly, including the two subtleties that make restore honest:
 * an anchor is recorded only on the FIRST relocate of a node, and the recorded `nextSibling` is
 * re-validated at restore time because it may itself have moved or been removed while the
 * studio was open.
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
        if (!this.#anchors.has(node)) {
            const parent = node.parentNode;
            if (!parent) return false;
            this.#anchors.set(node, { parent, nextSibling: node.nextSibling });
            this.#order.push(node);
        }
        target.appendChild(node);
        return true;
    }

    /**
     * Puts every borrowed node back, newest move first.
     * @returns {number} How many nodes went home.
     */
    restoreAll() {
        let restored = 0;
        for (let index = this.#order.length - 1; index >= 0; index--) {
            const node = this.#order[index];
            const anchor = this.#anchors.get(node);
            this.#anchors.delete(node);
            if (!anchor || !anchor.parent.isConnected) continue;
            // The original next sibling may have moved or been removed while we held the node;
            // appending to the recorded parent is the honest fallback.
            const before = anchor.nextSibling && anchor.nextSibling.parentNode === anchor.parent
                ? anchor.nextSibling
                : null;
            anchor.parent.insertBefore(node, before);
            restored += 1;
        }
        this.#order = [];
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
 * (`popup.js:623`) — the crop dialog `read_avatar_load()` opens (`script.js:7834`), the
 * alternate-greetings editor (`script.js:9909`) and every confirm — and `#shadow_popup` is the
 * legacy one still used by a handful of paths.
 * @returns {boolean} Whether to stand down.
 */
function corePopupOpen() {
    if (document.querySelector('dialog.popup[open]')) return true;
    const shadowPopup = document.getElementById('shadow_popup');
    if (!shadowPopup) return false;
    return getComputedStyle(shadowPopup).display !== 'none';
}

/**
 * Reads a form control's value by selector, tolerating its absence.
 * @param {string} selector CSS selector.
 * @returns {string} The value, or ''.
 */
function readValue(selector) {
    const element = document.querySelector(selector);
    if (element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement) {
        return String(element.value ?? '');
    }
    return '';
}

/**
 * The card studio.
 */
export class KCardStudio extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** Reflected so `public/css/studio.css` can key the mode without a class dance. */
        mode: { type: String, reflect: true },
        _tab: { state: true },
        _preview: { state: true },
        _ready: { state: true },
    };

    /** @type {Relocator} */
    #relocator = new Relocator();

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** @type {MutationObserver|null} Watches the three core nodes that change without an `input`. */
    #observer = null;

    /** @type {number} `setTimeout` handle for the coalesced preview refresh, 0 = idle. */
    #previewTimer = 0;

    /** @type {(() => void)|null} The studio's re-hosted token-count trigger. See the header. */
    #countTokens = null;

    /** @type {(event: Event) => void} */
    #onFormInput;

    /** @type {(() => void)|null} Closes the sheet when the card it is editing stops existing. */
    #onCharacterDeleted = null;

    /** Static poster mode: no handlers, no tab stop, nothing announced as a control. */
    #previewHandlers = Object.freeze({ interactive: false });

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {'create'|'edit'} */
        this.mode = 'create';
        /** @type {string} */
        this._tab = TABS[0].id;
        /** @type {import('../library/view-model.js').LibraryRow} */
        this._preview = previewRow({});
        /** @type {{ filled: number, total: number, missing: string[] }} */
        this._ready = readiness({});
        this.#onFormInput = () => {
            this.#schedulePreview();
            this.#countTokens?.();
        };
    }

    /** Light DOM: `public/css/studio.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        // The debounced counter is built per element rather than at module scope so a studio
        // that closes mid-debounce takes its pending call with it. `debounce_timeout.relaxed`
        // is the exact cadence core uses for the same job (`RossAscends-mods.js:73`).
        this.#countTokens = debounce(() => { void RA_CountCharTokens(); }, debounce_timeout.relaxed);

        // Window, capture phase — one rung above every other Escape listener in the document.
        // The library, the settings overlay and the AN sheet all listen on `document` in
        // capture, and capture runs window → document, so this handler is guaranteed to see
        // Escape first no matter what order those three were installed in. That ordering is not
        // a nicety: the studio paints above all of them (see STUDIO_Z), so it must be what
        // Escape closes first, and the settings overlay's handler calls
        // `stopImmediatePropagation()` — a same-node sibling could never win against it.
        this.#onEscape = (event) => this.#handleEscape(event);
        window.addEventListener('keydown', this.#onEscape, { capture: true });

        this.addEventListener('input', this.#onFormInput);
        this.addEventListener('change', this.#onFormInput);

        // The footer's Delete is REAL, so it can delete the card out from under the sheet. Core
        // then reveals the character list (`select_rm_info('char_delete')`, script.js:9024) and
        // the studio would be left editing a file that no longer exists — a form whose Save
        // would recreate it. One event, one close.
        this.#onCharacterDeleted = () => this.close();
        eventSource.on(event_types.CHARACTER_DELETED, this.#onCharacterDeleted);

        document.body.classList.add('k-studio-open');
    }

    disconnectedCallback() {
        // SYNCHRONOUS, and deliberately before `super`: the rails layout removes this element
        // and then calls `ctx.restoreAll()`, so every borrowed control has to be back inside
        // `#rm_ch_create_block` / `#character_popup` by the time this call returns — otherwise
        // the layout restores those blocks to classic with holes in them. Same ordering lesson
        // as `k-tab-rail.js:241-248`, and the reason the layout's unmount removes this element
        // BEFORE restoreAll rather than after.
        this.#teardown();
        super.disconnectedCallback();
    }

    /**
     * Undoes everything the element did to the document.
     * @returns {void}
     */
    #teardown() {
        if (this.#previewTimer !== 0) {
            clearTimeout(this.#previewTimer);
            this.#previewTimer = 0;
        }
        this.#observer?.disconnect();
        this.#observer = null;
        if (this.#onEscape) {
            window.removeEventListener('keydown', this.#onEscape, { capture: true });
            this.#onEscape = null;
        }
        this.removeEventListener('input', this.#onFormInput);
        this.removeEventListener('change', this.#onFormInput);
        if (this.#onCharacterDeleted) {
            eventSource.removeListener(event_types.CHARACTER_DELETED, this.#onCharacterDeleted);
            this.#onCharacterDeleted = null;
        }
        this.#countTokens = null;
        this.#relocator.restoreAll();
        document.body.classList.remove('k-studio-open');
    }

    /* ── lifecycle ──────────────────────────────────────────────────────────── */

    firstUpdated() {
        this.#place();
        this.#observe();
        this.#refreshPreview();
        this.#focusFirstField();
    }

    /**
     * Borrows every control the manifest names, in manifest order.
     *
     * Missing nodes are WARNED about, never thrown on: a core update that renames one control
     * must cost that one field, not the whole surface. The slot is left empty and everything
     * else still works.
     * @returns {void}
     */
    #place() {
        for (const slot of allSlots(this.mode)) {
            const target = this.querySelector(`[data-slot="${CSS.escape(slot.key)}"]`);
            const node = document.querySelector(slot.selector);
            if (!(target instanceof Element)) {
                console.warn(`[k-card-studio] no slot rendered for "${slot.key}".`);
                continue;
            }
            if (!(node instanceof Element)) {
                if (!slot.optional) {
                    console.warn(`[k-card-studio] core control "${slot.selector}" is missing; the "${slot.key}" field is empty.`);
                }
                continue;
            }
            this.#relocator.relocate(node, target);
            if (slot.counter) {
                const counter = document
                    .querySelector(`[data-token-counter="${CSS.escape(slot.counter)}"]`)
                    ?.closest('.extension_token_counter');
                this.#relocator.relocate(counter, target);
            }
        }
    }

    /**
     * Watches the three core nodes that change WITHOUT firing an `input` event we would hear.
     *
     * - `#avatar_load_preview`'s `src` is written by `read_avatar_load()` after the crop popup
     *   resolves (`script.js:7842`), which is how a newly chosen portrait reaches the preview.
     * - `#tagList`'s children are re-rendered by the tag bindings on every add and remove.
     * - `#favorite_button`'s class is the fav state's only visible truth
     *   (`updateFavButtonState`, `script.js:9334`); the paired `#fav_checkbox` is a hidden
     *   input, and `.prop('checked')` on one is not something the DOM reports as a change.
     * @returns {void}
     */
    #observe() {
        const observer = new MutationObserver(() => this.#schedulePreview());
        const preview = document.getElementById('avatar_load_preview');
        if (preview) observer.observe(preview, { attributes: true, attributeFilter: ['src'] });
        const tagList = document.getElementById('tagList');
        if (tagList) observer.observe(tagList, { childList: true, subtree: true });
        const favorite = document.getElementById('favorite_button');
        if (favorite) observer.observe(favorite, { attributes: true, attributeFilter: ['class'] });
        this.#observer = observer;
    }

    /** Puts the caret where the work starts. @returns {void} */
    #focusFirstField() {
        const first = this.mode === 'create'
            ? this.querySelector('#character_name_pole')
            : this.querySelector('#description_textarea');
        if (first instanceof HTMLElement) {
            first.focus({ preventScroll: true });
        }
    }

    /* ── doors ──────────────────────────────────────────────────────────────── */

    /**
     * Closes the studio, which restores every borrowed control.
     *
     * `remove()` is the whole implementation: `disconnectedCallback()` is what puts the controls
     * back, so there is exactly one close path and no way to close without restoring.
     * @returns {void}
     */
    close() {
        this.remove();
    }

    /** @returns {{ open: boolean, mode: string, tab: string, borrowed: number, readiness: string, name: string }} */
    get state() {
        return {
            open: this.isConnected,
            mode: this.mode,
            tab: this._tab,
            borrowed: this.#relocator.size,
            readiness: `${this._ready.filled}/${this._ready.total}`,
            name: this._preview.name,
        };
    }

    /* ── preview ────────────────────────────────────────────────────────────── */

    /** Coalesces a burst of keystrokes into one repaint. @returns {void} */
    #schedulePreview() {
        if (this.#previewTimer !== 0) {
            return;
        }
        this.#previewTimer = setTimeout(() => {
            this.#previewTimer = 0;
            this.#refreshPreview();
        }, PREVIEW_THROTTLE_MS);
    }

    /**
     * Rebuilds the poster from whatever the real controls currently hold.
     *
     * Everything goes through `previewRow()` + `renderCard()` — the two seams slice C exported
     * for exactly this — so the preview is not a lookalike of the gallery card, it IS the
     * gallery card with a hand-built row. Anything that ever changes about the poster changes
     * here for free.
     * @returns {void}
     */
    #refreshPreview() {
        const name = readValue('#character_name_pole');
        const notes = readValue('#creator_notes_textarea');
        const creator = readValue('#creator_textarea');
        const version = readValue('#character_version_textarea');
        const avatar = readValue('#avatar_url_pole');

        // The epithet chain's first link has no form control in v0 (`kotatsu_title` is written
        // by nothing yet — doc §4 non-goals), so an existing card's authored title is read off
        // the record rather than invented as absent. A create-mode card simply starts at link 2.
        const existing = this.mode === 'edit' && this_chid !== undefined ? characters?.[this_chid] : null;
        // Link 4 of the chain is `data[power_user.aux_field || 'character_version']`, and the
        // studio can only offer the two of those fields the form actually carries. Any other
        // aux choice falls back to the version field rather than reading a value off the record
        // that the reader cannot see themselves editing.
        const aux = power_user?.aux_field === 'creator' ? creator : version;
        const epithet = buildEpithet({
            title: existing?.data?.extensions?.kotatsu_title,
            notes,
            creator,
            aux,
        });

        const loaded = document.getElementById('avatar_load_preview');
        const loadedSrc = loaded instanceof HTMLImageElement ? (loaded.getAttribute('src') ?? '') : '';
        // A freshly cropped portrait arrives as a data: URL and is the only honest thing to
        // show; a saved card is drawn full-res like every gallery poster; a card with neither
        // draws its initials tile rather than core's `img/ai4.png` placeholder, which would be
        // a stock silhouette pretending to be a portrait.
        const portrait = loadedSrc.startsWith('data:')
            ? loadedSrc
            : avatar && avatar !== 'none'
                ? `/characters/${encodeURIComponent(avatar)}`
                : '';

        const tags = [...document.querySelectorAll('#tagList .tag .tag_name')]
            .map(node => String(node.textContent ?? '').trim())
            .filter(Boolean);

        const favourite = document.getElementById('favorite_button');

        this._preview = previewRow({
            name,
            avatar,
            portrait,
            hue: accentHue(avatar || name),
            fav: favourite?.classList.contains('fav_on') ?? false,
            kicker: epithet.kicker,
            body: epithet.body,
            epithetSource: epithet.source,
            tags,
            assistant: false,
            lastChat: this.mode === 'edit' ? Number(existing?.date_last_chat ?? 0) : 0,
        });

        this._ready = readiness({
            name,
            description: readValue('#description_textarea'),
            personality: readValue('#personality_textarea'),
            scenario: readValue('#scenario_pole'),
            first_mes: readValue('#firstmessage_textarea'),
        });
    }

    /* ── interaction ────────────────────────────────────────────────────────── */

    /**
     * Escape closes the studio — but only when it is the outermost thing Escape could mean.
     *
     * Capture phase on `window`, so without a stand-down this would pre-empt core's whole
     * Escape cascade (`RossAscends-mods.js:1175-1265`, bubble phase) AND every popup opened
     * from inside the studio's own flows. It stands down for those, and only then consumes the
     * key — `stopImmediatePropagation()` rather than `stopPropagation()`, the lesson the
     * retired settings overlay paid for (the 8/25 two-sheets bug): consuming a key means all of
     * it, later siblings on this node included, or two surfaces close on one press.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleEscape(event) {
        if (event.key !== 'Escape' || !this.isConnected) {
            return;
        }
        // The crop popup and the alternate-greetings editor open OVER us and are ours to wait
        // for; a confirm dialog belongs to whatever asked for it.
        if (corePopupOpen()) return;
        // The branch map paints at 30000, above this sheet. If it is up, it is what the reader
        // is looking at.
        if (document.querySelector('k-branch-map')) return;
        // An open `<select>` swallows Escape itself; a Kotatsu tab button never should.
        event.stopImmediatePropagation();
        event.preventDefault();
        this.close();
    }

    /**
     * Saves through core's own submit path.
     *
     * A real `.click()` on `#create_button`, never a `form.submit()` and never a fetch of our
     * own: the button is an `<input type="submit">` whose activation runs core's
     * `$('#form_create').on('submit', …)` handler (`script.js:11753`), and that handler is the
     * only thing that knows about `crop_data`, the alternate-greetings splice, the fav
     * force-set (`script.js:10104`) and the create-vs-edit fork.
     *
     * Closing straight after the click is safe and was verified against the source rather than
     * assumed: `createOrEditCharacter()` builds its `FormData` SYNCHRONOUSLY at its top
     * (`script.js:10103`) before its first `await`, and form submission dispatches `submit`
     * synchronously inside `.click()` — so by the time this line runs, every borrowed control
     * has already been read. Everything core does afterwards addresses controls by id
     * (`script.js:10154-10180`, `:10195`, `:10207`), which is exactly what survives being put
     * back where it came from.
     *
     * The one case that does NOT close: a create with an empty name. Core rejects it with a
     * toast (`script.js:10116`) and the reader needs the sheet still in front of them.
     * @returns {void}
     */
    #onSave() {
        const button = document.getElementById('create_button');
        if (!button) {
            console.warn('[k-card-studio] #create_button is missing; the save path is unavailable.');
            return;
        }
        const nameless = this.mode === 'create' && readValue('#character_name_pole').trim().length === 0;
        button.click();
        if (nameless) {
            return;
        }
        this.close();
    }

    /* ── render ─────────────────────────────────────────────────────────────── */

    render() {
        const tab = TABS.find(entry => entry.id === this._tab) ?? TABS[0];
        return html`
            <div class="k-studio-scrim" @click=${() => this.close()}></div>
            <div class="k-studio-sheet" role="dialog" aria-modal="true" aria-label=${this.#title()}>
                ${this.#renderHead()}
                <div class="k-studio-grid">
                    ${this.#renderRail()}
                    <section class="k-studio-pane">
                        ${this.#renderTabStrip()}
                        <p class="k-studio-blurb">${tab.blurb}</p>
                        <div class="k-studio-panels">
                            ${TABS.map(entry => this.#renderPanel(entry))}
                        </div>
                    </section>
                </div>
                ${this.#renderFoot()}
            </div>`;
    }

    /** @returns {string} The serif title, from the manifest's one formatter. */
    #title() {
        const name = this.mode === 'edit' && this_chid !== undefined
            ? characters?.[this_chid]?.name
            : '';
        return modeTitle(this.mode === 'edit' ? 'edit' : 'create', name);
    }

    /** @returns {unknown} Eyebrow, serif title, close ×. */
    #renderHead() {
        return html`
            <header class="k-studio-head">
                <div class="k-studio-head-copy">
                    <span class="k-studio-eyebrow">Card studio</span>
                    <h2 class="k-studio-title">${this.#title()}</h2>
                </div>
                <button type="button" class="k-studio-close" title="Close (Escape)" aria-label="Close the card studio"
                    @click=${() => this.close()}>${icons.close}</button>
            </header>`;
    }

    /** @returns {unknown} The live preview, the portrait button, the fav toggle, the meter. */
    #renderRail() {
        const { filled, total, missing } = this._ready;
        const percent = Math.round((filled / total) * 100);
        const note = missing.length === 0
            ? 'Every field a card wants is filled.'
            : `Still blank: ${missing.join(', ')}.`;
        return html`
            <aside class="k-studio-rail">
                <div class="k-studio-preview" aria-hidden="true">
                    ${renderCard(this._preview, this.#previewHandlers)}
                </div>

                <div class="k-studio-railtools">
                    <div class="k-studio-slot k-studio-slot--portrait" data-slot=${RAIL_SLOTS[0].key}></div>
                    <span class="k-studio-portrait-label">Replace portrait</span>
                    <div class="k-studio-slot k-studio-slot--fav" data-slot=${RAIL_SLOTS[1].key}></div>
                </div>

                <div class="k-studio-ready">
                    <div class="k-studio-ready-head">
                        <span class="k-studio-ready-label">Readiness</span>
                        <span class="k-studio-ready-score">${filled}/${total}</span>
                    </div>
                    <div class="k-studio-ready-track" role="presentation">
                        <i class="k-studio-ready-fill" style=${`width: ${percent}%;`}></i>
                    </div>
                    <p class="k-studio-ready-note">${note}</p>
                    <p class="k-studio-ready-fineprint">Encouragement, not validation — only a name is required.</p>
                </div>
            </aside>`;
    }

    /** @returns {unknown} The four tab buttons. */
    #renderTabStrip() {
        return html`
            <div class="k-studio-tabs" role="tablist" aria-label="Card sections">
                ${TABS.map(tab => html`
                    <button
                        type="button"
                        role="tab"
                        id=${`k-studio-tab-${tab.id}`}
                        class="k-studio-tab${this._tab === tab.id ? ' is-active' : ''}"
                        aria-selected=${this._tab === tab.id ? 'true' : 'false'}
                        aria-controls=${`k-studio-panel-${tab.id}`}
                        @click=${() => { this._tab = tab.id; }}
                    >${tab.label}</button>`)}
            </div>`;
    }

    /**
     * Renders one tab panel.
     *
     * ALL FOUR panels are rendered on every pass and hidden with an attribute, never rendered
     * conditionally. That is the load-bearing decision of this whole file: the borrowed controls
     * live inside these panels, and a conditional `${…}` would make lit-html the owner of that
     * subtree — it would tear the panel down on a tab switch and take a borrowed core control
     * out of the document with it, with the studio's ledger still claiming it was safely in a
     * slot. A slot element with no binding inside it has no ChildPart, so lit-html never touches
     * its children, and the controls sit still while the tabs move.
     * @param {import('./manifest.js').StudioTab} tab The tab to draw.
     * @returns {unknown} A Lit template.
     */
    #renderPanel(tab) {
        const active = this._tab === tab.id;
        return html`
            <div
                class="k-studio-panel"
                id=${`k-studio-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby=${`k-studio-tab-${tab.id}`}
                ?hidden=${!active}
            >${tab.fields.map(field => this.#renderField(field))}</div>`;
    }

    /**
     * @param {import('./manifest.js').StudioField} field One labelled row.
     * @returns {unknown} A Lit template, or nothing when the field belongs to the other mode.
     */
    #renderField(field) {
        if (field.only && field.only !== this.mode) {
            return nothing;
        }
        const kind = field.kind ?? 'field';
        const body = kind === 'readonly'
            ? html`<p class="k-studio-readonly">${this._preview.name}</p>`
            : field.slots.map(slot => html`<div class="k-studio-slot" data-slot=${slot.key}></div>`);
        return html`
            <div class="k-studio-field k-studio-field--${kind}${field.span === 'half' ? ' is-half' : ''}">
                <div class="k-studio-labelrow">
                    <span class="k-studio-label">${field.label}</span>
                    ${field.hint ? html`<span class="k-studio-hint">${field.hint}</span>` : nothing}
                </div>
                <div class="k-studio-control">${body}</div>
            </div>`;
    }

    /** @returns {unknown} Delete (real, edit-only by core's own display) · Cancel · Save. */
    #renderFoot() {
        return html`
            <footer class="k-studio-foot">
                <div class="k-studio-slot k-studio-slot--delete" data-slot=${FOOTER_SLOTS[0].key}></div>
                <div class="k-studio-foot-spacer"></div>
                <button type="button" class="k-lib-btn k-lib-btn--ghost k-studio-cancel"
                    @click=${() => this.close()}>Cancel</button>
                <button type="button" class="k-lib-btn k-lib-btn--primary k-studio-save"
                    @click=${() => this.#onSave()}
                >${icons.check}<span>${this.mode === 'edit' ? 'Save changes' : 'Create character'}</span></button>
            </footer>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-card-studio')) {
    customElements.define('k-card-studio', KCardStudio);
}

/* ── the host: one document door, no permanently mounted element ──────────── */

/** @type {boolean} */
let installed = false;

/** @type {((event: Event) => void)|null} */
let onOpenRequest = null;

/** @returns {KCardStudio|null} The mounted studio, or null. */
function currentStudio() {
    const element = document.querySelector('k-card-studio');
    return element instanceof KCardStudio ? element : null;
}

/**
 * Reads the mode straight off the form, never off a variable of ours.
 *
 * `#form_create[actiontype]` is written by `select_rm_create()` (`script.js:9245`) and
 * `select_selected_character()` (`script.js:9169`), which are the same two functions that fill
 * every field. Asking the form is asking the thing that actually decided.
 * @returns {'create'|'edit'} The current mode.
 */
export function studioMode() {
    const form = document.getElementById('form_create');
    return form?.getAttribute('actiontype') === 'editcharacter' ? 'edit' : 'create';
}

/**
 * Opens the studio.
 *
 * `'create'` fires a REAL click on `#rm_button_create` first — three independent handlers hang
 * off it (`script.js:11525`, `RossAscends-mods.js:207`, the delegated `tags.js:2779`) and only a
 * real click fires all three; all three are synchronous, so the form is in create mode by the
 * time the click returns. Unlike slice C's route there is no settings-rack reveal: the studio IS
 * the surface now, and revealing the drawer behind it would put the same form on screen twice.
 *
 * A chid opens EDIT mode, which requires the character to be ACTIVE — `this_chid` is what
 * `#delete_button`, the alternate-greetings popup and the edit branch of
 * `createOrEditCharacter()` all read. `selectCharacterById()` is the only way to set it, and it
 * opens that character's chat behind the sheet. That is the documented v0 reality (doc §2.1
 * item 5), not an accident: opening the editor WITHOUT selecting is an edit-state rework and is
 * on the chip list, not in v0.
 * @param {'create'|number|string} [target] `'create'`, or a character index.
 * @returns {Promise<KCardStudio|null>} The mounted studio, or null if it could not open.
 */
export async function openStudio(target = 'create') {
    const existing = currentStudio();
    if (existing) {
        return existing;
    }

    if (target === 'create') {
        const button = document.getElementById('rm_button_create');
        if (!button) {
            console.warn('[k-card-studio] #rm_button_create is missing; cannot enter create mode.');
            return null;
        }
        button.click();
    } else {
        const index = Number(target);
        if (!Number.isInteger(index) || index < 0) {
            console.warn(`[k-card-studio] "${String(target)}" is not a character index.`);
            return null;
        }
        try {
            await selectCharacterById(index);
        } catch (error) {
            console.error('[k-card-studio] could not select the character to edit', error);
            return null;
        }
    }

    // A previously opened Advanced Definitions panel is holding an empty box the moment we
    // borrow its children, so it is closed through core's own path first. `#character_cross`
    // is core's close button and its handler resets `is_advanced_char_open`
    // (`script.js:11690`) — hiding the block by hand would leave that flag lying.
    if (document.getElementById('character_popup')?.classList.contains('open')) {
        document.getElementById('character_cross')?.click();
    }

    const studio = /** @type {KCardStudio} */ (document.createElement('k-card-studio'));
    studio.setAttribute('variant', 'sheet');
    studio.mode = studioMode();
    document.body.appendChild(studio);
    return studio;
}

/** @returns {void} */
export function closeStudio() {
    currentStudio()?.close();
}

/** @returns {object|null} The console door's `.state`. */
export function studioState() {
    return currentStudio()?.state ?? null;
}

/**
 * Wires the document-level open door. Called by the rails layout's `mount()`.
 *
 * Listeners only — the element is created on the first open request and removed from the DOM on
 * close, so nothing is mounted and nothing is borrowed until someone asks. Idempotent: a shell
 * reload must not stack a second listener.
 * @returns {void}
 */
export function installStudio() {
    if (installed) {
        return;
    }
    installed = true;
    onOpenRequest = (event) => {
        const detail = /** @type {CustomEvent} */ (event).detail;
        void openStudio(detail?.target ?? 'create');
    };
    document.addEventListener(OPEN_STUDIO_EVENT, onOpenRequest);
}

/**
 * Removes every listener and node this module added, and — critically — CLOSES an open studio,
 * which is what puts the borrowed controls back.
 *
 * Called by the rails layout's `unmount()` BEFORE `ctx.restoreAll()`: the layout is about to
 * hand `#sheld` and the drawer rack back to classic, and it must hand them back whole.
 * @returns {void}
 */
export function uninstallStudio() {
    closeStudio();
    if (!installed) {
        return;
    }
    installed = false;
    if (onOpenRequest) {
        document.removeEventListener(OPEN_STUDIO_EVENT, onOpenRequest);
        onOpenRequest = null;
    }
}
