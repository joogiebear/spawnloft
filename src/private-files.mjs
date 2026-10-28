import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Files that hold secrets (RCON and database passwords, Microsoft refresh tokens, harness
// tokens, mclo.gs deletion tokens) are kept readable by this user alone.
//
// On POSIX that is mode 0600. Windows ignores the mode: a new file inherits its folder's ACL,
// and a data root off the system drive (S:\...) usually inherits "Authenticated Users: Modify,
// Users: Read", so every account on the machine could read the file. There the file gets an
// explicit ACL instead: inheritance removed and one entry for the current user, set with icacls
// (shipped with every Windows since Vista, called by its System32 path so a same-named program in
// the current folder is never run). The argument list goes to CreateProcess as is, with no
// shell, so a path cannot smuggle options in.
//
// `hooks` is the seam the tests use to act as Windows on any platform.

export const PRIVATE_MODE = 0o600

const defaults = {
  platform: process.platform,
  exec: (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 }),
  userInfo: () => os.userInfo(),
  env: () => process.env,
}
const hooks = { ...defaults }

export function setPrivateFileHooks(patch) {
  Object.assign(hooks, patch)
  principal = undefined
}

export function resetPrivateFileHooks() {
  Object.assign(hooks, defaults)
  principal = undefined
}

export function privateFilesPlatform() {
  return hooks.platform
}

function system32(exe) {
  return path.win32.join(hooks.env().SystemRoot || 'C:\\Windows', 'System32', exe)
}

// The current user, as icacls names a principal. The SID (written *S-1-...) is preferred: it
// needs no name lookup and survives a renamed account. DOMAIN\user is the fallback when whoami
// is missing or says something unexpected. Looked up once per process.
let principal
export function currentPrincipal() {
  if (principal !== undefined) return principal
  principal = null
  const res = hooks.exec(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'])
  if (!res.error && res.status === 0) {
    // "DESKTOP\josh","S-1-5-21-...-1001"
    const text = String(res.stdout).trim()
    const m = /"(S-1-[0-9-]+)"\s*$/.exec(text)
    if (m) principal = { sid: m[1], grant: `*${m[1]}`, name: /^"([^"]*)"/.exec(text)?.[1] ?? null }
  }
  if (!principal) {
    let user = null
    try { user = hooks.userInfo().username } catch { /* no account name available */ }
    const domain = hooks.env().USERDOMAIN
    if (user && /^[^"\\/:*?<>|]+$/.test(user)) {
      const name = domain ? `${domain}\\${user}` : user
      principal = { sid: null, grant: name, name }
    }
  }
  return principal
}

function icacls(args) {
  const res = hooks.exec(system32('icacls.exe'), args)
  if (res.error) return { ok: false, reason: `icacls could not run (${res.error.message})` }
  if (res.status !== 0) return { ok: false, reason: `icacls failed: ${oneLine(res.stderr || res.stdout)}` }
  return { ok: true, stdout: String(res.stdout ?? '') }
}

// Makes `file` readable and writable by this user only. Never throws for a permission tool that
// is missing or refuses (a FAT drive has no permissions to set): the caller decides whether that
// is fatal. Returns { ok: true } or { ok: false, reason }.
export function protectPrivateFile(file, { mode = PRIVATE_MODE } = {}) {
  if (hooks.platform !== 'win32') {
    try {
      fs.chmodSync(file, mode)
      return { ok: true }
    } catch (err) {
      return { ok: false, reason: err.message }
    }
  }
  // a mode that is not owner-only asks for no ACL
  if ((mode & 0o077) !== 0) return { ok: true }
  const who = currentPrincipal()
  if (!who) return { ok: false, reason: 'could not find out which Windows account is running SpawnLoft' }
  const res = icacls([path.resolve(file), '/inheritance:r', '/grant:r', `${who.grant}:F`])
  return res.ok ? { ok: true } : res
}

// Creates `file` with `mode`, protects it, and only then writes the data into it, so the secret
// is never on disk under the folder's permissions, not even for the moment before icacls runs.
// Returns protectPrivateFile's answer.
export function writePrivateFile(file, data, mode = PRIVATE_MODE) {
  if (hooks.platform === 'win32' && (mode & 0o077) === 0) {
    fs.writeFileSync(file, '', { mode })
    const protection = protectPrivateFile(file, { mode })
    fs.writeFileSync(file, data)
    return protection
  }
  fs.writeFileSync(file, data, { mode })
  return protectPrivateFile(file, { mode })
}

function oneLine(text) {
  return String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' ').slice(0, 300) || 'no output'
}

