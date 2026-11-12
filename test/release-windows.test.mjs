// The signed pre-beta Windows build on the signing machine (rust/SIGNING-WINDOWS.md): what can be
// checked without Windows, Azure or a signing module.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, signingSettings, gateArgs, OPENJS_CN } from '../rust/crates/spawnloft-shell/installer/release-windows.mjs'
import { signCommand } from '../rust/crates/spawnloft-shell/installer/sign-command.mjs'
import { parseSigned } from '../desktop/release-gate.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('only a 2.x beta version is built, and a public key comes only with its key', () => {
  assert.equal(parseArgs(['--version', '2.0.0-beta.3']).version, '2.0.0-beta.3')
  for (const v of ['2.0.0', '1.6.0-beta.9', '2.0.0-internal.4', '2.0.0-beta']) assert.throws(() => parseArgs(['--version', v]), /not a 2\.x beta/)
  assert.throws(() => parseArgs([]), /--version is required/)
  assert.equal(parseArgs(['--version', '2.0.0-beta.1', '--key', 'k']).pubkey, undefined)
  assert.throws(() => parseArgs(['--version', '2.0.0-beta.1', '--pubkey', 'p']), /pass both/)
  assert.throws(() => parseArgs(['--version', '2.0.0-beta.1', '--publish']), /unknown argument --publish/)
})

test('the signing account is the one 1.x stables are signed with', () => {
  const s = signingSettings(JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8')))
  assert.equal(s.SPAWNLOFT_SIGN_PUBLISHER, 'victor zemeckis')
  assert.equal(s.SPAWNLOFT_SIGN_ACCOUNT, 'Mcctl')
  assert.equal(s.SPAWNLOFT_SIGN_PROFILE, 'MCCTL')
  assert.match(s.SPAWNLOFT_SIGN_ENDPOINT, /^https:\/\/[a-z]+\.codesigning\.azure\.net\/$/)
  // the script's own defaults agree, for a run by hand
  const ps1 = fs.readFileSync(path.join(root, 'rust/crates/spawnloft-shell/installer/sign-windows.ps1'), 'utf8')
  for (const value of Object.values(s)) assert.ok(ps1.includes(`'${value}'`), `sign-windows.ps1 defaults to ${value}`)
  assert.throws(() => signingSettings({}), /azureSignOptions/)
})

test('the gate is asked for the publisher on the setup, the shell and the core, and OpenJS on node.exe', () => {
  const args = gateArgs({ out: 'O', version: '2.0.0-beta.1', pubkey: 'P', publisher: 'victor zemeckis', shellExe: 'S.exe', coreExe: 'C.exe', nodeExe: 'N\\node.exe', runtime: 'R', payload: 'Y' })
  assert.deepEqual(args.slice(args.indexOf('--authenticode-cn'), args.indexOf('--authenticode-cn') + 2), ['--authenticode-cn', 'victor zemeckis'])
  const signed = args.flatMap((a, i) => (a === '--signed' ? [parseSigned(args[i + 1])] : []))
  assert.deepEqual(signed, [{ file: 'S.exe', cn: null }, { file: 'C.exe', cn: null }, { file: 'N\\node.exe', cn: OPENJS_CN }])
  assert.ok(args.includes('--check-binary-versions'))
})

test('--signed splits the file from the signer', () => {
  assert.deepEqual(parseSigned('C:\\a=b\\node.exe=OpenJS Foundation'), { file: 'C:\\a=b\\node.exe', cn: 'OpenJS Foundation' })
  assert.deepEqual(parseSigned('x.DLL'), { file: 'x.DLL', cn: null })
  assert.throws(() => parseSigned('setup.msi'), /--signed takes/)
})

test('the bundler runs the signing script once per file, through Windows PowerShell', () => {
  const c = signCommand('C:\\repo\\sign-windows.ps1')
  assert.equal(c.cmd, 'powershell.exe')
  assert.deepEqual(c.args.slice(-3), ['-File', 'C:\\repo\\sign-windows.ps1', '%1'])
  assert.throws(() => signCommand('C:\\100%\\s.ps1'), /cannot hold/)
})

test('nothing in the signed build path publishes', () => {
  const text = fs.readFileSync(path.join(root, 'rust/crates/spawnloft-shell/installer/release-windows.mjs'), 'utf8')
  assert.doesNotMatch(text, /release-publish\.mjs|\bgh release\b|'release', 'create'|--confirm/)
})
