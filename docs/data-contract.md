# Kotatsu data contract

The on-disk `data/` compatibility contract. **An existing SillyTavern `data/default-user/` must drop into Kotatsu unchanged, forever, and must remain openable by stock SillyTavern afterwards.** Round-trip is bidirectional: Kotatsu may add, never rename, never restructure, never drop.

Companion to `CONTRACT.md` (the frozen extension ABI). Neither may be broken without a spec change (`../st-fork/SPEC.md`).

Baseline: SillyTavern 1.18.0, staging `1ca70787f`. Every `file:line` below was read in **this clone**, not in the upstream map and not in the live install. Where the source map (`../st-fork/maps/extensions-and-data.md`) and the code disagree, the code wins; the disagreements are logged in §9.

**Verification rule.** Any change touching a path in this document must be proven against a real profile — record counts, byte-diffs, a stock-ST reopen — not against unit tests alone.

---

## 0. The three-line version

1. `USER_DIRECTORY_TEMPLATE` (`src/constants.js:16`) is the canonical folder list. Add folders freely; rename nothing.
2. Every reader in ST is lenient and every writer is a **full-file rewrite**. Anything you fail to carry across a load/save cycle is destroyed silently and permanently.
3. Unknown fields are user property. `extra.ve_usage`, `chat_metadata.script_injects`, V3-only card fields, the preset `extensions` bag — preserve verbatim. (Three formats are exceptions and drop unknowns by design; they are named in §6.) **Amended 2026-08-25 (metrics native v0):** `extra.mm_usage` used to be this rule's headline example and is no longer unknown — Kotatsu adopted it as the native metrics key and now writes it. Its *shape* is documented in §2.6; the rule it illustrated is unchanged, and `ve_usage` (still foreign-owned, read-only) takes its place as the example.

---

## 1. `USER_DIRECTORY_TEMPLATE` — 31 keys, 30 folders

`src/constants.js:16-48`, a frozen object. Resolved per handle by `getUserDirectories(handle)` (`src/users.js:683-697`) as `path.join(DATA_ROOT, handle, TEMPLATE[key])`, memoized in `DIRECTORIES_CACHE` (`src/users.js:40`). `DATA_ROOT` comes from `config.yaml → dataRoot`.

> The template has **31 keys**; `root` maps to `''`, so it names the profile root rather than a subdirectory. That leaves **30 folder names**. (The map says "all 30 keys" — see §9.)

| # | Key | Path on disk | What lives there / format / reader-writer |
|---|---|---|---|
| — | `root` | `` (profile root) | Not a folder. Holds `settings.json`, `secrets.json`, `stats.json`, `image-metadata.json`, `content.log`. Root of the backup ZIP (`src/users.js:1148`). |
| 1 | `thumbnails` | `thumbnails` | Parent only; generated JPEG/PNG cache. `src/endpoints/thumbnails.js`. Fully regenerable — safe to delete, never safe to *require*. |
| 2 | `thumbnailsBg` | `thumbnails/bg` | Background thumbnails, one per `backgrounds/` image. |
| 3 | `thumbnailsAvatar` | `thumbnails/avatar` | Character-card thumbnails, keyed by avatar filename. |
| 4 | `thumbnailsPersona` | `thumbnails/persona` | Persona thumbnails; `force_avatar` on user messages points at `/thumbnail?type=persona&file=…`. |
| 5 | `worlds` | `worlds` | Lorebooks, one `.json` each. `src/endpoints/worldinfo.js`; client `public/scripts/world-info.js`. Schema §6.1. |
| 6 | `user` | `user` | Parent only for `user/images`, `user/workflows`, `user/files`. |
| 7 | `avatars` | `User Avatars` | **Space + capitals load-bearing.** Persona images (PNG/etc.). `src/endpoints/avatars.js:18,30,57`. Names map to `power_user.personas`. |
| 8 | `userImages` | `user/images` | Gallery store, one subfolder per character name. Gallery extension. |
| 9 | `groups` | `groups` | Group definitions, `<epochMs>.json`. `src/endpoints/groups.js:116+`. |
| 10 | `groupChats` | `group chats` | **Space load-bearing.** Group chat `.jsonl`, named `<chat_id>.jsonl` with no character prefix. `src/endpoints/chats.js:797-874`. |
| 11 | `chats` | `chats` | `chats/<avatarBasename>/<chatName>.jsonl`. The single most important folder in the profile. §2. |
| 12 | `characters` | `characters` | Character cards as `.png` with tEXt chunks, plus per-character sprite/background subfolders. `src/endpoints/characters.js`, `src/endpoints/sprites.js`. §3. |
| 13 | `backgrounds` | `backgrounds` | Chat background images. `src/endpoints/backgrounds.js:16,77,104,141`. |
| 14 | `novelAI_Settings` | `NovelAI Settings` | **Space + capitals load-bearing.** NovelAI presets, `.json`. `src/endpoints/presets.js:21`. |
| 15 | `koboldAI_Settings` | `KoboldAI Settings` | **Space + capitals load-bearing.** Kobold/Horde presets, `.json`. `presets.js:19-20`. |
| 16 | `openAI_Settings` | `OpenAI Settings` | **Space + capitals load-bearing.** Chat-completion presets, `.json`. `presets.js:25`. The acceptance fixtures live here. §4. |
| 17 | `textGen_Settings` | `TextGen Settings` | **Space + capitals load-bearing.** Text-completion presets, `.json`, flat dump of `textgenerationwebui_settings`. `presets.js:23`. |
| 18 | `themes` | `themes` | UI themes, `.json`, 39 keys. `src/endpoints/themes.js:10-19`. §6.4. |
| 19 | `movingUI` | `movingUI` | MovingUI panel-position presets, `.json`. `src/endpoints/moving-ui.js:8-19`. §6.5. |
| 20 | `extensions` | `extensions` | Per-user (local-tier) extensions, one folder each; served under `/scripts/extensions/third-party/<name>/`. See `CONTRACT.md`. |
| 21 | `instruct` | `instruct` | Instruct-mode templates, `.json`. `presets.js:27`. Live copy is `power_user.instruct`. |
| 22 | `context` | `context` | Context templates, `.json`. `presets.js:29`. Live copy is `power_user.context`. |
| 23 | `quickreplies` | `QuickReplies` | **Capitals load-bearing** (key is lowercase, folder is not). Quick Reply sets, `.json`. `src/endpoints/quick-replies.js:10-19`. §6.3. |
| 24 | `assets` | `assets` | Downloaded character assets, seven fixed category subdirs (`ambient`, `bgm`, `blip`, `character`, `live2d`, `temp`, `vrm`). `src/endpoints/assets.js:85,109,223-288`. |
| 25 | `comfyWorkflows` | `user/workflows` | ComfyUI workflow JSON for the image-generation extension. |
| 26 | `files` | `user/files` | Data Bank / chat attachment store. `src/endpoints/files.js`. |
| 27 | `vectors` | `vectors` | RAG indices, `vectors/<source>/<collectionId>/<model>`, each a `vectra.LocalIndex`. `src/endpoints/vectors.js`. |
| 28 | `backups` | `backups` | `chat_<slug>_<YYYYMMDD-HHMMSS>.jsonl` (`chats.js:31,41`) and `settings_<handle>_<ts>.json` (`settings.js:136`), plus `_group_metadata_update/` and `_sysprompt/`. `src/endpoints/backups.js`. |
| 29 | `sysprompt` | `sysprompt` | System-prompt presets, `.json`. `presets.js:31`. Live copy is `power_user.sysprompt`. |
| 30 | `reasoning` | `reasoning` | Reasoning-format templates, `.json`. `presets.js:33`. Live copy is `power_user.reasoning`. |

**Case hazard.** Six names carry spaces or non-lowercase characters: `User Avatars`, `group chats`, `NovelAI Settings`, `KoboldAI Settings`, `OpenAI Settings`, `TextGen Settings`, plus `QuickReplies`. A rename is invisible on Windows/macOS and catastrophic the moment the profile is copied to Linux or into a Docker image. Treat the template as frozen data, not as code.

**`.gitignore`d dev data.** Kotatsu's own `data/` in this clone is dev-only. A live user profile is never the dev target (`CLAUDE.md`, hard rules).

---

## 2. Chat `.jsonl`

Types: `public/global.d.ts:45-128` (`ChatFile`, `ChatHeader`, `ChatMetadata`, `ChatMessage`, `SwipeInfo`, `BaseMessageExtra`, `MediaAttachment`).
Client: `saveChat()` `public/script.js:7369`, `getChat()` `public/script.js:7608`.
Server: `/api/chats/save` → `trySaveChat()` `src/endpoints/chats.js:457`; `/api/chats/get` → `getChatData()` `src/endpoints/chats.js:502`.

### 2.1 File shape

Newline-delimited JSON. `trySaveChat` (`chats.js:458`) serializes as:

```js
const jsonlData = chatData?.map(m => JSON.stringify(m)).join('\n');
```

