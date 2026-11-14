# Page by page, part 4: launcher (Play), first-run wizard, sign-in and plain pages, desktop shell, installer and packages

Part of the [UX scan](../ux-scan-2026-11.md). Each page has an **Inventory** (every control, menu, dialog, message and state, with its wording and where it is in the code), **Findings**, and **Keep** (what already works and should not be lost).

Findings read: **id. title** | kind | severity | size (S is small, a few hours at most; M is about a day; L is several days or needs a design decision first). Everything in this part was confirmed by reading the code at `552082d`; line numbers are `src/ui.html` unless another file is named. Findings that were also seen in the running panel are listed in [part 5](05-seen-in-the-running-panel.md). "extends A2" and similar point at the [first pass](first-pass.md). "unverified" marks a consequence that could not be observed.

---

## 1. Launcher (`src/launcher.html`)

### LA-A. Inventory

- **Top bar** (`launcher.html:547-552`)
  - Brand "SpawnLoft" with "Launcher" under it (`:548`). When embedded in the panel it is replaced by an h1 "Play" (`:549`, `:359-361`).
  - **Account chip** (`:1287-1297`)
    - Signed in: name plus "Offline", "Microsoft", "Microsoft · sign in again" or "Signing in…" (`:1293`).
    - Nobody: "Not signed in" plus "Sign in or play offline" (`:1295`).
  - **Account menu**, `role="group"`, label "Accounts" (`:1299-1327`)
    - Heading "Playing as" (`:1306`).
    - One row per account: name, then "Offline" or "Microsoft" with " · default", or "sign in again" (`:1309-1312`).
    - Row button "Sign in again" on an expired account (`:1313`).
    - Row "x" icon on non-default accounts, tooltip and label "Remove NAME" or "Sign out NAME" (`:1314`).
    - "Add Microsoft account" with the note "opens Microsoft's page" (`:1318`).
    - Heading "Play offline on local servers" (`:1319`); input with placeholder "Name, 3 to 16 characters" and aria-label "Offline name" (`:1321`); button "Add" (`:1323`).
    - Note "An offline name plays on servers with online-mode=false, like the ones SpawnLoft makes. Online servers need a Microsoft account." (`:1325`).
    - Bottom row "Remove NAME" or "Sign out NAME" for the default account (`:1326`).
  - **Sign-in waiting strip** (`:1338-1355`)
    - "Waiting for Microsoft… Finish signing in in your browser, then come back here. This page updates by itself." (`:1342-1343`).
    - Link "Open Microsoft's page again" and button "Cancel" (`:1345-1346`).
    - Variants: "Microsoft is done; finishing the sign-in with Xbox and Minecraft."; "The sign-in window did not open, maybe because of a pop-up blocker." with link "Open Microsoft's sign-in page"; "Finish signing in in the window that opened. It closes itself." or "…the tab that opened, then come back here."; "Sign in in your browser instead" (`:1339`, `:1350-1353`).
  - **Account notices** (`:1329-1336`, `:2121-2233`, `:2272-2295`)
    - "A sign-in is already open in another window" / "Finish it there, or close that window and try again." / "Try again".
    - "Couldn't start the sign-in", with the raw error, or "The panel answered with a sign-in address that is not Microsoft's.".
    - "Signed in as NAME" / "You play as this account from now on." or "Pick it here to play as it.".
    - "The sign-in window closed before the sign-in finished" and "Sign-in cancelled", both with "Nothing was saved. If Microsoft showed an error about the redirect address, its app registration needs http://localhost/api/client/accounts/login/callback; see CLIENT.md.".
    - A failure shows the raw message as its title, plus "Try again, or play offline on local servers.".
    - "Playing as NAME" / "An offline name, for local servers."; "Added NAME, but couldn't play as it"; "Couldn't change who is playing"; "Removed NAME" or "Signed out NAME" / "A setup that named this account asks for another one before it plays."; "Couldn't remove NAME".
- **Stage states** (`playState`, `:820-829`)
  - **Loading**: three skeleton bars, aria-label "Loading" (`:1369`).
  - **Unreachable**: "Can't reach SpawnLoft" / "The panel that runs the launcher is not answering. If you closed the SpawnLoft app, open it again; this page reconnects by itself." / "Try again" (`:1359-1364`).
  - **First run** (`:1412-1430`)
    - "Play", or "Getting ready…" while it works.
    - Version button showing the id (or "…") with "Latest release".
    - Line "Opens Minecraft X on the title screen. Pick who is playing first.", or "Reading Mojang's version list…", or "The version list could not be read: ERROR. Try again".
    - Machine refusal "Minecraft can't be launched on this computer: …".
    - Flash "Couldn't make a setup" (`:1448`).
  - **Ready**
    - Split button "Play", "Start server and play" or "Play again" (`:1511`).
    - Setup button showing the version, "Vanilla" or "Fabric", and the given name (`:1516`).
    - Sentence, for example "Opens Minecraft 1.21 and joins NAME as WHO." or "Starts NAME first (up to 2 minutes), then opens … and joins it as …" (`:942-950`).
  - **Blocked**: Play disabled with a reason and fix links (`:805-815`, `:1393-1403`)
    - Reasons include "Another launch of this setup is already under way. Play unlocks when it finishes.", "Another setup is launching. Play unlocks when it finishes.", "This setup plays as NAME, who is no longer signed in.", "…whose saved sign-in no longer works.", "NAME needs a Microsoft account, and this setup plays as …".
    - Fix links: "Sign in with Microsoft", "sign in again", "pick another account", "play on the title screen", "pick another version".
  - **Launching** (`:1586-1603`)
    - Pill "Launching" plus the setup title; headline from the job, or "Preparing…".
    - Progress bar; steps "Version", "Java", "Files", "Server", "Start".
    - Hint "Closing this window does not stop the download. It keeps going and the files are used next time." (or "Leaving this page…" when embedded).
    - Server-side headlines: "Reading the Minecraft version list", "Downloading the version file for Minecraft X", "Finding a Fabric loader…", "Finding Java", "Getting Mojang's Java N", "Laying out the shared sounds and language files", "Checking Fabric API", "Checking the harness mod", "Starting NAME", "Starting the game" (`client.mjs:304-514`).
  - **Running** (`:1605-1623`)
    - Pill "Running", optional pill "Launched by an assistant".
    - "Minecraft is running", with "joined TARGET" or "on the title screen".
    - "Stop" (or "Stopping…"); "Open folder" in the desktop app only.
    - Facts "since HH:MM", "as NAME", "pid N".
    - "Closing this window does not stop the game."
    - Outside the app, the folder path with the tooltip "This setup's folder".
  - **Closed early or crash** (`:1625-1648`)
    - "Minecraft closed N seconds after it started" / "It was not stopped from here. Usually a mod, not enough memory, or the wrong Java. The last lines of its log:" plus a log block, or "The game left no log lines.".
    - "Report a problem" or "Collecting…".
    - "Saved the report to FILE (SIZE). Attach it to the bug report." or "The report could not be made: ERROR".
    - "Dismiss".
  - **Launch failure notices** (`:783-792`, `:1710`, `:1721`, `:1733`, `:1750`)
    - "Can't play" with the raw text.
    - "Another launch is already in progress: RAW" / "This page checks again every few seconds and unlocks when it finishes.".
    - "Can't play: …" / "Sign in with a Microsoft account, or join another server." / "Sign in".
    - "Playing, with a warning"; "Couldn't stop SETUP".
    - "the panel restarted during the launch; check the setup, then play again"; "lost the connection to the panel; the launch may still be running".
