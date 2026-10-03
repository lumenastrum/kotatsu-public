/**
 * `<k-phone-card variant="settings">` — use Kotatsu on your phone (docs/phone-v0.md §4.2).
 *
 * One switch, one scan. The card shows the LAN switch (or why it can't move), the pairing QR while
 * Kotatsu is listening, and the phones already paired. All of its state comes from
 * `/api/kotatsu/phone/status` through {@link PhoneStore}; what to draw is decided by the pure
 * `deriveView` in view-model.js, so this file is markup and wiring.
 *
 * Light DOM (css/phone-card.css paints it) with its own `k-ph__*` classes: the settings modal's
 * control rules (`.k-set-control select/input/.menu_button/small`) reach into light DOM, so the
 * card uses none of those elements. `variant` per SPEC §13 (v0 has one: "settings").
 *
 * A pairing session (a minted code and the 2 s poll) runs only while the card is on screen and a
 * QR can be shown; the store owns the timers, this element only decides when one is wanted.
 */

import { LitElement, html, nothing, svg } from '../shell/lit.js';
import { getRequestHeaders } from '../../script.js';
import { restartAndWait } from '../shell/restart.js';
import { line } from '../brand/mascot/lines.js';
import { qrSvg } from './qr.js';
import { PhoneStore } from './store.js';
import { buildPairUrl, deriveView } from './view-model.js';

const LAN_PICK_KEY = 'kotatsu.phone.lanPick';

/** House icon recipe: viewBox 24, stroke currentColor, 1.5. */
const svgIcon = (/** @type {unknown} */ paths) => html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const icons = {
    phone: svgIcon(svg`<rect x="7" y="2.5" width="10" height="19" rx="2.2"></rect><path d="M11 18.5h2"></path>`),
    check: svgIcon(svg`<path d="m5 12.5 4.5 4.5L19 7.5"></path>`),
    warning: svgIcon(svg`<path d="M12 4 2.8 19.5h18.4L12 4Z"></path><path d="M12 10v4.2M12 17h.01"></path>`),
    info: svgIcon(svg`<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path>`),
};

/**
 * Whether the active theme pack hides Mikan-chan (`--k-mascot-display: none`, docs/brand.md).
 * @returns {boolean}
 */
function isMascotHidden() {
    try {
        return getComputedStyle(document.documentElement).getPropertyValue('--k-mascot-display').trim() === 'none';
    } catch {
        return false;
    }
}

/** @returns {string|null} */
function readLanPick() {
    try {
        return localStorage.getItem(LAN_PICK_KEY);
    } catch {
        return null;
    }
}

/** @param {string} value */
function writeLanPick(value) {
    try {
        localStorage.setItem(LAN_PICK_KEY, value);
    } catch {
        // Storage refused: the pick lasts until the card is rebuilt.
    }
}

export class KPhoneCard extends LitElement {
    static properties = {
        variant: { type: String, reflect: true },
        _state: { state: true },
        _tab: { state: true },
        _lanPick: { state: true },
        _restart: { state: true },
        _restartError: { state: true },
        _copied: { state: true },
    };

    constructor() {
        super();
        this.variant = 'settings';
        this._store = new PhoneStore({ getHeaders: () => getRequestHeaders() });
        this._state = this._store.state;
        /** @type {'home'|'anywhere'} */
        this._tab = 'home';
        /** @type {string|null} */
        this._lanPick = readLanPick();
        /** @type {''|'restarting'|'waiting'|'reloading'} */
        this._restart = '';
        this._restartError = '';
        this._copied = false;
        this._visible = false;
        this._wasWanted = false;
        this._unsubscribe = () => { };
        /** @type {IntersectionObserver|null} */
        this._observer = null;
    }

    createRenderRoot() {
        return this;
    }

