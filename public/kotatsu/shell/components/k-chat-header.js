/**
 * `<k-chat-header>` — the rails-layout centre-column header strip (shell v0, slice D).
 *
 * The open chat's identity line, per `docs/shell-v0.md` §"The target > Center":
 *
 *   character name · `/` · <k-chat-switcher> · Scene chip · Background chip · History chip · spacer · message count
 *
 * Two placements, chosen by layouts/rails.js (reader-chrome, 2026-10-22): above 820px it docks
 * into `<k-topbar>`'s centre zone as variant `bar`, so the reader loses one strip instead of
 * two; at 820 and under it is the 44px `strip` above the messages, flanked by the phone's rail
 * handles. The Scene chip (scenes only) peeks at the scene's text, which no longer stays pinned
 * over the transcript (`k-scene-banner.js`), and asks the banner for an edit.
 *
 * The chat title is `<k-chat-switcher>`'s (that component owns the title
 * button, the switcher popover and the branch chip — see its header). The old
 * breadcrumb pill is DELETED: it predated BranchStore, faked a `main` trunk,
 * and repeated the title beside itself (smoke follow-up 2026-08-25; design
 * canvas "Kotatsu Chat Switcher").
 *
 * Mounted by `layouts/rails.js`, which PREPENDS it into `#k-center` (the slot is never
 * cleared — `restoreAll()` owns the relocated `#sheld`). Every rule that paints it lives
 * in `public/css/shell-center.css`.
 *
 * Contracts this component honours (the k-topbar.js / k-rail-left.js house patterns):
 *
 * - **Light DOM.** `createRenderRoot()` returns `this`, so `css/shell-center.css` and a
 *   theme pack's `sheet.css` both reach the internals, and `initDynamicStyles()`
 *   (dynamic-styles.js:188-202) can see the hover/focus-visible pairs it audits.
 * - **SPEC §13 variant attribute.** `strip` is the only v0 variant; the attribute is on
 *   the element from the first frame anyway so a second one costs no DOM change.
 * - **One-way imports.** kotatsu → core only.
 * - **No fabricated data.** The breadcrumb shows the trunk and the open chat, and says so
 *   in its tooltip. There is no branch tree in v0 (BranchStore is ladder step 3), so none
 *   is drawn. When `selected_group` is set the group's own `name` is used if the record is
 *   there, and NOTHING is printed if it is not — a missing name renders as the chat id
 *   alone rather than as the wrong character's name.
 * - **Collapses when there is no chat.** `getCurrentChatId()` is the test. With no chat
 *   open the element takes the `empty` attribute and `shell-center.css` hides it outright:
 *   the welcome screen needs no header, and a 44px hairline over nothing is a lie about
 *   there being something.
 *
 * Core reads (verified against the files, not the maps):
 *   `characters`         script.js:427  — live `export let`
 *   `this_chid`          script.js:432  — live `export let`, may be undefined or a string
 *   `chat`               script.js:411  — live `export let`; `chat.length` is the count
 *   `getCurrentChatId()` script.js:541  — group `chat_id` or `characters[this_chid].chat`
 *   `selected_group`     group-chats.js:92 (export list) — null when solo
 *   `groups`             group-chats.js:92 (export list) — records carry `id` and `name`
 *   `shouldSendOnEnter()` RossAscends-mods.js:149 — see `#syncComposerHint()`
 *
 * Boot order: this may mount before settings or characters have loaded. Every read is
 * guarded, the strip simply stays collapsed until there is a chat, and `APP_READY` is an
 * auto-fire event on core's emitter (lib/eventemitter.js:56-58) so a late subscription is
 * replayed immediately.
 */

import { LitElement, html, nothing } from '../lit.js';
import { characters, chat, chat_metadata, getCurrentChatId, this_chid } from '../../../script.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { groups, selected_group } from '../../../scripts/group-chats.js';
import { shouldSendOnEnter } from '../../../scripts/RossAscends-mods.js';
// Side-effect import: defines <k-chat-switcher>, rendered in the ident below.
import './k-chat-switcher.js';
import { openScene } from '../../groups/stage-actions.js';
import { SCENE_CHANGED_EVENT, SCENE_EDIT_EVENT } from '../../groups/k-scene-banner.js';
// Side-effect import: defines <k-backdrop-chip>, which shows itself in the Sprite view only.
import '../../sprites/k-backdrop-chip.js';
// Side-effect import: defines <k-vn-history>, which shows itself in the phone's theatre only.
import '../../sprites/k-vn-history.js';

/** Coalescing window for bursty core events (one chat switch fires several). */
const REFRESH_DEBOUNCE_MS = 60;

/**
 * `event_types` KEYS after which anything on the strip may be stale. Looked up by key and
 * skipped when absent, so an upstream rename degrades to one missing listener instead of a
 * boot-time crash (the k-topbar.js pattern).
 *
 * Deliberately excludes the per-token streaming events: the count comes off `chat.length`,
 * which only moves on the four message lifecycle events below, and the network has no
 * business being touched from inside the generation loop.
 */
