'use strict';
  // ---- pure helpers (test/launcher-page.test.mjs lifts these by name) ----------------------

  // Which step of the strip a job stage belongs to; -1 is "Preparing…".
  function stepOf(stage) {
    // the version file comes first: the Java is read from it
    if (stage === 'manifest' || stage === 'version') return 0
    if (stage === 'java') return 1
    if (['client', 'libraries', 'assets', 'natives', 'fabric', 'quilt', 'forge', 'neoforge', 'harness'].includes(stage)) return 2
    if (stage === 'server') return 3
    if (stage === 'spawn' || stage === 'running') return 4
    return -1
  }

  // "Downloading libraries · 212 of 1,049 files · 143 MB" -> the headline and the facts after it.
  function splitMessage(message) {
    const text = String(message ?? '')
    const at = text.indexOf(' · ')
    return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 3)]
  }

  // The panel's parseServerAddress, as a hint while typing; the launch checks it again.
  function addressProblem(text) {
    const raw = String(text ?? '').trim()
    if (!raw) return 'Type the address of the server to join.'
    const bad = 'That doesn\'t look like a server address. Use a host name or IP, optionally with :port.'
    if (raw.length > 260) return bad
    let host
    let port = null
    const v6 = /^\[([^\]]+)\](?::([^:]*))?$/.exec(raw)
    if (v6) {
      host = v6[1]
      port = v6[2] ?? null
      if (!/^[0-9A-Fa-f:.]+$/.test(host) || !host.includes(':')) return bad
    } else {
      const parts = raw.split(':')
      if (parts.length > 2) return bad
      host = parts[0]
      port = parts[1] ?? null
      if (host.length > 253 || !HOSTNAME_RE.test(host)) return bad
    }
    if (port !== null && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return 'The port must be a number from 1 to 65535.'
    return null
  }

  // Who a launch from here plays as: the profile's own account beats the default account
  // (CLIENT.md, account precedence); with neither it is an offline player named by the panel.
  function playAccount(profile, accounts, defaultAccount) {
    if (profile.account) {
      if (!profile.accountType) return { name: profile.accountName ?? profile.account, type: null, missing: true }
      const stored = accounts.find((a) => a.uuid === profile.accountUuid)
      return { name: profile.accountName, type: profile.accountType, expired: Boolean(stored?.refreshFailedAt) }
    }
    const def = accounts.find((a) => a.uuid === defaultAccount)
    if (def) return { name: def.name, type: def.type, expired: Boolean(def.refreshFailedAt) }
    return { name: null, type: 'offline' }
  }

  // Every SpawnLoft server as a setup sees it: `otherVersion` on the ones that run another version
  // (Join lists only the rest), `blocked` on an online-mode server for an offline player.
  // The mod loader a server needs on the player's side: a Fabric or NeoForge server's own, else null.
  function serverLoader(s) {
    return s?.loader === 'fabric' || s?.loader === 'neoforge' ? s.loader : null
  }

  // Whether a setup on `setupLoader` matches a server that runs `needs` (serverLoader's answer).
  // Quilt loads Fabric's mods, so a Quilt setup matches a Fabric server.
  function loaderFits(needs, setupLoader) {
    if (!needs) return true
    if (needs === 'fabric') return setupLoader === 'fabric' || setupLoader === 'quilt'
    return setupLoader === needs
  }

  function serverChoices(profile, servers, accountType) {
    return servers.map((s) => ({
      name: s.name,
      label: s.label,
      mc: s.mc,
      status: s.status,
      stopped: STOPPED.has(s.status),
      otherVersion: s.mc && s.mc !== profile.mc ? s.mc : null,
      // the loader the server runs, and that one again when this setup is on another: a warning,
      // not a block, since a server whose mods are all server-side lets anyone in
      loader: serverLoader(s),
      otherLoader: loaderFits(serverLoader(s), profile.loader) ? null : serverLoader(s),
      blocked: s.onlineMode === true && accountType !== 'microsoft' ? 'needs a Microsoft account' : null,
    }))
  }

  // How a picker row names what it is: the panel's kind, else Mojang's type.
  const KIND_LABELS = { 'pre-release': 'pre-release', 'release-candidate': 'release candidate', snapshot: 'snapshot', beta: 'beta', alpha: 'alpha', old_beta: 'beta', old_alpha: 'alpha' }
  function kindLabel(row) {
    const kind = row.kind ?? row.type
    return KIND_LABELS[kind] ?? kind
  }

  // The version picker's rows: releases, then snapshots too, then everything.
  function versionRows(versions, show) {
    if (show === 'all') return versions
    if (show === 'snapshot') return versions.filter((v) => v.type === 'release' || v.type === 'snapshot')
    return versions.filter((v) => v.type === 'release')
  }

  // The version list as the sheet shows it: { rows, more }. With nothing typed, the rows of the
  // tab (`show`); with something typed, every version whose id has it, whatever the tab, so
  // "24w" finds a snapshot from the Releases tab. Newest first as the panel sends them, ids that
  // start with what was typed before ids that only contain it. `more` is how many were left out
  // by `cap`: a long list is narrowed by typing, not by scrolling through a thousand rows.
  function pickerRows(versions, show, query, cap = VERSION_CAP) {
    const q = String(query ?? '').trim().toLowerCase()
    let rows
    if (!q) rows = versionRows(versions, show)
    else {
      const has = versions.filter((v) => v.id.toLowerCase().includes(q))
      rows = [...has.filter((v) => v.id.toLowerCase().startsWith(q)), ...has.filter((v) => !v.id.toLowerCase().startsWith(q))]
    }
    return { rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap) }
  }

  // The marks beside a version: [{ text, tone }]. What it is (unless a plain release), whether it
  // is the newest release, and whether it is already on this computer.
  function versionBadges(row, latestId) {
    const out = []
    if (row.id === latestId) out.push({ text: 'Latest', tone: 'live' })
    if (row.type && row.type !== 'release') out.push({ text: kindLabel(row).replace(/^./, (c) => c.toUpperCase()), tone: '' })
    if (row.downloaded) out.push({ text: 'Downloaded', tone: 'accent' })
    return out
  }

  // The row the arrow keys land on next among `rows`, skipping the ones that cannot be picked;
  // -1 when none can. `at` is the row they are on (-1: none yet), `step` 1 or -1.
  function nextPickable(rows, at, step, blocked) {
    const ok = rows.map((r, i) => (blocked(r) ? -1 : i)).filter((i) => i !== -1)
    if (!ok.length) return -1
    if (at === -1) return step > 0 ? ok[0] : ok[ok.length - 1]
    const after = step > 0 ? ok.find((i) => i > at) : [...ok].reverse().find((i) => i < at)
    return after ?? (step > 0 ? ok[0] : ok[ok.length - 1])
  }

  // Memory against this computer: { total, tooMuch(choice), warn, line }. `total` is its memory
  // in half gigabytes (null when the panel did not say); a choice above it cannot be picked; one
  // above three quarters of it gets a warning, since the game's Java takes more than it is
  // given and everything else needs room too. `line` says what the computer has.
  function memoryAdvice(memory, machine) {
    const totalBytes = Number(machine?.totalMemory)
    // a computer sold with 8 GB says 7.7: it is counted as the 8 it was sold as
    const real = totalBytes / 1024 ** 3
    const total = totalBytes > 0 ? Math.ceil(real) : null
    const gb = memoryGb(memory)
    const tooMuch = (choice) => total !== null && (memoryGb(choice) ?? 0) > total
    let warn = null
    if (total !== null && gb !== null) {
      const safer = Math.max(1, Math.floor(total / 2))
      if (gb > total) warn = `This computer has ${gbText(totalBytes)} of memory, less than the ${memoryText(memory)} this setup is given. The game may not start.`
      else if (gb > real * 0.75) warn = `That is most of this computer's ${gbText(totalBytes)}. The game and everything else open may slow down${safer < gb ? `; ${memoryText(memoryFromGb(safer))} is a safer choice` : ''}.`
    }
    const line = total === null ? 'Most setups need 2 to 4 GB.' : machine.freeMemory ? `This computer has ${gbText(machine.freeMemory)} free of ${gbText(totalBytes)}.` : `This computer has ${gbText(totalBytes)}.`
    return { total, tooMuch, warn, line }
  }

  // The Java list of the setup sheet: [{ value, text }]. Automatic, Mojang's own, each Java found
  // on this computer, the setup's saved path if it is none of those, and "Another Java…".
  function javaChoices(javas, current) {
    const out = [{ value: '', text: 'Automatic (recommended)' }, { value: 'mojang', text: 'Mojang\'s own Java for the version' }]
    for (const j of javas ?? []) {
      const what = `Java ${j.major ?? '?'}${j.arch ? ` (${j.arch})` : ''}`
      out.push({ value: j.path, text: j.path === 'java' ? `${what} · the one programs find first` : `${what} · ${j.path}` })
    }
    if (current && !out.some((o) => o.value === current)) out.push({ value: current, text: current })
    out.push({ value: JAVA_OTHER, text: 'Another Java\u2026' })
    return out
  }

  // A Java against what a version needs: a sentence when it will not do or may not, else null.
  // `needs` is { min, max } from the version's own file, or { min, guess: true } from its id.
  function javaFit(major, needs, mc) {
    if (!major || !needs?.min) return null
    if (major < needs.min) return needs.guess ? `${mc} probably needs Java ${needs.min} or newer, and this is Java ${major}.` : `${mc} needs Java ${needs.min}${needs.max === needs.min ? '' : ' or newer'}, and this is Java ${major}. Play will refuse it.`
    if (needs.max && major > needs.max) return `${mc} wants Java ${needs.max === needs.min ? needs.max : `${needs.min} to ${needs.max}`}, and this is Java ${major}, which is newer. The game may not start.`
    return null
  }

  // An offline name as the panel takes it; what is wrong with one being typed, or null.
  function offlineNameProblem(name) {
    const text = String(name ?? '')
    if (!text) return null
    if (/[^A-Za-z0-9_]/.test(text)) return 'Only letters, digits and underscore.'
    if (text.length < 3) return 'At least 3 characters.'
    if (text.length > 16) return 'At most 16 characters.'
    return null
  }
  function offlineNameOk(name) {
    return /^[A-Za-z0-9_]{3,16}$/.test(String(name ?? ''))
  }

  // Whose game the setup in view starts when that is not the account the chip names: the
  // setup's own "Play as". null when they are the same, or the setup has none.
  function setupPlaysAs(profile, def) {
    // an account that was signed out since has no type: there is no player to name
    if (!profile?.account || !profile.accountName || !profile.accountType) return null
    if (profile.accountUuid && profile.accountUuid === def?.uuid) return null
    // a setup set to an offline name, which is also who is signed in
    if (!profile.accountUuid && profile.accountType === 'offline' && def?.type === 'offline' && def.name === profile.accountName) return null
    return profile.accountName
  }

  // What a failed launch looks like on the Play screen. `fix` names the one control that helps.
  function launchNotice(message) {
    const text = String(message ?? 'the launch failed')
    if (/is being launched|is already starting/.test(text)) {
      return { tone: 'warn', title: `Another launch is already in progress: ${text}`, text: 'This page checks again every few seconds and unlocks when it finishes.', busy: true }
    }
    if (/requires a Microsoft account/.test(text)) {
      return { tone: 'fault', title: `Can't play: ${text.replace(/; sign in or pick another server$/, '')}`, text: 'Sign in with a Microsoft account, or join another server.', fix: 'sign-in' }
    }
    return { tone: 'fault', title: 'Can\'t play', text: sentence(text) }
  }

  // A launch refused for the version itself (the all-versions plan's strict mode: a launcher
  // format, rule or setting this SpawnLoft does not know) stays refused until the setup changes,
  // so Play is greyed with the panel's own words rather than offered again.
  function versionRefusal(ev) {
    if (STRICT_CODES.includes(ev?.code)) return true
    return /\bUpdate SpawnLoft\.?$/.test(String(ev?.message ?? ''))
  }

  // Why Play is greyed for a setup, or null. `c` is { profile, acct, picked, anyway, machineRefusal,
  // busy, otherJob, refusal }. The reason is sentence parts, like playSentence's; `fix` names
  // the controls that help, in order.
  function blockReason(c) {
    if (c.machineRefusal) return { reason: ['Minecraft can\'t be launched on this computer: ', sentence(c.machineRefusal).replace(/\.?$/, '.')], fix: [] }
    if (c.refusal) return { reason: [sentence(c.refusal).replace(/\.?$/, '.')], fix: ['edit'] }
    if (c.busy) return { reason: ['Another launch of this setup is already under way. Play unlocks when it finishes.'], fix: [] }
    if (c.otherJob) return { reason: [{ b: c.otherJobName ?? 'Another setup' }, ' is launching. Play unlocks when it finishes.'], fix: c.otherJobName ? ['show-launching'] : [] }
    const own = Boolean(c.profile.account)
    if (c.acct.missing) return { reason: ['This setup plays as ', { b: c.acct.name }, ', who is no longer signed in.'], fix: ['pick-account', 'sign-in'] }
    if (c.acct.expired) return { reason: [own ? 'This setup plays as ' : 'You play as ', { b: c.acct.name }, ', whose saved sign-in no longer works.'], fix: ['sign-in-again', own ? 'pick-account' : 'switch-account'] }
    if (c.picked?.blocked) return { reason: [{ b: c.picked.name }, ' needs a Microsoft account, and this setup plays as ', { b: c.acct.name ?? 'an offline player' }, '.'], fix: ['sign-in', 'title-screen'] }
    // the server would turn the game away after the whole download; `anyway` is the player saying
    // this server takes other versions, which SpawnLoft cannot see
    if (c.picked?.otherVersion && c.anyway !== c.picked.name) {
      return { reason: [{ b: c.picked.label || c.picked.name }, ' runs Minecraft ', { b: c.picked.otherVersion }, ', and this setup is ', { b: c.profile.mc }, '.'], fix: ['other-setup', 'title-screen', 'anyway'], other: { mc: c.picked.otherVersion, server: c.picked.name } }
    }
    return null
  }

  // What the Play screen shows: 'unreachable', 'loading', 'first-run', 'launching', 'running',
  // 'blocked' (with blockReason's reason and fix), 'closed-early' (a crash, however long the game
  // ran: Play reads "Play again") or 'ready'.
  function playState(c) {
    if (c.down) return { kind: 'unreachable' }
    if (!c.loaded) return { kind: 'loading' }
    if (!c.profile) return { kind: 'first-run' }
    if (c.job) return { kind: 'launching' }
    if (c.profile.running) return { kind: 'running' }
    const blocked = blockReason(c)
    if (blocked) return { kind: 'blocked', ...blocked }
    return { kind: c.crashed ? 'closed-early' : 'ready' }
  }

  // Something went wrong in these log lines: an ERROR or FATAL line (the level is read from its
  // bracket, not the word, so an INFO line about an "error" is not one), a stack trace (its lines
  // count too, in case the trace is long enough to push its header out of view), a JVM fault or a
  // crash report.
  function crashSigns(lines) {
    const wrong = /\/(ERROR|FATAL)\]:|^\s+at [\w.$<>/]+\(|^Caused by: |Exception in thread|fatal error has been detected|crash report/i
    return lines.some((l) => wrong.test(l))
  }

  // The game said it was stopping: Minecraft's own "Stopping!" is among the last lines.
  function saidStopping(lines) {
    return lines.filter((l) => l.trim()).slice(-10).some((l) => /\]: Stopping!\s*$/.test(l))
  }

  // A game that was closed, not one that crashed: the log ends in Minecraft's own "Stopping!" and
  // nothing in it went wrong. Such an exit gets no callout, however soon after Play it came.
  function cleanExit(lines) {
    const tail = lines.filter((l) => l.trim())
    if (!tail.length) return false
    if (crashSigns(tail)) return false
    return saidStopping(tail)
  }

  // What an exit this page did not ask for was, from the game's log: 'closed' (no callout) or
  // 'crash' (the callout with the log's last lines). Within the first minute, anything but a clean
  // exit is a crash: the game did not get to a title screen anyone could have quit from. Later, a
  // routine ERROR line somewhere in a long session is no crash; what counts is whether the game
  // said it was stopping at the end. That catches a hard kill and a mod loader's error dialog
  // closed after any wait, and never a game quit after an evening's play.
  function exitVerdict(lines, early) {
    if (early) return cleanExit(lines) ? 'closed' : 'crash'
    return saidStopping(lines) ? 'closed' : 'crash'
  }

  // Which watched games ended without a Stop from this page. `watch` is { name: { since, stopping } };
  // answers [{ name, seconds, early }], early meaning within CRASH_WINDOW_MS of starting, and changes
  // `watch`: running games join it, ended ones leave it.
  function watchedExits(watch, profiles, now) {
    const out = []
    for (const row of profiles) {
      if (!row.running) continue
      // a run that ended and another that began between two reads: the watch moves to the new
      // run, or its end would be measured from, and matched against, the old one's start
      const other = watch[row.name]?.startedAt && row.startedAt && watch[row.name].startedAt !== row.startedAt
      if (!watch[row.name] || other) watch[row.name] = { since: Date.parse(row.startedAt) || now, stopping: false }
      // which run it is, so the panel's record of its end can be told from an older one
      if (!watch[row.name].startedAt && row.startedAt) watch[row.name].startedAt = row.startedAt
    }
    for (const [name, w] of Object.entries(watch)) {
      const row = profiles.find((p) => p.name === name)
      if (row?.running) continue
      delete watch[name]
      const lived = now - w.since
      // `watch` goes along: a record written a moment after this read is looked for once more
      if (row && !w.stopping) out.push({ name, seconds: Math.max(1, Math.round(lived / 1000)), early: lived < CRASH_WINDOW_MS, exit: recordedExit(row.lastExit, w), watch: { since: w.since, startedAt: w.startedAt } })
    }
    return out
  }

  // The panel's record of how a watched run ended ({ code, signal, startedAt, endedAt, stopped }),
  // or null when it has none for that run: a game that outlived the panel that started it ends
  // with nobody there to write one. A run that was gone before any poll saw it has no start time
  // here, so its record is the one written since the launch.
  function recordedExit(rec, w) {
    if (!rec || typeof rec !== 'object' || typeof rec.endedAt !== 'string') return null
    if (w.startedAt) return rec.startedAt === w.startedAt ? rec : null
    return Date.parse(rec.endedAt) >= w.since - 2000 ? rec : null
  }

  // What a recorded exit was: 'stopped' (asked for, however it then ended), 'clean' (the game
  // exited by itself with code 0) or 'abnormal' (any other code, or a signal).
  function exitKind(rec) {
    if (rec.stopped) return 'stopped'
    return rec.code === 0 && !rec.signal ? 'clean' : 'abnormal'
  }

  // Crash or not, from the record when there is one. An abnormal end is a crash unless the log
  // shows the game closing with nothing wrong in it: a game that said "Stopping!" and then went
  // down in a driver on its way out, or was ended from outside as it closed, was quit, and whoever
  // quit it is not helped by a crash notice. A clean end is a crash only in the first minute and
  // only if the log does not show the game closing (a mod loader's error window, closed, can exit
  // with 0). With no record the log decides alone, as before the panel kept one.
  function crashVerdict(rec, lines, early) {
    if (!rec) return exitVerdict(lines, early)
    const kind = exitKind(rec)
    if (kind === 'stopped') return 'closed'
    if (kind === 'abnormal') return cleanExit(lines) ? 'closed' : 'crash'
    return early && !cleanExit(lines) ? 'crash' : 'closed'
  }

  // "It ended at 21:03 with exit code 1.", "It was ended by SIGKILL at 21:03." `at` is the time
  // as the page shows times.
  function exitWords(rec, at) {
    if (!rec) return ''
    if (rec.signal) return `It was ended by ${rec.signal} at ${at}.`
    // Windows' own fault codes are known by their hex (0xC0000005), not as ten digits
    const code = Number.isInteger(rec.code) ? (rec.code > 0x7fffffff ? `0x${rec.code.toString(16).toUpperCase()}` : String(rec.code)) : null
    return `It ended at ${at}${code ? ` with exit code ${code}` : ''}.`
  }

  // Crashes the panel recorded that this page has not shown: a game that went down while the page
  // was closed, or whose notice was still up when the page was reloaded. Only what the record
  // itself calls abnormal, and only recent ones: an old one says nothing about today. Not one
  // the panel has marked as shown (rec.seen) or this page has (`seen`, { profile: endedAt }), and
  // not one from before the setup's last run: a game started since (outside the panel, or one
  // that outlived it) left no record of its own, and its log is not that crash's.
  function unseenCrashes(profiles, seen, now) {
    const out = []
    for (const row of profiles) {
      const rec = row.lastExit
      if (row.running || !rec || typeof rec.endedAt !== 'string' || rec.seen || exitKind(rec) !== 'abnormal') continue
      if (row.played?.lastPlayedAt && rec.startedAt && row.played.lastPlayedAt !== rec.startedAt) continue
      const ended = Date.parse(rec.endedAt)
      if (!Number.isFinite(ended) || now - ended > CRASH_REPLAY_MS || ended > now + 60000 || seen[row.name] === rec.endedAt) continue
      const lived = Math.max(0, ended - (Date.parse(rec.startedAt) || ended))
      out.push({ name: row.name, seconds: Math.max(1, Math.round(lived / 1000)), early: lived < CRASH_WINDOW_MS, exit: rec })
    }
    return out
  }

  // "under a minute", "12 minutes", "1 hour 5 minutes": how long a game has been running.
  function playingFor(ms) {
    const minutes = Math.floor(ms / 60000)
    if (minutes < 1) return 'under a minute'
    if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`
    return ranFor(minutes * 60)
  }

  // How long the game ran, for the crash notice: seconds up to two minutes, then minutes, then hours.
  function ranFor(seconds) {
    const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
    if (seconds < 120) return n(seconds, 'second')
    const minutes = Math.round(seconds / 60)
    if (minutes < 120) return n(minutes, 'minute')
    const hours = Math.floor(minutes / 60)
    return minutes % 60 ? `${n(hours, 'hour')} ${n(minutes % 60, 'minute')}` : n(hours, 'hour')
  }

  // The keys the Edit sheet changed, as PATCH sends them. A running profile keeps the keys that
  // make up its command line (the panel refuses them too); a new version alone lets the panel
  // pick a loader build for it.
  function profilePatch(before, next) {
    const patch = {}
    for (const [k, val] of Object.entries(next)) {
      if ((before[k] ?? null) !== val) patch[k] = val
    }
    if (patch.mc !== undefined && patch.loaderVersion === undefined) delete patch.loaderVersion
    if (before.running) for (const k of ['mc', 'loader', 'loaderVersion', 'java', 'memory', 'harness']) delete patch[k]
    return patch
  }

  // The value a stored account has in a setup's "Play as" list: its uuid, or the setup's own
  // "offline:<name>" key when that key names this offline account, so it is listed once.
  function accountValue(account, current) {
    return account.type === 'offline' && current === `offline:${account.name}` ? current : account.uuid
  }

  // The Mods choices in the sheet's order, by the names a person sees. COMING are listed and
  // greyed out until SpawnLoft can set them up.
  const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }
  const MOD_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge']
  const COMING = []
  // the loaders set up by an installer, whose builds the sheet lists in Advanced
  const INSTALLER_LOADERS = ['forge', 'neoforge']

  function loaderName(loader) {
    return Object.hasOwn(LOADER_NAMES, loader) ? LOADER_NAMES[loader] : 'Vanilla'
  }

  function modded(loader) {
    return MOD_LOADERS.includes(loader)
  }

  // The name a setup gets when nobody gives it one: its version, made into a profile name
  // ("1.21.11" -> "1-21-11", "-fabric" for Fabric, "-quilt" for Quilt), then -2, -3... past the
  // names already taken.
  function nameBase(mc, loader) {
    let base = String(mc ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '').slice(0, 21)
    if (!base) base = 'setup'
    return modded(loader) ? `${base}-${loader}` : base
  }

  function autoName(mc, loader, taken) {
    const base = nameBase(mc, loader)
    const used = new Set(taken.map((n) => n.toLowerCase()))
    if (!used.has(base.toLowerCase())) return base
    for (let i = 2; ; i++) if (!used.has(`${base}-${i}`.toLowerCase())) return `${base}-${i}`
  }

  // The name a person gave a setup, or null when it is the one autoName made for it.
  function givenName(p) {
    const base = nameBase(p.mc, p.loader).toLowerCase()
    const name = String(p.name ?? '')
    const low = name.toLowerCase()
    return low === base || (low.startsWith(base) && /^-\d+$/.test(low.slice(base.length))) ? null : name
  }

  // A setup by what it is: "1.21.11 · Vanilla", "1.21.1 · Fabric", "1.20.1 · Quilt".
  function setupTitle(p) {
    return `${p.mc} · ${loaderName(p.loader)}`
  }

  // The line under the Play button, as text and bold parts: [ 'Opens ', { b: 'Minecraft 1.21.11' }, ... ].
  // `o` is { mc, loader, who, server, address, startsServer } (fabric: true still means Fabric).
  function playSentence(o) {
    const { mc, who, server, address, startsServer } = o
    const loader = o.loader ?? (o.fabric ? 'fabric' : 'vanilla')
    const what = { b: `Minecraft ${mc}${modded(loader) ? ` (${loaderName(loader)})` : ''}` }
    const as = { b: who ?? 'an offline player' }
    if (server && startsServer) return ['Starts ', { b: server }, ' first (up to 2 minutes), then opens ', what, ' and joins it as ', as, '.']
    if (server) return ['Opens ', what, ' and joins ', { b: server }, ' as ', as, '.']
    if (address) return ['Opens ', what, ' and joins ', { b: address }, ' as ', as, '.']
    return ['Opens ', what, ' on the title screen as ', as, '.']
  }

  // What the core says is written for a terminal as often as not: it names commands to run and a
  // log file to read. Here it is said for someone looking at a Play button. Anything not listed is
  // passed on as it is.
  const PLAIN = [
    [/^profile "(.+?)" is running; stop it (?:first|before changing .+?): spawnloft client stop .+$/, (m) => `\u201c${m[1]}\u201d is running. Close the game first, then try again.`],
    [/^profile "(.+?)" is being launched \(pid [^)]*\); wait for it(?: before changing .+)?$/, (m) => `\u201c${m[1]}\u201d is already starting. Give it a moment, then try again.`],
    [/^invalid profile name ".*" - use letters, digits, dash, underscore \(max 32 chars\)$/s, () => 'That name will not work. Use letters, digits, dashes and underscores, 32 at most.'],
    [/^the saved sign-in for (.+?) no longer works; run spawnloft client login again$/, (m) => `The saved sign-in for ${m[1]} no longer works. Sign in again from the account menu.`],
    [/^the code expired before it was entered; run spawnloft client login again$/, () => 'The sign-in ran out of time. Try again.'],
    [/^Microsoft's sign-in server stopped answering \(.*\); run spawnloft client login again in a few minutes$/s, () => 'Microsoft\u2019s sign-in server stopped answering. Try again in a few minutes.'],
    [/^Minecraft refused the sign-in \(HTTP 403\)/, () => 'Minecraft refused the sign-in for this copy of SpawnLoft. Nothing is wrong with your account. You can still play offline on local servers.'],
    [/^the account could not be saved; see panel\.log$/, () => 'The account could not be saved. Try signing in again.'],
    [/^the sign-in failed inside SpawnLoft; see panel\.log$/, () => 'The sign-in failed inside SpawnLoft. Try again.'],
  ]
  function plain(message) {
    const text = String(message ?? '')
    for (const [test, say] of PLAIN) {
      const m = test.exec(text)
      if (m) return say(m)
    }
    return text
  }

  /** One sentence for an answer that carried a status and no words. */
  function plainStatus(status) {
    if (status === 401 || status === 403) return 'This page is no longer signed in to SpawnLoft. Open the launcher again from the SpawnLoft app.'
    if (status >= 500) return `SpawnLoft hit a problem (error ${status}). Try again in a moment.`
    return `SpawnLoft refused that without saying why (error ${status}).`
  }

  function sentence(text) {
    const s = String(text ?? '').trim()
    return s ? s[0].toUpperCase() + s.slice(1) : s
  }

  function initials(name) {
    return String(name ?? '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '?'
  }

  // One of the four tile colours, the same for an account every time.
  function tileClass(key) {
    let n = 0
    for (const ch of String(key ?? '')) n = (n * 31 + ch.charCodeAt(0)) >>> 0
    return 't' + ((n % 4) + 1)
  }

  function memoryText(memory) {
    const m = /^(\d+)([MG])$/i.exec(String(memory ?? ''))
    if (!m) return String(memory ?? '')
    return m[2].toUpperCase() === 'G' ? `${m[1]} GB` : `${m[1]} MB`
  }

  // "1536M" -> 1.5, "4G" -> 4; null when it is neither.
  function memoryGb(memory) {
    const m = /^(\d+)([MG])$/i.exec(String(memory ?? ''))
    if (!m) return null
    return m[2].toUpperCase() === 'G' ? Number(m[1]) : Math.round((Number(m[1]) / 1024) * 2) / 2
  }

  // The slider's gigabytes as the panel writes memory: whole ones in G, halves in M.
  function memoryFromGb(gb) {
    const half = Math.max(1, Math.round(Number(gb) * 2) / 2)
    return Number.isInteger(half) ? `${half}G` : `${half * 1024}M`
  }

  // A new setup's memory: 2 GB for Vanilla, 4 GB with any mod loader (mods want more).
  function defaultMemory(loader) {
    return modded(loader) ? '4G' : '2G'
  }

  // The facts line under the version field, from the picker row and the version's details when
  // the panel has them (javaNeeds, loaders, harness, emulated); a fact nobody knows is left out.
  function versionFacts(row, details) {
    const d = { ...(row ?? {}), ...(details ?? {}) }
    const out = []
    // a guess from the id until the version's file has been read
    if (d.javaNeeds) out.push(d.javaNeedsExact === false ? `likely Java ${d.javaNeeds}` : `Java ${d.javaNeeds}`)
    // the loaders that build for it; a panel from before the loader list says only Fabric's
    const loaders = d.loaders && typeof d.loaders === 'object' ? d.loaders : { fabric: d.fabric }
    const known = MOD_LOADERS.filter((l) => loaders[l] === true || loaders[l] === false)
    const has = known.filter((l) => loaders[l] === true)
    if (has.length) out.push(`${has.map(loaderName).join(', ')} available`)
    else if (known.length === 1) out.push(`no ${loaderName(known[0])}`)
    else if (known.length) out.push('no mod loaders')
    if (d.harness === true) out.push('helper mod available')
    else if (d.harness === false) out.push('no helper mod yet')
    if (d.emulated) out.push('runs under emulation')
    return out
  }

  function gbText(bytes) {
    const gb = Number(bytes) / 1024 ** 3
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
  }

  function loaderText(profile) {
    if (!modded(profile.loader)) return 'Vanilla'
    return profile.loaderVersion ? `${loaderName(profile.loader)} ${profile.loaderVersion}` : loaderName(profile.loader)
  }

  // Why a loader cannot be picked for a version, or null: it is not in this SpawnLoft yet, or the
  // version facts say it has no build there. info is what the panel knows of the version.
  function loaderBlock(loader, mc, info) {
    if (!modded(loader)) return null
    if (COMING.includes(loader)) return `${loaderName(loader)} is coming in a later SpawnLoft.`
    if (loader === 'forge' && forgeTooOld(mc)) return 'SpawnLoft offers Forge from Minecraft 1.6.4 on.'
    const has = info?.loaders && typeof info.loaders === 'object' ? info.loaders[loader] : loader === 'fabric' ? info?.fabric : undefined
    return has === false ? `${loaderName(loader)} has no build for ${mc}.` : null
  }

  // Minecraft 1.6.3 and older, where Forge patched the game jar itself
  function forgeTooOld(mc) {
    const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc ?? ''))
    return Boolean(m) && (Number(m[1]) < 6 || (Number(m[1]) === 6 && Number(m[2] ?? 0) < 4))
  }

  // Forge on 1.6.4 to 1.12.2 other than 1.7.10 and 1.12.2: offered, not started by hand (design Q1)
  function forgeUntested(loader, mc) {
    const m = /^1\.(\d+)(?:\.\d+)?$/.exec(String(mc ?? ''))
    return loader === 'forge' && Boolean(m) && Number(m[1]) < 13 && !forgeTooOld(mc) && mc !== '1.7.10' && mc !== '1.12.2'
  }

  // The line under the Mods choice: why the pick cannot be used, else what it does.
  function loaderHint(loader) {
    if (!modded(loader)) return 'None is plain Minecraft, also called Vanilla. Pick a mod loader to play with mods.'
    const first = INSTALLER_LOADERS.includes(loader) ? ` The first Play sets ${loaderName(loader)} up, which takes a minute or two.` : ''
    return `${loaderName(loader)} loads mods. Put them in the mods folder inside the setup\u2019s folder.${first}`
  }

  // Said in the sheet when an existing setup's loader is changed: its mods were made for the old one.
  function loaderChangeWarning(from, to) {
    if (!modded(from) || from === to) return null
    if (!modded(to)) return `The mods in this setup\u2019s folder were made for ${loaderName(from)} and will not load without it. Duplicate the setup to keep both.`
    return `The mods in this setup\u2019s folder were made for ${loaderName(from)} and will not load on ${loaderName(to)}. Duplicate the setup to keep both.`
  }

  function statusText(status) {
    return sentence(String(status ?? 'unknown'))
  }

  // "today", "yesterday", "5 days ago", then a date: when a setup was last played.
  function dayWords(iso, now = Date.now()) {
    const t = new Date(iso)
    if (Number.isNaN(t.getTime())) return ''
    const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000)
    if (days <= 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 30) return `${days} days ago`
    return t.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
  }

  // "12 min", "3 h 20 min", "41 h": time played, as coarse as it is long.
  function playedWords(ms) {
    const min = Math.floor(ms / 60000)
    if (min < 1) return ''
    if (min < 60) return `${min} min`
    const hours = Math.floor(min / 60)
    return hours < 10 && min % 60 ? `${hours} h ${min % 60} min` : `${hours} h`
  }

  // "Played today · 3 h 20 min in all", or "Never played".
  function playedLine(p) {
    const rec = p.played
    if (p.running) return 'Running now'
    // no record is not "never": setups older than the record were played without one
    if (!rec?.lastPlayedAt) return ''
    const total = playedWords(rec.totalMs ?? 0)
    return `Played ${dayWords(rec.lastPlayedAt)}${total ? ` · ${total} in all` : ''}`
  }

  function clockTime(iso) {
    const t = new Date(iso)
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

