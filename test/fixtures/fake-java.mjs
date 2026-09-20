/**
 * A JVM stand-in for the lifecycle tests.
 *
 * <p>The daemon runs it in place of java (any `java` ending in .mjs is routed to this Node), with
 * the JVM arguments passed through and ignored. It prints what a server prints at the moments the
 * supervisor watches for, and obeys the console lines the daemon writes to it:
 *
 * <ul>
 *   <li>`stop`  - prints a shutdown line and exits 0, the way a real server does.</li>
 *   <li>`crash` - exits 3 with a ticking exception in the console, so crash recovery can be
 *       exercised.</li>
 *   <li>`hang`  - stops reading the console, so a graceful stop has to time out and be forced.</li>
 *   <li>`fork`  - starts a helper process of its own and prints its pid, the way a JVM running a
 *       plugin that shells out does, so that a force kill can be checked to reach it too.</li>
 *   <li>anything else is echoed, which is how a test proves a line reached the server.</li>
 * </ul>
 *
 * <p>FAKE_JAVA_FAIL=start makes it die during startup the way a server with a taken port does.
 */
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
  if (line === 'hang') {
    rl.close()
    process.stdin.pause()
    return
  }
  say(`fake got: ${line}`)
})

// Keep running whatever happens to stdin; a real JVM does not exit because its console closed.
setInterval(() => {}, 1 << 30)
