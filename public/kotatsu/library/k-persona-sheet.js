/**
 * `<k-persona-sheet variant="sheet">` — read a persona before you put it on
 * (`docs/persona-gallery-v0.md` §1.1, slice P1b).
 *
 * Opens over the gallery when a Your personas poster is chosen. READ-ONLY: any persona can be
 * looked at without wearing it. That's the half of doc §0's "editing puts it on" that costs
 * nothing, because nothing here writes. Two actions write, both through the shelf's own paths:
 * Wear (`setUserAvatar`) and Edit (the persona studio, P2, which wears it first).
 *
 * What it shows, all from the row the shelf built (no second read of core, except names for
 * connections and core's own tokenizer):
 * - the full-res portrait, name, core's display title;
 * - the description as text, `{{user}}` resolved to this persona's name;
 * - where it goes, in words (`placementWords`), and what it's tied to (default, chat lock,
 *   character lock, connections by name, persona lorebook);
 * - core's token count of the raw description (`getTokenCountAsync`, the exact call core's
 *   own counter makes, `personas.js:614-617`).
 *
 * Prev/next walks the shelf's on-screen order (tied strip first, then everyone else), wraps,
 * and answers ← / → while the sheet is open.
 *
 * Mounted on `document.body` by `<k-persona-shelf>`, not inside the gallery: the gallery's
 * sheet is a stacking context and a fixed overlay inside it would sit under the top bar (the
 * market preview's measured lesson, `k-market.js`). It wears the studio's scrim and sheet and
 * the market preview's head / body / foot rules; `css/library.css` §8.5 adds the persona bits.
 * Everything from the descriptor is bound as text. Nothing becomes HTML.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters } from '../../script.js';
import { groups } from '../../scripts/group-chats.js';
import { getTokenCountAsync } from '../../scripts/tokenizers.js';
import { toInitials } from './card-identity.js';
import { connectionLabels, neighbours, placementWords } from './persona-view-model.js';

/** @typedef {import('./persona-view-model.js').PersonaRow} PersonaRow */

