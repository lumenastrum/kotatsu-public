/**
 * `<k-persona-studio variant="sheet">` — edit the persona you're wearing, as a Kotatsu page
 * (`docs/persona-gallery-v0.md` §2, slice P2).
 *
 * THE CONTRACT, copied from the card studio (card-studio-v2.md "What does not change"):
 *
 * - **Borrow, never mirror.** The description, position, depth/role, the three locks, the
 *   connections list and the three global checkboxes are core's REAL controls, relocated into
 *   `[data-slot]`s on open and put back on close by this element's own {@link Relocator}.
 *   Autosave, `{{user}}` macros, core's token counter and the lock icons keep working because
 *   nothing here rebuilds them. Core's Font Awesome icon buttons (image, rename, lorebook,
 *   duplicate, delete, sync) stay home and are reached by PROXY: a Kotatsu button that fires a
 *   real `.click()` (`studio/persona-manifest.js`).
 * - **Every slot renders on every pass.** Simple / Advanced hides by attribute, never by
 *   template branch: a conditional would let lit-html tear a borrowed control out of the
 *   document.
 * - **Never borrowed:** the stock grid, the avatar upload form, and the two blocks the settings
 *   modal adopts whole (`NEVER_BORROWED`).
 * - **Close before unmount.** `disconnectedCallback` restores SYNCHRONOUSLY, and the rails
 *   layout's `unmount()` calls {@link uninstallPersonaStudio} before `ctx.restoreAll()`.
 *
 * EDITING PUTS IT ON (doc §0). Core's controls only ever edit `user_avatar`, so
 * {@link openPersonaStudio} wears the requested persona first and the header says so.
 *
 * EXCLUSIVE WITH SETTINGS → PERSONAS (doc §0). The settings modal adopts `#persona-suite` whole
 * while it is up. So: opening the studio closes the modal first (its `close()` is a `remove()`,
 * whose restore is synchronous), and a modal that appears while the studio is up closes the
 * studio. Restore goes by recorded PARENT, so even an overlap puts every control home.
 */

import { LitElement, html, nothing, svg as svgPaths } from '../shell/lit.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { setUserAvatar, user_avatar } from '../../scripts/personas.js';
import { Popup } from '../../scripts/popup.js';
import { getTokenCountAsync } from '../../scripts/tokenizers.js';
import { power_user } from '../../scripts/power-user.js';
import { accountStorage } from '../../scripts/util/AccountStorage.js';
import { closeSettings, isSettingsModalOpen, openSettings } from '../settings/k-settings-modal.js';
import { toInitials } from '../library/card-identity.js';
import { PERSONA_POSITIONS, personaPortraitUrl, placementWords, resolveUserMacro, withBust } from '../library/persona-view-model.js';
import { PORTRAIT_REPLACED_EVENT, portraitBust } from '../library/persona-portraits.js';
import {
    WRAPPER_PLACEHOLDER,
    activeItems,
    blankGroup,
    blankVariant,
    compilePattern,
    composeDescription,
    escapeJoiner,
    isDefaultFormat,
    isVariantActive,
    triggerSummary,
    unescapeJoiner,
} from '../library/persona-variants.js';
import {
    confirmVariantFlip,
    flipWarningsOn,
    readFormat,
    readVariantContext,
    readVariants,
    setFlipWarnings,
    targetName,
    variantTargets,
    writeFormat,
    writeVariants,
} from '../library/persona-variants-runtime.js';
import { perTurnMacros, perTurnNoteCopy, positionIsCached } from '../library/variant-cache.js';
import {
    PERSONA_PROXIES,
    PERSONA_SLOTS,
    PERSONA_STUDIO_VIEW_KEY,
    PERSONA_TOKEN_COUNTER_ID,
} from './persona-manifest.js';

/** @typedef {import('./persona-manifest.js').PersonaSlot} PersonaSlot */

/**
 * @typedef {object} Anchor
 * @property {Node} parent
 * @property {Node | null} nextSibling
 */

/**
 * This element's own relocation ledger — the card studio's semantics exactly (an anchor is
 * recorded on the FIRST relocate only; `nextSibling` is re-validated at restore). A separate
 * instance for the same reason the card studio keeps its own: the layout's ledger is replayed
 * on every layout switch, and the studio's lifetime is shorter than the layout's.
 */
class Relocator {
    /** @type {WeakMap<Element, Anchor>} */
    #anchors = new WeakMap();

    /** @type {Element[]} */
    #order = [];

