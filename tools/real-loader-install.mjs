#!/usr/bin/env node
// Sets a mod loader up for real, as a first Play does, through spawnloft-core, and stops before
// the game would start: the installer downloaded and checked, its build steps run on Mojang's
// Java, every output checked, the stamp written. Run by .github/workflows/loader-install.yml (the
// loaders' hosts cannot be reached from where SpawnLoft is written); it runs anywhere with network
// access, in a data folder of its own:
//
//   node tools/real-loader-install.mjs --loader neoforge --mc 26.3 --build 26.3.0.103 [--and <build>] [--core <bin>]
//
// The profiles are made and set up by spawnloft-core (`client new`, `client set`, `client
// install`); --core names it, else the newest build under rust/target is used. The checks after
// read what it left on disk: the stamp holds (every file it lists has its size and sha1), a
// second setup of the same build runs no build step, and every library the loader's version and
// the version it inherits from name for every machine is on disk.
//
// --and sets a second build for the same version up after the first, in a setup of its own, and
// checks that the first build's files still hold (the two share the build steps' middle files).
//
// Nothing outside that folder is touched, and the folder is removed after unless --keep.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findCore } from './parity/lib/rig.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const loader = arg('loader')
const mc = arg('mc')
const build = arg('build')
const also = arg('and')
const core = arg('core') ? path.resolve(arg('core')) : findCore(repo)
const keep = process.argv.includes('--keep')
if (!loader || !mc || !build) {
  console.error('usage: node tools/real-loader-install.mjs --loader <id> --mc <version> --build <build> [--and <build>] [--core <bin>] [--keep]')
  process.exit(2)
}
if (!core || !fs.existsSync(core)) {
  console.error('no spawnloft-core: build it (cd rust && cargo build -p spawnloft-core) or pass --core')
  process.exit(2)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-real-loader-'))
const clientRoot = path.join(root, 'client')
const versionDir = (id) => path.join(clientRoot, 'versions', id)
const name = 'real'
const began = Date.now()
const secs = () => `${((Date.now() - began) / 1000).toFixed(0)}s`

// One spawnloft-core command line in this data folder. Its stderr (the stages and progress) is
// shown as it comes, with the time, and handed to `onLine`; stdout is returned.
function runCore(args, { onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(core, args, { env: { ...process.env, SPAWNLOFT_DATA_ROOT: root, XDG_CONFIG_HOME: path.join(root, '.config'), APPDATA: path.join(root, '.config') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let carry = ''
    let failure = null
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d) => {
      const lines = (carry + d).split('\n')
      carry = lines.pop()
      for (const line of lines) {
        console.log(`[${secs()}] ${line}`)
        try { onLine(line) } catch (err) { failure ??= err; child.kill() }
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (carry) {
        console.log(`[${secs()}] ${carry}`)
        try { onLine(carry) } catch (err) { failure ??= err }
      }
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`spawnloft-core ${args.join(' ')} exited ${code}`))
      else resolve(stdout)
    })
  })
}

// A profile made and set up as a first Play does; the version id it was set up as.
async function setUp(profile, loaderVersion, { onLine = () => {} } = {}) {
  await runCore(['client', 'new', profile, '--mc', mc, '--loader', loader, '--memory', '4G'])
  await runCore(['client', 'set', profile, `loaderVersion=${loaderVersion}`])
  // not --json, which keeps the stages quiet: the second setup is checked by them
  const out = await runCore(['client', 'install', profile], { onLine })
  console.log(out.trim())
  const m = /^Installed (\S+): /m.exec(out)
  if (!m) throw new Error(`client install printed no "Installed <id>:" line:\n${out}`)
  return m[1]
}

const sha1Of = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')

