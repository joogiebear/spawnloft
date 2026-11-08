#!/usr/bin/env node
// Experiment 4a (PHASE0-FINDINGS.md): a local electron-updater "generic" feed on 127.0.0.1.
//
//   node feed-server.mjs <dir> [port]        default port 8099
//
// <dir> holds the signed installer to offer (SpawnLoft-Setup-<version>.exe), its .blockmap if
// you have it, and the release's beta.yml. The same yml is served as latest.yml, so the
// install's channel choice does not matter. Nothing here is reachable from another machine.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const [dir, portArg] = process.argv.slice(2)
if (!dir) { console.error('usage: node feed-server.mjs <dir> [port]'); process.exit(2) }
const port = Number(portArg || 8099)
const root = path.resolve(dir)

const server = http.createServer((req, res) => {
  let name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1))
  if (name === 'latest.yml' && !fs.existsSync(path.join(root, name))) name = 'beta.yml'
  const file = path.join(root, path.basename(name))
  const stamp = new Date().toISOString()
  if (!fs.existsSync(file)) {
    console.log(`${stamp} ${req.method} ${req.url} -> 404`)
    res.writeHead(404); res.end('not found'); return
  }
  const size = fs.statSync(file).size
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
  console.log(`${stamp} ${req.method} ${req.url}${range ? ` range ${range[0]}` : ''} -> 200 (${size} bytes)`)
  if (req.method === 'HEAD') { res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' }); res.end(); return }
  if (range) {
    const start = Number(range[1]); const end = range[2] ? Number(range[2]) : size - 1
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' })
    fs.createReadStream(file, { start, end }).pipe(res); return
  }
  res.writeHead(200, { 'content-length': size, 'accept-ranges': 'bytes' })
  fs.createReadStream(file).pipe(res)
})
server.listen(port, '127.0.0.1', () => console.log(`feed at http://127.0.0.1:${port}/ serving ${root}`))
