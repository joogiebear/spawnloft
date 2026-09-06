#!/usr/bin/env node
/**
 * mcctl - the SpawnLoft command line. A local Minecraft server control plane.
 *
 * Manages multiple server instances on this machine: detached launch with
 * captured console, RCON command/response, stdin injection, and snapshots.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'

import { ensureDirs, ROOT, runDir } from './src/paths.mjs'
import { listInstances, getInstance, removeInstance, updateInstance, serverJarPath, assertPortUsable } from './src/registry.mjs'
import { acceptableWebhook, notifyInstance } from './src/notify.mjs'
import * as plugins from './src/plugins.mjs'
import * as upgrade from './src/upgrade.mjs'
import * as sources from './src/sources.mjs'
import * as software from './src/software.mjs'
import * as mrpack from './src/mrpack.mjs'
import * as neoforge from './src/neoforge.mjs'
import * as worlds from './src/worlds.mjs'
import { diagnose, crashReports } from './src/diagnose.mjs'
import { readState, clearState } from './src/control.mjs'
import * as services from './src/services.mjs'
import { listServices, isDatabase } from './src/registry.mjs'
import * as sup from './src/supervisor.mjs'
import { rconExec, stripColors } from './src/rcon.mjs'
import * as backup from './src/backup.mjs'
import * as create from './src/create.mjs'
import * as paper from './src/paper.mjs'
import * as ui from './src/ui.mjs'
import * as manage from './src/manage.mjs'
import * as settings from './src/settings.mjs'
import * as java from './src/java.mjs'
import * as schedule from './src/schedule.mjs'
import * as paths from './src/paths.mjs'
import { readProps, writeProps } from './src/props.mjs'
import { UserError, fail, table, humanBytes, humanDuration, dirSize, isPortFree, sleep, cleanLabel } from './src/util.mjs'
import { parseArgs } from './src/args.mjs'

const out = (msg = '') => process.stdout.write(`${msg}\n`)

function requireName(positional, command) {
  const name = positional[0]
  if (!name) fail(`${command} requires an instance name. See: mcctl list`)
  return name
}

// -------------------------------------------------------------------- display

const STATUS_LABEL = {
  running: 'running',
  stopped: 'stopped',
  stopping: 'stopping',
  orphaned: 'ORPHANED',
  stale: 'stale',
}

function cmdList() {
  const instances = listInstances()
  if (!instances.length) {
    out('No instances registered.')
    out('')
    out('  Adopt an existing server:  mcctl adopt <name> <path-to-server-dir>')
    out('  Create a fresh one:        mcctl new <name> --jar <jar> --accept-eula')
    return
  }
  const rows = [['NAME', 'STATUS', 'PORT', 'RCON', 'MEM', 'UPTIME', 'DIR']]
  for (const inst of instances) {
    const { status, state } = readState(inst.name)
    rows.push([
      inst.name,
      STATUS_LABEL[status] ?? status,
      inst.port,
      inst.rcon?.port ?? '-',
      inst.memory,
      status === 'running' && state?.startedAt ? humanDuration(Date.now() - state.startedAt) : '-',
      inst.dir,
    ])
  }
  out(table(rows))
  const dbs = listServices()
  if (dbs.length) {
    out('')
    out(table(databaseRows(dbs)))
  }
}

function databaseRows(dbs) {
  const rows = [['DATABASE', 'STATUS', 'ENGINE', 'PORT', 'ATTACHED', 'UPTIME', 'DIR']]
  for (const db of dbs) {
    const { status, state } = readState(db.name)
    rows.push([
      db.name,
      db.external ? 'external' : (STATUS_LABEL[status] ?? status),
      `${services.ENGINES[db.engine]?.label ?? db.engine} ${db.version ?? ''}`.trim(),
      db.external ? `${db.host ?? '127.0.0.1'}:${db.port}` : db.port,
      Object.keys(db.attachments ?? {}).join(', ') || '-',
      status === 'running' && state?.startedAt ? humanDuration(Date.now() - state.startedAt) : '-',
      db.dir ?? '-',
    ])
  }
  return rows
}

function databaseStatus(st) {
  const rows = [
    ['database', st.name],
    ['label', st.label ?? '(none)'],
    ['status', STATUS_LABEL[st.status] ?? st.status],
    ['engine', `${services.ENGINES[st.engine]?.label ?? st.engine} ${st.version}`],
    ['directory', st.dir],
    ['host', '127.0.0.1'],
    ['port', String(st.port)],
    ['attached', Object.keys(st.attachments ?? {}).join(', ') || '(none)'],
  ]
  if (st.status === 'running' || st.status === 'stopping') {
    rows.push(['engine pid', String(st.javaPid)], ['daemon pid', String(st.daemonPid)], ['uptime', humanDuration(st.uptimeMs)])
  } else if (st.exitCode !== null && st.exitCode !== undefined) {
    rows.push(['last exit code', String(st.exitCode)])
  }
  rows.push(['console log', st.consoleLog])
  out(table(rows.map(([k, v]) => [`${k}:`, v])))
}

function cmdStatus(positional) {
  if (!positional[0]) return cmdList()
  const name = positional[0]
  const st = sup.statusOf(name)
  if (isDatabase(st)) return databaseStatus(st)
  const props = readProps(path.join(st.dir, 'server.properties'))
  const rows = [
    ['instance', st.name],
    ['label', st.label ?? '(none)'],
    ['status', STATUS_LABEL[st.status] ?? st.status],
    ['directory', st.dir],
    ['jar', st.jar],
    ['memory', st.memory],
    ['java', st.java || 'java'],
    ['port', String(st.port)],
    ['rcon port', String(st.rcon?.port ?? '-')],
    ['level-name', props.get('level-name') ?? '(unset)'],
    ['motd', props.get('motd') ?? '(unset)'],
    ['online-mode', props.get('online-mode') ?? '(unset)'],
  ]
  if (st.status === 'running' || st.status === 'stopping') {
    rows.push(['java pid', String(st.javaPid)], ['daemon pid', String(st.daemonPid)], ['uptime', humanDuration(st.uptimeMs)])
  } else if (st.exitCode !== null && st.exitCode !== undefined) {
    rows.push(['last exit code', String(st.exitCode)])
  }
  rows.push(['console log', st.consoleLog])
  out(table(rows.map(([k, v]) => [`${k}:`, v])))
}

/** The console's known failure shapes, printed as advice. Shared by start-failure and `why`. */
function printFindings(name) {
  const inst = getInstance(name)
  const findings = diagnose(sup.tailLog(name, 400), {
    port: inst.port,
    memory: inst.memory,
    dir: inst.dir,
    crashDir: path.join(inst.dir, 'crash-reports'),
  })
  for (const f of findings) {
    out('')
    out(`>> ${f.title}`)
    out(`   ${f.advice}`)
  }
  return findings.length
}

/**
 * The question a dead server actually raises, answered from its own console. Reads the
 * known failure shapes out of the last run and lists Minecraft's own crash reports; when
 * nothing matches, it says so instead of guessing.
 */
function cmdWhy(positional) {
  const name = requireName(positional, 'why')
  const inst = getInstance(name)
  const found = printFindings(name)
  if (!found) {
    out('Nothing SpawnLoft recognises in the recent console. The last lines of the log are the')
    out(`next place to look: mcctl logs ${name} -n 60 --grep " ERROR]| WARN]|Exception"`)
  }
  const crashes = crashReports(inst, { limit: 5 })
  if (crashes.reports.length) {
    out('')
    out(`Crash reports (${crashes.reports.length} newest, in ${crashes.dir}):`)
    for (const r of crashes.reports) {
      out(`  ${r.file}  ${r.description ? `- ${r.description}` : ''}`)
    }
  }
}

// --------------------------------------------------------------- lifecycle

async function cmdStart(positional, flags) {
  const name = requireName(positional, 'start')
  const wait = flags.wait !== false && !flags.detach
  const timeout = Number(flags.timeout ?? 180) * 1000
  out(`Starting "${name}"...`)
  // --force: start on a Java the version is known to be too old for, for whoever knows better.
  const res = await sup.start(name, { wait, timeout, sync: flags.sync !== false, force: Boolean(flags.force) })

  if (!wait) {
    out(`Launched (java pid ${res.javaPid}). Not waiting for ready.`)
    out(`Follow with: mcctl logs ${name} -f`)
    return
  }
  if (res.ready) {
    const inst = getInstance(name)
    out(`Ready - ${res.readyLine}`)
    out(`  java pid ${res.javaPid}   port ${inst.port}   rcon ${inst.rcon.port}`)
    return
  }
  if (res.failed) {
    out(`Server did not reach ready state: ${res.reason}`)
    printFindings(name)
    out('')
    out('Last 25 console lines:')
    for (const line of sup.tailLog(name, 25)) out(`  ${line}`)
    process.exitCode = 1
    return
  }
  out(`Timed out after ${timeout / 1000}s waiting for ready. The server may still be loading.`)
  out(`Follow with: mcctl logs ${name} -f`)
  process.exitCode = 1
}

async function cmdStop(positional, flags) {
  const name = requireName(positional, 'stop')
  const timeout = Number(flags.timeout ?? 90) * 1000
  out(`Stopping "${name}"...`)
  const res = await sup.stop(name, { timeout })
  if (res.alreadyStopped) out(`"${name}" was not running.`)
  else if (res.forced) out(`"${name}" did not shut down gracefully and was killed.`)
  else out(`"${name}" stopped (exit code ${res.code ?? 0}).`)
}