    connectedCallback() {
        super.connectedCallback();
        if (!this.hasAttribute('variant')) this.setAttribute('variant', this.variant);
        this._unsubscribe = this._store.subscribe((state) => {
            this._state = state;
            this._reconcile();
        });
        if (typeof IntersectionObserver === 'function') {
            this._observer = new IntersectionObserver((entries) => {
                const visible = entries.some(entry => entry.isIntersecting);
                if (visible === this._visible) return;
                this._visible = visible;
                if (visible) void this._store.refresh();
                this._reconcile();
            });
            this._observer.observe(this);
        } else {
            this._visible = true;
        }
        void this._store.refresh();
    }

    disconnectedCallback() {
        this._observer?.disconnect();
        this._unsubscribe();
        this._store.closePairing();
        this._wasWanted = false;
        super.disconnectedCallback();
    }

    /** @returns {import('./view-model.js').PhoneView} */
    _view() {
        return deriveView(this._state.status, { tab: this._tab, lanPick: this._lanPick });
    }

    /**
     * Opens or closes the pairing session when "a QR is showing" changes. Edge-triggered, so a
     * failed mint doesn't retry on every state change (the card offers Try again instead).
     */
    _reconcile() {
        const view = this._view();
        const wanted = this._visible && view.canPair && !view.noAddress && !this._state.justPaired && !this._restart;
        if (wanted && !this._wasWanted) void this._store.openPairing();
        if (!wanted && this._wasWanted) this._store.closePairing();
        this._wasWanted = wanted;
    }

    async _toggle() {
        const view = this._view();
        await this._store.setLan(!view.toggle.on);
        this._reconcile();
    }

    async _restartNow() {
        this._restartError = '';
        const result = await restartAndWait({
            onState: (state, detail) => {
                if (state === 'failed') {
                    this._restart = '';
                    this._restartError = detail === 'timeout'
                        ? 'Kotatsu didn’t come back. Start it again from the window or terminal you launched it in.'
                        : `Couldn’t restart Kotatsu: ${detail ?? 'unknown error'}.`;
                } else {
                    this._restart = state;
                }
            },
        });
        if (result === 'failed') this._reconcile();
    }

    /** @param {'home'|'anywhere'} tab */
    _pickTab(tab) {
        this._tab = tab;
    }

    /** @param {string} address */
    _pickLan(address) {
        this._lanPick = address;
        writeLanPick(address);
    }

    /** @param {string} url */
    async _copyUrl(url) {
        try {
            await navigator.clipboard.writeText(url);
            this._copied = true;
            setTimeout(() => { this._copied = false; }, 1800);
        } catch {
            // Clipboard needs a secure context; the URL is on screen as selectable text.
        }
    }

    _pairAnother() {
        this._store.clearJustPaired();
        this._wasWanted = false;
        this._reconcile();
    }

    /** @param {import('./view-model.js').PhoneView} view */
    _switch(view) {
        const busy = this._state.busy === 'lan';
        let hint = '';
        if (view.state === 'locked') hint = view.lockText ?? '';
        else if (view.state === 'off') hint = view.offText;
        else if (view.state === 'restart') hint = view.toggle.on ? 'Saved. Kotatsu starts listening after a restart.' : 'Saved. Kotatsu stops listening after a restart.';
        else hint = 'Kotatsu is listening on your network. Only phones you pair can connect.';
        return html`
            <div class="k-ph__switchrow">
                <button type="button" id="k-phone-switch" class="k-ph__switch" role="switch"
                    aria-checked=${view.toggle.on ? 'true' : 'false'} aria-describedby="k-phone-switch-hint"
                    ?disabled=${view.toggle.disabled || busy} @click=${() => this._toggle()}>
                    <span class="k-ph__track" aria-hidden="true"><span class="k-ph__thumb"></span></span>
                    <span class="k-ph__switchlabel">Let phones connect over your network</span>
                </button>
                <p class="k-ph__hint" id="k-phone-switch-hint" data-lock=${view.state === 'locked' ? 'true' : 'false'}>${busy ? 'Saving…' : hint}</p>
            </div>`;
    }

