/**
 * `<k-market-preview variant="sheet">` — read a card before you bring it home
 * (`docs/character-marketplace-v0.md` §6, §8; slice D).
 *
 * Opens over the gallery when a Browse Characters poster is chosen. One detail call, then:
 * the whole first message with the alternates behind a stepper, the facts as chips, the
 * description, scenario and creator's note folded, and the one action that fits: Import, or
 * Open and Update when the card is already in the library.
 *
 * The import is core's own (`importFromExternalUrl`), unchanged. It returns nothing and
 * reports through toasts, so this listens the way the tour's First card step does
 * (`shell/toast-ear.js`) and turns before/after/toasts into an outcome with
 * `onboarding/card-state.js`. "Added" is said only when the library really has the card.
 *
 * Everything from the site is bound as text. Nothing becomes HTML. The overlay wears the card
 * studio's scrim and sheet rules; the two never coexist.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters, isChatSaving, selectCharacterById, this_chid } from '../../script.js';
import { Popup } from '../../scripts/popup.js';
import { importFromExternalUrl } from '../../scripts/utils.js';
import { cardOutcome } from '../onboarding/card-state.js';
import { listenToToasts } from '../shell/toast-ear.js';
import { toInitials } from '../library/card-identity.js';
import { errorCopy, factChips, greetingFacts, previewActions, statChips, twinNotice } from './view-model.js';

/** Raised on the element after a card lands in the library. `detail.row`, `detail.avatar`. */
export const MARKET_IMPORTED_EVENT = 'k-market-imported';

/**
 * Raised on the element when the reader, with a card just landed, asks for the cast instead
 * of the chat: the sheet closes and `<k-market>` hands the gallery back to its cast view at
 * the top. Andres, 2026-10-02: deep in the scroll, the way back to the installed cards was a
 * scroll all the way up.
 */
export const MARKET_HOME_EVENT = 'k-market-home';

/**
 * @typedef {import('./view-model.js').MarketRow} MarketRow
 * @typedef {import('./view-model.js').CardDetail} CardDetail
 * @typedef {import('./view-model.js').MarketErrorBody} MarketErrorBody
 * @typedef {ReturnType<import('./store.js').createMarketStore>} MarketStore
 */

const icons = {
    close: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8"></path>
        </svg>`,
    out: html`
        <svg class="k-lib-icon k-lib-icon--arrow" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M5 11 11 5"></path><path d="M6 5h5v5"></path>
        </svg>`,
    prev: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M10 3 5 8l5 5"></path>
        </svg>`,
    next: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m6 3 5 5-5 5"></path>
        </svg>`,
    check: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5"></path>
        </svg>`,
};

