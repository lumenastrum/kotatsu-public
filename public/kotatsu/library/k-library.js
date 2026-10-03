/**
 * `<k-library variant="gallery">` — the cast-gallery landing (library v0 slice C,
 * `docs/library-v0.md` §1). The card studio (slice D) is a separate element; it reuses
 * {@link renderCard} and {@link previewRow} from here and from `view-model.js`.
 *
 * WHAT THIS IS, structurally: a CENTRE-COLUMN OVERLAY. The element is a child of `#k-center`
 * (a sibling of the relocated `#sheld`) and paints `position: absolute; inset: 0` over it.
 * That shape is the whole containment story:
 *
 * - It NEVER touches `#sheld` / `#chat` visibility or their interiors. The "Toggle Panels"
 *   inline-display hazard class — where something writes `display` onto a core surface and a
 *   later core call reads it back as the user's preference — stays closed by construction.
 *   `<k-chat-header>` already collapses itself on `[empty]`, so nothing underneath needs help.
 * - The four frozen ids in this region (`rm_print_characters_block`, `rm_ch_create_block`,
 *   `character_popup`, `form_create` — CONTRACT §1.3) are untouched and keep working. The
 *   library is a SECOND VIEW, never a replacement: Import and Create fire REAL clicks on the
 *   stock buttons, because three separate handlers hang off `#rm_button_create`
 *   (`script.js:11464`, `RossAscends-mods.js:207`, the delegated `tags.js:2779`) and only a
 *   real click fires all three.
 *
 * VISIBILITY. Shown when `getCurrentChatId() === undefined` and the landing setting says
 * `library`; hidden the moment a chat opens. `k-open-library` (bubbling + composed, the
 * branch-map precedent) opens it over an active chat, and the × / Escape return to that chat —
 * both hidden and stood down when there is no chat to return to, because a close button that
 * reveals an empty room is a trap with no exit. Console door: `window.kotatsu.library`.
 *
 * Light DOM (`createRenderRoot()` returns `this`) for the three reasons every kotatsu
 * component gives: `public/css/library.css` reaches the internals, a theme pack's `sheet.css`
 * reaches them too, and `initDynamicStyles()` (`dynamic-styles.js:188-202`) can see the
 * hover / focus-visible pairs it audits.
 *
 * One-way imports: kotatsu → core only. Nothing in core imports this file; the welcome-screen
 * gate that yields the landing to us is DATA-driven (`power_user.kotatsu_landing` plus the
 * layout attribute), never an import.
 */

import { toRelative } from '../shell/relative-time.js';
import { LitElement, html, nothing } from '../shell/lit.js';
import {
    characters,
    displayVersion,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    openCharacterChat,
    printCharactersDebounced,
    saveSettingsDebounced,
    selectCharacterById,
    setActiveCharacter,
    setActiveGroup,
    system_avatar,
} from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { groups, openGroupById, openGroupChat } from '../../scripts/group-chats.js';
import { power_user } from '../../scripts/power-user.js';
import { timestampToMoment } from '../../scripts/utils.js';
import { favsToHotswap } from '../../scripts/RossAscends-mods.js';
import {
    LANDING_CHANGED_EVENT,
    LANDING_IDS,
    readLanding,
    setLanding,
} from '../shell/persistence.js';
import {
    CARD_TAG_MAX,
    buildRows,
    countRows,
    filterRows,
    sortRows,
} from './view-model.js';
// Slice D's door, taken from the studio's DOM-FREE manifest rather than from the element:
// `<k-card-studio>` imports `renderCard()` from this file, so importing the element back here
// would make the two a cycle. `studio/manifest.js` imports nothing at all.
import { OPEN_STUDIO_EVENT } from '../studio/manifest.js';
import { chatLabelText } from '../shell/chat-label.js';

/** @typedef {import('./view-model.js').LibraryRow} LibraryRow */

/** The open request. Bubbling + composed, like `k-open-settings` and `k-open-branch-map`. */
export const OPEN_LIBRARY_EVENT = 'k-open-library';

/**
 * Set on `<body>` while the gallery is open in Browse Characters. The welcome tour steps aside
 * for it the way it does for the card studio and the settings modal (`k-studio-open`), so its
 * "Browse Characters" tile can hand the reader to the view and come back when they leave it.
 */
export const BROWSE_OPEN_CLASS = 'k-library-browse-open';

/**
 * Bubbling request, from anything inside the gallery, to show one of its views:
 * `detail.view` is `'cast'` or `'browse'`, `detail.top` asks for the top of the sheet too.
 * `<k-market>` raises it for the preview sheet's "Back to your cast".
 */
export const SHOW_VIEW_EVENT = 'k-library-show-view';

/**
 * How far down the sheet the reader is before the way back is offered (the "Top" pill, and
 * "Your cast" beside it in Browse). Past the hero and the tools, roughly: once the switch at
 * the head of the page is off screen. Reported 2026-10-02: deep in the scroll, the only way
 * back to the installed cards was a scroll all the way up.
 */
const JUMP_THRESHOLD_PX = 480;

/** Recent chats the continue strip will show. Five is the doc's number (§1.2 item 3). */
export const RECENT_MAX = 5;

/** How long after the last scroll event the cards take the pointer again. */
const SCROLL_SETTLE_MS = 150;

/** Coalescing window for bursty core events, matching `k-rail-left.js`. */
const REFRESH_DEBOUNCE_MS = 80;

/**
 * The readiness latch. Nothing reads `characters` — or asks the server for anything — before
 * one of these has fired (doc §1.4, shell-qa's console-clean gate). They also refresh, so they
 * are not listed again in {@link REFRESH_EVENTS}.
 */
const READY_EVENTS = [
    event_types.APP_READY,
    event_types.CHARACTER_PAGE_LOADED,
];

/** Core events after which the gallery's rows may be stale — the rail's set (doc §1.4). */
const REFRESH_EVENTS = [
    event_types.CHARACTER_EDITED,
    event_types.CHARACTER_DELETED,
    event_types.CHARACTER_DUPLICATED,
    event_types.CHARACTER_RENAMED,
    event_types.CHAT_DELETED,
    event_types.GROUP_UPDATED,
    event_types.SETTINGS_LOADED,
];

/** Core events after which the "pick up where you left off" strip may be stale. */
const RECENT_EVENTS = [
    event_types.CHAT_CHANGED,
    event_types.CHAT_CREATED,
    event_types.CHAT_DELETED,
    event_types.CHAT_RENAMED,
];

/** Core events that decide whether the gallery is on screen at all. */
const VISIBILITY_EVENTS = [
    event_types.APP_READY,
    event_types.CHAT_CHANGED,
    event_types.SETTINGS_LOADED,
];

/**
 * The sort menu, mirroring `#character_sort_order` (`index.html:6448-6461`) minus its hidden
 * `search` option — that one is core's TEMPORARY sort while the stock search bar has content,
 * it is never persisted (`power-user.js:3633-3641` skips writing it), and the library has its
 * own search box.
 *
 * `field` / `order` / `rule` are written straight into the same three `power_user` keys the
 * stock select writes, so the two controls describe one setting rather than two.
 * @type {ReadonlyArray<{ field: string, order: string, rule?: string, label: string }>}
 */
