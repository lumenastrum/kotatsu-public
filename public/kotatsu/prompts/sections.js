/**
 * Prompt section model — slice A of the prompt-manager rework (`docs/prompt-manager-v0.md`).
 *
 * Pure, DOM-free, imports nothing. Given a preset's `prompts[]` and its RESOLVED `100001`
 * order array, it derives a section tree that every later slice renders against.
 *
 * ## What derivation is
 *
 * Derivation runs over the ORDER, because the order is what renders. `prompts[]` supplies
 * names and markers only. Prompts with no order entry are reported in `unlisted` (both
 * acceptance fixtures ship exactly one — `━+ Optional Toggles` — on purpose); order entries
 * with no prompt are reported in `unknownOrder` and are NOT put in the tree, because there is
 * nothing to render. The model never invents an order entry.
 *
 * ## Tiers (first hit wins)
 *
 * | Tier | Fires when |
 * |---|---|
 * | `override` | `override` parses as a valid `extensions.kotatsu.sections` v1 bag |
 * | `sigil` | ≥2 structural sigil tokens (banner / sub-group / span open / span close) |
 * | `legacy` | ≥1 legacy banner (`=+`, `⭐─+`, `━+`, plus validated `extraPatterns`) |
 * | `flat` | otherwise — one honest flat section |
 *
 * ## The sigil table (explicit codepoints — the dingbat numerals are Unicode category `No`,
 * so a `\p{N}` shortcut misclassifies every radio option; the ranges are matched literally)
 *
 * | Leading token | Codepoints | Meaning |
 * |---|---|---|
 * | `━+` | U+2501 U+002B | section banner |
 * | `‒+` | U+2012 U+002B | sub-group (radio group when it holds dingbat options) |
 * | `┌`/`└`, `⌜`/`⌞`, `⌈`/`⌊` | U+250C/U+2514, U+231C/U+231E, U+2308/U+230A | span open/close |
 * | `\|┎`/`\|┖` | U+007C U+250E / U+007C U+2516 | span open/close, nested |
 * | `\|`, `\|\|` | U+007C runs | depth leaf (depth = run length) |
 * | `➊`–`➍`, `➀`–`➅` | U+278A–U+278D, U+2780–U+2785 (see `DINGBAT_RANGES`) | radio option |
 * | any other single non-ASCII, non-letter, non-digit glyph + space | — | badged leaf |
 * | *(no sigil)* | — | plain leaf (`Chat Examples`, `Chat History`) |
 *
 * Spans pair by family, nearest-open-first, and never straddle a banner or a sub-group
 * boundary. Unmatched opens and closes degrade to ordinary leaves — a match is never guessed.
 *
 * ## Ids
 *
 * Derived containers get deterministic ids. A section is `d:<n>:<slug>`; nested containers are
 * `<parentId>/<prefix>:<n>:<slug>` with `g` = group, `s` = span, `p` = prompt row. `<n>` is a
 * DISAMBIGUATION counter among siblings that would otherwise mint the same id — NOT the
 * positional index — so reordering other sections never renumbers this one (the stability
 * requirement). `<slug>` is the normalized label for containers and the raw identifier for
 * prompt rows. An empty slug becomes `~`, which is also the slug of the implicit sections
 * (the run before the first banner, the single flat-tier section, the override tier's
 * unassigned bucket).
 *
 * ## `extensions.kotatsu.sections` — bag schema v1
 *
 * The one sanctioned passthrough key (data-contract §4.1). Written by slices B/C, never
 * authored automatically, and NEVER on the two acceptance fixtures.
 *
 * ```jsonc
 * {
 *   "version": 1,                       // optional; only 1 is accepted
 *   "unassigned": "append",             // optional; "append" (default) | "first"
 *   "order": ["intro", "engine"],       // optional; section render order, defaults to key order
 *   "sections": {
 *     "intro": {
 *       "label": "Read me first",       // optional, defaults to ""
 *       "exclusive": false,             // optional; true = radio group (slice C enforcement)
 *       "collapsedDefault": false,      // optional
 *       "members": ["<identifier>", …]  // required array; THIS array is the member order
 *     }
 *   }
 * }
 * ```
 *
 * Rules: section ids are the object keys and are opaque strings (authored ids are uuids per
 * decision 4); members are prompt identifiers, never display names; a member claimed by an
 * earlier section is not claimed twice; members that are not in the order are dropped; and
 * identifiers no section claims land in an implicit trailing (or leading) section IN ORDER
 * SEQUENCE. There is deliberately no "hide" policy — a prompt is hidden by `enabled: false`,
 * never by being structurally unreachable. v1 sections are flat: no nested sections, no spans.
 * `validateSectionsOverride()` normalizes and reports; it never throws.
 */

const OVERRIDE_VERSION = 1;

/** Section banner `━+`: U+2501 U+002B. Escaped — U+2501 is easy to confuse with U+2500/U+2015. */
const BANNER_TOKEN = String.fromCodePoint(0x2501, 0x002B);
/** Sub-group header `‒+`: U+2012 U+002B. Escaped — U+2012 renders like a hyphen. */
const SUBGROUP_TOKEN = String.fromCodePoint(0x2012, 0x002B);

/**
 * Span open/close glyph pairs, in match order. `pipebox` (`|┎` / `|┖`) is listed first because
 * its open glyph starts with `|`, which the pipe-depth rule would otherwise want.
 * @type {ReadonlyArray<{family: string, open: string, close: string}>}
 */
const SPAN_FAMILIES = Object.freeze([
    { family: 'pipebox', open: String.fromCodePoint(0x007C, 0x250E), close: String.fromCodePoint(0x007C, 0x2516) },
    { family: 'box', open: String.fromCodePoint(0x250C), close: String.fromCodePoint(0x2514) },
    { family: 'corner', open: String.fromCodePoint(0x231C), close: String.fromCodePoint(0x231E) },
    { family: 'ceiling', open: String.fromCodePoint(0x2308), close: String.fromCodePoint(0x230A) },
]);

