#!/bin/sh
# Inside a clean container, as root: install a published 1.x desktop package, give it a server,
# start that server with 1.x, then install the 2.0 package over it the way a user (or 1.x's
# electron-updater, which runs `dpkg -i` / `rpm -U` through pkexec) would, and check what the
# design promises (rust/INSTALLER-UPDATER-DESIGN.md 5.7 and 11):
#
#   - the upgrade is in place (same package name), and Electron's files are gone;
#   - both 1.x paths exist: /opt/SpawnLoft/spawnloft-desktop (the .desktop entry, the updater's
#     relaunch and 1.x task shims run it) and /opt/SpawnLoft/resources/bin/spawnloft (what
#     /usr/bin/spawnloft execed in 1.x and what MCP configs may hold);
#   - /usr/bin/spawnloft is the Rust core; /usr/bin/spawnloft-desktop is still the app;
#   - the window's libraries resolve on this distribution; user data is untouched;
#   - the 1.x server keeps running through the upgrade, and the 2.0 command line sees it and
#     stops it;
#   - removal leaves no command behind and keeps user data; spawnloft-cli is refused beside it.
#
#   docker run --rm -v "$PWD:/repo:ro" -v "$PKG:/pkg:ro" <image> sh /repo/rust/crates/spawnloft-shell/installer/ci/linux-upgrade.sh deb|rpm <old version> <new version>
#
# /pkg holds the old package (SpawnLoft-<old>-linux-*.{deb,rpm}), the new one, and the new
# spawnloft-cli package. The images have no Node: the 2.0 package must not need one.
set -eu
kind=$1
old=$2
new=$3
cd /

fail() { echo "FAIL: $*"; exit 1; }
step() { echo; echo "---- $*"; }

pkg_file() { # <version> <glob prefix>
  for f in /pkg/$2-$1-linux-*."$kind"; do
    [ -e "$f" ] && { echo "$f"; return; }
  done
  fail "no $2 $1 .$kind in /pkg"
}

install_pkg() {
  if [ "$kind" = deb ] && [ "${INSTALL_WITH:-}" = dpkg ]; then
    # electron-updater's DebUpdater: dpkg -i, and apt-get install -f when dependencies are missing
    dpkg -i "$1" >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -f -y -qq >/dev/null
  elif [ "$kind" = deb ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$1" >/dev/null
  else
    dnf install -y -q "$1" >/dev/null
  fi
}

installed_version() {
  if [ "$kind" = deb ]; then dpkg-query -W -f='${Version}' spawnloft; else rpm -q --qf '%{VERSION}' spawnloft; fi
}

# what dpkg and rpm call a semver prerelease (desktop/build-cli-package.mjs packageVersion)
pkgver() { echo "$1" | sed 's/-/~/'; }

if [ "$kind" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
fi
if command -v node >/dev/null 2>&1; then fail "this image has Node on PATH, so it proves nothing"; fi

step "1.x: install $old"
install_pkg "$(pkg_file "$old" SpawnLoft)"
test "$(installed_version)" = "$(pkgver "$old")" || fail "installed $(installed_version), not $old"
test -e /opt/SpawnLoft/resources/app.asar || fail "$old has no app.asar: not an Electron build?"
test "$(readlink -f /usr/bin/spawnloft-desktop)" = /opt/SpawnLoft/spawnloft-desktop || fail "1.x made no /usr/bin/spawnloft-desktop"
# 1.x's Electron loads libasound and libgbm without declaring them (every desktop has them, a
# container does not)
if [ "$kind" = deb ]; then
  apt-get install -y -qq libasound2t64 libgbm1 >/dev/null 2>&1 || apt-get install -y -qq libasound2 libgbm1 >/dev/null
else
  dnf install -y -q alsa-lib mesa-libgbm >/dev/null
fi

# A server for 1.x to run: the test suite's fake one, on 1.x's own runtime (Electron as Node).
export SPAWNLOFT_DATA_ROOT=/tmp/spawnloft-data
# 1.5.0 predates the rename and reads MCCTL_DATA_ROOT
export MCCTL_DATA_ROOT="$SPAWNLOFT_DATA_ROOT"
export HOME=/tmp/spawnloft-home
mkdir -p "$HOME" "$SPAWNLOFT_DATA_ROOT/instances/pkgtest"
cp /repo/test/fixtures/fake-java.mjs /tmp/fake-java.mjs
printf 'eula=true\n' > "$SPAWNLOFT_DATA_ROOT/instances/pkgtest/eula.txt"
: > "$SPAWNLOFT_DATA_ROOT/instances/pkgtest/server.jar"
cat > "$SPAWNLOFT_DATA_ROOT/instances.json" <<JSON
{ "version": 1, "instances": { "pkgtest": {
  "dir": "$SPAWNLOFT_DATA_ROOT/instances/pkgtest", "jar": "server.jar", "java": "/tmp/fake-java.mjs", "memory": "1G",
  "port": 45665, "rcon": { "port": 45675, "password": "package-smoke" }, "autoRestart": false } } }
JSON
cp "$SPAWNLOFT_DATA_ROOT/instances.json" /tmp/instances.before
spawnloft start pkgtest
spawnloft status pkgtest --json | grep -q '"status": *"running"' || fail "1.x did not start the server"
# the 1.x daemon: Electron running as Node, from files the upgrade is about to delete
pid=$(spawnloft status pkgtest --json | tr -d '\n ' | sed -n 's/.*"daemonPid":\([0-9][0-9]*\).*/\1/p')
test -n "$pid" || fail "no daemonPid in 1.x status: $(spawnloft status pkgtest --json)"
echo "1.x daemon pid $pid"

step "2.0: install $new over it"
install_pkg "$(pkg_file "$new" SpawnLoft)"
test "$(installed_version)" = "$(pkgver "$new")" || fail "installed $(installed_version), not $new"
if [ "$kind" = deb ]; then
  test "$(dpkg-query -W -f='${Status}' spawnloft)" = "install ok installed" || fail "dpkg status: $(dpkg-query -W -f='${Status}' spawnloft)"
fi
test "$(cat /opt/SpawnLoft/resources/package-type)" = "$kind" || fail "package-type says $(cat /opt/SpawnLoft/resources/package-type)"

# Electron is gone: the package manager removed every 1.x file the new package does not ship
for f in resources/app.asar chrome-sandbox libffmpeg.so resources.pak icudtl.dat; do
  test ! -e "/opt/SpawnLoft/$f" || fail "1.x leftover /opt/SpawnLoft/$f"
done

# the two 1.x paths, and the rest of the layout
for f in /opt/SpawnLoft/spawnloft-desktop /opt/SpawnLoft/resources/bin/spawnloft /opt/SpawnLoft/resources/bin/mcctl \
         /opt/SpawnLoft/resources/bin/spawnloft-core /usr/bin/spawnloft; do
  test -x "$f" || fail "$f is missing or not executable"
done
test -f /opt/SpawnLoft/resources/core/mcctl.mjs || fail "no Node core"
grep -q '^Exec=/opt/SpawnLoft/spawnloft-desktop %U$' /usr/share/applications/spawnloft-desktop.desktop || fail ".desktop entry"
test "$(readlink -f /usr/bin/spawnloft-desktop)" = /opt/SpawnLoft/spawnloft-desktop || fail "/usr/bin/spawnloft-desktop is $(readlink -f /usr/bin/spawnloft-desktop 2>&1)"

# /usr/bin/spawnloft and both 1.x launchers are the Rust core, at the new version
for c in /usr/bin/spawnloft /opt/SpawnLoft/resources/bin/spawnloft /opt/SpawnLoft/resources/bin/mcctl; do
  out=$("$c" --version)
  echo "$c --version: $out"
  case "$out" in "spawnloft-core $new "*) ;; *) fail "$c is not the $new core" ;; esac
