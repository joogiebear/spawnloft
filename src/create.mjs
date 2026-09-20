import fs from 'node:fs'
import path from 'node:path'
import { JARS_DIR, TEMPLATES_DIR, INSTANCES_DIR, ROOT } from './paths.mjs'
import { getInstance, hasInstance, putInstance, usedPorts, defaultDir, parseMemoryGb } from './registry.mjs'
import { readProps, writeProps } from './props.mjs'
import { fail, findFreePort, randomPassword, validateName, humanBytes } from './util.mjs'
import { guessLoader } from './software.mjs'
import { defaultJava } from './java.mjs'

const DEFAULT_PORT = 25565
const DEFAULT_RCON_PORT = 25575

/**
 * Put a server jar where the instance expects to find it.
 *
 * <p>An instance runs the jar sitting in its own directory - serverJarPath is just
 * `<dir>/<inst.jar>` - while the jar store is a separate place jars are downloaded and kept. The
 * two are connected only by something copying between them, and only creation was doing it.
 * Changing an existing server's jar therefore recorded a filename that pointed at nothing, and the
 * next start failed with a path that had never existed.
 *
 * <p>Idempotent: a jar already in place is left alone rather than recopied, so this is safe to call
 * on every change whether or not the jar is new.
 */
export function placeJar(dir, chosenJar) {
  const base = path.basename(chosenJar)
  const inInstance = path.join(dir, base)
  if (fs.existsSync(inInstance)) return { path: inInstance, copied: false }

  const fromStore = path.join(JARS_DIR, base)
  const abs = path.isAbsolute(chosenJar) ? chosenJar : null
  const src = fs.existsSync(fromStore) ? fromStore : abs && fs.existsSync(abs) ? abs : null
  if (!src) {
    const have = listJars().map((j) => j.name).join(', ')
    fail([
      `server jar "${chosenJar}" is not in ${JARS_DIR}.`,
      have ? `  Stored jars: ${have}` : '  The jar store is empty.',
      '  Download one with "mcctl paper fetch <version>" or add one with "mcctl jars import <path>".',
    ].join(String.fromCharCode(10)))
  }
  fs.copyFileSync(src, inInstance)
  return { path: inInstance, copied: true }
}

/**
 * Jars in an instance's directory that it is not the one being run.
 *
 * <p>Changing version leaves the old one behind - fifty megabytes each, and they accumulate quietly.
 * Reported rather than deleted: the old jar is the way back if the new version turns out to be
 * wrong, and that is not a decision to make on somebody's behalf.
 */
export function strayJars(dir, currentJar) {
  const keep = path.basename(currentJar || '')
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.jar') && f !== keep)
      .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
  } catch {
    return []
  }
}

