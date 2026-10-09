import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import express from 'express';
import { sync as commandExistsSync } from 'command-exists';
import { default as simpleGit } from 'simple-git';

import { serverDirectory } from '../../server-directory.js';
import { getConfigValue } from '../../util.js';

/*
 * Kotatsu self-update — slice B of `docs/ship-v0.md` (decision 5, "git pull with a face").
 *
 * Three endpoints behind `/api/kotatsu/update`:
 *   GET  /check    — is a newer commit sitting on the release mirror?
 *   POST /apply    — fast-forward onto it, install deps, build the bundle if missing.
 *   POST /restart  — hand the process back to the launcher's restart loop.
 *
 * ── The origin guard (why every path stands down on a dev clone) ─────────────
 * `git pull` is a destructive-enough verb that it must never fire against a remote
 * we did not publish. The configured `kotatsu.update.repo` is the release mirror;
 * this module refuses to fetch, and refuses to pull, unless the checkout's `origin`
 * actually points there. Two shapes count as a match:
 *   1. a GitHub slug (`lumenastrum/kotatsu-public`) matching origin's exact host
 *      and repository path: HTTPS, `ssh://git@github.com[:22]/…`, or
 *      `git@github.com:…`, with an optional `.git` suffix and trailing slash; and
 *   2. an absolute filesystem path equal to origin's, resolved — that is how the
 *      update drill stands a local bare repo in for the mirror, and how anyone
 *      testing a release without pushing to GitHub does the same.
 * On this repo `origin` is the PRIVATE source repo, so the dev
 * tree answers `{enabled: false, reason: 'origin is not the release mirror (…)'}`
 * and never touches the network. That is the intended dev-clone behaviour, not a bug.
 *
 * ── Why npm is spawned through `process.execPath` ────────────────────────────
 * `spawnSync('npm.cmd', …)` fails with EINVAL on Windows under Node 24 (the shell-less
 * spawn of a `.cmd` is refused). Running npm's own CLI entry point with the Node binary
 * that is already executing us sidesteps the shim entirely and is the same interpreter
 * the server runs under, so the install matches the runtime by construction.
 */

export const router = express.Router();

/** Update checks are cheap but not free (a network fetch). Six hours, per ship-v0. */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;

/** Hard ceiling on the log we hand the client, so a noisy install cannot flood the pill. */
const MAX_LOG_CHARS = 8000;

/** npm flags shared by the launcher scripts and `/apply` — one install shape, one stamp. */
const NPM_INSTALL_ARGS = [
    'install',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    '--no-progress',
    '--omit=dev',
    '--ignore-scripts',
];

/**
 * @typedef {object} UpdateConfig
 * @property {boolean} enabled Whether self-update is switched on at all.
 * @property {string} repo Release mirror: a `owner/name` slug or an absolute path.
 * @property {string} branch Branch on the mirror that releases land on.
 */

/**
 * @typedef {object} CheckResult
 * @property {boolean} enabled False when the feature is off OR the guard stood it down.
 * @property {string} [reason] Present only when `enabled` is false. Human-readable.
 * @property {{kotatsuVersion: string, sha: string | null, branch: string | null}} current
 * @property {{sha: string | null}} remote
 * @property {boolean} behind
 * @property {string} checkedAt ISO timestamp.
 */

/** @type {CheckResult | null} Last successful check, served until it ages out. */
let cachedCheck = null;
/** @type {number} `Date.now()` of the cached check. */
let cachedAt = 0;

/** @type {boolean} `/apply` is not re-entrant: one git pull + npm install at a time. */
let applyInFlight = false;

/**
 * Reads the `kotatsu.update` block. Defaults match `default/config.yaml`, so a config
 * predating this block behaves exactly like the shipped one rather than crashing.
 * @returns {UpdateConfig}
 */
function readUpdateConfig() {
    return {
        enabled: !!getConfigValue('kotatsu.update.enabled', true, 'boolean'),
        repo: String(getConfigValue('kotatsu.update.repo', '') ?? ''),
        branch: String(getConfigValue('kotatsu.update.branch', 'main') ?? 'main'),
    };
}

