# Contributing

Thanks for wanting to improve SpawnLoft. A few things worth knowing before you start —
they will save you time.

## What SpawnLoft is, and is not

SpawnLoft runs Minecraft servers on one person's own machine - Windows, macOS or Linux: no accounts, no cloud,
no Docker, and nothing exposed to a network without a deliberate decision. Features
that push it toward being a hosting panel — multi-node, user accounts, a remote web
UI — are out of scope on purpose. [ROADMAP.md](ROADMAP.md) says what is planned and
what has been deliberately declined; reading it first beats building something that
cannot be merged.

## Ground rules

- **Few dependencies, all pinned.** The core is Rust (`rust/`), built with `--locked` and checked
  by `cargo deny`; no Node runs in it or ships with it. If a feature seems to need a new crate, it
  probably needs a smaller feature — the zip reader and the YAML-lite and TOML-lite in
  `spawnloft-lib` exist for exactly this reason. Node.js is a tool for the tests and the release
  scripts, and for test players on a user's machine (`BOTS.md`).
- **No build step for the pages.** The panel, the launcher and the wizard are single HTML files in
  `src/`, compiled into the binary as they are.
- **Honesty over polish.** Errors name what went wrong and the way out. Nothing is
  silently capped, silently skipped, or silently retried.
- **Comments say why, not what.** Write one when a line is the way it is for a reason the code
  can't show: a race, an OS quirk, a protocol detail, a trap in the ordering. Leave out what the
  code already says. If it takes a paragraph to explain what a function does, change the function.

## Working on it

```
git clone https://github.com/joogiebear/spawnloft
cd spawnloft/rust
cargo build -p spawnloft-core --features test-hooks    # the core, with the hooks the tests use
cargo test --workspace --locked                         # the Rust tests
cd ..
node tools/run-tests.mjs                                # the black-box tests (Node 22+), against that build
node tools/parity/run.mjs                               # the parity rig, below
rust/target/debug/spawnloft-core ui --no-open --port 8771    # the panel, from source
```

Before a pull request, from `rust/`: `cargo fmt --all --check`, `cargo clippy --workspace
--all-targets --locked -- -D warnings` and `cargo deny check` too (see `rust/README.md`).

`node tools/run-tests.mjs` (`npm test` runs the same) lists the test files in `test/` itself and
runs them under `node --test`; extra arguments go through, e.g. `node tools/run-tests.mjs --test-name-pattern=client`. To run one file, use `node --test test/<file>`. The tests drive the
built `spawnloft-core`: `SPAWNLOFT_CORE_BIN` names it, else the newest build under `rust/target`; a
test that needs it is skipped, with the command that builds it, when there is none. `MCCTL_FAKE_CLIENT` (a stand-in game for the client tests) is honoured only by a `test-hooks` build; it is not a user setting.

**The parity rig** (`tools/parity/`, `tools/parity/README.md`) runs scenarios, each a list of
command lines or panel and MCP requests with fake download hosts, on the Rust core and compares
every output, exit code, request and file left behind with a record frozen per platform in
`tools/parity/frozen/` (made from the Node core before it left in 2.0). A change to a record is a
change to what a person sees, made on purpose: re-record it with `--record` on each platform and
say why in the pull request.

Tests live in `test/` and `rust/`, and run on every push and pull request, on Windows, macOS and
Linux. All count: each platform has a scheduler, a control channel and a process table of
its own, and code that only runs there. New behaviour that has a pure core should come with tests for
it; the existing files show the shape.

One rule that is easy to break without noticing: **nothing slow while the panel's request
threads hold something shared.** The panel serves each request on its own thread, so a
long walk of a world or a blocking call under a lock holds the other requests and the console
stream behind it, and shows up for the person as the panel hesitating. Do slow work on its own thread or
as a job, and keep locks short.

## Where things go

