# Kotatsu — Extension Compatibility Contract

**Status:** frozen surface, v1
**Baseline:** SillyTavern `staging` @ `1ca70787f` (upstream 1.18.0), cloned into Kotatsu.
**Verified against:** this repo's working tree, and (read-only) the installed extension set at
a stock SillyTavern install — 8 global third-party
extensions + 4 local (per-user) extensions, 125 `.js` files scanned.

**Frozen totals:** 26 DOM IDs · 146 `getContext()` keys · 104 event keys (103 distinct values) ·
15 core module paths · 8 `/api/extensions/*` routes + the server-plugin router contract.

**NemoPresetExt demotion (2026-08-23).** NemoPresetExt was dropped by decision on 2026-08-23
(unused lately; recorded in the internal design notes) and will not be installed in Kotatsu, so
surface that existed *only* because Nemo touched it is not frozen: 33 DOM IDs and 4 module paths
moved to Appendix A, which keeps them documented and watched rather than promised. Anything Nemo
shared with another installed extension stays frozen on that other extension's account.
`getContext()` keys and event names are core surface, not per-extension, and stay fully frozen.

---

## 0. What this document is

This is the list of things Kotatsu **promises not to break**. Everything enumerated below is
load-bearing for at least one extension in active use. The fork may rewrite, restyle,
re-architect, or replace anything *not* on this list, but each item here is a public API of the
shell: it keeps its **name**, its **shape**, and its **reachability** for as long as the contract
is at v1.

Three rules govern it:

1. **Additive is always allowed.** New DOM IDs, new `getContext()` keys, new events, new exports,
   new routes — free. Nothing here caps growth.
2. **Removal, rename, or relocation-out-of-reach requires a spec change.** Not a commit message,
   not a "nobody uses it" grep — an explicit revision of this file, with the breakage named and
   accepted. Silent breakage is the failure mode this document exists to prevent: five of the
   seven remaining global extensions carry `auto_update: true`, so a fork that quietly changes an API they
   consume gets silently re-broken on every extension update, forever.
3. **The lists are grep-able on purpose.** Every section below can be re-derived mechanically
   from source. See §7 — Enforcement. A CI check that re-runs those commands and diffs against
   this file is the intended enforcement mechanism; until it exists, the commands are the manual
   pre-merge ritual.

**Why these four surfaces and not others.** Extensions reach into the shell through exactly four
doors: the DOM (jQuery/`querySelector` by ID), the `SillyTavern.getContext()` object, the
`eventSource` / `event_types` bus, and ES-module deep imports by relative path. Server plugins add
a fifth (HTTP). Nothing else in the codebase is contractual — it is convention, and convention is
refactorable.

---

## 1. Frozen DOM IDs — 26

**Definition:** the intersection of (a) `#id` selectors referenced by installed third-party
extension JS, **excluding NemoPresetExt**, and (b) `id="…"` attributes declared in core
`public/index.html`. 194 distinct `#id` selectors appear in the surviving extension set (both
tiers); **1,348** IDs are declared in `index.html`; **26** are in both. That intersection is the
contract.

> **Tree drift.** The `1ca70787f` baseline declares 1,351 IDs — the figure in
> `engine-review.md:349`'s table. The current tree declares 1,348: `api_key_cometapi`,
> `cometapi_form`, and `model_cometapi_select` were removed by the in-flight CometAPI provider
> deletion. None of the three is referenced by any installed extension, so the intersection is
> unchanged and no frozen ID was affected. Re-derive after any provider add/remove; the number to
> watch is the intersection, not the declared total.

> **Derivation note.** Including NemoPresetExt the same intersection yields **59** — the figure in
> `engine-review.md:349`, reproduced exactly before the demotion. 33 of those 59 were reachable
> only from Nemo; they are listed in **Appendix A**, not here. The remaining 26 all have at least
> one non-Nemo consumer.

**The promise:** these 26 IDs continue to exist in the live DOM, on an element that plays the same
role, reachable by `document.getElementById()` / `$('#id')` from the top-level document. They may
be **moved** in the tree, restyled, re-parented, wrapped, or re-rendered by different code. They
may **not** be renamed, deleted, duplicated, or hidden inside a shadow root (a shadow boundary is
opaque to `document.getElementById` — that is a break, not a relocation).

Attribution is per-extension over the surviving set. `Moonlit` = SillyTavern-MoonlitEchoesTheme,
`GG` = GuidedGenerations-Extension, `TopBar` = Extension-TopInfoBar, `Timelines` =
SillyTavern-Timelines; `message-metrics` and `neon-kissa` are the local-tier pair (written for this fork).

### 1.1 Chat & send form (8)

```
chat                              GG, Moonlit, Timelines, neon-kissa    the message list container
sheld                             Moonlit                               chat shell wrapper
send_form                         GG, Moonlit                           the send form
form_sheld                        Moonlit                               send-form shell
send_textarea                     GG, Moonlit, noass                    the input textarea
leftSendForm                      Moonlit                               left button cluster
rightSendForm                     Moonlit                               right button cluster
nonQRFormItems                    GG, Moonlit                           non-quick-reply form items
```

### 1.2 Panels, nav & top bar (6)

```
top-bar                           Moonlit
left-nav-panel                    Moonlit
right-nav-panel                   Moonlit
movingDivs                        Moonlit         movable-panel host
options_button                    Moonlit
HotSwapWrapper                    Moonlit         character hot-swap strip
```

### 1.3 Character list & editor (4)

```
rm_print_characters_block         Moonlit
rm_ch_create_block                Moonlit
character_popup                   Moonlit
form_create                       Moonlit         character create/edit form
```

### 1.4 API & extensions panel (4)

```
main_api                          TopBar
extensions_settings               GG, noass                       extensions settings column 1
extensions_settings2              message-metrics, neon-kissa     extensions settings column 2
file_form                         Moonlit
```

### 1.5 World Info (1)

```
WorldInfo                         Moonlit
```

### 1.6 Misc panels (3)

```
floatingPrompt                    Moonlit         author's note float
cfgConfig                         Moonlit
logprobsViewer                    Moonlit
```