/**
 * Dingbat numeral ranges that mark a radio option.
 *
 * The doc measures U+2780–U+2785 (`➀`–`➅`) and U+278A–U+278D (`➊`–`➍`) on the fixtures. The
 * whole dingbat-digit block is accepted instead, because a seventh option (`➆`, U+2786) is the
 * same character class and would otherwise fall through to the badge rule and silently stop
 * being a radio member. Nothing outside these blocks is affected.
 * @type {ReadonlyArray<[number, number]>}
 */
const DINGBAT_RANGES = Object.freeze([
    [0x2776, 0x277F], // ❶–❿ negative circled
    [0x2780, 0x2789], // ➀–➈ circled sans-serif (doc range: 0x2780–0x2785)
    [0x278A, 0x2793], // ➊–➓ negative circled sans-serif (doc range: 0x278A–0x278D)
]);

/** Legacy banner alternatives: `=+`, `⭐─+`, `━+`. */
const LEGACY_BANNER_PARTS = Object.freeze([
    '=+',
    String.fromCodePoint(0x2B50, 0x2500) + '+',
    String.fromCodePoint(0x2501) + '+',
]);
/** Legacy sub-header, e.g. `<🩸| Realism Filters >`. */
const LEGACY_SUBHEADER_PATTERN = /^<\s*(.+?)\s*>$/;
/** A cleaned banner label matching this marks its section exclusive (decision 6). */
const PICK_ONE_PATTERN = /\bpick one\b/i;
/**
 * A row that says it is one of a set, in its own name: `[Core] User: Agency-Lite (Pick 1)`.
 * Sola V2's convention — no header row, just the tag on each option.
 */
const PICK_ONE_TAG = /\(\s*pick\s*(?:1|one)\s*\)/i;
/** Label for a tagged run whose names share nothing to call it by. */
const PICK_ONE_FALLBACK_LABEL = 'Pick one';
/**
 * A banner may carry glyphs in front of its divider (`🧘=Pick Internal States👇 ====`). At most
 * this many codepoints are looked through, and only non-ASCII, non-letter, non-digit ones.
 */
const MAX_BANNER_LEAD_POINTS = 8;
/** …and only when the name also ENDS in a run of the divider this long: `🧘=foo` is a name. */
const MIN_BANNER_CLOSING_RUN = 3;

/** U+FE0E / U+FE0F — variation selectors, stripped before a badge glyph is measured. */
const VARIATION_SELECTORS = new RegExp('[' + String.fromCodePoint(0xFE0E, 0xFE0F) + ']', 'g');
/** U+200D — zero-width joiner, so a joined emoji still counts as one badge glyph. */
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200D);

const MAX_SLUG_LENGTH = 64;

/**
 * @typedef {object} PromptRecord
 * @property {string} identifier
 * @property {string} [name] Display label.
 * @property {boolean} [marker] Engine-supplied slot (data-contract §4.2).
 * @property {boolean} [system_prompt] One of core's own prompts: the markers, plus Main,
 *   Auxiliary, Post-History and Enhance Definitions.
 */

/**
 * @typedef {object} OrderEntry
 * @property {string} identifier
 * @property {boolean} [enabled]
 */

/**
 * @typedef {object} Classification
 * @property {'banner'|'subgroup'|'span-open'|'span-close'|'option'|'pipe'|'badge'|'plain'} type
 * @property {string} label Name with the leading token removed.
 * @property {string} [sigil] The raw leading token.
 * @property {string} [family] Span family, for `span-open` / `span-close`.
 * @property {number} [depth] Pipe run length, for `pipe`.
 */

/**
 * @typedef {object} SectionNode
 * @property {'group'|'span'|'leaf'|'option'} kind
 * @property {string} id
 * @property {string} label
 * @property {number} depth Nesting depth inside the section; direct children are 0.
 * @property {string} [identifier] The prompt this node's own row is.
 * @property {string} [name] The raw `prompts[].name` (search reads this, not `label`).
 * @property {boolean} [enabled] SNAPSHOT of the order entry — see the note on `deriveSections`.
 * @property {boolean} [marker]
 * @property {boolean} [builtin] One of core's built-in prompts that is not a marker (Main,
 *   Auxiliary, Post-History, Enhance Definitions). Never swept into a radio group.
 * @property {string} [sigil]
 * @property {string} [closeIdentifier] Span only: the closing row's prompt.
 * @property {boolean} [exclusive] Group only.
 * @property {SectionNode[]} [children] Group and span only.
 */

/**
 * @typedef {object} Section
 * @property {string} id
 * @property {string} label
 * @property {'banner'|'flat'} kind `flat` = implicit container with no header row.
 * @property {boolean} exclusive
 * @property {boolean} collapsedDefault
 * @property {string} [identifier] The banner prompt, when the section came from one.
 * @property {string} [name]
 * @property {boolean} [enabled]
 * @property {string} [sigil]
 * @property {SectionNode[]} children
 */

/**
 * @typedef {object} SectionTree
 * @property {'override'|'sigil'|'legacy'|'flat'} tier
 * @property {Section[]} sections
 * @property {string[]} unlisted `prompts[]` entries with no order entry.
 * @property {string[]} unknownOrder Order entries with no `prompts[]` entry (never in the tree).
 * @property {string[]} duplicateOrder Identifiers the order lists more than once.
 * @property {{sigil: number, legacy: number}} signals Token counts the tier choice was made on.
 */

/**
 * @typedef {object} OverrideSectionSpec
 * @property {string} label
 * @property {boolean} exclusive
 * @property {boolean} collapsedDefault
 * @property {string[]} members
 */

/**
 * @typedef {object} NormalizedOverride
 * @property {1} version
 * @property {'append'|'first'} unassigned
 * @property {string[]} order
 * @property {Record<string, OverrideSectionSpec>} sections
 */

