import { UserError } from './util.mjs'

export class UsageError extends UserError {}

/** A versioned envelope is shared by snapshots, stream events, and errors. Ordinary
 * output never reaches a JSON stream. Command data is deliberately projected at each
 * call site rather than serializing registry records that contain credentials. */
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

export function instanceName(positional, command) {
  if (positional.length !== 1) throw new UsageError(`Usage: spawnloft ${command} <instance>`)
  return positional[0]
}
