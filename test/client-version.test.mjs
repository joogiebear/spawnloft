import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-version-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const { resolveVersion, resolvedRefusal, javaRequirement, collectVariables, launchFeatures, LAUNCH_VARIABLES, isSafeVersionId, versionKind } = await import('../src/client-version.mjs')
const { ruleAllows, ruleProblems, archDecision, nativeArches, mergeInherited } = await import('../src/client-meta.mjs')
const { chooseClientJava, pickClientJava, parseArch } = await import('../src/java.mjs')
const { launch, createProfile } = await import('../src/client.mjs')
const { versionDir, versionJson } = await import('../src/client-paths.mjs')
const { platformRefusal } = await import('../src/client-meta.mjs')

// Before the first test(): a top-level await between tests lets the ones above it finish and the
// file's after() remove scratch before the ones below it run (review V1b S-1).
const realJava = await import('../src/java.mjs').then((m) => m.probe('java'))

const pair = (name, arch) => F.OS_PAIRS.find((o) => o.name === name && o.arch === arch)
const codes = (r) => r.problems.map((p) => p.code)

// The Java each era asks for, read from its own JSON (plan 4.1): the component and major, and
// the bounds and preferred major that pick an installed Java.
const JAVA = {
  'rd-132211': [8, 'jre-legacy', 8, 8, 8],
  'a1.2.6': [8, 'jre-legacy', 8, 8, 8],
  'b1.7.3': [8, 'jre-legacy', 8, 8, 8],
  '1.5.2': [8, 'jre-legacy', 8, 8, 8],
  '1.6.4': [8, 'jre-legacy', 8, 8, 8],
  '1.7.2': [8, 'jre-legacy', 8, 8, 8],
  '1.7.10': [8, 'jre-legacy', 8, 8, 8],
  '1.12.2': [8, 'jre-legacy', 8, 8, 8],
  '1.14.4': [8, 'jre-legacy', 8, 17, 8],
  '1.16.5': [8, 'jre-legacy', 8, 17, 8],
  '1.17.1': [16, 'java-runtime-alpha', 16, null, 17],
  '1.18.2': [17, 'java-runtime-beta', 17, null, 17],
  '1.20.4': [17, 'java-runtime-gamma', 17, null, 17],
  '1.21.11': [21, 'java-runtime-delta', 21, null, 21],
  '26.1': [25, 'java-runtime-epsilon', 25, null, 25],
  '26.3': [25, 'java-runtime-epsilon', 25, null, 25],
  '26.4-snapshot-6': [25, 'java-runtime-epsilon', 25, null, 25],
}

const MAP_FORM = ['rd-132211', 'a1.2.6', 'b1.7.3', '1.5.2', '1.6.4', '1.7.2', '1.7.10', '1.12.2', '1.14.4', '1.16.5', '1.17.1', '1.18.2']

test('resolver: the Java of every era comes from its JSON', () => {
  for (const id of F.ERA_IDS) {
    const { major, component, min, max, prefer } = resolveVersion(F.loadVersion(id), { os: pair('linux', 'x64') }).java
    assert.deepEqual([major, component, min, max, prefer], JAVA[id], id)
  }
})

test('resolver: a Fabric profile resolves through its parent, never as Java 8', () => {
  const child = F.loadFabricProfile('1.21.11')
  assert.equal(javaRequirement(child).major, 8, 'the child alone has no javaVersion')
  for (const mc of Object.keys(F.FABRIC_PROFILES)) {
    const r = resolveVersion(F.loadFabricMerged(mc), { os: pair('windows', 'x64') })
    assert.deepEqual(r.java, resolveVersion(F.loadVersion(mc), { os: pair('windows', 'x64') }).java, mc)
    assert.deepEqual(r.problems, [], mc)
  }
})

