'use strict'
// The macOS cross-generation handover (design section 6): a published 1.x install (Electron)
// updates to the 2.0 Tauri app through its own electron-updater and Squirrel.Mac, on quit. Only
// the HTTP feed is redirected to the candidate zip; the signature, checksum and Squirrel.Mac's
// native swap stay real, so this proves Squirrel.Mac accepts the 2.0 bundle as a valid in-place
// replacement signed by the same Developer ID.
//
//   node smoke-mac-handover.cjs <candidate SpawnLoft-<v>-mac-arm64.zip> <version>
//
// The candidate is the 2.0 Squirrel.Mac zip (keepParent, so SpawnLoft.app is the top entry). After
// the swap the installed bundle is a Tauri app, which Playwright/_electron cannot drive, so the
// replacement is checked on disk: Info.plist version and bundle id, codesign, stapled ticket,
// Gatekeeper, and that the seeded user data survived.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const { execFileSync, spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright')
const { validateStapled } = require(path.resolve(__dirname, '../../../../../desktop/mac-signing.cjs'))

const candidate = path.resolve(process.argv[2] || '')
const version = process.argv[3]
assert.ok(candidate.endsWith('.zip') && fs.existsSync(candidate), `candidate zip not found: ${candidate}`)
assert.ok(version, 'supply the candidate version')

function plist(app, key) {
  const res = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' })
  assert.equal(res.status, 0, `Info.plist has no ${key}: ${res.stderr}`)
  return res.stdout.trim()
}

