'use strict';
  // ---- DOM ----------------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id)

  // h('button', { class, text, onclick, disabled: true, value }, ...children). Children are
  // nodes or strings; strings become text nodes. `value` is set after the children, so a select
  // can pick one of its options.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag)
    let value
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'style') el.style.cssText = v
      else if (k === 'value') value = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue
      el.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)))
    }
    if (value !== undefined) el.value = value
    return el
  }

  function ico(name) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('class', 'ico')
    svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(ns, 'use')
    use.setAttribute('href', '#i-' + name)
    svg.append(use)
    return svg
  }

  const pill = (tone, text, dot = false) => h('span', { class: tone ? `pill ${tone}` : 'pill' }, dot && h('span', { class: 'dot' }), text)
  const tile = (account, size = '') => h('span', { class: `tile ${size} ${tileClass(account.uuid ?? account.name)}`.replace(/\s+/g, ' ') }, initials(account.name))
  // playSentence's parts as nodes
  const parts = (list) => list.map((x) => (typeof x === 'string' ? x : h('b', { text: x.b })))

  // { tone: 'fault' | 'warn' | 'live' | '', title, text, acts: [nodes], onclose, extra: node }
  function notice({ tone = '', title, text, acts = [], onclose, extra }) {
    const icon = tone === 'fault' ? 'alert' : tone === 'live' ? 'check' : 'info'
    // no live role of its own: it is rebuilt with the page, and would be read again each time.
    // announce() reads a notice once, when it first shows.
    return h('div', { class: `notice ${tone}`.trim(), role: 'group', 'aria-label': tone === 'fault' ? 'Problem' : 'Notice' }, ico(icon),
      h('div', { class: 'body' }, h('b', { text: title }), text && h('span', { text })),
      (acts.length || onclose) && h('div', { class: 'acts' }, acts,
        onclose && h('button', { class: 'sm quiet icon', 'aria-label': 'Dismiss', onclick: onclose }, ico('x'))),
      extra)
  }

  // Read aloud by a screen reader: politely, or at once for a problem. The text is cleared
  // first so that the same words said twice (the same failure, a second time) are read twice.
  function say(text, urgent = false) {
    const id = urgent ? 'sayNow' : 'say'
    const el = $(id)
    if (!el) return
    // two things to say within the moment are said together, not the second over the first
    saying[id].text = saying[id].text ? `${saying[id].text} ${text}` : text
    el.textContent = ''
    clearTimeout(saying[id].timer)
    saying[id].timer = setTimeout(() => { el.textContent = saying[id].text; saying[id].text = '' }, 60)
  }
  const saying = { say: { text: '', timer: 0 }, sayNow: { text: '', timer: 0 } }

  // What changed on the page that someone not looking at it should hear, worked out after each
  // rebuild: a notice that was not there before, the reason Play is held back, the step a launch
  // has reached (the step, not each percent), a game that started, and the setup now in view.
  // `was` is what the last rebuild had; answers { polite, urgent } and the new `was`.
  function spoken(was, now) {
    const polite = []
    const urgent = []
    for (const n of now.notices) if (!was.notices.some((o) => o.text === n.text)) (n.fault ? urgent : polite).push(n.text)
    if (now.why && now.why !== was.why) polite.push(now.why)
    if (now.step && now.step !== was.step) polite.push(now.step)
    if (now.running && !was.running && was.pick === now.pick) polite.push('Minecraft is running.')
    if (now.pick && was.pick && now.pick !== was.pick) polite.unshift(`${now.pickName} selected.`)
    return { polite: polite.join(' '), urgent: urgent.join(' ') }
  }

  let wasSaid = { notices: [], why: '', step: '', running: false, pick: null }
  function announce() {
    // while the panel cannot be reached the page says so itself; what stood before is not new
    // when it comes back
    if (S.down) return
    const p = S.summary && !S.down ? currentProfile() : null
    const job = S.job && !S.job.done ? S.job : null
    const now = {
      notices: [...document.querySelectorAll('.notice')].map((n) => ({ text: [...n.querySelectorAll('.body > *')].map((x) => x.textContent.trim()).filter(Boolean).join(' '), fault: n.classList.contains('fault') })),
      why: $('why')?.textContent ?? '',
      // the step, not its words, which change with every file counted
      step: job ? `Launching ${setupName(profileNamed(job.profile) ?? { name: job.profile, mc: '' })}: ${STEP_SAID[stepOf(job.stage)] ?? 'getting ready'}.` : '',
      running: Boolean(p?.running),
      pick: p?.name ?? null,
      pickName: p ? setupName(p) : '',
    }
    const out = spoken(wasSaid, now)
    wasSaid = now
    if (out.urgent) say(out.urgent, true)
    if (out.polite) say(out.polite)
  }

  const sk = (style) => h('div', { class: 'sk', style })

