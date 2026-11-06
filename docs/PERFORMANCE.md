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

Taken on 2026-11-06 from 1.6.0-beta.407 (the installed desktop app on the desktop, the
`spawnloft-cli` package on its bundled Node 24 on the test VM), before the first fix landed. It
is the "before" for the whole pass. Medians; p90 is in the result files.

- Desktop: Windows 11, Ryzen 9 9950X3D, 32 GB, NVMe SSD, Defender on.
- Test VM: Linux, 4 vCPU, 16 GB, virtio disk on an SSD pool.
- Panel plugins case: 200 jars (37 real plugins and 163 library jars). Panel files case: 20,000
  files in `world/region`.
- Backup world: a pregenerated world of 9.3 GB in 3,093 files (99% region files), the same on
  both machines. On the test VM the mirror folder is on the same disk.
- Memory: Paper 26.2 on Java 25 with a 1 GB heap; 2 servers on the desktop and 5 on the test VM,
  30 minutes after start.
- Not taken: the console pane on the test VM (no desktop), the hand-timed app launch, and the
  Mac mini.

| Metric | Machine | Build | Before | After | Shipped in |
|---|---|---|---|---|---|
| M1 bare runtime (`-e 0`) | Desktop | 1.6.0-beta.407 | 34 ms | | |
| M1 `--help` / `list` / `status`, 0 servers | Desktop | 1.6.0-beta.407 | 123 / 122 / 123 ms (3.6x bare) | | |
| M1 `list`, 10 servers | Desktop | 1.6.0-beta.407 | 127 ms | | |
| M1 `mcp`, stdin closed | Desktop | 1.6.0-beta.407 | 132 ms | | |
| M1 bare runtime (`-e 0`) | Test VM | 1.6.0-beta.407 | 13 ms | | |
| M1 `--help` / `list` / `status`, 0 servers | Test VM | 1.6.0-beta.407 | 61 / 64 / 64 ms (4.6x bare) | | |
| M1 `list`, 10 servers | Test VM | 1.6.0-beta.407 | 66 ms | | |
| M1 `mcp`, stdin closed | Test VM | 1.6.0-beta.407 | 65 ms | | |
| M2 `/api/instances`, 10 servers, 3 running | Desktop | 1.6.0-beta.407 | 1.3 ms | | |
| M2 `/api/instances`, 10 servers, 3 running | Test VM | 1.6.0-beta.407 | 0.7 ms | | |
| M2 plugins list, 200 jars (every request) | Desktop | 1.6.0-beta.407 | 78 ms | | |
| M2 plugins list, 200 jars (every request) | Test VM | 1.6.0-beta.407 | 43 ms | | |
| M2 files, `world/region` with 20,000 files | Desktop | 1.6.0-beta.407 | 557 ms | | |
| M2 files, `world/region` with 20,000 files | Test VM | 1.6.0-beta.407 | 280 ms | | |
| M2 `/api/databases`, dead external host | Desktop | 1.6.0-beta.407 | 21.1 s | | |
| M2 `/api/databases`, dead external host | Test VM | 1.6.0-beta.407 | 60.0 s (the client timeout) | | |
| M2 seconds with a stall ≥ 50 ms, 10 servers, 3 running | Desktop | 1.6.0-beta.407 | 25 | | |
| M2 seconds with a stall ≥ 50 ms, 10 servers, 3 running | Test VM | 1.6.0-beta.407 | 13 | | |
| M2 "Lost contact" under mixed load | Both | 1.6.0-beta.407 | no (but no 4 s poll finished in 60 s on the test VM) | | |
| M3 console, per 1,000 lines with 5,000 held, no filter | Desktop | 1.6.0-beta.407 | 76.0 s (37 long tasks, longest batch of 50 4.4 s) | | |
| M3 console, per 1,000 lines with 5,000 held, filter on | Desktop | 1.6.0-beta.407 | 0.49 s (2 long tasks) | | |
| M4 backup, server stopped: wall / archiver CPU | Desktop | 1.6.0-beta.407 | 119 s / 114 s | | |
| M4 backup, server stopped: wall / archiver CPU | Test VM | 1.6.0-beta.407 | 129 s / 132 s | | |
| M4 backup, server running idle: wall | Desktop / Test VM | 1.6.0-beta.407 | 116 s / 129 s | | |
| M4 backup with a mirror folder: wall | Desktop / Test VM | 1.6.0-beta.407 | 127 s / 139 s | | |
| M4 archive size (from 10.0 GB) | Both | 1.6.0-beta.407 | 6.8 GB | | |
| M4 verify / restore | Desktop | 1.6.0-beta.407 | 13.7 s / 31.9 s | | |
| M4 verify / restore | Test VM | 1.6.0-beta.407 | 34.6 s / 69.1 s | | |
| M4 panel during a panel backup: stalls ≥ 50 ms / peak RSS | Desktop / Test VM | 1.6.0-beta.407 | 0 / 65 MB, 0 / 82 MB | | |
| M5 SpawnLoft per running server (daemon + helpers), +30 min | Desktop | 1.6.0-beta.407 | 127 MB (daemon 55 MB, vitals sampler 73 MB) | | |
| M5 SpawnLoft per running server (daemon), +30 min | Test VM | 1.6.0-beta.407 | 20 MB private (62 MB RSS) | | |
| M5 SpawnLoft total vs JVMs, +30 min | Desktop, 2 servers | 1.6.0-beta.407 | 255 MB vs 2.8 GB | | |
| M5 SpawnLoft total vs JVMs, +30 min | Test VM, 5 servers | 1.6.0-beta.407 | 98 MB vs 7.0 GB | | |
| M6 `start` to launched / to ready (fake JVM) | Desktop | 1.6.0-beta.407 | 227 ms / 638 ms | | |
| M6 `start` to launched / to ready (fake JVM) | Test VM | 1.6.0-beta.407 | 100 ms / 619 ms | | |
| M7 panel spawn to listening, 10 servers | Desktop / Test VM | 1.6.0-beta.407 | 143 ms / 67 ms | | |

## Rerunning

See [tools/perf/README.md](../tools/perf/README.md) for every option. The short version:

```sh
node tools/perf/cli-start.mjs --data-root <empty folder> --machine <class> --commit <beta> --out <results folder>
node tools/perf/compare.mjs <before.json> <after.json>
```