test('resolver: every era on every machine, with and without x64 emulation', () => {
  for (const id of F.ERA_IDS) {
    const v = F.loadVersion(id)
    for (const os of F.OS_PAIRS) {
      for (const x64 of [true, false]) {
        const where = `${id} on ${F.pairName(os)}, x64 ${x64}`
        const r = resolveVersion(v, { os, hostCaps: { x64 } })
        const expected = []
        let arch = os.arch
        if (os.name === 'linux' && os.arch === 'arm64') {
          expected.push('no-natives-for-this-machine')
        } else if (os.arch === 'arm64' && MAP_FORM.includes(id)) {
          if (x64) arch = 'x64'
          else expected.push('no-natives-for-this-machine')
        } else if (os.name === 'windows' && os.arch === 'x86' && ['26.3', '26.4-snapshot-6'].includes(id)) {
          expected.push('no-natives-for-this-machine')
        }
        assert.deepEqual(codes(r), expected, where)
        assert.equal(r.arch, arch, where)
        assert.equal(r.emulated, arch !== os.arch, where)
        assert.equal(r.os.arch, arch, where)
        // no real JSON has a rule SpawnLoft cannot read: the osx os.version regexes on every
        // pre-1.7 LWJGL row are understood, and never match a Darwin version (review R1)
        assert.ok(!codes(r).includes('unknown-rule-key'), where)
        assert.equal(r.format.ok, true, where)
        // natives follow the arch the game runs as
        if (r.emulated) assert.ok(r.natives.rows.every((n) => !/arm64/.test(n.name)), where)
      }
    }
  }
})

test('resolver: emulated x64 takes the x64 natives, the arm64 Java is not wanted', () => {
  const r = resolveVersion(F.loadVersion('1.16.5'), { os: pair('osx', 'arm64'), hostCaps: { x64: true } })
  assert.equal(r.arch, 'x64')
  assert.ok(r.natives.rows.some((n) => n.name.endsWith(':natives-macos') || n.name.endsWith(':natives-osx')), r.natives.rows.map((n) => n.name).join(' '))
  const native = resolveVersion(F.loadVersion('1.20.4'), { os: pair('osx', 'arm64'), hostCaps: { x64: true } })
  assert.equal(native.arch, 'arm64', '1.19+ runs natively even when Rosetta is there')
  assert.equal(native.emulated, false)
})

test('resolver: the variables after rules are all known, with every launch feature on too', () => {
  const allOn = { ...launchFeatures({ hasServer: true }), has_custom_resolution: true, is_quick_play_singleplayer: true, is_quick_play_realms: true }
  // the minecraftArguments era's auth_session, game_assets and user_properties included (V1b)
  for (const id of F.ERA_IDS) {
    for (const features of [launchFeatures(), launchFeatures({ hasServer: true }), allOn]) {
      const r = resolveVersion(F.loadVersion(id), { os: pair('windows', 'x64'), features })
      for (const v of r.variables) assert.ok(LAUNCH_VARIABLES.includes(v), `${id}: \${${v}}`)
    }
  }
  // gated variables are not seen on a normal launch
  const plain = resolveVersion(F.loadVersion('1.21.11'), { os: pair('windows', 'x64') })
  assert.ok(!plain.variables.includes('resolution_width'))
  assert.ok(resolveVersion(F.loadVersion('1.21.11'), { os: pair('windows', 'x64'), features: allOn }).variables.includes('resolution_width'))
})

test('resolver: future.json is refused for exactly what SpawnLoft does not know', () => {
  const future = F.loadFuture()
  const win = resolveVersion(future, { os: pair('windows', 'x64') })
  assert.deepEqual(codes(win), ['unknown-rule-key', 'unknown-variable', 'newer-launcher-format'])
  assert.equal(win.problems[0].message, 'Minecraft 27.1 uses a platform rule SpawnLoft does not know ("os.kernel"). Update SpawnLoft.')
  assert.equal(win.problems[1].message, 'Minecraft 27.1 uses a launcher setting SpawnLoft does not know (${render_backend}). Update SpawnLoft.')
  assert.equal(win.problems[2].message, 'Minecraft 27.1 needs launcher format 22; this SpawnLoft knows 21. Update SpawnLoft.')
  // a range for every OS is judged against Darwin on a Mac, so it is a problem there too
  assert.deepEqual(ruleProblems([{ action: 'allow', os: { versionRange: { min: '14.0' } } }], { os: pair('osx', 'arm64') }), ['"os.versionRange" on macOS'])
  assert.deepEqual(ruleProblems([{ action: 'allow', os: { versionRange: { min: '10.0' } } }], { os: pair('windows', 'x64') }), [])
  // the osx versionRange is a problem on a Mac only
  const mac = resolveVersion(future, { os: pair('osx', 'arm64') })
  assert.equal(mac.problems[0].message, 'Minecraft 27.1 uses a platform rule SpawnLoft does not know ("os.versionRange" on macOS, "os.kernel"). Update SpawnLoft.')
  assert.equal(win.natives.dir, 'native/libs')
  assert.deepEqual(win.natives.extraDirs, ['jna', 'lwjgl', 'netty'])
  assert.deepEqual(resolvedRefusal(win), { code: 'unknown-rule-key', message: win.problems.map((p) => p.message).join(' ') })
  assert.equal(resolvedRefusal(resolveVersion(F.loadVersion('26.3'), { os: pair('windows', 'x64') })), null)
})

