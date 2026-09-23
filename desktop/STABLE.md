<!-- This file is published, as it stands, as the text of the next stable release.
     A pull request that changes something a person would notice adds its line here, under the
     version it will ship in, so that release day is a read-through. Rewrite the top for each
     release; the build procedure at the bottom stays. -->
SpawnLoft 1.3 lets an AI assistant you choose check on and run your servers.

- **Windows 10/11 x64:** download `SpawnLoft-Setup-1.3.0.exe`, signed through Microsoft Azure Artifact Signing.
- **Mac with Apple Silicon:** download `SpawnLoft-1.3.0-mac-arm64.dmg`.
- **Mac with Intel:** download `SpawnLoft-1.3.0-mac-x64.dmg`.
- Both Mac builds are Developer ID signed, hardened, Apple-notarized and stapled. The app requires macOS 13 or later; managed MySQL requires macOS 15 or later.
- **Linux, Debian and Ubuntu (22.04+, Debian 12+):** `SpawnLoft-1.3.0-linux-amd64.deb`, or `-linux-arm64.deb` on arm64. Install with `sudo apt install ./<file>`.
- **Linux, Fedora, RHEL-family and openSUSE:** `SpawnLoft-1.3.0-linux-x86_64.rpm`, or `-linux-aarch64.rpm` on arm64. Install with `sudo dnf install ./<file>`.
- Java is separate on every platform, and which one depends on your Minecraft version. On Debian and Ubuntu: `sudo apt install openjdk-25-jre-headless`. On Fedora the newest is `sudo dnf install java-latest-openjdk-headless`.

Existing installs receive 1.3 through the built-in updater. ZIP files are used by the Mac updater; choose the DMG for a manual installation. A Linux install updates through a system password prompt, and takes the package of its own kind.

## New in 1.3

- **AI assistants.** `spawnloft mcp` lets Claude Desktop, Claude Code, or any app that speaks the Model Context Protocol start and stop your servers, read their consoles, find out why one crashed, check TPS, take backups, install and update plugins and update Paper. You choose the app and add SpawnLoft to it; Settings, under AI assistants, shows the exact configuration for your install. No account, no open port, and nothing is sent unless that app asks. What the tools return - console lines, player names, plugin lists - goes to the app's provider; passwords and webhooks never do, and players' IP addresses are hidden unless you turn that on. Restoring a backup, force-kill and Minecraft version upgrades are offered only if you allow them, and each waits to be confirmed. Deleting a server is never offered. See [MCP.md](https://github.com/joogiebear/spawnloft/blob/main/MCP.md).
- **Installing a plugin takes a snapshot first**, as updating one already did, so a plugin that turns out to be the wrong one can be rolled back from the Backups tab.

## Fixed

- On Windows, the Backups tab could stay blank for several seconds while SpawnLoft asked Task Scheduler about automatic backups. Your backups and "Back up now" now appear at once, and the automatic-backup settings fill in when Windows answers.
- On Windows, the app could stop responding for a few seconds while setting up a MySQL or Redis database, as the engine was moved into place. It now stays responsive throughout.
- Plugin search showed every Hangar result as never downloaded. It now shows the real count, so the popular project stands out from its imitators.

Plugin configuration remains manual. SpawnLoft does not insert database credentials into plugin configuration files.


## Release build procedure

Maintainers build every platform from the same clean `main` commit. On the Windows Azure signing machine, on `main`, run `npm run release:stable` in `desktop`. It dispatches `desktop-stable`, which builds, signs, notarizes and exercises both native Mac apps, including an installed beta-to-stable upgrade, and builds both Linux architectures, installs the `.deb` with apt on Ubuntu 24.04 and the `.rpm` with dnf on Fedora, and exercises the installed app. Meanwhile it builds and signs the Windows installer, verifies it, runs the packaged-app smoke test and records its manifest; then it collects every platform's files in `desktop/dist/stable-release` and verifies them together.

`npm run release:stable -- --publish` then publishes. Publication checks all package bytes, Windows Authenticode, matching clean source commits, the successful native workflow, and the uploaded GitHub digests before exposing the complete release. Both beta and stable feeds are included so existing installations can move to stable.
