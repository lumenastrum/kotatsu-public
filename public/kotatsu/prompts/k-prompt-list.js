/**
 * `<k-prompt-list variant="list">` — the prompt manager's Lit view.
 * `promptManager` owns live preset state; this component derives the tree/model and owns
 * search, collapse, toggles, receipts, and pointer interactions. See docs/prompt-manager-v0.md.
 * The core render patch and explicit recount lifecycle live in ./render-seam.js.
 *
 * Behavioral constraints:
 * - Rendering never starts a dry generation. Real assemblies refresh counts through
 *   CHAT_COMPLETION_PROMPT_READY; the button and /kotatsu-recount request an explicit pass.
 * - Collapse and radio-group relaxation are stored per preset in accountStorage, using
 *   prompt identifiers as keys where possible so renaming a prompt keeps its state.
 * - Raw serviceSettings.prompts records supply row identity: `new Prompt(...)` drops marker.
 * - A span holds its opening prompt, children, and closing prompt. Both boundaries remain
 *   individually toggleable; reordering moves the whole block as a permutation of live entries.
 * - Radio enforcement batches sibling writes; a master toggle makes one write over the exact
 *   identifiers its counter describes. Disabling an option never enables another.
 * - Search requires every fragment across name + content, dims misses by class, and expands
 *   matching containers. Pointer events stay delegated on the host so Lit owns its child DOM.
 *
 * Light DOM lets public/css/prompt-list.css and theme packs reach the internals. Imports flow
 * Kotatsu → core; the shell initializes this module through firstLoadInit().
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { main_api } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { accountStorage } from '../../scripts/util/AccountStorage.js';
import { createPromptListSeam } from './render-seam.js';
export { PROMPT_LIST_MOUNTED_EVENT, RECOUNT_COMMAND } from './render-seam.js';
import {
    enforceStorageKey,
    indexTree,
    moveOrderBlock,
    planMasterToggle,
    planRadioEnable,
    radioEnforcement,
    relaxStorageKey,
    resolveBatch,
} from './order-ops.js';
import { deriveSections } from './sections.js';
import {
    NO_PROMPT_SEARCH,
    buildListModel,
    compilePromptQuery,
    counterPercent,
    highlightSegments,
    indexOrder,
    indexPrompts,
    regexChip,
    searchModel,
} from './view-model.js';
import { SCRIPT_TYPES, getCurrentPresetAPI, getCurrentPresetName, getScriptsByType, isPresetScriptsAllowed } from '../../scripts/extensions/regex/engine.js';
import { summarizeScripts } from '../../scripts/extensions/regex/script-summary.js';

/**
 * Additive events (CONTRACT §0 — additions are free). Both are plain DOM CustomEvents on
 * `document`, not entries on core's frozen `eventSource` bus.
 */
export const PROMPT_LIST_RENDERED_EVENT = 'kotatsu_prompt_list_rendered';
/**
 * Fired after an order write has been handed to the saver. Slice B fired it for a single row;
 * slice C routes EVERY enabled-state write through one batch primitive, so the detail grew a
 * `changes` array and a `reason` while keeping `identifier` / `enabled` meaning what they did
 * (the primary row of the interaction). One event per interaction, never one per entry.
 */
export const PROMPT_LIST_TOGGLED_EVENT = 'kotatsu_prompt_toggled';
/** Fired after a drag has permuted the order and handed the blob to the saver. */
export const PROMPT_LIST_REORDERED_EVENT = 'kotatsu_prompt_list_reordered';

/** `accountStorage` key prefix. One key per preset; the value is a JSON array of collapse keys. */
const COLLAPSE_KEY_PREFIX = 'kotatsu.promptList.collapsed.';

/** Pointer travel, in CSS pixels, before a press on a grip becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/** Preset name stand-in when the settings carry none, so collapse state still has a home. */
const UNNAMED_PRESET = '(unnamed)';

