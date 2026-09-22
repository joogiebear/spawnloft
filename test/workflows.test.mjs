import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.github', 'workflows')

// A YAML parser is only to hand where the desktop toolchain has been installed (electron-builder
// brings one); the core has no dependencies to take one from. CI installs it before the desktop
// previews and not before the plain test jobs, so this runs where it can.
let yaml = null
try { yaml = createRequire(path.join(root, 'desktop', 'package.json'))('js-yaml') } catch { /* not installed here */ }

test('every workflow file is valid YAML with jobs in it', { skip: yaml ? false : 'js-yaml is not installed (run npm ci in desktop/)' }, () => {
  // GitHub does not fail a workflow it cannot parse: it lists it under its file path, runs nothing,
  // and the pull request shows green without it. A one-line `run:` holding "? '' : '-'" did exactly
  // that - a colon followed by a space is the start of a key.
  for (const file of fs.readdirSync(dir).filter(name => /\.ya?ml$/.test(name))) {
    let parsed
    assert.doesNotThrow(() => { parsed = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')) }, `${file} does not parse`)
    assert.ok(parsed && typeof parsed.jobs === 'object' && Object.keys(parsed.jobs).length > 0, `${file} has no jobs`)
    for (const [name, job] of Object.entries(parsed.jobs)) {
      assert.ok(Array.isArray(job.steps) && job.steps.length > 0, `${file}: job ${name} has no steps`)
    }
  }
})
