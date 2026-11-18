import express from 'express';

import { STARTER_PHRASES } from './phrases-starter.js';
import { scanChats } from './scan.js';

/**
 * `/api/kotatsu/wrapped/*` — Kotatsu Wrapped (docs/wrapped/README.md).
 *
 * `POST /stats { from, to, tzOffsetMin, previous?: { from, to } }` → the numbers for one
 * window (and a few headline numbers for an earlier one to compare with), read fresh from the
 * signed-in user's own chat files. Read-only: nothing is stored, nothing leaves the machine.
 */

export const router = express.Router();

/** A window longer than this is refused: Wrapped is day / week / month, with room for a year. */
const MAX_WINDOW_MS = 400 * 24 * 60 * 60 * 1000;

router.post('/stats', (request, response) => {
    const from = Number(request.body?.from);
    const to = Number(request.body?.to);
    const tzOffsetMin = Number(request.body?.tzOffsetMin ?? 0);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_WINDOW_MS) {
        return response.status(400).json({ error: { message: 'Give a window: from and to in milliseconds, to after from, at most 400 days.' } });
    }
    if (!Number.isFinite(tzOffsetMin) || Math.abs(tzOffsetMin) > 16 * 60) {
        return response.status(400).json({ error: { message: 'tzOffsetMin is the browser’s getTimezoneOffset(), in minutes.' } });
    }
    try {
        const { chats, groupChats } = request.user.directories;
        const stats = scanChats([chats, groupChats], { from, to, tzOffsetMin, phrases: STARTER_PHRASES.phrases });
        // The stretch to compare against (the arrows): the caller says which, so that "this
        // month so far" can be held up to the same days of last month and not to all of it.
        const before = request.body?.previous;
        const [prevFrom, prevTo] = [Number(before?.from), Number(before?.to)];
        let previous = null;
        if (Number.isFinite(prevFrom) && Number.isFinite(prevTo) && prevTo > prevFrom && prevTo - prevFrom <= MAX_WINDOW_MS) {
            const then = scanChats([chats, groupChats], { from: prevFrom, to: prevTo, tzOffsetMin });
            previous = { from: prevFrom, to: prevTo, replies: then.replies, rerolls: then.rerolls, activeMs: then.activeMs, keptFirstTry: then.keptFirstTry, daysPlayed: then.daysPlayed };
        }
        return response.json({ ...stats, previous, phraseList: STARTER_PHRASES.name });
    } catch (error) {
        console.error('[wrapped] could not read the chats', error);
        return response.status(500).json({ error: { message: 'Could not read your chats.' } });
    }
});