const REFRESH_EVENTS = [
    'APP_READY',
    'CHAT_CHANGED',
    'CHAT_RENAMED',
    'CHARACTER_RENAMED',
    'CHARACTER_EDITED',
    'GROUP_UPDATED',
    'MESSAGE_SENT',
    'MESSAGE_RECEIVED',
    'MESSAGE_DELETED',
    'MESSAGE_SWIPE_DELETED',
    'SETTINGS_UPDATED',
    'SETTINGS_LOADED_AFTER',
];

/**
 * The active character's index, or -1 when a group is open or nothing is selected.
 * `this_chid` is `undefined` before a selection and can arrive as a numeric string.
 * @returns {number} Character index, or -1.
 */
function activeCharacterIndex() {
    if (selected_group) {
        return -1;
    }
    if (this_chid === undefined || this_chid === null || this_chid === '') {
        return -1;
    }
    const index = Number(this_chid);
    return Number.isInteger(index) && index >= 0 ? index : -1;
}

/**
 * The name to print before the `/`, or '' when there is nothing certain to print.
 *
 * A group whose record has not landed yet returns '' rather than falling through to the
 * character branch — under a group, `this_chid` may still hold the last solo character and
 * printing it would put the wrong name over the wrong chat.
 * @returns {string} Display name, or ''.
 */
function readSubjectName() {
    try {
        if (selected_group) {
            const list = Array.isArray(groups) ? groups : [];
            const group = list.find(entry => String(entry?.id) === String(selected_group));
            return String(group?.name ?? '').trim();
        }
        const index = activeCharacterIndex();
        if (index < 0 || !Array.isArray(characters)) {
            return '';
        }
        return String(characters[index]?.name ?? '').trim();
    } catch (error) {
        console.error('[k-chat-header] subject name read failed', error);
        return '';
    }
}

/**
 * The open scene's text, or '' outside a scene or when none is set.
 * @returns {string} Scene text.
 */
function readScene() {
    try {
        return openScene() ? String(chat_metadata?.scenario ?? '').trim() : '';
    } catch (error) {
        console.error('[k-chat-header] scene read failed', error);
        return '';
    }
}

/** A framed landscape: the scene. Stroke glyph, no icon set (repo CLAUDE.md). */
const sceneIcon = html`<svg class="k-ch__scene-icon" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m2.5 11.5 3.5-3.5 2.5 2.5 1.5-1.5 3.5 3"/><circle cx="10.5" cy="6" r="1"/></svg>`;

/**
 * The open chat's header: a strip over the messages, or docked in the top bar.
 */
