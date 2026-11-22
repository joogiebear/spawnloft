// Writes scenarios/c7-client-install.json: `client install` over faked Mojang hosts.
//   node tools/parity/make-c7-install-scenario.mjs
// The fake host can name a checksum only of a body given as bytes, and a version JSON must carry
// the checksums of the files it lists, so the version JSONs, asset indexes and jars are made here
// and written into the scenario as base64. Change this script, never the scenario by hand.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const META = 'https://piston-meta.mojang.com'
const DATA = 'https://piston-data.mojang.com'
const LIBS = 'https://libraries.minecraft.net'
const RES = 'https://resources.download.minecraft.net'

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const hosts = { [META]: { routes: {} }, [DATA]: { routes: {} }, [LIBS]: { routes: {} }, [RES]: { routes: {} } }
const serve = (url, body) => {
  const u = new URL(url)
  hosts[u.origin].routes[`GET ${u.pathname}`] = { base64: Buffer.from(body).toString('base64') }
  return url
}

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

const filler = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251))

function artifact(p, body, { url = `${LIBS}/${p}`, sum = sha1(body) } = {}) {
  if (url) serve(url, body)
  return { path: p, url: url ?? '', sha1: sum, size: body.length }
}

function lib(name, body, extra = {}) {
  const [g, a, v, cls] = name.split(':')
  const p = `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${cls ? `-${cls}` : ''}.jar`
  return { name, downloads: { artifact: artifact(p, body) }, ...extra }
}

const nativesJar = (tag) => zip([
  ['META-INF/', null],
  ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\n'],
  [`lib${tag}.so`, filler(2000, tag.length), true],
  ['sub/', null],
  ['sub/notes.txt', `natives for ${tag}\n`],
])

function assetIndex(id, objects, flags = {}) {
  const index = { ...flags, objects: {} }
  for (const [name, body] of objects) {
    const h = sha1(body)
    serve(`${RES}/${h.slice(0, 2)}/${h}`, body)
    index.objects[name] = { hash: h, size: body.length }
  }
  const text = JSON.stringify(index)
  const url = serve(`${META}/v1/packages/${sha1(text)}/${id}.json`, text)
  return { id, sha1: sha1(text), size: Buffer.byteLength(text), totalSize: 1, url }
}

function clientJar(id) {
  const body = zip([['net/minecraft/client/main/Main.class', `class of ${id}`]])
  const h = sha1(body)
  return { sha1: h, size: body.length, url: serve(`${DATA}/v1/objects/${h}/client.jar`, body) }
}

const a1 = filler(3000, 1)
const a2 = filler(700, 2)
const modernIndex = assetIndex('5', [['minecraft/sounds/a.ogg', a1], ['icons/icon.png', a2], ['minecraft/sounds/same.ogg', a1]])
const logBody = '<Configuration><Appenders/></Configuration>\n'
const logSum = sha1(logBody)
serve(`${DATA}/v1/objects/${logSum}/client-1.12.xml`, logBody)

