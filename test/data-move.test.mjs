import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveData, planMove, rollbackMove, finishMove, moveStatus, describeLink, removeLink, makeLink, journalPath } from '../src/data-move.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spawnloft-move-'))
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const T0 = new Date('2026-03-14T09:26:53.500Z')
const REGISTRY = JSON.stringify({ version: 1, instances: { Srv: { dir: 'PLACEHOLDER', jar: 'paper.jar' } } }, null, 2) + '\n'

let n = 0
/** A data folder with what one holds, and a place beside it to move it to. */
function world(name = `w${++n}`) {
  const base = path.join(scratch, name)
  const root = path.join(base, 'mcctl')
  const put = (rel, content, when) => {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    fs.utimesSync(file, when, when)
  }
  put('instances.json', REGISTRY, new Date(T0.getTime() + 1000))
  put('instances/Srv/server.properties', 'motd=hello\n', new Date(T0.getTime() + 2000))
  put('instances/Srv/world/region/r.0.0.mca', 'x'.repeat(4000), new Date(T0.getTime() + 3000))
  put('backups/Srv/old_2026-01-01.tar.gz', 'a'.repeat(200), new Date('2026-01-01T00:00:00Z'))
  put('backups/Srv/new_2026-02-01.tar.gz', 'b'.repeat(200), new Date('2026-02-01T00:00:00Z'))
  put('run/Srv/state.json', '{}', new Date(T0.getTime() + 4000))
  return { base, root, dest: path.join(base, 'moved', 'data') }
}

/** What is going on around a move, with a record of what was asked. */
function env({ running = [], locked = [], tasks = [], copies = [] } = {}) {
  const calls = []
  return {
    calls,
    running: () => running,
    heldLocks: () => locked,
    tasks: {
      list: async () => tasks,
      setEnabled: async (id, on) => { calls.push([id, on]) },
    },
    privateCopies: async () => copies,
    now: () => new Date('2026-10-02T12:00:00Z'),
  }
}

const move = (w, options = {}, around = {}) => moveData({ root: w.root, dest: w.dest, dryRun: false, env: env(around), ...options })
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8')
const listing = (dir) => fs.readdirSync(dir).sort()
const mtime = (...p) => fs.statSync(path.join(...p)).mtimeMs

// ---- planning: nothing is changed, and what stands in the way is said -----------------------

test('by default a move is only planned: nothing is created, moved or written', async () => {
  const w = world()
  const before = listing(w.base)
  const { plan, executed } = await moveData({ root: w.root, dest: w.dest, env: env() })
  assert.equal(executed, false)
  assert.equal(plan.ok, true, plan.problems.join('; '))
  assert.equal(plan.mode, 'rename')
  assert.equal(plan.stats.files, 6)
  assert.deepEqual(listing(w.base), before)
  assert.equal(fs.existsSync(w.dest), false)
  assert.equal(fs.existsSync(journalPath(w.root)), false)
})

test('a plan with problems is returned and nothing is done even when asked to', async () => {
  const w = world()
  fs.mkdirSync(w.dest, { recursive: true })
  fs.writeFileSync(path.join(w.dest, 'precious.txt'), 'mine')
  const { plan, executed } = await move(w)
  assert.equal(executed, false)
  assert.match(plan.problems.join('\n'), /not empty/)
  assert.equal(read(w.dest, 'precious.txt'), 'mine')
  assert.equal(describeLink(w.root).isLink, false)
})

test('it says what is wrong with the places given', async () => {
  const w = world()
  const problems = async (dest, root = w.root) => (await planMove({ root, dest, env: env() })).problems.join('\n')
  assert.match(await problems(w.root), /already/)
  assert.match(await problems(path.join(w.root, 'inside')), /inside the folder being moved/)
  assert.match(await problems(w.base), /inside .*which would have to be emptied/)
  assert.match(await problems(path.parse(w.base).root), /whole drive/)
  assert.match(await problems(w.dest, path.join(w.base, 'nothing-here')), /no data folder/)
  fs.writeFileSync(path.join(w.base, 'a-file'), 'x')
  assert.match(await problems(path.join(w.base, 'a-file')), /not a folder/)
})

