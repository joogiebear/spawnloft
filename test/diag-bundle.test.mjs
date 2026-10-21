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

const clientRoot = path.join(data, 'client')
const profDir = path.join(clientRoot, 'profiles', 'fixclient')
fs.mkdirSync(path.join(profDir, 'logs'), { recursive: true })
fs.mkdirSync(path.join(profDir, 'crash-reports'), { recursive: true })
fs.mkdirSync(path.join(profDir, 'mods'), { recursive: true })
fs.mkdirSync(path.join(clientRoot, 'run', 'fixclient'), { recursive: true })

fs.writeFileSync(path.join(clientRoot, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: {
    fixclient: {
      mc: '1.21.11',
      loader: 'fabric',
      loaderVersion: '0.19.5',
      java: null,
      memory: '2G',
      harness: false,
      server: null,
      createdAt: '2026-10-20T00:00:00.000Z',
    },
  },
}))

fs.writeFileSync(path.join(profDir, 'logs', 'latest.log'), fs.readFileSync(path.join(fixtureDir, 'client-latest.log')))
fs.writeFileSync(path.join(clientRoot, 'run', 'fixclient', 'client.log'), fs.readFileSync(path.join(fixtureDir, 'client-process.log')))
fs.writeFileSync(path.join(profDir, 'options.txt'), fs.readFileSync(path.join(fixtureDir, 'client-options.txt')))
fs.writeFileSync(path.join(profDir, 'crash-reports', 'crash-2026-10-20_14.00.06-client.txt'), fs.readFileSync(path.join(fixtureDir, 'crash-2026-10-20_14.00.06-client.txt'), 'utf8')
  + '\n\tJVM Flags: 2 total; -Xmx2G -Dspawnloft.harness.token=deadbeefdeadbeefdeadbeefdeadbeef\n')
fs.writeFileSync(path.join(profDir, 'mods', 'fabric-api-0.141.6+1.21.11.jar'), '')

// A log's mtime dates its lines, so every fixture log is pinned to the day the lines come from;
// left at "now", the server's 14:00 lines would land on today once the clock passes 14:00.
const t = new Date(2026, 9, 20, 14, 0, 10)
fs.utimesSync(path.join(profDir, 'logs', 'latest.log'), t, t)
fs.utimesSync(path.join(clientRoot, 'run', 'fixclient', 'client.log'), t, t)
fs.utimesSync(path.join(runDir, 'console.log'), t, t)

process.env.MCCTL_DATA_ROOT = data

const { collectServer, buildBundle, writeBundle, summarise, collectClient } = await import('../src/diag-bundle.mjs')
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

test('collectClient finds the connection-refused shape and the crash report', async () => {
  const result = await collectClient('fixclient', { lines: 100 })

  assert.ok(result.findings.some(f => f.id === 'connection-refused'), 'connection-refused finding is present')
  assert.deepEqual(result.facts.mods, ['fabric-api-0.141.6+1.21.11.jar'])
  assert.equal(result.facts.loader, 'fabric')
  assert.equal(result.facts.running, false)

  assert.equal(result.crashes.length, 1)
  assert.equal(result.crashes[0].description, 'Unexpected error')

  assert.ok(result.timeline.some(e => e.source === 'client'), 'timeline has client entries')
  assert.ok(result.timeline.some(e => e.source === 'client-process'), 'timeline has client-process entries')

  const refused = result.timeline.find(e => e.text.includes('Connection refused'))
  assert.ok(refused, 'Connection refused entry exists')
  assert.ok(refused.text.includes('checkConnect'), 'stack line is joined onto the entry')
})

