// Start time and memory of the installed app, for PHASE0-FINDINGS.md (P0-F).
//
//   node measure.cjs tauri    <SpawnLoft.exe> <out.json> [runs]
//   node measure.cjs electron <SpawnLoft.exe> <out.json> [runs]   (needs playwright on NODE_PATH)
//
// Start time: from spawning the exe to the panel page (http://127.0.0.1:<port>/) having loaded.
//   Tauri reports it through SPAWNLOFT_SPIKE_MEASURE (the webview's page-load-finished event);
//   Electron is driven by Playwright (load event of the first window once it is on the panel).
// Memory: 15 s after the panel loaded, the whole process tree under the exe, summed, as working
//   set and as private bytes. The Tauri tree is reported in two parts: the shell (SpawnLoft.exe
//   and its WebView2 processes) and the panel behind it (spawnloft-core ui and the Node panel,
//   which the Rust core replaces in step 2). Electron runs the panel inside its main process, so
//   its total is the comparable figure for "the app with the panel".
// Windows only. Runs are sequential; run 1 is the coldest.
'use strict'
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const [kind, exe, out, runsArg] = process.argv.slice(2)
const runs = Number(runsArg ?? 3)
if (!['tauri', 'electron'].includes(kind) || !exe || !out) {
  console.error('usage: node measure.cjs tauri|electron <exe> <out.json> [runs]')
  process.exit(64)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function processTable() {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress'
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', maxBuffer: 64 << 20 }))
}

function tree(rootPid) {
  const table = processTable()
  const byParent = new Map()
  for (const p of table) {
    if (!byParent.has(p.ParentProcessId)) byParent.set(p.ParentProcessId, [])
    byParent.get(p.ParentProcessId).push(p)
  }
  const found = []
  const walk = (pid, depth) => {
    for (const c of byParent.get(pid) ?? []) {
      found.push({ ...c, depth })
      walk(c.ProcessId, depth + 1)
    }
  }
  const root = table.find((p) => p.ProcessId === rootPid)
  if (root) found.push({ ...root, depth: 0 })
  walk(rootPid, 1)
  return found
}

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10
function sum(list) {
  return {
    processes: list.length,
    workingSetMB: mb(list.reduce((a, p) => a + Number(p.WorkingSetSize), 0)),
    // Win32_Process.PrivatePageCount is in bytes despite its name
    privateMB: mb(list.reduce((a, p) => a + Number(p.PrivatePageCount), 0)),
  }
}

function describe(list) {
  const panelRoots = list.filter((p) => /^spawnloft-core\.exe$/i.test(p.Name))
  const panelPids = new Set()
  for (const r of panelRoots) {
    panelPids.add(r.ProcessId)
    for (const p of list) if (panelPids.has(p.ParentProcessId)) panelPids.add(p.ProcessId)
  }
  const panel = list.filter((p) => panelPids.has(p.ProcessId))
  const shell = list.filter((p) => !panelPids.has(p.ProcessId))
  return {
    total: sum(list),
    shell: sum(shell),
    panel: sum(panel),
    processes: list.map((p) => `${p.Name} ${mb(Number(p.WorkingSetSize))}MB ws / ${mb(Number(p.PrivatePageCount))}MB private`),
  }
}

async function tauriRun() {
  const measureFile = path.join(os.tmpdir(), `spike-measure-${Date.now()}.json`)
  const t0 = Date.now()
  const child = spawn(exe, [], {
    env: { ...process.env, SPAWNLOFT_SPIKE_MEASURE: measureFile },
    detached: false,
    stdio: 'ignore',
  })
  let loaded = null
  for (let i = 0; i < 600 && !loaded; i++) {
    await sleep(50)
    try {
      loaded = JSON.parse(fs.readFileSync(measureFile, 'utf8'))
    } catch {}
  }
  if (!loaded) {
    child.kill()
    throw new Error('the Tauri window never reported a loaded panel within 30 s')
  }
  const startMs = loaded.panelLoadedEpochMs - t0
  await sleep(15000)
  const memory = describe(tree(child.pid))
  execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(3000)
  return { startMs, sinceMainMs: loaded.sinceMainMs, memory }
}

async function electronRun() {
  const { _electron: electron } = require('playwright')
  const t0 = Date.now()
  const app = await electron.launch({ executablePath: exe, args: [], timeout: 60000 })
  const page = await app.firstWindow({ timeout: 60000 })
  for (let i = 0; i < 600 && !page.url().startsWith('http://127.0.0.1'); i++) await sleep(50)
  await page.waitForLoadState('load')
  const startMs = Date.now() - t0
  const pid = app.process().pid
  await sleep(15000)
  const memory = describe(tree(pid))
  await app.close().catch(() => {})
  await sleep(3000)
  return { startMs, url: page.url().replace(/:\d+\//, ':<port>/'), memory }
}

;(async () => {
  const results = []
  for (let i = 0; i < runs; i++) {
    const r = kind === 'tauri' ? await tauriRun() : await electronRun()
    console.log(`${kind} run ${i + 1}: panel loaded in ${r.startMs} ms; total ${r.memory.total.workingSetMB} MB working set, ${r.memory.total.privateMB} MB private`)
    results.push(r)
  }
  const sorted = results.map((r) => r.startMs).sort((a, b) => a - b)
  const summary = {
    kind,
    exe,
    exeBytes: fs.statSync(exe).size,
    runs: results,
    startMsMedian: sorted[Math.floor(sorted.length / 2)],
    startMsFirst: results[0].startMs,
    memoryLastRun: results[results.length - 1].memory,
  }
  fs.writeFileSync(out, JSON.stringify(summary, null, 2))
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