> **Local-tier note.** The local tier (`data/default-user/extensions/` — Timelines,
> message-metrics, neon-kissa, voidlit-echoes) contributes 2 shared IDs: `chat` and
> **`extensions_settings2`**. The latter matters: in the global tier `extensions_settings2` was a
> Nemo-only ID, but message-metrics and neon-kissa both target it, so it stays frozen on their
> account. Any freeze computed from the global tier alone would have wrongly demoted it.

> **Not frozen by this section:** classes, `data-` attributes, tag names, nesting depth, and the
> ~168 IDs the surviving extensions reference that do *not* exist in core `index.html` (those are
> the extensions' own DOM). Themes (Moonlit, Voidlit) couple to classes and CSS custom properties
> as well as IDs — that coupling is covered by §6's strangler policy, not by a frozen list, because
> the 168-property CSS token layer is explicitly a *variable* surface. **Exception: the message
> DOM shape, frozen separately as §1.7** (added v2, ahead of the renderer strangle — the one
> place where "classes are not frozen" would have let us break every message-decorating
> extension legally).

### 1.7 Message DOM shape (added v2, 2026-08-24)

**Definition:** the subset of the rendered `.mes` subtree with at least one consumer outside the
renderer itself — core non-renderer modules, bundled extensions, or the surviving third-party set.
Derived consumer-by-consumer in `docs/renderer-v0-recon-abi.md` §2 (the receipts) ahead of the
SPEC target-3 renderer replacement; this section is the freeze, that document is the derivation.

**The promise**, in one paragraph (recon §9): `#chat` keeps its **node identity** from
module-load time and stays in the light DOM — it may be moved, never replaced, re-created, or
shadow-rooted; `.mes` elements stay its **direct children, in ascending `mesid` order**; each
carries `mesid` / `swipeid` / `ch_name` / `is_user` / `is_system` / `bookmark_link` /
`force_avatar` / `timestamp` / `type` as **real HTML attributes** (not `data-*`, not properties;
`bookmark_link` **absent** when unset, never empty — jQuery `removeAttr` semantics) and the
`last_mes` / `selected` / `smallSysMes` / `toolCall` / `swipes_visible` / `last_swipe` / `fade` /
`displayNone` class vocabulary; the interior keeps the `.mesAvatarWrapper` / `.mes_block` /
`.swipeRightBlock` three-way split as **direct children of `.mes`**, with `.mes_edit` a
descendant of `.mes_block` and `.mes_buttons` inside `.ch_name`; `#chat` continues to accept
**foreign non-`.mes` direct children** (`#show_more_messages`, `.style-pins`, the welcome panel);
and `addOneMessage()` returns with its node attached, **synchronously**.

**Frozen interior class names** (each has a named consumer in the recon's tables): `.avatar` (+
its `img`), `.mesIDDisplay`, `.mes_timer`, `.tokenCounterDisplay`, `.ch_name`, `.name_text`,
`.timestamp`, `.mes_buttons`, `.extraMesButtonsHint`, `.extraMesButtons`, the 13 named
`.mes_*` toolbar buttons, `.mes_edit_buttons` + its 7 children, `details.mes_reasoning_details` /
`summary.mes_reasoning_summary` / `.mes_reasoning_header` / `.mes_reasoning_header_title` /
`.mes_reasoning_arrow` / `.mes_reasoning_actions` (+ 6 children) / `.mes_reasoning`,
`.mes_text`, `.mes_media_wrapper`, `.mes_file_wrapper`, `.mes_bias`, `.swipe_left`,
`.swipe_right`, `.swipes-counter`, and the media sub-DOM cloned from the media templates
(`.mes_img_container[data-index]`, `.mes_img`, `.mes_video_container[data-index]`, `.mes_video`,
`.mes_media_container[data-index]`, `.mes_file_container[data-index]`, `.mes_img_caption`,
`.mes_media_enlarge`, `.mes_media_delete`, `.mes_img_swipe_left/right`, `.mes_file_delete`,
`.mes_file_open`, `.mes_audio_container`, `.mes_text.inline_media`).

**Imperative regions** — the renderer never owns their interiors; other parties write into them
after render and that stays legal: `.mes_text` (morphdom during streaming, hljs + `.code-copy`,
the edit textarea `#curEditTextarea`, search `<mark>`s, extension `innerHTML` writes),
`.mes_reasoning` (ReasoningHandler), `.mes_block`'s **child list** (extensions prepend siblings,
e.g. a metrics bar as first child), and the media/file wrappers. Consumer-written attributes on
`.mes` (`data-char-tags`, `data-char-tag-*`, `data-avatar-*`, consumer classes such as
`vectorized`) survive re-renders or are re-derivable by their owners' observers.

**Not frozen even here:** anything in the `.mes` subtree without a consumer in the recon's tables
(the anonymous flex wrappers inside `.ch_name`, exact attribute order, whitespace), additive
attributes and custom properties the renderer itself introduces (e.g. per-message `--k-mes-*`),
and everything §6 already lists. Changes to this section follow §8, with
`docs/renderer-v0-recon-abi.md` re-derived as evidence.

---

## 2. Frozen `getContext()` keys — 146

**Source of truth:** `public/scripts/st-context.js` (311 LOC), the `getContext()` return object.
Reached by extensions as `SillyTavern.getContext()` (global assembled at `public/script.js:293`)
or by importing `getContext` from `/scripts/extensions.js`. **146 top-level keys, verified by
parsing the return object — matches `engine-review.md:359` exactly, zero duplicates.**

**The promise:** every key below stays present on the returned object with a compatible value
type. Functions keep their arity and call contract; objects keep their identity semantics (live
references stay live — `chat`, `characters`, `groups`, `chat_metadata` are the actual arrays/objects,
not copies, and extensions mutate them in place). Keys marked `@deprecated` in source are **still
frozen** — deprecated means "don't use it in new code", not "safe to delete"; old extensions call
them.

### 2.1 Chat & character state (17)

```
chat  characters  groups  name1  name2  characterId  groupId  chatId  chatMetadata
extensionPrompts  streamingProcessor  onlineStatus  maxContext  mainApi  menuType
tags  tagMap
```

