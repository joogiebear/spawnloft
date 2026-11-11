// What the release gate checks inside a package's payload, before it is bundled
// (PLAN-2.0-REMAINING.md A3 and section 5 W1):
//
//   checkRuntime(dir)        resources/runtime as staged by stage-runtime.mjs: the pinned Node
//                            version, the pinned nodejs.org archive hash for its platform, the
//                            executable byte for byte as staged (Windows keeps the OpenJS
//                            Authenticode signature; macOS re-signs it, so its hash is not
//                            compared there), and that it runs as that version on this machine
//                            when it can (same platform and architecture)
//   checkNoInternalStrings(files)   no wording that marks a test build (the "internal spike"
//                            page, "Internal build: not for release.") in any shipped file,
//                            binaries included (searched as bytes)
//
// Both return a list of problems (empty when fine). release-gate.mjs runs them with --runtime
// and --payload.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { NODE_VERSION, nodeArchive } = await import(pathToFileURL(path.join(HERE, 'node-pin.mjs')).href)

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

export function checkRuntime(dir, { run = true } = {}) {
  const problems = []
  const recordFile = path.join(dir, 'runtime.json')
  let record
  try {
    record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  } catch (e) {
    return [`${recordFile}: ${e.message}`]
  }
  if (record.node !== NODE_VERSION) problems.push(`runtime.json says Node ${record.node}, the pin (desktop/node-pin.mjs) is ${NODE_VERSION}`)
  let pin = null
  try {
    pin = nodeArchive(record.platform, record.arch)
  } catch (e) {
    problems.push(`runtime.json: ${e.message}`)
  }
  if (pin) {
    if (record.archive !== pin.file) problems.push(`runtime.json names archive ${record.archive}, the pin is ${pin.file}`)
    if (record.archiveSha256 !== pin.sha256) problems.push(`runtime.json records archive sha256 ${record.archiveSha256}, the pin is ${pin.sha256}`)
    if (record.exe !== `node-${NODE_VERSION}/${pin.exe}`) problems.push(`runtime.json exe is ${record.exe}, expected node-${NODE_VERSION}/${pin.exe}`)
  }
  const exe = path.join(dir, String(record.exe || ''))
  if (!record.exe || !fs.existsSync(exe)) {
    problems.push(`the bundled Node ${exe} is missing`)
    return problems
  }
  if (record.platform !== 'darwin' && sha256(fs.readFileSync(exe)) !== record.exeSha256) {
    problems.push(`${exe} is not the executable staged from ${record.archive} (sha256 differs from runtime.json)`)
  }
  // only what is in the folder ships: the versioned folder and its record
  for (const entry of fs.readdirSync(dir)) {
    if (entry !== 'runtime.json' && entry !== `node-${NODE_VERSION}`) problems.push(`unexpected ${entry} in the runtime folder`)
  }
  if (run && record.platform === process.platform && record.arch === process.arch) {
    const ran = spawnSync(exe, ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8', timeout: 60000 })
    if (ran.status !== 0 || ran.stdout !== `v${NODE_VERSION}`) problems.push(`the bundled Node does not run as v${NODE_VERSION}: exit ${ran.status ?? ran.error?.message}, printed ${ran.stdout}`)
  }
  return problems
}

// User-visible wording of test builds. Matched case-insensitively against each file's bytes (as
// latin1, so a binary's embedded UTF-8 strings match too).
export const INTERNAL_WORDING = [/internal spike/i, /internal build: not for release/i, /\(internal spike\)/i]

function* filesUnder(p) {
  const st = fs.statSync(p)
  if (!st.isDirectory()) {
    yield p
    return
  }
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) yield* filesUnder(path.join(p, entry.name))
}

export function checkNoInternalStrings(paths) {
  const problems = []
  for (const root of paths) {
    if (!fs.existsSync(root)) {
      problems.push(`${root} is missing`)
      continue
    }
    for (const file of filesUnder(root)) {
      const text = fs.readFileSync(file).toString('latin1')
      for (const re of INTERNAL_WORDING) {
        const m = re.exec(text)
        if (m) problems.push(`${file} contains test-build wording "${m[0]}"`)
      }
    }
  }
  return problems
}
