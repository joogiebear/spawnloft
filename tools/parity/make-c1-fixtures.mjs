// Writes C1's behaviour fixtures from the Node modules, which are the reference:
//   node tools/parity/make-c1-fixtures.mjs
// test/fixtures/contracts/diagnose.json: diagnose() over console lines in three contexts (the
//   terminal with a server's details, the panel, none), read by spawnloft-lib's diagnose.rs tests.
// test/fixtures/contracts/js-patterns.json: run-time patterns (`logs --grep`, case-insensitive)
//   against subject lines, read by jsregex.rs's tests. Patterns the Rust core refuses on purpose
//   (lookaround, backreferences: the declared difference runtime-pattern-syntax) are not here.
// test/fixtures/contracts/js-numbers.json: Number(text), String(number) and toFixed, read by js.rs.
// Change the cases here, never the expectations by hand. test/c1-fixtures.test.mjs fails when a
// file no longer matches what this script makes.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnose } from '../../src/diagnose.mjs'

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
]
const SUBJECTS = [
  '[10:00:01] [Server thread/INFO]: Starting', '[10:00:02] [Server thread/WARN]: Can\'t keep up!', 'x WARN] y', 'java.lang.Error',
  'abc', 'a\rc', 'a{', 'aa', 'x]', 'a', 'a-b', 'A', '\n', ' ', '\u00a0', '\ufeff', '\u0085', 'color', 'colour', 'ababz', 'yz', 'ab', '',
  'é', 'É', 'server.jar', 'b', 'd', '/', '-', '\u0000', '\n', '\t', '\b', 'aab', 'aaab', 'a{,2}', 'k', '8', '3-x', 'TRUE', 'ſ', 'K',
  'S', 's', '\u212a', '\u0663', 'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu', 'AAAA', '&', 'a--b', '😀',
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

const doc = (about, data) => ({ about, ...data })
const files = {
  'diagnose.json': doc('diagnose() from src/diagnose.mjs over console lines in three contexts. Made by tools/parity/make-c1-fixtures.mjs; spawnloft-lib diagnose.rs must agree on every case.', { contexts: CONTEXTS, cases }),
  'js-patterns.json': doc('new RegExp(source, "i").test(subject) in Node for the run-time pattern sites (logs --grep). Made by tools/parity/make-c1-fixtures.mjs; spawnloft-lib jsregex.rs must agree, and must refuse exactly the patterns marked invalid.', { subjects: SUBJECTS, patterns }),
  'js-numbers.json': doc('Number(text), String(n), n.toFixed(1) and n.toFixed(0) in Node. Made by tools/parity/make-c1-fixtures.mjs; spawnloft-lib js.rs must agree.', numbers),
}
export function made() {
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v, null, 2) + '\n']))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, text] of Object.entries(made())) fs.writeFileSync(path.join(out, name), text)
}
