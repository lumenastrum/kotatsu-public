/**
 * Unified action loader system - shows loader overlay with optional toast notifications.
 * Designed to be flexible and reusable for various long-running operations.
 *
 * Features:
 * - Stacking multiple loaders - overlay stays single, but toasts can stack
 * - Blocking and non-blocking modes
 * - Stoppable or static toasts
 * - Class-based handle system for fine-grained control
 *
 * @module action-loader
 */

import { t } from './i18n.js';
import { stopGeneration } from '../script.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';

/**
 * Enum representing the toast display mode for the action loader.
 * @readonly
 * @enum {string}
 */
export const ActionLoaderToastMode = {
    /** No toast is displayed */
    NONE: 'none',
    /** Toast is displayed without stop button (non-interactable) */
    STATIC: 'static',
    /** Toast is displayed with stop button (default) */
    STOPPABLE: 'stoppable',
};

/**
 * @typedef {object} ActionLoaderOptions
 * @property {boolean} [blocking=true] - Whether to show the blocking overlay. Set to false for non-blocking toast-only loaders.
 * @property {ActionLoaderToastMode} [toastMode='stoppable'] - Toast display mode
 * @property {string} [slug=null] - Unique slug for the loader to identify it easily via code or CSS
 * @property {string} [message='Generating...'] - The message to display in the toast
 * @property {string} [title] - Optional title for the toast notification
 * @property {string} [stopTooltip='Stop'] - Tooltip text for the stop button
 * @property {HTMLElement|string|null} [overlayContent=null] - Custom content for the overlay (replaces default spinner)
 * @property {(() => void)|null} [onStop=null] - Custom stop handler. If null, calls `stopGeneration()`
 * @property {(() => void)|null} [onHide=null] - Custom hide handler. Called when the loader is hidden (not stopped).
 */

/** Counter for generating unique loader IDs */
let loaderIdCounter = 0;

/** @type {Set<ActionLoaderHandle>} Set of all active loader handles */
const activeHandles = new Set();

/**
 * Generates a unique loader ID.
 * @returns {string} Unique loader ID
 */
function generateLoaderId() {
    return `loader_${++loaderIdCounter}`;
}

/**
 * Checks if there are any active blocking loaders.
 * @returns {boolean} True if at least one blocking loader is active
 */
function hasBlockingLoaders() {
    for (const handle of activeHandles) {
        if (handle.isBlocking && handle.isActive) {
            return true;
        }
    }
    return false;
}

/**
 * Class representing an action loader handle.
 * Manages its own toast, stop handler, and lifecycle.
 */
export class ActionLoaderHandle {
    /**
     * A special empty handle that is already disposed. Useful as a default value to avoid null checks.
     * Does not generate any id, toast, or overlay, and all its methods are no-ops.
     * @type {ActionLoaderHandle}
     */
    static get EMPTY() {
        return new ActionLoaderHandle({ predisposed: true });
    }

    /** @type {string} Unique identifier for this handle */
    #id;

    /** @type {string|null} Unique slug for the loader */
    #slug = null;

    /** @type {JQuery<HTMLElement>|null} The toast element for this loader */
    #toast = null;

    /** @type {(() => void)|null} Custom stop handler */
    #onStop = null;

    /** @type {(() => void)|null} Custom hide handler */
    #onHide = null;

    /** @type {boolean} Whether this loader blocks the UI with an overlay */
    #blocking = true;

    /** @type {boolean} Whether this handle has been disposed */
    #disposed = false;

