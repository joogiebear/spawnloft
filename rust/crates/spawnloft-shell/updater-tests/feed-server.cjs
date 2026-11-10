// A static loopback server for the updater scenarios: serves one feed folder written by
// make-feed.mjs (releases.atom, api/releases, download/<tag>/<asset>) and switches folders when
// told to, so the app under test keeps one base URL while the scenario changes the feed.
//
//   node feed-server.cjs <feed root> <port file> [<initial variant>]
//   (FEED_PORT=<n> listens on that port instead of a free one: the macOS feed is built for a fixed base)
//
// GET /__variant            -> the folder being served
// POST /__variant/<name>    -> serve <feed root>/<name> from now on (a test control, loopback only)
// GET /__hits               -> request counts per path (to assert what the client fetched)
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const [root, portFile, initial = 'good'] = process.argv.slice(2)
let variant = initial
const hits = {}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = decodeURIComponent(url.pathname)
  hits[p] = (hits[p] || 0) + 1
  if (p === '/__variant' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(variant) }
  if (p.startsWith('/__variant/') && req.method === 'POST') {
    const name = p.slice('/__variant/'.length)
    if (!fs.existsSync(path.join(root, name))) { res.writeHead(404); return res.end(`no feed ${name}`) }
    variant = name
    res.writeHead(200); return res.end(variant)
  }
  if (p === '/__hits') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(hits)) }
  // api/releases?per_page=100&page=1: only page 1 holds anything
  const rel = p.replace(/^\/+/, '')
  if (rel.startsWith('api/releases') && url.searchParams.get('page') && url.searchParams.get('page') !== '1') {
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]')
  }
  const dir = path.join(root, variant)
  const file = path.join(dir, rel)
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-length': fs.statSync(file).size })
  fs.createReadStream(file).pipe(res)
}).listen(Number(process.env.FEED_PORT) || 0, '127.0.0.1', function () {
  fs.writeFileSync(portFile, String(this.address().port))
  console.log(`feed server on 127.0.0.1:${this.address().port} serving ${root} (${variant})`)
})
