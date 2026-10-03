/**
 * Prompt-list render seam. Replaces only the prompt manager's instance methods; core keeps
 * owning prompt state and assembly. Rendering never starts a dry generation. Both recount
 * doors share one guard, and uninstall restores core's debounced render and cancels ours.
 */
import { eventSource, event_types } from '../../scripts/events.js';
import { promptManager } from '../../scripts/openai.js';
import { SlashCommand } from '../../scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../scripts/slash-commands/SlashCommandParser.js';

/** Fired when the seam mounts or re-mounts the component. */
export const PROMPT_LIST_MOUNTED_EVENT = 'kotatsu_prompt_list_mounted';

/** The explicit dry-run command, shared by the button and STscript. */
export const RECOUNT_COMMAND = 'kotatsu-recount';

/** Delay for model redraws; independent of core's dry-run render debounce. */
const REDRAW_DEBOUNCE_MS = 250;

/**
 * A trailing-edge debounce. Local rather than core's `debounce()` so the seam owns its own
 * timer and can clear it on uninstall — a stale timer firing into a torn-down patch is exactly
 * the leak class the branch-map audit rules out.
 * @param {() => void} fn Function to debounce.
 * @param {number} ms Delay.
 * @returns {{call: () => void, cancel: () => void}} Handle.
 */
function makeDebounce(fn, ms) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    return {
        call: () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                fn();
            }, ms);
        },
        cancel: () => {
            if (timer !== null) clearTimeout(timer);
            timer = null;
        },
    };
}

/**
 * Owns the core method patch, redraw timer, mount, and recount lifecycle. The component class
 * is supplied after it is defined, so the component can call the recount door without a
 * runtime import cycle. Create once per prompt-list module.
 * @param {typeof import('./k-prompt-list.js').KPromptList} ListElement Component class.
 * @returns {{initKotatsuPromptList: () => boolean, uninstallKotatsuPromptList: () => void,
 *   recountTokens: () => Promise<boolean>, isRecounting: () => boolean}} Lifecycle doors.
 */
