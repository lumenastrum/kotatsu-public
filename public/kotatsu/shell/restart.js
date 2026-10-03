/*
 * Shared "restart Kotatsu and come back" helper.
 *
 * One implementation for every surface that offers a restart (the update pill, the Claude Code
 * bridge card). It asks the server to exit 75 so the launcher's loop (Start.bat / start.sh)
 * brings it back, polls `/version` until the NEW process answers, then reloads the page.
 * It never hangs silently: a refused request or a server that does not return resolves
 * `'failed'` and says why through `onState`.
 */

import { getRequestHeaders } from '../../script.js';

/** Restart poll: how often to ask `/version` whether the server is back. */
const POLL_INTERVAL_MS = 1000;

/** Restart poll ceiling. Past this the reload is not going to help; say so instead. */
const POLL_MAX_ATTEMPTS = 90;

/**
 * How long after the restart ack a successful `/version` is accepted as the NEW process
 * even when the poll never caught the server down.
 *
 * Measured on the update drill (2026-09-07, this box): the server stops answering 144 ms
 * after it acks `POST /restart` and answers again 2435 ms later — but the page's FIRST
 * poll consistently lands at ack + ~2.7 s, i.e. after the gap has already closed. An
 * "only accept a success once a failure has been observed" rule therefore never fires,
 * and the caller hangs in `restarting` until the ceiling. The gap is real; catching it is
 * not reliable. Three seconds is twenty times the measured 144 ms in which the old
 * process stops answering, so a success past this point cannot be the old one.
 */
const RESTART_GRACE_MS = 3000;

/**
 * Asks the server to restart (POST /api/kotatsu/update/restart, exit code 75 under Start.bat/start.sh)
 * and waits for it to come back, then reloads the page.
 *
 * Two independent proofs that `/version` is answering from the NEW process, either is enough:
 *   - the poll watched the server go down, so the next success is the restarted one; or
 *   - the success arrived more than `graceMs` after the ack (see `RESTART_GRACE_MS`).
 * @param {{ onState?: (state: 'restarting'|'waiting'|'reloading'|'failed', detail?: string) => void,
 *           pollIntervalMs?: number, maxAttempts?: number, graceMs?: number,
 *           fetchImpl?: typeof fetch, reload?: () => void, now?: () => number }} [options]
 * @returns {Promise<'reloading'|'failed'>}
 */
export async function restartAndWait(options = {}) {
    const {
        onState = () => { },
        pollIntervalMs = POLL_INTERVAL_MS,
        maxAttempts = POLL_MAX_ATTEMPTS,
        graceMs = RESTART_GRACE_MS,
        fetchImpl = (...args) => fetch(...args),
        reload = () => location.reload(),
        now = () => Date.now(),
    } = options;

    onState('restarting');
    let ackAt = now();
    try {
        const response = await fetchImpl('/api/kotatsu/update/restart', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        // Drain the body: the server is about to die, and an unread stream leaves the
        // socket occupied while the connection is torn down under it.
        await response.text().catch(() => undefined);
        ackAt = now();
    } catch (error) {
        console.error('[kotatsu] restart request failed', error);
        const reason = error instanceof Error ? error.message : String(error);
        onState('failed', reason);
        return 'failed';
    }

    onState('waiting');
    let sawDown = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        let up = false;
        try {
            const response = await fetchImpl('/version', {
                headers: getRequestHeaders(),
                cache: 'no-store',
            });
            up = response.ok;
            await response.text().catch(() => undefined);
        } catch {
            up = false;
        }
        if (!up) {
            sawDown = true;
            continue;
        }
        if (sawDown || now() - ackAt >= graceMs) {
            onState('reloading');
            reload();
            return 'reloading';
        }
    }
    onState('failed', 'timeout');
    return 'failed';
}
