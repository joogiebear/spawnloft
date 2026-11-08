/**
 * A daemon keeps supervising its server after the program's files are gone: an update, or 2.0
 * installed over 1.x, replaces the code folder while the daemon runs on (macOS and Linux never stop
 * it). So daemon.mjs and everything it imports load at start, statically, and nothing loads code
 * later. Checked two ways: the import graph has no dynamic import or require, and a daemon started
 * from a copy of src/ still diagnoses a crash and restarts the server after that copy is deleted.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const FAKE_JAVA = path.join(HERE, 'fixtures', 'fake-java.mjs')

// strings and comments out, so "import(" in a sentence or a message is not a finding
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

function staticImports(text) {
  const specs = []
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) specs.push(m[1])
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1])
  return specs
}

function daemonGraph() {
  const seen = new Set()
  const queue = [path.join(SRC, 'daemon.mjs')]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of staticImports(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(path.resolve(path.dirname(file), spec))
      else assert.ok(spec.startsWith('node:'), `${path.basename(file)} imports the package "${spec}"; the daemon may only use node: built-ins and files in src/`)
    }
  }
  return [...seen]
}

test('the daemon and everything it imports load nothing later', () => {
  const files = daemonGraph()
  assert.ok(files.length > 5, 'the import graph was not followed')
  for (const file of files) {
    const code = codeOnly(fs.readFileSync(file, 'utf8'))
    const name = path.relative(SRC, file)
    assert.ok(!/\bimport\s*\(/.test(code), `${name} has a dynamic import(): import it at the top instead`)
    assert.ok(!/\brequire\s*\(|\bcreateRequire\b/.test(code), `${name} loads code with require`)
  }
})

// Runs from a copy of the code, the way an installed app runs from its resources folder, so the
// copy can be deleted under the running daemon.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-eager-'))
const codeCopy = path.join(scratch, 'code')
const dataRoot = path.join(scratch, 'data')
fs.cpSync(SRC, path.join(codeCopy, 'src'), { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) })
fs.copyFileSync(path.join(HERE, '..', 'package.json'), path.join(codeCopy, 'package.json'))
process.env.MCCTL_DATA_ROOT = dataRoot
process.env.MCCTL_RESTART_DELAY_MS = '300'

const load = (rel) => import(pathToFileURL(path.join(codeCopy, 'src', rel)).href)
const { putInstance } = await load('registry.mjs')
const sup = await load('supervisor.mjs')
const { readState, controlRequest } = await load('control.mjs')
const { findFreePort, sleep, pidAlive } = await load('util.mjs')
const { consoleLog } = await load('paths.mjs')

let started = null
after(async () => {
  if (started) {
    try { await sup.kill(started) } catch { /* already down */ }
  }
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch { /* a scratch folder in the temp directory is not worth failing the run */ }
})

// Every file goes. Folders are left where the OS will not remove them: on Windows the daemon's
// working directory is src/, and an installer deletes files under it just the same.
function deleteCode(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      deleteCode(p)
      try { fs.rmdirSync(p) } catch { /* in use */ }
    } else {
      fs.rmSync(p, { force: true })
    }
  }
}

test('a daemon whose program files were deleted still diagnoses a crash and restarts the server', { timeout: 40000 }, async () => {
  const name = `eager-${process.pid}`
  const dir = path.join(dataRoot, 'instances', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  const port = await findFreePort(35000 + Math.floor(Math.random() * 20000))
  const rconPort = await findFreePort(port + 1)
  putInstance(name, { dir, jar: 'server.jar', java: FAKE_JAVA, memory: '1G', port, rcon: { port: rconPort, password: 'test' }, autoRestart: true })

  // set first: a start that times out after spawning still leaves a daemon for after() to kill
  started = name
  await sup.start(name, { timeout: 15000 })
  const first = readState(name).state.javaPid

  deleteCode(codeCopy)
  assert.ok(!fs.existsSync(path.join(codeCopy, 'src', 'daemon.mjs')))

  const crash = await controlRequest(name, { op: 'send', line: 'crash' })
  assert.equal(crash.ok, true)
  const deadline = Date.now() + 15000
  let recovered = false
  while (Date.now() < deadline && !recovered) {
    await sleep(100)
    const { status, state } = readState(name)
    recovered = status === 'running' && state.javaPid !== first && state.restarts === 1
  }
  const text = fs.readFileSync(consoleLog(name), 'utf8')
  assert.ok(recovered, `did not recover: ${JSON.stringify(readState(name))}\n${text}`)
  assert.match(text, /likely cause: Something in the world crashed the server/)

  const pong = await controlRequest(name, { op: 'ping' })
  assert.equal(pong.protocol, 1)
  assert.equal(pong.daemon, 'node')
  assert.equal(pong.version, JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version)

  const stopped = await controlRequest(name, { op: 'stop', timeout: 10000 })
  assert.equal(stopped.ok, true)
  // the reply comes before the daemon exits; Windows will not delete its log files until it has
  const daemonPid = readState(name).state?.daemonPid
  const gone = Date.now() + 10000
  while (Date.now() < gone && daemonPid && pidAlive(daemonPid)) await sleep(100)
  started = null
})
