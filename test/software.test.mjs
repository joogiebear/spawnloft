import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SOFTWARE, JAR_IDS, softwareOf, isSoftware, versionFromJar, guessLoader } from '../src/software.mjs'
import { contentKindFor, loadersFor, mcVersionOf } from '../src/plugins.mjs'
import { versionsOf, pickBuild, jarName as aspJarName } from '../src/asp.mjs'
import { parseVersionIndex, jarName as btJarName } from '../src/buildtools.mjs'
import { jarName as purpurJarName } from '../src/purpur.mjs'
import { jarName as vanillaJarName } from '../src/vanilla.mjs'

test('every kind of software is fully described, and the jar kinds are all but NeoForge', () => {
  for (const s of SOFTWARE) {
    assert.ok(s.id && s.label && s.blurb, `${s.id} is missing a field`)
    assert.ok(['bukkit', 'fabric', 'neoforge', 'vanilla'].includes(s.family), `${s.id} family`)
    assert.ok(['plugins', 'mods', 'none'].includes(s.content), `${s.id} content`)
    assert.ok(Array.isArray(s.modrinth))
  }
  assert.deepEqual(JAR_IDS, SOFTWARE.map((s) => s.id).filter((id) => id !== 'neoforge'))
  assert.equal(softwareOf('nonsense').id, 'paper', 'unknown is Paper, like absent')
  assert.ok(isSoftware('purpur') && !isSoftware('forge'))
})

test('every jar a source stores names its Minecraft version, and the version reads back', () => {
  assert.equal(versionFromJar('paper-26.2-121.jar'), '26.2')
  assert.equal(versionFromJar(purpurJarName('26.2', '2632')), '26.2')
  assert.equal(versionFromJar('folia-26.2-14.jar'), '26.2')
  assert.equal(versionFromJar(aspJarName('26.2', { id: '4c4079b5-00db-4cdf-a4bf-dd71cdb1bbe7' })), '26.2')
  assert.equal(aspJarName('26.2', { id: '4c4079b5-00db-4cdf-a4bf-dd71cdb1bbe7' }), 'asp-26.2-4c4079b5.jar')
  assert.equal(versionFromJar(btJarName('spigot', '1.21.11')), '1.21.11')
  assert.equal(versionFromJar(btJarName('craftbukkit', '26.2')), '26.2')
  assert.equal(versionFromJar(vanillaJarName('26.2')), '26.2')
  assert.equal(versionFromJar('fabric-server-mc.26.2-loader.0.19.3-launcher.1.1.2.jar'), '26.2')
  assert.equal(versionFromJar('server.jar'), null)
  assert.equal(mcVersionOf({ jar: 'purpur-26.2-2632.jar', mcVersion: '26.1.2' }), '26.1.2')
  assert.equal(mcVersionOf({ jar: 'purpur-26.2-2632.jar' }), '26.2')
})

test('an adopted server is recognised by its jar name, NeoForge by its libraries', () => {
  assert.equal(guessLoader('purpur-26.2-2632.jar'), 'purpur')
  assert.equal(guessLoader('folia-26.2-14.jar'), 'folia')
  assert.equal(guessLoader('asp-26.2-4c4079b5.jar'), 'asp')
  assert.equal(guessLoader('spigot-1.21.11.jar'), 'spigot')
  assert.equal(guessLoader('craftbukkit-26.2.jar'), 'craftbukkit')
  assert.equal(guessLoader('vanilla-26.2.jar'), 'vanilla')
  assert.equal(guessLoader('fabric-server-mc.26.2-loader.0.19.3-launcher.1.1.2.jar'), 'fabric')
  assert.equal(guessLoader('server.jar', { hasNeoforgeLibs: true }), 'neoforge')
  assert.equal(guessLoader('server.jar'), 'paper')
  assert.equal(guessLoader('paper-26.2-121.jar'), 'paper')
})

test('what each server loads, and where a search may look for it', () => {
  assert.deepEqual(contentKindFor({ loader: 'purpur' }).kind, 'plugins')
  assert.equal(contentKindFor({ loader: 'purpur' }).hangar, true)
  assert.ok(loadersFor({ loader: 'purpur' }).includes('purpur'))
  assert.ok(loadersFor({ loader: 'purpur' }).includes('paper'), 'Purpur runs Paper plugins')

  assert.deepEqual(loadersFor({ loader: 'folia' }), ['folia'], 'Folia runs only plugins built for it')
  assert.equal(contentKindFor({ loader: 'folia' }).hangar, false)

  assert.deepEqual(loadersFor({ loader: 'spigot' }), ['spigot', 'bukkit'], 'Spigot cannot promise Paper API')
  assert.equal(contentKindFor({ loader: 'spigot' }).hangar, false)
  assert.deepEqual(loadersFor({ loader: 'craftbukkit' }), ['bukkit'])

  const vanilla = contentKindFor({ loader: 'vanilla' })
  assert.equal(vanilla.kind, 'none')
  assert.equal(vanilla.hangar, false)

  assert.equal(contentKindFor({ loader: 'asp' }).hangar, true)
  assert.deepEqual(loadersFor({ loader: 'fabric' }), ['fabric'])
  assert.deepEqual(loadersFor({ loader: 'neoforge' }), ['neoforge'])
})

test('ASP: the versions with a server jar, newest first, and the newest build for one', () => {
  const builds = [
    { id: 'aaaa1111-x', date: 100, mcVersion: ['1.21.4'], files: [{ fileName: 'asp-server.jar', id: 'f1' }] },
    { id: 'bbbb2222-x', date: 300, mcVersion: ['26.2'], files: [{ fileName: 'asp-server.jar', id: 'f2' }] },
    { id: 'cccc3333-x', date: 200, mcVersion: ['26.2'], files: [{ fileName: 'asp-server.jar', id: 'f3' }] },
    { id: 'dddd4444-x', date: 400, mcVersion: ['26.3-pre1'], files: [{ fileName: 'asp-server.jar', id: 'f4' }] },
    // An API-only build, no server jar: not a version anyone can run.
    { id: 'eeee5555-x', date: 500, mcVersion: ['26.1.2'], files: [{ fileName: 'api-4.2.0.jar', id: 'f5' }] },
  ]
  assert.deepEqual(versionsOf(builds), ['26.2', '1.21.4'])
  assert.equal(pickBuild(builds, '26.2').id, 'bbbb2222-x', 'the newest by date, not by list order')
  assert.equal(pickBuild(builds, '26.1.2'), null)
})

test('BuildTools: the versions index yields Minecraft versions only, newest first', () => {
  const html = `
    <a href="latest.json">latest.json</a>
    <a href="4647.json">4647.json</a>
    <a href="1.21.4.json">1.21.4.json</a>
    <a href="26.2.json">26.2.json</a>
    <a href="1.21.11.json">1.21.11.json</a>
    <a href="26.1.2.json">26.1.2.json</a>
    <a href="1.8.8.json">1.8.8.json</a>
  `
  assert.deepEqual(parseVersionIndex(html), ['26.2', '26.1.2', '1.21.11', '1.21.4', '1.8.8'])
})
