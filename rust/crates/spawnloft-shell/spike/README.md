# Tauri spike test scripts (P0-F, internal)

Run by the `tauri-spike` job of `.github/workflows/rust-internal.yml` on `windows-latest`, and by
hand on Victor's PC for the signed runs. Results go to `PHASE0-FINDINGS.md`.

| Script | What it does |
| --- | --- |
| `spike-config.mjs` | Writes the `--config` overlay for one spike build: version, the core and Node core as resources, the updater key, updater artifacts on |
| `handover.ps1` | Installs a signed 1.6 beta, gives it a server and a scheduled task, installs the spike over it the way electron-updater does (`--updated /S --force-run`), checks folder, keys, shortcuts and that the task still runs, then uninstalls |
| `update-cycle.ps1` | Serves a Tauri updater feed on 127.0.0.1, refuses a feed whose signature does not match, then updates spike-a to spike-b through the plugin and checks the result |
| `measure.cjs` | Start time to a loaded panel and memory of the process tree, for the Tauri shell and for the installed 1.6 Electron app |

The spike builds use a throwaway minisign key made in the job and a plain-HTTP loopback feed
(`dangerousInsecureTransportProtocol`, spike config only). Neither is how a release would be
signed or served.
