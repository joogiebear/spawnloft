SpawnLoft 1.0 brings Windows and macOS together in one stable release.

- **Windows 10/11 x64:** download `SpawnLoft-Setup-1.0.0.exe`, signed through Microsoft Azure Artifact Signing.
- **Mac with Apple Silicon:** download `SpawnLoft-1.0.0-mac-arm64.dmg`.
- **Mac with Intel:** download `SpawnLoft-1.0.0-mac-x64.dmg`.
- Both Mac builds are Developer ID signed, hardened, Apple-notarized and stapled. The app requires macOS 13 or later; managed MySQL requires macOS 15 or later.
- Linux desktop downloads are coming soon.

Existing Windows stable and current Windows/Mac beta installs receive 1.0 through the built-in updater. ZIP files are used by the Mac updater; choose the DMG for a manual installation.

## Included in 1.0

- Original and SpawnLoft themes, live performance metrics, schedules and automatic backups on Windows and Mac.
- Managed **MySQL and Redis** on both platforms. Redis uses Microsoft Garnet with its private bundled .NET runtime. MariaDB is no longer offered for new services.
- CLI JSON output, metrics streaming and CSV export, readiness checks, and safe local plugin JAR deployment with rollback copies.
- Clean console output, easier scanning of long lines, and backup history that refreshes after CLI-created backups.
- `spawnloft` and `mcctl` terminal launchers.

Plugin configuration remains manual. SpawnLoft does not insert database credentials into plugin configuration files.


## Release build procedure

Maintainers build from the same clean `main` commit. Dispatch `desktop-stable` to build, sign, notarize and exercise both native Mac apps, including an installed beta-to-stable upgrade. On the existing Windows Azure signing machine, run `npm run release` in `desktop`, verify the packaged app, run `smoke-desktop.cjs`, then run `node desktop/stable-artifacts.mjs win32 x64` from the repository root.

Collect the Windows manifest and its listed files alongside both successful `desktop-stable-*` workflow artifacts in `desktop/dist/stable-release`. Run `node desktop/publish-stable.mjs desktop/dist/stable-release RUN_ID`. Publication checks all package bytes, Windows Authenticode, matching clean source commits, the successful native Mac workflow, and the uploaded GitHub digests before exposing the complete release. Both beta and stable feeds are included so existing installations can move to stable.
