#!/usr/bin/env node
// Copies a built spawnloft-core into build/bin/<platform>-<arch>/, where internal.config.cjs packs
// it from. Checks first that it is a binary for this machine and that it runs.
//
//   node desktop/stage-core.mjs                      # rust/target/release/spawnloft-core
//   node desktop/stage-core.mjs <path-to-binary>     # e.g. rust/target/x86_64-unknown-linux-musl/release/spawnloft-core
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { binaryArch } from './core-binary.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const exe = process.platform === 'win32' ? 'spawnloft-core.exe' : 'spawnloft-core'
const from = path.resolve(process.argv[2] || path.join(HERE, '..', 'rust', 'target', 'release', exe))
if (!fs.existsSync(from)) throw new Error(`${from} does not exist; run cargo build --release -p spawnloft-core in rust/`)

const arch = process.env.INTERNAL_ARCH || process.arch
const found = binaryArch(fs.readFileSync(from))
const want = { platform: process.platform, arch }
if (!found || found.platform !== want.platform || found.arch !== want.arch) {
  throw new Error(`${from} is a ${found ? `${found.platform}-${found.arch}` : 'unrecognised'} binary, not ${want.platform}-${want.arch}`)
}
const ran = spawnSync(from, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
if (ran.status !== 0) throw new Error(`${from} --version failed (${ran.status ?? ran.error?.message}): ${ran.stderr}`)

const dir = path.join(HERE, 'build', 'bin', `${want.platform}-${want.arch}`)
fs.mkdirSync(dir, { recursive: true })
const to = path.join(dir, exe)
fs.copyFileSync(from, to)
fs.chmodSync(to, 0o755)
console.log(`staged ${ran.stdout.trim()} at ${path.relative(path.join(HERE, '..'), to)}`)
