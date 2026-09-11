## SpawnLoft desktop development preview

Separate Windows and Mac installers, built from the same development commit with the
same version. The release is published only after Windows x64, Apple Silicon, and Intel
Mac packages all pass their native checks. Each release is immutable and numbered.

### Fixes to try

- **Performance now works on Apple Silicon and Intel Mac:** live server CPU and resident
  memory, ten-second samples, selectable history ranges, and history retained after stopping.
  CPU uses the same share-of-all-cores scale as Windows. Each server restart begins a fresh graph.
- Console output strips ANSI escape sequences into clean, searchable plain text while
  keeping warning and error indicators.
- Long lines scroll horizontally by default. Turn on **Wrap** whenever you prefer.
- Backup history refreshes every four seconds while visible and when reopened, including
  backups made with the CLI. Refreshes preserve backup scope and unsaved schedule edits.
- Snapshots appear only after their archive and manifest are complete. Concurrent backups
  get separate names, and failed archives never appear as completed backups.
- **Settings → Appearance** offers both Classic and SpawnLoft themes.

### Windows

Download **SpawnLoft-Setup-VERSION.exe**. Windows beta installations continue to receive
beta updates automatically; stable installations stay on the stable release. Both
`beta.yml` and `latest.yml` describe the Windows installer on this prerelease.

Like the previous Windows development beta, this GitHub Actions test build is unsigned.
SmartScreen may warn during manual installation: **More info → Run anyway**. Signed
production builds use the existing Azure signing profile on the release machine.

### Mac

- **Apple Silicon (M-series):** download the `mac-arm64.dmg` asset.
- **Intel:** download the `mac-x64.dmg` asset.
- Requires **macOS 13 Ventura or later** and a Java version suitable for your server.

Quit SpawnLoft, open the DMG, and drag SpawnLoft to Applications to replace the previous
preview. Your application data lives outside the app. Mac updates are manual for now.

The Mac app is ad-hoc signed for testing and **not Apple-notarized**. If macOS blocks its
first launch, try opening it once, then use **System Settings → Privacy & Security →
Open Anyway**. If it instead reports a damaged app, report the exact message.

Scheduled tasks, automatic backups, and automatic installation
of managed MariaDB/Garnet engines are still unavailable on Mac. Manual backups and
connections to an existing external database are available. Windows retains its existing
capabilities; a shared fix lands in both packages, with platform differences explicit.

### Toward 1.0

Keep testing setup, both themes, server creation, start/stop/restart, console commands,
backup/restore, and upgrading an existing installation on both platforms. Any remaining
Mac limitations must be implemented or explicitly scoped before calling 1.0 ready.
An Apple Developer membership and Developer ID signing/notarization are the next
distribution milestone before public Mac release and native Mac automatic updates.

This is a development prerelease, not SpawnLoft 1.0.
