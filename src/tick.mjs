import { Rcon, stripColors } from './rcon.mjs'

// TPS and player counts only exist inside the JVM, so they are read over RCON. The assistant
// asks once on demand; the daemon samples every ten seconds for the panel.

// Paper answers `tps` and `mspt`; vanilla and Fabric answer `tick query`.
export const TICK_COMMANDS = ['tps', 'mspt', 'tick query']

// a reply meaning the server has no such command
const REFUSED = /unknown|incorrect argument|<--\[HERE\]/i

// `send` is a one-shot connection for the assistant or the daemon's standing one. Stops at the
// first command family that answers, so Paper isn't also asked `tick query`. A command that
// throws is skipped.
export async function readTick(send) {
  const replies = {}
  for (const cmd of TICK_COMMANDS) {
    try {
      const text = stripColors((await send(cmd)) ?? '').trim()
      if (text && !REFUSED.test(text)) replies[cmd] = text
    } catch { /* RCON unavailable for this one */ }
    if (cmd === 'mspt' && replies.tps) break
  }
  return { replies, tps: parseTps(replies) }
}

// Paper: "TPS from last 1m, 5m, 15m: 20.0, 19.98, 20.0", with a leading * on a value capped at
// 20; the first figure is the one-minute average. Vanilla's `tick query` has no TPS line, only
// the target rate and average tick time, so TPS is min(target, 1000 / ms). Frozen is 0.
export function parseTps(replies) {
  const paper = /TPS from last[^:]*:\s*\*?(\d+(?:\.\d+)?)/i.exec(replies.tps ?? '')
  if (paper) return round(Number(paper[1]))
  const query = replies['tick query'] ?? ''
  if (!query) return null
  if (/frozen/i.test(query)) return 0
  const rate = /Target tick rate:\s*(\d+(?:\.\d+)?)/i.exec(query)
  const avg = /Average time per tick:\s*(\d+(?:\.\d+)?)\s*ms/i.exec(query)
  if (!rate || !avg) return null
  const target = Number(rate[1])
  const ms = Number(avg[1])
  if (!(target > 0)) return null
  return round(ms > 0 ? Math.min(target, 1000 / ms) : target)
}

// Vanilla and Paper say "There are 2 of a max of 20 players online: A, B"; Essentials replaces
// `list` and says "out of maximum". Anything else returns null.
export function parseList(text) {
  const m = /There (?:are|is) (\d+)\s*(?:\/\s*|of a max(?:imum)? of |out of (?:a )?maximum(?: of)? )(\d+)/i
    .exec(stripColors(text ?? ''))
  return m ? { online: Number(m[1]), max: Number(m[2]) } : null
}

const round = (n) => Math.round(n * 100) / 100

// Uses one standing RCON connection: every connection the server accepts logs two console
// lines ("Thread RCON Client started" / "shutting down"), which at one reading per ten seconds
// would flood the console. Reopened only if it drops. latest() returns null once a reading is
// older than three intervals, so a silent server doesn't look healthy.
export function startTickSampler(inst, { intervalMs = 10000, timeoutMs = 8000, onError = () => {} } = {}) {
  const port = inst?.rcon?.port
  const password = inst?.rcon?.password
  if (!port || !password) return { latest: () => null, stop: () => {} }

  let rcon = null
  let busy = false
  let stopped = false
  let reading = null
  let failures = 0

  const drop = () => {
    try { rcon?.close() } catch { /* already gone */ }
    rcon = null
  }

  const sample = async () => {
    if (busy || stopped) return
    busy = true
    try {
      if (!rcon || rcon.socket?.destroyed) {
        drop()
        const next = new Rcon({ port, password, timeout: timeoutMs })
        await next.connect()
        if (stopped) { next.close(); return }
        // the client's socket timeout is an idle timeout that tears the connection down, which
        // is wrong for a connection that sits quiet between readings; replies keep their own limit
        next.socket.setTimeout(0)
        rcon = next
      }
      const send = (cmd) => rcon.send(cmd)
      const { tps } = await readTick(send)
      const players = parseList(await send('list'))
      reading = { at: Date.now(), tps, online: players?.online ?? null, max: players?.max ?? null }
      failures = 0
    } catch (err) {
      drop()
      // refused connections are normal while the server starts; only log repeated failures
      // after it has answered once
      if (reading && ++failures === 3) onError(err)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(sample, intervalMs)
  timer.unref?.()
  sample()

  return {
    latest() {
      if (!reading || Date.now() - reading.at > intervalMs * 3) return null
      return reading
    },
    stop() {
      stopped = true
      clearInterval(timer)
      drop()
    },
  }
}