test('resolver: natives folder, its siblings and the log config are carried', () => {
  const r26 = resolveVersion(F.loadVersion('26.3'), { os: pair('linux', 'x64') })
  assert.equal(r26.natives.dir, 'java')
  assert.deepEqual(r26.natives.extraDirs, ['jna', 'lwjgl', 'netty'])
  assert.equal(r26.logging.id, 'client-1.21.2.xml')
  const r12 = resolveVersion(F.loadVersion('1.12.2'), { os: pair('linux', 'x64') })
  assert.equal(r12.natives.dir, '')
  assert.deepEqual(r12.natives.extraDirs, [])
  assert.equal(r12.logging.id, 'client-1.12.xml')
  assert.equal(resolveVersion(F.loadVersion('1.5.2'), { os: pair('linux', 'x64') }).logging, null)
})

test('rules: versionRange min inclusive, max exclusive, so Mojang\'s 10.0.17134 pair splits the builds', () => {
  // the pair in 26.x default-user-jvm (ZGC from that build, G1 flags below it); unused until Q5
  const zgc = [{ action: 'allow', os: { name: 'windows', versionRange: { min: '10.0.17134' } } }]
  const g1 = [{ action: 'allow', os: { name: 'windows', versionRange: { max: '10.0.17134' } } }]
  for (const [release, expectZgc] of [['10.0.17133', false], ['10.0.17134', true], ['10.0.22631', true], ['6.3.9600', false]]) {
    const os = { name: 'windows', arch: 'x64', version: release }
    assert.equal(ruleAllows(zgc, { os }), expectZgc, `ZGC on ${release}`)
    assert.equal(ruleAllows(g1, { os }), !expectZgc, `G1 on ${release}`)
  }
  assert.deepEqual(ruleProblems([...zgc, ...g1], { os: pair('windows', 'x64') }), [])
})