const lwjgl = (cls, os) => lib(`org.lwjgl:lwjgl:3.3.1:${cls}`, nativesJar(cls), { rules: [{ action: 'allow', os: { name: os } }] })
const versions = {
  '1.20.1': {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    arguments: { game: ['--username', '${auth_player_name}'], jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'] },
    assetIndex: modernIndex,
    assets: '5',
    downloads: { client: clientJar('1.20.1') },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.12.xml', sha1: logSum, size: logBody.length, url: `${DATA}/v1/objects/${logSum}/client-1.12.xml` }, type: 'log4j2-xml' } },
    libraries: [
      lib('com.example:alpha:1.0', filler(1500, 3)),
      lib('com.example:alpha:1.0', filler(1500, 3)),
      lib('com.example:beta:2.0', filler(900, 4)),
      lib('com.example:never:1.0', filler(10, 5), { rules: [{ action: 'allow', os: { name: 'nowhere' } }] }),
      lwjgl('natives-linux', 'linux'),
      lwjgl('natives-macos', 'osx'),
      lwjgl('natives-macos-arm64', 'osx'),
      lwjgl('natives-windows', 'windows'),
      lwjgl('natives-windows-arm64', 'windows'),
      lwjgl('natives-windows-x86', 'windows'),
    ],
  },
  '1.6.4': {
    id: '1.6.4', type: 'release', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name}',
    assetIndex: assetIndex('legacy', [['sound/step/grass1.ogg', filler(400, 6)], ['music/calm1.ogg', a1]], { virtual: true }),
    downloads: { client: clientJar('1.6.4') },
    libraries: [lib('net.sf.jopt-simple:jopt-simple:4.5', filler(300, 7))],
  },
  '1.5.2': {
    id: '1.5.2', type: 'release', mainClass: 'net.minecraft.client.Minecraft', minecraftArguments: '${auth_player_name}',
    assetIndex: assetIndex('pre-1.6', [['sound/random/click.ogg', filler(200, 8)]], { map_to_resources: true }),
    downloads: { client: clientJar('1.5.2') },
    libraries: [],
  },
  '1.12.2': {
    id: '1.12.2', type: 'release', mainClass: 'net.minecraft.client.main.Main', minecraftArguments: '--username ${auth_player_name}',
    assetIndex: assetIndex('1.12', [['minecraft/lang/en_us.lang', filler(120, 9)]]),
    downloads: { client: clientJar('1.12.2') },
    libraries: [
      (() => {
        const name = 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4'
        const base = 'org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4'
        const classifiers = {}
        for (const c of ['natives-linux', 'natives-osx', 'natives-windows']) classifiers[c] = artifact(`${base}-${c}.jar`, nativesJar(c))
        return { name, downloads: { classifiers }, natives: { linux: 'natives-linux', osx: 'natives-osx', windows: 'natives-windows' }, extract: { exclude: ['META-INF/', 'sub/'] } }
      })(),
    ],
  },
  'odd-layout': {
    id: 'odd-layout', type: 'snapshot', assetIndex: assetIndex('odd', [['x.ogg', filler(50, 10)]], { spread: true }),
    downloads: { client: clientJar('odd-layout') }, libraries: [],
  },
  'escape': {
    id: 'escape', type: 'snapshot', assetIndex: assetIndex('escape', [['../outside.ogg', filler(60, 11)]], { virtual: true }),
    downloads: { client: clientJar('escape') }, libraries: [],
  },
  'lib-missing': {
    id: 'lib-missing', type: 'snapshot', assetIndex: assetIndex('empty', []),
    libraries: [{ name: 'com.example:gone:1.0', downloads: { artifact: { path: 'com/example/gone/1.0/gone-1.0.jar', url: `${LIBS}/com/example/gone/1.0/gone-1.0.jar`, sha1: sha1('gone'), size: 4 } } }],
  },
  'lib-bad-sum': {
    id: 'lib-bad-sum', type: 'snapshot', assetIndex: assetIndex('empty', []),
    libraries: [{ name: 'com.example:bent:1.0', downloads: { artifact: artifact('com/example/bent/1.0/bent-1.0.jar', filler(80, 12), { sum: '0'.repeat(40) }) } }],
  },
  // eight workers start together: the first library refused, the next seven are still fetched
  'many-made': {
    id: 'many-made', type: 'snapshot', assetIndex: assetIndex('empty', []),
    libraries: [
      { name: 'com.many:l0:1.0', downloads: { artifact: { path: 'com/many/l0/1.0/l0-1.0.jar', url: '', sha1: sha1('l0'), size: 2 } } },
      ...Array.from({ length: 11 }, (_, i) => lib(`com.many:l${i + 1}:1.0`, filler(100 + i, 20 + i))),
    ],
  },
  'hostile-natives': {
    id: 'hostile-natives', type: 'snapshot', assetIndex: assetIndex('empty', []),
    libraries: ['linux', 'osx', 'windows'].map((os) => lib(`org.evil:natives:1.0:natives-${os === 'osx' ? 'macos-arm64' : os}`, zip([['ok.so', 'fine'], ['../../escaped.so', 'bad']]), { rules: [{ action: 'allow', os: { name: os } }] })),
  },
  'loader-made': {
    id: 'loader-made', type: 'snapshot', assetIndex: assetIndex('empty', []),
    libraries: [{ name: 'com.example:made:1.0', downloads: { artifact: { path: 'com/example/made/1.0/made-1.0.jar', url: '', sha1: sha1('made'), size: 4 } } }],
  },
}

