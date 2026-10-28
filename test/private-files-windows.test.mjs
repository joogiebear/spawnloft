import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-private-'))
process.env.MCCTL_DATA_ROOT = path.join(scratch, 'data')
after(() => fs.rmSync(scratch, { recursive: true, force: true }))

const { setPrivateFileHooks, resetPrivateFileHooks, currentPrincipal, protectPrivateFile, inspectPrivateFile, parseIcacls, checkPrivateFiles, repairPrivateFile } = await import('../src/private-files.mjs')
const { applyConfigWrite } = await import('../src/config-files.mjs')
const { redactIdentities, MICROSOFT_PLACEHOLDER } = await import('../src/diag-bundle.mjs')
const { writeJson, writeFileWithMode, readJson, PRIVATE_FILE_MODE, UserError } = await import('../src/util.mjs')
const { saveAccounts, loadAccounts, microsoftIdentities } = await import('../src/client-auth.mjs')
const { ACCOUNTS_FILE } = await import('../src/client-paths.mjs')

afterEach(() => resetPrivateFileHooks())

const WHOAMI = '"DESKTOP-ABC\\josh","S-1-5-21-1111-2222-3333-1001"\r\n'
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: undefined })

// Acts as Windows: records every icacls call (by tool name), answers whoami with a fixed SID.
// Both tools are run from System32 by their full path, never found through PATH or the cwd.
function fakeWindows({ icacls = () => ok(), whoami = () => ok(WHOAMI) } = {}) {
  const calls = []
  setPrivateFileHooks({
    platform: 'win32',
    exec: (cmd, args) => {
      assert.ok(cmd.startsWith('D:\\Win\\System32\\'), 'tools are run from System32: ' + cmd)
      const tool = cmd.slice('D:\\Win\\System32\\'.length).replace(/\.exe$/, '')
      calls.push([tool, ...args])
      if (tool === 'whoami') return whoami(args)
      if (tool === 'icacls') return icacls(args)
      throw new Error('unexpected command ' + cmd)
    },
    userInfo: () => ({ username: 'josh' }),
    env: () => ({ USERDOMAIN: 'DESKTOP-ABC', SystemRoot: 'D:\\Win' }),
  })
  return calls
}

test('the principal is the SID whoami reports, looked up once', () => {
  const calls = fakeWindows()
  assert.deepEqual(currentPrincipal(), { sid: 'S-1-5-21-1111-2222-3333-1001', grant: '*S-1-5-21-1111-2222-3333-1001', name: 'DESKTOP-ABC\\josh' })
  currentPrincipal()
  assert.equal(calls.filter(([c]) => c === 'whoami').length, 1)
})

test('without whoami the principal is DOMAIN\\user', () => {
  fakeWindows({ whoami: () => ({ error: new Error('ENOENT'), status: null, stdout: '', stderr: '' }) })
  assert.deepEqual(currentPrincipal(), { sid: null, grant: 'DESKTOP-ABC\\josh', name: 'DESKTOP-ABC\\josh' })
})

test('on Windows a private file loses its inherited ACL and keeps one entry for the user, with no shell', () => {
  const calls = fakeWindows()
  const file = path.join(scratch, 'with space & (parens)', 'accounts.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{}')
  assert.deepEqual(protectPrivateFile(file), { ok: true })
  const icacls = calls.filter(([c]) => c === 'icacls')
  assert.equal(icacls.length, 1)
  assert.deepEqual(icacls[0], ['icacls', path.resolve(file), '/inheritance:r', '/grant:r', '*S-1-5-21-1111-2222-3333-1001:F'])
})

test('an icacls that refuses or is missing is reported, not thrown', () => {
  fakeWindows({ icacls: () => ({ status: 1, stdout: '', stderr: 'S:\\x: The request is not supported.\r\nSuccessfully processed 0 files; Failed processing 1 files\r\n' }) })
  const r1 = protectPrivateFile(path.join(scratch, 'nope.json'))
  assert.equal(r1.ok, false)
  assert.match(r1.reason, /icacls failed: S:\\x: The request is not supported\./)
  fakeWindows({ icacls: () => ({ error: new Error('spawnSync icacls ENOENT'), status: null, stdout: '', stderr: '' }) })
  const r2 = protectPrivateFile(path.join(scratch, 'nope.json'))
  assert.equal(r2.ok, false)
  assert.match(r2.reason, /icacls could not run/)
})

