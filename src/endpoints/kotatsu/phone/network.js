import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import os from 'node:os';

import ipaddr from 'ipaddr.js';

/**
 * Which of this machine's addresses a phone should be sent to (docs/phone-v0.md §3.4).
 *
 * A VPN adapter can sit in a private range exactly like the home network (NordLynx `10.5.0.2/16`
 * beside Ethernet `192.168.1.10/24` on the box this was built on), so "the first private address"
 * picks wrong whenever the VPN is up. Addresses are classified by range and adapter name, and the
 * LAN address the OS actually routes outbound traffic from wins.
 */

/** @typedef {'lan'|'tailscale'|'vpn'|'virtual'|'other'} AddressKind */
/**
 * @typedef {object} MachineAddress
 * @property {string} address
 * @property {'IPv4'|'IPv6'} family
 * @property {string} iface Adapter name as the OS reports it
 * @property {AddressKind} kind
 * @property {boolean} preferred The one to put in a QR for its kind
 * @property {string} [networkCategory] Windows only: Private, Public or DomainAuthenticated
 */

const TAILSCALE_NAME = /tailscale/i;
const VPN_NAME = /nordlynx|wireguard|\bwg\d|\btun\d*\b|\btap\b|utun|openvpn|proton|mullvad|expressvpn|zerotier|surfshark|vpn/i;
const VIRTUAL_NAME = /vEthernet|\bWSL\b|hyper-v|docker|vbox|virtualbox|vmware|\bveth|^br-|loopback/i;

/**
 * Classifies one address. Pure.
 * @param {string} iface Adapter name
 * @param {string} address
 * @returns {AddressKind}
 */
export function classifyAddress(iface, address) {
    let parsed;
    try {
        parsed = ipaddr.parse(address);
    } catch {
        return 'other';
    }
    const range = parsed.range();
    if (TAILSCALE_NAME.test(iface) || (parsed.kind() === 'ipv4' && range === 'carrierGradeNat')) return 'tailscale';
    if (range === 'loopback') return 'virtual';
    if (range === 'linkLocal') return 'other';
    if (VPN_NAME.test(iface)) return 'vpn';
    if (VIRTUAL_NAME.test(iface)) return 'virtual';
    if (parsed.kind() === 'ipv4' && range === 'private') return 'lan';
    return 'other';
}

/**
 * The machine's non-internal addresses, classified. Pure over its input.
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces]
 * @returns {MachineAddress[]}
 */
export function listAddresses(interfaces = os.networkInterfaces()) {
    /** @type {MachineAddress[]} */
    const out = [];
    for (const [iface, infos] of Object.entries(interfaces)) {
        for (const info of infos ?? []) {
            if (info.internal) continue;
            const family = info.family === 'IPv6' || /** @type {any} */ (info.family) === 6 ? 'IPv6' : 'IPv4';
            out.push({ address: info.address, family, iface, kind: classifyAddress(iface, info.address), preferred: false });
        }
    }
    return out;
}

/**
 * Marks the one address per kind a QR should carry. IPv4 only: phones on home Wi-Fi reach IPv4,
 * and a ULA / link-local IPv6 in a QR is a support burden. Pure.
 * @param {MachineAddress[]} addresses
 * @param {string|null} outbound The address the OS routes outbound traffic from, if known
 * @returns {MachineAddress[]}
 */
export function markPreferred(addresses, outbound) {
    const result = addresses.map(entry => ({ ...entry, preferred: false }));
    for (const kind of /** @type {AddressKind[]} */ (['lan', 'tailscale'])) {
        const candidates = result.filter(entry => entry.kind === kind && entry.family === 'IPv4');
        const pick = candidates.find(entry => entry.address === outbound) ?? candidates[0];
        if (pick) pick.preferred = true;
    }
    return result;
}

/**
 * The local address the OS would send outbound traffic from. A UDP `connect()` only picks a route;
 * no packet leaves the machine. `192.0.2.1` is TEST-NET-1, never a real host.
 * @returns {Promise<string|null>}
 */
export function outboundAddress() {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        const done = (/** @type {string|null} */ value) => {
            try { socket.close(); } catch { /* already closed */ }
            resolve(value);
        };
        socket.once('error', () => done(null));
        try {
            socket.connect(9, '192.0.2.1', () => {
                try {
                    done(socket.address().address);
                } catch {
                    done(null);
                }
            });
        } catch {
            done(null);
        }
    });
}

const CATEGORY_TTL_MS = 30_000;
/** @type {{ at: number, value: Map<string, string> } | null} */
let categoryCache = null;

/**
 * Parses `Get-NetConnectionProfile | ConvertTo-Json` output into adapter → category. Pure.
 * `NetworkCategory` arrives as a number (0 Public, 1 Private, 2 DomainAuthenticated) or a name.
 * @param {string} json
 * @returns {Map<string, string>}
 */
export function parseConnectionProfiles(json) {
    const names = ['Public', 'Private', 'DomainAuthenticated'];
    /** @type {Map<string, string>} */
    const map = new Map();
    let data;
    try {
        data = JSON.parse(json);
    } catch {
        return map;
    }
    for (const entry of Array.isArray(data) ? data : [data]) {
        if (!entry || typeof entry.InterfaceAlias !== 'string') continue;
        const raw = entry.NetworkCategory;
        const category = typeof raw === 'number' ? names[raw] : typeof raw === 'string' ? raw : undefined;
        if (category) map.set(entry.InterfaceAlias, category);
    }
    return map;
}

/**
 * Windows only: each connected adapter's network category. Read-only — Kotatsu never changes
 * network or firewall settings. Cached; any failure resolves to an empty map.
 * @returns {Promise<Map<string, string>>}
 */
export function windowsNetworkCategories() {
    if (process.platform !== 'win32') return Promise.resolve(new Map());
    if (categoryCache && Date.now() - categoryCache.at < CATEGORY_TTL_MS) return Promise.resolve(categoryCache.value);
    return new Promise((resolve) => {
        childProcess.execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress'],
            { shell: false, encoding: 'utf8', timeout: 8000, windowsHide: true },
            (error, stdout) => {
                const value = error ? new Map() : parseConnectionProfiles(stdout);
                categoryCache = { at: Date.now(), value };
                resolve(value);
            },
        );
    });
}

/**
 * Everything the phone card needs to know about this machine's addresses.
 * @returns {Promise<MachineAddress[]>}
 */
export async function describeAddresses() {
    const [outbound, categories] = await Promise.all([outboundAddress(), windowsNetworkCategories()]);
    return markPreferred(listAddresses(), outbound).map(entry => {
        const networkCategory = categories.get(entry.iface);
        return networkCategory ? { ...entry, networkCategory } : entry;
    });
}