/**
 * @typedef {object} OverrideValidation
 * @property {boolean} ok
 * @property {NormalizedOverride|null} value
 * @property {string[]} errors
 * @property {string[]} warnings
 */

/**
 * @typedef {object} OrderRow
 * @property {string} identifier
 * @property {boolean} enabled
 * @property {string} name
 * @property {boolean} marker
 * @property {boolean} builtin
 * @property {Classification} cls
 */

/**
 * Normalizes a label into an id slug. Letters and numbers survive (in any script); everything
 * else collapses to `-`. An empty result becomes `~`, the slug of the implicit sections.
 * @param {string} label Label to normalize.
 * @returns {string}
 */
function slugify(label) {
    const slug = String(label ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/g, '');
    return slug || '~';
}

/**
 * Makes an id minter. Ids are `<parent>/<prefix>:<n>:<slug>` (no `<parent>/` at the top
 * level); `n` counts prior siblings that minted the same prefix+slug, so an id only ever moves
 * when a sibling with the SAME label is added or removed before it.
 * @returns {(parentId: string, prefix: string, slug: string) => string}
 */
function makeIdMint() {
    /** @type {Map<string, number>} */
    const seen = new Map();
    return (parentId, prefix, slug) => {
        const key = `${parentId}|${prefix}|${slug}`;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        const local = `${prefix}:${n}:${slug}`;
        return parentId ? `${parentId}/${local}` : local;
    };
}

/**
 * True when the codepoint is a dingbat numeral (radio option marker).
 * @param {number} codePoint Codepoint to test.
 * @returns {boolean}
 */
function isDingbatNumeral(codePoint) {
    for (const [start, end] of DINGBAT_RANGES) {
        if (codePoint >= start && codePoint <= end) return true;
    }
    return false;
}

/**
 * True when a leading token is a single badge glyph — one non-ASCII, non-letter, non-digit
 * grapheme (variation selectors ignored, ZWJ sequences allowed).
 * @param {string} token Leading token.
 * @returns {boolean}
 */
function isBadgeToken(token) {
    const cleaned = token.replace(VARIATION_SELECTORS, '');
    if (!cleaned) return false;
    for (const part of cleaned.split(ZERO_WIDTH_JOINER)) {
        const points = Array.from(part);
        if (points.length !== 1) return false;
        const glyph = points[0];
        const codePoint = glyph.codePointAt(0) ?? 0;
        if (codePoint < 0x80) return false;
        if (/[\p{L}\p{Nd}]/u.test(glyph)) return false;
    }
    return true;
}

/**
 * Classifies a prompt name by its leading sigil token. Pure and exported so slices B/C can
 * explain a row without re-deriving the tree.
 * @param {string} rawName Prompt display name.
 * @returns {Classification}
 */
export function classifySigil(rawName) {
    const name = String(rawName ?? '').trim();
    if (!name) return { type: 'plain', label: '' };

    if (name.startsWith(BANNER_TOKEN)) {
        return { type: 'banner', sigil: BANNER_TOKEN, label: name.slice(BANNER_TOKEN.length).trim() };
    }
    if (name.startsWith(SUBGROUP_TOKEN)) {
        return { type: 'subgroup', sigil: SUBGROUP_TOKEN, label: name.slice(SUBGROUP_TOKEN.length).trim() };
    }
    for (const span of SPAN_FAMILIES) {
        if (name.startsWith(span.open)) {
            return { type: 'span-open', family: span.family, sigil: span.open, label: name.slice(span.open.length).trim() };
        }
        if (name.startsWith(span.close)) {
            return { type: 'span-close', family: span.family, sigil: span.close, label: name.slice(span.close.length).trim() };
        }
    }

    const firstPoint = name.codePointAt(0) ?? 0;
    if (isDingbatNumeral(firstPoint)) {
        const glyph = String.fromCodePoint(firstPoint);
        return { type: 'option', sigil: glyph, label: name.slice(glyph.length).trim() };
    }

    const pipes = /^(\|+)(?:\s+|$)/.exec(name);
    if (pipes) {
        return { type: 'pipe', sigil: pipes[1], depth: pipes[1].length, label: name.slice(pipes[0].length).trim() };
    }

    const spaceAt = name.search(/\s/);
    if (spaceAt > 0) {
        const token = name.slice(0, spaceAt);
        if (isBadgeToken(token)) {
            return { type: 'badge', sigil: token, label: name.slice(spaceAt).trim() };
        }
    }
    return { type: 'plain', label: name };
}

/**
 * Builds the legacy banner pattern, merging user-supplied fragments into the alternation.
 * Each fragment is compiled on a throwaway `RegExp` and skipped silently if it does not
 * compile — or if it matches the empty string, which would turn every prompt into a banner.
 * @param {unknown} extraPatterns User fragments.
 * @returns {RegExp}
 */
function buildLegacyBannerPattern(extraPatterns) {
    const parts = [...LEGACY_BANNER_PARTS];
    if (Array.isArray(extraPatterns)) {
        for (const fragment of extraPatterns) {
            if (typeof fragment !== 'string') continue;
            const trimmed = fragment.trim();
            if (!trimmed) continue;
            const wrapped = `(?:${trimmed})`;
            let probe;
            try {
                probe = new RegExp(`^${wrapped}`);
            } catch {
                continue;
            }
            if (probe.test('')) continue;
            parts.push(wrapped);
        }
    }
    return new RegExp(`^(?:${parts.join('|')})`);
}