done

# the window's shared libraries resolve here (WebKitGTK 4.1, GTK 3, glibc floor)
if ldd /opt/SpawnLoft/spawnloft-desktop | grep 'not found'; then fail "the shell has unresolved libraries"; fi

cmp -s "$SPAWNLOFT_DATA_ROOT/instances.json" /tmp/instances.before || fail "the upgrade changed instances.json"
if kill -0 "$pid" 2>/dev/null; then
  echo "the 1.x daemon (pid $pid) kept running through the upgrade, from its deleted files"
else
  fail "the 1.x daemon (pid $pid) died during the upgrade"
fi

step "2.0: the command line takes over the 1.x server"
spawnloft list
spawnloft status pkgtest --json | grep -q '"status": *"running"' || fail "2.0 does not see the 1.x server as running"
spawnloft stop pkgtest
spawnloft status pkgtest --json | grep -q '"status": *"stopped"' || fail "2.0 did not stop the 1.x server"
if kill -0 "$pid" 2>/dev/null; then fail "the 1.x daemon (pid $pid) is still alive after stop"; fi
# what a 1.x task shim or MCP config runs: the app with the Node core's script path
/opt/SpawnLoft/spawnloft-desktop /opt/SpawnLoft/resources/core/mcctl.mjs list | grep -q pkgtest || fail "the 1.x shim form does not reach the core"
spawnloft start pkgtest
spawnloft status pkgtest --json | grep -q '"status": *"running"' || fail "2.0 did not start the server"
spawnloft stop pkgtest

step "spawnloft-cli is refused beside the desktop package"
cli=$(pkg_file "$new" spawnloft-cli)
if [ "$kind" = deb ]; then
  if out=$(dpkg -i "$cli" 2>&1); then fail "dpkg installed spawnloft-cli beside spawnloft"; fi
  dpkg --configure -a >/dev/null 2>&1 || true
else
  if out=$(rpm -i "$cli" 2>&1); then fail "rpm installed spawnloft-cli beside spawnloft"; fi
fi
echo "$out" | grep -qi conflict || fail "the refusal was not the declared conflict: $out"
test "$(installed_version)" = "$(pkgver "$new")" || fail "the refused CLI install changed spawnloft"

step "remove"
if [ "$kind" = deb ]; then apt-get remove -y -qq spawnloft >/dev/null; else dnf remove -y -q spawnloft >/dev/null; fi
for f in /usr/bin/spawnloft /usr/bin/spawnloft-desktop /opt/SpawnLoft/spawnloft-desktop /opt/SpawnLoft/resources/bin/spawnloft-core; do
  test ! -e "$f" && test ! -L "$f" || fail "$f is still there after removal"
done
test -f "$SPAWNLOFT_DATA_ROOT/instances.json" || fail "removal deleted user data"

step "fresh install of $new"
install_pkg "$(pkg_file "$new" SpawnLoft)"
test "$(readlink -f /usr/bin/spawnloft-desktop)" = /opt/SpawnLoft/spawnloft-desktop || fail "fresh install made no /usr/bin/spawnloft-desktop"
spawnloft --version

echo
echo "PASS: SpawnLoft $old -> $new ($kind) on $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m)"