    /**
     * Creates a new ActionLoaderHandle.
     * @param {object} options - Configuration options
     * @param {boolean} [options.blocking=true] - Whether to show blocking overlay
     * @param {ActionLoaderToastMode} [options.toastMode] - Toast display mode
     * @param {string|null} [options.slug] - Unique slug for the loader (to identify it easily via code or CSS)
     * @param {string} [options.message='Generating...'] - Message to display in the toast
     * @param {string} [options.title] - Title for the toast notification
     * @param {string} [options.stopTooltip='Stop'] - Tooltip for the stop button
     * @param {boolean} [options.predisposed=false] - Whether this handle is already disposed (for special use)
     * @param {HTMLElement|string|null} [options.overlayContent] - Custom content for the overlay (replaces default spinner)
     * @param {(() => void)|null} [options.onStop] - Custom stop handler
     * @param {(() => void)|null} [options.onHide] - Custom hide handler
     */
    constructor({
        blocking = true,
        toastMode = ActionLoaderToastMode.STOPPABLE,
        slug = null,
        message = t`Generating...`,
        title = '',
        stopTooltip = t`Stop`,
        overlayContent = null,
        onStop = null,
        onHide = null,
        predisposed = false,
    } = {}) {
        if (predisposed) {
            this.#disposed = true;
            return;
        }

        this.#id = generateLoaderId();
        this.#slug = slug;
        this.#blocking = blocking;
        this.#onStop = onStop;
        this.#onHide = onHide;

        // Warn if non-blocking loader has no toast - it won't be visible to the user
        if (!blocking && toastMode === ActionLoaderToastMode.NONE && !overlayContent) {
            console.warn('[ActionLoader] Non-blocking loader created without a toast. This loader will not be visible to the user.');
        }

        // Show the blocking loader overlay if this is the first blocking handle
        if (blocking && !hasBlockingLoaders() && !isOverlayDisplayed()) {
            showOverlay(overlayContent);
        }

        // Register this handle
        activeHandles.add(this);

        // Create toast if needed
        if (toastMode !== ActionLoaderToastMode.NONE) {
            this.#createToast(message, title, toastMode, stopTooltip);
        }
    }

    /**
     * Creates the toast element for this loader.
     * @param {string} message - Message to display
     * @param {string} title - Title for the toast
     * @param {ActionLoaderToastMode} toastMode - Toast mode
     * @param {string} stopTooltip - Tooltip for stop button
     */
    #createToast(message, title, toastMode, stopTooltip) {
        const toastContent = document.createElement('div');
        toastContent.className = 'action-loader-toast';

        if (this.#slug) {
            toastContent.dataset.slug = this.#slug;
        }
        toastContent.dataset.loaderId = this.#id;
        toastContent.dataset.blocking = this.#blocking.toString();

        const messageSpan = document.createElement('span');
        messageSpan.className = 'action-loader-message';
        messageSpan.textContent = message;
        toastContent.appendChild(messageSpan);

