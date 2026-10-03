/**
 * Phone card view-model: pure state derivation (docs/phone-v0.md §4.2).
 *
 * `/api/kotatsu/phone/status` plus a little local UI state in, everything the card needs to draw
 * out. No DOM, no fetch, no clock of its own: `now` is a parameter, so Jest covers every branch.
 */

/**
 * @typedef {object} PhoneAddress
 * @property {string} address
 * @property {'IPv4'|'IPv6'} family
 * @property {string} iface
 * @property {'lan'|'tailscale'|'vpn'|'virtual'|'other'} kind
 * @property {boolean} preferred
 * @property {'Private'|'Public'|'DomainAuthenticated'} [networkCategory]
 */

/**
 * @typedef {object} PhoneDevice
 * @property {string} id
 * @property {string} ip
 * @property {string} label
 * @property {string} pairedAt
 * @property {string} lastSeenAt
 */

/**
 * @typedef {object} PhoneStatus
 * @property {'computer'|'paired'|'other'} viewer
 * @property {string|null} viewerIp
 * @property {{ effective: boolean, configured: boolean, lockedBy: null|'cli'|'env', pendingRestart: boolean }} listen
 * @property {{ effective: boolean, configured: boolean }} hostWhitelist
 * @property {boolean} supervised
 * @property {'http'|'https'} scheme
 * @property {number|null} port
 * @property {string} pairPath
 * @property {PhoneAddress[]} addresses
 * @property {PhoneDevice[]} paired
 * @property {{ live: number, lastPaired: null | { id: string, label: string, at: string } }} pairing
 */

/**
 * @typedef {object} PhoneUi
 * @property {'home'|'anywhere'} [tab] The QR tab the person picked.
 * @property {string|null} [lanPick] A LAN address the person picked (remembered in localStorage).
 */

/** @typedef {'home'|'anywhere'} QrTab */

