'use strict'

const fs = require('node:fs')
const path = require('node:path')

// Stable-only vs stable-plus-betas. The only lever is `allowPrerelease`; version ordering does the
// rest. Opting out never downgrades: the copy stays on its beta and moves on at the next stable.
//
// `channel` is deliberately never set: the GitHub provider reads it from each release's tag, and
// assigning it switches `allowDowngrade` on. Downgrading could open a data folder written by a
// newer build, so allowDowngrade is forced off in apply().

const PRERELEASE = /^\d+\.\d+\.\d+-/

// a beta build was installed by someone who went looking for betas
function defaultFor(version) {
  return PRERELEASE.test(String(version))
}

// true, false, or null when nobody has chosen
function load(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof saved.beta === 'boolean' ? saved.beta : null
  } catch {
    // missing or unreadable
    return null
  }
}

function save(file, beta) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ beta: beta === true }, null, 2))
  fs.renameSync(tmp, file)
}

// waitingFor: a beta build that opted out does nothing until the stable release of its own
// version ships, and the panel needs to be able to say so
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
