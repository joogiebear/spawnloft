# UX/UI overhaul plan

2026-11-23. Branch `v2` at `f3fac3a` (the Rust core port is finished; the panel is `src/ui.html`,
`src/launcher.html` and `src/setup.html`, compiled into the Rust core and shown by the Tauri shell).
This is a plan only. Nothing in the repository was changed.

Screenshots of every main page as it is today are in
`current/` beside the working copy of this plan in the project files (21 pictures: 1440 wide, plus Overview at 2560 and 900, plus the SpawnLoft theme).

## 1. The short version

The two earlier passes (the 15 UX-scan phases and the 7 launcher phases, all merged on 2026-11-14)
made the app honest and safe: it no longer loses work, says untrue things, or shows raw errors. They
did not change how it looks, how it is laid out, or how it is built. That is what is left, and it is
four pieces of work:

1. **Foundations.** The whole panel is one 17,012-line file. Split it, give it a real set of shared
   components, and settle the Tailwind question. Nothing a person sees changes here, but every later
   step gets faster and safer.
2. **One look.** The website is charcoal and lime with its own typefaces. The app opens in a different
   blue theme with the system font, and looks different on Windows, macOS and Linux. Decide one identity
   and apply it everywhere at once.
3. **Layout.** A few structural things are awkward on every visit: the sidebar that unfolds ten tools
   and pushes the other servers down, an Overview that says the same warning three times, pages that
   read like documents. Fix the structure before polishing pages.
4. **Page by page.** Rebuild each page on the new components, and fold in the smaller findings from the
   November scan that were never built (555 were found; the 35 most important rows were built).

Recommended order: mock-ups first so you pick the direction by looking, then foundations, then the
shared look, then pages in parallel threads.

**Tailwind: yes, with conditions** (section 4). It should come in page by page as each page is
redesigned, on top of the colours and sizes the panel already has, using Tailwind's standalone program
so that no Node comes back into the product. A one-shot rewrite to Tailwind before the redesign is the
version to avoid.

## 2. What is there today

Measured on `v2` today.

| | |
|---|---|
| `src/ui.html` | 17,012 lines, 782 KB. 2,709 lines of CSS, about 770 of page markup, 13,523 of JavaScript in 345 functions |
| `src/launcher.html` | 3,787 lines (the Play page, shown inside the panel in a frame) |
| `src/setup.html` | 718 lines (first run) |
| CSS in the panel | 1,038 rules, 375 class names, all global |
| Design tokens | 115 variables, used 1,515 times. No font size is written as a raw number. 18 stray colour codes and 43 raw `rgba()` values outside the tokens |
| Responsive rules | 28 container queries (the density tiers), 7 window queries |
| How the page is drawn | By hand in JavaScript: 346 `className =` lines, 196 `el('…')` calls, 79 direct style writes, 60 inline `style="…"` |
| Themes | Two, Classic (blue, the default) and SpawnLoft (lime). Dark only |
| Tests tied to the page | `test/panel.test.mjs` lifts functions out of the HTML by name; `desktop/smoke-panel.cjs` uses 69 selectors, `smoke-tauri.cjs` 12 |

What this means:

- **The CSS is in good order.** Colours, type sizes and spacing already come from one token list. This
  is not a clean-up job, and whatever comes next should keep those tokens.
- **The problem is the single file and the missing component layer.** Every page builds its own rows,
  menus, dialogs and empty states by hand. A change to "what a list row looks like" is a change in a
  dozen places, and any thread editing the stylesheet can break a page it never opened.
- **The tokens are copied into all three pages.** The comment at the top of the stylesheet says this is
  because one page was loaded from disk by Electron and there was no build step. Electron is gone and
  the Rust panel now serves all three pages, so the reason no longer holds.
- **Two threads cannot work on the panel at once.** Everything is in one file, so page work has to
  queue. After the split, pages live in separate files and can be done in parallel.

## 3. What I saw in the running app

Looked at today on a test setup with three servers and a database. Ids are for this plan.

