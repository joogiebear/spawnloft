// Inventory of the block types present in a world's region files.
//
// Each region file starts with a 4096-byte location table (1024 entries: 3-byte sector offset,
// 1-byte sector count). A present chunk starts with a 4-byte payload length and a 1-byte
// compression id (1 gzip, 2 zlib, 3 raw), then compressed NBT.
//
// Instead of a full NBT reader it decompresses each chunk and scans for `minecraft:<id>` strings,
// which are mostly block-state palette entries. It counts chunks containing a block, not blocks:
// a type in 500 chunks is widespread, one in 3 is incidental.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const DIR = process.argv[2]
const LIMIT = Number(process.argv[3] || 0) // optional: max region files

const NAME = /minecraft:[a-z0-9_]+/g

const chunksWith = new Map()
let regionsRead = 0
let chunksRead = 0
let failures = 0

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.mca'))
  .sort()

for (const name of files) {
  if (LIMIT && regionsRead >= LIMIT) break
  const file = path.join(DIR, name)
  const buf = fs.readFileSync(file)
  if (buf.length < 4096) continue
  regionsRead++

  for (let i = 0; i < 1024; i++) {
    const off = (buf[i * 4] << 16) | (buf[i * 4 + 1] << 8) | buf[i * 4 + 2]
    const sectors = buf[i * 4 + 3]
    if (!off || !sectors) continue

    const start = off * 4096
    if (start + 5 > buf.length) continue
    const length = buf.readInt32BE(start)
    const compression = buf[start + 4]
    const payload = buf.subarray(start + 5, start + 4 + length)
    if (!payload.length) continue

    let raw
    try {
      if (compression === 1) raw = zlib.gunzipSync(payload)
      else if (compression === 2) raw = zlib.inflateSync(payload)
      else if (compression === 3) raw = payload
      else continue
    } catch {
      failures++
      continue
    }
    chunksRead++

    // Distinct names per chunk, so one chunk cannot inflate a count.
    const seen = new Set(raw.toString('latin1').match(NAME) || [])
    for (const id of seen) {
      chunksWith.set(id, (chunksWith.get(id) || 0) + 1)
    }
  }
}

const CATEGORIES = [
  ['TREES  (logs / wood)', /_(log|wood)$/],
  ['LEAVES', /_leaves$/],
  ['CROPS / farm', /^minecraft:(wheat|carrots|potatoes|beetroots|melon|pumpkin|sugar_cane|cactus|sweet_berry_bush|cocoa|nether_wart|bamboo|kelp|sea_pickle)$/],
  ['ORES', /(_ore|^minecraft:ancient_debris)$/],
  ['SAPLINGS', /_sapling$/],
]

console.log(`regions read: ${regionsRead}   chunks read: ${chunksRead}   unreadable: ${failures}`)
console.log(`distinct minecraft: ids seen: ${chunksWith.size}`)

for (const [title, re] of CATEGORIES) {
  const hits = [...chunksWith.entries()]
    .filter(([id]) => re.test(id))
    .sort((a, b) => b[1] - a[1])
  console.log('')
  console.log(`=== ${title} ===`)
  if (!hits.length) {
    console.log('  (none)')
    continue
  }
  for (const [id, count] of hits) {
    console.log(`  ${String(count).padStart(6)} chunks   ${id}`)
  }
}
