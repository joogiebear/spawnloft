// Writes C1's behaviour fixtures from the Node modules, which are the reference:
//   node tools/parity/make-c1-fixtures.mjs
// test/fixtures/contracts/diagnose.json: diagnose() over console lines in three contexts (the
//   terminal with a server's details, the panel, none), read by spawnloft-lib's diagnose.rs tests.
// test/fixtures/contracts/js-patterns.json: run-time patterns (`logs --grep`, case-insensitive)
//   against subject lines, read by jsregex.rs's tests. Patterns the Rust core refuses on purpose
//   (lookaround, backreferences: the declared difference runtime-pattern-syntax) are not here.
// test/fixtures/contracts/js-numbers.json: Number(text), String(number) and toFixed, read by js.rs.
// test/fixtures/contracts/c1-library.json: the library modules PR 2 of C1 ports with no command of
//   their own yet (exposure, cleanJvmFlags, data-format, the log timeline in two zones, the
//   activity reader), read by the tests of spawnloft-lib's exposure.rs, registry.rs,
//   data_format.rs, log_timeline.rs and activity.rs.
// Change the cases here, never the expectations by hand. test/c1-fixtures.test.mjs fails when a
// file no longer matches what this script makes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { diagnose } from '../../src/diagnose.mjs'
import { isPublicIPv4, isPrivateIPv4, publicAddresses, lanAddresses, joinInfo, rconExposure, boundAddress, firewallActive } from '../../src/exposure.mjs'
import { cleanJvmFlags, serverJvmArgs } from '../../src/registry.mjs'
import { dataFormatWarning } from '../../src/data-format.mjs'
import { parseLine, parseLog, mergeTimelines, formatTimeline } from '../../src/log-timeline.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '..', '..', 'test', 'fixtures', 'contracts')

const LINES = [
  '[12:00:01 WARN]: FAILED TO BIND TO PORT!',
  '[12:00:01 WARN]: java.net.BindException: Address already in use',
  'Failed to bind to address 0.0.0.0:25565',
  '[12:00:01 INFO]: You need to agree to the EULA in order to run the server.',
  'java.lang.UnsupportedClassVersionError: net/minecraft/server/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0)',
  'UnsupportedClassVersionError: x (class file version 61.0), this version only recognizes up to 52.0',
  'UnsupportedClassVersionError\rclass file version 65',
  'Exception in thread "main" java.lang.OutOfMemoryError: Java heap space',
  'java.io.IOException: No space left on device',
  'There is not enough space on the disk',
  "org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [ProtocolLib]. Please download and install these plugins to run 'Shop'.",
  'UnknownDependencyException: Unknown/missing dependency plugins: [ProtocolLib, Vault]. Please download',
  'UnknownDependencyException: Unknown/missing dependency plugins: [My.Plugin, Plugin Name]. Please',
  'org.bukkit.plugin.UnknownDependencyException: Unknown dependency Vault. Please download and install Vault to run this plugin.',
  'UnknownDependencyException: Unknown dependency',
  'UnknownDependencyException: null',
  'UnknownDependencyException: Some.Plugin-2.x',
  'UnknownDependencyExceptionX: Vault',
  'Mod sodium-extra requires any version of sodium, which is missing!',
  "Mod 'Lithium' (lithium) 0.11.2 requires version 0.15.0 of fabric-api, which is missing!",
  '[12:00:00 ERROR]: Ambiguous plugin name `WorldEdit\' for files `plugins/a.jar\' and `plugins/b.jar\'',
  '[12:00:02 ERROR]: Exception reading ./world/level.dat',
  'Failed to load level',
  'ChunkIoErrorReport: x',
  'Corrupted chunk at 1, 2',
  '[12:00:02 ERROR]: Ticking entity: minecraft:zombie',
  'Ticking block entity',
  'Exception ticking world',
  '[12:00:03 ERROR]: A single server tick took 60.00 seconds (should be max 0.05)',
  'Considering it to be crashed, server will forcibly shut down.',
  'Error: Unable to access jarfile server.jar',
  'Error: Unable to access jarfile   spaced name.jar   ',
  '[12:00:00 INFO]: Done (3.2s)! For help, type "help"',
  'failed to bind to port (lower case)',
  'ＦAILED TO BIND TO PORT',
  '',
]
const CONTEXTS = {
  // the folder is joined with eula.txt by path.join, so the Windows reader swaps the separators
  cli: { port: 25566, memory: '4G', dir: '/srv/smp', crashDir: '/srv/smp/crash-reports' },
  panel: { port: 25565, memory: '2G', dir: '/srv/smp', panel: true },
  none: {},
}
const cases = []
for (const [ctxName, ctx] of Object.entries(CONTEXTS)) {
  for (const line of LINES) cases.push({ ctx: ctxName, lines: [line], findings: diagnose([line], ctx) })
  // more than three shapes: the newest evidence wins, then log order
  const many = ['java.lang.OutOfMemoryError', 'FAILED TO BIND TO PORT', 'No space left on device', 'Ambiguous plugin name', 'Corrupted chunk', 'FAILED TO BIND TO PORT again']
  cases.push({ ctx: ctxName, lines: many, findings: diagnose(many, ctx) })
}

