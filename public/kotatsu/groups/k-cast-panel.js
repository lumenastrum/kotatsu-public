/**
 * `<k-cast-panel>` — the right rail's Cast tab in a scene (`docs/group-chat-v0.md` G4, board B).
 *
 * The room, where the stage strip is the moment: the scene's cover and name, who speaks after
 * you (the four plain-language styles), Up next (the round in flight plus the user's cues — cues
 * can be dropped and reordered), every member with their live state, share of the replies,
 * Speak and Mute, the way into Edit scene, and Let them talk with its pace.
 *
 * Reads the same `cast-state.js` + `round-store.js` as `<k-stage>`, acts through the same
 * `stage-actions.js`. Light DOM, `variant="rail"`; rules in css/scenes.css §7.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters, chat, getThumbnailUrl } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { seats } from './cast-state.js';
import { cueQueue } from './cue-queue.js';
import { OPEN_SCENE_STUDIO_EVENT } from './doors.js';
import { roundStore } from './round-store.js';
import { NARRATOR_PACE_KEY, narratorPace } from './narrator.js';
import { TURN_STYLES, clampDelay, hueColor, isCustomCover, turnStyle } from './scene-model.js';
import { openScene, sceneNarrator, setMuted, setTalking, setTurnStyle, speakNow, talking } from './stage-actions.js';

const REFRESH_EVENTS = [
    'APP_READY', 'CHAT_CHANGED', 'GROUP_UPDATED', 'CHARACTER_EDITED', 'CHARACTER_DELETED',
    'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
    // Core turns auto mode off by itself (typing, Stop); the switch must follow.
    'GROUP_AUTO_MODE_CHANGED',
];

/** @type {Record<string, string>} */
const STATE_LINE = {
    writing: 'writing…',
    next: 'up next',
    queued: 'speaking this round',
    cued: 'cued',
    muted: 'muted · still in the room',
    missing: 'card missing',
    idle: '',
};

const icons = {
    edit: html`<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M10.5 3.5 12.5 5.5 6 12H4v-2z"/></svg>`,
    speak: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4.5 3v10l8.5-5z"/></svg>`,
    mute: html`<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="m11.5 6.5 3 3m0-3-3 3"/></svg>`,
    sound: html`<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 6a3 3 0 0 1 0 4"/></svg>`,
    arrow: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M3 8h10M9 4l4 4-4 4"/></svg>`,
    x: html`<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>`,
    plus: html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10"/></svg>`,
    // The narrator seat's mark, as on the stage strip.
    lantern: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.5 4.5a2.5 2.5 0 0 1 5 0"/><path d="M8 6.5h8"/><path d="M8.5 6.5c-1.4 1.6-2 3.6-2 6s.6 4.4 2 6h7c1.4-1.6 2-3.6 2-6s-.6-4.4-2-6"/><path d="M12 10.5c1.1 1.1 1.6 2 1.6 3a1.6 1.6 0 0 1-3.2 0c0-1 .5-1.9 1.6-3z"/><path d="M8 18.5h8"/></svg>`,
};

/**
 * @param {import('./cast-state.js').Seat} seat
 * @returns {string} Identity hue, or the narrator's quiet ink.
 */
function seatColor(seat) {
    return seat.narrator ? 'var(--k-scene-narrator)' : hueColor(seat.hue);
}

