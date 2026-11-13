// The one Node.js the packages carry: the 1.x command-line package (build-cli-package.mjs) and
// the 2.0 runtime folder (rust/crates/spawnloft-shell/installer/stage-runtime.mjs), until the core
// port (2.1) takes Node out of the package. Bump the version and every hash together, from
// https://nodejs.org/dist/v<version>/SHASUMS256.txt; the release gate checks the staged copy
// against these.
export const NODE_VERSION = '24.22.3'

// The major line the packages stay on. Victor (2026-11-12): 2.0 ships on Node 24; moving to a newer
// LTS line (26) is a later decision of its own. tools/check-node-pin.mjs tracks releases in this
// line and only mentions a newer major, without failing or opening an issue for it. Raise it in
// the same commit that moves NODE_VERSION to the new line.
export const NODE_HELD_MAJOR = 24

// archive file name (after node-v<version>-) -> sha256
export const NODE_ARCHIVES = {
  'win-x64.zip': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
  'win-arm64.zip': 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14',
  'darwin-arm64.tar.xz': '1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5',
  'linux-x64.tar.xz': '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb',
  'linux-arm64.tar.xz': '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c',
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