/** Stroke-only icon set — no Font Awesome, no emoji (repo CLAUDE.md). */
const icons = {
    chevron: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M6 4l4 4-4 4" />
        </svg>`,
    search: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2L13.5 13.5" />
        </svg>`,
    close: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    // The five row kinds, in the order PromptManager.js:1743-1747 declares them.
    marker: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M6 2h4l-.6 4 2.6 2v1H4v-1l2.6-2z" /><path d="M8 9v5" />
        </svg>`,
    global: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" /><path d="M5 6.5h3" /><path d="M5 9.5h6" />
        </svg>`,
    important: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8L2.5 6.5l3.8-.5z" />
        </svg>`,
    preset: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M8 2.5v11" /><path d="M3.2 5.2l9.6 5.6" /><path d="M12.8 5.2l-9.6 5.6" />
        </svg>`,
    inChat: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8 2v8" /><path d="M5 7.2L8 10.3l3-3.1" /><path d="M3 13h10" />
        </svg>`,
    inspect: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.7" />
        </svg>`,
    edit: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M10.5 2.8l2.7 2.7-7.4 7.4-3.3.6.6-3.3z" /><path d="M9.2 4.1l2.7 2.7" />
        </svg>`,
    detach: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M6.4 9.6L4.9 11.1a2.3 2.3 0 0 1-3.2-3.2l1.5-1.5" />
            <path d="M9.6 6.4l1.5-1.5a2.3 2.3 0 0 1 3.2 3.2l-1.5 1.5" />
            <path d="M2 2l12 12" />
        </svg>`,
    warning: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8 2.4l6 10.2H2z" /><path d="M8 6.6v3" /><path d="M8 11.3v.1" />
        </svg>`,
    shelf: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M2.5 9.5h3l1 2h3l1-2h3" /><path d="M4 4.5h8l1.5 5v3.5h-11V9.5z" />
        </svg>`,
    // Slice C's four.
    grip: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="10" height="12" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M6 4h.01" /><path d="M10 4h.01" />
            <path d="M6 8h.01" /><path d="M10 8h.01" />
            <path d="M6 12h.01" /><path d="M10 12h.01" />
        </svg>`,
    masterOn: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M2.5 4.5h6" /><path d="M2.5 8h4" /><path d="M2.5 11.5h4" />
            <path d="M9 10.4l1.9 1.9 3.6-4.4" />
        </svg>`,
    masterOff: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M2.5 4.5h6" /><path d="M2.5 8h4" /><path d="M2.5 11.5h4" />
            <path d="M9.6 9.1l4 4" /><path d="M13.6 9.1l-4 4" />
        </svg>`,
    recount: html`
        <svg class="k-pl-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
             stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M13.2 7.2a5.2 5.2 0 1 0-.7 3.6" /><path d="M13.6 4.2v3.2h-3.2" />
        </svg>`,
};

/** Row-kind icon plus the tooltip core used for the same discrimination. */
const KIND_CHROME = Object.freeze({
    'marker': { icon: icons.marker, title: 'Marker — an engine-supplied slot', label: 'marker' },
    'global': { icon: icons.global, title: 'Global prompt — overridable by a character card', label: 'global' },
    'important': { icon: icons.important, title: 'Important prompt — character cards may not override it', label: 'important' },
    'preset': { icon: icons.preset, title: 'Preset prompt', label: 'preset' },
    'in-chat': { icon: icons.inChat, title: 'In-chat injection — its tokens are counted under chat history', label: 'in-chat' },
});

/**
 * The `accountStorage` key for one preset's collapse set.
 * @param {string} presetName Preset name from `serviceSettings.preset_settings_openai`.
 * @returns {string} Storage key.
 */
export function collapseStorageKey(presetName) {
    const name = typeof presetName === 'string' && presetName.trim() ? presetName.trim() : UNNAMED_PRESET;
    return `${COLLAPSE_KEY_PREFIX}${name}`;
}

/**
 * Reads a stored key set. Never throws: unreadable or malformed storage means "the empty set",
 * which for both callers (collapse, relax) is the state a reader can always recover from —
 * everything expanded, every group enforced.
 * @param {string} key Storage key.
 * @returns {Set<string>} The stored keys.
 */
function readStoredSet(key) {
    try {
        const raw = accountStorage.getItem(key);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : []);
    } catch (error) {
        console.debug(`[k-prompt-list] ${key} unreadable, using the default`, error);
        return new Set();
    }
}

/**
 * Persists a key set. One write per toggle; `accountStorage.setItem` funnels into the same
 * `saveSettingsDebounced()` every other settings writer uses, and an empty set REMOVES the key
 * rather than storing `[]`, so a preset that never used the affordance leaves no trace.
 * @param {string} key Storage key.
 * @param {Set<string>} value The keys to store.
 * @returns {void}
 */
function writeStoredSet(key, value) {
    try {
        if (value.size === 0) accountStorage.removeItem(key);
        else accountStorage.setItem(key, JSON.stringify([...value]));
    } catch (error) {
        console.debug(`[k-prompt-list] ${key} could not be saved`, error);
    }
}

/**
 * A settings save that cannot become an unhandled rejection. `saveServiceSettings` resolves on
 * the next `SETTINGS_UPDATED` (`openai.js:697-700`), so it is normally awaited by nobody.
 * @param {any} manager The prompt manager.
 * @returns {void}
 */
function save(manager) {
    try {
        const pending = manager?.saveServiceSettings?.();
        if (pending && typeof pending.catch === 'function') {
            pending.catch((/** @type {unknown} */ error) => {
                console.error('[k-prompt-list] settings save failed', error);
            });
        }
    } catch (error) {
        console.error('[k-prompt-list] settings save threw', error);
    }
}

/**
 * The prompt list.
 */
export class KPromptList extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `list` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _query: { state: true },
        _status: { state: true },
        _revision: { state: true },
        _inspecting: { state: true },
        _error: { state: true },
        _busy: { state: true },
        _dragging: { state: true },
        _regex: { state: true },
    };

    /**
     * The state owner. Assigned by the seam before the element is connected; never imported
     * into the component so a test can drive it with a fake.
     * @type {any}
     */
    manager = null;

    /** @type {import('./sections.js').SectionTree|null} The derived tree; rebuilt on re-derive. */
    #tree = null;

    /** @type {import('./view-model.js').ListModel|null} The render model; rebuilt on every change. */
    #model = null;

    /** @type {import('./view-model.js').SearchResult} */
    #search = NO_PROMPT_SEARCH;

    /**
     * Per-identifier affordance flags, computed ONCE per refresh.
     *
     * Core answers `isPromptToggleAllowed` / `isPromptEditAllowed` / `isPromptDeletionAllowed`
     * from a `Prompt` record it looks up with `.find()` over `prompts[]`
     * (`PromptManager.js:1257`). Asking per row per render would be O(rows x prompts) — ~8,700
     * comparisons a keystroke on the Sparkle fixture. One index pass, then O(1) lookups.
     * @type {Map<string, {toggle: boolean, edit: boolean, detach: boolean, listed: boolean, receipt: boolean}>}
     */
    #caps = new Map();

    /** @type {Set<string>} Collapsed container keys for the CURRENT preset. */
    #collapsed = new Set();

    /** @type {Set<string>} Container keys whose radio enforcement the reader relaxed. */
    #relaxed = new Set();

    /** @type {Set<string>} Container keys the reader enforced by hand (how an `open` group gets enforced). */
    #enforcedByHand = new Set();

    /** @type {string} Preset the collapse, relax and enforce sets belong to, so a switch reloads them. */
    #collapsePreset = '';

    /**
     * Slice C's lookups, rebuilt with the tree: container members (for master toggles), drag
     * blocks, exclusive groups and the member → group index. One walk per re-derive; O(1) per
     * interaction.
     * @type {import('./order-ops.js').TreeIndex}
     */
    #index = { members: new Map(), blocks: new Map(), groups: [], groupOfMember: new Map(), rendered: [] };

    /** @type {((data: any) => void)|null} `CHAT_COMPLETION_PROMPT_READY` subscription. */
    #onPromptReady = null;

    /** @type {(() => void)|null} `PRESET_CHANGED` / `SETTINGS_UPDATED` subscription for the regex chip. */
    #onRegexState = null;

    /**
     * The live drag, or null. ONE of these exists at a time — decision 8's "one sortable surface"
     * expressed as one piece of state rather than one jQuery plugin instance.
     * @type {{pointerId: number, block: string[], set: Set<string>, x: number, y: number, active: boolean}|null}
     */
    #drag = null;

    /** @type {{identifier: string, edge: 'before'|'after'}|null} Where the block would land. */
    #dropAt = null;

    /** @type {((event: PointerEvent) => void)|null} */
    #onPointerDown = null;

    /** @type {((event: PointerEvent) => void)|null} */
    #onPointerMove = null;

    /** @type {((event: PointerEvent) => void)|null} */
    #onPointerUp = null;

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onKeyDown = null;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'list';
        /** @type {string} */
        this._query = '';
        /** @type {'ready'|'foreign-api'|'no-manager'|'no-order'|'empty'} */
        this._status = 'no-manager';
        /** @type {number} Bumped to publish a change made to the non-reactive model. */
        this._revision = 0;
        /** @type {import('./view-model.js').RegexChip|null} The preset's regex chip, or null for none. */
        this._regex = null;
        /** @type {string} Identifier whose receipt drawer is open, or ''. */
        this._inspecting = '';
        /** @type {string} The last assembly error, captured off the manager. */
        this._error = '';
        /** @type {boolean} A recount dry run is in flight; every door into one is shut. */
        this._busy = false;
        /** @type {number} Bumped when the drag state changes, to publish it. */
        this._dragging = 0;
    }

    /** Light DOM: `public/css/prompt-list.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        // A dry run updates `tokenHandler.counts` (openai.js:1601) but core only re-renders for
        // NON-dry generations (:1608). This frozen event fires for both (:1614), so badges stay
        // honest either way. Counts only — the tree cannot have changed under a generation.
        this.#onPromptReady = () => this.refresh(false);
        eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, this.#onPromptReady);
        // The regex chip reads two things core changes without telling this list: which preset is
        // selected, and whether its scripts are allowed (a settings write). Neither rebuilds the
        // tree, so they only re-read the chip, and only re-render when it actually differs.
        this.#onRegexState = () => this.#syncRegex();
        eventSource.on(event_types.PRESET_CHANGED, this.#onRegexState);
        eventSource.on(event_types.SETTINGS_UPDATED, this.#onRegexState);
        // The whole drag surface: three listeners on the host, delegated. Pointer capture is
        // taken on the HOST (not on the grip), so a Lit patch mid-drag can never move the
        // element the events are bound to, and mouse / touch / pen are one code path — which
        // HTML5 drag-and-drop is not, and which is the only reason core's jQuery sortable works
        // on a phone at all (it rides `lib/jquery.ui.touch-punch.min.js`, index.html:8276).
        this.#onPointerDown = (event) => this.#dragStart(event);
        this.#onPointerMove = (event) => this.#dragMove(event);
        // Browser cancellation releases the drag without saving its last drop position.
        this.#onPointerUp = (event) => this.#dragEnd(event, event.type === 'pointerup');
        this.addEventListener('pointerdown', this.#onPointerDown);
        this.addEventListener('pointermove', this.#onPointerMove);
        this.addEventListener('pointerup', this.#onPointerUp);
        this.addEventListener('pointercancel', /** @type {EventListener} */ (this.#onPointerUp));
        this.refresh(true);
    }

    disconnectedCallback() {
        if (this.#onPromptReady) {
            eventSource.removeListener(event_types.CHAT_COMPLETION_PROMPT_READY, this.#onPromptReady);
            this.#onPromptReady = null;
        }
        if (this.#onRegexState) {
            eventSource.removeListener(event_types.PRESET_CHANGED, this.#onRegexState);
            eventSource.removeListener(event_types.SETTINGS_UPDATED, this.#onRegexState);
            this.#onRegexState = null;
        }
        if (this.#onPointerDown) this.removeEventListener('pointerdown', this.#onPointerDown);
        if (this.#onPointerMove) this.removeEventListener('pointermove', this.#onPointerMove);
        if (this.#onPointerUp) {
            this.removeEventListener('pointerup', this.#onPointerUp);
            this.removeEventListener('pointercancel', /** @type {EventListener} */ (this.#onPointerUp));
        }
        this.#onPointerDown = null;
        this.#onPointerMove = null;
        this.#onPointerUp = null;
        this.#releaseEscape();
        this.#drag = null;
        this.#dropAt = null;
        this.#tree = null;
        this.#model = null;
        this.#search = NO_PROMPT_SEARCH;
        this.#caps.clear();
        this.#collapsed.clear();
        this.#relaxed.clear();
        this.#enforcedByHand.clear();
        this.#collapsePreset = '';
        super.disconnectedCallback();
    }

    /** @returns {any} The live `serviceSettings` (=== `oai_settings`), or null. */
    get #settings() {
        return this.manager?.serviceSettings ?? null;
    }

    /**
     * The LIVE order array for the active character. Read fresh on every call — slice A's model
     * is a snapshot and must never be treated as state.
     * @returns {Array<{identifier: string, enabled?: boolean}>} The order, possibly empty.
     */
    get #order() {
        const manager = this.manager;
        if (!manager?.activeCharacter) return [];
        const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
        return Array.isArray(order) ? order : [];
    }

    /** @returns {string} The current preset name, for the collapse key. */
    get #presetName() {
        const name = this.#settings?.preset_settings_openai;
        return typeof name === 'string' ? name : '';
    }

    /**
     * Rebuilds the view.
     *
     * `rederive: true` rebuilds the section tree as well — do that when `prompts[]`, the order
     * or the override bag may have changed. `false` rebuilds only the model, which is what a
     * toggle and a token-count refresh need: the tree is structurally identical, so Lit sees the
     * same template shape and writes only the bindings that moved.
     * @param {boolean} [rederive] Whether to re-run `deriveSections()`.
     * @returns {void}
     */
    refresh(rederive = true) {
        this.#syncRegex();
        const manager = this.manager;
        if (!manager || !this.#settings) {
            this.#model = null;
            this._status = 'no-manager';
            this._revision++;
            return;
        }
        if (main_api !== 'openai') {
            // Core's render is a no-op here (`PromptManager.js:863`). Saying so beats leaving
            // a stale list on screen that no longer describes what would be sent.
            this._status = 'foreign-api';
            this._revision++;
            return;
        }

        // Core sets `error` at `openai.js:1587/1591` and clears it at the TOP of its own render
        // (`PromptManager.js:866`) — synchronously, before the `.then()` that builds the DOM ever
        // reads it, which is why the stock error banner is unreachable through that path.
        // Capturing it here, then clearing it the same way core does, is what finally makes it
        // paint. It stays until the reader dismisses it or the preset changes; nothing else in
        // core would ever clear it for us.
        const raw = this.manager.error;
        if (typeof raw === 'string' && raw) {
            this._error = raw;
            this.manager.error = null;
        }

        const preset = this.#presetName;
        if (preset !== this.#collapsePreset) {
            this.#collapsePreset = preset;
            this.#collapsed = readStoredSet(collapseStorageKey(preset));
            this.#relaxed = readStoredSet(relaxStorageKey(preset));
            this.#enforcedByHand = readStoredSet(enforceStorageKey(preset));
            this._error = '';
            this._inspecting = '';
            this.#cancelDrag();
        }

        const settings = this.#settings;
        const order = this.#order;
        if (rederive || !this.#tree) {
            this.#tree = deriveSections({
                prompts: Array.isArray(settings.prompts) ? settings.prompts : [],
                promptOrder: order,
                // Decision 3: derived by default, the bag only as an opt-in override. NOTHING in
                // slice B writes either key — both are pure reads, so the acceptance fixtures
                // can never grow an `extensions.kotatsu` entry by rendering.
                override: settings.extensions?.kotatsu?.sections ?? null,
                extraPatterns: settings.extensions?.kotatsu?.dividerPatterns ?? [],
            });
            // Slice C's lookups ride the same re-derive: the tree is the only thing they
            // describe, so they are stale exactly when it is.
            this.#index = indexTree(this.#tree.sections);
        }

        // The badge authority, not `counts`: see view-model.js's header on the eight legacy
        // bucket keys and the stale zeros `resetCounts()` leaves behind.
        const contributed = this.#contributedIdentifiers();

        this.#model = buildListModel({
            tree: /** @type {any} */ (this.#tree),
            prompts: settings.prompts,
            promptOrder: order,
            counts: manager.tokenHandler?.getCounts?.() ?? null,
            contributed,
            overridden: manager.overriddenPrompts,
            promptSources: manager.promptSources,
            budget: {
                tokenUsage: Number(manager.tokenUsage) || 0,
                maxContext: Number(settings.openai_max_context) || 0,
                maxTokens: Number(settings.openai_max_tokens) || 0,
                warningThreshold: manager.configuration?.warningTokenThreshold,
                dangerThreshold: manager.configuration?.dangerTokenThreshold,
            },
        });

        this.#indexCapabilities(order, settings, contributed);

        if (!manager.activeCharacter || order.length === 0) {
            this._status = this.#model.unlisted.length > 0 ? 'no-order' : 'empty';
        } else {
            this._status = 'ready';
        }

        this.#applySearch();
        this._revision++;
        this.#announce();
    }

    /**
     * The identifiers the LAST assembly produced a message collection for.
     *
     * This is the same object `handleInspect` reads (`PromptManager.js:473`) and the same one
     * `populateTokenCounts` iterates (`:1585`), so it is the exact authority for both the
     * receipt affordance and the token badge. `null` — no assembly has run — is a different
     * statement from "an empty assembly", and both callers depend on the difference.
     * @returns {Set<string>|null} The identifier set, or null.
     */
    #contributedIdentifiers() {
        const collection = this.manager?.messages?.getCollection?.();
        if (!Array.isArray(collection)) return null;
        /** @type {Set<string>} */
        const identifiers = new Set();
        for (const item of collection) {
            if (typeof item?.identifier === 'string' && item.identifier) identifiers.add(item.identifier);
        }
        return identifiers;
    }

    /**
     * Rebuilds {@link #caps}. One pass over `prompts[]` and one over the order — then every row
     * reads O(1).
     * @param {Array<{identifier: string}>} order The live order.
     * @param {any} settings The live `serviceSettings`.
     * @param {Set<string>|null} contributed Identifiers from the last assembly.
     * @returns {void}
     */
    #indexCapabilities(order, settings, contributed) {
        const manager = this.manager;
        const prompts = indexPrompts(settings.prompts);
        const listed = indexOrder(order);
        const receipts = contributed ?? new Set();
        this.#caps = new Map();
        for (const identifier of this.#model?.rowsByIdentifier.keys() ?? []) {
            const prompt = prompts.get(identifier) ?? null;
            const inOrder = listed.has(identifier);
            this.#caps.set(identifier, {
                // `isPromptToggleAllowed` is the only one of the three that answers `true` for
                // most markers, so the fallback when a manager is missing it is "allowed".
                toggle: inOrder && Boolean(prompt) && manager?.isPromptToggleAllowed?.(prompt) !== false,
                edit: Boolean(prompt) && manager?.isPromptEditAllowed?.(prompt) === true,
                detach: inOrder && Boolean(prompt) && manager?.isPromptDeletionAllowed?.(prompt) === true,
                listed: inOrder,
                receipt: receipts.has(identifier),
            });
        }
    }

    /**
     * @param {string} identifier Prompt identifier.
     * @returns {{toggle: boolean, edit: boolean, detach: boolean, listed: boolean, receipt: boolean}} Flags.
     */
    #capsFor(identifier) {
        return this.#caps.get(identifier)
            ?? { toggle: false, edit: false, detach: false, listed: false, receipt: false };
    }

    /** Recompiles the query against the current model. Called per keystroke and per refresh. */
    #applySearch() {
        const model = this.#model;
        this.#search = model
            ? searchModel(model, compilePromptQuery(this._query))
            : NO_PROMPT_SEARCH;
    }

    /** Publishes the additive rendered event with honest numbers only. */
    #announce() {
        const model = this.#model;
        document.dispatchEvent(new CustomEvent(PROMPT_LIST_RENDERED_EVENT, {
            detail: {
                tier: model?.tier ?? null,
                status: this._status,
                sections: model?.sections.length ?? 0,
                rows: model?.totals.total ?? 0,
                enabled: model?.totals.enabled ?? 0,
                unlisted: model?.unlisted.length ?? 0,
                search: this.#search.active ? this.#search.count : null,
            },
        }));
    }

    /**
     * Whether a container is currently shown open. A search forces its matching containers open
     * without touching the persisted set, so clearing the query restores exactly what the
     * reader had.
     * @param {string} key Collapse key.
     * @returns {boolean} True when the body renders.
     */
    #isOpen(key) {
        if (this.#search.active && this.#search.expand.has(key)) return true;
        return !this.#collapsed.has(key);
    }

    /**
     * @param {string} key Collapse key.
     * @returns {void}
     */
    #toggleCollapse(key) {
        if (this.#collapsed.has(key)) this.#collapsed.delete(key);
        else this.#collapsed.add(key);
        // A search-forced expansion has to be released too, or a collapse would visibly do
        // nothing while a query is in force (the branch map learned the same lesson).
        if (this.#search.active) this.#search.expand.delete(key);
        writeStoredSet(collapseStorageKey(this.#collapsePreset), this.#collapsed);
        this._revision++;
    }

    /**
     * Turns radio enforcement for one group off (or back on) and remembers it per preset.
     * @param {string} key Container key — the group's prompt identifier, or its tree id.
     * @returns {void}
     */
    #toggleRelax(key) {
        // Off the state the chip is SHOWING, so the click always flips it: an enforced group is
        // relaxed, and a relaxed or open one is enforced by hand.
        if (this.#radioStateOf(key) === 'enforced') {
            this.#relaxed.add(key);
            this.#enforcedByHand.delete(key);
        } else {
            this.#relaxed.delete(key);
            this.#enforcedByHand.add(key);
        }
        writeStoredSet(relaxStorageKey(this.#collapsePreset), this.#relaxed);
        writeStoredSet(enforceStorageKey(this.#collapsePreset), this.#enforcedByHand);
        this._revision++;
    }

    /**
     * Whether one group is enforced, relaxed by the reader, or left open because it already has
     * several members on ({@link radioEnforcement}). Read live, off this refresh's model.
     * @param {import('./order-ops.js').RadioGroup} group The group.
     * @returns {'enforced'|'relaxed'|'open'} The state.
     */
    #radioState(group) {
        return radioEnforcement(group, identifier => this.#isEnabled(identifier), {
            relaxed: this.#relaxed,
            enforced: this.#enforcedByHand,
        });
    }

    /**
     * @param {string} key Container key.
     * @returns {'enforced'|'relaxed'|'open'|null} The state, or null when the key is no radio group.
     */
    #radioStateOf(key) {
        const group = this.#index.groups.find(candidate => candidate.key === key);
        return group ? this.#radioState(group) : null;
    }

    /**
     * Live enabled state for one identifier, straight off the model built this refresh.
     * @param {string} identifier Prompt identifier.
     * @returns {boolean} Whether the order has it enabled.
     */
    #isEnabled(identifier) {
        return this.#model?.rowsByIdentifier.get(identifier)?.enabled === true;
    }

    /**
     * The enforced group one identifier belongs to, or null. A relaxed or open group answers
     * null, which is precisely what those mean: its members behave as plain toggles.
     * @param {string} identifier Prompt identifier.
     * @returns {import('./order-ops.js').RadioGroup|null} The group.
     */
    #enforcedGroupOf(identifier) {
        const group = this.#index.groupOfMember.get(identifier);
        if (!group || this.#radioState(group) !== 'enforced') return null;
        return group;
    }

    /**
     * THE order write. Every enabled-state change in this component goes through here: a single
     * row, radio enforcement, a master toggle. One resolve, one pass of mutations, ONE save, ONE
     * `refresh(false)`, ONE event — never n sequential toggles (the NemoPresetExt replay this
     * design exists to not repeat: 94 `.click()`s on a 50 ms ladder).
     *
     * Counts are invalidated per identifier exactly as core's own toggle does
     * (`PromptManager.js:448`), guarded by `hasOwn` so a batch cannot seed keys into
     * `tokenHandler.counts` that no assembly ever wrote (see view-model.js's header on the eight
     * legacy bucket keys).
     * @param {Array<{identifier: string, enabled: boolean}>} changes The plan.
     * @param {{reason?: string, identifier?: string, group?: string}} [detail] Event colour.
     * @returns {number} How many entries were actually written.
     */
    #writeBatch(changes, detail = {}) {
        const manager = this.manager;
        if (!manager?.activeCharacter) return 0;
        const order = this.#order;
        const plan = resolveBatch(order, changes);
        if (plan.writes.length === 0) return 0;

        const counts = manager.tokenHandler?.getCounts?.();
        for (const write of plan.writes) {
            const entry = order[write.index];
            if (!entry) continue;
            if (counts && Object.hasOwn(counts, write.identifier)) counts[write.identifier] = null;
            entry.enabled = write.enabled;
        }
        save(manager);
        this.refresh(false);

        const primary = typeof detail.identifier === 'string' ? detail.identifier : plan.writes[0].identifier;
        document.dispatchEvent(new CustomEvent(PROMPT_LIST_TOGGLED_EVENT, {
            detail: {
                identifier: primary,
                enabled: this.#isEnabled(primary),
                reason: detail.reason ?? 'toggle',
                group: detail.group ?? null,
                changes: plan.writes.map(write => ({ identifier: write.identifier, enabled: write.enabled })),
                // A duplicated identifier means core's `.find()` reads the FIRST entry and this
                // write touched exactly that one. Reported so a preset can be flagged rather
                // than silently half-written.
                duplicated: plan.duplicated,
            },
        }));
        return plan.writes.length;
    }

    /**
     * The batch primitive slice B's `#toggleRow` doc-comment promised: write ONE state to MANY
     * identifiers, in one save and one refresh. Public so the seam (and a console) can drive it.
     * @param {string[]} identifiers Prompt identifiers.
     * @param {boolean} state Target enabled state.
     * @returns {number} How many entries were written.
     */
    setEnabled(identifiers, state) {
        const changes = (Array.isArray(identifiers) ? identifiers : [])
            .filter(identifier => typeof identifier === 'string' && identifier)
            .map(identifier => ({ identifier, enabled: state === true }));
        return this.#writeBatch(changes, { reason: 'batch' });
    }

    /**
     * The preset's radio groups as read-only data, for surfaces outside the list — the welcome
     * tour's "how do you like to play?" (onboarding v0 O3). Built off this refresh's model, so
     * it is exactly what the rows show.
     *
     * An `open` group is left out: with several members already on it is not a choice between
     * them, and {@link pickRadio} would have to switch the rest off to make it one.
     * @returns {Array<{key: string, label: string, options: Array<{identifier: string, label: string, enabled: boolean}>}>}
     */
    radioGroups() {
        return this.#index.groups.filter(group => this.#radioState(group) !== 'open').map(group => ({
            key: group.key,
            label: group.label,
            options: group.members.map((identifier) => {
                const row = this.#model?.rowsByIdentifier.get(identifier);
                return { identifier, label: row?.label ?? identifier, enabled: row?.enabled === true };
            }),
        }));
    }

    /**
     * Turns one radio option on and its siblings off: the same plan and the same single write a
     * click on the row makes (see {@link #toggleRow}), so the list, the save and the
     * `kotatsu_prompt_toggled` event behave identically. Enforced even when the reader relaxed
     * the group in the list — a caller asking to "pick" one means exactly one. An `open` group
     * is refused: {@link radioGroups} never offered it.
     * @param {string} identifier The option to turn on.
     * @returns {number} How many entries were written (0 if it is in no group, or in an open one).
     */
    pickRadio(identifier) {
        const group = this.#index.groupOfMember.get(identifier);
        if (!group || this.#radioState(group) === 'open') return 0;
        return this.#writeBatch(
            planRadioEnable(group.members, identifier, id => this.#isEnabled(id)),
            { reason: 'radio', identifier, group: group.key },
        );
    }

    /**
     * The single-row toggle — decision 2, and the whole point of slice B; decision 6 rides on
     * top of it here.
     *
     * Enabling a member of an ENFORCED radio group takes its siblings off in the SAME write, so
     * the reader never sees two options lit and the settings blob is never briefly wrong.
     * Disabling is always just a disable: enforcement bounds how many can be on, it does not
     * promise one always is.
     * @param {string} identifier Prompt identifier.
     * @returns {void}
     */
    #toggleRow(identifier) {
        const next = !this.#isEnabled(identifier);
        const group = next ? this.#enforcedGroupOf(identifier) : null;
        if (group) {
            this.#writeBatch(
                planRadioEnable(group.members, identifier, id => this.#isEnabled(id)),
                { reason: 'radio', identifier, group: group.key },
            );
            return;
        }
        this.#writeBatch([{ identifier, enabled: next }], { reason: 'toggle', identifier });
    }

    /**
     * A container's master toggle: Nemo semantics over exactly the identifiers its `(n/m)`
     * counter describes, as ONE batch.
     *
     * Only rows this UI would let a reader toggle one at a time are included — a master control
     * must never reach a switch the row itself renders as fixed (`isPromptToggleAllowed`,
     * `PromptManager.js:1099`).
     * @param {string} key Container key.
     * @param {'auto'|'clear'} mode `clear` for an enforced radio group — see {@link planMasterToggle}.
     * @returns {void}
     */
    #masterToggle(key, mode) {
        const identifiers = this.#masterScope(key, mode);
        if (identifiers.length === 0) return;
        const changes = planMasterToggle({
            identifiers,
            isEnabled: identifier => this.#isEnabled(identifier),
            groups: this.#index.groups.filter(group => this.#radioState(group) === 'enforced'),
            mode,
        });
        this.#writeBatch(changes, { reason: 'master', identifier: key, group: key });
    }

    /**
     * @param {string} key Container key.
     * @returns {string[]} The container's members the reader could toggle individually.
     */
    #toggleableMembers(key) {
        const members = this.#index.members.get(key) ?? [];
        return members.filter(identifier => this.#capsFor(identifier).toggle);
    }

    /**
     * What a container's master control reaches. `clear` empties a radio group of its OPTIONS,
     * so an engine marker sitting under the same banner is left alone, as it is by a row click.
     * @param {string} key Container key.
     * @param {'auto'|'clear'} mode Master semantics.
     * @returns {string[]} The identifiers in scope.
     */
    #masterScope(key, mode) {
        const identifiers = this.#toggleableMembers(key);
        if (mode !== 'clear') return identifiers;
        return identifiers.filter(identifier => this.#model?.rowsByIdentifier.get(identifier)?.marker !== true);
    }

    /**
     * The master control's state for one container.
     * @param {string} key Container key.
     * @param {boolean} exclusive Whether the container is an exclusive group.
     * @returns {{mode: 'auto'|'clear', target: boolean, count: number, enabled: number}|null}
     *   Null when nothing inside can be toggled and the control should not render at all.
     */
    #masterState(key, exclusive) {
        const enforced = exclusive && this.#radioStateOf(key) === 'enforced';
        const identifiers = this.#masterScope(key, enforced ? 'clear' : 'auto');
        if (identifiers.length === 0) return null;
        const enabled = identifiers.filter(identifier => this.#isEnabled(identifier)).length;
        return {
            mode: enforced ? 'clear' : 'auto',
            target: enforced ? false : enabled < identifiers.length,
            count: identifiers.length,
            enabled,
        };
    }

    /**
     * Opens core's edit popup for a row. Deliberately a delegation: the popup's form, its save /
     * reset buttons and its macro autocomplete are all wired in `PromptManager.init()`
     * (`:803-815`) against ids that live in `index.html`. Rebuilding that form would be a second
     * writer onto the same prompt records.
     * @param {string} identifier Prompt identifier.
     * @returns {void}
     */
    #edit(identifier) {
        const manager = this.manager;
        const prompt = manager?.getPromptById?.(identifier);
        if (!prompt) return;
        manager.clearEditForm();
        manager.clearInspectForm();
        manager.loadPromptIntoEditForm(prompt);
        manager.showPopup();
    }

    /**
     * Removes a prompt from the order (core's `handleDetach`, `PromptManager.js:483-493`),
     * without the DOM-closest lookup that handler needs.
     * @param {string} identifier Prompt identifier.
     * @returns {void}
     */
    #detach(identifier) {
        const manager = this.manager;
        const prompt = manager?.getPromptById?.(identifier);
        if (!prompt || !manager.activeCharacter) return;
        manager.detachPrompt(prompt, manager.activeCharacter);
        manager.hidePopup();
        manager.clearEditForm();
        save(manager);
        this.refresh(true);
    }

    /**
     * The receipt for one prompt: the message collection assembly actually built for it.
     *
     * This is `handleInspect`'s data (`PromptManager.js:468-480` →
     * `loadMessagesIntoInspectForm` `:1428-1462`) promoted out of a popup nobody finds and into
     * the row — decision 9. Duck-typed rather than `instanceof`-tested so the component never
     * has to import `openai.js`'s `Message` / `MessageCollection`.
     * @param {string} identifier Prompt identifier.
     * @returns {Array<{identifier: string, role: string, content: string, tokens: number}>|null}
     *   The receipt, or null when this generation produced none for this prompt.
     */
    #receiptFor(identifier) {
        const messages = this.manager?.messages;
        if (!messages || typeof messages.hasItemWithIdentifier !== 'function') return null;
        if (!messages.hasItemWithIdentifier(identifier)) return null;
        const item = messages.getItemByIdentifier(identifier);
        if (!item) return null;
        const collection = typeof item.getCollection === 'function' ? item.getCollection() : [item];
        return (Array.isArray(collection) ? collection : []).map(message => ({
            identifier: typeof message?.identifier === 'string' ? message.identifier : '',
            role: typeof message?.role === 'string' ? message.role : '',
            content: typeof message?.content === 'string' ? message.content : '',
            tokens: typeof message?.getTokens === 'function' ? Number(message.getTokens()) || 0 : 0,
        }));
    }

    /** Moves focus to the search box. */
    focusSearch() {
        const input = this.querySelector('.k-pl-search-input');
        if (input instanceof HTMLInputElement) {
            input.focus({ preventScroll: true });
            input.select();
        }
    }

    /**
     * Publishes the recount busy state. Called by the seam so the header button, the slash
     * command and any future door all show the same one flag.
     * @param {boolean} busy Whether a dry run is in flight.
     * @returns {void}
     */
    setBusy(busy) {
        this._busy = busy === true;
    }

    /* ── Drag (decision 8) ──────────────────────────────────────────────────── */

    /**
     * Grabs a row. The grip is the only handle: a whole-row grab would have to claim
     * `touch-action` on the row, which costs the panel its scroll on a phone — the same reason
     * core hands mobile a `.drag-handle` (`PromptManager.js:1921`).
     * @param {PointerEvent} event Pointer down.
     * @returns {void}
     */
    #dragStart(event) {
        if (this.#drag || event.button > 0) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const grip = target.closest('.k-pl-grip');
        if (!grip) return;
        const identifier = grip.getAttribute('data-drag');
        if (!identifier) return;
        const block = this.#index.blocks.get(identifier);
        if (!block || block.length === 0) return;
        event.preventDefault();
        this.#drag = {
            pointerId: event.pointerId,
            block,
            set: new Set(block),
            x: event.clientX,
            y: event.clientY,
            active: false,
        };
        try {
            this.setPointerCapture(event.pointerId);
        } catch (error) {
            // Capture is a nicety: without it the drag still tracks while the pointer stays
            // over the list, which is where a 26px-row list is dragged anyway.
            console.debug('[k-prompt-list] pointer capture refused', error);
        }
        this.#captureEscape();
    }

    /**
     * Tracks the pointer. A drag only starts after {@link DRAG_THRESHOLD_PX} of travel, so a
     * mis-aimed click on the grip is still a click and not a silent no-op reorder.
     * @param {PointerEvent} event Pointer move.
     * @returns {void}
     */
    #dragMove(event) {
        const drag = this.#drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!drag.active) {
            if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
            drag.active = true;
            this._dragging++;
        }
        event.preventDefault();
        const slot = this.#slotAt(event.clientX, event.clientY);
        const current = this.#dropAt;
        const same = slot === current
            || (slot && current && slot.identifier === current.identifier && slot.edge === current.edge);
        // Re-render only when the slot actually moves. A render per pointermove would rebuild ~93
        // template results at pointer frequency for a picture that did not change.
        if (same) return;
        this.#dropAt = slot;
        this._dragging++;
    }

    /**
     * Drops. The write is one splice of the LIVE array — same entries, same count, unknown-order
     * entries riding along untouched — then one save and one re-derive (the tree's shape changed,
     * which a toggle's `refresh(false)` would not pick up).
     * @param {PointerEvent} event Pointer up or cancel.
     * @param {boolean} commit Whether to write; false for cancel paths.
     * @returns {void}
     */
    #dragEnd(event, commit) {
        const drag = this.#drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const slot = this.#dropAt;
        const active = drag.active;
        this.#cancelDrag();
        try {
            this.releasePointerCapture(event.pointerId);
        } catch {
            // Already released, or never taken. Nothing to undo.
        }
        if (!commit || !active || !slot) return;

        const manager = this.manager;
        if (!manager?.activeCharacter) return;
        const order = this.#order;
        const result = moveOrderBlock(order, drag.block, slot);
        if (!result.moved) return;
        // In place: the array object is the one `serviceSettings.prompt_order` holds and core's
        // `getPromptOrderForCharacter` hands out, and every element is an entry that was already
        // in it. Core's own drag instead REPLACES the list through `removePromptOrderForCharacter`
        // / `addPromptOrderForCharacter`, whose JSON round-trip (`PromptManager.js:1238`) both
        // re-objects every entry and cheerfully stores whatever `undefined`s its DOM-id map
        // produced.
        order.splice(0, order.length, ...result.next);
        save(manager);
        this.refresh(true);
        document.dispatchEvent(new CustomEvent(PROMPT_LIST_REORDERED_EVENT, {
            detail: {
                block: drag.block.slice(),
                anchor: slot.identifier,
                edge: slot.edge,
                length: order.length,
            },
        }));
    }

    /** Clears the drag state and the indicator without writing anything. */
    #cancelDrag() {
        if (!this.#drag && !this.#dropAt) return;
        this.#drag = null;
        this.#dropAt = null;
        this.#releaseEscape();
        this._dragging++;
    }

    /** Arms Escape as the drag's abort key. Only ever one listener, only while dragging. */
    #captureEscape() {
        if (this.#onKeyDown) return;
        this.#onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            this.#cancelDrag();
        };
        window.addEventListener('keydown', this.#onKeyDown, true);
    }

    /** Disarms Escape. */
    #releaseEscape() {
        if (!this.#onKeyDown) return;
        window.removeEventListener('keydown', this.#onKeyDown, true);
        this.#onKeyDown = null;
    }

    /**
     * The drop slot under a point: a rendered row, and which of its edges is nearer.
     *
     * Header rows carry `data-identifier` too, so dropping onto a section banner or a group
     * header lands the block at that BOUNDARY in the order — decision 8's cross-section drop,
     * with no special case for it anywhere.
     * @param {number} x Client X.
     * @param {number} y Client Y.
     * @returns {{identifier: string, edge: 'before'|'after'}|null} The slot.
     */
    #slotAt(x, y) {
        const drag = this.#drag;
        if (!drag) return null;
        const element = document.elementFromPoint(x, y);
        if (!(element instanceof Element)) return null;
        const row = element.closest('[data-identifier]');
        if (!(row instanceof HTMLElement) || !this.contains(row)) return null;
        const identifier = row.dataset.identifier ?? '';
        if (!identifier || drag.set.has(identifier)) return null;
        // The shelf holds prompts with no order entry; there is no position in the order to drop
        // beside. (`moveOrderBlock` would answer `anchor-missing`; refusing here keeps the
        // indicator from promising a landing that cannot happen.)
        if (!this.#capsFor(identifier).listed) return null;
        const rect = row.getBoundingClientRect();
        return { identifier, edge: (y - rect.top) < rect.height / 2 ? 'before' : 'after' };
    }

    /**
     * @param {string} identifier Prompt identifier.
     * @returns {string} Class suffix marking the drag block and the drop edge.
     */
    #dragClasses(identifier) {
        let classes = '';
        if (this.#drag?.active && this.#drag.set.has(identifier)) classes += ' is-dragging';
        if (this.#dropAt?.identifier === identifier) classes += ` is-drop-${this.#dropAt.edge}`;
        return classes;
    }

    /* ── Render ─────────────────────────────────────────────────────────────── */

    render() {
        return html`
            ${this.#renderHead()}
            ${this.#renderError()}
            ${this._status === 'ready' ? this.#renderBody() : this.#renderQuiet()}
            ${this.#renderFoot()}`;
    }

    /** @returns {unknown} Search box, counts, total tokens. */
    #renderHead() {
        const model = this.#model;
        const totals = model?.totals ?? { enabled: 0, total: 0 };
        const usage = Number(this.manager?.tokenUsage);
        const countStat = this.#search.active
            ? html`<span class="k-pl-stat" title="Prompts matching every term">${this.#search.count} of ${this.#search.scanned}</span>`
            : html`<span class="k-pl-stat" title="Enabled prompts of the ones this preset orders">${totals.enabled}/${totals.total}</span>`;
        const tokenStat = Number.isFinite(usage) && usage > 0
            ? html`<span class="k-pl-stat k-pl-stat--tokens" title="Tokens the last assembly used">${usage} tk</span>`
            : nothing;
        return html`
            <header class="k-pl-head">
                <label class="k-pl-search" aria-label="Search prompts by name or content">
                    ${icons.search}
                    <input
                        class="k-pl-search-input"
                        type="search"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="Filter by name or prompt text"
                        .value=${this._query}
                        @input=${(/** @type {Event} */ e) => this.#onQuery(e)}
                    >
                    ${this._query ? html`
                        <button type="button" class="k-pl-search-clear" title="Clear filter" aria-label="Clear filter"
                            @click=${() => { this._query = ''; this.#applySearch(); this._revision++; }}>${icons.close}</button>` : nothing}
                </label>
                <span class="k-pl-head-stats">
                    ${countStat}
                    ${tokenStat}
                    ${model ? html`<span class="k-pl-stat k-pl-stat--tier" title="How this preset's sections were derived">${model.tier}</span>` : nothing}
                    ${this._regex ? html`
                        <button type="button" class="k-pl-stat k-pl-stat--regex is-${this._regex.state}"
                            title=${this._regex.title}
                            aria-label=${this._regex.title}
                            @click=${() => this.#onRegexChip()}>${this._regex.label}</button>` : nothing}
                    ${this.#renderRecount()}
                </span>
            </header>`;
    }

    /**
     * Re-reads the regex chip off core's live state and publishes it only when it differs, so
     * the `SETTINGS_UPDATED` it listens to (every settings save) costs a comparison, not a render.
     * @returns {void}
     */
    #syncRegex() {
        /** @type {import('./view-model.js').RegexChip|null} */
        let next = null;
        try {
            if (main_api === 'openai') {
                const summary = summarizeScripts(getScriptsByType(SCRIPT_TYPES.PRESET));
                next = regexChip(
                    { total: summary.total, prompt: summary.prompt.length },
                    isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName()),
                );
            }
        } catch {
            // No preset manager yet (boot) or no regex engine: no chip, never an error in a header.
            next = null;
        }
        const prev = this._regex;
        if (prev?.label === next?.label && prev?.state === next?.state && prev?.title === next?.title) return;
        this._regex = next;
    }

    /**
     * Off: asks core's allow question for this preset, which now lists what would run. On: opens
     * the Regex settings at Preset Scripts. Both are dynamic imports on purpose — the regex
     * extension is loaded by core's extension loader, and a static import from here would
     * evaluate it ahead of the order `extensions.js` gives it.
     * @returns {Promise<void>}
     */
    async #onRegexChip() {
        const chip = this._regex;
        if (!chip) return;
        if (chip.state === 'off') {
            const { reviewPresetRegexScripts } = await import('../../scripts/extensions/regex/index.js');
            await reviewPresetRegexScripts();
        } else {
            const { openSettings } = await import('../settings/k-settings-modal.js');
            openSettings({ tab: 'extensions' });
            const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
            // The tab adopts the extension columns after its own render, so the block arrives
            // a few frames after the sheet does.
            /** @type {HTMLElement|null} */
            let block = null;
            for (let i = 0; i < 60 && !block; i++) {
                await frame();
                const found = document.getElementById('preset_scripts_block');
                if (found?.closest('k-settings-modal')) block = found;
            }
            if (block) {
                const drawer = block.closest('.inline-drawer');
                const content = drawer?.querySelector('.inline-drawer-content');
                if (content instanceof HTMLElement && content.offsetParent === null) {
                    /** @type {HTMLElement|null} */ (drawer?.querySelector('.inline-drawer-toggle'))?.click();
                }
                // The drawer SLIDES open, and the global list above this block grows with it.
                // Scrolling on the next frame lands on where the block was (the first cut did,
                // and only passed by hand because the drawer was already open). Wait until its
                // position holds for a few frames.
                let last = Number.NaN;
                let still = 0;
                for (let i = 0; i < 90 && still < 4; i++) {
                    await frame();
                    const top = block.getBoundingClientRect().top;
                    still = block.offsetParent !== null && Math.abs(top - last) < 0.5 ? still + 1 : 0;
                    last = top;
                }
                // Into the sheet's own scroller, never `scrollIntoView`: that can scroll the
                // document out from under the shell.
                let scroller = block.parentElement;
                while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
                if (scroller) scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
            }
        }
        this.#syncRegex();
    }

    /**
     * The explicit recount (decision 2). The stock panel ran this dry run on EVERY render,
     * including every toggle; here it is a button that says it is running and refuses to run
     * twice. `/kotatsu-recount` drives the same guard from STscript.
     * @returns {unknown} The button.
     */
    #renderRecount() {
        if (this._status !== 'ready' && this._status !== 'no-order') return nothing;
        const title = this._busy
            ? 'Counting — a dry run of the assembly is in flight'
            : 'Recount tokens: run one dry generation and refresh the badges';
        return html`
            <button type="button" class="k-pl-recount${this._busy ? ' is-busy' : ''}"
                ?disabled=${this._busy}
                aria-busy=${String(this._busy)}
                title=${title}
                aria-label="Recount tokens"
                @click=${() => this.#recount()}>${icons.recount}</button>`;
    }

    /**
     * Runs the on-demand dry run. The busy flag lives on the seam, not here, so the slash
     * command and the button cannot start two at once.
     * @returns {Promise<void>}
     */
    async #recount() {
        if (this._busy) return;
        await recountTokens();
    }

    /**
     * @param {Event} event Input event from the search box.
     * @returns {void}
     */
    #onQuery(event) {
        const input = event.target;
        this._query = input instanceof HTMLInputElement ? input.value : '';
        this.#applySearch();
        this._revision++;
    }

    /** @returns {unknown} Core's error line, when the last assembly set one. */
    #renderError() {
        if (!this._error) return nothing;
        return html`
            <p class="k-pl-error" role="status">
                ${icons.warning}<span>${this._error}</span>
                <button type="button" class="k-pl-search-clear" title="Dismiss" aria-label="Dismiss error"
                    @click=${() => { this._error = ''; }}>${icons.close}</button>
            </p>`;
    }

    /** @returns {unknown} Sections, the shelf, and the data-integrity notes. */
    #renderBody() {
        const model = this.#model;
        if (!model) return nothing;
        return html`
            <div class="k-pl-list" role="list">
                ${model.sections.map(section => this.#renderSection(section))}
                ${this.#renderShelf(model)}
                ${this.#renderNotes(model)}
            </div>`;
    }

    /** @returns {unknown} Quiet states — every one names what is actually true. */
    #renderQuiet() {
        if (this._status === 'foreign-api') {
            return this.#quiet('Chat Completion only.',
                'The prompt manager describes a Chat Completion assembly; the current API builds its prompt a different way.');
        }
        if (this._status === 'no-manager') {
            return this.#quiet('Prompt manager not ready.', 'Settings have not finished loading yet.');
        }
        const model = this.#model;
        if (this._status === 'no-order' && model) {
            return html`
                <div class="k-pl-quiet">
                    <span class="k-pl-quiet-title">This preset orders no prompts.</span>
                    <span class="k-pl-quiet-note">${model.unlisted.length} prompt${model.unlisted.length === 1 ? '' : 's'} exist without an order entry. They are listed below and are not sent.</span>
                </div>
                <div class="k-pl-list" role="list">${this.#renderShelf(model)}</div>`;
        }
        return this.#quiet('No prompts in this preset.', 'Add one with New, or import a prompt set from the footer.');
    }

    /**
     * @param {string} title Headline.
     * @param {string} note Supporting line.
     * @returns {unknown} A muted, non-interactive block.
     */
    #quiet(title, note) {
        return html`
            <div class="k-pl-quiet">
                <span class="k-pl-quiet-title">${title}</span>
                <span class="k-pl-quiet-note">${note}</span>
            </div>`;
    }

    /**
     * @param {import('./view-model.js').SectionView} section One derived section.
     * @returns {unknown} A collapsible section.
     */
    #renderSection(section) {
        const open = this.#isOpen(section.key);
        const identifier = section.row?.identifier ?? '';
        return html`
            <section class="k-pl-section${open ? ' is-open' : ''}" role="listitem">
                <div class="k-pl-head-row k-pl-head-row--section${this.#headState(section.key, section.row)}${this.#dragClasses(identifier)}"
                    data-identifier=${identifier}>
                    ${this.#renderTwist(section.key, open, section.label || 'section')}
                    <span class="k-pl-head-label" title=${section.label || ''}>${this.#renderLabel(section.label || '(unnamed section)')}</span>
                    ${section.exclusive ? this.#renderExclusiveChip(section.key, section.label) : nothing}
                    <span class="k-pl-spring" aria-hidden="true"></span>
                    ${this.#renderCounter(section.counter)}
                    ${this.#renderMaster(section.key, section.label || 'this section', section.exclusive)}
                    ${section.row ? this.#renderRowChrome(section.row) : nothing}
                </div>
                ${this.#renderReceiptIf(section.row)}
                ${this.#renderProgress(section.counter)}
                ${open ? html`
                    <div class="k-pl-section-body">
                        ${section.children.map(node => this.#renderNode(node))}
                    </div>` : nothing}
            </section>`;
    }

    /**
     * @param {import('./view-model.js').NodeView} node Tree node.
     * @returns {unknown} A container or a leaf row.
     */
    #renderNode(node) {
        if (node.kind === 'group' || node.kind === 'span') return this.#renderContainer(node);
        return node.row ? this.#renderRow(node.row, node.kind === 'option') : nothing;
    }

    /**
     * A sub-group or a tag-pair span. Decision 5: a span is ONE boundary pair around its
     * children, so both of its real prompts render as the container's own rows and 24 of the
     * fixtures' ~90 list entries stop being loose siblings.
     * @param {import('./view-model.js').NodeView} node Container node.
     * @returns {unknown} The container.
     */
    #renderContainer(node) {
        const open = this.#isOpen(node.key);
        const label = node.label || (node.row ? node.row.name : '') || '(unnamed)';
        const identifier = node.row?.identifier ?? '';
        return html`
            <div class="k-pl-container k-pl-container--${node.kind}${open ? ' is-open' : ''}"
                style="--k-pl-depth:${node.depth}">
                <div class="k-pl-head-row k-pl-head-row--${node.kind}${this.#headState(node.key, node.row)}${this.#dragClasses(identifier)}"
                    data-identifier=${identifier}>
                    ${this.#renderTwist(node.key, open, label)}
                    ${this.#renderGrip(identifier, label)}
                    <span class="k-pl-head-label" title=${label}>${this.#renderLabel(label)}</span>
                    ${node.exclusive ? this.#renderExclusiveChip(node.key, label) : nothing}
                    <span class="k-pl-spring" aria-hidden="true"></span>
                    ${this.#renderCounter(node.counter)}
                    ${this.#renderMaster(node.key, label, node.exclusive)}
                    ${node.row ? this.#renderRowChrome(node.row) : nothing}
                </div>
                ${this.#renderReceiptIf(node.row)}
                ${open ? html`
                    <div class="k-pl-container-body">
                        ${node.children.map(child => this.#renderNode(child))}
                        ${node.closeRow ? html`
                            <div class="k-pl-close-row">${this.#renderRow(node.closeRow, false, 'closing tag')}</div>` : nothing}
                    </div>` : nothing}
            </div>`;
    }

    /**
     * Search state for a container's own header row. A header carries a real prompt, so it must
     * light up and dim on exactly the same terms as a leaf — otherwise the search count and the
     * highlighted rows disagree, which is how a reader stops trusting either.
     * @param {string} key Collapse key.
     * @param {import('./view-model.js').RowView|null} row The header's prompt row.
     * @returns {string} Class suffix, '' when no search is running.
     */
    #headState(key, row) {
        if (!this.#search.active) return '';
        const hit = Boolean(row && this.#search.matches.has(row.identifier));
        if (hit) return ' is-hit';
        return this.#search.expand.has(key) ? '' : ' is-dim';
    }

    /**
     * @param {string} key Collapse key.
     * @param {boolean} open Current state.
     * @param {string} label Container label, for the accessible name.
     * @returns {unknown} The twist button.
     */
    #renderTwist(key, open, label) {
        return html`
            <button type="button" class="k-pl-twist${open ? ' is-open' : ''}"
                aria-expanded=${String(open)}
                aria-label=${open ? `Collapse ${label}` : `Expand ${label}`}
                @click=${() => this.#toggleCollapse(key)}>${icons.chevron}</button>`;
    }

    /**
     * The radio-group affordance (decision 6). Two parts, on purpose: a static chip that says
     * what the group IS, and a button that says — and changes — whether that is being enforced.
     *
     * Enforcement is the default and the reason Andres asked for it ("makes it foolproof"); the
     * relax button exists for the rare deliberate double, is per group, and is remembered per
     * preset in `accountStorage` (never in the preset file — a fixture must never gain a key).
     *
     * The one exception to the default: a group that already has several on reads "relaxed"
     * without anyone having relaxed it, and says why. Foolproof has to include not switching a
     * dozen rows off because a preset's "pick one" banner ran on past its options.
     * @param {string} key Container key.
     * @param {string} label Container label, for the accessible name.
     * @returns {unknown} The chip pair.
     */
    #renderExclusiveChip(key, label) {
        const state = this.#radioStateOf(key) ?? 'enforced';
        const enforced = state === 'enforced';
        const name = label || 'this group';
        let title = `Relaxed: these behave as ordinary toggles. Click to enforce "pick one" again for ${name}.`;
        if (enforced) title = `Enforced: turning one on turns the others off. Click to relax it for ${name}.`;
        else if (state === 'open') title = `Not enforced: several of these are already on, so they behave as ordinary toggles. Click to enforce "pick one" for ${name}.`;
        // In a narrow dock the two chips are one (css/prompt-list.css, "Narrow"): the static chip
        // steps aside and an enforced button is drawn as "pick one". The word in the DOM stays
        // the state, which is what probes and assistive tech read.
        return html`
            <span class="k-pl-chip k-pl-chip--exclusive" title="Only one of these is meant to be on">pick one</span>
            <button type="button" class="k-pl-chip k-pl-chip--relax${enforced ? ' is-on' : ''}"
                aria-pressed=${String(enforced)}
                title=${title}
                aria-label=${enforced ? `Relax pick-one for ${name}` : `Enforce pick-one for ${name}`}
                @click=${() => this.#toggleRelax(key)}><span class="k-pl-relax-word">${enforced ? 'enforced' : 'relaxed'}</span></button>`;
    }

    /**
     * A container's master toggle. One button, because the state it would move to is never
     * ambiguous: something off means "all on", everything on means "all off". An enforced radio
     * group gets the CLEAR variant instead — "all on" is not a state it can be in.
     * @param {string} key Container key.
     * @param {string} label Container label, for the accessible name.
     * @param {boolean} exclusive Whether the container is an exclusive group.
     * @returns {unknown} The button, or nothing when the container holds no toggleable row.
     */
    #renderMaster(key, label, exclusive) {
        const state = this.#masterState(key, exclusive);
        if (!state) return nothing;
        const clear = state.mode === 'clear';
        const dead = clear && state.enabled === 0;
        const name = label || 'this section';
        let title = `Enable all ${state.count} prompts in ${name}`;
        if (clear) title = `Turn every option in ${name} off (${state.enabled} on)`;
        else if (!state.target) title = `Disable all ${state.count} prompts in ${name}`;
        return html`
            <button type="button" class="k-pl-master" ?disabled=${dead}
                title=${title} aria-label=${title}
                @click=${() => this.#masterToggle(key, state.mode)}>${state.target ? icons.masterOn : icons.masterOff}</button>`;
    }

    /**
     * The drag handle. Rendered only for rows the tree says can move — leaves, options and span
     * containers; a section banner or a group header is structure and stays put (decision 8).
     * Non-draggable rows get an inert spacer so every name still starts at the same x.
     * @param {string} identifier Prompt identifier, '' for a container with no row.
     * @param {string} label Row label, for the accessible name.
     * @returns {unknown} The grip.
     */
    #renderGrip(identifier, label) {
        if (!identifier || !this.#index.blocks.has(identifier)) {
            return html`<span class="k-pl-grip k-pl-grip--fixed" aria-hidden="true"></span>`;
        }
        const block = this.#index.blocks.get(identifier) ?? [identifier];
        const title = block.length > 1
            ? `Drag to reorder — moves all ${block.length} rows of this span together`
            : 'Drag to reorder';
        return html`
            <span class="k-pl-grip" data-drag=${identifier} title=${title}
                role="button" tabindex="-1" aria-label=${`Reorder ${label}`}>${icons.grip}</span>`;
    }

    /**
     * @param {import('./view-model.js').Counter} counter Container counter.
     * @returns {unknown} The `(n/m)` readout, or nothing for an empty container.
     */
    #renderCounter(counter) {
        if (!counter || counter.total === 0) return nothing;
        return html`<span class="k-pl-counter" title="${counter.enabled} of ${counter.total} prompts inside are enabled">${counter.enabled}/${counter.total}</span>`;
    }

    /**
     * @param {import('./view-model.js').Counter} counter Section counter.
     * @returns {unknown} A thin progress rule under the section header.
     */
    #renderProgress(counter) {
        if (!counter || counter.total === 0) return nothing;
        return html`<div class="k-pl-progress" aria-hidden="true"><i style="width:${counterPercent(counter)}%"></i></div>`;
    }

    /**
     * One prompt row.
     * @param {import('./view-model.js').RowView} row Row view.
     * @param {boolean} [option] Whether the row is a radio option (visual grouping only in B).
     * @param {string} [note] Extra muted note, e.g. a span's closing boundary.
     * @returns {unknown} The row.
     */
    #renderRow(row, option = false, note = '') {
        const hit = this.#search.active && this.#search.matches.has(row.identifier);
        const dim = this.#search.active && !hit;
        const classes = [
            'k-pl-row',
            option ? 'k-pl-row--option' : '',
            row.enabled ? 'is-enabled' : 'is-disabled',
            hit ? 'is-hit' : '',
            dim ? 'is-dim' : '',
            row.present ? '' : 'is-missing',
        ].filter(Boolean).join(' ') + this.#dragClasses(row.identifier);
        const chrome = KIND_CHROME[row.kind];
        return html`
            <div class=${classes} data-kind=${row.kind} data-identifier=${row.identifier} role="listitem">
                ${this.#renderGrip(row.identifier, row.label)}
                ${this.#renderSwitch(row)}
                <span class="k-pl-kind" title=${chrome.title} aria-label=${chrome.label}>${chrome.icon}</span>
                <span class="k-pl-name" title=${row.name || row.identifier}>${this.#renderLabel(row.label)}</span>
                ${note ? html`<span class="k-pl-note">${note}</span>` : nothing}
                ${this.#renderRowChips(row)}
                ${this.#renderRowChrome(row)}
            </div>
            ${this.#renderReceiptIf(row)}`;
    }

    /**
     * The chips that carry the discriminations core hid in five icon variants plus two `<small>`
     * tags. Every one of them is a fact read off the raw record.
     * @param {import('./view-model.js').RowView} row Row view.
     * @returns {unknown} The chip strip.
     */
    #renderRowChips(row) {
        // No strip at all when there is nothing to put in it: an empty one still costs the row a
        // gap, and in a narrow dock that gap is the name's.
        if (!row.tag && !row.roleChip && !row.inChat && !row.overridden && !row.source && row.present) return nothing;
        return html`
            <span class="k-pl-chips">
                ${row.tag ? html`<span class="k-pl-chip k-pl-chip--tag" title="The tag in front of this prompt's name">${row.tag}</span>` : nothing}
                ${row.roleChip ? html`<span class="k-pl-chip k-pl-chip--role" title="Sent with the ${row.roleChip} role">${row.roleChip}</span>` : nothing}
                ${row.inChat ? html`<span class="k-pl-chip k-pl-chip--depth" title="Injected into the chat at depth ${row.depth}">@${row.depth}</span>` : nothing}
                ${row.overridden ? html`<span class="k-pl-chip k-pl-chip--override" title="Pulled from the character card this generation">card</span>` : nothing}
                ${row.source ? html`<span class="k-pl-chip k-pl-chip--source" title="Engine slot filled from ${row.source}">${row.source}</span>` : nothing}
                ${row.present ? nothing : html`<span class="k-pl-chip k-pl-chip--missing" title="The order lists this identifier but the preset has no such prompt">missing</span>`}
            </span>`;
    }

    /**
     * The right-hand controls: token badge and the three per-row actions. Shared by leaf rows
     * and container header rows so a banner behaves exactly like the prompt it is.
     * @param {import('./view-model.js').RowView} row Row view.
     * @returns {unknown} Badge plus actions.
     */
    #renderRowChrome(row) {
        const caps = this.#capsFor(row.identifier);
        const canEdit = caps.edit;
        const canDetach = caps.detach;
        const open = this._inspecting === row.identifier;
        return html`
            ${this.#renderTokens(row)}
            <span class="k-pl-actions">
                <button type="button" class="k-pl-act${open ? ' is-on' : ''}"
                    ?disabled=${!caps.receipt}
                    title=${!caps.receipt ? 'No receipt yet — run a generation to see what this prompt contributed' : 'Show what this prompt contributed'}
                    aria-label="Inspect ${row.label}"
                    aria-expanded=${String(open)}
                    @click=${() => { this._inspecting = open ? '' : row.identifier; }}>${icons.inspect}</button>
                <button type="button" class="k-pl-act" ?disabled=${!canEdit} title="Edit prompt"
                    aria-label="Edit ${row.label}"
                    @click=${() => this.#edit(row.identifier)}>${icons.edit}</button>
                <button type="button" class="k-pl-act k-pl-act--danger" ?disabled=${!canDetach}
                    title="Remove from this preset's order" aria-label="Remove ${row.label}"
                    @click=${() => this.#detach(row.identifier)}>${icons.detach}</button>
            </span>`;
    }

    /**
     * The token badge. Absence is a statement: see `tokenBadge()`'s three rules. A row with no
     * honest number gets no badge at all. The badge is the last thing in the row and sits flush
     * right, so numbers line up without an empty slot holding 46px on every other row; that slot
     * was every row's, before the first generation, and it came out of the name.
     * @param {import('./view-model.js').RowView} row Row view.
     * @returns {unknown} The badge.
     */
    #renderTokens(row) {
        if (row.tokens === null) return nothing;
        const warn = row.warn;
        /** @type {Record<string, string>} Core's two warning strings, plus the plain reading. */
        const titles = {
            danger: 'Very little chat history is being sent; consider disabling some prompts',
            warning: 'Only a few messages of chat history are being sent',
        };
        const title = warn ? titles[warn] : `${row.tokens} tokens in the last assembly`;
        return html`
            <span class="k-pl-tokens${warn ? ` is-${warn}` : ''}" title=${title}>
                ${warn ? icons.warning : nothing}${row.tokens}
            </span>`;
    }

    /**
     * The receipt drawer for a container's own header row — a banner, a sub-group header and a
     * span's opening tag are all real prompts with real receipts, so their inspect button has to
     * open somewhere too.
     * @param {import('./view-model.js').RowView|null} row The container's row, if it has one.
     * @returns {unknown} The drawer, or nothing.
     */
    #renderReceiptIf(row) {
        if (!row || this._inspecting !== row.identifier) return nothing;
        return this.#renderReceipt(row);
    }

    /**
     * The promoted inspect drawer (decision 9). Shows the exact per-message receipt core buries
     * in a popup: role, tokens, and the content that was actually assembled.
     * @param {import('./view-model.js').RowView} row Row view.
     * @returns {unknown} The drawer.
     */
    #renderReceipt(row) {
        const receipt = this.#receiptFor(row.identifier);
        if (receipt === null) return nothing;
        if (receipt.length === 0) {
            return html`
                <div class="k-pl-receipt">
                    <p class="k-pl-receipt-empty">This marker contributed no messages to the last assembly.</p>
                </div>`;
        }
        return html`
            <div class="k-pl-receipt">
                ${receipt.map(message => html`
                    <article class="k-pl-receipt-item">
                        <header class="k-pl-receipt-head">
                            <span class="k-pl-chip k-pl-chip--role">${message.role || 'system'}</span>
                            <span class="k-pl-receipt-id">${message.identifier || row.identifier}</span>
                            <span class="k-pl-tokens">${message.tokens}</span>
                        </header>
                        <pre class="k-pl-receipt-body">${message.content || '(empty)'}</pre>
                    </article>`)}
            </div>`;
    }

    /**
     * The unlisted shelf. `prompts[]` entries with no order entry — both acceptance fixtures
     * ship exactly one on purpose. They are NOT sent, and the UI never invents an order entry
     * for them (slice A's rule).
     * @param {import('./view-model.js').ListModel} model Render model.
     * @returns {unknown} The shelf, or nothing.
     */
    #renderShelf(model) {
        if (model.unlisted.length === 0) return nothing;
        const open = this.#isOpen('~unlisted');
        return html`
            <section class="k-pl-shelf${open ? ' is-open' : ''}" role="listitem">
                <div class="k-pl-head-row k-pl-head-row--shelf">
                    ${this.#renderTwist('~unlisted', open, 'unlisted prompts')}
                    <span class="k-pl-kind" title="Not in this preset's order">${icons.shelf}</span>
                    <span class="k-pl-head-label">Unlisted</span>
                    <span class="k-pl-counter" title="Prompts with no order entry">${model.unlisted.length}</span>
                </div>
                ${open ? html`
                    <div class="k-pl-section-body">
                        <p class="k-pl-shelf-note">These prompts exist in the preset but have no order entry, so nothing sends them.</p>
                        ${model.unlisted.map(row => this.#renderRow(row))}
                    </div>` : nothing}
            </section>`;
    }

    /**
     * Data-integrity notes. Both are conditions slice A reports and core silently swallows; a
     * duplicated identifier in particular makes core's drag write `undefined` into the order.
     * @param {import('./view-model.js').ListModel} model Render model.
     * @returns {unknown} The notes, or nothing.
     */
    #renderNotes(model) {
        if (model.unknownOrder.length === 0 && model.duplicateOrder.length === 0) return nothing;
        return html`
            <div class="k-pl-notes">
                ${model.unknownOrder.length > 0 ? html`
                    <p class="k-pl-note-line">${icons.warning}<span>${model.unknownOrder.length} order entr${model.unknownOrder.length === 1 ? 'y has' : 'ies have'} no matching prompt and cannot be rendered.</span></p>` : nothing}
                ${model.duplicateOrder.length > 0 ? html`
                    <p class="k-pl-note-line">${icons.warning}<span>${model.duplicateOrder.length} identifier${model.duplicateOrder.length === 1 ? ' is' : 's are'} listed more than once in the order. Toggles and reorders here touch the first entry only, which is the one the engine reads.</span></p>` : nothing}
            </div>`;
    }

    /**
     * The row's enabled switch.
     * @param {import('./view-model.js').RowView} row Row view.
     * @returns {unknown} The switch, or an inert slot when the order does not hold this row.
     */
    #renderSwitch(row) {
        const caps = this.#capsFor(row.identifier);
        if (!caps.toggle) {
            return html`<span class="k-pl-switch k-pl-switch--fixed" aria-hidden="true"
                title=${caps.listed ? 'This prompt cannot be switched off' : 'Not in the order'}></span>`;
        }
        return html`
            <button type="button" role="switch" class="k-pl-switch"
                aria-checked=${String(row.enabled)}
                aria-label=${`${row.enabled ? 'Disable' : 'Enable'} ${row.label}`}
                title=${row.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                @click=${() => this.#toggleRow(row.identifier)}><span class="k-pl-knob"></span></button>`;
    }

    /**
     * A label with search hits wrapped in `<mark>`. Segments come from a pure helper, so no
     * HTML is ever assembled out of user data.
     * @param {string} text Label text.
     * @returns {unknown} The label content.
     */
    #renderLabel(text) {
        if (!this.#search.active) return text;
        const segments = highlightSegments(text, this.#search.terms);
        return segments.map(part => part.hit ? html`<mark class="k-pl-mark">${part.text}</mark>` : part.text);
    }

    /**
     * The footer. Every action delegates to the handler `PromptManager.init()` already built
     * (`:585-723`); the append select keeps core's id because `handleAppendPrompt` and
     * `handleDeletePrompt` read their target out of it by `getElementById` (`:586`, `:601`).
     * @returns {unknown} The footer.
     */
    #renderFoot() {
        const manager = this.manager;
        if (!manager || this._status === 'foreign-api' || this._status === 'no-manager') return nothing;
        const prefix = typeof manager.configuration?.prefix === 'string' ? manager.configuration.prefix : 'completion_';
        const prompts = Array.isArray(this.#settings?.prompts) ? this.#settings.prompts : [];
        const selectable = prompts
            .filter((/** @type {any} */ prompt) => prompt && !prompt.system_prompt)
            .slice()
            .sort((/** @type {any} */ a, /** @type {any} */ b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
        return html`
            <footer class="k-pl-foot">
                <select id="${prefix}prompt_manager_footer_append_prompt" class="k-pl-select text_pole"
                    aria-label="Prompt to append or delete">
                    ${selectable.map((/** @type {any} */ prompt) => html`<option value=${prompt.identifier}>${prompt.name}</option>`)}
                </select>
                <button type="button" class="k-pl-btn" title="Append the selected prompt to this preset's order"
                    @click=${(/** @type {MouseEvent} */ e) => manager.handleAppendPrompt(e)}>Append</button>
                <button type="button" class="k-pl-btn" title="Create a new prompt"
                    @click=${(/** @type {MouseEvent} */ e) => manager.handleNewPrompt(e)}>New</button>
                <button type="button" class="k-pl-btn" title="Import a prompt set"
                    @click=${(/** @type {MouseEvent} */ e) => manager.handleImport(e)}>Import</button>
                <button type="button" class="k-pl-btn" title="Export every user prompt"
                    @click=${(/** @type {MouseEvent} */ e) => manager.handleFullExport(e)}>Export</button>
                <button type="button" class="k-pl-btn k-pl-btn--danger" title="Delete the selected prompt"
                    @click=${(/** @type {MouseEvent} */ e) => manager.handleDeletePrompt(e)}>Delete</button>
                <button type="button" class="k-pl-btn k-pl-btn--danger" title="Reset this preset's prompt order"
                    @click=${(/** @type {MouseEvent} */ e) => manager.handleCharacterReset(e)}>Reset order</button>
            </footer>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-prompt-list')) {
    customElements.define('k-prompt-list', KPromptList);
}

const { initKotatsuPromptList, uninstallKotatsuPromptList, recountTokens, isRecounting } = createPromptListSeam(KPromptList);
export { initKotatsuPromptList, uninstallKotatsuPromptList, recountTokens, isRecounting };
