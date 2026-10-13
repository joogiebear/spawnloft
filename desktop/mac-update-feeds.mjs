import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Apple Silicon is the only Mac architecture built, so the channel file lists one ZIP
export function prepareMacFeeds(dir, verified) {
  if (verified.macSigningMode !== 'signed') return []
  const files = ['arm64'].map(arch => {
    const name = `SpawnLoft-${verified.version}-mac-${arch}.zip`
    const artifact = verified.assets.find(a => a.name === name)
    if (!artifact) throw new Error(`Missing verified Mac ZIP: ${name}`)
    const bytes = fs.readFileSync(path.join(dir, name))
    if (bytes.length !== artifact.size || crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Mac ZIP changed after verification')
    return { url: name, sha512: crypto.createHash('sha512').update(bytes).digest('base64'), size: bytes.length }
  })
  // JSON is valid YAML, so electron-updater's reader accepts it. Hashes come from the verified
  // bytes, never from an independently uploaded feed.
  const body = JSON.stringify({ version: verified.version, files, path: files[0].url, sha512: files[0].sha512 }, null, 2) + '\n'
  return ['beta-mac.yml', 'latest-mac.yml'].map(name => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return { name, path: file, size: Buffer.byteLength(body), sha256: crypto.createHash('sha256').update(body).digest('hex') }
  })
}
