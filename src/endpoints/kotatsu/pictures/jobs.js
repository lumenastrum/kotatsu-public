import { randomUUID } from 'node:crypto';

import { imageSize } from 'image-size';

import { compareIds } from './recipes.js';
import { imageExtension, saveImage as storeImage } from './store.js';

/**
 * The job mirror (docs/pictures-v0.md §3.2): an in-memory map of jobId → what Kotatsu knows
 * about one picture on its lane, plus a per-job event feed the SSE route relays.
 *
 * Lifecycle on ComfyUI (event names and payloads from ComfyUI's execution.py / main.py):
 *   submit (upload the reference, POST /prompt) → `queued {position}` → ComfyUI's
 *   `execution_start` / `executing` / `progress` (→ `progress`), binary previews (→ `preview`,
 *   throttled, never stored), `executed` (outputs) → `execution_success` (execution.py :824)
 *   → history saved by `task_done`, then `executing {node: null}` (main.py :367-374) → fetch every
 *   image of every output node from `/history` + `/view`, save them → `done`.
 *   `execution_error` → `error`; `execution_interrupted` (execution.py :699) → `cancelled`.
 *
 * The socket is a fast path, not the source of truth: `execution_success` is sent before
 * history is written, so finishing always reads `/history/<id>` (with a short retry). While the
 * socket is down, and on a slow watchdog while it is up, each unfinished job polls
 * `/history/<id>` and `/queue`, so a dropped socket or a missed event still ends the job.
 *
 * A subscriber that goes away does not cancel anything; `cancel()` does. Finished jobs stay in
 * the mirror for `ttlMs` (1 h) so a client that comes back can still read the result; an
 * unfinished job never expires (it still owns a prompt on the lane).
 */

/** SSE event names. Mirrors `JOB_EVENTS` in public/kotatsu/pictures/contract.js (a test pins it). */
export const JOB_EVENTS = Object.freeze({
    QUEUED: 'queued',
    PROGRESS: 'progress',
    PREVIEW: 'preview',
    DONE: 'done',
    ERROR: 'error',
    CANCELLED: 'cancelled',
});

/** @enum {string} */
export const JOB_STATES = Object.freeze({
    SUBMITTING: 'submitting',
    QUEUED: 'queued',
    RUNNING: 'running',
    SAVING: 'saving',
    DONE: 'done',
    ERROR: 'error',
    CANCELLED: 'cancelled',
});

const TERMINAL_STATES = new Set([JOB_STATES.DONE, JOB_STATES.ERROR, JOB_STATES.CANCELLED]);
const TERMINAL_EVENTS = new Set([JOB_EVENTS.DONE, JOB_EVENTS.ERROR, JOB_EVENTS.CANCELLED]);
const ORPHAN_TTL_MS = 60_000;
const ORPHAN_MAX_EVENTS = 200;

/**
 * One line for a ComfyUI `execution_error` payload (execution.py :701).
 * @param {any} data `execution_error` data, or undefined
 * @returns {string} e.g. `KSampler [7] RuntimeError: CUDA out of memory`
 */
export function describeExecutionError(data) {
    if (!data || typeof data !== 'object') return 'ComfyUI reported an error';
    const where = data.node_type ? `${data.node_type} [${data.node_id}]` : (data.node_id ? `node ${data.node_id}` : '');
    const what = [data.exception_type, data.exception_message].filter(Boolean).join(': ').trim();
    return [where, what].filter(Boolean).join(' ') || 'ComfyUI reported an error';
}

