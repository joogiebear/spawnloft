// The child make-c3-fixtures.mjs runs with the data root in its environment (paths.mjs reads it
// when first imported): builds the server folder, runs the operations and prints the answers.
import fs from 'node:fs'
import path from 'node:path'

const [casesFile, root] = process.argv.slice(2)
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'))
const data = path.join(root, 'data')
const dir = path.join(data, 'instances', 'srv')
for (const f of cases.tree) {
  const full = path.join(dir, ...f.path.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : f.text)
}
const inst = { name: 'srv', dir, ...cases.instance }
fs.writeFileSync(path.join(data, 'instances.json'), JSON.stringify({ version: 1, instances: { srv: { dir, ...cases.instance } } }))

const files = await import('../../src/files.mjs')
const cf = await import('../../src/config-files.mjs')
const backup = await import('../../src/backup.mjs')
const { Readable } = await import('node:stream')

// the answer as the Rust tests compare it: the scratch root, stamps and times evened out
function even(v) {
  const text = JSON.stringify(v ?? null)
    .split(JSON.stringify(root).slice(1, -1)).join('<root>')
    .replace(/\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?/g, '<stamp>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
  return JSON.parse(text)
}
const failure = (err) => ({ error: even(err.message), code: err.code ?? null })

let lastSnapshot = null
const keep = (r) => {
  if (r && typeof r === 'object' && typeof r.snapshot === 'string') lastSnapshot = r.snapshot
  return r
}
const stat = ({ rel, stat }) => ({ rel, exists: !!stat })

const OPS = {
  resolvePath: (rel, o) => stat(files.resolvePath(inst, rel, o)),
  listDir: (rel, o) => files.listDir(inst, rel, o ?? {}),
  readFile: (rel) => files.readFile(inst, rel),
  readTail: (rel, o) => files.readTail(inst, rel, o),
  imageFile: async (rel) => { const r = await files.imageFile(inst, rel); return { size: r.size, type: r.type } },
  imageKind: (hex) => files.imageKind(Buffer.from(hex, 'hex')),
  writeFile: (rel, o) => files.writeFile(inst, rel, o),
  writeFileFresh: async (rel, o) => {
    const { version } = await files.readFile(inst, rel)
    return files.writeFile(inst, rel, { ...o, version })
  },
  makeFolder: (parent, name) => files.makeFolder(inst, parent, name),
  uploadFile: (parent, name, body, o) => files.uploadFile(inst, parent, name, Readable.from([Buffer.from(body)]), o),
  sameButForCase: (a, b, names) => files.sameButForCase(a, b, names),
  movePath: (from, to, o) => files.movePath(inst, from, to, o),
  deletePaths: (paths, o) => files.deletePaths(inst, paths, o),
  undoLast: () => files.undoSnapshot(inst, lastSnapshot, {}),
  archivePaths: async (paths, name) => { const r = await files.archivePaths(inst, paths, name); return { path: r.path, sized: r.size > 0 } },
  extractArchive: (rel, o) => files.extractArchive(inst, rel, o),
  searchNames: (rel, q, o) => files.searchNames(inst, rel, q, o),
  backupStandard: async () => { const r = await backup.createSnapshot(inst, { scope: 'standard', flush: false, quiet: true }); lastSnapshot = path.basename(r.file); return { made: true } },
  downloadable: async (rel) => {
    const r = await files.downloadable(inst, rel)
    const res = { name: r.name, sized: r.size > 0, temp: r.file !== path.join(dir, ...String(rel).split('/')) }
    r.done()
    return res
  },
  resolveConfigPath: (rel, o) => { const r = cf.resolveConfigPath(inst, rel, o); return { shown: r.shown, exists: r.exists } },
  listConfigFiles: (folder) => cf.listConfigFiles(inst, folder),
  readConfigFile: (rel) => cf.readConfigFile(inst, rel),
  planConfigWrite: (rel, o) => { const p = cf.planConfigWrite(inst, rel, o); return { shown: p.shown, existed: p.existed, before: p.before, after: p.after } },
  applyPlan: (rel, o) => { const p = cf.planConfigWrite(inst, rel, o); cf.applyConfigWrite(p); return { written: fs.readFileSync(p.full, 'utf8') } },
  unchangedSince: (rel, o) => {
    const p = cf.planConfigWrite(inst, rel, o)
    const first = cf.unchangedSince(p)
    fs.appendFileSync(p.full, '# touched\n')
    return { first, after: cf.unchangedSince(p) }
  },
}

const ops = []
for (const { op, args } of cases.ops) {
  try {
    ops.push({ result: even(keep(await OPS[op](...args))) })
  } catch (err) {
    ops.push(failure(err))
  }
}
const PURE = {
  redactConfig: (t) => cf.redactConfig(t),
  checkFormat: (s, t) => { cf.checkFormat(s, t); return 'ok' },
  summarizeChange: (a, b, n) => cf.summarizeChange(a, b, n),
  restoreHidden: (a, b) => cf.restoreHidden(a, b),
  extname: (p) => path.extname(p),
}
const pure = []
for (const { op, args } of cases.pure) {
  try {
    pure.push({ result: even(PURE[op](...args)) })
  } catch (err) {
    pure.push(failure(err))
  }
}
// the activity the operations recorded, in order
const activity = fs.readFileSync(path.join(data, 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => even(JSON.parse(l)))
process.stdout.write(JSON.stringify({ ops, pure, activity }))
