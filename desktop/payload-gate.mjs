// What the release gate checks inside a package's payload, before or after it is bundled
// (PLAN-2.0-REMAINING.md A3 and section 5 W1; rust/PLAN-CORE-PORT.md 5.1):
//
//   checkNoNode(paths)       no Node.js in any shipped file: no `node` or `node.exe` binary and
//                            no `.mjs` file of the Node core. Since C10 every command runs in
//                            spawnloft-core, so a package that still carries either is a build
//                            from the wrong tree. The one `node` allowed is the command-line
//                            package's compatibility link bin/node, which points at
//                            spawnloft-core (5.2)
//   checkNoInternalStrings(files)   no wording that marks a test build (the "internal spike"
//                            page, "Internal build: not for release.") in any shipped file,
//                            binaries included (searched as bytes)
//
// Both return a list of problems (empty when fine). release-gate.mjs runs them on every
// --payload and --installed path.
import fs from 'node:fs'
import path from 'node:path'

const NODE_NAMES = new Set(['node', 'node.exe'])
const CORE_NAMES = new Set(['spawnloft-core', 'spawnloft-core.exe'])

// every entry under p, p itself included; a symlink is reported as itself, never followed
function* entriesUnder(p) {
  const st = fs.lstatSync(p)
  yield [p, st]
  if (!st.isDirectory()) return
  for (const entry of fs.readdirSync(p)) yield* entriesUnder(path.join(p, entry))
}

export function checkNoNode(paths) {
  const problems = []
  for (const root of paths) {
    if (!fs.existsSync(root)) {
      problems.push(`${root} is missing`)
      continue
    }
    for (const [file, st] of entriesUnder(root)) {
      const name = path.basename(file).toLowerCase()
      if (st.isDirectory()) continue
      if (NODE_NAMES.has(name)) {
        if (st.isSymbolicLink() && CORE_NAMES.has(path.basename(fs.readlinkSync(file)).toLowerCase())) continue
        problems.push(`${file} is a Node.js binary, which no 2.x package may ship`)
      } else if (name.endsWith('.mjs')) {
        problems.push(`${file} is a Node core .mjs file, which no 2.x package may ship`)
      }
    }
  }
  return problems
}

// User-visible wording of test builds. Matched case-insensitively against each file's bytes (as
// latin1, so a binary's embedded UTF-8 strings match too).
export const INTERNAL_WORDING = [/internal spike/i, /internal build: not for release/i, /\(internal spike\)/i]

function* filesUnder(p) {
  const st = fs.statSync(p)
  if (!st.isDirectory()) {
    yield p
    return
  }
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) yield* filesUnder(path.join(p, entry.name))
}

export function checkNoInternalStrings(paths) {
  const problems = []
  for (const root of paths) {
    if (!fs.existsSync(root)) {
      problems.push(`${root} is missing`)
      continue
    }
    for (const file of filesUnder(root)) {
      const text = fs.readFileSync(file).toString('latin1')
      for (const re of INTERNAL_WORDING) {
        const m = re.exec(text)
        if (m) problems.push(`${file} contains test-build wording "${m[0]}"`)
      }
    }
  }
  return problems
}
