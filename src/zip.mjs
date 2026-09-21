import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform, Writable } from 'node:stream'
import { fail } from './util.mjs'

/**
 * Zip, written and read here, for the machines whose tar cannot.
 *
 * <p>Worlds travel as zips: it is the format maps are shared in and the one Windows opens
 * bare-handed. On Windows and macOS `tar` is bsdtar, which reads and writes zip, and that is what
 * those platforms go on using. GNU tar does neither - and says so badly: asked for `-a -cf x.zip`
 * it exits 0 having written a tar archive under a .zip name, which is an export nobody the map is
 * sent to can open. See tar.mjs for how the two are told apart.
 *
 * <p>Both directions stream. A world is gigabytes of region files, so nothing here holds more than
 * a chunk of one file in memory, and zip64 is written whenever - and only when - a size or an
 * offset outgrows 32 bits, so that a small export stays readable by the oldest unzip there is.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD64_SIG = 0x06064b50
const LOCATOR64_SIG = 0x07064b50
const MAX32 = 0xffffffff
const MAX16 = 0xffff
const UTF8_NAMES = 0x0800
// Deflate can grow incompressible data by a few bytes per block, so a file this close to four
// gigabytes gets its 64-bit fields reserved before it is known whether it needed them.
const NEAR_4G = 0xffff0000

const CRC_TABLE = zlib.crc32 ? null : Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
/** zlib.crc32 arrived in Node 20.15 and 22.2; the table covers the Node 20 releases before it. */
function crc32(chunk, crc) {
  if (zlib.crc32) return zlib.crc32(chunk, crc)
  let c = ~crc
  for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}

// The upper half of code page 437, which is what a zip name is in unless it says otherwise.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * An entry's name, in whichever encoding it was written.
 *
 * <p>A flag says UTF-8. Without it the format means code page 437, and bsdtar on Windows takes it
 * at its word - "ü" arrives as 0x81 - but macOS writes UTF-8 and leaves the flag off. So unflagged
 * bytes that are valid UTF-8 are read as UTF-8, which 437 text with accents in it never is, and
 * only the rest as 437. Read wrongly, an imported world lands in a folder named in mojibake.
 */
export function decodeName(bytes, flags) {
  if (!(flags & UTF8_NAMES)) {
    try { return strictUtf8.decode(bytes) } catch { /* not UTF-8, so it is what the format says */ }
    let name = ''
    for (const byte of bytes) name += byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80]
    return name
  }
  return bytes.toString('utf8')
}