async function cmdRestart(positional, flags) {
  const name = requireName(positional, 'restart')
  const { status } = readState(name)
  if (status === 'running' || status === 'stopping') {
    out(`Stopping "${name}"...`)
    await sup.stop(name, { timeout: Number(flags.timeout ?? 90) * 1000 })
  }
  await cmdStart(positional, flags)
}

async function cmdKill(positional) {
  const name = requireName(positional, 'kill')
  const res = await sup.kill(name)
  if (res.alreadyStopped) out(`"${name}" was not running.`)
  else out(`"${name}" force-killed.`)
}

// ------------------------------------------------------------------- console

function cmdLogs(positional, flags) {
  const name = requireName(positional, 'logs')
  getInstance(name)
  const count = Number(flags.n ?? flags.lines ?? 60)
  const grep = flags.grep ? new RegExp(flags.grep, 'i') : null

  const lines = sup.tailLog(name, grep ? Math.max(count, 5000) : count)
  const shown = grep ? lines.filter((l) => grep.test(l)).slice(-count) : lines
  for (const line of shown) out(line)

  if (flags.f || flags.follow) {
    out('--- following (ctrl-c to stop) ---')
    sup.followLog(name, (line) => {
      if (!grep || grep.test(line)) out(line)
    })
    return new Promise(() => {}) // follow until interrupted
  }
  return undefined
}

async function cmdCmd(positional, flags) {
  const name = requireName(positional, 'cmd')
  const command = positional.slice(1).join(' ').trim()
  if (!command) fail('cmd requires a command, e.g. mcctl cmd survival "tps"')
  const inst = getInstance(name)
  if (!sup.isRunning(name)) fail(`instance "${name}" is not running`)

  const [response] = await rconExec(inst, [command])
  const text = flags.raw ? response : stripColors(response)
  if (text.trim()) out(text.trimEnd())
  else out('(no output)')
}

async function cmdSend(positional) {
  const name = requireName(positional, 'send')
  const line = positional.slice(1).join(' ')
  if (!line.trim()) fail('send requires a line to write to the server console')
  await sup.sendConsole(name, line)
  out(`> ${line}`)
}

async function cmdPlayers(positional) {
  const name = requireName(positional, 'players')
  const inst = getInstance(name)
  if (!sup.isRunning(name)) fail(`instance "${name}" is not running`)
  const [res] = await rconExec(inst, ['list'])
  out(stripColors(res).trim())
}

async function cmdConsole(positional) {
  const name = requireName(positional, 'console')
  getInstance(name)
  if (!sup.isRunning(name)) fail(`instance "${name}" is not running`)

  out(`--- attached to "${name}" (ctrl-c or "/detach" to leave; the server keeps running) ---`)
  for (const line of sup.tailLog(name, 20)) out(line)

  const stop = sup.followLog(name, (line) => out(line))
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' })

  await new Promise((resolve) => {
    rl.on('line', async (line) => {
      const trimmed = line.trim()
      if (trimmed === '/detach' || trimmed === '/exit') {
        rl.close()
        return
      }
      if (!trimmed) return
      try {
        await sup.sendConsole(name, trimmed)
      } catch (err) {
        out(`[mcctl] ${err.message}`)
      }
    })
    rl.on('close', resolve)
    rl.on('SIGINT', () => rl.close())
  })
  stop()
  out(`--- detached from "${name}" (still running) ---`)
}

// --------------------------------------------------------------- provisioning

async function cmdNew(positional, flags) {
  const name = requireName(positional, 'new')

  // --modpack <slug> is its own creation path: the pack decides the loader, the Minecraft
  // version, the mods and the config, so the usual flags for those do not apply.
  if (flags.modpack) {
    const res = await mrpack.createFromModpack(name, String(flags.modpack), {
      memory: flags.memory ?? '4G',
      port: flags.port ? Number(flags.port) : null,
      onlineMode: !flags.offline,
      onProgress: ({ message }) => out(`  ${message}`),
    })
    out('')
    out(`Created "${res.name}" from ${res.pack} ${res.packVersion}`)
    out(table([
      ['minecraft:', res.mc],
      ['loader:', `${res.loader.kind} ${res.loader.version}`],
      ['pack files:', String(res.files) + (res.skippedClientOnly ? ` (${res.skippedClientOnly} client-only skipped)` : '')],
      ['port:', String(res.port)],
    ]))
    out('')
    out(`Start it with: mcctl start ${name}`)
    out('Players need the matching client pack to join - the same pack, installed in their launcher.')
    return
  }

  // --paper <version>, --purpur <version>, --spigot <version> and the rest make "spin up a fresh
  // environment on version X" one command instead of three. Every jar-shaped source goes through
  // the same fetch: resolve the version, put the jar in the store, place it. Downloading first
  // means a failed fetch leaves no half-made instance behind.
  let jar = flags.jar ?? null
  let loader = 'paper'
  let mcVersion = null
  let chosenJava = flags.java ?? null
  const chosen = software.JAR_IDS.filter((id) => flags[id])
  if (chosen.length > 1 || (chosen.length && flags.neoforge)) {
    fail(`pick one of ${[...chosen, ...(flags.neoforge ? ['neoforge'] : [])].map((id) => `--${id}`).join(', ')}`)
  }
  if (chosen.length) {
    const id = chosen[0]
    const version = String(flags[id])
    const sw = software.softwareOf(id)
    if (sw.slow) out(`${sw.label} is compiled here by BuildTools - this takes several minutes the first time.`)
    let lastLine = ''
    // Which Java, before the download: --java as given, else the newest installed that this
    // version can run on. Refused when nothing here is new enough, unless --force.
    chosenJava = await java.pickJava({
      explicit: flags.java ?? null,
      needs: java.requiredMajor(version),
      force: Boolean(flags.force),
      what: `Minecraft ${version}`,
    })
    const res = await sources.fetchJar(id, version, {
      build: flags.build ?? null,
      java: chosenJava,
      onProgress: (p) => {
        if (p.message && p.message !== lastLine) {
          lastLine = p.message
          out(`  ${p.message}`)
        }
      },
    })
    out(res.cached
      ? `Using stored ${res.name}.`
      : `Downloaded ${res.name}${res.build ? ` (build ${res.build})` : ''}${res.sizeHuman ? `, ${res.sizeHuman}` : ''}.`)
    jar = res.name
    loader = id
    mcVersion = version
  }
  // --neoforge <version>: its installer lays the server down and the starter jar makes it
  // launch like every other, so this is its own branch rather than a jar to pass along.
  if (flags.neoforge) {
    const res = await neoforge.createServer(name, String(flags.neoforge), {
      java: await java.pickJava({
        explicit: flags.java ?? null,
        needs: java.requiredMajor(String(flags.neoforge)),
        force: Boolean(flags.force),
        what: `Minecraft ${flags.neoforge}`,
      }),
      memory: flags.memory ?? '4G',
      port: flags.port ? Number(flags.port) : null,
      onlineMode: !flags.offline,
      onProgress: ({ message }) => out(`  ${message}`),
    })
    out(`Created instance "${res.name}" — NeoForge ${res.neoVersion} (minecraft ${res.mc}), port ${res.port}`)
    out(`Start it with: mcctl start ${name}`)
    return
  }

  const inst = await create.newInstance(name, {
    loader,
    mcVersion,
    template: flags.template ?? null,
    from: flags.from ?? null,
    withWorlds: Boolean(flags.withWorlds),
    jar,
    memory: flags.memory ?? '4G',
    port: flags.port ? Number(flags.port) : null,
    rconPort: flags.rconPort ? Number(flags.rconPort) : null,
    acceptEula: Boolean(flags.acceptEula),
    // --offline for joining as any name without an account, which is what multi-account testing
    // needs. It also puts an OFFLINE/INSECURE banner in every log the server writes, so it is a
    // choice rather than the default.
    onlineMode: !flags.offline,
    motd: flags.motd ?? null,
    java: chosenJava,
  })
  out(`Created instance "${inst.name}"`)
  out(table([
    ['directory:', inst.dir],
    ['jar:', inst.jar],
    ['memory:', inst.memory],
    ['port:', String(inst.port)],
    ['rcon port:', String(inst.rcon.port)],
  ]))
  if (!inst.eulaAccepted) {
    out('')
    out('EULA is NOT accepted. The server will refuse to start until you either')
    out(`  set eula=true in ${path.join(inst.dir, 'eula.txt')}`)
    out('  (see https://aka.ms/MinecraftEULA)')
  } else {
    out('')
    out(`Start it with: mcctl start ${inst.name}`)
  }
}

async function cmdClone(positional, flags) {
  const src = positional[0]
  const dst = positional[1]
  if (!src || !dst) fail('clone requires a source and a destination: mcctl clone <src> <new-name>')
  const inst = await create.newInstance(dst, {
    from: src,
    withWorlds: Boolean(flags.withWorlds),
    memory: flags.memory ?? getInstance(src).memory,
    port: flags.port ? Number(flags.port) : null,
    acceptEula: flags.acceptEula !== false, // the source already accepted it
    motd: flags.motd ?? `${dst} (clone of ${src})`,
  })
  out(`Cloned "${src}" -> "${dst}"${flags.withWorlds ? ' (with worlds)' : ' (fresh worlds)'}`)
  out(table([
    ['directory:', inst.dir],
    ['port:', String(inst.port)],
    ['rcon port:', String(inst.rcon.port)],
  ]))
  out('')
  out(`Start it with: mcctl start ${dst}`)
}