    /** @param {import('./view-model.js').PhoneView} view */
    _restartOffer(view) {
        if (!view.restart.show) return nothing;
        const turningOn = view.toggle.on;
        const busyText = {
            restarting: 'Restarting…',
            waiting: 'Waiting for Kotatsu to come back…',
            reloading: 'Reloading…',
        }[this._restart] ?? '';
        return html`
            <div class="k-ph__notice" data-tone="info" id="k-phone-restart">
                <span class="k-ph__noticeicon">${icons.info}</span>
                <div class="k-ph__noticebody">
                    <strong>${turningOn ? 'Restart Kotatsu to start listening' : 'Restart Kotatsu to stop listening'}</strong>
                    ${view.restart.canRestart
        ? html`<div class="k-ph__actions">
                            <button type="button" class="k-ph__btn k-ph__btn--primary" id="k-phone-restart-now"
                                ?disabled=${Boolean(this._restart)} @click=${() => this._restartNow()}>${busyText || 'Restart now'}</button>
                            <span class="k-ph__muted">Your chats are saved.</span>
                        </div>`
        : html`<p>${view.restart.text}</p>`}
                    ${this._restartError ? html`<p class="k-ph__error" role="alert">${this._restartError}</p>` : nothing}
                </div>
            </div>`;
    }

    /** @param {import('./view-model.js').PhoneView} view */
    _qrPanel(view) {
        const state = this._state;
        const status = state.status;
        if (!status) return nothing;
        if (state.justPaired) {
            const device = state.justPaired.label;
            const mascot = isMascotHidden() ? nothing : html`<span class="k-ph__mascot"><img src="kotatsu/brand/mascot/ready-bust.webp" alt="" draggable="false"></span>`;
            return html`
                <div class="k-ph__success" role="status" id="k-phone-success">
                    ${mascot}
                    <div class="k-ph__successbody">
                        <strong><span class="k-ph__ok">${icons.check}</span>${device} is connected.</strong>
                        <p class="k-ph__say">${line('phonePaired', { device })}</p>
                        <div class="k-ph__actions">
                            <button type="button" class="k-ph__btn" id="k-phone-another" @click=${() => this._pairAnother()}>Pair another phone</button>
                        </div>
                    </div>
                </div>`;
        }
        if (view.noAddress) {
            return html`<p class="k-ph__hint">${view.tab === 'anywhere'
                ? 'No Tailscale address found on this computer.'
                : 'No Wi-Fi or Ethernet address found on this computer. Connect to a network, then reopen this.'}</p>`;
        }
        const code = state.pair;
        const address = /** @type {import('./view-model.js').PhoneAddress} */ (view.address);
        const url = code ? buildPairUrl(status, address, code.path) : '';
        return html`
            <div class="k-ph__pair" id="k-phone-pair">
                ${view.tabs.length
        ? html`<div class="k-ph__tabs" role="tablist" aria-label="Where your phone is">
                        ${view.tabs.map(tab => html`
                            <button type="button" role="tab" class="k-ph__tab" id=${`k-phone-tab-${tab.id}`}
                                aria-selected=${view.tab === tab.id ? 'true' : 'false'}
                                @click=${() => this._pickTab(tab.id)}>${tab.label}</button>`)}
                    </div>`
        : nothing}
                ${view.showPicker
        ? html`<div class="k-ph__picker" role="radiogroup" aria-label="Network">
                        ${view.candidates.map(entry => html`
                            <button type="button" role="radio" class="k-ph__chip" aria-checked=${entry.address === address.address ? 'true' : 'false'}
                                @click=${() => this._pickLan(entry.address)}>${entry.address}<span class="k-ph__chipnote">${entry.iface}</span></button>`)}
                    </div>`
        : nothing}
                ${view.publicWarning
        ? html`<div class="k-ph__notice" data-tone="warning" id="k-phone-public">
                        <span class="k-ph__noticeicon">${icons.warning}</span>
                        <div class="k-ph__noticebody"><p>Windows treats this network as public, so it will probably block your phone. Switch the network to private in Windows settings.</p></div>
                    </div>`
        : nothing}
                ${view.anywhereNote ? html`<p class="k-ph__hint">Your phone needs Tailscale on, signed in to the same tailnet.</p>` : nothing}
                <div class="k-ph__qrwrap">
                    ${code
        ? html`<div class="k-ph__qrbox" id="k-phone-qr">${qrSvg(url, { ecc: 'M', quietZone: 4, label: `QR code to pair a phone with Kotatsu at ${address.address}` })}</div>`
        : html`<div class="k-ph__qrbox k-ph__qrbox--empty" aria-busy="true">${state.error ? '' : 'Making a code…'}</div>`}
                    <div class="k-ph__qrside">
                        ${code
        ? html`<p class="k-ph__url" id="k-phone-url" data-testid="k-phone-url">${url}</p>
                            <div class="k-ph__actions">
                                <button type="button" class="k-ph__btn k-ph__btn--small" @click=${() => this._copyUrl(url)}>${this._copied ? 'Copied' : 'Copy link'}</button>
                            </div>`
        : html`<div class="k-ph__actions"><button type="button" class="k-ph__btn k-ph__btn--small" @click=${() => this._store.openPairing()}>Try again</button></div>`}
                        <p class="k-ph__hint">Scan with your phone’s camera. The code works once and expires in 5 minutes.</p>
                        ${view.windowsNote ? html`<p class="k-ph__hint" id="k-phone-windows">If Windows asks whether Node.js may use the network, allow it on private networks.</p>` : nothing}
                    </div>
                </div>
            </div>`;
    }

