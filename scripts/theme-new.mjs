// npm run theme:new -- <id> [--from <pack>] [--extends <pack>] [--name "Display name"] [--builtin] [--user <handle>]
//
// Starts a theme pack. By default it goes in data/<user>/theme-packs/<id>/ (yours: updates never
// touch it, and zipping the folder is how you share it); --builtin puts it in public/themes/ for
// packs that ship with Kotatsu.
//   - plain: a pack that extends Blue Hour (or --extends), with its palette pre-filled with the
//     parent's real colours, so it looks exactly like the parent until you change one.
//   - --from <pack>: a copy of an existing pack (every file), renamed, to start from its look.
// Either way the folder gets README.md (a plain cheat sheet), TOKENS.md (every core token) and KNOBS.md (every
// component knob), generated from the live stylesheets, so the cheat sheet is never out of date.
import fs from 'node:fs/promises';
import path from 'node:path';

import { resolvePack } from '../public/kotatsu/theme/core.js';
import { GROWN_PALETTE_KEYS, PALETTE_KEYS, readPalette } from '../public/kotatsu/theme/palette.js';
import { BUILTIN_DIRECTORY, describeKnobReach, displayName, findPack, ID_PATTERN, readCoreTokens, readKnobs, REPO_ROOT, userPackDirectory } from './theme-lib.mjs';

/**
 * @param {string[]} args
 */
function parseArguments(args) {
    const options = { id: '', from: '', parentId: '', name: '', builtin: false, handle: /** @type {string|undefined} */ (undefined) };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        const value = () => {
            const next = args[++index];
            if (!next) throw new Error(`${argument} needs a value`);
            return next;
        };
        if (argument === '--from') options.from = value();
        else if (argument === '--extends') options.parentId = value();
        else if (argument === '--name') options.name = value();
        else if (argument === '--user') options.handle = value();
        else if (argument === '--builtin') options.builtin = true;
        else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
        else if (options.id) throw new Error(`Unexpected argument: ${argument} (put a name with spaces in quotes after --name)`);
        else options.id = argument;
    }
    if (!options.id) throw new Error('Usage: npm run theme:new -- <id> [--from <pack>] [--extends blue-hour] [--name "Display name"] [--builtin]');
    if (!ID_PATTERN.test(options.id)) throw new Error(`"${options.id}" can't be a theme id: use lowercase letters, digits and dashes, like my-cozy-theme`);
    if (options.from && options.parentId) throw new Error('Use --from OR --extends, not both: --from copies a pack, --extends starts a fresh one on top of it');
    for (const other of [options.from, options.parentId]) {
        if (other && !ID_PATTERN.test(other)) throw new Error(`Invalid theme id "${other}"`);
    }
    if (!options.from && !options.parentId) options.parentId = 'blue-hour';
    if (options.id === options.parentId || options.id === options.from) throw new Error('A theme cannot start from itself');
    return options;
}

/**
 * Resolves a pack's finished tokens from disk, for pre-filling a palette.
 * @param {string} id
 * @param {string|undefined} handle
 */
async function resolveFromDisk(id, handle) {
    return resolvePack(id, async packId => {
        const found = await findPack(packId, handle);
        if (!found) return null;
        const manifest = JSON.parse(await fs.readFile(path.join(found.directory, 'theme.json'), 'utf8'));
        let sheetCss;
        if (typeof manifest.sheet === 'string') {
            sheetCss = await fs.readFile(path.join(found.directory, ...manifest.sheet.split('/')), 'utf8').catch(() => '');
        }
        return { manifest, sheetCss };
    }, { baseline: (await readCoreTokens()).tokens });
}

/**
 * Copies a folder recursively (no symlinks followed).
 * @param {string} from
 * @param {string} to
 */
async function copyFolder(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) await copyFolder(source, target);
        else await fs.copyFile(source, target);
    }
}

/**
 * Escapes a value for a Markdown table cell.
 * @param {string} text
 * @returns {string}
 */
