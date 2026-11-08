# The rename from mcctl to SpawnLoft

SpawnLoft is the product and the command. Names people see (docs, help text, messages, the package
names) say `spawnloft`. Names that other software, old installs or stored data depend on were
**not** changed, or are read under both spellings. This table lists every old name, the new one, and
whether the old one ever stops working.

| Old name | New name | Does the old one stop working? |
| --- | --- | --- |
| `mcctl` command (`mcctl`, `mcctl.cmd` shims) | `spawnloft` | No. Both are written next to each other and stay. |
| `mcctl.mjs` (the CLI entry file) | `spawnloft.mjs` forwards to it | No. Task shims, server launchers and MCP configs that users wrote name `mcctl.mjs`, so it stays as the entry file. |
| npm package `mcctl`, `mcctl-desktop` | `spawnloft`, `spawnloft-desktop` | Package names only; the `mcctl` bin entry is kept beside `spawnloft`. |
| `MCCTL_DATA_ROOT` | `SPAWNLOFT_DATA_ROOT` | No. `SPAWNLOFT_*` is read first, `MCCTL_*` second, for good. New launchd plists write `SPAWNLOFT_DATA_ROOT`; old plists keep setting `MCCTL_DATA_ROOT`. |
| `MCCTL_FAKE_CLIENT`, `MCCTL_RESTART_DELAY_MS`, `MCCTL_RCON_TIMEOUT_MS`, `MCCTL_FLUSH_TIMEOUT_MS` | `SPAWNLOFT_` + the same suffix | No, same rule. |
| `MCCTL_CORE` (desktop: development core directory) | `SPAWNLOFT_CORE_DIR` | No. |
| Settings file `<config>/mcctl/settings.json` | `<config>/spawnloft/settings.json` | No. New installs write `spawnloft/`; an install that has only `mcctl/settings.json` keeps reading and writing it there. If both exist, `spawnloft/` wins and `spawnloft doctor` names the other. |
| Default data folder `<LOCALAPPDATA or XDG_DATA_HOME>/mcctl` | `.../spawnloft` | No. A machine that already has the `mcctl` folder (and no `spawnloft` one) keeps using it; `spawnloft data move` relocates it. A data root chosen in settings is never touched. |
| Console line prefix `[mcctl]` | `[spawnloft]` | The panel still colours old `[mcctl]` lines in existing console logs. |
| IPC channels `mcctl:*` and `window.mcctlDesktop` (desktop shell and panel) | `spawnloft:*`, `window.spawnloftDesktop` | Internal; shell and panel ship together. |
| Task Scheduler folder `mcctl` | unchanged | Never renamed: every lookup and `uninstall` use it. |
| launchd labels `io.github.joogiebear.mcctl.*` | unchanged | Never renamed. They follow the bundle id. |
| App id and bundle id `io.github.joogiebear.mcctl` | unchanged | Never renamed: updates and installs are found by it. |
| `BAN_SOURCE` `mcctl` in Minecraft ban files, `source: mcctl` sent to mclo.gs | unchanged | Values other software already stored. |
| Record files `.mcctl-pack.json`, `.mcctl-plugins.json`, `.mcctl-import-*` in server folders | unchanged | They are data in people's server folders. |
| Panel preferences saved in the browser under `mcctl.*` keys | unchanged | Renaming would reset them. |
| Control pipe `\\.\pipe\mcctl-<name>` | unchanged | Changes once, later, with the protocol version. |
| Code-signing account and profile names | unchanged | Azure resource names. |
| `mcctl-site` repository | unchanged | The repository keeps its name. |
