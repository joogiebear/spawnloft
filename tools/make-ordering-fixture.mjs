// Writes test/fixtures/contracts/ordering.json and ordering-pairs.json: the order Node's
// localeCompare gives, as data, for rust/crates/spawnloft-lib/src/collate.rs (cargo test) and for
// test/contracts-files.test.mjs, which checks that this Node still sorts the same way (an ICU
// update or a machine locale that moves a character is caught there). Run it again only on purpose,
// and say in the commit that the order changed, because the Rust side must follow.
//
//   node tools/make-ordering-fixture.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'contracts')

// how the source calls it (see "sites" below); the variant names are collate.rs's functions
export const VARIANTS = {
  default: undefined,
  base: { sensitivity: 'base' },
  numericBase: { numeric: true, sensitivity: 'base' },
}
const cmp = (variant) => (a, b) => (VARIANTS[variant] ? a.localeCompare(b, undefined, VARIANTS[variant]) : a.localeCompare(b))

// What the lists hold. Server names are letters, digits, - and _ (validateName); the rest is
// what shows up in plugin, jar, file, world and player names.
const NAMES = [
  'survival', 'Survival', 'SURVIVAL', 'survival-2', 'survival_2', 'survival2', 'survival-10', 'survival-9',
  'a', 'A', 'b', 'B', 'z', 'Z', 'zz', 'aa', 'aA', 'Aa', 'AA', 'ab', 'aB', 'Ab', 'AB',
  'a1', 'a-1', 'a_1', 'a-b', 'a_b', 'a--b', 'a__b', 'a-_b', 'a_-b', 'a-B', 'A-b',
  '-', '_', '--', '__', '-a', '_a', 'a-', 'a_',
  '0', '1', '9', '10', '01', '007', 'mc1', 'mc01', 'mc-01', 'mc_1', 'mc10', 'mc2', 'MC2',
  'lobby', 'Lobby-1', 'lobby_1', 'creative', 'Creative_old', 'x-ray', 'xray', 'x_ray', 'XRay',
  'hub', 'hub-eu', 'hub_eu', 'hubEU', 'hub2', 'skyblock', 'SkyBlock', 'sky-block', 'test_server-1',
]
const FILES = [
  'plugin.jar', 'plugin-1.9.jar', 'plugin-1.10.jar', 'plugin-1.9.4.jar', 'Plugin 2.jar', 'plugin (1).jar',
  'plugin(2).jar', 'plugin+extra.jar', 'plugin_v2.jar', 'Plugin.jar', 'plugin.jar.disabled',
  'paper-1.21.4-232.jar', 'paper-1.21.10-1.jar', 'paper-1.21.4-99.jar', 'purpur-1.21.4-2400.jar',
  'world', 'world_nether', 'world_the_end', 'World', 'world 2', 'world2', 'world-2', 'world.old',
  '.hidden', '.mcctl-plugins.json', 'config', 'config.yml', 'Config.yml', 'server.properties',
  '1.9', '1.10', '1.9.4', 'v1.9', 'v1.10', 'README.md', 'readme.txt', '#notes', '~backup', '$money',
  'a.b', 'a b', 'a,b', 'a;b', 'a:b', 'a!b', 'a?b', "a'b", 'a"b', 'a[b]', 'a{b}', 'a@b', 'a*b', 'a/b',
  'a\\b', 'a&b', 'a#b', 'a%b', 'a`b', 'a^b', 'a+b', 'a<b', 'a=b', 'a>b', 'a|b', 'a~b', 'a$b', 'a(b)',
  ' leading space', 'trailing space ', 'two  spaces', 'Notch', 'notch', '_jeb_', 'Dinnerbone',
]

// the one call in the source that sorts versions by hand still ends in a localeCompare
// (mariadb.mjs byVersionDesc); recorded so every call site is accounted for
const SITES = [
  { site: 'src/registry.mjs listAll', sorts: 'servers and databases by name (list, the panel, MCP)', variant: 'default' },
  { site: 'src/client.mjs listProfiles', sorts: 'client profiles by name', variant: 'default' },
  { site: 'src/create.mjs listJars', sorts: 'jars in the jar library', variant: 'default' },
  { site: 'src/schedule.mjs list', sorts: 'scheduled tasks by server, then by task name', variant: 'default' },
  { site: 'src/config-files.mjs', sorts: 'config files of a server folder', variant: 'default' },
  { site: 'src/players.mjs', sorts: 'players by name, or uuid when there is no name', variant: 'default' },
  { site: 'src/worlds.mjs', sorts: 'worlds, the active one first, then by name', variant: 'default' },
  { site: 'src/mariadb.mjs byVersionDesc', sorts: 'MariaDB versions: numeric parts as numbers, other parts with localeCompare, newest first', variant: 'default' },
  { site: 'src/plugins.mjs', sorts: 'plugins and mods by name', variant: 'base' },
  { site: 'src/files.mjs', sorts: 'the file browser: folders first, then by name', variant: 'numericBase' },
]

