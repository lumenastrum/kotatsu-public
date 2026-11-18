/**
 * Kotatsu Wrapped — painting the cards (docs/wrapped/README.md).
 *
 * The cards are drawn on a canvas, and the canvas IS the preview: what the sheet shows is the
 * exact picture that gets saved, pixel for pixel. One painter, so there is no second layout to
 * drift from the first, and nothing to rasterize at save time.
 *
 * THE LOOK IS THE THEME'S (Andres, 2026-11-12: "Kotatsu feels premium everywhere, the cards have
 * to feel that way too… they should match whether they're being rendered on Natsumikan, Blue
 * Hour or Sparkle"). Nothing here names a colour or a typeface: `readTheme()` asks the running
 * pack for its ground, its glass, its ink, its accent, its three glows and its display and UI
 * faces, and the card is built from those the way the app's own sheets are: the pack's lit
 * backdrop, a raised panel on it, the display face doing the talking. A card saved under
 * Natsumikan is cream glass and indigo ink; under Blue Hour, slate and periwinkle; under Sparkle,
 * plum and pink. A pack someone else wrote gets a card that matches it too.
 *
 * The idea of the layout is a programme for the stretch of time: its title, who was in it
 * ("The cast"), who wrote it (the models), under which presets. The lists are set as billing:
 * the top line largest, a hairline under each with the share of replies inked in. There are no
 * boxes; the type and the rules carry the structure.
 *
 * Every string comes from `model.js` `buildCards()`; this file decides where things go, never
 * what they say. The words themselves reach screen readers through `describeCards()`.
 */

export const CARD_SIZES = Object.freeze({
    story: { width: 1080, height: 1920 },
    nights: { width: 1080, height: 1080 },
    report: { width: 1080, height: 1080 },
    faceoff: { width: 1080, height: 1080 },
    phrases: { width: 1080, height: 1080 },
});

/** @typedef {{r: number, g: number, b: number}} Rgb */

/**
 * @typedef {object} CardTheme
 * @property {Rgb} ground The page behind everything.
 * @property {Rgb} panel The raised surface the card's content sits on.
 * @property {Rgb} ink Headline ink.
 * @property {Rgb} text Body ink.
 * @property {Rgb} muted Labels and units.
 * @property {Rgb} accent The pack's accent, for the italic line and the share rules.
 * @property {Rgb} spot The pack's "what matters" colour: the wordmark's dot, the mikans.
 * @property {Rgb} line Hairlines and the panel's edge.
 * @property {Rgb} shadow
 * @property {[Rgb, Rgb, Rgb]} glows Top-right, bottom-left, bottom.
 * @property {string} display Font family list for the display face.
 * @property {string} ui Font family list for the UI face.
 * @property {number} displayWeight
 * @property {number} radius The pack's largest radius, in CSS px.
 * @property {boolean} dark
 */

/** What a card looks like when nothing can be read from the page (a test, a detached canvas). */
const FALLBACK = Object.freeze({
    '--k-ground': '#11131a', '--k-surface': '#1a1d27', '--k-text-strong': '#eeeff5', '--k-text': '#dadce5',
    '--k-text-muted': '#8489a2', '--k-accent': '#9aa4d2', '--k-select': '#e2ae9f', '--k-chrome-border': '#4d5266',
    '--k-elevation-shadow': '#000000', '--k-glow-dawn': '#858eb6', '--k-glow-rose': '#966a8a', '--k-glow-deep': '#5c637f',
});

/**
 * A computed CSS colour as numbers. Browsers answer `rgb(r, g, b)` for plain colours and
 * `color(srgb r g b)` (0–1) for anything that went through `color-mix()`.
 * @param {string} value
 * @returns {Rgb|null}
 */
export function parseColor(value) {
    const text = String(value ?? '').trim();
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
    if (m) return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) };
    m = /^color\(\s*srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)/i.exec(text);
    if (m) return { r: Math.round(+m[1] * 255), g: Math.round(+m[2] * 255), b: Math.round(+m[3] * 255) };
    m = /^#([0-9a-f]{6})$/i.exec(text);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
    return null;
}