export function listJars() {
  fs.mkdirSync(JARS_DIR, { recursive: true })
  return fs
    .readdirSync(JARS_DIR)
    .filter((f) => f.endsWith('.jar'))
    .map((f) => {
      const st = fs.statSync(path.join(JARS_DIR, f))
      return { name: f, size: st.size, sizeHuman: humanBytes(st.size), mtime: st.mtime }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function importJar(src, { as = null } = {}) {
  if (!fs.existsSync(src)) fail(`jar not found: ${src}`)
  fs.mkdirSync(JARS_DIR, { recursive: true })
  const dest = path.join(JARS_DIR, as || path.basename(src))
  fs.copyFileSync(src, dest)
  return dest
}

/**
 * Double-clickable launchers, written into each instance directory.
 *
 * <p>Not everything wants a terminal and a remembered command. These make an instance startable and
 * watchable from Explorer, which is also what makes a second machine or a second person able to run
 * one of these servers without learning the CLI first.
 *
 * <p>They shell out to mcctl by absolute path rather than duplicating any logic, so a launcher can
 * never drift from what the CLI actually does - it IS the CLI.
 */
/**
 * How a .bat should invoke mcctl on THIS installation.
 *
 * <p>`node` is only on PATH if the person installed Node themselves. Someone who downloaded the
 * desktop app has no reason to have it, and a launcher that opens a console saying 'node' is not
 * recognized is worse than no launcher. The app already carries a Node runtime - its own
 * executable - so the launchers use whatever is actually running mcctl right now.
 */
function launcherRuntime() {
  const exe = process.execPath
  // Electron's binary runs scripts as Node only when told to; plain node ignores the variable.
  const viaElectron = Boolean(process.versions.electron)
  return {
    prelude: viaElectron ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : '',
    exe: /[\\\/]node(?:\.exe)?$/i.test(exe) ? 'node' : `"${exe}"`,
  }
}

/**
 * The same three launchers as shell scripts, for Linux.
 *
 * <p>For someone in a terminal inside the server's folder, which is where a person running a Linux
 * server usually is: ./start.sh rather than remembering what the instance was registered as.
 * Quoted with single quotes throughout, since a home folder may hold a space and a shell would
 * split the path on it.
 */
function writeShellLaunchers(inst) {
  const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'"
  const run = `${quote(process.execPath)} ${quote(path.join(ROOT, 'mcctl.mjs'))}`
  // Electron's binary runs scripts as Node only when told to; plain node ignores the variable.
  const head = ['#!/bin/sh', ...(process.versions.electron ? ['export ELECTRON_RUN_AS_NODE=1'] : [])]
  const name = quote(inst.name)
  const script = (...lines) => [...head, ...lines, ''].join('\n')
  const files = {
    // Starts, then attaches - the same meaning "start the server" has on Windows.
    'start.sh': script(`${run} start ${name} || { echo; echo 'Failed to start.'; exit 1; }`, `exec ${run} console ${name}`),
    'console.sh': script(`exec ${run} console ${name}`),
    'stop.sh': script(`exec ${run} stop ${name}`),
  }
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(inst.dir, file), body, { mode: 0o755 })
    // The mode above only applies to a file being created; a rewrite has to be told again.
    fs.chmodSync(path.join(inst.dir, file), 0o755)
  }
  return Object.keys(files)
}

export function writeLaunchers(inst) {
  if (process.platform === 'linux') return writeShellLaunchers(inst)
  const cli = path.join(ROOT, 'mcctl.mjs')
  const rt = launcherRuntime()
  const run = `${rt.exe} "${cli}"`
  const files = {
    // Starts, then attaches - so a double-click gives you a running server AND its console, which is
    // what "start the server" means to anyone not thinking about daemons.
    'start.bat': `@echo off
${rt.prelude}title ${inst.name} - SpawnLoft
${run} start ${inst.name}
if errorlevel 1 (echo.& echo Failed to start. & pause & exit /b 1)
${run} console ${inst.name}
`,
    'console.bat': `@echo off
${rt.prelude}title ${inst.name} console - SpawnLoft
${run} console ${inst.name}
pause
`,
    'stop.bat': `@echo off
${rt.prelude}title ${inst.name} - SpawnLoft
${run} stop ${inst.name}
pause
`,
  }
  for (const [file, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(inst.dir, file), body)
  }
  return Object.keys(files)
}

export function listTemplates() {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true })
  return fs
    .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const metaFile = path.join(TEMPLATES_DIR, e.name, 'template.json')
      let meta = {}
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      } catch {
        /* templates without metadata are still usable */
      }
      return { name: e.name, dir: path.join(TEMPLATES_DIR, e.name), ...meta }
    })
}

function copyTree(src, dest, { skip = new Set() } = {}) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyTree(s, d, { skip })
    else if (entry.isFile()) fs.copyFileSync(s, d)
  }
}

/** Everything that must never be cloned between instances. */
const CLONE_SKIP = new Set([
  'cache',
  'libraries',
  'versions',
  'logs',
  'server-console.log',
  'usercache.json',
  'version_history.json',
  'session.lock',
])

async function allocatePorts({ port, rconPort }) {
  const taken = usedPorts()
  const resolvedPort = port ?? (await findFreePort(DEFAULT_PORT, taken))
  taken.add(resolvedPort)
  const resolvedRcon = rconPort ?? (await findFreePort(DEFAULT_RCON_PORT, taken))
  return { port: resolvedPort, rconPort: resolvedRcon }
}

