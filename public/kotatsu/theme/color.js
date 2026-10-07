/**
 * Colour parsing and WCAG contrast, shared by the pack validator (core.js), the palette
 * deriver (palette.js) and the authoring checker (scripts/theme-check.mjs). Pure, DOM-free.
 * Moved verbatim out of core.js so palette.js can use it without an import cycle; core.js
 * re-exports both public functions so its API is unchanged.
 */

const CSS_NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * @typedef {object} ParsedColor
 * @property {number} r
 * @property {number} g
 * @property {number} b
 * @property {number} a
 */

/**
 * Clamps a numeric channel to a valid range.
 *
 * @param {number} value Input number.
 * @param {number} maximum Upper bound.
 * @returns {number}
 */
function clamp(value, maximum) {
    return Math.min(maximum, Math.max(0, value));
}

/**
 * Parses one rgb channel in numeric or percentage form.
 *
 * @param {string} value Channel source.
 * @returns {number|null}
 */
function parseRgbChannel(value) {
    const source = value.trim();
    const percentage = source.endsWith('%');
    const numberSource = percentage ? source.slice(0, -1) : source;
    if (!CSS_NUMBER_PATTERN.test(numberSource)) {
        return null;
    }

    const numeric = Number(numberSource);
    return percentage ? clamp(numeric, 100) / 100 * 255 : clamp(numeric, 255);
}

/**
 * Parses one alpha channel in numeric or percentage form.
 *
 * @param {string} value Alpha source.
 * @returns {number|null}
 */
function parseAlpha(value) {
    const source = value.trim();
    const percentage = source.endsWith('%');
    const numberSource = percentage ? source.slice(0, -1) : source;
    if (!CSS_NUMBER_PATTERN.test(numberSource)) {
        return null;
    }

    const numeric = Number(numberSource);
    return percentage ? clamp(numeric, 100) / 100 : clamp(numeric, 1);
}

/**
 * Parses a supported CSS color. v0 intentionally accepts only hexadecimal and
 * rgb()/rgba() sRGB forms; named colors, hsl(), color-mix(), and var() return
 * null so tooling can report them as unresolved.
 *
 * @param {string} value CSS color source.
 * @returns {ParsedColor|null}
 */
export function parseColor(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const source = value.trim();
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(source);
    if (hex) {
        const digits = hex[1].length <= 4
            ? [...hex[1]].map(digit => `${digit}${digit}`).join('')
            : hex[1];
        return {
            r: Number.parseInt(digits.slice(0, 2), 16),
            g: Number.parseInt(digits.slice(2, 4), 16),
            b: Number.parseInt(digits.slice(4, 6), 16),
            a: digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1,
        };
    }

    const functional = /^rgba?\((.*)\)$/i.exec(source);
    if (!functional) {
        return null;
    }

    /** @type {string[]} */
    let channels;
    /** @type {string|null} */
    let alphaSource = null;
    const body = functional[1].trim();
    if (body.includes(',')) {
        const parts = body.split(',').map(part => part.trim());
        if (parts.length !== 3 && parts.length !== 4) {
            return null;
        }
        channels = parts.slice(0, 3);
        alphaSource = parts[3] ?? null;
        if (parts.some(part => part.includes('/'))) {
            return null;
        }
    } else {
        const slashParts = body.split('/').map(part => part.trim());
        if (slashParts.length > 2) {
            return null;
        }
        channels = slashParts[0].split(/\s+/);
        alphaSource = slashParts[1] ?? null;
        if (channels.length !== 3) {
            return null;
        }
    }

    const parsedChannels = channels.map(parseRgbChannel);
    if (parsedChannels.some(channel => channel === null)) {
        return null;
    }
    const alpha = alphaSource === null ? 1 : parseAlpha(alphaSource);
    if (alpha === null) {
        return null;
    }

    return {
        r: /** @type {number} */ (parsedChannels[0]),
        g: /** @type {number} */ (parsedChannels[1]),
        b: /** @type {number} */ (parsedChannels[2]),
        a: alpha,
    };
}

/**
 * Composites a color over an opaque background.
 *
 * @param {ParsedColor} foreground Foreground color.
 * @param {ParsedColor} background Opaque background color.
 * @returns {ParsedColor}
 */
function composite(foreground, background) {
    return {
        r: foreground.r * foreground.a + background.r * (1 - foreground.a),
        g: foreground.g * foreground.a + background.g * (1 - foreground.a),
        b: foreground.b * foreground.a + background.b * (1 - foreground.a),
        a: 1,
    };
}

/**
 * Computes WCAG relative luminance for an opaque sRGB color.
 *
 * @param {ParsedColor} color Opaque sRGB color.
 * @returns {number}
 */
function relativeLuminance(color) {
    const channels = [color.r, color.g, color.b].map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

/**
 * Computes the WCAG contrast ratio of two supported CSS colors. A translucent
 * background is composited over white, then the foreground over that result.
 * Unsupported color syntaxes return null.
 *
 * @param {string} foreground Foreground color.
 * @param {string} background Background color.
 * @returns {number|null}
 */
export function contrastRatio(foreground, background) {
    const foregroundColor = parseColor(foreground);
    const backgroundColor = parseColor(background);
    if (!foregroundColor || !backgroundColor) {
        return null;
    }

    const white = { r: 255, g: 255, b: 255, a: 1 };
    const opaqueBackground = composite(backgroundColor, white);
    const opaqueForeground = composite(foregroundColor, opaqueBackground);
    const foregroundLuminance = relativeLuminance(opaqueForeground);
    const backgroundLuminance = relativeLuminance(opaqueBackground);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
}