        // Add stop button if mode is STOPPABLE
        if (toastMode === ActionLoaderToastMode.STOPPABLE) {
            const stopButton = document.createElement('i');
            stopButton.className = 'fa-solid fa-stop-circle action-loader-stop interactable';
            stopButton.title = stopTooltip;
            stopButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.stop();
            });
            toastContent.appendChild(stopButton);
        }

        // Show toast with no timeout (sticky)
        this.#toast = toastr.info($(toastContent), title, {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            escapeHtml: false,
        });
    }

    /**
     * Clears the toast element for this loader.
     */
    #clearToast() {
        if (this.#toast) {
            toastr.clear(this.#toast, { force: true }); // Need to force as the toast might have focus/hover
            this.#toast = null;
        }
    }

    /**
     * Disposes this handle, removing it from active handles and hiding overlay if last.
     */
    async #dispose() {
        if (this.#disposed) return;
        this.#disposed = true;

        this.#clearToast();
        activeHandles.delete(this);

        // Hide the overlay if this was the last blocking handle
        if (this.#blocking && !hasBlockingLoaders()) {
            await hideOverlay();
        }
    }

    /**
     * The unique identifier for this loader handle.
     * @returns {string}
     */
    get id() {
        return this.#id;
    }

    /**
     * The unique slug for this loader handle, used to identify it easily via code or CSS.
     * @returns {string|null}
     */
    get slug() {
        return this.#slug;
    }

    /**
     * Whether this handle is still active (not disposed).
     * @returns {boolean}
     */
    get isActive() {
        return !this.#disposed;
    }

    /**
     * Whether this loader blocks the UI with an overlay.
     * @returns {boolean}
     */
    get isBlocking() {
        return this.#blocking;
    }

    /**
     * Triggers the stop action on this loader.
     * Calls the custom onStop handler if provided, otherwise calls stopGeneration().
     * Then hides this loader.
     */
    async stop() {
        if (this.#disposed) return;

        // Call custom stop handler or default
        if (this.#onStop) {
            try {
                await this.#onStop();
            } catch (e) {
                console.error('Error executing onStop handler', e);
            }
        } else {
            stopGeneration();
        }

        // Dispose without calling onHide (stop is different from hide)
        await this.#dispose();
    }

    /**
     * Hides this loader and clears its toast.
     * Calls the custom onHide handler if provided.
     */
    async hide() {
        if (this.#disposed) return;

        // Call custom hide handler if provided
        if (this.#onHide) {
            try {
                await this.#onHide();
            } catch (e) {
                console.error('Error executing onHide handler', e);
            }
        }

        await this.#dispose();
    }
}

/**
 * Action loader utility API.
 * Provides a convenient interface for showing and managing loading indicators.
 *
 * Read the functions documentation for more details.
 *
 * @example
 * // Basic usage
 * const handle = loader.show({ message: 'Loading...' });
 * await someOperation();
 * handle.hide();
 *
 * @example
 * // Non-blocking background task
 * const handle = loader.show({ blocking: false, message: 'Processing...' });
 *
 * @example
 * // Hide all active loaders
 * loader.hide();
 */
export const loader = {
    /**
     * Shows an action loader with optional toast notification.
     * Returns a handle to control the loader.
     * @type {typeof showActionLoader}
     */
    show: showActionLoader,

    /**
     * Hides a specific loader by handle, or all loaders if no handle provided.
     * @type {typeof hideActionLoader}
     */
    hide: hideActionLoader,

    /**
     * Gets all currently active loader handles.
     * @type {typeof getActiveLoaderHandles}
     */
    active: getActiveLoaderHandles,

    /**
     * Gets a loader handle by its ID.
     * @type {typeof getLoaderHandleById}
     */
    get: getLoaderHandleById,

    /**
     * Checks if any blocking loader overlay is currently displayed.
     * @returns {boolean} True if a blocking overlay is shown
     */
    isBlocking: isOverlayDisplayed,

    /**
     * Toast display mode constants.
     * @type {typeof ActionLoaderToastMode}
     */
    ToastMode: ActionLoaderToastMode,

    /**
     * The ActionLoaderHandle class.
     * @type {typeof ActionLoaderHandle}
     */
    Handle: ActionLoaderHandle,

    /**
     * Creates a fresh default loader overlay element.
     * @type {typeof createDefaultLoaderOverlay}
     */
    createOverlay: createDefaultLoaderOverlay,
};

/**
 * Shows an action loader with an optional stoppable toast notification.
 * Multiple loaders can be stacked - the overlay stays single, but each gets its own toast.
 * When the last loader is hidden, the overlay is removed.
 *
 * With default arguments, will function as a generation loader / wrapper.
 *
 * @param {ActionLoaderOptions} [options={}] - Configuration options
 * @returns {ActionLoaderHandle} Handle to control the loader
 *
 * @example
 * // Basic usage
 * const loader = showActionLoader({ message: 'Generating title...' });
 * try {
 *     const result = await generateRaw({ prompt });
 *     // process result
 * } finally {
 *     await loader.hide();
 * }
 *
 * @example
 * // With custom stop and hide handlers
 * const loader = showActionLoader({
 *     message: 'Downloading...',
 *     stopTooltip: 'Cancel download',
 *     onStop: () => myCustomCancelFunction(),
 *     onHide: () => console.log('Loader hidden'),
 * });
 *
 * @example
 * // Stacking multiple loaders
 * const loader1 = showActionLoader({ message: 'Task 1...' });
 * const loader2 = showActionLoader({ message: 'Task 2...' });
 * await loader1.hide(); // Overlay stays, loader2 still active
 * await loader2.hide(); // Now overlay hides
 *
 * @example
 * // Non-blocking loader (toast only, no overlay)
 * const loader = showActionLoader({
 *     message: 'Captioning image...',
 *     blocking: false,
 *     onStop: () => abortCaptioning(),
 * });
 */
export function showActionLoader(options = {}) {
    return new ActionLoaderHandle(options);
}

/**
 * Hides a specific action loader by handle, or all active loaders if no handle provided.
 * @param {ActionLoaderHandle|null} [handle=null] - Specific handle to hide, or undefined to hide all
 * @returns {Promise<boolean>} Whether any loader was hidden
 */
export async function hideActionLoader(handle = null) {
    if (handle instanceof ActionLoaderHandle) {
        if (handle.isActive) {
            await handle.hide();
            return true;
        }
        return false;
    }

    // No handle provided - hide all active loaders
    const handles = getActiveLoaderHandles();
    for (const h of handles) {
        await h.hide();
    }
    return handles.length > 0;
}

/**
 * Gets all currently active loader handles.
 * @returns {ActionLoaderHandle[]} Array of active handles
 */
export function getActiveLoaderHandles() {
    return Array.from(activeHandles);
}

/**
 * Gets a loader handle by its ID.
 * @param {string} id - The handle ID
 * @returns {ActionLoaderHandle|undefined} The handle, or undefined if not found
 */
export function getLoaderHandleById(id) {
    for (const handle of activeHandles) {
        if (handle.id === id) {
            return handle;
        }
    }
    return undefined;
}

// ============================================================================
// Internal overlay management
// ============================================================================

/** @type {Popup|null} The current loader overlay popup */
let loaderPopup = null;

/** Whether the initial HTML preloader has been removed */
let preloaderYoinked = false;

/**
 * Cozy words cycled by the default loader overlay.
 * Brand voice, deliberately not localized (same doctrine as the wordmark).
 */
const LOADER_WORDS = [
    'Warming the table…',
    'Lighting the hearth…',
    'Brewing the tea…',
    'Fluffing the cushions…',
    'Stealing the blankets…',
    'Setting your place…',
    'Stoking the coals…',
    'Waking the cats…',
    'Peeling the mikan…',
    'Tucking in the corners…',
];

/** Milliseconds between word changes on the default loader overlay. */
const LOADER_WORD_INTERVAL_MS = 1800;

/** Milliseconds for each half of the word crossfade. */
const LOADER_WORD_FADE_MS = 220;

/** Monotonic suffix so overlapping overlays never share an SVG gradient id. */
let loaderOverlayCounter = 0;

/** A four-point sparkle; `fill` is a literal or `currentColor`. */
const sparkle = (fill) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0 C8.6 5.4 10.6 7.4 16 8 C10.6 8.6 8.6 10.6 8 16 C7.4 10.6 5.4 8.6 0 8 C5.4 7.4 7.4 5.4 8 0Z" fill="${fill}"/></svg>`;

/** The bigger "kira!" flare one eye throws once a loop. */
const KIRA_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0 L13 10.6 L24 12 L13 13.4 L12 24 L11 13.4 L0 12 L11 10.6Z" fill="#fffbe8"/><circle cx="12" cy="12" r="2.4" fill="#fff"/></svg>';

/**
 * Whether the active theme pack hides Mikan-chan (`--k-mascot-display: none`, docs/brand.md).
 * Pack tokens are on :root before any module runs (the first-paint script in index.html).
 * @returns {boolean} True when she should stay hidden
 */
function isMascotHidden() {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue('--k-mascot-display').trim() === 'none';
    } catch {
        return false;
    }
}

