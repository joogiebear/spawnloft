import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { diagnose, crashReports, SHAPES } from '../src/diagnose.mjs'

const one = (line, ctx) => diagnose([line], ctx)[0]

test('a taken port names the port and the way to see who has it', () => {
  const f = one('[12:00:01 WARN]: FAILED TO BIND TO PORT!', { port: 25566 })
  assert.equal(f.id, 'port-in-use')
  assert.match(f.advice, /25566/)
  assert.match(f.advice, /mcctl list/)
})

test('the EULA refusal points at the file', () => {
  const f = one('[12:00:01 INFO]: You need to agree to the EULA in order to run the server.', { dir: 'S:\\x' })
  assert.equal(f.id, 'eula')
  assert.match(f.advice, /eula\.txt/)
})

test('a class-file version mismatch translates to the Java release it needs', () => {
  const f = one('java.lang.UnsupportedClassVersionError: net/minecraft/server has been compiled by a more recent version of the Java Runtime (class file version 69.0)')
  assert.equal(f.id, 'wrong-java')
  assert.match(f.advice, /Java 25/)
})

test('out of memory names the configured memory', () => {
  const f = one('Caused by: java.lang.OutOfMemoryError: Java heap space', { memory: '2G' })
  assert.equal(f.id, 'out-of-memory')
  assert.match(f.advice, /2G/)
})

test('a full disk is a full disk', () => {
  assert.equal(one('java.io.IOException: There is not enough space on the disk').id, 'out-of-disk')
})

test('a plugin missing its dependency names the missing one when the log does', () => {
  const f = one('org.bukkit.plugin.UnknownDependencyException: Unknown dependency Vault.')
  assert.equal(f.id, 'missing-plugin-dependency')
  assert.match(f.advice, /"Vault"/)
})

test('a fabric mod missing its dependency names it', () => {
  const f = one("Mod 'Lithium' (lithium) 0.14.3 requires any version of fabric-api, which is missing!")
  assert.equal(f.id, 'missing-mod-dependency')
  assert.match(f.advice, /fabric-api/)
})

test('two jars claiming one plugin is recognised - the FAWE/WorldEdit trap', () => {
  const f = one("Ambiguous plugin name `WorldEdit' for files ...")
  assert.equal(f.id, 'duplicate-plugin')
  assert.match(f.advice, /FAWE/)
})

test('a world that fails to read back points at the snapshots', () => {
  const f = one('[12:00:02 ERROR]: Exception reading ./world/level.dat')
  assert.equal(f.id, 'corrupt-world')
  assert.match(f.advice, /snapshot/)
})

test('a ticking crash points at the crash report', () => {
  const f = one('[12:00:02 ERROR]: Ticking entity: minecraft:zombie', { crashDir: 'S:\\x\\crash-reports' })
  assert.equal(f.id, 'ticking-crash')
  assert.match(f.advice, /crash-reports/)
})

test('the watchdog shutdown reads as a stall, not a mystery', () => {
  assert.equal(one('A single server tick took 60.00 seconds (should be max 0.05)').id, 'watchdog')
})

test('a missing jar names it', () => {
  const f = one('Error: Unable to access jarfile paper-26.2-121.jar')
  assert.equal(f.id, 'missing-jar')
  assert.match(f.advice, /paper-26\.2-121\.jar/)
})

test('each shape reports once, at most three come back, cause before consequence', () => {
  const lines = [
    'You need to agree to the EULA in order to run the server.',
    'noise',
    'FAILED TO BIND TO PORT!',
    'FAILED TO BIND TO PORT!',
    'java.lang.OutOfMemoryError: Java heap space',
    'A single server tick took 60.00 seconds',
  ]
  const findings = diagnose(lines, {})
  assert.equal(findings.length, 3, 'capped at three')
  assert.equal(new Set(findings.map((f) => f.id)).size, findings.length, 'no duplicates')
  // Newest evidence is gathered first, then presented in log order.
  assert.deepEqual(findings.map((f) => f.id), ['port-in-use', 'out-of-memory', 'watchdog'])
})

test('an unremarkable log yields nothing rather than a guess', () => {
  assert.deepEqual(diagnose(['[12:00:00 INFO]: Done (3.2s)! For help, type "help"']), [])
})

test('every shape has the fields the surfaces rely on', () => {
  for (const s of SHAPES) {
    assert.ok(s.id && s.title && typeof s.advice === 'function', s.id)
  }
})

test('crash reports list newest first with their own description line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-diag-'))
  const crashes = path.join(dir, 'crash-reports')
  fs.mkdirSync(crashes)
  fs.writeFileSync(path.join(crashes, 'crash-2026-08-30_old.txt'),
    '---- Minecraft Crash Report ----\n\nDescription: Ticking entity\n\nstack...')
  fs.writeFileSync(path.join(crashes, 'crash-2026-08-31_new.txt'),
    '---- Minecraft Crash Report ----\n\nDescription: Exception in server tick loop\n\nstack...')
  fs.utimesSync(path.join(crashes, 'crash-2026-08-30_old.txt'), new Date(2026, 7, 30), new Date(2026, 7, 30))

  const out = crashReports({ dir })
  assert.equal(out.reports.length, 2)
  assert.equal(out.reports[0].file, 'crash-2026-08-31_new.txt')
  assert.equal(out.reports[0].description, 'Exception in server tick loop')
})

test('a server with no crash-reports folder has an empty, unremarkable answer', () => {
  const out = crashReports({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mcctl-diag-')) })
  assert.deepEqual(out.reports, [])
})
