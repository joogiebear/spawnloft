import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setPackageVersion, VERSION_RE } from '../desktop/set-version.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('only versions the release pipeline can use are accepted', () => {
  for (const ok of ['1.2.0', '1.3.0-beta.1', '10.0.12-beta.59']) assert.match(ok, VERSION_RE)
  // The preview pipeline numbers betas itself and refuses anything else after the dash.
  for (const bad of ['1.2', 'v1.2.0', '1.2.0-rc.1', '1.2.0-beta', '1.2.0-beta.0', '1.2.0-beta.01', '']) assert.doesNotMatch(bad, VERSION_RE)
})

test('a package.json changes its own version and nothing else, line endings included', () => {
  const text = '{\r\n  "name": "x",\r\n  "version": "1.1.0",\r\n  "dependencies": { "y": { "version": "1.1.0" } }\r\n}\r\n'
  const { text: next, from } = setPackageVersion(text, '1.2.0-beta.1')
  assert.equal(from, '1.1.0')
  assert.equal(next, text.replace('"version": "1.1.0",', '"version": "1.2.0-beta.1",'))
  assert.throws(() => setPackageVersion('{ "name": "x" }', '1.2.0'), /no version field/)
})

test('the two places the version is written agree, which a release refuses to go out without', () => {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  const core = read('package.json').version
  assert.equal(read('desktop/package.json').version, core)
  assert.match(core, VERSION_RE)
})