### 2.2 Chat mutation & rendering (23)

```
addOneMessage  deleteLastMessage  deleteMessage  updateMessageBlock  printMessages  clearChat
reloadCurrentChat  renameChat  openCharacterChat  openGroupChat  saveChat  saveReply
sendSystemMessage  appendMediaToMessage  ensureMessageMediaIsArray  getMediaDisplay
getMediaIndex  scrollChatToBottom  scrollOnMediaLoad  messageFormatting  messageFormatter
activateSendButtons  deactivateSendButtons
```

### 2.3 Generation (9)

```
generate  generateQuietPrompt  generateRaw  generateRawData  sendStreamingRequest
sendGenerationRequest  stopGeneration  extractMessageFromData  setExtensionPrompt
```

### 2.4 Persistence (8)

```
saveSettingsDebounced  saveMetadata  saveMetadataDebounced  updateChatMetadata
writeExtensionField  writeExtensionFieldBulk  accountStorage  getCurrentChatId
```

### 2.5 Events (3)

```
eventSource  eventTypes  event_types          # event_types = @deprecated snake-case alias
```

### 2.6 Slash commands (9)

```
SlashCommandParser  SlashCommand  SlashCommandArgument  SlashCommandNamedArgument
SlashCommandEnumValue  ARGUMENT_TYPE  executeSlashCommandsWithOptions
registerSlashCommand    # @deprecated
executeSlashCommands    # @deprecated
```

### 2.7 Registration APIs (10)

```
registerFunctionTool  unregisterFunctionTool  isToolCallingSupported  canPerformToolCalls
ToolManager  registerDataBankScraper  registerDebugFunction
registerHelper      # @deprecated no-op stub — MUST remain callable
registerMacro       # @deprecated
unregisterMacro     # @deprecated
```

### 2.8 UI / popups / loader (14)

```
Popup  POPUP_TYPE  POPUP_RESULT  callGenericPopup  loader
renderExtensionTemplateAsync  openThirdPartyExtensionMenu  getThumbnailUrl  isMobile
shouldSendOnEnter
callPopup            # @deprecated
renderExtensionTemplate   # @deprecated
showLoader           # @deprecated
hideLoader           # @deprecated
```

### 2.9 Settings objects (5)

```
extensionSettings  chatCompletionSettings  textCompletionSettings  powerUserSettings
getPresetManager
```

### 2.10 Tokenizers (6)

```
tokenizers  getTextTokens  getTokenCountAsync  getTokenizerModel  getChatCompletionModel
getTokenCount        # @deprecated
```

### 2.11 Characters (10)

```
getCharacters  getOneCharacter  getCharacterCardFields  getCharacterSource
selectCharacterById  createCharacterData  unshallowCharacter  unshallowGroupMembers
importTags  importFromExternalUrl
```

### 2.12 World info (7)

```
loadWorldInfo  saveWorldInfo  reloadWorldInfoEditor  updateWorldInfoList
convertCharacterBook  getWorldInfoPrompt  getWorldInfoNames
```

### 2.13 i18n (4)

```
t  translate  getCurrentLocale  addLocaleData
```

### 2.14 Reasoning (3)

```
updateReasoningUI  parseReasoningFromString  getReasoningTemplateByName
```

### 2.15 Requests & networking (6)

```
getRequestHeaders  CONNECT_API_MAP  getTextGenServer  ChatCompletionService
TextCompletionService  ConnectionManagerRequestService
```

### 2.16 Macros & utilities (8)

```
macros  substituteParams  substituteParamsExtended  timestampToMoment  humanizedDateTime
uuidv4  ModuleWorkerWrapper  getExtensionManifest
```

### 2.17 Namespaced sub-objects (4 keys, nested members also frozen)

```
swipe      = { left, right, to, show, hide, refresh, isAllowed, state }
variables  = { local:  { get, set, del, add, inc, dec, has },
               global: { get, set, del, add, inc, dec, has } }
symbols    = { ignore }        # IGNORE_SYMBOL
constants  = { unset }         # UNSET_VALUE — the sentinel that *removes* a card extension field
```

The nested member names inside `swipe`, `variables`, `symbols`, and `constants` are part of this
contract on the same terms as top-level keys. `constants.unset` in particular is a *sentinel
value*: its identity, not merely its presence, is load-bearing (`writeExtensionField` compares
against it to delete rather than set).

### 2.18 Also frozen: `SillyTavern.libs`

`globalThis.SillyTavern = { libs, getContext }` (`public/script.js:293`). `libs` is the default
export of `public/lib.js` — 25 vendored libraries extensions treat as ambient:

```
lodash  Fuse  DOMPurify  hljs  localforage  Handlebars  css  Bowser  DiffMatchPatch
Readability  isProbablyReaderable  SVGInject  showdown  moment  seedrandom  Popper
droll  morphdom  slideToggle  chalk  yaml  chevrotain  gzipSync  gzip  sha256
```

Library *versions* are not frozen (upgrades are allowed and expected). The *keys* are: removing a
library from `libs` is a contract break even if nothing in core still uses it.

---

## 3. Frozen event names — 104 keys / 103 distinct values

**Source of truth:** `public/scripts/events.js:3`, the `event_types` object.
**104 keys**, of which `SMOOTH_STREAM_TOKEN_RECEIVED` and `STREAM_TOKEN_RECEIVED` share the value
`'stream_token_received'` — so **103 distinct wire strings**. (Key count matches
`engine-review.md:360`; the 103/104 split is stated here because both numbers are true and the
maps only quote the key count.)

**The promise:** both halves are frozen — the **key** (extensions write
`event_types.MESSAGE_SENT`) and the **string value** (extensions and STScript also subscribe by
raw string, and the values are inconsistent by design: `CHAT_CHANGED` is `'chat_id_changed'`,
`CHAT_LOADED` is `'chatLoaded'`, `CHARACTER_DELETED` is `'characterDeleted'`,
`GENERATION_AFTER_COMMANDS` is its own uppercase name). Fixing those naming inconsistencies is a
contract break, however tempting. The two upstream `// TODO: Naming convention is inconsistent`
comments are **not** an invitation.

