import crypto from 'node:crypto'

import { ACCOUNTS_FILE } from './client-paths.mjs'
import { fail, readJson, writeJson, PRIVATE_FILE_MODE, sleep } from './util.mjs'

export function offlineUuid(name) {
  const bytes = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function assertPlayerName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    fail(`player name "${name}" must be 3 to 16 letters, digits or underscores`)
  }
  return name
}

// A profile name may be shorter, longer or hold a dash; the player name derived from it must
// still pass the server's rule.
export function defaultPlayerName(profileName) {
  const base = String(profileName).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16)
  return base.length >= 3 ? base : (base + '___').slice(0, 3)
}

export function offlineAccount(name) {
  assertPlayerName(name)
  return { type: 'offline', name, uuid: offlineUuid(name), accessToken: '0', userType: 'legacy', xuid: '', clientId: '' }
}

export const MSA_CLIENT_ID = process.env.SPAWNLOFT_MSA_CLIENT_ID ?? '946097b5-241d-4f83-9981-c6d0778e5507'
export const SCOPES = 'XboxLive.signin offline_access'
export const DEVICECODE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode'
export const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
export const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
export const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
export const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
export const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

// A proxy or an outage answers with HTML; the status then carries the message, not the body.
async function bodyOf(res) {
  try { return await res.json() ?? {} } catch { return {} }
}

function dashUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function minecraftFromMicrosoft(accessToken, refreshToken, { fetchImpl, now }) {
  const xblBody = JSON.stringify({
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + accessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })
  const xblRes = await fetchImpl(XBL_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: xblBody })
  if (!xblRes.ok) fail(`Xbox Live sign-in failed (HTTP ${xblRes.status})`)
  const xbl = await bodyOf(xblRes)
  const uhs = xbl.DisplayClaims?.xui?.[0]?.uhs
  if (!xbl.Token || !uhs) fail('Xbox Live answered without a token; try again in a minute')

  const xstsBody = JSON.stringify({
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })
  const xstsRes = await fetchImpl(XSTS_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: xstsBody })
  if (!xstsRes.ok) {
    const errJson = await bodyOf(xstsRes)
    if (xstsRes.status === 401 && errJson.XErr) {
      const xerr = errJson.XErr
      if (xerr === 2148916233) fail('this Microsoft account has no Xbox profile; create one at https://www.xbox.com and sign in again')
      if (xerr === 2148916238) fail('this is a child account; an adult in the Microsoft family must allow it to play before it can sign in')
      if (xerr === 2148916235) fail('Xbox Live is not available in this account\'s country')
      fail(`Xbox Live refused the sign-in (XErr ${xerr})`)
    }
    fail(`Xbox Live sign-in failed (HTTP ${xstsRes.status})`)
  }
  const xsts = await bodyOf(xstsRes)
  if (!xsts.Token) fail('Xbox Live answered without a token; try again in a minute')
  const xid = xsts.DisplayClaims?.xui?.[0]?.xid ?? ''

  const mcBody = JSON.stringify({ identityToken: 'XBL3.0 x=' + uhs + ';' + xsts.Token })
  const mcRes = await fetchImpl(MC_LOGIN_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: mcBody })
  if (!mcRes.ok) {
    if (mcRes.status === 403) fail(`Microsoft has not yet approved this build of SpawnLoft for Minecraft sign-in (client id ${MSA_CLIENT_ID}); offline profiles still work`)
    fail(`Minecraft sign-in failed (HTTP ${mcRes.status})`)
  }
  const mc = await bodyOf(mcRes)
  if (!mc.access_token) fail('Minecraft answered without a token; try again in a minute')

  const profRes = await fetchImpl(MC_PROFILE_URL, { method: 'GET', headers: { authorization: `Bearer ${mc.access_token}` } })
  if (!profRes.ok) {
    if (profRes.status === 404) fail('this Microsoft account owns no Minecraft: Java Edition; buy it at https://www.minecraft.net or sign in with another account')
    fail(`could not read the Minecraft profile (HTTP ${profRes.status})`)
  }
  const prof = await bodyOf(profRes)
  if (typeof prof.id !== 'string' || !/^[0-9a-f]{32}$/i.test(prof.id) || !prof.name) fail('Minecraft answered without a profile; try again in a minute')

  return {
    type: 'microsoft',
    name: prof.name,
    uuid: dashUuid(prof.id),
    accessToken: mc.access_token,
    expiresAt: new Date(now() + mc.expires_in * 1000).toISOString(),
    refreshToken,
    xuid: xid,
    userType: 'msa',
    clientId: MSA_CLIENT_ID,
  }
}

