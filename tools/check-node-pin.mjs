// Is the pinned Node runtime still the newest LTS? (plan D7, Q-X.) The Node that SpawnLoft ships
// (desktop/build-cli-package.mjs NODE_VERSION, with its nodejs.org sha256s pinned in source) and
// that CI tests on (.node-version) is bumped by hand, in its own commit, through the full
// installer workflows. Dependabot cannot see a pin like that, so this check does: it reads
// nodejs.org's release index and fails when a newer LTS exists, saying whether the newer releases
// in the pinned line include a security release and printing the sha256 lines the bump needs.
// It also fails when .node-version and NODE_VERSION disagree.
//
//   node tools/check-node-pin.mjs [--report <file.md>]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const INDEX_URL = 'https://nodejs.org/dist/index.json'
export const NODE_VERSION_FILE = path.join(ROOT, '.node-version')

const key = v => v.replace(/^v/, '').split('.').map(Number)
const newer = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }

// From nodejs.org's index rows ({ version: 'v24.22.2', lts: 'Krypton' | false, security, date }),
// what is newer than `pinned`: the newest LTS overall, the newest in the pinned major, and whether
// any release between the pin and that one is a security release.
export function compare(pinned, rows) {
  const lts = rows.filter(r => r.lts).map(r => ({ ...r, version: r.version.replace(/^v/, '') }))
  const major = key(pinned)[0]
  const sameLine = lts.filter(r => key(r.version)[0] === major && newer(r.version, pinned))
  const newest = lts.reduce((best, r) => (!best || newer(r.version, best.version) ? r : best), null)
  const newestInLine = sameLine.reduce((best, r) => (!best || newer(r.version, best.version) ? r : best), null)
  return {
    pinned,
    newest: newest && newer(newest.version, pinned) ? newest : null,
    newestInLine,
    security: sameLine.filter(r => r.security).map(r => r.version).sort((a, b) => (newer(a, b) ? -1 : 1)),
    pinnedIsLts: lts.some(r => r.version === pinned),
  }
}

async function shasums(version) {
  const res = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  if (!res.ok) return null
  const text = await res.text()
  return text.split('\n').filter(l => /node-v[\d.]+-linux-(x64|arm64)\.tar\.xz$|node-v[\d.]+-win-x64\.zip$|node-v[\d.]+-darwin-arm64\.tar\.gz$/.test(l)).join('\n')
}

export async function main(argv) {
  const reportAt = argv.indexOf('--report')
  const report = reportAt >= 0 ? argv[reportAt + 1] : null
  const { NODE_VERSION } = await import(pathToFileURL(path.join(ROOT, 'desktop', 'build-cli-package.mjs')).href)
  const lines = []
  let failed = false

  const file = fs.readFileSync(NODE_VERSION_FILE, 'utf8').trim()
  if (file !== NODE_VERSION) {
    failed = true
    lines.push(`- **.node-version says ${file} but desktop/build-cli-package.mjs pins ${NODE_VERSION}.** CI must test on the Node that ships; set both.`)
  }

  const res = await fetch(INDEX_URL)
  if (!res.ok) throw new Error(`${INDEX_URL}: HTTP ${res.status}`)
  const found = compare(NODE_VERSION, await res.json())
  if (!found.pinnedIsLts) {
    failed = true
    lines.push(`- **${NODE_VERSION} is not an LTS release** in nodejs.org's index.`)
  }
  if (found.newestInLine) {
    failed = true
    const sec = found.security.length ? ` It includes ${found.security.length === 1 ? 'a security release' : 'security releases'}: ${found.security.join(', ')}.` : ''
    lines.push(`- **Node ${found.newestInLine.version}** (${found.newestInLine.lts}, ${found.newestInLine.date}) is newer than the pinned ${NODE_VERSION} in the same line.${sec}`)
  }
  if (found.newest && (!found.newestInLine || found.newest.version !== found.newestInLine.version)) {
    failed = true
    lines.push(`- **Node ${found.newest.version}** (${found.newest.lts}, ${found.newest.date}) is the newest LTS line. Moving to a new major is a decision of its own: test the core and the packages on it first.`)
  }
  if (failed && (found.newestInLine || found.newest)) {
    const target = (found.newestInLine ?? found.newest).version
    const sums = await shasums(target).catch(() => null)
    lines.push('', `The bump is one commit: \`NODE_VERSION\` and \`NODE_SHA256\` in desktop/build-cli-package.mjs, \`.node-version\`, then the full installer workflows. The sha256 lines for ${target}:`, '', '```', sums || `(could not fetch https://nodejs.org/dist/v${target}/SHASUMS256.txt)`, '```')
  }
  if (!failed) lines.push(`Node ${NODE_VERSION} is the newest LTS release, and CI tests on it.`)

  const text = lines.join('\n') + '\n'
  process.stdout.write(text)
  if (report) fs.writeFileSync(report, text)
  return failed ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(`check-node-pin: ${err.message}`); process.exit(2) })
}
