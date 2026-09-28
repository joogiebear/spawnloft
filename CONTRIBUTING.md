# Contributing

## Scope

SpawnLoft runs Minecraft servers on one person's own machine (Windows, macOS or Linux) with no accounts, no cloud, no Docker, and nothing exposed to a network without a deliberate decision. Features that push it toward a hosting panel (multi-node, user accounts, a remote web UI) are out of scope. [ROADMAP.md](ROADMAP.md) lists what is planned and what was declined; read it before building something that cannot be merged.

## Ground rules

| Rule | Detail |
| --- | --- |
| Zero runtime dependencies | The core is plain Node 20 or later and ships nothing from npm. The zip reader, YAML-lite and TOML-lite in `src/zip.mjs` and `src/plugins.mjs` exist for this reason. When a feature seems to need a package, it probably needs a smaller feature. |
| No build step | The panel is served from `src/ui.html`; the setup wizard is `desktop/setup.html`, loaded from disk. |
| Honesty over polish | Errors name what went wrong and the way out. Nothing is silently capped, skipped or retried. |
| Comments carry the why | Reasoning is documented beside the code. Read a file's comments before reshaping it and keep yours in the same voice. |
| Nothing synchronous and slow on the panel's request path | The panel is one Node process. A `spawnSync`, or a `readdirSync` walk of a world, holds every request and the console stream. Use `execFile`, `spawn` and `fs.promises`. `run/panel.log` records every event-loop stall longer than 250 ms, so regressions are visible. |
| Never expose the panel | No `--host` flag, no non-loopback binding. The panel has no login. |
| Plugin configs stay manual | Database creation never writes plugin configuration files. |

## Development setup

```sh
git clone https://github.com/joogiebear/spawnloft
cd spawnloft
npm test                                       # node:test, no dependencies, runs in seconds
node spawnloft.mjs ui --no-open --port 8771    # the panel, from source
```

`node spawnloft.mjs` and `node mcctl.mjs` are equivalent entry points.

| Command | Purpose |
| --- | --- |
| `npm test` | Runs `node --test "test/*.test.mjs"`. |
| `cd desktop && npm install && npm start` | Desktop app with the bundled core. |
| `cd desktop && npm start -- --core ..` | Desktop app against this checkout (or set `MCCTL_CORE`). |
| `cd desktop && npm test` | Window-state and update-channel tests. |
| `cd desktop && npm run pack` | Build; `afterPack` fails the build when the result is wrong. |
| `cd desktop && npm run verify` | Re-check an existing build. |

Tests use `MCCTL_DATA_ROOT` to keep the registry, run directory and daemons in a scratch folder, and fixtures under `test/fixtures/` (a fake Java, MariaDB and Garnet) so lifecycle tests run real daemons without real servers. New behavior with a pure core should ship with tests for it; existing files show the shape.

CI runs on every push and pull request:

| Job | Runner | Purpose |
| --- | --- | --- |
| `version-policy` | Ubuntu | Checks that the version fits the target branch. A pull request into `dev` must carry a prerelease version. |
| `test` | `windows-latest` | Test suite and CLI smoke check. |
| `test-linux` | `ubuntu-latest` | Test suite, CLI smoke check, and tests on the runtime the packages carry. |

Both platforms count: each has its own scheduler, control channel and process table, and code that runs only there.

## Reporting and discussing

