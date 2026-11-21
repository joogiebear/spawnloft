// The client-meta.mjs and client-version.mjs readings of every client fixture on 8 OS and arch
// pairs, as JSON, for comparing with the Rust dump (spawnloft-lib client/library.rs, test
// meta_dump): node tools/parity/client-meta-dump.mjs > node.json, then
// META_DUMP=rust.json cargo test -p spawnloft-lib meta_dump -- --ignored, and compare the two.
import fs from 'node:fs'
import * as m from '../../src/client-meta.mjs'
import * as cv from '../../src/client-version.mjs'
const dir = new URL('../../test/fixtures/client/', import.meta.url).pathname
const files = [...fs.readdirSync(dir + 'versions').map(f => 'versions/' + f), '1.21.11.json', 'future.json', 'fabric-profile.json']
const oses = [['linux','x64','6.8.0-45-generic'],['linux','arm64','6.8.0'],['windows','x64','10.0.22631'],['windows','x64','10.0.17000'],['windows','arm64','10.0.22631'],['windows','x86','10.0.19045'],['osx','arm64','24.1.0'],['osx','x64','23.0.0']]
const out = []
const tryit = (f) => { try { return f() } catch (e) { return { error: String(e.message) } } }
for (const f of files) {
  let v = JSON.parse(fs.readFileSync(dir + f, 'utf8'))
  if (f === 'fabric-profile.json') v = m.mergeInherited(v, JSON.parse(fs.readFileSync(dir + 'versions/1.21.11.json', 'utf8')))
  for (const [name, arch, version] of oses) {
    const os = { name, arch, version }
    out.push({ f, os, libs: tryit(() => m.libraries(v, { os }).map(r => [r.name, r.path, r.url, r.sha1, r.size, r.native === false ? null : r.native.extract.exclude])),
      cp: tryit(() => m.classpathRows(m.libraries(v, { os })).map(r => r.path)),
      arch: tryit(() => { const d = m.archDecision(v, os, null); return [d.refusal, d.arch, d.emulated] }),
      archE: tryit(() => { const d = m.archDecision(v, os, { x64: true }); return [d.refusal, d.arch, d.emulated] }),
      archN: tryit(() => { const d = m.archDecision(v, os, { x64: false }); return [d.refusal, d.arch, d.emulated] }),
      game: tryit(() => m.gameArguments(v, { os, features: { has_custom_resolution: true } })),
      jvm: tryit(() => m.jvmArguments(v, { os })),
      sub: tryit(() => m.nativesLibrarySubdir(v, { os })), extra: tryit(() => m.nativesExtraDirs(v, { os })),
      res: tryit(() => { const r = cv.resolveVersion(v, { os, hostCaps: { x64: true }, features: cv.launchFeatures({ hasServer: true }) }); return [r.problems, r.java, r.os, r.emulated, r.variables, r.natives.stamp, r.natives.dir, r.format, r.type, r.clientJar, cv.resolvedRefusal(r)] }),
      problems: tryit(() => (v.libraries ?? []).flatMap(l => m.ruleProblems(l.rules, { os }))),
    })
  }
  out.push({ f, log: tryit(() => m.loggingConfig(v)), nolookups: tryit(() => m.log4jNoLookupsNeeded(v)), ai: tryit(() => m.assetIndex(v)) })
}
for (const a of fs.readdirSync(dir + 'assets')) {
  const idx = JSON.parse(fs.readFileSync(dir + 'assets/' + a, 'utf8'))
  out.push({ a, layout: m.assetLayout(idx), objs: tryit(() => m.assetObjects(idx).map(r => [r.hash, r.size, r.path, r.url])) })
}
console.log(JSON.stringify(out))