- A bug: [an issue](https://github.com/joogiebear/spawnloft/issues/new?template=bug_report.md),
  ideally through the app's **Feedback → Something broke**, which fills in the diagnostics.
- A question: [Q&A](https://github.com/joogiebear/spawnloft/discussions/categories/q-a) in
  Discussions, so the answer stays findable.
- An idea: [Ideas](https://github.com/joogiebear/spawnloft/discussions/categories/ideas). Say what
  you were trying to do, not only what to add.

## Branches

Two long-lived branches, and the version number says which is which:

- **`dev`** is next month's release. It carries a prerelease version (`1.3.0-beta.1`), and
  **every merge into it publishes a beta**: CI builds all five native packages, opens each one
  and runs the same smoke test against it, and releases them together to everyone on the beta
  channel. So `dev` is not a scratch branch. Nothing is committed to it directly.
- **`main`** is this month's release. It moves only when a release branch is merged into it,
  so checking out `main` always gives you the code behind the installer people have.

Work happens on a branch off `dev` - `feature/*` or `fix/*` - and reaches `dev` by pull request.
A pull request into `dev` runs the same five builds and smoke tests as a merge does, without
publishing anything, which is where a broken package is meant to be found. Merge when the change
is ready for beta users: a lower bar than ready for everyone, but they are real people with real
servers.

## Pull requests

- Every commit message starts with a conventional type prefix (`feat:`, `fix:`,
  `docs:`, …), imperative mood, lowercase subject. Name a commit for the reason it
  exists, not its largest diff.
- One reason per PR. Small and focused merges fast; sprawling sits.
- CI must be green on both runners before anything merges into `main`; branch
  protection enforces that. Outside contributions are reviewed by the maintainer
  before they merge, as etiquette rather than a rule the repository enforces, so
  that the maintainer's own release merges do not need a second account to approve
  them.
- Outside contributions are squash-merged, so one PR is one commit on `dev`. A release
  PR from `dev` to `main` is merged with a merge commit, never squashed: squashing
  rewrites `dev`'s history into one commit, and `main` then has to be merged back into
  `dev` after every release just to reconcile the two.
- By contributing you agree your work is licensed under the repository's
  [MIT license](LICENSE).

## Credit

Every release names the people who made it. GitHub appends a list of the merged pull
requests since the last release, each with its author, plus a "New Contributors" line
for anyone whose first change it is - that is automatic, from the pull request itself,
so a merged PR is a credit. The hand-written notes above that list name people too
when a feature is theirs. Label a PR `enhancement` or `bug` and it lands in the right
section; unlabelled ones go under "Everything else".

## Releases

**The rhythm is a month.** Work merges into `dev` as it is finished and goes out as betas. In the
last week only fixes merge, so the beta that becomes the release has been used. Then one stable
release, which every installed copy picks up through the updater. A minor version a month
(`1.2.0`, `1.3.0`); a patch (`1.2.1`) for something in a stable release that cannot wait, cut the
same way from a `fix/*` that has been through `dev` first.

**Write the release notes as you go.** [`desktop/STABLE.md`](desktop/STABLE.md) is published
verbatim as the text of the stable release. A pull request that changes what someone would notice
adds its line there, under the version it will ship in. Release day is then a read-through, not a
reconstruction from a month of commit messages.

### Betas

> **The 2.0 line (`v2`) retires this pipeline.** `desktop-preview` and `desktop-stable` are
> removed on `v2` so that merging it into `dev` cannot publish an Electron build to 1.6 beta
> users. 2.x betas are published only from the Tauri release workflow, on Victor's confirmation.
> What follows describes 1.x as it still runs on `dev` and `main`.

The `desktop-preview` workflow builds the same `dev` commit natively on Windows x64, Apple
Silicon Mac, Linux x64 and Linux arm64. It publishes one numbered beta only after all four
pass core tests, bundle verification and the packaged-app smoke checks; on Linux the `.deb` is
installed with apt on Ubuntu 24.04 and the installed app is what gets opened, and the `.rpm` is
installed with dnf in a Fedora container. It is all or nothing: one platform failing holds back the
rest. A red job is not always the code - GitHub's download servers fail now and then, and a
re-run of the failed job is the answer when the log says 504.

Every package uses the source version's base plus `-beta.N`, where N is the workflow run number
plus one. Manifests record the source version, package version, commit, platform, architecture
and checksums. The publisher verifies every manifest and updater feed, uploads everything to one
draft, then publishes it as a prerelease. It refuses mixed commits, missing packages and
conflicting existing tags. Keep fixes in shared code when they apply to more than one platform;
platform-specific behaviour must stay explicit and covered on its native runner.

A stable install asks GitHub for the latest release, which leaves pre-releases out, so nobody on a
stable version is offered a beta. An install that is itself a beta accepts newer betas and newer
stable releases alike, so it follows each beta and then moves to the stable release when that is
published. Install the first beta by hand; the rest arrive through the app. See
[the desktop preview guide](desktop/PREVIEW.md) for installation on each platform.

### Release day

1. Branch `release/X.Y` off `dev`. `node desktop/set-version.mjs X.Y.0` sets the version in the
   three places it is written. Read `desktop/STABLE.md` once more. Pull request to `main`; it
   needs `test` and `test-linux` green and every review thread resolved. Merge with a merge commit.
2. On the Windows signing machine, on `main`: `npm run release:stable` in `desktop/`. It starts
   the `desktop-stable` workflow (both Macs signed and notarized, both Linux architectures built,
   installed and exercised), builds and signs Windows, runs the smoke test, waits for CI, collects
   every platform into one folder and verifies them together. Then it stops.
3. `npm run release:stable -- --publish` makes it public. That is a separate step on purpose: a
   stable release reaches every installed copy and cannot be recalled.
4. It prints what is left: fast-forward `dev` to `main`, and delete the month's beta pre-releases
   once the update has been seen to arrive.

**Then start the next month.** After a release `dev` sits at a stable version, where the beta
pipeline switches itself off and says nothing. The first branch of the month runs
`node desktop/set-version.mjs X.(Y+1).0-beta.1`, and CI refuses a pull request into `dev` that
does not carry a prerelease version, so it cannot be forgotten - which it once was, for a whole
release.

To try a local build, run `npx electron-builder --publish never` in `desktop/` and install the
result by hand; it never touches GitHub.
