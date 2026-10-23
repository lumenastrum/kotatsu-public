/**
 * `<k-sprite-stage variant="stage">` — the Sprite look's stage (Pictures slice F, step 2).
 *
 * Mounted once by the rails layout as the first child of `#k-center`, absolutely positioned
 * behind `#sheld`, so the reading column floats over it and the chat background stays under it.
 * Draws only while `#chat` wears the `sprite` look. Light DOM; every rule is in css/sprites.css.
 *
 * What it paints comes from `stage-model.js`: this file only gathers the inputs (the cast, each
 * member's latest labelled face, who is speaking, who finished a reply when, the stage and column
 * boxes) and writes the result as custom properties. A face is loaded before it is swapped in, so
 * an expression change never flashes an empty box.
 */

import { LitElement, html, nothing } from '../shell/lit.js';
import { characters, chat, isGenerating, saveSettingsDebounced, this_chid } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { groups, selected_group } from '../../scripts/group-chats.js';
import { VARIANT_AXIS_EVENT } from '../../scripts/message-rows.js';
import { power_user } from '../../scripts/power-user.js';
import { idleRound, seats } from '../groups/cast-state.js';
import { hueColor } from '../groups/scene-model.js';
import { readStoredExpression, resolveExpression } from './expression-model.js';
import { EXPRESSION_EVENT, stageCharacterFor } from './expressions.js';
import { FRAMING_EVENT, faceStyle, readFraming } from './framing.js';
import { SPRITES_EVENT, forgetSpriteSet, spriteSetsFor } from './sprite-sets.js';
import { cropFor, cutSides, layoutStage, layoutTheatre, pickFraming, stageMode } from './stage-model.js';
import { loadFrame } from './frame-measure.js';
import { installTheatre } from './theatre.js';

export const SPRITE_STAGE_TAG = 'k-sprite-stage';

/**
 * Where the Sprite look becomes the phone's theatre (stage-model.js `layoutTheatre`, css/sprites.css §9): the
 * width at which the shell is a phone (kotatsu-phone.css), so the textbox and the stage switch together.
 */
export const THEATRE_QUERY = '(max-width: 600px)';

/** @returns {boolean} whether the Sprite look is a theatre here (a phone-width screen) */
export function theatreActive() {
    return spriteLookActive() && window.matchMedia(THEATRE_QUERY).matches;
}

/** @returns {boolean} whether the reading column wears the sprite look */
export function spriteLookActive() {
    return document.body?.dataset.kLayout === 'rails'
        && document.getElementById('chat')?.dataset.kMesVariant === 'sprite';
}

/** Core events after which the stage re-reads the scene (coalesced to one frame). */
const REFRESH_EVENTS = Object.freeze([
    event_types.MESSAGE_SENT, event_types.MESSAGE_SWIPED, event_types.MESSAGE_DELETED,
    event_types.CHARACTER_MESSAGE_RENDERED, event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED,
    event_types.GROUP_UPDATED, event_types.GROUP_MEMBER_DRAFTED,
    // A scene's reply renders while `is_group_generating` is still up (the round has not ended), so the stage still
    // reads it as being written; the round's end is when it counts toward seating (measured: a benched speaker never
    // took her seat without this).
    event_types.GROUP_WRAPPER_FINISHED,
]);

/** `power_user` key: light only, seats never swap (the staging spec's "Calm"). */
export const SPRITE_CALM_KEY = 'kotatsu_sprite_calm';

/** @returns {boolean} */
export function spriteCalm() {
    return power_user?.[SPRITE_CALM_KEY] === true;
}

/**
 * The card's stage knobs (`framing.js`): height and vertical offset.
 * @param {any} character
 * @returns {{scale: number, offset: number}}
 */
function framingOf(character) {
    const { scale, offset } = readFraming(character);
    return { scale, offset };
}

/**
 * @typedef {object} CastMember
 * @property {any} character a `characters[]` entry
 * @property {string} id its avatar file
 * @property {string} name
 * @property {string} color identity colour ('' outside a scene)
 */

