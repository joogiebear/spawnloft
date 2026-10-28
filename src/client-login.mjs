import crypto from 'node:crypto'

import { startBrowserLogin, finishBrowserLogin, upsertAccount, updateAccounts, publicAccount } from './client-auth.mjs'
import { getDefaultAccount, setDefaultAccount } from './client.mjs'
import { UserError } from './util.mjs'

// The panel's side of the launcher's Microsoft sign-in (CLIENT.md, "Signing in from the
// launcher"). One record at a time, held in this process's memory only: the PKCE verifier, the
// `state` the callback is looked up by, and who is listening. No token is ever kept here; the
// outcome goes to accounts.json and to the listening stream as a name and a uuid.
//
// Lifetimes: a record nobody listens to is dropped after ORPHAN_MS (the launcher opens its
// stream before it opens Microsoft's page, so a live sign-in always has a listener); every record
// is dropped EXPIRY_MS after it was made. A new sign-in replaces an orphaned one and is refused
// (409) while the old one's stream is still open. The callback consumes the state at the first
// request and answers at once; the token exchange and the Xbox chain run afterwards, and only the
// stream hears how they ended, so a replayed callback is a 400 from that moment on.

export const ORPHAN_MS = 10_000
export const EXPIRY_MS = 10 * 60 * 1000

const defaults = {
  fetchImpl: (...args) => fetch(...args),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
  log: () => {},
}
const hooks = { ...defaults }

// The seam the tests use: a scripted fetch and a clock they control. The hooks apply to records
// made after the call.
export function setLoginHooks(patch) {
  Object.assign(hooks, patch)
}

export function resetLoginHooks() {
  Object.assign(hooks, defaults)
}

export class LoginInProgress extends UserError {}

const records = new Map()

function drop(record, event) {
  if (!records.has(record.id)) return
  records.delete(record.id)
  hooks.clearTimer(record.orphanTimer)
  hooks.clearTimer(record.expiryTimer)
  if (event) emit(record, event)
  record.listeners.clear()
}

function emit(record, event) {
  record.last = event
  for (const send of record.listeners) {
    try { send(event) } catch { /* a stream that went away */ }
  }
}

function armOrphanTimer(record) {
  hooks.clearTimer(record.orphanTimer)
  record.orphanTimer = hooks.setTimer(() => {
    if (record.listeners.size === 0) drop(record, null)
  }, ORPHAN_MS)
}

function liveRecord() {
  for (const r of records.values()) return r
  return null
}

// Starts a sign-in. `redirectUri` is the panel's own callback with its bound port. Throws
// LoginInProgress while another sign-in still has a listener (the launcher shows "a sign-in is
// already open in another window"); replaces one nobody listens to.
export function startLogin({ redirectUri }) {
  const old = liveRecord()
  if (old) {
    if (old.listeners.size > 0 && !old.finished) throw new LoginInProgress('a sign-in is already open in another window; finish or cancel it first')
    drop(old, { status: 'failed', message: 'another sign-in was started' })
  }
  const { state, verifier, authorizeUrl } = startBrowserLogin({ redirectUri })
  const record = {
    id: crypto.randomBytes(16).toString('hex'),
    state,
    verifier,
    redirectUri,
    createdAt: hooks.now(),
    consumed: false,
    finished: false,
    listeners: new Set(),
    last: { status: 'pending' },
    orphanTimer: null,
    expiryTimer: null,
  }
  records.set(record.id, record)
  armOrphanTimer(record)
  record.expiryTimer = hooks.setTimer(() => drop(record, { status: 'failed', message: 'the sign-in took longer than 10 minutes; start it again' }), EXPIRY_MS)
  return { loginId: record.id, authorizeUrl }
}

// Attaches a listener; it hears the current status at once, then every change. Returns the
// detach function, or null when no such sign-in exists. The page opens this before it opens
// Microsoft's page, so the record always has a listener while the person is signing in.
export function listenLogin(loginId, send) {
  const record = records.get(loginId)
  if (!record) return null
  record.listeners.add(send)
  hooks.clearTimer(record.orphanTimer)
  send(record.last)
  return () => {
    record.listeners.delete(send)
    if (record.listeners.size === 0 && records.has(record.id)) armOrphanTimer(record)
  }
}

// The person closed Microsoft's window, or pressed Cancel.
export function cancelLogin(loginId) {
  const record = records.get(loginId)
  if (!record) return false
  drop(record, { status: 'cancelled', message: 'the sign-in was cancelled' })
  return true
}

function callbackError(query) {
  const error = String(query.get('error') ?? '')
  if (error === 'access_denied') return 'the sign-in was cancelled on Microsoft\'s page'
  const said = String(query.get('error_description') ?? '').split('\n')[0].slice(0, 200)
  return `Microsoft refused the sign-in: ${said || error}`
}

// Microsoft's redirect. `query` is the callback's URLSearchParams. Answers { ok: true } when the
// state named the live sign-in (the record is consumed right here, whatever happens next) and
// { ok: false } for anything else: unknown, reused or missing state, which leaves every record
// as it was. The exchange and the chain run after the answer; see finish().
export function handleCallback(query) {
  const state = query.get('state')
  if (typeof state !== 'string' || !state) return { ok: false }
  let record = null
  for (const r of records.values()) {
    if (!r.consumed && r.state.length === state.length && crypto.timingSafeEqual(Buffer.from(r.state), Buffer.from(state))) record = r
  }
  if (!record) return { ok: false }
  record.consumed = true
  if (query.has('error')) {
    drop(record, { status: 'failed', message: callbackError(query) })
    return { ok: true }
  }
  const code = query.get('code')
  finish(record, code).catch((err) => hooks.log(`sign-in chain: ${err?.stack ?? err}`))
  return { ok: true }
}

async function finish(record, code) {
  let account
  try {
    account = await finishBrowserLogin({ code, verifier: record.verifier, redirectUri: record.redirectUri, fetchImpl: hooks.fetchImpl, now: hooks.now })
  } catch (err) {
    const message = err instanceof UserError || err?.userFacing ? err.message : 'the sign-in failed inside SpawnLoft; see panel.log'
    if (!(err instanceof UserError)) hooks.log(`sign-in failed: ${err?.message ?? err}`)
    record.finished = true
    drop(record, { status: 'failed', message })
    return
  }
  // Cancelled or expired while Microsoft was slow: the stream has already said so, and the
  // person pressed Cancel, so the account is not kept.
  if (!records.has(record.id)) {
    hooks.log('sign-in finished after it was cancelled; the account was not saved')
    return
  }
  // The write rule: re-read, upsert this one account by uuid (a sign-in during the chain in
  // another process survives). The first signed-in account becomes the launcher's default. A
  // file that cannot be written (a drive with no permissions: saveAccounts is strict) is a
  // failure the stream hears about, not a record stuck in pending.
  try {
    updateAccounts((list) => upsertAccount(list, account))
    if (getDefaultAccount() === null) setDefaultAccount(account.uuid)
  } catch (err) {
    record.finished = true
    drop(record, { status: 'failed', message: err instanceof UserError ? err.message : 'the account could not be saved; see panel.log' })
    if (!(err instanceof UserError)) hooks.log(`sign-in: could not save the account: ${err?.message ?? err}`)
    return
  }
  hooks.log(`signed in ${account.name}`)
  record.finished = true
  drop(record, { status: 'done', account: publicAccount(account) })
}

// For the tests: forget every record.
export function resetLogins() {
  for (const r of [...records.values()]) drop(r, null)
}

export function liveLoginCount() {
  return records.size
}
