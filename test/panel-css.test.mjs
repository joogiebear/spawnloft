import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The rules that keep Tailwind and the hand-written stylesheets from stepping on each other
// (src/panel/tailwind/panel.css says why each exists). None of this needs the Tailwind program:
// it reads the committed files. Whether the committed tailwind.css is what the pinned program
// builds is checked by `node tools/panel-css.mjs --check`, in CI.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const panel = path.join(root, 'src', 'panel')
const read = (...parts) => fs.readFileSync(path.join(panel, ...parts), 'utf8')

// every stylesheet the panel serves, as css/<name>
function sheets(dir = 'css') {
  return fs.readdirSync(path.join(panel, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sheets(`${dir}/${e.name}`) : e.name.endsWith('.css') ? [`${dir}/${e.name}`] : [])
    .sort()
}
const legacySheets = () => sheets().filter((name) => name !== 'css/tokens.css' && name !== 'css/tailwind.css')

// CSS with its comments and strings blanked, so braces and dots inside them count for nothing
function bare(css) {
  return css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (m[0] === '/' ? ' ' : '""'))
}

// The blocks of a stylesheet as a tree: { prelude, children }. A block with no nested block is
// a leaf (a style rule's declarations, or a keyframe step).
function blocks(css) {
  const src = bare(css)
  const top = { prelude: '', children: [] }
  const stack = [top]
  let from = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '{') {
      const node = { prelude: src.slice(from, i).trim(), children: [] }
      stack[stack.length - 1].children.push(node)
      stack.push(node)
      from = i + 1
    } else if (c === '}') {
      assert.ok(stack.length > 1, 'a } without its {')
      stack.pop()
      from = i + 1
    } else if (c === ';') from = i + 1
  }
  assert.equal(stack.length, 1, 'a { without its }')
  return top.children
}

// Style rules: blocks whose prelude is a selector, wherever they are nested. Keyframe steps and
// the at-rules themselves are not rules.
function styleRules(nodes, out = []) {
  for (const node of nodes) {
    if (/^@(-webkit-)?keyframes\b/.test(node.prelude) || /^@(font-face|property|page)\b/.test(node.prelude)) continue
    if (node.prelude.startsWith('@')) styleRules(node.children, out)
    else { out.push(node.prelude); styleRules(node.children, out) }
  }
  return out
}

// the names of every @keyframes, wherever it is nested
function keyframes(nodes, out = []) {
  for (const node of nodes) {
    const m = /^@(?:-webkit-)?keyframes\s+(\S+)/.exec(node.prelude)
    if (m) out.push(m[1])
    else keyframes(node.children, out)
  }
  return out
}

// declarations in the style rules of a sheet: what is left of a rule's block once its nested
// blocks are taken out, split at `;`
function declarations(css) {
  let src = bare(css).replace(/@(?:-webkit-)?keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ' ')
  let n = 0
  for (;;) {
    let hit = false
    src = src.replace(/\{([^{}]*)\}/g, (_, body) => { hit = true; n += body.split(';').filter((d) => d.includes(':')).length; return ' ' })
    if (!hit) return n
  }
}

const classesIn = (selectors) => new Set(selectors.flatMap((s) =>
  [...s.matchAll(/\.((?:\\.|[A-Za-z0-9_-])+)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'))))

test('each page loads the tokens, then the Tailwind file, then any stylesheets of its own', () => {
  for (const file of ['ui.html', 'launcher.html', 'setup.html']) {
    const page = read(file).replace(/<!--[\s\S]*?-->/g, '')
    const links = [...page.matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g)].map((m) => m[1])
    // every stylesheet a page has is one of those tags: none spelled another way, none inline
    assert.equal((page.match(/<link\b[^>]*stylesheet/gi) || []).length, links.length, `${file}: a stylesheet link not written as <link rel="stylesheet" href="/assets/...">`)
    assert.ok(!/<style\b/i.test(page), `${file}: a <style> block would sit outside the layers`)
    // the Tailwind file declares the layer order, so it has to come before the first old sheet
    assert.deepEqual(links.slice(0, 2), ['css/tokens.css', 'css/tailwind.css'], file)
    for (const name of links) assert.ok(fs.existsSync(path.join(panel, name)), `${file} links ${name}, which is not there`)
  }
})

test('the built Tailwind file declares the layer order before anything else', () => {
  const css = read('css', 'tailwind.css')
  assert.match(css, /^\/\*! tailwindcss v[\d.]+ \| MIT License/, 'the licence line Tailwind writes is kept')
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'tailwind-pin.json'), 'utf8'))
  assert.ok(css.startsWith(`/*! tailwindcss v${pin.version} `), `built with the pinned Tailwind ${pin.version}`)
  const first = bare(css).replace(/@layer properties;/, '').trim()
  assert.ok(first.startsWith('@layer theme, base, legacy, components, utilities;'), 'the layer order comes first')
  assert.ok(!css.includes('\r'), 'LF line ends, so the file is the same bytes on every system')
})

