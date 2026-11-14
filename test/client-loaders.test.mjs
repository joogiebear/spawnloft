// The loader groundwork (Forge, NeoForge and Quilt plan, phase 0): the loader list, and the three
// shared-code changes Forge needs, on real version files.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-client-loaders-'))
process.env.MCCTL_DATA_ROOT = scratch
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const F = await import('./fixtures/client-fixtures.mjs')
const { mergeInherited, libraries, classpathRows, libraryKey, gameArguments } = await import('../src/client-meta.mjs')
const { buildCommand } = await import('../src/client-launch.mjs')
const { offlineAccount } = await import('../src/client-auth.mjs')
const { LOADERS, loaderFor } = await import('../src/client-loaders.mjs')
const client = await import('../src/client.mjs')

const linux = { name: 'linux', arch: 'x64', version: '6.1.0' }

test('the loader list: vanilla first, Fabric and Quilt behind the shared shape, and the same list client.mjs checks a setup against', () => {
  assert.deepEqual(LOADERS, ['vanilla', 'fabric', 'quilt', 'neoforge'])
  assert.equal(client.LOADERS, LOADERS)
  assert.equal(loaderFor('vanilla'), null)
  const fabric = loaderFor('fabric')
  for (const fn of ['gameVersions', 'available', 'assertAvailable', 'builds', 'pick', 'versionId', 'isInstalled', 'ensureInstalled', 'afterInstall']) {
    assert.equal(typeof fabric[fn], 'function', fn)
  }
  assert.equal(fabric.versionId('1.21.11', '0.19.5'), 'fabric-loader-0.19.5-1.21.11')
  assert.equal(fabric.pick([{ version: '0.20.0-beta.1', stable: false }, { version: '0.19.5', stable: true }]).version, '0.19.5')
  assert.equal(fabric.pick([{ version: '0.19.5', stable: true }, { version: '0.19.4', stable: true }], '0.19.4').version, '0.19.4')
  assert.equal(fabric.available('1.21.11', [{ version: '1.21.11', stable: true }]), true)
  assert.equal(fabric.available('1.8.9', [{ version: '1.21.11', stable: true }]), false)
  assert.throws(() => loaderFor('forge'), /unknown loader/)
  assert.throws(() => client.createProfile('bad-loader', { mc: '1.21.11', loader: 'forge' }), /unknown loader "forge" - use vanilla or fabric or quilt/)
})

// A Forge 1.12.2 profile as the legacy installer writes it: its own full minecraftArguments line
// with the tweaker, and launchwrapper as the main class.
function legacyForge(parent) {
  return {
    id: '1.12.2-forge-14.23.5.2864',
    inheritsFrom: '1.12.2',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    minecraftArguments: `${parent.minecraftArguments} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker --versionType Forge`,
    libraries: [
      { name: 'net.minecraftforge:forge:1.12.2-14.23.5.2864', url: 'https://maven.minecraftforge.net/' },
      { name: 'net.minecraft:launchwrapper:1.12' },
    ],
  }
}

