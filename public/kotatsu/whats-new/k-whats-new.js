/**
 * <k-whats-new> — the release notes, once per update: a short page per new feature, each with a
 * clip of the real thing, Mikan-chan's line, plain copy and a link into the wiki.
 *
 * When it opens and what it shows: `state.js` (pure, tested). The notes: `releases.js`.
 * Light DOM; `css/whats-new.css` owns every rule. Rails only, like the welcome tour, and one rung
 * under it (4070/4071 vs 4080/4081): the two never meet, because a boot that opens the tour stamps
 * the What's New flag instead, but if they ever did the tour would win.
 *
 * ── Closing ─────────────────────────────────────────────────────────────────────────────────
 * Got it, the close button and Escape all go through `#finish()`, which writes
 * `power_user.kotatsu_whats_new_seen` and removes the element. A reload while it is open shows it
 * again; nothing is marked seen until the reader has closed it.
 *
 * ── Motion ──────────────────────────────────────────────────────────────────────────────────
 * Clips are muted loops that play by themselves. Under `prefers-reduced-motion: reduce` they
 * don't: the poster shows, with the player's own controls to start it.
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { saveSettingsDebounced } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { power_user } from '../../scripts/power-user.js';
import { line } from '../brand/mascot/lines.js';
import { BROWSE_OPEN_CLASS } from '../library/k-library.js';
import { RELEASES, WIKI_BASE } from './releases.js';
import { latestRelease, pagesOf, whatsNewPlan } from './state.js';
import { tourState } from '../onboarding/flow.js';

/** Stacking rungs, mirrored by `--k-wn-z-*` in whats-new.css. */
export const WHATS_NEW_Z = Object.freeze({ scrim: 4070, sheet: 4071 });

/** Window event that (re)opens the latest notes; Settings → System dispatches it. */
export const OPEN_WHATS_NEW_EVENT = 'k-open-whats-new';

/** The flag: the version whose notes were last closed. */
export const SEEN_KEY = 'kotatsu_whats_new_seen';

/** Set on `<body>` while the sheet is up. */
const OPEN_CLASS = 'k-whats-new-open';

/** Surfaces the sheet steps aside for: settings, the card studio, Browse Characters, the tour. */
const COVERING_CLASSES = Object.freeze(['k-settings-modal-open', 'k-studio-open', BROWSE_OPEN_CLASS, 'k-onboarding-open']);

/** Which pose Mikan-chan wears beside each card. */
const CARD_POSES = Object.freeze({ rooms: 'welcome', mentions: 'teach', talk: 'sauce', narrator: 'card' });

/** Where the running version comes from (no git, no network: `src/endpoints/kotatsu/update.js`). */
const VERSION_URL = '/api/kotatsu/update/version';

const closeIcon = html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">${svg`<path d="M4 4l8 8M12 4l-8 8"/>`}</svg>`;
const outIcon = html`<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svg`<path d="M6.5 3.5H3.5v9h9v-3"/><path d="M9 3h4v4M13 3L7.5 8.5"/>`}</svg>`;

/** @returns {boolean} Whether the rails shell is active. */
function railsActive() {
    return document.body?.dataset?.kLayout === 'rails';
}

/** @returns {boolean} Whether something the sheet steps aside for is up. */
function isCovered() {
    return COVERING_CLASSES.some(name => document.body.classList.contains(name));
}

