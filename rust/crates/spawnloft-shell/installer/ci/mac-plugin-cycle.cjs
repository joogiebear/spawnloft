'use strict'
// The macOS 2.x -> 2.y cycle through the signed envelope and tauri-plugin-updater (design
// section 6, section 11 scenario 5): installs version a from its zip, serves the loopback feed
// make-mac-feed.mjs wrote, starts a, waits for the window's first check to stage the verified
// download, asks for the install as the panel's "Restart to update" does (update-request.json),
// and checks the bundle on disk became b, is still notarized and stapled, and came back up.
//
//   node mac-plugin-cycle.cjs --zip-a <SpawnLoft-a-mac-arm64.zip> --a <ver> --b <ver>
//        --feed <make-mac-feed out root> --port <n> --apps <folder to install into> --out <results dir>
//
// a and b must be internal-feed builds trusting the key the feed is signed with. Config and data
// live under <out> (XDG_CONFIG_HOME / XDG_DATA_HOME), so nothing of the person's is read. Every
// SpawnLoft running from <apps>/SpawnLoft.app is stopped first and at the end.
const path = require('node:path')
const fs = require('node:fs')
const { spawn, spawnSync, execFileSync } = require('node:child_process')
const { verifySignatureDetails, validateStapled } = require(path.resolve(__dirname, '../../../../../desktop/mac-signing.cjs'))

if (process.platform !== 'darwin') throw new Error('mac-plugin-cycle.cjs runs on macOS')
const opt = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) opt[argv[i].replace(/^--/, '')] = argv[i + 1]
for (const k of ['zip-a', 'a', 'b', 'feed', 'port', 'apps', 'out']) if (!opt[k]) throw new Error(`--${k} is required`)
const teamId = process.env.APPLE_TEAM_ID || ''

const out = path.resolve(opt.out)
fs.mkdirSync(out, { recursive: true })
const apps = path.resolve(opt.apps)
const app = path.join(apps, 'SpawnLoft.app')
const exe = path.join(app, 'Contents', 'MacOS', 'SpawnLoft')
const coreBin = path.join(app, 'Contents', 'Resources', 'resources', 'bin', 'spawnloft-core')
const xdgConfig = path.join(out, 'config')
const xdgData = path.join(out, 'data')
const config = path.join(xdgConfig, 'spawnloft')
const base = `http://127.0.0.1:${opt.port}/`
const result = { a: opt.a, b: opt.b, checks: {} }
const resultFile = path.join(out, 'mac-plugin-cycle.json')
const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')

