'use strict'

// Needs desktop/node_modules (npm ci --prefix desktop), so CI runs it after installing the toolchain,
// next to updater-preview.test.cjs.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
// electron-updater's own copy: npm may nest it under electron-updater rather than hoist it
const { HttpExecutor, configureRequestUrl, configureRequestOptions } = require(require.resolve('builder-util-runtime', { paths: [path.dirname(require.resolve('electron-updater'))] }))
const { NsisUpdater } = require('electron-updater/out/NsisUpdater')
const majorUpdate = require('./major-update')

// The updater that ships in the app, pointed at a feed served here. Only Electron is missing: its
// app object is replaced by the adapter below and its network stack by Node's.
class NodeExecutor extends HttpExecutor {
  createRequest(options, callback) {
    return http.request(options, callback)
  }
  download(url, destination, options) {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' }
      configureRequestUrl(url, requestOptions)
      configureRequestOptions(requestOptions)
      this.doDownload(requestOptions, {
        destination, options, onCancel, responseHandler: null,
        callback: (error) => (error ? reject(error) : resolve(destination)),
      }, 0)
    })
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-major-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const installer = Buffer.from('not really an installer')
const sha512 = crypto.createHash('sha512').update(installer).digest('base64')
let feedVersion = '2.0.0'
const server = http.createServer((req, res) => {
  // latest.yml, latest-mac.yml or latest-linux.yml: the provider names it for the platform running the test
  if (/^\/latest[\w-]*\.yml/.test(req.url)) {
    const name = `SpawnLoft-Setup-${feedVersion}.exe`
    res.end(`version: ${feedVersion}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-11-08T00:00:00.000Z'\n`)
  } else if (req.url.endsWith('.exe')) {
    res.end(installer)
  } else {
    res.statusCode = 404
    res.end()
  }
})

server.unref()

async function updaterAt(version, run, { feeds = ['2.0.0'] } = {}) {
  const dir = fs.mkdtempSync(path.join(scratch, 'install-'))
  const configPath = path.join(dir, 'app-update.yml')
  fs.writeFileSync(configPath, `provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: spawnloft-test-updater\n`)
  const quitHandlers = []
  const app = {
    version,
    name: 'SpawnLoft',
    isPackaged: true,
    appUpdateConfigPath: configPath,
    userDataPath: path.join(dir, 'user'),
    baseCachePath: path.join(dir, 'cache'),
    whenReady: () => Promise.resolve(),
    relaunch() {},
    quit() {},
    onQuit: (handler) => quitHandlers.push(handler),
  }
  const updater = new NsisUpdater(null, app)
  updater.httpExecutor = new NodeExecutor()
  updater.logger = null
  // no Authenticode check off Windows; the publisher check is not what is under test
  updater.verifyUpdateCodeSignature = async () => null
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  const installs = []
  updater.install = (...args) => { installs.push(args); return true }
  const state = majorUpdate.guard(updater, version)
  for (const v of feeds) {
    feedVersion = v
    const downloaded = new Promise((resolve, reject) => {
      updater.once('update-downloaded', resolve)
      updater.once('error', reject)
    })
    const result = await updater.checkForUpdates()
    await result.downloadPromise
    await downloaded
  }
  await run({ updater, state, installs, quit: (code = 0) => quitHandlers.forEach((h) => h(code)) })
}

test('a 1.x install downloads 2.0 from the feed but does not install it on quit', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  await updaterAt('1.7.0', async ({ updater, state, installs, quit }) => {
    assert.equal(state.offered, '2.0.0')
    assert.equal(state.major, true)
    assert.equal(updater.autoInstallOnAppQuit, false)
    quit()
    assert.deepEqual(installs, [], 'the 2.0 installer ran on quit')
  })
})

test('the same install still updates within 1.x on quit', async () => {
  await updaterAt('1.7.0', async ({ updater, state, installs, quit }) => {
    assert.equal(state.major, false)
    assert.equal(updater.autoInstallOnAppQuit, true)
    quit()
    assert.equal(installs.length, 1, 'a 1.x update did not install on quit')
  }, { feeds: ['1.7.1'] })
})

test('a 1.x update downloaded before a 2.0 one does not let 2.0 install on quit', async () => {
  await updaterAt('1.7.0', async ({ updater, state, installs, quit }) => {
    assert.equal(state.offered, '2.0.0')
    assert.equal(state.major, true)
    assert.equal(updater.autoInstallOnAppQuit, false)
    quit()
    assert.deepEqual(installs, [], 'the 2.0 installer ran on quit')
  }, { feeds: ['1.7.1', '2.0.0'] })
  server.close()
})
