/**
 * Kotatsu shell — the `rails` layout (shell v0 slice A).
 *
 * The simplified redesign: one desktop grid, zero drawers on the critical path.
 * Strangler stance — nothing is rebuilt here. `#sheld` is RELOCATED into the
 * centre track with its id, its children and every handler bound to them intact;
 * the drawer rack is parked offstage and its controls are BORROWED, a tab at a
 * time, by `<k-settings-modal>`; the rails host new components that read core
 * state through core's own exports.
 *
 * Component loading is deliberately defensive. `<k-topbar>` and `<k-rail-left>`
 * arrive from other slices on their own schedule, so each is imported inside its
 * own try/catch and each slot falls back to a quiet placeholder. A rail that has
 * not shipped yet must degrade to an empty column, never to a broken frame or a
 * boot-time exception — and integration has to become automatic the moment the
 * file appears, with no edit here.
 */

import { installAnSheet, uninstallAnSheet } from '../an-sheet.js';
import { installRailCollapse, uninstallRailCollapse } from '../rail-collapse.js';
import { installViewState, uninstallViewState } from '../view-state.js';
// Settings v0 slice B. A STATIC import, like the card studio's below and for the same two
// reasons: the unmount path has to call `uninstallSettingsModal()` SYNCHRONOUSLY before
// `ctx.restoreAll()`, and a module handle captured from a dynamic import would not be
// guaranteed to exist by then.
import {
    OPEN_SETTINGS_EVENT,
    installSettingsModal,
    uninstallSettingsModal,
} from '../../settings/k-settings-modal.js';
// Library v0 slice D. A STATIC import, unlike the gallery's defensive dynamic one below,
// for two reasons: `k-library.js` is already a static dependency of the shell entry point
// (shell/index.js imports its doors), so nothing is being pulled in early; and the unmount
// path has to call `uninstallStudio()` SYNCHRONOUSLY, before `ctx.restoreAll()` — a module
// handle captured from a dynamic import would not be guaranteed to exist by then.
import { installStudio, uninstallStudio } from '../../studio/k-card-studio.js';

/** Slots the layout clears on unmount. `#k-center` is not one: restoreAll() owns `#sheld`. */
const COMPONENT_SLOT_IDS = ['k-topbar', 'k-rail-left', 'k-rail-right'];

/**
 * A component slot: which module defines it, which tag it registers, where it goes.
 * @typedef {object} SlotSpec
 * @property {string} module Specifier resolved against THIS module's URL.
 * @property {string} tag
 * @property {string} slot
 * @property {string} label Human-readable, for the warning and the placeholder.
 * @property {string} [note] Placeholder note when the component is unavailable.
 */

/** @type {SlotSpec[]} */
const COMPONENT_SLOTS = [
    { module: '../components/k-topbar.js', tag: 'k-topbar', slot: 'k-topbar', label: 'Top bar' },
    { module: '../components/k-rail-left.js', tag: 'k-rail-left', slot: 'k-rail-left', label: 'Left rail' },
    { module: '../components/k-tab-rail.js', tag: 'k-tab-rail', slot: 'k-rail-right', label: 'Docks', note: 'panels dock here' },
];

/**
 * Builds the quiet stand-in for a slot whose component is not available.
 * @param {string} label
 * @param {string} note
 * @returns {HTMLElement}
 */
function buildPlaceholder(label, note) {
    const box = document.createElement('div');
    box.className = 'k-slot-placeholder';
    const title = document.createElement('span');
    title.className = 'k-slot-placeholder-title';
    title.textContent = label;
    const detail = document.createElement('span');
    detail.className = 'k-slot-placeholder-note';
    detail.textContent = note;
    box.append(title, detail);
    return box;
}

/**
 * The top bar's placeholder carries a real settings button.
 *
 * Without `<k-topbar>` there is no gear, and without a gear there is no way into
 * the settings modal — which under rails is the only way to reach the layout
 * switch, i.e. the control that switches back to classic. A plain `<button>` is
 * also the keyboard path: it takes focus in tab order and activates on Enter or
 * Space with no key handling of our own.
 * @returns {HTMLElement}
 */
