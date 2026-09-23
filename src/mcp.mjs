import readline from 'node:readline'
import { UserError } from './util.mjs'

/**
 * SpawnLoft as an MCP server: `spawnloft mcp`, spoken over stdio by an AI client the person
 * chose and configured themselves. Hand-written rather than the official SDK so the core stays
 * free of dependencies - a tools-only server is a small, stable corner of the protocol.
 *
 * <p>Dual-era, because the protocol changed shape in 2026-07-28 and clients will take a while
 * to follow. A modern request carries its protocol version in `_meta` and is served on its own
 * (no session); an `initialize` request selects the older handshake-based revisions. Nothing
 * here keeps per-client state either way - the only difference between the two is the shape of
 * a result.
 *
 * <p>Nothing opens a port. stdout carries protocol messages and nothing else; the caller
 * points console output at stderr before any tool runs.
 */

export const MODERN_VERSIONS = ['2026-07-28']
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const META = 'io.modelcontextprotocol/'

const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const PARSE_ERROR = -32700
const INTERNAL_ERROR = -32603
const UNSUPPORTED_VERSION = -32022

class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

/**
 * The protocol, without a transport: `handle(message)` takes one parsed JSON-RPC message and
 * resolves to the reply (or null), sending progress through `notify` while it works.
 *
 * <p>`tools` is a list of `{ name, title, description, inputSchema, annotations, run }`, where
 * `run(args, ctx)` returns `{ text, data }` or throws. `scrub` sees every string that leaves.
 */
