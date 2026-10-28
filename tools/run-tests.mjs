// npm test: runs every test/*.test.mjs. Node 20's --test does not expand a glob itself (21 and
// later do), and Windows shells do not expand one either, so the list is made here.
// Extra arguments go to node before the files, e.g. npm test -- --test-name-pattern=client; a file
// named there runs on top of the whole suite, so run one file with node --test test/<file> instead.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test')
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('test', f))
const res = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit', cwd: path.join(testDir, '..') })
process.exit(res.status ?? 1)