`join`, not per-line append — so **there is no trailing newline**, and the whole file is rewritten on every save (§2.5). The reader is the mirror image (`chats.js:503-513`): `split('\n')`, `tryParse` each line, `.filter(x => x)` — **unparseable lines are dropped silently, with no error and no backup**. A malformed line does not fail the load; it disappears at the next save.

### 2.2 The header-line rule, and where it is not applied

Line 0 is a `ChatHeader` **only if it carries `chat_metadata`**:

```jsonc
{ "chat_metadata": { … }, "user_name": "unused", "character_name": "unused" }
```

Written verbatim at `public/script.js:7401-7406`. `user_name` and `character_name` are hard-coded `'unused'` literals, typed `@deprecated` at `global.d.ts:52-56`; nothing reads them, but they must still be written for stock-ST back-compat. `create_date` is legacy — not written by 1.18.0, still present in older files, read by nothing.

`ChatFile` types the header as optional: `0?: ChatHeader` (`global.d.ts:45-48`).

Three readers apply the test correctly and one does not:

| Reader | Test | `file:line` |
|---|---|---|
| Group chat load | `Object.hasOwn(data[0], 'chat_metadata')` before `data.shift()` | `public/scripts/group-chats.js:272-273` |
| Server chat-info scan | `_.isObjectLike(jsonData.chat_metadata)` at `itemCounter === 0` | `src/endpoints/chats.js:394-396` |
| Server jsonl import | `user_name !== undefined \|\| name !== undefined \|\| chat_metadata !== undefined` | `src/endpoints/chats.js:764` |
| **Character chat load** | **none — unconditional `data.shift()`** | **`public/script.js:7630-7631`** |

> ### The no-header ambiguity
>
> `getChat()` shifts line 0 unconditionally and takes `chatHeader?.chat_metadata ?? {}`. For a character chat whose line 0 is a real message, **that message is eaten on load and gone forever on the next save**, because saving is a full rewrite.
>
> The exposure is real, not theoretical: group chats that were never registered in any group's `chats[]` were skipped by `migrateGroupChatsMetadataFormat()` and still have a message on line 0. `getGroupChat()` handles them; nothing else in the codebase would.
>
> **Kotatsu rule:** every reader of a `.jsonl` — core, extension, or Kotatsu-owned — MUST gate the shift on `Object.hasOwn(line0, 'chat_metadata')`. The server-side heuristic `jsonData.name || jsonData.character_name || jsonData.chat_metadata` (`chats.js:417`) is the acceptable looser variant for *validity* checks; it is not a substitute for the header test. Fixing `script.js:7630` is a strict improvement over stock and does not change the file format.

### 2.3 `chat_metadata`

`ChatMetadata` (`global.d.ts:58-64`) declares `tainted`, `integrity`, `scenario`, `persona` and then `[key: string]: any` — **the index signature is the contract**. Known inhabitants and their writers:

| Key | Writer |
|---|---|
| `integrity` | `public/script.js:7639-7641` — `uuidv4()` minted on load if absent |
| `tainted` | `public/script.js` — set once the user actually interacts |
| `main_chat` | `public/scripts/bookmarks.js:199,281` — names the parent chat on branches/checkpoints |
| `note_prompt`, `note_interval`, `note_position`, `note_depth`, `note_role` | Author's Note |
| `timedWorldInfo` | `public/scripts/world-info.js` — `{sticky:{}, cooldown:{}}` |
| `lastInContextMessageId`, `chat_id_hash` | core |
| `variables` | STscript local variable store |
| `world_info` | chat-bound lorebook |
| `scenario`, `mes_example` | group overrides, read `group-chats.js:561-562` |
| `script_injects` | **third-party** (GuidedGenerations) — the canonical proof that unknown keys are live data |

### 2.4 The `integrity` slug

A `uuidv4` minted client-side on load when missing (`script.js:7639-7641`; group path `group-chats.js:277-278`). It is a **lost-update guard, not a checksum** — it never changes with content.

Flow (`chats.js:457-468`):

1. Client sends `[header, ...messages]` with `header.chat_metadata.integrity`.
2. `trySaveChat` takes `chatData?.[0]?.chat_metadata?.integrity` (`:461`) — **from line 0 of the payload, so a headerless payload has no slug and the check is skipped entirely**.
3. `checkChatIntegrity(filePath, slug)` (`:316-335`) reads only the *first line* of the file on disk. Missing file → intact. No `chat_metadata.integrity` on disk → intact, logged as skipped (`:329`).
4. Mismatch → `IntegrityMismatchError` → HTTP 400 `{error:'integrity'}` (`:490`, group `:867`).
5. `request.body.force === true` is the bypass (`:482`, `:859`); the client surfaces it as an overwrite confirmation (`group-chats.js:646-664`).

Gated globally by the `checkIntegrity` config flag (`backups.chat.checkIntegrity`).

**Kotatsu rule:** any Kotatsu writer that touches a `.jsonl` goes through `trySaveChat`, carries the slug, and never passes `force` without an explicit user decision. Writing a chat file behind the endpoint's back defeats the only concurrent-write guard in the product.

### 2.5 Full-file rewrite on save

`saveChat()` (`script.js:7369-7420`) builds `[chatHeader, ...trimmedChat]` from the in-memory `chat` array and POSTs the whole thing; `trySaveChat` writes the whole thing. There is no append path, no partial write, no journal.

Consequences that are load-bearing for every feature Kotatsu builds:

- Anything not in the in-memory message object is **deleted** on the next save. Preservation is not passive; a message object that lost a key in a mapper loses it on disk.
- `mesId` truncation is how branches and checkpoints get their content: `chat.slice(0, mesId + 1)` (`script.js:7396-7400`).
- Concurrent editors clobber each other; `integrity` is the only defense.
- File size is rewritten in full on every message. This is the reason the backup rotation exists (`backupChat`, `chats.js:41`, throttled per handle by `getBackupFunction`, `chats.js:66`).

### 2.6 Message object

`ChatMessage` (`global.d.ts:66-81`), all fields optional:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name of the speaker |
| `is_user` | boolean | User vs. character turn |
| `is_system` | boolean | Excluded from `txt` export (`chats.js:645+`) |
| `mes` | string | The message body |
| `send_date` | `MessageTimestamp` | ISO 8601 via `getMessageTimeStamp()` (`RossAscends-mods.js:192`) |
| `gen_started`, `gen_finished` | `MessageTimestamp` | Generation window |
| `title` | string | Generation title (Horde worker / raw-prompt tooltip) |
| `force_avatar` | string | Usually `/thumbnail?type=persona&file=…` |
| `original_avatar` | string | **Group chats only** — the speaker's avatar filename; drives activation |
| `swipe_id` | number | Index into `swipes[]` |
| `swipes` | `string[]` | Alternate generations; `swipes[swipe_id]` must equal `mes` |
| `swipe_info` | `SwipeInfo[]` | Parallel to `swipes[]`; `{send_date, gen_started, gen_finished, extra}` (`global.d.ts:83-88`) |
| `extra` | `ChatMessageExtra` | See below |

`swipes` / `swipe_info` / `swipe_id` are a **three-way parallel structure**. Any operation that reorders, truncates, or inserts into one must do the same to the others, and must keep `mes` synchronized with `swipes[swipe_id]`.

**`extra` is explicitly open:**

```ts
type ChatMessageExtra = BaseMessageExtra & Partial<ReasoningMessageExtra> & Record<string, any>;
```

— `public/global.d.ts:23`. The `Record<string, any>` is deliberate. `BaseMessageExtra` (`global.d.ts:90-128`) names `api`, `model`, `type`, `gen_id`, `bias`, `uses_system_ui`, `memory`, `display_text`, `reasoning_display_text`, `tool_invocations`, `title`, `isSmallSys`, `token_count`, `swipeable`, `overswipe_behavior`, `files`, `inline_image`, `media_display`, `media_index`, `media`, plus `@deprecated` `file`, `image`, `video`, `image_swipes`, `append_title`, `generationType`, `negative`, plus the `[IGNORE_SYMBOL]` runtime marker. `ReasoningMessageExtra` (`public/scripts/reasoning.js:1486-1491`) adds `reasoning`, `reasoning_duration`, `reasoning_type`, `reasoning_signature`. Bookmarks add `bookmark_link` and `branches[]` (`bookmarks.js:290`, `:241`).

Third-party keys live here too — `extra.ve_usage` (Voidlit Echoes) has no writer anywhere in `public/` or `src/`, and a repo-wide grep will mislabel it as orphan data. **It is live.** Preserve every unrecognized `extra.*` key across load → edit → save.

**`extra.mm_usage` — amended 2026-08-25, metrics native v0.** It now HAS a core writer and is no longer third-party data. Kotatsu adopted the retired message-metrics extension's key rather than migrating chats, so every chat that extension (or the older Voidlit build) ever annotated keeps its bars for free.

