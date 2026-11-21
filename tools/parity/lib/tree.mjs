// A side's data tree as the rig compares it: every file and folder under the scratch folder
// (the data root and the scratch home both), with its kind, its mode on POSIX, and its content
// as text (evened out), as a zip listing, as a tar listing (from the system tar, which both
// cores call, rust/PLAN-CORE-PORT.md rule 9), or as a size and sha256.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const TEXT_LIMIT = 1024 * 1024

// glob with * (within a segment) and ** (any depth), on / separated paths
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

function isText(buf) {
  if (buf.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

// The central directory of a zip: name, method, flags, sizes and crc of every entry in order.
// Our own reader so the rig depends on nothing; enough for what the cores write (no zip64).
export function zipListing(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16).toString(16).padStart(8, '0')
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const extAttr = buf.readUInt32LE(p + 38)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1')
    out.push(`${name} method=${method} flags=0x${flags.toString(16)} size=${usize} csize=${csize} crc=${crc} attr=0x${extAttr.toString(16)}`)
    p += 46 + nlen + xlen + clen
  }
  return out.join('\n')
}

function tarListing(file) {
  const r = spawnSync('tar', ['-tf', file], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.replace(/\r\n/g, '\n') : null
}

function icacls(abs) {
  const r = spawnSync('icacls', [abs], { encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? r.stdout.replace(/\r\n/g, '\n').trim() : `icacls failed: ${r.stderr || r.status}`
}

function describeFile(abs, rel, normalize) {
  const buf = fs.readFileSync(abs)
  const lower = rel.toLowerCase()
  if (/\.(zip|jar|mrpack)$/.test(lower) || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50)) {
    const listing = zipListing(buf)
    if (listing !== null) return { zip: listing }
  }
  if (/\.(tar|tar\.gz|tgz)$/.test(lower)) {
    const listing = tarListing(abs)
    if (listing !== null) return { tar: listing }
  }
  if (buf.length <= TEXT_LIMIT && isText(buf)) return { text: normalize(buf.toString('utf8'), rel) }
  return { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') }
}

// Map of "relative/path" -> { kind, mode?, ...content }, sorted by path.
// `acl`: on Windows, each entry's access list as icacls prints it (owner-only files, C1's
// private-files port); POSIX modes are always recorded.
// `normalizePath` evens out a stamped file name the way `normalize` does text, so a backup made a
// second later on the other side is the same entry.
export function snapshot(root, { ignore = [], normalize = (t) => t, normalizePath = (p) => p, acl = false } = {}) {
  const skip = ignore.map(globToRegExp)
  const out = new Map()
  const walk = (dir) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names.sort()) {
      const abs = path.join(dir, name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      if (skip.some(re => re.test(rel))) continue
      const st = fs.lstatSync(abs)
      const mode = process.platform === 'win32'
        ? (acl ? { acl: icacls(abs) } : {})
        : { mode: (st.mode & 0o777).toString(8).padStart(3, '0') }
      const key = normalizePath(rel)
      if (st.isSymbolicLink()) out.set(key, { kind: 'link', target: fs.readlinkSync(abs), ...mode })
      else if (st.isDirectory()) { out.set(key, { kind: 'dir', ...mode }); walk(abs) }
      else out.set(key, { kind: 'file', ...mode, ...describeFile(abs, rel, normalize) })
    }
  }
  walk(root)
  return out
}