/**
 * Matches a legacy banner, with or without glyphs in front of its divider.
 *
 * `=Pick one POV 👇 ====` matches as it always did. `🧘=Pick Internal States👇 ====` matches too:
 * the shortest run of leading glyphs is looked through, but only when the name also closes with
 * a run of the same divider, so a badge in front of a single `=` stays an ordinary name.
 * Freaky Frankenstein 5.4 named two of its banners this way and they were read as rows, which
 * let the banner before them run on to the end of the list.
 * @param {string} rawName Prompt name.
 * @param {RegExp} pattern The banner alternation, anchored at the start.
 * @returns {{lead: string, body: string, token: string}|null} `lead` is the glyphs in front,
 *   `body` the name from the divider on, `token` the matched divider.
 */
function matchLegacyBanner(rawName, pattern) {
    const name = String(rawName ?? '').trim();
    const direct = pattern.exec(name);
    if (direct) return { lead: '', body: name, token: direct[0] };

    const points = Array.from(name);
    let lead = '';
    for (let i = 0; i < points.length && i < MAX_BANNER_LEAD_POINTS; i++) {
        const point = points[i];
        if ((point.codePointAt(0) ?? 0) < 0x80 || /[\p{L}\p{Nd}]/u.test(point)) return null;
        lead += point;
        const body = name.slice(lead.length).trimStart();
        const match = pattern.exec(body);
        if (!match) continue;
        const divider = new Set(Array.from(match[0]));
        let run = 0;
        for (let at = body.length - 1; at >= 0 && divider.has(body[at]); at--) run++;
        return run >= MIN_BANNER_CLOSING_RUN ? { lead, body, token: match[0] } : null;
    }
    return null;
}

/**
 * Names a run of rows tagged "(Pick 1)" by what their names share: the leading words
 * (`User: Agency-Lite` / `User: Embellishment` → `User`), else the trailing ones
 * (`Anti-Slop` / `Lite Anti-Slop` → `Anti-Slop`). A leading `[Tag]` and the pick tag itself are
 * not part of the name.
 * @param {string[]} names Raw prompt names, two or more.
 * @returns {string} The label; {@link PICK_ONE_FALLBACK_LABEL} when they share nothing.
 */
function labelTaggedRun(names) {
    const words = names.map((name) => {
        const tagAt = name.search(PICK_ONE_TAG);
        return (tagAt === -1 ? name : name.slice(0, tagAt))
            .replace(/^\s*\[[^\]]*\]\s*/, '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
    });
    const shortest = Math.min(...words.map(list => list.length));
    let head = 0;
    while (head < shortest && words.every(list => list[head] === words[0][head])) head++;
    let tail = 0;
    while (tail < shortest - head && words.every(list => list[list.length - 1 - tail] === words[0][words[0].length - 1 - tail])) tail++;
    const shared = head > 0 ? words[0].slice(0, head) : words[0].slice(words[0].length - tail);
    const label = shared.join(' ').replace(/[\s:–—-]+$/, '').trim();
    return label || PICK_ONE_FALLBACK_LABEL;
}

/**
 * Legacy label cleaning: strip the matched leading token, then a trailing run built only from
 * that token's own characters (Nemo's algorithm — the run is symmetric in CLASS, not length,
 * as `=Pick one POV 👇 ================` shows). A `+` glued straight onto the divider run is
 * dropped too, so a lone `━+` banner that misses the sigil tier still cleans to a real label.
 * @param {string} name Raw prompt name.
 * @param {string} token The matched leading token.
 * @returns {string}
 */
function cleanLegacyLabel(name, token) {
    let rest = name.trim().slice(token.length);
    if (rest.startsWith('+')) rest = rest.slice(1);
    const characters = new Set(Array.from(token));
    rest = rest.replace(/\s+$/, '');
    let end = rest.length;
    while (end > 0 && characters.has(rest[end - 1])) end--;
    return rest.slice(0, end).trim();
}

/**
 * Pairs span opens with closes inside one body. Nearest open of the SAME family wins; opens
 * left above a match, and closes with no open, stay unpaired and degrade to leaves.
 * @param {OrderRow[]} rows Rows of a single body.
 * @returns {{openOf: Map<number, number>, closeOf: Map<number, number>}}
 */
function pairSpans(rows) {
    /** @type {Map<number, number>} */
    const openOf = new Map();
    /** @type {Map<number, number>} */
    const closeOf = new Map();
    /** @type {Array<{index: number, family: string}>} */
    const stack = [];
    rows.forEach((row, index) => {
        if (row.cls.type === 'span-open') {
            stack.push({ index, family: String(row.cls.family) });
            return;
        }
        if (row.cls.type !== 'span-close') return;
        let at = -1;
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].family === row.cls.family) {
                at = i;
                break;
            }
        }
        if (at === -1) return;
        openOf.set(index, stack[at].index);
        closeOf.set(stack[at].index, index);
        stack.length = at;
    });
    return { openOf, closeOf };
}

/**
 * Makes a prompt-row node. Rows classified as dingbat options are always `option`; other rows
 * become `option` only when they sit directly inside an exclusive container.
 * @param {OrderRow} row Order row.
 * @param {string} parentId Owning container id.
 * @param {(parentId: string, prefix: string, slug: string) => string} mint Id minter.
 * @param {number} depth Nesting depth.
 * @returns {SectionNode}
 */
function makeRowNode(row, parentId, mint, depth) {
    /** @type {SectionNode} */
    const node = {
        kind: row.cls.type === 'option' ? 'option' : 'leaf',
        id: mint(parentId, 'p', row.identifier),
        label: row.cls.label,
        depth,
        identifier: row.identifier,
        name: row.name,
        enabled: row.enabled,
    };
    if (row.cls.sigil) node.sigil = row.cls.sigil;
    if (row.marker) node.marker = true;
    if (row.builtin) node.builtin = true;
    return node;
}

/**
 * Builds the node list for one body (a section body or a sub-group body) in the sigil tier.
 * @param {OrderRow[]} rows Body rows, in order.
 * @param {string} parentId Owning container id.
 * @param {(parentId: string, prefix: string, slug: string) => string} mint Id minter.
 * @returns {SectionNode[]}
 */
