# Page by page, part 1: page shell, sidebar, empty state, Overview, server header, Console, Add a server, Preferences and Feedback

Part of the [UX scan](../ux-scan-2026-11.md). Each page has an **Inventory** (every control, menu, dialog, message and state, with its wording and where it is in the code), **Findings**, and **Keep** (what already works and should not be lost).

Findings read: **id. title** | kind | severity | size (S is small, a few hours at most; M is about a day; L is several days or needs a design decision first). Everything in this part was confirmed by reading the code at `552082d`; line numbers are `src/ui.html` unless another file is named. Findings that were also seen in the running panel are listed in [part 5](05-seen-in-the-running-panel.md). "extends A2" and similar point at the [first pass](first-pass.md). "unverified" marks a consequence that could not be observed.

---

## 1. Page shell

### Inventory

- **Header** (`:2725-2743`, CSS `:389-418`)
  - Brand mark + "SpawnLoft"; plain `<span>`, not clickable. Wordmark hidden under 840px (`:2617`).
  - Java chip `#javaChip` (`:2736`, logic `:13906-13929`): text "Java" or "Java 25"; tone warn (Java found but too old) or fault (none found).
    - aria-label: "1 server needs Java N. Get Java." / "N servers need Java N. Get Java." / "Java needs updating. Get Java." / "Java is not installed. Get Java."
    - title: `java.message + ' Servers will not start until it is sorted.'`
    - Click opens `health.javaDownload` in the browser.
  - `#bUpdate` "Check for updates" (`:2739`, logic `:13952-14065`), only shown when `desktop.appInfo` exists.
    - States: "Check for updates" (ghost), "Checking…", "Up to date" (disabled, 4s), "Downloading X…", "Downloading N%", "Restart to update", "Restart to update to SpawnLoft N" (primary), "Download Mac preview".
    - Titles: "SpawnLoft X is ready — restart to switch to it"; "Rolling development builds are installed manually; this opens the preview release."
    - Toasts: "Update failed: …", "Could not check for updates."
    - Dialog "Restart to update?": "SpawnLoft closes, swaps itself for the new version and reopens. No installer window appears. Running servers keep running — SpawnLoft supervises them as separate processes." Button "Restart and update".
    - Dialog "Update to a new major version?": "This is a new major version of SpawnLoft. It is not installed when you close the app, only from here. On Windows, stop every server first. SpawnLoft closes, swaps itself for the new version and reopens." Button "Restart and update".
  - Preferences gear `#bSettings` (aria-label and title both "Preferences") (`:2740`).
- **Banners** (`#banner`, `:2723`, CSS `:363-375`)
  - Lost contact (`:5978-5997`), role=alert: "Lost contact with SpawnLoft." + " The panel process has stopped or is not answering, so nothing shown here is current. Your servers are separate processes and keep running." No button.
  - Handover notices (`:14288-14348`), polled every 4s (`:14364`):
    - "Updating." / "Starting A, B and C again after the update." (no dismiss)
    - "The update was not applied." / "X did not stop in time, so SpawnLoft left everything as it was and started what it had stopped again." (×)
    - "Updated to SpawnLoft X." / "SpawnLoft stopped A and B for the update and started them again." (×)
    - "Updated to SpawnLoft X." / "No servers were running, so nothing had to be stopped." (×)
    - "NAME did not start again." / "[error] It was stopped for the update." Button "Start" (primary), ×. Toast "Started NAME."
    - "NAME has no supervisor." / "Its Java process has been running without one since before the update, so SpawnLoft cannot talk to it. Stop it with "spawnloft kill NAME" in a terminal, then start it here." (×)
    - "NAME still runs on SpawnLoft 1." / "Restart it to move it to this version. Nothing happens on its own, because players may be on it." Button "Restart" (ghost, no ×). Dialog "Restart NAME?" / "It stops gracefully, then starts again under this version. Players on it are disconnected." Toasts "Restarting NAME...", "NAME restarted."
  - Start-up toast (red): "Note: <dataFormat>" (`:13940`).
- **Session ended** (`:3445-3470`): "This panel session has ended" / "Open SpawnLoft again from the app, or run `spawnloft ui` for a new sign-in link."
- **Toasts** (`:3632-3652`, CSS `:2560-2585`): fixed bottom-right; icons bolt / check / alert; × "Dismiss"; non-errors go after 5.2s, errors stay; text also copied to `#live`.
- **Shared dialog `ask`** (`:3410-3424`, `:3668-3777`, CSS `:2474-2495`): title, text, radio choices, one text box (type-to-confirm with a click-to-fill name button titled "Click to fill it in", label "Type NAME to confirm"), Cancel + "Confirm" (primary or danger). Enter works only in the text box. Three other functions drive the same `<dialog>` by hand: `editServer` (`:11918`), `showCredentials` (`:12183`), and the update dialogs through `ask`.
- **Tooltips** (`:6799-6854`, CSS `:2218-2225`): every `title` is lifted into `#tip` on hover (450ms) or keyboard focus (150ms); `aria-describedby="tip"` added; not used inside dialogs.
- **Keyboard**
  - Escape (`:14079-14094`): closes dialog, else a sheet, else an open tool when focus is inside it. Separate Escape handlers: menus (`:6516`), tooltip (`:6851`).
  - Sidebar: arrows, Home, End, Right, Left (`:4097-4116`). Menus: arrows, Home, End, Tab (`:6515-6534`). Command box: Enter, Up, Down (`:12787`).
  - Interface size keys live in the shell (`rust/crates/spawnloft-shell/src/bridge.js:64`).
  - No other shortcuts exist.

### Findings

**PG1. Update button and version are missing in the 2.x app** | missing state / gap | high | M
The header button, its "Restart to update" state and the About "Version" and "Build" rows all depend on `desktop.appInfo`, `onUpdate` and `checkUpdate`. The Tauri bridge defines none of them (its header comment says "minus Electron's own updater calls"). So in the 2.x app the header never shows an update button, About shows only "Panel: Local only — bound to 127.0.0.1", and an available update is visible only after opening Preferences and scrolling to Updates.

Evidence: `:13952`, `:13509-13519`, `:14228` (only called from `:13498`); `rust/crates/spawnloft-shell/src/bridge.js:20-60`.

Fix: drive the header button from `/api/update` (poll with the 4s refresh, show "Update available" as a primary chip), and fill About from `st.installed`. Extends E2 and D2.

**PG2. Java chip and "Java N needed" never clear after Java is installed** | missing feedback | high | S
`/health` is asked once at page load and `/java` once at start-up. The chip is re-rendered on every poll but from the same stale answer. After the owner clicks "Get Java" and installs it, the chip, the attention card and the "Needs Java N to start" line on cards stay until the page is reloaded. Nothing says a reload is needed.

Evidence: `:13931`, `:14368`, `:13906-13927`, `:5491-5498`.

Fix: re-ask `/health` and `/java` when the window regains focus and every minute while the chip shows; add "Check again" to the chip's click. Extends E6 and H3.

**PG3. "Checking…" gives up silently after 20 seconds** | missing error state | medium | S
If no answer arrives the button goes back to "Check for updates" with no message, so a pressed check looks like it did nothing.

Evidence: `:14061-14063`.

Fix: toast "Could not check for updates. Try again." on the timeout.

**PG4. Update check results are not announced and move the header** | accessibility | low | S
The result is shown only by changing the button's own text ("Up to date" on a disabled button). There is no live region, and the button's width changes from "Check for updates" to "Restart to update to SpawnLoft 3", shifting the Java chip.

Evidence: `:13990-14008`.

Fix: mirror state changes to `#live`; give the button a fixed min-width.

**PG5. "On Windows, stop every server first." is shown on every platform, as an instruction with no help** | wording / platform | medium | S
The major-update dialog tells the user to do something by hand, on all platforms, and does not check whether servers are running.

Evidence: `:14035-14036`.

Fix: show it only on win32 and only when something is running; list the running servers with a "Stop all" button. Extends C4.

**PG6. Dismissing one handover notice dismisses all of them** | flow | medium | S
Every × in the update banners calls the same `/api/handover/dismiss`. Closing "Updated to SpawnLoft X" also removes "B did not start again" (with its Start button) about four seconds later, on the next poll.

Evidence: `:14292`, used at `:14305`, `:14309`, `:14312`, `:14321`, `:14326`.

Fix: dismiss per notice, or keep failures until the server is started.

**PG7. Handover banners stack without limit and cannot be dismissed for legacy servers** | hierarchy | medium | S
One full-width banner per server "still runs on SpawnLoft 1", with no ×, above the header. Five servers is five rows pushing the whole app down.

Evidence: `:14329-14346`.

Fix: one banner ("3 servers still run on SpawnLoft 1") with "Restart all…" and a list.

**PG8. Handover banner wording and style are inconsistent with the rest** | consistency | low | S
- Titles end in a full stop ("Updating.") where other notices do not ("Orphaned").
- Server names are folder ids.
- "Started NAME." here, "NAME started." elsewhere (`:6664`).
- The legacy "Restart" is a ghost button while the failure "Start" is primary.
- "It stops gracefully".

Evidence: `:14300-14337`.

Fix: use display names, one sentence order, no trailing stop in titles. Extends C6 and A10.

**PG9. Escape pressed to dismiss a tooltip also closes the sheet or tool** | accessibility | medium | S
The tooltip's Escape handler and the global one are both on `document` and both run, so hiding a tooltip in Preferences closes Preferences.

Evidence: `:6851`, `:14079-14093`.

Fix: in the global handler, return early (and stop) when `#tip[data-on]` was showing.

**PG10. Escape closes the Add sheet from inside any field, including mid-download** | flow | medium | S
There is no check on what has focus. Escape in the modpack search (where it normally clears the field) or while a server is being created closes the sheet. The create continues unseen and later jumps the user to the new server (see AD2).

Evidence: `:14087`.

Fix: ignore Escape while a create is running or when the target is a non-empty search field; or ask.

**PG11. Tooltip text repeats the button's name for screen readers** | accessibility | low | S
Icon buttons carry the same string as `aria-label` and `title`; the tooltip code then adds `aria-describedby="tip"`, so the name is read twice ("Preferences, Preferences").

Evidence: `:2740`, `:2881`, `:2913-2916`, `:6834`.

Fix: skip `aria-describedby` when the title equals the accessible name.

**PG12. Explanations that live only in a tooltip on a non-focusable element** | accessibility | medium | M
These are plain `title`s on `div`, `li` or `span` that cannot take focus, so keyboard and touch users never get them, and the tip cannot be hovered (`pointer-events: none`):
- TPS, Memory and Players explanations (`:4362-4366`).
- The exact time of the last backup (`:4417`).
- The memory chip's meaning (`:4992`).
- The folder-name hint on the id (`:2869`).
- The "Offline mode" explanation (`:2871`).

