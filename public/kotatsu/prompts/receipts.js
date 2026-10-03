/**
 * Prompt receipts — slice D of the prompt-manager rework (`docs/prompt-manager-v0.md`,
 * decision 9). **Data layer only.** The live origin-labeled compiled-prompt view is v0.5;
 * this module makes sure v0.5 has every byte it needs and never has to lie.
 *
 * ## What a receipt is
 *
 * Client-side assembly already computes exactly the provenance the community asks for
 * (survey #1 preset gripe: "hard to know which prompt component caused a result").
 * `populateChatCompletion` builds one `MessageCollection` per contributing prompt with the
 * prompt identifier intact (`openai.js:1198-1202`), and `openai.js:1601` hands that intact
 * tree to `promptManager.setChatCompletion()`. Then it is thrown away: `getChat()`
 * (`openai.js:4016`) drops the identifiers on the way to the wire, and itemization coarsens
 * the per-identifier token counts into 11 buckets (`script.js:5965-5987`).
 *
 * A receipt is a synchronous projection of that tree, per generation, persisted per landed
 * message. No content bodies: identifiers, positions, roles, token sums, message counts,
 * and an honest list of what the record cannot attribute.
 *
 * ## Why capture is synchronous and eager, never lazy
 *
 * `ChatCompletion.squashSystemMessages()` does `this.messages.collection =
 * this.messages.flatten()` (`openai.js:3820`) on **the very object** `setChatCompletion`
 * was handed, and `prepareOpenAIMessages` calls it thirteen lines later
 * (`openai.js:1603`) on every non-dry generation. A receipt read lazily — at
 * `CHAT_COMPLETION_PROMPT_READY`, at `MESSAGE_RECEIVED`, from `promptManager.messages` at
 * render time — reads a flattened array with every identifier grouping already destroyed.
 * So the projection happens inside the `setChatCompletion` wrapper, before it returns.
 *
 * ## The seam
 *
 * `promptManager.setChatCompletion` is wrapped on the **instance**, not patched in core:
 * `openai.js`, `script.js` and `PromptManager.js` are untouched by this slice. The wrapper
 * calls the original first (so a fault here can never break assembly), then projects.
 *
 * `promptManager` is `null` when `firstLoadInit()` runs — the instance is built later, by
 * `setupChatCompletionPromptManager()` (`script.js:7845` → `openai.js:670`), and that
 * function early-returns forever after, so the instance is stable once it exists. Arming is
 * therefore retried on `SETTINGS_LOADED` / `SETTINGS_UPDATED` / `GENERATION_STARTED` until
 * it takes; {@link PromptReceiptStore.attachTo} is idempotent and cheap.
 *
 * ## The state machine (and the ordering trap in it)
 *
 * ```
 *   GENERATION_STARTED(type, opts, dryRun)  → remember type + provisional dryRun
 *   setChatCompletion(chatCompletion)       → PROJECT. record becomes `pending` and `latest`
 *   CHAT_COMPLETION_PROMPT_READY({dryRun})  → authoritative dryRun; dry runs stop here
 *   MESSAGE_RECEIVED(mesId, type)           → bind mesId, persist, clear `pending`
 * ```
 *
 * **`GENERATION_ENDED` is deliberately not the committer.** It is emitted from
 * `hideStopButton()` (`script.js:3512`), which on the streaming path runs from
 * `markUIGenStopped()` at `script.js:3771` — four lines *before* the `MESSAGE_RECEIVED`
 * emit at `script.js:3775`. Treating it as "the generation landed" would drop the receipt
 * of every streamed reply. It only clears the remembered generation type here.
 *
 * Dry runs (`promptManager.render()` → `tryGenerate()` → `Generate('normal', {}, true)`)
 * call `setChatCompletion` too and produce no message. They are kept in memory as
 * {@link PromptReceiptStore.latest} — that is what feeds per-row token badges after an
 * explicit recount (doc decision 2) — and are **never persisted**: there is no honest key
 * to file them under.
 *
 * ## What this record honestly cannot say
 *
 * Two whole classes of contribution are unattributable by construction, and the receipt
 * says so in `caveats` rather than inventing attribution:
 *
 * - **In-chat injections.** Every prompt with `injection_position === ABSOLUTE` is skipped
 *   by `addToChatCompletion` (`openai.js:1193-1196`) and merged into the chat pool, where
 *   the loop renames *every* entry `chatHistory-<n>` (`openai.js:948-949`) through a
 *   `Prompt` constructor that does not carry `injected` forward. Their tokens land under
 *   `chatHistory` and nothing downstream can separate them again. Sparkle Sauce ships 20 of
 *   these, Marinara 12.
 * - **Extension prompts into `main`.** `injectToMain` (`openai.js:1260-1302`) inserts
 *   summarize / author's note / vectors / smart-context messages *into the `main`
 *   collection*, so they are attributed to `main` by construction. This one leaves evidence:
 *   `main` holding more than one message means extra messages were injected into it, which
 *   is why the caveat is emitted on evidence rather than on suspicion.
 *
 * One more honesty flag is per entry: a **disabled `main` still emits a collection**.
 * `getPromptCollection` substitutes a content-free clone (`PromptManager.js:1531-1537`) and
 * `addToChatCompletion` exempts `'main'` from the disabled check (`openai.js:1186`), so the
 * tree carries a `main` collection with an empty, 0-token message. It is recorded, flagged
 * `emptyAnchor: true`, and a UI can say "contributed nothing" instead of "420 tokens".
 *
 * ## Contracts this module honours
 *
 * - **One-way imports.** kotatsu → core only. Registration rides the single sanctioned
 *   seam: `firstLoadInit()` → `initKotatsuShell()` → {@link initPromptReceipts}. Nothing in
 *   core imports this file.
 * - **Frozen events are read, never re-emitted or reordered.** `GENERATION_STARTED`,
 *   `CHAT_COMPLETION_PROMPT_READY`, `MESSAGE_RECEIVED`, `GENERATION_ENDED`, `CHAT_CHANGED`,
 *   `CHAT_DELETED`, `GROUP_CHAT_DELETED` are subscribed to. This module emits nothing on
 *   `eventSource`; consumers use {@link PromptReceiptStore.subscribe}.
 * - **Separate storage.** Its own localforage instance (`Kotatsu_PromptReceipts`), keyed by
 *   chat id like itemization's (`itemized-prompts.js:15`). Itemization's `SillyTavern_Prompts`
 *   rows and the 28-field `additionalPromptStuff` record (`script.js:5316-5348`) are not
 *   touched, so nothing in the stock inspector can be broken by this slice.
 * - **Quiet degradation.** Every storage failure is one `console.error` and a fall back to
 *   memory-only operation; capture keeps working. Nothing here ever throws into assembly.
 * - **Bounded growth.** {@link MAX_RECEIPTS_PER_CHAT} per chat with eviction, chats forgotten
 *   on `CHAT_DELETED` / `GROUP_CHAT_DELETED`. An 800-file character forest must not become
 *   an 800-row IndexedDB forest that nothing ever prunes.
 * - **No content, ever.** Bodies are never stored. The opt-in `digest` debug option records
 *   hashes only, and a returned value that is not hex, or that equals its input, is dropped
 *   rather than written.
 *
 * ## v2 — name snapshots and reindexing (`docs/receipt-tracker-v0.md`)
 *
 * `RECEIPT_VERSION` 2 adds two things a v1 record could not do, without touching how a v1
 * record already on disk is read (`normalizeStoredFile` and {@link isStoredReceipt} are
 * untouched — a v1 file loads exactly as it always has).
 *
 * - **Per-entry name snapshots.** `entry.name` is read from the live `promptManager`'s
 *   `serviceSettings.prompts` at the exact moment a tree is captured — one `Map(identifier →
 *   name)`, built synchronously inside {@link PromptReceiptStore#captureFrom}'s existing
 *   try/catch, so a preset rename can never rewrite what an old receipt says. Engine-only
 *   slots (`chatHistory`, `controlPrompts`, `continueNudge`, …) are never in `prompts[]` and
 *   get no snapshot on purpose — the v0.5 view labels those itself.
 * - **Reindexing.** `MESSAGE_DELETED` cannot carry a fix (see
 *   `public/scripts/message-index-hooks.js`'s header for the receipts) — every emit site
 *   hands back post-op `chat.length`, and a mid-chat `deleteMessage` makes the deleted index
 *   unrecoverable from the event alone. This store instead subscribes to
 *   {@link subscribeMessageIndexHooks}, which core calls with the real values at the same
 *   sites that already maintain itemization. {@link reindexForDelete},
 *   {@link reindexForTruncate}, and {@link reindexForSwap} are the three PURE transforms
 *   (design doc decision 2); {@link PromptReceiptStore#reindex} is the instance method that
 *   applies one of them to the active chat's warm file, its persisted copy, and the `#latest`
 *   binding, then fires one `'reindexed'` notification. `#pending` is never touched — it has
 *   no `mesId` yet, so there is nothing on it to reindex.
 */