test('writeJson with a private mode protects the empty temp file before the data goes in and before the rename, so the secret is never there with wide permissions', () => {
  const file = path.join(scratch, 'state.json')
  const sizes = []
  const calls = fakeWindows({ icacls: (args) => { sizes.push(fs.statSync(args[0]).size); return ok() } })
  assert.deepEqual(writeJson(file, { a: 1 }, { mode: PRIVATE_FILE_MODE }), { ok: true })
  const icacls = calls.filter(([c]) => c === 'icacls')
  assert.equal(icacls.length, 1)
  assert.equal(icacls[0][1], path.resolve(`${file}.tmp`))
  assert.deepEqual(sizes, [0], 'the ACL is set while the file is still empty')
  assert.deepEqual(readJson(file), { a: 1 })
  // no mode: no ACL work
  writeJson(file, { a: 2 })
  assert.equal(calls.filter(([c]) => c === 'icacls').length, 1)
  // a mode that is not owner-only is not an ACL job either
  writeFileWithMode(path.join(scratch, 'wide.txt'), 'x', 0o644)
  assert.equal(calls.filter(([c]) => c === 'icacls').length, 1)
})

test('a strict write that cannot be protected is not made at all, and the temp file is gone', () => {
  fakeWindows({ icacls: () => ({ status: 1, stdout: '', stderr: 'The request is not supported.' }) })
  const file = path.join(scratch, 'strict.json')
  fs.writeFileSync(file, '{"old":true}')
  assert.throws(() => writeJson(file, { new: true }, { mode: PRIVATE_FILE_MODE, strict: true }), (err) => err instanceof UserError && /could not make .*strict\.json readable by you alone \(icacls failed: The request is not supported\.\), so it was not written/.test(err.message))
  assert.deepEqual(readJson(file), { old: true })
  assert.ok(!fs.existsSync(`${file}.tmp`))
  // the same write without strict goes through
  assert.equal(writeJson(file, { new: true }, { mode: PRIVATE_FILE_MODE }).ok, false)
  assert.deepEqual(readJson(file), { new: true })
})

test('the accounts file is a strict write', () => {
  fakeWindows({ icacls: () => ({ status: 5, stdout: '', stderr: 'Access is denied.' }) })
  assert.throws(() => saveAccounts([{ type: 'microsoft', name: 'Wunga_', uuid: 'u', refreshToken: 'r' }]), /accounts\.json readable by you alone/)
  assert.deepEqual(loadAccounts(), [])
  assert.ok(!fs.existsSync(ACCOUNTS_FILE))
  resetPrivateFileHooks()
  saveAccounts([{ type: 'microsoft', name: 'Wunga_', uuid: 'u', refreshToken: 'r' }])
  assert.equal(loadAccounts().length, 1)
  if (process.platform !== 'win32') assert.equal(fs.statSync(ACCOUNTS_FILE).mode & 0o777, 0o600)
  fs.rmSync(ACCOUNTS_FILE)
})

const LISTING = (file) => `${file} DESKTOP-ABC\\josh:(F)\r\n` +
  '                     NT AUTHORITY\\SYSTEM:(I)(F)\r\n' +
  '                     BUILTIN\\Administrators:(I)(F)\r\n' +
  '                     NT AUTHORITY\\Authenticated Users:(I)(M)\r\n' +
  '                     BUILTIN\\Users:(I)(RX)\r\n' +
  '\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n'

test('parseIcacls reads one entry per line and tells inherited ones apart', () => {
  const file = 'S:\\VMs\\client data\\accounts.json'
  const entries = parseIcacls(LISTING(file), file)
  assert.deepEqual(entries.map((e) => [e.principal, e.inherited]), [
    ['DESKTOP-ABC\\josh', false],
    ['NT AUTHORITY\\SYSTEM', true],
    ['BUILTIN\\Administrators', true],
    ['NT AUTHORITY\\Authenticated Users', true],
    ['BUILTIN\\Users', true],
  ])
})

