'use strict'

// Run against the actual packaged app on macOS, Windows or Linux, not an Electron development checkout.
// CI supplies Playwright through NODE_PATH so it never becomes an application dependency.
// Usage: node desktop/smoke-desktop.cjs <SpawnLoft.app|win-unpacked|SpawnLoft.exe|linux-unpacked|/opt/SpawnLoft> <artifacts>
// On Linux it needs a display; CI supplies one with xvfb-run.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { _electron: electron } = require('playwright')

async function main() {
  assert.ok(['darwin', 'win32', 'linux'].includes(process.platform), 'Packaged desktop smoke tests require macOS, Windows or Linux')
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  // The two unixes share launchers that are shell scripts, a control channel that is a socket with
  // a short path limit, and a Playwright that waits on the app itself rather than on cmd.exe.
  const isUnix = isMac || isLinux
  assert.ok(process.argv[2] && process.argv[3], 'Supply an app bundle, unpacked directory, or executable and an artifact directory')
  const bundle = path.resolve(process.argv[2])
  const output = path.resolve(process.argv[3])
  assert.ok(fs.existsSync(bundle), `Missing package: ${bundle}`)
  const executable = isMac
    ? path.join(bundle, 'Contents', 'MacOS', 'SpawnLoft')
    : fs.statSync(bundle).isDirectory() ? path.join(bundle, isLinux ? 'spawnloft-desktop' : 'SpawnLoft.exe') : bundle
  const core = isMac
    ? path.join(bundle, 'Contents', 'Resources', 'core')
    : path.join(path.dirname(executable), 'resources', 'core')
  assert.ok(fs.existsSync(executable), `Missing packaged executable: ${executable}`)
  assert.ok(fs.existsSync(path.join(core, 'mcctl.mjs')), 'The package must contain its own CLI')
  fs.mkdirSync(output, { recursive: true })

  // macOS Unix-domain sockets have a short path limit; the runner's default temp path is too long.
  const tempRoot = path.resolve(isUnix ? '/tmp' : os.tmpdir())
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'sl-'))
  const data = path.join(scratch, 'App data')
  const config = path.join(scratch, 'c')
  const home = path.join(scratch, 'h')
  const userData = path.join(scratch, 'u')
  const localData = path.join(scratch, 'l')
  for (const dir of [data, config, home, userData, localData]) fs.mkdirSync(dir, { recursive: true })
  const settingsFile = path.join(config, 'mcctl', 'settings.json')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: config,
    LOCALAPPDATA: localData,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(scratch, 'share'),
    MCCTL_DATA_ROOT: data,
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCCTL_CORE
  delete env.FAKE_JAVA_FAIL
  const errors = []
  const log = []
  const pendingCloses = []
  let app = null
  let appPid = null
  let page = null
  let daemonCreated = false
  const name = 'desktop-smoke'
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
    appPid = await app.evaluate(() => process.pid)
    app.process().stdout?.on('data', (chunk) => log.push(`[stdout] ${chunk}`))
    app.process().stderr?.on('data', (chunk) => log.push(`[stderr] ${chunk}`))
    page = await app.firstWindow({ timeout: 45000 })
    page.on('pageerror', (error) => errors.push(error.stack || error.message))
    page.setDefaultTimeout(15000)
    await page.waitForLoadState('domcontentloaded')
    return page
  }

  async function close() {
    if (app) {
      const current = app
      if (isMac) {
        await current.close()
      } else {
        // On Linux the server daemon inherits the pipes Playwright drives the app through (they
        // arrive as descriptors 3 and 4, and spawn only replaces 0 to 2), so Playwright's close
        // never resolves while a server started by the app is still running. Same remedy as below.
        // Playwright launches Electron through cmd.exe on Windows and waits for the child
        // process's `close` event. A detached server can keep inherited stdio handles open
        // after the app has exited, so waiting for `close` here prevents the restart test.
        // Still request the normal app quit (and inspector disconnect), but first await
        // process exit independently. Settle every close promise after daemon cleanup below.
        const child = current.process()
        const exited = new Promise((resolve, reject) => {
          if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit)
            reject(new Error(`Packaged app process ${child.pid} did not exit within 15 seconds`))
          }, 15000)
          function onExit() { clearTimeout(timer); resolve() }
          child.once('exit', onExit)
        })
        pendingCloses.push(current.close().then(() => null, (error) => error))
        await exited
        await until(() => {
          try { process.kill(appPid, 0); return false }
          catch (error) {
            if (error.code === 'ESRCH') return true
            throw error
          }
        }, `Electron main process ${appPid} must exit before the app is relaunched`)
      }
    }
    app = null
    appPid = null
    page = null
  }

  async function settleCloses() {
    if (!pendingCloses.length) return
    let timer
    try {
      const results = await Promise.race([
        Promise.all(pendingCloses),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Playwright did not finish closing after test daemon cleanup')), 15000)
        }),
      ])
      for (const error of results) if (error) throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function cli(args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [path.join(core, 'mcctl.mjs'), ...args], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
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

  async function terminal(command, args, expectedCode = 0) {
    const launcher = path.join(path.dirname(core), 'bin', command + (isUnix ? '' : '.cmd'))
    const options = { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    // Only fixed test arguments and generated fixture paths enter this cmd.exe command.
    // The extra quote pair is cmd /s /c's required wrapper around a quoted batch path.
    for (const arg of [launcher, ...args]) assert.ok(!/["%\r\n]/.test(arg))
    const child = isUnix ? spawn(launcher, args, options)
      : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c',
        `""${launcher}" ${args.map(arg => `"${arg}"`).join(' ')}"`], { ...options, windowsVerbatimArguments: true })
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        if (code !== expectedCode) reject(new Error(`${command} ${args.join(' ')}: exit ${code}; ${stdout} ${stderr}`))
        else resolve({ stdout, stderr })
      })
    })
  }

  async function api(route, body, timeout = 30000) {
    const response = await fetch(new URL(`/api/${route}`, page.url()), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeout),
    })
    const result = await response.json()
    assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(result)}`)
    return result
  }

  async function until(check, message, timeout = 10000) {
    const deadline = Date.now() + timeout
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
    if (isMac) {
      const roles = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => String(item.role).toLowerCase()))
      assert.ok(roles.includes('appmenu') && roles.includes('editmenu'), `Native Mac menu roles: ${roles}`)
      const closed = page.waitForEvent('close')
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
      await closed
      const reopened = app.waitForEvent('window')
      await app.evaluate(({ app }) => app.emit('activate'))
      page = await reopened
      page.on('pageerror', (error) => errors.push(error.stack || error.message))
      await page.locator('#root').waitFor({ state: 'visible' })
      record('PASS: native Mac menus and reopening the setup window')
    }
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
    const warningText = 'desktop smoke warning ' + 'a long plugin diagnostic with useful details '.repeat(24)
    const warningOutput = '[00:00:01 \u001b[33mWARN\u001b[0m]: desktop smoke \u001b[38;2;255;180;0mwarning\u001b[0m '
      + 'a long plugin diagnostic with useful details '.repeat(24)
    fs.appendFileSync(fakeJava, `\nprocess.stdout.write(${JSON.stringify(warningOutput + '\n')})\n`)
    // Touch real memory and consume a bounded amount of CPU so the native sampler must
    // measure the server process, not draw a plausible empty chart or measure the panel.
    fs.appendFileSync(fakeJava, `
