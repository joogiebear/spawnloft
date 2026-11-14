# Page by page, part 2: Plugins and Mods, Files, Worlds, Backups, database Backups

Part of the [UX scan](../ux-scan-2026-11.md). Each page has an **Inventory** (every control, menu, dialog, message and state, with its wording and where it is in the code), **Findings**, and **Keep** (what already works and should not be lost).

Findings read: **id. title** | kind | severity | size (S is small, a few hours at most; M is about a day; L is several days or needs a design decision first). Everything in this part was confirmed by reading the code at `552082d`; line numbers are `src/ui.html` unless another file is named. Findings that were also seen in the running panel are listed in [part 5](05-seen-in-the-running-panel.md). "extends A2" and similar point at the [first pass](first-pass.md). "unverified" marks a consequence that could not be observed.

---

## 0. Shared by all four pages

### Findings

**X1. Plugins, Worlds and Files do not notice the server starting or stopping** | missing state | high | M
Each pane bakes `data.running` in when it is drawn and returns early if already drawn for this server (`:7655`, `:8214`, `:9344`). Only `select()` of another server clears the cache (`:6342-6348`), and `#filesBody` is not in that list. Nothing re-renders them on a state change (`renderServer` does not, `:4568`). So after pressing Stop in the header, Worlds still shows "Set active" and "Delete" greyed with "Stop the server first" (`:8357-8365`), Plugins still says "The server is running, so everything here takes effect the next time it starts." (`:7701`), and Files keeps its "In use" pills. Reopening the tool does not refresh it either. Backups is the only one of the four that polls (`:10424`).

Fix: when `row.status` changes for the current server, re-render the open pane (or at least clear `dataset.for`).

**X2. Every action rebuilds the whole pane and drops keyboard focus** | accessibility | medium | M
`again()` clears `body` and redraws (`:7688`, `:8232`, `:9372`; Backups `renderBackups({force:true})` at `:10958`, `:10974`, `:11035`). After Disable, Delete, Install, Set active, Lock or Add a note, focus falls to `<body>`. Extends F6, which only covers the Files checkbox.

Fix: restore focus to the same control on the same row after the redraw (key rows by file or name).

**X3. Escape in any field closes the whole tool** | flow | medium | S
The global handler closes the tool whenever focus is inside `#toolPanel` (`:14090`). Only the editor textarea stops it (`:9992-9996`). Escape in the Plugins search, the Files "Find" box, the Worlds import fields or the "Leave out of backups" box closes the pane instead of clearing the field. On Plugins the typed search and results are gone when reopened only if the pane re-renders; the Worlds form is kept.

Fix: ignore Escape when the target is an `input`, `textarea` or `select` (or let the first Escape clear or blur).

**X4. Typed dialog input is lost on a validation error** | flow | medium | M
`ask()` closes before the request is sent, and the refusal arrives as a toast. Affects New file (`:9443-9450`), New folder (`:9453-9458`), Rename or move (`:9508-9519`), Zip name (`:9523-9531`), the backup note (`:10965-10975`), and the backups and mirror folder paths in a browser (`:10380-10408`, `:10823-10838`). Same pattern as F3, in new places.

Fix: an `ask({ validate })` hook that keeps the dialog open and shows the error under the field.

**X5. Busy labels wipe the button's icon and it never comes back** | consistency | low | S
`go.textContent = 'Importing…'` then `'Import'` (`:8292`, `:8301`), `exp.textContent = 'Exporting…'` then `'Export'` (`:8386`, `:8394`), `install.textContent = 'Downloading…'` (`:7892`). The `busy()` helper at `:6778` already does this properly (keeps the icon, sets `aria-busy`) and is not used here.

**X6. One glyph, four meanings** | consistency | low | S
The `restore` icon is used for "Check for updates" (`:7927`), "Check for a newer release" (`:7738`), "Restore" (`:10922`) and Activity's "Undo" (`:10194`). The `archive` icon is both "Zip" and "Unzip" (`:9487-9488`), "Export" (`:8359`) and "Back up now" (`:10511`). The `folder` icon is both "New folder" and "Upload a folder" (`:9427`, `:9429`).

**X7. Two size formats** | consistency | low | S
Files uses the client `fileSize()` ("12 MB", "1.5 KB", `:9306`). Worlds and Backups use the server's `humanBytes` ("12.0 MB", `src/util.mjs:392`). The same file shows two ways in Files and in a toast.

**X8. Loading skeleton has no accessible name in practice** | accessibility | low | S
`aria-label="Loading"` and `aria-busy` sit on a plain `div` with no role (`:6753-6756`), which screen readers ignore. Add `role="status"`.

**X9. Player-list columns leak into Worlds and plugin search rows** | scaling | low | S
Worlds rows and search results reuse `.who` (`:7863`, `:8323`). At pane width ≥1280 `.who` reserves `180px 104px` for "seen" and "id", and `180px 300px` at ≥2000 (`:1906-1916`). These rows have neither cell, so 284 to 480px of every row is an empty gap between the text and the buttons on big screens.

Fix: a row class of their own, or scope the tier rule to `#playersBody`.

---

## 1. Plugins (and Mods)

### Inventory

- **Dock:** button "Plugins" / "Mods" (`:2767`, `:4583`); badge with a count and aria-label "Plugins, N update(s) ready" (`:7631-7640`).
- **Server runs nothing (Vanilla)** (`:7672-7680`)
  - Head: "{software} runs no plugins and no mods."
  - Hint: "Mojang's own server loads nothing beyond the game. For plugins, create a Paper, Purpur or Spigot server; for mods, a Fabric or NeoForge one."
- **Head** (`:7683-7685`): "Install from {Modrinth or Hangar | Modrinth} and keep it updated. {Plugins|Mods} you added by hand are left alone."
- **State hint** (`:7700-7705`)
  - Running: "The server is running, so everything here takes effect the next time it starts."
  - Stopped: "Applies the next time the server starts."
  - Plus, when the game version is known: " Builds for {mc} are preferred; anything else installs with a note."
- **Modpack section** (`:7710-7804`)
  - h3 "Modpack"; "{name} {version}. Players join with the matching client pack, installed in their own launcher: " then button "Open on Modrinth" (app) or the raw URL as a link (browser).
  - Button "Check for a newer release" → "Asking Modrinth…" → "This is the newest release of the pack." or "Release {v} is out." plus primary "Update pack to {v}".
  - Dialog "Update {pack} to {v}?": "The server must be stopped. A standard snapshot is taken first; only files the old pack owned and the new one dropped are removed - the worlds and anything you added by hand are never touched. Players will need the matching new client pack." Button "Update pack" (danger).
  - Progress: job messages written into the hint line.
  - Toasts: "Already on the newest release." / "Updated to {v}. Snapshot taken first; {n} old pack file(s) retired." plus optional " Minecraft moved to {mc} - the worlds migrate on the next start."
- **Search** (`:7809-7910`)
  - Input placeholder and aria-label "Add from Modrinth or Hangar" / "Add from Modrinth" / "Add mods from Modrinth"; button "Search"; Enter searches.
  - Loading: "Asking Modrinth and Hangar…" / "Asking Modrinth…".
  - Whole-request error: red line with the raw message. Per-source errors: red lines above the results (`:7847-7852`).
  - Empty: "Nothing on {sources} matches that for {mc}." (`:7854`).
  - Result row: plug icon, title, pill "Modrinth" / "Hangar", "{n} downloads · {description}", button "Install" (primary) or "Installed" (disabled).
  - Install: button reads "Downloading…"; toast "Installed {file} ({version})."; a second neutral toast with the version note; errors as a toast.
  - There is no incompatible state, no "no version for this Minecraft" state before pressing, no icon, author, version or link.
