'use strict';
  // ---- menus ---------------------------------------------------------------------------------

  function openMenu(which, { focus = true } = {}) {
    S.menu = which
    S.acctAsk = null
    render()
    if (focus) {
      const first = document.querySelector('.menu button:not(:disabled), .menu input')
      first?.focus({ preventScroll: true })
    }
    // a menu that opens under a centred column can run past the window: bring it into view
    document.querySelector('.menupad')?.scrollIntoView({ block: 'nearest' })
  }

  function closeMenu({ refocus = false } = {}) {
    const was = S.menu
    if (!was) return
    S.menu = null
    S.acctAsk = null
    render()
    if (refocus) ($(was === 'ask' && S.askFrom ? S.askFrom : { account: 'chip', join: 'join', ask: 'play' }[was]) ?? $('play'))?.focus({ preventScroll: true })
  }

  const toggleMenu = (which) => () => (S.menu === which ? closeMenu() : openMenu(which))

  // Every menu sits in a pad under its button; the pad's CSS aligns it to the button's edge.
  const menuPad = (menu) => h('div', { class: 'menupad' }, menu)

  const menuItems = (menu) => [...menu.querySelectorAll('button:not(:disabled), input')]

  // Up and down move through a menu's buttons, as in any menu.
  function menuKeys(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = menuItems(e.currentTarget)
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1)
    items[next].focus()
  }