/** @returns {{members: CastMember[], solo: boolean}} the cast in home order */
function currentCast() {
    const list = Array.isArray(characters) ? characters : [];
    if (selected_group) {
        const group = (Array.isArray(groups) ? groups : []).find(g => g?.id === selected_group);
        if (!group) return { members: [], solo: false };
        const byAvatar = new Map(list.map(c => [c?.avatar, c]));
        const members = seats(group, list, chat, idleRound())
            .filter(seat => seat.present && !seat.narrator && !(group.hideMutedSprites && seat.muted))
            .map(seat => ({ character: byAvatar.get(seat.avatar), id: seat.avatar, name: seat.name, color: hueColor(seat.hue) }))
            .filter(member => member.character);
        return { members, solo: false };
    }
    const character = this_chid !== undefined ? list[Number(this_chid)] : null;
    return character ? { members: [{ character, id: character.avatar, name: character.name, color: '' }], solo: true } : { members: [], solo: true };
}

/**
 * Speaker, recency and each member's latest labelled message, in one walk from the end.
 * @returns {{speaker: string|null, recency: Record<string, number>, latest: Map<string, any>}}
 */
function readScene() {
    /** @type {Record<string, number>} */
    const recency = {};
    /** @type {Map<string, any>} */
    const latest = new Map();
    let speaker = /** @type {string|null|undefined} */ (undefined);
    const writing = isGenerating() ? chat.length - 1 : -1;
    for (let index = chat.length - 1; index >= 0; index -= 1) {
        const message = chat[index];
        if (!message || message.is_system) continue;
        const character = stageCharacterFor(message);
        // The newest line decides who is lit: a stage character, or no one (the user, narration).
        if (speaker === undefined) speaker = character ? character.avatar : null;
        if (!character) continue;
        const id = character.avatar;
        if (index !== writing && !(id in recency)) recency[id] = index;
        if (!latest.has(id) && readStoredExpression(message)) latest.set(id, message);
    }
    return { speaker: speaker ?? null, recency, latest };
}

export class KSpriteStage extends LitElement {
    static properties = {
        /** SPEC §13 — `stage` is the only v0 variant. */
        variant: { type: String, reflect: true },
        _layout: { state: true },
    };

