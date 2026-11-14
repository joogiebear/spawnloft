import fs from 'node:fs'
import path from 'node:path'
import * as plugins from './plugins.mjs'
import * as backup from './backup.mjs'
import * as supervisor from './supervisor.mjs'
import * as activity from './activity.mjs'

// Plugin work shared by the panel and the MCP server. Separate from plugins.mjs because it needs backup and the supervisor.

// One source being down must not blank the other's results; failures become notes beside them.
export async function searchEverywhere(inst, q) {
  const kind = plugins.contentKindFor(inst)
  // Vanilla loads nothing; a search would send Modrinth an empty loader facet and get a 400.
  if (kind.kind === 'none') return { results: [], errors: [`${kind.label} runs no plugins or mods`] }
  const asks = [plugins.searchPlugins(q, { loaders: plugins.loadersFor(inst), projectType: kind.projectType })]
  if (kind.hangar) asks.push(plugins.searchHangar(q))
  const [modrinthHits, hangarHits] = await Promise.allSettled(asks)
  const errors = []
  if (modrinthHits.status === 'rejected') errors.push(modrinthHits.reason?.message ?? 'Modrinth search failed')
  if (hangarHits && hangarHits.status === 'rejected') errors.push(hangarHits.reason?.message ?? 'Hangar search failed')
  return { results: [...(modrinthHits.value ?? []), ...(hangarHits?.value ?? [])], errors }
}

// Snapshot of the plugins folder alone before adding or replacing a jar: a new plugin can
// rewrite other plugins' data on first start just as an update can.
async function snapshotPlugins(inst, label) {
  // no plugins folder yet, nothing to snapshot
  if (!fs.existsSync(path.join(inst.dir, plugins.contentKindFor(inst).dir))) return null
  return backup.createSnapshot(inst, { scope: 'plugins', label, running: supervisor.isRunning(inst.name), quiet: true })
}

// What an install would fetch and what it needs, for the page to ask about before anything is written.
export async function planInstall(inst, projectId, { source = 'modrinth' } = {}) {
  return plugins.planInstall(inst, String(projectId), { source: source === 'hangar' ? 'hangar' : 'modrinth', gameVersion: plugins.mcVersionOf(inst) })
}

// `also` is what the thing asked for cannot load without: fetched after it, under the same one
// snapshot (the folder can be hundreds of MB). One that fails is reported and the rest carry on;
// the thing asked for stays in either way.
export async function installWithSnapshot(inst, projectId, { source = 'modrinth', also = [] } = {}) {
  const gameVersion = plugins.mcVersionOf(inst)
  const fetchOne = (id, from) => (from === 'hangar'
    ? plugins.installFromHangar(inst, String(id), { gameVersion })
    : plugins.installPlugin(inst, String(id), { gameVersion }))
  const snap = await snapshotPlugins(inst, 'pre-install')
  const snapshot = snap ? path.basename(snap.file) : null
  const result = await fetchOne(projectId, source)
  activity.record(inst.name, 'plugin-install', { detail: `${result.installed} ${result.version ?? ''}`.trim(), snapshot })
  const extras = []
  const failed = []
  for (const dep of also) {
    try {
      const got = await fetchOne(dep.projectId, dep.source)
      extras.push({ projectId: String(dep.projectId), installed: got.installed, version: got.version ?? null })
      activity.record(inst.name, 'plugin-install', { detail: `${got.installed} ${got.version ?? ''}`.trim(), snapshot })
    } catch (err) {
      failed.push({ projectId: String(dep.projectId), error: err?.message ?? String(err) })
    }
  }
  return { ...result, extras, failed, snapshot: snap?.file ?? null }
}

export async function updateWithSnapshot(inst, file) {
  const gameVersion = plugins.mcVersionOf(inst)
  const snap = await snapshotPlugins(inst, 'pre-update')
  const result = await plugins.updatePlugin(inst, String(file), { gameVersion })
  activity.record(inst.name, 'plugin-update', { detail: `${result.from} to ${result.updated}`, snapshot: snap ? path.basename(snap.file) : null })
  return { ...result, snapshot: snap?.file ?? null }
}

// One snapshot for the whole batch (the folder can be hundreds of MB), then updates run in order.
// A failure is recorded and the rest carry on.
export async function updateAllWithSnapshot(inst, files, { onProgress = () => {} } = {}) {
  const gameVersion = plugins.mcVersionOf(inst)
  const snap = await snapshotPlugins(inst, 'pre-update')
  const updated = []
  const failed = []
  for (const [index, file] of files.entries()) {
    onProgress({ file, index, total: files.length })
    try {
      updated.push({ file, ...(await plugins.updatePlugin(inst, String(file), { gameVersion })) })
    } catch (err) {
      failed.push({ file, error: err?.message ?? String(err) })
    }
  }
  if (updated.length) {
    activity.record(inst.name, 'plugin-update', {
      detail: updated.map((u) => u.updated).join(', ') + (failed.length ? `; ${failed.length} failed` : ''),
      snapshot: snap ? path.basename(snap.file) : null,
    })
  }
  return { updated, failed, snapshot: snap?.file ?? null }
}