import { localforage } from '../../lib.js';
import { getCurrentChatId } from '../../script.js';
import { event_types, eventSource } from '../../scripts/events.js';
import { subscribeMessageIndexHooks } from '../../scripts/message-index-hooks.js';
import { oai_settings, promptManager } from '../../scripts/openai.js';

/** @typedef {import('../../scripts/message-index-hooks.js').MessageIndexEvent} MessageIndexEvent */

/** Schema version stamped on every record and on the per-chat file. */
export const RECEIPT_VERSION = 2;

/** localforage instance name. Deliberately not `SillyTavern_Prompts`. */
export const RECEIPT_STORE_NAME = 'Kotatsu_PromptReceipts';

/**
 * How many landed-message receipts survive per chat. Eviction drops the LOWEST `mesId`s:
 * the newest turns are the ones anyone opens a receipt for, and the oldest are the ones a
 * long roleplay accumulates thousands of.
 */
export const MAX_RECEIPTS_PER_CHAT = 200;

/**
 * Above this message count an entry stores role/token *summary* only, not the per-message
 * breakdown. Only `chatHistory` and `dialogueExamples` ever cross it, and their per-message
 * detail is the least informative in the record (it is the chat, which the reader already
 * has) while being the entire size tail — a 200-turn chat would otherwise write a 200-element
 * array into every one of 200 receipts.
 */
export const MESSAGE_DETAIL_LIMIT = 16;

/** Warm per-chat files kept in memory; insertion-ordered eviction. */
const WARM_CHAT_FILES = 4;

/** Warm in-memory `latest` captures kept across chat switches. */
const WARM_LATEST_CHATS = 8;

/**
 * How long an uncommitted capture may wait for its `MESSAGE_RECEIVED`. A slow model on a
 * huge context is the upper bound; anything past this is an abandoned generation whose
 * receipt must not be able to attach itself to an unrelated later message.
 */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Marker put on the wrapper function so a second load of this module (or a second store)
 * can never double-wrap the same method. Registry symbol on purpose: it survives module
 * duplication, which a plain `Symbol()` would not.
 */
const WRAPPED = Symbol.for('kotatsu.promptReceipts.wrapped');

/** Only hex of a plausible digest length is accepted as a content hash. */
const DIGEST_PATTERN = /^[0-9a-f]{8,128}$/i;

/**
 * `MESSAGE_RECEIVED` generation types that are replays, not generations. Core emits the
 * event for greetings too (`script.js:7681`, `script.js:9891`); those messages were never
 * assembled from a prompt tree and must not adopt a pending receipt.
 */
const NON_GENERATION_TYPES = new Set(['first_message']);

/**
 * The provenance a receipt cannot supply, named. A v0.5 view renders these verbatim — they
 * are the difference between an inspector that is trusted and one that quietly lies.
 */
export const RECEIPT_CAVEATS = Object.freeze({
    /**
     * `main` carries messages that `injectToMain` (`openai.js:1260-1302`) put there —
     * summarize, author's note, vectors, smart context. Their tokens are counted under
     * `main` and cannot be separated out.
     */
    EXTENSION_INJECTION_INTO_MAIN: 'extension-injection-into-main',
    /**
     * `chatHistory` may contain in-chat injections (`injection_position === ABSOLUTE`).
     * The chat-pool loop renamed every member `chatHistory-<n>` (`openai.js:948-949`), so
     * which members were injected — and by which prompt — is not recoverable.
     */
    IN_CHAT_INJECTIONS_UNDER_CHATHISTORY: 'in-chat-injections-under-chathistory',
    /**
     * `squash_system_messages` was on for a real generation, so `squashSystemMessages()`
     * merged adjacent system messages and **re-tokenized** the merged content
     * (`openai.js:3838-3839`) after this snapshot was taken. These token numbers are what
     * the assembler budgeted, not necessarily what the tokenizer finally saw.
     */
    TOKENS_ARE_PRE_SQUASH: 'tokens-are-pre-squash',
});

/**
 * @typedef {object} ReceiptMessageDetail
 * @property {string} role Message role, `'null'` when the message carried none.
 * @property {number} tokens Token count the assembler recorded for this message.
 */

/**
 * One top-level `MessageCollection` of the assembly tree.
 * @typedef {object} ReceiptEntry
 * @property {number} index Position in the root collection. The root is SPARSE — skipped
 *   prompts leave real holes (`openai.js:3899`) — so this is the prompt's own order index,
 *   not a running counter.
 * @property {string} identifier Collection identifier: a prompt identifier, or an engine
 *   slot (`chatHistory`, `dialogueExamples`, `controlPrompts`, `continueNudge`, …).
 * @property {string} [name] Display name snapshotted from `serviceSettings.prompts` at
 *   capture time (`RECEIPT_VERSION` 2). Absent on v1 records and on engine-only identifiers
 *   that were never in `prompts[]` — the view falls back to resolving those itself.
 * @property {string[]} roles Distinct roles present, in first-appearance order.
 * @property {number} tokens Sum of the member messages' token counts.
 * @property {number} messageCount How many messages the collection held.
 * @property {ReceiptMessageDetail[]} [messages] Per-message role/token breakdown. Present
 *   only when `messageCount` is within {@link MESSAGE_DETAIL_LIMIT}.
 * @property {true} [truncatedDetail] Set instead of `messages` when the collection is too
 *   large to record per message.
 * @property {true} [emptyAnchor] The collection held messages but contributed nothing —
 *   the disabled-`main` case (`PromptManager.js:1531-1537`, `openai.js:1186`). A UI must
 *   say "contributed nothing" here, not "absent".
 * @property {Array<string|null>} [contentHashes] Opt-in debug digests, one per message,
 *   `null` where the digest was refused. Never content.
 */

