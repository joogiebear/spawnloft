import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchRetry } from '../src/download.mjs'

/** A fetch that gives the scripted answers in order, and records what it was asked. */
function scripted(answers) {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, init })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return new Response(next.body ?? '', { status: next.status })
  }
  return { fetcher, calls }
}
const quick = { delayMs: 1 }

test('a gateway timeout is asked again, and the answer that follows is the one returned', async () => {
  const { fetcher, calls } = scripted([{ status: 504 }, { status: 502 }, { status: 200, body: 'engine' }])
  const retries = []
  const res = await fetchRetry('https://example.invalid/a', {}, { ...quick, fetcher, onRetry: r => retries.push(r) })
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'engine')
  assert.equal(calls.length, 3)
  assert.deepEqual(retries, [{ attempt: 1, reason: 'HTTP 504' }, { attempt: 2, reason: 'HTTP 502' }])
})

test('a refusal that means something is returned at once', async () => {
  for (const status of [403, 404, 410]) {
    const { fetcher, calls } = scripted([{ status }, { status: 200 }])
    const res = await fetchRetry('https://example.invalid/a', {}, { ...quick, fetcher })
    assert.equal(res.status, status)
    assert.equal(calls.length, 1, `${status} was asked again`)
  }
})

test('when every attempt is transient the last answer comes back, so the caller can name its status', async () => {
  const { fetcher, calls } = scripted([{ status: 504 }, { status: 504 }, { status: 503 }])
  const res = await fetchRetry('https://example.invalid/a', {}, { ...quick, attempts: 3, fetcher })
  assert.equal(res.status, 503)
  assert.equal(calls.length, 3)
})

test('a connection that fails is asked again, and the last failure is thrown as it was', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') })
  const recovered = scripted([reset, { status: 200 }])
  const retries = []
  assert.equal((await fetchRetry('https://example.invalid/a', {}, { ...quick, fetcher: recovered.fetcher, onRetry: r => retries.push(r) })).status, 200)
  assert.deepEqual(retries, [{ attempt: 1, reason: 'ECONNRESET' }])

  const never = scripted([reset, reset])
  await assert.rejects(fetchRetry('https://example.invalid/a', {}, { ...quick, attempts: 2, fetcher: never.fetcher }), err => err === reset)
  assert.equal(never.calls.length, 2)
})

test('every attempt gets a timeout of its own, and the caller\'s headers each time', async () => {
  const { fetcher, calls } = scripted([{ status: 504 }, { status: 200 }])
  await fetchRetry('https://example.invalid/a', { headers: { 'User-Agent': 'x' } }, { ...quick, timeoutMs: 60000, fetcher })
  assert.equal(calls.length, 2)
  assert.notEqual(calls[0].init.signal, calls[1].init.signal)
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal)
    assert.equal(call.init.headers['User-Agent'], 'x')
  }
  const plain = scripted([{ status: 200 }])
  await fetchRetry('https://example.invalid/a', {}, { ...quick, fetcher: plain.fetcher })
  assert.equal(plain.calls[0].init.signal, undefined)
})
