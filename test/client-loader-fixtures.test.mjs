// The loaders' real files (test/fixtures/client/loaders, captured by the loader-fixtures job) are
// what the Forge, NeoForge and Quilt design says they are. The points the design marked "to
// confirm" are settled here; a re-capture that changes one fails this file first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'client', 'loaders')
const read = (rel) => JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8'))
const installers = (loader) => fs.readdirSync(path.join(DIR, loader), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)

test('every captured file is the one the manifest names, with an https source', () => {
  const manifest = read('manifest.json')
  assert.ok(manifest.files.length > 40)
  for (const { file, url, sha1, bytes } of manifest.files) {
    const buf = fs.readFileSync(path.join(DIR, file))
    assert.equal(crypto.createHash('sha1').update(buf).digest('hex'), sha1, file)
    assert.equal(buf.length, bytes, file)
    assert.match(url, /^https:\/\//, file)
  }
})

test('every installer jar matched the sha1 its maven publishes beside it', () => {
  for (const loader of ['forge', 'neoforge']) {
    for (const v of installers(loader)) {
      const info = read(`${loader}/${v}/installer.json`)
      assert.match(info.publishedSha1, /^[0-9a-f]{40}$/, `${loader} ${v}`)
      assert.equal(info.sha1, info.publishedSha1, `${loader} ${v}`)
      assert.ok(info.entries.some((e) => e.name === 'install_profile.json'), `${loader} ${v}`)
    }
  }
})

// [folder, id, inheritsFrom, mainClass, client-side processors]
const MODERN = [
  ['forge/1.12.2-14.23.5.2864', '1.12.2-forge-14.23.5.2864', '1.12.2', 'net.minecraft.launchwrapper.Launch', 0],
  ['forge/1.16.5-36.2.34', '1.16.5-forge-36.2.34', '1.16.5', 'cpw.mods.modlauncher.Launcher', 4],
  ['forge/1.18.2-40.3.0', '1.18.2-forge-40.3.0', '1.18.2', 'cpw.mods.bootstraplauncher.BootstrapLauncher', 6],
  ['forge/1.20.1-47.4.28', '1.20.1-forge-47.4.28', '1.20.1', 'cpw.mods.bootstraplauncher.BootstrapLauncher', 6],
  ['forge/1.21.1-52.1.20', '1.21.1-forge-52.1.20', '1.21.1', 'net.minecraftforge.bootstrap.ForgeBootstrap', 3],
  ['forge/26.3-66.1.8', '26.3-forge-66.1.8', '26.3', 'net.minecraftforge.bootstrap.ForgeBootstrap', 1],
  ['neoforge/20.4.253', 'neoforge-20.4.253', '1.20.4', 'cpw.mods.bootstraplauncher.BootstrapLauncher', 6],
  ['neoforge/21.1.266', 'neoforge-21.1.266', '1.21.1', 'cpw.mods.bootstraplauncher.BootstrapLauncher', 6],
  ['neoforge/26.3.0.103', 'neoforge-26.3.0.103', '26.3', 'net.neoforged.fml.startup.Client', 1],
]

test('modern installers: spec 0 or 1, a version.json that inherits from vanilla, and the client-side build steps', () => {
  for (const [dir, id, parent, mainClass, clientSteps] of MODERN) {
    const profile = read(`${dir}/install_profile.json`)
    const version = read(`${dir}/version.json`)
    assert.ok([0, 1].includes(profile.spec), `${dir} spec ${profile.spec}`)
    assert.equal(version.id, id, dir)
    assert.equal(version.inheritsFrom, parent, dir)
    assert.equal(profile.minecraft, parent, dir)
    assert.equal(version.mainClass, mainClass, dir)
    const steps = (profile.processors ?? []).filter((p) => !p.sides || p.sides.includes('client'))
    assert.equal(steps.length, clientSteps, dir)
    for (const step of steps) {
      assert.equal(typeof step.jar, 'string', dir)
      assert.ok(Array.isArray(step.args), dir)
    }
  }
})

test('legacy installers: install and versionInfo, no build steps, launchwrapper with its tweaker', () => {
  for (const [dir, id, parent] of [
    ['forge/1.7.10-10.13.4.1614-1.7.10', '1.7.10-Forge10.13.4.1614-1.7.10', '1.7.10'],
    ['forge/1.12.2-14.23.0.2486', '1.12.2-forge1.12.2-14.23.0.2486', '1.12.2'],
  ]) {
    assert.ok(!fs.existsSync(path.join(DIR, dir, 'version.json')), dir)
    const profile = read(`${dir}/install_profile.json`)
    // 1.12.2's also lists optionals (extra mods the installer's window offered), which a client install skips
    assert.ok(profile.install && profile.versionInfo, dir)
    assert.equal(profile.install.minecraft, parent, dir)
    assert.ok(read(`${dir}/installer.json`).entries.some((e) => e.name === profile.install.filePath), `${dir}: the Forge jar is inside the installer`)
    const v = profile.versionInfo
    assert.equal(v.id, id, dir)
    assert.equal(v.inheritsFrom, parent, dir)
    assert.equal(v.mainClass, 'net.minecraft.launchwrapper.Launch', dir)
    assert.match(v.minecraftArguments, /--tweakClass \S+/, dir)
  }
})

test('Quilt: a Fabric-like profile with no checksums in its rows, and a .sha1 beside every library', () => {
  for (const mc of ['1.20.1', '26.3']) {
    const profile = read(`quilt/profile-${mc}-0.30.2.json`)
    assert.equal(profile.id, `quilt-loader-0.30.2-${mc}`)
    assert.equal(profile.inheritsFrom, mc)
    assert.equal(profile.mainClass, 'org.quiltmc.loader.impl.launch.knot.KnotClient')
    for (const lib of profile.libraries) {
      assert.equal(lib.sha1, undefined, lib.name)
      assert.equal(lib.downloads, undefined, lib.name)
      assert.match(lib.url, /^https:\/\//, lib.name)
    }
    const sums = read(`quilt/sidecars-${mc}-0.30.2.json`)
    assert.deepEqual(Object.keys(sums).sort(), profile.libraries.map((l) => l.name).sort())
    for (const [name, { sha1 }] of Object.entries(sums)) assert.match(sha1, /^[0-9a-f]{40}$/, name)
  }
  // no stable flag on Quilt's loader list: a beta is told by its name
  const loaders = read('quilt/loader-versions.json')
  assert.ok(loaders.every((l) => !Object.hasOwn(l, 'stable')))
  assert.ok(loaders.some((l) => /-beta\./.test(l.version)))
})