test('it will not move a folder that is already a link, and says where the data is', async () => {
  const w = world()
  await move(w)
  const again = await planMove({ root: w.root, dest: path.join(w.base, 'elsewhere'), env: env() })
  assert.match(again.problems.join('\n'), /already a link/)
  assert.ok(again.problems.join('\n').includes('data status'))
})

test('servers and databases that are running stop it, by name', async () => {
  const w = world()
  const { plan, executed } = await move(w, {}, { running: ['Survival', 'Survival-db'] })
  assert.equal(executed, false)
  assert.match(plan.problems.join('\n'), /Survival, Survival-db are running; stop them first/)
  assert.equal(describeLink(w.root).isLink, false)
})

test('a start or a backup holding its lock stops it, though no server shows as running', async () => {
  const w = world()
  const { plan, executed } = await move(w, {}, { locked: ['Survival (being started)', 'Lobby (being backed up)'] })
  assert.equal(executed, false)
  assert.match(plan.problems.join('\n'), /Survival \(being started\), Lobby \(being backed up\) are in use right now; wait for them to finish/)
  assert.equal(describeLink(w.root).isLink, false)
})
test('an interrupted move recorded earlier stops a new one, and says how to put it back', async () => {
  const w = world()
  fs.writeFileSync(journalPath(w.root), JSON.stringify({ step: 'copying' }))
  const plan = await planMove({ root: w.root, dest: w.dest, env: env() })
  assert.match(plan.problems.join('\n'), /interrupted at "copying".*data rollback/)
})

test('a copy needs room, with some to spare', async (t) => {
  const w = world()
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 100, bsize: 1 }))
  const plan = await planMove({ root: w.root, dest: w.dest, forceCopy: true, env: env() })
  assert.match(plan.problems.join('\n'), /needs about .* free for the copy and has 100 B/)
  const rename = await planMove({ root: w.root, dest: w.dest, env: env() })
  assert.equal(rename.problems.some((p) => /free for the copy/.test(p)), false, 'a rename copies nothing, so needs no room')
})

test('scheduled tasks are said to be paused, and are listed to be', async () => {
  const w = world()
  const plan = await planMove({ root: w.root, dest: w.dest, env: env({ tasks: [{ id: 'a' }, { id: 'b' }] }) })
  assert.deepEqual(plan.pauseTasks, ['a', 'b'])
  assert.match(plan.warnings.join('\n'), /2 scheduled tasks will be paused/)
})

// ---- private copies ------------------------------------------------------------------------------

function privateCopy({ archives = 0, onlyInCopy = [], files = 0 } = {}) {
  const dir = path.join(scratch, `priv-${++n}`, 'Local', 'mcctl')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'activity.jsonl'), '{}\n')
  return { package: 'Acme.Client_1', dir, registry: { state: 'absent', onlyInCopy }, backups: { archives, bytes: archives * 100 }, instances: { files } }
}

test('a private copy that holds things found nowhere else stops the move', async () => {
  const w = world()
  for (const [what, copy] of [['backups', privateCopy({ archives: 3 })], ['servers', privateCopy({ onlyInCopy: ['Fresh'] })], ['files', privateCopy({ files: 5 })]]) {
    const { plan, executed } = await move(w, { setAsidePrivateCopies: true }, { copies: [copy] })
    assert.equal(executed, false, what)
    assert.match(plan.problems.join('\n'), /Moving the folder would hide them; run `spawnloft doctor`/, what)
    assert.equal(describeLink(w.root).isLink, false, what)
  }
  const one = await planMove({ root: w.root, dest: w.dest, env: env({ copies: [privateCopy({ onlyInCopy: ['Fresh'] })] }) })
  assert.match(one.problems.join('\n'), /1 server \(Fresh\) that exists only there/, 'the verb agrees with the count')
  const many = await planMove({ root: w.root, dest: w.dest, env: env({ copies: [privateCopy({ archives: 3 })] }) })
  assert.match(many.problems.join('\n'), /3 backups \(300 B\) that exist only there/)
})