/**
 * @typedef {object} ReceiptTotals
 * @property {number} tokens Sum over every entry.
 * @property {number} messages Sum over every entry.
 * @property {number} collections How many entries the tree produced.
 * @property {number} slots Length of the sparse root collection.
 * @property {number} holes How many of those slots are empty.
 */

/**
 * The pure projection of one assembly tree.
 * @typedef {object} ReceiptProjection
 * @property {ReceiptEntry[]} entries Entries in tree order.
 * @property {number[]} holes Indices of the empty slots, ascending.
 * @property {number} slots Length of the sparse root collection.
 * @property {ReceiptTotals} totals Rolled-up counts.
 * @property {string[]} caveats Structural caveats — see {@link RECEIPT_CAVEATS}.
 */

/**
 * One generation's provenance record.
 * @typedef {object} PromptReceipt
 * @property {number} version {@link RECEIPT_VERSION}.
 * @property {string} chatId Chat this was assembled in; `''` when there was no chat.
 * @property {number|null} mesId Message it produced; null until the generation lands, and
 *   permanently null for a dry run.
 * @property {number} capturedAt `Date.now()` at projection time.
 * @property {string|null} generationType `GENERATION_STARTED`'s type, or null if unseen.
 * @property {boolean|null} dryRun Null until `CHAT_COMPLETION_PROMPT_READY` resolves it (or
 *   `GENERATION_STARTED` provisionally set it). Only `false` is ever persisted.
 * @property {string|null} presetName `oai_settings.preset_settings_openai` at capture.
 * @property {ReceiptEntry[]} entries Per-prompt provenance.
 * @property {number[]} holes Empty root slots.
 * @property {number} slots Root collection length.
 * @property {ReceiptTotals} totals Rolled-up counts.
 * @property {string[]} caveats What this record cannot attribute.
 */

/**
 * @typedef {object} ReceiptChange
 * @property {'captured'|'resolved'|'dry-run'|'landed'|'saved'|'forgotten'|'reindexed'} reason
 *   What moved. `'reindexed'` covers a delete, truncate, or swap that may have touched more
 *   than one stored record at once, so unlike every other reason it carries no single
 *   `receipt` — {@link PromptReceiptStore#all} or {@link PromptReceiptStore#forMessage} is
 *   how a listener reads the result.
 * @property {string} chatId Chat in play.
 * @property {number|null} mesId Bound message, when there is one.
 * @property {PromptReceipt|null} receipt The record, when there is one.
 */

/**
 * @callback ReceiptListener
 * @param {ReceiptChange} change What moved.
 * @returns {void}
 */

/**
 * @callback ReceiptDigest
 * @param {string} content Message content.
 * @returns {string} A hex digest.
 */

/**
 * Token count of one message, tolerating both the real `Message` (a `tokens` field with a
 * `getTokens()` accessor) and the plain objects tests and future callers hand in.
 * @param {any} message Message-shaped object.
 * @returns {number} Non-negative token count; 0 when there is nothing honest to read.
 */
function readTokens(message) {
    const direct = Number(message?.tokens);
    if (Number.isFinite(direct)) {
        return direct;
    }
    if (typeof message?.getTokens === 'function') {
        const called = Number(message.getTokens());
        if (Number.isFinite(called)) {
            return called;
        }
    }
    return 0;
}

/**
 * Whether a message would survive to the wire. Mirrors the test `getChat()` applies
 * (`openai.js:4021`): content or tool calls, nothing else counts.
 * @param {any} message Message-shaped object.
 * @returns {boolean} True when the message carries something.
 */
function hasPayload(message) {
    if (message?.tool_calls) {
        return true;
    }
    const content = message?.content;
    if (typeof content === 'string') {
        return content.length > 0;
    }
    return content !== null && content !== undefined && content !== false;
}

/**
 * Runs a caller-supplied digest over one message's content and refuses anything that could
 * be the content itself.
 *
 * The option exists because "did this prompt's text change between these two generations?"
 * is a real debugging question. It takes a **synchronous** digest by design: browsers only
 * offer sha256 through the async `crypto.subtle`, and this projection cannot yield — the
 * tree is destroyed by `squashSystemMessages()` on the next line. Callers who want sha256
 * supply a synchronous implementation; the guards below are what keep a lazy or hostile
 * "digest" from turning this store into a transcript.
 * @param {any} message Message-shaped object.
 * @param {ReceiptDigest} digest Caller-supplied synchronous digest.
 * @returns {string|null} A hex digest, or null when the value was refused.
 */
function hashContent(message, digest) {
    const content = message?.content;
    const raw = typeof content === 'string' ? content : JSON.stringify(content ?? null);
    let hash;
    try {
        hash = digest(raw);
    } catch {
        return null;
    }
    if (typeof hash !== 'string' || hash === raw || !DIGEST_PATTERN.test(hash)) {
        return null;
    }
    return hash;
}

/**
 * Projects one top-level item of the root collection.
 * @param {any} item A `MessageCollection`, or a bare `Message` (the root tolerates both —
 *   `openai.js:4019-4022`).
 * @param {number} index Its position in the sparse root collection.
 * @param {ReceiptDigest|null} digest Opt-in content digest.
 * @param {Map<string, string>|null} names Opt-in identifier→name snapshot (`RECEIPT_VERSION`
 *   2). Looked up by the entry's own resolved identifier, never by anything read off core.
 * @returns {ReceiptEntry} The projected entry.
 */
function projectItem(item, index, digest, names) {
    const raw = typeof item.getCollection === 'function' ? item.getCollection() : [item];
    const messages = Array.isArray(raw) ? raw.filter(message => message && typeof message === 'object') : [];

    /** @type {string[]} */
    const roles = [];
    /** @type {ReceiptMessageDetail[]} */
    const detail = [];
    /** @type {Array<string|null>} */
    const hashes = [];
    let tokens = 0;
    let contentful = 0;

    for (const message of messages) {
        const role = typeof message.role === 'string' && message.role ? message.role : 'null';
        if (!roles.includes(role)) {
            roles.push(role);
        }
        const messageTokens = readTokens(message);
        tokens += messageTokens;
        detail.push({ role, tokens: messageTokens });
        if (hasPayload(message)) {
            contentful += 1;
        }
        if (digest) {
            hashes.push(hashContent(message, digest));
        }
    }

    const identifier = typeof item.identifier === 'string' && item.identifier ? item.identifier : '(unknown)';

    /** @type {ReceiptEntry} */
    const entry = { index, identifier, roles, tokens, messageCount: messages.length };
    const name = names ? names.get(identifier) : undefined;
    if (typeof name === 'string' && name) {
        entry.name = name;
    }
    if (messages.length > MESSAGE_DETAIL_LIMIT) {
        entry.truncatedDetail = true;
    } else if (messages.length > 0) {
        entry.messages = detail;
    }
    if (messages.length > 0 && tokens === 0 && contentful === 0) {
        entry.emptyAnchor = true;
    }
    if (digest && hashes.length > 0) {
        entry.contentHashes = hashes;
    }
    return entry;
}

