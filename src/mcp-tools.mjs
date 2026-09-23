import path from 'node:path'
import { getInstance, isDatabase, loadRegistry } from './registry.mjs'
import * as sup from './supervisor.mjs'
import { rconExec, stripColors } from './rcon.mjs'
import * as backup from './backup.mjs'
import * as plugins from './plugins.mjs'
import * as pluginActions from './plugin-actions.mjs'
import * as upgrade from './upgrade.mjs'
import { listPlayers, onlineNow } from './players.mjs'
import { diagnose } from './diagnose.mjs'
import { query, statusRecord } from './cli-query.mjs'
import { readMetrics } from './cli-metrics.mjs'
import { runDoctor } from './doctor.mjs'
import { readState } from './control.mjs'
import { fail, humanBytes, humanDuration } from './util.mjs'

/**
 * What an AI client may do to this machine's servers, and exactly that much.
 *
 * <p>Three tiers. Reading is always offered. Actions a person could undo - start, stop, a
 * backup, a plugin install with a snapshot before it - are offered and marked as writes, so a
 * client asks before running them. Destructive tools are not offered at all unless the client's
 * own configuration passes `--allow-destructive`; the model cannot talk its way into a tool it
 * was never shown. Those that are offered still answer a first call with a description of what
 * would happen and act only when called again with `confirm: true` - the `--yes` of the CLI.
 *
 * <p>Deliberately absent: deleting a server (worlds go with it), database credentials, and any
 * setting that holds a secret. Every result passes through `scrubber()` on the way out.
 */

const MAX_LOG_LINES = 500
const LEVEL_RE = {
  // Paper writes "[12:42:11 ERROR]:", so the level follows a space, never a bracket.
  error: / (ERROR|SEVERE|FATAL)\]|Exception/,
  warn: / (WARN|WARNING|ERROR|SEVERE|FATAL)\]|Exception/,
}
// Commands that would take the server down behind the supervisor's back - it would read the exit
// as a crash - or run Bukkit's reload, which leaves plugins half-initialised. Each has a tool.
const REFUSED_COMMANDS = new Set(['stop', 'restart', 'reload', 'rl'])

const name = { type: 'string', minLength: 1, description: 'Server name, as list_servers shows it' }
const confirm = { type: 'boolean', description: 'Leave unset first to see what would happen; true to do it' }
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const READ_NET = { ...READ, openWorldHint: true }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const WRITE_NET = { ...WRITE, openWorldHint: true }
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

function server(n) {
  const inst = getInstance(n)
  if (isDatabase(inst)) fail(`"${n}" is a database, not a Minecraft server`)
  return inst
}

function requireRunning(n) {
  if (!sup.isRunning(n)) fail(`"${n}" is not running`)
}

function snapshotRow(row) {
  return { name: row.name, scope: row.scope, label: row.label ?? null, sizeBytes: row.size,
    createdAt: row.mtime instanceof Date ? row.mtime.toISOString() : row.mtime, members: row.members ?? [] }
}

function lines(list) {
  return list.length ? list.join('\n') : '(no lines)'
}

// ------------------------------------------------------------------- read-only

