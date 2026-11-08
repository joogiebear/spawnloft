import test from 'node:test'
import assert from 'node:assert/strict'
import { binaryArch } from './core-binary.mjs'

const pad = (head) => Buffer.concat([head, Buffer.alloc(128)])

test('reads a PE x64 header', () => {
  const b = Buffer.alloc(256)
  b.write('MZ', 0, 'latin1')
  b.writeUInt32LE(0x80, 0x3c)
  b.writeUInt32LE(0x00004550, 0x80)
  b.writeUInt16LE(0x8664, 0x84)
  assert.deepEqual(binaryArch(b), { platform: 'win32', arch: 'x64' })
  b.writeUInt16LE(0xaa64, 0x84)
  assert.deepEqual(binaryArch(b), { platform: 'win32', arch: 'arm64' })
})

test('reads ELF x64 and arm64', () => {
  const b = pad(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]))
  b.writeUInt16LE(62, 18)
  assert.deepEqual(binaryArch(b), { platform: 'linux', arch: 'x64' })
  b.writeUInt16LE(183, 18)
  assert.deepEqual(binaryArch(b), { platform: 'linux', arch: 'arm64' })
})

test('reads a thin arm64 Mach-O', () => {
  const b = Buffer.alloc(128)
  b.writeUInt32LE(0xfeedfacf, 0)
  b.writeUInt32LE(0x0100000c, 4)
  assert.deepEqual(binaryArch(b), { platform: 'darwin', arch: 'arm64' })
})

test('refuses scripts and short files', () => {
  assert.equal(binaryArch(Buffer.from('#!/bin/sh\nexec node "$@"\n'.padEnd(80))), null)
  assert.equal(binaryArch(Buffer.from('MZ')), null)
})
