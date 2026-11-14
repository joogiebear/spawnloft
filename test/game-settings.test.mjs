/** The game settings a server is offered: which rows, for which version, and what Save refuses. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-game-settings-'))
process.env.APPDATA = path.join(scratch, 'config')
process.env.XDG_CONFIG_HOME = path.join(scratch, 'config')
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
const { EDITABLE_PROPS, propsFor, unescapedProp, serve } = await import('../src/ui.mjs')
const registry = await import('../src/registry.mjs')
const { readProps } = await import('../src/props.mjs')
const { panelFetch } = await import('./helpers/panel.mjs')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const RULES = ['pvp', 'spawn-monsters', 'allow-nether', 'enable-command-block']
const keys = (list) => list.map((p) => p.key)

test('every setting says what it does, and a number says what it counts', () => {
  for (const p of EDITABLE_PROPS) {
    if (p.key !== 'motd') assert.ok(p.note && /[.]$/.test(p.note), `${p.key} has no note`)
    assert.ok(['access', 'gameplay', 'world'].includes(p.group), `${p.key} is in no section`)
    if (p.type === 'int') {
      assert.ok(Number.isInteger(p.min) && Number.isInteger(p.max) && p.min < p.max, `${p.key} has no range`)
      const fallback = Number(p.fallback)
      assert.ok(fallback >= p.min && fallback <= p.max, `${p.key} defaults outside its own range`)
    }
    if (p.type === 'enum') assert.ok(p.options.includes(p.fallback))
    if (p.type === 'bool') assert.ok(['true', 'false'].includes(p.fallback))
  }
  assert.equal(new Set(keys(EDITABLE_PROPS)).size, EDITABLE_PROPS.length, 'a key is listed twice')
  for (const key of ['view-distance', 'simulation-distance', 'spawn-protection', 'player-idle-timeout', 'max-world-size']) {
    assert.ok(EDITABLE_PROPS.find((p) => p.key === key).unit, `${key} does not say its unit`)
  }
})

test('a version is shown only the rows it reads', () => {
  const old = keys(propsFor('1.16.5'))
  for (const key of ['simulation-distance', 'hide-online-players', 'require-resource-pack']) assert.ok(!old.includes(key), key)
  for (const key of ['pvp', 'view-distance', 'resource-pack', 'allow-flight']) assert.ok(old.includes(key), key)
  assert.ok(keys(propsFor('1.17.1')).includes('require-resource-pack'))
  assert.ok(!keys(propsFor('1.17.1')).includes('simulation-distance'))
  assert.ok(keys(propsFor('1.18')).includes('simulation-distance'))
  assert.ok(propsFor('1.20.4').every((p) => !p.gameRule))
})

test('what became a game rule is marked from the version that moved it', () => {
  const marked = (v) => propsFor(v).filter((p) => p.gameRule).map((p) => p.key).sort()
  assert.deepEqual(marked('1.21.8'), [])
  assert.deepEqual(marked('1.21.9'), [...RULES].sort())
  assert.deepEqual(marked('1.21.10'), [...RULES].sort(), '1.21.10 is after 1.21.9, not before')
  // the year-style versions come after every 1.x
  for (const v of ['26.1', '26.2.1']) {
    assert.deepEqual(marked(v), [...RULES].sort(), v)
    assert.ok(keys(propsFor(v)).includes('simulation-distance'), v)
  }
  // a release candidate or a snapshot of a version is read as that version
  assert.deepEqual(marked('1.21.9-rc1'), [...RULES].sort())
  assert.deepEqual(marked('26.1-snapshot-2'), [...RULES].sort())
  assert.deepEqual(marked('1.21.8-pre2'), [])
  assert.ok(!keys(propsFor('1.12.2')).includes('enforce-whitelist'))
  assert.ok(keys(propsFor('1.13')).includes('enforce-whitelist'))
  // the list itself is not written on
  assert.ok(EDITABLE_PROPS.every((p) => !('gameRule' in p)))
})

test('with no version known, every row is offered as the file’s', () => {
  for (const v of [null, undefined, '', 'latest', '24w14a']) {
    const out = propsFor(v)
    assert.equal(out.length, EDITABLE_PROPS.length)
    assert.ok(out.every((p) => !p.gameRule))
  }
})

function server(name, jar, port, mcVersion) {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, jar), '')
  fs.writeFileSync(path.join(dir, 'server.properties'), 'pvp=true\nmotd=hello\n')
  registry.putInstance(name, { dir, jar, memory: '1G', port, ...(mcVersion ? { mcVersion } : {}) })
  return dir
}

test('the panel offers and saves by the server’s version', async () => {
  const oldDir = server('older', 'server.jar', 41801, '1.20.4')
  const newDir = server('newer', 'server.jar', 41802, '1.21.10')
  const panel = await serve({ port: 0 })
  const at = (name) => `${panel.url}api/instances/${name}/props`
  const save = (name, body) => panelFetch(at(name), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const older = await (await panelFetch(at('older'))).json()
    const pvp = older.fields.find((f) => f.key === 'pvp')
    assert.equal(pvp.gameRule, undefined)
    assert.equal(pvp.value, 'true')
    assert.equal(pvp.set, true)
    const idle = older.fields.find((f) => f.key === 'player-idle-timeout')
    assert.deepEqual([idle.value, idle.set, idle.unit], ['0', false, 'minutes'])

    // a link, or nothing
    for (const bad of ['https://example.com/p.zip\\', 'https://example.com/a\\u00e9.zip', 'pack.zip', 'ftp://example.com/p.zip', 'https://example.com/a b.zip', 'https://example.com/p.zip\nop-permission-level=4', 'javascript:alert(1)']) {
      const res = await save('older', { 'resource-pack': bad })
      assert.equal(res.status, 400, bad)
      assert.match((await res.json()).error, /http/)
    }
    assert.equal((await save('older', { 'resource-pack': 'https://example.com/packs/p.zip?v=2' })).status, 200)
    assert.equal(readProps(path.join(oldDir, 'server.properties')).get('resource-pack'), 'https://example.com/packs/p.zip?v=2')
    assert.equal((await save('older', { 'resource-pack': '' })).status, 200)
    assert.equal(readProps(path.join(oldDir, 'server.properties')).get('resource-pack'), '')

    // what Java would read as an escape is refused in text: a backslash at the end takes the next
    // line of the file with it, and a bad \u stops the file loading
    for (const bad of ['abc\\', 'abc\\\\\\', 'seed\\uZZ12']) assert.equal((await save('older', { 'level-seed': bad })).status, 400, bad)
    for (const fine of ['abc\\\\', '\\u00a7aGreen', 'plain seed 123']) assert.equal((await save('older', { 'level-seed': fine })).status, 200, fine)
    // Minecraft writes the link back with its colon and equals escaped; it is shown as it was typed
    fs.appendFileSync(path.join(oldDir, 'server.properties'), '')
    fs.writeFileSync(path.join(oldDir, 'server.properties'), 'pvp=true\nmotd=hello\nresource-pack=https\\://example.com/p.zip?v\\=2\n')
    const read = await (await panelFetch(at('older'))).json()
    assert.equal(read.fields.find((f) => f.key === 'resource-pack').value, 'https://example.com/p.zip?v=2')
    assert.equal(unescapedProp('a\\:b\\=c\\\\d'), 'a:b=c\\\\d')
    // a row this version does not have is not saved to it
    registry.updateInstance('older', { mcVersion: '1.16.5' })
    assert.equal((await save('older', { 'simulation-distance': '6' })).status, 400)
    registry.updateInstance('older', { mcVersion: '1.20.4' })

    // ranges hold for the new numbers
    assert.equal((await save('older', { 'op-permission-level': '5' })).status, 400)
    assert.equal((await save('older', { 'simulation-distance': '2' })).status, 400)
    assert.equal((await save('older', { 'simulation-distance': '6', pvp: 'false', hardcore: 'true' })).status, 200)
    const saved = readProps(path.join(oldDir, 'server.properties'))
    assert.deepEqual([saved.get('simulation-distance'), saved.get('pvp'), saved.get('hardcore'), saved.get('motd')], ['6', 'false', 'true', 'hello'])

    // the newer server: the row is there and marked, and saving it is refused with the way to do it
    const newer = await (await panelFetch(at('newer'))).json()
    assert.equal(newer.fields.find((f) => f.key === 'pvp').gameRule, true)
    assert.equal(newer.fields.find((f) => f.key === 'hardcore').gameRule, undefined)
    // a form drawn before the upgrade sends both: the game rule is left out and named, the rest saved
    const res = await save('newer', { pvp: 'false', hardcore: 'true' })
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.deepEqual(out.ignored, [{ key: 'pvp', label: 'PvP' }])
    assert.deepEqual(out.changed, ['hardcore'])
    const after = readProps(path.join(newDir, 'server.properties'))
    assert.equal(after.get('pvp'), 'true')
    assert.equal(after.get('hardcore'), 'true')
    // only a game rule: nothing is written, and that is said, not called an error
    const only = await save('newer', { pvp: 'false' })
    assert.equal(only.status, 200)
    assert.deepEqual((await only.json()).changed, [])
    assert.equal(readProps(path.join(newDir, 'server.properties')).get('pvp'), 'true')
  } finally {
    panel.server.closeAllConnections()
    await new Promise((resolve) => panel.server.close(resolve))
  }
})