Emission order and payload shape are frozen for the events extensions listen on. `eventSource` is
an `EventEmitter` constructed with `[APP_READY, APP_INITIALIZED]` as replayed/sticky events —
handlers registered after those fire still run. That behavior is frozen.

```
KEY                                            = wire value
APP_INITIALIZED                                = app_initialized
APP_READY                                      = app_ready
EXTRAS_CONNECTED                               = extras_connected
MESSAGE_SWIPED                                 = message_swiped
MESSAGE_SENT                                   = message_sent
MESSAGE_RECEIVED                               = message_received
MESSAGE_EDITED                                 = message_edited
MESSAGE_DELETED                                = message_deleted
MESSAGE_UPDATED                                = message_updated
MESSAGE_FILE_EMBEDDED                          = message_file_embedded
MESSAGE_REASONING_EDITED                       = message_reasoning_edited
MESSAGE_REASONING_DELETED                      = message_reasoning_deleted
MESSAGE_SWIPE_DELETED                          = message_swipe_deleted
MORE_MESSAGES_LOADED                           = more_messages_loaded
IMPERSONATE_READY                              = impersonate_ready
CHAT_CHANGED                                   = chat_id_changed
CHAT_LOADED                                    = chatLoaded
GENERATION_AFTER_COMMANDS                      = GENERATION_AFTER_COMMANDS
GENERATION_STARTED                             = generation_started
GENERATION_STOPPED                             = generation_stopped
GENERATION_ENDED                               = generation_ended
SD_PROMPT_PROCESSING                           = sd_prompt_processing
EXTENSIONS_FIRST_LOAD                          = extensions_first_load
EXTENSION_SETTINGS_LOADED                      = extension_settings_loaded
SETTINGS_LOADED                                = settings_loaded
SETTINGS_UPDATED                               = settings_updated
GROUP_UPDATED                                  = group_updated
MOVABLE_PANELS_RESET                           = movable_panels_reset
SETTINGS_LOADED_BEFORE                         = settings_loaded_before
SETTINGS_LOADED_AFTER                          = settings_loaded_after
CHATCOMPLETION_SOURCE_CHANGED                  = chatcompletion_source_changed
CHATCOMPLETION_MODEL_CHANGED                   = chatcompletion_model_changed
OAI_PRESET_CHANGED_BEFORE                      = oai_preset_changed_before
OAI_PRESET_CHANGED_AFTER                       = oai_preset_changed_after
OAI_PRESET_EXPORT_READY                        = oai_preset_export_ready
OAI_PRESET_IMPORT_READY                        = oai_preset_import_ready
WORLDINFO_SETTINGS_UPDATED                     = worldinfo_settings_updated
WORLDINFO_UPDATED                              = worldinfo_updated
CHARACTER_EDITOR_OPENED                        = character_editor_opened
CHARACTER_EDITED                               = character_edited
CHARACTER_PAGE_LOADED                          = character_page_loaded
CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE    = character_group_overlay_state_change_before
CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER     = character_group_overlay_state_change_after
USER_MESSAGE_RENDERED                          = user_message_rendered
CHARACTER_MESSAGE_RENDERED                     = character_message_rendered
FORCE_SET_BACKGROUND                           = force_set_background
CHAT_DELETED                                   = chat_deleted
CHAT_CREATED                                   = chat_created
CHAT_RENAMED                                   = chat_renamed
GROUP_CHAT_DELETED                             = group_chat_deleted
GROUP_CHAT_CREATED                             = group_chat_created
GENERATE_BEFORE_COMBINE_PROMPTS                = generate_before_combine_prompts
GENERATE_AFTER_COMBINE_PROMPTS                 = generate_after_combine_prompts
GENERATE_AFTER_DATA                            = generate_after_data
GROUP_MEMBER_DRAFTED                           = group_member_drafted
GROUP_WRAPPER_STARTED                          = group_wrapper_started
GROUP_WRAPPER_FINISHED                         = group_wrapper_finished
WORLD_INFO_ACTIVATED                           = world_info_activated
TEXT_COMPLETION_SETTINGS_READY                 = text_completion_settings_ready
CHAT_COMPLETION_SETTINGS_READY                 = chat_completion_settings_ready
CHAT_COMPLETION_PROMPT_READY                   = chat_completion_prompt_ready
CHARACTER_FIRST_MESSAGE_SELECTED               = character_first_message_selected
CHARACTER_DELETED                              = characterDeleted
CHARACTER_DUPLICATED                           = character_duplicated
CHARACTER_RENAMED                              = character_renamed
CHARACTER_RENAMED_IN_PAST_CHAT                 = character_renamed_in_past_chat
SMOOTH_STREAM_TOKEN_RECEIVED                   = stream_token_received     # @deprecated alias
STREAM_TOKEN_RECEIVED                          = stream_token_received
STREAM_REASONING_DONE                          = stream_reasoning_done
FILE_ATTACHMENT_DELETED                        = file_attachment_deleted
WORLDINFO_FORCE_ACTIVATE                       = worldinfo_force_activate
OPEN_CHARACTER_LIBRARY                         = open_character_library
ONLINE_STATUS_CHANGED                          = online_status_changed
IMAGE_SWIPED                                   = image_swiped
CONNECTION_PROFILE_LOADED                      = connection_profile_loaded
CONNECTION_PROFILE_CREATED                     = connection_profile_created
CONNECTION_PROFILE_DELETED                     = connection_profile_deleted
CONNECTION_PROFILE_UPDATED                     = connection_profile_updated
TOOL_CALLS_PERFORMED                           = tool_calls_performed
TOOL_CALLS_RENDERED                            = tool_calls_rendered
CHARACTER_MANAGEMENT_DROPDOWN                  = charManagementDropdown
SECRET_WRITTEN                                 = secret_written
SECRET_DELETED                                 = secret_deleted
SECRET_ROTATED                                 = secret_rotated
SECRET_EDITED                                  = secret_edited
PRESET_CHANGED                                 = preset_changed
PRESET_DELETED                                 = preset_deleted
PRESET_RENAMED                                 = preset_renamed
PRESET_RENAMED_BEFORE                          = preset_renamed_before
MAIN_API_CHANGED                               = main_api_changed
WORLDINFO_ENTRIES_LOADED                       = worldinfo_entries_loaded
WORLDINFO_SCAN_DONE                            = worldinfo_scan_done
MEDIA_ATTACHMENT_DELETED                       = media_attachment_deleted
PERSONA_CHANGED                                = persona_changed
PERSONA_CREATED                                = persona_created
PERSONA_UPDATED                                = persona_updated
PERSONA_RENAMED                                = persona_renamed
PERSONA_DELETED                                = persona_deleted
TTS_JOB_STARTED                                = tts_job_started
TTS_AUDIO_READY                                = tts_audio_ready
TTS_JOB_COMPLETE                               = tts_job_complete
ITEMIZED_PROMPTS_LOADED                        = itemized_prompts_loaded
ITEMIZED_PROMPTS_SAVED                         = itemized_prompts_saved
ITEMIZED_PROMPTS_DELETED                       = itemized_prompts_deleted
```

