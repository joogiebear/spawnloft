import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientDiagnose, CLIENT_SHAPES } from '../src/client-diagnose.mjs'

const one = (line, ctx) => clientDiagnose([line], ctx)[0]

test('out of memory names the configured memory and the command to raise it', () => {
  const f = one('java.lang.OutOfMemoryError: Java heap space', { memory: '2G', profile: 'myclient' })
  assert.equal(f.id, 'client-out-of-memory')
  assert.match(f.advice, /2G/)
  assert.match(f.advice, /spawnloft client set myclient memory=4G/)
})

test('an OpenGL failure names both the driver and the headless option', () => {
  const f = one('GLFW error 62104: X11: Failed to establish connection')
  assert.equal(f.id, 'opengl')
  assert.match(f.advice, /driver/i)
  assert.match(f.advice, /headless/i)
})

test('a fabric mod missing its dependency names it and points at mods/', () => {
  const f = one("Mod 'Lithium' (lithium) 0.14.3 requires any version of fabric-api, which is missing!")
  assert.equal(f.id, 'mod-dependency')
  assert.match(f.advice, /fabric-api/)
  assert.match(f.advice, /mods\//)
})

test('a mod built for the wrong Minecraft version names the profile version', () => {
  const f = one("Mod 'Sodium' (sodium) 0.5.0 requires Minecraft 1.21", { mc: '1.20.4' })
  assert.equal(f.id, 'mod-wrong-version')
  assert.match(f.advice, /1\.20\.4/)
})

test('a refused connection points at spawnloft list', () => {
  const f = one('java.net.ConnectException: Connection refused')
  assert.equal(f.id, 'connection-refused')
  assert.match(f.advice, /spawnloft list/)
})

test('an outdated client kick names the version mismatch', () => {
  const f = one('Incompatible client', { mc: '1.20.4' })
  assert.equal(f.id, 'kicked-outdated')
  assert.match(f.advice, /1\.20\.4/)
})

test('an auth failure names both the offline-profile and expired-sign-in causes', () => {
  const f = one('Failed to verify username')
  assert.equal(f.id, 'auth-failed')
  assert.match(f.advice, /offline/i)
  assert.match(f.advice, /Microsoft|sign-in/i)
})

test('a resource pack failure points at the URL and hash', () => {
  const f = one('Failed to download resource pack')
  assert.equal(f.id, 'resource-pack')
  assert.match(f.advice, /URL/i)
  assert.match(f.advice, /hash/i)
})

test('a client crash points at the crash report directory', () => {
  const f = one('---- Minecraft Crash Report ----', { crashDir: 'C:\\Users\\me\\crash-reports' })
  assert.equal(f.id, 'crash-report')
  assert.match(f.advice, /crash-reports/)
})

test('a class-file version mismatch translates to the Java release it needs', () => {
  const f = one('java.lang.UnsupportedClassVersionError: net/minecraft/client has been compiled by a more recent version of the Java Runtime (class file version 65.0)')
  assert.equal(f.id, 'wrong-java')
  assert.match(f.advice, /Java 21/)
})

test('each shape reports once, at most three come back, cause before consequence', () => {
  const lines = [
    'GLFW error 62104: X11: Failed to establish connection',
    'noise',
    'Connection refused',
    'Connection refused',
    'java.lang.OutOfMemoryError: Java heap space',
    'Incompatible client',
  ]
  const findings = clientDiagnose(lines, {})
  assert.equal(findings.length, 3, 'capped at three')
  assert.equal(new Set(findings.map((f) => f.id)).size, findings.length, 'no duplicates')
  assert.deepEqual(findings.map((f) => f.id), ['connection-refused', 'client-out-of-memory', 'kicked-outdated'])
})

test('an unremarkable log yields nothing rather than a guess', () => {
  assert.deepEqual(clientDiagnose(['[12:00:00 INFO]: Connected to server', 'Loading assets...']), [])
})