/**
 * @param {number} ms Delay
 * @returns {Promise<void>} Resolves after the delay
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @typedef {import('./comfy.js').ComfyClient} ComfyClient
 * @typedef {(event: string, data: object) => void} JobListener
 *
 * @typedef {object} Job
 * @property {string} id
 * @property {string} owner          Handle of the user who started it (jobs are per user)
 * @property {string} lane
 * @property {string|null} promptId
 * @property {string} server
 * @property {ComfyClient} client
 * @property {string} state
 * @property {string} purpose
 * @property {string} character
 * @property {string} recipe
 * @property {number} seed
 * @property {string} graphSha
 * @property {object} graph
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {{value: number, max: number, node: string|null, nodeTitle?: string}|null} progress
 * @property {number} lastPreviewAt
 * @property {any} pendingPreview
 * @property {NodeJS.Timeout|null} previewTimer
 * @property {NodeJS.Timeout|null} pollTimer
 * @property {Set<JobListener>} listeners
 * @property {{queued: object|null, progress: object|null, terminal: {event: string, data: object}|null}} last
 * @property {Record<string, any>} outputs
 * @property {string[]} outputsOrder
 * @property {string} userImages
 * @property {{bytes: Buffer, name: string, subfolder: string, mime: string}|null} reference
 * @property {boolean} finalizing
 * @property {boolean} released
 * @property {number|null} unreachableSince
 * @property {number} lostChecks
 * @property {string} [model]               key lanes: the provider model id
 * @property {AbortController} [controller] key lanes: aborts the provider call
 */

/**
 * @param {object} [options] Options (all injectable for tests)
 * @param {typeof storeImage} [options.saveImage] Writes one picture
 * @param {() => number} [options.now] Clock
 * @param {number} [options.ttlMs] How long a finished job stays in the mirror
 * @param {number} [options.previewIntervalMs] Minimum gap between relayed previews (250 = 4/s)
 * @param {number} [options.historyPollMs] History poll interval while the socket is down
 * @param {number} [options.watchdogMs] History poll interval while the socket is up
 * @param {number} [options.lostAfterMs] Unreachable this long → the job fails
 * @param {number} [options.historyRetries] Attempts to read history after a success event
 * @param {number} [options.historyRetryMs] Gap between those attempts
 * @param {number} [options.openTimeoutMs] How long a submit waits for the socket
 * @param {{warn?: Function}} [options.logger] Logger
 * @returns {object} The manager
 */
