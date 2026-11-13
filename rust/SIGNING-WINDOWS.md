# Signed pre-beta Windows builds of v2, on Desktop-Main

Victor's call (2026-11-12, plan Q-T): until `v2` becomes the release branch, signed 2.0 Windows
builds are made on his signing machine, Desktop-Main, with the Azure Artifact Signing profile 1.x
stables are already signed with. No new Azure federated credential trusts `v2`, and CI keeps
building unsigned. Nothing in this procedure tags, uploads or publishes anything.

The command is `rust/crates/spawnloft-shell/installer/release-windows.mjs`. It builds the Rust core
and the Tauri shell at one version from one pushed commit, signs everything Windows checks, assembles
the update asset set the same way `release.yml` does, and runs the release gate on the result.

## What gets signed, and by whom

| File | Signed by | How |
| --- | --- | --- |
| `SpawnLoft-Setup-<v>.exe` (the setup) | victor zemeckis | the bundler's `signCommand` (sign-windows.ps1) |
| `SpawnLoft.exe` (the shell) | victor zemeckis | the bundler's `signCommand` |
| `uninstall.exe` | victor zemeckis | the bundler's `signCommand`, from inside makensis (`!uninstfinalize`) |
| `resources\bin\spawnloft-core.exe` | victor zemeckis | sign-windows.ps1, before the bundler copies it (the bundler does not sign resources) |
| `resources\runtime\node-<ver>\node.exe` | OpenJS Foundation | left as nodejs.org ships it, so its bytes still match the pinned archive |
| `resources\bin\spawnloft.cmd`, `mcctl.cmd` | not signed | batch files, as in 1.x |

The release gate checks the setup with `--authenticode-cn "victor zemeckis"`, the shell and the core
with `--signed`, and node.exe with `--signed <node.exe>=OpenJS Foundation`: each must be valid and
carry a timestamp, so the signature outlives the short-lived certificate. The uninstaller exists
only inside an installed copy, so it is checked in the W8 run on a clean VM, not here.

## Once per machine

All of these are already on Desktop-Main for 1.x stables except the Tauri pieces, which the script
installs for itself.

1. Git, Node (any current LTS), the GitHub CLI signed in (`gh auth status`).
2. Rust through rustup. `rust/rust-toolchain.toml` pins the compiler; rustup installs it on first use.
   The MSVC build tools (Visual Studio Build Tools, "Desktop development with C++").
3. The Azure CLI and the signing module, from the PowerShell you sign in (PowerShell 7 on Desktop-Main):
   ```powershell
   Install-Module -Name TrustedSigning -Scope CurrentUser
   ```
4. Signed in to Azure in the terminal that will build:
   ```powershell
   az login --tenant <the tenant holding the Mcctl signing account>
   ```

## Each build

In a PowerShell terminal, in a clean checkout of `v2`:

```powershell
git checkout v2
git pull --ff-only
node rust/crates/spawnloft-shell/installer/release-windows.mjs --version 2.0.0-beta.<N>
```

`<N>` is a number no published release uses. Pre-beta builds are numbered from 1 upwards; the
first public beta will still be `2.0.0-beta.1` only if no pre-beta build took that number, so pick
pre-beta numbers you will never publish, such as 1001, 1002 and so on.
A machine with such a build installed will not update down to a lower beta, so uninstall it
before testing the public betas there.

It stops at the first problem and says what to do. In order: it checks the machine (Windows, a
clean checkout at `origin/v2`, an Azure session, the signing module, a free output folder),
installs the pinned Tauri CLI into a temporary folder, makes a throwaway release key, builds and
signs the core, stages the bundled Node, builds and signs the shell, uninstaller and setup, assembles
the asset set, runs the gate, and writes the signing report beside the output folder.

The result is in `desktop\dist\v2-signed\<version>\`:

- `SpawnLoft-Setup-<version>.exe` and its `.sig`
- `spawnloft-updates.json` and `.sig`, `latest.json`, `latest.yml` and `beta.yml` (the update feeds)

and beside it, so the folder holds only release assets:

- `<version>.signing-report.json`: version, commit, which release key, and each signed file's
  sha256, signer and certificate thumbprint
- `<version>.throwaway-release.pub` when the throwaway key was used

It signs only from `v2` (the branch the checkout tracks on GitHub). To try a pull request's branch
before it merges, pass `--any-branch`.

It never installs the build. On Desktop-Main that would replace the installed SpawnLoft. Copy the
setup to a clean Windows VM for the W8 runs.

### The release key

By default the update files are signed with a throwaway key made for the run, so nothing built
here can be offered to a real install. The build itself still trusts the release keys compiled
into the core, like every build; what keeps a pre-beta install from taking a public beta is its
higher beta number (1001 and up), and `release-publish.mjs --confirm` refuses such a number.

For the W8 updater runs, which need the real key, pass it. The password goes in the terminal's
environment for that run only, never in a file:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host 'release key password'
node rust/crates/spawnloft-shell/installer/release-windows.mjs --version 2.0.0-beta.<N> --key <path to the release key file>
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

The public half defaults to `rust/crates/spawnloft-shell/release.pub` (`--pubkey` overrides it).
A build signed with the real key is still not published by anything here. Publishing stays a
separate, deliberate step through `desktop/release-publish.mjs --confirm`, on Victor's word.

## Over Remote Control

A thread can run this on Desktop-Main through Remote Control once Victor approves the session. The
Azure sign-in is interactive, so Victor runs `az login` himself first if `az account show` fails.
The thread then reports the gate's output and the signing report.

## When it fails

- **"there is no Azure session"**: `az login` as above. The session lasts hours, not days.
- **A signing attempt fails three times**: usually the timestamp service. Run the command again;
  the output folder must be empty first.
- **The gate says `signed by "<other>"`**: the profile or account settings differ from
  `desktop/package.json` `build.win.azureSignOptions`. That file is the one source of them.
- **`node.exe` is not signed by OpenJS Foundation**: the staged runtime is not the pinned nodejs.org
  archive. `desktop/node-pin.mjs` and the gate's `--runtime` check say which part differs.
- **"the bundler cannot find signtool.exe"** (or `tauri build` stops with "SignTool not found"):
  Tauri's NSIS bundler finds `signtool.exe` through `KitsRoot10` under
  `HKLM\SOFTWARE\Microsoft\Windows Kits\Installed Roots` in the 64-bit registry view, even with a
  custom sign command. On Desktop-Main that value once pointed at `C:\Program Files\Windows Kits\10\`
  (no bin folder) while the SDK is under `C:\Program Files (x86)\Windows Kits\10\`. Repair the
  Windows SDK, or set the value (elevated) to the folder whose `bin\<version>\x64` holds
  `signtool.exe`. The script checks this before it builds anything.
- **A resource path "doesn't exist" in `tauri-build`**: the work folder must be on the checkout's
  drive (it is, under `rust\target\signed-work`); tauri-build drops the drive letter of absolute
  resource paths.
- **`rust\target\release\SpawnLoft.exe` shows NotSigned after a good build**: expected. The bundler
  rewrites that loose file after it packs the signed copy into the setup. The sign command keeps a
  copy of every file as it signed it (`SPAWNLOFT_SIGNED_COPIES`), and the gate and the report check
  that copy.