const PATTERNS = [
  'info', 'WARN', ' ERROR]| WARN]|Exception', '^\\[10:00:0[12]\\]', '\\d{2}:\\d{2}', '\\bjava\\.', '[\\w-]+:', '\\[[^\\]]+\\]',
  'a.c', 'a{', 'a{2}', 'x]', '\\a', '[\\w-]+$', '\\u0041', '\\x41', '[^]', '\\s', '\\S+', '\\D', '\\W', '\\B', 'colou?r', '(ab)+',
  '(?:x|y)z', '(?<n>a)b', '^$', 'é', 'É', '\\.jar$', 'a|', '|', '[a-c]+', '[^a-c]', '\\/', '\\-', '[\\-]', '\\0', '\\cJ', '\\c', '\\t',
  '[\\b]', 'a*?b', 'a{1,}b', 'a{,2}', '\\k', '\\8', '[\\d-x]', 'true', 'ſ', 'k', '\\w', '\\u{41}', '\\uD83D', '[&&]', 'a--b',
  // nothing to repeat, and other refusals
  'a**', 'a{2}{3}', 'x{1,2}{3}', 'a?+', '(?:a|b)++', '\\b+', '^*', '*a', 'a|*', 'a+??', '(?<1a>x)', '(?<a>x)(?<a>y)', 'x{3,2}',
  // case mates beyond one pair, Annex B escapes, group names
  'σ', 'Σ', 'ς', 'µ', 'μ', 'ǆ', 'ǅ', 'θ', 'ϑ', 'ı', 'İ', '[\\c1]', '[\\c_]', '\\c1', '\\k<x>', '(?<$x>a)', 'a+?', 'a{2}?', '[σ-ω]',
  'x(?<n>a)\\k<n>', 'a{99999999999}',
]
const SUBJECTS = [
  '[10:00:01] [Server thread/INFO]: Starting', '[10:00:02] [Server thread/WARN]: Can\'t keep up!', 'x WARN] y', 'java.lang.Error',
  'abc', 'a\rc', 'a{', 'aa', 'x]', 'a', 'a-b', 'A', '\n', ' ', '\u00a0', '\ufeff', '\u0085', 'color', 'colour', 'ababz', 'yz', 'ab', '',
  'é', 'É', 'server.jar', 'b', 'd', '/', '-', '\u0000', '\n', '\t', '\b', 'aab', 'aaab', 'a{,2}', 'k', '8', '3-x', 'TRUE', 'ſ', 'K',
  'S', 's', '\u212a', '\u0663', 'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu', 'AAAA', '&', 'a--b', '😀',
  'σ', 'Σ', 'ς', 'µ', 'μ', 'Μ', 'ǆ', 'ǅ', 'Ǆ', 'θ', 'ϑ', 'Θ', '\u0011', '\u001f', 'c1', '\\c1', 'k<x>', 'İ', 'ı', 'i', 'I', 'xaa', 'ω', 'Ω',
]
const patterns = []
for (const source of PATTERNS) {
  let re
  try {
    re = new RegExp(source, 'i')
  } catch (e) {
    patterns.push({ source, invalid: true })
    continue
  }
  patterns.push({ source, matches: SUBJECTS.filter(s => re.test(s)) })
}

