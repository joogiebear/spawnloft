'use strict';
// -------------------------------------------------------------- servers ----

const STATE_TEXT = {
  running: 'Running',
  stopped: 'Stopped',
  reachable: 'Reachable',
  unreachable: 'Unreachable',
  stopping: 'Stopping…',
  orphaned: 'Out of reach',
  stale: 'Not shut down cleanly',
  unknown: 'Unavailable',
};

// The states nobody can be expected to know the meaning of. Saying it here beats a support
// question, and each one names its way out.
const STATE_NOTE = {
  orphaned: ['Still running, but out of reach.', 'The part of SpawnLoft that looked after this server has gone, so it cannot be stopped the usual way or sent commands. Force stop it, then start it again.'],
  stale: ['Not shut down cleanly.', 'This server stopped without shutting down cleanly, as when the computer goes off while it runs. It is not running now, and starting it clears this.'],
  unknown: ['Unavailable', 'SpawnLoft could not read this server’s state. Its folder may have been moved or deleted.'],
  unreachable: ['Unreachable', 'This database runs elsewhere and is not answering at its address. Start it there, or check the host, port and password under Settings.'],
};

function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

/** A crash is a stop nobody asked for. It stays said until the next start. */
const crashedNow = (row) => Boolean(row && row.crashed) && row.status !== 'running';

