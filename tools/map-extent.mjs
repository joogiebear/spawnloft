// Classifies each region as real content or void stubs and reports the true built extent.
// A chunk occupying a single 4 KiB sector is empty air, so regions made only of those are
// excluded or they inflate the extent.
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.argv[2]
const REAL_SECTOR_MIN = 2

const regions = []
for (const name of fs.readdirSync(DIR)) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name)
  if (!m) continue
  const rx = Number(m[1])
  const rz = Number(m[2])

  const fd = fs.openSync(path.join(DIR, name), 'r')
  const header = Buffer.alloc(4096)
  fs.readSync(fd, header, 0, 4096, 0)
  fs.closeSync(fd)

  let written = 0
  let real = 0
  for (let i = 0; i < 1024; i++) {
    const off = (header[i * 4] << 16) | (header[i * 4 + 1] << 8) | header[i * 4 + 2]
    const sectors = header[i * 4 + 3]
    if (off !== 0 && sectors !== 0) {
      written++
      if (sectors >= REAL_SECTOR_MIN) real++
    }
  }
  regions.push({ name, rx, rz, written, real })
}

const content = regions.filter((r) => r.real > 0)
const stubs = regions.filter((r) => r.real === 0)

const span = (list, key) => [
  Math.min(...list.map((r) => r[key])),
  Math.max(...list.map((r) => r[key])),
]

console.log(`total regions: ${regions.length}`)
console.log(`  with real terrain: ${content.length}`)
console.log(`  void stubs only:   ${stubs.length}  (${stubs.map((s) => s.name).join(', ')})`)

const [minx, maxx] = span(content, 'rx')
const [minz, maxz] = span(content, 'rz')
console.log('')
console.log('TRUE BUILT EXTENT (regions with real terrain)')
console.log(`  region  x ${minx}..${maxx}   z ${minz}..${maxz}`)
console.log(`  block   x ${minx * 512}..${(maxx + 1) * 512 - 1}   z ${minz * 512}..${(maxz + 1) * 512 - 1}`)
console.log(`  size    ${(maxx - minx + 1) * 512} x ${(maxz - minz + 1) * 512} blocks`)

// the 3000x2500 render covered regions x -3..2, z -3..2
const covered = content.filter((r) => r.rx >= -3 && r.rx <= 2 && r.rz >= -3 && r.rz <= 2)
console.log('')
console.log(`content regions inside the 3000x2500 render: ${covered.length} / ${content.length}`)
const outside = content.filter((r) => !(r.rx >= -3 && r.rx <= 2 && r.rz >= -3 && r.rz <= 2))
console.log(`content regions OUTSIDE it: ${outside.length}`)
for (const r of outside.sort((a, b) => b.real - a.real).slice(0, 12)) {
  console.log(`  ${r.name}  real chunks ${r.real}  block x ${r.rx * 512}..${(r.rx + 1) * 512 - 1} z ${r.rz * 512}..${(r.rz + 1) * 512 - 1}`)
}
