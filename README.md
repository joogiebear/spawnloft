# SpawnLoft

Minecraft servers on your own PC, without the terminal. A local control plane for this machine:
multiple server instances with detached launch, captured console, RCON command/response, stdin
injection, and snapshot/restore. The site is [spawnloft.com](https://spawnloft.com).

SpawnLoft is the product: the desktop app, the panel, the installer. `mcctl` is the command-line
tool inside it, and the name of this repository, so commands, file names and links keep that name.

Zero dependencies — plain Node 20+ and the `tar` that ships with Windows.

## What you need

- **Java 25 or newer** for current Minecraft (26.x); 1.21.x runs on 21. This is the one thing
  SpawnLoft cannot supply: Minecraft servers *are* Java processes.
  [Temurin 25](https://adoptium.net/temurin/releases/?version=25) is a good default, and a JDK
  rather than a JRE if you want Spigot or CraftBukkit built here.
  The desktop app checks for it on first run and the panel says so in a banner if it is missing;
  `mcctl doctor` reports it from the command line. SpawnLoft looks for Java on PATH **and** in the
  usual install folders (Program Files, the per-user Programs folder, `JAVA_HOME`), so a Java that
  the installer did not add to PATH, or one added after SpawnLoft was already running, is still found
  and used. Each server can also be pointed at a specific Java with `mcctl set <name> java=<path>`.
  SpawnLoft knows which Java each Minecraft version needs (17 for 1.18 to 1.20.4, 21 for 1.20.5 and
  1.21, 25 for 26.x) and picks the newest installed Java that fits when a server is created; a
  version nothing installed can run is refused before the download, with the download link.
  `--force` on `new` and `start` goes ahead anyway.
- **Node 20+**, for the CLI. The desktop app carries its own runtime and does not need it.
- **Windows 10/11** for the desktop app. The CLI runs anywhere Node does.

## Why this exists

A Minecraft server is an interactive foreground process. Launched from a normal
shell call it blocks forever, its stdin is unreachable, and its console output is
lost. That makes the ordinary edit-restart-check loop painful to automate.

`mcctl` puts a supervisor in front of each server so short-lived commands can
start it, read what it printed, talk to it, and shut it down cleanly.

## Quickstart

```bash
node mcctl.mjs list
```

Register a server directory you already have, in place — nothing is moved or
rewritten, and its existing ports and RCON password are read from its own
`server.properties`:

```bash
node mcctl.mjs adopt survival "S:\Claude\minecraft\Server" --memory 6G
```

Start it and wait until Paper reports ready:

```bash
node mcctl.mjs start survival
```

Talk to it:

```bash
node mcctl.mjs cmd survival "tps"
```

Spin up a disposable copy of its plugins and config on its own port, with fresh
worlds, for reproducing a bug without touching the real server:

```bash
node mcctl.mjs clone survival ecotest && node mcctl.mjs start ecotest
```

On Windows `mcctl.cmd` wraps the above, so `mcctl list` works once this folder is
on your PATH.

## Commands

### Lifecycle

| Command | Does |
| --- | --- |
| `list` | Every instance with status, ports, memory, uptime |
| `status <name>` | Detail for one instance, including pids and level-name |
| `start <name>` | Launch and block until the server reports ready |
| `stop <name>` | Graceful shutdown by writing `stop` to the console |
| `restart <name>` | Stop, then start |
| `kill <name>` | Force-kill the process tree |

`start` flags: `--detach` (return as soon as the process launches),
`--timeout <sec>` (ready timeout, default 180), `--no-sync` (leave
`server.properties` alone instead of pushing registry ports into it).

If the server fails to reach ready, `start` prints the last 25 console lines and
exits non-zero, so a failed launch is self-diagnosing.

### Console

| Command | Does |
| --- | --- |
| `logs <name> [-n 60] [-f] [--grep re]` | Read the captured console; `-f` follows |
| `cmd <name> "<command>"` | Run over RCON and print the reply |
| `send <name> "<line>"` | Write a raw line to the server's stdin |
| `console <name>` | Interactive attach; `/detach` leaves the server running |
| `players <name>` | Who is online |

`cmd` goes over RCON and gets a reply back, which is what you want almost always.
`send` writes to stdin and gets no reply, which is what you want for anything
RCON refuses to carry.

### Instances

| Command | Does |
| --- | --- |
| `adopt <name> <dir>` | Register an existing server directory in place |
| `new <name>` | Create a fresh instance (`--paper <v>`, `--purpur <v>`, `--folia <v>`, `--asp <v>`, `--vanilla <v>`, `--spigot <v>`, `--craftbukkit <v>`, `--fabric <v>`, `--neoforge <v>`, `--modpack <slug>`, `--jar`, `--template`, `--accept-eula`) |
| `clone <src> <new>` | Copy plugins and config into a new instance on a free port |
| `set <name> key=value` | `label`, `memory`, `java`, `jar`, `port`, `rcon.port`, `rcon.password`, `auto-restart=on\|off`, `webhook=<url>\|off` |
| `props <name> [key=value]` | Read or edit `server.properties` |
| `plugins <name> [enable\|disable <x>]` | List a server's plugins, flip one on or off |
| `upgrade <name> [--check]` | Newest Paper build for its version; `--version <v> --yes` crosses Minecraft versions |
| `rm <name> [--purge --yes]` | Unregister, optionally deleting the files |

#### Server software

`new` fetches whichever server you name. Every one runs with a plain `-jar`, so
the daemon does not care which; what differs is where it comes from and what it
loads.

| Flag | What you get | Loads | From |
| --- | --- | --- | --- |
| `--paper <v>` | Paper, newest stable build | plugins | PaperMC, sha256-verified |
| `--purpur <v>` | Purpur, a Paper fork with more configuration | plugins | purpurmc.org, md5-verified |
| `--folia <v>` | Folia, Paper with regionised multithreading | Folia-built plugins only | PaperMC |
| `--asp <v>` | Advanced Slime Paper, Paper with Slime World Manager built in | plugins | InfernalSuite, sha256-verified |
| `--spigot <v>` | Spigot | plugins | **compiled here** by BuildTools |
| `--craftbukkit <v>` | CraftBukkit | plugins | **compiled here** by BuildTools |
| `--vanilla <v>` | Mojang's own server | nothing | Mojang, sha1-verified |
| `--fabric <v>` | Fabric launcher | mods | FabricMC |
| `--neoforge <v>` | NeoForge, via its installer | mods | NeoForged maven, sha256-verified |

`--build <n>` picks a specific build where the source numbers them (Paper,
Folia, Purpur). The panel's **Add a server** offers the same list.

SpigotMC publishes no jars, so Spigot and CraftBukkit are built on this machine
by BuildTools: it needs a **JDK** (javac, not just a runtime), fetches a portable
git for itself, takes five to ten minutes the first time for a version, and
keeps about a gigabyte of clones under `jars/buildtools/` so later builds are
faster. The panel narrates the build line by line.

The Plugins tab follows the software: Purpur searches Modrinth for Purpur, Paper,
Spigot and Bukkit builds; Folia only for Folia-built plugins; Spigot for Spigot
and Bukkit; vanilla has nothing to manage and says so. `upgrade` still knows
Paper only; other servers move versions by creating a new instance or importing
a newer jar.

`clone` gives fresh worlds by default; pass `--with-worlds` to copy world data
too. Ports are allocated automatically from 25565/25575 upward, skipping anything
already claimed in the registry or in use on the box.

### Snapshots

| Command | Does |
| --- | --- |
| `backup <name>` | Snapshot to `backups/<name>/` |
| `snapshots <name>` | List snapshots |
| `restore <name> [ref] --yes` | Restore (default `latest`); server must be stopped |
| `prune <name> --keep <n>` | Delete all but the newest n |
| `verify <name> [ref\|--all]` | Read a snapshot back end to end and check its coverage |

Scopes: `plugins`, `worlds`, `config`, `standard` (the default — plugins, the
active world set, and config), `full` (everything except `cache/`, `libraries/`,
`versions/`, `logs/`).

Backing up a running server issues `save-off` / `save-all flush` over RCON first
and `save-on` afterward, so a hot snapshot is coherent rather than a torn copy
of a world mid-write. That happens inside the snapshot itself, so every path
that takes one gets it: this command, the panel's Backups tab, a scheduled
backup task, and the snapshot taken before a cross-version upgrade. If the
flush cannot be done the snapshot is still taken and the manifest says so.

`restore` refuses without `--yes` and prints what it would overwrite. It
extracts over the instance in place and deletes nothing, so a file added after
the snapshot was taken survives a restore. To get back to exactly what the
snapshot holds, remove the members it lists first.

`verify` is a restore minus the writes: listing the archive decompresses every
block, so the gzip checksums are genuinely checked, and the entries are compared
against the manifest so a snapshot missing a locked world is caught the week it
was taken rather than the day it is needed. It exits non-zero on any failure, so
a scheduled `verify <name> --all` can be noticed by whatever runs it.

### Scheduled work

| Command | Does |
| --- | --- |
| `task list` | Every scheduled task, with its next run and last result |
| `task add <inst> --do <what> [when]` | Create one |
| `task rm <id>` / `task enable\|disable <id>` | Remove or pause one |
| `task run <id>` | Run it now — this is also what Windows calls |

`--do` is one of `backup`, `command` (with `--line "<what to send>"`), `restart`,
`stop`, `start`. When: `--daily 03:00`, `--hourly <n>`, `--minutes <n>`,
`--weekly SUN --at 03:00`, or `--on-logon`.

Windows Task Scheduler runs these, so they happen whether or not SpawnLoft is open.
They run **interactive only**: while you are signed in, screen locked included,
but not after you sign out. Running regardless would mean storing a Windows
password in the task definition, which is not a thing to do quietly for a nightly
backup.

SpawnLoft keeps the definitions in its own file and gives Windows only a trigger that
calls back into `mcctl task run <id>`. Two reasons: what a task *does* stays inside
SpawnLoft, where it is constrained to the handful of things a task is allowed to be
rather than an arbitrary command line; and editing a task does not mean recreating
a Windows task.

Every run writes a line to the instance's run directory recording what it did —
the filename a backup produced, the command it sent, or why it was skipped. Task
Scheduler only records an exit code, so `0` is all it can say about a backup.

Runs have three outcomes. A `command` task whose server is down did not fail;
there was nothing to send, and it reads as skipped. Renaming a server moves its
tasks with it, and deleting one takes them away.

### Other

| Command | Does |
| --- | --- |
| `templates` / `templates save <inst> <tpl>` | Reusable plugin+config sets |
| `jars` / `jars import <path>` | Server jar store used by `new` |
| `doctor` | Environment, port collisions, EULA, disk, stale state |

## How it works

```
mcctl (short-lived CLI)
   │
   ├─ spawns detached ──▶ src/daemon.mjs (one per instance)
   │                        │
   │                        ├─ owns the java child process
   │                        ├─ mirrors stdout/stderr ──▶ run/<name>/console.log
   │                        └─ listens on \\.\pipe\mcctl-<name>
   │                              ops: ping | send | stop | kill
   │
   ├─ reads run/<name>/state.json  (pids, ports, start time)
   ├─ reads run/<name>/console.log (logs, ready detection, follow)
   └─ connects to RCON on 127.0.0.1 (cmd, players, save flush)
```

The daemon exists because the CLI is short-lived and the JVM is not. It holds the
pipe to the server's stdin for as long as the server runs.

It also owns crash recovery, because it is the only thing alive at the moment a
server dies. With `auto-restart=on` for an instance, a crash is relaunched in
place after ten seconds; three crashes in ten minutes and it stays down saying
why, so a broken plugin cannot grind the machine all night. A stop that was
asked for always sticks — including `stop` typed straight into the console,
recognised by its clean exit. An optional per-instance Discord `webhook` gets a
message for the events nobody is watching the panel for: crashed, recovered,
gave up, or a scheduled task that failed. Routine lifecycle stays quiet.

Scheduled restarts can warn the players first (`warnMinutes` on the action, a
field in the panel's task form): the countdown is said over the console at the
full figure, one minute, and ten seconds.

State is reconciled against live pids on every read, so a daemon that dies takes
its instance to `stale` (cleaned up automatically) rather than reporting
`running` forever. A java process that outlives its daemon shows as `orphaned`
and `kill` will clean it up.

`instances.json` is the source of truth for ports and RCON. `start` pushes those
values into `server.properties` before every launch, so hand-editing the file
cannot silently desync an instance from what SpawnLoft believes about it. Pass
`--no-sync` if you want the file left alone.

### Layout

```
mcctl/
├── mcctl.mjs           CLI
├── mcctl.cmd           Windows shim
├── instances.json      Registry: ports, memory, RCON credentials  (gitignored)
├── src/
│   ├── daemon.mjs      Per-instance supervisor
│   ├── supervisor.mjs  start/stop/kill/ready-detection/log tailing
│   ├── control.mjs     Named-pipe client, state reconciliation
│   ├── rcon.mjs        Source RCON protocol client
│   ├── registry.mjs    Instance registry, Aikar JVM flags
│   ├── backup.mjs      tar-based snapshots
│   ├── create.mjs      new/clone/adopt/templates/jars
│   ├── props.mjs       server.properties reader/writer (preserves comments)
│   └── util.mjs        Ports, pids, tables, formatting
├── instances/          Instance data for servers mcctl created
├── templates/          Saved plugin+config sets
├── jars/               Server jar store
├── backups/            Snapshots + manifests
└── run/                Per-instance state.json, console.log, daemon.log
```

Instances that were `adopt`ed keep living wherever they already are; only their
runtime state lands in `run/`.

## Security posture

This is built for **localhost and LAN only**.

- RCON binds to whatever `server-ip` says; leave it empty for LAN or set it to
  `127.0.0.1` to keep RCON strictly local. RCON has no rate limiting or
  encryption and must never face the internet.
- `instances.json` stores RCON passwords in plaintext and is gitignored. So are
  `backups/`, `jars/`, `instances/`, and `run/`.
- Generated instances default to **`online-mode=true`**. That was `false` until v0.2.3, on the
  reasoning that a scratch server is for testing — but offline mode gives players name-derived
  UUIDs rather than Mojang ones, so any plugin keying data by UUID behaves differently: some bugs
  will not reproduce, and some appear that do not exist on a real server. Paper also prints a
  four-line `OFFLINE/INSECURE` banner near the top of every log, and plugin authors routinely
  refuse a bug report carrying it. A tool for reproducing plugin bugs should not produce reports
  that get thrown out on sight.

  Offline is still one toggle away, for multi-account testing or working without internet:
  `mcctl new <name> --offline`, `mcctl props <name> online-mode=false`, or the panel's
  **Settings…** on a server. The panel badges any server running that way.
- Nothing here opens firewall ports or touches your router. Exposing a server to
  the internet is a deliberate, separate decision.
- **Two things leave the machine, and only on a click.** *Feedback* opens GitHub in your browser
  with a report drafted; nothing is sent by SpawnLoft. *Console → Export → Upload to mclo.gs* posts the
  console log to [mclo.gs](https://mclo.gs), the log-sharing service plugin developers ask for,
  after a dialog that says what is in it: SpawnLoft replaces your account name in file paths first,
  mclo.gs removes IP addresses on its side (best effort, by its own policy) and deletes the log 90
  days after it was last opened, and everything else - player names, plugin output - goes as is.
  The delete token comes back and is kept in `run/mclogs.json`. Everything else SpawnLoft does stays
  on this machine.
- **The panel cannot be bound to another address.** There is no `--host` flag, on purpose:
  the panel has no login, and a panel reachable from another machine is a server console
  reachable from another machine. If you want to manage a server from elsewhere, remote into
  the machine that runs it. A remote panel is out of scope (see [ROADMAP.md](ROADMAP.md)).
- The panel is an **unauthenticated local HTTP server that can start processes and type into a
  server console**. Binding to `127.0.0.1` stops other machines reaching it; it does not stop the
  browser already on this one. So every request must also carry a loopback `Host` — which is what
  defeats DNS rebinding, since the attacker's own hostname is what arrives in that header — and an
  `Origin`, when there is one, must match that `Host` exactly, **port included**. Comparing only the
  hostname was not enough: this machine is full of pages served from loopback, and dynmap, BlueMap
  and Plan all serve web UIs on their own ports while rendering names and chat that players chose.
  Requests with no `Origin` (the panel's own fetches, curl, the CLI) are allowed, because that is
  what a first-party request looks like.
- **Scheduled tasks are code that runs on a timer**, so what a task may be is an allowlist rather
  than a command string: back up, send a console command, restart, stop, start. Windows holds only
  a trigger calling `mcctl task run <id>`; what that id means lives in SpawnLoft's own file, and a value
  it does not recognise is refused rather than executed. Tasks run as the signed-in user, with no
  stored password and no elevation.
- The page never receives an RCON password. Every route that returns an instance strips it first,
  so it cannot end up in a browser cache, a screenshot, or a pasted bug report.

## Notes

- JVM flags default to Aikar's G1 tuning, switching to the large-heap variant at
  12G and above. Override per instance with a `jvmFlags` array in
  `instances.json`.
- `start` truncates `run/<name>/console.log` each launch so `logs` shows the
  current run. The server's own `logs/` directory keeps the full rolling history.
- `tar` exits 1 with a warning when it skips a file the running server holds
  locked. That is expected on hot snapshots and is not treated as failure.

---

## The site

The project page and the docs live in their own repository,
[joogiebear/mcctl-site](https://github.com/joogiebear/mcctl-site), served at
[spawnloft.com](https://spawnloft.com): a VitePress site deployed by Vercel on every push. The
banner artwork partner sites embed lives there too, under `public/banner/`.

## The panel

```bash
node mcctl.mjs ui        # opens http://127.0.0.1:8770 in your browser
```

One HTML file, served by Node's own http module. No framework, no build step, no npm packages —
the panel that ships is the file in `src/ui.html`, and it works offline because nothing is fetched
from anywhere.

The same page runs in a browser tab and inside the desktop app. `window.mcctlDesktop` exists only in
Electron, and everything that depends on it is additive: a Browse button beside a path field, a
Settings screen that can move the data folder, update checking. In a browser those simply are not
there, and nothing else changes.

What it does:

- **Servers** — a card each, with a status lamp, the port, the memory and a live uptime that ticks.
- **Adding a server** — either create one, which downloads Paper and reports real progress, or point
  SpawnLoft at a folder you already have. Nothing is moved; existing ports and the RCON password are
  read from that folder's own `server.properties`.
- **Renaming, resetting and deleting** ask you to type the server's name. That friction is
  deliberate: a dialog that only says "are you sure" gets answered reflexively.

A selected server has five tabs.

**Console** — search, filter to warnings or errors, pause, copy, wrap, line numbers and a bounded
scrollback. *Export* saves the console to a `.log` file beside the server's snapshots, or uploads
it to mclo.gs for sharing with a plugin developer (see the security section for what is in it).
Log level shows as a coloured rail in the gutter rather than by recolouring the text, so ERROR
stands out without becoming harder to read. A stack trace inherits the level of the line above it,
which is what makes "filter to errors" show the whole failure instead of its first line.

**Plugins** — search and install from **Modrinth and Hangar** together, each result
naming its source, filtered or checked against this server's version, with checksum-
verified downloads, an update check, and one-click updates (a plugins-scope snapshot is
taken first). Hangar projects that host their downloads elsewhere are linked to rather
than pretended at. The page manages **only what SpawnLoft installed** — it records
provenance in the plugins folder — so a custom or premium plugin dropped in by hand is
never listed there, never offered a meaningless update, and never has its hash sent to
anyone. `mcctl plugins <name>` lists the full inventory, manual jars included, with a
SOURCE column saying which is which. Enable/disable renames the jar in place, so a
disabled plugin keeps its spot and its config.

**Backups** — take one at a chosen scope, see every snapshot with its size, age and coverage, and
restore or delete any of them. Restoring is refused while the server runs, because extracting over
files a live server holds open corrupts a world rather than replacing it. Automatic backups run on
a schedule with a retention limit, and the limit only ever removes snapshots its own schedule
produced — never one taken by hand or before a reset.

**Players** — everyone the server knows about, gathered from operators, bans, the whitelist, the
name cache and the world folder, since none of those is a complete list on its own. Search, filter
to operators or the banned, and op, ban or delete a player's world data. Whoever is connected is
marked and sorted first, which has to be asked of the server: a player's file is not written until
they log out, so a screen reading only files says "has never joined" about somebody standing in
front of you. Changes go through the console while the server runs and into its files when it does
not — editing a file under a live server is reverted the next time it saves.

**Feedback**, in the header, is three doors. *Something broke* opens a GitHub bug report with the
version, Java, server status and panel log already in it, and puts the full diagnostics on the
clipboard for pasting under it. *A question* opens a new post in the project's
[Q&A](https://github.com/joogiebear/spawnloft/discussions/categories/q-a), and *An idea* one in
[Ideas](https://github.com/joogiebear/spawnloft/discussions/categories/ideas). Nothing is
sent from SpawnLoft on its own; the browser hop is the consent. A crash notice under a server's vitals
has a **Report** link that does the same, named for the crash.

**Settings → Copy diagnostics** puts a bug report's worth of facts on the clipboard: the version,
the Java found, where things live, every server's status, the panel's own log (`run/panel.log`,
which records every time the panel process was held up for more than a quarter of a second) and
the last console lines of the selected server. It never includes an RCON password or a webhook URL.

**Performance** — processor and memory over the last minute, five minutes, half hour, hour or four
hours, sampled every ten seconds. Both scales follow the data, because a fixed 0–100% processor
axis draws every ordinary server as a flat line on the floor.

**Settings** — the part of `server.properties` people actually change: who can join, MOTD,
difficulty, game mode, max players, PvP, whitelist, view distance, spawn protection. Everything
else stays in the file for `mcctl props` or an editor, and nothing the panel writes disturbs
another key or a comment.

**Changing who can join** on a world that already has players warns first. Minecraft derives an
offline UUID from the player's name and uses the real Mojang one otherwise, so flipping this hands
everybody a different identity — permissions, homes, inventories and anything else a plugin keyed
by UUID stay attached to the identity nobody has any more. The panel reads the world's player data,
tells the two kinds of UUID apart by version, and says how many players are affected before you
decide.

There is also a **Scheduler** tab, covered under [Scheduled work](#scheduled-work).

The panel is bound to `127.0.0.1` and refuses any request whose `Host` is not a loopback address, or
whose `Origin` is not exactly its own — port included, because this machine is full of other things
serving web pages on loopback. It can start processes and type into a server console, so "local"
has to mean local rather than merely reachable — see [Security posture](#security-posture).

---

## Desktop app

A window around the same panel, plus a native folder picker and first-run setup.

```bash
cd desktop
npm install
npm start                  # runs the bundled core
npm start -- --core ..     # develop against this checkout (or set MCCTL_CORE)
```

The core runs **inside** the Electron process. Electron is already a Node runtime, so importing
SpawnLoft directly is what bundling means here: one process, no second Node to ship, and no orphaned
child if the window dies.

Closing the window does **not** stop your servers. They are detached daemons that do not belong to
the app.

### Releasing

Installers and the update feed live on **this repository's releases** (the repo went public on
2026-09-01, and its full release history was migrated here). `joogiebear/mcctl-releases` is the
legacy feed: apps installed as v0.6.6 or earlier check it for updates, so it keeps a copy of each
new release until that population has moved across — publish there stops once it has.

```bash
cd desktop
npm version patch                 # bump; the app reports this version
GH_TOKEN=<token> npm run release  # build, sign, upload as a DRAFT
npm run release:publish           # check it is whole, then make it live
```

**Two steps, deliberately.** Both one-step options fail, and this project has now seen each:

- Publishing **live** means a failed upload leaves a release tagged, live and marked latest with
  nothing to download and no update feed. That happened on v0.2.6 — the blockmap uploaded, the
  111 MB installer did not, and a client checking for updates in that window got a 404.
- Publishing as a **draft and leaving it** means the release looks published on GitHub while
  `electron-updater` cannot see it at all, so nobody is offered the update and nothing says so.

So the build uploads a draft, and `release:publish` makes it live only after confirming the things
whose absence caused the first failure: all three assets present, uploaded and non-empty, and
`latest.yml` naming this version with a size matching the installer actually up there. It refuses
and exits non-zero otherwise.

The draft is created **before** the build, by `ensure-draft.mjs`, and that ordering is load-bearing.
electron-builder uploads artifacts concurrently and each upload creates the release if it cannot
find it — and a draft has no git tag to find it by, so the first v0.2.7 build produced *two* drafts
a second apart with the assets split between them. Creating it up front leaves nothing to race over.

Every published release names the commit it was built from, captured at build time rather than
publish time, and says so if the tree was dirty. Same information under **Settings → About** in the
app, so a bug report can name the exact build rather than a version several builds could share.

Builds are signed through **Azure Artifact Signing** (formerly Trusted Signing), configured under
`win.azureSignOptions`. That publishes under a validated individual identity, which is what turns
"Unknown publisher" into a name.

It does **not** make SmartScreen go away immediately. SmartScreen is a reputation system, not a
signature check, and reputation accrues to the publisher identity through real installs — so a new
publisher still gets warned about. EV certificates used to grant reputation automatically; Microsoft
removed that in 2024. Keep telling people about **More info → Run anyway** until the reputation
builds.

Signing needs, on the build machine:

- the **.NET SDK** — electron-builder installs a `dotnet` tool to do the signing, and fails with
  "No .NET SDKs were found" if only the runtime is present
- **`az login`**, against the tenant holding the signing account. Note that MFA is enforced for
  Azure Resource Manager, and a bare `az login` fails against such a tenant because it tries to
  acquire tokens silently — use `az login --tenant <id>`, which authenticates interactively.
- the **Artifact Signing Certificate Profile Signer** role. Being subscription Owner does not
  include it; identity validation does not include it either. It is assigned separately, and its
  absence is the last thing that bites before a first successful signature.

Certificates live about **three days** and rotate automatically, which is why every signature is
timestamped — without one, everything already shipped would stop validating within the week rather
than staying valid for the moment it was signed in. `npm run verify` treats a missing timestamp as
a failure for exactly that reason.

### Tests

```bash
cd desktop
npm test
```

Covers window-state.js, which decides whether a remembered window position is still somewhere a
person can reach. That decision depends on which monitors are attached — the thing you cannot
arrange on the machine running the test — so the module takes the display list as an argument and
the test passes it fictional ones, including the case that matters: a window last seen on a second
monitor that is no longer plugged in.

### Checking a build before shipping it

CI runs the test suite and a CLI smoke check on every push, but it cannot build,
sign or publish - the signing profile lives on the release machine - so the
build checks itself:

```bash
cd desktop
npm run pack      # builds; afterPack fails it if the result is wrong
npm run verify    # re-checks a build that already exists, icon included
```

The check covers the things that have gone wrong silently before — the app icon not reaching the
executable, the core not being copied into `resources`, a file added to `desktop/` and forgotten in
the `files` allowlist, and a signature that is missing, invalid or untimestamped. `afterPack` runs during the build itself, so a bad build throws before an
installer is made and long before anything is published.

### How updates behave

Checking, downloading and installing are three separate presses. Nothing downloads or installs on
its own — this app sits beside long-lived servers, and an update that restarts the window
unannounced is a surprise rather than a feature. Installing warns that running servers survive it,
because the honest answer is that only the window restarts.

Update checks are refused outside a packaged build: in development the version is whatever
`package.json` says and there is no installer to replace.

### How uninstalling behaves

The uninstaller removes the program and asks one question: whether to delete your servers, worlds,
backups, downloaded jars and settings too. The default is no, so uninstalling to reinstall, or to
move to a new version by hand, loses nothing.

Either way it first stops every running server and removes every scheduled task, since a task left
behind would keep firing at a program that is gone. An update never does any of this: the servers,
the tasks and the data all carry across.

Saying yes deletes only what this program created. A server you added from a folder you already
had stays where it is, and a data folder you pointed at a drive with other things on it loses only
SpawnLoft's own folders. The same command is available from a terminal as
`mcctl uninstall --yes [--data]`.

## Databases

Plugins that want MySQL — LuckPerms, CoreProtect, Plan, AuthMe, Jobs, mcMMO — can have one
here, with nothing to install; so can plugins that want Redis, by way of Microsoft's Garnet. A database is another entry in the registry, run by the same
daemon as a server: a card with a lamp, a console, start, stop and restart, crash recovery.

```bash
mcctl db versions                    # MariaDB releases that can be run
mcctl db add maria                   # downloads the newest stable MariaDB, once, and sets one up on a free port
mcctl start maria
mcctl db attach maria survival       # a database and a user for that server; prints the credentials
mcctl db create survival             # or all of that in one step: survival-db on port 25566, started, attached
mcctl db creds maria survival        # shows them again
mcctl db detach maria survival       # takes the user away; --drop deletes the data too
mcctl db add cache --engine garnet   # a Redis-compatible server, the same way
mcctl db connect xampp --port 3306 --user root --password ''   # one you already run, registered so servers can attach
mcctl db plugins survival            # which plugins here can take the credentials
mcctl db apply maria survival luckperms   # writes them into that plugin's config, comments kept
```

MariaDB comes from its own mirror as the portable Windows zip, hash-checked and unpacked with the
`tar` Windows ships, into `engines/` beside the jars; every database on that version shares it.
Each database keeps its data under `services/<name>/`, listens on 127.0.0.1 only, and is stopped
through `mariadb-admin` over TCP, since a database takes no console input. The user a server gets
can reach its one database and nothing else. A snapshot of an attached server carries a dump of
its database as a `databases/` member; verify checks for it, and restore imports it back into the
database it came from, which has to be running. *Apply to a plugin* writes the credentials into
LuckPerms, CoreProtect, Plan or AuthMe's own config, in place, with the comments kept; the server
restarts for the plugin to read it. A database you already run - XAMPP, a MariaDB install, a Redis on the LAN - is
registered with its address and attaches the same way, only never started or stopped from here. In the panel, databases sit under the servers in the
sidebar, a server's Settings tab has a Databases card with the credentials one click away and a
*Create a database* button that makes one for that server in one step - MariaDB's newest stable
release on the port after the game port, started and attached - and *Add a server → A database*
creates one with the choices in it (a version, an engine, one for several servers to share). The plan, with what comes next (backups of attached
databases, config helpers for the common plugins, Redis by way of Garnet), is in
`docs/databases-plan.md`.
