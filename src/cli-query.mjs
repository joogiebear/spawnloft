import path from 'node:path'
import { listInstances, listServices, getInstance } from './registry.mjs'
import { statusOf, tailLog } from './supervisor.mjs'
import { listPlugins } from './plugins.mjs'
import { listSnapshots } from './backup.mjs'
import { diagnose, crashReports } from './diagnose.mjs'
import { checkFlags, instanceName, UsageError } from './cli-output.mjs'

export const QUERY_ALIASES = {
  list: 'list', ls: 'list', status: 'status', plugins: 'plugins',
  snapshots: 'backups', backups: 'backups', why: 'diagnostics', diagnostics: 'diagnostics',
}

/** Status is a public automation record, not a dump of the registry. In particular,
 * RCON passwords, database users/passwords, webhook URLs, and JVM arguments stay out. */
export function statusRecord(name) {
  const row = statusOf(name)
  return {
    name: row.name, label: row.label ?? null, kind: row.kind ?? 'server',
    status: row.external ? 'external' : row.status,
    directory: row.dir ?? null, jar: row.jar ?? null, memory: row.memory ?? null,
    port: row.port ?? null, rconPort: row.rcon?.port ?? null,
    engine: row.engine ?? null, external: Boolean(row.external),
    javaPid: row.javaPid, daemonPid: row.daemonPid, javaAlive: row.javaAlive,
    startedAt: row.startedAt, uptimeMs: row.uptimeMs, exitCode: row.exitCode,
    consoleLog: row.consoleLog,
  }
}

export function query(command, positional, flags) {
  checkFlags(flags, ['json'])
  if (command === 'list' || (command === 'status' && positional.length === 0)) {
    if (positional.length) throw new UsageError('Usage: spawnloft list --json')
    return { instances: listInstances().map(row => statusRecord(row.name)),
      databases: listServices().map(row => statusRecord(row.name)) }
  }
  const name = instanceName(positional, command)
  const inst = getInstance(name)
  if (command === 'status') return statusRecord(name)
  if (command === 'plugins') return { instance: name, plugins: listPlugins(inst) }
  if (command === 'backups') return { instance: name, backups: listSnapshots(name).map(row => ({
    name: row.name, path: row.path, sizeBytes: row.size, modifiedAt: row.mtime.toISOString(),
    scope: row.scope, label: row.label, taskId: row.taskId, members: row.members,
  })) }
  if (command === 'diagnostics') {
    const findings = diagnose(tailLog(name, 400), { port: inst.port, memory: inst.memory,
      dir: inst.dir, crashDir: path.join(inst.dir, 'crash-reports') })
    return { instance: name, status: statusRecord(name), findings, crashes: crashReports(inst, { limit: 5 }),
      scope: 'recent-console-and-crash-reports' }
  }
  throw new UsageError(`JSON output is not supported for ${command}`)
}