| Kind | Where |
| --- | --- |
| Bug | [Issue](https://github.com/joogiebear/spawnloft/issues/new?template=bug_report.md), ideally through **Feedback → Something broke** in the app, which fills in diagnostics. |
| Question | [Q&A discussions](https://github.com/joogiebear/spawnloft/discussions/categories/q-a), so the answer stays findable. |
| Idea | [Ideas discussions](https://github.com/joogiebear/spawnloft/discussions/categories/ideas). Say what you were trying to do, not only what to add. |

## Branches

| Branch | Role | Rules |
| --- | --- | --- |
| `dev` | Next month's release. Carries a prerelease version such as `1.3.0-beta.1`. | Never committed to directly. Every merge publishes a beta to everyone on the beta channel. |
| `main` | This month's release. | Moves only when a release branch merges into it, so a checkout always matches the shipped installer. |
| `feature/*`, `fix/*` | Working branches off `dev`. | Reach `dev` by pull request. A pull request into `dev` runs the same builds and smoke tests as a merge, without publishing. |

Merge into `dev` when the change is ready for beta users: a lower bar than ready for everyone, but they are real people with real servers.

## Pull requests

| Requirement | Detail |
| --- | --- |
| Commit messages | Conventional type prefix (`feat:`, `fix:`, `docs:`, and so on), imperative mood, lowercase subject. Name a commit for the reason it exists, not its largest diff. |
| Scope | One reason per pull request. |
| Template | Fill in **What this changes, and why**, **How it was verified**, and the checklist: `npm test` passes, conventional prefixes, no runtime dependencies or build step added. |
| CI | Green on both runners before anything merges into `main`; branch protection enforces it. |
| Review | The maintainer reviews outside contributions before merge (`.github/CODEOWNERS`), as etiquette rather than an enforced rule, so the maintainer's own release merges need no second account. |
| Merge method | Outside contributions are squash-merged: one pull request, one commit on `dev`. The `dev` to `main` release pull request is merged with a merge commit, never squashed, because squashing rewrites `dev` into one commit and forces `main` to be merged back after every release. |
| License | Contributions are licensed under the repository's [MIT license](LICENSE). |

## Credit

Every release names its contributors. GitHub appends each merged pull request with its author and a **New Contributors** line for first-time authors, from `.github/release.yml`. Hand-written notes name people when a feature is theirs.

| Label | Release section |
| --- | --- |
| `enhancement`, `feature` | New |
| `bug`, `fix` | Fixed |
| anything else | Everything else |
| `release` | Excluded |

## Releases

The cadence is monthly. Work merges into `dev` as it finishes and ships as betas. In the last week only fixes merge, so the beta that becomes the release has been used. One stable release follows, which every installed copy receives through the updater. Versions: a minor per month (`1.2.0`, `1.3.0`); a patch (`1.2.1`) for something in a stable release that cannot wait, cut from a `fix/*` branch that has been through `dev` first.

### Release notes

[`desktop/STABLE.md`](desktop/STABLE.md) is published verbatim as the text of the stable release, and [`desktop/PREVIEW.md`](desktop/PREVIEW.md) as the text of each beta (`renderPreviewNotes` fills its `MAC_DISTRIBUTION` block). A pull request that changes what a person would notice adds its line to `STABLE.md` under the version it ships in, so release day is a read-through rather than a reconstruction.

### Betas

The `desktop-preview` workflow builds the same `dev` commit natively:

| Package | Runner and checks |
| --- | --- |
| Windows x64 | Native build and packaged-app smoke test |
| macOS Apple Silicon | Native build, packaged-app smoke test, signed when `MAC_SIGNING_ENABLED` is `true` |
| macOS Intel | As above |
| Linux x64, arm64 | `.deb` installed with apt on Ubuntu 24.04 and the installed app opened; `.rpm` installed with dnf in a Fedora container |
| `spawnloft-cli` (Linux) | Installed and run in clean Ubuntu 22.04, Debian 12, Rocky 9 and Fedora containers |

A beta publishes only after every package passes core tests, bundle verification and the packaged-app smoke checks; one failing platform holds back the rest. A red job is not always the code: GitHub's download servers fail occasionally, and when the log says 504, re-running the failed job is the answer.

Every package version is the source version's base plus `-beta.N`, where `N` is the workflow run number plus one. Manifests record source version, package version, commit, platform, architecture and checksums. The publisher verifies every manifest and updater feed, uploads everything to one draft, then publishes it as a prerelease. It refuses mixed commits, missing packages and conflicting existing tags. Keep fixes in shared code when they apply to more than one platform; platform-specific behavior must stay explicit and covered on its native runner.

| Installed version | Update behavior |
| --- | --- |
| Stable | Asks GitHub for the latest release, which excludes prereleases: never offered a beta. |
| Beta | Accepts newer betas and newer stable releases, and moves to stable when it publishes. |

Install the first beta by hand; later ones arrive through the app. See [`desktop/PREVIEW.md`](desktop/PREVIEW.md) for per-platform installation.

### Release day

1. Branch `release/X.Y` off `dev`. Run `node desktop/set-version.mjs X.Y.0`, which sets the version in the three places it is written. Read `desktop/STABLE.md` once more. Open a pull request to `main`; it needs `test` and `test-linux` green and every review thread resolved. Merge with a merge commit.
2. On the Windows signing machine, on `main`, run `npm run release:stable` in `desktop/`. It starts the `desktop-stable` workflow (both Macs signed and notarized, both Linux architectures built, installed and exercised), builds and signs Windows, runs the smoke test, waits for CI, collects every platform into `desktop/dist/stable-release` and verifies them together. Then it stops.
3. Run `npm run release:stable -- --publish`. It is separate on purpose: a stable release reaches every installed copy and cannot be recalled. Before making the release public it checks every package's bytes against its manifest, the Windows Authenticode signature, that all packages were built from the same clean commit, the successful native workflow, and the uploaded GitHub digests. Anything it cannot vouch for stays a draft.
4. It then prints what remains: fast-forward `dev` to `main`, and delete the month's beta prereleases once the update has been seen to arrive.

Publication is separate from upload because both half-states are failures. An early release went live with its blockmap uploaded and its 111 MB installer not, and clients checking for updates got a 404. A draft left unpublished looks released on GitHub while `electron-updater` cannot see it.

### Starting the next month

After a release, `dev` sits at a stable version, where the beta pipeline switches itself off silently. Begin the month with `node desktop/set-version.mjs X.(Y+1).0-beta.1`. CI refuses a pull request into `dev` that lacks a prerelease version.

### Local builds

```sh
cd desktop
npx electron-builder --publish never
```

Install the result by hand; it never touches GitHub.

### Signing

| Platform | Mechanism | Details |
| --- | --- | --- |
| Windows | Azure Artifact Signing (formerly Trusted Signing), configured under `win.azureSignOptions` | Needs the .NET SDK (not only the runtime), `az login --tenant <id>` (MFA is enforced for Azure Resource Manager, so a bare `az login` fails), and the **Artifact Signing Certificate Profile Signer** role, which subscription Owner and identity validation do not include. Certificates live about three days and rotate, so every signature is timestamped; `npm run verify` fails on a missing timestamp. |
| macOS | Developer ID Application certificate with hardened runtime and notarization | See [desktop/MAC-SIGNING.md](desktop/MAC-SIGNING.md). |
| Linux | None | Packages are verified by the hash in the update feed. |

`afterPack` and `npm run verify` check things that have failed silently before: the app icon reaching the executable, the core copied into `resources`, a file added to `desktop/` but missing from the `files` allowlist, and a missing, invalid or untimestamped signature.
