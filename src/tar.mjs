import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { UserError } from './util.mjs'

/**
 * Which tar to run.
 *
 * <p>Windows ships bsdtar at System32\tar.exe, and this code has always assumed that is the one it
 * gets. It is not: `tar` resolves through PATH, and any machine with Git for Windows, MSYS or a
 * similar toolchain installed finds GNU tar first. GNU tar reads `C:\backups\x.tar.gz` as
 * host `C:` plus a path and tries to open a network connection to it, so every snapshot on such a
 * machine failed with "Cannot connect to C: resolve failed" - which meant rebuild and delete-with-
 * files were unusable, because both take a snapshot first and both correctly refuse to continue
 * without one.
 *
 * <p>Naming the binary rather than trusting PATH is the fix. bsdtar has no --force-local and does
 * not need one.
 */
export function tarBinary() {
  if (process.platform !== 'win32') return 'tar'
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return fs.existsSync(system32) ? system32 : 'tar'
}

/**
 * Can this tar read and write zip?
 *
 * <p>bsdtar can, and is what Windows and macOS have. GNU tar cannot, and is what nearly every Linux
 * has - and it does not refuse: `-a -cf world.zip` exits 0 having written a tar archive under that
 * name. So the tar is asked what it is, once, rather than the platform being assumed from; an Arch
 * or FreeBSD machine whose tar is bsdtar keeps using it. zip.mjs is what the others use.
 */
let zipCapable = null
export function tarHandlesZip() {
  if (zipCapable === null) {
    const res = spawnSync(tarBinary(), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    zipCapable = /bsdtar|libarchive/i.test(String(res.stdout ?? ''))
  }
  return zipCapable
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
    child.on('exit', (code) => {
      // bsdtar exits 1 on warnings such as "file changed as we read it",
      // which is expected when snapshotting a running server.
      if (code === 0 || code === 1) resolve({ code, stderr })
      else reject(new UserError(`tar exited ${code}: ${stderr.trim() || 'unknown error'}`))
    })
  })
}