/**
 * Star-Eyes: chibi Mikan-chan hugging her mikan. She breathes, sways, blinks, and her star
 * pupils twinkle (docs/loader-v0.md). The glint positions live in loader.css.
 * @param {HTMLDivElement} spinnerElement The `#load-spinner` element to fill
 */
function fillChibiSpinner(spinnerElement) {
    spinnerElement.classList.add('k-chibi');
    spinnerElement.setAttribute('role', 'img');
    spinnerElement.setAttribute('aria-label', 'Loading');
    spinnerElement.innerHTML = `
        <span class="k-chibi-shadow"></span>
        <div class="k-chibi-sway"><div class="k-chibi-breathe">
            <img class="k-chibi-open" src="kotatsu/brand/mascot/chibi.webp" alt="" draggable="false">
            <img class="k-chibi-blink" src="kotatsu/brand/mascot/chibi-blink.webp" alt="" draggable="false">
            <div class="k-chibi-fx">
                <span class="k-chibi-glint is-left">${sparkle('#fffbe8')}</span>
                <span class="k-chibi-glint is-right">${sparkle('#fffbe8')}</span>
                <span class="k-chibi-kira">${KIRA_SVG}</span>
            </div>
        </div></div>
        <span class="k-chibi-pop is-1">${sparkle('currentColor')}</span>
        <span class="k-chibi-pop is-2">${sparkle('currentColor')}</span>
        <span class="k-chibi-pop is-3">${sparkle('currentColor')}</span>`;
}

