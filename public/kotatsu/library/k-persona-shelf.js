/**
 * `<k-persona-shelf variant="gallery">` — Your personas, the library's third view
 * (`docs/persona-gallery-v0.md` §1, slice P1a). `<k-library>` renders it in place of the
 * cast's continue strip, tools and grid, exactly the way `<k-market>` takes Browse.
 *
 * COPY CORE'S DATA, NEVER KEEP A SECOND COPY (the `k-persona-menu.js` doctrine):
 *
 * - The list is `power_user.personas`, descriptors are `power_user.persona_descriptions`, the
 *   persona you're wearing is `user_avatar` (`personas.js:108`, a live `export let`) — all read
 *   fresh on every refresh and handed to the pure `persona-view-model.js` as a snapshot.
 * - Wearing goes THROUGH `setUserAvatar(id)` (`personas.js:154`), the function the stock grid
 *   and the rail chip already call: same persistence, same `PERSONA_CHANGED`, same first-
 *   message retrigger on an empty chat.
 * - The sort is core's own `power_user.persona_sort_order`, so this shelf and the stock grid
 *   describe one setting (the stock select re-reads it on its next render, `personas.js:222`).
 * - Search is our own. Driving `personasFilter` (`personas.js:111`) would re-render the stock
 *   grid behind the reader's back.
 *
 * A poster click opens `<k-persona-sheet>` (slice P1b), the read-only detail view; Wear lives
 * there. Edit opens `<k-persona-studio>` (slice P2), which wears the persona first: core's
 * editor only ever edits `user_avatar`, which is doc §0's "editing puts it on" decision. The sheet is mounted on
 * `document.body` (the market preview's stacking-context lesson) and removed with the shelf.
 *
 * Light DOM for the reasons every kotatsu component gives; `public/css/library.css` owns the
 * rules (the shelf reuses the cast's `.k-lib-*` classes and adds `.k-ps-*` for its own bits).
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters, chat_metadata, getThumbnailUrl, saveSettingsDebounced, this_chid } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { groups, selected_group } from '../../scripts/group-chats.js';
import { getConnectedPersonas, isPersonaConnectionLocked, setUserAvatar, user_avatar } from '../../scripts/personas.js';
import { power_user } from '../../scripts/power-user.js';
import { openSettings } from '../settings/k-settings-modal.js';
import { openPersonaStudio } from '../studio/k-persona-studio.js';
import { VARIANTS_CHANGED_EVENT, readVariantContext } from './persona-variants-runtime.js';
import { PORTRAIT_REPLACED_EVENT, bustedUrl, portraitBust } from './persona-portraits.js';
import { renderCard } from './k-library.js';
import './k-persona-sheet.js';
import {
    buildPersonaRows,
    filterPersonaRows,
    sortPersonaRows,
    tiedPersonaRows,
} from './persona-view-model.js';

/** @typedef {import('./persona-view-model.js').PersonaRow} PersonaRow */
/** @typedef {import('./persona-view-model.js').PersonaSnapshot} PersonaSnapshot */

/** Core events after which a persona row may be stale. Names resolved defensively, like the chip. */
const REFRESH_EVENTS = [
    'PERSONA_CHANGED',
    'PERSONA_CREATED',
    'PERSONA_UPDATED',
    'PERSONA_RENAMED',
    'PERSONA_DELETED',
    'SETTINGS_UPDATED',
    'SETTINGS_LOADED_AFTER',
    // The "Tied to" strip and the lock badges depend on what is open.
    'CHAT_CHANGED',
];

/** Coalescing window for bursty core events, matching `<k-library>`. */
const REFRESH_DEBOUNCE_MS = 80;

/** Core's two persona sorts, labelled the way the cast's menu labels its name pair. */
const SORT_OPTIONS = Object.freeze([
    { value: 'asc', label: 'A–Z' },
    { value: 'desc', label: 'Z–A' },
]);

const searchIcon = html`
    <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
         stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13.5 13.5" />
    </svg>`;

const gearIcon = html`
    <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
         stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
         aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="2.1" /><path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1" />
    </svg>`;