| Id | Where | What |
|---|---|---|
| U1 | Whole app | The app and the website look like two products. The site is charcoal and lime in Bricolage Grotesque and JetBrains Mono; the app opens blue in Segoe UI, and falls back to a different font on macOS and Linux. The lime theme exists but is opt-in. |
| U2 | Overview | The same warning appears three times: a full-width amber banner per server, the footer of that server's card, and the dot in the sidebar. With five servers never backed up there are five banners above the first server. |
| U3 | Overview | A stopped server's card spends a whole row saying "Server is stopped, start it to see live stats". The status pill sits beside one name and under the next. There are two "New server" buttons on screen. |
| U4 | Sidebar | Opening a server unfolds ten tools under it and pushes every other server and the databases down, so the list is in a different place on every click. |
| U5 | Server page | A tool is two things at once: a page in the sidebar, and a panel with an X that closes back to the console, with a one-line console strip under it. |
| U6 | Server header | Stopped, it replaces the stats with a sentence and leaves a gap. No Minecraft version is shown. Every server has the same icon, so nothing tells two servers apart but the name. |
| U7 | Sidebar | Play, one of the two main places in the app, is a small outlined button at the bottom, under "New server". |
| U8 | Backups, Preferences, Settings | Pages read like documents. Backups has four paragraphs of explanation and three settings that are text links in the middle of sentences ("Change", "Add a second copy", "Remove after 30 days"). Preferences is one long scroll with six folder paths that wrap. Every Settings row has a description and a "More" link. |
| U9 | Tool pages | Lists stretch the full width. In Files at 1440 a file's name and its date are over 1,000 pixels apart. |
| U10 | Console | A stopped server is a black page with one line of text. |
| U11 | Whole app | Dark only. Not a problem in itself, but it has never been a decision. |

Not judged here because it needs your eyes or real hardware: whether the current look feels right to
you at all, real monitors, the real window on Windows and macOS, and a screen reader.

Rules already settled that this plan keeps: the sidebar shell, "big screens show more, never bigger",
the density tiers, the one-screen Play page, the standalone launcher window getting no design time, and
the wording rules from the scan (one word for a backup, no developer terms, no raw errors).

## 4. Tailwind

### What it would and would not do

Tailwind does not change anything a person sees. It changes how styles are written: small ready-made
classes on each element, with unused ones left out of the final file.

For this project the real gains are:

- A page's styles sit with that page's markup, so restyling Backups cannot break Files. Today 375
  global class names share one stylesheet.
- It is the styling vocabulary every model writes best, which matters when threads do the building.
- The spacing, type and colour steps are enforced by the tool instead of by discipline.

The real costs are:

- **A build step.** The panel has never had one, and 2.0 has just removed Node. Tailwind 4 ships as a
  single standalone program, so this can be done without Node or npm, but it is still a new thing to
  pin, verify and run.
- **A rewrite of styling that works.** 1,038 rules and almost every line that sets a class would be
  touched. Done on its own, that is weeks of risk for no visible change.
- **Long class lists inside JavaScript.** The page is built in code, not in templates, so without a
  component layer the classes would be scattered through 13,500 lines.

### Options

| | Option | Verdict |
|---|---|---|
| T0 | Keep hand-written CSS, split it into files, keep the tokens | Safe and needs no build step. Loses the "styles sit with the page" gain. This is the fallback. |
| **T1** | **Tailwind 4, brought in page by page during the redesign** | **Recommended**, on the conditions below. |
| T2 | Convert everything to Tailwind first, then redesign | No. All of the cost up front, and each page would be rewritten twice. |
| T3 | Tailwind with React and shadcn | Already ruled out by you. Agreed: the panel has no framework and does not need one. |

### Conditions for T1

1. **No Node.** Tailwind's standalone program only, pinned to one version with its checksum recorded
   next to the other supply-chain pins. It runs on a developer's machine and in one CI job. It is never
   in a package.
2. **The built stylesheet is committed.** The Rust build keeps compiling the pages in exactly as now and
   stays offline. One CI job rebuilds the stylesheet and fails if the committed copy is stale.
3. **The existing tokens are the theme.** Tailwind's theme points at today's colour, spacing, type and
   radius variables. The two themes stay as variable swaps and the density tiers stay as container
   queries, which Tailwind 4 supports directly.
4. **Components first.** Buttons, fields, cards, rows, menus and dialogs become about thirty shared
   building blocks (phase 3). Tailwind classes live inside those, not across every page.
5. **No half-and-half for ever.** A page moves to Tailwind when it is redesigned and its old rules are
   deleted in the same pull request. CI counts the rules left in the old stylesheet and the number may
   only go down. At the end of the overhaul the old stylesheet is empty.
6. **A spike decides it.** Before anything is built on it, a short test proves the output renders in
   all three windows the app really uses: WebView2 on Windows, the system web view on the oldest macOS
   2.0 supports, and WebKitGTK on Ubuntu 22.04 and Rocky 9. Tailwind 4 needs a fairly recent engine. If
   the oldest target fails, fall back to T0; the rest of this plan does not change.

