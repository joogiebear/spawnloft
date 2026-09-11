'use strict'

// Run on a Mac against the actual packaged app, not an Electron development checkout.
// CI supplies Playwright through NODE_PATH so it never becomes an application dependency.
// Usage: node desktop/smoke-mac.cjs /absolute/SpawnLoft.app /absolute/artifacts
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')

async function main() {
  assert.equal(process.platform, 'darwin', 'Packaged macOS smoke tests require macOS')
  assert.ok(process.argv[2] && process.argv[3], 'Supply an app bundle and an artifact directory')
  const bundle = path.resolve(process.argv[2])
  const output = path.resolve(process.argv[3])
  const executable = path.join(bundle, 'Contents', 'MacOS', 'SpawnLoft')
  const core = path.join(bundle, 'Contents', 'Resources', 'core')
  assert.ok(fs.existsSync(executable), `Missing packaged executable: ${executable}`)
  assert.ok(fs.existsSync(path.join(core, 'mcctl.mjs')), 'The package must contain its own CLI')
  fs.mkdirSync(output, { recursive: true })

  // macOS Unix-domain sockets have a short path limit; the runner's default temp path is too long.
  const scratch = fs.mkdtempSync('/tmp/sl-')
  const data = path.join(scratch, 'd')
  const config = path.join(scratch, 'c')
  const home = path.join(scratch, 'h')
  const userData = path.join(scratch, 'u')
  for (const dir of [data, config, home, userData]) fs.mkdirSync(dir, { recursive: true })
  const settingsFile = path.join(config, 'mcctl', 'settings.json')
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(scratch, 'share'),
    MCCTL_DATA_ROOT: data,
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCCTL_CORE
  delete env.FAKE_JAVA_FAIL
  const errors = []
  const log = []
  let app = null
  let page = null
  let daemonCreated = false
  const name = 'mac-smoke'
  const consoleFile = path.join(data, 'run', name, 'console.log')

  function record(message) {
    console.log(message)
    log.push(message)
  }

  async function launch() {
    app = await electron.launch({
      executablePath: executable,
      args: [`--user-data-dir=${userData}`],
      env,
      timeout: 45000,
    })
    app.process().stdout?.on('data', (chunk) => log.push(`[stdout] ${chunk}`))
    app.process().stderr?.on('data', (chunk) => log.push(`[stderr] ${chunk}`))
    page = await app.firstWindow({ timeout: 45000 })
    page.on('pageerror', (error) => errors.push(error.stack || error.message))
    page.setDefaultTimeout(15000)
    await page.waitForLoadState('domcontentloaded')
    return page
  }

  async function close() {
    if (app) await app.close()
    app = null
    page = null
  }

  async function cli(args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [path.join(core, 'mcctl.mjs'), ...args], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let text = ''
      child.stdout.on('data', (chunk) => { text += chunk })
      child.stderr.on('data', (chunk) => { text += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('close', (code, signal) => {
        clearTimeout(timer)
        log.push(`[CLI ${args.join(' ')}] ${text}`)
        if (code === 0) resolve(text)
        else reject(new Error(`Bundled CLI ${args.join(' ')} failed (${signal || code}): ${text}`))
      })
    })
  }

  async function api(route, body) {
    const response = await fetch(new URL(`/api/${route}`, page.url()), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    })
    const result = await response.json()
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`)
    return result
  }

  async function until(check, message) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(check(), message)
  }

  try {
    await launch()
    await page.locator('#root').waitFor({ state: 'visible' })
    assert.match(await page.locator('h1').innerText(), /Where should SpawnLoft keep your servers/)
    await page.waitForFunction(() => document.querySelector('#root').value.length > 0)
    assert.ok((await page.locator('#root').inputValue()).startsWith(scratch), 'Wizard must use isolated data paths')
    await page.screenshot({ path: path.join(output, '01-first-run.png') })
    record('PASS: packaged first-run wizard and preload bridge')
    const roles = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => String(item.role).toLowerCase()))
    assert.ok(roles.includes('appmenu') && roles.includes('editmenu'), `Native Mac menu roles: ${roles}`)
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    const reopened = app.waitForEvent('window')
    await app.evaluate(({ app }) => app.emit('activate'))
    page = await reopened
    await page.locator('#root').waitFor({ state: 'visible' })
    record('PASS: native Mac menus and reopening the setup window')
    await close()

    // Keep relaunches under Playwright control; test the real wizard above and normal saved setup below.
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ dataRoot: data, theme: 'classic' }))
    const instanceDir = path.join(data, 'instances', name)
    fs.mkdirSync(instanceDir, { recursive: true })
    const fakeJava = path.join(scratch, 'fake-java.mjs')
    fs.copyFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'fake-java.mjs'), fakeJava)
    // Real process output passes through the daemon, SSE stream, and renderer. Splitting the
    // searchable phrase with SGR codes proves the panel cleans text before searching/classifying.
    const warningText = 'mac smoke warning ' + 'a long plugin diagnostic with useful details '.repeat(24)
    const warningOutput = '[00:00:01 \u001b[33mWARN\u001b[0m]: mac smoke \u001b[38;2;255;180;0mwarning\u001b[0m '
      + 'a long plugin diagnostic with useful details '.repeat(24)
    fs.appendFileSync(fakeJava, `\nprocess.stdout.write(${JSON.stringify(warningOutput + '\n')})\n`)
    fs.writeFileSync(path.join(instanceDir, 'server.jar'), '')
    fs.writeFileSync(path.join(instanceDir, 'eula.txt'), 'eula=true\n')
    fs.writeFileSync(path.join(instanceDir, 'server.properties'), 'motd=Packaged Mac smoke test\n')
    fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({
      version: 1,
      instances: {
        [name]: {
          dir: instanceDir, jar: 'server.jar', java: fakeJava, memory: '1G',
          port: 45565, rcon: { port: 45575, password: 'isolated-smoke' },
          label: 'Mac development smoke test', autoRestart: false,
        },
      },
    }))
    assert.match(await cli(['list']), /mac-smoke/, 'Packaged Node runtime must run the bundled CLI')
    record('PASS: bundled CLI runs through the packaged Electron Node runtime')

    await launch()
    await page.locator('#bSettings').waitFor({ state: 'visible' })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'classic')
    const info = await page.evaluate(() => window.mcctlDesktop.appInfo())
    assert.equal(info.packaged, true)
    assert.equal(info.coreMode, 'bundled')
    assert.equal(info.manualUpdates, true)
    assert.equal((await page.evaluate(() => window.mcctlDesktop.checkUpdate())).reason, 'manual')
    await page.locator('#bSettings').click()
    await page.locator('input[name="appTheme"][value="spawnloft"]').check()
    await page.waitForFunction(() => document.querySelector('#themeStatus').textContent.includes('SpawnLoft theme saved.'))
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'spawnloft')
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme, 'spawnloft')
    await page.screenshot({ path: path.join(output, '02-theme-picker.png') })
    record('PASS: theme picker changes and persists the real application setting')

    daemonCreated = true
    const started = await api(`instances/${name}/start`, {})
    assert.equal(started.status, 'running')
    await api(`instances/${name}/command`, { line: 'packaged mac console' })
    await until(() => fs.existsSync(consoleFile) && fs.readFileSync(consoleFile, 'utf8').includes('fake got: packaged mac console'), 'Console input must reach the fixture through the packaged daemon')
    assert.match(fs.readFileSync(consoleFile, 'utf8'), /Done \(/)
    record('PASS: packaged daemon starts, reaches ready, and receives console input over its Unix socket')
    await page.locator('#bSetClose').click()
    await page.locator(`#list [data-name="${name}"]`).click()
    await page.locator('#tabConsole').click()
    const warningLine = page.locator('#log .ln').filter({ hasText: 'mac smoke warning' })
    await warningLine.waitFor({ state: 'visible' })
    assert.equal(await warningLine.locator('.txt').textContent(), '[00:00:01 WARN]: ' + warningText)
    assert.match(await warningLine.getAttribute('class'), /\bwarn\b/, 'ANSI-colored WARN must still classify as a warning')
    assert.ok(fs.readFileSync(consoleFile, 'utf8').includes('\u001b[33mWARN'), 'Fixture must actually emit ANSI codes')
    assert.equal(await page.locator('#bWrap').getAttribute('aria-pressed'), 'false', 'Long console lines must not wrap by default')
    assert.equal(await warningLine.evaluate((line) => getComputedStyle(line).whiteSpace), 'pre')
    assert.ok(await page.locator('#log').evaluate((log) => log.scrollWidth > log.clientWidth), 'Long lines must remain horizontally scrollable')
    await page.locator('#bWrap').click()
    assert.equal(await page.locator('#bWrap').getAttribute('aria-pressed'), 'true')
    assert.equal(await warningLine.evaluate((line) => getComputedStyle(line).whiteSpace), 'pre-wrap')
    await page.locator('#bWrap').click()
    await page.locator('#conSearch').fill('mac smoke warning')
    await page.waitForFunction(() => document.querySelector('#log mark')?.textContent === 'mac smoke warning')
    await page.locator('[data-lvl="warn"]').click()
    assert.equal(await page.locator('#log .ln').count(), 1, 'Warning filter and search must work on clean text')
    await page.screenshot({ path: path.join(output, '03-console-regression.png') })
    await page.locator('#conSearch').fill('')
    await page.locator('[data-lvl="all"]').click()
    record('PASS: ANSI output becomes searchable plain text with warning levels; long lines scroll and Wrap remains available')
    await close()

    await launch()
    await page.locator('#bSettings').waitFor({ state: 'visible' })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'spawnloft')
    assert.equal((await api('instances')).find((instance) => instance.name === name)?.status, 'running')
    await page.screenshot({ path: path.join(output, '04-reopened-panel.png') })
    const stopped = await api(`instances/${name}/stop`, {})
    assert.equal(stopped.status, 'stopped')
    assert.match(fs.readFileSync(consoleFile, 'utf8'), /server process exited \(code=0\)/)
    record('PASS: theme survives app restart; detached server survives and then stops cleanly')

    await page.locator(`#list [data-name="${name}"]`).click()
    await page.locator('#tabBackups').click()
    const scope = page.locator('#backupsBody .section').filter({ has: page.getByRole('heading', { name: 'Back up now', exact: true }) }).locator('select')
    await scope.selectOption('full')
    const scopeElement = await scope.elementHandle()
    const pageMarker = await page.evaluate(() => (window.__backupSmoke = Math.random().toString(36)))
    await cli(['backup', name, '--label', 'cli-visible-smoke'])
    await page.locator('#backupsBody .snap .what').filter({ hasText: 'cli-visible-smoke' }).waitFor({ state: 'visible', timeout: 12000 })
    assert.equal(await scope.inputValue(), 'full', 'Automatic history refresh must preserve the selected backup scope')
    assert.ok(await scopeElement.evaluate((element) => element.isConnected), 'Polling must not rebuild the backup form')
    assert.equal(await page.evaluate(() => window.__backupSmoke), pageMarker, 'CLI-created backup must appear without a page reload')
    await page.locator('#tabConsole').click()
    await cli(['backup', name, '--label', 'cli-reentry-smoke'])
    await page.locator('#tabBackups').click()
    await page.locator('#backupsBody .snap .what').filter({ hasText: 'cli-reentry-smoke' }).waitFor({ state: 'visible', timeout: 12000 })
    assert.equal(await scope.inputValue(), 'full', 'Reopening Backups must preserve the selected scope')
    assert.equal(await page.evaluate(() => window.__backupSmoke), pageMarker)
    await page.screenshot({ path: path.join(output, '05-backup-refresh.png') })
    record('PASS: bundled CLI backups appear while Backups is open and after tab reentry without reload or lost form state')
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`)
    record('PASS: no uncaught renderer errors')
  } catch (error) {
    record(`FAIL: ${error.stack || error.message}`)
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    // Shut the test daemon down before removing its control socket and settings, even after failure.
    let safeToRemove = true
    if (daemonCreated) {
      try { await cli(['kill', name]) }
      catch (error) {
        safeToRemove = false
        process.exitCode = 1
        record(`Cleanup could not confirm daemon exit: ${error.message}`)
      }
    }
    await close().catch((error) => record(`App close: ${error.message}`))
    for (const filename of ['console.log', 'daemon.log', 'state.json']) {
      const source = path.join(data, 'run', name, filename)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, filename))
    }
    fs.writeFileSync(path.join(output, 'smoke.log'), log.join('\n'))
    fs.writeFileSync(path.join(output, 'renderer-errors.json'), JSON.stringify(errors, null, 2))
    if (safeToRemove) fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