test('every hand-written stylesheet is one `legacy` layer; the tokens are in no layer', () => {
  assert.ok(legacySheets().length >= 3)
  for (const name of legacySheets()) {
    const css = bare(read(name))
    const top = blocks(css)
    assert.deepEqual(top.map((b) => b.prelude), ['@layer legacy'],
      `${name}: everything in it belongs inside one \`@layer legacy { ... }\`, so a Tailwind class always wins over an old rule`)
    // and nothing beside the block: an @import or an @layer statement has no braces to be seen by
    assert.equal(css.slice(0, css.indexOf('{')).trim(), '@layer legacy', `${name}: something stands before \`@layer legacy {\``)
    assert.equal(css.slice(css.lastIndexOf('}') + 1).trim(), '', `${name}: something stands after the layer's closing brace`)
  }
  // unlayered, so a token always wins over anything a layer might say about the same name
  assert.ok(!/@layer\b/.test(bare(read('css', 'tokens.css'))), 'css/tokens.css stays outside the layers')
})

test('no class is defined both by Tailwind and by a hand-written stylesheet', () => {
  const tailwind = classesIn(styleRules(blocks(read('css', 'tailwind.css'))))
  for (const name of legacySheets()) {
    const both = [...classesIn(styleRules(blocks(read(name))))].filter((c) => tailwind.has(c))
    assert.deepEqual(both, [], `${name} and css/tailwind.css both define .${both[0]}: an element with that class would get both. Delete the old rule in the same change, or use another name.`)
  }
})

test('no animation is defined both by Tailwind and by a hand-written stylesheet', () => {
  // Tailwind writes @keyframes outside the layers, so its copy would replace an old one of the same name
  const tailwind = new Set(keyframes(blocks(read('css', 'tailwind.css'))))
  for (const name of legacySheets()) {
    const both = keyframes(blocks(read(name))).filter((k) => tailwind.has(k))
    assert.deepEqual(both, [], `${name} and css/tailwind.css both define @keyframes ${both[0]}`)
  }
})

test('the hand-written stylesheets only shrink', () => {
  const file = path.join(panel, 'tailwind', 'legacy-rules.json')
  const record = JSON.parse(fs.readFileSync(file, 'utf8'))
  const recorded = record.rules
  const now = legacySheets().reduce((n, name) => n + styleRules(blocks(read(name))).length, 0)
  // a rule can also grow without the count of rules moving, so the declarations are counted too
  const lines = legacySheets().reduce((n, name) => n + declarations(read(name)), 0)
  assert.ok(lines <= record.declarations,
    `the old stylesheets have ${lines} declarations and src/panel/tailwind/legacy-rules.json records ${record.declarations}. New styles are written with Tailwind classes (src/panel/tailwind/panel.css); the old sheets only lose them.`)
  assert.equal(lines, record.declarations,
    `the old stylesheets are down to ${lines} declarations: record that in src/panel/tailwind/legacy-rules.json (it says ${record.declarations})`)
  assert.ok(now <= recorded,
    `the old stylesheets have ${now} rules and src/panel/tailwind/legacy-rules.json records ${recorded}. New styles are written with Tailwind classes (src/panel/tailwind/panel.css); the old sheets only lose rules.`)
  assert.equal(now, recorded,
    `the old stylesheets are down to ${now} rules: record that in src/panel/tailwind/legacy-rules.json (it says ${recorded}), so the number cannot creep back up`)
})

test('Tailwind reads class names only from files named in panel.css, and they exist', () => {
  const input = read('tailwind', 'panel.css')
  assert.match(bare(input), /@import "" layer\(utilities\) source\(none\);/, 'automatic scanning stays off: any word in a scanned file can become a class')
  for (const m of input.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@source\s+"([^"]+)"/g)) {
    const target = path.resolve(panel, 'tailwind', m[1])
    assert.ok(target.startsWith(panel + path.sep), `@source "${m[1]}" is outside src/panel`)
    assert.ok(fs.existsSync(target), `@source "${m[1]}" is not there`)
  }
})

test('the Tailwind pin names one release and a sha256 for each program', () => {
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'tailwind-pin.json'), 'utf8'))
  assert.match(pin.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pin.release, `https://github.com/tailwindlabs/tailwindcss/releases/download/v${pin.version}/`)
  for (const key of ['linux-x64', 'darwin-arm64', 'win32-x64']) assert.ok(pin.programs[key], `no program pinned for ${key}`)
  for (const [key, entry] of Object.entries(pin.programs)) {
    assert.match(entry.file, /^tailwindcss-[a-z0-9-]+(\.exe)?$/, key)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, key)
  }
})
