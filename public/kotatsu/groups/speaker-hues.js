/**
 * Speaker colour in the transcript (`docs/group-chat-v0.md` G5): in a scene, every cast
 * member's rows wear the identity hue the stage seat and the cast tab already show — nameplate,
 * stripe, and the broadcast look's rail — in every wardrobe variant.
 *
 * One `<style id="k-scene-speakers">` in `<head>`, rewritten from `speakerSheet()` whenever the
 * open scene or a member's name can have changed; empty outside a scene. The hues come from the
 * same `castHues()` over the same seating order as `<k-stage>`, so a seat and its rows always
 * match. Rails-only: installed by the rails layout, removed on unmount.
 */

import { characters } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { castHues, castOf, rosterByAvatar, speakerSheet } from './scene-model.js';
import { openScene } from './stage-actions.js';

const STYLE_ID = 'k-scene-speakers';
const EVENTS = ['APP_READY', 'CHAT_CHANGED', 'GROUP_UPDATED', 'CHARACTER_EDITED', 'CHARACTER_RENAMED'];

let installed = false;

/** @returns {HTMLStyleElement} */
function sheet() {
    let el = document.getElementById(STYLE_ID);
    if (!(el instanceof HTMLStyleElement)) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }
    return /** @type {HTMLStyleElement} */ (el);
}

/** Rewrites the sheet for the open scene. Never throws. */
export function refreshSpeakerHues() {
    try {
        const group = openScene();
        let text = '';
        if (group) {
            const cast = castOf(group, rosterByAvatar(characters)).filter(member => member.present);
            // The narrator takes no slot on the wheel (scene-model.js speakerSheet).
            const hues = castHues(cast.filter(member => member.role === 'cast').map(member => member.avatar));
            text = speakerSheet(cast.map(member => ({ name: member.name, hue: hues.get(member.avatar) ?? 0, narrator: member.role === 'narrator' })));
        }
        const el = sheet();
        if (el.textContent !== text) el.textContent = text;
    } catch (error) {
        console.error('[speaker-hues] refresh failed', error);
    }
}

/** @returns {void} Idempotent. */
export function installSpeakerHues() {
    if (installed) return;
    installed = true;
    for (const key of EVENTS) {
        const name = event_types[key];
        if (typeof name === 'string') eventSource.on(name, refreshSpeakerHues);
    }
    refreshSpeakerHues();
}

/** @returns {void} */
export function uninstallSpeakerHues() {
    if (!installed) return;
    installed = false;
    for (const key of EVENTS) {
        const name = event_types[key];
        if (typeof name === 'string') eventSource.removeListener(name, refreshSpeakerHues);
    }
    document.getElementById(STYLE_ID)?.remove();
}
