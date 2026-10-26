import { test } from 'node:test'
import assert from 'node:assert/strict'
import { windowsPowerShellEnv } from '../desktop/windows-powershell.mjs'

test('Windows PowerShell is started without PowerShell 7 module paths, and everything else kept', () => {
  const env = windowsPowerShellEnv({ PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'x', Path: 'C:\\Windows', AZURE_TENANT_ID: 't' })
  assert.deepEqual(env, { Path: 'C:\\Windows', AZURE_TENANT_ID: 't' })
})