export class KChatHeader extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `strip` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _name: { state: true },
        _chatId: { state: true },
        _count: { state: true },
        _scene: { state: true },
        _peek: { state: true },
    };

    /** @type {ReturnType<typeof setTimeout> | 0} Coalesced refresh handle, 0 = idle. */
    #refreshTimer = 0;

    /** @type {Array<{ type: string, handler: () => void }>} */
    #subscriptions = [];

    #onSceneChanged = () => this.#scheduleRefresh();

    /** Closes the peek on a press outside the chip and its card. */
    #onOutsidePress = (/** @type {PointerEvent} */ event) => {
        const scene = this.querySelector('.k-ch__scene');
        if (scene && !event.composedPath().includes(scene)) this.#closePeek();
    };

    #onPeekKey = (/** @type {KeyboardEvent} */ event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        this.#closePeek();
        /** @type {HTMLElement | null} */ (this.querySelector('.k-ch__scene-chip'))?.focus();
    };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'strip';
        /** @type {string} Character or group name; '' when nothing certain is known. */
        this._name = '';
        /** @type {string} The open chat's id — also its title. '' when no chat is open. */
        this._chatId = '';
        /** @type {number} Messages in the open chat. */
        this._count = 0;
        /** @type {string} The open scene's text; '' hides the Scene chip. */
        this._scene = '';
        /** @type {boolean} Whether the scene peek is open. */
        this._peek = false;
    }

    /** Light DOM: `public/css/shell-center.css` owns every rule. */
    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        // Guarantee the variant hook is on the element from the first frame, whether or not
        // the mounting layout authored it, without waiting for Lit's reflection pass.
        if (!this.hasAttribute('variant')) {
            this.setAttribute('variant', this.variant);
        }
        // Collapsed until proven otherwise: no attribute flash of an empty 44px hairline.
        this.toggleAttribute('empty', true);

        for (const key of REFRESH_EVENTS) {
            const type = event_types ? event_types[key] : undefined;
            if (typeof type !== 'string' || this.#subscriptions.some(s => s.type === type)) {
                continue;
            }
            const handler = () => this.#scheduleRefresh();
            this.#subscriptions.push({ type, handler });
            eventSource.on(type, handler);
        }
        document.addEventListener(SCENE_CHANGED_EVENT, this.#onSceneChanged);
        this.#refresh();
    }

    disconnectedCallback() {
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
        document.removeEventListener(SCENE_CHANGED_EVENT, this.#onSceneChanged);
        this.#closePeek();
        if (this.#refreshTimer !== 0) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = 0;
        }
        // The composer hint is ours; it must not outlive the component that keeps it true.
        delete document.body.dataset.kSendOnEnter;
        super.disconnectedCallback();
    }

    /** Coalesces the burst of core events a single chat switch produces. */
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
     * Re-reads core state. Never throws: a header that crashes at boot takes the layout's
     * mount with it (`rails.js` imports this module inside a try/catch, but a throw AFTER
     * `customElements.define()` lands in Lit's update, not in that catch).
     */
    #refresh() {
        let chatId = '';
        try {
            chatId = String(getCurrentChatId() ?? '');
        } catch (error) {
            console.error('[k-chat-header] active chat read failed', error);
            chatId = '';
        }

        this._chatId = chatId;
        this._name = chatId ? readSubjectName() : '';
        this._count = Array.isArray(chat) ? chat.length : 0;
        this._scene = chatId ? readScene() : '';
        if (!this._scene) this.#closePeek();
        // Drives `k-chat-header[empty] { display: none }` — see shell-center.css §1.
        this.toggleAttribute('empty', !chatId);

        this.#syncComposerHint();
    }

    /**
     * Publishes the ONE composer binding that varies, as `body[data-k-send-on-enter]`.
     *
     * The keyboard-hint line under the composer is a `::after` on `#form_sheld` (no DOM of
     * ours can live inside a core form we are forbidden to rebuild), and a pseudo-element
     * cannot read a setting. `power_user.send_on_enter` has three states — DISABLED(-1),
     * AUTO(0), ENABLED(1) — and AUTO additionally depends on `isMobile()`
     * (RossAscends-mods.js:153-160), so a hardcoded "Enter send" is simply false for some
     * users. Rather than print a binding that may not exist, the component asks core's own
     * predicate and lets CSS pick the true sentence.
     *
     * This is the centre column's only JS, which is why the composer's hint lives here.
     * The attribute is removed in `disconnectedCallback()`.
     */
    #syncComposerHint() {
        let sends = false;
        try {
            sends = Boolean(shouldSendOnEnter());
        } catch (error) {
            console.error('[k-chat-header] send-on-enter read failed', error);
            sends = false;
        }
        document.body.dataset.kSendOnEnter = sends ? 'yes' : 'no';
    }

    #togglePeek() {
        if (this._peek) {
            this.#closePeek();
            return;
        }
        this._scene = readScene();
        this._peek = true;
        document.addEventListener('pointerdown', this.#onOutsidePress, true);
        document.addEventListener('keydown', this.#onPeekKey, true);
    }

    #closePeek() {
        this._peek = false;
        document.removeEventListener('pointerdown', this.#onOutsidePress, true);
        document.removeEventListener('keydown', this.#onPeekKey, true);
    }

    /** The banner owns the editor; it scrolls to the head of the transcript and opens it. */
    #editScene() {
        this.#closePeek();
        document.dispatchEvent(new CustomEvent(SCENE_EDIT_EVENT));
    }

    #renderScene() {
        if (!this._scene) return nothing;
        return html`
            <div class="k-ch__scene">
                <button type="button" class="k-ch__scene-chip" aria-expanded=${String(this._peek)}
                    aria-controls="k-ch-scene-peek" aria-label="The scene" title="The scene" @click=${() => this.#togglePeek()}>
                    ${sceneIcon}<span>Scene</span>
                </button>
                ${this._peek ? html`
                    <div class="k-ch__scene-peek" id="k-ch-scene-peek" role="dialog" aria-label="The scene">
                        <p class="k-ch__scene-text">${this._scene}</p>
                        <div class="k-ch__scene-actions">
                            <button type="button" class="k-ch__scene-edit" @click=${() => this.#editScene()}>Edit the scene</button>
                        </div>
                    </div>` : nothing}
            </div>`;
    }

    render() {
        if (!this._chatId) {
            return nothing;
        }
        return html`
            <div class="k-ch__row">
                <div class="k-ch__ident">
                    ${this._name ? html`
                        <span class="k-ch__char" title=${this._name}>${this._name}</span>
                        <span class="k-ch__sep" aria-hidden="true">/</span>` : nothing}
                    <k-chat-switcher></k-chat-switcher>
                </div>
                ${this.#renderScene()}
                <k-backdrop-chip></k-backdrop-chip>
                <k-vn-history></k-vn-history>
                <span class="k-ch__spacer"></span>
                <span class="k-ch__count" title="${this._count} messages in this chat">
                    <span class="k-ch__count-value">${this._count}</span>
                    <span class="k-ch__count-unit">msg</span>
                </span>
            </div>`;
    }
}

if (!customElements.get('k-chat-header')) {
    customElements.define('k-chat-header', KChatHeader);
}