function buildTopbarPlaceholder() {
    const box = buildPlaceholder('kotatsu', 'top bar unavailable');
    box.classList.add('k-topbar-placeholder');

    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'k-placeholder-settings';
    gear.textContent = 'Settings';
    gear.title = 'Open settings';
    gear.addEventListener('click', () => {
        gear.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { bubbles: true, composed: true }));
    });

    box.appendChild(gear);
    return box;
}

/**
 * Imports a component module and mounts its element, or reports why it could not.
 * @param {SlotSpec} spec
 * @returns {Promise<boolean>} Whether the real component is mounted.
 */
async function mountComponent(spec) {
    const slot = document.getElementById(spec.slot);
    if (!slot) {
        console.warn(`[Kotatsu shell] Slot #${spec.slot} is missing from index.html.`);
        return false;
    }

    try {
        await import(spec.module);
    } catch (error) {
        console.warn(`[Kotatsu shell] ${spec.label}: ${spec.module} did not load. Rendering a placeholder.`, error);
        return false;
    }

    // Loading is not defining. A module that imports cleanly but never reaches its
    // customElements.define() would otherwise leave an inert unknown element here.
    if (!customElements.get(spec.tag)) {
        console.warn(`[Kotatsu shell] ${spec.label}: ${spec.module} loaded but did not define <${spec.tag}>. Rendering a placeholder.`);
        return false;
    }

    slot.replaceChildren(document.createElement(spec.tag));
    return true;
}

/**
 * Hands `#send_textarea`'s height across a layout switch.
 *
 * Under rails the core input listener stops writing inline height altogether
 * (RossAscends-mods.js, docs/composer-performance-v0.md §6 A1) — the stylesheet says
 * `height: auto` and `field-sizing: content` grows the field. Inline style outranks a
 * stylesheet, so a height left behind by a manual resize in classic would fight native
 * sizing for the rest of the session with nothing left to erase it: mount clears it once.
 * Unmount writes back the inline `auto` that classic's own listener would have written on
 * its next input, so a long draft does not sit collapsed until the next keystroke.
 *
 * Only for browsers that have `field-sizing` at all. Without it the manual auto-fit
 * fallback owns this property in both layouts and must keep the height it measured.
 * @param {string} value Inline height to write; `''` removes the declaration.
 * @returns {void}
 */
function setComposerInlineHeight(value) {
    if (!CSS.supports('field-sizing', 'content')) return;
    const composer = document.getElementById('send_textarea');
    if (composer instanceof HTMLTextAreaElement) {
        composer.style.height = value;
    }
}