export async function newInstance(
  name,
  {
    template = null,
    from = null,
    withWorlds = false,
    jar = null,
    memory = '4G',
    port = null,
    rconPort = null,
    acceptEula = false,
    motd = null,
    java = null,
    onlineMode = true,
    loader = 'paper',
    mcVersion = null,
  } = {},
) {
  validateName(name)
  if (hasInstance(name)) fail(`instance "${name}" already exists`)
  // Before a directory is made or a jar is downloaded. An unusable memory value written into the
  // registry does not fail here - it fails when the daemon builds -Xmx from it, minutes later, on
  // a server that looks created. Same parser the launcher uses, so what is accepted here is what
  // will start.
  parseMemoryGb(memory)

  const dir = defaultDir(name)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    fail(`directory already exists and is not empty: ${dir}`)
  }
  fs.mkdirSync(dir, { recursive: true })

  let sourceJar = null

  if (from) {
    const src = getInstance(from)
    if (!fs.existsSync(src.dir)) fail(`source instance directory is missing: ${src.dir}`)
    const skip = new Set(CLONE_SKIP)
    if (!withWorlds) {
      const props = readProps(path.join(src.dir, 'server.properties'))
      const level = props.get('level-name') || 'world'
      for (const entry of fs.readdirSync(src.dir, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === level || entry.name.startsWith(`${level}_`))) {
          skip.add(entry.name)
        }
      }
    }
    copyTree(src.dir, dir, { skip })
    sourceJar = src.jar
    memory = memory ?? src.memory
  } else if (template) {
    const tpl = listTemplates().find((t) => t.name === template)
    if (!tpl) fail(`no template named "${template}" - see: mcctl templates`)
    copyTree(tpl.dir, dir, { skip: new Set(['template.json']) })
    sourceJar = tpl.jar ?? null
  }

  // Resolve the server jar and place it in the instance directory. NeoForge is the one loader
  // with no jar to place: its installer lays the server down AFTER the instance exists, and
  // the caller records the starter jar it produces.
  const chosenJar = jar ?? sourceJar
  if (!chosenJar && loader !== 'neoforge') {
    fail(
      `no server jar specified.\n` +
        `  Pick one with --jar <file>. Available: ${listJars().map((j) => j.name).join(', ') || '(none - use "mcctl jars import <path>")'}`,
    )
  }
  if (chosenJar) placeJar(dir, chosenJar)

  const { port: finalPort, rconPort: finalRcon } = await allocatePorts({ port, rconPort })
  const rconPassword = randomPassword()

  const props = {
    'server-port': String(finalPort),
    'enable-rcon': 'true',
    'rcon.port': String(finalRcon),
    'rcon.password': rconPassword,
    'server-ip': '',
    /*
      Online mode, by default.

      This used to default to false, on the reasoning that a scratch server is for plugin testing
      and offline lets you join as any name without an account. The cost turned out to be higher
      than the convenience: offline issues name-derived UUIDs rather than Mojang ones, so a plugin
      that keys anything by UUID behaves differently - some bugs will not reproduce, and some appear
      that do not exist on a real server. Paper also prints a four-line OFFLINE/INSECURE banner near
      the top of every log, and plugin authors routinely refuse a bug report carrying it.

      A tool whose whole job is reproducing plugin bugs should not produce reports that get thrown
      out on sight. Offline is still one toggle away for multi-account or no-internet testing.
    */
    'online-mode': onlineMode === false ? 'false' : 'true',
    'motd': motd ?? `${name} (SpawnLoft)`,
    'max-players': '10',
    'spawn-protection': '0',
  }
  writeProps(path.join(dir, 'server.properties'), props)

  if (acceptEula) {
    fs.writeFileSync(
      path.join(dir, 'eula.txt'),
      `# Accepted via SpawnLoft on ${new Date().toISOString()}\n` +
        `# https://aka.ms/MinecraftEULA\neula=true\n`,
    )
  }

  const cfg = {
    dir,
    jar: chosenJar ? path.basename(chosenJar) : 'server.jar',
    // Nobody chose one: the best Java on the machine, wherever it is - see java.mjs. 'java' by
    // name is what a machine with nothing found gets, so the failure at start names it plainly.
    java: java ?? (await defaultJava()) ?? 'java',
    memory,
    loader,
    // Recorded when the jar name cannot carry it (NeoForge's starter is just "server.jar").
    ...(mcVersion ? { mcVersion } : {}),
    port: finalPort,
    rcon: { port: finalRcon, password: rconPassword },
    createdAt: new Date().toISOString(),
    origin: from ? { clonedFrom: from, withWorlds } : template ? { template } : { scratch: true },
  }
  putInstance(name, cfg)
  writeLaunchers({ name, dir: cfg.dir })
  return { name, ...cfg, eulaAccepted: acceptEula }
}