function check(what, ok, detail = '') {
  console.log(`${ok ? 'ok   ' : 'FAIL '} ${what}${detail ? `  (${detail})` : ''}`)
  result.checks[what] = ok ? 'ok' : `FAIL ${detail}`
  save()
  if (!ok) throw new Error(`mac plugin cycle: ${what}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const version = () => {
  const r = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const updateLog = () => { try { return fs.readFileSync(path.join(config, 'update.log'), 'utf8') } catch { return '' } }
const running = () => spawnSync('/usr/bin/pgrep', ['-f', exe], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
const stopApp = async () => { spawnSync('/usr/bin/pkill', ['-f', exe]); await sleep(2000) }
async function waitFor(seconds, cond) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) { if (cond()) return true; await sleep(1000) }
  return cond()
}
const appEnv = {
  ...process.env,
  XDG_CONFIG_HOME: xdgConfig,
  XDG_DATA_HOME: xdgData,
  SPAWNLOFT_UPDATE_SOURCE: base,
  SPAWNLOFT_SPIKE_LOG: path.join(out, 'shell.log'),
}
for (const k of ['SPAWNLOFT_UPDATES', 'SPAWNLOFT_CORE_BIN', 'SPAWNLOFT_CORE_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH', 'GITHUB_TOKEN', 'GH_TOKEN']) delete appEnv[k]

async function main() {
  await stopApp()
  // ---- install a ----
  fs.mkdirSync(apps, { recursive: true })
  fs.rmSync(app, { recursive: true, force: true })
  execFileSync('/usr/bin/ditto', ['-x', '-k', path.resolve(opt['zip-a']), apps], { stdio: 'inherit' })
  check(`version a (${opt.a}) is installed at ${app}`, version() === opt.a, version())
  fs.rmSync(xdgConfig, { recursive: true, force: true })
  fs.rmSync(xdgData, { recursive: true, force: true })
  fs.mkdirSync(config, { recursive: true })
  fs.mkdirSync(path.join(xdgData, 'spawnloft'), { recursive: true })
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ dataRoot: path.join(xdgData, 'spawnloft') }, null, 2))
  const status = spawnSync(coreBin, ['update', 'status', '--json'], { encoding: 'utf8', env: appEnv })
  result.statusA = status.stdout.trim()
  check('the installed core of a answers `update status`', status.status === 0 && result.statusA.includes(opt.a), result.statusA || status.stderr)

  // ---- the feed ----
  const server = spawn(process.execPath, [path.resolve(__dirname, '..', '..', 'updater-tests', 'feed-server.cjs'), path.resolve(opt.feed), path.join(out, 'feed-port.txt'), 'good'],
    { env: { ...process.env, FEED_PORT: opt.port }, stdio: ['ignore', fs.openSync(path.join(out, 'feed-server.log'), 'w'), 'inherit'] })
  try {
    check('the loopback feed is up', await waitFor(15, () => fs.existsSync(path.join(out, 'feed-port.txt'))))
    const checked = spawnSync(coreBin, ['update', 'check', '--json'], { encoding: 'utf8', env: appEnv })
    result.coreCheck = checked.stdout.trim()
    check(`the core of a verifies the envelope and offers b (${opt.b})`, checked.stdout.includes(`"${opt.b}"`), result.coreCheck || checked.stderr)
    // the window does its own check 20 s after start; start from a clean state so it is the one
    for (const f of ['update-state.json', 'update-hold.json', 'update-request.json']) fs.rmSync(path.join(config, f), { force: true })
    fs.rmSync(path.join(config, 'updates'), { recursive: true, force: true })

    // ---- a runs, stages b, installs it on request ----
    const started = Date.now()
    spawn(exe, [], { env: appEnv, detached: true, stdio: 'ignore' }).unref()
    check('a started', await waitFor(20, () => running().length > 0))
    const staged = await waitFor(120, () => readJson(path.join(config, 'update-state.json'))?.downloaded === true)
    check('the window staged the verified download after its first check', staged, updateLog())
    fs.writeFileSync(path.join(config, 'update-request.json'), JSON.stringify({ action: 'install', version: opt.b, at: new Date().toISOString() }))
    const swapped = await waitFor(120, () => version() === opt.b)
    result.seconds = Math.round((Date.now() - started) / 100) / 10
    check(`the bundle on disk is b (${opt.b}) after the plugin install`, swapped, version())
    check('the app came back after the update', await waitFor(30, () => running().length > 0))
    const log = updateLog()
    result.updateLog = log
    check('update.log has the download and the install', /shell-download/.test(log) && /shell-install/.test(log) && !/install-failed/.test(log), log)
    check('the verified download was kept in the cache', fs.existsSync(path.join(config, 'updates', opt.b, `SpawnLoft-${opt.b}-mac-arm64.app.tar.gz`)))

    // ---- b is the signed, notarized build ----
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
    const sig = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' })
    if (teamId) verifySignatureDetails(sig.stderr.replace(/\r\n/g, '\n'), 'signed', teamId)
    check('b: codesign --deep --strict, Developer ID, hardened runtime', true, teamId ? `team ${teamId}` : 'team not checked')
    await validateStapled(app, { run: (command, args) => spawnSync(command, args, { encoding: 'utf8' }) })
    check('b: stapled ticket validates', true)
    const spctl = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app], { encoding: 'utf8' })
    const spctlOut = `${spctl.stdout}${spctl.stderr}`.trim()
    check('b: Gatekeeper accepts it as a notarized Developer ID build', spctl.status === 0 && /Notarized Developer ID/.test(spctlOut), spctlOut)
    const ver = spawnSync(coreBin, ['--version', '--json'], { encoding: 'utf8' })
    result.coreB = ver.stdout.trim()
    check(`b: the bundled core runs and reports ${opt.b}`, ver.status === 0 && result.coreB.includes(opt.b), result.coreB || ver.stderr)
    console.log(`\nPASS: ${opt.a} -> ${opt.b} through the signed envelope and tauri-plugin-updater in ${result.seconds}s; b notarized, stapled, accepted by Gatekeeper, relaunched`)
  } finally {
    server.kill()
    await stopApp()
    save()
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
