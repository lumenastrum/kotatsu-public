#!/usr/bin/env node
/**
 * scripts/release.mjs — cut a Kotatsu release onto the public mirror.
 *
 * docs/ship-v0.md decision 1: the source repo stays private; `lumenastrum/kotatsu-public`
 * carries one squashed commit per release, built from the source tree at HEAD:
 *   tracked files  →  minus docs/ (except the public contracts), CLAUDE.md, .claude/, tests/
 *                  →  plus a freshly built dist/lib.js
 *                  →  committed as "Kotatsu v<kotatsu.version>", tagged, pushed.
 *
 * Usage:
 *   node scripts/release.mjs --dry-run          export + verify, touch nothing remote
 *   node scripts/release.mjs --clio "Opus 5.5"  build, export, commit, tag, push
 * Flags:
 *   --clio <model>     the Clio cutting it, for the commit trailer (required unless --dry-run)
 *   --mirror <url>     default https://github.com/lumenastrum/kotatsu-public.git
 *   --work <dir>       local clone of the mirror; default ../kotatsu-public next to this repo
 *   --tag <name>       default v<package.json kotatsu.version>
 *   --allow-dirty      skip the clean-tree check (never for a real release)
 *   --no-build         reuse the dist/ already on disk
 *   --force            allow re-cutting an existing tag (moves it)
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASES, WIKI_BASE } from '../public/kotatsu/whats-new/releases.js';
import { latestRelease } from '../public/kotatsu/whats-new/state.js';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR_DEFAULT = 'https://github.com/lumenastrum/kotatsu-public.git';
const MIRROR_BRANCH = 'main';
const INSTALLER = 'Install Kotatsu.bat';
/**
 * The installer also rides every GitHub Release as a downloadable file, and the README links
 * `releases/latest/download/<this>`. raw.githubusercontent serves the .bat as text/plain, so a
 * browser shows the script instead of saving it (a Reddit user hit exactly that on 2026-10-04).
 * No space in the name: GitHub would rewrite it to a dot.
 */
const INSTALLER_ASSET = 'Install-Kotatsu.bat';
const COMMIT_EMAIL = '43384618+lumenastrum@users.noreply.github.com';
const COMMIT_NAME = 'lumenastrum';
/**
 * The release commit's trailer names the Clio cutting it (`--clio "Opus 5.5"`). It used to be a
 * constant, and a constant names whichever model wrote the script, forever.
 * @param {string} model
 * @returns {string}
 */
const coAuthor = (model) => `Co-Authored-By: Clio (${model}) <sparklenailsclio@gmail.com>`;

/**
 * Public-facing docs: the contracts the README links to, and the theme authoring guide with the
 * example packs it walks through (people make themes from the mirror). Everything else under
 * docs/ is internal.
 */
const KEEP_DOCS = new Set(['docs/data-contract.md', 'docs/providers.md', 'docs/theme-authoring-guide.md']);
const KEEP_DOC_PREFIXES = ['docs/theme-examples/'];
// default/presets-upstream/ holds authors' original files; the mirror ships the normalized copies.
const STRIP_PREFIXES = ['docs/', 'tests/', '.claude/', 'default/presets-upstream/'];
const STRIP_FILES = new Set(['CLAUDE.md']);
/**
 * Anything matching these must never reach the mirror — checked on the exported tree, not the
 * rules. The tracked placeholders that create empty dirs on clone (data/.gitkeep,
 * plugins/.gitkeep + plugins/package.json, backups/!README.md) are the only files allowed
 * under those roots.
 */
const PLACEHOLDERS = new Set(['data/.gitkeep', 'plugins/.gitkeep', 'plugins/package.json', 'backups/!README.md']);
const FORBIDDEN = [
    /^(data|plugins|backups)\//, /^config\.yaml$/, /(^|\/)secrets\.json$/,
    /^CLAUDE\.md$/, /^\.claude\//, /^tests\//, /^docs\/(?!data-contract\.md$|providers\.md$|theme-authoring-guide\.md$|theme-examples\/)/,
    /^node_modules\//, /\.jsonl$/,
];
const isForbidden = (rel) => !PLACEHOLDERS.has(rel) && FORBIDDEN.some((re) => re.test(rel));
const DIST_FILES = ['dist/lib.js', 'dist/lib.js.LICENSE.txt'];

