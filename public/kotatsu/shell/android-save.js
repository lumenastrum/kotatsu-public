/**
 * Saving files out of the Android app (kotatsu-public#12).
 *
 * Every export in the app (the user backup, cards, chats, presets, lorebooks, Quick Replies,
 * attachments) ends the same way: an `<a download>` pointed at a blob and clicked from script.
 * A browser turns that into a download. The APK's WebView has no downloads at all, so the click
 * did nothing and nothing was written anywhere.
 *
 * The app now exposes `window.KotatsuAndroid` (MainActivity.SaveBridge). When it is there, this
 * module takes those clicks, asks Android for its "save as" screen so the person picks the folder
 * and the name, then hands the bytes across in base64 pieces: a JavaScript bridge only carries
 * strings, and a backup can be far too large for one.
 *
 * Nothing here runs in a browser, on desktop or on a phone: no bridge, no install.
 */

/**
 * @typedef {object} AndroidSaveBridge
 * @property {(name: string, mime: string) => string} begin Opens the save screen; returns the save's id.
 * @property {(id: string, base64: string) => boolean} write Appends one piece; false when the write failed.
 * @property {(id: string) => boolean} finish Closes the file; false when it could not be completed.
 * @property {(id: string) => void} cancel Drops a half-written file.
 */

/** @typedef {'ok' | 'cancelled' | 'error'} PickResult */

/** Bytes per piece. One piece is one bridge call, held in memory twice (bytes and base64). */
export const CHUNK_BYTES = 768 * 1024;

/** How long a revoked blob stays reachable, for a save that starts just after the page let go of it. */
const REVOKE_GRACE_MS = 30_000;

/**
 * A name Android's save screen can take: the last path segment, without characters a file system refuses.
 * @param {string | null | undefined} raw The `download` attribute, or a guess from the address.
 * @returns {string}
 */
export function safeFileName(raw) {
    const last = String(raw ?? '').split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    const clean = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
    return clean || 'download';
}

/**
 * The name to save a link under: its `download` attribute, else the end of its address.
 * @param {{download?: string, href?: string}} link
 * @returns {string}
 */
export function fileNameFor(link) {
    if (link.download) return safeFileName(link.download);
    try {
        const url = new URL(link.href ?? '', 'http://localhost/');
        if (url.protocol === 'http:' || url.protocol === 'https:') return safeFileName(decodeURIComponent(url.pathname));
    } catch {
        // An address that will not parse has no name to offer.
    }
    return 'download';
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
    let binary = '';
    // fromCharCode takes its bytes as arguments, and engines cap how many arguments a call may have.
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary);
}

/**
 * Writes one blob through the bridge.
 * @param {AndroidSaveBridge} bridge
 * @param {Blob} blob
 * @param {string} name
 * @param {(id: string) => Promise<PickResult>} picked Resolves when the person leaves the save screen.
 * @returns {Promise<PickResult>}
 */
export async function writeThroughBridge(bridge, blob, name, picked) {
    const id = bridge.begin(name, blob.type || 'application/octet-stream');
    const result = await picked(id);
    if (result !== 'ok') return result;
    try {
        for (let at = 0; at < blob.size; at += CHUNK_BYTES) {
            const bytes = new Uint8Array(await blob.slice(at, at + CHUNK_BYTES).arrayBuffer());
            if (!bridge.write(id, toBase64(bytes))) throw new Error('The file could not be written.');
        }
        if (!bridge.finish(id)) throw new Error('The file could not be completed.');
        return 'ok';
    } catch (error) {
        bridge.cancel(id);
        throw error;
    }
}

/**
 * Routes `<a download>` clicks to the Android app's save screen. Does nothing without the bridge.
 * @param {Window & typeof globalThis} [win]
 * @returns {boolean} Whether the bridge was there.
 */
export function installAndroidSave(win = window) {
    /** @type {AndroidSaveBridge | undefined} */
    const bridge = /** @type {any} */ (win).KotatsuAndroid;
    if (!bridge || typeof bridge.begin !== 'function') return false;

    // Callers revoke the blob's address on the line after the click, so by the time anything
    // asynchronous looks the address up it is gone. Keep the blob itself, by address.
    /** @type {Map<string, Blob>} */
    const blobs = new Map();
    const createObjectURL = win.URL.createObjectURL.bind(win.URL);
    const revokeObjectURL = win.URL.revokeObjectURL.bind(win.URL);
    win.URL.createObjectURL = (source) => {
        const url = createObjectURL(source);
        if (source instanceof win.Blob) blobs.set(url, source);
        return url;
    };
    win.URL.revokeObjectURL = (url) => {
        revokeObjectURL(url);
        if (blobs.has(url)) win.setTimeout(() => blobs.delete(url), REVOKE_GRACE_MS);
    };

    /** @type {Map<string, (result: PickResult) => void>} */
    const waiting = new Map();
    /** @param {string} id */
    const picked = (id) => new Promise((resolve) => waiting.set(id, resolve));

    // One save screen at a time: a second export waits for the first to be answered.
    let queue = Promise.resolve();

    /**
     * @param {string} href
     * @param {string} name
     */
    const save = (href, name) => {
        // Taken now, while the address still resolves; the write itself may wait its turn.
        const source = blobs.get(href) ?? win.fetch(href).then((response) => {
            if (!response.ok) throw new Error(`The file could not be read (${response.status}).`);
            return response.blob();
        });
        queue = queue.then(async () => {
            try {
                const result = await writeThroughBridge(bridge, await source, name, picked);
                if (result === 'ok') toastr.success(name, 'Saved');
                else if (result === 'error') toastr.error('Android could not open its save screen.', 'Kotatsu');
            } catch (error) {
                console.error('[kotatsu] android save failed', error);
                toastr.error(`${name} could not be saved. See the console.`, 'Kotatsu');
            }
        });
    };

    // Script-made links: `a.click()` on an anchor that is usually not even in the page.
    const anchorClick = win.HTMLAnchorElement.prototype.click;
    win.HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download') && this.href) return save(this.href, fileNameFor(this));
        return anchorClick.call(this);
    };

    // Links a finger actually taps.
    win.document.addEventListener('click', (event) => {
        const target = event.target instanceof win.Element ? event.target.closest('a[download]') : null;
        if (!(target instanceof win.HTMLAnchorElement) || !target.href) return;
        event.preventDefault();
        save(target.href, fileNameFor(target));
    }, true);

    /** The app's side of the conversation: MainActivity calls these. */
    /** @type {any} */ (win).__kotatsuAndroidSave = {
        /**
         * The person left the save screen.
         * @param {string} id
         * @param {PickResult} result
         */
        picked(id, result) {
            waiting.get(id)?.(result);
            waiting.delete(id);
        },
        /**
         * A download reached the WebView by a road the two hooks above do not cover.
         * @param {string} url
         * @param {string} name
         */
        fromUrl(url, name) {
            save(url, safeFileName(name));
        },
    };

    return true;
}
