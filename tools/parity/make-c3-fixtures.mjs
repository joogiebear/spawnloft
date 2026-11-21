// Writes C3's behaviour fixture from the Node modules, which are the reference:
//   node tools/parity/make-c3-fixtures.mjs
// test/fixtures/contracts/c3-library.json: files.mjs and config-files.mjs, which no command calls
// yet (manage in C4, the panel in C8 and the MCP tools in C9 will). The cases are in
// c3-library-cases.json: a server folder, operations on it in order (each sees what the ones
// before it did) and calls of the pure functions. Each gets the answer or the error Node gave,
// evened out (the scratch root, stamps, times; zip sizes, since the two cores deflate
// differently). spawnloft-lib's files.rs tests run the same cases and must agree.
// Change the cases, never the expectations by hand. test/c3-fixtures.test.mjs fails when the
// file no longer matches what this script makes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', '..', 'test', 'fixtures', 'contracts')
const CASES = path.join(here, 'c3-library-cases.json')

function results() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-c3-fixture-'))
  try {
    const home = path.join(root, 'home')
    const env = { ...process.env, SPAWNLOFT_DATA_ROOT: path.join(root, 'data'), HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), TZ: 'UTC', TMPDIR: path.join(root, 'tmp') }
    for (const k of Object.keys(env)) if (/^MCCTL_/.test(k)) delete env[k]
    fs.mkdirSync(env.TMPDIR, { recursive: true })
    const text = execFileSync(process.execPath, [path.join(here, 'c3-library-run.mjs'), CASES, root], { env, encoding: 'utf8', maxBuffer: 64 << 20 })
    return JSON.parse(text)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export function made() {
  const cases = JSON.parse(fs.readFileSync(CASES, 'utf8'))
  const { ops, pure, activity } = results()
  const doc = {
    about: 'files.mjs and config-files.mjs in Node over the server folder and operations in tools/parity/c3-library-cases.json. Made by tools/parity/make-c3-fixtures.mjs; spawnloft-lib files.rs and config_files.rs must agree on every case.',
    tree: cases.tree,
    instance: cases.instance,
    ops: cases.ops.map((o, i) => ({ ...o, ...ops[i] })),
    pure: cases.pure.map((o, i) => ({ ...o, ...pure[i] })),
    activity,
  }
  return { 'c3-library.json': JSON.stringify(doc, null, 2) + '\n' }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, text] of Object.entries(made())) fs.writeFileSync(path.join(out, name), text)
}