function cell(text) {
    return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/**
 * The first sentence of a comment, for a catalog cell.
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
    const match = /^(.{20,220}?[.!?])(\s|$)/.exec(text);
    return match ? match[1] : text.slice(0, 220);
}

/**
 * The settings most themes reach for first, in plain words (the guide's §5 tables, shortened).
 * @type {[string, string][]}
 */
const FIRST_SETTINGS = [
    ['--k-radius-md', 'How round corners are. Also `-xs`, `-sm`, `-lg`, `-xl` for smaller and bigger things.'],
    ['--k-font-prose', 'The font story text is written in. Keep it calm; it is read for hours.'],
    ['--k-font-ui', 'The font of buttons, lists and settings.'],
    ['--k-font-display', 'The font of big titles.'],
    ['--k-font-name', 'The font of the speaker\'s name above each message.'],
    ['--k-font-label', 'The font of small section labels (CHARACTERS, DESCRIPTION...).'],
    ['--k-label-case', 'Labels in `uppercase` (the usual look) or `none` (as written).'],
    ['--k-label-scale', 'Makes every label bigger: `1.3` is 30% bigger.'],
    ['--k-mes-line-height', 'Space between lines of story text, like `1.7`.'],
    ['--k-material-rail', 'What the side panels are made of: a picture or gradient over their colour.'],
    ['--k-material-reading', 'A soft light or texture behind the conversation.'],
    ['--k-app-backdrop', 'Everything behind the app: a picture from your folder, gradients, or both.'],
    ['--k-atmosphere', 'An extra layer for weather or texture (fog, snow, grain). See the guide first.'],
];

/**
 * The cheat sheet a new theme folder starts with. Written for someone who has never seen CSS:
 * the technical full list goes to TOKENS.md instead.
 * @param {{id: string, name: string, parent: string}} pack
 * @returns {string}
 */
function readme(pack) {
    const grown = GROWN_PALETTE_KEYS.map(key => `\`${key}\``);
    const lines = [
        `# ${pack.name}`,
        '',
        `Your Kotatsu theme. It ${pack.parent}. The guide that explains everything step by step is \`docs/theme-authoring-guide.md\` in your Kotatsu folder.`,
        '',
        '## How to work on it',
        '',
        '1. Open `theme.json` in a text editor and change a colour in `palette`. Save the file.',
        `2. In a terminal in the Kotatsu folder, type \`npm run theme:check -- ${pack.id}\`. Fix anything marked FAIL; the line says how.`,
        `3. In Kotatsu, press F5 to reload the page. The first time, pick your theme: Settings (the gear at the top right) → Appearance → Theme → Theme pack → ${pack.name}. Kotatsu remembers your choice.`,
        '',
        'After that it is: edit, save, press F5.',
        '',
        '## Palette colours',
        '',
        'A colour is written as `#` and six characters, like `#e0a157`; any colour picker gives you one. Change one and the colours that grow from it follow (the dimmer text, the deeper panels, the glows).',
        '',
        '| Name | What it colours |',
        '| --- | --- |',
        ...Object.entries(PALETTE_KEYS).map(([key, spec]) => `| \`${key}\` | ${cell(spec.about)} |`),
        '',
        `A colour you write in \`palette\` is always kept exactly as written. ${grown.slice(0, -1).join(', ')} and ${grown.at(-1)} start out left out, so they grow from your other colours; add one only to choose it yourself.`,
        '',
        '## Settings worth knowing first',
        '',
        'These go in `tokens`, written like `"--k-radius-md": "6px"`. A value that is a picture is written `url("textures/wood.svg")` and must be a file inside this folder.',
        '',
        '| Setting | What it changes |',
        '| --- | --- |',
        ...FIRST_SETTINGS.map(([token, about]) => `| \`${token}\` | ${about} |`),
        '',
        '## Fonts and pictures',
        '',
        'Make a `fonts` folder here and put font files in it (`.woff2`, `.ttf` or `.otf`; a Google Fonts download gives `.ttf`), together with the font\'s licence file. Pictures can go in any folder you make here, like `textures` or `bg`. The guide\'s sections 6 and 7 walk through both.',
        '',
        '## The full lists',
        '',
        '- `TOKENS.md`: every setting, with Blue Hour\'s value. Its notes come from Kotatsu\'s own code and are technical; the guide explains the ones most themes need.',
        '- `KNOBS.md`: over 400 fine dials for single parts of the app (card corners, label sizes).',
        '',
        '## Sharing',
        '',
        'Zip this whole folder and send it. Whoever gets it unzips it into their `data/default-user/theme-packs/` folder.',
        '',
    ];
    return lines.join('\n');
}

/**
 * The technical full list of core tokens, with the stylesheet's own notes.
 * @returns {Promise<string>}
 */
async function tokensMarkdown() {
    const { catalog } = await readCoreTokens();
    const lines = [
        '# Every core setting',
        '',
        'Every setting a theme can write in `tokens`, grouped as in Kotatsu\'s `public/css/tokens.css`, with Blue Hour\'s value. The notes are the comments in that file, written for Kotatsu\'s developers; `docs/theme-authoring-guide.md` explains the ones most themes need in plain words. Generated by `npm run theme:new`, so it matches the Kotatsu it was made with.',
    ];
    let section = '';
    for (const entry of catalog) {
        if (entry.section !== section) {
            section = entry.section;
            lines.push('', `## ${section}`, '', '| Setting | Blue Hour value | Notes |', '| --- | --- | --- |');
        }
        lines.push(`| \`${entry.token}\` | \`${cell(entry.value).slice(0, 60)}\` | ${cell(firstSentence(entry.comment))} |`);
    }
    lines.push('');
    return lines.join('\n');
}

/**
 * @returns {Promise<string>}
 */
async function knobsMarkdown() {
    const { knobs } = await readKnobs();
    /** @type {Map<string, [string, any][]>} */
    const groups = new Map();
    for (const entry of Object.entries(knobs)) {
        const list = groups.get(entry[1].group) ?? [];
        list.push(entry);
        groups.set(entry[1].group, list);
    }
    const lines = [
        '# Component knobs',
        '',
        'Every dial a Kotatsu component exposes, generated from the stylesheets (`npm run theme:knobs`). Put any of them in your `tokens` exactly like a core token: `"--k-lib-card-radius": "4px"`. Kotatsu sets your value everywhere that component declares it. When a knob depends on the window size (or a reader setting), its Notes say what happens to your value.',
        '',
    ];
    for (const [group, entries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`## ${group}`, '', '| Knob | Default | Notes |', '| --- | --- | --- |');
        for (const [name, entry] of entries) {
            const reach = describeKnobReach(entry);
            const responsive = reach.reach === 'always' ? '' : `*${reach.text[0].toUpperCase()}${reach.text.slice(1)}.* `;
            lines.push(`| \`${name}\` | \`${cell(entry.default).slice(0, 60)}\` | ${responsive}${cell(firstSentence(entry.note ?? ''))} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * @param {ReturnType<typeof parseArguments>} options
 */
async function createTheme(options) {
    const base = options.builtin ? BUILTIN_DIRECTORY : userPackDirectory(options.handle);
    const directory = path.join(base, options.id);
    if (await findPack(options.id, options.handle)) {
        throw new Error(`A theme called "${options.id}" already exists. Pick another id, or edit that one.`);
    }
    const sourceId = options.from || options.parentId;
    // An example (docs/theme-examples/) may be copied, never extended: the app does not list it.
    const source = await findPack(sourceId, options.handle, { examples: Boolean(options.from) });
    if (!source && options.parentId && await findPack(sourceId, options.handle, { examples: true })) {
        throw new Error(`"${sourceId}" is an example, not an installed theme, so Kotatsu cannot use it as a parent. Copy it instead: npm run theme:new -- ${options.id} --from ${sourceId}`);
    }
    if (!source) throw new Error(`There is no theme called "${sourceId}" to start from. Built-in ones: blue-hour, sparkle, natsumikan, midnight-kissaten; the example kissaten-showcase.`);

    const name = options.name || displayName(options.id);
    const schema = path.relative(directory, path.join(REPO_ROOT, 'public', 'kotatsu', 'theme', 'theme.schema.json')).split(path.sep).join('/');
    /** @type {Record<string, unknown>} */
    let manifest;
    let parentLine;
    if (options.from) {
        await copyFolder(source.directory, directory);
        const copied = JSON.parse(await fs.readFile(path.join(directory, 'theme.json'), 'utf8'));
        manifest = { $schema: schema, ...copied, id: options.id, name, author: 'Your name' };
        manifest.$schema = schema;
        await fs.rm(path.join(directory, 'README.md'), { force: true });
        parentLine = `started as a copy of \`${options.from}\``;
    } else {
        const parent = await resolveFromDisk(options.parentId, options.handle);
        manifest = {
            $schema: schema,
            id: options.id,
            name,
            author: 'Your name',
            description: 'One line about your theme.',
            version: 1,
            extends: options.parentId,
            // The seed colours only: a colour listed here is the author's and never re-grows
            // (palette.js rule 1), so the ones that grow from the others start out left out.
            palette: Object.fromEntries(Object.entries(readPalette({ ...(await readCoreTokens()).tokens, ...parent.tokens }))
                .filter(([key]) => !GROWN_PALETTE_KEYS.includes(key))),
            tokens: {},
        };
        await fs.mkdir(directory, { recursive: true });
        parentLine = `extends \`${options.parentId}\``;
    }

    await fs.writeFile(path.join(directory, 'theme.json'), `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    const about = options.from
        ? `started as a copy of \`${options.from}\``
        : `starts from \`${options.parentId}\`: anything you leave alone looks the way it does there`;
    await fs.writeFile(path.join(directory, 'README.md'), readme({ id: options.id, name, parent: about }), 'utf8');
    await fs.writeFile(path.join(directory, 'TOKENS.md'), await tokensMarkdown(), 'utf8');
    await fs.writeFile(path.join(directory, 'KNOBS.md'), await knobsMarkdown(), 'utf8');

    const where = path.relative(REPO_ROOT, directory).split(path.sep).join('/');
    console.log(`Created ${where}/ (${parentLine.replace(/`/g, '')}).`);
    console.log('Next:');
    console.log(`  1. open ${where}/theme.json and change a palette colour`);
    console.log(`  2. npm run theme:check -- ${options.id}`);
    console.log(`  3. in Kotatsu: press F5, then Settings → Appearance → Theme → Theme pack → ${name}`);
}

try {
    await createTheme(parseArguments(process.argv.slice(2)));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