export function createJobManager({
    saveImage = storeImage,
    now = Date.now,
    ttlMs = 3_600_000,
    previewIntervalMs = 250,
    historyPollMs = 1_000,
    watchdogMs = 5_000,
    lostAfterMs = 300_000,
    historyRetries = 20,
    historyRetryMs = 150,
    openTimeoutMs = 2_000,
    logger = console,
} = {}) {
    /** @type {Map<string, Job>} */
    const jobs = new Map();
    /** @type {Map<string, Job>} */
    const byPrompt = new Map();
    /** @type {Map<string, {at: number, events: any[]}>} events for a prompt id whose POST /prompt reply has not arrived yet */
    const orphans = new Map();
    /** @type {WeakSet<ComfyClient>} */
    const attached = new WeakSet();
    /** @type {Map<ComfyClient, NodeJS.Timeout>} */
    const queueTimers = new Map();

    const isTerminal = (/** @type {Job} */ job) => TERMINAL_STATES.has(job.state);

    /**
     * @param {Job} job Job
     * @param {string} event Event name
     * @param {object} data Payload
     */
    function emit(job, event, data) {
        if (event === JOB_EVENTS.QUEUED) job.last.queued = data;
        else if (event === JOB_EVENTS.PROGRESS) job.last.progress = data;
        else if (TERMINAL_EVENTS.has(event)) job.last.terminal = { event, data };
        for (const listener of [...job.listeners]) {
            try {
                listener(event, data);
            } catch (error) {
                logger.warn?.('[Pictures] job listener failed', error);
            }
        }
    }

    /**
     * Ends a job: state, timers, the event, the socket hold.
     * @param {Job} job Job
     * @param {string} event Terminal event
     * @param {object} data Payload
     */
    function complete(job, event, data) {
        if (isTerminal(job)) return;
        job.state = event === JOB_EVENTS.DONE ? JOB_STATES.DONE : event === JOB_EVENTS.ERROR ? JOB_STATES.ERROR : JOB_STATES.CANCELLED;
        job.endedAt = now();
        if (job.previewTimer) clearTimeout(job.previewTimer);
        if (job.pollTimer) clearTimeout(job.pollTimer);
        job.previewTimer = null;
        job.pollTimer = null;
        job.pendingPreview = null;
        emit(job, event, data);
        job.listeners.clear();
        if (!job.released) {
            job.released = true;
            job.client.release();
        }
    }

    /**
     * @param {Job} job Job
     * @param {unknown} error What went wrong
     */
    function fail(job, error) {
        if (isTerminal(job)) return;
        const message = error instanceof Error ? error.message : String(error);
        const nodeErrors = /** @type {any} */ (error)?.nodeErrors;
        logger.warn?.(`[Pictures] job ${job.id} (${job.recipe}) failed: ${message}`);
        complete(job, JOB_EVENTS.ERROR, {
            message,
            ...(nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length ? { nodeErrors } : {}),
        });
    }

    /** @param {Job} job Job */
    function markRunning(job) {
        if (job.state === JOB_STATES.SUBMITTING || job.state === JOB_STATES.QUEUED) job.state = JOB_STATES.RUNNING;
    }

    /**
     * @param {Job} job Job
     * @param {string|null} node Node id
     * @returns {string|undefined} The node's title for the progress line
     */
    function nodeTitle(job, node) {
        const entry = node ? /** @type {any} */ (job.graph)[node] : null;
        return entry ? (entry._meta?.title ?? entry.class_type) : undefined;
    }

    /**
     * @param {Job} job Job
     * @param {{value: number, max: number, node: string|null}} progress Progress
     */
    function setProgress(job, progress) {
        const title = nodeTitle(job, progress.node);
        job.progress = title ? { ...progress, nodeTitle: title } : progress;
        emit(job, JOB_EVENTS.PROGRESS, job.progress);
    }

    /**
     * @param {any} queue `/queue` body
     * @param {string} promptId Prompt id
     * @returns {'running'|'pending'|null} Where the prompt is
     */
    function locate(queue, promptId) {
        if ((queue?.queue_running ?? []).some((/** @type {any[]} */ entry) => entry?.[1] === promptId)) return 'running';
        if ((queue?.queue_pending ?? []).some((/** @type {any[]} */ entry) => entry?.[1] === promptId)) return 'pending';
        return null;
    }

    /**
     * Updates a queued job's place in line from a `/queue` body. Pending entries are
     * `[number, prompt_id, …]` (server.py :1067); ComfyUI runs the lowest number first.
     * @param {Job} job Job
     * @param {any} queue `/queue` body
     */
    function applyPosition(job, queue) {
        if (job.state !== JOB_STATES.QUEUED || !job.promptId) return;
        const where = locate(queue, job.promptId);
        if (where === 'running') {
            markRunning(job);
            return;
        }
        if (where !== 'pending') return;
        const running = queue.queue_running ?? [];
        const pending = [...queue.queue_pending].sort((a, b) => Number(a?.[0]) - Number(b?.[0]));
        const position = running.length + pending.findIndex(entry => entry?.[1] === job.promptId);
        if (position !== /** @type {any} */ (job.last.queued)?.position) emit(job, JOB_EVENTS.QUEUED, { position });
    }

    /** @param {ComfyClient} client Client */
    async function refreshQueue(client) {
        const waiting = [...jobs.values()].filter(job => job.client === client && job.promptId && job.state === JOB_STATES.QUEUED);
        if (!waiting.length) return;
        let queue;
        try {
            queue = await client.queue();
        } catch {
            return;
        }
        for (const job of waiting) applyPosition(job, queue);
    }

    /** @param {ComfyClient} client Client */
    function scheduleQueueRefresh(client) {
        if (queueTimers.has(client)) return;
        const timer = setTimeout(() => {
            queueTimers.delete(client);
            refreshQueue(client);
        }, 50);
        timer.unref?.();
        queueTimers.set(client, timer);
    }

    /**
     * Ends a job from its history entry (ComfyUI execution.py `task_done` writes
     * `{prompt, outputs, status: {status_str, completed, messages}, meta}`).
     * @param {Job} job Job
     * @param {any} entry History entry
     */
    async function settle(job, entry) {
        const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
        const find = (/** @type {string} */ name) => messages.find((/** @type {any} */ m) => Array.isArray(m) && m[0] === name)?.[1];
        if (find('execution_interrupted')) {
            complete(job, JOB_EVENTS.CANCELLED, {});
            return;
        }
        const executionError = find('execution_error');
        if (executionError || entry?.status?.status_str === 'error') {
            fail(job, describeExecutionError(executionError));
            return;
        }
        await finish(job, entry?.outputs ?? {});
    }

    /**
     * Saves every image of every output node, then reports `done`.
     * @param {Job} job Job
     * @param {Record<string, any>} outputs History outputs (nodeId → {images: [...]})
     */
    async function finish(job, outputs) {
        job.state = JOB_STATES.SAVING;
        const order = [
            ...job.outputsOrder.filter(id => Object.hasOwn(outputs, id)),
            ...Object.keys(outputs).filter(id => !job.outputsOrder.includes(id)).sort(compareIds),
        ];
        const items = order.flatMap(id => (Array.isArray(outputs[id]?.images) ? outputs[id].images : []))
            .filter(item => item && typeof item.filename === 'string');
        if (!items.length) {
            fail(job, 'The graph ran but produced no images');
            return;
        }
        const date = new Date(now());
        const images = [];
        for (const [index, item] of items.entries()) {
            const bytes = await job.client.view(item);
            const saved = await saveImage({
                userImages: job.userImages,
                character: job.character,
                seed: job.seed,
                bytes,
                ext: imageExtension(item.filename),
                date,
                index,
            });
            let width = null;
            let height = null;
            try {
                ({ width, height } = imageSize(bytes));
            } catch {
                // unknown format: the client can measure it
            }
            images.push({ url: saved.url, width, height });
        }
        complete(job, JOB_EVENTS.DONE, { images, seed: job.seed, graphSha: job.graphSha, lane: job.lane, recipe: job.recipe });
    }

    /**
     * The socket said the prompt finished: read history (it lands just after the event) and settle.
     * @param {Job} job Job
     */
    async function finalize(job) {
        if (job.finalizing || isTerminal(job) || !job.promptId) return;
        job.finalizing = true;
        let entry = null;
        for (let attempt = 0; attempt < historyRetries && !entry && !isTerminal(job); attempt++) {
            if (attempt) await delay(historyRetryMs);
            try {
                const history = await job.client.history(job.promptId);
                entry = history?.[job.promptId] ?? null;
            } catch {
                // retried; then the poll takes over
            }
        }
        if (isTerminal(job)) return;
        try {
            if (entry) {
                await settle(job, entry);
            } else if (Object.keys(job.outputs).length) {
                await finish(job, job.outputs);
            } else {
                // History not readable yet: hand the job back to the poll.
                job.finalizing = false;
                schedulePoll(job, historyPollMs);
            }
        } catch (error) {
            fail(job, error);
        }
    }

    /**
     * One history/queue check for a job (socket down, or the watchdog).
     * @param {Job} job Job
     */
    async function pollOnce(job) {
        if (isTerminal(job) || job.finalizing || !job.promptId) return;
        let history;
        try {
            history = await job.client.history(job.promptId);
            job.unreachableSince = null;
        } catch {
            job.unreachableSince ??= now();
            if (now() - job.unreachableSince >= lostAfterMs) fail(job, `ComfyUI at ${job.server} stopped answering`);
            return;
        }
        if (isTerminal(job) || job.finalizing) return;
        const entry = history?.[job.promptId];
        if (entry) {
            job.finalizing = true;
            try {
                await settle(job, entry);
            } catch (error) {
                fail(job, error);
            }
            return;
        }
        let queue;
        try {
            queue = await job.client.queue();
        } catch {
            return;
        }
        if (isTerminal(job) || job.finalizing) return;
        const where = locate(queue, job.promptId);
        if (where) {
            job.lostChecks = 0;
            if (where === 'running') markRunning(job);
            else applyPosition(job, queue);
            return;
        }
        // Neither finished nor waiting. History and queue change together under ComfyUI's queue
        // mutex (execution.py `task_done`), but ask twice before calling it lost.
        job.lostChecks++;
        if (job.lostChecks >= 2) fail(job, 'ComfyUI no longer has this job (restarted, or its queue was cleared)');
    }

    /**
     * Keeps a job's history poll running: fast while the socket is down, slow while it is up.
     * @param {Job} job Job
     * @param {number} [delayMs] Override the next delay
     */
    function schedulePoll(job, delayMs) {
        if (isTerminal(job)) return;
        if (job.pollTimer) clearTimeout(job.pollTimer);
        const wait = delayMs ?? (job.client.connected ? watchdogMs : historyPollMs);
        job.pollTimer = setTimeout(async () => {
            job.pollTimer = null;
            await pollOnce(job);
            if (!job.pollTimer) schedulePoll(job);
        }, wait);
        job.pollTimer.unref?.();
    }

    /**
     * Routes one ComfyUI JSON event to its job.
     * @param {ComfyClient} client Client it came from
     * @param {{type: string, data: any}} message Event
     */
    function handleEvent(client, message) {
        const { type, data } = message;
        if (type === 'status') {
            scheduleQueueRefresh(client);
            return;
        }
        const promptId = data?.prompt_id ?? ((type === 'progress' || type === 'executing') ? client.currentPromptId : null);
        if (!promptId) return;
        const job = byPrompt.get(promptId);
        if (!job) {
            const orphan = orphans.get(promptId) ?? { at: now(), events: [] };
            if (orphan.events.length < ORPHAN_MAX_EVENTS) orphan.events.push(message);
            orphans.set(promptId, orphan);
            return;
        }
        if (isTerminal(job) || job.client !== client) return;
        switch (type) {
            case 'execution_start':
            case 'execution_cached':
                markRunning(job);
                break;
            case 'executing':
                if (data.node === null || data.node === undefined) {
                    finalize(job);
                } else {
                    markRunning(job);
                    setProgress(job, { value: 0, max: 1, node: String(data.node) });
                }
                break;
            case 'progress':
                markRunning(job);
                setProgress(job, {
                    value: Number(data.value) || 0,
                    max: Number(data.max) || 0,
                    node: data.node === null || data.node === undefined ? null : String(data.node),
                });
                break;
            case 'executed':
                if (data.node !== null && data.node !== undefined && data.output && typeof data.output === 'object') {
                    job.outputs[String(data.node)] = data.output;
                }
                break;
            case 'execution_success':
                finalize(job);
                break;
            case 'execution_error':
                fail(job, describeExecutionError(data));
                break;
            case 'execution_interrupted':
                complete(job, JOB_EVENTS.CANCELLED, {});
                break;
            default:
                // progress_state, feature_flags, custom-node chatter: not ours to relay.
                break;
        }
    }

    /**
     * Relays a preview frame, at most one per `previewIntervalMs` per job; a frame inside the
     * window waits for its end (the newest one wins), so the last latent still shows.
     * @param {ComfyClient} client Client it came from
     * @param {{mime: string, image: Buffer, metadata: any}} frame Parsed frame
     */
    function handlePreview(client, frame) {
        const promptId = frame.metadata?.prompt_id ?? client.currentPromptId;
        const job = promptId ? byPrompt.get(promptId) : null;
        if (!job || isTerminal(job) || job.client !== client) return;
        const send = (/** @type {any} */ f) => {
            job.lastPreviewAt = now();
            job.pendingPreview = null;
            emit(job, JOB_EVENTS.PREVIEW, { jpegBase64: f.image.toString('base64'), mime: f.mime });
        };
        const since = now() - job.lastPreviewAt;
        if (since >= previewIntervalMs) {
            send(frame);
            return;
        }
        job.pendingPreview = frame;
        if (!job.previewTimer) {
            job.previewTimer = setTimeout(() => {
                job.previewTimer = null;
                if (job.pendingPreview && !isTerminal(job)) send(job.pendingPreview);
            }, previewIntervalMs - since);
            job.previewTimer.unref?.();
        }
    }

    /** @param {ComfyClient} client Client */
    function attach(client) {
        if (attached.has(client)) return;
        attached.add(client);
        client.on('event', message => handleEvent(client, message));
        client.on('preview', frame => handlePreview(client, frame));
        const active = () => [...jobs.values()].filter(job => job.client === client && job.promptId && !isTerminal(job));
        // Socket gone: poll history at the fast rate. Socket back: catch up on what was missed.
        client.on('close', () => active().forEach(job => schedulePoll(job, historyPollMs)));
        client.on('open', () => active().forEach(job => schedulePoll(job, 0)));
    }

    /**
     * @param {Job} job Job
     * @param {string} promptId Prompt id
     */
    function register(job, promptId) {
        job.promptId = promptId;
        byPrompt.set(promptId, job);
        const orphan = orphans.get(promptId);
        if (orphan) {
            orphans.delete(promptId);
            for (const message of orphan.events) handleEvent(job.client, message);
        }
    }

    /**
     * Takes a cancelled job's prompt off the lane: delete it while pending, interrupt it while
     * running (targeted by prompt id).
     * @param {Job} job Job
     */
    async function abortOnLane(job) {
        if (!job.promptId) return;
        try {
            let queue = await job.client.queue();
            if (locate(queue, job.promptId) === 'pending') {
                await job.client.deleteQueued([job.promptId]);
                queue = await job.client.queue();
            }
            if (locate(queue, job.promptId) === 'running' || job.client.currentPromptId === job.promptId) {
                await job.client.interrupt(job.promptId);
            }
        } catch (error) {
            logger.warn?.(`[Pictures] could not cancel ${job.promptId} on ${job.server}: ${error instanceof Error ? error.message : error}`);
        }
    }

    /** @param {Job} job Job */
    async function submit(job) {
        const { client } = job;
        try {
            await client.waitOpen(openTimeoutMs);
            if (isTerminal(job)) return;
            if (job.reference) {
                await client.uploadImage(job.reference.bytes, job.reference.name, { subfolder: job.reference.subfolder, mime: job.reference.mime });
                job.reference = null; // the bytes are on the lane now; the mirror keeps no copy
            }
            if (isTerminal(job)) return;
            const promptId = randomUUID();
            register(job, promptId);
            const reply = await client.queuePrompt(job.graph, promptId);
            if (reply?.prompt_id && reply.prompt_id !== promptId) {
                // A build that mints its own ids.
                byPrompt.delete(promptId);
                register(job, String(reply.prompt_id));
            }
            if (isTerminal(job)) {
                if (job.state === JOB_STATES.CANCELLED) await abortOnLane(job);
                return;
            }
            if (job.state === JOB_STATES.SUBMITTING) job.state = JOB_STATES.QUEUED;
            await refreshQueue(client);
            // Every job opens with `queued` unless ComfyUI already reported progress: position 0
            // when the prompt is already the running one, null when the queue was unreadable.
            if (!isTerminal(job) && !job.last.queued && !job.last.progress) {
                emit(job, JOB_EVENTS.QUEUED, { position: job.state === JOB_STATES.RUNNING ? 0 : null });
            }
            schedulePoll(job);
        } catch (error) {
            fail(job, error);
        }
    }

    /** Drops finished jobs past their time, and stale orphan buffers. */
    function prune() {
        const t = now();
        for (const [id, job] of jobs) {
            if (isTerminal(job) && job.endedAt !== null && t - job.endedAt > ttlMs) {
                jobs.delete(id);
                if (job.promptId && byPrompt.get(job.promptId) === job) byPrompt.delete(job.promptId);
            }
        }
        for (const [promptId, orphan] of orphans) {
            if (t - orphan.at > ORPHAN_TTL_MS) orphans.delete(promptId);
        }
    }

    /**
     * @param {Job} job Job
     * @returns {object} What `GET /jobs` shows
     */
    const publicView = job => ({
        id: job.id,
        state: job.state,
        purpose: job.purpose,
        character: job.character,
        startedAt: job.startedAt,
        progress: job.progress,
        recipe: job.recipe,
        seed: job.seed,
        lane: job.lane,
    });

    return {
        /**
         * Starts a job. Submission runs in the background; its failure arrives as `error`.
         * @param {object} params Inputs
         * @param {ComfyClient} params.client Lane client
         * @param {object} params.graph Filled graph
         * @param {string} params.graphSha Its sha256
         * @param {number} params.seed Seed
         * @param {string} params.recipe Recipe id
         * @param {string} params.purpose Purpose
         * @param {string} params.character Character (folder under user/images)
         * @param {string} params.userImages `user/images` of the requesting user
         * @param {string} [params.owner] Handle of the requesting user
         * @param {string[]} [params.outputsOrder] The recipe's output node ids, first in the result
         * @param {Job['reference']} [params.reference] Reference image to upload first
         * @returns {Job} The job
         */
        /**
         * Starts a key-lane job (OpenAI, Gemini): one provider call with no queue and no steps.
         * It opens with `queued {position: 0}`, then `progress {value: 0, max: 0}` once the call is
         * out (a step count of 0 = "drawing, no count"), then `done` like a ComfyUI job, with
         * `model` in place of `recipe` and `seed: null` (these lanes take no seed).
         * @param {object} params Inputs
         * @param {string} params.lane `openai` | `gemini`
         * @param {string} params.model Provider model id
         * @param {string} params.requestSha sha256 of the provider request (reference bytes as their hash)
         * @param {(signal: AbortSignal) => Promise<{bytes: Buffer, ext: string}[]>} params.run The provider call
         * @param {string} params.purpose Purpose
         * @param {string} params.character Character (folder under user/images)
         * @param {string} params.userImages `user/images` of the requesting user
         * @param {string} [params.owner] Handle of the requesting user
         * @returns {Job} The job
         */
        start({ lane, model, requestSha, run, purpose, character, userImages, owner = '' }) {
            prune();
            const controller = new AbortController();
            /** @type {Job} */
            const job = /** @type {any} */ ({
                id: randomUUID(),
                owner,
                lane,
                promptId: null,
                server: lane,
                client: null,
                state: JOB_STATES.SUBMITTING,
                purpose,
                character,
                recipe: model,
                model,
                seed: null,
                graphSha: requestSha,
                graph: {},
                startedAt: now(),
                endedAt: null,
                progress: null,
                lastPreviewAt: 0,
                pendingPreview: null,
                previewTimer: null,
                pollTimer: null,
                listeners: new Set(),
                last: { queued: null, progress: null, terminal: null },
                outputs: {},
                outputsOrder: [],
                userImages,
                reference: null,
                finalizing: false,
                released: true, // no socket to hold
                unreachableSince: null,
                lostChecks: 0,
                controller,
            });
            jobs.set(job.id, job);
            emit(job, JOB_EVENTS.QUEUED, { position: 0 });
            (async () => {
                try {
                    job.state = JOB_STATES.RUNNING;
                    setProgress(job, { value: 0, max: 0, node: null });
                    const pictures = await run(controller.signal);
                    if (isTerminal(job)) return;
                    if (!pictures.length) {
                        fail(job, 'The provider answered without a picture');
                        return;
                    }
                    job.state = JOB_STATES.SAVING;
                    const date = new Date(now());
                    const images = [];
                    for (const [index, picture] of pictures.entries()) {
                        const saved = await saveImage({ userImages, character, seed: lane, bytes: picture.bytes, ext: picture.ext, date, index });
                        let width = null;
                        let height = null;
                        try {
                            ({ width, height } = imageSize(picture.bytes));
                        } catch {
                            // unknown format: the client can measure it
                        }
                        images.push({ url: saved.url, width, height });
                    }
                    complete(job, JOB_EVENTS.DONE, { images, seed: null, graphSha: requestSha, lane, model });
                } catch (error) {
                    if (controller.signal.aborted) complete(job, JOB_EVENTS.CANCELLED, {});
                    else fail(job, error);
                }
            })();
            return job;
        },

        create({ client, graph, graphSha, seed, recipe, purpose, character, userImages, owner = '', outputsOrder = [], reference = null }) {
            prune();
            /** @type {Job} */
            const job = {
                id: randomUUID(),
                owner,
                lane: 'comfy',
                promptId: null,
                server: client.base,
                client,
                state: JOB_STATES.SUBMITTING,
                purpose,
                character,
                recipe,
                seed,
                graphSha,
                graph,
                startedAt: now(),
                endedAt: null,
                progress: null,
                lastPreviewAt: 0,
                pendingPreview: null,
                previewTimer: null,
                pollTimer: null,
                listeners: new Set(),
                last: { queued: null, progress: null, terminal: null },
                outputs: {},
                outputsOrder,
                userImages,
                reference,
                finalizing: false,
                released: false,
                unreachableSince: null,
                lostChecks: 0,
            };
            jobs.set(job.id, job);
            attach(client);
            client.retain();
            submit(job);
            return job;
        },

        /**
         * @param {string} id Job id
         * @returns {Job|undefined} The job
         */
        get(id) {
            prune();
            return jobs.get(id);
        },

        /**
         * @param {string} [owner] Only this user's jobs (omit for all)
         * @returns {object[]} Jobs in the mirror, newest first
         */
        list(owner) {
            prune();
            return [...jobs.values()]
                .filter(job => owner === undefined || job.owner === owner)
                .sort((a, b) => b.startedAt - a.startedAt)
                .map(publicView);
        },

        /**
         * Cancels a job: `cancelled` now, then the prompt leaves the lane.
         * @param {string} id Job id
         * @returns {boolean} False when there is no such job
         */
        cancel(id) {
            const job = jobs.get(id);
            if (!job) return false;
            if (isTerminal(job)) return true;
            complete(job, JOB_EVENTS.CANCELLED, {});
            if (job.controller) job.controller.abort();
            else abortOnLane(job);
            return true;
        },

        /**
         * Feeds a job's events to a listener: first the state so far (the terminal event, else
         * the latest `progress`, else the latest `queued`), then live events.
         * @param {string} id Job id
         * @param {JobListener} listener Listener
         * @returns {(() => void)|null} Unsubscribe; null when there is no such job
         */
        subscribe(id, listener) {
            const job = jobs.get(id);
            if (!job) return null;
            if (job.last.terminal) {
                listener(job.last.terminal.event, job.last.terminal.data);
                return () => {};
            }
            if (job.last.progress) listener(JOB_EVENTS.PROGRESS, job.last.progress);
            else if (job.last.queued) listener(JOB_EVENTS.QUEUED, job.last.queued);
            job.listeners.add(listener);
            return () => job.listeners.delete(listener);
        },

        /** Stops every timer and lets go of every socket (tests, shutdown). */
        shutdown() {
            for (const job of jobs.values()) {
                if (job.previewTimer) clearTimeout(job.previewTimer);
                if (job.pollTimer) clearTimeout(job.pollTimer);
                job.previewTimer = null;
                job.pollTimer = null;
                job.state = isTerminal(job) ? job.state : JOB_STATES.CANCELLED;
                job.controller?.abort();
                if (!job.released) {
                    job.released = true;
                    job.client.release();
                }
            }
            for (const timer of queueTimers.values()) clearTimeout(timer);
            queueTimers.clear();
        },
    };
}
