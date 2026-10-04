/**
 * Kotatsu shell — the `classic` layout (shell v0 slice A).
 *
 * Today's SillyTavern UI, untouched, and the permanent fallback: switching back
 * to it must always work, which is easiest to guarantee when it does almost
 * nothing. It moves no nodes and sets no attributes — core's own boot already
 * produces exactly this. `#k-shell` stays `display: none` because the frame
 * sheet only lifts that under `body[data-k-layout="rails"]`, and no shell sheet
 * has a rule that matches without that attribute.
 *
 * The ONE thing it adds is a way back. The Classic/Rails switch lives in the
 * settings modal, and the modal is a rails surface, so once rails became the
 * default (2026-08-26) a reader who tried Classic had no door home short of
 * editing settings.json (a Reddit report, 2026-10-04). The door is a single
 * icon in core's own top bar, dressed as one of its drawers so it reads as part
 * of the furniture:
 *
 * - `.drawer` wrapper + `.drawer-icon`, deliberately WITHOUT `.drawer-toggle`.
 *   Core delegates drawer clicks on `.drawer-toggle` (script.js:12608), so the
 *   door never asks it to open a `.drawer-content` it doesn't have, while
 *   a11y.js and keyboard.js already make every `.drawer-icon` a focusable,
 *   Enter-able button.
 * - It sits just before `#rightNavHolder`, so the character drawer keeps its
 *   far-right spot.
 *
 * The definition exists so the registry has something to unmount TO. Without a
 * registered `classic`, `applyLayout('classic')` from rails would refuse.
 *
 * @type {import('../registry.js').LayoutDefinition}
 */
import { setLayout } from '../persistence.js';

const DOOR_ID = 'k-classic-rails-door';

export const classicLayout = {
    mount() {
        const holder = document.getElementById('top-settings-holder');
        if (!holder || document.getElementById(DOOR_ID)) return;
        const door = document.createElement('div');
        door.id = DOOR_ID;
        door.className = 'drawer';
        const icon = document.createElement('div');
        icon.className = 'drawer-icon fa-solid fa-table-columns fa-fw closedIcon';
        icon.title = 'Back to the Kotatsu layout (Rails). Reloads the page.';
        icon.setAttribute('aria-label', 'Back to the Kotatsu layout');
        icon.addEventListener('click', () => {
            if (icon.classList.contains('disabled')) return;
            icon.classList.add('disabled');
            void setLayout('rails');
        });
        door.appendChild(icon);
        holder.insertBefore(door, document.getElementById('rightNavHolder'));
    },
    unmount() {
        document.getElementById(DOOR_ID)?.remove();
    },
};
