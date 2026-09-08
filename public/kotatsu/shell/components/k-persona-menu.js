/*
 * <k-persona-menu> — the left rail's persona switcher chip (rails v0 follow-up
 * to slice B/E, design language borrowed wholesale from `<k-model-menu>`).
 *
 * A circle-portrait chip pinned to the bottom of the left rail. Click it and a
 * popover lists every persona core knows, current one marked, click one to
 * switch. Exactly the two jobs `<k-model-menu>` does for connection/model, done
 * here for personas — same trigger-plus-popover shape, same footer-escape-hatch
 * idiom, same doctrine:
 *
 * MIRRORS, NEVER A SECOND SOURCE OF TRUTH.
 *
 *   - The current persona is `user_avatar` (`scripts/personas.js:108`, a live
 *     `export let`) — read directly, never cached across a render.
 *   - The persona list is `power_user.personas` (`scripts/power-user.js:286`),
 *     an avatarId → display name map. It is core's own object, not fetched: by
 *     boot it already holds every avatar file on disk, because `script.js:805`
 *     runs `getUserAvatars(true, user_avatar)` during startup, and that call's
 *     `addMissingPersonas()` (`scripts/personas.js:261-267`) backfills an entry
 *     for anything missing one. So this menu never calls `/api/avatars/get`
 *     itself — the mirror is already warm by the time anything can click it.
 *   - Switching goes THROUGH `setUserAvatar(id)` (`scripts/personas.js:154`) —
 *     not a DOM click on a hidden grid item, because there is a real exported
 *     function to call, and it is the EXACT one the classic persona grid's own
 *     click handler calls (`scripts/personas.js:2972-2975`:
 *     `$(document).on('click', '#user_avatar_block .avatar-container', …
 *     setUserAvatar(imgfile))`). Calling it directly reaches the same
 *     persistence, the same `PERSONA_CHANGED` emit, the same first-message
 *     retrigger — nothing here reimplements any of it.
 *   - Portraits use `getThumbnailUrl('persona', id)` (`script.js:7868`), the
 *     same helper `k-rail-left.js` uses for character art and personas.js uses
 *     for its own grid (`scripts/personas.js:243`) and message avatars
 *     (`scripts/personas.js:177`). A failed thumbnail falls back to an inline
 *     glyph once and stays there for the session — never a broken `<img>`,
 *     same contract as `k-rail-left.js`'s `#thumbFailed` (`k-rail-left.js:456-462`).
 *   - The footer opens the settings modal on its Personas tab
 *     (`openSettings({ tab: 'personas' })`), imported exactly the way
 *     `k-model-menu.js` imports it. `k-settings-modal.js`'s own `openSettings()`
 *     doc names `k-model-menu` as one of two current callers and predicts "a
 *     third will want it tomorrow" (`k-settings-modal.js:1404-1406`) — this is it.
 *
 * Everything degrades by absence: an empty persona map renders one quiet line,
 * never a crash; a broken portrait falls back to the glyph, never a broken
 * image icon; `REFRESH_EVENTS` are looked up by key so an upstream rename of an
 * `event_types` entry degrades to one dead listener, not a boot failure.
 *
 * Mount point: `k-rail-left.js` grew a minimal `.k-rl-footer` slot below its
 * existing scrollable content (`.k-rl-scroll`, wrapping the three sections that
 * used to be the component's whole render output) and mounts this element
 * there via a side-effect import, the same pattern `k-topbar.js` uses for
 * `<k-model-menu>`. See `k-rail-left.js`'s header for why the footer had to be
 * a real DOM change rather than pure CSS: the rail's `overflow-y: auto` used to
 * live on the component host itself, which would have scrolled a bottom-pinned
 * chip away with the rest of the content.
 *
 * Light DOM, and for the same three reasons `<k-model-menu>` gives:
 * `css/shell-left.css` (this component's owning sheet — it lives inside
 * `<k-rail-left>`, so it follows that file's ownership boundary rather than
 * `css/shell-topbar.css`'s) reaches in, the `body[data-k-layout="rails"]` gate
 * holds, and `initDynamicStyles()` (dynamic-styles.js:188-202) can audit the
 * hover/focus-visible pairs.
 *
 * One-way imports: kotatsu → core only.
 */

import { LitElement, html, nothing } from '../lit.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { setUserAvatar, user_avatar } from '../../../scripts/personas.js';
import { power_user } from '../../../scripts/power-user.js';
import { getThumbnailUrl } from '../../../script.js';
import { openSettings } from '../../settings/k-settings-modal.js';

/** The popover's DOM id, for `aria-controls`. */
const POP_ID = 'k-persona-menu-pop';

/**
 * Events that mean "the persona set or the active persona may have moved".
 * Looked up by key and skipped when absent, so an upstream rename degrades to
 * one dead listener instead of a boot crash — the same contract
 * `k-model-menu.js`'s `REFRESH_EVENTS` keeps.
 */
