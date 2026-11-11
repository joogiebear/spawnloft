// The Node core's package.json as a Tauri build ships it (resources/core/package.json), stamped
// with the build's version. The repository's package.json carries the 1.x line's version; the
// panel (src/ui.mjs), data-format.json's writtenBy (src/data-format.mjs), the diagnostics bundle
// and the launcher all read the copy beside src/, so an unstamped copy makes a 2.x install report
// 1.x. installer-config.mjs and mac-config.mjs map this file instead of ../../../package.json.
//
// The edit is desktop/set-version.mjs's own (setPackageVersion): only the "version" field
// changes, the layout stays as it is in the repository.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')
const { setPackageVersion } = await import(pathToFileURL(join(REPO, 'desktop', 'set-version.mjs')).href)

// what a Tauri build may be versioned: X.Y.Z, X.Y.Z-beta.N or X.Y.Z-internal.N (the spike's
// throwaway versions included); anything else is a typo that would ship as the app's version
export const BUILD_VERSION_RE = /^\d+\.\d+\.\d+(?:-(?:beta|internal)\.\d+)?$/

// Writes <outDir>/core-package.json and returns its absolute path.
export function writeCorePackage(version, outDir, source = join(REPO, 'package.json')) {
  if (!BUILD_VERSION_RE.test(version ?? '')) throw new Error(`not a build version: ${version}`)
  const { text, from } = setPackageVersion(readFileSync(source, 'utf8'), version)
  if (JSON.parse(text).version !== version) throw new Error('the core package.json version could not be set')
  const file = join(resolve(outDir), 'core-package.json')
  writeFileSync(file, text)
  console.log(`resources/core/package.json: ${from} -> ${version}`)
  return file
}