test('a private copy that would only hide the link needs --set-aside-private-copies, and is then renamed, not deleted', async () => {
  const w = world()
  const copy = privateCopy()
  const without = await move(w, {}, { copies: [copy] })
  assert.equal(without.executed, false)
  assert.match(without.plan.problems.join('\n'), /--set-aside-private-copies to rename it \(nothing in it is deleted\)/)

  const done = await move(w, { setAsidePrivateCopies: true }, { copies: [copy] })
  assert.equal(done.executed, true)
  assert.equal(fs.existsSync(copy.dir), false)
  const aside = done.result.privateAside[0]
  assert.equal(aside.from, copy.dir)
  assert.equal(read(aside.to, 'activity.jsonl'), '{}\n', 'everything in it is still there')
})

test('a program installed as a package is warned about running the move from itself', async () => {
  const w = world()
  const plan = await planMove({ root: w.root, dest: w.dest, setAsidePrivateCopies: true, env: env({ copies: [privateCopy()] }) })
  assert.match(plan.warnings.join('\n'), /not from a program installed as a package/)
})

// ---- moving on the same drive: one rename ---------------------------------------------------------

test('a move on the same drive renames the folder, leaves a link, and everything reads the same through it', async () => {
  const w = world()
  const folderTime = mtime(w.root, 'instances')
  const { executed, result } = await move(w)
  assert.equal(executed, true)
  assert.equal(result.mode, 'rename')
  const link = describeLink(w.root)
  assert.equal(link.isLink, true)
  assert.equal(link.dangling, false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY, 'the old path still reads the registry')
  assert.equal(read(w.dest, 'instances.json'), REGISTRY)
  assert.equal(read(w.root, 'instances/Srv/server.properties'), 'motd=hello\n')
  fs.writeFileSync(path.join(w.root, 'written-after.txt'), 'through the link')
  assert.equal(read(w.dest, 'written-after.txt'), 'through the link', 'what is written at the old path lands in the new folder')
  assert.equal(mtime(w.dest, 'backups/Srv/old_2026-01-01.tar.gz'), new Date('2026-01-01T00:00:00Z').getTime(), 'times are untouched by a rename')
  assert.ok(Math.abs(mtime(w.dest, 'instances') - folderTime) < 5)
  assert.match(read(journalPath(w.root)), /"step": "done"/)
})

test('no probe file is left behind by the check of the link', async () => {
  const w = world()
  await move(w)
  assert.equal(listing(w.dest).some((f) => f.startsWith('.spawnloft-move-probe')), false)
})

test('a destination that is an empty folder is used, and put back as one if the move fails', async (t) => {
  const w = world()
  fs.mkdirSync(w.dest, { recursive: true })
  const real = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === path.resolve(w.root)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return real(from, to)
  })
  await assert.rejects(move(w, {}), /could not be renamed \(EBUSY\)/)
  t.mock.restoreAll()
  assert.ok(fs.statSync(w.dest).isDirectory(), 'the empty folder that was there is there again')
  assert.deepEqual(fs.readdirSync(w.dest), [])
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
})

test('scheduled tasks are paused for the move and switched back on, in that order', async () => {
  const w = world()
  const e = env({ tasks: [{ id: 'nightly' }, { id: 'restart' }] })
  await moveData({ root: w.root, dest: w.dest, dryRun: false, env: e })
  assert.deepEqual(e.calls, [['nightly', false], ['restart', false], ['nightly', true], ['restart', true]])
})

