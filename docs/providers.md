# Provider patches — provenance & maintenance

**Scope.** Everything Kotatsu carries on top of upstream SillyTavern in the provider/model layer: what each hunk does, why it exists, and how to extend it. This document is the permanent replacement for two retired mechanisms (`VOIDLIT-PATCHES.md` and `clio-patches/*.mjs`) — see §5.

**Base.** SillyTavern 1.18.0, branch `staging`, upstream HEAD `1ca70787f` (2026-05-20, "Add gemini-3.5-flash to Google AI Studio and Vertex model lists (#5675)").
**Carrier commit.** `a4c64666c` — `feat(providers): carry local provider patches (VOIDLIT + CLIO)`, **4 files, +69 / −11, 16 hunks**.
**Ground truth.** `git show a4c64666c`. Where this document and any retired doc disagree, the diff wins.

All line numbers below are **this clone, post-`a4c64666c`**, verified by grep. They shift on every upstream merge — re-verify before trusting one.

---

## State after the 2026-10-04 upstream sweep (read this first)

**This section supersedes the counts in §1.0 and the "carried" status of A2, C1/C2/C4 and D1–D4 below.** Those entries stay as history.

**Swept to.** Every upstream `staging` commit through `ad29cbda6` (2026-10-03) is in, cherry-picked one by one with `-x` (each commit names its upstream sha). Branch `sweep/upstream-2026-10-04`. Skipped on purpose: `8172dcd0e` (duplicate of `bba96c6fb`), `30eaf26a4` + `9758a6cd5` (upstream's readme, which Kotatsu deleted), `06bde939f` (npm publish workflow), `ad29cbda6` (CONTRIBUTING / PR template), `61139aa9b` (version bump; `package.json` is Kotatsu's identity). `2463e8396` came up empty: Kotatsu never had the whitespace it removes.

**Retired into upstream** (the merge lane paying out, §4.2 rule 2):
- **A2 / D2 / D3** — upstream's `isFableModel` + unanchored `isClaude5Model = /claude-(opus-5|sonnet-5)/` replaced our regex tails; the Claude block in `chat-completions.js` is now byte-identical to upstream. The `|sonnet-5|opus-5|fable-5)` probe in §1.0 returns **0/0** by design now.
- **D1 / D4** — upstream ships every Claude 5 option and vision entry; our duplicates were dropped.
- **C1 / C2 / C4** — upstream has Gemini 3.8 / 3.7 / 3.6 in their own optgroups; our entries under "Gemini 3.5" were dropped.
- **B1** — upstream ships `glm-5.2` (option + context map); our `glm-5.2` lines were dropped, `glm-5.3` / `glm-5.3-flash` stay ours.
- **getChatInfo crash fix** (`63eb5f1c2`) — replaced by upstream #5871's version (`chatVanished()` sentinel, no async executor). Our caller guards remain as harmless belts.

**Still carried:** A1 (usage passthrough), A3–A6 (Grok 4.5), B2/B3 (glm-5.3), **C3** (now documented in code as the fallback for Gemini ids upstream's own `noPrefillModel` list doesn't name), the Claude Code bridge hunks, plus the new §1.E / §1.F below.

**Markers now:** `grep -rc "KOTATSU-PATCH\|VOIDLIT-PATCH" src/ public/` → `chat-completions.js` 7, `openai.js` 9, `constants.js` 1, `endpoints/secrets.js` 1, `scripts/secrets.js` 1, `index.html` 1, `prompt-converters.js` 1.

