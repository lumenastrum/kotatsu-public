/**
 * Kotatsu Wrapped — from numbers to what a card says (docs/wrapped/README.md). Pure: no DOM, no
 * clock, no settings. The server's stats (`/api/kotatsu/wrapped/stats`) and the reader's choices
 * go in; plain strings come out, and `draw.js` paints exactly those strings. So a test can read
 * a card without a canvas, and the picture can never say something this file did not.
 */

/** @typedef {'day'|'week'|'month'} Span */

/** A model joins a comparison once it has written this many replies in the window. */
export const FACEOFF_MIN_REPLIES = 5;

export const SPANS = /** @type {const} */ (['day', 'week', 'month']);

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The window a span covers, in the reader's own zone. `step` walks back in whole spans
 * (0 = the one containing `now`, 1 = the one before it).
 *
 * A day is a calendar day. A week is the seven days ending on that day, so "this week" always
 * has a week in it, on a Monday too. A month is the calendar month.
 * @param {Span} span
 * @param {number} now Epoch ms.
 * @param {number} tzOffsetMin `Date#getTimezoneOffset()`.
 * @param {number} [step]
 * @returns {{from: number, to: number, label: string, phrase: string, length: string}}
 */
export function windowFor(span, now, tzOffsetMin, step = 0) {
    const shift = tzOffsetMin * 60000;
    const local = new Date(now - shift);
    const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
    const at = (yy, mm, dd) => Date.UTC(yy, mm, dd) + shift;
    const dayLabel = (ms) => { const x = new Date(ms - shift); return `${MONTHS_SHORT[x.getUTCMonth()]} ${x.getUTCDate()}`; };
    if (span === 'month') {
        const from = at(y, m - step, 1);
        const start = new Date(from - shift);
        const to = at(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
        const sameYear = start.getUTCFullYear() === y;
        return {
            from,
            to,
            label: sameYear ? MONTHS[start.getUTCMonth()] : `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
            phrase: step === 0 ? 'this month' : `in ${MONTHS[start.getUTCMonth()]}`,
            // A month still running is as long as it has run, today included: the card speaks for
            // those days, not for the ones that have not happened.
            length: now < to ? `${Math.ceil((now - from) / DAY_MS)} days so far` : `${Math.round((to - from) / DAY_MS)} days`,
        };
    }
    if (span === 'week') {
        const to = at(y, m, d + 1 - step * 7);
        const from = to - 7 * DAY_MS;
        return { from, to, label: `${dayLabel(from)} – ${dayLabel(to - DAY_MS)}`, phrase: step === 0 ? 'this week' : 'that week', length: '7 days' };
    }
    const from = at(y, m, d - step);
    const x = new Date(from - shift);
    return {
        from,
        to: from + DAY_MS,
        label: `${WEEKDAYS[x.getUTCDay()]}, ${MONTHS_SHORT[x.getUTCMonth()]} ${x.getUTCDate()}`,
        phrase: step === 0 ? 'today' : 'that day',
        length: '1 day',
    };
}

/**
 * The stretch a window is compared with, for the arrows. Like for like: a window that is still
 * running (step 0) is held up to the SAME STRETCH of the one before it, so "November so far" on
 * the 12th meets October 1–12 and not all of October; a finished window meets the whole one
 * before it.
 * @param {Span} span @param {number} now @param {number} tzOffsetMin @param {number} [step]
 * @returns {{from: number, to: number, label: string}}
 */
export function previousWindow(span, now, tzOffsetMin, step = 0) {
    const current = windowFor(span, now, tzOffsetMin, step);
    const before = windowFor(span, now, tzOffsetMin, step + 1);
    const running = step === 0 && now < current.to;
    const to = running ? Math.min(before.to, before.from + Math.max(60000, now - current.from)) : before.to;
    const partial = to < before.to;
    const name = span === 'month' ? before.label : span === 'week' ? 'the week before' : step === 0 ? 'yesterday' : 'the day before';
    const label = !partial ? name
        : span === 'month' ? `the same days of ${before.label}`
            : span === 'week' ? 'the week before'
                : 'yesterday by this hour';
    return { from: before.from, to, label };
}

/**
 * A window with everything a card needs to draw it: which span it is, the calendar it covers,
 * and the stretch it is compared with.
 * @param {Span} span @param {number} now @param {number} tzOffsetMin @param {number} [step]
 */
export function describeWindow(span, now, tzOffsetMin, step = 0) {
    const window = windowFor(span, now, tzOffsetMin, step);
    const shift = tzOffsetMin * 60000;
    const first = Math.floor((window.from - shift) / DAY_MS);
    return {
        ...window,
        span,
        // Local calendar days, counted the way the server counts them (days since the epoch in
        // the reader's zone), so a day's square finds its number without parsing a date.
        calendar: {
            first,
            count: Math.round((window.to - window.from) / DAY_MS),
            weekday: new Date(window.from - shift).getUTCDay(),
            today: Math.floor((now - shift) / DAY_MS),
        },
        previous: previousWindow(span, now, tzOffsetMin, step),
    };
}

/**
 * How one figure moved against the earlier stretch. No judgement in it: an arrow and a size,
 * the same grey whichever way it points (more swipes is not "bad", it is more swipes).
 * @param {number} now @param {number} before
 * @returns {{dir: 'up'|'down'|'same', text: string}|null} null when there is nothing to compare with.
 */
export function change(now, before) {
    if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return null;
    const ratio = (now - before) / before;
    if (Math.abs(ratio) < 0.005) return { dir: 'same', text: 'same' };
    const size = Math.abs(ratio);
    // Past a doubling a percentage stops being readable ("up 500%"): say the multiple instead.
    const times = now / before;
    if (times >= 2) return { dir: 'up', text: `${times < 9.95 ? times.toFixed(1).replace(/\.0$/, '') : Math.round(times)}×` };
    return { dir: ratio > 0 ? 'up' : 'down', text: `${Math.round(size * 100)}%` };
}

/**
 * 47 → "47", 1284 → "1,284", 148200 → "148K", 4100000 → "4.1M".
 * @param {number} n
 * @returns {string}
 */
export function compact(n) {
    const value = Number.isFinite(n) ? Math.max(0, n) : 0;
    if (value < 10000) return Math.round(value).toLocaleString('en-US');
    if (value < 999500) return `${Math.round(value / 1000)}K`;
    const millions = value / 1e6;
    return `${millions < 10 ? millions.toFixed(1).replace(/\.0$/, '') : Math.round(millions)}M`;
}

/**
 * 6600000 → "1h 50m", 165600000 → "46h", 240000 → "4m".
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
    const minutes = Math.round((Number.isFinite(ms) ? Math.max(0, ms) : 0) / 60000);
    const hours = Math.floor(minutes / 60);
    if (hours >= 20) return `${Math.round(minutes / 60)}h`;
    if (hours === 0) return `${minutes}m`;
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/**
 * Minutes after local midnight → "1:48 AM".
 * @param {number} minutes
 * @returns {string}
 */
export function clock(minutes) {
    const h = Math.floor(minutes / 60) % 24, m = Math.round(minutes % 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** @param {number} hour 0–23 → "11 PM". */
const hourLabel = (hour) => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
/** How the makers write their own names; anything not listed is simply capitalized. */
const MODEL_WORDS = Object.freeze({
    gpt: 'GPT', glm: 'GLM', claude: 'Claude', gemini: 'Gemini', gemma: 'Gemma', deepseek: 'DeepSeek', kimi: 'Kimi',
    mimo: 'MiMo', minimax: 'MiniMax', qwen: 'Qwen', llama: 'Llama', grok: 'Grok', mistral: 'Mistral',
    xai: 'xAI', openai: 'OpenAI', hd: 'HD', xl: 'XL', ai: 'AI',
});

/**
 * A model id the way a person would say it: `claude-opus-5-5` → "Claude Opus 5.5",
 * `gemini-4-argon` → "Gemini 4 Argon", `gpt-5.6-sol` → "GPT-5.6 Sol", `glm-5.2` → "GLM 5.2".
 *
 * Deliberately cautious. Only ids in the lowercase-and-hyphens shape the API providers use are
 * rewritten; a name with capitals, spaces or underscores (a local model file, a name someone
 * typed) is somebody's own spelling and is printed as it is. A route prefix (`anthropic/…`), a
 * `:free`-style suffix and a trailing date stamp are dropped: they say where and when, not which.
 * @param {unknown} id
 * @returns {string}
 */
export function friendlyModel(id) {
    if (typeof id !== 'string' || !id.trim()) return 'unknown model';
    let name = id.trim();
    name = name.slice(name.lastIndexOf('/') + 1).replace(/:[a-z0-9-]+$/i, '');
    if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(name)) return name;
    name = name.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-latest$/, '');
    /** @type {string[]} */
    const words = [];
    for (const part of name.split('-')) {
        const previous = words[words.length - 1];
        // `5-5` is a version spelled with a hyphen because ids cannot hold a dot.
        if (/^\d{1,2}$/.test(part) && previous && /^\d{1,2}$/.test(previous)) words[words.length - 1] = `${previous}.${part}`;
        else words.push(part);
    }
    const said = words.map((word) => {
        if (MODEL_WORDS[/** @type {keyof typeof MODEL_WORDS} */ (word)]) return MODEL_WORDS[/** @type {keyof typeof MODEL_WORDS} */ (word)];
        // `v4`, `k3`, `m3`, `o4`: a letter and a number is a designation, said in capitals.
        if (/^[a-z]\d+(?:\.\d+)?$/.test(word)) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1);
    });
    // OpenAI hyphenates the family to its version: GPT-5.6.
    if (said[0] === 'GPT' && /^\d/.test(said[1] ?? '')) said.splice(0, 2, `GPT-${said[1]}`);
    return said.join(' ');
}

const percent = (share) => `${Math.round((Number.isFinite(share) ? share : 0) * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${compact(n)} ${n === 1 ? one : many}`;

/**
 * The mikan rating on the report card. One rule, said out loud so nobody has to guess: it is
 * the share of replies kept on the first try, and nothing else.
 * @param {number} keptFirstTry 0–1
 * @returns {{mikans: number, verdict: string}}
 */
export function rating(keptFirstTry) {
    const share = Number.isFinite(keptFirstTry) ? keptFirstTry : 0;
    if (share >= 0.9) return { mikans: 5, verdict: 'Kept nearly every first try' };
    if (share >= 0.75) return { mikans: 4, verdict: 'Would peel again' };
    if (share >= 0.6) return { mikans: 3, verdict: 'Good, with a swipe habit' };
    if (share >= 0.4) return { mikans: 2, verdict: 'A lot of second opinions' };
    return { mikans: 1, verdict: 'Mostly rerolls' };
}

/**
 * What the reader chose to show (the "what's on the card" step).
 * @typedef {object} Choices
 * @property {boolean} [showNames] Card names on the picture. Off: "Card 1", "Card 2", …
 * @property {Record<string, string>} [nicknames] Real card name → what to print instead.
 * @property {boolean} [showNight] The latest-night line.
 */

/**
 * @typedef {object} RankRow
 * @property {string} name
 * @property {string} note
 * @property {string} value The right-hand figure.
 * @property {number} share 0–1, the share of replies.
 */

/**
 * The three cards as plain strings.
 * @param {any} stats The server's answer.
 * @param {ReturnType<typeof windowFor> & Partial<Omit<ReturnType<typeof describeWindow>, keyof ReturnType<typeof windowFor>>>} window A bare window, or a described one (which also brings the calendar and the arrows).
 * @param {Choices} [choices]
 */
export function buildCards(stats, window, choices = {}) {
    const { showNames = true, nicknames = {}, showNight = true } = choices;
    const cards = Array.isArray(stats?.cards) ? stats.cards : [];
    /** The same card always gets the same stand-in, wherever it appears on the picture. */
    const alias = new Map(cards.map((card, index) => [card.name, `Card ${index + 1}`]));
    const cardName = (name) => {
        if (!name) return '';
        if (!showNames) return alias.get(name) ?? 'a card';
        const nickname = nicknames[name]?.trim();
        return nickname || name;
    };
    const replies = stats?.replies ?? 0;
    const all = (row) => (row.share >= 0.995 ? `all ${compact(row.replies)} replies` : `${percent(row.share)} of replies`);

    /** @type {string[]} */
    const little = [];
    if (stats?.longestSitting?.ms >= 10 * 60000) {
        const who = cardName(stats.longestSitting.card);
        little.push(`Longest sitting: ${duration(stats.longestSitting.ms)}${who ? ` with ${who}` : ''}`);
    }
    if (showNight && stats?.latestNight) {
        const who = cardName(stats.latestNight.card);
        little.push(`Latest night: ${clock(stats.latestNight.minutes)}${who ? ` with ${who}` : ''}`);
    }
    if (Number.isInteger(stats?.busiestHour) && replies >= 20) little.push(`Busiest hour: ${hourLabel(stats.busiestHour)}`);

    const presets = Array.isArray(stats?.presets) ? stats.presets : [];
    const before = stats?.previous;
    const moves = before && replies
        ? [change(replies, before.replies), change(stats?.rerolls ?? 0, before.rerolls), change(stats?.activeMs ?? 0, before.activeMs)]
        : [null, null, null];
    const story = {
        when: window.label,
        // The three figures under the title, then the two that are said in a sentence.
        lead: [
            [compact(replies), replies === 1 ? 'reply read' : 'replies read'],
            [compact(stats?.rerolls ?? 0), (stats?.rerolls ?? 0) === 1 ? 'swipe' : 'swipes'],
            [duration(stats?.activeMs ?? 0), 'at the table'],
        ],
        // How each of the three moved against the earlier stretch (same order), or null.
        moves,
        versus: moves.some(Boolean) ? `Arrows compare with ${window.previous?.label ?? 'the stretch before'}` : '',
        fine: replies ? [
            `${percent(stats?.keptFirstTry)} of replies kept on the first try`,
            `${compact(stats?.tokens?.output ?? 0)} tokens written`,
        ] : [],
        cards: /** @type {RankRow[]} */ (cards.slice(0, 3).map((c) => ({ name: cardName(c.name), note: plural(c.replies, 'reply', 'replies'), value: compact(c.replies), share: c.share }))),
        models: /** @type {RankRow[]} */ ((stats?.models ?? []).slice(0, 3).map((m) => ({ name: friendlyModel(m.model), note: all(m), value: percent(m.share), share: m.share }))),
        presets: /** @type {RankRow[]} */ (presets.slice(0, 3).map((p) => ({ name: p.preset, note: all(p), value: percent(p.share), share: p.share }))),
        // Presets are only known for replies written since the stamp existed; when that is not
        // the whole window the card says how much of it the list speaks for.
        presetNote: presets.length && stats.presetCoverage < 0.995 ? `Presets are known for ${percent(stats.presetCoverage)} of these replies` : '',
        little,
    };

    // The report card: the top model × preset pair when presets are known, else the top model.
    // A pair only takes the card once presets are known for most of the window and the pair has
    // a few replies behind it; the day the stamp arrives, two replies are not a report.
    const top = stats?.models?.[0];
    const pair = stats?.combos?.[0];
    const combo = pair && (stats.presetCoverage ?? 0) >= 0.5 && pair.replies >= 5 ? pair : null;
    const subject = combo ?? top ?? null;
    const report = subject ? {
        when: window.length,
        title: combo ? [friendlyModel(combo.model), combo.preset] : [friendlyModel(top.model)],
        label: combo ? 'Model and preset report card' : 'Model report card',
        rows: [
            ['Replies', compact(subject.replies)],
            ['Kept on the first try', percent(subject.keptFirstTry)],
            ['Swipes per reply', (subject.generationsPerReply - 1).toFixed(2)],
            ['Words per reply', compact(subject.wordsPerGeneration)],
            ['Average wait', `${Math.round(subject.waitAvgMs / 1000)} s`],
        ],
        ...rating(subject.keptFirstTry),
    } : null;

    const spotted = Array.isArray(stats?.phrases) ? stats.phrases.slice(0, 6) : [];
    // Models compared have to have written enough for a rate to mean something.
    const contenders = (Array.isArray(stats?.models) ? stats.models : []).filter((m) => m.replies >= FACEOFF_MIN_REPLIES).slice(0, 3);
    const rate = (/** @type {number|undefined} */ count, /** @type {number} */ drafts) => (drafts > 0 ? (count ?? 0) / drafts * 100 : 0);
    const rateText = (/** @type {number|undefined} */ count, /** @type {number} */ drafts) => {
        const value = rate(count, drafts);
        return value === 0 ? '0' : value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
    };
    const byModel = new Map((Array.isArray(stats?.phraseModels) ? stats.phraseModels : []).map((m) => [m.model, m]));
    const who = contenders.length >= 2 && spotted.length && Array.isArray(stats?.phraseModels)
        ? contenders.map((m) => ({ model: m.model, generations: m.generations, counts: byModel.get(m.model)?.counts ?? {} }))
        : [];
    const peakRate = Math.max(0, ...who.flatMap((m) => spotted.map((p) => rate(m.counts[p.id], m.generations))));
    const most = spotted[0]?.count ?? 0;
    const phrases = {
        when: window.label,
        label: `Phrases spotted ${window.phrase}`,
        sub: window.phrase,
        rows: spotted.map((p) => ({
            label: p.label,
            count: compact(p.count),
            fill: most ? p.count / most : 0,
            // One figure per column of `who`: times per 100 replies that model wrote.
            rates: who.map((m) => ({ text: rateText(m.counts[p.id], m.generations), depth: peakRate ? rate(m.counts[p.id], m.generations) / peakRate : 0 })),
        })),
        // "Which model says it": the columns, when at least two models wrote enough to compare.
        who: who.map((m) => friendlyModel(m.model)),
        whoNote: who.length ? 'Squares: times per 100 replies that model wrote' : '',
        empty: spotted.length ? '' : 'None of the usual suspects showed up.',
        list: `Phrase list: ${stats?.phraseList ?? 'unnamed'}`,
    };

    // The calendar card: a square for every day of the window, inked by how much was read.
    // A single day has no calendar to show.
    const calendar = window.calendar;
    let nights = null;
    if (calendar && window.span !== 'day') {
        const byDay = new Map((Array.isArray(stats?.days) ? stats.days : []).map((d) => [d.day, d.replies]));
        const most = Math.max(0, ...byDay.values());
        const cells = Array.from({ length: calendar.count }, (_, index) => {
            const day = calendar.first + index;
            const date = new Date(day * DAY_MS);
            const count = byDay.get(day) ?? 0;
            return { number: date.getUTCDate(), weekday: date.getUTCDay(), replies: count, level: count ? Math.max(1, Math.ceil(4 * count / most)) : 0, future: day > calendar.today };
        });
        const past = cells.filter((cell) => !cell.future).length;
        const played = cells.filter((cell) => cell.replies > 0).length;
        const streak = stats?.longestStreak ?? 0;
        const best = stats?.bestDay;
        const bestDate = best ? new Date(best.day * DAY_MS) : null;
        const hours = Array.isArray(stats?.hours) && stats.hours.length === 24 ? stats.hours : Array(24).fill(0);
        const peak = Math.max(0, ...hours);
        nights = {
            when: window.label,
            title: 'Days under the blanket',
            sub: `${played} of ${past}${past < calendar.count ? ' so far' : ''}`,
            // A month hangs from its weekdays, Sunday first; a week is simply its seven days in a row.
            offset: window.span === 'month' ? calendar.weekday : 0,
            weekdays: window.span === 'month' ? WEEKDAYS.map((name) => name[0]) : cells.map((cell) => WEEKDAYS[cell.weekday][0]),
            cells,
            facts: played ? [
                [`${streak} ${streak === 1 ? 'day' : 'days'}`, 'longest streak in a row'],
                ...(bestDate ? [[`${compact(best.replies)} ${best.replies === 1 ? 'reply' : 'replies'}`, `biggest day, ${WEEKDAYS[bestDate.getUTCDay()]} ${MONTHS_SHORT[bestDate.getUTCMonth()]} ${bestDate.getUTCDate()}`]] : []),
            ] : [],
            hours: hours.map((count) => (peak ? count / peak : 0)),
            hoursNote: Number.isInteger(stats?.busiestHour) && peak ? `By hour of the day. Busiest: ${hourLabel(stats.busiestHour)}` : 'By hour of the day',
        };
    }

    // The face-off: the two or three most-used models side by side on the same figures.
    let faceoff = null;
    if (contenders.length >= 2) {
        /** Which column leads a row, when the figure has a direction and one model clearly has it. */
        const lead = (/** @type {number[]} */ values, /** @type {'high'|'low'} */ want) => {
            const best = want === 'high' ? Math.max(...values) : Math.min(...values);
            return values.filter((v) => v === best).length === 1 ? values.indexOf(best) : null;
        };
        const kept = contenders.map((m) => Math.round(m.keptFirstTry * 100));
        const swipes = contenders.map((m) => Number((m.generationsPerReply - 1).toFixed(2)));
        const waits = contenders.map((m) => Math.round(m.waitAvgMs / 1000));
        const slop = contenders.map((m) => {
            const counts = byModel.get(m.model)?.counts ?? {};
            return Number(rate(Object.values(counts).reduce((sum, n) => sum + n, 0), m.generations).toFixed(1));
        });
        faceoff = {
            when: window.label,
            title: 'Face-off',
            sub: window.phrase,
            names: contenders.map((m) => friendlyModel(m.model)),
            counts: contenders.map((m) => plural(m.replies, 'reply', 'replies')),
            rows: [
                { label: 'Kept on the first try', values: kept.map((v) => `${v}%`), lead: lead(kept, 'high') },
                { label: 'Swipes per reply', values: swipes.map((v) => v.toFixed(2)), lead: lead(swipes, 'low') },
                { label: 'Words per reply', values: contenders.map((m) => compact(m.wordsPerGeneration)), lead: null },
                { label: 'Average wait', values: waits.map((v) => `${v} s`), lead: lead(waits, 'low') },
                ...(Array.isArray(stats?.phraseModels) ? [{ label: 'Phrases per 100 replies', values: slop.map((v) => String(v)), lead: lead(slop, 'low') }] : []),
            ],
        };
    }

    return { story, nights, report, faceoff, phrases, empty: replies === 0 };
}

/**
 * The cards in words, for a screen reader and for tests: every line the picture carries.
 * @param {ReturnType<typeof buildCards>} view
 * @returns {string[]}
 */
export function describeCards(view) {
    const { story, nights, report, faceoff, phrases } = view;
    const rank = (title, rows) => (rows.length ? [`${title}: ${rows.map((r, i) => `${i + 1}. ${r.name}, ${r.note}`).join('; ')}`] : []);
    return [
        `Kotatsu Wrapped, ${story.when}, under the blanket.`,
        story.lead.map(([value, label], index) => {
            const move = story.moves[index];
            return `${value} ${label}${move ? ` (${move.dir === 'same' ? 'the same' : `${move.dir} ${move.text}`})` : ''}`;
        }).join(', '),
        ...(story.versus ? [story.versus] : []),
        ...story.fine,
        ...rank('The cast', story.cards),
        ...rank('Written by', story.models),
        ...rank('Presets', story.presets),
        ...(story.presetNote ? [story.presetNote] : []),
        ...story.little,
        ...(report ? [`${report.label}: ${report.title.join(' with ')}. ${report.mikans} of 5 mikans: ${report.verdict}. ${report.rows.map(([label, value]) => `${label} ${value}`).join(', ')}.`] : []),
        ...(nights ? [`${nights.title}: ${nights.sub}. ${nights.facts.map(([value, label]) => `${value}, ${label}`).join('. ')}${nights.facts.length ? '. ' : ''}${nights.hoursNote}.`] : []),
        ...(faceoff ? [`Face-off, ${faceoff.sub}: ${faceoff.names.map((name, i) => `${name} (${faceoff.counts[i]}): ${faceoff.rows.map((r) => `${r.label} ${r.values[i]}`).join(', ')}`).join('. ')}.`] : []),
        ...(phrases.who.length ? [`Per 100 replies, by model: ${phrases.rows.map((r) => `${r.label}: ${r.rates.map((x, i) => `${phrases.who[i]} ${x.text}`).join(', ')}`).join('; ')}.`] : []),
        `${phrases.label}: ${phrases.rows.length ? phrases.rows.map((r) => `${r.label} ${r.count}`).join('; ') : phrases.empty} (${phrases.list})`,
    ];
}
