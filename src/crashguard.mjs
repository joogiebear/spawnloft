// Restart decision, kept free of I/O so it can be tested (the daemon can't be imported).
// A requested stop stays stopped. So does a clean exit: "stop" typed into the server console
// bypasses the daemon and only shows up as exit code 0. A crash restarts after a delay, but
// three crashes inside ten minutes means give up.

export const CRASH_WINDOW_MS = 10 * 60 * 1000
export const CRASH_LIMIT = 3
// long enough for the port and world file locks to be released; env override is for tests
export const RESTART_DELAY_MS = Number(process.env.MCCTL_RESTART_DELAY_MS) > 0
  ? Number(process.env.MCCTL_RESTART_DELAY_MS)
  : 10 * 1000

// `crashes` includes the one being decided about: the caller records first, then asks.
export function crashVerdict({ enabled, stopping, code, signal, crashes = [], now = Date.now() }) {
  if (stopping) return { kind: 'stay-down', why: 'stop was requested' }
  if (code === 0 && !signal) return { kind: 'stay-down', why: 'clean exit' }
  if (!enabled) return { kind: 'stay-down', why: 'auto-restart is off' }
  const recent = crashes.filter((t) => now - t <= CRASH_WINDOW_MS).length
  if (recent >= CRASH_LIMIT) return { kind: 'give-up', recent }
  return { kind: 'restart', delayMs: RESTART_DELAY_MS, recent }
}
