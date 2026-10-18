# Panel UI audit

The baseline for the UI polish pass on `feature/ui-polish`, taken from `dev` at 7608e8d (after the
Overview redesign, #131). Every view except Overview was walked in both themes (Classic and
SpawnLoft) at 1440×900, with spot checks at 1000×760, against a scratch data root holding four
servers (two running), two databases, plugins, mods, backups and forty activity entries. Error and
loading states were forced by failing or holding the panel's API calls in the browser. The wizard
was opened from disk with a stubbed `window.mcctlDesktop`.

Overview is out of scope except where it should adopt a shared component.

Severity: **high** is broken, misleading, or fails accessibility; **medium** is inconsistent or
makes a task harder than it needs to be; **low** is polish. The step column is where the fix lands in
the eleven-step plan.

## What is already in good shape

Worth keeping, so the later steps do not undo it:

- Type is tokenised: `--t-1`…`--t-7` cover all but two `font-size` declarations.
- `--ink-3` meets AA on every plane in both themes (5.2:1 or better).
- A global `:focus-visible` ring exists, and every control in the frame is reachable by Tab.
- The sidebar already has Servers and Databases headings, distinct server and database icons,
  status dots, an active state and a compact rail under 1200px.
- The console already tints WARN and ERROR lines with a coloured spine, counts them, filters by
  level, has a Jump-to-newest button and an up-arrow history.
