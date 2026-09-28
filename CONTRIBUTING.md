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

- **Zero runtime dependencies.** The core is plain Node (>= 20) and ships nothing from
  npm. If a feature seems to need a package, it probably needs a smaller feature —
  the zip reader, the YAML-lite and the TOML-lite in `src/plugins.mjs` exist for
  exactly this reason.
- **No build step.** The panel is served from source; the wizard is loaded from disk.
- **Honesty over polish.** Errors name what went wrong and the way out. Nothing is
  silently capped, silently skipped, or silently retried.
- **Comments carry the why.** The codebase documents its reasoning next to the code —
  read a file's comments before reshaping it, and keep yours in the same voice.

## Working on it

```
git clone https://github.com/joogiebear/spawnloft
cd mcctl
npm test                 # node:test, no dependencies, ~a second
node mcctl.mjs ui --no-open --port 8771    # the panel, from source
```

Tests live in `test/` and run on every push and pull request, on Windows and on
Linux. Both count: each platform has a scheduler, a control channel and a process table of
its own, and code that only runs there. New behaviour that has a pure core should come with tests for
it; the existing files show the shape.

One rule that is easy to break without noticing: **nothing synchronous and slow on the
panel's request path.** The panel is one Node process, so a `spawnSync`, a
`readdirSync` walk of a world, or anything else that holds the event loop holds every
request and the console stream with it, and shows up for the person as the panel
hesitating. Use `execFile`/`spawn` and `fs.promises` there; `run/panel.log` records
every time the loop was held for more than a quarter of a second, so a regression is
visible.

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

The `desktop-preview` workflow builds the same `dev` commit natively on Windows x64, Apple
Silicon, Intel Mac, Linux x64 and Linux arm64. It publishes one numbered beta only after all five
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