async function cmdAdopt(positional, flags) {
  const name = positional[0]
  const dir = positional[1]
  if (!name || !dir) fail('adopt requires a name and a directory: mcctl adopt <name> <server-dir>')
  const inst = await create.adoptInstance(name, dir, {
    jar: flags.jar ?? null,
    memory: flags.memory ?? '4G',
    java: flags.java ?? null,
  })
  out(`Adopted "${inst.name}"`)
  out(table([
    ['directory:', inst.dir],
    ['jar:', inst.jar],
    ['memory:', inst.memory],
    ['port:', String(inst.port)],
    ['rcon port:', String(inst.rcon.port)],
  ]))
}

function cmdRemove(positional, flags) {
  const name = requireName(positional, 'rm')
  const inst = getInstance(name)
  if (sup.isRunning(name)) fail(`instance "${name}" is running - stop it first`)
  if (flags.purge && !flags.yes) {
    fail(`--purge deletes ${inst.dir} permanently. Re-run with --yes to confirm.`)
  }
  removeInstance(name)
  // The panel's delete does this through manage.destroy; this command has its own older path and
  // was missing it. A trigger that outlives its server fires forever, fails every time, and turns
  // up months later in Task Scheduler with nothing to say what put it there.
  let dropped = 0
  try {
    dropped = schedule.removeForInstance(name).removed
  } catch {
    /* the instance is gone either way; a stuck task is not a reason to refuse that */
  }
  if (flags.purge) {
    fs.rmSync(inst.dir, { recursive: true, force: true })
    out(`Removed "${name}" and deleted ${inst.dir}`)
  } else {
    out(`Unregistered "${name}". Files kept at ${inst.dir}`)
  }
  if (dropped) out(`Also removed ${dropped} scheduled task(s) that pointed at it.`)
  fs.rmSync(runDir(name), { recursive: true, force: true })
}

