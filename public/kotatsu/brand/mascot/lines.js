/**
 * Mikan-chan's lines — the one place her voice lives (docs/onboarding-v0.md §6).
 *
 * She is the house spirit of the kotatsu: warm, a little smug, sure you'll be fine. Teases the
 * reader, never a failure. One mikan bit per moment at most. About two bubble lines (180
 * characters; one-word beats like "Much." are her timing), because the real instructions live
 * in the UI beside her bubble — skipping her loses nothing. Honest: a
 * failure line quotes the actual reason through `{reason}`, never a vague "something went wrong".
 * No emoji (house rule); her expressions are the art.
 *
 * Each key holds variants; {@link line} picks one. Tune the voice here, never in a component.
 */

/** @type {Readonly<Record<string, readonly string[]>>} */
export const LINES = Object.freeze({
    welcome: Object.freeze([
        'Oh! A new face. Get in, the kotatsu\'s warm. I\'m Mikan-chan, and I\'ll get you set up before the tea gets cold.',
        'Hi hi! Mikan-chan, house spirit, professional table-warmer. Let\'s make this place yours. It takes a minute, I promise.',
        'You made it! Shoes off, legs under the blanket. I\'m Mikan-chan, and I\'m about to make you very comfortable.',
    ]),
    connect: Object.freeze([
        'First, a brain for your stories. Claude Code if you\'ve got it, an API key if you don\'t. I don\'t judge. Much.',
        'Every story needs someone smart on the other end. Plug something in and I\'ll check it\'s really talking.',
    ]),
    connectFailed: Object.freeze([
        'Hm. That didn\'t take. It says: {reason}. Fix that and poke me again; I\'ll wait right here.',
        'Oops, no spark. The reason it gave me: {reason}. Not your fault. Probably.',
    ]),
    // Claude Code is optional (v0.2.3): not finding it is a fork in the road, never a failure.
    connectNoClaude: Object.freeze([
        'No Claude Code on this computer, and that\'s fine. It\'s one door of several. An API key, a ChatGPT plan, a local model: pick yours and I\'ll check it\'s talking.',
        'I peeked: no Claude Code here. No trouble at all! Bring an API key or a ChatGPT plan instead, and I\'ll make sure someone smart answers.',
    ]),
    connected: Object.freeze([
        'There it is! {what} is listening. Next stop: the sauce.',
        'Connected to {what}. Ooh, it\'s warm in here now. Shall we keep going?',
    ]),
    connectSkipped: Object.freeze([
        'Skipping the brain? Bold. You can look around, but nobody will write back until something\'s connected. The Connection tab is always there.',
    ]),
    sauce: Object.freeze([
        'Every story needs a sauce. Ours is Kotatsu Nabe, and it\'s already in the pot. Taste the others if you like; you can always switch later.',
        'Recipe time! Nabe\'s simmering, the rest are on the shelf. Pick one, pick how you like to play, and I\'ll stir.',
    ]),
    sauceOwn: Object.freeze([
        'Nabe. Ours, start to finish, and light enough to let you lead. I may be biased.',
    ]),
    sauceSola: Object.freeze([
        'Sola, Pyrxpia\'s. She made it, so the thanks go to her. It brings its own regex scripts, and you get to say yes or no to them.',
    ]),
    sauceBorrowed: Object.freeze([
        '{author}\'s sauce. Made by someone else, so say thanks over there. Stir it however you like.',
    ]),
    saucePlain: Object.freeze([
        'Plain? A purist. Respect. Bring your own seasoning whenever you like.',
    ]),
    effort: Object.freeze([
        'How hard should Claude think? Higher is smarter and slower. I\'d go high. I always go high.',
    ]),
    persona: Object.freeze([
        'Okay, mirror time. Who are you in these stories? A name\'s enough. The rest can come later.',
        'Every story needs a you. Give me a name and I\'ll make sure everyone uses it.',
    ]),
    personaNamed: Object.freeze([
        '{name}. Ooh, I like it.',
        '{name}! That suits you. I\'ll make sure everyone uses it.',
    ]),
    card: Object.freeze([
        'Now someone to talk to! Bring a card from somewhere, build one from scratch, or say hi to Seraphina. She\'s nice. Suspiciously nice.',
        'Characters live on cards. Got one already? Toss it here. Want to make one? I love a project.',
    ]),
    cardLanded: Object.freeze([
        '{name}! Good pick. They\'re waiting right behind me whenever you\'re ready.',
        'There they are. {name} looks ready to talk. I\'d say hi first, it\'s only polite.',
    ]),
    cardFailed: Object.freeze([
        'Hm. That one wouldn\'t come in. It says: {reason}. Try another, or we can make one from scratch.',
    ]),
    ready: Object.freeze([
        'Look at you, all set up! Go write something good. I\'ll be under the table if you need me.',
        'Done! The kotatsu\'s warm, the story\'s waiting, and I saved you a mikan. Go on.',
    ]),
    readyLoose: Object.freeze([
        'That\'s the tour! A couple of things are still open, and that\'s fine. They\'re one press away whenever you want them.',
    ]),
    veteran: Object.freeze([
        'Ohh, a veteran. Fine, fine. I\'ll be around.',
    ]),
    replay: Object.freeze([
        'Again? Okay, scoot over.',
    ]),
    phonePaired: Object.freeze([
        'There! {device} is in. Slide over, there\'s room under the blanket.',
        '{device} found us. That code is spent now, so nobody else gets in on it. I\'m thorough like that.',
        'Look who followed you to the table. {device} can come in; I checked.',
    ]),
});

/**
 * One line for a situation, with `{name}` placeholders filled.
 * @param {keyof typeof LINES} key Situation.
 * @param {Record<string, string>} [values] Placeholder values, e.g. `{ reason }`.
 * @param {() => number} [random] Source of randomness (tests pin it).
 * @returns {string} The line, or '' for an unknown key.
 */
export function line(key, values = {}, random = Math.random) {
    const variants = LINES[key];
    if (!variants?.length) return '';
    const chosen = variants[Math.min(variants.length - 1, Math.floor(random() * variants.length))];
    return chosen.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}
