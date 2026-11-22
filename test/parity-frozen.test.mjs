// The frozen parity records (tools/parity/frozen/, C10): what the Node core did in every scenario
// on each platform the parity job runs, which the Rust core is held to once the Node core is gone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadScenarios } from '../tools/parity/run.mjs'
import { neutralizer, recordOf, sideOfRecord, compareSides, frozenFile, FROZEN_DIR } from '../tools/parity/lib/rig.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const parity = path.join(repo, 'tools', 'parity')
// the parity job's runners (rust-internal.yml): Linux x64 and arm64, Windows x64, macOS arm64
const PLATFORMS = [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'arm64']]

const runsOn = (s, platform, arch) => !s.platforms || s.platforms.includes(platform) || s.platforms.includes(`${platform}-${arch}`)

test('every scenario has a frozen record for each platform it runs on, and no record is left over', () => {
  const all = loadScenarios([path.join(parity, 'scenarios'), path.join(parity, 'selftest')])
  for (const [platform, arch] of PLATFORMS) {
    const key = `${platform}-${arch}`
    const want = all.filter(s => s.frozen !== false && runsOn(s, platform, arch)).map(s => s.name).sort()
    const dir = path.join(repo, FROZEN_DIR, key)
    const have = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort() : []
    assert.deepEqual(have.filter(n => !want.includes(n)), [], `${key}: records with no scenario`)
    assert.deepEqual(want.filter(n => !have.includes(n)), [], `${key}: scenarios with no record`)
    for (const name of have) {
      const r = JSON.parse(fs.readFileSync(frozenFile(repo, name, key), 'utf8'))
      assert.equal(r.scenario, name)
      assert.equal(r.platform, key)
      assert.ok(Array.isArray(r.steps) && Array.isArray(r.requests) && r.tree && typeof r.tree === 'object', `${key}/${name} has steps, requests and a tree`)
    }
  }
})

test('a record names the machine\'s paths, the fake hosts\' ports and the rig\'s pid', () => {
  const paths = { run: '/tmp/sl-parity-abc/x/run', repo: '/home/me/spawnloft', node: '/usr/bin/node', core: '/home/me/spawnloft/rust/target/debug/spawnloft-core' }
  const neutral = neutralizer({ paths, hostMap: { 'https://fill.papermc.io': 'http://127.0.0.1:4100', 'https://api.modrinth.com': 'http://127.0.0.1:41000' }, rigPid: 777 })
  assert.equal(neutral('at /tmp/sl-parity-abc/x/run/data from 127.0.0.1:41000 and 127.0.0.1:4100, pid 777, 7777'),
    'at <run>/data from <fake https://api.modrinth.com> and <fake https://fill.papermc.io>, pid <rig-pid>, 7777')
  const side = {
    steps: [{ label: 'step 1 (list)', args: ['list'], code: 0, signal: null, stdout: 'in /tmp/sl-parity-abc/x/run\n', stderr: '', frozen: true },
      { label: 'step 2 (doctor)', args: ['doctor'], code: 0, signal: null, stdout: 'machine-dependent', stderr: '', frozen: false }],
    requests: [{ url: '/v3/projects/paper', origin: 'https://fill.papermc.io' }],
    tree: new Map([['data/instances.json', { kind: 'file', mode: '644', text: '{"dir":"/tmp/sl-parity-abc/x/run/data/a"}' }]]),
  }
  const record = recordOf(side, neutral)
  assert.equal(record.steps.length, 1, 'a step marked frozen: false is left out')
  assert.equal(record.steps[0].stdout, 'in <run>\n')
  assert.equal(record.tree['data/instances.json'].text, '{"dir":"<run>/data/a"}')
  // a record read back compares as a side: equal to itself, and a change shows
  assert.deepEqual(compareSides(sideOfRecord(record), sideOfRecord(record)), [])
  const changed = recordOf({ ...side, steps: [{ ...side.steps[0], code: 1 }] }, neutral)
  assert.deepEqual(compareSides(sideOfRecord(record), sideOfRecord(changed), ['frozen', 'rust']).map(d => d.what), ['step 1 (list): exit code'])
})
