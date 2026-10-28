import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-eras-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const { planInstall } = await import('../src/client-install.mjs')
const { buildCommand } = await import('../src/client-launch.mjs')
const { jvmArguments, gameArguments, loggingConfig } = await import('../src/client-meta.mjs')
const { offlineAccount } = await import('../src/client-auth.mjs')
const { DATA_ROOT } = await import('../src/paths.mjs')

// What each era's JSON says, as the plan's section 2.2 describes it. A fixture that disagrees
// means the plan (and the resolver built on it) is wrong about that era.
const FACTS = {
  'rd-132211': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: 'pre-1.6', logging: null, mainClass: 'com.mojang.rubydung.RubyDung' },
  'a1.2.6': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: 'pre-1.6', logging: null, mainClass: 'net.minecraft.launchwrapper.Launch' },
  'b1.7.3': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: 'pre-1.6', logging: null, mainClass: 'net.minecraft.launchwrapper.Launch' },
  '1.5.2': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: 'pre-1.6', logging: null, mainClass: 'net.minecraft.launchwrapper.Launch' },
  // the one era with no javaVersion at all: "absent means jre-legacy 8" is exercised by a real file
  '1.6.4': { java: null, form: 'minecraftArguments', index: 'legacy', logging: null, mainClass: 'net.minecraft.client.main.Main' },
  '1.7.2': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: 'legacy', logging: 'client-1.7.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.7.10': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: '1.7.10', logging: 'client-1.7.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.12.2': { java: ['jre-legacy', 8], form: 'minecraftArguments', index: '1.12', logging: 'client-1.12.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.14.4': { java: ['jre-legacy', 8], form: 'arguments', index: '1.14', logging: 'client-1.12.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.16.5': { java: ['jre-legacy', 8], form: 'arguments', index: '1.16', logging: 'client-1.12.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.17.1': { java: ['java-runtime-alpha', 16], form: 'arguments', index: '1.17', logging: 'client-1.12.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.18.2': { java: ['java-runtime-beta', 17], form: 'arguments', index: '1.18', logging: 'client-1.12.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.20.4': { java: ['java-runtime-gamma', 17], form: 'arguments', index: '12', logging: 'client-1.12.xml', mainClass: 'net.minecraft.client.main.Main' },
  '1.21.11': { java: ['java-runtime-delta', 21], form: 'arguments', index: '29', logging: 'client-1.21.2.xml', mainClass: 'net.minecraft.client.main.Main' },
  '26.1': { java: ['java-runtime-epsilon', 25], form: 'arguments', index: '30', logging: 'client-1.21.2.xml', mainClass: 'net.minecraft.client.main.Main' },
  '26.3': { java: ['java-runtime-epsilon', 25], form: 'arguments', index: '34', logging: 'client-1.21.2.xml', mainClass: 'net.minecraft.client.main.Main' },
  '26.4-snapshot-6': { java: ['java-runtime-epsilon', 25], form: 'arguments', index: '36', logging: 'client-1.21.2.xml', mainClass: 'net.minecraft.client.main.Main' },
}

test('every era has a fixture and a line of facts, and the facts hold', () => {
  assert.deepEqual(Object.keys(FACTS), F.ERA_IDS)
  for (const id of F.ERA_IDS) {
    const v = F.loadVersion(id)
    const facts = FACTS[id]
    assert.equal(v.id, id)
    assert.deepEqual(v.javaVersion ? [v.javaVersion.component, v.javaVersion.majorVersion] : null, facts.java, `${id}: javaVersion`)
    assert.equal(v.arguments ? 'arguments' : 'minecraftArguments', facts.form, `${id}: argument form`)
    assert.equal(v.assetIndex.id, facts.index, `${id}: asset index`)
    assert.equal(v.logging?.client?.file?.id ?? null, facts.logging, `${id}: logging config`)
    assert.equal(v.mainClass, facts.mainClass, `${id}: mainClass`)
    // the format number has not moved since 1.13, which is why it is a weak signal (plan N1)
    assert.ok(v.minimumLauncherVersion <= 21, `${id}: minimumLauncherVersion ${v.minimumLauncherVersion}`)
  }
})

test('the variables each era uses are the ones buildCommand fills, plus the three legacy ones V1b adds', () => {
  const supplied = new Set([
    'classpath', 'classpath_separator', 'library_directory', 'natives_directory', 'game_directory', 'assets_root',
    'assets_index_name', 'version_name', 'version_type', 'launcher_name', 'launcher_version', 'auth_player_name',
    'auth_uuid', 'auth_access_token', 'clientid', 'auth_xuid', 'user_type', 'quickPlayMultiplayer', 'quickPlayPath',
  ])
  const legacy = { auth_session: [], game_assets: [], user_properties: [] }
  const os = { name: 'windows', arch: 'x64', version: '10.0.22631' }
  for (const id of F.ERA_IDS) {
    const v = F.loadVersion(id)
    const args = [...jvmArguments(v, { os }), ...gameArguments(v, { os })]
    for (const a of args) {
      for (const [, name] of a.matchAll(/\$\{(\w+)\}/g)) {
        if (supplied.has(name)) continue
        assert.ok(Object.hasOwn(legacy, name), `${id}: \${${name}} is neither supplied nor one of the legacy three`)
        if (!legacy[name].includes(id)) legacy[name].push(id)
      }
    }
  }
  // section 2.2: --session through 1.6.x, ${game_assets} up to 1.7.2, ${user_properties} on 1.7.10 (and 1.8.9)
  assert.deepEqual(legacy, {
    auth_session: ['rd-132211', 'a1.2.6', 'b1.7.3', '1.5.2', '1.6.4'],
    game_assets: ['a1.2.6', 'b1.7.3', '1.5.2', '1.6.4', '1.7.2'],
    user_properties: ['1.7.10'],
  })
})

test('the eras manifest holds every era and the odd id shapes, with Mojang\'s four types', () => {
  const manifest = F.loadErasManifest()
  const ids = manifest.versions.map((v) => v.id)
  for (const id of [...F.ERA_IDS, '1.21.11-rc3', '25w46a', '3D Shareware v1.34', '1.RV-Pre1', '1.14.2 Pre-Release 4']) {
    assert.ok(ids.includes(id), `${id} in the manifest`)
  }
  assert.deepEqual([...new Set(manifest.versions.map((v) => v.type))].sort(), ['old_alpha', 'old_beta', 'release', 'snapshot'])
})

test('Fabric fixtures: the profiles merge onto their parents and keep Fabric\'s main class', () => {
  for (const mc of Object.keys(F.FABRIC_PROFILES)) {
    const merged = F.loadFabricMerged(mc)
    assert.equal(merged.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient', mc)
    assert.equal(merged.assetIndex.id, F.loadVersion(mc).assetIndex.id, mc)
    // the child has no javaVersion of its own; the merge carries the parent's
    assert.deepEqual(merged.javaVersion, F.loadVersion(mc).javaVersion, mc)
    assert.ok(merged.libraries.some((l) => l.name === `net.fabricmc:intermediary:${mc}`), mc)
  }
})

test('future.json carries one of each thing SpawnLoft cannot know yet', () => {
  const v = F.loadFuture()
  assert.equal(v.id, '27.1')
  assert.equal(v.minimumLauncherVersion, 22)
  const raw = JSON.stringify(v.arguments)
  assert.ok(raw.includes('${render_backend}'))
  assert.ok(raw.includes('"kernel"'))
  assert.ok(v.arguments.jvm.some((a) => a.rules?.some((r) => r.os?.name === 'osx' && r.os.versionRange)))
  assert.ok(v.arguments.jvm.includes('-Djava.library.path=${natives_directory}/native/libs'))
  assert.equal(F.loadAssetIndex('future-pack').layout, 'pack')
})

test('asset index fixtures: one per layout Mojang has used, and a bad path', () => {
  assert.equal(F.loadAssetIndex('legacy').virtual, true)
  assert.equal(F.loadAssetIndex('pre-1.6').map_to_resources, true)
  const objects = F.loadAssetIndex('objects')
  assert.ok(!('virtual' in objects) && !('map_to_resources' in objects))
  assert.ok(Object.keys(F.loadAssetIndex('bad').objects).includes('../x'))
})

// Every URL a library row may be fetched from, as the JSON names it: Mojang's downloads blocks,
// or a Maven base plus the coordinate path for Fabric's rows.
function namedUrls(version) {
  const urls = new Set()
  for (const lib of version.libraries ?? []) {
    if (lib.downloads?.artifact?.url) urls.add(lib.downloads.artifact.url)
    for (const cls of Object.values(lib.downloads?.classifiers ?? {})) urls.add(cls.url)
  }
  return urls
}

test('install plan, every era on every machine: only URLs the JSON names, one arch of natives', () => {
  for (const id of F.ERA_IDS) {
    const v = F.loadVersion(id)
    const named = namedUrls(v)
    for (const os of F.OS_PAIRS) {
      const where = `${id} on ${F.pairName(os)}`
      const plan = planInstall(v, { os })
      for (const row of plan.libraries) assert.ok(named.has(row.url), `${where}: ${row.url} is not in the JSON (B1)`)
      assert.equal(plan.client?.url, v.downloads.client.url, where)
      assert.equal(plan.assetIndex.id, v.assetIndex.id, where)
      assert.equal(plan.logConfig?.id ?? null, FACTS[id].logging, where)
      assert.equal(plan.nativesSubdir, ['26.3', '26.4-snapshot-6'].includes(id) ? 'java' : '', where)
      // a natives jar of another OS or another arch is never fetched as one of this machine's
      for (const row of plan.natives) {
        const cls = row.name.split(':')[3] ?? ''
        const osWord = os.name === 'osx' ? /natives-(osx|macos)/ : new RegExp(`natives-${os.name}`)
        assert.match(cls, osWord, `${where}: ${row.name}`)
        if (os.arch === 'arm64' && /-arm64$/.test(cls) === false) {
          // map-form versions (before 1.19) have only x64 natives: today they are planned anyway
          // and the game crashes on an arm64 Java; V1a turns this into x64 under emulation
          assert.ok(!v.libraries.some((l) => /natives-(macos|windows)-arm64$/.test(l.name)), `${where}: x64 natives taken although arm64 ones exist`)
        }
      }
    }
  }
})

test('install plan: the natives stay off the classpath list and every row is fetched once', () => {
  for (const id of F.ERA_IDS) {
    const plan = planInstall(F.loadVersion(id), { os: F.OS_PAIRS[0] })
    const paths = plan.libraries.map((r) => r.path)
    assert.equal(new Set(paths).size, paths.length, id)
    for (const row of plan.natives) assert.ok(paths.includes(row.path), `${id}: natives jar ${row.path} is downloaded`)
  }
})

// The 1.21.11 guard (plan 10.2): the full command line of 1.21.11, vanilla and Fabric, with and
// without a server, on every machine, as buildCommand produced it before the resolver existed.
// V1a must reproduce these byte for byte. Paths are written relative to the data root with forward
// slashes and the classpath as a list, so one file holds for Windows and Linux runners alike.
// Regenerate only on purpose: UPDATE_CLIENT_EXPECTATIONS=1 node --test test/client-eras.test.mjs
const EXPECTED_DIR = path.join(F.FIXTURE_DIR, 'expected')
const launcherVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function normalise(cmd) {
  const fix = (s) => s.split(DATA_ROOT).join('<data>').split(launcherVersion).join('<launcher-version>').replace(/\\/g, '/')
  const args = cmd.args.map((a, i) => (cmd.args[i - 1] === '-cp' ? a.split(path.delimiter).map(fix) : fix(a)))
  return { bin: cmd.bin, cwd: fix(cmd.cwd), args }
}

const VARIANTS = {
  vanilla: { fabric: false, address: null, harnessToken: null },
  'vanilla-server': { fabric: false, address: { host: '127.0.0.1', port: 25565 }, harnessToken: null },
  fabric: { fabric: true, address: null, harnessToken: null },
  'fabric-server-harness': { fabric: true, address: { host: 'play.example.net', port: 25570 }, harnessToken: '00112233445566778899aabbccddeeff' },
}

for (const [variant, opts] of Object.entries(VARIANTS)) {
  test(`1.21.11 guard: ${variant} command line on every machine is unchanged`, () => {
    const version = opts.fabric ? F.loadFabricMerged('1.21.11') : F.loadVersion('1.21.11')
    const profile = { mc: '1.21.11', loader: opts.fabric ? 'fabric' : 'vanilla', memory: '4G', server: null }
    const actual = {}
    for (const os of F.OS_PAIRS) {
      const cmd = buildCommand({ version, profile, profileName: 'guard', account: offlineAccount('alice'), java: '/opt/java/bin/java', os, harnessToken: opts.harnessToken, address: opts.address })
      actual[F.pairName(os)] = normalise(cmd)
    }
    const file = path.join(EXPECTED_DIR, `1.21.11-${variant}.json`)
    if (process.env.UPDATE_CLIENT_EXPECTATIONS === '1') {
      fs.mkdirSync(EXPECTED_DIR, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n')
    }
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(file, 'utf8')))
  })
}

test('1.21.11 guard: the expectation files carry the log config and no unfilled variable', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(EXPECTED_DIR, '1.21.11-vanilla.json'), 'utf8'))
  assert.deepEqual(Object.keys(expected), F.OS_PAIRS.map(F.pairName))
  for (const [pair, cmd] of Object.entries(expected)) {
    assert.ok(cmd.args.includes(`-Dlog4j.configurationFile=<data>/client/assets/log_configs/${loggingConfig(F.loadVersion('1.21.11')).id}`), pair)
    assert.ok(!JSON.stringify(cmd.args).includes('${'), pair)
  }
})
