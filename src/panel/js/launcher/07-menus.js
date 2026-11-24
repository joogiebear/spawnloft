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

  // Every menu sits in a pad under its button, at the button's left edge (or its right, with
  // `end`). The pad's bottom padding is in flow, so the stage scrolls a little past the menu (a
  // positioned box's own margin would not count, in Chromium at least). On a narrow window the
  // pad steps aside and the menu comes up from the bottom.
  const menuPad = (menu, end = false) => h('div', { class: `menupad absolute z-6 top-[calc(100%+6px)] left-0 right-0 pb-7 flex pointer-events-none max-[700px]:contents ${end ? 'justify-end' : ''}` }, menu)

  // A menu: `menu` stays on it for the focus code above. `cls` is its width.
  const MENU = 'menu sl-menu static flex-none pointer-events-auto max-w-none max-h-[min(70vh,560px)] overflow-auto p-2 grid gap-[2px] content-start max-[700px]:fixed max-[700px]:z-6 max-[700px]:inset-x-0 max-[700px]:top-auto max-[700px]:bottom-0 max-[700px]:w-auto max-[700px]:max-h-[75vh] max-[700px]:rounded-b-none max-[700px]:rounded-t-lg max-[700px]:px-3 max-[700px]:pt-3 max-[700px]:pb-5'
  const MENU_HEAD = 'sl-eyebrow px-2 pt-2 pb-1'
  const MENU_NOTE = 'sl-hint px-2 pt-1 pb-2'
  const MENU_SEP = 'sl-menu-sep border-0'
  // a row of a menu that is itself the thing to press
  const MENU_ROW = 'sl-menu-item flex-1 flex-row items-center gap-3 min-w-0 min-h-9 px-2 py-1 font-normal text-left disabled:opacity-45 disabled:cursor-not-allowed disabled:bg-transparent'
  const MENU_META = 'ml-auto text-1 text-ink-3 whitespace-nowrap'

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