const NUMBER_TEXT = ['', ' ', ' 5 ', '0x10', '0X1f', '0b101', '0o17', '1e2', '1E-2', '1.', '.5', '+.5', '-0', '+Infinity', '-Infinity', 'Infinity',
  'infinity', 'inf', 'nan', 'NaN', 'abc', 'true', '.', '1e', '1_000', '0x', '-0x10', '1 2', '\u00a05\u2028', '0.1e+5', '00012', '1.5.2']
const NUMBERS = [0, -0, 1, 0.1, 1.25, 1.35, 1.45, 2.5, -2.5, 12, 99.95, 1023.95, 1e21, 1e-7, 1.5e-7, 0.000001, 123456789012345680000, 12345678901234567890, 2 ** 53 + 1, 5e-324, 1.7976931348623157e308, 0.30000000000000004, 100, 2048.5, 600, 12.25, -0.04]
const numbers = {
  parse: NUMBER_TEXT.map(text => ({ text, value: Number.isNaN(Number(text)) ? 'NaN' : String(Number(text)) })),
  print: NUMBERS.map(n => ({ n, text: String(n), fixed1: n.toFixed(1), fixed0: n.toFixed(0) })),
}

// ---- c1-library.json
const outcome = (fn) => {
  try { return { value: fn() } } catch (e) { return { error: e.message } }
}
const ADDRESSES = ['8.8.8.8', '1.1.1.1', '10.0.0.1', '127.0.0.1', '0.0.0.0', '169.254.1.1', '172.16.0.1', '172.32.0.1', '172.15.255.255',
  '192.168.1.10', '100.64.0.1', '100.128.0.1', '198.18.0.1', '198.20.0.1', '192.0.0.1', '192.0.2.1', '192.0.3.1', '198.51.100.7',
  '203.0.113.9', '224.0.0.1', '255.255.255.255', '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.0004', '', 'a.b.c.d', ' 1.2.3.4', '::1']
const nic = (address, extra = {}) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal: false, ...extra })
const INTERFACES = {
  home: { lo: [nic('127.0.0.1', { internal: true }), nic('::1', { internal: true })], eth0: [nic('192.168.1.20'), nic('fe80::1')], 'docker0': [nic('172.17.0.1')] },
  vm: { lo: [nic('127.0.0.1', { internal: true })], 'vEthernet (WSL)': [nic('172.20.0.1')], virbr0: [nic('192.168.122.1')] },
  vps: { lo: [nic('127.0.0.1', { internal: true })], ens3: [nic('203.1.113.5'), nic('2001:db8::5')], wg0: [nic('10.8.0.1')] },
  odd: { 'Tailscale': [nic('100.100.1.1')], 'Wi-Fi': [nic('10.1.2.3'), nic('10.1.2.4')], 'TAP-x': [nic('192.168.50.1')], none: [] },
}
const JOINS = [
  [{ port: 25565, dir: '/x' }, ''], [{ port: 25565, dir: '/x' }, '0.0.0.0'], [{ port: 25565, dir: '/x' }, '::'], [{ port: 25565, dir: '/x' }, '127.0.0.1'],
  [{ port: 25565 }, 'localhost'], [{ port: 25565 }, '::1'], [{ port: 25565 }, '[::1]'], [{ port: 25565 }, ' 192.168.1.20 '], [{ port: 25565 }, '203.1.113.5'],
  [{ port: 25565 }, '10.9.9.9'], [{ port: 25565 }, 'fe80::1'], [{ port: 25565 }, '127.999.0.1'], [{ port: '25565' }, ''], [{ port: 25565.5, bind: '10.8.0.1' }, null],
  [{ port: 25565, bind: '0.0.0.0' }, null], [{ port: 25565, bind: '' }, ''], [{ bind: '[::]' }, null], [{ port: 1, bind: 127 }, null],
]
const joins = []
for (const [iname, ifaces] of Object.entries(INTERFACES)) {
  for (const [inst, bound] of JOINS) joins.push({ interfaces: iname, inst, bound, info: joinInfo(inst, { interfaces: ifaces, bound: bound ?? undefined }) })
}
const RCON = [
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: '' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: ['203.1.113.5', '8.8.8.8'], firewall: null, bound: '0.0.0.0' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: true, bound: '' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: [], firewall: false, bound: '' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'win32', addresses: ['203.1.113.5'], firewall: false, bound: '' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: '127.0.0.1' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: 'localhost' }],
  [{ port: 25565, rcon: { port: 25575 } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: '10.0.0.5' }],
  [{ port: 25565, rcon: { port: 0 } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: '' }],
  [{ port: 25565 }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: '' }],
  [{ rcon: { port: '25575' } }, { platform: 'linux', addresses: ['203.1.113.5'], firewall: false, bound: '' }],
]
const PROPERTIES = ['server-ip=\nserver-port=25565\n', 'motd=x\n \tserver-ip = 10.0.0.5 \r\nserver-port=1', '#server-ip=1.2.3.4\n', 'server-ipx=1\nserver-ip=2\n',
  'server-ip=1.2.3.4\rserver-port=5', 'server-ip= next', 'x=1\n  server-ip   =   \n', 'server-ip:1.2.3.4\n', '']
