import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The rules that keep the panel's styles in one place: the tokens and the Tailwind file, and no
// hand-written stylesheet beside them (src/panel/tailwind/panel.css says why each exists). None
// of this needs the Tailwind program: it reads the committed files. Whether the committed tailwind.css is what the pinned program
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

// CSS with its comments and strings blanked, so braces and dots inside them count for nothing
function bare(css) {
  return css.replace(/\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (m[0] === '/' ? ' ' : '""'))
}

test('each page loads the tokens, then the Tailwind file, and nothing else', () => {
  for (const file of ['ui.html', 'launcher.html', 'setup.html']) {
    const page = read(file).replace(/<!--[\s\S]*?-->/g, '')
    const links = [...page.matchAll(/<link rel="stylesheet" href="\/assets\/([^"]+)">/g)].map((m) => m[1])
    // every stylesheet a page has is one of those tags: none spelled another way, none inline
    assert.equal((page.match(/<link\b[^>]*stylesheet/gi) || []).length, links.length, `${file}: a stylesheet link not written as <link rel="stylesheet" href="/assets/...">`)
    assert.ok(!/<style\b/i.test(page), `${file}: a <style> block would sit outside the layers`)
    assert.deepEqual(links, ['css/tokens.css', 'css/tailwind.css'], file)
  }
})

test('the built Tailwind file declares the layer order before anything else', () => {
  const css = read('css', 'tailwind.css')
  assert.match(css, /^\/\*! tailwindcss v[\d.]+ \| MIT License/, 'the licence line Tailwind writes is kept')
  const pin = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'tailwind-pin.json'), 'utf8'))
  assert.ok(css.startsWith(`/*! tailwindcss v${pin.version} `), `built with the pinned Tailwind ${pin.version}`)
  const first = bare(css).replace(/@layer properties;/, '').trim()
  assert.ok(first.startsWith('@layer theme, base, components, utilities;'), 'the layer order comes first')
  assert.ok(!css.includes('\r'), 'LF line ends, so the file is the same bytes on every system')
})

test('no hand-written stylesheet: the tokens and the built Tailwind file are all there is', () => {
  // The old stylesheets were retired in phase 14 of the UX/UI plan. A new look is Tailwind classes
  // or a shared block (tailwind/components.css), and the page basics are tailwind/base.css.
  assert.deepEqual(sheets(), ['css/tailwind.css', 'css/tokens.css'],
    'a stylesheet in src/panel/css besides the tokens and the built Tailwind file: write it as classes, or in src/panel/tailwind/')
  // unlayered, so a token always wins over anything a layer might say about the same name
  assert.ok(!/@layer\b/.test(bare(read('css', 'tokens.css'))), 'css/tokens.css stays outside the layers')
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
