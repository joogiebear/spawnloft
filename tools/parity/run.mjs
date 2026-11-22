#!/usr/bin/env node
// The parity rig's command line (README.md beside this file).
//
//   node tools/parity/run.mjs [scenario.json | folder ...] [--core <spawnloft-core>]
//        [--only <name>] [--keep] [--out <dir>] [--sides node,rust] [--update-golden] [--declared]
//        [--record [--record-from node|rust]] [--frozen check|off]
//
// With no scenario named, runs tools/parity/scenarios/ and tools/parity/selftest/. Exit 0 when
// every scenario passes, 1 when one fails, 2 for a usage error.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from '../../src/args.mjs'
import { runScenario, findCore, SIDES } from './lib/rig.mjs'
import { declaredTable } from './declared-differences.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')

function usage(msg) {
  process.stderr.write(`${msg}\nUsage: node tools/parity/run.mjs [scenario.json | folder ...] [--core <bin>] [--only <name>] [--keep] [--out <dir>] [--sides node,rust] [--update-golden]\n`)
  process.exit(2)
}

export function loadScenarios(targets) {
  const files = []
  for (const t of targets) {
    const abs = path.resolve(t)
    if (fs.statSync(abs).isDirectory()) {
      for (const f of fs.readdirSync(abs).sort()) if (f.endsWith('.json')) files.push(path.join(abs, f))
    } else {
      files.push(abs)
    }
  }
  return files.map((file) => {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    s.name ??= path.basename(file, '.json')
    s.file = file
    return s
  })
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), { booleanFlags: ['keep', 'updateGolden', 'declared', 'record'] })
  if (flags.declared) { process.stdout.write(declaredTable() + '\n'); return }
  const known = ['core', 'only', 'keep', 'out', 'sides', 'updateGolden', 'declared', 'scratch', 'record', 'recordFrom', 'frozen']
  for (const k of Object.keys(flags)) if (!known.includes(k)) usage(`unknown option --${k}`)
  const core = flags.core ? path.resolve(flags.core) : findCore(repo)
  if (!core || !fs.existsSync(core)) usage('no spawnloft-core found: build it (cd rust && cargo build -p spawnloft-core --features test-hooks) or pass --core')
  // a core without the test hooks ignores SPAWNLOFT_TEST_ORIGINS, so its side could reach the network
  const version = spawnSync(core, ['--version', '--json'], { encoding: 'utf8', windowsHide: true })
  let hooks = null
  try { hooks = JSON.parse(version.stdout).testHooks } catch {}
  if (!hooks) usage(`${core} is not a test-hooks build (--version --json has no testHooks): cd rust && cargo build -p spawnloft-core --features test-hooks`)
  const sides = flags.sides ? String(flags.sides).split(',') : SIDES
  if (!sides.every(s => SIDES.includes(s)) || !sides.length) usage(`--sides takes ${SIDES.join(',')}`)
  const recordFrom = flags.recordFrom ? String(flags.recordFrom) : 'node'
  if (!SIDES.includes(recordFrom)) usage(`--record-from takes ${SIDES.join(' or ')}`)
  if (flags.record && !sides.includes(recordFrom)) usage(`--record needs the ${recordFrom} side`)
  if (flags.frozen !== undefined && !['check', 'off'].includes(String(flags.frozen))) usage('--frozen takes check or off')
  const frozen = flags.record ? 'record' : String(flags.frozen ?? 'check')
  const targets = positional.length ? positional : [path.join(here, 'scenarios'), path.join(here, 'selftest')]
  let scenarios = loadScenarios(targets)
  if (flags.only) scenarios = scenarios.filter(s => s.name === flags.only)
  if (!scenarios.length) usage('no scenario to run')
  // a short base: Windows paths have a length limit, and the scratch folder is in every path
  // the real path (no /var -> /private/var, no Windows 8.3 short names), so a golden file's <run> is found
  const base = flags.scratch ? path.resolve(flags.scratch) : fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-parity-')))
  const results = []
  let failed = 0
  for (const s of scenarios) {
    if (s.platforms && !s.platforms.includes(process.platform) && !s.platforms.includes(`${process.platform}-${process.arch}`)) {
      process.stdout.write(`skip ${s.name} (only on ${s.platforms.join(', ')})\n`)
      continue
    }
    const scratch = path.join(base, s.name)
    const started = Date.now()
    let r
    try {
      r = await runScenario(s, { core, repo, scratch, sides, keep: Boolean(flags.keep), baseDir: path.dirname(s.file), golden: flags.updateGolden ? 'update' : 'check', frozen, recordFrom })
    } catch (e) {
      r = { name: s.name, ok: false, diffs: [], problems: [`the scenario could not run: ${e.stack || e.message}`] }
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    results.push(r)
    if (r.ok) {
      const note = r.expect === 'differ' ? ` (seeded difference found: ${r.diffs.length})` : ''
      process.stdout.write(`ok   ${s.name}${note} ${secs}s\n`)
    } else {
      failed++
      process.stdout.write(`FAIL ${s.name} ${secs}s\n`)
      if (r.expect === 'differ' && !r.diffs.length && !r.problems.length) process.stdout.write('  the rig found no difference in a scenario seeded with one\n')
      for (const p of r.problems) process.stdout.write(`  problem: ${p.replace(/\n/g, '\n    ')}\n`)
      if (r.expect !== 'differ') for (const d of r.diffs) process.stdout.write(`  differs: ${d.what}\n    ${d.detail.replace(/\n/g, '\n    ')}\n`)
    }
  }
  if (flags.out) {
    const out = path.resolve(flags.out)
    fs.mkdirSync(out, { recursive: true })
    const plain = results.map(r => ({ ...r, sides: Object.fromEntries(Object.entries(r.sides ?? {}).map(([k, v]) => [k, { steps: v.steps, requests: v.requests, problems: v.problems, tree: Object.fromEntries(v.tree) }])) }))
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ core, platform: process.platform, arch: process.arch, results: plain }, null, 1))
  }
  if (!flags.keep && !flags.scratch) fs.rmSync(base, { recursive: true, force: true })
  else process.stdout.write(`scratch folders kept in ${base}\n`)
  process.stdout.write(`${results.length - failed} of ${results.length} scenarios passed (core ${core}, sides ${sides.join(' and ')})\n`)
  process.exitCode = failed ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