/** @type {import('../registry.js').LayoutDefinition} */
export const railsLayout = {
    async mount(ctx) {
        document.body.dataset.kLayout = ctx.id;
        setComposerInlineHeight('');

        // The relocation that makes it a layout. Everything else is decoration.
        const relocated = ctx.relocate(document.getElementById('sheld'), document.getElementById('k-center'));
        if (!relocated) {
            console.warn('[Kotatsu shell] #sheld could not be relocated into #k-center; the centre track will be empty.');
        }

        for (const spec of COMPONENT_SLOTS) {
            const mounted = await mountComponent(spec);
            if (mounted) continue;
            const slot = document.getElementById(spec.slot);
            if (!slot) continue;
            slot.replaceChildren(spec.tag === 'k-topbar'
                ? buildTopbarPlaceholder()
                : buildPlaceholder(spec.label, spec.note ?? 'component not available'));
        }

        // Slice D's chat header sits ABOVE the relocated #sheld, so it prepends into
        // #k-center rather than replacing — that slot is never cleared (restoreAll
        // owns #sheld) and must not be.
        try {
            // Specifier kept in a const so the import stays dynamic for the type
            // checker, matching how SlotSpec modules resolve (the file may not
            // exist until slice D lands).
            const chatHeaderModule = '../components/k-chat-header.js';
            await import(chatHeaderModule);
            if (customElements.get('k-chat-header')) {
                document.getElementById('k-center')?.prepend(document.createElement('k-chat-header'));
            }
        } catch {
            // Slice D not landed — the centre column simply has no header yet.
        }

        // Reader-polish v0 finding 4: the "back to latest" pill. Appended AFTER the relocated
        // #sheld so it paints over the bottom of #chat (absolute inside the positioned
        // #k-center; shell-center.css §6). Same defensive dynamic import as the header: a
        // missing module leaves the column exactly as it was.
        try {
            const jumpModule = '../components/k-jump-latest.js';
            await import(jumpModule);
            if (customElements.get('k-jump-latest')) {
                document.getElementById('k-center')?.append(document.createElement('k-jump-latest'));
            }
        } catch {
            // No pill; the reader scrolls by hand, as before.
        }

        // Library v0 slice C. Appended (not prepended, not replaceChildren) into the same
        // never-cleared slot: the gallery is an absolute overlay inside #k-center, so it must
        // come after the relocated #sheld in DOM order and must not disturb it. Same
        // defensive dynamic import as the chat header — a missing module leaves the centre
        // column exactly as it was, with no gallery and no exception.
        try {
            const libraryModule = '../../library/k-library.js';
            const library = await import(libraryModule);
            library.mountLibrary?.(document.getElementById('k-center'));
        } catch (error) {
            console.warn('[Kotatsu shell] Library: k-library.js did not load; the centre column has no gallery.', error);
        }

        // Library v0 slice D: the card studio's document door. Listeners only — the element is
        // created on the first open request and removed on close, so nothing is mounted and no
        // core control is borrowed until someone asks for the studio.
        installStudio();

        // Settings v0 slice B: the settings modal's document door — the gear's
        // `k-open-settings` listener. Listeners only, same as the studio: the
        // element is created on the first open request and removed on close, so
        // no stock control is borrowed out of the parked rack until someone asks
        // for settings.
        installSettingsModal();

        // Shell QoL v0 Tier 1: the Author's Note gets a scrim and an Escape door
        // under rails (docs/shell-qol-v0.md §3). Layout-scoped like the settings
        // overlay and for the same reason — the sheet dressing only makes sense
        // against css/shell-panels.css, which is gated on this layout. The panel
        // itself is not touched; the installer only observes it.
        installAnSheet();

        // Rail collapse (variant wardrobe v0 slice C). Last, so the first apply()
        // describes rails whose components have already mounted — and so a
        // stored `collapsed` hides a real rail rather than an empty slot that is
        // about to be filled. The handles go on #k-shell, not into a slot, so
        // the replaceChildren() calls above cannot sweep them away.
        installRailCollapse();

        // View state (home vs chat) drives whether the rails are on screen at
        // all. After installRailCollapse() so the collapse handles exist before
        // the first sync can hide them: a boot landing on home should never
        // flash a handle it is about to take away.
        installViewState();
    },

    unmount(ctx) {
        // FIRST, and before every other teardown: an open studio is HOLDING three dozen core
        // controls out of `#rm_ch_create_block` and `#character_popup`, and `uninstallStudio()`
        // closes it, which is what puts them back. Restoring the layout with the studio still
        // up would hand classic two frozen blocks with holes in them. Same ordering lesson as
        // the tab rail's dock (`k-tab-rail.js:241-248`), one layer further out.
        uninstallStudio();
        // SECOND, and for exactly the same reason: an open settings modal is
        // HOLDING that tab's controls out of the drawer rack, and
        // `uninstallSettingsModal()` closes it, which is what puts them back.
        // Restoring the layout with the modal still up would hand classic a rack
        // with holes in it.
        uninstallSettingsModal();
        uninstallViewState();
        uninstallRailCollapse();
        uninstallAnSheet();
        // Before restoreAll(), like every other centre-column guest: the element's
        // disconnectedCallback is what unbinds its document listeners, so it has to run while
        // #sheld is still where the gallery expects it (the tab-rail ordering lesson).
        document.querySelector('#k-center > k-library')?.remove();
        document.querySelector('#k-center > k-jump-latest')?.remove();
        document.querySelector('#k-center > k-chat-header')?.remove();
        for (const id of COMPONENT_SLOT_IDS) {
            document.getElementById(id)?.replaceChildren();
        }
        ctx.restoreAll();
        setComposerInlineHeight('auto');
        delete document.body.dataset.kLayout;
    },
};
