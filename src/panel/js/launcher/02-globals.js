'use strict';


  const POLL_MS = 3000
  // a game gone this soon after it started is a crash unless its log says it was closed; one gone
  // later is a crash when its log does not end in Minecraft's own stop (exitVerdict)
  const CRASH_WINDOW_MS = 60000
  const LOG_LINES = 20
  // how far back the log is read to tell a crash from a game that was simply closed
  const LOG_SCAN = 200
  // a crash the panel recorded while this page was closed is still told, this long after
  const CRASH_REPLAY_MS = 12 * 60 * 60 * 1000
  // how long a notice of something that went well stays before it goes by itself
  const FLASH_MS = 8000
  // the memory segments; anything else is Custom, a slider in half-gigabyte steps
  const MEMORY_CHOICES = ['2G', '4G', '8G']
  // the version list shows this many rows; the rest are reached by typing
  const VERSION_CAP = 80
  // the Java list's last choice: a path typed or browsed to
  const JAVA_OTHER = ':other'
  const STOPPED = new Set(['stopped', 'stale'])
  const JOB_KEY = 'spawnloft.launcher.job'
  const PICK_KEY = 'spawnloft.launcher.profile'
  // per profile, where Join pointed last: { server } or { address }; nothing is the title screen
  const JOIN_KEY = 'spawnloft.launcher.join'
  const STEPS = ['Version', 'Java', 'Files', 'Server', 'Start']
  // the same steps as a screen reader hears them
  const STEP_SAID = ['reading the version', 'finding Java', 'getting the game\'s files', 'starting the server', 'starting the game']
  // the all-versions plan's strict-mode codes: the version itself is refused, not this launch
  const STRICT_CODES = ['unknown-variable', 'unknown-rule-key', 'newer-launcher-format', 'unknown-asset-layout', 'no-natives-for-this-machine']
  const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/
  const LEVEL_RE = /\b(WARN|ERROR|FATAL)\b/
  // the desktop app's bridge; null in a browser tab
  // Embedded in the panel, the bridge exists only on the parent frame; the launcher window has its own.
  const desktop = window.spawnloftDesktop ?? (() => {
    try { return window.self !== window.top ? window.parent.spawnloftDesktop ?? null : null } catch { return null }
  })()
  // Inside the panel's Play page, a frame of the panel's own origin, rather than a window or tab
  // of its own: the top bar becomes a page head (CSS), and the two lines that speak of closing
  // "this window" speak of leaving the page. Nothing else here knows the difference.
  const EMBEDDED = window.self !== window.top
  const CLOSING = EMBEDDED ? 'Leaving this page' : 'Closing this window'