---

## 4. Frozen module paths — 15

Extensions reach past `getContext()` and import core modules directly by relative path.
Resolution happens in **URL space, at module-load time, in the browser** — which makes the path
itself the API. Nothing catches a miss: a moved file is a silent white-screen at load.

**Verified by resolving every relative-parent `import` / `export … from` in the installed set into
served-URL space. Over the surviving (non-Nemo) set: 94 such statements, 39 extension-internal,
**55 into core**, across **15 distinct core modules** — 31 statements from the global tier and 24
from the local tier. Every named export in the table below was checked to exist in this repo's
source.**

> **Derivation note.** Including NemoPresetExt the same pass yields 216 statements / 96 internal /
> **120 core** across **19** modules, with the global tier contributing 94 import edges — matching
> `engine-review.md:362`'s "~94" exactly, and confirming the pre-demotion figures before they were
> narrowed. Four of those 19 paths were imported only by Nemo and are listed in **Appendix A**.
>
> The maps' own tables disagree with each other on the pre-demotion count:
> `extensions-and-data.md:197` lists **17** modules, omitting `/scripts/world-info.js` and
> `/scripts/util/AccountStorage.js`, both of which `engine-review.md:362`'s prose breakdown does
> name. 19 was the correct pre-demotion figure; 15 is the frozen one.

**The promise: these files may grow, never move or rename.** Their URL path is frozen, and so is
every named export listed against them. Adding exports is free. Splitting a module into several
files is fine *only* if the original path remains a module that re-exports the frozen names.

| # | Frozen URL path | Stmts | Frozen named exports | Importers |
|--:|---|--:|---|---|
| 1 | `/script.js` | 16 | `addOneMessage`, `animation_duration`, `animation_easing`, `characters`, `chat`, `eventSource`, `event_types`, `getGeneratingApi`, `getMaxContextTokens`, `getPastCharacterChats`, `getRequestHeaders`, `getThumbnailUrl`, `isStreamingEnabled`, `name2`, `openCharacterChat`, `saveChatConditional`, `saveChatDebounced`, `saveSettingsDebounced`, `this_chid` | TopBar, TypingIndicator, GG, CustomModels, Timelines, VoidlitEchoes, message-metrics, neon-kissa, noass, voidlit-echoes |
| 2 | `/scripts/extensions.js` | 12 | `extension_settings`, `getContext`, `loadExtensionSettings`, `renderExtensionTemplateAsync` | TypingIndicator, GG, CustomModels, Timelines, VoidlitEchoes, message-metrics, neon-kissa, voidlit-echoes |
| 3 | `/scripts/i18n.js` | 6 | `t` | TopBar, TypingIndicator, Moonlit |
| 4 | `/scripts/power-user.js` | 5 | `power_user`, `addEphemeralStoppingString`, `flushEphemeralStoppingStrings`, `fixMarkdown`, `loadMovingUIState` | Moonlit, Timelines, noass |
| 5 | `/scripts/utils.js` | 4 | `debounce`, `delay`, `download`, `getFileText`, `sortMoments`, `timestampToMoment`, `uuidv4`, `waitUntilCondition` | TopBar, Timelines, noass |
| 6 | `/scripts/group-chats.js` | 2 | `getGroupPastChats`, `selected_group` | TopBar, TypingIndicator |
| 7 | `/scripts/RossAscends-mods.js` | 2 | `dragElement`, `getMessageTimeStamp` | Moonlit, noass |
| 8 | `/scripts/openai.js` | 1 | `Message`, `MessageCollection`, `promptManager` | noass |
| 9 | `/scripts/constants.js` | 1 | `debounce_timeout` | TopBar |
| 10 | `/scripts/preset-manager.js` | 1 | `getPresetManager` | GG |
| 11 | `/scripts/tokenizers.js` | 1 | `getTokenCount` | Timelines |
| 12 | `/scripts/macros/macro-system.js` | 1 | `macros` | noass |
| 13 | `/scripts/slash-commands.js` | 1 | `registerSlashCommand` | Timelines |
| 14 | `/scripts/loader.js` | 1 | `showLoader`, `hideLoader` | Timelines |
| 15 | `/scripts/bookmarks.js` | 1 | `createBranch` | Timelines |

Named exports that only Nemo deep-imported are **not** frozen at the module level even where the
module itself stays frozen — see Appendix A.2. All of them remain reachable through `getContext()`
regardless, which is frozen in full (§2).

### 4.1 Relative-path depth is itself frozen

Extensions hard-code the number of `../` hops, and the correct number differs by tier:

```
built-in     public/scripts/extensions/<x>/index.js              →  '../../../script.js'
third-party  …/extensions/third-party/<x>/index.js               →  '../../../../script.js'
nested       …/third-party/<x>/**/*.js                           →  5–6 levels up
```

Therefore the **directory depth** of `public/scripts/extensions/third-party/` relative to
`public/` is frozen alongside the file paths. Moving `script.js` out of `public/` root, or
inserting/removing a level in `public/scripts/`, breaks every installed extension simultaneously,
at module-resolution time, with no error that names the cause.

