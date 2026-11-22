import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.github', 'workflows')

// A YAML parser: the core has no dependencies to take one from, so the Linux CI job installs a
// pinned js-yaml outside the repository and names it in SPAWNLOFT_YAML_DIR. In CI a missing parser
// is a failure; on a machine without one the test is skipped.
let yaml = null
for (const base of [process.env.SPAWNLOFT_YAML_DIR, root].filter(Boolean)) {
  try { yaml = createRequire(path.join(base, 'package.json'))('js-yaml'); break } catch { /* not there */ }
}
if (!yaml && process.env.SPAWNLOFT_YAML_DIR) throw new Error(`js-yaml is not in ${process.env.SPAWNLOFT_YAML_DIR}`)

test('every workflow file is valid YAML with jobs in it', { skip: yaml ? false : 'js-yaml is not installed (set SPAWNLOFT_YAML_DIR to a folder with node_modules/js-yaml)' }, () => {
  // GitHub does not fail a workflow it cannot parse: it lists it under its file path, runs nothing,
  // and the pull request shows green. A colon followed by a space inside a one-line run: starts a key.
  for (const file of fs.readdirSync(dir).filter(name => /\.ya?ml$/.test(name))) {
    let parsed
    assert.doesNotThrow(() => { parsed = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8')) }, `${file} does not parse`)
    assert.ok(parsed && typeof parsed.jobs === 'object' && Object.keys(parsed.jobs).length > 0, `${file} has no jobs`)
    for (const [name, job] of Object.entries(parsed.jobs)) {
      assert.ok(Array.isArray(job.steps) && job.steps.length > 0, `${file}: job ${name} has no steps`)
    }
  }
})
