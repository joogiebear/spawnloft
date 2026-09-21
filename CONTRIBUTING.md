# Contributing

Thanks for wanting to improve SpawnLoft. A few things worth knowing before you start —
they will save you time.

## What SpawnLoft is, and is not

SpawnLoft runs Minecraft servers on one person's Windows machine: no accounts, no cloud,
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

Two long-lived branches:

- **`dev`** is where work lands. Base pull requests on it and target it.
- **`main`** is what was last released. It moves only when `dev` is merged into it to
  cut a release, so checking out `main` always gives you the code behind the installer
  people have.

The desktop app updates itself from GitHub releases, not from branches, so nothing on
either branch reaches anyone until a release is published. `dev` is where a change
gets built and tried by hand first; the release is the gate.

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

Production releases are built, signed and published by the maintainer from a machine
holding the signing profile, from `main` after `dev` has been merged into it. Development
previews build Windows and Mac installers in CI as described below. To try a local build, run
`npx electron-builder --publish never` in `desktop/` on `dev` and install the result
by hand; it never touches GitHub.

### Betas

The `desktop-preview` workflow builds the same `dev` commit natively on Windows x64,
Apple Silicon, and Intel Mac. Relevant pushes to `dev` publish a new numbered beta only
after all three packages pass core tests, bundle verification, and the shared packaged
smoke checks. Pull requests run the same checks without publishing. Windows updater
compatibility is tested with the installed updater library too.

Every package uses the source version's base plus `-beta.N`; N is the workflow run number
plus one, avoiding the existing beta.1. Manifests record the source version, actual package
version, commit, platform, architecture, and checksums. The publisher verifies all three
manifests and Windows updater feeds, uploads everything to one draft, then publishes it
as a prerelease. It refuses mixed commits, missing packages, and conflicting existing tags.
Keep fixes in shared code when they apply to both platforms. Platform-specific behavior
must stay explicit and covered on its native runner.

Windows test installers are unsigned, as in the previous dev-build workflow. Windows
auto-update keeps its existing behavior: a stable
install asks GitHub for the latest release, which leaves pre-releases out, so nobody on
0.9.1 is offered a beta. An install that is itself a beta accepts newer betas and newer
stable releases alike, so it follows each beta and then moves to the stable release when
that is published. Install the first beta by hand; the rest arrive through the app.
Mac previews update manually until Developer ID signing and notarization are ready.
See [the desktop preview guide](desktop/PREVIEW.md) for installation and Mac limitations.
