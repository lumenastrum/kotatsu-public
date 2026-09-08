/**
 * `<k-preset-pages>` — the Prompt dock's sub-page strip (preset dock v0).
 *
 * Sauce · Dials · Rack, per `docs/preset-dock-v0.md`. The component renders
 * three filter buttons and tags the panel's content blocks; `css/preset-dock.css`
 * does every hide. **No node is ever relocated** — the panel is filtered in
 * place, so every `#id` lookup, descendant query and delegated handler core or
 * an extension owns keeps working untouched.
 *
 * Contracts this component honours:
 *
 * - **Gated on `.k-docked`.** Every CSS rule requires the dock marker, so the
 *   classic layout renders the stock panel with the strip hidden. The tags and
 *   the page attribute are inert data outside the rail.
 * - **Unknown content is never hidden.** Only blocks this file tags can be
 *   filtered, and the fallback tags stray children of the two chat-completion
 *   containers as `rack`. Other APIs' blocks stay untagged and show on every
 *   page — the stock unpaged panel, by design.
 * - **Anchors, not order.** Blocks resolve from stable control ids via
 *   `closest()`, never from child position — core reorders its panel freely.
 * - **SPEC §13** — `variant="pills"` is the only v0 variant; the attribute is
 *   present so a pack can address a second one later.
 * - **Light DOM** so `css/preset-dock.css` reaches the strip and the panel
 *   with one sheet, same reasoning as `k-tab-rail`.
 */

import { html, LitElement } from '../lit.js';

/** The pages, in strip order. Slugs are pinned in docs/preset-dock-v0.md. */
const PAGES = [
    { id: 'sauce', label: 'Sauce' },
    { id: 'dials', label: 'Dials' },
    { id: 'rack', label: 'Rack' },
];

/** @type {string} */
const DEFAULT_PAGE = 'sauce';

/** localStorage key, same lane as `kotatsu.rails`. */
const STORAGE_KEY = 'kotatsu.presetDock.page';

/** The attribute a classified block wears. */
const SECT_ATTR = 'data-k-dock-sect';

/** The attribute the panel wears for the active page. */
const PAGE_ATTR = 'data-k-dock-page';

/**
 * Anchor → block map. `sel` must exist for the tag to land; a missing anchor
 * is skipped silently (an absent upstream control is not an error). `block` is
 * the `closest()` selector resolving the enclosing block to tag.
 * @type {{sel: string, page: string, block: string}[]}
 */
const ANCHORS = [
    { sel: '#openai_api-presets', page: 'sauce', block: '#openai_api-presets' },
    { sel: '#completion_prompt_manager', page: 'sauce', block: '#openai_settings > div' },

    { sel: '#oai_max_context_unlocked', page: 'dials', block: '.range-block' },
    { sel: '#openai_max_context', page: 'dials', block: '.range-block' },
    { sel: '#openai_max_tokens', page: 'dials', block: '.range-block' },
    { sel: '#temp_openai', page: 'dials', block: '.range-block' },
    { sel: '#freq_pen_openai', page: 'dials', block: '.range-block' },
    { sel: '#pres_pen_openai', page: 'dials', block: '.range-block' },
    { sel: '#top_k_openai', page: 'dials', block: '.range-block' },
    { sel: '#top_p_openai', page: 'dials', block: '.range-block' },
    { sel: '#repetition_penalty_openai', page: 'dials', block: '.range-block' },
    { sel: '#min_p_openai', page: 'dials', block: '.range-block' },
    { sel: '#top_a_openai', page: 'dials', block: '.range-block' },
    { sel: '#seed_openai', page: 'dials', block: '.range-block' },

    { sel: '#stream_toggle', page: 'rack', block: '.range-block' },
    { sel: '#n_openai', page: 'rack', block: '.range-block' },
    { sel: '#openrouter_middleout', page: 'rack', block: '.range-block' },
    { sel: '#main_prompt_quick_edit_textarea', page: 'rack', block: '.inline-drawer' },
    { sel: '#impersonation_prompt_restore', page: 'rack', block: '.inline-drawer' },
    { sel: '#use_sysprompt', page: 'rack', block: '#openai_settings > div' },
    { sel: '#openai_logit_bias_preset', page: 'rack', block: '#openai_settings > div' },
];

