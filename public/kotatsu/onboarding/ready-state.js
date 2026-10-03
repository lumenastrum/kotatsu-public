/**
 * Mikan-chan's welcome tour — the Ready step's summary (docs/onboarding-v0.md §2.5, slice
 * O6). No DOM, no core imports: `<k-onboarding>` reads what is set, and this says how to tell
 * the person about it.
 *
 * The summary is the last thing the tour shows, and every step before it could be skipped. So
 * each row is honest about its own state: what is set, or plainly that it is not, with the step
 * that sets it one press away. Nothing here blocks: someone who skipped everything still leaves
 * through the same button, to the library instead of a chat.
 */

/**
 * @typedef {object} ReadyInput
 * @property {{connected: boolean, label: string, effort: string}} connection `label` is the live
 *   connection as a person says it; `effort` is the word that rides a Claude Code request, ''
 *   when the connection has none.
 * @property {{name: string, style: string, mature?: boolean|null}} sauce The preset's display
 *   name, its play style, and whether its mature-content switch is on (null or absent when the
 *   preset has no such switch: only Nabe does).
 * @property {{name: string, named: boolean}} persona `named` is false for core's placeholder.
 * @property {{name: string}} card '' when nobody is picked.
 */

/**
 * @typedef {object} ReadyRow
 * @property {'connect'|'sauce'|'persona'|'card'} step The step that sets it.
 * @property {string} label What the row is about.
 * @property {string} value What is set, or that nothing is.
 * @property {boolean} set Whether it is set.
 */

/**
 * @typedef {object} ReadySummary
 * @property {ReadyRow[]} rows
 * @property {boolean} canWrite Whether pressing the button lands in a chat that can be written in.
 * @property {string} primary The button's words.
 * @property {string} note One line under the rows, '' when there is nothing to add.
 */

/**
 * @param {ReadyInput} input What is set.
 * @returns {ReadySummary} How to say it.
 */
export function readySummary(input) {
    const connection = input?.connection ?? { connected: false, label: '', effort: '' };
    const sauce = input?.sauce ?? { name: '', style: '' };
    const persona = input?.persona ?? { name: '', named: false };
    const card = input?.card ?? { name: '' };

    const connected = Boolean(connection.connected);
    const picked = String(card.name ?? '').trim();
    const sauceName = String(sauce.name ?? '').trim();
    const style = String(sauce.style ?? '').trim();
    const personaName = String(persona.name ?? '').trim();
    const named = Boolean(persona.named) && personaName !== '';

    /** @type {ReadyRow[]} */
    const rows = [
        {
            step: 'connect',
            label: 'Writing with',
            value: connected
                ? `${String(connection.label ?? '').trim() || 'your connection'}${connection.effort ? `, ${String(connection.effort).toLowerCase()} effort` : ''}`
                : 'Nothing connected yet',
            set: connected,
        },
        {
            step: 'sauce',
            label: 'Sauce',
            // Mature content is the one sauce setting people care most about, so the summary says
            // where it landed (walkthrough F6).
            value: sauceName
                ? `${sauceName}${style ? `, as a ${style}` : ''}${typeof sauce.mature === 'boolean' ? ` · mature content ${sauce.mature ? 'on' : 'off'}` : ''}`
                : 'No preset picked',
            set: sauceName !== '',
        },
        {
            step: 'persona',
            label: 'You are',
            value: named ? personaName : '"User", until you pick a name',
            set: named,
        },
        {
            step: 'card',
            label: 'Talking to',
            value: picked || 'Nobody picked yet',
            set: picked !== '',
        },
    ];

    const canWrite = picked !== '';
    let note = '';
    if (canWrite && !connected) note = 'You can open the chat, but nobody will write back until something is connected.';
    else if (!canWrite) note = 'With nobody picked, this takes you to your library. Pick someone there to start a chat.';
    return {
        rows,
        canWrite,
        primary: canWrite ? 'Start writing' : 'Go to the library',
        note,
    };
}