/**
 * Register an existing server directory without moving or rewriting it.
 * Ports and RCON credentials are read from its own server.properties so the
 * adopted server keeps behaving exactly as it did before.
 */
export async function adoptInstance(name, dir, { jar = null, memory = '4G', java = null } = {}) {
  validateName(name)
  if (hasInstance(name)) fail(`instance "${name}" already exists`)
  parseMemoryGb(memory)
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs)) fail(`directory not found: ${abs}`)

  const jars = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.jar'))
    .sort()
  let chosen = jar
  if (!chosen) {
    const preferred = jars.filter((f) => /paper|purpur|spigot|folia|fabric|server/i.test(f))
    const pool = preferred.length ? preferred : jars
    if (pool.length === 0) fail(`no .jar found in ${abs} - pass --jar <file>`)
    if (pool.length > 1) fail(`multiple jars in ${abs} - pass --jar <one of: ${pool.join(', ')}>`)
    chosen = pool[0]
  }
  if (!fs.existsSync(path.join(abs, chosen))) fail(`jar not found: ${path.join(abs, chosen)}`)

  const props = readProps(path.join(abs, 'server.properties'))
  const taken = usedPorts()
  const port = Number(props.get('server-port')) || (await findFreePort(DEFAULT_PORT, taken))
  taken.add(port)
  const rconPort = Number(props.get('rcon.port')) || (await findFreePort(DEFAULT_RCON_PORT, taken))
  const rconPassword = props.get('rcon.password') || randomPassword()

  const cfg = {
    dir: abs,
    jar: chosen,
    java: java ?? (await defaultJava()) ?? 'java',
    memory,
    // Guessed the way a person would: a Fabric launcher names itself, a NeoForge server carries
    // its libraries tree, and a Purpur, Folia, Spigot or vanilla jar says so in its name.
    // Anything else is treated as Paper.
    loader: guessLoader(chosen, { hasNeoforgeLibs: fs.existsSync(path.join(abs, 'libraries', 'net', 'neoforged')) }),
    port,
    rcon: { port: rconPort, password: rconPassword },
    createdAt: new Date().toISOString(),
    origin: { adopted: abs },
  }
  putInstance(name, cfg)
  writeLaunchers({ name, dir: cfg.dir })
  return { name, ...cfg }
}

/** Snapshot an instance's plugins+config into a reusable template. */
export function saveTemplate(inst, templateName, { includeWorlds = false } = {}) {
  validateName(templateName)
  const dest = path.join(TEMPLATES_DIR, templateName)
  if (fs.existsSync(dest)) fail(`template "${templateName}" already exists`)

  const skip = new Set(CLONE_SKIP)
  if (!includeWorlds) {
    const props = readProps(path.join(inst.dir, 'server.properties'))
    const level = props.get('level-name') || 'world'
    for (const entry of fs.readdirSync(inst.dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === level || entry.name.startsWith(`${level}_`))) {
        skip.add(entry.name)
      }
    }
  }
  // The jar lives in jars/, not inside every template copy.
  skip.add(inst.jar)

  copyTree(inst.dir, dest, { skip })
  fs.writeFileSync(
    path.join(dest, 'template.json'),
    `${JSON.stringify(
      {
        name: templateName,
        jar: inst.jar,
        memory: inst.memory,
        includesWorlds: includeWorlds,
        sourceInstance: inst.name,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  )
  return { name: templateName, dir: dest }
}

export { INSTANCES_DIR }
