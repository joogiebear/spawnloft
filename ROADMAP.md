# Roadmap

## Scope

SpawnLoft serves one person on their own machine (Windows, macOS or Linux) running servers for friends, family or plugin testing, with no accounts, no cloud, no Docker, and nothing exposed to a network without a deliberate decision. Features serving that person are listed. Features that turn SpawnLoft into a smaller Pterodactyl (multi-node, user accounts, a remote web panel) are declined on purpose.

| Declined | Reason |
| --- | --- |
| Remote web panel, `--host` binding | The panel has no login; a reachable panel is a reachable server console. Remote into the machine instead. |
| User accounts, multi-node | Hosting-panel scope. |
| Docker or cloud hosting | Contradicts the local-machine premise. |
| Writing database credentials into plugin configs | Plugin configs stay manual; the former `db apply` command was removed. |
| Deleting servers or credentials through MCP | Not offered to AI assistants. |

## Shipped

| Feature | Version | Summary |
| --- | --- | --- |
| Reliability | 0.6 line | Crash auto-restart with a crash-loop stop (three crashes in ten minutes), scheduled restarts that warn players first, Discord webhook notifications, and `verify` to prove snapshots restore. |
| Plugin manager | 0.6 line | **Plugins** tool and `plugins` command: Modrinth search and install filtered to compatible builds, hash-based update check, one-click update after a plugins snapshot, enable and disable by renaming in place. Manages only what it installed; hand-added and premium plugins are never hashed to anyone. |
| Server updates | 0.6 line | `upgrade` and **Server software** in **Settings**: one-click newest build with the old jar kept as the way back, and a confirmed, snapshot-first path for crossing Minecraft versions because worlds migrate one way. |
| Hangar as a second plugin source | 0.6.2 | Searched beside Modrinth with the source named on every result, sha256-verified installs, version-name update checks against the provenance record. External-download projects are linked, and a sparse version claim is offered with the mismatch stated. |
| Modded servers | 0.6.x | Fabric and NeoForge as first-class loaders with a **Mods** tool, **From a modpack** in **Add a server**, pack updates that touch only what the old pack owned, and the server's version treated as a preference: a mismatched build installs with the author's version claim stated. |
| Form controls | 0.6.6 | Carved fields, owned select chevron, drawn radios, troughed switches; the wizard matches the panel. |
| Worlds | 0.7.0 | **Worlds** tool and `worlds`: list with the active world named, import from zip or folder, export as zip, switch, delete. Also a backup mirror (every snapshot copied to a second location, deletions following) and a scheduled `verify` action whose failures reach the webhook. |
| Log intelligence | 0.8.0 | `src/diagnose.mjs` recognises known failures (port taken, EULA, wrong Java, out of memory or disk, missing dependencies, duplicate plugins, corrupt worlds, ticking crashes, watchdog stalls, missing jars) and states the fix in the panel strip, on a failed `start`, in `why`, and in the crash webhook. Minecraft crash reports are surfaced with their description line. |
| AI assistants | 1.3.0 | `spawnloft mcp`: status, logs, diagnostics, TPS, backups, plugins and server updates for an assistant the owner chooses. Credentials and player IPs stay out of every result. Restore, kill and cross-version upgrades are offered only with `--allow-destructive`. **Settings** shows the install's exact configuration. Plugin installs snapshot first, in the panel too. |
| Panel redesign, config editing through MCP | 1.4.0 | Console stays on screen beside a tool dock, per-server overview with **Needs attention**, settings as one form, database backups of their own, update checks for Purpur, Folia and Advanced Slime Paper, and `list_config_files`, `read_config_file` and `write_config_file` for AI assistants. |
| macOS | Pre-1.0 betas | Developer ID signed and notarized Apple Silicon and Intel builds with native scheduling, automatic backups, performance metrics, managed MySQL and automatic update feeds. |
| Linux | Pre-1.0 betas | `.deb` and `.rpm` for x64 and arm64: systemd user-timer scheduling, `/proc` metrics, managed MySQL (x64) and Redis, automatic updates, and `spawnloft-cli` for machines with no desktop. |

## Planned

### Share screen (after 1.0)

Tabled 2026-09-01 at the owner's call, likely post-1.0. It answers "how do my friends join?" in tiers of increasing exposure:

| Tier | Mechanism |
| --- | --- |
| LAN | The LAN address, stated plainly. |
| Direct | A DNS record on the owner's own domain pointed at the home IP, with an SRV record for the port and UPnP as an explicit opt-in. |
| Tunnel | playit.gg or a self-owned VPS relay: no ports opened, home IP hidden. |

Exposure stays a deliberate decision; the screen's job is making it an informed one, with whitelist and `online-mode` nudged on at the moment anything goes public.

### Reach

| Item | Status |
| --- | --- |
| Distribution | Screenshots in the README, a winget manifest, a public landing page. |
| macOS | Installed upgrade verification gates subsequent signed betas before 1.0. |
| Linux AppImage | Blocked: needs `libfuse2`, meets Ubuntu's AppArmor sandbox restriction, and mounts at a new path on every launch, so its scheduler shims must go through `$APPIMAGE` first. |
| Managed MySQL on Linux arm64 | Not offered; Oracle publishes no small arm64 build. Redis is available. |
| Localization | Planned. |
| Local JAR deployment, required-plugin readiness checks, automatic `PATH` setup | Planned CLI additions. |