function parseArgs(argv) {
    const out = { dryRun: false, allowDirty: false, build: true, force: false, mirror: MIRROR_DEFAULT, work: null, tag: null, clio: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--allow-dirty') out.allowDirty = true;
        else if (a === '--no-build') out.build = false;
        else if (a === '--force') out.force = true;
        else if (a === '--mirror') out.mirror = argv[++i];
        else if (a === '--work') out.work = path.resolve(argv[++i]);
        else if (a === '--tag') out.tag = argv[++i];
        else if (a === '--clio') out.clio = argv[++i];
        else throw new Error(`Unknown argument: ${a}`);
    }
    out.work ??= path.resolve(repoDir, '..', 'kotatsu-public');
    return out;
}

function git(cwd, args, { allowFail = false } = {}) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
        if (allowFail) return null;
        throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${error.stderr?.trim() || error.message}`);
    }
}

/**
 * Node 24 rejects spawnSync('npm.cmd'); run npm's JS entry with this exact node. Windows keeps
 * npm next to node.exe; macOS/Linux keep it under <prefix>/lib.
 */
function npm(cwd, args) {
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const npmCli = candidates.find((file) => fs.existsSync(file));
    if (!npmCli) throw new Error(`npm-cli.js not found for this node:\n${candidates.join('\n')}`);
    execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' });
}

function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function shouldStrip(rel) {
    if (STRIP_FILES.has(rel)) return true;
    if (KEEP_DOCS.has(rel) || KEEP_DOC_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
    return STRIP_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

/** Empties a directory except `.git`. Refuses to touch links so a stray junction can never be followed. */
function emptyExceptGit(dir) {
    for (const entry of fs.readdirSync(dir)) {
        if (entry === '.git') continue;
        const full = path.join(dir, entry);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error(`Refusing to remove a link in the mirror worktree: ${full}`);
        fs.rmSync(full, { recursive: true, force: true });
    }
}

/**
 * The installer is the one file people download raw, so what the index holds is what they run.
 * It uses labels, and cmd cannot reliably find a label in an LF-only batch file (v0.2.3: the
 * LF blob failed with "cannot find the batch label specified" on the skip path). `.gitattributes`
 * marks it `-text`; this refuses to cut if the staged blob is anything but CRLF.
 * @param {string} dir Repository to check
 * @param {string} which Name for the error message
 */
function assertInstallerCrlf(dir, which) {
    const eol = git(dir, ['ls-files', '--eol', '--', INSTALLER]);
    if (!/^i\/crlf\s/.test(eol)) {
        throw new Error(`${INSTALLER} is not stored with CRLF line endings in the ${which} index (${eol || 'not tracked'}). Check .gitattributes, then: git add --renormalize "${INSTALLER}"`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    const version = pkg.kotatsu?.version;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`package.json kotatsu.version is missing or malformed: ${String(version)}`);
    }
    const tag = args.tag ?? `v${version}`;
    if (!args.dryRun && !args.clio) {
        throw new Error('Say which Clio is cutting this release: --clio "<model>", e.g. --clio "Opus 5.5"');
    }

    // --- preflight on the source ---
    const dirty = git(repoDir, ['status', '--porcelain']);
    if (dirty && !args.allowDirty) {
        throw new Error(`Source tree is not clean; commit or stash first (or --allow-dirty for a dry run):\n${dirty}`);
    }
    // Bundled presets (docs/preset-bundle-v0.md §6): every shipped preset is in the credits
    // manifest with an "own" or "granted" permission, its upstream bytes are the author's, and its
    // shipped copy is current. A preset whose author hasn't answered can't reach strangers.
    try {
        execFileSync(process.execPath, [path.join(repoDir, 'scripts', 'normalize-shipped-presets.mjs'), '--check'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        throw new Error(`Bundled presets are not releasable (run node scripts/normalize-shipped-presets.mjs --check):\n${error.stderr || error.stdout || error.message}`);
    }
    assertInstallerCrlf(repoDir, 'source');
    const branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const sha = git(repoDir, ['rev-parse', 'HEAD']);
    const shortSha = sha.slice(0, 9);
    console.log(`Kotatsu ${tag} from ${branch}@${shortSha}${dirty ? ' (DIRTY)' : ''}`);

    // --- build the frontend bundle in the source tree (it has node_modules) ---
    if (args.build) {
        console.log('Building dist/lib.js …');
        npm(repoDir, ['run', 'build:lib']);
    }
    for (const rel of DIST_FILES) {
        if (!fs.existsSync(path.join(repoDir, rel))) throw new Error(`Missing build artifact: ${rel}`);
    }

    // --- export tracked files minus the internal set ---
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), `kotatsu-export-${tag}-`));
    const tracked = git(repoDir, ['ls-files', '-z']).split('\0').filter(Boolean);
    let copied = 0;
    const stripped = [];
    const missing = [];
    for (const rel of tracked) {
        if (shouldStrip(rel)) { stripped.push(rel); continue; }
        const src = path.join(repoDir, rel);
        // Tracked but deleted in the working tree (only possible with --allow-dirty).
        if (!fs.existsSync(src)) { missing.push(rel); continue; }
        const dst = path.join(exportDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied++;
    }
    for (const rel of DIST_FILES) {
        const dst = path.join(exportDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(repoDir, rel), dst);
        copied++;
    }
    // The mirror ships dist/ so nobody downstream needs webpack: un-ignore it there.
    const ignorePath = path.join(exportDir, '.gitignore');
    const ignoreLines = fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/);
    const ignoreOut = ignoreLines.filter((line) => line.trim() !== '/dist');
    if (ignoreOut.length === ignoreLines.length) throw new Error('.gitignore no longer has the /dist line this script expects');
    fs.writeFileSync(ignorePath, `${ignoreOut.join('\n').replace(/\n+$/, '')}\n`);

    // --- verify the exported tree against the forbidden list (walk what is actually there) ---
    const exported = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else exported.push(path.relative(exportDir, full).replaceAll('\\', '/'));
        }
    })(exportDir);
    const violations = exported.filter(isForbidden);
    if (violations.length) {
        throw new Error(`Export contains files that must never ship:\n${violations.join('\n')}`);
    }
    const summary = {
        tag,
        source: `${branch}@${shortSha}`,
        tracked: tracked.length,
        exported: exported.length,
        stripped: stripped.length,
        strippedTopLevel: [...new Set(stripped.map((rel) => rel.split('/')[0]))],
        missingInWorkingTree: missing,
        keptDocs: exported.filter((rel) => rel.startsWith('docs/')),
        dist: DIST_FILES.map((rel) => `${rel} sha256:${sha256(path.join(exportDir, rel)).slice(0, 12)}`),
        exportDir,
    };
    console.log(JSON.stringify(summary, null, 2));

    if (args.dryRun) {
        console.log(`\nRelease notes for ${tag}:\n${releaseBody(tag, '<sha>', branch)}\n`);
        console.log('Dry run: mirror untouched. Export left at', exportDir);
        return;
    }

    // --- mirror worktree ---
    const work = args.work;
    if (!fs.existsSync(path.join(work, '.git'))) {
        console.log(`Cloning ${args.mirror} → ${work}`);
        git(path.dirname(work), ['clone', args.mirror, work]);
    }
    git(work, ['config', 'user.email', COMMIT_EMAIL]);
    git(work, ['config', 'user.name', COMMIT_NAME]);
    git(work, ['remote', 'set-url', 'origin', args.mirror]);
    git(work, ['fetch', 'origin', '--tags', '--prune']);
    const remoteMain = git(work, ['rev-parse', '--verify', `origin/${MIRROR_BRANCH}`], { allowFail: true });
    if (remoteMain) git(work, ['checkout', '-B', MIRROR_BRANCH, `origin/${MIRROR_BRANCH}`]);
    else git(work, ['checkout', '--orphan', MIRROR_BRANCH]);
    const tagExists = git(work, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
    if (tagExists && !args.force) throw new Error(`Tag ${tag} already exists on the mirror; bump kotatsu.version or pass --force`);

    emptyExceptGit(work);
    fs.cpSync(exportDir, work, { recursive: true });
    git(work, ['add', '-A']);
    // The mirror's own .gitignore hides dist/ and the placeholder dirs from `add -A`
    // (v0.1.0 shipped without data/, plugins/, backups/ — harmless, boot creates what it
    // needs, but the tree should match the source). Force them in, when present.
    const forced = [...DIST_FILES, ...PLACEHOLDERS].filter((rel) => fs.existsSync(path.join(work, rel)));
    git(work, ['add', '-f', ...forced]);
    assertInstallerCrlf(work, 'mirror');
    const staged = git(work, ['status', '--porcelain']);
    if (!staged) {
        console.log('Mirror already matches this export; nothing to commit.');
        return;
    }
    const message = [
        `Kotatsu ${tag}`,
        '',
        `Built from lumenastrum/kotatsu ${shortSha} (${branch}). Frontend bundle prebuilt; internal docs and tests stripped.`,
        '',
        coAuthor(args.clio),
    ].join('\n');
    const messageFile = path.join(exportDir, '.release-message.txt');
    fs.writeFileSync(messageFile, `${message}\n`);
    git(work, ['commit', '-q', '-F', messageFile]);
    git(work, ['tag', ...(args.force ? ['-f'] : []), '-a', tag, '-m', `Kotatsu ${tag}`]);
    const mirrorSha = git(work, ['rev-parse', '--short', 'HEAD']);
    console.log(`Committed ${mirrorSha} on ${MIRROR_BRANCH}, tagged ${tag}. Pushing …`);
    git(work, ['push', 'origin', MIRROR_BRANCH]);
    git(work, ['push', ...(args.force ? ['-f'] : []), 'origin', `refs/tags/${tag}`]);
    console.log(`Pushed. ${args.mirror.replace(/\.git$/, '')}/releases/tag/${tag}`);
    createGithubRelease(args.mirror, tag, shortSha, branch, path.join(work, INSTALLER));
    fs.rmSync(exportDir, { recursive: true, force: true });
}

/**
 * The release's own notes, from the entry What's New shows in the app
 * (`public/kotatsu/whats-new/releases.js`), so the release page and the app never disagree.
 * A fix-up release with no entry of its own carries the newest notes below it, said so, since
 * `releases/latest` is the page people are linked to.
 * @param {string} tag e.g. `v0.5.0`
 * @returns {string[]} Markdown lines; empty when no release at or below it has notes.
 */
function releaseNotesFor(tag) {
    const entry = latestRelease(tag, RELEASES);
    if (!entry) return [];
    const own = `v${entry.version}` === tag;
    return [
        ...(own ? [] : [`_Fixes only. The notes below came with v${entry.version}._`, '']),
        `## ${entry.title}`,
        '',
        ...entry.cards.flatMap((card) => [
            `**${card.title}**`,
            card.wiki ? `${card.body} [Read more](${WIKI_BASE}${card.wiki})` : card.body,
            '',
        ]),
        ...(entry.notes?.length ? [own ? '**Also in this release**' : `**Also in v${entry.version}**`, ...entry.notes.map((note) => `- ${note}`), ''] : []),
    ];
}