const SORT_OPTIONS = Object.freeze([
    { field: 'name', order: 'asc', label: 'A–Z' },
    { field: 'name', order: 'desc', label: 'Z–A' },
    { field: 'create_date', order: 'desc', label: 'Newest' },
    { field: 'create_date', order: 'asc', label: 'Oldest' },
    { field: 'fav', order: 'desc', rule: 'boolean', label: 'Favorites' },
    { field: 'date_last_chat', order: 'desc', label: 'Recent' },
    { field: 'chat_size', order: 'desc', label: 'Most chats' },
    { field: 'chat_size', order: 'asc', label: 'Least chats' },
    { field: 'data_size', order: 'desc', label: 'Most tokens' },
    { field: 'data_size', order: 'asc', label: 'Least tokens' },
    { field: 'name', order: 'random', label: 'Random' },
]);

/**
 * Stroke-only icon set. No Font Awesome, no emoji — including for the "open chat" arrow, which
 * the design doc writes as `↗`: a dingbat glyph is still a glyph in a font we do not control,
 * and it would not take the card accent reliably (repo CLAUDE.md rule).
 */
const icons = {
    close: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M4 4l8 8" /><path d="M12 4l-8 8" />
        </svg>`,
    search: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">
            <circle cx="7" cy="7" r="4.25" /><path d="M10.2 10.2 13.5 13.5" />
        </svg>`,
    /** The bottom-right "open chat" affordance — an arrow leaving the card. */
    arrow: html`
        <svg class="k-lib-icon k-lib-icon--arrow" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M5.5 10.5 10.5 5.5" /><path d="M6.25 5.5h4.25v4.25" />
        </svg>`,
    import: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M8 2.5v7" /><path d="M5.25 6.75 8 9.5l2.75-2.75" /><path d="M3 11.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" />
        </svg>`,
    /** URL import — a chain link, because the thing being handed over IS a link. */
    link: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M6.75 9.25 9.25 6.75" /><path d="M7.5 4.75 8.9 3.35a2.3 2.3 0 0 1 3.25 3.25L10.75 8" /><path d="M8.5 11.25 7.1 12.65a2.3 2.3 0 0 1-3.25-3.25L5.25 8" />
        </svg>`,
    plus: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false">
            <path d="M8 3.25v9.5" /><path d="M3.25 8h9.5" />
        </svg>`,
    /** The way back up. */
    up: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M8 12.5v-9" /><path d="M4.25 7.25 8 3.5l3.75 3.75" />
        </svg>`,
    /** Your cast — two heads, the people already here. */
    cast: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="12" height="12" fill="none"
             stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <circle cx="6" cy="5.5" r="2.4" /><path d="M1.75 13a4.25 4.25 0 0 1 8.5 0" /><path d="M10.5 3.4a2.4 2.4 0 0 1 0 4.2" /><path d="M11.4 9.1a4.25 4.25 0 0 1 2.85 3.9" />
        </svg>`,
    /** Browse Characters — a compass: somebody out there, not yet here. */
    browse: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="5.75" /><path d="m10.4 5.6-1.5 3.3-3.3 1.5 1.5-3.3z" />
        </svg>`,
    /**
     * Edit card. A PENCIL, not the design doc's `⋯`.
     *
     * The doc writes this affordance as "card ⋯ → Edit card" (§2.1 item 5), and an overflow
     * menu is the right shape the moment there are two card actions. In v0 there is exactly
     * one, and a `⋯` that opens a menu whose only row is the thing the click already meant is
     * a click of ceremony for nothing — worse, a `⋯` that performs an action directly lies
     * about what it is. A pencil says what it does. The menu arrives with the second action.
     */
    edit: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M10.6 3.4a1.5 1.5 0 0 1 2.1 2.1L6.4 11.8l-2.9.7.7-2.9z" /><path d="M9.4 4.6l2 2" />
        </svg>`,
    /** The assistant badge — core's own "welcome page assistant" mark, as a hearth spark. */
    assistant: html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="13" height="13" fill="none"
             stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true" focusable="false">
            <path d="M8 2.25 9.5 6.5 13.75 8 9.5 9.5 8 13.75 6.5 9.5 2.25 8 6.5 6.5z" />
        </svg>`,
};

/**
 * The favourite heart. Filled from the accent when on, outlined when off — one shape, so the
 * toggle does not jump.
 * @param {boolean} on Whether the entity is favourited.
 * @returns {unknown} A Lit template.
 */
function heartIcon(on) {
    return html`
        <svg class="k-lib-icon" viewBox="0 0 16 16" width="14" height="14"
             fill=${on ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.4"
             stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8 13.25 3.4 8.9a2.85 2.85 0 0 1 4.05-4L8 5.5l.55-.6a2.85 2.85 0 0 1 4.05 4z" />
        </svg>`;
}

/**
 * The brand lockup, token-tinted — the same two SVGs `welcomePanel.html:3-28` carries, so the
 * 8/24 identity work moves house rather than dying (doc §0). The gradient id is namespaced:
 * both lockups can be in one document at once (hearth mode with the library opened over a
 * chat), and duplicate ids resolve to whichever came first.
 * @returns {unknown} A Lit template.
 */
function brandLockup() {
    return html`
        <svg class="k-lib-logo" viewBox="0 0 64 64" role="img" aria-label="Kotatsu">
            <defs>
                <radialGradient id="k-lib-wm-glow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" style="stop-color: var(--k-rose)" stop-opacity="0.55" />
                    <stop offset="100%" style="stop-color: var(--k-rose)" stop-opacity="0" />
                </radialGradient>
            </defs>
            <path d="M18 12 h28 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-20 l-10 8 v-8 a8 8 0 0 1 -6 -7.7 v-20.3 a8 8 0 0 1 8 -8z"
                  fill="none" style="stroke: var(--k-accent)" stroke-width="5" stroke-linejoin="round" />
            <ellipse cx="32" cy="30" rx="12" ry="8" fill="url(#k-lib-wm-glow)" />
            <circle cx="32" cy="30" r="6.5" style="fill: var(--k-rose)" />
        </svg>
        <svg class="k-lib-wordmark" viewBox="0 0 236 64" role="img" aria-label="Kotatsu">
            <g fill="none" style="stroke: var(--k-accent-bright)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 12 v40 M14 34 l20 -18 M19.5 29.5 l16 22.5" />
                <path d="M68 18 v27 a7 7 0 0 0 7 7 M58 30 h19" />
                <circle cx="98" cy="42" r="9" />
                <path d="M107 33 v19" />
                <path d="M126 18 v27 a7 7 0 0 0 7 7 M116 30 h19" />
                <path d="M162 34 a8 7 0 0 0 -15 2.5 c0 7 15 3 15 10.5 a8 7 0 0 1 -15 2.5" />
                <path d="M178 30 v13 a9 9 0 0 0 18 0 v-13 M196 43 v9" />
            </g>
            <ellipse cx="45" cy="42" rx="11" ry="9" fill="url(#k-lib-wm-glow)" />
            <circle cx="45" cy="42" r="7" style="fill: var(--k-rose)" />
        </svg>`;
}

export { toRelative } from '../shell/relative-time.js';

/**
 * @typedef {object} CardHandlers
 * @property {(row: LibraryRow) => unknown} [onOpen] Whole-card activation.
 * @property {(row: LibraryRow, event: Event) => unknown} [onFav] Heart click; already stopped.
 * @property {(row: LibraryRow, event: Event) => unknown} [onEdit] "Edit card" click; already
 *   stopped. Omitted (and the affordance not drawn) when there is nowhere to send it — the
 *   studio is rails-only, and groups have no card studio in v0.
 * @property {boolean} [interactive] Default true. `false` renders a STATIC poster: no
 *   handlers, no tab stop, nothing announced as a control. That is the mode slice D's live
 *   preview uses.
 */

