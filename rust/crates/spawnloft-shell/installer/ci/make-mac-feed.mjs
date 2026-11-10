// The loopback 2.x feed for the macOS plugin cycle (design section 6 "verify on the mini", section 11
// scenario 5): one `good` folder that updater-tests/feed-server.cjs serves at <base>, laid out as
// the core reads a test source (SPAWNLOFT_UPDATE_SOURCE): releases.atom, api/releases and
// download/v<version>/ with the Tauri artifact and the signed envelope.
//
//   node make-mac-feed.mjs --out <root> --base http://127.0.0.1:<port>/ --tauri <tauri cli>
//        --key <throwaway private key> --pubkey <its .pub> --release <version>=<mac-package out dir> ...
//
// Each release's SpawnLoft-<v>-mac-arm64.app.tar.gz (from mac-package.mjs) is copied in and
// signed again with `tauri signer sign --app-version <v>` under that name, as the release
// pipeline does after renaming (the signature `tauri build` made names SpawnLoft.app.tar.gz and no
// version, which the client refuses). Then desktop/update-envelope.mjs writes and signs the
// envelope with the same key. Versions must be beta (internal builds have no update channel).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { main: envelopeMain, ENVELOPE_FILE } = await import(pathToFileURL(path.join(here, '..', '..', '..', '..', '..', 'desktop', 'update-envelope.mjs')).href)

const args = process.argv.slice(2)
const opt = { releases: [] }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  const v = () => args[++i]
  if (a === '--out') opt.out = v()
  else if (a === '--base') opt.base = v()
  else if (a === '--tauri') opt.tauri = v()
  else if (a === '--key') opt.key = v()
  else if (a === '--pubkey') opt.pubkey = v()
  else if (a === '--release') { const [version, dir] = v().split('='); opt.releases.push({ version, dir }) }
  else throw new Error(`unknown argument ${a}`)
}
for (const k of ['out', 'base', 'tauri', 'key', 'pubkey']) if (!opt[k]) throw new Error(`--${k} is required`)
if (!opt.releases.length) throw new Error('at least one --release is needed')
const base = opt.base.endsWith('/') ? opt.base : `${opt.base}/`
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(opt.key, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' }

function sign(file, version) {
  execFileSync(opt.tauri, ['signer', 'sign', '--app-version', version, file], { env, stdio: ['ignore', 'pipe', 'inherit'] })
}

const feed = path.join(opt.out, 'good')
fs.rmSync(opt.out, { recursive: true, force: true })
fs.mkdirSync(path.join(feed, 'api'), { recursive: true })
const atom = opt.releases.map(r => `  <entry>\n    <id>tag:github.com,2008:Repository/1/v${r.version}</id>\n    <link rel="alternate" type="text/html" href="https://github.com/joogiebear/spawnloft/releases/tag/v${r.version}"/>\n    <title>v${r.version}</title>\n  </entry>`).join('\n')
fs.writeFileSync(path.join(feed, 'releases.atom'), `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n${atom}\n</feed>\n`)
fs.writeFileSync(path.join(feed, 'api', 'releases'), JSON.stringify(opt.releases.map(r => ({ tag_name: `v${r.version}`, draft: false, prerelease: r.version.includes('-') }))))

for (const r of opt.releases) {
  const name = `SpawnLoft-${r.version}-mac-arm64.app.tar.gz`
  const src = path.join(r.dir, name)
  if (!fs.existsSync(src)) throw new Error(`${src} is missing (run mac-package.mjs first)`)
  const dist = path.join(feed, 'download', `v${r.version}`)
  fs.mkdirSync(dist, { recursive: true })
  fs.copyFileSync(src, path.join(dist, name))
  sign(path.join(dist, name), r.version)
  envelopeMain(['--dist', dist, '--version', r.version, '--pubkey', opt.pubkey, '--download-base', `${base}download/`, '--no-sign'])
  sign(path.join(dist, ENVELOPE_FILE), r.version)
}
console.log(`mac feed for ${opt.releases.map(r => r.version).join(', ')} written under ${feed} (base ${base})`)