/**
 * The GitHub Release body: the notes, then where it was built from and how to install it.
 * @param {string} tag
 * @param {string} shortSha
 * @param {string} branch
 * @returns {string}
 */
function releaseBody(tag, shortSha, branch) {
    return [
        ...releaseNotesFor(tag),
        `Built from the private source repo at \`${shortSha}\` (${branch}).`,
        '',
        `**Install (Windows):** download \`${INSTALLER_ASSET}\` below and double-click it.`,
        '**Update an existing install:** click the pill in the header, or run `Update.bat`.',
    ].join('\n');
}

/**
 * Best effort: a GitHub Release object so the tag has a page, with the installer attached.
 * Needs `gh` logged in; skipped otherwise.
 * @param {string} installerPath The mirror worktree's installer (CRLF, already asserted)
 */
function createGithubRelease(mirror, tag, shortSha, branch, installerPath) {
    const match = mirror.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (!match) return;
    const repo = match[1];
    const run = (a) => execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
        run(['--version']);
    } catch {
        console.log('gh not found; create the GitHub Release by hand if you want a release page.');
        return;
    }
    let exists = false;
    try {
        run(['release', 'view', tag, '-R', repo]);
        exists = true;
        console.log(`GitHub Release ${tag} already exists.`);
    } catch {
        // not there yet — create it
    }
    if (!exists) {
        const notes = releaseBody(tag, shortSha, branch);
        try {
            run(['release', 'create', tag, '-R', repo, '--title', `Kotatsu ${tag}`, '--notes', notes, '--latest']);
            console.log(`GitHub Release created: https://github.com/${repo}/releases/tag/${tag}`);
        } catch (error) {
            console.log(`GitHub Release not created (${error.stderr?.trim() || error.message}); the tag is pushed regardless.`);
            return;
        }
    }
    // Attach under the asset name via a temp copy; --clobber so a re-cut (--force) replaces it.
    const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kotatsu-asset-'));
    const assetPath = path.join(assetDir, INSTALLER_ASSET);
    fs.copyFileSync(installerPath, assetPath);
    try {
        run(['release', 'upload', tag, assetPath, '--clobber', '-R', repo]);
        console.log(`Installer attached: https://github.com/${repo}/releases/download/${tag}/${INSTALLER_ASSET}`);
    } catch (error) {
        console.log(`Installer NOT attached (${error.stderr?.trim() || error.message}). The README links releases/latest/download/${INSTALLER_ASSET}, so attach it by hand: gh release upload ${tag} "${INSTALLER_ASSET}" -R ${repo}`);
    } finally {
        fs.rmSync(assetDir, { recursive: true, force: true });
    }
}

try {
    main();
} catch (error) {
    console.error(`\n[release] ${error.message}`);
    process.exitCode = 1;
}
