// What a Tauri build may be versioned: X.Y.Z, X.Y.Z-beta.N or X.Y.Z-internal.N (the spike's
// throwaway versions included); anything else is a typo that would ship as the app's version.
// installer-config.mjs and mac-config.mjs refuse anything else.
export const BUILD_VERSION_RE = /^\d+\.\d+\.\d+(?:-(?:beta|internal)\.\d+)?$/

export function checkBuildVersion(version) {
  if (!BUILD_VERSION_RE.test(version ?? '')) throw new Error(`not a build version: ${version}`)
  return version
}
