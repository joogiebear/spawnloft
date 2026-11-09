# SpawnLoft 2.x updater keys

How the 2.x updater signs and verifies releases (rust/INSTALLER-UPDATER-DESIGN.md §5.3–§5.4).

One minisign key pair signs **both** the update artifacts (installer, macOS updater tarball) and
the feed envelope `spawnloft-updates.json`. Tauri's updater keys are minisign keys, so the same
key and the same `TAURI_SIGNING_PRIVATE_KEY` secret cover everything. A second, pre-generated
"next" key ships in every build for rotation without a flag day.

## The keys

Generated on Victor's Windows signing machine on 2026-11-09 with `tauri signer generate`
(password-protected). The private halves never leave that machine (kept in his password manager);
only the public halves are in the repository and compiled into the binaries.

| Role | Key id | Public key line (minisign) |
| --- | --- | --- |
| release (current) | `1D6FA7724F159315` | `RWQVkxVPcqdvHbvBfjZVJEFH+NZIDDnnOEzIFpjLDcgnbP0ex5p7+VJd` |
| next (rotation) | `FABC42A3EFD78DF4` | `RWT0jdfvo0K8+m+bIp/B0qgqssh1oaByYs30Vjtilc6fzKHiyBkwnTeI` |

Both are compiled into `spawnloft-core` and the shell as the trusted list, so a client accepts an
envelope signed by either and hands the plugin the one the envelope's `keyId` names. The release
key is also baked into `rust/crates/spawnloft-shell/tauri.conf.json` (`plugins.updater.pubkey`) as
the plugin's own verification key.

`release.pub` (the current release key's public file, minisign format) lives beside the shell at
`rust/crates/spawnloft-shell/release.pub`; the release scripts and the gate read it from there.

## The GitHub secrets (Victor's hands)

The release workflow signs with the private key from two repository secrets, scoped like the Azure
and Apple credentials to the release workflows (`dev` and `main`), never exposed to pull requests
or to the `v2` internal and dry-run jobs:

- `TAURI_SIGNING_PRIVATE_KEY` — the contents of the release `.key` file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password.

As of 2026-11-09 these are **not yet set**. Until they are, the dry-run workflow
(`.github/workflows/release.yml`) generates a throwaway key per run and signs with it, so the
pipeline is exercised end to end without the real key. The envelope a throwaway run produces is
refused by real clients (wrong key id), which is the point.

## Rotation

To move to the "next" key:

1. Build and sign a release with `FABC42A3EFD78DF4` (set `TAURI_SIGNING_PRIVATE_KEY` to the next
   private key), keeping both keys in the compiled trusted list, and generate and seal a new
   "next" pair whose public half joins the list.
2. Two releases later, drop the retired key from the list.

A client always carries the full current list, so no revocation feed is needed — a key is retired
simply by shipping a build without it (the model `src/client-harness-index.mjs` already uses).

## What signs what, and when

- `tauri build` signs the installer and the macOS updater tarball during the build, with their
  **raw** bundle names in the trusted comment.
- The release pipeline (`desktop/release-feed.mjs`) renames each artifact to its release name and
  **re-signs** it on that name (`tauri signer sign --app-version <v>`), because the client binds a
  signature to the file it names (`file:` in the trusted comment); it then writes and signs
  `spawnloft-updates.json`.
- `desktop/release-gate.mjs` re-verifies every signature against `release.pub` before anything is
  published, so a release never ships a signature its own clients would refuse.
