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

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIRROR_DEFAULT = 'https://github.com/lumenastrum/kotatsu-public.git';
const MIRROR_BRANCH = 'main';
const COMMIT_EMAIL = '43384618+lumenastrum@users.noreply.github.com';
const COMMIT_NAME = 'lumenastrum';
/**
 * The release commit's trailer names the Clio cutting it (`--clio "Opus 5.5"`). It used to be a
 * constant, and a constant names whichever model wrote the script, forever.
 * @param {string} model
 * @returns {string}
 */
const coAuthor = (model) => `Co-Authored-By: Clio (${model}) <sparklenailsclio@gmail.com>`;

/** Public-facing contracts the README links to; everything else under docs/ is internal. */
const KEEP_DOCS = new Set(['docs/data-contract.md', 'docs/providers.md']);
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
    /^CLAUDE\.md$/, /^\.claude\//, /^tests\//, /^docs\/(?!data-contract\.md$|providers\.md$)/,
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

/** Node 24 rejects spawnSync('npm.cmd'); run npm's JS entry with this exact node. */
function npm(cwd, args) {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npmCli)) throw new Error(`npm-cli.js not found next to node: ${npmCli}`);
    execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' });
}

function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function shouldStrip(rel) {
    if (STRIP_FILES.has(rel)) return true;
    if (KEEP_DOCS.has(rel)) return false;
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
    createGithubRelease(args.mirror, tag, shortSha, branch);
    fs.rmSync(exportDir, { recursive: true, force: true });
}

/** Best effort: a GitHub Release object so the tag has a page. Needs `gh` logged in; skipped otherwise. */
function createGithubRelease(mirror, tag, shortSha, branch) {
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
    try {
        run(['release', 'view', tag, '-R', repo]);
        console.log(`GitHub Release ${tag} already exists.`);
        return;
    } catch {
        // not there yet — create it
    }
    const notes = [
        `Built from the private source repo at \`${shortSha}\` (${branch}).`,
        '',
        '**Install (Windows):** download `Install Kotatsu.bat` from the repo root and double-click it.',
        '**Update an existing install:** click the pill in the header, or run `Update.bat`.',
    ].join('\n');
    try {
        run(['release', 'create', tag, '-R', repo, '--title', `Kotatsu ${tag}`, '--notes', notes, '--latest']);
        console.log(`GitHub Release created: https://github.com/${repo}/releases/tag/${tag}`);
    } catch (error) {
        console.log(`GitHub Release not created (${error.stderr?.trim() || error.message}); the tag is pushed regardless.`);
    }
}

try {
    main();
} catch (error) {
    console.error(`\n[release] ${error.message}`);
    process.exitCode = 1;
}
