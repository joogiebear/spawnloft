import fs from 'node:fs'
import path from 'node:path'

import { ROOT, RUN_DIR } from './paths.mjs'
import { listInstances } from './registry.mjs'
import { writeLaunchers } from './create.mjs'
import { rewriteShims } from './schedule.mjs'

// Scheduled-task shims and the per-server launchers embed the installation's absolute path and
// are only read by Windows or a double-click, so nothing notices when that path goes stale. The
// panel records the executable and code folder it ran from; if either differs (or there is no
// record) every shim and launcher is rewritten. Idempotent, and covers a hand-moved program folder.
//
// `format` is the version of the text those files hold. Bump it in any release that changes what a
// shim or launcher runs (another entry file, another executable, new environment), so an update in
// place - same exe, same folder - still rewrites them. A record without it is an older release's.
export const RUNTIME_FORMAT = 1

export function runtimeSignature() {
  return { format: RUNTIME_FORMAT, exe: process.execPath, root: ROOT }
}

export function markerFile() {
  return path.join(RUN_DIR, 'runtime.json')
}

// force: rewrite even when the record matches (`spawnloft repair`). The record's other fields are
// left for whoever wrote them: a newer release may keep more there, and only these three are compared.
export function repairAfterMove({ marker = markerFile(), signature = runtimeSignature(), force = false } = {}) {
  let recorded = null
  try {
    recorded = JSON.parse(fs.readFileSync(marker, 'utf8'))
  } catch {
    // no or unreadable record counts as moved
  }
  const same = recorded && recorded.format === signature.format && recorded.exe === signature.exe && recorded.root === signature.root
  if (same && !force) {
    return { moved: false, shims: 0, launchers: 0 }
  }

  const shims = rewriteShims()
  let launchers = 0
  for (const inst of listInstances()) {
    // a server whose folder is gone gets no launchers
    try {
      writeLaunchers(inst)
      launchers++
    } catch {}
  }

  fs.mkdirSync(path.dirname(marker), { recursive: true })
  const keep = recorded && typeof recorded === 'object' && !Array.isArray(recorded) ? recorded : {}
  fs.writeFileSync(marker, JSON.stringify({ ...keep, ...signature }, null, 2) + '\n')
  return { moved: true, shims, launchers }
}
