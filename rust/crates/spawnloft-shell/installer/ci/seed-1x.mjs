/**
 * Seeds a 1.x install for the installer scenarios, through that install's own modules: run by
 * the installed SpawnLoft.exe as Node (ELECTRON_RUN_AS_NODE=1), so the registry, data root and
 * database setup are exactly 1.x's.
 *
 *   SpawnLoft.exe seed-1x.mjs <1.x core dir> <spec json file>
 *
 * spec: { servers: [{ name, ignoreStop? }], databases: [name], fixtures: <dir with fake-java.mjs
 * and fake-mariadb> }. Prints { dataRoot, servers: { name: dir }, databases: { name: dir } }.
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [coreDir, specFile] = process.argv.slice(2)
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8').replace(/^﻿/, ''))
const mod = (p) => import(pathToFileURL(path.join(coreDir, 'src', p)).href)
const { putInstance } = await mod('registry.mjs')
const paths = await mod('paths.mjs')
const services = await mod('services.mjs')

function freePort(from) {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(freePort(from + 1)))
    s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)))
  })
}

const out = { dataRoot: paths.DATA_ROOT, servers: {}, databases: {} }
let port = 41000
for (const s of spec.servers || []) {
  const dir = path.join(paths.INSTANCES_DIR, s.name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.jar'), '')
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  if (s.ignoreStop) fs.writeFileSync(path.join(dir, 'ignore-stop'), '')
  port = await freePort(port + 1)
  const rcon = await freePort(port + 1)
  putInstance(s.name, {
    dir,
    jar: 'server.jar',
    java: path.join(spec.fixtures, 'fake-java.mjs'),
    memory: '1G',
    port,
    rcon: { port: rcon, password: 'installer-ci' },
  })
  port = rcon
  out.servers[s.name] = dir
}
if ((spec.databases || []).length) {
  const engine = path.join(paths.ENGINES_DIR, 'mariadb-0.0.0-fake')
  fs.mkdirSync(engine, { recursive: true })
  fs.cpSync(path.join(spec.fixtures, 'fake-mariadb'), engine, { recursive: true })
  for (const name of spec.databases) {
    const db = await services.createDatabase(name, { engine: 'mariadb', version: '0.0.0-fake' })
    out.databases[name] = db.dir
  }
}
process.stdout.write(JSON.stringify(out) + '\n')
