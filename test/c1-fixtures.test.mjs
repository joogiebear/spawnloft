// The C1 behaviour fixtures (diagnose, run-time patterns, numbers) are what the Node modules
// make today: the Rust side is tested against them, so a stale file would test it against
// nothing. Regenerate with node tools/parity/make-c1-fixtures.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { made } from '../tools/parity/make-c1-fixtures.mjs'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contracts')

test('the C1 fixtures match what the Node modules make', () => {
  for (const [name, made_] of Object.entries(made())) {
    // diagnose's EULA advice joins the folder with path.join, so Windows makes backslashes
    const text = made_.replaceAll('\\\\srv\\\\smp\\\\eula.txt', '/srv/smp/eula.txt')
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n'), text, `${name} is stale: run node tools/parity/make-c1-fixtures.mjs`)
  }
})