- Activity already has actor filters and pages by `before`.
- The shell and density tiers (#122–#130) hold up at 1000px: TPS drops out, the strip reflows,
  nothing overflows the window.

## Design system (cross-cutting)

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Spacing is half on the grid. 62 `padding` declarations use raw pixels (61 use `--s-*`), and `gap` uses 2, 3, 5, 6, 7, 9 and 10px — 6px alone 21 times. | Keep `--s-1`…`--s-7`, add `--s-0` (2px) and `--s-1h` (6px) only if they earn their place, and move components onto the scale as they are touched in Step 3. | medium | 2–3 |
| The type scale is sizes, not roles. Page, section and card titles each pick their own size, weight and tracking (`h1` in the strip is `--t-6`/650, sheet `h1` differs, tool `h2` is `--t-5`, section labels are 650 uppercase `--t-1` with three different letter-spacings). | Add role tokens on top of the sizes: `--type-page`, `--type-section`, `--type-card`, `--type-body`, `--type-meta`, `--type-mono` (size/line-height/weight), and a single `.eyebrow` for uppercase labels. | medium | 2 |
| `--ink-4` is 2.3–2.9:1 (Classic) and 2.4–3.4:1 (SpawnLoft). It is used for console timestamps, line numbers, breadcrumb separators, the meta-row dot and **code comments in the file editor**, which are real text. | Lift `--ink-4` to about 3:1 for the separators that stay decorative, and move comments and line numbers to `--ink-3`. | high | 2 |
| `--lapis` as text on `--raised-hi` is 4.39:1 in Classic, under AA for small text (links and active labels on hovered rows). | Darken nothing; add `--lapis-text` (a lighter lapis, ≈#7d9cff) for text use and keep `--lapis` for fills and rings. | medium | 2 |
| The focus ring animates in over 200ms because `button` has `transition: all`, so a fast Tab shows no ring for the first frames. Inputs replace the ring with a 3px wash that is faint on `--raised`. | Exclude `outline` from transitions (`transition-property` lists instead of `all`) and use one ring for every control, inputs included. | medium | 2 |
| Hit targets under 32px: sidebar tool rows 30px, the Java chip 26px, the address copy chips 19–26px, console level segments 27px, backup row icon buttons 28×25, Restore/Delete 28px, ghost links (Change, Add a mirror, Check for updates) 25–27px, setting toggles 20px, the "More" disclosure in Settings 17px, the wizard checkbox 13px, the "Leave out of backups" summary 11px tall. | `--hit: 32px` as `min-height` on buttons, segments, tabs and summaries; icon buttons 32×32; enlarge the clickable area of checkboxes and switches with their label. | high | 3 |
| Primary buttons glow (coloured shadow) everywhere, so every primary competes; on the lime theme the glow is loud. Card-level Start buttons on Overview and in the strip carry the same glow. | One flat primary; keep the glow, if at all, for the single page-level action. | low | 3 |
| Disabled buttons are opacity .5 with no reason shown (Restore while running, Export of the active world, Start on an external database). | Disabled controls keep a tooltip or an inline hint saying why. | medium | 3 |
| There is no loading state. A tool pane keeps the previous server's content (or error) until the new request returns, so switching servers can show another server's plugins. | Clear the pane and show a skeleton for the new server immediately; stale content never outlives a switch. | high | 3 |
| Errors are one red line at the top of an empty pane, with no retry. | Shared error state: icon, the message, a Retry button. | high | 3, 11 |
| Empty states vary: some have an icon and a line (Players, Schedule, Backups history), none have a primary action, the console's says "Start the server" on a database. | Shared empty state: icon, one line, one primary action. | medium | 3 |
| Section labels (`INSTALLED (6)`, `HISTORY (6)`, `TASKS (0)`, `WORLDS (1)`) repeat a count the list already shows, and `(0)` sits above an empty state that says the same. | Drop the count when zero; consider dropping it entirely. | low | 3 |
| Two inline style systems for tabs: the sheet uses underline tabs, tools use segmented controls, Stats uses a segmented control for a time range. Fine in principle, but their heights (27, 30, 36px) and paddings differ. | One `.seg` and one `.tabs` component with fixed heights. | medium | 3 |

## Sidebar

| Problem | Fix | Sev | Step |
|---|---|---|---|
| While the Add or Preferences sheet is open, the server last opened stays highlighted, so the sidebar says you are somewhere you are not. | Clear the active state when a sheet is open, or mark New server active for Add. | medium | 4 |
| Status is a 6px dot on the corner of the icon. The row's tooltip and `aria-label` do name the state, but sighted users only get it on hover, and stopped and unreachable are both grey. | Keep the label; make the dot larger and give unreachable/crashed the fault colour, with a shape difference (ring vs fill) so state is not colour alone. | medium | 4 |
| Arrow keys do nothing; every server and every tool is a separate Tab stop (eleven tools under an open server). | Roving tabindex: one stop for the list, arrows move, Enter opens, Right/Left expand and collapse a server's tools. | medium | 4 |
| Every database uses the same icon regardless of engine. | Engine glyph (MySQL, Redis/Garnet) in the row. | low | 4, 9 |
| The dashed "New server" button at the bottom duplicates the Overview header's New server button and looks like a drop zone rather than a button. | Keep one: a solid secondary button styled like the rest, or remove it and rely on the header. | medium | 4 |
| In the compact rail (<1200px) servers are unlabelled icons; only a hover tooltip names them. | Keep the tooltip, add the name to `aria-label`, and show the open server's initial or name in the rail. | low | 4 |

## Server header (all server pages)

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The memory meter runs into the next vital: at 1440px the bar strikes through "24h ago" / "Never" under Last backup. The meter is a fixed 64px in a cell that is not wide enough for "46 MB / 4 GB" plus the bar. | Put the meter under the figure (full cell width) rather than beside it. | high | 5 |
| A stopped server shows four dashes. Nothing says why the numbers are missing. | Stopped state: one line, "Stopped · start it to see players, TPS and memory", in place of the vitals. | medium | 5 |
| The address is plain mono text in the strip but a copy chip on Overview cards. | Same copy chip in the header, with a "Copied" confirmation. | medium | 5 |
| Running servers show Restart, Stop (danger) and ⋯; stopped show Start and ⋯. Stop in red on every running server reads as a warning when nothing is wrong, and there is no pending state while a start or stop is in flight beyond button text. | Stop as a secondary button (danger only in the confirm), a spinner/pending state on the pressed button, other buttons disabled while pending. | medium | 5 |
| The ⋯ menu lists Rename, Reset world and Delete disabled with "Stop the server first", so half the menu is unusable while running. | Keep them, but group destructive items under a separator with the danger colour, and offer "Stop and rename…" as the action instead of a dead item. | low | 5 |
| The status pill colour is the only difference between Running and Stopped at a glance in the sidebar. | Covered by the sidebar dot fix above. | — | 4 |

## Console

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Long lines run off the right edge with wrap off by default; the first line of a JVM start is cut mid-flag. | Keep no-wrap as the default but add a fade and a horizontal scrollbar that is visible, or default to wrap. | low | 6 |
| Timestamp and level are `--ink-4` (2.4–2.9:1). | Lift to the new `--ink-4` or `--ink-3`. | medium | 2, 6 |
| The toolbar is eight controls in one row (filter, level segment, count, pause, wrap, pop out, copy, Share log); five are 16px icons with no labels. | Keep filter and level on the left, group the icon buttons in a quiet cluster, labels in tooltips (already) and `aria-label`s (already). | low | 6 |
| "Jump to newest" exists but is easy to miss (small, bottom-right). | Floating pill centred above the input with the count of new lines. | low | 6 |
| On a stopped server the input reads "Start the server to send commands" in the same style as a live input; on a database it explains that databases take no commands. | Disabled input styling plus an inline Start button for servers; hide the command row entirely on databases. | medium | 6, 9 |

## Plugins / Mods

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Hand-added plugins have no actions at all, not even Disable or Remove; managed ones put Disable and a trash icon in a hidden-until-hover cluster. | Every row: version, enabled state and Enable/Disable visible; Remove behind a confirm that names the jar. | high | 7 |
| Version is not shown for hand-added jars and the name falls back to the file name, so `EssentialsX-2.20.1` reads as a name. | Show the version column for every row; when unread, show the file name in mono under the name. | medium | 7 |
| The search box and Check for updates are both full-weight; the row list starts after an unexplained 40px gap. | Tighten the header, one primary (Search), updates as a ghost button in the list header. | low | 7 |
| Long names are not truncated (they push the row). | Truncate with a tooltip. | medium | 7 |

## Files

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Five equal-weight buttons in the toolbar (New file, New folder, Upload files, Upload a folder, Open in your file manager on its own line). | One primary (Upload), New file/folder in a menu, Open in file manager as a ghost link by the breadcrumb. | medium | 7 |
| Two paragraphs of explanation above the list on every visit. | One line; move the "running server holds files open" note into the "In use" chip's tooltip. | low | 7 |
| Sizes are right-aligned (good) but folders show nothing; dates use a proportional font so they do not line up. | Folders show "—", dates in tabular numerals. | low | 7 |
| File names are proportional; paths elsewhere are mono. | Mono for names and paths, consistently. | low | 7 |

## Worlds

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The name field's placeholder is cut ("letters, numbers, dash, und"). | Shorter placeholder, rule in the hint. | low | 7 |
| Export on the active world is disabled at 30% opacity with no reason. | Tooltip "Stop the server to export the active world". | medium | 3, 7 |

## Backups

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The automatic-backup switch is off but labelled "On", which reads as the current state. | Label states the state: "Off" / "On · daily at 03:00, keeping 7". | high | 7 |
| Schedule status is the second card; nothing at the top says whether backups are running, when the next one is, or that this server has never been backed up (Overview flags lobby, its own Backups tool does not). | Status bar at the top: on/off, next run, keep count, last backup age, and a warning when there is no backup in the last 7 days, with one primary action. | high | 7 |
| Every snapshot row has five actions (lock, note, download, Restore, Delete); Restore is disabled while running with no reason. | Restore and ⋯ per row (lock, note, download, delete inside); Restore while running offers "Stop and restore". Restore confirm names the snapshot and what will be replaced. | medium | 7 |
| The Contents column shows a `?` chip for every row. | Hide the column when the manifest is unknown, or say "Unknown" in text. | low | 7 |
| "Leave out of backups" is a collapsed card on its own in the right column, 11px tall as a click target. | Fold it into the Back up now card as a disclosure with a 32px target. | low | 7 |
| The storage path and mirror line are long mono strings with ghost links that are 25px tall. | One "Stored in …" line with a Change button, mirror status as a pill. | low | 7 |
| The backup kind select shows a lowercase internal name ("standard"). | Title case labels ("Standard: plugins, worlds and config"). | low | 7 |

## Activity

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Rows use a different look from the Overview feed (chips for the actor, no icons, no runs grouping). | Reuse the Overview feed's row, icons and run grouping. | medium | 8 |
| Filters are You / AI assistants / Schedules / SpawnLoft; the brief wants all / you / schedule / assistant. | Rename to match and keep SpawnLoft under All. | low | 8 |
| Paging exists but there is no visible "Load more" at the end of the list. | Load more button, with the count shown. | medium | 8 |
| An entry with no detail reads "Installed" with no object. | Fall back to the plugin or file name from the entry, or "Installed a plugin". | low | 8 |

## Players

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The empty state has no action, though whitelisting or opping someone by name is the common next step. | Empty state with "Add a player" primary. | low | 3, 8 |
| The search field is 880px wide for a list of names. | Cap at the card width. | low | 8 |

## Stats

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Players and TPS are not here; only processor and memory. | Add live bars for players (of max) and TPS (of 20) next to memory, with a stopped state. | medium | 5 |
| The footer facts (`Uptime 45s Started … Samples 4 every 10s`) are mono bold on proportional labels. | Use the vitals style. | low | 5 |

## Schedule

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The second paragraph opens with the platform's scheduler name ("systemd.") and explains lingering in the first screenful. | Lead with what happens; put scheduler details behind "How this runs". | low | 8 |
| New task sits above an empty state that has no action of its own. | Move New task into the empty state; keep it in the header once tasks exist. | low | 3 |

## Settings (per server)

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The sticky save bar is always shown, even with nothing to save ("No unsaved changes" beside three disabled buttons), so it is chrome most of the time. | Show it only when there are changes, and slide it in. | medium | 8 |
| No inline validation: Max players has `max=1000`, but 5000 is accepted, marked Changed and offered for Save with no message. | Validate on input, `aria-invalid`, message under the field. | medium | 8 |
| Help text is clipped behind "More" links that are 17px tall. | Show one line of help, "More" as a 32px disclosure. | low | 8 |

## Databases

| Problem | Fix | Sev | Step |
|---|---|---|---|
| A database opens on an empty console that says "Start the server and it appears here", with a dead command input. An external database cannot be started, yet Start is shown disabled. | Open databases on an Overview tab: engine, address, status, attached servers, connection details; no console for external ones; no Start for external ones. | high | 9 |
| No copyable connection details on the database itself (they live in the attached server's Settings). | Host, port, user, database and password rows with copy buttons and a show/hide toggle for secrets. | high | 9 |
| "Attached: survival, lobby" is plain text. | Links to those servers. | low | 9 |
| The Unreachable banner fills the width in fault red with a small × and repeats the pill. | Inline notice in the overview with Retry and "Edit address". | medium | 9 |

## New server / Add sheet

| Problem | Fix | Sev | Step |
|---|---|---|---|
| The sheet is titled "Add a server" on the database tab too. | Title follows the tab ("Add a database"), or "Add" with the tabs as the choice. | medium | 9 |
| When the version list cannot load, the error is the select's text and is cut off ("Could not reach the Paper dov"). | Error under the field with Retry; the select shows "Unavailable". | high | 9 |
| The name hint ends in "use –" until something is typed, which reads as broken. | Show the example slug from the placeholder until there is input. | medium | 9 |
| No summary before Create; the create button is far from what it creates, and its disabled state says nothing. | A short summary line beside the button ("Paper 1.21.4, 4 GB, port 25565, account required"). | medium | 9 |
| Field labels are uppercase eyebrow labels here and sentence-case labels in server Settings. | One label style. | low | 3 |
| The adopt tab lays its button and note out inline; the create tab stacks them. Browse is hidden in the browser with no hint. | One action row layout; when Browse is unavailable, say "Paste the folder path". | low | 9 |
| No step structure: software, version, memory, port and join mode are one form. | Two short groups (What to run / Who can join) with the summary at the end; not a multi-page wizard. | low | 9 |

## Preferences

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Long absolute paths wrap mid-word in a narrow column. | Truncate from the middle with the full path in a tooltip and a copy button. | low | 8 |
| "To move these, run: mcctl config set-root <path>" tells a desktop user to use a terminal. | Keep for the CLI build; in the desktop app, point at the data-folder move flow. | low | 8 |

## Empty, loading and error states

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Loading: panes keep the previous server's content until the request returns (see Design system). | Skeleton rows per pane. | high | 3 |
| Error: a single red line, no retry, no icon, at the top of an empty pane (Files, Plugins, Backups, Activity all identical). | Shared error state with Retry. | high | 3, 11 |
| First-run (no servers): good. The two doors have no icon and the sidebar shows only Overview with an active state. | Icons on the doors; the empty state is otherwise the model for the others. | low | 3 |
| The Java chip in the header is 26px tall and says only "Java 25" with a warning icon, so it is unclear what is wrong. | "Java 25 needs updating" in the tooltip and accessible name (already), visible text "Update Java". | low | 4 |

## First-run wizard (desktop/setup.html)

| Problem | Fix | Sev | Step |
|---|---|---|---|
| Its buttons, inputs and checkbox are styled separately from the panel's (Browse… is taller, the checkbox is a native 13px box, the "First run" tag is mono). | Use the shared button, input and checkbox styles once Step 3 defines them; mirror the tokens. | medium | 10 |
| No step indicator, though it is the first of two screens a new user meets (folder, then Java). | A two-dot step indicator in the header. | low | 10 |
| The Continue button glows. | Flat primary, matching the panel. | low | 10 |
| Error box and Java check use their own paddings (10/14px). | Spacing tokens. | low | 10 |

## Responsive (1000 / 1280 / 1440 / 1920)

At 1000px the shell folds to the rail and the strip reflows cleanly; the Backups automatic-backup row
wraps its "keeping 7 of them" onto a second line, which is fine. The only overflow seen at any width
was the memory meter at 1440px (Server header, above). Full sweep at all four widths is Step 11.