    constructor() {
        super();
        this.variant = 'stage';
        /** @type {(import('./stage-model.js').StageLayout & {members: Array<CastMember & {url: string, faceUrl: string, label: string, framing: string, cut?: {left: boolean, right: boolean}}>, speaker?: string|null}) | null} */
        this._layout = null;
        this._token = 0;
        this._frame = 0;
        this._refresh = () => this.schedule();
        this._onChatChanged = () => { forgetSpriteSet(); this.schedule(); };
        // A streamed reply joins the chat with its first token, after GENERATION_STARTED: that is
        // when the writer is lit. Once per generation, not per token.
        this._streamLit = false;
        this._onGenerationStarted = () => { this._streamLit = false; this.schedule(); };
        this._onToken = () => {
            if (this._streamLit) return;
            this._streamLit = true;
            this.schedule();
        };
        this._resize = new ResizeObserver(this._refresh);
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        document.addEventListener(EXPRESSION_EVENT, this._refresh);
        document.addEventListener(VARIANT_AXIS_EVENT, this._refresh);
        document.addEventListener(FRAMING_EVENT, this._refresh);
        document.addEventListener(SPRITES_EVENT, this._refresh);
        for (const type of REFRESH_EVENTS) eventSource.on(type, this._refresh);
        eventSource.on(event_types.CHAT_CHANGED, this._onChatChanged);
        eventSource.on(event_types.GENERATION_STARTED, this._onGenerationStarted);
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, this._onToken);
        for (const id of ['k-center', 'form_sheld']) {
            const target = document.getElementById(id);
            if (target) this._resize.observe(target);
        }
        this.schedule();
    }

    disconnectedCallback() {
        super.disconnectedCallback();
        document.removeEventListener(EXPRESSION_EVENT, this._refresh);
        document.removeEventListener(VARIANT_AXIS_EVENT, this._refresh);
        document.removeEventListener(FRAMING_EVENT, this._refresh);
        document.removeEventListener(SPRITES_EVENT, this._refresh);
        for (const type of REFRESH_EVENTS) eventSource.removeListener(type, this._refresh);
        eventSource.removeListener(event_types.CHAT_CHANGED, this._onChatChanged);
        eventSource.removeListener(event_types.GENERATION_STARTED, this._onGenerationStarted);
        eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, this._onToken);
        this._resize.disconnect();
        cancelAnimationFrame(this._frame);
    }

    /** Coalesces a burst of triggers into one update per frame. */
    schedule() {
        cancelAnimationFrame(this._frame);
        this._frame = requestAnimationFrame(() => void this.refreshStage());
    }

    /**
     * Gathers the inputs and lays out. A newer call wins (`_token`); faces are loaded before the
     * layout that shows them is published, so a swap never shows an empty box.
     * @returns {Promise<void>}
     */
    async refreshStage() {
        const token = ++this._token;
        if (!spriteLookActive() || document.body.dataset.kView === 'home') {
            this._layout = null;
            return;
        }
        const theatre = theatreActive();
        const { members, solo } = currentCast();
        const { speaker, recency, latest } = readScene();
        // A card may carry two framings (the full body in its folder, the bust in `bust/`); the layout's mode picks
        // one per figure (stage-model `pickFraming`), so the mode is counted over everyone with either set first.
        const withSets = [];
        for (const member of members) {
            const sets = await spriteSetsFor(member.character);
            if (sets.full.labels.size || sets.bust.labels.size) withSets.push({ member, sets });
        }
        const mode = theatre ? 'theatre' : stageMode(withSets.length, solo);
        /** @type {Array<CastMember & {url: string, faceUrl: string, label: string, framing: string, aspect: number, crop: number, cut: {left: boolean, right: boolean}}>} */
        const placed = [];
        for (const { member, sets } of withSets) {
            const framing = pickFraming(mode, readFraming(member.character).pin, { bust: sets.bust.labels.size > 0, full: sets.full.labels.size > 0 });
            const set = framing === 'bust' ? sets.bust : sets.full;
            const label = resolveExpression(readStoredExpression(latest.get(member.id)), set.labels.keys())
                ?? (set.labels.has('neutral') ? 'neutral' : [...set.labels.keys()][0]);
            const wanted = set.labels.get(label) ?? '';
            const { aspect } = await loadFrame(wanted);
            // Bust or full body is the CHARACTER's framing, read from one sprite (neutral) so a face change never
            // resizes the figure.
            const base = await loadFrame(set.labels.get('neutral') ?? [...set.labels.values()][0] ?? wanted);
            // Face chips crop with the card's knobs, which are set on the main (full-body) set: they keep reading it.
            const faceUrl = sets.full.labels.get(label) ?? sets.full.labels.get('neutral') ?? wanted;
            placed.push({ ...member, url: wanted, faceUrl, label, framing: framing ?? 'full', aspect, crop: cropFor(base.bottomCoverage), cut: cutSides(base) });
        }
        if (token !== this._token) return;
        const box = this.getBoundingClientRect();
        if (theatre) {
            const layout = box.width ? layoutTheatre({
                width: box.width,
                height: box.height,
                members: placed.map(m => ({ id: m.id, aspect: m.aspect, crop: m.crop, ...framingOf(m.character) })),
                speaker,
                recency,
            }) : null;
            this._layout = layout ? { ...layout, members: placed, speaker } : null;
            this.dataset.mode = layout?.mode ?? 'none';
            return;
        }
        const column = document.getElementById('form_sheld')?.getBoundingClientRect();
        if (!column || !box.width) {
            this._layout = null;
            return;
        }
        const layout = layoutStage({
            width: box.width,
            height: box.height,
            columnLeft: column.left - box.left,
            columnRight: column.right - box.left,
            members: placed.map(m => ({ id: m.id, aspect: m.aspect, crop: m.crop, ...framingOf(m.character) })),
            solo,
            speaker,
            recency,
            calm: spriteCalm(),
        });
        this._layout = { ...layout, members: placed, speaker };
        this.dataset.mode = layout.mode;
    }

    /** Diagnostics for the door and the probe. */
    get state() {
        const layout = this._layout;
        return layout ? {
            mode: layout.mode,
            pitch: layout.pitch,
            bench: layout.bench,
            figures: layout.figures.map(f => {
                const member = layout.members.find(m => m.id === f.id);
                return { ...f, label: member?.label ?? '', framing: member?.framing ?? '' };
            }),
        } : { mode: 'off', pitch: 0, bench: { left: [], right: [] }, figures: [] };
    }

    render() {
        const layout = this._layout;
        if (!layout || layout.mode === 'none') return nothing;
        const byId = new Map(layout.figures.map(f => [f.id, f]));
        // Every member, always in home order, so each keeps ONE element and moves rather than
        // being re-created; a benched member's figure fades out in place.
        return html`${layout.members.map(member => {
            const figure = byId.get(member.id);
            const style = figure
                ? `--x:${figure.x}px;--w:${figure.width}px;--h:${figure.height}px;--crop:${(figure.crop * 100).toFixed(1)}%;--s:${figure.scale};--dy:${figure.dy}px;`
                    + `--b:${figure.brightness};--sat:${figure.saturate};--z:${figure.z};--o:1;background-image:url("${member.url}");`
                    + (member.color ? `--k-speaker:${member.color};` : '')
                : '--o:0;';
            return html`<div class="k-sprite-figure" data-id=${member.id} data-side=${figure?.side ?? 'none'} data-framing=${member.framing}
                ?data-speaking=${figure?.speaking} ?data-cut-left=${member.cut?.left} ?data-cut-right=${member.cut?.right}
                role="img" aria-label=${`${member.name}, ${member.label}`} style=${style}></div>`;
        })}${this.renderBench(layout)}`;
    }

    /**
     * The bench: a face chip per character waiting in a wing, in that wing's top outer corner, dashed and dimmed;
     * lit while the benched character is the one speaking (they take a seat once their reply has finished).
     * @param {NonNullable<KSpriteStage['_layout']>} layout
     */
    renderBench(layout) {
        const sides = /** @type {const} */ (['left', 'right']);
        return sides.map(side => {
            const ids = layout.bench[side];
            if (!ids.length) return nothing;
            return html`<div class="k-sprite-bench" data-side=${side} role="group" aria-label=${`Waiting on the ${side}`}>
                ${ids.map(id => this.renderBenchChip(layout, id))}
                <span class="k-sprite-bench__label">Bench</span>
            </div>`;
        });
    }

    /**
     * @param {NonNullable<KSpriteStage['_layout']>} layout
     * @param {string} id
     */
    renderBenchChip(layout, id) {
        const member = layout.members.find(m => m.id === id);
        if (!member) return nothing;
        const style = `background-image:url("${member.faceUrl}");${faceStyle(readFraming(member.character))}${member.color ? `--k-speaker:${member.color};` : ''}`;
        return html`<span class="k-sprite-bench__chip" ?data-speaking=${layout.speaker === id}
            title=${`${member.name} (on the bench)`} style=${style}></span>`;
    }
}