- **Setups menu** (on the version button, `:1525-1539`)
  - Heading "Play with".
  - Rows: title, then given name, memory and "usually joins X"; pills "running" and "launching"; gear icon "Edit SETUP".
  - "New setup" with the note "any version, snapshots too".
  - Notes "No setups yet. Play makes one for the latest release, or make your own:" and "A setup keeps its own worlds, options and mods. The gear edits memory, Java and the rest.".
- **"Who's playing?" menu** (`:1463-1477`)
  - "Sign in with Microsoft" / "Opens Microsoft's own sign-in page. SpawnLoft never sees your password. Needed for online servers.".
  - "Or play offline on local servers", name input, "Play".
- **Join field** (`:1541-1564`)
  - Label "Join"; placeholder "Pick a server or type an address"; status hint such as "Running · 1.21"; chevron labelled "Your servers".
  - Hint "Host, or host:port. Online servers need a Microsoft account; you are signed in as NAME.".
  - Errors "Type the address of the server to join.", "That doesn't look like a server address. Use a host name or IP, optionally with :port.", "The port must be a number from 1 to 65535." (`:720-737`).
  - **Join menu** (`:1566-1584`)
    - "Your servers" or "No SpawnLoft servers yet.".
    - Row meta "joins right away", "starts it first, up to 2 min", "needs a Microsoft account", "runs a different version".
    - "Title screen only".
    - "Or type an address above: play.example.net or 192.168.1.20:25566. Online servers need a Microsoft account.".
- **Setup sheet**, New and Edit (`:1889-2037`)
  - Title "New setup" with "Nothing is downloaded until you press Play.", or the setup title with a summary line or "Running since HH:MM".
  - Notices "This setup is running" / "The version, loader, Java, memory and the harness can't change while the game is open. Stop it first to change them." and "Minecraft can't be launched on this computer".
  - "Version" select. Option suffixes "(latest release)", "(snapshot)", " · downloaded", and refusal or note text. Empty states "Loading versions…" and "No versions to pick".
    - Hints "Changing it may stop the mods in its folder from loading.", "The version list could not be read: …".
    - Facts "Java 21", "likely Java N", "Fabric available", "no Fabric", "harness published", "harness not published", "runs under emulation" (`:994-1005`).
    - Links "Releases · Show snapshots · Show all · Refresh".
  - "Loader": segments "Vanilla" and "Fabric"; "Fabric for mods. Put them in the setup's mods folder." or "Fabric has no build for X.".
  - "Memory": segments "2 GB", "4 GB", "8 GB", "Custom"; slider; "You have X free of Y." or "Most setups need 2 to 4 GB.".
  - "Name (optional)" / "Shown in the setups menu. Letters, digits, dash and underscore."; when editing it is read-only with "The profile name the command line uses.".
  - "Play as": "Whoever is signed in (NAME)", "NAME (Offline)", "NAME (Microsoft)", "(no longer signed in)".
  - "Usually joins": "Title screen only", "NAME · 1.21 (another version)", "NAME (not found)".
  - Switch "Let SpawnLoft see the game" / "Adds the harness mod, for diagnostics and the assistant tools. Off until you need it.", or "Needs Fabric. Pick Fabric above to turn it on.", or "Not published for X yet…".
  - "Advanced"
    - "Java", placeholder "Automatic (recommended)", hint "A path to java or javaw, or mojang for Mojang's own Java for the version. Checked at launch.".
    - "Fabric loader version", placeholder "Newest stable".
    - Switch "Allow an assistant to use my account" / "An AI assistant connected through MCP may play this setup signed in as NAME.".
  - Remove strip: "Remove SETUP? Its folder with worlds, options and mods is kept." / checkbox "Also delete its folder" / "Keep it" / "Remove setup".
  - Footer: "Open folder", "Remove setup…", "Kept in its own folder under SpawnLoft's data folder.", "Cancel", "Save" or "Create" or "Saving…".
  - Flashes: "Made SETUP" / "Press Play to start it. The first time downloads the game."; "Saved SETUP"; "Removed SETUP" / "Its folder was deleted too." or "Its folder was kept."; "The folder could not be opened" / "It is PATH".
- **Session-ended overlay**: "This panel session has ended" / "Open SpawnLoft again from the app, or run `spawnloft ui` for a new sign-in link." (`:577-602`).

### LA-B. Findings

**LA1. A launch cannot be cancelled, and almost everything else locks with it (extends G1, G3)** | missing state | high | M
The launching card has no button at all. While it shows, the Play split button is not rendered, so the setups menu and the gear are gone, and Join is disabled. The account chip stays live, so the one thing still possible is signing out mid-launch.

Evidence: `launcher.html:1381`, `:1388`, `:1586-1602`. No cancel call exists in the page; only `/api/jobs/<id>/stream` is used (`:1691`).

Fix: add a Cancel button to the card, which needs a server route. Keep the setup button visible and read-only.

**LA2. The page can sit on the loading skeleton with no message** | missing state | high | S
`pollOnce` only handles a network failure. If `/api/client/launcher` answers with an error status (a 500, say), `S.summary` stays null and `S.down` stays false, so `playView` keeps drawing the skeleton with no message and no retry button for as long as the error lasts. Polling goes on (`:2331`), so one good answer clears it.

Evidence: `launcher.html:2337-2344`, `:1368-1370`, `:1098-1101`.

Fix: keep the last error and show the "Can't reach SpawnLoft" block with the reason and Try again.

**LA3. Developer instructions shown after a cancelled sign-in** | wording | high | S
Cancelling, or just closing the sign-in tab, shows "If Microsoft showed an error about the redirect address, its app registration needs http://localhost/api/client/accounts/login/callback; see CLIENT.md." This is Azure app-registration advice and a repository file name, shown to every player. The address also omits the port the server really uses (`ui.mjs:1402`).

Evidence: `launcher.html:680`, `:2229`, `:2231`.

Fix: "Nothing was saved." plus Try again. Move the redirect note to the docs.

**LA4. Raw server errors, many with terminal commands, reach the launcher unchanged** | wording | high | M
The sheet, the account menu and the "Can't play" notice print `err.message` or the job message as is. Examples a user can hit:
- `profile "x" is running; stop it first: spawnloft client stop x` (`client.mjs:237`, `:218`).
- `profile "x" is being launched (pid 1234); wait for it` (`client.mjs:222`, `:336`).
- `invalid profile name "…" - use letters, digits, dash, underscore (max 32 chars)` (`client.mjs:69`).
- `the saved sign-in for NAME no longer works; run spawnloft client login again` (`client-auth.mjs:249`).
- A 403 text about "Azure app registration … Allow public client flows" (`client-auth.mjs:94`).
- `the account could not be saved; see panel.log` (`client-login.mjs:186`).
- `could not download library NAME from URL: …` (`client-install.mjs:309`).
- `the panel answered 500` (`launcher.html:1099`).

