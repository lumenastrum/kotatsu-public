import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

/**
 * Phones paired by scanning a QR on the computer (docs/phone-v0.md §3.1). One file under
 * `DATA_ROOT/.kotatsu/`, mirrored by an in-memory set so the whitelist's per-request check is a
 * lookup, never a disk read.
 */

/**
 * @typedef {object} PairedDevice
 * @property {string} id
 * @property {string} ip The socket address it paired from
 * @property {string} label e.g. "iPhone · Safari"
 * @property {string} pairedAt ISO time
 * @property {string} lastSeenAt ISO time
 */

const FILE_VERSION = 1;
const SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * Reduces a User-Agent to a device and a browser. Never keeps the raw string. Pure.
 * @param {string|undefined} userAgent
 * @returns {string}
 */
export function deviceLabel(userAgent) {
    const ua = String(userAgent ?? '');
    const device = /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) ? 'iPad'
            : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
                : /Windows/.test(ua) ? 'Windows'
                    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
                        : /CrOS/.test(ua) ? 'Chromebook'
                            : /Linux/.test(ua) ? 'Linux'
                                : 'Device';
    const browser = /EdgA?\/|EdgiOS/.test(ua) ? 'Edge'
        : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
            : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
                : /OPR\/|OPiOS/.test(ua) ? 'Opera'
                    : /CriOS|Chrome\//.test(ua) ? 'Chrome'
                        : /Safari\//.test(ua) ? 'Safari'
                            : '';
    return browser ? `${device} · ${browser}` : device;
}

/**
 * The paired-device store for one data root.
 */
export class PairedStore {
    /** @type {string} */
    #file;
    /** @type {PairedDevice[]} */
    #devices = [];
    /** @type {Set<string>} */
    #ips = new Set();
    /** @type {Map<string, number>} */
    #seenWrittenAt = new Map();

    /**
     * @param {string} dataRoot
     */
    constructor(dataRoot) {
        this.#file = path.join(dataRoot, '.kotatsu', 'paired-devices.json');
        this.#load();
    }

    #load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
            const devices = Array.isArray(data?.devices) ? data.devices : [];
            this.#devices = devices.filter(device => device && typeof device.ip === 'string' && typeof device.id === 'string');
        } catch {
            this.#devices = [];
        }
        this.#reindex();
    }

    #reindex() {
        this.#ips = new Set(this.#devices.map(device => device.ip));
    }

    #save() {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
        writeFileAtomicSync(this.#file, JSON.stringify({ version: FILE_VERSION, devices: this.#devices }, null, 4), 'utf8');
    }

    /**
     * @param {string} ip
     * @returns {boolean}
     */
    has(ip) {
        return this.#ips.has(ip);
    }

    /**
     * @returns {PairedDevice[]}
     */
    list() {
        return this.#devices.map(device => ({ ...device }));
    }

    /**
     * Pairs an IP. A device that paired from the same IP before is replaced, not duplicated.
     * @param {string} ip
     * @param {string|undefined} userAgent
     * @param {Date} [now]
     * @returns {PairedDevice}
     */
    add(ip, userAgent, now = new Date()) {
        const at = now.toISOString();
        /** @type {PairedDevice} */
        const device = { id: crypto.randomUUID(), ip, label: deviceLabel(userAgent), pairedAt: at, lastSeenAt: at };
        this.#devices = [...this.#devices.filter(existing => existing.ip !== ip), device];
        this.#reindex();
        this.#save();
        return { ...device };
    }

    /**
     * @param {string} id
     * @returns {boolean} Whether a device was removed
     */
    forget(id) {
        const before = this.#devices.length;
        this.#devices = this.#devices.filter(device => device.id !== id);
        if (this.#devices.length === before) return false;
        this.#reindex();
        this.#save();
        return true;
    }

    /**
     * Records that a paired IP made a request. Written at most once a minute per device.
     * @param {string} ip
     * @param {Date} [now]
     * @returns {void}
     */
    touch(ip, now = new Date()) {
        const device = this.#devices.find(entry => entry.ip === ip);
        if (!device) return;
        device.lastSeenAt = now.toISOString();
        const last = this.#seenWrittenAt.get(ip) ?? 0;
        if (now.getTime() - last < SEEN_WRITE_INTERVAL_MS) return;
        this.#seenWrittenAt.set(ip, now.getTime());
        try {
            this.#save();
        } catch {
            // lastSeenAt is a courtesy; a failed write must never fail the request it rode on.
        }
    }
}