function cmdSet(positional) {
  const name = requireName(positional, 'set')
  const assignments = positional.slice(1)
  if (!assignments.length) fail('set requires key=value pairs, e.g. mcctl set survival memory=8G')
  const patch = {}
  const inst = getInstance(name)
  for (const pair of assignments) {
    const [key, ...rest] = pair.split('=')
    const value = rest.join('=')
    if (!value) fail(`malformed assignment "${pair}" - expected key=value`)
    switch (key) {
      case 'memory':
        patch.memory = value
        break
      // What the panel calls it. Anything goes here; the name stays the folder and the argument.
      case 'label':
        patch.label = value.toLowerCase() === 'off' ? null : cleanLabel(value)
        break
      case 'java':
        patch.java = value
        break
      case 'jar':
        patch.jar = value
        break
      case 'port':
        patch.port = assertPortUsable(name, Number(value))
        break
      case 'rcon.port':
        patch.rcon = { ...(patch.rcon ?? inst.rcon), port: assertPortUsable(name, Number(value), 'RCON port') }
        break
      case 'rcon.password':
        patch.rcon = { ...(patch.rcon ?? inst.rcon), password: value }
        break
      // The daemon re-reads the registry at every java exit, so both of these apply to a RUNNING
      // server from its next exit - no restart needed to arm them.
      case 'auto-restart':
        if (!['on', 'off', 'true', 'false'].includes(value.toLowerCase())) {
          fail('auto-restart takes on or off')
        }
        patch.autoRestart = ['on', 'true'].includes(value.toLowerCase())
        break
      case 'webhook':
        if (value.toLowerCase() === 'off') {
          patch.webhook = null
        } else {
          if (!acceptableWebhook(value)) fail(`"${value}" is not an http(s) URL - paste the one Discord gives you`)
          patch.webhook = value
        }
        break
      default:
        fail(`unknown setting "${key}" - one of: label, memory, java, jar, port, rcon.port, rcon.password, auto-restart, webhook`)
    }
  }
  // Before the registry, not after. An instance runs the jar in its own directory, and recording a
  // filename that is not there yet leaves a server that cannot start - which is what used to
  // happen, discovered at the next start rather than here.
  if (patch.jar) create.placeJar(inst.dir, patch.jar)

  updateInstance(name, patch)
  out(`Updated "${name}":`)
  for (const [k, v] of Object.entries(patch)) out(`  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)

  if (patch.jar) {
    // Reported, never deleted. The jar it was running is the way back if the new version turns out
    // to be wrong, and fifty megabytes is not a good enough reason to take that away from someone.
    const stray = create.strayJars(inst.dir, patch.jar)
    if (stray.length) {
      out('')
      out(`${stray.length} older jar(s) left in ${inst.dir}:`)
      for (const j of stray) out(`  ${j.name}  ${humanBytes(j.size)}`)
      out('Kept on purpose - they are how you go back. Delete them when you are sure.')
    }
  }
  if (sup.isRunning(name)) out('Restart the instance for changes to take effect.')
}

function cmdProps(positional) {
  const name = requireName(positional, 'props')
  const inst = getInstance(name)
  const file = path.join(inst.dir, 'server.properties')
  const assignments = positional.slice(1)

  if (!assignments.length) {
    const props = readProps(file)
    out(table([...props.entries()].sort().map(([k, v]) => [`${k}:`, v])))
    return
  }
  const updates = {}
  for (const pair of assignments) {
    const [key, ...rest] = pair.split('=')
    if (!rest.length) fail(`malformed assignment "${pair}" - expected key=value`)
    updates[key] = rest.join('=')
  }
  writeProps(file, updates)
  out(`Updated ${file}:`)
  for (const [k, v] of Object.entries(updates)) out(`  ${k}=${v}`)
  if (sup.isRunning(name)) out('Restart the instance for changes to take effect.')
}

// ------------------------------------------------------------------- backups

async function cmdBackup(positional, flags) {
  const name = requireName(positional, 'backup')
  const inst = getInstance(name)
  const scope = flags.scope ?? 'standard'
  const running = sup.isRunning(name)
  const flush = flags.flush !== false

  // The flush itself lives in createSnapshot, so every caller gets it; this only narrates it.
  if (running && flush) out('Flushing world to disk (save-all), then snapshotting...')
  else out(`Snapshotting "${name}" (scope: ${scope})...`)
  const res = await backup.createSnapshot(inst, { scope, label: flags.label ?? null, running, flush })
  out(`Wrote ${res.file} (${humanBytes(res.size)})`)
  out(`  included: ${res.members.join(', ')}`)
  for (const d of res.databases ?? []) out(`  database: ${d.database} on ${d.service} (${humanBytes(d.bytes)})`)
  for (const d of res.databasesSkipped ?? []) out(`  WARNING: database ${d.database} on ${d.service} not included: ${d.reason}`)
  if (res.flushWarning) out(`  WARNING: ${res.flushWarning}`)
  if (res.mirrored) out(`  mirrored: ${res.mirrored}`)
  if (res.mirrorError) out(`  WARNING: ${res.mirrorError}`)
  const tarWarnings = res.manifest.warnings.filter((w) => w !== res.flushWarning)
  if (tarWarnings.length) {
    out('  tar warnings (normal for a live server):')
    for (const w of tarWarnings) out(`    ${w}`)
  }
  if (flags.keep) {
    const removed = backup.pruneSnapshots(name, Number(flags.keep))
    if (removed.length) out(`Pruned ${removed.length} old snapshot(s), keeping ${flags.keep}.`)
  }
}

function cmdSnapshots(positional) {
  const name = requireName(positional, 'snapshots')
  getInstance(name)
  const snaps = backup.listSnapshots(name)
  if (!snaps.length) {
    out(`No snapshots for "${name}". Create one with: mcctl backup ${name}`)
    return
  }
  const rows = [['NAME', 'SCOPE', 'SIZE', 'CREATED']]
  for (const s of snaps) rows.push([s.name, s.scope, s.sizeHuman, s.mtime.toISOString().replace('T', ' ').slice(0, 19)])
  out(table(rows))
}

async function cmdRestore(positional, flags) {
  const name = requireName(positional, 'restore')
  const inst = getInstance(name)
  if (sup.isRunning(name)) fail(`instance "${name}" is running - stop it before restoring`)
  const snap = backup.resolveSnapshot(name, positional[1] ?? 'latest')

  if (!flags.yes) {
    out(`About to restore into ${inst.dir}:`)
    out(`  snapshot: ${snap.name} (${snap.sizeHuman}, scope ${snap.scope})`)
    out(`  overwrites: ${snap.members.join(', ') || '(see manifest)'}`)
    for (const d of snap.databases ?? []) out(`  imports:    database ${d.database} on ${d.service} (needs "${d.service}" running)`)
    out('')
    out('This overwrites existing files in place. Re-run with --yes to proceed.')
    process.exitCode = 1
    return
  }
  const res = await backup.restoreSnapshot(inst, snap)
  out(`Restored ${res.restored} into ${res.into}`)
  for (const d of res.databases?.imported ?? []) out(`  imported database ${d.database} into ${d.service}`)
  for (const d of res.databases?.skipped ?? []) out(`  WARNING: database ${d.database} not imported: ${d.reason}`)
  if (res.databases?.skipped?.length) process.exitCode = 1
}

function cmdPrune(positional, flags) {
  const name = requireName(positional, 'prune')
  getInstance(name)
  const keep = Number(flags.keep ?? 10)
  const removed = backup.pruneSnapshots(name, keep)
  out(removed.length ? `Removed ${removed.length} snapshot(s), keeping the newest ${keep}.` : 'Nothing to prune.')
}

/**
 * Prove the snapshots restore, before the day that gets found out the hard way.
 *
 * <p>Exits non-zero when anything fails, so a scheduled `mcctl verify <name> --all` can be
 * noticed by whatever runs it rather than scrolling past as text.
 */
async function cmdVerify(positional, flags) {
  const name = requireName(positional, 'verify')
  getInstance(name)
  const targets = flags.all
    ? backup.listSnapshots(name)
    : [backup.resolveSnapshot(name, positional[1] ?? 'latest')]
  if (!targets.length) fail(`no snapshots exist for "${name}". Create one with: mcctl backup ${name}`)

  let failed = 0
  for (const target of targets) {
    const res = await backup.verifySnapshot(name, target.name)
    if (res.ok) {
      out(`ok    ${target.name}  (${res.entries} entries, ${humanBytes(res.size)})`)
      if (!res.hasManifest) {
        out('      no manifest beside it, so only the archive itself was checked, not its coverage')
      }
    } else {
      failed++
      out(`FAIL  ${target.name}`)
      for (const problem of res.problems) out(`      ${problem}`)
    }
  }
  if (targets.length > 1) {
    out('')
    out(failed
      ? `${failed} of ${targets.length} snapshots FAILED verification.`
      : `All ${targets.length} snapshots read back whole.`)
  }
  if (failed) process.exitCode = 1
}

// ------------------------------------------------------- templates and jars

function cmdTemplates(positional, flags) {
  const sub = positional[0]
  if (sub === 'save') {
    const instName = positional[1]
    const tplName = positional[2]
    if (!instName || !tplName) fail('usage: mcctl templates save <instance> <template-name>')
    const res = create.saveTemplate(getInstance(instName), tplName, { includeWorlds: Boolean(flags.withWorlds) })
    out(`Saved template "${res.name}" -> ${res.dir}`)
    return
  }
  const tpls = create.listTemplates()
  if (!tpls.length) {
    out('No templates. Create one from an existing instance:')
    out('  mcctl templates save <instance> <template-name>')
    return
  }
  const rows = [['NAME', 'JAR', 'WORLDS', 'FROM']]
  for (const t of tpls) rows.push([t.name, t.jar ?? '-', t.includesWorlds ? 'yes' : 'no', t.sourceInstance ?? '-'])
  out(table(rows))
}

function cmdConfig(positional, flags) {
  const sub = positional[0]

  if (!sub || sub === 'show') {
    const l = paths.LAYOUT
    out(table([
      ['settings file:', l.settingsFile],
      ['data root:', l.dataRoot],
      ['instances:', l.instancesDir + (l.separateInstances ? '   (separate location)' : '')],
      ['jars:', l.jarsDir],
      ['backups:', l.backupsDir],
      ['backup mirror:', backup.mirrorRoot() ?? '(none - one disk failure takes servers and snapshots together)'],
      ['templates:', l.templatesDir],
      ['run state:', l.runDir],
    ]))
    if (l.usingLegacyLayout) {
      out('')
      out('Using the folder SpawnLoft lives in, because it already holds instances.json.')
      out('Move it with: mcctl config set-root <path>')
    }
    return
  }

  if (sub === 'set-root' || sub === 'set-instances') {
    const dir = positional[1]
    if (!dir) fail(`usage: mcctl config ${sub} <path>`)
    const abs = path.resolve(dir)
    const check = settings.checkWritable(abs)
    // Written to, not merely inspected: permission bits and free-space numbers both lie about a
    // network share, a read-only mount, or a drive that has been unplugged.
    if (!check.ok) fail(`cannot write to ${abs}
  ${check.error}`)

    settings.save(sub === 'set-root'
      ? { dataRoot: abs }
      : { instancesDir: abs, separateInstances: true })
    out(`Saved. ${sub === 'set-root' ? 'Data root' : 'Instances directory'}: ${abs}`)
    out('')
    out('Takes effect on the next command. Existing servers do NOT move — the registry stores')
    out('their absolute paths, so they keep running where they are; only new ones land here.')
    return
  }

  if (sub === 'set-backup-mirror') {
    const arg = positional[1]
    if (!arg) fail('usage: mcctl config set-backup-mirror <path>|off')
    if (arg.toLowerCase() === 'off') {
      settings.save({ backupsMirrorDir: null })
      out('Mirroring turned off. Copies already made stay where they are.')
      return
    }
    const abs = path.resolve(arg)
    const check = settings.checkWritable(abs)
    if (!check.ok) fail(`cannot write to ${abs}
  ${check.error}`)
    settings.save({ backupsMirrorDir: abs })
    out(`Every new snapshot, for every server, now also copies to ${abs}.`)
    out('Ideally that is another drive - the point is that one disk failure cannot take')
    out('the servers and their backups together. Retention deletions follow the mirror.')
    return
  }

  if (sub === 'same-drive') {
    settings.save({ separateInstances: false })
    out('Servers will be created under the data root again.')
    return
  }

  fail('usage: mcctl config [show|set-root <path>|set-instances <path>|same-drive]')
}

function cmdRename(positional) {
  const from = positional[0]
  const to = positional[1]
  if (!from || !to) fail('usage: mcctl rename <old-name> <new-name>')
  const res = manage.rename(from, to)
  out(`Renamed "${from}" -> "${to}"`)
  if (res.movedDir) out(`  directory moved to ${res.dir}`)
}

async function cmdRebuild(positional, flags) {
  const name = requireName(positional, 'rebuild')
  if (!flags.yes) {
    fail(`rebuild deletes the worlds in "${name}". Re-run with --yes to confirm.
` +
      `  Add --wipe-plugins to reset plugins too. A snapshot is taken first unless --no-snapshot.`)
  }
  const res = await manage.rebuild(name, {
    keepPlugins: !flags.wipePlugins,
    // The parser turns --no-snapshot into { snapshot: false }, the same as --no-wait and
    // --no-sync in cmdStart. Reading flags.noSnapshot here read a key it never writes, so the
    // documented flag was silently ignored and a snapshot taken anyway.
    snapshot: flags.snapshot !== false,
  })
  if (res.snapshot) out(`Snapshot: ${res.snapshot}`)
  out(`Rebuilt "${name}" — removed: ${res.removed.join(', ') || '(nothing to remove)'}`)
  out(res.keptPlugins ? 'Plugins kept.' : 'Plugins wiped.')
}

function cmdReveal(positional) {
  const name = requireName(positional, 'reveal')
  out(`Opening ${manage.reveal(name)}`)
}

/**
 * Move a server to a newer Paper build, or - deliberately harder - a newer Minecraft version.
 *
 * <p>A build update is routine and just happens; the old jar stays in the instance folder as
 * the way back. Crossing Minecraft versions migrates the worlds one-way on the next start, so
 * it takes --yes, and a standard snapshot is taken before anything is swapped.
 */
async function cmdUpgrade(positional, flags) {
  const name = requireName(positional, 'upgrade')
  const inst = getInstance(name)
  const running = sup.isRunning(name)

  if (flags.check) {
    const info = await upgrade.checkUpgrade(inst)
    if (!info.current) {
      out(`${inst.jar} is not a Paper jar SpawnLoft recognises. Newest Paper is for ${info.latestVersion}.`)
      return
    }
    out(`${name} runs Paper ${info.current.version} build ${info.current.build}.`)
    out(info.buildUpdate
      ? `Build ${info.latestBuild.build} is available (${info.latestBuild.channel.toLowerCase()}). Apply with: mcctl upgrade ${name}`
      : `That is the newest ${info.latestBuild.channel === 'STABLE' ? 'stable ' : ''}build for ${info.current.version}.`)
    if (info.newerVersions.length) {
      out(`Minecraft ${info.newerVersions[0]} is out. Cross with: mcctl upgrade ${name} --version ${info.newerVersions[0]} --yes`)
    }
    return
  }

  const version = flags.version ? String(flags.version) : null
  const current = upgrade.parsePaperJar(inst.jar)
  if (version && current && version !== current.version && !flags.yes) {
    fail(`upgrading "${name}" from ${current.version} to ${version} migrates its worlds, and worlds do not migrate back.
  A snapshot is taken first, but read your plugins' release notes too. Re-run with --yes.`)
  }

  const res = await upgrade.applyUpgrade(name, { version, build: flags.build ?? null, running })
  if (res.alreadyCurrent) {
    out(`${name} already runs ${res.jar} - nothing to do.`)
    return
  }
  if (res.snapshot) out(`Snapshot: ${res.snapshot}`)
  out(`${name}: ${res.from} -> ${res.to}${res.channel !== 'STABLE' ? ` (${res.channel})` : ''}`)
  if (res.oldJars.length) out(`  Old jar kept in the instance folder - the way back if this build misbehaves.`)
  out(running
    ? '  The server is running; the new jar loads at its next restart.'
    : '  Takes effect at the next start.')
}

/**
 * A modpack server's pack: what it runs, whether a newer release exists, and moving to it.
 * The update takes a standard snapshot first and only ever deletes files the old pack owned
 * that the new one dropped - the worlds and anything hand-added are not the pack's to touch.
 */
