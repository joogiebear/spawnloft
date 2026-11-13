import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// The pages' "session ended" notice (rust/PANEL-AUTH-DESIGN.md 3.4). ui.html and launcher.html
// hold one block of script word for word; it is run here against stand-ins for fetch, EventSource
// and the document. A real browser runs it in desktop/smoke-panel.cjs.

const START = '// ---- session ended'
const END = '// ---- end session ended ----'

function block(file) {
  const html = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  const from = html.indexOf(START)
  const to = html.indexOf(END)
  assert.ok(from > 0 && to > from, `${file} holds the block`)
  const text = html.slice(from, to + END.length)
  // the launcher's copy is indented one level inside its script
  return file === 'launcher.html' ? text.split('\n').map((line) => line.replace(/^ {2}/, '')).join('\n') : text
}

test('ui.html and launcher.html hold the same block', () => {
  assert.equal(block('launcher.html'), block('ui.html'))
})

test('the block comes before the page\'s first request', () => {
  for (const file of ['ui.html', 'launcher.html']) {
    const html = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    const at = html.indexOf(START)
    for (const call of ['fetch(', 'new EventSource(']) {
      const first = html.indexOf(call, html.indexOf(END))
      assert.ok(first === -1 || first > at, `${file}: ${call}`)
      const before = html.slice(0, at)
      assert.ok(!before.includes(call), `${file}: a ${call} before the block`)
    }
  }
})

// a page with nothing but what the block uses
function page({ answer }) {
  const appended = []
  const listeners = []
  const requests = []
  class FakeEventSource {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 2
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.handlers = []
    }

    addEventListener(kind, fn) { this.handlers.push(fn) }
    close() { this.readyState = 2 }
    fail(state) {
      this.readyState = state
      for (const fn of this.handlers) fn()
    }
  }
  const el = () => {
    const node = { style: {}, children: [], attrs: {}, append: (...c) => node.children.push(...c), setAttribute: (k, v) => { node.attrs[k] = v } }
    return node
  }
  const document = {
    body: { append: (n) => appended.push(n) },
    documentElement: {},
    getElementById: (id) => appended.find((n) => n.id === id) ?? null,
    createElement: el,
    addEventListener: (...a) => listeners.push(a),
  }
  const window = {
    fetch: async (url, init) => {
      requests.push(url)
      const { status, body } = answer(url, init)
      return {
        status,
        url: new URL(url, 'http://127.0.0.1:9/').href,
        clone() { return { json: async () => body } },
        json: async () => body,
      }
    },
    EventSource: FakeEventSource,
  }
  const location = { origin: 'http://127.0.0.1:9' }
  const run = new Function('window', 'document', 'location', `${block('ui.html')}\nreturn panelSession`)
  const session = run(window, document, location)
  return { window, appended, requests, session, FakeEventSource }
}

const settled = (promise, ms = 30) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))])

test('a 401 with code "auth" ends the session: one notice, streams closed, no more requests', async () => {
  let signedIn = true
  const p = page({ answer: () => (signedIn ? { status: 200, body: {} } : { status: 401, body: { code: 'auth', error: 'x' } }) })
  const stream = new p.window.EventSource('/api/instances/a/stream')
  const ok = await p.window.fetch('/api/instances')
  assert.equal(ok.status, 200)
  assert.equal(p.session.ended, false)

  signedIn = false
  assert.equal(await settled(p.window.fetch('/api/instances')), 'pending', 'the caller waits instead of failing')
  assert.equal(p.session.ended, true)
  assert.equal(stream.readyState, 2, 'open streams are closed')
  assert.equal(p.appended.length, 1)
  assert.equal(p.appended[0].id, 'sessionEnded')
  assert.equal(p.appended[0].attrs.role, 'alertdialog')

  const sent = p.requests.length
  assert.equal(await settled(p.window.fetch('/api/overview')), 'pending')
  assert.equal(p.requests.length, sent, 'nothing more is asked')
  const late = new p.window.EventSource('/api/jobs/1/stream')
  assert.equal(late.readyState, 2, 'a stream opened after the end is closed at once')
  p.window.fetch('/api/x')
  assert.equal(p.appended.length, 1, 'one notice')
})

test('other refusals pass through untouched', async () => {
  const p = page({ answer: (url) => (url.includes('other') ? { status: 401, body: { code: 'auth' } } : { status: 401, body: { error: 'no' } }) })
  assert.equal((await p.window.fetch('/api/thing')).status, 401)
  assert.equal(p.session.ended, false)
  // only this panel's answers count
  assert.equal((await p.window.fetch('http://127.0.0.1:10/other')).status, 401)
  assert.equal(p.session.ended, false)
})

test('a failed stream asks once whether the sign-in holds', async () => {
  let session = true
  const p = page({ answer: () => (session ? { status: 200, body: {} } : { status: 401, body: { code: 'auth' } }) })
  const stream = new p.window.EventSource('/api/instances/a/stream')
  stream.fail(0)
  stream.fail(0)
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(p.requests, ['/api/appearance'], 'one check while the panel is still signed in')
  assert.equal(p.session.ended, false)
  session = false
  stream.fail(2)
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(p.session.ended, true)
})
