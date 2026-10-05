/**
 * `<k-onboarding>` — Mikan-chan's welcome tour (docs/onboarding-v0.md). O1: the sheet, the
 * flag, resume, replay, Welcome. O2: Connect. O3: Sauce. O4: Persona. O5: First card. O6: Ready.
 *
 * ── Ready (O6) ──────────────────────────────────────────────────────────────────────────────
 * A summary of the four steps, read live (ready-state.js). Every step could be skipped, so every
 * row says what is set or plainly that it is not, with its step one press away. "Start writing"
 * closes the tour onto the chat First card opened and puts the cursor in the composer; with
 * nobody picked the button says "Go to the library", because that is where it goes.
 *
 * ── First card (O5) ─────────────────────────────────────────────────────────────────────────
 * Four ways in: a file (`processDroppedFiles`), a link (`importFromExternalUrl`), the card
 * studio (`openStudio('create')`), or the seeded card. None of core's ways says what happened:
 * they return nothing and report through toasts, and the studio has no "done" event. So the step
 * takes the library before and after, listens to core's toasts in between, and card-state.js
 * turns that into "landed (who)", "problem (core's words)" or "nothing". A card that lands is
 * selected, so its chat is open behind the sheet. The tour hides while the studio is up and
 * settles the step when it closes.
 *
 * ── Persona (O4) ────────────────────────────────────────────────────────────────────────────
 * A name, an optional "who you are", an optional picture. This step replaces the stock first-run
 * name popup and does what it did: it names the persona slot a new profile already has (core
 * calls it "[Unnamed Persona]"), so nobody ends up with an orphan beside their own. Skipped, the
 * profile stays "User". persona-state.js decides update / create / nothing, so a replay shows
 * who they already are and never mints a second persona. The write is core's own
 * `/persona-update` or `/persona-create`, called as a function.
 *
 * ── Sauce (O3) ──────────────────────────────────────────────────────────────────────────────
 * Pick a sauce (core's preset manager selects it — presets never switch the connection, D3),
 * pick a play style (the preset's own radio group, written by `<k-prompt-list>.pickRadio()`, the
 * same single write a row click makes; preset FILES are never touched), then the dials the live
 * connection honours (sauce-state.js `dialsFor`): core's own inputs, set by value + `input` and
 * read back, so a model's ceiling shows as a disabled option instead of a silent clamp.
 *
 * ── Connect (O2) ────────────────────────────────────────────────────────────────────────────
 * Three lanes, Claude Code first. Nothing here connects anything by itself: the lanes host the
 * Connection tab's own components (`<k-bridge-card variant="compact">`, `<k-provider-cards>`)
 * and "Something else" opens that tab, so there is exactly one implementation of every connect
 * path. The step only watches — ONLINE_STATUS_CHANGED, the bridge's status events, and the cards'
 * `k-connect-attempt` — and `connectState()` turns what it sees into her line and pose: the
 * connected model, or the oops pose quoting the real reason. Leaving without a connection is
 * allowed (skippable everywhere) after one warm warning.
 *
 * ── Lifecycle (the settings-modal pattern, k-settings-modal.js) ─────────────────────────────
 * Created on open and appended to `<body>`, removed on close, light DOM (`onboarding.css` owns
 * every rule). One close path: `#finish()` writes the flag, then `remove()`, and
 * `disconnectedCallback()` undoes everything the element did to the document.
 *
 * ── Stacking ────────────────────────────────────────────────────────────────────────────────
 * scrim 4080 / sheet 4081 (`ONBOARDING_Z`, mirrored in onboarding.css): one rung under settings
 * (4090) and the card studio (4100), because later steps open both ON TOP of the tour. And while
 * either is up the tour hides outright (`covered`), so nothing ever stacks half-visible and the
 * tour's Escape and focus trap stand aside for theirs.
 *
 * ── The flag ────────────────────────────────────────────────────────────────────────────────
 * `power_user.kotatsu_onboarding`, semantics in flow.js. Every step change writes `step:<id>`
 * through the debounce; the only reload this element triggers (the language select) awaits a
 * real `saveSettings()` first (persistence §1.7).
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import {
    characters,
    getThumbnailUrl,
    isChatSaving,
    main_api,
    online_status,
    processDroppedFiles,
    saveSettings,
    saveSettingsDebounced,
    selectCharacterById,
    this_chid,
} from '../../script.js';
import { importFromExternalUrl } from '../../scripts/utils.js';
import { openStudio } from '../studio/k-card-studio.js';
import { BROWSE_OPEN_CLASS, showLibraryView } from '../library/k-library.js';
import { listenToToasts } from '../shell/toast-ear.js';
import { cardOutcome, cleanLink, findSeeded } from './card-state.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { oai_settings } from '../../scripts/openai.js';
import { power_user } from '../../scripts/power-user.js';
import { line } from '../brand/mascot/lines.js';
import {
    BRIDGE_CHANGE_EVENT,
    BRIDGE_STATUS_EVENT,
    getBridgeModel,
    getDoctor,
    getHealth,
    isOnBridge,
    loadDoctor,
    modelLabel,
} from '../connections/bridge.js';
import { composerReason } from '../connections/composer-reason.js';
import { getBridgeEffort, setBridgeEffort } from '../connections/bridge.js';
import { getPresetManager } from '../../scripts/preset-manager.js';
import { PROMPT_LIST_RENDERED_EVENT, PROMPT_LIST_TOGGLED_EVENT } from '../prompts/k-prompt-list.js';
import { DIALS, MATURE_IDENTIFIER, availableSauces, bridgeContextCeiling, dialsFor, modeGroup, modeLabel, optionBlurb, optionLabel, promptState, regexNote, selectedOption } from './sauce-state.js';
import { SCRIPT_TYPES, getCurrentPresetAPI, getCurrentPresetName, getScriptsByType, isPresetScriptsAllowed } from '../../scripts/extensions/regex/engine.js';
import { FALLBACK_MANIFEST, loadPresetCredits } from './preset-credits.js';
import { PROVIDERS } from '../connections/providers.js';
import { CONNECT_ATTEMPT_EVENT } from '../connections/k-provider-cards.js';
import '../connections/k-bridge-card.js';
import '../connections/k-chatgpt-card.js';
import { isOnChatGPT } from '../connections/chatgpt.js';
import { LANES, connectState, initialLane } from './connect-state.js';
import { getUserAvatar, user_avatar } from '../../scripts/personas.js';
import { SlashCommandParser } from '../../scripts/slash-commands/SlashCommandParser.js';
import { effortWord } from '../shell/components/k-model-menu.js';
import { NAME_LIMIT, initialForm, isNamed, personaPlan } from './persona-state.js';
import { readySummary } from './ready-state.js';
import {
    FLAG_DONE,
    FLAG_SKIPPED,
    STEPS,
    STEP_POSES,
    flagFor,
    isStep,
    nextStep,
    previousStep,
    progress,
    tourState,
} from './flow.js';

/** @typedef {import('./flow.js').Step} Step */
/** @typedef {import('./connect-state.js').Lane} Lane */
/** @typedef {import('../prompts/k-prompt-list.js').KPromptList} KPromptList */
/**
 * @typedef {object} StudioWatch What First card keeps while the card studio is open from it.
 * @property {string[]} before The library's avatars when the studio opened.
 * @property {boolean} submitted Whether a create with a name was submitted.
 * @property {{toasts: import('./card-state.js').Toast[], stop: () => void}} ear Core's toasts since.
 * @property {HTMLElement|null} form Core's `#form_create`.
 * @property {() => void} onSubmit The `submit` listener on it.
 */

/**
 * @typedef {object} BrowseWatch What First card keeps while Browse Characters is open from it.
 * @property {string[]} before The library's avatars when the view opened.
 * @property {{toasts: import('./card-state.js').Toast[], stop: () => void}} ear Core's toasts since.
 * @property {() => void} onImported The `k-market-imported` listener on `document`.
 */

/** @type {Readonly<Record<Lane, string>>} */
// The first lane is a plan you already pay for: Claude Code or ChatGPT (v0.2.0 walkthrough F1;
// its id stays `claude` so saved state and tests keep their meaning).
const LANE_LABELS = Object.freeze({ claude: 'Your subscription', keys: 'An API key', other: 'Something else' });

/** Stacking rungs, mirrored by `--k-onb-z-*` in onboarding.css. */
export const ONBOARDING_Z = Object.freeze({ scrim: 4080, sheet: 4081 });

/** Window event that (re)opens the tour; Settings → System's replay button dispatches it. */
export const OPEN_TOUR_EVENT = 'k-open-onboarding';

/** Set on `<body>` while the tour is up. */
const OPEN_CLASS = 'k-onboarding-open';

/**
 * Body classes of the surfaces the tour steps aside for: the settings modal, the card studio,
 * and the gallery while it is in Browse Characters (marketplace v0 §9, the fifth tile).
 */
const COVERING_CLASSES = Object.freeze(['k-settings-modal-open', 'k-studio-open', BROWSE_OPEN_CLASS]);