/**
 * Renders one poster card — `docs/library-v0.md` §1.3.
 *
 * **Exported as the slice-D seam.** `<k-card-studio>`'s left-rail preview is required to be
 * "the same card renderer as the gallery", so this function takes a plain {@link LibraryRow}
 * and nothing else: no component state, no core reads, no event subscriptions. Feed it a row
 * from `buildRows()` or one from `previewRow()` and it draws the same poster.
 *
 * The accent is passed in as an inline `--card-accent` custom property built from the row's
 * hue and the sheet's `--k-lib-accent-s` / `--k-lib-accent-l` band tokens. It is spent in
 * exactly four places — kicker, hover border, heart, arrow — and never as a fill, which is
 * what keeps 40 cards from reading as a colour chart.
 * @param {LibraryRow} row The row to draw.
 * @param {CardHandlers} [handlers] Interaction hooks.
 * @returns {unknown} A Lit template.
 */
export function renderCard(row, handlers = {}) {
    const interactive = handlers.interactive !== false;
    const isGroup = row.type === 'group';
    const tags = row.tags.slice(0, CARD_TAG_MAX);
    const relative = toRelative(row.lastChat);
    const stamp = row.lastChat > 0 ? new Date(row.lastChat).toLocaleString() : '';

    // Handlers and branches are resolved to single values BEFORE the template. Multi-line
    // expressions inside `${}` are code the indent rule still audits, and every other kotatsu
    // component keeps its bindings on one line for the same reason.
    /** @param {Event} event */
    const stop = (event) => event.stopPropagation();
    /** @param {Event} event */
    const favClick = (event) => { stop(event); handlers.onFav?.(row, event); };
    /** @param {Event} event */
    const editClick = (event) => { stop(event); handlers.onEdit?.(row, event); };
    /** @param {KeyboardEvent} event */
    const cardKey = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handlers.onOpen?.(row);
    };

    const art = row.portrait
        ? html`<img class="k-lib-card-portrait" src=${row.portrait} alt="" loading="lazy" decoding="async" />`
        : isGroup && row.members.length
            ? html`<div class="k-lib-card-stack">${row.members.map(member => html`<img class="k-lib-card-stack-face" src=${member} alt="" loading="lazy" decoding="async" />`)}</div>`
            : html`<div class="k-lib-card-initials" aria-hidden="true">${row.initials}</div>`;

    const badge = row.assistant
        ? html`<span class="k-lib-card-badge" title="Welcome page assistant" aria-label="Welcome page assistant">${icons.assistant}</span>`
        : nothing;

    // Slice D's way in. Drawn only when a handler exists AND the row is a character: groups
    // are edited through the stock group panel, and the static preview poster (`interactive:
    // false`) is a picture of a card, not a control surface.
    const editButton = interactive && handlers.onEdit && !isGroup
        ? html`
            <button
                type="button"
                class="k-lib-card-edit"
                title="Edit card"
                aria-label=${`Edit ${row.name}`}
                @click=${editClick}
            >${icons.edit}</button>`
        : nothing;

    const tagList = tags.length
        ? html`<ul class="k-lib-card-tags">${tags.map(tag => html`<li class="k-lib-card-tag">${tag}</li>`)}</ul>`
        : nothing;

    // A character record carries `chat_size` in BYTES, never a chat COUNT
    // (src/endpoints/characters.js:342-357), so only groups — which carry a real `chats[]` —
    // print one. The number is not invented for the other half of the cast.
    const count = isGroup
        ? html`<span class="k-lib-card-count">${row.chatCount} ${row.chatCount === 1 ? 'chat' : 'chats'}</span>`
        : nothing;

    const bodyText = isGroup
        ? `${row.memberCount} ${row.memberCount === 1 ? 'member' : 'members'}`
        : row.body;

    return html`
        <article
            class="k-lib-card${isGroup ? ' k-lib-card--group' : ''}"
            style=${`--card-accent: hsl(${row.hue} var(--k-lib-accent-s) var(--k-lib-accent-l));`}
            role=${interactive ? 'button' : nothing}
            tabindex=${interactive ? '0' : nothing}
            aria-label=${interactive ? `Open ${row.name}` : nothing}
            @click=${interactive ? () => handlers.onOpen?.(row) : nothing}
            @keydown=${interactive ? cardKey : nothing}
        >
            <div class="k-lib-card-art">
                ${art}
                <div class="k-lib-card-scrim" aria-hidden="true"></div>
            </div>

            <div class="k-lib-card-chrome">
                ${badge}
                ${editButton}
                <button
                    type="button"
                    class="k-lib-card-fav${row.fav ? ' is-on' : ''}"
                    tabindex=${interactive ? '0' : '-1'}
                    aria-pressed=${row.fav ? 'true' : 'false'}
                    title=${row.fav ? 'Remove from favorites' : 'Add to favorites'}
                    aria-label=${row.fav ? `Remove ${row.name} from favorites` : `Add ${row.name} to favorites`}
                    @click=${interactive ? favClick : stop}
                >${heartIcon(row.fav)}</button>
            </div>

            <div class="k-lib-card-copy">
                ${row.kicker ? html`<span class="k-lib-card-kicker">${row.kicker}</span>` : nothing}
                <h3 class="k-lib-card-name">${row.name}</h3>
                <p class="k-lib-card-body">${bodyText}</p>
                ${tagList}
                <div class="k-lib-card-foot">
                    <span class="k-lib-card-stat" title=${stamp}>
                        ${count}
                        ${relative ? html`<span class="k-lib-card-when">${relative}</span>` : nothing}
                    </span>
                    <span class="k-lib-card-open">Open chat${icons.arrow}</span>
                </div>
            </div>
        </article>`;
}

/**
 * The left rail: roster, chats, branches — no. The gallery.
 */
export class KLibrary extends LitElement {
    static properties = {
        /** SPEC §13 — present from day one even though `gallery` is the only v0 variant. */
        variant: { type: String, reflect: true },
        /** Reflected so `public/css/library.css` can hide the element with one attribute rule. */
        open: { type: Boolean, reflect: true },
        _rows: { state: true },
        _ready: { state: true },
        _search: { state: true },
        _tab: { state: true },
        _recents: { state: true },
        _hasChat: { state: true },
        _view: { state: true },
        _deep: { state: true },
    };

    /** @type {Array<{ type: string, handler: () => void }>} */
    #subscriptions = [];

    /** @type {number} `setTimeout` handle for the coalesced refresh, 0 = idle. */
    #refreshTimer = 0;

    /** Monotonic token so a slow recents fetch cannot overwrite a newer one. */
    #recentToken = 0;

    /** True once a core event has proven `characters` is populated (doc §1.4). */
    #coreReady = false;

    /** @type {((event: KeyboardEvent) => void)|null} */
    #onEscape = null;

    /** @type {((event: Event) => void)|null} */
    #onOpenRequest = null;

    /** @type {((event: Event) => void)|null} */
    #onLandingChanged = null;

    /** @type {((event: Event) => void)|null} */
    #onScroll = null;

    /** @type {((event: Event) => void)|null} */
    #onShowView = null;

    /** @type {number} `setTimeout` handle that ends the scrolling state, 0 = idle. */
    #scrollTimer = 0;

    /**
     * The card renderer's hooks, built once.
     *
     * A fresh object per render would hand `renderCard()` a new identity every pass; keeping
     * one means the only thing that changes between renders is the row.
     * @type {import('./k-library.js').CardHandlers}
     */
    #cardHandlers;