/**
 * A git handle rooted at the install, or null when this is not a working checkout.
 * `getVersion()` (src/util.js) builds its handle exactly this way; same baseDir, same
 * `commandExistsSync` gate, so the two never disagree about what git can see.
 * @returns {import('simple-git').SimpleGit | null}
 */
function openGit() {
    if (!commandExistsSync('git')) {
        return null;
    }
    if (!fs.existsSync(path.join(serverDirectory, '.git'))) {
        return null;
    }
    return simpleGit({ baseDir: serverDirectory });
}

/**
 * Reads a GitHub owner/name slug from a remote path, rejecting extra path segments.
 * @param {string} remotePath Repository path, without a leading slash.
 * @returns {string|null} Case-folded owner/name, or null for an unsupported path.
 */
function githubSlug(remotePath) {
    const slug = remotePath.replace(/\/$/, '').replace(/\.git$/i, '');
    return /^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(slug) ? slug.toLowerCase() : null;
}

/**
 * Whether `origin` is the configured release mirror. A slug trusts only GitHub's exact
 * host and repository; a local mirror trusts only the configured resolved path.
 * @param {string} originUrl Origin's fetch URL as git reports it.
 * @param {string} repo Configured `kotatsu.update.repo`.
 * @returns {boolean}
 */
function originIsMirror(originUrl, repo) {
    const origin = String(originUrl ?? '').trim();
    const mirror = String(repo ?? '').trim();
    if (!origin || !mirror) return false;

    if (path.isAbsolute(mirror)) {
        try {
            const fileUrl = /^file:/i.test(origin) ? new URL(origin) : null;
            if (fileUrl?.search || fileUrl?.hash) return false;
            const originPath = fileUrl ? fileURLToPath(fileUrl) : origin;
            if (!path.isAbsolute(originPath)) return false;
            const a = path.resolve(originPath);
            const b = path.resolve(mirror);
            return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
        } catch {
            return false;
        }
    }

    // The configured form is owner/name, not an arbitrary remote URL or path fragment.
    // A configured `.git` suffix or trailing slash folds the same way origin's does.
    const wanted = githubSlug(mirror);
    if (!wanted) return false;
    const scpPath = /^git@github\.com:(.+)$/i.exec(origin)?.[1];
    if (scpPath) return githubSlug(scpPath) === wanted;

    try {
        const url = new URL(origin);
        if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return false;
        const https = url.protocol === 'https:' && !url.port && !url.username && !url.password;
        const ssh = url.protocol === 'ssh:' && (!url.port || url.port === '22')
            && url.username === 'git' && !url.password;
        if (!https && !ssh) return false;
        return githubSlug(url.pathname.slice(1)) === wanted;
    } catch {
        return false;
    }
}

/**
 * Resolves origin's fetch URL, or null when there is no origin.
 * @param {import('simple-git').SimpleGit} git
 * @returns {Promise<string | null>}
 */
async function readOriginUrl(git) {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(remote => remote.name === 'origin');
    return origin?.refs?.fetch || null;
}

/**
 * The Kotatsu version from `package.json`. Read fresh (not cached) so a version bumped
 * by an `/apply` in this same process is reported honestly on the next `/check`.
 * @returns {string}
 */
function readKotatsuVersion() {
    try {
        const raw = fs.readFileSync(path.join(serverDirectory, 'package.json'), 'utf8');
        return JSON.parse(raw)?.kotatsu?.version ?? 'UNKNOWN';
    } catch {
        return 'UNKNOWN';
    }
}

/**
 * Local HEAD sha and branch name. Never throws; a detached or empty checkout reports nulls.
 * @param {import('simple-git').SimpleGit | null} git
 * @returns {Promise<{sha: string | null, branch: string | null}>}
 */
async function readLocalHead(git) {
    if (!git) {
        return { sha: null, branch: null };
    }
    try {
        const sha = (await git.revparse(['HEAD'])).trim();
        const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
        return { sha, branch };
    } catch {
        return { sha: null, branch: null };
    }
}

/**
 * Builds the stood-down answer. Same shape as a real check so the pill has one parser.
 * @param {string} reason Why nothing will be fetched.
 * @param {{sha: string | null, branch: string | null}} head Local head, best effort.
 * @returns {CheckResult}
 */