test('inspectPrivateFile on Windows is an allowlist: the user, SYSTEM and Administrators, nothing inherited, nobody else', () => {
  const file = path.join(scratch, 'inspect.json')
  fs.writeFileSync(file, '{}')
  fakeWindows({ icacls: () => ok(LISTING(path.resolve(file))) })
  const bad = inspectPrivateFile(file)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /inherits its folder's permissions \(NT AUTHORITY\\SYSTEM, BUILTIN\\Administrators, NT AUTHORITY\\Authenticated Users, BUILTIN\\Users\)/)

  fakeWindows({ icacls: () => ok(`${path.resolve(file)} DESKTOP-ABC\\josh:(F)\r\n                 Everyone:(R)\r\n                 DESKTOP-ABC\\bob:(F)\r\n                 Jeder:(RX)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`) })
  const wide = inspectPrivateFile(file)
  assert.equal(wide.ok, false)
  assert.equal(wide.reason, 'Everyone, DESKTOP-ABC\\bob, Jeder can open it')
  assert.deepEqual(wide.leftovers, ['Everyone', 'DESKTOP-ABC\\bob', 'Jeder'])

  // SIDs icacls could not resolve: the user's own, SYSTEM and Administrators pass, another does not
  fakeWindows({ icacls: () => ok(`${path.resolve(file)} *S-1-5-21-1111-2222-3333-1001:(F)\r\n                 *S-1-5-18:(F)\r\n                 *S-1-5-32-544:(F)\r\n                 *S-1-5-21-1111-2222-3333-1002:(R)\r\n`) })
  const sids = inspectPrivateFile(file)
  assert.equal(sids.ok, false)
  assert.equal(sids.reason, '*S-1-5-21-1111-2222-3333-1002 can open it')
  // the user's name is compared without regard to case
  fakeWindows({ icacls: () => ok(`${path.resolve(file)} desktop-abc\\Josh:(F)\r\n`) })
  assert.deepEqual(inspectPrivateFile(file), { ok: true })

  fakeWindows({ icacls: () => ok(`${path.resolve(file)} DESKTOP-ABC\\josh:(F)\r\n                 NT AUTHORITY\\SYSTEM:(F)\r\n                 BUILTIN\\Administrators:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`) })
  assert.deepEqual(inspectPrivateFile(file), { ok: true })
  assert.deepEqual(inspectPrivateFile(path.join(scratch, 'missing.json')), { missing: true })
})

test('on POSIX the check is the mode, and repair is a chmod', { skip: process.platform === 'win32' }, () => {
  const file = path.join(scratch, 'posix.json')
  fs.writeFileSync(file, '{}', { mode: 0o644 })
  fs.chmodSync(file, 0o644)
  assert.deepEqual(inspectPrivateFile(file), { ok: false, reason: 'its permissions are 644, not 600' })
  const report = checkPrivateFiles([{ file, what: 'registry' }, { file: path.join(scratch, 'none.json'), what: 'nothing' }])
  assert.deepEqual(report.notes, [])
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0], /^registry: other users on this computer can read .*posix\.json \(its permissions are 644, not 600\); run doctor without --json to make it owner-only$/)
  const fixed = checkPrivateFiles([{ file, what: 'registry' }], { repair: true })
  assert.deepEqual(fixed.problems, [])
  assert.match(fixed.notes[0], /^registry: made owner-only/)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(checkPrivateFiles([{ file, what: 'registry' }]), { problems: [], notes: [] })
})

test('repair removes the explicit entries that an inheritance reset leaves behind', () => {
  const file = path.join(scratch, 'leftover.json')
  fs.writeFileSync(file, '{}')
  let reset = false
  const removed = []
  const calls = fakeWindows({
    icacls: (args) => {
      if (args.length === 1) {
        const lines = [`${path.resolve(file)} DESKTOP-ABC\\josh:(F)`]
        if (!reset) lines.push('   BUILTIN\\Users:(I)(RX)')
        for (const who of ['DESKTOP-ABC\\bob', 'Power Users']) if (!removed.includes(who)) lines.push(`   ${who}:(F)`)
        return ok(lines.join('\r\n') + '\r\n')
      }
      if (args[1] === '/remove') { removed.push(args[2]); return ok() }
      reset = true
      return ok()
    },
  })
  assert.deepEqual(repairPrivateFile(file), { ok: true })
  assert.deepEqual(removed, ['DESKTOP-ABC\\bob', 'Power Users'])
  assert.deepEqual(calls.filter(([c, , opt]) => c === 'icacls' && opt === '/remove').map((c) => c.slice(1)), [[path.resolve(file), '/remove', 'DESKTOP-ABC\\bob'], [path.resolve(file), '/remove', 'Power Users']])

  // a leftover that will not go is reported, not claimed fixed
  fakeWindows({ icacls: (args) => (args.length === 1 ? ok(`${path.resolve(file)} DESKTOP-ABC\\josh:(F)\r\n   Everyone:(F)\r\n`) : ok()) })
  const stuck = repairPrivateFile(file)
  assert.equal(stuck.ok, false)
  assert.match(stuck.reason, /^after the repair Everyone can open it$/)
})

