/**
 * Kotatsu Wrapped — the stats engine (docs/wrapped/README.md). Pure: it is handed parsed chat
 * messages and a time window, and returns numbers. No file access, no clock, no settings, so
 * the same chats and the same window always give the same card.
 *
 * Vocabulary, pinned here because every number on a card depends on it:
 *
 * - A **generation** is one text a model wrote: a reply's first draft, or any swipe of it. A
 *   card's greeting is not one (nothing generated it: it carries no model and no start time).
 * - A **reply** is a character message with at least one generation inside the window.
 * - **Rerolls** are the generations beyond the first on a reply (generations − replies).
 * - **Kept first try** is the share of replies that were never rerolled at all.
 *
 * We measure, we never judge or fix: the phrase counter counts, presets own their anti-slop.
 */

/** Two activity events closer than this belong to the same sitting. */
export const SITTING_GAP_MS = 15 * 60 * 1000;

/**
 * A night belongs to the day it started on: the "latest night" clock rolls over at this local
 * hour, so 1:30 AM is later than 11:50 PM, and 6 AM is an early morning, not a very late night.
 */
const NIGHT_END_HOUR = 5;
/** Before this local hour nothing counts as a night at all (a 3 PM session is not "late"). */
const NIGHT_START_HOUR = 21;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * A message timestamp as epoch milliseconds. Chats carry four shapes (all four are in real
 * chat files): ISO strings, epoch numbers (sometimes as digit strings), stock's old
 * `2024-7-12 @14h 05m 09s 123ms`, and the humanized `July 12, 2024 2:05pm`. The last two carry
 * no zone, so they are read as the reader's local time, `tzOffsetMin` minutes behind UTC.
 * @param {unknown} value
 * @param {number} [tzOffsetMin] `Date#getTimezoneOffset()` of the reader (420 for UTC-7).
 * @returns {number|null}
 */
export function parseStamp(value, tzOffsetMin = 0) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (!text) return null;
    if (/^\d{11,}$/.test(text)) return Number(text);
    if (/^\d{4}-\d\d-\d\dT/.test(text)) {
        const ms = Date.parse(text);
        return Number.isNaN(ms) ? null : ms;
    }
    const local = (y, mo, d, h, mi, s, ms) => Date.UTC(y, mo, d, h, mi, s, ms) + tzOffsetMin * 60000;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?$/.exec(text);
    if (m) return local(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] ?? 0));
    m = /^([A-Za-z]+) (\d{1,2}), (\d{4}) (\d{1,2}):(\d\d)\s*([ap]m)$/i.exec(text);
    if (m) {
        const month = MONTHS.indexOf(m[1].toLowerCase());
        if (month < 0) return null;
        const hour = (+m[4] % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);
        return local(+m[3], month, +m[2], hour, +m[5], 0, 0);
    }
    return null;
}

/**
 * A reply as its reader sees it, for counting words and phrases in.
 *
 * What is stored is not always what is shown. Some presets have the model write a stand-in for
 * every space (Freaky Frankenstein's replies are stored as one unbroken run, `[$Time$10:42$PM…`,
 * and a display script turns each `$` back into a space on screen), and replies carry markup
 * that is never read as words. Counted raw, a 700-word reply came out as 21 "words", and no
 * phrase with a space in it could ever match (found on Andres's own library, 2026-11-12: 197
 * replies averaging 76 "words" at 60 characters each).
 *
 * Trackers are not the story either. Presets like Sola V4 and Freaky Frankenstein have the model
 * write a status block after the prose (`<sola_hud>`, `<internal_states>`, `<thought_engine>`…)
 * that the display folds away; counted as words, GLM 5.2 "wrote" 1,700 words a reply when about
 * 1,000 were story (Andres's November, 2026-11-18). On 1,172 real replies the line was clean: every
 * multi-line block in a made-up tag was a tracker, every made-up tag on one line was colour on the
 * prose (`<pink>`, `<rose:whisper>`). Real HTML is kept, since in-story phone screens are read.
 *
 * So: CSS, scripts and folded `<details>` go; a multi-line block in a tag HTML does not have goes;
 * then a run of two or more dollar signs is a space, a tag is a space, and whitespace is one
 * space. If dropping blocks would leave nothing, the blocks were the reply, and they stay. This
 * does not run anyone's display scripts, so a preset with a different trick reads wrong until it
 * is taught here.
 * @param {unknown} text
 * @returns {string}
 */
