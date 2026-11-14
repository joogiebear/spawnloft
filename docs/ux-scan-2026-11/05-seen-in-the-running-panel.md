# Page by page, part 5: what was seen in the running panel

Part of the [UX scan](../ux-scan-2026-11.md). Parts 1 to 4 were written from the code. This part is what
was seen with the panel actually running: about 360 states were opened and screenshotted, and their text
was captured.

## How it was run

Two worlds, both on Linux in a cloud machine, both using the real panel code from `v2` at `552082d`:

- **Plain world.** Three servers and one database, no internet. Used for the offline and error states,
  the sign-in pages, lost contact, the empty first state and the first-run wizard page.
- **Rich world.** Five servers (Paper running with three players online, Paper stopped with six backups,
  Paper crashed, Fabric running, Advanced Slime Paper stopped), a MySQL-compatible database, a Redis
  database and an external Redis, thirteen plugins with four updates waiting, scheduled tasks with run
  history, bans, operators and a whitelist. The servers were stand-in programs that print a real Paper or
  Fabric log and answer RCON. Modrinth, Hangar, Paper, Mojang and the other download services were
  answered from fixtures, so search, updates, version lists and creating a server all worked.

Window sizes: 800, 1100, 1440 and 2560 wide. Both themes at 1440.

What this does not cover, and should be checked on real hardware:

- The real desktop window on Windows and macOS. Everything here was a browser on Linux.
- A real Minecraft server and a real game client. The launcher states were produced by answering the
  launcher's own requests with fixtures (27 states), so they show the real page with made-up data.
- Real MySQL. The database was the repo's own test engine.
- A screen reader. Accessibility findings in parts 1 to 4 are from the markup.

Screenshots are in the project files under `ux-scan-2026-11-14/shots2/` (names in brackets below).

## New findings from running it

These were not found by reading. Ids are LV1 to LV25. Format as in the other parts.

### Across the panel

**LV1. Pressing "Crash reports", "Open folder" or "Open in your file manager" can stop the whole panel** | error state | high | S

On a Linux machine with no `xdg-open` (any server reached over SSH, many minimal installs), pressing any
button that opens a folder ends the panel process. Every page then shows "Failed to fetch" and, after a
while, "Lost contact". The servers keep running, but the panel is gone until it is started again. It
happened twice in this scan: once from "Crash reports" on a crashed server, once from a database's
"Manage this database…" dialog, where "Open its folder" is the preselected choice and "Continue" runs it.

Evidence: `src/manage.mjs:216-220`. The `spawn` call is wrapped in `try`, but a missing program is
reported later through the child's `error` event, which has no listener, so Node exits. Entry points:
`#moreMenu` "Open folder", Files "Open in your file manager", the crash finding's "Crash reports", the
crash-report row's "Open folder", the database Manage dialog.