Fix: make these small "?" buttons or put the sentence on screen.

**PG13. Three different sentences for "could not copy"** | consistency | low | S
"Could not reach the clipboard." (`:6468`), "The clipboard refused; select and copy by hand." (`:12177`), "Could not copy diagnostics: <raw error>" (`:13733`). The second blames the clipboard and tells the user to select text that is inside a button.

Fix: one sentence and, on failure, a dialog with the text selected.

**PG14. Toasts appear in the far corner on large screens** | scaling | low | M
`#toasts` is fixed at bottom-right. At 2560 to 3840 wide the confirmation of a click on the left of the page is up to three metres of pixels away, and it is the only feedback for Start, Stop, Copy and Save.

Evidence: `:2560`.

Fix: anchor toasts to the stage's bottom centre with a max width, or put inline confirmation at the control (the address button already does this, `:5080-5087`). Extends A2.

**PG15. Edit dialog does not save on Enter** | consistency | low | S
`ask`'s text box submits on Enter; the Edit dialog's four fields are plain inputs with no form and no key handler.

Evidence: `:11926-11949`, compare `:3771`.

Fix: wrap dialog bodies in a `<form method="dialog">`.

**PG16. Session-ended box takes no focus** | accessibility | low | S
It is `role="alertdialog"` with no focusable element and focus is not moved to it.

Evidence: `:3447-3469`.

Fix: add a "Reload" button and focus it. Extends H4.

**PG17. gap: no keyboard shortcuts beyond Escape** | gap | low | M
Nothing focuses the command box, switches server, or jumps to the console filter, and there is no list of the keys that do exist (sidebar arrows, ↑ history, Ctrl +/-).

Fix: add `/` for the command box, Ctrl+1..9 for servers, and a "Keyboard shortcuts" list in Preferences.

**PG18. gap: the brand mark does nothing** | gap | low | S
Clicking the logo does not go to Overview. Evidence: `:2726-2734`.

### Keep
- One shared dialog with named buttons, type-to-confirm with click-to-fill, and the stale-close guard (`:3746-3765`).
- Error toasts stay, acknowledgements leave; a glyph as well as colour says the tone (`:3645`).
- Tooltips reach keyboard focus and are one style.
- "Lost contact" only after three missed polls (`:6089`).
- Background update checks stay silent; only a pressed check answers (`:13968-13972`).

---

## 2. Sidebar

### Inventory

- `<aside class="side">` holding `nav[aria-label="Servers"]` (`:2752-2784`, CSS `:422-490`). Fixed 240px; 56px rail under 1200px (`:2596-2613`).
- "Overview" row (`#tabHome`, title "Overview").
- Group headings "Servers" and "Databases" (`span.tabs-head`, `:4135-4148`).
- Server/database row (`:3997-4048`):
  - Icon (server / database / cache for Redis) with a lamp on its corner.
  - Name (display name).
  - Note: player count as a bare number, or "crashed" (`:4020-4029`).
  - title "NAME — Running — 2 players online — offline mode"; aria-label "NAME, running, 2 players online".
- Lamp (`:523-549`, `:476-479`): running green and breathing; stopping/stale amber; orphaned/unknown/crashed red; stopped a hollow ring; reachable green; unreachable red.
- Tool dock under the open server (`:2765-2776`): "Console" (aria-current), "Plugins" or "Mods" (with update-count badge), "Files", "Worlds", "Backups", "Activity", "Players", "Stats", "Schedule", "Settings". A database shows Console, Backups, Activity, Stats, Settings (`:3803`, `:4593`).
- "New server" (`#bNew`) and "Play" (`#bLauncher`) at the foot (`:2778-2783`).
- Keyboard: one Tab stop with arrows (`:4086-4116`).
- No context menu, no drag reorder, no search.

### Findings

**SB1. In the icon rail every server looks the same** | hierarchy | medium | M
Under 1200px the name and note are hidden and each server is the same server glyph plus a lamp. With three servers there are three identical icons, told apart only by hover tooltip.

Evidence: `:2599-2600`, `:4009`.

Fix: show the first letter or two of the name in the rail tile (keep the lamp), or let the rail be widened. Extends E1.

**SB2. Player count is a bare number** | clarity | low | S
The note beside a running server is just "3" in monospace. Nothing visible says it is players; it could be read as updates or errors, and the Plugins badge is also a bare number.

Evidence: `:4025`, `:462`.

Fix: a small person glyph before the number.

**SB3. "Starting…" is not shown in the sidebar** | missing state | low | S
The row's lamp follows `row.status` only. While the header pill says "Starting…", the row is still the hollow "stopped" ring and its tooltip says "Stopped".

Evidence: `:4032`, `:4040`; compare `:4200-4205`.

Fix: pass `state.acting` / `overview.acting` into `updateTab`.

**SB4. Crashed and running differ only by colour in the rail** | accessibility | low | S
Both are a filled dot; the word "crashed" is hidden in the rail.

Evidence: `:545`, `:2600`.

Fix: a distinct shape for fault (for example a small triangle or cross).

**SB5. "New server" and "Play" are the same style, and Play uses the Start glyph** | consistency | low | S
Two identical secondary buttons stacked; the Play icon is the same triangle as Start.

Evidence: `:2778-2783`, `:2879`.

Fix: a controller or cube glyph and the label "Play Minecraft". Extends E3.

**SB6. Group headings are not headings or groups** | accessibility | low | S
"Servers" and "Databases" are `<span>`s between buttons; the rows are not in a list. A screen reader gets a flat run of buttons.

Evidence: `:4144-4147`.

Fix: `role="group"` with `aria-labelledby`, or `<h2>` elements.

**SB7. gap: no quick actions from the sidebar** | gap | medium | M
There is no right-click or hover menu on a server row. To start a second server the user must open it (which swaps the console stream) or go to Overview.

Fix: a context menu with Start, Stop, Restart, Open folder.

**SB8. gap: no order, pin or filter for the server list** | gap | low | M
Order is whatever the API returns (`:4135`). With many servers there is no search, no "running first", no drag to reorder.

**SB9. Pressing the open tool's row again closes it** | flow | low | S
A second click on "Backups" returns to the console. In a navigation list this reads as "nothing happened, then my page vanished".

Evidence: `:3891-3895`.

Fix: keep the toggle for keyboard (it announces expanded/collapsed) but make a second mouse click a no-op; "Console" and the × already close.

### Keep
- One list for servers and their tools; a single Tab stop with full arrow-key handling.
- Keyed updates that do not steal focus (`:4124-4163`).
- Stopped as a hollow ring; different glyphs for server, database and Redis.
- Plugins/Mods renamed by what the server loads (`:4582-4583`).
- Dock badge with a spoken label (`:7638`).

---

## 3. Empty / first state (`#vEmpty`)

### Inventory

- Brand mark, h1 "No servers yet" (`:2801`).
- Lede: "SpawnLoft runs Minecraft servers on this machine — start them, watch the console, send commands, and reset a world without going near a terminal." (`:2803`).
- Door "Create a server": "Downloads Paper and sets up a fresh world on a free port. Takes about a minute." Opens the Add sheet on "Create a new one".
- Door "Add one you already have": "Points SpawnLoft at a server folder on this machine. Nothing is moved or rewritten." Opens the "Add one I already have" tab.
- Shown when `state.rows.length === 0` (`:4909`), at start-up before the first answer (`:14366`), and briefly after any delete (`:12065`, `:12129`).

### Findings

**EM1. "No servers yet" is shown to someone who has only databases** | missing state | medium | S
The empty state is chosen from servers alone. With one or more databases and no server, Overview is this screen and the database cards never appear; the databases are only in the sidebar.

Evidence: `:4909-4916`; database cards live in `#vHome` (`:2846`).

Fix: use the Overview whenever `rows.length + dbs.length > 0`, with an inline "Create a server" card.

**EM2. Deleting a database flashes "No servers yet"** | missing state | low | S
`deleteDatabase` and `deleteServer` both call `show('empty')` before the refresh, even when other servers exist.

Evidence: `:12065`, `:12129`.

Fix: call `showHome()` after `refresh()` instead. Extends A4.

**EM3. Nothing here says Java is missing** | missing state | medium | S
On a fresh machine the only sign is the small amber/red chip in the header. The big door says "Takes about a minute", and the create form hides its Java warning when no Java exists at all (see AD4).

Evidence: `:2806-2815`, `:13917`.

Fix: when `health.java.found` is false, add a third line or door: "Minecraft needs Java. Get Java N" with "Check again".

**EM4. Only two of the four ways in are offered** | consistency | low | S
The Add sheet has four tabs (new, modpack, existing, database); the empty state offers two.

Evidence: `:2807-2814` vs `:3008-3011`.

Fix: a third door "Start from a modpack"; leave the database for later.

**EM5. Wording: "Paper", "on a free port", "reset a world"** | wording | low | S
"Paper" is not explained to someone who has never run a server, "a free port" is jargon on the first screen, and the lede lists "reset a world" as a headline feature.

Fix: "Sets up a new Minecraft server with a fresh world. Takes about a minute." and a lede about playing with friends.

**EM6. gap: no next step after the first server is made** | gap | medium | M
Create ends on the server page, stopped, with a toast "Created NAME on port N." (`:13182`). Nothing offers "Start it now", says how friends join, or points at backups.

Fix: start the new server (or offer "Start now") and show a one-time "What next" strip: address to share, Players, Backups.

### Keep
- Two big doors with a sentence each; "Nothing is moved or rewritten."
- A single server is opened directly at start-up (`:14377`).

---

## 4. Overview (`#vHome`)

### Inventory

- Head: h1 "Your servers"; summary chips (`:4962-5015`); "New server" (primary).
  - Chips: "N server(s)", "N running" (lamp), "N player(s) online" (only when a server answered), "N database(s)", memory "X of Y GB reserved" or "X GB reserved" with a meter.
  - Memory chip title: "Reserved is what the servers are allowed to use, added up, whether or not they are running." Tones warn over 80%, fault over 100%; aria-valuetext "N% of this machine, more than it has".
