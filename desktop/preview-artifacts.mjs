import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { cliPackageNames } from './build-cli-package.mjs'

export const TARGETS = [
  { platform: 'win32', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
]
// Each packaging system has its own names for the architectures, and electron-builder puts the
// native one in the filename: amd64 and arm64 for a .deb, x86_64 and aarch64 for an .rpm.
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' }
const RPM_ARCH = { x64: 'x86_64', arm64: 'aarch64' }
/** The installable Linux packages for one architecture, without their feeds. */
export const linuxPackages = ({ arch, version }) => [`SpawnLoft-${version}-linux-${DEB_ARCH[arch]}.deb`, `SpawnLoft-${version}-linux-${RPM_ARCH[arch]}.rpm`]
export const manifestName = ({ platform, arch }) => `preview-build-${platform}-${arch}.json`
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding)

export function validateIdentity(info, expected = {}) {
  if (expected.stable) {
    if (!/^\d+\.\d+\.\d+$/.test(info.version || '') || info.sourceVersion !== info.version ||
        !/^[0-9a-f]{40}$/.test(info.commit || '') || info.dirty !== false) {
      throw new Error('A clean stable source version and full commit are required')
    }
  } else {
  const source = /^(\d+\.\d+\.\d+)-[0-9A-Za-z.-]+$/.exec(info.sourceVersion || '')
  if (!source || !/^[0-9a-f]{40}$/.test(info.commit || '') || info.dirty !== false) {
    throw new Error('A clean development source version and full commit are required')
  }
  const prefix = source[1] + '-beta.'
  const sequence = String(info.version || '').slice(prefix.length)
  if (!String(info.version || '').startsWith(prefix) || !/^[1-9]\d*$/.test(sequence)) {
    throw new Error('Expected a numbered beta version based on the source version')
  }
  const sourceBeta = /-beta\.(\d+)$/.exec(info.sourceVersion)
  if (sourceBeta && Number(sequence) <= Number(sourceBeta[1])) throw new Error('Beta must be newer than the source version')
  }
  if (!TARGETS.some(target => target.platform === info.platform && target.arch === info.arch)) {
    throw new Error('Unexpected build platform or architecture')
  }
  for (const key of ['version', 'sourceVersion', 'commit', 'platform', 'arch']) {
    if (expected[key] !== undefined && expected[key] !== info[key]) throw new Error(`Unexpected build ${key}`)
  }
}

export function artifactNames({ platform, arch, version }) {
  if (platform === 'win32' && arch === 'x64') {
    const installer = `SpawnLoft-Setup-${version}.exe`
    return [installer, installer + '.blockmap', 'latest.yml', 'beta.yml']
  }
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    return ['dmg', 'zip'].map(ext => `SpawnLoft-${version}-mac-${arch}.${ext}`)
  }
  if (platform === 'linux' && Object.hasOwn(DEB_ARCH, arch)) {
    // The command-line packages are released and verified with the rest, and are in no feed: nothing
    // updates them but the package manager that installed them.
    return [...linuxPackages({ arch, version }), ...linuxFeedNames(arch), ...cliPackageNames({ arch, version })]
  }
  throw new Error('Unexpected build platform or architecture')
}

// Beta installations prefer beta.yml and fall back to latest.yml. Validate the
// small electron-builder schema without adding YAML to the core's dependencies.
export function verifyWindowsFeed(text, version, installerName, installerBytes) {
  const fields = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^(\s*)(- )?(version|files|url|sha512|size|path|releaseDate):\s*(.*?)\s*$/.exec(line)
    if (!match) throw new Error('Unexpected Windows updater feed field')
    let value = match[4]
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1)
    fields.push({ indent: match[1].length, list: Boolean(match[2]), key: match[3], value })
  }
  const scalar = (key, nested = false) => {
    const found = fields.filter(field => field.key === key && (nested ? field.indent > 0 : field.indent === 0))
    if (found.length !== 1) throw new Error(`Invalid Windows updater feed ${key}`)
    return found[0].value
  }
  const sha512 = digest(installerBytes, 'sha512', 'base64')
  if (scalar('version') !== version || scalar('path') !== installerName || scalar('sha512') !== sha512 ||
      scalar('files') !== '' || scalar('url', true) !== installerName || scalar('sha512', true) !== sha512 ||
      scalar('size', true) !== String(installerBytes.length) || fields.filter(field => field.list).length !== 1 ||
      !fields.some(field => field.key === 'url' && field.list)) {
    throw new Error('Windows updater feed does not match the verified installer')
  }
  const expectedKeys = ['version', 'files', 'url', 'sha512', 'size', 'path', 'sha512']
  if (JSON.stringify(fields.filter(field => field.key !== 'releaseDate').map(field => field.key)) !== JSON.stringify(expectedKeys) ||
      fields.filter(field => field.key === 'releaseDate').length > 1) throw new Error('Invalid Windows updater feed structure')
}