    constructor() {
        super();
        this.#cardHandlers = {
            onOpen: (row) => { void this.#onOpenRow(row); },
            onFav: (row) => { void this.#onToggleFav(row); },
            onEdit: (row) => { this.#onEditRow(row); },
        };
        /** @type {string} */
        this.variant = 'gallery';
        /** @type {boolean} */
        this.open = false;
        /** @type {LibraryRow[]} */
        this._rows = [];
        /** @type {boolean} */
        this._ready = false;
        /** @type {string} */
        this._search = '';
        /** @type {'all'|'favorites'} */
        this._tab = 'all';
        /** @type {Array<Record<string, any>>} */
        this._recents = [];
        /**
         * Whether a chat is open behind the gallery.
         *
         * Nothing READS this in `render()` — the close affordance asks {@link
         * KLibrary.#canClose} for the fresh answer. It is kept as a reactive property because
         * it is the TRIGGER: opening the gallery over a chat changes it, which is what makes
         * Lit repaint the header with a × on it.
         * @type {boolean}
         */
        this._hasChat = false;
        /**
         * Which of the gallery's two sources is showing: the library, or a card site
         * (`docs/character-marketplace-v0.md` §9). Not persisted: the gallery opens on the
         * cast every time.
         * @type {'cast'|'browse'}
         */
        this._view = 'cast';
        /** @type {boolean} The sheet is scrolled past {@link JUMP_THRESHOLD_PX}: the way back is offered. */
        this._deep = false;
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

        // The readiness latch FIRST, and on its own two events, so nothing below has to depend
        // on subscription order to know whether `characters` is safe to read. `APP_READY` is
        // sticky on core's emitter (`events.js:113`), so this fires immediately for an element
        // that mounts after boot — a rails→classic→rails round trip, say.
        for (const type of READY_EVENTS) {
            const handler = () => {
                this.#coreReady = true;
                this.#scheduleRefresh();
                void this.#loadRecents();
            };
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
        for (const type of REFRESH_EVENTS) {
            const handler = () => this.#scheduleRefresh();
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
        for (const type of RECENT_EVENTS) {
            const handler = () => { void this.#loadRecents(); };
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
        for (const type of VISIBILITY_EVENTS) {
            const handler = () => this.#syncVisibility();
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }

        // Document-level doors live and die with the element, which is the branch map's
        // answer to teardown: nothing to remember to unbind, because the element stops
        // existing. Under classic it never mounts at all.
        this.#onOpenRequest = () => this.openLibrary();
        document.addEventListener(OPEN_LIBRARY_EVENT, this.#onOpenRequest);
        this.#onEscape = (event) => this.#handleEscape(event);
        document.addEventListener('keydown', this.#onEscape, { capture: true });
        // `requestUpdate()` as well as the sync: the close affordance is derived from
        // `#canClose()`, which reads the landing setting FRESH rather than mirroring it into a
        // reactive field. Flipping the setting while the gallery is open changes whether there
        // is a way out without changing any reactive property, so the repaint has to be asked
        // for explicitly. One source of truth, one extra line.
        this.#onLandingChanged = () => {
            this.#syncVisibility();
            this.requestUpdate();
        };
        document.addEventListener(LANDING_CHANGED_EVENT, this.#onLandingChanged);

        // While the sheet scrolls, cards do not take the pointer. Measured 2026-10-02
        // (playwright-rig `kotatsu-market-firstview-perf.mjs`): with the pointer resting over
        // the grid, every card that slides under it starts the hover bloom, and the portrait's
        // scale change costs a repaint of the image each time, animated or not. Wheeling
        // through fresh cards stalled the main thread ~140 ms of every second; with hover off
        // during the scroll it was ~15. Scroll events do not bubble, so this listens in the
        // capture phase on the element and catches the sheet's. Hover returns 150 ms after
        // the last scroll event, where the hand has stopped.
        this.#onScroll = (event) => {
            if (this.#scrollTimer === 0) this.setAttribute('data-scrolling', '');
            else clearTimeout(this.#scrollTimer);
            this.#scrollTimer = window.setTimeout(() => {
                this.#scrollTimer = 0;
                this.removeAttribute('data-scrolling');
            }, SCROLL_SETTLE_MS);
            // The way back: one boolean, written only on change, so a scroll never re-renders.
            const sheet = event.target;
            if (sheet instanceof Element && sheet.classList.contains('k-lib-sheet')) {
                const deep = sheet.scrollTop > JUMP_THRESHOLD_PX;
                if (deep !== this._deep) this._deep = deep;
            }
        };
        this.addEventListener('scroll', this.#onScroll, { capture: true, passive: true });
        this.#onShowView = (event) => {
            const detail = /** @type {CustomEvent<{ view?: string, top?: boolean }>} */ (event).detail ?? {};
            const view = detail.view === 'browse' ? 'browse' : 'cast';
            void this.showView(view).then(() => { if (detail.top) this.scrollToTop(); });
        };
        this.addEventListener(SHOW_VIEW_EVENT, this.#onShowView);

        this.#syncVisibility();
        this.#scheduleRefresh();
        void this.#loadRecents();
    }

    disconnectedCallback() {
        document.body.classList.remove(BROWSE_OPEN_CLASS);
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
        if (this.#refreshTimer !== 0) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = 0;
        }
        this.#recentToken++;
        if (this.#onOpenRequest) {
            document.removeEventListener(OPEN_LIBRARY_EVENT, this.#onOpenRequest);
            this.#onOpenRequest = null;
        }
        if (this.#onEscape) {
            document.removeEventListener('keydown', this.#onEscape, { capture: true });
            this.#onEscape = null;
        }
        if (this.#onLandingChanged) {
            document.removeEventListener(LANDING_CHANGED_EVENT, this.#onLandingChanged);
            this.#onLandingChanged = null;
        }
        if (this.#onScroll) {
            this.removeEventListener('scroll', this.#onScroll, { capture: true });
            this.#onScroll = null;
        }
        if (this.#onShowView) {
            this.removeEventListener(SHOW_VIEW_EVENT, this.#onShowView);
            this.#onShowView = null;
        }
        if (this.#scrollTimer !== 0) {
            clearTimeout(this.#scrollTimer);
            this.#scrollTimer = 0;
            this.removeAttribute('data-scrolling');
        }
        super.disconnectedCallback();
    }

    /* ── doors ──────────────────────────────────────────────────────────── */

    /** Opens the gallery over whatever is in the centre column. @returns {void} */
    openLibrary() {
        this._hasChat = getCurrentChatId() !== undefined;
        this.open = true;
        this.#scheduleRefresh();
        void this.#loadRecents();
    }

    /**
     * Whether closing would reveal anything.
     *
     * Two ways it can. A chat behind us is the obvious one. The other is hearth mode: when
     * `power_user.kotatsu_landing` is `hearth`, core's welcome screen is already rendered into
     * `#chat` underneath — the gallery was opened deliberately over it — so closing hands the
     * hearth back. With NEITHER (library mode, no chat) the gallery IS the landing and there
     * is nothing behind it; offering a way out there would be a door onto an empty room.
     *
     * Gates all three exits together — the ×, Escape, and {@link KLibrary.closeLibrary} — so
     * they can never disagree about whether there is somewhere to go.
     * @returns {boolean} Whether the gallery may be dismissed.
     */
    #canClose() {
        return getCurrentChatId() !== undefined || readLanding() !== 'library';
    }

    /**
     * Returns to whatever is behind the gallery. A no-op when nothing is — the affordance is
     * hidden in that state and Escape stands down, so this is belt to that brace.
     * @returns {void}
     */
    closeLibrary() {
        if (!this.#canClose()) {
            return;
        }
        this.open = false;
    }

    /** @returns {{ open: boolean, ready: boolean, rows: number, favorites: number, tab: string, search: string, recents: number, landing: string, view: string }} */
    get state() {
        const counts = countRows(this._rows);
        return {
            open: this.open,
            ready: this._ready,
            rows: counts.all,
            favorites: counts.favorites,
            tab: this._tab,
            search: this._search,
            recents: this._recents.length,
            landing: readLanding(),
            view: this._view,
        };
    }

    /**
     * Switches between the cast and Browse Characters.
     *
     * The marketplace module is imported here, on the first switch, and nowhere else: a
     * gallery that never browses never loads it, and a card site that is down cannot touch
     * the cast (doc §10). If the import itself fails the view stays where it was.
     * @param {'cast'|'browse'} view The view to show.
     * @returns {Promise<void>}
     */
    async showView(view) {
        if (view === 'browse') {
            try {
                await import('../market/k-market.js');
            } catch (error) {
                console.error('[k-library] Browse Characters could not be loaded.', error);
                return;
            }
        }
        this._view = view;
        // The other view renders a fresh sheet at its head, and a fresh sheet fires no scroll
        // event; the depth is reset here so the pill does not linger over the new view's top.
        this._deep = false;
    }

    /**
     * Scrolls the sheet back to its head. Smooth unless the reader asked for less motion.
     * @returns {void}
     */
    scrollToTop() {
        const sheet = this.querySelector('.k-lib-sheet');
        if (!(sheet instanceof HTMLElement)) return;
        const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        sheet.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    }

    /**
     * @param {Map<string, unknown>} changed Changed properties.
     * @returns {void}
     */
    updated(changed) {
        // The body class is a plain mirror of "open, in Browse": set on the first paint that
        // is, dropped on the first that is not, for whatever reason — the switch, the close
        // affordance, a chat opening underneath. Nothing else writes it.
        if (changed.has('open') || changed.has('_view')) {
            document.body.classList.toggle(BROWSE_OPEN_CLASS, this.open && this._view === 'browse');
        }
    }

    /* ── state ──────────────────────────────────────────────────────────── */

    /**
     * Decides whether the gallery is on screen.
     *
     * Two inputs, both read fresh: is a chat open, and does the landing setting name us. A
     * chat opening always wins — that is the "card click opens the chat and the library gets
     * out of the way" behaviour, and it is why the card click needs no close call of its own.
     * @returns {void}
     */
    #syncVisibility() {
        const chatId = getCurrentChatId();
        this._hasChat = chatId !== undefined;
        if (this._hasChat) {
            this.open = false;
            return;
        }
        this.open = readLanding() === 'library';
    }

    /** Coalesces the burst of core events a single roster change produces. */
    #scheduleRefresh() {
        if (this.#refreshTimer !== 0) {
            return;
        }
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = 0;
            this.#refresh();
        }, REFRESH_DEBOUNCE_MS);
    }

    /**
     * Rebuilds every row.
     *
     * Gated on {@link KLibrary.#coreReady}: `getEntitiesList()` reads `characters`, `groups`
     * and the tag map, and reading those before the first `CHARACTER_PAGE_LOADED` is what
     * shell-qa's console-clean gate is watching for. Before then the gallery renders its
     * quiet loading state, not its empty state — "no one is here" and "nobody has arrived
     * yet" are different sentences.
     * @returns {void}
     */
    #refresh() {
        if (!this.#coreReady) {
            return;
        }
        this._rows = sortRows(buildRows());
        this._ready = true;
    }

    /**
     * Loads the continue strip.
     *
     * `POST /api/chats/recent` is the same endpoint the welcome screen uses, and the rows are
     * decorated the same way (`welcome-screen.js:802-814`). Its `pinned` argument is sent as
     * an empty list on purpose: `PinnedChatsManager` is module-private to `welcome-screen.js`
     * and pinning is a hearth feature, so the library asks only for "most recent" and never
     * writes pin state it cannot read back.
     *
     * Gated on the same readiness latch the roster uses, for two reasons: the decoration needs
     * `characters` / `groups` to resolve a chat to an entity at all, and `getRequestHeaders()`
     * carries a CSRF token core fetches during its own boot — asking early would put a 403 in
     * the console for an answer we could not have used anyway. `APP_READY` is sticky on core's
     * emitter (`events.js:113`), so a re-mounted element gets the latch replayed rather than
     * waiting forever for an event that has already happened.
     * @returns {Promise<void>}
     */
    async #loadRecents() {
        if (!this.#coreReady) {
            return;
        }
        const token = ++this.#recentToken;
        try {
            const response = await fetch('/api/chats/recent', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ max: RECENT_MAX, pinned: [] }),
                cache: 'no-cache',
            });
            if (!response.ok) {
                console.warn('[k-library] recent chats request failed');
                return;
            }
            const data = await response.json();
            if (token !== this.#recentToken || !Array.isArray(data)) {
                return;
            }
            const decorated = data
                .map(entry => ({
                    entry,
                    character: characters.find(x => x.avatar === entry.avatar),
                    group: groups.find(x => x.id === entry.group),
                }))
                .filter(pair => pair.character || pair.group)
                .slice(0, RECENT_MAX)
                .map(({ entry, character, group }) => {
                    const moment = timestampToMoment(entry.last_mes);
                    return {
                        ...entry,
                        char_name: character?.name || group?.name || '',
                        date_short: moment?.isValid() ? moment.format('l') : '',
                        date_long: moment?.isValid() ? moment.format('LL LT') : '',
                        relative: moment?.isValid() ? toRelative(moment.valueOf()) : '',
                        chat_name: String(entry.file_name ?? '').replace('.jsonl', ''),
                        char_thumbnail: character ? getThumbnailUrl('avatar', character.avatar) : system_avatar,
                        is_group: Boolean(group),
                        avatar: entry.avatar || '',
                        group: entry.group || '',
                    };
                });
            this._recents = decorated;
        } catch (error) {
            if (token === this.#recentToken) {
                console.warn('[k-library] recent chats read failed', error);
            }
        }
    }

    /* ── interaction ────────────────────────────────────────────────────── */

    /**
     * Escape returns to the chat — but only when it is the outermost thing Escape could mean.
     *
     * Capture phase, so this would otherwise pre-empt core's whole Escape cascade
     * (`RossAscends-mods.js:1175-1265`, bubble phase) and every kotatsu surface layered above
     * us. It stands down for all of them and for its own search box, and only then consumes
     * the key. Same discipline as `k-settings-modal.js:#handleEscape`.
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    #handleEscape(event) {
        if (event.key !== 'Escape' || !this.open || !this.isConnected) {
            return;
        }
        // Nothing to return to: the × is hidden in this state and the key must fall through.
        if (!this.#canClose()) {
            return;
        }
        // Surfaces layered over us own the key first.
        if (document.querySelector('dialog.popup[open]')) return;
        const shadowPopup = document.getElementById('shadow_popup');
        if (shadowPopup && getComputedStyle(shadowPopup).display !== 'none') return;
        // `k-settings-modal-open`, set by <k-settings-modal> for exactly as long as it is
        // connected (k-settings-modal.js `OPEN_CLASS`). It replaced `k-settings-open`, the
        // retired drawer-rack overlay's class, in settings v0.1. Read as a class rather than
        // imported so this component keeps depending on nothing outside its own folder.
        if (document.body.classList.contains('k-settings-modal-open')) return;
        if (document.querySelector('k-branch-map')) return;
        // A populated search box eats the first Escape, the way every search field does.
        const target = event.target;
        if (target instanceof HTMLInputElement && target.classList.contains('k-lib-search-input') && target.value) {
            event.stopPropagation();
            event.preventDefault();
            this._search = '';
            target.value = '';
            return;
        }
        event.stopPropagation();
        event.preventDefault();
        this.closeLibrary();
    }

    /**
     * Fires a REAL click on a stock button.
     *
     * Never a reimplementation: `#rm_button_create` carries three independent handlers
     * (`script.js:11464`, `RossAscends-mods.js:207`, the delegated `tags.js:2779`) and
     * `#character_import_button` triggers a file input core owns (`script.js:12290`). Only a
     * real click fires all of them. `#external_import_button`'s handler is delegated off the
     * document (`script.js:12896`), so the real click reaches it even while the element
     * stands in the parked drawer rack.
     * @param {string} id Element id.
     * @returns {void}
     */
    #clickStock(id) {
        const button = document.getElementById(id);
        if (!button) {
            console.warn(`[k-library] #${id} is missing; the stock flow is unavailable`);
            return;
        }
        button.click();
    }

    /**
     * Create character — straight into `<k-card-studio>` (doc §2.1 item 5).
     *
     * Slice C had to reveal the settings rack first, because the only surface that could hold
     * `#rm_ch_create_block` was the parked drawer, and `select_rm_create()` reveals that block
     * INSIDE it. Slice D removes the detour entirely: the studio borrows the real controls out
     * of the block and shows them in its own sheet, so revealing the rack now would put the
     * same form on screen twice, one copy of it gutted.
     *
     * The real `#rm_button_create.click()` still fires — the studio's own open path does it, so
     * all three handlers (`script.js:11525`, `RossAscends-mods.js:207`, the delegated
     * `tags.js:2779`) run exactly as before and the form lands in create mode before the sheet
     * paints. This is a routing change, not a flow change.
     * @returns {void}
     */
    #onCreateCharacter() {
        this.dispatchEvent(new CustomEvent(OPEN_STUDIO_EVENT, {
            bubbles: true,
            composed: true,
            detail: { target: 'create', source: 'k-library' },
        }));
    }

    /**
     * Edit card — the studio in edit mode.
     *
     * The chid travels in the detail; the studio is what calls `selectCharacterById()`, because
     * making the character ACTIVE is what edit mode requires (`this_chid` is read by
     * `#delete_button`, the alternate-greetings popup and the edit branch of
     * `createOrEditCharacter()`) and that selection opens the character's chat behind the sheet.
     * Documented v0 reality (doc §2.1 item 5), and the reason the gallery hides itself the
     * moment the studio opens in edit mode: `CHAT_CHANGED` fires and `#syncVisibility()` does
     * what it always does.
     * @param {LibraryRow} row Card row.
     * @returns {void}
     */
    #onEditRow(row) {
        if (row.type !== 'character') {
            return;
        }
        this.dispatchEvent(new CustomEvent(OPEN_STUDIO_EVENT, {
            bubbles: true,
            composed: true,
            detail: { target: Number(row.id), source: 'k-library' },
        }));
    }

    /**
     * Opens an entity. The chat that opens fires `CHAT_CHANGED`, which closes the gallery —
     * so there is deliberately no `close()` here to race the navigation.
     * @param {LibraryRow} row Card row.
     * @returns {Promise<void>}
     */
    async #onOpenRow(row) {
        try {
            if (row.type === 'group') {
                await openGroupById(String(row.id));
                return;
            }
            await selectCharacterById(Number(row.id));
        } catch (error) {
            console.error('[k-library] open failed', error);
        }
    }

