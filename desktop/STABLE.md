SpawnLoft 1.1 adds Linux. Windows, macOS and Linux are now one release, built from one commit.

- **Windows 10/11 x64:** download `SpawnLoft-Setup-1.1.0.exe`, signed through Microsoft Azure Artifact Signing.
- **Mac with Apple Silicon:** download `SpawnLoft-1.1.0-mac-arm64.dmg`.
- **Mac with Intel:** download `SpawnLoft-1.1.0-mac-x64.dmg`.
- Both Mac builds are Developer ID signed, hardened, Apple-notarized and stapled. The app requires macOS 13 or later; managed MySQL requires macOS 15 or later.
- **Linux x64 (Ubuntu 22.04+, Debian 12+):** download `SpawnLoft-1.1.0-linux-amd64.deb` and install it with `sudo apt install ./SpawnLoft-1.1.0-linux-amd64.deb`. Java is separate, as on every platform: `sudo apt install openjdk-25-jre-headless`.

Existing Windows and Mac installs receive 1.1 through the built-in updater. ZIP files are used by the Mac updater; choose the DMG for a manual installation.

## New in 1.1: Linux

- The same panel and the same CLI. `spawnloft-desktop` opens the window; `spawnloft` is the command line, and needs no Node.
- On a server with no desktop, run `spawnloft ui --no-open` and reach the panel through an SSH tunnel (`ssh -L 8770:127.0.0.1:8770 you@server`). It listens on loopback only.
- Schedules and automatic backups run through systemd user timers. **They run while you are logged in.** Turn on *Keep running after logout* in the Backups or Scheduler tab if they should outlive your session - on a server you disconnect from, that is the difference between a nightly backup and none.
- Managed **MySQL** on x64 and **Redis** on x64 and arm64. MySQL needs libaio, libnuma and ncurses, which a stock server does not have: SpawnLoft fetches your distribution's own packages with `apt-get download` and unpacks them beside the engine, without sudo and without installing anything on the system. Off Debian and Ubuntu it tells you the command to run instead.
- `spawnloft doctor` and the panel warn when RCON is reachable from the internet: a public address, no firewall to be seen. Minecraft cannot bind RCON separately from the game port.
- Linux has no code signing to check. The package is verified by the hash in the update feed.
- Not yet: an `.rpm`, an arm64 package, or an AppImage.

## Fixed for everyone

- Two servers under a very long data folder path could share one control channel, so stopping one stopped the other. Seen on Linux; the same code ran on macOS.
- A force kill now takes whatever the server had started with it, rather than leaving it running and holding the port (macOS and Linux; Windows already did).
- `task list` shows the next run in local time on macOS and Linux. It showed UTC.

Plugin configuration remains manual. SpawnLoft does not insert database credentials into plugin configuration files.


## Release build procedure

Maintainers build from the same clean `main` commit. Dispatch `desktop-stable` to build, sign, notarize and exercise both native Mac apps, including an installed beta-to-stable upgrade, and to build the Linux package, install it with apt on Ubuntu 24.04 and exercise the installed app. On the existing Windows Azure signing machine, run `npm run release` in `desktop`, verify the packaged app, run `smoke-desktop.cjs`, then run `node desktop/stable-artifacts.mjs win32 x64` from the repository root.

Collect the Windows manifest and its listed files alongside all three successful `desktop-stable-*` workflow artifacts in `desktop/dist/stable-release`. Run `node desktop/publish-stable.mjs desktop/dist/stable-release RUN_ID`. Publication checks all package bytes, Windows Authenticode, matching clean source commits, the successful native Mac and Linux workflow, and the uploaded GitHub digests before exposing the complete release. Both beta and stable feeds are included so existing installations can move to stable.
