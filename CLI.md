# SpawnLoft Command Line

`spawnloft` is the preferred command. `mcctl` runs the same implementation and remains supported for existing scripts, scheduled tasks and shortcuts. Both names accept identical arguments; the JSON `command` field always uses the canonical name.

## Installation and invocation

| Install | Command | Runtime |
| --- | --- | --- |
| Windows desktop | `resources\bin\spawnloft.cmd` inside the SpawnLoft install directory (default `%LOCALAPPDATA%\Programs\SpawnLoft`), or add `resources\bin` to your user `PATH` | Bundled |
| macOS desktop | `/Applications/SpawnLoft.app/Contents/Resources/bin/spawnloft` | Bundled |
| Linux desktop `.deb` / `.rpm` | `spawnloft` on `PATH` | Bundled |
| Linux `spawnloft-cli` `.deb` / `.rpm` | `spawnloft` on `PATH` | Bundled Node, no graphical dependencies |
| Source checkout | `node spawnloft.mjs <command>`, `./spawnloft` (Linux, macOS), `spawnloft.cmd` (Windows) | Node 20 or later |

macOS `PATH` for the current terminal session:

```sh
export PATH="/Applications/SpawnLoft.app/Contents/Resources/bin:$PATH"
spawnloft status royalplugins --json
```

Add the `export` line to your shell configuration to make it permanent. The app does not edit shell configuration; update the entry if you move the app. Do not symlink the launcher alone: it resolves its runtime relative to its own directory.

Run `spawnloft help` for usage. Unknown commands exit `2`.

## Command reference

Command names accept aliases where listed. `<name>` is an instance name: 32 characters or fewer, and shared by servers and databases.

### Lifecycle

| Command | Description |
| --- | --- |
| `list` (`ls`) | Every server and database with status, ports, memory and uptime. |
| `status [<name>]` | Detail for one instance, including pids and `level-name`. Without a name, returns the same inventory as `list`. |
| `start <name>` | Launch and block until the server reports ready. |
| `stop <name>` | Graceful shutdown: writes `stop` to the console. |
| `restart <name>` | Stop, then start. |
| `kill <name>` | Force-kill the process tree. Also clears an `orphaned` instance. |

| Flag | Applies to | Default | Effect |
| --- | --- | --- | --- |
| `--detach` | `start` | | Return as soon as the process launches. |
| `--timeout <sec>` | `start` | `180` | Ready timeout. On timeout the server may still be loading. |
| `--timeout <sec>` | `stop`, `restart` | `90` | Graceful stop timeout. |
| `--no-sync` | `start` | | Do not write registry ports and RCON settings into `server.properties`. |
| `--force` | `start`, `new` | | Proceed even when no installed Java can run the server's Minecraft version. |

`start`, `stop`, `restart`, `logs` and `status` accept a database's name.

A failed `start` prints the last 25 console lines, the likely cause from log diagnostics, and exits `1`.

### Console

| Command | Description |
| --- | --- |
| `logs <name> [-n 60] [-f] [--grep <regex>]` (`log`) | Read the captured console. `-n` sets the number of lines, `-f` follows, `--grep` filters. |
| `cmd <name> "<command>"` (`rcon`) | Run a command over RCON and print the reply. |
| `send <name> "<line>"` | Write a raw line to the server's stdin. No reply. Use for anything RCON refuses to carry. |
| `console <name>` (`attach`) | Interactive attach. `/detach` leaves the server running. |
| `players <name>` | Who is online. |
| `why <name>` (`diagnostics`) | Explain what is wrong with a server from its own console: known failure causes with fixes, and crash report summaries. |

### Instances