    /**
     * Toggles a character's favourite flag through core's own quick-fav path.
     *
     * `/api/characters/merge-attributes` — NOT `/edit-attribute`, which the design doc named.
     * Both endpoints exist (`src/endpoints/characters.js:1196` and `:1326`), but merge is the
     * one `BulkEditOverlay.js:69-96` actually uses for quick-fav, and it is the correct one:
     * `fav` lives in TWO places on a card (top-level and `data.extensions.fav`), merge writes
     * both in one request, and `/edit-attribute` refuses any field the file does not already
     * carry — which is exactly the never-favourited card.
     *
     * Groups are display-only in v0: a group's flag lives in its own JSON and is written by
     * `editGroup()`, a different path with its own reload semantics. Chip, not a half-toggle.
     * @param {LibraryRow} row Card row.
     * @returns {Promise<void>}
     */
    async #onToggleFav(row) {
        if (row.type !== 'character') {
            toastr.info('Favouriting a group lives in the group editor for now.', 'Kotatsu');
            return;
        }
        const index = Number(row.id);
        const item = Array.isArray(characters) ? characters[index] : null;
        if (!item) {
            return;
        }
        const next = !row.fav;
        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    name: item.name,
                    avatar: item.avatar,
                    data: { extensions: { fav: next } },
                    fav: next,
                }),
            });
            if (!response.ok) {
                toastr.error('Could not save the favourite. See the console.', 'Kotatsu');
                return;
            }
        } catch (error) {
            console.error('[k-library] favourite write failed', error);
            toastr.error('Could not save the favourite. See the console.', 'Kotatsu');
            return;
        }
        item.fav = next;
        if (item.data && typeof item.data === 'object') {
            item.data.extensions = { ...(item.data.extensions ?? {}), fav: next };
        }
        await favsToHotswap();
        // Keeps the stock list in agreement; its CHARACTER_PAGE_LOADED also refreshes us.
        printCharactersDebounced();
        this.#refresh();
    }

    /**
     * Writes the sort choice into the same three `power_user` keys `#character_sort_order`
     * writes (`power-user.js:3633-3641`), then reprints both surfaces. One setting, two
     * controls — never two settings.
     * @param {string} value `field|order|rule` from the select.
     * @returns {void}
     */
    #onSort(value) {
        const [field, order, rule] = String(value).split('|');
        if (!field) {
            return;
        }
        power_user.sort_field = field;
        power_user.sort_order = order;
        power_user.sort_rule = rule || undefined;
        saveSettingsDebounced();
        printCharactersDebounced();
        this.#refresh();
    }

    /**
     * Opens a chat from the continue strip, through the same path the welcome screen uses
     * (`welcome-screen.js:478-527`, the group variant included).
     * @param {Record<string, any>} recent A decorated recent-chat row.
     * @returns {Promise<void>}
     */
    async #onOpenRecent(recent) {
        try {
            if (recent.is_group) {
                const group = groups.find(x => x.id === recent.group);
                if (!group) {
                    console.warn(`[k-library] group not found for id: ${recent.group}`);
                    return;
                }
                await openGroupById(recent.group);
                setActiveGroup(recent.group);
                saveSettingsDebounced();
                if (getCurrentChatId() === recent.chat_name) {
                    return;
                }
                await openGroupChat(recent.group, recent.chat_name);
                return;
            }
            const characterId = characters.findIndex(x => x.avatar === recent.avatar);
            if (characterId === -1) {
                console.warn(`[k-library] character not found for avatar: ${recent.avatar}`);
                return;
            }
            await selectCharacterById(characterId);
            setActiveCharacter(recent.avatar);
            saveSettingsDebounced();
            if (getCurrentChatId() === recent.chat_name) {
                return;
            }
            await openCharacterChat(recent.chat_name);
        } catch (error) {
            console.error('[k-library] recent chat open failed', error);
            toastr.error('Failed to open that chat. See the console.', 'Kotatsu');
        }
    }

    /* ── render ─────────────────────────────────────────────────────────── */

    render() {
        // Closed means NOT RENDERED, not merely hidden: a gallery of 40 posters left in the
        // DOM behind an open chat would keep 40 lazy <img> elements alive for nothing.
        if (!this.open) {
            return nothing;
        }
        const counts = countRows(this._rows);
        // Browse Characters replaces the cast's three blocks and nothing above them. `_rows`
        // rides along as the revision: whenever the library changes, the view re-reads which
        // of its cards are already installed.
        if (this._view === 'browse') {
            return html`
                <div class="k-lib-sheet" role="region" aria-label="Library">
                    <div class="k-lib-page">
                        ${this.#renderBrandRow()}
                        ${this.#renderHero()}
                        ${this.#renderViews()}
                        <k-market variant="browse" .revision=${this._rows}></k-market>
                        ${this.#renderJump()}
                    </div>
                </div>`;
        }
        const visible = filterRows(this._rows, { search: this._search, tab: this._tab });
        return html`
            <div class="k-lib-sheet" role="region" aria-label="Library">
                <div class="k-lib-page">
                    ${this.#renderBrandRow()}
                    ${this.#renderHero()}
                    ${this.#renderViews()}
                    ${this.#renderContinue()}
                    ${this.#renderTools(counts)}
                    ${this.#renderBody(visible, counts)}
                    ${this.#renderJump()}
                </div>
            </div>`;
    }

    /**
     * The way back, once the head of the page is off screen: a pill stuck to the sheet's
     * foot (`position: sticky; bottom`, zero height in flow, so nothing moves to make room).
     * "Top" in both views; in Browse, "Your cast" beside it, because that is where the reader
     * actually wants to go. Always rendered, shown by `data-visible`, so the fade works.
     * @returns {unknown} The pill.
     */
    #renderJump() {
        const browsing = this._view === 'browse';
        return html`
            <div class="k-lib-jump" ?data-visible=${this._deep} aria-hidden=${this._deep ? 'false' : 'true'}>
                ${browsing ? html`
                    <button type="button" class="k-lib-jump-btn k-lib-jump-cast" tabindex=${this._deep ? '0' : '-1'}
                        @click=${() => { void this.showView('cast').then(() => this.scrollToTop()); }}>${icons.cast}<span>Your cast</span></button>` : nothing}
                <button type="button" class="k-lib-jump-btn k-lib-jump-top" tabindex=${this._deep ? '0' : '-1'}
                    @click=${() => this.scrollToTop()}>${icons.up}<span>Top</span></button>
            </div>`;
    }

    /** @returns {unknown} The switch between the two sources of the same gallery. */
    #renderViews() {
        return html`
            <div class="k-lib-views" role="tablist" aria-label="Source">
                <button
                    type="button" role="tab" class="k-lib-view${this._view === 'cast' ? ' is-active' : ''}"
                    data-view="cast"
                    aria-selected=${this._view === 'cast' ? 'true' : 'false'}
                    @click=${() => { void this.showView('cast'); }}
                >Your cast</button>
                <button
                    type="button" role="tab" class="k-lib-view${this._view === 'browse' ? ' is-active' : ''}"
                    data-view="browse"
                    aria-selected=${this._view === 'browse' ? 'true' : 'false'}
                    @click=${() => { void this.showView('browse'); }}
                >Browse Characters</button>
            </div>`;
    }

    /** @returns {unknown} Brand row: lockup, version, and the way out. */
    #renderBrandRow() {
        // Hidden when nothing is behind us, per doc §1.1: a close button that reveals an empty
        // room is a trap with no exit. See {@link KLibrary.#canClose}.
        const close = this.#canClose()
            ? html`<button type="button" class="k-lib-close" title="Back to the chat" aria-label="Back to the chat"
                    @click=${() => this.closeLibrary()}>${icons.close}</button>`
            : nothing;
        return html`
            <header class="k-lib-brandrow">
                <div class="k-lib-brand">
                    ${brandLockup()}
                    <span class="k-lib-version">${displayVersion}</span>
                </div>
                ${close}
            </header>`;
    }

    /** @returns {unknown} Hero: eyebrow, serif question, sub-line, and the actions. */
    #renderHero() {
        // The question is the same in both views. The eyebrow and the line under it say which
        // room the answer comes from.
        const browsing = this._view === 'browse';
        return html`
            <section class="k-lib-hero">
                <div class="k-lib-hero-copy">
                    <span class="k-lib-eyebrow">${browsing ? '✦ Browse Characters' : '✦ The cast'}</span>
                    <h1 class="k-lib-title">Who are we meeting tonight?</h1>
                    <p class="k-lib-sub">${browsing ? 'Somebody new. Read the card before you bring them home.' : 'Your cast, their worlds, every thread of them.'}</p>
                </div>
                <div class="k-lib-hero-actions">
                    <button
                        type="button"
                        class="k-lib-btn k-lib-btn--ghost"
                        @click=${() => this.#clickStock('character_import_button')}
                    >${icons.import}<span>Import card</span></button>
                    <button
                        type="button"
                        class="k-lib-btn k-lib-btn--ghost"
                        @click=${() => this.#clickStock('external_import_button')}
                    >${icons.link}<span>Import from URL</span></button>
                    <button
                        type="button"
                        class="k-lib-btn k-lib-btn--primary"
                        @click=${() => this.#onCreateCharacter()}
                    >${icons.plus}<span>Create character</span></button>
                </div>
            </section>`;
    }

    /** @returns {unknown} The continue strip, or nothing when there are no recents. */
    #renderContinue() {
        if (this._recents.length === 0) {
            return nothing;
        }
        return html`
            <section class="k-lib-continue">
                <h2 class="k-lib-sectiontitle">Pick up where you left off</h2>
                <div class="k-lib-recents">
                    ${this._recents.map(recent => html`
                        <button
                            type="button"
                            class="k-lib-recent${recent.is_group ? ' k-lib-recent--group' : ''}"
                            title=${`${recent.char_name} — ${recent.chat_name}${recent.date_long ? ` (${recent.date_long})` : ''}`}
                            @click=${() => this.#onOpenRecent(recent)}
                        >
                            <img class="k-lib-recent-face" src=${recent.char_thumbnail} alt="" loading="lazy" decoding="async" />
                            <span class="k-lib-recent-copy">
                                <span class="k-lib-recent-name">${recent.char_name}</span>
                                <span class="k-lib-recent-chat">${chatLabelText(recent.chat_name, recent.char_name)}</span>
                            </span>
                            ${recent.relative ? html`<span class="k-lib-recent-when">${recent.relative}</span>` : nothing}
                        </button>`)}
                </div>
            </section>`;
    }

    /**
     * @param {{ all: number, favorites: number }} counts Tab counts over the unfiltered set.
     * @returns {unknown} Search box, tabs, sort select.
     */
    #renderTools(counts) {
        // The selection is expressed per OPTION, not as `.value` on the select. lit-html
        // commits an element's own parts before its children exist, so a `.value` binding on
        // the `<select>` would run against an option-less element on the first render and
        // silently fall back to the browser's default. `.selected` on each option is committed
        // in document order and the one true value wins.
        const active = SORT_OPTIONS.find(option => option.field === power_user?.sort_field
            && option.order === power_user?.sort_order);
        return html`
            <div class="k-lib-tools">
                <label class="k-lib-search">
                    ${icons.search}
                    <input
                        class="k-lib-search-input"
                        type="search"
                        placeholder="Search the cast…"
                        aria-label="Search the cast"
                        .value=${this._search}
                        @input=${(/** @type {Event} */ event) => this.#onSearchInput(event)}
                    />
                </label>
                <div class="k-lib-tabs" role="tablist" aria-label="Filter">
                    <button
                        type="button" role="tab" class="k-lib-tab${this._tab === 'all' ? ' is-active' : ''}"
                        aria-selected=${this._tab === 'all' ? 'true' : 'false'}
                        @click=${() => { this._tab = 'all'; }}
                    >All <span class="k-lib-tab-count">${counts.all}</span></button>
                    <button
                        type="button" role="tab" class="k-lib-tab${this._tab === 'favorites' ? ' is-active' : ''}"
                        aria-selected=${this._tab === 'favorites' ? 'true' : 'false'}
                        @click=${() => { this._tab = 'favorites'; }}
                    >Favorites <span class="k-lib-tab-count">${counts.favorites}</span></button>
                </div>
                <select
                    class="k-lib-sort"
                    aria-label="Sort order"
                    @change=${(/** @type {Event} */ event) => this.#onSortChange(event)}
                >
                    ${SORT_OPTIONS.map(option => html`
                        <option value=${`${option.field}|${option.order}|${option.rule ?? ''}`} .selected=${option === active}>${option.label}</option>`)}
                </select>
            </div>`;
    }

    /**
     * @param {Event} event Input event from the search box.
     * @returns {void}
     */
    #onSearchInput(event) {
        const input = event.target;
        if (input instanceof HTMLInputElement) {
            this._search = input.value;
        }
    }

    /**
     * @param {Event} event Change event from the sort select.
     * @returns {void}
     */
    #onSortChange(event) {
        const select = event.target;
        if (select instanceof HTMLSelectElement) {
            this.#onSort(select.value);
        }
    }

    /**
     * @param {LibraryRow[]} visible Rows after search and tab.
     * @param {{ all: number, favorites: number }} counts Unfiltered counts.
     * @returns {unknown} The grid, or the honest empty state.
     */
    #renderBody(visible, counts) {
        if (!this._ready) {
            return html`<p class="k-lib-quiet">Gathering the cast…</p>`;
        }
        if (visible.length > 0) {
            return html`
                <div class="k-lib-grid">
                    ${visible.map(row => renderCard(row, this.#cardHandlers))}
                </div>`;
        }
        // Two different silences, and the copy is the doc's (§1.2 item 6). "Nobody matches" is
        // a search result; "nobody is here" is a library that has never been filled, and only
        // the second one offers Import — there is nothing to import your way out of a search.
        const searching = counts.all > 0;
        const title = searching ? 'No one answers that description.' : 'The room is warm and empty.';
        const sub = searching
            ? 'Try another search, or make somebody new.'
            : 'Import a card you already love, or make somebody new.';
        const importButton = searching
            ? nothing
            : html`<button type="button" class="k-lib-btn k-lib-btn--ghost"
                    @click=${() => this.#clickStock('character_import_button')}>${icons.import}<span>Import card</span></button>`;
        const urlImportButton = searching
            ? nothing
            : html`<button type="button" class="k-lib-btn k-lib-btn--ghost"
                    @click=${() => this.#clickStock('external_import_button')}>${icons.link}<span>Import from URL</span></button>`;
        // The third door (character-marketplace v0 §9): the same switch as the tools row, for
        // the reader who has nobody yet and nothing to import.
        const browseButton = searching
            ? nothing
            : html`<button type="button" class="k-lib-btn k-lib-btn--ghost k-lib-empty-browse"
                    @click=${() => { void this.showView('browse'); }}>${icons.browse}<span>Browse Characters</span></button>`;
        return html`
            <div class="k-lib-empty">
                <p class="k-lib-empty-title">${title}</p>
                <p class="k-lib-empty-sub">${sub}</p>
                <div class="k-lib-empty-actions">
                    ${importButton}
                    ${urlImportButton}
                    ${browseButton}
                    <button type="button" class="k-lib-btn k-lib-btn--primary"
                        @click=${() => this.#onCreateCharacter()}
                    >${icons.plus}<span>Create character</span></button>
                </div>
            </div>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-library')) {
    customElements.define('k-library', KLibrary);
}

/* ── the host: mounted by the rails layout, doors owned by the element ────── */

/** @returns {KLibrary|null} The mounted gallery, or null. */
function currentLibrary() {
    const element = document.querySelector('k-library');
    return element instanceof KLibrary ? element : null;
}

/**
 * Mounts the gallery into the centre column. Called by the rails layout's `mount()`.
 *
 * Appended rather than prepended: `<k-chat-header>` prepends and `#sheld` is relocated in, so
 * appending puts the overlay last in paint order inside `#k-center` without needing a z-index
 * fight with either.
 * @param {HTMLElement|null} host Usually `#k-center`.
 * @returns {KLibrary|null} The mounted element, or null when the host is missing.
 */