- **Writers (core):** `public/script.js` — `StreamingProcessor.onProgressStreaming` on `isFinal` (streaming), and `saveReply()`'s four branches (non-streaming). Both write immediately before `CHARACTER_MESSAGE_RENDERED` fires. Values come from `public/scripts/usage-capture.js` `normalizeUsage()`.
- **Readers:** `public/kotatsu/metrics/*`. `extra.ve_usage` remains a READ-ONLY fallback — foreign data Kotatsu paints and never writes.
- **Shape** (all counts are integers; `promptTokens` always INCLUDES the cached portion, whichever dialect it came from):

```ts
type MmUsage = {
    provider: 'anthropic' | 'openai';
    promptTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    cacheKnown: boolean;
};
```

- **Swipes:** `mm_usage` rides `swipe_info[].extra` on purpose and is deliberately absent from the `token_count` / `reasoning` delete lists (`script.js` finalize and `saveReply()`). Each swipe was its own generation with its own prompt and its own cache outcome, so per-swipe usage is correct, not leakage.
- **Round trip:** an older or unrecognized shape (the extension's own, a hand-edit) is preserved verbatim like any other `extra.*` key. The reader treats a non-object as absent and paints nothing rather than a bar of `NaN`s. Stock SillyTavern ignores the key entirely, so the file stays openable there.

### 2.7 Naming

`humanizedDateTime()` — duplicated at `src/util.js:539` (server) and `public/scripts/RossAscends-mods.js:169` (client). Local time, `YYYY-MM-DD@HHhMMmSSsMSms`, month/day/hour/min/sec padded to 2, ms to 3.

| Kind | Pattern | Where |
|---|---|---|
| New chat | `${character.name} - ${humanizedDateTime()}.jsonl` | `script.js:1309,1396,1424,10614` |
| Imported chat | `${characterName} - ${humanizedDateTime()} imported.jsonl` | `chats.js:741,780`; `characters.js:818` |
| Checkpoint | `${cleanName} - Checkpoint #N` | `bookmarks.js:46` (`bookmarkNameToken`) |
| **Branch** | `${cleanName} - Branch #N` | `bookmarks.js:212` |
| Group chat | `${group.chat_id}.jsonl`, `chat_id` a bare `humanizedDateTime()` — **no character prefix** | `group-chats.js` |
| Chat backup | `chat_<sanitizedSlug>_<YYYYMMDD-HHMMSS>.jsonl` | `chats.js:31,41`; `generateTimestamp()` `src/util.js:624` |
| Settings backup | `settings_<handle>_<YYYYMMDD-HHMMSS>.json` | `settings.js:136` |

Server-side every filename is `sanitize()`d and confined with `isPathUnderParent` before use (`chats.js:476-477`, `:521`).

### 2.8 Branch semantics as they exist today

`createBranch(mesId, { swipeId })` — `public/scripts/bookmarks.js:186-243`. Carries the comment `// Export is used by Timelines extension. Do not remove.` at `bookmarks.js:185`; it is part of the extension ABI.

> **This is not a file copy.** The map describes branching as a copy of the source `.jsonl`; the code builds an in-memory snapshot and writes a brand-new file through the ordinary save path. See §9.

Mechanism, in order:

1. `mainChatName = getCurrentChatDetails().sessionName` (`bookmarks.js:198`; `script.js:8505`).
2. `newMetadata = { main_chat: mainChatName }` (`:199`) — the only metadata the branch inherits explicitly.
3. Name: `getUniqueName(mainChatName, …, { nameBuilder: buildBranchName, startIndex: 1 })` (`:214`). `buildBranchName` (`:207-213`) strips a trailing ` - Branch #\d+` **and** a legacy leading `Branch #\d+ - ` before appending ` - Branch #${i}` — so branch names never nest, and a branch of a branch is `Original - Branch #2`, not `Original - Branch #1 - Branch #2`.
4. `getBranchChatSnapshot(mesId, {swipeId})` (`:171-183`) = `structuredClone(chat.slice(0, mesId + 1))`, then, if a `swipeId` was given, `syncSwipeToMes(null, swipeId, snapshot[mesId])` so the branch opens on the chosen swipe.
5. `saveChat({ chatName: name, withMetadata: newMetadata, mesId, chatData: branchChatSnapshot })` (`:232`) — or `saveGroupBookmarkChat(...)` for groups (`:230`). `saveChat` merges `{...chat_metadata, ...withMetadata}` (`script.js:7380`), so the branch inherits the parent's full metadata with `main_chat` overlaid. **`integrity` is inherited too** and the new file therefore starts life sharing a slug with its parent.
6. The source message is annotated in place: `lastMes.extra.branches ??= []` then `push(name)` (`:233-241`).

Checkpoints (`createNewBookmark`, `bookmarks.js:253-297`) use the same machinery — `main_chat` metadata (`:281`), `saveChat` with `mesId` (`:287`) — but write `extra.bookmark_link = name` (`:290`) as a scalar instead of appending to an array, and call `saveChatConditional()` afterwards to persist the annotation.

Contract consequences:

- `extra.branches[]` is an **append-only string array of chat names**, not paths, not ids. A rename of the branch file orphans the link; nothing repairs it.
- `chat_metadata.main_chat` is a **chat name string**. Same fragility.
- Branch lineage is therefore derivable but not authoritative, and it is stored *inside* the `.jsonl` files. Kotatsu may cache a richer graph (§7) but must be able to rebuild it from `main_chat` + `extra.branches[]` + `extra.bookmark_link` alone.

---

## 3. Character cards — `characters/*.png`

Parser: `src/character-card-parser.js`. Server wrappers and the format pipeline: `src/endpoints/characters.js`.

### 3.1 Dual tEXt chunks

`write(image, data)` — `src/character-card-parser.js:15-46`:

1. Decode all `tEXt` chunks; splice out every chunk whose keyword lowercases to `chara` or `ccv3` (`:20-25`).
2. Insert `chara` = base64(utf8(data)) before `IEND` (`:28-29`) — the V2 payload.
3. In a `try`, parse the same JSON, force `spec = 'chara_card_v3'` and `spec_version = '3.0'`, and insert `ccv3` = base64 of *that* (`:32-42`). Failure is swallowed (`:40-42`), so a card can legitimately end up with `chara` only.

**ST does not produce real V3 data — it relabels V2.** `'chara_card_v3'` appears exactly once in the codebase, at `character-card-parser.js:35`.

> The JSDoc at `character-card-parser.js:10` reads *"Writes only 'chara', 'ccv3' is not supported and removed not to create a mismatch."* That comment is stale and contradicts the code directly beneath it. Trust `:31-42`. Do not "fix the bug" it appears to describe.

`read(image)` — `:54-78`: collect `tEXt` chunks; **`ccv3` first** (`:64-68`), `chara` as fallback (`:70-74`), throw `No PNG metadata` if neither. Encoder vendored at `src/png/encode.js`; decoding via `png-chunks-extract` + `png-chunk-text`.

`parse(cardUrl, format)` — `:86-97`: `png` is the only accepted format.

**Kotatsu rule:** write both chunks, read `ccv3`-first. Writing only `chara` yields a card stock ST still reads but that loses the V3 relabel; reading only `chara` silently ignores genuine V3 cards from other tools.

### 3.2 V1 / V2 / V3 branching

`getCharaCardV2(jsonObject, directories, hoistDate)` (`characters.js:450`) dispatches: no `spec` → `convertToV2()` (`:469`); spec present → `readFromV2()` (`:504`). `charaFormatData()` (`characters.js:565`) is the single writer.

**V1** — still written top-level on every card for back-compat: `name`, `description`, `personality`, `scenario`, `first_mes`, `mes_example`, plus `creatorcomment`, `avatar` (`'none'`), `chat`, `talkativeness` (default `0.5`), `fav`, `tags[]`. Foreign V1 fields (e.g. Pygmalion's `char_persona`) survive because `charaFormatData` re-parses the original chunk.

**V2** — `src/types/spec-v2.d.ts`, written at `characters.js:596+`: `spec: 'chara_card_v2'`, `spec_version: '2.0'`, and `data{}` carrying the six core fields plus `creator_notes`, `system_prompt`, `post_history_instructions`, `alternate_greetings[]`, `character_book`, `tags[]`, `creator`, `character_version`, `extensions{}`.

`data.extensions` is ST's own namespace **and** a third-party passthrough: `talkativeness`, `fav`, `world`, `depth_prompt{prompt,depth,role}`, `regex_scripts[]`, alongside `pygmalion_id`, `github_repo`, `source_url`, `chub{}`, `risuai{}`, `sd_character_prompt{}`. Caller-supplied `extensions` JSON is deep-merged (`characters.js:646+`). `writeExtensionField(charId, key, value)` writes here; `context.constants.unset` deletes a field.

**V3 — read-through only.** `readFromV2()` (`:504-557`) maps a fixed handful of fields out of `char.data` and leaves the rest untouched, so **V3-only fields survive round-trips as opaque passthrough but never surface in the UI**. `group_only_greetings`, `nickname`, `creation_date`, `modification_date` have zero references repo-wide — inert but present on real cards. `data.assets[]` is consumed only on CharX import (`src/charx.js`), never from a PNG.

**Server-injected, non-card fields.** `processCharacter()` adds `json_data` (the raw chunk string), `date_added` (`ctimeMs`), `chat_size`, `date_last_chat` at list time; `toShallow()` returns `{shallow:true,…}` for the lazy list. `json_data` is un-editable and stripped before re-serialization (`:511`, `:570`). `unsetPrivateFields()` (`:498`) clears `fav`, `data.extensions.fav`, and `chat` on export.

**Kotatsu rule:** never round-trip a card through a typed struct that drops unknowns. Read → mutate the parsed object → write. `mutateJsonString(rawData, unsetPrivateFields)` on the export path (`characters.js:1657`) is the pattern to copy.

---

## 4. Chat-completion presets — `OpenAI Settings/*.json`

### 4.1 `settingsToUpdate` is the schema

`public/scripts/openai.js:303-407` defines

```js
export const settingsToUpdate = {
    presetKey: ['#selector', 'oai_settings_key', is_checkbox, is_connection],
    …
};
```

and `getChatCompletionPreset(settings)` (`openai.js:4501-4507`) builds the file by iterating **exactly** that map, in declaration order:

```js
const presetBody = {};
for (const [presetKey, [, settingsKey]] of Object.entries(settingsToUpdate)) {
    presetBody[presetKey] = settings[settingsKey];
}
return structuredClone(presetBody);
```

Therefore: **on-disk key set === `Object.keys(settingsToUpdate)`, in declaration order.** In this clone that is **102 keys** (the map says 100 — §9; this document previously said 103, corrected 2026-08-24 by the slice-0 characterization gate: the earlier count included `cometapi_model`, which the acceptance fixtures carry on disk — authored by a newer upstream — but which has ZERO references in this clone and is therefore silently dropped on any load/save, by stock ST of this baseline and by Kotatsu alike; 32 bytes, no warning. The known-unsupported set is pinned as a tested ledger in `tests/preset-byte-identity.test.js` — it goes red if a new unknown key appears or a ledger entry gains an implementation). Key order is part of the contract: a Kotatsu-written preset must stay textually diffable against an ST-written one.

The 102 group as: connection/model selection (`chat_completion_source`, the per-provider `*_model` / `*_endpoint` keys, `custom_*`, `azure_*`, `vertexai_*`, `openrouter_*`), samplers (`temperature`, `frequency_penalty`, `presence_penalty`, `top_p`, `top_k`, `top_a`, `min_p`, `repetition_penalty`, `seed`, `n`), context (`openai_max_context`, `openai_max_tokens`, `max_context_unlocked`), utility prompts (`send_if_empty`, `impersonation_prompt`, `new_chat_prompt`, `new_group_chat_prompt`, `new_example_chat_prompt`, `continue_nudge_prompt`, `group_nudge_prompt`, `wi_format`, `scenario_format`, `personality_format`, `assistant_prefill`, `assistant_impersonation`, `continue_prefill`, `continue_postfix`, `bias_preset_selected`), behavior toggles (`stream_openai`, `use_sysprompt`, `squash_system_messages`, `media_inlining`, `inline_image_quality`, `function_calling`, `tool_call_recurse_limit`, `tool_reasoning_mode`, `show_thoughts`, `reasoning_effort`, `verbosity`, `enable_web_search`, `request_images`, `request_image_aspect_ratio`, `request_image_resolution`, `names_behavior`, `show_external_models`, `bypass_status_check`), the prompt-manager payload (`prompts`, `prompt_order`), the free-form `extensions` bag, and — flagged — `reverse_proxy` and `proxy_password`, **serialized in plaintext**.

> **Credential hazard.** `reverse_proxy` and `proxy_password` are ordinary preset keys. Sharing a preset shares the proxy password. Any Kotatsu "share / export preset" affordance must strip both, and must say so in the UI.

**Load side.** `loadOpenAISettings(data, settings)` (`openai.js:4246`) calls `migrateChatCompletionSettings(settings)` (`:4206`, invoked `:4264`) and then fills `oai_settings[key] = settings[key] ?? default_settings[key]` **for every key of `default_settings`** (fill loop `:4267`; defaults literal `openai.js:408-515`). Keys on disk that are not in `default_settings` are therefore **dropped on the next save** — this format does *not* pass unknowns through, by design. The only exception is `extensions`, which is a first-class key holding a free-form object.

`bind_preset_to_connection` (`openai.js:514`) is in `default_settings` but deliberately **not** in `settingsToUpdate` — it lives only in `settings.json → oai_settings`, never in a preset file.

Legacy keys still on disk in older presets — `wrap_in_quotes`, `api_url_scale`, `use_alt_scale`, `windowai_model`, `zerooneai_model`, and the pre-rename `claude_use_sysprompt` / `use_makersuite_sysprompt` / `image_inlining` — are handled by the migration map and then dropped. Keep the migration; do not resurrect the writes.

### 4.2 `prompts[]`

Class `Prompt`, `public/scripts/PromptManager.js:80-116`. Constructor (`:103`) accepts `{identifier, role, content, name, system_prompt, position, injection_depth, injection_position, forbid_overrides, extension, injection_order, injection_trigger}` and applies three defaults at `:113-115`: `extension ?? false`, `injection_order ?? DEFAULT_ORDER`, `injection_trigger ?? []`.

| Field | Type | Meaning |
|---|---|---|
| `identifier` | string | Reserved names or a UUID. See below. |
| `name` | string | Display label in the Prompt Manager |
| `system_prompt` | boolean | Marks a built-in/system-owned prompt |
| `role` | `system` \| `user` \| `assistant` | Message role |
| `content` | string | Prompt text |
| `injection_position` | number | **`0` = relative/ordered** (position determined by `prompt_order`); **`1` = in-chat at depth** |
| `injection_depth` | number | Depth from the end of chat history; only meaningful when `injection_position === 1` |
| `injection_order` | number | Tie-break among prompts landing at the same depth; default `DEFAULT_ORDER` |
| `injection_trigger` | `string[]` | Generation types that activate this prompt; `[]` = always |
| `forbid_overrides` | boolean | Blocks character-card override of this prompt |
| `marker` | boolean | Content is supplied by the engine, not the file (`chatHistory`, `charDescription`, …) |
| `enabled` | boolean | Set externally, **not** by the constructor |
| `position` | string \| number | Legacy/runtime; not written by 1.18.0 |
| `extension` | boolean | Runtime-only; never serialized |

Reserved identifiers: `main`, `nsfw`, `jailbreak`, `enhanceDefinitions`, plus the marker set `dialogueExamples`, `chatHistory`, `worldInfoAfter`, `worldInfoBefore`, `charDescription`, `charPersonality`, `scenario`, `personaDescription`. Everything else is a UUID.

`marker: true` prompts must be treated as **engine-supplied slots** — their `content` on disk is meaningless and must not be substituted.

### 4.3 `prompt_order[]` and the `100001` sentinel

```jsonc
"prompt_order": [
  { "character_id": 100000, "order": [ { "identifier": "…", "enabled": true }, … ] },
  { "character_id": 100001, "order": [ { "identifier": "…", "enabled": true }, … ] }
]
```

`order[]` elements carry exactly `{identifier: string, enabled: boolean}`.

**Two sentinels; only one is live.**

- **`100001` is the active one.** `setupChatCompletionPromptManager()` passes `promptOrder: { strategy: 'global', dummyId: 100001 }` — `public/scripts/openai.js:696`. `PromptManager.render()` then does `if ('global' === strategy) this.activeCharacter = { id: this.configuration.promptOrder.dummyId }` (`PromptManager.js:438`), and every subsequent lookup (`:641`, `:1011`, `:1132`, `:1153`, `:1168`, `:1853`) resolves against it.
- **`100000` is dead data.** It is the base-class default at `PromptManager.js:336`, overwritten by the chat-completion config. Legacy presets carry a vestigial ~11-entry `100000` list that nothing reads.

**Kotatsu rule:** resolve `character_id === 100001`; **read and preserve `100000` verbatim, never author it.** Dropping it on re-save would make Kotatsu-written presets diverge from ST-written ones for no gain.

`strategy: 'character'` (real character indices) exists in `PromptManager` but is not used by the chat-completion manager.

### 4.4 What `PresetManager` strips

`PresetManager.getPresetSettings(name)` applies a `filteredKeys` blacklist (`public/scripts/preset-manager.js:676+`) before writing — `api_server`, `preset`, `streaming`, `truncation_length`, `n`, `seed`, `bypass_status_check`, `custom_model`, `openrouter_model`, `openrouter_providers`, `openrouter_quantizations`, `openrouter_allow_fallbacks`, the per-backend `*_model` keys, `enabled`, `bind_to_context`, `derived`, and the reasoning runtime flags `auto_parse` / `add_to_prompts` / `auto_expand` / `show_hidden` / `max_additions`, among others. For non-Advanced-Formatting, non-`openai` APIs it appends `genamt` and `max_length`.

`getPresetSettingsByAPI(apiId, directories)` (`src/endpoints/presets.js:16-38`) is the canonical apiId → folder map (extension always `.json`): `kobold`/`koboldhorde` → `KoboldAI Settings`, `novel` → `NovelAI Settings`, `textgenerationwebui` → `TextGen Settings`, `openai` → `OpenAI Settings`, `instruct` → `instruct`, `context` → `context`, `sysprompt` → `sysprompt`, `reasoning` → `reasoning`; anything else → HTTP 400.

`POST /api/presets/save` sanitizes the name and writes with `writeFileAtomicSync`, 4-space JSON.

### 4.5 Acceptance fixtures

Two presets are the regression gate for the prompt pipeline (per `CLAUDE.md`). The canonical
copies are tracked in **`tests/fixtures/presets/`** (moved 2026-10-01 out of the gitignored
`data/default-user/OpenAI Settings/`, where dev use had silently replaced one). Both carry empty
`reverse_proxy` / `proxy_password`, and a test keeps it that way:

- **`Clio's Sparkle Sauce v1.json`** — 94 prompts; `prompt_order` = `100000`/11 + `100001`/93.
- **`Marinara's Spaghetti Recipe 10.json`** — 80 prompts; `prompt_order` = `100000`/11 + `100001`/79.

**Acceptance criterion:** both must load, drive a generation, and re-save **byte-identically
modulo the pinned unknown-key ledger** through Kotatsu's prompt pipeline. Byte-identical means:
same declared keys (102), same order, same `prompt_order` including the dead `100000` block,
same free-form `extensions` bag, 4-space indent. The single sanctioned delta is the ledger of
§4.1 (`cometapi_model` today — a stock ST of this baseline drops it identically); the ledger is
a tested set, and any growth or shrink of it is a red test, not a judgment call. Anything less
is a contract break, not a nitpick.

---

## 5. `settings.json` and `secrets.json`

### 5.1 The 24 top-level keys

`settings.json` is a verbatim dump of the `payload` object built in `saveSettings()` — `public/script.js:8371`, payload literal at `:8389-8414`:

| # | Key | Shape |
|---|---|---|
| 1 | `firstRun` | boolean — onboarding gate |
| 2 | `accountStorage` | object — `accountStorage.getState()`; a flat `Record<string,string>` server-persisted localStorage replacement. **All values are strings, including booleans.** |
| 3 | `currentVersion` | string — migration gating |
| 4 | `username` | string — `name1` |
| 5 | `active_character` | string — avatar filename |
| 6 | `active_group` | null \| string — mutually exclusive with the above |
| 7 | `user_avatar` | string — current persona avatar filename |
| 8 | `amount_gen` | number |
| 9 | `max_context` | number |
| 10 | `main_api` | string — `openai` \| `textgenerationwebui` \| `kobold` \| `novel` \| `koboldhorde` |
| 11 | `world_info_settings` | object — `getWorldInfoSettings()`; note `world_info` is **nested inside** as `{globalSelect[], charLore[]}` |
| 12 | `textgenerationwebui_settings` | object — `public/scripts/textgen-settings.js` |
| 13 | `swipes` | boolean |
| 14 | `horde_settings` | object |
| 15 | `power_user` | object — the big one; see §5.3 |
| 16 | `extension_settings` | object — per-extension namespaces + `disabledExtensions[]` |
| 17 | `tags` | array — `{id, name, color, color2}` |
| 18 | `tag_map` | object — `Record<entityKey, tagId[]>`, entityKey = avatar filename or group id |
| 19 | `nai_settings` | object |
| 20 | `kai_settings` | object |
| 21 | `oai_settings` | object — full `default_settings` shape (`openai.js:408-515`), a **superset** of a preset file |
| 22 | `background` | object — `{name, url, fitting, animation, sortOrder, thumbnailColumns}` |
| 23 | `proxies` | array — `[{name, url, password}]`, **plaintext passwords** |
| 24 | `selected_proxy` | object — `{name, url, password}`, **plaintext password** |

### 5.2 Atomic blob rule, and unknown-field passthrough

`POST /api/settings/save` — `src/endpoints/settings.js:206-216`:

```js
const pathToSettings = path.join(request.user.directories.root, SETTINGS_FILE);
writeFileAtomicSync(pathToSettings, JSON.stringify(request.body, null, 4), 'utf8');
triggerAutoSave(request.user.profile.handle);
```

Three properties, all contractual:

1. **Atomic** — `write-file-atomic`, temp file + rename. Never a partial `settings.json`.
2. **Whole-blob** — the server writes `request.body` unexamined. There is no server-side schema, no key allowlist, no merge. Whatever the client sends *is* the file. A Kotatsu endpoint that patches one key must read-modify-write the entire object.
3. **Unknown fields pass through — per lane, not universally** (corrected 2026-08-25; the earlier text wrongly listed `oai_settings` here, contradicting this document's own §4 load-side note and `tests/preset-byte-identity.test.js`). The server never inspects the body, so survival is decided by which *client* object serializes. **SURVIVE lanes** (loaded stored-onto-defaults or round-tripped as live references — unknown keys persist forever): `power_user` (`power-user.js:1645` `Object.assign`), `extension_settings` (`extensions.js:1785`), `textgenerationwebui_settings` (`textgen-settings.js:556`), `horde_settings` (`horde.js:319`), `accountStorage` (`AccountStorage.js:71`), `tags` / `tag_map` / `proxies`. **DIE lanes** (memory rebuilt by iterating a defaults/literal key list — unknown stored keys never enter memory and vanish on the next save): `oai_settings` (fill loop `openai.js:4267`), `nai_settings`, `kai_settings`, `background`, and `world_info_settings` (worst shape — rebuilt on save from a 14-key literal, `world-info.js:795-812`, unfixable from the load side). An extension that stores `extension_settings.myThing` gets it persisted with zero registration; a new Kotatsu setting must live in a SURVIVE lane, never a DIE lane. **Kotatsu must not add server-side validation or key-stripping to this endpoint.** Doing so would silently delete every third-party namespace on the first save. Full mechanics + hazards H1–H9: `docs/settings-recon-persistence.md`.

`triggerAutoSave` drives the rotation: `backupUserSettings(handle, preventDuplicates)` (`settings.js:136`) on a 10-minute throttle (`AUTOSAVE_INTERVAL`, `settings.js:23`), duplicate-suppressed by byte comparison, writing `backups/settings_<handle>_<ts>.json`. Snapshot routes: `/get-snapshots` (`:298`), `/load-snapshot` (`:316`), `/make-snapshot` (`:340`), `/restore-snapshot` (`:350`).

**The boot envelope.** `POST /api/settings/get` (`settings.js:219`) returns one fat payload (`:268-296`): `settings` (a **raw JSON string**, parsed client-side), `koboldai_settings`/`koboldai_setting_names`, `novelai_settings`/`novelai_setting_names`, `openai_settings`/`openai_setting_names`, `textgenerationwebui_presets`/`textgenerationwebui_preset_names` (also raw strings, via `readPresetsFromDirectory` `:92`), the pre-parsed `themes`, `movingUIPresets`, `quickReplyPresets`, `instruct`, `context`, `sysprompt`, `reasoning` (via `readAndParseFromDirectory` `:54`), `world_names`, and the feature flags `enable_extensions`, `enable_extensions_auto_update`, `enable_accounts`, `request_compression`. This envelope is the boot contract; change its shape and nothing renders.

### 5.3 Where things actually live

Frequently assumed to be top-level, actually nested:

- `personas` and `persona_descriptions` → **inside `power_user`** (`power-user.js:286`, `:288`)
- `instruct`, `context`, `sysprompt`, `reasoning` → **inside `power_user`** (`power-user.js:218`, `:247`, `:267`, `:274`) — these are the *live* copies of the four preset folders
- `movingUI`, `movingUIState`, `movingUIPreset` → **inside `power_user`** (`power-user.js:173-175`)
- `disabledExtensions` → **inside `extension_settings`**
- `world_info` → nested at `world_info_settings.world_info`
- Themes → **not in `settings.json` at all.** Only `power_user.theme`, a name string; bodies are files in `themes/`.

### 5.4 `secrets.json` — schema only

**No secret values were read in producing this document, and none may be read to maintain it.** Schema comes from `src/endpoints/secrets.js` typedefs at `:76-97`:

```ts
SecretValue    = { id: string, value: string, label: string, active: boolean }
SecretKeys     = { [key: string]: SecretValue[] }        // the on-disk shape
FlatSecretKeys = { [key: string]: string }               // legacy pre-1.18, migrated away
SecretStateMap = Record<string, SecretState[] | null>    // what /view returns, values masked
```

So the file is `{ "<secret_id>": SecretValue[] }` — **an array per key, supporting multiple stored credentials with one marked `active`**, not a flat string map. Filename constant `SECRETS_FILE = 'secrets.json'` (`secrets.js:8`). Key ids come from `SECRET_KEYS` (`secrets.js:9-73`, ~62 entries, mostly `api_key_*`). `_MIGRATED: '_migrated'` (`secrets.js:10`) is the sentinel marking a completed flat→array migration; the migration runs when `!secrets[_MIGRATED] && values.length && !values.some(Array.isArray)` (`secrets.js:391`) and writes `migratedSecrets[_MIGRATED] = []` (`:410`). Writes go through `SecretManager._writeSecretsFile` (`:149`) → `writeFileAtomicSync`.

**Kotatsu rules for secrets:** support both shapes on read (legacy flat is still reachable), write only the array shape, never log or echo a `value`, never include `secrets.json` in any export or artifact. The full-profile backup already excludes it unless `allowKeysExposure` (`src/users.js:1174`) — keep that exclusion.

> **Credential surface beyond `secrets.json`:** `settings.json → proxies[]` / `selected_proxy` (plaintext passwords), `extension_settings.apiKey`, and chat-completion presets' `reverse_proxy` / `proxy_password`. Any "share your config" feature must account for all four.

---

## 6. World info, personas, QuickReplies, themes, movingUI

### 6.1 World info entries — `worlds/*.json`

Authoritative definition: `newWorldInfoEntryDefinition` at `public/scripts/world-info.js:4082-4125` — a `{key: {default, type, excludeFromTemplate?, arrayFilter?}}` map with **42 keys**. The serialized template is derived at `:4127`:

```js
export const newWorldInfoEntryTemplate = Object.fromEntries(
    Object.entries(newWorldInfoEntryDefinition)
        .filter(([_, v]) => !v.excludeFromTemplate)
        .map(([k, v]) => [k, v.default]));
```

Three keys carry `excludeFromTemplate: true` and are **never serialized** — `characterFilterNames`, `characterFilterTags`, `characterFilterExclude` (slash-command-only virtual fields that proxy into `entry.characterFilter`). That leaves **39 serialized keys**.

Top level of a world file: `entries` is an **object keyed by stringified uid**, not an array — `{"0": {...}, "1": {...}}`. Optional siblings on imported or character-embedded books: `name`, `description`, `scan_depth`, `token_budget`, `recursive_scanning`, `extensions`, `is_creation`, and `originalData` (a verbatim V2 character-book kept for lossless export).

Entry fields (defaults in parentheses): `key[]`, `keysecondary[]`, `comment`, `content`, `constant(false)`, `vectorized(false)`, `selective(**true**)`, `selectiveLogic(0)`, `addMemo(false)`, `order(100)`, `position(0)`, `disable(false)`, `ignoreBudget(false)`, `excludeRecursion(false)`, `preventRecursion(false)`, `matchPersonaDescription`, `matchCharacterDescription`, `matchCharacterPersonality`, `matchCharacterDepthPrompt`, `matchScenario`, `matchCreatorNotes` (all false), `delayUntilRecursion(0)`, `probability(100)`, `useProbability(true)`, `depth(4)`, `outletName('')`, `group('')`, `groupOverride(false)`, `groupWeight(100)`, `scanDepth(null)`, `caseSensitive(null)`, `matchWholeWords(null)`, `useGroupScoring(null)`, `automationId('')`, `role(0)`, `sticky(null)`, `cooldown(null)`, `delay(null)`, `triggers([])`. Plus `uid` (assigned by `createWorldInfoEntry`), `displayIndex` (added by the sort/UI layer, not in the definition map), and `characterFilter` (`{isExclude, names[], tags[]}`, built lazily).

Two type traps that a strict parser breaks on:

1. **`delayUntilRecursion` is a `number`** (a recursion-level threshold) despite the name, and older entries on disk hold a `boolean`. Coerce.
2. **Unconverted V2 character-book files exist in the wild** in `worlds/` — entries carrying modern (`uid`) *and* legacy (`keys`, `secondary_keys`, `enabled`, `case_sensitive`, `insertion_order`, `priority`, `extensions`, `id`, `name`) fields side by side, with legacy `extensions` sub-keys `addMemo`, `characterFilter`, `depth`, `displayIndex`, `excludeRecursion`, `useProbability`, `weight`. **Prefer `uid`/`key`/`keysecondary`; treat the snake_case set as fallback.**

Unknown fields on an entry are guarded rather than dropped: `world-info.js:1270` and `:1389` check `Object.hasOwn(newWorldInfoEntryDefinition, field)` before touching a field, so unrecognized keys are left alone by the editors.

Server: `src/endpoints/worldinfo.js` — `readWorldInfoFile`, `/list`, `/get`, `/delete`, `/import` (no format detection; validates only that `'entries' in worldContent`), `/edit`.

### 6.2 Personas

Not a folder of their own — the images are in `User Avatars/`, the metadata is in `power_user`:

- `power_user.personas` = `Record<avatarFilename, displayName>` (`power-user.js:286`)
- `power_user.persona_descriptions` = `Record<avatarFilename, {description, position}>` (`power-user.js:288`)
- Currently selected persona = top-level `settings.json → user_avatar`
- Sibling knobs: `default_persona`, `persona_description`, `persona_description_position`, `persona_description_role`, `persona_description_depth`, `persona_description_lorebook`, `persona_show_notifications`, `persona_sort_order`

The **avatar filename is the primary key**. Renaming a file in `User Avatars/` orphans both maps and every `force_avatar` reference in every chat. Thumbnails regenerate into `thumbnails/persona/`.

### 6.3 QuickReplies — `QuickReplies/*.json`

Server: `src/endpoints/quick-replies.js:10-19` — `sanitize(name)`, `writeFileAtomicSync`, 4-space JSON. Written by `QuickReplySet.performSave()` (`public/scripts/extensions/quick-reply/src/QuickReplySet.js:376-389`) as `JSON.stringify(this)`.

> `JSON.stringify(this)` does **not** mean "the whole object" — the class defines `toJSON()` at `QuickReplySet.js:362-373`, an explicit **9-key whitelist**:

```jsonc
{
  "version": 2, "name": "…",
  "disableSend": false, "placeBeforeInput": false, "injectInput": false,
  "color": "transparent", "onlyBorderColor": false,
  "idIndex": 3,
  "qrList": [ … ]
}
```

`scope` (`'global'|'chat'|'character'`) and `isDeleted` are declared on the class (`QuickReplySet.js:30-40`) but **excluded by `toJSON`** — they are runtime state, not file state. **This format does not pass unknown fields through.** A Kotatsu addition to a QR set that is not added to `toJSON()` is silently lost on save.

Item fields (`QuickReply.js:29-48`): `id`, `icon`, `label`, `showLabel`, `title`, `message` (STscript), `contextList[]` (`QuickReplyContextLink` = `{set, isChained}`), `preventAutoExecute`, `isHidden`, `executeOnStartup`, `executeOnUser`, `executeOnAi`, `executeOnChatChange`, `executeOnGroupMemberDraft`, `executeOnNewChat`, `executeBeforeGeneration`, `automationId`.

### 6.4 Themes — `themes/*.json`

Server: `src/endpoints/themes.js:10-19` (`/save`), `:21+` (`/delete`) — `sanitize(name)`, `writeFileAtomicSync`, 4-space JSON.

The body is produced by `getThemeObject(name)` — `public/scripts/power-user.js:2535-2577` — **exactly 39 keys**, `name` plus 38 mirrors of the theme slice of `power_user`:

`name`, `blur_strength`, `main_text_color`, `italics_text_color`, `underline_text_color`, `quote_text_color`, `blur_tint_color`, `chat_tint_color`, `user_mes_blur_tint_color`, `bot_mes_blur_tint_color`, `shadow_color`, `shadow_width`, `border_color`, `font_scale`, `fast_ui_mode`, `waifuMode`, `avatar_style`, `chat_display`, `toastr_position`, `noShadows`, `chat_width`, `timer_enabled`, `timestamps_enabled`, `timestamp_model_icon`, `mesIDDisplay_enabled`, `hideChatAvatars_enabled`, `message_token_count_enabled`, `expand_message_actions`, `enableZenSliders`, `enableLabMode`, `hotswap_enabled`, **`custom_css`**, `bogus_folders`, `zoomed_avatar_magnification`, `reduced_motion`, `compact_input_area`, `show_swipe_num_all_messages`, `click_to_edit`, `media_display`.

`custom_css` is arbitrary user CSS shipped inside the theme file and injected wholesale (`power-user.js:1157`). `@import` in `custom_css` is detected and handled specially on import (`power-user.js:2459`). Kotatsu themes (Blue Hour, Sparkle) ship through this same 39-key file — no new top-level theme format.

> **Unknown keys are dropped.** `getNewTheme(parsed)` (`power-user.js:2585-2593`) starts from `getThemeObject()` and copies across only keys satisfying `Object.hasOwn(theme, key)`. A theme file with extra keys loses them on import. This is the third format (with presets and QuickReplies) that does **not** pass unknowns through.

> **Type hazard:** `enableZenSliders`, `enableLabMode`, `zoomed_avatar_magnification`, `show_swipe_num_all_messages` appear as **`boolean | string`** across real theme files — older themes stored `"false"` as a string. A strict parser breaks on stock data. Coerce, do not assert.

### 6.5 MovingUI — `movingUI/*.json`

Server: `src/endpoints/moving-ui.js:8-19`. Body built at `power-user.js:2604-2607`:

```jsonc
{ "name": "…", "movingUIState": { "<panelId>": { "top": n, "left": n, "width": n, "height": n, "margin": "" } } }
```

Live state lives in `power_user.movingUI`, `power_user.movingUIState`, `power_user.movingUIPreset` (`power-user.js:173-175`).

> **The MovingUI *feature* is scheduled for removal in Kotatsu** (`CLAUDE.md`). **Its data is not.** The `movingUI/` folder, the `/api/moving-ui/*` routes, and the three `power_user` keys stay in the contract and **pass through untouched**: read them, round-trip them, write them back unchanged, do not migrate them, do not delete the files. A profile that visits Kotatsu and returns to stock ST must find its panel layouts intact. Removing the feature means removing the *UI that edits them* and the drag runtime — not the bytes.
>
> Same posture applies to `movingUIPresets` in the boot envelope (`settings.js:280`): keep serving the array even when nothing consumes it, or stock ST's own hydration breaks on a shared profile.

---

## 7. Kotatsu additions policy

Kotatsu will want state that ST has no slot for — branch graphs, search indices, render caches, per-chat UI state. The rule:

> **Kotatsu-owned on-disk state lives in dotfolders, is invisible to ST's `.jsonl`-filtered listings, and is always rebuildable from the `.jsonl` files. Deleting a dotfolder must never lose a message.**

### 7.1 Where it goes

Chat-scoped state → `chats/<charName>/.kotatsu/`. Profile-scoped state → a `.kotatsu/` dotfolder under the profile root. Never a new top-level key in `USER_DIRECTORY_TEMPLATE`, never a new sibling folder in the profile root, never a new top-level key in `settings.json`.

### 7.2 Why dotfolders are actually invisible — verified

Every core enumerator of chat data filters on `.jsonl`, and most also require `isFile()`:

| Consumer | Filter | `file:line` |
|---|---|---|
| Chat search | `path.extname(file) === '.jsonl'` | `src/endpoints/chats.js:919` |
| All-chats scan | `chatFiles.filter(file => path.extname(file) === '.jsonl')` | `src/endpoints/chats.js:1000` |
| Root chat files | `e.isFile() && path.extname(e.name) === '.jsonl'` | `src/endpoints/chats.js:1040` |
| Character chat list | `file.isFile() && path.extname(file.name) === '.jsonl'` | `src/endpoints/characters.js:1509` |
| Data-maid orphan sweep | `file.isFile() && path.parse(file.name).ext === '.jsonl'` | `src/endpoints/data-maid.js:340, 385` |
| Data-maid message sweep | same | `src/endpoints/data-maid.js:538, 549` |
| Data-maid metadata sweep | same | `src/endpoints/data-maid.js:597, 611` |

A directory named `.kotatsu` fails `isFile()` and its extension is `.kotatsu`, not `.jsonl`. It is invisible to chat listings, to search, and to the data-maid cleanup pass — so Kotatsu state will not show up as a phantom chat and will not be swept as an orphan.

**Caveat, deliberate:** the full-profile backup ZIP globs `**/*` **including dotfiles** (`src/users.js:1148-1174`). Kotatsu dotfolders therefore ride along in backups. That is acceptable — they are derived data and restore harmlessly — but it means **nothing sensitive goes in a dotfolder**. Secrets stay in `secrets.json`, which the archive excludes.

### 7.3 The rebuildability requirement

Every dotfolder must ship a rebuild path, and the rebuild must be exercised, not merely intended:

- The `.jsonl` files are the **sole source of truth**. A dotfolder is a cache or an index, never a store of record.
- `rm -rf chats/<char>/.kotatsu/` followed by a restart must produce a fully functional Kotatsu with zero message loss and zero user-visible data loss. Anything that fails that test does not belong in a dotfolder — it belongs in `chat_metadata` or `extra` (which stock ST preserves), or it does not belong on disk.
- Branch graphs are the motivating case and the test case: the graph is *derivable* from `chat_metadata.main_chat` + `extra.branches[]` + `extra.bookmark_link` across the folder's `.jsonl` files (§2.8). Kotatsu may cache a richer, faster graph; it must be able to regenerate it from those three fields alone.
- Staleness is Kotatsu's problem, not the user's. A dotfolder must carry enough provenance (source mtimes, sizes, or hashes) to detect that the underlying `.jsonl` changed underneath it — including changes made by **stock ST**, which will happily edit these files while Kotatsu is not running. Assume the `.jsonl` files mutate behind your back between every launch.
- Corruption is not fatal: an unparseable dotfolder is discarded and rebuilt, never surfaced as an error and never allowed to block a chat from opening.

### 7.4 What must never happen

- No new keys inside a chat `.jsonl` header beyond `chat_metadata` (the index signature at `global.d.ts:58-64` is the sanctioned extension point; use `chat_metadata.kotatsu` if in-file state is genuinely required and must survive a dotfolder wipe).
- No renaming or reformatting of any file listed in §1.
- No server-side validation added to `/api/settings/save` (§5.2).
- No `.jsonl` writes that bypass `trySaveChat` and its `integrity` check (§2.4).
- No writes into `data/` of the live install (`CLAUDE.md`, hard rules).

---

## 8. Import formats and deprecated surfaces

### 8.1 Character import — kept

`POST /api/characters/import` (`src/endpoints/characters.js:1558`). **No content sniffing**: the client sends `file_type` and the server looks it up in the literal dispatch table `formatImportFunctions` (`characters.js:1565-1572`); an unknown key throws `Unsupported format`.

| `file_type` | Handler | `file:line` |
|---|---|---|
| `png` | `importFromPng` — reads tEXt, branches on `jsonData.spec` (V2/V3) vs `jsonData.name` (V1) | `characters.js:968` |
| `json` | `importFromJson` — three sub-formats: `spec` → V2/V3, `name` → V1, `char_name` → Pygmalion/gradio | `characters.js:883` |
| `yaml` / `yml` | `importFromYaml` — TavernAI-style `context`/`greeting` → `convertToV2` | `characters.js:731` |
| `charx` | `importFromCharX` → `CharXParser` (`src/charx.js`) | `characters.js:765` |
| `byaf` | `importFromByaf` → `ByafParser` (`src/byaf.js`); also creates chats, backgrounds, alt icons | `characters.js:803` |

Export (`POST /api/characters/export`) supports **only** `png` and `json`. No CharX or BYAF export exists; do not imply one.

### 8.2 Chat import — kept

`POST /api/chats/import` (`src/endpoints/chats.js:696`).

`format === 'json'` → sniffing chain at `chats.js:725-738`:

| Predicate | Source | Converter |
|---|---|---|
| `jsonData.savedsettings !== undefined` | KoboldAI Lite | `importKoboldLiteChat` (`chats.js:215`) |
| `jsonData.histories !== undefined` | CharacterAI (CAI Tools dump) | `importCAIChat` (`chats.js:180`) |
| `Array.isArray(jsonData.data_visible)` | oobabooga | `importOobaChat` (`chats.js:110`) |
| `Array.isArray(jsonData.messages)` | Agnai | `importAgnaiChat` (`chats.js:151`) |
| `jsonData.type === 'risuChat'` | RisuAI | `importRisuChat` (`chats.js:288`) |
| else | — | `{error: true}` |

`format === 'jsonl'` (`chats.js:758`) → native ST. Validates that line 0 carries one of `user_name` / `name` / `chat_metadata` (`:764`), then always attempts `flattenChubChat` (`chats.js:258`) to normalize Chub Chat's nested `mes.message` / `swipes[].message` shape, falling back to a raw `copyFileSync`. TavernAI is not a separate branch — legacy TavernAI chats ride the jsonl path.

Group chat import (`POST /api/chats/group/import`, `chats.js:676`) does **no** format detection — verbatim `copyFileSync` into `group chats/<humanizedDateTime()>.jsonl`.

Export (`POST /api/chats/export`, `chats.js:604`): `jsonl` = raw passthrough; anything else (effectively `txt`) streams through `readline`, skips `is_system` messages, and emits `${name}: ${message}\n\n` using `extra.display_text ?? mes`.

> **Live upstream bug, inherited by this clone — `src/endpoints/chats.js:204`:**
> ```js
> const newChats = (jsonData.histories.histories ?? []).map(history =>
>     newChats.push(convert(history).map(obj => JSON.stringify(obj)).join('\n')));
> ```
> The callback dereferences `newChats` while the `const` is still in its temporal dead zone, so any non-empty CAI dump throws `ReferenceError`, swallowed by the route's try/catch into a generic `{error: true}`. An empty array silently yields `[]`. **CharacterAI dumps cannot be imported today.** Fixing it changes no on-disk format and is a free correctness win.

### 8.3 World info import — kept

Server `POST /api/worldinfo/import` (`src/endpoints/worldinfo.js`) does **no** format detection: it stores the uploaded file verbatim or the client-supplied `convertedData`, validating only `'entries' in worldContent`. All foreign-format detection is **client-side** in `importWorldInfo` (`public/scripts/world-info.js`): `.png` → `extractDataFromPng(buffer,'naidata')`; `lorebookVersion` → NovelAI (`convertNovelLorebook`); `kind === 'memory'` → Agnai (`convertAgnaiMemoryBook`); `type === 'risu'` → RisuAI (`convertRisuLorebook`); otherwise native passthrough. Export is client-only — there is no export endpoint.

Card ↔ world bridging: `importEmbeddedWorldInfo` → `convertCharacterBook` inbound (stashing the original under `originalData`), `convertWorldInfoToCharacterBook` (`characters.js:663`) outbound.

### 8.4 Preset import/export — kept

`src/endpoints/presets.js`: `/save` (sanitize + atomic + 4-space JSON), `/delete`, `/restore` (**never touches disk** — looks the name up in the bundled defaults and returns `{isDefault, preset}`; a user-authored name returns `{isDefault:false, preset:{}}`). Folder resolution via `getPresetSettingsByAPI` (`presets.js:16-38`, §4.4).

Client: per-manager export/import, plus the Advanced Formatting master bundle (`performMasterImport` / `performMasterExport`, filename `ST-formatting-<YYYY-MM-DD>.json`) with legacy single-template sniffers.

### 8.5 Deprecated surfaces — endpoints stay, UI goes

The **marketplace front doors** are the deprecation target. Removing the UI is a product decision; removing the endpoints would break the data contract, because they are the ingest path for content already on disk and because installed extensions call them.

| Surface | UI removed | Endpoint / mechanism retained |
|---|---|---|
| Assets marketplace browser | `public/scripts/extensions/assets/market.html`, `installation.html`, `character.html`, `window.html` and the `ASSETS_JSON_URL` remote index browser (`assets/index.js:19`) | `src/endpoints/assets.js` `/get`, `/download`, `/delete`, `/character` stay. `assets/` and its seven category subdirs stay in the template (§1 #24). Local assets keep loading. |
| Extension marketplace / remote install-by-URL front door | The browse-and-discover panel | `src/endpoints/extensions.js` install/update/branches/switch/move/version/delete/discover stay — extension management is `CONTRACT.md` territory, not a marketplace |
| Character-site import front doors (Chub, JanitorAI, Pygmalion, AICharacterCards, RisuRealm, Perchance, whitelist) | The URL/UUID import dialog as a discovery surface | `POST /api/content/importURL` (`content-manager.js:978`) and `POST /api/content/importUUID` (`:1071`) stay, host dispatch via `getHostFromUrl` (`:958`) intact. Non-whitelisted hosts 404 as today. |
| Data Bank scrapers (web, Fandom, MediaWiki, YouTube) | Scraper picker | `src/endpoints/files.js` and `registerDataBankScraper` stay |

Also deprecatable **as behavior, never as bytes** (read-and-ignore; never write):

- `create_date` in chat headers — not written since pre-1.1x
- `user_name` / `character_name` header literals — hard-coded `'unused'`, but **must still be written** for stock-ST back-compat
- `prompt_order` entries with `character_id: 100000` — dead in every preset, but preserved on round-trip (§4.3)
- Legacy `extra.image` / `extra.video` / `extra.image_swipes` / `extra.file` / `extra.title`+`append_title` — keep the one-way migration to `media[]`/`files[]`, drop the write path
- Group `chat_metadata` / `past_metadata` — actively stripped by 1.18.0's `warnOnGroupMetadata`; keep the migration for old folders, never reintroduce the keys
- Removed preset keys (`wrap_in_quotes`, `api_url_scale`, `use_alt_scale`, `windowai_model`, `zerooneai_model`, and the pre-rename sysprompt/inlining spellings) — keep only the migration map
- Extras API module gating (`requires` / `optional`, `extension_settings.apiUrl`) — keep the manifest fields parsed-and-ignored so third-party manifests still load

`vectors/`, `user/files/`, and `assets/` are commonly empty in real profiles. They remain **mandatory folders in the template** regardless of population; "unused" is not "removable".

---

## 9. Where the map and the code disagree

Recorded so the next reader does not re-derive them. In every case **the clone's code is authoritative** and this document follows it.

| # | Map claim | Code | Impact |
|---|---|---|---|
| 1 | "`USER_DIRECTORY_TEMPLATE` — all **30 keys**" | **31 keys**, 30 of which name a subdirectory; `root: ''` is the 31st (`src/constants.js:16-48`) | Cosmetic, but a template-completeness test written to "30" would pass while missing a key |
| 2 | A freshly-saved preset has **100 keys** | **103 keys** in `settingsToUpdate` (`openai.js:303-407`), counted programmatically | Material. Any preset round-trip test hard-coding 100 fails. The map was written against the live install, which is not this commit |
| 3 | Branch = "**file copy** + `chat_metadata.main_chat` + `extra.branches[]`" | **No file copy.** `createBranch` (`bookmarks.js:186-243`) builds `structuredClone(chat.slice(0, mesId+1))` via `getBranchChatSnapshot` (`:171-183`) and writes a new file through `saveChat({chatData})` (`:232`). Metadata is `{...chat_metadata, ...{main_chat}}` (`script.js:7380`), so `integrity` is inherited too | Material. A "copy the file" implementation would preserve bytes a real branch does not, and would miss the swipe-selection step (`syncSwipeToMes`, `:177`) |
| 4 | Chat line-0 rule stated flatly as "header only if it has `chat_metadata`" | True for the group reader (`group-chats.js:272`) and both server heuristics (`chats.js:394-396`, `:764`) — **false for the character-chat reader**, which shifts unconditionally (`script.js:7630-7631`) | Material and dangerous. This is the mechanism by which a headerless character chat loses its first message permanently. §2.2 |
| 5 | QuickReplies file = "`JSON.stringify(this)` — the file *is* the class's own-enumerable fields"; `scope`/`isDeleted` "absent from this file" | `toJSON()` (`QuickReplySet.js:362-373`) is an explicit **9-key whitelist**. `scope` and `isDeleted` are excluded by construction, not absent by accident | Material. Explains *why* QR does not pass unknown fields through, and warns that a new field needs a `toJSON` edit |
| 6 | Themes described as a 39-key union with a `boolean\|string` coercion hazard | 39 keys confirmed (`getThemeObject`, `power-user.js:2535-2577`). The map omits that `getNewTheme` (`:2585-2593`) **drops unknown keys** via `Object.hasOwn` | Additive. Themes are the third non-passthrough format |
| 7 | Character-card `write()` writes dual `chara` + `ccv3` chunks | Confirmed (`character-card-parser.js:15-46`), **but the function's own JSDoc at `:10` says the opposite** ("Writes only 'chara', 'ccv3' is not supported") | Trap. A future contributor "fixing" the code to match its comment would break V3 compatibility |
| 8 | CharacterAI import is dead code (TDZ `ReferenceError`) | Confirmed live in this clone at `chats.js:204` | Map correct; recorded here because it is a free fix that costs no format change |

**Open ambiguities** — not resolved by code reading, flagged for a decision:

1. **Branch `integrity` inheritance.** A new branch inherits the parent's `integrity` slug because `saveChat` spreads the parent's `chat_metadata` (`script.js:7380`) and nothing re-mints it. Two chats then share a slug until one is reloaded and `getChat` finds it present (`:7639`, which only mints when *absent*). Whether ST intends this or it is an oversight is not determinable from the code. Kotatsu should decide explicitly; minting a fresh slug on branch creation is a behavior change, not a format change.
2. **Trailing newline.** Writers use `join('\n')` (`chats.js:458`), so files end without a newline. Readers `split('\n')` and drop empties (`:503-513`), so a trailing newline is harmless on read. Files edited by external tools will commonly have one. Kotatsu should tolerate it and match the no-trailing-newline convention on write, but the two are not interchangeable for byte-identity tests.
3. **`extra.branches[]` / `main_chat` are names, not ids.** Renaming a chat orphans the lineage and nothing in the codebase repairs it. Whether Kotatsu should heal these links (and thereby write to files stock ST considers stable) is a product decision, not a contract one.
4. **`character_id: 100000` write policy.** §4.3 mandates preserving it on files that have it. Whether a *newly authored* Kotatsu preset should emit an empty `100000` block for maximal diff-similarity with ST-written files is undecided; this document's position is "read and preserve, never author".