export function plain(text) {
    if (typeof text !== 'string' || !text) return '';
    const spaced = (s) => s.replace(/<\/?[a-zA-Z][^>]{0,300}>/g, ' ').replace(/\${2,}/g, ' ').replace(/\s+/g, ' ').trim();
    const story = spaced(text.replace(UNREAD_BLOCK, (whole, name, body) => (
        NEVER_READ.has(name.toLowerCase()) || (!HTML_TAGS.has(name.toLowerCase()) && body.includes('\n')) ? ' ' : whole
    )));
    return story || spaced(text);
}

/** `<name …>body</name>`, same name both ends, shortest body. */
const UNREAD_BLOCK = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/g;
/** Never on screen as words, or folded until someone opens it. */
const NEVER_READ = new Set(['style', 'script', 'details', 'template']);
/** Tags a browser knows. Anything else is a preset's own invention. */
const HTML_TAGS = new Set(('a abbr address article aside b bdi bdo blockquote br caption center cite code col colgroup dd del dfn '
    + 'div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q '
    + 's samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var').split(' '));

/**
 * @typedef {object} Generation
 * @property {number} at When it finished (or, failing that, when it was sent).
 * @property {number|null} startedAt
 * @property {string} model
 * @property {string} api
 * @property {string} preset '' when the reply predates the preset stamp.
 * @property {string} text
 * @property {number} tokensOut Output tokens: the provider's figure when stored, else core's count, else 0.
 * @property {number} tokensPrompt Prompt tokens, only when the provider's usage was stored.
 * @property {number|null} cost What the provider says it cost (OpenRouter credits), or null when it did not say.
 * @property {boolean} kept Whether this is the swipe currently shown.
 */

/**
 * Every generation on one message, greetings and user turns excluded.
 * @param {any} message One parsed `.jsonl` row.
 * @param {number} [tzOffsetMin]
 * @returns {Generation[]}
 */
export function generationsOf(message, tzOffsetMin = 0) {
    if (!message || typeof message !== 'object' || message.is_user) return [];
    const build = (text, info, kept) => {
        const extra = info?.extra ?? {};
        const startedAt = parseStamp(info?.gen_started, tzOffsetMin);
        const model = typeof extra.model === 'string' ? extra.model : '';
        const api = typeof extra.api === 'string' ? extra.api : '';
        // Nothing generated it: a greeting, an imported line, a narrator note.
        if (!model && !api && startedAt === null) return null;
        const at = parseStamp(info?.gen_finished, tzOffsetMin) ?? parseStamp(info?.send_date, tzOffsetMin);
        if (at === null) return null;
        const usage = extra.mm_usage && typeof extra.mm_usage === 'object' ? extra.mm_usage : null;
        const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
        return {
            at,
            startedAt,
            model,
            api,
            preset: typeof extra.kotatsu_preset === 'string' ? extra.kotatsu_preset : '',
            text: plain(text),
            tokensOut: count(usage?.outputTokens) || count(extra.token_count),
            tokensPrompt: count(usage?.promptTokens),
            // Only OpenRouter's figure is trusted as money: it is the one provider that documents
            // `usage.cost` (credits = US dollars). The same key from anywhere else is not summed.
            cost: api === 'openrouter' && typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null,
            kept,
        };
    };
    const swipes = Array.isArray(message.swipes) ? message.swipes : null;
    if (!swipes || swipes.length === 0) {
        const one = build(message.mes, message, true);
        return one ? [one] : [];
    }
    const keptIndex = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const out = [];
    swipes.forEach((text, index) => {
        // The shown swipe's own facts also live on the message; older files only have them there.
        const info = message.swipe_info?.[index] ?? (index === keptIndex ? message : null);
        const generation = info ? build(text, info, index === keptIndex) : null;
        if (generation) out.push(generation);
    });
    return out;
}

/**
 * @typedef {object} Phrase
 * @property {string} id
 * @property {string} label What the card prints.
 * @property {string} pattern A regular expression source.
 * @property {string} [flags] Defaults to 'gi'. 'g' is always added.
 */

/**
 * @param {string} text
 * @returns {number}
 */
function wordsIn(text) {
    const words = text.match(/\S+/g);
    return words ? words.length : 0;
}

const ratio = (a, b) => (b > 0 ? a / b : 0);

