#!/bin/sh
# Inside a clean container, as root: the headless package. Install the published 1.x
# spawnloft-cli, start a server with it, install the 2.0 spawnloft-cli over it, and check that
# /usr/bin/spawnloft is now the Rust core on the bundled runtime, that what 1.x wrote to disk
# (task shims and MCP configs name /opt/spawnloft-cli/bin/node and core/mcctl.mjs) still runs,
# that 2.0 sees and stops the 1.x server, and that the desktop package is refused beside it.
# desktop/smoke-cli-package.sh then runs a server end to end on the installed 2.0 package.
#
#   docker run --rm -v "$PWD:/repo:ro" -v "$PKG:/pkg:ro" <image> sh /repo/rust/crates/spawnloft-shell/installer/ci/linux-cli-upgrade.sh deb|rpm <old version> <new version>
set -eu
kind=$1
old=$2
new=$3
cd /

fail() { echo "FAIL: $*"; exit 1; }
step() { echo; echo "---- $*"; }
pkg_file() {
  for f in /pkg/$2-$1-linux-*."$kind"; do [ -e "$f" ] && { echo "$f"; return; }; done
  fail "no $2 $1 .$kind in /pkg"
}
install_pkg() {
  if [ "$kind" = deb ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$1" >/dev/null; else dnf install -y -q "$1" >/dev/null; fi
}
installed_version() {
  if [ "$kind" = deb ]; then dpkg-query -W -f='${Version}' spawnloft-cli; else rpm -q --qf '%{VERSION}' spawnloft-cli; fi
}
pkgver() { echo "$1" | sed 's/-/~/'; }

if [ "$kind" = deb ]; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; fi
if command -v node >/dev/null 2>&1; then fail "this image has Node on PATH, so it proves nothing"; fi

step "1.x: install spawnloft-cli $old"
install_pkg "$(pkg_file "$old" spawnloft-cli)"
test "$(installed_version)" = "$(pkgver "$old")" || fail "installed $(installed_version), not $old"

export SPAWNLOFT_DATA_ROOT=/tmp/spawnloft-data
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
spawnloft start pkgtest
pid=$(spawnloft status pkgtest --json | tr -d '\n ' | sed -n 's/.*"daemonPid":\([0-9][0-9]*\).*/\1/p')
test -n "$pid" || fail "no daemonPid in 1.x status"
echo "1.x daemon pid $pid"

step "2.0: install spawnloft-cli $new over it"
install_pkg "$(pkg_file "$new" spawnloft-cli)"
test "$(installed_version)" = "$(pkgver "$new")" || fail "installed $(installed_version), not $new"
test "$(cat /opt/spawnloft-cli/package-type)" = "$kind" || fail "package-type"
out=$(spawnloft --version)
echo "spawnloft --version: $out"
case "$out" in "spawnloft-core $new "*) ;; *) fail "/usr/bin/spawnloft is not the $new core" ;; esac
test -f /opt/spawnloft-cli/runtime/runtime.json || fail "no runtime.json"
node_exe="/opt/spawnloft-cli/runtime/$(sed -n 's/.*"exe": *"\([^"]*\)".*/\1/p' /opt/spawnloft-cli/runtime/runtime.json)"
test -x "$node_exe" || fail "runtime.json names $node_exe, which is not there"
# the 1.x path stays, for what 1.x wrote to disk
test "$(readlink -f /opt/spawnloft-cli/bin/node)" = "$(readlink -f "$node_exe")" || fail "bin/node does not reach the runtime"
/opt/spawnloft-cli/bin/node /opt/spawnloft-cli/core/mcctl.mjs list | grep -q pkgtest || fail "the 1.x shim form does not run"
kill -0 "$pid" 2>/dev/null || fail "the 1.x daemon died during the upgrade"
echo "the 1.x daemon (pid $pid) kept running through the upgrade"

step "2.0: the command line takes over the 1.x server"
spawnloft status pkgtest --json | grep -q '"status": *"running"' || fail "2.0 does not see the 1.x server as running"
spawnloft stop pkgtest
spawnloft status pkgtest --json | grep -q '"status": *"stopped"' || fail "2.0 did not stop the 1.x server"
if kill -0 "$pid" 2>/dev/null; then fail "the 1.x daemon (pid $pid) is still alive after stop"; fi

step "the desktop package is refused beside spawnloft-cli"
desk=$(pkg_file "$new" SpawnLoft)
if [ "$kind" = deb ]; then
  if out=$(dpkg -i "$desk" 2>&1); then fail "dpkg installed spawnloft beside spawnloft-cli"; fi
  dpkg --configure -a >/dev/null 2>&1 || true
else
  if out=$(rpm -i --nodeps "$desk" 2>&1); then fail "rpm installed spawnloft beside spawnloft-cli"; fi
fi
echo "$out" | grep -qi conflict || fail "the refusal was not the declared conflict: $out"
test "$(installed_version)" = "$(pkgver "$new")" || fail "the refused install changed spawnloft-cli"

echo
echo "PASS: spawnloft-cli $old -> $new ($kind) on $(. /etc/os-release && echo "$PRETTY_NAME"), $(uname -m)"
