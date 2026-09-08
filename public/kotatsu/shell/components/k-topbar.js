/*
 * <k-topbar> — the rails top bar (shell v0, slice E).
 *
 * Spec: `docs/shell-v0.md` §"The target" (top-bar numbers) and §"The slot contract".
 * Ground truth for every core read below: `docs/shell-v0-recon.md`.
 *
 * Three zones, left to right:
 *   left    glow dot + `kotatsu` wordmark
 *   center  the command pill — INERT in v0. It is rendered, it is pretty, it opens
 *           nothing. Not focusable, not a form control, `aria-disabled`. The palette
 *           itself is an explicit non-goal of v0.
 *   right   `<k-model-menu>` (the model pill grown into the compact picker — that
 *           component owns the pill, the status dot and the popover; see its
 *           header), `<k-update-pill>` (ship-v0 slice B — hidden unless the release
 *           mirror has moved; it owns its own visibility), context pill (limit only,
 *           see below), settings gear
 *
 * Light DOM on purpose: `createRenderRoot()` returns `this` so `css/shell-topbar.css`
 * reaches the internals, `body[data-k-layout="rails"]` still gates every rule, and
 * `initDynamicStyles()` (dynamic-styles.js:188-202) can see the hover/focus-visible
 * pairs it audits. A shadow root would hide all three.
 *
 * Core reads (one-way, kotatsu → core):
 *   `main_api`             script.js:628   — live `export let`
 *   `getMaxContextTokens()` script.js:5903 — full context window for the current API
 *
 * NEVER fake a number: the context pill renders the LIMIT alone, only when `main_api`
 * is one of the five families `getMaxContextTokens()` actually has a branch for. Its
 * `return 1487` fallthrough is a joke default, not data — the allowlist below exists to
 * keep it off screen. Current usage (`N tok`) is not exposed anywhere cheap, so v0
 * simply does not claim it.
 *
 * Boot order: this may mount before settings load. Every read is guarded, every empty
 * value renders as a muted em-dash, and the bar re-reads on the core events below —
 * `APP_READY` is an auto-fire event (lib/eventemitter.js:56-58), so a late listener is
 * replayed immediately and the bar fills in even if it mounted after boot finished.
 */

import { LitElement, html, nothing } from '../lit.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { getMaxContextTokens, main_api } from '../../../script.js';
// Side-effect import: defines <k-model-menu>, rendered in the right zone below.
import './k-model-menu.js';
// Side-effect import: defines <k-update-pill> (ship-v0 slice B). It renders itself
// hidden unless the release mirror has actually moved, so on every dev clone and on
// every current install this adds one empty element to the right zone and nothing else.
import './k-update-pill.js';

/**
 * The `main_api` values `getMaxContextTokens()` (script.js:5903) has a real branch for.
 * Anything else falls through to its `1487` default, which is not a context window.
 */
const CONTEXT_APIS = new Set(['kobold', 'koboldhorde', 'textgenerationwebui', 'novel', 'openai']);

/**
 * `event_types` keys that mean "the connection or the model may have moved".
 * Looked up by key and skipped when absent so an upstream rename degrades to one
 * dead listener instead of a boot crash.
 */
const REFRESH_EVENTS = [
    'APP_READY',
    'SETTINGS_LOADED_AFTER',
    'SETTINGS_UPDATED',
    'ONLINE_STATUS_CHANGED',
    'CHATCOMPLETION_SOURCE_CHANGED',
    'CHATCOMPLETION_MODEL_CHANGED',
    'OAI_PRESET_CHANGED_AFTER',
    'PRESET_CHANGED',
    'CONNECTION_PROFILE_LOADED',
];

/**
 * The mockup ships the macOS glyph pair. Kotatsu is Windows-first, so the hint follows
 * the platform it is actually being read on. Cosmetic either way — the pill is inert.
 */
const COMMAND_HINT = /mac|iphone|ipad|ipod/i.test(navigator.userAgent || '') ? '⌘K' : 'Ctrl K';

/**
 * Compact token count for the context pill: 200000 → `200k`, 8192 → `8.2k`, 900 → `900`.
 * The exact figure stays on the pill's `title`, so the rounding never hides the truth.
 * @param {number} n Token count.
 * @returns {string} Short form.
 */
function shortTokens(n) {
    if (n < 1000) {
        return String(n);
    }
    const k = n / 1000;
    const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
    return `${rounded}k`;
}

/**
 * The current API's full context window, or null when there is nothing honest to show.
 * @returns {number | null} Token limit.
 */
function readContextLimit() {
    if (!CONTEXT_APIS.has(main_api)) {
        return null;
    }
    try {
        const limit = getMaxContextTokens();
        return Number.isFinite(limit) && limit > 0 ? limit : null;
    } catch {
        // NovelAI's branch dereferences `nai_settings.model_novel` — undefined pre-settings.
        return null;
    }
}

/**
 * @returns {unknown} Magnifier glyph.
 */
function searchIcon() {
    return html`
        <svg class="k-topbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="10.6" cy="10.6" r="6.4"></circle>
            <line x1="15.4" y1="15.4" x2="20" y2="20"></line>
        </svg>
    `;
}

/**
 * Branch: two nodes on a trunk plus one on a limb. Same stroke weight and the same
 * 24-box as the gear so the pair reads as one set. Drawn here for the same reason —
 * no Font Awesome, no emoji (repo CLAUDE.md).
 * @returns {unknown} Branch glyph.
 */
