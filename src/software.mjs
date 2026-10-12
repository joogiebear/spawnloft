// Table of the server software mcctl can create. Pure data (no network or filesystem) so plugins.mjs
// can import it cheaply; the fetch clients are in sources.mjs.
// family: bukkit loads plugins/ (Paper and the forks and ancestors around it), fabric and neoforge load mods/,
// vanilla loads nothing. modrinth is the search loader facet, widest-compatible first, narrowing down
// the tree (Folia only runs Folia plugins; Spigot can't load plugins needing Paper's API). hangar says
// whether PaperMC's platform is a useful second source.
export const SOFTWARE = [
  {
    id: 'paper',
    label: 'Paper',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['paper', 'spigot', 'bukkit', 'folia'],
    hangar: true,
    blurb: 'Downloads the newest stable Paper build.',
  },
  {
    id: 'purpur',
    label: 'Purpur',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['purpur', 'paper', 'spigot', 'bukkit', 'folia'],
    hangar: true,
    blurb: 'A Paper fork with more configuration. Downloads the newest Purpur build.',
  },
  {
    id: 'folia',
    label: 'Folia',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['folia'],
    hangar: false,
    blurb: 'Paper with regionised multithreading. Only plugins built for Folia will load.',
  },
  {
    id: 'asp',
    label: 'Advanced Slime Paper',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['paper', 'spigot', 'bukkit', 'folia'],
    hangar: true,
    blurb: 'Paper with Slime World Manager built in, from InfernalSuite. Downloads the newest build.',
  },
  {
    id: 'spigot',
    label: 'Spigot',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['spigot', 'bukkit'],
    hangar: false,
    // SpigotMC publishes no jars; BuildTools compiles one here. slow warns up front so a ten-minute create doesn't read as a hang.
    slow: true,
    blurb: 'Compiled on this machine by SpigotMC’s BuildTools. Needs a JDK and takes five to ten minutes the first time.',
  },
  {
    id: 'craftbukkit',
    label: 'CraftBukkit',
    family: 'bukkit',
    content: 'plugins',
    modrinth: ['bukkit'],
    hangar: false,
    slow: true,
    blurb: 'Compiled on this machine by SpigotMC’s BuildTools. Needs a JDK and takes five to ten minutes the first time.',
  },
  {
    id: 'vanilla',
    label: 'Vanilla',
    family: 'vanilla',
    content: 'none',
    modrinth: [],
    hangar: false,
    blurb: 'Mojang’s own server, unmodified. No plugins and no mods.',
  },
  {
    id: 'fabric',
    label: 'Fabric',
    family: 'fabric',
    content: 'mods',
    modrinth: ['fabric'],
    hangar: false,
    blurb: 'Downloads the Fabric server launcher, which fetches the rest on first start.',
  },
  {
    id: 'neoforge',
    label: 'NeoForge',
    family: 'neoforge',
    content: 'mods',
    modrinth: ['neoforge'],
    hangar: false,
    blurb: 'Runs the NeoForge installer, which downloads its libraries. Takes a few minutes.',
  },
]

const BY_ID = new Map(SOFTWARE.map((s) => [s.id, s]))

// unknown and absent both mean Paper (see registry.loaderOf)
export function softwareOf(loader) {
  return BY_ID.get(loader) ?? BY_ID.get('paper')
}

export function isSoftware(id) {
  return BY_ID.has(id)
}

// ids whose server is one jar fetched into the store; NeoForge is installed instead
export const JAR_IDS = SOFTWARE.filter((s) => s.id !== 'neoforge').map((s) => s.id)

// Every source names its jar <id>-<mc>... so instances made before mcVersion was recorded still answer.
export function versionFromJar(jar) {
  const name = String(jar || '')
  const m = /^(?:paper|purpur|folia|asp|spigot|craftbukkit|vanilla)-(\d+\.\d+(?:\.\d+)?)/i.exec(name)
    ?? /^fabric-server-mc\.(\d+\.\d+(?:\.\d+)?)-/i.exec(name)
  return m ? m[1] : null
}

// Guessed from the jar name, and for NeoForge from the libraries tree its installer leaves.
// Anything unrecognised is Paper.
export function guessLoader(jar, { hasNeoforgeLibs = false } = {}) {
  const name = String(jar || '')
  if (/^fabric-server/i.test(name)) return 'fabric'
  if (hasNeoforgeLibs) return 'neoforge'
  const m = /^(purpur|folia|asp|spigot|craftbukkit|vanilla)-/i.exec(name)
  if (m) return m[1].toLowerCase()
  return 'paper'
}
