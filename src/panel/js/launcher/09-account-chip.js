'use strict';
  // ---- the account chip and its menu -----------------------------------------------------------

  function accountChip() {
    const def = defaultAccount()
    const open = S.menu === 'account'
    const attrs = { id: 'chip', 'aria-expanded': String(open), 'aria-controls': 'menuAccount', onclick: toggleMenu('account') }
    // the setup in view can be set to another player than the one named here: say so
    const own = S.summary ? setupPlaysAs(currentProfile(), def) : null
    const chip = def
      ? h('button', { ...attrs, class: 'chip' }, tile(def), h('span', { class: 'who' }, h('b', { text: def.name }),
        h('small', { text: S.login ? 'Signing in…' : def.type === 'offline' ? 'Offline' : def.refreshFailedAt ? 'Microsoft · sign in again' : 'Microsoft' }),
        own && h('small', { class: 'own', id: 'chipOwn', text: `This setup plays as ${own}` })), ico('chev'))
      : h('button', { ...attrs, class: 'chip empty' }, h('span', { class: 'tile', style: '--tile:var(--raised-hi);color:var(--ink-3)' }, ico('user')),
        h('span', { class: 'who' }, h('b', { text: 'Not signed in' }), h('small', { text: S.login ? 'Signing in…' : 'Sign in or play offline' })), ico('chev'))
    return [chip, open && menuPad(accountMenu(def))].filter(Boolean)
  }

  function accountMenu(def) {
    const accounts = accountsNow()
    const p = currentProfile()
    const own = S.summary ? setupPlaysAs(p, def) : null
    const verb = (a) => (a.type === 'offline' ? 'Remove' : 'Sign out')
    const ask = (a) => { S.acctAsk = a.uuid; render(); $('acctKeep')?.focus({ preventScroll: true }) }
    const asking = S.acctAsk ? accounts.find((a) => a.uuid === S.acctAsk) ?? null : null
    return h('div', { class: 'menu who', id: 'menuAccount', role: 'group', 'aria-label': 'Accounts', onkeydown: menuKeys },
      S.acctNotice && acctNotice(S.acctNotice),
      S.login && waitingStrip(S.login),
      own && p && p.name !== FIRST && h('p', { class: 'note', id: 'ownNote' }, `${setupName(p)} is set to play as ${own}, whoever is picked here. `,
        h('button', { class: 'linkbtn', onclick: () => { S.menu = null; openSheet(p, null, 'fAccount') } }, 'Change that')),
      accounts.length > 0 && [
        h('div', { class: 'mhead', text: 'Playing as' }),
        accounts.map((a) => {
          const offline = a.type === 'offline'
          const meta = `${offline ? 'Offline' : 'Microsoft'}${a === def ? ' · default' : ''}`
          return h('div', { class: a === def ? 'row cur' : 'row' },
            h('button', { class: 'pick', 'aria-current': a === def ? 'true' : null, onclick: () => setDefault(a.uuid) },
              tile(a, 'sm'), h('span', { text: a.name }), h('span', { class: a.refreshFailedAt ? 'meta warn' : 'meta', text: !offline && a.refreshFailedAt ? 'sign in again' : meta })),
            !offline && a.refreshFailedAt && h('button', { class: 'sm', disabled: Boolean(S.login), onclick: startLogin }, 'Sign in again'),
            a !== def && h('button', { class: 'sm quiet icon', title: `${verb(a)} ${a.name}`, 'aria-label': `${verb(a)} ${a.name}`, onclick: () => ask(a) }, ico('x')))
        }),
        // signing out is asked first, with the safe choice in focus: getting back in means
        // Microsoft's page again, and setups set to this account stop playing until told another
        asking && accountAsk(asking, verb(asking)),
        h('hr'),
      ],
      h('button', { class: 'row act', disabled: Boolean(S.login), onclick: startLogin }, ico('plus'), 'Add Microsoft account', h('span', { class: 'meta', text: 'opens Microsoft\'s page' })),
      h('div', { class: 'mhead', text: 'Play offline on local servers' }),
      offlineField('offName', 'Add', () => addOffline()),
      h('p', { class: 'note', text: 'An offline name plays on servers that do not check accounts, like a SpawnLoft server set to let anyone join. Every other server needs a Microsoft account.' }),
      def && !asking && [h('hr'), h('button', { class: 'row act', id: 'acctOut', onclick: () => ask(def) }, ico('x'), `${verb(def)} ${def.name}\u2026`)])
  }

  function accountAsk(a, verb) {
    const using = profilesNow().filter((q) => q.accountUuid === a.uuid).length
    const back = () => { S.acctAsk = null; render(); $('chip')?.focus({ preventScroll: true }) }
    return h('div', { class: 'confirm', id: 'acctAsk', role: 'group', 'aria-label': `${verb} ${a.name}?` },
      h('p', { id: 'acctWhy' }, h('b', { text: `${verb} ${a.name}?` }), a.type === 'offline' ? ' The name can be added again at any time.' : ' Signing in again goes through Microsoft\'s page.',
        using > 0 && ` ${using === 1 ? 'One setup is' : `${using} setups are`} set to play as this account and will ask for another one.`),
      h('button', { class: 'sm', id: 'acctKeep', onclick: back }, 'Keep'),
      h('button', { class: 'sm danger', id: 'acctGo', 'aria-describedby': 'acctWhy', onclick: () => removeAccount(a) }, verb))
  }

  // The offline name: a label that stays, what is wrong as it is typed, and a button that
  // works once the name is one the game takes.
  function offlineField(id, action, go) {
    const o = S.offline
    const problem = offlineNameProblem(o.name)
    const ok = offlineNameOk(o.name)
    return [
      h('label', { class: 'flabel', for: id, text: 'Offline name' }),
      h('div', { class: 'inline' },
        h('input', { id, value: o.name, maxlength: '16', placeholder: 'Like Steve_01', class: o.error || problem ? 'bad' : null, 'aria-describedby': `${id}Hint`, autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => { o.name = e.target.value; o.error = null; if (!e.isComposing) render() }, oncompositionend: (e) => { o.name = e.target.value; render() }, onkeydown: (e) => { if (e.key === 'Enter' && offlineNameOk(o.name)) go() } }),
        h('button', { class: 'sm', id: `${id}Go`, disabled: !ok, onclick: go }, action)),
      h('small', { class: o.error || problem ? 'hint bad' : 'hint', id: `${id}Hint`, role: o.error ? 'alert' : null, text: o.error ? sentence(o.error) : problem ?? '3 to 16 letters, digits or underscores.' }),
    ]
  }

  function acctNotice(n) {
    const acts = []
    if (n.retry) acts.push(h('button', { class: 'sm', disabled: Boolean(S.login), onclick: startLogin }, n.retry))
    let text = n.text
    // the default can only be read once the list has been fetched again
    if (n.signedIn) text = S.summary?.defaultAccount === n.signedIn ? 'You play as this account from now on.' : 'Pick it here to play as it.'
    return notice({ tone: n.tone, title: n.title, text, acts, onclose: () => { S.acctNotice = null; render() } })
  }

  function waitingStrip(login) {
    if (login.external && login.status !== 'finishing') {
      return h('div', { class: 'waiting', role: 'status' }, h('span', { class: 'spin' }),
        h('span', { class: 'grow' }, h('b', { text: 'Waiting for Microsoft… ' }),
          'Finish signing in in your browser within 10 minutes. SpawnLoft comes back to the front when Microsoft is done.'),
        h('span', { class: 'acts' },
          h('button', { class: 'linkbtn', onclick: () => openMicrosoft(login) }, 'Open Microsoft\'s page again'),
          h('button', { class: 'sm', onclick: () => cancelLogin(login) }, 'Cancel')))
    }
    return h('div', { class: 'waiting', role: 'status' }, h('span', { class: 'spin' }),
      h('span', { class: 'grow' }, h('b', { text: 'Waiting for Microsoft… ' }),
        login.status === 'finishing' ? 'Microsoft is done; finishing the sign-in with Xbox and Minecraft.' : login.blocked ? 'The sign-in tab did not open, maybe because of a pop-up blocker. ' : 'Finish signing in in the tab that opened, then come back here.',
        login.blocked && h('a', { href: login.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open Microsoft\'s sign-in page')),
      h('span', { class: 'acts' },
        login.status !== 'finishing' && h('button', { class: 'sm', onclick: () => cancelLogin(login) }, 'Cancel')))
  }

