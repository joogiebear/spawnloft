// The one Node.js the packages carry: the 1.x command-line package (build-cli-package.mjs) and
// the 2.0 runtime folder (rust/crates/spawnloft-shell/installer/stage-runtime.mjs), until the core
// port (2.1) takes Node out of the package. Bump the version and every hash together, from
// https://nodejs.org/dist/v<version>/SHASUMS256.txt; the release gate checks the staged copy
// against these.
export const NODE_VERSION = '24.21.0'

// archive file name (after node-v<version>-) -> sha256
export const NODE_ARCHIVES = {
  'win-x64.zip': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
  'win-arm64.zip': '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
  'darwin-arm64.tar.xz': '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
  'linux-x64.tar.xz': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  'linux-arm64.tar.xz': '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
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
