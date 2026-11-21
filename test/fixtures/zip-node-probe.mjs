// The Node twin of rust/crates/spawnloft-fakes/src/bin/zip-probe.rs: the same commands and the
// same output, through src/zip.mjs and the jar readers of src/plugins.mjs, run as its own process.
//
//   node zip-node-probe.mjs create <zip> <cwd> [--zip64] [--exclude <name>]... -- <member>...
//   node zip-node-probe.mjs list <zip>
//   node zip-node-probe.mjs extract <zip> <dest>
//   node zip-node-probe.mjs is-zip <file>
//   node zip-node-probe.mjs jar-list <zip>
//   node zip-node-probe.mjs jar-read <zip> <name>
//   node zip-node-probe.mjs jar-extract <zip> <dest> <prefix>
import fs from 'node:fs'
import { createZip, zipEntries, extractZip, isZip } from '../../src/zip.mjs'
import { zipEntryList, readZipEntry, extractZip as extractJar } from '../../src/plugins.mjs'
import { UserError } from '../../src/util.mjs'

const [cmd, file, ...rest] = process.argv.slice(2)
const say = (line) => fs.writeSync(1, `${line}\n`)

async function run() {
  if (cmd === 'create') {
    const [cwd, ...opts] = rest
    let forceZip64 = false
    const exclude = []
    let members = []
    for (let i = 0; i < opts.length; i++) {
      if (opts[i] === '--zip64') forceZip64 = true
      else if (opts[i] === '--exclude') exclude.push(opts[++i])
      else if (opts[i] === '--') { members = opts.slice(i + 1); break }
      else throw new Error(`unknown option ${opts[i]}`)
    }
    const made = await createZip(file, cwd, members, { exclude, forceZip64 })
    return { entries: made.entries }
  }
  if (cmd === 'list') {
    const fd = fs.openSync(file, 'r')
    try {
      return [...zipEntries(fd, fs.fstatSync(fd).size)].map((e) => ({ name: e.name, madeBy: e.madeBy, flags: e.flags,
        method: e.method, crc: e.crc, packed: e.packed, size: e.size, attributes: e.attributes, offset: e.offset }))
    } finally {
      fs.closeSync(fd)
    }
  }
  if (cmd === 'extract') return await extractZip(file, rest[0])
  if (cmd === 'is-zip') return isZip(file)
  if (cmd === 'jar-list') return zipEntryList(file)
  if (cmd === 'jar-read') {
    const data = readZipEntry(file, rest[0])
    return data == null ? null : Buffer.from(data).toString('hex')
  }
  if (cmd === 'jar-extract') {
    const [dest, prefix] = rest
    return extractJar(file, dest, { mapPath: (n) => (n.startsWith(prefix) ? n.slice(prefix.length) : null) })
  }
  throw new Error(`unknown command ${cmd}`)
}

try {
  say(JSON.stringify(await run()))
} catch (err) {
  say(err instanceof UserError ? `error: ${err.message}` : String(err.stack).split('\n')[0])
  process.exitCode = 1
}