One thing not checked today: which Tailwind release is current. The spike pins it.

## 5. Design direction

To be shown as mock-ups in phase 0, not decided in prose. What I would propose:

- **One identity.** The SpawnLoft charcoal-and-lime look becomes what a new install opens in, so the
  app matches the website. Classic stays as a choice and nobody's saved choice is changed.
- **The same type on every system.** Bundle the website's typefaces (both are free to ship) so Windows,
  macOS and Linux look alike: the display face for headings and big numbers, the mono face for the
  console, paths and addresses. Whether body text also moves off the system font is best judged from
  the mock-ups.
- **Servers you can tell apart.** Each server shows its own icon (the server's own `server-icon.png`
  when it has one, otherwise a coloured initial as the Play page already does), its software and its
  Minecraft version, everywhere it appears.
- **Calm until something is wrong.** One accent colour. Amber and red only for a real problem, said
  once, in one place.
- **Controls, not paragraphs.** One line of help beside a control. Longer explanation behind a small
  "?" or a fold. Settings that are settings look like settings.
- **Width with a purpose.** Lists and forms get a comfortable maximum width; the extra room on a large
  screen goes to a second column (details, the console, activity), as Overview already does.

Layout proposals that go into the mock-ups as choices:

- **L1 Server tools.** Move the ten tools out of the sidebar into a row of tabs under the server's
  header, so the sidebar is a steady list of servers and databases, and a tool is simply a page. The
  alternative is to keep them in the sidebar but stop them pushing the list around.
- **L2 Overview.** One "needs attention" line per kind of problem ("2 servers have never been backed
  up", with one button for both), compact cards for stopped servers, one "New server" button.
- **L3 Play.** A first-class place at the top of the sidebar beside Overview.
- **L4 Server header.** Identity, address and the one main action always; live numbers only while it
  runs.
- **L5 Preferences.** Sections with a list down the side, the way server Settings already works, and
  each folder as a row with "Open" and "Change".

Left out on purpose: a light theme (question 5), a command palette, drag-to-reorder servers, anything
that needs a new network call.

## 6. Phases

Each phase is one implementation thread and one pull request into `v2` unless it says otherwise.
Sizes: **S** a few hours, **M** about a day of thread time, **L** several days. Model per the project
routing rules.

| # | Phase | What it delivers | Size | Model | Needs |
|---|---|---|---|---|---|
| 0 | Direction and mock-ups | Two directions for three screens (Overview, a server page, Play) as clickable mock-ups, with the type, colour and layout choices of section 5 visible in them. You pick. Nothing in the repo. | M | Fable | Your answers to section 8 |
| 1 | Split the pages into files | `ui.html`, `launcher.html` and `setup.html` become a folder of stylesheets and script modules that the Rust panel serves, with one shared token file. No bundler. Tests import functions directly instead of lifting them out of HTML. **No visual change**: proof is the 21-picture set matching before and after. | L | Opus, Fable review (it adds panel routes and changes the content security policy) | A quiet window, see section 7 |
| 2 | Tailwind spike and wiring | The spike of condition 6, on a branch, can run alongside phase 0. If it passes: the pinned program, the build script, the committed stylesheet, the CI check, the theme mapped onto today's tokens. | M | Fable | Phase 1 for the wiring |
| 3 | Components and the new look | About thirty shared building blocks: button, field, select, switch, pill, card, list row, table, tabs, menu, dialog, sheet, toast, banner, empty state, progress. A components page in debug builds that shows every one in every state, in both themes. The chosen identity (fonts, colours, icons) goes in here, so the whole app changes look in this one pull request, before any page is laid out again. | L | Opus build, Sonnet polish | 0, 1, 2 |
| 4 | Shell and navigation | Header, sidebar, the server header and the tools model chosen from L1, L3 and L4. | L | Opus | 3 |
| 5 | Overview | L2, server identity on the cards, the activity column. | M | Sonnet | 4 |
| 6 | Console | The page people spend the most time on: toolbar, filters, the stopped and starting states (U10), the pop-out window. | M | Opus | 4 |
| 7 | Plugins and Mods, Files and the editor | | L | Opus | 4 |
| 8 | Worlds, Backups, Schedule | Includes turning Backups from paragraphs into controls (U8). | L | Opus | 4 |
| 9 | Players, Stats, Activity | | M | Sonnet | 4 |
| 10 | Server Settings and the database pages | | M | Opus | 4 |
| 11 | Add a server, first run, sign-in pages | All four Add tabs, `setup.html`, and the small pages the Rust core writes itself (sign-in, session ended, could not start). | M | Opus, Fable review (sign-in) | 3 |
| 12 | Play page | The layout was redone on 2026-11-14, so this is moving it onto the shared tokens and components. | M | Sonnet | 3 |
| 13 | Preferences, feedback, update and handover banners | L5, and a sweep of every dialog not owned by a page. | M | Sonnet | 4 |
| 14 | Finish | The old stylesheet deleted. Inline scripts no longer allowed by the page's security policy if phase 1 got that far. Keyboard and contrast pass in both themes. Website and docs screenshots retaken. A list for your hardware check on Windows and macOS. | M | Fable review | 5 to 13 |

Phases 5 to 13 touch separate files after phase 1, so two or three can run at the same time once
phase 4 is in. Phases 0 to 4 are a chain.

### What every page phase does

1. Reads this plan, the chosen mock-ups, and that page's findings in `docs/ux-scan-2026-11/` (each
   finding has an id; the thread lists which it closes and which it leaves).
