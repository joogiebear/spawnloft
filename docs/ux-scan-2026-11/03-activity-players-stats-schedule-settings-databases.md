# Page by page, part 3: Activity, Players, Stats, Schedule, server Settings, database pages

Part of the [UX scan](../ux-scan-2026-11.md). Each page has an **Inventory** (every control, menu, dialog, message and state, with its wording and where it is in the code), **Findings**, and **Keep** (what already works and should not be lost).

Findings read: **id. title** | kind | severity | size (S is small, a few hours at most; M is about a day; L is several days or needs a design decision first). Everything in this part was confirmed by reading the code at `552082d`; line numbers are `src/ui.html` unless another file is named. Findings that were also seen in the running panel are listed in [part 5](05-seen-in-the-running-panel.md). "extends A2" and similar point at the [first pass](first-pass.md). "unverified" marks a consequence that could not be observed.

---

## 1. Activity

### Inventory
- Entry: dock button "Activity" `:2771`; rendered by `renderActivity` `:10129`; also used unchanged for databases (`DB_TOOLS` `:3803`).
- Head: title "Activity", subtitle "What was done to this server and who did it: you, a schedule, an AI assistant, or SpawnLoft itself." `:10147`
- Filters (`role=group`, `aria-label="Show"`): "All", "You", "Schedule", "Assistant" `:10095`, `:10150`. No SpawnLoft filter (deliberate, comment `:10093`).
- States
  - Loading: skeleton `paneLoading` `:10133`.
  - Error: `paneError` with the raw message and "Retry" `:10142`.
  - Empty, no filter: "Nothing yet. Starts and stops, backups, edits and anything an assistant or a schedule does will show here." `:10167`
  - Empty, filtered: "Nothing from them yet." `:10166`
- List
  - Day headings (`h3.act-day`): "Today", "Yesterday", else weekday, short month, day `:10118`.
  - Row: icon, sentence, actor chip, clock time (title holds the full date), optional Undo `:5386`.
  - Run of the same thing within 30 minutes collapses into a `<details>` `:5269`, `:5433`.
  - Failed entries: pill "Failed" or "Crash" plus red text `:5405`, `:1700`.
- Actor chips `:10098`: "You"; "You, in a terminal"; assistant name or "AI assistant" (title "An AI assistant, through SpawnLoft's MCP tools"); "Schedule: <name>" or "A schedule"; "SpawnLoft" (title "SpawnLoft itself - crash guard, or something it did on its own").
- Entry wording, single (`ACTIVITY_TEXT` `:10077`, bare forms `:5296`), then what the server puts after it:
  - start "Started" (failed start: detail is the reason, `supervisor.mjs:85`); stop "Stopped"; kill "Forced to stop"; crash: the detail, capitalised `:5311`.
  - command "Ran <line>" / "Ran a command".
  - backup "Backed up <scope> (<label>), <size>" (`backup.mjs:355`); database: "<dbs> as SQL, <size>" (`services.mjs:462`).
  - restore "Restored a backup <file>, cleared first; how it was is kept as <file>" (`backup.mjs:499`).
  - backup-delete "Deleted a backup <file>"; backup-prune "Cleared old backups <n> old snapshots removed, keeping <k>" (`backup.mjs:658`); backup-lock "Locked the backup"; backup-unlock "Unlocked the backup"; backup-note "Noted the backup <file>: <note | (note removed)>".
  - file-edit "Edited"; file-create "Created"; folder-create "Made a folder"; file-upload "Uploaded"; file-replace "Replaced <path> (<size>)"; file-move "Moved <a> to <b>"; file-delete "Deleted <paths> (no copy kept)"; file-zip "Zipped"; file-unzip "Unzipped <a> into <b>".
  - config-edit "Changed <file>"; config-create "Created"; undo "Put back <files>".
  - settings "Changed settings" + `key = value, …` (`ui.mjs:564`, `:2092`), or "server icon changed/removed", "backups leave out …".
  - plugin-install "Installed"; plugin-update "Updated <a> to <b>"; plugin-enable "Turned on"; plugin-disable "Turned off"; plugin-remove "Removed".
  - upgrade "Changed the server software <old.jar> to <new.jar>" (`upgrade.mjs:158`).
  - world-activate "Switched to the world"; world-import "Imported the world"; world-delete "Deleted the world".
  - player-op "Made an operator"; player-deop "Took operator from"; player-ban "Banned <name>: <reason>"; player-unban "Unbanned"; player-forget "Forgot the player".
  - schedule-add "Scheduled <name>: <action type>" (`schedule.mjs:346`); schedule-change "Changed the schedule"; schedule-enable "Turned on the schedule"; schedule-disable "Paused the schedule"; schedule-remove "Removed the schedule"; schedule-run "Ran the schedule now".
  - create "Created this server <jar>"; adopt "Added this server from <folder>"; rename "Renamed from <old>"; rebuild "Reset fresh worlds, plugins kept"; delete "Deleted this server unregistered, files kept" (`manage.mjs:196`).
- Entry wording, runs (`ACTIVITY_MANY` `:5282`): "Made {n} backups", "Deleted {n} backups", "Cleared old backups {n} times", "Locked/Unlocked {n} backups", "Restored {n} backups", "Started/Stopped {n} times", "Forced to stop {n} times", "Crashed {n} times", "Ran {n} commands", "Edited/Created/Uploaded/Deleted/Moved {n} files", "Changed {n} config files", "Installed/Updated/Removed {n} plugins", "Turned on/off {n} plugins", "Changed settings {n} times", "Made {n} operators", "Banned/Unbanned {n} players", "Scheduled {n} tasks", "Removed {n} schedules", "Ran schedules {n} times"; anything else "<verb> ×n" `:5316`.
- Undo `:10187`
  - Offered only for file-edit, file-replace, file-delete, config-edit with a kept copy `:10092`.
  - Button "Undo" (title "Put back what this changed, as it was just before"); replaced by text "Undone" once an undo entry names the same copy.
  - Dialog: title "Undo this change?"; text "Puts back <detail> as it was just before. Anything changed there since is replaced. The undo is recorded here too."; button "Undo" `:10199`.
  - Toasts: "Put back <detail>." or the server error.
- Footer: "Showing the latest N" or "N entries" / "1 entry"; button "Load more" (busy "Loading…") `:10247`, `:10253`.

### Findings

**ACT1. Settings changes are logged as raw keys** | wording | medium | M. A change reads "Changed settings difficulty = hard, max-players = 30", and SpawnLoft's own settings read "memory = 6G, java = C:\…\java.exe, autoRestart = true". These are file and registry keys, not the labels on the Settings page. Evidence: `ui.mjs:564`, `ui.mjs:2092-2094`. Fix: record the label and a readable value ("Difficulty: Hard", "Restart it automatically: on").

**ACT2. A failed start reads "Started …"** | wording | medium | S. A start that fails is recorded as action `start` with the reason as detail, so the line is "Started had not finished starting when SpawnLoft stopped waiting" with a "Failed" pill. Evidence: `supervisor.mjs:85,88`; `:5313`, `:5408`. Fix: when `ok === false` say "Could not start: <reason>".

**ACT3. Several lines glue a verb to a fragment** | wording | medium | M. Examples: "Deleted this server unregistered, files kept", "Reset fresh worlds, plugins kept", "Renamed from old", "Cleared old backups 3 old snapshots removed, keeping 7", "Scheduled Nightly: backup" (raw action type), "Noted the backup x.tar.gz: (note removed)". The colons in `ACTIVITY_TEXT` that would separate them are stripped by `.replace(/:$/, '')` on every path, so "Changed settings:", "Made an operator:" and "Ran the schedule now:" never show their colon. Evidence: `:5313`, `:5316`, `:10082-10087`; `manage.mjs:163,196`; `backup.mjs:658`; `schedule.mjs:346`. Fix: one sentence builder per action; keep the colon where the detail is a list.

**ACT4. File names stand in for things people know by another name** | wording | low | M. Backups, restores and upgrades show archive and jar names ("Changed the server software paper-1.21.4-100.jar to paper-1.21.4-130.jar"). Evidence: `upgrade.mjs:158`, `backup.mjs:499`, `create.mjs:290`. Fix: "Updated Paper 1.21.4 from build 100 to 130"; show the backup's date and label.

**ACT5. "schedule" and "task" are mixed, and "Paused" has no matching button** | consistency | low | S. Activity says "Removed the schedule", "Paused the schedule", "Removed {n} schedules" but "Scheduled {n} tasks"; the Schedule page says "task", "Turn off" and "Off". Evidence: `:10086`, `:5291`, `:9206`, `:9177`. Fix: "task" and "Turned off" throughout.

**ACT6. "Forgot the player" does not match the button that causes it** | consistency | low | S. The Players button and dialog say "Delete data". Evidence: `:10085`, `:7543`. Fix: "Deleted <name>'s player data".