/** Raised on `document` by the marketplace's preview sheet after a card lands (bubbles from body). */
const MARKET_IMPORTED_EVENT = 'k-market-imported';

/** @type {Readonly<Record<Step, string>>} */
const STEP_TITLES = Object.freeze({
    welcome: 'Welcome to Kotatsu',
    connect: 'Connect a model',
    sauce: 'Pick your sauce',
    persona: 'Who are you?',
    card: 'Your first character',
    ready: 'All set',
});

/** What Welcome promises, in order — one line per later step. */
const PLAN = Object.freeze([
    ['connect', 'Connect a model to write with'],
    ['sauce', 'Season the preset to taste'],
    ['persona', 'Tell the story who you are'],
    ['card', 'Bring in, or make, someone to talk to'],
]);

/** How long a submitted studio create is given to reach the library before the step gives up on it. */
const STUDIO_CREATE_WAIT_MS = 20000;

/** First card's tile icons: inline stroke SVG, 16px, currentColor (house rule: no emoji as icons). */
const tileIcon = (/** @type {unknown} */ body) => html`<svg class="k-onb-tile-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const TILE_ICONS = Object.freeze({
    file: tileIcon(svg`<path d="M8 10.5v-8M4.5 6L8 2.5 11.5 6M3 13.5h10"/>`),
    link: tileIcon(svg`<path d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.8.8"/><path d="M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.8-.8"/>`),
    browse: tileIcon(svg`<circle cx="8" cy="8" r="5.75"/><path d="m10.4 5.6-1.5 3.3-3.3 1.5 1.5-3.3z"/>`),
    studio: tileIcon(svg`<path d="M3 13l.6-3L11 2.6a1.4 1.4 0 0 1 2 2L5.6 12z"/><path d="M9.8 3.8l2 2"/>`),
    seeded: tileIcon(svg`<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 13.5a5.2 5.2 0 0 1 10.4 0"/>`),
});

/** @returns {boolean} Whether the rails shell is active (the tour is a rails surface). */
function railsActive() {
    return document.body?.dataset?.kLayout === 'rails';
}

/** @returns {KOnboarding|null} The open tour, if any. */
function currentTour() {
    const element = document.querySelector('k-onboarding');
    return element instanceof KOnboarding ? element : null;
}

/** @returns {boolean} Whether settings or the card studio is up over the tour. */
function isCovered() {
    return COVERING_CLASSES.some(name => document.body.classList.contains(name));
}