async function cmdPack(positional, flags) {
  const name = requireName(positional, 'pack')
  const inst = getInstance(name)
  const sub = positional[1] ?? 'status'

  if (sub === 'status' || sub === 'check') {
    const pack = mrpack.packOf(inst)
    if (!pack) fail(`"${name}" was not built from a modpack`)
    const packLoader = pack.loader ?? { kind: 'fabric', version: pack.fabricLoader }
    out(`${name} runs ${pack.name} ${pack.versionNumber} (minecraft ${pack.mc}, ${packLoader.kind} ${packLoader.version})`)
    const info = await mrpack.checkPackUpdate(inst)
    out(info.updateAvailable
      ? `Release ${info.latest.version} is out. Apply with: mcctl pack ${name} update --yes`
      : 'That is the newest release.')
    return
  }

  if (sub === 'update') {
    if (!flags.yes) {
      fail(`updating replaces the pack's own files. A standard snapshot is taken first, the worlds
  and anything you added by hand are never touched, and players will need the matching new
  client pack. The server must be stopped. Re-run with --yes.`)
    }
    const res = await mrpack.updatePack(name, { onProgress: ({ message }) => out(`  ${message}`) })
    if (res.alreadyLatest) {
      out(`Already on the newest release (${res.version}).`)
      return
    }
    out('')
    out(`Updated to ${res.to} (from ${res.from}).`)
    out(`  Snapshot: ${res.snapshot}`)
    out(`  ${res.files} pack files laid in, ${res.removed} old pack file(s) retired.`)
    if (res.mcChanged) out(`  Minecraft moved to ${res.mc} - the worlds migrate on the next start.`)
    out('Players need the matching new client pack to join.')
    return
  }

  fail('usage: mcctl pack <name> [update --yes]')
}