function buildSigilBody(rows, parentId, mint) {
    const { openOf, closeOf } = pairSpans(rows);
    /** @type {SectionNode[]} */
    const roots = [];
    /** @type {Array<{id: string, children: SectionNode[]}>} */
    const stack = [{ id: parentId, children: roots }];
    rows.forEach((row, index) => {
        if (openOf.has(index)) {
            if (stack.length > 1) stack.pop();
            return;
        }
        const top = stack[stack.length - 1];
        const depth = stack.length - 1;
        if (closeOf.has(index)) {
            const id = mint(top.id, 's', slugify(row.cls.label));
            const closeIndex = closeOf.get(index) ?? index;
            /** @type {SectionNode} */
            const span = {
                kind: 'span',
                id,
                label: row.cls.label,
                depth,
                identifier: row.identifier,
                name: row.name,
                enabled: row.enabled,
                closeIdentifier: rows[closeIndex].identifier,
                children: [],
            };
            if (row.cls.sigil) span.sigil = row.cls.sigil;
            top.children.push(span);
            stack.push({ id, children: span.children ?? [] });
            return;
        }
        top.children.push(makeRowNode(row, top.id, mint, depth));
    });
    return roots;
}

/**
 * Promotes plain leaves to options inside an exclusive container.
 *
 * An engine marker is never promoted. Chat History and Char Description are slots, not choices,
 * and a preset that leaves them under a "pick one" banner (Freaky Frankenstein 5.4 does) must not
 * have them switched off by somebody picking a colour.
 *
 * A derived container (`swept`) also leaves core's built-in prompts alone. Its membership is
 * positional, everything up to the next header, and Post-History Instructions parked after the
 * last real option is the same accident a marker is. An authored override names its members, so
 * there a built-in is an option if the author listed it.
 * @param {SectionNode[]} children Direct children.
 * @param {boolean} [swept] Whether membership came from position rather than an authored list.
 * @returns {void}
 */
function promoteOptions(children, swept = true) {
    for (const child of children) {
        if (child.kind !== 'leaf' || child.marker === true) continue;
        if (swept && child.builtin === true) continue;
        child.kind = 'option';
    }
}

/**
 * Builds the leaves of one legacy or flat body, gathering each run of two or more adjacent rows
 * tagged "(Pick 1)" into an exclusive group of its own. The group has no header row: nothing in
 * the preset is one, so its key is its tree id and its label is what the names share.
 *
 * Not done inside a container that is already exclusive; one tagged row alone is just a row.
 * @param {OrderRow[]} rows Rows of the body, in order.
 * @param {string} parentId Owning container id.
 * @param {(parentId: string, prefix: string, slug: string) => string} mint Id minter.
 * @param {boolean} exclusiveParent Whether the owning container is itself a radio group.
 * @returns {SectionNode[]}
 */
function buildLegacyBody(rows, parentId, mint, exclusiveParent) {
    /** @type {SectionNode[]} */
    const nodes = [];
    for (let start = 0; start < rows.length;) {
        let end = start;
        if (!exclusiveParent) {
            while (end < rows.length && !rows[end].marker && PICK_ONE_TAG.test(rows[end].name)) end++;
        }
        if (end - start < 2) {
            nodes.push(makeLegacyLeaf(rows[start], parentId, mint, 0));
            start++;
            continue;
        }
        const run = rows.slice(start, end);
        const label = labelTaggedRun(run.map(row => row.name));
        const id = mint(parentId, 'g', slugify(label));
        const children = run.map(row => makeLegacyLeaf(row, id, mint, 0));
        promoteOptions(children);
        nodes.push({ kind: 'group', id, label, depth: 0, exclusive: true, children });
        start = end;
    }
    return nodes;
}

/**
 * Splits rows into runs delimited by a header predicate. The first run has a `null` header and
 * holds everything before the first match.
 * @param {OrderRow[]} rows Rows to split.
 * @param {(row: OrderRow) => boolean} isHeader Header test.
 * @returns {Array<{header: OrderRow|null, rows: OrderRow[]}>}
 */
function splitOn(rows, isHeader) {
    /** @type {Array<{header: OrderRow|null, rows: OrderRow[]}>} */
    const runs = [{ header: null, rows: [] }];
    for (const row of rows) {
        if (isHeader(row)) {
            runs.push({ header: row, rows: [] });
            continue;
        }
        runs[runs.length - 1].rows.push(row);
    }
    return runs;
}

/**
 * Sigil tier: banner → sub-group → span/leaf, with spans confined to their innermost body.
 * @param {OrderRow[]} rows Resolved order rows.
 * @returns {Section[]}
 */
function buildSigilSections(rows) {
    const mint = makeIdMint();
    /** @type {Section[]} */
    const sections = [];
    for (const run of splitOn(rows, row => row.cls.type === 'banner')) {
        if (!run.header && run.rows.length === 0) continue;
        const section = makeSection(run.header, mint);
        for (const groupRun of splitOn(run.rows, row => row.cls.type === 'subgroup')) {
            if (!groupRun.header) {
                section.children.push(...buildSigilBody(groupRun.rows, section.id, mint));
                continue;
            }
            const header = groupRun.header;
            const id = mint(section.id, 'g', slugify(header.cls.label));
            const children = buildSigilBody(groupRun.rows, id, mint);
            const exclusive = children.some(child => child.kind === 'option');
            if (exclusive) promoteOptions(children);
            /** @type {SectionNode} */
            const group = {
                kind: 'group',
                id,
                label: header.cls.label,
                depth: 0,
                identifier: header.identifier,
                name: header.name,
                enabled: header.enabled,
                exclusive,
                children,
            };
            if (header.cls.sigil) group.sigil = header.cls.sigil;
            section.children.push(group);
        }
        sections.push(section);
    }
    return sections;
}