test('a folder held open is named for what it usually is, and nothing is changed', async (t) => {
  const w = world()
  const e = env({ tasks: [{ id: 'nightly' }] })
  const real = fs.renameSync
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(from) === path.resolve(w.root)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    return real(from, to)
  })
  await assert.rejects(moveData({ root: w.root, dest: w.dest, dryRun: false, env: e }), (err) => {
    assert.match(err.message, /the move did not complete and was undone/)
    assert.match(err.message, /Close the SpawnLoft app/)
    return true
  })
  t.mock.restoreAll()
  assert.deepEqual(e.calls, [['nightly', false], ['nightly', true]], 'the task is on again')
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(fs.existsSync(journalPath(w.root)), false, 'nothing left half-recorded')
  assert.equal(fs.existsSync(w.dest), false)
})

test('a link that cannot be made puts the folder back where it was', async (t) => {
  const w = world()
  t.mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) })
  await assert.rejects(move(w), /was undone/)
  t.mock.restoreAll()
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(read(w.root, 'backups/Srv/new_2026-02-01.tar.gz'), 'b'.repeat(200))
  assert.equal(fs.existsSync(w.dest), false)
  assert.equal(fs.existsSync(journalPath(w.root)), false)
})

test('a link that does not lead where it should is caught by the check and undone', async (t) => {
  const w = world()
  const real = fs.realpathSync
  t.mock.method(fs, 'realpathSync', (p, ...rest) => (path.resolve(p) === path.resolve(w.root) ? path.join(w.base, 'somewhere-else') : real(p, ...rest)))
  await assert.rejects(move(w), /does not lead to/)
  t.mock.restoreAll()
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
})

// ---- moving to another drive: copy, compare, park the original -----------------------------------

test('a move to another drive copies, compares, parks the original and links; nothing is deleted', async () => {
  const w = world()
  const { executed, result } = await move(w, { forceCopy: true })
  assert.equal(executed, true)
  assert.equal(result.mode, 'copy')
  assert.ok(result.parked.endsWith('.moved-2026-10-02T12-00-00-000Z'))
  assert.equal(describeLink(w.root).isLink, true)
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(read(result.parked, 'instances.json'), REGISTRY, 'the original is parked whole')
  const order = (dir) => fs.readdirSync(path.join(dir, 'backups/Srv')).sort((a, b) => mtime(dir, 'backups/Srv', b) - mtime(dir, 'backups/Srv', a))
  assert.deepEqual(order(w.dest), order(result.parked), 'backup history is in the same order')
  assert.ok(Math.abs(mtime(w.dest, 'instances.json') - (T0.getTime() + 1000)) < 2)
})

test('finish deletes the parked original and nothing else, and only once the move is done', async () => {
  const w = world()
  const { result } = await move(w, { forceCopy: true })
  const status = await moveStatus(w.root)
  assert.equal(status.leftovers.length, 1)
  assert.equal(status.leftovers[0].path, result.parked)
  assert.ok(status.leftovers[0].bytes > 4000)

  const finished = await finishMove(w.root)
  assert.equal(finished.parked, result.parked)
  assert.equal(fs.existsSync(result.parked), false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY, 'the data, through the link, is untouched')
  assert.equal(fs.existsSync(journalPath(w.root)), false)
  assert.equal((await moveStatus(w.root)).leftovers.length, 0)
})

