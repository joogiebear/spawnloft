## SpawnLoft desktop development preview

Separate Windows, Mac and Linux installers, built from the same development commit with the
same version. The release is published only after Windows x64, Apple Silicon, Intel Mac and
Linux x64 packages all pass their native checks. Each release is immutable and numbered.

### Fixes to try

- **MySQL and Redis on both platforms:** new setups offer MySQL 8.4 LTS (the default)
  and Redis (Garnet) on Windows x64, Apple Silicon, and Intel Mac. MariaDB is removed
  from new setup choices. Garnet automatically downloads its verified private runtime;
  no separate .NET installation is needed. Its stop action saves a checkpoint before
  terminating the process, and a failed save leaves it running with an error.
- **Reliable rapid restarts:** a process-list entry from before a new launch is rechecked
  before labeling a live daemon as orphaned, avoiding stale Windows PID ownership.

- **Mac scheduling and automatic backups:** native per-user launchd agents run tasks
  with the desktop closed while you are signed in. Create, edit, enable, disable,
  run now, and remove tasks through the Scheduler tab; the Backups tab uses the
  same scheduler and retains only its own scheduled snapshots. No administrator
  password or background copy of the desktop app is needed.
- Daily/weekly jobs missed during sleep run once on wake. Interval jobs skip missed
  runs. Jobs do not run after sign-out. Login tasks run at login and when first
  registered/enabled. macOS may show SpawnLoft in Login Items / background activity;
  disabling it there prevents scheduled work. Remove tasks in SpawnLoft before
  deleting the app.
- **Signed Mac automatic updates:** background download, then install on quit or
  use Restart to update. Which releases a copy follows is a setting (below). Both native
  architectures share a verified feed; Windows update behavior is preserved.
  Ad-hoc test packages still require manual installation.

- **Database CLI startup:** `spawnloft start <database>` and `restart <database>` now
  finish successfully after the database becomes ready, instead of throwing a TypeError
  while trying to display a Minecraft RCON port. Database output labels the database PID;
  detached startup is labeled correctly too. This shared fix applies to Mac and Windows,
  and to both the `spawnloft` and `mcctl` commands.
- **Managed MySQL:** **Create a database** downloads verified MySQL 8.4 LTS binaries
  for Windows x64 or macOS 15+ (Apple Silicon and Intel), initializes a private data directory,
  starts the database and creates scoped credentials for the selected server. No Homebrew,
  system service or separate database installation is needed. Start/stop, restart and SQL
  backup/restore use the managed tools. A Windows computer missing the Microsoft Visual C++
  x64 runtime gets a link to install that prerequisite.
- Mac tool discovery also checks the managed engine store, Homebrew locations, `/usr/local/mysql`
  and PATH when connecting to a database you already run.
- **Plugin database configs stay manual:** database creation and attachment provide
  credentials for you to copy into your plugins. The former `db apply` command and
  panel config-writing controls are removed. Existing plugin files are left unchanged.
- **CLI automation:** versioned `--json` output for status, plugin inventory, backup history,
  backup creation, diagnostics, and environment checks. `metrics --follow --json` streams
  readings; `metrics --csv --output <file>` exports them without overwriting old runs.
