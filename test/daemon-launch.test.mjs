// Which daemon runs a server: SPAWNLOFT_DAEMON, then settings.json, then an internal build's default.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { daemonChoice } = await import('../src/daemon-launch.mjs')

test('node unless something says rust; an internal build defaults to rust', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-dl-'))
  const internal = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-dl-'))
  fs.writeFileSync(path.join(internal, 'internal-defaults.json'), '{"daemon":"rust"}\n')
  try {
    assert.equal(daemonChoice({}, {}, plain), 'node')
    assert.equal(daemonChoice({ SPAWNLOFT_DAEMON: 'rust' }, {}, plain), 'rust')
    assert.equal(daemonChoice({}, { daemon: 'rust' }, plain), 'rust')
    assert.equal(daemonChoice({}, {}, internal), 'rust')
    // the tester can still pick the Node daemon in an internal build
    assert.equal(daemonChoice({ SPAWNLOFT_DAEMON: 'node' }, {}, internal), 'node')
    assert.equal(daemonChoice({}, { daemon: 'node' }, internal), 'node')
  } finally {
    fs.rmSync(plain, { recursive: true, force: true })
    fs.rmSync(internal, { recursive: true, force: true })
  }
})
