#!/bin/sh
# Inside a clean container, as root: install the command-line package the way a user would and run
# a server with it. Called by the workflows as
#
#   docker run --rm -v "$PWD:/repo:ro" <image> sh /repo/desktop/smoke-cli-package.sh deb|rpm
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
echo "PASS: spawnloft-cli $kind on $(. /etc/os-release && echo "$PRETTY_NAME")"