/** @returns {boolean} */
function reducedMotion() {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class KWhatsNew extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        covered: { type: Boolean, reflect: true },
        _page: { state: true },
    };

    /** @type {HTMLElement|null} */
    #opener = null;

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onKeydown = null;

    /** @type {MutationObserver|null} */
    #coverWatcher = null;

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'sheet';
        /** @type {boolean} */
        this.covered = false;
        /** @type {number} */
        this._page = 0;
        /** @type {import('./state.js').Release[]} Newest first. */
        this.releases = [];
        /** @type {string} The running version, written to the flag on close. */
        this.current = '';
        /** @type {string} Shown instead of the first card's line, once (the replay greeting). */
        this.greeting = '';
    }

    /** Light DOM: whats-new.css owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        this.#opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        this.#onKeydown = (event) => this.#handleKeydown(event);
        window.addEventListener('keydown', this.#onKeydown, { capture: true });
        this.covered = isCovered();
        if (typeof MutationObserver === 'function') {
            this.#coverWatcher = new MutationObserver(() => {
                this.covered = isCovered();
            });
            this.#coverWatcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
        document.body.classList.add(OPEN_CLASS);
    }

    disconnectedCallback() {
        if (this.#onKeydown) {
            window.removeEventListener('keydown', this.#onKeydown, { capture: true });
            this.#onKeydown = null;
        }
        this.#coverWatcher?.disconnect();
        this.#coverWatcher = null;
        document.body.classList.remove(OPEN_CLASS);
        if (this.#opener?.isConnected) this.#opener.focus({ preventScroll: true });
        this.#opener = null;
        super.disconnectedCallback();
    }

    firstUpdated() {
        /** @type {HTMLElement|null} */ (this.querySelector('[data-k-wn-primary]'))?.focus({ preventScroll: true });
    }

    /** @returns {ReturnType<typeof pagesOf>} */
    get #pages() {
        return pagesOf(this.releases);
    }

    /**
     * @param {number} page
     * @returns {void}
     */
    go(page) {
        const total = this.#pages.length;
        this._page = Math.max(0, Math.min(total - 1, page));
    }

    /** Writes the flag, then closes. The one close path. */
    #finish() {
        if (this.current) {
            power_user[SEEN_KEY] = this.current;
            saveSettingsDebounced();
        }
        this.remove();
    }

    /**
     * Escape closes; the arrows page; Tab stays inside the sheet. All stand aside while covered.
     * @param {KeyboardEvent} event
     * @returns {void}
     */
    #handleKeydown(event) {
        if (this.covered || event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            this.#finish();
            return;
        }
        const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]');
        if (!typing && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
            event.preventDefault();
            this.go(this._page + (event.key === 'ArrowRight' ? 1 : -1));
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = /** @type {HTMLElement[]} */ ([...this.querySelectorAll('.k-wn-sheet :is(button, a[href], video[controls]):not([disabled])')]);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const inside = active instanceof HTMLElement && this.contains(active);
        if (event.shiftKey && (active === first || !inside)) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (active === last || !inside)) {
            event.preventDefault();
            first.focus();
        }
    }

    /**
     * @param {import('./state.js').Release} release
     * @param {import('./state.js').Card} card
     * @returns {unknown}
     */
    #renderClip(release, card) {
        const base = `kotatsu/whats-new/media/${release.version}/${card.id}`;
        const still = reducedMotion();
        return html`
            <figure class="k-wn-clip">
                <video class="k-wn-video" poster=${`${base}.webp`} muted loop playsinline preload="metadata"
                    ?autoplay=${!still} ?controls=${still} aria-label=${`A short clip: ${card.title}`}
                    .muted=${true}>
                    <source src=${`${base}.webm`} type="video/webm">
                    <source src=${`${base}.mp4`} type="video/mp4">
                </video>
            </figure>`;
    }

    /**
     * Marks the body when more of it waits below the fold, so its bottom edge fades (the last
     * page's notes sit under a short window, and a phone's scrollbar is 0px wide).
     * @returns {void}
     */
    #checkOverflow() {
        const body = this.querySelector('.k-wn-body');
        if (!(body instanceof HTMLElement)) return;
        body.toggleAttribute('data-more', body.scrollHeight - body.scrollTop - body.clientHeight > 2);
    }

    /** @param {Map<string, unknown>} changed */
    updated(changed) {
        this.#checkOverflow();
        if (changed.has('_page')) this.querySelector('.k-wn-body')?.scrollTo({ top: 0 });
        // Lit keeps the one <video> and swaps its <source> URLs, which a media element ignores
        // until it is told to load again; each page's clip then starts from its first frame.
        if (changed.has('_page') && changed.get('_page') !== undefined) {
            const video = this.querySelector('.k-wn-video');
            if (video instanceof HTMLVideoElement) {
                video.load();
                if (!reducedMotion()) void video.play().catch(() => { /* autoplay refused: the poster stays */ });
            }
        }
    }

    render() {
        const pages = this.#pages;
        if (!pages.length) return nothing;
        const index = Math.max(0, Math.min(pages.length - 1, this._page));
        const { release, card, last } = pages[index];
        const final = index === pages.length - 1;
        const bubble = index === 0 && this.greeting ? this.greeting : line(card.line);
        const pose = CARD_POSES[/** @type {keyof typeof CARD_POSES} */ (card.id)] ?? 'welcome';
        return html`
            <div class="k-wn-scrim" @click=${() => this.#finish()}></div>
            <section class="k-wn-sheet" role="dialog" aria-modal="true" aria-labelledby="k-wn-title" data-card=${card.id}>
                <header class="k-wn-head">
                    <div class="k-wn-heading">
                        <span class="k-wn-eyebrow">What’s new in Kotatsu ${release.version}</span>
                        <h2 id="k-wn-title" class="k-wn-title">${release.title}</h2>
                    </div>
                    <button type="button" class="k-wn-close" aria-label="Close" title="Close" @click=${() => this.#finish()}>${closeIcon}</button>
                </header>
                <div class="k-wn-body" @scroll=${() => this.#checkOverflow()}>
                ${this.#renderClip(release, card)}
                <div class="k-wn-guide">
                    <img class="k-wn-mascot" src=${`kotatsu/brand/mascot/${pose}-bust.webp`} alt="" draggable="false">
                    <p class="k-wn-bubble" aria-live="polite"><span class="k-wn-speaker">Mikan-chan</span>${bubble}</p>
                </div>
                <div class="k-wn-copy">
                    <h3 class="k-wn-card-title">${card.title}</h3>
                    <p class="k-wn-card-body">${card.body}</p>
                    ${card.wiki ? html`<a class="k-wn-wiki" href=${`${WIKI_BASE}${card.wiki}`} target="_blank" rel="noopener noreferrer">Read more on the wiki${outIcon}</a>` : nothing}
                    ${last && release.notes?.length ? html`
                        <div class="k-wn-notes">
                            <span class="k-wn-notes-label">Also in ${release.version}</span>
                            <ul>${release.notes.map(note => html`<li>${note}</li>`)}</ul>
                        </div>` : nothing}
                </div>
                </div>
                <footer class="k-wn-foot">
                    <div class="k-wn-dots" role="img" aria-label=${`Page ${index + 1} of ${pages.length}`}>
                        ${pages.map((_, dot) => html`<span class="k-wn-dot" data-state=${dot < index ? 'past' : dot === index ? 'now' : 'next'}></span>`)}
                    </div>
                    <div class="k-wn-actions">
                        ${index > 0 ? html`<button type="button" class="k-wn-button" data-kind="ghost" @click=${() => this.go(index - 1)}>Back</button>` : nothing}
                        <button type="button" class="k-wn-button" data-kind="primary" data-k-wn-primary
                            @click=${() => final ? this.#finish() : this.go(index + 1)}>${final ? 'Got it' : 'Next'}</button>
                    </div>
                </footer>
            </section>`;
    }
}

