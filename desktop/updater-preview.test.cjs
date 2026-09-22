'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider')

// Run the updater library that ships in the app, with network responses supplied locally.
// A paired release must still resolve the Windows installer; old Mac-only previews must
// never win, and stable installs must never be offered the development beta.
const versions = ['0.15.0-beta.3', '0.15.0-mac.6', '0.15.0-beta.1', '0.14.0']
const feed = '<feed>' + versions.map(version => `<entry><title>SpawnLoft ${version}</title>
  <link href="https://github.com/joogiebear/spawnloft/releases/tag/v${version}"/>
  <content>Development test</content></entry>`).join('') + '</feed>'

// On Linux the updater names its feed for the machine's architecture: latest-linux.yml on x64 and
// latest-linux-arm64.yml on arm64. The library reads the architecture of the host it runs on, and
// this test runs on an Apple Silicon runner too - which is also what an arm64 Linux package will
// have to publish when there is one.
const LINUX_FEED = process.arch === 'x64' ? '-linux' : `-linux-${process.arch}`

function provider(currentVersion, allowPrerelease, platform = 'win32', stable = false) {
  const requests = []
  const executor = { async request(options) {
    const route = options.path
    requests.push(route)
    if (route.endsWith('/releases.atom')) return stable ? feed.replace('<feed>', '<feed><entry><title>SpawnLoft 1.0.0</title><link href="https://github.com/joogiebear/spawnloft/releases/tag/v1.0.0"/><content>Stable</content></entry>') : feed
    if (route.endsWith('/releases/latest')) return JSON.stringify({ tag_name: stable ? 'v1.0.0' : 'v0.14.0' })
    const match = /\/download\/v(0\.15\.0-beta\.3|0\.14\.0|1\.0\.0)\/(beta|latest)(-mac|-linux(?:-arm64)?)?\.yml$/.exec(route)
    assert.ok(match, `Unexpected updater request: ${route}`)
    const version = match[1]
    if (platform === 'darwin') {
      assert.equal(match[3], '-mac')
      return JSON.stringify({ version, files: ['arm64', 'x64'].map(arch => ({ url: `SpawnLoft-${version}-mac-${arch}.zip`, sha512: 'Zml4dHVyZQ==', size: 42 })) })
    }
    if (platform === 'linux') {
      assert.equal(match[3], LINUX_FEED)
      // One feed per architecture, listing both packages; the installed app takes its own kind.
      const names = [`SpawnLoft-${version}-linux-amd64.deb`, `SpawnLoft-${version}-linux-x86_64.rpm`]
      return `version: ${version}\nfiles:\n${names.map(name => `  - url: ${name}\n    sha512: Zml4dHVyZQ==\n    size: 42\n`).join('')}path: ${names[0]}\nsha512: Zml4dHVyZQ==\n`
    }
    assert.equal(match[3], undefined)
    const name = `SpawnLoft-Setup-${version}.exe`
    return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: Zml4dHVyZQ==\n    size: 42\npath: ${name}\nsha512: Zml4dHVyZQ==\n`
  } }
  return {
    client: new GitHubProvider({ provider: 'github', owner: 'joogiebear', repo: 'spawnloft' },
      { currentVersion, allowPrerelease, fullChangelog: false }, { platform, executor }),
    requests,
  }
}

test('the existing Windows beta finds the paired beta and its Windows installer', async () => {
  const { client, requests } = provider('0.15.0-beta.1', true)
  const info = await client.getLatestVersion()
  assert.equal(info.version, '0.15.0-beta.3')
  assert.equal(client.resolveFiles(info)[0].url.href,
    'https://github.com/joogiebear/spawnloft/releases/download/v0.15.0-beta.3/SpawnLoft-Setup-0.15.0-beta.3.exe')
  assert.ok(requests.some(route => route.endsWith('/beta.yml')))
  assert.ok(requests.every(route => !route.includes('mac.6') && !route.includes('latest-mac')))
})

test('Mac beta resolves the combined feed and the shipped updater chooses each native architecture', async () => {
  const { MacUpdater } = require('electron-updater/out/MacUpdater')
  const { findFile } = require('electron-updater/out/providers/Provider')
  const { client, requests } = provider('0.15.0-beta.1', true, 'darwin')
  const info = await client.getLatestVersion()
  const files = client.resolveFiles(info)
  for (const arm of [true, false]) {
    const file = findFile(MacUpdater.filterFilesForArch(files, arm), 'zip', ['pkg', 'dmg'])
    assert.ok(file.url.href.endsWith(`mac-${arm ? 'arm64' : 'x64'}.zip`))
  }
  assert.ok(requests.some(route => route.endsWith('/beta-mac.yml')))
  assert.ok(requests.every(route => !route.endsWith('/beta.yml')))
})

test('stable Windows stays on the stable release when paired betas exist', async () => {
  const { client, requests } = provider('0.14.0', false)
  const info = await client.getLatestVersion()
  assert.equal(info.version, '0.14.0')
  assert.ok(requests.some(route => route.endsWith('/releases/latest')))
  assert.ok(requests.every(route => !route.includes('/download/v0.15.0')))
})

for (const platform of ['win32', 'darwin']) {
  for (const current of ['0.14.0', '0.15.0-beta.42', '1.0.0']) {
    test(`${platform} ${current} resolves stable 1.0 with its native update feed`, async () => {
      const { client } = provider(current, current.includes('-'), platform, true)
      const info = await client.getLatestVersion()
      assert.equal(info.version, '1.0.0')
      const files = client.resolveFiles(info)
      if (platform === 'win32') assert.ok(files[0].url.href.endsWith('SpawnLoft-Setup-1.0.0.exe'))
      else {
        const { MacUpdater } = require('electron-updater/out/MacUpdater')
        for (const arm of [true, false]) assert.ok(MacUpdater.filterFilesForArch(files, arm)[0].url.href.endsWith(`mac-${arm ? 'arm64' : 'x64'}.zip`))
      }
    })
  }
}

test('a Linux beta asks for the Linux feed and is handed the Debian package', async () => {
  const { client, requests } = provider('0.15.0-beta.1', true, 'linux')
  const info = await client.getLatestVersion()
  assert.equal(info.version, '0.15.0-beta.3')
  assert.equal(client.resolveFiles(info)[0].url.href,
    'https://github.com/joogiebear/spawnloft/releases/download/v0.15.0-beta.3/SpawnLoft-0.15.0-beta.3-linux-amd64.deb')
  // The name the preview workflow copies latest-linux.yml to. If the updater ever asked for
  // anything else, Linux betas would install and then never hear of another release.
  assert.ok(requests.some(route => route.endsWith(`/beta${LINUX_FEED}.yml`)))
  assert.ok(requests.every(route => !route.endsWith('/beta.yml') && !route.endsWith('-mac.yml')))
})

test('stable Linux stays on the stable release when betas exist', async () => {
  const { client, requests } = provider('0.14.0', false, 'linux')
  const info = await client.getLatestVersion()
  assert.equal(info.version, '0.14.0')
  assert.ok(requests.some(route => route.endsWith(`/latest${LINUX_FEED}.yml`)))
  assert.ok(requests.every(route => !route.includes('/download/v0.15.0')))
})

test('one Linux feed serves both packages: a deb install takes the .deb, an rpm install the .rpm', async () => {
  const { findFile } = require('electron-updater/out/providers/Provider')
  const { client } = provider('0.15.0-beta.1', true, 'linux')
  const files = client.resolveFiles(await client.getLatestVersion())
  assert.equal(files.length, 2)
  // The same calls DebUpdater and RpmUpdater make. Which one runs is decided by the package-type
  // marker each package leaves in its own resources folder.
  assert.ok(findFile(files, 'deb', ['AppImage', 'rpm', 'pacman']).url.href.endsWith('-linux-amd64.deb'))
  assert.ok(findFile(files, 'rpm', ['AppImage', 'deb', 'pacman']).url.href.endsWith('-linux-x86_64.rpm'))
})

// ---- the "Get beta builds" setting -----------------------------------------------------------
// The setting is one property, allowPrerelease, chosen independently of the running version
// (update-channel.js). These are the transitions that choice makes possible and the installer
// someone downloaded used to decide.

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: a stable copy that opts in is offered the newest beta from that beta's own feed`, async () => {
    const { client, requests } = provider('0.14.0', true, platform)
    const info = await client.getLatestVersion()
    assert.equal(info.version, '0.15.0-beta.3')
    const suffix = { win32: '', darwin: '-mac', linux: LINUX_FEED }[platform]
    assert.ok(requests.some(route => route.endsWith(`/v0.15.0-beta.3/beta${suffix}.yml`)))
    assert.ok(requests.every(route => !route.includes('mac.6')))
  })

  test(`${platform}: a beta copy that opts out hears of no more betas, and is never pointed at one`, async () => {
    const { client, requests } = provider('0.15.0-beta.1', false, platform)
    const info = await client.getLatestVersion()
    // Older than what is installed, so the updater does nothing with it: downgrades are off.
    assert.equal(info.version, '0.14.0')
    assert.ok(requests.every(route => !route.includes('/download/v0.15.0')))
  })

  test(`${platform}: a beta copy that opted out moves to the stable release when it ships`, async () => {
    const { client } = provider('0.15.0-beta.1', false, platform, true)
    assert.equal((await client.getLatestVersion()).version, '1.0.0')
  })

  test(`${platform}: a stable copy that opted in still gets the stable release when that is newest`, async () => {
    const { client, requests } = provider('0.14.0', true, platform, true)
    assert.equal((await client.getLatestVersion()).version, '1.0.0')
    assert.ok(requests.every(route => !route.includes('/download/v0.15.0')))
  })
}
