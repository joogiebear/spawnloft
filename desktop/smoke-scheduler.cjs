'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async ({ api, cli, close, launch, data, name, record }) => {
  const base = `instances/${name}`
  const logFile = path.join(data, 'run', name, 'tasks.log')
  const runs = id => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('\n').filter(line => line.includes(`\t${id}\tok\t`))
  const wait = async (check, message, ms = 20000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (await check()) return; await new Promise(r => setTimeout(r, 500)) }
    throw new Error(message)
  }
  const ids = new Set()
  let closed = false
  try {
    const made = await api(`${base}/schedules`, { name: 'Schedule smoke', action: { type: 'verify' }, schedule: { kind: 'daily', at: '03:00' }, enabled: false })
    ids.add(made.id)
    let list = await api(`${base}/schedules`)
    assert.equal(list.tasks.find(t => t.id === made.id).state, 'Disabled')
    await api(`${base}/schedules/${made.id}/enable`, { enabled: true })
    await api(`${base}/schedules/${made.id}/run`, {})
    await wait(() => runs(made.id).length > 0, 'launchd run-now must execute the bundled CLI')
    await wait(async () => (await api(`${base}/schedules`)).tasks.find(t => t.id === made.id).state !== 'Running', 'Task must exit')
    await api(`${base}/schedules/${made.id}`, { schedule: { kind: 'weekly', day: 'SUN', at: '04:00' } })
    list = await api(`${base}/schedules`)
    assert.equal(list.tasks.find(t => t.id === made.id).schedule.kind, 'weekly')
    await api(`${base}/schedules/${made.id}`, { action: { type: 'start' } })
    await api(`${base}/schedules/${made.id}/run`, {})
    await wait(() => runs(made.id).length >= 2, 'Scheduled start must reach Minecraft readiness')
    await wait(async () => (await api(`${base}/schedules`)).tasks.find(t => t.id === made.id).state !== 'Running', 'Start task must exit')
    assert.equal((await api(`${base}/metrics`)).running, true, 'Minecraft must survive the launchd task exiting')
    await api(`${base}/schedules/${made.id}`, { action: { type: 'stop' } })
    await api(`${base}/schedules/${made.id}/run`, {})
    await wait(() => runs(made.id).length >= 3, 'Scheduled stop must finish')
    await wait(async () => (await api(`${base}/schedules`)).tasks.find(t => t.id === made.id).state !== 'Running', 'Stop task must exit')
    assert.equal((await api(`${base}/metrics`)).running, false)
    await api(`${base}/schedules/${made.id}/enable`, { enabled: false })

    const auto = await api(`${base}/backups/auto`, { enabled: true, schedule: { kind: 'minutes', every: 1 }, keep: 1 })
    ids.add(auto.auto.id)
    await close(); closed = true
    await wait(() => runs(auto.auto.id).length >= 2, 'Two automatic backups must fire with the desktop closed', 150000)
    await launch(); closed = false
    await wait(async () => (await api(`${base}/schedules`)).tasks.find(t => t.id === auto.auto.id).state !== 'Running', 'Backup task must exit')
    const backups = await api(`${base}/backups`)
    assert.equal(backups.automaticAvailable, true)
    assert.equal(backups.auto.id, auto.auto.id)
    // Automatic retention must not delete the manual CLI snapshots made earlier.
    assert.ok(backups.snapshots.some(s => JSON.stringify(s).includes('cli-visible-smoke')))
    const taskLog = runs(auto.auto.id)
    assert.ok(taskLog.length >= 2)
    assert.match(taskLog.at(-1), /pruned 1 over the limit of 1/, 'Automatic backup retention must prune its previous snapshot')
    await api(`${base}/backups/auto`, { enabled: false })
    ids.delete(auto.auto.id)
    assert.ok((await api(`${base}/schedules`)).tasks.some(t => t.id === made.id), 'Turning off automatic backups preserves user tasks')
    record('PASS: native launchd create/edit/disable/enable/run-now; automatic backups fire with desktop closed and preserve manual snapshots; state survives app relaunch')
  } finally {
    if (closed) await launch()
    for (const id of ids) await cli(['task', 'rm', id])
  }
}
