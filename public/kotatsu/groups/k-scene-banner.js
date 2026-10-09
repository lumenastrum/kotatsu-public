/**
 * `<k-scene-banner>` — the scene, pinned at the top of a scene's chat (`docs/group-chat-v0.md`
 * G7, board A).
 *
 * The text is the open chat's `chat_metadata.scenario` — the per-chat override every member
 * reads instead of their own card's scenario (core's `setCharacterSettingsOverrides`,
 * `script.js:9463`). The banner shows it, folds it to one line, and edits it in place with a real
 * Save and Cancel (core's popup committed on any close until S9). The popup still owns the other
 * two overrides (example dialogue, main prompt); "More overrides…" opens it.
 *
 * Mounted once by the rails layout right after `<k-chat-header>`; draws nothing outside a scene.
 * Light DOM, `variant="card"`; rules in css/scenes.css §8. The fold is a `power_user` key
 * (`kotatsu_scene_banner`: 'open' | 'closed').
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { chat_metadata, saveMetadata, saveSettingsDebounced, setCharacterSettingsOverrides } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import { openScene } from './stage-actions.js';

const EVENTS = ['APP_READY', 'CHAT_CHANGED', 'GROUP_UPDATED'];

const icons = {
    fold: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4 10 4-4 4 4"/></svg>`,
    unfold: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4 6 4 4 4-4"/></svg>`,
    edit: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.5 3.5 12.5 5.5 6 12H4v-2z"/></svg>`,
    plus: html`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10"/></svg>`,
};

export class KSceneBanner extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _text: { state: true },
        _editing: { state: true },
        _draft: { state: true },
        _open: { state: true },
        _inScene: { state: true },
        _busy: { state: true },
    };

    /** @type {string[]} */
    #bound = [];

    #onCore = () => this.refresh();

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'card';
        /** @type {string} */
        this._text = '';
        /** @type {boolean} */
        this._editing = false;
        /** @type {string} */
        this._draft = '';
        /** @type {boolean} */
        this._open = true;
        /** @type {boolean} */
        this._inScene = false;
        /** @type {boolean} */
        this._busy = false;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        for (const key of EVENTS) {
            const name = event_types[key];
            if (typeof name === 'string') {
                eventSource.on(name, this.#onCore);
                this.#bound.push(name);
            }
        }
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this.#bound) eventSource.removeListener(name, this.#onCore);
        this.#bound = [];
        super.disconnectedCallback();
    }

    /** Re-reads the open chat's scene. A chat switch drops an unsaved edit (it belonged to the old chat). */
    refresh() {
        const inScene = Boolean(openScene());
        const text = inScene ? String(chat_metadata?.scenario ?? '') : '';
        if (!inScene || text !== this._text) this._editing = false;
        this._inScene = inScene;
        this._text = text;
        this._open = power_user.kotatsu_scene_banner !== 'closed';
        this.hidden = !inScene;
    }

    #toggleOpen() {
        this._open = !this._open;
        power_user.kotatsu_scene_banner = this._open ? 'open' : 'closed';
        saveSettingsDebounced();
    }

    #startEdit() {
        this._draft = this._text;
        this._editing = true;
        void this.updateComplete.then(() => {
            const area = this.querySelector('textarea');
            if (area instanceof HTMLTextAreaElement) {
                area.focus();
                area.setSelectionRange(area.value.length, area.value.length);
            }
        });
    }

    #cancel() {
        this._editing = false;
        this._draft = '';
    }

    async #save() {
        if (this._busy) return;
        this._busy = true;
        try {
            chat_metadata.scenario = this._draft.trim();
            await saveMetadata();
            this._text = chat_metadata.scenario;
            this._editing = false;
        } catch (error) {
            console.error('[k-scene-banner] save failed', error);
            toastr.error('The scene could not be saved. See the console.', 'Kotatsu');
        } finally {
            this._busy = false;
        }
    }

    /**
     * Keys typed in the editor stay in the editor: core binds global hotkeys on the document
     * (Ctrl+Enter is Regenerate, RossAscends-mods.js), and a save shortcut that also asked to
     * regenerate the last reply was caught live.
     * @param {KeyboardEvent} event
     */
    #onKey(event) {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            this.#cancel();
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void this.#save();
        }
    }

    async #moreOverrides() {
        await setCharacterSettingsOverrides();
        this.refresh();
    }

    render() {
        if (!this._inScene) return nothing;
        if (this._editing) {
            return html`
                <div class="k-banner is-editing">
                    <label class="k-banner-label" for="k-banner-text">Scene</label>
                    <div class="k-banner-editor">
                        <textarea id="k-banner-text" rows="3" placeholder="Where are they, and what’s going on? Every member reads this instead of their own scenario."
                            .value=${this._draft}
                            @input=${(/** @type {InputEvent} */ e) => { this._draft = /** @type {HTMLTextAreaElement} */ (e.target).value; }}
                            @keydown=${(/** @type {KeyboardEvent} */ e) => this.#onKey(e)}></textarea>
                        <div class="k-banner-actions">
                            <button type="button" class="k-banner-link" @click=${() => this.#moreOverrides()}>More overrides…</button>
                            <span class="k-banner-spacer"></span>
                            ${this._text ? html`<button type="button" class="k-banner-btn" @click=${() => { this._draft = ''; }}>Clear</button>` : nothing}
                            <button type="button" class="k-banner-btn" @click=${() => this.#cancel()}>Cancel</button>
                            <button type="button" class="k-banner-btn k-banner-btn--primary" ?disabled=${this._busy || this._draft.trim() === this._text.trim()}
                                @click=${() => this.#save()}>Save</button>
                        </div>
                    </div>
                </div>`;
        }
        if (!this._text) {
            return html`
                <button type="button" class="k-banner k-banner--empty" @click=${() => this.#startEdit()}>
                    ${icons.plus}<span>Set the scene</span>
                </button>`;
        }
        return html`
            <div class="k-banner${this._open ? '' : ' is-folded'}">
                <span class="k-banner-label" aria-hidden="true">Scene</span>
                <p class="k-banner-text" title=${this._open ? '' : this._text}>${this._text}</p>
                <div class="k-banner-tools">
                    <button type="button" class="k-banner-icon" title="Edit the scene" aria-label="Edit the scene"
                        @click=${() => this.#startEdit()}>${icons.edit}</button>
                    <button type="button" class="k-banner-icon" aria-expanded=${String(this._open)}
                        title=${this._open ? 'Fold to one line' : 'Show the whole scene'}
                        aria-label=${this._open ? 'Fold the scene to one line' : 'Show the whole scene'}
                        @click=${() => this.#toggleOpen()}>${this._open ? icons.fold : icons.unfold}</button>
                </div>
            </div>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-scene-banner')) {
    customElements.define('k-scene-banner', KSceneBanner);
}

/** @type {KSceneBanner|null} */
let mounted = null;

/** Mounts the banner right after the chat header (rails mount). Idempotent. */
export function installSceneBanner() {
    if (mounted) return;
    const header = document.querySelector('#k-center > k-chat-header');
    const center = document.getElementById('k-center');
    if (!center) return;
    mounted = /** @type {KSceneBanner} */ (document.createElement('k-scene-banner'));
    mounted.setAttribute('variant', 'card');
    if (header) header.after(mounted);
    else center.prepend(mounted);
}

/** @returns {void} */
export function uninstallSceneBanner() {
    mounted?.remove();
    mounted = null;
}
