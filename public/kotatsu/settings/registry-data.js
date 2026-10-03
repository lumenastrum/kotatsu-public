/**
 * The registry's data — `docs/settings-v0.md` §6 slice A.
 *
 * Imports NOTHING at runtime (the `import(...)` in the JSDoc is type-only), exactly like
 * `studio/manifest.js`. Everything here is authored, not scraped: the census proved no section
 * taxonomy exists in the markup to scrape (§5.1 — three of the drawer's groups have no heading
 * at all, and 27 of 110 controls sit in them), so tabs, `affects`, `keywords` and `tier` are
 * decisions with receipts, not derivations.
 *
 * ── Where every row came from ─────────────────────────────────────────────────────────────
 * - 110 rows = the census's value-bearing controls (`settings-recon-census.md` §1.2). Every
 *   one is present, killed rows included.
 * - +2 Kotatsu-native rows with no drawer control (§6.1): `kotatsu_layout`, `kotatsu_rails`.
 *   These are the two runtime-built controls; the other five Kotatsu settings (three wardrobe
 *   axes, metrics, landing) already have static markup at `index.html:5029-5065` and are among
 *   the 110.
 * - +2 MovingUI affordances that persist no value of their own (`#movingUIreset`,
 *   `#movingui-preset-save-button`). They are not census value rows, but they ARE two of the
 *   kill list's ten (`settings-v0.md` §4), and `/resetpanels` synthesizes a click on the first
 *   (`power-user.js:2964-2967`) — slice C's guard needs them on the map.
 * - +4 rows the design pins into tabs 3 and 5 although they render in other drawers
 *   (`settings-v0.md` §3.3 "reasoning (auto_parse, show_hidden) … show_user_prompt_bias",
 *   §3.5 "auto_connect"). All four are bound in `power-user.js`/`reasoning.js` and carry static
 *   ids; nothing under `public/kotatsu/` borrows them, so the modal may adopt them cleanly.
 *
 * - +11 clickable ACTION affordances (slice C): the five theme file-ops, the debug menu,
 *   reload/clean-up, and the three account-cluster buttons.
 * - +5 adopted BLOCKS (slice E, `settings-v0.md` §10): `#rm_api_block`, `#persona-suite`,
 *   `#wiTopBlock`, `#world_popup`, `#extensions-settings-button`. Each is a whole stock region
 *   the modal relocates as one unit; each declares `keys: []` and an `adopt` selector, and the
 *   controls inside get no entries of their own.
 *
 * **134 entries.** The arithmetic is asserted in `tests/settings-registry.test.js`.
 *
 * ── Blocks, and the one control that folds into one ───────────────────────────────────────
 * The four v0.1 tabs are made of blocks and nothing else — recon verdicts §1.8, §2.6, §3.7 and
 * §4.6 all land on "ONE unit", for four different reasons (stranded select2 siblings, a
 * FormData form, a DIE-lane key literal, and a frozen two-column ABI). §10 pins one departure
 * from the recon: World Info's settings strip rides as a BLOCK too rather than as fourteen
 * `world_info_settings` rows, so the zero-DIE-lane assertion stays a rule instead of becoming
 * a rule with an exception list. Per-row search inside that strip is the chip that buys it.
 *
 * `auto_connect` is the one control that had to be both carried and findable: its checkbox is
 * at `index.html:4165`, inside `#rm_api_block`, so the Connection block moves it whether the
 * registry says so or not. It declares `withinBlock: 'rm_api_block'` — searchable, never a row.
 *
 * ── Grouping (`group`) — the Hybrid ───────────────────────────────────────────────────────
 * `settings-v0.md` §9: ledger rows for heavyweight controls, a two-column weave only for
 * homogeneous clusters. `group` is the eyebrow each row sits under; the registry carries the
 * STRING and no layout logic — the modal reads the `control` kinds in a run and decides
 * whether that run weaves. Homogeneous checkbox runs are what weave two-up; a run with a
 * select, a slider or a textarea in it stays ledger.
 *
 * Groups are contiguous runs of `getEntries()` order — the renderer starts a new eyebrow when
 * the string changes, so a group appearing twice in a tab would print its eyebrow twice. That
 * is what moved `debug_menu` up beside the two diagnostics toggles; nothing else moved.
 * Blocks carry no `group` (a block is its own region and its label is its eyebrow), and
 * neither do `withinBlock` rows or killed rows — neither ever renders a row.
 *
 * ── Adoption units (`adopt`), audited entry by entry, slice C ─────────────────────────────
 * The modal MOVES a live node instead of drawing a copy, so every row has to answer "which
 * node?" — and for 17 of the 102 surfaced rows the answer is bigger than the control itself.
 * `adopt` names those; the other 85 take the modal's fallback (`closest('label.checkbox_label')`
 * ?? the node), which is correct for them because stock's dominant shape really is a checkbox
 * inside its own label. Every `adopt` below carries the `index.html` lines it was read from.
 * Slice E adds five more, one per block — 22 `adopt` selectors in total, and the block five are
 * the only ones where `adopt` is required rather than an override.
 *
 * Three rules came out of that audit, and the *absences* are as deliberate as the entries:
 *
 * 1. **A `<label for=>` is an affordance and must travel.** It is clickable hit area, so
 *    leaving it behind removes function, not just words. Seven rows are named for this reason
 *    alone, and one (`auto_continue_target_length`) wraps its own input, where the fallback
 *    would have torn the control out of its label.
 * 2. **A slider's counter must travel with it.** Four of the seven slider mirrors the census
 *    counts (§1.1) belong to surfaced rows; each is a sibling of its slider, so the wrapper is
 *    the unit. (`chat_width_slider` and `blur_strength` are the other two — both killed, so
 *    they never travel at all.)
 * 3. **A bare caption is NOT an affordance and stays home.** `<span>Avatars:</span>`,
 *    `<span>Language:</span>`, `<small>Enter to Send:</small>` and the ten colour-picker
 *    captions are plain text beside a control, with no `for=`; the row label the modal prints
 *    says the same word and says it once. Those rows travel alone on purpose.
 *
 * Two known limits, recorded rather than papered over: `stscript_autocomplete_width_left` and
 * `_right` share ONE `.doubleRangeContainer` (`index.html:5723-5740`), so neither may claim it
 * — they travel as two bare ranges in two labelled rows and lose the container's tick markers
 * (`style.css:4328-4353`); and `themes` deliberately does NOT adopt `#UI-presets-block`,
 * because the five theme file-op buttons inside it are their own rows now (see the `button`
 * entries below) and a block that travels whole would leave every one of them empty.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────────────────────
 * Entries are grouped by section in tab order, and within a section in the order a tab should
 * render them (`getEntries` preserves it), which since slice E also means: in `group` runs.
 * Killed rows sit at the end of their natural section — they are filtered out of every
 * rendering path, but leaving them in a sensible home keeps the map readable and keeps
 * `rehome` legible next to the thing it replaced.
 */

/**
 * The input primitive a row needs.
 * `color` is `<toolcool-color-picker>` (`change` → `evt.detail.rgba`); `buttongroup` is a
 * segmented pair (layout switch, rail collapse); `button` persists nothing at all.
 *
 * `block` (v0.1) is not a primitive at all — it is a whole adopted stock REGION, the shape
 * `settings-v0.md` §10 pins for the four new tabs. A block declares `keys: []` and an `adopt`
 * selector (required, and the entire point of the kind: the region is the unit), and its
 * `keywords` describe everything inside it so modal search still reaches the tab. The controls
 * within keep their own stock bindings, their own stock lanes — including DIE lanes — and get
 * no registry entries of their own, which is what keeps the "zero DIE-lane keys" assertion
 * honest rather than merely narrow.
 * @typedef {'select'|'checkbox'|'range'|'number'|'textarea'|'color'|'buttongroup'|'button'|'block'|'kotatsu-layout'|'kotatsu-rails'|'kotatsu-tour'|'kotatsu-phone'} ControlKind
 */

/** @typedef {import('./registry.js').Entry} Entry */
/** @typedef {import('./registry.js').Section} Section */

/**
 * The `affects` vocabulary — the surfaces a setting can reach.
 *
 * Mined from `public/css/toggle-dependent.css` (the closest thing the codebase has to an
 * existing affects map — census §5.5 lists the eighteen body classes that resolve there) plus
 * the census's read-site column. An entry's `section` is a consequence of its `affects`:
 * `message-row`/`chat-column` → **chat**, `composer`/`streaming` → **streaming**,
 * `chrome`/`theme-tokens` → **appearance**, `scripting`/`diagnostics` → **scripting**,
 * `startup`/`request`/`prompt`/`sound`/`media` → **system**. Where an entry carries two, the
 * first one listed is the one that decided the tab.
 */
export const AFFECTS = Object.freeze([
    /** The rendered message rows: avatars, nameplates, metadata readouts, actions. */
    'message-row',
    /** The centre column itself: width, scrollback, greeting pins, autoscroll. */
    'chat-column',
    /** The input area and the buttons that live in it. */
    'composer',
    /** App chrome outside the message list: rails, panels, blur, shadow, motion, toasts. */
    'chrome',
    /** CSS custom properties and the theme-file payload. */
    'theme-tokens',
    /** The character gallery / roster / tags. */
    'library',
    /** The token-stream paint path. */
    'streaming',
    /** What gets assembled and sent to the model. */
    'prompt',
    /** The outgoing request body beyond the prompt text. */
    'request',
    /** Audio notifications. */
    'sound',
    /** Toasts and dialogs. */
    'notifications',
    /** STscript, macros, autocomplete. */
    'scripting',
    /** Console output and debug affordances. */
    'diagnostics',
    /** Boot-time behaviour. */
    'startup',
    /** Images, video, external-media policy. */
    'media',
]);

/** Every legal `control` value. */
export const CONTROLS = Object.freeze([
    'select', 'checkbox', 'range', 'number', 'textarea', 'color', 'buttongroup', 'button',
    'block', 'kotatsu-layout', 'kotatsu-rails', 'kotatsu-tour', 'kotatsu-phone',
]);

/** Every legal `store` value. See the `EntryStore` typedef in `registry.js` for the lane rules. */
export const STORES = Object.freeze(['power_user', 'settings', 'localStorage', 'background']);

/** Every legal `tier` value. Dormant metadata — nothing may consume it. */
export const TIERS = Object.freeze(['simple', 'advanced']);

/**
 * The nine tabs — `settings-v0.md` §3 (the original five) and §10 (the four v0.1 additions,
 * in the canvas-v2 order: Connection · Personas · Appearance · Chat & Messages · Streaming &
 * Input · World Info · Extensions · Scripting & Tools · System).
 *
 * The four new tabs are the modal becoming **the configuration home** (§9): Connection adopts
 * the API drawer whole and retires the settings overlay's last surviving job; Personas adopts
 * the persona suite; World Info and Extensions MOVE IN from the right rail, which slims to the
 * live surfaces (prompt manager + trackers) in the same batch. Each is one or two adopted
 * blocks — see the `block` entries at the top of `ENTRIES`.
 * @type {ReadonlyArray<Section>}
 */
export const SECTIONS = Object.freeze([
    {
        id: 'connection',
        label: 'Connection',
        blurb: 'Which API answers, which model, and the keys that reach them.',
    },
    {
        id: 'personas',
        label: 'Personas',
        blurb: 'Who you are in a chat — name, avatar, description, and what locks to what.',
    },
    {
        id: 'appearance',
        label: 'Appearance',
        blurb: 'Theme, wardrobe, layout, and the chrome around the chat.',
    },
    {
        id: 'chat',
        label: 'Chat & Messages',
        blurb: 'What a message row shows, and how the chat behaves around it.',
    },
    {
        id: 'streaming',
        label: 'Streaming & Input',
        blurb: 'How replies arrive, and how you write the ones you send.',
    },
    {
        id: 'worldinfo',
        label: 'World Info',
        blurb: 'Lorebooks: what is active, how hard it scans, and the entry editor.',
    },
    {
        id: 'extensions',
        label: 'Extensions',
        blurb: 'Installed extensions and the panels they render for themselves.',
    },
    {
        id: 'scripting',
        label: 'Scripting & Tools',
        blurb: 'STscript, macros, autocomplete, and the diagnostic switches.',
    },
    {
        id: 'system',
        label: 'System',
        blurb: 'Startup, language, using Kotatsu on your phone, media policy, and the prompt-affecting character keys.',
    },
]);