async function main() {
  assert.equal(process.platform, 'darwin')
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'SpawnLoft update verification' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const releasesResponse = await fetch('https://api.github.com/repos/joogiebear/spawnloft/releases?per_page=15', { headers, signal: AbortSignal.timeout(30000) })
  assert.ok(releasesResponse.ok, `Release discovery: ${releasesResponse.status}`)
  const releases = await releasesResponse.json()
  // the last 1.x beta, named exactly (design section 11): it has no major-update guard, so it
  // installs 2.0 on quit. A newer 1.x beta could carry desktop/major-update.js and hold the
  // install back, so this does not take "the newest prerelease".
  const previous = releases.find(r => r.tag_name === 'v1.6.0-beta.413')
  assert.ok(previous, 'v1.6.0-beta.413 is not among the latest releases')
  assert.ok(previous.assets.some(a => a.name === 'beta-mac.yml'), 'v1.6.0-beta.413 has no Mac feed')
  assert.notEqual(previous.tag_name, `v${version}`)
  const asset = previous.assets.find(a => a.name.endsWith('-mac-arm64.zip'))
  assert.ok(asset, 'the previous release has no arm64 Mac zip')
  console.log(`handover: ${previous.tag_name} -> ${version}`)

  const scratch = fs.mkdtempSync('/tmp/sl-handover-')
  const installed = path.join(scratch, 'Applications', 'SpawnLoft.app')
  const executable = path.join(installed, 'Contents/MacOS/SpawnLoft')
  const data = path.join(scratch, 'data')
  const config = path.join(scratch, 'config')
  const home = path.join(scratch, 'home')
  const userData = path.join(scratch, 'userData')
  for (const folder of [data, config, home, path.dirname(installed)]) fs.mkdirSync(folder, { recursive: true })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, MCCTL_DATA_ROOT: data, SPAWNLOFT_DATA_ROOT: data }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCCTL_CORE; delete env.SPAWNLOFT_CORE_DIR
  delete env.GITHUB_TOKEN; delete env.GH_TOKEN // the token is for CI discovery only, never the app
  delete env.NODE_PATH // the CI step sets it for Playwright; the installed app must not inherit it

  const preserved = new Map()
  for (const [name, content] of [
    [path.join(config, 'mcctl/settings.json'), JSON.stringify({ dataRoot: data, theme: 'spawnloft' })],
    [path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {} })],
    [path.join(data, 'instances/upgrade-fixture/plugins/Manual/config.yml'), 'database:\n  password: manual-fixture-only\n'],
    [path.join(data, 'backups/upgrade-fixture/snapshot.tar'), 'backup preservation fixture'],
  ]) {
    fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, content); preserved.set(name, content)
  }

  // install the published 1.x bundle
  const oldZip = path.join(scratch, 'previous.zip')
  const response = await fetch(asset.browser_download_url)
  assert.ok(response.ok, `download previous: ${response.status}`)
  const oldBytes = Buffer.from(await response.arrayBuffer())
  if (asset.digest) assert.equal('sha256:' + crypto.createHash('sha256').update(oldBytes).digest('hex'), asset.digest)
  fs.writeFileSync(oldZip, oldBytes)
  execFileSync('/usr/bin/ditto', ['-x', '-k', oldZip, path.dirname(installed)])
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed])

  // serve the candidate zip and a feed that names it
  const zipName = path.basename(candidate)
  const bytes = fs.readFileSync(candidate)
  const feed = JSON.stringify({ version, files: [{ url: zipName, size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') }] })
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const url = req.url.split('?')[0]
    if (url.endsWith('.yml')) { res.setHeader('Content-Type', 'application/yaml'); res.end(feed) }
    else if (url === '/' + zipName) { res.setHeader('Content-Length', bytes.length); fs.createReadStream(candidate).pipe(res) }
    else { res.statusCode = 404; res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const launch = () => electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], env, timeout: 45000 })
  const until = async (fn, message, ms = 120000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 500)) }
    throw new Error(message)
  }
  let app
  try {
    app = await launch()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate((_, url) => {
      // listen to electron-updater's own 'update-downloaded', which fires once the zip is staged
      // whatever autoInstallOnAppQuit is, so this does not depend on the native Squirrel event
      const updater = process.mainModule.require('electron-updater').autoUpdater
      updater.setFeedURL({ provider: 'generic', url })
      updater.autoRunAppAfterInstall = false // the swapped bundle is a Tauri app; do not relaunch it here
      globalThis.__updateReady = false
      globalThis.__updateErrors = []
      updater.on('update-downloaded', () => { globalThis.__updateReady = true })
      updater.on('error', e => globalThis.__updateErrors.push(String(e)))
    }, `http://127.0.0.1:${server.address().port}/`)
    const check = await page.evaluate(() => window.spawnloftDesktop.checkUpdate())
    assert.equal(check.ok, true, JSON.stringify(check))
    assert.equal(check.version, version)
    await until(async () => {
      const state = await app.evaluate(() => ({ ready: globalThis.__updateReady, errors: globalThis.__updateErrors }))
      assert.deepEqual(state.errors, [])
      return state.ready
    }, 'electron-updater did not download and stage the signed 2.0 update')
    await page.evaluate(() => { void window.spawnloftDesktop.installUpdate() }).catch(() => {})
    await until(() => {
      try { return plist(installed, 'CFBundleShortVersionString') === version }
      catch { return false }
    }, 'Squirrel.Mac did not replace the installed bundle with the 2.0 app')
    await app.close().catch(() => {})
    app = null

    // the installed bundle is now the 2.0 Tauri app; check it on disk
    assert.equal(plist(installed, 'CFBundleIdentifier'), 'io.github.joogiebear.mcctl')
    assert.equal(plist(installed, 'CFBundleShortVersionString'), version)
    assert.ok(fs.existsSync(path.join(installed, 'Contents/Resources/resources/bin/spawnloft-core')), 'the 2.0 bundle has no Rust core in resources/bin')
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed])
    await validateStapled(installed, { run: (command, args) => spawnSync('/usr/bin/' + command, args, { encoding: 'utf8' }) })
    const spctl = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', installed], { encoding: 'utf8' })
    const spctlOut = `${spctl.stdout || ''}${spctl.stderr || ''}`
    assert.ok(spctl.status === 0 && /Notarized Developer ID/.test(spctlOut), `Gatekeeper did not accept the 2.0 bundle as notarized: ${spctlOut.trim()}`)
    for (const [file, content] of preserved) assert.equal(fs.readFileSync(file, 'utf8'), content, `changed user data: ${file}`)
    assert.ok(requests.some(url => url.startsWith('/' + zipName)), 'the candidate zip was never fetched')
    console.log(`PASS: ${previous.tag_name} -> ${version} through Squirrel.Mac; 2.0 Tauri bundle in place, Developer ID / notarization / Gatekeeper accepted, user data preserved`)
  } finally {
    if (app) await app.close().catch(() => {})
    // an older electron-updater that relaunches the swapped 2.0 app would leave it running with
    // the runner's real HOME; make sure nothing lingers
    spawnSync('/usr/bin/pkill', ['-f', `${installed}/Contents/MacOS/SpawnLoft`])
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
