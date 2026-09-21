<!-- This file is published, as it stands, as the text of the next stable release.
     A pull request that changes something a person would notice adds its line here, under the
     version it will ship in, so that release day is a read-through. Rewrite the top for each
     release; the build procedure at the bottom stays. -->
SpawnLoft 1.2 brings Linux to more machines: an `.rpm` beside the `.deb`, and both for arm64.

- **Windows 10/11 x64:** download `SpawnLoft-Setup-1.2.0.exe`, signed through Microsoft Azure Artifact Signing.
- **Mac with Apple Silicon:** download `SpawnLoft-1.2.0-mac-arm64.dmg`.
- **Mac with Intel:** download `SpawnLoft-1.2.0-mac-x64.dmg`.
- Both Mac builds are Developer ID signed, hardened, Apple-notarized and stapled. The app requires macOS 13 or later; managed MySQL requires macOS 15 or later.
- **Linux, Debian and Ubuntu (22.04+, Debian 12+):** `SpawnLoft-1.2.0-linux-amd64.deb`, or `-linux-arm64.deb` on arm64. Install with `sudo apt install ./<file>`.
- **Linux, Fedora, RHEL-family and openSUSE:** `SpawnLoft-1.2.0-linux-x86_64.rpm`, or `-linux-aarch64.rpm` on arm64. Install with `sudo dnf install ./<file>`.
- Java is separate on every platform, and which one depends on your Minecraft version. On Debian and Ubuntu: `sudo apt install openjdk-25-jre-headless`. On Fedora the newest is `sudo dnf install java-latest-openjdk-headless`.

Existing installs receive 1.2 through the built-in updater. ZIP files are used by the Mac updater; choose the DMG for a manual installation. A Linux install updates through a system password prompt, and takes the package of its own kind.

## New in 1.2

- **An `.rpm`**, with the same arrangement as the `.deb`: `spawnloft-desktop` opens the window, `spawnloft` is the command line and needs no Node, and everything installs to `/opt/SpawnLoft`.
- **Get beta builds**, in Settings under Updates. Turn it on and SpawnLoft follows the betas between monthly releases - new features as they are finished - and then the release itself. Turn it off whenever you like: nothing is downgraded, the betas stop, and the next release installs when it ships. Until now this was decided by which installer you had downloaded.
- **arm64 Linux packages**, for both. Managed Redis runs there. Managed MySQL does not - Oracle publishes no small arm64 build - so *Create a database* is off on those machines and says so, rather than being offered and refused; connecting to a MySQL you already run works as it does everywhere.

## Fixed

- On Linux arm64 the one-click *Create a database* button was offered and then refused by the server.
- Downloading a server jar or a database engine asks again when the download server answers with a gateway timeout or is briefly unavailable, instead of failing the install on one bad response.

Plugin configuration remains manual. SpawnLoft does not insert database credentials into plugin configuration files.


## Release build procedure

Maintainers build every platform from the same clean `main` commit. On the Windows Azure signing machine, on `main`, run `npm run release:stable` in `desktop`. It dispatches `desktop-stable`, which builds, signs, notarizes and exercises both native Mac apps, including an installed beta-to-stable upgrade, and builds both Linux architectures, installs the `.deb` with apt on Ubuntu 24.04 and the `.rpm` with dnf on Fedora, and exercises the installed app. Meanwhile it builds and signs the Windows installer, verifies it, runs the packaged-app smoke test and records its manifest; then it collects every platform's files in `desktop/dist/stable-release` and verifies them together.

`npm run release:stable -- --publish` then publishes. Publication checks all package bytes, Windows Authenticode, matching clean source commits, the successful native workflow, and the uploaded GitHub digests before exposing the complete release. Both beta and stable feeds are included so existing installations can move to stable.
