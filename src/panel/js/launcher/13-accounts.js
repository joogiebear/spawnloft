'use strict';
  // ---- accounts ------------------------------------------------------------------------------

  // The Login button (CLIENT.md, "Signing in from the launcher"): ask the panel for a sign-in,
  // listen on its stream, and only once the stream has said "pending" open Microsoft's page, so
  // the sign-in always has a listener while the person is on Microsoft's page. In a browser tab
  // the window is opened here, inside the click, while a pop-up is still allowed; it stays blank
  // until the stream answers.
  async function startLogin() {
    if (S.login) return
    S.acctNotice = null
    if (S.menu !== 'ask') S.menu = 'account'
    const tab = desktop?.openMicrosoftLogin ? null : window.open('', 'spawnloft-login')
    // cut from this page: Microsoft's page gets no handle on the launcher
    if (tab) try { tab.opener = null } catch { /* already cross-origin */ }
    let made
    try {
      made = await api('client/accounts/login', { method: 'POST' })
    } catch (err) {
      tab?.close()
      S.acctNotice = err.status === 409
        ? { tone: 'warn', title: 'A sign-in is already open in another window', text: 'Finish it there, or close that window and try again.', retry: 'Try again' }
        : { tone: 'fault', title: 'Couldn\'t start the sign-in', text: sentence(err.message), retry: 'Try again' }
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      return render()
    }
    if (!/^https:\/\/login\.microsoftonline\.com\//.test(String(made?.authorizeUrl ?? ''))) {
      tab?.close()
      S.acctNotice = { tone: 'fault', title: 'Couldn\'t start the sign-in', text: 'The panel answered with a sign-in address that is not Microsoft\'s.' }
      return render()
    }
    // status: what the stream said last; 'finishing' once Microsoft's part is over
    const login = { id: made.loginId, url: made.authorizeUrl, status: null, opened: false, blocked: false, done: false, tab, watcher: null }
    S.login = login
    const es = new EventSource(`/api/client/accounts/login/${enc(login.id)}/stream`)
    login.es = es
    es.onmessage = (e) => {
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (S.login !== login) return es.close()
      login.status = ev.status
      if (ev.status === 'pending') {
        if (!login.opened) {
          login.opened = true
          openMicrosoft(login)
        }
        return
      }
      // Microsoft's page was in the browser, which is still in front of this window
      if (login.external && !login.raised && ev.status !== 'cancelled') {
        login.raised = true
        desktop?.focusWindow?.().catch(() => {})
      }
      if (ev.status === 'finishing') return render()
      endLogin(login, ev)
    }
    es.onerror = () => {
      if (!login.done && es.readyState === EventSource.CLOSED) endLogin(login, { status: 'failed', message: 'lost the connection to the panel during the sign-in; start it again' })
    }
    render()
  }

  // A window closed while the stream still says "pending" was closed by the person: nothing is
  // coming, so the sign-in is cancelled. Once it says "finishing" the panel has Microsoft's code
  // and a DELETE would throw the account away, so closing the window then changes nothing.
  function windowClosed(login) {
    if (S.login !== login || login.status !== 'pending') return
    // not a Cancel press: the notice says the window closed, not that the person cancelled
    login.closedEarly = true
    cancelLogin(login)
  }

  async function openMicrosoft(login) {
    if (desktop?.openMicrosoftLogin) {
      let out = null
      try { out = await desktop.openMicrosoftLogin(login.url) } catch { /* refused */ }
      if (S.login !== login) return
      if (!out?.ok) {
        // an again-press that is refused leaves the waiting state as it was
        if (!login.external) login.blocked = true
        return render()
      }
      if (out.external) {
        // the system browser has the page and there is no closed signal: the stream reports the outcome
        login.external = true
        return render()
      }
      // resolves when the window has closed; a moment for a "finishing" already on its way
      setTimeout(() => windowClosed(login), 500)
      return
    }
    const w = login.tab
    if (!w || w.closed) {
      login.blocked = true
      return render()
    }
    w.location.href = login.url
    login.watcher = setInterval(() => {
      if (login.done) return clearInterval(login.watcher)
      if (w.closed) {
        clearInterval(login.watcher)
        windowClosed(login)
      }
    }, 1000)
  }

  async function cancelLogin(login) {
    if (login.done) return
    try {
      await api(`client/accounts/login/${enc(login.id)}`, { method: 'DELETE' })
    } catch { /* gone already */ }
    // the stream normally says "cancelled" first; this covers a stream that is already closed
    endLogin(login, { status: 'cancelled' })
  }

  // The outcome shows in the account menu, which opens for it.
  function endLogin(login, ev) {
    if (login.done) return
    login.done = true
    login.es?.close()
    clearInterval(login.watcher)
    if (S.login === login) S.login = null
    const thenPlay = S.afterLogin
    S.afterLogin = null
    if (ev.status === 'done' && thenPlay && ev.account?.uuid) {
      // "Who's playing?" was answered: this account plays, now
      S.menu = null
      playAs(ev.account.uuid, thenPlay)
      return
    }
    if (ev.status === 'done') {
      S.acctNotice = { tone: 'live', title: `Signed in as ${ev.account?.name ?? 'your account'}`, signedIn: ev.account?.uuid ?? null }
    } else if (ev.status === 'cancelled' && login.closedEarly) {
      S.acctNotice = { tone: 'warn', title: 'The sign-in window closed before the sign-in finished', text: 'Nothing was saved.', retry: 'Try again' }
    } else if (ev.status === 'cancelled') {
      S.acctNotice = { tone: '', title: 'Sign-in cancelled', text: 'Nothing was saved.', retry: 'Add Microsoft account' }
    } else {
      S.acctNotice = { tone: 'fault', title: sentence(plain(ev.message ?? 'the sign-in failed')), text: 'Try again, or play offline on local servers.', retry: 'Try again' }
    }
    if (S.menu !== 'ask') S.menu = 'account'
    refresh()
    // the menu opened by itself to say how the sign-in went: focus goes to it, so it is not a
    // menu left open somewhere the keyboard is not
    if (S.menu === 'account' && !S.sheet && !$('menuAccount')?.contains(document.activeElement)) $('chip')?.focus({ preventScroll: true })
  }

  // Make an account the one this launcher plays as, then play `profile`.
  async function playAs(uuid, profile) {
    try {
      if (S.summary?.defaultAccount !== uuid) await api('client/accounts/default', { method: 'POST', body: { uuid } })
    } catch (err) {
      S.flash = { tone: 'fault', title: 'Couldn\'t pick who is playing', text: sentence(err.message) }
      return refresh()
    }
    await refresh()
    const p = profileNamed(profile)
    if (p) startLaunch(p)
  }

  // "Play offline as": the name is added and becomes the one this launcher plays as; from
  // "Who's playing?" (`thenPlay`, a profile name) the game starts too.
  async function addOffline(thenPlay = null) {
    const o = S.offline
    let out
    try {
      out = await api('client/accounts/offline', { method: 'POST', body: { name: o.name.trim() } })
      o.name = ''
      o.error = null
    } catch (err) {
      o.error = err.message
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      return refresh()
    }
    if (thenPlay) {
      S.menu = null
      return playAs(out.account.uuid, thenPlay)
    }
    try {
      if (out.defaultAccount !== out.account.uuid) await api('client/accounts/default', { method: 'POST', body: { uuid: out.account.uuid } })
      S.acctNotice = { tone: 'live', title: `Playing as ${out.account.name}`, text: 'An offline name, for local servers.' }
    } catch (err) {
      S.acctNotice = { tone: 'fault', title: `Added ${out.account.name}, but couldn't play as it`, text: sentence(err.message) }
    }
    refresh()
  }

  async function setDefault(uuid) {
    S.acctNotice = null
    try {
      await api('client/accounts/default', { method: 'POST', body: { uuid } })
      S.menu = null
      S.acctAsk = null
    } catch (err) {
      S.acctNotice = { tone: 'fault', title: 'Couldn\'t change who is playing', text: sentence(err.message) }
    }
    refresh()
  }

  async function removeAccount(a) {
    S.acctAsk = null
    try {
      await api(`client/accounts/${enc(a.uuid)}`, { method: 'DELETE' })
      S.acctNotice = { tone: '', title: a.type === 'offline' ? `Removed ${a.name}` : `Signed out ${a.name}`, text: 'A setup that was set to play as this account asks for another one before it plays.' }
    } catch (err) {
      S.acctNotice = { tone: 'fault', title: `Couldn't remove ${a.name}`, text: sentence(err.message) }
    }
    await refresh()
    // the button that was pressed is gone with the question
    if (!document.activeElement || document.activeElement === document.body) $('chip')?.focus({ preventScroll: true })
  }

