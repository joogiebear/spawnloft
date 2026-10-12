import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mcOf, pickBuild } from '../src/neoforge.mjs'
import { parseModsToml } from '../src/plugins.mjs'

test('a NeoForge version names its Minecraft version, zero patch spelled out', () => {
  assert.equal(mcOf('26.2.0.75'), '26.2')
  assert.equal(mcOf('26.1.2.14'), '26.1.2')
  assert.equal(mcOf('21.1.0.186'), '21.1')
  assert.equal(mcOf('not-a-version'), null)
  assert.equal(mcOf('26.2.0.76-beta'), '26.2', 'a beta still names its Minecraft version')
})

test('the newest stable build for a version wins; betas only exist when nothing else does', () => {
  const all = ['26.1.2.13', '26.1.2.14', '26.2.0.74', '26.2.0.75', '26.2.0.76-beta']
  assert.equal(pickBuild(all, '26.2'), '26.2.0.75')
  assert.equal(pickBuild(all, '26.1.2'), '26.1.2.14')
  assert.equal(pickBuild(all, '25.4'), null)
  assert.equal(pickBuild(['26.3.0.1-beta'], '26.3'), '26.3.0.1-beta')
})

const TOML = `
modLoader = "javafml"
loaderVersion = "[4,)"
license = "MIT"

[[mods]]
modId = "examplemod"
version = "1.4.2"
displayName = "Example Mod"
authors = "someone, someone else"
description = '''
Does example things,
across two lines.
'''

[[dependencies.examplemod]]
modId = "neoforge"
`

test('the first [[mods]] block yields the fields the list needs', () => {
  const meta = parseModsToml(TOML)
  assert.equal(meta.name, 'Example Mod')
  assert.equal(meta.version, '1.4.2')
  assert.deepEqual(meta.authors, ['someone, someone else'])
  assert.match(meta.description, /across two lines/)
})

test('a jar-manifest version placeholder resolves from the jar manifest', () => {
  const toml = '[[mods]]\nmodId = "x"\nversion = "${file.jarVersion}"\n'
  assert.equal(parseModsToml(toml, { jarVersion: '2.7.1' }).version, '2.7.1')
  assert.equal(parseModsToml(toml, {}).version, null)
})

test('a file with no [[mods]] block is null, not a guess', () => {
  assert.equal(parseModsToml('modLoader = "javafml"\n'), null)
})