/**
 * Containers whose UNTAGGED direct children default to `rack` — the cost
 * readouts, `<hr>`s and whatever upstream adds next land behind the rack door
 * instead of floating on every page.
 * @type {string[]}
 */
const FALLBACK_CONTAINERS = ['#range_block_openai', '#openai_settings'];

/**
 * @returns {string} The persisted page, or the default.
 */
function readStoredPage() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && PAGES.some(page => page.id === stored)) {
            return stored;
        }
    } catch {
        // Storage can be denied; the default is a fine life.
    }
    return DEFAULT_PAGE;
}

/**
 * @param {string} id Page slug to persist.
 * @returns {void}
 */
function storePage(id) {
    try {
        localStorage.setItem(STORAGE_KEY, id);
    } catch {
        // Same story as above.
    }
}

/**
 * The strip: three filter buttons over an attribute-filtered panel.
 */
export class KPresetPages extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `pills` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _active: { state: true },
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'pills';
        /** @type {string} */
        this._active = readStoredPage();
    }

    /** Light DOM: `css/preset-dock.css` owns every rule. See the file header. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        this.#classify();
        this.#apply(this._active);
    }

    /**
     * Tags every resolvable block with its page. Idempotent — re-running after
     * a layout remount re-lands the same attributes on the same nodes.
     * @returns {void}
     */
    #classify() {
        for (const anchor of ANCHORS) {
            const control = document.querySelector(anchor.sel);
            const block = control?.closest(anchor.block);
            if (block instanceof HTMLElement) {
                block.setAttribute(SECT_ATTR, anchor.page);
            }
        }
        for (const containerSel of FALLBACK_CONTAINERS) {
            const container = document.querySelector(containerSel);
            if (!container) {
                continue;
            }
            for (const child of container.children) {
                if (child instanceof HTMLElement && !child.hasAttribute(SECT_ATTR)) {
                    child.setAttribute(SECT_ATTR, 'rack');
                }
            }
        }
    }

    /**
     * Sets the active page on the component and the panel. The CSS keys every
     * filter on the panel attribute + `.k-docked`, so this is the whole switch.
     * @param {string} id Page slug.
     * @returns {void}
     */
    #apply(id) {
        this._active = id;
        const panel = this.closest('#left-nav-panel');
        if (panel instanceof HTMLElement) {
            panel.setAttribute(PAGE_ATTR, id);
        }
    }

    /**
     * @param {string} id Page slug.
     * @returns {void}
     */
    #select(id) {
        if (!PAGES.some(page => page.id === id) || id === this._active) {
            return;
        }
        this.#apply(id);
        storePage(id);
    }

    /** @returns {unknown} The strip. */
    render() {
        return html`
            <div class="k-pp-strip" role="group" aria-label="Prompt dock pages">
                ${PAGES.map(page => html`
                    <button
                        type="button"
                        class="k-pp-seg${page.id === this._active ? ' is-active' : ''}"
                        aria-pressed=${page.id === this._active ? 'true' : 'false'}
                        @click=${() => this.#select(page.id)}
                    >${page.label}</button>`)}
            </div>`;
    }
}

if (!customElements.get('k-preset-pages')) {
    customElements.define('k-preset-pages', KPresetPages);
}

/**
 * Mounts the strip as `#left-nav-panel`'s first element child, once. Under
 * classic the strip is CSS-hidden and the tags are inert, so the mount is
 * layout-independent — it travels with the panel wherever `k-tab-rail` docks
 * it, exactly like the prompt manager itself does.
 * @returns {void}
 */
export function initPresetDock() {
    const panel = document.getElementById('left-nav-panel');
    if (!panel) {
        console.warn('[k-preset-pages] #left-nav-panel is missing; preset dock pages not mounted');
        return;
    }
    if (panel.querySelector('k-preset-pages')) {
        return;
    }
    panel.prepend(document.createElement('k-preset-pages'));
}
