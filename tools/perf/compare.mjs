#!/usr/bin/env node
// Before/after table from two result files of the same metric (PLAN.md section 2.3), ready to
// paste into a PR description, docs/PERFORMANCE.md or the beta notes. Rows are matched by id;
// a change under 10% reads "no change" (section 4.6: these machines are not that quiet).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fmt, mdTable, round, check, runMain } from './lib.mjs'

const USAGE = `node tools/perf/compare.mjs <before.json> <after.json> [--stat median|p90|p95] [--threshold 10]
node tools/perf/compare.mjs --self-test`

function compare(before, after, { stat = 'median', threshold = 10 } = {}) {
  if (before.metric !== after.metric) throw new Error(`these measure different things: ${before.metric} and ${after.metric}`)
  const byId = new Map(after.results.map((r) => [r.id, r]))
  const rows = [['case', 'before', 'after', 'change']]
  const seen = new Set()
  for (const b of before.results) {
    const a = byId.get(b.id)
    seen.add(b.id)
    rows.push([b.label ?? b.id, fmt(b[stat], b.unit), fmt(a?.[stat], a?.unit ?? b.unit), change(b[stat], a?.[stat], threshold)])
  }
  for (const a of after.results) if (!seen.has(a.id)) rows.push([a.label ?? a.id, '-', fmt(a[stat], a.unit), 'new'])
  return rows
}

function change(b, a, threshold) {
  if (b == null || a == null) return '-'
  if (b === 0) return a === 0 ? 'no change' : `+${a}`
  const pct = ((a - b) / b) * 100
  if (Math.abs(pct) < threshold) return 'no change'
  if (a < b && a > 0 && b / a >= 2) return `${round(b / a, 1)}x less`
  return `${pct > 0 ? '+' : ''}${round(pct, 0)}%`
}

function header(before, after) {
  const e = (d) => `${d.environment.machine} @ ${d.environment.cliVersion ?? d.environment.commit ?? '?'}`
  return `**${before.metric}**: ${e(before)} → ${e(after)}`
}

function selfTest() {
  const env = { machine: 'test-box', commit: 'abc1234' }
  const doc = (results) => ({ tool: 'spawnloft-perf', format: 1, metric: 'cli-start', environment: env, results })
  const before = doc([
    { id: 'help-0', label: '--help', unit: 'ms', median: 150 },
    { id: 'list-0', label: 'list', unit: 'ms', median: 100 },
    { id: 'gone', label: 'removed case', unit: 'ms', median: 5 },
  ])
  const after = doc([
    { id: 'help-0', label: '--help', unit: 'ms', median: 50 },
    { id: 'list-0', label: 'list', unit: 'ms', median: 95 },
    { id: 'fresh', label: 'new case', unit: 'bytes', median: 2048 },
  ])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-perf-compare-'))
  try {
    const bf = path.join(dir, 'before.json')
    const af = path.join(dir, 'after.json')
    fs.writeFileSync(bf, JSON.stringify(before))
    fs.writeFileSync(af, JSON.stringify(after))
    const rows = compare(JSON.parse(fs.readFileSync(bf, 'utf8')), JSON.parse(fs.readFileSync(af, 'utf8')))
    const find = (label) => rows.find((r) => r[0] === label)
    check(find('--help')[3] === '3x less', `3x faster reads "3x less" (got ${find('--help')[3]})`)
    check(find('list')[3] === 'no change', '5% reads "no change"')
    check(find('removed case')[2] === '-', 'a case missing after shows -')
    check(find('new case')[3] === 'new' && find('new case')[2] === '2 KB', 'a new case is listed')
    let threw = false
    try { compare(before, { ...after, metric: 'memory' }) } catch { threw = true }
    check(threw, 'different metrics are refused')
    process.stdout.write(`${mdTable(rows)}\n\ncompare self-test passed\n`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { machine: { type: 'string' }, stat: { type: 'string', default: 'median' }, threshold: { type: 'string', default: '10' }, 'self-test': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
    allowPositionals: true,
  })
  if (values.help) { process.stdout.write(`${USAGE}\n`); return 0 }
  if (values['self-test']) { selfTest(); return 0 }
  if (positionals.length !== 2) { process.stderr.write(`${USAGE}\n`); return 2 }
  const [before, after] = positionals.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  process.stdout.write(`${header(before, after)}\n\n${mdTable(compare(before, after, { stat: values.stat, threshold: Number(values.threshold) }))}\n`)
  return 0
}

runMain(main)