const icons = {
    close: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8M12 4l-8 8"></path>
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
    edit: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M10.6 3.4a1.5 1.5 0 0 1 2.1 2.1L6.4 11.8l-2.9.7.7-2.9z" /><path d="M9.4 4.6l2 2" />
        </svg>`,
};

/**
 * Resolves a connection to a display name off core's lists. `''` = gone.
 * @param {{ type: string, id: string }} connection A descriptor connection.
 * @returns {string} The name.
 */
function connectionName(connection) {
    if (connection.type === 'group') {
        return String(groups.find(group => group?.id === connection.id)?.name ?? '');
    }
    return String(characters.find(character => character?.avatar === connection.id)?.name ?? '');
}

export class KPersonaSheet extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `sheet` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** Reflected so the sheet rules and the probe can see it. */
        open: { type: Boolean, reflect: true },
        /** Rows in on-screen order, handed in by the shelf on every render. */
        rows: { attribute: false },
        /** Name of the open character or scene, for the "Locked to …" line. */
        tiedTo: { type: String },
        /** `(id) => Promise<void>`: the shelf's wear. */
        onWear: { attribute: false },
        /** `(id) => Promise<void>`: the shelf's edit. */
        onEdit: { attribute: false },
        _id: { state: true },
        _tokens: { state: true },
        _artStep: { state: true },
        _busy: { state: true },
    };

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onKey = null;

    /** Monotonic, so a slow token count cannot land on a later persona. */
    #ticket = 0;

    /** @type {HTMLElement|null} What had focus before the sheet opened; it gets it back. */
    #returnFocus = null;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {boolean} */
        this.open = false;
        /** @type {PersonaRow[]} */
        this.rows = [];
        /** @type {string} */
        this.tiedTo = '';
        /** @type {((id: string) => Promise<void>)|null} */
        this.onWear = null;
        /** @type {((id: string) => Promise<void>)|null} */
        this.onEdit = null;
        /** @type {string} */
        this._id = '';
        /** @type {number|null} */
        this._tokens = null;
        /** @type {0|1|2} 0 = full-res, 1 = thumbnail, 2 = initials. */
        this._artStep = 0;
        /** @type {boolean} */
        this._busy = false;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        // Window, capture phase: the card studio's and the market preview's rung, above the
        // gallery's own Escape. ← / → walk, but never out of a text field.
        this.#onKey = (event) => {
            if (!this.open) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                this.close();
                return;
            }
            const target = event.target;
            const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
            if (typing || event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                const around = neighbours(this.#order(), this._id);
                if (!around) return;
                event.preventDefault();
                this.show(event.key === 'ArrowLeft' ? around.prev : around.next);
            }
        };
        window.addEventListener('keydown', this.#onKey, { capture: true });
    }

    disconnectedCallback() {
        if (this.#onKey) {
            window.removeEventListener('keydown', this.#onKey, { capture: true });
            this.#onKey = null;
        }
        super.disconnectedCallback();
    }

    /** @returns {string[]} Ids in on-screen order. */
    #order() {
        return this.rows.map(row => String(row.id));
    }

    /** @returns {PersonaRow|null} The open persona's row, fresh from the shelf. */
    get row() {
        return this.rows.find(row => String(row.id) === this._id) ?? null;
    }

    /** What the probe reads. @returns {object} A plain snapshot. */
    get state() {
        const around = neighbours(this.#order(), this._id);
        return {
            open: this.open,
            id: this._id,
            index: around ? around.index : (this.row ? 0 : -1),
            total: this.rows.length,
            tokens: this._tokens,
            art: ['full', 'thumb', 'initials'][this._artStep],
            busy: this._busy,
        };
    }

    /**
     * Opens the sheet on a persona, or moves an open sheet to it.
     * @param {string} id Avatar id.
     * @returns {void}
     */
    show(id) {
        if (!this.open) {
            const active = document.activeElement;
            this.#returnFocus = active instanceof HTMLElement ? active : null;
        }
        this._id = id;
        this._artStep = 0;
        this._tokens = null;
        this.open = true;
        void this.#count();
        void this.updateComplete.then(() => {
            const sheet = this.querySelector('.k-ps-sheet');
            if (sheet instanceof HTMLElement && !sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true });
        });
    }

    /** @returns {void} */
    close() {
        if (!this.open) return;
        this.open = false;
        this.#ticket++;
        const back = this.#returnFocus;
        this.#returnFocus = null;
        // The poster that opened us, if it's still in the document.
        if (back?.isConnected) back.focus({ preventScroll: true });
    }

    /** Core's token count of the raw description, the call core's own counter makes. @returns {Promise<void>} */
    async #count() {
        const row = this.row;
        const ticket = ++this.#ticket;
        if (!row) return;
        try {
            const count = await getTokenCountAsync(row.rawDescription);
            if (ticket === this.#ticket && this.open) this._tokens = Number.isFinite(count) ? count : null;
        } catch (error) {
            console.warn('[k-persona-sheet] token count failed', error);
        }
    }

    /**
     * Rows changed under us (core events → the shelf re-rendered): a persona deleted while open
     * closes the sheet; anything else just re-renders with the fresh row.
     * @param {Map<string, unknown>} changed Changed properties.
     * @returns {void}
     */
    willUpdate(changed) {
        if (changed.has('rows') && this.open && !this.row) {
            this.open = false;
            this.#ticket++;
        }
    }

    /** @param {'wear'|'edit'} kind Which action. @returns {Promise<void>} */
    async #act(kind) {
        const row = this.row;
        if (!row || this._busy) return;
        const handler = kind === 'wear' ? this.onWear : this.onEdit;
        if (typeof handler !== 'function') return;
        this._busy = true;
        try {
            if (kind === 'edit') this.close();
            await handler(String(row.id));
        } finally {
            this._busy = false;
        }
    }

    /** Full-res → thumbnail → initials, the poster's own fallback chain (doc §4 gate 5). @returns {void} */
    #artFailed() {
        this._artStep = this._artStep === 0 && this.row?.thumb ? 1 : 2;
    }

    /* ── render ─────────────────────────────────────────────────────────── */

    render() {
        const row = this.open ? this.row : null;
        if (!row) return nothing;
        return html`
            <div class="k-studio-scrim k-mkt-preview-scrim k-ps-scrim" @click=${() => this.close()}></div>
            <div class="k-studio-sheet k-mkt-preview k-ps-sheet" role="dialog" aria-modal="true" tabindex="-1"
                aria-label=${`${row.name}, your persona`}
                style=${`--card-accent: hsl(${row.hue} var(--k-lib-accent-s) var(--k-lib-accent-l));`}>
                ${this.#renderHead(row)}
                <div class="k-mkt-preview-body k-ps-sheet-body">
                    ${this.#renderAbout(row)}
                    ${this.#renderFacts(row)}
                </div>
                ${this.#renderFoot(row)}
            </div>`;
    }

    /**
     * @param {PersonaRow} row The persona.
     * @returns {unknown} Portrait, eyebrow, name, title, walker, close.
     */
    #renderHead(row) {
        const src = this._artStep === 0 ? row.portrait : this._artStep === 1 ? row.thumb : '';
        const picture = src
            ? html`<img class="k-mkt-preview-portrait" src=${src} alt="" decoding="async" @error=${() => this.#artFailed()} />`
            : html`<div class="k-lib-card-initials" aria-hidden="true">${row.initials || toInitials(row.name)}</div>`;
        const around = neighbours(this.#order(), this._id);
        const walker = around
            ? html`
                <div class="k-mkt-preview-stepper k-ps-walker" role="group" aria-label="Personas">
                    <button type="button" class="k-mkt-preview-step" aria-label="Previous persona" title="Previous (←)" @click=${() => this.show(around.prev)}>${icons.prev}</button>
                    <span class="k-mkt-preview-step-count">${around.index + 1} of ${around.total}</span>
                    <button type="button" class="k-mkt-preview-step" aria-label="Next persona" title="Next (→)" @click=${() => this.show(around.next)}>${icons.next}</button>
                </div>`
            : nothing;
        return html`
            <header class="k-studio-head k-mkt-preview-head k-ps-sheet-head">
                <div class="k-mkt-preview-art k-ps-sheet-art">${picture}</div>
                <div class="k-studio-head-copy k-mkt-preview-copy">
                    <span class="k-studio-eyebrow">${row.current ? 'Your persona · wearing it now' : 'Your persona'}</span>
                    <h2 class="k-studio-title">${row.name}</h2>
                    ${row.title ? html`<p class="k-mkt-preview-tagline">${row.title}</p>` : nothing}
                    ${row.current ? html`<span class="k-mkt-card-owned k-ps-wearing">${icons.check}<span>Wearing</span></span>` : nothing}
                </div>
                <div class="k-ps-sheet-tools">
                    ${walker}
                    <button type="button" class="k-lib-close k-mkt-preview-close" title="Close" aria-label="Close" @click=${() => this.close()}>${icons.close}</button>
                </div>
            </header>`;
    }

    /**
     * @param {PersonaRow} row The persona.
     * @returns {unknown} The description, as the reader wrote it (with `{{user}}` filled in).
     */
    #renderAbout(row) {
        const tokens = this._tokens === null ? '…' : String(this._tokens);
        const text = row.description.trim()
            ? html`<p class="k-mkt-preview-text k-ps-sheet-text">${row.description}</p>`
            : html`<p class="k-lib-quiet k-ps-sheet-empty">No description yet. The model only knows ${row.name}'s name.</p>`;
        return html`
            <section class="k-ps-sheet-about" aria-label=${`About ${row.name}`}>
                <div class="k-mkt-preview-greeting-head">
                    <h3 class="k-lib-sectiontitle">About ${row.name}</h3>
                    <span class="k-ps-sheet-tokens" title="Core's token count for this description">${tokens} tokens</span>
                </div>
                ${text}
            </section>`;
    }

    /**
     * @param {PersonaRow} row The persona.
     * @returns {unknown} Where it goes and what it's tied to.
     */
    #renderFacts(row) {
        /** @type {string[]} */
        const ties = [];
        if (row.isDefault) ties.push('Default for new chats');
        if (row.chatLocked) ties.push('Locked to this chat');
        if (row.charLocked) ties.push(this.tiedTo ? `Locked to ${this.tiedTo}` : 'Locked to the open character');
        const connected = connectionLabels(row.connections, connectionName);
        const counted = row.variants?.items ?? 0;
        const variantsFact = counted
            ? html`
                <div class="k-ps-sheet-fact" data-fact="variants">
                    <dt class="k-lib-sectiontitle">Variants</dt>
                    <dd>
                        ${counted} ${counted === 1 ? 'variant' : 'variants'}${row.variants.groups ? `, in ${row.variants.groups} ${row.variants.groups === 1 ? 'group' : 'groups'}` : ''}.
                        ${row.variantsHere.length
        ? html`On here: <ul class="k-mkt-preview-chips k-ps-sheet-variants">${row.variantsHere.map(title => html`<li class="k-mkt-chip is-static">${title}</li>`)}</ul>`
        : 'None fold in for what is open.'}
                    </dd>
                </div>`
            : nothing;
        return html`
            <dl class="k-ps-sheet-facts">
                <div class="k-ps-sheet-fact" data-fact="placement">
                    <dt class="k-lib-sectiontitle">Where it goes</dt>
                    <dd>${placementWords(row.position, row.depth, row.role)}</dd>
                </div>
                ${variantsFact}
                <div class="k-ps-sheet-fact" data-fact="ties">
                    <dt class="k-lib-sectiontitle">What it's tied to</dt>
                    <dd>
                        ${ties.length || connected.length || row.lorebook ? html`
                            <ul class="k-mkt-preview-chips">
                                ${ties.map(label => html`<li class="k-mkt-chip is-static">${label}</li>`)}
                                ${connected.map(label => html`<li class="k-mkt-chip is-static" data-kind="connection">${label}</li>`)}
                                ${row.lorebook ? html`<li class="k-mkt-chip is-static" data-kind="lorebook">Lorebook: ${row.lorebook}</li>` : nothing}
                            </ul>` : html`<span class="k-ps-sheet-none">Nothing yet: this persona goes wherever you take it.</span>`}
                    </dd>
                </div>
            </dl>`;
    }

    /**
     * @param {PersonaRow} row The persona.
     * @returns {unknown} Edit and Wear.
     */
    #renderFoot(row) {
        const wear = row.current
            ? html`<button type="button" class="k-lib-btn k-lib-btn--primary k-ps-sheet-wear" disabled>${icons.check}<span>Wearing</span></button>`
            : html`<button type="button" class="k-lib-btn k-lib-btn--primary k-ps-sheet-wear" ?disabled=${this._busy} @click=${() => { void this.#act('wear'); }}><span>${this._busy ? 'Putting it on…' : `Wear ${row.name}`}</span></button>`;
        return html`
            <footer class="k-mkt-preview-foot">
                <span class="k-ps-sheet-hint">${row.current ? 'Editing changes the persona you are wearing.' : 'Editing puts this persona on first.'}</span>
                <div class="k-mkt-preview-actions">
                    <button type="button" class="k-lib-btn k-lib-btn--ghost k-ps-sheet-edit" ?disabled=${this._busy} @click=${() => { void this.#act('edit'); }}>${icons.edit}<span>Edit</span></button>
                    ${wear}
                </div>
            </footer>`;
    }
}

if (!customElements.get('k-persona-sheet')) {
    customElements.define('k-persona-sheet', KPersonaSheet);
}