- **Updates callout** (`:8017-8038`): "{n} update(s) ready", the names comma-joined, primary "Update all" / "Update and restart", progress line (aria-live).
- **Installed list** (`:7922-7932`, `:8040-8195`)
  - Head "Installed ({n})"; ghost button "Check for updates".
  - Check note: "Asking Modrinth and Hangar about everything SpawnLoft installed…" → "Everything SpawnLoft installed is already the newest build."
  - Empty: "No {plugins|mods} yet. Search {sources} above and they land in this server's {kind} folder." plus button "Find {kind}".
  - Row: monogram tile; name; source line "Added by hand" / "Hangar" / "Modpack" / "Modrinth" plus the jar file name in code type when it differs; version or "—" (tooltip "The jar does not say which version it is"); "Enabled" / "Disabled" with a filled or hollow dot.
  - Row buttons: "→ {latest}" (primary; aria "Update {name} to {v}"), "Disable" / "Enable", trash (aria "Delete {name}").
  - Row tooltip: description, file and size, authors.
- **Update one** (`:8140-8156`): "Updating…"; toasts "{name} is already the newest build." / "Updated {name} to {v}. A plugins snapshot was taken first."; then the version note.
- **Enable/Disable** (`:8159-8169`): toast "{name} disabled. Takes effect on the next start." / "{name} enabled. …".
- **Delete** (`:8171-8193`)
  - Dialog "Delete {name}?": "{file} is removed from the {kind} folder. Its config folder stays, so installing it again picks up where it left off." For hand-added: " It was added by hand, so SpawnLoft cannot download it again; keep a copy if you might want it back, or Disable it instead."
  - Button "Delete plugin" / "Delete mod"; toast "Deleted {file}."
- **Update all** (`:7971-8015`)
  - Dialog "Update {n plugins} and restart?" / "Update {n plugins}?": "A snapshot of the {kind} folder is taken first, then each is updated in turn, and {server} restarts to load them. Anyone online is disconnected for the restart." or "…. They load the next time the server starts."
  - Buttons "Update and restart" / "Update all".
  - Progress: "Updating {file} ({i} of {n})" (`src/ui.mjs:1114`), then "Restarting {server}…".
  - Toasts: "{name} was not updated: {error}"; "Updated {n} plugins. A snapshot of the {kind} folder was taken first."; then the standard restart toasts.

### Findings

**PL1. Nothing is done about dependencies** | gap | high | L
`plugins.mjs` never reads `depend` from plugin.yml or Modrinth's dependency list (no match for "depend" in `src/plugins.mjs`). A Fabric mod that needs Fabric API, or a plugin that needs Vault or ProtocolLib, installs with "Installed … " and then fails at the next start. Every mainstream panel with a Modrinth installer offers the required ones.

Fix: after picking a version, list its required dependencies not already installed and offer "Install these too".

**PL2. A build for the wrong Minecraft version installs without asking, and the warning vanishes in 5 seconds** | flow | high | M
The install falls back to "the newest build for the loader" (`src/plugins.mjs:565-571`, Hangar `:537-539`). The only signal is a second neutral toast (`:7898`) such as "Its newest build lists 1.20.4, not 1.21.4 - it may run anyway, but that is its author's claim, not SpawnLoft's.", removed after 5.2 s (`:3650`). Nothing on the installed row records it.

Fix: ask before installing a mismatched build, and show a small "Built for 1.20.4" note on the row.

**PL3. Installing one result throws away the search** | flow | high | S
After an install, `again()` redraws the pane (`:7899`), so the query, results and scroll position are gone. Installing three plugins from one search means searching three times.

Fix: on success, mark that row "Installed" and refresh only the Installed list.

**PL4. The Plugins page lets you rename or delete a jar the running server has loaded; Files refuses the same thing** | consistency | medium | M
Files marks `plugins/*.jar` "In use" and refuses move and delete while running (`src/files.mjs:88-91`). Plugins' Disable (a rename) and Delete have no such check (`src/plugins.mjs:334-352`). On Windows a held jar fails with a raw system error through the 500 path (`src/ui.mjs:125-126`); the exact text is unverified.

Fix: decide one rule. If allowed, catch the "file is busy" case and say "Stop the server to remove this one."

**PL5. Deleting a plugin keeps no copy, and the dialog does not say so** | flow | medium | S
`removePlugin` is a plain delete (`src/plugins.mjs:345-351`). Deleting the same jar in Files keeps a copy first (`src/files.mjs:331`). Install and update both take a plugins-folder snapshot; delete does not.

Fix: take the same snapshot, or say "No copy is kept" in the dialog.

**PL6. "Installed" in search results is matched by display name** | clarity | medium | S
`installedNames.has(hit.title.toLowerCase())` (`:7860`, `:7882`) compares the Modrinth project title with the name inside the jar. They often differ (title "EssentialsX", jar name "Essentials"), so installed plugins show a live "Install" button and a second copy can be added. The server already records the project id for managed jars (`src/plugins.mjs:319`).

Fix: match on `source` plus `project`.

**PL7. "Update and restart" has no "update now, restart later"** | flow | medium | S
On a running server the only choice is Update and restart or Cancel (`:7972-7981`). `ask()` already supports `choices`.

Fix: two choices, "Restart now" and "I'll restart later".

**PL8. "Update and restart" silently skips the restart if you look at another server** | missing feedback | medium | S
The restart only runs `if (… state.current === row.name)` (`:8010`), and `act('restart')` also returns silently when another action is in progress (`:6654`). The user confirmed a restart and gets none, with no message.

Fix: restart by name, not by what is on screen, and toast if it could not.

**PL9. Only two buttons are locked during Update all** | missing state | medium | S
`button.disabled` and `check.disabled` only (`:7983-7984`). Row Update, Disable, Delete, Install and the pack update stay live while jars are being swapped.

**PL10. "Everything SpawnLoft installed is already the newest build" when nothing was checked** | wording | medium | S
`checkUpdates` returns an empty list when no jar is managed and enabled (`src/plugins.mjs:609-610`), skips disabled plugins, and swallows Hangar failures (`:659-661`). The page then prints the all-clear (`:7954-7956`).

Fix: return what was checked and what could not be: "Checked 6. 3 added by hand cannot be checked. Hangar could not be reached."

**PL11. "Updates ready" never expires and has no date** | clarity | medium | S
The check result is kept in localStorage with no timestamp (`:7623-7628`). The callout and dock badge can show weeks-old results, and "Check for updates" only ever runs by hand.

Fix: store the time, show "Checked 3 days ago", and re-check quietly when older than a day.

**PL12. Search says "for {version}" but does not search by version, and has no "more"** | wording | medium | S
Search is deliberately not filtered by game version (`src/plugins.mjs:393-394`), yet the empty text says "Nothing on Modrinth or Hangar matches that for 1.21.4." (`:7854-7855`). Results are capped at 20 from Modrinth and 10 from Hangar (`src/plugins.mjs:395`, `:462`) with no count and no way to load more. A plugin on both sites appears twice (`src/plugin-actions.mjs:21`).

**PL13. Result rows show too little to choose by** | gap | medium | M
Only title, source, downloads and description. The server already returns `icon`, `slug` and Hangar `author` (`src/plugins.mjs:407-415`, `:465-473`), unused. No link to the project page, no version that would be installed, and every row carries a primary "Install" (twenty primary buttons).

Fix: icon, author, "View page", and a plain Install with the primary reserved for the callout.

**PL14. Results are not announced** | accessibility | low | S
The results box has no `aria-live` or role (`:7820`). "Asking Modrinth…" and the result count are silent, and so is the check note (`:7929`).

**PL15. The update button is just "→ 5.4.1"** | clarity | low | S
`:8117`. The aria-label is good; the visible label is an arrow and a number in a primary button on every row, competing with the callout's primary.

Fix: "Update to 5.4.1", plain style.

**PL16. Single update: "A plugins snapshot was taken first." on a mods server** | wording | low | S
Hardcoded at `:8148`; Update all uses `data.kind` (`:8008`). Also "snapshot" (extends B1).

**PL17. No pending-change marker; "Enabled" means "file is named .jar"** | clarity | medium | M
After Disable on a running server the row says "Disabled" while the plugin is still loaded. Extends F7 (no Restart beside the notice): nothing marks which rows are waiting for a restart, and none of the toasts (`:8163`, `:8148`, `:7895`) offers Restart.

