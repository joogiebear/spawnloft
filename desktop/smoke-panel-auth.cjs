'use strict'

// Signs a smoke script's own requests in to the panel of the app it drives. The panel takes no
// request without a credential (src/panel-auth.mjs): a page has the window's session cookie, a
// script outside the page signs a short token with the install's key, as any program run by the
// same user can. `configDir` is the app's config folder (<APPDATA or XDG_CONFIG_HOME>/spawnloft).
//
//   fetch(url, { headers: { authorization: authorization(configDir, new URL(url).port) } })
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function authorization(configDir, port) {
  const key = Buffer.from(fs.readFileSync(path.join(configDir, 'panel.key'), 'utf8').trim(), 'base64url')
  const body = `v1.api.${Number(port)}.${Date.now()}.`
  return `SpawnLoft ${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`
}

// The panel proving itself to a caller that holds the key (what `spawnloft ui` asks before it
// calls something on a port "a SpawnLoft panel"): true when a signed request carrying a fresh
// nonce is answered with that nonce's signature.
async function provesItself(configDir, url) {
  const key = Buffer.from(fs.readFileSync(path.join(configDir, 'panel.key'), 'utf8').trim(), 'base64url')
  const nonce = crypto.randomBytes(16).toString('base64url')
  const res = await fetch(url, { headers: { authorization: authorization(configDir, new URL(url).port), 'x-spawnloft-probe': nonce } })
  const want = crypto.createHmac('sha256', key).update(`probe.v1.${nonce}`).digest('base64url')
  return res.status === 200 && res.headers.get('x-spawnloft-proof') === want
}

module.exports = { authorization, provesItself }
