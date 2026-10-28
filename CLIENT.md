# The game client

`spawnloft client` is a Minecraft launcher for your own servers. You make a profile (a Minecraft
version, a loader, how much memory), press Play, and the real Minecraft client starts, already
pointed at one of your SpawnLoft servers. Nothing is drawn or patched by SpawnLoft: it downloads
the client Mojang ships from Mojang's own servers, the way Prism and MultiMC do, and runs it.

There are two ways to drive it. The command line (`spawnloft client ...`) is below; for a person
who would rather click, the [game launcher](#the-game-launcher) is a window with one Play
screen: a Play button with the setup it plays, a Join field, an account menu with the Microsoft
sign-in, and a version picker.

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

## The game launcher

The game launcher is a window for the same profiles and accounts the command line uses (nothing
is kept twice: a profile made in one shows in the other). It is a dev tool that goes with
SpawnLoft, not a separate product, and it is one screen. On it a profile is called a **setup**,
named by what it is (`1.21.11 · Vanilla`, `1.21.1 · Fabric (modded)`); the command line, the API
and the files keep "profile".

- **Play** is a split button. The big half plays; the small half shows the setup's version and
  opens the setups menu: pick another setup, edit one (the gear), or make a **New setup**. A line
  under the button says what will happen ("Opens Minecraft 1.21.11 and joins survival as
  Wunga_."). The first launch of a version downloads the game (progress shows in the button's
  place; closing the window does not stop the download, and the files are used next time).
- **Join** is one field. Its menu lists the SpawnLoft servers with their state (and a note when one
  runs another version than the setup), plus *Title screen only*. A stopped server is started
  first: the button then reads **Start server and play**, waits up to two minutes for it, launches
  the game and joins it. Typing into the field instead joins any other server, `host` or
  `host:port` (a bracketed IPv6 address works). An address is only checked for shape; whether the
  server is reachable, and which accounts it lets in, is between the game and that server. The
  field remembers where each setup went last, in the page's local storage; a typed address does
  not become a saved server. Assistant control (the harness) works on your own SpawnLoft servers
  only.
- **The account chip** (top right) opens the account menu: who plays (click one to make it the
  default), **Add Microsoft account** (see [Signing in from the launcher](#signing-in-from-the-launcher)),
  an offline name for servers with `online-mode=false`, and sign out. A setup plays as its own
  account, else the default account (see [Default account and precedence](#default-account-and-precedence)).
  When a setup has neither, Play first asks **Who's playing?**: sign in with Microsoft, or type an
  offline name and play.

On a fresh install with no setup, Play makes one for the latest release (Vanilla, 2 GB), asks
who is playing, and plays. Nothing downloads before that is answered.

The setup sheet (New setup, or the gear) has the version (releases, or with snapshots, or
everything, from Mojang's version list, cached so it works offline once fetched), Vanilla or
Fabric, memory (2, 4 or 8 GB, or Custom: a slider up to the machine's memory that says how much is
free), an optional name (else it is named by its version), who it plays as, the server it usually
joins, **Let SpawnLoft see the game** (the harness mod), and under Advanced the Java path, the
Fabric loader version and, once the setup exists, the switch that lets an assistant use its
Microsoft account. Changing the version, loader, Java, memory or harness is refused while the game
is running. Changing the version of a setup that has mods in its folder warns that they may not
load. **Remove setup** keeps its folder unless you tick the box.

While a game runs the button turns into **Stop**, with **Open folder** (desktop app only; a
browser tab shows the folder's path instead). If the game closes within a minute of starting
without a Stop from the page, a notice says so, shows the last lines of the game log, and offers
**Report a problem**, which writes the same diagnostics bundle as `spawnloft diag --client`. When
Play cannot work it is greyed with the reason where the line under it was, and a link that fixes
it: the account the setup names is no longer signed in or its sign-in expired, an online-mode
server was picked for an offline player, another launch is under way, the machine cannot run the
client (Linux arm64, for one), or the panel refused the version itself. The old `#profiles` and
`#accounts` links open the setups menu and the account menu.

Everything the page does goes through the panel's `/api/client/...` routes (profiles, versions,
launch, stop, log, diag, accounts), behind the panel's localhost Host and Origin check. A launch
is a job: the page posts it with a job id, opens `/api/jobs/<id>/stream` and shows the download
and start-up lines, which end in `running` or an `error`. `GET /api/client/launcher` is the one
read the page polls (profiles with their running state, accounts, the default account, the
servers a profile can join, a refusal when the machine cannot run the client, and the machine's
total and free memory for the memory slider). The log tail is
scrubbed of the harness token, the game's access token and every secret the registry or the
accounts file holds (it keeps player names: the page is the account owner's own; only the
diagnostics bundle hides them). No route returns a token.

### Opening it

| From | How |
| --- | --- |
| The desktop app | The **Play** button at the bottom of the sidebar opens the launcher in a window of its own, which remembers its size and place. A second press brings the open one forward. |
| macOS | **Window → Game launcher** in the menu bar does the same. (Windows and Linux have no app menu bar; use the sidebar button.) |
| The command line | `spawnloft ui --launcher` starts the panel and opens `/launcher` in the browser. If a panel is already running on the port, it opens that panel's launcher instead of failing. `--no-open` prints the address (`http://127.0.0.1:8770/launcher`) without opening it. |
| A browser | Go to `/launcher` on a running panel. The sidebar button works there too, as a tab. |
| A server card | The **Play** on a server card (and its ⋯ menu) opens the launcher with that server and its Minecraft version pre-filled. |

In the desktop app the Microsoft sign-in opens in a small window of its own (not your browser)
that closes by itself when the sign-in is done; in a browser it is a new tab. The launcher page
refuses to be framed by other pages.

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
Microsoft's own page, and the command finishes when you have (Ctrl-C gives up on it). No password
passes through SpawnLoft. What it keeps is a refresh token, in `client/accounts.json`, a file only
your user can read; the game gets a short-lived session token at each launch, and a token that is
about to expire is refreshed before the launch. `client accounts` lists who is signed in, `client
logout <name>` forgets one. An account on a profile (`account=<name>`) is used by every launch of
it; `--account offline:<player name>` plays offline again for one run. `--as` and `--account` do
not mix: a signed-in account brings its own name.

Accounts are told apart by uuid; the name is what you type and what Mojang may let the person
change. A profile's `account` key is stored as the uuid when the account is in the list (a key
written as a name by an older SpawnLoft keeps working), and the CLI, the panel and the assistant
show it as the name. The game launcher's offline accounts (below) are in the same file, as a name
and the uuid an offline-mode server derives from it, with no tokens; `client logout <name>`
removes one of those too.

### Default account and precedence

The game launcher keeps a **default account** (`defaultAccount` in `client/profiles.json`, a
uuid): the first account added through the launcher, or whichever one you make the default
there. It is only a preference. A launch plays as, in this order: `--as <player name>` (offline),
then `--account <account>`, then the profile's own `account` key, then the default account, then
offline under the profile's name. So an existing profile with no `account` plays as your
Microsoft account the moment you sign in through the launcher and make it the default, which is
right for a person and harmless on offline-mode servers. **An assistant launch never uses the
default account**: `client_launch` plays offline unless the profile itself names an account and
`assistantAccount` allows it. A default that points at an account you have since signed out is
dropped, not an error; the launch falls through to offline.

A running game's `state.json` says who started it (`launchedBy`: `cli`, `panel`, `launcher` or
`assistant`), and `client status --json` and `client_status` show it.

### Signing in from the launcher

The game launcher (the panel's `/launcher` page, in the desktop app or a browser) signs in through
Microsoft's own sign-in page instead of a code: OAuth authorization code with PKCE and a loopback
redirect, the flow every launcher uses. The Azure registration (client id
`946097b5-241d-4f83-9981-c6d0778e5507`, a public client, no secret anywhere) has exactly one
redirect URI, `http://localhost/api/client/accounts/login/callback`; Microsoft matches localhost
redirects on any port, so it covers the desktop app's per-launch port and the CLI panel's 8770,
and the path has to match exactly. The chain after the Microsoft token (Xbox Live, XSTS,
Minecraft, profile) is the one the device code runs, so Mojang's approval of the app id applies
to both.

How it runs, in the panel process (`src/client-login.mjs`):

1. The page asks `POST /api/client/accounts/login`. The panel makes an in-memory record (a
   random `state`, a PKCE verifier, the time) and answers `{ loginId, authorizeUrl }`. The
   verifier and the state never leave the process except inside that URL.
2. The page opens `GET /api/client/accounts/login/<loginId>/stream` (server-sent events; the
   first event is `{ status: "pending" }`), then opens `authorizeUrl` in a window.
3. Microsoft redirects the window to `GET /api/client/accounts/login/callback?code=…&state=…`.
   A `state` that names the one live record is consumed at once, the stream says
   `{ status: "finishing" }` (from then on closing the window is not a cancel), and the window
   gets a short static page ("Finishing the sign-in in SpawnLoft. You can close this window."); anything
   else, including a replay, is a 400 that changes nothing. The code is exchanged and the chain
   runs after that answer, in the background.
4. The outcome reaches the page on the stream only: `{ status: "done", account }` (name, uuid,
   type, expiry) or `{ status: "failed", message }` with Microsoft's `access_denied`, an expired
   code, the Xbox errors and a lost connection each mapped to one line. The first account that
   signs in this way becomes the default account.

`DELETE /api/client/accounts/login/<loginId>` cancels (the stream ends with `cancelled`). One
sign-in runs at a time: a second `POST` is a 409 while the first still has an open stream, and
replaces it when nobody is listening. A record whose stream has been gone for 10 seconds is
dropped, unless the callback has already consumed it (the chain then finishes and saves the
account even if the launcher window was closed meanwhile), and every record expires 10 minutes
after it was made. The callback is the one route a
page cannot reach by itself (it has no Origin header, being a top-level navigation), and it is
useless without the state that exists only in the panel's memory. Nothing from the callback (the
code, the state, Microsoft's error text) is written to `panel.log`; the log line is "signed in
<name>".

The accounts routes, all behind the panel's localhost Host and Origin check and none of them ever
carrying a token:

| Route | Does |
| --- | --- |
| `GET /api/client/accounts` | `{ accounts: [{ name, uuid, type, expiresAt, refreshFailedAt }], defaultAccount }` |
| `POST /api/client/accounts/offline` `{ name }` | Adds an offline account (3 to 16 letters, digits, underscore) |
| `POST /api/client/accounts/default` `{ uuid }` | Sets the default account (`null` clears it) |
| `DELETE /api/client/accounts/<uuid>` | Signs out a Microsoft account or removes an offline one |

`refreshFailedAt` is set on a Microsoft account when a refresh at launch fails (the launch itself
fails with "sign in again"); a new sign-in clears it. `expiresAt` is the day-long game token and
means nothing about whether the account still works, which is why the launcher shows "sign in
again" from `refreshFailedAt` and not from the expiry. Every write to `accounts.json` re-reads
the file and changes only its own entry, so a sign-in in the launcher and a `client login` or
`client logout` in a terminal at the same time cannot lose each other.

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

**What has been tried.** The device-code sign-in has been run end to end on Windows: Xbox Live,
Minecraft login, profile, an online-mode join, a token refresh, and sign-out. Games have launched
on Windows, Linux x64 and Apple Silicon. The launcher's browser sign-in is covered by tests and its
window by a run of the desktop shell on Linux, but **not yet verified**: the redirect through
Microsoft's real sign-in page, signing in on macOS or Linux, the sign-in and the Play button inside
the *packaged* Windows desktop app, and the macOS **Window** menu entry. One known unknown: on
Windows `localhost` can resolve to `::1` before `127.0.0.1`, and the panel listens on `127.0.0.1`
only; if the sign-in window ends on "can't reach this page", use `client login` meanwhile and
report it.

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
  accounts.json              the signed-in Microsoft accounts with their tokens, and the launcher's offline accounts (owner-only, see Accounts)
  profiles/<name>/           one profile's game folder: options.txt, mods/, logs/latest.log,
                             screenshots/, saves/, crash-reports/, spawnloft-harness.json (while the harness runs)
  versions/<id>/             the client jar and its version JSON, one folder per version
  libraries/                 shared by every version
  assets/                    shared by every version; log_configs/ holds the log4j configs Mojang names
                             for each version (its Log4Shell mitigation, passed to the game at launch)
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

- Sign in for an AI assistant. A person signs in, on the command line or in the launcher; offline players join offline-mode servers only.
- Be a modpack launcher, news feed or store. The launcher starts profiles you made; mods go in the profile's `mods/` folder.
- Download Java. Install Java 21 or newer yourself, as for a server.
- Bundle mods or tweaks of its own. The only mod it ever installs is the harness, and only when a profile asks for it.
- Run on Linux arm64, or on a machine with no display. The client needs a graphics driver; use bots there.
- Drive the game through anything but the harness: no screen scraping, no input injection.
- Create or delete profiles from an AI assistant. That stays with you, on the command line, so an
  assistant cannot fill the disk with game versions.
