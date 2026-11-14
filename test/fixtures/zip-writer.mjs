// A small stored (uncompressed) zip writer for tests: [name, string | Buffer] pairs.
import zlib from 'node:zlib'

export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, body] of entries) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(zlib.crc32(raw), 14)
    local.writeUInt32LE(raw.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, raw)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(zlib.crc32(raw), 16)
    central.writeUInt32LE(raw.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + raw.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

// A jar with just a manifest naming its main class
export const toolJar = (main) => buildZip([['META-INF/MANIFEST.MF', `Manifest-Version: 1.0\r\nMain-Class: ${main}\r\n\r\n`]])