export async function deviceCodeLogin({ onCode, fetchImpl = fetch, sleepImpl = sleep, now = Date.now } = {}) {
  const dcBody = new URLSearchParams({ client_id: MSA_CLIENT_ID, scope: SCOPES }).toString()
  const dcRes = await fetchImpl(DEVICECODE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: dcBody })
  if (!dcRes.ok) fail(`Microsoft did not start the sign-in (HTTP ${dcRes.status}); try again in a minute`)
  const dc = await bodyOf(dcRes)
  if (!dc.device_code || !dc.user_code) fail('Microsoft did not start the sign-in; try again in a minute')
  onCode({ verificationUri: dc.verification_uri, userCode: dc.user_code, expiresIn: dc.expires_in })

  let interval = dc.interval ?? 5
  for (;;) {
    await sleepImpl(interval * 1000)
    const tBody = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: MSA_CLIENT_ID, device_code: dc.device_code }).toString()
    const tRes = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tBody })
    const t = await bodyOf(tRes)
    if (t.access_token) {
      return minecraftFromMicrosoft(t.access_token, t.refresh_token, { fetchImpl, now })
    }
    if (t.error === 'authorization_pending') continue
    if (t.error === 'slow_down') {
      interval += 5
      continue
    }
    if (t.error === 'expired_token') fail('the code expired before it was entered; run spawnloft client login again')
    if (t.error === 'authorization_declined') fail('the sign-in was declined on Microsoft\'s page')
    fail(`Microsoft refused the sign-in: ${t.error_description ?? t.error}`)
  }
}

export async function refreshAccount(account, { fetchImpl = fetch, now = Date.now } = {}) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: MSA_CLIENT_ID, refresh_token: account.refreshToken, scope: SCOPES }).toString()
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  const json = await bodyOf(res)
  if (!res.ok || !json.access_token) {
    fail(`the saved sign-in for ${account.name} no longer works; run spawnloft client login again`)
  }
  const refreshToken = json.refresh_token ?? account.refreshToken
  return minecraftFromMicrosoft(json.access_token, refreshToken, { fetchImpl, now })
}

export function loadAccounts() {
  return readJson(ACCOUNTS_FILE, null)?.accounts ?? []
}

export function saveAccounts(list) {
  writeJson(ACCOUNTS_FILE, { version: 1, accounts: list }, { mode: PRIVATE_FILE_MODE })
}

export async function accountFor(selector, { fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof selector !== 'string' || !selector) {
    fail('an account is "offline:<player name>" or the name of a signed-in Microsoft account')
  }
  if (selector.startsWith('offline:')) {
    return offlineAccount(selector.slice('offline:'.length))
  }
  const accounts = loadAccounts()
  const idx = accounts.findIndex((a) => a.name.toLowerCase() === selector.toLowerCase())
  if (idx === -1) {
    fail(`no Microsoft account named "${selector}" is signed in; spawnloft client login, or use offline:<player name>`)
  }
  const account = accounts[idx]
  if (Date.parse(account.expiresAt) - now() < 5 * 60 * 1000) {
    const refreshed = await refreshAccount(account, { fetchImpl, now })
    accounts[idx] = refreshed
    saveAccounts(accounts)
    return refreshed
  }
  return account
}