- **SpawnLoft terminal command:** both `spawnloft` and the compatible `mcctl` launcher live
  in the package's `Resources/bin` on Mac or `resources/bin` on Windows and use the bundled
  runtime. See [CLI setup and examples](https://github.com/joogiebear/spawnloft/blob/dev/CLI.md).
- **Performance now works on Apple Silicon and Intel Mac:** live server CPU and resident
  memory, ten-second samples, selectable history ranges, and history retained after stopping.
  CPU uses the same share-of-all-cores scale as Windows. Each server restart begins a fresh graph.
- Console output strips ANSI escape sequences into clean, searchable plain text while
  keeping warning and error indicators.
- Long lines scroll horizontally by default. Turn on **Wrap** whenever you prefer.
- Backup history refreshes every four seconds while visible and when reopened, including
  backups made with the CLI. Refreshes preserve backup scope and unsaved schedule edits.
- Snapshots appear only after their archive and manifest are complete. Concurrent backups
  get separate names, and failed archives never appear as completed backups.
- **Settings → Appearance** offers both Classic and SpawnLoft themes.

### Linux servers with no screen

`spawnloft-cli-VERSION-linux-amd64.deb` / `-x86_64.rpm` (and `arm64` / `aarch64`) are the command
line alone, on its own Node runtime, with none of the desktop app's graphical dependencies.
Install with `sudo apt install ./<file>` or `sudo dnf install ./<file>`; it conflicts with the
desktop package, which already contains it. There is no updater: install a newer package the same
way. `spawnloft task linger on` keeps scheduled tasks running after you log out.

### Windows

Download **SpawnLoft-Setup-VERSION.exe**. Windows beta installations continue to receive
beta updates automatically; stable installations stay on the stable release unless
*Settings > Updates > Get beta builds* is turned on, which works the same on Mac and Linux.
Turning it off never downgrades: the copy keeps the beta it has and moves to the next
stable release when that ships. Both
`beta.yml` and `latest.yml` describe the Windows installer on this prerelease.

Like the previous Windows development beta, this GitHub Actions test build is unsigned.
SmartScreen may warn during manual installation: **More info → Run anyway**. Signed
production builds use the existing Azure signing profile on the release machine.

### Mac

- **Apple Silicon (M-series):** download the `mac-arm64.dmg` asset.
- **Intel:** download the `mac-x64.dmg` asset.
- Requires **macOS 13 Ventura or later** and a Java version suitable for your server.

Quit SpawnLoft, open the DMG, and drag SpawnLoft to Applications to replace the previous
preview. Your application data lives outside the app. Beta.25 and older require this
one-time manual replacement to enable automatic updates in signed builds.

<!-- MAC_DISTRIBUTION -->
The Mac app is ad-hoc signed for testing and **not Apple-notarized**. If macOS blocks its
first launch, try opening it once, then use **System Settings → Privacy & Security →
Open Anyway**. If it instead reports a damaged app, report the exact message.
<!-- /MAC_DISTRIBUTION -->

New setups offer **MySQL** and **Redis (Garnet)** on Windows x64 and both Mac architectures.
Managed MySQL 8.4 LTS requires macOS 15+; the desktop app itself runs on macOS 13+.
Garnet installs a verified private .NET runtime automatically. Its stop action waits for a
saved checkpoint before terminating the process because Garnet does not implement SHUTDOWN.
Plugin configs remain manual. MariaDB is no longer offered for new setups.

### Linux

- **Debian and Ubuntu (22.04+, Debian 12+):** the `linux-amd64.deb` asset, or `linux-arm64.deb` on
  arm64. Install it with `sudo apt install ./<file>`, which also pulls in what it depends on.
- **Fedora, the RHEL family and openSUSE:** the `linux-x86_64.rpm` asset, or `linux-aarch64.rpm`
  on arm64. Install it with `sudo dnf install ./<file>`.
- Java is separate, as everywhere, and which one depends on your Minecraft version:
  `sudo apt install openjdk-25-jre-headless`, or on Fedora `sudo dnf install java-latest-openjdk-headless`.
- `spawnloft-desktop` opens the window; `spawnloft` is the command line, and needs no Node.
- On a server with no desktop, run `spawnloft ui --no-open` and reach the panel through an SSH
  tunnel. It listens on loopback only.

Linux has no code signing to check. The package is verified by the hash in the update feed.

**Scheduled tasks and automatic backups run while you are logged in.** Turn on *Keep running
after logout* in the Backups or Scheduler tab if they should outlive your session - on a server
you disconnect from, that is the difference between a nightly backup and none.

Managed **MySQL** is offered on x64 and **Redis (Garnet)** on x64 and arm64. MySQL needs libaio,
libnuma and ncurses, which a stock server does not have: SpawnLoft fetches the distribution's own
packages with `apt-get download` and unpacks them beside the engine, without sudo and without
installing anything on the system. Off Debian and Ubuntu it tells you the command to run instead.

Managed MySQL is not offered on arm64, where Oracle publishes no small build; Redis is. There is
no AppImage yet. Under WSL, a window that shows only a taskbar icon titled
"WARN: Copy Mode" is WSLg, not SpawnLoft: run `wsl --shutdown` from a non-Administrator terminal.

On a machine with a public address and no firewall, `spawnloft doctor` and the panel warn that
RCON is reachable from the internet. Minecraft cannot bind it separately from the game port.

### Toward 1.0

Keep testing setup, both themes, server creation, start/stop/restart, console commands,
backup/restore, and upgrading an existing installation on both platforms. Any remaining
Mac limitations must be implemented or explicitly scoped before calling 1.0 ready.
Signing/notarization status for this build is recorded above. Verify a complete installed
Mac automatic upgrade before promoting the release candidate to 1.0.

This is a development prerelease, not SpawnLoft 1.0.
