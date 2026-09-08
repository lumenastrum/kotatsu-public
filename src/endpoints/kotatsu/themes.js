import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { serverDirectory } from '../../server-directory.js';

const THEME_ID_PATTERN = /^[a-z0-9-]+$/;
const BUILTIN_THEME_ROOT = path.join(serverDirectory, 'public', 'themes');

/** @typedef {'builtin' | 'user'} ThemeSource */

/**
 * @typedef {object} ThemeSummary
 * @property {string} id
 * @property {string} name
 * @property {ThemeSource} source
 * @property {string} [extends]
 */

export const router = express.Router();

/**
 * Tests whether a path is a strict descendant of a parent path.
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {boolean}
 */
function isPathInside(parentPath, childPath) {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath !== ''
        && relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);
}

/**
 * Resolves a path through the filesystem, returning null when it does not exist.
 * @param {string} filePath
 * @returns {Promise<string | null>}
 */
async function realpathOrNull(filePath) {
    try {
        return await fs.promises.realpath(filePath);
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
            && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            return null;
        }

        throw error;
    }
}

/**
 * Gets the real user theme root only when it remains inside that user's data root.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @returns {Promise<string | null>}
 */
async function getUserThemeRoot(directories) {
    const userRoot = await realpathOrNull(directories.root);
    const themeRoot = await realpathOrNull(directories.themePacks);

    if (!userRoot || !themeRoot || !isPathInside(userRoot, themeRoot)) {
        return null;
    }

    const stats = await fs.promises.stat(themeRoot);
    return stats.isDirectory() ? themeRoot : null;
}

/**
 * Resolves a file inside a pack without permitting lexical or symlink escapes.
 * @param {string} themeRoot A real path to the theme-packs directory.
 * @param {string} id A validated theme id.
 * @param {string} relativePath A pack-relative file path.
 * @returns {Promise<string | null>}
 */
async function resolvePackFile(themeRoot, id, relativePath) {
    const unresolvedPackRoot = path.resolve(themeRoot, id);
    if (!isPathInside(themeRoot, unresolvedPackRoot)) {
        return null;
    }

    const packRoot = await realpathOrNull(unresolvedPackRoot);
    if (!packRoot || !isPathInside(themeRoot, packRoot)) {
        return null;
    }

    const packStats = await fs.promises.stat(packRoot);
    if (!packStats.isDirectory()) {
        return null;
    }

    const unresolvedFile = path.resolve(packRoot, relativePath);
    if (!isPathInside(packRoot, unresolvedFile)) {
        return null;
    }

    const filePath = await realpathOrNull(unresolvedFile);
    if (!filePath || !isPathInside(packRoot, filePath)) {
        return null;
    }

    const fileStats = await fs.promises.stat(filePath);
    return fileStats.isFile() ? filePath : null;
}

/**
 * Resolves a built-in manifest path.
 * @param {string} id
 * @returns {Promise<string | null>}
 */
async function resolveBuiltinManifest(id) {
    const manifestPath = path.join(BUILTIN_THEME_ROOT, id, 'theme.json');

    try {
        const stats = await fs.promises.stat(manifestPath);
        return stats.isFile() ? manifestPath : null;
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
            && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            return null;
        }

        throw error;
    }
}

/**
 * Reads the display metadata used by the pack picker. Schema-invalid manifests
 * stay discoverable so the client validator can report their actual errors.
 * @param {string} id
 * @param {ThemeSource} source
 * @param {string} manifestPath
 * @returns {Promise<ThemeSummary | null>}
 */
async function readThemeSummary(id, source, manifestPath) {
    let rawManifest;

    try {
        rawManifest = await fs.promises.readFile(manifestPath, 'utf8');
    } catch {
        return null;
    }

    /** @type {unknown} */
    let manifest;

    try {
        manifest = JSON.parse(rawManifest);
    } catch {
        return { id, name: id, source };
    }

    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        return { id, name: id, source };
    }

    const record = /** @type {Record<string, unknown>} */ (manifest);
    const name = typeof record.name === 'string' && record.name.trim() ? record.name : id;
    const summary = { id, name, source };

    if (typeof record.extends === 'string') {
        return { ...summary, extends: record.extends };
    }

    return summary;
}