2. Rebuilds the page on the shared components and deletes the page's old CSS rules.
3. Keeps element ids and `data-` hooks that tests use. Class names are free to change; ids are not.
4. Runs the tests, then takes pictures at 900, 1440 and 2560 wide in both themes into
   `/mnt/project-files/ux-ui-plan-2026-11-23/phaseN/`, before and after.
5. Gets a separate review (Opus; Fable where it touches the shell, sign-in or panel routes).
6. Opens a pull request from `v2-ui-<topic>` into `v2`, following the no-attribution rules.

## 7. Risks

- **The pre-beta fixes thread is editing the same file.** Phase 1 moves every line of `ui.html`. It has
  to land in a window where that thread has merged and paused, or one of the two redoes its work. The
  coordinator should schedule it.
- **Hardware testing done before the redesign will not cover the new UI.** Checks of the engine
  (start, stop, backups, updates, installers) are unaffected and can go ahead now. Anything about what
  the window looks like should wait for phase 14.
- **Smoke tests read the page.** 81 selectors across two smoke scripts. The "ids are stable" rule
  covers most; each phase updates the rest in the same pull request.
- **The pages the Rust core writes itself** (sign-in and friends) allow only inline styles by policy,
  so they cannot load the shared stylesheet. They keep a small copy of the tokens, with a test that it
  matches.
- **Bundled fonts add to the download.** Roughly 0.2 to 0.4 MB on an 11.3 MB core. Small, but real.
- **Windows checks files out with CRLF line endings**, which broke page tests before. The split makes
  more files; the tests must not depend on line endings.

## 8. Questions for you

Each has a recommendation. If you say "go with the recommendations", phase 0 can start.

1. **What bothers you most today?** The look, the amount of text, getting around, or all of it. One
   sentence is enough and it steers the mock-ups. If you would rather react to pictures, say so and
   phase 0 covers all three.
2. **Tailwind.** Recommended: yes, on the six conditions in section 4, with plain split-up CSS as the
   fallback if the spike fails.
3. **The default look.** Recommended: new installs open in the SpawnLoft lime look, Classic stays as an
   option, existing choices are left alone.
4. **Fonts.** Recommended: bundle the website's two typefaces so every system looks the same. Final
   call from the mock-ups.
5. **Light theme.** Recommended: not in this overhaul. The tokens make it possible later.
6. **Timing.** Recommended: the overhaul goes into 2.0 before the first public beta, since the beta is
   the first time most people will see the app. Engine checks on hardware can run alongside it.

## 9. Direction picked