/**
 * Makes a section shell from an optional header row.
 * @param {OrderRow|null} header Banner row, or null for the implicit section.
 * @param {(parentId: string, prefix: string, slug: string) => string} mint Id minter.
 * @param {string} [label] Label override (legacy tier cleans its own).
 * @returns {Section}
 */
function makeSection(header, mint, label) {
    const text = label ?? (header ? header.cls.label : '');
    /** @type {Section} */
    const section = {
        id: mint('', 'd', slugify(text)),
        label: text,
        kind: header ? 'banner' : 'flat',
        exclusive: false,
        collapsedDefault: false,
        children: [],
    };
    if (header) {
        section.identifier = header.identifier;
        section.name = header.name;
        section.enabled = header.enabled;
        if (header.cls.sigil) section.sigil = header.cls.sigil;
    }
    return section;
}

/**
 * Legacy tier: `=== X ===` banners, `< … >` sub-headers, two-level positional nesting, and no
 * spans. Leaf labels keep the raw name — the legacy conventions carry their badge INSIDE the
 * name (`🔞| X`) and there is no measured rule for splitting it off.
 * @param {OrderRow[]} rows Resolved order rows.
 * @param {RegExp} bannerPattern Banner alternation.
 * @returns {Section[]}
 */
function buildLegacySections(rows, bannerPattern) {
    const mint = makeIdMint();
    /** @type {Section[]} */
    const sections = [];
    const isBanner = (/** @type {OrderRow} */ row) => matchLegacyBanner(row.name, bannerPattern) !== null;
    for (const run of splitOn(rows, isBanner)) {
        if (!run.header && run.rows.length === 0) continue;
        let label = '';
        if (run.header) {
            const match = matchLegacyBanner(run.header.name, bannerPattern);
            // Glyphs in front of the divider stay in front of the label, glued the way an
            // inside-the-divider badge already is (`=🚫Pick one NSFW Toggle` → `🚫Pick one …`).
            label = match ? `${match.lead}${cleanLegacyLabel(match.body, match.token)}` : '';
        }
        const section = makeSection(run.header, mint, label);
        section.exclusive = Boolean(run.header) && PICK_ONE_PATTERN.test(label);
        for (const groupRun of splitOn(run.rows, row => LEGACY_SUBHEADER_PATTERN.test(row.name.trim()))) {
            if (!groupRun.header) {
                section.children.push(...buildLegacyBody(groupRun.rows, section.id, mint, section.exclusive));
                continue;
            }
            const header = groupRun.header;
            const match = LEGACY_SUBHEADER_PATTERN.exec(header.name.trim());
            const groupLabel = match ? match[1] : header.name.trim();
            const id = mint(section.id, 'g', slugify(groupLabel));
            const exclusive = PICK_ONE_PATTERN.test(groupLabel);
            const children = buildLegacyBody(groupRun.rows, id, mint, exclusive);
            if (exclusive) promoteOptions(children);
            section.children.push({
                kind: 'group',
                id,
                label: groupLabel,
                depth: 0,
                identifier: header.identifier,
                name: header.name,
                enabled: header.enabled,
                exclusive,
                children,
            });
        }
        if (section.exclusive) promoteOptions(section.children);
        sections.push(section);
    }
    return sections;
}

/**
 * Makes a legacy-tier leaf. The label is the raw name; no sigil is claimed.
 * @param {OrderRow} row Order row.
 * @param {string} parentId Owning container id.
 * @param {(parentId: string, prefix: string, slug: string) => string} mint Id minter.
 * @param {number} depth Nesting depth.
 * @returns {SectionNode}
 */
function makeLegacyLeaf(row, parentId, mint, depth) {
    /** @type {SectionNode} */
    const node = {
        kind: 'leaf',
        id: mint(parentId, 'p', row.identifier),
        label: row.name,
        depth,
        identifier: row.identifier,
        name: row.name,
        enabled: row.enabled,
    };
    if (row.marker) node.marker = true;
    if (row.builtin) node.builtin = true;
    return node;
}

/**
 * Flat tier: one honest section holding every row in order (a tagged "(Pick 1)" run still
 * becomes its group — the tag does not need a banner to mean what it says).
 * @param {OrderRow[]} rows Resolved order rows.
 * @returns {Section[]}
 */
function buildFlatSections(rows) {
    if (rows.length === 0) return [];
    const mint = makeIdMint();
    const section = makeSection(null, mint);
    section.children = buildLegacyBody(rows, section.id, mint, false);
    return [section];
}

/**
 * Override tier: authored sections, authored member order, unassigned rows in an implicit
 * bucket that keeps ORDER sequence.
 * @param {NormalizedOverride} bag Normalized bag.
 * @param {OrderRow[]} rows Resolved order rows.
 * @returns {Section[]}
 */
function buildOverrideSections(bag, rows) {
    const mint = makeIdMint();
    /** @type {Map<string, OrderRow>} */
    const byIdentifier = new Map();
    for (const row of rows) {
        if (!byIdentifier.has(row.identifier)) byIdentifier.set(row.identifier, row);
    }
    /** @type {Set<string>} */
    const claimed = new Set();
    /** @type {Section[]} */
    const sections = [];
    const used = new Set(bag.order);
    for (const sectionId of bag.order) {
        const spec = bag.sections[sectionId];
        if (!spec) continue;
        /** @type {SectionNode[]} */
        const children = [];
        for (const identifier of spec.members) {
            const row = byIdentifier.get(identifier);
            if (!row || claimed.has(identifier)) continue;
            claimed.add(identifier);
            children.push(makeRowNode(row, sectionId, mint, 0));
        }
        if (spec.exclusive) promoteOptions(children, false);
        sections.push({
            id: sectionId,
            label: spec.label,
            kind: 'banner',
            exclusive: spec.exclusive,
            collapsedDefault: spec.collapsedDefault,
            children,
        });
    }
    const leftovers = rows.filter(row => !claimed.has(row.identifier));
    if (leftovers.length > 0) {
        let index = 0;
        let id = `d:${index}:~`;
        while (used.has(id)) id = `d:${++index}:~`;
        /** @type {Section} */
        const implicit = {
            id,
            label: '',
            kind: 'flat',
            exclusive: false,
            collapsedDefault: false,
            children: [],
        };
        const seen = new Set();
        for (const row of leftovers) {
            if (seen.has(row.identifier)) continue;
            seen.add(row.identifier);
            implicit.children.push(makeRowNode(row, id, mint, 0));
        }
        if (bag.unassigned === 'first') sections.unshift(implicit);
        else sections.push(implicit);
    }
    return sections;
}

