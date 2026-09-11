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

function provider(currentVersion, allowPrerelease) {
  const requests = []
  const executor = { async request(options) {
    const route = options.path
    requests.push(route)
    if (route.endsWith('/releases.atom')) return feed
    if (route.endsWith('/releases/latest')) return JSON.stringify({ tag_name: 'v0.14.0' })
    const match = /\/download\/v(0\.15\.0-beta\.3|0\.14\.0)\/(beta|latest)\.yml$/.exec(route)
    assert.ok(match, `Unexpected updater request: ${route}`)
    const version = match[1]
    const name = `SpawnLoft-Setup-${version}.exe`
    return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: Zml4dHVyZQ==\n    size: 42\npath: ${name}\nsha512: Zml4dHVyZQ==\n`
  } }
  return {
    client: new GitHubProvider({ provider: 'github', owner: 'joogiebear', repo: 'spawnloft' },
      { currentVersion, allowPrerelease, fullChangelog: false }, { platform: 'win32', executor }),
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

test('stable Windows stays on the stable release when paired betas exist', async () => {
  const { client, requests } = provider('0.14.0', false)
  const info = await client.getLatestVersion()
  assert.equal(info.version, '0.14.0')
  assert.ok(requests.some(route => route.endsWith('/releases/latest')))
  assert.ok(requests.every(route => !route.includes('/download/v0.15.0')))
})
