import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPublicIPv4, publicAddresses, firewallActive, boundAddress, rconExposure } from '../src/exposure.mjs'

test('an address the internet can route to is told apart from one only a LAN can', () => {
  for (const address of ['203.0.114.9', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.167.1.1'])
    assert.equal(isPublicIPv4(address), true, address)
  for (const address of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20', '127.0.0.1', '169.254.10.1',
    '100.64.0.1', '100.127.255.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', '203.0.113.7', '198.51.100.1'])
    assert.equal(isPublicIPv4(address), false, address)
  for (const nonsense of ['', 'fe80::1', '1.2.3', '1.2.3.256', '1.2.3.x']) assert.equal(isPublicIPv4(nonsense), false, nonsense)
})

test('only real, external IPv4 interfaces count as this machine being on the internet', () => {
  assert.deepEqual(publicAddresses({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '198.199.70.20', family: 'IPv4', internal: false }, { address: '2604:a880::1', family: 'IPv6', internal: false }],
    eth1: [{ address: '10.10.0.5', family: 'IPv4', internal: false }],
  }), ['198.199.70.20'])
  // A home PC: private addresses only, a router in front. Nothing to say.
  assert.deepEqual(publicAddresses({ wlan0: [{ address: '192.168.1.44', family: 'IPv4', internal: false }] }), [])
})

test('a firewall is reported on, off, or not knowable - never guessed', () => {
  const files = map => file => { if (file in map) return map[file]; throw Object.assign(new Error('nope'), { code: 'ENOENT' }) }
  const service = state => () => ({ stdout: state + '\n' })
  assert.equal(firewallActive({ read: files({ '/etc/ufw/ufw.conf': '# comment\nENABLED=yes\nLOGLEVEL=low\n' }), run: service('inactive') }), true)
  assert.equal(firewallActive({ read: files({ '/etc/ufw/ufw.conf': 'ENABLED=no\n' }), run: service('active') }), true)
  assert.equal(firewallActive({ read: files({ '/etc/ufw/ufw.conf': 'ENABLED=no\n' }), run: service('inactive') }), false)
  assert.equal(firewallActive({ read: files({}), run: () => ({ error: new Error('no systemctl') }) }), false)
  // Rules of someone's own can only be listed as root; their existence is not the lack of a firewall.
  assert.equal(firewallActive({ read: files({ '/etc/nftables.conf': 'table inet filter {\n}\n' }), run: service('inactive') }), null)
  assert.equal(firewallActive({ read: files({ '/etc/iptables/rules.v4': '*filter\n:INPUT DROP [0:0]\n-A INPUT -i lo -j ACCEPT\n' }), run: service('unknown') }), null)
})

test('server-ip is read from server.properties, and absent means every interface', () => {
  assert.equal(boundAddress('/srv/x', () => 'motd=hi\nserver-ip=127.0.0.1\nserver-port=25565\n'), '127.0.0.1')
  assert.equal(boundAddress('/srv/x', () => 'server-ip=\n'), '')
  assert.equal(boundAddress('/srv/x', () => 'motd=hi\n'), '')
  assert.equal(boundAddress('/srv/x', () => { throw new Error('gone') }), '')
})

test('the warning speaks only on the machine it is about', () => {
  const inst = { name: 'smp', dir: '/srv/smp', port: 25565, rcon: { port: 25575 } }
  const vps = { platform: 'linux', addresses: ['198.199.70.20'], firewall: false, bound: '' }
  const found = rconExposure(inst, vps)
  assert.equal(found.id, 'rcon-exposed')
  assert.match(found.advice, /198\.199\.70\.20/)
  assert.match(found.advice, /port 25575/)
  assert.match(found.advice, /No firewall was found/)
  // The remedy opens the game port and SSH, and never RCON; and says why the order matters.
  assert.match(found.advice, /ufw allow OpenSSH && sudo ufw allow 25565\/tcp && sudo ufw enable/)
  assert.doesNotMatch(found.advice, /ufw allow 25575/)
  assert.match(rconExposure(inst, { ...vps, firewall: null }).advice, /could not be confirmed/)

  assert.equal(rconExposure(inst, { ...vps, firewall: true }), null, 'a firewall is on')
  assert.equal(rconExposure(inst, { ...vps, addresses: [] }), null, 'behind a router')
  assert.equal(rconExposure(inst, { ...vps, bound: '127.0.0.1' }), null, 'bound to loopback')
  assert.equal(rconExposure(inst, { ...vps, platform: 'win32' }), null, 'Windows has its own inbound firewall')
  assert.equal(rconExposure(inst, { ...vps, platform: 'darwin' }), null)
  assert.equal(rconExposure({ ...inst, rcon: null }, vps), null, 'no RCON configured')
})
