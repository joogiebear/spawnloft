import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-fabric-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures', 'client')

const { META_URL, loaderVersions, pickLoader, fabricVersionId, ensureFabricProfile, ensureFabricApi } = await import('../src/client-fabric.mjs')
const { mergeInherited } = await import('../src/client-meta.mjs')
const { versionJson } = await import('../src/client-paths.mjs')

const loaderListFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fabric-loader-list.json'), 'utf8'))
const fabricProfileFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'fabric-profile.json'), 'utf8'))
const vanillaFixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, '1.21.11.json'), 'utf8'))

test('loaderVersions: maps the API array and validates the url', async () => {
  let calledUrl = null
  const fetchImpl = async (url) => {
    calledUrl = url
    return loaderListFixture
  }
  const result = await loaderVersions('1.21.11', { fetchImpl })
  assert.equal(calledUrl, META_URL + '/versions/loader/1.21.11')
  assert.equal(result.length, 3)
  assert.equal(result[0].version, '0.19.6')
  assert.equal(result[0].stable, false)
  assert.equal(result[1].version, '0.19.5')
  assert.equal(result[1].stable, true)
  assert.equal(result[2].version, '0.19.4')
  assert.equal(result[2].stable, true)
})

test('pickLoader: picks the newest stable, not the unstable latest', () => {
  const list = [{ version: '0.19.6', stable: false }, { version: '0.19.5', stable: true }, { version: '0.19.4', stable: true }]
  const picked = pickLoader(list)
  assert.equal(picked.version, '0.19.5')
})

test('pickLoader: picks the wanted version', () => {
  const list = [{ version: '0.19.6', stable: false }, { version: '0.19.5', stable: true }, { version: '0.19.4', stable: true }]
  const picked = pickLoader(list, { wanted: '0.19.4' })
  assert.equal(picked.version, '0.19.4')
})

test('pickLoader: refuses an unknown wanted, naming the known versions', () => {
  const list = [{ version: '0.19.6', stable: false }, { version: '0.19.5', stable: true }, { version: '0.19.4', stable: true }]
  assert.throws(() => pickLoader(list, { wanted: '0.1.0' }), /0\.19\.6, 0\.19\.5, 0\.19\.4/)
})

test('fabricVersionId: builds the id string', () => {
  assert.equal(fabricVersionId('1.21.11', '0.19.5'), 'fabric-loader-0.19.5-1.21.11')
})

test('ensureFabricProfile: writes the JSON, returns the id, and a second call does not fetch', async () => {
  let callCount = 0
  const fetchImpl = async () => {
    callCount++
    return fabricProfileFixture
  }
  const id = await ensureFabricProfile('1.21.11', '0.19.5', { fetchImpl })
  assert.equal(id, 'fabric-loader-0.19.5-1.21.11')
  assert.equal(callCount, 1)
  assert.ok(fs.existsSync(versionJson(id)))

  const id2 = await ensureFabricProfile('1.21.11', '0.19.5', { fetchImpl })
  assert.equal(id2, 'fabric-loader-0.19.5-1.21.11')
  assert.equal(callCount, 1)
})

test('ensureFabricProfile: the written JSON merged with vanilla has Knot as main class', () => {
  const written = JSON.parse(fs.readFileSync(versionJson('fabric-loader-0.19.5-1.21.11'), 'utf8'))
  const merged = mergeInherited(written, vanillaFixture)
  assert.equal(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient')
})

test('ensureFabricProfile: throws when inheritsFrom does not match the requested mc', async () => {
  const badProfile = { ...fabricProfileFixture, id: 'fabric-loader-0.19.4-1.21.11', inheritsFrom: '1.20.1' }
  const fetchImpl = async () => badProfile
  await assert.rejects(
    ensureFabricProfile('1.21.11', '0.19.4', { fetchImpl }),
    /inherits from 1\.20\.1/,
  )
})

test('ensureFabricProfile: throws when the meta answers for another id', async () => {
  const other = { ...fabricProfileFixture, id: 'fabric-loader-0.19.5-1.21.11' }
  const fetchImpl = async () => other
  await assert.rejects(ensureFabricProfile('1.21.11', '0.19.3', { fetchImpl }), /different profile/)
})

test('ensureFabricApi is exported as a function', () => {
  assert.equal(typeof ensureFabricApi, 'function')
})