**PL18. Row facts are a tooltip on a row that cannot be focused** | accessibility | low | S
Extends F7. `el.title` (`:8071`) is shown by the custom tooltip when a child button gets focus, so focusing "Disable" pops the description and attaches `aria-describedby` to the row, not the button (`:6846`, `:6834`).

**PL19. Pack update is offered while the server runs, then refused** | flow | medium | S
`data.running` is known, but the dialog just says "The server must be stopped." (`:7771`) and the request fails with `"{id}" is running - stop it before updating its pack, or its own files change under it` (`src/mrpack.mjs:437`).

Fix: disable with a visible reason, or offer "Stop and update".

**PL20. Pack wording** | wording | low | S
"retired", "migrate", "A standard snapshot" (`:7771`, `:7791-7793`). The success toast tells players they need a new client pack and disappears in 5 seconds. In a browser the pack link is the raw URL with `color: inherit` (`:7728-7733`); whether it is visibly a link is unverified.

**PL21. Update all progress and toasts use jar file names** | wording | low | S
"Updating EssentialsX-2.20.1.jar (1 of 3)" (`src/ui.mjs:1114`) and "Deleted EssentialsX-2.20.1.jar." (`:8187`), while titles use the plugin name.

**PL22. Hangar "hosted elsewhere" error is a URL in a toast** | flow | low | S
"that project hosts its downloads elsewhere: {url}\n  Download it by hand and drop it into the plugins folder - SpawnLoft will leave it alone." (`src/plugins.mjs:500-502`). The link is not clickable and the message starts lower-case.

Fix: a result-row state "Download from its own site" with an Open button.

**PL23. Vanilla state is a dead end** | flow | low | S
Text only (`:7673-7679`); no button to the place where server software is changed.

