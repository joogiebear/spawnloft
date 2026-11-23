import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The shared building blocks: Kit's makers (src/panel/js/shared/kit.js) and the classes they draw
// with (src/panel/tailwind/components.css, built into css/tailwind.css).

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const panel = path.join(root, 'src', 'panel')
const read = (...parts) => fs.readFileSync(path.join(panel, ...parts), 'utf8')
// Kit only touches the document when a maker is called, so its pure helpers run without one
const Kit = new Function(`${read('js', 'shared', 'kit.js')}\nreturn Kit`)()

test('a tile keeps its colour: one of six, the same for the same key every time', () => {
  const seen = new Set()
  for (const key of ['survival', 'creative', 'skyblock', 'lobby', 'minigames', 'hardcore', 'main-db', 'Ünïcödé', '']) {
    const tone = Kit.tileTone(key)
    assert.ok(Number.isInteger(tone) && tone >= 1 && tone <= 6, `${key}: ${tone}`)
    assert.equal(Kit.tileTone(key), tone)
    seen.add(tone)
  }
  assert.ok(seen.size >= 4, 'keys spread over the colours')
  // the three servers most screenshots show are three colours
  assert.equal(new Set(['survival', 'creative', 'skyblock'].map(Kit.tileTone)).size, 3)
})

test("a tile's letter is the first letter or digit of the name", () => {
  assert.equal(Kit.initial('survival'), 'S')
  assert.equal(Kit.initial('  [1.21] modded'), '1')
  assert.equal(Kit.initial('élan'), 'É')
  assert.equal(Kit.initial('---'), '?')
  assert.equal(Kit.initial(null), '?')
})

// every `sl-` class a source names, and every one the built stylesheet defines
const used = (text) => new Set([...text.matchAll(/\bsl-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((m) => m[0]))
const defined = () => new Set([...read('css', 'tailwind.css').matchAll(/\.(sl-[a-z0-9-]+)/g)].map((m) => m[1]))

test('every block class Kit and the components page use is one the stylesheet draws', () => {
  const have = defined()
  // ids and keyframes start sl- too: they are not classes
  const notClasses = new Set(['sl-field', 'sl-menu', 'sl-dialog', 'sl-panel', 'sl-tab', 'sl-spin', 'sl-breathe', 'sl-sweep'])
  for (const file of [['js', 'shared', 'kit.js'], ['js', 'components', 'gallery.js'], ['components.html']]) {
    for (const name of used(read(...file))) {
      if (notClasses.has(name) && !have.has(name)) continue
      assert.ok(have.has(name), `${file.join('/')} uses .${name}, which components.css does not define`)
    }
  }
})

test('the blocks are in the components layer and draw only from tokens', () => {
  const css = read('tailwind', 'components.css').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /^\s*@layer components \{/, 'one components layer, so a utility class still adjusts a block')
  // a colour is a token: no hex, rgb() or named colour written in
  for (const m of css.matchAll(/:\s*([^;{}]+);/g)) {
    const value = m[1]
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value), `a colour written in: ${value}`)
  }
  // every class here starts sl-, so none can collide with an old one or a utility
  for (const m of css.matchAll(/\.(-?[a-z_][\w-]*)/gi)) assert.ok(m[1].startsWith('sl-'), `.${m[1]} is not an sl- class`)
})