    /**
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

    /** @returns {number} How many nodes went home, newest move first. */
    restoreAll() {
        let restored = 0;
        for (let index = this.#order.length - 1; index >= 0; index--) {
            const node = this.#order[index];
            const anchor = this.#anchors.get(node);
            this.#anchors.delete(node);
            if (!anchor) continue;
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

/** @returns {boolean} Whether a core popup (rename, delete confirm, lorebook picker) owns the keyboard. */
function corePopupOpen() {
    if (document.querySelector('dialog.popup[open]')) return true;
    const shadowPopup = document.getElementById('shadow_popup');
    return Boolean(shadowPopup) && getComputedStyle(/** @type {Element} */ (shadowPopup)).display !== 'none';
}

/**
 * The element a slot actually moves.
 * @param {PersonaSlot} slot Manifest entry.
 * @returns {Element|null} The unit, or null when core no longer has the control.
 */
function slotUnit(slot) {
    const node = document.getElementById(slot.id);
    if (!node) return null;
    return slot.unit === 'range-block' ? node.closest('.range-block') : node;
}

/** Fires a real click on a core button that stays home. @param {string} id @returns {boolean} */
function proxyClick(id) {
    const button = document.getElementById(id);
    if (!button) {
        console.warn(`[k-persona-studio] #${id} is missing; that action is unavailable.`);
        return false;
    }
    button.click();
    return true;
}

// Inner paths go through lit's `svg` tag: an `html` template nested in <svg> parses in the HTML
// namespace and draws nothing (measured: every icon in the first build was blank).
const svg = (/** @type {unknown} */ paths, size = 14) => html`
    <svg class="k-lib-icon" viewBox="0 0 16 16" width=${size} height=${size} fill="none" stroke="currentColor"
         stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const icons = {
    close: svg(svgPaths`<path d="M4 4l8 8M12 4l-8 8" />`, 15),
    image: svg(svgPaths`<rect x="2.5" y="3" width="11" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5" />`),
    pen: svg(svgPaths`<path d="M10.6 3.4a1.5 1.5 0 0 1 2.1 2.1L6.4 11.8l-2.9.7.7-2.9z" /><path d="M9.4 4.6l2 2" />`),
    copy: svg(svgPaths`<rect x="5" y="5" width="8" height="8" rx="1.4" /><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />`),
    trash: svg(svgPaths`<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />`),
    sync: svg(svgPaths`<path d="M13 6.5A5 5 0 0 0 4.2 4.4L3 5.6" /><path d="M3 3v2.6h2.6" /><path d="M3 9.5a5 5 0 0 0 8.8 2.1L13 10.4" /><path d="M13 13v-2.6h-2.6" />`),
    book: svg(svgPaths`<path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3zM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13z" />`),
    gear: svg(svgPaths`<circle cx="8" cy="8" r="2.1" /><path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1" />`),
    check: svg(svgPaths`<path d="M3.5 8.5 6.5 11.5 12.5 4.5" />`, 12),
    plus: svg(svgPaths`<path d="M8 3.25v9.5M3.25 8h9.5" />`),
    up: svg(svgPaths`<path d="M8 12.5v-9M4.25 7.25 8 3.5l3.75 3.75" />`, 12),
    down: svg(svgPaths`<path d="M8 3.5v9M4.25 8.75 8 12.5l3.75-3.75" />`, 12),
    chevronDown: svg(svgPaths`<path d="m4 6 4 4 4-4" />`, 12),
    chevronRight: svg(svgPaths`<path d="m6 4 4 4-4 4" />`, 12),
};

/**
 * The chapters. `level: 'advanced'` chapters hide in Simple; their slots still render.
 * Copy names the persona or says "you": Kotatsu cannot know anyone's pronouns.
 */
const CHAPTERS = Object.freeze([
    { id: 'who', n: '1', title: 'Who you are', blurb: 'What the model knows about you. Write it the way you\'d introduce yourself at the table.', level: 'simple' },
    { id: 'variants', n: '2', title: 'When you\'re different', blurb: 'Extra lines that fold in after your description, only where they belong: with certain characters, in certain chats, or when a card matches.', level: 'simple' },
    { id: 'reads', n: '3', title: 'What the model reads', blurb: 'Everything above as it will arrive here, macros filled in, and where it lands.', level: 'simple' },
    { id: 'where', n: '4', title: 'Where it goes', blurb: 'Where in the prompt your description is placed.', level: 'advanced' },
    { id: 'ties', n: '5', title: 'What it\'s tied to', blurb: 'Which chats and characters pick this persona on their own.', level: 'simple' },
    { id: 'hood', n: '', title: 'Under the hood', blurb: 'This persona as a file, and the rules every persona shares.', level: 'advanced' },
]);

export class KPersonaStudio extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        view: { type: String, reflect: true },
        _id: { state: true },
        _name: { state: true },
        _title: { state: true },
        _description: { state: true },
        _position: { state: true },
        _depth: { state: true },
        _role: { state: true },
        _lorebook: { state: true },
        _tokens: { state: true },
        _bust: { state: true },
        _artFailed: { state: true },
        _variants: { state: true },
        _context: { state: true },
        _tokensHere: { state: true },
        _format: { state: true },
    };

    /** Monotonic, so a slow composed count cannot land on a later edit. */
    #countTicket = 0;

    #relocator = new Relocator();

    /** @type {Array<{ type: string, handler: (...args: any[]) => void }>} */
    #subscriptions = [];

    /** @type {MutationObserver[]} */
    #observers = [];

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** Coalesces bursts of `input` from the borrowed controls into one re-read. */
    #readFrame = 0;

    /** @type {(event: Event) => void} */
    #onInput = () => this.#scheduleRead();