/**
 * The bubble hearth breathing: the overlay when a theme pack hides Mikan-chan.
 * @param {HTMLDivElement} spinnerElement The `#load-spinner` element to fill
 */
function fillHearthSpinner(spinnerElement) {
    const glowId = `k-loader-glow-${++loaderOverlayCounter}`;
    spinnerElement.innerHTML = `
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Loading">
            <defs>
                <radialGradient id="${glowId}" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" style="stop-color: var(--k-rose, #dca9a4)" stop-opacity="0.55" />
                    <stop offset="100%" style="stop-color: var(--k-rose, #dca9a4)" stop-opacity="0" />
                </radialGradient>
            </defs>
            <path d="M18 12 h28 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-20 l-10 8 v-8 a8 8 0 0 1 -6 -7.7 v-20.3 a8 8 0 0 1 8 -8z" fill="none" style="stroke: var(--k-accent, #9aa4d2)" stroke-width="5" stroke-linejoin="round" />
            <ellipse class="k-loader-glow" cx="32" cy="30" rx="12" ry="8" fill="url(#${glowId})" />
            <circle class="k-loader-dot" cx="32" cy="30" r="6.5" style="fill: var(--k-rose, #dca9a4)" />
        </svg>`;
}

/**
 * Creates the default loader overlay element: Star-Eyes Mikan-chan (or the bubble hearth, when
 * a pack hides her) over a cycling cozy word. Always returns a fresh element instance.
 *
 * @returns {HTMLDivElement} A new loader overlay element
 */
export function createDefaultLoaderOverlay() {
    const loaderElement = document.createElement('div');
    loaderElement.id = 'loader';

    const spinnerElement = document.createElement('div');
    spinnerElement.id = 'load-spinner';
    if (isMascotHidden()) {
        fillHearthSpinner(spinnerElement);
    } else {
        loaderElement.classList.add('k-loader--chibi');
        fillChibiSpinner(spinnerElement);
    }

    const wordElement = document.createElement('div');
    wordElement.id = 'load-word';
    let wordIndex = Math.floor(Math.random() * LOADER_WORDS.length);
    wordElement.textContent = LOADER_WORDS[wordIndex];

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const wordTimer = setInterval(() => {
        if (!wordElement.isConnected) {
            clearInterval(wordTimer);
            return;
        }
        wordIndex = (wordIndex + 1) % LOADER_WORDS.length;
        const nextWord = LOADER_WORDS[wordIndex];
        if (reducedMotion || typeof wordElement.animate !== 'function') {
            wordElement.textContent = nextWord;
            return;
        }
        // Web Animations on purpose: hideOverlay() races a transitionend listener,
        // so the crossfade must not emit transition events.
        const fadeOut = wordElement.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: LOADER_WORD_FADE_MS, easing: 'ease', fill: 'forwards' },
        );
        fadeOut.onfinish = () => {
            wordElement.textContent = nextWord;
            wordElement.animate(
                [{ opacity: 0 }, { opacity: 1 }],
                { duration: LOADER_WORD_FADE_MS, easing: 'ease', fill: 'forwards' },
            );
        };
    }, LOADER_WORD_INTERVAL_MS);

    loaderElement.appendChild(spinnerElement);
    loaderElement.appendChild(wordElement);

    return loaderElement;
}

