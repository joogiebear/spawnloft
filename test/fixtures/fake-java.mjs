/**
 * JVM stand-in for the lifecycle tests. The daemon runs it in place of java (any java ending in
 * .mjs is routed to this Node) and the JVM arguments are ignored. It prints what a server prints
 * when the supervisor is watching, and obeys these console lines:
 *
 *   stop        prints a shutdown line and exits 0
 *   crash       exits 3 with a ticking exception in the console
 *   hang        stops reading the console, so a graceful stop times out and is forced
 *   closestdin  closes its console input, so the daemon's next write fails with EPIPE while the
 *               process keeps running
 *   fork        starts a helper process and prints its pid, so a force kill can be checked to reach it
 *   anything else is echoed, which proves a line reached the server
 *
 * FAKE_JAVA_FAIL=start makes it die during startup the way a taken port does.
 */
import fs from 'node:fs'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

const say = (line) => process.stdout.write(`[00:00:00 INFO]: ${line}\n`)

say(`Starting minecraft server (fake) with ${process.argv.slice(2).join(' ')}`)
if (process.env.FAKE_JAVA_FAIL === 'start') {
  say('Failed to start the minecraft server')
  process.exit(1)
}

setTimeout(() => say('Done (0.042s)! For help, type "help"'), 150)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (raw) => {
  const line = raw.trim()
  if (line === 'stop') {
    say('Stopping server')
    process.exit(0)
  }
  if (line === 'crash') {
    say('Exception ticking world')
    process.exit(3)
  }
  if (line === 'fork') {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
    say(`forked helper pid ${helper.pid}`)
    return
  }
  if (line === 'closestdin') {
    rl.close()
    process.stdin.destroy()
    // destroy() alone leaves the descriptor open on a pipe; closing fd 0 is what makes the
    // writer's next write fail.
    try {
      fs.closeSync(0)
    } catch {
      /* already closed */
    }
    return
  }
  if (line === 'hang') {
    rl.close()
    process.stdin.pause()
    return
  }
  say(`fake got: ${line}`)
})

// Keep running whatever happens to stdin; a real JVM does not exit because its console closed.
setInterval(() => {}, 1 << 30)
