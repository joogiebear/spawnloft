'use strict'

// The panel in a real browser, signed in the way a person signs in without the app: `spawnloft
// ui` opens its one-use link through a private page in the config folder (src/panel-open.mjs).
// Then the panel's regressions that only a page shows: console text and levels, live
// performance charts, backups appearing while open, the file editor, the console window, managed
// databases, the scheduler (macOS), a panel restart that ends the old tab's session, and
// `spawnloft ui --link` for a second browser.
//
// It runs the checkout it sits in, with the Node that runs it. The daemon is the one the
// environment picks: SPAWNLOFT_DAEMON=rust with SPAWNLOFT_CORE_BIN for the 2.0 one. Playwright
// comes from NODE_PATH, so it is not a dependency of the app.
// Usage: node desktop/smoke-panel.cjs <artifacts>
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')
const { authorization } = require('./smoke-panel-auth.cjs')

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function main() {
  assert.ok(['darwin', 'win32', 'linux'].includes(process.platform), 'The panel smoke runs on macOS, Windows or Linux')
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'
  const isUnix = isMac || isLinux
  assert.ok(process.argv[2], 'Supply an artifact directory')
  const output = path.resolve(process.argv[2])
  const core = path.resolve(__dirname, '..')
  const executable = process.execPath
  assert.ok(fs.existsSync(path.join(core, 'spawnloft.mjs')), 'Run this from a SpawnLoft checkout')
  fs.mkdirSync(output, { recursive: true })

  // unix-domain sockets have a short path limit; the runner's default temp path is too long
  const tempRoot = path.resolve(isUnix ? '/tmp' : os.tmpdir())
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'sl-'))
  const data = path.join(scratch, 'App data')
  const config = path.join(scratch, 'c')
  const home = path.join(scratch, 'h')
  const localData = path.join(scratch, 'l')
  for (const dir of [data, config, home, localData]) fs.mkdirSync(dir, { recursive: true })
  const configDir = path.join(config, 'spawnloft')
  const settingsFile = path.join(configDir, 'settings.json')
  const openDir = path.join(configDir, 'open')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: config,
    LOCALAPPDATA: localData,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: path.join(scratch, 'share'),
    SPAWNLOFT_DATA_ROOT: data,
    // `spawnloft ui` hands the sign-in page to $BROWSER. This smoke opens the page itself, in its
    // own browser, so the runner's browser is not started: Node is given the page instead, and
    // stops at its first line without doing anything.
    BROWSER: process.execPath,
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCCTL_CORE; delete env.SPAWNLOFT_CORE_DIR
  delete env.SPAWNLOFT_ENTRY
  delete env.FAKE_JAVA_FAIL
  const errors = []
  const log = []
  const port = await freePort()
  const base = `http://127.0.0.1:${port}/`
  let browser = null
  let context = null
  let panel = null
  let page = null
  let daemonCreated = false
  const name = 'panel-smoke'
  const consoleFile = path.join(data, 'run', name, 'console.log')

  // each server remembers which tool was open and a second press closes it, so these check
  // aria-expanded rather than blindly clicking
  async function openTool(id) {
    const button = page.locator(`#${id}`)
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
    await page.locator('#toolPanel').waitFor({ state: 'visible' })
  }
  async function showConsole() {
    if (await page.locator('#toolPanel').isVisible()) await page.locator('#toolClose').click()
    await page.locator('#log').waitFor({ state: 'visible' })
  }
  // Settings shows one section at a time; the databases are the last one, added once the form has read
  // which databases the server is attached to.
  async function openDatabaseSettings() {
    await openTool('tabSettings')
    const databases = page.locator('#settingsBody .set-nav [data-section="databases"]')
    await databases.waitFor({ state: 'visible' })
    if (await databases.getAttribute('aria-current') !== 'true') await databases.click()
  }

  function record(message) {
    console.log(message)
    log.push(message)
  }

  const openPages = () => (fs.existsSync(openDir) ? fs.readdirSync(openDir).filter((f) => f.endsWith('.html')) : [])

  function track(p) {
    p.on('pageerror', (error) => errors.push(error.stack || error.message))
    p.setDefaultTimeout(15000)
    return p
  }

  // `spawnloft ui`, as a person runs it: it starts the panel, writes the sign-in page and hands
  // it to the browser. With `afterRestart`, the tab of the panel that was stopped is still open
  // and must now say its session has ended.
  async function launch({ afterRestart = false } = {}) {
    const before = new Set(openPages())
    const child = spawn(executable, [path.join(core, 'spawnloft.mjs'), 'ui', '--port', String(port)], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    panel = child
    let said = ''
    child.stdout.on('data', (chunk) => { said += chunk; log.push(`[ui] ${chunk}`) })
    child.stderr.on('data', (chunk) => { said += chunk; log.push(`[ui:err] ${chunk}`) })
    await until(() => /Opening the panel in your browser/.test(said) || child.exitCode !== null, 'spawnloft ui must start and open its sign-in page', 60000)
    assert.equal(child.exitCode, null, `spawnloft ui exited: ${said}`)
    assert.ok(!said.includes('SPAWNLOFT_') && /\/auth\?t=v1\.login\./.test(said), 'The sign-in link is printed as well')
    const made = openPages().filter((f) => !before.has(f))
    assert.equal(made.length, 1, `one sign-in page is written: ${made}`)
    const file = path.join(openDir, made[0])
    if (isUnix) assert.equal(fs.statSync(file).mode & 0o077, 0, 'The sign-in page is private')
    const stale = page
    // the old tab asks the new panel with a cookie it never issued; it must say so before this
    // browser signs in again (a new sign-in in the same browser replaces the cookie, and the old
    // tab would simply carry on with it)
    if (afterRestart && stale && !stale.isClosed()) {
      await stale.locator('#sessionEnded').waitFor({ state: 'visible', timeout: 30000 })
      assert.match(await stale.locator('#sessionEnded').innerText(), /This panel session has ended[\s\S]*spawnloft ui/)
      await stale.screenshot({ path: path.join(output, '04a-session-ended.png') })
      record('PASS: the tab of a stopped panel says its session has ended once a new panel answers')
    }
    if (stale && !stale.isClosed()) await stale.close()
    page = track(await context.newPage())
    await page.goto(pathToFileURL(file).href)
    await page.waitForURL(base, { timeout: 30000 })
    await page.waitForLoadState('domcontentloaded')
    await until(() => !fs.existsSync(file), 'The panel deletes the sign-in page once its link is used')
    return page
  }

  // stops the panel; servers keep running. The tab stays open, as a person would leave it.
  async function close() {
    const child = panel
    panel = null
    if (!child || child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15000))])
    assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'spawnloft ui must stop')
  }

  async function cli(args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [path.join(core, 'mcctl.mjs'), ...args], {
        env,
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
        else reject(new Error(`CLI ${args.join(' ')} failed (${signal || code}): ${text}`))
      })
    })
  }

  // the two command names a terminal has, with their stdout and stderr apart
  async function terminal(command, args, expectedCode = 0) {
    const child = spawn(executable, [path.join(core, `${command}.mjs`), ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    const target = new URL(`/api/${route}`, base)
    const response = await fetch(target, {
      method: body === undefined ? 'GET' : 'POST',
      // asked from outside the page, so signed with the install's key (smoke-panel-auth.cjs)
      headers: { 'Content-Type': 'application/json', Authorization: authorization(configDir, target.port) },
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
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } })

    // nothing gets in without signing in
    {
      const probe = spawn(executable, [path.join(core, 'spawnloft.mjs'), 'ui', '--port', String(port), '--no-open'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let said = ''
      probe.stdout.on('data', (chunk) => { said += chunk })
      await until(() => /\/auth\?t=/.test(said), 'spawnloft ui --no-open prints a link', 60000)
      assert.deepEqual(openPages(), [], '--no-open writes no sign-in page')
      const stranger = track(await context.newPage())
      const res = await stranger.goto(base)
      assert.equal(res.status(), 401)
      assert.match(await stranger.locator('body').innerText(), /Open SpawnLoft from the app, or run spawnloft ui/)
      await stranger.screenshot({ path: path.join(output, '00-signed-out.png') })
      // the printed link works once
      const link = /(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)/.exec(said)[1]
      await stranger.goto(link)
      await stranger.waitForURL(base)
      await stranger.locator('#bSettings').waitFor({ state: 'visible' })
      const again = track(await (await browser.newContext()).newPage())
      assert.equal((await again.goto(link)).status(), 401, 'A used link is refused')
      await again.context().close()
      await stranger.close()
      probe.kill()
      await new Promise((resolve) => probe.exitCode !== null ? resolve() : probe.once('exit', resolve))
      record('PASS: a browser without a sign-in sees the sign-in page; --no-open prints a link that works once')
    }

    // seed saved settings, as the first-run screen in the window would have left them
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ dataRoot: data, theme: 'classic' }))
    const instanceDir = path.join(data, 'instances', name)
    fs.mkdirSync(instanceDir, { recursive: true })
    const fakeJava = path.join(scratch, 'fake-java.mjs')
    fs.copyFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'fake-java.mjs'), fakeJava)
    // real output goes through daemon, SSE and renderer; SGR codes inside the phrase prove the
    // panel strips them before searching and classifying
    const warningText = 'desktop smoke warning ' + 'a long plugin diagnostic with useful details '.repeat(24)
    const warningOutput = '[00:00:01 \u001b[33mWARN\u001b[0m]: desktop smoke \u001b[38;2;255;180;0mwarning\u001b[0m '
      + 'a long plugin diagnostic with useful details '.repeat(24)
    fs.appendFileSync(fakeJava, `\nprocess.stdout.write(${JSON.stringify(warningOutput + '\n')})\n`)
    // touch real memory and burn some CPU so the sampler has to measure the server process
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
    assert.match(await cli(['list']), /panel-smoke/, 'The CLI must list the seeded server')
    record('PASS: the CLI lists the seeded server')
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
    record('PASS: spawnloft and mcctl return clean JSON and keep success/failure exit codes')

    // the MCP server, driven over piped stdin like an MCP client
    const mcp = await new Promise((resolve, reject) => {
      const child = spawn(executable, [path.join(core, 'spawnloft.mjs'), 'mcp'], {
        env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
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
    record('PASS: MCP over stdio answers without exposing credentials')

    await launch()
    await page.locator('#bSettings').waitFor({ state: 'visible' })
    const mcpLaunch = await api('mcp')
    assert.equal(fs.realpathSync(mcpLaunch.command), fs.realpathSync(executable), 'Settings must point AI apps at the Node that runs this panel')
    assert.equal(fs.realpathSync(mcpLaunch.args[0]), fs.realpathSync(path.join(core, 'spawnloft.mjs')))
    record('PASS: Settings gives AI apps a launch line that runs this core')
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'classic')
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
    await api(`instances/${name}/command`, { line: 'packaged desktop console' })
    await until(() => fs.existsSync(consoleFile) && fs.readFileSync(consoleFile, 'utf8').includes('fake got: packaged desktop console'), 'Console input must reach the fixture through the packaged daemon')
    assert.match(fs.readFileSync(consoleFile, 'utf8'), /Done \(/)
    record(`PASS: the ${process.env.SPAWNLOFT_DAEMON === 'rust' ? 'Rust' : 'Node'} daemon starts, reaches ready, and receives console input over its ${isUnix ? 'Unix socket' : 'named pipe'}`)
    await page.locator('#bSetClose').click()
    await page.locator(`#list [data-name="${name}"]`).click()
    await openDatabaseSettings()
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
    await showConsole()
    const warningLine = page.locator('#log .ln').filter({ hasText: 'desktop smoke warning' })
    await warningLine.waitFor({ state: 'visible' })
    assert.equal(await warningLine.locator('.txt').textContent(), '[00:00:01 WARN]: ' + warningText)
    assert.match(await warningLine.getAttribute('class'), /\bwarn\b/, 'ANSI-colored WARN must still classify as a warning')
    assert.ok(fs.readFileSync(consoleFile, 'utf8').includes('\u001b[33mWARN'), 'Fixture must actually emit ANSI codes')
    assert.equal(await page.locator('#bWrap').getAttribute('aria-pressed'), 'true', 'Long console lines wrap by default')
    assert.equal(await warningLine.evaluate((line) => getComputedStyle(line).whiteSpace), 'pre-wrap')
    await page.locator('#bWrap').click()
    assert.equal(await page.locator('#bWrap').getAttribute('aria-pressed'), 'false')
    assert.equal(await warningLine.evaluate((line) => getComputedStyle(line).whiteSpace), 'pre')
    assert.ok(await page.locator('#log').evaluate((log) => log.scrollWidth > log.clientWidth), 'With Wrap off, long lines must stay horizontally scrollable')
    await page.locator('#bWrap').click()
    await page.locator('#conSearch').fill('desktop smoke warning')
    await page.waitForFunction(() => document.querySelector('#log mark')?.textContent === 'desktop smoke warning')
    await page.locator('[data-lvl="warn"]').click()
    assert.equal(await page.locator('#log .ln').count(), 1, 'Warning filter and search must work on clean text')
    await page.screenshot({ path: path.join(output, '03-console-regression.png') })
    await page.locator('#conSearch').fill('')
    await page.locator('[data-lvl="all"]').click()
    record('PASS: ANSI output becomes searchable plain text with warning levels; long lines wrap by default and scroll with Wrap off')

    await openTool('tabPerformance')
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
    await showConsole()
    await openTool('tabPerformance')
    assert.equal(await page.locator('#performanceBody .ranges button[aria-pressed="true"]').textContent(), '1m')
    const beforeClose = await api(`instances/${name}/metrics`)
    fs.writeFileSync(path.join(output, 'performance-live.json'), JSON.stringify(beforeClose, null, 2))
    const cliMetrics = JSON.parse((await terminal('spawnloft', ['metrics', name, '--json'])).stdout)
    assert.equal(cliMetrics.data.cpuScale, 'whole-machine')
    assert.ok(cliMetrics.data.samples.length >= beforeClose.samples.length)
    assert.equal(cliMetrics.data.samples[0].cpuPercent, beforeClose.samples[0].cpu)
    assert.equal(cliMetrics.data.samples[0].rssMiB, beforeClose.samples[0].rss)
    const csvPath = path.join(scratch, 'test run export.csv')
    await terminal('mcctl', ['metrics', name, '--csv', '--output', csvPath])
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
      'The daemon must keep measuring while the panel is closed', 25000)

    await launch({ afterRestart: true })
    await page.locator('#bSettings').waitFor({ state: 'visible' })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'spawnloft')
    assert.equal((await api('instances')).find((instance) => instance.name === name)?.status, 'running')
    await page.screenshot({ path: path.join(output, '04-reopened-panel.png') })
    const stopped = await api(`instances/${name}/stop`, {})
    assert.equal(stopped.status, 'stopped')
    assert.match(fs.readFileSync(consoleFile, 'utf8'), /server process exited \(code=0\)/)
    record('PASS: theme survives a panel restart; detached server survives and then stops cleanly')

    await page.locator(`#list [data-name="${name}"]`).click()
    await openTool('tabPerformance')
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
    record('PASS: measurements continue with the panel closed, remain visible after stop, and restart with a fresh process baseline')

    await page.locator(`#list [data-name="${name}"]`).click()
    await openTool('tabBackups')
    const scope = page.locator('#backupsBody .section').filter({ has: page.getByRole('heading', { name: 'Back up now', exact: true }) }).locator('select')
    await scope.selectOption('full')
    const scopeElement = await scope.elementHandle()
    const pageMarker = await page.evaluate(() => (window.__backupSmoke = Math.random().toString(36)))
    await cli(['backup', name, '--label', 'cli-visible-smoke'])
    await page.locator('#backupsBody .snap .what').filter({ hasText: 'cli-visible-smoke' }).waitFor({ state: 'visible', timeout: 12000 })
    assert.equal(await scope.inputValue(), 'full', 'Automatic history refresh must preserve the selected backup scope')
    assert.ok(await scopeElement.evaluate((element) => element.isConnected), 'Polling must not rebuild the backup form')
    assert.equal(await page.evaluate(() => window.__backupSmoke), pageMarker, 'CLI-created backup must appear without a page reload')
    await showConsole()
    await cli(['backup', name, '--label', 'cli-reentry-smoke'])
    await openTool('tabBackups')
    await page.locator('#backupsBody .snap .what').filter({ hasText: 'cli-reentry-smoke' }).waitFor({ state: 'visible', timeout: 12000 })
    assert.equal(await scope.inputValue(), 'full', 'Reopening Backups must preserve the selected scope')
    assert.equal(await page.evaluate(() => window.__backupSmoke), pageMarker)
    await page.screenshot({ path: path.join(output, '05-backup-refresh.png') })
    record('PASS: CLI backups appear while Backups is open and after tab reentry without reload or lost form state')

    // uses its own file so the plugin configs later steps compare stay untouched
    const filesConfig = path.join(instanceDir, 'plugins', 'SmokeFiles', 'config.yml')
    fs.mkdirSync(path.dirname(filesConfig), { recursive: true })
    fs.writeFileSync(filesConfig, 'enabled: true\nlimit: 5\n')
    const snapshotsLabelled = (label) => fs.readdirSync(path.join(data, 'backups', name)).filter((f) => f.startsWith(label + '_') && f.endsWith('.json'))
    await openTool('tabFiles')
    const fileRow = (text) => page.locator('#filesBody .fm-open').filter({ hasText: new RegExp(`^${text.replace('.', '\\.')}`) })
    await fileRow('plugins').click()
    await fileRow('SmokeFiles').click()
    await fileRow('config.yml').click()
    const editor = page.locator('#filesBody .fm-code textarea')
    await editor.waitFor({ state: 'visible' })
    assert.equal(await editor.inputValue(), 'enabled: true\nlimit: 5\n')
    await editor.fill('enabled: false\nlimit: 5\n')
    await page.locator('#filesBody .fm-bar').getByRole('button', { name: 'Save', exact: true }).click()
    await page.locator('#toasts .toast').filter({ hasText: 'Saved config.yml' }).waitFor({ state: 'visible' })
    assert.equal(fs.readFileSync(filesConfig, 'utf8'), 'enabled: false\nlimit: 5\n')
    assert.equal(snapshotsLabelled('file-edit').length, 1, 'A save must copy the file first')
    await page.screenshot({ path: path.join(output, '06-files-editor.png') })
    await page.locator('#filesBody .fm-bar').getByRole('button', { name: 'All files' }).click()
    await page.locator('#filesBody .fm-row').filter({ hasText: 'config.yml' }).locator('input[type="checkbox"]').check()
    await page.locator('#filesBody .fm-sel').getByRole('button', { name: 'Delete', exact: true }).click()
    await page.locator('#dlgOk').click()
    await page.locator('#toasts .toast').filter({ hasText: 'Deleted config.yml' }).waitFor({ state: 'visible' })
    assert.ok(!fs.existsSync(filesConfig))
    assert.equal(snapshotsLabelled('file-delete').length, 1, 'A delete must copy what it removes first')
    await openTool('tabActivity')
    const historyRow = (verb) => page.locator('#activityBody .feed-row').filter({ hasText: new RegExp(`${verb}\\s*plugins/SmokeFiles/config\\.yml`) })
    await historyRow('Deleted').waitFor({ state: 'visible' })
    assert.equal(await historyRow('Edited').locator('.act-who').textContent(), 'You')
    assert.equal(await historyRow('Edited').locator('.act-undo').count(), 1, 'An edit that kept a copy must offer Undo')
    await showConsole()
    record('PASS: Files edits a config with a copy kept first, and deletes with another; Activity lists both as yours')

    // the console opens in a window of its own: the panel at ?console=<name>, signed in by the
    // same cookie
    const popped = page.waitForEvent('popup')
    await page.locator('#bPopConsole').click()
    const consolePage = await popped
    await consolePage.waitForLoadState('domcontentloaded')
    await consolePage.locator('#log').waitFor({ state: 'visible' })
    assert.equal(await consolePage.locator('.dock').isVisible(), false, 'The console window must not show the tool dock')
    assert.equal(await consolePage.title(), `${name} — console`)
    await consolePage.close()
    record('PASS: a server console opens in its own window, without the rest of the panel')
    if (isMac) await require('./smoke-scheduler.cjs')({ api, cli, close, launch, data, name, record })
    // the managed databases download their servers; SMOKE_PANEL_NO_DOWNLOADS=1 skips them on a
    // machine without the internet (CI always runs them)
    if (process.env.SMOKE_PANEL_NO_DOWNLOADS === '1') record('SKIPPED: managed MySQL and Redis (SMOKE_PANEL_NO_DOWNLOADS=1)')
    // Oracle publishes no small MySQL build for Linux arm64, so the button must be off and say why
    else if (isLinux && process.arch !== 'x64') {
      await openDatabaseSettings()
      const create = page.locator('#settingsBody').getByRole('button', { name: 'Create a database', exact: true })
      await create.scrollIntoViewIfNeeded()
      assert.equal(await create.isEnabled(), false, 'Managed MySQL must not be offered where it cannot be installed')
      assert.match(await page.locator('#settingsBody').innerText(), /Managed MySQL is not available for this machine/)
      record('PASS: managed MySQL is not offered on this architecture, and the panel says why')
    } else await require('./smoke-mysql.cjs')({ page, api, cli, core, executable, env, data, name, output, record, openDatabaseSettings })
    if (process.env.SMOKE_PANEL_NO_DOWNLOADS !== '1') await require('./smoke-redis.cjs')({ page, api, cli, core, executable, env, data, name, output, record })

    // a second browser gets in with a fresh link from `spawnloft ui --link`, and nothing is started
    {
      const printed = (await cli(['ui', '--link', '--port', String(port)]))
      const link = /(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)/.exec(printed)?.[1]
      assert.ok(link, `ui --link prints a link: ${printed}`)
      const second = await browser.newContext()
      const other = track(await second.newPage())
      await other.goto(link)
      await other.waitForURL(base)
      await other.locator('#bSettings').waitFor({ state: 'visible' })
      await second.close()
      record('PASS: spawnloft ui --link signs a second browser in to the running panel')
    }
    assert.deepEqual(errors, [], `Page errors: ${errors.join('\n')}`)
    record('PASS: no uncaught page errors')
  } catch (error) {
    record(`FAIL: ${error.stack || error.message}`)
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    throw error
  } finally {
    // stop the test daemon before removing its socket and settings, even after a failure
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
      record(`Panel close: ${error.message}`)
    })
    await browser?.close().catch(() => {})
    for (const filename of ['console.log', 'daemon.log', 'state.json', 'metrics.log']) {
      const source = path.join(data, 'run', name, filename)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, filename))
    }
    // records event-loop stalls, which tells a blocked panel from a slow runner when a request times out
    const panelLog = path.join(data, 'run', 'panel.log')
    if (fs.existsSync(panelLog)) fs.copyFileSync(panelLog, path.join(output, 'panel.log'))
    fs.writeFileSync(path.join(output, 'smoke.log'), log.join('\n'))
    fs.writeFileSync(path.join(output, 'page-errors.json'), JSON.stringify(errors, null, 2))
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
