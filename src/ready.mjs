// Console patterns for ready and failed starts, shared by the daemon and the supervisor.

/** Paper, Fabric and NeoForge all print vanilla's line: Done (12.345s)! For help, type "help" */
export const READY_RE = /Done \([\d.,]+s\)!/

/** The shapes of a start that is not going to succeed, so waiting for ready can stop early. */
export const FAILED_RE = /(Failed to start the minecraft server|A fatal error has occurred|Could not (?:reserve|create).*heap|Unable to access jarfile)/i

/** MariaDB, with --console: the note it prints once it listens, and the shapes of a start that died. */
export const MARIADB_READY_RE = /ready for connections/i
export const MARIADB_FAILED_RE = /\[ERROR\] (?:Aborting|Can't start server|mariadbd: Can't|mysqld: Can't|InnoDB: Unable to lock|Fatal error)/i

/** Garnet, and Redis itself: the line every Redis-speaking server prints once it listens. */
export const GARNET_READY_RE = /ready to accept connections/i
export const GARNET_FAILED_RE = /address already in use|only one usage of each socket|unhandled exception|cannot bind/i

// Longer than any line the patterns above have to see whole.
const OVERLAP = 512

// A read can end mid-line, so the tail of the previous read is searched along with the new text.
// Pass the returned `carry` back in with the next text.
export function scanConsole(carry, text, { ready, failed }) {
  const scan = carry + text
  const hit = ready.exec(scan)
  if (hit) return { carry: '', ready: hit[0] }
  const bad = failed.exec(scan)
  if (bad) return { carry: '', failed: bad[0] }
  return { carry: scan.slice(-OVERLAP) }
}

/** The pair that fits an instance: a database's engine has its own lines. */
export function patternsFor(inst) {
  if (inst?.kind === 'database') {
    if (inst.engine === 'garnet') return { ready: GARNET_READY_RE, failed: GARNET_FAILED_RE }
    return { ready: MARIADB_READY_RE, failed: MARIADB_FAILED_RE }
  }
  return { ready: READY_RE, failed: FAILED_RE }
}
