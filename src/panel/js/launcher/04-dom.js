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

  // the sprite's icon; `cls` sizes or places it where it sits
  function ico(name, cls = '') {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('class', cls ? `sl-ico ${cls}` : 'sl-ico')
    svg.setAttribute('aria-hidden', 'true')
    const use = document.createElementNS(ns, 'use')
    use.setAttribute('href', '#i-' + name)
    svg.append(use)
    return svg
  }

  const pill = (tone, text, dot = false) => h('span', { class: 'sl-pill', 'data-tone': tone || null }, dot && h('span', { class: 'sl-dot', 'data-tone': tone || null, 'aria-hidden': 'true' }), text)
  // A server's state as a dot in the shared look: lit when running, a ring when stopped.
  const stateDot = (status, stopped) => h('span', { class: 'sl-dot', 'data-tone': status === 'running' ? 'live' : stopped ? null : 'warn', 'data-hollow': status !== 'running' && stopped ? '' : null, 'aria-hidden': 'true' })
  // an account's face: its initial on one of the shared tile colours, 28px, or 22px when `small`
  const tile = (account, small = false) => h('span', { class: small ? 'sl-tile sl-tile-sm size-[22px] text-1' : 'sl-tile sl-tile-sm', 'data-tone': tileClass(account.uuid ?? account.name).slice(1) }, initials(account.name))
  // playSentence's parts as nodes
  const parts = (list) => list.map((x) => (typeof x === 'string' ? x : h('b', { text: x.b })))

  // The launcher's controls in the shared look (src/panel/tailwind/components.css).
  const BTN = 'sl-btn'
  const BTN_SM = 'sl-btn sl-btn-sm'
  const BTN_PRIMARY = 'sl-btn sl-btn-primary'
  const BTN_DANGER_SM = 'sl-btn sl-btn-danger sl-btn-sm'
  const BTN_QUIET_SM = 'sl-btn sl-btn-ghost sl-btn-sm'
  const BTN_ICON = 'sl-btn sl-btn-ghost sl-btn-sm sl-btn-icon'
  // a verb inside a sentence: it flows and wraps with the words around it, at their size
  const LINK = 'sl-btn sl-btn-link [display:inline] whitespace-normal [font:inherit]'
  // the buttons of a launch under way or a game running, at the weight of Play
  const BTN_BIG = 'h-auto min-h-[52px] px-5 rounded-md'
  const HINT = 'sl-hint'
  const HINT_WARN = 'sl-hint text-warn-ink'
  const HINT_BAD = 'sl-error font-normal'
  const NOTE = 'sl-hint'
  // a field whose value is refused: the border and the focus ring say so
  const INPUT_BAD = 'sl-input border-fault focus:outline-fault'
  const LABEL = 'sl-eyebrow'
  // a box that asks before something that cannot be taken back
  const CONFIRM = 'flex items-center flex-wrap gap-3 mt-1 py-3 px-4 border border-fault-edge bg-fault-wash rounded-sm text-3 text-fault-ink [&_b]:font-semibold'
  // a select in the shared look, with its chevron
  const selectBox = (select, cls = '') => h('div', { class: `sl-input-group ${cls}`.trim() }, select, h('span', { class: 'sl-input-caret', 'aria-hidden': 'true' }, ico('chev')))

  // { tone: 'fault' | 'warn' | 'live' | '', title, text, acts: [nodes], onclose, extra: node, cls }
  // `notice` and the tone stay on it for announce() and the poll, which look for them.
  function notice({ tone = '', title, text, acts = [], onclose, extra, cls = '' }) {
    const icon = tone === 'fault' ? 'alert' : tone === 'live' ? 'check' : 'info'
    // no live role of its own: it is rebuilt with the page, and would be read again each time.
    // announce() reads a notice once, when it first shows.
    return h('div', { class: `notice sl-banner items-start ${cls}`.trim(), 'data-tone': tone || null, role: 'group', 'aria-label': tone === 'fault' ? 'Problem' : 'Notice' }, ico(icon),
      h('div', { class: 'sl-banner-text grid gap-1 basis-[200px]' }, h('b', { class: 'sl-banner-title', text: title }), text && h('span', { class: 'sl-banner-body', text })),
      (acts.length || onclose) && h('div', { class: 'sl-banner-actions flex-none items-center ml-auto' }, acts,
        onclose && h('button', { class: BTN_ICON, 'aria-label': 'Dismiss', onclick: onclose }, ico('x'))),
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
      notices: [...document.querySelectorAll('.notice')].map((n) => ({ text: [...n.querySelectorAll('.sl-banner-text > *')].map((x) => x.textContent.trim()).filter(Boolean).join(' '), fault: n.dataset.tone === 'fault' })),
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

  const sk = (style) => h('div', { class: 'sl-skeleton', style })