const FIREWALL = [
  [{ '/etc/ufw/ufw.conf': '# x\n ENABLED = YES \n' }, ''], [{ '/etc/ufw/ufw.conf': 'ENABLED=no\n' }, ''], [{}, 'active\n'], [{}, 'inactive\n'], [{}, null],
  [{ '/etc/nftables.conf': 'flush ruleset\ntable inet filter {\n' }, ''], [{ '/etc/iptables/rules.v4': '*filter\n:INPUT ACCEPT\n' }, ''],
  [{ '/etc/nftables.conf': 'tables\n' }, ''], [{ '/etc/sysconfig/iptables': '  -A INPUT -j DROP\n' }, ''], [{ '/etc/sysconfig/iptables': '-AB\n' }, ''],
  [{ '/etc/ufw/ufw.conf': 'ENABLED=yes # comment\n' }, ''], [{ '/etc/ufw/ufw.conf': 'enabled\t=\tyes' }, ''],
]
const exposure = {
  addresses: ADDRESSES.map(a => ({ address: a, public: isPublicIPv4(a), private: isPrivateIPv4(a) })),
  interfaces: INTERFACES,
  lists: Object.fromEntries(Object.entries(INTERFACES).map(([k, v]) => [k, { public: publicAddresses(v), lan: lanAddresses(v) }])),
  joins,
  rcon: RCON.map(([inst, seen]) => ({ inst, seen, exposure: rconExposure(inst, seen) })),
  bound: PROPERTIES.map(text => ({ text, bound: boundAddress('/x', () => text) })),
  firewall: FIREWALL.map(([files, systemctl]) => ({
    files, systemctl,
    active: firewallActive({
      read: (f) => { if (Object.hasOwn(files, f)) return files[f]; throw new Error('ENOENT') },
      run: () => (systemctl === null ? { error: new Error('ENOENT') } : { stdout: systemctl, status: 0 }),
    }),
  })),
}

const JVM = [null, '', '   ', '-XX:+UseG1GC', '-XX:+UseG1GC  -Dfoo=bar\n-Dx=1', ['-Da', ' -Db ', ''], ['-Da', 5], 'nodash', '-Xmx4G', '-xms1g', '-XmX', '-jar',
  '-JAR', '-cp', '--class-path', '--CLASS-PATH', '-classpath', '-jarx', '-' + 'x'.repeat(300), '-' + 'x'.repeat(299), Array(61).fill('-Da').join(' '), Array(60).fill('-Da'),
  '-Da -Db', '-Da -Db', '-Da﻿-Db', 5, true, ['-Dé']]
const jvm = {
  clean: JVM.map(input => ({ input, ...outcome(() => cleanJvmFlags(input)) })),
  args: serverJvmArgs('4G', ['-XX:+UseG1GC'], 'paper.jar'),
}

const MARKERS = [{ writtenBy: '3.1.0', format: 1 }, { writtenBy: '2.4.0', format: 1 }, { format: 2 }, { format: 1.5 }, { writtenBy: 'v3.0' }, { writtenBy: '3' },
  { writtenBy: 3.5 }, { writtenBy: '10.0.0', format: '2' }, { writtenBy: null, format: 3 }, {}, { writtenBy: '99999999999999999999.0' }]
