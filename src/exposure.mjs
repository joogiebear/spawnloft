import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Is a server's RCON port open to the internet?
 *
 * <p>RCON is an admin console: whoever is let in can op themselves, stop the server, run anything a
 * plugin exposes. It is unencrypted and guarded by one password, and Minecraft binds it wherever it
 * binds the game - there is no setting to keep it on loopback while the game listens publicly.
 *
 * <p>On a PC behind a home router that does not matter: the machine has a private address and the
 * router is a firewall whether anyone meant it to be or not. The same is true of Windows, whose own
 * firewall refuses inbound connections to a new program until someone allows them. A Linux VPS is
 * the opposite on both counts - a public address on the interface itself, and very often no
 * firewall at all - and that is exactly the machine a headless Linux build invites. So this speaks
 * only there: Linux, a public address, RCON bound beyond loopback, and no firewall that can be seen.
 *
 * <p>Everything is read without root. That limits what can be known about a firewall, and the
 * wording stays inside it: "none was found", not "there is none".
 */

/** An IPv4 address the internet can route to: not private, shared, link-local, loopback or reserved. */
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

/** This machine's public IPv4 addresses, from the interfaces themselves. */
export function publicAddresses(interfaces = os.networkInterfaces()) {
  return Object.values(interfaces).flat()
    .filter(entry => entry && !entry.internal && entry.family === 'IPv4' && isPublicIPv4(entry.address))
    .map(entry => entry.address)
}

/**
 * Whether a firewall can be seen to be on. True, false, or null for "could not tell".
 *
 * <p>ufw records its state in a world-readable file, and firewalld is a service whose state anyone
 * may ask. Hand-written nftables or iptables rules can only be listed as root, so their absence
 * here proves nothing - which is why the answer for "neither of the two was found" is null on a
 * machine that has nft or iptables rulesets configured, and false only when nothing is installed.
 */
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

/** `server-ip` from server.properties; empty means every interface, which is Minecraft's default. */
export function boundAddress(dir, read = file => fs.readFileSync(file, 'utf8')) {
  try {
    const hit = /^\s*server-ip\s*=\s*(.*)$/m.exec(read(path.join(dir, 'server.properties')))
    return hit ? hit[1].trim() : ''
  } catch { return '' }
}

/**
 * The finding for one instance, or null when there is nothing to say.
 *
 * <p>Shaped like a console diagnosis (id, title, advice) so the panel shows it where it shows
 * those, and `doctor` prints the same sentence.
 */
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
