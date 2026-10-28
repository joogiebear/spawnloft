# Client fixtures

- `versions/<id>.json`: Mojang's own version JSONs, one per era, as published (not trimmed).
  Fetched 2026-10-28 from the PrismLauncher mirror
  (`raw.githubusercontent.com/PrismLauncher/meta-upstream/master/mojang/versions/<id>.json`),
  which keeps Mojang's files unchanged; the 1.5.2, 1.7.10, 1.12.2 and 1.17.1 files are
  byte-identical to the ones fetched earlier for the Log4Shell fix. The mirror's `1.18.1` is
  stale (it still names log4j 2.14.1), so it is not used.
- `version_manifest_eras.json`: Mojang's `version_manifest_v2.json` from the same mirror, cut
  down to the era ids plus the odd id shapes (`1.21.11-rc3`, `25w46a`, `3D Shareware v1.34`,
  `1.RV-Pre1`, `1.14.2 Pre-Release 4`).
- `1.21.11.json` (top level): a trimmed 1.21.11 with a made-up old-style natives row, used by the
  tests that pin the natives arch rules. `versions/1.21.11.json` is the real one.
- `fabric-profile.json`: Fabric's own profile for loader 0.19.5 on 1.21.11.
  `fabric-profile-26.3.json` and `fabric-profile-1.14.4.json` are made from it by changing the
  id, `inheritsFrom` and the intermediary coordinate, which are the only parts of a Fabric profile
  that depend on the game version (meta.fabricmc.net could not be reached from where these were
  made).
- `fabric-game-versions.json`: synthetic, in the shape of Fabric's `/v2/versions/game` list
  (`{ version, stable }`, newest first), holding the era ids Fabric builds for (1.14 on) and the
  spaced `1.14.2 Pre-Release 4`; nothing before 1.14.
- `future.json`: synthetic. `26.4-snapshot-6` turned into `27.1` with one of each thing SpawnLoft
  cannot know: `minimumLauncherVersion` 22, a `${render_backend}` game argument, a rule with an
  `os.kernel` key, an osx rule with a `versionRange`, natives under `${natives_directory}/native/libs`,
  and an asset index (`assets/future-pack.json`) with a `layout` flag.
- `assets/`: synthetic asset indexes with three entries each, one per layout Mojang has used:
  `objects.json` (no flag), `legacy.json` (`virtual: true`, the 1.6.1 to 1.7.2 index),
  `pre-1.6.json` (`map_to_resources: true`), plus `bad.json` (a `../x` entry) and
  `future-pack.json`. The flags match Mojang's files; the entries and hashes are made up.

`../client-fixtures.mjs` loads all of these and lists the seven OS/arch pairs. It imports the
client code, so a test sets `MCCTL_DATA_ROOT` before it imports the loader.

A test file that removes its scratch folder in `after()` does every top-level `await` before its
first `test()`: an await between tests lets the tests above it finish, and `after()` runs, before
the tests below it are registered, which then run against a folder that is gone.
