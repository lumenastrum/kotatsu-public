/**
 * Kotatsu metrics — the subsystem wiring (metrics native v0, `docs/metrics-native-v0.md` §4).
 *
 * What this module is NOT is the point of the slice. The retired message-metrics extension
 * needed a `window.fetch` wrapper, a two-slot generation reconciler, a 2500 ms flush timer and a
 * 700 ms re-assert, because it could only ever see usage AFTER the render and could only ever
 * hold a row by `mesid`. Native capture kills all four:
 *
 *  - usage is written into `chat[id].extra.mm_usage` by core BEFORE `CHARACTER_MESSAGE_RENDERED`
 *    emits (`script.js` streaming finalize and `saveReply()`), so by the time this module hears
 *    the event the data is already on the message;
 *  - rows are found through `rowFor(chat[id])` — a WeakMap on message-object identity — so a
 *    delete or a move cannot make the bar land on the wrong message the way a `mesid` query can;
 *  - therefore there are NO TIMERS anywhere in this subsystem. Every paint is driven by an event
 *    or by an explicit call. That is a gate the probe asserts, not a style preference.
 *
 * Row reuse is core's business: `resetRowConditionals()` drops any `<k-mes-metrics>` before a
 * refill, exactly as it drops the timestamp and thinking icons, so a reused row can never wear
 * a previous message's numbers. The paint drivers below put it back.
 */
import { chat, getMaxContextTokens, saveSettingsDebounced } from '../../script.js';
import { eventSource, event_types } from '../../scripts/events.js';
import { rowFor } from '../../scripts/message-rows.js';
import { power_user } from '../../scripts/power-user.js';
import { defineMetricsElement, METRICS_TAG, paintMetricsBar, removeMetricsBar } from './bar.js';
import { readStoredUsage } from './usage.js';

/** The `power_user` key. Native subsystems persist there (precedent: `kotatsu_layout`). */
export const METRICS_SETTING = 'kotatsu_metrics';

/** Its values. A string enum rather than a boolean, for the same reason the variant axes are. */
export const METRICS_STATES = Object.freeze(['on', 'off']);

/** Id of the checkbox in the User Settings drawer, beside the Wardrobe picker. */
const CHECKBOX_ID = 'kotatsu_metrics';

let initialized = false;
/** Last paint's shape, for the console door. Diagnostics only — nothing reads it back. */
let lastPaint = { messageId: /** @type {number?} */ (null), painted: false };

/**
 * @returns {boolean} whether the bar is switched on. Default ON: the readout is the point of
 * folding the extension in, and an unset key must mean "the shipped behaviour".
 */
export function metricsEnabled() {
    return power_user?.[METRICS_SETTING] !== 'off';
}

/**
 * @returns {number} the denominator: the FULL context window.
 *
 * Kept on purpose (`docs/metrics-native-v0.md` §1). Core's own budgeting uses
 * `getMaxPromptTokens()` — the window minus the reserved response — so this percentage reads a
 * few points lower than core's internal one. Changing a number users have calibrated their eyes
 * to over months of use would be a regression dressed as a correction; the tooltip says which
 * number it is instead.
 */
function maxContext() {
    try {
        return getMaxContextTokens() || 0;
    } catch {
        return 0;
    }
}

/**
 * Paints one message's row, if it has one mounted.
 * @param {any} message a `chat[]` entry
 * @param {number} max the context window, hoisted by sweeps so it is read once per pass
 * @returns {boolean} whether a bar is mounted afterwards
 */
function paintMessage(message, max) {
    // Character rows only, same scope the extension had: a user turn has no provider usage and
    // a bar under the persona name would be a lie about who spent the tokens.
    if (!message || message.is_user) return false;
    const row = rowFor(message);
    if (!row) return false;
    if (!metricsEnabled()) {
        removeMetricsBar(row);
        return false;
    }
    return paintMetricsBar(row, message, max);
}

/**
 * `CHARACTER_MESSAGE_RENDERED` — the single-row driver. Fires once per finalized character
 * message on both the streaming and the non-streaming path, AFTER core has stamped the usage.
 * @param {number|string} messageId the rendered message's index
 * @returns {void}
 */
function onCharacterMessageRendered(messageId) {
    const id = Number(messageId);
    if (!Number.isFinite(id)) return;
    const message = Array.isArray(chat) ? chat[id] : null;
    lastPaint = { messageId: id, painted: paintMessage(message, maxContext()) };
}

/**
 * The sweep. Walks `chat[]` rather than the DOM so the source of truth is the data, and lets
 * `rowFor()` decide which of those messages currently owns a mounted row — a windowed chat has
 * far more messages than rows and the WeakMap answers "not mounted" for free.
 *
 * Drivers: `CHAT_CHANGED` (a chat opened or reloaded) and `MORE_MESSAGES_LOADED` (the scrollback
 * sentinel or `#show_more_messages` extended the window). Both fire after core's rows exist.
 *
 * Known edge, documented rather than papered over with a timer: a bare `printMessages()` called
 * straight from the extension API repaints rows without emitting either event, so bars come back
 * on the next driver instead of immediately. Every core path that reaches `printMessages()`
 * emits `CHAT_CHANGED` right after it (`script.js:1855`, `:7975`, `:11199`), so no user-facing
 * flow is affected.
 * @returns {number} how many bars are mounted afterwards
 */
