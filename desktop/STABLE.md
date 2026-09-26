<!-- This file is published, as it stands, as the text of the next stable release.
     A pull request that changes something a person would notice adds its line here, under the
     version it will ship in, so that release day is a read-through. Rewrite the top for each
     release; the build procedure at the bottom stays. -->
SpawnLoft 1.4 lets an AI assistant change your plugins' settings, not only read about them.

- **Windows 10/11 x64:** download `SpawnLoft-Setup-1.4.0.exe`, signed through Microsoft Azure Artifact Signing.
- **Mac with Apple Silicon:** download `SpawnLoft-1.4.0-mac-arm64.dmg`.
- **Mac with Intel:** download `SpawnLoft-1.4.0-mac-x64.dmg`.
- Both Mac builds are Developer ID signed, hardened, Apple-notarized and stapled. The app requires macOS 13 or later; managed MySQL requires macOS 15 or later.
- **Linux, Debian and Ubuntu (22.04+, Debian 12+):** `SpawnLoft-1.4.0-linux-amd64.deb`, or `-linux-arm64.deb` on arm64. Install with `sudo apt install ./<file>`.
- **Linux, Fedora, RHEL-family and openSUSE:** `SpawnLoft-1.4.0-linux-x86_64.rpm`, or `-linux-aarch64.rpm` on arm64. Install with `sudo dnf install ./<file>`.
- Java is separate on every platform, and which one depends on your Minecraft version. On Debian and Ubuntu: `sudo apt install openjdk-25-jre-headless`. On Fedora the newest is `sudo dnf install java-latest-openjdk-headless`.

Existing installs receive 1.4 through the built-in updater. ZIP files are used by the Mac updater; choose the DMG for a manual installation. A Linux install updates through a system password prompt, and takes the package of its own kind.

## New in 1.4

- **AI assistants can change configuration files.** Ask for a plugin setting to be changed and the assistant finds the file, reads it and changes the lines it means to, then reloads the plugin or restarts the server. Each change is snapshotted first, one file at a time, so it can be put back from the Backups tab without touching anything else. It stays inside the server's folder, works only on text configuration (YAML, JSON, properties, TOML and the like), and never sees worlds, logs, `eula.txt` or players' IP addresses. Passwords, tokens and webhook URLs in those files are shown to it as `[redacted]` and cannot be changed through it, and neither can the ports and RCON settings SpawnLoft manages. See [MCP.md](https://github.com/joogiebear/spawnloft/blob/main/MCP.md).
- **Update checks for Purpur, Folia and Advanced Slime Paper**, as Paper already had. Settings, under Server software, says which build a server runs and offers the newest one, or a newer Minecraft version; so do `spawnloft upgrade` and the AI assistant tools. Advanced Slime Paper builds have no number, so they are compared by date.

## Fixed

- Upgrading a server to a newer Minecraft version left it recorded as the old one, so it kept being offered plugin builds for that version and was started on the Java that version needs rather than the new one's. It now records the version it moved to.

SpawnLoft does not insert database credentials into plugin configuration files.


## Release build procedure

Maintainers build every platform from the same clean `main` commit. On the Windows Azure signing machine, on `main`, run `npm run release:stable` in `desktop`. It dispatches `desktop-stable`, which builds, signs, notarizes and exercises both native Mac apps, including an installed beta-to-stable upgrade, and builds both Linux architectures, installs the `.deb` with apt on Ubuntu 24.04 and the `.rpm` with dnf on Fedora, and exercises the installed app. Meanwhile it builds and signs the Windows installer, verifies it, runs the packaged-app smoke test and records its manifest; then it collects every platform's files in `desktop/dist/stable-release` and verifies them together.

`npm run release:stable -- --publish` then publishes. Publication checks all package bytes, Windows Authenticode, matching clean source commits, the successful native workflow, and the uploaded GitHub digests before exposing the complete release. Both beta and stable feeds are included so existing installations can move to stable.
