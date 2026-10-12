import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UserError } from './util.mjs'

// Use System32\tar.exe on Windows rather than whatever `tar` is first on PATH. Git for Windows/MSYS
// put GNU tar first, which reads `C:\backups\x.tar.gz` as host `C:` and fails every snapshot.
export function tarBinary() {
  if (process.platform !== 'win32') return 'tar'
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return fs.existsSync(system32) ? system32 : 'tar'
}

// Ask the tar what it is instead of assuming from the platform. GNU tar can't do zip, and
// `-a -cf world.zip` exits 0 having written a plain tar under that name.
let zipCapable = null
export function tarHandlesZip() {
  if (zipCapable === null) {
    const res = spawnSync(tarBinary(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    zipCapable = /bsdtar|libarchive/i.test(String(res.stdout ?? ''))
  }
  return zipCapable
}

// A leading `-` is read as an option (GNU tar: `--checkpoint-action=exec=...` runs a command) and
// a leading `@` makes bsdtar copy entries from that archive. `./` makes either a plain path.
export function tarMember(name) {
  return /^[-@]/.test(name) ? `./${name}` : name
}

export function runTar(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarBinary(), args, { cwd, windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (err) =>
      reject(
        new UserError(
          err.code === 'ENOENT'
            ? process.platform === 'win32'
              ? 'tar was not found on PATH (Windows 10/11 ships tar.exe in System32)'
              : 'tar was not found on PATH - install it with your package manager'
            : `tar failed: ${err.message}`,
        ),
      ),
    )
    child.on('close', (code) => {
      // bsdtar exits 1 on warnings such as "file changed as we read it",
      // which is expected when snapshotting a running server.
      if (code === 0 || code === 1) resolve({ code, stderr })
      else reject(new UserError(`tar exited ${code}: ${stderr.trim() || 'unknown error'}`))
    })
  })
}
