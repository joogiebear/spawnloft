'use strict';
  // ---- start ---------------------------------------------------------------------------------

  // a click outside the open menu closes it; a click inside one rebuilds it, so its target may
  // already be out of the page
  document.addEventListener('click', (e) => {
    if (!S.menu || !e.target.isConnected) return
    if (!(e.target.closest('[data-menu]')?.dataset.menu ?? '').split(' ').includes(S.menu)) closeMenu()
  })
  // so does the keyboard leaving it: Tab out of a menu, and it is not left open behind the focus
  document.addEventListener('focusin', (e) => {
    if (!S.menu || !e.target.isConnected) return
    // only when focus was in the menu and left it: a rebuild that puts focus back where it was,
    // or a menu the page opened by itself, comes from elsewhere and closes nothing
    const menuOf = (el) => (el?.closest?.('[data-menu]')?.dataset.menu ?? '').split(' ')
    if (!menuOf(e.relatedTarget).includes(S.menu)) return
    if (!menuOf(e.target).includes(S.menu)) closeMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (S.menu) closeMenu({ refocus: true })
    // the version list first, then the sheet it is in
    else if (S.sheet?.vOpen) { S.sheet.vOpen = false; S.sheet.vFind = ''; render(); $('fMc')?.focus({ preventScroll: true }) }
    else if (S.sheet) closeSheet()
    else if (S.stopAsk) { S.stopAsk = null; render(); $('stop')?.focus({ preventScroll: true }) }
  })
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })

  // The old screens' links still land somewhere: #profiles opens the setups, #accounts the
  // account menu. The address is put back to #play so the same link works twice.
  function followHash() {
    const hash = location.hash.slice(1)
    const menu = hash === 'profiles' ? 'setups' : hash === 'accounts' ? 'account' : null
    if (hash && hash !== 'play') try { history.replaceState(null, '', '#play') } catch { /* file: or a sandbox */ }
    return menu
  }
  // #accounts opens the account menu; #profiles lands on the setups, which are always in view
  function followMenu(menu) {
    if (menu !== 'setups') return openMenu(menu)
    const cur = currentProfile()
    const to = (cur && $(`setup-${cur.name}`)) ?? $('newSetup')
    to?.focus()
    to?.scrollIntoView({ block: 'nearest' })
  }
  window.addEventListener('hashchange', () => {
    const menu = followHash()
    if (menu && S.summary && !S.sheet) followMenu(menu)
  })

  // A server card's Play with no fitting setup leaves { mc, server }: a setup of that version is
  // picked and joins the server, or the New setup sheet opens filled in for it.
  function prefillPick(prefill, profiles, servers = []) {
    const mc = typeof prefill?.mc === 'string' ? prefill.mc : ''
    const server = typeof prefill?.server === 'string' ? prefill.server : ''
    // a Fabric or NeoForge server wants a setup on its loader: one of those, or a new one with it
    const loader = server ? serverLoader(servers.find((s) => s.name === server)) : null
    const fits = profiles.filter((p) => (!mc || p.mc === mc) && loaderFits(loader, p.loader))
    // the panel names the setup its Play button stands for; one that is gone falls back to a fit
    const named = typeof prefill?.profile === 'string' ? profiles.find((p) => p.name === prefill.profile) ?? null : null
    return { mc, server, loader, profile: named ?? fits.find((q) => q.server === server) ?? fits[0] ?? null, play: prefill?.play === true && Boolean(named) }
  }

  function takePrefill(prefill) {
    if (!prefill || typeof prefill !== 'object') return
    // a sheet already open keeps what was typed into it, and says why nothing started
    if (S.sheet) {
      S.sheet.error = 'Save or cancel this setup first, then press Play on the server again'
      return render()
    }
    const { mc, server, loader, profile: p, play } = prefillPick(prefill, profilesNow(), serversNow())
    if (p) {
      // a running or launching setup is shown as it is; its Join changes from the next launch
      pickProfile(p.name)
      const known = server && serversNow().some((s) => s.name === server)
      if (known) setTarget(p, { server })
      // A server card's Play is this page's Play, pressed for the person: the launch starts here,
      // with its progress and Cancel. Not when Play here would do more than they asked for (start
      // a stopped server) or cannot go ahead: then the page shows why, and the button is theirs.
      const plan = launchPlan(p)
      if (play && known && !S.job && !S.menu && !plan.blocked && !plan.startsServer && plan.picked?.name === server) startLaunch(p)
      else {
        render()
        // what was pressed (a link in the reason, a server's card) may be gone with the old setup
        if (!document.activeElement || document.activeElement === document.body) ($('play') ?? $('stop'))?.focus({ preventScroll: true })
      }
    } else {
      openSheet(null, { mc, server, loader })
    }
  }

  {
    const menu = followHash()
    // a launch this tab started before a reload: follow it again
    try {
      const was = JSON.parse(stored('session', JOB_KEY) ?? 'null')
      if (was?.id && was.profile) {
        S.job = { id: String(was.id), profile: String(was.profile), stage: 'start', message: '', percent: null, reached: -1, startsServer: Boolean(was.startsServer), done: false }
        followJob(S.job, null)
      }
    } catch { stored('session', JOB_KEY, null) }
    render()
    poll().then(() => {
      loadedOnce = true
      if (waitingNote) takePrefill(waitingNote)
      else if (menu && !S.down) followMenu(menu)
      waitingNote = null
    })
  }

  // A server card's Play arrives as a message from the panel that holds this page in its frame,
  // and from nothing else: one press reaches one page (a note in shared storage reached every
  // launcher open in the browser, and each started the game), and nothing is left behind to be
  // acted on another day. A note that comes before the first answer from the panel waits for it,
  // and is read against what the panel says now, not three seconds ago.
  window.addEventListener('message', (e) => {
    if (window.parent === window || e.source !== window.parent || e.origin !== location.origin) return
    if (e.data?.type !== 'spawnloft-play-note' || !e.data.note || typeof e.data.note !== 'object') return
    const note = e.data.note
    if (!loadedOnce) { waitingNote = note; return }
    poll().then(() => takePrefill(note))
  })
  // the panel sends a note it made while this page was loading once it hears this
  if (window.parent !== window) try { window.parent.postMessage({ type: 'spawnloft-play-ready' }, location.origin) } catch { /* not the panel */ }
