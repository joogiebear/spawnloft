'use strict';
  // ---- the poll ------------------------------------------------------------------------------

  // after something this page did: show it now, then read the panel again
  function refresh() {
    render()
    return poll()
  }

  let pollTimer = null
  let polling = null

  // One read of the launcher summary every few seconds (and right after anything this page
  // changes), plus the log of a game that closed early. Re-renders only on a change, so a field
  // being typed in is not rebuilt for nothing.
  // A call while a read is under way gets one more read after it: that read began before
  // whatever the caller just changed.
  let pollAgain = false
  function poll() {
    clearTimeout(pollTimer)
    if (polling) {
      pollAgain = true
      return polling
    }
    polling = (async () => {
      do {
        pollAgain = false
        await pollOnce()
      } while (pollAgain)
    })().finally(() => {
      polling = null
      clearTimeout(pollTimer)
      pollTimer = setTimeout(poll, POLL_MS)
    })
    return polling
  }

  async function pollOnce() {
    try {
      const next = await api('client/launcher')
      noticeExits(next, !S.summary)
      S.summary = next
      S.down = false
      S.downWhy = null
    } catch (err) {
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      // An answer that is an error is not "still loading": with nothing to show yet, the page
      // says so and why, where it used to sit on the loading shapes for as long as it lasted.
      else if (!S.summary) { S.down = true; S.downWhy = sentence(err.message) }
    }
    await readLog()
    await readLive()
    // the game went while "Stop the game?" was up: the question goes, and focus to what replaces it
    const asked = S.stopAsk && !profileNamed(S.stopAsk)?.running
    if (asked) S.stopAsk = null
    if (S.notice?.busy && Date.now() - (S.notice.at ?? 0) > 30000) S.notice = null
    // "Saved", "Made a copy": good news goes by itself after a while, unless it is being read
    // with the keyboard. A warning or a fault stays until it is dismissed.
    if (S.flash) {
      S.flash.at ??= Date.now()
      const passing = S.flash.tone === 'live' || !S.flash.tone
      if (passing && Date.now() - S.flash.at > FLASH_MS && !document.activeElement?.closest?.('.notice')) S.flash = null
    }
    // the minute, while a game runs: "for 12 minutes" moves on though nothing else changed
    const minute = profilesNow().some((p) => p.running) ? Math.floor(Date.now() / 60000) : 0
    const key = JSON.stringify([S.summary, S.down, S.downWhy, S.log, S.live, minute, S.notice, Boolean(S.flash), S.crash && { ...S.crash }])
    // lines being selected in a log are left alone: rebuilding the page would drop the selection,
    // and selecting is the way to copy when Copy cannot. The read after it is let go shows the rest.
    if (key !== lastKey && !selectingLog()) {
      lastKey = key
      // not between the press and the release of a click, which the rebuild would swallow
      renderSoon()
      if (asked && document.activeElement === document.body) $('play')?.focus({ preventScroll: true })
    }
  }

  function selectingLog() {
    const sel = window.getSelection?.()
    if (!sel || sel.isCollapsed || !sel.anchorNode) return false
    return ['liveLogPre', 'crashLogPre'].some((id) => $(id)?.contains(sel.anchorNode))
  }

  // A game this page saw running that is gone, not stopped from here, may have crashed: the log
  // decides (readLog), and until it has been read nothing shows. One exit is looked at at a time;
  // the rest wait their turn (S.exits), so two games gone in the same poll both get seen.
  function noticeExits(next, first = false) {
    // a game running again is no longer the crash being shown
    if (S.crash && next.profiles.some((p) => p.name === S.crash.profile && p.running)) dropCrash()
    // what the panel recorded while this page was not there to see it
    if (first) S.exits.push(...unseenCrashes(next.profiles, S.seenExits, Date.now()))
    S.exits.push(...watchedExits(S.watch, next.profiles, Date.now()))
    nextExit()
  }

  // The next exit waiting, if no crash is being shown or read.
  function nextExit() {
    if (S.crash || !S.exits.length) return
    const { name, seconds, early, exit = null, watch = null } = S.exits.shift()
    S.crash = { profile: name, seconds, early, exit, watch, report: null, pending: true }
    S.logMore = false
    S.log = { profile: name, lines: [] }
  }

  // The log is read once, for a game that has gone; it does not change after that. exitVerdict
  // says whether the game was closed (no callout) or crashed (the callout with the log's last lines).
  async function readLog() {
    const c = S.crash
    if (!c || !c.pending || profileNamed(c.profile)?.running) return
    // The process can be seen gone a moment before the panel has written how it ended (Windows
    // above all): with no record yet, the next read is waited for once before the log decides alone.
    if (!c.exit && c.watch) {
      c.exit = recordedExit(profileNamed(c.profile)?.lastExit, c.watch)
      if (!c.exit && !c.waited) { c.waited = true; return }
    }
    try {
      const out = await api(`client/profiles/${enc(c.profile)}/log?lines=${LOG_SCAN}`)
      const lines = out.lines ?? []
      if (crashVerdict(c.exit, lines, c.early) === 'closed') {
        // an exit the record calls abnormal but the log shows as a quit is not asked about again
        seenExit(c)
        if (S.crash === c) S.crash = null
        S.log = { profile: null, lines: [] }
        nextExit()
        return
      }
      c.pending = false
      // all of them are kept: the notice shows the last few, and the rest on "Show more"
      S.log = { profile: c.profile, lines }
    } catch { /* the next poll tries again */ }
  }

