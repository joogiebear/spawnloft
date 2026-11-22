// Writes scenarios/c7-client-forge.json: `client install` and `client launch` of Forge and
// NeoForge profiles over faked Mojang, Forge and NeoForged hosts, with a stand-in Java (a shell
// script, so Linux and macOS only) that runs the installers' build steps.
//   node tools/parity/make-c7-forge-scenario.mjs
// The installers are zips made here, and every file a version or installer lists carries its
// checksum, so the bodies are written into the scenario as base64. Change this script, never the
// scenario by hand.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const META = 'https://piston-meta.mojang.com'
const DATA = 'https://piston-data.mojang.com'
const LIBS = 'https://libraries.minecraft.net'
const FFILES = 'https://files.minecraftforge.net'
const FMAVEN = 'https://maven.minecraftforge.net'
const NMAVEN = 'https://maven.neoforged.net'

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const hosts = Object.fromEntries([META, DATA, LIBS, FFILES, FMAVEN, NMAVEN].map((o) => [o, { routes: {} }]))
const serve = (url, body) => {
  const u = new URL(url)
  hosts[u.origin].routes[`GET ${u.pathname}`] = { base64: Buffer.from(body).toString('base64') }
  return url
}
const json = (url, value) => {
  const u = new URL(url)
  hosts[u.origin].routes[`GET ${u.pathname}`] = { json: value }
}
// a file with its .sha1 beside it, as the mavens publish them
const published = (url, body) => { serve(url, body); serve(`${url}.sha1`, `${sha1(body)}\n`); return url }

// a zip with a stored and a deflated entry, a folder entry and a manifest
function zip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, data, deflate] of entries) {
    const nameBuf = Buffer.from(name)
    const body = data === null ? Buffer.alloc(0) : Buffer.from(data)
    const packed = deflate ? zlib.deflateRawSync(body) : body
    const crc = zlib.crc32(body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(deflate ? 8 : 0, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(packed.length, 20)
    cd.writeUInt32LE(body.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, packed)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, end])
}

const filler = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 41 + seed) % 251))
const mavenPath = (name) => {
  const [g, a, v, c] = name.split(':')
  const [ver, ext = 'jar'] = v.split('@')
  return `${g.replace(/\./g, '/')}/${a}/${ver}/${a}-${ver}${c ? `-${c}` : ''}.${ext}`
}
const art = (name, body, url) => ({ name, downloads: { artifact: { path: mavenPath(name), url, sha1: sha1(body), size: body.length } } })