const readTools = [
  {
    name: 'list_servers', title: 'List servers', annotations: READ,
    description: 'Every Minecraft server and database SpawnLoft manages on this machine, with status, ports and memory.',
    inputSchema: object(),
    run() {
      const data = query('list', [], {})
      const rows = [...data.instances, ...data.databases].map((r) =>
        `${r.name}: ${r.status}${r.kind === 'database' ? ` (database, ${r.engine})` : ''}${r.port ? `, port ${r.port}` : ''}`)
      return { data, text: rows.length ? rows.join('\n') : 'No servers yet.' }
    },
  },
  {
    name: 'server_status', title: 'Server status', annotations: READ,
    description: 'Status of one server: running or not, ports, memory, uptime and process ids.',
    inputSchema: object({ name }, ['name']),
    run({ name: n }) {
      const s = statusRecord(n)
      const parts = [`${s.name}${s.label ? ` (${s.label})` : ''}: ${s.status}`]
      if (s.port) parts.push(`port ${s.port}${s.rconPort ? `, RCON ${s.rconPort}` : ''}`)
      if (s.memory) parts.push(`${s.memory} memory`)
      if (s.status === 'running' && s.uptimeMs) parts.push(`up ${humanDuration(s.uptimeMs)}`)
      if (s.status !== 'running' && s.exitCode !== null && s.exitCode !== undefined) parts.push(`last exit code ${s.exitCode}`)
      return { data: s, text: parts.join('; ') }
    },
  },
  {
    name: 'get_logs', title: 'Read the console', annotations: READ,
    description: 'The last lines of a server console. Filter by level (error, or warn which includes errors) and/or a case-insensitive regular expression. Player IP addresses are hidden.',
    inputSchema: object({
      name,
      lines: { type: 'integer', minimum: 1, maximum: MAX_LOG_LINES, description: `How many lines to return (default 100, at most ${MAX_LOG_LINES})` },
      level: { type: 'string', enum: ['error', 'warn'], description: 'Only lines at this level or worse' },
      grep: { type: 'string', description: 'Only lines matching this regular expression (case-insensitive)' },
    }, ['name']),
    run({ name: n, lines: count = 100, level, grep }) {
      getInstance(n)
      let pattern = null
      if (grep) {
        try { pattern = new RegExp(grep, 'i') } catch (err) { fail(`grep is not a valid regular expression: ${err.message}`) }
      }
      const filtered = Boolean(level || pattern)
      let out = sup.tailLog(n, filtered ? 5000 : count)
      if (level) out = out.filter((l) => LEVEL_RE[level].test(l))
      if (pattern) out = out.filter((l) => pattern.test(l))
      out = out.slice(-count)
      return { data: { name: n, lines: out, scanned: filtered ? 5000 : count }, text: lines(out) }
    },
  },
  {
    name: 'diagnostics', title: 'Why did it fail?', annotations: READ,
    description: 'Known failure shapes found in the recent console (port taken, EULA, wrong Java, out of memory, missing dependencies, corrupt world...) with the fix for each, plus recent crash report summaries.',
    inputSchema: object({ name }, ['name']),
    run({ name: n }) {
      const d = query('diagnostics', [n], {})
      const out = [`${n} is ${d.status.status}.`]
      if (d.findings.length) {
        out.push('Known problems in the recent console, oldest first:')
        for (const f of d.findings) out.push(`- ${f.title}. ${f.advice}\n  From: ${f.line.trim()}`)
      } else {
        out.push('No known failure causes in the recent console. get_logs with level "warn" shows anything else.')
      }
      const reports = d.crashes.reports ?? []
      if (reports.length) {
        out.push(`Crash reports (${reports.length}, newest first):`)
        for (const r of reports) out.push(`- ${r.file}: ${r.description ?? 'no description line'}`)
      }
      return { data: d, text: out.join('\n') }
    },
  },
  {
    name: 'players', title: 'Players', annotations: READ,
    description: 'Who is online now (if running) and every player the server knows: ops, bans and whitelist.',
    inputSchema: object({ name }, ['name']),
    async run({ name: n }) {
      const inst = server(n)
      const online = await onlineNow(inst)
      const known = listPlayers(inst).map((p) => ({ name: p.name, uuid: p.uuid, op: p.op, banned: p.banned,
        banReason: p.banReason, whitelisted: p.whitelisted, lastSeen: p.lastSeen }))
      return { data: { name: n, running: sup.isRunning(n), online, known },
        text: `Online (${online.length}): ${online.join(', ') || 'nobody'}\nKnown players: ${known.length}` }
    },
  },
  {
    name: 'performance', title: 'Performance', annotations: READ,
    description: 'CPU (share of the whole machine) and memory over a recent window, plus TPS and MSPT from the server itself when it is running.',
    inputSchema: object({ name, seconds: { type: 'integer', minimum: 10, maximum: 86400, description: 'Window in seconds (default 600)' } }, ['name']),
    async run({ name: n, seconds = 600 }) {
      const inst = getInstance(n)
      const m = readMetrics(n, seconds)
      const cpu = m.samples.map((s) => s.cpuPercent)
      const rss = m.samples.map((s) => s.rssMiB)
      const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null)
      const summary = { samples: m.samples.length, cpuAvg: avg(cpu), cpuMax: cpu.length ? Math.max(...cpu) : null,
        cpuLast: cpu.at(-1) ?? null, memoryMiBLast: rss.at(-1) ?? null, memoryMiBMax: rss.length ? Math.max(...rss) : null }
      const tick = {}
      if (!isDatabase(inst) && sup.isRunning(n)) {
        // Paper answers tps and mspt; vanilla and Fabric answer tick query. Whatever the server does
        // not know comes back as an unknown-command line and is left out.
        for (const cmd of ['tps', 'mspt', 'tick query']) {
          try {
            const [reply] = await rconExec(inst, [cmd])
            const text = stripColors(reply ?? '').trim()
            if (text && !/unknown|incorrect argument|<--\[HERE\]/i.test(text)) tick[cmd] = text
          } catch { /* RCON unavailable: the machine-side numbers still stand */ }
          if (cmd === 'mspt' && tick.tps) break
        }
      }
      const data = { name: n, running: m.running, windowSeconds: seconds, cores: m.cores, cpuScale: m.cpuScale,
        samplingAvailable: m.samplingAvailable, summary, tick, recent: m.samples.slice(-30) }
      const text = [
        `${n}: ${m.running ? 'running' : 'not running'}; ${summary.samples} samples in the last ${seconds}s`,
        summary.samples ? `CPU avg ${summary.cpuAvg}% max ${summary.cpuMax}% (of all ${m.cores} cores); memory ${summary.memoryMiBLast} MiB (max ${summary.memoryMiBMax})` : 'No samples recorded in this window.',
        ...Object.values(tick),
      ].join('\n')
      return { data, text }
    },
  },
  {
    name: 'list_snapshots', title: 'List backups', annotations: READ,
    description: 'Backups of a server, newest first, with scope and size.',
    inputSchema: object({ name }, ['name']),
    run({ name: n }) {
      getInstance(n)
      const snapshots = backup.listSnapshots(n).map(snapshotRow)
      const text = snapshots.length
        ? snapshots.map((s) => `${s.name}: ${s.scope}, ${humanBytes(s.sizeBytes)}, taken ${s.createdAt}`).join('\n')
        : `No backups of ${n} yet. The backup tool takes one.`
      return { data: { name: n, snapshots }, text }
    },
  },
  {
    name: 'verify_snapshot', title: 'Verify a backup', annotations: READ,
    description: 'Prove a backup restores: reads the whole archive and checks it holds what its manifest says.',
    inputSchema: object({ name, snapshot: { type: 'string', description: 'Snapshot name, or "latest" (default)' } }, ['name']),
    async run({ name: n, snapshot = 'latest' }) {
      getInstance(n)
      const res = await backup.verifySnapshot(n, snapshot)
      const { snapshot: snap, ...rest } = res
      return { data: { name: n, snapshot: snap.name, ...rest },
        text: res.ok ? `ok: ${snap.name}${res.hasManifest ? '' : ' (no manifest, so only the archive itself was checked)'}` : `FAILED: ${snap.name}: ${[...res.problems, ...res.missing.map((m) => `missing ${m}`)].join('; ')}` }
    },
    failed: (data) => data && data.ok === false,
  },
  {
    name: 'list_plugins', title: 'List plugins', annotations: READ,
    description: 'Plugins (or mods) installed on a server. "managed" ones were installed by SpawnLoft and can be updated by it; the rest are the owner\'s own and are never touched.',
    inputSchema: object({ name }, ['name']),
    run({ name: n }) {
      const rows = plugins.listPlugins(server(n)).map(({ mtime, ...p }) => p)
      return { data: { name: n, plugins: rows },
        text: rows.length ? rows.map((p) => `${p.name} ${p.version ?? ''}${p.enabled ? '' : ' (disabled)'}${p.managed ? ` [${p.source}]` : ''}`).join('\n') : 'No plugins installed.' }
    },
  },
  {
    name: 'search_plugins', title: 'Search plugins', annotations: READ_NET,
    description: 'Search Modrinth (and Hangar, for Paper servers) for plugins or mods this server can load. Use the id and source from a result with install_plugin.',
    inputSchema: object({ name, query: { type: 'string', minLength: 1, description: 'What to search for' } }, ['name', 'query']),
    async run({ name: n, query: q }) {
      const { results, errors } = await pluginActions.searchEverywhere(server(n), q)
      const top = results.slice(0, 20).map(({ icon, ...r }) => r)
      const text = [...top.map((r) => `${r.title} (${r.source} id ${r.id}, ${r.downloads} downloads): ${r.description}`),
        ...errors.map((e) => `note: ${e}`)].join('\n') || 'No results.'
      return { data: { name: n, query: q, results: top, errors }, text }
    },
  },
  {
    name: 'check_plugin_updates', title: 'Check plugin updates', annotations: READ_NET,
    description: 'Which plugins SpawnLoft installed have a newer build for this server.',
    inputSchema: object({ name }, ['name']),
    async run({ name: n }) {
      const inst = server(n)
      const updates = await plugins.checkUpdates(inst, { gameVersion: plugins.mcVersionOf(inst) })
      const all = plugins.listPlugins(inst)
      const managed = all.filter((p) => p.managed).length
      const own = all.length - managed
      const note = own ? ` ${own} other plugin(s) were added by hand and are not checked; SpawnLoft never touches those.` : ''
      const text = !managed
        ? `SpawnLoft has not installed any plugins on ${n}, so there is nothing it can update.${note}`
        : updates.length
          ? [`${updates.length} of ${managed} can be updated:`,
            ...updates.map((u) => `- ${u.name}: ${u.installedVersion ?? '?'} -> ${u.latestVersion} (update_plugin with file "${u.file}")`)].join('\n') + note
          : `All ${managed} plugin(s) SpawnLoft installed are up to date.${note}`
      return { data: { name: n, updates }, text }
    },
  },
  {
    name: 'check_server_update', title: 'Check for a Paper update', annotations: READ_NET,
    description: 'Whether a newer Paper build exists for the server\'s Minecraft version (upgrade_build applies it), and which newer Minecraft versions exist.',
    inputSchema: object({ name }, ['name']),
    async run({ name: n }) {
      const info = await upgrade.checkUpgrade(server(n))
      const text = !info.current
        ? `${n} does not run a Paper jar SpawnLoft recognises. Newest Paper is for ${info.latestVersion}.`
        : [`${n} runs Paper ${info.current.version} build ${info.current.build}.`,
          info.buildUpdate ? `Build ${info.latestBuild.build} is available (upgrade_build applies it).` : 'That is the newest build for its version.',
          info.newerVersions.length ? `Newer Minecraft versions: ${info.newerVersions.join(', ')} (crossing one migrates the worlds for good).` : ''].filter(Boolean).join('\n')
      return { data: { name: n, ...info }, text }
    },
  },
  {
    name: 'doctor', title: 'Check this machine', annotations: READ,
    description: 'Environment checks: Java, tar, every server\'s folder, jar, EULA, port collisions, orphaned processes and RCON exposure. Changes nothing.',
    inputSchema: object(),
    async run() {
      const data = await runDoctor({ repair: false })
      return { data, text: data.healthy ? 'No problems found.' : `${data.problems.length} problem(s):\n- ${data.problems.join('\n- ')}` }
    },
  },
]

