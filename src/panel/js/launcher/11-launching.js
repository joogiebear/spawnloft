'use strict';
  // ---- launching -----------------------------------------------------------------------------

  async function startLaunch(p) {
    if (!S.summary) return render()
    // the fresh-install draft is not a setup yet: Play there makes one first
    if (p.name === FIRST) return firstPlay()
    const plan = launchPlan(p)
    if (plan.blocked) return render()
    if (plan.addrProblem) {
      render()
      return ($('joinAddress') ?? $('join'))?.focus()
    }
    if (!p.account && !defaultAccount()) {
      S.acctNotice = null
      return openMenu('ask')
    }
    const body = { jobId: newId() }
    if (plan.picked) {
      body.server = plan.picked.name
      if (plan.startsServer) body.startServer = true
    } else if (plan.address) {
      body.address = plan.address
    } else {
      body.server = false
    }
    // only this setup's crash is done with by playing it again
    if (S.crash?.profile === p.name) dropCrash()
    S.notice = null
    S.flash = null
    S.menu = null
    pickProfile(p.name)
    const job = { id: body.jobId, profile: p.name, stage: 'start', message: '', percent: null, reached: -1, startsServer: plan.startsServer, done: false }
    S.job = job
    stored('session', JOB_KEY, JSON.stringify({ id: job.id, profile: p.name, startsServer: plan.startsServer }))
    followJob(job, () => api(`client/profiles/${enc(p.name)}/launch`, { method: 'POST', body }))
    render()
  }

  // The stream first, then the POST: the stream replays the job's state when it opens, so the
  // page hears every event of a launch it started. `start` is null when picking up a launch this
  // tab started before a reload.
  function followJob(job, start) {
    const es = new EventSource(`/api/jobs/${enc(job.id)}/stream`)
    job.es = es
    let first = true
    es.onmessage = (e) => {
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (S.job !== job) return es.close()
      // The panel answers a job id it does not know with a blank start: after a restart (the
      // stream reconnects by itself) or for a launch picked up after a reload.
      const blank = ev.stage === 'start' && !ev.message
      if (first) {
        first = false
        if (start) {
          start().catch((err) => finishJob(job, { stage: 'error', done: true, message: err.message }))
        } else if (blank) {
          finishJob(job, null)
          return
        }
      } else if (blank && job.message) {
        finishJob(job, { stage: 'error', done: true, message: 'the panel restarted during the launch; check the setup, then play again' })
        return
      }
      job.stage = ev.stage
      job.message = ev.message
      if (ev.cancelling) job.cancelling = true
      job.percent = ev.percent ?? null
      job.reached = Math.max(job.reached, stepOf(ev.stage))
      if (ev.done) finishJob(job, ev)
      else render()
    }
    es.onerror = () => {
      if (!job.done && es.readyState === EventSource.CLOSED) finishJob(job, { stage: 'error', done: true, message: 'lost the connection to the panel; the launch may still be running' })
    }
  }

  function finishJob(job, ev) {
    if (job.done) return
    job.done = true
    job.es?.close()
    stored('session', JOB_KEY, null)
    if (S.job === job) S.job = null
    if (ev?.stage === 'running') {
      S.watch[job.profile] = { since: Date.now(), stopping: false }
      if (ev.warnings?.length) S.notice = { profile: job.profile, tone: 'warn', title: 'Playing, with a warning', text: ev.warnings.map(sentence).join(' ') }
    } else if (ev?.stage === 'cancelled' || ev?.code === 'cancelled') {
      S.notice = { profile: job.profile, ...cancelledNotice(job), at: Date.now() }
    } else if (ev && versionRefusal(ev)) {
      const p = profileNamed(job.profile)
      if (p) S.refusals[job.profile] = { mc: p.mc, message: ev.message }
    } else if (ev) {
      S.notice = { profile: job.profile, ...launchNotice(plain(ev.message)), at: Date.now() }
    }
    refresh()
  }

  // Stop asks first: the game closes where it stands. Focus goes to the choice that keeps it.
  function askStop(p) {
    S.stopAsk = p.name
    render()
    $('keepPlaying')?.focus({ preventScroll: true })
  }

  async function stopProfile(p) {
    S.stopAsk = null
    S.stopping = p.name
    if (S.watch[p.name]) S.watch[p.name].stopping = true
    render()
    $('stop')?.focus({ preventScroll: true })
    try {
      await api(`client/profiles/${enc(p.name)}/stop`, { method: 'POST' })
    } catch (err) {
      S.notice = { profile: p.name, tone: 'fault', title: `Couldn't stop ${setupTitle(p)}`, text: sentence(err.message) }
      if (S.watch[p.name]) S.watch[p.name].stopping = false
    }
    S.stopping = null
    // focus follows only if it is still where Stop left it
    const held = document.activeElement === $('stop') || document.activeElement === document.body
    await refresh()
    if (held && (document.activeElement === document.body || document.activeElement === $('stop'))) ($('play') ?? $('stop'))?.focus({ preventScroll: true })
  }

  // The setup's folder, or the folder the game keeps its logs or crash reports in, in the file
  // manager. The panel opens it (it runs on this computer); when it cannot, its answer says
  // where the folder is.
  async function reveal(p, what) {
    try {
      const out = await api(`client/profiles/${enc(p.name)}/reveal`, { method: 'POST', body: { what } })
      if (out?.fellBack && !S.sheet) {
        S.flash = { tone: '', title: what === 'crash-reports' ? 'The game has written no crash report' : 'The game has no log folder yet', text: 'The setup\'s own folder was opened instead.' }
        render()
      }
    } catch (err) {
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      const why = sentence(plain(err.message)) || (p.folder ? `It is ${p.folder}` : '')
      // the sheet covers the card, so the sheet says it while it is open
      if (S.sheet) S.sheet.error = `The folder could not be opened. ${why}`
      else S.flash = { tone: 'warn', title: 'The folder could not be opened', text: why }
      render()
    }
  }

  // "Show log" on a running game: its last lines, read again with every poll while it is open.
  function toggleLive(p) {
    S.live = S.live?.profile === p.name ? null : { profile: p.name, lines: [], read: false }
    render()
    $('liveLog')?.focus({ preventScroll: true })
    if (S.live) readLive().then(render)
  }

  async function readLive() {
    const live = S.live
    if (!live) return
    if (!profileNamed(live.profile)?.running) { S.live = null; return }
    try {
      const out = await api(`client/profiles/${enc(live.profile)}/log?lines=${LOG_SCAN}`)
      if (S.live === live) { live.lines = out.lines ?? []; live.read = true }
    } catch { /* the next poll tries again */ }
  }

  async function reportProblem(crash) {
    crash.report = 'busy'
    render()
    try {
      crash.report = await api(`client/profiles/${enc(crash.profile)}/diag`, { method: 'POST' })
    } catch (err) {
      crash.report = { error: err.message }
    }
    render()
  }

