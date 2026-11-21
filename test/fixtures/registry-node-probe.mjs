// The Node twin of rust/crates/spawnloft-fakes/src/bin/registry-probe.rs: the same commands and
// the same output, through src/registry.mjs, run as its own process. The registry file named is
// <data root>/instances.json, so the data root is set from it before registry.mjs loads.
//
//   node registry-node-probe.mjs put <registry> <name> <json>
//   node registry-node-probe.mjs update <registry> <name> <json>    prints the record
//   node registry-node-probe.mjs remove <registry> <name>
//   node registry-node-probe.mjs many <registry> <prefix> <n>
//   node registry-node-probe.mjs free <registry> <base>
import fs from 'node:fs'
import path from 'node:path'

const [cmd, file, ...rest] = process.argv.slice(2)
process.env.SPAWNLOFT_DATA_ROOT = path.dirname(path.resolve(file))
const { putInstance, updateInstance, removeInstance, freeName } = await import('../../src/registry.mjs')
const say = (line) => fs.writeSync(1, `${line}\n`)

try {
  if (cmd === 'put') putInstance(rest[0], JSON.parse(rest[1]))
  else if (cmd === 'update') say(JSON.stringify(updateInstance(rest[0], JSON.parse(rest[1]))))
  else if (cmd === 'remove') removeInstance(rest[0])
  else if (cmd === 'many') {
    for (let i = 0; i < Number(rest[1]); i++) putInstance(`${rest[0]}-${i}`, { port: 30000 + i, by: 'node' })
  } else if (cmd === 'free') say(freeName(rest[0]))
  else throw new Error(`unknown command ${cmd}`)
} catch (err) {
  say(`error: ${err.message}`)
  process.exitCode = 1
}
