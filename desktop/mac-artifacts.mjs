import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const arch = process.argv[2]
if (!['arm64', 'x64'].includes(arch)) throw new Error('Expected arm64 or x64')
const info = JSON.parse(fs.readFileSync(path.join(here, 'dist/build-info.json'), 'utf8'))
if (!info.version.includes('-') || info.dirty || !info.commit) throw new Error('A clean prerelease build is required')
const assets = ['dmg', 'zip'].map(ext => {
  const name = `SpawnLoft-${info.version}-mac-${arch}.${ext}`
  const bytes = fs.readFileSync(path.join(here, 'dist', name))
  if (!bytes.length) throw new Error(`Empty artifact: ${name}`)
  return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
})
fs.writeFileSync(path.join(here, 'dist', `mac-build-${arch}.json`), JSON.stringify({ ...info, arch, assets }, null, 2) + '\n')
