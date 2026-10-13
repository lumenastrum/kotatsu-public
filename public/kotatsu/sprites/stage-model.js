/**
 * Sprites — the stage model (Pictures slice F, `docs/handoffs/pictures-slice-f.md` "The staging
 * spec"; the numbers are prototype v5's, to be tuned in the app).
 *
 * Pure: no DOM, no core imports. In: the stage box, the reading column inside it, the cast in
 * home order, who is speaking, who spoke when. Out: one placed figure per seated character and
 * the bench. The component only paints what this returns.
 *
 * - Stage (1:1): one figure in the left wing. Duet (2): one per wing. Wings (3+): each wing has
 *   a front and a back seat; a wing holds two, the rest wait on the bench.
 * - Home wings alternate by member order (1 left, 2 right, 3 left…); a character never crosses
 *   the column.
 * - The most recent speaker on a wing sits in front; a bench character who speaks takes the seat
 *   of whoever on that wing spoke least recently. The caller passes recency from FINISHED replies
 *   only, so seats never move while a reply streams; lighting follows `speaker`, which may be the
 *   one writing now.
 * - Calm: seats never swap (front/back by member order), light only.
 */

/** @type {Readonly<Record<string, number>>} */
export const STAGE = Object.freeze({
    /** Below this wing width there is no stage (the phone spotlight takes over). */
    minWing: 150,
    /** Seat pitch: wing × 0.62, clamped to [minWing, max(maxPitch, the pitch at which the height cap governs)]. */
    pitchOfWing: 0.62,
    maxPitch: 300,
    /** Figure box height: pitch × 2.45, at most 92 % of the stage. */
    heightOfPitch: 2.45,
    heightOfStage: 0.92,
    /** Knees up: the sprite is drawn at 132 % of the box height, top aligned. */
    crop: 1.32,
    /** Gap between a lone figure and the column. */
    soloGap: 12,
    /** Front seat centre: 0.32 × pitch outside the column; back seat a further 0.56 × pitch out. */
    front: 0.32,
    back: 0.56,
    backScale: 0.86,
    speakerScale: 1.04,
    lift: 6,
    brightSpeaker: 1,
    brightFront: 0.66,
    brightBack: 0.52,
    /** Nobody speaking (narration, the user's turn): the front row rests, slightly dimmed. */
    brightIdle: 0.88,
    saturateOther: 0.6,
    saturateIdle: 0.9,
});

/** Sprite canvas aspect (width / height) when a file's own is not known yet (832 × 1216). */
export const DEFAULT_ASPECT = 832 / 1216;

/**
 * Share of the sprite's bottom row that is opaque from which the art is a bust / half-body (the figure runs off its
 * own canvas) rather than a full body standing on empty floor. Measured 2026-10-12 on every set we have: full-body
 * sets 0–21 % (feet, or floor rows below them), bust sets 67–98 %.
 */
export const BUST_COVERAGE = 0.35;

/**
 * How much of the sprite the box shows. A full body is drawn at {@link STAGE.crop} (knees up); a bust is already
 * cropped by its artist, and knees-up would cut the bottom quarter of the art (the chest), so it is shown whole.
 * Decided once per CHARACTER (from its neutral sprite), never per expression, so a face change never resizes the
 * figure.
 * @param {number|null|undefined} bottomCoverage opaque share of the sprite's bottom row, 0..1; unknown → knees up
 * @returns {number}
 */
export function cropFor(bottomCoverage) {
    return Number(bottomCoverage) >= BUST_COVERAGE ? 1 : STAGE.crop;
}

/**
 * Share of a sprite's leftmost / rightmost column that is opaque from which its art counts as cut by the canvas edge
 * there (a wing or a lock of hair running off the side). Remielle's wing: 54 % of the right edge, Velina's hair 28 %
 * of the left; the full-body lab sets pass the crop gate with 0 %. A hairline brush of 1–2 % is not a cut.
 */
export const SIDE_CUT = 0.03;

/**
 * Which sides of a sprite run off its canvas. The stage fades those sides out: once a figure stands clear of the
 * column (2026-10-12) a cut edge would otherwise show as a hard vertical line.
 * @param {{leftCoverage?: number|null, rightCoverage?: number|null}} frame
 * @returns {{left: boolean, right: boolean}}
 */
export function cutSides(frame) {
    return { left: Number(frame?.leftCoverage) >= SIDE_CUT, right: Number(frame?.rightCoverage) >= SIDE_CUT };
}

/**
 * @typedef {object} StageMember
 * @property {string} id the character's avatar file (stable across renames of the display name)
 * @property {number} [aspect] the sprite's width / height
 * @property {number} [scale] the card's framing knob (height), 1 = as drawn
 * @property {number} [offset] the card's framing knob (vertical), a fraction of the figure height, + = down
 * @property {number} [crop] the sprite is painted at crop × the box height, top aligned ({@link cropFor}); default STAGE.crop
 */