2026-11-23: Victor looked at the mock-ups ([canvas](https://claude.ai/artifact/BirJnTrzsNF6xjDqUd3T1i))
and said the direction "looks pretty good". That settles phase 0 for the three screens shown: the lime
look, Bricolage Grotesque for headings with Inter for body text and JetBrains Mono for the console,
server tools as tabs under the header (L1), the grouped Overview (L2), Play at the top of the sidebar
(L3), and Backups as controls. Screens not yet drawn follow the same pattern.

## 10. Done ahead of the build (2026-11-23)

Work that touches nothing the pre-beta fixes edit, done while the build is on hold:

- **Tailwind test: passed.** Findings in [TAILWIND-SPIKE.md](TAILWIND-SPIKE.md), code on the scratch
  branch `v2-tailwind-spike` (not for merging). Tailwind 4.3.5 works on the panel's tokens, both
  themes and the density tiers, in Chromium and WebKitGTK, and asks for nothing the panel does not
  already need. Still to do in phase 2: pin the standalone program, and load the test page in the real
  Windows and macOS windows.
- **Side finding, not about Tailwind:** the Mac package says macOS 11 is enough, but the panel's
  density tiers already need the web view of macOS 13. Settled the same day: PR #271 raises the
  minimum to macOS 13.0.
- **Three more mock-ups** on the canvas: Play, server Settings, Add a server.

## 11. Decided, 2026-11-23

Victor chose "Yes, start building" on the plan's recommendations. That settles section 8:

| Question | Answer |
|---|---|
| Tailwind | Yes, on the six conditions of section 4. The test of condition 6 has passed in two of the engines (section 10). |
| Default look | New installs open in the SpawnLoft lime look. Classic stays. Saved choices are left alone. |
| Fonts | Bundle Bricolage Grotesque, Inter and JetBrains Mono, as in the mock-ups. |
| Light theme | Not in this overhaul. |
| Timing | Into 2.0, before the first public beta. |

The hold for the pre-beta fixes ended the same day (#271 and #272 merged), so phase 1 can start.
Its brief is [PHASE-1-BRIEF.md](PHASE-1-BRIEF.md).

Two refinements to the phase table, from writing that brief:

- **Phase 1 keeps ordinary scripts loaded in order, not modules.** The panel's functions share one
  scope; ordinary script files keep that exactly, so the split stays a pure move that can be checked
  byte for byte. Tests keep lifting functions by name, from the new files. Modules can follow later,
  page by page.
- **Phase 2 changes one line of the pull request template.** It says "no build step introduced".
  Tailwind's stylesheet build is a build step for developers and CI (never in a package), so the
  line should say what is still true: no runtime dependencies, and nothing a package has to build.

## 12. Phase 2 as built (2026-11-23)

Tailwind 4.3.5 is wired in, with no visible change. What later phases need to know:

- **Build.** `node tools/panel-css.mjs` turns `src/panel/tailwind/panel.css` into
  `src/panel/css/tailwind.css`, which is committed and served like any other panel file. The
  standalone program is pinned by version and sha256 in `tools/tailwind-pin.json` and checked
  before every run. The `panel-css` CI job rebuilds on Linux, Windows and macOS and fails on a
  stale file.
- **Theme.** Every class resolves to a panel token: colours (`bg-surface`, `text-ink-2`,
  `border-line`, `text-accent`, `bg-primary`, `text-warn-ink`, ...), the seven sizes (`text-1` to
  `text-7`), the type roles (`type-page`, `type-section`, `type-card`, `type-body`, `type-meta`,
  `type-label`, `type-mono`), radii (`rounded-xs` to `rounded-lg`), shadows (`shadow-sm`,
  `shadow-md`, `shadow-lg`, `shadow-lift`), and the four-pixel spacing grid (`p-4` is 16px).
  Tailwind's own palette, sizes and window breakpoints are off. The density tiers are container
  variants: mark the pane `@container/pane`, then `@wide/pane:` (1280) and `@ultra/pane:` (2000).
- **Layers.** Every hand-written stylesheet is now inside `@layer legacy`, below Tailwind's
  layers. A Tailwind class always wins over an old rule on the same element; an element with no
  Tailwind class is drawn as before. An old `!important` still wins (that is how layers work),
  so `[hidden]` keeps hiding.
- **Sources.** Tailwind reads class names only from files listed with `@source` in `panel.css`,
  because it takes any word in a file as a possible class. A phase adds its files to that list.
  None is listed yet, so the built file is empty apart from the layer order.
- **Guards** (`test/panel-css.test.mjs`): the page link order, the `legacy` wrapper on every old
  sheet, no class defined on both sides (today `grid`, `grow`, `inline` and `sr-only` are old
  class names, so the phase that first needs one of those removes or renames the old rule), and
  the count of old rules, 1,338 across the three pages, which may only go down.
- **Preflight is off.** Tailwind's reset would change pages that have not been redesigned.
  Phase 3 decides when it comes in; until then `border` works without it, and headings and
  lists keep browser margins unless a class says otherwise.
- **Engines** (condition 6). A self-checking probe page built from the same input passes in
  Chromium, WebKitGTK, Edge on Windows and Safari on macOS, in CI on every pull request. Edge and
  Safari are the engines behind WebView2 and WKWebView, not the SpawnLoft window itself; the
  Linux window itself is checked for the layer order and that the old sheets still draw. Windows and macOS windows on real hardware stay on the
  phase 14 list.
