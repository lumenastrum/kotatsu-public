/**
 * `<k-card-studio variant="sheet">` — the creation/edit surface. v2: a character PAGE, not ST's
 * settings form (`docs/card-studio-v2.md`, #16); v0 was library v0 slice D (`docs/library-v0.md` §2).
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
 * ── v2: one page of chapters, Simple and Advanced ─────────────────────────────────────────
 * The manifest's six chapters render top to bottom in one scroll, with a chapter bar that
 * follows it. Simple shows four; Advanced adds the character's world and the levers under the
 * hood. EVERY chapter and EVERY field is rendered on every pass and hidden with an attribute —
 * the load-bearing rule v0 learned with its tab panels, and the reason the view switch is a
 * `hidden` binding and never a template branch: a conditional `${…}` would make lit-html the
 * owner of a subtree that holds a borrowed core control, and the next render would tear it out
 * of the document with the ledger still claiming it was safely in a slot.
 *
 * ── What relocation does NOT carry, and what we do about it ───────────────────────────────
 * 1. **Token counting.** The trigger is delegated on the blocks themselves —
 *    `$('#rm_ch_create_block').on('input', …)` and `$('#character_popup').on('input', …)`
 *    (`RossAscends-mods.js:211-213`). Relocate the textareas out and typing stops re-counting,
 *    even though `RA_CountCharTokens()` itself is entirely id-based
 *    (`RossAscends-mods.js:221-228`). The studio runs its OWN debounced call on its own `input`
 *    listener: it re-hosts the trigger, never the work. The header's token chip then READS the
 *    counters core wrote (`manifest.js` `tokenBudget`), so it can never disagree with them.
 * 2. **Spoiler-free peeking.** `peekSpoilerMode()` toggles wrappers the studio left behind, so
 *    the studio has its own eye: it blurs the story fields inside the sheet until one is focused.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────────────────
 * A fixed, centred modal sheet over a scrim, appended to `<body>` so no ancestor `filter` /
 * `transform` can turn `position: fixed` into a containing block under it. Created on open,
 * removed on close: `disconnectedCallback()` restores every borrowed control synchronously
 * before anything else can run. Light DOM, `variant` attribute from day one (SPEC §13), every
 * rule in `public/css/studio.css` scoped `body[data-k-layout="rails"]`.
 *
 * One-way imports: kotatsu → core. Nothing in core imports this file; the rails layout installs
 * it and the library opens it.
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import {
    characters,
    create_save,
    selectCharacterById,
    substituteParams,
    this_chid,
} from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { RA_CountCharTokens } from '../../scripts/RossAscends-mods.js';
import { power_user } from '../../scripts/power-user.js';
import { debounce } from '../../scripts/utils.js';
import { debounce_timeout } from '../../scripts/constants.js';
import { accountStorage } from '../../scripts/util/AccountStorage.js';
import { buildEpithet } from '../library/epithet.js';
import { TONGUES } from '../pictures/contract.js';
import { cardArtUrl, defaultLookFor, getLook, normalizeLook, saveLook } from '../pictures/look.js';
import { listLoras } from '../pictures/jobs-client.js';
import { LORA_BASE_NAMES, MAX_LORAS, normalizeLoras } from '../pictures/picture-model.js';
import { SPRITES_EVENT, readSpriteSet, spriteFolderFor } from '../sprites/sprite-sets.js';
import {
    CHAPTERS,
    DROPDOWN_ACTIONS,
    HOOD_CHAPTER,
    OPEN_STUDIO_EVENT,
    STUDIO_VIEW_KEY,
    advancedInUse,
    allSlots,
    chapterDone,
    chapterNumber,
    levelOf,
    modeTitle,
    named,
    nextStep,
    readiness,
    shortName,
    tokenBudget,
} from './manifest.js';
import { TAGLINE_MAX, getTagline, saveTagline } from './tagline.js';
import { clampOpening, flipOpening, listOpenings, macroOptions, openingExcerpt, openingLabel } from './openings.js';

// Defines <k-sprite-studio> (③'s body) and gives the hero the main feelings' order.
import { MAIN_LABELS } from '../sprites/k-sprite-studio.js';
// Defines <k-opening-preview> (②'s first message, as the chat renders it).
import { OPENING_FLIP_EVENT } from './k-opening-preview.js';

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
 * every one of those in-page surfaces must paint under it. It stays BELOW `dialog.popup` (9999)
 * on purpose and by necessity: the crop popup and the alternate-greetings editor are
 * `<dialog showModal()>` (`popup.js:623,685`), they open OVER the studio as part of its own
 * flows, and the top layer beats any z-index anyway.
 */
export const STUDIO_Z = Object.freeze({ scrim: 4100, sheet: 4101 });

/** How long the hero coalesces a burst of keystrokes. One frame's worth, not a debounce. */
const PREVIEW_THROTTLE_MS = 60;

/**
 * Stroke-only icons. No Font Awesome, no emoji (repo CLAUDE.md). The borrowed core controls
 * keep their own Font Awesome classes — those are core's markup and the studio does not restyle
 * a glyph it did not draw.
 */
// The paths are `svg` fragments, not `html` ones: an `html` template parses `<path>` in the HTML
// namespace, where it is an unknown element that never draws.
const icon = (/** @type {unknown} */ body, size = 16) => html`
    <svg class="k-studio-icon" viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const icons = {
    close: icon(svg`<path d="M18 6 6 18M6 6l12 12" />`, 15),
    check: icon(svg`<path d="M20 6 9 17l-5-5" />`, 14),
    eye: icon(svg`<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />`, 17),
    eyeOff: icon(svg`<path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" />`, 17),
    dots: html`<svg class="k-studio-icon" viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>`,
    gear: icon(svg`<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />`, 15),
    persona: icon(svg`<circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />`, 17),
    book: icon(svg`<path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M8 7h7M8 11h5" />`, 17),
    layers: icon(svg`<path d="m12 3 9 5-9 5-9-5 9-5z" /><path d="m3 13 9 5 9-5" />`, 17),
    pen: icon(svg`<path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />`, 14),
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
 * (`popup.js:623`) — the crop dialog, the alternate-greetings editor, the world and persona
 * pickers the studio's proxies open, and every confirm — and `#shadow_popup` is the legacy one
 * still used by a handful of paths.
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