/**
 * Normalizes custom overlay content into a value supported by Popup.
 * @param {string|HTMLElement|null} customContent - Custom overlay content
 * @returns {string|HTMLElement} Content for Popup
 */
function getOverlayContent(customContent) {
    if (typeof customContent === 'string') {
        return customContent;
    }

    if (customContent instanceof HTMLElement) {
        return customContent;
    }

    return createDefaultLoaderOverlay();
}

/**
 * Checks if the loader overlay is currently displayed.
 * @returns {boolean} True if overlay is shown
 */
function isOverlayDisplayed() {
    return !!loaderPopup;
}

/**
 * Shows the blocking loader overlay.
 * Internal function - use showActionLoader() instead.
 * @param {HTMLElement|string|null} [customContent] - Custom content for the overlay
 */
function showOverlay(customContent = null) {
    // Two loaders don't make sense. Don't await, we can overlay the old loader while it closes
    if (loaderPopup) loaderPopup.complete(POPUP_RESULT.CANCELLED);

    const content = getOverlayContent(customContent);

    loaderPopup = new Popup(content, POPUP_TYPE.DISPLAY, null, {
        allowEscapeClose: false,
        transparent: true,
        animation: 'none',
        wide: true,
        large: true,
    });

    // No close button, loaders are not closable
    loaderPopup.closeButton.style.display = 'none';

    loaderPopup.show();
}

/**
 * Hides the blocking loader overlay with animation.
 * Internal function - use hideActionLoader() instead.
 * @returns {Promise<void>}
 */
async function hideOverlay() {
    if (!loaderPopup) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        const loaderElement = $('#loader');
        const spinner = $('#load-spinner');

        if (!loaderElement.length) {
            console.warn('Loader element not found, skipping animation');
            cleanup();
            return;
        }

        // Check if transitions are enabled on spinner (which has the transition property)
        const transitionDuration = spinner.length && spinner[0] ? getComputedStyle(spinner[0]).transitionDuration : '0s';
        const hasTransitions = parseFloat(transitionDuration) > 0;

        if (hasTransitions) {
            Promise.race([
                new Promise((r) => setTimeout(r, 500)), // Fallback timeout
                new Promise((r) => loaderElement.one('transitionend webkitTransitionEnd oTransitionEnd MSTransitionEnd', r)),
            ]).finally(cleanup);
        } else {
            cleanup();
        }

        function cleanup() {
            loaderElement.remove();
            // Yoink preloader entirely; it only exists to cover up unstyled content while loading JS
            // If it's present, we remove it once and then it's gone.
            yoinkPreloader();

            loaderPopup.complete(POPUP_RESULT.AFFIRMATIVE)
                .catch((err) => console.error('Error completing loaderPopup:', err))
                .finally(() => {
                    loaderPopup = null;
                    resolve();
                });
        }

        // Apply the blur styles to the entire loader element
        loaderElement.css({
            'filter': 'blur(15px)',
            'opacity': '0',
        });
    });
}

/**
 * Removes the initial HTML preloader element.
 * Called once after the first loader hide.
 */
function yoinkPreloader() {
    if (preloaderYoinked) return;
    document.getElementById('preloader')?.remove();
    preloaderYoinked = true;
}

// ============================================================================
// End internal overlay management
// ============================================================================