test('merge: the child\'s minecraftArguments wins, so Forge 1.12.2\'s --tweakClass reaches the command line', () => {
  const parent = F.loadVersion('1.12.2')
  const child = legacyForge(parent)
  const merged = mergeInherited(child, parent)
  assert.equal(merged.minecraftArguments, child.minecraftArguments)
  assert.equal(merged.mainClass, 'net.minecraft.launchwrapper.Launch')
  const game = gameArguments(merged, { os: linux })
  assert.equal(game[game.indexOf('--tweakClass') + 1], 'net.minecraftforge.fml.common.launcher.FMLTweaker')
  const cmd = buildCommand({ version: merged, profile: { mc: '1.12.2', loader: 'vanilla', memory: '4G', server: null }, profileName: 'forge', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
  assert.equal(cmd.args.filter((a) => a === '--tweakClass').length, 1)
  assert.ok(cmd.args.includes('net.minecraftforge.fml.common.launcher.FMLTweaker'))
  assert.ok(cmd.args.includes('net.minecraft.launchwrapper.Launch'))
})

test('merge: a child without minecraftArguments keeps the parent\'s, and an arguments-era child is unchanged', () => {
  const parent = F.loadVersion('1.12.2')
  const plain = { id: 'child', inheritsFrom: '1.12.2', mainClass: 'x', libraries: [] }
  assert.equal(mergeInherited(plain, parent).minecraftArguments, parent.minecraftArguments)
  const fabric = F.loadFabricMerged('1.21.11')
  assert.equal(fabric.minecraftArguments, undefined)
  assert.ok(fabric.arguments.game.length > 0)
})

test('libraryKey: the name without its version, classifier and extension kept', () => {
  assert.equal(libraryKey('org.ow2.asm:asm:9.7.1'), 'org.ow2.asm:asm')
  assert.equal(libraryKey('org.lwjgl:lwjgl:3.3.3:natives-linux'), 'org.lwjgl:lwjgl:natives-linux')
  assert.equal(libraryKey('net.minecraftforge:forge:1.20.1-47.4.28:client'), 'net.minecraftforge:forge:client')
  assert.equal(libraryKey('de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip'), 'de.oceanlabs.mcp:mcp_config@zip')
  assert.equal(libraryKey('g:a:2@jar'), libraryKey('g:a:1'))
})

test('classpath: one copy per library name, the loader\'s newer copy first, as Mojang\'s launcher does', () => {
  const parent = F.loadVersion('1.20.4')
  const guava = parent.libraries.find((l) => l.name.startsWith('com.google.guava:guava:'))
  assert.ok(guava, 'the fixture lists guava')
  const child = {
    id: '1.20.4-forge-test',
    inheritsFrom: '1.20.4',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    arguments: { game: [], jvm: [] },
    libraries: [
      { name: 'com.google.guava:guava:99.0-jre', downloads: { artifact: { path: 'com/google/guava/guava/99.0-jre/guava-99.0-jre.jar', url: 'https://maven.minecraftforge.net/com/google/guava/guava/99.0-jre/guava-99.0-jre.jar', sha1: '0'.repeat(40), size: 1 } } },
      { name: 'net.minecraftforge:forge:1.20.4-test:universal', downloads: { artifact: { path: 'net/minecraftforge/forge/1.20.4-test/forge-1.20.4-test-universal.jar', url: 'https://maven.minecraftforge.net/x.jar', sha1: '1'.repeat(40), size: 1 } } },
      { name: 'net.minecraftforge:forge:1.20.4-test:client', downloads: { artifact: { path: 'net/minecraftforge/forge/1.20.4-test/forge-1.20.4-test-client.jar', url: '', sha1: '2'.repeat(40), size: 1 } } },
    ],
  }
  const merged = mergeInherited(child, parent)
  const cp = classpathRows(libraries(merged, { os: linux })).map((r) => r.path)
  assert.ok(cp.includes('com/google/guava/guava/99.0-jre/guava-99.0-jre.jar'))
  assert.ok(!cp.includes(guava.downloads.artifact.path), 'vanilla\'s older guava is left off')
  assert.equal(cp.filter((p) => p.includes('/guava/guava/')).length, 1)
  // a classifier is its own library: universal and client both stay
  assert.ok(cp.includes('net/minecraftforge/forge/1.20.4-test/forge-1.20.4-test-universal.jar'))
  assert.ok(cp.includes('net/minecraftforge/forge/1.20.4-test/forge-1.20.4-test-client.jar'))
  // the order is the loader's first, then the parent's
  assert.equal(cp[0], 'com/google/guava/guava/99.0-jre/guava-99.0-jre.jar')

  const cmd = buildCommand({ version: merged, profile: { mc: '1.20.4', loader: 'vanilla', memory: '4G', server: null }, profileName: 'forge', account: offlineAccount('alice'), java: '/opt/java/bin/java', os: linux, harnessToken: null, address: null })
  const classpath = cmd.args[cmd.args.indexOf('-cp') + 1].split(path.delimiter)
  assert.equal(classpath.filter((p) => p.includes(`${path.sep}guava${path.sep}guava${path.sep}`)).length, 1)
  assert.ok(classpath.some((p) => p.endsWith(`guava-99.0-jre.jar`)))
})

test('library rows: an empty URL is null (made by the installer), and a missing URL still means Mojang\'s library server', () => {
  const rows = libraries({
    libraries: [
      { name: 'a:made:1', downloads: { artifact: { path: 'a/made/1/made-1.jar', url: '', sha1: '0'.repeat(40), size: 1 } } },
      { name: 'a:bare:1', url: '' },
      { name: 'a:mojang:1' },
      { name: 'a:maven:1', url: 'https://maven.example.net/' },
    ],
  }, { os: linux })
  assert.deepEqual(rows.map((r) => r.url), [null, null, 'https://libraries.minecraft.net/a/mojang/1/mojang-1.jar', 'https://maven.example.net/a/maven/1/maven-1.jar'])
})