/**
 * True for a plain, non-array object safe to read keys off.
 * @param {unknown} value Candidate.
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Own-key read that ignores anything inherited (the bag comes off disk).
 * @param {object} target Object to read.
 * @param {string} key Key to read.
 * @returns {unknown}
 */
function own(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key) ? /** @type {any} */ (target)[key] : undefined;
}

/**
 * Validates and normalizes an `extensions.kotatsu.sections` bag. Never throws; garbage comes
 * back as `{ ok: false }` with the reasons listed.
 * @param {unknown} value Raw bag value.
 * @returns {OverrideValidation}
 */
export function validateSectionsOverride(value) {
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];
    /** @type {OverrideValidation} */
    const fail = { ok: false, value: null, errors, warnings };

    if (!isPlainObject(value)) {
        errors.push('sections override must be an object');
        return fail;
    }
    const bag = /** @type {object} */ (value);

    const rawVersion = own(bag, 'version');
    if (rawVersion === undefined) {
        warnings.push(`version missing; assuming ${OVERRIDE_VERSION}`);
    } else if (rawVersion !== OVERRIDE_VERSION) {
        errors.push(`unsupported version ${JSON.stringify(rawVersion)}`);
        return fail;
    }

    const rawSections = own(bag, 'sections');
    if (!isPlainObject(rawSections)) {
        errors.push('sections must be an object keyed by section id');
        return fail;
    }

    /** @type {Record<string, OverrideSectionSpec>} */
    const sections = Object.create(null);
    /** @type {string[]} */
    const keys = [];
    /** @type {Set<string>} */
    const claimed = new Set();
    for (const key of Object.keys(/** @type {object} */ (rawSections))) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
            warnings.push(`section id ${JSON.stringify(key)} is reserved; dropped`);
            continue;
        }
        if (!key) {
            warnings.push('empty section id dropped');
            continue;
        }
        const rawSpec = own(/** @type {object} */ (rawSections), key);
        if (!isPlainObject(rawSpec)) {
            warnings.push(`section ${JSON.stringify(key)} is not an object; dropped`);
            continue;
        }
        const spec = /** @type {object} */ (rawSpec);
        const rawMembers = own(spec, 'members');
        if (!Array.isArray(rawMembers)) {
            warnings.push(`section ${JSON.stringify(key)} has no members array; dropped`);
            continue;
        }
        /** @type {string[]} */
        const members = [];
        for (const member of rawMembers) {
            if (typeof member !== 'string' || !member) {
                warnings.push(`section ${JSON.stringify(key)} dropped a non-string member`);
                continue;
            }
            if (claimed.has(member)) {
                warnings.push(`member ${JSON.stringify(member)} claimed more than once; first section wins`);
                continue;
            }
            claimed.add(member);
            members.push(member);
        }
        const rawLabel = own(spec, 'label');
        const rawExclusive = own(spec, 'exclusive');
        const rawCollapsed = own(spec, 'collapsedDefault');
        if (rawLabel !== undefined && typeof rawLabel !== 'string') {
            warnings.push(`section ${JSON.stringify(key)} has a non-string label; using ""`);
        }
        if (rawExclusive !== undefined && typeof rawExclusive !== 'boolean') {
            warnings.push(`section ${JSON.stringify(key)} has a non-boolean exclusive; using false`);
        }
        if (rawCollapsed !== undefined && typeof rawCollapsed !== 'boolean') {
            warnings.push(`section ${JSON.stringify(key)} has a non-boolean collapsedDefault; using false`);
        }
        sections[key] = {
            label: typeof rawLabel === 'string' ? rawLabel : '',
            exclusive: rawExclusive === true,
            collapsedDefault: rawCollapsed === true,
            members,
        };
        keys.push(key);
    }

    if (keys.length === 0) {
        errors.push('sections override has no usable sections');
        return fail;
    }

    /** @type {string[]} */
    const order = [];
    const rawOrder = own(bag, 'order');
    if (rawOrder !== undefined && !Array.isArray(rawOrder)) {
        warnings.push('order must be an array; using key order');
    } else if (Array.isArray(rawOrder)) {
        for (const id of rawOrder) {
            if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(sections, id)) {
                warnings.push(`order entry ${JSON.stringify(id)} is not a known section; dropped`);
                continue;
            }
            if (order.includes(id)) {
                warnings.push(`order entry ${JSON.stringify(id)} repeated; kept once`);
                continue;
            }
            order.push(id);
        }
    }
    for (const key of keys) {
        if (!order.includes(key)) {
            if (order.length > 0 && Array.isArray(rawOrder)) {
                warnings.push(`section ${JSON.stringify(key)} missing from order; appended`);
            }
            order.push(key);
        }
    }

    const rawUnassigned = own(bag, 'unassigned');
    /** @type {'append'|'first'} */
    let unassigned = 'append';
    if (rawUnassigned === 'first') {
        unassigned = 'first';
    } else if (rawUnassigned !== undefined && rawUnassigned !== 'append') {
        warnings.push(`unknown unassigned policy ${JSON.stringify(rawUnassigned)}; using "append"`);
    }

    return {
        ok: true,
        value: { version: OVERRIDE_VERSION, unassigned, order, sections },
        errors,
        warnings,
    };
}