**ACT7. Long lines are cut with no way to read them except hover** | clarity | medium | S. `.feed-text` is `white-space: nowrap` with ellipsis and the full text is only in `title`. A delete of several files or a settings change is cut at Regular width; keyboard and touch users cannot read it and nobody can copy it. Evidence: `:1693`, `:5403`. Fix: let a single row expand on click, as runs already do.

**ACT8. Undo is offered again in a filtered view** | flow | medium | S. "Undone" is worked out from the entries on screen. With the "Assistant" filter on, your own undo entry is filtered out, so an assistant's change you already undid shows "Undo" again. The same happens when the undo entry is on a page not yet loaded. Evidence: `:10228` (built from `all`, which is the filtered list `:10136`). Fix: have the server return `undone: true` per entry.

**ACT9. Clicking a filter drops keyboard focus** | accessibility | medium | S. A filter button calls `renderActivity()`, which empties the body and rebuilds the buttons. Evidence: `:10159`, `:10146`. Fix: repaint the list only, or refocus the pressed filter.

**ACT10. Filtered empty state says "Nothing from them yet."** | wording | low | S. Under "You" this reads oddly, and under "Schedule" it does not say which. Evidence: `:10166`. Fix: per filter: "Nothing done by you yet.", "No scheduled task has run yet.", "No assistant has changed this server."

**ACT11. Nothing says what Undo covers, and entries with a kept copy have no way back from here** | gap | medium | M. Plugin install, update, world reset, upgrade and restore all record a `snapshot` (`plugin-actions.mjs:38,46`, `manage.mjs:163`, `upgrade.mjs:158`), but the row shows nothing. Evidence: `:10188`. Fix: for those rows show "Backup kept" linking to that backup on the Backups page.

**ACT12. The Undo dialog cannot name what it will overwrite when the detail is long or missing** | clarity | low | S. The text embeds `e.detail` whole (up to 500 characters, including sizes like "(2.1 MB)" or "(no copy kept)" wording from other entries). Evidence: `:10201`. Fix: list the files as a short list, capped with "and N more".

**ACT13. No search, no type or date filter, no "failures only"** | gap | low | M. The only filter is who. A person looking for "when did it last crash" has to page through with "Load more". Evidence: `:10095`. Fix: add a "Problems" filter first (cheap: `ok === false`).

**ACT14. History has a silent size limit** | missing state | low | S. The log is one 2 MB file plus one previous file shared by all servers (`activity.mjs:13`), so old entries disappear. The footer says "N entries" as if that were everything. Fix: when `more` is false, say "That is everything SpawnLoft has kept."

**ACT15. The list does not update while it is open, and there is no Refresh** | missing state | low | S. It is re-read only when the tool is opened (`:3863`). Fix: re-read on the 10-second tick the vitals already use, or add Refresh.

**ACT16. On a database the page still says "this server"** | wording | low | S. Title text, empty text and the "Schedule" filter are the server's; a database has no schedules. Evidence: `:10147`, `:10167`, `:10095`, no `isDb` branch. Fix: branch the copy and hide "Schedule" for databases.

**ACT17. The assistant chip uses the warning colour and a jargon tooltip** | clarity | low | S. `data-tone="ai"` is styled with `--warn-ink`/`--warn-wash`, the same amber as real warnings; the tooltip says "MCP tools". Evidence: `:1611`, `:10102`. Fix: a neutral tone of its own; "An AI assistant you connected to SpawnLoft".

**ACT18. Schedule chips are cut at 190px with no tooltip** | clarity | low | S. `title` is only set for assistant and SpawnLoft. Evidence: `:1606`, `:10114`. Fix: always set the title to the full text.

### Keep
- Sentences instead of event codes, grouped by day, with runs collapsed.
- Undo confirm says the undo is itself recorded.
- "Load more" keeps open runs open and does not rebuild the header (`:10229`).
- Failed entries carry a pill as well as colour.

---

## 2. Players

### Inventory
- Entry: dock "Players" `:2772`; `renderPlayers` `:7236`; data from `GET /instances/<n>/players` (`ui.mjs:1125`).
- Head: "Players", "Everyone this server knows about, and what it thinks of them." `:7255`
- Mode line `:7265`: running "Changes go through the running server's console, so they take effect at once."; stopped "Changes are written to the server's files, and take effect the next time it starts."
- Search: placeholder "Search by name or id" `:7275` (no label). Filter tabs with counts: "Everyone N", "Operators N", "Banned N" `:7219`, `:7287`.
- States: skeleton; error with "Retry" `:7249`; empty "Nobody has joined this server, and nobody is opped, banned or whitelisted. People appear here the first time the server hears of them." `:7319`; no match "Nobody here matches that." `:7324`.
- Row (`playerRow` `:7458`)
  - Generated face; name or italic "name unknown" (title "This server has only ever seen this id, never a name to go with it.").
  - Pills: "Online", "Operator", "Banned" (title holds the reason), "Whitelisted".
  - Meta line (Regular): full UUID, then "connected now" / "last seen <date>" / "has never joined", then "banned: <reason>" `:7518-7520`.
  - Wide (1280+): columns "Connected now | Last seen … | Has never joined" and the first 8 characters of the id; Ultra: full id `:1905-1918`.
  - Sorted online first, then by name.
- Row actions `:7538`
  - "Make op" / "Remove op": no confirm. Toasts "<name> is now an operator." / "<name> is no longer an operator." or the server's reply.
  - "Ban" (red): dialog "Ban <name>?"; running "They are disconnected straight away and cannot rejoin. The reason is shown to them when they try."; stopped "They cannot join once the server starts. The reason is shown to them when they try."; field "Why (optional)", placeholder "Griefing"; button "Ban". Toast "<name> is banned."
  - "Unban": no confirm. Toast "<name> is unbanned."
  - "Delete data" (red, trash): disabled when running (title "Stop the server first - a running one writes this straight back") or never joined (title "This player has no world data to delete"); otherwise title "Remove this player's inventory, position, stats and advancements". Dialog "Delete <name>'s data?", text "Their inventory, position, health, stats and advancements are removed from this world. They can still join - they arrive as if for the first time. Being opped, banned or whitelisted is not affected, and this is not undoable without a backup.", type the name to confirm, button "Delete data". Toast "Deleted <name>'s world data."
- Detail card, Ultra only (`playerDetail` `:7346`, CSS `:1925`): 72px face, name, pills (plus "Has joined" / "Never joined"), rows "UUID", "Status" (Connected now / Not connected / Server stopped), "Last seen" (Now / date / Unknown / Has never joined), "World data" (Kept in this world / None yet), "Operator" (Yes, level N / No), "Ban reason" (… / None given), "Banned by", "Ban expires" (date / Never), "Whitelist" (On the list / Not on the list), then the same three buttons.
- Server errors that can surface (`players.mjs`): "\"<srv>\" has no record of a player with that id" `:162`; "SpawnLoft does not know the name behind <uuid>, and banning needs one. Offline-mode ids are made by hashing a name, so they cannot be turned back into one - have the player join once while the server is running, or type the name in yourself." `:170`; "\"<srv>\" is running. Stop it before deleting player data - …" `:258`.

### Findings

**PLY1. Whitelist cannot be managed, and Settings sends people to the console** | gap | high | L. The page shows a "Whitelisted" pill and a "Whitelist" row but has no add, remove or on/off, and no "Whitelisted" filter tab. Settings → Who can join → Whitelist says, behind "More": `Add them from the console with "whitelist add <name>".` Evidence: `:7500`, `:7219`; `ui.mjs:344`; `handlePlayers` only knows `op`, `ban`, `forget` (`ui.mjs:1152-1165`). Fix: a Whitelist tab with an on/off switch, "Add a player" by name, and Remove per row.

**PLY2. No way to add a player by name** | gap | high | M. Someone who has never joined cannot be opped, whitelisted or banned in advance; the empty state says people "appear here the first time the server hears of them". The server's own error tells you to "type the name in yourself", which the page has no field for. Evidence: `:7319`; `players.mjs:170-172`; `ui.mjs:1147` requires a `uuid`. Fix: "Add a player" field that takes a name and offers Op / Whitelist / Ban.

**PLY3. The list goes stale and cannot be refreshed** | missing state | high | S. The pane returns early if it has already drawn this server, and that cache is only cleared when a different server is selected. "Online" pills, last-seen times and counts stay as they were when first opened, even after closing and reopening the tool. Evidence: `:7241`, `:6345`, `:3858`. Fix: re-read on every open (as Activity does `:3863`) and on the existing poll while open; add a Refresh.

**PLY4. A server refusal is shown as a green success** | error state | high | S. While running, the toast is the server's own reply with the "good" style whatever it says. Replies such as "That player does not exist" or "Nothing changed. The player is already banned" come back as successes. Evidence: `:7559` (`toast(out.reply || done, 'good')`), `players.mjs:194-195,220-221`. Fix: re-read the list and report from the result (is the player now op/banned), showing the reply as an error if not.