/**
 * @typedef {object} StageFigure
 * @property {string} id
 * @property {'left'|'right'} side
 * @property {0|1} row 0 front, 1 back
 * @property {number} x left edge of the box, px from the stage's left
 * @property {number} width
 * @property {number} height
 * @property {number} crop the sprite is painted at crop × height, top aligned
 * @property {number} scale
 * @property {number} dy px, + = down (lift is negative)
 * @property {number} brightness
 * @property {number} saturate
 * @property {number} z
 * @property {boolean} speaking
 */

/**
 * @typedef {object} StageLayout
 * @property {'stage'|'duet'|'wings'|'none'} mode
 * @property {StageFigure[]} figures
 * @property {{left: string[], right: string[]}} bench
 * @property {number} pitch
 */

/**
 * @param {number} value
 * @param {number} low
 * @param {number} high
 */
function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

/**
 * The stage's mode for a cast: one figure (or a one-on-one chat) is Stage, two are a Duet, more fill the Wings.
 * @param {number} count members with a sprite
 * @param {boolean} [solo]
 * @returns {'stage'|'duet'|'wings'}
 */
export function stageMode(count, solo = false) {
    return solo || count === 1 ? 'stage' : count === 2 ? 'duet' : 'wings';
}

/** A card's framing pin (`data.extensions.kotatsu.sprites.pin`): `auto` lets the layout choose. */
export const FRAMING_PINS = Object.freeze(['auto', 'bust', 'full']);

/**
 * Which of a character's two sets the stage shows: the card's pin when that set exists; else the bust in Stage and
 * Duet (a lone figure beside the column reads best as a bust) and the full body in the Wings (rows of figures);
 * else whichever set the card has.
 * @param {'stage'|'duet'|'wings'} mode
 * @param {string} pin `auto` | `bust` | `full`
 * @param {{bust: boolean, full: boolean}} has which sets have sprites
 * @returns {'bust'|'full'|null} null when the card has neither
 */
export function pickFraming(mode, pin, has) {
    const want = pin === 'bust' || pin === 'full' ? pin : mode === 'wings' ? 'full' : 'bust';
    if (has[want]) return want;
    const other = want === 'bust' ? 'full' : 'bust';
    return has[other] ? other : null;
}

/**
 * @param {number} index member order
 * @returns {'left'|'right'}
 */
export function homeWing(index) {
    return index % 2 === 0 ? 'left' : 'right';
}

/**
 * Who sits where: per wing, most recent speaker first (never-spoken keep member order after
 * everyone who has spoken), two seats, the rest on the bench.
 * @param {string[]} ids home order
 * @param {Record<string, number>} recency id → when they last finished a reply (higher = later)
 * @param {boolean} [calm]
 * @returns {{seats: Map<string, {side: 'left'|'right', row: 0|1}>, bench: {left: string[], right: string[]}}}
 */
export function seatCast(ids, recency, calm = false) {
    /** @type {Map<string, {side: 'left'|'right', row: 0|1}>} */
    const seats = new Map();
    const bench = { left: /** @type {string[]} */ ([]), right: /** @type {string[]} */ ([]) };
    /** @type {{left: string[], right: string[]}} */
    const wings = { left: [], right: [] };
    ids.forEach((id, index) => wings[homeWing(index)].push(id));
    for (const side of /** @type {const} */ (['left', 'right'])) {
        const members = wings[side];
        const spoke = (/** @type {string} */ id) => Number.isFinite(recency?.[id]) ? recency[id] : -Infinity;
        const byRecency = [...members].sort((a, b) => (spoke(b) - spoke(a)) || (members.indexOf(a) - members.indexOf(b)));
        const seated = byRecency.slice(0, 2);
        for (const id of byRecency.slice(2)) bench[side].push(id);
        // Calm: whoever is seated keeps member order front/back, so nobody swaps on a line.
        const order = calm ? members.filter(id => seated.includes(id)) : seated;
        order.forEach((id, row) => seats.set(id, { side, row: /** @type {0|1} */ (row) }));
    }
    return { seats, bench };
}

/**
 * Lays out the stage.
 * @param {object} args
 * @param {number} args.width stage width
 * @param {number} args.height stage height
 * @param {number} args.columnLeft reading column's left edge, px from the stage's left
 * @param {number} args.columnRight reading column's right edge
 * @param {StageMember[]} args.members home order
 * @param {boolean} [args.solo] a one-on-one chat (Stage) rather than a scene
 * @param {string|null} [args.speaker] who to light (may be writing now); null lights no one
 * @param {Record<string, number>} [args.recency] finished replies only
 * @param {boolean} [args.calm]
 * @returns {StageLayout}
 */