/**
 * Every setting Kotatsu knows about.
 * @type {ReadonlyArray<Entry>}
 */
export const ENTRIES = Object.freeze([

    // ─── Connection ──────────────────────────────────────────────────────────────────────
    // One block, one folded checkbox. `settings-recon-v01-surfaces.md` §1.8 is unambiguous:
    // "Discrete registry rows for the Connection tab are **not** advisable in v0.1 — with the
    // exception of `auto_connect`."
    {
        id: 'rm_api_block',
        keys: [],
        label: 'API Connection',
        section: 'connection',
        control: 'block',
        binding: { by: 'id', ref: 'rm_api_block' },
        // The WHOLE `.drawer-content` (`index.html:2371-4172`, 1,802 lines), never a sub-block.
        // Three receipts force it (recon §1.8):
        //   1. Six select2 widgets inside render as a SIBLING `span.select2-container`
        //      (`utils.js:2393`), not a wrapper — per-control adoption strands the visible
        //      widget and its click handler and leaves a 1×1 clipped `<select>` behind,
        //      silently: `adoptionUnit()` resolves, `#place()` warns only on a MISSING node.
        //   2. The connection-profile block has NO id — `connection-manager/index.js:707-709`
        //      injects `<div class="wide100p">` (`settings.html:1`) as `afterbegin` of this
        //      node at extension-init time. It cannot be named by a selector; it rides free
        //      inside the whole.
        //   3. Per-API visibility is 167 nodes of core-owned INLINE `display` written by three
        //      independent jQuery layers — `changeMainAPI()` (`script.js:8076-8189`),
        //      `[data-source]` (`openai.js:6050-6055`) and `[data-tg-type]`
        //      (`textgen-settings.js:1159-1178`). **Those three writers keep sole authority.**
        //      The tab styles this container and NEVER writes `display` on anything inside it;
        //      the preset-dock lesson (`preset-dock-v0.md:68-73`) with the sign reversed — a
        //      `settings-modal.css` rule landing on those nodes shows all five APIs at once.
        // Secrets discipline: the tab adopts the inputs, reads nothing, echoes nothing
        // (recon §1.5). `#viewSecrets` (`index.html:4168`) rides inside and keeps its own
        // stock gate.
        adopt: '#rm_api_block',
        affects: ['request', 'startup'],
        keywords: [
            'api', 'connection', 'connect', 'provider', 'backend', 'endpoint', 'server', 'url',
            'model', 'key', 'api key', 'secret', 'secrets', 'token', 'proxy', 'reverse proxy',
            'connection profile', 'profile', 'status', 'main api', 'text completion',
            'chat completion', 'textgen', 'oobabooga', 'kobold', 'koboldai', 'horde', 'novelai',
            'openai', 'claude', 'anthropic', 'openrouter', 'mistral', 'groq', 'deepseek',
            'gemini', 'makersuite', 'vertex', 'cohere', 'custom', 'xai', 'grok',
        ],
        tier: 'advanced',
        // Vacuous, exactly like the thirteen `button` rows: `keys: []` means this entry names
        // no key, so no lane claim is being made. The controls INSIDE write to `oai_settings`,
        // `nai_settings`, `kai_settings` and the secrets store — DIE lanes and worse — which
        // is precisely why they get no entries: relocation is DOM-only and safe, a registry
        // key there would not be.
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto-connect-checkbox',
        keys: ['auto_connect'],
        label: 'Auto-connect to Last Server',
        section: 'connection',
        // FOLDED into the block above (`settings-v0.md` §10). It renders at
        // `index.html:4165`, which is INSIDE `#rm_api_block` — so the Connection block already
        // carries this node, and a second entry claiming it would be the double-adoption the
        // §10 gate names. `withinBlock` is how the registry says that out loud: searchable
        // from any tab, never independently adopted, never a row of its own.
        withinBlock: 'rm_api_block',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto-connect-checkbox' },
        affects: ['startup', 'request'],
        keywords: ['auto connect', 'autoconnect', 'connect', 'startup', 'api', 'auto_connect'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },

    // ─── Personas ────────────────────────────────────────────────────────────────────────
    {
        id: 'persona-suite',
        keys: [],
        label: 'Persona Management',
        section: 'personas',
        control: 'block',
        binding: { by: 'id', ref: 'persona-suite' },
        // NOT `#persona-management-block`. That block (`index.html:5984-6117`) is unusually
        // clean and must not be split — `changeUserAvatar` builds
        // `new FormData(document.getElementById('form_upload_avatar'))` (`personas.js:387,
        // 401`), and a form whose inputs left the subtree submits EMPTY with no error — but
        // four controls sit one level up in what was, until this batch, an unnamed div:
        // `.user_stats_button` (`:5969`), `#personas_backup` (`:5973`), `#personas_restore`
        // (`:5977`), `#personas_restore_input` (`:5981`). Adopting the block alone strands
        // Backup, Restore and Usage Stats in a drawer nobody opens any more.
        // So `index.html:5958` gains `id="persona-suite"` — recon §2.6 option 1, ONE
        // classic-visible markup line, tabled in `settings-v0.md` §8.1 with the other six.
        // `#PersonaManagement` stays a valid `.drawer-content` for `doNavbarIconClick`
        // (`script.js:11286`); the toolbar row and the block both travel.
        // Not adopted, deliberately: `#user_avatar_template` (`index.html:6611-6636`) lives
        // far outside the drawer and is CLONED per tile (`personas.js:232`) — it must stay
        // where it is and nothing may re-parse it.
        adopt: '#persona-suite',
        affects: ['prompt', 'message-row'],
        keywords: [
            'persona', 'personas', 'user', 'your name', 'name', 'avatar', 'user avatar',
            'profile picture', 'description', 'persona description', 'depth', 'position',
            'lorebook', 'persona lore', 'lock', 'default persona', 'auto lock', 'connections',
            'backup', 'restore', 'usage stats', 'stats', 'identity', 'who you are',
        ],
        tier: 'advanced',
        // Vacuous — see the Connection block. The persona lanes are three (recon §2.3) and
        // none of them is `power_user`; the block travels, the lanes stay stock's business.
        store: 'power_user',
        surface: 'modal',
    },

    // ─── Appearance ──────────────────────────────────────────────────────────────────────

    {
        id: 'themes',
        keys: ['theme'],
        label: 'Theme pack',
        section: 'appearance',
        group: 'Theme',
        control: 'select',
        binding: { by: 'id', ref: 'themes' },
        affects: ['theme-tokens', 'chrome', 'message-row'],
        keywords: ['theme', 'ui theme', 'preset', 'skin', 'look', 'palette', 'colors', 'colours', 'pack', 'blue hour', 'sparkle'],
        // The single highest-value control in the whole surface: applying a theme writes 38
        // keys in one act (simple-tier §2.1 — 38/38 of a real profile matched `Blue Hour.json`).
        // Kotatsu also stores `pack:<id>` values here (`theme/loader.js:550`).
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    // The theme file-ops — `settings-v0.md` §3.1 ("theme pack picker + theme file-ops").
    // The census counts these as ACTION rows (§1.1: 14 affordances, no key, no value, no
    // `power_user` write of their own), which is why slice A's 110 does not contain them —
    // but every one is a thing a person opens Settings in order to DO, and stock hides all
    // five behind icon-only buttons whose meaning lives in a `title` attribute. As registry
    // rows they get written labels and the modal search reaches them: "export theme" answers.
    //
    // None takes an `adopt`. Each button is its own node and `#UI-presets-block` stays home,
    // because a block that travelled whole would carry all five into the theme select's row
    // and leave their own rows empty. The hidden `<input type="file" id="ui_preset_import_file">`
    // (`index.html:5022`) gets NO entry — it is not a user control — and does not need to
    // travel either: the import button reaches it by id (`power-user.js:4132-4134`), which
    // resolves from anywhere in the document.
    {
        id: 'ui_preset_import_button',
        keys: [],
        label: 'Import Theme File',
        section: 'appearance',
        group: 'Theme',
        control: 'button',
        binding: { by: 'id', ref: 'ui_preset_import_button' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['theme', 'import', 'import theme', 'load', 'file', 'json', 'upload', 'restore'],
        // `power-user.js:4132` → clicks the hidden file input → `importTheme()` at `:4136`.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'ui_preset_export_button',
        keys: [],
        label: 'Export Theme File',
        section: 'appearance',
        group: 'Theme',
        control: 'button',
        binding: { by: 'id', ref: 'ui_preset_export_button' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['theme', 'export', 'export theme', 'save', 'download', 'file', 'json', 'backup', 'share'],
        // `power-user.js:4152` → `exportTheme()`. Writes the 38 theme-scoped keys to disk.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'ui-preset-update-button',
        keys: [],
        label: 'Update Theme File',
        section: 'appearance',
        group: 'Theme',
        control: 'button',
        binding: { by: 'id', ref: 'ui-preset-update-button' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['theme', 'update', 'update theme', 'save', 'overwrite', 'apply', 'commit'],
        // `power-user.js:3603` → `updateTheme()` — writes the current values back over the
        // selected theme file.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'ui-preset-save-button',
        keys: [],
        label: 'Save as New Theme',
        section: 'appearance',
        group: 'Theme',
        control: 'button',
        binding: { by: 'id', ref: 'ui-preset-save-button' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['theme', 'save', 'save as', 'new theme', 'create', 'duplicate', 'preset'],
        // `power-user.js:3602` → `saveTheme()`, which prompts for a name.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'ui-preset-delete-button',
        keys: [],
        label: 'Delete Theme',
        section: 'appearance',
        group: 'Theme',
        control: 'button',
        binding: { by: 'id', ref: 'ui-preset-delete-button' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['theme', 'delete', 'delete theme', 'remove', 'discard'],
        // `power-user.js:3604` → `deleteTheme()`. Opens a core confirm — which is exactly the
        // popup `#handleEscape` stands down for (`corePopupOpen()`).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_mes_variant',
        keys: ['kotatsu_mes_variant'],
        label: 'Messages',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'select',
        binding: { by: 'id', ref: 'kotatsu_mes_variant' },
        // `index.html:5039-5045`: the select sits in a labelled row that also carries the pack
        // note (`#kotatsu_mes_variant_note`) and the row tooltip. Without the wrapper the note
        // that says a pack has outranked your choice stays behind in the rack, unread.
        adopt: '#kotatsu_mes_variant_row',
        affects: ['message-row', 'theme-tokens'],
        keywords: ['wardrobe', 'variant', 'message style', 'bubbles', 'card', 'script', 'chat style', 'row', 'kotatsu_mes_variant'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_mes_nameplate',
        keys: ['kotatsu_mes_nameplate'],
        label: 'Nameplate',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'select',
        binding: { by: 'id', ref: 'kotatsu_mes_nameplate' },
        // Same shape as the variant row (`index.html:5046-5052`).
        adopt: '#kotatsu_mes_nameplate_row',
        affects: ['message-row'],
        keywords: ['wardrobe', 'nameplate', 'name', 'character name', 'byline', 'header', 'kotatsu_mes_nameplate'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_mes_metadata',
        keys: ['kotatsu_mes_metadata'],
        label: 'Metadata',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'select',
        binding: { by: 'id', ref: 'kotatsu_mes_metadata' },
        // Same shape as the variant row (`index.html:5053-5059`).
        adopt: '#kotatsu_mes_metadata_row',
        affects: ['message-row'],
        keywords: ['wardrobe', 'details', 'metadata', 'timestamps', 'token count', 'readouts', 'hover', 'kotatsu_mes_metadata'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_prose_scale',
        keys: ['kotatsu_prose_scale'],
        label: 'Reading size',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'select',
        binding: { by: 'id', ref: 'kotatsu_prose_scale' },
        // Reader-polish v0 finding 1. The select sits in a labelled row shaped like the three
        // wardrobe rows above it, minus the pack note: a pack never pins how large someone
        // reads (theme/prose-scale.js). Scales the prose and, under rails, the reading column
        // with it, so the measure holds; core's `font_scale` remains the whole-UI knob.
        adopt: '#kotatsu_prose_scale_row',
        affects: ['message-row'],
        // No "text size" / "font size" here on purpose: those queries belong to `font_scale`
        // first (the search test pins it); this row answers to reading vocabulary.
        keywords: ['reading size', 'reading', 'prose', 'prose size', 'ultrawide', 'measure', 'column width', 'kotatsu_prose_scale'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'k-layout-switch',
        keys: ['kotatsu_layout'],
        label: 'Layout',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'kotatsu-layout',
        // Built in JS by the retired rails settings overlay; slice F deleted that module and
        // the modal rebuilds the strip under the same id (`#renderLayoutSwitch`).
        binding: { by: 'id', ref: 'k-layout-switch', runtime: true },
        affects: ['chrome'],
        keywords: ['layout', 'classic', 'rails', 'shell', 'switch', 'kotatsu_layout'],
        // Persistence §1.7: a layout change reloads, so it must `await saveSettings()`.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'k-rail-collapse',
        keys: ['kotatsu_rails'],
        label: 'Rails',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'kotatsu-rails',
        // The shell renders class-based handles with no id (`rail-collapse.js:186-196`,
        // `.k-rail-handle`), so there is no stock ref to borrow: this is the id the modal's own
        // control claims. `power_user.kotatsu_rails` is `{left, right}`, the PREFERRED pair —
        // the resolver's viewport suppression is never persisted (`rail-collapse.js:100-112`).
        binding: { by: 'id', ref: 'k-rail-collapse', runtime: true },
        affects: ['chrome'],
        keywords: ['rails', 'rail', 'collapse', 'sidebar', 'panels', 'left', 'right', 'kotatsu_rails'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_landing',
        keys: ['kotatsu_landing'],
        label: 'Landing',
        section: 'appearance',
        group: 'Wardrobe & Shell',
        control: 'select',
        binding: { by: 'id', ref: 'kotatsu_landing' },
        // `index.html:5064-5070`. The note here is live text, not decoration: `k-library.js:1298`
        // writes "no effect outside the rails layout" into it at runtime.
        adopt: '#kotatsu_landing_row',
        affects: ['library', 'chrome'],
        keywords: ['landing', 'home', 'start', 'welcome', 'library', 'gallery', 'startup screen', 'kotatsu_landing'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'font_scale',
        keys: ['font_scale'],
        label: 'Font Scale',
        section: 'appearance',
        group: 'Type & Avatars',
        control: 'range',
        // Bound `$('input[name="font_scale"]')` at `power-user.js:3505`, NOT by id (census §5.3).
        binding: { by: 'name', ref: 'font_scale' },
        // `index.html:5176-5183`. The wrapper has no id, so the parent is named through the
        // slider it contains. It carries the `<small>` caption AND `#font_scale_counter` — one
        // of the seven number inputs the census counts as slider mirrors (§1.1). The counter
        // resolves its master by `'#' + data('for')` (`script.js:12840`) so it would keep
        // working from the rack, but a slider with its readout left in another room is not a
        // control anyone can use.
        adopt: 'div:has(> #font_scale)',
        affects: ['theme-tokens', 'chrome'],
        // `size` is the generic term, and this is the control that owns it: it scales the whole
        // UI. Without it here, "text size" ranks the autocomplete popup's font slider first.
        keywords: ['font', 'font scale', 'size', 'text size', 'font size', 'zoom', 'bigger text', 'smaller text', 'scale'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'avatar_style',
        keys: ['avatar_style'],
        label: 'Avatars',
        section: 'appearance',
        group: 'Type & Avatars',
        control: 'select',
        binding: { by: 'id', ref: 'avatar_style' },
        affects: ['message-row', 'library'],
        keywords: ['avatar', 'avatars', 'portrait', 'circle', 'square', 'rounded', 'picture', 'shape'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'zoomed_avatar_magnification',
        keys: ['zoomed_avatar_magnification'],
        label: 'Avatar Hover Magnification',
        section: 'appearance',
        group: 'Type & Avatars',
        control: 'checkbox',
        binding: { by: 'id', ref: 'zoomed_avatar_magnification' },
        affects: ['message-row'],
        keywords: ['avatar', 'zoom', 'magnify', 'hover', 'enlarge', 'zoomed_avatar_magnification'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'media_display',
        keys: ['media_display'],
        label: 'Media Style',
        section: 'appearance',
        group: 'Media & Notifications',
        control: 'select',
        binding: { by: 'id', ref: 'media_display' },
        affects: ['media', 'message-row'],
        keywords: ['media', 'images', 'image', 'video', 'pictures', 'inline', 'cover', 'contain', 'media_display'],
        // Can prompt a reload (`power-user.js:1270`, `:1295`).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'background_thumbnails_animation',
        keys: ['animation'],
        label: 'Animated Background Thumbnails',
        // Re-homed here per `settings-v0.md` §3.1: it is a *backgrounds* setting that stock
        // filed under Character Handling (census §5.10 calls it historical drift), so it is the
        // one Character Handling row that is neither dropped nor a prompt key.
        section: 'appearance',
        group: 'Media & Notifications',
        control: 'checkbox',
        binding: { by: 'id', ref: 'background_thumbnails_animation' },
        affects: ['media', 'chrome'],
        keywords: ['background', 'backgrounds', 'thumbnail', 'thumbnails', 'animation', 'animated', 'gif', 'wallpaper'],
        tier: 'advanced',
        // `settings.background.animation` (`script.js:8411`, `backgrounds.js:1844`). The
        // `background` lane rebuilds field-by-field on load (`backgrounds.js:211-243`), so
        // UNKNOWN keys die there — `animation` is one of the known fields, which is the only
        // reason this row is safe. Nothing new may ever be added to this store.
        store: 'background',
        surface: 'modal',
    },
    {
        id: 'toastr_position',
        keys: ['toastr_position'],
        label: 'Notifications',
        section: 'appearance',
        group: 'Media & Notifications',
        control: 'select',
        binding: { by: 'id', ref: 'toastr_position' },
        affects: ['notifications', 'chrome'],
        keywords: ['notifications', 'toast', 'toasts', 'toastr', 'position', 'corner', 'popup', 'alerts'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'reduced_motion',
        keys: ['reduced_motion'],
        label: 'Reduced Motion',
        section: 'appearance',
        group: 'Motion & Effects',
        control: 'checkbox',
        binding: { by: 'id', ref: 'reduced_motion' },
        affects: ['chrome', 'message-row'],
        keywords: ['motion', 'reduced motion', 'animation', 'animations', 'accessibility', 'a11y', 'transitions', 'still'],
        tier: 'advanced',
        // The only control in the drawer an external authority can disable: `switchReducedMotion()`
        // force-writes `true` and calls `.prop('disabled', true)` when the media query matches
        // (`power-user.js:511-527`; census §5.11).
        lockedBy: 'prefers-reduced-motion',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'fast_ui_mode',
        keys: ['fast_ui_mode'],
        label: 'No Blur Effect',
        section: 'appearance',
        group: 'Motion & Effects',
        control: 'checkbox',
        binding: { by: 'id', ref: 'fast_ui_mode' },
        affects: ['chrome', 'theme-tokens'],
        keywords: ['blur', 'no blur', 'fast ui', 'performance', 'glass', 'frosted', 'backdrop', 'fast_ui_mode'],
        // The one blur switch that still reaches Kotatsu chrome — a universal `!important` kill
        // (`toggle-dependent.css:368-370`), unlike `blur_strength` which the tokens superseded.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'noShadowsmode',
        keys: ['noShadows'],
        label: 'No Text Shadows',
        section: 'appearance',
        group: 'Motion & Effects',
        control: 'checkbox',
        binding: { by: 'id', ref: 'noShadowsmode' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['shadow', 'shadows', 'text shadow', 'noshadows', 'glow', 'flat'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'shadow_width',
        keys: ['shadow_width'],
        label: 'Shadow Width',
        section: 'appearance',
        group: 'Motion & Effects',
        control: 'range',
        // Bound by name (`power-user.js:3520`), read back by id (`:1248`). Census §5.3.
        binding: { by: 'name', ref: 'shadow_width' },
        // `index.html:5194-5201`, which gains `id="shadow-width-block"` in this batch (§5 truth
        // fix). Two jobs, one selector: the counter travels with its slider, and the id that
        // `applyNoShadows()` greys out (`power-user.js:1026`, `:1029` — dead since the wrapper
        // never had it) now resolves wherever the control is standing.
        adopt: '#shadow-width-block',
        affects: ['theme-tokens', 'message-row'],
        keywords: ['shadow', 'shadow width', 'text shadow', 'glow', 'outline', 'shadow_width'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'customCSS',
        keys: ['custom_css'],
        label: 'Custom CSS',
        section: 'appearance',
        group: 'Custom CSS',
        control: 'textarea',
        binding: { by: 'id', ref: 'customCSS' },
        // `index.html:5440-5448`. The block's `<h4>` carries `i.editor_maximize[data-for=customCSS]`,
        // which is the only way to open the full-screen editor for an 8-row textarea. Borrowing
        // the textarea alone would strand the affordance that makes it usable.
        adopt: '#CustomCSS-block',
        affects: ['theme-tokens', 'chrome'],
        keywords: ['css', 'custom css', 'stylesheet', 'style', 'override', 'custom_css'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },

    // The ten legacy colour pickers — `settings-v0.md` §3.1 keeps them visible as a collapsed
    // "Legacy theme colors" group. Packs supersede them (they inline-pin `:root` and fight
    // pack tokens, supersession §7), but the executive decision was: only receipted kills go.
    // All ten are applied by `applyThemeColor()` (`power-user.js:1174`), which writes both the
    // legacy `--SmartTheme*` var and the Kotatsu `--k-*` token.
    {
        id: 'main-text-color-picker',
        keys: ['main_text_color'],
        label: 'Main Text',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'main-text-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'text', 'main text', 'body', 'foreground', 'legacy theme colors', 'main_text_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'italics-color-picker',
        keys: ['italics_text_color'],
        label: 'Italics Text',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'italics-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'italics', 'italic', 'emphasis', 'narration', 'legacy theme colors', 'italics_text_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'underline-color-picker',
        keys: ['underline_text_color'],
        label: 'Underlined Text',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'underline-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'underline', 'underlined', 'legacy theme colors', 'underline_text_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'quote-color-picker',
        keys: ['quote_text_color'],
        label: 'Quote Text',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'quote-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'quote', 'quotes', 'dialogue', 'speech', 'legacy theme colors', 'quote_text_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'shadow-color-picker',
        keys: ['shadow_color'],
        label: 'Text Shadow',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'shadow-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'shadow', 'text shadow', 'glow', 'legacy theme colors', 'shadow_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'chat-tint-color-picker',
        keys: ['chat_tint_color'],
        label: 'Chat Background',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'chat-tint-color-picker' },
        affects: ['theme-tokens', 'chat-column'],
        keywords: ['color', 'colour', 'chat background', 'tint', 'backdrop', 'legacy theme colors', 'chat_tint_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'blur-tint-color-picker',
        keys: ['blur_tint_color'],
        label: 'UI Background',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'blur-tint-color-picker' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['color', 'colour', 'ui background', 'surface', 'panel', 'tint', 'theme-color', 'legacy theme colors', 'blur_tint_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'border-color-picker',
        keys: ['border_color'],
        label: 'UI Border',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'border-color-picker' },
        affects: ['theme-tokens', 'chrome'],
        keywords: ['color', 'colour', 'border', 'outline', 'edge', 'legacy theme colors', 'border_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'user-mes-blur-tint-color-picker',
        keys: ['user_mes_blur_tint_color'],
        label: 'User Message',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'user-mes-blur-tint-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'user message', 'my messages', 'bubble', 'legacy theme colors', 'user_mes_blur_tint_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'bot-mes-blur-tint-color-picker',
        keys: ['bot_mes_blur_tint_color'],
        label: 'AI Message',
        section: 'appearance',
        group: 'Legacy Theme Colors',
        control: 'color',
        binding: { by: 'id', ref: 'bot-mes-blur-tint-color-picker' },
        affects: ['theme-tokens', 'message-row'],
        keywords: ['color', 'colour', 'ai message', 'bot message', 'character message', 'bubble', 'legacy theme colors', 'bot_mes_blur_tint_color'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },

    // Appearance — not adopted. Everything below stays in the stock drawer, fully functional
    // under classic, untouched in storage.
    {
        id: 'chat_display',
        keys: ['chat_display'],
        label: 'Chat Style',
        section: 'appearance',
        control: 'select',
        binding: { by: 'id', ref: 'chat_display' },
        affects: ['message-row', 'chat-column'],
        keywords: ['chat style', 'flat', 'bubbles', 'document', 'message style', 'chat_display'],
        tier: 'simple',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #1 — `shell-center.css:54-57` marks it INERT UNDER RAILS.
        rehome: 'variant wardrobe (Messages)',
    },
    {
        id: 'chat_width_slider',
        keys: ['chat_width'],
        label: 'Chat Width',
        section: 'appearance',
        control: 'range',
        // The one slider of the four that IS bound by id (`power-user.js:3465`).
        binding: { by: 'id', ref: 'chat_width_slider' },
        affects: ['chat-column'],
        keywords: ['chat width', 'width', 'column', 'narrow', 'wide', 'sheldwidth', 'chat_width'],
        tier: 'simple',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #2 — `shell-frame.css:56-61` redeclares `--sheldWidth` on `body`.
        rehome: 'rails centre track (--sheldWidth)',
    },
    {
        id: 'blur_strength',
        keys: ['blur_strength'],
        label: 'Blur Strength',
        section: 'appearance',
        control: 'range',
        // Bound by name (`power-user.js:3513`), read back by id (`:1242`). Census §5.3.
        binding: { by: 'name', ref: 'blur_strength' },
        affects: ['chrome', 'theme-tokens'],
        keywords: ['blur', 'blur strength', 'frosted', 'glass', 'backdrop', 'blur_strength'],
        tier: 'simple',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #8 — the token stays adjustable via packs; only the slider goes.
        rehome: 'theme pack token (--k-blur-panel)',
    },
    {
        id: 'waifuMode',
        keys: ['waifuMode'],
        label: 'Visual Novel Mode',
        section: 'appearance',
        control: 'checkbox',
        binding: { by: 'id', ref: 'waifuMode' },
        affects: ['chrome', 'chat-column'],
        keywords: ['visual novel', 'vn', 'waifu', 'waifumode', 'fullscreen', 'sprite'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #3 — the rails grid un-positions `#sheld` and hides `#top-bar`.
        rehome: 'rails grid',
    },
    {
        id: 'hotswapEnabled',
        keys: ['hotswap_enabled'],
        label: 'Characters Hotswap',
        section: 'appearance',
        control: 'checkbox',
        binding: { by: 'id', ref: 'hotswapEnabled' },
        affects: ['library', 'chrome'],
        keywords: ['hotswap', 'quick switch', 'favorites', 'favourites', 'characters', 'hotswap_enabled'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #9 — `#HotSwapWrapper` lives in the parked `#right-nav-panel` and has
        // zero references in `shell-*.css` or `public/kotatsu/`.
        rehome: 'left rail (Characters)',
    },
    {
        id: 'bogus_folders',
        keys: ['bogus_folders'],
        label: 'Tags as Folders',
        section: 'appearance',
        control: 'checkbox',
        binding: { by: 'id', ref: 'bogus_folders' },
        affects: ['library'],
        keywords: ['tags', 'folders', 'tags as folders', 'bogus folders', 'roster', 'bogus_folders'],
        tier: 'simple',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #10 — a folder tree is an explicit non-goal (`library-v0.md:250-252`).
        rehome: 'library gallery',
    },
    {
        id: 'movingUImode',
        keys: ['movingUI'],
        label: 'MovingUI',
        section: 'appearance',
        control: 'checkbox',
        binding: { by: 'id', ref: 'movingUImode' },
        affects: ['chrome'],
        keywords: ['movingui', 'drag', 'draggable', 'panels', 'move', 'resize', 'windows'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #4. The keys still pass through (`CLAUDE.md`), and `loadMovingUIState`
        // stays exported — it is a frozen CONTRACT export consumed by Moonlit and noass.
        rehome: 'rails grid + rail collapse',
    },
    {
        id: 'movingUIreset',
        keys: [],
        label: 'Reset MovingUI',
        section: 'appearance',
        control: 'button',
        binding: { by: 'id', ref: 'movingUIreset' },
        affects: ['chrome'],
        keywords: ['movingui', 'reset', 'resetpanels', 'panels', 'restore'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #5. Persists nothing itself; it acts on `movingUIState`. ⚠️ slice C:
        // `/resetpanels` synthesizes a click on this node (`power-user.js:2964-2967`) and needs
        // a rails guard.
        rehome: 'rails grid (no drag state to reset)',
    },
    {
        id: 'movingUIPresets',
        keys: ['movingUIPreset'],
        label: 'MovingUI Preset',
        section: 'appearance',
        control: 'select',
        binding: { by: 'id', ref: 'movingUIPresets' },
        affects: ['chrome'],
        keywords: ['movingui', 'preset', 'layout preset', 'panels'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #6. ⚠️ slice C: `/movingui` also reaches it (`power-user.js:4416-4428`).
        rehome: 'rails grid',
    },
    {
        id: 'movingui-preset-save-button',
        keys: [],
        label: 'Save MovingUI Preset',
        section: 'appearance',
        control: 'button',
        binding: { by: 'id', ref: 'movingui-preset-save-button' },
        affects: ['chrome'],
        keywords: ['movingui', 'preset', 'save', 'layout preset'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // supersession §6 #7 — POSTs to `src/endpoints/moving-ui.js:13`; existing preset files
        // go inert on disk, no migration.
        rehome: 'rails grid',
    },
    {
        id: 'aux_field',
        keys: ['aux_field'],
        label: 'Char List Subheader',
        section: 'appearance',
        control: 'select',
        binding: { by: 'id', ref: 'aux_field' },
        affects: ['library'],
        keywords: ['subheader', 'character list', 'roster', 'epithet', 'creator', 'version', 'aux_field'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // Character Handling drop (`settings-v0.md` §4). Still read by the gallery's epithet
        // chain (`library/epithet.js:196`) — the key lives, the control moves.
        rehome: 'library gallery (epithet line)',
    },
    {
        id: 'show_card_avatar_urls',
        keys: ['show_card_avatar_urls'],
        label: 'Show Avatar Filenames',
        section: 'appearance',
        control: 'checkbox',
        binding: { by: 'id', ref: 'show_card_avatar_urls' },
        affects: ['library'],
        keywords: ['avatar', 'filename', 'file name', 'url', 'card', 'show_card_avatar_urls'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        rehome: 'library gallery (card details)',
    },
    {
        id: 'spoiler_free_mode',
        keys: ['spoiler_free_mode'],
        label: 'Spoiler Free Mode',
        section: 'appearance',
        control: 'checkbox',
        binding: { by: 'id', ref: 'spoiler_free_mode' },
        affects: ['library'],
        keywords: ['spoiler', 'spoiler free', 'hide description', 'blur description', 'spoiler_free_mode'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        rehome: 'library card treatment',
    },

    // ─── Chat & Messages ─────────────────────────────────────────────────────────────────

    {
        id: 'mesIDDisplayEnabled',
        keys: ['mesIDDisplay_enabled'],
        label: 'Message IDs',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'mesIDDisplayEnabled' },
        affects: ['message-row'],
        keywords: ['message id', 'ids', 'number', 'index', 'mesid', 'mesIDDisplay_enabled'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'messageTimestampsEnabled',
        keys: ['timestamps_enabled'],
        label: 'Chat Timestamps',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'messageTimestampsEnabled' },
        affects: ['message-row'],
        keywords: ['timestamp', 'timestamps', 'time', 'date', 'clock', 'timestamps_enabled'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'messageTimerEnabled',
        keys: ['timer_enabled'],
        label: 'Message Timer',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'messageTimerEnabled' },
        affects: ['message-row'],
        keywords: ['timer', 'generation time', 'duration', 'seconds', 'speed', 'timer_enabled'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'messageModelIconEnabled',
        keys: ['timestamp_model_icon'],
        label: 'Model Icons',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'messageModelIconEnabled' },
        affects: ['message-row'],
        keywords: ['model icon', 'icons', 'api icon', 'badge', 'provider', 'timestamp_model_icon'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'messageTokensEnabled',
        keys: ['message_token_count_enabled'],
        label: 'Message Token Count',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'messageTokensEnabled' },
        affects: ['message-row'],
        keywords: ['token', 'tokens', 'token count', 'length', 'counter', 'message_token_count_enabled'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_metrics',
        keys: ['kotatsu_metrics'],
        label: 'Message Metrics',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'kotatsu_metrics' },
        affects: ['message-row'],
        keywords: ['metrics', 'usage', 'cost', 'tokens', 'price', 'spend', 'readout', 'kotatsu_metrics'],
        tier: 'advanced',
        // Stored as the string enum `'on'`/`'off'`, not a boolean, and **unset means ON**
        // (`metrics/index.js:32`, `:46`) — the registry stores no default for it; the owning
        // module resolves that read-time (persistence §7.2 rule 4).
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'show_swipe_num_all_messages',
        keys: ['show_swipe_num_all_messages'],
        label: 'Swipe # for All Messages',
        section: 'chat',
        group: 'Message Readouts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'show_swipe_num_all_messages' },
        affects: ['message-row'],
        keywords: ['swipe', 'swipes', 'counter', 'swipe number', 'all messages', 'show_swipe_num_all_messages'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'swipes-checkbox',
        keys: ['swipes'],
        label: 'Swipes',
        section: 'chat',
        group: 'Message Row',
        control: 'checkbox',
        binding: { by: 'id', ref: 'swipes-checkbox' },
        affects: ['message-row'],
        keywords: ['swipe', 'swipes', 'regenerate', 'alternatives', 'arrows', 'reroll'],
        tier: 'advanced',
        // NOT a `power_user` key: top-level `settings.swipes`, loaded `script.js:8267`, saved
        // `script.js:8402` (census §5.10).
        store: 'settings',
        surface: 'modal',
    },
    {
        id: 'hideChatAvatarsEnabled',
        keys: ['hideChatAvatars_enabled'],
        label: 'Hide Chat Avatars',
        section: 'chat',
        group: 'Message Row',
        control: 'checkbox',
        binding: { by: 'id', ref: 'hideChatAvatarsEnabled' },
        affects: ['message-row'],
        keywords: ['avatar', 'avatars', 'hide avatars', 'portrait', 'hideChatAvatars_enabled'],
        // supersession §6 #11 flagged it borderline; `settings-v0.md` §4 kept it visible —
        // only receipted kills go.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'expandMessageActions',
        keys: ['expand_message_actions'],
        label: 'Expand Message Actions',
        section: 'chat',
        group: 'Message Row',
        control: 'checkbox',
        binding: { by: 'id', ref: 'expandMessageActions' },
        affects: ['message-row'],
        keywords: ['message actions', 'buttons', 'expand', 'toolbar', 'edit', 'expand_message_actions'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'click_to_edit',
        keys: ['click_to_edit'],
        label: 'Click to Edit',
        section: 'chat',
        group: 'Editing & Deletion',
        control: 'checkbox',
        binding: { by: 'id', ref: 'click_to_edit' },
        affects: ['message-row'],
        keywords: ['edit', 'click to edit', 'double click', 'message editing', 'click_to_edit'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_save_msg_edits',
        keys: ['auto_save_msg_edits'],
        label: 'Auto-save Message Edits',
        section: 'chat',
        group: 'Editing & Deletion',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto_save_msg_edits' },
        affects: ['message-row'],
        keywords: ['edit', 'auto save', 'autosave', 'message edits', 'auto_save_msg_edits'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'confirm_message_delete',
        keys: ['confirm_message_delete'],
        label: 'Confirm Message Deletion',
        section: 'chat',
        group: 'Editing & Deletion',
        control: 'checkbox',
        binding: { by: 'id', ref: 'confirm_message_delete' },
        affects: ['message-row', 'notifications'],
        keywords: ['delete', 'confirm', 'confirmation', 'prompt', 'are you sure', 'confirm_message_delete'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_scroll_chat_to_bottom',
        keys: ['auto_scroll_chat_to_bottom'],
        label: 'Auto-scroll Chat',
        section: 'chat',
        group: 'Chat Column',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto_scroll_chat_to_bottom' },
        affects: ['chat-column'],
        keywords: ['scroll', 'autoscroll', 'auto scroll', 'bottom', 'follow', 'auto_scroll_chat_to_bottom'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'pin_styles',
        keys: ['pin_styles'],
        label: 'Pin Greeting Message Styles',
        section: 'chat',
        group: 'Chat Column',
        control: 'checkbox',
        binding: { by: 'id', ref: 'pin_styles' },
        affects: ['chat-column', 'message-row'],
        keywords: ['pin', 'styles', 'greeting', 'first message', 'style pins', 'pin_styles'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'chat_truncation',
        keys: ['chat_truncation'],
        // `settings-v0.md` §5 truth fix: stock's "(0 = All)" is false in BOTH layouts — `0`
        // means the windowed scrollback, which auto-loads (`script.js:1480-1481, 1580-1585`).
        label: 'Messages to Load (0 = windowed scrollback, auto-loads)',
        section: 'chat',
        group: 'Chat Column',
        control: 'range',
        binding: { by: 'id', ref: 'chat_truncation' },
        // `index.html:5457-5466`. Carries `#chat_truncation_counter` and the `(0 = …)` note this
        // batch corrects in place.
        adopt: 'div:has(> #chat_truncation)',
        affects: ['chat-column'],
        keywords: ['truncation', 'messages to load', 'history', 'scrollback', 'pagination', 'load', 'chat_truncation'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'example_messages_behavior',
        // The one control that writes two keys (`power-user.js:3391-3403`); its displayed value
        // is derived by `getExampleMessagesBehavior()` (`:1620`). Census §5.9 — this is why
        // `keys` is an array everywhere.
        keys: ['pin_examples', 'strip_examples'],
        label: 'Example Messages Behavior',
        section: 'chat',
        group: 'Chat Column',
        control: 'select',
        binding: { by: 'id', ref: 'example_messages_behavior' },
        // `index.html:5477-5488`. The `<label for=>` is a real affordance — clicking the caption
        // focuses the select — and it is not a `label.checkbox_label`, so the default resolver
        // walks past it and would leave it behind.
        adopt: '#examples-behavior-block',
        affects: ['prompt', 'chat-column'],
        keywords: ['examples', 'example messages', 'mes example', 'pin', 'strip', 'keep', 'pin_examples', 'strip_examples'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_fix_generated_markdown',
        keys: ['auto_fix_generated_markdown'],
        label: 'Auto-fix Markdown',
        section: 'chat',
        group: 'Response Formatting',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto_fix_generated_markdown' },
        affects: ['message-row'],
        keywords: ['markdown', 'fix', 'asterisks', 'formatting', 'auto_fix_generated_markdown'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'allow_name1_display',
        keys: ['allow_name1_display'],
        label: 'Show {{user}}: in Responses',
        section: 'chat',
        group: 'Response Formatting',
        control: 'checkbox',
        binding: { by: 'id', ref: 'allow_name1_display' },
        affects: ['message-row'],
        keywords: ['name', 'user', 'persona name', 'prefix', 'show name', 'allow_name1_display'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'allow_name2_display',
        keys: ['allow_name2_display'],
        label: 'Show {{char}}: in Responses',
        section: 'chat',
        group: 'Response Formatting',
        control: 'checkbox',
        binding: { by: 'id', ref: 'allow_name2_display' },
        affects: ['message-row'],
        keywords: ['name', 'char', 'character name', 'prefix', 'show name', 'allow_name2_display'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'encode_tags',
        keys: ['encode_tags'],
        label: 'Show <tags> in Responses',
        section: 'chat',
        group: 'Response Formatting',
        control: 'checkbox',
        binding: { by: 'id', ref: 'encode_tags' },
        affects: ['message-row'],
        keywords: ['tags', 'html', 'xml', 'escape', 'encode', 'angle brackets', 'encode_tags'],
        // Key and label look opposite but agree: escaping `<`/`>` is what makes tags *visible*
        // (`script.js:2006-2009`; census §2.9 ODD).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'image_overswipe',
        keys: ['image_overswipe'],
        label: 'Image Swipe Behavior',
        section: 'chat',
        group: 'Images & Gestures',
        control: 'select',
        binding: { by: 'id', ref: 'image_overswipe' },
        // `index.html:5489-5499`, same `<label for=>` shape as the block above but on an
        // unnamed `<div>`.
        adopt: 'div:has(> #image_overswipe)',
        affects: ['media', 'message-row'],
        keywords: ['image', 'swipe', 'overswipe', 'gallery', 'stable diffusion', 'image_overswipe'],
        // Census §1.4 DEAD-CANDIDATE for core: the only read site is the bundled
        // stable-diffusion extension (`extensions/stable-diffusion/index.js:5350`). Kept
        // visible — an extension consumer is a consumer, and it is not on any kill list.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'gestures-checkbox',
        keys: ['gestures'],
        label: 'Gestures',
        section: 'chat',
        group: 'Images & Gestures',
        control: 'checkbox',
        binding: { by: 'id', ref: 'gestures-checkbox' },
        affects: ['message-row', 'composer'],
        keywords: ['gestures', 'swipe gesture', 'touch', 'mobile', 'drag'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'show_group_chat_queue',
        keys: ['show_group_chat_queue'],
        label: 'Show Group Chat Queue',
        section: 'chat',
        group: 'Group Chats',
        control: 'checkbox',
        binding: { by: 'id', ref: 'show_group_chat_queue' },
        affects: ['chat-column'],
        keywords: ['group', 'queue', 'turn order', 'group chat', 'show_group_chat_queue'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'disable_group_trimming',
        keys: ['disable_group_trimming'],
        label: 'Relax Message Trim in Groups',
        section: 'chat',
        group: 'Group Chats',
        control: 'checkbox',
        binding: { by: 'id', ref: 'disable_group_trimming' },
        affects: ['prompt', 'chat-column'],
        keywords: ['group', 'trim', 'trimming', 'group chat', 'context', 'disable_group_trimming'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_swipe',
        keys: ['auto_swipe'],
        label: 'Auto-swipe',
        section: 'chat',
        group: 'Auto-swipe',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto_swipe' },
        affects: ['message-row'],
        keywords: ['auto swipe', 'autoswipe', 'retry', 'reroll', 'automatic', 'auto_swipe'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_swipe_minimum_length',
        keys: ['auto_swipe_minimum_length'],
        label: 'Minimum Generated Message Length',
        section: 'chat',
        group: 'Auto-swipe',
        control: 'number',
        binding: { by: 'id', ref: 'auto_swipe_minimum_length' },
        affects: ['message-row'],
        keywords: ['auto swipe', 'minimum', 'length', 'short', 'threshold', 'auto_swipe_minimum_length'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_swipe_blacklist',
        keys: ['auto_swipe_blacklist'],
        label: 'Blacklisted Words',
        section: 'chat',
        group: 'Auto-swipe',
        control: 'textarea',
        binding: { by: 'id', ref: 'auto_swipe_blacklist' },
        affects: ['message-row'],
        keywords: ['auto swipe', 'blacklist', 'banned words', 'filter', 'auto_swipe_blacklist'],
        // Stored as an ARRAY, edited as CSV (split `power-user.js:3656`, joined `:1740`), and
        // one of the three load-bearing defaults that may never be removed — `:1740` and
        // `:3135` deref it unguarded (persistence §7.2 rule 7).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_swipe_blacklist_threshold',
        keys: ['auto_swipe_blacklist_threshold'],
        label: 'Blacklisted Word Count to Swipe',
        section: 'chat',
        group: 'Auto-swipe',
        control: 'number',
        binding: { by: 'id', ref: 'auto_swipe_blacklist_threshold' },
        affects: ['message-row'],
        keywords: ['auto swipe', 'blacklist', 'threshold', 'count', 'auto_swipe_blacklist_threshold'],
        // Census §5.12: JS default is 2 (`power-user.js:183`), the markup ships `value="1"`.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_continue_enabled',
        keys: ['auto_continue.enabled'],
        label: 'Auto-Continue',
        section: 'chat',
        group: 'Auto-continue',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto_continue_enabled' },
        affects: ['prompt', 'chat-column'],
        keywords: ['auto continue', 'continue', 'automatic', 'unfinished', 'auto_continue'],
        // `auto_continue.*` is a load-bearing default (`power-user.js:1778-1780` derefs it
        // unguarded) — hideable, never removable.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_continue_allow_chat_completions',
        keys: ['auto_continue.allow_chat_completions'],
        label: 'Allow Auto-Continue for Chat Completion APIs',
        section: 'chat',
        group: 'Auto-continue',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto_continue_allow_chat_completions' },
        affects: ['prompt'],
        keywords: ['auto continue', 'chat completion', 'openai', 'allow', 'auto_continue'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto_continue_target_length',
        keys: ['auto_continue.target_length'],
        label: 'Auto-Continue Target Length (tokens)',
        section: 'chat',
        group: 'Auto-continue',
        control: 'number',
        binding: { by: 'id', ref: 'auto_continue_target_length' },
        // `index.html:5640-5645` — the input is INSIDE its label, not beside it. Adopting the
        // input alone would pull it out of its own `<label>` and leave the caption behind with
        // an empty box; this is the one row where the default resolver would actively break the
        // markup rather than merely under-select it.
        adopt: 'label[for="auto_continue_target_length"]',
        affects: ['prompt'],
        keywords: ['auto continue', 'target', 'length', 'tokens', 'auto_continue'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },

    // ─── Streaming & Input ───────────────────────────────────────────────────────────────

    {
        id: 'smooth_streaming',
        keys: ['smooth_streaming'],
        label: 'Smooth Streaming',
        section: 'streaming',
        group: 'Streaming',
        control: 'checkbox',
        binding: { by: 'id', ref: 'smooth_streaming' },
        affects: ['streaming'],
        keywords: ['smooth', 'streaming', 'typewriter', 'animation', 'letter by letter', 'smooth_streaming'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'smooth_streaming_no_think',
        keys: ['smooth_streaming_no_think'],
        label: 'Exclude "Thinking..." from Smooth Streaming',
        section: 'streaming',
        group: 'Streaming',
        control: 'checkbox',
        binding: { by: 'id', ref: 'smooth_streaming_no_think' },
        affects: ['streaming'],
        keywords: ['smooth', 'streaming', 'thinking', 'reasoning', 'exclude', 'smooth_streaming_no_think'],
        // Census §5.6: the ONLY parent/child gate among the 110, and it is expressed purely in
        // CSS (`toggle-dependent.css:480-481`) with no JS involved. The modal must keep the
        // three `#smooth_streaming*_control` wrappers adjacent siblings or the gate goes inert.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'smooth_streaming_speed',
        keys: ['smooth_streaming_speed'],
        label: 'Smooth Streaming Speed',
        section: 'streaming',
        group: 'Streaming',
        control: 'range',
        binding: { by: 'id', ref: 'smooth_streaming_speed' },
        // `index.html:5367-5374`. The range has no `<label>` at all — its whole legend is the
        // `.slider_hint` Slow/…/Fast strip inside this wrapper, which is also the node the CSS
        // gate at `toggle-dependent.css:480` addresses.
        adopt: '#smooth_streaming_speed_control',
        affects: ['streaming'],
        keywords: ['smooth', 'streaming', 'speed', 'slow', 'fast', 'pace', 'smooth_streaming_speed'],
        // The only range in the drawer with no numeric counter; same CSS gate as above.
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'streaming_fps',
        keys: ['streaming_fps'],
        label: 'Streaming FPS',
        section: 'streaming',
        group: 'Streaming',
        control: 'range',
        binding: { by: 'id', ref: 'streaming_fps' },
        // `index.html:5468-5475`, caption + `#streaming_fps_counter`.
        adopt: 'div:has(> #streaming_fps)',
        affects: ['streaming'],
        keywords: ['fps', 'streaming', 'frame rate', 'refresh', 'performance', 'paint', 'streaming_fps'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stream_fade_in',
        keys: ['stream_fade_in'],
        // `settings-v0.md` §5 truth fix: the label gains its cost. ON disables the incremental
        // streaming path — full format + full paint per tick (`streaming-view.js:296-305`).
        label: 'Stream Fade-In (crossfade; uses the classic streaming path)',
        section: 'streaming',
        group: 'Streaming',
        control: 'checkbox',
        binding: { by: 'id', ref: 'stream_fade_in' },
        affects: ['streaming', 'message-row'],
        keywords: ['fade', 'fade in', 'crossfade', 'streaming', 'experimental', 'stream_fade_in'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'reasoning_auto_parse',
        keys: ['reasoning.auto_parse'],
        label: 'Auto-parse Reasoning Blocks',
        // Not a census row: it renders in the AdvancedFormatting drawer, which is offstage
        // under rails. `settings-v0.md` §3.3 pins the reasoning pair into this tab.
        section: 'streaming',
        group: 'Reasoning',
        control: 'checkbox',
        binding: { by: 'id', ref: 'reasoning_auto_parse' },
        affects: ['streaming', 'message-row'],
        keywords: ['reasoning', 'thinking', 'think', 'parse', 'auto parse', 'cot', 'chain of thought', 'reasoning.auto_parse'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'reasoning_show_hidden',
        keys: ['reasoning.show_hidden'],
        label: 'Show Hidden Reasoning',
        section: 'streaming',
        group: 'Reasoning',
        control: 'checkbox',
        binding: { by: 'id', ref: 'reasoning_show_hidden' },
        affects: ['streaming', 'message-row'],
        keywords: ['reasoning', 'thinking', 'hidden', 'show', 'cot', 'chain of thought', 'reasoning.show_hidden'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'send_on_enter',
        keys: ['send_on_enter'],
        label: 'Enter to Send',
        section: 'streaming',
        group: 'Sending',
        control: 'select',
        binding: { by: 'id', ref: 'send_on_enter' },
        affects: ['composer'],
        keywords: ['enter', 'send', 'keyboard', 'submit', 'newline', 'shift enter', 'send_on_enter'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'continue_on_send',
        keys: ['continue_on_send'],
        label: '"Send" to Continue',
        section: 'streaming',
        group: 'Sending',
        control: 'checkbox',
        binding: { by: 'id', ref: 'continue_on_send' },
        affects: ['composer', 'prompt'],
        keywords: ['continue', 'send', 'empty', 'resume', 'continue_on_send'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'quick_continue',
        keys: ['quick_continue'],
        label: 'Quick "Continue" Button',
        section: 'streaming',
        group: 'Composer Buttons',
        control: 'checkbox',
        binding: { by: 'id', ref: 'quick_continue' },
        affects: ['composer'],
        keywords: ['continue', 'quick', 'button', 'shortcut', 'quick_continue'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'quick_impersonate',
        keys: ['quick_impersonate'],
        label: 'Quick "Impersonate" Button',
        section: 'streaming',
        group: 'Composer Buttons',
        control: 'checkbox',
        binding: { by: 'id', ref: 'quick_impersonate' },
        affects: ['composer'],
        keywords: ['impersonate', 'quick', 'button', 'shortcut', 'quick_impersonate'],
        // Census §5.2 / `settings-v0.md` §5: the checkbox ECHO loads from `quick_continue`
        // (`power-user.js:1734`) — a one-line stock bug slice C fixes. Write path and
        // button-visibility read are both correct.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'restore_user_input',
        keys: ['restore_user_input'],
        label: 'Restore User Input',
        section: 'streaming',
        group: 'Input Field',
        control: 'checkbox',
        binding: { by: 'id', ref: 'restore_user_input' },
        affects: ['composer'],
        keywords: ['restore', 'input', 'draft', 'reload', 'remember', 'restore_user_input'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'chat-show-reply-prefix-checkbox',
        keys: ['show_user_prompt_bias'],
        label: 'Show Reply Prefix in Chat',
        // Not a census row: AdvancedFormatting drawer (`index.html:4736`), bound in
        // `power-user.js:3367`. `settings-v0.md` §3.3 pins it into this tab.
        section: 'streaming',
        group: 'Input Field',
        control: 'checkbox',
        binding: { by: 'id', ref: 'chat-show-reply-prefix-checkbox' },
        affects: ['composer', 'message-row'],
        keywords: ['prompt bias', 'reply prefix', 'prefix', 'start reply with', 'bias', 'show_user_prompt_bias'],
        tier: 'simple',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'enable_auto_select_input',
        keys: ['enable_auto_select_input'],
        label: 'Auto-select Input Text',
        section: 'streaming',
        group: 'Input Field',
        control: 'checkbox',
        binding: { by: 'id', ref: 'enable_auto_select_input' },
        affects: ['composer'],
        keywords: ['select', 'auto select', 'input', 'highlight', 'enable_auto_select_input'],
        // Census §5.4 / `settings-v0.md` §5: the wrapping label's `for=" enable_auto_select_input"`
        // has a LEADING SPACE (`index.html:5394`) and therefore labels nothing. Slice C's fix.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'enable_md_hotkeys',
        keys: ['enable_md_hotkeys'],
        label: 'Markdown Hotkeys',
        section: 'streaming',
        group: 'Input Field',
        control: 'checkbox',
        binding: { by: 'id', ref: 'enable_md_hotkeys' },
        affects: ['composer'],
        keywords: ['markdown', 'hotkeys', 'shortcuts', 'bold', 'italic', 'ctrl b', 'enable_md_hotkeys'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'compact_input_area',
        keys: ['compact_input_area'],
        label: 'Compact Input Area',
        section: 'streaming',
        group: 'Input Field',
        control: 'checkbox',
        binding: { by: 'id', ref: 'compact_input_area' },
        affects: ['composer'],
        keywords: ['compact', 'input', 'composer', 'small', 'mobile', 'compact_input_area'],
        // supersession §6 #12 flagged it borderline; `settings-v0.md` §4 kept it visible.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },

    // ─── World Info ──────────────────────────────────────────────────────────────────────
    // TWO blocks, split at `#wi-holder`'s clean seam: `#wi-holder` (`index.html:4775`) has
    // exactly two element children and nothing interleaved — `#wiTopBlock` (`:4776-4909`, the
    // settings strip) and `#world_popup` (`:4910-4957`, the editor). No settings control lives
    // in the editor; no editor control lives in the strip (recon §3.1).
    //
    // **The strip's 14 settings ride their block. No per-key entries — ever.** All fourteen
    // live in `world_info_settings`, which `getWorldInfoSettings()` (`world-info.js:795-812`)
    // rebuilds as a fresh object literal on EVERY save (`script.js:8400`): a key absent from
    // that literal never enters the payload, so the destruction is save-side and no load-side
    // care can rescue it. It is a DIE lane (persistence H3; `settings-v0.md` §1 rule 1), and
    // fourteen registry rows naming it would turn the "zero DIE-lane keys" gate into a rule
    // with an exception list. Relocation is DOM-only and safe; a key claim is not.
    // The cost is honest and small: per-row search inside the strip is a chip, not a promise —
    // the block-level `keywords` below are what answers "budget", "recursion", "case
    // sensitive" today, and they land the searcher on the tab that holds the control.
    //
    // Discarded on adoption (they are drawer furniture, not settings): `#WorldInfoheader`
    // (`:4759`), the `h3` (`:4768`), `#WI_panel_pin_div` (`:4761`, which writes
    // `accountStorage['WINavLockOn']` — `RossAscends-mods.js:763`).
    {
        id: 'wiTopBlock',
        keys: [],
        label: 'World Info Settings',
        section: 'worldinfo',
        control: 'block',
        binding: { by: 'id', ref: 'wiTopBlock' },
        // Adopting the strip whole also disposes of the single nastiest trap on this surface
        // for free: `#world_info` is select2 (`world-info.js:6371`), its container is a NEXT
        // SIBLING (`utils.js:2393`), the original select is clipped to 1×1, and the entire
        // choice-click handler that jumps into the editor is bound to that sibling span. A
        // per-key entry adopting the bare `<select>` resolves successfully, warns nothing and
        // renders an invisible sliver. Inside `#wiTopBlock` the select, its `#WIMultiSelector`
        // wrapper (`:4777`) and the injected container all travel together, and
        // `world-info.css:324` (`#WIMultiSelector .select2-container …`) stays true.
        adopt: '#wiTopBlock',
        affects: ['prompt'],
        keywords: [
            'world info', 'worldinfo', 'lorebook', 'lorebooks', 'lore', 'wi', 'active world',
            'global lorebook', 'activation', 'min activations', 'budget', 'budget cap', 'depth',
            'scan depth', 'recursion', 'recursive', 'max recursion steps', 'case sensitive',
            'match whole words', 'group scoring', 'overflow alert', 'include names',
            'character strategy', 'insertion strategy', 'keys', 'keywords', 'triggers',
        ],
        tier: 'advanced',
        // Vacuous — `keys: []` claims no lane. The fourteen real keys are `world_info_settings`
        // members and stay entirely stock's, which is the whole point of the paragraph above.
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'world_popup',
        keys: [],
        label: 'Lorebook Editor',
        section: 'worldinfo',
        control: 'block',
        binding: { by: 'id', ref: 'world_popup' },
        // Safe to borrow because it has no lifecycle of its own: `#world_popup` never
        // unmounts, `clearEntryList()` (`world-info.js:2247-2307`) is scoped strictly to its
        // `$list` argument and never touches the container, the file has no `replaceWith` and
        // no structural `innerHTML =`, there is no `MutationObserver`, and the only two
        // `eventSource` subscriptions (`CHAT_CHANGED` `:1013-1018`,
        // `WORLDINFO_FORCE_ACTIVATE` `:1020-1029`) touch no editor DOM. Nothing chat- or
        // character-driven can tear it down while it is borrowed (recon §3.5).
        // `#entry_edit_template` (`index.html:6984`) is captured as module-load-time node refs
        // (`world-info.js:62-63`) and cloned at `:3365`/`:3556`: it lives outside the drawer,
        // it must stay there, and nothing may re-parse it.
        // Debt, recorded: `$('#WorldInfo').on('scroll', …)` (`:6392-6400`) closes jQuery-UI
        // autocompletes and `$('#WorldInfo').scrollTop(…)` (`:2465`) drives navigate-to-entry.
        // After adoption `#WorldInfo` is no longer the scroll container, so both go cosmetic.
        adopt: '#world_popup',
        affects: ['prompt'],
        keywords: [
            'lorebook', 'lorebooks', 'world info', 'worldinfo', 'editor', 'entries', 'entry',
            'new entry', 'create lorebook', 'new lorebook', 'import lorebook', 'export lorebook',
            'rename', 'duplicate', 'delete lorebook', 'fill', 'backfill', 'constant', 'blue',
            'green', 'trigger', 'secondary keys', 'sort entries', 'search entries', 'probability',
        ],
        tier: 'advanced',
        // Vacuous — the editor is fifteen buttons, two selects, a search, a paginator and a
        // sortable list, and none of it is value-bearing under `world_info_settings`.
        store: 'power_user',
        surface: 'modal',
    },

    // ─── Extensions ──────────────────────────────────────────────────────────────────────
    {
        id: 'extensions-settings-button',
        keys: [],
        label: 'Extensions',
        section: 'extensions',
        control: 'block',
        binding: { by: 'id', ref: 'extensions-settings-button' },
        // The whole `.drawer` WRAPPER (`index.html:5870-5952`), exactly as `k-tab-rail` docks
        // it today (`k-tab-rail.js:167-173`, `#dockAll()` `:286-337`) — one `appendChild`,
        // which MOVES the live node with every third-party panel inside it intact.
        //
        // **`CONTRACT.md:71-75` permits this explicitly.** `#extensions_settings` (column 1)
        // and `#extensions_settings2` (column 2) are frozen ABI (`CONTRACT.md:118-119`), and
        // the promise is that the ids "continue to exist in the live DOM, on an element that
        // plays the same role, reachable by `document.getElementById()` … They may be **moved**
        // in the tree, restyled, re-parented, wrapped, or re-rendered by different code. They
        // may **not** be renamed, deleted, duplicated, or hidden inside a shadow root."
        // Moving the wrapper does none of the forbidden four.
        //
        // Splitting the two columns out is affirmatively dangerous, not merely worse: they are
        // siblings in ONE `flex-wrap` row (`index.html:5875`; `st-tailwind.css:268-272`) and
        // their 50/50 comes from `wide50p` plus that parent, and
        // `SillyTavern-MoonlitEchoesTheme/style.css:3793-3806` styles the header controls by
        // descendant selector FROM `#rm_extensions_block` inside a
        // `@media (max-width: 1000px)` block — lift the columns out and those rules stop
        // matching with no error, only below 1000px (recon §4.6).
        //
        // Two holders for one node is the headline trap and it has no recovery path: nothing
        // in the codebase re-creates these containers (recon §4.5 — a sweep of `extensions.js`
        // for `.empty()`/`innerHTML =`/`replaceWith`/`removeChild`/`.detach()` returns zero
        // hits), so a wrapper that lands where neither ledger expects is a `location.reload()`.
        // The mitigation is structural and belongs to the slices, not to this entry: the rail
        // DROPS the Extensions dock in the same batch this tab lands. Exactly one holder, ever.
        //
        // And never gate adoption on "extensions are done" — there is no such moment
        // (recon §4.2: panels mount at boot AND later, on wall-clock timers, with no completion
        // signal), which is also why the block must never sit behind a Lit `${}` ChildPart.
        adopt: '#extensions-settings-button',
        affects: ['chrome', 'startup'],
        keywords: [
            'extension', 'extensions', 'plugin', 'plugins', 'addon', 'add-on', 'add on',
            'manage extensions', 'install extension', 'install', 'update extensions', 'git',
            'third party', 'notify updates', 'extension settings', 'panel', 'panels',
            // No 'extras' terms: the Extras API strip is retired (baggage-audit-v0 §1).
            'auto-update',
        ],
        tier: 'advanced',
        // Vacuous — `keys: []`. Extension state lives in `extension_settings`, a SURVIVE lane
        // stock already owns end to end; the registry describes the surface, not the lane.
        store: 'power_user',
        surface: 'modal',
    },

    // ─── Scripting & Tools ───────────────────────────────────────────────────────────────

    {
        id: 'stscript_autocomplete_state',
        keys: ['stscript.autocomplete.state'],
        label: 'Autocomplete Visibility',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'select',
        binding: { by: 'id', ref: 'stscript_autocomplete_state' },
        // `index.html:5657-5666`. `<label for=>` + select inside a `<div>` that also holds the
        // row tooltip; the label is an affordance the default resolver does not see.
        adopt: 'div:has(> label[for="stscript_autocomplete_state"])',
        affects: ['scripting'],
        keywords: ['autocomplete', 'visibility', 'suggestions', 'stscript', 'slash commands', 'stscript.autocomplete.state'],
        // The whole `stscript.*` chain is load-bearing at boot (`power-user.js:1807-1822` derefs
        // `.parser.flags` and `.autocomplete.style` bare) — hideable, never removable.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_autoHide',
        keys: ['stscript.autocomplete.autoHide'],
        label: 'Automatically Hide Autocomplete Details',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'checkbox',
        binding: { by: 'id', ref: 'stscript_autocomplete_autoHide' },
        affects: ['scripting'],
        keywords: ['autocomplete', 'hide', 'details', 'help', 'stscript', 'stscript.autocomplete.autoHide'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_showInAllMacroFields',
        keys: ['stscript.autocomplete.showInAllMacroFields'],
        label: 'Show Autocomplete in All Macro Fields',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'checkbox',
        binding: { by: 'id', ref: 'stscript_autocomplete_showInAllMacroFields' },
        affects: ['scripting'],
        keywords: ['autocomplete', 'macro', 'macros', 'fields', 'everywhere', 'stscript.autocomplete.showInAllMacroFields'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_matching',
        keys: ['stscript.matching'],
        label: 'Autocomplete Matching',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'select',
        binding: { by: 'id', ref: 'stscript_matching' },
        // `index.html:5680-5689`, same shape.
        adopt: 'div:has(> label[for="stscript_matching"])',
        affects: ['scripting'],
        keywords: ['autocomplete', 'matching', 'fuzzy', 'starts with', 'includes', 'stscript.matching'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_style',
        keys: ['stscript.autocomplete.style'],
        label: 'Autocomplete Style',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'select',
        binding: { by: 'id', ref: 'stscript_autocomplete_style' },
        // `index.html:5690-5702`. Named through the LABEL rather than the select, because here
        // the select is one level deeper (`div.flex1 > div.flex-container > select`).
        adopt: 'div:has(> label[for="stscript_autocomplete_style"])',
        affects: ['scripting', 'theme-tokens'],
        keywords: ['autocomplete', 'style', 'theme', 'appearance', 'stscript', 'stscript.autocomplete.style'],
        // Applied as `body[data-stscript-style]` (`power-user.js:4027`, `:1812`).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_select',
        keys: ['stscript.autocomplete.select'],
        label: 'Autocomplete Keyboard',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'select',
        binding: { by: 'id', ref: 'stscript_autocomplete_select' },
        affects: ['scripting'],
        keywords: ['autocomplete', 'keyboard', 'tab', 'enter', 'select', 'accept', 'stscript.autocomplete.select'],
        // A BITMASK (`TAB | ENTER`) rendered as a 3-option select (census §2.10 ODD).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_font_scale',
        keys: ['stscript.autocomplete.font.scale'],
        label: 'Autocomplete Font Scale',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'range',
        binding: { by: 'id', ref: 'stscript_autocomplete_font_scale' },
        // `index.html:5714-5718`, label + slider + `#stscript_autocomplete_font_scale_counter`
        // — the last of the seven slider mirrors.
        adopt: 'div:has(> label[for="stscript_autocomplete_font_scale"])',
        affects: ['scripting', 'theme-tokens'],
        keywords: ['autocomplete', 'font', 'scale', 'size', 'text size', 'stscript.autocomplete.font.scale'],
        // The only counter in the drawer bound twice: its own handler (`power-user.js:4045`)
        // AND the generic `.neo-range-input` delegate (`script.js:12816+`). Census §5.9.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_width_left',
        keys: ['stscript.autocomplete.width.left'],
        label: 'Autocomplete Width (left)',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'range',
        binding: { by: 'id', ref: 'stscript_autocomplete_width_left' },
        affects: ['scripting'],
        keywords: ['autocomplete', 'width', 'left', 'size', 'stscript.autocomplete.width.left'],
        // Half of a dual-range widget; `power-user.js:1820` fakes an `input` event to re-paint.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_autocomplete_width_right',
        keys: ['stscript.autocomplete.width.right'],
        label: 'Autocomplete Width (right)',
        section: 'scripting',
        group: 'Autocomplete',
        control: 'range',
        binding: { by: 'id', ref: 'stscript_autocomplete_width_right' },
        affects: ['scripting'],
        keywords: ['autocomplete', 'width', 'right', 'size', 'stscript.autocomplete.width.right'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_parser_flag_strict_escaping',
        // `PARSER_FLAG.STRICT_ESCAPING` is the numeric key `1`
        // (`slash-commands/SlashCommandParser.js:38-40`), which is how it lands in the blob.
        keys: ['stscript.parser.flags.1'],
        label: 'STRICT_ESCAPING',
        section: 'scripting',
        group: 'STscript & Macros',
        control: 'checkbox',
        binding: { by: 'id', ref: 'stscript_parser_flag_strict_escaping' },
        affects: ['scripting'],
        keywords: ['stscript', 'parser', 'escaping', 'strict', 'backslash', 'flag', 'slash commands'],
        // Bound on `click`, not `input`/`change`, unlike every other checkbox in the drawer.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'stscript_parser_flag_replace_getvar',
        keys: ['stscript.parser.flags.2'],
        label: 'REPLACE_GETVAR',
        section: 'scripting',
        group: 'STscript & Macros',
        control: 'checkbox',
        binding: { by: 'id', ref: 'stscript_parser_flag_replace_getvar' },
        affects: ['scripting'],
        keywords: ['stscript', 'parser', 'getvar', 'variables', 'macro', 'flag', 'slash commands'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'experimental_macro_engine',
        keys: ['experimental_macro_engine'],
        label: 'Experimental Macro Engine',
        section: 'scripting',
        group: 'STscript & Macros',
        control: 'checkbox',
        binding: { by: 'id', ref: 'experimental_macro_engine' },
        affects: ['scripting', 'prompt'],
        keywords: ['macro', 'macros', 'engine', 'experimental', 'parser', 'experimental_macro_engine'],
        // Default is TRUE (`power-user.js:302`) despite the flask icon, and
        // `MacroDiagnostics.js:62-63` can flip it and re-fire the checkbox.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'console_log_prompts',
        keys: ['console_log_prompts'],
        label: 'Log Prompts to Console',
        section: 'scripting',
        group: 'Diagnostics',
        control: 'checkbox',
        binding: { by: 'id', ref: 'console_log_prompts' },
        affects: ['diagnostics', 'prompt'],
        keywords: ['console', 'log', 'prompts', 'debug', 'devtools', 'console_log_prompts'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'request_token_probabilities',
        keys: ['request_token_probabilities'],
        label: 'Request Token Probabilities',
        section: 'scripting',
        group: 'Diagnostics',
        control: 'checkbox',
        binding: { by: 'id', ref: 'request_token_probabilities' },
        affects: ['diagnostics', 'request'],
        keywords: ['logprobs', 'probabilities', 'tokens', 'debug', 'request_token_probabilities'],
        // A *display* toggle that changes the outgoing request body (census §2.9 ODD).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    // §3.4 names the debug-menu affordance as Scripting & Tools content. An ACTION row like
    // the theme file-ops: no key, bound straight by id (`power-user.js:3974`), so relocation
    // is free — the handler is on the node, not delegated from the rack.
    // Moved up beside the two diagnostics toggles in slice E: `group` eyebrows are contiguous
    // runs of `getEntries()` order, and "Diagnostics" cannot be two eyebrows with the
    // Experimental pair sitting between them. §3.4's own list orders it this way too
    // ("STscript (2), AutoComplete (9), debug-menu affordance, lab mode, zen sliders").
    {
        id: 'debug_menu',
        keys: [],
        label: 'Debug Menu',
        section: 'scripting',
        group: 'Diagnostics',
        control: 'button',
        binding: { by: 'id', ref: 'debug_menu' },
        affects: ['diagnostics'],
        keywords: ['debug', 'debug menu', 'diagnostics', 'developer', 'tools', 'troubleshoot', 'console'],
        // Opens `templates/debug.html`; its contents are a runtime registry
        // (`registerDebugFunction`, `power-user.js:1545`) that this map does not enumerate.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'enableZenSliders',
        keys: ['enableZenSliders'],
        label: 'Zen Sliders',
        section: 'scripting',
        group: 'Experimental',
        control: 'checkbox',
        binding: { by: 'id', ref: 'enableZenSliders' },
        affects: ['scripting', 'chrome'],
        keywords: ['zen', 'sliders', 'samplers', 'simple sliders', 'enableZenSliders'],
        // Mutually exclusive with Mad Lab (`power-user.js:3790`). Its body class has no CSS
        // consumer anywhere (census §5.5) — chipped, not killed.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'enableLabMode',
        keys: ['enableLabMode'],
        label: 'Mad Lab Mode',
        section: 'scripting',
        group: 'Experimental',
        control: 'checkbox',
        binding: { by: 'id', ref: 'enableLabMode' },
        affects: ['scripting', 'chrome'],
        keywords: ['mad lab', 'lab mode', 'sliders', 'unlock', 'samplers', 'enableLabMode'],
        // Mutually exclusive with Zen (`power-user.js:3803`); re-fired with `{fromInit:true}`
        // at `:1798`. Body class has no CSS consumer either.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },


    // ─── System ──────────────────────────────────────────────────────────────────────────
    // `auto-connect-checkbox` used to open this section. It moved to `connection` in slice E
    // and folded into that tab's block (`withinBlock: 'rm_api_block'`) — the node it binds
    // lives at `index.html:4165`, inside `#rm_api_block`, so the block was always going to
    // carry it and a System row would have been a second claim on one node.

    {
        id: 'ui_language_select',
        keys: ['language'],
        label: 'Language',
        section: 'system',
        group: 'Startup',
        control: 'select',
        binding: { by: 'id', ref: 'ui_language_select' },
        affects: ['chrome', 'startup'],
        keywords: ['language', 'locale', 'translation', 'i18n', 'english', 'idioma'],
        tier: 'advanced',
        // The ONE drawer control that lives outside `settings.json` entirely
        // (`localStorage['language']`, `i18n.js:290`) and the ONE that force-reloads the page
        // (`i18n.js:295`) — persistence §1.7: it must `await saveSettings()`, never the debounce.
        store: 'localStorage',
        surface: 'modal',
    },
    {
        id: 'k-onboarding-replay',
        keys: ['kotatsu_onboarding'],
        label: 'Welcome Tour',
        section: 'system',
        group: 'Startup',
        control: 'kotatsu-tour',
        // Onboarding v0 (docs/onboarding-v0.md §3): drawn by the modal (`#renderTourReplay`),
        // no stock node. It writes nothing itself — it closes settings and dispatches
        // `k-open-onboarding`; the tour writes `kotatsu_onboarding` as it moves.
        binding: { by: 'id', ref: 'k-onboarding-replay', runtime: true },
        affects: ['startup'],
        keywords: ['welcome', 'tour', 'onboarding', 'tutorial', 'mikan-chan', 'kotatsu-chan', 'mascot', 'first run', 'setup', 'kotatsu_onboarding'],
        // An affordance, not a measured setting: advanced, like every other action row.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'auto-load-chat-checkbox',
        keys: ['auto_load_chat'],
        label: 'Auto-load Last Chat',
        section: 'system',
        group: 'Startup',
        control: 'checkbox',
        binding: { by: 'id', ref: 'auto-load-chat-checkbox' },
        affects: ['startup', 'chat-column'],
        keywords: ['auto load', 'last chat', 'startup', 'resume', 'boot', 'auto_load_chat'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'k-phone-card',
        keys: [],
        label: 'Use Kotatsu on your phone',
        section: 'system',
        group: 'Phone',
        control: 'kotatsu-phone',
        // Phone v0 (docs/phone-v0.md §4.1): drawn by the modal (`#renderNative` →
        // `<k-phone-card variant="settings">`). It owns no settings key: the switch writes
        // `listen` and `hostWhitelist.enabled` to config.yaml through `/api/kotatsu/phone/lan`, and
        // the paired list lives in `.kotatsu/paired-devices.json`. NOT a `block` — a block turns
        // off the System tab's two-column flow and needs a stock region to adopt.
        binding: { by: 'id', ref: 'k-phone-card', runtime: true },
        affects: ['startup'],
        keywords: [
            'phone', 'mobile', 'lan', 'local network', 'wifi', 'wi-fi', 'qr', 'qr code', 'tailscale',
            'pair', 'paired devices', 'device', 'forget', 'remote', 'listen', 'network',
        ],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'forbid_external_media',
        keys: ['forbid_external_media'],
        label: 'Forbid External Media',
        section: 'system',
        group: 'Media Policy',
        control: 'checkbox',
        binding: { by: 'id', ref: 'forbid_external_media' },
        affects: ['media', 'message-row'],
        keywords: ['external media', 'forbid', 'block', 'images', 'privacy', 'security', 'remote', 'forbid_external_media'],
        // Enforced ENTIRELY in the browser (`chats.js:852` `isExternalMediaAllowed()`); a grep
        // for `external_media` in `src/` returns zero hits (census §4). Per-character overrides
        // live in `external_media_*_overrides` and are set from the character UI, not here.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    // Character marketplace v0 slice E (`character-marketplace-v0.md` §7, §13 "the gate is
    // region"). Two string enums owned by `market/settings.js`, which resolves what unset means
    // (NSFW unset → off; blur unset → on) — the registry stores no default, persistence §7.2
    // rule 4. The Browse view also offers the NSFW switch inline; both write through the same
    // module, so the two never disagree.
    {
        id: 'kotatsu_market_nsfw',
        keys: ['kotatsu_market_nsfw'],
        label: 'Include NSFW cards when browsing',
        section: 'system',
        group: 'Browse Characters',
        control: 'checkbox',
        binding: { by: 'id', ref: 'kotatsu_market_nsfw' },
        affects: ['library'],
        keywords: ['nsfw', 'adult', 'browse', 'chub', 'marketplace', 'card site', 'kotatsu_market_nsfw'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'kotatsu_market_blur',
        keys: ['kotatsu_market_blur'],
        label: 'Blur NSFW portraits',
        section: 'system',
        group: 'Browse Characters',
        control: 'checkbox',
        binding: { by: 'id', ref: 'kotatsu_market_blur' },
        affects: ['library'],
        keywords: ['blur', 'nsfw', 'portrait', 'thumbnail', 'browse', 'kotatsu_market_blur'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'prefer_character_prompt',
        keys: ['prefer_character_prompt'],
        label: 'Prefer Character Prompt',
        // Re-homed from Character Handling per `settings-v0.md` §4: the gallery and the studio
        // own character *presentation*, but these two change what reaches the model, and the
        // gallery does not cover that. (Flagged for veto; if vetoed, `surface:'none'`.)
        section: 'system',
        group: 'Character Prompts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'prefer_character_prompt' },
        affects: ['prompt'],
        keywords: ['character prompt', 'prefer', 'system prompt', 'card', 'override', 'prefer_character_prompt'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'prefer_character_jailbreak',
        keys: ['prefer_character_jailbreak'],
        label: 'Prefer Character Instructions',
        section: 'system',
        group: 'Character Prompts',
        control: 'checkbox',
        binding: { by: 'id', ref: 'prefer_character_jailbreak' },
        affects: ['prompt'],
        keywords: ['character instructions', 'jailbreak', 'prefer', 'post history', 'card', 'override', 'prefer_character_jailbreak'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'relaxed_api_urls',
        keys: ['relaxed_api_urls'],
        label: 'Relaxed API URLs',
        section: 'system',
        group: 'Requests & Imports',
        control: 'checkbox',
        binding: { by: 'id', ref: 'relaxed_api_urls' },
        affects: ['request'],
        keywords: ['api', 'url', 'urls', 'relaxed', 'endpoint', 'lenient', 'relaxed_api_urls'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'world_import_dialog',
        keys: ['world_import_dialog'],
        label: 'Lorebook Import Dialog',
        section: 'system',
        group: 'Requests & Imports',
        control: 'checkbox',
        binding: { by: 'id', ref: 'world_import_dialog' },
        affects: ['notifications', 'prompt'],
        keywords: ['lorebook', 'world info', 'import', 'dialog', 'prompt', 'world_import_dialog'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'play_message_sound',
        keys: ['play_message_sound'],
        label: 'Message Sound',
        section: 'system',
        group: 'Sound',
        control: 'checkbox',
        binding: { by: 'id', ref: 'play_message_sound' },
        affects: ['sound'],
        keywords: ['sound', 'audio', 'notification', 'ping', 'chime', 'alert', 'play_message_sound'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'play_sound_unfocused',
        keys: ['play_sound_unfocused'],
        label: 'Background Sound Only',
        section: 'system',
        group: 'Sound',
        control: 'checkbox',
        binding: { by: 'id', ref: 'play_sound_unfocused' },
        affects: ['sound'],
        keywords: ['sound', 'audio', 'unfocused', 'background', 'tab', 'notification', 'play_sound_unfocused'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },

    // System affordances — `settings-v0.md` §3.5 ("data/backup affordances"), plus the
    // account cluster from the drawer's header row (census §2.0), which had no home in the
    // authored taxonomy because it is not a setting at all. It belongs here for the reason
    // §3.5 exists: this is the tab about the app rather than about the chat.
    //
    // All five are bound directly by id (`power-user.js:3727`, `data-maid.js:397`,
    // `user.js:919-927`) — no container delegation anywhere, so every one survives being
    // relocated (module rule 4 in `k-settings-modal.js`).
    {
        id: 'reload_chat',
        keys: [],
        label: 'Reload Chat',
        section: 'system',
        group: 'Maintenance',
        control: 'button',
        binding: { by: 'id', ref: 'reload_chat' },
        affects: ['chat-column', 'message-row'],
        keywords: ['reload', 'reload chat', 'refresh', 'redraw', 'rerender', 'repaint', 'chat'],
        // `power-user.js:3727` — saves settings and the chat, then redraws. The one action
        // row that touches the chat column, which is why its keywords lean that way.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'data_maid_button',
        keys: [],
        label: 'Clean Up Data',
        section: 'system',
        group: 'Maintenance',
        control: 'button',
        binding: { by: 'id', ref: 'data_maid_button' },
        affects: ['diagnostics', 'media'],
        keywords: ['clean', 'clean-up', 'cleanup', 'data maid', 'maid', 'backups', 'unused', 'disk', 'space', 'delete', 'prune'],
        // `data-maid.js:397` — `addEventListener`, not jQuery, and still id-addressed.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'account_button',
        keys: [],
        label: 'Account',
        section: 'system',
        group: 'Account',
        control: 'button',
        binding: { by: 'id', ref: 'account_button' },
        affects: ['startup'],
        keywords: ['account', 'profile', 'user', 'password', 'name', 'avatar', 'login'],
        // `user.js:926` → `openUserProfile()`. `affects: startup` is the nearest true term the
        // vocabulary has: these three end or change the session the app booted into, and
        // inventing an "account" surface for three action rows would widen the map for nothing.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'admin_button',
        keys: [],
        label: 'Admin Panel',
        section: 'system',
        group: 'Account',
        control: 'button',
        binding: { by: 'id', ref: 'admin_button' },
        affects: ['startup'],
        keywords: ['admin', 'admin panel', 'users', 'accounts', 'manage', 'server'],
        // `user.js:923` → `openAdminPanel()`. Visibility is not ours: `user.js:73` toggles it
        // to admins only, and `:24-26` hides it outright when accounts are off — see the
        // hidden-affordance row rule in `settings-modal.css`.
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },
    {
        id: 'logout_button',
        keys: [],
        label: 'Log Out',
        section: 'system',
        group: 'Account',
        control: 'button',
        binding: { by: 'id', ref: 'logout_button' },
        affects: ['startup'],
        keywords: ['logout', 'log out', 'sign out', 'signout', 'session', 'switch user', 'account'],
        // `user.js:920` → `logout()`. Hidden with the admin button when accounts are off
        // (`user.js:25`, `:30`).
        tier: 'advanced',
        store: 'power_user',
        surface: 'modal',
    },

    // System — not adopted (Character Handling drop, `settings-v0.md` §4).
    {
        id: 'tag_import_setting',
        keys: ['tag_import_setting'],
        label: 'Import Card Tags',
        section: 'system',
        control: 'select',
        binding: { by: 'id', ref: 'tag_import_setting' },
        affects: ['library'],
        keywords: ['tags', 'import', 'card tags', 'ask', 'none', 'all', 'tag_import_setting'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // `tags.js:1071` writes this key back and re-syncs the select outside `power-user.js`,
        // so the studio's import flow is where it belongs.
        rehome: 'card studio (import options)',
    },
    {
        id: 'fuzzy_search_checkbox',
        keys: ['fuzzy_search'],
        label: 'Advanced Character Search',
        section: 'system',
        control: 'checkbox',
        binding: { by: 'id', ref: 'fuzzy_search_checkbox' },
        affects: ['library'],
        keywords: ['search', 'fuzzy', 'advanced search', 'characters', 'find', 'fuzzy_search'],
        tier: 'advanced',
        store: 'power_user',
        surface: 'none',
        // Governs the parked roster only; the shipped landing's search is substring
        // (`library/view-model.js:320-338`).
        rehome: 'library search',
    },
    {
        id: 'never_resize_avatars',
        keys: ['never_resize_avatars'],
        label: 'Never Resize Avatars',
        section: 'system',
        control: 'checkbox',
        binding: { by: 'id', ref: 'never_resize_avatars' },
        affects: ['library', 'media'],
        keywords: ['avatar', 'resize', 'crop', 'never resize', 'full size', 'never_resize_avatars'],
        // Measured Simple-tier row #21 that lands `surface:'none'` — the Character Handling
        // drop is a section-wide decision, and avatar crop is a card-import concern. The key
        // still works everywhere it is read (`popup.js:499` → `characters.js:295 want_resize`).
        tier: 'simple',
        store: 'power_user',
        surface: 'none',
        rehome: 'card studio (avatar import)',
    },
]);