export function createManifest(dir, info, target, policy = {}) {
  const identity = { sourceVersion: info.sourceVersion, version: info.version, commit: info.commit, dirty: info.dirty, ...target }
  // New builds record the native identity in after-pack. A supplied target must
  // agree with that provenance, rather than merely relabelling an artifact.
  validateIdentity(identity, policy)
  if (info.platform !== target.platform) throw new Error('Build provenance platform mismatch')
  if (info.arch !== target.arch) throw new Error('Build provenance architecture mismatch')
  if (target.platform === 'darwin') {
    if (!['ad-hoc', 'signed'].includes(info.macSigningMode)) throw new Error('Missing or invalid Mac signing mode')
    identity.macSigningMode = info.macSigningMode
  }
  if (policy.stable && target.platform === 'win32') {
    if (info.windowsSigningMode !== 'azure') throw new Error('Stable Windows builds require Azure signing')
    identity.windowsSigningMode = info.windowsSigningMode
  }
  const assets = artifactNames(identity).map(name => {
    const bytes = fs.readFileSync(path.join(dir, name))
    if (!bytes.length) throw new Error(`Empty artifact: ${name}`)
    return { name, size: bytes.length, sha256: digest(bytes) }
  })
  if (identity.platform === 'win32') {
    verifyWindowsFeeds(dir, identity.version, assets[0].name)
  }
  if (identity.platform === 'linux') {
    verifyLinuxFeeds(dir, identity.version, identity.arch, linuxPackages(identity))
  }
  return { ...identity, assets }
}

export function verifyRelease(dir, expected) {
  const manifests = TARGETS.map(target => {
    const name = manifestName(target)
    const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    validateIdentity(info, { ...expected, ...target })
    return { name, info }
  })
  const first = manifests[0].info
  if (expected.stable && first.windowsSigningMode !== 'azure') throw new Error('Stable Windows builds require Azure signing')
  const macModes = manifests.filter(({ info }) => info.platform === 'darwin').map(({ info }) => info.macSigningMode)
  if (macModes.some(mode => !['ad-hoc', 'signed'].includes(mode)) || new Set(macModes).size !== 1 ||
      (expected.stable && macModes[0] !== 'signed') ||
      (expected.macSigningMode !== undefined && macModes[0] !== expected.macSigningMode)) {
    throw new Error('Mac signing mode must match on both architectures and the release policy')
  }
  const assets = []
  for (const { name, info } of manifests) {
    validateIdentity(info, { stable: expected.stable, version: first.version, sourceVersion: first.sourceVersion, commit: first.commit })
    const required = artifactNames(info)
    if (!Array.isArray(info.assets) || info.assets.length !== required.length ||
        new Set(info.assets.map(asset => asset.name)).size !== required.length ||
        info.assets.some(asset => !required.includes(asset.name))) throw new Error(`Unexpected artifact list in ${name}`)
    for (const artifact of info.assets) {
      const bytes = fs.readFileSync(path.join(dir, artifact.name))
      if (!bytes.length || artifact.size !== bytes.length || artifact.sha256 !== digest(bytes)) throw new Error(`Artifact verification failed: ${artifact.name}`)
      assets.push({ ...artifact, path: path.join(dir, artifact.name) })
    }
    const bytes = fs.readFileSync(path.join(dir, name))
    assets.push({ name, path: path.join(dir, name), size: bytes.length, sha256: digest(bytes) })
  }
  const installerName = artifactNames(first)[0]
  verifyWindowsFeeds(dir, first.version, installerName)
  for (const { info } of manifests.filter(({ info }) => info.platform === 'linux')) {
    verifyLinuxFeeds(dir, info.version, info.arch, linuxPackages(info))
  }
  return { version: first.version, sourceVersion: first.sourceVersion, commit: first.commit, macSigningMode: macModes[0], assets }
}