export function layoutStage({ width, height, columnLeft, columnRight, members, solo = false, speaker = null, recency = {}, calm = false }) {
    const none = /** @type {StageLayout} */ ({ mode: 'none', figures: [], bench: { left: [], right: [] }, pitch: 0 });
    const list = Array.isArray(members) ? members.filter(m => m && typeof m.id === 'string' && m.id) : [];
    const wing = Math.min(columnLeft, width - columnRight);
    if (!list.length || !(wing >= STAGE.minWing) || !(height > 0)) return none;

    const mode = stageMode(list.length, solo);
    // For a lone figure per wing (Stage, Duet) maxPitch is only a floor: on a tall stage the cap rises until the
    // height rule (92 % of the stage) governs, so a widescreen grows its figures instead of stopping at
    // 300 × 2.45 = 735 px. Wings keep the fixed cap: their seats are spaced BY the pitch, and bigger figures there
    // would stack up behind the column.
    const pitchCap = mode === 'wings' ? STAGE.maxPitch : Math.max(STAGE.maxPitch, height * STAGE.heightOfStage / STAGE.heightOfPitch);
    const pitch = clamp(wing * STAGE.pitchOfWing, STAGE.minWing, pitchCap);
    const boxHeight = Math.min(height * STAGE.heightOfStage, pitch * STAGE.heightOfPitch);
    const ids = list.map(m => m.id);
    const { seats, bench } = seatCast(ids, recency, calm);
    const anyone = speaker !== null && seats.has(speaker);

    /** @type {StageFigure[]} */
    const figures = [];
    for (const member of list) {
        const seat = seats.get(member.id);
        if (!seat) continue;
        const left = seat.side === 'left';
        const outward = left ? -1 : 1;
        const front = seat.row === 0;
        const speaking = member.id === speaker;
        const lone = mode === 'stage' || mode === 'duet';
        const frontCentre = left ? columnLeft - pitch * STAGE.front : columnRight + pitch * STAGE.front;
        const aspect = Number(member.aspect) > 0 ? Number(member.aspect) : DEFAULT_ASPECT;
        const crop = Number(member.crop) > 0 ? Number(member.crop) : STAGE.crop;
        const boxWidth = boxHeight * crop * aspect;
        // A lone figure (Stage, Duet) stands beside the column: its inner edge one gap from the text when the wing
        // has room (a widescreen used to leave most of the wing empty while the figure hid behind the column,
        // measured 2026-10-12 at 3440 × 1278); else as far out as the screen edge allows; else the seat as before.
        // Continuous in every input, so nothing jumps while a window resizes. The figure is scaled about its bottom
        // centre by the card's height knob, so the edges use the knob-scaled width (a 0.7 knob otherwise left a
        // 170 px gap at 3440); the speaker's 1.04 pop is left out so a turn change never slides anyone sideways.
        const knob = Number(member.scale) > 0 ? Number(member.scale) : 1;
        const shown = boxWidth * knob;
        const seatCentre = left ? columnLeft - pitch / 2 - STAGE.soloGap : columnRight + pitch / 2 + STAGE.soloGap;
        const flushCentre = left ? columnLeft - STAGE.soloGap - shown / 2 : columnRight + STAGE.soloGap + shown / 2;
        const edgeCentre = left ? shown / 2 : width - shown / 2;
        const loneCentre = left
            ? Math.max(flushCentre, Math.min(seatCentre, edgeCentre))
            : Math.min(flushCentre, Math.max(seatCentre, edgeCentre));
        const centre = lone ? loneCentre : front ? frontCentre : frontCentre + outward * pitch * STAGE.back;
        const offset = Number.isFinite(member.offset) ? Number(member.offset) * boxHeight : 0;
        const brightness = speaking ? STAGE.brightSpeaker : !anyone && front ? STAGE.brightIdle : front ? STAGE.brightFront : STAGE.brightBack;
        figures.push({
            id: member.id,
            side: seat.side,
            row: seat.row,
            x: Math.round(centre - boxWidth / 2),
            width: Math.round(boxWidth),
            height: Math.round(boxHeight),
            crop,
            scale: Math.round((speaking ? STAGE.speakerScale : front ? 1 : STAGE.backScale) * knob * 1000) / 1000,
            dy: Math.round(offset - (speaking && !calm ? STAGE.lift : 0)),
            brightness,
            saturate: speaking ? 1 : !anyone && front ? STAGE.saturateIdle : STAGE.saturateOther,
            z: speaking ? 5 : front ? 3 : 2,
            speaking,
        });
    }
    return { mode, figures, bench, pitch: Math.round(pitch) };
}