export class KCastPanel extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _tick: { state: true },
    };

    /** @type {string[]} */
    #bound = [];

    /** @type {(() => void)|null} */
    #offRound = null;

    #onCore = () => { this._tick++; };

    #onComposerInput = () => { this._tick++; };

    constructor() {
        super();
        /** @type {string} */
        this.variant = 'rail';
        /** @type {number} Bumped to re-render; the panel reads core live on every render. */
        this._tick = 0;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        for (const key of REFRESH_EVENTS) {
            const name = event_types[key];
            if (typeof name === 'string') {
                eventSource.on(name, this.#onCore);
                this.#bound.push(name);
            }
        }
        roundStore.acquire();
        this.#offRound = roundStore.subscribe(this.#onCore);
        document.getElementById('send_textarea')?.addEventListener('input', this.#onComposerInput);
    }

    disconnectedCallback() {
        for (const name of this.#bound) eventSource.removeListener(name, this.#onCore);
        this.#bound = [];
        this.#offRound?.();
        this.#offRound = null;
        roundStore.release();
        document.getElementById('send_textarea')?.removeEventListener('input', this.#onComposerInput);
        super.disconnectedCallback();
    }

    #openStudio() {
        const group = openScene();
        if (!group) return;
        this.dispatchEvent(new CustomEvent(OPEN_SCENE_STUDIO_EVENT, {
            bubbles: true, composed: true, detail: { target: String(group.id), source: 'k-cast-panel' },
        }));
    }

    /**
     * @param {() => unknown} action
     */
    #act(action) {
        Promise.resolve().then(action).then(() => { this._tick++; }).catch(error => console.error('[k-cast-panel] action failed', error));
    }

    render() {
        const group = openScene();
        if (!group) {
            return html`<p class="k-cast-empty">Open a scene to see its cast.</p>`;
        }
        const round = roundStore.round;
        const list = seats(group, characters, chat, round);
        const style = turnStyle(group.activation_strategy);
        const total = list.reduce((sum, seat) => sum + seat.turns, 0);
        const chats = Array.isArray(group.chats) ? group.chats.length : 0;
        const on = talking();
        const castCount = list.filter(seat => !seat.narrator).length;
        const pace = sceneNarrator(group) ? narratorPace(group[NARRATOR_PACE_KEY]) : -1;
        const paceLine = pace > 0 ? ` · the narrator every ${pace} replies` : pace === 0 ? ' · the narrator when called' : '';
        return html`
            <div class="k-cast">
                <header class="k-cast-head">
                    ${this.#renderCover(group, list)}
                    <div class="k-cast-head-copy">
                        <span class="k-cast-name">${group.name}</span>
                        <span class="k-cast-sub">${castCount} in the cast${castCount === list.length ? '' : ' and a narrator'} · ${chats} ${chats === 1 ? 'chat' : 'chats'}</span>
                    </div>
                    <button type="button" class="k-cast-icon" title="Edit scene" aria-label="Edit scene"
                        @click=${() => this.#openStudio()}>${icons.edit}</button>
                </header>

                <section class="k-cast-card" aria-labelledby="k-cast-speaks">
                    <span class="k-cast-label" id="k-cast-speaks">Who speaks after you</span>
                    <div class="k-cast-seg" role="radiogroup" aria-labelledby="k-cast-speaks">
                        ${TURN_STYLES.map(option => html`
                            <button type="button" role="radio" aria-checked=${String(option.value === style.value)}
                                class=${option.value === style.value ? 'is-on' : ''} title=${option.label}
                                @click=${() => this.#act(() => setTurnStyle(option.value))}>${option.short}</button>`)}
                    </div>
                    <p class="k-cast-hint">${style.hint}</p>
                </section>

                ${this.#renderUpNext(list, round)}

                <section class="k-cast-list" aria-label="Cast">
                    <span class="k-cast-label">Cast</span>
                    ${list.map(seat => this.#renderRow(seat, total))}
                    <button type="button" class="k-cast-invite" @click=${() => this.#openStudio()}>${icons.plus}<span>Change the cast</span></button>
                </section>

                <section class="k-cast-card k-cast-talk">
                    <div class="k-cast-talk-copy">
                        <span class="k-cast-talk-title">Let them talk</span>
                        <span class="k-cast-hint">A reply every ${clampDelay(group.auto_mode_delay)} s${paceLine} · stops when you type</span>
                    </div>
                    <button type="button" role="switch" aria-checked=${String(on)} aria-label="Let them talk"
                        class="k-cast-switch${on ? ' is-on' : ''}" @click=${() => this.#act(() => setTalking(!on))}>
                        <span></span>
                    </button>
                </section>
            </div>`;
    }

    /**
     * @param {any} group
     * @param {import('./cast-state.js').Seat[]} list
     * @returns {unknown}
     */
    #renderCover(group, list) {
        if (isCustomCover(group.avatar_url)) {
            return html`<img class="k-cast-cover" src=${group.avatar_url} alt="">`;
        }
        const faces = list.filter(seat => seat.present && !seat.narrator).slice(0, 4);
        return html`
            <span class="k-cast-cover k-scene-cover--collage" data-count=${faces.length || 1} aria-hidden="true">
                ${faces.map(seat => html`<img src=${getThumbnailUrl('avatar', seat.avatar)} alt="">`)}
            </span>`;
    }

    /**
     * The round in flight (fixed order — core already decided it) followed by the user's cues
     * (theirs to drop or reorder).
     * @param {import('./cast-state.js').Seat[]} list
     * @param {import('./cast-state.js').LiveRound} round
     * @returns {unknown}
     */
    #renderUpNext(list, round) {
        const byAvatar = new Map(list.map(seat => [seat.avatar, seat]));
        const writingAt = round.writing ? round.queue.indexOf(round.writing) : -1;
        const live = round.queue.slice(Math.max(0, writingAt));
        const cued = round.cued;
        const chip = (/** @type {string} */ avatar, /** @type {'live'|'cue'} */ kind, /** @type {number} */ index) => {
            const seat = byAvatar.get(avatar);
            if (!seat) return nothing;
            const writing = kind === 'live' && avatar === round.writing;
            return html`
                <li class="k-cast-chip${writing ? ' is-writing' : ''}" style=${`--seat: ${seatColor(seat)};`}>
                    ${seat.narrator
        ? html`<span class="k-cast-chip-face k-cast-face--narrator">${icons.lantern}</span>`
        : html`<img class="k-cast-chip-face" src=${getThumbnailUrl('avatar', avatar)} alt="">`}
                    <span>${seat.name}</span>
                    ${kind === 'cue' ? html`
                        ${index > 0 ? html`<button type="button" class="k-cast-chip-act" title="Earlier" aria-label=${`Move ${seat.name} earlier`}
                            @click=${() => cueQueue.move(index, index - 1)}>‹</button>` : nothing}
                        <button type="button" class="k-cast-chip-act" title="Drop" aria-label=${`Drop ${seat.name} from the queue`}
                            @click=${() => cueQueue.drop(avatar)}>${icons.x}</button>` : nothing}
                </li>`;
        };
        return html`
            <section class="k-cast-card" aria-labelledby="k-cast-next">
                <span class="k-cast-label" id="k-cast-next">Up next</span>
                ${live.length === 0 && cued.length === 0 ? html`
                    <p class="k-cast-hint">Nobody queued. ${icons.speak} on a member cues them.</p>
                ` : html`
                    <ol class="k-cast-chips">
                        ${live.map((avatar, i) => chip(avatar, 'live', i))}
                        ${cued.map((avatar, i) => chip(avatar, 'cue', i))}
                    </ol>`}
            </section>`;
    }

    /**
     * @param {import('./cast-state.js').Seat} seat
     * @param {number} total
     * @returns {unknown}
     */
    #renderRow(seat, total) {
        const replies = total ? `${seat.turns} of ${total} replies` : 'hasn’t spoken yet';
        const line = STATE_LINE[seat.state] || (seat.narrator ? `the world and the extras · ${replies}` : replies);
        const percent = Math.round(seat.share * 100);
        let face = html`<span class="k-cast-face k-cast-face--gone" aria-hidden="true">?</span>`;
        if (seat.present) {
            face = seat.narrator
                ? html`<span class="k-cast-face k-cast-face--narrator">${icons.lantern}</span>`
                : html`<img class="k-cast-face" src=${getThumbnailUrl('avatar', seat.avatar)} alt="">`;
        }
        return html`
            <div class="k-cast-row${seat.narrator ? ' k-cast-row--narrator' : ''}" data-state=${seat.state} style=${`--seat: ${seatColor(seat)};`}>
                ${face}
                <div class="k-cast-row-copy">
                    <span class="k-cast-row-name">${seat.name}<small>${line}</small></span>
                    <span class="k-cast-share" role="img" aria-label=${`${percent}% of the replies`}><i style=${`width: ${percent}%;`}></i></span>
                </div>
                <button type="button" class="k-cast-icon" ?disabled=${!seat.present} title=${`${seat.name} speaks now`}
                    aria-label=${`Make ${seat.name} speak`} @click=${() => this.#act(() => speakNow(seat.avatar))}>${icons.speak}</button>
                ${seat.narrator ? html`<span class="k-cast-icon-spacer" aria-hidden="true"></span>` : html`
                <button type="button" class="k-cast-icon${seat.muted ? ' is-muted' : ''}" aria-pressed=${String(seat.muted)}
                    title=${seat.muted ? `Unmute ${seat.name}` : `Mute ${seat.name}`} aria-label=${seat.muted ? `Unmute ${seat.name}` : `Mute ${seat.name}`}
                    @click=${() => this.#act(() => setMuted(seat.avatar, !seat.muted))}>${seat.muted ? icons.mute : icons.sound}</button>`}
            </div>`;
    }
}

if (typeof customElements !== 'undefined' && !customElements.get('k-cast-panel')) {
    customElements.define('k-cast-panel', KCastPanel);
}