customElements.define('k-whats-new', KWhatsNew);

/** @returns {KWhatsNew|null} */
function currentSheet() {
    const element = document.querySelector('k-whats-new');
    return element instanceof KWhatsNew ? element : null;
}

/**
 * Opens the sheet on these releases (or keeps an open one), rails only.
 * @param {import('./state.js').Release[]} releases Newest first.
 * @param {string} current The running version.
 * @param {{greeting?: string}} [options]
 * @returns {KWhatsNew|null}
 */
export function openWhatsNew(releases, current, { greeting = '' } = {}) {
    if (!railsActive() || !releases.length) return null;
    const existing = currentSheet();
    if (existing) return existing;
    const sheet = /** @type {KWhatsNew} */ (document.createElement('k-whats-new'));
    sheet.setAttribute('variant', 'sheet');
    sheet.releases = releases;
    sheet.current = current;
    sheet.greeting = greeting;
    document.body.appendChild(sheet);
    return sheet;
}

/** @returns {Promise<string>} The running Kotatsu version, '' when the server can't say. */
async function runningVersion() {
    try {
        const response = await fetch(VERSION_URL, { cache: 'no-store' });
        if (!response.ok) return '';
        const data = await response.json();
        return typeof data?.kotatsuVersion === 'string' ? data.kotatsuVersion : '';
    } catch {
        return '';
    }
}

/**
 * Registration at the shell seam: decide at APP_READY, and answer Settings' "show again".
 * @returns {void}
 */
export function installWhatsNew() {
    window.addEventListener(OPEN_WHATS_NEW_EVENT, () => {
        void runningVersion().then((current) => {
            const release = latestRelease(current, RELEASES);
            if (release) openWhatsNew([release], current, { greeting: line('whatsNewAgain') });
        });
    });
    eventSource.on(event_types.APP_READY, () => {
        if (!railsActive()) return;
        void runningVersion().then((current) => {
            const plan = whatsNewPlan({
                seen: power_user[SEEN_KEY],
                current,
                tourDue: tourState(power_user.kotatsu_onboarding).open,
                releases: RELEASES,
            });
            if (plan.stamp) {
                power_user[SEEN_KEY] = plan.stamp;
                saveSettingsDebounced();
            }
            if (plan.open) openWhatsNew(plan.releases, current);
        });
    });
}