/** @returns {boolean} The reader asked for less motion: core's Reduced motion, or the OS setting. */
function reducedMotion() {
    if (power_user?.reduced_motion) return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The options of `#char-management-dropdown` the studio places somewhere specific; the rest are
 * offered in the card menu as they are.
 * @type {ReadonlySet<string>}
 */
const PLACED_OPTIONS = new Set(Object.values(DROPDOWN_ACTIONS));

/**
 * The card studio.
 */
export class KCardStudio extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `sheet` is the only variant. */
        variant: { type: String, reflect: true },
        /** Reflected so `public/css/studio.css` can key the mode without a class dance. */
        mode: { type: String, reflect: true },
        /** `simple` | `advanced`, reflected for the same reason. */
        view: { type: String, reflect: true },
        _chapter: { state: true },
        _menuOpen: { state: true },
        _tokensOpen: { state: true },
        _spoilers: { state: true },
        _name: { state: true },
        _portrait: { state: true },
        _ready: { state: true },
        _step: { state: true },
        _inUse: { state: true },
        _budget: { state: true },
        _stage: { state: true },
        _picked: { state: true },
        _heroLabels: { state: true },
        _tagline: { state: true },
        _taglineHint: { state: true },
        _taglineError: { state: true },
        _extensionActions: { state: true },
        _openings: { state: true },
        _opening: { state: true },
        _beginEdit: { state: true },
        _heroUnpinned: { state: true },
        _look: { state: true },
        _lookError: { state: true },
        _loraList: { state: true },
        _loraError: { state: true },
    };

    /**
     * The look as it stood when the studio opened, serialized; the save path writes the look only
     * when the fields differ from it, so a bare open/close (the byte gates' cycle) writes nothing.
     * @type {string}
     */
    #lookAtOpen = '';

    /** @type {string} The tagline as it stood at open, same rule as the look. */
    #taglineAtOpen = '';

    /** @type {Relocator} */
    #relocator = new Relocator();

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** @type {MutationObserver|null} Watches the core nodes that change without an `input`. */
    #observer = null;

    /** @type {MutationObserver|null} Watches core's token counters, so the chip follows them. */
    #counterObserver = null;

    /** @type {IntersectionObserver|null} Which chapter the page is on. */
    #chapterObserver = null;

    /** @type {ResizeObserver|null} Whether the pinned hero still fits (see `#fitHero`). */
    #heroObserver = null;

    /** @type {number} `setTimeout` handle for the coalesced refresh, 0 = idle. */
    #previewTimer = 0;

    /** @type {(() => void)|null} The studio's re-hosted token-count trigger. See the header. */
    #countTokens = null;

    /** @type {(event: Event) => void} */
    #onFormInput;

    /** @type {(() => void)|null} Closes the sheet when the card it is editing stops existing. */
    #onCharacterDeleted = null;

    /** @type {((event: Event) => void)|null} Re-reads the hero's sprites when a set changes. */
    #onSpritesChanged = null;

    /** @type {((event: Event) => void)|null} Core's popups close: the openings may have changed. */
    #onDialogClose = null;

    /**
     * "+ Another opening" is waiting for core's popup to close, to show the new one: the opening
     * count when the editor opened, or false.
     * @type {number|false}
     */
    #showNewOpening = false;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {'create'|'edit'} */
        this.mode = 'create';
        /** @type {'simple'|'advanced'} */
        this.view = 'simple';
        this._chapter = CHAPTERS[0].id;
        this._menuOpen = false;
        this._tokensOpen = false;
        this._spoilers = false;
        this._name = '';
        /** @type {string} The card art to show: a fresh crop (data:), the saved file, or ''. */
        this._portrait = '';
        /** @type {{ filled: number, total: number, missing: string[] }} */
        this._ready = readiness({});
        /** @type {ReturnType<typeof nextStep>} */
        this._step = nextStep({});
        /** @type {string[]} */
        this._inUse = [];
        /** @type {ReturnType<typeof tokenBudget>} */
        this._budget = tokenBudget([]);
        /** @type {'sprite'|'art'} */
        this._stage = 'sprite';
        this._picked = '';
        /** @type {Map<string, string>} The full-body set, label → url. */
        this._heroLabels = new Map();
        this._tagline = '';
        this._taglineHint = '';
        this._taglineError = '';
        /** @type {{ id: string, label: string }[]} Options an extension (or a later core) added to the dropdown. */
        this._extensionActions = [];
        /** @type {string[]} Every opening's raw text: the first message, then the alternates. */
        this._openings = [''];
        /** Which opening ② shows (0 = the first message). */
        this._opening = 0;
        /** ② shows the first message's textarea beside its preview. */
        this._beginEdit = false;
        /** The window is too short to pin the hero: it scrolls away with the page instead. */
        this._heroUnpinned = false;
        /** @type {ReturnType<typeof normalizeLook>} */
        this._look = normalizeLook(null);
        /** @type {string} */
        this._lookError = '';
        /** @type {import('../pictures/picture-model.js').LoraInfo[]|null} */
        this._loraList = null;
        this._loraError = '';
        this.#onFormInput = (event) => {
            // Kotatsu's own fields (the Look, the tagline) are outside the card form: their
            // keystrokes neither repaint the hero nor re-count the card's tokens.
            if (event?.target instanceof Element && event.target.closest('.k-studio-look, .k-studio-tagline')) return;
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
        this.view = this.#storedView();
        // The debounced counter is built per element rather than at module scope so a studio
        // that closes mid-debounce takes its pending call with it. `debounce_timeout.relaxed`
        // is the exact cadence core uses for the same job (`RossAscends-mods.js:73`).
        this.#countTokens = debounce(() => { void RA_CountCharTokens(); }, debounce_timeout.relaxed);

        // Window, capture phase — one rung above every other Escape listener in the document.
        // The library, the settings overlay and the AN sheet all listen on `document` in
        // capture, and capture runs window → document, so this handler is guaranteed to see
        // Escape first no matter what order those three were installed in.
        this.#onEscape = (event) => this.#handleEscape(event);
        window.addEventListener('keydown', this.#onEscape, { capture: true });

        this.addEventListener('input', this.#onFormInput);
        this.addEventListener('change', this.#onFormInput);
        this.addEventListener('k-sprite-pick', this.#onSpritePick);

        // Delete is REAL (it lives in the card menu), so it can delete the card out from under
        // the sheet. Core then reveals the character list and the studio would be left editing a
        // file that no longer exists — a form whose save would recreate it. One event, one close.
        this.#onCharacterDeleted = () => this.close();
        eventSource.on(event_types.CHARACTER_DELETED, this.#onCharacterDeleted);

        this.#onSpritesChanged = () => void this.#loadHero();
        document.addEventListener(SPRITES_EVENT, this.#onSpritesChanged);

        this.addEventListener(OPENING_FLIP_EVENT, this.#onOpeningFlip);

        // Core's alternate-greetings editor writes the array as you type and saves on close; its
        // keystrokes happen in a top-layer dialog outside the studio, so the studio re-reads when
        // a dialog closes. `close` does not bubble: capture is how a document listener hears it.
        this.#onDialogClose = () => this.#openingsClosed();
        document.addEventListener('close', this.#onDialogClose, { capture: true });

        document.body.classList.add('k-studio-open');
    }

    disconnectedCallback() {
        // SYNCHRONOUS, and deliberately before `super`: the rails layout removes this element
        // and then calls `ctx.restoreAll()`, so every borrowed control has to be back inside
        // `#rm_ch_create_block` / `#character_popup` by the time this call returns — otherwise
        // the layout restores those blocks to classic with holes in them.
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
        this.#counterObserver?.disconnect();
        this.#counterObserver = null;
        this.#chapterObserver?.disconnect();
        this.#chapterObserver = null;
        this.#heroObserver?.disconnect();
        this.#heroObserver = null;
        if (this.#onEscape) {
            window.removeEventListener('keydown', this.#onEscape, { capture: true });
            this.#onEscape = null;
        }
        this.removeEventListener('input', this.#onFormInput);
        this.removeEventListener('change', this.#onFormInput);
        this.removeEventListener('k-sprite-pick', this.#onSpritePick);
        if (this.#onCharacterDeleted) {
            eventSource.removeListener(event_types.CHARACTER_DELETED, this.#onCharacterDeleted);
            this.#onCharacterDeleted = null;
        }
        if (this.#onSpritesChanged) {
            document.removeEventListener(SPRITES_EVENT, this.#onSpritesChanged);
            this.#onSpritesChanged = null;
        }
        this.removeEventListener(OPENING_FLIP_EVENT, this.#onOpeningFlip);
        if (this.#onDialogClose) {
            document.removeEventListener('close', this.#onDialogClose, { capture: true });
            this.#onDialogClose = null;
        }
        this.#countTokens = null;
        this.#relocator.restoreAll();
        document.body.classList.remove('k-studio-open');
    }

    /* ── lifecycle ──────────────────────────────────────────────────────────── */

    firstUpdated() {
        this.#place();
        this.#observe();
        this.#observeCounters();
        this.#observeChapters();
        this.#observeHero();
        this.#readDropdown();
        this.#refreshPreview();
        this.#loadLook();
        this.#loadTagline();
        void this.#loadHero();
        // Core counted when the card was selected, but a create-mode form and a just-relocated
        // set of counters deserve a fresh count the chip can read.
        void RA_CountCharTokens();
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
     * Watches the core nodes that change WITHOUT firing an `input` event we would hear.
     *
     * - `#avatar_load_preview`'s `src` is written by `read_avatar_load()` after the crop popup
     *   resolves (`script.js:7842`), which is how a newly chosen portrait reaches the hero.
     * - `#favorite_button`'s class is the fav state's only visible truth (`updateFavButtonState`,
     *   `script.js:9334`).
     * - `#character_world`'s value is written by the lorebook picker the ⑤ proxy opens.
     * @returns {void}
     */
    #observe() {
        const observer = new MutationObserver(() => this.#schedulePreview());
        const preview = document.getElementById('avatar_load_preview');
        if (preview) observer.observe(preview, { attributes: true, attributeFilter: ['src'] });
        const favorite = document.getElementById('favorite_button');
        if (favorite) observer.observe(favorite, { attributes: true, attributeFilter: ['class'] });
        const world = document.getElementById('character_world');
        if (world) observer.observe(world, { attributes: true, attributeFilter: ['value'] });
        this.#observer = observer;
    }

    /**
     * Core writes every count as the text of a `[data-token-counter]` node
     * (`RossAscends-mods.js:215`); the chip re-reads them whenever one changes.
     * @returns {void}
     */
    #observeCounters() {
        const observer = new MutationObserver(() => this.#refreshBudget());
        for (const counter of document.querySelectorAll('[data-token-counter]')) {
            observer.observe(counter, { childList: true, characterData: true, subtree: true });
        }
        this.#counterObserver = observer;
        this.#refreshBudget();
    }

    /** Re-reads core's counters into the chip. @returns {void} */
    #refreshBudget() {
        const readings = [...document.querySelectorAll('[data-token-counter]')].map(node => ({
            id: String(node.getAttribute('data-token-counter') ?? ''),
            count: Number.parseInt(String(node.textContent ?? '').replace(/[^0-9]/g, ''), 10) || 0,
            permanent: node.getAttribute('data-token-permanent') === 'true',
        }));
        this._budget = tokenBudget(readings);
    }

    /**
     * The chapter bar follows the scroll: the chapter whose top crossed the upper third of the page
     * is the current one.
     * @returns {void}
     */
    #observeChapters() {
        if (typeof IntersectionObserver !== 'function') return;
        // Root = the viewport, not the page: the body is what scrolls (studio.css §4), and the
        // viewport is the one root that stays right whichever box a layout makes the scroller.
        // The sheet is fixed and covers it, so "the upper third of the viewport" is the sheet's.
        const observer = new IntersectionObserver((entries) => {
            const visible = entries
                .filter(entry => entry.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
            const id = visible[0]?.target.getAttribute('data-chapter');
            if (id) this._chapter = id;
        }, { root: null, rootMargin: '0px 0px -66% 0px' });
        for (const section of this.querySelectorAll('.k-studio-chapter')) observer.observe(section);
        this.#chapterObserver = observer;
    }

    /**
     * The hero is pinned beside the page and never scrolls on its own (studio.css §4): its stage
     * gives height down to a floor so the rest fits. Below that, pinning would clip it, so the hero
     * is unpinned and scrolls away with the page. Measured, not a fixed breakpoint: tags and names
     * wrap, and the feelings row exists only with sprites. Watches the body (the window) and every
     * row of the hero (its content).
     * @returns {void}
     */
    #observeHero() {
        if (typeof ResizeObserver !== 'function') return;
        const body = this.querySelector('.k-studio-body');
        const hero = this.querySelector('.k-studio-hero');
        if (!body || !hero) return;
        const observer = new ResizeObserver(() => this.#fitHero());
        observer.observe(body);
        for (const row of hero.children) observer.observe(row);
        this.#heroObserver = observer;
    }

    /** @returns {void} */
    #fitHero() {
        const body = this.querySelector('.k-studio-body');
        const hero = this.querySelector('.k-studio-hero');
        const stage = hero?.querySelector('.k-studio-stage');
        if (!(body instanceof HTMLElement) || !(hero instanceof HTMLElement) || !(stage instanceof HTMLElement)) return;
        // The hero's height with the stage at its floor. Pinned and clipped, scrollHeight still
        // counts the clipped rows; unpinned, the stage sits at full height and is subtracted back.
        const floor = parseFloat(getComputedStyle(stage).minHeight) || 0;
        const need = hero.scrollHeight - stage.offsetHeight + floor;
        const unpinned = need > body.clientHeight + 1;
        if (unpinned !== this._heroUnpinned) this._heroUnpinned = unpinned;
    }

    /**
     * Lists the dropdown options the studio does not place somewhere specific — an extension's
     * entries, or one a later core adds — so the card menu can offer them unchanged.
     * @returns {void}
     */
    #readDropdown() {
        const select = document.getElementById('char-management-dropdown');
        if (!(select instanceof HTMLSelectElement)) return;
        this._extensionActions = [...select.options]
            .filter(option => option.id && !option.disabled && !PLACED_OPTIONS.has(option.id))
            .map(option => ({ id: option.id, label: String(option.textContent ?? '').trim() || option.id }));
    }

    /**
     * Runs one of core's dropdown actions through core's own handler (`script.js:12852`): select
     * the option, fire `change`. Core resets the dropdown to its placeholder afterwards.
     * @param {string} optionId
     * @returns {void}
     */
    #runDropdown(optionId) {
        const select = document.getElementById('char-management-dropdown');
        const option = select?.querySelector(`#${CSS.escape(optionId)}`);
        if (!(select instanceof HTMLSelectElement) || !(option instanceof HTMLOptionElement)) {
            console.warn(`[k-card-studio] core's "${optionId}" action is missing.`);
            return;
        }
        this._menuOpen = false;
        option.selected = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
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

    /** @returns {{ open: boolean, mode: string, view: string, chapter: string, borrowed: number, readiness: string, name: string, tokens: number }} */
    get state() {
        return {
            open: this.isConnected,
            mode: this.mode,
            view: this.view,
            chapter: this._chapter,
            borrowed: this.#relocator.size,
            readiness: `${this._ready.filled}/${this._ready.total}`,
            name: this._name,
            tokens: this._budget.total,
        };
    }

    /* ── the view ───────────────────────────────────────────────────────────── */

    /** @returns {'simple'|'advanced'} */
    #storedView() {
        try {
            return accountStorage.getItem(STUDIO_VIEW_KEY) === 'advanced' ? 'advanced' : 'simple';
        } catch {
            return 'simple';
        }
    }

    /** @param {'simple'|'advanced'} view */
    #setView(view) {
        this.view = view;
        try {
            accountStorage.setItem(STUDIO_VIEW_KEY, view);
        } catch {
            // The choice is a convenience; a storage that refuses it costs nothing but the memory.
        }
    }

    /**
     * Scrolls the page to a chapter. An Advanced chapter asked for from Simple switches the view
     * first — the greyed ⑤ in Simple's bar is a door, not a dead end.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async #goTo(id) {
        const chapter = CHAPTERS.find(entry => entry.id === id);
        if (chapter?.level === 'advanced' && this.view === 'simple') {
            this.#setView('advanced');
            await this.updateComplete;
        }
        this._chapter = id;
        // The page scrolls itself, never via `scrollIntoView()`: that scrolls EVERY scrollable
        // ancestor, and the sheet (overflow hidden, still script-scrollable) slid its own header
        // out of sight (found 2026-10-19 on the first Advanced run).
        const section = this.querySelector(`#k-studio-ch-${CSS.escape(id)}`);
        const scroller = this.#scroller();
        if (scroller && section instanceof HTMLElement) {
            const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
            scroller.scrollTo({ top: Math.max(0, top - 4), behavior: reducedMotion() ? 'auto' : 'smooth' });
        }
    }

    /**
     * The element that scrolls the chapters: the body, on every width since the hero stopped
     * scrolling on its own (2026-10-19, studio.css §4). The page is still asked first so a pack or
     * a later layout that makes it the scroller keeps working.
     * @returns {HTMLElement|null}
     */
    #scroller() {
        for (const selector of ['.k-studio-page', '.k-studio-body']) {
            const element = this.querySelector(selector);
            if (element instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(element).overflowY)) return element;
        }
        return null;
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
     * Re-reads everything the hero, the next-step strip and the Simple notice show, from whatever
     * the real controls currently hold.
     * @returns {void}
     */
    #refreshPreview() {
        const name = readValue('#character_name_pole');
        const avatar = readValue('#avatar_url_pole');
        const existing = this.#editedCard();
        this._name = this.mode === 'edit' ? String(existing?.name ?? name) : name;

        const loaded = document.getElementById('avatar_load_preview');
        const loadedSrc = loaded instanceof HTMLImageElement ? (loaded.getAttribute('src') ?? '') : '';
        // A freshly cropped portrait arrives as a data: URL and is the only honest thing to
        // show; a saved card is drawn full-res; a card with neither shows its initials rather than
        // core's `img/ai4.png` placeholder, a stock silhouette pretending to be a portrait.
        this._portrait = loadedSrc.startsWith('data:')
            ? loadedSrc
            : avatar && avatar !== 'none'
                ? `/characters/${encodeURIComponent(avatar)}`
                : '';

        // The tagline's placeholder is what the library card shows when it is empty: the next
        // link of the epithet chain (`library/epithet.js`).
        const aux = power_user?.aux_field === 'creator' ? readValue('#creator_textarea') : readValue('#character_version_textarea');
        this._taglineHint = buildEpithet({
            title: '',
            notes: readValue('#creator_notes_textarea'),
            creator: readValue('#creator_textarea'),
            aux,
        }).kicker || '';

        const values = {
            name,
            description: readValue('#description_textarea'),
            personality: readValue('#personality_textarea'),
            scenario: readValue('#scenario_pole'),
            first_mes: readValue('#firstmessage_textarea'),
        };
        this._ready = readiness(values);
        const alternates = this.mode === 'edit' ? existing?.data?.alternate_greetings : create_save?.alternate_greetings;
        const openings = listOpenings(values.first_mes, alternates);
        this._openings = openings.map(opening => opening.text);
        this._opening = clampOpening(this._opening, openings.length);
        // Nothing to read yet = writing, and it STAYS writing once the first letter lands (a
        // textarea that vanished on the first keystroke would be the bug); Done editing ends it.
        if (!values.first_mes.trim()) this._beginEdit = true;
        this._step = nextStep({
            ...values,
            name: this._name,
            openings: openings.length - 1,
            mes_example: readValue('#mes_example_textarea'),
            spritesMissing: this.#spritesMissing(),
        });
        this._inUse = advancedInUse({
            world: readValue('#character_world'),
            depth_prompt: readValue('#depth_prompt_prompt'),
            system_prompt: readValue('#system_prompt_textarea'),
            post_history: readValue('#post_history_instructions_textarea'),
        });
    }

    /* ── ② the openings ─────────────────────────────────────────────────────── */

    /** The row's own swipe arrows, or the flipper. @param {Event} event */
    #onOpeningFlip = (event) => {
        const delta = Number(/** @type {CustomEvent} */ (event).detail?.delta) || 0;
        this.#flipOpening(delta);
    };

    /** @param {number} delta */
    #flipOpening(delta) {
        this._opening = flipOpening(this._opening, delta, this._openings.length);
    }

    /** A dialog closed: maybe core's openings editor. Re-read, and show a just-added opening. */
    #openingsClosed() {
        this.#refreshPreview();
        if (this.#showNewOpening !== false) {
            // Core's editor writes the array as it goes, so the count is compared with the one
            // taken when the editor opened, not with whatever a refresh in between saw.
            if (this._openings.length > this.#showNewOpening) this._opening = this._openings.length - 1;
            this.#showNewOpening = false;
        }
    }

    /**
     * Opens core's alternate-greetings editor through the borrowed button (the only
     * implementation), optionally pressing its own Add, then puts the caret in the opening asked for.
     * @param {{ add?: boolean, focus?: number }} [options] `focus` = an alternate's index in core's list.
     * @returns {void}
     */
    #openOpenings({ add = false, focus } = {}) {
        const button = this.querySelector('.open_alternate_greetings');
        if (!(button instanceof HTMLElement)) {
            console.warn('[k-card-studio] core\'s alternate-greetings button is missing.');
            return;
        }
        this.#showNewOpening = add ? this._openings.length : false;
        button.click();
        // Popup.show() builds the dialog synchronously and opens it on the next tick.
        requestAnimationFrame(() => {
            const dialogs = [...document.querySelectorAll('dialog.popup')].filter(dialog => dialog.querySelector('.alternate_greetings_list'));
            const dialog = dialogs[dialogs.length - 1];
            if (!dialog) return;
            if (add) dialog.querySelector('.add_alternate_greeting')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            const textareas = dialog.querySelectorAll('.alternate_greeting_text');
            const target = add ? textareas[textareas.length - 1] : (focus !== undefined ? textareas[focus] : null);
            if (target instanceof HTMLElement) {
                target.scrollIntoView({ block: 'nearest' });
                target.focus({ preventScroll: true });
            }
        });
    }

    /** ②'s Edit: the first message edits in place; another opening edits in core's editor. */
    #editOpening() {
        if (this._opening === 0) {
            this._beginEdit = !this._beginEdit;
            if (this._beginEdit) {
                void this.updateComplete.then(() => {
                    const textarea = this.querySelector('#firstmessage_textarea');
                    if (textarea instanceof HTMLElement) textarea.focus({ preventScroll: true });
                });
            }
            return;
        }
        this.#openOpenings({ focus: this._opening - 1 });
    }

    /** @returns {string} An avatar the preview must force, or '' for core's own pick (as in chat). */
    #previewAvatar() {
        // A fresh crop is not on disk yet; in create mode the active character is someone else.
        if (this._portrait.startsWith('data:')) return this._portrait;
        if (this.mode === 'create') return this._portrait || 'img/ai4.png';
        return '';
    }

    /** @returns {number|null} Main feelings the card has no sprite for, or null when it has none at all. */
    #spritesMissing() {
        if (!this._heroLabels.size) return null;
        return MAIN_LABELS.filter(label => !this._heroLabels.has(label)).length;
    }

    /* ── the hero ───────────────────────────────────────────────────────────── */

    /** Reads the full-body set the hero's stage draws from. @returns {Promise<void>} */
    async #loadHero() {
        const card = this.#editedCard();
        const folder = card ? spriteFolderFor(card) : '';
        const set = folder ? await readSpriteSet(folder) : { labels: new Map() };
        this._heroLabels = new Map(set.labels);
        if (!this._picked || !this._heroLabels.has(this._picked)) {
            this._picked = this._heroLabels.has('neutral') ? 'neutral' : (this.#heroOrder()[0] ?? '');
        }
        if (!this._heroLabels.size) this._stage = 'art';
        this.#refreshPreview();
    }

    /** @returns {string[]} The labels the card has, main nine first. */
    #heroOrder() {
        const have = [...this._heroLabels.keys()];
        return [...MAIN_LABELS.filter(label => have.includes(label)), ...have.filter(label => !MAIN_LABELS.includes(label)).sort()];
    }

    /** @param {-1|1} step */
    #flip(step) {
        const order = this.#heroOrder();
        if (!order.length) return;
        const index = Math.max(0, order.indexOf(this._picked));
        this._picked = order[(index + step + order.length) % order.length];
        this._stage = 'sprite';
    }

    /** ③ picked a feeling: the hero shows it full body. @param {Event} event */
    #onSpritePick = (event) => {
        const detail = /** @type {CustomEvent} */ (event).detail;
        if (!detail?.label) return;
        this._picked = String(detail.label);
        this._stage = 'sprite';
    };

    /** Touch-up on the picked sprite, through ③'s own sheet. @returns {void} */
    #fixHoles() {
        const studio = /** @type {any} */ (this.querySelector('k-sprite-studio'));
        const card = this.#editedCard();
        if (!studio || !card || typeof studio.openTouchup !== 'function') return;
        studio.openTouchup(spriteFolderFor(card), this._picked || undefined);
    }

    /* ── interaction ────────────────────────────────────────────────────────── */

    /**
     * Escape closes the innermost thing first: an open menu or token breakdown, then the studio —
     * and only when the studio is the outermost thing Escape could mean.
     *
     * Capture phase on `window`, so without a stand-down this would pre-empt core's whole
     * Escape cascade (`RossAscends-mods.js:1175-1265`, bubble phase) AND every popup opened
     * from inside the studio's own flows. It stands down for those, and only then consumes the
     * key — `stopImmediatePropagation()` rather than `stopPropagation()`: consuming a key means
     * all of it, later siblings on this node included, or two surfaces close on one press.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleEscape(event) {
        if (event.key !== 'Escape' || !this.isConnected) {
            return;
        }
        // The crop popup, the alternate-greetings editor and the pickers the proxies open sit OVER
        // us and are ours to wait for; a confirm dialog belongs to whatever asked for it.
        if (corePopupOpen()) return;
        // The branch map paints at 30000, above this sheet. If it is up, it is what the reader
        // is looking at.
        if (document.querySelector('k-branch-map')) return;
        // ③'s sheets (Touch-up, Generate) open over us and close on their own Escape.
        if (document.querySelector('k-sprite-touchup[open], k-sprite-generate[open]')) return;
        // Core's export format menu hangs off the relocated `#export_button`.
        const exportPopup = document.getElementById('export_format_popup');
        if (exportPopup && getComputedStyle(exportPopup).display !== 'none') return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (this._menuOpen || this._tokensOpen) {
            this._menuOpen = false;
            this._tokensOpen = false;
            return;
        }
        this.close();
    }

    /**
     * A click anywhere in the sheet outside an open menu or breakdown closes it.
     * @param {MouseEvent} event
     */
    #onSheetClick = (event) => {
        if (!this._menuOpen && !this._tokensOpen) return;
        const path = event.composedPath();
        const inside = (/** @type {string} */ selector) => path.some(node => node instanceof Element && node.matches(selector));
        if (this._menuOpen && !inside('.k-studio-menu, .k-studio-menu-toggle, #export_format_popup')) this._menuOpen = false;
        if (this._tokensOpen && !inside('.k-studio-tokens, .k-studio-tokens-pop')) this._tokensOpen = false;
    };

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
     * has already been read.
     *
     * The one case that does NOT close: a create with an empty name. Core rejects it with a
     * toast (`script.js:10116`) and the reader needs the sheet still in front of them.
     *
     * The Look and the tagline (Kotatsu-owned, outside the form) save FIRST, and only when they
     * changed: each writes the card through `/merge-attributes` and refreshes
     * `#character_json_data`, so the stock submit that follows carries them instead of writing the
     * old values back. A failed save keeps the sheet open with the reason and does not submit.
     * @returns {Promise<void>}
     */
    async #onSave() {
        const button = document.getElementById('create_button');
        if (!button) {
            console.warn('[k-card-studio] #create_button is missing; the save path is unavailable.');
            return;
        }
        if (!(await this.#saveLookIfChanged())) return;
        if (!(await this.#saveTaglineIfChanged())) return;
        const nameless = this.mode === 'create' && readValue('#character_name_pole').trim().length === 0;
        button.click();
        if (nameless) {
            return;
        }
        this.close();
    }

    /* ── the tagline ────────────────────────────────────────────────────────── */

    #loadTagline() {
        const card = this.#editedCard();
        this._tagline = card ? getTagline(card) : '';
        this.#taglineAtOpen = this._tagline;
        this._taglineError = '';
    }

    /** @returns {Promise<boolean>} False when the save failed (the reason is on screen). */
    async #saveTaglineIfChanged() {
        const card = this.#editedCard();
        if (!card || this._tagline.trim() === this.#taglineAtOpen.trim()) return true;
        try {
            this._tagline = await saveTagline(card, this._tagline);
            this.#taglineAtOpen = this._tagline;
            return true;
        } catch (error) {
            console.error('[k-card-studio] the tagline could not be saved', error);
            this._taglineError = error instanceof Error ? error.message : 'The tagline could not be saved.';
            return false;
        }
    }

    /* ── the Look group (Pictures v0, docs/pictures-v0.md §4) ───────────────── */

    /** @returns {any|null} The card being edited, or null in create mode. */
    #editedCard() {
        if (this.mode !== 'edit' || this_chid === undefined) return null;
        return characters?.[Number(this_chid)] ?? null;
    }

    /** Reads the card's look into the group, or a blank one that points at the card's art. */
    #loadLook() {
        const card = this.#editedCard();
        this._look = normalizeLook(card ? (getLook(card) ?? defaultLookFor(card)) : null);
        this.#lookAtOpen = JSON.stringify(this._look);
        this._lookError = '';
        if (card) void this.#loadLoraList();
    }

    /**
     * @param {'positive'|'negative'|'tongue'} field
     * @param {string} value
     */
    #editLook(field, value) {
        this._look = { ...this._look, [field]: value };
        this._lookError = '';
    }

    /** @param {boolean} useArt Whether the look's reference is the card's own art. */
    #useCardArt(useArt) {
        const card = this.#editedCard();
        const art = card ? cardArtUrl(card) : '';
        const atOpen = /** @type {{ reference?: string }} */ (JSON.parse(this.#lookAtOpen || '{}'));
        // Unticking falls back to whatever other picture the look already named, else none.
        const other = atOpen.reference && atOpen.reference !== art ? atOpen.reference : '';
        this._look = { ...this._look, reference: useArt ? art : other };
        this._lookError = '';
    }

    /**
     * Saves the look when it changed since the studio opened.
     * @returns {Promise<boolean>} False when the save failed (the reason is on screen).
     */
    async #saveLookIfChanged() {
        const card = this.#editedCard();
        if (!card || JSON.stringify(this._look) === this.#lookAtOpen) return true;
        try {
            const saved = await saveLook(card, this._look);
            this._look = normalizeLook(saved);
            this.#lookAtOpen = JSON.stringify(this._look);
            return true;
        } catch (error) {
            console.error('[k-card-studio] the look could not be saved', error);
            this._lookError = error instanceof Error ? error.message : 'The look could not be saved.';
            if (this.view === 'simple') this.#setView('advanced');
            void this.#goTo('looks');
            return false;
        }
    }

    /**
     * ③'s body (`<k-sprite-studio>`): big tiles in Simple, the dense grid in Advanced. Edit mode
     * only: a card that does not exist yet has no sprite folder. Uploads and knobs save on their
     * own; the borrowed form never sees them.
     * @returns {unknown} A Lit template.
     */
    #renderSprites() {
        const card = this.#editedCard();
        if (!card) {
            return html`<p class="k-studio-empty">Once the card is created, ${named('{name}', this.#short)}’s faces can be added here.</p>`;
        }
        return html`<k-sprite-studio variant=${this.view === 'advanced' ? 'grid' : 'strip'} .character=${card} .picked=${this._picked}></k-sprite-studio>`;
    }

    /**
     * Kotatsu's own picture Look. NOT part of `#form_create`: no `name=`, no `form=`, so the
     * borrowed form's wire format and the byte gates never see it. Simple shows one line about
     * it; Advanced shows the whole group.
     * @returns {unknown} A Lit template.
     */
    #renderLook() {
        const card = this.#editedCard();
        if (!card) {
            return html`
                <section class="k-studio-look" aria-label="Look">
                    <h3 class="k-studio-look__head">How new pictures are drawn</h3>
                    <p class="k-studio-look__lead">Once the card is created, its look for pictures can be set here.</p>
                </section>`;
        }
        const look = this._look;
        const art = cardArtUrl(card);
        const usesArt = Boolean(art) && look.reference === art;
        const shown = look.reference || '';
        const summary = look.positive.trim() || 'Nothing set yet: pictures use the card art and the recipe’s defaults.';
        return html`
            <div class="k-studio-look-simple" ?hidden=${this.view !== 'simple'}>
                <div class="k-studio-look-simple__copy">
                    <span class="k-studio-label">How new pictures of ${this._name || 'them'} are drawn</span>
                    <span class="k-studio-look-simple__line">${summary}</span>
                </div>
                <button type="button" class="k-studio-btn" @click=${() => { this.#setView('advanced'); void this.#goTo('looks'); }}>Edit the look</button>
            </div>
            <section class="k-studio-look" aria-label="Look" data-k-studio-look ?hidden=${this.view !== 'advanced'}>
                <h3 class="k-studio-look__head">How new pictures are drawn</h3>
                <p class="k-studio-look__lead">It travels with the card when you share it.</p>
                <div class="k-studio-field k-studio-field--field">
                    <div class="k-studio-labelrow">
                        <label class="k-studio-label" for="k-studio-look-positive">Always include</label>
                        <span class="k-studio-hint">Put in front of every picture of them</span>
                    </div>
                    <div class="k-studio-control">
                        <textarea id="k-studio-look-positive" rows="3" spellcheck="false" data-k-look="positive"
                            placeholder="1girl, long silver hair, green eyes, black coat"
                            .value=${look.positive}
                            @input=${(/** @type {Event} */ e) => this.#editLook('positive', /** @type {HTMLTextAreaElement} */ (e.target).value)}></textarea>
                    </div>
                </div>
                <div class="k-studio-field k-studio-field--field">
                    <div class="k-studio-labelrow">
                        <label class="k-studio-label" for="k-studio-look-negative">Never include</label>
                        <span class="k-studio-hint">Where the recipe takes a negative</span>
                    </div>
                    <div class="k-studio-control">
                        <textarea id="k-studio-look-negative" rows="2" spellcheck="false" data-k-look="negative"
                            placeholder="extra fingers, blurry"
                            .value=${look.negative}
                            @input=${(/** @type {Event} */ e) => this.#editLook('negative', /** @type {HTMLTextAreaElement} */ (e.target).value)}></textarea>
                    </div>
                </div>
                <div class="k-studio-field k-studio-field--field is-half">
                    <div class="k-studio-labelrow">
                        <label class="k-studio-label" for="k-studio-look-tongue">Written as</label>
                    </div>
                    <div class="k-studio-control">
                        <select id="k-studio-look-tongue" data-k-look="tongue"
                            @change=${(/** @type {Event} */ e) => this.#editLook('tongue', /** @type {HTMLSelectElement} */ (e.target).value)}>
                            <option value="" ?selected=${!look.tongue}>Whatever the recipe wants</option>
                            <option value=${TONGUES.TAGS} ?selected=${look.tongue === TONGUES.TAGS}>Tags</option>
                            <option value=${TONGUES.PROSE} ?selected=${look.tongue === TONGUES.PROSE}>Prose</option>
                        </select>
                    </div>
                </div>
                <div class="k-studio-field k-studio-field--field">
                    <div class="k-studio-labelrow">
                        <span class="k-studio-label">Reference</span>
                        <span class="k-studio-hint">Recipes with a reference slot draw from it</span>
                    </div>
                    <div class="k-studio-control k-studio-look__reference">
                        ${shown
        ? html`<img class="k-studio-look__thumb" src=${shown} alt="The reference picture" loading="lazy" decoding="async">`
        : html`<span class="k-studio-look__thumb" aria-hidden="true"></span>`}
                        <label class="k-studio-look__check">
                            <input type="checkbox" data-k-look="use-card-art" .checked=${usesArt} ?disabled=${!art}
                                @change=${(/** @type {Event} */ e) => this.#useCardArt(/** @type {HTMLInputElement} */ (e.target).checked)}>
                            <span>Use card art</span>
                        </label>
                    </div>
                </div>
                ${this.#renderLookLoras()}
                ${this._lookError ? html`<p class="k-studio-look__error" role="alert">${this._lookError}</p>` : nothing}
            </section>`;
    }

    /**
     * The card's LoRAs (ComfyUI pictures, 2026-10-10): they ride every picture of this character,
     * their trigger words go into the prompt. The picker lists the server's LoRAs by model family.
     * @returns {unknown} A Lit template.
     */
    #renderLookLoras() {
        const loras = this._look.loras ?? [];
        const list = this._loraList;
        const infoOf = (/** @type {string} */ file) => list?.find(l => l.file === file);
        const free = (list ?? []).filter(l => !loras.some(a => a.file === l.file));
        /** @type {Map<string, import('../pictures/picture-model.js').LoraInfo[]>} */
        const byBase = new Map();
        for (const info of free) {
            const key = info.base ?? '';
            byBase.set(key, [...(byBase.get(key) ?? []), info]);
        }
        const families = [...byBase.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
        return html`
            <div class="k-studio-field k-studio-field--field" data-k-look="loras">
                <div class="k-studio-labelrow">
                    <span class="k-studio-label">LoRAs</span>
                    <span class="k-studio-hint">For ComfyUI recipes; their trigger words go into the prompt</span>
                </div>
                <div class="k-studio-control k-studio-look__loras">
                    ${loras.map(lora => {
        const title = infoOf(lora.file)?.title ?? lora.file.replace(/\.(safetensors|ckpt|pt)$/i, '');
        return html`
                        <div class="k-studio-look__lora" data-k-look-lora=${lora.file}>
                            <span class="k-studio-look__lora-name" title=${lora.file}>${title}</span>
                            <input type="number" step="0.05" min="-10" max="10" inputmode="decimal" aria-label=${`Strength of ${title}`}
                                .value=${String(lora.strength)}
                                @change=${(/** @type {Event} */ e) => this.#editLora(lora.file, { strength: Number(/** @type {HTMLInputElement} */ (e.target).value) })}>
                            <input type="text" spellcheck="false" aria-label=${`Trigger words for ${title}`} placeholder="Trigger words"
                                .value=${lora.trigger}
                                @input=${(/** @type {Event} */ e) => this.#editLora(lora.file, { trigger: /** @type {HTMLInputElement} */ (e.target).value })}>
                            <button type="button" class="k-studio-look__lora-remove" aria-label=${`Remove ${title}`} title="Remove"
                                @click=${() => this.#editLora(lora.file, null)}>${icons.close}</button>
                        </div>`;
    })}
                    ${list === null ? html`<span class="k-studio-hint">Reading your ComfyUI's LoRAs…</span>` : nothing}
                    ${this._loraError ? html`<span class="k-studio-hint">Couldn’t read the LoRAs: ${this._loraError}</span>` : nothing}
                    ${free.length && loras.length < MAX_LORAS ? html`
                        <select aria-label="Add a LoRA" data-k-look="lora-add" @change=${this.#onAddLookLora}>
                            <option value="" selected>Add a LoRA…</option>
                            ${families.map(base => html`
                                <optgroup label=${base ? `For ${LORA_BASE_NAMES[base] ?? base}` : 'Base unknown'}>
                                    ${(byBase.get(base) ?? []).map(info => html`<option value=${info.file}>${info.title}</option>`)}
                                </optgroup>`)}
                        </select>` : nothing}
                </div>
            </div>`;
    }

    /** @param {Event} event The picker's change */
    #onAddLookLora = (event) => {
        const select = /** @type {HTMLSelectElement} */ (event.target);
        const info = this._loraList?.find(l => l.file === select.value);
        select.value = '';
        if (!info) return;
        this._look = { ...this._look, loras: normalizeLoras([...(this._look.loras ?? []), { file: info.file, strength: 1, trigger: info.triggers.join(', ') }]) };
        this._lookError = '';
    };

    /**
     * @param {string} file
     * @param {{strength?: number, trigger?: string}|null} change null removes it
     */
    #editLora(file, change) {
        const loras = this._look.loras ?? [];
        const next = change === null ? loras.filter(l => l.file !== file) : loras.map(l => (l.file === file ? { ...l, ...change } : l));
        this._look = { ...this._look, loras: normalizeLoras(next) };
        this._lookError = '';
    }

    /** Lists the server's LoRAs for the picker (once per open). */
    async #loadLoraList() {
        this._loraList = null;
        this._loraError = '';
        try {
            const answer = await listLoras();
            this._loraList = answer?.ok && Array.isArray(answer.loras) ? answer.loras : [];
            if (!answer?.ok) this._loraError = answer?.message || 'The picture server did not answer.';
        } catch (error) {
            this._loraList = [];
            this._loraError = error instanceof Error ? error.message : String(error);
        }
    }

    /* ── render ─────────────────────────────────────────────────────────────── */

    render() {
        return html`
            <div class="k-studio-scrim" @click=${() => this.close()}></div>
            <div class="k-studio-sheet" role="dialog" aria-modal="true" aria-label=${this.#title()}
                data-view=${this.view} ?data-spoilers=${this._spoilers} @click=${this.#onSheetClick}>
                ${this.#renderHead()}
                ${this.#renderChapterBar()}
                <div class="k-studio-body">
                    ${this.#renderHero()}
                    <div class="k-studio-page">
                        ${this.#renderNextStep()}
                        ${CHAPTERS.map(chapter => this.#renderChapter(chapter))}
                    </div>
                </div>
            </div>`;
    }

    /** @returns {string} The name chapters and labels use (`manifest.js` `shortName`). */
    get #short() {
        return shortName(this._name);
    }

    /** @returns {string} The dialog's accessible name, from the manifest's one formatter. */
    #title() {
        return modeTitle(this.mode === 'edit' ? 'edit' : 'create', this._name);
    }

    /** @returns {unknown} Eyebrow, token chip · view switch, spoiler eye, card menu, Done, ×. */
    #renderHead() {
        const always = this._budget.rows.filter(row => row.group === 'always');
        const total = Math.max(1, this._budget.total);
        return html`
            <header class="k-studio-head">
                <div class="k-studio-head-lead">
                    <span class="k-studio-eyebrow">Card studio</span>
                    <h2 class="k-studio-title k-studio-sr">${this.#title()}</h2>
                    <button type="button" class="k-studio-tokens" aria-expanded=${this._tokensOpen ? 'true' : 'false'}
                        aria-controls="k-studio-tokens-pop" title="What this card costs every turn"
                        @click=${() => { this._tokensOpen = !this._tokensOpen; this._menuOpen = false; }}>
                        <span class="k-studio-tokens__bar" aria-hidden="true">${always.map(row => html`<i data-id=${row.id} style=${`flex-grow: ${row.count / total}`}></i>`)}</span>
                        <span class="k-studio-tokens__copy"><b>${this._budget.total} tokens</b> <span>always in the story</span></span>
                    </button>
                    ${this._tokensOpen ? this.#renderTokens() : nothing}
                </div>
                <div class="k-studio-head-tools">
                    <div class="k-studio-view" role="group" aria-label="View">
                        <button type="button" aria-pressed=${this.view === 'simple' ? 'true' : 'false'} @click=${() => this.#setView('simple')}>Simple</button>
                        <button type="button" aria-pressed=${this.view === 'advanced' ? 'true' : 'false'} @click=${() => this.#setView('advanced')}>Advanced</button>
                    </div>
                    <button type="button" class="k-studio-iconbtn" aria-pressed=${this._spoilers ? 'true' : 'false'}
                        aria-label=${this._spoilers ? 'Show the story fields' : 'Hide spoilers'}
                        title="Blur the description, the openings and the example lines (for streaming)"
                        @click=${() => { this._spoilers = !this._spoilers; }}>${this._spoilers ? icons.eyeOff : icons.eye}</button>
                    <button type="button" class="k-studio-iconbtn k-studio-menu-toggle" aria-label="Card menu"
                        aria-expanded=${this._menuOpen ? 'true' : 'false'} aria-controls="k-studio-menu"
                        @click=${() => { this._menuOpen = !this._menuOpen; this._tokensOpen = false; }}>${icons.dots}</button>
                    ${this.mode === 'edit' ? html`<span class="k-studio-autosave">${icons.check}Autosaves</span>` : nothing}
                    <button type="button" class="k-studio-save" @click=${() => this.#onSave()}>${this.mode === 'edit' ? 'Done' : 'Create character'}</button>
                    <button type="button" class="k-studio-close k-studio-iconbtn" title="Close (Escape)" aria-label="Close the card studio"
                        @click=${() => this.close()}>${icons.close}</button>
                </div>
                ${this.#renderMenu()}
            </header>`;
    }

    /** @returns {unknown} The token breakdown, from core's own counters. */
    #renderTokens() {
        const group = (/** @type {string} */ name) => this._budget.rows.filter(row => row.group === name);
        const total = Math.max(1, this._budget.total);
        const once = group('once');
        const room = group('room');
        const levers = group('lever').filter(row => row.count > 0);
        return html`
            <div class="k-studio-tokens-pop" id="k-studio-tokens-pop" role="dialog" aria-label="What this card costs every turn">
                <span class="k-studio-tokens-pop__title">What ${this._name || 'this card'} costs every turn</span>
                <div class="k-studio-tokens-pop__bar" aria-hidden="true">${group('always').map(row => html`<i data-id=${row.id} style=${`flex-grow: ${row.count / total}`}></i>`)}</div>
                <dl class="k-studio-tokens-pop__rows">
                    ${group('always').map(row => html`<div data-id=${row.id}><dt><i aria-hidden="true"></i>${row.label}</dt><dd>${row.count}</dd></div>`)}
                    <div class="is-total"><dt>Always in the story</dt><dd>${this._budget.total}</dd></div>
                </dl>
                <dl class="k-studio-tokens-pop__rows is-quiet">
                    ${once.map(row => html`<div><dt>Sent once, to open: ${row.label.toLowerCase()}</dt><dd>${row.count}</dd></div>`)}
                    ${room.map(row => html`<div><dt>Kept while there is room: ${row.label.toLowerCase()}</dt><dd>${row.count}</dd></div>`)}
                    ${levers.map(row => html`<div><dt>Replaces part of your preset: ${row.label.toLowerCase()}</dt><dd>${row.count}</dd></div>`)}
                    <div><dt>Only when they come up: lore entries</dt><dd>${readValue('#character_world') ? 'linked' : 'none linked'}</dd></div>
                </dl>
                <span class="k-studio-tokens-pop__foot">These are the counts under each field, counted with your model’s tokenizer.</span>
            </div>`;
    }

    /**
     * The card menu. ALWAYS rendered (hidden when shut): it holds borrowed core buttons. Export,
     * Duplicate and Delete are core's, visible inside their rows — the export format popup is a
     * Popper anchored to the real `#export_button` (`script.js:472`), so that button must stay a
     * painted box. The dropdown is relocated into a hidden holder and driven by proxies.
     * @returns {unknown}
     */
    #renderMenu() {
        const proxy = (/** @type {string} */ id) => () => this.#runDropdown(id);
        const click = (/** @type {string} */ id) => () => document.getElementById(id)?.click();
        return html`
            <div class="k-studio-menu" id="k-studio-menu" role="menu" aria-label="Card menu" ?hidden=${!this._menuOpen}>
                <div class="k-studio-menu-row" role="none">
                    <div class="k-studio-slot k-studio-menu-slot" data-slot="menu.export"></div>
                    <button type="button" role="menuitem" class="k-studio-menu-item" ?disabled=${this.mode !== 'edit'} @click=${click('export_button')}>
                        <b>Export…</b><span>Save the card as a file to share (PNG or JSON).</span></button>
                </div>
                <div class="k-studio-menu-row" role="none">
                    <div class="k-studio-slot k-studio-menu-slot" data-slot="menu.dupe"></div>
                    <button type="button" role="menuitem" class="k-studio-menu-item" ?disabled=${this.mode !== 'edit'} @click=${click('dupe_button')}>
                        <b>Duplicate</b><span>A copy to experiment on. Chats stay with the original.</span></button>
                </div>
                <div class="k-studio-menu-row" role="none">
                    <span class="k-studio-menu-icon" aria-hidden="true">${icons.persona}</span>
                    <button type="button" role="menuitem" class="k-studio-menu-item" ?disabled=${this.mode !== 'edit'} @click=${proxy(DROPDOWN_ACTIONS.persona)}>
                        <b>Use as a persona</b><span>Play as ${this._name || 'this character'} yourself in other chats.</span></button>
                </div>
                ${this._extensionActions.length ? html`
                    <span class="k-studio-menu-divider" role="separator">More</span>
                    ${this._extensionActions.map(action => html`
                        <div class="k-studio-menu-row" role="none">
                            <span class="k-studio-menu-icon" aria-hidden="true">${icons.layers}</span>
                            <button type="button" role="menuitem" class="k-studio-menu-item" @click=${proxy(action.id)}><b>${action.label}</b></button>
                        </div>`)}` : nothing}
                <div class="k-studio-menu-hold" hidden><div class="k-studio-slot" data-slot="menu.more"></div></div>
                <span class="k-studio-menu-divider is-rule" role="separator"></span>
                <div class="k-studio-menu-row is-danger" role="none">
                    <div class="k-studio-slot k-studio-menu-slot" data-slot="menu.delete"></div>
                    <button type="button" role="menuitem" class="k-studio-menu-item" ?disabled=${this.mode !== 'edit'} @click=${click('delete_button')}>
                        <b>Delete ${this._name || 'this character'}…</b><span>Asks first, and lets you keep or delete the chats.</span></button>
                </div>
            </div>`;
    }

    /** @returns {unknown} The chapter bar: Simple's four (⑤ greyed as a door), or all six. */
    #renderChapterBar() {
        const simple = this.view === 'simple';
        return html`
            <nav class="k-studio-chapters" aria-label="Chapters">
                ${CHAPTERS.map((chapter) => {
        const advanced = chapter.level === 'advanced';
        const isHood = chapter.id === HOOD_CHAPTER;
        const current = this._chapter === chapter.id;
        const done = chapterDone(chapter.id, this._step.missing, this._heroLabels.size > 0);
        // Under the hood never appears in Simple's bar; the world does, greyed, as the door
        // to Advanced (Andres, 2026-10-19).
        return html`
                    <button type="button" class="k-studio-chapter-btn${isHood ? ' is-hood' : ''}"
                        data-chapter=${chapter.id}
                        ?hidden=${simple && isHood}
                        aria-current=${current ? 'true' : nothing}
                        data-state=${simple && advanced ? 'locked' : done ? 'done' : 'open'}
                        title=${simple && advanced ? 'Lives in Advanced' : nothing}
                        @click=${() => void this.#goTo(chapter.id)}>
                        <span class="k-studio-chapter-num" aria-hidden="true">${isHood ? icons.gear : done && !(simple && advanced) ? icons.check : chapterNumber(chapter.id)}</span>
                        <span>${named(chapter.short, this.#short)}</span>
                        ${chapter.id === 'looks' && this._heroLabels.size ? html`<span class="k-studio-chapter-count">${MAIN_LABELS.filter(l => this._heroLabels.has(l)).length}/${MAIN_LABELS.length}</span>` : nothing}
                        ${simple && advanced ? html`<span class="k-studio-chapter-tag">in Advanced</span>` : nothing}
                    </button>`;
    })}
                <span class="k-studio-chapters-view">${simple ? 'Simple view' : 'Advanced view · every field'}</span>
            </nav>`;
    }

    /** @returns {unknown} The character, beside every chapter. */
    #renderHero() {
        const url = this._heroLabels.get(this._picked) ?? '';
        const showSprite = this._stage === 'sprite' && Boolean(url);
        const order = this.#heroOrder();
        const card = this.#editedCard();
        const initials = (this._name || '?').split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase();
        return html`
            <aside class="k-studio-hero" aria-label=${this._name || 'Your character'} ?data-unpinned=${this._heroUnpinned}>
                <div class="k-studio-stage" data-stage=${showSprite ? 'sprite' : 'art'} data-label=${showSprite ? this._picked : nothing}>
                    ${showSprite
        ? html`<img class="k-studio-stage__sprite" src=${url} alt=${`${this._name}, ${this._picked}`} decoding="async">`
        : this._portrait
            ? html`<img class="k-studio-stage__art" src=${this._portrait} alt=${`${this._name || 'The character'}’s card art`} decoding="async">`
            : html`<span class="k-studio-stage__initials" aria-hidden="true">${initials}</span>`}
                    ${this._heroLabels.size ? html`
                        <div class="k-studio-stage__toggle" role="group" aria-label="Show">
                            <button type="button" aria-pressed=${showSprite ? 'true' : 'false'} @click=${() => { this._stage = 'sprite'; }}>Sprite</button>
                            <button type="button" aria-pressed=${showSprite ? 'false' : 'true'} @click=${() => { this._stage = 'art'; }}>Card art</button>
                        </div>` : nothing}
                </div>
                <div class="k-studio-hero-row" ?hidden=${!order.length}>
                    <div class="k-studio-flipper">
                        <button type="button" aria-label="Previous feeling" @click=${() => this.#flip(-1)}>‹</button>
                        <span>${this._picked}</span>
                        <button type="button" aria-label="Next feeling" @click=${() => this.#flip(1)}>›</button>
                    </div>
                    <button type="button" class="k-studio-btn" ?hidden=${!card} @click=${() => this.#fixHoles()}
                        title="Touch-up on this sprite: fix leftover background and holes">Fix holes</button>
                </div>
                <div class="k-studio-hero-art">
                    <div class="k-studio-slot k-studio-slot--portrait" data-slot="hero.portrait"></div>
                    <span class="k-studio-hero-art__copy">${this._portrait ? 'Replace card art' : 'Add card art'}</span>
                    <div class="k-studio-slot k-studio-slot--fav" data-slot="hero.fav"></div>
                </div>
                <div class="k-studio-hero-name">
                    <div class="k-studio-labelrow">
                        <span class="k-studio-label">Name</span>
                        ${this.mode === 'edit' ? html`
                            <button type="button" class="k-studio-link k-studio-rename" @click=${() => this.#runDropdown(DROPDOWN_ACTIONS.rename)}
                                title="Renames the card and moves its chats along with it">${icons.pen}Rename…</button>` : nothing}
                    </div>
                    <div class="k-studio-control" ?hidden=${this.mode !== 'create'}><div class="k-studio-slot" data-slot="hero.name"></div></div>
                    ${this.mode === 'edit' ? html`<span class="k-studio-hero-name__text">${this._name}</span>` : nothing}
                </div>
                <label class="k-studio-tagline">
                    <span class="k-studio-label">Tagline <span class="k-studio-hint">on the library card</span></span>
                    <input type="text" maxlength=${TAGLINE_MAX} spellcheck="true" ?disabled=${!card}
                        placeholder=${card ? (this._taglineHint || 'One line under the name') : 'Once the card is created'}
                        .value=${this._tagline}
                        @input=${(/** @type {Event} */ e) => { this._tagline = /** @type {HTMLInputElement} */ (e.target).value; this._taglineError = ''; }}>
                    ${this._taglineError ? html`<span class="k-studio-hint is-error" role="alert">${this._taglineError}</span>` : nothing}
                </label>
                <div class="k-studio-hero-tags">
                    <span class="k-studio-label">Tags <span class="k-studio-hint">yours, in this library</span></span>
                    <div class="k-studio-control"><div class="k-studio-slot" data-slot="hero.tags"></div></div>
                </div>
            </aside>`;
    }

    /** @returns {unknown} One next step, and — in Simple — what Advanced is steering. */
    #renderNextStep() {
        const step = this._step;
        const fraction = step.total ? step.done / step.total : 1;
        return html`
            <div class="k-studio-next" data-done=${step.next ? nothing : ''}>
                <span class="k-studio-next__ring" aria-hidden="true" style=${`--studio-next-done: ${Math.round(fraction * 100)}%`}><span>${step.done}/${step.total}</span></span>
                <p class="k-studio-next__copy">${step.next
        ? html`<b>Next: ${named(step.next.title, this.#short)}</b> ${step.next.why}`
        : html`<b>Everything a card wants is here.</b> Only a name was ever required; the rest is what makes a card good.`}</p>
                ${step.next ? html`<button type="button" class="k-studio-btn" @click=${() => void this.#goTo(step.next?.chapter ?? 'who')}>Take me there →</button>` : nothing}
            </div>
            ${this.view === 'simple' && this._inUse.length ? html`
                <p class="k-studio-inuse">Set in Advanced and steering the model: ${this._inUse.join(', ')}.
                    <button type="button" class="k-studio-link" @click=${() => this.#setView('advanced')}>Show me</button></p>` : nothing}`;
    }

    /**
     * One chapter. Rendered on EVERY pass, hidden by attribute (see the header).
     * @param {import('./manifest.js').StudioChapter} chapter
     * @returns {unknown}
     */
    #renderChapter(chapter) {
        const simple = this.view === 'simple';
        const hidden = simple && chapter.level === 'advanced';
        const number = chapterNumber(chapter.id);
        return html`
            <section class="k-studio-chapter" id=${`k-studio-ch-${chapter.id}`} data-chapter=${chapter.id}
                aria-labelledby=${`k-studio-ch-${chapter.id}-title`} ?hidden=${hidden}>
                <header class="k-studio-chapter-head">
                    <h3 id=${`k-studio-ch-${chapter.id}-title`} class="k-studio-chapter-title">
                        <span class="k-studio-chapter-badge" aria-hidden="true">${number ?? icons.gear}</span>${named(chapter.title, this.#short)}
                    </h3>
                    <p class="k-studio-chapter-blurb">${named(chapter.blurb, this.#short)}</p>
                </header>
                <div class="k-studio-fields">
                    ${chapter.fields.map(field => this.#renderField(chapter, field))}
                    ${chapter.id === 'world' ? this.#renderWorldActions() : nothing}
                    ${chapter.id === 'hood' ? this.#renderHoodActions() : nothing}
                </div>
                ${chapter.id === 'looks' ? html`<div class="k-studio-looks">${this.#renderSprites()}${this.#renderLook()}</div>` : nothing}
            </section>`;
    }

    /**
     * @param {import('./manifest.js').StudioChapter} chapter
     * @param {import('./manifest.js').StudioField} field One labelled row.
     * @returns {unknown} A Lit template; Advanced rows are hidden in Simple, never left out.
     */
    #renderField(chapter, field) {
        const kind = field.kind ?? 'field';
        const hidden = this.view === 'simple' && levelOf(chapter, field) === 'advanced';
        if (kind === 'opening') return this.#renderOpening(field, hidden);
        return html`
            <div class="k-studio-field k-studio-field--${kind}${field.span === 'half' ? ' is-half' : ''}" ?hidden=${hidden}>
                <div class="k-studio-labelrow">
                    ${this.#fieldLabel(field)}
                    ${field.hint ? html`<span class="k-studio-hint">${named(field.hint, this.#short)}</span>` : nothing}
                </div>
                ${kind === 'openings' ? this.#renderOpeningTiles() : nothing}
                <div class="k-studio-control">${field.slots.map(slot => html`<div class="k-studio-slot" data-slot=${slot.key}></div>`)}</div>
            </div>`;
    }

    /**
     * A field's label: Kotatsu's words, with ST's own name beside them (the sheet shows it in Advanced).
     * @param {import('./manifest.js').StudioField} field
     * @returns {unknown}
     */
    #fieldLabel(field) {
        return html`<span class="k-studio-label">${named(field.label, this.#short)}${field.stName ? html` <span class="k-studio-stname">(${field.stName})</span>` : nothing}</span>`;
    }

    /**
     * ②'s first message: a head (the flipper over every opening, Edit, + Another opening), the
     * opening as the chat renders it, and the borrowed textarea. The textarea's slot renders on
     * EVERY pass and hides by attribute (the v2 rule): it is a borrowed control.
     * @param {import('./manifest.js').StudioField} field
     * @param {boolean} hidden
     * @returns {unknown}
     */
    #renderOpening(field, hidden) {
        const total = this._openings.length;
        const index = this._opening;
        const firstEmpty = !String(this._openings[0] ?? '').trim();
        // The textarea shows while editing opening 1 (an empty first message starts in Edit).
        const writing = index === 0 && this._beginEdit;
        const sent = this._budget.rows.find(row => row.id === 'firstmessage_textarea');
        return html`
            <div class="k-studio-field k-studio-field--opening" ?hidden=${hidden} data-writing=${writing ? '' : nothing}>
                <div class="k-studio-labelrow">
                    ${this.#fieldLabel(field)}
                    <span class="k-studio-hint">${field.hint ? named(field.hint, this.#short) : nothing}${sent && sent.count ? ` · ${sent.count} tokens` : ''}</span>
                </div>
                <div class="k-studio-opening-bar">
                    <div class="k-studio-flipper k-studio-opening-flipper" ?hidden=${total < 2}>
                        <button type="button" aria-label="Previous opening" @click=${() => this.#flipOpening(-1)}>‹</button>
                        <span aria-live="polite">${openingLabel(index, total)}</span>
                        <button type="button" aria-label="Next opening" @click=${() => this.#flipOpening(1)}>›</button>
                    </div>
                    <button type="button" class="k-studio-btn" ?hidden=${index === 0 && firstEmpty}
                        aria-pressed=${index === 0 ? (this._beginEdit ? 'true' : 'false') : nothing}
                        title=${index === 0 ? 'Write the first message here, with the preview under it' : 'Opens the openings editor at this one'}
                        @click=${() => this.#editOpening()}>${index === 0 && this._beginEdit ? 'Done editing' : 'Edit'}</button>
                    <button type="button" class="k-studio-btn is-quiet" @click=${() => this.#openOpenings({ add: true })}
                        title="Another way a new chat can begin; players swipe between them">+ Another opening</button>
                </div>
                <div class="k-studio-control" ?hidden=${!writing}>${field.slots.map(slot => html`<div class="k-studio-slot" data-slot=${slot.key}></div>`)}</div>
                <k-opening-preview variant="chat" .texts=${this._openings} .index=${index} .name=${this._name}
                    .mode=${this.mode} .avatar=${this.#previewAvatar()}></k-opening-preview>
                <span class="k-studio-hint k-studio-opening-foot">Shown as the chat shows it, in your theme and message style.</span>
            </div>`;
    }

    /** @returns {unknown} One tile per opening, under "Other openings"; a tile shows that opening above. */
    #renderOpeningTiles() {
        if (this._openings.length < 2) return nothing;
        const options = macroOptions({ name: this._name, mode: this.mode === 'create' ? 'create' : 'edit' });
        return html`
            <div class="k-studio-opening-tiles">
                ${this._openings.map((text, index) => html`
                    <button type="button" class="k-studio-opening-tile" aria-pressed=${index === this._opening ? 'true' : 'false'}
                        @click=${() => { this._opening = index; }}>
                        <span class="k-studio-opening-tile__num">${openingLabel(index, this._openings.length)}</span>
                        <span class="k-studio-opening-tile__text">${openingExcerpt(text ? substituteParams(text, options) : '') || 'Empty'}</span>
                    </button>`)}
            </div>`;
    }

    /** @returns {unknown} ⑤'s doors into core's lorebook flows. */
    #renderWorldActions() {
        const linked = readValue('#character_world');
        const card = this.#editedCard();
        return html`
            <div class="k-studio-field k-studio-field--world" ?hidden=${this.view === 'simple'}>
                <p class="k-studio-world-state">${icons.book}${linked
    ? html`<span>Linked: <b>${linked}</b>. Entries wake up when the chat mentions them.</span>`
    : html`<span>No lorebook yet. A book holds the people, places and history of ${this._name || 'the story'}, and each entry wakes up only when it is mentioned.</span>`}</p>
                <div class="k-studio-world-actions">
                    <button type="button" class="k-studio-btn" ?disabled=${!card} @click=${() => this.#runDropdown(DROPDOWN_ACTIONS.linkWorld)}>${linked ? 'Change or add books…' : 'Link a lorebook…'}</button>
                    <button type="button" class="k-studio-btn is-quiet" ?disabled=${!card} @click=${() => this.#runDropdown(DROPDOWN_ACTIONS.importLore)}
                        title="Some cards carry their own lore inside the file; this makes it a lorebook and links it">Import the card’s own lore</button>
                </div>
            </div>`;
    }

    /** @returns {unknown} Under the hood's one proxy: per-chat overrides. */
    #renderHoodActions() {
        return html`
            <div class="k-studio-field k-studio-field--actions" ?hidden=${this.view === 'simple'}>
                <div class="k-studio-labelrow">
                    <span class="k-studio-label">Just for the current chat <span class="k-studio-stname">(character settings overrides)</span></span>
                    <span class="k-studio-hint">A different scenario, example lines or main prompt in one chat, card untouched</span>
                </div>
                <div class="k-studio-control">
                    <button type="button" class="k-studio-btn" ?disabled=${this.mode !== 'edit'} @click=${() => this.#runDropdown(DROPDOWN_ACTIONS.chatOverrides)}>Set overrides…</button>
                </div>
            </div>`;
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
 * time the click returns.
 *
 * A chid opens EDIT mode, which requires the character to be ACTIVE — `this_chid` is what
 * `#delete_button`, the alternate-greetings popup and the edit branch of
 * `createOrEditCharacter()` all read. `selectCharacterById()` is the only way to set it, and it
 * opens that character's chat behind the sheet (doc §2.1 item 5).
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
