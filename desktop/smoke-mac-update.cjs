'use strict'
// Install a published updater-enabled beta in isolation and replace it using the
// real bundled updater and Squirrel.Mac. Only the HTTP source is redirected to
// the candidate ZIP; signatures, checksums and the native installer stay real.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright')

async function main() {
  assert.equal(process.platform, 'darwin')
  const target = path.resolve(process.argv[2])
  const dist = path.resolve('desktop/dist')
  const info = JSON.parse(fs.readFileSync(path.join(target, 'Contents/Resources/build-info.json')))
  assert.equal(info.macSigningMode, 'signed')
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'SpawnLoft update verification' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const releasesResponse = await fetch('https://api.github.com/repos/joogiebear/spawnloft/releases?per_page=15', { headers, signal: AbortSignal.timeout(30000) })
  assert.ok(releasesResponse.ok, `Release discovery: ${releasesResponse.status}`)
  const releases = await releasesResponse.json()
  const previous = releases.find(r => r.prerelease && !r.draft && r.assets.some(a => a.name === 'beta-mac.yml'))
  if (!previous) {
    console.log('BOOTSTRAP: no published updater-enabled Mac beta exists yet; next signed build must prove the installed upgrade.')
    return
  }
  assert.notEqual(previous.tag_name, `v${info.version}`)
  const asset = previous.assets.find(a => a.name.endsWith(`-mac-${process.arch}.zip`))
  assert.ok(asset, 'Previous release must contain this architecture')
  const scratch = fs.mkdtempSync('/tmp/sl-update-')
  const installed = path.join(scratch, 'Applications', 'SpawnLoft.app')
  const executable = path.join(installed, 'Contents/MacOS/SpawnLoft')
  const data = path.join(scratch, 'data')
  const config = path.join(scratch, 'config')
  const home = path.join(scratch, 'home')
  const userData = path.join(scratch, 'userData')
  for (const folder of [data, config, home, path.dirname(installed)]) fs.mkdirSync(folder, { recursive: true })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config, MCCTL_DATA_ROOT: data }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCCTL_CORE
  // Authentication belongs only to CI release discovery, never the installed app.
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  const preserved = new Map()
  for (const [name, content] of [
    [path.join(config, 'mcctl/settings.json'), JSON.stringify({ dataRoot: data, theme: 'spawnloft' })],
    [path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: {} })],
    [path.join(data, 'instances/upgrade-fixture/plugins/Manual/config.yml'), 'database:\n  password: manual-fixture-only\n'],
    [path.join(data, 'services/upgrade-fixture/data.bin'), 'database preservation fixture'],
    [path.join(data, 'backups/upgrade-fixture/snapshot.tar'), 'backup preservation fixture'],
  ]) {
    fs.mkdirSync(path.dirname(name), { recursive: true }); fs.writeFileSync(name, content); preserved.set(name, content)
  }
  const oldZip = path.join(scratch, 'previous.zip')
  const response = await fetch(asset.browser_download_url)
  assert.ok(response.ok)
  const oldBytes = Buffer.from(await response.arrayBuffer())
  assert.equal('sha256:' + crypto.createHash('sha256').update(oldBytes).digest('hex'), asset.digest)
  fs.writeFileSync(oldZip, oldBytes)
  execFileSync('/usr/bin/ditto', ['-x', '-k', oldZip, path.dirname(installed)])
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed])
  const zipName = `SpawnLoft-${info.version}-mac-${process.arch}.zip`
  const zip = path.join(dist, zipName)
  const bytes = fs.readFileSync(zip)
  const feed = JSON.stringify({ version: info.version, files: [{ url: zipName, size: bytes.length, sha512: crypto.createHash('sha512').update(bytes).digest('base64') }] })
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url.split('?')[0].endsWith('.yml')) { res.setHeader('Content-Type', 'application/yaml'); res.end(feed) }
    else if (req.url.split('?')[0] === '/' + zipName) { res.setHeader('Content-Length', bytes.length); fs.createReadStream(zip).pipe(res) }
    else { res.statusCode = 404; res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let app
  const launch = () => electron.launch({ executablePath: executable, args: [`--user-data-dir=${userData}`], env, timeout: 45000 })
  const until = async (fn, message, ms = 120000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 500)) }
    throw new Error(message)
  }
  try {
    app = await launch()
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    assert.equal((await page.evaluate(() => window.mcctlDesktop.appInfo())).manualUpdates, false)
    await app.evaluate(({ app, autoUpdater: nativeUpdater }, url) => {
      const updater = process.mainModule.require('electron-updater').autoUpdater
      updater.setFeedURL({ provider: 'generic', url })
      updater.autoRunAppAfterInstall = false // Relaunch under Playwright after native replacement.
      globalThis.__nativeUpdateReady = false
      globalThis.__updateErrors = []
      nativeUpdater.once('update-downloaded', () => { globalThis.__nativeUpdateReady = true })
      updater.on('error', e => globalThis.__updateErrors.push(String(e)))
    }, `http://127.0.0.1:${server.address().port}/`)
    const check = await page.evaluate(() => window.mcctlDesktop.checkUpdate())
    assert.equal(check.ok, true, JSON.stringify(check))
    assert.equal(check.version, info.version)
    await until(async () => {
      const state = await app.evaluate(() => ({ ready: globalThis.__nativeUpdateReady, errors: globalThis.__updateErrors }))
      assert.deepEqual(state.errors, [])
      return state.ready
    }, 'Squirrel.Mac did not accept the signed update')
    await page.evaluate(() => { void window.mcctlDesktop.installUpdate() }).catch(() => {})
    await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(installed, 'Contents/Resources/build-info.json'))).version === info.version }
      catch { return false }
    }, 'Native installer did not replace the installed app')
    await app.close().catch(() => {})
    app = null
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed])
    execFileSync('/usr/bin/xcrun', ['stapler', 'validate', installed])
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', installed])
    app = await launch()
    const updated = await app.firstWindow()
    await updated.waitForLoadState('domcontentloaded')
    const actual = await updated.evaluate(() => window.mcctlDesktop.appInfo())
    assert.equal(actual.version, info.version)
    assert.equal(actual.manualUpdates, false)
    for (const [file, content] of preserved) assert.equal(fs.readFileSync(file, 'utf8'), content, `Changed user data: ${file}`)
    assert.ok(requests.some(url => url.startsWith('/' + zipName)))
    console.log(`PASS: installed ${previous.tag_name} -> ${info.version} through bundled updater and Squirrel.Mac; relaunched version verified, Developer ID/notarization/Gatekeeper accepted, settings and manual data preserved`)
  } finally {
    if (app) await app.close().catch(() => {})
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    // Keep a failed installation for CI diagnostics; successful jobs are ephemeral too.
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