export function sweepMetrics() {
    if (!Array.isArray(chat)) return 0;
    const max = maxContext();
    let painted = 0;
    for (const message of chat) {
        if (paintMessage(message, max)) painted++;
    }
    return painted;
}

/**
 * Turns the readout on or off and repaints immediately. Off removes every mounted bar; on
 * repaints the loaded chat from stored data — the usage itself is never discarded, so the switch
 * is symmetric and losslessly reversible.
 * @param {string} value `'on'` or `'off'`
 * @returns {string} the value applied
 */
export function setMetricsEnabled(value) {
    const applied = METRICS_STATES.includes(value) ? value : 'on';
    if (applied !== value) {
        console.warn(`[Kotatsu metrics] Unknown state "${value}"; using "${applied}". Known: ${METRICS_STATES.join(', ')}.`);
    }
    power_user[METRICS_SETTING] = applied;
    saveSettingsDebounced();
    syncCheckbox();
    if (applied === 'off') {
        for (const bar of document.querySelectorAll(`#chat ${METRICS_TAG}`)) bar.remove();
    } else {
        sweepMetrics();
    }
    return applied;
}

/**
 * @returns {HTMLInputElement?} the settings checkbox, when the drawer markup is present
 */
function checkbox() {
    const element = document.getElementById(CHECKBOX_ID);
    return element instanceof HTMLInputElement ? element : null;
}

/**
 * Renders the live setting back into the checkbox. Called on init, on every set, and on
 * `SETTINGS_LOADED` — the seam runs before real settings exist, so the first paint of the
 * checkbox is a guess that has to be corrected once the file lands.
 * @returns {void}
 */
function syncCheckbox() {
    const input = checkbox();
    if (input) input.checked = metricsEnabled();
}

/**
 * Settings arrived: correct the checkbox and repaint. A chat is usually already open by then
 * (the boot order paints rows before `SETTINGS_LOADED`), so this is also what makes a stored
 * `off` take effect on the very first load instead of one navigation later.
 * @returns {void}
 */
function onSettingsLoaded() {
    syncCheckbox();
    if (metricsEnabled()) sweepMetrics();
    else for (const bar of document.querySelectorAll(`#chat ${METRICS_TAG}`)) bar.remove();
}

/**
 * Registers the metrics subsystem. Called once from `initKotatsuShell()` — the same
 * `firstLoadInit()` seam every other Kotatsu subsystem rides, and the only place core is allowed
 * to reach into kotatsu at all.
 * @returns {void}
 */
export function initMetrics() {
    if (initialized) return;
    initialized = true;

    defineMetricsElement();

    const input = checkbox();
    if (input) {
        input.checked = metricsEnabled();
        input.addEventListener('input', () => setMetricsEnabled(input.checked ? 'on' : 'off'));
    }

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, sweepMetrics);
    eventSource.on(event_types.MORE_MESSAGES_LOADED, sweepMetrics);
    eventSource.on(event_types.SETTINGS_LOADED, onSettingsLoaded);

    // Paint whatever is already on screen. The seam can run after a chat has been restored.
    sweepMetrics();

    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') {
        targetWindow.kotatsu = {};
    }
    // Same console surface shape as `window.kotatsu.{shell,branches,map,renderer}`.
    const door = {
        get state() {
            const messages = Array.isArray(chat) ? chat : [];
            return {
                on: metricsEnabled(),
                setting: power_user?.[METRICS_SETTING] ?? '(unset → on)',
                maxContext: maxContext(),
                bars: document.querySelectorAll(`#chat ${METRICS_TAG}`).length,
                messagesWithUsage: messages.filter(m => !m?.is_user && readStoredUsage(m)).length,
                lastPaint,
            };
        },
        enabled: metricsEnabled,
        set: setMetricsEnabled,
        sweep: sweepMetrics,
        probe() {
            const info = door.state;
            console.table(info);
            return info;
        },
        /**
         * Forces a synthetic bar onto the last character row without touching stored data —
         * the CSS/wardrobe door. Numbers are obviously fake so a screenshot can never be
         * mistaken for a real turn.
         * @returns {string} what happened
         */
        forceLast() {
            const messages = Array.isArray(chat) ? chat : [];
            for (let id = messages.length - 1; id >= 0; id--) {
                const message = messages[id];
                if (!message || message.is_user) continue;
                const row = rowFor(message);
                if (!row) continue;
                const painted = paintMetricsBar(row, {
                    extra: {
                        mm_usage: {
                            provider: 'test',
                            promptTokens: 12345,
                            outputTokens: 678,
                            cachedTokens: 9000,
                            cacheCreationTokens: 0,
                            cacheKnown: true,
                        },
                    },
                }, maxContext());
                return painted ? `forced a synthetic bar on message ${id}` : `message ${id} has no .mes_block`;
            }
            return 'no mounted character row to force';
        },
    };
    targetWindow.kotatsu.metrics = door;
}
