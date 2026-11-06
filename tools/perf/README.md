# tools/perf: measurement scripts

Scripts for the performance pass. Each one measures one thing the same way before and after a
change, writes the numbers as JSON, and prints a Markdown table. The results, the reference
machines and the headline table are in [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md).

None of this ships: `tools/` is outside the desktop package's file list. The scripts use only Node's
own modules (Node 22 or later; the CLI package's bundled Node 24 works too).

| Script | Metric | What it does |
|---|---|---|
| `cli-start.mjs` | M1, M6 | times `--help`, `list`, `status` and `mcp` (stdin closed) in fresh processes, beside the bare runtime; then `start` to "launched" and to ready on a fake JVM |
| `panel-latency.mjs` | M2, M7 | starts `spawnloft ui` on bench fixtures (0, 3 and 10 servers, 0 to 3 running) and times each panel route; counts event-loop stalls; dead external database host; mixed load (the 4 s poll while a console streams 200 lines/s) |
| `console-bench.cjs` | M3 | drives the panel page in the desktop app over the DevTools protocol: 5,000 lines, then 2,000 timed through the page's own `pushLine()` (and `flushConsole()` once per batch of 50, where the panel has it), without and with a search filter |
| `backup-bench.mjs` | M4 | copies a real world into a bench server and times `backup`, `verify` and `restore`, with the archiver's CPU; mirror case; the same backup started from the panel (panel RSS, stalls, latency during it) |
| `memory.mjs` | M5 | samples each running server's daemon, its helper processes (the Windows vitals sampler) and its JVM: private/PSS where the OS gives it, RSS everywhere |
| `compare.mjs` | | before/after table from two result files of the same metric |

## Safety

- **Bench data roots only.** Every script except `compare.mjs` needs `--data-root <folder>` (or
  `MCCTL_DATA_ROOT`) and refuses a folder that is not empty unless these scripts made it (they
  leave a `.spawnloft-perf-bench` file). The default data root, the data root, servers folder and
  backups folder named in your settings, your home folder and the checkout are always refused.
- **Settings stay out of it.** Each CLI and panel process gets `XDG_CONFIG_HOME` (and `APPDATA` on
  Windows) pointed inside the bench root, so your real settings (a backups folder elsewhere, a
  mirror) are never read or written.
- **Real worlds are copied, never touched.** `backup-bench.mjs --world` only reads the folder you
  give it, and refuses one with a `session.lock` touched in the last five minutes (a live world).
- `memory.mjs --live-root <data root>` is the one way to look at real servers: it reads their state
  files and samples their processes, and starts, stops and writes nothing.
- Never point any of this at a server you care about being slow for a while. On the project's
  machines: never mc-test.
- The bench root is emptied at the end unless `--keep`.

## Running them

From a checkout, against the checkout's own core:

```sh
node tools/perf/cli-start.mjs --data-root ~/perf/bench --machine desktop --out ~/perf/results
```

Against an installed package, as the plan's baseline wants (section 2.4):

```sh
# Windows desktop app, through the shim users have on PATH (<install> is where SpawnLoft is installed)
node tools\perf\cli-start.mjs --cli "<install>\resources\bin\spawnloft.cmd" --runtime "<install>\SpawnLoft.exe" --electron --data-root S:\perf\bench --machine desktop

# the spawnloft-cli package on Linux (its own Node 24)
node tools/perf/cli-start.mjs --cli /opt/spawnloft-cli/core/mcctl.mjs --runtime /opt/spawnloft-cli/bin/node --data-root ~/perf/bench --machine vm
```

(With the `.cmd` shim, `--runtime` is only used for the bare-runtime floor.) Common options on every script: `--machine`, `--commit`
(the beta version under test), `--disk`, `--note` (e.g. "Defender on"), `--out`, `--keep`. Each has
`--help`.

Per script:

```sh
node tools/perf/panel-latency.mjs --data-root <dir> --external-db --db-tools <folder with the mysql client> --plugins-from <folder of 200 jars>
node tools/perf/backup-bench.mjs --data-root <dir> --world <copy of a real world> --mirror <folder on another drive> \
     --server-jar <paper.jar> --java <java>     # the last two enable the "running" case
node tools/perf/memory.mjs --data-root <dir> --start 3 --jar <paper.jar> --java <java> --at 60,1800
node tools/perf/memory.mjs --live-root <real data root> --panel-pid <pid>   # read-only
node tools/perf/console-bench.cjs --app <path to SpawnLoft.exe> --data-root <dir>   # close SpawnLoft first
node tools/perf/compare.mjs before.json after.json
```

`--db-tools` matters on Linux: the core looks for a MySQL/MariaDB client only in its own engines
folder there (Windows and macOS also find XAMPP, Program Files and Homebrew installs). Without one
the dead-host probe fails at once and measures nothing; the result row then says so.

`console-bench.cjs` starts the app itself with `--remote-debugging-port`, so the running copy has to
be closed first (the app allows one). It gives the app the bench settings (with the bench data
root saved, so the app skips its first-run setup) and its own `--user-data-dir`, so the real
app's window size, zoom and update channel are left alone. `--checkout` runs `desktop/`'s Electron instead of an
installed app; `--browser <chrome>` serves the panel from the checkout and opens it in a headless
Chrome or Chromium, for a Linux box without a desktop (that number is Chromium's, not the app's).

## Output

Each run writes `perf-<metric>-<machine>-<commit>-<date>.json` to `--out` (default
`./perf-results`): an `environment` block (OS, CPU, RAM, runtime, commit, Defender state on
Windows) and `results`, one row per case with `median`, `p90` and the raw extras. Medians and p90
only; never a single run. The raw files for the pass are kept outside the repo, under the
project's `perf-2026-11/<machine>/` folder; `docs/PERFORMANCE.md` keeps only the headline table.

## The panel's stall log: `SPAWNLOFT_PERF_LOG_MS`

The panel logs `event loop held for <n>ms` to `run/panel.log` when its event loop is blocked for
250 ms or more. `SPAWNLOFT_PERF_LOG_MS=<ms>` (a whole number from 1 to 60000) lowers that
threshold for a measurement run; `panel-latency.mjs` and `backup-bench.mjs` set it to 50 on the
panel they start and count the lines. Unset, empty or unusable values keep 250. It changes only
which stalls are logged, nothing else.

## Self-tests

`node tools/perf/<script> --self-test` runs a script against a throwaway fixture in a temp folder
(a fake JVM for running servers, a small synthetic world) and checks its result file's shape.
`test/perf-tools.test.mjs` runs all of them, so `npm test` and CI (Windows and Linux) keep them
working. No benchmark number is asserted anywhere: hosted runners are too noisy.
`console-bench.cjs --self-test` checks its in-page benchmark against a stub page; the DevTools path
itself needs the app, so it is run by hand (or with `--browser` where Chromium is installed).

## Caveats

- CPU per process comes from sampling the process tree (every 200 ms on Linux and macOS, every
  second on Windows, where each sample is a PowerShell call). A child that exits between samples
  loses what it used since its last sample; on a backup that takes minutes that is under 1%.
- On Linux the backup bench's total CPU is exact (the CPU this script collects from the finished
  process tree); the per-process split, and every figure on Windows and macOS, is sampled.
- "Stalls" counts the seconds in which the panel's event loop was held at least the threshold
  (its watcher reports the worst delay once a second), not individual stalls.
- The live-world check is a guard, not a proof: Minecraft writes `session.lock` when it starts, so
  besides its age the script tries to read it (a running server holds it locked on Windows) and,
  on Linux, looks for a process working in the folder. Stop the server or copy the world first.
- macOS gives RSS only (no cheap private/proportional figure).
- The fake JVM has no RCON, so the panel's `players` route there times a refused RCON connection.
- The fake JVM makes "running" servers cheap and instant. That is the point for panel latency and
  daemon start (SpawnLoft's own cost); memory and backup-while-running numbers want a real Paper jar.