/** @param {Rgb} c @param {number} [alpha] */
const ink = (c, alpha = 1) => `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
/** @param {Rgb} c */
const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

/**
 * Asks the running theme pack what a card should look like. Colours are resolved by the
 * browser (a probe element wearing each token), so `var()` chains and `color-mix()` come back
 * as real colours; a token a pack does not define falls back along the same chain the
 * stylesheets use.
 * @param {Element} [host] Where to read from; the body by default.
 * @returns {CardTheme}
 */
export function readTheme(host = globalThis.document?.body) {
    /** @type {(expression: string, fallback: string) => Rgb} */
    let color = (_expression, fallback) => /** @type {Rgb} */ (parseColor(fallback));
    /** @type {(name: string) => string} */
    let raw = () => '';
    /** @type {HTMLElement|null} */
    let probe = null;
    if (host && typeof globalThis.document !== 'undefined') {
        probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
        host.appendChild(probe);
        const style = getComputedStyle(host);
        raw = (name) => style.getPropertyValue(name).trim();
        color = (expression, fallback) => {
            /** @type {HTMLElement} */ (probe).style.color = fallback;
            /** @type {HTMLElement} */ (probe).style.color = expression;
            return parseColor(getComputedStyle(/** @type {HTMLElement} */ (probe)).color) ?? /** @type {Rgb} */ (parseColor(fallback));
        };
    }
    const token = (/** @type {keyof typeof FALLBACK} */ name) => color(`var(${name})`, FALLBACK[name]);
    try {
        const panel = token('--k-surface');
        return {
            ground: token('--k-ground'),
            panel,
            ink: token('--k-text-strong'),
            text: token('--k-text'),
            muted: token('--k-text-muted'),
            accent: token('--k-accent'),
            // "What matters": a pack's primary fill when it has one (Natsumikan's mikan), else
            // what it selects with (Blue Hour's rose, Sparkle's pink).
            spot: color('var(--k-primary-bg, var(--k-select))', FALLBACK['--k-select']),
            line: token('--k-chrome-border'),
            shadow: token('--k-elevation-shadow'),
            glows: [token('--k-glow-dawn'), token('--k-glow-rose'), token('--k-glow-deep')],
            display: raw('--k-font-display') || 'Georgia, serif',
            ui: raw('--k-font-ui') || 'system-ui, sans-serif',
            displayWeight: Number.parseInt(raw('--k-display-weight'), 10) || 600,
            radius: Number.parseFloat(raw('--k-radius-xl')) || 12,
            dark: luminance(panel) < 0.5,
        };
    } finally {
        probe?.remove();
    }
}

/**
 * @param {CardTheme} theme
 * @returns {Promise<void>} Resolves when the pack's faces are ready (or could not be had: the
 * fallbacks in each family list still draw a whole card).
 */
export async function ensureFonts(theme) {
    const fonts = globalThis.document?.fonts;
    if (!fonts?.load) return;
    const faces = [
        `${theme.displayWeight} 120px ${theme.display}`,
        `italic ${theme.displayWeight} 60px ${theme.display}`,
        `italic 500 44px ${theme.display}`,
        `500 30px ${theme.ui}`,
        `700 30px ${theme.ui}`,
    ];
    await Promise.all(faces.map((face) => fonts.load(face).catch(() => [])));
}

const EDGE = 40;      // backdrop showing around the panel
const INSET = 72;     // panel edge to content
const LEFT = EDGE + INSET;

/**
 * Text that never leaves its box: shortened with an ellipsis when it is too long.
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxWidth
 * @returns {string}
 */
function fit(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
}

/**
 * Sets a font, stepping the size down until the text fits (to a floor, then it is ellipsized).
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxWidth
 * @param {string} style e.g. `700` or `italic 500` @param {number} size @param {string} family @param {number} floor
 * @returns {string} The text to draw.
 */
function fitSize(ctx, text, maxWidth, style, size, family, floor) {
    for (let px = size; px >= floor; px -= 2) {
        ctx.font = `${style} ${px}px ${family}`;
        if (ctx.measureText(text).width <= maxWidth) return text;
    }
    return fit(ctx, text, maxWidth);
}

/** The pack's lit backdrop: ground, then its three glows where the app itself puts them. */
function backdrop(ctx, { width, height }, theme) {
    ctx.fillStyle = ink(theme.ground);
    ctx.fillRect(0, 0, width, height);
    const strength = theme.dark ? 0.5 : 0.7;
    /** @type {[number, number, number, Rgb][]} */
    const lights = [
        [width * 0.96, -height * 0.02, Math.max(width, height) * 0.62, theme.glows[0]],
        [-width * 0.04, height * 1.02, Math.max(width, height) * 0.5, theme.glows[1]],
        [width * 0.66, height * 1.08, Math.max(width, height) * 0.42, theme.glows[2]],
    ];
    for (const [x, y, radius, glow] of lights) {
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, ink(glow, strength));
        gradient.addColorStop(1, ink(glow, 0));
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }
}

/** The raised panel: the pack's surface as glass over its own glow, with a lit top edge. */
function panel(ctx, { width, height }, theme) {
    const radius = Math.max(28, Math.min(64, theme.radius * 2.4));
    const [x, y, w, h] = [EDGE, EDGE, width - EDGE * 2, height - EDGE * 2];
    ctx.save();
    ctx.shadowColor = ink(theme.shadow, theme.dark ? 0.5 : 0.26);
    ctx.shadowBlur = 80;
    ctx.shadowOffsetY = 30;
    ctx.fillStyle = ink(theme.panel, theme.dark ? 0.84 : 0.8);
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink(theme.line, theme.dark ? 0.55 : 0.7);
    ctx.beginPath(); ctx.roundRect(x + 1, y + 1, w - 2, h - 2, radius - 1); ctx.stroke();
    // Light catching the top edge, the way the app's glass panels have it.
    const sheen = ctx.createLinearGradient(0, y, 0, y + 220);
    sheen.addColorStop(0, `rgba(255, 255, 255, ${theme.dark ? 0.07 : 0.5})`);
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sheen;
    ctx.beginPath(); ctx.roundRect(x + 2, y + 2, w - 4, 220, [radius - 2, radius - 2, 0, 0]); ctx.fill();
}

/**
 * Kotatsu's wordmark, "k•tatsu", from its own strokes (brand/wordmark.svg, docs/brand.md) in
 * the pack's ink with the pack's spot colour for the dot, then "Wrapped" beside it in the
 * display italic.
 * @returns {void}
 */
function masthead(ctx, { width }, theme, when) {
    const scale = 0.66, x = LEFT - 9 * scale, y = EDGE + 62;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink(theme.ink);
    for (const d of [
        'M14 12 v40 M14 34 l20 -18 M19.5 29.5 l16 22.5',
        'M68 18 v27 a7 7 0 0 0 7 7 M58 30 h19',
        'M107 33 v19',
        'M126 18 v27 a7 7 0 0 0 7 7 M116 30 h19',
        'M162 34 a8 7 0 0 0 -15 2.5 c0 7 15 3 15 10.5 a8 7 0 0 1 -15 2.5',
        'M178 30 v13 a9 9 0 0 0 18 0 v-13 M196 43 v9',
    ]) ctx.stroke(new Path2D(d));
    ctx.beginPath(); ctx.arc(98, 42, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ink(theme.spot);
    ctx.beginPath(); ctx.arc(45, 42, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
    ctx.font = `italic 500 42px ${theme.display}`;
    ctx.fillStyle = ink(theme.accent);
    ctx.fillText('Wrapped', x + 236 * scale + 14, y + 52 * scale);
    if (when) {
        ctx.font = `500 28px ${theme.ui}`;
        ctx.fillStyle = ink(theme.muted);
        ctx.textAlign = 'right';
        ctx.fillText(when, width - LEFT, y + 52 * scale);
        ctx.textAlign = 'left';
    }
}

/**
 * The quiet line at the foot of a card. With `narrow` (a figure is standing in the right-hand
 * corner) both texts stack on the left inside that width instead of facing each other.
 */
function footer(ctx, { width, height }, theme, left, right = '', narrow = 0) {
    ctx.font = `500 25px ${theme.ui}`;
    ctx.fillStyle = ink(theme.muted);
    if (narrow) {
        if (right) ctx.fillText(fit(ctx, right, narrow), LEFT, height - EDGE - 54);
        ctx.fillText(fit(ctx, left, narrow), LEFT, height - EDGE - (right ? 92 : 54));
        return;
    }
    ctx.fillText(fit(ctx, left, width - LEFT * 2 - (right ? 260 : 0)), LEFT, height - EDGE - 54);
    if (right) {
        ctx.textAlign = 'right';
        ctx.fillText(right, width - LEFT, height - EDGE - 54);
        ctx.textAlign = 'left';
    }
}

/**
 * Mikan-chan, Kotatsu's mascot (docs/brand.md): her full figure for the tall card, her chibi for
 * the square ones. Art, so the one thing on a card the pack does not recolour.
 * @typedef {{hero: HTMLImageElement|null, small: HTMLImageElement|null}} CardArt
 */
const ART_FILES = Object.freeze({ hero: 'kotatsu/brand/mascot/ready.webp', small: 'kotatsu/brand/mascot/chibi.webp' });
/** @type {Promise<CardArt>|null} */
let artPromise = null;

/**
 * @returns {Promise<CardArt>} Her pictures, fetched once. One that will not load is null and the
 * card is drawn without it.
 */
export function loadArt() {
    artPromise ??= (async () => {
        const one = (/** @type {string} */ src) => new Promise((resolve) => {
            const image = new Image();
            image.decoding = 'async';
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = src;
        });
        const [hero, small] = await Promise.all([one(ART_FILES.hero), one(ART_FILES.small)]);
        return /** @type {CardArt} */ ({ hero, small });
    })();
    return artPromise;
}

/**
 * Where she goes: against a right and a bottom edge, as tall as the room between `top` and
 * `bottom` allows (up to `maxHeight`). Too little room and she sits this one out.
 * @param {CardArt|null|undefined} art
 * @param {{right: number, bottom: number, top: number, maxHeight: number}} room
 * @returns {{image: HTMLImageElement, x: number, y: number, w: number, h: number}|null}
 */
function placeArt(art, { right, bottom, top, maxHeight }) {
    if (!art) return null;
    const h = Math.min(maxHeight, bottom - top);
    if (h < 170) return null;
    const image = (h >= 330 ? art.hero : art.small) ?? art.small ?? art.hero;
    if (!image || !image.naturalHeight) return null;
    const w = h * image.naturalWidth / image.naturalHeight;
    return { image, x: right - w, y: bottom - h, w, h };
}

/** Draws her where `placeArt` put her, on a soft patch of shade so she stands on the card. */
function drawArt(ctx, figure, theme) {
    if (!figure) return;
    const { image, x, y, w, h } = figure;
    const shade = ctx.createRadialGradient(x + w / 2, y + h - 6, 0, x + w / 2, y + h - 6, w * 0.46);
    shade.addColorStop(0, ink(theme.shadow, theme.dark ? 0.5 : 0.2));
    shade.addColorStop(1, ink(theme.shadow, 0));
    ctx.save();
    ctx.translate(0, (y + h - 6) * 0.78);
    ctx.scale(1, 0.22);
    ctx.fillStyle = shade;
    ctx.fillRect(x - w * 0.2, y + h - 6 - w * 0.5, w * 1.4, w);
    ctx.restore();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, x, y, w, h);
}

/** A hairline; with `share`, the share of it inked in the accent. */
function rule(ctx, x, y, w, theme, share = 0) {
    ctx.fillStyle = ink(theme.line, theme.dark ? 0.6 : 0.75);
    ctx.fillRect(x, y, w, 2);
    if (share > 0) {
        ctx.fillStyle = ink(theme.accent);
        ctx.beginPath(); ctx.roundRect(x, y - 2, Math.max(10, w * Math.min(1, share)), 6, 3); ctx.fill();
    }
}

/** A small solid triangle, pointing up or down, centred on (cx, cy). */
function arrow(ctx, cx, cy, up) {
    const s = 8;
    ctx.beginPath();
    const tip = up ? -s : s, base = up ? s * 0.7 : -s * 0.7;
    ctx.moveTo(cx, cy + tip);
    ctx.lineTo(cx + s, cy + base);
    ctx.lineTo(cx - s, cy + base);
    ctx.closePath();
    ctx.fill();
}

/** Billing sizes: the top line is the largest. */
const BILLING = [54, 44, 38];
const billingHeight = (/** @type {number} */ count) => 58 + BILLING.slice(0, count).reduce((sum, size) => sum + size + 46, 0);

/**
 * One billed list: its name and what the right-hand column counts, then a line per entry.
 * @returns {void}
 */
function billing(ctx, width, y, theme, title, unit, rows) {
    const right = width - LEFT, w = right - LEFT;
    ctx.font = `700 28px ${theme.ui}`;
    ctx.fillStyle = ink(theme.muted);
    ctx.fillText(title, LEFT, y + 28);
    ctx.font = `500 26px ${theme.ui}`;
    ctx.textAlign = 'right';
    ctx.fillText(unit, right, y + 28);
    ctx.textAlign = 'left';
    let top = y + 58;
    rows.slice(0, BILLING.length).forEach((row, index) => {
        const size = BILLING[index];
        ctx.font = `${theme.displayWeight} ${size}px ${theme.display}`;
        ctx.fillStyle = ink(theme.ink);
        ctx.textAlign = 'right';
        ctx.fillText(row.value, right, top + size);
        const valueWidth = ctx.measureText(row.value).width;
        ctx.textAlign = 'left';
        ctx.fillText(fit(ctx, row.name, w - valueWidth - 40), LEFT, top + size);
        rule(ctx, LEFT, top + size + 22, w, theme, row.share);
        top += size + 46;
    });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<import('./model.js').buildCards>['story']} story
 * @param {CardTheme} theme
 * @param {CardArt|null} [art]
 */
export function drawStory(ctx, story, theme, art = null) {
    const size = CARD_SIZES.story;
    const { width, height } = size;
    const right = width - LEFT, w = right - LEFT;
    backdrop(ctx, size, theme);
    panel(ctx, size, theme);
    masthead(ctx, size, theme, '');

    // The title: the stretch of time, as the name of the thing.
    ctx.fillStyle = ink(theme.ink);
    ctx.fillText(fitSize(ctx, story.when, w, `${theme.displayWeight}`, 136, theme.display, 70), LEFT - 4, 372);
    ctx.font = `italic 500 56px ${theme.display}`;
    ctx.fillStyle = ink(theme.accent);
    ctx.fillText('under the blanket', LEFT, 452);

    // Three figures across, as type: no boxes.
    const column = w / story.lead.length;
    // One size for all three: the largest at which the longest of them still fits its column.
    let figure = 92;
    for (; figure > 52; figure -= 2) {
        ctx.font = `${theme.displayWeight} ${figure}px ${theme.display}`;
        if (story.lead.every(([value]) => ctx.measureText(value).width <= column - 28)) break;
    }
    story.lead.forEach(([value, caption], index) => {
        const x = LEFT + column * index;
        ctx.font = `${theme.displayWeight} ${figure}px ${theme.display}`;
        ctx.fillStyle = ink(theme.ink);
        ctx.fillText(fit(ctx, value, column - 28), x - 2, 620);
        ctx.font = `500 28px ${theme.ui}`;
        ctx.fillStyle = ink(theme.muted);
        ctx.fillText(fit(ctx, caption, column - 20), x, 666);
        // How it moved against the earlier stretch: a small arrow and a size, in the same quiet
        // ink whichever way it points.
        const move = story.moves?.[index];
        if (move) {
            ctx.fillStyle = ink(theme.muted);
            if (move.dir !== 'same') arrow(ctx, x + 9, 697, move.dir === 'up');
            ctx.font = `700 25px ${theme.ui}`;
            ctx.fillText(move.text, x + (move.dir === 'same' ? 0 : 26), 706);
        }
    });
    const moved = Boolean(story.versus);
    if (moved) {
        ctx.font = `500 23px ${theme.ui}`;
        ctx.fillStyle = ink(theme.muted, 0.85);
        ctx.fillText(fit(ctx, story.versus, w), LEFT, 748);
    }

    const contentTop = moved ? 776 : 716;
    const contentBottom = height - EDGE - 136;
    const notesAll = [...story.fine, ...story.little, ...(story.presetNote ? [story.presetNote] : [])];
    /**
     * Everything has to fit on the card. With three lists and every note there is more than the
     * card is tall, so the lists give up their last line (presets first, then models, then the
     * cast) and then the notes thin out, until it does.
     */
    const lists = /** @type {{title: string, unit: string, rows: any[], keep: number}[]} */ ([
        { title: 'The cast', unit: 'replies', rows: story.cards },
        { title: 'Written by', unit: 'share of replies', rows: story.models },
        { title: 'Presets', unit: 'share of replies', rows: story.presets },
    ]).filter((list) => list.rows.length).map((list) => ({ ...list, keep: Math.min(list.rows.length, BILLING.length) }));
    let noteCount = notesAll.length;
    const needed = () => lists.reduce((sum, list) => sum + billingHeight(list.keep), 0) + noteCount * 46 + (lists.length + (noteCount ? 1 : 0)) * 18;
    for (let pass = 0; needed() > contentBottom - contentTop && pass < 12; pass++) {
        const trim = [...lists].reverse().find((list) => list.keep > 2);
        if (trim) trim.keep--;
        else if (noteCount > story.fine.length) noteCount--;
        else if (noteCount > 0) noteCount--;
        else break;
    }
    /** Each block knows its own height, so the leftover space can be shared out between them. */
    const blocks = lists.map((list) => ({
        height: billingHeight(list.keep),
        draw: (/** @type {number} */ y) => billing(ctx, width, y, theme, list.title, list.unit, list.rows.slice(0, list.keep)),
    }));
    const notes = notesAll.slice(0, noteCount);
    let noteWidth = w;
    if (notes.length) {
        blocks.push({
            height: notes.length * 46,
            draw: (/** @type {number} */ y) => notes.forEach((note, index) => {
                ctx.font = `500 30px ${theme.ui}`;
                ctx.fillStyle = ink(index < story.fine.length ? theme.text : theme.muted);
                ctx.fillText(fit(ctx, note, noteWidth), LEFT, y + 32 + index * 46);
            }),
        });
    }
    if (story.cards.length || story.models.length) {
        const used = blocks.reduce((sum, block) => sum + block.height, 0);
        const gap = Math.max(18, Math.min(76, (contentBottom - contentTop - used) / blocks.length));
        let y = contentTop + gap;
        const tops = blocks.map((block) => { const top = y; y += block.height + gap; return top; });
        // Mikan-chan stands in the bottom corner, beside the notes and as tall as the room
        // under the last list allows; the notes give her their right-hand side.
        const below = notes.length ? tops[tops.length - 1] - 8 : y - gap + 16;
        const figure = placeArt(art, { right: width - EDGE - 26, bottom: height - EDGE - 30, top: below, maxHeight: 470 });
        if (figure) noteWidth = figure.x - LEFT - 20;
        blocks.forEach((block, index) => block.draw(tops[index]));
        drawArt(ctx, figure, theme);
    } else {
        drawArt(ctx, placeArt(art, { right: width - EDGE - 26, bottom: height - EDGE - 30, top: contentTop + 230, maxHeight: 470 }), theme);
        rule(ctx, LEFT, contentTop + 20, w, theme);
        ctx.font = `italic 500 46px ${theme.display}`;
        ctx.fillStyle = ink(theme.text);
        ctx.fillText('A quiet stretch.', LEFT, contentTop + 120);
        ctx.font = `500 32px ${theme.ui}`;
        ctx.fillStyle = ink(theme.muted);
        ctx.fillText('The blanket is still warm.', LEFT, contentTop + 176);
    }
    footer(ctx, size, theme, 'made under the blanket');
}

/**
 * A mikan: a round fruit with its leaf (or an empty ring). Like Mikan-chan herself it is a picture
 * of a thing, so it keeps its own colours under every pack: a pink mikan reads as a peach.
 */
const FRUIT = Object.freeze({ peel: { r: 243, g: 154, b: 60 }, leaf: { r: 110, g: 160, b: 86 } });
function mikan(ctx, cx, cy, r, theme, on) {
    if (!on) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = ink(theme.line, 0.9);
        ctx.beginPath(); ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2); ctx.stroke();
        return;
    }
    ctx.fillStyle = ink(FRUIT.peel);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${theme.dark ? 0.22 : 0.4})`;
    ctx.beginPath(); ctx.ellipse(cx - r * 0.34, cy - r * 0.36, r * 0.3, r * 0.2, -0.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink(FRUIT.leaf);
    ctx.beginPath(); ctx.ellipse(cx + r * 0.3, cy - r * 1.02, r * 0.46, r * 0.22, -0.5, 0, Math.PI * 2); ctx.fill();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {NonNullable<ReturnType<import('./model.js').buildCards>['report']>} report
 * @param {CardTheme} theme
 * @param {CardArt|null} [art]
 */
export function drawReport(ctx, report, theme, art = null) {
    const size = CARD_SIZES.report;
    const { width } = size;
    const right = width - LEFT, w = right - LEFT;
    backdrop(ctx, size, theme);
    panel(ctx, size, theme);
    masthead(ctx, size, theme, report.when);

    const [first, second] = report.title;
    ctx.fillStyle = ink(theme.ink);
    ctx.fillText(fitSize(ctx, first, w, `${theme.displayWeight}`, 96, theme.display, 52), LEFT - 3, 300);
    let y = 300;
    if (second) {
        y += 70;
        ctx.fillStyle = ink(theme.accent);
        // Preset names run long ("Freaky Frankenstein 5.6 Internal States Argon Edition"): past
        // the smallest comfortable size the name takes a second line instead of losing its end.
        const line = fitSize(ctx, `with ${second}`, w, 'italic 500', 52, theme.display, 34);
        if (line === `with ${second}`) ctx.fillText(line, LEFT, y);
        else {
            ctx.font = `italic 500 38px ${theme.display}`;
            const lines = wrapLeft(ctx, `with ${second}`, w);
            lines.forEach((text, n) => ctx.fillText(text, LEFT, y - 6 + n * 44));
            y += (lines.length - 1) * 44 - 6;
        }
    }

    // The verdict, the way a review opens: the rating, then what it means.
    const row = y + 84;
    for (let i = 0; i < 5; i++) mikan(ctx, LEFT + 26 + i * 66, row, 26, theme, i < report.mikans);
    ctx.font = `italic 500 40px ${theme.display}`;
    ctx.fillStyle = ink(theme.text);
    ctx.fillText(fit(ctx, report.verdict, w - 360), LEFT + 356, row + 13);

    // The figures as a ledger: what it is on the left, the number on the right.
    const top = row + 66;
    // Her chibi stands in the bottom corner; the ledger closes above her head.
    const figure = placeArt(art, { right: width - EDGE - 30, bottom: size.height - EDGE - 26, top: size.height - EDGE - 236, maxHeight: 210 });
    const rowH = Math.min(86, (size.height - EDGE - (figure ? 250 : 110) - top) / report.rows.length);
    // When a two-line preset name takes the ledger's room, the type gets smaller with its rows
    // rather than sitting on the hairlines.
    const namePx = Math.round(Math.min(32, rowH * 0.5)), valuePx = Math.round(Math.min(46, rowH * 0.7));
    rule(ctx, LEFT, top, w, theme);
    report.rows.forEach(([name, value], index) => {
        const base = top + rowH * index + rowH * 0.66;
        ctx.font = `500 ${namePx}px ${theme.ui}`;
        ctx.fillStyle = ink(theme.text);
        ctx.fillText(name, LEFT, base);
        ctx.font = `${theme.displayWeight} ${valuePx}px ${theme.display}`;
        ctx.fillStyle = ink(theme.ink);
        ctx.textAlign = 'right';
        ctx.fillText(value, right, base + 2);
        ctx.textAlign = 'left';
        rule(ctx, LEFT, top + rowH * (index + 1), w, theme);
    });
    drawArt(ctx, figure, theme);
    footer(ctx, size, theme, 'Mikans go by the share of replies kept on the first try', '', figure ? figure.x - LEFT - 20 : 0);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReturnType<import('./model.js').buildCards>['phrases']} phrases
 * @param {CardTheme} theme
 * @param {CardArt|null} [art]
 */
export function drawPhrases(ctx, phrases, theme, art = null) {
    const size = CARD_SIZES.phrases;
    const { width } = size;
    const right = width - LEFT, w = right - LEFT;
    backdrop(ctx, size, theme);
    panel(ctx, size, theme);
    masthead(ctx, size, theme, phrases.when);

    ctx.font = `${theme.displayWeight} 84px ${theme.display}`;
    ctx.fillStyle = ink(theme.ink);
    ctx.fillText('Phrases spotted', LEFT - 3, 292);
    ctx.font = `italic 500 44px ${theme.display}`;
    ctx.fillStyle = ink(theme.accent);
    ctx.fillText(phrases.sub, LEFT, 352);

    if (!phrases.rows.length) {
        rule(ctx, LEFT, 420, w, theme);
        ctx.font = `italic 500 46px ${theme.display}`;
        ctx.fillStyle = ink(theme.text);
        ctx.fillText(fit(ctx, phrases.empty, w), LEFT, 520);
    }
    // Each phrase set as the quotation it is, in the display italic, with its tally. When two
    // or three models are being compared, a square per model sits between the phrase and its
    // tally: how often THAT model wrote it per 100 replies, inked deeper the more it did.
    const who = phrases.who ?? [];
    const colW = 122, totalW = 104;
    const matrix = who.length >= 2;
    const top = matrix ? 458 : 404;
    // With her chibi in the corner there is room for five phrases rather than six.
    const figure = placeArt(art, { right: width - EDGE - 30, bottom: size.height - EDGE - 26, top: size.height - EDGE - 236, maxHeight: 210 });
    const rows = figure || matrix ? phrases.rows.slice(0, 5) : phrases.rows;
    const rowH = Math.min(100, (size.height - EDGE - (figure ? 240 : 104) - top) / Math.max(1, rows.length));
    const columnX = (/** @type {number} */ index) => right - totalW - (who.length - index) * colW;
    if (matrix && rows.length) {
        ctx.textAlign = 'center';
        ctx.fillStyle = ink(theme.muted);
        who.forEach((name, index) => {
            ctx.font = `700 21px ${theme.ui}`;
            wrapTwo(ctx, name, colW - 12).forEach((line, n, lines) => ctx.fillText(line, columnX(index) + colW / 2, top - 22 - (lines.length - 1 - n) * 25));
        });
        ctx.textAlign = 'left';
    }
    rows.forEach((row, index) => {
        const base = top + rowH * index + rowH * 0.6;
        ctx.font = `${theme.displayWeight} ${matrix ? 44 : 50}px ${theme.display}`;
        ctx.fillStyle = ink(theme.ink);
        ctx.textAlign = 'right';
        ctx.fillText(row.count, right, base);
        const countWidth = ctx.measureText(row.count).width;
        ctx.textAlign = 'left';
        ctx.fillStyle = ink(theme.text);
        const labelRoom = matrix ? columnX(0) - LEFT - 20 : w - countWidth - 48;
        // A long phrase steps down a little, then takes two lines inside its row rather than
        // losing its end ("a character named Kaelen…" said nothing about Elara).
        const single = fitSize(ctx, row.label, labelRoom, 'italic 500', matrix ? 38 : 44, theme.display, 32);
        if (single === row.label) ctx.fillText(single, LEFT, base);
        else {
            const px = Math.max(24, Math.min(30, Math.floor(rowH / 2.2)));
            ctx.font = `italic 500 ${px}px ${theme.display}`;
            wrapLeft(ctx, row.label, labelRoom).forEach((line, n) => ctx.fillText(line, LEFT, base - px / 2 + n * px));
        }
        if (matrix) {
            (row.rates ?? []).forEach((cell, n) => {
                const x = columnX(n) + (colW - 84) / 2, y = base - 38;
                ctx.fillStyle = cell.depth > 0 ? ink(theme.accent, 0.22 + cell.depth * 0.78) : ink(theme.line, theme.dark ? 0.24 : 0.26);
                ctx.beginPath(); ctx.roundRect(x, y, 84, 50, Math.max(8, Math.min(14, theme.radius))); ctx.fill();
                ctx.font = `700 24px ${theme.ui}`;
                ctx.textAlign = 'center';
                ctx.fillStyle = cell.depth >= 0.6 ? ink(theme.panel) : ink(theme.text, cell.depth > 0 ? 0.95 : 0.55);
                ctx.fillText(cell.text, x + 42, y + 34);
                ctx.textAlign = 'left';
            });
        }
        rule(ctx, LEFT, base + 24, w, theme, matrix ? 0 : row.fill);
    });
    drawArt(ctx, figure, theme);
    footer(ctx, size, theme, matrix ? phrases.whoNote : 'Counted, never corrected', phrases.list, figure ? figure.x - LEFT - 20 : 0);
}

/**
 * A short name on at most two centred lines (a model's name over its column).
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxWidth
 * @returns {string[]}
 */
function wrapTwo(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return [text];
    const words = text.split(' ');
    let first = words[0];
    let index = 1;
    while (index < words.length - 1 && ctx.measureText(`${first} ${words[index]}`).width <= maxWidth) first += ` ${words[index++]}`;
    return [fit(ctx, first, maxWidth), fit(ctx, words.slice(index).join(' '), maxWidth)].filter(Boolean);
}

/**
 * Text on at most two left-set lines, the first as full as it can be; the second is ellipsized
 * only if even two lines cannot hold it.
 * @param {CanvasRenderingContext2D} ctx @param {string} text @param {number} maxWidth
 * @returns {string[]}
 */
function wrapLeft(ctx, text, maxWidth) {
    const words = text.split(' ');
    let first = words[0];
    let index = 1;
    while (index < words.length && ctx.measureText(`${first} ${words[index]}`).width <= maxWidth) first += ` ${words[index++]}`;
    return [fit(ctx, first, maxWidth), fit(ctx, words.slice(index).join(' '), maxWidth)].filter(Boolean);
}

/**
 * The face-off: two or three models side by side on the same figures, as a ledger with a
 * column each. Where a figure has a direction (kept more, swiped less, waited less) and one
 * model clearly has it, that number takes the accent.
 * @param {CanvasRenderingContext2D} ctx
 * @param {NonNullable<ReturnType<import('./model.js').buildCards>['faceoff']>} faceoff
 * @param {CardTheme} theme
 * @param {CardArt|null} [art]
 */
export function drawFaceoff(ctx, faceoff, theme, art = null) {
    const size = CARD_SIZES.faceoff;
    const { width, height } = size;
    const right = width - LEFT, w = right - LEFT;
    backdrop(ctx, size, theme);
    panel(ctx, size, theme);
    masthead(ctx, size, theme, faceoff.when);

    ctx.font = `${theme.displayWeight} 84px ${theme.display}`;
    ctx.fillStyle = ink(theme.ink);
    ctx.fillText(faceoff.title, LEFT - 3, 292);
    ctx.font = `italic 500 44px ${theme.display}`;
    ctx.fillStyle = ink(theme.accent);
    ctx.fillText(faceoff.sub, LEFT, 352);

    const count = faceoff.names.length;
    const colW = count === 2 ? 232 : 176;
    const columnRight = (/** @type {number} */ index) => right - (count - 1 - index) * colW;
    // Each model heads its column: its name, and how many replies stand behind its figures.
    ctx.textAlign = 'right';
    faceoff.names.forEach((name, index) => {
        ctx.font = `${theme.displayWeight} ${count === 2 ? 32 : 27}px ${theme.display}`;
        ctx.fillStyle = ink(theme.ink);
        wrapTwo(ctx, name, colW - 16).forEach((line, n, lines) => ctx.fillText(line, columnRight(index), 462 - (lines.length - 1 - n) * (count === 2 ? 36 : 31)));
        ctx.font = `500 22px ${theme.ui}`;
        ctx.fillStyle = ink(theme.muted);
        ctx.fillText(faceoff.counts[index], columnRight(index), 494);
    });
    ctx.textAlign = 'left';

    const figure = placeArt(art, { right: width - EDGE - 30, bottom: height - EDGE - 26, top: height - EDGE - 236, maxHeight: 210 });
    const top = 516;
    const rowH = Math.min(78, (height - EDGE - (figure ? 240 : 110) - top) / faceoff.rows.length);
    rule(ctx, LEFT, top, w, theme);
    faceoff.rows.forEach((row, index) => {
        const base = top + rowH * index + rowH * 0.66;
        ctx.fillStyle = ink(theme.text);
        ctx.fillText(fitSize(ctx, row.label, w - count * colW - 16, '500', 30, theme.ui, 22), LEFT, base);
        ctx.textAlign = 'right';
        row.values.forEach((value, n) => {
            ctx.font = `${theme.displayWeight} ${count === 2 ? 42 : 36}px ${theme.display}`;
            ctx.fillStyle = ink(row.lead === n ? theme.accent : theme.ink);
            ctx.fillText(value, columnRight(n), base + 2);
        });
        ctx.textAlign = 'left';
        rule(ctx, LEFT, top + rowH * (index + 1), w, theme);
    });
    drawArt(ctx, figure, theme);
    footer(ctx, size, theme, 'In colour: kept the most, swiped or waited the least', '', figure ? figure.x - LEFT - 20 : 0);
}

/**
 * The calendar card: a square for every day, inked by how much was read that day, with the
 * streak and the biggest day beside it and the shape of a day (activity by hour) beneath.
 * A month hangs from its weekdays; a week is its seven days in one wide row.
 * @param {CanvasRenderingContext2D} ctx
 * @param {NonNullable<ReturnType<import('./model.js').buildCards>['nights']>} nights
 * @param {CardTheme} theme
 * @param {CardArt|null} [art]
 */
export function drawNights(ctx, nights, theme, art = null) {
    const size = CARD_SIZES.nights;
    const { width, height } = size;
    const right = width - LEFT, w = right - LEFT;
    backdrop(ctx, size, theme);
    panel(ctx, size, theme);
    masthead(ctx, size, theme, nights.when);

    ctx.fillStyle = ink(theme.ink);
    ctx.fillText(fitSize(ctx, nights.title, w, `${theme.displayWeight}`, 84, theme.display, 54), LEFT - 3, 292);
    ctx.font = `italic 500 44px ${theme.display}`;
    ctx.fillStyle = ink(theme.accent);
    ctx.fillText(nights.sub, LEFT, 352);

    const figure = placeArt(art, { right: width - EDGE - 30, bottom: height - EDGE - 26, top: height - EDGE - 236, maxHeight: 210 });
    const month = nights.cells.length > 7;
    // A week's seven squares span the card's full measure, edge to edge.
    const cell = month ? 58 : 104, pitch = month ? 68 : (w - 104) / 6;
    const gridTop = month ? 430 : 450;
    const radius = Math.max(8, Math.min(month ? 14 : 22, theme.radius));
    /** How strongly each level is inked; level 0 is an empty square. */
    const depth = [0, 0.36, 0.56, 0.78, 1];

    // Weekday initials over the columns.
    ctx.font = `700 22px ${theme.ui}`;
    ctx.fillStyle = ink(theme.muted);
    ctx.textAlign = 'center';
    nights.weekdays.forEach((name, index) => ctx.fillText(name, LEFT + index * pitch + cell / 2, gridTop - 16));
    let gridBottom = gridTop;
    nights.cells.forEach((day, index) => {
        const slot = index + nights.offset;
        const x = LEFT + (slot % 7) * pitch, y = gridTop + Math.floor(slot / 7) * pitch;
        gridBottom = Math.max(gridBottom, y + cell);
        ctx.beginPath(); ctx.roundRect(x, y, cell, cell, radius);
        if (day.future) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = ink(theme.line, 0.6);
            ctx.stroke();
        } else {
            ctx.fillStyle = day.level ? ink(theme.accent, depth[day.level]) : ink(theme.line, theme.dark ? 0.24 : 0.26);
            ctx.fill();
        }
        // The date sits in the square; on the deepest ink it switches to the panel's colour.
        ctx.font = `700 ${month ? 20 : 30}px ${theme.ui}`;
        ctx.fillStyle = day.level >= 3 ? ink(theme.panel) : ink(day.future ? theme.muted : theme.text, day.future ? 0.6 : 0.85);
        ctx.fillText(String(day.number), x + cell / 2, y + cell / 2 + (month ? 7 : 11));
    });
    ctx.textAlign = 'left';

    // The streak and the biggest day: beside a month's grid, under a week's row.
    nights.facts.forEach(([value, caption], index) => {
        const x = month ? LEFT + 7 * pitch + 44 : LEFT + index * (w / 2);
        const y = month ? gridTop + 50 + index * 150 : gridBottom + 116;
        const room = month ? right - x : w / 2 - 30;
        ctx.fillStyle = ink(theme.ink);
        ctx.fillText(fitSize(ctx, value, room, `${theme.displayWeight}`, 62, theme.display, 38), x - 2, y);
        ctx.font = `500 25px ${theme.ui}`;
        ctx.fillStyle = ink(theme.muted);
        ctx.fillText(fit(ctx, caption, room), x, y + 40);
    });

    // The shape of a day: twenty-four bars, midnight to midnight.
    const stripWidth = month ? 7 * pitch - (pitch - cell) : (figure ? figure.x - LEFT - 36 : w);
    const stripBottom = height - EDGE - 108;
    const stripTall = Math.max(40, Math.min(month ? 62 : 120, stripBottom - gridBottom - (month ? 24 : 190)));
    const step = stripWidth / 24;
    nights.hours.forEach((share, hour) => {
        const tall = 6 + share * (stripTall - 6);
        ctx.fillStyle = share ? ink(theme.accent, 0.3 + share * 0.7) : ink(theme.line, theme.dark ? 0.45 : 0.55);
        ctx.beginPath(); ctx.roundRect(LEFT + hour * step + step * 0.16, stripBottom - tall, step * 0.68, tall, Math.min(5, step * 0.3)); ctx.fill();
    });
    drawArt(ctx, figure, theme);
    footer(ctx, size, theme, nights.hoursNote, '', figure ? figure.x - LEFT - 20 : 0);
}

