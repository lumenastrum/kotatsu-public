/**
 * Kotatsu shell — entry point (shell v0 slice A, docs/shell-v0.md).
 *
 * Registered from `firstLoadInit()` at public/script.js, one line next to the
 * theme loader and following its shape exactly. That seam is chosen, not
 * convenient: it runs BEFORE initDomHandlers() and long before the end-of-file
 * jQuery block where `.drawer-toggle` binds and OpenNavPanels() fires, so nodes
 * can be relocated while nothing has bound to their positions yet (recon 4.1).
 */

import { eventSource, event_types } from '../../scripts/events.js';
import { formatCacheClear, formatCacheStats } from '../../scripts/message-format-cache.js';
import {
    getVariantAxis,
    MESSAGE_VARIANTS,
    ROW_AXES,
} from '../../scripts/message-rows.js';
import { power_user } from '../../scripts/power-user.js';
import {
    closeBranchMap,
    installBranchMap,
    openBranchMap,
} from '../branches/k-branch-map.js';
import { branchStore, initBranchStore } from '../branches/store.js';
import { initMetrics } from '../metrics/index.js';
import { initMarketSettings } from '../market/settings.js';
import { initSceneNudgeSetting } from '../groups/scene-nudge-setting.js';
import {
    closeLibrary,
    installLandingPicker,
    libraryState,
    openLibrary,
    showLibraryView,
} from '../library/k-library.js';
import { initKotatsuPromptList } from '../prompts/k-prompt-list.js';
import { initReceiptTracker } from '../prompts/k-receipt-tracker.js';
import { closeStudio, openStudio, studioState } from '../studio/k-card-studio.js';
import { closeSceneStudio, openSceneStudio, sceneStudioState } from '../groups/k-scene-studio.js';
import { closeSettings, openSettings, settingsState } from '../settings/k-settings-modal.js';
import { initPromptReceipts } from '../prompts/receipts.js';
import { initMetadataReveal } from '../renderer/metadata-reveal.js';
import { initSwipeCountMarker } from '../renderer/swipe-count.js';
import { applyResolvedVariants, setVariantAxis } from '../theme/loader.js';
import { initPresetDock } from './components/k-preset-pages.js';
import { classicLayout } from './layouts/classic.js';
import { railsLayout } from './layouts/rails.js';
import {
    DEFAULT_LAYOUT,
    isLayoutId,
    mirrorLayout,
    readStoredLayout,
    setLayout,
} from './persistence.js';
import { getRailStates, setRail, toggleRail } from './rail-collapse.js';
import { installBaggage } from '../settings/baggage.js';
import { installBridgeLink } from '../connections/bridge.js';
import { mountBridgeCard } from '../connections/k-bridge-card.js';
import { mountProviderCards } from '../connections/k-provider-cards.js';
import { mountConnectionMore } from '../connections/k-connection-more.js';
import { installPresetBinding } from '../connections/preset-binding.js';
import { installComposerReason } from '../connections/composer-reason.js';
import { installOnboarding } from '../onboarding/k-onboarding.js';
import { installWhatsNew } from '../whats-new/k-whats-new.js';
import { applyLayout, currentLayout, defineLayout, hasLayout } from './registry.js';

export { setLayout } from './persistence.js';

let initialized = false;

/**
 * Brings the settings mirror up to date once real settings have loaded.
 *
 * The seam runs before getSettings(), so the layout that painted came from
 * localStorage. If `power_user.kotatsu_layout` arrives later disagreeing — a
 * settings file synced from another machine, a fresh profile on this one — the
 * mirror is corrected so the NEXT load honours it. Deliberately no reload: a
 * boot-time reload is hostile, and one wrong paint is the whole cost.
 * @returns {void}
 */
function reconcileWithSettings() {
    const stored = power_user?.kotatsu_layout;
    if (!isLayoutId(stored)) return;
    if (!hasLayout(stored)) return;
    if (stored === currentLayout()) return;
    console.info(`[Kotatsu shell] Settings ask for the "${stored}" layout; it will apply on the next load.`);
    mirrorLayout(stored);
}

/**
 * Settles every variant axis once real settings exist, and warns once about a Moonlit-era
 * `chat_display` value core cannot apply (renderer v0 §2.5: detected, never trusted — the
 * variant setting is the renderer-owned replacement).
 *
 * The write is delegated to the theme loader because a theme pack's `variants.<axis>`
 * outranks the user's own setting, and only the loader knows whether a pack declares one.
 * It reads `power_user.kotatsu_mes_*` itself and falls back to those whenever no pack does.
 * Delegating is not optional: SETTINGS_LOADED listeners run in registration order and the
 * theme loader registers first (script.js firstLoadInit), so applying the user's settings
 * straight from here would clobber a pack's wardrobe every boot.
 * @returns {void}
 */