function dosTime(date) {
  // The format has no year before 1980 and no timezone; local time is what every unzip assumes.
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Everything under the members, directories before their contents, in a stable order. */
function* walk(cwd, members, excluded) {
  for (const member of members) {
    const stack = [member]
    while (stack.length) {
      const rel = stack.pop()
      if (excluded.has(path.basename(rel))) continue
      const stat = fs.lstatSync(path.join(cwd, rel))
      if (stat.isDirectory()) {
        yield { rel, stat, dir: true }
        const names = fs.readdirSync(path.join(cwd, rel)).sort().reverse()
        for (const name of names) stack.push(path.join(rel, name))
      } else if (stat.isFile()) {
        yield { rel, stat, dir: false }
      }
      // Links, sockets and devices are left out: a world has none, and a link is a way out of it.
    }
  }
}

/**
 * Write `members` (paths relative to `cwd`) into a new zip at `file`.
 *
 * <p>The file is written once, front to back, and each local header is filled in after its data:
 * sizes and the checksum are only known then, and going back for them keeps the archive free of
 * trailing data descriptors, which are the part of the format readers disagree about most.
 *
 * @param exclude basenames to leave out, wherever they sit
 * @param forceZip64 write every 64-bit structure regardless of size - for tests, which cannot
 *        reasonably carry a four gigabyte fixture
 */
export async function createZip(file, cwd, members, { exclude = [], forceZip64 = false } = {}) {
  const excluded = new Set(exclude)
  const fd = fs.openSync(file, 'w')
  const entries = []
  let at = 0
  const put = (buffer, position = null) => {
    let done = 0
    while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done, position === null ? null : position + done)
    if (position === null) at += buffer.length
  }

  try {
    for (const { rel, stat, dir } of walk(cwd, members, excluded)) {
      const name = Buffer.from(rel.split(path.sep).join('/') + (dir ? '/' : ''), 'utf8')
      if (name.length > MAX16) fail(`"${rel}" has a path too long to put in a zip`)
      const wide = forceZip64 || (!dir && stat.size >= NEAR_4G)
      const { time, date } = dosTime(stat.mtime)
      const entry = { name, dir, wide, time, date, mode: stat.mode, offset: at, crc: 0, size: 0, packed: 0,
        method: dir || stat.size === 0 ? 0 : 8 }

      const header = Buffer.alloc(30 + name.length + (wide ? 20 : 0))
      header.writeUInt32LE(LOCAL_SIG, 0)
      header.writeUInt16LE(wide ? 45 : 20, 4)
      header.writeUInt16LE(UTF8_NAMES, 6)
      header.writeUInt16LE(entry.method, 8)
      header.writeUInt16LE(time, 10)
      header.writeUInt16LE(date, 12)
      header.writeUInt16LE(name.length, 26)
      header.writeUInt16LE(wide ? 20 : 0, 28)
      name.copy(header, 30)
      if (wide) {
        header.writeUInt16LE(0x0001, 30 + name.length)
        header.writeUInt16LE(16, 32 + name.length)
      }
      put(header)

      if (!dir && stat.size > 0) {
        const count = new Transform({ transform(chunk, _, done) {
          entry.crc = crc32(chunk, entry.crc); entry.size += chunk.length; done(null, chunk) } })
        const sink = new Writable({ write(chunk, _, done) {
          try { put(chunk); entry.packed += chunk.length; done() } catch (error) { done(error) } } })
        await pipeline(fs.createReadStream(path.join(cwd, rel)), count, zlib.createDeflateRaw(), sink)
        if (!wide && (entry.size > MAX32 || entry.packed > MAX32)) {
          fail(`"${rel}" grew past four gigabytes while it was being read; stop whatever is writing it and try again`)
        }
      }
      // A file that emptied out between the stat and the read was still declared deflated, and
      // deflate of nothing is two bytes rather than none - so the sizes are whatever was written.
      header.writeUInt32LE(entry.crc, 14)
      header.writeUInt32LE(wide ? MAX32 : entry.packed, 18)
      header.writeUInt32LE(wide ? MAX32 : entry.size, 22)
      if (wide) {
        header.writeBigUInt64LE(BigInt(entry.size), 34 + name.length)
        header.writeBigUInt64LE(BigInt(entry.packed), 42 + name.length)
      }
      put(header, entry.offset)
      entries.push(entry)
    }

    const directoryAt = at
    for (const entry of entries) {
      const farOffset = forceZip64 || entry.offset >= MAX32
      const extra = []
      if (entry.wide) extra.push(entry.size, entry.packed)
      if (farOffset) extra.push(entry.offset)
      const record = Buffer.alloc(46 + entry.name.length + (extra.length ? 4 + extra.length * 8 : 0))
      record.writeUInt32LE(CENTRAL_SIG, 0)
      // Made by: Unix (3), so the mode in the external attributes means what it says.
      record.writeUInt16LE((3 << 8) | 45, 4)
      record.writeUInt16LE(extra.length ? 45 : 20, 6)
      record.writeUInt16LE(UTF8_NAMES, 8)
      record.writeUInt16LE(entry.method, 10)
      record.writeUInt16LE(entry.time, 12)
      record.writeUInt16LE(entry.date, 14)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.wide ? MAX32 : entry.packed, 20)
      record.writeUInt32LE(entry.wide ? MAX32 : entry.size, 24)
      record.writeUInt16LE(entry.name.length, 28)
      record.writeUInt16LE(extra.length ? 4 + extra.length * 8 : 0, 30)
      record.writeUInt32LE((((entry.mode & 0xffff) << 16) | (entry.dir ? 0x10 : 0)) >>> 0, 38)
      record.writeUInt32LE(farOffset ? MAX32 : entry.offset, 42)
      entry.name.copy(record, 46)
      if (extra.length) {
        let p = 46 + entry.name.length
        record.writeUInt16LE(0x0001, p)
        record.writeUInt16LE(extra.length * 8, p + 2)
        for (const value of extra) { record.writeBigUInt64LE(BigInt(value), p + 4); p += 8 }
      }
      put(record)
    }
    const directorySize = at - directoryAt

    const wideEnd = forceZip64 || entries.length >= MAX16 || directorySize >= MAX32 || directoryAt >= MAX32
    if (wideEnd) {
      const end64 = Buffer.alloc(56 + 20)
      end64.writeUInt32LE(EOCD64_SIG, 0)
      end64.writeBigUInt64LE(44n, 4)
      end64.writeUInt16LE((3 << 8) | 45, 12)
      end64.writeUInt16LE(45, 14)
      end64.writeBigUInt64LE(BigInt(entries.length), 24)
      end64.writeBigUInt64LE(BigInt(entries.length), 32)
      end64.writeBigUInt64LE(BigInt(directorySize), 40)
      end64.writeBigUInt64LE(BigInt(directoryAt), 48)
      end64.writeUInt32LE(LOCATOR64_SIG, 56)
      end64.writeBigUInt64LE(BigInt(at), 64)
      end64.writeUInt32LE(1, 72)
      put(end64)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(EOCD_SIG, 0)
    end.writeUInt16LE(wideEnd ? MAX16 : entries.length, 8)
    end.writeUInt16LE(wideEnd ? MAX16 : entries.length, 10)
    end.writeUInt32LE(wideEnd ? MAX32 : directorySize, 12)
    end.writeUInt32LE(wideEnd ? MAX32 : directoryAt, 16)
    put(end)
    fs.fsyncSync(fd)
    return { entries: entries.length, bytes: at }
  } finally {
    fs.closeSync(fd)
  }
}

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const got = fs.readSync(fd, buffer, done, length - done, position + done)
    if (got === 0) fail('the zip ends before its own index says it should; the file is cut short or damaged')
    done += got
  }
  return buffer
}