Evidence: `launcher.html:791`, `:1448`, `:2017`, `:2081`, `:2123`, `:2233`, `:2262`.

Fix: have the routes return a code and map the dozen common ones to launcher wording with the control that fixes them. Keep the raw text behind "Details".

**LA5. "Remove setup" puts keyboard focus on the destructive button, next to an unlabelled-risk checkbox (extends G7)** | weak confirm | high | S
Pressing "Remove setup…" renders the confirm strip and focuses "Remove setup", so a second Enter removes it. With "Also delete its folder" ticked that deletes worlds. The button text stays the same, there is no undo, and the strip appears above the footer where it can be below the fold of the sheet.

Evidence: `launcher.html:2023-2028`, `:2032`, `:2087-2090`.

Fix: focus "Keep it". When the box is ticked, change the button to "Remove and delete worlds" and require typing the name, as the panel's destructive dialog does.

**LA6. Signing out and removing an account happen on one click with no confirm or undo (extends G2)** | weak confirm | medium | S
This applies to the bottom menu row for the default account as well as to the small "x". The follow-up notice says "A setup that named this account asks for another one before it plays", so setups are silently affected too.

Evidence: `launcher.html:1314`, `:1326`, `:2290-2297`.

Fix: confirm in place for Microsoft accounts ("Sign out NAME? You will need Microsoft's page to sign in again").

**LA7. After Microsoft's page, nothing brings the player back, and the browser tab never says how it ended** | flow friction | high | M
In the Tauri app the sign-in always opens the system browser (`bridge.js:33-34`, `bridge.rs:411-430`). The callback page only ever says "Finishing sign-in … You can close this window." (`ui.mjs:1408-1412`). Success or failure (a child account, no Minecraft owned, no Xbox profile; `client-auth.mjs:74-103`) appears only inside the launcher's account menu, in a window that is behind the browser and is not raised. The strings "the window that opened. It closes itself." and "Sign in in your browser instead" are Electron-only and are dead under Tauri (`launcher.html:1339`, `:1353`). The 10-minute limit (`client-login.mjs:100`) is not mentioned while waiting.
Unverified at runtime.

Fix: have the shell focus the launcher window when the login stream ends. Make the callback page say "Signed in. Go back to SpawnLoft." or give the reason. Show the time limit in the waiting strip.

**LA8. Editing the Join box after picking a server turns the server's name into an address** | clarity | medium | S
With a server picked, the input holds its name as editable text. Typing one character calls `setTarget` with the address set to the name plus the keystroke, which drops the pick and treats the text as a host name. There is no clear button; the only clean way back is the menu's "Title screen only".

Evidence: `launcher.html:1551-1554`.

Fix: show a picked server as a chip with an "x". Start the address empty on the first keystroke.

**LA9. A server on another version can be picked, and Play goes ahead** | missing state | medium | M
The Join menu marks it "runs a different version" in warning colour only. The Play sentence then reads as normal, and the game will be refused by the server after the whole download. The setup sheet's "Usually joins" behaves the same way with "(another version)".

Evidence: `launcher.html:763`, `:1575`, `:1982`. Nothing in `blockReason` covers it (`:805-815`).

Fix: say it under Play ("NAME runs 1.20.4; this setup is 1.21") with links "Use a 1.20.4 setup" and "Make one". The prefill code for that already exists (`:2421-2439`).

**LA10. Jargon in the launcher's own text** | wording | medium | S
- "online-mode=false" (`:1325`).
- "pid 1234" on the running card (`:1610`).
- "harness published" and "harness not published" under the version (`:1001-1002`).
- "Adds the harness mod, for diagnostics and the assistant tools" (`:1986`).
- "connected through MCP" (`:2006`, `:2008`).
- "The profile name the command line uses." (`:1970`).
- "Loader" and "Vanilla" with no explanation of Vanilla.
- The magic word "mojang" typed into the Java field (`:2001`).
The UI says "setup" everywhere but every server error says "profile" (finding 4).

Fix: use "offline-mode servers" or "servers that do not check accounts"; drop the pid; hide harness facts unless the switch is on; write "an AI assistant you connected to SpawnLoft"; call the loader choice "Mods: None / Fabric".

**LA11. "Let SpawnLoft see the game" does not say what is seen or by whom** | clarity | medium | S
The title is vague and the explanation is jargon. It installs a mod into the player's game.

Evidence: `launcher.html:1986`.

Fix: "Add SpawnLoft's helper mod. Lets diagnostics and AI assistants read what is on screen and send chat. Off unless you use those."

**LA12. Version picker is a native select with no search, and the option text carries refusals** | flow friction | medium | M
"Show all" puts every Mojang version in one list. Each option is a long string such as "1.21 (latest release) · downloaded · REFUSAL TEXT". The filter is three link-style toggles in a hint line.

Evidence: `launcher.html:1908-1929`.

Fix: a filterable list with type-ahead, and badges instead of suffixes. Comparable launchers (Prism, Modrinth) have a searchable version list with type checkboxes.

**LA13. Memory choices are not checked against the machine (extends G10)** | missing state | low | S
"8 GB" is offered on any machine. The "You have X free of Y" hint only shows for Custom. The slider's maximum is 16 when the machine is unknown.

Evidence: `launcher.html:1943`, `:1952-1957`.

Fix: disable or warn on segments above about 75% of total memory, and show the free-memory line always.

**LA14. The Java field is free text with no Browse and no check on save** | flow friction | medium | S
"Checked at launch" means a typo is found only after pressing Play. The shell has a file picker, but it is not offered here, and its first filter is "World archives" (`bridge.rs:295`).

Evidence: `launcher.html:2000-2001`.

Fix: a select of "Automatic", "Mojang's Java", detected Javas and "Browse…", with validation on save.

**LA15. Crash notice ends in a file path (extends G8) and offers nothing to do with the log** | flow friction | medium | S
After "Report a problem" the text is "Saved the report to FILE (SIZE). Attach it to the bug report." There is no Open folder, no Copy path and no link to where bugs go. The 20 log lines cannot be copied in one action or opened in full. The lead sentence "It was not stopped from here." reads oddly.

Evidence: `launcher.html:1626-1632`, `:669`.

Fix: add "Show file", "Copy log" and "Open full log", and reword to "Minecraft closed by itself."

**LA16. No log while the game runs** | gap | medium | M
The log is read only after an unexpected exit (`:2374-2389`). A player whose game hangs on a loading screen has nothing to look at. Prism and the Modrinth app show a live log.

Fix: a "Show log" disclosure on the running card using the existing log route.

**LA17. Stop kills the game on one click** | weak confirm | low | S
"Stop" is a large danger button with no confirm (`launcher.html:1617`, `:1743`). The server asks the game to quit only when the harness is on (`client.mjs:870`). What happens without it is unverified, but it is not a quit from inside the game.

Fix: when the game is on the title screen or in single player, confirm with "Stop Minecraft? Unsaved progress in a single-player world may be lost."

