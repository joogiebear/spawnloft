#!/usr/bin/env node
// Stable packages are collected and verified together before publication.
import { spawnSync } from 'node:child_process'
if (process.argv.includes('--unsigned')) throw new Error('Stable releases must be signed')
const result = spawnSync('npx', ['electron-builder', '--config', 'stable.config.cjs', '--publish', 'never'], {
  cwd: new URL('.', import.meta.url), stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32',
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