/**
 * A running tally over any number of chats. Feed it chats, then ask for the result.
 * @param {object} options
 * @param {number} options.from Window start, epoch ms, inclusive.
 * @param {number} options.to Window end, epoch ms, exclusive.
 * @param {number} [options.tzOffsetMin] The reader's `Date#getTimezoneOffset()`.
 * @param {Phrase[]} [options.phrases]
 * @param {number} [options.top] How many rows each ranked list keeps (default 10).
 */
export function createTally({ from, to, tzOffsetMin = 0, phrases = [], top = 10 }) {
    const inWindow = (t) => t !== null && t >= from && t < to;
    /** Model → phrase id → times that model wrote it. */
    /** @type {Map<string, Record<string, number>>} */
    const phraseModels = new Map();
    const matchers = phrases.map((phrase) => {
        const flags = new Set((phrase.flags ?? 'gi').split(''));
        flags.add('g');
        let regex = null;
        try { regex = new RegExp(phrase.pattern, [...flags].join('')); } catch { /* a broken pattern counts nothing */ }
        return { id: phrase.id, label: phrase.label, regex, count: 0 };
    });

    const totals = { replies: 0, generations: 0, firstTry: 0, userMessages: 0, words: 0, tokensOut: 0, tokensPrompt: 0, usageKnown: 0, waitMs: 0, waitN: 0, stamped: 0, spend: 0, spendN: 0 };
    /** @type {Map<string, {name: string, replies: number, generations: number}>} */
    const cards = new Map();
    /** @type {Map<string, {model: string, apis: string[], replies: number, generations: number, firstTry: number, words: number, waitMs: number, waitN: number}>} */
    const models = new Map();
    /** @type {Map<string, {preset: string, replies: number, generations: number}>} */
    const presets = new Map();
    /** @type {Map<string, {model: string, preset: string, replies: number, generations: number, firstTry: number, words: number, waitMs: number, waitN: number}>} */
    const combos = new Map();
    /** @type {{at: number, card: string}[]} */
    const events = [];
    const hours = Array(24).fill(0);
    /** Local calendar day (days since the epoch, in the reader's zone) → replies read that day. */
    /** @type {Map<number, number>} */
    const days = new Map();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const localDay = (/** @type {number} */ at) => Math.floor((at - tzOffsetMin * 60000) / DAY_MS);

    const row = (map, key, make) => {
        let value = map.get(key);
        if (!value) { value = make(); map.set(key, value); }
        return value;
    };

    /**
     * @param {any[]} messages The chat's rows, header row included or not.
     * @param {object} [chat]
     * @param {string} [chat.card] Fallback card name for rows that carry none.
     * @returns {void}
     */
    function addChat(messages, { card = '' } = {}) {
        for (const message of messages) {
            if (!message || typeof message !== 'object' || message.chat_metadata !== undefined) continue;
            const name = typeof message.name === 'string' && message.name ? message.name : card;
            if (message.is_user) {
                const at = parseStamp(message.send_date, tzOffsetMin);
                if (!message.is_system && inWindow(at)) {
                    totals.userMessages++;
                    events.push({ at, card: '' });
                }
                continue;
            }
            const all = generationsOf(message, tzOffsetMin);
            const mine = all.filter((g) => inWindow(g.at));
            if (mine.length === 0) continue;
            // Never rerolled, in the window or out of it: one generation, ever.
            const firstTry = all.length === 1;
            // The reply is credited to the swipe on screen when that one is in the window, else
            // to the last one written inside it.
            const credit = mine.find((g) => g.kept) ?? mine[mine.length - 1];

            totals.replies++;
            // A reply belongs to the day its credited draft was written.
            days.set(localDay(credit.at), (days.get(localDay(credit.at)) ?? 0) + 1);
            totals.generations += mine.length;
            if (firstTry) totals.firstTry++;
            totals.words += wordsIn(credit.text);
            if (credit.preset) totals.stamped++;

            const cardRow = row(cards, name, () => ({ name, replies: 0, generations: 0 }));
            cardRow.replies++;
            cardRow.generations += mine.length;

            const seenCombo = new Set();
            for (const g of mine) {
                totals.tokensOut += g.tokensOut;
                totals.tokensPrompt += g.tokensPrompt;
                if (g.tokensPrompt > 0) totals.usageKnown++;
                if (g.cost !== null) { totals.spend += g.cost; totals.spendN++; }
                const wait = g.startedAt !== null && g.at > g.startedAt ? g.at - g.startedAt : null;
                if (wait !== null) { totals.waitMs += wait; totals.waitN++; }

                // One row per model, whichever door it came through: the same Claude over the
                // API and over a subscription is one favourite, not two.
                const modelRow = row(models, g.model, () => ({ model: g.model, apis: [], replies: 0, generations: 0, firstTry: 0, words: 0, waitMs: 0, waitN: 0 }));
                modelRow.generations++;
                modelRow.words += wordsIn(g.text);
                if (wait !== null) { modelRow.waitMs += wait; modelRow.waitN++; }
                if (g === credit && firstTry) modelRow.firstTry++;
                if (g.api && !modelRow.apis.includes(g.api)) modelRow.apis.push(g.api);
                // A reply belongs to ONE model and one preset, the credited swipe's, so shares
                // add up to a whole. Rerolls on other models still count as their generations.
                if (g === credit) modelRow.replies++;

                if (g.preset) {
                    const presetRow = row(presets, g.preset, () => ({ preset: g.preset, replies: 0, generations: 0 }));
                    presetRow.generations++;
                    if (g === credit) presetRow.replies++;

                    const comboKey = `${g.model}\u0000${g.preset}`;
                    const combo = row(combos, comboKey, () => ({ model: g.model, preset: g.preset, replies: 0, generations: 0, firstTry: 0, words: 0, waitMs: 0, waitN: 0 }));
                    combo.generations++;
                    combo.words += wordsIn(g.text);
                    if (wait !== null) { combo.waitMs += wait; combo.waitN++; }
                    if (!seenCombo.has(comboKey)) {
                        seenCombo.add(comboKey);
                        combo.replies++;
                        if (firstTry) combo.firstTry++;
                    }
                }

                for (const matcher of matchers) {
                    if (!matcher.regex || !g.text) continue;
                    matcher.regex.lastIndex = 0;
                    const found = g.text.match(matcher.regex);
                    if (found) {
                        matcher.count += found.length;
                        // Who wrote it: the same tally, kept per model.
                        const mine = row(phraseModels, g.model, () => /** @type {Record<string, number>} */ ({}));
                        mine[matcher.id] = (mine[matcher.id] ?? 0) + found.length;
                    }
                }

                events.push({ at: g.at, card: name });
                if (g.startedAt !== null && inWindow(g.startedAt)) events.push({ at: g.startedAt, card: name });
            }
        }
    }

    /** Local wall-clock parts of an instant, for the reader's zone. */
    const localParts = (at) => {
        const d = new Date(at - tzOffsetMin * 60000);
        return { hour: d.getUTCHours(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
    };

    function result() {
        events.sort((a, b) => a.at - b.at);
        let activeMs = 0, sittings = 0;
        /** @type {{ms: number, card: string, from: number}|null} */
        let longest = null;
        /** @type {{minutes: number, rolled: number, at: number, card: string}|null} */
        let latestNight = null;
        let start = 0;
        const close = (endIndex) => {
            const slice = events.slice(start, endIndex + 1);
            const ms = slice[slice.length - 1].at - slice[0].at;
            sittings++;
            activeMs += ms;
            if (!longest || ms > longest.ms) {
                const counts = new Map();
                for (const e of slice) if (e.card) counts.set(e.card, (counts.get(e.card) ?? 0) + 1);
                const card = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
                longest = { ms, card, from: slice[0].at };
            }
        };
        events.forEach((event, index) => {
            const { hour, minutes } = localParts(event.at);
            hours[hour]++;
            // Minutes past the rollover hour: 11 PM = 1080, 1:30 AM = 1230.
            const rolled = (minutes - NIGHT_END_HOUR * 60 + 1440) % 1440;
            const isNight = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
            if (isNight && (!latestNight || rolled > latestNight.rolled)) {
                // A user turn has no card of its own: borrow the nearest reply's, looking a few
                // events either way (several user turns can sit between two replies).
                let card = event.card;
                for (let step = 1; !card && step <= 6; step++) card = events[index + step]?.card || events[index - step]?.card || '';
                latestNight = { minutes, rolled, at: event.at, card };
            }
            const next = events[index + 1];
            if (!next || next.at - event.at > SITTING_GAP_MS) { close(index); start = index + 1; }
        });

        const ranked = (map, by = 'replies') => [...map.values()].sort((a, b) => b[by] - a[by] || b.generations - a.generations);
        const share = (n) => ratio(n, totals.replies);
        const busiest = hours.some((n) => n > 0) ? hours.indexOf(Math.max(...hours)) : null;
        const played = [...days.keys()].sort((a, b) => a - b);
        let streak = 0, run = 0;
        /** @type {{day: number, replies: number}|null} */
        let bestDay = null;
        played.forEach((day, index) => {
            run = index > 0 && day === played[index - 1] + 1 ? run + 1 : 1;
            if (run > streak) streak = run;
            const count = days.get(day) ?? 0;
            if (!bestDay || count > bestDay.replies) bestDay = { day, replies: count };
        });

        return {
            window: { from, to },
            replies: totals.replies,
            generations: totals.generations,
            rerolls: totals.generations - totals.replies,
            generationsPerReply: ratio(totals.generations, totals.replies),
            keptFirstTry: share(totals.firstTry),
            userMessages: totals.userMessages,
            words: totals.words,
            wordsPerReply: ratio(totals.words, totals.replies),
            tokens: { output: totals.tokensOut, prompt: totals.tokensPrompt, generationsWithUsage: totals.usageKnown },
            // What the provider itself said these drafts cost, and how many of them it spoke for.
            // Not on any card yet: a number that covers some replies and not others needs to say so.
            spend: { credits: totals.spend, generations: totals.spendN },
            waitAvgMs: ratio(totals.waitMs, totals.waitN),
            activeMs,
            sittings,
            longestSitting: longest,
            latestNight,
            busiestHour: busiest,
            // Activity by hour of the local day (replies, swipes and the reader's own turns).
            hours: [...hours],
            // The calendar: each local day that had a reply, as days since the epoch in the
            // reader's zone (`Math.floor((ms - tzOffsetMin * 60000) / 86400000)`), so the
            // client can lay a month out without parsing a date.
            days: played.map((day) => ({ day, replies: days.get(day) ?? 0 })),
            daysPlayed: played.length,
            longestStreak: streak,
            bestDay,
            cards: ranked(cards).slice(0, top).map((c) => ({ ...c, share: share(c.replies) })),
            // Each model carries its own report-card numbers, so a card can be drawn for a model
            // alone while no reply in the window has a preset stamp yet.
            models: ranked(models).slice(0, top).map((m) => ({
                model: m.model,
                apis: m.apis,
                replies: m.replies,
                generations: m.generations,
                share: share(m.replies),
                generationsPerReply: ratio(m.generations, m.replies),
                keptFirstTry: ratio(m.firstTry, m.replies),
                wordsPerGeneration: ratio(m.words, m.generations),
                waitAvgMs: ratio(m.waitMs, m.waitN),
            })),
            presets: ranked(presets).slice(0, top).map((p) => ({ ...p, share: share(p.replies) })),
            // How much of the window the preset numbers actually cover: replies written before
            // the stamp existed carry no preset, and a card has to be able to say so.
            presetCoverage: share(totals.stamped),
            combos: ranked(combos).slice(0, top).map((c) => ({
                model: c.model,
                preset: c.preset,
                replies: c.replies,
                generations: c.generations,
                generationsPerReply: ratio(c.generations, c.replies),
                keptFirstTry: ratio(c.firstTry, c.replies),
                wordsPerGeneration: ratio(c.words, c.generations),
                waitAvgMs: ratio(c.waitMs, c.waitN),
            })),
            // Which model says which phrase: counts beside how many drafts each model wrote, so
            // a reader can turn them into a rate (a model that wrote more would say more).
            phraseModels: ranked(models).slice(0, top).map((m) => ({ model: m.model, generations: m.generations, counts: phraseModels.get(m.model) ?? {} })),
            phrases: matchers.filter((m) => m.count > 0).sort((a, b) => b.count - a.count).map(({ id, label, count }) => ({ id, label, count })),
        };
    }

    return { addChat, result };
}

/**
 * One-shot form of the tally, for a single chat or a test.
 * @param {any[]} messages
 * @param {Parameters<typeof createTally>[0]} options
 */
export function tallyChat(messages, options) {
    const tally = createTally(options);
    tally.addChat(messages);
    return tally.result();
}