function verifyWindowsFeeds(dir, version, installerName) {
  const latest = fs.readFileSync(path.join(dir, 'latest.yml'))
  const beta = fs.readFileSync(path.join(dir, 'beta.yml'))
  if (!latest.equals(beta)) throw new Error('Windows beta.yml and latest.yml must be identical')
  verifyWindowsFeed(latest.toString('utf8'), version, installerName, fs.readFileSync(path.join(dir, installerName)))
}

/**
 * A Linux feed lists every package built for one architecture - the .deb and the .rpm - and the
 * installed app takes the one matching the marker its own package left behind. So unlike the
 * Windows feed it has several `files`, and each has to describe the bytes that ship under that name:
 * a feed that is right about the .deb and wrong about the .rpm strands every Fedora install on the
 * version it has. `path` and the top-level hash must agree with one of them.
 */
export function verifyLinuxFeed(text, version, packages) {
  const fields = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^(\s*)(- )?(version|files|url|sha512|size|path|releaseDate):\s*(.*?)\s*$/.exec(line)
    if (!match) throw new Error('Unexpected Linux updater feed field')
    let value = match[4]
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1)
    fields.push({ indent: match[1].length, list: Boolean(match[2]), key: match[3], value })
  }
  const top = key => {
    const found = fields.filter(field => field.key === key && field.indent === 0)
    if (found.length !== 1) throw new Error(`Invalid Linux updater feed ${key}`)
    return found[0].value
  }
  // Each list item is a url followed by its sha512 and size, in the order electron-builder writes them.
  const listed = []
  for (const field of fields.filter(field => field.indent > 0)) {
    if (field.list) {
      if (field.key !== 'url') throw new Error('Invalid Linux updater feed structure')
      listed.push({ url: field.value })
    } else if (!listed.length || field.key in listed.at(-1) || !['sha512', 'size'].includes(field.key)) {
      throw new Error('Invalid Linux updater feed structure')
    } else listed.at(-1)[field.key] = field.value
  }
  if (top('version') !== version || top('files') !== '' || listed.length !== packages.length ||
      fields.filter(field => field.key === 'releaseDate').length > 1) throw new Error('Linux updater feed does not match the verified packages')
  for (const { name, bytes } of packages) {
    const entry = listed.filter(item => item.url === name)
    if (entry.length !== 1 || entry[0].sha512 !== digest(bytes, 'sha512', 'base64') || entry[0].size !== String(bytes.length)) {
      throw new Error(`Linux updater feed does not match the verified package: ${name}`)
    }
  }
  const primary = listed.find(item => item.url === top('path'))
  if (!primary || primary.sha512 !== top('sha512')) throw new Error('Linux updater feed names a package it does not list')
}

// electron-updater names the Linux feed for the machine: latest-linux.yml on x64 and
// latest-linux-arm64.yml on arm64, with a beta- twin for an installation on the beta channel.
export const linuxFeedNames = arch => ['latest', 'beta'].map(channel => `${channel}-linux${arch === 'x64' ? '' : `-${arch}`}.yml`)

function verifyLinuxFeeds(dir, version, arch, packageNames) {
  const [latestName, betaName] = linuxFeedNames(arch)
  const latest = fs.readFileSync(path.join(dir, latestName))
  if (!latest.equals(fs.readFileSync(path.join(dir, betaName)))) throw new Error(`Linux ${betaName} and ${latestName} must be identical`)
  verifyLinuxFeed(latest.toString('utf8'), version, packageNames.map(name => ({ name, bytes: fs.readFileSync(path.join(dir, name)) })))
}

export function verifyPublishedRelease(release, resolvedCommit, verified) {
  if (release.draft || !release.prerelease || release.tag_name !== `v${verified.version}` || resolvedCommit !== verified.commit) {
    throw new Error('Existing release has a different target or is not a published prerelease')
  }
  if (!Array.isArray(release.assets) || release.assets.length !== verified.assets.length) throw new Error('Existing release has a different artifact set')
  for (const local of verified.assets) {
    const matches = release.assets.filter(asset => asset.name === local.name)
    if (matches.length !== 1 || matches[0].size !== local.size || matches[0].digest !== `sha256:${local.sha256}`) {
      throw new Error(`Existing published artifact differs or cannot be verified: ${local.name}`)
    }
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.join(here, 'dist')
  const target = { platform: process.argv[2], arch: process.argv[3] }
  const info = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8'))
  const manifest = createManifest(dir, info, target)
  fs.writeFileSync(path.join(dir, manifestName(target)), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Verified ${target.platform}/${target.arch} artifacts for ${manifest.version}`)
}