globalThis.smokeMemory = Buffer.alloc(32 * 1024 * 1024, 1);
setInterval(() => { const end = performance.now() + 50; while (performance.now() < end) {} }, 100);
`)
    fs.writeFileSync(path.join(instanceDir, 'server.jar'), '')
    fs.writeFileSync(path.join(instanceDir, 'eula.txt'), 'eula=true\n')
    fs.writeFileSync(path.join(instanceDir, 'server.properties'), 'motd=Packaged desktop smoke test\n')
    const pluginConfig = path.join(instanceDir, 'plugins', 'LuckPerms', 'config.yml')
    const manualConfig = '# Manual settings\nstorage-method: h2\ndata:\n  password: keep-my-settings\n'
    fs.mkdirSync(path.dirname(pluginConfig), { recursive: true })
    fs.writeFileSync(pluginConfig, manualConfig)
    fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({
      version: 1,
      instances: {
        'manual-db': {
          kind: 'database', engine: 'mariadb', version: 'smoke-fixture',
          dir: path.join(data, 'services', 'manual-db'), port: 45585,
          root: { password: 'fixture-root' }, autoRestart: false,
          attachments: { [name]: { database: name, user: name, password: 'fixture-manual-credential',
            applied: { luckperms: { file: 'plugins/LuckPerms/config.yml', at: '2026-01-01T00:00:00Z' } } } },
        },
        [name]: {
          dir: instanceDir, jar: 'server.jar', java: fakeJava, memory: '1G',
          port: 45565, rcon: { port: 45575, password: 'isolated-smoke' },
          label: 'Desktop development smoke test', autoRestart: false,
        },
      },
    }))
    assert.match(await cli(['list']), /desktop-smoke/, 'Packaged Node runtime must run the bundled CLI')
    record('PASS: bundled CLI runs through the packaged Electron Node runtime')
    for (const command of ['spawnloft', 'mcctl']) {
      const result = await terminal(command, ['status', name, '--json'])
      assert.equal(result.stderr, '')
      const status = JSON.parse(result.stdout)
      assert.equal(status.schemaVersion, 1)
      assert.equal(status.data.name, name)
      assert.equal(status.data.status, 'stopped')
      assert.ok(!result.stdout.includes('isolated-smoke'), 'Status JSON must not expose the RCON password')
      const missing = JSON.parse((await terminal(command, ['status', 'no-such-instance', '--json'], 1)).stdout)
      assert.equal(missing.ok, false)
      const usage = JSON.parse((await terminal(command, ['remove', name, '--json'], 2)).stdout)
      assert.equal(usage.error.code, 'INVALID_USAGE')
      const removed = await terminal(command, ['db', 'apply', 'manual-db', name, 'luckperms'], 1)
      assert.match(removed.stderr, /usage:/)
      assert.equal(fs.readFileSync(pluginConfig, 'utf8'), manualConfig)
    }
    record('PASS: packaged spawnloft and mcctl terminal launchers return clean JSON and preserve success/failure exit codes')

    // The launch line Settings gives an AI app: the executable itself with ELECTRON_RUN_AS_NODE,
    // not the .cmd launcher, spoken to over piped stdin the way an MCP client does.
    const mcp = await new Promise((resolve, reject) => {
      const child = spawn(executable, [path.join(core, 'spawnloft.mjs'), 'mcp'], {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        log.push(`[MCP] exit ${code} ${stderr}`)
        if (code !== 0) return reject(new Error(`spawnloft mcp: exit ${code}; ${stderr}`))
        resolve({ stdout, replies: new Map(stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).map(m => [m.id, m])) })
      })
      for (const message of [
        { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
        { method: 'notifications/initialized' },
        { id: 2, method: 'tools/list' },
        { id: 3, method: 'tools/call', params: { name: 'server_status', arguments: { name } } },
      ]) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
      child.stdin.end()
    })
    assert.equal(mcp.replies.get(1).result.serverInfo.name, 'spawnloft')
    const mcpTools = mcp.replies.get(2).result.tools.map(tool => tool.name)
    assert.ok(mcpTools.includes('start') && !mcpTools.includes('restore'), 'Destructive tools need --allow-destructive')
    assert.equal(mcp.replies.get(3).result.structuredContent.status, 'stopped')
    assert.ok(!mcp.stdout.includes('isolated-smoke'), 'MCP results must not expose the RCON password')
    record('PASS: packaged runtime serves MCP over stdio without exposing credentials')

    await launch()
    await page.locator('#bSettings').waitFor({ state: 'visible' })
    const mcpLaunch = await api('mcp')
    assert.equal(fs.realpathSync(mcpLaunch.command), fs.realpathSync(executable), 'Settings must point AI apps at this executable')
    assert.equal(fs.realpathSync(mcpLaunch.args[0]), fs.realpathSync(path.join(core, 'spawnloft.mjs')))
    assert.deepEqual(mcpLaunch.env, { ELECTRON_RUN_AS_NODE: '1' })
    record('PASS: Settings gives AI apps the packaged executable and script')
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'classic')
    const info = await page.evaluate(() => window.mcctlDesktop.appInfo())
    assert.equal(info.packaged, true)
    assert.equal(info.coreMode, 'bundled')
    const provenance = JSON.parse(fs.readFileSync(path.join(path.dirname(core), 'build-info.json'), 'utf8'))
    const manual = isMac && provenance.macSigningMode !== 'signed'
    assert.equal(info.manualUpdates, manual, 'Signed Mac builds enable updates; ad-hoc Mac builds stay manual; Windows and Linux keep their updater')
    // Exercise the no-network manual path only for ad-hoc packages. Signed
    // installed upgrades have their own native Squirrel.Mac smoke test.
    if (manual) assert.equal((await page.evaluate(() => window.mcctlDesktop.checkUpdate())).reason, 'manual')
    await page.locator('#bSettings').click()
    await page.locator('input[name="appTheme"][value="spawnloft"]').check()
    await page.waitForFunction(() => document.querySelector('#themeStatus').textContent.includes('SpawnLoft theme saved.'))
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'spawnloft')
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).theme, 'spawnloft')
    await page.screenshot({ path: path.join(output, '02-theme-picker.png') })
    record('PASS: theme picker changes and persists the real application setting')

    // Read, never clicked: changing it asks GitHub for an update, and this test owes it nothing.
    if (manual) {
      assert.equal(await page.locator('#setUpdates').isVisible(), false, 'A build that updates by hand offers no beta setting')
    } else {
      await page.locator('#setUpdates').waitFor({ state: 'visible' })
      const following = await page.evaluate(() => window.mcctlDesktop.updateChannel())
      const onBeta = info.version.includes('-')
      assert.deepEqual(following, { beta: onBeta, chosen: false, onBetaBuild: onBeta, waitingFor: null })
      assert.equal(await page.locator('#setBeta').isChecked(), onBeta, 'With no choice made, a copy follows what its own version followed')
      await page.locator('#setUpdates').scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, '02b-beta-setting.png') })
      record('PASS: the packaged app offers the beta setting, and with no choice made follows what it already followed')
    }

    daemonCreated = true
    const started = await api(`instances/${name}/start`, {})
    assert.equal(started.status, 'running')
    await api(`instances/${name}/command`, { line: 'packaged desktop console' })
    await until(() => fs.existsSync(consoleFile) && fs.readFileSync(consoleFile, 'utf8').includes('fake got: packaged desktop console'), 'Console input must reach the fixture through the packaged daemon')
    assert.match(fs.readFileSync(consoleFile, 'utf8'), /Done \(/)
    record(`PASS: packaged daemon starts, reaches ready, and receives console input over its ${isUnix ? 'Unix socket' : 'named pipe'}`)
    await page.locator('#bSetClose').click()
    await page.locator(`#list [data-name="${name}"]`).click()
    await page.locator('#tabSettings').click()
    const showCredentials = page.locator('#settingsBody').getByRole('button', { name: 'Show credentials', exact: true })
    await showCredentials.waitFor({ state: 'visible' })
    assert.match(await page.locator('#settingsBody').textContent(), /configure your plugins manually/)
    assert.equal(await page.locator('#settingsBody').getByRole('button', { name: /Apply to a plugin/ }).count(), 0)
    assert.ok(!(await page.locator('#settingsBody').textContent()).includes('Written to'))
    await page.screenshot({ path: path.join(output, '08-manual-database-settings.png') })
    await showCredentials.click()
    await page.locator('#dlg .creds').waitFor({ state: 'visible' })
    assert.ok((await page.locator('#dlg .creds').textContent()).includes('fixture-manual-credential'))
    await page.locator('#dlgCancel').click()
    assert.equal(fs.readFileSync(pluginConfig, 'utf8'), manualConfig)
    record('PASS: database settings offer manual credentials without plugin config writers; legacy CLI apply is rejected and existing config bytes stay unchanged')
    await page.locator('#tabConsole').click()
    const warningLine = page.locator('#log .ln').filter({ hasText: 'desktop smoke warning' })
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
    await page.locator('#conSearch').fill('desktop smoke warning')
    await page.waitForFunction(() => document.querySelector('#log mark')?.textContent === 'desktop smoke warning')
    await page.locator('[data-lvl="warn"]').click()
    assert.equal(await page.locator('#log .ln').count(), 1, 'Warning filter and search must work on clean text')
    await page.screenshot({ path: path.join(output, '03-console-regression.png') })
    await page.locator('#conSearch').fill('')
    await page.locator('[data-lvl="all"]').click()
    record('PASS: ANSI output becomes searchable plain text with warning levels; long lines scroll and Wrap remains available')

    await page.locator('#tabPerformance').click()
    await page.waitForFunction(() => {
      const values = [...document.querySelectorAll('#performanceBody .gauge .now')].map(el => el.textContent)
      return values.length === 2 && /\d.*%/.test(values[0]) && /\d.* MB/.test(values[1])
    }, null, { timeout: 45000 })
    const firstMetrics = await api(`instances/${name}/metrics?seconds=60`)
    assert.notEqual(firstMetrics.available, false)
    assert.ok(firstMetrics.samples.length > 0)
    assert.ok(firstMetrics.samples.some(sample => sample.cpu > 0 && sample.cpu <= 100), 'Measured CPU must reflect the fixture workload')
    assert.ok(firstMetrics.samples.every(sample => sample.rss >= 32), 'Measured resident memory must include the touched fixture buffer')
    await page.waitForFunction(count => {
      const match = /Samples\s+(\d+)/.exec(document.querySelector('#performanceBody .facts')?.textContent || '')
      return match && Number(match[1]) > count
    }, firstMetrics.samples.length, { timeout: 30000 })
    await page.screenshot({ path: path.join(output, '06-performance-live.png') })
    await page.locator('#performanceBody .ranges').getByRole('button', { name: '1m', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#performanceBody .ranges button[aria-pressed="true"]')?.textContent === '1m')
    await page.locator('#tabConsole').click()
    await page.locator('#tabPerformance').click()
    assert.equal(await page.locator('#performanceBody .ranges button[aria-pressed="true"]').textContent(), '1m')
    const beforeClose = await api(`instances/${name}/metrics`)
    fs.writeFileSync(path.join(output, 'performance-live.json'), JSON.stringify(beforeClose, null, 2))
    const cliMetrics = JSON.parse((await terminal('spawnloft', ['metrics', name, '--json'])).stdout)
    assert.equal(cliMetrics.data.cpuScale, 'whole-machine')
    assert.ok(cliMetrics.data.samples.length >= beforeClose.samples.length)
    assert.equal(cliMetrics.data.samples[0].cpuPercent, beforeClose.samples[0].cpu)
    assert.equal(cliMetrics.data.samples[0].rssMiB, beforeClose.samples[0].rss)
    const csvPath = path.join(scratch, 'test run export.csv')
    await terminal('spawnloft', ['metrics', name, '--csv', '--output', csvPath])
    const csvBytes = fs.readFileSync(csvPath)
    assert.match(csvBytes.toString('utf8'), /^instance,run_id,timestamp,cpu_percent,rss_mib,cores\n/)
    assert.ok(csvBytes.toString('utf8').includes(`,${beforeClose.samples[0].cpu},${beforeClose.samples[0].rss},`))
    await terminal('mcctl', ['metrics', name, '--csv', '--output', csvPath], 1)
    assert.ok(fs.readFileSync(csvPath).equals(csvBytes), 'An existing test export must survive an accidental repeat')
    fs.copyFileSync(csvPath, path.join(output, 'performance-cli.csv'))
    record('PASS: packaged CLI JSON and CSV use the same real measurements as the panel; export paths with spaces and overwrite protection work')
    record('PASS: native CPU/memory measurements reach the Performance charts and refresh automatically; history range survives tab reentry')
    await close()

    const metricsPath = path.join(data, 'run', name, 'metrics.log')
    await until(() => fs.readFileSync(metricsPath, 'utf8').trim().split('\n').length > beforeClose.history.count,
      'The daemon must keep measuring while the desktop app is closed', 25000)

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
    await page.locator('#tabPerformance').click()
    await page.waitForFunction(() => [...document.querySelectorAll('#performanceBody .gauge .now')]
      .every(el => el.textContent === 'stopped') && document.querySelectorAll('#performanceBody .gauge .now').length === 2)
    const stoppedMetrics = await api(`instances/${name}/metrics`)
    assert.equal(stoppedMetrics.running, false)
    assert.ok(stoppedMetrics.history.count > beforeClose.history.count)
    await page.screenshot({ path: path.join(output, '07-performance-stopped.png') })
    await api(`instances/${name}/start`, {})
    const restartedMetrics = await api(`instances/${name}/metrics`)
    assert.ok(restartedMetrics.startedAt > firstMetrics.startedAt)
    assert.equal(restartedMetrics.history.count, 0, 'A restart must not join the previous process history')
    await until(() => fs.existsSync(metricsPath) && fs.readFileSync(metricsPath, 'utf8').trim().length > 0,
      'The replacement server process must produce new measurements', 30000)
    const newMetrics = await api(`instances/${name}/metrics`)
    assert.ok(newMetrics.samples.every(sample => sample.at >= Math.floor(restartedMetrics.startedAt / 1000)))
    assert.ok(newMetrics.samples.some(sample => sample.cpu > 0))
    await api(`instances/${name}/stop`, {})
    record('PASS: measurements continue with the app closed, remain visible after stop, and restart with a fresh process baseline')

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
    if (isMac) await require('./smoke-scheduler.cjs')({ api, cli, close, launch, data, name, record })
    // Oracle publishes no small MySQL build for Linux on arm64. There the one-click button must be
    // off and say why, rather than be offered and refused; Redis below still runs.
    if (isLinux && process.arch !== 'x64') {
      await page.locator('#tabSettings').click()
      const create = page.locator('#settingsBody').getByRole('button', { name: 'Create a database', exact: true })
      await create.scrollIntoViewIfNeeded()
      assert.equal(await create.isEnabled(), false, 'Managed MySQL must not be offered where it cannot be installed')
      assert.match(await page.locator('#settingsBody').innerText(), /Managed MySQL is not available for this machine/)
      record('PASS: managed MySQL is not offered on this architecture, and the panel says why')
    } else await require('./smoke-mysql.cjs')({ page, api, cli, core, executable, env, data, name, output, record })
    await require('./smoke-redis.cjs')({ page, api, cli, core, executable, env, data, name, output, record })
    assert.deepEqual(errors, [], `Renderer errors: ${errors.join('\n')}`)
    record('PASS: no uncaught renderer errors')
  } catch (error) {
    record(`FAIL: ${error.stack || error.message}`)
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    // Shut the test daemon down before removing its control socket and settings, even after failure.
    let safeToRemove = true
    if (fs.existsSync(path.join(data, 'instances.json'))) {
      const instances = JSON.parse(fs.readFileSync(path.join(data, 'instances.json'), 'utf8')).instances
      for (const db of [`${name}-db`, `${name}-cache`]) if (instances[db]) {
        try { await cli(['kill', db], 45000) }
        catch (error) { safeToRemove = false; record(`Database cleanup: ${error.message}`) }
      }
    }
    if (daemonCreated) {
      try { await cli(['kill', name]) }
      catch (error) {
        safeToRemove = false
        process.exitCode = 1
        record(`Cleanup could not confirm daemon exit: ${error.message}`)
      }
    }
    await close().catch((error) => {
      safeToRemove = false
      process.exitCode = 1
      record(`App close: ${error.message}`)
    })
    await settleCloses().catch((error) => {
      process.exitCode = 1
      record(`App cleanup failed: ${error.message}`)
    })
    for (const filename of ['console.log', 'daemon.log', 'state.json', 'metrics.log']) {
      const source = path.join(data, 'run', name, filename)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, filename))
    }
    fs.writeFileSync(path.join(output, 'smoke.log'), log.join('\n'))
    fs.writeFileSync(path.join(output, 'renderer-errors.json'), JSON.stringify(errors, null, 2))
    if (safeToRemove) {
      assert.equal(path.dirname(path.resolve(scratch)), tempRoot, 'Cleanup must stay in the temporary root')
      assert.ok(path.basename(scratch).startsWith('sl-'), 'Cleanup must target the generated smoke directory')
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
