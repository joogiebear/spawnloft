#!/usr/bin/env node
// Builds the panel's Tailwind stylesheet: src/panel/tailwind/panel.css -> src/panel/css/tailwind.css.
//
// The built file is committed, and it is what the Rust panel compiles in. This tool runs on a
// developer's machine and in one CI job; it is never part of a package, and Tailwind is not a
// dependency of anything that ships. It uses Tailwind's standalone program, one file with no
// Node or npm behind it, at the version and sha256 pinned in tools/tailwind-pin.json. The
// program is fetched once into .cache/tailwind/ and its sha256 is checked before every run,
// so a file that is not the pinned release is never executed.
//
//   node tools/panel-css.mjs                    build src/panel/css/tailwind.css
//   node tools/panel-css.mjs --check            fail if the committed file is not what a build gives
//   node tools/panel-css.mjs build <in> <out>   build another input (the engine probe's)
//
// No network? Put the release file named in the pin at .cache/tailwind/<version>/<file>
// yourself: it is checked the same way.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const INPUT = path.join(root, 'src', 'panel', 'tailwind', 'panel.css')
const OUTPUT = path.join(root, 'src', 'panel', 'css', 'tailwind.css')
const pin = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'tailwind-pin.json'), 'utf8'))

const fail = (message) => { console.error(`panel-css: ${message}`); process.exit(1) }

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// The pinned program for this machine, fetched if it is not there yet, checked every time.
async function program() {
  const key = `${process.platform}-${process.arch}`
  const entry = pin.programs[key]
  if (!entry) fail(`no pinned Tailwind program for ${key} (tools/tailwind-pin.json has ${Object.keys(pin.programs).join(', ')})`)
  const dir = path.join(root, '.cache', 'tailwind', pin.version)
  const file = path.join(dir, entry.file)
  if (!fs.existsSync(file)) {
    const url = pin.release + entry.file
    console.error(`panel-css: fetching Tailwind ${pin.version} (${entry.file}, about 100 MB), once`)
    let res
    try { res = await fetch(url, { redirect: 'follow' }) } catch (e) {
      fail(`could not fetch ${url}: ${e.cause?.message || e.message}\n  Download it another way and put it at ${file}; it is checked before it runs.`)
    }
    if (!res.ok) fail(`${url} answered ${res.status}`)
    fs.mkdirSync(dir, { recursive: true })
    // written beside its final name and moved only once it is whole and checked, so a stopped
    // download is never taken for the program
    const part = `${file}.${process.pid}.part`
    fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()))
    const got = sha256(part)
    if (got !== entry.sha256) {
      fs.rmSync(part, { force: true })
      fail(`${url} is not the pinned file: sha256 ${got}, expected ${entry.sha256}. Nothing was run.`)
    }
    fs.chmodSync(part, 0o755)
    fs.renameSync(part, file)
  }
  const got = sha256(file)
  if (got !== entry.sha256) {
    fail(`${file} is not the pinned Tailwind ${pin.version}: sha256 ${got}, expected ${entry.sha256}. Nothing was run. Delete it and run this again.`)
  }
  return file
}

// One build. The output is plain (not minified) so a change to it reads in a diff, and has LF
// line ends on every system so the committed copy is the same bytes wherever it was built.
async function build(input, output) {
  const exe = await program()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-css-'))
  try {
    const out = path.join(tmp, 'out.css')
    const run = spawnSync(exe, ['--input', input, '--output', out], { cwd: path.dirname(input), encoding: 'utf8' })
    if (run.error) fail(`could not run ${exe}: ${run.error.message}`)
    if (run.status !== 0) fail(`Tailwind failed on ${path.relative(root, input)}:\n${run.stderr || run.stdout}`)
    const css = fs.readFileSync(out, 'utf8').replace(/\r\n/g, '\n')
    if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, css) }
    return css
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args[0] === 'build' && args.length === 3) {
  await build(path.resolve(args[1]), path.resolve(args[2]))
  console.log(`panel-css: built ${args[2]}`)
} else if (args.length === 1 && args[0] === '--check') {
  const fresh = await build(INPUT, null)
  const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : null
  if (fresh !== committed) {
    fail('src/panel/css/tailwind.css is not what src/panel/tailwind/panel.css and its @source files build to.\n  Run `node tools/panel-css.mjs` and commit the result.')
  }
  console.log(`panel-css: src/panel/css/tailwind.css is up to date (Tailwind ${pin.version})`)
} else if (args.length === 0) {
  await build(INPUT, OUTPUT)
  console.log(`panel-css: built src/panel/css/tailwind.css (Tailwind ${pin.version})`)
} else {
  fail('usage: node tools/panel-css.mjs [--check | build <input.css> <output.css>]')
}