test('on Windows repair runs icacls, and a repair that fails says so', () => {
  const file = path.join(scratch, 'repair.json')
  fs.writeFileSync(file, '{}')
  let fixed = false
  const calls = fakeWindows({
    icacls: (args) => {
      if (args.length === 1) return ok(fixed ? `${path.resolve(file)} DESKTOP-ABC\\josh:(F)\r\n` : LISTING(path.resolve(file)))
      fixed = true
      return ok()
    },
  })
  const report = checkPrivateFiles([{ file, what: 'accounts file' }], { repair: true })
  assert.deepEqual(report.problems, [])
  assert.match(report.notes[0], /^accounts file: made owner-only \(it inherits/)
  assert.ok(calls.some(([c, , opt]) => c === 'icacls' && opt === '/inheritance:r'))
  assert.deepEqual(checkPrivateFiles([{ file, what: 'accounts file' }]), { problems: [], notes: [] })

  fakeWindows({ icacls: (args) => (args.length === 1 ? ok(LISTING(path.resolve(file))) : { status: 1, stdout: '', stderr: 'Access is denied.' }) })
  const failed = checkPrivateFiles([{ file, what: 'accounts file' }], { repair: true })
  assert.equal(failed.problems.length, 1)
  assert.match(failed.problems[0], /could not be made owner-only: icacls failed: Access is denied\./)
})

test('parseIcacls takes the principal from the last ":(" and copes with a first line whose path is not the one given', () => {
  const file = 'S:\\VMs\\client data\\accounts.json'
  const entries = parseIcacls(`S:\\VMs\\CLIENT~1\\accounts.json DESKTOP-ABC\\josh:(F)\r\n   NT AUTHORITY\\Authenticated Users:(I)(M)\r\n   weird:(name):(OI)(CI)(F)\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`, file)
  assert.deepEqual(entries.map((e) => [e.principal, e.inherited]), [
    ['S:\\VMs\\CLIENT~1\\accounts.json DESKTOP-ABC\\josh', false],
    ['NT AUTHORITY\\Authenticated Users', true],
    ['weird:(name)', false],
  ])
})

test('server.properties edited through the config writer stays owner-only; other files are written as before', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(scratch, 'inst')
  fs.mkdirSync(dir, { recursive: true })
  const props = path.join(dir, 'server.properties')
  fs.writeFileSync(props, 'rcon.password=old\n', { mode: 0o644 })
  fs.chmodSync(props, 0o644)
  applyConfigWrite({ full: props, before: 'rcon.password=old\n', after: 'rcon.password=new\n' })
  assert.equal(fs.readFileSync(props, 'utf8'), 'rcon.password=new\n')
  assert.equal(fs.statSync(props).mode & 0o777, 0o600)
  const other = path.join(dir, 'bukkit.yml')
  applyConfigWrite({ full: other, before: null, after: 'a: 1\n' })
  assert.equal(fs.readFileSync(other, 'utf8'), 'a: 1\n')
  assert.notEqual(fs.statSync(other).mode & 0o077, 0, 'not forced private')
})

test('redactIdentities replaces whole names and uuids only, escapes regex characters and ignores case', () => {
  const hide = redactIdentities(['Steve', 'a.b+c', '069a79f4-44e9-4726-a5be-fca90e38aaf5', '069a79f444e94726a5befca90e38aaf5', 'ab'])
  assert.equal(hide('Steve joined; steve left; Steve_ and Steve2 and xSteve stay; a.b+c and aXbYc; 069a79f4-44e9-4726-a5be-fca90e38aaf5 069a79f444e94726a5befca90e38aaf5 ab'),
    `${MICROSOFT_PLACEHOLDER} joined; ${MICROSOFT_PLACEHOLDER} left; Steve_ and Steve2 and xSteve stay; ${MICROSOFT_PLACEHOLDER} and aXbYc; ${MICROSOFT_PLACEHOLDER} ${MICROSOFT_PLACEHOLDER} ab`)
  assert.equal(redactIdentities([])('Steve'), 'Steve')
})

test('microsoftIdentities lists names and both uuid forms of Microsoft accounts only, and nothing too short to be one', () => {
  assert.deepEqual(microsoftIdentities([
    { type: 'microsoft', name: 'Wunga_', uuid: '990308b3-1111-2222-3333-444444444444' },
    { type: 'microsoft', name: 'ab', uuid: 'short' },
    { type: 'offline', name: 'Bob', uuid: '00000000-0000-0000-0000-000000000000' },
    null,
  ]), ['Wunga_', '990308b3-1111-2222-3333-444444444444', '990308b3111122223333444444444444'])
})
