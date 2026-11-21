// Writes test/fixtures/contracts/test-origins.json from src/test-origins.mjs: node tools/parity/make-test-origins-fixture.mjs > test/fixtures/contracts/test-origins.json
// Change the cases here, never the expectations by hand: the Node module is the reference.
import { parseOrigins, rewriteUrl } from '../../src/test-origins.mjs'
const maps = {
  paper: { 'https://fill.papermc.io': 'http://127.0.0.1:41234', 'https://fill-data.papermc.io': 'http://127.0.0.1:41235' },
  empty: {},
}
const urls = {
  paper: [
    'https://fill.papermc.io/v3/projects/paper',
    'https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds?channel=STABLE#top',
    'https://FILL.PaperMC.io/v3/x',
    'https://fill.papermc.io:443/v3/x',
    'https://fill.papermc.io',
    'https://fill.papermc.io?q=1',
    'https://fill.papermc.io#frag',
    'https://fill-data.papermc.io/v1/objects/abc/paper-1.21.4-15.jar',
    'http://fill.papermc.io/v3/x',
    'https://fill.papermc.io:8443/v3/x',
    'https://api.modrinth.com/v2/project/x',
    'https://user:pw@fill.papermc.io/v3/x',
    'http://127.0.0.1:8080/api/client/launcher',
    'http://localhost:1/x',
    'http://[::1]:2/x',
    'not a url',
  ],
  empty: ['https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 'http://127.0.0.1:5/ok'],
}
const badMaps = [
  'not json', '[]', '"x"',
  JSON.stringify({ 'https://fill.papermc.io/': 'http://127.0.0.1:1' }),
  JSON.stringify({ 'https://Fill.papermc.io': 'http://127.0.0.1:1' }),
  JSON.stringify({ 'https://fill.papermc.io:443': 'http://127.0.0.1:1' }),
  JSON.stringify({ 'https://fill.papermc.io': 'http://127.0.0.1:1/v3' }),
  JSON.stringify({ 'https://fill.papermc.io': 'http://example.com' }),
  JSON.stringify({ 'ftp://fill.papermc.io': 'http://127.0.0.1:1' }),
  JSON.stringify({ 'https://fill.papermc.io': 'ftp://127.0.0.1:1' }),
  JSON.stringify({ 'https://fill.papermc.io': 5 }),
]
const cases = []
for (const [name, m] of Object.entries(maps)) {
  const map = parseOrigins(JSON.stringify(m))
  for (const url of urls[name]) {
    let expect
    try { expect = rewriteUrl(url, map) } catch { expect = { refused: true } }
    cases.push({ map: name, url, expect })
  }
}
const out = {
  about: 'SPAWNLOFT_TEST_ORIGINS (rust/PLAN-CORE-PORT.md 6.2): the test-only map from a download origin to a local fake. Held by test/test-origins.test.mjs (src/test-origins.mjs) and by the test_origins tests under cargo test (spawnloft-lib, test-hooks). A map is a JSON object of canonical origins (lower-case scheme and host, no default port, nothing after the authority) to origins on this machine (127.0.0.1, localhost, [::1]); anything else makes the whole variable unusable and every request through it fails. A mapped origin keeps the text after its authority exactly; an unmapped loopback URL passes unchanged; any other URL is refused, never sent.',
  env: 'SPAWNLOFT_TEST_ORIGINS',
  honouredWhen: { node: 'NODE_ENV=test', rust: 'a build with the test-hooks feature' },
  maps,
  badMaps,
  cases,
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
for (const b of badMaps) if (!(parseOrigins(b) instanceof Error)) throw new Error('accepted ' + b)
