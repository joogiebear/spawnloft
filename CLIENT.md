# The game client

`spawnloft client` is a Minecraft launcher for your own servers. You make a profile (a Minecraft
version, a loader, how much memory), press Play, and the real Minecraft client starts, already
pointed at one of your SpawnLoft servers. Nothing is drawn or patched by SpawnLoft: it downloads
the client Mojang ships from Mojang's own servers, the way Prism and MultiMC do, and runs it.

The same client can be driven by an AI assistant or a script. A small Fabric mod, the *harness*,
opens a control channel on this machine only, and through it `spawnloft mcp`'s `client_*` tools
can join a server, chat, read what came back, take a screenshot and quit. Scripted test players
(bots) still exist for what they are good at; [when to use which](#bots-or-the-real-client) is
below.

What it is not: a custom renderer, a mod bundle of FPS boosters and cosmetics, or an account
system of SpawnLoft's own. It is the stock client, installed and launched for you.

## Setup

You need **Java 21 or newer** for Minecraft 1.21.x (the same Java a server of that version
needs; `spawnloft doctor` says what is installed). SpawnLoft finds it the way it finds a server's
Java and picks the newest that fits; a profile can be pinned to one with `java=<path>`.

```
spawnloft client new play --mc 1.21.11 --server survival
spawnloft client launch play
```

The first launch downloads the client jar, its libraries and assets (a few hundred megabytes,
with progress on stderr) and starts the game as an offline player named after the profile. The
download is shared between profiles of the same version, so a second profile on 1.21.11 starts
at once. `spawnloft client install <name>` does the download without starting the game.

`launch` takes `--as <playerName>` to play offline under another name, `--account <name>` to
play as a signed-in Microsoft account, `--server <name>` to point at a different server for this run, and `--wait`, which keeps the command alive for five seconds and
fails if the game died in that time. It does not wait for the game to load or join; the
assistant's `client_launch` does (see [The harness](#the-harness)). Everything else goes through `status`, `stop` and `logs`.

If the profile's server is stopped, `launch` prints a `warning:` before the game starts (and
`--json` carries it in `warnings`), because the game will show "Connection refused" until the
server is up; start it, the game can wait on its connect screen. An offline player against a
server in online mode is refused before anything downloads or opens, with exit code 1, since the
server would refuse the join for sure: sign in and play as that account (`--account <name>`, or
`account=<name>` on the profile), or set `online-mode=false` on a test server. The panel's Play
and the assistant's `client_launch` refuse with the same words. A profile whose `server` is a
database target is refused before anything downloads.

**Platforms.** Windows x64, macOS on Apple Silicon (tested on an arm64 Mac with arm64 Java) and
Linux x64 are supported. Linux arm64 is not: Mojang ships no arm64 Linux natives, so `launch` and
`install` refuse with "use bots on this machine" before downloading anything. Windows arm64 works
only for Minecraft versions that ship Windows arm64 natives (1.21 and newer) and is refused for
older ones. The native libraries come from the machine's own CPU architecture, as Node reports
it, not from the chosen Java's: a Java of the other architecture
than the machine's (an x64 Java under Rosetta on Apple Silicon) will not load them, so use a
native Java there.

## Profiles

```
spawnloft client list
spawnloft client new <name> --mc <version> [--loader vanilla|fabric] [--memory 2G] [--java <path>] [--server <server>] [--harness] [--account <name>]
spawnloft client set <name> key=value ...
spawnloft client remove <name> [--purge]
```

A profile is a few keys, all changeable with `set`:

