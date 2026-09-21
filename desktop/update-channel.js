'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * Which releases this copy follows: the monthly stable ones, or the betas between them as well.
 *
 * <p>Until this existed the answer was whichever installer someone had downloaded. electron-updater
 * follows prereleases when the running version is one and not otherwise, so the only way to change
 * lanes was to find the other installer on GitHub and run it by hand.
 *
 * <p>The whole mechanism is one property, `allowPrerelease`, and the ordering of versions does the
 * rest. Opted in, a stable 1.1.0 is offered 1.2.0-beta.N, then each beta after it, then 1.2.0
 * itself - which outranks every beta of it - and then 1.3.0's betas. Opted out again, nothing is
 * taken away: the copy stays on the beta it has, hears of no more betas, and moves to the next
 * stable release when that ships.
 *
 * <p>Two things are deliberately never done. `channel` is never set: the GitHub provider reads the
 * channel from each release's own tag, and assigning `channel` has the side effect of switching
 * `allowDowngrade` on. And nothing is ever downgraded, because an older build opening a data folder
 * a newer one has written to is how someone loses a server; `allowDowngrade` is forced off here in
 * case a later version of the library changes its mind about the default.
 *
 * <p>Its own module for the reason window-state.js is: the deciding is worth testing without
 * launching an application.
 */

const PRERELEASE = /^\d+\.\d+\.\d+-/

/** A build that is itself a beta was installed by someone who went looking for betas. */
function defaultFor(version) {
  return PRERELEASE.test(String(version))
}

/** The saved choice: true, false, or null when nobody has made one. */
function load(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof saved.beta === 'boolean' ? saved.beta : null
  } catch {
    // Missing, or not ours. Nobody has chosen.
    return null
  }
}

function save(file, beta) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ beta: beta === true }, null, 2))
  fs.renameSync(tmp, file)
}

/**
 * What the panel shows and the updater is given.
 *
 * <p>`waitingFor` is the case that would otherwise look broken: a beta build that has opted out
 * does nothing at all until the stable release of its own version ships, and the panel has to be
 * able to say so.
 */
function describe(file, version) {
  const chosen = load(file)
  const beta = chosen ?? defaultFor(version)
  const onBetaBuild = defaultFor(version)
  return {
    beta,
    chosen: chosen !== null,
    onBetaBuild,
    waitingFor: !beta && onBetaBuild ? String(version).split('-')[0] : null,
  }
}

function apply(updater, beta) {
  updater.allowPrerelease = beta === true
  updater.allowDowngrade = false
}

module.exports = { defaultFor, load, save, describe, apply }
