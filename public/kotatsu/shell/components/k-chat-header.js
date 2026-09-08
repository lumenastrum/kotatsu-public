/**
 * `<k-chat-header>` — the rails-layout centre-column header strip (shell v0, slice D).
 *
 * The 44px line above the messages, per `docs/shell-v0.md` §"The target > Center":
 *
 *   character name · `/` · <k-chat-switcher> · spacer · message count
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
import { characters, chat, getCurrentChatId, this_chid } from '../../../script.js';
import { event_types, eventSource } from '../../../scripts/events.js';
import { groups, selected_group } from '../../../scripts/group-chats.js';
import { shouldSendOnEnter } from '../../../scripts/RossAscends-mods.js';
// Side-effect import: defines <k-chat-switcher>, rendered in the ident below.
import './k-chat-switcher.js';

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
 * The centre column's header strip.
 */
export class KChatHeader extends LitElement {
    static properties = {
        /** SPEC §13 — present even though `strip` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _name: { state: true },
        _chatId: { state: true },
        _count: { state: true },
    };

    /** @type {ReturnType<typeof setTimeout> | 0} Coalesced refresh handle, 0 = idle. */
    #refreshTimer = 0;

    /** @type {Array<{ type: string, handler: () => void }>} */
    #subscriptions = [];

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
        this.#refresh();
    }

    disconnectedCallback() {
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
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