/** Where the central directory is and how many entries it holds, from whichever end record says. */
function findDirectory(fd, size) {
  if (size < 22) fail('that file is too small to be a zip')
  // The end record sits at the very end, behind a comment of at most 64 KiB.
  const tailSize = Math.min(size, 22 + MAX16)
  const tail = readAt(fd, tailSize, size - tailSize)
  // The four signature bytes can turn up INSIDE a zip's comment, and scanning backwards meets those
  // first. Taken at their word they usually describe an archive with nothing in it - a world zip
  // that imports as "contains no world". Two things tell the real record from a lookalike. Its
  // comment runs exactly to the end of the file. And it sits directly after the directory it
  // describes (or after the zip64 locator that does): a decoy can be given a comment length that
  // fits, even a whole well-formed empty record can, but not a directory that ends where it begins.
  // A record that passes only the first test is kept as a fallback, for the rare archive with
  // something prepended to it, whose offsets are all out by that much.
  let fallback = null
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue
    if (i + 22 + tail.readUInt16LE(i + 20) !== tailSize) continue
    const at = size - tailSize + i
    const found = { entries: tail.readUInt16LE(i + 10), size: tail.readUInt32LE(i + 12), offset: tail.readUInt32LE(i + 16) }
    const wide = found.entries === MAX16 || found.size === MAX32 || found.offset === MAX32
    if (wide) {
      if (at < 20 || readAt(fd, 20, at - 20).readUInt32LE(0) !== LOCATOR64_SIG) continue
      const end64 = readAt(fd, 56, Number(readAt(fd, 20, at - 20).readBigUInt64LE(8)))
      if (end64.readUInt32LE(0) !== EOCD64_SIG) fail('the zip64 index of that archive is damaged')
      return { entries: Number(end64.readBigUInt64LE(32)), size: Number(end64.readBigUInt64LE(40)), offset: Number(end64.readBigUInt64LE(48)) }
    }
    if (found.offset + found.size === at) return found
    fallback ??= found
  }
  if (fallback) return fallback
  fail('that file is not a zip archive')
}