**LA18. Progress is announced badly to screen readers (extends G9)** | accessibility | medium | S
- The whole progress well is `aria-live="polite"` and is rebuilt on every job event, so each percent tick can be re-read (`:1591`).
- The progress bar has no accessible name (`:1593`).
- The steps show done and current only by colour, a hidden check icon and a literal "●" character (`:1597-1599`).

Fix: one polite live region for the headline only, updated on step change; add `aria-label` to the bar; add `aria-current="step"` and hidden "done" text.

**LA19. Menus are not menus to assistive tech, and Tab leaves them open** | accessibility | medium | M
- The account and setups menus are `role="group"`; the chip has no `aria-haspopup` (`:1290`, `:1302`, `:1527`).
- The Join input is `role="combobox"` with `aria-haspopup="dialog"`, but typing closes the popup instead of filtering it (`:1550-1554`).
- The chevron that opens Join is `tabindex="-1"`, so keyboard users must know to press Arrow Down (`:1557`, `:1561`).
- Tabbing out of any menu leaves it open, because only a click or Escape closes it (`:2395-2403`).
- When a sign-in ends the account menu opens by itself without moving focus (`:2235`).

Fix: close on focus leaving the menu; make the chevron tabbable; either implement a real combobox or drop the role.

**LA20. Session-ended overlay in the launcher (extends H4)** | accessibility | medium | S
Besides H4's points: focus is not moved into the alert dialog and the page behind is not made inert (`launcher.html:577-602`). When the launcher is embedded, the panel and the frame each hold this block (`:565`), so two overlays can stack (unverified).

Fix: one overlay owned by the top frame, focused, with a Reconnect button in the app.

**LA21. Inside the panel, the setup sheet and menus are modal only within the frame** | accessibility | medium | M
The sheet's backdrop and Tab trap cover the iframe document only (`launcher.html:484`, `:1873-1881`; `src/ui.html:2789`). The panel sidebar stays clickable and tabbable while a "modal" is open, and Escape pressed with focus in the panel does not close it. Unverified at runtime.

Fix: ask the parent to dim and inert its chrome while the sheet is open.

**LA22. Offline name field: placeholder is the only visible label, no checks before sending** | accessibility | low | S
"Name, 3 to 16 characters" disappears on typing. The rule is letters, digits and underscore (`client-auth.mjs:16`), not "characters". "Add" and "Play" are enabled when the field is empty.

Evidence: `launcher.html:1321-1323`, `:1473-1475`.

Fix: a visible label, a live hint, and a disabled button until the name is valid.

**LA23. Chip and Play sentence can name different players** | clarity | low | S
The chip shows the default account. A setup with its own "Play as" uses another one (`:743-752`). Only the sentence under Play shows it.

Fix: when the current setup overrides the account, add "this setup: NAME" under the chip or in the setup button.

**LA24. "Another setup is launching" does not say which or offer to show it** | clarity | low | S

Evidence: `launcher.html:809`.

Fix: name the setup and link "Show it" (which is `pickProfile`).

**LA25. "Try again" on the unreachable screen gives no feedback, and the text assumes a browser tab** | missing state | low | S
The button calls `poll()` and nothing changes if it fails again (`:1363`). "If you closed the SpawnLoft app, open it again" is shown inside the app's own launcher window too (`:1362`).

Fix: a "Trying…" state on the button, and app-specific text when `desktop` is present.

**LA26. The card and its type grow with the window (extends G5)** | scaling | medium | S
Besides the `vw` font sizes in G5:
- The card's width is `clamp(680px, 34vw, 960px)` (`:384`).
- The Play button's height is `clamp(72px, 4.2vw, 100px)` (`:392`, `:394`, `:454`).
- The stage's bottom padding is `14vh` (`:375`).
At 2560 wide the card is 870px and the button 100px tall, on top of Auto zoom. This is "bigger", not "more".

Fix: fixed sizes. Use the spare width for recent setups (G11).

**LA27. At the launcher's minimum width, menus become bottom sheets with no scrim** | scaling | low | S
Below 700px menus are fixed to the bottom edge (`:513-523`). The window's minimum is 640 CSS px (`bridge.rs:74`). There is no backdrop, so the sheet floats over a live page. Unverified visually.

**LA28. Setups cannot be renamed (G10), duplicated, exported or imported** | gap | medium | M
The name is read-only on edit (`:1970`). There is no "Duplicate" and no modpack import. Prism, the Modrinth app and CurseForge all have these.

**LA29. Only Vanilla and Fabric** | gap | medium | L
The loader control has two segments (`:1934`) and the server allows two (`client.mjs:24`). Forge, NeoForge and Quilt are absent, although the panel creates Forge servers (`linux-package.mjs:90-91` advertises them). A Forge server made in SpawnLoft cannot be joined with a matching client from SpawnLoft's own launcher.

**LA30. No mod list or mod install for a Fabric setup** | gap | medium | L
The only guidance is "Put them in the setup's mods folder." (`:1940`). Outside the desktop app there is no Open folder button, only a path (`:1621`).

**LA31. No game options comparable launchers have** | gap | low | M
The sheet has no JVM arguments, window size or fullscreen, no "close the launcher when the game starts", and no per-setup icon. The profile keys are fixed at nine (`client.mjs:27`).

**LA32. No last-played time, play time or sort in the setups menu; no skin or avatar** | gap | low | M
Rows show version, memory and server only (`:1521-1534`). Accounts are a coloured initial (`:1065`).

**LA33. No download size before the first Play, and no way to see or clear downloaded versions** | gap | low | M
The copy says "Nothing is downloaded until you press Play." (`:2016`) and "The first time downloads the game." (`:2067`), with no figure.

**LA34. The "does not stop the download" hint shows on every step** | clarity | low | S
It is shown during "Starting NAME" and "Starting the game" too (`:1601`).

**LA35. Flash and warning notices stay until dismissed** | consistency | low | S
"Saved SETUP" and "Playing, with a warning" persist (`:1140`, `:1733`). The panel's toasts time out. The dismiss "x" is 28px (G10).

### LA-C. Keep

- One sentence under Play that states exactly what will happen, including "Starts NAME first (up to 2 minutes)" (`:942-950`).
- Blocked Play that names the reason and puts the fix as links in the same sentence (`:805-815`, `:1385`).
- "Who's playing?" asked only when it is needed, with "SpawnLoft never sees your password" (`:1469`).
- First run needs no form: Play makes a setup for the latest release (`:1405-1460`).
- A launch survives a reload and is picked up again (`:2443-2450`); a server restart during a launch is explained (`:1710`).
- Clean exits are silent; only real crashes get a notice, with the log lines coloured by level (`:845-863`, `:1635-1648`).
- The sign-in address is checked to be Microsoft's before it is opened (`:2127`), and a blocked pop-up has its own message and link (`:1350-1351`).
- Menu arrow keys, Escape with focus return, and focus and caret kept across re-renders (`:1247-1283`).
- Running fields in the sheet go read-only with "Stop the game to change it." instead of failing on save (`:1902-1906`).
- "Launched by an assistant" pill (`:1613`), and the assistant-account switch being off by default (`:2005-2008`).

---

## 2. First-run wizard (`src/setup.html`)

### WZ-A. Inventory