---

## 5. Frozen HTTP surface

### 5.1 `/api/extensions/*` — 8 routes

Mounted at `src/server-startup.js:157` (`app.use('/api/extensions', extensionsRouter)`), defined in
`src/endpoints/extensions.js`. The whole router is wrapped in `extensionsEnabledFeatureGuard`,
which 404s every route when `config.yaml → extensions.enabled: false` — that gate behavior is part
of the contract, not an implementation detail, because the frontend distinguishes "extensions off"
from "route missing" by it. Git operations run through the pluggable backend selected by
`config.yaml → git.backend` (default `auto`, `src/git/client.js :: createGitClient`), with a 5-minute
clone timeout.

| Method + path | Contract |
|---|---|
| `POST /api/extensions/install` | Body `{url, global, branch}`. Validates the URL and requires `http(s):`. Folder name is `sanitize(basename(pathname, '.git'))`. 409 if the directory already exists. Shallow-clones (`git clone --depth 1 [--branch]`) into `data/<user>/extensions/<name>`, or into `public/scripts/extensions/third-party/<name>` when `global:true` — which additionally requires `request.user.profile.admin`. |
| `POST /api/extensions/update` | `git pull` (fetch + reset) inside the extension directory. Backs the `auto_update` startup path. |
| `POST /api/extensions/branches` | Lists remote branches for an installed extension. |
| `POST /api/extensions/switch` | Checks out a named remote branch. |
| `POST /api/extensions/move` | Moves an extension between the local (per-user) and global tiers. |
| `POST /api/extensions/version` | Returns the current commit plus `checkIfRepoIsUpToDate()`. |
| `POST /api/extensions/delete` | Recursively removes the extension directory. |
| `GET /api/extensions/discover` | Returns `[{type, name}]` across three tiers — `system` (`public/scripts/extensions/<name>`, excluding `third-party`, internal key `<name>`), `local` (`data/<handle>/extensions/<name>`, internal key `third-party/<name>`), `global` (`public/scripts/extensions/third-party/<name>`, internal key `third-party/<name>`). The **internal-key format is frozen**: `extension_settings.disabledExtensions` is a `string[]` of exactly these keys, and `auto_update` only fires for keys beginning `third-party`. |

**Also frozen — the static serving rule.** `src/users.js:1219` mounts
`/scripts/extensions/third-party/*` onto the requesting user's `directories.extensions`
(`data/<handle>/extensions`). This is what makes a *local* extension's `'../../../../script.js'`
resolve to `/script.js` even though the file lives under `data/` on disk. The URL prefix
`/scripts/extensions/third-party/` must keep serving both tiers — global from `public/`, local from
the user directory, with the user directory shadowing. Break this and the local tier stops loading
while the global tier keeps working, which is the most confusing possible failure.

**And the manifest contract.** `manifest.json` is fetched at
`/scripts/extensions/<name>/manifest.json` by `getManifests()` (`public/scripts/extensions.js:533`)
and consumed by `activateExtensions()` (`:562`). The keys ST reads today —
`display_name`, `version`, `author`, `description`, `license`, `homePage` (capital P),
`loading_order`, `requires`, `optional`, `dependencies`, `minimum_client_version`, `js`, `css`,
`generate_interceptor`, `hooks`, `i18n`, `auto_update` — keep their meanings. The schema is
**permissive and never validated**, so Kotatsu may add fields freely; unknown keys are ignored, and
malformed `requires`/`dependencies` `console.warn` and degrade to "no requirement". Sort is
`loading_order` ascending, ties broken by `display_name` `localeCompare` (`:418`). The `activate`
hook is a **named export** of `js`, dynamically imported and called with a 5000 ms timeout after
which ST warns and continues.

**Generation interceptors are a global, not an export.** `runGenerationInterceptors()`
(`public/scripts/extensions.js:2015`) walks manifests carrying `generate_interceptor` and calls
`globalThis[<key>](chat, contextSize, abort, type)` in `loading_order` sequence. `noass` and two
built-ins depend on this dispatch, including the `abort(immediately)` contract. Frozen as-is.

### 5.2 Server plugins — `/api/plugins/<id>`

`src/plugin-loader.js` scans `./plugins/`, gated on `config.yaml → enableServerPlugins: true`. Each
subdirectory is loaded via its `package.json` `main`, or a bare `index.js` / `index.mjs`. A plugin
module must export `info = {id, name, description}` (all strings) and `async init(router)`, where
`router` is an **`express.Router`**; an optional `async exit()` is collected into the shutdown
hooks. After `init`, the loader inspects `router.stack.length` and mounts the router at
`/api/plugins/<info.id>` only if it is non-zero (`src/plugin-loader.js:213-227`).

**This makes an Express internal (`router.stack`) part of the contract.** Kotatsu therefore stays
on Express for the plugin lane: Fastify and Hono have no clean equivalent, and swapping the
framework breaks every server plugin with no migration path. `plugins/claude-code-rp` — the
loopback bridge onto the Claude Code subscription — is the live consumer here, and it is
load-bearing. `plugins/package.json` pins `{"type":"commonjs"}` for the folder; that pin is frozen
too, since plugins are loaded as Node modules and the type field decides how.

---

## 6. What is NOT frozen

Everything else. Explicitly, and non-exhaustively:

- **Markup structure.** Element nesting, wrappers, tag names, and the DOM tree shape are free to
  change, provided the 26 IDs in §1 survive the move — **except the message DOM shape, which §1.7
  freezes** (added v2).
- **CSS.** All of it. The 168 custom properties, the 15,392 LOC of core CSS, class names, the
  cascade. Themes that couple to classes may break; that is accepted, and §6's strangler clause is
  the mitigation. `src/middleware/userCss.js` remains the supported user-CSS injection point.
  **Exception: the §1.7 message class vocabulary**, which is a structural surface with named
  consumers, not styling.
- **jQuery.** Its presence, version, and use inside core are not promised. Only the *reachability*
  of the 26 IDs via standard DOM lookup is — and `$('#id')` works on any element
  `document.getElementById` can find.