const manifestRows = []
for (const [id, v] of Object.entries(versions)) {
  const text = JSON.stringify(v)
  const url = serve(`${META}/v1/packages/${sha1(text)}/${id}.json`, text)
  // 1.5.2's row names no checksum, as some third-party lists do: fetched without a check
  manifestRows.push(id === '1.5.2' ? { id, type: v.type, url } : { id, type: v.type, url, sha1: `\${sha1:${url}}` })
}
hosts[META].routes['GET /mc/game/version_manifest_v2.json'] = { json: { latest: { release: '1.20.1', snapshot: 'escape' }, versions: manifestRows } }

const profile = (mc, loader = 'vanilla') => ({ mc, loader, loaderVersion: null, memory: '2G', java: null, server: null, harness: false, account: null })
const profiles = { m: profile('1.20.1'), old: profile('1.6.4'), res: profile('1.5.2'), lwjgl2: profile('1.12.2'), odd: profile('odd-layout'), esc: profile('escape'), gone: profile('lib-missing'), bent: profile('lib-bad-sum'), made: profile('loader-made'), many: profile('many-made'), hostile: profile('hostile-natives'), unlisted: profile('9.9.9'), fab: profile('1.20.1', 'fabric') }

const run = (args, code, more = {}) => ({ run: ['client', ...args], ...(code === null ? {} : { expect: { code } }), ...more })
const scenario = {
  about: 'C7 part 3b: client install over faked Mojang hosts (made by make-c7-install-scenario.mjs). A modern version with its jar, log config, asset index, duplicate libraries and assets, and natives for every OS and arch (extracted without META-INF), installed again from the checked-files list, a damaged library fetched again, natives extracted again after their stamp goes, --verify; the virtual and resources asset layouts; an LWJGL 2 version with old-style natives and excludes (Linux arm64 and the arm64 Mac refuse it); an unknown layout, an index path that leaves its folder, a missing library, a checksum mismatch, a library only a loader makes (alone, and first of twelve, when the other seven workers still fetch theirs), a natives jar with an entry that leaves its folder, a version not in the list, an unknown profile, usage errors, and a Fabric profile with no Fabric host faked.',
  platforms: ['linux-x64', 'darwin', 'win32'],
  hosts,
  normalize: [
    { pattern: '^1[5-9]\\d{11}$', replace: '<epoch-ms>' },
    // the libraries and assets phases print while workers finish, every 250 ms; the last line of
    // each and the totals in the result are what both cores must agree on
    { pattern: '(?:(?:libraries|assets) \\d+/\\d+ \\([^)\\n]*\\)\\n)+', replace: '<progress>\n' },
  ],
  // the checked-files list holds each file's modification time, and its lines come in the order
  // the downloads finished
  ignore: ['data/client/cache/verified.json'],
  steps: [
    { write: 'data/client/profiles.json', json: { version: 1, profiles, defaultAccount: null } },
    run(['install', 'm'], 0),
    run(['install', 'm', '--json'], 0),
    { write: 'data/client/libraries/com/example/beta/2.0/beta-2.0.jar', text: 'damaged' },
    run(['install', 'm'], 0),
    { remove: 'data/client/natives/1.20.1/.complete' },
    run(['install', 'm', '--json'], 0),
    run(['install', 'm', '--verify', '--json'], 0),
    run(['install', 'old', '--json'], 0),
    run(['install', 'res'], 0),
    run(['install', 'lwjgl2', '--json'], null),
    run(['install', 'odd'], 1),
    run(['install', 'esc', '--json'], 1),
    run(['install', 'gone'], 1),
    run(['install', 'bent', '--json'], 1),
    run(['install', 'made'], 1),
    run(['install', 'many', '--json'], 1),
    run(['install', 'hostile', '--json'], 1),
    run(['install', 'unlisted'], 1),
    run(['install', 'nosuch'], 1),
    run(['install', 'fab'], 1),
    run(['install'], 2),
    run(['install', 'm', 'extra'], 2),
    run(['install', 'm', '--bogus'], 2),
  ],
}
fs.writeFileSync(path.join(here, 'scenarios', 'c7-client-install.json'), JSON.stringify(scenario, null, 1) + '\n')
