'use strict';
  // ---- render --------------------------------------------------------------------------------

  let lastKey = ''

  // The panel's sidebar shows a launch under way or a game running from any of its pages: this
  // page says so whenever it changes. Nobody listens in a window of its own.
  let toldPanel = ''
  // a server card's note that came before the panel's first answer, and whether that has come
  let waitingNote = null
  let loadedOnce = false
  function tellPanel() {
    if (window.parent === window) return
    // modal: the setup sheet is open, and the panel around this frame dims and locks itself
    const state = { type: 'spawnloft-play-state', launching: S.job && !S.job.done ? S.job.profile : null, running: (S.summary?.profiles ?? []).filter((q) => q.running).map((q) => q.name), modal: Boolean(S.sheet && !S.down) }
    const key = JSON.stringify(state)
    if (key === toldPanel) return
    toldPanel = key
    try { window.parent.postMessage(state, location.origin) } catch { /* a parent of another origin is not the panel */ }
  }

  function render() {
    tellPanel()
    // a re-render (a poll, a keystroke that changes a hint) keeps the focused field and caret
    const active = document.activeElement
    const keep = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null
    // a row in an open menu has no id: it is found again by its place in the rebuilt menu
    const inMenu = !keep && active?.closest?.('.menu[id]')
    const row = inMenu ? { menu: inMenu.id, at: menuItems(inMenu).indexOf(active) } : null
    // the running game's log stays at its end while it grows, and where it was scrolled to otherwise
    // what was typed changed: the best matches are at the top, so the list starts there again
    const listWas = S.sheet?.vTop ? 0 : $('fMcList')?.scrollTop ?? null
    if (S.sheet?.vTop) S.sheet.vTop = false
    const logWas = $('liveLogPre')
    const logAt = logWas ? { top: logWas.scrollTop, left: logWas.scrollLeft, end: logWas.scrollTop + logWas.clientHeight >= logWas.scrollHeight - 12 } : null
    $('chipwrap').replaceChildren(...(S.down ? [] : accountChip()))
    $('stage').replaceChildren(S.down ? unreachableView() : playView())
    $('sheet').replaceChildren(...(S.sheet && !S.down ? [sheetView()] : []))
    if (keep) {
      const el = $(keep.id)
      if (el && el !== document.activeElement) {
        el.focus({ preventScroll: true })
        try { if (keep.start !== null && keep.start !== undefined) el.setSelectionRange(keep.start, keep.end) } catch { /* not a text field */ }
      }
    }
    if (row && row.at !== -1) {
      const menu = $(row.menu)
      const items = menu ? menuItems(menu) : []
      items[Math.min(row.at, items.length - 1)]?.focus({ preventScroll: true })
    }
    if (listWas !== null && $('fMcList')) $('fMcList').scrollTop = listWas
    const logNow = $('liveLogPre')
    if (logNow) {
      logNow.scrollTop = logAt && !logAt.end ? logAt.top : logNow.scrollHeight
      if (logAt) logNow.scrollLeft = logAt.left
    }
    announce()
  }

