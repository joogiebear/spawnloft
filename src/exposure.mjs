import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Is a server's RCON port open to the internet? RCON is an unencrypted admin console behind one password,
// and Minecraft binds it wherever it binds the game. Behind a home router or the Windows firewall that
// doesn't matter, so this only speaks on Linux with a public address, RCON bound beyond loopback, and no
// firewall that can be seen. Everything is read without root, so the wording stays at "none was found".

// routable on the internet: not private, shared, link-local, loopback or reserved
export function isPublicIPv4(address) {
  const parts = String(address).split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  const [a, b, c] = parts.map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false       // this network, private, loopback, multicast and reserved
  if (a === 169 && b === 254) return false                             // link-local
  if (a === 172 && b >= 16 && b <= 31) return false                    // private
  if (a === 192 && b === 168) return false                             // private
  if (a === 100 && b >= 64 && b <= 127) return false                   // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return false                // benchmarking
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false       // protocol assignments, TEST-NET-1
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false // TEST-NET-2 and -3
  return true
}

export function publicAddresses(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces).flat()
    .filter(entry => entry && !entry.internal && entry.family === 'IPv4' && isPublicIPv4(entry.address))
    .map(entry => entry.address)
}

// True, false, or null for "could not tell". ufw and firewalld state can be read without root; hand-written
// nftables/iptables rules cannot be listed, so a saved ruleset file gives null and false means none was found.
export function firewallActive({ read = file => fs.readFileSync(file, 'utf8'), run = spawnSync } = {}) {
  try {
    if (/^\s*ENABLED\s*=\s*yes\s*$/im.test(read('/etc/ufw/ufw.conf'))) return true
  } catch { /* ufw is not installed */ }
  const firewalld = run('systemctl', ['is-active', 'firewalld'], { encoding: 'utf8', timeout: 5000 })
  if (!firewalld.error && String(firewalld.stdout).trim() === 'active') return true
  // A saved ruleset of someone's own is a firewall this cannot read, not the lack of one.
  for (const file of ['/etc/nftables.conf', '/etc/iptables/rules.v4', '/etc/sysconfig/iptables']) {
    try { if (/^\s*(table|-A|:INPUT)\b/m.test(read(file))) return null } catch { /* not there */ }
  }
  return false
}

// server-ip from server.properties; empty means every interface, Minecraft's default
export function boundAddress(dir, read = file => fs.readFileSync(file, 'utf8')) {
  try {
    const hit = /^\s*server-ip\s*=\s*(.*)$/m.exec(read(path.join(dir, 'server.properties')))
    return hit ? hit[1].trim() : ''
  } catch { return '' }
}

// Shaped like a console diagnosis (id, title, advice) so the panel shows it with those and doctor prints the same sentence.
export function rconExposure(inst, {
  platform = process.platform, addresses = publicAddresses(), firewall = undefined, bound = undefined,
} = {}) {
  if (platform !== 'linux' || !inst?.rcon?.port || !addresses.length) return null
  const ip = bound ?? boundAddress(inst.dir)
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1') return null
  const wall = firewall === undefined ? firewallActive() : firewall
  if (wall === true) return null
  const found = wall === null ? 'A firewall may be in place, but one could not be confirmed.' : 'No firewall was found.'
  return {
    id: 'rcon-exposed',
    title: 'The admin console may be open to the internet',
    advice: `This machine has a public address (${addresses[0]}) and RCON listens on port ${inst.rcon.port} on every interface - ` +
      `Minecraft cannot bind it separately from the game. ${found} RCON is unencrypted and guarded only by its password. ` +
      `Block it: sudo ufw allow OpenSSH && sudo ufw allow ${inst.port}/tcp && sudo ufw enable ` +
      `(allow SSH first, or enabling the firewall will lock you out).`,
  }
}
