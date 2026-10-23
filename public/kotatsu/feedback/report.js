/**
 * Send feedback, as data (docs/feedback-v0.md). Pure: k-feedback.js gathers what the person wrote
 * and the diagnostics they chose to include, this turns it into a GitHub issue, and Jest drives it.
 *
 * Andres, 2026-10-22: a report opens as a pre-filled issue on the public repo in the person's own
 * browser. Nothing is sent from Kotatsu, and nothing reaches GitHub until they press Submit there.
 */

/** Where reports go: the public mirror, where releases are cut and people already file issues. */
export const REPO = 'lumenastrum/kotatsu-public';

/**
 * GitHub answers 414 somewhere past 8 KB of URL, and browsers differ before that. Kept well under:
 * a long report moves its diagnostics to the clipboard instead (see {@link issueUrl}).
 */
export const URL_LIMIT = 7000;

/** @typedef {'bug'|'idea'|'other'} FeedbackKind */

/**
 * The three kinds. `issueLabel` is a label on the public repo (`bug` is GitHub's default; `idea` and
 * `feedback` were added for this form, 2026-10-22). GitHub applies a prefilled label only for someone
 * who can triage the repo and ignores it for everyone else, so it is a convenience, never relied on;
 * the title's prefix is what sorts a stranger's report.
 * @type {Readonly<Record<FeedbackKind, { label: string, prefix: string, issueLabel: string, heading: string, placeholder: string }>>}
 */
export const KINDS = Object.freeze({
    bug: {
        label: 'A problem',
        prefix: 'Bug',
        issueLabel: 'bug',
        heading: 'What happened',
        placeholder: 'What happened, and what did you expect instead? The steps to make it happen again help the most.',
    },
    idea: {
        label: 'An idea',
        prefix: 'Idea',
        issueLabel: 'idea',
        heading: 'The idea',
        placeholder: 'What would you like Kotatsu to do? What would it help you with?',
    },
    other: {
        label: 'Something else',
        prefix: 'Feedback',
        issueLabel: 'feedback',
        heading: 'Feedback',
        placeholder: 'Anything at all: what you love, what confused you, what felt off.',
    },
});

/** What stands in for diagnostics that didn't fit in the link. */
export const PASTE_HERE = '(They were too long for the link, so Kotatsu copied them to your clipboard. Paste them here.)';

/**
 * @param {unknown} kind
 * @returns {FeedbackKind}
 */
export function kindOf(kind) {
    return kind === 'idea' || kind === 'other' ? kind : 'bug';
}

/**
 * The issue's title: what they typed, else the first line of what they wrote (shortened), prefixed
 * with the kind so the issue list reads at a glance even without labels (a stranger's prefilled
 * labels are dropped by GitHub unless they can triage).
 * @param {FeedbackKind} kind
 * @param {string} title
 * @param {string} text
 * @returns {string}
 */
export function issueTitle(kind, title, text) {
    const own = String(title ?? '').trim();
    const first = String(text ?? '').trim().split(/\r?\n/)[0].trim();
    const words = own || (first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first) || 'No title';
    return `[${KINDS[kindOf(kind)].prefix}] ${words}`;
}

/**
 * The issue's body, in Markdown.
 * @param {{ kind: FeedbackKind, text: string, diagnostics: string }} report `diagnostics` is '' when
 *   they chose not to include any.
 * @returns {string}
 */
export function issueBody({ kind, text, diagnostics }) {
    const parts = [`### ${KINDS[kindOf(kind)].heading}`, '', String(text ?? '').trim() || '_(nothing written)_'];
    const diag = String(diagnostics ?? '').trim();
    if (diag) parts.push('', '### Diagnostics', '', diag === PASTE_HERE ? diag : `\`\`\`\n${diag}\n\`\`\``);
    parts.push('', '<sub>Opened from Kotatsu’s feedback form.</sub>');
    return parts.join('\n');
}

/**
 * The new-issue link, and whether the diagnostics had to leave it. A report too long for a link
 * keeps what they wrote and swaps the diagnostics for {@link PASTE_HERE} (the caller copies them);
 * if what they wrote alone is still too long, it is cut, and `cut` says so.
 * @param {{ kind: FeedbackKind, title: string, text: string, diagnostics: string, repo?: string }} report
 * @returns {{ url: string, moved: boolean, cut: boolean }}
 */