// The stamp the build steps leave (forge_install.rs): format 1, and per file, relative to the
// client folder, [size or null, sha1]. It holds when every one of them still matches.
function stampProblems(id) {
  const file = path.join(versionDir(id), '.loader-installed.json')
  if (!fs.existsSync(file)) return [`${id} has no stamp (${file})`]
  const stamp = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (stamp.format !== 1) return [`${id}'s stamp has format ${stamp.format}`]
  const rows = Object.entries(stamp.files ?? {})
  if (!rows.length) return [`${id}'s stamp lists no file`]
  const problems = []
  for (const [rel, [size, sha1]] of rows) {
    const f = path.join(clientRoot, ...rel.split('/'))
    if (!fs.existsSync(f)) problems.push(`${rel}: missing`)
    else if (size !== null && fs.statSync(f).size !== size) problems.push(`${rel}: ${fs.statSync(f).size} bytes, the stamp says ${size}`)
    else if (sha1Of(f) !== String(sha1).toLowerCase()) problems.push(`${rel}: sha1 differs from the stamp`)
  }
  return problems
}

// group:artifact:version[:classifier][@ext] to its path in a maven
function mavenPath(coords) {
  const [spec, ext = 'jar'] = coords.split('@')
  const [group, artifact, version, classifier] = spec.split(':')
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`
}

// The libraries a version and the ones it inherits from name for every machine (no rules), each
// with its place under libraries/.
function unconditionalLibraries(id) {
  const out = []
  for (let at = id; at;) {
    const version = JSON.parse(fs.readFileSync(path.join(versionDir(at), `${at}.json`), 'utf8'))
    for (const lib of version.libraries ?? []) {
      if (lib.rules || lib.natives || typeof lib.name !== 'string') continue
      const rel = lib.downloads?.artifact?.path ?? (lib.downloads && !lib.downloads.artifact ? null : mavenPath(lib.name))
      if (rel) out.push(rel)
    }
    at = version.inheritsFrom
  }
  return out
}

async function main() {
  console.log(`setting up through ${core}`)
  const id = await setUp(name, build)
  const problems = stampProblems(id)
  if (problems.length) throw new Error(`the stamp does not hold:\n  ${problems.join('\n  ')}`)
  console.log(`stamp: ${Object.keys(JSON.parse(fs.readFileSync(path.join(versionDir(id), '.loader-installed.json'), 'utf8')).files).length} files hold`)

  // a second setup on the same build builds nothing
  const t = Date.now()
  const again = await setUp(`${name}-2`, build, { onLine: (message) => { if (/step \d+ of/.test(message)) throw new Error(`a second setup ran a build step: ${message}`) } })
  if (again !== id) throw new Error(`the second setup installed ${again}, the first ${id}`)
  console.log(`second setup: ${((Date.now() - t) / 1000).toFixed(1)}s, no build steps`)

  if (also) {
    const id2 = await setUp(`${name}-and`, also)
    if (stampProblems(id2).length) throw new Error(`${also}'s stamp does not hold:\n  ${stampProblems(id2).join('\n  ')}`)
    if (stampProblems(id).length) throw new Error(`setting ${also} up changed ${build}'s files:\n  ${stampProblems(id).join('\n  ')}`)
    console.log(`${also} set up beside ${build}; both stamps hold`)
  }

  const missing = unconditionalLibraries(id).filter((rel) => !fs.existsSync(path.join(clientRoot, 'libraries', ...rel.split('/'))))
  if (missing.length) throw new Error(`libraries the version names are missing:\n  ${missing.join('\n  ')}`)
  console.log(`every library ${id} names for every machine is on disk`)
  console.log(`${loader} ${build} for ${mc} set up in ${secs()}`)
}

try {
  await main()
} catch (err) {
  console.error(`FAILED after ${secs()}: ${err.message}`)
  const log = path.join(clientRoot, 'run', name, 'loader-install.log')
  if (fs.existsSync(log)) {
    console.error('----- loader-install.log (last 200 lines) -----')
    console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-200).join('\n'))
  }
  process.exitCode = 1
} finally {
  if (!keep) fs.rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