const VERSIONS = ['2.0.0', 'v2.1', '2', null, '2.0.0-internal.5']
const dataFormat = []
for (const marker of MARKERS) for (const version of VERSIONS) dataFormat.push({ marker, version, warning: dataFormatWarning({ file: '/d/data-format.json', marker, version }) })

const LOG_LINES = [
  '[12:00:01 INFO]: Done (3.2s)!', '[12:00:01 SEVERE]: bad', '[12:00:01 warn]: lower', '[12:00:01] [Server thread/INFO]: fabric', '[12:00:01] [main/WARN] (fabric-loader) mod text',
  '[2026-08-31T05:42:27.5Z] daemon line', '[2026-08-31 05:42:27+0100] daemon colonless', '[2026-08-31T05:42:27] daemon local', '[2026-02-30 05:42:27] overflow',
  '2026-08-31T05:42:27.5Z ServerMain WARN Advanced terminal', '2026-08-31T05:42:27Z main SEVERE x', '2026-08-31T05:42:27Z main NOTICE x', 'plain text', '\tat java.lang.Thread.run',
  '[12:00:01 INFO]: crlf\r', '[12:00:01 INFO]: a b', '[１２:00:01 INFO]: wide digits', '[12:00:01 ÌNFO]: accent', '[12:00:01] [a]b/INFO]: x', '',
  '[2026-13-01T00:00:00Z] bad month', '[2026-08-31T24:00:00Z] midnight', '[0001-01-01 00:00:00Z] legacy year', '[2026-08-31T05:42:27-0230] minus',
]
const LOGS = [
  { lines: ['Starting org.bukkit.craftbukkit.Main', '[23:59:58 INFO]: a', '[23:59:59 INFO]: b', '[00:00:01 INFO]: next day', '\tcontinued', '[01:30:00 INFO]: c'], anchor: null, mtime: Date.UTC(2026, 2, 9, 6, 0, 0) },
  { lines: ['[10:00:00 INFO]: a', '[09:30:00 INFO]: half hour back stays', '[08:00:00 INFO]: two back is a new day'], anchor: Date.UTC(2026, 10, 1, 13, 0, 0), mtime: null },
  { lines: ['[01:59:00 INFO]: before', '[02:30:00 INFO]: skipped hour', '[03:01:00 INFO]: after'], anchor: Date.UTC(2026, 2, 8, 5, 0, 0), mtime: null },
  { lines: ['[01:30:00 INFO]: twice', '[01:45:00 INFO]: twice again'], anchor: Date.UTC(2026, 10, 1, 4, 0, 0), mtime: null },
  { lines: ['[01:30:00 INFO]: mtime in the repeated hour'], anchor: null, mtime: Date.UTC(2026, 10, 1, 6, 40, 0) },
  { lines: ['[12:00:00 INFO]: anchor later in the day'], anchor: Date.UTC(2026, 5, 15, 20, 0, 0), mtime: null },
  { lines: ['[23:00:00 INFO]: after mtime of day'], anchor: null, mtime: Date.UTC(2026, 5, 15, 12, 0, 0) },
  { lines: ['no stamp at all', 'still none'], anchor: null, mtime: Date.UTC(2026, 0, 31, 23, 30, 0) },
  { lines: ['[2026-08-31T05:42:27Z] only daemon', 'cont'], anchor: null, mtime: Date.UTC(2026, 0, 1) },
  { lines: ['[12:00:00 INFO]: month end'], anchor: null, mtime: Date.UTC(2026, 2, 1, 4, 0, 0) },
  { lines: ['[2026-08-31 99:99:99] unreadable', '[12:00:00 INFO]: after'], anchor: Date.UTC(2026, 7, 31), mtime: null },
]
const DATES = ['2026-08-31T05:42:27.5Z', '2026-08-31 05:42:27.5Z', '2026-08-31t05:42:27Z', '2026-08-31T05:42:27+0100', '2026-08-31T05:42:27+01:00', '2026-08-31 05:42:27',
  '2026-08-31T05:42:27', '2026-08-31T05:42:27.123456Z', '2026-08-31 05:42:27-0230', '2026-13-31T05:42:27Z', '2026-02-30T05:42:27Z', '2026-08-31T24:00:00Z', '2026-08-31T25:00:00Z',
  '2026-08-31 24:00:00', '2026-08-31T05:42:60Z', '2026-03-08T02:30:00', '2026-11-01T01:30:00', '2026-03-08 02:30:00', '2026-11-01 01:30:00', '2026-08-31T05:42:27.Z',
  '0000-01-01T00:00:00Z', '2026-02-00T05:42:27Z', '2026-02-32T05:42:27Z', '2026-08-31T24:00:01Z', '2026-08-31T24:00:00.001Z', '2026-08-31 24:00:00.5', '2026-08-31 24:00:00.000', '2026-08-31 24:00:00.0001', '2026-08-31T24:00:00.0001Z',
  '2026-08-31 05:42:27+2400', '2026-08-31 05:42:27+2359', '2026-08-31T05:42:27+24:00', '2026-08-31T05:42:27+2400', '2026-08-31 05:42:27+24:00', '2026-08-31 05:42:27+23:60',
  '2026-08-31 05:42:27+0099', '2026-08-31T05:42:27+0099', '2026-08-31 05:42:27+0023', '2026-08-31T05:42:27+0023', '2026-08-31 05:42:27+0024', '2026-08-31 05:42:27+9999',
  '2026-08-31T05:42:27+00:99', '0001-01-01 00:00:00Z', '0049-06-01 00:00:00Z', '0050-06-01 00:00:00Z', '0099-06-01 00:00:00', '0100-06-01 00:00:00Z', '9999-12-31T23:59:59Z',
  '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '-000001-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '-000000-01-01T00:00:00.000Z', 'Invalid Date', '']