- Window document title "SpawnLoft setup" (`setup.html:4`).
- Brand "SpawnLoft"; steps "1 Choose folders" and "2 Open the panel" (`:471-475`).
- Heading "Where should SpawnLoft keep your servers?" (`:484`).
- Lead "Worlds, downloaded server jars and backups go here. Not the program itself — that is already installed. You can move this later from Settings." (`:485-488`).
- Field "Data folder", "Browse…", hint "A fresh server takes about 300 MB. Worlds grow from there." (`:491-496`).
- Checkbox card "Put servers on a different drive" / "Worlds and backups are the parts that grow. Turn this on if they should live somewhere with more room than the folder above." (`:499-506`).
- Hidden until ticked: "Servers folder", "Browse…", "Jars, backups and settings stay in the data folder above." (`:508-515`).
- Java check row (`:522-527`, `:626-650`)
  - Pending: "Checking for Java…" / "Minecraft servers run on Java. SpawnLoft needs one installed.".
  - OK: "Java is installed" plus the version string.
  - Check failed: "Could not check for Java" / "Carry on — SpawnLoft will say so again if a server fails to start.".
  - Otherwise: "Java needs updating" or "Java is not installed", then the server message plus " You can finish setting up either way — servers will not start until it is sorted.", and a button "Get Java".
- Error box (`:529`, `:549-553`)
  - "This screen is part of the SpawnLoft desktop app and cannot run in a browser." (`:572`).
  - "SpawnLoft could not read its settings." plus the raw error (`:580`).
  - "SpawnLoft could not read its settings file, so it does not know where your servers are. FILE (ERROR) If you already have servers, close SpawnLoft and mend or delete that file, or choose the folder that holds them below. The damaged file is kept next to the new one." (`:589-594`).
  - "Both folders are needed before SpawnLoft can continue." (`:662`).
  - "SpawnLoft could not save these locations." (`:679`, `bridge.js:44`).
  - Server texts: "Choose a folder for SpawnLoft's files.", "Choose a folder for the servers.", "Cannot write to DIR" plus the raw error, "SpawnLoft could not remember that location. It saved to FILE but read back … Check that file is writable, then try again." (`first-run.mjs:46-68`).
- Footer: note "Setting up, then restarting into the panel…" and "Continue" (`:532-533`, `:670`).
- Folder dialog titles: "Choose where SpawnLoft keeps its files" and "Choose where servers are stored" (`:611`, `:619`).

### WZ-B. Findings

**WZ1. The Java result is mislabelled in three of its states** | clarity | high | S
Anything other than a clean "ok" falls into one branch that:
- titles the row "Java needs updating" whenever Java was found, and
- appends "servers will not start until it is sorted" (`setup.html:637-646`).
That is wrong for:
- Java found but its version unreadable, which the server reports as fine: "Found X." (`java.mjs:87`).
- Java that runs older versions: "will run older Minecraft versions" (`java.mjs:107-108`).
- Java that is present but could not be run, which is titled "Java is not installed" (`java.mjs:64-68`, `setup.html:643`).

Fix: branch on `reason`. For example, "Java 17 found. Fine for older versions; current Paper needs 25." with no "will not start" line.

**WZ2. No "Check again", and "Get Java" drops the user on a download matrix (extends H3)** | flow friction | high | M
The check runs once, at load (`setup.html:599`). "Get Java" opens `https://adoptium.net/temurin/releases/?version=25` (`java.mjs:15`), where the user must choose operating system, architecture and package type. Combined with the 15-minute sign-in expiry (H2), the natural path of install Java, come back, Continue fails.

Fix: re-check on window focus and add a "Check again" button. Better, offer "Install Java for me". The game launcher already fetches Mojang's Java by itself (`client.mjs:469`), so a server-side equivalent is the feature users of comparable tools expect.

**WZ3. Browse can fail silently** | missing state | medium | S
`d.pickFolder` is awaited with no try or catch (`setup.html:610-611`, `:618-619`). The bridge rejects with "not the panel" in the webkit2gtk race that `bridge.js:47-50` documents, and with "the window bridge is not ready" (`bridge.js:10`). The click then does nothing.

Fix: catch the rejection, retry once, then show "The folder chooser could not open. Type the path instead."

**WZ4. Three names for one idea on one card** | clarity | medium | S
The heading asks where to keep "your servers". The field is "Data folder". The toggle then offers to put "servers" somewhere else, in a "Servers folder", while "Jars, backups and settings stay in the data folder above". "Jars" is jargon.

Evidence: `setup.html:484-514`.

Fix: heading "Where should SpawnLoft keep its files?", field "SpawnLoft folder", toggle "Keep worlds on another drive".

**WZ5. "You can move this later from Settings" points at the wrong place** | consistency | medium | S
In the panel, "Settings" is a per-server tab (`src/ui.html:2775`). The data folder lives under "Preferences" with "Change the data folder…" (`src/ui.html:3262`, `:13477`).

Evidence: `setup.html:487`.

Fix: "from Preferences".

**WZ6. Raw and misleading save errors (extends H2)** | wording | medium | S
- A path that is typed but not absolute gets "Choose a folder for SpawnLoft's files." (`first-run.mjs:46`).
- A folder that cannot be written gets "Cannot write to DIR" followed by Node's raw text such as "EACCES: permission denied, mkdir …" (`first-run.mjs:53`, `settings.mjs:233`).
- An expired session gets the panel's "run `spawnloft ui`" sentence with backticks (`panel-auth.mjs:367`).
- If the restart call fails after its retries, the user sees "not the panel" although the folders were saved (`bridge.js:51-58`, `setup.html:675-679`; unverified).

Fix: plain sentences per case ("SpawnLoft is not allowed to write there. Pick a folder inside your home folder."), and re-authenticate through the shell instead of printing the command.

**WZ7. Errors are not announced, not tied to a field, and focus stays on the button (extends H7)** | accessibility | medium | S
- The error box has no `role="alert"` (`setup.html:529`).
- Neither input gets `aria-invalid` or focus.
- The Java row is not a live region, so "Checking for Java…" changing to the result is silent (`:522-527`).
- The Java status is an 8px coloured dot with no icon (`:411-430`).
- The footer note "Setting up, then restarting into the panel…" is not live (`:532`).

Fix: `role="alert"` on the box; `role="status"` on the Java row and the note; an icon per state; focus the offending field.

**WZ8. "Both folders are needed" when only one folder is asked for** | wording | low | S
The same sentence is used when the toggle is off and the single field is empty (`setup.html:661-662`).

Fix: "Choose a folder first."

**WZ9. The damaged-settings message asks the user to hand-repair a file** | flow friction | medium | S
"close SpawnLoft and mend or delete that file" shows a path and a parser error, with no button (`setup.html:589-594`).

Fix: lead with the action that works here ("Choose the folder that holds your servers below"), offer "Show the file", and move the raw error behind "Details".

**WZ10. No information about the chosen folder** | gap | medium | M
The wizard does not show free space (despite "A fresh server takes about 300 MB"), does not say whether the folder already contains SpawnLoft servers that will be picked up, and does not warn about a non-empty unrelated folder. The write test happens only on Continue (`first-run.mjs:51-54`).

Fix: after a pick, show "120 GB free" and "3 servers found here, they will appear in the panel".

