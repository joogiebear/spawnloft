## Mac rolling preview

Mac previews roll forward from the theme-changer development codebase on `dev`
after both architectures pass tests. GitHub locks published releases, so each build
gets a new `0.15.0-mac.N` prerelease rather than replacing an existing download.
The build's exact source is recorded below and in Settings → About. The custom Mac
channel is ignored by Windows beta updaters; the Windows beta and stable releases
are unchanged. Mac previews update manually: quit SpawnLoft and replace the app
with the newest Mac preview on the repository's Releases page. Your data lives
outside the application.

- **Apple Silicon (M1/M2/M3/M4 and later):** download the `mac-arm64.dmg` asset.
- **Intel:** download the `mac-x64.dmg` asset.
- Requires **macOS 13 Ventura or later** and a Java version suitable for your server.

Open the DMG and drag SpawnLoft to Applications. This preview is ad-hoc signed for
testing and **not Apple-notarized**. macOS may block its first launch. After trying
to open it, use System Settings → Privacy & Security → Open Anyway. Do not disable
Gatekeeper globally. If macOS reports a damaged app rather than offering Open Anyway,
send the exact message so we can diagnose that build.

Try setup, **Settings → Appearance** (Classic and SpawnLoft), creating and starting
a server, console commands, stopping/restarting, and a manual backup/restore.

Scheduled tasks, automatic backups, performance sampling, and automatic installation
of managed MariaDB/Garnet engines are not available in this first Mac preview.
Manual backups and connections to an existing external database remain available.
This is a development preview, not a stable Mac release.