/**
 * Derives the section tree for a preset.
 *
 * `enabled` on every node is a SNAPSHOT taken from the order entry at derive time. Slice C's
 * toggle path mutates the order and patches the row — it must read live state from
 * `promptOrder`, never from a tree built earlier.
 *
 * @param {object} input Input.
 * @param {PromptRecord[]} [input.prompts] The preset's `prompts[]`.
 * @param {OrderEntry[]} [input.promptOrder] The RESOLVED `100001` order array (the caller
 *   resolves the sentinel; this module never sees a `prompt_order` wrapper).
 * @param {unknown} [input.override] Raw `extensions.kotatsu.sections` value, if any.
 * @param {unknown} [input.extraPatterns] User-supplied legacy banner fragments.
 * @returns {SectionTree}
 */
export function deriveSections({ prompts, promptOrder, override = null, extraPatterns = [] } = {}) {
    const promptList = Array.isArray(prompts) ? prompts : [];
    const orderList = Array.isArray(promptOrder) ? promptOrder : [];

    /** @type {Map<string, PromptRecord>} */
    const byIdentifier = new Map();
    for (const prompt of promptList) {
        if (!isPlainObject(prompt)) continue;
        const identifier = prompt.identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        if (!byIdentifier.has(identifier)) byIdentifier.set(identifier, prompt);
    }

    /** @type {OrderRow[]} */
    const rows = [];
    /** @type {string[]} */
    const unknownOrder = [];
    /** @type {string[]} */
    const duplicateOrder = [];
    /** @type {Set<string>} */
    const listed = new Set();
    for (const entry of orderList) {
        if (!isPlainObject(entry)) continue;
        const identifier = entry.identifier;
        if (typeof identifier !== 'string' || !identifier) continue;
        if (listed.has(identifier) && !duplicateOrder.includes(identifier)) duplicateOrder.push(identifier);
        listed.add(identifier);
        const prompt = byIdentifier.get(identifier);
        if (!prompt) {
            if (!unknownOrder.includes(identifier)) unknownOrder.push(identifier);
            continue;
        }
        const name = typeof prompt.name === 'string' ? prompt.name : '';
        rows.push({
            identifier,
            enabled: entry.enabled === true,
            name,
            marker: prompt.marker === true,
            builtin: prompt.system_prompt === true && prompt.marker !== true,
            cls: classifySigil(name),
        });
    }

    /** @type {string[]} */
    const unlisted = [];
    for (const identifier of byIdentifier.keys()) {
        if (!listed.has(identifier)) unlisted.push(identifier);
    }

    const bannerPattern = buildLegacyBannerPattern(extraPatterns);
    let sigilSignals = 0;
    let legacySignals = 0;
    for (const row of rows) {
        const type = row.cls.type;
        if (type === 'banner' || type === 'subgroup' || type === 'span-open' || type === 'span-close') sigilSignals++;
        if (matchLegacyBanner(row.name, bannerPattern)) legacySignals++;
    }

    /** @type {'override'|'sigil'|'legacy'|'flat'} */
    let tier = 'flat';
    /** @type {Section[]} */
    let sections;
    const validation = override === null || override === undefined ? null : validateSectionsOverride(override);
    if (validation && validation.ok && validation.value) {
        tier = 'override';
        sections = buildOverrideSections(validation.value, rows);
    } else if (sigilSignals >= 2) {
        tier = 'sigil';
        sections = buildSigilSections(rows);
    } else if (legacySignals >= 1) {
        tier = 'legacy';
        sections = buildLegacySections(rows, bannerPattern);
    } else {
        sections = buildFlatSections(rows);
    }

    return {
        tier,
        sections,
        unlisted,
        unknownOrder,
        duplicateOrder,
        signals: { sigil: sigilSignals, legacy: legacySignals },
    };
}

/**
 * Flattens a derived tree back to the identifiers it renders, in render order. Slice C's order
 * writes are proved against this: for every derived tier it equals the input order minus
 * `unknownOrder`.
 * @param {Section[]} sections Derived sections.
 * @returns {string[]}
 */
export function orderedIdentifiers(sections) {
    /** @type {string[]} */
    const out = [];
    /**
     * @param {SectionNode[]} nodes Nodes to walk.
     * @returns {void}
     */
    const walk = (nodes) => {
        for (const node of nodes) {
            if (node.identifier) out.push(node.identifier);
            if (node.children) walk(node.children);
            if (node.closeIdentifier) out.push(node.closeIdentifier);
        }
    };
    for (const section of Array.isArray(sections) ? sections : []) {
        if (section.identifier) out.push(section.identifier);
        walk(section.children ?? []);
    }
    return out;
}

/**
 * Collects the radio groups slice C enforces: every exclusive container, with the identifiers
 * of its DIRECT option children. Nested containers are not members of their ancestor's group.
 * @param {Section[]} sections Derived sections.
 * @returns {Array<{id: string, label: string, memberIdentifiers: string[]}>}
 */
export function exclusiveGroups(sections) {
    /** @type {Array<{id: string, label: string, memberIdentifiers: string[]}>} */
    const out = [];
    /**
     * @param {{id: string, label: string, exclusive?: boolean, children?: SectionNode[]}} container Container.
     * @returns {void}
     */
    const visit = (container) => {
        const children = container.children ?? [];
        if (container.exclusive) {
            out.push({
                id: container.id,
                label: container.label,
                memberIdentifiers: children
                    .filter(child => child.kind === 'option' && Boolean(child.identifier))
                    .map(child => String(child.identifier)),
            });
        }
        for (const child of children) {
            if (child.children) visit(child);
        }
    };
    for (const section of Array.isArray(sections) ? sections : []) visit(section);
    return out;
}

export { OVERRIDE_VERSION as SECTION_OVERRIDE_VERSION };