// the vanilla versions
const emptyIndex = (() => {
  const text = JSON.stringify({ objects: {} })
  return { id: 'empty', sha1: sha1(text), size: text.length, totalSize: 0, url: serve(`${META}/v1/packages/${sha1(text)}/empty.json`, text) }
})()
const clientJar = (id) => {
  const body = zip([['net/minecraft/client/main/Main.class', `class of ${id}`]])
  return { sha1: sha1(body), size: body.length, url: serve(`${DATA}/v1/objects/${sha1(body)}/client.jar`, body) }
}
const vlib = (name, body) => art(name, body, serve(`${LIBS}/${mavenPath(name)}`, body))
const vanilla = (id, java) => ({
  id, type: 'release', mainClass: 'net.minecraft.client.main.Main',
  javaVersion: java,
  ...(java.majorVersion === 8 ? { minecraftArguments: '--username ${auth_player_name}' } : { arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-cp', '${classpath}'] } }),
  assetIndex: emptyIndex, assets: 'empty', downloads: { client: clientJar(id) },
  libraries: [vlib('com.example:shared:1.0', filler(300, 1))],
})
const versions = { '1.20.1': vanilla('1.20.1', { component: 'java-runtime-gamma', majorVersion: 17 }), '1.12.2': vanilla('1.12.2', { component: 'jre-legacy', majorVersion: 8 }) }
const rows = []
for (const [id, v] of Object.entries(versions)) {
  const text = JSON.stringify(v)
  const url = serve(`${META}/v1/packages/${sha1(text)}/${id}.json`, text)
  rows.push({ id, type: v.type, url, sha1: `\${sha1:${url}}` })
}
json(`${META}/mc/game/version_manifest_v2.json`, { latest: { release: '1.20.1', snapshot: '1.20.1' }, versions: rows })

// a build step's tool: a jar that names its main class
const tool = (main) => zip([['META-INF/MANIFEST.MF', `Manifest-Version: 1.0\r\nMain-Class: ${main.slice(0, 20)}\r\n ${main.slice(20)}\r\n`], ['Tool.class', `tool ${main}`]])
// what the stand-in Java writes for each --output
const MADE = Buffer.from('made')

// a modern installer (NeoForge's, and Forge's from 1.13): libraries, data table, build steps
function modernInstaller({ who, mc, id, mavenBase, toolName, spec = 1, minecraft = mc, versionId = id, extra = {} }) {
  const toolJar = tool('net.example.installertools.ConsoleTool')
  const inside = filler(220, id.length)
  const toolUrl = published(`${mavenBase}/${mavenPath(toolName)}`, toolJar)
  const profile = {
    spec, profile: who, version: id, minecraft, json: '/version.json',
    data: {
      MAPPINGS: { client: `[${toolName.replace(/:[^:]+:[^:]+$/, '')}:mappings:1.0@txt]`, server: '[x:y:1]' },
      PATCHED: { client: `[${toolName.replace(/:[^:]+:[^:]+$/, '')}:patched:1.0]`, server: '[x:y:1]' },
      BINPATCH: { client: '/data/client.lzma', server: '/data/server.lzma' },
      NAME: { client: "'hello world'", server: "'s'" },
    },
    processors: [
      { jar: toolName, classpath: [`${toolName.replace(/:[^:]+$/, '')}:1.0`.replace(/:1\.0:1\.0$/, ':1.0'), 'net.example:inside:1.0'].slice(1), args: ['--task', 'MAPPINGS', '--input', '{MINECRAFT_JAR}', '--output', '{MAPPINGS}', '--name', '{NAME}', '--side', '{SIDE}'], outputs: { '{MAPPINGS}': sha1(MADE) } },
      { sides: ['server'], jar: toolName, args: ['--task', 'SERVER_ONLY'] },
      { jar: toolName, args: ['--task', 'PATCH', '--patch', '{BINPATCH}', '--output', '{PATCHED}', '--root', '{ROOT}'] },
    ],
    libraries: [art(toolName, toolJar, toolUrl), art('net.example:inside:1.0', inside, '')],
    ...extra,
  }
  const version = {
    id: versionId, inheritsFrom: mc, type: 'release', mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: { game: ['--launchTarget', 'forgeclient'], jvm: [] },
    libraries: [art('net.example:inside:1.0', inside, ''), art(`${toolName.replace(/:[^:]+:[^:]+$/, '')}:patched:1.0`, MADE, '')],
  }
  return zip([
    ['install_profile.json', JSON.stringify(profile)],
    ['version.json', JSON.stringify(version)],
    ['data/client.lzma', 'binpatch'],
    ['maven/net/example/inside/1.0/inside-1.0.jar', inside, true],
  ])
}

// NeoForge: the maven's version list, and installers for 1.20.1 (20.1.x)
json(`${NMAVEN}/api/maven/versions/releases/net/neoforged/neoforge`, { isSnapshot: false, versions: ['20.1.1', '20.1.5', '20.1.6-beta', '20.2.3', '20.1.2', '20.1.3', '20.1.4'] })
const NEO = `${NMAVEN}/releases/net/neoforged/neoforge`
const neoInstaller = (build, opts = {}) => published(`${NEO}/${build}/neoforge-${build}-installer.jar`, modernInstaller({ who: 'NeoForge', mc: '1.20.1', id: `neoforge-${build}`, mavenBase: `${NMAVEN}/releases`, toolName: 'net.neoforged.installertools:installertools:2.1.2', ...opts }))
neoInstaller('20.1.5')
neoInstaller('20.1.4', { minecraft: '1.20.2' })
neoInstaller('20.1.3', { spec: 9 })
neoInstaller('20.1.2', { versionId: 'neoforge-other' })
// 20.1.1's installer is served with a checksum that does not match it
serve(`${NEO}/20.1.1/neoforge-20.1.1-installer.jar`, modernInstaller({ who: 'NeoForge', mc: '1.20.1', id: 'neoforge-20.1.1', mavenBase: `${NMAVEN}/releases`, toolName: 'net.neoforged.installertools:installertools:2.1.2' }))
serve(`${NEO}/20.1.1/neoforge-20.1.1-installer.jar.sha1`, `${'0'.repeat(40)}\n`)

// Forge: both lists, a modern installer for 1.20.1 and an old one for 1.12.2
json(`${FFILES}/net/minecraftforge/forge/maven-metadata.json`, { '1.20.1': ['1.20.1-47.1.0', '1.20.1-47.2.0', '1.20.1-47.0.1-new'], '1.12.2': ['1.12.2-14.23.5.2847', '1.12.2-14.23.5.2860'], '1.5.2': ['1.5.2-7.8.1.738'] })
json(`${FFILES}/net/minecraftforge/forge/promotions_slim.json`, { homepage: 'https://files.minecraftforge.net', promos: { '1.20.1-recommended': '47.1.0', '1.12.2-latest': '14.23.5.2860' } })
const FORGE = `${FMAVEN}/net/minecraftforge/forge`
published(`${FORGE}/1.20.1-47.1.0/forge-1.20.1-47.1.0-installer.jar`, modernInstaller({ who: 'Forge', mc: '1.20.1', id: '1.20.1-forge-47.1.0', mavenBase: FMAVEN, toolName: 'net.minecraftforge:installertools:1.4.1' }))

// the old installer: install + versionInfo, libraries with a maven base or none (Mojang's)
const forgeJar = zip([['net/minecraftforge/Forge.class', 'forge']])
const lwrap = filler(330, 50)
const scala = filler(410, 51)
const nosum = filler(120, 52)
published(`${FMAVEN}/net/minecraft/launchwrapper/1.12/launchwrapper-1.12.jar`, lwrap)
published(`${FMAVEN}/org/scala-lang/scala-library/2.11.1/scala-library-2.11.1.jar`, scala)
// a maven with no checksum beside its file: the file itself, checked against the installer's list
serve(`${FMAVEN}/org/example/nosum/1.0/nosum-1.0.jar`, nosum)
const legacy = (build, { libraries, inheritsFrom = '1.12.2' } = {}) => {
  const name = `net.minecraftforge:forge:1.12.2-${build}`
  const profile = {
    install: { profileName: 'forge', target: `1.12.2-forge-${build}`, path: name, version: `forge 1.12.2-${build}`, filePath: `forge-1.12.2-${build}-universal.jar`, welcome: 'Welcome', minecraft: '1.12.2', mirrorList: 'http://files.minecraftforge.net/mirror-brand.list', logo: '/big_logo.png' },
    versionInfo: { id: `1.12.2-forge-${build}`, time: '2018-01-01T00:00:00+0000', releaseTime: '1960-01-01T00:00:00-0700', type: 'release', minecraftArguments: '--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker', mainClass: 'net.minecraft.launchwrapper.Launch', inheritsFrom, jar: '1.12.2', logging: {}, libraries },
    optionals: [{ name: 'Mercurius', client: true }],
  }
  return published(`${FORGE}/1.12.2-${build}/forge-1.12.2-${build}-installer.jar`, zip([['install_profile.json', JSON.stringify(profile)], [`forge-1.12.2-${build}-universal.jar`, forgeJar]]))
}
legacy('14.23.5.2847', { libraries: [
  { name: 'net.minecraftforge:forge:1.12.2-14.23.5.2847', url: 'http://files.minecraftforge.net/maven/' },
  { name: 'net.minecraft:launchwrapper:1.12', serverreq: true, url: 'http://files.minecraftforge.net/maven/' },
  { name: 'org.scala-lang:scala-library:2.11.1', url: 'https://maven.minecraftforge.net/', checksums: [sha1(scala).toUpperCase(), '1'.repeat(40)], serverreq: true, clientreq: true },
  { name: 'org.example:nosum:1.0', url: 'https://maven.minecraftforge.net/', checksums: [sha1(nosum)], clientreq: true },
  { name: 'org.example:serveronly:1.0', clientreq: false, serverreq: true },
] })
legacy('14.23.5.2860', { libraries: [{ name: 'org.evil:lib:1.0', url: 'https://evil.example.com/maven/', clientreq: true }] })

// the stand-in Java: answers -version as Java 17; for a build step, writes "made" to its
// --output, prints a few lines, and fails a task named in FAKE_STEP_FAIL
const fakeJava = `#!/bin/sh
for a in "$@"; do case "$a" in -version) echo 'openjdk version "17.0.9" 2023-10-17' >&2; exit 0;; esac; done
out=""; task=""; prev=""
for a in "$@"; do
  [ "$prev" = "--output" ] && out="$a"
  [ "$prev" = "--task" ] && task="$a"
  prev="$a"
done
echo "task $task"
echo "working on $task"
echo ""
echo "still working"
# stdout and stderr are two pipes, so the order lines from both reach the tail in is a race:
# the failure line goes to stderr only after a pause
if [ "$task" = "$FAKE_STEP_FAIL" ]; then sleep 0.3; echo "Exception in $task" >&2; exit 3; fi
if [ -n "$out" ] && [ "$task" != "$FAKE_STEP_SKIP" ]; then mkdir -p "$(dirname "$out")"; printf made > "$out"; fi
exit 0
`

const profile = (mc, loader, loaderVersion = null) => ({ mc, loader, loaderVersion, memory: '2G', java: '{data}/fakejava', server: null, harness: false, account: null })
const profiles = {
  neo: profile('1.20.1', 'neoforge'),
  neopin: profile('1.20.1', 'neoforge', '20.1.5'),
  neomc: profile('1.20.1', 'neoforge', '20.1.4'),
  neospec: profile('1.20.1', 'neoforge', '20.1.3'),
  neoid: profile('1.20.1', 'neoforge', '20.1.2'),
  neosum: profile('1.20.1', 'neoforge', '20.1.1'),
  neowrong: profile('1.20.1', 'neoforge', '21.1.5'),
  neogone: profile('1.20.1', 'neoforge', '20.1.9'),
  forge: profile('1.20.1', 'forge'),
  forgeold: profile('1.12.2', 'forge', '14.23.5.2847'),
  forgehost: profile('1.12.2', 'forge', '14.23.5.2860'),
  forgebad: profile('1.20.1', 'forge', '47.0.1-new'),
  forgeancient: profile('1.5.2', 'forge'),
  forgenone: profile('1.20.1', 'forge', '99.0'),
}

const run = (args, code, more = {}) => ({ run: ['client', ...args], ...(code === null ? {} : { expect: { code } }), ...more })
const scenario = {
  about: 'C7 part 4c: Forge and NeoForge profiles (made by make-c7-forge-scenario.mjs), with a stand-in Java that runs the build steps. NeoForge picks its newest stable build and pins it; the installer is checked against the maven\'s .sha1, its libraries fetched or taken out of it, the data table resolved, the client\'s steps run (the server\'s skipped), the outputs checked and the stamp written; installed again from the stamp, set up again after a stamped file changes, a step that fails (its last lines told) and one whose output is not made; installers for another Minecraft, an unknown format, another id, and one whose checksum does not match; a build for another version and one not published. Forge picks its recommended build; an old 1.12.2 installer read into the new shape (Mojang\'s Java 8 wanted, the profile\'s newer one used with a warning, checksums from the maven, from the installer\'s list and from the file itself); a library on another host, a test build, a version too old, an unknown build; and launches with the fake game.',
  platforms: ['linux-x64', 'darwin'],
  env: { NODE_ENV: 'test' },
  hosts,
  normalize: [
    { pattern: '^1[5-9]\\d{11}$', replace: '<epoch-ms>' },
    { pattern: '(?:(?:libraries|assets) \\d+/\\d+ \\([^)\\n]*\\)\\n)+', replace: '<progress>\n' },
    { pattern: '"at": "[^"]*"', replace: '"at": "<time>"' },
  ],
  ignore: ['data/client/cache/verified.json', 'data/client/run/*/loader-install.log'],
  steps: [
    { write: 'data/fakejava', text: fakeJava, mode: '755' },
    { write: 'data/client/profiles.json', json: { version: 1, profiles, defaultAccount: null } },
    run(['install', 'neo'], 0),
    run(['install', 'neo', '--json'], 0),
    run(['install', 'neopin', '--json'], 0),
    { write: 'data/client/libraries/net/neoforged/installertools/patched/1.0/patched-1.0.jar', text: 'changed' },
    run(['install', 'neo'], 0),
    { remove: 'data/client/versions/neoforge-20.1.5/.loader-installed.json' },
    { remove: 'data/client/libraries/net/neoforged/installertools/mappings/1.0/mappings-1.0.txt' },
    run(['install', 'neo'], 1, { env: { FAKE_STEP_FAIL: 'MAPPINGS' } }),
    run(['install', 'neo', '--json'], 1, { env: { FAKE_STEP_SKIP: 'MAPPINGS' } }),
    run(['install', 'neo', '--verify'], 0),
    run(['install', 'neomc'], 1),
    run(['install', 'neospec', '--json'], 1),
    run(['install', 'neoid'], 1),
    run(['install', 'neosum', '--json'], 1),
    run(['install', 'neowrong'], 1),
    run(['install', 'neogone', '--json'], 1),
    run(['install', 'forge'], 0),
    run(['install', 'forgeold', '--json'], 0),
    run(['install', 'forgeold'], 0),
    run(['install', 'forgehost'], 1),
    run(['install', 'forgebad', '--json'], 1),
    run(['install', 'forgeancient'], 1),
    run(['install', 'forgenone'], 1),
    run(['launch', 'neo', '--as', 'Neo', '--wait', '--json'], 0, { env: { MCCTL_FAKE_CLIENT: '{repo}/test/fixtures/fake-client.mjs' } }),
    run(['stop', 'neo'], 0),
    run(['launch', 'forgeold', '--as', 'Old', '--wait'], 0, { env: { MCCTL_FAKE_CLIENT: '{repo}/test/fixtures/fake-client.mjs' } }),
    run(['stop', 'forgeold'], 0),
    { run: ['client', 'list', '--json'] },
  ],
}
fs.writeFileSync(path.join(here, 'scenarios', 'c7-client-forge.json'), JSON.stringify(scenario, null, 1) + '\n')
