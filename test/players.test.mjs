import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-players-'))
process.env.MCCTL_DATA_ROOT = ROOT

const players = await import('../src/players.mjs')
const plugins = await import('../src/plugins.mjs')

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const STEVE = '11111111-2222-3333-4444-555555555555'

function server(name) {
  const dir = path.join(ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n')
  fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify([{ uuid: STEVE, name: 'Steve', expiresOn: '2030-01-01 00:00:00 +0000' }]))
  return { name, dir }
}

test('opping through a running server is reported from its list, not from its reply', async () => {
  const inst = server('ops')
  // the server does it: the list has the player by the time the reply arrives
  const does = async (i, [cmd]) => {
    assert.equal(cmd, 'op Steve')
    fs.writeFileSync(path.join(i.dir, 'ops.json'), JSON.stringify([{ uuid: STEVE, name: 'Steve', level: 4 }]))
    return ['Made Steve a server operator']
  }
  const yes = await players.setOp(inst, STEVE, true, { running: true, exec: does })
  assert.equal(yes.via, 'console')
  assert.equal(yes.took, true)

  // the server refuses, in the same kind of sentence
  const refuses = async () => ['§cThat player does not exist']
  const no = await players.setOp(inst, STEVE, false, { running: true, exec: refuses })
  assert.equal(no.took, false)
  assert.equal(no.reply, 'That player does not exist')

  // "nothing changed, already an operator" is still the state that was asked for
  const already = await players.setOp(inst, STEVE, true, { running: true, exec: async () => ['Nothing changed. The player already is an operator'] })
  assert.equal(already.took, true)
})

test('a ban through a running server is matched by name on an offline-mode server', async () => {
  const inst = server('bans')
  // an offline-mode server files the player under an id of its own
  const does = async (i, [cmd]) => {
    assert.equal(cmd, 'ban Steve griefing')
    fs.writeFileSync(path.join(i.dir, 'banned-players.json'), JSON.stringify([{ uuid: 'aaaaaaaa-0000-3000-8000-000000000000', name: 'steve', reason: 'griefing' }]))
    return ['Banned Steve: griefing']
  }
  assert.equal((await players.setBan(inst, STEVE, true, 'griefing', { running: true, exec: does })).took, true)
  assert.equal((await players.setBan(inst, STEVE, false, '', { running: true, exec: async () => ['Nothing changed. The player isn\'t banned'] })).took, false)
})

test('a stopped server is changed in its files, with nothing to doubt', async () => {
  const inst = server('files')
  const out = await players.setOp(inst, STEVE, true, { running: false })
  assert.equal(out.via, 'file')
  assert.equal(out.took, undefined)
  assert.equal(JSON.parse(fs.readFileSync(path.join(inst.dir, 'ops.json'), 'utf8'))[0].name, 'Steve')
})

test('an update check with nothing it can ask about says so, and asks nobody', async () => {
  const inst = { ...server('plugs'), loader: 'paper' }
  fs.mkdirSync(path.join(inst.dir, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(inst.dir, 'plugins', 'ByHand.jar'), 'not a real jar')
  fs.writeFileSync(path.join(inst.dir, 'plugins', 'Other.jar'), 'not a real jar')
  const report = await plugins.checkUpdatesReport(inst)
  assert.deepEqual(report, { updates: [], checked: 0, byHand: 2, off: 0, pack: 0, unreachable: [] })
  assert.deepEqual(await plugins.checkUpdates(inst), [])
})