test('rules: an osx versionRange is a problem, an osx os.version regex is not and never matches Darwin', () => {
  const mac = pair('osx', 'arm64')
  const range = [{ action: 'allow', os: { name: 'osx', versionRange: { min: '14.0' } } }]
  assert.deepEqual(ruleProblems(range, { os: mac }), ['"os.versionRange" on macOS'])
  assert.equal(ruleAllows(range, { os: mac }), false)
  const regex = [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx', version: '^10\\.5\\.\\d$' } }]
  assert.deepEqual(ruleProblems(regex, { os: mac }), [])
  assert.equal(ruleAllows(regex, { os: mac }), true)
  // a Windows machine is not refused over an osx-only rule
  assert.deepEqual(ruleProblems(range, { os: pair('windows', 'x64') }), [])
})

test('rules: an unknown key never matches and is reported; last matching rule wins', () => {
  const os = pair('linux', 'x64')
  assert.equal(ruleAllows([{ action: 'allow', os: { name: 'linux', kernel: '^6' } }], { os }), false)
  assert.equal(ruleAllows([{ action: 'allow' }, { action: 'disallow', os: { name: 'linux', kernel: '^6' } }], { os }), true)
  assert.equal(ruleAllows([{ action: 'allow', when: 'always' }], { os }), false)
  assert.equal(ruleAllows([{ os: { name: 'linux' } }], { os }), false)
  assert.deepEqual(ruleProblems([{ action: 'allow', when: 'always' }, { os: { name: 'linux' } }, { action: 'allow', os: { name: 'linux', kernel: '^6' } }], { os }), ['"when"', '"action"', '"os.kernel"'])
  assert.equal(ruleAllows([{ action: 'allow' }, { action: 'disallow', os: { name: 'linux' } }], { os }), false)
})

test('arch: map-form versions on arm64 run as x64 when the machine can, and are refused in words when not', () => {
  const v = F.loadVersion('1.16.5')
  assert.deepEqual([...nativeArches(v, pair('osx', 'arm64'))].sort(), ['x64', 'x86'])
  assert.deepEqual(archDecision(v, pair('osx', 'arm64'), { x64: true }), { refusal: null, arch: 'x64', emulated: true })
  assert.equal(archDecision(v, pair('osx', 'arm64'), { x64: false }).refusal,
    'Minecraft 1.16.5 has no Apple Silicon build; install Rosetta to run it: softwareupdate --install-rosetta --agree-to-license')
  assert.equal(archDecision(v, { name: 'windows', arch: 'arm64', version: '10.0.19045' }, { x64: false }).refusal,
    'Minecraft 1.16.5 has no Windows arm64 build, and Windows 10 arm64 (build 19045) cannot run the x64 one; Windows 11 can')
  assert.equal(archDecision(v, pair('windows', 'arm64'), { x64: true }).arch, 'x64')
  // without knowing the machine (the picker on a version list), the plain refusal
  assert.equal(platformRefusal(v, pair('osx', 'arm64')), '1.16.5 ships no macOS arm64 natives; use a newer Minecraft version on this machine')
  // Windows x86 keeps the map-form versions and loses 26.2+
  assert.equal(archDecision(v, pair('windows', 'x86'), { x64: false }).refusal, null)
  assert.equal(archDecision(F.loadVersion('26.3'), pair('windows', 'x86'), { x64: false }).refusal, '26.3 ships no Windows x86 natives; use a newer Minecraft version on this machine')
})

test('collectVariables: in order of first use, once each', () => {
  assert.deepEqual(collectVariables(['-a=${x}', '${y}${x}', 'plain']), ['x', 'y'])
})

const javas = (...rows) => rows.map(([major, arch = 'x64']) => ({ path: `/jvm/${major}-${arch}/bin/java`, major, arch, version: `${major}` }))

test('Java: the preferred major first, else the newest inside the bounds, of the right arch', () => {
  const req = (id) => javaRequirement(F.loadVersion(id))
  const pick = (id, found, arch = 'x64') => chooseClientJava(found, req(id), arch)?.major ?? null
  assert.equal(pick('1.16.5', javas([21], [17], [8])), 8, '1.16.5 takes an installed 8')
  assert.equal(pick('1.16.5', javas([21], [17])), 17, '1.16.5 accepts 17')
  assert.equal(pick('1.16.5', javas([21])), null, '1.16.5 does not take 21')
  assert.equal(pick('1.12.2', javas([21], [17])), null, '1.12.2 runs on 8 only')
  assert.equal(pick('1.17.1', javas([17])), 17, '1.17.1 accepts 17')
  assert.equal(pick('1.21.11', javas([25], [21])), 21, '21 over 25 for 1.21.11 (review R3)')
  assert.equal(pick('1.21.11', javas([25])), 25, '25 when 21 is absent')
  assert.equal(pick('26.3', javas([25], [21])), 25)
  assert.equal(pick('26.3', javas([21])), null)
  assert.equal(pick('1.16.5', javas([8, 'arm64'], [17, 'x64']), 'x64'), 17, 'an arm64 Java is skipped for an emulated game')
  assert.equal(pick('1.16.5', [{ path: '/j', major: 8, arch: null }], 'x64'), 8, 'a Java whose arch is unknown is taken')
})

test('Java: the refusals name the Java the version needs; a newer one runs with a warning', async () => {
  const req = javaRequirement(F.loadVersion('26.3'))
  await assert.rejects(pickClientJava({ requirement: req, what: 'Minecraft 26.3', found: javas([21], [17]) }), {
    code: 'java-too-old',
    message: 'Minecraft 26.3 needs Java 25 or newer. The newest Java on this machine is 21 (/jvm/21-x64/bin/java). Install Java 25 from https://adoptium.net/temurin/releases/?version=25, or point the profile at one.',
  })
  // only newer Javas than the bounds and no way to Mojang's runtime: the closest one, with a warning
  assert.deepEqual(await pickClientJava({ requirement: javaRequirement(F.loadVersion('1.16.5')), what: 'Minecraft 1.16.5', found: javas([25], [21]) }), {
    path: '/jvm/21-x64/bin/java',
    warning: 'Minecraft 1.16.5 wants Java 8 to 17; using Java 21 at /jvm/21-x64/bin/java, which is newer, so the game may not start. Install Java 8 from https://adoptium.net/temurin/releases/?version=8, or point the profile at one.',
    source: 'fallback',
  })
  await assert.rejects(pickClientJava({ requirement: req, what: 'Minecraft 26.3', found: [] }), { code: 'java-missing' })
  await assert.rejects(pickClientJava({ requirement: javaRequirement(F.loadVersion('1.16.5')), arch: 'x64', what: 'Minecraft 1.16.5', found: javas([17, 'arm64']) }), {
    code: 'java-wrong-arch',
    message: 'Minecraft 1.16.5 runs as x64 on this machine and needs an x64 Java 8 to 17; the Javas found are arm64. Install Java 8 from https://adoptium.net/temurin/releases/?version=8, or point the profile at one.',
  })
  assert.deepEqual(await pickClientJava({ requirement: req, found: javas([25], [21]) }), { path: '/jvm/25-x64/bin/java', warning: null, source: 'installed' })
})

test('Java: probe() reports the arch of a real Java', { skip: !realJava.found && 'no Java on PATH' }, async () => {
  const { probe } = await import('../src/java.mjs')
  const state = await probe('java')
  assert.ok(['x64', 'arm64', 'x86'].includes(state.arch), `arch ${state.arch}`)
  assert.equal(typeof state.major, 'number')
})

test('Java: os.arch from -XshowSettings:properties', () => {
  const props = (arch) => `Property settings:\n    java.home = /x\n    os.arch = ${arch}\n    os.name = Linux\n\nopenjdk version "21.0.5" 2024-10-15\n`
  assert.equal(parseArch(props('amd64')), 'x64')
  assert.equal(parseArch(props('x86_64')), 'x64')
  assert.equal(parseArch(props('aarch64')), 'arm64')
  assert.equal(parseArch(props('x86')), 'x86')
  assert.equal(parseArch(props('i386')), 'x86')
  assert.equal(parseArch('openjdk version "21.0.5"'), null)
})

test('launch: a version with a problem is refused after its JSON and before Java is looked for', { skip: platformRefusal(null) !== null && 'Mojang ships no client for this machine' }, async () => {
  const future = F.loadFuture()
  fs.mkdirSync(versionDir(future.id), { recursive: true })
  fs.writeFileSync(versionJson(future.id), JSON.stringify(future))
  createProfile('future', { mc: future.id })
  const stages = []
  await assert.rejects(launch('future', { onStage: (s) => stages.push(s.stage) }), (err) => {
    assert.equal(err.code, 'unknown-rule-key')
    assert.match(err.message, /^Minecraft 27\.1 uses a platform rule SpawnLoft does not know/)
    return true
  })
  assert.ok(!stages.includes('java'), `no Java search: ${stages.join(', ')}`)
  assert.equal(fs.existsSync(path.join(versionDir(future.id), `${future.id}.jar`)), false, 'nothing downloaded')
})

test('mergeInherited keeps the parent javaVersion for the resolver', () => {
  const merged = mergeInherited(F.loadFabricProfile('26.3'), F.loadVersion('26.3'))
  assert.equal(resolveVersion(merged, { os: pair('linux', 'x64') }).java.major, 25)
})

test('ids: every id shape Mojang has used is safe, nothing that would leave its folder is', () => {
  for (const row of F.loadErasManifest().versions) assert.ok(isSafeVersionId(row.id), row.id)
  for (const ok of ['26.4-snapshot-6', '1.14.2 Pre-Release 4', 'rd-132211', 'c0.0.11a', 'inf-20100618', '3D Shareware v1.34']) assert.ok(isSafeVersionId(ok), ok)
  for (const bad of ['', ' 1.21', '1.21 ', '1.21.', '-1.21', '.1', '1..21', '../x', 'a/b', 'a\\b', '1.21:x', 'x'.repeat(65), 42, null]) {
    assert.equal(isSafeVersionId(bad), false, String(bad))
  }
})

test('ids: the picker kind of every shape', () => {
  const kinds = Object.fromEntries(F.loadErasManifest().versions.map((v) => [v.id, versionKind(v)]))
  assert.equal(kinds['26.3'], 'release')
  assert.equal(kinds['26.4-snapshot-6'], 'snapshot')
  assert.equal(kinds['25w46a'], 'snapshot')
  assert.equal(kinds['1.21.11-rc3'], 'release-candidate')
  assert.equal(kinds['1.14.2 Pre-Release 4'], 'pre-release')
  assert.equal(kinds['3D Shareware v1.34'], 'snapshot')
  assert.equal(kinds['b1.7.3'], 'beta')
  assert.equal(kinds['a1.2.6'], 'alpha')
  assert.equal(kinds['rd-132211'], 'alpha')
  assert.equal(versionKind({ id: '1.21.11-pre1', type: 'snapshot' }), 'pre-release')
  assert.equal(versionKind({ id: '26.1-pre-2', type: 'snapshot' }), 'pre-release')
  assert.equal(versionKind({ id: '26.1-rc-1', type: 'snapshot' }), 'release-candidate')
})

test('rules: a versionRange with no OS name never matches on a Mac, at launch or in the picker (review N-1)', () => {
  const mac = pair('osx', 'arm64')
  const rules = [{ action: 'allow', os: { versionRange: { min: '1.0' } } }]
  assert.equal(ruleAllows(rules, { os: mac }), false)
  assert.equal(ruleAllows(rules, { os: pair('windows', 'x64') }), true)
  assert.equal(ruleAllows([{ action: 'allow' }, { action: 'disallow', os: { versionRange: { min: '1.0' } } }], { os: mac }), true)
})

// A stand-in Java: a shell script answering -version (and -XshowSettings unless told to refuse it).
// Each in a folder of its own, made here: nothing else in the run can have removed it.
function stubJava(name, { major, arch = 'x86_64', refuseSettings = false }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-stub-java-')), name)
  const version = major === 8 ? '1.8.0_402' : `${major}.0.1`
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'for a in "$@"; do',
    `  if [ "$a" = "-XshowSettings:properties" ]; then ${refuseSettings ? 'echo "Unrecognized option: -XshowSettings:properties" >&2; exit 1' : `echo "    os.arch = ${arch}" >&2`}; fi`,
    'done',
    `echo 'openjdk version "${version}" 2024-10-15' >&2`,
    'exit 0',
    '',
  ].join('\n'))
  fs.chmodSync(file, 0o755)
  return file
}

