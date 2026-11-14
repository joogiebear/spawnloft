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
  assert.deepEqual(report, { updates: [], checked: 0, byHand: 2, off: 0, pack: 0, unknown: 0, unreachable: [] })
  assert.deepEqual(await plugins.checkUpdates(inst), [])
})

const ALEX = '069a79f4-44e9-4726-a5be-fca90e38aaf5'
const readJson = (inst, file) => JSON.parse(fs.readFileSync(path.join(inst.dir, file), 'utf8'))
const noLookup = async () => assert.fail('nothing should be looked up')

test('the whitelist: a stopped server\'s file, a running server\'s console', async () => {
  const inst = server('wl')
  const on = await players.setWhitelisted(inst, STEVE, true, { running: false })
  assert.equal(on.via, 'file')
  assert.deepEqual(readJson(inst, 'whitelist.json'), [{ uuid: STEVE, name: 'Steve' }])
  assert.equal(players.listPlayers(inst).find((p) => p.uuid === STEVE).whitelisted, true)
  // twice is still once
  await players.setWhitelisted(inst, STEVE, true, { running: false })
  assert.equal(readJson(inst, 'whitelist.json').length, 1)
  await players.setWhitelisted(inst, STEVE, false, { running: false })
  assert.deepEqual(readJson(inst, 'whitelist.json'), [])

  // running: the server is told, and its list is the result
  const does = async (i, [cmd]) => {
    assert.equal(cmd, 'whitelist add Steve')
    fs.writeFileSync(path.join(i.dir, 'whitelist.json'), JSON.stringify([{ uuid: STEVE, name: 'Steve' }]))
    return ['Added Steve to the whitelist']
  }
  assert.equal((await players.setWhitelisted(inst, STEVE, true, { running: true, exec: does })).took, true)
  const refuses = async (i, [cmd]) => { assert.equal(cmd, 'whitelist remove Steve'); return ['§cPlayer is not whitelisted'] }
  assert.equal((await players.setWhitelisted(inst, STEVE, false, { running: true, exec: refuses })).took, false)
})

test('the whitelist switch is the server.properties line, or the console while it runs', async () => {
  const inst = server('wl-mode')
  assert.equal(players.whitelistOn(inst), false)
  assert.deepEqual(await players.setWhitelistOn(inst, true, { running: false }), { on: true, via: 'file' })
  assert.equal(players.whitelistOn(inst), true)
  // the level name beside it is still there
  assert.match(fs.readFileSync(path.join(inst.dir, 'server.properties'), 'utf8'), /level-name=world/)
  await players.setWhitelistOn(inst, false, { running: false })
  assert.equal(players.whitelistOn(inst), false)

  // running: the server is told first, and a server that did not do it leaves the file alone
  const says = (text) => async (i, [cmd]) => { assert.equal(cmd, 'whitelist on'); return [text] }
  assert.equal((await players.setWhitelistOn(inst, true, { running: true, exec: says('Unknown command') })).took, false)
  assert.equal(players.whitelistOn(inst), false)
  // Paper changes it in memory only: the file is written too, or the next start undoes it
  const took = await players.setWhitelistOn(inst, true, { running: true, exec: says('§aWhitelist is now turned on') })
  assert.equal(took.via, 'console')
  assert.equal(took.took, true)
  assert.equal(players.whitelistOn(inst), true)
  assert.equal((await players.setWhitelistOn(inst, true, { running: true, exec: says('Whitelist is already turned on') })).took, true)
})

