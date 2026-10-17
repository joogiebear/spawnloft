import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import signing from '../desktop/mac-signing.cjs'
import notes from '../desktop/preview-notes.cjs'

const credentials = { CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture', APPLE_ID: 'test@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'AB12345678', GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/dev' }

test('signing fails closed on incomplete credentials or untrusted refs/events', () => {
  assert.doesNotThrow(() => signing.requireCredentials(credentials))
  assert.doesNotThrow(() => signing.requireCredentials({ ...credentials, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch' }))
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.throws(() => signing.requireCredentials({ ...credentials, [key]: '' }), /Missing Mac signing credentials/)
  }
  for (const change of [{ GITHUB_REF: 'refs/heads/untrusted' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' }, { APPLE_TEAM_ID: 'bad' }]) {
    assert.throws(() => signing.requireCredentials({ ...credentials, ...change }))
  }
  assert.equal(signing.signingMode({}), 'ad-hoc')
  assert.throws(() => signing.signingMode({ MAC_SIGNING_MODE: 'typo' }))
})

test('signed verification refuses ad-hoc, wrong team, missing runtime or timestamp', () => {
  const good = 'CodeDirectory v=20500 size=700 flags=0x10000(runtime) hashes=10+7 location=embedded\nAuthority=Developer ID Application: Fixture (AB12345678)\nTimestamp=Sep 11, 2026 at 1:00:00 PM\nTeamIdentifier=AB12345678\n'
  assert.doesNotThrow(() => signing.verifySignatureDetails(good, 'signed', 'AB12345678'))
  for (const broken of [good.replace('AB12345678\n', 'ZZ12345678\n'), good.replace('runtime', 'none'),
    good.replace('Timestamp=', 'Missing='), good.replace('Developer ID Application:', 'Apple Development:'),
    good + 'Signature=adhoc\n']) {
    assert.throws(() => signing.verifySignatureDetails(broken, 'signed', 'AB12345678'))
  }
  assert.doesNotThrow(() => signing.verifySignatureDetails('Signature=adhoc\n', 'ad-hoc'))
  assert.throws(() => signing.verifySignatureDetails(good, 'ad-hoc'))
})

test('stapler validation retries a CloudKit blip, keeps the output, and fails closed', async () => {
  const calls = []
  const logs = []
  const waits = []
  const flaky = (statuses) => (command, args) => {
    calls.push([command, ...args])
    const status = statuses.shift()
    return { status, stdout: `Processing: ${args[2]}\n`, stderr: status ? 'CloudKit query failed\n' : '' }
  }
  const opts = { sleep: ms => { waits.push(ms); return Promise.resolve() }, log: m => logs.push(m), pauseMs: 7 }
  assert.equal(await signing.validateStapled('/tmp/App.app', { ...opts, run: flaky([68, 68, 0]) }), 3)
  assert.deepEqual(calls[0], ['xcrun', 'stapler', 'validate', '/tmp/App.app'])
  assert.deepEqual(waits, [7, 7])
  assert.match(logs[0], /exit 68.*attempt 1 of 4/s)
  assert.match(logs[0], /CloudKit query failed/)
  await assert.rejects(signing.validateStapled('/tmp/App.app', { ...opts, run: flaky([65, 65, 65, 65]) }), /did not validate after 4 attempts \(exit 65\)/)
  assert.equal(calls.length, 7)
})

test('release notes describe verified signing mode without changing Windows preview status', () => {
  const template = fs.readFileSync(new URL('../desktop/PREVIEW.md', import.meta.url), 'utf8')
  assert.equal(notes.renderPreviewNotes(template, 'ad-hoc'), template)
  const signed = notes.renderPreviewNotes(template, 'signed')
  assert.match(signed, /Developer ID signed and Apple-notarized/)
  assert.doesNotMatch(signed, /not Apple-notarized|ad-hoc signed/)
  assert.match(signed, /Windows development beta.*unsigned/s)
  assert.throws(() => notes.renderPreviewNotes('No status block', 'signed'))
})