- **Internal core APIs.** Any function, class, or module not listed in §2 or §4. Rename and
  refactor freely.
- **Rendering strategy.** `addOneMessage` / `printMessages` may be reimplemented on any engine, as
  long as their `getContext()` signatures hold, the events in §3 still fire in the same order, and
  the output honors §1.7 (including `addOneMessage`'s synchronous-attach guarantee).
- **The 267 non-extension HTTP routes.** Everything outside §5.
- **Build tooling, module bundling, TypeScript adoption, directory layout under `src/`.**
- **Extension-internal DOM.** The ~168 IDs the surviving extensions reference that do not exist in core
  `index.html` belong to the extensions themselves.

### 6.1 The strangler policy

Kotatsu replaces the shell panel by panel, not in one cut. During that migration:

> **New panels may relocate frozen IDs in the DOM — moving them into a new component, a new
> container, a different position in the tree, or under different styling — but may never remove,
> rename, or shadow-root them.** A rewritten panel must carry its frozen IDs forward onto whatever
> element now plays that role. An ID whose old element is deleted and whose role has no successor
> is not a relocation; it is a removal, and removals require a spec change to this file.

Two corollaries:

1. **Shadow DOM is a break.** Custom elements are otherwise the preferred boundary — jQuery
   selectors cannot accidentally reach into a shadow root, while CSS custom properties pierce it by
   design, so the theme token layer keeps working inside new components for free. But any element
   carrying a frozen ID must stay in the light DOM where `document.getElementById` reaches it.
2. **Relocation is not free of consequence.** Extensions that *append into* a frozen container
   (rather than merely reading it) will land their content wherever that container now lives. That
   is expected and acceptable; visual displacement is not a contract break, disappearance is.

---

## 7. Enforcement

All commands are read-only and run from the repo root. Third-party extension paths assume the
installed set is present at `public/scripts/extensions/third-party/` and
`data/default-user/extensions/`; against a bare clone, point them at a stock SillyTavern install that has the same extensions (read-only).

**Every extension-side grep excludes `NemoPresetExt`** — it is dropped (see the preamble and
Appendix A). Re-including it re-derives the pre-demotion figures in the derivation notes, which is
the intended way to check that Appendix A is still complete and nothing silently moved between the
frozen list and the watched list.

```bash
EXT=public/scripts/extensions/third-party
LOCAL=data/default-user/extensions
NONNEMO=$(ls -d $EXT/*/ | grep -v NemoPresetExt)

# §1 — the 26 frozen DOM IDs. Any output from the diff is a contract change.
comm -12 \
  <(grep -rhoE "#[a-zA-Z_][a-zA-Z0-9_-]*" $NONNEMO $LOCAL --include="*.js" \
      | sed 's/#//' | sort -u) \
  <(grep -oE 'id="[^"]+"' public/index.html | sed 's/id="//; s/"//' | sort -u)
# expect: 26 lines, matching §1.  Swap $NONNEMO for $EXT to reproduce the pre-demotion 59.

# §2 — the 146 getContext() keys (top-level names in the return object)
sed -n '/^    return {/,/^    };/p' public/scripts/st-context.js \
  | grep -oE '^        [A-Za-z_$][A-Za-z0-9_$]*\s*[,:]' \
  | sed 's/[ ,:]//g' | sort
# expect: 146 unique names, matching §2

# §3 — the 104 event_types keys / 103 distinct values
grep -oE "^    [A-Z_0-9]+: '[^']+'" public/scripts/events.js | wc -l          # expect 104
grep -oE "^    [A-Z_0-9]+: '[^']+'" public/scripts/events.js \
  | sed "s/.*: '//; s/'//" | sort -u | wc -l                                  # expect 103

# §4 — deep-import targets. Resolve each relative-parent import in URL space;
# anything not under /scripts/extensions/third-party/ is a frozen core module.
grep -rhoE "from ['\"](\.\./)+[^'\"]+['\"]" $NONNEMO $LOCAL --include="*.js" \
  | sed "s/.*['\"]//; s/['\"]$//"
# expect: after resolution, exactly the 15 paths in §4 (19 with Nemo re-included)

# §5 — the 8 /api/extensions routes
grep -nE "router\.(get|post|put|delete|patch|all)\(" src/endpoints/extensions.js
# expect: install, update, branches, switch, move, version, delete, discover

# §5.2 — the plugin mount point must stay intact
grep -n "api/plugins\|router.stack" src/plugin-loader.js
```

---

## 8. Changing this contract

A change to any frozen item requires, in order:

1. An entry in this file's revision history naming the item, the reason, and the extensions
   affected — checked against the installed set, not assumed.
2. A bump of the contract version in the header.
3. A migration note for each affected extension: what breaks, and whether Kotatsu patches the
   extension, shims the old name, or accepts the break.

Deprecation is the preferred path over removal: keep the old name as a shim that forwards to the
new one, mark it `@deprecated` in source, and leave it in the frozen list. Every `@deprecated`
entry already in §2 exists because upstream took exactly this route, and every one of them is
still called by something.

---

## Appendix A — Watched, not frozen (NemoPresetExt — dropped 2026-08-23)

NemoPresetExt was dropped by decision on **2026-08-23** (unused lately; recorded in
the internal design notes). It will not be installed in Kotatsu. Everything in this appendix was
load-bearing **for Nemo and nothing else**, so the fork does not promise it — but it is recorded
here with its attribution intact rather than deleted, for three reasons:

1. **Reversibility.** If Nemo is ever reinstated, this is the exact delta that has to be re-frozen.
   No re-derivation, no archaeology.
2. **Blast-radius awareness.** Most of these are the Prompt Manager, preset, and API-settings
   surface — precisely the region Kotatsu intends to rebuild. Knowing what *used* to be contract
   there is useful when writing the replacement.
3. **Honest bookkeeping.** The pre-demotion numbers (59 IDs, 19 modules) appear throughout
   the internal design notes. Without this appendix, the gap between those figures and the frozen totals
   looks like an error instead of a decision.

**Status of everything below: free to rename, move, restructure, or delete.** No spec change
required. If a future extension starts depending on one of these, promote it back into the frozen
list at that point — the trigger is a real consumer, not this list.

### A.1 DOM IDs demoted — 33

All 33 were reachable from NemoPresetExt only; none has another consumer in either tier.
Grouped by the region of the shell they belong to.

**Prompt Manager (5)** — Nemo's core attachment point, and the region most likely to be rebuilt:

```
completion_prompt_manager
completion_prompt_manager_popup
completion_prompt_manager_popup_entry_form_prompt
completion_prompt_manager_popup_entry_form_save
openai_settings
```

**API & generation settings (10):**

```
kobold_api-settings   textgenerationwebui_api-settings   openai_api-presets
range_block_openai    range_block_novel                  common-gen-settings-block
max_context_block     temp                               temp_textgenerationwebui
api_url_text
```

**World Info (5):**

```
world_info   world_editor_select   world_popup_entries_list   world_import_file
wiActivationSettings
```

**Character list (4):**

```
rm_characters_block   rm_button_characters   rm_button_selected_ch   charListFixedTop
```

**System prompt (2):**

```
sysprompt_content   sysprompt_select
```

**Themes, backgrounds & chrome (7):**

```
Backgrounds   bg_menu_content   UI-presets-block   CustomCSS-block
power-user-option-checkboxes    top-settings-holder    form_character_search_form
```

> `extensions_settings2` looks like it belongs on this list and does **not**: it is Nemo-only in the
> global tier, but message-metrics and neon-kissa both target it from the local tier, so it stays
> frozen in §1.4. Same story in reverse for `WorldInfo`, `chat`, `extensions_settings`,
> `left-nav-panel`, `right-nav-panel`, `rm_print_characters_block`, and `sheld` — Nemo touched all
> seven, but Moonlit/GG/noass keep them frozen.

### A.2 Module paths demoted — 4

| Demoted URL path | Stmts | Named exports Nemo imported | Still reachable via |
|---|--:|---|---|
| `/scripts/popup.js` | 6 | `Popup`, `POPUP_TYPE`, `callGenericPopup` | `getContext()` §2.8 — all three |
| `/scripts/world-info.js` | 1 | `createNewWorldInfo`, `createWorldInfoEntry`, `deleteWIOriginalDataValue`, `deleteWorldInfoEntry`, `getFreeWorldName`, `loadWorldInfo`, `saveWorldInfo`, `world_names` | `getContext()` §2.12 — `loadWorldInfo`, `saveWorldInfo`, `getWorldInfoNames` only |
| `/scripts/util/AccountStorage.js` | 1 | `accountStorage` | `getContext().accountStorage` §2.4 |
| `/scripts/reasoning.js` | 1 | `updateReasoningUI` | `getContext().updateReasoningUI` §2.14 |

**None of these four modules may be deleted outright** — every one of them still backs a frozen
`getContext()` key, and §2 is frozen in full. What is released is only the *deep-import path*: the
files may be moved, renamed, or merged, provided `getContext()` keeps returning the same members.

### A.3 Named exports demoted on still-frozen paths

These modules stay frozen (§4) because non-Nemo extensions import them, but these particular named
exports had Nemo as their only deep-import consumer, so they are not frozen at the module level.
Each remains reachable through `getContext()`, which is frozen in full.

```
/script.js           chat_metadata            → getContext().chatMetadata
/script.js           selectCharacterById      → getContext().selectCharacterById
/scripts/openai.js   oai_settings             → getContext().chatCompletionSettings
/scripts/openai.js   openai_setting_names     → (no getContext equivalent — fully released)
/scripts/tokenizers.js  getTokenCountAsync    → getContext().getTokenCountAsync
/scripts/utils.js    debounceAsync, escapeHtml, flashHighlight, getSortableDelay, isValidUrl,
                     navigation_option, onlyUnique, removeFromArray, throttle
                                              → (no getContext equivalents — fully released)
/scripts/constants.js  debounce_timeout       → still frozen (TopBar imports it too)
```

Note the last line: `debounce_timeout` appears here only because Nemo re-exported it from
`NemoPresetExt/core/utils.js`; Extension-TopInfoBar imports it directly, so it stays frozen. The
two `export … from` re-export edges counted in the pre-demotion total both lived in that Nemo file
and disappear with it — which is why the frozen statement total is 55 import edges with no
re-exports.

---

### Revision history

| Version | Baseline | Notes |
|---|---|---|
| v1 | ST staging `1ca70787f` (1.18.0) | Initial freeze, **NemoPresetExt already excluded** (dropped 2026-08-23, per the internal design notes). Frozen: **26 DOM IDs**, **146 `getContext()` keys**, **104 event keys** (103 distinct values), **15 core module paths**, 8 `/api/extensions` routes + the plugin router contract. Demoted to Appendix A: 33 DOM IDs, 4 module paths, and the Nemo-only named exports on still-frozen paths. |
| v2 | same | **§1.7 message DOM shape added** (2026-08-24, renderer v0 slice 0) — freezes the `.mes` subtree surface with named consumers ahead of the SPEC target-3 renderer strangle; derivation in `docs/renderer-v0-recon-abi.md` §2. §6's markup/CSS/rendering-strategy bullets amended with the §1.7 carve-outs. No change to the §1–§5 counts. |

**Pre-demotion figures, for reconciliation against the internal design notes:** with Nemo included the
same derivations give 59 DOM IDs (matching `engine-review.md:349` exactly), 19 core module paths,
and 120 core import edges of which 94 come from the global tier (matching `engine-review.md:362`'s
"~94" exactly). `getContext()` (146) and `event_types` (104) reproduced exactly and are unaffected
by the demotion.

**Correction carried forward:** `extensions-and-data.md:197` tabulates **17** deep-import modules;
the correct pre-demotion figure is **19** — it omits `/scripts/world-info.js` and
`/scripts/util/AccountStorage.js`, both of which `engine-review.md:362`'s prose breakdown does
name. Both happen to be Nemo-only and now sit in Appendix A.2, but the map's table was wrong
independently of the demotion and should be read with that in mind.
