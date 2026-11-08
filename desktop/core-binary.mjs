// What a spawnloft-core binary is built for, read from its header, so a build that packs the wrong
// one (an x64 binary in an arm64 app, a Linux one in the Windows installer) fails before it ships.

// PE machine field values, ELF e_machine values, Mach-O CPU types
const PE = { 0x8664: 'x64', 0xaa64: 'arm64' }
const ELF = { 62: 'x64', 183: 'arm64' }
const MACHO = { 0x01000007: 'x64', 0x0100000c: 'arm64' }

/** { platform, arch } as Node names them, or null when the bytes are no executable we know. */
export function binaryArch(bytes) {
  if (bytes.length < 64) return null
  // PE: "MZ", then the offset of "PE\0\0" at 0x3c, then the machine field
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const pe = bytes.readUInt32LE(0x3c)
    if (pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550) return null
    const arch = PE[bytes.readUInt16LE(pe + 4)]
    return arch ? { platform: 'win32', arch } : null
  }
  // ELF: 0x7f "ELF", class, data (1 = little endian), ..., e_machine at 18
  if (bytes.readUInt32BE(0) === 0x7f454c46) {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
    const arch = ELF[machine]
    return arch ? { platform: 'linux', arch } : null
  }
  // thin 64-bit Mach-O, little endian (0xfeedfacf stored as cf fa ed fe)
  if (bytes.readUInt32LE(0) === 0xfeedfacf) {
    const arch = MACHO[bytes.readUInt32LE(4)]
    return arch ? { platform: 'darwin', arch } : null
  }
  return null
}