function branchIcon() {
    return html`
        <svg class="k-topbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="5" r="2.4"></circle>
            <circle cx="7" cy="19" r="2.4"></circle>
            <circle cx="17" cy="9.5" r="2.4"></circle>
            <line x1="7" y1="7.4" x2="7" y2="16.6"></line>
            <path d="M14.6 9.5h-2.2A5.4 5.4 0 0 0 7 14.9"></path>
        </svg>
    `;
}

/**
 * Gear: hub, rim, and eight spokes. Drawn here rather than pulled from an icon set —
 * no Font Awesome, no emoji (repo CLAUDE.md).
 * @returns {unknown} Gear glyph.
 */
function gearIcon() {
    return html`
        <svg class="k-topbar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="2.6"></circle>
            <circle cx="12" cy="12" r="6"></circle>
            <line x1="18" y1="12" x2="20.6" y2="12"></line>
            <line x1="16.24" y1="16.24" x2="18.08" y2="18.08"></line>
            <line x1="12" y1="18" x2="12" y2="20.6"></line>
            <line x1="7.76" y1="16.24" x2="5.92" y2="18.08"></line>
            <line x1="6" y1="12" x2="3.4" y2="12"></line>
            <line x1="7.76" y1="7.76" x2="5.92" y2="5.92"></line>
            <line x1="12" y1="6" x2="12" y2="3.4"></line>
            <line x1="16.24" y1="7.76" x2="18.08" y2="5.92"></line>
        </svg>
    `;
}

/**
 * The rails top bar.
 */
export class KTopBar extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _ctxLimit: { state: true },
    };

    constructor() {
        super();
        /** @type {string} Theme-pack variant hook (SPEC §13). v0 ships one: `bar`. */
        this.variant = 'bar';
        /** @type {number | null} Context window, or null when nothing real is available. */
        this._ctxLimit = null;
        /** @type {() => void} */
        this._onCoreChange = () => this.refresh();
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
        // Guarantee the variant hook is on the element from the first frame, whether or
        // not the mounting slice authored it, without waiting for Lit's reflection pass.
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
        this.refresh();
    }

    disconnectedCallback() {
        for (const name of this._boundEvents) {
            eventSource.removeListener(name, this._onCoreChange);
        }
        this._boundEvents = [];
        super.disconnectedCallback();
    }

    /**
     * Re-reads connection state from core. Never throws: a bar that crashes at boot
     * takes the whole layout with it.
     */
    refresh() {
        this._ctxLimit = readContextLimit();
    }

    render() {
        return html`
            <div class="k-topbar__zone k-topbar__zone--left">
                <span class="k-topbar__glow" aria-hidden="true"></span>
                <span class="k-topbar__wordmark">kotatsu</span>
            </div>
            <div class="k-topbar__zone k-topbar__zone--center">
                ${this._renderCommandPill()}
            </div>
            <div class="k-topbar__zone k-topbar__zone--right">
                <k-model-menu></k-model-menu>
                <k-update-pill variant="rail"></k-update-pill>
                ${this._renderContextPill()}
                <button type="button" class="k-topbar__gear" aria-label="Open branch map"
                    title="Branch map (Ctrl+Shift+B)" @click=${() => this._openBranchMap()}>${branchIcon()}</button>
                <button type="button" class="k-topbar__gear" aria-label="Open settings"
                    title="Settings" @click=${() => this._openSettings()}>${gearIcon()}</button>
            </div>
        `;
    }

    /**
     * The centerpiece. Deliberately not an `<input>` and deliberately not focusable —
     * v0 has no command palette and the bar must not pretend otherwise.
     * @returns {unknown} Command pill.
     */
    _renderCommandPill() {
        return html`
            <div class="k-cmd" role="button" aria-disabled="true"
                title="Command palette — coming soon">
                ${searchIcon()}
                <span class="k-cmd__placeholder">Jump to chat, branch, preset, or /command</span>
                <span class="k-cmd__hint">${COMMAND_HINT}</span>
            </div>
        `;
    }

    /**
     * Limit only, and only when it is real. See the file header.
     * @returns {unknown} Context pill, or nothing.
     */
    _renderContextPill() {
        const limit = this._ctxLimit;
        if (limit === null) {
            return nothing;
        }
        return html`
            <div class="k-pill k-pill--ctx" title="Max context: ${limit} tokens">
                <span class="k-pill__ctx-value">${shortTokens(limit)}</span>
                <span class="k-pill__ctx-unit">ctx</span>
            </div>
        `;
    }

    /**
     * Hands settings to whoever owns it — `<k-settings-modal>` since settings v0
     * slice B, the drawer-rack overlay before that. This component knows nothing
     * about either. No `detail`, so the event keeps its toggle reading; a caller
     * that wants a specific tab passes `{ detail: { tab } }` instead.
     */
    _openSettings() {
        this.dispatchEvent(new CustomEvent('k-open-settings', { bubbles: true, composed: true }));
    }

    /**
     * Hands the branch forest to whoever owns it — the same shape as the gear.
     * The event is the rail's too (branch panel v0 slice C/D), so the bar stays
     * ignorant of `<k-branch-map>` and of the store behind it. Reuses the
     * `.k-topbar__gear` class deliberately: the affordances are the same size
     * and the same ghost-button treatment, and one class means one place to
     * restyle them (`css/shell-topbar.css:287-318`).
     */
    _openBranchMap() {
        this.dispatchEvent(new CustomEvent('k-open-branch-map', { bubbles: true, composed: true }));
    }
}

if (!customElements.get('k-topbar')) {
    customElements.define('k-topbar', KTopBar);
}
