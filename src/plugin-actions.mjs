import fs from 'node:fs'
import path from 'node:path'
import * as plugins from './plugins.mjs'
import * as backup from './backup.mjs'
import * as supervisor from './supervisor.mjs'
import * as activity from './activity.mjs'

/**
 * Plugin work shared by the panel and the MCP server, so the two cannot drift on what comes
 * first. Kept out of plugins.mjs because it needs backup and the supervisor, and plugins.mjs is
 * the low-level half that both of those can stay ignorant of.
 */

/** Both sources at once. One being down must not blank the other's answers, so each failure
 * becomes a note beside the results rather than an error instead of them. */
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

/** A snapshot of the plugins alone before anything is added or replaced: small, fast, and the
 * way back when the new jar turns out to be the wrong one. Installs used to skip it; a new
 * plugin can rewrite other plugins' data on its first start just as an update can. */
async function snapshotPlugins(inst, label) {
  // A server's first plugin has nothing before it to keep.
  if (!fs.existsSync(path.join(inst.dir, plugins.contentKindFor(inst).dir))) return null
  return backup.createSnapshot(inst, { scope: 'plugins', label, running: supervisor.isRunning(inst.name), quiet: true })
}

export async function installWithSnapshot(inst, projectId, { source = 'modrinth' } = {}) {
  const gameVersion = plugins.mcVersionOf(inst)
  const snap = await snapshotPlugins(inst, 'pre-install')
  const result = source === 'hangar'
    ? await plugins.installFromHangar(inst, String(projectId), { gameVersion })
    : await plugins.installPlugin(inst, String(projectId), { gameVersion })
  activity.record(inst.name, 'plugin-install', { detail: `${result.installed} ${result.version ?? ''}`.trim(), snapshot: snap ? path.basename(snap.file) : null })
  return { ...result, snapshot: snap?.file ?? null }
}

export async function updateWithSnapshot(inst, file) {
  const gameVersion = plugins.mcVersionOf(inst)
  const snap = await snapshotPlugins(inst, 'pre-update')
  const result = await plugins.updatePlugin(inst, String(file), { gameVersion })
  activity.record(inst.name, 'plugin-update', { detail: `${result.from} to ${result.updated}`, snapshot: snap ? path.basename(snap.file) : null })
  return { ...result, snapshot: snap?.file ?? null }
}

/**
 * Several updates behind one snapshot. The way back is the plugins folder as it was before any of
 * them, which is the state someone rolling back wants - and one snapshot of a folder that can run
 * to hundreds of megabytes, not one per plugin.
 *
 * <p>One at a time, in order. A failure is recorded and the rest carry on: one author pulling a
 * build must not leave every other plugin on its old version.
 */
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
