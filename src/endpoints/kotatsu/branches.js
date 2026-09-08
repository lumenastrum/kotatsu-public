import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import validateAvatarUrlMiddleware from '../../middleware/validateFileName.js';
import { isPathUnderParent } from '../../util.js';
import { maintainTree, renameChatWithHeal } from './branch-tree.js';

const CHAT_EXTENSION = '.jsonl';

export const router = express.Router();

/**
 * Resolves the character chat folder for a request, or null when the request
 * names a path outside the user's chats directory. Group chats are out of scope
 * for v0.
 * @param {import('express').Request} request Express request.
 * @returns {string | null}
 */
function resolveChatFolder(request) {
    const avatarUrl = request.body?.avatar_url;
    if (typeof avatarUrl !== 'string' || !avatarUrl) {
        return null;
    }

    const directoryName = avatarUrl.replace('.png', '');
    if (!directoryName) {
        return null;
    }

    const chatFolder = path.join(request.user.directories.chats, directoryName);
    if (!isPathUnderParent(request.user.directories.chats, chatFolder)) {
        return null;
    }

    return chatFolder;
}

/**
 * Sanitizes a chat file name and confines it to the chat folder.
 * @param {string} chatFolder Chat folder path.
 * @param {unknown} fileName Requested file name.
 * @returns {string | null} The sanitized `.jsonl` file name.
 */
function resolveChatFileName(chatFolder, fileName) {
    if (typeof fileName !== 'string' || !fileName) {
        return null;
    }

    const sanitized = sanitize(fileName);
    if (!sanitized || path.extname(sanitized) !== CHAT_EXTENSION) {
        return null;
    }

    if (!isPathUnderParent(chatFolder, path.join(chatFolder, sanitized))) {
        return null;
    }

    return sanitized;
}

router.post('/tree', validateAvatarUrlMiddleware, async (request, response) => {
    try {
        const chatFolder = resolveChatFolder(request);
        if (!chatFolder) {
            return response.sendStatus(400);
        }

        const stats = await fs.promises.stat(chatFolder).catch(() => null);
        if (!stats || !stats.isDirectory()) {
            return response.sendStatus(404);
        }

        const { tree, build } = await maintainTree(chatFolder);
        return response.json({ ...tree, build });
    } catch (error) {
        console.error('Failed to build the Kotatsu branch tree:', error);
        return response.sendStatus(500);
    }
});

router.post('/rename', validateAvatarUrlMiddleware, async (request, response) => {
    try {
        const chatFolder = resolveChatFolder(request);
        if (!chatFolder) {
            return response.sendStatus(400);
        }

        const originalFile = resolveChatFileName(chatFolder, request.body?.original_file);
        const renamedFile = resolveChatFileName(chatFolder, request.body?.renamed_file);
        if (!originalFile || !renamedFile) {
            return response.sendStatus(400);
        }

        const result = await renameChatWithHeal(chatFolder, originalFile, renamedFile);
        if (!result.ok) {
            console.error(`Failed to rename a Kotatsu branch chat: ${result.reason}`);
            return response.status(400).send({ error: true });
        }

        return response.send({
            ok: true,
            sanitizedFileName: result.sanitizedFileName,
            healedChildren: result.healedChildren,
        });
    } catch (error) {
        console.error('Failed to rename a Kotatsu branch chat:', error);
        return response.status(500).send({ error: true });
    }
});
