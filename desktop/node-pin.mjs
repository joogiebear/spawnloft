// The one Node.js the packages carry: the 1.x command-line package (build-cli-package.mjs) and
// the 2.0 runtime folder (rust/crates/spawnloft-shell/installer/stage-runtime.mjs), until the core
// port (2.1) takes Node out of the package. Bump the version and every hash together, from
// https://nodejs.org/dist/v<version>/SHASUMS256.txt; the release gate checks the staged copy
// against these.
export const NODE_VERSION = '24.22.2'

// The major line the packages stay on. Victor (2026-11-12): 2.0 ships on Node 24; moving to a newer
// LTS line (26) is a later decision of its own. tools/check-node-pin.mjs tracks releases in this
// line and only mentions a newer major, without failing or opening an issue for it. Raise it in
// the same commit that moves NODE_VERSION to the new line.
export const NODE_HELD_MAJOR = 24

// archive file name (after node-v<version>-) -> sha256
export const NODE_ARCHIVES = {
  'win-x64.zip': 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
  'win-arm64.zip': 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468',
  'darwin-arm64.tar.xz': '1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115',
  'linux-x64.tar.xz': '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75',
  'linux-arm64.tar.xz': 'eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8',
}

// Node's names for a platform and architecture (process.platform / process.arch values)
const OS = { win32: 'win', darwin: 'darwin', linux: 'linux' }

export function nodeArchive(platform, arch) {
  const os = OS[platform]
  const key = Object.keys(NODE_ARCHIVES).find((k) => k.startsWith(`${os}-${arch}.`))
  if (!os || !key) throw new Error(`no pinned Node.js archive for ${platform}-${arch}`)
  const base = `node-v${NODE_VERSION}-${os}-${arch}`
  return {
    base,
    file: `${base}.${key.slice(key.indexOf('.') + 1)}`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${base}.${key.slice(key.indexOf('.') + 1)}`,
    sha256: NODE_ARCHIVES[key],
    // where the executable sits inside the archive (and inside the staged folder)
    exe: platform === 'win32' ? 'node.exe' : 'bin/node',
  }
}