/**
 * One finished card.
 * @param {'story'|'nights'|'report'|'faceoff'|'phrases'} kind
 * @param {ReturnType<import('./model.js').buildCards>} view
 * @param {CardTheme} theme
 * @param {HTMLCanvasElement} [canvas] Reused when given.
 * @param {CardArt|null} [art] Mikan-chan's pictures (`loadArt()`); null draws the card without her.
 * @returns {HTMLCanvasElement|null} null when this card has nothing to show (no report subject).
 */
export function paintCard(kind, view, theme, canvas = document.createElement('canvas'), art = null) {
    if (kind === 'report' && !view.report) return null;
    if (kind === 'nights' && !view.nights) return null;
    if (kind === 'faceoff' && !view.faceoff) return null;
    const { width, height } = CARD_SIZES[kind];
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.textBaseline = 'alphabetic';
    if (kind === 'story') drawStory(ctx, view.story, theme, art);
    else if (kind === 'nights') drawNights(ctx, /** @type {any} */ (view.nights), theme, art);
    else if (kind === 'report') drawReport(ctx, /** @type {any} */ (view.report), theme, art);
    else if (kind === 'faceoff') drawFaceoff(ctx, /** @type {any} */ (view.faceoff), theme, art);
    else drawPhrases(ctx, view.phrases, theme, art);
    return canvas;
}