- Loading: "Loading your servers…" from CSS `::before` (`:864`).
- Failure strip: "Backup ages and this machine's memory could not be read." + "Try again" (`:2833-2836`).
- **Needs attention** (`:5543-5618`), first three, then "and N more" / "Show fewer". Every kind:
  1. Crash (fault, alert icon). Title "NAME crashed". Text "It stopped on its own at HH:MM." / "It stopped on its own N days ago." / "It stopped without being asked to." Button "See why" (primary, opens console).
  2. Restarted after a crash (fault, restart icon), only on the day it happened. Title "NAME restarted after a crash". Text "Crash guard brought it back at HH:MM." / "Crash guard has brought it back N times, the last at HH:MM." Button "See why" (primary).
  3. Plugin updates (accent, plug icon), from a cached check in this browser. Title "N update(s) for NAME". Text: the plugin names, comma separated. Button "Review" (opens Plugins).
  4. Backups (warn, archive icon), only when automatic backups are off. Title "NAME has no backups" / "NAME has never been backed up" / "No backup of NAME in N days" (the last only if running and 7+ days).
     - Text: "Turn on nightly backups at 03:00, keeping the last 7." or "Automatic backups are not available here; take one from Backups."
     - Prefixed when backups were lost by one of: "1 backup was deleted 2h ago." / "N backups were deleted …, and the backup schedule was removed …." / "Its N backups were deleted and its backup schedule was removed ….". / "The backup schedule was removed …, and no backup is left on disk." / "The last backup, made …, is no longer on disk."
     - Buttons "Turn on backups" (primary) + "Open Backups", or "Open Backups" (primary). Toast "Nightly backups of NAME at 03:00, keeping the last 7."
  5. Java (warn, alert icon). Title "Java N needed". Text "A and B won’t start until it is installed." / "A, B and N more won’t start until it is installed." Button "Get Java" (primary, external).
- **Server card** (`:5709-5952`):
  - Tile, name, pill, "Software version · localhost:PORT" (copy button).
  - Buttons "Restart" (while running), "Play" / "Playing", and "Stop" / "Start" / "Restart" (crashed) / "Starting…" / "Stopping…" / "Restarting…".
  - Stats Players / TPS / Memory with sparklines when the card is 640px+.
  - Idle line: "Needs Java N to start" / "Crashed — open the console to see why, or start it again" / "Starting — live stats appear once it is up" / "Server is stopped — start it to see live stats".
  - Owned database row: name + "DATABASE", engine · address, pill, "Open →". Shared: "Shared database(s) A, B".
  - Foot note (`:5782-5798`): "Checking backups…" / "Backups unknown" / "Last backup 3h ago · Backs up every day at 03:00" / "Last backup … · No schedule" + "Set up backups" / "No backup yet · First one every day at 03:00" / "Test copy, backups off" / "No backups kept · Backups off" + "Set up backups" / "Never backed up · Backups off" + "Set up backups".
  - "Open →".
  - Toasts: "Starting NAME…", "NAME started.", "NAME is being launched.", "NAME is already running. Stop it under Preferences › Game client.", "Starting NAME…", "NAME is running."
- **Database card** (`:5143-5221`): database tile, name, pill, "MySQL 8.4 · runs elsewhere · host:port"; "Memory" (value / "Not measured" / "Not running"); "Used by" (server chips / "Nothing yet"); foot "Shared by N servers" / "1 server attached" / "No server attached"; "Open →".
- **Recent activity** (`:5326-5464`): 8 runs, then "View all N" / "Show fewer" / "View all in NAME’s Activity"; day labels "Today" / "Yesterday" / weekday; times "just now", "5m ago", "2h ago", "1 day ago"; "Failed" / "Crash" pill; server name and actor chip only when more than one.
  - Actor chips: "You", "You, in a terminal", "AI assistant" (or its name), "Schedule: NAME" / "A schedule", "SpawnLoft".
  - Single-entry wording (`:10077-10089`, `:5296-5304`):
    - Lifecycle: "Started", "Stopped", "Forced to stop", "Crashed" (or the crash detail), "Ran <command>".
    - Backups: "Backed up", "Restored a backup", "Deleted a backup", "Cleared old backups", "Locked the backup", "Unlocked the backup", "Noted the backup".
    - Files: "Edited / Created / Uploaded / Replaced / Moved / Deleted / Zipped / Unzipped <path>", "Made a folder", "Changed <config>", "Put back <x>".
    - Settings and software: "Changed settings", "Changed the server software".
    - Plugins: "Installed / Updated / Turned on / Turned off / Removed <plugin>".
    - Worlds: "Switched to the world", "Imported the world", "Deleted the world".
    - Players: "Made an operator", "Took operator from", "Banned", "Unbanned", "Forgot the player".
    - Schedules: "Scheduled", "Changed the schedule", "Turned on the schedule", "Paused the schedule", "Removed the schedule", "Ran the schedule now".
    - Server: "Created this server", "Added this server from", "Renamed", "Reset", "Deleted this server".
  - Run wording (`:5282-5292`): "Made N backups", "Started N times", "Ran N commands", and so on; anything else "<verb> ×N".
  - A deleted server shows "NAME (deleted)" and is not a link.

### Findings

**OV1. The most blocking attention item is listed last and can be hidden** | hierarchy | medium | S
Items are pushed in a fixed order: crashes, crash restarts, plugin updates, backups, then Java. Only three show. With three servers lacking backups, "Java 25 needed — won’t start" is behind "and 1 more", below optional plugin updates.

Evidence: `:5548-5616`, `:5628`.

Fix: sort by severity (cannot start, crashed, unprotected, updates) and merge same-kind items ("3 servers have no backups").

**OV2. Attention list misses several real problems** | gap | medium | M
There is no card for:
- an orphaned, stale or unavailable server;
- an unreachable or crashed database (the crash check walks `state.rows` only);
- memory reserved beyond the machine;
- an available SpawnLoft update;
- the handover failures shown in the banner.

Evidence: `:5548`, `:5000`.

Fix: add these kinds; they each already have a state and a sentence elsewhere.

**OV3. Crash card has no "Start again"** | flow | low | S
The only button is "See why". The Restart button is on the server card further down the page.

Evidence: `:5556`.

Fix: add "Start again" as the second button.

**OV4. "Turn on backups" acts at once with fixed settings and no undo** | flow | medium | S
One click schedules a nightly 03:00 job. A hobbyist's PC is often off at 03:00; nothing says what happens then, and the toast is the only trace.

Evidence: `:5696-5705`.

Fix: keep one click, but make the toast carry "Change" (opens Backups) and say "runs when this computer is next on" if that is true. Also offer "Back up now" on "never been backed up" cards (gap).

**OV5. Time formats are mixed inside one card** | consistency | low | S
"at 03:00" is hard-coded 24-hour while crash times use the locale clock (`toLocaleTimeString`), so a US machine shows "It stopped on its own at 3:07 PM" beside "nightly backups at 03:00".

Evidence: `:5484`, `:5592`.

Fix: format the schedule time with the same function. Extends A10.

**OV6. "N updates for NAME" does not say plugin updates, and can be stale** | clarity | low | S
The title is ambiguous alongside app and server-software updates. It comes from a cache in this browser's storage (`:7614`), so it can persist after the plugins were updated elsewhere.

Evidence: `:5579`.

Fix: "2 plugin updates for NAME"; stamp the cache and drop it after a day. Extends E2.

**OV7. Attention cards are single full-width rows at any width** | scaling | low | S
The code comment says "Three to a row" but the grid is one column. At 2560+ the text sits at the far left and the buttons up to 1600 to 2200px to the right.

Evidence: `:874`, `:5621`, `:919`, `:928`.

Fix: `repeat(auto-fit, minmax(420px, 1fr))` from the Wide tier.

**OV8. Orphaned, stale and stopping servers' cards say "Server is stopped"** | missing state | medium | S
The idle line has four branches. Orphaned (Java still running), stale and stopping all fall into "Server is stopped — start it to see live stats", and orphaned and stale get a primary "Start".

Evidence: `:5870-5880`, `:5753-5754`.

Fix: a line per state ("Still running, but SpawnLoft lost track of it", "Stopping…") and no primary Start for orphaned. Extends E7.

**OV9. Players shows "… starting" whenever the server has not answered** | wording | low | S
A server up for hours whose status query is not answering still reads "starting".

Evidence: `:5884`.

Fix: "…" with "waiting for the server" after the first minute.

**OV10. An external database that is reachable says "Not running"** | wrong state | medium | S
Memory is read only when `status === 'running'`. Anything else, including "reachable", prints "Not running" directly under a green "Reachable" pill.

Evidence: `:5179-5187`.

Fix: for external databases show "Runs elsewhere".

**OV11. Database cards have no Start or Stop, and Redis gets the MySQL glyph** | consistency | low | S
Server cards carry their verbs; a local database card has only "Open →". The card tile is always the database cylinder, while the sidebar uses a different glyph for Redis.

Evidence: `:5143-5165`, `:5146` vs `:4009`.

**OV12. Only "Open →" opens a card** | flow | low | S
The name and the card body are not clickable; the target is one small button at the bottom right.

Evidence: `:5741-5745`.

Fix: make the name a link/button too (keep inner buttons separate).

**OV13. Memory chip: over-commit is said only by colour, and "reserved" is jargon** | accessibility / wording | medium | S
Above 100% the number and bar turn red; the words stay "12 of 8 GB reserved". The explanation of "reserved" is a tooltip on an `<li>`.

Evidence: `:4996-5001`, `:4992`.

Fix: "Servers may use 12 GB; this computer has 8 GB" with a warning glyph.

**OV14. Memory total ignores servers with a decimal memory value** | wrong data | medium | S
The create and edit forms accept "2.5G" (`MEM_RE`, `:12810`) but `memoryCeilingMb` only matches whole numbers. Such a server counts as 0 in "reserved", and its Memory vital shows no "/ N GB" and no bar.

Evidence: `:7034-7038`, used at `:4959`, `:4453`, `:5888`.

Fix: accept decimals in `memoryCeilingMb`.

**OV15. Low TPS is not flagged on cards; in the header it is flagged by bar colour only** | accessibility | low | S
Cards pass no tone for TPS (`:5886`). In the header only the 4px meter turns amber or red (`:4447`); the figure itself does not change and no word is added.

Fix: tone the number and add "slow" / "very slow" as the unit text.

**OV16. The feed can show typed commands, which the panel elsewhere treats as secret** | privacy | medium | S
The command box does not keep history on disk "because a command can carry a password" (`:3574-3575`). The core records every command's full text in Activity (`src/supervisor.mjs:333`) and Overview prints it as "Ran <command>".

Evidence: `:5313`, `:5398-5399`.

Fix: record only the command word, or mask arguments of known sensitive commands.

**OV17. Unknown or unphrased activity falls back to raw ids and "×N"** | wording | low | S
An action missing from the table prints its internal id (`e.action`). Runs of actions without a plural phrase print things like "Changed the server software ×2", "Put back ×3", "Made a folder ×4".

Evidence: `:5313`, `:5316`; the plural table at `:5282-5292` lacks about twenty actions.

Fix: fill the table; default to "Did N things".

**OV18. "View all N" is not all** | wording | low | S
N counts runs within the 60 entries fetched.

Evidence: `:4930`, `:5368`.

Fix: "Show N more" and a link to the server's Activity.

