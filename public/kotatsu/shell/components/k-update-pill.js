/*
 * <k-update-pill> — "there is a newer Kotatsu" in the rails top bar (ship-v0 slice B).
 *
 * Spec: `docs/ship-v0.md` decision 5, "Update = `git pull` with a face". Backend:
 * `src/endpoints/kotatsu/update.js`. Design language: the top bar's own chips
 * (`css/shell-topbar.css` §4) — same height, same radius, same hairline, so the pill
 * reads as a member of the right zone rather than a banner parked in it.
 *
 * The whole state machine, in the order a user meets it:
 *   hidden      the common case. No newer commit, or the origin guard stood the
 *               feature down (every dev clone). Nothing is rendered at all.
 *   available   "Update ready" — click to pull.
 *   updating    the pull + install is running. Disabled, spinner.
 *   restart     "Restart Kotatsu" — the new code is on disk but this process is
 *               still running the old one.
 *   restarting  disabled; the server is going down and coming back under the
 *               launcher's exit-75 loop. We poll `/version` and reload.
 *
 * ── Shadow DOM, and why this one component departs from the house pattern ────
 * Every other Kotatsu component renders into light DOM so its rules can live in a
 * `css/shell-*.css` sheet. Slice B allocates no such sheet and touches no core CSS,
 * so this component carries its own `static styles` instead. It costs nothing that
 * matters: `--k-*` custom properties inherit straight through the shadow boundary,
 * so the pill still gets the theme's tokens AND the `k-topbar[variant="bar"]` chip
 * numbers from its host — it is token-clean, not literal-clean-by-accident. What is
 * given up is theme-pack override reach (a pack cannot restyle the pill's internals
 * from `sheet.css`). Tracked as ship-v0 errata: when a rail-chrome sheet exists, this
 * moves to light DOM with no template change.
 *
 * ── Failure posture ──────────────────────────────────────────────────────────
 * A dead or stood-down update endpoint must cost the top bar nothing. Every network
 * call is guarded; a failed check leaves the pill hidden and logs once; a failed
 * apply toasts and rewinds to `available`. The bar never blocks on this component.
 */

import { LitElement, css, html, nothing } from '../lit.js';
import { getRequestHeaders } from '../../../script.js';
import { restartAndWait } from '../restart.js';

/** Same cadence as the server's own cache — a second check inside 6 h is served from it. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Shortens a sha for display. The full value stays on the `title`.
 * @param {string | null | undefined} sha Full commit sha.
 * @returns {string} Seven characters, or an em-dash.
 */
function shortSha(sha) {
    return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : '—';
}

/**
 * Arrow into a tray — "there is something to bring down". Stroke only, drawn here:
 * no Font Awesome, no emoji (repo CLAUDE.md).
 * @returns {unknown} Download glyph.
 */
function downloadIcon() {
    return html`
        <svg class="k-up__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <line x1="12" y1="3.6" x2="12" y2="13.4"></line>
            <path d="M8.2 9.6 12 13.4l3.8-3.8"></path>
            <path d="M4.8 15.6v2.2a2.2 2.2 0 0 0 2.2 2.2h10a2.2 2.2 0 0 0 2.2-2.2v-2.2"></path>
        </svg>
    `;
}

/**
 * A circular arrow — "run it again, from the top".
 * @returns {unknown} Restart glyph.
 */
function restartIcon() {
    return html`
        <svg class="k-up__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <path d="M19.6 12a7.6 7.6 0 1 1-2.3-5.4"></path>
            <path d="M19.9 4.2v4.4h-4.4"></path>
        </svg>
    `;
}

/**
 * A three-quarter ring; the CSS spins it. Same 24-box and stroke weight as the
 * other two so the pill's width does not jump between states.
 * @returns {unknown} Busy glyph.
 */
function spinnerIcon() {
    return html`
        <svg class="k-up__icon k-up__icon--spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.9" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M12 4.4a7.6 7.6 0 1 0 7.6 7.6"></path>
        </svg>
    `;
}

/**
 * The rails update pill.
 */
