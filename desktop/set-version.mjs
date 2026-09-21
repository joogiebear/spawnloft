#!/usr/bin/env node
/**
 * Set SpawnLoft's version, everywhere it is written down.
 *
 * <p>There are three places and they have to agree: the core's package.json, the desktop's, and
 * the two fields at the top of the desktop's lockfile. `npm version` only knows about the folder it
 * is run in, which is how the core and the desktop came to disagree once; publish-stable.mjs now
 * refuses a release where they do, so it is better never to get there.
 *
 *   node desktop/set-version.mjs 1.3.0-beta.1     # the start of a month's work on dev
 *   node desktop/set-version.mjs 1.3.0            # a release branch
 *
 * <p>Text is edited rather than parsed and re-serialised, so nothing else in the files moves and
 * their line endings stay as they were.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/

/** The first `"version": "..."` in a package.json is the package's own. */
export function setPackageVersion(text, version) {
  const found = /^(\s*"version":\s*")([^"]+)(")/m.exec(text)
  if (!found) throw new Error('no version field found')
  return { text: text.slice(0, found.index) + found[1] + version + found[3] + text.slice(found.index + found[0].length), from: found[2] }
}

/**
 * A lockfile records the package's own version twice - at the top, and under packages[""] - and
 * then the version of everything it depends on. Only the first two are this package's, and they
 * are the first two in the file.
 */
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
  // Every file is worked out before any is written: a failure half way must not leave them disagreeing.
  const edits = files.map(([file, set]) => ({ file, ...set(fs.readFileSync(file, 'utf8'), version) }))
  for (const { file, text, from } of edits) {
    fs.writeFileSync(file, text)
    console.log(`${path.relative(path.join(here, '..'), file)}: ${from} -> ${version}`)
  }
  console.log(version.includes('-')
    ? 'A prerelease version: every merge into dev from here publishes a beta.'
    : 'A stable version: previews switch themselves off. This belongs on a release branch headed for main.')
}
