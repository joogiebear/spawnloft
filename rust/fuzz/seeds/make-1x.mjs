// How fuzz/seeds/zip_read/1x*.zip were made: run from a checkout of v1.6.0-beta.413's src/ (git archive
// v1.6.0-beta.413 src | tar -x -C <dir>; copy this file there), as node make-1x.mjs <out> <scratch>.
import fs from 'node:fs'
import path from 'node:path'
import { createZip } from './src/zip.mjs'
const [out, seed] = process.argv.slice(2)
fs.mkdirSync(path.join(seed, 'w/d'), { recursive: true })
fs.mkdirSync(path.join(seed, 'w/region'), { recursive: true })
fs.writeFileSync(path.join(seed, 'w/level.dat'), 'level '.repeat(500))
fs.writeFileSync(path.join(seed, 'w/d/ü.txt'), 'hi\n')
fs.writeFileSync(path.join(seed, 'w/empty'), '')
let x = 1; const rnd = Buffer.alloc(4096); for (let i = 0; i < rnd.length; i++) { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; rnd[i] = x & 0xff }
fs.writeFileSync(path.join(seed, 'w/region/r.0.0.mca'), rnd)
fs.writeFileSync(path.join(seed, 'w/session.lock'), 'lock')
fs.mkdirSync(out, { recursive: true })
for (const [name, opts] of [['1x.zip', {}], ['1x-zip64.zip', { forceZip64: true }], ['1x-exclude.zip', { exclude: ['session.lock'] }]]) {
  const made = await createZip(path.join(out, name), seed, ['w'], opts)
  console.log(name, made.entries)
}
