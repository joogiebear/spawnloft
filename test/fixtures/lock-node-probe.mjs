// The Node twin of rust/crates/spawnloft-fakes/src/bin/lock-probe.rs: the same commands and the
// same output, through src/util.mjs's lock, run as its own process so the lock's holder is a pid
// that is not the test's.
//
//   node lock-node-probe.mjs hold <lockfile> <ms>      `held <pid>`, keeps it <ms>, `released`
//   node lock-node-probe.mjs try <lockfile>            `got` (released at once) or `busy <pid|null>`
//   node lock-node-probe.mjs holder <lockfile>         a pid, -1, or `free`
//   node lock-node-probe.mjs count <lockfile> <counterfile> <n>
import fs from 'node:fs'
import { acquireLock, lockHolder, withLock } from '../../src/util.mjs'

const WAIT_MS = 60000
const [cmd, file, ...rest] = process.argv.slice(2)
const say = (line) => fs.writeSync(1, `${line}\n`)

if (cmd === 'hold' && rest.length === 1) {
  const release = acquireLock(file, { mode: 'wait', timeoutMs: WAIT_MS })
  say(`held ${process.pid}`)
  setTimeout(() => {
    release()
    say('released')
  }, Number(rest[0]))
} else if (cmd === 'try' && rest.length === 0) {
  const release = acquireLock(file, { mode: 'fail' })
  if (release) {
    release()
    say('got')
  } else {
    say(`busy ${lockHolder(file)}`)
  }
} else if (cmd === 'holder' && rest.length === 0) {
  const pid = lockHolder(file)
  say(pid === null ? 'free' : String(pid))
} else if (cmd === 'count' && rest.length === 2) {
  const [counter, n] = rest
  for (let i = 0; i < Number(n); i++) {
    withLock(file, () => {
      const value = Number(fs.readFileSync(counter, 'utf8').trim())
      // a gap between the read and the write, so a missing exclusion loses updates
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
      fs.writeFileSync(counter, String(value + 1))
    }, { timeoutMs: WAIT_MS })
  }
  say('done')
} else {
  process.stderr.write('usage: lock-node-probe.mjs hold <lockfile> <ms> | try <lockfile> | holder <lockfile> | count <lockfile> <counterfile> <n>\n')
  process.exit(2)
}
