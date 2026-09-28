# SpawnLoft

SpawnLoft runs Minecraft servers on the machine in front of you, without a terminal, a hosting account, or Docker. It is a local control plane: many server instances, each supervised by a detached daemon, with captured console output, RCON command and reply, stdin injection, snapshots, scheduled tasks, plugin management, and managed MySQL and Redis databases. Site and guides: [spawnloft.com](https://spawnloft.com).

`spawnloft` is the command-line name. `mcctl` is the original name and runs the same code; existing scripts, scheduled tasks and shortcuts keep working. Settings directories, application identity and the Windows updater were not renamed.

| Guide | Contents |
| --- | --- |
| [CLI.md](CLI.md) | Every command, flag, exit code, and the JSON output contract |
| [MCP.md](MCP.md) | Model Context Protocol server for AI assistants: setup, tools, privacy |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Ground rules, branches, pull requests, release procedure |
| [ROADMAP.md](ROADMAP.md) | Shipped work, planned work, declined scope |
| [desktop/MAC-SIGNING.md](desktop/MAC-SIGNING.md) | Apple Developer ID signing and notarization setup |

## Requirements

| Component | Requirement | Notes |
| --- | --- | --- |
| Java | Java 25+ for Minecraft 26.x; Java 21 for 1.20.5 to 1.21.x; Java 17 for 1.18 to 1.20.4 | Not bundled. SpawnLoft selects the newest installed Java that fits the server's Minecraft version at creation, and refuses a version no installed Java can run before downloading anything. `--force` on `new` and `start` overrides the refusal. |
| JDK (not JRE) | Required only for Spigot and CraftBukkit | BuildTools needs `javac`. |
| Desktop app | Windows 10/11 x64, macOS 13+ (Apple Silicon and Intel), Linux `.deb` (Ubuntu 22.04+, Debian 12+) or `.rpm` (Fedora, RHEL family, openSUSE), x64 and arm64 | Bundles its own runtime. No Node needed. |
| CLI from a checkout | Node 20 or later, and the system `tar` | No npm packages. Where `tar` is GNU tar and cannot read or write a zip, world import and export use SpawnLoft's own zip reader and writer. |
| Linux scheduling | A systemd user session | Tasks run only while you are logged in unless lingering is on (`spawnloft task linger on`). |
| Managed MySQL | Windows x64, macOS 15+, Linux x64 | Linux x64 also needs `libaio`, `libnuma` and `ncurses`; SpawnLoft fetches the distribution packages and unpacks them beside the engine without `sudo`. |
| Managed Redis (Garnet) | Windows x64, macOS (both architectures), Linux x64 and arm64 | Downloads a verified private runtime. |

Java lookup covers `PATH`, `JAVA_HOME`, and the standard install folders (Program Files, the per-user Programs folder), so a Java the installer did not add to `PATH`, or one installed after SpawnLoft started, is still found. Point one server at a specific Java with `spawnloft set <name> java=<path>`. `spawnloft doctor` reports the Java it found; the desktop app shows a header chip when Java is missing or too old.

## Quickstart

```sh
spawnloft new survival --paper 1.21.4 --accept-eula
spawnloft start survival          # blocks until the console prints "Done (…s)!"
spawnloft cmd survival "tps"      # RCON command, reply printed
spawnloft backup survival
spawnloft ui                      # control panel at http://127.0.0.1:8770
```

From a source checkout, replace `spawnloft` with `node spawnloft.mjs` (or `./spawnloft` on Linux and macOS, `spawnloft.cmd` on Windows).

Register a server directory that already exists, in place. Nothing is moved or rewritten, and its ports and RCON password are read from its own `server.properties`:

```sh
spawnloft adopt survival "/srv/minecraft/survival" --memory 6G
```

Create a disposable copy of a server's plugins and configuration on a free port with fresh worlds, to reproduce a bug without touching the real server:

```sh
spawnloft clone survival ecotest && spawnloft start ecotest
```

### Headless Linux

`spawnloft-cli` is the command line alone, without the desktop app's graphical dependencies: a `.deb` and an `.rpm` for x64 and arm64, about 30 MB, with its own Node. It installs `spawnloft` on `PATH` and conflicts with the desktop package, which already contains it.

```sh
sudo apt install ./spawnloft-cli-<version>-linux-amd64.deb     # Debian 12+, Ubuntu 22.04+
sudo dnf install ./spawnloft-cli-<version>-linux-x86_64.rpm    # Fedora, RHEL 9 family
sudo apt install openjdk-25-jre-headless                        # Java is separate
spawnloft new survival --paper 1.21.4 --accept-eula && spawnloft start survival
```

| Concern | Behavior |
| --- | --- |
| Scheduled tasks | Stop when you log out unless lingering is enabled. `spawnloft task linger on` enables it; `task add` warns when it is off. |
| Control panel | `spawnloft ui --no-open` serves on `127.0.0.1:8770`. Reach it with `ssh -L 8770:127.0.0.1:8770 you@server`; no port is opened. |
| Updates | Install a newer package the same way. There is no updater. |

## Server software

`new` downloads or builds the server you name. Every option runs with a plain `-jar`, so the daemon is indifferent to which; the differences are the source, the verification, and what the server loads.

| Flag | Software | Loads | Source and verification |
| --- | --- | --- | --- |
| `--paper <v>` | Paper, newest stable build | Plugins | PaperMC, sha256 |
| `--purpur <v>` | Purpur, a Paper fork with additional configuration | Plugins | purpurmc.org, md5 |
| `--folia <v>` | Folia, Paper with regionised multithreading | Folia-built plugins only | PaperMC |
| `--asp <v>` | Advanced Slime Paper, Paper with Slime World Manager | Plugins | InfernalSuite, sha256 |
| `--spigot <v>` | Spigot | Plugins | Compiled locally by BuildTools |
| `--craftbukkit <v>` | CraftBukkit | Plugins | Compiled locally by BuildTools |
| `--vanilla <v>` | Mojang server | Nothing | Mojang, sha1 |
| `--fabric <v>` | Fabric launcher | Mods | FabricMC |
| `--neoforge <v>` | NeoForge, through its installer | Mods | NeoForged maven, sha256 |
| `--modpack <slug>` | Full server from a Modrinth modpack | Mods | Modrinth |
| `--jar <file>` | A jar from the `jars/` store | Depends on the jar | Local |
| `--template <name>` | A saved plugin and config set | Depends on the template | Local |

`--build <n>` selects a specific build for sources that number builds (Paper, Folia, Purpur).

SpigotMC publishes no jars. BuildTools compiles Spigot and CraftBukkit on this machine: it needs a JDK, fetches a portable git, takes five to ten minutes the first time for a version, and keeps about 1 GB of clones under `jars/buildtools/` so later builds are faster.

The Plugins tab follows the software:

| Software | Plugin search |
| --- | --- |
| Paper | Modrinth and Hangar |
| Purpur | Modrinth for Purpur, Paper, Spigot and Bukkit builds |
| Folia | Folia-built plugins only |
| Spigot, CraftBukkit | Spigot and Bukkit builds |
| Vanilla | Nothing to manage |
| Fabric, NeoForge | **Mods** tab, Modrinth |

`spawnloft upgrade` moves Paper, Purpur, Folia and Advanced Slime Paper servers to their newest build. Other software changes version by creating a new instance or importing a newer jar.

## Architecture

A Minecraft server is an interactive foreground process. Launched from a short-lived shell call it blocks, its stdin is unreachable, and its console output is lost. SpawnLoft puts a supervisor in front of each server.

```
spawnloft / mcctl (short-lived CLI)
   │
   ├─ spawns detached ──▶ src/daemon.mjs (one per instance)
   │                        ├─ owns the java child process
   │                        ├─ mirrors stdout/stderr ──▶ run/<name>/console.log
   │                        ├─ samples CPU and RSS every 10 s ──▶ run/<name>/metrics.log
   │                        └─ listens on a control channel: ping | send | stop | kill
   │
   ├─ reads run/<name>/state.json   (pids, ports, start time)
   ├─ reads run/<name>/console.log  (logs, ready detection, follow)
   └─ connects to RCON on 127.0.0.1 (cmd, players, save flush)
```

| Platform | Control channel |
| --- | --- |
| Windows | Named pipe `\\.\pipe\mcctl-<name>` |
| macOS, Linux | Unix socket `run/<name>/control.sock`. When that path exceeds the socket limit (103 bytes on macOS, 107 on Linux), a socket under `/tmp/spawnloft-<uid>/` named by a hash of the path is used; the directory must be private to the user. |

### Lifecycle and state

| Status | Meaning |
| --- | --- |
| `running` | Daemon and java process are alive. |
| `stopping` | A graceful stop is in progress. |
| `stopped` | No daemon, no state. |
| `stale` | State file references dead pids. Cleared automatically or by `spawnloft doctor`. |
| `orphaned` | A java process outlived its daemon. `spawnloft kill <name>` cleans it up. |

State is reconciled against live pids on every read. A server is ready when its console prints `Done (<seconds>s)!`. `start` also stops waiting early on known failure shapes (`Failed to start the minecraft server`, `A fatal error has occurred`, heap reservation failures, `Unable to access jarfile`), prints the last 25 console lines, and exits non-zero.

### Crash recovery

The daemon owns crash recovery because it is the only process alive when a server dies.

| Setting | Behavior |
| --- | --- |
| `auto-restart=on` | A crash relaunches the server in place after 10 seconds. |
| Crash-loop limit | Three crashes within ten minutes: the server stays down and records why. |
| Requested stops | Always stick, including `stop` typed into the console (recognised by its clean exit). |
| `webhook=<url>` | Per-instance Discord webhook for crashed, recovered, gave-up, and failed scheduled-task events. Routine lifecycle events are not sent. |
| Restart warnings | A scheduled restart with `warnMinutes` announces the countdown over the console at the full figure, at one minute, and at ten seconds. |

### Configuration authority

`instances.json` is the source of truth for ports and RCON. `start` writes those values into `server.properties` before every launch, so a hand edit cannot desynchronise an instance from the registry. `--no-sync` leaves the file untouched. Default ports allocate from `25565` (game) and `25575` (RCON) upward, skipping ports claimed in the registry or in use on the machine.

JVM flags default to Aikar's G1 tuning, switching to the large-heap variant at 12 GB and above. Override per instance with a `jvmFlags` array in `instances.json`. `start` truncates `run/<name>/console.log` each launch; the server's own `logs/` directory keeps the rolling history.

### Data layout

| Item | Location |
| --- | --- |
| Settings file | Windows `%APPDATA%\mcctl\settings.json`; elsewhere `$XDG_CONFIG_HOME/mcctl/settings.json`, default `~/.config/mcctl/settings.json` |
| Default data root | Windows `%LOCALAPPDATA%\mcctl`; elsewhere `$XDG_DATA_HOME/mcctl`, default `~/.local/share/mcctl` |
| Legacy data root | The checkout itself, when it already contains `instances.json` |
| Override | `MCCTL_DATA_ROOT` environment variable, which wins over everything and is inherited by daemons |

| Path under the data root | Contents |
| --- | --- |
| `instances.json` | Registry: ports, memory, RCON credentials, loader, options |
| `instances/` | Servers SpawnLoft created. Adopted servers stay where they were. |
| `templates/` | Saved plugin and config sets |
| `jars/` | Server jar store, plus `jars/buildtools/` |
| `backups/` | Snapshots and manifests (relocatable with `config`) |
| `run/<name>/` | `state.json`, `console.log`, `daemon.log`, `metrics.log`, task run logs |
| `run/panel.log` | Records every panel event-loop stall longer than 250 ms |
| `run/mclogs.json` | mclo.gs delete tokens |
| `engines/` | Database engine binaries, shared by version |
| `services/<name>/` | Data for each managed database |

`spawnloft config` shows the resolved layout and moves it: `set-root <path>` (new servers only), `set-instances <path>`, `same-drive`, and `set-backup-mirror <path>|off`. Moving a location never moves existing data.

## Backups

Snapshots are tar archives with a manifest in `backups/<name>/`.

| Scope | Contents |
| --- | --- |
| `plugins` | `plugins/` and `mods/` |
| `worlds` | The active world set (only the active world is ever included) |
| `config` | Root configuration files and `config/` |
| `standard` (default) | Plugins, active worlds and config |
| `full` | Everything except `cache/`, `libraries/`, `versions/` and `logs/` |

| Behavior | Detail |
| --- | --- |
| Hot snapshots | A running server receives `save-off` and `save-all flush` over RCON first and `save-on` afterwards. This is inside the snapshot routine, so the CLI, the panel, scheduled backups, pre-upgrade snapshots and MCP all get it. If the flush fails, the snapshot is still taken and the manifest records that. |
| Databases | Snapshots of `standard` and `full` scope include a `databases/` dump of an attached database. Restore imports it back; the database must be running. |
| Restore | Refuses without `--yes` and while the server runs. Extracts in place and deletes nothing: files added after the snapshot survive. |
| Verify | Reads the archive end to end (every gzip block is decompressed) and compares entries to the manifest. Exits non-zero on any failure. |
| Retention | `--keep <n>` prunes only snapshots produced by the same schedule, never manual ones or pre-reset ones. |
| Mirror | `config set-backup-mirror <path>` copies every new snapshot to a second location; deletions follow. |
| tar warnings | `tar` exits 1 when it skips a file the running server holds locked. That is expected on hot snapshots and is not treated as failure. |

## Scheduled tasks

| Action | Behavior | Skipped when |
| --- | --- | --- |
| `backup` | Snapshot, optional `keep` (1 to 365) | |
| `verify` | Reads every snapshot back | |
| `command` | Sends `--line "<command>"` | Server is down |
| `restart` | Optional `warnMinutes` (1 to 60) | |
| `stop` | Graceful stop | Server is down |
| `start` | Launches the server | |

| Trigger | Flag |
| --- | --- |
| Daily | `--daily 03:00` |
| Weekly | `--weekly SUN --at 03:00` |
| Every n hours | `--hourly <n>` |
| Every n minutes | `--minutes <n>` |
| At sign-in | `--on-logon` |

| Platform | Scheduler | Notes |
| --- | --- | --- |
| Windows | Task Scheduler | Interactive only: runs while you are signed in, screen locked included, never after sign-out. Running regardless would need a stored Windows password. |
| macOS | Per-user launchd agents | Daily and weekly jobs missed during sleep run once on wake; interval jobs skip missed runs; login tasks also run when registered or enabled. Interval next-run times are not supplied by launchd. Remove tasks before deleting the app. |
| Linux | systemd user timers | Requires lingering to run after logout. |

The operating system holds only a trigger that invokes the bundled CLI (`task run <id>`). Task definitions live in SpawnLoft's data folder, and an unrecognised action is refused rather than executed. Every run appends a line to the instance's run directory describing what it did; Task Scheduler alone records only an exit code. Outcomes are success, failure, or skipped. Renaming a server moves its tasks; deleting it removes them.

## Databases

MySQL 8.4 LTS and Redis-compatible Garnet run as registry entries beside servers, under the same daemon: a lamp, a console, start, stop, restart and crash recovery. Every database listens on `127.0.0.1` only, and is stopped through `mysqladmin` over TCP because databases take no console input.

```sh
spawnloft db versions                         # verified releases
spawnloft db add sql                          # download MySQL once, set up a database on a free port
spawnloft start sql
spawnloft db attach sql survival              # database and scoped user for that server; prints credentials
spawnloft db create survival                  # all of the above: survival-db on the next port, started, attached
spawnloft db creds sql survival               # show credentials again
spawnloft db detach sql survival --drop       # remove the user and the data
spawnloft db add cache --engine garnet        # Redis-compatible server
spawnloft db connect xampp --port 3306 --user root --password ''   # register an existing database
```

| Fact | Detail |
| --- | --- |
| Source | Oracle CDN, pinned native archive, SHA-256 verified, unpacked with the system `tar` into `engines/` |
| Isolation | The user given to a server reaches its one database and nothing else |
| Snapshots | A server snapshot carries a dump of its attached database; a MySQL database also has its own **Backups** tool with plain SQL dumps that can be downloaded, restored (saving a dump of the current state first) or deleted |
| Redis | Garnet keeps its own checkpoints and has no dump; stop saves a checkpoint and a failed save leaves it running with an error |
| Existing databases | Registered with `db connect`; attached the same way; never started or stopped by SpawnLoft |
| MariaDB | Removed from new setups |
| Plugin configuration | Never written. Copy credentials from `db creds` or **Show credentials** into plugin configs yourself. |

## Control panel

```sh
spawnloft ui [--port 8770] [--no-open]
```

One HTML file (`src/ui.html`) served by Node's `http` module. No framework, no build step, no npm packages, and no network fetches. The same page runs in a browser tab and inside the desktop app; `window.mcctlDesktop` exists only in Electron and gates additive features (a **Browse** button beside path fields, moving the data folder, update checks).

Servers are tabs across the top. A server's tools open from a dock beside its console rather than replacing it; **Settings** and **Backups** open full width with the console's newest line and error count along the bottom. The first tab is an overview of every server.

| Area | Function |
| --- | --- |
| **Overview** | State, players, TPS, memory and last backup per server, with **Start** and **Stop** on each card, and the machine's memory budget across servers. A **Needs attention** row flags crashes (including crash-guard restarts today), plugin updates found by the last check, servers never backed up or not backed up in a week, and a Java too old to start a server, each with one button that resolves it. |
| **Console** | Search, filter to warnings or errors, pause, copy, wrap, line numbers, bounded scrollback. ANSI escapes are stripped. Log level appears as a coloured gutter rail; a stack trace inherits the level of the line above so the error filter shows whole failures. **Export** saves a `.log` beside the snapshots or uploads to mclo.gs. |
| **Plugins** / **Mods** | Search Modrinth and Hangar together, each result naming its source, with checksum-verified downloads, an update check, and update-all behind one plugins snapshot and a restart. Lists everything in the folder, including hand-added jars, but manages only what SpawnLoft installed (provenance is recorded beside the jars); custom and premium plugins are never offered updates and never have their hash sent anywhere. Enable and disable rename the jar in place. Hangar projects hosting downloads elsewhere are linked, not installed. |
| **Worlds** | List worlds with the active one named, import a map from a zip or folder (found however deeply nested, never overwriting), export as zip, switch the active world, delete. |
| **Backups** | Take a snapshot at a chosen scope; list with size, age and coverage; restore, verify or delete; schedule automatic backups with retention. Refreshes every four seconds while visible. |
| **Players** | Everyone the server knows, merged from operators, bans, whitelist, name cache and world data. Connected players are marked and sorted first. Op, ban, or delete world data; through the console while running, through files when stopped. |
| **Stats** | CPU and memory over 1 minute, 5 minutes, 30 minutes, 1 hour or 4 hours, sampled every 10 seconds, with both axes following the data. |
| **Schedule** | Create, edit, enable, disable, run now and remove tasks. |
| **Settings** | One form of sections with a dot on any section holding unsaved changes. Each setting reads **Default** until the file has it and **Changed** until saved. A bottom bar saves, discards, or saves and restarts. Memory and Java are set here; `server.properties` can be edited as a whole file (RCON password hidden, managed ports uneditable, file snapshotted first). **Server software** shows the running build and offers the newest, or a newer Minecraft version. **Databases** shows credentials and **Create a database**. |
| Preferences (gear) | Appearance (**Classic** and **SpawnLoft** themes), data locations, updates (**Get beta builds**), **AI assistants** configuration, **Copy diagnostics**, **Feedback**. |

Quick-form `server.properties` fields:

| Key | Label | Type | Range or values | Default shown |
| --- | --- | --- | --- | --- |
| `online-mode` | Who can join | Toggle | Mojang accounts (`true`) or any name (`false`) | `true` |
| `motd` | Message of the day | Text | | `A Minecraft Server` |
| `difficulty` | Difficulty | Choice | `peaceful`, `easy`, `normal`, `hard` | `easy` |
| `gamemode` | Default game mode | Choice | `survival`, `creative`, `adventure`, `spectator` | `survival` |
| `max-players` | Max players | Integer | 1 to 1000 | `20` |
| `pvp` | PvP | Toggle | | `true` |
| `white-list` | Whitelist | Toggle | | `false` |
| `view-distance` | View distance | Integer | 2 to 32 | `10` |
| `spawn-protection` | Spawn protection | Integer | 0 to 256 | `16` |

New instances are generated with `online-mode=true`, `motd=<name> (SpawnLoft)`, `max-players=10`, and `spawn-protection=0`. Writes preserve comments and key order.

Changing `online-mode` on a world with existing players shows a warning first. Minecraft derives an offline UUID from the player name and uses the Mojang UUID otherwise, so switching hands every player a different identity and orphans permissions, homes and inventories keyed by UUID. The panel reads player data, distinguishes the two UUID kinds by version, and reports how many players are affected.

Renaming, resetting and deleting a server require typing its name.

### Feedback and diagnostics

| Feature | Behavior |
| --- | --- |
| **Something broke** | Opens a GitHub bug report with version, Java, server status and panel log pre-filled and copies the full diagnostics to the clipboard. |
| **A question** | Opens a new post in [Q&A](https://github.com/joogiebear/spawnloft/discussions/categories/q-a). |
| **An idea** | Opens a new post in [Ideas](https://github.com/joogiebear/spawnloft/discussions/categories/ideas). |
| **Copy diagnostics** | Version, Java, locations, every server's status, `run/panel.log`, and the last console lines of the selected server. Never includes an RCON password or webhook URL. |
| Crash notice **Report** link | Same as **Something broke**, named for the crash. |

Nothing is sent by SpawnLoft; the browser hop is the consent.

## Security posture

SpawnLoft is built for localhost and LAN use.

| Area | Behavior |
| --- | --- |
| RCON | Binds to `server-ip`; empty means all interfaces (LAN), `127.0.0.1` keeps it local. RCON has no rate limiting or encryption and must never face the internet. `spawnloft doctor` and the panel warn when a machine has a public address and no active firewall. Minecraft cannot bind RCON separately from the game port. |
| Secrets at rest | `instances.json` stores RCON passwords in plaintext. It is gitignored, as are `backups/`, `jars/`, `instances/` and `run/`. The panel never receives an RCON password; every route that returns an instance strips it. |
| Online mode | New instances default to `online-mode=true`. Offline mode gives name-derived UUIDs, so UUID-keyed plugin behavior differs from a real server, and Paper prints a four-line `OFFLINE/INSECURE` banner that plugin authors commonly refuse reports for. Offline remains available: `spawnloft new <name> --offline`, `spawnloft props <name> online-mode=false`, or the panel's **Settings**. The panel badges servers running that way. |
| Network | Nothing opens firewall ports or touches the router. Exposing a server is a separate, deliberate decision. |
| Panel binding | Fixed to `127.0.0.1`. There is no `--host` flag, on purpose: the panel has no login. To manage a server elsewhere, remote into the machine. |
| Panel request checks | Every request needs a loopback `Host` header (defeats DNS rebinding). An `Origin`, when present, must equal the panel's own `Host` including port (dynmap, BlueMap and Plan serve pages on other loopback ports). Requests without `Origin` (the panel itself, curl, the CLI) are allowed. |
| Scheduled tasks | An allowlist of actions (`backup`, `verify`, `command`, `restart`, `stop`, `start`), not command strings. Tasks run as the signed-in user with no stored password and no elevation. |
| Outbound data | Only on a click: **Feedback** (browser opens GitHub) and **Console → Export → Upload to mclo.gs**. Before an upload SpawnLoft replaces your account name in file paths; mclo.gs removes IP addresses on its side (best effort) and deletes the log 90 days after last open; player names and plugin output are sent as is. The delete token is kept in `run/mclogs.json`. Everything else stays on the machine. |
| AI assistants | See [MCP.md](MCP.md). |

## Desktop app

The desktop app is a window around the same panel, plus a native folder picker and first-run setup. The core runs inside the Electron process, so there is no second Node and no orphaned child if the window dies. Closing the window does not stop servers; they are detached daemons.

```sh
cd desktop
npm install
npm start                    # bundled core
npm start -- --core ..       # develop against this checkout (or set MCCTL_CORE)
npm test                     # window-state and update-channel tests
npm run pack                 # build; afterPack fails the build if the result is wrong
npm run verify               # re-check an existing build
```

| Topic | Behavior |
| --- | --- |
| Terminal launchers | `resources/bin/spawnloft` and `mcctl` (`.cmd` on Windows) use the bundled runtime. See [CLI.md](CLI.md). |
| Update checks | 20 seconds after start and every 6 hours while open. Newer builds download in the background as changed blocks; the header button reads **Restart to update**. Windows installs with `/S` per user, with no wizard or elevation prompt. Closing with a download waiting applies it on exit. Failed background checks are silent; a check you press answers either way. Refused outside a packaged build. |
| Channels | Stable installs follow stable releases. Turn on **Settings > Updates > Get beta builds** to follow betas. Turning it off never downgrades. |
| Uninstall | Removes the program and asks once whether to delete servers, worlds, backups, jars and settings (default no). Always first stops every server and removes every scheduled task. Deleting data removes only what SpawnLoft created: adopted servers stay, and a data folder shared with other files loses only SpawnLoft's own folders. Terminal equivalent: `spawnloft uninstall --yes [--data]`. |
| Signing | Windows: Azure Artifact Signing, timestamped. SmartScreen reputation accrues per publisher through installs, so **More info → Run anyway** may still be needed on new builds. Mac: Developer ID with notarization ([desktop/MAC-SIGNING.md](desktop/MAC-SIGNING.md)). Linux packages are verified by the hash in the update feed. |
| Build provenance | Every release names its source commit; **Settings → About** shows it. |

Release engineering is documented in [CONTRIBUTING.md](CONTRIBUTING.md#releases).

## Site

The project site and documentation live in [joogiebear/mcctl-site](https://github.com/joogiebear/mcctl-site), a VitePress site deployed by Vercel to [spawnloft.com](https://spawnloft.com). Partner banner artwork is under `public/banner/` in that repository.

## License

[MIT](LICENSE).