**PLY5. "Make op" has no confirm and no explanation** | flow | high | S. One click gives full control of the server (level 4, `players.mjs:204`); it sits beside "Ban" in a row whose actions are dimmed to 60%. Extends F8 ("Make op is unexplained"). Evidence: `:7567`, `:1919`. Fix: label "Make operator"; confirm "Make <name> an operator? Operators can run every command, including stop and ban."

**PLY6. No Kick** | gap | medium | S. A running server offers ban but not a plain disconnect. Evidence: no `kick` in ui.html or `ui.mjs` handlers. Fix: "Kick" on online rows with an optional message.

**PLY7. No ban duration; bans are always permanent, and that is not said** | gap | medium | M. File bans write `expires: 'forever'` and the console path sends `ban <name>`. The dialog does not say "permanently". Evidence: `players.mjs:219,232`; `:7572`. Fix: say "Banned until you unban them"; offer a duration later.

**PLY8. Players with no known name fail on a running server with a long technical error** | error state | medium | S. Buttons stay enabled for "name unknown" rows; pressing Op or Ban returns the hashing paragraph above as a red toast. Evidence: `players.mjs:167-173`; `:7539-7549`. Fix: disable those buttons while running with the reason shown in the row: "Stop the server to change this player; their name is not known."

**PLY9. Delete data is the one destructive action that keeps no copy** | flow | medium | M. Files, worlds and upgrades take a copy first; this only says "not undoable without a backup". Evidence: `players.mjs:255-281` (no snapshot); `:7590`. Fix: copy the player's files first, like Files does, and say "A copy is kept in Backups".

**PLY10. Every row leads with a 36-character id** | clarity | medium | S. At Regular width the meta line starts with the full UUID in mono before the facts that matter. The search placeholder says "id" and the detail card says "UUID". Evidence: `:7518`, `:7389`, `:7275`. Fix: lead with last seen and ban reason; move the id behind a "Copy ID" action.

**PLY11. Ban reason, who banned and expiry only exist at 2000px** | scaling | medium | M. Extends F8 with the rest: at Regular and Wide the click-to-select handler still runs and sets `aria-selected`, but nothing visible changes, and `aria-selected` sits on a `div` with no role. Evidence: `:7464`, `:7333`, `:1925-1930`. Fix: expandable row or side sheet at lower tiers; give the list `role="listbox"`/options or drop the attribute.

**PLY12. Every action rebuilds the pane and drops focus** | accessibility | medium | S. `again()` re-renders head, search and list; the pressed button no longer exists and the search box loses focus. Evidence: `:7560`, `:7254`. Fix: update the one row; return focus to the same action.

**PLY13. "Banned by mcctl"** | wording | low | S. Bans written while stopped record source `mcctl`, the old product name, and the card shows it. Evidence: `players.mjs:158`; `:7396`. Fix: write "SpawnLoft"; show "You, from SpawnLoft".

**PLY14. "Ban expires" may show "Invalid Date"** | error state | low | S | unverified in a browser. Minecraft's format is `2026-08-30 18:41:07 -0500` (`players.mjs:241`), passed to `new Date()`; that is not ISO and browsers differ. Evidence: `:7397`. Fix: parse the format explicitly.

**PLY15. Two red buttons on every row** | hierarchy | low | S. "Ban" and "Delete data" are both `danger` on each line, so the list is a column of red. Evidence: `:7541`, `:7543`. Fix: neutral buttons in the row, red only in the confirm; or move Delete data to a ⋯ menu.

**PLY16. "Delete data" is greyed with the reason only on hover** | missing state | low | S. Same shape as B6. The mode line above says changes "take effect at once", which reads as if everything works while running. Evidence: `:7544-7548`. Fix: add to the mode line: "Deleting a player's data needs the server stopped."

**PLY17. Filter tabs and search have no group or label** | accessibility | low | S. `.filters` has no `role="group"`/`aria-label` (the Activity filter has both), the count is run into the name ("Everyone 12"), and the search input has a placeholder only. Evidence: `:7277`, `:7287`, `:7273`. Fix: add the role and labels; put the count in its own span.

**PLY18. Wording: "opped", "what it thinks of them"** | wording | low | S. Evidence: `:7256`, `:7319`, `:7589`. Fix: "Everyone who has joined, and who is an operator, banned or on the whitelist."

**PLY19. No online filter and no IP ban** | gap | low | S. Evidence: `:7219`.

**PLY20. Op, ban and delete are recorded in Activity but unban reasons and kicks are not, and nothing links a row to its history** | gap | low | M. Evidence: `ui.mjs:1153-1163`. Fix: "History" link per player filtering Activity.

### Keep
- The line saying how a change will be made (console vs files) before any button is pressed.
- Online players sorted first with a pill, not colour alone.
- Ban dialog differs for running and stopped and says the reason is shown to the player.
- Delete data explains exactly what is and is not removed and asks for the name.
- Faces generated offline from the id.

---

## 3. Stats / Performance

### Inventory
- Entry: dock "Stats" `:2773`; pane title "Performance" `:7082`; subtitle "Processor and memory while the server runs, sampled every ten seconds."; unavailable: "Not available in this preview." plus the reason "CPU and memory charts are not available in this preview on this platform. Server controls and the live console still work." (`platform.mjs:11`).
- Range buttons "1m", "5m", "30m", "1h", "4h" (default 5m) `:6905`, `:7094`.
- Gauges (`gauge` `:6970`)
  - "Processor": now "N.N%" / "stopped" / "…" / "—"; aside "peak N.N% · share of all N cores".
  - "Memory": "N MB" / "stopped"; aside "peak N MB · <mem> max heap".
  - "TPS" (only when readings exist): "N.N"; aside "low N.N · 20 is full speed".
  - Ultra only: "Now", "Average", "Peak", "Low" under each chart `:7009`, `:1766`.
- Notes
  - No samples, history elsewhere: "Nothing in this range. This server last ran <ago>, and N readings are kept - try <range>." `:7114`
  - No samples, running: "Measuring. The first reading needs two samples 10 seconds apart, because processor use is a rate rather than a number you can read off once." `:7119`
  - No samples, stopped: "Nothing recorded. This is measured while the server runs, and history is cleared when it starts so two runs are never drawn as one line." `:7121`
  - Memory chart: "Waiting for the first reading." / "No readings in this range." `:7135`
  - Over the limit: "Above the heap limit is normal: this is the whole java process, and <mem> is the ceiling on its heap alone." `:7196`
- Facts row: "Uptime <t | just started | not running>", "Started <date>", "Samples N every 10s" `:7211`.
- Layout: two columns from an 860px pane `:1378`; two by two with a facts card at Ultra `:1397`.
- Error: `paneError` + "Retry" on first load; silent on later polls `:7075`.

### Findings

**STA1. Readings older than four hours can never be seen** | flow | medium | S. The server keeps up to 5 hours (`ui.mjs:722`) and the largest button is 4h. When the last run ended more than 4 hours ago the message is "…and N readings are kept." with no range to try, and that is the exact case the comment says the page exists for ("what was it doing before it died"). Evidence: `:7113-7116`, `:6905-6911`. Fix: add an "All" range, or jump to the last run.

**STA2. "try 4h." is text, not a button** | flow | low | S. Evidence: `:7116`. Fix: make it a link that selects the range.

**STA3. A failed poll leaves a frozen chart with no sign** | error state | medium | S. Quiet polls return on error with nothing shown. Evidence: `:7075`. Fix: after two misses show "Not updating. Last reading 10:42." in the facts row.

**STA4. Charts have no accessible name or text equivalent** | accessibility | medium | S. The svg has `role="img"` and no `aria-label` or `<title>`; the range group has no role or label; "1m" is read as "one m". Evidence: `:6939-6941`, `:7094-7103`. Fix: `aria-label="Processor, last 5 minutes: now 3.1%, peak 12%"`; group label "Time range"; `aria-label="Last 1 minute"`.

**STA5. Choosing a range rebuilds the page and drops focus** | accessibility | medium | S. Extends F9 (which covered the 10-second redraw). Evidence: `:7101`, `:7081`. Fix: update values and polylines in place.

**STA6. Wording: "max heap", "heap limit", "java process", "Samples", "rate rather than a number you can read off once"** | wording | medium | S. Extends C3. Evidence: `:7126`, `:7164`, `:7196`, `:7213`, `:7119`. Fix: "of 4 GB allowed"; "Memory can sit a little above the limit you set. That is normal."; "Readings: 30, one every 10 seconds"; "Measuring. The first reading takes about 20 seconds."

**STA7. "stopped" is printed where the number goes** | clarity | low | S. With history in range and the server down, the big figure reads "stopped" in the display font, while the empty case uses "—". Evidence: `:7150`, `:7163`, `:7128`. Fix: show the last reading greyed with "last reading" under it.

**STA8. TPS simply disappears when it cannot be read** | missing state | medium | S. The gauge is only added when a sample has `tps`; there is no line saying why it is missing (the header vital says "Waiting for the server to answer over RCON" `:4434`). Evidence: `:7174-7175`. Fix: keep the gauge with "The server has not reported its speed yet."

