// Recognises known failure shapes in console output and suggests the fix. Anything unrecognised
// is left as the raw stack trace. Pure over an array of lines; callers supply them (the panel and
// CLI tail the console, the daemon keeps a ring of its child's last output).

import fs from 'node:fs'
import path from 'node:path'
import { humanBytes } from './util.mjs'

// class-file major version to Java release
export const CLASS_VERSION_TO_JAVA = (major) => major - 44

// ordered from more specific/actionable to less
export const SHAPES = [
  {
    id: 'port-in-use',
    test: /FAILED TO BIND TO PORT|Address already in use|Failed to bind to address/i,
    title: 'The port is already taken',
    advice: (m, ctx) => `Something else is listening on port ${ctx.port ?? 'this server’s port'} - `
      + 'usually another server, or another copy of this one. "mcctl list" shows who; '
      + 'change the port under Manage if both should run at once.',
  },
  {
    id: 'eula',
    test: /You need to agree to the EULA/i,
    title: 'The EULA is not accepted',
    advice: (m, ctx) => `Set eula=true in ${ctx.dir ? `${ctx.dir}\\eula.txt` : 'eula.txt'} `
      + '(see https://aka.ms/MinecraftEULA) and start again.',
  },
  {
    id: 'wrong-java',
    test: /UnsupportedClassVersionError.*class file version (\d+)/i,
    title: 'Java is too old for this server',
    advice: (m) => {
      const needs = CLASS_VERSION_TO_JAVA(Number(m[1]))
      return `This server is built for Java ${needs} or newer, and the Java that launched it is older. `
        + `Install Java ${needs}+ and, if several are installed, point this server at it with `
        + `"mcctl set <name> java=<path-to-java.exe>".`
    },
  },
  {
    id: 'out-of-memory',
    test: /java\.lang\.OutOfMemoryError/,
    title: 'The server ran out of memory',
    advice: (m, ctx) => `It has ${ctx.memory ?? 'its configured memory'} and wants more. Raise it under `
      + 'Manage (modded servers usually want 4G or more), and make sure the machine has that to give.',
  },
  {
    id: 'out-of-disk',
    test: /No space left on device|There is not enough space on the disk/i,
    title: 'The disk is full',
    advice: () => 'The drive this server lives on has no room left - saves and logs are failing. '
      + 'Free space, or move the server with "mcctl config set-instances" onto a drive that has some. '
      + '"mcctl prune" can thin old snapshots.',
  },
  {
    id: 'missing-plugin-dependency',
    test: /UnknownDependencyException:?\s*(?:Unknown[\/ ]dependenc\w+)?:?\s*([\w-]+)?/,
    title: 'A plugin is missing a dependency',
    advice: (m) => (m[1]
      ? `A plugin needs "${m[1]}", which is not installed. Install it from the Plugins tab, or `
        + 'disable the plugin that wants it.'
      : 'A plugin depends on another plugin that is not installed - the lines above name it. '
        + 'Install the missing one from the Plugins tab, or disable the one that wants it.'),
  },
  {
    id: 'missing-mod-dependency',
    test: /requires (?:any version|version [^ ]+) of ([\w-]+), which is missing/i,
    title: 'A mod is missing a dependency',
    advice: (m) => `A mod needs "${m[1]}", which is not installed. Install it from the Mods tab - `
      + 'for most mods that means Fabric API first.',
  },
  {
    id: 'duplicate-plugin',
    test: /Ambiguous plugin name/i,
    title: 'Two plugins claim the same name',
    advice: () => 'Two jars in the plugins folder provide the same plugin - usually an old copy '
      + 'beside a new one, or WorldEdit installed beside FAWE, which already provides it. '
      + 'Disable one of them in the Plugins tab.',
  },
  {
    id: 'corrupt-world',
    test: /Exception reading .*level\.dat|Failed to load level|ChunkIoErrorReport|Corrupted chunk/i,
    title: 'The world failed to load',
    advice: () => 'Part of the world data would not read back - usually a hard power-off mid-save. '
      + 'Restore the latest snapshot from the Backups tab; "mcctl verify" proves which ones are whole.',
  },
  {
    id: 'ticking-crash',
    test: /Exception ticking world|Ticking (entity|block entity)/i,
    title: 'Something in the world crashed the server',
    advice: (m, ctx) => 'An entity or block crashed the server mid-tick. The crash report names the '
      + `exact thing and where it stands${ctx.crashDir ? ` - see ${ctx.crashDir}` : ' - see crash-reports in the server folder'}. `
      + 'If it repeats, that report is what the responsible plugin or mod’s author needs.',
  },
  {
    id: 'watchdog',
    test: /A single server tick took \d+|Considering it to be crashed, server will forcibly shut down/i,
    title: 'The server stalled and the watchdog stopped it',
    advice: () => 'A tick took so long the server declared itself stuck - heavy world generation, '
      + 'a plugin doing too much at once, or the machine out of breath. The thread dump above the '
      + 'shutdown names what it was doing; more memory or fewer chunks loaded usually helps.',
  },
  {
    id: 'missing-jar',
    test: /Unable to access jarfile (.+)/i,
    title: 'The server jar is missing',
    advice: (m) => `Java could not find ${m[1] ? `"${m[1].trim()}"` : 'the server jar'}. `
      + 'Re-download it ("mcctl upgrade" for Paper, or re-choose a jar with "mcctl set <name> jar=..."), '
      + 'or restore the folder from a snapshot.',
  },
]

// Scans from the end so the newest evidence wins; each shape reports once, at most three findings.
export function diagnose(lines, ctx = {}) {
  return scanShapes(SHAPES, lines, ctx)
}

// Shared with client-diagnose.mjs, whose shapes differ but whose rules are the same.
export function scanShapes(shapes, lines, ctx = {}) {
  const findings = []
  const seen = new Set()
  for (let i = lines.length - 1; i >= 0 && findings.length < 3; i--) {
    const line = lines[i]
    for (const shape of shapes) {
      if (seen.has(shape.id)) continue
      const m = shape.test.exec(line)
      if (!m) continue
      seen.add(shape.id)
      findings.push({ id: shape.id, title: shape.title, advice: shape.advice(m, ctx), line, at: i })
    }
  }
  // log order, so cause reads before consequence
  return findings.sort((a, b) => a.at - b.at)
}

// Minecraft's own crash-reports/, newest first, each with its one-line Description read from the
// first couple of KB.
export function crashReports(inst, { limit = 10 } = {}) {
  const dir = path.join(inst.dir, 'crash-reports')
  let entries = []
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.txt'))
  } catch {
    return { dir, reports: [] }
  }
  const reports = entries
    .map((file) => {
      const full = path.join(dir, file)
      const st = fs.statSync(full)
      let description = null
      try {
        const fd = fs.openSync(full, 'r')
        const buf = Buffer.alloc(2048)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        fs.closeSync(fd)
        description = /^Description:\s*(.+)$/m.exec(buf.toString('utf8', 0, n))?.[1]?.trim() ?? null
      } catch {
        /* still listed without a description */
      }
      return { file, mtime: st.mtime, size: st.size, sizeHuman: humanBytes(st.size), description }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
  return { dir, reports }
}