if (!customElements.get(SPRITE_STAGE_TAG)) customElements.define(SPRITE_STAGE_TAG, KSpriteStage);

/**
 * Mounts the stage behind `#sheld` (rails only). Idempotent.
 * @returns {void}
 */
export function installSpriteStage() {
    const center = document.getElementById('k-center');
    if (!center || center.querySelector(`:scope > ${SPRITE_STAGE_TAG}`)) return;
    center.prepend(document.createElement(SPRITE_STAGE_TAG));
    // The phone theatre's reading behaviour (start of a line, the box's edge fades).
    installTheatre();

    // The console door joins the one expressions.js made (properties added, so its live getters survive).
    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, any>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') targetWindow.kotatsu = {};
    if (!targetWindow.kotatsu.sprites) targetWindow.kotatsu.sprites = {};
    const door = targetWindow.kotatsu.sprites;
    door.stage = () => /** @type {KSpriteStage|null} */ (document.querySelector(SPRITE_STAGE_TAG))?.state ?? null;
    /** @param {boolean} [on] omitted → report */
    door.calm = (on) => {
        if (typeof on === 'boolean') {
            power_user[SPRITE_CALM_KEY] = on;
            saveSettingsDebounced();
            /** @type {KSpriteStage|null} */ (document.querySelector(SPRITE_STAGE_TAG))?.schedule();
        }
        return spriteCalm();
    };
}

/** @returns {void} */
export function uninstallSpriteStage() {
    document.querySelector(SPRITE_STAGE_TAG)?.remove();
}
