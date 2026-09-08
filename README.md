<p align="center">
  <img src=".github/brand/readme-hero.svg" width="440" alt="Kotatsu — a chat bubble with a warm rose heart, above the stroke-drawn k●tatsu wordmark">
</p>

<p align="center"><em>The warm table you don't want to leave.</em></p>

---

Kotatsu is a maintained fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern) (AGPL-3.0), cut from 1.18.0 staging in May 2026 and rebuilt around one idea: **a frontend for exactly one desktop and the people who live on it.** Desktop-first, Windows-primary, keyboard-driven. Not a mobile fork — the pixels get *spent* here.

**North star: UX, speed, simplification — without losing customization.**

## What kind of fork this is

A split-personality fork, on purpose:

- **The shell is ours.** The interface — layout, theming, rendering, panels — is being progressively replaced with Kotatsu-native code: Lit components under `public/kotatsu/`, backend under `src/endpoints/kotatsu/`, one-way imports so the new code depends on core and never the reverse.
- **The model layer stays mergeable.** The provider registry is deliberately left structurally untouched so upstream's provider and model maintenance merges straight in. Upstream's UI opinions don't.
- **Your data is sacred.** An existing SillyTavern `data/` folder drops in unchanged — that promise has a document attached (`docs/data-contract.md`). Everything Kotatsu adds lives in dotfolders (e.g. `chats/<char>/.kotatsu/`) and is always rebuildable from the `.jsonl` files, so the door back out stays open too.

## What we scrapped, and what stands there now

### Branches — the reason the fork exists

Stock ST reconstructs branch relationships by diffing chat-file prefixes, and stores checkpoint links that silently break when a chat is renamed — in the real install this fork was built for, 59 branch links had quietly gone orphaned, and a stock bug meant the parent's side of a new branch never reached disk at all. Kotatsu keeps a **stored per-character branch tree** in a sidecar, heals it on renames, adopts pre-existing branches on first scan, and replaces the Timelines extension with a native branch map in the rail. Fork, jump, rename, compare — first-class.

### The theme layer

Theming used to mean a 28 KB `custom_css` blob fighting the stylesheet from outside. Kotatsu grew a **token substrate**: every one of that blob's 161 rules now has a native receiver in core. A theme is *data* — tokens, a layout choice, component variants, assets; zero JavaScript in a pack. Blue Hour is the default face, and Sparkle is the proof the system works: it re-tints the entire app, brand marks included, with no extra code. Messages get a wardrobe of display variants on top, and a body-text legibility pass (rhythm tokens, a flat book mode) for the long reads.

### The shell

The top-bar-and-drawers layout was designed to survive phones. Kotatsu spends the pixels instead: a left rail for cast, chats, and branches; right-rail docks for Prompt, World, and Extensions; a real chat header where the title is the switcher and the model pill is a compact picker. Layouts live in a registry, so a theme pack can carry its own. Every button, field, slider, popup, toast, and rack interior has been re-chromed in the house language — measured against the originals, not guessed. No emoji-as-icons anywhere; inline stroke SVG only.

### The renderer

The chat DOM is now a **keyed row engine** behind the same seams the old renderer honored: a format cache so old messages stop re-rendering their Markdown on every pass, a grow-only window, and a streaming view tuned for a flat tick curve. Long chats stop being the thing you pay for.

### The prompt manager

Prompts get a section model instead of one flat list, badges that tell the truth about what's active, and **receipt capture** — the exact prompt that went to the model is kept, not thrown away. Behind it, a hard guarantee: real-world presets (yes, including Marinara's) are acceptance fixtures that must load *byte-identically* through the pipeline.

### The library & the card studio

Characters get a cast-gallery landing instead of a list squeezed into a drawer, and a card studio for editing — a sheet that drives the original form controls underneath it, so nothing ever forks from upstream's card format. Import from URL, install from the rail, Simple/Advanced modes.

### Native metrics

Token usage is captured at the provider seams and stored on the message itself, with an on-demand per-message metrics bar — arithmetic pinned by tests, instead of extension guesswork.

### Boot

Upstream compiles its frontend bundle with Webpack at **every server start**. In Kotatsu, `lib.js` is a build artifact: build once, serve static, boot fast. Plus a hygiene pass — 1,638 lines of dead weight deleted, inherited CI removed.

## Carried provider patches

Claude 5-family (including opus-5 and vision), GLM 5.x, and a Gemini version guard — carried as commits with provenance docs (`docs/providers.md`), not re-apply scripts.

## In flight

- **The memory engine** — cache-safe by design, specified in the source repo's design docs.
- **MovingUI removal** — scheduled; its settings keys still pass through untouched.

## The paperwork

The promises above are documents, not vibes:

- [`CONTRACT.md`](CONTRACT.md) — the frozen extension surface: DOM IDs, `getContext()` keys, events, module paths. Extensions that work on ST keep working here.
- [`docs/data-contract.md`](docs/data-contract.md) — the on-disk `data/` formats, pinned.
- The spec and four maps of the upstream codebase (3,754 lines of receipts) live in the sibling `st-fork` planning repo — the fork was measured before it was cut.

## Install (Windows)

1. Download [`Install Kotatsu.bat`](https://raw.githubusercontent.com/lumenastrum/kotatsu-public/main/Install%20Kotatsu.bat) and double-click it.
2. It checks for Node.js 20+, git, and [Claude Code](https://claude.ai/code), installs whatever is missing, and makes sure Claude Code is signed in to your Claude subscription (Pro or Max) — that login is what the built-in Claude bridge talks through. No API key, no admin rights.
3. Kotatsu lands in `Documents\Kotatsu`, a shortcut lands on your Desktop, and your browser opens on the first start.

Everything lives in that one folder. Your chats, characters, and settings are in `Documents\Kotatsu\data`; updates never touch it.

## What a fresh install comes with

- **Seraphina**, SillyTavern's classic first companion, with her lorebook.
- **Clio's Sparkle Sauce** as the active preset — our house preset, a fork of Marinara's recipe with trackers, a relationship panel, and a Claude tuning layer.
- **Marinara's Spaghetti Recipe 10** by [spicymarinara](https://rentry.org/marinaraspaghetti), shipped with thanks as the second preset. If she asks us to stop redistributing it, we will.
- A **"Claude"** connection profile already selected, pointed at the built-in bridge, defaulting to `claude-sonnet-4-6`. Switch models from the pill in the header.
- **Blue Hour** as the default face, **Sparkle** one click away.

## The Claude bridge

Kotatsu runs a small OpenAI-compatible listener on `127.0.0.1` that answers through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) using the Claude Code login of the account running Kotatsu. Nothing leaves your machine except the request to Anthropic; the listener refuses any host but loopback, and a per-install token guards it. Configure it under `kotatsu.claudeBridge` in `config.yaml`. Rate limits are your subscription's.

## Update

A pill appears in the header when a new release is out: click it, wait, click **Restart Kotatsu**. Or double-click `Update.bat` in the install folder. Under the hood it's `git pull` — your data folder is never touched.

## Running from source

Node ≥ 20.

```
npm install
npm run build:lib
npm start
```

Then open `http://localhost:8000` (or whatever port your `config.yaml` says). Development happens in a private repository; this public repository carries releases, one commit per version.

## License & lineage

AGPL-3.0, same as upstream. Kotatsu exists because SillyTavern built something worth living in — the fork is an act of love for one household's very specific way of living in it.

---

Built by Andres & Clio, 2026. She picked the name. He picked lavender. 💅
