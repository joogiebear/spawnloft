// A side's data tree as the rig compares it: every file and folder under the scratch folder
// (the data root and the scratch home both), with its kind, its mode on POSIX, and its content
// as text (evened out), as a zip listing, as a tar member listing with each member's hash, or as
// a size and sha256.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
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

// A tar's members as name, type, mode, size and sha256, from our own reader (gunzip first for
// .gz): the names alone would call two backups with different bytes the same. Mtimes, owners
// and the gzip header are left out, since they change from one run to the next.
export function tarListing(buf) {
  let data = buf
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { data = zlib.gunzipSync(buf) } catch { return null }
  }
  const out = []
  let longName = null
  let paxPath = null
  const field = (h, at, len) => h.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '')
  const octal = (h, at, len) => parseInt(field(h, at, len).trim() || '0', 8)
  for (let p = 0; p + 512 <= data.length;) {
    const h = data.subarray(p, p + 512)
    if (h.every(b => b === 0)) break
    const size = octal(h, 124, 12)
    const type = String.fromCharCode(h[156] || 48)
    const body = data.subarray(p + 512, p + 512 + size)
    p += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      if (m) paxPath = m[1]
      continue
    }
    if (type === 'g') continue
    const prefix = field(h, 345, 155)
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100))
    longName = null
    paxPath = null
    const mode = (octal(h, 100, 8) & 0o777).toString(8).padStart(3, '0')
    const hash = type === '0' || type === '\0' ? ` sha256=${crypto.createHash('sha256').update(body).digest('hex')}` : ''
    const link = type === '1' || type === '2' ? ` link=${field(h, 157, 100)}` : ''
    out.push(`${name} type=${type} mode=${mode} size=${size}${hash}${link}`)
  }
  return out.join('\n')
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
    const listing = tarListing(buf)
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
      // two names that even out alike (two backups a second apart) stay two entries, so a side
      // that leaves an extra one is caught
      let key = normalizePath(rel)
      for (let n = 2; out.has(key); n++) key = `${normalizePath(rel)}#${n}`
      if (st.isSymbolicLink()) out.set(key, { kind: 'link', target: fs.readlinkSync(abs), ...mode })
      else if (st.isDirectory()) { out.set(key, { kind: 'dir', ...mode }); walk(abs) }
      else out.set(key, { kind: 'file', ...mode, ...describeFile(abs, rel, normalize) })
    }
  }
  walk(root)
  return out
}