Fix: add an `error` listener and answer with a plain message ("This computer has no file manager to open.
The folder is at …" with a Copy button). On a machine with no display, hide these buttons and show the
path instead, as `panel-open.mjs` `canOpen()` already decides for the browser.

**LV2. Backups says "Automatic backups off. Nothing backs this server up unless you do it by hand." while a scheduled backup exists and has run** | wrong state | high | S

The running server had a Schedule task "Weekly world backup" that had already made a backup (the row
`scheduled_standard_…` was in the History list on the same page). The strip at the top of Backups still
said automatic backups were off, offered "Turn on nightly backups", and the Overview card said
"No schedule · Set up backups". Only the task made by the Backups page's own switch counts. Extends B4.
[srv-backups]

Fix: count any enabled task that takes a backup. Say "Backed up by the task Weekly world backup, every
Sunday at 04:00" with a link to Schedule.

**LV3. A missing plugin dependency is reported as `A plugin needs "Unknown"`** | wrong data | medium | S

The crashed server's log had Paper's own line `UnknownDependencyException: Unknown/missing dependency
plugins: [ProtocolLib]`. The finding strip said: `A plugin needs "Unknown", which is not installed.` The
pattern expects the older wording and picks up the word "Unknown" as the plugin name. [mg-crashed]

Evidence: `src/diagnose.mjs:57`.

Fix: read the names inside the square brackets; name the plugin that wants them too (the same log line
ends "to run 'X'"). Offer "Find ProtocolLib" that opens Plugins with the search filled in.

**LV4. The console fills with "Thread RCON Client /127.0.0.1 started" and "shutting down"** | clarity | medium | S

Each time SpawnLoft asks the server for players and TPS, the server logs a pair of lines. In ten minutes
the running server's console was mostly these, with chat and warnings scattered between. [srv-players-w]
The stand-in server prints what Paper prints for an RCON connection; worth confirming the volume on a
real server.

Fix: hide these two lines by default with a small "SpawnLoft's own checks hidden · Show" note, or keep
one connection open instead of reconnecting.

**LV5. Selecting everything in a server's folder and pressing Delete asks only "Delete 14 items?"** | weak confirm | medium | S

Select all on the top folder, then Delete: the dialog is "Delete 14 items? A copy is kept first, so
Backups can put them back." with one red Delete button, no names and nothing to type. That removes the world, the server jar and
server.properties. A copy does go to Backups first, a selection over 1 GB gets a second, typed confirm
(`src/ui.html:9781-9788`), and files in use are protected while the server runs, so this is about a
stopped server with a small world. Elsewhere the mild choice "Remove from SpawnLoft, keep the files" needs the server's
id typed. [files-select-all, files-bulk-delete]

Fix: when the selection includes the active world or the server jar, name them and ask for a typed
confirm; otherwise list the first few names.

**LV6. "New file" with an empty name closes the dialog and says nothing** | missing error | low | S

Create with nothing typed closes the dialog; no file, no message. Same for "New folder". [files-new-file-empty]

Fix: keep Create disabled until there is a name.

### Overview

**LV7. "3 databases" in the summary, one card under Databases** | clarity | medium | S

At 2560 wide the Databases section showed only Main MySQL. Redis cache and the external Redis appear only
inside the cards of the servers that use them. A database used by two servers is shown a third way, as
the text "Shared database Main MySQL" inside each server card. Someone looking for Redis under Databases
does not find it. [overview-w]

Fix: list every database under Databases; keep a one-line link in the server card ("Uses Redis cache").

**LV8. Server cards are uneven and leave holes** | hierarchy | low | M

A stopped server's card is the same height as a running one, so half of it is empty. With five servers at
2560 wide the grid is three columns with an empty slot beside two cards. [overview, overview-w]

Fix: let stopped cards be compact rows, or fill the stopped card with something useful (last played, last
backup, world size).

**LV9. "24 of 16 GB reserved" is shown only as a red bar** | accessibility | medium | S

Confirms OV13 on screen. Nothing says in words that the servers are set to use more memory than the
computer has, or what to do about it. [overview]

### Server header and sidebar

**LV10. In the icon rail on a short window, the last tools are hidden** | scaling | medium | S

At 1100 by 720 the rail shows the five servers, then tools down to Stats. Schedule and Settings are under
the "New server" and "Play" buttons with no sign that there is more. [srv-backups-n]

Fix: let the rail scroll with a fade at the edge, or collapse the server list when a server is open.

**LV11. At 800 wide the TPS figure disappears** | scaling | low | S

Players, Memory and Last backup stay; TPS is dropped without a trace. [srv-plugins-xs]

**LV12. Beside a tool at 2560 wide, the console toolbar wraps** | scaling | low | S

"Share log" drops to a second row under the filter. [srv-players-w]

### Players

**LV13. While the server runs, every row has a greyed "Delete data" button** | hierarchy | low | S

Eight rows, eight dead red buttons, the reason only on hover. Confirms PLY15 and PLY16. [srv-players]

Fix: hide it while running and say once above the list "Deleting a player's data needs the server
stopped."

**LV14. The same action gives two different messages** | consistency | low | S

Make op on a running server: "Made Alex a server operator" (the server's own reply). On a stopped server:
"Alex is now an operator." Unban: "Unbanned Herobrine_" against "… is unbanned." Confirms the path behind
PLY4.

### Schedule

**LV15. "Recent runs" shows an internal id and a full file path** | wording | low | S

`Nov 14, 1:02 AM  survival-backup  /tmp/…/backups/survival/scheduled_standard_2026-11-14_010230.tar.gz (1.9 MB)`.
Confirms SCH20. The task that is switched off is listed first and dimmed, buttons included (SCH18). An
empty command gives the toast "a command is required" (SCH6). [srv-scheduler]

### Stats

**LV16. Charts have no scale** | clarity | low | S

No time marks along the bottom and no values up the side; on a quiet server Processor and Memory are a
flat line on the floor of an empty box. Three boxes leave a fourth cell empty at 1440. [srv-performance]

Fix: label the left and right ends ("5 min ago", "now") and the top value.

### Add a server

**LV17. A version that needs Java 8 can be chosen with only Java 21 and 25 installed, with no warning** | missing state | medium | S

The list says "1.8.8 · Java 8". Choosing it showed no Java note; the summary read "Creates Paper 1.8.8".
Whether that server would start on Java 25 was not tested. Memory "64G" and a port already used by
another server were also accepted without a word (confirms AD11). [add-old-version]

**LV18. The "created" message names the folder, not the server** | wording | low | S

"Created Test-world on port 25570." for a server named "Test world". The Edit dialog does the same:
renaming gave "Renamed to 99999." where 99999 was the new folder id. Extends A10.

**LV19. Choosing a modpack can show a raw program error** | error state | low | S

After "Use this pack" the form showed "could not reach Modrinth: Cannot read properties of undefined
(reading 'replace')". The cause here was an answer from the stand-in service that the code did not
expect, so this exact case may not happen with the real Modrinth; the point is that an unexpected answer
is reported as "could not reach" plus an internal error. [add-pack-chosen]

### Databases

**LV20. For Redis, the page describes MySQL** | wording | low | S

Under "Attached servers" a Redis database says "Each has a database and a user named after it." Redis
has neither; the row beneath says "key prefix survival:". Detaching a server from Redis asks "The user
goes away… Drop the database too: Every table this server had on it goes." (confirms SET21). [rd-settings,
set-db-detach]

### Launcher (stand-in data)

**LV21. Internal words on the Play screen** | wording | medium | S

Seen in the 27 launcher states: "pid 48211" and a full folder path on the running card; "harness not
published"; "Let SpawnLoft see the game"; "online-mode=false"; "The profile name
the command line uses". The Join list leads with folder ids: "creative (Creative Build)". Adds examples
to LA3 and LA4. (Two further messages in the screenshots, about a "launcher rule" and setting Java to
"mojang", were made-up text in the stand-in data; the real ones are in `src/client-version.mjs:119-127`.) [launcher sheets]

**LV22. The setup sheet is taller than the window** | scaling | medium | S

At 1100 by 820 the edit sheet with Advanced open runs to the bottom edge, and the "Remove 26.2 · Fabric?"
row with its tick box sits half off the window. The launcher window opens at 1040 by 640. Whether the
sheet scrolls there was not checked. [launcher sheets]

### First run and sign-in

**LV23. The first-run wizard opened in a browser shows a form that cannot work** | missing state | low | S

In the desktop build's panel, `/setup` in a browser draws the whole wizard, then a red box "This screen
is part of the SpawnLoft desktop app and cannot run in a browser." "Checking for Java…" never finishes
and Continue stays off. [setup]

Fix: show only the message, with "Open the panel" as the way on.

**LV24. A warning chip before there is anything to warn about** | hierarchy | low | S

With no servers at all, the top bar already shows an amber "Java 25" chip. [empty]

**LV25. Sign-in, session ended and lost contact** | missing state | high | M

Seen as described in H4 and SI1: a bare "Sign in to this panel" page with no button for a used
or expired link; a "session has ended" box with no button and the lost-contact banner still showing
behind it; and after contact is lost, about 15 seconds in which every button still works and fails with
"Failed to fetch". [signin-page, session-ended, lost-contact-start]

## Findings from parts 1 to 4 that were confirmed on screen

Forty-nine ids, twelve of them high. This is what happened to be reachable in the test worlds, not a
check of every high finding: about thirty high findings in parts 1 to 4 could not be tried here (most
need Windows, the desktop window, a real game client or a failure that is hard to stage).

| Id | What was seen |
|---|---|
| X1 | With Plugins open on a stopped server, pressing Start left "Applies the next time the server starts." With Worlds open, "Set active" and "Delete" stayed enabled on a running server. |
| PLY3 | With Players open on a running server, pressing Stop left "Changes go through the running server's console…", also after closing and reopening the tool. |
| SET1 | Changing only "Restart it automatically" on a running server showed "1 unsaved change · Take effect when … next starts." with "Save and restart". |
| SET5, F2 | "0 unsaved changes" with a blue Save after any section change, on every server. |
| SET8 | Difficulty and game mode choices are lower-case file values. |
| SET19 | After "Update to build 131" the toast was "Now on paper-1.21.11-131.jar." and the check result vanished. |
| SET21, SET24 | Detach wording as quoted; the credentials dialog shows the password in clear at once and "Copy" closes it. Its title is "survival on cache". |
| DB1, HD1 | External database: "Forget this database", Continue, then "Delete shared-redis?" with "Delete the data as well · Every database and table on it goes." |
| DB2 | The menu hint promises rename and credentials; the dialog offers "Open its folder" and, when stopped, "Delete this database". |
| DB3 | After "Show", the copy button for the admin password is labelled "Copy password" followed by the password, and its tooltip is "Copy" followed by the password. |
| DB16 | "Shows the data folder in Explorer." on Linux. |
| DB20 | External database: Memory "—", Stats permanently "Nothing recorded… while the server runs". |
| DBB3 | Database backup rows show "survival, creative" then "Manual"; file name hidden in the row and used in every message. |
| BK4, BK5 | After installing twelve plugins, History (13) was eleven "Plugins" rows named `pre-install_plugins_…` and two real backups. |
| BK7 | Restore opens with "Put it back over what is there … Not undoable" selected. |
| BK16 | Restore dialog date "11/13/2026, 11:07:16 PM"; lists say "Nov 14, 1:02 AM"; presets say "03:00". |
| BK20 | "SIZE" header sits to the left of the right-aligned sizes. |
| BK15, SCH23 | "Held by systemd… unless lingering is on for your account (loginctl enable-linger)." |
| WO1 | Delete dialog: "only the ACTIVE world is ever included in snapshots". |
| WO2 | Export: the only trace is the toast "Exported to /…/backups/survival/exports/spawn_lobby_….zip (195.2 KB)." |
| WO9 | Empty import: red sticky toast "A source and a name are both needed." |
| PL3 | After installing one search result, the query and results were gone. |
| PL10 | Offline, with only hand-added plugins: "Everything SpawnLoft installed is already the newest build." |
| PL12 | "Nothing on Modrinth or Hangar matches that for 26.2." |
| PL13, PL15 | Every result has a primary Install; update buttons read "→ 23.1". |
| PL16 | "Updated CoreProtect to 23.1. A plugins snapshot was taken first." |
| FI3 | Ticking a box inserts the selection bar and moves the list down by 78px. |
| FI4 | Multi-select offers Zip, Delete, Clear only. |
| ACT10 | Assistant filter, nothing there: "Nothing from them yet." |
| ACT16, STA10 | On a database: "What was done to this server…", "Processor and memory while the server runs". |
| PLY10 | Rows lead with the full id at 1440. |
| OV5 | "It stopped on its own at 01:02 AM." beside "1:02 AM" in the feed. |
| SB1, SB2 | In the icon rail all five servers are the same glyph; player counts are bare numbers. |
| HD2 | Finding text on screen: "Install it from the Plugins tab", a full path to crash-reports. |
| HD10 | Type-to-confirm asks for the folder id: "TYPE survival TO CONFIRM", "Upgrade survival to Minecraft 26.3?". |
| AD6 | The EULA line is a grey hint beside "Create server". |
| AD22 | Database tab wording as quoted, including "Its requirepass, if it has one". |
| PR2, D1, D2 | Preferences as described: read-only paths with a terminal command, two switches above two unstyled light text boxes. |
| A1 | Raw errors seen in this pass: "Failed to fetch", "could not reach Modrinth: getaddrinfo ENOTFOUND api.modrinth.com", "could not reach the PaperMC API: fetch failed", "directory not found: /nonexistent/place", "could not reach 10.9.9.9:6379: connect ECONNREFUSED 10.9.9.9:6379", "a command is required". |

## Findings from parts 1 to 4 that turned out wrong

Two were removed after looking: "the tool title and the pane title both show" for Stats and for database
Settings. Only one title is drawn.

## Things that looked good running

- Overview at 1440 and 2560 reads at a glance: counts, one red card for the crash, state on every card.
- The running server header: players, TPS, memory and last backup in one line, with bars.
- The console with warnings and errors tinted and counted, the filter, and "Nothing matches. Clear the
  search or the level filter to see the rest."
- The crashed server: a plain-language cause, the crash report and buttons to the right place.
- The Add a server form: live summary line, inline checks for memory and port, the version list with
  the Java each needs.
- The Settings validation line "Use a whole number from 1 to 1000." with "Fix the field marked in red
  to save."
- Players at 2560: a calm table with pills and short ids.
- The launcher's blocked states each say what is wrong and link to the fix ("Sign in again or pick
  another account").
- The plugin delete dialog, which explains that a hand-added jar cannot be downloaded again.