/** Worlds: list, switch, import, export, delete. The panel's Worlds tab, for a terminal. */
async function cmdWorlds(positional, flags) {
  const name = requireName(positional, 'worlds')
  const inst = getInstance(name)
  const sub = positional[1] ?? 'list'

  if (sub === 'list') {
    const data = await worlds.listWorlds(inst)
    if (!data.worlds.length) {
      out(`No worlds in ${inst.dir}. The server generates one on first start, or: mcctl worlds ${name} import <zip-or-folder> --as <name>`)
      return
    }
    const t = [['WORLD', 'ACTIVE', 'DIMENSIONS', 'SIZE']]
    for (const w of data.worlds) {
      t.push([w.name, w.active ? 'yes' : '', w.dimensions.join(', ') || '-', w.sizeHuman])
    }
    out(table(t))
    return
  }

  if (sub === 'use') {
    const target = positional[2]
    if (!target) fail(`usage: mcctl worlds ${name} use <world>`)
    worlds.activateWorld(inst, target)
    out(`${target} is now the active world. Takes effect on the next start.`)
    return
  }

  if (sub === 'import') {
    const source = positional[2]
    if (!source) fail(`usage: mcctl worlds ${name} import <zip-or-folder> --as <name>`)
    const asName = flags.as
      ?? path.basename(String(source)).replace(/\.(zip|tar\.gz|tgz)$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
    const res = await worlds.importWorld(inst, source, { name: asName })
    out(`Imported "${res.name}" (${res.sizeHuman}${res.dimensions.length ? `, with ${res.dimensions.join(' and ')}` : ''}).`)
    out(`Make it the active world with: mcctl worlds ${name} use ${res.name}`)
    return
  }

  if (sub === 'export') {
    const target = positional[2] ?? worlds.activeWorld(inst)
    const res = await worlds.exportWorld(inst, target)
    out(`Exported ${res.members.join(', ')} to:`)
    out(`  ${res.file}  (${res.sizeHuman})`)
    return
  }

  if (sub === 'delete') {
    const target = positional[2]
    if (!target) fail(`usage: mcctl worlds ${name} delete <world> --yes`)
    if (!flags.yes) {
      fail(`deleting "${target}" is permanent: only the ACTIVE world is ever in snapshots, so an
  inactive world has no way back unless it was exported. Re-run with --yes.`)
    }
    const res = worlds.deleteWorld(inst, target)
    out(`Deleted ${res.removed.join(', ')}.`)
    return
  }

  fail('usage: mcctl worlds <name> [use <world> | import <src> --as <name> | export [world] | delete <world> --yes]')
}

/** List a server's plugins, or flip one on or off. The panel's Plugins tab, for a terminal. */
function cmdPlugins(positional) {
  const name = requireName(positional, 'plugins')
  const inst = getInstance(name)
  const sub = positional[1]

  if (sub === 'enable' || sub === 'disable') {
    const ref = positional[2]
    if (!ref) fail(`usage: mcctl plugins <name> ${sub} <plugin>`)
    const rows = plugins.listPlugins(inst)
    const hit = rows.find((p) => p.file === ref || p.name.toLowerCase() === String(ref).toLowerCase())
    if (!hit) fail(`no plugin "${ref}" on "${name}". See: mcctl plugins ${name}`)
    const res = plugins.setPluginEnabled(inst, hit.file, sub === 'enable')
    out(`${hit.name} is now ${res.enabled ? 'enabled' : 'disabled'}. Takes effect on the next start.`)
    return
  }
  if (sub) fail('usage: mcctl plugins <name> [enable|disable <plugin>]')

  const rows = plugins.listPlugins(inst)
  if (!rows.length) {
    out(`No plugins in ${path.join(inst.dir, 'plugins')}. The panel's Plugins tab installs from Modrinth.`)
    return
  }
  // The CLI is an inventory, so it lists everything - but SOURCE says which jars are mcctl's
  // to update ("modrinth") and which are the person's own ("manual"). The panel lists only
  // the former.
  const t = [['NAME', 'VERSION', 'STATE', 'SOURCE', 'FILE', 'SIZE']]
  for (const p of rows) {
    t.push([p.name, p.version ?? '-', p.enabled ? 'on' : 'off',
      p.managed ? (p.source ?? 'mcctl') : 'manual', p.file, humanBytes(p.size)])
  }
  out(table(t))
}


function cmdLaunchers(positional) {
  // Backfills instances made before launchers existed, and repairs them if mcctl moves on disk -
  // the .bat files hold an absolute path to the CLI.
  const targets = positional.length ? positional.map(getInstance) : listInstances()
  for (const inst of targets) {
    const files = create.writeLaunchers(inst)
    out(`${inst.name}: ${files.join(', ')}`)
  }
  out('')
  out('Double-click start.bat in an instance folder to run it with a console attached.')
}

async function cmdUi(positional, flags) {
  const { url } = await ui.serve({
    port: Number(flags.port ?? 8770),
    // --no-open arrives as { open: false }; flags.noOpen was a key the parser never writes,
    // so the flag was silently ignored and the browser opened anyway.
    open: flags.open !== false,
  })
  out(`SpawnLoft panel: ${url}`)
  out('Bound to 127.0.0.1 only — it can start servers and type console commands, so it is')
  out('for this machine, not the network. Ctrl+C to stop the panel (servers keep running).')
}

async function cmdPaper(positional, flags) {
  const sub = positional[0] ?? 'versions'

  if (sub === 'versions') {
    const all = await paper.versions({ includeUnstable: Boolean(flags.unstable) })
    const limit = Number(flags.limit ?? 25)
    out(`Paper versions (newest first)${flags.unstable ? ', including pre-releases' : ''}:`)
    out('  ' + all.slice(0, limit).join('  '))
    if (all.length > limit) out(`  ... ${all.length - limit} older (use --limit ${all.length})`)
    return
  }

  if (sub === 'builds') {
    const version = positional[1]
    if (!version) fail('usage: mcctl paper builds <version>')
    const all = await paper.builds(version)
    const rows = [['BUILD', 'CHANNEL', 'DATE', 'FILE']]
    for (const b of all.slice(0, Number(flags.limit ?? 15))) {
      rows.push([String(b.build), b.channel, b.time.slice(0, 10), b.name ?? '-'])
    }
    out(table(rows))
    return
  }

  if (sub === 'fetch') {
    const version = positional[1]
    if (!version) fail('usage: mcctl paper fetch <version> [build] [--force]')
    const res = await paper.fetchBuild(version, positional[2] ?? null, { force: Boolean(flags.force) })
    if (res.cached) {
      out(`Already stored: ${res.name} (build ${res.build}, ${res.channel}). Re-download with --force.`)
    } else {
      out(`Downloaded ${res.name} — build ${res.build}, ${res.channel}, ${res.sizeHuman}, checksum verified.`)
    }
    out(`Use it with: mcctl new <name> --jar ${res.name}`)
    return
  }

  fail('usage: mcctl paper [versions|builds <version>|fetch <version> [build]]')
}

function cmdJars(positional, flags) {
  const sub = positional[0]
  if (sub === 'import') {
    const src = positional[1]
    if (!src) fail('usage: mcctl jars import <path-to-jar> [--as <name>]')
    const dest = create.importJar(src, { as: flags.as ?? null })
    out(`Imported ${dest}`)
    return
  }
  const jars = create.listJars()
  if (!jars.length) {
    out('No jars stored. Import one with: mcctl jars import <path-to-jar>')
    return
  }
  const rows = [['NAME', 'SIZE', 'ADDED']]
  for (const j of jars) rows.push([j.name, j.sizeHuman, j.mtime.toISOString().slice(0, 10)])
  out(table(rows))
}

// -------------------------------------------------------------------- doctor

/**
 * Scheduled tasks.
 *
 * <p>`task run` is what Windows Task Scheduler actually invokes, through a small batch file, and it
 * is the only thing a trigger is able to call. What a task DOES comes from its stored definition
 * rather than from the command line, so a scheduled task can only ever be one of the handful of
 * things mcctl allows a task to be - not a way to run whatever was written into a trigger.
 */
async function cmdTask(positional, flags) {
  const sub = positional[0] ?? 'list'

  if (sub === 'list') {
    const tasks = await schedule.list()
    if (!tasks.length) {
      out('No scheduled tasks.')
      out('')
      out('  Add one with: mcctl task add <instance> --do backup --daily 03:00')
      return
    }
    const rows = [['ID', 'INSTANCE', 'DOES', 'WHEN', 'STATE', 'LAST', 'NEXT']]
    for (const t of tasks) {
      const w = t.windows
      rows.push([
        t.id,
        t.instance,
        t.action.type,
        describeSchedule(t.schedule),
        t.enabled ? (w ? w.state : 'NOT IN SCHEDULER') : 'disabled',
        w ? schedule.describeResult(w.lastResult) : '-',
        w?.nextRun ? String(w.nextRun).replace('T', ' ').slice(0, 16) : '-',
      ])
    }
    out(table(rows))
    out('')
    out('Tasks run while you are logged in, including with the screen locked - not after signing out.')
    return
  }

  if (sub === 'run') {
    const id = positional[1]
    if (!id) fail('usage: mcctl task run <id>')
    return runTask(id)
  }

  if (sub === 'add') {
    const instance = positional[1]
    if (!instance) fail('usage: mcctl task add <instance> --do <backup|command|restart|stop|start> [when]')
    getInstance(instance)
    const type = String(flags.do ?? 'backup')
    const action = { type }
    if (type === 'command') {
      if (!flags.line) fail('--do command needs --line "<what to send>"')
      action.line = String(flags.line)
    }
    const sched = flags.hourly ? { kind: 'hourly', every: Number(flags.hourly) || 1 }
      : flags.minutes ? { kind: 'minutes', every: Number(flags.minutes) || 30 }
      : flags.weekly ? { kind: 'weekly', day: String(flags.weekly), at: String(flags.at ?? '03:00') }
      : flags.onLogon ? { kind: 'onlogon' }
      : { kind: 'daily', at: String(flags.daily === true ? '03:00' : flags.daily ?? flags.at ?? '03:00') }
    const made = schedule.create({ instance, name: flags.name ?? null, action, schedule: sched })
    out(`Created "${made.id}" - ${made.name}, ${describeSchedule(made.schedule)}.`)
    return
  }

  if (sub === 'rm') {
    const id = positional[1]
    if (!id) fail('usage: mcctl task rm <id>')
    schedule.remove(id)
    out(`Removed "${id}".`)
    return
  }

  if (sub === 'enable' || sub === 'disable') {
    const id = positional[1]
    if (!id) fail(`usage: mcctl task ${sub} <id>`)
    schedule.setEnabled(id, sub === 'enable')
    out(`${sub === 'enable' ? 'Enabled' : 'Disabled'} "${id}".`)
    return
  }

  fail('usage: mcctl task [list|add|run|rm|enable|disable]')
}

function describeSchedule(s) {
  switch (s.kind) {
    case 'hourly': return s.every > 1 ? `every ${s.every}h` : 'hourly'
    case 'minutes': return `every ${s.every}m`
    case 'weekly': return `${s.day} ${s.at}`
    case 'onlogon': return 'at logon'
    default: return `daily ${s.at}`
  }
}

/**
 * Perform one scheduled task.
 *
 * <p>Runs unattended, so everything it does is written down: Task Scheduler records the exit code,
 * and stdout goes to the instance's own run directory where the panel can show it next to the task
 * that produced it. A failure at 3am that leaves no trace is the reason to bother.
 */
// How long an unattended start waits for the server to report ready before calling it a failure.
// Passed explicitly rather than left to the default so the number in the log line cannot drift
// away from the number actually waited.
const TASK_START_TIMEOUT = 180000

async function runTask(id) {
  const all = schedule.load().tasks
  if (!Object.hasOwn(all, id)) fail(`no scheduled task "${id}"`)
  const task = all[id]
  const { instance, action } = task
  const started = Date.now()

  /**
   * One line per run, and the exit code Windows will see.
   *
   * <p>Three outcomes, not two. A command task whose server happens to be down did not fail - there
   * was simply nothing to send - and calling that a failure every hour teaches you to ignore the
   * word. It is recorded as skipped and reported to Windows as success, so the two records agree;
   * they did not before, and a log saying FAILED beside a scheduler saying ok is worse than either.
   */
  const record = (status, detail) => {
    // The id is written down because one instance can have several tasks of the same type -
    // two backup schedules, say - and a line that only says "backup" cannot say which.
    // Tabs and newlines are stripped from the detail so one run stays one parseable line.
    const flat = String(detail).replace(/[\t\r\n]+/g, ' ')
    const line = `${new Date().toISOString()}\t${id}\t${status}\t${action.type}\t${flat}`
    try {
      const file = path.join(runDir(instance), 'tasks.log')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, line + '\n')
    } catch {
      /* the exit code still reaches Task Scheduler */
    }
    out(line)
  }

  // A failed task runs at 3am with nobody watching, which is exactly what the webhook is for.
  // Awaited so the process does not exit under the delivery; best-effort beyond that.
  const alert = async (detail) => {
    try {
      await notifyInstance(getInstance(instance), `scheduled task "${task.name}" FAILED: ${detail}`)
    } catch {
      /* the run log and the exit code already carry the failure */
    }
  }

  /**
   * Start the server, and wait to find out whether it survived.
   *
   * <p>This used to pass `wait: false` and record "restarted" the moment the process existed. A
   * server that died eight seconds later on a broken plugin therefore reported success to Task
   * Scheduler and wrote "ok" into the log - and the nightly restart that was quietly leaving the
   * server down looked healthy for as long as anyone cared to check. Nothing is waiting on this
   * task, so there is no reason to answer before the answer is known.
   */
  const startAndReport = async (verb) => {
    const res = await sup.start(instance, { timeout: TASK_START_TIMEOUT })
    if (res.failed) {
      process.exitCode = 1
      await alert(`${verb}, but it stopped again: ${res.reason}`)
      return record('FAILED', `${verb}, but it stopped again: ${res.reason}`)
    }
    if (res.timedOut) {
      process.exitCode = 1
      await alert(`${verb}, but it had not finished starting after ${TASK_START_TIMEOUT / 1000}s`)
      return record('FAILED', `${verb}, but it had not finished starting after ${TASK_START_TIMEOUT / 1000}s`)
    }
    return record('ok', verb)
  }

  try {
    const inst = getInstance(instance)
    const running = sup.isRunning(instance)

    if (action.type === 'backup') {
      const res = await backup.createSnapshot(inst, { scope: 'standard', label: 'scheduled', running, taskId: id })
      let pruned = ''
      // Pruned AFTER the new one exists, never before: trimming first would mean a failed backup
      // leaves you with fewer than you had, which is the opposite of what a retention limit is for.
      if (Number.isInteger(action.keep) && action.keep > 0) {
        // Scoped to this task's own snapshots. Scheduled ones taken before snapshots recorded
        // which task made them have no id and belong to nobody, so they are left where they are
        // rather than being counted against a limit that was never about them.
        const gone = backup.pruneSnapshots(instance, action.keep, { only: 'scheduled', taskId: id })
        if (gone.length) pruned = `, pruned ${gone.length} over the limit of ${action.keep}`
      }
      record('ok', `${res.file} (${humanBytes(res.size)})${pruned}`)
    } else if (action.type === 'verify') {
      const snaps = backup.listSnapshots(instance)
      if (!snaps.length) return record('skipped', 'no snapshots to verify yet')
      const failed = []
      for (const s of snaps) {
        const r = await backup.verifySnapshot(instance, s.name)
        if (!r.ok) failed.push(`${s.name}: ${r.problems[0]}`)
      }
      if (failed.length) {
        process.exitCode = 1
        const detail = `${failed.length} of ${snaps.length} snapshots failed: ${failed.join('; ')}`
        await alert(detail)
        return record('FAILED', detail)
      }
      record('ok', `all ${snaps.length} snapshots read back whole`)
    } else if (action.type === 'command') {
      if (!running) return record('skipped', 'the server was not running, so nothing was sent')
      await sup.sendConsole(instance, action.line)
      record('ok', action.line)
    } else if (action.type === 'restart') {
      if (running && action.warnMinutes > 0) {
        // Counted down over the console: the full figure up front, again at one minute, again at
        // ten seconds. Announcements are best-effort - a server that dies mid-countdown has made
        // the warning moot, and the stop below already copes with a stopped server.
        const say = (msg) => sup.sendConsole(instance, `say ${msg}`).catch(() => {})
        let remaining = action.warnMinutes * 60
        await say(`Server restarting in ${action.warnMinutes} minute${action.warnMinutes === 1 ? '' : 's'}`)
        if (remaining > 60) {
          await sleep((remaining - 60) * 1000)
          remaining = 60
          await say('Server restarting in 1 minute')
        }
        await sleep((remaining - 10) * 1000)
        await say('Server restarting in 10 seconds')
        await sleep(10000)
      }
      if (running) await sup.stop(instance)
      return await startAndReport(action.warnMinutes > 0 && running
        ? `restarted after a ${action.warnMinutes}-minute warning`
        : 'restarted')
    } else if (action.type === 'stop') {
      if (!running) return record('skipped', 'it was already stopped')
      await sup.stop(instance)
      record('ok', 'stopped')
    } else if (action.type === 'start') {
      if (running) return record('skipped', 'it was already running')
      return await startAndReport('started')
    } else {
      fail(`unknown action "${action.type}"`)
    }
  } catch (err) {
    record('FAILED', err?.message ?? String(err))
    process.exitCode = 1
    await alert(err?.message ?? String(err))
    return
  }
  out(`done in ${Math.round((Date.now() - started) / 1000)}s`)
}

// ------------------------------------------------------------------------ db

/**
 * Databases: MariaDB run under the same supervision as a server, attached to servers with
 * credentials of their own. start/stop/restart/logs/status take a database's name like a
 * server's; this group is what is specific to them.
 */
