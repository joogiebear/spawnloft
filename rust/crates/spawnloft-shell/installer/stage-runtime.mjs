// Stages the Node.js runtime a 2.0 package carries (PLAN-2.0-REMAINING.md section 4 item 1):
//
//   <out>/node-<version>/node.exe          (Windows)
//   <out>/node-<version>/bin/node          (macOS, Linux)
//   <out>/node-<version>/LICENSE
//   <out>/runtime.json                     what spawnloft-core reads to find it, and what the
//                                          release gate checks: version, archive hash, exe hash
//
// The archive is the official one from nodejs.org for the version in desktop/node-pin.mjs, and is
// refused unless its sha256 matches the pin. Only the executable and its licence are kept (no
// npm, corepack or headers). <out> maps to `resources/runtime/` in every package.
//
//   node stage-runtime.mjs <out dir> [--platform win32|darwin|linux] [--arch x64|arm64] [--cache <dir>]
//
// `stageRuntime({ platform, arch, out, cache })` is the same, for the packaging scripts.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const { NODE_VERSION, nodeArchive } = await import(pathToFileURL(path.join(REPO, 'desktop/node-pin.mjs')).href)

export const RUNTIME_RECORD = 'runtime.json'
export const runtimeFolder = (version = NODE_VERSION) => `node-${version}`

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function download(pin, cache) {
  const archive = path.join(cache, pin.file)
  if (fs.existsSync(archive) && sha256File(archive) === pin.sha256) return archive
  const { fetchRetry } = await import(pathToFileURL(path.join(REPO, 'src/download.mjs')).href)
  const res = await fetchRetry(pin.url, {}, { timeoutMs: 600000 })
  if (!res.ok) throw new Error(`Node download failed (${res.status}) from ${pin.url}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const got = crypto.createHash('sha256').update(bytes).digest('hex')
  if (got !== pin.sha256) throw new Error(`Node checksum mismatch for ${pin.file}\n  expected ${pin.sha256}\n  got      ${got}`)
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(archive, bytes)
  return archive
}

function extract(archive, into, members) {
  // Windows: the system bsdtar, which reads zip (a Git-for-Windows GNU tar on PATH does not)
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  const res = spawnSync(tar, ['-xf', archive, '-C', into, ...members], { stdio: 'inherit' })
  if (res.error) throw new Error(`${tar} could not be run: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`${tar} -xf ${archive} exited ${res.status}`)
}

export async function stageRuntime({ platform = process.platform, arch = process.arch, out, cache } = {}) {
  if (!out) throw new Error('stageRuntime: no out dir')
  const pin = nodeArchive(platform, arch)
  cache ||= path.join(os.tmpdir(), 'spawnloft-node-cache')
  const archive = await download(pin, cache)

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-runtime-'))
  try {
    extract(archive, work, [`${pin.base}/${pin.exe}`, `${pin.base}/LICENSE`])
    const folder = runtimeFolder()
    // a clean out dir: an old version's folder would ship beside the new one
    fs.rmSync(out, { recursive: true, force: true })
    fs.mkdirSync(out, { recursive: true })
    fs.cpSync(path.join(work, pin.base), path.join(out, folder), { recursive: true })
    const exe = path.join(out, folder, pin.exe)
    if (platform !== 'win32') fs.chmodSync(exe, 0o755)
    const record = {
      node: NODE_VERSION,
      exe: `${folder}/${pin.exe}`,
      platform,
      arch,
      archive: pin.file,
      archiveSha256: pin.sha256,
      // as staged; on macOS the exe is signed again with the Developer ID afterwards
      exeSha256: sha256File(exe),
    }
    fs.writeFileSync(path.join(out, RUNTIME_RECORD), JSON.stringify(record, null, 2) + '\n')
    return { ...record, dir: out, path: exe }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args.splice(i, 2)[1] : undefined
  }
  const platform = opt('--platform')
  const arch = opt('--arch')
  const cache = opt('--cache')
  const [out] = args
  if (!out) {
    console.error('usage: node stage-runtime.mjs <out dir> [--platform win32|darwin|linux] [--arch x64|arm64] [--cache <dir>]')
    process.exit(64)
  }
  const staged = await stageRuntime({ platform, arch, out: path.resolve(out), cache })
  console.log(`staged Node ${staged.node} (${staged.platform}-${staged.arch}) at ${staged.path}`)
}
