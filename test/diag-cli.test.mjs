import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-diag-cli-'))
const data = path.join(scratch, 'data')
const instDir = path.join(data, 'instances', 'diagtest')
const runDir = path.join(data, 'run', 'diagtest')
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'diag')

for (const d of [instDir, runDir, path.join(instDir, 'crash-reports')]) fs.mkdirSync(d, { recursive: true })
const env = { ...process.env, MCCTL_DATA_ROOT: data, APPDATA: path.join(scratch, 'config'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), HOME: scratch, USERPROFILE: scratch,
  LOCALAPPDATA: path.join(scratch, 'local'), XDG_DATA_HOME: path.join(scratch, 'share') }

fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({
  version: 1,
  instances: {
    diagtest: {
      dir: instDir,
      jar: 'paper-1.21.4-100.jar',
      memory: '2G',
      port: 25565,
    },
  },
}))
fs.writeFileSync(path.join(runDir, 'console.log'), fs.readFileSync(path.join(fixtureDir, 'console.log')))
fs.writeFileSync(path.join(runDir, 'daemon.log'), fs.readFileSync(path.join(fixtureDir, 'daemon.log')))
fs.writeFileSync(path.join(instDir, 'server.properties'), fs.readFileSync(path.join(fixtureDir, 'server.properties')))
fs.writeFileSync(path.join(instDir, 'crash-reports', 'crash-2026-10-20_12.00.00-server.txt'), fs.readFileSync(path.join(fixtureDir, 'crash-2026-10-20_12.00.00-server.txt')))
fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
  startedAt: new Date('2026-10-20T11:59:00.000Z').getTime(),
}))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

function cli(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [path.join(root, 'mcctl.mjs'), ...args],
      { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    if (!Number.isInteger(error.status)) throw error
    return { code: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }
  }
}

test('diag writes a zip and prints its path', () => {
  const res = cli(['diag', 'diagtest'])
  assert.equal(res.code, 0, res.stderr)
  const match = res.stdout.match(/Written: (.+)/)
  assert.ok(match, `expected "Written:" line, got: ${res.stdout}`)
  const file = match[1].trim()
  assert.ok(fs.existsSync(file), `file ${file} does not exist`)
})

test('diag --json yields one parseable line with the file present', () => {
  const res = cli(['diag', 'diagtest', '--json'])
  assert.equal(res.code, 0, res.stderr)
  const lines = res.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `expected one line, got ${lines.length}`)
  const parsed = JSON.parse(lines[0])
  assert.ok(parsed.data.file, 'data.file must be present')
  assert.ok(fs.existsSync(parsed.data.file), `file ${parsed.data.file} does not exist`)
})

test('diag with no name exits 2', () => {
  const res = cli(['diag'])
  assert.equal(res.code, 2)
})