// deterministic, so a rerun on the same Node writes the same file
// (mulberry32: 32-bit integer steps, which JavaScript numbers hold exactly)
let seed = 20261121
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (s) => s[Math.floor(rnd() * s.length)]
const PRINTABLE = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('')
const ALPHABETS = [PRINTABLE, 'abcABCxyzXYZ0123456789-_', 'abAB019.-_ ()+', 'aA0-_', '0123456789.a', 'aAbB']
function randomString() {
  const alphabet = pick(ALPHABETS)
  let s = ''
  for (let n = Math.floor(rnd() * 9); n > 0; n--) s += pick(alphabet)
  return s
}
// a near neighbour: one letter's case flipped, one character added or one taken away, which is
// where the case level and the length rule decide
function neighbour(s) {
  const chars = [...s]
  const k = Math.floor(rnd() * 3)
  if (k === 0 && chars.length) {
    const i = Math.floor(rnd() * chars.length)
    chars[i] = rnd() < 0.5 ? chars[i].toUpperCase() : chars[i].toLowerCase()
  } else if (k === 1) chars.splice(Math.floor(rnd() * (chars.length + 1)), 0, pick(PRINTABLE))
  else if (chars.length) chars.splice(Math.floor(rnd() * chars.length), 1)
  return chars.join('')
}

const input = [...new Set([...NAMES, ...FILES])]
if (input.length !== NAMES.length + FILES.length) throw new Error('a string is listed twice')
const byDefault = [...input].sort(cmp('default'))
const orders = { default: byDefault }
// the others are a stable sort of the default order, so ties land where JavaScript puts them
for (const variant of ['base', 'numericBase']) orders[variant] = [...byDefault].sort(cmp(variant))

const about = {
  about: 'The order Node gives with String.prototype.localeCompare, which sorts every list the core shows. orders.default is the strings in Node\'s order for a.localeCompare(b) (no locale, so the machine\'s default; ICU root order for these characters in every locale CI runs); orders.base and orders.numericBase are a stable sort of orders.default with the options of sites[].variant. Made by tools/make-ordering-fixture.mjs; checked against this Node by test/contracts-files.test.mjs and against rust/crates/spawnloft-lib/src/collate.rs by cargo test. Random pairs with Node\'s answers are in ordering-pairs.json.',
  madeWith: { node: process.version, icu: process.versions.icu, locale: new Intl.Collator().resolvedOptions().locale },
  variants: VARIANTS,
  rules: [
    'Primary level first, over the whole string: space and punctuation in the order of punctuation below, then 0-9, then a-z with case ignored. A string that is a prefix of the other is smaller.',
    'Only if every primary weight is equal, case decides, left to right: lowercase before uppercase (ab < aB < Ab < AB; but a! > A, because ! is primary).',
    'sensitivity base stops after the primary level: a and A are equal, and the stable sort keeps them in input order.',
    'numeric reads a run of digits as one number, leading zeros ignored (01 equals 1, 1.9 < 1.10); a number sorts where a digit does.',
    'Characters outside printable ASCII: a declared difference. collate.rs sorts them after every ASCII letter by code point, primary level only.',
  ],
  punctuation: " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$",
  sites: SITES,
  orders,
}
fs.writeFileSync(path.join(dir, 'ordering.json'), JSON.stringify(about, null, 2) + '\n')

const PER_VARIANT = 1500
const pairs = {}
for (const variant of Object.keys(VARIANTS)) {
  const rows = []
  const seen = new Set()
  while (rows.length < PER_VARIANT) {
    const a = randomString()
    const b = rnd() < 0.5 ? neighbour(a) : randomString()
    const key = JSON.stringify([a, b])
    if (seen.has(key)) continue
    seen.add(key)
    rows.push([a, b, Math.sign(cmp(variant)(a, b))])
  }
  pairs[variant] = rows
}
// one pair per line keeps the file readable and its diffs small
const lines = Object.entries(pairs).map(([variant, rows]) =>
  `    ${JSON.stringify(variant)}: [\n${rows.map((r) => `      ${JSON.stringify(r)}`).join(',\n')}\n    ]`)
fs.writeFileSync(path.join(dir, 'ordering-pairs.json'), '{\n' +
  `  "about": ${JSON.stringify('Random pairs of printable-ASCII strings with the sign of a.localeCompare(b, undefined, options) for each variant of ordering.json, as this Node answered. Made by tools/make-ordering-fixture.mjs (seeded, so a rerun gives the same pairs); checked by test/contracts-files.test.mjs and by the collate tests under cargo test.')},\n` +
  `  "madeWith": ${JSON.stringify(about.madeWith)},\n` +
  `  "pairs": {\n${lines.join(',\n')}\n  }\n}\n`)
console.log(`wrote ordering.json (${input.length} strings) and ordering-pairs.json (${PER_VARIANT * Object.keys(VARIANTS).length} pairs)`)
