#!/usr/bin/env node
// Sets the version in the core's package.json, the desktop's, and the desktop lockfile, which must
// agree (publish-stable.mjs refuses a release where they don't). `npm version` only handles its
// own folder. Text is edited rather than re-serialised so line endings and layout stay put.
//
//   node desktop/set-version.mjs 1.3.0-beta.1     # the start of a month's work on dev
//   node desktop/set-version.mjs 1.3.0            # a release branch
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/

export function setPackageVersion(text, version) {
  const found = /^(\s*"version":\s*")([^"]+)(")/m.exec(text)
  if (!found) throw new Error('no version field found')
  return { text: text.slice(0, found.index) + found[1] + version + found[3] + text.slice(found.index + found[0].length), from: found[2] }
}

// the package's own version appears twice, first in the file (top level and packages[""]),
// followed by every dependency's
export function setLockVersion(text, version) {
  const own = JSON.parse(text)
  if (own.version !== own.packages?.['']?.version) throw new Error('the lockfile disagrees with itself about the version')
  let seen = 0
  const next = text.replace(/("version":\s*")([^"]+)(")/g, (whole, open, current, close) =>
    current === own.version && seen++ < 2 ? open + version + close : whole)
  const check = JSON.parse(next)
  if (check.version !== version || check.packages[''].version !== version) throw new Error('the lockfile version could not be set')
  return { text: next, from: own.version }
}

const here = path.dirname(fileURLToPath(import.meta.url))
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!VERSION_RE.test(version ?? '')) {
    console.error('usage: node desktop/set-version.mjs <X.Y.Z | X.Y.Z-beta.N>')
    process.exit(2)
  }
  const files = [
    [path.join(here, '..', 'package.json'), setPackageVersion],
    [path.join(here, 'package.json'), setPackageVersion],
    [path.join(here, 'package-lock.json'), setLockVersion],
  ]
  // compute every edit before writing any, so a failure can't leave the files disagreeing
  const edits = files.map(([file, set]) => ({ file, ...set(fs.readFileSync(file, 'utf8'), version) }))
  for (const { file, text, from } of edits) {
    fs.writeFileSync(file, text)
    console.log(`${path.relative(path.join(here, '..'), file)}: ${from} -> ${version}`)
  }
  console.log(version.includes('-')
    ? 'A prerelease version: every merge into dev from here publishes a beta.'
    : 'A stable version: previews switch themselves off. This belongs on a release branch headed for main.')
}