**OV19. Several "See why" / "Open →" / "Set up backups" buttons, some without a name** | accessibility | low | S
"See why", "Review" and "Open Backups" carry no server name. Cards do it right ("Open NAME", `:5859`).

Evidence: `:5660-5666`.

Fix: `aria-label` with the server name.

**OV20. "Loading your servers…" is CSS-generated text** | accessibility | low | S
It is `content:` on a pseudo-element, which is not reliably announced, and it hides cards that are already known until `/overview` answers.

Evidence: `:863-864`, `:5019`.

Fix: show the cards at once with "Checking backups…" (the note already has that state) and drop the page-level hide.

**OV21. Failure sentence is awkward** | wording | low | S
"Backup ages and this machine's memory could not be read." (`:2834`).

Fix: "Could not load backup times and memory. Try again."

### Keep
- Attention cards rebuilt only when their meaning changes, so focus survives (`:5631-5635`).
- "never" only when the log agrees (`:5500-5516`).
- Players chip only from servers that answered (`:4966-4971`).
- Runs folded into one line with details.
- Server and actor shown only when there is more than one.
- Copy-address button with an in-place tick.
- Owned databases nested in the server's card.

---

## 5. Server view header

### Inventory

- Name `h1#srvName` (display name) and `#srvId` (folder id, shown only when different; title "The name the folder and the commands use") (`:2868-2869`).
- Status pill (`:3961-3970`, `:4196-4223`):
  - Live tone: "Running · 1h 2m" (server), "Running" (database), "Reachable".
  - Warn tone: "Starting…", "Restarting…", "Stopping…", "Stale state".
  - Fault tone: "Crashed", "Orphaned", "Unavailable", "Unreachable".
  - Neutral: "Stopped". Any unknown status prints the raw string.
- Badge "Offline mode" (title "Anyone can join as any name. Players get name-derived UUIDs, and every log carries an OFFLINE/INSECURE banner.") (`:2871`).
- Meta line (`:4238-4264`): "Paper 1.21.4 · localhost:25565 [copy] · Java 21"; database "MySQL 8.4, runs elsewhere · host:port".
- Vitals (`:4387-4470`):
  - Running: "Players n / max", "TPS 19.9", "Memory 1.2 / 4 GB", "Last backup 3h ago" / "now" / "Never" / "…".
  - Not running, one sentence: "Starting. Players, TPS and memory appear once it answers." / "Crashed. The console shows the last lines before it stopped." / "Not running. Start it to see players, TPS and memory."
  - Database: "Memory", "Attached" (names or "nothing yet").
  - Tooltips: "Waiting for the server to answer over RCON"; "Ticks per second over the last minute; 20 is full speed"; "The whole java process. It can sit above the 4G heap limit; that is normal."; "The whole database process".
- Buttons "Restart", "Stop", "Start" (primary), "⋯" (aria-label "More actions") (`:2877-2885`).
- **⋯ menu, server** (`:4493-4515`):
  - "Open folder" — "Shows the server’s files in Explorer/Finder/your file manager."
  - "Play" — "Opens the Play page to make a setup for this server." / "The game client “X” is running." / "Starts the game client “X” pointed at this server."
  - "Upgrade…" — "A newer build, or a newer Minecraft version, under Server software."
  - Running: "Stop and edit…" — "Name, memory and port. Stops the server first." Otherwise "Rename, memory and port…" — "Takes effect the next time it starts." (disabled while stopping: "Stop the server first.")
  - "Reset the world…" — "Deletes worlds and generated state. A snapshot is taken first." / "Stop the server first."
  - "Delete this server…" — "Removes it from SpawnLoft, and optionally its files." / "Stop the server first."
- **⋯ menu, database**: one item, "Manage this database…" — "Rename it, see its credentials, or delete it."
- **Dialogs**
  - "Stop NAME to edit it?" — "One player is online and will be disconnected." / "N players are online and will be disconnected." / "Nobody is online." Button "Stop and edit".
  - "Edit ID" — "Changes apply the next time this server starts." Fields "Name", "Folder and command name", "Memory", "Port". Button "Save changes". Toasts "Renamed to X.", "Saved. Takes effect on the next start."
  - "Reset the world of ID?" — "Worlds, logs and cached state are deleted. A snapshot is taken first, so this can be undone." Choices "Keep plugins" (Plugin jars and their config survive. Usually what you want.) / "Remove plugins too" (Starts over completely, as if the server were new.). Type to confirm. Button "Reset world". Toasts "Resetting ID… taking a snapshot first.", "Reset. Snapshot saved to PATH."
  - "Delete ID?" — choices "Remove from SpawnLoft, keep the files" (The folder stays where it is. You can add it again later.) / "Delete the files as well" (The whole server folder goes. A snapshot is taken first.). Type to confirm. Button "Delete server". Toasts "Deleting ID…", "Deleted. Snapshot saved to PATH.", "Removed from SpawnLoft. The files are still in their folder."
  - "Manage ID" (database): external — "This database runs elsewhere. Forgetting it here leaves it exactly as it is; only the record and its attachments go." Choice "Forget this database". Running — "This database is running. Stop it first to delete it. Servers attach to it from their own Settings tab." Choice "Open its folder". Stopped — "Choose what to do with this database." Choices "Open its folder" / "Delete this database". Button "Continue".
  - "Delete ID?" (database) — "Attached: a, b. Their plugin configs will still name this database." Choices "Remove from SpawnLoft, keep the data" / "Delete the data as well" (Every database and table on it goes. There is no snapshot of a database yet.). Button "Delete database". Toasts "Deleted, data and all.", "Removed from SpawnLoft. The data is still in its folder."
  - Edit address (database page, `:4684-4753`): pencil "Edit address"; fields "Host", "Port", "Admin user" (Empty keeps the one saved.), "Password" (Empty keeps the one saved.); "Save", "Cancel". Toasts "Saved. NAME answers at host:port." / "Saved, but nothing answers at host:port yet."
  - "Not answering" notice: "Nothing replied at host:port. Start it where it runs, or correct the address, then check again." Buttons "Check again", "Edit address".
- **State notices** `#srvNotice` (`:3974-3979`, `:4597-4612`), each with ×:
  - "Orphaned" — "The Java process is still running but the supervisor that owned it is gone, so SpawnLoft can no longer talk to it. Stop it with "spawnloft kill" in a terminal, then start it again here." (no button)
  - "Stale state" — "A leftover state file from a session that did not shut down cleanly. Starting the server clears it." Button "Start".
  - "Unavailable" — "SpawnLoft could not read this server’s state. Its folder may have been moved or deleted." (no button)
- **Crash findings** `#srvDiag` (`:4829-4900`; titles and advice from `src/diagnose.mjs:13-112`). At most two are shown; each gets "Show in console" when a line is known, and ×.
  - "The port is already taken" — button "Change port…"
  - "The EULA is not accepted" — "Open folder"
  - "Java is too old for this server" — "Choose Java"
  - "The server ran out of memory" — "Raise memory…"
  - "The disk is full" — no button
  - "A plugin is missing a dependency" — "Open Plugins"
  - "A mod is missing a dependency" — "Open Mods"
  - "Two plugins claim the same name" — "Open Plugins"
  - "The world failed to load" — "Open Backups"
  - "Something in the world crashed the server" — "Crash reports"
  - "The server stalled and the watchdog stopped it" — no button
  - "The server jar is missing" — "Server software"
  - Crash-report notice: "1 crash report" / "N crash reports" — "<description or file>  ·  2h ago". Buttons "Open folder", "Report", ×.

### Findings

**HD1. The database menu promises things that do not exist, and "Forget" leads to "Delete the data as well"** | flow / wording | high | M
- The menu hint says "Rename it, see its credentials, or delete it." The dialog offers only "Open its folder" and "Delete this database"; there is no database rename anywhere in the panel (the only rename call is for servers, `:12001`).
- For an external database the dialog says forgetting "leaves it exactly as it is", then "Continue" opens the generic delete dialog. Its title is "Delete ID?" and its second option is "Delete the data as well — Every database and table on it goes". Whether the core refuses that for an external database is unverified; the panel offers it.

Evidence: `:4496`, `:12079-12105`, `:12108-12119`.

Fix: make the ⋯ menu the real list (Open folder, Show admin login, Rename…, Delete… / Forget…) and give external databases their own one-option confirm. Extends F11.

**HD2. Finding advice tells the user to run commands and names menus that no longer exist** | wording | high | M
The advice text is written for the terminal and shown as-is:
- "“spawnloft list” shows who; change the port under Manage"
- "point this server at it with "spawnloft set <name> java=<path-to-java.exe>""
- "move the server with "spawnloft config set-instances"… "spawnloft prune" can thin old snapshots"
- ""spawnloft verify" proves which ones are whole"
- ""spawnloft upgrade" for Paper, or re-choose a jar with "spawnloft set <name> jar=...""
- "Set eula=true in DIR\eula.txt" (a backslash on every platform)

"Manage" was the old name of the ⋯ menu; "the Plugins tab", "the Mods tab" and "the Backups tab" are sidebar tools.

Evidence: `src/diagnose.mjs:18-108`; the Rust core carries the same strings (`rust/crates/spawnloft-lib/src/diagnose.rs:56-170`); shown at `:4871`.

Fix: let the panel pick its own advice per finding id (it already picks the buttons) and keep the CLI text for the CLI. Extends C1.

**HD3. The address is always `localhost`** | gap | high | M
The header, cards and copy button all give "localhost:PORT". That works only on the same computer. There is no LAN address, no public address, and no word about what a friend should type. A port that is not known shows and copies "localhost:?".

Evidence: `:4250`, `:5836`, `:5070-5079`.

Fix: a "How to join" popover on the address: this computer, same Wi-Fi (LAN IP), over the internet (with the caveat about port forwarding). Disable copy when the port is unknown.

**HD4. The state notice is rebuilt every four seconds** | accessibility | medium | S
`renderServer` runs on every poll and empties and refills `#srvNotice`. A keyboard user who tabs to "Start" or × in the "Stale state" notice loses focus within four seconds, and a hover tooltip is orphaned. Crash findings are keyed and do not have this problem.

Evidence: `:4597-4612`, called from `:6114`.

Fix: key the notice on `noteKey` and leave it alone when unchanged.

**HD5. Dismissing a notice drops keyboard focus** | accessibility | low | S
× removes the box that holds the focused button.

Evidence: `:4806`.

Fix: move focus to the next notice or to the console.

**HD6. "Change port…" and "Raise memory…" open the Edit dialog even while the server is running** | flow | medium | S
Findings are shown in amber on a running server too. The buttons call `editServer` directly; the core refuses edits on a live server, so the user fills in the form and gets an error toast with the values gone.

Evidence: `:4830-4831`; refusal noted at `:4614-4616`.

