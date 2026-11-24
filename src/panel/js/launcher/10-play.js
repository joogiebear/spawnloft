'use strict';
  // ---- Play ----------------------------------------------------------------------------------

  function unreachableView() {
    return h('div', { class: 'sl-empty m-auto max-w-[420px] p-0', role: 'alert' }, h('div', { class: 'size-12 mb-1 rounded-sm border border-dashed border-edge grid place-items-center text-ink-3 text-[20px]' }, ico('alert')),
      h('h2', { class: 'sl-empty-title', text: S.downWhy ? 'SpawnLoft could not open the launcher' : 'Can\'t reach SpawnLoft' }),
      h('p', { class: 'sl-empty-text', text: S.downWhy || 'The panel that runs the launcher is not answering. If you closed the SpawnLoft app, open it again; this page reconnects by itself.' }),
      h('div', { class: 'sl-empty-actions mt-1' }, h('button', { class: BTN_PRIMARY, onclick: () => poll() }, 'Try again')))
  }

  function playView() {
    const sum = S.summary
    if (!sum) {
      return h('div', { class: PLAYGRID_SOLO }, h('div', { class: PLAYBOX, 'aria-busy': 'true', 'aria-label': 'Loading' }, sk('height:72px;border-radius:var(--r)'), sk('width:60%;height:16px'), sk('height:40px;margin-top:var(--s-4)')))
    }
    const p = currentProfile()
    if (!p) return firstRunView()
    const plan = launchPlan(p)
    const { state } = plan
    const kids = [flashNotice(), setupHead(p)]
    if (S.crash?.profile === p.name && !S.crash.pending && state.kind !== 'running' && state.kind !== 'launching') kids.push(crashNotice(S.crash))
    else if (S.crash && !S.crash.pending && S.crash.profile !== p.name && profileNamed(S.crash.profile)) kids.push(crashElsewhere(S.crash))
    if (S.notice?.profile === p.name && state.kind !== 'launching' && !(S.notice.busy && state.kind === 'blocked')) {
      const n = S.notice
      kids.push(notice({ ...n, acts: n.fix === 'sign-in' ? [h('button', { class: BTN_SM, onclick: () => openMenu('account') }, 'Sign in')] : [], onclose: () => { S.notice = null; render() } }))
    }
    if (state.kind === 'launching') kids.push(launchingCard(p, S.job))
    else if (state.kind === 'running') kids.push(runningCard(p))
    else {
      kids.push(playButton(p, plan))
      if (state.kind === 'blocked') kids.push(h('p', { class: WHY, id: 'why' }, ico('alert', WHY_ICO), h('span', {}, parts(state.reason), state.fix.map((f, i) => [fixJoin(i, state.fix.length), fixButton(f, p, i === 0, state.other)]), state.fix.length ? '.' : null)))
      else kids.push(h('p', { class: DOES, id: 'does' }, parts(plan.sentence)))
      const lw = state.kind !== 'blocked' && loaderWarning(plan.picked, p)
      if (lw) kids.push(h('p', { class: WHY, id: 'loaderWarn' }, ico('alert', WHY_ICO), h('span', {}, parts(lw), ' ', fixButton('loader-setup', p, true, { mc: plan.picked.mc ?? p.mc, server: plan.picked.name }), '.')))
    }
    kids.push(joinField(p, plan, state.kind === 'launching' || state.kind === 'running'))
    return h('div', { class: PLAYGRID },
      h('div', { class: MAINCOL }, h('div', { class: PLAYBOX }, kids), serversRow(p, plan)),
      setupsPanel(p))
  }

  // The page: the selected setup's card with your servers under it, and the setups beside it.
  // Sizes are fixed, not a share of the window: on a wide screen the page stays the size it
  // reads well at and the window's own zoom is what grows it. Under 940px it is one column: the
  // card, then the setups (the only way to change setup must not sit under a long row of
  // servers), then your servers. margin:auto centres it in the stage and still scrolls when it
  // is taller.
  const PLAYGRID = 'w-[min(1120px,100%)] m-auto grid grid-cols-[minmax(0,1fr)_312px] gap-5 items-start max-[940px]:grid-cols-[minmax(0,1fr)]'
  const PLAYGRID_SOLO = 'w-[min(760px,100%)] m-auto grid grid-cols-[minmax(0,1fr)] gap-5 items-start'
  const MAINCOL = 'grid grid-cols-[minmax(0,1fr)] gap-5 min-w-0 max-[940px]:contents'
  // One card for every state: Play, a launch under way, a running game, a game that closed
  // early, a blocked Play. What changes is the block in the button's place, never the frame.
  // minmax(0, 1fr) keeps a long log line from widening the card past the window.
  const PLAYBOX = 'sl-card grid grid-cols-[minmax(0,1fr)] gap-5 p-7 shadow-md *:min-w-0 max-[940px]:order-1 max-[700px]:p-4'
  // the lines under Play: what it will do, or why it can't yet
  const DOES = 'm-0 text-4 leading-normal text-ink-2 text-center [&_b]:text-ink [&_b]:font-semibold'
  const WHY = 'm-0 flex gap-2 items-start justify-center text-4 leading-normal text-warn-ink [&_b]:font-semibold'
  const WHY_ICO = 'mt-[.3em]'
  // the setup's head: a label, its name, the facts it is picked by
  const SETUP_HEAD = 'grid gap-2'
  const SETUP_NAME = 'm-0 font-display text-6 leading-[1.15] font-strong tracking-[-.01em] [overflow-wrap:anywhere]'
  const PLAY_BTN = 'sl-btn sl-btn-primary flex-1 h-auto min-h-16 px-7 gap-3 rounded-md font-display text-6 leading-none font-strong tracking-[-.01em] max-[700px]:basis-full'
  const PLAY_ROW = 'relative min-w-0 flex items-stretch gap-3 max-[700px]:flex-wrap'
  // the head of the setups and of your servers: its label, and a control at the end
  const SECTION_HEAD = 'flex items-center gap-3 min-h-8'
  const SETUP_ROW = 'flex items-center gap-1 border rounded-sm'

  // The line under Play when the server picked runs another mod loader than the setup: sentence
  // parts, or null. The join will probably be turned away, but a server whose mods are all
  // server-side takes anyone, so Play stays open.
  function loaderWarning(picked, p) {
    if (!picked?.otherLoader) return null
    return [{ b: picked.label || picked.name }, ' runs ', { b: loaderName(picked.otherLoader) }, ' and this setup is ', { b: loaderName(p.loader) }, ', so the server will probably turn the join away.']
  }

  // What the selected setup is: its name, and the facts a person picks a setup by.
  function setupName(q) {
    return givenName(q) ?? setupTitle(q)
  }

  function setupHead(p) {
    const played = playedLine(p)
    return h('header', { class: SETUP_HEAD },
      h('span', { class: LABEL, text: 'Selected setup' }),
      h('h2', { class: SETUP_NAME, id: 'setupName', text: setupName(p) }),
      h('div', { class: 'flex flex-wrap gap-2' },
        h('span', { class: 'sl-pill', text: `Minecraft ${p.mc}` }),
        h('span', { class: 'sl-pill', text: loaderName(p.loader) }),
        h('span', { class: 'sl-pill', text: memoryText(p.memory) }),
        played && !p.running && h('span', { class: 'sl-pill', text: played })))
  }

  // What goes between the links in a blocked Play's reason: "A or B", "A, B, or C".
  function fixJoin(i, count) {
    if (i === 0) return ' '
    if (count === 2) return ' or '
    return i === count - 1 ? ', or ' : ', '
  }

  // The one control that clears a blocked Play, as a link in the reason.
  function fixButton(fix, p, first, other = null) {
    const cap = (text) => (first ? sentence(text) : text)
    // an id each, so a re-render (a poll) keeps the focus on the link it was on
    const link = (text, onclick) => h('button', { class: LINK, id: `fix-${fix}`, onclick }, cap(text))
    if (fix === 'sign-in') return link('sign in with Microsoft', () => openMenu('account'))
    if (fix === 'sign-in-again') return link('sign in again', startLogin)
    if (fix === 'pick-account') return link('pick another account', () => openSheet(p, null, 'fAccount'))
    if (fix === 'switch-account') return link('pick another account', () => openMenu('account'))
    if (fix === 'title-screen') return link('play on the title screen', () => { setTarget(p, {}); render(); $('play')?.focus({ preventScroll: true }) })
    if (fix === 'edit') return link('pick another version', () => openSheet(p, null, 'fMc'))
    if (fix === 'show-launching') return link('show it', () => { if (S.job) pickProfile(S.job.profile); render(); $('cancelLaunch')?.focus({ preventScroll: true }) })
    // a setup of the server's version: one that exists is picked, else the New sheet opens for it
    if (fix === 'other-setup' && other) return link(`use a ${other.mc} setup`, () => takePrefill({ mc: other.mc, server: other.server }))
    // a setup on the server's loader: one that exists is picked, else the New sheet opens with it
    if (fix === 'loader-setup' && other) return link('use a setup that matches it', () => takePrefill({ mc: other.mc, server: other.server }))
    if (fix === 'anyway' && other) return link('play anyway if the server takes other versions', () => { setTarget(p, { server: other.server, anyway: other.server }); render(); $('play')?.focus({ preventScroll: true }) })
    return null
  }

  // A fresh install: no setup yet. Play makes one for the latest release, then asks who is playing
  // (unless someone already signs in here), then plays. Nothing downloads before that answer.
  const FIRST = '#first'
  function latestRelease() {
    return (S.versions?.versions ?? []).find((v) => v.type === 'release' && !v.refusal)?.id ?? null
  }

  function firstRunView() {
    if (!S.versions) loadVersions()
    const mc = latestRelease()
    const draft = { name: FIRST, mc: mc ?? 'latest', loader: 'vanilla', server: null, account: null, running: false }
    const plan = launchPlan(draft)
    const def = defaultAccount()
    const machine = S.summary.machineRefusal
    const does = machine
      ? h('p', { class: WHY, id: 'why' }, ico('alert', WHY_ICO), h('span', { text: `Minecraft can't be launched on this computer: ${sentence(machine).replace(/\.?$/, '.')}` }))
      : h('p', { class: DOES, id: 'does' }, mc ? parts(def ? plan.sentence : ['Opens ', { b: `Minecraft ${mc}` }, plan.picked ? [' and joins ', { b: plan.picked.name }] : ' on the title screen', '. Pick who is playing first.']) : S.versions?.error ? [`The version list could not be read: ${S.versions.error}. `, h('button', { type: 'button', class: LINK, id: 'versionsAgain', onclick: loadVersions }, 'Try again')] : 'Reading Mojang\'s version list…')
    const card = h('div', { class: PLAYBOX }, flashNotice(),
      h('header', { class: SETUP_HEAD },
        h('span', { class: LABEL, text: 'Latest release' }),
        h('h2', { class: SETUP_NAME, id: 'setupName', text: mc ? `Minecraft ${mc}` : 'Minecraft' })),
      h('div', { class: PLAY_ROW },
        h('button', { class: PLAY_BTN, id: 'play', disabled: !mc || S.firstRun || Boolean(machine), 'aria-describedby': machine ? 'why' : 'does', onclick: firstPlay }, ico('play', 'text-[1em]'), S.firstRun ? 'Getting ready…' : 'Play')),
      does,
      joinField(draft, plan, false))
    return h('div', { class: PLAYGRID },
      h('div', { class: MAINCOL }, card, serversRow(draft, plan)),
      setupsPanel(draft))
  }

  // The setup Play makes on a fresh install: the latest release, vanilla, the usual memory.
  function firstProfileBody(mc, taken) {
    return { name: autoName(mc, 'vanilla', taken), mc, loader: 'vanilla', memory: defaultMemory('vanilla') }
  }

  async function firstPlay() {
    const mc = latestRelease()
    // a machine Minecraft cannot run on gets no setup made for it, whichever button asked
    if (!mc || S.firstRun || S.summary?.machineRefusal) return
    S.firstRun = true
    S.menu = null
    render()
    let made = null
    try {
      made = await api('client/profiles', { method: 'POST', body: firstProfileBody(mc, profilesNow().map((q) => q.name)) })
    } catch (err) {
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      S.flash = { tone: 'fault', title: 'Couldn\'t make a setup', text: sentence(err.message) }
    }
    S.firstRun = false
    if (!made) return render()
    // where Join pointed carries over to the setup it was for
    if (S.targets[FIRST]) S.targets[made.name] = S.targets[FIRST]
    delete S.targets[FIRST]
    saveTargets()
    pickProfile(made.name)
    await refresh()
    const p = profileNamed(made.name)
    if (p) startLaunch(p)
  }

  // "Who's playing?": asked when a setup has no account of its own and nobody signs in here.
  function askMenu(p) {
    const o = S.offline
    return h('div', { class: `${MENU} w-[400px]`, id: 'menuAsk', role: 'dialog', 'aria-label': 'Who\'s playing?', onkeydown: menuKeys },
      h('div', { class: MENU_HEAD, text: 'Who\'s playing?' }),
      S.acctNotice && acctNotice(S.acctNotice),
      S.login ? waitingStrip(S.login) : h('button', { class: `${BTN_PRIMARY} w-full`, onclick: () => { S.afterLogin = p.name; startLogin() } }, ico('ext'), 'Sign in with Microsoft'),
      h('p', { class: MENU_NOTE, text: 'Opens Microsoft\'s own sign-in page. SpawnLoft never sees your password. Needed for online servers.' }),
      h('hr', { class: MENU_SEP }),
      h('div', { class: MENU_HEAD, text: 'Or play offline on local servers' }),
      offlineField('askName', 'Play', () => addOffline(p.name)))
  }

  function flashNotice() {
    return S.flash && notice({ ...S.flash, onclose: () => { S.flash = null; render() } })
  }

  // What Play would do for a profile right now, and whether it may.
  function launchPlan(p) {
    const acct = playAccount(p, accountsNow(), S.summary.defaultAccount)
    const t = targetFor(p)
    const choices = serverChoices(p, serversNow(), acct.type)
    const picked = t.server ? choices.find((c) => c.name === t.server) ?? null : null
    // a server that is gone falls back to the title screen
    if (t.server && !picked) t.server = null
    // "Another address" is a choice of its own: until an address is typed, Play has nowhere to go
    const custom = !picked && (t.custom || Boolean(t.address.trim()))
    const address = custom ? t.address.trim() : ''
    const addrProblem = custom ? addressProblem(address) : null
    const job = S.job?.profile === p.name ? S.job : null
    const refused = S.refusals[p.name]
    if (refused && refused.mc !== p.mc) delete S.refusals[p.name]
    const state = playState({
      down: S.down, loaded: true, profile: p, job, acct, picked, anyway: t.anyway,
      machineRefusal: S.summary.machineRefusal,
      busy: Boolean(S.notice?.busy && S.notice.profile === p.name),
      otherJob: Boolean(S.job && !job),
      otherJobName: S.job && !job && profileNamed(S.job.profile) ? setupName(profileNamed(S.job.profile)) : null,
      refusal: S.refusals[p.name]?.message ?? null,
      crashed: S.crash?.profile === p.name && !S.crash.pending,
    })
    // a server Play will not go to is not started for it
    const startsServer = Boolean(picked?.stopped) && !(picked.otherVersion && t.anyway !== picked.name)
    const who = acct.missing ? `${acct.name} (no longer signed in)` : acct.name
    const sentenceParts = custom && addrProblem
      ? [address ? 'Fix the server address under Join, or pick another place to join.' : 'Type a server address under Join, or pick another place to join.']
      : playSentence({ mc: p.mc, loader: p.loader, who, server: picked?.name, address, startsServer })
    return { state, acct, t, choices, picked, custom, address, addrProblem, startsServer, blocked: state.kind !== 'ready' && state.kind !== 'closed-early', sentence: sentenceParts }
  }

  function playButton(p, plan) {
    const label = plan.startsServer ? 'Start server and play' : plan.state.kind === 'closed-early' ? 'Play again' : 'Play'
    return h('div', { class: PLAY_ROW, 'data-menu': 'ask' },
      h('button', { class: PLAY_BTN, id: 'play', disabled: plan.blocked, 'aria-describedby': plan.blocked ? 'why' : 'does', onclick: () => { S.askFrom = null; startLaunch(p) } }, ico('play', 'text-[1em]'), label),
      h('button', { class: 'sl-btn h-auto min-h-16 px-4 rounded-md', id: 'editSetup', onclick: () => openSheet(p) }, ico('gear'), 'Edit setup'),
      S.menu === 'ask' && menuPad(askMenu(p)))
  }

  // The square at the start of a setup's row: its version as far as the minor ("1.21"), or the
  // whole id when it is not a release.
  function setupBadge(q) {
    const m = /^(\d+\.\d+)(?:\.\d+)?$/.exec(String(q.mc))
    return m ? m[1] : String(q.mc).slice(0, 5).replace(/[-. _]+$/, '')
  }

  function setupSub(q) {
    // a named setup says what it is; a second unnamed one of the same version shows its saved
    // name ("1-21-11-2"), which is all that tells the two apart
    const what = givenName(q) ? setupTitle(q) : String(q.name).toLowerCase() !== nameBase(q.mc, q.loader).toLowerCase() ? q.name : null
    return [what, q.played?.lastPlayedAt ? `played ${dayWords(q.played.lastPlayedAt)}` : 'not played yet'].filter(Boolean).join(' · ')
  }

  // The setups, always in view beside the card. Picking one changes the card; the gear opens its
  // sheet (edit, rename, duplicate, remove). Each control has an id, so a re-render keeps focus.
  function setupsPanel(p) {
    const list = profilesNow()
    return h('aside', { class: 'sl-card grid gap-3 p-4 shadow-md min-w-0 max-[940px]:order-2', id: 'setups', 'aria-labelledby': 'setupsTitle' },
      h('div', { class: SECTION_HEAD },
        h('h2', { class: `${LABEL} flex-1`, id: 'setupsTitle', text: 'Setups' }),
        h('button', { class: BTN_SM, id: 'newSetup', title: 'Any version, snapshots too', 'aria-label': 'New setup', onclick: () => openSheet() }, ico('plus'), 'New')),
      !list.length && h('p', { class: NOTE, text: 'No setups yet. Play makes one for the latest release, or make your own with New.' }),
      list.length > 0 && h('ul', { class: 'list-none m-0 p-0 grid gap-1 max-h-[420px] overflow-auto max-[940px]:max-h-[264px]', role: 'list' }, list.map((q) => h('li', { class: q === p ? `${SETUP_ROW} bg-accent-wash border-accent-edge` : `${SETUP_ROW} border-transparent` },
        h('button', { class: 'sl-row m-0 w-auto flex-1 min-w-0 p-2 hover:bg-hover-hi', id: `setup-${q.name}`, 'aria-current': q === p ? 'true' : null, onclick: () => { pickProfile(q.name); S.menu = null; render() } },
          h('span', { class: 'size-9 flex-none grid place-items-center rounded-xs bg-recess border border-line font-mono text-1 leading-none font-strong text-ink-2', 'aria-hidden': 'true', text: setupBadge(q) }),
          h('span', { class: 'grid leading-[1.3] min-w-0 flex-1' }, h('b', { class: 'font-semibold truncate', text: setupName(q) }), h('small', { class: 'text-1 text-ink-3 truncate', text: setupSub(q) })),
          q.running ? pill('live', 'running', true) : S.job?.profile === q.name ? pill('accent', 'launching', true) : null),
        h('button', { class: BTN_ICON, id: `edit-${q.name}`, title: `Edit ${setupTitle(q)}${givenName(q) ? ` (${givenName(q)})` : ''}`, 'aria-label': `Edit ${setupTitle(q)}${givenName(q) ? ` (${givenName(q)})` : ''}`, onclick: () => openSheet(q) }, ico('gear'))))),
      list.length > 0 && h('p', { class: NOTE, text: 'A setup keeps its own worlds, options and mods. The gear edits, renames or copies it.' }))
  }

  // Which of your servers the page shows: those on the setup's version, or all of them, narrowed
  // by what was typed (a name, a label or a version).
  function shownServers(choices, opts) {
    const all = opts?.all === true
    const q = String(opts?.find ?? '').trim().toLowerCase()
    return choices.filter((c) => (all || !c.otherVersion) && (!q || [c.name, c.label, c.mc].some((v) => String(v ?? '').toLowerCase().includes(q))))
  }

  // Past this many servers the row gets a box to find one in.
  const FIND_FROM = 7

  // Your servers, under the card. Someone with a test server for every Minecraft version sees the
  // ones this setup can join; the rest are one press away, each offering a setup of its version.
  function serversRow(p, plan) {
    const all = plan.choices
    if (!all.length) return null
    const others = all.filter((c) => c.otherVersion).length
    // the box is there from seven servers up; what was typed counts only while it is
    const find = all.length >= FIND_FROM ? S.serverFind.trim() : ''
    // the first run's draft has no version until Mojang's list is read: nothing to narrow by yet;
    // and a search looks through every server, whatever the version
    const wide = S.serversAll || p.mc === 'latest' || Boolean(find)
    const shown = shownServers(all, { all: wide, find })
    const busy = plan.state.kind === 'launching' || plan.state.kind === 'running' || Boolean(S.job) || Boolean(S.firstRun)
    const stuck = cardsBlocked(plan, S.summary.machineRefusal)
    const card = (c) => {
      const cur = plan.picked?.name === c.name
      const act = c.otherVersion
        ? h('button', { class: `${BTN_SM} justify-self-start mt-1`, id: `srv-${c.name}`, disabled: Boolean(S.firstRun), onclick: () => { S.menu = null; takePrefill({ mc: c.otherVersion, server: c.name }) } }, `Use a ${c.otherVersion} setup`)
        : c.blocked
          ? h('small', { class: 'text-2 text-ink-3', text: sentence(c.blocked) })
          : h('button', { class: `${BTN_SM} justify-self-start mt-1`, id: `srv-${c.name}`, disabled: busy || stuck, title: stuck && !busy ? 'Play can\'t start yet: the card above says why.' : null, onclick: () => playOn(p, c) }, ico('play'), c.stopped ? 'Start and play' : 'Play here')
      return h('li', { class: 'sl-card grid gap-2 content-start p-4 rounded-md', 'data-tone': cur ? 'accent' : null, 'aria-current': cur ? 'true' : null },
        h('span', { class: 'flex items-center gap-2 min-w-0' }, stateDot(c.status, c.stopped), h('b', { class: 'font-semibold truncate', title: c.label && c.label !== c.name ? `${c.label} (folder name: ${c.name})` : c.name, text: c.label || c.name })),
        h('small', { class: 'text-2 text-ink-3', text: `${c.mc ?? 'version unknown'}${c.loader ? ` · ${loaderName(c.loader)}` : ''} · ${statusText(c.status).toLowerCase()}` }),
        act)
    }
    return h('section', { class: 'grid gap-3 min-w-0 max-[940px]:order-3', 'aria-labelledby': 'serversTitle' },
      h('div', { class: SECTION_HEAD },
        h('h2', { class: `${LABEL} flex-1`, id: 'serversTitle', text: wide ? 'Your servers' : `Your servers on ${p.mc}` }),
        all.length >= FIND_FROM && h('input', { class: 'sl-input w-[200px] h-8 max-[700px]:w-full', id: 'serverFind', type: 'search', 'aria-label': 'Find a server', placeholder: 'Find a server', value: S.serverFind, autocomplete: 'off', spellcheck: 'false', oninput: (e) => { S.serverFind = e.target.value; S.menu = null; render() } }),
        // the label says what a press does; it is not a pressed/unpressed toggle
        others > 0 && p.mc !== 'latest' && !find && h('button', { class: LINK, id: 'serversAll', onclick: () => { S.serversAll = !S.serversAll; S.menu = null; render() } }, S.serversAll ? `Only ${p.mc}` : `Show all ${all.length}`)),
      shown.length
        ? h('ul', { class: 'list-none m-0 p-0 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3', role: 'list' }, shown.map(card))
        : h('p', { class: NOTE, text: find ? `No server matches \u201c${find}\u201d.` : `None of your servers run Minecraft ${p.mc}.${wide ? '' : ' Show all to see the others.'}` }))
  }

  // Whether a server card's Play would go nowhere whichever server it is for: Play is blocked,
  // and not by the server now picked (picking another is what the card does).
  function cardsBlocked(plan, machineRefusal) {
    if (machineRefusal) return true
    return plan.state.kind === 'blocked' && !(plan.picked && (plan.picked.blocked || plan.picked.otherVersion))
  }

  // A server card's own Play: this setup, joined to that server, now. Focus follows to what the
  // press brought up (Cancel on the launch, or the question of who is playing), since the button
  // pressed is disabled the moment the launch starts.
  function playOn(p, c) {
    S.menu = null
    S.askFrom = `srv-${c.name}`
    setTarget(p, { server: c.name })
    startLaunch(p)
    if (S.menu !== 'ask') (document.activeElement?.id ? null : $('cancelLaunch') ?? $('play'))?.focus({ preventScroll: true })
  }

  // Join is one choice out of a short list: a SpawnLoft server on the setup's version, another
  // address (typed in a box of its own under the field), or the title screen. The field is a
  // button that says which, so nothing typed can turn a picked server into an address.
  function joinField(p, plan, inert) {
    const { t, picked, custom, address, addrProblem, acct } = plan
    const open = S.menu === 'join' && !inert
    const dot = picked && stateDot(picked.status, picked.stopped)
    const now = picked ? picked.label || picked.name : custom ? 'Another address' : 'Title screen'
    const hint = picked ? `${statusText(picked.status)}${picked.mc ? ` \u00b7 ${picked.mc}` : ''}` : custom ? null : 'no server'
    return h('div', { class: 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 items-center pt-5 border-t border-line-soft max-[700px]:grid-cols-[minmax(0,1fr)]' },
      h('span', { class: LABEL, id: 'joinLabel', text: 'Join' }),
      h('div', { class: 'relative min-w-0', 'data-menu': 'join' },
        h('button', {
          class: JOIN_BOX, id: 'join', 'aria-haspopup': 'dialog', 'aria-expanded': String(open), 'aria-controls': 'menuJoin', 'aria-labelledby': 'joinLabel joinNow', 'aria-describedby': hint ? 'joinHint' : null, disabled: inert,
          onclick: toggleMenu('join'),
          onkeydown: (e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openMenu('join') } },
        }, dot, h('span', { class: 'flex-[0_1_auto] min-w-0 truncate text-4 font-strong', id: 'joinNow', text: now }), hint && h('span', { class: `${HINT} flex-1 truncate`, id: 'joinHint', text: hint }), h('span', { class: 'inline-flex ml-auto px-2 text-ink-3', 'aria-hidden': 'true' }, ico('chev'))),
        open && menuPad(joinMenu(p, plan))),
      custom && h('div', { class: JOIN_ADDRESS },
        h('input', {
          id: 'joinAddress', 'aria-label': 'Server address', 'aria-describedby': 'joinAddressHint', autocomplete: 'off', spellcheck: 'false', disabled: inert,
          class: address && addrProblem ? `${INPUT_BAD} h-10` : 'sl-input h-10', placeholder: 'play.example.net or 192.168.1.20:25566', value: t.address, maxlength: '260',
          oninput: (e) => { setTarget(p, { address: e.target.value, custom: true }); S.menu = null; render() },
          onkeydown: (e) => { if (e.key === 'Enter' && !plan.blocked) { e.preventDefault(); startLaunch(p) } },
        }),
        h('small', { id: 'joinAddressHint', class: address && addrProblem ? HINT_BAD : HINT, text: address && addrProblem ? addrProblem : `Host, or host:port. Online servers need a Microsoft account${acct.type === 'microsoft' ? `; you are signed in as ${acct.name}` : ''}.` })))
  }

  // The Join field looks like a field and is a button that opens the menu of places to join.
  const JOIN_BOX = 'sl-input flex items-center gap-2 h-auto min-h-11 pl-3 pr-1 bg-recess text-left text-ink cursor-pointer hover:border-accent-edge hover:bg-[var(--field-focus)] aria-expanded:border-accent-edge aria-expanded:bg-[var(--field-focus)]'
  const JOIN_ADDRESS = 'col-start-2 grid gap-1 max-[700px]:col-start-1'

  // The servers Join offers a setup: the ones on its version (and the one picked now, whatever
  // it runs), those that are up first. The first run's draft has no version to narrow by yet.
  function joinChoices(choices, mc, current) {
    const fits = choices.filter((c) => mc === 'latest' || !c.otherVersion || c.name === current)
    return [...fits.filter((c) => c.status === 'running'), ...fits.filter((c) => c.status !== 'running')]
  }

  function joinMenu(p, plan) {
    const { t, choices, custom } = plan
    const title = !t.server && !custom
    const list = joinChoices(choices, p.mc, t.server)
    const rest = choices.length - list.length
    const pickServer = (c) => () => { setTarget(p, { server: c.name }); closeMenu({ refocus: true }) }
    return h('div', { class: `${MENU} w-full`, id: 'menuJoin', role: 'dialog', 'aria-label': 'Where to join', onkeydown: menuKeys },
      list.length
        ? h('div', { class: MENU_HEAD, text: p.mc === 'latest' ? 'Your servers' : `Your servers on ${p.mc}` })
        : h('p', { class: MENU_NOTE, text: choices.length ? `None of your servers run Minecraft ${p.mc}.` : 'No SpawnLoft servers yet.' }),
      list.map((c) => {
        let meta = c.status === 'running' ? 'joins right away' : c.stopped ? 'starts it first, up to 2 min' : statusText(c.status)
        let warn = false
        if (c.blocked) { meta = c.blocked; warn = true } else if (c.otherVersion && p.mc !== 'latest') { meta = 'runs another version'; warn = true } else if (c.otherLoader) { meta = `runs ${loaderName(c.otherLoader)}`; warn = true }
        return h('button', { class: c.name === t.server ? `${MENU_ROW} bg-accent-wash` : MENU_ROW, 'aria-current': c.name === t.server ? 'true' : null, disabled: Boolean(c.blocked) && c.name !== t.server, onclick: pickServer(c) },
          stateDot(c.status, c.stopped),
          h('span', { class: 'grid leading-[1.25] min-w-0' }, h('b', { class: 'font-semibold', title: c.label && c.label !== c.name ? `Folder name: ${c.name}` : null, text: c.label || c.name }), h('small', { class: 'text-1 text-ink-3 truncate', text: `${statusText(c.status)}${c.mc ? ` \u00b7 ${c.mc}` : ''}` })),
          h('span', { class: warn ? `${MENU_META} text-warn-ink` : MENU_META, text: meta }))
      }),
      rest > 0 && h('p', { class: MENU_NOTE, text: `${rest} more on other versions. They are under Your servers, with Show all.` }),
      h('hr', { class: MENU_SEP }),
      h('button', { class: custom ? `${MENU_ROW} text-ink-2 bg-accent-wash` : `${MENU_ROW} text-ink-2`, id: 'joinOther', 'aria-current': custom ? 'true' : null, onclick: () => { setTarget(p, { address: t.address, custom: true }); closeMenu(); $('joinAddress')?.focus() } }, 'Another address\u2026'),
      h('button', { class: title ? `${MENU_ROW} text-ink-2 bg-accent-wash` : `${MENU_ROW} text-ink-2`, id: 'joinTitle', 'aria-current': title ? 'true' : null, onclick: () => { setTarget(p, {}); closeMenu({ refocus: true }) } }, 'Title screen'))
  }

  function launchingCard(p, job) {
    const [headline, facts] = splitMessage(job.message || 'Preparing…')
    const shown = STEPS.map((name, i) => ({ name, i })).filter((s) => s.name !== 'Server' || job.startsServer)
    return [
      h('div', { class: EYEBROW }, pill('accent', 'Launching', true)),
      // not a live region: every counted file would be read out. announce() says each new step once.
      h('div', { class: PROG },
        h('div', { class: PROG_LINE }, h('b', { class: PROG_HEAD, text: stepOf(job.stage) === -1 && !job.message ? 'Preparing…' : headline }), facts && h('span', { class: `${HINT} ml-auto`, text: facts })),
        h('div', { class: 'sl-progress h-2.5', role: 'progressbar', 'aria-label': 'Launch progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': job.percent ?? null, 'aria-valuetext': job.percent === null || job.percent === undefined ? headline : null,
          style: job.percent === null || job.percent === undefined ? null : `--value:${Math.max(2, job.percent) / 100}` }),
        // which steps are done and which one it is on, in words too, not by colour and a dot alone
        h('div', { class: 'flex gap-3 flex-wrap', role: 'list', 'aria-label': 'Steps of the launch' }, shown.map((s) => {
          const now = stepOf(job.stage)
          if (s.i < now || (s.i <= job.reached && s.i !== now)) return h('span', { class: `${STEP} text-live-ink`, role: 'listitem' }, ico('check'), s.name, h('span', { class: 'sl-sr', text: ', done' }))
          if (s.i === now) return h('span', { class: `${STEP} text-accent-ink font-strong`, role: 'listitem', 'aria-current': 'step' }, h('span', { 'aria-hidden': 'true', text: '● ' }), s.name)
          return h('span', { class: `${STEP} text-ink-4`, role: 'listitem' }, s.name)
        })),
        // the one thing to do while it runs; once the game itself is starting there is nothing left to cancel
        h('div', { class: RUN_ROW },
          h('button', { class: `${BTN} ${BTN_BIG}`, id: 'cancelLaunch', disabled: Boolean(job.cancelling) || stepOf(job.stage) >= 4, onclick: () => cancelLaunch(job) }, job.cancelling ? 'Cancelling…' : 'Cancel')),
        // once the game itself is starting there is no download left to speak of
        h('p', { class: `${HINT} text-3`, text: stepOf(job.stage) >= 4 ? 'The game is starting. Its window opens in a moment.' : `${CLOSING} does not stop the download. It keeps going and the files are used next time. Cancel stops it; what is already downloaded is kept.` })),
    ]
  }

  // the card's status row while the game is being launched or is running: the pill and the setup
  const EYEBROW = 'flex items-center gap-3 flex-wrap mb-[calc(var(--s-2)-var(--s-5))] type-card text-ink-2'
  // a launch under way, or a game running: a well in the button's place, at the button's weight
  const PROG = 'grid gap-3 min-h-[84px] p-5 border border-line rounded-md bg-recess shadow-lift max-[700px]:p-4'
  const PROG_LINE = 'flex items-baseline gap-3 flex-wrap'
  const PROG_HEAD = 'font-display text-5 leading-[1.2] font-strong tracking-[-.01em]'
  const STEP = 'text-1 inline-flex gap-[5px] items-center'
  const RUN_ROW = 'flex items-center gap-3 flex-wrap mt-1'

  // Asks the panel to stop the launch. The job's own stream then says it was cancelled, and that
  // is what puts Play back; a launch that had already finished just carries on to its result.
  async function cancelLaunch(job) {
    if (job.done || job.cancelling) return
    job.cancelling = true
    render()
    try {
      const out = await api(`jobs/${enc(job.id)}/cancel`, { method: 'POST', body: {} })
      if (!out?.cancelling && !job.done) { job.cancelling = false; render() }
    } catch (err) {
      if (job.done) return
      job.cancelling = false
      S.flash = null
      S.notice = { profile: job.profile, tone: 'fault', title: 'Could not cancel', text: sentence(plain(err.message)) }
      render()
    }
  }

  /** What the page says after a launch was cancelled. */
  function cancelledNotice(job) {
    const started = job.startsServer && job.reached >= 3
    return { tone: '', title: 'Launch cancelled', text: 'The game was not started. What was downloaded is kept for next time.' + (started ? ' Its server had already been asked to start, and is left to.' : '') }
  }

  function runningCard(p) {
    const target = p.launchTarget
    const started = Date.parse(p.startedAt)
    const total = playedWords((p.played?.totalMs ?? 0) + (Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0))
    const facts = [
      h('span', {}, 'since ', h('b', { text: clockTime(p.startedAt) })),
      Number.isFinite(started) && h('span', {}, 'for ', h('b', { text: playingFor(Date.now() - started) })),
      p.runningAccount?.name && h('span', {}, 'as ', h('b', { text: p.runningAccount.name })),
      total && h('span', {}, h('b', { text: total }), ' in all'),
    ]
    const asking = S.stopAsk === p.name && S.stopping !== p.name
    const live = S.live?.profile === p.name ? S.live : null
    return [
      h('div', { class: EYEBROW }, pill('live', 'Running', true), p.launchedBy === 'assistant' && pill('accent', 'Launched by an assistant')),
      h('div', { class: PROG },
        h('div', { class: PROG_LINE }, h('b', { class: PROG_HEAD, text: 'Minecraft is running' }), h('span', { class: `${HINT} ml-auto` }, target ? ['joined ', h('b', { class: 'text-ink-2', text: target })] : 'on the title screen')),
        asking
          // Stop closes the game where it stands; asked first, with the safe choice in focus
          ? h('div', { class: CONFIRM, role: 'group', 'aria-label': 'Stop the game?' },
            h('p', { class: 'm-0 flex-[1_1_260px] text-3 text-ink-2', id: 'stopWhy', text: target ? 'Stop Minecraft now? It closes straight away.' : 'Stop Minecraft now? If a single-player world is open, quit from the game\'s own menu instead, so the world is saved first.' }),
            h('button', { class: BTN, id: 'keepPlaying', onclick: () => { S.stopAsk = null; render(); $('stop')?.focus({ preventScroll: true }) } }, 'Keep playing'),
            h('button', { class: 'sl-btn sl-btn-danger', id: 'stopNow', 'aria-describedby': 'stopWhy', onclick: () => stopProfile(p) }, ico('stop'), 'Stop now'))
          : h('div', { class: RUN_ROW },
            // not `disabled` while stopping: the button holds the focus "Stop now" had
            h('button', { class: 'sl-btn sl-btn-danger h-auto min-h-[52px] px-10 gap-3 rounded-md font-display text-5 leading-none font-strong', id: 'stop', 'aria-disabled': S.stopping === p.name ? 'true' : null, onclick: () => { if (S.stopping !== p.name) askStop(p) } }, ico('stop', 'text-[14px]'), S.stopping === p.name ? 'Stopping\u2026' : 'Stop'),
            h('button', { class: `${BTN} ${BTN_BIG}`, id: 'liveLog', 'aria-expanded': String(Boolean(live)), 'aria-controls': live ? 'liveLogBox' : null, onclick: () => toggleLive(p) }, live ? 'Hide log' : 'Show log'),
            h('button', { class: `${BTN} ${BTN_BIG}`, id: 'openFolder', onclick: () => reveal(p, 'folder') }, ico('folder'), 'Open folder')),
        h('div', { class: 'flex flex-wrap gap-y-1 gap-x-3 type-meta text-ink-3 [&_b]:text-ink-2 [&_b]:font-semibold' }, facts),
        live && h('div', { class: 'grid gap-2', id: 'liveLogBox' },
          logBlock(live.lines, { id: 'liveLogPre', label: 'The game\'s log, as it runs', empty: live.read ? 'Nothing in the log yet.' : 'Reading the log\u2026', cls: 'w-full max-h-[260px]' }),
          h('div', { class: 'flex gap-2 flex-wrap' },
            h('button', { class: BTN_SM, id: 'copyLive', disabled: !live.lines.length, onclick: () => copyLines('live', live.lines) }, S.copied === 'live' ? 'Copied' : 'Copy'),
            h('button', { class: BTN_SM, id: 'liveFolder', onclick: () => reveal(p, 'logs') }, 'Open log folder'))),
        h('p', { class: `${HINT} text-3`, text: `${CLOSING} does not stop the game.` })),
    ]
  }

  // What a Forge or NeoForge log says went wrong, as one sentence for the crash notice, or null.
  // The loader's own error screen names the mod; these are the shapes behind it. Forge before
  // 1.13 says the same things in other words, so each test takes both.
  const LOADER_CAUSES = [
    // Forge 1.12.2 and older on Java 9 or newer
    { test: /AppClassLoader cannot be cast to (?:class )?java\.net\.URLClassLoader/, say: (m, name) => `This ${name} needs Java 8, and the game ran on a newer Java. Set Java to Automatic under Edit setup.` },
    { test: /Mod ID: '(?:minecraft)', Requested by: '([\w.-]+)', Expected range: '([^']*)'/, say: (m, name, mc) => `The mod ${m[1]} is made for another Minecraft version (it wants ${m[2]}, and this setup is ${mc}). Get the build of it for ${mc}.` },
    { test: /Mod ID: '(?:forge|neoforge)', Requested by: '([\w.-]+)', Expected range: '([^']*)'/, say: (m, name) => `The mod ${m[1]} needs another ${name} build (${m[2]}). Pick one under Advanced in Edit setup.` },
    { test: /Found duplicate mods|DuplicateModsFoundException|Duplicate mods? found/i, say: () => 'The mods folder has two copies of one mod. Remove the older file.' },
    { test: /Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)'/, say: (m) => `The mod ${m[2]} needs ${m[1]}, which is missing or the wrong version. Put the right build of ${m[1]} in the mods folder.` },
    { test: /Missing or unsupported mandatory dependencies|MissingModsException|requires (?:mod )?[\w.-]+.*(?:missing|not installed)/i, say: () => 'A mod needs another mod that is missing or the wrong version. The game\u2019s error screen named it, and the log below does too.' },
    { test: /fabric\.mod\.json|quilt\.mod\.json|is an? (?:Fabric|Quilt) mod/i, say: (m, name) => `A mod in the mods folder is made for Fabric or Quilt. A ${name} setup loads ${name} mods only.` },
    { test: /MixinApplyError|InvalidMixinException|MixinTransformerError|Mixin apply (?:failed|for mod)/, say: () => 'A mod failed to patch the game, usually because two mods clash or one is made for another version.' },
  ]
  function loaderCrashCause(loader, lines, mc) {
    // no log read yet, or a game out of memory: the general line says it better
    if (!INSTALLER_LOADERS.includes(loader) || !lines.length || lines.some((l) => /OutOfMemoryError/.test(l))) return null
    const name = loaderName(loader)
    for (const cause of LOADER_CAUSES) {
      for (const line of lines) {
        const m = cause.test.exec(line)
        if (m) return cause.say(m, name, mc)
      }
    }
    return `${name} usually closes like this when a mod is missing, made for another Minecraft version, or made for another loader.`
  }

  // A game that ended without a Stop from here and was not simply closed. The panel's record of
  // the exit, when it has one, says how it ended; the log's last lines say why, as far as anything does.
  function crashNotice(crash) {
    const rec = crash.exit
    const p = profileNamed(crash.profile)
    const all = S.log.profile === crash.profile ? S.log.lines : []
    const lines = S.logMore ? all : all.slice(-LOG_LINES)
    const how = exitWords(rec, rec && clockTime(rec.endedAt))
    const cause = (p && loaderCrashCause(p.loader, all, p.mc)) || 'Usually a mod, not enough memory, or the wrong Java.'
    let text = `${how ? `${how} ` : ''}It was not stopped from here. ${cause} The last lines of its log:`
    if (crash.report && typeof crash.report === 'object') {
      text = crash.report.error ? `The report could not be made: ${crash.report.error}` : `Saved the report to ${crash.report.file} (${crash.report.sizeHuman}). Attach it to the bug report.`
    }
    const acts = [h('button', { class: BTN_SM, id: 'crashReport', disabled: crash.report === 'busy', onclick: () => reportProblem(crash) }, crash.report === 'busy' ? 'Collecting\u2026' : 'Report a problem')]
    // under the notice's words, lined up with them (past the icon and the gap after it)
    const pre = logBlock(lines, { id: 'crashLogPre', cls: `basis-full ml-[34px] w-[calc(100%-34px)] ${S.logMore ? 'max-h-80' : 'max-h-32'}` })
    const logActs = h('div', { class: 'flex gap-2 flex-wrap basis-full ml-[34px]' },
      h('button', { class: BTN_SM, id: 'copyCrash', disabled: !all.length, onclick: () => copyLines('crash', all) }, S.copied === 'crash' ? 'Copied' : 'Copy log'),
      all.length > LOG_LINES && h('button', { class: BTN_SM, id: 'crashMore', 'aria-expanded': String(S.logMore), 'aria-controls': 'crashLogPre', onclick: () => { S.logMore = !S.logMore; render() } }, S.logMore ? 'Show less' : `Show ${all.length} lines`),
      p && h('button', { class: BTN_SM, id: 'crashFolder', onclick: () => reveal(p, 'crash-reports') }, 'Show crash reports'),
      p && h('button', { class: BTN_SM, id: 'crashLogs', onclick: () => reveal(p, 'logs') }, 'Open log folder'))
    const title = `Minecraft ${rec && exitKind(rec) === 'abnormal' ? 'crashed' : 'closed'} ${ranFor(crash.seconds)} after it started`
    return notice({ tone: 'fault', title, text, acts, extra: [pre, logActs], onclose: () => { dropCrash(); nextExit(); render() } })
  }

  // Another setup's game crashed: said on the card in view, since the notice itself sits on its
  // own setup's card and would otherwise wait there unseen.
  function crashElsewhere(crash) {
    const q = profileNamed(crash.profile)
    return notice({ tone: 'fault', title: `Minecraft crashed in ${setupName(q)}`, text: 'Its log is on that setup\'s card.',
      acts: [h('button', { class: BTN_SM, id: 'crashShow', onclick: () => { pickProfile(crash.profile); render(); $('crashLogPre')?.focus({ preventScroll: true }) } }, 'Show')],
      onclose: () => { dropCrash(); nextExit(); render() } })
  }

  // The crash notice is done with: dismissed, or its game is being played again. What the panel
  // recorded is marked as shown there, so neither a reload nor the app's next start brings it back.
  function dropCrash() {
    seenExit(S.crash)
    S.crash = null
    S.logMore = false
  }

  // The mark is kept by the panel, with the record: the desktop app's page gets a new address at
  // every start, so nothing it stores itself is still there the next time. S.seenExits covers the
  // moment until the panel's answer carries the mark.
  function seenExit(c) {
    if (!c?.exit?.endedAt) return
    S.seenExits[c.profile] = c.exit.endedAt
    api(`client/profiles/${enc(c.profile)}/exit-seen`, { method: 'POST', body: { endedAt: c.exit.endedAt } }).catch(() => { /* it is told again after a reload, no worse */ })
  }

  // Lines to the clipboard, and the button says so for a moment.
  async function copyLines(what, lines) {
    const text = lines.join('\n')
    let ok = false
    try { await navigator.clipboard.writeText(text); ok = true } catch { /* no clipboard here: the old way */ }
    if (!ok) {
      const box = h('textarea', { style: 'position:fixed;left:-999px;top:0', 'aria-hidden': 'true' })
      box.value = text
      document.body.append(box)
      box.select()
      try { ok = document.execCommand('copy') } catch { /* nothing more to try */ }
      box.remove()
    }
    const back = () => $(what === 'live' ? 'copyLive' : 'copyCrash')?.focus({ preventScroll: true })
    if (!ok) {
      S.flash = { tone: 'warn', title: 'Could not copy', text: 'Select the lines and copy them by hand.' }
      render()
      return back()
    }
    S.copied = what
    render()
    back()
    setTimeout(() => { if (S.copied === what) { S.copied = null; render() } }, 2000)
  }

  // `cls` is its height
  function logBlock(lines, { id = null, label = 'The last lines of the game log', empty = 'The game left no log lines.', cls = 'w-full max-h-[220px]' } = {}) {
    const pre = h('pre', { class: `m-0 py-2 px-3 bg-sunken border border-line-soft rounded-xs font-mono font-normal text-2 leading-[1.55] text-console whitespace-pre overflow-auto ${cls}`, id, tabindex: '0', 'aria-label': label })
    lines.forEach((line, i) => {
      if (i) pre.append('\n')
      const m = LEVEL_RE.exec(line)
      if (!m) {
        pre.append(line)
        return
      }
      pre.append(line.slice(0, m.index), h('span', { class: m[1] === 'WARN' ? 'text-warn-ink' : 'text-fault-ink', text: m[1] }), line.slice(m.index + m[1].length))
    })
    if (!lines.length) pre.append(empty)
    return pre
  }