### Sweep runbook (what this one taught)
- Worktree off `kotatsu`, real `npm ci` (never junction `node_modules`), and `npm run build:lib` before booting.
- Resolve **per hunk**, never `git checkout --theirs <file>` (that takes upstream's whole file and silently drops every Kotatsu change in it).
- **cometapi traps:** upstream lines still name the dead CometAPI provider; take upstream's line, then strip `cometapi`.
- After the model commits, run a duplicate-`<option>`-per-`<select>` scan; a clean cherry-pick can still double an id we had added early.
- Upstream tests assume jest runs from `tests/`; Kotatsu runs from the root. `chdir` relative to the test file, not `cwd`.
- Upstream moves stock `Default.json` model defaults; Kotatsu Nabe inherits them, so `node scripts/build-kotatsu-nabe.mjs` then `normalize-shipped-presets.mjs` (check first).

---

## 0. Why these patches exist at all

Upstream has no provider abstraction. `src/endpoints/backends/chat-completions.js` is a 2,929-line monolith serving 26 chat-completion sources (`src/constants.js:187 CHAT_COMPLETION_SOURCES`): twelve near-duplicate `sendXRequest` functions, a ~360-line `else if` ladder that mutates shared `apiUrl`/`apiKey`/`headers`/`bodyParams` locals, a 340-line `/status` switch, a `/multimodal-models` sub-router, and `/process`.

Model *capability* is expressed as **regex tests against the model ID string**, scattered across frontend and backend. Consequence: a new model that upstream has not shipped yet needs edits in three-to-five separate places, none of which are a registry. That is what every hunk below is.

Upstream ships these edits eventually — provider/model maintenance is **13.6% of upstream churn** (`../st-fork/maps/engine-review.md:553`) and it is free value. Our patches are the gap between "model launched" and "upstream shipped it." They are written to **collide cleanly** with the upstream version when it lands, not to replace it. See §4.

Two dead-weight facts that shape the file and will confuse you if you don't know them:
- `cometapi` was a **dead provider** (threw `'This provider is temporarily disabled.'` in both its `/status` and `/generate` branches). **Removed in the dead-weight hygiene slice (2026-08-23)** per SPEC §3 — backend branches, constants, secret key, and all frontend surfaces. If an upstream merge ever reintroduces or revives it, resolving in upstream's favor is fine; re-delete only if it is still dead.
- Most config is read at module load into `const`s, so **every backend change needs a server restart**, not a reload.

---

## 1. Patch inventory

Sixteen hunks in four files. Grouped by family, then by provider.

### 1.0 Marker discipline — read this before grepping

Only **8 of the 16 hunks carry an in-code marker.** `grep -rn "KOTATSU-PATCH\|VOIDLIT-PATCH" src/ public/` returns exactly:

| File | Markers |
|---|---|
| `public/scripts/openai.js` | 5 |
| `src/endpoints/backends/chat-completions.js` | 2 (1× `VOIDLIT-PATCH`, 1× `KOTATSU-PATCH`) |
| `src/prompt-converters.js` | 1 |
| **total** | **8** |

**Unmarked and therefore invisible to that grep:** all four `public/index.html` dropdown hunks, both Grok 4.5 `openai.js` hunks, the Claude capability-regex block (`chat-completions.js:236-242`), and both Grok 4.5 backend hunks (`:2533`, `:2601`). The marker grep is a *liveness smoke test*, not an inventory. **This table is the inventory.**

A second, more complete probe for the Claude family specifically — the shared regex tail:

```
grep -c "|sonnet-5|opus-5|fable-5)" src/endpoints/backends/chat-completions.js public/scripts/openai.js
# expect: chat-completions.js:6   openai.js:1
```

---

### 1.A VOIDLIT family

Provenance: hand-applied edits in the live install, documented (partially — see §5) by `VOIDLIT-PATCHES.md` → `data/default-user/extensions/voidlit-echoes/PATCHES.md`.

#### A1 — Claude: preserve `usage` on non-streaming replies
**File:** `src/endpoints/backends/chat-completions.js:406-410`, in `sendClaudeRequest` (`:215`).

```js
// VOIDLIT-PATCH: preserve upstream `usage` so the Voidlit Echoes metrics
// bar can read cache/token telemetry on NON-streaming Claude. ST drops it
// by default. Re-apply after SillyTavern updates.
// See data/default-user/extensions/voidlit-echoes/PATCHES.md
const reply = { choices: [{ 'message': { 'content': responseText } }], content: generateResponseJson.content, usage: generateResponseJson.usage };
```

**Upstream code modified:** the non-streaming branch rebuilds Anthropic's response into a fake OpenAI wrapper and **discards the `usage` object** (cache-read/cache-write/input/output token counts). Upstream shipped `{ choices, content }`; we add the third key.

**Why:** the Voidlit Echoes theme extension's `metrics.js` reads `data.usage` off the JSON response. Without this field the metrics bar is silently dead on non-streaming Claude — no error, just zeros.

**Scope note (carried from the retired doc, verified against the diff):** this is **only** needed for non-streaming. With streaming ON, ST forwards Claude's raw SSE via `forwardFetchResponse` and `usage` survives untouched. DeepSeek / OpenAI / OpenRouter non-streaming also already keep `usage` — they are raw passthrough, no patch needed.

**Known unpatched sibling:** there is a structurally identical response-rebuild at `chat-completions.js:747` — `const reply = { choices: [{ 'message': { 'content': responseText } }], responseContent };` — that also omits `usage`. Left alone deliberately. If you ever run that provider non-streamed and want metrics, patch it the same way.

#### A2 — Claude 5-family capability regexes
**File:** `src/endpoints/backends/chat-completions.js:236-242`. **Unmarked.**

Seven capability regexes gate Claude request shaping. **Six were extended** with `|opus-4-8|sonnet-5|opus-5|fable-5`; the seventh was deliberately left alone.

| Line | Const | Regex (exact, post-patch) |
|---|---|---|
| 236 | `useThinking` | `/^claude-(3-7\|opus-4\|sonnet-4\|haiku-4-5\|opus-4-5\|opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` |
| 237 | `useWebSearch` | `/^claude-(3-5\|3-7\|opus-4\|sonnet-4\|haiku-4-5\|opus-4-5\|opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` |
| 238 | `isLimitedSampling` | `/^claude-(opus-4-1\|sonnet-4-5\|haiku-4-5\|opus-4-5\|opus-4-6\|sonnet-4-6)/` — **UNCHANGED, intentionally** |
| 239 | `useVerbosity` | `/^claude-(opus-4-5\|opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` |
| 240 | `noPrefillModel` | `/^claude-(opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` |
| 241 | `isAdaptiveModel` | `/^claude-(opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` `\|\| (enableAdaptiveThinking && /^claude-(opus-4-6\|sonnet-4-6)/...)` |
| 242 | `noSamplingModel` | `/^claude-(opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` |

**Why `isLimitedSampling` is excluded.** It is the *superseded* mechanism. `noSamplingModel` (`:242`) is the stronger, newer gate — 5-family models are `noSampling`, which is checked at `:319` and `:333` and strictly dominates the `isLimitedSampling` handling at `:311`. Adding a 5-family model to `isLimitedSampling` would be redundant at best and contradictory at worst. **Six is the correct count. Do not "fix" it to seven.**

**What each gate does downstream:** `useWebSearch` → `:294`; `isLimitedSampling` → `:311`; `noSamplingModel` → `:319` and `:333`; `isAdaptiveModel` → `:326` (`calculateClaudeBudgetTokens`); `useThinking` → `:329`/`:340`; `noPrefillModel` → `:361` (strips a trailing assistant turn — Anthropic's own prefill removal, mirroring the Gemini guard in C3); `useVerbosity` → `:366`.

#### A3 — Grok 4.5 sampler handling (frontend)
**File:** `public/scripts/openai.js:2901`, `:2904`, `:2925-2929`, in `createGenerationParameters`. **Unmarked.**

```js
const isGrok45 = /(?:^|\/)grok-4\.5(?:$|[-:])/.test(model);
```

Hoisted above the XAI branch so both the XAI branch and the CUSTOM branch can use it. The regex is deliberately anchor-tolerant: `(?:^|\/)` matches a bare `grok-4.5` **or** a gateway-prefixed `someprovider/grok-4.5`; `(?:$|[-:])` matches an exact ID or a suffixed variant (`grok-4.5-fast`, `grok-4.5:free`).

Two behavior changes:
1. `:2904` — the XAI sampler-strip branch was `if (model.includes('grok-3-mini'))`; it is now `if (model.includes('grok-3-mini') || isGrok45)`. Grok 4.5 is a reasoning model, so `presence_penalty` / `frequency_penalty` / `stop` are deleted and `reasoning_effort` is **kept** (the `else` arm deletes it). The stale dated comment `// As of 2025/09/21, only grok-3-mini accepts reasoning_effort` was replaced with `// Only known reasoning models accept reasoning_effort.` — a deliberate de-dating, since the claim it made is no longer true.
2. `:2925-2929` — a new branch for `chat_completion_sources.CUSTOM && isGrok45` applying the same three deletes. Rationale in-code: *"OpenAI-compatible gateways use provider-prefixed model IDs for Grok 4.5."* Reaching Grok 4.5 through a CUSTOM OpenAI-compatible endpoint is a real path and the XAI-source branch never fires for it.

#### A4 — Grok 4.5 `reasoning_effort` passthrough (backend, xAI source)
**File:** `src/endpoints/backends/chat-completions.js:1179-1183`, in `sendXaiRequest` (`:1146`). **Unmarked.**

```js
const isGrok45 = /(?:^|\/)grok-4\.5(?:$|[-:])/.test(request.body.model);
bodyParams['reasoning_effort'] = isGrok45
    ? request.body.reasoning_effort
    : request.body.reasoning_effort === 'high' ? 'high' : 'low';
```

**Upstream code modified:** upstream hard-clamped every xAI request to a two-value enum — `request.body.reasoning_effort === 'high' ? 'high' : 'low'` — because grok-3-mini only accepted `low|high`. Grok 4.5 accepts the full ST effort range, so it gets the raw value passed through; everything else keeps the clamp. **Non-4.5 xAI behavior is byte-identical to upstream.**

#### A5 / A6 — Grok 4.5 on the CUSTOM source (backend)
**File:** `src/endpoints/backends/chat-completions.js:2533-2535` and `:2601-2605`. **Unmarked.**

```js
if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM && /(?:^|\/)grok-4\.5(?:$|[-:])/.test(request.body.model)) {
    bodyParams['reasoning_effort'] = request.body.reasoning_effort;
}
```
Placed immediately after upstream's identical-shaped `koboldcpp/` passthrough — it is a deliberate copy of that idiom, which is what makes it merge cleanly.

```js
if (/(?:^|\/)grok-4\.5(?:$|[-:])/.test(request.body.model)) {
    delete requestBody.presence_penalty;
    delete requestBody.frequency_penalty;
    delete requestBody.stop;
}
```
Inside the `CHAT_COMPLETION_SOURCES.CUSTOM` block, immediately before `excludeKeysByYaml(...)`. This is **belt-and-braces with A3's frontend delete at `:2925`** — deliberate, not redundant. The frontend strip can be bypassed by a preset, an API caller, or a stale cached bundle; the backend strip is the one that actually protects the request. If you ever remove one, remove the frontend one.

---

### 1.B KOTATSU family — Z.AI / GLM

Provenance: `clio-patches/add-models-2026-08-14.mjs` and `clio-patches/fix-gemini36-glm53-2026-08-14.mjs` (both idempotent, both retired here).

#### B1 — glm-5.3 / glm-5.2 dropdown options
**File:** `public/index.html:3964-3965`, inside `<select id="model_zai_select">` (`:3961`). Inserted above `glm-5.1`. Unmarked (HTML carries no comments in this file's style).

#### B2 — glm-5.3 / glm-5.2 max context
**File:** `public/scripts/openai.js:5164-5165`, in `getZaiMaxContext` (`:5158`).

```js
'glm-5.3': max_1mil, // KOTATSU-PATCH 2026-08-14: 1M ctx per Z.AI docs (same base as 5.2)
'glm-5.2': max_1mil, // KOTATSU-PATCH 2026-08-14: 1M ctx per Z.AI model doc
'glm-5.1': max_200k,
```

`max_1mil` = `1000 * 1000` (`openai.js:135`); `max_200k` = `200 * 1000` (`:132`). Consumed at `:5905`. Note the shape difference from Google's map: Z.AI's is an **exact-string object map**, Google's is an **ordered `[RegExp, number][]` array** (`:5043-5052`). A GLM model with no entry silently falls through to the map's default — always add the entry.

#### B3 — glm-5.3 reasoning dialect
**File:** `src/endpoints/backends/chat-completions.js:2477-2488`, in the `CHAT_COMPLETION_SOURCES.ZAI` branch of the `/generate` ladder (branch opens `:2465`).

```js
// KOTATSU-PATCH: glm-5.3 reasoning dialect (2026-08-14). glm-5.3+ cannot disable
// thinking (400/1210) and takes top-level reasoning_effort: low|high|max
// ('medium' rejected). Reasoning toggled off in ST -> cheapest level.
if (/^glm-5\.[3-9]/.test(request.body.model)) {
    bodyParams.thinking = { type: 'enabled' };
    const zaiEffortMap = { min: 'low', low: 'low', medium: 'high', high: 'high', max: 'max' };
    if (!request.body.include_reasoning) {
        bodyParams.reasoning_effort = 'low';
    } else if (zaiEffortMap[request.body.reasoning_effort]) {
        bodyParams.reasoning_effort = zaiEffortMap[request.body.reasoning_effort];
    } // 'auto'/unset: omit and let the provider default rule.
}
```

**Upstream code modified:** upstream builds `bodyParams = { thinking: { type: request.body.include_reasoning ? 'enabled' : 'disabled' } }` and sends **no** `reasoning_effort` at all for Z.AI. Both halves of that are wrong for 5.3+. The patch runs *after* the upstream assignment and overwrites it — order matters; do not hoist it.

**Regex `/^glm-5\.[3-9]/` is forward-looking on purpose.** It pre-covers glm-5.4 … glm-5.9. It does **not** cover glm-6.x — that is a deliberate boundary, since a major-version bump is exactly when the dialect could change again. Re-verify against the API before widening it.

Full field notes on the 5.3 dialect: **§2.1**.

---

### 1.C KOTATSU family — Gemini

#### C1 / C2 — gemini-3.7-flash / gemini-3.6-flash dropdown options
**Files:** `public/index.html:3315-3316` (`<select id="model_google_select">`, `:3313` — AI Studio / makersuite) and `:3500-3501` (`<select id="model_vertexai_select">`, `:3497`). Both selects, always. Inserted above `gemini-3.5-flash`.

⚠️ **Optgroup label mismatch.** Both insertions land inside the existing `<optgroup label="Gemini 3.5">`, so 3.6 and 3.7 render under a "Gemini 3.5" heading. Cosmetic, and **deliberate** — the anchor-based script targeted the `gemini-3.5-flash` option line, and keeping the optgroup untouched keeps the upstream merge trivial. Fix it only in a Kotatsu shell-layer pass, never in the merge lane.

**No JS or backend edit was needed for Gemini context/thinking**, and this was *proven*, not assumed. `add-models-2026-08-14.mjs` asserted it on every run against the two shipped upstream regexes:
- `public/scripts/openai.js:5046` — `[/gemini-(?:3[.\d]*|2\.(?:5|0))-(pro|flash)/, max_1mil]` → grants 1M context.
- `src/endpoints/backends/chat-completions.js:498` — `/^gemini-3[.\d]*-(flash|pro)/` inside `isThinkingConfigModel` → grants `thinkingConfig`.

Both match `gemini-3.6-flash` and `gemini-3.7-flash` without modification. **Re-run that assertion mentally before adding any future Gemini** — see §3.3.

#### C4 — gemini-3.8-flash dropdown option (2026-09-23)
Same shape as C1/C2: one `<option>` above `gemini-3.7-flash` in BOTH selects (`model_google_select` + `model_vertexai_select`), still under the "Gemini 3.5" optgroup label on purpose. ID confirmed stable on ai.google.dev/gemini-api/docs/models (not `-preview`). Zero JS/backend edits: the §3.3 assertion was re-run in node against the live regexes — 1M context, `isThinkingConfigModel`, flash thinking-level, `gemini-3` image-size/media-resolution/vision prefixes and the C3 guard all match `gemini-3.8-flash`.

#### C3 — Gemini ≥3.6 continuation-turn guard
**File:** `src/prompt-converters.js:618-623`, at the end of `convertGooglePrompt` (`:432`), immediately before its `return`.

```js
// KOTATSU-PATCH: gemini-3.6+ model-turn guard (2026-08-14). Gemini >=3.6 rejects requests
// ending with a model turn — model-turn prefill was removed from the API. Convert the
// dangling prefill/continue tail into an explicit continuation instruction.
if (/^gemini-(?:3\.[6-9]|[4-9])/.test(model) && contents.length && contents[contents.length - 1].role === 'model') {
    contents.push({ role: 'user', parts: [{ text: '[Continue seamlessly from the end of your previous turn without repeating any of it.]' }] });
}
```

Full field notes: **§2.2**.

---

### 1.D KOTATSU family — Claude (opus-5 + 5-family vision)

Provenance: `clio-patches/add-opus5-2026-08-16.mjs`. This script *extended* the hand-applied VOIDLIT 5-family work (A2) rather than duplicating it — its guard asserted it found exactly six occurrences of the pre-existing tail `|sonnet-5|fable-5)` before rewriting them to `|sonnet-5|opus-5|fable-5)`.

#### D1 — Claude dropdown options
**File:** `public/index.html:3179-3181` and `:3186`, inside `<select id="model_claude_select">` (`:3177`). One diff hunk, two insertion points:
- `:3179-3181` — `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, above `claude-opus-4-7`.
- `:3186` — `claude-sonnet-5`, above `claude-sonnet-4-6`.

#### D2 — opus-5 in the six backend capability regexes
Folded into A2 above — the six regexes at `chat-completions.js:236-242` carry `opus-4-8|sonnet-5|opus-5|fable-5` as one combined tail. VOIDLIT contributed `opus-4-8|sonnet-5|fable-5`; KOTATSU-PATCH added `opus-5`. In the committed diff they are indistinguishable, which is fine — they are one mechanism now.

#### D3 — 5-family 1M max context (frontend)
**File:** `public/scripts/openai.js:5633`, in `onModelChange`.

```js
} else if (/^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7|opus-4-8|sonnet-5|opus-5|fable-5)/.test(value)) {
    $('#openai_max_context').attr('max', max_1mil);
```

Note the **asymmetry with the backend list**: this frontend regex includes `sonnet-4-5` (which the backend `noSamplingModel`/`isAdaptiveModel` lists do not) because context window and sampling capability are independent axes. Do not try to make the two lists identical.

#### D4 — 5-family vision list fix
**File:** `public/scripts/openai.js:6155-6157`, in `isImageInliningSupported` (`:6128`).

```js
'claude-haiku-4',
'claude-fable', // KOTATSU-PATCH 2026-08-16: 5-family vision (matches upstream #5757)
'claude-sonnet-5', // KOTATSU-PATCH 2026-08-16
'claude-opus-5', // KOTATSU-PATCH 2026-08-16
```

**This was a bug fix, not a feature.** The VOIDLIT 5-family patch (A2) added the six *backend* capability regexes and the dropdown entries but never touched the vision list, so **image inlining was silently unavailable across the entire Claude 5 family** — no error, images just never attached. Upstream's own #5757 added `'claude-fable'` to this list; our patch matches that entry exactly and adds the two siblings.

The list is a **substring-prefix array**, not regexes — `'claude-fable'` (no `-5`) deliberately covers every fable variant. Consumed at `:933`, `:1229`, `:6639`.

**Standing lesson:** the vision list is the capability surface most easily forgotten, because its failure mode is silent. §3.1 puts it on the checklist.

### 1.E KOTATSU family — Xiaomi MiMo, a whole provider (2026-10-04)

Upstream has no Xiaomi source, so this is a permanent provider in the merge lane, written in Moonshot's idiom (live `/models` list) so conflicts stay on list lines. Source id `xiaomi`, secret `api_key_xiaomi`, model key `xiaomi_model` (default `mimo-v2.6-pro`), base `https://api.xiaomimimo.com/v1`. Every hunk is marked `KOTATSU-PATCH 2026-10-04` except the plain list entries.

| Where | What |
|---|---|
| `src/constants.js`, `src/endpoints/secrets.js`, `public/scripts/secrets.js` | source + secret id (+ friendly name, input map) |
| `chat-completions.js` `/status` | `apiUrl`/`apiKey` → generic `${apiUrl}/models` fetch (validates the key on Connect) |
| `chat-completions.js` `/generate` ladder | `thinking.type` from `include_reasoning`; tools + `json_schema` ride the generic tail |
| `openai.js` | source, `settingsToUpdate`/`default_settings`, model getter, model-list filler (drops `-tts`/`-asr` ids), `streamUsageSources`, streamed-reasoning source list, 1M context, **temperature clamp to 1.5** (+ `xiaomi_max_temp` slider cap), model-change handler, Connect map, form toggle, vision rule, change binding |
| `reasoning.js`, `tool-calling.js`, `RossAscends-mods.js`, `slash-commands.js` | non-stream `reasoning_content`, function-calling support, autoconnect, `/model` picker |
| `public/index.html` | source option, `#xiaomi_form` (static fallback list, replaced on Connect), `data-source` on temperature / top P / both penalties / function calling / inline media / image quality / reasoning toggle (+ its "except" note) |
| `public/img/xiaomi.svg` | a copy of `generic.svg` (chat messages load `/img/<source>.svg`); swap for a real mark if one is ever drawn |
| `public/kotatsu/connections/providers.js` | first-party card between xAI and OpenRouter |
| tests | `provider-cards` roster; `preset-byte-identity` gains `FORK_ADDED_SCHEMA_KEYS` (a saved older preset *adds* `xiaomi_model` at its default — additive, asserted byte-exact) |

**Not opted in, on evidence:** multi-swipe (`n` → 400 "n is not supported"), reverse proxy (unverified), `reasoning_effort` (accepted, changes nothing).

### 1.F Claude Sonnet 5.5 (2026-10-04)

Upstream shipped Opus 5.5 (#6070) but not Sonnet 5.5. Same three places #6070 used: `model_claude_select` + caption list option, and `useNativeJsonOutput` (Sonnet 5.5 400s on forced `tool_choice`, so JSON-schema requests use `output_config.format`). Everything else reaches it through upstream's unanchored `isClaude5Model` / `^claude-(…sonnet-5…)` / `includes('claude-sonnet-5')`. **Bridge:** `isThinkingAlwaysOnModel` now covers `sonnet-5-5+` — its thinking-off branch had been sending `{type: 'disabled'}`, which Sonnet 5.5 rejects; it now gets adaptive + low effort like Opus 5.5. When upstream ships Sonnet 5.5, take theirs and drop ours (§4.2 rule 2).

---

## 2. Provider field notes

Operational knowledge from live-fire testing, carried forward from the retired docs. These are the things that cost a debugging session to learn.

### 2.1 Z.AI / GLM 5.3 API dialect

Three separate facts, all **live-verified** against the API during day-one testing of glm-5.3:

**Mandatory thinking.** glm-5.3 cannot disable reasoning. Sending `thinking: { type: 'disabled' }` returns **400 with Z.AI error code 1210** (request-shape rejection). Upstream ST sends exactly that whenever the user toggles reasoning off, so glm-5.3 was 100% broken on upstream. Patch B3 forces `{ type: 'enabled' }` unconditionally for `/^glm-5\.[3-9]/`.

**`reasoning_effort` is a top-level enum of `low | high | max`.** Not nested under `thinking`; not the OpenAI four-value scale. **`medium` is rejected** — also verified via error 1210. ST's internal effort scale is mapped:

| ST effort | → Z.AI |
|---|---|
| `min` | `low` |
| `low` | `low` |
| `medium` | `high` |
| `high` | `high` |
| `max` | `max` |
| `auto` / unset | *omitted* — provider default rules |
| *(reasoning toggled OFF in ST)* | `low` — cheapest available, since off is impossible |

The `auto`/unset case falling through to omission is deliberate: sending nothing is not the same as sending a guess, and Z.AI's own default is the correct answer for "auto."

**⚠️ Error 1210 vs 1220 — the entitlement gate.** These are different failures and confusing them will send you patching code that is already correct.

| Code | Meaning | Fixable in code? |
|---|---|---|
| **1210** | Request-shape rejection (bad `thinking.type`, bad `reasoning_effort` value) | **Yes** — that is what B3 is |
| **1220** | **Account entitlement gate.** Valid, correctly-shaped requests still return 403 | **No. Nothing code-side fixes this.** |

glm-5.3 returned 1220 on this account at patch time. **glm-5.2 works on both endpoints** and is the fallback. The two endpoints are `API_ZAI_COMMON = 'https://api.z.ai/api/paas/v4'` (`chat-completions.js:91`) and `API_ZAI_CODING = 'https://api.z.ai/api/coding/paas/v4'` (`:92`), selected by `request.body.zai_endpoint === ZAI_ENDPOINT.CODING` at `:2466` (`ZAI_ENDPOINT` at `src/constants.js:559`). A coding-plan `glm-5.3[1m]` suffixed ID exists in Z.AI's docs and is **deliberately not added** to the dropdown.

**Probing the Z.AI edge.** Z.AI's edge drops bare `curl` probes. Probe with a small Node `fetch` script instead — same request, but it presents a normal runtime TLS/HTTP fingerprint and gets through. *(Provenance note: this is operator field knowledge from the 5.3 session; an exhaustive grep across `clio-patches/`, both VOIDLIT docs, and all of `../st-fork/` found **no** written source for it, so it is carried here on operator recall alone. Re-confirm with a live probe before relying on it in a diagnosis. (The 1210/1220 distinction above, by contrast, *is* documented — `clio-patches/README.md` ledger and the `fix-gemini36-glm53-2026-08-14.mjs` header.))*

### 2.2 Gemini ≥3.6 model-turn prefill rejection

**The failure.** Gemini 3.6 and newer return **400 "Requests ending with a model turn are not supported."** Google removed model-turn prefill from the API.

**The proof (live-verified, not inferred).** An identical trailing-model-turn request was sent to three models: `gemini-3.5-flash` → **200**; `gemini-3.6-flash` → **400**; `gemini-3.7-flash` → **400**. The break is exactly at 3.6.

**Why it hits SillyTavern hard.** ST prefills a model turn routinely — assistant prefill, and every "Continue" on an existing message. Both produce a `contents` array whose last element is `{ role: 'model', ... }`. So on ≥3.6, *continue was simply broken*.

**The guard regex, exactly:**

```
/^gemini-(?:3\.[6-9]|[4-9])/
```

Its behavior is precisely specified and was asserted by the retired script on every run:

| Model | Matches? | Correct because |
|---|---|---|
| `gemini-3.6-flash` | ✅ | prefill removed |
| `gemini-3.7-flash` | ✅ | prefill removed |
| `gemini-3.8-flash` | ✅ | assumed same as 3.6/3.7 — NOT live-verified (no Google key in dev); guard is regex-covered |
| `gemini-3.5-flash` | ❌ | still prefills — **must be spared** |
| `gemini-3.1-pro-preview` | ❌ | still prefills — **must be spared** |

The `[4-9]` alternative pre-covers Gemini 4 through 9. The `3\.[6-9]` alternative covers only 3.6–3.9. **A `gemini-3.10` would not match** — a real (if unlikely) gap; widen the regex if Google ever ships a two-digit minor.

**What the guard does instead of erroring:** appends a synthetic user turn carrying the literal string

```
[Continue seamlessly from the end of your previous turn without repeating any of it.]
```

This converts a hard 400 into a soft instruction. It is not free — the model sees a bracketed meta-instruction it did not before, which can leak into output on a badly-behaved preset. That tradeoff was accepted knowingly; a 400 is worse than a leak.

**Structural parallel:** Anthropic did the same thing, and upstream handled it the same way — `noPrefillModel` at `chat-completions.js:240`, applied at `:361`, strips a trailing assistant turn for `opus-4-6+`. If a future provider removes prefill, this is the shape to copy.

### 2.3 Claude 5-family capability regexes — which lists a new Claude model must join

**Six backend regexes** in `src/endpoints/backends/chat-completions.js`, all in `sendClaudeRequest`:

1. `:236` `useThinking`
2. `:237` `useWebSearch`
3. `:239` `useVerbosity`
4. `:240` `noPrefillModel`
5. `:241` `isAdaptiveModel` (first alternative only — the `enableAdaptiveThinking` clause stays 4-6/4-6)
6. `:242` `noSamplingModel`

**Plus two frontend lists** in `public/scripts/openai.js`:

7. `:5633` — the 1M max-context regex in `onModelChange`
8. `:6155-6157` — the `isImageInliningSupported` vision array (**string prefixes, not a regex**)

**Not `isLimitedSampling` (`:238`)** — see A2 for why.

**The shared tail is the invariant.** All six backend regexes and the frontend context regex end in `|sonnet-5|opus-5|fable-5)`. That uniformity is deliberate: it makes the whole family greppable and countable in one command, and it is what let the retired script assert `expected 6 capability-regex tails`. **Preserve it.** When you add a model, append to the tail consistently in all seven places, or you lose the invariant and the smoke test with it.

### 2.4 ST secrets format — schema only

Provider API keys live in `data/<user>/secrets.json`. Since 1.18's key-rotation feature the shape is **array-of-objects per key**, not a flat string map (`src/endpoints/secrets.js:76-96`):

```jsonc
{
  "<secret_id>": [
    { "id": "string", "value": "string", "label": "string", "active": true },
    { "id": "string", "value": "string", "label": "string", "active": false }
  ]
}
```

Typedefs: `SecretValue {id, value, label, active}`; `SecretKeys = {[key: string]: SecretValue[]}`; `FlatSecretKeys = {[key: string]: string}` is the **legacy pre-1.18 shape**. `_migrated` is the migration sentinel; `migrateFlatSecrets()` at `secrets.js:498` converts old installs, backing up first.

`SECRET_KEYS` (`secrets.js:9`) holds 62 entries. The ones this document's providers use: `CLAUDE: 'api_key_claude'` (`:18`), `MAKERSUITE: 'api_key_makersuite'` (`:27`), `VERTEXAI: 'api_key_vertexai'` (`:28`), `XAI: 'api_key_xai'` (`:58`), `ZAI: 'api_key_zai'` (`:66`).

Backend reads go through `readSecret(request.user.directories, SECRET_KEYS.X, request.body.secret_id)` — the `secret_id` argument is what selects a rotation entry.

> 🔴 **Never quote a real secret value into this repo, a commit message, a log, or a chat.** Schema only. Also be aware that credentials leak into three places beyond `secrets.json`: `settings.json → proxies[]` stores **plaintext proxy passwords**; chat-completion **presets serialize `reverse_proxy` and `proxy_password` in plaintext** — `getChatCompletionPreset` (`openai.js:4501-4507`) copies every key in `settingsToUpdate`, which includes both (`:369`, `:378`), so sharing a preset shares the proxy password; and `*.before-*.bak` files in the data root hold live credential material in the same shape. Kotatsu's dev `data/` is gitignored — keep it that way.

### 2.5 Xiaomi MiMo API dialect (live-probed 2026-10-04)

OpenAI-compatible at `https://api.xiaomimimo.com/v1`, Bearer key. Measured against the live API, not docs:

- **`/models`** returns chat ids *and* `-tts` / `-asr` / `-tts-voiceclone` / `-tts-voicedesign` ids, with no context sizes. On 2026-10-04: `mimo-v2.6-pro`, `mimo-v2.6-pro-ultraspeed`, `mimo-v2.6-flash`, `mimo-v2.5-pro`, `mimo-v2.5` (+ 4 audio ids).
- **Context:** 1M / 128K output for v2.6 Pro, v2.6 Flash, v2.5 Pro, v2.5 (Xiaomi's model pages, `mimo.mi.com/models/en-US/<id>`).
- **Reasoning:** `reasoning_content` on the message and on stream deltas; `usage.completion_tokens_details.reasoning_tokens`. `thinking: {type: 'disabled'}` → 0 reasoning tokens. `reasoning_effort` is accepted and ignored.
- **Samplers:** `temperature` must be within **[0, 1.5]** (1.8 and 2.0 → 400 `Param Incorrect`). `top_p`, `top_k`, both penalties, `seed`, `logit_bias`, `stop` accepted. **`n` → 400 "n is not supported".**
- **Tools:** OpenAI `tools` / `tool_choice: 'auto'` → proper `tool_calls`. **JSON:** `response_format: {type: 'json_schema', ...}` honoured.
- **Images:** `image_url` data URIs work on every v2.6 id (incl. pro-ultraspeed); `mimo-v2.5-pro` → 404 "No endpoints found that support image input".
- **Usage:** standard shape, `prompt_tokens_details.cached_tokens`; `stream_options.include_usage` emits a final usage chunk.
- Consecutive same-role turns and a trailing assistant turn are accepted (no prefill semantics).

A new MiMo model needs **nothing** for the picker (it comes from `/models`); check only whether it reads images (the vision rule in `isImageInliningSupported`) and its context (the 1M rule in `onModelChange`).

---

## 3. How to add a model in Kotatsu

**First, always: check whether upstream already did it.** `git log upstream/staging --oneline -- public/index.html public/scripts/openai.js src/endpoints/backends/chat-completions.js`. Cherry-picking upstream's version is strictly better than writing our own — it is the merge lane working as designed (§4).

**Refresh rules, both cases (from the retired scripts' own closing output):**
- Edited `public/**` only → **hard-refresh the ST tab** (Ctrl+Shift+R). No restart.
- Edited `src/**` → **restart the server.** Config and module-level `const`s are read at load; a reload does nothing.
- Edited both → do both.

**Verify before "done":** `npm run lint`, Jest (`tests/` — `prompt-converters.test.js` carries 144 tests guarding exactly this layer), and boot `node server.js` → hit `http://localhost:8000` and send one real message on the new model. Live proof, not vibes.

### 3.1 A new Claude model

Eight edit sites. Miss one and you get a *silent* capability gap, not an error.

1. **Dropdown** — `public/index.html`, `<select id="model_claude_select">` (`:3177`). Add `<option value="claude-X">claude-X</option>` in the Versions optgroup, newest at top (`:3179-3181` region for opus/fable, `:3186` region for sonnet).
2. **`useThinking`** — `chat-completions.js:236`, append to the tail.
3. **`useWebSearch`** — `:237`.
4. **`useVerbosity`** — `:239`.
5. **`noPrefillModel`** — `:240` (only if the model rejects assistant prefill — check the API docs; this is the Anthropic analogue of §2.2).
6. **`isAdaptiveModel`** — `:241`, **first alternative only**.
7. **`noSamplingModel`** — `:242` (only if the model rejects `temperature`/`top_p`).
8. **1M context** — `public/scripts/openai.js:5633`, append to the tail. Only if the model actually has a 1M window; otherwise it falls through to `max_200k` at `:5636`, which is correct for older Claudes.
9. **Vision list** — `public/scripts/openai.js:6155-6157`. **Do not skip this.** Add the shortest unambiguous prefix (`'claude-fable'` covers all fable variants). Silent failure mode.

Do **not** add to `isLimitedSampling` (`:238`).

**Post-edit assertion** — the invariant from §2.3:
```
grep -c "|sonnet-5|opus-5|fable-5)" src/endpoints/backends/chat-completions.js public/scripts/openai.js
```
should still read `6` and `1` with your new ID inside each tail. Then: restart server + hard-refresh.

### 3.2 A new GLM / Z.AI model

1. **Dropdown** — `public/index.html`, `<select id="model_zai_select">` (`:3961`), above the next-lower version.
2. **Max context** — `public/scripts/openai.js`, `getZaiMaxContext` `contextMap` (`:5164` region). **Exact string key**, no regex fallback — an unlisted GLM silently gets the map default. Use `max_1mil` (`:135`) or `max_200k` (`:132`).
3. **Dialect gate** — `chat-completions.js:2480`, `/^glm-5\.[3-9]/`. Already covers 5.4–5.9. **A glm-6.x needs an explicit decision**, not a regex widening: re-probe whether thinking is still mandatory and whether the `low|high|max` enum still holds (§2.1) before extending.
4. **Endpoint** — confirm the model exists on the endpoint you use (`API_ZAI_COMMON` vs `API_ZAI_CODING`, `chat-completions.js:91-92`). A model on one and not the other looks like an auth failure.

Restart server + hard-refresh. If you get a 403 on a request that validates, **check for error 1220 before touching code** — that is entitlement, not a bug (§2.1).

### 3.3 A new Gemini model

Usually the cheapest case — often **dropdown-only**.

1. **Dropdown, BOTH selects** — `public/index.html:3315` (`model_google_select`, `:3313`) *and* `:3500` (`model_vertexai_select`, `:3497`). The retired script asserted exactly 2 anchors for this reason. **Forgetting the Vertex one is the classic miss.** Mind the stale optgroup label (§1.C).
2. **Assert, don't assume, the two upstream regexes cover the new ID:**
   - `public/scripts/openai.js:5046` — `/gemini-(?:3[.\d]*|2\.(?:5|0))-(pro|flash)/` → 1M context.
   - `src/endpoints/backends/chat-completions.js:498` — `/^gemini-3[.\d]*-(flash|pro)/` → `thinkingConfig`.

   If the new ID is `gemini-3.8-flash`-shaped, both match and there is **no JS or backend edit at all**. If it is `gemini-4-pro` or an `-image` variant, neither holds — check `:5045` (`gemini-3-pro-image` → `max_64k`) and the `-image(-preview)?$` exclusion at `:498`, and add an explicit entry to the ordered `[RegExp, number][]` map (`:5043-5052`). Order matters in that array — first match wins.
3. **Prefill guard** — `src/prompt-converters.js:621`, `/^gemini-(?:3\.[6-9]|[4-9])/`. Covers 3.6–3.9 and 4–9. Verify a new ID matches; a `gemini-3.10` would **not** (§2.2).

Dropdown-only change → hard-refresh suffices. Any `src/` touch → restart.

### 3.4 A new Grok / xAI model

Four sites, all keyed on the same shared regex `/(?:^|\/)grok-4\.5(?:$|[-:])/`: `openai.js:2901` and `:2925`; `chat-completions.js:1179`, `:2533`, and `:2601`. If a new Grok reasoning model lands, generalize that regex **in all five places at once** or the frontend and backend will disagree about what to strip. Keep the `(?:^|\/)` prefix tolerance — gateway-prefixed IDs are a real path (A3).

---

## 4. Upstream merge policy

### 4.1 The rule

**Merge the model layer; own the shell layer.**

`src/endpoints/backends/chat-completions.js` (2,929 LOC, twelve copy-pasted `sendXRequest` functions and a 360-line `else if` ladder) is genuinely bad code, and a provider-adapter interface would be the single highest-leverage refactor available. **Do not do it.**

The reason is arithmetic, not taste (`../st-fork/SPEC.md:17,59`, `../st-fork/maps/engine-review.md:553-599`): **13.6% of upstream commits are provider/model maintenance** — new models, changed vendor wire formats, cache-control semantics, thinking-budget rules — landing in a small set of well-tested, mostly-pure files (`openai.js`, `chat-completions.js`, `prompt-converters.js`, `textgen-settings.js`), guarded by 144 unit tests. That is permanent free value with **zero UX opinion**, i.e. nothing Kotatsu exists to overrule.

A refactor converts that stream from *merge* to *re-implement, forever*. So: **the provider registry stays structurally unrefactored on purpose.** Carry our patches as real commits, rebase them over upstream, and keep conflicts confined to regex lines and dropdown entries — which is exactly what `a4c64666c` is built to do.

By contrast `public/index.html` (~90 upstream touches / 6 months, part of the 17.5% UI-shell churn) is the layer Kotatsu *does* overrule. Our four dropdown hunks there are merge-lane work, not shell work, and should be kept minimal and upstream-shaped so they never entangle with a shell redesign.

Revisit only if upstream goes dead for good. It went ~5 weeks quiet once already — **watch, don't assume.**

### 4.2 Handling a conflict in `chat-completions.js`

This file is **the highest-risk merge point in the repo** — it carries both patch families and it is where upstream does its most frequent work.

**Before merging**, snapshot the patch surface:

```
grep -rn "KOTATSU-PATCH\|VOIDLIT-PATCH" src/ public/          # expect 8 total
grep -c "|sonnet-5|opus-5|fable-5)" src/endpoints/backends/chat-completions.js public/scripts/openai.js
                                                            # expect 6 and 1
grep -n "grok-4\.5" src/endpoints/backends/chat-completions.js public/scripts/openai.js
                                                            # expect 3 and 2
```

**Resolving:**

1. **Identify which family the conflicting hunk belongs to.** Use §1's inventory — remember §1.0: **half our hunks carry no marker**, so a conflict in the Grok blocks or the Claude regex block will look like unattributed local churn. It isn't.
2. **If upstream shipped the same model we patched in** — the common case — **take upstream's version wholesale and drop ours.** That is the merge lane paying out. Verify the capability lists still cover our IDs, then delete the now-redundant local edit. Prefer upstream's exact spelling even if ours was equivalent; it minimizes the *next* conflict.
3. **If upstream refactored around our hunk**, re-apply ours in upstream's new idiom rather than restoring our old lines. Our Grok CUSTOM passthrough (A5) was deliberately written to mirror upstream's adjacent `koboldcpp/` block for exactly this reason — copy the local idiom, always.
4. **Never `git checkout --theirs`/`--ours` this whole file.** The retired `clio-patches/README.md` carried this warning and it survives verbatim: `chat-completions.js` holds **both** families, so a blanket reset silently drops the other one. Resolve hunk by hunk.
5. **Re-run the three greps above** and diff the counts against the pre-merge snapshot. A count that dropped is a patch you lost.
6. `npm run lint` + Jest + a live boot, per §3.

**Ordering hazard.** Patch B3 (glm dialect) works by **overwriting** the `bodyParams` object upstream assigns immediately above it (`chat-completions.js:2472-2476` → `:2480`). If a merge moves either block, the overwrite can end up ordered *before* the assignment and silently stop working — the request just goes back to upstream's broken shape. After any merge touching the ZAI branch, confirm the CLIO block still sits **after** the `bodyParams = { thinking: ... }` literal.

---

## 5. Retired mechanisms

Two mechanisms previously maintained these patches. **Neither is part of this repo.** Both may still exist in an older live install and are still correct *there* — such an install remains an update-and-re-apply workflow.

| Retired | Lived at (live install) | Superseded here by |
|---|---|---|
| `VOIDLIT-PATCHES.md` (277 B) + `data/default-user/extensions/voidlit-echoes/PATCHES.md` | repo root + extension dir | §1.A, §2 |
| `clio-patches/*.mjs` (idempotent re-apply scripts) + its `README.md` ledger | `clio-patches/` (untracked, survived `git pull`) | §1.B–D, §3 |

> ⚠️ **An older live install (a separate stock SillyTavern checkout) may be in daily use. Never develop in it; never point Kotatsu at its `data/`.** Its copies of these files are read-only reference material for this document.

**Why they were retired.** Both existed to solve one problem: *ST updates overwrite untracked edits to tracked files.* Kotatsu solves that structurally — the patches are **real commits on a real fork with a real `upstream` remote**, so an update is a rebase, not a re-application. Idempotent repair scripts become unnecessary the moment the edits are version-controlled.

**What was carried forward, and what was not:**
- **Carried:** every field note in §2 (the 1210/1220 distinction, the live-verified 3.5-vs-3.6 probe, the regex sparing behavior, the `usage`/streaming scope note, the unpatched `:747` sibling, the "don't blanket-reset `chat-completions.js`" warning).
- **Not carried:** `apply-claude-code-rp.mjs` and `clio-patches/claude-code-rp/`. That is a **server plugin** (a bearer-protected loopback OpenAI API at `127.0.0.1:5107/v1` plus a Connection Manager profile), owns no tracked core file, and is out of scope for the provider layer. It stays live-install-only.

**Gaps in the retired mechanism, recorded so they are not repeated.** These are real discrepancies found while writing this document:

1. **`VOIDLIT-PATCHES.md` documented only one of its three patch groups.** Both VOIDLIT docs cover *only* the `usage` preservation patch (A1). The **Claude 5-family capability regexes (A2)** and **all four Grok 4.5 hunks (A3–A6)** — attributed to the VOIDLIT family by `a4c64666c`'s own commit message — appear in **no** retired document, carry **no** in-code marker, and had **no** re-apply script. They were hand-applied and undocumented. An ST update would have wiped them with nothing to detect the loss. **This document is their first written provenance.**
2. **The `clio-patches/README.md` ledger omitted `add-opus5-2026-08-16.mjs` entirely** — no table row — and its "after every SillyTavern update, re-apply everything" instruction listed only **two** of the four scripts (`add-models` and `apply-claude-code-rp`), silently omitting `fix-gemini36-glm53` and `add-opus5`. Following the documented procedure would have restored roughly half the patches.
3. **The `grep -rn "KOTATSU-PATCH" public/scripts/openai.js` liveness check was structurally incomplete** — it covers 5 of 16 hunks. §1.0 replaces it with an honest inventory plus counted assertions.

Together these are the argument for this document existing: the retired mechanisms tracked *scripts*, and anything applied by hand fell through. A commit tracks everything, and the inventory in §1 is auditable against `git show`.

---

## Appendix — quick reference

**Files in the provider surface:**

| File | Role | Our hunks |
|---|---|---|
| `public/index.html` | model `<option>` dropdowns | 4 |
| `public/scripts/openai.js` | frontend request shaping, context maps, vision list | 5 |
| `src/endpoints/backends/chat-completions.js` | 26-provider backend registry | 6 |
| `src/prompt-converters.js` | per-vendor prompt format conversion | 1 |

**Every regex we own, exactly:**

| Purpose | Regex | Site |
|---|---|---|
| Claude thinking | `/^claude-(3-7\|opus-4\|sonnet-4\|haiku-4-5\|opus-4-5\|opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` | `chat-completions.js:236` |
| Claude web search | `/^claude-(3-5\|3-7\|opus-4\|sonnet-4\|haiku-4-5\|opus-4-5\|opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` | `:237` |
| Claude verbosity | `/^claude-(opus-4-5\|opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` | `:239` |
| Claude no-prefill | `/^claude-(opus-4-6\|sonnet-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` | `:240` |
| Claude adaptive / no-sampling | `/^claude-(opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` | `:241`, `:242` |
| Claude 1M context (frontend) | `/^claude-(sonnet-4-5\|sonnet-4-6\|opus-4-6\|opus-4-7\|opus-4-8\|sonnet-5\|opus-5\|fable-5)/` | `openai.js:5633` |
| Grok 4.5 | `/(?:^\|\/)grok-4\.5(?:$\|[-:])/` | `openai.js:2901`, `:2925`; `chat-completions.js:1179`, `:2533`, `:2601` |
| GLM 5.3+ dialect | `/^glm-5\.[3-9]/` | `chat-completions.js:2480` |
| Gemini prefill guard | `/^gemini-(?:3\.[6-9]\|[4-9])/` | `prompt-converters.js:621` |

**Upstream regexes we depend on but do not own** (assert, never edit):

| Purpose | Regex | Site |
|---|---|---|
| Gemini 1M context | `/gemini-(?:3[.\d]*\|2\.(?:5\|0))-(pro\|flash)/` | `openai.js:5046` |
| Gemini `thinkingConfig` | `/^gemini-3[.\d]*-(flash\|pro)/` | `chat-completions.js:498` |
| Claude `isLimitedSampling` | `/^claude-(opus-4-1\|sonnet-4-5\|haiku-4-5\|opus-4-5\|opus-4-6\|sonnet-4-6)/` | `chat-completions.js:238` |

**Remotes:** `upstream` = `github.com/SillyTavern/SillyTavern` · `origin` = the private development remote · `local-st` = the live install (historical; never push).
