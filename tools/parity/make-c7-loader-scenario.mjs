// Writes scenarios/c7-client-loaders.json: `client install` and `client launch` of Fabric and
// Quilt profiles over faked Mojang, Fabric and Quilt hosts.
//   node tools/parity/make-c7-loader-scenario.mjs
// A loader profile's libraries carry (or are checked against) the checksums of their bodies, which
// the fake host can only name for a body given as bytes, so everything is made here and written
// into the scenario as base64. Change this script, never the scenario by hand.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const META = 'https://piston-meta.mojang.com'
const DATA = 'https://piston-data.mojang.com'
const LIBS = 'https://libraries.minecraft.net'
const FMETA = 'https://meta.fabricmc.net'
const FMAVEN = 'https://maven.fabricmc.net'
const QMETA = 'https://meta.quiltmc.org'
const QMAVEN = 'https://maven.quiltmc.org'

const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex')
const hosts = Object.fromEntries([META, DATA, LIBS, FMETA, FMAVEN, QMETA, QMAVEN].map((o) => [o, { routes: {} }]))
const serve = (url, body) => {
  const u = new URL(url)
  hosts[u.origin].routes[`GET ${u.pathname}`] = { base64: Buffer.from(body).toString('base64') }
  return url
}
const json = (url, value) => {
  const u = new URL(url)
  hosts[u.origin].routes[`GET ${u.pathname}`] = { json: value }
}
const filler = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + seed) % 251))
const mavenPath = (name) => {
  const [g, a, v] = name.split(':')
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}.jar`
}

// the vanilla versions the loaders build on
const emptyIndex = (() => {
  const text = JSON.stringify({ objects: {} })
  return { id: 'empty', sha1: sha1(text), size: text.length, totalSize: 0, url: serve(`${META}/v1/packages/${sha1(text)}/empty.json`, text) }
})()
const clientJar = (id) => {
  const body = filler(500, id.length)
  return { sha1: sha1(body), size: body.length, url: serve(`${DATA}/v1/objects/${sha1(body)}/client.jar`, body) }
}
const vlib = (name, body) => ({ name, downloads: { artifact: { path: mavenPath(name), url: serve(`${LIBS}/${mavenPath(name)}`, body), sha1: sha1(body), size: body.length } } })
const vanilla = (id, type) => ({
  id, type, mainClass: 'net.minecraft.client.main.Main',
  javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
  arguments: { game: ['--username', '${auth_player_name}', '--version', '${version_name}'], jvm: ['-cp', '${classpath}'] },
  assetIndex: emptyIndex, assets: 'empty', downloads: { client: clientJar(id) },
  libraries: [vlib('com.example:shared:1.0', filler(300, 1))],
})
const versions = { '1.20.1': vanilla('1.20.1', 'release'), '24w01a': vanilla('24w01a', 'snapshot'), '1.12.2': vanilla('1.12.2', 'release') }
const rows = []
for (const [id, v] of Object.entries(versions)) {
  const text = JSON.stringify(v)
  const url = serve(`${META}/v1/packages/${sha1(text)}/${id}.json`, text)
  rows.push({ id, type: v.type, url, sha1: `\${sha1:${url}}` })
}
json(`${META}/mc/game/version_manifest_v2.json`, { latest: { release: '1.20.1', snapshot: '24w01a' }, versions: rows })

// Fabric: the meta names each library's checksum
const flib = (name, body) => {
  serve(`${FMAVEN}/${mavenPath(name)}`, body)
  return { name, url: `${FMAVEN}/`, sha1: sha1(body), size: body.length }
}
const fabricProfile = (build, mc, more = {}) => ({
  id: `fabric-loader-${build}-${mc}`, inheritsFrom: mc, type: 'release',
  mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
  libraries: [flib(`net.fabricmc:fabric-loader:${build}`, filler(800, build.length + 3)), flib('net.fabricmc:intermediary:1.20.1', filler(400, 9))],
  ...more,
})
json(`${FMETA}/v2/versions/game`, [{ version: '1.20.1', stable: true }, { version: '1.12.2-not', stable: true }])
json(`${FMETA}/v2/versions/loader/1.20.1`, [
  { loader: { separator: '.', build: 17, maven: 'net.fabricmc:fabric-loader:0.16.0-beta.1', version: '0.16.0-beta.1', stable: false } },
  { loader: { separator: '.', build: 16, maven: 'net.fabricmc:fabric-loader:0.15.11', version: '0.15.11', stable: true } },
  { loader: { separator: '.', build: 15, maven: 'net.fabricmc:fabric-loader:0.14.0', version: '0.14.0', stable: true } },
])
const fprofile = (build, value) => json(`${FMETA}/v2/versions/loader/1.20.1/${build}/profile/json`, value)
fprofile('0.15.11', fabricProfile('0.15.11', '1.20.1'))
fprofile('0.14.0', fabricProfile('0.14.0', '1.20.1'))
fprofile('0.13.0', fabricProfile('0.13.1', '1.20.1'))
fprofile('0.12.0', fabricProfile('0.12.0', '1.20.1', { inheritsFrom: '1.19.4' }))
// a profile whose library's body does not match the checksum it names
fprofile('0.11.0', { ...fabricProfile('0.11.0', '1.20.1'), libraries: [{ ...flib('net.fabricmc:bent:1.0', filler(50, 4)), sha1: '0'.repeat(40) }] })

// Quilt: the meta names no checksums; they come from the .sha1 file beside each library
const QREL = `${QMAVEN}/repository/release/`
const qlib = (name, body, { base = QREL, sum = sha1(body), sumBody = `${sum}\n`, given = false } = {}) => {
  const url = `${base}${mavenPath(name)}`
  serve(url, body)
  serve(`${url}.sha1`, sumBody)
  return { name, ...(base === `${LIBS}/` ? {} : { url: base.replace(/\/$/, '') }), ...(given ? { sha1: sum } : {}) }
}
const quiltProfile = (build, mc, libraries) => ({
  id: `quilt-loader-${build}-${mc}`, inheritsFrom: mc, type: 'release',
  mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
  arguments: { game: [] },
  libraries,
})
json(`${QMETA}/v3/versions/game`, [{ version: '1.20.1', stable: true }])
// served out of order, as Quilt's meta does
json(`${QMETA}/v3/versions/loader/1.20.1`, [
  { loader: { version: '0.25.0' } },
  { loader: { version: '0.26.0-beta.2' } },
  { loader: { version: '0.26.0' } },
  { loader: { version: '0.26.0-beta.10' } },
  { loader: { version: '0.24.0' } },
])
const qprofile = (build, libraries, id = build) => json(`${QMETA}/v3/versions/loader/1.20.1/${build}/profile/json`, quiltProfile(id, '1.20.1', libraries))
qprofile('0.26.0', [
  qlib('org.quiltmc:quilt-loader:0.26.0', filler(700, 21)),
  // a checksum file with the file name after it, in capitals
  qlib('org.quiltmc:hashed:1.0', filler(200, 22), { sumBody: `${sha1(filler(200, 22)).toUpperCase()}  hashed-1.0.jar\n` }),
  // a library that names its checksum is not asked about
  qlib('org.quiltmc:named:1.0', filler(210, 23), { given: true }),
  // one from Fabric's maven, and one with no url (Mojang's)
  qlib('net.fabricmc:intermediary:1.20.1', filler(400, 9), { base: `${FMAVEN}/` }),
  qlib('org.ow2.asm:asm:9.6', filler(150, 24), { base: `${LIBS}/` }),
])
// the libraries after the refused one are still checked, and their checksums asked for
qprofile('0.25.0', [qlib('org.quiltmc:quilt-loader:0.25.0', filler(690, 25)), { name: 'org.evil:mod:1.0', url: 'https://evil.example.com/maven' }, qlib('org.quiltmc:after:1.0', filler(95, 28))])
qprofile('0.24.0', [{ name: 'org.quiltmc:shaped:1.0', downloads: { artifact: {} } }])
qprofile('0.26.0-beta.2', [qlib('org.quiltmc:nosum:1.0', filler(100, 26), { sumBody: 'not a checksum\n' })])
qprofile('0.26.0-beta.10', [qlib('org.quiltmc:quilt-loader:0.26.0-beta.10', filler(100, 27))], '0.26.0-beta.9')

const profile = (mc, loader, loaderVersion = null) => ({ mc, loader, loaderVersion, memory: '2G', java: null, server: null, harness: false, account: null })
const profiles = {
  fab: profile('1.20.1', 'fabric'),
  fabpin: profile('1.20.1', 'fabric', '0.14.0'),
  fabid: profile('1.20.1', 'fabric', '0.13.0'),
  fabparent: profile('1.20.1', 'fabric', '0.12.0'),
  fabbent: profile('1.20.1', 'fabric', '0.11.0'),
  fabgone: profile('1.20.1', 'fabric', '0.10.0'),
  fabunknown: profile('1.20.1', 'fabric', '0.9.9'),
  fabsnap: profile('24w01a', 'fabric'),
  fabold: profile('1.12.2', 'fabric'),
  qui: profile('1.20.1', 'quilt'),
  quihost: profile('1.20.1', 'quilt', '0.25.0'),
  quishape: profile('1.20.1', 'quilt', '0.24.0'),
  quisum: profile('1.20.1', 'quilt', '0.26.0-beta.2'),
  quiid: profile('1.20.1', 'quilt', '0.26.0-beta.10'),
  quisnap: profile('24w01a', 'quilt'),
  quiold: profile('1.12.2', 'quilt'),
  // launched only: one with no build pinned, one whose build is fetched by the launch
  lnull: profile('1.20.1', 'fabric'),
  lpin: profile('1.20.1', 'quilt', '0.26.0'),
}

const fake = { MCCTL_FAKE_CLIENT: '{repo}/test/fixtures/fake-client.mjs' }
const run = (args, code, more = {}) => ({ run: ['client', ...args], ...(code === null ? {} : { expect: { code } }), ...more })
const launch = (args, code, more = {}) => run(['launch', ...args], code, { env: fake, ...more })
const scenario = {
  about: 'C7 part 4a: Fabric and Quilt profiles (made by make-c7-loader-scenario.mjs). Install picks the stable Fabric build and pins it, a pinned build, a meta answering for another build or another game version, a library whose checksum does not match, a build the meta lacks, a snapshot and an old release Fabric does not build for; Quilt picks the newest build that is not a beta from a list out of order, fills each checksum from the .sha1 beside the library (with a file name after it, in capitals, named already, from Fabric\'s maven and from Mojang\'s), and refuses a library on another host, one in a shape it does not know, a checksum file that holds none and an id that does not match; installed again from what is on disk; and the fake game launched on a loader profile (Fabric API is not fetched for it), with no build pinned, and with a build the launch fetches.',
  platforms: ['linux-x64', 'darwin', 'win32'],
  env: { NODE_ENV: 'test' },
  hosts,
  normalize: [
    { pattern: '^1[5-9]\\d{11}$', replace: '<epoch-ms>' },
    // the game's start time, in the kernel's clock ticks
    { pattern: '"procStart":( ?)"\\d+"', replace: '"procStart":$1"<t>"' },
    { pattern: '(?:(?:libraries|assets) \\d+/\\d+ \\([^)\\n]*\\)\\n)+', replace: '<progress>\n' },
  ],
  ignore: ['data/client/cache/verified.json', 'data/client/logs/**'],
  steps: [
    { write: 'data/client/profiles.json', json: { version: 1, profiles, defaultAccount: null } },
    run(['install', 'fab'], 0),
    run(['install', 'fab', '--json'], 0),
    run(['install', 'fabpin', '--json'], 0),
    run(['install', 'fabid'], 1),
    run(['install', 'fabparent', '--json'], 1),
    run(['install', 'fabbent'], 1),
    run(['install', 'fabgone', '--json'], 1),
    run(['install', 'fabunknown'], 1),
    run(['install', 'fabsnap'], 1),
    run(['install', 'fabold', '--json'], 1),
    run(['install', 'qui'], 0),
    run(['install', 'qui', '--verify', '--json'], 0),
    run(['install', 'quihost'], 1),
    run(['install', 'quishape', '--json'], 1),
    run(['install', 'quisum'], 1),
    run(['install', 'quiid', '--json'], 1),
    run(['install', 'quisnap'], 1),
    run(['install', 'quiold'], 1),
    { remove: 'data/client/versions/fabric-loader-0.15.11-1.20.1/fabric-loader-0.15.11-1.20.1.json' },
    { write: 'data/client/versions/quilt-loader-0.26.0-1.20.1/quilt-loader-0.26.0-1.20.1.json', text: '{"id":"quilt-loa' },
    run(['install', 'fab', '--json'], 0),
    run(['install', 'qui', '--json'], 0),
    launch(['lnull'], 1),
    launch(['fab', '--as', 'Fabby', '--wait', '--json'], 0),
    launch(['lpin', '--as', 'Quilty', '--wait'], 0),
    { run: ['client', 'list', '--json'] },
  ],
}
fs.writeFileSync(path.join(here, 'scenarios', 'c7-client-loaders.json'), JSON.stringify(scenario, null, 1) + '\n')