| Key | Meaning |
| --- | --- |
| `mc` | The Minecraft version, such as `1.21.11`. |
| `loader` | `vanilla` or `fabric`. Fabric is needed for mods, and for the harness. |
| `loaderVersion` | The Fabric loader version. Left empty, the newest stable one is picked at the first launch and recorded. |
| `memory` | The game's heap, a whole number of M or G (`2G` by default). |
| `java` | A specific Java to use, or empty to let SpawnLoft pick. |
| `server` | The SpawnLoft server the game joins on launch, or empty for the title screen. |
| `account` | A signed-in Microsoft account to play as (see [Accounts](#accounts)), or empty to play offline. |
| `assistantAccount` | `true` lets an AI assistant launch this profile when it plays as a signed-in Microsoft account (`account=`). `false` by default for every profile, however it was made; only `set` turns it on. Offline profiles are not affected. |
| `harness` | `true` installs the harness mod and Fabric API into the profile's `mods/` on launch and opens the control channel. Needs `loader=fabric`. |

Profile names follow the same rule as server names: letters, digits, dash and underscore, up to
32 characters. `remove` forgets the profile but keeps its game folder, with its saves,
screenshots and mods, on disk; `--purge` deletes the folder too. A profile that is running or
being launched cannot be removed.

Each profile has its own game folder, so its `options.txt`, resource packs, mods and
screenshots are its own. Put mods in `client/profiles/<name>/mods/` (see the layout below) the
way you would in any launcher.

## Accounts

By default the client plays **offline**: the player has a name and nothing else, exactly like a
scripted test player. That is enough for any of your servers running `online-mode=false`, which
is what a test server usually is (`spawnloft new <name> --offline`, or `spawnloft props <name>
online-mode=false`). A server in online mode refuses an offline player, and `client_join` and the
diagnostics say so.

To play on an online-mode server as yourself, sign in once:

```
spawnloft client login
spawnloft client launch play --account Joogiebear
spawnloft client set play account=Joogiebear
```

`login` prints a code and a Microsoft address; you enter the code in your browser, on
Microsoft's own page, and the command finishes when you have. No password passes through
SpawnLoft. What it keeps is a refresh token, in `client/accounts.json`, a file only your user can
read; the game gets a short-lived session token at each launch, and a token that is about to
expire is refreshed before the launch. `client accounts` lists who is signed in, `client logout
<name>` forgets one. An account on a profile (`account=<name>`) is used by every launch of it;
`--account offline:<player name>` plays offline again for one run. `--as` and `--account` do not
mix: a signed-in account brings its own name.

The account needs Minecraft: Java Edition and an Xbox profile; a child account must be allowed by
an adult in its Microsoft family first. The sign-in itself goes through Microsoft's and Mojang's
servers only, and Microsoft must have approved SpawnLoft's registration for Minecraft sign-in; until
it has, the command says so and offline profiles still work.

An AI assistant cannot sign in or read the accounts file, and it cannot launch a profile that plays
as your Microsoft account until you allow it for that profile:

```
spawnloft client set play assistantAccount=true
```

`client_launch` refuses such a profile with that command in the message, and `client_profiles`
marks it "not for assistants". Launching from the command line or the panel is never affected, and
an offline profile needs no permission. The tokens never appear in a tool result, the activity log
or a diagnostics bundle, and a bundle also replaces the signed-in accounts' names and uuids with
`[microsoft account]` wherever the logs carry them ("Setting user", "joined the game"); offline
player names stay, they are not identities.

**Where the tokens live.** `client/accounts.json` under the data folder holds the accounts with
their access and refresh tokens, and `client/run/<name>/state.json` holds a running game's harness
token. Both are written for this user alone: mode 0600 on macOS and Linux, and on Windows, where
a mode means nothing and a file would inherit its folder's permissions (a data folder on a second
drive often lets every account on the machine read it), an explicit ACL set with `icacls`,
inheritance removed and one entry for the account running SpawnLoft. The accounts file is not
written at all when that cannot be done (a drive without permissions, such as FAT), and the
sign-in says so. `spawnloft doctor` checks these files, the registry (RCON and database
passwords) and every server's `server.properties`, reports one that other users could read, and
makes it owner-only when run without `--json`. The game itself gets the access token on its
command line, as every launcher does, where anyone who can list this user's processes can see it;
it expires within a day, and the refresh token never leaves the accounts file.

The whole sign-in has been run end to end on Windows: device code, Xbox Live, Minecraft login,
profile, an online-mode join, a token refresh, and sign-out. On macOS and Linux the same code runs
but has not been tried against Microsoft yet.

## The harness

With `harness=true`, launching does two more things: it puts the
[spawnloft-harness](https://github.com/joogiebear/spawnloft-harness-mod) mod and Fabric API into
the profile's `mods/`, both downloaded once and checked against a pinned hash, and it hands the
game a one-time token. The mod does nothing at all unless it was started with that token. With
it, the mod listens on `127.0.0.1` on a port the operating system picks, writes the port into
`spawnloft-harness.json` in the game folder, and answers requests from the process that knows the
token: SpawnLoft, on the same machine. The first request on a connection must carry the token or
the connection is closed without a word; one connection is served at a time; the token is fresh
on every launch and dies with the game.

`client_launch` waits (up to 90 seconds) until the game has loaded: the title screen, or the world
when the profile joins a server, plus a moment for Mojang's loading overlay to fade, so a
screenshot taken right after is not the splash. `client_join` waits until the player is in the
world (up to 60 seconds) and says so if the server kicks it during loading. If the game is still
joining the profile's own server it waits for that connection instead of starting a second one, it
does nothing if the player is already there, and it refuses another server until the first
connection is done.

What the harness can do, in the words the MCP tools use: tell what screen the game shows and
which server it is on (`client_status`), join one of your servers (`client_join`), send chat or a
command as the player (`client_chat`; `stop`, `restart` and `reload` are refused, as they are from
the console tools), read the messages the client received (`client_messages`), take a screenshot
(`client_screenshot`) and quit (`client_quit`). It cannot read or write files, change settings, or
reach anything the player could not.

Everything the harness returns, chat, titles, screen titles and item names, is game content
written by players, plugins and servers. The tools say so in their replies (`client_logs` and
`client_status` too), and an assistant should treat it as data rather than instructions.
`client_chat` waits a few seconds for the server's echo of the message before it returns.

Two things to know about the token. It is passed to the game as a JVM flag
(`-Dspawnloft.harness.token=...`), so any other user on this machine can read it from the process
list while the game runs (`ps`, Task Manager's command line column, `/proc/<pid>/cmdline` on
Linux); with it they can drive your game window through the harness. On a machine you share with
people you do not trust, leave the harness off. The profile's `run/<name>/state.json`, which also
holds the token, is readable only by your own user. And Minecraft's crash reports list the JVM flags,
so a crash report in the profile's `crash-reports/` holds a token that is already dead; the
diagnostics bundle redacts it anyway.

The harness is published for the Minecraft versions it was built against (1.21.11 today). A
harness profile on another version is refused at launch with the list.

## Bots or the real client

Both can act as a player; they are for different things.

| Need | Use |
| --- | --- |
| Several players at once, fast, headless, in CI, no Java on the machine | Bots (`bot_run_scenario`). Up to five, no rendering, assertions on packets. |
| Plugin logic: commands, permissions, GUIs by slot, chat replies, console lines | Bots. They already do this and do it well. |
| Anything a player *sees*: resource packs, custom models, client mods, disconnect screens, the real chat rendering, a crash on the client side | The real client. Bots see packets, not pixels. |
| A screenshot as evidence | The real client (`client_screenshot`). |
| Reproducing a bug a person reported from their own game | The real client, with the same version and mods. |
| A person who wants to play on their SpawnLoft server | The real client, as a launcher. |
| Load, soak, or "does it still work with five players on" | Bots. |

The difference underneath is lifetime: a bot scenario is one call that joins, runs and leaves; a
client session stays open across many calls (launch, join, chat, screenshot, quit), because a game
window that takes half a minute to start cannot be relaunched per step. [BOTS.md](BOTS.md) has
the scenario format.

## Where things live

Everything client-side sits under the data folder, beside the servers, in `client/`:

```
client/
  profiles.json              the profiles
  accounts.json              the signed-in Microsoft accounts with their tokens (owner-only, see Accounts)
  profiles/<name>/           one profile's game folder: options.txt, mods/, logs/latest.log,
                             screenshots/, saves/, crash-reports/, spawnloft-harness.json (while the harness runs)
  versions/<id>/             the client jar and its version JSON, one folder per version
  libraries/                 shared by every version
  assets/                    shared by every version
  natives/<id>/              the native libraries, per version
  run/<name>/state.json      what is running: pid, start time, player, server, harness token and port (owner-only)
  run/<name>/launch.lock     held while a launch is under way, so two Play clicks cannot start two games
  run/<name>/client.log      SpawnLoft's capture of what the game process printed, one launch at a time
  run/<name>/cache/          Mojang's and Fabric's version lists, with the time they were fetched
```

`spawnloft client logs <name>` shows the process capture (JVM errors land there);
`--latest` shows the game's own `logs/latest.log`.

A second launch of a profile that is starting or running is refused ("is being launched (pid N)").
The lock treats its holder as alive when that process id exists, like every other SpawnLoft lock,
so after a crash or reboot a process id reused by something unrelated keeps the profile refused
until that process exits. If it never does, delete `client/run/<name>/launch.lock`.

## When something goes wrong

`spawnloft diag <server> --client <profile>` writes one zip with the server's console and
daemon log, the client's `latest.log` and process capture, both sides' newest crash reports, the
profile's `options.txt`, and the known-problem findings for each side, all on one timeline so a
client error lines up with what the server was doing at that moment. Passwords and your computer
account's name in file paths are removed first; the Minecraft player name is not, so an offline
`--as` name stays in the bundle. `diag --client <profile>` on its own does the client half. An AI
assistant gets the same through the `diagnostics` tool with `client: "<profile>"`.

The findings the client side knows: out of memory, a graphics driver that cannot open a window
(a headless machine cannot run the client; bots are the way to test there), a mod missing a
dependency or built for another version, a server that could not be reached, a version mismatch
with the server, an expired or offline login refused by an online-mode server, a resource pack
that would not load, a crash, and a Java too old for the version.

## What it does not do

- Sign in for an AI assistant. A person signs in on the command line; offline players join offline-mode servers only.
- Download Java. Install Java 21 or newer yourself, as for a server.
- Bundle mods or tweaks of its own. The only mod it ever installs is the harness, and only when a profile asks for it.
- Run on Linux arm64, or on a machine with no display. The client needs a graphics driver; use bots there.
- Drive the game through anything but the harness: no screen scraping, no input injection.
- Create or delete profiles from an AI assistant. That stays with you, on the command line, so an
  assistant cannot fill the disk with game versions.