export function createServer({ info, instructions, tools, notify = () => {}, scrub = (s) => s }) {
  const byName = new Map(tools.map((t) => [t.name, t]))
  // Only a request still in flight can be cancelled; ids are reused once answered.
  const inflight = new Set()
  const cancelled = new Set()
  const capabilities = { tools: { listChanged: false } }
  const listing = tools.map(({ name, title, description, inputSchema, annotations }) =>
    ({ name, title, description, inputSchema, annotations }))

  function reply(id, result, modern) {
    if (cancelled.delete(id)) return null
    const body = modern ? { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: info } } : result
    return { jsonrpc: '2.0', id, result: body }
  }

  async function callTool(params, meta) {
    const tool = byName.get(params?.name)
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params?.name}`)
    const args = params.arguments ?? {}
    const problem = validate(tool.inputSchema, args)
    if (problem) return toolError(`Invalid arguments for ${tool.name}: ${problem}`)

    let step = 0
    const token = meta?.progressToken
    const progress = token === undefined ? () => {} : (message) => {
      notify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, message: scrub(message) } })
    }
    try {
      const { text, data } = await tool.run(args, { progress })
      const safe = scrubDeep(data, scrub)
      const body = { content: [{ type: 'text', text: scrub(text ?? JSON.stringify(safe)) }] }
      if (safe !== undefined) body.structuredContent = safe
      if (tool.failed?.(data)) body.isError = true
      return body
    } catch (err) {
      // A person's mistake and a crash both go back as tool errors the model can read and act on;
      // neither carries a stack trace out of the process.
      const message = err instanceof UserError ? err.message : `${tool.name} failed: ${err?.message ?? err}`
      return toolError(scrub(message))
    }
  }

  async function dispatch(method, params, modern) {
    switch (method) {
      case 'ping':
        return {}
      case 'server/discover':
        return { supportedVersions: [...MODERN_VERSIONS], capabilities, instructions }
      case 'tools/list':
        return { tools: listing }
      case 'tools/call':
        return callTool(params, params?._meta)
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  async function handle(message) {
    if (Array.isArray(message) || message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return error(null, INVALID_REQUEST, 'Invalid request: one JSON-RPC 2.0 object per line')
    }
    const { id, method, params } = message
    if (typeof method !== 'string') return null // a response to a request this server never sends
    if (id === undefined) {
      if (method === 'notifications/cancelled' && inflight.has(params?.requestId)) cancelled.add(params.requestId)
      return null
    }
    if (id === null || !['string', 'number'].includes(typeof id)) return error(null, INVALID_REQUEST, 'Invalid request id')

    inflight.add(id)
    try {
      return await answer(id, method, params)
    } finally {
      inflight.delete(id)
      cancelled.delete(id)
    }
  }

  async function answer(id, method, params) {
    try {
      if (method === 'initialize') {
        const asked = params?.protocolVersion
        return reply(id, {
          protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
          capabilities, serverInfo: info, instructions,
        }, false)
      }
      const meta = params?._meta ?? {}
      const version = meta[`${META}protocolVersion`]
      // No version in _meta is a client on the handshake revisions, after its initialize.
      // Served the same way even without one: there is no session here for it to be missing from.
      if (version === undefined || LEGACY_VERSIONS.includes(version)) return reply(id, await dispatch(method, params, false), false)
      if (!MODERN_VERSIONS.includes(version)) {
        throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version',
          { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: version })
      }
      if (typeof meta[`${META}clientCapabilities`] !== 'object' || meta[`${META}clientCapabilities`] === null) {
        throw new RpcError(INVALID_PARAMS, `Missing _meta["${META}clientCapabilities"]`)
      }
      return reply(id, await dispatch(method, params, true), true)
    } catch (err) {
      if (cancelled.delete(id)) return null
      if (err instanceof RpcError) return error(id, err.code, err.message, err.data)
      return error(id, INTERNAL_ERROR, scrub(String(err?.message ?? err)))
    }
  }

  return { handle }
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function error(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function scrubDeep(value, scrub) {
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub))
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString()
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, scrub)]))
  }
  return value
}

/**
 * Just enough JSON Schema for the schemas in this server: an object of primitive properties with
 * `required`, `enum`, integer bounds and no extras. Anything richer belongs in a real validator,
 * and a tool that needs one should say so rather than have this quietly accept it.
 */
export function validate(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object'
  const props = schema.properties ?? {}
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `"${key}" is required`
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key]
    if (!spec) {
      if (schema.additionalProperties === false) return `unknown argument "${key}"`
      continue
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) return `"${key}" must be a whole number`
    if (spec.type === 'string' && typeof value !== 'string') return `"${key}" must be a string`
    if (spec.type === 'boolean' && typeof value !== 'boolean') return `"${key}" must be true or false`
    if (spec.enum && !spec.enum.includes(value)) return `"${key}" must be one of: ${spec.enum.join(', ')}`
    if (spec.minimum !== undefined && value < spec.minimum) return `"${key}" must be at least ${spec.minimum}`
    if (spec.maximum !== undefined && value > spec.maximum) return `"${key}" must be at most ${spec.maximum}`
    if (spec.minLength !== undefined && value.length < spec.minLength) return `"${key}" must not be empty`
  }
  return null
}

/**
 * Serve over this process's stdin and stdout until stdin closes. Console output from anything
 * underneath is sent to stderr first: one stray line on stdout would corrupt the stream.
 */
export function serveStdio(options, { input = process.stdin, output = process.stdout } = {}) {
  for (const level of ['log', 'info', 'warn', 'debug']) {
    console[level] = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`)
  }
  const send = (message) => { if (message) output.write(`${JSON.stringify(message)}\n`) }
  const server = createServer({ ...options, notify: send })
  const pending = new Set()
  const lines = readline.createInterface({ input, crlfDelay: Infinity })

  lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      send(error(null, PARSE_ERROR, 'Parse error'))
      return
    }
    // Requests run side by side: a server that takes a minute to start must not hold up a status
    // check behind it.
    const job = server.handle(message).then(send, (err) => process.stderr.write(`mcp: ${err?.stack ?? err}\n`))
    pending.add(job)
    job.finally(() => pending.delete(job))
  })
  return new Promise((resolve) => {
    // Closing stdin is how a client says it is done. Work already under way - a snapshot half
    // written, a start waiting for ready - is let finish, since each leaves the server in a state
    // someone will want described; a client that cannot wait kills the process instead.
    lines.on('close', async () => {
      await Promise.allSettled([...pending])
      resolve()
    })
  })
}
