/**
 * Every registered server and database with its status, through a core's own readState: run by
 * 1.x's SpawnLoft.exe as Node for the 1.x view, or by the machine's Node over the 2.0 install's
 * resources\core for 2.0's. (No shipped 1.x answers `list --json`.)
 *
 *   <node> list.mjs <core dir>   prints [{ name, kind, status, daemonPid, javaPid, daemonExe }]
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const coreDir = process.argv[2]
const mod = (p) => import(pathToFileURL(path.join(coreDir, 'src', p)).href)
const { listAll } = await mod('registry.mjs')
const { readState } = await mod('control.mjs')
const out = listAll().map((i) => {
  const { status, state } = readState(i.name)
  return {
    name: i.name,
    kind: i.kind === 'database' ? 'database' : 'server',
    status,
    daemonPid: state?.daemonPid ?? null,
    javaPid: state?.javaPid ?? null,
    daemonExe: state?.daemonExe ?? null,
  }
})
process.stdout.write(JSON.stringify(out) + '\n')
