#!/bin/sh
# Inside a clean container, as root: install the command-line package the way a user would and run
# a server with it. Called by the workflows as
#
#   docker run --rm -v "$PWD:/repo:ro" <image> sh /repo/desktop/smoke-cli-package.sh deb|rpm [db]
#
# The images have no Node, which is the point: the package says it needs none. They have no Java
# either, so the server is the test suite's fake one, run by the package's own runtime. What is
# being proved is everything around the JVM: the dependencies the package declares resolve on this
# distribution, its runtime loads against this distribution's libc, the daemon detaches and is
# recognised afterwards - the check that called every server ORPHANED under Node 24, and only ever
# showed on a real install - and the server obeys the console and stops.
set -eu
kind=$1
cd /

if [ "$kind" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq /repo/desktop/dist/spawnloft-cli-*.deb
  dpkg -s spawnloft-cli | grep -E '^(Version|Status):'
else
  dnf install -y -q /repo/desktop/dist/spawnloft-cli-*.rpm
  rpm -q spawnloft-cli
fi

if command -v node >/dev/null 2>&1; then echo "this image has Node on PATH, so it proves nothing"; exit 1; fi
test -x /usr/bin/spawnloft
test "$(cat /opt/spawnloft-cli/package-type)" = "$kind"

export MCCTL_DATA_ROOT=/tmp/spawnloft-data
export HOME=/tmp/spawnloft-home
mkdir -p "$HOME" "$MCCTL_DATA_ROOT/instances/pkgtest"
spawnloft config

cp /repo/test/fixtures/fake-java.mjs /tmp/fake-java.mjs
printf 'eula=true\n' > "$MCCTL_DATA_ROOT/instances/pkgtest/eula.txt"
: > "$MCCTL_DATA_ROOT/instances/pkgtest/server.jar"
cat > "$MCCTL_DATA_ROOT/instances.json" <<JSON
{ "version": 1, "instances": { "pkgtest": {
  "dir": "$MCCTL_DATA_ROOT/instances/pkgtest", "jar": "server.jar", "java": "/tmp/fake-java.mjs", "memory": "1G",
  "port": 45665, "rcon": { "port": 45675, "password": "package-smoke" }, "autoRestart": false } } }
JSON

spawnloft start pkgtest
spawnloft list
# "running", and not ORPHANED: the daemon was found again by what it is, not by what ps calls it.
spawnloft status pkgtest --json | grep -q '"status": *"running"'
spawnloft send pkgtest "say from the package"
spawnloft stop pkgtest
spawnloft status pkgtest --json | grep -q '"status": *"stopped"'
spawnloft doctor || true
# What an AI app sees: MCP over stdio from the package's own Node, with the RCON password left out.
mcp_out=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"server_status","arguments":{"name":"pkgtest"}}}' \
  | spawnloft mcp)
echo "$mcp_out" | grep -q '"serverInfo":{"name":"spawnloft"'
echo "$mcp_out" | grep -q '"status":"stopped"'
if echo "$mcp_out" | grep -q package-smoke; then echo "FAIL: spawnloft mcp exposed the RCON password"; exit 1; fi
echo "PASS: spawnloft-cli $kind on $(. /etc/os-release && echo "$PRETTY_NAME")"

# ---- managed MySQL, where the system has none of the libraries it needs ---------------------------
#
# Oracle's mysqld wants libaio, libnuma and ncurses and a server image has none of them. SpawnLoft
# fetches the distribution's own packages without root and unpacks them beside the engine. That is
# `apt-get download` on the Debian family and `dnf download` on the Fedora and RHEL families, and the
# only honest test of either is a machine that really lacks the libraries, asked by someone who
# really is not root - mysqld refuses to run as root anyway. x64 only: there is no managed MySQL
# on arm64.
if [ "${2:-}" != db ] || [ "$(uname -m)" != x86_64 ]; then exit 0; fi

if ldconfig -p | grep -q 'libaio.so.1'; then echo "this image already has libaio, so it proves nothing"; exit 1; fi
if [ "$kind" = rpm ]; then
  # What a real install has and a container image leaves out: the download command on dnf 4
  # (part of dnf itself from 5), and cpio, which anything that builds an initramfs pulls in.
  # util-linux is the test's own need, not SpawnLoft's: it is how this script becomes another user,
  # and the Fedora image has neither su nor runuser.
  dnf install -y -q dnf-plugins-core cpio util-linux >/dev/null 2>&1 || dnf install -y -q cpio util-linux
fi
useradd -m sl 2>/dev/null || adduser --disabled-password --gecos "" sl >/dev/null
cat > /tmp/db-smoke.sh <<'SH'
set -eu
# Root's test above exported these; this user has a home of its own.
export HOME=/home/sl
export MCCTL_DATA_ROOT="$HOME/data"
cd "$HOME"
spawnloft db add pkgdb
spawnloft start pkgdb
spawnloft db
spawnloft status pkgdb --json | grep -q '"status": *"running"'
libs=$(ls -d "$MCCTL_DATA_ROOT"/engines/*/spawnloft-libs)
ls -l "$libs"
test -e "$libs/libaio.so.1"
spawnloft stop pkgdb
SH
# su is a package a Fedora image does not carry; runuser comes with the one it does.
if command -v runuser >/dev/null 2>&1; then runuser -u sl -- sh /tmp/db-smoke.sh; else su sl -s /bin/sh -c 'sh /tmp/db-smoke.sh'; fi
# Supplied privately: nothing was installed on the system to make that work.
if ldconfig -p | grep -q 'libaio.so.1'; then echo "libaio reached the system"; exit 1; fi
echo "PASS: managed MySQL on $(. /etc/os-release && echo "$PRETTY_NAME") with privately fetched libraries"