/**
 * Lists packs from one root directory.
 * @param {string} themeRoot
 * @param {ThemeSource} source
 * @returns {Promise<ThemeSummary[]>}
 */
async function listThemeRoot(themeRoot, source) {
    let entries;

    try {
        entries = await fs.promises.readdir(themeRoot, { withFileTypes: true });
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error
            && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            return [];
        }

        throw error;
    }

    const summaries = await Promise.all(entries
        .filter(entry => entry.isDirectory() && THEME_ID_PATTERN.test(entry.name))
        .map(async (entry) => {
            const manifestPath = source === 'user'
                ? await resolvePackFile(themeRoot, entry.name, 'theme.json')
                : await resolveBuiltinManifest(entry.name);

            return manifestPath ? readThemeSummary(entry.name, source, manifestPath) : null;
        }));

    return summaries.filter(summary => summary !== null);
}

/**
 * Rejects malformed theme ids before they reach filesystem operations.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function validateThemeId(request, response, next) {
    if (!THEME_ID_PATTERN.test(request.params.id)) {
        response.sendStatus(400);
        return;
    }

    next();
}

router.param('id', validateThemeId);

router.get('/', async (request, response) => {
    try {
        const userThemeRoot = await getUserThemeRoot(request.user.directories);
        const [builtinPacks, userPacks] = await Promise.all([
            listThemeRoot(BUILTIN_THEME_ROOT, 'builtin'),
            userThemeRoot ? listThemeRoot(userThemeRoot, 'user') : [],
        ]);

        const packsById = new Map(builtinPacks.map(pack => [pack.id, pack]));
        for (const pack of userPacks) {
            packsById.set(pack.id, pack);
        }

        const packs = [...packsById.values()].sort((left, right) => left.id.localeCompare(right.id));
        return response.json(packs);
    } catch (error) {
        console.error('Failed to list Kotatsu theme packs:', error);
        return response.sendStatus(500);
    }
});

router.get('/:id/manifest', async (request, response) => {
    try {
        const userThemeRoot = await getUserThemeRoot(request.user.directories);
        const userManifest = userThemeRoot
            ? await resolvePackFile(userThemeRoot, request.params.id, 'theme.json')
            : null;

        if (userManifest) {
            return response.sendFile(userManifest);
        }

        const builtinManifest = await resolveBuiltinManifest(request.params.id);
        if (builtinManifest) {
            return response.sendFile(builtinManifest);
        }

        return response.sendStatus(404);
    } catch (error) {
        console.error(`Failed to read Kotatsu theme manifest ${request.params.id}:`, error);
        return response.sendStatus(500);
    }
});

router.get('/:id/assets/*', async (request, response) => {
    let assetPath;

    try {
        assetPath = decodeURIComponent(request.params[0]);
    } catch {
        return response.sendStatus(400);
    }

    const segments = assetPath.split('/');
    if (!assetPath || /[\u0000-\u001f\u007f]/.test(assetPath) || path.isAbsolute(assetPath)
        || assetPath.includes('%') || assetPath.includes('\\') || /^[a-z]:/i.test(assetPath)
        || segments.some(segment => !segment || segment === '.' || segment === '..')) {
        return response.sendStatus(400);
    }

    try {
        const userThemeRoot = await getUserThemeRoot(request.user.directories);
        const assetFile = userThemeRoot
            ? await resolvePackFile(userThemeRoot, request.params.id, assetPath)
            : null;

        if (!assetFile) {
            return response.sendStatus(404);
        }

        return response.sendFile(assetFile, { dotfiles: 'deny' });
    } catch (error) {
        console.error(`Failed to read Kotatsu theme asset ${request.params.id}/${assetPath}:`, error);
        return response.sendStatus(500);
    }
});