**WZ11. Windows-only path building and wording on all platforms (extends H6)** | wording | low | S
`serversUnder` appends `\instances` (`setup.html:563`). "Put servers on a different drive" is Windows phrasing; on Mac and Linux it is a disk or folder (`:501`).

Fix: build the path with the separator found in the root; say "on another disk or folder".

**WZ12. The step indicator's second step is not a step** | hierarchy | low | S
"2 Open the panel" (`setup.html:474`) is just what happens on Continue. A two-dot stepper for a one-page form adds reading and suggests more to come.

Fix: drop it, or label the button "Continue to SpawnLoft".

**WZ13. Continue leads to a bare "Starting SpawnLoft…" page** | missing state | low | S
After a save the shell navigates the window to the start page while the core restarts (`bridge.rs:224-231`, `:433-444`). The wizard's note is gone by then. See SH3.

**WZ14. Primary button style differs from the launcher's** | consistency | low | S
The wizard's primary has a gradient and a glow (`setup.html:364-365`). The launcher's is flat (`launcher.html:290`). G10 noted the launcher against the panel; this is the third variant.

**WZ15. Fit at the main window's minimum size** | scaling | low | S
The card is a fixed 660px column, centred with 28px of body padding (`setup.html:273`, `:280`). With the Java warning and an error box showing it is likely taller than the 600px minimum window (`bridge.rs:71`) and will scroll. Unverified. At 2560 it stays 660px, which matches the settled rule.

### WZ-C. Keep

- One screen and one question; the comment trail shows it was cut down on purpose (`setup.html:478-483`).
- The Java check happens before any download, and never blocks Continue (`:517-521`, `:646`).
- The servers path follows the data folder until the user edits it by hand (`:544-547`, `:566-568`).
- Enter submits; paths are trimmed; the save is write-tested and read back before the restart (`:652-660`, `first-run.mjs:50-69`).
- "Setting up, then restarting into the panel…" warns that the window will blink (`:668-670`).
- An unreadable settings file is explained instead of showing empty boxes (`:579-594`).

---

## 3. Sign-in page and other plain pages

### SI-A. Inventory

- **"Opening SpawnLoft"**: served after a good sign-in link. h1 "Opening SpawnLoft" and link "Continue to SpawnLoft", with an instant refresh (`panel-auth.mjs:385`).
- **"Sign in to this panel"**: HTTP 401 for a page request with no session or a refused link. h1 "Sign in to this panel", body "Open SpawnLoft from the app, or run `spawnloft ui` to get a new link." (`panel-auth.mjs:388-390`).
- **JSON answers a person can land on**
  - `{"error":"this panel only answers requests addressed to localhost"}` with 403 (`panel-auth.mjs:371-373`).
  - `{"error":"this panel needs a sign-in: open SpawnLoft from the app, or run `spawnloft ui` to get a new link","code":"auth"}` (`panel-auth.mjs:367`, `:393-395`).
  - `{"error":"not found"}` for `/setup` in a browser and for unknown paths (`ui.mjs:1480`, `:1493`).
- **Local "open" file** written by `spawnloft ui`: title "Opening SpawnLoft"; "Opening SpawnLoft. If nothing happens, continue to SpawnLoft." and "This link signs one browser in, once, within five minutes." (`panel-open.mjs:80-88`).
- **Microsoft callback pages**: "Finishing sign-in" / "Finishing the sign-in in SpawnLoft. You can close this window."; and "This sign-in link is not valid any more" / "Start the sign-in again from the SpawnLoft launcher." (`ui.mjs:1408-1421`).
- **Session-ended overlay** in panel pages and the launcher: "This panel session has ended" (`launcher.html:591-598`).
- Shared style for these pages: `#111` background, `#eee` text, `#bbb` paragraph, `#9cf` links, centred (`panel-auth.mjs:353`, `ui.mjs:1414`). The open file is left-aligned with inline styles (`panel-open.mjs:85`).

### SI-B. Findings

**SI1. "Sign in to this panel" has nothing to sign in with** | flow friction | high | M
The title names an action, but the page has no form, no button and no link. Inside the desktop app (after the 15-minute idle expiry, `panel-auth.mjs:32`, or a core restart) the window shows this page and the only way forward is to quit and reopen the app. "Run `spawnloft ui`" is a terminal command.

Evidence: `panel-auth.mjs:388-390`. Extends H2 and H4.

Fix: in the app, the shell should catch a 401 on a main-frame load and navigate through `/auth` again, as `open_panel` already does (`main.rs:342-375`). In a browser, retitle to "This page is no longer signed in" and keep the command as a second line.

**SI2. An expired or used link looks the same as never having signed in** | clarity | medium | S
`login-refused` and plain `unauthorized` share one page (`panel-auth.mjs:388`). The open file promises "once, within five minutes" (`panel-open.mjs:87`), but the page that follows a second click or a late click does not say so.

Fix: a separate page: "This sign-in link was already used or is older than five minutes. Get a new one from the SpawnLoft app."

**SI3. The callback page never reports the outcome** | missing state | medium | M
See LA7. "Finishing sign-in" is final text. A failed Xbox or Minecraft step is never shown in the browser tab the person is looking at (`ui.mjs:1408-1412`). The code comment explains the security reason, namely that a replayed callback must learn nothing. A neutral "Go back to SpawnLoft to see the result" would keep that property.

Fix: reword to "Almost done. Go back to SpawnLoft; it shows the result there." and raise the app window.

**SI4. Raw JSON shown for page-level mistakes** | wording | low | S
Opening the panel by machine name or LAN address gives a JSON 403 (`panel-auth.mjs:371-373`). A mistyped path gives `{"error":"not found"}` (`ui.mjs:1493`).

Fix: for requests that accept `text/html`, serve the same small page with a sentence and a link to `/`.

**SI5. Helper pages ignore the theme and differ from each other (extends H7)** | consistency | low | S
The two server pages share one style string, but it is hard-coded `#111`, with no logo and no theme (`panel-auth.mjs:353`, `ui.mjs:1414`). The file page is left-aligned with different markup (`panel-open.mjs:85-87`). The start page uses `#16181d` (`index.html:6`). The session-ended overlay uses fixed Classic colours (`launcher.html:584-596`).

Fix: one tiny shared template that takes the saved theme, as `/setup` and `/launcher` already do (`ui.mjs:1482-1483`).

**SI6. "Opening SpawnLoft" relies on a zero-second refresh** | accessibility | low | S
The page has a link fallback, which is good, but no text that says what to do if it stays (`panel-auth.mjs:385`). The file version does say it (`panel-open.mjs:86`).

Fix: reuse the file version's sentence.

### SI-C. Keep

- Pages work with scripts off, set no-referrer and a tight content policy, and use a one-use link (`panel-auth.mjs:352-364`, `panel-open.mjs:78-89`).
- "This link signs one browser in, once, within five minutes." is exactly the right amount of explanation (`panel-open.mjs:87`).
- An invalid callback says what to do next: "Start the sign-in again from the SpawnLoft launcher." (`ui.mjs:1411`).
- The session-ended overlay stops all retries and toasts behind it, so the user sees one message and not a cascade (`launcher.html:565-570`, `:618-629`).

---