export class KOnboarding extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        step: { type: String, reflect: true },
        covered: { type: Boolean, reflect: true },
        _line: { state: true },
        _reloading: { state: true },
        _lane: { state: true },
        _failed: { state: true },
        _warned: { state: true },
        _pName: { state: true },
        _pDesc: { state: true },
        _pAvatar: { state: true },
        _busy: { state: true },
        _trouble: { state: true },
        _more: { state: true },
        _tile: { state: true },
        _link: { state: true },
        _landed: { state: true },
        _dropping: { state: true },
        _credits: { state: true },
        _regexSig: { state: true },
        _explain: { state: true },
    };

    /** @type {HTMLElement|null} Focus to restore on close. */
    #opener = null;
    /** @type {((event: KeyboardEvent) => void)|null} */
    #onKeydown = null;
    /** @type {MutationObserver|null} */
    #coverWatcher = null;
    /** @type {string} A one-time line for the first step shown (the replay greeting). */
    #greeting = '';
    /** @type {string} Which line situation is showing, so a re-render never re-rolls it. */
    #lineSig = '';
    /** @type {ReturnType<typeof setInterval>|null} Watches the regex allow state while Sauce is up (core's popup resolves out of band). */
    #regexTimer = null;
    /** @type {boolean} Whether the step's last write through core failed (she wears the oops pose). */
    #saveFailed = false;
    /** @type {StudioWatch|null} First card: what is being watched while the studio is open from here. */
    #studio = null;
    /** @type {BrowseWatch|null} First card: what is being watched while Browse Characters is open from here. */
    #browse = null;
    /** Re-renders on connection news while the tour is up. */
    #onConnectionNews = () => this.requestUpdate();
    /** @param {Event} event `k-connect-attempt` from an embedded provider card. */
    #onAttempt = (event) => {
        const detail = /** @type {CustomEvent} */ (event).detail ?? {};
        this._failed = detail.ok ? '' : String(detail.name ?? '');
    };

    constructor() {
        super();
        /** @type {string} Theme-pack variant (CLAUDE.md: every component ships one). */
        this.variant = 'sheet';
        /** @type {Step} */
        this.step = STEPS[0];
        /** @type {boolean} True while settings or the studio covers the tour. */
        this.covered = false;
        /** @type {string} Mikan-chan's current line. */
        this._line = '';
        /** @type {boolean} True between a language pick and the reload it triggers. */
        this._reloading = false;
        /** @type {Lane} Connect: the open lane. */
        this._lane = 'claude';
        /** @type {string} Connect: the provider whose last key didn't take, or ''. */
        this._failed = '';
        /** @type {boolean} Connect: the one "you'll need this" warning has been given. */
        this._warned = false;
        /** @type {string} Persona: the name field. */
        this._pName = '';
        /** @type {string} Persona: the "who you are" field. */
        this._pDesc = '';
        /** @type {string} Persona: a newly picked picture as a data URL, '' for none. */
        this._pAvatar = '';
        /** @type {boolean} True while a step is writing through core; Next waits. */
        this._busy = false;
        /** @type {string} What went wrong on this step, in core's own words; '' when nothing did. */
        this._trouble = '';
        /** @type {boolean} Whether the step's body has more below the fold. */
        this._more = false;
        /** @type {string} First card: the tile that is open ('link'), or ''. */
        this._tile = '';
        /** @type {string} First card: the link field. */
        this._link = '';
        /** @type {string} First card: the avatar of the card that is picked, or ''. */
        this._landed = '';
        /** @type {boolean} First card: a file is being dragged over the drop tile. */
        this._dropping = false;
    }

    /** Light DOM: onboarding.css owns every rule. */
    createRenderRoot() {
        return this;
    }

    /**
     * Shows `text` instead of the first step's usual line, once.
     * @param {string} text Greeting.
     * @returns {void}
     */
    greet(text) {
        this.#greeting = text;
    }

    connectedCallback() {
        super.connectedCallback();
        this.#opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        this.#onKeydown = (event) => this.#handleKeydown(event);
        window.addEventListener('keydown', this.#onKeydown, { capture: true });
        this.covered = isCovered();
        void loadPresetCredits().then((manifest) => { this._credits = manifest; });
        if (typeof MutationObserver === 'function') {
            this.#coverWatcher = new MutationObserver(() => {
                this.covered = isCovered();
            });
            this.#coverWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
        document.body.classList.add(OPEN_CLASS);
        eventSource.on(event_types.ONLINE_STATUS_CHANGED, this.#onConnectionNews);
        eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, this.#onConnectionNews);
        document.addEventListener(PROMPT_LIST_RENDERED_EVENT, this.#onConnectionNews);
        document.addEventListener(PROMPT_LIST_TOGGLED_EVENT, this.#onConnectionNews);
        document.addEventListener(BRIDGE_STATUS_EVENT, this.#onConnectionNews);
        document.addEventListener(BRIDGE_CHANGE_EVENT, this.#onConnectionNews);
        this.addEventListener(CONNECT_ATTEMPT_EVENT, this.#onAttempt);
    }

    disconnectedCallback() {
        eventSource.removeListener(event_types.ONLINE_STATUS_CHANGED, this.#onConnectionNews);
        eventSource.removeListener(event_types.OAI_PRESET_CHANGED_AFTER, this.#onConnectionNews);
        document.removeEventListener(PROMPT_LIST_RENDERED_EVENT, this.#onConnectionNews);
        document.removeEventListener(PROMPT_LIST_TOGGLED_EVENT, this.#onConnectionNews);
        document.removeEventListener(BRIDGE_STATUS_EVENT, this.#onConnectionNews);
        document.removeEventListener(BRIDGE_CHANGE_EVENT, this.#onConnectionNews);
        this.removeEventListener(CONNECT_ATTEMPT_EVENT, this.#onAttempt);
        if (this.#onKeydown) {
            window.removeEventListener('keydown', this.#onKeydown, { capture: true });
            this.#onKeydown = null;
        }
        if (this.#regexTimer) clearInterval(this.#regexTimer);
        this.#coverWatcher?.disconnect();
        this.#coverWatcher = null;
        this.#dropStudioWatch()?.ear.stop();
        this.#dropBrowseWatch()?.ear.stop();
        document.body.classList.remove(OPEN_CLASS);
        if (this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
        this.#opener = null;
        super.disconnectedCallback();
    }

    /** @param {Map<string, unknown>} changed Changed properties. */
    willUpdate(changed) {
        if (changed.has('step')) {
            if (!isStep(this.step)) this.step = STEPS[0];
            if (this.#greeting) {
                this._line = this.#greeting;
                this.#lineSig = 'greeting';
                this.#greeting = '';
            } else if (this.step !== 'connect') {
                this._line = line(/** @type {any} */ (this.step));
                this.#lineSig = this.step;
            }
            if (this.step === 'connect') this.#enterConnect();
            if (this.step === 'persona') this.#enterPersona();
            if (this.step === 'card') this.#enterCard();
            // She never says "all set up" about a tour that skipped things.
            if (this.step === 'ready' && this.#lineSig === 'ready' && this.#readySummary().rows.some(row => !row.set)) {
                this._line = line('readyLoose');
                this.#lineSig = 'readyLoose';
            }
            this._trouble = '';
            this.#saveFailed = false;
            this._explain = false;
            power_user.kotatsu_onboarding = flagFor(this.step);
            saveSettingsDebounced();
        }
        // Connect's line follows the connection, so it is re-derived on every update; the
        // signature keeps a re-render from re-rolling the same situation's variant.
        if (this.step === 'connect') this.#refreshConnectLine();
    }

    /** Fresh state for the Connect step, opened on the lane the current connection is in. */
    #enterConnect() {
        this._failed = '';
        this._warned = false;
        this.#lineSig = '';
        this._lane = initialLane({
            // Either plan opens the subscription lane, where both cards live.
            onBridge: isOnBridge() || isOnChatGPT(),
            source: main_api === 'openai' ? String(oai_settings?.chat_completion_source ?? '') : '',
            providerSources: PROVIDERS.map(provider => provider.source),
        });
        // The doctor spawns the claude CLI, so it is never on the boot path; someone looking at
        // the Claude Code lane is exactly when it is worth asking (bridge.js shares the answer).
        if (this._lane === 'claude' && !getDoctor().doctor && !getDoctor().pending) void loadDoctor();
    }

    /** @returns {string} What the live connection is, as a person says it. */
    #connectedLabel() {
        if (isOnBridge()) {
            const model = getBridgeModel();
            return model ? `Claude Code (${modelLabel(model)})` : 'Claude Code';
        }
        if (isOnChatGPT()) {
            const model = getBridgeModel();
            return model ? `ChatGPT (${model})` : 'ChatGPT';
        }
        if (main_api === 'openai') {
            const provider = PROVIDERS.find(entry => entry.source === oai_settings?.chat_completion_source);
            if (provider) {
                const model = String(/** @type {Record<string, unknown>} */ (oai_settings)?.[provider.modelKey] ?? '');
                return model ? `${provider.name} (${modelLabel(model)})` : provider.name;
            }
        }
        return 'your connection';
    }

    /** @returns {{ state: 'idle'|'absent'|'connected'|'problem', text: string }} The Connect step's reading. */
    #connectReading() {
        return connectState({
            online: String(online_status ?? ''),
            reason: composerReason({ onBridge: isOnBridge(), health: getHealth(), doctor: getDoctor().doctor, online: String(online_status ?? '') }),
            failed: this._failed,
            label: this.#connectedLabel(),
        });
    }

    /** Sets her Connect line from the reading, re-rolling only when the situation changes. */
    #refreshConnectLine() {
        const reading = this.#connectReading();
        // The skip warning outranks a problem: it is the last thing said before leaving without a
        // connection, and the status line below still shows the problem itself.
        const key = reading.state === 'connected' ? 'connected'
            : this._warned ? 'connectSkipped'
                : reading.state === 'problem' ? 'connectFailed'
                    : reading.state === 'absent' ? 'connectNoClaude' : 'connect';
        const signature = `${key}:${reading.text}`;
        if (signature === this.#lineSig) return;
        this.#lineSig = signature;
        // Reasons are sentences ("…on this computer."); her lines supply their own punctuation.
        const text = reading.text.replace(/[.!?…]+$/, '');
        this._line = line(key, { reason: text, what: text });
    }

    /**
     * Next / Skip this. Leaving Connect without a connection gets one warm warning first; the
     * second press goes (skippable everywhere, decision 2026-10-01). Next on Persona writes the
     * form first and stays put if that fails; Skip never writes.
     * @param {{skip?: boolean}} [options] `skip` leaves the step without writing what it holds.
     * @returns {Promise<void>}
     */
    async #advance({ skip = false } = {}) {
        if (this._busy) return;
        if (this.step === 'connect' && !this._warned && this.#connectReading().state !== 'connected') {
            this._warned = true;
            return;
        }
        if (this.step === 'persona' && !skip && !(await this.#commitPersona())) return;
        this.go(nextStep(/** @type {Step} */ (this.step)));
    }

    // ── Persona (O4) ────────────────────────────────────────────────────────────────────────

    /** @returns {import('./persona-state.js').PersonaNow} The active persona, as core has it. */
    #personaNow() {
        const personas = /** @type {Record<string, string>} */ (power_user.personas ?? {});
        const descriptor = /** @type {Record<string, {description?: string}>} */ (power_user.persona_descriptions ?? {})[user_avatar];
        const name = typeof personas[user_avatar] === 'string' ? personas[user_avatar] : '';
        // `/persona-update` needs both halves of the entry; without them the step creates.
        const exists = name !== '' && Boolean(descriptor);
        return { avatarId: user_avatar, exists, name, description: String(descriptor?.description ?? '') };
    }

    /** Fills the Persona fields with who they already are (blank on a new profile). */
    #enterPersona() {
        const form = initialForm(this.#personaNow());
        this._pName = form.name;
        this._pDesc = form.description;
        this._pAvatar = '';
    }

    /**
     * Reads a picked image into the form. Nothing is uploaded until Next.
     * @param {Event} event Change event from the file input.
     * @returns {void}
     */
    #pickAvatar(event) {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            this._trouble = `"${file.name}" is not a picture. A PNG, JPG or WebP works.`;
            return;
        }
        this._trouble = '';
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            this._pAvatar = typeof reader.result === 'string' ? reader.result : '';
        });
        reader.addEventListener('error', () => {
            this._trouble = `"${file.name}" could not be read.`;
        });
        reader.readAsDataURL(file);
    }

    /**
     * Writes the Persona form through core's own `/persona-update` (naming the slot a new
     * profile already has, the way the stock popup did) or `/persona-create` (no slot at all).
     * The commands are called as functions, not parsed from a string: a description is free
     * text, and the parser would expand its `{{macros}}` and split it at a pipe.
     * @returns {Promise<boolean>} Whether the tour may move on.
     */
    async #commitPersona() {
        const plan = personaPlan(this.#personaNow(), { name: this._pName, description: this._pDesc, avatar: this._pAvatar });
        if (plan.action === 'need-name') {
            this._trouble = 'A name is the one thing I need. Or press "Skip this" and stay "User" for now.';
            /** @type {HTMLElement|null} */ (this.querySelector('#k-onb-persona-name'))?.focus();
            return false;
        }
        if (plan.action === 'none') return true;
        const command = SlashCommandParser.commands[plan.action === 'create' ? 'persona-create' : 'persona-update'];
        this._busy = true;
        this._trouble = '';
        this.#saveFailed = false;
        // Core says "Persona … updated successfully" and "Persona Changed" here, on top of the
        // next step's title (walkthrough F3). She has just said it herself, so those two stay
        // quiet; a warning or an error from core still shows.
        const ear = listenToToasts({ quiet: toast => toast.level === 'success' || toast.level === 'info' });
        try {
            if (!command) throw new Error('the persona commands are not loaded');
            const key = await command.callback(/** @type {any} */ (plan.args), '');
            if (!key) throw new Error('core did not save it');
            this._pAvatar = '';
            return true;
        } catch (error) {
            this.#saveFailed = true;
            this._trouble = `That did not save: ${error instanceof Error ? error.message : String(error)}.`;
            return false;
        } finally {
            ear.stop();
            this._busy = false;
        }
    }

    /** @returns {unknown} The Persona step: a picture, a name, and who you are. */
    #renderPersona() {
        const now = this.#personaNow();
        const named = isNamed(now);
        // The slot's own picture, named or not: a new profile's is the default avatar.
        const picture = this._pAvatar || (now.exists && now.avatarId ? getUserAvatar(now.avatarId) : 'img/user-default.png');
        return html`
            <div class="k-onb-persona">
                <div class="k-onb-portrait">
                    <img class="k-onb-portrait-img" src=${picture} alt="" draggable="false">
                    <label class="k-onb-button k-onb-portrait-pick" data-kind="ghost">
                        ${this._pAvatar || named ? 'Change picture' : 'Add a picture'}
                        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="k-onb-file"
                            @change=${(/** @type {Event} */ event) => this.#pickAvatar(event)}>
                    </label>
                </div>
                <div class="k-onb-persona-fields">
                    <label class="k-onb-field">
                        <span class="k-onb-label">Your name</span>
                        <input id="k-onb-persona-name" class="k-onb-input text_pole" type="text" maxlength=${NAME_LIMIT} autocomplete="off"
                            placeholder="What the story calls you" .value=${this._pName}
                            @input=${(/** @type {Event} */ event) => { this._pName = /** @type {HTMLInputElement} */ (event.target).value; this._trouble = ''; }}
                            @change=${() => this.#greetByName()}
                            @keydown=${(/** @type {KeyboardEvent} */ event) => { if (event.key === 'Enter') { event.preventDefault(); void this.#advance(); } }}>
                    </label>
                    <label class="k-onb-field">
                        <span class="k-onb-label">Who you are</span>
                        <textarea class="k-onb-input k-onb-textarea text_pole" rows="3"
                            placeholder="A sentence or two the story should know about you. Optional."
                            .value=${this._pDesc}
                            @input=${(/** @type {Event} */ event) => { this._pDesc = /** @type {HTMLTextAreaElement} */ (event.target).value; }}></textarea>
                        <span class="k-onb-hint">Sent to the model with every message, so keep it to what matters.</span>
                    </label>
                </div>
            </div>
            ${this._trouble ? html`<p class="k-onb-status" role="alert" data-state="problem"><span class="k-onb-status-dot"></span>${this._trouble}</p>` : nothing}
            <p class="k-onb-note">${named
        ? 'This is the persona you are using now. Change anything here, or leave it as it is.'
        : 'This is your persona. You can make more, and switch between them, from the persona menu at the top.'}</p>`;
    }

    /** Her reaction to a name, once the field is left with one in it. */
    #greetByName() {
        const name = this._pName.trim();
        if (!name) return;
        this._line = line('personaNamed', { name });
        this.#lineSig = `personaNamed:${name}`;
    }

    // ── First card (O5) ─────────────────────────────────────────────────────────────────────

    /** @returns {string[]} The library's avatars, right now. */
    #avatars() {
        return characters.map(character => String(character?.avatar ?? ''));
    }

    /** Opens the step on whoever is already selected (a replay, or Back from Ready). */
    #enterCard() {
        this._tile = '';
        this._link = '';
        this._dropping = false;
        this.#dropStudioWatch()?.ear.stop();
        const current = this_chid !== undefined ? characters[Number(this_chid)] : null;
        this._landed = current?.avatar ? String(current.avatar) : '';
    }

    /**
     * Runs one of core's ways of bringing a card in and works out what it came to. Core's import
     * paths return nothing and report through toasts, so the toasts are listened to while it
     * runs (and still shown: they are core's, and "Character Created" is worth seeing).
     * @param {() => Promise<unknown>} work The import.
     * @returns {Promise<void>}
     */
    async #bringIn(work) {
        if (this._busy) return;
        const before = this.#avatars();
        const ear = this.#listenToToasts();
        this._busy = true;
        this._trouble = '';
        this.#saveFailed = false;
        try {
            await work();
        } catch (error) {
            ear.toasts.push({ level: 'error', title: '', message: error instanceof Error ? error.message : String(error) });
        } finally {
            ear.stop();
            this._busy = false;
        }
        await this.#settleCard(before, ear.toasts);
    }

    /**
     * Records every toast core raises until `stop()`. The toasts are still shown. The listener
     * lives in `shell/toast-ear.js` now, shared with the marketplace's preview sheet.
     * @returns {{toasts: import('./card-state.js').Toast[], stop: () => void}} The record and its off switch.
     */
    #listenToToasts() {
        return listenToToasts();
    }

    /**
     * Turns "before, after, and what core said" into the step's state.
     * @param {string[]} before The library's avatars before.
     * @param {import('./card-state.js').Toast[]} toasts Toasts raised in between.
     * @returns {Promise<void>}
     */
    async #settleCard(before, toasts) {
        const outcome = cardOutcome({ before, after: this.#avatars(), toasts });
        if (outcome.state === 'landed') {
            await this.#land(outcome.avatar);
        } else if (outcome.state === 'problem') {
            this.#saveFailed = true;
            this._trouble = outcome.text;
            this._line = line('cardFailed', { reason: outcome.text.replace(/[.!?…]+$/, '') });
            this.#lineSig = `cardFailed:${outcome.text}`;
        } else if (!this.#stillPicked()) {
            // Not a failure: the studio was closed, or the picker cancelled, with nobody made.
            this._trouble = 'No new card came in. Pick another way, or press "Skip this".';
        }
        // Otherwise someone picked earlier still is (browsing without bringing anyone home):
        // the step keeps saying who, instead of "no new card" (walkthrough F5).
    }

    /** @returns {boolean} Whether the card this step picked is still the one core has open. */
    #stillPicked() {
        if (!this._landed || this_chid === undefined) return false;
        return String(characters[Number(this_chid)]?.avatar ?? '') === this._landed;
    }

    /**
     * Selects a card, so its chat is open behind the sheet when the tour ends.
     * @param {string} avatar The card's avatar file.
     * @returns {Promise<void>}
     */
    async #land(avatar) {
        const find = () => characters.findIndex(character => character?.avatar === avatar);
        if (find() < 0) {
            this._trouble = 'That card is not in the library any more.';
            return;
        }
        this._busy = true;
        try {
            // Core will not switch characters while a chat is still saving. It says so with a
            // toast and returns, so wait the save out rather than be refused.
            for (let i = 0; i < 40 && isChatSaving; i += 1) await new Promise(resolve => setTimeout(resolve, 120));
            // Looked up again after the wait: the library can be rebuilt in between.
            const index = find();
            if (index < 0) throw new Error('they left the library while it was loading');
            if (String(this_chid) !== String(index)) await selectCharacterById(index);
            // "Is picked" is only said once core agrees. `selectCharacterById` has three quiet
            // ways of not selecting (a save in flight, a generation running, a missing card).
            if (String(this_chid) !== String(index)) throw new Error('Kotatsu was busy and did not switch to them');
            this._landed = avatar;
            this._trouble = '';
            this.#saveFailed = false;
            this._tile = '';
            this._line = line('cardLanded', { name: String(characters[index]?.name ?? 'They') });
            this.#lineSig = `cardLanded:${avatar}`;
        } catch (error) {
            this.#saveFailed = true;
            this._landed = '';
            this._trouble = `That card is in your library, but its chat would not open: ${error instanceof Error ? error.message : String(error)}. Try its tile again in a moment.`;
        } finally {
            this._busy = false;
        }
    }

    /**
     * @param {FileList|File[]|null|undefined} files Picked or dropped files.
     * @returns {void}
     */
    #importFiles(files) {
        const list = [...(files ?? [])];
        if (!list.length) return;
        void this.#bringIn(() => processDroppedFiles(list));
    }

    /** Hands the link field to core's importer. */
    #importLink() {
        const link = cleanLink(this._link);
        if (!link) {
            this._trouble = 'Paste a link to a card first.';
            /** @type {HTMLElement|null} */ (this.querySelector('#k-onb-card-link'))?.focus();
            return;
        }
        void this.#bringIn(() => importFromExternalUrl(link));
    }

    /**
     * Opens the card studio over the tour. The studio has no "done" event: the tour hides while
     * it is up, and `#studioClosed()` settles the step when it comes back.
     *
     * A closed studio is not a created card. The studio closes the instant it clicks core's
     * create button, while core is still posting the card and reloading the library, and core
     * emits nothing when a create finishes. The one honest sign that a create is in flight is the
     * form's own `submit`, so that is what is watched for while the studio is up.
     * @returns {Promise<void>}
     */
    async #makeOne() {
        this._trouble = '';
        this.#saveFailed = false;
        /** @type {StudioWatch} */
        const watch = {
            before: this.#avatars(),
            submitted: false,
            ear: this.#listenToToasts(),
            form: document.getElementById('form_create'),
            // A create with no name is refused by core, and the studio stays up for it.
            onSubmit: () => {
                const name = /** @type {HTMLInputElement|null} */ (document.getElementById('character_name_pole'))?.value ?? '';
                if (name.trim()) watch.submitted = true;
            },
        };
        watch.form?.addEventListener('submit', watch.onSubmit);
        this.#studio = watch;
        const studio = await openStudio('create');
        if (!studio) {
            this.#dropStudioWatch();
            this.#saveFailed = true;
            this._trouble = 'The card studio would not open.';
        }
    }

    /** @returns {StudioWatch|null} The studio watch, taken down and handed back. */
    #dropStudioWatch() {
        const watch = this.#studio;
        this.#studio = null;
        watch?.form?.removeEventListener('submit', watch.onSubmit);
        return watch;
    }

    /**
     * The fifth tile: opens the gallery on Browse Characters. The tour hides while the body
     * carries the gallery's browse class (the same mechanism as the studio) and comes back when
     * the class drops — on a card landing (below), or on the reader leaving the view by any
     * door: the switch, the gallery's close, a chat opening underneath.
     * @returns {Promise<void>}
     */
    async #browseCharacters() {
        this._trouble = '';
        this.#saveFailed = false;
        /** @type {BrowseWatch} */
        const watch = {
            before: this.#avatars(),
            ear: this.#listenToToasts(),
            // A card landed through the preview sheet: leave the view, which uncovers the tour,
            // whose uncover handler settles the step from before/after. The sheet's own "Open
            // chat" is not needed; `#land()` opens the chat behind the tour as every tile does.
            onImported: () => { void showLibraryView('cast'); },
        };
        document.addEventListener(MARKET_IMPORTED_EVENT, watch.onImported);
        this.#browse = watch;
        const shown = await showLibraryView('browse');
        if (!shown) {
            this.#dropBrowseWatch()?.ear.stop();
            this.#saveFailed = true;
            this._trouble = 'Browse Characters would not open.';
        }
    }

    /** @returns {BrowseWatch|null} The browse watch, taken down and handed back. */
    #dropBrowseWatch() {
        const watch = this.#browse;
        this.#browse = null;
        if (watch) document.removeEventListener(MARKET_IMPORTED_EVENT, watch.onImported);
        return watch;
    }

    /**
     * Browse Characters closed over the First card step: see whether it left anyone.
     * @returns {Promise<void>}
     */
    async #browseClosed() {
        const watch = this.#dropBrowseWatch();
        if (!watch) return;
        watch.ear.stop();
        await this.#settleCard(watch.before, watch.ear.toasts);
    }

    /**
     * The studio closed over the First card step. If a create was submitted, wait for the card to
     * reach the library (or for core to say why it will not); otherwise nobody was made.
     * @returns {Promise<void>}
     */
    async #studioClosed() {
        const watch = this.#dropStudioWatch();
        if (!watch) return;
        if (watch.submitted) {
            // Wait for core to FINISH, not for the card to appear. The new avatar shows up in
            // the library partway through core's create (inside its `getCharacters()`, before
            // the list is reprinted), and selecting it then races core's own tail. Core's last
            // act is a toast, success or error, in whatever language the UI is in; that is the
            // signal. If none comes, the library is still checked when the wait runs out.
            this._busy = true;
            const deadline = Date.now() + STUDIO_CREATE_WAIT_MS;
            while (Date.now() < deadline) {
                if (watch.ear.toasts.some(toast => toast.level === 'success' || toast.level === 'error')) break;
                await new Promise(resolve => setTimeout(resolve, 120));
            }
            this._busy = false;
        }
        watch.ear.stop();
        await this.#settleCard(watch.before, watch.ear.toasts);
    }

    /** @returns {unknown} The First card step: four ways in, then who was picked. */
    #renderCard() {
        const seeded = findSeeded(this.#avatars());
        const landed = this._landed ? characters.find(character => character?.avatar === this._landed) : null;
        const pressed = (/** @type {string} */ tile) => (this._tile === tile ? 'true' : 'false');
        return html`
            <div class="k-onb-tiles" role="group" aria-label="Ways to bring a character in">
                <label class="k-onb-tile${this._dropping ? ' is-dropping' : ''}" data-tile="file"
                    @dragover=${(/** @type {DragEvent} */ event) => { event.preventDefault(); this._dropping = true; }}
                    @dragleave=${() => { this._dropping = false; }}
                    @drop=${(/** @type {DragEvent} */ event) => { event.preventDefault(); event.stopPropagation(); this._dropping = false; this.#importFiles(event.dataTransfer?.files); }}>
                    <span class="k-onb-tile-title">${TILE_ICONS.file}Import a file</span>
                    <span class="k-onb-tile-blurb">A character card: PNG, JSON or CHARX. Drop it here, or click to pick one.</span>
                    <input type="file" class="k-onb-file" multiple accept=".png,.json,.charx,.byaf,.yaml,.yml" ?disabled=${this._busy}
                        @change=${(/** @type {Event} */ event) => { const input = /** @type {HTMLInputElement} */ (event.target); this.#importFiles(input.files); input.value = ''; }}>
                </label>
                <button type="button" class="k-onb-tile" data-tile="link" aria-expanded=${pressed('link')} ?disabled=${this._busy}
                    @click=${() => { this._tile = this._tile === 'link' ? '' : 'link'; this._trouble = ''; }}>
                    <span class="k-onb-tile-title">${TILE_ICONS.link}From a link</span>
                    <span class="k-onb-tile-blurb">Paste a card's page from Chub, JanitorAI, Pygmalion and the like.</span>
                </button>
                <button type="button" class="k-onb-tile" data-tile="browse" ?disabled=${this._busy} @click=${() => this.#browseCharacters()}>
                    <span class="k-onb-tile-title">${TILE_ICONS.browse}Browse Characters</span>
                    <span class="k-onb-tile-blurb">Look through a card site from here. Read a card, bring it home; I will be back when one lands.</span>
                </button>
                <button type="button" class="k-onb-tile" data-tile="studio" ?disabled=${this._busy} @click=${() => this.#makeOne()}>
                    <span class="k-onb-tile-title">${TILE_ICONS.studio}Make one from scratch</span>
                    <span class="k-onb-tile-blurb">Opens the card studio. I will be right here when you close it.</span>
                </button>
                ${seeded ? html`
                <button type="button" class="k-onb-tile" data-tile="seeded" ?disabled=${this._busy} @click=${() => this.#land(seeded)}>
                    <span class="k-onb-tile-title">${TILE_ICONS.seeded}Meet Seraphina</span>
                    <span class="k-onb-tile-blurb">She came with the house. Good for a first hello.</span>
                </button>` : nothing}
            </div>
            ${this._tile === 'link' ? html`
            <div class="k-onb-linkrow">
                <input id="k-onb-card-link" class="k-onb-input text_pole" type="url" inputmode="url" autocomplete="off" spellcheck="false"
                    aria-label="Link to a character card"
                    placeholder="https://…" .value=${this._link} ?disabled=${this._busy}
                    @input=${(/** @type {Event} */ event) => { this._link = /** @type {HTMLInputElement} */ (event.target).value; this._trouble = ''; }}
                    @keydown=${(/** @type {KeyboardEvent} */ event) => { if (event.key === 'Enter') { event.preventDefault(); this.#importLink(); } }}>
                <button type="button" class="k-onb-button" data-kind="ghost" ?disabled=${this._busy} @click=${() => this.#importLink()}>${this._busy ? 'Fetching' : 'Bring them in'}</button>
            </div>` : nothing}
            ${this._trouble ? html`<p class="k-onb-status" role="alert" data-state=${this.#saveFailed ? 'problem' : 'idle'}><span class="k-onb-status-dot"></span>${this._trouble}</p>`
        : landed ? html`
            <p class="k-onb-status k-onb-landed" role="status" data-state="connected">
                <img class="k-onb-landed-img" src=${getThumbnailUrl('avatar', String(landed.avatar))} alt="" draggable="false">
                <span><strong>${landed.name}</strong> is picked. Their chat is open behind me.</span>
            </p>` : nothing}
            <p class="k-onb-note">Cards live in your library. You can bring in more, or make more, any time.</p>`;
    }

    /** @returns {{names: string[], selected: string}} Chat Completion presets core knows, and the live one. */
    #presets() {
        const manager = getPresetManager('openai');
        if (!manager) return { names: [], selected: '' };
        const list = /** @type {any} */ (manager.getPresetList())?.preset_names;
        const names = Array.isArray(list) ? list : Object.keys(list ?? {});
        return { names, selected: String(manager.getSelectedPresetName() ?? '') };
    }

    /**
     * Selects a sauce through core's preset manager — the same select the dock drives.
     * @param {import('./sauce-state.js').Sauce} sauce Sauce.
     * @returns {void}
     */
    #pickSauce(sauce) {
        const manager = getPresetManager('openai');
        const value = manager?.findPreset(sauce.name);
        if (value === undefined || value === null) return;
        if (sauce.name !== this.#presets().selected) manager.selectPreset(value);
        this._line = line(/** @type {any} */ (sauce.line), { author: sauce.author });
        this.#lineSig = sauce.line;
    }

    /** @returns {KPromptList|null} The mounted prompt list, if the rails shell has one. */
    #promptList() {
        const list = /** @type {KPromptList|null} */ (document.querySelector('k-prompt-list'));
        return list && typeof list.radioGroups === 'function' ? list : null;
    }

    /**
     * A dial's live value.
     * @param {import('./sauce-state.js').DialId} dial Dial.
     * @returns {unknown} Value.
     */
    #dialValue(dial) {
        if (dial === 'effort') return getBridgeEffort();
        const settings = /** @type {Record<string, unknown>} */ (oai_settings ?? {});
        return dial === 'context' ? settings.openai_max_context
            : dial === 'reply' ? settings.openai_max_tokens
                : settings.temp_openai;
    }

    /**
     * Sets a dial through core's own control (value + `input`, the event core binds), or the
     * bridge's effort setter. Core clamps to the model's limits; the render reads back what took.
     * @param {import('./sauce-state.js').DialId} dial Dial.
     * @param {number|string} value Value.
     * @returns {void}
     */
    #setDial(dial, value) {
        if (dial === 'effort') {
            setBridgeEffort(String(value));
        } else {
            const id = dial === 'context' ? 'openai_max_context' : dial === 'reply' ? 'openai_max_tokens' : 'temp_openai';
            const element = document.getElementById(id);
            if (!(element instanceof HTMLInputElement)) return;
            element.value = String(value);
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        this.requestUpdate();
    }

    /** @returns {number} The live model's context ceiling: the bridge's model, else core's own slider. */
    #contextCeiling() {
        if (isOnBridge()) return bridgeContextCeiling(getBridgeModel());
        const max = Number(/** @type {HTMLInputElement|null} */ (document.getElementById('openai_max_context'))?.max);
        return Number.isFinite(max) && max > 0 ? max : Infinity;
    }

    /**
     * "by <author>", linking to where the author's work lives (a new tab; the tour stays put).
     * @param {import('./sauce-state.js').Sauce} sauce Sauce.
     * @returns {unknown} The credit line.
     */
    #renderCredit(sauce) {
        return html`<span class="k-onb-sauce-credit">${sauce.url
            ? html`by <a href=${sauce.url} target="_blank" rel="noopener noreferrer" aria-label=${`${sauce.title}, by ${sauce.author} (opens in a new tab)`}>${sauce.author}</a>`
            : html`by ${sauce.author}`}</span>`;
    }

    /**
     * Whether the chosen sauce has the mature-content module, and whether it is on. Read off the
     * LIVE order the prompt list writes to, never a copy.
     * @param {import('./sauce-state.js').Sauce|undefined} sauce The chosen sauce.
     * @returns {{present: boolean, enabled: boolean}} State; absent unless it is Kotatsu's own.
     */
    #matureState(sauce) {
        if (!sauce?.own) return { present: false, enabled: false };
        const manager = this.#promptList()?.manager;
        const order = manager?.activeCharacter ? manager.getPromptOrderForCharacter(manager.activeCharacter) : [];
        return promptState(order, MATURE_IDENTIFIER);
    }

    /**
     * Turns the mature-content module on or off through the prompt list's own batch write: the
     * same save and event a click on its row in the dock makes.
     * @param {boolean} on Target state.
     * @returns {void}
     */
    #setMature(on) {
        this.#promptList()?.setEnabled([MATURE_IDENTIFIER], on);
        this.requestUpdate();
    }

    /**
     * The Mature content switch, on Kotatsu Nabe's tile.
     * @param {boolean} enabled Whether the module is on right now.
     * @returns {unknown} The switch and its hint.
     */
    #renderMature(enabled) {
        return html`
            <div class="k-onb-mature">
                <button type="button" class="k-onb-switch" role="switch" id="k-onb-mature" aria-checked=${enabled ? 'true' : 'false'}
                    aria-describedby="k-onb-mature-hint" @click=${() => this.#setMature(!enabled)}>
                    <span class="k-onb-switch-track"><span class="k-onb-switch-knob"></span></span>
                    <span class="k-onb-switch-label">Mature content</span>
                </button>
                <span class="k-onb-hint" id="k-onb-mature-hint">Lets a story go to dark or sexual places when you take it there. Change it any time in the prompt dock.</span>
            </div>`;
    }

    /**
     * The regex scripts the active preset carries and whether core has them allowed. Core asks
     * once, in its own popup, when a preset with scripts is selected; the answer is not announced,
     * so the Sauce step re-reads it (see {@link #watchRegex}).
     * @returns {{total: number, allowed: boolean}} State.
     */
    #regexState() {
        const scripts = getScriptsByType(SCRIPT_TYPES.PRESET);
        return {
            // The ones that would run, the number core's own popup gives ("148 would run · 1
            // switched off inside it"): a script the author ships disabled stays out of the count.
            total: Array.isArray(scripts) ? scripts.filter(script => !script?.disabled).length : 0,
            allowed: isPresetScriptsAllowed(getCurrentPresetAPI(), getCurrentPresetName()),
        };
    }

    /** @returns {void} Starts or stops the regex watch to match the current step. */
    #watchRegex() {
        if (this.step === 'sauce' && !this.#regexTimer) {
            this.#regexTimer = setInterval(() => {
                const { total, allowed } = this.#regexState();
                this._regexSig = `${getCurrentPresetName()}:${total}:${allowed}`;
            }, 500);
        } else if (this.step !== 'sauce' && this.#regexTimer) {
            clearInterval(this.#regexTimer);
            this.#regexTimer = null;
        }
    }

    /**
     * Opens core's allow question for the selected preset again (the same one the prompt list's
     * regex chip opens), then re-reads the state.
     * @returns {Promise<void>}
     */
    async #reviewRegex() {
        const { reviewPresetRegexScripts } = await import('../../scripts/extensions/regex/index.js');
        await reviewPresetRegexScripts();
        this.requestUpdate();
    }

    /**
     * The tile's regex note, only on the chosen sauce and only when it carries scripts.
     * @returns {unknown} The note, or nothing.
     */
    #renderRegexNote() {
        const note = regexNote(this.#regexState().total, this.#regexState().allowed);
        if (!note) return nothing;
        return html`
            <div class="k-onb-regex" data-state=${note.state} data-regex-note>
                <span class="k-onb-hint">${note.text}</span>
                ${note.action ? html`<button type="button" class="k-onb-quiet" @click=${() => this.#reviewRegex()}>${note.action}</button>` : nothing}
            </div>`;
    }

    /** @returns {unknown} The Sauce step: sauce, play style, dials. */
    #renderSauce() {
        const { names, selected } = this.#presets();
        const sauces = availableSauces(names, this._credits ?? FALLBACK_MANIFEST);
        const mature = this.#matureState(sauces.find(sauce => sauce.name === selected));
        const groups = this.#promptList()?.radioGroups() ?? [];
        const group = modeGroup(groups);
        // The sauce's other seasonings (Narration, Tense, POV, Length, Guidelines in both shipped
        // sauces). Length is a prompt instruction, so it is the reply-length control that works on
        // the Claude Code bridge too.
        const seasonings = groups.filter(other => other !== group && other.options.length >= 2);
        const dials = dialsFor({ onBridge: isOnBridge(), mainApi: String(main_api ?? '') });
        const ceiling = this.#contextCeiling();
        return html`
            <div class="k-onb-sauce-head">
                <button type="button" class="k-onb-whatis" aria-haspopup="dialog" @click=${() => this.#explain(true)}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><path d="M6.4 6.2a1.7 1.7 0 0 1 3.3.5c0 1.1-1.7 1.4-1.7 2.5"/><path d="M8 11.4h.01"/></svg>
                    What are these?
                </button>
            </div>
            <div class="k-onb-sauces" role="group" aria-label="Sauce">
                ${sauces.map(sauce => html`
                    <div class="k-onb-sauce" data-selected=${sauce.name === selected ? 'true' : 'false'} data-own=${sauce.own ? 'true' : 'false'}>
                        <button type="button" class="k-onb-sauce-pick" aria-pressed=${sauce.name === selected ? 'true' : 'false'}
                            @click=${() => this.#pickSauce(sauce)}>
                            <span class="k-onb-sauce-title">${sauce.title}</span>
                            <span class="k-onb-sauce-blurb">${sauce.blurb}</span>
                        </button>
                        ${sauce.author && !sauce.own ? this.#renderCredit(sauce) : nothing}
                        ${sauce.name === selected && sauce.name !== 'Default' ? this.#renderRegexNote() : nothing}
                        ${sauce.name === selected && mature.present ? this.#renderMature(mature.enabled) : nothing}
                    </div>`)}
            </div>
            ${group ? html`
                <div class="k-onb-field">
                    <span class="k-onb-label" id="k-onb-mode-label">How do you like to play?</span>
                    <div class="k-onb-seg" role="group" aria-labelledby="k-onb-mode-label">
                        ${group.options.map(option => html`
                            <button type="button" class="k-onb-seg-option" aria-pressed=${option.enabled ? 'true' : 'false'}
                                aria-describedby="k-onb-mode-blurb"
                                @click=${() => this.#promptList()?.pickRadio(option.identifier)}>${optionLabel(group.label, option.label)}</button>`)}
                    </div>
                    ${this.#renderModeBlurb(group)}
                </div>` : nothing}
            ${seasonings.length ? html`
                <details class="k-onb-more">
                    <summary>More seasoning</summary>
                    <div class="k-onb-more-body">
                    ${seasonings.map(other => html`
                        <div class="k-onb-field">
                            <span class="k-onb-label" id=${`k-onb-season-${other.key}`}>${modeLabel(other.label)}</span>
                            <div class="k-onb-seg" role="group" aria-labelledby=${`k-onb-season-${other.key}`}>
                                ${other.options.map(option => html`
                                    <button type="button" class="k-onb-seg-option" aria-pressed=${option.enabled ? 'true' : 'false'}
                                        @click=${() => this.#promptList()?.pickRadio(option.identifier)}>${optionLabel(other.label, option.label)}</button>`)}
                            </div>
                        </div>`)}
                    </div>
                </details>` : nothing}
            ${dials.length ? dials.map((dial) => {
        const spec = DIALS[dial];
        const live = selectedOption(dial, this.#dialValue(dial));
        const capped = dial === 'context' && spec.options.some(option => Number(option.value) > ceiling);
        // "Default" is the bridge's own setting, and the topbar prints what that resolves to
        // ("Sonnet 5.5 · High"). Say the same thing here, so the two never seem to disagree.
        const resolved = dial === 'effort' && live === '' ? effortWord('', getHealth()?.settings?.reasoningEffort) : '';
        return html`
                <div class="k-onb-field">
                    <span class="k-onb-label" id=${`k-onb-dial-${dial}`}>${spec.title}</span>
                    <div class="k-onb-seg" role="group" aria-labelledby=${`k-onb-dial-${dial}`}>
                        ${spec.options.map(option => html`
                            <button type="button" class="k-onb-seg-option" aria-pressed=${option.value === live ? 'true' : 'false'}
                                ?disabled=${dial === 'context' && Number(option.value) > ceiling}
                                @click=${() => this.#setDial(dial, option.value)}>${option.label}</button>`)}
                    </div>
                    <span class="k-onb-hint">${spec.hint}${capped ? ` This model tops out at ${ceiling >= 1000000 ? `${ceiling / 1000000}M` : `${Math.round(ceiling / 1000)}k`}.` : ''}${resolved ? ` Default is Claude Code's own setting: ${resolved} right now.` : ''}</span>
                </div>`;
    }) : html`<p class="k-onb-note">This connection's knobs live in the preset dock; the tour leaves them to you.</p>`}
            <p class="k-onb-note">Everything else is in the preset dock in the right rail: Sauce, Dials, Rack. On a narrower screen the rail tucks itself away; the handle on the right edge brings it back.</p>`;
    }

    /**
     * What the selected play style means, in one line, under its buttons. Reads the option's own
     * prompt text through core's prompt manager when the sauce isn't ours (sauce-state.js
     * `optionBlurb`).
     * @param {{options: Array<{identifier: string, enabled: boolean}>}} group The mode group.
     * @returns {unknown}
     */
    #renderModeBlurb(group) {
        const chosen = group.options.find(option => option.enabled);
        if (!chosen) return nothing;
        const manager = this.#promptList()?.manager;
        const content = manager && typeof manager.getPromptById === 'function'
            ? String(manager.getPromptById(chosen.identifier)?.content ?? '')
            : '';
        const blurb = optionBlurb(chosen.identifier, content);
        return blurb ? html`<span class="k-onb-hint" id="k-onb-mode-blurb" aria-live="polite">${blurb}</span>` : nothing;
    }

    /**
     * Opens or closes "What are these?" on the Sauce step: Mikan-chan at her chalkboard, saying
     * what a preset is in four plain lines (decision 2026-10-03). Focus goes to its one button and
     * comes back to the link.
     * @param {boolean} open
     * @returns {Promise<void>}
     */
    async #explain(open) {
        this._explain = open;
        await this.updateComplete;
        const target = open ? '.k-onb-explain [data-explain-close]' : '.k-onb-whatis';
        /** @type {HTMLElement|null} */ (this.querySelector(target))?.focus();
    }

    /** @returns {unknown} The chalkboard window. Her lines follow onboarding-v0 §6. */
    #renderExplain() {
        return html`
            <div class="k-onb-explain-scrim" @click=${() => this.#explain(false)}></div>
            <section class="k-onb-explain" role="dialog" aria-modal="true" aria-labelledby="k-onb-explain-title">
                <img class="k-onb-explain-art" src="kotatsu/brand/mascot/teach.webp" alt="Mikan-chan at a little chalkboard, pointing at a chalk drawing of a steaming pot" draggable="false">
                <div class="k-onb-explain-body">
                    <span class="k-onb-speaker">Mikan-chan</span>
                    <h3 id="k-onb-explain-title" class="k-onb-explain-title">So, what's a sauce?</h3>
                    <p>A sauce is what we call a preset: the recipe the model reads before every reply. Voice, pacing, how long to write, what to keep in mind.</p>
                    <p>Your character is who you're talking to. The sauce is how the story gets told. Same character, different sauce, different evening.</p>
                    <p>Nabe is ours, light on purpose so your writing leads. Sola and Vivarium are bigger engines, made by their authors and shipped with their blessing.</p>
                    <p>Taste one now and switch any time from the preset dock. Your chats stay exactly as they are.</p>
                    <button type="button" class="k-onb-button" data-kind="primary" data-explain-close @click=${() => this.#explain(false)}>Got it</button>
                </div>
            </section>`;
    }

    /** @returns {void} Opens the Connection tab over the tour (the tour hides while it is up). */
    #openConnectionTab() {
        document.dispatchEvent(new CustomEvent('k-open-settings', { bubbles: true, composed: true, detail: { tab: 'connection' } }));
    }

    /** @param {Map<string, unknown>} changed Changed properties. */
    updated(changed) {
        // A new step (or uncovering) puts focus on its primary action, so keyboard users land
        // where the next press belongs instead of on whatever the last step left focused.
        if ((changed.has('step') || (changed.has('covered') && changed.get('covered'))) && !this.covered) {
            // Persona opens on its name field: typing a name is the step.
            const target = this.step === 'persona' ? '#k-onb-persona-name' : '[data-k-onb-primary]';
            /** @type {HTMLElement|null} */ (this.querySelector(target))?.focus({ preventScroll: true });
        }
        // The card studio, or Browse Characters, just closed over the First card step: see
        // whether it left anyone.
        if (changed.has('covered') && changed.get('covered') && !this.covered) {
            if (this.#studio) void this.#studioClosed();
            if (this.#browse) void this.#browseClosed();
        }
        this.#checkOverflow();
        this.#watchRegex();
    }

    /**
     * Whether the step's body has more below what is showing. The body is the sheet's one
     * scroller and its scrollbar is easy to miss (0px wide on a phone), so a step that runs past
     * the fold says so with a fade at its bottom edge (onboarding.css `[data-more]`). Found on
     * Sauce: opening "More seasoning" pushed Context and Effort out of sight with no cue.
     * @returns {void}
     */
    #checkOverflow() {
        const body = this.querySelector('.k-onb-body');
        if (!(body instanceof HTMLElement)) return;
        const more = body.scrollHeight - body.scrollTop - body.clientHeight > 4;
        if (more !== this._more) this._more = more;
    }

    /**
     * Moves to `step`.
     * @param {Step|null} step Destination; null past the last step finishes the tour.
     * @returns {void}
     */
    go(step) {
        if (step === null) {
            // "Start writing" means it: with someone picked, their chat is already open behind
            // the sheet (First card selected them), so the cursor goes to the composer. The close
            // hands focus back to whatever opened the tour first, which is why this runs after.
            const write = this.step === 'ready' && this.#readySummary().canWrite;
            this.#finish(FLAG_DONE);
            if (write) /** @type {HTMLElement|null} */ (document.getElementById('send_textarea'))?.focus();
            return;
        }
        this.step = step;
    }

    /**
     * Ends the tour: writes the flag, then closes. The one close path.
     * @param {string} flag `done` or `skipped`.
     * @returns {void}
     */
    #finish(flag) {
        power_user.kotatsu_onboarding = flag;
        saveSettingsDebounced();
        this.remove();
    }

    /**
     * Escape ends the tour (it is skippable everywhere, and Settings → System replays it); Tab
     * stays inside the sheet. Both stand aside while settings or the studio covers the tour.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleKeydown(event) {
        if (this.covered || event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            // The chalkboard closes first; a second Escape still ends the tour.
            if (this._explain) {
                void this.#explain(false);
                return;
            }
            this.#finish(FLAG_SKIPPED);
            return;
        }
        if (this._explain && event.key === 'Tab') {
            // Focus stays inside the chalkboard while it is up: it has one button.
            event.preventDefault();
            /** @type {HTMLElement|null} */ (this.querySelector('.k-onb-explain [data-explain-close]'))?.focus();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = /** @type {HTMLElement[]} */ ([...this.querySelectorAll('.k-onb-sheet :is(button, select, input, textarea, a[href]):not([disabled])')]);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && this.contains(active);
        if (event.shiftKey && (active === first || !inside)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !inside)) {
            event.preventDefault();
            first.focus();
        }
    }

    /**
     * Hands a language pick to core's own select, which stores it and reloads. The tour's flag
     * is flushed for real first, so the reload comes back to this step.
     * @param {Event} event Change event from the tour's select.
     * @returns {Promise<void>}
     */
    async #chooseLanguage(event) {
        const value = /** @type {HTMLSelectElement} */ (event.target).value;
        const core = document.getElementById('ui_language_select');
        if (!(core instanceof HTMLSelectElement) || core.value === value) return;
        this._reloading = true;
        power_user.kotatsu_onboarding = flagFor(this.step);
        await saveSettings();
        core.value = value;
        core.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /** @returns {unknown} The language row, or nothing when core has no languages loaded. */
    #renderLanguage() {
        const core = document.getElementById('ui_language_select');
        if (!(core instanceof HTMLSelectElement) || core.options.length < 2) return nothing;
        return html`
            <label class="k-onb-field">
                <span class="k-onb-label">Language</span>
                <select class="k-onb-select" ?disabled=${this._reloading} @change=${(event) => this.#chooseLanguage(event)}>
                    ${[...core.options].map(option => html`
                        <option value=${option.value} ?selected=${option.value === core.value}>${option.textContent}</option>`)}
                </select>
                <span class="k-onb-hint">Changing it reloads the page; the tour picks up right here.</span>
            </label>`;
    }

    /** @returns {unknown} The current step's body. */
    #renderBody() {
        if (this.step === 'welcome') {
            return html`
                <ol class="k-onb-plan">
                    ${PLAN.map(([step, text], index) => html`
                        <li data-k-onb-plan=${step}><span class="k-onb-plan-n">${index + 1}</span>${text}</li>`)}
                </ol>
                <p class="k-onb-note">Every step can be skipped, and you can take the tour again any time from Settings → System.</p>
                ${this.#renderLanguage()}`;
        }
        if (this.step === 'connect') return this.#renderConnect();
        if (this.step === 'sauce') return this.#renderSauce();
        if (this.step === 'persona') return this.#renderPersona();
        if (this.step === 'card') return this.#renderCard();
        return this.#renderReady();
    }

    // ── Ready (O6) ──────────────────────────────────────────────────────────────────────────

    /** @returns {import('./ready-state.js').ReadySummary} What is set, read live. */
    #readySummary() {
        const connected = this.#connectReading().state === 'connected';
        const { names, selected } = this.#presets();
        const sauce = availableSauces(names, this._credits ?? FALLBACK_MANIFEST).find(entry => entry.name === selected);
        const style = modeGroup(this.#promptList()?.radioGroups() ?? [])?.options.find(option => option.enabled);
        const persona = this.#personaNow();
        const card = this_chid !== undefined ? characters[Number(this_chid)] : null;
        return readySummary({
            connection: {
                connected,
                label: connected ? this.#connectedLabel() : '',
                // The same word the topbar prints, so the tour never names a third effort.
                effort: connected && isOnBridge() ? effortWord(getBridgeEffort(), getHealth()?.settings?.reasoningEffort) : '',
            },
            sauce: (() => {
                const mature = this.#matureState(sauce);
                return { name: sauce?.title ?? selected, style: style ? modeLabel(style.label) : '', mature: mature.present ? mature.enabled : null };
            })(),
            persona: { name: persona.name, named: isNamed(persona) },
            card: { name: card?.name ? String(card.name) : '' },
        });
    }

    /** @returns {unknown} The Ready step: what is set, each row one press from its step. */
    #renderReady() {
        const summary = this.#readySummary();
        return html`
            <dl class="k-onb-summary">
                ${summary.rows.map(row => html`
                    <div class="k-onb-summary-row" data-set=${row.set ? 'true' : 'false'} data-row=${row.step}>
                        <dt>${row.label}</dt>
                        <dd>${row.value}</dd>
                        <button type="button" class="k-onb-quiet k-onb-summary-change"
                            aria-label=${`${row.set ? 'Change' : 'Set up'}: ${row.label.toLowerCase()}`}
                            @click=${() => this.go(row.step)}>${row.set ? 'Change' : 'Set it up'}</button>
                    </div>`)}
            </dl>
            ${summary.note ? html`<p class="k-onb-note">${summary.note}</p>` : nothing}
            <p class="k-onb-note">You can take this tour again any time from Settings → System.</p>`;
    }

    /** @returns {unknown} The Connect step: lane switch, the lane, and a status line. */
    #renderConnect() {
        const reading = this.#connectReading();
        return html`
            <div class="k-onb-lanes" role="group" aria-label="How to connect">
                ${LANES.map(lane => html`
                    <button type="button" class="k-onb-lane" aria-pressed=${lane === this._lane ? 'true' : 'false'}
                        @click=${() => { this._lane = lane; this._failed = ''; }}>${LANE_LABELS[lane]}</button>`)}
            </div>
            <div class="k-onb-lane-panel" data-lane=${this._lane}>
                ${this._lane === 'claude' ? html`
                    <k-bridge-card variant="compact"></k-bridge-card>
                    <k-chatgpt-card variant="compact"></k-chatgpt-card>`
        : this._lane === 'keys' ? html`<k-provider-cards variant="grid"></k-provider-cards>`
            : html`
                    <p class="k-onb-note">NanoGPT, Mistral, a local model, a custom endpoint, a saved connection: everything else lives in the Connection tab. I'll wait here and check when you come back.</p>
                    <button type="button" class="k-onb-button" data-kind="ghost" @click=${() => this.#openConnectionTab()}>Open the Connection tab</button>`}
            </div>
            <p class="k-onb-status" role="status" data-state=${reading.state === 'absent' ? 'idle' : reading.state}>
                <span class="k-onb-status-dot"></span>${reading.state === 'connected' ? `Connected: ${reading.text}`
        : reading.state === 'problem' ? reading.text : 'Not connected yet'}
            </p>`;
    }

    render() {
        const step = /** @type {Step} */ (this.step);
        // She only looks worried when something actually failed: a connection, or a save.
        const failed = (step === 'connect' && this.#connectReading().state === 'problem')
            || ((step === 'persona' || step === 'card') && this.#saveFailed && this._trouble !== '');
        const pose = failed ? 'oops' : STEP_POSES[step];
        const { index, total } = progress(step);
        const back = previousStep(step);
        const primaryLabel = step === 'welcome' ? 'Let\'s go' : step === 'ready' ? this.#readySummary().primary : 'Next';
        return html`
            <div class="k-onb-scrim"></div>
            <section class="k-onb-sheet" role="dialog" aria-modal="true" aria-labelledby="k-onb-title" data-step=${step}>
                <figure class="k-onb-mascot">
                    <picture>
                        <source media="(max-width: 640px)" srcset=${`kotatsu/brand/mascot/${pose}-bust.webp`}>
                        <img src=${`kotatsu/brand/mascot/${pose}.webp`} alt="" draggable="false">
                    </picture>
                </figure>
                <div class="k-onb-main">
                    <header class="k-onb-head">
                        <h2 id="k-onb-title" class="k-onb-title">${STEP_TITLES[step]}</h2>
                        ${step === 'ready' ? nothing : html`
                            <button type="button" class="k-onb-quiet" @click=${() => this.#finish(FLAG_SKIPPED)}>I know my way around</button>`}
                    </header>
                    <p class="k-onb-bubble" aria-live="polite"><span class="k-onb-speaker">Mikan-chan</span>${this._line}</p>
                    <div class="k-onb-body" ?data-more=${this._more}
                        @scroll=${() => this.#checkOverflow()}
                        @toggle=${{ handleEvent: () => this.#checkOverflow(), capture: true }}>${this.#renderBody()}</div>
                    <footer class="k-onb-foot">
                        <div class="k-onb-dots" role="img" aria-label=${`Step ${index + 1} of ${total}`}>
                            ${STEPS.map((_, dot) => html`<span class="k-onb-dot" data-state=${dot < index ? 'past' : dot === index ? 'now' : 'next'}></span>`)}
                        </div>
                        <div class="k-onb-actions">
                            ${back ? html`<button type="button" class="k-onb-button" data-kind="ghost" @click=${() => this.go(back)}>Back</button>` : nothing}
                            ${step === 'welcome' || step === 'ready' ? nothing : html`
                                <button type="button" class="k-onb-button" data-kind="ghost" ?disabled=${this._busy}
                                    @click=${() => this.#advance({ skip: true })}>Skip this</button>`}
                            <button type="button" class="k-onb-button" data-kind="primary" data-k-onb-primary
                                ?disabled=${this._reloading || this._busy}
                                @click=${() => this.#advance()}>${this._busy ? 'Saving' : primaryLabel}</button>
                        </div>
                    </footer>
                </div>
                ${step === 'sauce' && this._explain ? this.#renderExplain() : nothing}
            </section>`;
    }
}

customElements.define('k-onboarding', KOnboarding);

/**
 * Opens the tour (or moves an open one), on a rails layout only.
 * @param {{step?: Step, replay?: boolean}} [options] Where to start; `replay` greets accordingly.
 * @returns {KOnboarding|null} The tour, or null under classic.
 */
export function openTour({ step = STEPS[0], replay = false } = {}) {
    if (!railsActive()) {
        console.warn('[k-onboarding] the welcome tour is a rails surface; classic keeps the stock first-run popup.');
        return null;
    }
    const existing = currentTour();
    if (existing) {
        existing.go(step);
        return existing;
    }
    const tour = /** @type {KOnboarding} */ (document.createElement('k-onboarding'));
    tour.setAttribute('variant', 'sheet');
    if (replay) tour.greet(line('replay'));
    tour.step = step;
    document.body.appendChild(tour);
    return tour;
}

/** @returns {boolean} Whether the tour is up. */
export function isTourOpen() {
    return currentTour() !== null;
}

/**
 * Registration at the shell seam: open at APP_READY when the flag says so, and answer the replay
 * door. Core's first-run gate (script.js `getSettings()`) is what writes `pending`.
 * @returns {void}
 */
export function installOnboarding() {
    window.addEventListener(OPEN_TOUR_EVENT, () => openTour({ replay: true }));
    eventSource.on(event_types.APP_READY, () => {
        const { open, step } = tourState(power_user.kotatsu_onboarding);
        if (open) openTour({ step });
    });
}