**STA10. On a database the copy is the server's** | wording | low | S. "Processor and memory while the server runs", "This server last ran…", and the tooltip logic for heap are shown for a database. For a database that runs elsewhere the page is permanently "Nothing recorded. This is measured while the server runs…" yet Stats is still in its menu. Evidence: `:7084`, `:7114`, `:7121`, `:3803`. Fix: branch the copy; hide Stats for external databases or say "This database runs on another machine, so SpawnLoft cannot measure it."

**STA11. No players-over-time or disk use** | gap | low | M. Player count is already sampled for the header (`latest.players` `:4435`). Fix: a Players chart; world folder size as a fact.

**STA12. Memory colour is hard-coded in three places** | consistency | low | S. Extends F9 with the lines: `:7134`, `:7168`.

### Keep
- Fixed, explained scales (CPU floor of 10%, TPS fixed at 20).
- Three different empty explanations (never measured, nothing in range, still measuring).
- Empty gauges keep the page's shape.
- Polling stops when the tool is closed.

---

## 4. Schedule

### Inventory
- Entry: dock "Schedule" `:2774`; pane title "Scheduled work" `:9028`; subtitle "Backups, restarts and console commands on a clock, run by Windows | macOS | your system whether or not this is open."; unavailable: "Not available in this preview." plus `platform.mjs:10`.
- "How this runs" (collapsed) `:9060`: "Held by Windows Task Scheduler | macOS launchd | systemd. " + platform hint `:3541-3545`.
- Linux notice `:8973`
  - Headless (warn): "These only run while you are logged in. Your account stops its background tasks when you log out. On a server you connect to and disconnect from, a nightly backup would never run."
  - Desktop: "These pause when you log out. They run while you are logged in, with the screen locked too. Turn this on if backups and servers should keep going after you log out of this computer."
  - Button "Keep running after logout" (title "Turns on lingering for your account (loginctl enable-linger)"); toast "Scheduled tasks will now run while you are logged out."; errors from `schedule-linux.mjs:185-187`.
- Empty: "Nothing scheduled. A nightly backup and a daily restart are the two most servers ever need." + "New task" `:9105`.
- "New task" button `:9071`; form (`taskForm` `:8803`)
  - "What should happen": "Take a backup", "Verify the backups", "Run a server command", "Restart the server", "Stop the server", "Start the server", "Several steps in order" (`schedule.mjs:47-57`).
  - "Console command to send" (placeholder "say Server restarting in 5 minutes"); "Snapshots to keep" (1 to 365, default 7); "Minutes of warning first" (0 to 60, default 5).
  - "Steps, in order" (`stepsEditor` `:8670`): step kinds "Tell the players", "Run a command", "Wait", "Count down", "Take a backup", "Verify the backups", "Stop the server", "Start the server", "Restart the server"; selects "Add a step…" and "Start from…" with presets "Restart with a warning and a backup first", "Back up, telling the players", "Stop, take a full backup, start again"; per step ↑ ↓ ×; checkboxes "Only while the server is running - otherwise the whole task is skipped", "Keep going if a step fails".
  - "How often": "Every few minutes", "Every few hours", "Once a day", "Once a week", "When you sign in" (Linux: "When your session starts (at startup, if tasks keep running after logout)") `:8429`; "How many" (default 6); "On" (weekday); "At" (default 03:00); "Call it".
  - Notes: "Skipped, and recorded as skipped, whenever the server is not running at that moment."; "One after another in one run: a step waits for the one before it, however long that takes. A step that fails stops the rest unless you say otherwise."
  - Buttons "Create task" / "Save changes", "Cancel".
- List: heading "Tasks (N)"; card (`taskCard` `:9155`)
  - Name, optional "from the Backups tab".
  - State pill: "Off"; "Not in Windows" (title "SpawnLoft has this task but the system scheduler does not. Edit it to put it back."); otherwise the scheduler's word ("Ready", "Running").
  - Line: summary · schedule sentence; "Next <date>" or "No next run scheduled"; "· last run: ok | ready | running | disabled | not run yet | no more runs scheduled | stopped by user | queued | already running, so this run was skipped | not run - the machine was not logged in | failed (exit N) | unknown" (`schedule.mjs:60-71,132`).
  - Buttons "Run now", "Turn off" / "Turn on", "Edit", "Delete".
- Dialog: "Delete \"<name>\"?", "It stops running and is removed from the system scheduler. Backups it already took are not touched.", "Delete task".
- Toasts: "Task created.", "Saved.", "Deleted.", "Started. Watch Recent runs for what it did."; none for Turn on/off.
- "Recent runs": empty "Nothing has run yet. Every run writes a line here, including the ones that fail."; row = date, task id, "<status>: <detail>" `:9132-9148`.
- Server validation messages (`schedule.mjs:84-116`, `task-steps.mjs:29-54`, `ui.mjs:1219`): "the interval must be a whole number of at least 1"; "the largest hourly interval Windows accepts is 23"; "\"\" is not a time - use HH:MM on a 24 hour clock"; "a command is required"; "that command is too long for a console line"; "step 2: which command?"; "step 1: what should the players be told?"; "add at least one step"; "a task holds at most N steps"; "the waits add up to N minutes; keep them under M"; "\"Automatic backup\" is the name the Backups tab uses for the schedule behind its own toggle. Pick another so the two cannot be confused."; "another change to the scheduled tasks is still in progress; try again in a moment".

### Findings

**SCH1. Tasks stopping at sign-out is hidden on Windows and macOS** | missing state | high | S. Linux gets a visible notice with a button. Windows and macOS say it only inside the collapsed "How this runs": "…but not after sign-out." / "Tasks do not run after sign-out." The page subtitle says the opposite impression: "whether or not this is open". Evidence: `:3541-3545`, `:8974` (returns null off Linux), `:9030`. Fix: one plain line under the title on every platform: "Tasks run while you are signed in to this computer, even with SpawnLoft closed."

**SCH2. The default time is 03:00 and nothing says what happens if the computer is asleep or off** | surprising default | medium | S. The macOS and Linux hints mention missed runs; the Windows hint does not. Whether a missed Windows run is caught up is unverified. Evidence: `:8860`, `:3545`. Fix: say it next to the time field: "If the computer is asleep or off at this time, the task runs when it is next on" (or "is skipped", whichever is true per platform).

**SCH3. Recent runs and "Next" go stale; "Watch Recent runs" does not update** | missing state | high | S. Same cache as Players: the pane only redraws when a different server is selected. After "Run now" there is one refresh at 2.5 seconds; a backup that takes longer never appears. Evidence: `:9012`, `:6344`, `:9220-9223`. Fix: re-read on open and every 10 seconds while a run is expected; show the run as "Running…" until its line arrives.

**SCH4. A slow or failed scheduler query marks every task "Not in Windows"** | error state | medium | M. Extends B9. When the query errors or returns nothing, every task comes back `known: false`, so all cards turn red and lose their "Next" line. The fix ("Edit it to put it back") is only in a tooltip on a non-focusable `div`. Evidence: `schedule.mjs` `queryWindows` (`if (err || !stdout.trim()) return resolve(out)`), comment `:9180-9181`, `:9182-9184`. Fix: tell "could not ask the scheduler" apart from "missing"; for missing, show a "Put it back" button.

**SCH5. A failed last run is grey text on a card that says "Ready"** | hierarchy | medium | S. "last run: failed (exit 1)" is in the same muted line as the schedule. Evidence: `:9197-9198`, `:9186`. Fix: red "Last run failed" pill with a link to the run line; drop "exit N".

**SCH6. No validation in the form; errors arrive as lower-case toasts** | error state | medium | M. An empty command, an empty time or an empty step is sent and comes back as "a command is required", "\"\" is not a time - use HH:MM on a 24 hour clock", "step 2: which command?". Settings validates inline; this form does not. Evidence: `:8928-8952`; messages above. Fix: mark the field, disable "Create task" until valid.

**SCH7. Numbers are silently changed on save** | flow | medium | S. "Every few hours: 48" is clamped to 23 and saved with "Task created."; switching between minutes and hours also rewrites the number without a word. The server's own message names Windows on every platform. Evidence: `:8907-8912`, `:8940-8942`; `schedule.mjs:93`. Fix: show "Up to 23 hours. For longer, use Once a day or Once a week." under the field.

**SCH8. "Every few minutes" starts at 6** | surprising default | low | S. One default serves both units, so the first minutes value is a backup every 6 minutes. Evidence: `:8856`. Fix: default 30 for minutes, 6 for hours.

