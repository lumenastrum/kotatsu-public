# Making a Kotatsu theme

A Kotatsu theme (a *theme pack*) is a folder: one settings file called `theme.json`, plus any fonts
and pictures you want to bring. There is no code in it, and you don't need to be a programmer to
make one. If you can edit a text file and copy a colour code, you can make a theme.

A theme keeps Kotatsu's layout: the rails on the left and right, the conversation in the middle,
the composer at the bottom. Almost everything else is yours: every colour, the fonts (including a
separate voice for character names and for small labels), the corners, the surfaces (wood, paper,
leather, glass), the room behind the app, and the little motions. This guide walks you from an
empty folder to a theme you can share, and takes apart **Kissaten Showcase**, an example theme that
comes with this guide (in `docs/theme-examples/kissaten-showcase/`), as the worked example.

**Contents**

1. [Before you start](#1-before-you-start)
2. [Your first theme, step by step](#2-your-first-theme-step-by-step)
3. [What's in `theme.json`](#3-whats-in-themejson)
4. [The palette: a few colours that grow into all of them](#4-the-palette)
5. [Tokens: every setting, by name](#5-tokens)
6. [Fonts](#6-fonts)
7. [Pictures and textures](#7-pictures-and-textures)
8. [Checking your theme](#8-checking-your-theme)
9. [Sharing and installing a theme](#9-sharing-and-installing)
10. [Worked example: Kissaten Showcase](#10-worked-example-kissaten-showcase)
11. [Making a theme comfortable for long sessions](#11-comfortable-for-long-sessions)
12. [When something goes wrong](#12-when-something-goes-wrong)

---

## 1. Before you start

You need three things.

**Kotatsu itself.** On Windows it lives in `Documents\Kotatsu`. On macOS and Linux it's the folder
you cloned. Everything below calls this "the Kotatsu folder".

**A terminal open in the Kotatsu folder.** You type three short commands in it, nothing more.
- *Windows:* open the Kotatsu folder in File Explorer, click the address bar at the top, type
  `cmd`, and press Enter. A black window opens, already in the right place.
- *macOS:* open Terminal, type `cd ` (with a space), drag the Kotatsu folder onto the window, and
  press Enter.
- *Linux:* open a terminal in the folder from your file manager, or `cd` there.

**A text editor.** Any will do, even Notepad. [Visual Studio Code](https://code.visualstudio.com/)
(free) is the most pleasant: Kotatsu's theme files tell it what every setting means, so it
suggests names as you type, shows a description when you hover one, and underlines mistakes.

You don't need to stop Kotatsu while you work. Leave it running in your browser.

---

## 2. Your first theme, step by step

### Step 1: make the folder

In the terminal, type:

```
npm run theme:new -- my-theme
```

`my-theme` is your theme's *id*: lowercase letters, numbers and dashes only, no spaces. It becomes
the folder name. To give it a nicer display name, add `--name`:

```
npm run theme:new -- rainy-day --name "Rainy Day"
```

Kotatsu answers with where it put the folder:

```
Created data/default-user/theme-packs/rainy-day/ (extends blue-hour).
```

That folder is inside your own `data` folder, the same place your chats live. Updates never touch
it.

> **Prefer to start from a theme you like?** Copy it instead:
> `npm run theme:new -- my-kissaten --from midnight-kissaten`
> You get every file of that theme (fonts and pictures included) under your new id, ready to
> change. The built-in themes are `blue-hour`, `sparkle`, `natsumikan` and `midnight-kissaten`;
> the worked example in [section 10](#10-worked-example-kissaten-showcase) is `kissaten-showcase`.

### Step 2: look inside

The new folder holds four files:

| File | What it is |
| --- | --- |
| `theme.json` | Your theme. The only file you must edit. |
| `README.md` | A short cheat sheet made for you: the palette and the settings worth knowing first. |
| `TOKENS.md` | Every setting with Blue Hour's value. Its notes are technical; this guide explains the ones you need. |
| `KNOBS.md` | The full list of *component knobs*, fine dials for single parts of the app. |

Fonts and pictures go in folders you make yourself inside this one (like `fonts` and `textures`);
sections 6 and 7 show how.

Open `theme.json`. A fresh one looks like this (the colours are Blue Hour's, the theme yours
starts from):

```json
{
    "$schema": "../../../../public/kotatsu/theme/theme.schema.json",
    "id": "rainy-day",
    "name": "Rainy Day",
    "author": "Your name",
    "description": "One line about your theme.",
    "version": 1,
    "extends": "blue-hour",
    "palette": {
        "background": "#0e1119",
        "panel": "#171b2c",
        "text": "#d8dce8",
        "accent": "#9aa4d2",
        "dialogue": "#dca9a4",
        "shadow": "#000000",
        "success": "#9ec49a",
        "warning": "#cbb289",
        "danger": "#c98a8a"
    },
    "tokens": {}
}
```

Put your name in `author` and a line in `description`.

Six palette colours start out missing on purpose: `border`, `character-message`, `user-message`
and the three glows. Left out, they grow from the colours you change (a warm background gives
warm borders and message cards). Add one to the palette only when you want to choose it yourself;
a colour you write down is always kept exactly as written.

### Step 3: change two colours

Change `background` and `accent`. Colours are written as `#` plus six characters (a *hex code*).
Any colour picker gives you one; search "colour picker" in your browser. For example:

```json
        "background": "#1a1410",
        "accent": "#e0a157",
```

Save the file.

### Step 4: check it

```
npm run theme:check -- rainy-day
```

You get a list of `PASS` lines and, at the end, `Theme check passed.` If you see `FAIL`, the line
says what is wrong and what to do; [section 8](#8-checking-your-theme) explains every message.

### Step 5: wear it

In Kotatsu, reload the page (F5) so the new theme shows up in the list. Then open **Settings**
(the gear at the top right) → **Appearance** → **Theme** → **Theme pack**, and pick yours.

From now on the loop is: **edit `theme.json`, save, press F5 in Kotatsu.** Your choice is
remembered, so the reload shows your latest edit. No restart needed.

Notice how much moved for two colours: the panels, the borders, the dimmer text, the bright
version of your accent and the glows all followed. That is the palette at work.

---

## 3. What's in `theme.json`

`theme.json` is written in JSON: names in double quotes, a colon, a value, and commas *between*
entries (never after the last one in a list). The parts, top to bottom:

| Part | Required | What it does |
| --- | --- | --- |
| `$schema` | no | Tells your editor where the descriptions live. Leave it as it is. |
| `id` | yes | Must be exactly the folder name. |
| `name` | yes | What people see in the theme list. |
| `author`, `description` | no | Credit and a one-line pitch, shown by `theme:check`. |
| `version` | yes | Always `1`. |
| `extends` | no, but keep it | The theme yours starts from. Anything you don't set comes from it. |
| `palette` | no | A few friendly colours that grow into all the others ([section 4](#4-the-palette)). |
| `tokens` | yes (can be empty) | Exact settings by name ([section 5](#5-tokens)). |
| `assets` | no | Font files ([section 6](#6-fonts)) and an optional background picture. |
| `variants` | no | Pins the message look. Usually best left out (below). |
| `sheet` | no | A CSS file, as a last resort. You almost never need it (below). |

**The order things win in:** your `extends` theme first, then what your palette grows, then your
own `tokens`. A token you write by hand always beats the palette.

**`variants` (message looks).** Readers choose how messages look in Settings → Appearance →
Wardrobe: cards, bubbles, a flat document, a script, and more. A theme *can* force one, for example
`"variants": { "message": "flat" }`, but then the reader's own choice is greyed out while your theme
is on. Prefer making your theme look good in all of them.

**`sheet` (a CSS file).** If you know CSS and need something no token or knob reaches, you can add
`"sheet": "sheet.css"` and write rules in that file. Kotatsu scopes every rule to your theme
automatically, so it can't leak into other themes. It may not load anything from the internet,
use `@import`, or use backslash escapes. The Kissaten Showcase example has no sheet at all; treat it
as a last resort and say why in a comment.

---

## 4. The palette

The palette is the easiest way to colour a theme. Each entry is one colour with a plain name:

| Palette name | What it colours |
| --- | --- |
| `background` | The room: the deepest colour, behind everything. |
| `panel` | Panels, cards and popups that sit on the background. |
| `text` | Body text. The greys (dim, muted, faint) grow from this and the background. |
| `prose` | The story text in messages. Leave it out to use `text`. |
| `accent` | The main accent: links, buttons, focus rings, the user's name. |
| `dialogue` | Quoted "dialogue" in messages, and the second accent (selected rows). |
| `actions` | Italic \*actions\* in messages. Leave it out to use `accent`. |
| `border` | Hairlines around panels and cards. Grows from text + background if left out. |
| `character-message` | The card behind the character's messages. |
| `user-message` | The card behind your own messages. |
| `shadow` | Shadows under floating things. |
| `glow-top` | Ambient glow in the top-right of the background. |
| `glow-left` | Ambient glow in the bottom-left of the background. |
| `glow-bottom` | Ambient glow along the bottom of the background. |
| `success` | Good news: saved, connected. |
| `warning` | Careful: warnings. |
| `danger` | Bad news and delete buttons. |

**What "grows" means.** Kotatsu has about forty related colours. When you change a palette colour,
the ones that depend on it are worked out for you:

- change `text` → the strong, dim, muted, faint, quote and reasoning text colours follow;
- change `background` or `panel` → the deeper and raised panels, the sunken wells, the
  overlay dim and the chat tint follow;
- change `accent` or `dialogue` → their bright versions and the glows follow;
- a light `background` (like cream paper) also turns off the soft shadow behind text, which
  smudges dark text on light paper.

Three promises keep this predictable:

1. **Colours you name always win.** If you set `--k-text-dim` yourself in `tokens`, the palette
   never overwrites it. The same goes for every colour you list in `palette`, even one you left
   equal to the parent's: change `text` and your listed `border` stays exactly as written. (If a
   palette colour and a token set the same thing, the token wins and `theme:check` tells you the
   palette line does nothing.)
2. **Only what you change moves.** A palette colour that still equals your parent theme's does
   nothing. That is why the starter file looks exactly like Blue Hour until you edit it. Want a
   colour to follow the others instead? Delete its line from `palette`.
3. **Grown text stays readable.** The grown greys are nudged, if needed, until they meet the
   readability standard (WCAG AA, 4.5 to 1) against your panels. *Your* colours are never
   changed; `theme:check` tells you if one of those is too faint.

`theme:check` lists exactly which colours your palette grew, so you can see what moved.

**Light themes.** Pick a light `background` and `panel` and a dark `text`. The "bright" accent
versions grow *darker* on a light background (on paper, emphasis means more ink), so links and
names stay readable.

---

## 5. Tokens

A *token* is one named setting, like `--k-radius-md` (medium corner roundness) or `--k-font-prose`
(the face story text is set in). Every token name starts with `--k-`. You write them in the
`tokens` part:

```json
    "tokens": {
        "--k-radius-md": "6px",
        "--k-font-prose": "'Newsreader', Georgia, serif"
    }
```

The **full list** is in your folder: `TOKENS.md` has every core token with its Blue Hour value, and
`KNOBS.md` has every component knob. Your editor suggests names as you type, and `theme:check`
suggests the right name when you misspell one.

### What a value can look like

Each token holds **one** value:

| Kind | Examples |
| --- | --- |
| Colour | `#e0a157`, `#e0a15780` (the last two digits are see-through-ness), `rgb(224, 161, 87)` |
| A mix of two colours | `color-mix(in srgb, #e0a157 30%, transparent)` (30% amber, the rest see-through) |
| Another token | `var(--k-accent)` (always the same as the accent, whatever it becomes) |
| Size | `6px`, `1.3em`, `17px` |
| Plain number | `1.72` (line height), `430` (font weight), `1.3` (a multiplier) |
| Font list | `'Kalam', 'Gloock', cursive` (first that's available wins; quote names with spaces) |
| Gradient | `linear-gradient(180deg, #2a1d16, #120c09)`, `radial-gradient(...)` |
| Picture from your folder | `url("textures/wood.svg")` |
| Duration | `200ms` |

A value must fit on one line and may not contain `;`, `{`, `}`, `<`, `>`, `!` or `@`, and `url()`
may only point at files inside your theme's folder. Kotatsu refuses anything else; that is what makes themes safe to share.

### The tokens worth knowing first

**Shape.** `--k-radius-xs`, `-sm`, `-md`, `-lg`, `-xl` are the corner roundness steps, from tiny
chips to big popups. Smaller numbers feel crisp and carved; bigger feel soft and friendly.

**Type.**

| Token | What it sets |
| --- | --- |
| `--k-font-prose` | The face story text is set in. |
| `--k-font-ui` | Buttons, lists and settings. |
| `--k-font-display` | Big titles ("Who are we meeting tonight?", popup titles, the chat title). |
| `--k-display-weight` | How bold those titles are. |
| `--k-font-name` | The speaker's name above each message. Defaults to the display face. |
| `--k-name-weight` | How bold names are. |
| `--k-font-label` | The small section labels (CHARACTERS, DESCRIPTION, THE CAST...). |
| `--k-label-case` | `uppercase` (the default look), `none` (as written), `lowercase`, `capitalize`. |
| `--k-label-tracking` | Letter spacing of labels, like `0.08em`, or `0` for none. |
| `--k-label-weight` | How bold labels are. |
| `--k-label-scale` | Multiplies every label's size: `1.3` is 30% bigger. Handwritten faces need about 1.3 to 1.4. |
| `--k-mes-line-height` | Space between lines of story text (Blue Hour: `1.65`). |
| `--k-mes-weight` | Weight of story text (Blue Hour: `450`). |
| `--k-mes-para-gap` | Space between paragraphs (Blue Hour: `0.85em`). |

The four label tokens start *unset*, which means every label keeps its own built-in style. Set any
of them and every label in the app follows.

Reading size is the reader's own setting (Settings → Appearance → Reading size), not the theme's.

**Materials: what surfaces are made of.** Each material is laid *over* that surface's colour (the
colour still comes from your palette). A material is a list of layers separated by commas: the
first one is on top. Gradients stretch to fill the surface; pictures repeat at their own size, like
tiles.

| Token | Surface |
| --- | --- |
| `--k-material-topbar` | The bar along the top. |
| `--k-material-rail` | The left and right side panels. |
| `--k-material-reading` | The area behind the conversation. A soft light here reads as a lamp over the table. |
| `--k-material-message` | The character's message cards (in the card and bubble looks). |
| `--k-material-message-user` | Your own message cards. |
| `--k-material-composer` | The box you type in. |
| `--k-material-library` | The backdrop of the home page (the cast). |

`none` means plain colour. A material holds pictures and gradients only; a plain colour is set with
the palette, and `theme:check` stops one written here. Example, a faint light falling from the top
of each message card:

```json
"--k-material-message": "linear-gradient(180deg, color-mix(in srgb, #f6c27e 5%, transparent), transparent 160px)"
```

**The room.** `--k-app-backdrop` is everything behind the app: by default, the soft glows coloured by
`glow-top`, `glow-left` and `glow-bottom` over a gradient. Replace it with your own layers, for
example a picture over a gradient:

```json
"--k-app-backdrop": "url(\"bg/room.svg\"), linear-gradient(176deg, #1e140f, #0a0605)"
```

(Inside a JSON value, a double quote is written `\"`.) As with materials, the first layer is on
top. The home page has its own backdrop, `--k-material-library`; set it to `var(--k-app-backdrop)`
to show the same room there.

**Atmosphere.** One extra full-window layer between the room and the app, for weather or light:
fog, slow snow, a glow that breathes.

| Token | What it does |
| --- | --- |
| `--k-atmosphere` | The picture or gradient (layers, like a material). `none` = off. |
| `--k-atmosphere-opacity` | How strong it is, `0` to `1`. |
| `--k-atmosphere-blend` | How it mixes with what's under it: `normal`, `screen` (lightens), `soft-light`, `overlay`. |
| `--k-atmosphere-mask` | Where it shows, as a gradient: black shows, transparent hides. `linear-gradient(90deg, transparent 50%, #000)` keeps it to the right half. |
| `--k-atmosphere-motion` | `none`, `k-atmo-fall` (slides down), `k-atmo-drift` (slides sideways), `k-atmo-breathe` (fades gently in and out). |
| `--k-atmosphere-period` | How long one loop takes, like `120s`. Slow is cozy. |
| `--k-atmosphere-travel` | How far one loop moves: your picture's height (fall) or width (drift), so it joins up without a jump. |
| `--k-atmosphere-steps` | How many small hops a loop takes. Fewer is lighter on the computer. |

*Where it shows.* The atmosphere (like the room) sits behind everything. The side panels, popups
and the home page cover it. In a chat it shows through the conversation column, which is a tinted,
blurred pane: how blurred is each reader's own Blur setting, and at the usual setting thin lines
(rain streaks, grain, small flakes) melt into an even haze. Only the strip along the top of the
column shows it sharp. So an atmosphere works as **large, soft shapes**: fog banks, broad light,
big slow flakes. Fine weather belongs in the room picture instead (that is what the worked example
does with its rain).

*Motion is optional,* and still is the kind default ([section 11](#11-comfortable-for-long-sessions)).
If you do move it, move it slowly, in small hops: each hop redraws the blurred pane. Good starting
numbers for a picture that tiles every 480 pixels:

| Token | Start with | Why |
| --- | --- | --- |
| `--k-atmosphere-travel` | `480px` | The tile's height (fall) or width (drift), so the loop joins up. |
| `--k-atmosphere-steps` | `240` | Half the travel: each hop moves 2 pixels, which reads as gliding. |
| `--k-atmosphere-period` | `80s` | Steps ÷ 3: about three hops a second. Longer is calmer. |
| `--k-atmosphere-opacity` | `0.4` | Weather should be felt, not read through. |

`theme:check` prints how far your atmosphere moves per hop and how often, and warns when it jumps
(more than 3 pixels a hop) or busies the computer (more than 6 hops a second). Motion always stops
for readers who turned on Reduced Motion (in Kotatsu, or in their computer's settings).

**Motion.** `--k-dur-1`, `-2`, `-3` are how long small, medium and large interface movements take
(Blue Hour: `120ms`, `180ms`, `240ms`). Keep them at 260ms or less so nothing feels like it is in the
way. `--k-ease-out` is the curve things settle with.

### Component knobs

Beyond the core tokens there are over 400 *component knobs*: fine dials that belong to one part of
the app, like `--k-lib-card-radius` (corners of the cards on the home page), `--k-cc-name-size` (size
of names above messages) or `--k-lib-title-size` (the big title on the home page). They are listed,
grouped by part, in `KNOBS.md`. You write them in `tokens` exactly like a core token, and Kotatsu
applies your value everywhere that part uses it. A few knobs depend on the window size: some only
exist on phones or in wide windows (your value applies only there), and some normally change with
the size (your value replaces that, so it stays the same at every size). `KNOBS.md` and
`theme:check` say which, in words. Check your theme in a narrow window too.

---

## 6. Fonts

Fonts travel inside your theme, so everyone who installs it sees the same thing. Put the font files
in a `fonts` folder inside your theme and list them under `assets`:

```json
    "assets": {
        "fonts": [
            { "family": "Kalam", "src": "fonts/kalam-regular.woff2", "weight": "400" },
            { "family": "Kalam", "src": "fonts/kalam-bold.woff2", "weight": "700" }
        ]
    }
```

Then use the family name in a font token: `"--k-font-name": "'Kalam', cursive"`.

| Field | Meaning |
| --- | --- |
| `family` | The name you'll use in tokens. One family can have several files. |
| `src` | The file, inside your theme folder. `.woff2` is smallest; `.ttf` and `.otf` work too. |
| `weight` | Which boldness this file is: `400` regular, `700` bold, or a range like `400 800`. |
| `style` | `normal` or `italic`. |
| `unicodeRange` | Optional: which characters this file covers, to split a family across files (font services give it). |

**A font with only one weight.** If you only have the regular file, give it a range,
`"weight": "400 800"`. Then places that ask for bold use your file as it is instead of smearing it
into a fake bold.

**Getting a font from Google Fonts, step by step.** [Google Fonts](https://fonts.google.com/) is
the easy place to start: every font there may be shared inside a theme.

1. Find a font you like on the site and open its page (say, *Kalam*).
2. Press **Get font**, then **Download all**. You get a `.zip` file.
3. Open the zip. Inside are the licence, `OFL.txt`, and the font files, which end in `.ttf`. Some
   fonts have one file per weight (`Kalam-Regular.ttf`, `Kalam-Bold.ttf`); others have one file with
   `[wght]` in its name and a `static` folder. If there is a `static` folder, use the files in it.
4. In your theme's folder, make a folder called `fonts`. Copy in the weights you want (usually
   Regular, and Bold if your names or titles are bold) and `OFL.txt`.
5. List each file under `assets.fonts`. The `family` is the font's name exactly as the site shows
   it; the `weight` comes from the file name: Light `300`, Regular `400`, Medium `500`, SemiBold
   `600`, Bold `700`.

```json
    "assets": {
        "fonts": [
            { "family": "Kalam", "src": "fonts/Kalam-Regular.ttf", "weight": "400" },
            { "family": "Kalam", "src": "fonts/Kalam-Bold.ttf", "weight": "700" }
        ]
    }
```

6. Use it in a token, `"--k-font-name": "'Kalam', cursive"`, run `theme:check`, and press F5 in
   Kotatsu.

`.ttf` files work as they are; there is nothing to convert. (`.woff2` files are smaller, so a
theme that ships many fonts may prefer them, but they are optional.) Keep `OFL.txt` with the fonts:
the licence asks for it. Don't bundle fonts you bought or found without a licence that allows
sharing.

Story text is read for hours. Keep `--k-font-prose` a calm, proven reading face; spend your
personality on names, labels and titles.

---

## 7. Pictures and textures

Pictures go in your folder (any sub-folder name works; Kissaten Showcase uses `bg/` and
`textures/`) and are used with `url("folder/file")` in a token. SVG, PNG, JPEG and WebP all work.

- **A texture that repeats** (wood grain, paper, fabric): make a small square picture that tiles
  without a visible seam, and use it in a material. It repeats at its own size: a PNG, JPEG or
  WebP at its pixel size, an SVG at the `width` and `height` written on its `<svg>` tag.
- **A full picture** (a room, a skyline): use an SVG *without* `width` and `height` on its `<svg>`
  tag, and it stretches to cover the window. A photo (PNG, JPEG, WebP) is drawn at its own size and repeats, so
  make it at least 2560 by 1440. Keep anything important away from the middle, where the
  conversation sits.
- **Keep them light.** Textures should whisper: a faint layer at low contrast. If you notice the
  texture while reading, it's too strong. Keep files small (Kissaten Showcase's pictures are all
  under 16 KB).
- **A single background picture** can also go in `assets`: `"backdrop": "bg/room.png"`. It replaces
  the whole room, glows included. Use either this or `--k-app-backdrop`, not both.

---

## 8. Checking your theme

**Seeing it.** Your theme is checked best by wearing it: pick it in Settings → Appearance → Theme →
Theme pack, and after every edit save the file and press F5 in Kotatsu. Look at a chat in each
message look (Settings → Appearance → Wardrobe), the home page, the settings sheet, and a narrow
window (or your phone).

**Checking it.**

```
npm run theme:check -- my-theme
```

Run it after every few edits. Every line starts with a word:

| Word | Meaning |
| --- | --- |
| `PASS` | Fine. |
| `INFO` | Just telling you something, like which colours your palette grew. |
| `WARN` | Works, but worth a look. Never stops the check. |
| `FAIL` | Must fix before you share. The line says what to do. |

What it checks: that `theme.json` is well-formed, every name is real, every file you point at
exists inside your folder, nothing reaches outside it, and that the text people read is readable:
body text, story text, "dialogue", \*actions\*, names and the dim greys against panels and message
cards, measured against the WCAG AA standard (4.5 to 1). It also warns about fonts you name but don't
include, tokens that repeat your parent's value, and movements longer than 260ms.

**Common messages and fixes**

| Message | Fix |
| --- | --- |
| `theme.json is not valid JSON` | A missing comma between entries, an extra one after the last entry, or a missing `"`. |
| `is not a known token (did you mean "--k-lib-card-radius"?)` | A typo; use the suggested name. |
| `contrast ... 3.10:1, needs 4.5:1` | That text is too close to its background. Make the text lighter (dark theme) or darker (light theme), or the background the other way. |
| `may only use url() for files inside your pack folder` | Copy the picture into your folder and point at it, like `url("textures/wood.png")`. No web addresses. |
| `points at a file that does not exist` | Check the spelling and the folder name; capitals count. |
| `"id" must be "...", the same as its folder name` | Rename the folder or the id so they match. |
| `is not a font file Kotatsu can use` | Point `src` at the `.ttf` (or `.otf`, `.woff2`) file itself, not the `.zip` you downloaded. |
| `asks for "X", but no font file in this pack provides it` | Add the font files under `assets.fonts`, or accept that people without the font see the next one in your list. |
| `repeats the parent's value and can be deleted` | Harmless; delete the line to keep your file tidy. |

---

## 9. Sharing and installing

**To share:** zip your theme's folder (the one named after your id, from
`data/default-user/theme-packs/`) and send it.

**To install a theme someone sent you:** unzip it into your Kotatsu folder's
`data/default-user/theme-packs/` (on Windows, `Documents\Kotatsu\data\default-user\theme-packs\`).
You should end up with `theme-packs/their-theme/theme.json`. Reload Kotatsu (F5) and pick it in
Settings → Appearance → Theme pack. If you like, run `npm run theme:check -- their-theme` first.

**Why themes are safe to share.** A theme is data only: colours, sizes, fonts and pictures from its
own folder. It cannot contain programs, and Kotatsu refuses any theme that tries to load something
from the internet or from outside its folder. The worst a theme can do is look bad.

The **Import** button next to the theme list is for old SillyTavern theme files, not for these
theme folders.

---

## 10. Worked example: Kissaten Showcase

> *A Shōwa-era jazz kissaten at two in the morning: the last coffee shop in the neighbourhood still
> lit. Lacquered dark wood and worn leather booths, amber pendant lamps pooling light on the counter,
> a record turning on the hi-fi, menus written by hand, rain on the front window and the street neon
> smeared behind it. Dramatic but deeply cozy, and easy on the eyes through a four-hour roleplay: the
> conversation is the warm centre of the room and everything else is atmosphere.*

It is an example, not one of the built-in themes, so it is not in Kotatsu's theme list. Its files
are in the Kotatsu folder's `docs/theme-examples/kissaten-showcase/`. To wear it and take it apart,
make your own copy: `npm run theme:new -- my-showcase --from kissaten-showcase`, then pick it in
Settings like any theme of yours. It uses no `sheet.css`, pins no message look and adds no ambient
motion: everything below is the palette, tokens, knobs, three fonts and three pictures.

(The built-in **Midnight Kissaten** is another take on the same coffee shop, built the older way:
every colour written out as a token, and a small `sheet.css` for what tokens could not reach yet.
Compare the two to see what the palette and knobs save you.)

### The palette: a room lit by lamps

```json
    "palette": {
        "background": "#120c09",
        "panel": "#1e1511",
        "text": "#eadfcb",
        "prose": "#e4d6bd",
        "accent": "#e0a157",
        "dialogue": "#e8bf86",
        "actions": "#d6a59c",
        "border": "#5c4431",
        "character-message": "#211813",
        "user-message": "#2b1a16",
        ...
    }
```

- The **background** is near-black with brown in it, lacquered wood with the lights low, and the
  **panels** are one step up, dark walnut. Nothing is pure black, which is part of why the room feels
  warm instead of empty.
- **Text** is a warm cream, like a menu card under a lamp, never white. **Prose** is a shade softer
  still, because it's what people read for hours; labels and buttons keep the crisper cream.
- The **accent** is the amber of the pendant lamps. **Dialogue** is a paler, honeyed gold: spoken
  words are what the light falls on, and the conversation glows a little warmer than the narration
  around it. **Actions** take the neon from outside, a dusty rose, muted so it doesn't shout.
- **Your messages** sit on oxblood leather (`user-message`), a touch redder than the character's
  walnut cards (`character-message`): two sides of the same table.
- The **glows** are the street through the window (a pink neon, top right), lamplight (bottom
  left) and a deep oxblood floor.

Everything else (sixteen more colours: the dim and faint greys, the deeper panels, the borders, the
bright amber for names) grew from these. `theme:check` lists them.

### Type: three voices

```json
        "--k-font-display": "'Gloock', 'Newsreader', Georgia, serif",
        "--k-display-weight": "400",
        "--k-font-name": "'Kalam', 'Gloock', cursive",
        "--k-name-weight": "400",
        "--k-font-label": "'Klee One', 'IBM Plex Sans', sans-serif",
        "--k-label-case": "none",
        "--k-label-tracking": "0.01em",
        "--k-label-weight": "600",
        "--k-label-scale": "1.3",
```

- **Titles** are in *Gloock*, a high-contrast serif like the gold lettering on a jazz bar's sign:
  the drama.
- **Names** above messages are in *Kalam*, a marker hand: each speaker's name is chalked on the menu
  board. They are bigger than usual (`--k-cc-name-size: 17px`, a knob), because handwriting needs
  room.
- **Labels** ("Characters", "Pick up where you left off", "Description") are in *Klee One*, a calm
  Japanese handwriting face, written as they are (`--k-label-case: none`) instead of shouted in
  capitals, and 30% bigger. These are the menus written by hand.
- **Story text** stays in Kotatsu's own reading face, Newsreader, a little lighter and with a little
  more air between lines (`--k-mes-line-height: 1.72`). The personality lives in the titles,
  names and labels; the prose is left alone to be read.

Each font is listed in `assets.fonts` twice, once for basic Latin letters and once for accented
ones, using `unicodeRange`, so a name like *Hjördís* stays in the same hand. Gloock comes in one
weight, so its files say `"weight": "400 800"` and bold titles use it as drawn.

### Materials: wood, paper, leather, light

```json
        "--k-material-topbar": "linear-gradient(...lamplight...), url(\"textures/walnut.svg\")",
        "--k-material-rail": "linear-gradient(...lamplight...), url(\"textures/walnut.svg\")",
        "--k-panel-fill": "url(\"textures/walnut.svg\"), linear-gradient(180deg, var(--k-surface-2), var(--k-ground-deep))",
        "--k-material-composer": "linear-gradient(...), url(\"textures/grain.svg\")",
        "--k-material-message-user": "linear-gradient(...edge...), url(\"textures/grain.svg\")",
        "--k-material-message": "linear-gradient(...edge...), linear-gradient(180deg, color-mix(in srgb, #f6c27e 5%, transparent), transparent 160px)",
        "--k-material-reading": "radial-gradient(ellipse 78% 52% at 50% -6%, ...amber 14%...), radial-gradient(...shadow at the floor...)",
```

- The **side rails, top bar and popups** are lacquered walnut: `walnut.svg` is a tiny tile of wood
  grain, very faint, with a little lamplight falling down the top of the rails.
- The **composer** and **your own message cards** get `grain.svg`, a fine tooth that reads as worn
  leather.
- The **character's cards** get no texture at all, only a hairline of light along the top edge and a
  warm glow fading down from it, as if the card sits under the lamp. Texture behind words you read
  for hours turns into noise, so it was tried and taken out.
- Behind the conversation, `--k-material-reading` hangs the **pendant lamp**: a pool of amber at the
  top of the reading area, and shadow gathering at the floor. This is what makes the conversation
  the warm centre and lets everything else fall back into the room.

### The room: the window and the rain

```json
        "--k-app-backdrop": "url(\"bg/kissaten.svg\"), radial-gradient(...a lamp, left...), radial-gradient(...a lamp, right...), linear-gradient(176deg, #1e140f 0%, #120c09 55%, #0a0605 100%)",
        "--k-material-library": "var(--k-app-backdrop)",
```

The room is four layers. At the bottom, a gradient from lamplit wood to the dark floor. Over it, the
pools of two pendant lamps. On top, `bg/kissaten.svg`: the wall's lacquered panels, and the front
window, rain running down the glass and the street's neon (a pink sign, a teal sign, a sodium lamp)
smeared behind it. The window fades out toward the floor so it reads as part of the room, not a
picture hung on it. `--k-material-library` puts the same room behind the home page, where it is
seen most clearly; in a chat it glows softly through the blurred area beside the conversation.

The rain could have used the atmosphere layer and slid slowly down. It doesn't: behind the blurred
reading area it was invisible, and a moving layer under a blur keeps the computer working for
nothing. The static rain in the window says it, and the reader's four hours stay still.

### Knobs: the carpentry

```json
        "--k-radius-xs": "3px", ... "--k-radius-xl": "9px",
        "--k-cc-bubble-radius": "var(--k-radius-md)",
        "--k-cc-bubble-border": "color-mix(in srgb, var(--k-chrome-border) 32%, transparent)",
        "--k-cc-name-size": "17px",
        "--k-bubble-name-size": "1.05em",
        "--k-lib-title-size": "clamp(40px, 4.4vw, 64px)",
        "--k-lib-card-radius": "var(--k-radius-md)",
```

Corners are tighter all round (cut wood, not cushions), message cards have a slightly firmer edge,
names are big enough for handwriting in both the card and bubble looks, and the home page's
title is a size bigger for the drama.

### What it measures

`npm run theme:check -- kissaten-showcase` passes. On the painted page, story text measures 12.4 to
1 against its card, dialogue 10.4 to 1, names 11.1 to 1 and timestamps 6.4 to 1; the standard asks
for 4.5.

---

## 11. Comfortable for long sessions

People read in Kotatsu for hours. A theme that is exciting for a minute and tiring after an hour has
failed. Some rules of thumb:

- **No pure white text on a dark theme, no pure black on a light one.** Cream and ink are easier
  on the eyes.
- **Give the prose its own, softer colour** (`prose`) if your `text` is very bright.
- **Dialogue and actions should be distinct but quiet.** Saturated colours over whole paragraphs
  wear people out; pale, warm or dusty versions read for hours.
- **Keep textures and pictures away from the words.** Wood, paper and grain belong on rails,
  composers and edges; behind story text, use at most a faint gradient.
- **Personality in titles, names and labels; calm in the prose.**
- **Little or no motion.** Anything that moves in the corner of the eye pulls attention away from
  the story. Kotatsu stops theme motion for readers who ask for reduced motion, but the kindest
  default is stillness. If your theme moves, keep it slow and soft (the numbers in
  [section 5](#5-tokens), under Atmosphere).
- **Check it on a phone.** Make your browser window narrow, or open Kotatsu on your phone.

---

## 12. When something goes wrong

**My theme isn't in the list.** Reload Kotatsu (F5). Check that the folder is directly inside
`data/default-user/theme-packs/` and contains `theme.json` (not inside another folder from the zip).

**I picked my theme and everything went back to Blue Hour, with a red message.** Kotatsu refuses a
broken theme rather than half-applying it. The message names the problem; `npm run theme:check`
explains it in more detail.

**My edit doesn't show.** Save the file, then press F5 in Kotatsu. (Picking another theme and
yours again is not enough: it re-reads `theme.json` but keeps showing the old pictures.)

**My font doesn't show.** Check the `src` path, that the `family` name matches the one in your token
exactly (spaces and capitals count), and that the font name in the token has quotes around it if it
contains a space: `'Klee One'`.

**A colour looks right on panels but wrong in messages.** Messages sit on `character-message` and
`user-message`, and story text uses `prose`. Check those three; `theme:check` measures them.

**I want to start over.** Delete your theme's folder and run `npm run theme:new` again.

**Where's the list of everything?** `TOKENS.md` (every core token) and `KNOBS.md` (every component
knob) in your theme's folder. `theme:new` writes fresh ones into every new theme, so if Kotatsu
has been updated since, make a throwaway theme to get an up-to-date list.
