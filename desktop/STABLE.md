<!-- This file is published, as it stands, as the text of the next stable release.
     A pull request that changes something a person would notice adds its line here, under the
     version it will ship in, so that release day is a read-through. Rewrite the top for each
     release; the build procedure at the bottom stays. -->
SpawnLoft 1.5 puts a server's files in the panel: browse them, edit any text file beside the console, upload, download and tidy up, with a copy of everything changed kept in Backups.

- **Windows 10/11 x64:** download `SpawnLoft-Setup-1.5.0.exe`, signed through Microsoft Azure Artifact Signing.
- **Mac with Apple Silicon:** download `SpawnLoft-1.5.0-mac-arm64.dmg`.
- **Mac with Intel:** download `SpawnLoft-1.5.0-mac-x64.dmg`.
- Both Mac builds are Developer ID signed, hardened, Apple-notarized and stapled. The app requires macOS 13 or later; managed MySQL requires macOS 15 or later.
- **Linux, Debian and Ubuntu (22.04+, Debian 12+):** `SpawnLoft-1.5.0-linux-amd64.deb`, or `-linux-arm64.deb` on arm64. Install with `sudo apt install ./<file>`.
- **Linux, Fedora, RHEL-family and openSUSE:** `SpawnLoft-1.5.0-linux-x86_64.rpm`, or `-linux-aarch64.rpm` on arm64. Install with `sudo dnf install ./<file>`.
- Java is separate on every platform, and which one depends on your Minecraft version. On Debian and Ubuntu: `sudo apt install openjdk-25-jre-headless`. On Fedora the newest is `sudo dnf install java-latest-openjdk-headless`.

Existing installs receive 1.5 through the built-in updater. ZIP files are used by the Mac updater; choose the DMG for a manual installation. A Linux install updates through a system password prompt, and takes the package of its own kind.

## New in 1.5

- **Files.** A server's folder is in the panel now, under Files in the dock. Open any text file in an editor that colours YAML, JSON and properties files and numbers its lines, and save it beside the console; upload by dropping files onto the list; download a file or a whole folder; rename, move, zip, unzip, and find anything by name. Every edit, replaced file and delete keeps a copy of what it changed first, and Backups can put back just that. A save over a file that changed since you opened it - the server rewrote it, or it was edited elsewhere - is refused rather than undoing that change, and a tab in YAML or broken JSON asks before it is saved. While the server runs, what it holds open - the active world, its jar, the plugins it loaded - cannot be moved, replaced or deleted.

- **Activity.** Every server has a history: what was done to it, when, and by whom - you, a scheduled task by name, an AI assistant by the name of its app, or SpawnLoft's own crash guard. Starts, stops and crashes, commands, backups, file and config edits, plugins, settings, worlds, players and schedules all appear, and can be narrowed to one kind of doer. A change that kept a copy of what it changed has Undo beside it, so "what did the assistant change last night" is one screen and one button. The Overview shows the last few things done on any server, and a line there opens that server's history. AI assistants can read it too, with `get_activity`.

- **Scheduled tasks can be several steps.** A task can now warn the players with a countdown, take a backup, and restart - in that order, in one run, each step waiting for the one before it, so a restart never overtakes its backup. Steps can also run commands, wait, verify backups, stop and start. A failed step stops the rest unless you say otherwise, and a task can be set to run only while the server is up. Three ready-made chains cover the usual nightly routines.

- **Backups you can keep, name and take with you.** Lock a backup and nothing deletes it - not the Delete button, not a schedule's retention - so the one taken before a big change stays. Give any backup a note ("before the 1.21 upgrade"), download it to keep somewhere else, and list paths each server's backups should leave out, such as a map plugin's rendered tiles. A restore can now clear what the backup holds first, so the server ends up exactly as it was; what was cleared is kept, so that can be undone too.

- **See how your server looks in the multiplayer list.** Settings shows the server's icon, name and message of the day the way players see them, with the colours; swatches insert Minecraft's colour and style codes, and any image becomes the server icon.
- **Java arguments of your own.** Settings, under Java and memory, keeps SpawnLoft's recommended flags unless you write your own, and shows the whole launch line either way. Memory stays with the Memory setting.
- **The console in its own window.** A button on the console's toolbar opens that server's console on its own - on a second screen, say - while the main window does something else.
- **Doctor notices a second copy of your data on Windows.** An AI assistant installed as a Windows package is given a private copy of what it writes under AppData, and the programs it starts read that copy from then on - so it can keep seeing the servers as they were the last time it wrote the registry - a server missing, a memory setting out of date - while its backups pile up where the Backups tab never looks. `spawnloft doctor` now finds the copy and says what differs and what to do about it, and the assistant is told at the start to ask you to run it outside the assistant, since a program that is itself redirected cannot see the difference. See [MCP.md](https://github.com/joogiebear/spawnloft/blob/main/MCP.md).

## Fixed

- A backup of a running server could leave it with autosave switched off, if its world took longer than eight seconds to write out: the backup gave up on the flush, and with it on the step that turns saving back on. The flush now has two minutes, and the command that turns saving back on is sent whether the flush worked, failed or timed out. If the server does not confirm it, the backup says autosave may still be off and what to type - in the panel, in a scheduled task's log, on the command line and to an AI assistant.
- A few commands in every hundred sent to a server over RCON were hung up on, and the readings under a server's name - TPS and players online - dropped their connection and opened another again and again, each time writing two lines to the server's console. SpawnLoft sent a command and its end-of-reply marker back to back, and Minecraft's RCON thread hangs up on a read that holds two packets. The marker now follows the start of the reply, so the readings keep the one connection they were meant to, one-off commands stop leaning on retries, and a connection the server has closed fails at once instead of waiting out the timeout.

SpawnLoft does not insert database credentials into plugin configuration files.


## Release build procedure

Maintainers build every platform from the same clean `main` commit. On the Windows Azure signing machine, on `main`, run `npm run release:stable` in `desktop`. It dispatches `desktop-stable`, which builds, signs, notarizes and exercises both native Mac apps, including an installed beta-to-stable upgrade, and builds both Linux architectures, installs the `.deb` with apt on Ubuntu 24.04 and the `.rpm` with dnf on Fedora, and exercises the installed app. Meanwhile it builds and signs the Windows installer, verifies it, runs the packaged-app smoke test and records its manifest; then it collects every platform's files in `desktop/dist/stable-release` and verifies them together.

`npm run release:stable -- --publish` then publishes. Publication checks all package bytes, Windows Authenticode, matching clean source commits, the successful native workflow, and the uploaded GitHub digests before exposing the complete release. Both beta and stable feeds are included so existing installations can move to stable.