/**
 * Reads core's persona state into a plain snapshot. The only function in this file that
 * touches core state directly, so the probe surface ({@link KPersonaShelf.state}) and the
 * renderer agree by construction.
 * @returns {PersonaSnapshot} The snapshot.
 */
export function readPersonaSnapshot() {
    let tiedIds = [];
    try {
        // Defaults to the open character / group (`personas.js:1674`); nothing open → nothing tied.
        tiedIds = (selected_group || this_chid !== undefined) ? getConnectedPersonas() : [];
    } catch (error) {
        console.warn('[k-persona-shelf] connection read failed', error);
    }
    return {
        personas: power_user?.personas ?? {},
        descriptions: power_user?.persona_descriptions ?? {},
        current: typeof user_avatar === 'string' ? user_avatar : '',
        defaultId: typeof power_user?.default_persona === 'string' ? power_user.default_persona : '',
        chatPersona: typeof chat_metadata?.persona === 'string' ? chat_metadata.persona : '',
        tiedIds,
        variantContext: readVariantContext(),
        bustFor: portraitBust,
        isLockedHere: (connection) => {
            try {
                return Boolean(isPersonaConnectionLocked(connection));
            } catch {
                return false;
            }
        },
    };
}

/** @returns {string} The open character's or scene's name, `''` when nothing is open. */
function openEntityName() {
    if (selected_group) {
        const group = groups.find(entry => entry?.id === selected_group);
        return String(group?.name ?? '').trim();
    }
    if (this_chid !== undefined) {
        return String(characters[Number(this_chid)]?.name ?? '').trim();
    }
    return '';
}

