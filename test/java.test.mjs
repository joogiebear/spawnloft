import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseMajor, probe, discover, defaultJava, health, requiredMajor, pickJava, MINIMUM_MAJOR } from '../src/java.mjs'
import { UserError } from '../src/util.mjs'

test('the major version is read from both shapes java -version has used', () => {
  assert.equal(parseMajor('openjdk version "21.0.5" 2024-10-15'), 21)
  assert.equal(parseMajor('java version "1.8.0_401"'), 8)
  assert.equal(parseMajor('openjdk version "25" 2026-09-16'), 25)
  assert.equal(parseMajor('nothing here'), null)
})

test('a java that is not there answers not-installed rather than throwing', async () => {
  const res = await probe('no-such-java-binary-for-mcctl-tests')
  assert.equal(res.ok, false)
  assert.equal(res.found, false)
  assert.equal(res.reason, 'not-installed')
})

// Discovery must never depend on PATH alone, and must agree with itself: the default is one of
// the Javas it found, and the health answer names the same one.
test('discovery, the default and health agree on the same Java', async () => {
  const { best, onPath, all } = await discover()
  for (const j of all) assert.ok(Number.isInteger(j.major), `${j.path} has a major version`)
  const chosen = await defaultJava()
  const state = await health()
  if (!best) {
    assert.equal(chosen, null)
    assert.equal(state.ok, false)
    return
  }
  assert.ok(best.major >= MINIMUM_MAJOR)
  assert.ok(all.some((j) => j.path === best.path))
  // 'java' stands for the PATH one only when PATH really has the best major.
  if (chosen === 'java') assert.equal(onPath.major, best.major)
  else assert.equal(chosen, best.path)
  assert.equal(state.path, best.path)
  assert.equal(state.onPath, best.path === 'java')
})

// Mojang's floor per release, which every server built on that release inherits.
test('the Java a Minecraft version needs follows Mojang, and unknown names answer null', () => {
  assert.equal(requiredMajor('1.16.5'), 8)
  assert.equal(requiredMajor('1.17.1'), 16)
  assert.equal(requiredMajor('1.18.2'), 17)
  assert.equal(requiredMajor('1.20.4'), 17)
  assert.equal(requiredMajor('1.20.5'), 21)
  assert.equal(requiredMajor('1.21'), 21)
  assert.equal(requiredMajor('1.21.4'), 21)
  assert.equal(requiredMajor('26.1'), 25)
  assert.equal(requiredMajor('26.2.1'), 25)
  for (const odd of ['25w14a', '1.21.4-pre1', 'latest', '', null, undefined]) {
    assert.equal(requiredMajor(odd), null, `"${odd}" must not be guessed at`)
  }
})

test('picking a Java refuses one that is certainly too old, unless forced', async () => {
  const { best } = await discover()
  if (!best) return
  const impossible = best.major + 50
  await assert.rejects(pickJava({ needs: impossible, what: 'a future version' }), (err) => {
    assert.ok(err instanceof UserError)
    assert.equal(err.code, 'java-too-old')
    assert.equal(err.needs, impossible)
    assert.equal(err.have, best.major)
    return true
  })
  const forced = await pickJava({ needs: impossible, force: true })
  assert.ok(forced === 'java' || forced === best.path)
  const fine = await pickJava({ needs: best.major })
  assert.ok(fine === 'java' || fine === best.path)
  assert.equal(await pickJava({}), await defaultJava())
})