// Principals that may stand on a private file besides the user: SYSTEM and Administrators are
// the equivalents of root (an administrator can take ownership of anything anyway). Known by
// their SIDs, which icacls prints as *S-... when it cannot resolve them, and by their English
// names; a localized Windows prints other names, which are then reported (the repair removes
// them along with everyone else, which costs an administrator nothing).
const ROOT_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544'])
const ROOT_NAMES = /^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$/i

function allowedPrincipal(name) {
  if (name.startsWith('*')) {
    const sid = name.slice(1)
    if (ROOT_SIDS.has(sid)) return true
    const who = currentPrincipal()
    return Boolean(who?.sid && who.sid === sid)
  }
  if (ROOT_NAMES.test(name)) return true
  const who = currentPrincipal()
  return Boolean(who?.name && who.name.toLowerCase() === name.toLowerCase())
}

// icacls lists one access entry per line: the first line starts with the path as it was given,
// the rest are indented; a trailing "Successfully processed..." line has no ":(". Entries read
// "principal:(flags)(perms)", and "(I)" among the flags marks one inherited from the folder.
export function parseIcacls(stdout, file) {
  const entries = []
  const wanted = [...new Set([String(file), path.resolve(file)])].map((s) => s.toLowerCase())
  for (const raw of String(stdout).split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) continue
    const want = wanted.find((w) => line.toLowerCase().startsWith(w))
    if (want) line = line.slice(want.length).trim()
    const at = line.lastIndexOf(':(')
    if (at <= 0 || !line.endsWith(')')) continue
    const flags = line.slice(at + 1)
    entries.push({ principal: line.slice(0, at).trim(), inherited: /\(I\)/.test(flags), flags })
  }
  return entries
}

// Says whether `file` is readable by this user alone. { ok: true }, { ok: false, reason,
// leftovers }, or { missing: true }. On Windows every entry has to be the user's own, SYSTEM's or
// Administrators', and not inherited from the folder; `leftovers` names the explicit entries a
// repair has to remove on top of resetting inheritance.
export function inspectPrivateFile(file) {
  if (!fs.existsSync(file)) return { missing: true }
  if (hooks.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777
    if (mode & 0o077) return { ok: false, reason: `its permissions are ${mode.toString(8)}, not 600` }
    return { ok: true }
  }
  const res = icacls([path.resolve(file)])
  if (!res.ok) return res
  const entries = parseIcacls(res.stdout, file)
  const inherited = entries.filter((e) => e.inherited)
  const others = entries.filter((e) => !e.inherited && !allowedPrincipal(e.principal))
  if (!inherited.length && !others.length) return { ok: true }
  const reasons = []
  if (inherited.length) reasons.push(`it inherits its folder's permissions (${inherited.map((e) => e.principal).join(', ')})`)
  if (others.length) reasons.push(`${others.map((e) => e.principal).join(', ')} can open it`)
  return { ok: false, reason: reasons.join(' and '), leftovers: others.map((e) => e.principal) }
}

// Makes an existing file owner-only and checks the result: the inheritance reset leaves explicit
// entries for other accounts in place, so those are removed one by one.
export function repairPrivateFile(file) {
  const first = protectPrivateFile(file)
  if (!first.ok) return first
  if (hooks.platform !== 'win32') return { ok: true }
  const after = inspectPrivateFile(file)
  if (after.ok) return { ok: true }
  for (const who of after.leftovers ?? []) {
    const removed = icacls([path.resolve(file), '/remove', who])
    if (!removed.ok) return removed
  }
  const last = inspectPrivateFile(file)
  return last.ok ? { ok: true } : { ok: false, reason: `after the repair ${last.reason}` }
}

// The doctor's pass over the files that hold secrets. Only files that exist are checked; with
// `repair` a file others could read is made owner-only, without it the problem says how.
export function checkPrivateFiles(files, { repair = false } = {}) {
  const problems = []
  const notes = []
  for (const { file, what } of files) {
    const state = inspectPrivateFile(file)
    if (state.missing || state.ok) continue
    if (repair) {
      const fixed = repairPrivateFile(file)
      if (fixed.ok) {
        notes.push(`${what}: made owner-only (${state.reason})`)
        continue
      }
      problems.push(`${what}: other users on this computer can read ${file} (${state.reason}) and it could not be made owner-only: ${fixed.reason}`)
      continue
    }
    problems.push(`${what}: other users on this computer can read ${file} (${state.reason}); run doctor without --json to make it owner-only`)
  }
  return { problems, notes }
}