// ---------------------------------------------------------------------- actions

async function startTool(n, wait, progress) {
  const inst = getInstance(n)
  progress(`Starting ${n}`)
  // Reported every few seconds so a client with a short timeout sees it is alive.
  const tick = setInterval(() => progress(`Waiting for ${n} to be ready: ${sup.tailLog(n, 1)[0] ?? ''}`.slice(0, 200)), 5000)
  let res
  try {
    res = await sup.start(n, { wait, timeout: 180000 })
  } finally {
    clearInterval(tick)
  }
  if (!wait) return { data: { name: n, started: true, ready: false, javaPid: res.javaPid }, text: `${n} launched; not waiting for ready.` }
  if (res.ready) return { data: { name: n, started: true, ready: true, readyLine: res.readyLine }, text: `${n} is ready: ${res.readyLine}` }
  const tail = sup.tailLog(n, 25)
  const findings = isDatabase(inst) ? [] : diagnose(sup.tailLog(n, 400), { port: inst.port, memory: inst.memory,
    dir: inst.dir, crashDir: path.join(inst.dir, 'crash-reports') })
  return {
    data: { name: n, started: true, ready: false, failed: Boolean(res.failed), reason: res.reason ?? 'timed out waiting for ready', findings, lastLines: tail },
    text: `${n} did not reach ready: ${res.reason ?? 'timed out after 180s (it may still be loading)'}\n\nLast console lines:\n${lines(tail)}`,
  }
}