function reconcileVariantAxes() {
    applyResolvedVariants();
    const chatDisplay = Number(power_user?.chat_display);
    if (Number.isFinite(chatDisplay) && chatDisplay > 2) {
        console.warn(`[Kotatsu renderer] settings carry chat_display=${chatDisplay} — a value core's applier has no case for (a Moonlit-era residue). Ignored; use window.kotatsu.renderer.setVariant() instead.`);
    }
}

/**
 * Registers both layouts and applies the stored choice.
 * @returns {Promise<void>}
 */
export async function initKotatsuShell() {
    if (initialized) return;
    initialized = true;

    defineLayout('classic', classicLayout);
    defineLayout('rails', railsLayout);

    // Branch panel v0 slice B. Rides this seam rather than adding a second
    // core → kotatsu import: `firstLoadInit()` owns exactly one line per
    // subsystem, and the store only subscribes to core events here — no fetch
    // happens until a UI asks for a tree.
    initBranchStore();

    // Branch panel v0 slice D. Listeners only — the overlay element is created
    // on the first open request and removed from the DOM on close, so nothing
    // is mounted (and nothing subscribes to the store) until it is asked for.
    // Installed here rather than in the rails layout because the map is
    // layout-independent: its sheet is scoped to the custom element, not to
    // body[data-k-layout="rails"], and the keyboard door has to work under
    // classic too.
    installBranchMap();

    // Prompt manager v0 slices B + D. Both are deferred-arming by design:
    // `promptManager` does not exist until loadOpenAISettings() builds it long
    // after this seam, so the list waits on SETTINGS_LOADED and the receipt
    // store retries on the same events — wiring here is registration only.
    initKotatsuPromptList();
    initPromptReceipts();

    // Preset dock v0 (docs/preset-dock-v0.md). Mounts the Sauce/Dials/Rack
    // strip into #left-nav-panel; inert under classic, filters only when the
    // panel wears .k-docked.
    initPresetDock();

    // Baggage audit v0 (docs/baggage-audit-v0.md). Registration only: the Extras migration
    // listens for EXTENSIONS_FIRST_LOAD (after saved extension settings merge, before any
    // extension activates), the option pruning waits for APP_READY, and the connection
    // attributes the baggage sheet keys on follow core's connection events.
    installBaggage();

    // Connections v0 slice C0 (docs/connections-v0.md): what the frontend knows about the built-in
    // Claude Code bridge — the `data-k-bridge` attribute, the first-run connect, the doctor toast.
    installBridgeLink();
    // D3: presets shape the prompt, connections pick the model — unbind once per install.
    installPresetBinding();
    // Artboard 3's first-run half: the composer says why Claude Code isn't ready, and links the fix.
    installComposerReason();
    // C1–C3: the Claude Code card, "Your API keys", then saved connections + more ways, first in
    // core's #rm_api_block (the Connection tab adopts it). The Connection Manager inserts its
    // profile block at the top of that block when extensions activate — after this — so all three
    // re-seat once the app is ready.
    const seatConnectionCards = () => {
        mountBridgeCard();
        mountProviderCards();
        mountConnectionMore();
    };
    seatConnectionCards();
    eventSource.on(event_types.APP_READY, seatConnectionCards);

    // Receipt tracker v0 (docs/receipt-tracker-v0.md). Registration only, same as the store
    // above: this just guarantees <k-receipt-tracker> is defined. k-tab-rail.js's Trackers
    // page is what actually creates one, as an ordinary Lit child, when that tab renders.
    initReceiptTracker();

    // Metrics native v0. Registration only: the paint drivers are core events and the bar is
    // built on demand, so nothing mounts until a message with usage has a row. Rides this seam
    // rather than a second core → kotatsu import for the same reason everything else here does
    // — `firstLoadInit()` owns exactly one line per subsystem.
    initMetrics();

    // Library v0 slice C. Importing this module is what DEFINES <k-library>; the element
    // itself is mounted into #k-center by the rails layout and removed on unmount, and it
    // owns its own document-level doors (`k-open-library`, Escape) for exactly as long as it
    // is connected. Only the settings picker is wired here, at the same seam and for the same
    // reason the wardrobe picker is: the drawer markup exists from first paint, and the
    // control has to be a view of `power_user` before anything can change it.
    installLandingPicker();

    // Character marketplace v0 slice E (docs/character-marketplace-v0.md §7): the two Browse
    // Characters checkboxes. Binding only; `<k-market>` is still imported on the first switch
    // to Browse and never before, so a gallery that never browses never loads it.
    initMarketSettings();
    // Group chat v0 §10: the scene nudge toggle (power_user.kotatsu_scene_nudge).
    initSceneNudgeSetting();

    // Onboarding v0 slice O1 (docs/onboarding-v0.md): Mikan-chan's welcome tour. Registration
    // only — it opens at APP_READY when core's first-run gate (or a mid-tour reload) left
    // `power_user.kotatsu_onboarding` asking for it, and answers Settings → System's replay door.
    installOnboarding();

    // What's New: the release notes, once per update (whats-new/state.js decides). Registration
    // only — it reads the running version at APP_READY and answers Settings → System's door.
    installWhatsNew();

    const requested = readStoredLayout();
    const target = hasLayout(requested) ? requested : DEFAULT_LAYOUT;
    if (target !== requested) {
        console.warn(`[Kotatsu shell] No layout registered as "${requested}"; falling back to "${DEFAULT_LAYOUT}".`);
    }
    await applyLayout(target);

    // Variant wardrobe v0 slice B: the `metadata=click` reveal. Registration only — the
    // handler is a no-op until the metadata axis actually resolves to `click`. It rides this
    // seam rather than the layouts because `#chat` is layout-independent: the rails layout
    // moves the node, it never replaces it.
    initMetadataReveal();
    // Reader-polish v0 finding 5: marks each row with its swipe total so the sheet can hide
    // the "1/1" counters. Same seam, same one-registration shape as the reveal above.
    initSwipeCountMarker();

    eventSource.on(event_types.SETTINGS_LOADED, reconcileWithSettings);
    eventSource.on(event_types.SETTINGS_LOADED, reconcileVariantAxes);

    /**
     * Same console surface the theme loader exposes (`window.kotatsu.theme`).
     * `open()` matters beyond debugging: it is the guaranteed door into the
     * settings surface if a top bar ever mounts without a working gear. That
     * surface is `<k-settings-modal>` as of settings v0 slice B; the drawer-rack
     * reveal it replaced is still reachable from the model menu's wizard footer.
     * @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}}
     */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') {
        targetWindow.kotatsu = {};
    }
    targetWindow.kotatsu.shell = {
        current: currentLayout,
        set: setLayout,
        open: openSettings,
        close: closeSettings,
        // `state` is a getter so a console read is always current — same shape the
        // library's door uses. Reports the active tab and how many stock controls
        // the modal is currently holding out of the parked rack.
        get settings() {
            return settingsState();
        },
        // Rail collapse (variant wardrobe v0 §3). Present under both layouts and
        // harmless under classic, where nothing is installed: `rails()` reports
        // the defaults and the setters warn rather than writing an attribute
        // onto a layout that has no rails to describe.
        rails: getRailStates,
        setRail,
        toggleRail,
    };
    // Same console door for the branch graph, so a tree can be inspected before
    // any branch UI exists to render it. `map.open()` matters beyond debugging
    // for the same reason the shell's does: it is the guaranteed way into the
    // overlay if the top-bar affordance is missing and the hotkey is swallowed
    // by the browser.
    targetWindow.kotatsu.branches = branchStore;
    targetWindow.kotatsu.map = { open: openBranchMap, close: closeBranchMap };
    // Library v0 §1.1's console door. `open()` matters beyond debugging for the same reason
    // the map's does: it is the guaranteed way into the gallery if the rail's route and the
    // auto-show both fail. `state` is a getter so a console read is always current.
    targetWindow.kotatsu.library = {
        open: openLibrary,
        close: closeLibrary,
        // `show('browse')` = open on Browse Characters, the tour tile's door (marketplace §9).
        show: showLibraryView,
        get state() {
            return libraryState();
        },
    };
    // Library v0 §2's console door. `open('create')` / `open(chid)` matter beyond debugging for
    // the reason every other door here does: they are the guaranteed way into the studio if the
    // gallery's hero button and the card's pencil both fail. `close()` is also the guaranteed
    // way to put the borrowed core controls back if a surface ever strands them — the element's
    // disconnect path is what restores, so `close()` cannot leave a control behind.
    targetWindow.kotatsu.studio = {
        open: (/** @type {'create'|number|string} */ target = 'create') => openStudio(target),
        close: closeStudio,
        get state() {
            return studioState();
        },
    };
    // Group chat v0 G2: the scene studio door — `open('create')` / `open(groupId)`.
    targetWindow.kotatsu.scenes = {
        open: (/** @type {'create'|string} */ target = 'create') => openSceneStudio(target),
        close: closeSceneStudio,
        get state() {
            return sceneStudioState();
        },
    };
    // Renderer v0 §2.5: the message-variant door, now one of three axes (variant-wardrobe v0
    // §2 — `window.kotatsu.wardrobe` is the axis-general surface). The sets are fixed in core
    // (SPEC §13 — a new variant is a core change).
    //
    // `setVariant` delegates to the wardrobe door instead of force-writing the attribute: it
    // persists the user's choice and re-resolves, so a pack that pins `message` still outranks
    // it. That deliberately retires slice E's third precedence source — the console and the
    // picker now agree, and the picker disables an axis a pack has pinned.
    targetWindow.kotatsu.renderer = {
        variants: MESSAGE_VARIANTS,
        axes: ROW_AXES,
        variant: () => getVariantAxis('message'),
        setVariant: (/** @type {string} */ value) => setVariantAxis('message', value),
        // Renderer v0 slice B: the format cache's console surface — hit/miss/epoch counters and
        // whether a macro-carrying regex script or a formatter hook has it hard-disabled.
        formatCache: formatCacheStats,
        clearFormatCache: formatCacheClear,
    };
}
