# Roadmap

What SpawnLoft is for shapes what goes on this list: one person's own machine - Windows, macOS or Linux - running
servers for friends, family or plugin testing, with no accounts, no cloud, no Docker, and
nothing exposed to a network without a deliberate decision. Features that serve that
person go on the list; features that turn this into a smaller Pterodactyl - multi-node,
user accounts, a remote web panel - stay off it on purpose.

## Done

- **Reliability** *(v0.6 line)* — crash auto-restart with a crash-loop stop, scheduled
  restarts that warn the players first, Discord webhook notifications for the events
  nobody is watching for, and `spawnloft verify` to prove snapshots actually restore.
- **Plugin manager** — a Plugins tab and `spawnloft plugins`: Modrinth search and install
  filtered to compatible builds, hash-based update check, one-click update with a
  plugins snapshot first, enable/disable by renaming in place. Manages only what it
  installed (provenance recorded beside the jars); hand-dropped custom and premium
  plugins are left alone and never hashed to anyone.

- **Server updates** — `spawnloft upgrade` and a "Server software" card in Settings: a
  routine one-click move to the newest Paper build (old jar kept as the way back), and
  a deliberately harder, confirmed, snapshot-first path for crossing Minecraft
  versions, because worlds migrate one-way.

- **Hangar as a second plugin source** *(v0.6.2)* — searched alongside Modrinth with
  the source named on every result, sha256-verified installs, and version-name update
  checks against the provenance record. External-download projects (premium and
  elsewhere-hosted) are linked to rather than pretended at; a sparse version claim is
  offered with the mismatch said out loud.

- **Modded servers, complete** *(0.6.x)* — Fabric and NeoForge
  as first-class loaders with a Mods tab, "From a modpack" in Add-a-server for both,
  pack updates that may only touch what the old pack owned, and the server's version
  treated as a preference rather than a wall: search shows the loader's whole
  ecosystem, and a mismatched build installs with the author's version claim stated.
- **Form controls with depth** *(v0.6.6)* — carved fields, an owned select chevron,
  drawn radios, troughed switches; the wizard matches the panel.
- **Worlds** *(v0.7.0)* — a Worlds tab and `spawnloft worlds`: every world listed with the
  active one named (and shown in the vitals), import a downloaded map from a zip or
  folder (found wherever it is nested, never overwriting), export one as a zip, switch
  which world runs, delete with the truth stated (only the active world is ever in
  snapshots). Plus the batch's two riders: a **backup mirror** — every snapshot copied
  to a second location as it is taken, deletions following, because servers and backups
  on one drive fail together — and a **scheduled verify** action, so backup integrity
  runs on a clock and failures reach the webhook.

- **Log intelligence** *(v0.8.0)* — src/diagnose.mjs recognises the known failure shapes
  (port taken, EULA, wrong Java, out of memory or disk, missing plugin/mod dependencies,
  duplicate plugins, corrupt worlds, ticking crashes, watchdog stalls, missing jars) and
  says the fix wherever the failure surfaces: a strip under the panel's vitals, advice on
  a failed `spawnloft start`, `spawnloft why <name>`, and the daemon's crash webhook naming the
  likely cause. Minecraft's own crash reports are surfaced beside them, with their
  Description line, one click from the folder.

- **AI assistants** *(1.3.0)* — `spawnloft mcp`, a Model Context Protocol server on stdio for
  an assistant the owner chooses: status, logs, diagnostics, TPS, backups, plugins and Paper
  updates. No account, no port, nothing sent unless that assistant asks. Credentials and player
  IPs stay out of every result; restore, kill and cross-version upgrades are offered only when the
  owner's own config allows them, and deleting a server is not offered at all. Settings shows the
  exact config for the install. Plugin installs now take a snapshot first, in the panel too.

- **Databases** *(2.0)* — managed MySQL and a Redis-compatible service (Garnet) per server, each
  with its own database and user, listening on localhost only. Connection details are shown, never
  written into a plugin's configuration. Snapshots include a dump; MySQL has its own backups.
- **Java that picks itself** *(2.0)* — each server uses the newest installed Java that fits its
  Minecraft version (17, 21 or 25); a version nothing installed can run is refused before any
  download, with a link to the Java it needs.
- **The game launcher** *(2.0)* — a Play button for your own server: a setup with a Minecraft
  version, an optional mod loader and memory, Microsoft sign-in or offline play on a test server,
  and a way for an allowed assistant to join as a real player.
- **SpawnLoft 2.0** *(2.0.0, 2026-11-26)* — the whole core is the `spawnloft-core` binary: CLI,
  panel, game launcher, daemons, bot harness and MCP server. A Tauri shell on the system web view
  replaces Electron, so no Node runtime ships in any package (Node is needed only for test players,
  see BOTS.md). A supervisor keeps servers running while the app updates, updates are verified
  against SpawnLoft's own signing key, and the panel needs a sign-in.

## Next

- **A Share screen** *(tabled 2026-09-01, owner's call)*. The honest
  answer to "how do my friends join?", in tiers of increasing exposure: the LAN address
  plainly; "direct" keeping a DNS record on the owner's own domain pointed at the home
  IP with SRV for the port and UPnP as an explicit opt-in; "tunnel" via playit.gg or a
  self-owned VPS relay, no ports opened and the home IP hidden. Exposure stays a
  deliberate user decision; this screen's whole job is making it an informed one, with
  whitelist and online-mode nudged on at the moment anything goes public.

## Reach

- **Distribution.** Screenshots in the README, a winget manifest, a public landing.
  People cannot want a tool they cannot find.
- **macOS.** Signed, notarized builds for Apple Silicon (Intel Macs are not supported) with native
  scheduling, automatic backups, performance metrics, managed MySQL, and automatic update feeds.
- **Linux.** Ships as a `.deb` and an `.rpm`, for x64 and arm64, with the same panel and CLI: scheduling and automatic
  backups through systemd user timers, performance metrics from `/proc`, managed MySQL (x64) and
  Redis (x64 and arm64), and automatic updates. Every preview installs the package on Ubuntu 24.04
  and opens it with the sandbox on. Managed MySQL is x64 only; Oracle
  publishes no small arm64 build. For a server with no desktop there is `spawnloft-cli`: the command
  line alone (the Rust `spawnloft-core`, with no Node; in 1.x it carried its own), as a `.deb` and an `.rpm`, installed and run in clean Ubuntu 22.04, Debian 12,
  Rocky 9 and Fedora containers by every build. Still to come: an AppImage - which needs libfuse2, meets Ubuntu's AppArmor sandbox restriction, and mounts at a new path on
  every launch, so its scheduler shims have to go through `$APPIMAGE` before it can ship.
- Localization.