export class KPersonaShelf extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `gallery` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _rows: { state: true },
        _search: { state: true },
        _tiedTo: { state: true },
    };

    /** @type {string[]} Resolved core event names this element is subscribed to. */
    #bound = [];

    /** @type {number} `setTimeout` handle for the coalesced refresh, 0 = idle. */
    #refreshTimer = 0;

    /** Bound once so the subscription can be removed by identity. */
    #onCoreChange = () => this.#scheduleRefresh();

    /** A variant edit (the studio, the chip) changes counts; a replaced portrait changes art. */
    #onVariantsChanged = () => this.#scheduleRefresh();

    /** @type {import('./k-library.js').CardHandlers} Built once; see `<k-library>`'s note. */
    #cardHandlers;

    /** @type {import('./k-persona-sheet.js').KPersonaSheet|null} The detail sheet, a body child. */
    #sheet = null;

    /** @type {PersonaRow[]} Rows in on-screen order as of the last render: the sheet walks these. */
    #order = [];

    constructor() {
        super();
        this.#cardHandlers = {
            onOpen: (row) => { this.openSheet(String(row.id)); },
            onEdit: (row) => { void this.edit(String(row.id)); },
        };
        /** @type {string} */
        this.variant = 'gallery';
        /** @type {PersonaRow[]} */
        this._rows = [];
        /** @type {string} */
        this._search = '';
        /** @type {string} */
        this._tiedTo = '';
    }

    /** Light DOM: `public/css/library.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        for (const key of REFRESH_EVENTS) {
            const name = event_types ? /** @type {Record<string, string>} */ (event_types)[key] : undefined;
            if (typeof name !== 'string' || this.#bound.includes(name)) continue;
            eventSource.on(name, this.#onCoreChange);
            this.#bound.push(name);
        }
        const sheet = /** @type {import('./k-persona-sheet.js').KPersonaSheet} */ (document.createElement('k-persona-sheet'));
        sheet.setAttribute('variant', 'sheet');
        sheet.onWear = (id) => this.wear(id);
        sheet.onEdit = (id) => this.edit(id);
        document.body.appendChild(sheet);
        this.#sheet = sheet;
        document.addEventListener(VARIANTS_CHANGED_EVENT, this.#onVariantsChanged);
        document.addEventListener(PORTRAIT_REPLACED_EVENT, this.#onVariantsChanged);
        // No readiness latch needed: core warms `power_user.personas` during boot
        // (`getUserAvatars(true, …)` → `addMissingPersonas()`), and this shelf only mounts when
        // the reader asks for it, long after.
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this.#bound) {
            eventSource.removeListener(name, this.#onCoreChange);
        }
        this.#bound = [];
        if (this.#refreshTimer !== 0) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = 0;
        }
        this.#sheet?.remove();
        this.#sheet = null;
        document.removeEventListener(VARIANTS_CHANGED_EVENT, this.#onVariantsChanged);
        document.removeEventListener(PORTRAIT_REPLACED_EVENT, this.#onVariantsChanged);
        super.disconnectedCallback();
    }

    #scheduleRefresh() {
        if (this.#refreshTimer !== 0) clearTimeout(this.#refreshTimer);
        this.#refreshTimer = window.setTimeout(() => {
            this.#refreshTimer = 0;
            this.refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    /** Re-reads core. Public so a probe (or a caller that just changed core) can force it. @returns {void} */
    refresh() {
        try {
            const thumbFor = (/** @type {string} */ id) => bustedUrl(getThumbnailUrl('persona', id), id);
            this._rows = buildPersonaRows(readPersonaSnapshot(), thumbFor);
        } catch (error) {
            console.error('[k-persona-shelf] persona read failed', error);
            this._rows = [];
        }
        this._tiedTo = openEntityName();
    }

    /**
     * Wears a persona. A no-op for the one already on.
     * @param {string} id Avatar id.
     * @returns {Promise<void>}
     */
    async wear(id) {
        if (!id || id === user_avatar) return;
        try {
            await setUserAvatar(id);
        } catch (error) {
            console.error('[k-persona-shelf] persona switch failed', error);
        }
        // PERSONA_CHANGED already schedules one; this covers a throw before the emit.
        this.refresh();
    }

    /**
     * Opens the read-only detail sheet on a persona, walking the shelf's on-screen order.
     * @param {string} id Avatar id.
     * @returns {void}
     */
    openSheet(id) {
        if (!this.#sheet) return;
        this.#syncSheet();
        this.#sheet.show(id);
    }

    /** @returns {import('./k-persona-sheet.js').KPersonaSheet|null} The sheet, for the probe. */
    get sheet() {
        return this.#sheet;
    }

    /** Hands the sheet the rows as drawn. Called after every render and before opening. @returns {void} */
    #syncSheet() {
        if (!this.#sheet) return;
        this.#sheet.rows = this.#order;
        this.#sheet.tiedTo = this._tiedTo;
    }

    /** @returns {void} */
    updated() {
        this.#syncSheet();
    }

    /**
     * Edit: the persona studio (slice P2), which wears the persona first (doc §0 "editing puts
     * it on"). Settings → Personas stays the fallback for a studio that can't open here.
     * @param {string} id Avatar id.
     * @returns {Promise<void>}
     */
    async edit(id) {
        const studio = await openPersonaStudio(id);
        if (!studio) {
            await this.wear(id);
            openSettings({ tab: 'personas' });
        }
        this.refresh();
    }

    /** @returns {{ rows: number, visible: number, tied: number, current: string, search: string, sort: string, tiedTo: string }} Probe surface. */
    get state() {
        const visible = filterPersonaRows(this._rows, this._search);
        return {
            rows: this._rows.length,
            visible: visible.length,
            tied: tiedPersonaRows(visible).length,
            current: this._rows.find(row => row.current)?.id?.toString() ?? '',
            search: this._search,
            sort: this.#sortOrder(),
            tiedTo: this._tiedTo,
        };
    }

    /** @returns {string} Core's persona sort, normalised. */
    #sortOrder() {
        return power_user?.persona_sort_order === 'desc' ? 'desc' : 'asc';
    }

    /** @param {Event} event Change event from the sort select. @returns {void} */
    #onSortChange(event) {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement)) return;
        const value = select.value === 'desc' ? 'desc' : 'asc';
        if (power_user.persona_sort_order === value) return;
        power_user.persona_sort_order = value;
        saveSettingsDebounced();
        this.requestUpdate();
    }

    /** @param {Event} event Input event from the search box. @returns {void} */
    #onSearchInput(event) {
        const input = event.target;
        if (input instanceof HTMLInputElement) {
            this._search = input.value;
        }
    }

    render() {
        const sort = this.#sortOrder();
        const visible = sortPersonaRows(filterPersonaRows(this._rows, this._search), sort);
        const tied = this._tiedTo ? tiedPersonaRows(visible) : [];
        const rest = tied.length ? visible.filter(row => !row.tied) : visible;
        this.#order = [...tied, ...rest];
        return html`
            ${this.#renderTools(sort)}
            ${this.#renderBody(visible, tied, rest)}
            <div class="k-ps-foot">
                <button type="button" class="k-lib-btn k-lib-btn--ghost k-ps-settings"
                    @click=${() => openSettings({ tab: 'personas' })}
                >${gearIcon}<span>Persona settings</span></button>
                <span class="k-ps-foot-hint">Backup, restore, usage stats and the finer locks live there.</span>
            </div>`;
    }

    /**
     * @param {string} sort The active sort.
     * @returns {unknown} Search box and sort select (no tabs: personas have no favourites).
     */
    #renderTools(sort) {
        // Selection per OPTION, not `.value` on the select — `<k-library>`'s tools note.
        return html`
            <div class="k-lib-tools">
                <label class="k-lib-search">
                    ${searchIcon}
                    <input
                        class="k-lib-search-input"
                        type="search"
                        placeholder="Search your personas…"
                        aria-label="Search your personas"
                        .value=${this._search}
                        @input=${(/** @type {Event} */ event) => this.#onSearchInput(event)}
                    />
                </label>
                <span class="k-ps-count" aria-live="polite">${this._rows.length} ${this._rows.length === 1 ? 'persona' : 'personas'}</span>
                <select class="k-lib-sort" aria-label="Sort order" @change=${(/** @type {Event} */ event) => this.#onSortChange(event)}>
                    ${SORT_OPTIONS.map(option => html`<option value=${option.value} .selected=${option.value === sort}>${option.label}</option>`)}
                </select>
            </div>`;
    }

    /**
     * @param {PersonaRow[]} visible Rows after search, sorted.
     * @param {PersonaRow[]} tied The "Tied to" subset, empty when nothing is open.
     * @param {PersonaRow[]} rest Everyone not in the tied strip.
     * @returns {unknown} The strip and the grid, or an honest empty state.
     */
    #renderBody(visible, tied, rest) {
        if (visible.length === 0) {
            // Two silences, like the cast: a search that missed, and a table nobody sits at yet.
            const searching = this._rows.length > 0;
            return html`
                <div class="k-lib-empty">
                    <p class="k-lib-empty-title">${searching ? 'No face matches that.' : 'Nobody is sitting on your side yet.'}</p>
                    <p class="k-lib-empty-sub">${searching ? 'Try another search, or make a new persona.' : 'A persona is who you are in a chat: a name, a face, a few lines about you.'}</p>
                </div>`;
        }
        const tiedStrip = tied.length
            ? html`
                <section class="k-ps-tied" aria-label=${`Tied to ${this._tiedTo}`}>
                    <h2 class="k-lib-sectiontitle">Tied to ${this._tiedTo}</h2>
                    <div class="k-lib-grid">${tied.map(row => renderCard(row, this.#cardHandlers))}</div>
                </section>`
            : nothing;
        const restTitle = tied.length && rest.length
            ? html`<h2 class="k-lib-sectiontitle">Everyone else</h2>`
            : nothing;
        const grid = rest.length
            ? html`<div class="k-lib-grid">${rest.map(row => renderCard(row, this.#cardHandlers))}</div>`
            : nothing;
        return html`
            ${tiedStrip}
            <section class="k-ps-all">
                ${restTitle}
                ${grid}
            </section>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-persona-shelf')) {
    customElements.define('k-persona-shelf', KPersonaShelf);
}
