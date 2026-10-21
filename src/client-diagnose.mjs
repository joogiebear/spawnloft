// The client's known failure shapes, read over latest.log and the client process's output. The
// scan and the Java-release table are diagnose.mjs's, so the two sides never drift apart.
import { CLASS_VERSION_TO_JAVA, scanShapes } from './diagnose.mjs'

export const CLIENT_SHAPES = [
  {
    id: 'client-out-of-memory',
    test: /java\.lang\.OutOfMemoryError/,
    title: 'The client ran out of memory',
    advice: (m, ctx) => `It has ${ctx.memory ?? 'its configured memory'} and wants more. Raise it with `
      + `"spawnloft client set ${ctx.profile ?? 'the profile'} memory=4G", and make sure the machine has that to give.`,
  },
  {
    id: 'opengl',
    test: /Failed to create window|GLFW error|OpenGL (version|context)|No OpenGL context/i,
    title: 'The graphics subsystem could not start',
    advice: () => 'The graphics driver could not create a window or an OpenGL context. Update the GPU '
      + 'driver; a headless machine with no display cannot run the client, and bots ("spawnloft bot") are the way to test there.',
  },
  {
    id: 'mod-dependency',
    test: /requires (?:any version|version [^ ]+) of ([\w-]+), which is missing/i,
    title: 'A mod is missing a dependency',
    advice: (m) => `A mod needs "${m[1]}", which is not installed. Install it into the profile's `
      + 'mods/ folder.',
  },
  {
    id: 'mod-wrong-version',
    test: /Mod '[^']+' \([\w-]+\) [^ ]+ requires|Incompatible mods found/i,
    title: 'A mod is built for a different Minecraft version',
    advice: (m, ctx) => `A mod is built for a different Minecraft version than ${ctx.mc ?? 'this version'}. `
      + 'Re-download it for the right version, or switch the profile to the version it wants.',
  },
  {
    id: 'connection-refused',
    test: /Connection refused|Failed to connect to the server|io\.netty\.channel\.AbortedException/i,
    title: 'The client could not reach the server',
    advice: () => 'The server is not running or the address is wrong. "spawnloft list" shows which '
      + 'servers are up.',
  },
  {
    id: 'kicked-outdated',
    test: /Outdated (client|server)|Incompatible client/i,
    title: 'The client version does not match the server',
    advice: (m, ctx) => `The profile's Minecraft version (${ctx.mc ?? 'this version'}) differs from the `
      + `server's. Set it with "spawnloft client set ${ctx.profile ?? 'the profile'} mc=<version>".`,
  },
  {
    id: 'auth-failed',
    test: /Failed to verify username|Invalid session|Authentication servers are down/i,
    title: 'Authentication failed',
    advice: () => 'An offline profile can only join a server with online-mode=false; for any other server, '
      + 'the Microsoft sign-in has expired: sign in again with "spawnloft client login".',
  },
  {
    id: 'resource-pack',
    test: /Failed to (download|apply) resource pack|Couldn't load pack/i,
    title: 'A resource pack could not be loaded',
    advice: () => 'The resource pack could not be downloaded or applied. Check resource-pack and '
      + "resource-pack-sha1 in the server's server.properties: the URL must be reachable from this machine and the hash must match the file.",
  },
  {
    id: 'crash-report',
    test: /#@!@# Game crashed!|---- Minecraft Crash Report ----/,
    title: 'The game crashed',
    advice: (m, ctx) => `The game crashed. See the crash report in ${ctx.crashDir ?? 'crash-reports/'} `
      + 'for the full stack trace.',
  },
  {
    id: 'wrong-java',
    test: /UnsupportedClassVersionError.*class file version (\d+)/i,
    title: 'Java is too old for this client',
    advice: (m) => {
      const needs = CLASS_VERSION_TO_JAVA(Number(m[1]))
      return `The client is built for Java ${needs} or newer, and the Java that launched it is older. `
        + `Install Java ${needs}+ and, if several are installed, point the profile at it with `
        + '"spawnloft client set <profile> java=<path>".'
    },
  },
]

export function clientDiagnose(lines, ctx = {}) {
  return scanShapes(CLIENT_SHAPES, lines, ctx)
}