Fix: route through `stopThenEdit` when running. Extends F3.

**HD7. Only two findings are shown, with no hint of more** | missing state | low | S
`data.findings.slice(0, 2)`. Evidence: `:4863`.

Fix: "and 1 more" expander.

**HD8. Findings with no way out** | flow / gap | medium | M
- "The disk is full" and "The server stalled…" have no button.
- "The EULA is not accepted" opens the folder so the user can hand-edit a file, although SpawnLoft accepts the EULA itself when creating a server (`:3076`).
- "Crash reports" (finding) and "Open folder" (crash-report notice) are the same action under two names.
- "Report" does not say it opens GitHub.

Evidence: `:4829-4845`, `:4885-4894`.

Fix: "Accept the EULA and start"; "Free up space: open Backups"; rename to "Open crash reports" and "Report this crash…".

**HD9. Edit dialog: field names, no checks, silent folder rename** | clarity | medium | M
- The title is "Edit ID" while the menu items are "Rename, memory and port…" and "Stop and edit…".
- The second field is "Folder and command name". Changing it renames the server's folder and id with no warning; the user is told nothing about what happens to backups and schedules stored under the old name.
- Memory and Port are not validated here; the create form has checks for both (`:12829`, `:13009`).
- The Port field has no min or max.
- The dialog says "Changes apply the next time this server starts", but it can only be opened while stopped.

Evidence: `:11920-11934`, `:11992-12001`.

Fix: title "Rename, memory and port"; reuse `checkMemory` / `checkPort`; put the folder name behind "Also rename the folder" with a sentence on what it does. Extends F3 and A10.

**HD10. Type-to-confirm asks for the folder id, which the user may never have seen as such** | clarity | low | S
The confirm compares against `row.name`. The header shows the display name, with the id as a small grey tag only when it differs. The click-to-fill button softens this.

Evidence: `:12021`, `:12049`, `:12115`, `:4576`.

Fix: accept either the display name or the id, and show the display name in the title. Extends A10.

**HD11. Reset the world says "plugins" on a mod server, and two different lists of what is deleted** | wording | low | S
The choices are "Keep plugins" / "Remove plugins too" for every server, including ones whose tool is called "Mods". The menu says "Deletes worlds and generated state"; the dialog says "Worlds, logs and cached state are deleted".

Evidence: `:12018-12025`, `:4512`.

Fix: use the software's content word; one list (worlds, logs, caches).

**HD12. Delete dialog does not say what happens to backups and schedules** | weak confirm | medium | S
The dialog has no body text. "Delete the files as well" says a snapshot is taken first, but not where it goes, whether older backups survive, or whether scheduled tasks and attached databases are removed.

Evidence: `:12045-12054`.

Fix: one sentence: "Its backups stay in PATH. Its schedule is removed."

**HD13. Database "Attached" vital lists folder ids** | consistency | low | S
The header joins `Object.keys(row.attachments)`; the Overview card shows display names for the same thing.

Evidence: `:4395-4404` vs `:5201-5204`.

**HD14. An unreachable local database shows no notice unless Settings is open** | missing state | low | S
The header notice is suppressed for databases, and the "Not answering" box is painted only inside the Settings tool.

Evidence: `:4604`, `:4757-4758`.

**HD15. "Stop and edit" can end silently** | missing feedback | low | S
After the stop, the dialog opens only if the server is neither running nor stopping. If it is still "Stopping…", nothing happens and nothing is said.

Evidence: `:4525-4527`.

Fix: wait for stopped, or toast "Still stopping. Try Edit again in a moment."

**HD16. Vitals wording: "RCON", "heap", "java process"** | wording | low | S
Tooltips at `:4434` and `:4455`.

Fix: "Waiting for the server to answer" and "Total memory the server is using. It can be a little above the limit you set." Extends C3.

**HD17. "Last backup" is not a link** | gap | low | S
The vital shows the age but does not open Backups. Evidence: `:4412-4418`.

**HD18. "Upgrade…" finds its section by matching heading text** | fragile | low | S
`openUpgrade` looks for an `h3` whose text is exactly "Server software". Renaming that heading silently breaks the menu item; it then just opens Settings at the top.

Evidence: `:4563`. Same pattern as F10.

**HD19. A stopped server's vitals put a `<p>` inside a `<dl>`** | accessibility | low | S

Evidence: `:4423-4429`.

Fix: render the sentence outside the list.

**HD20. The ⋯ menu can close under the user** | flow | low | S
When the Play setups change, `buildMoreMenu` empties and refills the menu even if it is open. The focused item is removed and the focus-out handler closes it.

Evidence: `:6013`, `:6536-6538`.

Fix: skip the rebuild while open.

### Keep
- One primary verb at a time; the busy verb spins and the pill says "Starting…".
- Disabled menu items stay and say why.
- "Stop and edit" counts the players who will be disconnected.
- A crashed or stopped server gets one plain sentence in place of dashes.
- Findings carry a direct button and "Show in console".
- Notices dismissed per run (`:4662-4670`).
- The external-database address editor is inline, with "Empty keeps the one saved" and an honest "Saved, but nothing answers…".

---

## 6. Console

### Inventory