export function issueUrl({ kind, title, text, diagnostics, repo = REPO }) {
    const head = `https://github.com/${repo}/issues/new?labels=${KINDS[kindOf(kind)].issueLabel}&title=${encodeURIComponent(issueTitle(kind, title, text))}&body=`;
    const link = (/** @type {string} */ body) => head + encodeURIComponent(body);

    let url = link(issueBody({ kind, text, diagnostics }));
    if (url.length <= URL_LIMIT) return { url, moved: false, cut: false };

    const moved = Boolean(String(diagnostics ?? '').trim());
    url = link(issueBody({ kind, text, diagnostics: moved ? PASTE_HERE : '' }));
    if (url.length <= URL_LIMIT) return { url, moved, cut: false };

    // Still too long: shorten what they wrote until it fits. The full text is on the clipboard too.
    let words = String(text ?? '');
    while (words.length > 0 && url.length > URL_LIMIT) {
        words = words.slice(0, Math.floor(words.length * 0.8));
        url = link(issueBody({ kind, text: `${words.trimEnd()}…\n\n(The rest is on your clipboard.)`, diagnostics: moved ? PASTE_HERE : '' }));
    }
    return { url, moved, cut: true };
}

/**
 * The whole report as one Markdown text, for "Copy report" and for whatever didn't fit the link.
 * @param {{ kind: FeedbackKind, title: string, text: string, diagnostics: string }} report
 * @returns {string}
 */
export function reportText({ kind, title, text, diagnostics }) {
    return `${issueTitle(kind, title, text)}\n\n${issueBody({ kind, text, diagnostics })}`;
}

/**
 * The browser and system, in words a maintainer reads: "Chrome 141 on macOS". From the user agent
 * string alone (Client Hints are not everywhere); no versions of the OS, which UA strings freeze.
 * @param {string} userAgent
 * @returns {string}
 */
export function describeAgent(userAgent) {
    const ua = String(userAgent ?? '');
    const os = /iPhone/.test(ua) ? 'iPhone'
        : /iPad/.test(ua) ? 'iPad'
            : /Android/.test(ua) ? 'Android'
                : /Windows NT/.test(ua) ? 'Windows'
                    : /CrOS/.test(ua) ? 'ChromeOS'
                        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
                            : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
    const pick = (/** @type {RegExp} */ re) => re.exec(ua)?.[1];
    let browser = 'an unknown browser';
    let version;
    if ((version = pick(/Edg(?:A|iOS)?\/(\d+)/))) browser = `Edge ${version}`;
    else if ((version = pick(/(?:Firefox|FxiOS)\/(\d+)/))) browser = `Firefox ${version}`;
    else if ((version = pick(/(?:OPR|Opera)\/(\d+)/))) browser = `Opera ${version}`;
    else if ((version = pick(/(?:Chrome|CriOS)\/(\d+)/))) browser = `Chrome ${version}`;
    else if ((version = pick(/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari/))) browser = `Safari ${version}`;
    return `${browser} on ${os}`;
}

/**
 * @typedef {object} DiagnosticFacts
 * @property {string} version Kotatsu's version, '' when the server didn't say.
 * @property {string} agent {@link describeAgent}'s answer.
 * @property {{ width: number, height: number }} screen The viewport, in CSS pixels.
 * @property {string} layout `rails` or `classic`.
 * @property {string} pack The theme pack id, '' for the default.
 * @property {string} look The message look (`card`, `sprite`…), '' when unknown.
 * @property {string} connection What answers: "Claude Code · Opus 5.5", "ChatGPT plan", "DeepSeek · deepseek-chat"…
 * @property {boolean} connected Whether the connection is up right now.
 * @property {string} claudeCode What the doctor last said, '' when it was never asked.
 * @property {string[]} errors The last errors the page saw, newest last.
 */

/**
 * The diagnostics block, one fact per line, for the person to read (and edit) before sending.
 * Never the chat, never names, never keys: only what tells a maintainer where to look.
 * @param {DiagnosticFacts} facts
 * @returns {string}
 */
export function diagnosticsText(facts) {
    const lines = [
        `Kotatsu ${facts.version || '(version unknown)'}`,
        `Browser: ${facts.agent}`,
        `Window: ${facts.screen.width}×${facts.screen.height}${facts.screen.width <= 600 ? ' (phone-sized)' : ''}`,
        `Layout: ${facts.layout || 'unknown'} · Theme: ${facts.pack || 'Blue Hour (default)'} · Look: ${facts.look || 'unknown'}`,
        `Connection: ${facts.connection || 'none picked'}${facts.connected ? '' : ' (not connected)'}`,
    ];
    if (facts.claudeCode) lines.push(`Claude Code: ${facts.claudeCode}`);
    if (facts.errors.length) {
        lines.push('Recent errors:');
        for (const error of facts.errors) lines.push(`  ${error}`);
    }
    return lines.join('\n');
}
