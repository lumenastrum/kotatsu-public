/**
 * Kotatsu shell — "Your settings changed on another device" (docs/phone-v0.md §5.4).
 *
 * Settings saves are diffs now (`public/scripts/settings-diff.js` → `/api/settings/patch`), so a
 * stale tab no longer erases what another device saved: the server merges both. What the stale
 * tab still lacks is the other device's changes *on screen*. When a patch lands on a file this
 * tab did not last see, core's `saveSettings()` dispatches `kotatsu:settings-foreign` on
 * `document` (a DOM event, so core never imports Kotatsu) and this notice says so.
 *
 * Non-blocking and honest: nothing was lost either way. **Reload** saves first (one more
 * `saveSettings()`, which queues behind any save in flight and flushes a pending debounced
 * change), then reloads. **Later** hides it for the rest of this page.
 *
 * `<k-sync-notice variant="banner">`, the `ext-guard.js` shape: Lit, light DOM,
 * `css/shell-sync-notice.css` owns every rule, fixed under the top bar at stock's rung + 1
 * (3006). Rails only, installed by `layouts/rails.js`.
 *
 * Console door: `window.kotatsu.syncNotice` (`state`).
 */

import { LitElement, html, nothing } from './lit.js';
import { saveSettings } from '../../script.js';

/** The DOM event core's `saveSettings()` dispatches on `document` (`public/script.js`). */
export const SETTINGS_FOREIGN_EVENT = 'kotatsu:settings-foreign';

/** Stock's `#top-bar` rung is 3005; the notice sits just above it, like the extension guard. */
export const SYNC_NOTICE_Z = 3006;

let installed = false;
/** "Later" was chosen: stays hidden for the life of this page. */
let dismissedForPage = false;
/** How many foreign patches this page has seen (for the console door and the probe). */
let foreignCount = 0;

/** @returns {HTMLElement|null} The banner, mounted on first need. */
function banner() {
    let element = document.querySelector('k-sync-notice');
    if (!element) {
        element = document.createElement('k-sync-notice');
        element.setAttribute('variant', 'banner');
        document.body.appendChild(element);
    }
    return element instanceof HTMLElement ? element : null;
}

/** @returns {void} */
function onForeign() {
    foreignCount++;
    if (!installed || dismissedForPage) return;
    const element = /** @type {any} */ (banner());
    if (element) element.open = true;
}

/** @returns {void} */
export function installSyncNotice() {
    if (installed) return;
    installed = true;
    defineSyncNotice();
    document.addEventListener(SETTINGS_FOREIGN_EVENT, onForeign);

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') targetWindow.kotatsu = {};
    targetWindow.kotatsu.syncNotice = {
        get state() {
            return { foreign: foreignCount, dismissed: dismissedForPage, shown: !!document.querySelector('k-sync-notice[open]') };
        },
    };
}

/** @returns {void} */
export function uninstallSyncNotice() {
    if (!installed) return;
    installed = false;
    document.removeEventListener(SETTINGS_FOREIGN_EVENT, onForeign);
    document.querySelector('k-sync-notice')?.remove();
    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (targetWindow.kotatsu) delete targetWindow.kotatsu.syncNotice;
}

/** The notice. Light DOM; `css/shell-sync-notice.css` owns every rule. */
export class KSyncNotice extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        open: { type: Boolean, reflect: true },
        _busy: { state: true },
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'banner';
        /** @type {boolean} */
        this.open = false;
        /** @type {boolean} */
        this._busy = false;
    }

    createRenderRoot() {
        return this;
    }

    /** Lets every queued save land (and flushes a pending one), then reloads. @returns {Promise<void>} */
    async #reload() {
        if (this._busy) return;
        this._busy = true;
        try {
            await saveSettings();
        } catch (error) {
            console.error('[k-sync-notice] save before reload failed', error);
        }
        location.reload();
    }

    /** Hidden for the rest of this page. @returns {void} */
    #later() {
        dismissedForPage = true;
        this.open = false;
    }

    render() {
        if (!this.open) return nothing;
        return html`
            <div class="k-sn" role="status">
                <p class="k-sn-line">Your settings changed on another device. <span class="k-sn-why">Reload to see them here.</span></p>
                <div class="k-sn-actions">
                    <button type="button" class="k-sn-btn k-sn-btn--primary k-sn-reload" ?disabled=${this._busy} @click=${() => { void this.#reload(); }}>${this._busy ? 'Reloading…' : 'Reload'}</button>
                    <button type="button" class="k-sn-btn k-sn-later" ?disabled=${this._busy} @click=${() => this.#later()}>Later</button>
                </div>
            </div>`;
    }
}

/** @returns {void} */
function defineSyncNotice() {
    if (!customElements.get('k-sync-notice')) customElements.define('k-sync-notice', KSyncNotice);
}
