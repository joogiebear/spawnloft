'use strict'

// A new major (SpawnLoft 2.0 offered to a 1.x install) never installs by itself on quit; only the
// Restart button installs it, and on Windows only once every server is stopped.
//
// Why: an update of the same major keeps the daemons running and they keep working. Across a major
// the program files they were started from are replaced by a different program. On macOS and Linux
// a 1.x daemon keeps running from deleted files (it imports everything at start, see daemon.mjs).
// On Windows the daemons are SpawnLoft.exe processes, and what the installer does to a running
// SpawnLoft.exe across that change has not been measured yet (plan experiment 4a), so a major waits
// for the person, with nothing running.
//
// electron-updater reads autoInstallOnAppQuit twice: on macOS when the download finishes (whether
// Squirrel is told to install on quit), elsewhere when the app quits. So the decision is made as
// soon as a version is offered, before the download starts, and again when it has downloaded, in
// case a later check offered a different version.

function majorOf(version) {
  const m = /^v?(\d+)\./.exec(String(version ?? ''))
  return m ? Number(m[1]) : null
}

// true when `offered` is a higher major than `current`; unknown versions count as a major, so a
// feed this code cannot read never installs unattended
function isMajorUpgrade(current, offered) {
  const from = majorOf(current)
  const to = majorOf(offered)
  if (from === null || to === null) return true
  return to > from
}

// Wires the decision into an updater. Returns state the shell asks before installing: the version
// on disk and whether it is a new major. An offer of a major turns install-on-quit off at once
// (macOS reads the flag when its download finishes); only the version actually downloaded turns it
// back on, so a later same-major offer cannot re-arm it while a major sits downloaded.
function guard(updater, currentVersion) {
  const state = { offered: null, major: false }
  updater.on('update-available', (info) => {
    if (isMajorUpgrade(currentVersion, info?.version)) updater.autoInstallOnAppQuit = false
  })
  updater.on('update-downloaded', (info) => {
    state.offered = info?.version ?? null
    state.major = isMajorUpgrade(currentVersion, state.offered)
    updater.autoInstallOnAppQuit = !state.major
  })
  return state
}

module.exports = { majorOf, isMajorUpgrade, guard }
