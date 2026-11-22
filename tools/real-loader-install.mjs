#!/usr/bin/env node
// Sets a mod loader up for real, as a first Play does, and stops before the game would start:
// the installer downloaded and checked, its build steps run on Mojang's Java, every output
// checked, the stamp written, and the launch command built with every file it names on disk.
// Run by .github/workflows/loader-install.yml (the loaders' hosts cannot be reached from where
// SpawnLoft is written); it runs anywhere with network access, in a data folder of its own:
//
//   node tools/real-loader-install.mjs --loader neoforge --mc 26.3 --build 26.3.0.103 [--and <build>] [--core <bin>]
//
// --core <bin> makes and sets the profiles up through that spawnloft-core (`client new`, `client
// set`, `client install`), the Rust core's client (rust/PLAN-CORE-PORT.md, C7b). The checks after
// (the stamps, the launch command and every file it names) read what it left on disk with the
// Node core's readers, so the two cores are held to the same files. Without it the Node core's
// modules do the setting up themselves.
//
// --and sets a second build for the same version up after the first, in a setup of its own, and
// checks that the first build's files still hold (the two share the build steps' middle files).
//
// Nothing outside that folder is touched, and the folder is removed after unless --keep.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const loader = arg('loader')
const mc = arg('mc')
const build = arg('build')
const also = arg('and')
const core = arg('core')
const keep = process.argv.includes('--keep')
if (!loader || !mc || !build) {
  console.error('usage: node tools/real-loader-install.mjs --loader <id> --mc <version> --build <build> [--and <build>] [--core <bin>] [--keep]')
  process.exit(2)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-real-loader-'))
process.env.MCCTL_DATA_ROOT = root

const client = await import('../src/client.mjs')
const { loaderFor } = await import('../src/client-loaders.mjs')
const { versionJson, clientRunDir, LIBRARIES_DIR } = await import('../src/client-paths.mjs')
const { mergeInherited, libraries, classpathRows, currentOs } = await import('../src/client-meta.mjs')
const { isStamped, stampHolds, stampFile } = await import('../src/client-forge-install.mjs')
const { buildCommand } = await import('../src/client-launch.mjs')
const { offlineAccount } = await import('../src/client-auth.mjs')

const name = 'real'
const began = Date.now()
const secs = () => `${((Date.now() - began) / 1000).toFixed(0)}s`
let lastProgress = 0

// One spawnloft-core command line in this data folder. Its stderr (the stages and progress) is
// shown as it comes, with the time, and handed to `onLine`; stdout is returned.
function runCore(args, { onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(core, args, { env: { ...process.env, SPAWNLOFT_DATA_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] })
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
      if (carry) console.log(`[${secs()}] ${carry}`)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`spawnloft-core ${args.join(' ')} exited ${code}`))
      else resolve(stdout)
    })
  })
}

// A profile made and set up as a first Play does; the version id it was set up as.
async function setUp(profile, loaderVersion, { onStage = ({ stage, message }) => console.log(`[${secs()}] ${stage}: ${message}`) } = {}) {
  if (core) {
    await runCore(['client', 'new', profile, '--mc', mc, '--loader', loader, '--memory', '4G'])
    await runCore(['client', 'set', profile, `loaderVersion=${loaderVersion}`])
    // not --json, which keeps the stages quiet: the second setup is checked by them
    const out = await runCore(['client', 'install', profile], { onLine: (message) => onStage({ stage: 'core', message }) })
    console.log(out.trim())
    const m = /^Installed (\S+): /m.exec(out)
    if (!m) throw new Error(`client install printed no "Installed <id>:" line:\n${out}`)
    return m[1]
  }
  const checkedMc = await client.checkProfileVersion({ mc, loader })
  client.createProfile(profile, { mc: checkedMc, loader, loaderVersion, memory: '4G' })
  const result = await client.installProfile(profile, {
    onStage,
    onProgress: (p) => {
      if (Date.now() - lastProgress < 5000) return
      lastProgress = Date.now()
      console.log(`[${secs()}]   ${p.phase} ${p.done}/${p.total}`)
    },
    onNote: (n) => console.log(`[${secs()}] note: ${n}`),
  })
  return result.id
}

async function main() {
  if (core) console.log(`setting up through ${core}`)
  const installed = await setUp(name, build)
  const mod = loaderFor(loader)
  const id = mod.versionId(mc, build)
  if (installed !== id) throw new Error(`installed ${installed}, expected ${id}`)
  if (!mod.isInstalled(mc, build)) throw new Error('the loader does not count as set up')
  if (mod.finishInstall) {
    if (!isStamped(id) || !(await stampHolds(id))) throw new Error('the stamp is missing or does not hold')
    const stamp = JSON.parse(fs.readFileSync(stampFile(id), 'utf8'))
    console.log(`stamp: ${Object.keys(stamp.files).length} files`)
  }
  // a second setup up on the same build builds nothing
  const t = Date.now()
  await setUp(`${name}-2`, build, { onStage: ({ message }) => { if (/step \d+ of/.test(message)) throw new Error(`a second setup ran a build step: ${message}`) } })
  console.log(`second setup: ${((Date.now() - t) / 1000).toFixed(1)}s, no build steps`)

  if (also) {
    await setUp(`${name}-and`, also)
    const id2 = mod.versionId(mc, also)
    if (mod.finishInstall && !(await stampHolds(id2))) throw new Error(`${also}'s stamp does not hold`)
    if (mod.finishInstall && !(await stampHolds(id))) throw new Error(`setting ${also} up changed ${build}'s files`)
    console.log(`${also} set up beside ${build}; both stamps hold`)
  }

  // the launch command, and every file on its classpath and module path
  let version = JSON.parse(fs.readFileSync(versionJson(id), 'utf8'))
  version = mergeInherited(version, JSON.parse(fs.readFileSync(versionJson(version.inheritsFrom), 'utf8')))
  const osNow = currentOs()
  const cmd = buildCommand({ version, profile: { ...client.getProfile(name), server: null }, profileName: name, account: offlineAccount('Tester'), java: 'java', os: osNow, harnessToken: null, address: null })
  const left = cmd.args.filter((a) => /\$\{/.test(a))
  if (left.length) throw new Error(`launch values not filled in: ${left.join(' ')}`)
  const missing = []
  for (const row of classpathRows(libraries(version, { os: osNow }))) if (!fs.existsSync(path.join(LIBRARIES_DIR, row.path))) missing.push(row.path)
  const p = cmd.args.indexOf('-p')
  if (p !== -1) for (const f of cmd.args[p + 1].split(path.delimiter)) if (!fs.existsSync(f)) missing.push(f)
  if (missing.length) throw new Error(`files the launch names are missing:\n  ${missing.join('\n  ')}`)
  console.log(`main class ${version.mainClass}; ${cmd.args.length} launch arguments, every file on disk`)
  console.log(`${loader} ${build} for ${mc} set up in ${secs()}`)
}

try {
  await main()
} catch (err) {
  console.error(`FAILED after ${secs()}: ${err.message}`)
  const log = path.join(clientRunDir(name), 'loader-install.log')
  if (fs.existsSync(log)) {
    console.error('----- loader-install.log (last 200 lines) -----')
    console.error(fs.readFileSync(log, 'utf8').split('\n').slice(-200).join('\n'))
  }
  process.exitCode = 1
} finally {
  if (!keep) fs.rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root}`)
}