export function mountLibrary(host) {
    if (!host) {
        console.warn('[k-library] no host element; the gallery will not mount.');
        return null;
    }
    const existing = currentLibrary();
    if (existing) {
        return existing;
    }
    const element = /** @type {KLibrary} */ (document.createElement('k-library'));
    element.setAttribute('variant', 'gallery');
    host.appendChild(element);
    return element;
}

/** Removes the gallery. Called by the rails layout's `unmount()`. @returns {void} */
export function unmountLibrary() {
    currentLibrary()?.remove();
}

/** @returns {void} */
export function openLibrary() {
    const library = currentLibrary();
    if (!library) {
        console.warn('[k-library] the gallery is not mounted (classic layout?).');
        return;
    }
    library.openLibrary();
}

/** @returns {void} */
export function closeLibrary() {
    currentLibrary()?.closeLibrary();
}

/**
 * Opens the gallery on one of its views. The welcome tour's "Browse Characters" tile is the
 * caller that needs both at once.
 * @param {'cast'|'browse'} view The view to show.
 * @returns {Promise<boolean>} False when the gallery is not mounted (classic layout).
 */
export async function showLibraryView(view) {
    const library = currentLibrary();
    if (!library) {
        console.warn('[k-library] the gallery is not mounted (classic layout?).');
        return false;
    }
    if (!library.open) library.openLibrary();
    await library.showView(view);
    return library.state.view === view;
}

