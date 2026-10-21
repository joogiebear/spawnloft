import crypto from 'node:crypto'

import { fail } from './util.mjs'

export function offlineUuid(name) {
  const bytes = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function assertPlayerName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    fail(`player name "${name}" must be 3 to 16 letters, digits or underscores`)
  }
  return name
}

// A profile name may be shorter, longer or hold a dash; the player name derived from it must
// still pass the server's rule.
export function defaultPlayerName(profileName) {
  const base = String(profileName).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16)
  return base.length >= 3 ? base : (base + '___').slice(0, 3)
}

export function offlineAccount(name) {
  assertPlayerName(name)
  return { type: 'offline', name, uuid: offlineUuid(name), accessToken: '0', userType: 'legacy', xuid: '', clientId: '' }
}
