import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { prepareMacFeeds } from '../desktop/mac-update-feeds.mjs'

test('signed Mac channels contain both verified ZIPs; ad-hoc packages never publish update feeds', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-feeds-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const verified = { version: '0.15.0-beta.27', macSigningMode: 'signed', assets: [] }
  for (const arch of ['arm64', 'x64']) {
    const name = `SpawnLoft-${verified.version}-mac-${arch}.zip`
    const bytes = Buffer.from(arch)
    fs.writeFileSync(path.join(dir, name), bytes)
    verified.assets.push({ name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  assert.deepEqual(prepareMacFeeds(dir, { ...verified, macSigningMode: 'ad-hoc' }), [])
  const feeds = prepareMacFeeds(dir, verified)
  assert.equal(feeds.length, 2)
  const body = fs.readFileSync(feeds[0].path, 'utf8')
  assert.equal(body, fs.readFileSync(feeds[1].path, 'utf8'))
  const parsed = JSON.parse(body)
  assert.equal(parsed.version, verified.version)
  assert.equal(parsed.files.length, 2)
  for (const file of parsed.files) assert.equal(file.sha512, crypto.createHash('sha512').update(fs.readFileSync(path.join(dir, file.url))).digest('base64'))
  fs.appendFileSync(path.join(dir, verified.assets[0].name), 'changed')
  assert.throws(() => prepareMacFeeds(dir, verified), /changed after verification/)
})
