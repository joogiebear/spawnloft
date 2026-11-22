# Client fixtures

- `versions/<id>.json`: Mojang's own version JSONs, one per era, as published (not trimmed).
  Fetched 2026-10-28 from the PrismLauncher mirror
  (`raw.githubusercontent.com/PrismLauncher/meta-upstream/master/mojang/versions/<id>.json`),
  which keeps Mojang's files unchanged; the 1.5.2, 1.7.10, 1.12.2 and 1.17.1 files are
  byte-identical to the ones fetched earlier for the Log4Shell fix. The mirror's `1.18.1` is
  stale (it still names log4j 2.14.1), so it is not used.
- `1.21.11.json` (top level): a trimmed 1.21.11 with a made-up old-style natives row. The parity
  scenarios copy it into a data folder, and spawnloft-lib's `client/library.rs` tests read it.
  `versions/1.21.11.json` is the real one.
- `fabric-profile.json`: Fabric's own profile for loader 0.19.5 on 1.21.11.
- `future.json`: synthetic. `26.4-snapshot-6` turned into `27.1` with one of each thing SpawnLoft
  cannot know: `minimumLauncherVersion` 22, a `${render_backend}` game argument, a rule with an
  `os.kernel` key, an osx rule with a `versionRange`, natives under `${natives_directory}/native/libs`,
  and an asset index with a `layout` flag.

`versions/`, `1.21.11.json`, `future.json` and `fabric-profile.json` are what spawnloft-lib's
`client/library.rs` `meta_dump` test (ignored by default) resolves for every OS and arch.

## Mod loaders (`loaders/`)

Captured by the `loader-fixtures` Actions job (`tools/capture-loader-fixtures.mjs`), since the
loaders' hosts cannot be reached from where the launcher code is written. The job uploads them as
its `loader-fixtures` artifact (no workflow writes to the repository), and they are committed from
there. Not edited, except that the per-version loader lists (`quilt/loader-<mc>.json`,
`fabric/loader-<mc>.json`) keep only each row's `loader` part, in the order served (Quilt's is
not newest first), as the script does: re-run the job to change them. `loaders/manifest.json` lists every file with its source URL and
sha1, and when it was captured.

- `forge/<forge version>/`: per pinned Forge installer, `install_profile.json` and (from the modern
  format on) `version.json` as they are inside the jar, and `installer.json`: the jar's sha1, the
  sha1 the maven publishes beside it, and its entry list (names and sizes; the jar itself is not
  kept). Pinned: 1.7.10, 1.12.2 (14.23.0.2486, the legacy format, and 14.23.5.2864, the modern
  one), 1.16.5, 1.18.2, 1.20.1, 1.21.1, 26.3. `forge/maven-metadata.json` and
  `forge/promotions_slim.json` are Forge's version lists.
- `neoforge/<version>/`: the same for NeoForge 20.4.253, 21.1.266 and 26.3.0.103;
  `neoforge/versions.json` is the maven's versions list.
- `quilt/`: Quilt meta's game and loader lists, the loader list and profile for Quilt Loader
  0.30.2 on 1.20.1 and 26.3, and `sidecars-*.json`: per profile library, the `.sha1` file its maven
  publishes (Quilt's rows carry no checksum).
- `fabric/`: Fabric meta's real game list and the loader lists for 1.21.11 and 26.3.
