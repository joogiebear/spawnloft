# R1 contract fixtures

What the per-server daemon and the files around it promise, written down once so a second
implementation (the Rust daemon on `v2`) can be held to exactly what the Node code does. Plan:
PLAN-RUST-TAURI.md section 3 item 2 and section 12 (P0-A).

| File | Contract | Written by | Read by |
| --- | --- | --- | --- |
| `control-protocol.json` | the control channel: transport, the four ops, every reply | `src/daemon.mjs` | `src/control.mjs`, `src/supervisor.mjs` |
| `state.json` | `run/<name>/state.json` in every situation, and the status each reads as | `src/daemon.mjs` | `src/control.mjs` `readState` |
| `metrics.json` | `run/<name>/metrics.log` lines | `src/metrics.mjs` (in the daemon) | `readSamples`, `latestSample` |
| `activity.json` | `activity.jsonl` entries, actor kinds, every action name | `src/activity.mjs` (everyone; the daemon writes `crash`) | `readActivity`, the panel |
| `webhook.json` | the crash/recovery webhook request and every daemon message | `src/notify.mjs`, `src/daemon.mjs` | Discord or any http(s) endpoint |
| `instances.json` | the registry, every field the code has written, servers and databases | `src/registry.mjs` and its callers | the daemon (unlocked), everyone |
| `schedules.json` | scheduled task definitions, every action, step and schedule kind | `src/schedule.mjs`, `src/task-steps.mjs` | `spawnloft task run` |
| `panel-auth.json` | who may call the panel's HTTP API: the sign-in tokens, and the answer to whole requests in order | `tools/make-panel-auth-fixture.mjs` | `src/panel-auth.mjs` (the Node panel) and `rust/crates/spawnloft-lib/src/panel_auth.rs` (`spawnloft-core ui`), which must agree |

Shapes are written in the small language described at the top of `shape.mjs`, which also checks
them. Examples are concrete values; the tests substitute live pids and paths where needed.

## The tests

- `test/contracts.test.mjs` holds each fixture against the Node functions that write and read the
  file (`sampleLine`, `readSamples`, `record`, `formatDiscord`, `readState`, the registry, the
  schedule normalisers) and scans the source for new state fields, control replies (by their field
  set and error text), activity actions and webhook message sites. The scans read one-line
  literals in top-level `src/*.mjs`: an action passed in a variable or a reply built over several
  lines is not seen, so keep to that style or extend the scan.
- `test/contracts-daemon.test.mjs` runs a real daemon with the fake java and fake Garnet and checks
  every control case marked `"asserted": "live"`, the exact field set of `state.json` in each
  situation, the webhook posts and crash entries, and a daemon run on the fullest registry record.
  It runs under whichever daemon `SPAWNLOFT_DAEMON` picks; `rust-internal.yml` runs it under both.
  Cases marked `"asserted": "source"` need a real engine failure or a race to reach and are checked
  against `src/daemon.mjs` instead.

`panel-auth.json` is different in kind: it is not a file format but a rule two listeners apply,
and it is generated (its tokens carry real HMACs, made with test keys and `node:crypto` alone).
`test/panel-auth.test.mjs` and the `panel_auth` tests under `cargo test` run every token and
every request in it; a request the two sides would answer differently is a hole in one of them.
Design: `rust/PANEL-AUTH-DESIGN.md`.

## Changing a contract

A failing contract test means the code and the fixture disagree. If the change is intended, update
the fixture in the same commit and say in the commit message that it changes a contract, because
the Rust daemon (and any reader of these files) has to follow. A new control op, a changed reply or
a changed pipe name is a protocol change: it also needs the protocol version in `ping` raised.
Readers must accept fields they do not know; writers must not drop fields the fixture lists.

Known quirk kept on purpose: a stop or kill during the restart delay replies `code: null` and leaves
`exitCode: null` in the state, not the crash's code (see `control-protocol.json`).

Not covered here (step 2 of the plan): CLI `--json` output and panel routes; `tasks.log` and the
task shims; `console.log` text beyond the daemon's own lines.
