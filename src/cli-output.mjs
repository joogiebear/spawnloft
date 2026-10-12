import { UserError } from './util.mjs'

export class UsageError extends UserError {}

// Shared by snapshots, stream events and errors. Callers project the data themselves
// because registry records contain credentials.
export function envelope(command, data, { error = null, type } = {}) {
  return { schemaVersion: 1, command, ok: error === null, ...(type ? { type } : {}),
    ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) }
}

export function jsonLine(command, data, options) {
  return JSON.stringify(envelope(command, data, options)) + '\n'
}

export function checkFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key)) throw new UsageError(`Unknown option --${key}`)
  }
}

export function keepCount(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError('--keep must be a positive whole number')
  }
  return Number(value)
}

export function instanceName(positional, command) {
  if (positional.length !== 1) throw new UsageError(`Usage: spawnloft ${command} <instance>`)
  return positional[0]
}
