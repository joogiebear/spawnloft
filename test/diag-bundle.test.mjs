import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-diag-'))
const data = path.join(scratch, 'data')
const instDir = path.join(data, 'instances', 'diagtest')
const runDir = path.join(data, 'run', 'diagtest')
const crashDir = path.join(instDir, 'crash-reports')
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'diag')

for (const d of [instDir, runDir, crashDir]) fs.mkdirSync(d, { recursive: true })

fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    diagtest: {
      dir: instDir,
      jar: 'paper-1.21.4-100.jar',
      memory: '2G',
      port: 25565,
    },
    neverstarted: {
      dir: path.join(data, 'instances', 'neverstarted'),
      jar: 'paper-1.21.4-100.jar',
      memory: '1G',
      port: 25566,
    },
  },
}))
fs.mkdirSync(path.join(data, 'instances', 'neverstarted'), { recursive: true })

fs.writeFileSync(path.join(runDir, 'console.log'), fs.readFileSync(path.join(fixtureDir, 'console.log')))
fs.writeFileSync(path.join(runDir, 'daemon.log'), fs.readFileSync(path.join(fixtureDir, 'daemon.log')))
fs.writeFileSync(path.join(instDir, 'server.properties'), fs.readFileSync(path.join(fixtureDir, 'server.properties')))
fs.writeFileSync(path.join(crashDir, 'crash-2026-10-20_12.00.00-server.txt'), fs.readFileSync(path.join(fixtureDir, 'crash-2026-10-20_12.00.00-server.txt')))
fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
  startedAt: new Date('2026-10-20T11:59:00.000Z').getTime(),
}))

process.env.MCCTL_DATA_ROOT = data

const { collectServer, buildBundle, writeBundle, summarise } = await import('../src/diag-bundle.mjs')
const { extractZip, zipEntries } = await import('../src/zip.mjs')
const { formatTimeline } = await import('../src/log-timeline.mjs')

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('collectServer finds the port-in-use shape and the crash report description', async () => {
  const result = await collectServer('diagtest', { lines: 100 })

  const portFinding = result.findings.find(f => f.id === 'port-in-use')
  assert.ok(portFinding, 'port-in-use finding is present')
  assert.match(portFinding.title, /port/i)

  assert.equal(result.crashes.length, 1)
  assert.equal(result.crashes[0].file, 'crash-2026-10-20_12.00.00-server.txt')
  assert.ok(result.crashes[0].description, 'crash description is present')
  assert.match(result.crashes[0].description, /OutOfMemoryError/)

  assert.equal(result.facts.name, 'diagtest')
  assert.equal(result.facts.software, 'paper')
  assert.ok(result.timeline.length > 0, 'timeline is non-empty for a started server')
})

test('a server that has never run yields an empty timeline and the never-started status', async () => {
  const result = await collectServer('neverstarted', { lines: 100 })
  assert.equal(result.facts.status, 'never started')
  assert.deepEqual(result.timeline, [])
})

test('writeBundle writes a zip whose entries are exactly the expected names', async () => {
  const bundle = await buildBundle({ server: 'diagtest', lines: 100 })
  const outDir = path.join(scratch, 'exports')
  const { file, entries: returnedEntries } = await writeBundle(bundle, { outDir })
  assert.ok(fs.existsSync(file), 'the zip file exists on disk')

  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const onDiskNames = []
    for (const entry of zipEntries(fd, size)) {
      onDiskNames.push(entry.name)
    }

    const expected = [
      'summary.json',
      'timeline.txt',
      'server-console.log',
      'server-daemon.log',
      'server.properties',
      'crash-reports/crash-2026-10-20_12.00.00-server.txt',
    ]
    assert.deepEqual(onDiskNames.sort(), expected.sort())
  } finally {
    fs.closeSync(fd)
  }

  assert.deepEqual(returnedEntries.sort(), [
    'summary.json',
    'timeline.txt',
    'server-console.log',
    'server-daemon.log',
    'server.properties',
    'crash-reports/crash-2026-10-20_12.00.00-server.txt',
  ].sort())
})

test('the rcon password is in neither summary.json nor server.properties inside the zip', async () => {
  const bundle = await buildBundle({ server: 'diagtest', lines: 100 })
  const outDir = path.join(scratch, 'exports2')
  const { file } = await writeBundle(bundle, { outDir })

  const extractTo = path.join(scratch, 'extracted')
  fs.mkdirSync(extractTo, { recursive: true })
  await extractZip(file, extractTo)

  const summary = fs.readFileSync(path.join(extractTo, 'summary.json'), 'utf8')
  assert.ok(!summary.includes('fixture-secret-never-leaves'), 'password not in summary.json')

  const props = fs.readFileSync(path.join(extractTo, 'server.properties'), 'utf8')
  assert.ok(!props.includes('fixture-secret-never-leaves'), 'password not in server.properties')
  assert.match(props, /rcon\.password=\[redacted\]/)
})

test('summarise ends with the newest timeline line', async () => {
  const bundle = await buildBundle({ server: 'diagtest', lines: 100 })
  const text = summarise(bundle)
  const lines = text.split('\n')

  let lastNonEmpty = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) { lastNonEmpty = lines[i]; break }
  }

  const newest = bundle.timeline[bundle.timeline.length - 1]
  const formatted = formatTimeline([newest])
  const formattedLines = formatted.split('\n')
  const formattedLast = formattedLines[formattedLines.length - 1]

  assert.equal(lastNonEmpty, formattedLast)
})

test('scrub reaches the timeline and the findings, not only the files', async () => {
  const bundle = await buildBundle({ server: 'diagtest', lines: 100, scrub: s => s.replace(/Steve/g, '<player>') })
  assert.ok(bundle.timeline.some(e => e.text.includes('<player>')), 'timeline text was scrubbed')
  assert.ok(!bundle.timeline.some(e => e.text.includes('Steve')), 'no unscrubbed timeline text')
  assert.ok(!summarise(bundle).includes('Steve'))
  assert.ok(!bundle.files.some(f => f.text.includes('Steve')))
})

test('summary.json names the files with their size instead of repeating the logs', async () => {
  const bundle = await buildBundle({ server: 'diagtest', lines: 100 })
  const { file } = await writeBundle(bundle, { outDir: path.join(scratch, 'exports3') })
  const extractTo = path.join(scratch, 'extracted3')
  fs.mkdirSync(extractTo, { recursive: true })
  await extractZip(file, extractTo)
  const summary = JSON.parse(fs.readFileSync(path.join(extractTo, 'summary.json'), 'utf8'))
  assert.equal(summary.timeline, undefined)
  assert.ok(summary.files.every(f => typeof f.bytes === 'number' && f.text === undefined))
  assert.ok(!JSON.stringify(summary).includes('FAILED TO BIND'))
  assert.match(summarise(bundle), /server java: |server status/)
})