export class KMarketPreview extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** Reflected so the sheet rules and the probe can see it. */
        open: { type: Boolean, reflect: true },
        /** The store the view uses; handed in so the two share one cache. */
        store: { attribute: false },
        /** The source's display name, for the copy. */
        label: { type: String },
        _row: { state: true },
        _detail: { state: true },
        _phase: { state: true },
        _error: { state: true },
        _greeting: { state: true },
        _busy: { state: true },
        _outcome: { state: true },
        _artBroken: { state: true },
    };

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** Monotonic, so a slow detail cannot land on a later card. */
    #ticket = 0;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {boolean} */
        this.open = false;
        /** @type {MarketStore|null} */
        this.store = null;
        /** @type {string} */
        this.label = 'the site';
        /** @type {MarketRow|null} */
        this._row = null;
        /** @type {CardDetail|null} */
        this._detail = null;
        /** @type {'loading'|'ready'|'error'} */
        this._phase = 'loading';
        /** @type {MarketErrorBody|null} */
        this._error = null;
        /** @type {number} Which greeting is showing: 0 = the first message. */
        this._greeting = 0;
        /** @type {boolean} An import or an update is running. */
        this._busy = false;
        /** @type {{ state: 'landed', avatar: string, name: string, replaced: boolean } | { state: 'problem', text: string } | { state: 'nothing' } | null} */
        this._outcome = null;
        /** @type {boolean} */
        this._artBroken = false;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        // Window, capture phase: the same rung as the card studio, above every other Escape.
        this.#onEscape = (event) => {
            if (event.key !== 'Escape' || !this.open) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.close();
        };
        window.addEventListener('keydown', this.#onEscape, { capture: true });
    }

    disconnectedCallback() {
        if (this.#onEscape) {
            window.removeEventListener('keydown', this.#onEscape, { capture: true });
            this.#onEscape = null;
        }
        super.disconnectedCallback();
    }

    /** What the probe reads. @returns {object} A plain snapshot. */
    get state() {
        return {
            open: this.open,
            phase: this._phase,
            id: this._row?.id ?? null,
            uid: this._row?.uid ?? null,
            servedUid: this._detail?.uid ?? null,
            greeting: this._greeting,
            greetings: this._detail ? greetingFacts(this._detail).greetings.length : 0,
            busy: this._busy,
            outcome: this._outcome?.state ?? null,
            error: this._error?.kind ?? null,
        };
    }

    /**
     * Shows the card. A second call while open moves to the new card.
     * @param {MarketRow} row The chosen poster.
     * @returns {Promise<void>}
     */
    async openCard(row) {
        this._row = row;
        this._detail = null;
        this._error = null;
        this._outcome = null;
        this._greeting = 0;
        this._artBroken = false;
        this._phase = 'loading';
        this.open = true;
        const ticket = ++this.#ticket;
        const answer = this.store ? await this.store.detail(row.source, row.id) : null;
        if (ticket !== this.#ticket || !this.open) return;
        if (!answer || answer.status !== 'ok') {
            this._error = answer && answer.status === 'error' ? answer.error : { kind: 'local', source: row.source };
            this._phase = 'error';
            return;
        }
        this._detail = answer.data;
        this._phase = 'ready';
    }

    /** @returns {void} */
    close() {
        if (this._busy) return;
        this.open = false;
        this.#ticket++;
    }

    /* ── the import ─────────────────────────────────────────────────────── */

    /**
     * Runs core's import and finds out how it went, the way the tour does.
     * @param {() => Promise<unknown>} work The import.
     * @param {boolean} replaced Whether this was an update of an installed card.
     * @returns {Promise<void>}
     */
    async #bringIn(work, replaced) {
        if (this._busy || !this._row) return;
        const row = this._row;
        const before = characters.map(character => character?.avatar).filter(avatar => typeof avatar === 'string');
        const ear = listenToToasts();
        this._busy = true;
        this._outcome = null;
        try {
            await work();
        } catch (error) {
            ear.toasts.push({ level: 'error', title: '', message: error instanceof Error ? error.message : String(error) });
        } finally {
            ear.stop();
            this._busy = false;
        }
        const after = characters.map(character => character?.avatar).filter(avatar => typeof avatar === 'string');
        const outcome = cardOutcome({ before, after, toasts: ear.toasts });
        if (outcome.state === 'landed') {
            const name = String(characters.find(character => character?.avatar === outcome.avatar)?.name ?? row.name);
            this._outcome = { state: 'landed', avatar: outcome.avatar, name, replaced };
            this.dispatchEvent(new CustomEvent(MARKET_IMPORTED_EVENT, { detail: { row, avatar: outcome.avatar, replaced }, bubbles: true, composed: true }));
        } else if (outcome.state === 'problem') {
            this._outcome = outcome;
        } else {
            this._outcome = { state: 'problem', text: 'Nothing came in. Core did not say why.' };
        }
    }

    /** Import the card as new. @returns {void} */
    #import() {
        const row = this._row;
        if (!row) return;
        void this.#bringIn(() => importFromExternalUrl(row.importUrl), false);
    }

    /**
     * Replace the installed copy in place. Core keeps chats, assets and group memberships and
     * drops local edits to the card; the confirm says so in core's own words.
     * @returns {Promise<void>}
     */
    async #update() {
        const row = this._row;
        if (!row?.installed) return;
        const ok = await Popup.show.confirm(`Update from ${this.label}`,
            `${row.name} will be replaced with the copy on ${this.label}. All chats, assets and group memberships will be preserved, but local changes to the character data will be lost. Proceed?`);
        if (!ok) return;
        await this.#bringIn(() => importFromExternalUrl(row.importUrl, { preserveFileName: row.installed }), true);
    }

    /**
     * Opens the installed card's chat. The gallery closes itself when the chat changes.
     * @param {string} avatar The installed avatar file.
     * @returns {Promise<void>}
     */
    async #openChat(avatar) {
        const find = () => characters.findIndex(character => character?.avatar === avatar);
        if (find() < 0) return;
        this._busy = true;
        try {
            for (let i = 0; i < 40 && isChatSaving; i += 1) await new Promise(resolve => setTimeout(resolve, 120));
            const index = find();
            if (index >= 0 && String(this_chid) !== String(index)) await selectCharacterById(index);
        } finally {
            this._busy = false;
        }
        if (String(this_chid) === String(find())) this.close();
    }

    /** Closes and asks the view for the cast. @returns {void} */
    #goHome() {
        this.close();
        this.dispatchEvent(new CustomEvent(MARKET_HOME_EVENT, { bubbles: true, composed: true }));
    }

    /* ── render ─────────────────────────────────────────────────────────── */

    render() {
        if (!this.open || !this._row) return nothing;
        const row = this._row;
        return html`
            <div class="k-studio-scrim k-mkt-preview-scrim" @click=${() => this.close()}></div>
            <div class="k-studio-sheet k-mkt-preview" role="dialog" aria-modal="true" aria-label=${`${row.name}, on ${this.label}`}>
                ${this.#renderHead(row)}
                <div class="k-mkt-preview-body">
                    ${this._phase === 'loading' ? html`<p class="k-lib-quiet">Reading the card…</p>` : nothing}
                    ${this._phase === 'error' ? this.#renderError() : nothing}
                    ${this._phase === 'ready' && this._detail ? this.#renderCard(row, this._detail) : nothing}
                </div>
                ${this.#renderFoot(row)}
            </div>`;
    }

    /**
     * @param {MarketRow} row The poster.
     * @returns {unknown} Art, eyebrow, name, tagline, close.
     */
    #renderHead(row) {
        const art = this._detail?.artUrl || row.portrait;
        // Resolved before the template, one binding per line, as every kotatsu component does.
        const picture = art && !this._artBroken
            ? html`<img class="k-mkt-preview-portrait" src=${art} alt="" decoding="async" referrerpolicy="no-referrer" @error=${() => { this._artBroken = true; }} />`
            : html`<div class="k-lib-card-initials" aria-hidden="true">${toInitials(row.name)}</div>`;
        return html`
            <header class="k-studio-head k-mkt-preview-head">
                <div class="k-mkt-preview-art" style=${`--card-accent: hsl(${row.hue} var(--k-lib-accent-s) var(--k-lib-accent-l));`}>${picture}</div>
                <div class="k-studio-head-copy k-mkt-preview-copy">
                    <span class="k-studio-eyebrow">On ${this.label}${row.kicker ? ` · ${row.kicker}` : ''}</span>
                    <h2 class="k-studio-title">${row.name}</h2>
                    ${row.body ? html`<p class="k-mkt-preview-tagline">${row.body}</p>` : nothing}
                    ${row.installed ? html`<span class="k-mkt-card-owned">${icons.check}<span>In your library</span></span>` : nothing}
                </div>
                <button type="button" class="k-lib-close k-mkt-preview-close" title="Close" aria-label="Close" @click=${() => this.close()}>${icons.close}</button>
            </header>`;
    }

    /** @returns {unknown} The words for a failed detail call. */
    #renderError() {
        if (!this._error) return nothing;
        const copy = errorCopy(this._error, { label: this.label, context: 'detail' });
        return html`
            <div class="k-lib-empty k-mkt-error" data-kind=${this._error.kind} role="status">
                <p class="k-lib-empty-title">${copy.title}</p>
                <p class="k-lib-empty-sub">${copy.body}</p>
                ${copy.action === 'retry' ? html`<div class="k-lib-empty-actions"><button type="button" class="k-lib-btn k-lib-btn--ghost k-mkt-retry" @click=${() => { if (this._row) void this.openCard(this._row); }}><span>Try again</span></button></div>` : nothing}
            </div>`;
    }

    /**
     * @param {MarketRow} row The poster.
     * @param {CardDetail} detail The card.
     * @returns {unknown} Facts, greeting, folded sections.
     */
    #renderCard(row, detail) {
        const facts = greetingFacts(detail);
        const chips = [...factChips(facts), ...statChips(detail.stats, detail.updatedAt)];
        const notice = twinNotice(row, detail, this.label);
        const greeting = facts.greetings[Math.min(this._greeting, Math.max(0, facts.greetings.length - 1))] ?? '';
        const tags = detail.tags.length ? html`<ul class="k-lib-card-tags k-mkt-preview-tags">${detail.tags.map(tag => html`<li class="k-lib-card-tag">${tag}</li>`)}</ul>` : nothing;
        return html`
            ${notice ? html`<p class="k-mkt-preview-notice" role="status">${notice}</p>` : nothing}
            ${tags}
            ${chips.length ? html`<ul class="k-mkt-preview-chips" aria-label="Facts">${chips.map(chip => html`<li class="k-mkt-chip is-static" data-fact=${chip.id}>${chip.label}</li>`)}</ul>` : nothing}
            <section class="k-mkt-preview-greeting" aria-label="Greeting">
                <div class="k-mkt-preview-greeting-head">
                    <h3 class="k-lib-sectiontitle">${this._greeting === 0 ? 'First message' : `Alternate greeting ${this._greeting}`}</h3>
                    ${facts.greetings.length > 1 ? html`
                        <div class="k-mkt-preview-stepper" role="group" aria-label="Greetings">
                            <button type="button" class="k-mkt-preview-step" aria-label="Previous greeting" ?disabled=${this._greeting === 0} @click=${() => { this._greeting -= 1; }}>${icons.prev}</button>
                            <span class="k-mkt-preview-step-count">${this._greeting + 1} of ${facts.greetings.length}</span>
                            <button type="button" class="k-mkt-preview-step" aria-label="Next greeting" ?disabled=${this._greeting >= facts.greetings.length - 1} @click=${() => { this._greeting += 1; }}>${icons.next}</button>
                        </div>` : nothing}
                </div>
                ${greeting ? html`<p class="k-mkt-preview-text">${greeting}</p>` : html`<p class="k-lib-quiet">This card has no greeting.</p>`}
            </section>
            ${detail.description ? this.#fold('Description', detail.description, 'description') : nothing}
            ${detail.scenario ? this.#fold('Scenario', detail.scenario, 'scenario') : nothing}
            ${detail.blurb ? this.#fold('Creator\'s note', detail.blurb, 'note') : nothing}`;
    }

    /**
     * @param {string} title Section title.
     * @param {string} text Untrusted text, shown as text.
     * @param {string} id For the probe.
     * @returns {unknown} A folded section.
     */
    #fold(title, text, id) {
        return html`
            <details class="k-mkt-preview-fold" data-fold=${id}>
                <summary class="k-mkt-preview-fold-title">${title}</summary>
                <p class="k-mkt-preview-text">${text}</p>
            </details>`;
    }

    /**
     * @param {MarketRow} row The poster.
     * @returns {unknown} The outcome line and the actions.
     */
    #renderFoot(row) {
        const actions = previewActions(row);
        const outcome = this._outcome;
        const line = outcome?.state === 'landed'
            ? html`<span class="k-mkt-preview-outcome is-good" role="status">${icons.check}<span>${outcome.replaced ? `${outcome.name} is updated.` : `${outcome.name} is in your library.`}</span></span>`
            : outcome?.state === 'problem'
                ? html`<span class="k-mkt-preview-outcome is-bad" role="status">${outcome.text}</span>`
                : nothing;
        const landedAvatar = outcome?.state === 'landed' ? outcome.avatar : '';
        const primary = landedAvatar
            ? html`<button type="button" class="k-lib-btn k-lib-btn--primary k-mkt-preview-open" ?disabled=${this._busy} @click=${() => { void this.#openChat(landedAvatar); }}><span>Open chat</span></button>`
            : actions.primary === 'open'
                ? html`<button type="button" class="k-lib-btn k-lib-btn--primary k-mkt-preview-open" ?disabled=${this._busy} @click=${() => { void this.#openChat(row.installed); }}><span>Open chat</span></button>`
                : html`<button type="button" class="k-lib-btn k-lib-btn--primary k-mkt-preview-import" ?disabled=${this._busy || this._phase !== 'ready'} @click=${() => this.#import()}><span>${this._busy ? 'Importing…' : 'Import'}</span></button>`;
        const secondary = landedAvatar
            // A card just landed: the other way home is the cast, not the chat.
            ? html`<button type="button" class="k-lib-btn k-lib-btn--ghost k-mkt-preview-home" ?disabled=${this._busy} @click=${() => this.#goHome()}><span>Back to your cast</span></button>`
            : actions.secondary === 'update'
                ? html`<button type="button" class="k-lib-btn k-lib-btn--ghost k-mkt-preview-update" ?disabled=${this._busy || this._phase !== 'ready'} @click=${() => { void this.#update(); }}><span>${this._busy ? 'Updating…' : `Update from ${this.label}`}</span></button>`
                : nothing;
        return html`
            <footer class="k-mkt-preview-foot">
                ${line}
                <div class="k-mkt-preview-actions">
                    <a class="k-lib-btn k-lib-btn--ghost k-mkt-preview-site" href=${row.pageUrl} target="_blank" rel="noopener noreferrer"><span>View on ${this.label}</span>${icons.out}</a>
                    ${secondary}
                    ${primary}
                </div>
            </footer>`;
    }
}

if (!customElements.get('k-market-preview')) {
    customElements.define('k-market-preview', KMarketPreview);
}
