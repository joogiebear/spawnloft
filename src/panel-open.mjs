import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { FUTURE_LEEWAY_MS, LOGIN_TTL_MS } from './panel-auth.mjs'
import { protectPrivateFile } from './private-files.mjs'
import { configDir } from './settings.mjs'

// How `spawnloft ui` hands a browser its one-use sign-in link (rust/PANEL-AUTH-DESIGN.md 3.7).
//
// The link is never put on a command line: on Linux and macOS every account can read other
// processes' arguments, and a link read there works for whoever uses it first. It goes in a small
// page in <config>/open/ instead (a private folder, never the data root, which may be shared),
// and the browser is pointed at that file, as Jupyter does for the same reason. The page sends the
// browser on to the link.
//
// Each file is named after its link's nonce, hashed, so the panel that takes the link can delete
// the file it came from. Anything older than a link lives is deleted by the next writer and by
// every panel start, so a file that was never opened does not outlive its (by then dead) link.

const MAX_AGE_MS = LOGIN_TTL_MS + FUTURE_LEEWAY_MS
const NAME = /^[0-9a-f]{32}\.html$/

export function openDir() {
  return path.join(configDir(), 'open')
}

export function openFileName(nonce) {
  return `${crypto.createHash('sha256').update(`open.v1.${nonce}`).digest('hex').slice(0, 32)}.html`
}

// the folder, made private, and checked to be this user's own folder before anything goes in it
function ensureDir() {
  const dir = openDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // asked of the runtime, not of process.platform (Windows: APPDATA is the user's own already)
  if (typeof process.getuid === 'function') {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory()) throw new Error(`${dir} is not a folder; delete it and try again`)
    if (stat.uid !== process.getuid()) throw new Error(`${dir} belongs to another account; delete it and try again`)
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
  }
  return dir
}

// Deletes the pages whose links are dead. Only names this module makes are touched.
export function sweepOpenFiles(now = Date.now()) {
  let names
  try {
    names = fs.readdirSync(openDir())
  } catch {
    return
  }
  for (const name of names) {
    if (!NAME.test(name)) continue
    const file = path.join(openDir(), name)
    try {
      if (now - fs.lstatSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true })
    } catch {
      // gone already, or not ours to delete: either way nothing to do
    }
  }
}

// The panel took the link with this nonce: the page that carried it has done its job.
export function removeOpenFile(nonce) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return
  try {
    fs.rmSync(path.join(openDir(), openFileName(nonce)), { force: true })
  } catch {
    // nothing to remove
  }
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// No script: a refresh and a link, so it works with scripts off and says what it is if it stays.
export function openPage(url) {
  const href = escape(url)
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="referrer" content="no-referrer">'
    + `<meta http-equiv="refresh" content="0; url=${href}">`
    + '<title>Opening SpawnLoft</title></head>'
    + '<body style="font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;padding:24px">'
    + `<p>Opening SpawnLoft. If nothing happens, <a href="${href}" style="color:#9cf">continue to SpawnLoft</a>.</p>`
    + '<p style="color:#bbb">This link signs one browser in, once, within five minutes.</p>'
    + '</body></html>\n'
}

// Writes the page for `url` (a login link whose nonce is `nonce`) and returns its path. The file
// is created exclusively and private before the link goes in.
export function writeOpenFile(url, nonce) {
  const dir = ensureDir()
  sweepOpenFiles()
  const file = path.join(dir, openFileName(nonce))
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    const made = protectPrivateFile(file)
    if (!made.ok) throw new Error(`could not make ${file} private: ${made.reason}`)
    fs.writeSync(fd, openPage(url))
    fs.fsyncSync(fd)
  } catch (err) {
    fs.closeSync(fd)
    fs.rmSync(file, { force: true })
    throw err
  }
  fs.closeSync(fd)
  return file
}

// The program that opens a file in the browser. BROWSER, when set, names one to run with the file
// as its only argument (the convention Python's webbrowser and Jupyter follow); otherwise the
// system's own opener. Only the file's path is passed, never the link.
export function opener(file, env = process.env, platform = process.platform) {
  const chosen = String(env.BROWSER ?? '').trim()
  if (chosen) return [chosen, [file]]
  // explorer, not `cmd /c start`: a path goes to it as one argument, with no shell to parse it
  if (platform === 'win32') return [path.win32.join(env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [file]]
  if (platform === 'darwin') return ['open', [file]]
  return ['xdg-open', [file]]
}

// Opens the page in the browser. Never throws: with no browser the link is printed anyway.
export function openInBrowser(file) {
  const [cmd, args] = opener(file)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => {})
    child.unref()
  } catch {
    // no opener on this machine
  }
}
