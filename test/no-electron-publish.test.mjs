// The 2.0 line (v2) must never publish an Electron build. desktop-preview.yml published a numbered
// beta to every 1.6 beta user on each push to dev, so the v2 -> dev merge would have shipped the v2
// tree inside the Electron shell (PLAN-2.0-REMAINING D1, Q-U). It and desktop-stable.yml are
// retired here; these checks keep them, or anything like them, from coming back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.github', 'workflows')
const workflows = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).map(f => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))

test('the Electron beta and stable workflows are gone', () => {
  for (const file of ['desktop-preview.yml', 'desktop-stable.yml']) assert.ok(!fs.existsSync(path.join(dir, file)), `${file} is retired`)
  assert.ok(!fs.existsSync(path.join(root, 'desktop', 'publish-preview.mjs')), 'the beta publisher is retired with it')
})

test('no workflow publishes anything or can write to the repository', () => {
  for (const { file, text } of workflows) {
    assert.doesNotMatch(text, /contents:\s*write/, `${file} asks for contents: write`)
    assert.doesNotMatch(text, /publish-(preview|stable)\.mjs|release-stable\.mjs|finish-release\.mjs/, `${file} runs a 1.x publisher`)
    assert.doesNotMatch(text, /\bgh release (create|upload|edit)\b/, `${file} makes or changes a release`)
    // electron-builder publishes by itself unless told not to
    for (const line of text.split('\n').filter(l => /electron-builder\b/.test(l) && !/^\s*#/.test(l))) {
      assert.match(line, /--publish never\b/, `${file}: ${line.trim()}`)
    }
  }
})

test('the 1.x stable release scripts refuse to run on this line', () => {
  for (const file of ['release-stable.mjs', 'publish-stable.mjs']) {
    const text = fs.readFileSync(path.join(root, 'desktop', file), 'utf8')
    assert.match(text, /^process\.exit\(1\)$/m, `${file} stops before doing anything`)
  }
})