const posixOnly = process.platform === 'win32' && 'the stand-in Java is a shell script'

test('Java: an explicit Java of the wrong arch, too old, or newer with a warning (review N-4)', { skip: posixOnly }, async () => {
  const req = javaRequirement(F.loadVersion('1.16.5'))
  const arm = stubJava('java-arm', { major: 8, arch: 'aarch64' })
  await assert.rejects(pickClientJava({ explicit: arm, requirement: req, arch: 'x64', what: 'Minecraft 1.16.5' }), {
    code: 'java-wrong-arch',
    message: `Minecraft 1.16.5 runs as x64 on this machine, and ${arm} is an arm64 Java. Pick an x64 Java for the profile, or clear it to let SpawnLoft choose.`,
  })
  const old = stubJava('java-old', { major: 17 })
  await assert.rejects(pickClientJava({ explicit: old, requirement: javaRequirement(F.loadVersion('26.3')), arch: 'x64', what: 'Minecraft 26.3' }), {
    code: 'java-too-old',
    message: `Minecraft 26.3 needs Java 25 or newer, and ${old} is Java 17. Pick another Java for the profile, or clear it to let SpawnLoft choose.`,
  })
  const newer = stubJava('java-new', { major: 21 })
  const picked = await pickClientJava({ explicit: newer, requirement: req, arch: 'x64', what: 'Minecraft 1.16.5' })
  assert.equal(picked.path, newer)
  assert.match(picked.warning, /^Minecraft 1\.16\.5 wants Java 8 to 17; using Java 21 at .*, which is newer, so the game may not start\./)
  const eight = stubJava('java-8', { major: 8 })
  assert.deepEqual(await pickClientJava({ explicit: eight, requirement: req, arch: 'x64' }), { path: eight, warning: null, source: 'explicit' })
})

test('Java: probe() asks again with -version when a Java refuses -XshowSettings (review N-4)', { skip: posixOnly }, async () => {
  const { probe } = await import('../src/java.mjs')
  const state = await probe(stubJava('java-plain', { major: 8, refuseSettings: true }))
  assert.equal(state.found, true)
  assert.equal(state.major, 8)
  assert.equal(state.arch, null, 'its arch stays unknown')
  assert.equal((await probe(stubJava('java-props', { major: 21, arch: 'aarch64' }))).arch, 'arm64')
})
