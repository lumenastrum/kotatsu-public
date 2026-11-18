import fs from 'node:fs';
import path from 'node:path';

import { createTally } from './engine.js';

/**
 * Kotatsu Wrapped — reading the chats off disk for the engine.
 *
 * Nothing is cached and nothing is written: the `.jsonl` files are the only source, so the
 * numbers are always rebuildable (repo rule). The one shortcut is honest: a chat file last
 * written before the window opens cannot hold anything inside the window, so it is skipped
 * unread. A month of play on a library of a thousand old chats reads only the chats touched
 * that month.
 */

const CHAT_EXTENSION = '.jsonl';

/**
 * Every chat file under a folder, one level of card folders deep (`chats/<card>/x.jsonl`) or
 * flat (`group chats/x.jsonl`).
 * @param {string} root
 * @returns {{file: string, card: string}[]}
 */
function chatFiles(root) {
    /** @type {{file: string, card: string}[]} */
    const out = [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        if (entry.isFile() && entry.name.endsWith(CHAT_EXTENSION)) {
            out.push({ file: full, card: '' });
        } else if (entry.isDirectory()) {
            let inner;
            try { inner = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
            for (const chat of inner) {
                if (chat.isFile() && chat.name.endsWith(CHAT_EXTENSION)) out.push({ file: path.join(full, chat.name), card: entry.name });
            }
        }
    }
    return out;
}

/**
 * @param {string} file
 * @returns {any[]} The rows that parse; a torn or foreign line is skipped, never fatal.
 */
function readRows(file) {
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return rows;
}

/**
 * Tallies every chat in the given folders over a window.
 * @param {string[]} roots Chat roots: the user's `chats` and `group chats` directories.
 * @param {Parameters<typeof createTally>[0]} options
 * @returns {ReturnType<ReturnType<typeof createTally>['result']> & {scan: {files: number, read: number, skippedOld: number, failed: number}}}
 */
export function scanChats(roots, options) {
    const tally = createTally(options);
    const scan = { files: 0, read: 0, skippedOld: 0, failed: 0 };
    for (const root of roots) {
        for (const { file, card } of chatFiles(root)) {
            scan.files++;
            try {
                if (fs.statSync(file).mtimeMs < options.from) { scan.skippedOld++; continue; }
                const rows = readRows(file);
                // The header row names the character; a card folder name is the fallback.
                const header = rows[0]?.chat_metadata !== undefined ? rows[0] : null;
                tally.addChat(rows, { card: typeof header?.character_name === 'string' && header.character_name ? header.character_name : card });
                scan.read++;
            } catch {
                scan.failed++;
            }
        }
    }
    return { ...tally.result(), scan };
}
