import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '@adobe/css-tools';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIRECTORY = path.join(REPO_ROOT, 'public', 'themes');
const TOKENS_PATH = path.join(REPO_ROOT, 'public', 'css', 'tokens.css');
const ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Parses theme:new arguments.
 * @param {string[]} args
 * @returns {{ id: string, parentId: string }}
 */
function parseArguments(args) {
    let id = '';
    let parentId = 'blue-hour';

    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];

        if (argument === '--extends') {
            parentId = args[index + 1] ?? '';
            index += 1;
            continue;
        }

        if (argument.startsWith('--')) {
            throw new Error(`Unknown option: ${argument}`);
        }

        if (id) {
            throw new Error(`Unexpected argument: ${argument}`);
        }

        id = argument;
    }

    if (!id) {
        throw new Error('Usage: npm run theme:new -- <id> [--extends blue-hour]');
    }

    if (!ID_PATTERN.test(id)) {
        throw new Error(`Invalid theme id "${id}"; expected [a-z0-9-]+`);
    }

    if (!ID_PATTERN.test(parentId)) {
        throw new Error(`Invalid parent theme id "${parentId}"; expected [a-z0-9-]+`);
    }

    if (id === parentId) {
        throw new Error('A theme cannot extend itself');
    }

    return { id, parentId };
}

/**
 * Turns a slug into the starter display name.
 * @param {string} id
 * @returns {string}
 */
function displayName(id) {
    const name = id.split('-')
        .filter(Boolean)
        .map(part => part[0].toUpperCase() + part.slice(1))
        .join(' ');
    return name || id;
}

/**
 * Normalizes a CSS comment for a Markdown table cell.
 * @param {string} comment
 * @returns {string}
 */
function cleanComment(comment) {
    return comment
        .replace(/[─]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\|/g, '\\|');
}

/**
 * Reads every canonical token and its nearest tokens.css comment.
 * @returns {Promise<{ token: string, comment: string }[]>}
 */
async function readTokenCatalog() {
    const css = await fs.readFile(TOKENS_PATH, 'utf8');
    const ast = parse(css, { source: TOKENS_PATH });
    const rootRule = ast.stylesheet.rules.find(rule => (
        rule.type === 'rule'
        && rule.selectors?.length === 1
        && rule.selectors[0] === ':root'
    ));

    if (!rootRule || rootRule.type !== 'rule') {
        throw new Error('public/css/tokens.css has no standalone :root rule');
    }

    const catalog = [];
    let section = 'Token substrate';
    /** @type {string[]} */
    let pendingComments = [];

    for (const declaration of rootRule.declarations ?? []) {
        if (declaration.type === 'comment') {
            const comment = cleanComment(declaration.comment);
            if (!comment) {
                continue;
            }

            if (declaration.comment.includes('──')) {
                section = comment;
                pendingComments = [];
            } else {
                pendingComments.push(comment);
            }
            continue;
        }

        if (declaration.type !== 'declaration' || !declaration.property.startsWith('--k-')) {
            continue;
        }

        catalog.push({
            token: declaration.property,
            comment: pendingComments.join(' ') || section,
        });
        pendingComments = [];
    }

    return catalog;
}

/**
 * Creates a starter theme pack without overwriting an existing folder.
 * @param {string} id
 * @param {string} parentId
 */
async function createTheme(id, parentId) {
    const parentManifest = path.join(THEMES_DIRECTORY, parentId, 'theme.json');
    try {
        await fs.access(parentManifest);
    } catch {
        throw new Error(`Parent theme does not exist: ${parentId}`);
    }

    const themeDirectory = path.join(THEMES_DIRECTORY, id);
    try {
        await fs.access(themeDirectory);
        throw new Error(`Theme folder already exists: public/themes/${id}`);
    } catch (error) {
        if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) {
            throw error;
        }
    }

    const catalog = await readTokenCatalog();
    const manifest = {
        $schema: '../../kotatsu/theme/theme.schema.json',
        id,
        name: displayName(id),
        version: 1,
        extends: parentId,
        tokens: {},
    };
    const readme = [
        `# ${manifest.name}`,
        '',
        `This pack extends \`${parentId}\`. Add only intentional overrides to \`theme.json\`; every other token remains inherited.`,
        '',
        '## Token catalog',
        '',
        '| Token | `tokens.css` comment |',
        '| --- | --- |',
        ...catalog.map(entry => `| \`${entry.token}\` | ${entry.comment} |`),
        '',
    ].join('\n');

    await fs.mkdir(themeDirectory, { recursive: false });
    await fs.writeFile(path.join(themeDirectory, 'theme.json'), `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    await fs.writeFile(path.join(themeDirectory, 'README.md'), readme, 'utf8');

    console.log(`Created public/themes/${id}/ with ${catalog.length} documented tokens.`);
}

try {
    const { id, parentId } = parseArguments(process.argv.slice(2));
    await createTheme(id, parentId);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