export function createPromptListSeam(ListElement) {
    /** @type {boolean} */
    let installed = false;

    /** @type {any} The manager whose methods this module patched. */
    let patched = null;

    /** @type {((afterTryGenerate?: boolean) => void)|null} The original prototype render, bound. */
    let stockRender = null;

    /** @type {(() => void)|null} The original debounced render. */
    let stockRenderDebounced = null;

    /** @type {{call: () => void, cancel: () => void}|null} Our own debounce, cleared on uninstall. */
    let redraw = null;

    /** @type {(() => void)|null} Retry hook while `promptManager` has not been constructed yet. */
    let onSettingsLoaded = null;

    /** @returns {import('./k-prompt-list.js').KPromptList|null} The mounted component, or null. */
    function currentList() {
        const element = document.querySelector('k-prompt-list');
        return element instanceof ListElement ? element : null;
    }

    /**
     * Mounts (or re-mounts) the component inside `#completion_prompt_manager`.
     *
     * Re-mount is not paranoia: any core path that still reaches `renderPromptManager()` does
     * `containerElement.innerHTML = ''` (`PromptManager.js:1604`), which would take the element
     * with it. Checking on every update makes that recoverable instead of fatal.
     * @param {any} manager The prompt manager.
     * @returns {import('./k-prompt-list.js').KPromptList|null} The mounted component.
     */
    function mount(manager) {
        const container = manager.containerElement
            ?? document.getElementById(manager.configuration?.containerIdentifier ?? 'completion_prompt_manager');
        if (!(container instanceof HTMLElement)) return null;
        const existing = currentList();
        if (existing && container.contains(existing)) {
            existing.manager = manager;
            return existing;
        }
        container.innerHTML = '';
        const element = /** @type {import('./k-prompt-list.js').KPromptList} */ (document.createElement('k-prompt-list'));
        element.setAttribute('variant', 'list');
        element.manager = manager;
        container.appendChild(element);
        document.dispatchEvent(new CustomEvent(PROMPT_LIST_MOUNTED_EVENT, { detail: { remount: Boolean(existing) } }));
        return element;
    }

    /**
     * The patched render's whole body: make sure the component is mounted, then ask it to rebuild.
     * Never a dry run, never a teardown (decision 2).
     * @param {boolean} [rederive] Whether the section tree may have changed.
     * @returns {void}
     */
    function update(rederive = true) {
        if (!patched) return;
        const element = mount(patched);
        if (!element) return;
        element.refresh(rederive);
    }

    /** @type {boolean} One dry run at a time, whichever door it came through. */
    let recounting = false;

    /** @returns {boolean} Whether a recount is in flight. */
    function isRecounting() {
        return recounting;
    }

    /**
     * Runs core's dry run ON DEMAND and refreshes the badges from the result — decision 2's
     * "explicit recount". No teardown: `tryGenerate()` alone repopulates `tokenHandler.counts`
     * through `setChatCompletion` (`openai.js:1601`).
     *
     * Two doors reach it — the header button and `/kotatsu-recount` — and both share this one
     * guard, so a second request while a generation is in flight is refused rather than queued.
     * The busy flag is pushed onto the mounted component so the button can show it.
     * @returns {Promise<boolean>} Whether a dry run actually ran.
     */
    async function recountTokens() {
        if (!patched || recounting) return false;
        recounting = true;
        currentList()?.setBusy(true);
        try {
            await patched.tryGenerate();
        } catch (error) {
            console.error('[k-prompt-list] recount dry run failed', error);
        } finally {
            recounting = false;
            currentList()?.setBusy(false);
            update(false);
        }
        return true;
    }

    /**
     * Installs the strangler seam.
     *
     * Called by initKotatsuShell() before settings exist. Core constructs `promptManager`
     * later in loadOpenAISettings(), so a deferred attach waits on SETTINGS_LOADED.
     * Registration and attachment are idempotent.
     * @returns {boolean} Whether the seam is attached yet.
     */
    function initKotatsuPromptList() {
        if (installed) return true;
        installed = true;
        registerRecountCommand();
        if (attach()) return true;
        onSettingsLoaded = () => {
            if (attach() && onSettingsLoaded) {
                eventSource.removeListener(event_types.SETTINGS_LOADED, onSettingsLoaded);
                onSettingsLoaded = null;
            }
        };
        eventSource.on(event_types.SETTINGS_LOADED, onSettingsLoaded);
        return false;
    }

    /** @type {boolean} */
    let commandRegistered = false;

    /**
     * Registers `/kotatsu-recount` — the sanctioned replacement for the side effect STscript users
     * lost when `/pm-render refresh=true` stopped running a dry run (decision 2: the always-on dry
     * run is the single worst interaction in the stock panel, so `render()` no longer honours the
     * flag). `/pm-render` itself keeps working and still redraws; only the hidden recount moved to
     * a command that says what it does.
     *
     * Additive under CONTRACT §0, and idempotent: registering twice would only earn a
     * `console.trace` from `addCommandObjectUnsafe` (`SlashCommandParser.js:79-81`), but a duplicate
     * command is a duplicate autocomplete entry, so it is checked. There is no deregistration API in
     * core, so `uninstallKotatsuPromptList()` leaves the command in place — with the seam gone
     * `recountTokens()` returns false and does nothing, which is the honest behaviour anyway.
     * @returns {void}
     */
    function registerRecountCommand() {
        if (commandRegistered) return;
        commandRegistered = true;
        try {
            const existing = SlashCommandParser.commands;
            if (existing && Object.hasOwn(existing, RECOUNT_COMMAND)) return;
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: RECOUNT_COMMAND,
                callback: async () => {
                    await recountTokens();
                    return '';
                },
                helpString: 'Recounts the prompt manager\'s token badges by running one dry generation, '
                    + 'and refreshes the list. This is the explicit form of the pass the stock panel used to '
                    + 'run on every render; /pm-render only redraws.',
            }));
        } catch (error) {
            console.error('[k-prompt-list] /kotatsu-recount could not be registered', error);
        }
    }

    /**
     * Patches the instance and mounts the component. Both `render` and `renderDebounced` are
     * replaced; the originals are kept, and `renderStock` is published on the manager so a wedged
     * session can put core's own UI back by hand.
     * @returns {boolean} Whether the patch took.
     */
    function attach() {
        const manager = promptManager;
        if (!manager || typeof manager.render !== 'function') return false;
        if (patched === manager) return true;

        stockRender = manager.render.bind(manager);
        stockRenderDebounced = manager.renderDebounced;
        patched = manager;
        manager.renderStock = stockRender;

        redraw = makeDebounce(() => update(true), REDRAW_DEBOUNCE_MS);

        // Both methods must be replaced: core's constructor-built debounce captured the stock
        // render before this patch. Own properties shadow both originals. The
        // `afterTryGenerate` argument is accepted and deliberately ignored: `/pm-render refresh=true`
        // and every core caller default to `true`, and honouring it would put the dry run back on
        // the hot path. `recountTokens()` is the on-demand door.
        manager.render = (/** @type {boolean} */ afterTryGenerate = true) => {
            void afterTryGenerate;
            update(true);
        };
        manager.renderDebounced = () => redraw?.call();

        if (!mount(manager)) {
            // The panel's container is not in the document yet. The patch stays in place; the next
            // `render()` call re-tries the mount, so nothing is lost.
            console.debug('[k-prompt-list] container not present yet; patch armed, mount deferred');
            return true;
        }
        update(true);
        return true;
    }

    /**
     * Removes the patch, the component and every listener this module added. Symmetry for
     * {@link initKotatsuPromptList}; used by teardown paths and tests.
     * @returns {void}
     */
    function uninstallKotatsuPromptList() {
        if (!installed) return;
        installed = false;
        if (onSettingsLoaded) {
            eventSource.removeListener(event_types.SETTINGS_LOADED, onSettingsLoaded);
            onSettingsLoaded = null;
        }
        redraw?.cancel();
        redraw = null;
        currentList()?.remove();
        if (patched) {
            delete patched.render;
            delete patched.renderStock;
            if (stockRenderDebounced) patched.renderDebounced = stockRenderDebounced;
            patched = null;
        }
        stockRender = null;
        stockRenderDebounced = null;
    }

    return { initKotatsuPromptList, uninstallKotatsuPromptList, recountTokens, isRecounting };
}