**SCH9. Labels: "How many", "Call it", "Snapshots to keep"** | wording | low | S. "How many" sits beside "How often: Every few hours"; "Call it" does not say it is optional (it defaults to the action's name, `schedule.mjs:325`). B1 covers "Snapshots". Evidence: `:8865`, `:8875`, `:8842`. Fix: "Every [6] hours" as one sentence; "Name (optional)"; "Backups to keep".

**SCH10. "Verify the backups" is never explained** | wording | medium | S. No note exists for that action, and "Run a server command" does not say whether to type the slash. Evidence: `:8916-8920`; `schedule.mjs:50`. Fix: "Reads every backup back to check none is damaged."; "Without the leading /".

**SCH11. The steps editor adds a step as soon as the select changes** | accessibility | medium | S. "Add a step…" and "Start from…" act on `change`; with a keyboard, arrowing through a closed select fires `change` in several browsers, adding steps or replacing the whole list. Evidence: `:8773`, `:8781`. Fix: a select plus an "Add" button, or a menu button.

**SCH12. Choosing a preset replaces the steps without asking** | flow | medium | S. Evidence: `:8781-8786`. Fix: ask when the list has been edited, or name the control "Replace with…".

**SCH13. Step fields have no labels; moving a step drops focus** | accessibility | medium | S. The text, minutes and message inputs inside a step have no `aria-label`; the countdown message is explained only by a tooltip ("Said as \"<this> in 5 minutes\", then at one minute and ten seconds"); ↑/↓ rebuild the list. Evidence: `:8722-8745`, `:8739`, `:8758`. Fix: `aria-label` per input; a visible example line; refocus the moved step.

**SCH14. The chain summary leaves things out** | clarity | low | S. `describeChain` has no phrase for stop, start or restart (it prints the raw word), ignores the countdown message and prints waits as "wait 90 s". Evidence: `:8461-8471`. Fix: add the phrases; "wait 1½ min".

**SCH15. Opening a form moves no focus; opening a second form throws the first away** | flow | medium | S. "New task" hides itself while focused and nothing in the form is focused. Clicking "Edit" on another card calls `editor.close()`, discarding whatever was typed with no question. "Cancel" also discards silently. Evidence: `:9077-9096`, `:9242`. Fix: focus the first field; ask before discarding a changed form.

**SCH16. Save gives no "working" state** | missing state | low | S. Only `save.disabled` is set; registering with the system scheduler can take seconds on Windows. Evidence: `:8946`. Fix: `busy(save, true, 'Saving…')`.

**SCH17. "Run now" on a restart or stop task acts at once** | flow | medium | S. Extends A3: a task that restarts or stops the server runs with players online and no confirm. The refresh 2.5 seconds later also rebuilds the pane and drops focus. Evidence: `:9214-9223`. Fix: confirm when the task stops or restarts a server with players on.

**SCH18. Turn on / Turn off gives no confirmation and dims its own button** | missing state | low | S. No toast; an "Off" card is drawn at 62% opacity including "Turn on". Evidence: `:9230-9234`, `:2254`. Fix: dim the text, not the actions; announce the change.

**SCH19. Times are shown three ways** | consistency | low | S. The field uses the browser's time input, the card says "every day at 03:00" (always 24-hour), and "Next" uses the locale format. Evidence: `:8449`, `:8859`, `:9197`. Fix: format the card's time with the locale.

**SCH20. Recent runs cannot be tied to a task** | clarity | medium | S. Extends B9: the middle column is the internal id ("survival-backup-2"), not the task's name; runs of deleted tasks stay; "FAILED" is upper-case; the list stops at 40 with no "more". Evidence: `:9141`, `:9146`; `schedule.mjs:446`. Fix: show the task name; "Failed" pill; "Show older".

**SCH21. Frequency choices are thin** | gap | medium | M. No several days a week, no several times a day, no monthly, no one-off. Evidence: `schedule.mjs:77`. Fix: weekday checkboxes first.

**SCH22. A task made by the Backups page can be edited into something else** | flow | low | S | effect on the Backups switch unverified. The "from the Backups tab" card has the same Edit, including "What should happen". Evidence: `:9167-9172`, `:9241`. Fix: link "Change on the Backups page" instead of Edit (also answers B4).

**SCH23. "tab" for what the panel calls a page; "Held by systemd"** | wording | low | S. Evidence: `:9170`, `ui.mjs:1219`, `:9063`. Fix: "from the Backups page"; "Run by your system's scheduler".

**SCH24. The Linux "could not turn it on" error is a terminal command** | wording | low | S. Extends C1: "Run this in a terminal, then reload: sudo loginctl enable-linger <user>". Evidence: `schedule-linux.mjs:187`; `:8997`. Fix: keep the command but offer Copy and say why a password is needed.

### Keep
- One form open at a time, fields that appear only when they apply.
- Presets for the three chains most people want.
- The Linux notice puts the fix on a button next to the problem.
- Delete confirm says existing backups are not touched.
- Skips are recorded and styled differently from failures.

---

## 5. Settings

### Inventory
- Entry: dock "Settings" `:2775`; pane title "Server settings", subtitle "server.properties, and how SpawnLoft runs this server." `:11094`. Layout: section list (240px) + one section at a time; raw file beside the form at Ultra `:1989`, `:2074`; list becomes a wrapped row under 760px `:2084`.
- Section list (`nav`, "Settings sections"): "Who can join", "Gameplay", "World and load", "If it crashes", "Java and memory", "Server software" (Paper, Purpur, Folia, ASP only `:11520`), "Databases" (added after an async read `:11894`), separator, "server.properties". A dot marks sections with unsaved changes; `aria-label` "<title>, unsaved changes" `:11698`.
- Tags per row: "Changed" (title "Different from what is saved"), "Default" (title "Not in server.properties yet: this is Minecraft's own default") `:11687`. Help: first sentence shown, the rest behind "More" `:11182`.
- **Who can join** ("Identity, the whitelist, and how many people at once.") `ui.mjs:328-352`
  - "Require a Minecraft account": select Yes / No. Help "Off lets anyone join as any name, which is what multi-account testing needs - but it gives players name-derived UUIDs instead of real ones, and puts an OFFLINE/INSECURE banner in every log." More: "Plugin authors often refuse a bug report carrying it." Inline warning on change when the world has players `:11283`: "This world already has data for N players, M of them under offline|real UUIDs. Changing this gives those players a different UUID, so anything stored against them — permissions, homes, inventories, plugin data — will not follow, and they will join as new players." / "…Changing this alters how UUIDs are issued, so stored per-player data may not follow."
  - "Max players": number 1 to 1000. No help.
  - "Whitelist": select Yes / No. Help "Only listed players can join." More: "Add them from the console with \"whitelist add <name>\"."
- **Gameplay** ("The rules the world is played by.")
  - "Difficulty": select peaceful / easy / normal / hard. No help.
  - "Default game mode": select survival / creative / adventure / spectator. No help.
  - "PvP": Yes / No. No help.
  - "Spawn protection": number 0 to 256. No help.
- **World and load** ("What players see before they join, and how much the server draws for them.")
  - "Message of the day": text, plus the preview block `:8540`: 16 colour swatches (title "Colour §x", label "Colour x"), "B", "I", "U", "S", "↺" (Bold, Italic, Underline, Strikethrough, Reset); a preview card (icon, server name, MOTD); "Change icon", "Remove icon", "Any image; it is cut to a square and scaled to 64 by 64. Saved at once." Toasts "Icon saved." (+ " Players see it after the next restart."), "Icon removed.", "That image could not be read."; server: "the icon must be a PNG image", "the icon must be 64 by 64 pixels", "that icon is too large".
  - "View distance": number 2 to 32. No help.
- Validation for numbers: "Use a whole number from <min> to <max>." `:12824`.
- **If it crashes** ("What SpawnLoft does when the server dies without being asked to.") `:11314`
  - "Restart it automatically": switch. Help "Comes back ten seconds after a crash." More: "Three crashes in ten minutes and it stays down instead of grinding all night; stopping it yourself always sticks."
  - "Discord webhook": text, placeholder "https://discord.com/api/webhooks/…". Help "Gets a message when the server crashes, recovers, gives up, or a scheduled task fails." More: "Leave it empty for none; Discord makes one under Server, Integrations, Webhooks." Validation "Paste the whole link Discord gives you, starting with https://"; server "the webhook must be an http(s) URL - paste the one Discord gives you." No test button.
- **Java and memory** ("What the server runs on, and how much memory it may use. Both take effect at the next start.") `:11370`
  - "Runs on": select. Options "Java N · on PATH | <path>" (+ " · too old for this server"), "Whatever \"java\" resolves to on PATH", "A path of my own…" (reveals a path box, placeholder `C:\Program Files\Java\jdk-17\bin\java.exe`). Help states: "Looking for installed Javas…"; "This server needs Java N or newer. Found N Java(s) on this machine; for one installed somewhere else, pick the last option and paste the path to java.exe."; "No Java was found on PATH or in the usual install folders. Paste the path to java.exe, or get one from <url>"; "Could not look for Javas: <error>". Save errors: "Pick a Java, or paste the path to one." `:11725`; "<path> could not be run: <message>" (`ui.mjs:2075`).
  - "Memory": text. Help "The most the server may use, as 4G or 6144M." More: "The whole process sits a little above it, which is normal." Validation "Use a number followed by G or M — for example 4G, or 6144M."
  - "Java arguments": checkbox "Use my own Java arguments", textarea, and the full launch line (`java -Xms… -Xmx… … -jar <jar> --nogui`). Help "How Java runs the server, beyond memory." More: "The recommended set suits almost every server; your own replaces it. Memory stays with the setting above, and takes effect at the next start." Server errors (`registry.mjs:179-184`): "that is more than 60 Java arguments"; "\"x\" is not a Java option - each starts with a dash, like -XX:+UseG1GC"; "-Xmx…: memory is set by the Memory setting, so both stay in step"; "-jar: which jar runs is the server's own jar".
- **Server software** ("The server build this server runs.") `:11522`: the jar file name; button "Check for updates"; then "Checking for updates…"; "SpawnLoft did not download this jar, so it cannot tell which build it is or offer updates for it."; "Runs <Paper> <version>, build <n>."; "Build <n> is available for <version> (beta). The jar it runs now stays in the folder as the way back." + "Update to build <n>" → "Downloading…" → toast "Now on <file>. Restart to load it."; "This is the newest build for <version>."; "Minecraft <next> is out. Crossing versions migrates the worlds on the next start, and worlds do not migrate back." + "Upgrade to <next>…".
  - Confirm: "Upgrade <id> to Minecraft <next>?", "The first start migrates the worlds, and worlds do not migrate back. A standard snapshot is taken first, but check your plugins support <next> too - a plugin built for <current> may refuse to load.", type the name, "Upgrade". Toasts "Snapshotting, then downloading <Paper> <next>…", "Now on <file>. Snapshot saved first. Restart to load it."
- **Databases** `:12241`: "Attach a database, then use Show credentials to configure your plugins manually. SpawnLoft does not edit plugin configs."
  - Attached row: name; "<engine> <version> (elsewhere) · host:port · database <db> · user <user>" or "· shared password"; "Show credentials"; "Detach".
  - Detach dialog: "Detach <server> from <db>?", "The user goes away. Whether the data goes with it is up to you.", choices "Keep the data" ("Attaching again later gives the same database back, with a new password.") / "Drop the database too" ("Every table this server had on it goes. The database must be running for this."), "Detach". Toast "Detached."
  - "Create a database" + "MySQL 8.4 LTS, on port N if it is free. Started and attached for you." (macOS: "(macOS 15+)"); progress text replaces the hint; toast "Created <db> on port N and attached <server>."; unavailable texts `:12340`, `:12343`.
  - No databases yet: "Or add one with choices in it: " + "Add a database…". Otherwise a select of unattached databases ("<name> — <engine> <version> at host:port (stopped | unreachable)") + "Attach" + "The database has to be running to attach."; all attached: "Attached to every database here." Toast "Attached <server> to <db>."
  - Credentials dialog (`showCredentials` `:12183`): title "<server> on <db>"; "What a plugin config wants. Paste it into the plugin's storage section; the user can reach this one database and nothing else." (Redis: "What a plugin config wants. <note>"); rows Host, Port, Database, User, Password, JDBC, URL, Key prefix; buttons "Copy" and "Close"; toast "Copied the connection details." / "The clipboard refused; select and copy by hand."
- **server.properties** (raw) `:11767`: "The whole file. Values shown as [redacted] are hidden: leave those lines as they are. The ports and RCON are set by SpawnLoft at every start, so a change to them is refused."; textarea; "Save file", "Reload"; notes "Reading server.properties…", "Saving…"; toast "Saved server.properties. A snapshot of it was taken first; restart <name> to apply."; confirm "Discard your edits to server.properties?", "Reloading reads the file again as it is on disk.", "Reload".
- Save bar `:11638`: dot, "N unsaved change(s)" / "Saving…", "Take effect when <name> next starts." / "Fix the field marked in red to save.", "Discard", "Save", "Save and restart" (only while running; then Save is not primary). Toast "Saved N setting(s). Restart <name> to apply."

### Findings

**SET1. "Save and restart" and "next starts" are shown for settings that need no restart** | flow | high | S. Changing only "Restart it automatically" or the webhook still shows "Take effect when <name> next starts.", makes "Save and restart" the primary button on a running server, and the toast says "Restart <name> to apply." The code's own comment says these take effect without a start. A user is nudged into disconnecting players for nothing. Evidence: `:11311-11313`, `:11643`, `:11707-11712`, `:11742-11743`. Fix: mark each entry as needing a restart or not; offer "Save and restart" and the restart wording only when one does.

**SET2. A partly failed save reports only the failure** | error state | medium | S. Properties are saved first, then SpawnLoft's own settings. If the second call fails (a Java path that will not run, a bad argument), the properties are already written but the only message is the error; the count just drops. Evidence: `:11730-11740`, `:11748`. Fix: "Saved 3 settings. 1 was not saved: <reason>", with the failed row marked.

**SET3. "Save and restart" can save and then quietly not restart** | flow | low | S. `act('restart')` returns at once when another action is under way. It also restarts with players online without asking (A3). Evidence: `:11747`, `:6654`. Fix: say "Saved. Restart it when the current action finishes."

**SET4. Updating the server software or attaching a database throws away unsaved settings** | flow | high | S. Extends F1. "Update to build", "Upgrade to…", Attach, Detach and Create all clear `dataset.for` and rebuild the whole form. "Add a database…" leaves the page for the Add sheet. Evidence: `:11580-11581`, `:11618-11619`, `:12313`, `:12358`, `:12403`, `:12382`. Fix: rebuild only that section, or ask to save first.

**SET5. Root cause of "0 unsaved changes"** | bug detail | medium | S. Extends F2. `showRaw()` sets `bar.hidden = on && !beside`, which un-hides the bar on every section click regardless of the count; in the raw view below Ultra it also hides the bar while form changes are pending. Evidence: `:11859`, `:11123`, against `:11705`. Fix: let `update()` alone decide; call it from `showRaw`.

**SET6. Only nine game settings have a row** | gap | high | L. Missing rows a host panel normally has: simulation distance, allow flight, hardcore, world seed, level type, allow nether, command blocks, force game mode, spawn monsters/animals/NPCs, player idle timeout, enforce whitelist, resource pack and "require resource pack", hide online players, max world size, op permission level. Everything else needs the raw file. Evidence: `ui.mjs:328-347`. Fix: add the common ones to `EDITABLE_PROPS` with help text; the form already builds itself from that list.

**SET7. Six of nine rows have no help, and two need a unit** | clarity | medium | S. "Spawn protection" (blocks around spawn only operators can change; 0 turns it off) and "View distance" (chunks; higher costs more) say nothing. "Max players", "Difficulty", "Default game mode", "PvP" also have no line. Evidence: `ui.mjs:339-346`. Fix: one sentence each.

**SET8. Choices are raw file values** | wording | low | S. "peaceful", "easy", "survival", "spectator" are lower-case file values next to "Yes"/"No". Evidence: `:11229`. Fix: capitalised labels, same stored value.

**SET9. The only whitelist instruction is hidden behind "More" and is a console command** | wording | medium | S. See PLY1. Evidence: `ui.mjs:344`, `:11184`. Fix: link "Manage the whitelist in Players".

**SET10. The MOTD box fills with `\u00A7c`** | clarity | medium | M. Swatches insert the escaped code as text, so the field reads `\u00A7cWelcome`. There is no way to add the second line except typing `\n`, no length hint, and the 21 buttons are 18px and 22px wide. Colour buttons are named "Colour 4", "Colour c". Evidence: `:8549`, `:1630-1632`, `:8559-8560`. Fix: name the colours ("Red"); a "New line" button; larger targets; ideally show `§c` in the box and escape on save.

**SET11. "Remove icon" is always enabled and never asks** | flow | low | S. It posts and toasts "Icon removed." even when there is no icon. The icon saves at once while the MOTD beside it waits for Save. Evidence: `:8640-8647`, `:8614`. Fix: hide it when `img.dataset.none`; keep the "Saved at once" note next to the buttons.

**SET12. No webhook test, and the saved webhook is shown in full** | gap | medium | M. There is no "Send a test message"; a wrong link is only discovered at the next crash (failures are just logged, `notify.mjs:28-31`). The value is a credential (comment `ui.mjs:2091`) but is displayed in clear. Evidence: `:11332-11364`. Fix: "Send test" button with the result inline; mask after save with "Show".

**SET13. Java picker wording** | wording | medium | S. Extends C4 beyond the placeholder: "on PATH", "Whatever \"java\" resolves to on PATH", "Javas", "paste the path to java.exe" on every platform, and the download address printed as plain text. A Java marked "too old for this server" can be chosen and saved with no warning. Evidence: `:11414-11425`. Fix: "Java 21 (system default)"; "Choose another Java…"; a link "Get Java"; warn on save.

**SET14. Java argument and Java path errors arrive as toasts after Save** | error state | low | S. The webhook and memory fields validate as you type; arguments do not, and "<path> could not be run: <message>" is raw. Evidence: `ui.mjs:2075`, `registry.mjs:179-184`. Fix: same inline note under the field.

**SET15. The "Java arguments" label points at a hidden box** | accessibility | low | S. `for="s_jvmFlags"` targets the textarea, which is hidden until the checkbox is ticked. Evidence: `:11502`, `:11481`. Fix: point the label at the checkbox.

**SET16. "⋯ → Upgrade…" is a dead end on Fabric, Forge, Vanilla and Spigot servers** | flow | medium | S. The menu item is always present and says "under Server software", but that section only exists for Paper, Purpur, Folia and ASP; `openUpgrade` then just opens Settings at the first section. Evidence: `:4505`, `:4560-4566`, `:11520`. Fix: hide or disable the item with the reason; or show the section with "SpawnLoft cannot update <software> yet."

**SET17. Only the newest Minecraft version is offered** | gap | medium | M. `newerVersions[0]` is the only choice; a server on 1.21.4 cannot move to 1.21.8 if 1.22 exists. Evidence: `:11592-11593`. Fix: a select of newer versions.

**SET18. "The jar it runs now stays in the folder as the way back" has no way back in the panel** | flow | medium | M. No control in ui.html switches to an older jar (searched for `oldJars`, `strayJars`, and any post of `jar`); the settings endpoint accepts `jar` (`ui.mjs:2065`). Evidence: `:11569`. Fix: "Go back to build <n>" after an update.

**SET19. Update messages** | wording | low | S. "Now on paper-1.21.4-130.jar." is a file name; no Restart button follows "Restart to load it."; "Downloading…" has no progress; the confirm title uses the folder id (A10) and says "standard snapshot" (B1, B7); a check result is lost when the form rebuilds. C6 covers "Now on undefined." Evidence: `:11578`, `:11601-11604`, `:11616`. Fix: "Updated to Paper 1.21.4 build 130." with a Restart action.

**SET20. A file saved from the raw editor shows up in Backups as "Before an AI edit"** | wording | medium | S. The raw save labels its copy `before-edit`; Backups names that "Before an AI edit" with the tooltip "as it was before an AI assistant changed it". Evidence: `ui.mjs:432`; `:10331`, `:10884-10885`. Fix: a separate label for the panel's own editor ("Before an edit").

**SET21. Detach wording, and a CLI flag in its error** | wording | medium | S. "The user goes away", "Drop the database too" are database terms; the same dialog is used for Redis, where there is no user and no tables. Choosing drop on a stopped database returns "…start it first, or detach without --drop". Evidence: `:12299-12307`; `services.mjs:246`. Fix: "Remove <server>'s login" / "Also delete its data"; branch for Redis; disable the drop choice when the database is stopped.

**SET22. "Create a database" can be pressed again to make a second one** | flow | medium | S. After one is attached the button stays (as a text-style button) and each press downloads and starts another MySQL with no confirm, size or cancel; on failure the error is shown twice (hint and toast). Evidence: `:12332-12368`. Fix: confirm when one already exists; say the download size; one error place.

**SET23. Stopped databases are offered for Attach, then refused** | flow | low | S. The select lists "(stopped)" entries; Attach returns "\"x\" is not running - start it first, then attach". The select has no label. Evidence: `:12385-12391`, `:12414`; `services.mjs:231`. Fix: "Start and attach"; `aria-label="Database to attach"`.

**SET24. Credentials dialog** | flow | low | S. The password is shown at once (the database page masks it), there is no per-field copy, "Copy" closes the dialog, and the copied text leaves out the Redis key prefix that the dialog shows. Title uses ids ("survival on mydb"). Evidence: `:12199-12234`, `:12148` vs `:12161-12168`. Fix: same masked rows with per-field copy as the database page; keep the dialog open after Copy.

**SET25. No "apply to plugin"** | gap | low | L. The section says outright "SpawnLoft does not edit plugin configs." Evidence: `:12255`. Fix (later): offer to write the storage block for known plugins, with the same copy-first safety as Files.

**SET26. Name and port are not in Settings; memory is in two places** | consistency | medium | M. Rename and port live only in "⋯ → Rename, memory and port…" (`:4510`), which needs the server stopped, while Memory is also a Settings row that saves while running. Evidence: `:4509-4510`, `:11453`. Fix: a "General" section with name and port; make the ⋯ item open it.

**SET27. Section nav jumps when "Databases" arrives** | scaling | low | S. It is inserted after the async read. Evidence: `:11894-11901`. Fix: add the nav entry up front with a loading body.

**SET28. Tags and save bar are not announced** | accessibility | low | S. "Changed"/"Default" meanings are tooltip-only; the bar's count and "Fix the field marked in red to save." have no `aria-live`; "red" is the only pointer to the bad field. Evidence: `:11692`, `:11638-11655`, `:11707`. Fix: `role="status"` on the bar; name the field ("Fix Max players to save").

**SET29. "Discard" resets every section, including ones not on screen, with no undo** | flow | low | S. Evidence: `:11717-11720`. Fix: "Discard N changes?" when more than one section is affected.

**SET30. Raw file and form are two save models on one page** | clarity | low | M. The raw view has its own "Save file" that writes at once and is not counted in the bar; at Ultra both are visible with two different Save buttons. Evidence: `:11760-11766`, `:11779`. Fix: label the raw side "Advanced: edit the file directly" and say "Saves separately from the settings on the left."

### Keep
- The form is generated from the server's own list, so a new setting needs one line.
- Changed and Default tags, section dots, one Save for two back ends (already in the scan's "works well").
- The online-mode warning counts the players it will affect, before the choice is saved.
- Number ranges and the webhook are checked as typed.
- The launch line shows exactly what the arguments checkbox means.
- Version upgrades are confirmed by name and backed up first.

---

## 6. Database pages

### Inventory
- Header (`renderServer` with `isDb` `:4568`): name; state pill "Running", "Stopped", "Reachable", "Unreachable", "Starting…", "Stopping…" `:3961`, `:4196`; meta "<engine> <version>, runs elsewhere · host:port" with copy `:4244`; vitals "Memory" (title "The whole database process") and "Attached" ("a, b" or "nothing yet") `:4393`; Start / Stop / Restart hidden for databases that run elsewhere `:4622`; no command row `:4638`.
- Menu "More actions" (⋯) `:2881`: one item "Manage this database…" with hint "Rename it, see its credentials, or delete it." `:4496`.
  - Manage dialog, external: "Manage <id>", "This database runs elsewhere. Forgetting it here leaves it exactly as it is; only the record and its attachments go.", one choice "Forget this database" ("Servers attached to it keep whatever their plugin configs say."), "Continue" `:12080`.
  - Manage dialog, managed: running "This database is running. Stop it first to delete it. Servers attach to it from their own Settings tab." with one choice "Open its folder" ("Shows the data folder in Explorer."); stopped "Choose what to do with this database." with "Open its folder" and "Delete this database" ("Removes it from SpawnLoft, and optionally its data."), "Continue" `:12090`.
  - Delete dialog `:12110`: "Delete <id>?", "Attached: a, b. Their plugin configs will still name this database.", choices "Remove from SpawnLoft, keep the data" ("The folder stays where it is.") / "Delete the data as well" ("Every database and table on it goes. There is no snapshot of a database yet."), type the name, "Delete database". Toasts "Deleting <id>…", "Deleted, data and all." / "Removed from SpawnLoft. The data is still in its folder."
- Tool dock: Console, Backups, Activity, Stats, Settings (`DB_TOOLS` `:3803`); opens on Settings by default `:3823`.
- Console: empty text "This database runs elsewhere, so its log is on that machine, not here." / "No output yet. Start the database and its log appears here as it runs." `:6252`.
- Settings ("Database settings", "Where it listens, how to reach it as root, and which servers have a database on it.") `:12620`
  - Unreachable notice `:4756`: "Not answering", "Nothing replied at host:port. Start it where it runs, or correct the address, then check again.", "Check again", "Edit address" (external only).
  - "Connection" card: blurb (external) "Registered with its address and admin credentials; it is run and stopped where it lives. Servers are attached to it from their own Settings tab."; (Redis) "Loopback only: nothing outside this machine can reach it. One password and one key space, shared by every server attached; plugins prefix their keys."; (MySQL) "Loopback only: nothing outside this machine can reach it. Servers get their own user and database; root is for you." Rows "Engine", "Host" (copy), "Port" (copy), "Folder", "Admin login" (Redis: "Password") shown as "••••••••" with "Show"/"Hide" and "Copy"; shown rows User, Password, URL, each a copy button. Toast "Copied the admin login." / "Copied the connection details."
  - "Edit address" (external) `:4684`: "Host", "Port", "Admin user" ("Empty keeps the one saved."), "Password" ("Empty keeps the one saved."), "Save", "Cancel". Toasts "Saved. <name> answers at host:port." / "Saved, but nothing answers at host:port yet."; errors "\"x\" is not a host name or address", "N is not a port number" (`services.mjs:311,316`).
  - "Attached servers": "Each has a database and a user named after it. Attach a server from its own Settings tab."; empty "No server uses this database yet. Attach one from that server's Settings."; row: server link (or "<name> (removed)"), "database <db> · user <user>" or "key prefix <name>:", "Show credentials".
- Backups (`renderDatabaseBackups` `:12439`): "SQL dumps of this database, kept apart from the servers' snapshots. Download one to keep a copy somewhere else."
  - Redis: "<engine> keeps its own checkpoints on disk, so there is nothing here to dump. Back up the servers that use it instead."
  - "Back up now": "Dumps a, b — the databases your servers use here — into one .sql file." / "No server is attached to this database yet, so there is nothing of yours in it to dump." / "Start the database first: a dump is read from the running database."; field "Label (optional)"; button "Back up now" → "Dumping…"; toast "Backed up <name> to <file> (<size>)."
  - "Backups (N)", "Kept in <folder>"; empty "No backups of this database yet. Back up now, before a plugin update or a migration, and there is a way back."
  - Table head "Backup", "Label", "Reason", "Databases", "Size"; row actions "Download", "Restore" (disabled when stopped; title "Start the database to put a backup back into it"), delete icon.
  - Restore dialog: "Put <name> back as it was?", "The tables in <file> replace the ones there now, and anything written since it was taken is lost from them. A backup of how things are now is taken first, so this can be undone from this list. Stop the servers that use it first if they are writing to it.", type the name, "Restore". Toasts "Putting back <file>…", "Put back <file>. How it was before is saved as <file>."
  - Delete dialog: "Delete this backup?", "<file>, <size>. Download it first if you want to keep a copy.", "Delete backup". Toast "Deleted <file>."
- Activity and Stats: the server pages, unchanged (see ACT16, STA10).

### Findings

**DB1. Deleting an external database claims "Deleted, data and all."** | error state | high | S. "Forget this database" opens the ordinary delete dialog with "Delete the data as well" ("Every database and table on it goes"). For an external database the server deletes nothing, but still returns `purged: true`, so the toast says "Deleted, data and all." Evidence: `:12087`, `:12116-12119`, `:12131`; `services.mjs` `removeDatabase` (`if (purge && inst.dir && !inst.external)` … `return { purged: purge }`). Fix: for external databases skip the choices: "Forget <name>? It keeps running where it is; SpawnLoft only forgets its address." with a "Forget" button and a matching toast.

**DB2. The menu promises things it does not offer** | wording | medium | S. Extends F11. The hint says "Rename it, see its credentials, or delete it." The dialog offers "Open its folder" and (stopped only) "Delete this database"; there is no rename anywhere for a database, and credentials are on the Settings page. Evidence: `:4496`, `:12084`, `:12097-12100`. Fix: real menu items ("Open folder", "Delete…" disabled with "Stop it first"), as servers have; add Rename or drop the word.

**DB3. Copying the admin password prints it in a toast and a tooltip** | privacy | medium | S. The revealed rows use `addrButton`, which sets `title="Copy <value>"`, `aria-label="Copy password <value>"` and toasts "Copied <value>." The page masks the password precisely so it is not left on screen. Evidence: `:12710`, `:5075-5078`. Fix: for secrets, toast "Copied the password." and a title of "Copy password".

**DB4. Stopping a database does not mention the servers using it** | flow | medium | S. Stop and Restart act at once (as A3), even with attached servers running that will lose their storage. Evidence: `:6652-6672` (no check), `:4395`. Fix: confirm "survival and lobby are running and use this database."

**DB5. An unreachable database only says so on its Settings page** | missing state | medium | S. The header strip is suppressed for this state (`:4604`) in favour of the box inside Settings; on Console, Backups, Activity or Stats only the small pill shows it. Three names are used for one state: pill "Unreachable", notice "Not answering", unused note "Unreachable". Evidence: `:4601-4612`, `:4773`, `:3965`, `:3978`. Fix: show the notice above every tool; one word.

**DB6. "Check again" gives no answer when it is still down** | missing state | medium | S. The notice only repaints when the state flips, so a failed re-check looks like nothing happened. Evidence: `:4760`, `:4764-4769`. Fix: "Still not answering (checked 10:42)."

**DB7. For a managed database the unreachable text tells you to "Start it where it runs, or correct the address"** | wording | low | S | whether a managed database can report `unreachable` is unverified (`ui.mjs:1670` sets it only for external). Evidence: `:4774-4775`. Fix: branch the sentence on `row.external`.

**DB8. Restore does not lock the list** | flow | high | S. Extends B8 to databases: during a restore nothing is disabled, so Restore, Delete or "Back up now" can be pressed on top of it; the "Putting back…" toast disappears after 5 seconds (A2). Evidence: `:12584-12596`. Fix: disable the list and show progress in the row.

**DB9. Errors carry CLI wording** | wording | medium | S. Extends C1: "a version is required - see: spawnloft db versions", "…or detach without --drop", "…run \"spawnloft kill <name>\" before deleting it". Evidence: `services.mjs:100,246`; `control.mjs:99`. Fix: panel-specific messages.

**DB10. Backups page wording** | wording | medium | S. Extends B1 and C3 with the rest: "SQL dumps", "Dumps a, b … into one .sql file", "nothing of yours in it to dump", "checkpoints", "migration", and the Restore title "Put <name> back as it was?" beside a button called "Restore". Evidence: `:12476`, `:12489-12491`, `:12479`, `:12575-12579`. Fix: "Backups of this database. Download one to keep a copy elsewhere."; "Backs up the data your servers keep here."; title "Restore this backup?".

**DB11. Redis has a Backups page that can do nothing** | missing state | low | S. It shows only the "nothing here to dump" message. Evidence: `:12478-12482`. Fix: hide Backups for Redis, or link to the attached servers' Backups.

**DB12. No automatic backups for a database, no upload of a .sql file, no "keep N"** | gap | medium | M. Schedule is not among a database's tools and the list grows without limit. Evidence: `:3803`, `:12484-12518`. Fix: reuse the automatic-backup card from server Backups.

**DB13. Download gives no feedback** | missing state | low | S. A hidden link is clicked and nothing on the page changes. Evidence: `:12564-12571`. Fix: toast "Downloading <file>…" (in the app, the saved path).

**DB14. Delete of a backup is an unlabeled trash icon while its neighbours are words; table head is read aloud here but hidden on the server list** | consistency | low | S. Extends F11. Evidence: `:12553-12557`, `:12531` vs `:10853`. Fix: same row actions and the same `aria-hidden` on both lists.

**DB15. Delete dialog uses the folder id and still says "no snapshot of a database yet"** | wording | low | S. Extends F11 and A10: titles "Manage <id>", "Delete <id>?" use `row.name`, not the label; the attached line reads "Attached: a, b. Their plugin configs will still name this database." Evidence: `:12081`, `:12111-12118`. Fix: use the label; "survival and lobby use this database and will stop being able to save to it."

**DB16. "Open its folder" hint says "Explorer" on every platform** | wording | low | S. Extends C4; the constant `FILE_MANAGER` already exists. Evidence: `:12097`, `:12099`, `:4235`.

**DB17. Connection card wording** | wording | medium | S. Extends C3 ("Loopback only", "root is for you") with: "key space", "plugins prefix their keys", "Registered with its address and admin credentials", "how to reach it as root". Evidence: `:12626`, `:12657-12660`. Fix: "Only this computer can connect to it. Each server gets its own login; the admin login below is for you."

**DB18. "Edit address" also changes the admin login** | clarity | low | S. The button names only the address; the form includes "Admin user" and "Password". Evidence: `:4686`, `:4711-4712`. Fix: "Edit connection".

**DB19. Attached servers cannot be detached or attached from the database's own page** | flow | medium | M. The list has only "Show credentials"; the page says twice to go to the server's Settings. A server that was deleted shows as "<name> (removed)" with no way to clear it. Evidence: `:12736-12762`. Fix: "Detach" per row and an "Attach a server" select here.

**DB20. For a database that runs elsewhere, Console, Stats and the Memory figure are permanently empty** | missing state | low | S. Console says its log is "on that machine", Stats never has data, and the header shows "Memory —" with the tooltip "The whole database process". Evidence: `:6252`, `:4393-4400`, `:3803`. Fix: hide Console, Stats and the Memory cell for external databases.

**DB22. "Settings tab" for a page** | wording | low | S. "Servers attach to it from their own Settings tab." appears three times while the panel has pages, not tabs. Evidence: `:12093`, `:12657`, `:12737`.

### Keep
- A database opens on its connection details, not an empty log.
- The admin password is masked, fetched only when asked for, and dropped when hidden.
- External databases get no Start/Stop buttons instead of dead ones.
- Restore takes a backup of the current state first and says so; delete says to download first.
- The address form never holds the old password ("Empty keeps the one saved.").
- The unreachable notice sits beside the address with "Check again" and "Edit address".

---
