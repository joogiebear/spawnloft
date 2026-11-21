// The C3 behaviour fixture (files.mjs and config-files.mjs over a server folder) is what the
// Node modules make today: the Rust side is tested against it, so a stale file would test it
// against nothing. Regenerate with node tools/parity/make-c3-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { made } from '../tools/parity/make-c3-fixtures.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contracts')

// Windows lists a folder in its own order, not byte order, so a search answers in another order
// there; the fixture is made where readdir is byte-ordered, as on every other platform
test('the C3 fixture matches what the Node modules make', { skip: process.platform === 'win32' ? 'readdir order differs on Windows' : false }, () => {
  for (const [name, text] of Object.entries(made())) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n'), text, `${name} is stale: run node tools/parity/make-c3-fixtures.mjs`)
  }
})
