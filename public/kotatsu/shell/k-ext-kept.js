/**
 * `<k-ext-kept variant="list">` — Settings → Extensions: the extensions Kotatsu warned about, and
 * the way to change the answer (public issue #6).
 *
 * Each row has a real switch: off is core's `disableExtension`, on is core's `enableExtension`,
 * both of which save and reload, because that is what it takes for an extension to come or go. So
 * someone who pressed "Keep it" can still turn the bully off, and someone who pressed "Disable and
 * reload" can turn it back on. "Ask again" forgets the answer, so the notice comes back.
 *
 * A row with no folder is a layer no extension's stylesheet claimed. There is nothing to switch,
 * only the answer to forget. Extensions uninstalled since keep a row with no switch, too.
 *
 * Light DOM (css/shell-ext-guard.css), `variant` per SPEC §13.
 */

import { LitElement, html, nothing } from './lit.js';
import { disableExtension, enableExtension, extension_settings, extensionNames } from '../../scripts/extensions.js';
import { KEPT_CHANGE_EVENT, forgetKept, keptExtensions } from './ext-guard.js';

/**
 * @param {import('./ext-guard.js').KeptExtension} entry A kept extension.
 * @returns {string} What to call it.
 */
function nameOf(entry) {
    return entry.name || entry.folder?.split('/').pop() || `An extension (${entry.key})`;
}

export class KExtKept extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _busy: { state: true },
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'list';
        /** @type {boolean} */
        this._busy = false;
        this._refresh = () => this.requestUpdate();
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener(KEPT_CHANGE_EVENT, this._refresh);
    }

    disconnectedCallback() {
        document.removeEventListener(KEPT_CHANGE_EVENT, this._refresh);
        super.disconnectedCallback();
    }

    /**
     * @param {string} folder `third-party/<folder>`.
     * @param {boolean} on The new state.
     * @returns {Promise<void>}
     */
    async #switch(folder, on) {
        if (this._busy) return;
        this._busy = true;
        try {
            await (on ? enableExtension(folder, true) : disableExtension(folder, true));
        } catch (error) {
            console.error('[k-ext-kept] switch failed', error);
            this._busy = false;
        }
    }

    /** @param {string} key The kept entry's key. @returns {void} */
    #forget(key) {
        forgetKept(key);
    }

    /**
     * @param {import('./ext-guard.js').KeptExtension} entry A kept extension.
     * @returns {unknown} A Lit template.
     */
    #row(entry) {
        const { folder } = entry;
        const installed = Boolean(folder) && extensionNames.includes(/** @type {string} */ (folder));
        const on = installed && !extension_settings.disabledExtensions.includes(/** @type {string} */ (folder));
        const name = nameOf(entry);
        const state = !folder ? 'Asked not to warn about it' : !installed ? 'No longer installed' : on ? 'On, covering the page' : 'Off';
        return html`
            <li class="k-ek__row">
                <span class="k-ek__copy">
                    <span class="k-ek__name">${name}</span>
                    <span class="k-ek__state">${state}</span>
                </span>
                ${on || !installed ? html`<button type="button" class="menu_button k-ek__forget" ?disabled=${this._busy} aria-label=${`Ask again about ${name}`} @click=${() => this.#forget(entry.key)}>Ask again</button>` : nothing}
                ${installed ? html`
                    <label class="checkbox_label k-ek__switch">
                        <input type="checkbox" .checked=${on} ?disabled=${this._busy} aria-label=${`${name} on`}
                            @change=${(/** @type {Event} */ event) => this.#switch(/** @type {string} */ (folder), /** @type {HTMLInputElement} */ (event.target).checked)}>
                        <span>On</span>
                    </label>` : nothing}
            </li>`;
    }

    render() {
        const kept = keptExtensions();
        if (kept.length === 0) {
            return html`<p class="k-ek__empty">None yet. If an extension covers the page, Kotatsu asks what to do and keeps your answer here.</p>`;
        }
        return html`
            <ul class="k-ek__list">${kept.map(entry => this.#row(entry))}</ul>
            <p class="k-ek__empty">Switching one reloads the page.</p>`;
    }
}

if (!customElements.get('k-ext-kept')) {
    customElements.define('k-ext-kept', KExtKept);
}