test('collectClient keeps only what the process capture adds to latest.log', async () => {
  const latest = fs.readFileSync(path.join(fixtureDir, 'client-latest.log'), 'utf8')
  const processLog = path.join(clientRoot, 'run', 'fixclient', 'client.log')
  const before = fs.readFileSync(processLog)
  try {
    // the game prints its log lines to stdout too, so the capture is latest.log plus the JVM's own words
    fs.writeFileSync(processLog, latest + 'Error: Could not create the Java Virtual Machine.\n')
    const result = await collectClient('fixclient', { lines: 100 })
    const fromProcess = result.timeline.filter(e => e.source === 'client-process')
    assert.equal(fromProcess.length, 1, 'the duplicated lines are not in the timeline twice')
    assert.ok(fromProcess[0].text.includes('Could not create the Java Virtual Machine'))
  } finally {
    fs.writeFileSync(processLog, before)
  }
})

test('buildBundle merges server and client timelines in time order with findings on both sides', async () => {
  const bundle = await buildBundle({ server: 'diagtest', client: 'fixclient', lines: 100 })

  for (let i = 0; i < bundle.timeline.length - 1; i++) {
    assert.ok(bundle.timeline[i].at <= bundle.timeline[i + 1].at, `timeline entry ${i} <= entry ${i + 1}`)
  }

  const bindIdx = bundle.timeline.findIndex(e => e.text.includes('FAILED TO BIND TO PORT'))
  const refusedIdx = bundle.timeline.findIndex(e => e.text.includes('Connection refused'))
  assert.ok(bindIdx !== -1, 'FAILED TO BIND TO PORT entry exists')
  assert.ok(refusedIdx !== -1, 'Connection refused entry exists')
  assert.ok(bindIdx < refusedIdx, 'port-in-use comes before connection-refused in the timeline')

  assert.ok(bundle.findings.server.some(f => f.id === 'port-in-use'), 'server has port-in-use finding')
  assert.ok(bundle.findings.client.some(f => f.id === 'connection-refused'), 'client has connection-refused finding')
  assert.equal(bundle.facts.client.name, 'fixclient')
})

test('writeBundle with a client includes the four new zip entries', async () => {
  const bundle = await buildBundle({ server: 'diagtest', client: 'fixclient', lines: 100 })
  const outDir = path.join(scratch, 'exports-client')
  const { file } = await writeBundle(bundle, { outDir })
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
      'client-latest.log',
      'client-process.log',
      'options.txt',
      'client-crash-reports/crash-2026-10-20_14.00.06-client.txt',
    ]
    assert.deepEqual(onDiskNames.sort(), expected.sort())
  } finally {
    fs.closeSync(fd)
  }
})

test('summarise shows Server and Client sections with the client finding title', async () => {
  const bundle = await buildBundle({ server: 'diagtest', client: 'fixclient', lines: 100 })
  const text = summarise(bundle)
  assert.ok(text.includes('Server:'), 'has Server heading')
  assert.ok(text.includes('Client:'), 'has Client heading')
  const clientFinding = bundle.findings.client.find(f => f.id === 'connection-refused')
  assert.ok(clientFinding, 'client finding exists for title check')
  assert.ok(text.includes(clientFinding.title), 'client finding title is in the summary')
})

test('a client-only bundle has no server and names the zip after the client', async () => {
  const bundle = await buildBundle({ client: 'fixclient', lines: 100 })
  assert.equal(bundle.facts.server, null)
  assert.deepEqual(bundle.findings.server, [])

  const outDir = path.join(scratch, 'exports-client-only')
  const { file } = await writeBundle(bundle, { outDir })
  assert.ok(path.basename(file).startsWith('fixclient_diag_'), 'zip is named after the client')
})

test('buildBundle with neither server nor client rejects', async () => {
  await assert.rejects(buildBundle({}), /needs a server or a client profile/)
})

test('buildBundle with an unknown client profile rejects', async () => {
  await assert.rejects(buildBundle({ client: 'nosuch' }))
})

test('the harness token in a crash report never reaches the bundle', async () => {
  const bundle = await buildBundle({ client: 'fixclient', lines: 100 })
  const report = bundle.files.find(f => f.name.startsWith('client-crash-reports/'))
  assert.ok(report, 'the crash report is in the bundle')
  assert.ok(!report.text.includes('deadbeef'), 'token scrubbed')
  assert.match(report.text, /spawnloft\.harness\.token=\[redacted\]/)
})
