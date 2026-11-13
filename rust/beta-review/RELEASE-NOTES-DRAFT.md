# SpawnLoft 2.0.0-beta.1 (draft release notes)

Draft for Victor to edit. Lines marked **[confirm]** depend on work or decisions still open in
[REVIEW.md](REVIEW.md); remove the mark or the line before publishing.

---

## Your servers are stopped and started again for this update

Updating from SpawnLoft 1 to 2.0 replaces the whole program, so this one time the installer stops
every running server and database (a normal `stop`, with a save, never a kill), installs 2.0, and
starts them again. Players are disconnected for a minute or two. If a server will not stop within
five minutes, the update is called off, everything is started again under SpawnLoft 1, and it
tries again later.

After this, updates no longer touch running servers: from 2.0 on, servers keep running while
SpawnLoft updates itself.

On macOS and Linux the update does not stop anything. Servers that were running keep running under
SpawnLoft 1 until you restart them; the panel shows a banner with a Restart button for each.

## What is new

- **A new app.** It no longer carries its own copy of Chromium: the window uses the system's web
  view (WebView2 on Windows, installed for you if it is missing), so the download is much
  smaller. **[confirm: add measured size and memory figures, or leave as is]**
- **Servers survive updates.** Each server is looked after by a small supervisor that keeps
  running while the app updates or restarts.
- **Signed updates.** Every update is checked against SpawnLoft's own signing key before it is
  installed, on top of the Windows and Apple signatures.
- **Go back to a previous version.** Preferences → Updates → "Reinstall a previous version" lists
  earlier 2.x releases and installs the one you pick. Updates are then paused until you resume
  them.
- **`spawnloft` on your PATH on Windows.** Open a new terminal after installing and
  `spawnloft list` works. `mcctl` still works too.
- **Linux arm64** packages, beside x64.
- **The panel only answers you.** SpawnLoft 1's panel answered any program on the same computer,
  including programs of other accounts on it. 2.0's panel needs a sign-in: the app's window signs
  itself in, and nothing changes for you there. Without the app, `spawnloft ui` opens your
  browser already signed in and prints a one-use link (`spawnloft ui --link` makes a new one). A
  bookmark or an open tab at `http://127.0.0.1:8770/` now shows "Open SpawnLoft from the app, or
  run `spawnloft ui`", and scripts calling the panel's HTTP API get `401` until they sign their
  requests (the README's "Panel access" has the recipe). SpawnLoft 1 is not changed: updating to
  2.0 is the fix.
- Nothing to install first: the app brings the runtime it needs. You still need Java for the
  Minecraft servers themselves.

Everything you had is kept: servers, worlds, backups, scheduled tasks, settings, Microsoft
sign-ins. Scheduled tasks and assistant (MCP) configurations written by SpawnLoft 1 keep working
without changes.

## Downloads

| System | File |
| --- | --- |
| Windows 10 and 11 (x64) | `SpawnLoft-Setup-2.0.0-beta.1.exe` |
| macOS 13 or newer, Apple Silicon **[confirm the minimum]** | `SpawnLoft-2.0.0-beta.1-mac-arm64.dmg` **[confirm the dmg exists]** |
| Ubuntu 22.04+, Debian 12+ | `SpawnLoft-2.0.0-beta.1-linux-amd64.deb`, `-linux-arm64.deb` |
| Fedora and relatives | `SpawnLoft-2.0.0-beta.1-linux-x86_64.rpm`, `-linux-aarch64.rpm` |
| Servers without a desktop | the `spawnloft-cli` packages |

If you run a SpawnLoft 1 beta you do not need to download anything: it updates when you next quit
the app. SpawnLoft 1.5.0 on the stable channel is not offered this beta.

Intel Macs are not supported.

## Good to know in this beta

- **Linux updates are installed by your package manager.** When an update is ready, run
  `spawnloft update apply`; it downloads and checks the package and prints the `apt` or `dnf`
  command to install it. **[confirm: the Updates page still shows an Install button on Linux that
  does not work; remove this sentence once it shows the command instead]**
- **Open the window once after updating from SpawnLoft 1.** If the update was interrupted (for
  example the PC was shut down while it ran), opening SpawnLoft finishes starting your servers and
  tells you what happened. Check that your scheduled tasks are still enabled afterwards.
  **[confirm: remove the last sentence once B1 is fixed]**
- **Uninstalling with "delete app data" removes the whole backups folder you chose** in
  Preferences, including anything else in it. If your backups folder holds other files, move them
  first or leave the box unticked. **[confirm: remove once fixed]**
- If an update fails to install, SpawnLoft tries again the next time you quit. `update.log` in the
  SpawnLoft settings folder says why.

## If you need to go back

To an earlier 2.x version: Preferences → Updates → "Reinstall a previous version".

To SpawnLoft 1.5.0:

1. **Stop every server first.** The 1.x installer closes whatever it finds running.
2. Download and run the [1.5.0 installer](https://github.com/joogiebear/spawnloft/releases/tag/v1.5.0).
   **[confirm the link]**
3. Open SpawnLoft once. It rewrites its scheduled tasks and launchers on first start.

Your servers, worlds and backups are the same files in both versions; nothing is converted.

## Reporting a problem

Open an issue and attach `update.log`, and after an update from SpawnLoft 1 also
`run/handover.json` and `run/handover.log` from the data folder.
