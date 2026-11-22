'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

// A small Redis protocol client: sends the commands in order (AUTH first when a password is
// given) and resolves with the last reply; an error reply rejects with its text.
function respSend(host, port, commands, { password = null, timeout = 5000 } = {}) {
  const queue = [...(password ? [['AUTH', password]] : []), ...commands]
  const encode = args => `*${args.length}\r\n` + args.map(a => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join('')
  const parse = buf => {
    const nl = buf.indexOf('\r\n')
    if (nl === -1) return null
    const kind = buf[0]
    const body = buf.slice(1, nl)
    const after = buf.slice(nl + 2)
    if (kind === '-') return { error: body, after }
    if (kind === '$') {
      const len = Number(body)
      if (len === -1) return { value: null, after }
      if (after.length < len + 2) return null
      return { value: after.slice(0, len), after: after.slice(len + 2) }
    }
    if (kind === '*') {
      let more = after
      const items = []
      for (let i = 0; i < Number(body); i++) {
        const r = parse(more)
        if (!r) return null
        items.push(r.value)
        more = r.after
      }
      return { value: items, after: more }
    }
    return { value: body, after }
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let buf = ''
    let sent = 0
    let last = null
    let settled = false
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); fn(v) } }
    const timer = setTimeout(() => done(reject, new Error(`no reply from ${host}:${port} within ${timeout}ms`)), timeout)
    const next = () => sent >= queue.length ? done(resolve, last) : socket.write(encode(queue[sent++]))
    socket.on('connect', next)
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      for (let r = parse(buf); r; r = parse(buf)) {
        buf = r.after
        if (r.error) return done(reject, new Error(`${host}:${port} refused: ${r.error}`))
        last = r.value
        next()
      }
    })
    socket.on('close', () => done(reject, new Error(`${host}:${port} closed the connection`)))
    socket.on('error', err => done(reject, new Error(`could not reach ${host}:${port}: ${err.message}`)))
  })
}

module.exports = async function smokeRedis({ page, api, cli, env, data, name, output, record }) {
  const dbName = `${name}-cache`
  const engines = await api('databases/engines')
  assert.deepEqual(engines.map(e => e.id).sort(), ['garnet', 'mysql'])
  // Redis is managed everywhere; MySQL is too except Linux arm64, where Oracle publishes no small
  // build and the panel must say so
  const mysqlExpected = !(process.platform === 'linux' && process.arch !== 'x64')
  assert.deepEqual(Object.fromEntries(engines.map(e => [e.id, e.managed])), { garnet: true, mysql: mysqlExpected })
  await page.locator('#bNew').click()
  await page.locator('#vAdd [data-tab="db"]').click()
  await page.waitForFunction(() => document.querySelectorAll('#dEngine option').length === 2)
  assert.deepEqual(await page.locator('#dEngine option').evaluateAll(opts => opts.map(o => o.value).sort()), ['garnet', 'mysql'])
  await page.locator('#dEngine').selectOption('garnet')
  assert.equal(await page.locator('#dEngine option:checked').isDisabled(), false)
  await page.locator('#bAddClose').click()
  const config = path.join(data, 'instances', name, 'plugins', 'LuckPerms', 'config.yml')
  const before = fs.readFileSync(config, 'utf8')
  const versions = await api('databases/versions?engine=garnet')
  assert.ok(versions.length, 'Redis has a native version available')
  await api('databases', { name: dbName, engine: 'garnet', version: versions[0].version }, 600000)
  // the registry record the panel wrote, read as any program reads instances.json
  const registryRecord = () => JSON.parse(fs.readFileSync(path.join(data, 'instances.json'), 'utf8')).instances[dbName]
  const statements = async phase => {
    const db = registryRecord()
    const send = commands => respSend('127.0.0.1', db.port, commands, { password: db.root.password })
    assert.equal(await send([['PING']]), 'PONG')
    await assert.rejects(respSend('127.0.0.1', db.port, [['PING']], { password: 'incorrect' }), /WRONGPASS|invalid|auth/i)
    await assert.rejects(respSend('127.0.0.1', db.port, [['GET', 'spawnloft-smoke']]), /NOAUTH|auth/i)
    if (phase === 'write') assert.equal(await send([['SET', 'spawnloft-smoke', 'persisted']]), 'OK')
    else assert.equal(await send([['GET', 'spawnloft-smoke']]), 'persisted')
    record('PASS: Redis ' + phase + ', password enforced')
  }
  try {
    await cli(['start', dbName, '--timeout', '60'], 75000)
    await cli(['db', 'attach', dbName, name])
    await statements('write')
    await cli(['stop', dbName], 60000)
    await api(`instances/${dbName}/start`, {})
    await statements('read')
    await cli(['restart', dbName, '--timeout', '60'], 90000)
    await statements('read')
    assert.equal(fs.readFileSync(config, 'utf8'), before)
    record('PASS: native Redis (Garnet) downloaded and verified; authenticated writes survive stop/start and restart; plugin configs unchanged')
  } finally { await cli(['stop', dbName], 60000) }
}