async function cmdDb(positional, flags) {
  const sub = positional[0] ?? 'list'

  if (sub === 'list') {
    const dbs = listServices()
    if (!dbs.length) {
      out('No databases.')
      out('')
      out('  Add one with: mcctl db add <name> --version <mariadb-version>')
      out('  See versions: mcctl db versions')
      return
    }
    out(table(databaseRows(dbs)))
    return
  }

  if (sub === 'versions') {
    const engine = String(flags.engine ?? 'mariadb')
    const list = await services.versionsFor(engine)
    if (!list.length) fail(`${engine} publishes no stable releases right now`)
    out(table([['VERSION', 'STATUS', 'SUPPORT', 'RELEASED'], ...list.slice(0, 20).map((v) => [v.version, v.status, v.support ?? '-', v.date ?? '-'])]))
    if (list.length > 20) out(`  ...and ${list.length - 20} older.`)
    return
  }

  if (sub === 'add') {
    const name = positional[1]
    if (!name) fail('usage: mcctl db add <name> --version <version> [--port <n>] [--label "..."]')
    const engine = String(flags.engine ?? 'mariadb')
    let version = flags.version ? String(flags.version) : null
    if (!version) {
      const newest = (await services.versionsFor(engine))[0]
      if (!newest) fail(`${engine} publishes no stable release to pick from - name one with --version`)
      version = newest.version
      out(`Using ${services.ENGINES[engine]?.label ?? engine} ${version}, the newest stable release.`)
    }
    let lastPercent = -1
    const db = await services.createDatabase(name, {
      engine,
      version,
      port: flags.port ? Number(flags.port) : null,
      label: flags.label ?? null,
      onProgress: (p) => {
        if (p.total && p.received != null) {
          const pct = Math.floor((p.received / p.total) * 10) * 10
          if (pct !== lastPercent) {
            lastPercent = pct
            out(`  ${p.message} ${pct}%`)
          }
        } else if (p.message) out(`  ${p.message}`)
      },
    })
    out('')
    out(`Created database "${db.name}" (${services.ENGINES[db.engine]?.label ?? db.engine} ${db.version}) on 127.0.0.1:${db.port}`)
    out(`Start it with: mcctl start ${db.name}`)
    out(`Then attach a server: mcctl db attach ${db.name} <server>`)
    return
  }

  if (sub === 'create') {
    const serverName = positional[1]
    if (!serverName) fail('usage: mcctl db create <server> [--version <version>] [--engine mariadb]')
    const engine = String(flags.engine ?? 'mariadb')
    let lastPercent = -1
    const { database: db, credentials } = await services.createForServer(serverName, {
      engine,
      version: flags.version ? String(flags.version) : null,
      onProgress: (p) => {
        if (p.total && p.received != null) {
          const pct = Math.floor((p.received / p.total) * 10) * 10
          if (pct !== lastPercent) {
            lastPercent = pct
            out(`  ${p.message} ${pct}%`)
          }
        } else if (p.message) out(`  ${p.message}`)
      },
    })
    out('')
    out(`Created database "${db.name}" (${services.ENGINES[db.engine]?.label ?? db.engine} ${db.version}) on 127.0.0.1:${db.port}, running, attached to "${serverName}".`)
    out('')
    printCredentials(credentials)
    return
  }

  if (sub === 'attach' || sub === 'detach') {
    const [, dbName, serverName] = positional
    if (!dbName || !serverName) fail(`usage: mcctl db ${sub} <database> <server>${sub === 'detach' ? ' [--drop]' : ''}`)
    if (sub === 'attach') {
      const creds = services.attach(dbName, serverName)
      out(`"${serverName}" is attached to "${dbName}".`)
      out('')
      printCredentials(creds)
      return
    }
    const res = services.detach(dbName, serverName, { drop: Boolean(flags.drop) })
    out(`"${serverName}" is detached from "${dbName}"${res.dropped ? `; database ${res.database} dropped` : `; database ${res.database} kept`}.`)
    return
  }

  if (sub === 'creds' || sub === 'credentials') {
    const [, dbName, serverName] = positional
    if (!dbName || !serverName) fail('usage: mcctl db creds <database> <server>')
    printCredentials(services.credentials(dbName, serverName))
    return
  }

  if (sub === 'plugins') {
    const serverName = positional[1]
    if (!serverName) fail('usage: mcctl db plugins <server>')
    const rows = [['PLUGIN', 'INSTALLED', 'CONFIG', 'FILE']]
    for (const h of services.helpersFor(serverName)) {
      rows.push([h.label, h.pluginPresent ? 'yes' : 'no', h.configPresent ? 'present' : 'not written yet', h.file])
    }
    out(table(rows))
    out('')
    out('Apply with: mcctl db apply <database> <server> <plugin>   (luckperms, coreprotect, plan, authme)')
    return
  }

  if (sub === 'apply') {
    const [, dbName, serverName, plugin] = positional
    if (!dbName || !serverName || !plugin) fail('usage: mcctl db apply <database> <server> <plugin>')
    const res = services.applyToPlugin(dbName, serverName, plugin.toLowerCase())
    out(`Wrote ${res.file}`)
    if (res.written.length) out(`  set:   ${res.written.join(', ')}`)
    if (res.inserted.length) out(`  added: ${res.inserted.join(', ')}`)
    out(`  ${res.note}`)
    out(`Restart "${serverName}" for ${res.label} to pick it up.`)
    return
  }

  if (sub === 'connect') {
    const name = positional[1]
    if (!name) fail('usage: mcctl db connect <name> --engine mariadb|garnet --host <host> --port <n> --user <u> --password <p> [--tools <folder>]')
    const engine = String(flags.engine ?? 'mariadb')
    const db = await services.registerExternal(name, {
      engine,
      host: flags.host ? String(flags.host) : '127.0.0.1',
      port: flags.port ? Number(flags.port) : null,
      user: flags.user ? String(flags.user) : 'root',
      password: flags.password != null ? String(flags.password) : '',
      tools: flags.tools ? String(flags.tools) : null,
      label: flags.label ?? null,
    })
    out(`Registered "${db.name}": ${services.ENGINES[engine].label} at ${db.host}:${db.port}, answering.`)
    out(`Attach a server: mcctl db attach ${db.name} <server>`)
    return
  }

  if (sub === 'root') {
    const dbName = positional[1]
    if (!dbName) fail('usage: mcctl db root <database>')
    const db = services.getDatabase(dbName)
    out(table([['host:', db.host ?? '127.0.0.1'], ['port:', String(db.port)], ['user:', db.root?.user ?? 'root'], ['password:', db.root?.password ?? '']]))
    return
  }

  if (sub === 'remove' || sub === 'rm') {
    const dbName = positional[1]
    if (!dbName) fail('usage: mcctl db remove <database> [--purge]')
    const res = services.removeDatabase(dbName, { purge: Boolean(flags.purge) })
    out(`Removed database "${res.name}"${res.purged ? ' and its files' : ' (files kept)'}.`)
    if (res.detached.length) out(`Servers that were attached: ${res.detached.join(', ')} - their plugin configs still name it.`)
    return
  }

  fail('usage: mcctl db [list|versions|add|create|connect|attach|detach|creds|plugins|apply|root|remove]')
}

function printCredentials(c) {
  const rows = [['host:', c.host], ['port:', String(c.port)]]
  if (c.database) rows.push(['database:', c.database])
  if (c.user) rows.push(['user:', c.user])
  rows.push(['password:', c.password])
  if (c.jdbc) rows.push(['jdbc:', c.jdbc])
  if (c.url) rows.push(['url:', c.url])
  if (c.keyPrefix) rows.push(['key prefix:', c.keyPrefix])
  out(table(rows))
  if (c.note) out(`  ${c.note}`)
}

// ----------------------------------------------------------------- uninstall

/**
 * What the Windows uninstaller runs before it removes the program: stop every server, remove every
 * scheduled task, and - only when asked - delete what this program created. See uninstall.mjs.
 */
async function cmdUninstall(positional, flags) {
  if (!flags.yes) {
    fail(
      'uninstall stops every server and removes every scheduled task; with --data it also deletes\n' +
        '  the servers this program created, jars, backups, templates and settings.\n' +
        '  Add --yes to go ahead. The desktop app\'s uninstaller runs this for you.',
    )
  }
  const uninstall = await import('./src/uninstall.mjs')
  const res = await uninstall.run({ data: Boolean(flags.data), log: out })
  if (res.stopped.length) out(`Stopped: ${res.stopped.join(', ')}`)
  out(res.tasks ? 'Scheduled tasks removed.' : 'Scheduled tasks could not all be removed.')
  if (flags.data) out(`Deleted ${res.removed.length} item(s).`)
  for (const f of res.failed) out(`  !  ${f}`)
  if (res.failed.length) process.exitCode = 1
}