test('a player is added by name: looked up with Mojang on a stopped server that checks accounts', async () => {
  const inst = server('add-online')
  const asked = []
  const lookup = async (name) => { asked.push(name); return { uuid: ALEX, name: 'Alex' } }
  const out = await players.addByName(inst, ' alex ', 'whitelist', { running: false, lookup })
  assert.deepEqual(asked, ['alex'])
  // the name as the account spells it, under the account's id
  assert.equal(out.name, 'Alex')
  assert.equal(out.as, 'whitelist')
  assert.deepEqual(readJson(inst, 'whitelist.json'), [{ uuid: ALEX, name: 'Alex' }])

  // an operator and a ban the same way, with the ban's reason
  await players.addByName(inst, 'Alex', 'op', { running: false, lookup: noLookup })
  assert.equal(readJson(inst, 'ops.json')[0].uuid, ALEX)
  await players.addByName(inst, 'Griefer', 'ban', { running: false, reason: 'griefing', lookup: async () => ({ uuid: '22222222-3333-4444-8555-666666666666', name: 'Griefer' }) })
  const ban = readJson(inst, 'banned-players.json')[0]
  assert.equal(ban.name, 'Griefer')
  assert.equal(ban.reason, 'griefing')

  // nobody has that name, and Mojang cannot be reached: both said, neither written
  await assert.rejects(players.addByName(inst, 'Nobody_Here', 'whitelist', { running: false, lookup: async () => null }), /No Minecraft account is called "Nobody_Here"/)
  await assert.rejects(players.addByName(inst, 'Offline', 'whitelist', { running: false, lookup: async () => { throw new Error('fetch failed') } }),
    /Could not look up "Offline" with Mojang \(fetch failed\).*start the server/)
  assert.equal(readJson(inst, 'whitelist.json').length, 1)

  for (const bad of ['', 'two words', 'way_too_long_for_a_name', 'semi;colon', '../etc']) {
    await assert.rejects(players.addByName(inst, bad, 'whitelist', { running: false, lookup: noLookup }), /up to 16 letters, digits or underscores/, bad)
  }
  await assert.rejects(players.addByName(inst, 'Alex', 'kick', { running: false, lookup: noLookup }), /unknown way to add/)
})

test('added by name without a lookup: someone already known, a server that checks nobody, a running server', async () => {
  // known already: the id the server knows them by
  const known = server('add-known')
  const out = await players.addByName(known, 'steve', 'whitelist', { running: false, lookup: noLookup })
  assert.equal(out.name, 'Steve')
  assert.deepEqual(readJson(known, 'whitelist.json'), [{ uuid: STEVE, name: 'Steve' }])

  // accounts are not checked: the id is the one such a server makes from the name
  const offline = server('add-offline')
  fs.writeFileSync(path.join(offline.dir, 'server.properties'), 'level-name=world\nonline-mode=false\n')
  await players.addByName(offline, 'Notch', 'whitelist', { running: false, lookup: noLookup })
  const row = readJson(offline, 'whitelist.json')[0]
  assert.equal(row.name, 'Notch')
  assert.match(row.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

  // running: the server is told the name and finds the player itself
  const running = server('add-running')
  const sent = []
  const does = async (i, [cmd]) => {
    sent.push(cmd)
    fs.writeFileSync(path.join(i.dir, 'whitelist.json'), JSON.stringify([{ uuid: ALEX, name: 'Alex' }]))
    return ['Added Alex to the whitelist']
  }
  const added = await players.addByName(running, 'Alex', 'whitelist', { running: true, exec: does, lookup: noLookup })
  assert.deepEqual(sent, ['whitelist add Alex'])
  assert.equal(added.took, true)
  // and when it does not know the name, that is the answer
  const refused = await players.addByName(running, 'Ghost', 'op', { running: true, exec: async () => ['§cThat player does not exist'], lookup: noLookup })
  assert.equal(refused.took, false)
  assert.equal(refused.reply, 'That player does not exist')
})

test('Mojang\'s answer is read as an id and a name, or as nobody', async () => {
  const answer = (status, body) => async (url) => {
    assert.equal(url, 'https://api.mojang.com/users/profiles/minecraft/Alex')
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  }
  assert.deepEqual(await players.mojangLookup('Alex', { fetchImpl: answer(200, { id: '069a79f444e94726a5befca90e38aaf5', name: 'Alex' }) }), { uuid: ALEX, name: 'Alex' })
  assert.equal(await players.mojangLookup('Alex', { fetchImpl: answer(404, {}) }), null)
  assert.equal(await players.mojangLookup('Alex', { fetchImpl: answer(204, {}) }), null)
  await assert.rejects(players.mojangLookup('Alex', { fetchImpl: answer(429, {}) }), /Mojang answered 429/)
  await assert.rejects(players.mojangLookup('Alex', { fetchImpl: answer(200, { id: 'nope' }) }), /could not read/)
})
