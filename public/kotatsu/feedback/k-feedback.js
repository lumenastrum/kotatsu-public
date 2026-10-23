/**
 * `<k-feedback variant="sheet">` — Send feedback (docs/feedback-v0.md). A body-level sheet with
 * its own scrim: what kind of report, a title, what happened, and the diagnostics the person can
 * read, edit or leave out. "Open on GitHub" opens a pre-filled issue on the public repo in a new
 * tab; nothing leaves Kotatsu and nothing reaches GitHub until they press Submit there (Andres,
 * 2026-10-22). "Copy report" copies the same text, for anywhere else.
 *
 * Opened from Settings → System → Help (`OPEN_FEEDBACK_EVENT`, settings closes first). Rails only.
 * Light DOM, `css/feedback.css` owns every rule; buttons and the kind switch are the house button
 * and switch (rechrome-controls.css `--k-rc-*`).
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { copyText } from '../../scripts/utils.js';
import { gatherFacts, listenForErrors } from './diagnostics.js';
import { KINDS, diagnosticsText, issueUrl, kindOf, reportText } from './report.js';

/** Fired on `window` to open the sheet (Settings → System → Send feedback). */
export const OPEN_FEEDBACK_EVENT = 'k-open-feedback';

const closeIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">${svg`<path d="M4 4l8 8M12 4l-8 8"/>`}</svg>`;
const outIcon = html`<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<path d="M6.5 3.5H3.5v9h9v-3"/><path d="M9 3h4v4M13 3L7.5 8.5"/>`}</svg>`;

/** @returns {boolean} Whether the rails shell is active. */
function railsActive() {
    return document.body?.dataset?.kLayout === 'rails';
}

export class KFeedback extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _kind: { state: true },
        _title: { state: true },
        _text: { state: true },
        _include: { state: true },
        _diagnostics: { state: true },
        _status: { state: true },
    };

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onKeydown = null;
    /** @type {Element|null} Where focus was before the sheet opened, to hand it back. */
    #returnFocus = null;

    constructor() {
        super();
        /** @type {string} SPEC §13: every component ships a variant. */
        this.variant = 'sheet';
        /** @type {import('./report.js').FeedbackKind} */
        this._kind = 'bug';
        this._title = '';
        this._text = '';
        this._include = true;
        this._diagnostics = 'Gathering…';
        this._status = '';
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        this.#returnFocus = document.activeElement;
        this.#onKeydown = (event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            this.close();
        };
        window.addEventListener('keydown', this.#onKeydown, { capture: true });
        void gatherFacts().then((facts) => {
            this._diagnostics = diagnosticsText(facts);
        });
        void this.updateComplete.then(() => /** @type {HTMLElement|null} */ (this.querySelector('#k-fb-text'))?.focus());
    }

    disconnectedCallback() {
        if (this.#onKeydown) window.removeEventListener('keydown', this.#onKeydown, { capture: true });
        this.#onKeydown = null;
        super.disconnectedCallback();
    }

    close() {
        this.remove();
        if (this.#returnFocus instanceof HTMLElement && this.#returnFocus.isConnected) this.#returnFocus.focus();
    }

    /** @returns {{ kind: import('./report.js').FeedbackKind, title: string, text: string, diagnostics: string }} */
    #report() {
        return { kind: this._kind, title: this._title, text: this._text, diagnostics: this._include ? this._diagnostics : '' };
    }

    /** @param {string} text @returns {Promise<boolean>} */
    async #copy(text) {
        try {
            await copyText(text);
            return true;
        } catch {
            return false;
        }
    }

    async #copyReport() {
        this._status = (await this.#copy(reportText(this.#report())))
            ? 'Copied. Paste it wherever you like: GitHub, Reddit, a message.'
            : 'Your browser wouldn’t let Kotatsu copy. Select the text and copy it yourself.';
    }

    async #open() {
        if (!this._text.trim()) {
            this._status = 'Write a line or two first, so whoever reads it knows where to look.';
            /** @type {HTMLElement|null} */ (this.querySelector('#k-fb-text'))?.focus();
            return;
        }
        const report = this.#report();
        const { url, moved, cut } = issueUrl(report);
        // What didn't fit the link goes to the clipboard BEFORE the tab opens, while this page still
        // has the click's permission to write it.
        const copied = moved || cut ? await this.#copy(reportText(report)) : false;
        // `noopener` makes window.open return null whether or not a tab opened, so there is nothing
        // to check; the link is also the "Open on GitHub" button's own words if a blocker ate it.
        window.open(url, '_blank', 'noopener,noreferrer');
        this._status = moved || cut
            ? copied
                ? 'GitHub opened in a new tab. Part of the report didn’t fit the link, so the whole report is on your clipboard: paste it into the issue, then press Submit.'
                : 'GitHub opened in a new tab, but part of the report didn’t fit the link and Kotatsu couldn’t copy it. Use Copy report and paste it there.'
            : 'GitHub opened in a new tab. Look it over and press Submit there. Screenshots can be pasted straight into the issue.';
    }

    render() {
        const kind = KINDS[kindOf(this._kind)];
        return html`
            <div class="k-fb-scrim" @click=${() => this.close()}></div>
            <section class="k-fb-sheet" role="dialog" aria-modal="true" aria-labelledby="k-fb-title">
                <header class="k-fb-head">
                    <h2 id="k-fb-title" class="k-fb-title">Send feedback</h2>
                    <button type="button" class="k-fb-close" aria-label="Close" title="Close" @click=${() => this.close()}>${closeIcon}</button>
                </header>
                <p class="k-fb-lede">This opens a new issue on Kotatsu’s GitHub with what you write here. Nothing is sent until you press Submit there. You’ll need a free GitHub account.</p>

                <div class="k-fb-body">
                    <div class="k-fb-kinds" role="radiogroup" aria-label="What kind of feedback">
                        ${Object.entries(KINDS).map(([id, entry]) => html`
                            <button type="button" role="radio" class="k-fb-kind" aria-checked=${this._kind === id ? 'true' : 'false'}
                                @click=${() => { this._kind = kindOf(id); this._status = ''; }}>${entry.label}</button>`)}
                    </div>

                    <label class="k-fb-field">
                        <span class="k-fb-label">Title <small>optional</small></span>
                        <input id="k-fb-name" class="k-fb-input text_pole" type="text" maxlength="120" autocomplete="off"
                            placeholder="A few words" .value=${this._title}
                            @input=${(/** @type {Event} */ e) => { this._title = /** @type {HTMLInputElement} */ (e.target).value; }}>
                    </label>

                    <label class="k-fb-field">
                        <span class="k-fb-label">${kind.heading}</span>
                        <textarea id="k-fb-text" class="k-fb-input k-fb-text text_pole" rows="6" placeholder=${kind.placeholder} .value=${this._text}
                            @input=${(/** @type {Event} */ e) => { this._text = /** @type {HTMLTextAreaElement} */ (e.target).value; this._status = ''; }}></textarea>
                    </label>

                    <div class="k-fb-diag">
                        <label class="k-fb-check checkbox_label">
                            <input type="checkbox" .checked=${this._include}
                                @change=${(/** @type {Event} */ e) => { this._include = /** @type {HTMLInputElement} */ (e.target).checked; }}>
                            <span>Include diagnostics</span>
                        </label>
                        <p class="k-fb-hint">Only what helps find the problem: your version, browser, theme and what kind of connection answers. Never your chats, names or keys. Edit anything you’d rather not share.</p>
                        ${this._include ? html`
                            <textarea class="k-fb-input k-fb-diagtext text_pole" rows="7" spellcheck="false" aria-label="Diagnostics" .value=${this._diagnostics}
                                @input=${(/** @type {Event} */ e) => { this._diagnostics = /** @type {HTMLTextAreaElement} */ (e.target).value; }}></textarea>` : nothing}
                    </div>
                </div>

                ${this._status ? html`<p class="k-fb-status" role="status">${this._status}</p>` : nothing}

                <footer class="k-fb-foot">
                    <button type="button" class="k-fb-button" @click=${() => this.#copyReport()}>Copy report</button>
                    <button type="button" class="k-fb-button" data-kind="primary" @click=${() => this.#open()}>Open on GitHub ${outIcon}</button>
                </footer>
            </section>`;
    }
}

if (!customElements.get('k-feedback')) {
    customElements.define('k-feedback', KFeedback);
}

/**
 * Opens the sheet (or keeps an open one), rails only.
 * @returns {KFeedback|null}
 */
export function openFeedback() {
    if (!railsActive()) return null;
    const existing = document.querySelector('k-feedback');
    if (existing instanceof KFeedback) return existing;
    const sheet = /** @type {KFeedback} */ (document.createElement('k-feedback'));
    sheet.setAttribute('variant', 'sheet');
    document.body.appendChild(sheet);
    return sheet;
}

/**
 * Registration at the shell seam: keep the last few page errors for reports, and answer
 * Settings' "Send feedback". Once.
 * @returns {void}
 */
export function installFeedback() {
    listenForErrors();
    window.addEventListener(OPEN_FEEDBACK_EVENT, () => openFeedback());
}