/**
 * Projects an assembly tree into the receipt shape. **Pure and synchronous** — no core
 * imports are read, no clock, no storage — so it is safe to call from inside the
 * `setChatCompletion` wrapper and trivial to test against synthetic trees.
 *
 * Positions are preserved rather than compacted: the root collection is a sparse array
 * (`this.messages.collection[position] = collection`, `openai.js:3899`) whose holes ARE the
 * prompts that did not contribute, and `forEach` skips them — which is also how
 * `populateTokenCounts` ends up with counts only for contributors
 * (`PromptManager.js:1583`). Each entry keeps its `index`, and the holes are listed
 * explicitly so a view can render the gaps instead of pretending the list was dense.
 * Reads no core state itself — `names` arrives as a plain argument, built by the caller — so
 * this stays pure and testable against synthetic trees exactly as it was before v2.
 * @param {any} root The root `MessageCollection` (`chatCompletion.getMessages()`).
 * @param {{digest?: ReceiptDigest|null, names?: Map<string, string>|null}} [options]
 *   Projection options.
 * @returns {ReceiptProjection} The projection; empty and honest for a malformed tree.
 */
export function projectPromptTree(root, options = {}) {
    const digest = typeof options.digest === 'function' ? options.digest : null;
    const names = options.names instanceof Map ? options.names : null;
    /** @type {ReceiptEntry[]} */
    const entries = [];
    /** @type {number[]} */
    const holes = [];
    /** @type {Set<number>} */
    const filled = new Set();

    const collection = Array.isArray(root?.collection) ? root.collection : [];
    const slots = collection.length;

    collection.forEach((item, index) => {
        // `forEach` never visits a hole, so anything reaching here occupies a slot. An
        // explicitly-stored nullish value still counts as empty, and is reported as a hole
        // rather than projected into a fictional entry.
        if (!item || typeof item !== 'object') {
            return;
        }
        filled.add(index);
        entries.push(projectItem(item, index, digest, names));
    });

    for (let index = 0; index < slots; index++) {
        if (!filled.has(index)) {
            holes.push(index);
        }
    }

    let tokens = 0;
    let messages = 0;
    for (const entry of entries) {
        tokens += entry.tokens;
        messages += entry.messageCount;
    }

    /** @type {string[]} */
    const caveats = [];
    const main = entries.find(entry => entry.identifier === 'main');
    if (main && main.messageCount > 1) {
        // More than one message under `main` is direct evidence of `injectToMain`: the
        // prompt itself is added as a single message (`openai.js:1199-1202`) and every
        // extra one was inserted by an extension (`openai.js:1262`).
        caveats.push(RECEIPT_CAVEATS.EXTENSION_INJECTION_INTO_MAIN);
    }
    const chatHistory = entries.find(entry => entry.identifier === 'chatHistory');
    if (chatHistory && chatHistory.messageCount > 0) {
        caveats.push(RECEIPT_CAVEATS.IN_CHAT_INJECTIONS_UNDER_CHATHISTORY);
    }

    return {
        entries,
        holes,
        slots,
        totals: { tokens, messages, collections: entries.length, slots, holes: holes.length },
        caveats,
    };
}

/**
 * @param {any} value Candidate.
 * @returns {boolean} True when it is shaped like a stored receipt.
 */
function isStoredReceipt(value) {
    return !!value && typeof value === 'object' && Number.isInteger(value.mesId);
}

/**
 * Upserts a receipt into a chat's list and applies retention. **Pure** — returns a new
 * array and never mutates the input.
 *
 * Upsert is by `mesId`, matching itemization's own rule (`script.js:5351-5357`), so a swipe
 * or a regeneration replaces the record for that message instead of stacking a second one.
 * Eviction drops from the FRONT of the `mesId`-sorted list: the oldest turns go first.
 * `mesId` is a chat index, not a clock — deleting a message shifts every later one — so
 * "oldest" here means "earliest in the chat", which is the ordering a reader scrolls away
 * from and the only ordering the stored records can honestly support.
 * @param {PromptReceipt[]|null|undefined} receipts Existing list.
 * @param {PromptReceipt} receipt Record to merge in.
 * @param {number} [limit] Retention cap; defaults to {@link MAX_RECEIPTS_PER_CHAT}.
 * @returns {PromptReceipt[]} The new list, ascending by `mesId`.
 */