| Command | Description |
| --- | --- |
| `adopt <name> <dir>` | Register an existing server directory in place. Nothing moves; ports and RCON password are read from its `server.properties`. Flags: `--jar <file>`, `--memory <4G>`. |
| `new <name> [options]` | Create an instance. See [Creating servers](#creating-servers). |
| `clone <src> <new>` | Copy plugins and configuration into a new instance on a free port with fresh worlds. `--with-worlds` also copies world data. |
| `set <name> key=value...` | Change instance settings. See [Instance settings](#instance-settings). |
| `props <name> [key=value...]` | Read or edit `server.properties`. Comments and key order are preserved. |
| `plugins <name> [enable\|disable <plugin>]` | Inventory of plugins or mods, or flip one by renaming its jar in place. |
| `worlds <name> [...]` | See [Worlds](#worlds). |
| `upgrade <name> [--check]` | Move to the newest build for the server's Minecraft version. |
| `pack <name> [update --yes]` | For a modpack server: show, check, or update its pack. |
| `rename <old> <new>` | Rename an instance and its folder. Tasks move with it. |
| `rebuild <name> --yes` | Reset worlds; keeps plugins unless `--wipe-plugins`. A snapshot is taken first unless `--no-snapshot`. |
| `rm <name> [--purge --yes]` (`remove`) | Unregister. `--purge --yes` also deletes the files. |
| `reveal <name>` (`open`) | Open the instance folder in the file manager. |
| `launchers [<name>]` | Write `start`, `console` and `stop` `.bat` files into instance folders. |
| `templates` / `templates save <inst> <tpl>` (`template`) | List, or save an instance's plugins and config as a reusable template. |
| `jars` / `jars import <path> [--as <name>]` | List the jar store used by `new`, or add a jar to it. |
| `paper versions [--unstable] [--limit <n>]` | Paper versions available to download. |
| `paper builds <version> [--limit <n>]` | Builds of one version. |
| `paper fetch <version> [build] [--force]` | Download a Paper build into the jar store. |

#### Creating servers

| Flag | Effect |
| --- | --- |
| `--paper <v>`, `--purpur <v>`, `--folia <v>`, `--asp <v>` | Download that software and version. |
| `--vanilla <v>` | Mojang server jar (no plugins, no mods). |
| `--spigot <v>`, `--craftbukkit <v>` | Compile with BuildTools. Needs a JDK, roughly ten minutes first time. |
| `--fabric <v>`, `--neoforge <v>` | Download or install that loader for the Minecraft version. |
| `--modpack <slug>` | Build the whole server from a Modrinth modpack. |
| `--jar <file>` | Use a jar from the `jars/` store. |
| `--template <name>` | Start from a saved template. |
| `--build <n>` | A specific build for sources that number them (Paper, Folia, Purpur). |
| `--memory <4G>` | Heap size. `4G` or `6144M` form. |
| `--port <n>` | Game port. Default: first free port from `25565`; RCON from `25575`. |
| `--accept-eula` | Write `eula=true`, accepting [Mojang's EULA](https://aka.ms/MinecraftEULA). |
| `--offline` | Set `online-mode=false`: anyone can join under any name. Every log gets an `OFFLINE/INSECURE` banner. |
| `--force` | Proceed when the Java check would refuse. |

Java is chosen at creation as the newest installed Java that fits the Minecraft version (17 for 1.18 to 1.20.4, 21 for 1.20.5 to 1.21.x, 25 for 26.x).

#### Instance settings

`spawnloft set <name> key=value` accepts these keys.

| Key | Value | Effect |
| --- | --- | --- |
| `label` | text | Display name. |
| `memory` | `4G`, `6144M` | JVM heap. |
| `java` | path | Java executable for this server. |
| `jar` | file name | Server jar inside the instance folder. |
| `port` | 1 to 65535 | Game port. Refused when another instance holds it. |
| `rcon.port` | 1 to 65535 | RCON port. Refused when another instance holds it. |
| `rcon.password` | text | RCON password. |
| `auto-restart` | `on`, `off` | Relaunch after a crash. Three crashes in ten minutes stops it. |
| `webhook` | URL, `off` | Discord webhook for crash, recovery, give-up and failed-task events. |

Ports and RCON settings are written into `server.properties` at every start unless `--no-sync` is given. A per-instance `jvmFlags` array in `instances.json` overrides the default Aikar G1 flags, which switch to a large-heap variant at 12 GB and above.

#### Upgrading

| Command | Effect |
| --- | --- |
| `upgrade <name> --check` | Report the newest build for the current version and newer Minecraft versions. |
| `upgrade <name>` | Install the newest build of the same version. The old jar is kept as the way back. |
| `upgrade <name> --version <v> --yes` | Cross Minecraft versions. A snapshot is taken first; worlds migrate one way. |
| `--build <n>` | Choose a specific build. |

Supported on Paper, Purpur, Folia and Advanced Slime Paper (Advanced Slime Paper builds have no number and compare by date). Other software changes version by creating a new instance or importing a newer jar.

#### Worlds

| Command | Effect |
| --- | --- |
| `worlds <name>` | List worlds, marking the active one. |
| `worlds <name> use <world>` | Switch which world runs. |
| `worlds <name> import <zip-or-folder> --as <name>` | Import a map, found however deeply nested; never overwrites. |
| `worlds <name> export [world]` | Export as a zip. |
| `worlds <name> delete <world> --yes` | Delete a world. |

Only the active world is included in snapshots.

### Snapshots

| Command | Description |
| --- | --- |
| `backup <name>` (`snapshot`) | Take a snapshot into `backups/<name>/`. |
| `backups <name>` (`snapshots`) | List snapshots. |
| `restore <name> [ref] --yes` | Restore (default `latest`). The server must be stopped. Extracts in place and deletes nothing. |
| `prune <name> --keep <n>` | Delete all but the newest `n` (default 10). |
| `verify <name> [ref\|--all]` | Read snapshots end to end and compare with their manifests. Non-zero exit on any failure. |

| `backup` flag | Effect |
| --- | --- |
| `--scope <scope>` | One of the scopes below. Default `standard`. |
| `--label <text>` | Label recorded in the snapshot name. |
| `--keep <n>` | Prune to the newest `n` after taking the snapshot. |

| Scope | Contents |
| --- | --- |
| `plugins` | `plugins/` and `mods/` |
| `worlds` | The active world set |
| `config` | Root configuration files (`server.properties`, `bukkit.yml`, `spigot.yml`, `paper*.yml`, `permissions.yml`, and similar) and `config/` |
| `standard` | Plugins, active worlds and config |
| `full` | Everything except `cache/`, `libraries/`, `versions/`, `logs/` |

A running server is flushed with `save-off` and `save-all flush` before, and `save-on` after, every snapshot from any path (CLI, panel, task, pre-upgrade, MCP). If the flush fails the snapshot is still taken and its manifest says so. `standard` and `full` snapshots include a `databases/` dump of any attached database; restore imports it back into a running database.

### Scheduled tasks

| Command | Description |
| --- | --- |
| `task list` | Every task with next run and last result. |
| `task add <server> --do <action> [when]` | Create a task. |
| `task run <id>` | Run now. The system scheduler calls this. |
| `task rm <id>` | Remove. |
| `task enable <id>` / `task disable <id>` | Resume or pause. |
| `task linger [on]` | Linux: report, or turn on, whether tasks run while logged out. |

| `--do` action | Extra flag | Notes |
| --- | --- | --- |
| `backup` | | Retention applies only to snapshots the same task produced. |
| `verify` | | Reads back every snapshot; failures reach the webhook. |
| `command` | `--line "<command>"` | Skipped, not failed, when the server is down. |
| `restart` | | The panel's task form adds `warnMinutes` (1 to 60): countdown announced at the full figure, one minute and ten seconds. |
| `stop` | | Skipped when the server is down. |
| `start` | | |

| When | Flag |
| --- | --- |
| Daily | `--daily 03:00` |
| Weekly | `--weekly SUN --at 03:00` |
| Every n hours | `--hourly <n>` |
| Every n minutes | `--minutes <n>` |
| At sign-in | `--on-logon` |

`--name <text>` sets the task's display name. Tasks run through Windows Task Scheduler, per-user macOS launchd agents, or Linux systemd user timers, and only while you are signed in. See the [README](README.md#scheduled-tasks) for platform behavior.

### Databases

| Command | Description |
| --- | --- |
| `db` | List databases. |
| `db versions [--engine <e>]` | Verified releases. Engines: `mysql` (default), `garnet` (Redis-compatible). |
| `db add <name> [--version <v>] [--engine <e>] [--port <n>]` | Download the engine once and set up a database on a free port. |
| `db connect <name> --host <h> --port <n> --user <u> --password <p>` | Register a database you already run. Never started or stopped by SpawnLoft. |
| `db create <server>` | Create a database on the port after the server's game port, start it and attach it. |
| `db attach <db> <server>` | Create a database and scoped user for a server and print the credentials. |
| `db detach <db> <server> [--drop]` | Remove the user; `--drop` also deletes the data. |
| `db creds <db> <server>` | Show credentials again. |
| `db remove <db> [--purge]` (`rm`) | Forget a stopped database; `--purge` deletes its files. |

Plugin configuration files are never written; copy credentials into them yourself.

### Environment and layout

| Command | Description |
| --- | --- |
| `doctor` | Check Java, `tar`, each server's folder, jar, EULA, port collisions, RCON exposure, orphaned processes, stale state and disk use. Clears stale state files. Exits `1` when it finds problems. |
| `config` | Show the resolved data layout. |
| `config set-root <path>` | Move the data root (new servers only). |
| `config set-instances <path>` | Put servers on a different drive. |
| `config same-drive` | Create servers under the data root again. |
| `config set-backup-mirror <path>\|off` | Copy every new snapshot to a second location; deletions follow. |
| `ui [--port <n>] [--no-open]` (`panel`) | Serve the control panel on `127.0.0.1` (default port `8770`). |
| `mcp [--allow-destructive] [--show-ips]` | MCP server on stdio. See [MCP.md](MCP.md). |
| `uninstall --yes [--data]` | Stop every server and remove every scheduled task; `--data` also deletes what SpawnLoft created. |
| `help` | Print usage. |

Moving a location never moves existing data. Environment variables: `MCCTL_DATA_ROOT` overrides the data root for the process and its daemons; `MCCTL_RESTART_DELAY_MS` overrides the 10-second crash restart delay (used by tests); `JAVA_HOME` is consulted for Java discovery.

## JSON output contract, version 1

```sh
spawnloft list --json
spawnloft status royalplugins --json
spawnloft plugins royalplugins --json
spawnloft backups royalplugins --json
spawnloft diagnostics royalplugins --json
spawnloft doctor --json
spawnloft backup royalplugins --scope plugins --json
spawnloft metrics royalplugins --json
```

Each command writes one JSON object and a newline to stdout, with no progress messages, tables, ANSI colors or stack traces mixed in.

```json
{"schemaVersion":1,"command":"status","ok":true,"data":{"name":"royalplugins","status":"stopped"}}
```

Failure:

```json
{"schemaVersion":1,"command":"status","ok":false,"type":"error","error":{"code":"COMMAND_FAILED","message":"no instance named missing"}}
```

Check `schemaVersion`, accept additional fields, and branch on `error.code` and the exit code.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Contract version, currently `1`. |
| `command` | Canonical command name. |
| `ok` | Whether the operation succeeded. |
| `data` | Result payload when `ok` is `true`. |
| `type` | `error` on failure. |
| `error.code` | `COMMAND_FAILED`, `INVALID_USAGE`, `CHECK_FAILED`, or a command-specific code. |
| `error.message` | Human-readable reason. |

| Exit code | Meaning |
| --- | --- |
| `0` | Completed. A stopped server or empty inventory is valid data. |
| `1` | Operation failed, or `doctor` found environment problems (`CHECK_FAILED`). |
| `2` | Invalid usage or unsupported JSON operation (`INVALID_USAGE`). No action ran. |
| `130` | A metrics follower was interrupted with Ctrl+C. |
| `143` | A metrics follower received SIGTERM. |

Structured commands and metrics use these codes. Other commands retain their existing exit behavior.

| Command | JSON behavior |
| --- | --- |
| `list` | Aliases: `ls`. |
| `status` | Without a name, equals `list`. Excludes RCON and database passwords, webhook URLs and JVM arguments. |
| `plugins` | Inventory only. `plugins ... enable\|disable --json` is rejected before any jar changes. |
| `backups` | Aliases: `snapshots`. |
| `diagnostics` | Aliases: `why`. Contains matching console lines and crash-report summaries; review before sharing. A historical finding is not a failed command or a plugin-health verdict. |
| `doctor` | Read-only. Returns `ok:false` with findings when checks fail. Plain-text `doctor` additionally repairs stale state. |
| `backup` | Aliases: `snapshot`. Reports warnings, skipped database dumps, mirror errors and pruning results. Exit `0` means the archive was created, not that every optional step succeeded; read those fields before treating an automated backup as fully successful. |
| `metrics` | See below. |

Any other command with `--json` exits `2` before taking action. `--json` takes no value.

## Performance readings and export

```sh
spawnloft metrics royalplugins --json
spawnloft metrics royalplugins --seconds 1800 --json
spawnloft metrics royalplugins --follow --json
spawnloft metrics royalplugins --csv --output royalplugins-run.csv
spawnloft metrics royalplugins --follow --csv
```

| Flag | Effect |
| --- | --- |
| `--json` | One snapshot envelope (with `--follow`, JSON Lines). |
| `--csv` | CSV output. Mutually exclusive with `--json`; supported only for `metrics`. |
| `--seconds <n>` | Limit the initial history window. Default: all retained history for the current or last run. |
| `--follow` | Stream new readings until interrupted. |
| `--output <file>` | Write a finite CSV snapshot to a new file. Never overwrites. Without it, CSV goes to stdout. |

Readings are the same ten-second samples the panel's **Stats** tool uses, kept in `run/<name>/metrics.log` (up to 1,800 samples, five hours). CPU is a percentage of the whole machine; `rssMiB` is resident process memory in MiB, including memory outside the Java heap. An empty `samples` array is valid before the first measurement or outside the selected range. Collection runs on Windows, macOS and Linux; export reads saved history anywhere.

`--follow --json` writes JSON Lines:

| Envelope | When |
| --- | --- |
| `snapshot` | First line: history and metadata. |
| `sample` | Each new reading. Unchanged samples are not repeated. |
| `reset` | The server restarted or the clock rolled back. Use `runId` to keep runs apart. |
| error envelope | A runtime failure; exit `1`. |

The follower stays open while a server is stopped and follows its next start. It checks the file once per second. Closing the output pipe ends it cleanly.

CSV columns: `instance,run_id,timestamp,cpu_percent,rss_mib,cores`, with UTC ISO timestamps. Redirect stdout yourself to capture an ongoing CSV stream.

## AI assistants

`spawnloft mcp` is a Model Context Protocol server on stdio, launched by the AI app. It is outside the JSON contract above and writes only protocol messages to stdout. See [MCP.md](MCP.md).

## Platform notes

### Scheduled tasks on macOS

`spawnloft task add royalplugins --do backup --daily 03:00` creates a per-user launchd agent. The desktop **Schedule** and **Backups** tools use the same backend, including retention scoped to each task. Tasks run with the app closed while you are signed in. Daily and weekly jobs missed during sleep run once on wake; interval jobs skip missed runs; nothing runs after sign-out; login jobs also run when registered or enabled. Keep SpawnLoft background activity enabled in macOS Login Items, and remove tasks before deleting the app.

### Managed databases on macOS

On macOS 15 or later, `spawnloft db create royalplugins` downloads the verified MySQL 8.4 LTS engine for your Mac, creates and starts a database, and prints the server's credentials. `spawnloft db add testdb`, `spawnloft start testdb` and `spawnloft db attach testdb royalplugins` do the same in steps; `spawnloft db creds testdb royalplugins` shows credentials again. Existing databases are never silently upgraded to another engine or version.