/** Every entry of an open zip, with 64-bit sizes and offsets resolved. */
export function* zipEntries(fd, size) {
  const directory = findDirectory(fd, size)
  if (directory.offset + directory.size > size) fail('the zip index points past the end of the file; the archive is cut short')
  const cd = readAt(fd, directory.size, directory.offset)
  let at = 0
  for (let n = 0; n < directory.entries; n++) {
    if (at + 46 > cd.length || cd.readUInt32LE(at) !== CENTRAL_SIG) fail('the zip index is damaged')
    const nameLength = cd.readUInt16LE(at + 28)
    const extraLength = cd.readUInt16LE(at + 30)
    const entry = {
      madeBy: cd.readUInt16LE(at + 4) >> 8,
      flags: cd.readUInt16LE(at + 8),
      method: cd.readUInt16LE(at + 10),
      crc: cd.readUInt32LE(at + 16),
      packed: cd.readUInt32LE(at + 20),
      size: cd.readUInt32LE(at + 24),
      attributes: cd.readUInt32LE(at + 38),
      offset: cd.readUInt32LE(at + 42),
    }
    entry.name = decodeName(cd.subarray(at + 46, at + 46 + nameLength), entry.flags)
    // The zip64 field holds only the values that overflowed, in this fixed order.
    let p = at + 46 + nameLength
    const extraEnd = p + extraLength
    while (p + 4 <= extraEnd) {
      const id = cd.readUInt16LE(p)
      const length = cd.readUInt16LE(p + 2)
      if (id === 0x0001) {
        let q = p + 4
        for (const key of ['size', 'packed', 'offset']) {
          if (entry[key] === MAX32 && q + 8 <= p + 4 + length) { entry[key] = Number(cd.readBigUInt64LE(q)); q += 8 }
        }
      }
      p += 4 + length
    }
    yield entry
    at = extraEnd + cd.readUInt16LE(at + 32)
  }
}

/** Is this a zip? Asked of the bytes, because a file's extension is only what someone called it. */
export function isZip(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(4)
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false
    // A zip with entries starts with a local header; an empty one is only its end record.
    return head.readUInt32LE(0) === LOCAL_SIG || head.readUInt32LE(0) === EOCD_SIG
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Extract a whole zip into `dest`.
 *
 * <p>Every name is confined to `dest` before a byte is written. Names arrive from the archive, and
 * "../" or a drive letter in one would otherwise turn "import a map" into "write anywhere" - the
 * guard bsdtar brings with it has to be brought along by hand here. Links are not recreated, for
 * the same reason. Each file's checksum is verified as it is written, so a damaged download fails
 * on the file that is damaged rather than later, in the game, as a corrupt chunk.
 */
export async function extractZip(file, dest) {
  const root = path.resolve(dest)
  const fd = fs.openSync(file, 'r')
  let files = 0
  try {
    const size = fs.fstatSync(fd).size
    for (const entry of zipEntries(fd, size)) {
      // Windows tools have been known to write backslashes, which the format forbids.
      const name = entry.name.replaceAll('\\', '/')
      if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) {
        fail(`the archive tried to write outside its folder ("${entry.name}"); nothing more was extracted`)
      }
      const target = path.resolve(root, name)
      if (target !== root && !target.startsWith(root + path.sep)) {
        fail(`the archive tried to write outside its folder ("${entry.name}"); nothing more was extracted`)
      }
      if (entry.flags & 1) fail(`"${entry.name}" is encrypted; password-protected zips cannot be imported`)
      if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue }
      if (entry.madeBy === 3 && ((entry.attributes >>> 16) & 0o170000) === 0o120000) continue
      if (entry.method !== 0 && entry.method !== 8) fail(`"${entry.name}" uses a compression this cannot read (method ${entry.method})`)

      const local = readAt(fd, 30, entry.offset)
      if (local.readUInt32LE(0) !== LOCAL_SIG) fail(`"${entry.name}" is not where the zip index says it is; the archive is damaged`)
      // The local header repeats the name and extra field, and its extra field may differ in
      // length from the central one - so it is read, not assumed.
      const dataAt = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      if (dataAt + entry.packed > size) fail(`"${entry.name}" runs past the end of the file; the archive is cut short`)

      fs.mkdirSync(path.dirname(target), { recursive: true })
      let crc = 0
      let written = 0
      const check = new Transform({ transform(chunk, _, done) { crc = crc32(chunk, crc); written += chunk.length; done(null, chunk) } })
      if (entry.packed === 0) fs.writeFileSync(target, '')
      else {
        const source = fs.createReadStream(null, { fd, autoClose: false, start: dataAt, end: dataAt + entry.packed - 1 })
        const stages = entry.method === 8 ? [source, zlib.createInflateRaw(), check] : [source, check]
        await pipeline(...stages, fs.createWriteStream(target))
      }
      if (crc !== entry.crc || written !== entry.size) {
        fs.rmSync(target, { force: true })
        fail(`"${entry.name}" did not match its checksum; the archive is damaged and nothing more was extracted`)
      }
      files++
    }
    return { files }
  } finally {
    fs.closeSync(fd)
  }
}