function timeline(tz) {
  const was = process.env.TZ
  process.env.TZ = tz
  try {
    const logs = LOGS.map(({ lines, anchor, mtime }) => {
      const entries = parseLog(lines, { source: 'server', anchor, mtime })
      return { lines, anchor, mtime, entries, text: formatTimeline(entries, { width: 8 }) }
    })
    const merged = mergeTimelines(...LOGS.slice(0, 3).map(({ lines, anchor, mtime }, i) => parseLog(lines, { source: SOURCES_FOR[i], anchor, mtime })))
    return {
      tz,
      dates: DATES.map(text => { const t = new Date(text).getTime(); return { text, ms: Number.isNaN(t) ? null : t } }),
      logs,
      merged: { entries: merged, text: formatTimeline(merged) },
    }
  } finally {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  }
}
const SOURCES_FOR = ['server', 'daemon', 'client']

// The activity reader runs in a child whose data root holds these two files.
const ACTIVITY_PREVIOUS = [
  { at: '2026-01-01T00:00:00.000Z', server: 'smp', action: 'create', by: { kind: 'cli' } },
  { at: '2026-01-02T00:00:00.000Z', server: 'smp', action: 'backup', by: { kind: 'schedule', name: 'nightly' } },
  { at: '2026-01-03T00:00:00.000Z', server: 'old', action: 'backup', by: { kind: 'panel' } },
].map(e => JSON.stringify(e)).join('\n') + '\n'
const ACTIVITY_CURRENT = [
  JSON.stringify({ at: '2026-01-04T00:00:00.000Z', server: 'smp', action: 'backup-delete', by: { kind: 'panel' } }),
  '{"at":"2026-01-04T01:00:00.000Z","server":"smp","action":"backup-prune","detail":" 3 backups","by":{"kind":"schedule"}}',
  '{"truncated":',
  '',
  '  ',
  JSON.stringify({ at: '2026-01-05T00:00:00.000Z', server: 'smp', action: 'schedule-disable', detail: 'Automatic backup', by: { kind: 'assistant', name: 'Claude' } }),
  JSON.stringify({ at: '2026-01-05T01:00:00.000Z', server: 'smp', action: 'backup-prune', detail: 'none', by: { kind: 'schedule' } }),
  JSON.stringify({ at: '2026-01-06T00:00:00.000Z', server: 'old', action: 'delete', by: { kind: 'cli' }, ok: false }),
  JSON.stringify({ at: '2026-01-06T01:00:00.000Z', server: 'old', action: 'delete', by: { kind: 'cli' } }),
  JSON.stringify({ at: '2026-01-07T00:00:00.000Z', server: 'new', action: 'start', by: 'cli' }),
  JSON.stringify({ at: 5, server: 'new', action: 'stop' }),
  JSON.stringify({ server: 'new', action: 'restart', by: { kind: 'spawnloft' } }),
  JSON.stringify({ at: 'not a date', server: 'gone', action: 'backup', by: { kind: 'cli' } }),
  '[1,2]',
  '"text"',
  JSON.stringify({ at: '2026-01-08T00:00:00.000Z', server: 'smp', action: 'schedule-remove', detail: 'Automatic backup', by: { kind: 'panel' } }),
].join('\n')
const ACTIVITY_QUERIES = [{}, { limit: 3 }, { limit: 0 }, { server: 'smp' }, { server: 'new' }, { since: '2026-01-04T00:00:00.000Z' }, { before: '2026-01-05T00:00:00.000Z' },
  { by: 'you' }, { by: 'schedule', limit: 1 }, { by: 'cli' }, { server: 'smp', since: '2026-01-02', before: '2026-01-05' }, { by: 'spawnloft' }]
