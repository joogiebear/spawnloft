'use strict';
  // ---- the account chip and its menu -----------------------------------------------------------

  function accountChip() {
    const def = defaultAccount()
    const open = S.menu === 'account'
    const attrs = { id: 'chip', 'aria-expanded': String(open), 'aria-controls': 'menuAccount', onclick: toggleMenu('account') }
    // the setup in view can be set to another player than the one named here: say so
    const own = S.summary ? setupPlaysAs(currentProfile(), def) : null
    const chip = def
      ? h('button', { ...attrs, class: CHIP }, tile(def), h('span', { class: CHIP_WHO }, h('b', { class: CHIP_NAME, text: def.name }),
        h('small', { class: CHIP_SUB, text: S.login ? 'Signing in…' : def.type === 'offline' ? 'Offline' : def.refreshFailedAt ? 'Microsoft · sign in again' : 'Microsoft' }),
        own && h('small', { class: 'own', id: 'chipOwn', text: `This setup plays as ${own}` })), ico('chev', 'text-ink-3'))
      : h('button', { ...attrs, class: `${CHIP} border-dashed text-ink-2` }, h('span', { class: 'sl-tile sl-tile-sm bg-raised-hi text-ink-3' }, ico('user', 'text-3')),
        h('span', { class: CHIP_WHO }, h('b', { class: CHIP_NAME, text: 'Not signed in' }), h('small', { class: CHIP_SUB, text: S.login ? 'Signing in…' : 'Sign in or play offline' })), ico('chev', 'text-ink-3'))
    return [chip, open && menuPad(accountMenu(def), true)].filter(Boolean)
  }

  // the account chip: a button the shape of a name card, in the top bar
  const CHIP = 'sl-btn h-auto min-h-10 max-w-[260px] gap-2 pl-1 pr-2 bg-surface border-line hover:bg-raised-hi aria-expanded:border-accent-edge aria-expanded:bg-accent-wash'
  const CHIP_WHO = 'grid leading-[1.2] text-left min-w-0 [&>small]:text-1 [&>small]:font-normal [&>small]:text-ink-3 [&>#chipOwn]:text-accent-ink'
  const CHIP_NAME = 'text-3 font-semibold truncate'
  const CHIP_SUB = 'text-1 text-ink-3 font-normal'

  function accountMenu(def) {
    const accounts = accountsNow()
    const p = currentProfile()
    const own = S.summary ? setupPlaysAs(p, def) : null
    const verb = (a) => (a.type === 'offline' ? 'Remove' : 'Sign out')
    const ask = (a) => { S.acctAsk = a.uuid; render(); $('acctKeep')?.focus({ preventScroll: true }) }
    const asking = S.acctAsk ? accounts.find((a) => a.uuid === S.acctAsk) ?? null : null
    return h('div', { class: `${MENU} w-[360px]`, id: 'menuAccount', role: 'group', 'aria-label': 'Accounts', onkeydown: menuKeys },
      S.acctNotice && acctNotice(S.acctNotice),
      S.login && waitingStrip(S.login),
      own && p && p.name !== FIRST && h('p', { class: MENU_NOTE, id: 'ownNote' }, `${setupName(p)} is set to play as ${own}, whoever is picked here. `,
        h('button', { class: LINK, onclick: () => { S.menu = null; openSheet(p, null, 'fAccount') } }, 'Change that')),
      accounts.length > 0 && [
        h('div', { class: MENU_HEAD, text: 'Playing as' }),
        accounts.map((a) => {
          const offline = a.type === 'offline'
          const meta = `${offline ? 'Offline' : 'Microsoft'}${a === def ? ' · default' : ''}`
          return h('div', { class: a === def ? 'flex items-center gap-2 rounded-sm text-3 min-h-9 bg-accent-wash' : 'flex items-center gap-2 rounded-sm text-3 min-h-9' },
            h('button', { class: MENU_ROW, 'aria-current': a === def ? 'true' : null, onclick: () => setDefault(a.uuid) },
              tile(a, true), h('span', { text: a.name }), h('span', { class: a.refreshFailedAt ? `${MENU_META} text-warn-ink` : MENU_META, text: !offline && a.refreshFailedAt ? 'sign in again' : meta })),
            !offline && a.refreshFailedAt && h('button', { class: BTN_SM, disabled: Boolean(S.login), onclick: startLogin }, 'Sign in again'),
            a !== def && h('button', { class: BTN_ICON, title: `${verb(a)} ${a.name}`, 'aria-label': `${verb(a)} ${a.name}`, onclick: () => ask(a) }, ico('x')))
        }),
        // signing out is asked first, with the safe choice in focus: getting back in means
        // Microsoft's page again, and setups set to this account stop playing until told another
        asking && accountAsk(asking, verb(asking)),
        h('hr', { class: MENU_SEP }),
      ],
      h('button', { class: `${MENU_ROW} text-ink-2`, disabled: Boolean(S.login), onclick: startLogin }, ico('plus'), 'Add Microsoft account', h('span', { class: MENU_META, text: 'opens Microsoft\'s page' })),
      h('div', { class: MENU_HEAD, text: 'Play offline on local servers' }),
      offlineField('offName', 'Add', () => addOffline()),
      h('p', { class: MENU_NOTE, text: 'An offline name plays on servers that do not check accounts, like a SpawnLoft server set to let anyone join. Every other server needs a Microsoft account.' }),
      def && !asking && [h('hr', { class: MENU_SEP }), h('button', { class: `${MENU_ROW} text-ink-2`, id: 'acctOut', onclick: () => ask(def) }, ico('x'), `${verb(def)} ${def.name}\u2026`)])
  }

  function accountAsk(a, verb) {
    const using = profilesNow().filter((q) => q.accountUuid === a.uuid).length
    const back = () => { S.acctAsk = null; render(); $('chip')?.focus({ preventScroll: true }) }
    return h('div', { class: `${CONFIRM} my-1 mx-2`, id: 'acctAsk', role: 'group', 'aria-label': `${verb} ${a.name}?` },
      h('p', { class: 'm-0 flex-[1_1_260px] text-3 text-ink-2', id: 'acctWhy' }, h('b', { text: `${verb} ${a.name}?` }), a.type === 'offline' ? ' The name can be added again at any time.' : ' Signing in again goes through Microsoft\'s page.',
        using > 0 && ` ${using === 1 ? 'One setup is' : `${using} setups are`} set to play as this account and will ask for another one.`),
      h('button', { class: BTN_SM, id: 'acctKeep', onclick: back }, 'Keep'),
      h('button', { class: BTN_DANGER_SM, id: 'acctGo', 'aria-describedby': 'acctWhy', onclick: () => removeAccount(a) }, verb))
  }

  // The offline name: a label that stays, what is wrong as it is typed, and a button that
  // works once the name is one the game takes.
  function offlineField(id, action, go) {
    const o = S.offline
    const problem = offlineNameProblem(o.name)
    const ok = offlineNameOk(o.name)
    return [
      h('label', { class: 'block px-2 pb-1 type-meta text-ink-2', for: id, text: 'Offline name' }),
      h('div', { class: 'grid grid-cols-[1fr_auto] gap-2 px-2 pt-1 pb-2' },
        h('input', { id, value: o.name, maxlength: '16', placeholder: 'Like Steve_01', class: o.error || problem ? INPUT_BAD : 'sl-input', 'aria-describedby': `${id}Hint`, autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => { o.name = e.target.value; o.error = null; if (!e.isComposing) render() }, oncompositionend: (e) => { o.name = e.target.value; render() }, onkeydown: (e) => { if (e.key === 'Enter' && offlineNameOk(o.name)) go() } }),
        h('button', { class: BTN, id: `${id}Go`, disabled: !ok, onclick: go }, action)),
      h('small', { class: o.error || problem ? `${HINT_BAD} block px-2 pb-2` : `${HINT} block px-2 pb-2`, id: `${id}Hint`, role: o.error ? 'alert' : null, text: o.error ? sentence(o.error) : problem ?? '3 to 16 letters, digits or underscores.' }),
    ]
  }

  function acctNotice(n) {
    const acts = []
    if (n.retry) acts.push(h('button', { class: BTN_SM, disabled: Boolean(S.login), onclick: startLogin }, n.retry))
    let text = n.text
    // the default can only be read once the list has been fetched again
    if (n.signedIn) text = S.summary?.defaultAccount === n.signedIn ? 'You play as this account from now on.' : 'Pick it here to play as it.'
    return notice({ tone: n.tone, title: n.title, text, acts, cls: 'my-1', onclose: () => { S.acctNotice = null; render() } })
  }

  // the account menu's strip while Microsoft's sign-in is open elsewhere
  const WAITING = 'flex items-start flex-wrap gap-y-2 gap-x-3 p-3 my-1 rounded-sm border border-accent-edge bg-accent-fill text-accent-ink text-3'
  const WAITING_ACTS = 'flex gap-3 items-center ml-auto'
  function waitingStrip(login) {
    if (login.external && login.status !== 'finishing') {
      return h('div', { class: WAITING, role: 'status' }, h('span', { class: 'sl-spinner mt-0.5' }),
        h('span', { class: 'min-w-0 flex-[1_1_200px]' }, h('b', { text: 'Waiting for Microsoft… ' }),
          'Finish signing in in your browser within 10 minutes. SpawnLoft comes back to the front when Microsoft is done.'),
        h('span', { class: WAITING_ACTS },
          h('button', { class: LINK, onclick: () => openMicrosoft(login) }, 'Open Microsoft\'s page again'),
          h('button', { class: BTN_SM, onclick: () => cancelLogin(login) }, 'Cancel')))
    }
    return h('div', { class: WAITING, role: 'status' }, h('span', { class: 'sl-spinner mt-0.5' }),
      h('span', { class: 'min-w-0 flex-[1_1_200px]' }, h('b', { text: 'Waiting for Microsoft… ' }),
        login.status === 'finishing' ? 'Microsoft is done; finishing the sign-in with Xbox and Minecraft.' : login.blocked ? 'The sign-in tab did not open, maybe because of a pop-up blocker. ' : 'Finish signing in in the tab that opened, then come back here.',
        login.blocked && h('a', { class: 'text-accent-ink underline-offset-3 cursor-pointer', href: login.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Microsoft\'s sign-in page')),
      h('span', { class: WAITING_ACTS },
        login.status !== 'finishing' && h('button', { class: BTN_SM, onclick: () => cancelLogin(login) }, 'Cancel')))
  }
