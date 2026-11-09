/**
 * The JVM stand-in for the installer scenarios (installer.yml). Both 1.x's daemon and 2.0's run
 * a `java` ending in .mjs with their Node (1.x: SpawnLoft.exe as Node), so a server needs no jar.
 *
 * In the server folder (its cwd) it keeps evidence a CI step can read after the fact:
 *   fake-starts.log   one JSON line per start: pid, the runtime that ran it, time
 *   fake-exit.json    written on a graceful `stop`, never on a kill: a JVM that was terminated
 *                     leaves no such file
 * and obeys:
 *   stop   exits 0 after writing fake-exit.json; ignored (with a console line) while a file
 *          `ignore-stop` exists in its folder, the server that refuses to stop
 */
import fs from 'node:fs'
import readline from 'node:readline'

const say = (line) => process.stdout.write(`[00:00:00 INFO]: ${line}\n`)
fs.appendFileSync('fake-starts.log', JSON.stringify({ pid: process.pid, runtime: process.execPath, at: Date.now() }) + '\n')
try {
  fs.rmSync('fake-exit.json', { force: true })
} catch {
  /* a later stop writes it again */
}

say('Starting minecraft server (fake)')
setTimeout(() => say('Done (0.042s)! For help, type "help"'), 150)

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (raw) => {
  const line = raw.trim()
  if (line === 'stop') {
    if (fs.existsSync('ignore-stop')) {
      say('fake: ignoring stop (ignore-stop is present)')
      return
    }
    say('Stopping server')
    say('Saving worlds')
    fs.writeFileSync('fake-exit.json', JSON.stringify({ pid: process.pid, graceful: true, at: Date.now() }))
    process.exit(0)
  }
  say(`fake got: ${line}`)
})
setInterval(() => {}, 1 << 30)
