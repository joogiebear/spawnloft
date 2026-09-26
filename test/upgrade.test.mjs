import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parsePaperJar, parseServerJar, newerVersionsOf, compareMcVersions } from '../src/upgrade.mjs'
import { compareBuilds } from '../src/asp.mjs'

test('a Paper jar name yields its version and build', () => {
  assert.deepEqual(parsePaperJar('paper-26.2-121.jar'), { version: '26.2', build: 121 })
  assert.deepEqual(parsePaperJar('paper-1.21.4-2140.jar'), { version: '1.21.4', build: 2140 })
})

test('anything else yields null rather than a guess', () => {
  for (const bad of ['purpur-26.2-100.jar', 'custom.jar', 'paper-26.2.jar', '', null]) {
    assert.equal(parsePaperJar(bad), null, `parsed "${bad}"`)
  }
})

test('newer versions are the ones before the current in the newest-first list', () => {
  const all = ['26.3', '26.2', '26.1', '25.4']
  assert.deepEqual(newerVersionsOf(all, '26.2'), ['26.3'])
  assert.deepEqual(newerVersionsOf(all, '26.3'), [])
  // A version Paper never published gets no "newer than" claim at all.
  assert.deepEqual(newerVersionsOf(all, '9.9'), [])
})

test('every jar SpawnLoft downloads for an updatable server says its software, version and build', () => {
  assert.deepEqual(parseServerJar('paper-26.2-121.jar'), { software: 'paper', label: 'Paper', version: '26.2', build: 121 })
  assert.deepEqual(parseServerJar('purpur-26.3-2641.jar'), { software: 'purpur', label: 'Purpur', version: '26.3', build: 2641 })
  assert.deepEqual(parseServerJar('folia-1.21.4-10.jar'), { software: 'folia', label: 'Folia', version: '1.21.4', build: 10 })
  assert.deepEqual(parseServerJar('asp-26.3-b77d5e97.jar'), { software: 'asp', label: 'Advanced Slime Paper', version: '26.3', build: 'b77d5e97' })
  for (const other of ['spigot-26.2.jar', 'vanilla-26.2.jar', 'fabric-server-mc.26.2-loader.jar', 'asp-26.3-notahex!.jar', 'custom.jar', null]) {
    assert.equal(parseServerJar(other), null, `parsed "${other}"`)
  }
})

test('Minecraft versions compare by number, not as text', () => {
  assert.ok(compareMcVersions('1.21.10', '1.21.9') > 0)
  assert.ok(compareMcVersions('26.1', '1.21.11') > 0)
  assert.ok(compareMcVersions('26.2', '26.2.1') < 0)
  assert.equal(compareMcVersions('26.2', '26.2.0'), 0)
})

test('an older version still getting builds is not offered as newer, whatever order the list is in', () => {
  // ASP lists versions by when each last had a build, so a maintained 1.21.11 can come first.
  assert.deepEqual(newerVersionsOf(['1.21.11', '26.3', '26.1', '26.2'], '26.1'), ['26.3', '26.2'])
  assert.deepEqual(newerVersionsOf(['1.21.11', '26.3'], '26.3'), [])
})

test('an ASP build is newer by date, and a build the API no longer lists counts as older', () => {
  const jar = [{ fileName: 'asp-server.jar' }]
  const builds = [
    { id: 'b77d5e97-0000', date: 300, mcVersion: ['26.3'], files: jar },
    { id: 'fd11812e-0000', date: 200, mcVersion: ['26.3'], files: jar },
    { id: 'aaaaaaaa-0000', date: 400, mcVersion: ['26.2'], files: jar },
    { id: 'cccccccc-0000', date: 500, mcVersion: ['26.3'], files: [] },
  ]
  assert.deepEqual(compareBuilds(builds, '26.3', 'b77d5e97'), { build: 'b77d5e97', time: new Date(300).toISOString(), newer: false })
  assert.equal(compareBuilds(builds, '26.3', 'fd11812e').newer, true)
  assert.equal(compareBuilds(builds, '26.3', '12345678').newer, true)
  assert.equal(compareBuilds(builds, '26.9', 'b77d5e97'), null)
})