- Toolbar (`:2900-2940`):
  - Filter box, placeholder "Filter the console".
  - Level buttons "All", "Warnings N", "Errors N".
  - Count "N lines" / "X of Y lines" / "N held · …".
  - Icon buttons "Pause" / "Resume", "Wrap long lines", "Open in its own window", "Copy the lines shown".
  - "Diagnostics".
  - "Share log ▾" menu: "Save to a .log file" (Keeps a copy beside this server's snapshots.), "Upload to mclo.gs" (Publishes a shareable link and opens it.), "Line numbers" (check item), "Clear the view" (The log file on disk is untouched.).
- Log `pre#log role="log" aria-label="Server console"` (`:2942`); 5000-line cap (`:3536`); level shown as a coloured left rail (`:2396-2401`); prefix dimmed; search hits in `<mark>`.
- Empty texts (`:6250-6254`): "Nothing matches. Clear the search or the level filter to see the rest." / "This database runs elsewhere, so its log is on that machine, not here." / "No output yet. Start the database and its log appears here as it runs." / "No console output yet. Start the server and it appears here as it runs."
- "Jump to latest" / "Jump to latest · N new" (`:2943`, `:6626`).
- Command row (`:2946-2953`): "/" prompt; placeholder "Type a command — ↑ recalls" / "Start the server to send commands"; "Send" (primary) or "Start server"; hidden for databases.
- Strip under a tool (`#conMini`, `:2993`): "Console" + last line + "N errors", title "Back to the console". Hidden from 1600px, where the console keeps its own column (`:1234`).
- Pop-out window: `/?console=NAME`, 980×660, title "NAME — console"; hides header, sidebar, ⋯ and the state notice (`:1640-1648`).
- Toasts: "Nothing to copy.", "Copied N lines.", "Copied.", "Could not reach the clipboard.", "Console view cleared. The log file on disk is untouched.", "Saving the console…", "Exported N lines to FILE (SIZE).", "Writing the diagnostics zip…", "Diagnostics zip written (SIZE). Download", "Uploading to mclo.gs…", "Uploaded — URL", "Uploaded the last N lines — URL", "Select a server first."
- mclo.gs dialog "Upload this console to mclo.gs?" — "The log is published at a public link that anyone holding it can read. Before sending, SpawnLoft replaces your account name in file paths. mclo.gs removes IP addresses on its side, best effort, and deletes the log 90 days after it was last opened. Player names, plugin output and everything else stay in - read it over first. The delete token is kept in run/mclogs.json so the log can be taken down later." Button "Upload and open".

### Findings

**CO1. "Show in console" reduces the log to one line** | flow | medium | M
The button puts the finding's text into the filter. The console then shows that single line with nothing around it, and the user must clear the filter to see what led up to it, losing the place.

Evidence: `:4814-4822`.

Fix: scroll to the line and highlight it, with the filter left alone.

**CO2. Pause stops holding as soon as the filter or search changes** | bug | medium | S
`renderLog` draws every stored line and ignores `pausedAt`. While paused, typing in the filter or pressing a level button shows all the "held" lines, yet the button still says Resume and the count still says "N held".

Evidence: `:6235-6245`, `:6229-6231`, `:6295`.

Fix: slice `state.lines` to `pausedAt` in `renderLog` while paused.

**CO3. Paused is easy to miss** | missing state | low | S
The only signs are the icon changing to a play triangle and "N held" in 11px text once lines arrive. With no new lines, nothing says the console is paused. "held" is also an odd word.

Evidence: `:6401-6408`, `:6231`.

Fix: a visible "Paused · 12 new lines" bar over the log with "Resume".

**CO4. No clear button for the filter** | flow | low | S
The filter is a plain text input with no × and the empty message says "Clear the search or the level filter" without offering it.

Evidence: `:2903`, `:6251`.

Fix: `type="search"` (the cancel-button style already exists at `:723`) and a "Show everything" button in the empty message.

**CO5. After "Clear the view", a running server says "Start the server"** | wrong state | low | S
The empty text is chosen from `state.lines.length` alone.

Evidence: `:6474-6480`, `:6254`.

Fix: when the server is running say "Cleared. New lines appear here." Extends F10.

**CO6. "Save to a .log file" leaves no way to reach the file** | flow | medium | S
- The menu says "Save" and the toast says "Exported … to FILE".
- The toast lasts five seconds and the path cannot be clicked.
- In a browser nothing is downloaded.
- The hint says "beside this server's snapshots".

Evidence: `:2923-2924`, `:6557-6562`.

Fix: one verb; toast with "Show in folder" (app) or a download link (browser), kept until dismissed. Extends A2 and B1.

**CO7. mclo.gs: the link is not copied, and there is no way to take a log down** | flow / gap | medium | M
After upload the page opens the link and shows it in a five-second toast as plain text. It is not on the clipboard, although pasting it somewhere is the point. The dialog says the delete token is kept "so the log can be taken down later", but no screen lists uploads or deletes one.

Evidence: `:6613-6618`; no other mclo.gs code in the file.

Fix: copy the link, keep a "Copy link" toast, and add "Shared logs" (list with Delete) under Share log.

**CO8. mclo.gs dialog wording** | wording | low | S
"run/mclogs.json", "delete token", "best effort", and a hyphen used as a dash. It also does not say whether the whole log or only the filtered view is sent.

Evidence: `:6603-6607`.

Fix: three short lines: who can read it, what is removed, what stays in; and "Uploads the whole log, not just the lines shown."

**CO9. "Diagnostics" writes and downloads a file with no explanation** | weak confirm | low | S
Unlike the mclo.gs upload, nothing says what the zip contains or where it is saved; it also auto-clicks a download link inside a toast.

Evidence: `:6569-6586`.

Fix: tooltip or first-use sentence "Saves a zip of logs and settings for a bug report. No passwords." Extends D3.

**CO10. The popped-out console can show "No servers yet" or the Overview** | missing state | medium | S
If the name in the address no longer exists, the window stays on the empty state with working "Create a server" doors and no sidebar. If the server is deleted while the window is open, it falls to Overview.

Evidence: `:14371-14373`, `:6099-6105`.

Fix: in console-only mode show "This server no longer exists. Close this window."

**CO11. Pop-out gives no feedback if the window is blocked, and is titled by id** | missing feedback | low | S
`window.open` returning null is not checked. The title uses the folder id.

Evidence: `:14381-14385`, `:3600`.

Fix: toast "Your browser blocked the window"; title from the display name. Extends H7.

**CO12. The "/" prompt and slash commands** | clarity | low | S
A lilac "/" sits inside the field, yet the text is sent exactly as typed (`:12779`, `src/supervisor.mjs:330-333`). A user who types "/say hi", as in the game, sends "/say hi" to a console that expects "say hi". Whether the server tolerates the extra slash is unverified.

Fix: strip one leading slash before sending, or change the prompt to ">".

**CO13. Wrong placeholder while stopping** | wording | low | S
During "Stopping…" the box is disabled and says "Start the server to send commands".

Evidence: `:4644`.

Fix: "Stopping…".

**CO14. Enter sends during text composition** | bug | low | S
The key handler does not check `e.isComposing`, so confirming an IME candidate (Chinese, Japanese, Korean player names or chat) sends the half-typed command.

Evidence: `:12788`.

**CO15. gap: no command help** | gap | medium | M
There are no suggestions, no list of common commands (say, op, whitelist add, stop), and no completion. The only hint is "↑ recalls".

**CO16. The console strip's error count never resets** | clarity | low | S
"N errors" counts every error since the stream connected and stays red after the user has looked.

Evidence: `:3915-3916`.

Fix: count errors since the console was last on screen.

**CO17. `role="log"` announces every line** | accessibility | low | S
A busy server writes many lines a second; a screen reader user gets all of them unless they find Pause. The log is also labelled "Server console" for a database.

Evidence: `:2942`.

Fix: `aria-live="off"` by default with a "Read new lines aloud" toggle; label by kind.

**CO18. Pause is both a pressed toggle and a renamed button** | accessibility | low | S
It becomes "Resume, pressed", which is a double state.

Evidence: `:6403-6406`.

Fix: keep the name "Pause" and flip only `aria-pressed`, or rename without `aria-pressed`.

**CO19. "Jump to latest" uses the download glyph** | consistency | low | S

Evidence: `:2943`. Use a plain down arrow.

**CO20. "Warnings" also shows errors; line numbers are not file line numbers** | clarity | low | S
The Warnings filter includes errors (`:6210`). Line numbers are a counter since the stream connected and restart on reconnect or clear (`:6275`, `:6308`).

Fix: label "Warnings and errors" (or exclude errors); tooltip "Numbered from when this view opened".

**CO21. Database console offers Minecraft-only actions** | consistency | low | S
"Diagnostics" and "Upload to mclo.gs" stay visible for a database and call the `/instances/…` paths (`:6550`, `:6575`). Whether those work for a database is unverified.

Fix: hide them for databases.

**CO22. Toolbar at 1000 to 1200 wide** | scaling | low | S (estimate, not rendered)
The filter (up to 220px), three level buttons, count, four icon buttons, "Diagnostics" and "Share log" share one wrapping row (`:2303`). At a 944px stage they most likely wrap onto two rows, and the two labelled buttons are the least-used ones.

Fix: fold Diagnostics into the Share menu. Related to E5.

### Keep
- The console keeps streaming under tools and stays visible beside them from 1600px.
- Stack traces inherit their level and count as one error (`:6221`).
- Text is cleaned of control codes and never becomes markup.
- "Jump to latest · N new".
- ↑ and ↓ history with the draft kept.
- Send swaps to "Start server" when stopped.
- "Clear the view" says the file is untouched.
- The upload confirm says what is public.

---

## 7. Add a server sheet (`#vAdd`)

### Inventory

- Head "Add a server" / "Add a database"; "Close" (`:3003-3005`, `:12839`).
- Tabs "Create a new one", "From a modpack", "Add one I already have", "A database" (`:3008-3011`).
- **Create a new one** (`:3014-3078`)
  - Group "What to run".
  - Name: placeholder "Survival (Season 3)"; hint "Anything you like. The folder and the console use `slug`"; error "There is already a server called X."
  - Software (from `src/software.mjs`), with what changes per option:
    - Paper — "Runs plugins" — "Downloads the newest stable Paper build."
    - Purpur — plugins — "A Paper fork with more configuration. Downloads the newest Purpur build."
    - Folia — plugins — "Paper with regionised multithreading. Only plugins built for Folia will load."
    - Advanced Slime Paper — plugins — "Paper with Slime World Manager built in, from InfernalSuite. Downloads the newest build."
    - Spigot, CraftBukkit — plugins — "Compiled on this machine by SpigotMC’s BuildTools. Needs a JDK and takes five to ten minutes the first time."
    - Vanilla — "No plugins or mods" — "Mojang’s own server, unmodified. No plugins and no mods."
    - Fabric — "Runs mods" — "Downloads the Fabric server launcher, which fetches the rest on first start."
    - NeoForge — mods — "Runs the NeoForge installer, which downloads its libraries. Takes a few minutes."
    - Per option: the version list is re-fetched, the hint under Software and under Version change, each version gets "· Java N", the summary line changes, and after creation the Plugins tool is named Plugins or Mods.
  - Minecraft version: "Loading versions…"; "1.21.4 (newest)  · Java 21"; failure "Unavailable" + "Could not reach the Paper download service. Try again" + hint "Creating a server needs a connection, to download the server jar. A server you already have can still be added." + button "Add an existing server instead".
  - Java warning: "Minecraft X needs Java N. The newest Java found on this machine is M. Get Java N first, or create it anyway and point it at a Java of your own afterwards."
  - Memory: "4G"; hint "e.g. 4G"; error "Use a number followed by G or M — for example 4G, or 6144M."
  - Port: placeholder "auto"; hint "Blank picks a free one"; error "Use a port from 1024 to 65535, or leave it blank."
  - Group "Who can join": "Require a Minecraft account" / "Anyone, as any name".
  - Summary: "Creates Paper 1.21.4 · 4G memory · a free port · Minecraft account required".
  - "Create server" + hint "Accepts the Minecraft EULA on your behalf, as the operator of this machine."
  - Progress: bar + "Starting…" then job messages; hint "This can take a minute on a slow connection."
  - Java refusal dialog "No Java here can run this version" — "<error> The server will not start until it has a Java that fits; you can choose one under Settings → Java." Button "Create anyway".
  - Toast "Created ID on port N."
- **From a modpack** (`:3080-3118`, `:13241-13362`)
  - "Modpack" search, placeholder "Search Modrinth — server-ready Fabric and NeoForge packs"; "Search"; hint "The pack decides the Minecraft version, the loader and the mods. You pick a name and how much memory it gets."
  - Results: "Asking Modrinth…"; raw error; "No server-ready Fabric or NeoForge packs match that."; rows with title, "N downloads · description", "Use this pack".
  - "Chosen pack"; Name (hint "Folder and console: `slug`"); Memory (hint "Modded servers want 4G or more."); "Create server from this pack" + hint "Downloads every server-side file the pack lists, checksummed, before the server exists."
  - Toast "Created ID from PACK."
- **Add one I already have** (`:3120-3146`)
  - "Server folder": placeholder "C:\Minecraft\survival"; "Browse…" (app only); hint "Paste the full path of the folder holding the server jar and server.properties." / "The folder holding the server jar and server.properties."
  - "Name in SpawnLoft": placeholder "Survival"; hint "The console and commands use `slug`".
  - Memory "4G".
  - "Add server" + hint "Nothing is moved. Its port and RCON password are read from its own server.properties."
  - Toast "Added ID on port N."
- **A database** (`:3148-3221`, `:12856-13118`)
  - Intro: "A database for plugins that want one — MySQL for LuckPerms, CoreProtect, Plan and the rest; Redis for messaging between servers. Run here, downloaded once and supervised like a server, reachable only from this machine. Or point at one you already run."
  - Mode: "Run one here" (MySQL from Oracle, or Redis by way of Microsoft's Garnet. SpawnLoft installs what each engine needs.) / "Connect to one I already run" (A MySQL or Redis database you already run. Registered with its address so servers can be attached; never started or stopped from here.). Where unsupported: "Automatic database installation is not available in this preview. Connect to an existing MySQL or Redis database instead."
  - Name: placeholder "Database"; hint "The commands use `slug`".
  - Engine: MySQL (hint "MySQL 8.4 LTS; Windows x64, macOS 15+ or Linux x64") or Redis/Garnet (hint "Redis-compatible, by Microsoft"). The two engines come from `src/services.mjs:32`.
  - Version (run-here only): "Loading versions…", "8.4.x (LTS)", "No stable release listed", "Could not load versions" + raw error.
  - Port: "Blank picks 3306 or the next free one" / "Blank means 3306" (6379 for Redis).
  - Connect fields: "Host" 127.0.0.1 (Where it listens); "Admin user" root (Makes databases and users; hidden for Redis); "Password" (Password for the database account / Its requirepass, if it has one); "Client tools folder (optional)" placeholder "C:\xampp\mysql\bin" (Where the MySQL client tools live. Found on its own in the usual places.; hidden for Redis).
  - Button "Add database" / "Connect". Hints "The verified engine downloads once; databases using that version share the installation." / "It is asked to answer before it is saved, so a wrong address or password is refused now."
  - Toasts "Pick a version first.", "Connected to ID at host:port. Attach a server from its Settings tab.", "Added ID on port N. Start it, then attach a server from its Settings tab."

### Findings

**AD1. No Cancel once a create has started** | gap | medium | M
Paper is tens of megabytes, NeoForge "a few minutes", Spigot "five to ten minutes". The button is disabled and there is no way to stop. The tabs stay clickable and hide the progress bar when pressed.

Evidence: `:13135`, `:12939`.

Fix: turn the button into "Cancel" during the job and disable the tabs.

**AD2. A create that finishes while the user is elsewhere pulls them to the new server** | flow | medium | S
On success the code always calls `select(inst.name)`. Close the sheet (or press Escape) and open another server's settings, and the page switches away when the download ends.

Evidence: `:13180-13181`, `:13351-13352`, `:13108-13109`.

Fix: only navigate if the Add sheet is still showing; otherwise toast "NAME is ready" with "Open".

**AD3. After the first create, the line under the button is wrong for good** | bug | medium | S
Starting a create replaces "Accepts the Minecraft EULA on your behalf…" with "This can take a minute on a slow connection." Success never puts it back; failure blanks it. Every later create in that session runs without the EULA line.

Evidence: `:13136`, `:13169-13182`, `:13190`; restored only at `:13887-13889` after a version-list failure.

Fix: restore the hint in a `finally`.

**AD4. No Java warning when no Java is installed at all** | missing state | medium | S
The warning under the version is hidden when `info.have == null`, which is exactly the case of a machine with no Java. The user finds out after the download, in the "No Java here can run this version" dialog.

Evidence: `:13809`.

Fix: for null say "Minecraft X needs Java N, and none was found on this computer. Get Java N."

**AD5. Spigot and CraftBukkit: "This can take a minute" for a five-to-ten-minute build** | wrong expectation | medium | S
The software table marks them `slow: true` "so a ten-minute create doesn't read as a hang" (`src/software.mjs:51-52`), but the panel never reads that flag and shows the one-minute hint.

Evidence: `:13136`; no use of `slow` for software in `ui.html`.

Fix: use the flag for the hint and a confirm ("This builds Spigot on your computer and takes 5 to 10 minutes").

**AD6. Accepting the EULA is a grey hint, and only on one tab** | weak confirm | medium | S
The legal acceptance is a 12px hint beside the button with no link to the EULA. The modpack tab creates a server the same way and says nothing about it.

Evidence: `:3076`, `:3115`.

Fix: a line with a link ("By creating a server you accept the Minecraft EULA") on both tabs.

**AD7. Nine software choices with no steer** | clarity | medium | S
The list is in table order with no "recommended" mark. The explanation appears only for the selected option and uses words like "regionised multithreading", "Slime World Manager" and "JDK".

Evidence: `:13770-13777`; `src/software.mjs:9-90`.

Fix: "Paper (recommended)" first, a divider, then group as "Plugins", "Mods", "No add-ons", with one plain line each.

**AD8. Fields can be edited while the server is being created** | flow | low | S
Only the button is disabled. Changes typed during the download are ignored and then wiped by the reset.

Evidence: `:13135`, `:13173`.

Fix: disable the fieldset while busy.

**AD9. Progress is not announced and failure is not styled as failure** | accessibility | medium | S
The progress block has no `role="progressbar"` and its message is not a live region. On failure the error text is written into the same grey message line under an empty bar. The New tab also toasts; the Database tab does not (three forms, three behaviours).

Evidence: `:3069-3072`, `:13188`, `:13202`, `:13115`.

Fix: `role="status"` on the message, a `.bad` style on failure, and one pattern for all three. Extends F12.

**AD10. The summary line is a live region that re-announces on every keystroke** | accessibility | low | S
`#newSummary` is `aria-live="polite"` and is rebuilt on every `input` event anywhere in the form. It also leaves out the name.

Evidence: `:3073`, `:13038-13039`.

Fix: drop `aria-live`, or update it on `change` only.

**AD11. Memory can exceed what the computer has; a taken port is only caught by the server** | validation | medium | S
The page knows the machine's memory (Overview, `:4960`) and every other server's port (`state.rows`), but checks only the shape of the values.

Evidence: `:12829-12835`, `:13009-13015`.

Fix: warn "This computer has 8 GB" above about 75%; warn when the port belongs to another server. Extends F4.

**AD12. Old errors and values are still there when the sheet is reopened** | flow | low | S
`openAdd` does not clear the progress message or fields. A failed create's error is still showing next time. After a modpack create, the chosen pack and name are kept, and the name then reports "There is already a server called…".

Evidence: `:12848-12852`, `:13348-13353`.

Fix: reset the form on success and clear progress on open.

**AD13. Modpack: the name is filled with the pack's slug** | wording | low | S
Choosing a pack sets Name to the lower-case slug with dashes ("all-of-fabric-7"), and that becomes the display name.

Evidence: `:13299`, `:13342`.

Fix: fill with `hit.title`.

**AD14. Modpack results are thin, and the choice is not marked** | clarity / gap | medium | M
- Each row has a generic archive glyph and no pack icon, Minecraft version, loader or link to its page.
- Every row has a primary "Use this pack".
- After choosing, the list stays as it was with nothing highlighted, and the choice appears as plain text under a `<label>` that labels nothing.
- Nothing is shown before a search (no popular packs), there is no "more results", and no choice of pack version.
- An empty search does nothing.

Evidence: `:13272-13304`, `:3092-3093`, `:13243`.

Fix: show version and loader per row, mark the chosen row, collapse the list to "Change pack", and load popular packs on open.

**AD15. Modpack tab has no port and no "Who can join"** | consistency | low | S
Both are on the New tab. A pack server silently gets defaults. Evidence: `:3090-3117`.

**AD16. Empty required fields fail silently on two tabs** | missing error | low | S
On "Add one I already have", an empty folder or name only moves focus, with no message (`:13209-13210`). The same happens for the modpack name (`:13315`). The New and Database name fields use `required` and get the browser's bubble.

Fix: write "Choose the server's folder." / "Give it a name." under the field.

**AD17. Add existing: nothing is shown about the folder before it is added** | gap | medium | M
There is no preview (found Paper 1.20.4, world "world", port 25565), no warning if that server is running outside SpawnLoft, and no busy state on "Add server" beyond being disabled. Memory defaults to 4G whatever the server used before.

Evidence: `:13206-13230`.

Fix: after a folder is chosen, ask the core what it sees and show a one-line summary.

**AD18. "There is already a server called X" on the Database tab; database names are not checked** | wrong message | low | S
`checkName` compares against servers only and always says "server".

Evidence: `:12994-12995`, `:13003`.

Fix: pass the noun and the right list.

**AD19. Database versions: failure replaces the hint for good and has no "Try again"** | missing state | low | S
The raw error is written into the hint and never reset; the Paper version list has a retry button, this one does not.

Evidence: `:12933-12935`, compare `:13852-13856`.

Fix: same pattern as the version field.

**AD20. "Connect" shows no progress while it tests the connection** | missing feedback | low | S
The hint says the database "is asked to answer before it is saved"; during that the button is only disabled.

Evidence: `:13046-13067`.

Fix: `busy(button, true, 'Checking…')`.

**AD21. A new database needs two more manual steps** | flow | medium | M
The success toast says "Start it, then attach a server from its Settings tab." It is a five-second toast (extends A2) and the user is left on the database page with neither action offered.

Evidence: `:13110`, `:13063`.

Fix: start it automatically, and add "Use with:" (a server picker) to the form or a persistent "Attach a server" button on arrival.

**AD22. Database tab wording** | wording | medium | S
"supervised like a server", "by way of Microsoft's Garnet", "Registered with its address", "requirepass", "The verified engine", "Client tools folder", "Makes databases and users", and a Windows path as the placeholder on every platform.

Evidence: `:3150-3164`, `:12898`, `:12905`, `:3208-3210`.

Fix: "Most plugins that ask for MySQL work with this." and plain field hints; platform placeholder. Extends C3 and C4.

**AD23. Unavailable engines are greyed with no reason** | missing state | low | S
On a platform without managed MySQL the option is disabled in the list and the form silently switches to the other engine.

Evidence: `:12886-12889`.

Fix: a hint "MySQL cannot be installed automatically on this computer. Connect to one you already run."

**AD24. The mode choice has no group label** | accessibility | low | S
"Who can join" is a labelled `radiogroup`; the run/connect choice is a bare `div`.

Evidence: `:3155` vs `:3053`.

**AD25. Field rows in a 600px column** | scaling | low | S (estimate, not rendered)
Four fields share a row at flex 1:2:1:1 (New) and 2:1:2:3 (Connect) inside a 640px sheet body. "Admin user" gets about 75px, so its hint "Makes databases and users" wraps to three lines. The page is no wider at 2560.

Evidence: `:3022-3049`, `:3191-3211`, `:2441`. Related to I2.

### Keep
- A name can be anything; the folder name is derived and shown live (`:12950-12988`).
- The version list offers "Try again" and "Add an existing server instead" when offline.
- "· Java N" is shown per version.
- The summary line reads back what Create will make.
- "Create anyway" on the Java refusal.
- The connect mode tests the connection before saving.
- Focus goes to the first field on open and back to the opener on close.

---

## 8. Preferences (`#vSettings`) and Feedback (`#vFeedback`)

### Inventory

- Head "Preferences"; "Close".
- **Appearance** (`:3267-3293`)
  - "Choose your colors. Your selection is saved on this PC and applies immediately."
  - "Classic — The original blue palette"; "SpawnLoft — Charcoal, warm white, and lime".
  - Status "Saving appearance…", "Classic theme saved.", "Could not save your theme: …"; toast "Appearance was not saved. Your previous theme has been restored."
  - "Interface size" (app only): "Auto fits the screen. Ctrl and + or -, Ctrl 0 for 100%."; options "Auto (125%)", 80% to 200%.
- **Where SpawnLoft keeps things** (`:3294-3302`, `:13457-13496`)
  - "Servers that already exist keep their own folders — the registry stores absolute paths, so changing this only affects servers created from now on."
  - Rows "Data folder", "Servers" (+ "(separate drive)"), "Server jars", "Backups", "Templates", "Settings file"; failure row "Locations — Could not read them from the core."
  - App: "Change the data folder…" with dialog "Change the data folder?" — "SpawnLoft restarts to pick up the new location. Servers that already exist stay exactly where they are — only new ones land in the new folder, and anything running keeps running." Button "Choose a folder".
  - Browser: "To move these, run: spawnloft config set-root <path>".
- **Updates** (2.x core; `:3303-3335`, `:14126-14277`)
  - Summary "SpawnLoft X, stable releases. Last checked: DATE." (+ " The update list is older than expected, so a newer release may exist.")
  - Offer "SpawnLoft X is available" / "…is ready to reinstall" + " - downloaded and verified, ready to install." / " - verified; it downloads when you install."; "What changed"; "Install and restart" / "Reinstall and restart" / "Installing...".
  - Dialog "Update to SpawnLoft X?" / "Reinstall SpawnLoft X?" — "SpawnLoft closes, swaps itself for that version and reopens. Servers keep running; they are separate processes." Button "Restart and update".
  - Message "The window is installing this. SpawnLoft will restart in a moment."
  - Hold "Updates to SpawnLoft X and newer are paused because you went back to an older version." + "Resume updates".
  - "Check now" / "Checking..."; results "A newer release exists but cannot be installed here: REASON." / "The update feed could not be read (REASON). Check your connection and try again." / "SpawnLoft X is the newest stable release."; toast "Update check failed: …".
  - "Get beta builds" switch with hint; message "The next check will use the beta channel."
  - "Reinstall a previous version": "Going back pauses updates below the version you left until you resume them here. A version that cannot read your servers' data is not offered."; "Loading..."; rows VERSION + "Reinstall" (+ "This version cannot read your data."); "No older version is available."; "Could not list versions: …". Dialog "Go back to SpawnLoft X?" — "SpawnLoft restarts on that version and stops offering newer ones until you resume updates here." Button "Reinstall". Toast "Reinstalling X. SpawnLoft will restart."
  - "Update log" (raw lines / "Nothing logged yet.").
- **Updates** (older app; `:3336-3351`): "Get beta builds" with a different hint; status "You get the monthly releases." / "The next check will offer the newest beta." / "You are on a beta and will get each new one, then the release itself when it ships." / "You will stay on this beta build. Betas stop, and SpawnLoft X installs when it is released. Nothing is downgraded."; toast "Could not save that choice."
- **Game client** (`:3352-3356`, `:13592-13630`): "Profiles for the real Minecraft client, launched pointed at one of your servers. Create profiles with `spawnloft client new`."; "No profiles — spawnloft client new <name> --mc 1.21.11"; rows "NAME — Minecraft X, loader, harness · running/stopped" + "Launch" / "Stop".
- **AI assistants** (`:3357-3383`): intro; switch "Allow restoring backups, force-kill and Minecraft version upgrades" (Off, the assistant is never offered them. On, each still describes what it would do and waits to be confirmed.); switch "Show players' IP addresses" (The console records one each time someone joins. Hidden unless this is on.); two read-only boxes; "Copy Claude Desktop config", "Copy Claude Code command"; toasts "Copied the Claude Desktop configuration." / "Copied the Claude Code command."
- **About** (`:13503-13526`): "Panel — Local only — bound to 127.0.0.1"; older app only: "Version", "Build"; Mac: "Mac support", "Updates".
- **Feedback**: "A bug report with the diagnostics already filled in, a question, or an idea. Each opens GitHub in your browser; nothing is sent from here on its own." + "Send feedback…".
- **Reporting a problem**: "Copies the version, the Java found, where things live, every server's status, the panel's own log and the last console lines of the selected server. No passwords and no webhook. Paste it into a GitHub issue." + "Copy diagnostics"; toasts "Diagnostics copied. Paste them into your bug report." / "Could not copy diagnostics: …".
- **Feedback sheet** (`:3225-3257`, `:13671-13718`): "Feedback"; "Close"; "SpawnLoft is in beta and reports are read. Every door opens GitHub in your browser; nothing is sent from here on its own."
  - "Something broke" — "Opens a bug report with the version, Java, server status and the panel log already filled in, and puts the full diagnostics on your clipboard to paste under it. No passwords, no webhook."
  - "A question" — "Opens a new post in the project's Q&A. How something works, whether it can do a thing, why a server will not start. Answers stay findable for the next person."
  - "An idea" — "Opens a new post in Ideas. A feature you wish it had, a server kind it should support. Say what you were trying to do, not only what to add."
  - Note "A bug report will include the last console lines of ID." / "Select a server first if the problem is about one - its console lines go into the report."
  - Toasts "Bug report opened in your browser. The full diagnostics are on your clipboard - paste them in.", "Bug report opened in your browser.", "Could not gather diagnostics: …", "This build does not know where its project lives, so it cannot open a report."

### Findings

**PR1. Opening Preferences or Feedback does not move focus into it** | accessibility | medium | S
The Add sheet focuses its first field. Preferences leaves focus on the gear in the header, with the whole sidebar between it and the sheet in Tab order. Feedback is opened by a button that is then hidden, so focus falls to the page body.

Evidence: `:13652`, `:13699-13705`, `:3931-3937`; compare `:12851`.

Fix: focus the sheet's `h1` (tabindex -1) or its Close button on open.

**PR2. The two AI-assistant switches look like settings but only edit the text below** | clarity | high | S
"Allow restoring backups, force-kill and Minecraft version upgrades" and "Show players' IP addresses" are styled as live switches with "Off… On…" hints. They save nothing; they add two flags to the snippet in the box. They also start Off every time, whatever the assistant is really configured with. A user who flips one and closes the page has changed nothing; a user who sees "Off" may wrongly believe destructive actions are blocked.

Evidence: `:13640-13646`, `:13572-13576`.

Fix: label them as options for the snippet ("Include in the setup text:") with "Copy again and update the app after changing these", or store the permission in SpawnLoft where it can be enforced and shown truthfully.

**PR3. "Change the data folder" confirms before the folder is known, then restarts with no second look** | weak confirm | medium | S
The dialog's button is "Choose a folder". After the picker, the setting is saved and SpawnLoft restarts at once, with no "Move to D:\X and restart?" step. It does not say what happens to existing backups, downloaded jars and templates. A thrown error is not caught.

Evidence: `:13478-13489`.

Fix: pick first, then confirm with the chosen path and a plain list of what moves and what stays.

**PR4. "Could not read them from the core" is permanent until reload** | missing error state | low | S
Locations are fetched once at start-up. If that failed, Preferences shows the failure row every time with no retry; they also go stale.

Evidence: `:13443-13449`, `:14367`, `:13464`.

Fix: fetch on open; show "Try again". Extends C3 ("the core").

**PR5. Folder paths cannot be opened or copied** | gap | low | S
Six paths as text. No "Open" or "Copy" beside any, although Open folder exists for servers.

Evidence: `:13465-13471`.

**PR6. The update offer has no styling** | hierarchy | medium | S
`.upd-offer` has no CSS rule in the file. "SpawnLoft X is available", the most important line in the section, is plain body text followed by a default (non-primary) button, in the same weight as the summary above it. The hold notice is the same.

Evidence: `:3306-3307`, `:14139-14154`.

Fix: a notice-style box with a primary "Install and restart".

**PR7. Update wording and dots** | wording / consistency | low | S
- Button "Install and restart" vs dialog button "Restart and update".
- "The window is installing this."
- "The update feed could not be read (reason)".
- Raw channel names ("stable", "beta channel").
- " - downloaded and verified" with a hyphen as a dash.
- "Checking...", "Installing...", "Loading..." with three dots.
- Two different hints for the same "Get beta builds" switch.
- "Reinstall" for going back to an older version, as a non-danger button.
- "Update log" shows raw log lines.

Evidence: `:14143-14169`, `:14129-14130`, `:3316-3320` vs `:3343-3346`, `:14203-14210`.

Fix: one verb ("Update and restart"), "Go back to X", "…", and move the log behind "Show details for a bug report". Extends C3 and C6.

**PR8. Update results are not announced** | accessibility | low | S
`#updMsg`, `#updSummary` and the offer box are not live regions. Evidence: `:3305-3308`.

**PR9. "Ctrl" is shown on a Mac** | platform | low | S
"Auto fits the screen. Ctrl and + or -, Ctrl 0 for 100%." The shell accepts Cmd as well, and the page knows its platform.

Evidence: `:3285`; `rust/crates/spawnloft-shell/src/bridge.js:64-66`.

Fix: "⌘" on darwin. Extends C4.

**PR10. Heading sizes are uneven** | hierarchy | low | S
"Appearance" is a 16px display-face legend. Every other section title ("Updates", "AI assistants", "About"…) is a 13px `h2`, the same size as body text.

Evidence: `:276` vs `:2443`.

Fix: one section-title style (`--type-section`).

**PR11. AI assistants: jargon and one vendor only** | wording | low | S
"an AI app that supports MCP", "`claude_desktop_config.json` (Settings → Developer → Edit Config)", "run this in a terminal". "force-kill" appears here although the panel itself has no force stop (A6). The section vanishes silently if `/api/mcp` fails.

Evidence: `:3359-3378`, `:13635-13637`.

Fix: collapse behind "Set up" (as D1 suggests), plain intro, and a "could not load" line.

**PR12. "Copy diagnostics" has no fallback when the clipboard is refused** | missing error state | low | S
The comment promises "a prompt with the text selected"; the code only toasts the raw error and the gathered text is lost. The bug-report door has the same gap but hides it.

Evidence: `:13720-13737`, `:13686-13692`.

Fix: show the text in a dialog with a selected textarea.

**PR13. Feedback: "A question" and "An idea" can do nothing** | missing feedback | low | S
If the core returns no link for that category, the click is ignored with no message. There is no busy state while the link is fetched and no confirmation toast, unlike the bug door.

Evidence: `:13709-13717`.

Fix: toast "Opened in your browser" or the same "does not know where its project lives" message.

**PR14. Feedback assumes a GitHub account and silently replaces the clipboard** | clarity | medium | S
Nothing says a GitHub account is needed. The bug door overwrites whatever the user had copied; this is mentioned in the door's description but not at the moment it happens. The note uses the folder id and, when no server is selected, says "Select a server first", which means closing two sheets.

Evidence: `:13688`, `:13701-13703`, `:3233-3241`.

Fix: "You will need a free GitHub account." and a server picker on the sheet. Extends D3 and C6.

**PR15. "This build does not know where its project lives"** | wording | low | S

Evidence: `:13683`. Fix: "This copy of SpawnLoft has no report address. Use Copy diagnostics instead."

**PR16. Game client section: internal words** | wording | low | S
"harness", loader ids, lower-case "running/stopped", and "Launch" here against "Play" everywhere else. A server card's toast sends people here ("Stop it under Preferences › Game client", `:6061`), so this stale section is a required stop.

Evidence: `:13607-13609`.

Fix: move Stop to the Play page and remove the section. Extends D4 and C1.

**PR17. About has no links, and no version in the 2.x app** | gap | medium | S
There is no website, licence, changelog or documentation link. In the Tauri app the Version and Build rows never render (see PG1), so a user asked "which version are you on?" has to read the Updates summary sentence.

Evidence: `:13503-13526`.

**PR18. gap: preferences a desktop app owner would expect** | gap | low | L
None of these exist:
- Start SpawnLoft when the computer starts; start chosen servers with it.
- Notifications (crash, backup failed).
- Defaults for new servers (memory, software).
- A Java section listing what was found, with "Get Java" (Java is only a header chip).
- Language.
- "Check for updates automatically".

**PR19. A long page with no index** | scaling | low | M
Up to nine sections in one 840px column with small headings and no in-page navigation. At 2560+ the column is centred while "Close" is at the far right edge.

Evidence: `:2442`, `:2437`. Related to I2 and D2.

### Keep
- Theme applies at once, reverts on failure and says so.
- "Auto (125%)" names the size it picked.
- The beta switch says exactly what turning it off does.
- Rollback refuses versions that cannot read the data and says why.
- The AI section says plainly what leaves the machine.
- Feedback gives each kind of message its own door and promises nothing is sent on its own.
- Closing Feedback returns to Preferences with focus on the opener (`:3929-3957`).