/** @returns {object|null} The console door's `.state`. */
export function libraryState() {
    return currentLibrary()?.state ?? null;
}

/* ── the landing picker (User Settings → UI Theme, beside the wardrobe) ───── */

/** Human labels for the two landings. */
const LANDING_LABELS = Object.freeze({ library: 'Library', hearth: 'Hearth' });

let pickerInitialized = false;

/**
 * Renders the landing select from current settings.
 *
 * Mirrors `theme/wardrobe.js`: the select is a VIEW of a resolution someone else owns, so it
 * is re-rendered rather than trusted to hold state, and its note says the one thing that is
 * not obvious — that the setting does nothing outside the rails layout.
 * @returns {void}
 */
export function renderLandingPicker() {
    const select = document.getElementById('kotatsu_landing');
    if (select instanceof HTMLSelectElement) {
        select.value = readLanding();
    }
    const note = document.getElementById('kotatsu_landing_note');
    if (note) {
        const railsActive = document.body.dataset.kLayout === 'rails';
        note.textContent = railsActive ? '' : 'Rails layout only — Classic always opens the welcome screen.';
        note.hidden = railsActive;
    }
}

/**
 * Builds the landing select and wires it. Idempotent; safe to call at the shell seam.
 *
 * Options are built from {@link LANDING_IDS} rather than hard-coded in `index.html`, for the
 * reason `wardrobe.js` gives: the markup must not be able to drift from the frozen set.
 * @returns {void}
 */
export function installLandingPicker() {
    if (pickerInitialized) {
        return;
    }
    pickerInitialized = true;

    const select = document.getElementById('kotatsu_landing');
    if (select instanceof HTMLSelectElement) {
        select.replaceChildren();
        for (const id of LANDING_IDS) {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = LANDING_LABELS[id] ?? id;
            select.append(option);
        }
        select.addEventListener('change', () => setLanding(select.value));
    }
    renderLandingPicker();
    eventSource.on(event_types.SETTINGS_LOADED, renderLandingPicker);
}