const REFRESH_EVENTS = [
    'APP_READY',
    'SETTINGS_LOADED_AFTER',
    'SETTINGS_UPDATED',
    'PERSONA_CHANGED',
    'PERSONA_CREATED',
    'PERSONA_UPDATED',
    'PERSONA_RENAMED',
    'PERSONA_DELETED',
];

/**
 * @returns {unknown} Check glyph — selection marker. Same path as
 * `k-model-menu.js`'s `checkIcon()`, so "you are here" draws identically on
 * both surfaces.
 */
function checkIcon() {
    return html`
        <svg class="k-pm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <path d="M2.8 8.6 6.3 12l6.9-8"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Chevron glyph — the footer's trailing arrow. Same path as
 * `k-model-menu.js`'s `chevronIcon()`.
 */
function chevronIcon() {
    return html`
        <svg class="k-pm__glyph k-pm__glyph--chevron" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m6 3 5 5-5 5"></path>
        </svg>
    `;
}

/**
 * @returns {unknown} Head-and-shoulders glyph — the portrait fallback and the
 * footer's leading icon. Same path as the settings modal's own Personas tab
 * icon (`k-settings-modal.js` `TAB_ICONS.personas`), so the glyph that stands
 * in for a persona here is the same one that marks the tab it opens into.
 */
function personIcon() {
    return html`
        <svg class="k-pm__glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="8" cy="5.3" r="2.4"></circle>
            <path d="M2.6 13.5c0-3.1 2.4-5.3 5.4-5.3s5.4 2.2 5.4 5.3"></path>
        </svg>
    `;
}

/**
 * The persona chip and its picker popover.
 */
export class KPersonaMenu extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _currentId: { state: true },
        _open: { state: true },
    };

    /**
     * Avatar ids whose thumbnail request failed, so a row falls back to the
     * glyph once and stays there — session-lived, same contract as
     * `k-rail-left.js`'s `#thumbFailed`.
     * @type {Set<string>}
     */
    #thumbFailed = new Set();

    constructor() {
        super();
        /** @type {string} Theme-pack variant hook (SPEC §13). v0 ships one: `chip` — a
         * portrait+name trigger with a popover, naming this component's own interaction
         * shape the way `k-model-menu`'s `popover` names its. */
        this.variant = 'chip';
        /** @type {string} `user_avatar` as of the last refresh. */
        this._currentId = '';
        /** @type {boolean} Whether the popover is up. */
        this._open = false;
        /** @type {() => void} */
        this._onCoreChange = () => this.refresh();
        /** @type {(event: PointerEvent) => void} */
        this._onOutsidePointer = (event) => {
            if (this._open && event.target instanceof Node && !this.contains(event.target)) {
                this._close({ restoreFocus: false });
            }
        };
        /** @type {string[]} Event names actually bound, for symmetric teardown. */
        this._boundEvents = [];
    }

    /**
     * Light DOM — see the file header.
     * @returns {*} This element, used as the render root.
     */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        for (const key of REFRESH_EVENTS) {
            const name = event_types ? event_types[key] : undefined;
            if (typeof name !== 'string' || this._boundEvents.includes(name)) {
                continue;
            }
            eventSource.on(name, this._onCoreChange);
            this._boundEvents.push(name);
        }
        document.addEventListener('pointerdown', this._onOutsidePointer);
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this._boundEvents) {
            eventSource.removeListener(name, this._onCoreChange);
        }
        this._boundEvents = [];
        document.removeEventListener('pointerdown', this._onOutsidePointer);
        super.disconnectedCallback();
    }

    /**
     * Re-reads the active persona from core. Never throws — same contract as
     * the rail it lives in.
     */
    refresh() {
        this._currentId = typeof user_avatar === 'string' ? user_avatar : '';
        this.requestUpdate();
    }

    /**
     * The personas core knows, alphabetically by display name (falling back to
     * the avatar id for one with none — `power_user.personas[id]` is only
     * populated with a real name once `initPersona()` has run, but
     * `addMissingPersonas()` guarantees the KEY exists first).
     * @returns {Array<{ id: string, name: string }>}
     */
    get _personas() {
        const map = power_user?.personas;
        if (!map || typeof map !== 'object') {
            return [];
        }
        return Object.keys(map)
            .filter((id) => typeof id === 'string' && id)
            .map((id) => ({ id, name: typeof map[id] === 'string' && map[id] ? map[id] : id }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /**
     * @returns {string} The active persona's display name, the id itself when
     * unnamed, or '' when no persona is selected at all.
     */
    get _currentName() {
        const id = this._currentId;
        if (!id) {
            return '';
        }
        const map = power_user?.personas;
        const name = map && typeof map === 'object' ? map[id] : undefined;
        return typeof name === 'string' && name ? name : id;
    }

    /**
     * Opens or closes the popover from the chip.
     * @returns {void}
     */
    _toggle() {
        if (this._open) {
            this._close({ restoreFocus: true });
        } else {
            this._open = true;
        }
    }

    /**
     * @param {{ restoreFocus: boolean }} options Whether the chip takes focus back.
     * @returns {void}
     */
    _close({ restoreFocus }) {
        if (!this._open) {
            return;
        }
        const active = document.activeElement;
        const focusWasInside = active instanceof HTMLElement && this.contains(active);
        this._open = false;
        if (restoreFocus || focusWasInside) {
            const chip = this.querySelector('.k-pm__trigger');
            if (chip instanceof HTMLElement) {
                chip.focus({ preventScroll: true });
            }
        }
    }

    /**
     * Escape closes the popover before core's document-level cascade can read
     * the key as meaning anything else; every other key passes through.
     * @param {KeyboardEvent} event
     * @returns {void}
     */
    _onKeyDown(event) {
        if (event.key !== 'Escape' || !this._open) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this._close({ restoreFocus: true });
    }

    /**
     * Switches the active persona through `setUserAvatar()` — see the file
     * header for why this is a direct call rather than a DOM-driven mirror.
     * @param {string} id Persona avatar id.
     * @returns {Promise<void>}
     */
    async _onSelectPersona(id) {
        if (!id || id === this._currentId) {
            this._close({ restoreFocus: true });
            return;
        }
        this._close({ restoreFocus: false });
        try {
            await setUserAvatar(id);
        } catch (error) {
            console.error('[k-persona-menu] persona switch failed', error);
        }
        // PERSONA_CHANGED — emitted at the end of a successful setUserAvatar()
        // — already reaches `_onCoreChange` and calls refresh(); this covers a
        // throw before that emit or a listener race, the same belt-and-suspenders
        // `k-model-menu.js`'s `_applyModel()` keeps after its own commitSelect().
        this.refresh();
    }

    /**
     * The escape hatch: the settings modal, on its Personas tab. Same one-call
     * shape as `k-model-menu.js`'s `_openWizard()`.
     * @returns {void}
     */
    _openPersonaSettings() {
        this._close({ restoreFocus: false });
        openSettings({ tab: 'personas' });
    }

    /**
     * A persona's circle portrait, or the fallback glyph once its thumbnail has
     * failed once — never a broken `<img>`.
     * @param {string} id Persona avatar id.
     * @param {string} sizeClass Modifier class for sizing context (trigger vs row).
     * @returns {unknown}
     */
    _portrait(id, sizeClass) {
        if (!id || this.#thumbFailed.has(id)) {
            return html`<span class="k-pm__portrait ${sizeClass}" aria-hidden="true">${personIcon()}</span>`;
        }
        return html`
            <img class="k-pm__portrait ${sizeClass}" aria-hidden="true" alt=""
                loading="lazy" src=${getThumbnailUrl('persona', id)}
                @error=${() => { this.#thumbFailed.add(id); this.requestUpdate(); }}>
        `;
    }

    render() {
        const name = this._currentName || 'No persona selected';
        return html`
            <button type="button" class="k-pm__trigger" title=${name}
                aria-haspopup="true" aria-expanded=${this._open ? 'true' : 'false'}
                aria-controls="${POP_ID}"
                @click=${() => this._toggle()} @keydown=${this._onKeyDown}>
                ${this._portrait(this._currentId, 'k-pm__portrait--trigger')}
                <span class="k-pm__name">${name}</span>
            </button>
            ${this._open ? this._renderPopover() : nothing}
        `;
    }

    /**
     * @returns {unknown} The popover.
     */
    _renderPopover() {
        const personas = this._personas;
        const currentId = this._currentId;
        return html`
            <div id="${POP_ID}" class="k-pm__pop" role="group" aria-label="Personas"
                @keydown=${this._onKeyDown}>
                <div class="k-pm__label">Personas</div>
                ${personas.length === 0 ? html`
                    <div class="k-pm__empty">No personas yet.</div>
                ` : html`
                    <div class="k-pm__list">
                        ${personas.map((persona) => {
        const selected = persona.id === currentId;
        return html`
                            <button type="button" class="k-pm__row ${selected ? 'k-pm--selected' : ''}"
                                aria-pressed=${selected ? 'true' : 'false'}
                                @click=${() => this._onSelectPersona(persona.id)}>
                                ${this._portrait(persona.id, 'k-pm__portrait--row')}
                                <span class="k-pm__copy">
                                    <span class="k-pm__name">${persona.name}</span>
                                </span>
                                ${selected ? html`<span class="k-pm__mark">${checkIcon()}</span>` : nothing}
                            </button>`;
    })}
                    </div>
                `}
                <div class="k-pm__divider" role="presentation"></div>
                <button type="button" class="k-pm__foot" @click=${() => this._openPersonaSettings()}>
                    ${personIcon()}
                    <span class="k-pm__foot-label">Persona settings…</span>
                    ${chevronIcon()}
                </button>
            </div>
        `;
    }
}

if (!customElements.get('k-persona-menu')) {
    customElements.define('k-persona-menu', KPersonaMenu);
}