function activity() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-c1-activity-'))
  try {
    fs.writeFileSync(path.join(root, 'activity.1.jsonl'), ACTIVITY_PREVIOUS)
    fs.writeFileSync(path.join(root, 'activity.jsonl'), ACTIVITY_CURRENT)
    const script = `
      const { readActivity, backupTrails } = await import(${JSON.stringify(new URL('../../src/activity.mjs', import.meta.url).href)})
      const queries = JSON.parse(process.argv[1])
      process.stdout.write(JSON.stringify({
        reads: queries.map(q => ({ query: q, ...readActivity(q) })),
        trails: backupTrails(['smp', 'old', 'new', 'gone', 'none', 'smp']),
      }))`
    const env = { ...process.env, SPAWNLOFT_DATA_ROOT: root }
    for (const k of Object.keys(env)) if (/^MCCTL_/.test(k)) delete env[k]
    const outText = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(ACTIVITY_QUERIES)], { env, encoding: 'utf8' })
    return { previous: ACTIVITY_PREVIOUS, current: ACTIVITY_CURRENT, ...JSON.parse(outText) }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const library = () => ({
  exposure,
  jvm,
  dataFormat,
  lines: LOG_LINES.map(line => ({ line, parsed: parseLine(line) })),
  timelines: [timeline('America/New_York'), timeline('UTC')],
  activity: activity(),
})

const doc = (about, data) => ({ about, ...data })
const files = () => ({
  'diagnose.json': doc('diagnose() from src/diagnose.mjs over console lines in three contexts. Made by tools/parity/make-c1-fixtures.mjs; spawnloft-lib diagnose.rs must agree on every case.', { contexts: CONTEXTS, cases }),
  'js-patterns.json': doc('new RegExp(source, "i").test(subject) in Node for the run-time pattern sites (logs --grep). Made by tools/parity/make-c1-fixtures.mjs; spawnloft-lib jsregex.rs must agree, and must refuse exactly the patterns marked invalid.', { subjects: SUBJECTS, patterns }),
  'js-numbers.json': doc('Number(text), String(n), n.toFixed(1) and n.toFixed(0) in Node. Made by tools/parity/make-c1-fixtures.mjs; spawnloft-lib js.rs must agree.', numbers),
  'c1-library.json': doc('exposure.mjs, cleanJvmFlags, dataFormatWarning, log-timeline.mjs (in America/New_York and in UTC) and the activity reader in Node. Made by tools/parity/make-c1-fixtures.mjs; the matching spawnloft-lib modules must agree.', library()),
})
export function made() {
  return Object.fromEntries(Object.entries(files()).map(([k, v]) => [k, JSON.stringify(v, null, 2) + '\n']))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, text] of Object.entries(made())) fs.writeFileSync(path.join(out, name), text)
}