## 4. Tauri shell, installer and packages

### SH-A. Inventory

- **Windows**
  - Main window: title "SpawnLoft", 1280 x 820, minimum 900 x 600 (`bridge.rs:70-71`, `:515`).
  - Launcher window: "SpawnLoft Launcher", 1040 x 640 CSS px, minimum 640 x 520 (`bridge.rs:73-74`, `:672`).
  - Console windows: "SpawnLoft", 980 x 660 (`bridge.rs:645-648`).
- **Start page**: "Starting SpawnLoft…" (`index.html:11`).
- **Native dialogs**
  - Title "SpawnLoft could not start its panel"; body "WHY. Running servers are not affected. Details are in PATH/panel.log."; OK only (`main.rs:379-390`).
  - WHY is one of:
    - "this installation has no core program (resources/bin)" (`:249`)
    - "PATH did not start: ERROR" (`:270`)
    - "the core did not print its address within 90 seconds" (`:287`)
    - "the core exited before the panel was ready; see panel.log" (`:315`)
    - "the core keeps stopping; see panel.log" (`:325`)
    - "the core printed a bad address" (`:345`)
    - "the panel address is not loopback" or "capability: …" (`bridge.rs:192-211`)
    - "the core printed an address with no port" (`main.rs:351`)
    - "could not build the panel's address" (`:364`)
    - "could not sign the window in to the panel" (`:365`)
  - Windows-only message boxes: "SpawnLoft could not open its window" with "On Windows, SpawnLoft needs Microsoft Edge WebView2. Install the Evergreen runtime from … and open SpawnLoft again. Your servers keep running either way." (`main.rs:140-146`); and "SpawnLoft could not start" (`:163`). On Mac and Linux these go to stderr (`:409-412`).
  - File dialogs: "Choose a folder" and "Choose a file", with filters "World archives" and "All files" (`bridge.rs:276`, `:294-296`).
- **Behaviours without UI**
  - Downloads are saved to Downloads and shown in the file manager (`bridge.rs:718-759`).
  - Ctrl or Cmd with plus, minus and zero change the zoom (`bridge.js:67-76`).
  - A second start focuses the main window (`main.rs:123-129`).
  - A core that dies is restarted up to 3 times (`main.rs:49`, `:317-331`).
  - An update installs on quit (`main.rs:168-172`).
- **Windows installer** (`installer.nsi`)
  - Pages: Welcome (`:237`); License if defined (`:242`); reinstall choice (`:285-344`); "Stopping servers for the update" (`:607-610`); install folder (`:489`); Start menu folder (`:499`); progress (`:502`); Finish with a desktop shortcut tick and a run tick (`:508-517`).
  - Uninstaller: confirm page with the tick "Also delete servers, worlds, backups, jars and settings" (`:809`), then progress.
  - "Stopping servers for the update" / "Each running server is asked to stop and save. They start again after the update." / "Looking for running servers..." (`:607-610`).
  - Message boxes:
    - "NAME is still running and could not be stopped in 5 minutes. Stop it and run the update again. Nothing was changed." (`:662`, `:1068`)
    - "The servers could not be stopped for the update (code N). Nothing was changed." (`:666`, `:1073`)
    - "SpawnLoft 1 was removed, but SpawnLoft 2 could not be installed completely. Run this setup again, then open SpawnLoft: the servers that were running start again and the scheduled tasks are switched back on." (`:1262`)
    - "SpawnLoft 1 could not be removed, so SpawnLoft 2 was not installed. Close SpawnLoft and try again." (`:1547`)
  - Progress lines:
    - "Starting the stopped servers again under SpawnLoft 1" (`:592`)
    - "node.exe is in use; it was moved to resources\runtime\… until that program ends" (`:787`)
    - "SpawnLoft 2 is being installed without Microsoft Edge WebView2. Its window will say how to get it." (`:962`, `:999`)
    - "Stopping servers for the update" (`:1054`)
    - "Removing the newer version's files" (`:1088`)
    - "spawnloft-core.exe is in use by running servers; it was moved to … until they restart" (`:1113`)
    - "Updating scheduled tasks and server launchers" (`:1226`)
    - "Starting the servers again" (`:1233`)
    - "Stopping servers and removing scheduled tasks" (`:1361`)
    - "Replacing SpawnLoft 1" (`:1511`)
    - "SpawnLoft 1 could not be removed (exit code N)" (`:1544`)
  - Aborts: "node.exe is in use and could not be moved aside" (`:785`); "spawnloft-core.exe is in use and could not be moved aside" (`:1111`).
  - Footer branding text is the copyright value "joogiebear" (`installer.nsi:147`, `tauri.conf.json:22`). Publisher is "victor zemeckis" (`tauri.conf.json:21`).
  - All standard page texts (welcome, reinstall choices, WebView2 lines, "app is running") come from Tauri's language files, which are not in the repo. Their wording is unverified.
- **Linux package**: menu entry "SpawnLoft", comment "Minecraft servers on your own PC, without the terminal", category Utility, program name `spawnloft-desktop` (`linux-package.mjs:76-86`). The post-install scripts print nothing (`:99-109`).
- **macOS**: a grep of `mac-config.mjs` and `mac-package.mjs` found no user-facing strings beyond the product name.

### SH-B. Findings

**SH1. Closing the main window while a launcher or console window is open leaves the app with no way back** | missing state | high | S
The app exits only when the last window closes (`main.rs:166-172`). If the main window is closed first, the process and the core keep running behind the launcher. Starting SpawnLoft again hits the single-instance handler, which only looks for the main window and does nothing when it is gone (`main.rs:123-129`). No code recreates the main window. The panel is then unreachable until the remaining windows are closed.
Runtime unverified; the code path is plain.

Fix: in the single-instance callback, call `build_main` when the main window does not exist and navigate it to the panel. Or close child windows with the main one.

**SH2. "Could not start" is a developer sentence in an OK-only box over a window that stays on "Starting SpawnLoft…" (extends H1)** | missing state | high | M
All ten reasons listed in the inventory are internal ("the core did not print its address", "capability: …", "the core printed a bad address"). The dialog is non-blocking with only OK (`main.rs:382-389`). The window behind never changes and has no Try again, no Open log and no Quit. For up to 90 seconds before that there is only static text (`main.rs:38`, `index.html:11`).

Fix: as H1 says, an in-window error state. Add a user-level sentence per cause ("SpawnLoft's background service did not start"), buttons Try again and Show log file, and the technical line under "Details".

**SH3. A background restart blanks the main window and closes the others with no explanation (extends H5)** | missing state | medium | M
When the core ends by itself, `clear_panel` sends the main window to the start page and closes every other window (`bridge.rs:224-235`, `main.rs:327-331`). The start page says "Starting SpawnLoft…", as on a cold start. Anything typed in an open form or console is lost. The same path runs after the wizard's Continue (`bridge.rs:433-444`).

Fix: a distinct "Reconnecting…" state, reopening the launcher and console windows afterwards, and "Opening your panel…" after the wizard.

