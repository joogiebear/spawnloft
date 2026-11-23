'use strict';
  // ---- state ---------------------------------------------------------------------------------

  const S = {
    summary: null,
    // a mod loader's builds per loader@version, for Advanced's build list
    builds: {},
    down: false,
    downWhy: null,
    pick: stored('local', PICK_KEY),
    // your servers: every version shown, and what was typed to find one
    serversAll: false,
    serverFind: '',
    // per profile: { server: a name or null, address: what was typed }; neither is the title screen
    targets: loadTargets(),
    job: null,
    // profile -> { since, stopping }: games this page watches for an early exit
    watch: {},
    crash: null,
    // exits still to be looked at while a crash is being shown: [{ name, seconds, early, exit }]
    exits: [],
    notice: null,
    // the outcome of a change made in the sheet or a menu, above the button until dismissed
    flash: null,
    // profile -> { mc, message }: the panel refused this version itself; cleared when it changes
    refusals: {},
    log: { profile: null, lines: [] },
    // the crash notice shows all the lines read, not the last few
    logMore: false,
    // profile -> endedAt of the recorded exit whose notice was dismissed here
    seenExits: {},
    // the running game's log, while "Show log" is open: { profile, lines }
    live: null,
    // the profile whose Stop was pressed and is waiting for "Stop now"
    stopAsk: null,
    // what was just copied ('crash' | 'live'), for a moment, so the button can say so
    copied: null,
    stopping: null,
    // the open menu: 'account' | 'join' | 'ask' | null
    menu: null,
    // the setup sheet's values while it is open, so a re-render keeps them
    sheet: null,
    // version id -> its details from GET client/versions/<id>; detailsRoute false once the panel
    // has said it has no such route
    details: {},
    detailsRoute: null,
    // the setup to play once "Who's playing?" is answered with a Microsoft sign-in
    afterLogin: null,
    // making the first setup on a fresh install
    firstRun: false,
    versions: null,
    versionShow: 'release',
    // the Javas on this computer: null until asked, { loading }, { javas } or { error }
    javas: null,
    login: null,
    acctNotice: null,
    offline: { name: '', error: null },
    // the account whose "Sign out?" is up in the account menu
    acctAsk: null,
  }

  function loadTargets() {
    let saved = null
    try { saved = JSON.parse(stored('local', JOIN_KEY) ?? 'null') } catch { /* ignored */ }
    return cleanTargets(saved)
  }

  // What localStorage held, or anything else, made into the shape the page trusts.
  function cleanTargets(saved) {
    const out = {}
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out
    for (const [name, t] of Object.entries(saved)) {
      if (!t || typeof t !== 'object' || name === '__proto__') continue
      const server = typeof t.server === 'string' && t.server ? t.server : null
      const address = typeof t.address === 'string' ? t.address.slice(0, 260) : ''
      // custom: "Another address" is the choice, typed yet or not; anyway: the server whose
      // other version the player said to go ahead with
      out[name] = { server, address, custom: !server && (t.custom === true || Boolean(address.trim())), anyway: server && t.anyway === server ? server : null }
    }
    return out
  }

  function saveTargets() {
    const out = {}
    for (const [name, t] of Object.entries(S.targets)) {
      if (t.server) out[name] = t.anyway === t.server ? { server: t.server, anyway: t.server } : { server: t.server }
      else if (t.custom || t.address.trim()) out[name] = { address: t.address.trim(), custom: true }
      else out[name] = {}
    }
    stored('local', JOIN_KEY, JSON.stringify(out))
  }

  const profilesNow = () => S.summary?.profiles ?? []
  const accountsNow = () => S.summary?.accounts ?? []
  const serversNow = () => S.summary?.servers ?? []
  const profileNamed = (name) => profilesNow().find((p) => p.name === name) ?? null
  const defaultAccount = () => accountsNow().find((a) => a.uuid === S.summary?.defaultAccount) ?? null

  function currentProfile() {
    const list = profilesNow()
    return profileNamed(S.pick) ?? list.find((p) => p.running) ?? list[0] ?? null
  }

  // A profile seen for the first time joins the server it names, if any.
  function targetFor(p) {
    if (!S.targets[p.name]) S.targets[p.name] = { server: p.server ?? null, address: '', custom: false, anyway: null }
    return S.targets[p.name]
  }

  function setTarget(p, { server = null, address = '', custom = false, anyway = null }) {
    S.targets[p.name] = { server, address, custom: !server && (custom || Boolean(address.trim())), anyway: server && anyway === server ? server : null }
    saveTargets()
  }

  function pickProfile(name) {
    // the log drawer and the Stop question belong to the card that is leaving
    if (S.pick !== name) {
      if (S.live && S.live.profile !== name) S.live = null
      if (S.stopAsk && S.stopAsk !== name) S.stopAsk = null
    }
    S.pick = name
    stored('local', PICK_KEY, name)
  }