test('a file that is locked fails the copy, names it, and leaves the original and no copy', async (t) => {
  const w = world()
  const real = fs.promises.copyFile
  t.mock.method(fs.promises, 'copyFile', async (from, to, mode) => {
    if (String(from).endsWith('r.0.0.mca')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    return real(from, to, mode)
  })
  await assert.rejects(move(w, { forceCopy: true }), (err) => {
    assert.match(err.message, /was undone/)
    assert.match(err.message, /1 file could not be copied/)
    assert.ok(err.message.includes('r.0.0.mca'))
    return true
  })
  t.mock.restoreAll()
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances/Srv/server.properties'), 'motd=hello\n')
  assert.equal(fs.existsSync(w.dest), false, 'the half copy is gone')
  assert.equal(fs.existsSync(journalPath(w.root)), false)
})

test('a copy that does not match is caught before the original is touched', async (t) => {
  const w = world()
  const real = fs.promises.copyFile
  t.mock.method(fs.promises, 'copyFile', async (from, to, mode) => {
    await real(from, to, mode)
    if (String(from).endsWith('server.properties')) fs.writeFileSync(to, 'motd=HELLO\n') // same size, damaged
  })
  await assert.rejects(move(w, { forceCopy: true }), /the copy does not match the original.*server\.properties \(contents differ\)|server\.properties: contents differ/s)
  t.mock.restoreAll()
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances/Srv/server.properties'), 'motd=hello\n')
  assert.equal(fs.existsSync(w.dest), false)
})

test('a link that cannot be made after the original is parked brings the original back', async (t) => {
  const w = world()
  t.mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
  await assert.rejects(move(w, { forceCopy: true }), /was undone/)
  t.mock.restoreAll()
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(fs.existsSync(w.dest), false)
  assert.deepEqual(listing(w.base).filter((f) => f.includes('.moved-')), [], 'no parked copy left over')
})

test('a destination that was an empty folder is emptied again, not removed, after a failed copy', async (t) => {
  const w = world()
  fs.mkdirSync(w.dest, { recursive: true })
  t.mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) })
  await assert.rejects(move(w, { forceCopy: true }), /was undone/)
  t.mock.restoreAll()
  assert.deepEqual(fs.readdirSync(w.dest), [])
})

// ---- putting an interrupted move back -------------------------------------------------------------

test('an interrupted rename is rolled back, even when a command has since made empty folders where the link was to go', async () => {
  const w = world()
  // The state a crash between the rename and the link leaves, and what `ensureDirs` then does.
  fs.mkdirSync(path.dirname(w.dest), { recursive: true })
  fs.renameSync(w.root, w.dest)
  for (const dir of ['instances', 'backups', 'run']) fs.mkdirSync(path.join(w.root, dir), { recursive: true })
  fs.writeFileSync(journalPath(w.root), JSON.stringify({ version: 1, from: w.root, to: w.dest, mode: 'rename', step: 'moving', destExisted: false, parked: null, pausedTasks: ['nightly'] }))
  const e = env()
  const { notes } = await rollbackMove(w.root, { env: e })
  assert.deepEqual(notes, [])
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(fs.existsSync(w.dest), false)
  assert.equal(fs.existsSync(journalPath(w.root)), false)
  assert.deepEqual(e.calls, [['nightly', true]], 'the task that was paused is switched back on')
})

test('an interrupted copy is rolled back: the copy goes, the original stays', async () => {
  const w = world()
  fs.mkdirSync(path.join(w.dest, 'instances'), { recursive: true })
  fs.writeFileSync(path.join(w.dest, 'instances.json'), 'half')
  fs.writeFileSync(journalPath(w.root), JSON.stringify({ version: 1, from: w.root, to: w.dest, mode: 'copy', step: 'copying', destExisted: false, parked: null, pausedTasks: [] }))
  await rollbackMove(w.root, { env: env() })
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(fs.existsSync(w.dest), false)
})

test('an interrupted move after the original was parked puts the original back and takes the link away', async () => {
  const w = world()
  const parked = `${w.root}.moved-x`
  fs.mkdirSync(path.dirname(w.dest), { recursive: true })
  fs.cpSync(w.root, w.dest, { recursive: true })
  fs.renameSync(w.root, parked)
  makeLink(w.dest, w.root)
  fs.writeFileSync(journalPath(w.root), JSON.stringify({ version: 1, from: w.root, to: w.dest, mode: 'copy', step: 'linked', destExisted: false, parked, pausedTasks: [] }))
  await rollbackMove(w.root, { env: env() })
  assert.equal(describeLink(w.root).isLink, false)
  assert.equal(read(w.root, 'instances.json'), REGISTRY)
  assert.equal(fs.existsSync(parked), false)
  assert.equal(fs.existsSync(w.dest), false)
})