function standDown(reason, head) {
    return {
        enabled: false,
        reason,
        current: { kotatsuVersion: readKotatsuVersion(), sha: head.sha, branch: head.branch },
        remote: { sha: null },
        behind: false,
        checkedAt: new Date().toISOString(),
    };
}

/**
 * Whether `ancestor` is reachable from `descendant` — i.e. the local HEAD is strictly
 * behind the mirror rather than merely different (a dirty local commit must NOT read as
 * "update ready", because `pull --ff-only` would refuse it and the pill would lie).
 * @param {import('simple-git').SimpleGit} git
 * @param {string} ancestor
 * @param {string} descendant
 * @returns {Promise<boolean>}
 */
async function isAncestor(git, ancestor, descendant) {
    try {
        // Exits 0 when true, 1 when false; simple-git rejects on the non-zero exit.
        await git.raw(['merge-base', '--is-ancestor', ancestor, descendant]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Runs one check against the mirror. Callers own the cache.
 * @returns {Promise<CheckResult>}
 */
async function runCheck() {
    const config = readUpdateConfig();
    const git = openGit();
    const head = await readLocalHead(git);

    if (!config.enabled) {
        return standDown('kotatsu.update.enabled is false in config.yaml', head);
    }
    if (!git) {
        return standDown('this install is not a git checkout, or git is not on PATH', head);
    }
    if (!config.repo) {
        return standDown('kotatsu.update.repo is not configured', head);
    }

    const originUrl = await readOriginUrl(git);
    if (!originUrl) {
        return standDown('this checkout has no origin remote', head);
    }
    if (!originIsMirror(originUrl, config.repo)) {
        return standDown(`origin is not the release mirror (${originUrl})`, head);
    }

    await git.fetch('origin', config.branch);
    const localSha = (await git.revparse(['HEAD'])).trim();
    const remoteSha = (await git.revparse([`origin/${config.branch}`])).trim();
    const behind = localSha !== remoteSha && await isAncestor(git, localSha, remoteSha);

    return {
        enabled: true,
        current: { kotatsuVersion: readKotatsuVersion(), sha: localSha, branch: head.branch },
        remote: { sha: remoteSha },
        behind,
        checkedAt: new Date().toISOString(),
    };
}

/**
 * Absolute path to npm's CLI entry point next to the running Node binary.
 * @returns {string}
 */
function npmCliPath() {
    return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/**
 * Runs npm with the interpreter already executing us. See the header note on EINVAL.
 * @param {string[]} args npm arguments.
 * @returns {{ok: boolean, output: string}}
 */
function runNpm(args) {
    const cli = npmCliPath();
    if (!fs.existsSync(cli)) {
        return { ok: false, output: `npm CLI not found at ${cli}` };
    }
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: serverDirectory,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
        windowsHide: true,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.error) {
        return { ok: false, output: `${output}\n${result.error.message}`.trim() };
    }
    return { ok: result.status === 0, output };
}

/**
 * The dependency stamp: sha256 of `package-lock.json`. Only the launcher scripts ever READ
 * it, and they cannot parse `--dataRoot`, so it lives at the install-relative
 * `data/.kotatsu/install-stamp` regardless of where the data root actually is (the tracked
 * `data/.gitkeep` guarantees the folder exists in every checkout). Kotatsu state lives in a
 * dotfolder and is rebuildable (CLAUDE.md) — deleting it costs one install.
 * @returns {string} Stamp file path.
 */
function stampPath() {
    return path.join(serverDirectory, 'data', '.kotatsu', 'install-stamp');
}

/**
 * Writes the install stamp for the lockfile as it stands right now.
 * @returns {void}
 */
function writeInstallStamp() {
    const lock = path.join(serverDirectory, 'package-lock.json');
    if (!fs.existsSync(lock)) {
        return;
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(lock)).digest('hex');
    const target = stampPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, digest, 'utf8');
}

/**
 * Trims a joined log to the ceiling, keeping the TAIL — errors land at the end.
 * @param {string[]} parts Log fragments.
 * @returns {string}
 */
function trimLog(parts) {
    const joined = parts.filter(Boolean).join('\n').trim();
    return joined.length > MAX_LOG_CHARS
        ? `…\n${joined.slice(joined.length - MAX_LOG_CHARS)}`
        : joined;
}

// The running version alone, for What's New: no git, no network, so it answers on every install
// (a dev clone, an offline machine) and never waits on /check's remote lookup.
router.get('/version', (request, response) => {
    return response.json({ kotatsuVersion: readKotatsuVersion() });
});

router.get('/check', async (request, response) => {
    try {
        const force = request.query.force === '1' || request.query.force === 'true';
        if (!force && cachedCheck && Date.now() - cachedAt < CHECK_TTL_MS) {
            return response.json(cachedCheck);
        }

        const result = await runCheck();
        cachedCheck = result;
        cachedAt = Date.now();
        return response.json(result);
    } catch (error) {
        console.error('Kotatsu update check failed:', error);
        return response.status(500).json({ error: 'Update check failed. See the server log.' });
    }
});

router.post('/apply', async (request, response) => {
    if (applyInFlight) {
        return response.status(409).json({ ok: false, reason: 'An update is already running.' });
    }

    const config = readUpdateConfig();
    const git = openGit();
    if (!config.enabled) {
        return response.status(400).json({ ok: false, reason: 'kotatsu.update.enabled is false in config.yaml' });
    }
    if (!git) {
        return response.status(400).json({ ok: false, reason: 'this install is not a git checkout, or git is not on PATH' });
    }

    applyInFlight = true;
    try {
        const originUrl = await readOriginUrl(git);
        if (!originUrl || !originIsMirror(originUrl, config.repo)) {
            return response.status(400).json({
                ok: false,
                reason: `origin is not the release mirror (${originUrl ?? 'no origin remote'})`,
            });
        }

        const from = (await git.revparse(['HEAD'])).trim();
        const log = [];

        const pull = await git.raw(['pull', '--ff-only', 'origin', config.branch]);
        log.push(String(pull ?? '').trim());

        const to = (await git.revparse(['HEAD'])).trim();

        const install = runNpm(NPM_INSTALL_ARGS);
        log.push(install.output);
        if (!install.ok) {
            // The pull already landed, so `from`/`to` are still the truth of what moved.
            // The stamp is deliberately NOT written: the next launch retries the install.
            return response.status(500).json({ ok: false, from, to, log: trimLog(log), reason: 'npm install failed' });
        }
        writeInstallStamp();

        // The mirror ships `dist/lib.js`, so this is the never-taken branch on a released
        // install and the always-taken one on a checkout that has never built the bundle.
        if (!fs.existsSync(path.join(serverDirectory, 'dist', 'lib.js'))) {
            const build = runNpm(['run', 'build:lib']);
            log.push(build.output);
            if (!build.ok) {
                return response.status(500).json({ ok: false, from, to, log: trimLog(log), reason: 'build:lib failed' });
            }
        }

        // The next /check must not serve a pre-pull answer.
        cachedCheck = null;
        cachedAt = 0;

        return response.json({ ok: true, from, to, log: trimLog(log) });
    } catch (error) {
        console.error('Kotatsu update apply failed:', error);
        const message = error instanceof Error ? error.message : String(error);
        return response.status(500).json({ ok: false, reason: message });
    } finally {
        applyInFlight = false;
    }
});

router.post('/restart', (request, response) => {
    /*
     * Exit code 75 is the contract with `Start.bat` / `start.sh`: their launch loop reads it
     * as "come back up", anything else as "stay down". We do NOT call `process.exit(75)` —
     * that would skip `exitProcess()` in server-main.js (stats flush, plugin cleanup, the
     * Claude bridge listener). Instead: set `process.exitCode`, then raise SIGINT so the
     * graceful handler runs and its bare `process.exit()` honours the code we set.
     *
     * Scheduled off the response's `finish` event so the JSON is on the wire before the
     * process starts tearing down — the pill needs the ack to move into `restarting`.
     */
    response.json({ ok: true });
    response.once('finish', () => {
        setImmediate(() => {
            console.log('Kotatsu update: restarting on request (exit code 75).');
            process.exitCode = 75;
            process.emit('SIGINT');
        });
    });
});