const actionTools = [
  {
    name: 'start', title: 'Start a server', annotations: WRITE,
    description: 'Start a server (or database) and wait until it reports ready, up to three minutes. On failure, returns the likely cause and the last console lines.',
    inputSchema: object({ name, wait: { type: 'boolean', description: 'Wait for ready (default true). False returns as soon as it launches.' } }, ['name']),
    run: ({ name: n, wait = true }, { progress }) => startTool(n, wait, progress),
    failed: (data) => data.started && data.ready === false && data.reason !== undefined,
  },
  {
    name: 'stop', title: 'Stop a server', annotations: WRITE,
    description: 'Stop a server gracefully (it saves its worlds), falling back to a kill after 90 seconds.',
    inputSchema: object({ name }, ['name']),
    async run({ name: n }, { progress }) {
      progress(`Stopping ${n}`)
      const res = await sup.stop(n)
      const text = res.alreadyStopped ? `${n} was not running.` : res.forced ? `${n} did not shut down in time and was killed.` : `${n} stopped.`
      return { data: { name: n, ...res }, text }
    },
  },
  {
    name: 'restart', title: 'Restart a server', annotations: WRITE,
    description: 'Stop a server if it is running, then start it and wait for ready.',
    inputSchema: object({ name }, ['name']),
    async run({ name: n }, { progress }) {
      const { status } = readState(n)
      if (status === 'running' || status === 'stopping') {
        progress(`Stopping ${n}`)
        await sup.stop(n)
      }
      return startTool(n, true, progress)
    },
    failed: (data) => data.ready === false,
  },
  {
    name: 'run_command', title: 'Run a console command', annotations: WRITE,
    description: 'Run one command on a running server over RCON and return its reply, e.g. "list", "tps", "whitelist add Steve". Use the stop and restart tools instead of those commands.',
    inputSchema: object({ name, command: { type: 'string', minLength: 1, description: 'The command, without a leading slash' } }, ['name', 'command']),
    async run({ name: n, command }) {
      const inst = server(n)
      const line = command.trim().replace(/^\//, '')
      const verb = line.split(/\s+/)[0].toLowerCase().replace(/^[a-z0-9_.-]+:/, '')
      if (REFUSED_COMMANDS.has(verb)) {
        fail(`"${verb}" is not run over RCON here: ${verb === 'stop' ? 'use the stop tool' : verb === 'restart' ? 'use the restart tool' : 'reloading plugins in place breaks them; use the restart tool'}`)
      }
      requireRunning(n)
      const [reply] = await rconExec(inst, [line])
      const text = stripColors(reply ?? '').trimEnd()
      return { data: { name: n, command: line, reply: text }, text: text || '(no output)' }
    },
  },
  {
    name: 'backup', title: 'Back up a server', annotations: WRITE,
    description: 'Take a snapshot. Safe while running: the world is saved to disk first. Scopes: standard (plugins, worlds, config; default), full, plugins, worlds, config.',
    inputSchema: object({
      name,
      scope: { type: 'string', enum: backup.SCOPES, description: 'What to include (default standard)' },
      label: { type: 'string', description: 'A short label for the snapshot name' },
    }, ['name']),
    async run({ name: n, scope = 'standard', label = null }, { progress }) {
      const inst = getInstance(n)
      progress(`Snapshotting ${n} (${scope})`)
      const res = await backup.createSnapshot(inst, { scope, label, running: sup.isRunning(n) })
      const data = { name: n, snapshot: path.basename(res.file), sizeBytes: res.size, scope, members: res.members,
        databases: res.databases ?? [], databasesSkipped: res.databasesSkipped ?? [], warnings: res.manifest?.warnings ?? [],
        mirrored: Boolean(res.mirrored), mirrorError: res.mirrorError ?? null }
      return { data, text: `Wrote ${data.snapshot} (${Math.round(res.size / 1048576 * 10) / 10} MiB): ${res.members.join(', ')}` +
        (data.databasesSkipped.length ? `\nWARNING: ${data.databasesSkipped.map((d) => `${d.database} not included: ${d.reason}`).join('; ')}` : '') }
    },
  },
  {
    name: 'install_plugin', title: 'Install a plugin', annotations: WRITE_NET,
    description: 'Install a plugin (or mod) from search_plugins results. A plugins snapshot is taken first. Takes effect at the next restart.',
    inputSchema: object({
      name,
      project_id: { type: 'string', minLength: 1, description: 'The id from a search_plugins result' },
      source: { type: 'string', enum: ['modrinth', 'hangar'], description: 'The source from that result (default modrinth)' },
    }, ['name', 'project_id']),
    async run({ name: n, project_id: id, source = 'modrinth' }, { progress }) {
      progress('Snapshotting plugins, then downloading')
      const res = await pluginActions.installWithSnapshot(server(n), id, { source })
      const snapshot = res.snapshot ? path.basename(res.snapshot) : null
      const text = [`Installed ${res.installed} (${res.version}) on ${n}. It loads at the next restart.`,
        res.versionNote,
        snapshot ? `Snapshot taken first: ${snapshot}.` : 'No snapshot: this is the first plugin on the server.'].filter(Boolean).join('\n')
      return { data: { name: n, ...res, snapshot }, text }
    },
  },
  {
    name: 'update_plugin', title: 'Update a plugin', annotations: WRITE_NET,
    description: 'Update one plugin SpawnLoft installed (see check_plugin_updates) by its file name. A plugins snapshot is taken first. Takes effect at the next restart.',
    inputSchema: object({ name, file: { type: 'string', minLength: 1, description: 'The plugin\'s file name, from list_plugins' } }, ['name', 'file']),
    async run({ name: n, file }, { progress }) {
      progress('Snapshotting plugins, then downloading')
      const res = await pluginActions.updateWithSnapshot(server(n), file)
      const snapshot = res.snapshot ? path.basename(res.snapshot) : null
      const text = res.alreadyLatest
        ? `${file} is already the newest build (${res.version}).`
        : [`Updated ${res.from} to ${res.updated} (${res.version}) on ${n}. It loads at the next restart.`,
          res.versionNote, snapshot ? `Snapshot taken first: ${snapshot}.` : null].filter(Boolean).join('\n')
      return { data: { name: n, ...res, snapshot }, text }
    },
  },
  {
    name: 'upgrade_build', title: 'Update Paper', annotations: WRITE_NET,
    description: 'Move a server to the newest Paper build of the Minecraft version it already runs. The old jar is kept beside it. Takes effect at the next start. Crossing Minecraft versions is upgrade_minecraft.',
    inputSchema: object({ name }, ['name']),
    async run({ name: n }, { progress }) {
      const inst = server(n)
      if (!upgrade.parsePaperJar(inst.jar)) fail(`${inst.jar} is not a Paper jar SpawnLoft recognises`)
      progress('Downloading the newest build')
      const running = sup.isRunning(n)
      const res = await upgrade.applyUpgrade(n, { running })
      if (res.alreadyCurrent) return { data: { name: n, alreadyCurrent: true, jar: res.jar }, text: `${n} already runs the newest build (${res.jar}).` }
      return { data: { name: n, from: res.from, to: res.to, channel: res.channel, takesEffect: running ? 'next restart' : 'next start' },
        text: `${n}: ${res.from} -> ${res.to}. ${running ? 'Restart the server to load it.' : 'Takes effect at the next start.'}` }
    },
  },
]

// -------------------------------------------------------------------- destructive

const destructiveTools = [
  {
    name: 'restore', title: 'Restore a backup', annotations: DESTROY,
    description: 'Overwrite a stopped server\'s files with a snapshot (and import any database dumps in it). Call without confirm first to see exactly what it overwrites.',
    inputSchema: object({ name, snapshot: { type: 'string', description: 'Snapshot name, or "latest" (default)' }, confirm }, ['name']),
    async run({ name: n, snapshot = 'latest', confirm: yes = false }, { progress }) {
      const inst = getInstance(n)
      if (sup.isRunning(n)) fail(`"${n}" is running - stop it before restoring`)
      const snap = backup.resolveSnapshot(n, snapshot)
      if (!yes) {
        return { data: { name: n, confirmed: false, snapshot: snap.name, scope: snap.scope, overwrites: snap.members,
          imports: (snap.databases ?? []).map((d) => ({ database: d.database, service: d.service })) },
        text: `Would restore ${snap.name} into ${n}, overwriting: ${snap.members.join(', ') || '(see manifest)'}. Nothing has changed yet; call again with confirm: true to do it.` }
      }
      progress(`Restoring ${snap.name}`)
      const res = await backup.restoreSnapshot(inst, snap)
      const imported = res.databases?.imported ?? []
      const skipped = res.databases?.skipped ?? []
      const text = [`Restored ${snap.name} into ${n}. Start it to use the restored files.`,
        ...imported.map((d) => `Imported database ${d.database} into ${d.service}.`),
        ...skipped.map((d) => `NOT imported: database ${d.database}: ${d.reason}. The dump is left in the server folder to import by hand.`)].join('\n')
      return { data: { name: n, confirmed: true, snapshot: snap.name, restored: res.restored,
        databasesImported: imported, databasesSkipped: skipped }, text }
    },
    failed: (data) => data.databasesSkipped?.length > 0,
  },
  {
    name: 'kill', title: 'Force-kill a server', annotations: DESTROY,
    description: 'Kill a server\'s process immediately, without saving. Anything since the last autosave is lost. Only for a server that will not stop. Call without confirm first.',
    inputSchema: object({ name, confirm }, ['name']),
    async run({ name: n, confirm: yes = false }) {
      getInstance(n)
      const { status } = readState(n)
      if (!yes) {
        return { data: { name: n, confirmed: false, status },
          text: `${n} is ${status}. Killing it skips the world save. Nothing has changed yet; call again with confirm: true to do it, or try stop first.` }
      }
      const res = await sup.kill(n)
      return { data: { name: n, confirmed: true, ...res },
        text: res.alreadyStopped ? `${n} was not running; nothing was killed.` : `${n} was force-killed. Anything since its last autosave is lost.` }
    },
  },
  {
    name: 'upgrade_minecraft', title: 'Upgrade Minecraft version', annotations: { ...DESTROY, openWorldHint: true },
    description: 'Move a server to a newer Minecraft version. Its worlds migrate on the next start and cannot migrate back; a snapshot is taken first. Call without confirm first.',
    inputSchema: object({ name, version: { type: 'string', minLength: 1, description: 'Target Minecraft version, from check_server_update' }, confirm }, ['name', 'version']),
    async run({ name: n, version, confirm: yes = false }, { progress }) {
      const inst = server(n)
      const current = upgrade.parsePaperJar(inst.jar)
      if (!current) fail(`${inst.jar} is not a Paper jar SpawnLoft recognises`)
      if (version === current.version) fail(`${n} already runs ${version}; use upgrade_build for a newer build of it`)
      if (!yes) {
        return { data: { name: n, confirmed: false, from: current.version, to: version },
          text: `Would move ${n} from Minecraft ${current.version} to ${version}. Worlds migrate one way on the next start; a snapshot is taken first. Check that its plugins support ${version}. Nothing has changed yet; call again with confirm: true to do it.` }
      }
      progress(`Downloading Paper ${version}`)
      const running = sup.isRunning(n)
      const res = await upgrade.applyUpgrade(n, { version, running })
      const snapshot = res.snapshot ? path.basename(res.snapshot) : null
      return { data: { name: n, confirmed: true, from: res.from, to: res.to, snapshot, takesEffect: running ? 'next restart' : 'next start' },
        text: `${n}: ${res.from} -> ${res.to}. The worlds migrate at the ${running ? 'next restart' : 'next start'}.` +
          (snapshot ? ` The way back is the snapshot ${snapshot}, restored with restore.` : '') }
    },
  },
]

export function toolsFor({ allowDestructive = false } = {}) {
  return [...readTools, ...actionTools, ...(allowDestructive ? destructiveTools : [])]
}

export const INSTRUCTIONS = `SpawnLoft runs Minecraft servers on this computer. Start with list_servers to learn the server names.
Changes to plugins and Paper take effect when the server next restarts. install_plugin and update_plugin take a plugins snapshot first; take a backup yourself before anything else risky.
When a server will not start, read diagnostics before get_logs. For get_logs, prefer level "warn" over reading everything.
Destructive tools (restore, kill, upgrade_minecraft), when present, describe what they would do unless called with confirm: true; show that description to the user before confirming.`

// ------------------------------------------------------------------ redaction

/**
 * Everything that leaves goes through this. The projections above already leave credentials
 * out; this is the net under them, for a password that turns up somewhere nobody expected - a
 * plugin echoing its database URL into the console, say. Secrets are read fresh on each call so
 * a password changed while the server runs is still caught.
 *
 * <p>Player IP addresses are hidden by default: Paper logs one on every join, and many of the
 * people on these servers are children. `showIps` is the owner's call, made in the client config.
 */
export function scrubber({ showIps = false, secrets = collectSecrets } = {}) {
  return (text) => {
    if (typeof text !== 'string' || !text) return text
    let out = text
    for (const secret of secrets()) out = out.split(secret).join('[redacted]')
    if (!showIps) out = hideIps(out)
    return out
  }
}

// Java prints a socket address as "/203.0.113.5:51234" (or "/[2001:db8::1]:51234"), which is
// how every join, disconnect and ban line carries one.
const IP_RE = /\/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.%a-zA-Z0-9]+\]|[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7})(?=:\d{1,5}\b)/g
export function hideIps(text) {
  return text.replace(IP_RE, '/[ip hidden]')
}

function collectSecrets() {
  const found = new Set()
  const walk = (value, key = '') => {
    if (typeof value === 'string') {
      if (/password|webhook|secret|token/i.test(key) && value.length >= 4) found.add(value)
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k)
    }
  }
  try { walk(loadRegistry()) } catch { /* no registry yet: nothing to hide */ }
  // Longest first, so a secret containing another is not half-replaced.
  return [...found].sort((a, b) => b.length - a.length)
}