export class KUpdatePill extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _state: { state: true },
        _current: { state: true },
        _remote: { state: true },
    };

    static styles = css`
        :host {
            display: inline-flex;
            align-items: center;
            box-sizing: border-box;
        }

        :host([hidden]) {
            display: none;
        }

        *,
        *::before,
        *::after {
            box-sizing: border-box;
        }

        /* The "rail" variant (SPEC §13): every number the pill owns, in one block, so a
           second variant is a second block of these and nothing else. Fallbacks are the
           top bar's own chip values — the pill matches its neighbours when mounted in
           <k-topbar>, and still renders correctly anywhere else. */
        :host([variant="rail"]) {
            --k-up-height: var(--k-topbar-chip-height, 26px);
            --k-up-pad: var(--k-topbar-chip-pad, 9px);
            --k-up-gap: var(--k-topbar-chip-gap, 7px);
            --k-up-hairline: var(--k-topbar-hairline, 1px);
            --k-up-label-size: var(--k-topbar-label-size, 11.5px);
            --k-up-label-weight: var(--k-topbar-label-weight, 600);
            --k-up-mono-size: var(--k-topbar-mono-size, 11.5px);
            --k-up-icon-size: var(--k-topbar-icon-size, 14px);
            --k-up-focus-ring: var(--k-topbar-focus-ring, 2px);
        }

        .k-up {
            display: inline-flex;
            align-items: center;
            gap: var(--k-up-gap);
            block-size: var(--k-up-height);
            min-inline-size: 0;
            margin: 0;
            padding-inline: var(--k-up-pad);
            appearance: none;
            border: var(--k-up-hairline) solid
                color-mix(in srgb, var(--k-accent) 55%, transparent);
            border-radius: var(--k-radius-pill);
            background: color-mix(in srgb, var(--k-accent) 16%, transparent);
            box-shadow: var(--k-elev-1);
            font-family: var(--k-font-ui);
            font-size: var(--k-up-label-size);
            font-weight: var(--k-up-label-weight);
            line-height: 1;
            white-space: nowrap;
            color: var(--k-text-strong);
            cursor: pointer;
            transition: background-color var(--k-motion), border-color var(--k-motion),
                color var(--k-motion);
        }

        .k-up:hover,
        .k-up:focus-visible {
            border-color: color-mix(in srgb, var(--k-accent) 78%, transparent);
            background: color-mix(in srgb, var(--k-accent) 26%, transparent);
        }

        .k-up:focus-visible {
            outline: var(--k-up-focus-ring) solid
                color-mix(in srgb, var(--k-accent) 55%, transparent);
            outline-offset: var(--k-up-hairline);
        }

        /* Busy is not a hover target and not an error: quieter chrome, same geometry,
           so the bar does not reflow while the update runs. */
        .k-up[disabled] {
            cursor: default;
            border-color: color-mix(in srgb, var(--k-chrome-border) 40%, transparent);
            background: var(--k-chrome-fill);
            color: var(--k-text-muted);
        }

        .k-up__icon {
            flex: 0 0 auto;
            inline-size: var(--k-up-icon-size);
            block-size: var(--k-up-icon-size);
        }

        .k-up__icon--spin {
            animation: k-up-spin 900ms linear infinite;
            transform-origin: 50% 50%;
        }

        @keyframes k-up-spin {
            to {
                rotate: 360deg;
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .k-up__icon--spin {
                animation: none;
            }

            .k-up {
                transition: none;
            }
        }

        .k-up__label {
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* The target sha, in the same mono voice as the model id beside it, behind the
           same hairline divider. Present only when there is a real sha to name. */
        .k-up__sha {
            padding-inline-start: var(--k-up-gap);
            border-inline-start: var(--k-up-hairline) solid
                color-mix(in srgb, var(--k-chrome-border) 32%, transparent);
            font-family: var(--k-font-mono);
            font-size: var(--k-up-mono-size);
            font-weight: 400;
            color: var(--k-text-muted);
        }
    `;

    constructor() {
        super();
        /** @type {string} Theme-pack variant hook (SPEC §13). v0 ships one: `rail`. */
        this.variant = 'rail';
        /** @type {'hidden' | 'available' | 'updating' | 'restart' | 'restarting'} */
        this._state = 'hidden';
        /** @type {string | null} Local sha at the last check. */
        this._current = null;
        /** @type {string | null} Mirror sha at the last check, or the sha `/apply` landed. */
        this._remote = null;
        /** @type {ReturnType<typeof setInterval> | null} */
        this._timer = null;
        /** @type {boolean} True once the stood-down reason has been logged, so it is logged once. */
        this._reasonLogged = false;
    }

    connectedCallback() {
        super.connectedCallback();
        // Guarantee the variant hook from the first frame, whether or not the mounting
        // slice authored it — same contract as <k-topbar>.
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        this.hidden = true;
        void this.check();
        this._timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    }

    disconnectedCallback() {
        if (this._timer !== null) {
            clearInterval(this._timer);
            this._timer = null;
        }
        super.disconnectedCallback();
    }

    /**
     * Asks the server whether the mirror has moved. Never throws, never toasts: a check
     * is background work the user did not ask for, and a broken one must be silent.
     * @param {boolean} [force] Bypass the server's 6 h cache.
     * @returns {Promise<void>}
     */
    async check(force = false) {
        // A check landing mid-update would rewind the pill out of `restart`. The user is
        // in the middle of the flow; the timer can wait for the next tick.
        if (this._state === 'updating' || this._state === 'restart' || this._state === 'restarting') {
            return;
        }

        try {
            const url = `/api/kotatsu/update/check${force ? '?force=1' : ''}`;
            const response = await fetch(url, { headers: getRequestHeaders() });
            if (!response.ok) {
                this.#stayHidden(`check returned HTTP ${response.status}`);
                return;
            }
            const data = await response.json();
            if (!data?.enabled) {
                this.#stayHidden(data?.reason ?? 'self-update is not enabled');
                return;
            }
            if (!data.behind) {
                this._state = 'hidden';
                this.hidden = true;
                return;
            }
            this._current = data.current?.sha ?? null;
            this._remote = data.remote?.sha ?? null;
            this._state = 'available';
            this.hidden = false;
        } catch (error) {
            this.#stayHidden(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Hidden, and the reason logged exactly once per mount — a dev clone stands the
     * feature down on every check and must not fill the console with it.
     * @param {string} reason Why nothing will be shown.
     * @returns {void}
     */
    #stayHidden(reason) {
        this._state = 'hidden';
        this.hidden = true;
        if (!this._reasonLogged) {
            this._reasonLogged = true;
            console.debug(`[k-update-pill] no update pill: ${reason}`);
        }
    }

    render() {
        switch (this._state) {
            case 'available':
                return this.#renderButton('Update ready', downloadIcon(), false,
                    `A newer Kotatsu is on the release mirror (${this._remote ?? 'unknown'}). Click to update.`,
                    shortSha(this._remote));
            case 'updating':
                return this.#renderButton('Updating…', spinnerIcon(), true,
                    'Pulling the update and installing dependencies.', null);
            case 'restart':
                return this.#renderButton('Restart Kotatsu', restartIcon(), false,
                    `Updated to ${this._remote ?? 'the latest commit'}. Click to restart into it.`,
                    shortSha(this._remote));
            case 'restarting':
                return this.#renderButton('Restarting…', spinnerIcon(), true,
                    'Kotatsu is restarting. The page reloads when the server answers again.', null);
            default:
                return nothing;
        }
    }

    /**
     * One button shape for every visible state, so the pill's geometry never jumps.
     * @param {string} label Button text.
     * @param {unknown} icon Leading glyph.
     * @param {boolean} disabled Whether the action is running.
     * @param {string} title Tooltip.
     * @param {string | null} sha Short sha to show behind the divider, if any.
     * @returns {unknown} Button template.
     */
    #renderButton(label, icon, disabled, title, sha) {
        return html`
            <button type="button" class="k-up" part="pill" title=${title}
                ?disabled=${disabled} @click=${() => this.#onClick()}>
                ${icon}
                <span class="k-up__label">${label}</span>
                ${sha ? html`<span class="k-up__sha">${sha}</span>` : nothing}
            </button>
        `;
    }

    /**
     * Routes the click by state. Disabled states never reach here.
     * @returns {void}
     */
    #onClick() {
        if (this._state === 'available') {
            void this.#apply();
        } else if (this._state === 'restart') {
            void this.#restart();
        }
    }

    /**
     * `git pull --ff-only` + install, server-side. On success the code is on disk but
     * this process is still the old one — hence `restart`, not a reload.
     * @returns {Promise<void>}
     */
    async #apply() {
        this._state = 'updating';
        try {
            const response = await fetch('/api/kotatsu/update/apply', {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !data?.ok) {
                const reason = data?.reason ?? `HTTP ${response.status}`;
                console.error('[k-update-pill] update failed', data ?? response.status);
                toastr.error(String(reason), 'Kotatsu update');
                this._state = 'available';
                return;
            }
            if (data.log) {
                console.log('[k-update-pill] update log\n' + data.log);
            }
            this._current = data.from ?? this._current;
            this._remote = data.to ?? this._remote;
            this._state = 'restart';
            toastr.success(`Updated to ${shortSha(data.to)}. Restart to load it.`, 'Kotatsu update');
        } catch (error) {
            console.error('[k-update-pill] update request failed', error);
            toastr.error('The update could not be applied. See the console.', 'Kotatsu update');
            this._state = 'available';
        }
    }

    /**
     * Asks the server to exit 75 so the launcher's loop brings it back, then waits for
     * it and reloads.
     *
     * A failed restart rewinds to `restart`, NOT to `available`: the pull already landed,
     * and offering "Update ready" again would send the user through a no-op pull instead
     * of the one action that is still outstanding.
     * @returns {Promise<void>}
     */
    async #restart() {
        this._state = 'restarting';
        let failure = '';
        const result = await restartAndWait({
            onState: (state, detail) => {
                if (state === 'failed') failure = detail ?? '';
            },
        });
        if (result === 'failed') {
            // A refused POST and a server that never returned read differently: the first
            // means nothing restarted, the second means it may have and the launcher is gone.
            if (failure === 'timeout') {
                toastr.warning('Kotatsu did not come back on its own. Run Start.bat to finish the update.', 'Kotatsu update');
            } else {
                toastr.error('Kotatsu could not be restarted. Close the window and run Start.bat.', 'Kotatsu update');
            }
            this._state = 'restart';
        }
    }
}

if (!customElements.get('k-update-pill')) {
    customElements.define('k-update-pill', KUpdatePill);
}