async function cmdDoctor() {
  const problems = []
  const notes = []

  // The same probe the panel and the first-run wizard use, so all three agree about what
  // counts as a usable Java.
  const javaCheck = await java.health()
  if (!javaCheck.ok) problems.push(`java: ${javaCheck.message} ${java.DOWNLOAD_URL}`)
  else notes.push(`java: ${javaCheck.version}${javaCheck.onPath ? '' : ` at ${javaCheck.path} (not on PATH)`}`)
  for (const other of javaCheck.others ?? []) {
    if (other.path !== javaCheck.path) notes.push(`java (also): ${other.version} at ${other.path}`)
  }

  const tarCheck = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  if (tarCheck.error) problems.push('tar is not on PATH (needed for snapshots)')
  else notes.push(`tar: ${(tarCheck.stdout || '').split('\n')[0].trim()}`)

  notes.push(`node: ${process.version}`)
  notes.push(`root: ${ROOT}`)

  const seenPorts = new Map()
  for (const inst of listInstances()) {
    if (!fs.existsSync(inst.dir)) {
      problems.push(`${inst.name}: directory missing (${inst.dir})`)
      continue
    }
    if (!fs.existsSync(serverJarPath(inst))) {
      problems.push(`${inst.name}: jar missing (${serverJarPath(inst)})`)
    }
    const eula = path.join(inst.dir, 'eula.txt')
    const eulaText = fs.existsSync(eula) ? fs.readFileSync(eula, 'utf8') : ''
    if (!/^\s*eula\s*=\s*true\s*$/im.test(eulaText)) {
      problems.push(`${inst.name}: EULA not accepted (${eula})`)
    }
    for (const [label, port] of [['port', inst.port], ['rcon', inst.rcon?.port]]) {
      if (!port) continue
      if (seenPorts.has(port)) problems.push(`${inst.name}: ${label} ${port} collides with ${seenPorts.get(port)}`)
      else seenPorts.set(port, `${inst.name} ${label}`)
    }
    const { status } = readState(inst.name)
    if (status === 'orphaned') problems.push(`${inst.name}: orphaned java process - run "mcctl kill ${inst.name}"`)
    if (status === 'stale') {
      clearState(inst.name)
      notes.push(`${inst.name}: cleared stale state file`)
    }
    if (status === 'stopped') {
      const free = await isPortFree(inst.port)
      if (!free) problems.push(`${inst.name}: port ${inst.port} is in use by something else while the instance is stopped`)
    }
    notes.push(`${inst.name}: ${humanBytes(dirSize(inst.dir))} on disk at ${inst.dir}`)
  }

  out('Environment')
  for (const n of notes) out(`  ${n}`)
  out('')
  if (!problems.length) {
    out('No problems found.')
    return
  }
  out(`${problems.length} problem(s):`)
  for (const p of problems) out(`  - ${p}`)
  process.exitCode = 1
}

// ---------------------------------------------------------------------- help

function cmdHelp() {
  out(`mcctl - the SpawnLoft command line. Local Minecraft servers, from a terminal.

LIFECYCLE
  mcctl list                         Show every instance and its state
  mcctl status <name>                Detailed state for one instance
  mcctl start <name>                 Start and wait until the server reports ready
      --detach                       Return as soon as the process launches
      --timeout <sec>                Ready timeout (default 180)
      --no-sync                      Do not push registry ports into server.properties
  mcctl stop <name> [--timeout sec]  Graceful shutdown via the console "stop" command
  mcctl restart <name>               Stop then start
  mcctl kill <name>                  Force-kill the process tree

CONSOLE
  mcctl logs <name> [-n 60] [-f]     Read the captured console; -f follows
      --grep <regex>                 Filter lines
  mcctl cmd <name> "<command>"       Run a command over RCON and print the reply
  mcctl send <name> "<line>"         Write a raw line to the server's stdin
  mcctl console <name>               Interactive attach (server survives detach)
  mcctl players <name>               Who is online

INSTANCES
  mcctl adopt <name> <dir>           Register an existing server directory in place
      --jar <file> --memory <4G>
  mcctl new <name> [options]         Create a fresh instance
      --jar <file>                   Server jar from the jars/ store
      --paper <version>              Download that Paper version and use it
      --purpur | --folia | --asp     Same, for Purpur, Folia or Advanced Slime Paper
      --vanilla <version>            Mojang's own server jar (no plugins, no mods)
      --spigot | --craftbukkit <v>   Compiled here by BuildTools (needs a JDK, ~10 min)
      --build <n>                    A specific build, for the sources that number them
      --fabric <version>             Download Fabric for that version (mods, not plugins)
      --neoforge <version>           Install NeoForge for that version (mods, not plugins)
      --modpack <slug>               Build the whole server from a Modrinth modpack
      --template <name>              Start from a saved template
      --memory <4G> --port <n>
      --accept-eula                  Write eula=true (you accept Mojang's EULA)
      --offline                      Let anyone join as any name, no account needed.
                                     Puts an OFFLINE/INSECURE banner in every log.
  mcctl clone <src> <new>            Copy plugins+config into a new instance
      --with-worlds                  Also copy world data (default: fresh worlds)
  mcctl set <name> key=value...      memory, java, jar, port, rcon.port, rcon.password,
                                     auto-restart=on|off, webhook=<url>|off
  mcctl props <name> [key=value...]  Read or edit server.properties
  mcctl plugins <name>               List plugins; flip one with: plugins <name> disable <x>
  mcctl worlds <name>                List worlds; use <w>, import <src> --as <n>,
                                     export [w], delete <w> --yes
  mcctl rm <name> [--purge --yes]    Unregister (and optionally delete files)

SNAPSHOTS
  mcctl backup <name>                Snapshot to backups/<name>/
      --scope <${backup.SCOPES.join('|')}>
      --label <text> --keep <n>
  mcctl snapshots <name>             List snapshots
  mcctl restore <name> [ref] --yes   Restore (default ref: latest); server must be stopped
  mcctl prune <name> --keep <n>      Delete all but the newest n
  mcctl verify <name> [ref|--all]    Read a snapshot back end to end and check its coverage

OTHER
  mcctl templates                    List templates
  mcctl templates save <inst> <tpl>  Save an instance's plugins+config as a template
  mcctl ui [--port n] [--no-open]    Serve the local control panel (and open it in a browser)
  mcctl paper versions               Paper versions available to download
  mcctl paper fetch <version>        Download a Paper build into the jar store
  mcctl upgrade <name> [--check]     Move to the newest Paper build for its version;
                                     --version <v> --yes crosses Minecraft versions
  mcctl pack <name> [update --yes]   A modpack server's pack: show, check, update
                                     (snapshot first; worlds and hand-added files untouched)
  mcctl config                       Show where servers, jars and backups live
  mcctl config set-root <path>       Move the data root (new servers only)
  mcctl config set-instances <path>  Put servers on a different drive
  mcctl config set-backup-mirror <path>|off
                                     Copy every new snapshot to a second drive too
  mcctl rename <old> <new>           Rename an instance (and its folder)
  mcctl rebuild <name> --yes         Reset worlds; keeps plugins unless --wipe-plugins
  mcctl reveal <name>                Open the instance folder in Explorer
  mcctl launchers [name]             Write start/console/stop .bat files
  mcctl jars                         List stored server jars
  mcctl jars import <path> [--as x]  Add a server jar to the store
  mcctl why <name>                   Say what is wrong with a server, from its own console

DATABASES
  mcctl db                           List databases
  mcctl db versions [--engine e]     Releases that can be run: mariadb (default) or garnet (Redis)
  mcctl db add <name> [--version v]  Download MariaDB and set up a database on a free port [--engine garnet for Redis]
  mcctl db connect <name> --host h --port n --user u --password p   Register a database you already run
  mcctl db create <server>           A database of the server's own on the port after its game port, started and attached
  mcctl db attach <db> <server>      Give a server its own database and user; prints the credentials
  mcctl db detach <db> <server>      Take the user away [--drop deletes the data too]
  mcctl db creds <db> <server>       Show a server's credentials again
  mcctl db plugins <server>          Which plugins here can take those credentials
  mcctl db apply <db> <server> <plugin>  Write them into that plugin's config (luckperms, coreprotect, plan, authme)
  mcctl db remove <db> [--purge]     Forget a stopped database [and delete its files]
  start, stop, restart, logs and status take a database's name like a server's.

  mcctl doctor                       Check environment, ports, EULA, disk, stale state
  mcctl uninstall --yes [--data]     Stop servers, remove scheduled tasks; --data deletes what mcctl made
`)
}

// ---------------------------------------------------------------------- main

const COMMANDS = {
  list: cmdList,
  ls: cmdList,
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  kill: cmdKill,
  logs: cmdLogs,
  log: cmdLogs,
  cmd: cmdCmd,
  rcon: cmdCmd,
  send: cmdSend,
  console: cmdConsole,
  attach: cmdConsole,
  players: cmdPlayers,
  new: cmdNew,
  clone: cmdClone,
  adopt: cmdAdopt,
  rm: cmdRemove,
  remove: cmdRemove,
  set: cmdSet,
  props: cmdProps,
  backup: cmdBackup,
  snapshot: cmdBackup,
  snapshots: cmdSnapshots,
  restore: cmdRestore,
  prune: cmdPrune,
  verify: cmdVerify,
  templates: cmdTemplates,
  template: cmdTemplates,
  jars: cmdJars,
  paper: cmdPaper,
  config: cmdConfig,
  rename: cmdRename,
  rebuild: cmdRebuild,
  reveal: cmdReveal,
  open: cmdReveal,
  plugins: cmdPlugins,
  upgrade: cmdUpgrade,
  pack: cmdPack,
  worlds: cmdWorlds,
  why: cmdWhy,
  launchers: cmdLaunchers,
  ui: cmdUi,
  panel: cmdUi,
  task: cmdTask,
  doctor: cmdDoctor,
  db: cmdDb,
  uninstall: cmdUninstall,
  help: cmdHelp,
}

async function main() {
  ensureDirs()
  const [, , command, ...rest] = process.argv
  if (!command || command === '--help' || command === '-h') {
    cmdHelp()
    return
  }
  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`Unknown command "${command}". Run "mcctl help" for usage.\n`)
    process.exitCode = 2
    return
  }
  const { flags, positional } = parseArgs(rest)
  await handler(positional, flags)
}

main().catch((err) => {
  if (err instanceof UserError) {
    process.stderr.write(`error: ${err.message}\n`)
    process.exitCode = 1
  } else {
    process.stderr.write(`${err.stack || err}\n`)
    process.exitCode = 1
  }
})