**PL24. No rule for narrow or wide panes** | scaling | low | M
`.plug` is one fixed grid (`:1815-1817`) with no container rule. At an Ultra pane the name sits at the far left and the version, state and buttons about 1,800px away. Description, authors and size (F7's tooltip-only facts) are the obvious extra columns for the Wide and Ultra tiers.

**PL25. Gaps against other panels** | gap | medium | L
- No "Add a plugin file" (upload a .jar) on this page; the only route is Files.
- No filter or sort for a long installed list.
- No "Open its config" link into Files.
- No "what's new" or project link before updating.
- No choice of version, downgrade or "skip this update".
- No option to remove a deleted plugin's data folder.
- No note that players need the same mods on a mods server (only packs say so).

### Keep
- The installed list works offline, and hand-added jars are listed and can be switched off.
- State is a word plus a filled or hollow dot, not only dimming.
- One confirm for Update all that names the restart and that players are disconnected; per-item progress is `aria-live`.
- The delete dialog explains that hand-added jars cannot be re-downloaded and suggests Disable.
- The dock badge has a spoken label.
- A failed update leaves both jars rather than none.

---

## 2. Files

### Inventory

- **Head** (`:9370-9371`): "Everything in this server's folder. An edit, a replaced file or a delete keeps a copy first, which Backups can put back."
- **Running hint** (`:9378-9379`): "The server is running: files it holds open are marked In use and cannot be moved, replaced or deleted until it stops." Tooltip only: "The active world, its jar and the plugins it loaded. They can still be read and edited; a changed config applies when the plugin reloads or the server restarts."
- **Toolbar** (`:9384-9473`)
  - Breadcrumb (`nav aria-label="Folder"`): server name, "/" separators, folder buttons, `aria-current="location"`.
  - Search: placeholder "Find in this folder" / "Find a file", aria "Find files by name", Enter only; toast "Search for at least two characters."
  - Buttons: "New file" (ghost), "New folder" (ghost), "Upload files" (primary), "Upload a folder", "Open in Finder/Explorer/your file manager" (ghost).
- **Dialogs**
  - "New file in {dir | the server folder}": field "Name", placeholder "config.yml", button "Create".
  - "New folder in …": field "Name", button "Create".
- **Selection bar** (`:9478-9541`): "{n} selected"; then:
  - "Download" (one item only).
  - "Rename or move" (one item only). Dialog "Rename or move {name}": "A new name, or a path from the server folder to move it somewhere else."; field "New path"; button "Rename".
  - "Zip". Dialog "Zip {name | n items}": field "Archive name"; button "Zip"; toast "Made {path} ({size})."
  - "Unzip" (one .zip, .mrpack, .tar.gz or .tgz). Toast "Unpacked into {path}."
  - "Delete" (danger).
  - "Clear".
  - In-use tooltip on Delete and Rename: "{name} is in use by the running server".
- **Search heading** (`:9548`): "{n}{+} named like "{q}"".
- **List** (`:9551-9649`)
  - `role="table"`; columns Name, Kind (≥1280), Size, Modified (hidden under 560; long form ≥2000).
  - Select-all checkbox; ".." row (aria "Up one folder").
  - Row: checkbox (aria "Select {name}"), a button with icon and name (the full path in search), pill "In use" (tooltip "The running server holds this. Stop it to move, replace or delete it."), link tooltip "A link that leads outside the server folder".
  - Kind values: Folder, Link, Other, File, Jar, YAML, JSON, TOML, Properties, Log, Archive, Text, Markdown, Script, Data, Region, Image, Lock, or the extension in capitals (`:9328-9337`).
  - Empty: "This folder is empty. Drop files or folders here, or use Upload." / "Nothing here is named like that."
  - Footer hint: "Drop files or whole folders onto this list to upload them here."
- **Drag and drop** (`:9657-9681`): dashed outline on the list; toasts "Nothing to upload: the folder is empty." and "Could not read {name}: {error}".
- **Upload** (`:9712-9763`)
  - Toast "Uploading {name | n files} to {where}…"; per-file error "{name}: {error}".
  - Dialog "Replace {name}?" / "Replace {n} files?": "… already in {where}. What is there now is copied to Backups first."; button "Replace".
  - Toast "Uploaded {n files | folder (n files)} to {where}."
- **Delete** (`:9765-9796`)
  - Dialog "Delete {what}?": "A copy is kept first, so Backups can put it/them back."; button "Delete"; toast "Deleted {what}. A copy is in Backups."
  - Over 1 GB: dialog "Delete {what} without a copy?": "That is {size}; keeping a copy first would take a while and as much space again. Deleted without one, there is no way back. Take a full backup first if there is any doubt."; type the file name or "delete"; button "Delete for good"; toast "Deleted {what}."
- **Open a file** (`:9798-9817`)
  - Not editable: dialog "{name} is not something to edit here" with "It is {size}, too big for the editor. Download it to open it in something made for files that size." (over 2 MB) or "It is not text - a jar, a world file or an image. Download it to open it elsewhere."; button "Download".
- **Editor** (`:9902-10065`)
  - Sub-head: the path.
  - Bar: "All files", a dot (tooltip "Unsaved changes"), "Reload", "Download", "Save" (primary; disabled when clean; "Saving…").
  - Line-number gutter; colouring for YAML, JSON and key=value files up to 300 KB.
  - Footer: "Line {n}, column {n}" and "{YAML|JSON|Key = value|Plain text} · Ctrl+S saves · Tab indents with spaces; Esc, then Tab, moves on".
  - Dialogs:
    - "Leave without saving?": "Your changes to {name} are not saved."; button "Discard changes".
    - "Save it with a mistake in it?": "{error}. Whatever reads this file may refuse to load it."; button "Save anyway".
    - "{name} changed on disk": "{path} has changed on disk since it was opened. Reload it to see the change, then make yours again. Reloading discards what you typed here; copy it first if you need it."; button "Reload it".
  - Toast: "Saved {name}. The previous version is in Backups; reload the plugin or restart the server to use it."
  - Server refusals shown as toasts (`src/files.mjs`): "{keys} is set by SpawnLoft at every start and would be put back. Change the port and RCON in the server's Settings instead."; "{path} already exists"; ""{name}" is not a name a file can have here"; "that name is too long"; "{path} is in use by the running server. Stop it first to {move|replace|delete} it."; "archive things from one folder at a time"; "a folder cannot be moved inside itself"; "that is its name already".

### Findings

**FI1. Uploads follow you if you change folder mid-upload** | flow | high | S
`send()` reads `view.dir` each time it is called (`:9720`), while `where` was captured once (`:9716`). Open another folder while a large upload runs and the remaining files land there, and the final toast still names the first folder.

Fix: capture `dir` once at the start.

**FI2. A dropped file that is not caught makes the browser open it; unsaved text is lost with no warning** | flow | high | S
There is no document-level `dragover`/`drop` guard and no `beforeunload` anywhere (grep finds neither). In the editor the pane's `ondragover` still accepts the drag (`:9658-9661`), but `ondrop` returns before `preventDefault()` (`:9666`), so the browser's default (navigate to the file) applies; whether the desktop shell blocks that navigation is unverified. A reload or closed tab with a dirty editor also loses the text silently.

Fix: always `preventDefault()` on drop, add a `beforeunload` while any editor is dirty, and show a dot on the Files dock button.

**FI3. Ticking a box shifts the list down under the pointer** | flow | medium | S
The selection bar is inserted above the list on first tick (`:9503`), and the whole list is rebuilt (F6). The row you were about to tick next has moved by one bar's height.

Fix: reserve the bar's space, or put it in the toolbar row.

**FI4. No row actions; everything goes through tick, then bar** | gap | medium | M
A row has a checkbox and an open button only (`:9634`). Rename, Download and Delete on one file take a tick, a bar click, then a Clear. No right-click menu, no Delete or F2 keys, no shift-click range. Multi-select offers only Zip and Delete (`:9484-9490`): no multi-download, no multi-move.

Fix: a ⋯ menu per row (Rename, Move, Duplicate, Download, Delete) and a keyboard map.

**FI5. Move means typing a path; the button always says "Rename"** | flow | medium | M
`:9508-9513`. No folder picker, no drag to a folder, no copy or duplicate at all.

Fix: separate "Rename" (name only) and "Move to…" (pick a folder from the tree).

**FI6. "Changed on disk" offers only "Reload and lose my text"** | flow | medium | M
`:10054-10056`. The dialog tells the user to copy their text by hand first. No "Save mine anyway", no "Save as a copy", no side-by-side view.

Fix: three choices: Keep mine (overwrite; a copy of the other version is kept anyway), Reload theirs, Cancel.

**FI7. Log files over 2 MB cannot be read at all** | gap | medium | M
`MAX_EDIT_BYTES = 2 MB` (`src/files.mjs:22`). `latest.log` on a busy server passes that in a day and the only offer is Download (`:9806-9811`). `.log.gz` and images get the same "not something to edit here".

Fix: a read-only viewer that loads the last part of a big text file, and an image preview for PNG and JPG (server-icon.png is the common one).

**FI8. Editor has no find, no wrap, no go-to-line, no Minecraft colour help** | gap | medium | M
The textarea is `wrap = 'off'` with no toggle (`:9942`) and there is no search control. The code leans on the browser's Ctrl+F (`:9826-9827`); whether the desktop shell offers one is unverified. Long MOTD and message lines scroll sideways.

Fix: a small bar with Find, Wrap, and for `.yml`/`.properties` a `&`/`§` colour-code preview.

**FI9. "Ctrl+S saves" on a Mac** | wording | low | S
The footer always says Ctrl (`:9954`) though the handler accepts ⌘ (`:10001`) and `panelPlatform` is known (`:3538`).

**FI10. Saving with a mistake does not show where** | flow | low | S
The YAML message names a line ("line 12 of the new config.yml is indented with a tab…", `src/config-files.mjs:326`) but the editor does not move to it. The JSON message is the parser's raw text ("… not valid JSON: Unexpected token } in JSON at position 512"). Only tabs in YAML and broken JSON are checked, yet the dialog title is the general "Save it with a mistake in it?" (`:10052`).

Fix: jump to and mark the line; offer "Replace tabs with spaces".

**FI11. Delete and Zip give no sign of working** | missing state | medium | S
`deleteFiles` shows nothing between the confirm and the result (`:9775-9778`), though the copy of up to 1 GB is compressed first (`src/files.mjs:24`, `:331`). Zip and Unzip only disable their own button (`:9525`, `:9534`). Search and opening a file also show nothing while waiting (`:9353-9355`, `:9802`).

Fix: a persistent "Keeping a copy, then deleting…" line (ties to A2).

**FI12. The quickest way to get a copy back is not mentioned** | flow | medium | S
The head, the delete dialog and the toasts all point to Backups (`:9371`, `:9770`, `:9778`, `:10048`). Restore there is disabled while the server runs (`:10923`). Activity has a one-click Undo for exactly these changes that works while running (`:10092`, `src/files.mjs:443-452`).

Fix: put an "Undo" button in the toast, and say "Activity can undo it" in the text.

**FI13. Every replaced or edited file becomes a row in Backup history, forever** | flow | medium | M
Upload-replace takes one snapshot per file (`src/files.mjs:274`), so replacing a 100-file folder adds 100 rows. Nothing ever prunes them (see BK4).

Fix: one copy per upload batch, and prune file copies after N days.

**FI14. A failed folder upload leaves one sticky error toast per file** | error state | medium | S
`:9731-9733`, `:9751-9753`. A full disk on a 300-file drop gives 300 error toasts that each need dismissing.

Fix: one summary ("12 of 300 could not be uploaded") with a "Show which" list.

**FI15. Upload has no progress and no cancel** | missing state | medium | M
Extends A2. One `fetch` per file in sequence (`:9724-9726`), no byte or file count, no stop. A 2 GB world zip shows a toast for 5 seconds and then nothing.

Fix: "Uploading 14 of 300 · 62%" pinned in the pane, with Cancel.

**FI16. "Replace 12 files?" does not say which** | clarity | low | S
`:9738-9740`. Same for "Delete 5 items?" (`:9767-9769`). List the first few names.

**FI17. The table is not a valid table for screen readers** | accessibility | medium | S
`role="table"` and `role="row"` are set (`:9553`, `:9557`, `:9591`) but body cells have no `role="cell"`, and the header's checkbox is not in a column header. The breadcrumb's "/" separators are read aloud (`:9401-9403`).

**FI18. 16px checkboxes are the only way to select** | accessibility | low | S
`width: 16px; height: 16px` (`:688`), in a 20px column (`:1519`). Under the panel's 32px minimum, and clicking elsewhere on the row does nothing.

**FI19. Important running-server facts are in a tooltip on plain text** | accessibility | low | S
"They can still be read and edited; a changed config applies when the plugin reloads or the server restarts." is the `title` of a non-focusable hint (`:9379`). The reason Delete and Rename are greyed is also tooltip-only (`:9494-9496`).

**FI20. Links and "Other" entries are buttons that do nothing** | missing state | low | S
The click handler covers only folders and files (`:9637-9640`); a link gets a tooltip and no response.

**FI21. Select all in search results leads to a refusal** | flow | low | S
Search lists files from many folders; Zip then fails with "archive things from one folder at a time" (`src/files.mjs:342`).

**FI22. SpawnLoft's own bookkeeping file is shown and deletable** | clarity | low | S
`plugins/.mcctl-plugins.json` (old product name, `src/plugins.mjs:181`) is listed like any other file. Deleting it turns every installed plugin into "Added by hand" with no updates.

Fix: hide it or label it "SpawnLoft's list of installed plugins".

**FI23. "In use" is missing from search results for plugin jars** | consistency | low | S
The listing flags `plugins/*.jar` (`src/files.mjs:120`); search flags only by top-level folder (`:426`). Delete then fails with the server's refusal.

**FI24. No way out of search except clearing the box** | flow | low | S
No "Back to {folder}" or clear control beside the "{n} named like" heading (`:9545-9550`). The search finds names only; there is no "find text inside configs".

**FI25. Empty folder still shows a header row with Select all** | polish | low | S
`:9642-9646`. The empty state has no button even though `emptyState` supports one.

**FI26. Long folders are drawn in full on every tick** | scaling | low | M
No cap or windowing on `entries` (`:9588`). A `playerdata` or `region` folder with thousands of files is rebuilt on each checkbox change (F6); the speed impact is unverified.

**FI27. Big screens: one very wide list** | scaling | low | M
At the Ultra tier only the Modified text gets longer (`:1548-1552`). The other tools split into a list and a companion at 2000px (`:1397-1401`, `:1927`); Files could show the editor or a preview beside the list.

**FI28. Columns cannot be sorted** | gap | low | S
Headers are plain text (`:9563-9569`). Sort by size or date is the usual way to find what is filling the disk.

### Keep
- Folder, open file and unsaved text are remembered per server (`:9299-9304`).
- A folder that vanished takes you back to the top instead of an error (`:9359`).
- One "Replace N files?" for a whole drop; the over-1 GB delete asks separately with type-to-confirm.
- Line endings and byte-order mark are preserved; port and RCON keys are protected with a message that says where to change them.
- Tab inserts spaces, and Esc then Tab is offered as the keyboard way out, stated in the footer.
- Unzip always goes into a new folder, never over existing files.
- Folder size shows "—" rather than blank; the full path is a tooltip on truncated names.

---

## 3. Worlds

### Inventory

- **Head** (`:8228-8229`): "Every world this server holds. Import a downloaded map, export one to share, choose which one runs."
- **Hint** (`:8236-8238`): "The server is running: importing works now; switching, deleting and exporting the active world need it stopped." / "Switching worlds takes effect the next time the server starts."
- **Import a world** (`:8242-8303`)
  - Path field, placeholder "C:\Downloads\amazing-map.zip — a zip, tar.gz, or a folder".
  - "Browse…" (desktop app only; picker titled "Choose a world archive or folder").
  - Name field, placeholder "Name it — letters, numbers, dash, underscore".
  - Button "Import" (primary) → "Importing…".
  - Note: "Never overwrites: the world arrives as a new entry here, and nothing changes until you make it the active one. The world inside the archive is found wherever it is nested."
  - Toasts: "A source and a name are both needed." / "Imported {name} ({size}, with nether and the_end)."
  - Server refusals (`src/worlds.mjs`, `src/util.mjs:514`): "invalid instance name "{x}" - use letters, digits, dash, underscore (max 32 chars)"; ""{name}" already exists in {folder} - pick another name"; "there is nothing at {path}"; "no level.dat found inside {file} - that archive does not hold a world".
- **List** (`:8306-8421`)
  - Head "Worlds ({n})"; empty "No worlds yet. The server generates one on its first start, or import a downloaded map above."
  - Row: map icon; name; pill "Active" (green dot, green wash on the row); pills "nether", "the end"; size.
  - Buttons: "Set active" (hidden on the active world; disabled while running, tooltip "Stop the server first"); "Export" (disabled for the active world while running, tooltip "The running server is saving into this world - stop it first, or take a backup"); "Delete" (danger; hidden on the active world; disabled while running).
  - Toasts: "{name} is now the active world. Takes effect on the next start."; "Exported to {full path} ({size})."; "Deleted {folders}."
  - Delete dialog "Delete the world "{name}"?": "Gone for good: only the ACTIVE world is ever included in snapshots, so an inactive world deleted here has no way back unless it was exported. Its nether and the_end go with it. Export it first if there is any doubt." Type the name; button "Delete world".
  - Server refusals: ""{id}" is running - stop it before switching worlds."; ""{id}" has an orphaned java process (pid N) with no daemon - run "spawnloft kill {id}" before …" (`src/control.mjs:96-99`).

### Findings

**WO1. Deleting a world here keeps no copy, and the dialog's reason is wrong** | flow | high | M
The dialog says "only the ACTIVE world is ever included in snapshots" (`:8401`). A Full backup takes everything in the folder except caches and logs (`src/backup.mjs:170-173`), inactive worlds included. Meanwhile deleting the same folder in Files keeps a copy first (`src/files.mjs:331`). The page built for worlds is therefore the less safe way to delete one.

Fix: export (or copy) the world automatically before deleting, say where it went, and drop the capitals.

**WO2. Export leaves no trace and cannot be opened from the panel** | flow | medium | M
Extends F5. The zip goes to `{backups}/{server}/exports/` (`src/worlds.mjs:176-178`), which neither Files nor Backups lists, and `reveal` only opens folders inside the server folder (`src/manage.mjs:200-210`). After the 5-second toast there is no list of exports, no "Show in folder", no Download, and exports are never cleaned up.

Fix: download it directly (as Backups does) or show an "Exports" list with Download, Show in folder and Delete.

**WO3. Standard and "Worlds only" backups cover only the active world** | clarity | high | S
See BK1; noted here because this page is where a second world is added. A world imported and visited through a multi-world plugin, but not "active", is in no automatic backup, and nothing on this page says so until the delete dialog.

Fix: a line under the list: "Automatic backups cover the active world only" (or fix BK1).

**WO4. Missing basics: rename, duplicate, new world, reset, seed, download, upload** | gap | medium | L
Row actions are Set active, Export, Delete only (`:8366`). There is no "Create a new world" (name, seed, type), no "Reset this world" on the active row, no rename, no "Duplicate" for testing, and no upload from the browser (F5 covers the typed path).

Fix: at minimum New world (with seed) and Duplicate; link Reset from the active row to wherever reset lives.

**WO5. The Browse picker says "archive or folder" but can only pick a file** | wording | medium | S
Title "Choose a world archive or folder" (`:8277`); the picker is `openFile` only (`desktop/main.js:368-378`, `bridge.rs:289-298`). A world that is a folder (the most common form when copying a singleplayer save) can only be imported by typing its path.

Fix: two buttons, "Choose a zip…" and "Choose a folder…" (`pickFolder` already exists).

**WO6. A pasted path with quotes, `~` or a relative path fails with a confusing message** | error state | medium | S
The value is only trimmed (`:8288`) and resolved against the service's own working folder (`src/worlds.mjs:116`). Windows "Copy as path" adds quotes, giving "there is nothing at {service folder}\"C:\…"".

Fix: strip surrounding quotes, expand `~`, refuse relative paths with "Paste the full path".

**WO7. Name errors call the world an "instance"** | wording | medium | S
A space in the name returns "invalid instance name "my world" - use letters, digits, dash, underscore (max 32 chars)" (`src/util.mjs:514` via `src/worlds.mjs:112`).

Fix: check in the page as the user types, with the rule under the field ("Letters, numbers, - and _ only, up to 32").

**WO8. Two inputs with no label** | accessibility | medium | S
The path and name fields have a placeholder only, no `<label>` and no `aria-label` (`:8248-8265`). F5 already notes the placeholder is cut off; it is also the only place the naming rule is given.

**WO9. "Missing field" is a red toast, not marked on the field** | error state | low | S
"A source and a name are both needed." (`:8290`). No `aria-invalid`, no focus move. "Source" is also not a word used on the page.

**WO10. A failed export re-enables buttons that should stay off** | missing state | low | S
`busy(false)` enables every button in the row (`:8369`, `:8393`), including "Set active" and "Delete" that were disabled because the server is running.

**WO11. Raw dimension names** | wording | low | S
Pills replace `the_` (`:8344`), but the import toast and delete dialog print "the_end" (`:8296`, `:8403`). Pills are lower-case ("nether", "the end") beside "Active".

Fix: "Nether", "The End" everywhere.

**WO12. Import gives no progress, and a folder import can freeze the whole panel** | missing state | medium | M
The button says "Importing…" (`:8292`). Folder imports use a synchronous copy (`fs.cpSync`, `src/worlds.mjs:104`), which blocks the service; with three missed polls the "Lost contact" banner would appear (`:6089`). The freeze follows from the code but was not observed.

Fix: async copy with a progress line.

**WO13. After import the new world is not pointed out** | flow | low | S
The pane redraws (`:8297`), the list re-sorts, and the user must find the row and press "Set active".

Fix: a "Make it the active world" tick box on the form (disabled with reason while running), or an action in the toast.

**WO14. Active row has one button and no explanation** | clarity | low | S
Set active and Delete are hidden on the active world (`:8356`, `:8363`), so the row shows only Export. Nothing says "This is the world in use; switch to another to delete it."

**WO15. Refusals name the folder id and, for an orphaned server, a terminal command** | wording | low | S
`"{id}" is running - stop it before switching worlds.` and `run "spawnloft kill {id}"` (`src/control.mjs:96-99`) reach the toast unchanged. Extends A6/C1 to this page.

**WO16. Rows show only size** | gap | low | S
No last-played date, no Minecraft version, no seed. For "which of these is the old one?" the size is not enough.

**WO17. Import form sits above the list** | hierarchy | low | S
Covered by F5. On a server with one world, the form and its three-line note fill the screen before the world is seen.

### Keep
- Import never overwrites, and says so; it works while the server runs.
- The world inside an archive is found wherever it is nested, and Nether and End folders come along.
- The page states up front what needs the server stopped.
- Delete uses type-to-confirm and names the dimensions that go with it.
- "Active" is a word plus a tint, not colour alone.

---

## 4. Backups (server)

### Inventory

- **Head** (`:10476-10477`): "Take a snapshot now, put one back, or leave it to a schedule."
- **Refresh error line** (`:10451`, role status): "Backup history could not refresh: {error}. Trying again shortly."
- **Status strip** (`:10609-10663`, role status)
  - "Checking the schedule…" / "Asking whether this server backs itself up."
  - "Schedule unknown" / {error}.
  - "Automatic backups on" / "{Every hour | … | On a schedule}, keeping {n} · next {date}".
  - "Automatic backups off" / "Nothing backs this server up unless you do it by hand." or the platform's unavailable text.
  - Right side: "Never backed up" / "Last backup {ago}" / "No backup in 7 days · last {ago}" (amber).
  - Button "Turn on nightly backups" (primary) → toast "Nightly backups of {server} at 03:00, keeping the last 7." (`:5700`).
- **Back up now** (`:10495-10575`)
  - Select (aria "What to back up"): Standard, Full, Worlds only, Config only, Plugins only (`:10598`).
  - Button "Back up now".
  - Hint: "Standard covers plugins, worlds and config. Safe while running - the one file the server holds locked is left out." / "Standard covers plugins, worlds and config. Full is everything except caches and logs."
  - Progress: "Archiving. Large worlds take a moment."
  - Toasts: "Saved {file}, and mirrored." / "Saved {file}."; error-styled "the snapshot is safe, but mirroring it failed: …"; "Left out, locked by the running server: {files}"; "autosave may still be off: save-on was not confirmed (…). Type save-on in the server's console if it is".
- **Leave out of backups** (`:10524-10557`)
  - Collapsible "Leave out of backups ({n})"; text box, placeholder "plugins/dynmap/web" and "*.log"; button "Save".
  - Hint: "One per line, from the server folder; * matches anything. Big things that rebuild themselves are the usual candidates. A restore cannot bring back what was left out."
  - Toasts: "Backups will leave out {n} path(s)." / "Backups leave nothing out."
- **Automatic backups** (`:10669-10762`)
  - Switch with word "On"/"Off"; select: Every hour, Every 6 hours, Every 12 hours, Daily at 03:00, Daily at 05:00, Weekly, Sunday 03:00; "keeping [n] of them"; button "Apply".
  - Line: "Held by {Windows Task Scheduler | macOS launchd | systemd}. Last run: {ok | failed (exit N) | …}. Next: {date}." or the platform hint (B5); "Could not read the schedule: {error}".
  - Linux notice (`:8973-9005`): "These only run while you are logged in." / "These pause when you log out." plus button "Keep running after logout".
  - Toasts: "Automatic backups scheduled." / "Automatic backups turned off."
- **History** (`:10764-11044`)
  - Head "History ({n})".
  - Path line plus "Change" (tooltip "Where backups are kept, for every server").
  - Mirror line "mirrored to {path}" / "No mirror: snapshots live on one drive, beside what they back up." plus "Add a mirror" / "Change" and "Off".
  - Change location: app folder picker "Where should SpawnLoft keep backups?"; browser dialog "Where should backups be kept?" (field "Full path to a folder", button "Use this folder"); then "Restart SpawnLoft to use the new folder" with "Got it"; toast "Backups are already kept there."
  - Mirror: picker "Where should snapshot copies go? Ideally another drive."; browser dialog "Mirror snapshots to a second location" with "… Retention deletions follow the mirror too."; toasts "New snapshots now mirror to {path}. No restart needed." / "Mirroring turned off. Copies already made stay where they are."
  - Empty: "Nothing here yet. Reset and delete both take one automatically before they run, so this fills up on its own."
  - Columns: Snapshot, Contents, Reason (≥1280), Items (≥2000), Size.
  - Row: "{date} · {ago}"; note (bold) and file name; "Only {path}" for single-file copies; a chip with the scope / "one file" / "before an edit" / "before a replace" / "deleted" / "Unknown" plus " + N db"; reason (Manual, Nightly, Schedule, Before a restore, Before an AI edit, Before a delete, Before a reset, Before an upgrade, Before a pack update, Before an edit, Before a replace, On delete, or the raw label); "{n} items"; size.
  - Row actions: lock glyph (aria "Lock, so nothing deletes it" / "Locked - nothing deletes it. Unlock"), pencil ("Add a note" / "Change its note"), download glyph ("Download"), "Restore" (disabled while running; tooltip "Stop the server first"), trash ("Delete"; disabled when locked, "Locked. Unlock it first.").
  - Lock toasts: "Locked. Neither Delete nor a schedule's retention will remove it." / "Unlocked. Retention can remove it again."
  - Note dialog "A note for this snapshot": "A few words saying what it is - "before the 1.21 upgrade". Empty removes it."; button "Save".
  - Restore dialog "Restore into {id}?"
    - Text: "This puts back {members} from {name}, as they were on {date}. Anything changed since then is overwritten." plus the leave-out and database sentences.
    - Choice 1: "Put it back over what is there" / "Anything added since - a new plugin, chunks explored since - stays. Not undoable; take a backup first if you are unsure."
    - Choice 2: "Clear first, so it ends up exactly as the backup was" / "What it holds is removed, then put back. A copy of what was there is kept in this list, so this can be undone."
    - Type the id; button "Restore".
  - Restore toasts: "Restoring {file}."; "What was there before is kept as {file}."; "Restored {file}, with N database(s) imported."; "Database {db} not imported: {reason}".
  - Delete dialog "Delete this snapshot?": "{file}, {size}. What it holds goes with it."; button "Delete snapshot"; toast "Deleted {file}."

### Findings

**BK1. "Standard" and "Worlds only" back up one world, not "worlds"** | clarity | high | S
Both use `worldDirs(props)`, which is the active `level-name` plus its Nether and End folders (`src/props.mjs:59-62`, `src/backup.mjs:158`). The page says "Standard covers plugins, worlds and config." (`:10516-10517`) and the option is "Worlds only" (`:10598`). A server with several worlds (any multi-world plugin, or imports from the Worlds page) has only one of them in every automatic and Standard backup.

Fix: either back up every folder with a `level.dat` (the Worlds page already finds them), or rename to "the active world" and say so.

**BK2. A backup can silently miss the database, and may be a torn copy, with a green "Saved"** | missing feedback | high | S
The core returns `databasesSkipped` and `flushWarning` ("could not flush the world before the snapshot…; the copy may be torn", `src/backup.mjs:275`, `:356`). The panel's handler drops both (`src/ui.mjs:634-642`), and the history list does not return a snapshot's stored warnings (`src/backup.mjs:382-396`). So with the database stopped, the user sees "Saved …" and a row with no "+ 1 db" and no hint that anything is missing.

Fix: return and show both; put a warning mark on the row, with the reasons, for any backup that has warnings.

**BK3. The page never says that databases are included** | clarity | medium | S
Standard and Full add a dump of every attached database (`src/backup.mjs:244-249`). Neither hint mentions it (`:10515-10517`). It appears only as "+ 1 db" on the chip (`:10915`), "db" being jargon.

Fix: "Standard: plugins, the world, settings and this server's databases (if they are running)." Chip: "+ database".

**BK4. Nothing except scheduled backups is ever cleaned up** | flow | high | M
The "keeping N" rule removes only backups made by that schedule (`src/backup.mjs:641-650`; callers `mcctl.mjs:1584`, `:1644`). Every plugin install and update snapshots the whole plugins folder (`src/plugin-actions.mjs:26-30`), every file edit, replace and delete adds a copy, and manual, pre-upgrade and pre-restore ones stay too. The page shows no total size, has no multi-select, no "Delete all older than…", and no filter.

Fix: a total ("48 backups · 31 GB"), a filter (Full backups / Small copies), bulk delete, and automatic clean-up of file copies and before-install copies after N days.

**BK5. Single-file copies and whole backups are one undifferentiated list** | hierarchy | medium | M
A "one file" copy of `config.yml` (12 KB) is a row of the same weight as a 4 GB full backup (`:10861-10951`). After an evening of config edits the real backups are buried. "History (37)" counts both (`:10771`).

Fix: group or filter; default to whole backups with "Show small copies (31)".

**BK6. "Last backup just now" after installing a plugin** | clarity | medium | S
`isWholeBackup` excludes only single-file and Files copies (`:10602`). A plugins-only pre-install snapshot or a "Config only" one resets "Last backup" and clears the 7-day warning (`:10611-10614`) although no world was saved.

Fix: count only Standard, Full and Worlds for the strip and for Overview.

**BK7. The default restore choice is the one that cannot be undone** | flow | high | S
The first radio is preselected (`:3684`) and it is "Put it back over what is there … Not undoable" (`:11001`). Only "Clear first" keeps a copy (`src/backup.mjs:463-471`). The database page takes a safety copy on every restore (`src/services.mjs:471`).

Fix: always take the safety copy before any restore (it is a short snapshot of the same members), and say "A copy of how things are now is kept first."

**BK8. The restore dialog skips its own choices for keyboard users** | accessibility | medium | S
Focus goes to the type-to-confirm box (`:3775`), below the two radios, which sit in a plain `div` with no group name (`:3414`). The text above is one paragraph of up to six sentences (`:10998-10999`).

Fix: focus the first radio, wrap the choices in a `fieldset` with a legend, and split the text into what, when and warnings.

**BK9. A failed restore tells the user to run a terminal command** | wording | medium | S
"… would not restore cleanly, so nothing was changed.\n  {problems}\n  Choose an older snapshot; "spawnloft verify {id} --all" checks every one." (`src/backup.mjs:454-456`). The panel has no Verify action, though the core has one (`verifySnapshot`, `src/backup.mjs:622`) and already checks before every restore.

Fix: a "Check this backup" row action and a "Check all" button; mark bad ones in the list.

**BK10. Restore needs the server stopped but offers no "Stop and restore"** | flow | medium | S
Extends B6. Elsewhere the panel has a stop-then-act confirm (`:4517`). Here the button is just greyed (`:10923`), and nothing offers to start the server again afterwards.

**BK11. No partial restore and no way to see what a backup holds** | gap | medium | L
The only view of contents is the first three names in the restore dialog ("… and 13 other files and folders", `:10349-10354`) and the "Items" count at ≥2000px. Common asks: restore only the world, only one plugin's folder, or pull one file out.

Fix: a "Contents" view with tick boxes, feeding the existing members-only restore path.

**BK12. If the schedule does not match a preset, Apply silently changes it to "Every hour"** | flow | medium | S
Options are selected only on an exact match (`:10699`). A schedule made elsewhere (for example daily at 04:30) matches none, so the browser shows the first option, "Every hour". Pressing Apply for any reason (to change the keep count) saves hourly (`:10742-10745`). The status strip handles this case correctly with "On a schedule" (`:10635`).

Fix: add the current schedule as its own option ("Daily at 04:30 (current)"), and offer a time picker rather than two fixed times.

**BK13. A bad "keeping" number means "keep everything", with no message** | error state | medium | S
Empty, 0 or a non-number becomes `keep: null` on the server (`src/ui.mjs:689-690`), which means never delete. `max="365"` is not enforced. The toast still says "Automatic backups scheduled." (`:10746`).

Fix: validate in the page; say what the number covers ("Keeps the newest 7 automatic backups. Backups you make by hand are never removed.").

**BK14. Automatic backup controls have no accessible names** | accessibility | medium | S
The switch's label is the word "On" or "Off" (`:10683-10692`), so it is announced as "Off, checkbox". The frequency select has no label (`:10694`). The number field has none ("keeping" and "of them" are plain spans, `:10704-10718`).

Fix: `aria-label` "Automatic backups", "How often", "How many to keep".

**BK15. "Held by Windows Task Scheduler. Last run: ok."** | wording | low | S
`:10727-10728`. "Held by", lower-case "ok", "failed (exit 1)", "ready", "queued", "not run - the machine was not logged in" (`src/schedule.mjs:61-72`, `:134`). Extends B5/C3.

Fix: "Last ran {date}: worked / did not work ({plain reason})", with the scheduler's name behind "How this runs".

**BK16. Times are mixed 24-hour and locale** | consistency | low | S
Presets and the toast are fixed "03:00" (`:10302-10304`, `:5700`). "next …" uses the locale (`:10274-10280`), giving "Daily at 03:00 … next Nov 15, 3:00 AM" on a 12-hour system. The restore dialog uses `toLocaleString()` with seconds (`:10999`).

**BK17. Changing the backup folder hides every existing backup after the restart, with no way to bring them along** | flow | high | M
In the app the folder picker opens with no explanation first (`:10376-10378`); the consequences come after the choice is saved, in a dialog whose only button is "Got it" (`:10397-10405`). After the restart the history is empty and the strip will say "Never backed up" for every server. There is no "Move existing backups", no "Restart now", no way to cancel, and until the restart the page still shows the old path with no "pending" note (`:10776`).

Fix: explain before picking; offer "Move existing backups too"; show "Changes to {path} when SpawnLoft restarts · Undo" on the page; add a Restart button.

**BK18. A setting for every server sits inside one server's History with only a tooltip to say so** | clarity | medium | S
"Where backups are kept, for every server" is the `title` on "Change" (`:10781`). The mirror is also global (`:10825`).

Fix: say "All servers" in the row, or move both to Preferences with a link here.

**BK19. The mirror has no health state** | missing state | medium | M
The row only shows the path (`:10792-10794`). A failed copy is reported once, as a toast after a manual backup (`:10566`); for scheduled backups nobody is told. Rows do not show whether a backup reached the mirror; existing backups are not copied when a mirror is added, and nothing says so.

Fix: "Second copy: OK, last copied {time}" or "Not reachable since {time}", a per-row mark, and "Copy existing backups now".

**BK20. Column headers are attached to the wrong columns** | polish | low | S
Five header cells are created (Snapshot, Contents, Reason, Items, Size; `:10854`), but the CSS still assumes three: `:nth-child(3)` gets `text-align: right` (`:1440`), which is now "Reason" (left-aligned values under a right-aligned header), while "Size" has no rule and is left-aligned over right-aligned sizes. "Contents" heads the scope chip and "Snapshot" heads the date.

Fix: address header cells by class; rename to When, Type, Why, Items, Size.

**BK21. Row buttons are not named for their row** | accessibility | medium | S
Extends B6/A11. Every row's glyphs are labelled just "Download", "Delete", "Add a note" (`:10927-10942`), and "Restore" is bare. The database page uses "Download {file}" (`:12548`). The header is `aria-hidden` and rows have no roles, so cells are read as loose text; the DOM order is date, size, type, reason, items, buttons, then the name last (`:10950`).

Fix: labels with the date ("Restore the backup from Nov 14, 3:00"), and DOM order to match reading order.

**BK22. Lock: label and pressed state both change; "retention" in the toast** | wording | low | S
`aria-pressed` plus a label that flips to "Locked - nothing deletes it. Unlock" (`:10936-10937`). Toasts: "Neither Delete nor a schedule's retention will remove it." / "Retention can remove it again." (`:10957`).

Fix: a constant label "Keep this backup" with pressed state; toast "Kept. It will not be deleted automatically."

**BK23. Reason column prints raw labels** | wording | low | S
`pre-install` and `pre-update` (`src/plugin-actions.mjs:35`, `:45`) are not in the table at `:10330-10335`, so they show as "Pre install" and "Pre update" beside "Before an upgrade". Add "Before installing a plugin" / "Before a plugin update".

**BK24. File names are the identity of a backup everywhere** | wording | low | M
Toasts and dialogs say "Saved manual_standard_20261114-120301.tar.gz.", "Restoring …tar.gz.", "Deleted …tar.gz." (`:10565`, `:11009`, `:11034`, `:11027`). Extends B1/A10.

Fix: "the backup from Nov 14, 12:03 (Standard)".

**BK25. "Back up now" cannot be named, and shows no progress** | missing state | medium | M
The database page has a "Label (optional)" field (`:12494`); the server page has none, though the API accepts a label (`src/ui.mjs:631`). The note must be added afterwards with the pencil. Progress is a fixed "Archiving. Large worlds take a moment." (`:10562`): no elapsed time, no cancel. A backup started by the schedule or elsewhere shows nothing at all until it appears in the list.

**BK26. Warnings after a good backup are styled as errors** | wording | low | S
"Left out, locked by the running server: …" is a red sticky toast (`:10567`) directly after the page promised "Safe while running - the one file the server holds locked is left out." The "autosave may still be off: save-on was not confirmed (…). Type save-on in the server's console" message is developer text (`src/backup.mjs:197`).

Fix: a neutral note on the row; plain wording and a "Turn saving back on" button.

**BK27. Scope options are unexplained and partly misnamed** | clarity | medium | S
Only Standard (and Full when stopped) is described; while running, the Full sentence is replaced (`:10515-10517`). "Config only" is the server's own files plus the `config` folder, not plugin configs (`src/backup.mjs:105-119`, `:159`). "Plugins only" also covers mods (`:157`) and is shown unchanged on a mods server.

Fix: one line under the select that changes with the choice.

**BK28. "Leave out of backups" needs typed paths and patterns** | flow | low | M
A code-style box with "*.log" (`:10529-10543`). It applies to automatic backups too, which the text does not say. No "Leave out of backups" action on a folder in Files, and no size shown for what is excluded. Save gives no sign of unsaved edits.

**BK29. Deleting a backup does not say the second copy goes too** | clarity | low | S
"What it holds goes with it." (`:11027`); the mirror copy is removed as well (`src/backup.mjs:636`).

**BK30. Download is a .tar.gz** | clarity | low | S
`:10977-10984`. World export gives a .zip (`src/worlds.mjs:178`). The format is unfamiliar to the audience and nothing says how to open it.

**BK31. Awkward pane widths at 1600 to 1750 wide windows** | scaling | medium | M
From 1600px the console takes `clamp(520px, 38%, 1400px)` (`:1234-1237`), so at a 1600 window the Backups pane is about 750px, narrower than at 1280. The two-column rule (`≥860`, `:1378`) switches off again, and the history row's fixed columns (`132px 84px 262px` plus gaps, `:1426`) leave roughly 150px for date and name. Derived from the CSS; not seen on screen.

Fix: let the name wrap under the date at that width, or collapse the row buttons into a ⋯ menu below about 900px.

**BK32. The strip is announced on every redraw** | accessibility | low | S
`role="status"` and it is repainted twice per forced render ("Checking the schedule…", then the answer; `:10584`, `:10595`), which happens after every lock, note and delete.

**BK33. Gaps against other panels** | gap | medium | L
- No off-site destination (cloud or SFTP); the mirror is a local path only.
- No "back up before every stop or restart" option.
- No notification when an automatic backup fails (the strip shows only what `lastResult` says when the page is opened).
- No compare or diff between backups.
- No "restore as a new server".

### Keep
- The status strip answers "is this server backed up?" first, with an icon and words, and the stale warning is amber with text.
- History refreshes in the background without disturbing the form or focus (`:10466-10473`).
- Locking is honoured by both Delete and the schedule; a locked row stays at full strength.
- The restore dialog names what comes back, from when, what was left out, and that databases are included; it uses type-to-confirm.
- The note dialog says that empty removes it.
- The empty state explains that reset and delete make their own backups.
- The absence of a second copy is stated as a risk, not hidden.

---

## 5. Database Backups (for comparison)

### Inventory (`:12439-12617`)

- **Head:** "SQL dumps of this database, kept apart from the servers' snapshots. Download one to keep a copy somewhere else."
- **Cannot dump:** "{engine} keeps its own checkpoints on disk, so there is nothing here to dump. Back up the servers that use it instead."
- **Back up now**
  - "Dumps {names} — the database(s) your servers use here — into one .sql file." / "No server is attached to this database yet, so there is nothing of yours in it to dump."
  - "Start the database first: a dump is read from the running database."
  - Field "Label (optional)"; button "Back up now" → "Dumping…".
  - Toast "Backed up {name} to {file} ({size})."
- **List**
  - "Backups ({n})"; "Kept in {dir}".
  - Empty: "No backups of this database yet. Back up now, before a plugin update or a migration, and there is a way back."
  - Columns Backup, Label, Reason, Databases, Size.
  - Row buttons "Download", "Restore" (disabled when stopped; tooltip "Start the database to put a backup back into it"), trash.
- **Restore:** dialog "Put {name} back as it was?": "The tables in {file} replace the ones there now, and anything written since it was taken is lost from them. A backup of how things are now is taken first, so this can be undone from this list. Stop the servers that use it first if they are writing to it."; type the id; button "Restore". Toasts "Putting back {file}…" / "Put back {file}. How it was before is saved as {file}."
- **Delete:** dialog "Delete this backup?": "{file}, {size}. Download it first if you want to keep a copy."; button "Delete backup"; toast "Deleted {file}."

### Findings

**DBB1. The "nothing to dump" advice does not protect the data** | clarity | medium | S
For an engine that cannot be dumped the page says "Back up the servers that use it instead." (`:12479-12480`), but a server backup skips that engine too ("keeps its own checkpoints; it is not dumped", `src/services.mjs:350`).

Fix: say what does protect it (for example "Stop it and copy its data folder") and offer that as a button.

**DBB2. Same job, different words and controls from the server page** | consistency | medium | M
Adds specifics to F11 and B1:
- Verbs: "Put back" / "Putting back…" here; "Restore" / "Restoring" there (`:12575`, `:12585`, `:10997`, `:11009`).
- Buttons: text "Download" and "Restore" here; glyphs there.
- Features: a label field at creation here, a note pencil afterwards there; no lock, schedule, keep count, second copy or "ago" here (`:12537`).
- Safety: a safety copy on every restore here, only in one mode there.
- Accessibility: the header row is readable here, `aria-hidden` there.
- Location: "Kept in {dir}" with no Change.

Fix: one row component and one vocabulary for both.

**DBB3. "Label" and "Reason" columns show the same value twice** | clarity | low | S
Both come from `b.label` (`:12539-12540`): "manual" beside "Manual", "pre-restore" beside "Before a restore".

**DBB4. The file name is hidden in the row but used in every message** | clarity | low | S
The row shows the database names with the file as a tooltip (`:12538`, `:12544`); the dialogs and toasts name the file. The label is silently rewritten (spaces to dashes, `src/services.mjs:438`).

**DBB5. "SQL dumps", ".sql file", "tables", "migration"** | wording | low | S
Extends C3 ("Dumping…"). `:12476`, `:12489`, `:12525`, `:12576`.

**DBB6. Restore does not check whether attached servers are running** | flow | medium | S
The dialog only advises "Stop the servers that use it first if they are writing to it." (`:12578`). The page knows which servers are attached, so it could name the ones running and offer to stop them.

**DBB7. No automatic backups for a database** | gap | medium | M
Dumps are by hand only. A database is covered automatically only as part of a server's Standard backup, and only if it is running at that moment (BK2).

### Keep
- Every restore takes a safety copy first and says it can be undone from the same list.
- A poll does not redraw under a dump or restore, or while a label is being typed (`:12445`, `:12461-12463`).
- The empty state suggests when to take one.
- The disabled reasons ("Start the database first…") are on the page, not only in a tooltip.

---
