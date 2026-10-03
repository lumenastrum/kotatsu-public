/**
 * QR facade (docs/phone-v0.md §4.3). The single import point for `qrcode-generator` in Kotatsu
 * code: it rides the vendor bundle (public/lib.js → dist/lib.js), never a CDN.
 *
 * The output is ALWAYS black on white, whatever the theme pack: a phone camera wants contrast, and
 * Natsumikan cream or Blue Hour navy can't be trusted to supply it. The quiet zone is part of the
 * image for the same reason (a QR on a dark card with no white margin does not scan).
 */

import { html } from '../shell/lit.js';
import { qrcode } from '../../lib.js';

/** @typedef {{ ecc?: 'L'|'M'|'Q'|'H', quietZone?: number }} QrOptions */

/**
 * The dark modules as one SVG path, merged into horizontal runs. Pure but for the encoder.
 * @param {string} text What the code says.
 * @param {QrOptions} [options]
 * @returns {{ size: number, d: string, modules: number }} `size` includes the quiet zone.
 */
export function qrPath(text, { ecc = 'M', quietZone = 4 } = {}) {
    const code = qrcode(0, ecc);
    code.addData(text);
    code.make();
    const modules = code.getModuleCount();
    let d = '';
    for (let row = 0; row < modules; row++) {
        let col = 0;
        while (col < modules) {
            if (!code.isDark(row, col)) {
                col++;
                continue;
            }
            const start = col;
            while (col < modules && code.isDark(row, col)) col++;
            d += `M${start + quietZone} ${row + quietZone}h${col - start}v1h-${col - start}z`;
        }
    }
    return { size: modules + quietZone * 2, d, modules };
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The QR as an SVG string.
 * @param {string} text
 * @param {QrOptions & { label?: string }} [options]
 * @returns {string}
 */
export function qrSvgString(text, options = {}) {
    const { size, d } = qrPath(text, options);
    const label = escapeAttribute(options.label ?? 'QR code');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/**
 * The QR as a Lit template.
 * @param {string} text
 * @param {QrOptions & { label?: string }} [options]
 * @returns {unknown}
 */
export function qrSvg(text, options = {}) {
    const { size, d } = qrPath(text, options);
    return html`<svg class="k-ph__qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label=${options.label ?? 'QR code'}><rect width=${size} height=${size} fill="#fff"></rect><path d=${d} fill="#000"></path></svg>`;
}
