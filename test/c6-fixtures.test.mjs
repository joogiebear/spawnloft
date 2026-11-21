// The C6 library fixture (players.mjs, mclogs.mjs and the scrubber) is what the Node modules make
// today: the Rust side is tested against it, so a stale file would test it against nothing.
// Regenerate with node tools/parity/make-c6-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { made } from '../tools/parity/make-c6-fixtures.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contracts')

// the fixture is made where paths use `/` and readdir is byte-ordered, as off Windows
test('the C6 fixture matches what the Node modules make', { skip: process.platform === 'win32' ? 'paths and readdir order differ on Windows' : false }, () => {
  for (const [name, text] of Object.entries(made())) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n'), text, `${name} is stale: run node tools/parity/make-c6-fixtures.mjs`)
  }
})