**SH4. Refused links and windows do nothing visible** | missing state | medium | S
A navigation outside the panel's origin is dropped and only logged (`bridge.rs:166-178`). `window.open` to anything but the launcher, a console or an https address is dropped and logged (`bridge.rs:609-627`). An `http:` link in a plugin description therefore does nothing when clicked. `open_external` returns `ok: false` for non-https, and the wizard's "Get Java" ignores the result (`setup.html:649`).

Fix: send plain `http:` links to the browser too, or surface a toast "SpawnLoft only opens https links".

**SH5. Downloads give no confirmation in the app, and failures are silent** | missing state | medium | S
A finished download opens the file manager on the file (`bridge.rs:747-752`), with no in-app message. A failed one is only logged (`:753`). The file name may have been changed to "name (2).zip" (`:793-807`) without the user being told.

Fix: have the shell emit an event that the panel shows as a toast ("Saved to Downloads as world (2).zip", with Show), and an error toast on failure.

**SH6. Every window is titled "SpawnLoft" (extends H7)** | clarity | low | S
The main window, every console window and the wizard share the title (`bridge.rs:515`). Only the launcher differs (`:672`). The taskbar and Alt+Tab cannot tell three consoles apart.

Fix: "NAME console · SpawnLoft" and "SpawnLoft setup".

**SH7. Zoom shortcuts change the size silently, and minimum sizes do not follow (extends H7)** | missing state | low | S
The key handler discards the reply (`bridge.js:75`). The main minimum is a fixed 900 x 600 whatever the zoom (`bridge.rs:71`, `:543`). The launcher's minimum is computed from the zoom once, at creation (`bridge.rs:664`, `:674`).

Fix: a brief "125%" overlay, and re-apply the minimum sizes in `apply_zoom`.

**SH8. No app menu, tray icon or About** | gap | low | M
There is no place in the shell for "Quit", "Check for updates", "Open log folder" or the version. Users of comparable desktop tools expect at least About and Quit. On macOS the default Tauri menu applies (unverified).

**SH9. The file chooser always leads with "World archives"** | consistency | low | S
`pick_file` has one fixed filter set (`bridge.rs:294-296`) whatever the title, so any other use of it, such as a Java path, opens filtered to zip files.

Fix: take the filter from the caller, from a fixed allow-list.

**SH10. Start page colours and semantics (extends H7)** | consistency | low | S
The page is `#16181d` (`index.html:6`), the window background is `#0c0e14` (`bridge.rs:513`), and the theme is not applied, so the SpawnLoft theme flashes blue-grey. There is no logo, no spinner and no `role="status"`.

**SH11. Fatal errors on Mac and Linux go to the terminal only; the WebView2 text is Windows advice (extends H1)** | missing state | medium | S
`message_box` is `eprintln!` off Windows (`main.rs:409-412`), so a double-clicked app that cannot make its window just does not appear. The message printed says "On Windows, SpawnLoft needs Microsoft Edge WebView2…" on every platform (`main.rs:143-145`).

Fix: use a native dialog on all three platforms, and platform-specific advice (webkit2gtk on Linux).

**SH12. Installer: the install-folder page is still shown on a fresh install** | flow friction | medium | S
`MUI_PAGE_DIRECTORY` is skipped only for passive runs and when replacing 1.x (`installer.nsi:488-489`). The wizard's own text and comment say the installer no longer asks for a location (`setup.html:478-483`, `:486`). A new user is asked "where" twice, which is the confusion that comment says was fixed. Whether a build setting hides the page is unverified; `installer-config.mjs` does not.

Fix: skip the directory page (per-user install), or change the wizard's wording.

**SH13. Installer: uninstall stops every server and removes scheduled tasks without saying so** | weak confirm | medium | S
The uninstall section always runs "Stopping servers and removing scheduled tasks" (`installer.nsi:1349-1364`). The confirm page's only added text is the data tick (`:809`). H7 already covers the missing second confirm for the data tick.

Fix: a line on the confirm page: "Running servers will be stopped and their schedules removed. Your worlds are kept unless you tick the box."

**SH14. Installer: Cancel during "Stopping servers" can look frozen for minutes** | missing state | medium | S
The abort handler loops with `Sleep 250` up to 2,400 times, which is 10 minutes, waiting for the stop helper to finish (`installer.nsi:680-689`). The page label is not updated to say it is cancelling. The page itself is a single text label with no progress bar (`:610`).
Runtime unverified.

Fix: set the label to "Cancelling. Starting your servers again…" before the loop, and add a marquee bar.

**SH15. Installer: raw codes and file names in messages** | wording | low | S
- "(code N)" in two message boxes (`:666`, `:1073`).
- "node.exe is in use and could not be moved aside" and "spawnloft-core.exe is in use and could not be moved aside" as abort texts with no next step (`:785`, `:1111`).
- "(exit code N)" in the log (`:1544`).

Fix: "Another program is using SpawnLoft's files. Close SpawnLoft windows and any terminal running spawnloft, then run setup again."

**SH16. Installer: a second copy exits with no message** | missing state | low | S
The single-instance guard quits with error level 5 and shows nothing (`installer.nsi:712-718`), so a double-click while setup is already open looks like nothing happened.

Fix: bring the first window forward, or show "SpawnLoft setup is already running."

**SH17. Installer identity strings do not match** | consistency | medium | S
The installer footer shows "joogiebear" (`installer.nsi:147`, `tauri.conf.json:22`). The publisher shown in Windows' installed-apps list is "victor zemeckis" (`tauri.conf.json:21`). The app identifier still says `mcctl` (`tauri.conf.json:6`). Three different names in a trust-sensitive place.

Fix: one publisher name everywhere, and the footer set to "SpawnLoft VERSION".

**SH18. Installer: SpawnLoft's own strings exist in English only** | consistency | low | S
`deleteAppData` is defined for English only (`installer.nsi:809`), and all SPAWNLOFT message boxes and progress lines are literals. The template still loops over languages (`:800-807`). If a second language is ever enabled, the uninstall tick would have no label in it. Latent today.

**SH19. Linux menu entry** | wording | low | S
The comment says "on your own PC" and the category is Utility only (`linux-package.mjs:84-85`). The program is installed as `spawnloft-desktop` (`:51`), which is what appears in process lists and "open with".

Fix: "on your own computer", and add `Game;` to the categories.

### SH-C. Keep

- Every failure message says "Running servers are not affected" (`main.rs:384`), and the WebView2 one says "Your servers keep running either way" (`:145`).
- The core is restarted by itself up to three times, with the count reset after five stable minutes (`main.rs:48-51`, `:317-331`).
- A second launch focuses the existing window (`main.rs:123-129`). Window size and position are remembered for the main and launcher windows (`bridge.rs:533-549`, `:665-688`).
- Opening a console or the launcher again brings the existing window forward (`bridge.rs:641-654`).
- Downloads never overwrite: "name (2).ext" (`bridge.rs:793-807`).
- The installer's update texts are plain and say what state things are in: "Each running server is asked to stop and save. They start again after the update." and "Nothing was changed." (`installer.nsi:607`, `:662`).
- The 1.x to 2 failure message tells the user exactly what to do and what will happen (`installer.nsi:1262`).
- The uninstall data tick lists what it deletes and is off by default (`installer.nsi:809`).
- Microsoft sign-in uses the person's own browser and its password manager (`bridge.rs:411-414`).

---