export const LOCK_TEXT = Object.freeze({
    cli: 'Set by a launch flag',
    env: 'Set by an environment variable',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "3 Oct", or "3 Oct 2025" when it isn't this year. Local time, like every other date on screen.
 * @param {string} iso
 * @param {number} now Epoch ms.
 * @returns {string} '' for an unreadable date.
 */
export function formatPairedDate(iso, now) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const base = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
    return date.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

/**
 * "just now", "2 min ago", "3 hours ago", "yesterday", "5 days ago", then the date.
 * @param {string} iso
 * @param {number} now Epoch ms.
 * @returns {string} '' for an unreadable time.
 */
export function formatLastSeen(iso, now) {
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return '';
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 14) return `${days} days ago`;
    return formatPairedDate(iso, now);
}

/**
 * @param {PhoneAddress[]} addresses
 * @param {'lan'|'tailscale'} kind
 * @returns {PhoneAddress[]} The IPv4 entries of a kind. IPv6 is never offered in v0.
 */
export function ipv4Of(addresses, kind) {
    return (addresses ?? []).filter(entry => entry.kind === kind && entry.family === 'IPv4');
}

/**
 * The address a QR carries: the person's pick when it's still a candidate, else the server's
 * preferred one, else the first.
 * @param {PhoneAddress[]} candidates
 * @param {string|null|undefined} pick
 * @returns {PhoneAddress|null}
 */
export function chooseAddress(candidates, pick) {
    if (!candidates.length) return null;
    return candidates.find(entry => entry.address === pick)
        ?? candidates.find(entry => entry.preferred)
        ?? candidates[0];
}

/**
 * The URL a QR carries.
 * @param {Pick<PhoneStatus, 'scheme'|'port'>} status
 * @param {PhoneAddress} address
 * @param {string} path The `path` the server minted (`/k-pair?t=…`).
 * @returns {string}
 */
export function buildPairUrl(status, address, path) {
    return `${status.scheme}://${address.address}:${status.port}${path}`;
}

/**
 * The first device in `paired` that wasn't there when the QR opened.
 * @param {ReadonlySet<string>|readonly string[]} baselineIds
 * @param {PhoneDevice[]} paired
 * @returns {PhoneDevice|null}
 */
export function findNewDevice(baselineIds, paired) {
    const known = baselineIds instanceof Set ? baselineIds : new Set(baselineIds);
    return (paired ?? []).find(device => !known.has(device.id)) ?? null;
}

/**
 * @typedef {object} PhoneView
 * @property {'loading'|'viewer'|'manage'} mode `viewer` is a paired phone (or a stranger) looking in.
 * @property {'locked'|'off'|'restart'|'on'|null} state Precedence: locked, off, restart, on.
 * @property {{ visible: boolean, on: boolean, disabled: boolean }} toggle
 * @property {string|null} lockText
 * @property {{ show: boolean, canRestart: boolean, text: string }} restart
 * @property {string} offText
 * @property {boolean} canPair A QR can be minted: listening now, on a computer.
 * @property {{ id: QrTab, label: string }[]} tabs Empty unless a Tailscale address exists.
 * @property {QrTab} tab
 * @property {PhoneAddress[]} candidates The addresses the active tab can use.
 * @property {boolean} showPicker More than one candidate.
 * @property {PhoneAddress|null} address
 * @property {boolean} noAddress The active tab has nothing to put in a QR.
 * @property {boolean} anywhereNote Tailscale tab: the phone needs Tailscale too.
 * @property {boolean} publicWarning
 * @property {boolean} windowsNote
 * @property {string} viewerText
 * @property {boolean} canForget
 * @property {{ id: string, label: string, pairedText: string, lastSeenText: string, thisDevice: boolean }[]} devices
 * @property {string} emptyText
 */

/**
 * Everything the card shows.
 * @param {PhoneStatus|null|undefined} status
 * @param {PhoneUi} [ui]
 * @param {number} [now]
 * @returns {PhoneView}
 */
export function deriveView(status, ui = {}, now = Date.now()) {
    /** @type {PhoneView} */
    const view = {
        mode: 'loading',
        state: null,
        toggle: { visible: false, on: false, disabled: true },
        lockText: null,
        restart: { show: false, canRestart: false, text: '' },
        offText: 'Turn this on to reach Kotatsu from your phone. Only devices you pair with a code can connect.',
        canPair: false,
        tabs: [],
        tab: 'home',
        candidates: [],
        showPicker: false,
        address: null,
        noAddress: false,
        anywhereNote: false,
        publicWarning: false,
        windowsNote: false,
        viewerText: '',
        canForget: false,
        devices: [],
        emptyText: 'No phones yet.',
    };
    if (!status) return view;

    const isComputer = status.viewer === 'computer';
    const paired = Array.isArray(status.paired) ? status.paired : [];
    view.devices = paired.map(device => ({
        id: device.id,
        label: device.label,
        pairedText: `paired ${formatPairedDate(device.pairedAt, now)}`.trim(),
        lastSeenText: device.lastSeenAt ? `last seen ${formatLastSeen(device.lastSeenAt, now)}`.trim() : '',
        thisDevice: !isComputer && Boolean(status.viewerIp) && device.ip === status.viewerIp,
    }));

    if (!isComputer) {
        view.mode = 'viewer';
        view.viewerText = status.viewer === 'paired'
            ? 'You’re on a paired device. Manage phone access on the computer Kotatsu runs on.'
            : 'Manage phone access on the computer Kotatsu runs on.';
        return view;
    }

    view.mode = 'manage';
    view.canForget = true;
    const { effective, configured, lockedBy } = status.listen;
    view.toggle = { visible: true, on: lockedBy ? effective : configured, disabled: Boolean(lockedBy) };

    if (lockedBy) {
        view.state = 'locked';
        view.lockText = LOCK_TEXT[lockedBy] ?? LOCK_TEXT.env;
    } else if (!configured && !effective) {
        view.state = 'off';
    } else if (configured !== effective) {
        view.state = 'restart';
        view.restart = {
            show: true,
            canRestart: Boolean(status.supervised),
            text: status.supervised ? '' : 'Close Kotatsu and start it again to finish.',
        };
    } else {
        view.state = 'on';
    }

    // Locked still pairs while Kotatsu is actually listening; every other state needs "on".
    view.canPair = effective && (view.state === 'on' || view.state === 'locked');
    if (!view.canPair) return view;

    const home = ipv4Of(status.addresses, 'lan');
    const anywhere = ipv4Of(status.addresses, 'tailscale');
    if (anywhere.length) {
        view.tabs = [
            { id: 'home', label: 'At home' },
            { id: 'anywhere', label: 'Anywhere' },
        ];
    }
    /** @type {QrTab} */
    let tab = ui.tab === 'anywhere' ? 'anywhere' : 'home';
    if (tab === 'anywhere' && !anywhere.length) tab = 'home';
    if (tab === 'home' && !home.length && anywhere.length) tab = 'anywhere';
    view.tab = tab;
    view.candidates = tab === 'anywhere' ? anywhere : home;
    view.showPicker = view.candidates.length > 1;
    view.address = chooseAddress(view.candidates, tab === 'home' ? ui.lanPick : null);
    view.noAddress = !view.address;
    view.anywhereNote = tab === 'anywhere' && Boolean(view.address);
    view.publicWarning = view.address?.networkCategory === 'Public';
    view.windowsNote = paired.length === 0;
    return view;
}
