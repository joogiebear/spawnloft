import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-version-drift-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { checkDrift, report, BASELINE_FILE } = await import('../tools/check-version-drift.mjs')
const { MANIFEST_URL } = await import('../src/client-meta.mjs')
const { RUNTIME_INDEX_URL } = await import('../src/client-java.mjs')
const { META_URL } = await import('../src/client-fabric.mjs')

const fixture = (...p) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'client', ...p), 'utf8'))
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))

// Mojang and Fabric as the fixtures have them, with 26.3 the newest release and `snapshot` the
// newest snapshot.
function world(snapshot) {
  const release = fixture('versions', '26.3.json')
  const manifest = fixture('version_manifest_v2.json')
  const url = (id) => `https://piston-meta.mojang.com/v1/packages/test/${id}.json`
  manifest.latest = { release: '26.3', snapshot: snapshot.id }
  manifest.versions = [{ id: snapshot.id, type: 'snapshot', url: url(snapshot.id) }, { id: '26.3', type: 'release', url: url('26.3') }, ...manifest.versions.filter((v) => v.id !== '26.3')]
  const loaders = fixture('fabric-loader-list.json')
  const answers = new Map([
    [MANIFEST_URL, manifest],
    [url('26.3'), release],
    [url(snapshot.id), snapshot],
    [`${META_URL}/versions/loader/26.3`, loaders],
    [release.assetIndex.url, fixture('assets', 'objects.json')],
    [snapshot.assetIndex.url, fixture('assets', snapshot.id === '27.1' ? 'future-pack.json' : 'objects.json')],
    [RUNTIME_INDEX_URL, fixture('java-runtime-all.json')],
  ])
  return async (u) => {
    if (answers.has(u)) return structuredClone(answers.get(u))
    if (u.startsWith(`${META_URL}/versions/loader/26.3/`) && u.endsWith('/profile/json')) return fixture('fabric-profile-26.3.json')
    throw new Error(`no answer for ${u}`)
  }
}

test('the formats of today pass, and the baseline is what they show', async () => {
  const result = await checkDrift({ get: world(fixture('versions', '26.4-snapshot-6.json')), baseline })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.facts, baseline, 'tools/version-drift-baseline.json matches the fixtures')
  // three versions (release, snapshot, release + Fabric), seven machines, two feature sets
  assert.equal(result.rows.length, 3 * 7 * 2)
  assert.ok(result.rows.some((r) => r.pair === 'linux-arm64' && r.result === 'no-natives-for-this-machine'), 'Linux arm64 is only noted')
  assert.match(report(result), /^\*\*No drift\.\*\*/)
})

test('a snapshot in a format SpawnLoft does not know fails the check, naming each thing', async () => {
  const result = await checkDrift({ get: world(fixture('future.json')), baseline })
  const text = result.failures.join('\n')
  assert.match(text, /^27\.1 \(snapshot\): Minecraft 27\.1 needs launcher format 22; this SpawnLoft knows 21\. Update SpawnLoft\. \(on windows-x64, windows-x64 \(all flags\), /m)
  assert.match(text, /launcher setting SpawnLoft does not know \(\$\{render_backend\}\)/)
  assert.match(text, /platform rule SpawnLoft does not know \("os\.kernel"\)/)
  assert.match(text, /platform rule SpawnLoft does not know \("os\.versionRange" on macOS, "os\.kernel"\)\. Update SpawnLoft\. \(on osx-arm64/)
  assert.match(text, /asset index 37 is laid out in a way SpawnLoft does not know/)
  // the release still passes: every failure is the snapshot's
  assert.ok(result.failures.every((f) => f.startsWith('27.1')), text)
  assert.match(report(result), /^\*\*\d+ problem\(s\)\*\*/)
})

test('an unreadable list, a manifest type the picker does not know and a missing runtime each fail', async () => {
  const down = await checkDrift({ get: async () => { throw new Error('offline') }, baseline })
  assert.deepEqual(down.failures, ['the version list: offline'])

  const base = world(fixture('versions', '26.4-snapshot-6.json'))
  const odd = async (u) => {
    const body = await base(u)
    if (u === MANIFEST_URL) body.versions.push({ id: 'x', type: 'april_fools', url: 'https://example.invalid/x.json' })
    if (u === RUNTIME_INDEX_URL) body.linux['java-runtime-epsilon'] = []
    return body
  }
  const result = await checkDrift({ get: odd, baseline })
  assert.ok(result.failures.includes('the version list has types the picker does not know: april_fools'))
  assert.ok(result.failures.some((f) => /has no java-runtime-epsilon \(for 26\.3 \(release\)\) on linux/.test(f)))
})