    /** A replaced portrait: re-bust the hero when it's this persona's. @type {(event: Event) => void} */
    #onPortraitReplaced = (event) => {
        const id = event instanceof CustomEvent ? event.detail?.id : '';
        if (id && id === this._id) {
            this._artFailed = false;
            this._bust = portraitBust(id);
        }
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {'simple'|'advanced'} */
        this.view = this.#storedView();
        this._id = '';
        this._name = '';
        this._title = '';
        this._description = '';
        /** @type {number} */
        this._position = PERSONA_POSITIONS.IN_PROMPT;
        /** @type {number} */
        this._depth = 2;
        /** @type {number} */
        this._role = 0;
        this._lorebook = '';
        /** @type {string} */
        this._tokens = '';
        /** The hero portrait's cache-buster (`persona-portraits.js`); 0 until its image changes. */
        this._bust = 0;
        this._artFailed = false;
        /** @type {import('../library/persona-variants.js').PersonaVariant[]} */
        this._variants = [];
        /** @type {import('../library/persona-variants.js').VariantContext} */
        this._context = { characterKeys: [], chatId: '', cardText: '' };
        /** Token count of the COMPOSED description here; `''` when no variant is on here. */
        this._tokensHere = '';
        /** @type {import('../library/persona-variants.js').VariantFormat} */
        this._format = { joiner: '\n\n', wrapper: '' };
        /**
         * The Joiner field's raw text while it has focus. Re-escaping the stored joiner on every
         * keystroke turned a lone backslash into two before the "n" could follow it.
         * @type {string|null}
         */
        this._joinerDraft = null;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);

        // Window, capture: the card studio's rung. Stands down while core's own popups are up
        // (rename, delete confirm, lorebook picker): Escape is theirs first.
        this.#onEscape = (event) => {
            if (event.key !== 'Escape' || corePopupOpen()) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.close();
        };
        window.addEventListener('keydown', this.#onEscape, { capture: true });

        const on = (/** @type {string} */ type, /** @type {(...args: any[]) => void} */ handler) => {
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        };
        for (const type of [event_types.PERSONA_CHANGED, event_types.PERSONA_UPDATED, event_types.PERSONA_RENAMED, event_types.SETTINGS_UPDATED]) {
            if (typeof type === 'string') on(type, () => this.#scheduleRead());
        }
        // Delete is REAL (core's button, core's confirm). The persona this page edits is gone.
        if (typeof event_types.PERSONA_DELETED === 'string') on(event_types.PERSONA_DELETED, () => this.close());

        this.addEventListener('input', this.#onInput);
        this.addEventListener('change', this.#onInput);
        document.addEventListener(PORTRAIT_REPLACED_EVENT, this.#onPortraitReplaced);

        document.body.classList.add('k-studio-open', 'k-persona-studio-open');
    }

    disconnectedCallback() {
        // SYNCHRONOUS, before `super`: the rails layout removes us and then restores its own
        // ledger, so every borrowed control must be home by the time this returns.
        this.#teardown();
        super.disconnectedCallback();
    }

    #teardown() {
        if (this.#onEscape) {
            window.removeEventListener('keydown', this.#onEscape, { capture: true });
            this.#onEscape = null;
        }
        for (const { type, handler } of this.#subscriptions) eventSource.removeListener(type, handler);
        this.#subscriptions = [];
        for (const observer of this.#observers) observer.disconnect();
        this.#observers = [];
        if (this.#readFrame) cancelAnimationFrame(this.#readFrame);
        this.#readFrame = 0;
        this.removeEventListener('input', this.#onInput);
        this.removeEventListener('change', this.#onInput);
        document.removeEventListener(PORTRAIT_REPLACED_EVENT, this.#onPortraitReplaced);
        this.#relocator.restoreAll();
        document.body.classList.remove('k-studio-open', 'k-persona-studio-open');
    }

    firstUpdated() {
        this.#place();
        this.#observe();
        this.#read();
        const description = document.getElementById(PERSONA_SLOTS[0].id);
        if (description instanceof HTMLElement && this.contains(description)) description.focus({ preventScroll: true });
    }

    /** Closes the studio. Removal IS the restore. @returns {void} */
    close() {
        this.remove();
    }

    /** What the probe reads. @returns {object} A plain snapshot. */
    get state() {
        return {
            open: this.isConnected,
            id: this._id,
            name: this._name,
            view: this.view,
            borrowed: this.#relocator.size,
            tokens: this._tokens,
            position: this._position,
        };
    }

    /* ── borrowing ──────────────────────────────────────────────────────────── */

    /** Borrows every manifest slot. A missing control costs its field, never the page. @returns {void} */
    #place() {
        for (const slot of PERSONA_SLOTS) {
            const target = this.querySelector(`[data-slot="${CSS.escape(slot.key)}"]`);
            const unit = slotUnit(slot);
            if (!target) {
                console.warn(`[k-persona-studio] no slot rendered for "${slot.key}".`);
                continue;
            }
            if (!unit) {
                console.warn(`[k-persona-studio] core control #${slot.id} is missing; the "${slot.key}" field is empty.`);
                continue;
            }
            this.#relocator.relocate(unit, target);
        }
    }

    /**
     * Watches what changes without an `input` we'd hear:
     * - core's token counter text (it counts on a debounce after typing);
     * - the stock grid, which core re-renders after an image replace (`changeUserAvatar` →
     *   `getUserAvatars(true, …)`): the cue to bust the hero portrait's cache;
     * - `<body>`, for a settings modal arriving (exclusion, doc §0).
     * @returns {void}
     */
    #observe() {
        const counter = document.getElementById(PERSONA_TOKEN_COUNTER_ID);
        if (counter) {
            const observer = new MutationObserver(() => { this._tokens = counter.textContent?.trim() ?? ''; });
            observer.observe(counter, { childList: true, characterData: true, subtree: true });
            this.#observers.push(observer);
        }
        const body = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node instanceof Element && node.localName === 'k-settings-modal') {
                        this.close();
                        return;
                    }
                }
            }
        });
        body.observe(document.body, { childList: true });
        this.#observers.push(body);
    }

    #scheduleRead() {
        if (this.#readFrame) return;
        this.#readFrame = requestAnimationFrame(() => {
            this.#readFrame = 0;
            this.#read();
        });
    }

    /** Re-reads core: who's on, the descriptor, the live control values. @returns {void} */
    #read() {
        const id = typeof user_avatar === 'string' ? user_avatar : '';
        if (id !== this._id) this._artFailed = false;
        this._bust = portraitBust(id);
        this._id = id;
        const name = power_user?.personas?.[id];
        this._name = typeof name === 'string' && name.trim() ? name.trim() : id;
        const descriptor = power_user?.persona_descriptions?.[id] ?? {};
        this._title = typeof descriptor.title === 'string' ? descriptor.title : '';
        this._lorebook = typeof descriptor.lorebook === 'string' ? descriptor.lorebook : '';
        // The borrowed controls are the live truth while they're being typed in; the descriptor
        // catches up on core's debounce.
        const area = document.getElementById('persona_description');
        this._description = area instanceof HTMLTextAreaElement ? area.value : String(descriptor.description ?? '');
        const position = document.getElementById('persona_description_position');
        this._position = position instanceof HTMLSelectElement ? Number(position.value) : Number(descriptor.position ?? 0);
        const depth = document.getElementById('persona_depth_value');
        this._depth = depth instanceof HTMLInputElement && depth.value !== '' ? Number(depth.value) : Number(descriptor.depth ?? 2);
        const role = document.getElementById('persona_depth_role');
        this._role = role instanceof HTMLSelectElement ? Number(role.value) : Number(descriptor.role ?? 0);
        this._tokens = document.getElementById(PERSONA_TOKEN_COUNTER_ID)?.textContent?.trim() ?? '';
        this._variants = readVariants(id);
        this._format = readFormat(id);
        this._context = readVariantContext();
        void this.#countHere();
    }

    /** @returns {import('../library/persona-variants.js').PersonaVariant[]} The items folding in here. */
    #onHere() {
        return activeItems(this._variants, this._context);
    }

    /** @returns {string} The description as the prompt will carry it here (raw macros). */
    #composedHere() {
        return this.#onHere().length
            ? composeDescription(this._description, this._variants, this._context, this._format)
            : this._description;
    }

    /** Core's tokenizer over the composed text, only when a variant changes it. @returns {Promise<void>} */
    async #countHere() {
        const ticket = ++this.#countTicket;
        if (!this.#onHere().length) {
            this._tokensHere = '';
            return;
        }
        try {
            const count = await getTokenCountAsync(this.#composedHere());
            if (ticket === this.#countTicket) this._tokensHere = String(count);
        } catch (error) {
            console.warn('[k-persona-studio] composed token count failed', error);
        }
    }

    /* ── variants ───────────────────────────────────────────────────────────── */

    /**
     * Writes the whole list (the descriptor holds one array; settings saves it as one leaf).
     * @param {import('../library/persona-variants.js').PersonaVariant[]} next The new list.
     * @returns {void}
     */
    #saveVariants(next) {
        if (!this._id) return;
        writeVariants(this._id, next);
        this._variants = readVariants(this._id);
        void this.#countHere();
    }

    /**
     * Rewrites one entry wherever it sits (top level or inside a group).
     * @param {string} id Variant id.
     * @param {(variant: import('../library/persona-variants.js').PersonaVariant) => (import('../library/persona-variants.js').PersonaVariant|null)} update Returns the new entry, or null to remove it.
     * @returns {import('../library/persona-variants.js').PersonaVariant[]} The new list.
     */
    #mapTree(id, update) {
        /** @param {import('../library/persona-variants.js').PersonaVariant[]} list */
        const walk = list => list.flatMap((variant) => {
            if (variant.id === id) {
                const next = update(variant);
                return next ? [next] : [];
            }
            return variant.kind === 'group' ? [{ ...variant, children: walk(variant.children) }] : [variant];
        });
        return walk(this._variants);
    }

    /**
     * @param {string} id Variant id.
     * @returns {import('../library/persona-variants.js').PersonaVariant|null} The entry, anywhere in the tree.
     */
    #find(id) {
        for (const variant of this._variants) {
            if (variant.id === id) return variant;
            const child = variant.children.find(entry => entry.id === id);
            if (child) return child;
        }
        return null;
    }

    /**
     * @param {string} id Variant id.
     * @param {Partial<import('../library/persona-variants.js').PersonaVariant>} patch Fields to change.
     * @returns {void}
     */
    #patchVariant(id, patch) {
        this.#saveVariants(this.#mapTree(id, variant => ({ ...variant, ...patch })));
    }

    /**
     * The switch. Asks first when flipping would make the next reply re-send the whole chat
     * (`confirmVariantFlip`, doc §7.3); silent when it costs nothing.
     * @param {string} id Variant or group id.
     * @returns {Promise<void>}
     */
    async #flip(id) {
        if (!(await confirmVariantFlip(this._id, id))) return;
        const variant = this.#find(id);
        if (variant) this.#patchVariant(id, { enabled: !variant.enabled });
    }

    /**
     * The heads-up for macros that change every message, when this persona sits ahead of the
     * chat (where a changing line means every reply re-sends it all).
     * @param {string} text Description or variant text.
     * @returns {unknown}
     */
    #perTurnNote(text) {
        if (!positionIsCached(this._position)) return nothing;
        const copy = perTurnNoteCopy(perTurnMacros(text));
        return copy ? html`<p class="k-pstudio-note" role="note">${copy}</p>` : nothing;
    }

    /** Swaps an entry with its neighbour in whichever list holds it. @param {string} id @param {-1|1} step @returns {void} */
    #moveVariant(id, step) {
        /** @param {import('../library/persona-variants.js').PersonaVariant[]} list */
        const move = (list) => {
            const from = list.findIndex(variant => variant.id === id);
            if (from >= 0) {
                const to = from + step;
                if (to < 0 || to >= list.length) return list;
                const copy = [...list];
                [copy[from], copy[to]] = [copy[to], copy[from]];
                return copy;
            }
            return list.map(variant => (variant.kind === 'group' ? { ...variant, children: move(variant.children) } : variant));
        };
        this.#saveVariants(move(this._variants));
    }

    /**
     * Moves an item into a group (appended), or out to the top level (appended) with `''`.
     * @param {string} id Item id.
     * @param {string} groupId Target group id, `''` for the top level.
     * @returns {void}
     */
    #regroup(id, groupId) {
        const item = this.#find(id);
        if (!item || item.kind === 'group') return;
        const without = this.#mapTree(id, () => null);
        const next = groupId
            ? without.map(variant => (variant.id === groupId ? { ...variant, children: [...variant.children, item], collapsed: false } : variant))
            : [...without, item];
        this.#saveVariants(next);
    }

    /** Asks first when there's something to lose; core's own confirm, so Escape layers right. @param {string} id @returns {Promise<void>} */
    async #removeVariant(id) {
        const variant = this.#find(id);
        if (!variant) return;
        const isGroup = variant.kind === 'group';
        if (isGroup ? variant.children.length > 0 : variant.text.trim()) {
            const ok = await Popup.show.confirm(
                isGroup ? 'Delete this group?' : 'Delete this variant?',
                isGroup
                    ? `“${variant.title || 'Untitled group'}” and the ${variant.children.length} ${variant.children.length === 1 ? 'variant' : 'variants'} in it will be gone.`
                    : `“${variant.title || 'Untitled'}” and its text will be gone.`);
            if (!ok) return;
        }
        this.#saveVariants(this.#mapTree(id, () => null));
    }

    /**
     * Adds a blank item at the top level, or at the end of a group.
     * @param {string} [groupId] The group to add into.
     * @returns {void}
     */
    #addVariant(groupId = '') {
        const fresh = blankVariant();
        const next = groupId
            ? this._variants.map(variant => (variant.id === groupId ? { ...variant, children: [...variant.children, fresh], collapsed: false } : variant))
            : [...this._variants, fresh];
        this.#saveVariants(next);
        this.#focusTitle(fresh.id);
    }

    #addGroup() {
        const fresh = blankGroup();
        this.#saveVariants([...this._variants, fresh]);
        this.#focusTitle(fresh.id);
    }

    /** @param {string} id The new entry. @returns {void} */
    #focusTitle(id) {
        void this.updateComplete.then(() => {
            const title = this.querySelector(`[data-variant="${CSS.escape(id)}"] .k-pvar-title`);
            if (title instanceof HTMLElement) title.focus();
        });
    }

    /**
     * The Joiner field keeps what you typed while it has focus (`_joinerDraft`); only the stored
     * joiner is unescaped, so "\" then "n" lands as a new line.
     * @param {Event} event
     * @returns {void}
     */
    #onJoinerInput(event) {
        const typed = /** @type {HTMLInputElement} */ (event.target).value;
        this._joinerDraft = typed;
        this.#patchFormat({ joiner: unescapeJoiner(typed) });
    }

    /** @param {Partial<import('../library/persona-variants.js').VariantFormat>} patch @returns {void} */
    #patchFormat(patch) {
        if (!this._id) return;
        writeFormat(this._id, { ...this._format, ...patch });
        this._format = readFormat(this._id);
        void this.#countHere();
    }

    /* ── the view ───────────────────────────────────────────────────────────── */

    /** @returns {'simple'|'advanced'} */
    #storedView() {
        try {
            return accountStorage.getItem(PERSONA_STUDIO_VIEW_KEY) === 'advanced' ? 'advanced' : 'simple';
        } catch {
            return 'simple';
        }
    }

    /** @param {'simple'|'advanced'} view */
    #setView(view) {
        this.view = view;
        try {
            accountStorage.setItem(PERSONA_STUDIO_VIEW_KEY, view);
        } catch {
            // A convenience; a storage that refuses it costs nothing but the memory.
        }
    }

    /** Opens core's lorebook link popup through the "More…" dropdown's own change handler. @returns {void} */
    #linkLorebook() {
        const select = document.getElementById(PERSONA_PROXIES.dropdown);
        const option = document.getElementById(PERSONA_PROXIES.lorebookLink);
        if (!(select instanceof HTMLSelectElement) || !(option instanceof HTMLOptionElement)) {
            console.warn('[k-persona-studio] the lorebook link menu is missing.');
            return;
        }
        option.selected = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * "See it in the last prompt": the receipt tracker's persona row is what was ACTUALLY sent;
     * chapter ③ is what WILL be sent. Closes the studio (it covers the rail), asks the right
     * rail for its Trackers page through `k-show-rail-tab`, then scrolls the persona row into
     * view and flashes it. If the tracker has no receipt yet, its own empty state says so.
     * @returns {Promise<void>}
     */
    async #toReceipts() {
        this.close();
        /** @type {{ id: string, ready?: Promise<unknown> }} */
        const detail = { id: 'trackers' };
        const answered = !document.dispatchEvent(new CustomEvent('k-show-rail-tab', { cancelable: true, detail }));
        if (!answered) {
            console.warn('[k-persona-studio] no rail answered; the receipt tracker is not on screen.');
            return;
        }
        await detail.ready;
        // The tracker mounts with the page and loads its receipts async: give it two frames.
        for (let frame = 0; frame < 20; frame += 1) {
            const row = document.querySelector('k-receipt-tracker .k-rt-entry[data-k-cat="persona"]');
            if (row instanceof HTMLElement) {
                row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                row.classList.remove('k-rt-entry--flash');
                void row.offsetWidth;
                row.classList.add('k-rt-entry--flash');
                setTimeout(() => row.classList.remove('k-rt-entry--flash'), 1800);
                return;
            }
            await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        }
    }

    /** Backup, restore and stats live in Settings → Personas; the two never share the suite. @returns {void} */
    #toSettings() {
        this.close();
        openSettings({ tab: 'personas' });
    }

    /* ── render ─────────────────────────────────────────────────────────────── */

    render() {
        const simple = this.view === 'simple';
        return html`
            <div class="k-studio-scrim" @click=${() => this.close()}></div>
            <div class="k-studio-sheet k-pstudio" role="dialog" aria-modal="true" aria-label=${`Persona studio: ${this._name}`} data-view=${this.view}>
                ${this.#renderHead()}
                <div class="k-studio-body">
                    ${this.#renderHero()}
                    <div class="k-studio-page">
                        ${this.#chapter(CHAPTERS[0], simple, this.#renderWho())}
                        ${this.#chapter(CHAPTERS[1], simple, this.#renderVariants())}
                        ${this.#chapter(CHAPTERS[2], simple, this.#renderReads())}
                        ${this.#chapter(CHAPTERS[3], simple, this.#renderWhere())}
                        ${this.#chapter(CHAPTERS[4], simple, this.#renderTies(simple))}
                        ${this.#chapter(CHAPTERS[5], simple, this.#renderHood())}
                    </div>
                </div>
            </div>`;
    }

    #renderHead() {
        const here = this._tokensHere !== '';
        const tokens = here ? this._tokensHere : this._tokens === '' ? '…' : this._tokens;
        const where = here ? 'in prompts here' : 'in every prompt';
        return html`
            <header class="k-studio-head">
                <div class="k-studio-head-lead">
                    <span class="k-studio-eyebrow">Persona studio</span>
                    <span class="k-pstudio-tokens" title=${here ? 'Your description plus the variants that are on here, by core\'s tokenizer' : 'Core\'s token count for this description'}><b>${tokens} tokens</b> <span>${where}</span></span>
                    <span class="k-pstudio-wearing">${icons.check}<span>You're wearing ${this._name}</span></span>
                </div>
                <div class="k-studio-head-tools">
                    <div class="k-studio-view" role="group" aria-label="View">
                        <button type="button" aria-pressed=${this.view === 'simple' ? 'true' : 'false'} @click=${() => this.#setView('simple')}>Simple</button>
                        <button type="button" aria-pressed=${this.view === 'advanced' ? 'true' : 'false'} @click=${() => this.#setView('advanced')}>Advanced</button>
                    </div>
                    <span class="k-studio-autosave">${icons.check}Autosaves</span>
                    <button type="button" class="k-studio-save" @click=${() => this.close()}>Done</button>
                    <button type="button" class="k-studio-close k-studio-iconbtn" title="Close (Escape)" aria-label="Close the persona studio" @click=${() => this.close()}>${icons.close}</button>
                </div>
            </header>`;
    }

    #renderHero() {
        const src = this._id && !this._artFailed ? withBust(personaPortraitUrl(this._id), this._bust) : '';
        const art = src
            ? html`<img class="k-studio-stage__art" src=${src} alt=${`${this._name}'s portrait`} decoding="async" @error=${() => { this._artFailed = true; }}>`
            : html`<span class="k-studio-stage__initials" aria-hidden="true">${toInitials(this._name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim() || this._name)}</span>`;
        return html`
            <aside class="k-studio-hero k-pstudio-hero" aria-label=${this._name}>
                <div class="k-studio-stage" data-stage="art">${art}</div>
                <div class="k-pstudio-hero-actions">
                    <button type="button" class="k-studio-btn" @click=${() => proxyClick(PERSONA_PROXIES.image)}>${icons.image}<span>Replace image</span></button>
                    <button type="button" class="k-studio-btn" @click=${() => proxyClick(PERSONA_PROXIES.rename)}>${icons.pen}<span>Rename…</span></button>
                </div>
                <div class="k-pstudio-hero-name">
                    <h2 class="k-pstudio-name">${this._name}</h2>
                    ${this._title ? html`<p class="k-pstudio-title">${this._title}</p>` : nothing}
                </div>
            </aside>`;
    }

    /**
     * @param {{ id: string, n: string, title: string, blurb: string, level: string }} chapter
     * @param {boolean} simple Simple view.
     * @param {unknown} body The chapter's fields.
     * @returns {unknown}
     */
    #chapter(chapter, simple, body) {
        return html`
            <section class="k-studio-chapter" data-chapter=${chapter.id} aria-labelledby=${`k-pstudio-ch-${chapter.id}`} ?hidden=${simple && chapter.level === 'advanced'}>
                <header class="k-studio-chapter-head">
                    <h3 id=${`k-pstudio-ch-${chapter.id}`} class="k-studio-chapter-title"><span class="k-studio-chapter-badge" aria-hidden="true">${chapter.n || icons.gear}</span>${chapter.title}</h3>
                    <p class="k-studio-chapter-blurb">${chapter.blurb}</p>
                </header>
                <div class="k-studio-fields">${body}</div>
            </section>`;
    }

    /**
     * One labelled field holding borrowed slots. Always rendered; hidden by attribute.
     * @param {{ label: string, st?: string, hint?: string, slots: string[], half?: boolean, hidden?: boolean, extra?: unknown, after?: unknown }} field
     * @returns {unknown}
     */
    #field(field) {
        return html`
            <div class="k-studio-field${field.half ? ' is-half' : ''}" ?hidden=${Boolean(field.hidden)}>
                <div class="k-studio-labelrow">
                    <span class="k-studio-label">${field.label}${field.st ? html` <span class="k-studio-stname">(${field.st})</span>` : nothing}</span>
                    ${field.hint ? html`<span class="k-studio-hint">${field.hint}</span>` : nothing}
                </div>
                ${field.extra ?? nothing}
                <div class="k-studio-control">${field.slots.map(key => html`<div class="k-studio-slot" data-slot=${key}></div>`)}</div>
                ${field.after ?? nothing}
            </div>`;
    }

    #renderWho() {
        return this.#field({ label: 'About you', st: 'Persona Description', hint: '{{user}} becomes your name', slots: ['desc'], after: this.#perTurnNote(this._description) });
    }

    #renderVariants() {
        const targets = variantTargets();
        const groups = this._variants.filter(variant => variant.kind === 'group');
        const count = this._variants.length;
        return html`
            <div class="k-studio-field">
                ${count ? nothing : html`<p class="k-pstudio-quiet">None yet. A variant is a few lines about you that only show up somewhere specific: at the office with your boss, in armor in the fantasy chats, or whenever a card mentions dragons. A group switches a handful of them together.</p>`}
                <div class="k-pvar-list">${this._variants.map((variant, index) => (variant.kind === 'group'
        ? this.#renderGroup(variant, index, count, targets, groups)
        : this.#renderVariant(variant, index, count, targets, groups, '')))}</div>
                ${flipWarningsOn() ? nothing : html`
                    <p class="k-pstudio-quiet">You turned off the heads-up for switching variants mid-chat.
                        <button type="button" class="k-studio-link" @click=${() => { setFlipWarnings(true); this.requestUpdate(); }}>Turn it back on</button></p>`}
                <div class="k-pstudio-actions">
                    <button type="button" class="k-studio-btn k-pvar-add" @click=${() => this.#addVariant()}>${icons.plus}<span>Add a variant</span></button>
                    <button type="button" class="k-studio-btn k-pvar-add-group" @click=${() => this.#addGroup()}>${icons.plus}<span>Add a group</span></button>
                </div>
            </div>
            ${this.#renderFormat()}`;
    }

    /**
     * The four-way "When" picker plus the trigger's own controls. Shared by items and groups.
     * @param {import('../library/persona-variants.js').PersonaVariant} variant The entry.
     * @param {Array<{ key: string, name: string, kind: string }>} targets Everyone it can be tied to.
     * @returns {unknown}
     */
    #renderWhen(variant, targets) {
        const id = variant.id;
        const what = variant.kind === 'group' ? 'this group switches on' : 'this variant folds in';
        return html`
            <div class="k-pvar-when">
                <span class="k-studio-label">When</span>
                <div class="k-studio-control k-pvar-trigger">
                    <select aria-label=${`When ${what}`} @change=${(/** @type {Event} */ event) => this.#patchVariant(id, { when: /** @type {any} */ (/** @type {HTMLSelectElement} */ (event.target).value) })}>
                        <option value="always" .selected=${variant.when === 'always'}>Always (switch it on and off by hand)</option>
                        <option value="characters" .selected=${variant.when === 'characters'}>With certain characters or scenes</option>
                        <option value="chats" .selected=${variant.when === 'chats'}>In certain chats</option>
                        <option value="match" .selected=${variant.when === 'match'}>When the character's card matches</option>
                    </select>
                </div>
                ${this.#renderTrigger(variant, targets)}
            </div>`;
    }

    /**
     * The switch, name, "On here", and move/delete row. Shared by items and groups.
     * @param {import('../library/persona-variants.js').PersonaVariant} variant The entry.
     * @param {number} index Its place in its list.
     * @param {number} count How many share that list.
     * @param {unknown} [lead] Anything before the switch (the group's fold chevron).
     * @returns {unknown}
     */
    #renderHeadRow(variant, index, count, lead = nothing) {
        const id = variant.id;
        const group = variant.kind === 'group';
        const noun = group ? 'group' : 'variant';
        const active = isVariantActive(variant, this._context);
        return html`
            <div class="k-pvar-head">
                ${lead}
                <button type="button" class="k-pvar-switch" role="switch" aria-checked=${variant.enabled ? 'true' : 'false'}
                    aria-label=${variant.enabled ? `Switch this ${noun} off` : `Switch this ${noun} on`} title=${variant.enabled ? 'On' : 'Off'}
                    @click=${() => { void this.#flip(id); }}><span class="k-pvar-knob"></span></button>
                <input class="k-pvar-title" type="text" .value=${variant.title} placeholder=${group ? 'Name the group (Fantasy)' : 'Name it (At the office)'} aria-label=${`${group ? 'Group' : 'Variant'} name`}
                    @input=${(/** @type {Event} */ event) => this.#patchVariant(id, { title: /** @type {HTMLInputElement} */ (event.target).value })}>
                ${active ? html`<span class="k-pvar-chip is-here">${icons.check}On here</span>` : nothing}
                <div class="k-pvar-tools">
                    <button type="button" class="k-studio-iconbtn" aria-label="Move up" title="Move up" ?disabled=${index === 0} @click=${() => this.#moveVariant(id, -1)}>${icons.up}</button>
                    <button type="button" class="k-studio-iconbtn" aria-label="Move down" title="Move down" ?disabled=${index === count - 1} @click=${() => this.#moveVariant(id, 1)}>${icons.down}</button>
                    <button type="button" class="k-studio-iconbtn k-pstudio-danger" aria-label=${`Delete this ${noun}`} title="Delete" @click=${() => { void this.#removeVariant(id); }}>${icons.trash}</button>
                </div>
            </div>`;
    }

    /**
     * One variant card. Kotatsu-owned fields (not borrowed), so branches are fine here.
     * @param {import('../library/persona-variants.js').PersonaVariant} variant The variant.
     * @param {number} index Its place in its list.
     * @param {number} count How many share that list.
     * @param {Array<{ key: string, name: string, kind: string }>} targets Everyone it can be tied to.
     * @param {import('../library/persona-variants.js').PersonaVariant[]} groups Every group, for "Group".
     * @param {string} parentId The group it sits in, `''` at the top level.
     * @returns {unknown}
     */
    #renderVariant(variant, index, count, targets, groups, parentId) {
        const id = variant.id;
        const active = isVariantActive(variant, this._context);
        const regroup = groups.length
            ? html`
                <div class="k-pvar-regroup">
                    <span class="k-studio-label">Group</span>
                    <div class="k-studio-control">
                        <select aria-label="Which group this variant is in" @change=${(/** @type {Event} */ event) => this.#regroup(id, /** @type {HTMLSelectElement} */ (event.target).value)}>
                            <option value="" .selected=${!parentId}>None</option>
                            ${groups.map(group => html`<option value=${group.id} .selected=${parentId === group.id}>${group.title || 'Untitled group'}</option>`)}
                        </select>
                    </div>
                </div>`
            : nothing;
        return html`
            <article class="k-pvar${parentId ? ' k-pvar--child' : ''}" data-variant=${id} ?data-on=${active} ?data-off=${!variant.enabled}>
                ${this.#renderHeadRow(variant, index, count)}
                <div class="k-studio-control">
                    <textarea class="k-pvar-text" rows="3" .value=${variant.text} placeholder="What's different about you then. {{user}} works here too." aria-label="Variant text"
                        @input=${(/** @type {Event} */ event) => this.#patchVariant(id, { text: /** @type {HTMLTextAreaElement} */ (event.target).value })}></textarea>
                </div>
                ${this.#perTurnNote(variant.text)}
                ${this.#renderWhen(variant, targets)}
                <div class="k-pvar-foot">
                    <p class="k-pvar-summary">${triggerSummary(variant, targetName)}${parentId ? ' · and only while its group is on' : ''}</p>
                    ${regroup}
                </div>
            </article>`;
    }

    /**
     * A group card: its own switch and trigger gate the variants inside it.
     * @param {import('../library/persona-variants.js').PersonaVariant} group The group.
     * @param {number} index Its place in the top level.
     * @param {number} count How many entries share the top level.
     * @param {Array<{ key: string, name: string, kind: string }>} targets Everyone it can be tied to.
     * @param {import('../library/persona-variants.js').PersonaVariant[]} groups Every group.
     * @returns {unknown}
     */
    #renderGroup(group, index, count, targets, groups) {
        const id = group.id;
        const active = isVariantActive(group, this._context);
        const open = !group.collapsed;
        const chevron = html`
            <button type="button" class="k-studio-iconbtn k-pvar-fold" aria-expanded=${open ? 'true' : 'false'}
                aria-label=${open ? 'Fold the group shut' : 'Open the group'} title=${open ? 'Fold' : 'Open'}
                @click=${() => this.#patchVariant(id, { collapsed: open })}>${open ? icons.chevronDown : icons.chevronRight}</button>`;
        const size = group.children.length;
        return html`
            <section class="k-pvar k-pvar--group" data-variant=${id} ?data-on=${active} ?data-off=${!group.enabled} ?data-folded=${!open}>
                ${this.#renderHeadRow(group, index, count, chevron)}
                <p class="k-pvar-summary">${size} ${size === 1 ? 'variant' : 'variants'} · ${triggerSummary(group, targetName)}</p>
                ${open ? html`
                    ${this.#renderWhen(group, targets)}
                    <div class="k-pvar-list k-pvar-children">
                        ${group.children.map((child, childIndex) => this.#renderVariant(child, childIndex, size, targets, groups, id))}
                    </div>
                    <div class="k-pstudio-actions">
                        <button type="button" class="k-studio-btn" @click=${() => this.#addVariant(id)}>${icons.plus}<span>Add to this group</span></button>
                    </div>` : nothing}
            </section>`;
    }

    /**
     * How the folded variants are joined and wrapped. Advanced; in Simple a non-default format
     * still says it's there (Simple never hides something that is ON).
     * @returns {unknown}
     */
    #renderFormat() {
        const simple = this.view === 'simple';
        const custom = !isDefaultFormat(this._format);
        const wrapper = this._format.wrapper;
        const wrapperIgnored = Boolean(wrapper.trim()) && !wrapper.includes(WRAPPER_PLACEHOLDER);
        return html`
            <div class="k-studio-field" ?hidden=${simple && !custom}>
                <div class="k-studio-labelrow">
                    <span class="k-studio-label">How they're joined</span>
                    ${simple ? html`<span class="k-studio-hint">A custom joiner or wrapper is set in Advanced</span>` : nothing}
                </div>
                <div class="k-pvar-format" ?hidden=${simple}>
                    <label class="k-pvar-format-row">
                        <span class="k-studio-label">Joiner</span>
                        <span class="k-studio-control"><input type="text" class="k-pvar-joiner" .value=${this._joinerDraft ?? escapeJoiner(this._format.joiner)} aria-label="Joiner"
                            @blur=${() => { this._joinerDraft = null; this.requestUpdate(); }}
                            @input=${(/** @type {Event} */ event) => this.#onJoinerInput(event)}></span>
                        <span class="k-studio-hint">Between your description and each variant. \n is a new line.</span>
                    </label>
                    <label class="k-pvar-format-row">
                        <span class="k-studio-label">Wrapper</span>
                        <span class="k-studio-control"><input type="text" class="k-pvar-wrapper" .value=${wrapper} placeholder=${`[Right now: ${WRAPPER_PLACEHOLDER}]`} aria-label="Wrapper"
                            @input=${(/** @type {Event} */ event) => this.#patchFormat({ wrapper: /** @type {HTMLInputElement} */ (event.target).value })}></span>
                        <span class="k-studio-hint${wrapperIgnored ? ' is-error' : ''}">${wrapperIgnored ? `Needs ${WRAPPER_PLACEHOLDER} where the variants go; ignored until then.` : `Wraps the folded variants, never your description. ${WRAPPER_PLACEHOLDER} is where they go.`}</span>
                    </label>
                    ${custom ? html`<div class="k-pstudio-actions"><button type="button" class="k-studio-link" @click=${() => { this._joinerDraft = null; this.#patchFormat({ joiner: '\n\n', wrapper: '' }); }}>Back to the default</button></div>` : nothing}
                </div>
            </div>`;
    }

    /**
     * The trigger's own controls.
     * @param {import('../library/persona-variants.js').PersonaVariant} variant The variant.
     * @param {Array<{ key: string, name: string, kind: string }>} targets Everyone it can be tied to.
     * @returns {unknown}
     */
    #renderTrigger(variant, targets) {
        const id = variant.id;
        if (variant.when === 'characters') {
            const chosen = new Set(variant.characters);
            const left = targets.filter(target => !chosen.has(target.key));
            return html`
                <div class="k-pvar-targets">
                    ${variant.characters.map(key => html`
                        <span class="k-pvar-chip">${targetName(key) || `${key} (gone)`}<button type="button" class="k-pvar-chip-x" aria-label=${`Remove ${targetName(key) || key}`}
                            @click=${() => this.#patchVariant(id, { characters: variant.characters.filter(entry => entry !== key) })}>${icons.close}</button></span>`)}
                    <div class="k-studio-control k-pvar-add-target">
                        <select aria-label="Add a character or scene" @change=${(/** @type {Event} */ event) => {
        const select = /** @type {HTMLSelectElement} */ (event.target);
        if (select.value) this.#patchVariant(id, { characters: [...variant.characters, select.value] });
        select.value = '';
    }}>
                            <option value="" selected>Add someone…</option>
                            ${left.map(target => html`<option value=${target.key}>${target.kind === 'scene' ? `${target.name} (scene)` : target.name}</option>`)}
                        </select>
                    </div>
                </div>`;
        }
        if (variant.when === 'chats') {
            const chatId = this._context.chatId;
            const here = Boolean(chatId) && variant.chats.includes(chatId);
            const toggleHere = () => this.#patchVariant(id, { chats: here ? variant.chats.filter(entry => entry !== chatId) : [...variant.chats, chatId] });
            return html`
                <div class="k-pstudio-actions">
                    <button type="button" class="k-studio-btn" ?disabled=${!chatId} title=${chatId ? chatId : 'Open a chat first'} @click=${toggleHere}>
                        ${here ? html`${icons.check}<span>Tied to this chat</span>` : html`${icons.plus}<span>Tie to this chat</span>`}
                    </button>
                    ${variant.chats.length ? html`<button type="button" class="k-studio-link" @click=${() => this.#patchVariant(id, { chats: [] })}>Untie all ${variant.chats.length}</button>` : nothing}
                </div>`;
        }
        if (variant.when === 'match') {
            const typed = variant.pattern.trim();
            const valid = !typed || compilePattern(variant.pattern) !== null;
            // `/(bad` is a valid PHRASE (no closing slash), which is never what someone typing a
            // leading slash meant. Say so instead of matching it literally in silence.
            const halfRegex = valid && typed.startsWith('/') && !/^\/.+\/[a-z]*$/s.test(typed);
            return html`
                <div class="k-studio-control">
                    <input type="text" class="k-pvar-pattern" .value=${variant.pattern} placeholder="dragon, or /knight|squire/i" aria-label="Pattern"
                        @input=${(/** @type {Event} */ event) => this.#patchVariant(id, { pattern: /** @type {HTMLInputElement} */ (event.target).value })}>
                </div>
                <span class="k-studio-hint${valid && !halfRegex ? '' : ' is-error'}">${!valid ? 'That regex doesn\'t compile, so it matches nothing.' : halfRegex ? 'Starts like a regex: close it with / (and flags), or it\'s matched as plain text.' : 'A phrase, or /regex/flags. Checked against the character\'s name and description.'}</span>`;
        }
        return nothing;
    }

    #renderReads() {
        const text = resolveUserMacro(this.#composedHere(), this._name);
        const on = this.#onHere();
        const folded = on.length
            ? html`<p class="k-pstudio-placement"><span class="k-studio-label">Folded in here</span> ${on.map(variant => html`<span class="k-pvar-chip">${variant.title || 'Untitled'}</span>`)}</p>`
            : nothing;
        const preview = text.trim()
            ? html`<p class="k-mkt-preview-text k-pstudio-preview">${text}</p>`
            : html`<p class="k-pstudio-quiet">Nothing yet. Until you write something, the model only knows your name.</p>`;
        const offInSimple = this.view === 'simple' && this._position !== PERSONA_POSITIONS.IN_PROMPT && this._position !== PERSONA_POSITIONS.AFTER_CHAR;
        return html`
            <div class="k-studio-field">
                ${preview}
                ${folded}
                <p class="k-pstudio-placement"><span class="k-studio-label">Lands</span> ${placementWords(this._position, this._depth, this._role)}${offInSimple ? html` <span class="k-studio-hint">Set in Advanced</span>` : nothing}</p>
                ${this._context.chatId ? html`
                    <div class="k-pstudio-actions">
                        <button type="button" class="k-studio-link k-pstudio-receipts" title="The receipt tracker shows what the last generation in this chat actually sent"
                            @click=${() => { void this.#toReceipts(); }}>See what the last prompt actually sent</button>
                    </div>` : nothing}
            </div>`;
    }

    #renderWhere() {
        return html`
            ${this.#field({ label: 'Position', st: 'Position', slots: ['position'], half: true })}
            ${this.#field({ label: 'Depth and role', st: 'In-chat @ Depth', slots: ['depth'], half: true, hidden: this._position !== PERSONA_POSITIONS.AT_DEPTH })}`;
    }

    /** @param {boolean} simple Simple view. */
    #renderTies(simple) {
        const lorebook = html`
            <div class="k-pstudio-actions">
                <span class="k-pstudio-lorebook">${this._lorebook ? html`${icons.book}<span>${this._lorebook}</span>` : 'No lorebook linked.'}</span>
                ${this._lorebook ? html`<button type="button" class="k-studio-btn" @click=${() => proxyClick(PERSONA_PROXIES.lore)}>${icons.book}<span>Open it</span></button>` : nothing}
                <button type="button" class="k-studio-btn" @click=${() => this.#linkLorebook()}>${icons.book}<span>${this._lorebook ? 'Change…' : 'Link a lorebook…'}</span></button>
            </div>`;
        return html`
            ${this.#field({ label: 'Locks', st: 'Connections', hint: 'Default for new chats · this character · this chat', slots: ['locks'] })}
            ${this.#field({ label: 'Connected characters', slots: ['conn-info', 'conn-list'], hidden: simple })}
            ${this.#field({ label: 'Persona lorebook', st: 'Persona Lore', slots: [], hidden: simple && !this._lorebook, extra: lorebook })}`;
    }

    #renderHood() {
        const actions = html`
            <div class="k-pstudio-actions">
                <button type="button" class="k-studio-btn" @click=${() => proxyClick(PERSONA_PROXIES.duplicate)}>${icons.copy}<span>Duplicate</span></button>
                <button type="button" class="k-studio-btn" title="Rewrite the name on every message you've sent in this chat" @click=${() => proxyClick(PERSONA_PROXIES.sync)}>${icons.sync}<span>Use this name on all my messages</span></button>
                <button type="button" class="k-studio-btn k-pstudio-danger" @click=${() => proxyClick(PERSONA_PROXIES.remove)}>${icons.trash}<span>Delete…</span></button>
            </div>`;
        const elsewhere = html`
            <div class="k-pstudio-actions">
                <button type="button" class="k-studio-link" @click=${() => this.#toSettings()}>Backup, restore and usage stats live in Persona settings</button>
            </div>`;
        return html`
            ${this.#field({ label: 'This persona', slots: [], extra: actions })}
            ${this.#field({ label: 'Every persona', st: 'Global Settings', slots: ['notify', 'multi', 'autolock'], after: elsewhere })}`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-persona-studio')) {
    customElements.define('k-persona-studio', KPersonaStudio);
}

/* ── doors ───────────────────────────────────────────────────────────────────── */

/** @returns {KPersonaStudio|null} */
function currentStudio() {
    const element = document.querySelector('k-persona-studio');
    return element instanceof KPersonaStudio ? element : null;
}

/**
 * Opens the studio on a persona, wearing it first (doc §0 "editing puts it on").
 * @param {string} [id] Avatar id; defaults to the persona you're wearing.
 * @returns {Promise<KPersonaStudio|null>} The studio, or null when it can't open here.
 */
export function openPersonaStudio(id) {
    const existing = currentStudio();
    if (existing) return Promise.resolve(existing);
    // One open at a time: a double-click on a poster's Edit used to pass the check above twice
    // during the `setUserAvatar` await, append two studios, and the second one's restore put
    // core's controls back into the first one's detached slots (gone until reload).
    if (!pendingOpen) {
        pendingOpen = openPersonaStudioOnce(id).finally(() => { pendingOpen = null; });
    }
    return pendingOpen;
}

/** @type {Promise<KPersonaStudio|null>|null} */
let pendingOpen = null;

/**
 * @param {string} [id]
 * @returns {Promise<KPersonaStudio|null>}
 */
async function openPersonaStudioOnce(id) {
    if (document.body.dataset.kLayout !== 'rails') {
        console.warn('[k-persona-studio] the persona studio is a rails surface; classic keeps the stock drawer.');
        return null;
    }
    // The modal holds `#persona-suite` while it's up. Its close is a synchronous remove().
    if (isSettingsModalOpen()) closeSettings();
    if (id && id !== user_avatar) {
        try {
            await setUserAvatar(id);
        } catch (error) {
            console.error('[k-persona-studio] could not put the persona on', error);
            return null;
        }
    }
    if (!user_avatar) {
        console.warn('[k-persona-studio] no persona is on; nothing to edit.');
        return null;
    }
    const studio = /** @type {KPersonaStudio} */ (document.createElement('k-persona-studio'));
    studio.setAttribute('variant', 'sheet');
    document.body.appendChild(studio);
    return studio;
}

/** @returns {void} */
export function closePersonaStudio() {
    currentStudio()?.close();
}

/** @returns {object|null} The probe's `.state`. */
export function personaStudioState() {
    return currentStudio()?.state ?? null;
}

/**
 * Called by the rails layout's `unmount()` BEFORE `ctx.restoreAll()`, beside
 * `uninstallStudio()`: an open persona studio is holding core's persona controls, and closing it
 * is what puts them back.
 * @returns {void}
 */
export function uninstallPersonaStudio() {
    closePersonaStudio();
}
