#!/usr/bin/env node
// Builds the panel's Tailwind stylesheet: src/panel/tailwind/panel.css -> src/panel/css/tailwind.css.
//
// The built file is committed, and it is what the Rust panel compiles in. This tool runs on a
// developer's machine and in one CI job; it is never part of a package, and Tailwind is not a
// dependency of anything that ships. It uses Tailwind's standalone program, one file with no
// Node or npm behind it, at the version and sha256 pinned in tools/tailwind-pin.json. The
// program is fetched once into .cache/tailwind/. Before every run its bytes are read, their
// sha256 is checked against the pin, and those same bytes are written to a private temporary
// folder and run from there, so what runs is what was checked.
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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// The pinned program for this machine, fetched if it is not there yet: its checked bytes.
async function program() {
  const key = `${process.platform}-${process.arch}`
  const entry = pin.programs[key]
  if (!entry) fail(`no pinned Tailwind program for ${key} (tools/tailwind-pin.json has ${Object.keys(pin.programs).join(', ')})`)
  // the pin's words become a folder, a file name and a URL: only the shapes those can have
  if (!/^\d+\.\d+\.\d+$/.test(pin.version) || !/^tailwindcss-[a-z0-9-]+(\.exe)?$/.test(entry.file) || !/^[0-9a-f]{64}$/.test(entry.sha256)
    || pin.release !== `https://github.com/tailwindlabs/tailwindcss/releases/download/v${pin.version}/`) {
    fail('tools/tailwind-pin.json is not a version, a Tailwind release URL for it, a file name and a sha256')
  }
  const dir = path.join(root, '.cache', 'tailwind', pin.version)
  const file = path.join(dir, entry.file)
  if (!fs.existsSync(file)) {
    const url = pin.release + entry.file
    console.error(`panel-css: fetching Tailwind ${pin.version} (${entry.file}, about 100 MB), once`)
    let res
    try { res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) }) } catch (e) {
      fail(`could not fetch ${url}: ${e.cause?.message || e.message}\n  Download it another way and put it at ${file}; it is checked before it runs.`)
    }
    if (!res.ok) fail(`${url} answered ${res.status}`)
    fs.mkdirSync(dir, { recursive: true })
    // written beside its final name and moved only once it is whole and checked, so a stopped
    // download is never taken for the program
    const part = `${file}.${process.pid}.part`
    let body
    try { body = Buffer.from(await res.arrayBuffer()) } catch (e) { fail(`the download of ${url} stopped: ${e.cause?.message || e.message}`) }
    const got = sha256(body)
    if (got !== entry.sha256) fail(`${url} is not the pinned file: sha256 ${got}, expected ${entry.sha256}. Nothing was kept or run.`)
    fs.writeFileSync(part, body)
    fs.renameSync(part, file)
  }
  const bytes = fs.readFileSync(file)
  const got = sha256(bytes)
  if (got !== entry.sha256) {
    fail(`${file} is not the pinned Tailwind ${pin.version}: sha256 ${got}, expected ${entry.sha256}. Nothing was run. Delete it and run this again.`)
  }
  return { bytes, name: entry.file }
}

// One build. The output is plain (not minified) so a change to it reads in a diff, and has LF
// line ends on every system so the committed copy is the same bytes wherever it was built.
async function build(input, output) {
  const { bytes, name } = await program()
  // mkdtemp makes the folder for this user alone (0700)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-css-'))
  try {
    // the checked bytes themselves are what runs, not whatever is at the cache path by then
    const exe = path.join(tmp, name)
    fs.writeFileSync(exe, bytes, { mode: 0o700 })
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