    /** @param {import('./view-model.js').PhoneView} view */
    _devices(view) {
        const forgetting = this._state.busy === 'forget';
        return html`
            <div class="k-ph__devices" id="k-phone-devices">
                <h4 class="k-ph__subhead">Paired phones</h4>
                ${view.devices.length
        ? html`<ul class="k-ph__list">
                        ${view.devices.map(device => html`
                            <li class="k-ph__device" data-device-id=${device.id}>
                                <span class="k-ph__deviceicon">${icons.phone}</span>
                                <span class="k-ph__devicebody">
                                    <span class="k-ph__devicename">${device.label}${device.thisDevice ? html`<span class="k-ph__badge">this device</span>` : nothing}</span>
                                    <span class="k-ph__devicemeta">${[device.pairedText, device.lastSeenText].filter(Boolean).join(' · ')}</span>
                                </span>
                                ${view.canForget
        ? html`<button type="button" class="k-ph__btn k-ph__btn--small k-ph__btn--danger" ?disabled=${forgetting}
                                        aria-label=${`Forget ${device.label}`} @click=${() => this._store.forget(device.id)}>Forget</button>`
        : nothing}
                            </li>`)}
                    </ul>`
        : html`<p class="k-ph__hint">${view.emptyText}</p>`}
            </div>`;
    }

    render() {
        const view = this._view();
        const error = this._state.error;
        if (view.mode === 'loading') {
            return html`<section class="k-ph" data-variant=${this.variant} data-mode="loading" aria-label="Phone access">
                <p class="k-ph__hint">${error || 'Checking phone access…'}</p>
            </section>`;
        }
        if (view.mode === 'viewer') {
            return html`<section class="k-ph" data-variant=${this.variant} data-mode="viewer" aria-label="Phone access">
                <p class="k-ph__lead">${view.viewerText}</p>
                ${view.devices.length ? this._devices(view) : nothing}
            </section>`;
        }
        return html`<section class="k-ph" data-variant=${this.variant} data-mode="manage" data-state=${view.state ?? ''} aria-label="Phone access">
            ${this._switch(view)}
            ${this._restartOffer(view)}
            ${view.canPair ? this._qrPanel(view) : nothing}
            ${error ? html`<p class="k-ph__error" role="alert" id="k-phone-error">${error}</p>` : nothing}
            ${view.state === 'off' || view.state === 'restart' ? (view.devices.length ? this._devices(view) : nothing) : this._devices(view)}
        </section>`;
    }
}

if (!customElements.get('k-phone-card')) {
    customElements.define('k-phone-card', KPhoneCard);
}
