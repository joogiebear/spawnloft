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
export function runtimeSignature() {
  return { exe: process.execPath, root: ROOT }
}

export function markerFile() {
  return path.join(RUN_DIR, 'runtime.json')
}

export function repairAfterMove({ marker = markerFile(), signature = runtimeSignature() } = {}) {
  let recorded = null
  try {
    recorded = JSON.parse(fs.readFileSync(marker, 'utf8'))
  } catch {
    // no or unreadable record counts as moved
  }
  if (recorded && recorded.exe === signature.exe && recorded.root === signature.root) {
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
  fs.writeFileSync(marker, JSON.stringify(signature, null, 2) + '\n')
  return { moved: true, shims, launchers }
}
