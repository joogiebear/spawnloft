# Performance

How fast SpawnLoft is on real machines, how that is measured, and what each change bought. The
scripts live in [tools/perf](../tools/perf/README.md); this page keeps the method and the headline
numbers. Raw result files are kept outside the repo.

## Method

- One script per metric, the same script before and after, the same machines, the same inputs.
- Medians and p90 over several fresh runs, never a single run. A change under 10% is reported as
  "no change": these are desktops and VMs, not quiet lab machines.
- Numbers come from published builds (a dev beta, or a pull request's build artifacts), not from a
  source checkout on a system Node, which is a different runtime.
- Everything runs against a bench data root with copied or synthetic servers. Live servers are
  never benchmarked. On Windows, Defender's real-time scanning stays on: it is part of what users get.
- No benchmark number is checked in CI; CI only runs the scripts' self-tests.

## Reference machines

| Machine | OS | Stands for | Build under test |
|---|---|---|---|
| Desktop | Windows 11 | the typical user: the desktop app | the dev beta installer |
| Test VM | Linux | headless and Linux users | the `spawnloft-cli` package (bundled Node 24) and `spawnloft ui` |
| Mac mini (optional) | macOS, Apple Silicon | Mac desktop users | the dev beta DMG |

Results always name the machine class, never a host name.

## Metrics

| | Metric | Script | Target after the pass |
|---|---|---|---|
| M1 | CLI start: `--help`, `list`, `status`, `mcp` | `cli-start.mjs` | `--help` within 2x and the others within 3x of the bare runtime on the same machine |
| M2 | Panel response per route, event-loop stalls, mixed load | `panel-latency.mjs` | `/api/instances` p95 ≤ 30 ms with 10 servers; `/api/databases` ≤ 50 ms with a dead external host once the first probe settled; 200-plugin list ≤ 150 ms cold, ≤ 10 ms warm; no stall ≥ 250 ms; no "Lost contact" |
| M3 | Console pane: time per 1,000 lines with 5,000 held | `console-bench.cjs` | ≥ 10x less with a filter on; no long task over 50 ms from console input at 200 lines/s |
| M4 | Backup of a real multi-GB world: wall, CPU, size, verify, restore | `backup-bench.mjs` | gzip CPU ≤ 40% of baseline; size ≤ 110%; SHA-256 in the manifest; restore no slower; no panel stall ≥ 250 ms during a panel backup |
| M5 | Memory per running server (daemon + helpers; JVM for context) | `memory.mjs` | none until the baseline exists |
| M6 | Daemon start: `start` to launched, and to ready | `cli-start.mjs` | reported |
| M7 | Panel first load: spawn to listening, first `GET /` | `panel-latency.mjs` (plus a hand-timed desktop launch) | reported |

## Baseline

Not taken yet. It is taken once, on the desktop and the test VM, from the current dev beta and
CLI package, before the first fix lands, and is the "before" for the whole pass.

| Metric | Machine | Build | Before | After | Shipped in |
|---|---|---|---|---|---|
| | | | | | |

## Rerunning

See [tools/perf/README.md](../tools/perf/README.md) for every option. The short version:

```sh
node tools/perf/cli-start.mjs --data-root <empty folder> --machine <class> --commit <beta> --out <results folder>
node tools/perf/compare.mjs <before.json> <after.json>
```