test('a data folder that is simply empty is the data, and rolling back does not discard it', async () => {
  const base = path.join(scratch, `w${++n}`)
  const root = path.join(base, 'mcctl')
  const dest = path.join(base, 'moved')
  fs.mkdirSync(path.join(root, 'instances'), { recursive: true })
  fs.mkdirSync(path.join(dest, 'instances'), { recursive: true })
  fs.writeFileSync(path.join(dest, 'partial.bin'), 'x')
  fs.writeFileSync(journalPath(root), JSON.stringify({ version: 1, from: root, to: dest, mode: 'copy', step: 'copying', destExisted: false, parked: null, pausedTasks: [] }))
  await rollbackMove(root, { env: env() })
  assert.ok(fs.statSync(path.join(root, 'instances')).isDirectory(), 'the empty original is still there')
  assert.equal(fs.existsSync(dest), false)
})

test('the copy is never deleted unless the original is home: if the original is gone, the copy is all there is', async () => {
  const w = world()
  fs.mkdirSync(path.dirname(w.dest), { recursive: true })
  fs.cpSync(w.root, w.dest, { recursive: true })
  fs.rmSync(w.root, { recursive: true })
  // The parked original is missing too: someone cleaned it up, or it never got that far.
  fs.writeFileSync(journalPath(w.root), JSON.stringify({ version: 1, from: w.root, to: w.dest, mode: 'copy', step: 'linked', destExisted: false, parked: `${w.root}.moved-gone`, pausedTasks: [] }))
  const { notes } = await rollbackMove(w.root, { env: env() })
  assert.equal(read(w.dest, 'instances.json'), REGISTRY, 'the only copy of the data is still there')
  assert.match(notes.join('\n'), /could not be put back/)
  assert.equal(fs.existsSync(journalPath(w.root)), true, 'the record is kept, since this is not settled')
})

test('a move that finished cannot be rolled back: the data has been used since', async () => {
  const w = world()
  await move(w)
  await assert.rejects(rollbackMove(w.root, { env: env() }), /finished, and the data has been used since/)
  assert.equal(describeLink(w.root).isLink, true)
  await assert.rejects(rollbackMove(path.join(w.base, 'nowhere'), { env: env() }), /nothing to put back/)
})

test('finish refuses a move that is not done, and says to roll it back', async () => {
  const w = world()
  fs.writeFileSync(journalPath(w.root), JSON.stringify({ step: 'verifying' }))
  await assert.rejects(finishMove(w.root), /stopped at "verifying".*data rollback/)
})

// ---- links ----------------------------------------------------------------------------------------

test('removing a link removes the link and not what it leads to, and refuses anything that is not a link', () => {
  const target = path.join(scratch, `link-target-${++n}`)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'canary.txt'), 'safe')
  const at = path.join(scratch, `link-${n}`)
  makeLink(target, at)
  assert.equal(describeLink(at).isLink, true)
  removeLink(at)
  assert.equal(fs.existsSync(at), false)
  assert.equal(read(target, 'canary.txt'), 'safe')
  assert.throws(() => removeLink(target), /is not a link, so it was not removed/)
  assert.equal(read(target, 'canary.txt'), 'safe')
})

test('a link whose target is gone is described as dangling', () => {
  const target = path.join(scratch, `gone-${++n}`)
  fs.mkdirSync(target)
  const at = path.join(scratch, `dangling-${n}`)
  makeLink(target, at)
  fs.rmdirSync(target)
  assert.deepEqual({ ...describeLink(at), target: undefined }, { exists: true, isLink: true, target: undefined, dangling: true })
  removeLink(at)
})

test('status of a folder that is not a link says so and has no journal', async () => {
  const w = world()
  const status = await moveStatus(w.root)
  assert.equal(status.link.isLink, false)
  assert.equal(status.journal, null)
  assert.deepEqual(status.leftovers, [])
})