export function mergeReceipt(receipts, receipt, limit = MAX_RECEIPTS_PER_CHAT) {
    const existing = Array.isArray(receipts) ? receipts.filter(isStoredReceipt) : [];
    if (!isStoredReceipt(receipt)) {
        return existing.slice().sort((a, b) => Number(a.mesId) - Number(b.mesId));
    }
    const next = existing.filter(item => item.mesId !== receipt.mesId);
    next.push(receipt);
    next.sort((a, b) => Number(a.mesId) - Number(b.mesId));
    const cap = Number.isInteger(limit) && limit > 0 ? limit : MAX_RECEIPTS_PER_CHAT;
    return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Reindexes a receipt list for a mid-chat delete at `index` — the same value
 * `notifyMessageDeleted` was called with (design doc decision 2). **Pure**: returns a new
 * array, never mutates the input, and never touches a record it does not need to.
 *
 * The record bound to the deleted message has no honest index left, so it is dropped rather
 * than pinned to a neighbor; every later record shifts down by one, mirroring the
 * `chat.splice(index, 1)` the array itself just underwent.
 * @param {PromptReceipt[]|null|undefined} receipts Existing list, any order.
 * @param {number} index The deleted message's id.
 * @returns {PromptReceipt[]} The reindexed list, ascending by `mesId`.
 */
export function reindexForDelete(receipts, index) {
    const existing = Array.isArray(receipts) ? receipts.filter(isStoredReceipt) : [];
    /** @type {PromptReceipt[]} */
    const next = [];
    for (const receipt of existing) {
        // `Number(...)`, not a raw read: `isStoredReceipt` already proved `mesId` is an
        // integer at runtime, but its return type is a plain boolean, not a type predicate,
        // so the checker still sees `number|null` here — same idiom `mergeReceipt` already
        // uses for the same reason.
        const mesId = Number(receipt.mesId);
        if (mesId === index) {
            continue;
        }
        next.push(mesId > index ? { ...receipt, mesId: mesId - 1 } : receipt);
    }
    next.sort((a, b) => Number(a.mesId) - Number(b.mesId));
    return next;
}

/**
 * Reindexes a receipt list for a bulk truncation to `newLength` — the same value
 * `notifyMessagesTruncated` was called with. **Pure**, same guarantees as
 * {@link reindexForDelete}.
 *
 * Every record whose `mesId` no longer fits inside the truncated chat is dropped; nothing
 * shifts, because truncation only ever removes a tail. `newLength` 0 drops everything, which
 * is the honest answer for a chat with nothing left in it.
 * @param {PromptReceipt[]|null|undefined} receipts Existing list, any order.
 * @param {number} newLength `chat.length` after the truncation.
 * @returns {PromptReceipt[]} The reindexed list, ascending by `mesId`.
 */
export function reindexForTruncate(receipts, newLength) {
    const existing = Array.isArray(receipts) ? receipts.filter(isStoredReceipt) : [];
    return existing
        .filter(receipt => Number(receipt.mesId) < newLength)
        .sort((a, b) => Number(a.mesId) - Number(b.mesId));
}

/**
 * Reindexes a receipt list for a `messageEditMove` swap of `a` and `b` — the same ids
 * `notifyMessagesSwapped` was called with. **Pure**, same guarantees as
 * {@link reindexForDelete}.
 *
 * Only the two records' `mesId`s exchange; everything else in either record — including its
 * `name` snapshots and its whole assembly tree — is exactly as true after the move as before
 * it, because the CONTENT that was assembled for message `a` is still that content, it just
 * now lives at `b`. Either side may have no record at all (one message swiped, the other
 * never generated), which is tolerated: a record present on only one side simply relocates.
 * @param {PromptReceipt[]|null|undefined} receipts Existing list, any order.
 * @param {number} a One swapped message's id.
 * @param {number} b The other swapped message's id.
 * @returns {PromptReceipt[]} The reindexed list, ascending by `mesId`.
 */
export function reindexForSwap(receipts, a, b) {
    const existing = Array.isArray(receipts) ? receipts.filter(isStoredReceipt) : [];
    const next = existing.map((receipt) => {
        const mesId = Number(receipt.mesId);
        if (mesId === a) {
            return { ...receipt, mesId: b };
        }
        if (mesId === b) {
            return { ...receipt, mesId: a };
        }
        return receipt;
    });
    next.sort((x, y) => Number(x.mesId) - Number(y.mesId));
    return next;
}

/**
 * Reads a stored per-chat payload back into a receipt list, tolerating anything at all in
 * the slot: a foreign value, a half-written object, or the bare array an earlier shape
 * might have used.
 * @param {any} raw Value read from storage.
 * @returns {PromptReceipt[]} Usable receipts, possibly empty.
 */
function normalizeStoredFile(raw) {
    if (Array.isArray(raw)) {
        return raw.filter(isStoredReceipt);
    }
    if (!raw || typeof raw !== 'object') {
        return [];
    }
    const receipts = raw.receipts;
    return Array.isArray(receipts) ? receipts.filter(isStoredReceipt) : [];
}

/** @typedef {{valid: boolean, users: number}} ReceiptLifetime */

/**
 * The per-generation provenance store. One instance per page; see {@link receiptStore}.
 */
export class PromptReceiptStore {
    /** @type {Map<string, PromptReceipt>} Last capture per chat, dry runs included. */
    #latest = new Map();

    /** @type {PromptReceipt|null} Capture awaiting a `mesId`. */
    #pending = null;

    /** @type {Map<string, {version: number, receipts: PromptReceipt[]}>} Warm chat files. */
    #files = new Map();

    /** @type {Map<string, Promise<{version: number, receipts: PromptReceipt[]}>>} */
    #loads = new Map();

    /** @type {Map<string, ReceiptLifetime>} Ownership of warm files and pending work. */
    #lifetimes = new Map();

    /** @type {Map<string, Promise<unknown>>} Per-chat storage writes, including deletions. */
    #writes = new Map();

    /** Disposal invalidates completion events from earlier deletions. */
    #disposalEpoch = 0;

    /** @type {Set<ReceiptListener>} */
    #listeners = new Set();

    /** @type {Array<{type: string, handler: (...args: any[]) => void}>} */
    #subscriptions = [];

    /** @type {{manager: any, original: Function}|null} The wrapped instance, if armed. */
    #wrapped = null;

    /** @type {{type: string, dryRun: boolean}|null} Generation currently assembling. */
    #activeGeneration = null;

    /** @type {any} Lazily created localforage instance; false once known broken. */
    #storage = null;

    /** @type {Set<string>} Failure keys already reported — one error line each. */
    #logged = new Set();

    /** @type {{digest: ReceiptDigest|null}} */
    #options = { digest: null };

    /** @type {(() => void)|null} Unsubscribe from `message-index-hooks`, once armed. */
    #indexUnsubscribe = null;

    /**
     * Subscribes to the core events the state machine runs on, arms the capture seam if
     * `promptManager` already exists, and subscribes to `message-index-hooks` for reindexing
     * (`RECEIPT_VERSION` 2). Idempotent: a second shell load must not stack a second set of
     * handlers, a second wrapper, or a second index subscription.
     * @returns {void}
     */
    init() {
        if (this.#subscriptions.length > 0) {
            return;
        }
        this.#on(event_types.GENERATION_STARTED, (type, generateOptions, dryRun) => {
            this.#activeGeneration = { type: String(type ?? ''), dryRun: dryRun === true };
            // Earliest reliable moment the instance can exist: `Generate()` cannot run
            // before `setupChatCompletionPromptManager()` has.
            this.#tryAttach();
        });
        this.#on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => this.#resolve(data));
        this.#on(event_types.MESSAGE_RECEIVED, (mesId, type) => {
            void this.#commit(mesId, type);
        });
        this.#on(event_types.GENERATION_ENDED, () => {
            // NOT the committer — see the module header. On the streaming path this fires
            // before `MESSAGE_RECEIVED` (script.js:3771 vs :3775).
            this.#activeGeneration = null;
        });
        this.#on(event_types.CHAT_CHANGED, () => {
            this.#pending = null;
        });
        this.#on(event_types.CHAT_DELETED, (chatId) => {
            void this.forget(chatId);
        });
        this.#on(event_types.GROUP_CHAT_DELETED, (chatId) => {
            void this.forget(chatId);
        });
        this.#on(event_types.SETTINGS_LOADED, () => this.#tryAttach());
        this.#on(event_types.SETTINGS_UPDATED, () => this.#tryAttach());
        this.#indexUnsubscribe = subscribeMessageIndexHooks((event) => {
            void this.#reindex(event);
        });
        this.#tryAttach();
    }

    /**
     * Drops every subscription and unwraps the capture seam. Symmetry for {@link init};
     * used by tests and by anything that tears the shell down.
     * @returns {void}
     */
    dispose() {
        this.#disposalEpoch++;
        for (const { type, handler } of this.#subscriptions) {
            eventSource.removeListener(type, handler);
        }
        this.#subscriptions = [];
        if (this.#indexUnsubscribe) {
            this.#indexUnsubscribe();
            this.#indexUnsubscribe = null;
        }
        if (this.#wrapped) {
            const { manager, original } = this.#wrapped;
            if (manager.setChatCompletion?.[WRAPPED] === true) {
                manager.setChatCompletion = original;
            }
            this.#wrapped = null;
        }
        this.#pending = null;
        this.#activeGeneration = null;
        this.#latest.clear();
        for (const lifetime of this.#lifetimes.values()) lifetime.valid = false;
        this.#lifetimes.clear();
        this.#files.clear();
        this.#loads.clear();
        this.#listeners.clear();
        this.#logged.clear();
    }

    /**
     * Wraps one `PromptManager` instance's `setChatCompletion`.
     *
     * The original runs first and its return value is passed through untouched, so a fault
     * in the projection can delay nothing and break nothing: by the time capture runs,
     * `promptManager.messages` and `tokenHandler.counts` are already populated exactly as
     * core left them. Capture completes before the wrapper returns, which is what puts it
     * ahead of `squashSystemMessages()`.
     * @param {any} manager The `PromptManager` instance (core's `promptManager`).
     * @returns {boolean} True when this store is armed on that instance.
     */
    attachTo(manager) {
        if (this.#wrapped) {
            return this.#wrapped.manager === manager;
        }
        if (!manager || typeof manager.setChatCompletion !== 'function') {
            return false;
        }
        const original = manager.setChatCompletion;
        if (original[WRAPPED] === true) {
            // Someone already wrapped it — a duplicate module copy, or a torn-down store
            // that failed to unwrap. Capturing twice would double every notification.
            this.#report('attach:double', 'setChatCompletion is already wrapped; receipts stay disarmed');
            return false;
        }
        const store = this;
        /**
         * @this {any}
         * @param {...any} args Forwarded to core untouched.
         * @returns {any} Whatever core returns.
         */
        const wrapper = function (...args) {
            const result = original.apply(this, args);
            store.#captureFrom(args[0]);
            return result;
        };
        /** @type {any} */ (wrapper)[WRAPPED] = true;
        manager.setChatCompletion = wrapper;
        this.#wrapped = { manager, original };
        return true;
    }

    /** @returns {boolean} Whether the capture seam is armed. */
    get armed() {
        return this.#wrapped !== null;
    }

    /**
     * The most recent capture for a chat, dry runs included, straight from memory.
     *
     * Synchronous on purpose: this is what per-row token badges read after a recount (doc
     * decision 2), and a render pass must not be able to start an IndexedDB read.
     * @param {string} [chatId] Chat id; the active chat when omitted.
     * @returns {PromptReceipt|null} The capture, or null.
     */
    latest(chatId) {
        const id = chatId === undefined ? this.#chatId() : String(chatId ?? '');
        if (!id) {
            return null;
        }
        return this.#latest.get(id) ?? null;
    }

    /**
     * The persisted receipt for one message.
     * @param {string} chatId Chat id.
     * @param {number} mesId Message index.
     * @returns {Promise<PromptReceipt|null>} The receipt, or null when there is none.
     */
    async forMessage(chatId, mesId) {
        const id = String(chatId ?? '');
        const index = Number(mesId);
        if (!id || !Number.isInteger(index)) {
            return null;
        }
        return this.#withChat(id, async (lifetime) => {
            const file = await this.#file(id, lifetime);
            return lifetime.valid ? file.receipts.find(receipt => receipt.mesId === index) ?? null : null;
        });
    }

    /**
     * Every persisted receipt for a chat, ascending by `mesId`.
     * @param {string} chatId Chat id.
     * @returns {Promise<PromptReceipt[]>} The receipts, possibly empty.
     */
    async all(chatId) {
        const id = String(chatId ?? '');
        if (!id) {
            return [];
        }
        return this.#withChat(id, async (lifetime) => {
            const file = await this.#file(id, lifetime);
            return lifetime.valid ? file.receipts.slice() : [];
        });
    }

    /**
     * Drops a chat's receipts from memory and from storage. Wired to `CHAT_DELETED` and
     * `GROUP_CHAT_DELETED` the way itemization wires its own delete
     * (`itemized-prompts.js:352-357`), so a deleted chat cannot leave an orphan row behind.
     * @param {string} chatId Chat id.
     * @returns {Promise<void>}
     */
    async forget(chatId) {
        const id = String(chatId ?? '');
        if (!id) {
            return;
        }
        const epoch = this.#disposalEpoch;
        const lifetime = this.#lifetimes.get(id);
        if (lifetime) lifetime.valid = false;
        this.#lifetimes.delete(id);
        this.#files.delete(id);
        this.#loads.delete(id);
        this.#latest.delete(id);
        if (this.#pending && this.#pending.chatId === id) {
            this.#pending = null;
        }
        const storage = this.#storageInstance();
        if (storage) {
            try {
                // An IndexedDB write that already started cannot be cancelled. Delete after it.
                await this.#queueWrite(id, () => storage.removeItem(id));
            } catch (error) {
                if (epoch === this.#disposalEpoch) this.#report('forget:throw', 'receipt storage delete failed', error);
            }
        }
        if (epoch === this.#disposalEpoch) this.#notify('forgotten', null, id, null);
    }

    /**
     * Registers a change listener. Fires on capture, resolution, landing, save, and forget.
     * @param {ReceiptListener} listener Called with what moved.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
        if (typeof listener !== 'function') {
            return () => { };
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /**
     * Debug knobs. `digest` opts into per-message content hashes; pass null to turn them
     * off again. Anything that is not a function is treated as "off".
     * @param {{digest?: ReceiptDigest|null}} options Options to apply.
     * @returns {void}
     */
    setOptions(options) {
        if (!options || typeof options !== 'object') {
            return;
        }
        if ('digest' in options) {
            this.#options.digest = typeof options.digest === 'function' ? options.digest : null;
        }
    }

    /**
     * Projects the tree the wrapper just intercepted. Everything here is synchronous and
     * everything is caught: this runs on the assembly path.
     * @param {any} chatCompletion The `ChatCompletion` handed to `setChatCompletion`.
     * @returns {void}
     */
    #captureFrom(chatCompletion) {
        try {
            const root = typeof chatCompletion?.getMessages === 'function' ? chatCompletion.getMessages() : null;
            if (!root) {
                this.#report('capture:no-tree', 'setChatCompletion was handed no message tree; nothing to capture');
                return;
            }
            const projection = projectPromptTree(root, { digest: this.#options.digest, names: this.#nameSnapshot() });
            const chatId = this.#chatId();
            /** @type {PromptReceipt} */
            const receipt = {
                version: RECEIPT_VERSION,
                chatId,
                mesId: null,
                capturedAt: Date.now(),
                generationType: this.#activeGeneration ? this.#activeGeneration.type : null,
                // Provisional. `CHAT_COMPLETION_PROMPT_READY` is the authority and lands
                // thirteen lines later (openai.js:1614); this only covers the case where
                // that event never arrives.
                dryRun: this.#activeGeneration ? this.#activeGeneration.dryRun : null,
                presetName: this.#presetName(),
                entries: projection.entries,
                holes: projection.holes,
                slots: projection.slots,
                totals: projection.totals,
                caveats: projection.caveats,
            };
            this.#pending = receipt;
            if (chatId) {
                this.#latest.delete(chatId);
                this.#latest.set(chatId, receipt);
                this.#evict(this.#latest, WARM_LATEST_CHATS);
            }
            this.#notify('captured', receipt);
        } catch (error) {
            this.#report('capture:throw', 'receipt capture failed; assembly is unaffected', error);
        }
    }

    /**
     * Stamps the authoritative dry-run flag from `CHAT_COMPLETION_PROMPT_READY` and closes
     * out dry runs, which have no message to bind to and are never persisted.
     * @param {any} data The frozen event payload `{ chat, dryRun }` (`openai.js:1613`).
     * @returns {void}
     */
    #resolve(data) {
        const receipt = this.#pending;
        if (!receipt) {
            return;
        }
        const dryRun = data && typeof data === 'object' ? data.dryRun === true : false;
        receipt.dryRun = dryRun;
        if (dryRun) {
            this.#pending = null;
            this.#notify('dry-run', receipt);
            return;
        }
        if (this.#squashEnabled()) {
            receipt.caveats = [...receipt.caveats, RECEIPT_CAVEATS.TOKENS_ARE_PRE_SQUASH];
        }
        this.#notify('resolved', receipt);
    }

    /**
     * Binds the pending capture to the message the generation produced and persists it.
     * @param {any} mesId Message index from `MESSAGE_RECEIVED`.
     * @param {any} type Generation type from the same event.
     * @returns {Promise<void>}
     */
    async #commit(mesId, type) {
        const receipt = this.#pending;
        if (!receipt) {
            return;
        }
        // Only a resolved, real generation can land. `null` means no
        // `CHAT_COMPLETION_PROMPT_READY` was seen, and "unknown" is not "landed".
        if (receipt.dryRun !== false) {
            return;
        }
        if (NON_GENERATION_TYPES.has(String(type ?? ''))) {
            return;
        }
        if (receipt.chatId !== this.#chatId()) {
            // The chat moved between assembly and delivery; there is no honest binding.
            this.#pending = null;
            return;
        }
        if (Date.now() - receipt.capturedAt > PENDING_TTL_MS) {
            this.#pending = null;
            this.#report('commit:stale', 'a capture outlived its generation and was dropped rather than bound to a later message');
            return;
        }
        const index = Number(mesId);
        if (!Number.isInteger(index) || index < 0) {
            this.#report('commit:mesId', `MESSAGE_RECEIVED carried an unusable message id (${String(mesId)}); receipt kept in memory only`);
            return;
        }
        this.#pending = null;
        receipt.mesId = index;
        await this.#withChat(receipt.chatId, async (lifetime) => {
            this.#notify('landed', receipt);
            await this.#persist(receipt, lifetime);
        });
    }

    /**
     * Writes one landed receipt into its chat's file. Storage failure is memory-only
     * operation plus one error line — never a thrown promise on the generation path.
     * @param {PromptReceipt} receipt Landed record.
     * @param {ReceiptLifetime} lifetime Generation's chat ownership.
     * @returns {Promise<void>}
     */
    async #persist(receipt, lifetime) {
        if (!receipt.chatId) {
            // No chat id means no key. The capture stays available through `latest()`.
            return;
        }
        try {
            const file = await this.#file(receipt.chatId, lifetime);
            if (!lifetime.valid) return;
            file.receipts = mergeReceipt(file.receipts, receipt, MAX_RECEIPTS_PER_CHAT);
            const storage = this.#storageInstance();
            if (!storage) {
                return;
            }
            const payload = { version: RECEIPT_VERSION, receipts: file.receipts };
            await this.#queueWrite(receipt.chatId, () => lifetime.valid ? storage.setItem(receipt.chatId, payload) : undefined);
            if (lifetime.valid) this.#notify('saved', receipt);
        } catch (error) {
            if (lifetime.valid) this.#report('persist:throw', 'receipt storage write failed; receipts stay in memory for this session', error);
        }
    }

    /**
     * Applies one `message-index-hooks` event to the ACTIVE chat's stored receipts
     * (`RECEIPT_VERSION` 2, design doc decision 2): the warm file, its persisted copy, and
     * the `#latest` binding. `#pending` is deliberately untouched — it has no `mesId` yet, so
     * a delete/truncate/swap has nothing on it to reindex.
     *
     * Reindexing only ever targets the chat that is CURRENTLY LOADED, because `chat[]` — the
     * array core just mutated — only ever exists for the active chat; there is no other chat
     * whose indices could have moved. Wrapped in its own try/catch, same discipline as
     * {@link #captureFrom}: a subscriber's own bug must never surface as a broken delete, and
     * this runs from an un-awaited call (`void this.#reindex(event)`) where a rejection would
     * otherwise become an unhandled promise rejection.
     * @param {MessageIndexEvent} event The event from `message-index-hooks`.
     * @returns {Promise<void>}
     */
    async #reindex(event) {
        const chatId = this.#chatId();
        if (!chatId) {
            return;
        }
        return this.#withChat(chatId, async (lifetime) => {
            try {
                const file = await this.#file(chatId, lifetime);
                if (!lifetime.valid) return;
                /** @type {PromptReceipt[]} */
                let after;
                if (event.type === 'deleted') {
                    after = reindexForDelete(file.receipts, event.index);
                } else if (event.type === 'truncated') {
                    after = reindexForTruncate(file.receipts, event.newLength);
                } else if (event.type === 'swapped') {
                    after = reindexForSwap(file.receipts, event.a, event.b);
                } else {
                    return;
                }
                file.receipts = after;
                this.#reindexLatest(chatId, event);
                const storage = this.#storageInstance();
                if (storage) {
                    try {
                        await this.#queueWrite(chatId, () => lifetime.valid
                            ? storage.setItem(chatId, { version: RECEIPT_VERSION, receipts: after })
                            : undefined);
                    } catch (error) {
                        if (lifetime.valid) this.#report('reindex:persist', 'receipt reindex write failed; the warm copy stays correct for this session', error);
                    }
                }
                if (lifetime.valid) this.#notify('reindexed', null, chatId, null);
            } catch (error) {
                if (lifetime.valid) this.#report('reindex:throw', 'receipt reindex failed', error);
            }
        });
    }

    /**
     * Applies one message-index event to the `#latest` binding for one chat. A deleted
     * binding degrades to `mesId: null` — the capture stays real, only the binding is gone —
     * and a shifted or swapped binding follows its record's new position. A dry run or a
     * still-pending capture (`mesId === null`) has no binding to move.
     * @param {string} chatId Chat whose `#latest` entry may need to move.
     * @param {MessageIndexEvent} event The event from `message-index-hooks`.
     * @returns {void}
     */
    #reindexLatest(chatId, event) {
        const latest = this.#latest.get(chatId);
        if (!latest || latest.mesId === null) {
            return;
        }
        const boundMesId = latest.mesId;
        /** @type {number|null} */
        let nextMesId;
        if (event.type === 'deleted') {
            if (boundMesId === event.index) {
                nextMesId = null;
            } else if (boundMesId > event.index) {
                nextMesId = boundMesId - 1;
            } else {
                return;
            }
        } else if (event.type === 'truncated') {
            if (boundMesId >= event.newLength) {
                nextMesId = null;
            } else {
                return;
            }
        } else if (event.type === 'swapped') {
            if (boundMesId === event.a) {
                nextMesId = event.b;
            } else if (boundMesId === event.b) {
                nextMesId = event.a;
            } else {
                return;
            }
        } else {
            return;
        }
        this.#latest.set(chatId, { ...latest, mesId: nextMesId });
    }

    /**
     * The warm file for a chat, loading it once and sharing the in-flight promise.
     * @param {string} chatId Chat id.
     * @param {ReceiptLifetime} lifetime Read's chat ownership.
     * @returns {Promise<{version: number, receipts: PromptReceipt[]}>} The file.
     */
    #file(chatId, lifetime) {
        if (!lifetime.valid) return Promise.resolve({ version: RECEIPT_VERSION, receipts: [] });
        const cached = this.#files.get(chatId);
        if (cached) {
            return Promise.resolve(cached);
        }
        const inflight = this.#loads.get(chatId);
        if (inflight) {
            return inflight;
        }
        const promise = this.#loadFile(chatId, lifetime);
        this.#loads.set(chatId, promise);
        const cleanup = () => {
            if (this.#loads.get(chatId) === promise) this.#loads.delete(chatId);
        };
        void promise.then(cleanup, cleanup);
        return promise;
    }

    /**
     * @param {string} chatId Chat id.
     * @param {ReceiptLifetime} lifetime Read's chat ownership.
     * @returns {Promise<{version: number, receipts: PromptReceipt[]}>} The loaded file.
     */
    async #loadFile(chatId, lifetime) {
        const write = this.#writes.get(chatId);
        if (write) await write.catch(() => undefined);
        if (!lifetime.valid) return { version: RECEIPT_VERSION, receipts: [] };
        /** @type {PromptReceipt[]} */
        let receipts = [];
        const storage = this.#storageInstance();
        if (storage) {
            try {
                receipts = normalizeStoredFile(await storage.getItem(chatId));
            } catch (error) {
                if (lifetime.valid) this.#report('load:throw', 'receipt storage read failed; this chat starts empty', error);
            }
        }
        if (!lifetime.valid) return { version: RECEIPT_VERSION, receipts: [] };
        const file = { version: RECEIPT_VERSION, receipts };
        this.#files.set(chatId, file);
        this.#evict(this.#files, WARM_CHAT_FILES);
        return file;
    }

    /**
     * Keeps pending work tied to its chat lifetime. Forget/dispose invalidate it; a new read
     * gets a fresh lifetime. Uncached, idle lifetimes are dropped to keep bookkeeping bounded.
     * @template T
     * @param {string} chatId Chat id.
     * @param {(lifetime: ReceiptLifetime) => Promise<T>} action Chat operation.
     * @returns {Promise<T>} The operation's result.
     */
    async #withChat(chatId, action) {
        let lifetime = this.#lifetimes.get(chatId);
        if (!lifetime) {
            lifetime = { valid: true, users: 0 };
            this.#lifetimes.set(chatId, lifetime);
        }
        lifetime.users += 1;
        try {
            return await action(lifetime);
        } finally {
            lifetime.users -= 1;
            if (lifetime.users === 0 && !this.#files.has(chatId) && !this.#loads.has(chatId)
                && this.#lifetimes.get(chatId) === lifetime) {
                this.#lifetimes.delete(chatId);
            }
        }
    }

    /**
     * Serializes writes/deletions for one chat; a failed write never blocks its deletion.
     * @template T
     * @param {string} chatId Chat id.
     * @param {() => T | Promise<T>} action Storage operation.
     * @returns {Promise<T>} Completion of this operation.
     */
    #queueWrite(chatId, action) {
        const previous = this.#writes.get(chatId);
        const pending = (previous ?? Promise.resolve()).catch(() => undefined).then(action);
        this.#writes.set(chatId, pending);
        const cleanup = () => {
            if (this.#writes.get(chatId) === pending) this.#writes.delete(chatId);
        };
        void pending.then(cleanup, cleanup);
        return pending;
    }

    /**
     * The localforage instance, created on first use. A creation failure is sticky: the
     * store keeps capturing into memory and never retries a broken storage layer.
     * @returns {any} The instance, or null when storage is unavailable.
     */
    #storageInstance() {
        if (this.#storage === false) {
            return null;
        }
        if (this.#storage) {
            return this.#storage;
        }
        try {
            const instance = localforage.createInstance({ name: RECEIPT_STORE_NAME });
            if (!instance || typeof instance.getItem !== 'function' || typeof instance.setItem !== 'function') {
                throw new Error('localforage returned an unusable instance');
            }
            this.#storage = instance;
            return instance;
        } catch (error) {
            this.#storage = false;
            this.#report('storage:create', 'receipt storage is unavailable; receipts stay in memory for this session', error);
            return null;
        }
    }

    /**
     * Arms the seam against core's live `promptManager` binding.
     * @returns {boolean} True when armed.
     */
    #tryAttach() {
        if (this.#wrapped) {
            return true;
        }
        return this.attachTo(promptManager);
    }

    /** @returns {string} The active chat id, or ''. */
    #chatId() {
        try {
            return String(getCurrentChatId() ?? '');
        } catch (error) {
            this.#report('chatId:throw', 'active chat read failed', error);
            return '';
        }
    }

    /** @returns {string|null} The selected preset name, or null. */
    #presetName() {
        const name = oai_settings?.preset_settings_openai;
        return typeof name === 'string' && name ? name : null;
    }

    /**
     * Snapshots identifier→name off the wrapped manager's live `serviceSettings.prompts`
     * (`RECEIPT_VERSION` 2). Own try/catch, separate from `#captureFrom`'s: a broken prompts
     * array must degrade to "no names this capture", not lose the whole receipt.
     * @returns {Map<string, string>|null} The snapshot, or null when there is nothing usable.
     */
    #nameSnapshot() {
        try {
            const prompts = this.#wrapped?.manager?.serviceSettings?.prompts;
            if (!Array.isArray(prompts)) {
                return null;
            }
            /** @type {Map<string, string>} */
            const names = new Map();
            for (const prompt of prompts) {
                if (prompt && typeof prompt.identifier === 'string' && prompt.identifier
                    && typeof prompt.name === 'string' && prompt.name) {
                    names.set(prompt.identifier, prompt.name);
                }
            }
            return names;
        } catch (error) {
            this.#report('capture:names', 'prompt name snapshot failed; entries fall back to raw identifiers', error);
            return null;
        }
    }

    /** @returns {boolean} Whether a real generation will squash system messages. */
    #squashEnabled() {
        return oai_settings?.squash_system_messages === true;
    }

    /**
     * @param {string} type Core event type.
     * @param {(...args: any[]) => void} handler Listener.
     * @returns {void}
     */
    #on(type, handler) {
        this.#subscriptions.push({ type, handler });
        eventSource.on(type, handler);
    }

    /**
     * Insertion-ordered trim of a warm cache.
     * @param {Map<string, any>} map Cache to trim.
     * @param {number} max Maximum entries.
     * @returns {void}
     */
    #evict(map, max) {
        while (map.size > max) {
            const oldest = map.keys().next();
            if (oldest.done) {
                return;
            }
            map.delete(oldest.value);
            if (map === this.#files && this.#lifetimes.get(oldest.value)?.users === 0) {
                this.#lifetimes.delete(oldest.value);
            }
        }
    }

    /**
     * @param {ReceiptChange['reason']} reason What moved.
     * @param {PromptReceipt|null} receipt The record, when there is one.
     * @param {string} [chatId] Chat override, for changes with no record.
     * @param {number|null} [mesId] Message override.
     * @returns {void}
     */
    #notify(reason, receipt, chatId, mesId) {
        /** @type {ReceiptChange} */
        const change = {
            reason,
            chatId: chatId ?? receipt?.chatId ?? '',
            mesId: mesId === undefined ? (receipt?.mesId ?? null) : mesId,
            receipt: receipt ?? null,
        };
        for (const listener of [...this.#listeners]) {
            try {
                listener(change);
            } catch (error) {
                console.error('[kotatsu receipts] listener threw', error);
            }
        }
    }

    /**
     * One `console.error` per distinct failure, for the life of the store. Receipts are a
     * background convenience; they are not allowed to fill anyone's console.
     * @param {string} key Dedupe key.
     * @param {string} message What went wrong.
     * @param {unknown} [error] Optional cause.
     * @returns {void}
     */
    #report(key, message, error) {
        if (this.#logged.has(key)) {
            return;
        }
        this.#logged.add(key);
        if (error === undefined) {
            console.error(`[kotatsu receipts] ${message}`);
        } else {
            console.error(`[kotatsu receipts] ${message}`, error);
        }
    }
}

/** The page-wide receipt store. */
export const receiptStore = new PromptReceiptStore();

/**
 * Registration entry for the `firstLoadInit()` seam, invoked from `initKotatsuShell()` the
 * way `initBranchStore()` is. Wiring only: no storage is touched until a generation is
 * captured or a caller asks for a stored receipt.
 * @returns {void}
 */
export function initPromptReceipts() {
    receiptStore.init();

    if (typeof window === 'undefined') {
        return;
    }
    /** @type {Window & typeof globalThis & {kotatsu?: Record<string, unknown>}} */
    const targetWindow = window;
    if (!targetWindow.kotatsu || typeof targetWindow.kotatsu !== 'object') {
        targetWindow.kotatsu = {};
    }
    targetWindow.kotatsu.receipts = receiptStore;
}
