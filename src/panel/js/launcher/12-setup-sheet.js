'use strict';
  // ---- the setup sheet -----------------------------------------------------------------------

  // New and Edit. `p` is the profile to edit; with none it is a new setup, prefilled from
  // `prefill` ({ mc, server }, what a server card's Play leaves when no setup fits). `focus` is
  // the field to put the caret in.
  function openSheet(p = null, prefill = null, focus = null) {
    const servers = serversNow()
    // a new setup for a Fabric or NeoForge server starts on that server's loader
    const newLoader = MOD_LOADERS.includes(prefill?.loader) ? prefill.loader : 'vanilla'
    S.menu = null
    S.acctAsk = null
    S.sheetFrom = document.activeElement?.id || null
    S.sheet = p
      ? { editing: p.name, name: p.name, mc: p.mc, loader: p.loader, loaderVersion: p.loaderVersion ?? '', memory: p.memory, java: p.java ?? '', server: p.server ?? '', account: p.accountUuid ?? p.account ?? '', harness: p.harness, assistantAccount: p.assistantAccount, serverList: p.serverList !== false, error: null, saving: false, removing: false }
      : { editing: null, name: '', mc: prefill?.mc ?? '', loader: newLoader, loaderVersion: '', memory: defaultMemory(newLoader), memoryTouched: false, java: '', server: prefill?.server && servers.some((s) => s.name === prefill.server) ? prefill.server : '', account: '', harness: false, assistantAccount: false, serverList: true, error: null, saving: false, removing: false }
    if (!p && prefill?.server && !S.sheet.server) S.sheet.server = prefill.server
    S.sheet.custom = !MEMORY_CHOICES.includes(String(S.sheet.memory).toUpperCase())
    S.sheet.javaOther = false
    S.sheet.javaCheck = null
    if (!S.versions || S.versions.error) loadVersions()
    else defaultVersion(S.sheet)
    render()
    $(focus ?? 'fMc')?.focus()
  }

  // Focus goes back to what opened the sheet (a gear in the list, Edit setup, New), and to Play
  // when that is gone.
  function closeSheet() {
    S.sheet = null
    render()
    backFromSheet()
  }

  function backFromSheet() {
    const to = (S.sheetFrom && $(S.sheetFrom)) || $('play') || $('stop') || $('editSetup')
    S.sheetFrom = null
    to?.focus({ preventScroll: true })
  }

  // loaders=1: the rows say where each mod loader builds; refresh asks Mojang and the loaders again now, for a
  // version out within the hour
  async function loadVersions({ refresh = false } = {}) {
    S.versions = { loading: true }
    // what a version's details said may be older than the lists now read
    if (refresh) S.details = {}
    try {
      S.versions = await (refresh ? api('client/versions/refresh', { method: 'POST' }) : api('client/versions?loaders=1'))
    } catch (err) {
      S.versions = { error: err.message }
    }
    if (S.sheet) defaultVersion(S.sheet)
    render()
  }

  // a new setup starts on the newest release this machine can run
  function defaultVersion(f) {
    if (!f.editing && !f.mc) {
      const first = (S.versions?.versions ?? []).find((v) => v.type === 'release' && !v.refusal)
      if (first) f.mc = first.id
    }
    fixLoader(f)
    loadDetails(f.mc)
  }

  const versionRow = (id) => (S.versions?.versions ?? []).find((v) => v.id === id) ?? null

  // A version's details (exact Java, Fabric, harness), when the panel has the route; asked once
  // per version, and not at all once the panel has answered that it has no such route. The route
  // comes with the all-versions picker, whose rows carry `kind`; a panel without those is not asked.
  async function loadDetails(id) {
    if (!id || S.detailsRoute === false || S.details[id] !== undefined) return
    if (!(S.versions?.versions ?? []).some((r) => r.kind)) return
    S.details[id] = null
    try {
      S.details[id] = await api(`client/versions/${enc(id)}`)
      S.detailsRoute = true
    } catch (err) {
      if (err.status === 404 && !S.detailsRoute) S.detailsRoute = false
      delete S.details[id]
      return
    }
    if (S.sheet) {
      fixLoader(S.sheet)
      render()
    }
  }

  // What the panel knows about a version: the picker row, with the details on top.
  const versionInfo = (id) => ({ ...(versionRow(id) ?? {}), ...(S.details[id] ?? {}) })

  // A loader where it has the version; the harness where it is published (and Fabric is on).
  function sheetLoaderBlock(f, loader = f.loader) {
    return loaderBlock(loader, f.mc, versionInfo(f.mc))
  }

  function harnessBlock(f) {
    if (f.loader !== 'fabric') return 'Needs Fabric. Pick Fabric above to turn it on.'
    const row = versionRow(f.mc)
    const info = versionInfo(f.mc)
    if (info.harness === false) return `The helper mod is not out for ${f.mc} yet, so this stays off for this version.`
    if (!row && S.versions?.versions) return `The helper mod is not out for ${f.mc || 'this version'} yet.`
    return null
  }

  function fixLoader(f) {
    if (sheetLoaderBlock(f) && !f.editing) f.loader = 'vanilla'
    if (harnessBlock(f)) f.harness = false
  }

  // Tab stays inside the sheet while it is open.
  function trapTab(e) {
    if (e.key !== 'Tab') return
    const items = [...e.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')]
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  // The version field: a button that says the version, and under it, when opened, a box to type
  // in and the list it narrows. Up and Down move through the list from the box, Enter picks,
  // Escape closes. A version this computer cannot run is listed with the reason and cannot be picked.
  function versionPicker(f, p, machine) {
    const v = S.versions
    const all = v?.versions ?? []
    const latest = all.find((r) => r.type === 'release')?.id ?? null
    const cur = versionRow(f.mc)
    const badges = (r) => versionBadges(r, latest).map((b) => pill(b.tone, b.text))
    const { rows, more } = pickerRows(all, S.versionShow, f.vFind)
    const blocked = (r) => Boolean(r.refusal || machine)
    if (f.vAt === undefined || f.vAt >= rows.length) f.vAt = -1
    const close = () => { f.vOpen = false; f.vFind = ''; f.vAt = -1; render(); $('fMc')?.focus({ preventScroll: true }) }
    const pick = (r) => {
      if (blocked(r)) return
      // a build is made for one version; going back to the setup's own keeps its pinned build
      if (r.id !== f.mc) {
        const own = S.sheet === f && f.editing ? profileNamed(f.editing) : null
        f.loaderVersion = own && own.mc === r.id && own.loader === f.loader ? (own.loaderVersion ?? '') : ''
      }
      f.mc = r.id
      fixLoader(f)
      loadDetails(f.mc)
      close()
    }
    const move = (step) => {
      f.vAt = nextPickable(rows, f.vAt, step, blocked)
      render()
      $(`fMcRow${f.vAt}`)?.scrollIntoView({ block: 'nearest' })
    }
    const keys = (e) => {
      if (e.isComposing) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1) }
      else if (e.key === 'Enter') { e.preventDefault(); const r = rows[f.vAt] ?? rows.find((x) => x.id.toLowerCase() === typed.toLowerCase()) ?? (rows.length === 1 ? rows[0] : null); if (r) pick(r) }
    }
    const tab = (mode, text) => h('button', { type: 'button', id: `fMcShow-${mode}`, 'aria-pressed': String(S.versionShow === mode), onclick: () => { S.versionShow = mode; f.vAt = -1; render() } }, text)
    const typed = String(f.vFind ?? '').trim()
    const facts = versionFacts(cur, S.details[f.mc])
    const refused = S.details[f.mc]?.refusal ?? null
    const changed = p && f.mc !== p.mc
    const box = f.vOpen && h('div', { class: 'vbox', id: 'fMcBox' },
      h('input', { id: 'fMcFind', type: 'text', role: 'combobox', 'aria-label': 'Find a version', 'aria-expanded': 'true', 'aria-controls': 'fMcOptions', 'aria-autocomplete': 'list', 'aria-activedescendant': f.vAt >= 0 ? `fMcRow${f.vAt}` : null,
        placeholder: 'Type to find one, like 1.20', value: f.vFind ?? '', autocomplete: 'off', spellcheck: 'false', oninput: (e) => { f.vFind = e.target.value; f.vAt = -1; f.vTop = true; if (!e.isComposing) render() }, oncompositionend: (e) => { f.vFind = e.target.value; render() }, onkeydown: keys }),
      h('div', { class: 'vtabs' },
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Which versions the list shows' }, tab('release', 'Releases'), tab('snapshot', 'And snapshots'), tab('all', 'Everything')),
        h('button', { type: 'button', class: 'linkbtn', id: 'versionsRefresh', disabled: Boolean(v?.loading), title: 'Ask Mojang for the list again, for a version out within the hour', onclick: () => loadVersions({ refresh: true }) }, v?.loading ? 'Reading\u2026' : 'Refresh')),
      typed && h('small', { class: 'hint', text: 'Searching every version, snapshots and old ones included.' }),
      // the options alone are the listbox; the notes under them are not options
      h('div', { class: 'vlist', id: 'fMcList' }, h('div', { class: 'vopts', id: 'fMcOptions', role: 'listbox', 'aria-label': 'Versions' },
        rows.map((r, i) => h('div', { class: i === f.vAt ? 'vrow at' : 'vrow', id: `fMcRow${i}`, role: 'option', 'aria-selected': String(r.id === f.mc), 'aria-disabled': blocked(r) ? 'true' : null, onpointerdown: (e) => e.preventDefault(), onclick: () => pick(r) },
          h('span', { class: 'vid', text: r.id }), badges(r),
          (r.refusal || r.note) && h('small', { class: r.refusal ? 'why warn' : 'why', text: sentence(r.refusal ?? r.note) })))),
        !rows.length && h('p', { class: 'hint', role: 'status', text: v?.loading ? 'Reading the version list\u2026' : typed ? `No version has \u201c${typed}\u201d in its name.` : 'No versions to pick.' }),
        more > 0 && h('p', { class: 'hint', text: `${more} more. Type part of a version to find it.` })))
    return h('div', { class: f.vOpen ? 'field full' : 'field' }, h('span', { class: 'label', id: 'fMcLabel', text: 'Version' }),
      h('button', { type: 'button', class: 'vpick', id: 'fMc', 'aria-haspopup': 'dialog', 'aria-expanded': String(Boolean(f.vOpen)), 'aria-controls': f.vOpen ? 'fMcBox' : null, 'aria-labelledby': 'fMcLabel fMcNow',
        onclick: () => { if (f.vOpen) return close(); f.vOpen = true; f.vAt = -1; render(); $('fMcFind')?.focus({ preventScroll: true }); $('fMcList')?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) } },
        h('span', { class: 'now', id: 'fMcNow' }, h('b', { text: f.mc || (v?.loading ? 'Reading the version list\u2026' : 'Pick a version') }), cur && badges(cur)), ico('chev')),
      box,
      changed && h('small', { class: 'hint warn', text: 'Changing it may stop the mods in its folder from loading.' }),
      refused && h('small', { class: 'hint warn', text: sentence(refused) }),
      (v?.error || v?.offline || facts.length > 0) && h('small', { class: v?.offline || v?.error ? 'hint warn' : 'hint',
        text: [v?.error ? `The version list could not be read: ${v.error}.` : v?.offline ? sentence(v.offline) + '.' : '', facts.length ? sentence(facts.join(' \u00b7 ')) : ''].filter(Boolean).join(' ') }))
  }

  // The Javas on this computer, for the sheet's Java list; asked for when Advanced is opened.
  // A loader's builds for a version, for the build list in Advanced, kept by loader and version.
  const buildsKey = (loader, mc) => `${loader}@${mc}`
  async function loadBuilds(loader, mc) {
    const key = buildsKey(loader, mc)
    const had = S.builds[key]
    // a list is read again after ten minutes, a failed read after one
    if (had && (had.loading || Date.now() - had.at < (had.error ? 60e3 : 600e3))) return
    S.builds[key] = { ...(had?.builds ? had : {}), loading: true, at: Date.now() }
    try {
      S.builds[key] = { ...(await api(`client/loaders/${encodeURIComponent(loader)}/${encodeURIComponent(mc)}/builds`)), at: Date.now() }
    } catch (err) {
      S.builds[key] = { ...(had?.builds ? had : {}), error: err.message, at: Date.now() }
    }
    render()
  }

  // The loader's version in Advanced: a list of its builds for an installer's loader once they
  // are read, else a field to type one in.
  function loaderVersionField(f) {
    const name = loaderName(f.loader)
    const example = { quilt: '0.30.2', neoforge: '21.1.266', forge: '47.4.28' }[f.loader] ?? '0.17.3'
    const typed = () => h('label', { class: 'field' }, h('span', { text: `${name} version` }), h('input', { id: 'fLoaderVersion', value: f.loaderVersion, placeholder: 'Newest stable', oninput: (e) => { f.loaderVersion = e.target.value } }),
      h('small', { class: 'hint', text: `The build of ${name} itself, like ${example}. Left empty, the first Play takes the newest stable one.` }))
    if (!INSTALLER_LOADERS.includes(f.loader) || !f.mc || loaderBlock(f.loader, f.mc, versionInfo(f.mc))) return typed()
    // read when Advanced is open; until the list is in, the field to type one in
    if (f.adv) loadBuilds(f.loader, f.mc)
    const got = S.builds[buildsKey(f.loader, f.mc)]
    if (!got?.builds?.length) {
      if (!got?.error) return typed()
      return h('div', {}, typed(), h('small', { class: 'hint warn', text: `${name}\u2019s builds could not be read: ${got.error}` }))
    }
    const builds = got.builds
    const by = got.picked && builds.find((b) => b.version === got.picked)
    const auto = by ? `${by.recommended ? 'Recommended' : 'Newest'}: ${by.version}` : 'Newest stable'
    const options = [['', auto], ...builds.map((b) => [b.version, b.recommended ? `${b.version} (recommended)` : b.stable ? b.version : `${b.version} (beta)`])]
    const unknown = Boolean(f.loaderVersion) && !builds.some((b) => b.version === f.loaderVersion)
    if (unknown) options.splice(1, 0, [f.loaderVersion, `${f.loaderVersion} (not published)`])
    // a pinned build with a newer default out says so; the setup keeps its build (design Q3)
    const pinned = f.loaderVersion && builds.findIndex((b) => b.version === f.loaderVersion)
    const newer = Boolean(got.picked) && got.picked !== f.loaderVersion && pinned > 0 && builds.findIndex((b) => b.version === got.picked) < pinned
    const hint = unknown
      ? `${name} ${f.loaderVersion} is not published for ${f.mc}. Pick one from the list.`
      : newer
      ? `${name} ${got.picked} is out. This setup stays on ${f.loaderVersion} until you pick another.`
      : f.loaderVersion ? `This setup stays on ${name} ${f.loaderVersion}.` : `Left on ${auto.split(':')[0].toLowerCase()}, the first Play takes that build and keeps it.`
    return h('label', { class: 'field' }, h('span', { text: `${name} version` }),
      h('select', { id: 'fLoaderVersion', value: f.loaderVersion, onchange: (e) => { f.loaderVersion = e.target.value; render() } },
        options.map(([v, text]) => h('option', { value: v, selected: v === (f.loaderVersion ?? '') || null, text }))),
      h('small', { class: newer || unknown ? 'hint warn' : 'hint', text: hint }))
  }

  async function loadJavas({ fresh = false } = {}) {
    if (S.javas?.loading) return
    S.javas = { loading: true, javas: S.javas?.javas ?? null }
    render()
    try {
      S.javas = await api(`client/javas${fresh ? '?fresh=1' : ''}`)
    } catch (err) {
      S.javas = { error: err.message, javas: [] }
    }
    render()
  }

  // Is the path in the sheet a Java: asked when the field is left, after Browse, and before Save.
  // The answer is kept with the path it was for.
  async function checkJava(f) {
    const path = fieldText(f.java)
    if (!path || path === 'mojang') { f.javaCheck = null; return null }
    if (f.javaCheck?.path === path && !f.javaCheck.checking) return f.javaCheck
    f.javaCheck = { path, checking: true }
    renderSoon()
    let out
    try {
      out = await api('client/javas/check', { method: 'POST', body: { path } })
    } catch (err) {
      if (err instanceof PanelDown) {
        if (f.javaCheck?.checking) f.javaCheck = null
        throw err
      }
      out = { path, found: false, message: sentence(err.message) }
    }
    if (S.sheet === f && fieldText(f.java) === path) { f.javaCheck = out; renderSoon() }
    return out
  }

  // A render that nobody asked for by clicking (an answer that arrived) waits while a mouse
  // button is down: rebuilding the page between press and release would swallow the click, as
  // when Save is pressed straight from the Java path field, whose check starts as it is left.
  let pressed = false
  let renderWaits = false
  document.addEventListener('pointerdown', () => { pressed = true }, true)
  const released = () => {
    pressed = false
    if (renderWaits) { renderWaits = false; setTimeout(render, 0) }
  }
  // the release can go elsewhere: to a context menu, or to another window
  for (const ev of ['pointerup', 'pointercancel', 'contextmenu']) document.addEventListener(ev, released, true)
  window.addEventListener('blur', released)
  function renderSoon() {
    if (pressed) renderWaits = true
    else render()
  }

  async function browseJava(f) {
    let picked = null
    try { picked = await desktop.pickFile('Choose the java program', 'program') } catch { /* closed, or no picker here */ }
    if (!picked || S.sheet !== f) return
    f.java = picked
    f.javaCheck = null
    render()
    checkJava(f).catch(() => {})
  }

  // What the version in the sheet needs of a Java: its own file's bounds when the panel has
  // read it, else the guess from its id.
  function javaNeeds(mc, loader = null) {
    const d = S.details[mc]?.java
    // Forge on a version Mojang ships with Java 8 runs on Java 8 only, as the launch decides
    if (d?.min && loader === 'forge' && d.component === 'jre-legacy') return { min: 8, max: 8 }
    if (d?.min) return { min: d.min, max: d.max ?? null }
    const row = versionInfo(mc)
    return row.javaNeeds ? { min: row.javaNeeds, max: null, guess: row.javaNeedsExact === false } : null
  }

  function javaField(f) {
    const found = S.javas?.javas ?? []
    const other = f.javaOther
    const choices = javaChoices(found, other ? null : fieldText(f.java))
    const picked = found.find((j) => j.path === f.java) ?? null
    const check = f.javaCheck && f.javaCheck.path === fieldText(f.java) ? f.javaCheck : null
    const major = picked?.major ?? (check?.found ? check.major : null)
    const fit = javaFit(major, javaNeeds(f.mc, f.loader), f.mc)
    const onpick = (e) => {
      const val = e.target.value
      // "Another Java" starts from the path the setup had, so that it is not lost by looking
      const had = fieldText(f.java)
      f.javaOther = val === JAVA_OTHER
      f.java = f.javaOther ? (had && had !== 'mojang' && had !== 'java' ? had : '') : val
      f.javaCheck = null
      render()
      if (f.javaOther) $('fJavaPath')?.focus()
    }
    let hint = 'SpawnLoft picks a Java that fits the version, and gets Mojang\'s own when none on this computer does.'
    if (other) hint = `The whole path to ${/Win/.test(navigator.platform) ? 'javaw.exe or java.exe' : 'the java program'}, in a Java's bin folder.`
    else if (f.java === 'mojang') hint = 'The Java that Mojang ships for this version, downloaded on the first Play. It is the one the official launcher uses.'
    else if (f.java) hint = 'This setup always starts with this Java.'
    return h('div', { class: 'field' }, h('label', { class: 'label', for: 'fJava', text: 'Java' }),
      h('select', { id: 'fJava', value: other ? JAVA_OTHER : f.java, onchange: onpick }, choices.map((c) => h('option', { value: c.value, text: c.text }))),
      other && h('div', { class: 'pathrow' },
        h('input', { id: 'fJavaPath', 'aria-label': 'Path to Java', value: f.java, class: check && check.found === false ? 'bad' : null, autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => { f.java = e.target.value; f.javaCheck = null }, onchange: () => checkJava(f).catch(() => {}) }),
        desktop?.pickFile && h('button', { type: 'button', class: 'sm', id: 'fJavaBrowse', onclick: () => browseJava(f) }, 'Browse\u2026')),
      check?.checking && h('small', { class: 'hint', role: 'status', text: 'Checking that it is a Java\u2026' }),
      check && check.found === false && h('small', { class: 'hint bad', id: 'fJavaBad', role: 'alert', text: sentence(check.message) }),
      check?.found && h('small', { class: 'hint', id: 'fJavaGood', role: 'status', text: `That is Java ${check.major ?? 'of a version it does not say'}${check.arch ? ` (${check.arch})` : ''}.` }),
      fit && h('small', { class: 'hint warn', id: 'fJavaFit', text: fit }),
      h('small', { class: 'hint' }, hint, ' ',
        h('button', { type: 'button', class: 'linkbtn', id: 'javasRefresh', disabled: Boolean(S.javas?.loading), title: 'Look for the Javas on this computer again, after installing one', onclick: () => loadJavas({ fresh: true }) }, S.javas?.loading ? 'Looking\u2026' : 'Look again'),
        S.javas?.error && ` The Javas on this computer could not be listed: ${sentence(S.javas.error)}`))
  }

  // Segmented buttons: one of `choices` ([value, label, disabled]) is pressed.
  function segmented(label, choices, value, onpick) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label },
      choices.map(([v, text, disabled]) => h('button', { type: 'button', 'aria-pressed': String(v === value), disabled: Boolean(disabled) && v !== value, title: typeof disabled === 'string' && v !== value ? disabled : null, onclick: () => onpick(v) }, text)))
  }

  function sheetView() {
    const f = S.sheet
    const p = f.editing ? profileNamed(f.editing) : null
    const running = Boolean(p?.running)
    const v = S.versions
    const machine = v?.machineRefusal ?? S.summary?.machineRefusal ?? null
    const set = (key, rerender = false) => (e) => {
      f[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value
      if (key === 'mc') { fixLoader(f); loadDetails(f.mc) }
      if (rerender) render()
    }
    const toggle = (key) => () => { f[key] = !f[key]; render() }
    const ro = (label, value, hint) => h('label', { class: 'field' }, h('span', { text: label }), h('input', { readonly: true, value }), hint && h('small', { class: 'hint', text: hint }))
    const runningHint = 'Stop the game to change it.'
    // an error about the setup's own name, not one that only has the word in it
    const NAME_ERROR = /profile name|already exists|folder named|needs a name/i
    // Duplicate copies the setup as it is saved, so not while the sheet holds changes
    const edited = Boolean(p && (fieldText(f.name) !== p.name || Object.keys(profilePatch(p, editedProfile(f))).length))
    const busyHere = Boolean(p && S.job?.profile === p.name)

    const versionField = running ? ro('Version', f.mc, runningHint) : versionPicker(f, p, machine)

    const loaderNo = sheetLoaderBlock(f)
    const loaderChoices = [['vanilla', 'None'], ...MOD_LOADERS.map((l) => [l, loaderName(l), sheetLoaderBlock(f, l)])]
    const pickLoader = (val) => {
      if (val === f.loader) return
      f.loader = val
      // a build is made for one loader; going back to the setup's own loader keeps its pinned build
      f.loaderVersion = p && val === p.loader && f.mc === p.mc ? (p.loaderVersion ?? '') : ''
      if (!f.editing && !f.memoryTouched) { f.memory = defaultMemory(val); f.custom = false }
      fixLoader(f)
      render()
    }
    const changed = p ? loaderChangeWarning(p.loader, f.loader) : null
    // the reasons the others are greyed out, said once under the control
    const others = loaderChoices.filter(([l, , why]) => why && l !== f.loader && !COMING.includes(l)).map(([, , why]) => why)
    const coming = COMING.filter((l) => l !== f.loader)
    if (coming.length) others.push(`${coming.map(loaderName).join(' and ')} ${coming.length > 1 ? 'are' : 'is'} coming in a later SpawnLoft.`)
    const loaderField = running ? ro('Mods', modded(f.loader) ? loaderText({ loader: f.loader, loaderVersion: f.loaderVersion }) : 'None', runningHint) : h('div', { class: 'field' }, h('span', { class: 'label', id: 'fLoaderLabel', text: 'Mods' }),
      h('div', { class: 'modsseg' }, segmented('Mods', loaderChoices, f.loader, pickLoader)),
      // narrow sheets: the same five as a list
      h('select', { class: 'modspick', id: 'fLoader', 'aria-labelledby': 'fLoaderLabel', value: f.loader, onchange: (e) => pickLoader(e.target.value) },
        loaderChoices.map(([l, text, why]) => h('option', { value: l, disabled: Boolean(why) && l !== f.loader, text: why && l !== f.loader ? `${text} (${COMING.includes(l) ? 'coming' : 'not for this version'})` : text }))),
      h('small', { class: loaderNo ? 'hint warn' : 'hint', text: loaderNo ?? loaderHint(f.loader) }),
      !loaderNo && forgeUntested(f.loader, f.mc) && h('small', { class: 'hint', text: `Forge on ${f.mc} is not tested by SpawnLoft. Its 1.7.10 and 1.12.2 are, and ${f.mc} uses the same kind of installer.` }),
      changed && h('small', { class: 'hint warn', text: changed }),
      others.length > 0 && !loaderNo && h('small', { class: 'hint', text: others.join(' ') }))

    const advice = memoryAdvice(f.memory, S.summary?.machine)
    const totalGb = advice.total ?? 16
    const gb = memoryGb(f.memory) ?? 2
    const pickMemory = (val) => {
      f.memoryTouched = true
      if (val === 'custom') { f.custom = true; f.memory = memoryFromGb(Math.min(gb, totalGb)) } else { f.custom = false; f.memory = val }
      render()
      if (val === 'custom') $('fMemory')?.focus()
    }
    const memoryField = running ? ro('Memory', memoryText(f.memory), runningHint) : h('div', { class: 'field' }, h('span', { class: 'label', text: 'Memory' }),
      // a choice this computer does not have the memory for cannot be picked
      segmented('Memory', [...MEMORY_CHOICES.map((c) => [c, memoryText(c), advice.tooMuch(c)]), ['custom', 'Custom']], f.custom ? 'custom' : String(f.memory).toUpperCase(), pickMemory),
      f.custom && h('div', { class: 'slider' },
        h('input', { type: 'range', id: 'fMemory', min: '1', max: String(Math.max(totalGb, gb)), step: '0.5', value: String(gb), 'aria-label': 'Memory in gigabytes', 'aria-valuetext': memoryText(f.memory),
          oninput: (e) => { f.memory = memoryFromGb(e.target.value); f.memoryTouched = true; render() } }),
        h('output', { for: 'fMemory', text: `${gb} GB` })),
      advice.warn && h('small', { class: 'hint warn', id: 'fMemoryWarn', text: advice.warn }),
      h('small', { class: 'hint', id: 'fMemoryLine', text: advice.line }))

    const servers = serversNow()
    const def = defaultAccount()
    const block = harnessBlock(f)
    const taken = profilesNow().map((q) => q.name)
    const autoPlaceholder = f.mc ? autoName(f.mc, f.loader, taken) : 'Named by its version'

    const grid = h('div', { class: 'grid2' },
      versionField,
      loaderField,
      memoryField,
      f.editing
        ? (running || busyHere
          ? ro('Name', f.name, running ? runningHint : 'It is being launched.')
          : h('label', { class: 'field' }, h('span', { text: 'Name' }),
            h('input', { id: 'fName', value: f.name, maxlength: '32', class: f.error && NAME_ERROR.test(f.error) ? 'bad' : null, oninput: set('name', true) }),
            h('small', { class: 'hint', text: 'Renaming moves its folder too. Letters, digits, dash and underscore.' })))
        : h('label', { class: 'field' }, h('span', { text: 'Name (optional)' }),
          h('input', { id: 'fName', value: f.name, placeholder: autoPlaceholder, maxlength: '32', class: f.error && /name/.test(f.error) ? 'bad' : null, oninput: set('name') }),
          h('small', { class: 'hint', text: 'Shown in the setups list. Letters, digits, dash and underscore.' })),
      h('label', { class: 'field' }, h('span', { text: 'Play as' }),
        h('select', { id: 'fAccount', value: f.account, onchange: set('account') },
          h('option', { value: '', text: def ? `Whoever is signed in (${def.name})` : 'Whoever is signed in' }),
          accountsNow().map((a) => h('option', { value: accountValue(a, f.account), text: `${a.name} (${a.type === 'offline' ? 'Offline' : 'Microsoft'})` })),
          f.account && !accountsNow().some((a) => accountValue(a, f.account) === f.account) && h('option', { value: f.account, text: p?.accountType === 'offline' ? `${p.accountName} (Offline)` : `${p?.accountName ?? f.account} (no longer signed in)` }))),
      h('label', { class: 'field' }, h('span', { text: 'Usually joins' }),
        h('select', { id: 'fServer', value: f.server, onchange: set('server') },
          h('option', { value: '', text: 'Title screen only' }),
          servers.map((s) => h('option', { value: s.name, text: `${s.label || s.name}${s.mc ? ` · ${s.mc}` : ''}${s.mc && f.mc && s.mc !== f.mc ? ' (another version)' : ''}` })),
          f.server && !servers.some((s) => s.name === f.server) && h('option', { value: f.server, text: `${f.server} (not found)` }))))

    const harness = !running && h('div', { class: 'switchrow' },
      h('div', { class: 'txt' }, h('b', { id: 'fHarnessLabel', text: 'Let SpawnLoft see the game' }), h('small', { style: block ? 'color:var(--warn-ink)' : null, text: block ?? 'Adds SpawnLoft\u2019s helper mod to the game. With it, a problem report and an AI assistant you connected can read what is on screen and send chat. Off until you need it.' })),
      h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(f.harness), 'aria-labelledby': 'fHarnessLabel', disabled: Boolean(block), onclick: toggle('harness') }))

    const serverList = h('div', { class: 'switchrow' },
      h('div', { class: 'txt' }, h('b', { id: 'fServerListLabel', text: 'Show my SpawnLoft servers in the game' }), h('small', { text: 'Each time the game starts, the servers on this version are put in its Multiplayer list. Servers you added there yourself are never changed.' })),
      h('button', { type: 'button', class: 'switch', id: 'fServerList', role: 'switch', 'aria-checked': String(f.serverList), 'aria-labelledby': 'fServerListLabel', onclick: toggle('serverList') }))

    if (f.adv === undefined) f.adv = Boolean(f.java || f.loaderVersion || f.assistantAccount)
    const msAccount = (() => {
      const a = f.account ? accountsNow().find((x) => x.uuid === f.account) : def
      return a?.type === 'microsoft' ? a : null
    })()
    if (f.adv && !running && !S.javas) loadJavas()
    const advanced = h('details', { class: 'adv', open: f.adv || null, ontoggle: (e) => { f.adv = e.target.open; if (f.adv && !S.javas) loadJavas() } },
      h('summary', { text: 'Advanced' }),
      h('div', { class: 'in' },
        running
          ? h('div', { class: 'grid2' }, ro('Java', f.java === 'mojang' ? "Mojang's own Java" : f.java || 'Automatic', runningHint), modded(f.loader) && ro(`${loaderName(f.loader)} version`, f.loaderVersion || 'Newest stable'))
          : h('div', { class: 'grid2' },
            javaField(f),
            modded(f.loader) && loaderVersionField(f)),
        f.editing
          ? h('div', { class: 'switchrow' }, h('div', { class: 'txt' }, h('b', { id: 'fAssistLabel', text: 'Allow an assistant to use my account' }),
            h('small', { text: msAccount ? `An AI assistant you connected to SpawnLoft may start this setup and play signed in as ${msAccount.name}.` : 'An AI assistant you connected to SpawnLoft may start this setup signed in as its Microsoft account. It plays as an offline player while the setup has none.' })),
          h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(f.assistantAccount), 'aria-labelledby': 'fAssistLabel', onclick: toggle('assistantAccount') }))
          : h('p', { class: 'hint', text: 'An AI assistant you connected to SpawnLoft plays a new setup as an offline player. To let it use a Microsoft account, turn that on after the setup exists.' })))

    const given = p && givenName(p)
    return h('div', { class: 'backdrop', onclick: (e) => { if (e.target === e.currentTarget) closeSheet() } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheetTitle', onkeydown: trapTab },
        h('div', {},
          h('h2', { id: 'sheetTitle' }, p ? [setupTitle(p), given && h('span', { text: ` (${given})` })] : 'New setup'),
          h('p', { class: 'sub', text: p ? (running ? `Running since ${clockTime(p.startedAt)}` : [playedLine(p), memoryText(p.memory), p.server ? `usually joins ${p.server}` : 'opens on the title screen'].filter(Boolean).join(' · ')) : 'Nothing is downloaded until you press Play.' })),
        f.error && notice({ tone: 'fault', title: sentence(f.error) }),
        running && notice({ tone: 'warn', title: 'This setup is running', text: 'The version, mods, Java, memory and the helper mod can\'t change while the game is open. Stop it first to change them.' }),
        machine && !running && notice({ tone: 'fault', title: 'Minecraft can\'t be launched on this computer', text: sentence(machine) }),
        grid,
        serverList,
        harness,
        advanced,
        f.removing && p && h('div', { class: 'confirm', role: 'alert' },
          h('span', {}, h('b', { text: `Remove ${setupTitle(p)}?` }), ' Its folder with worlds, options and mods is kept.'),
          // The button says what it will do: with the box ticked it deletes worlds, and reads so.
          h('label', {}, h('input', { type: 'checkbox', id: 'purge', onchange: (ev) => { $('confirmRemove').textContent = removeLabel(ev.target.checked) } }), ' Also delete its folder, worlds included'),
          h('span', { class: 'grow' }),
          h('button', { class: 'sm', id: 'keepSetup', onclick: () => { f.removing = false; render() } }, 'Keep it'),
          h('button', { class: 'sm danger', id: 'confirmRemove', onclick: () => removeProfile(p, $('purge').checked) }, removeLabel(false))),
        h('div', { class: 'foot' },
          p
            ? [h('button', { class: 'sm quiet', id: 'sheetFolder', onclick: () => reveal(p, 'folder') }, ico('folder'), 'Open folder'),
              h('button', { class: 'sm quiet', style: 'color:var(--fault-ink)', disabled: running || busyHere, title: running ? 'Stop the game to remove it.' : null, onclick: () => { f.removing = true; render(); const keep = $('keepSetup'); keep?.scrollIntoView({ block: 'nearest' }); keep?.focus() } }, 'Remove setup…'),
              h('button', { class: 'sm quiet', disabled: f.saving || edited, title: edited ? 'Save or cancel your changes first: the copy is made from the saved setup.' : 'A second setup with the same settings, mods and options. Worlds are not copied.', onclick: () => duplicateProfile(p) }, 'Duplicate'),
              h('span', { class: 'grow' })]
            : h('span', { class: 'hint', text: 'Kept in its own folder under SpawnLoft\'s data folder.' }),
          h('button', { onclick: closeSheet }, 'Cancel'),
          h('button', { class: 'primary', disabled: f.saving || !f.mc, onclick: saveSheet }, f.saving ? 'Saving…' : f.editing ? 'Save' : 'Create'))))
  }

  // A typed field as the panel wants it: trimmed, and null when empty.
  function fieldText(s) { return String(s ?? '').trim() || null }

  // The sheet's fields as the panel's profile routes take them. A loader build only goes with a loader.
  function profileFields(f) {
    return { mc: f.mc, loader: f.loader, loaderVersion: modded(f.loader) ? fieldText(f.loaderVersion) : null, memory: f.memory, java: fieldText(f.java), harness: f.harness, server: fieldText(f.server), account: fieldText(f.account), serverList: f.serverList }
  }

  // What a New sheet POSTs: a name unless one was typed, and the fields.
  function newProfileBody(f, taken) {
    return { name: fieldText(f.name) ?? autoName(f.mc, f.loader, taken), ...profileFields(f) }
  }

  // What an Edit sheet wants the setup to be; profilePatch keeps only what changed.
  function editedProfile(f) {
    return { ...profileFields(f), assistantAccount: f.assistantAccount }
  }

  // What this page keeps by a setup's name follows it to its new one.
  function movedName(from, to) {
    if (S.pick === from) pickProfile(to)
    if (S.targets[from]) { S.targets[to] = S.targets[from]; delete S.targets[from]; saveTargets() }
    if (S.refusals[from]) { S.refusals[to] = S.refusals[from]; delete S.refusals[from] }
    // the row itself, so the sheet and the card read as the same setup until the next poll
    const row = S.summary?.profiles?.find((q) => q.name === from)
    if (row) row.name = to
    if (S.seenExits[from]) { S.seenExits[to] = S.seenExits[from]; delete S.seenExits[from] }
    if (S.crash?.profile === from) S.crash.profile = to
    if (S.log.profile === from) S.log.profile = to
    for (const e of S.exits) if (e.name === from) e.name = to
  }

  async function duplicateProfile(p) {
    const f = S.sheet
    f.saving = true
    f.error = null
    render()
    try {
      // the panel picks the name: it can see the folders a removed setup left behind
      const made = await api(`client/profiles/${enc(p.name)}/duplicate`, { method: 'POST', body: {} })
      pickProfile(made.name)
      S.flash = { tone: 'live', title: `Made ${made.name}, a copy of ${p.name}`, text: 'It has the same settings, mods and options. Worlds were not copied.' }
      S.sheet = null
    } catch (err) {
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      f.error = err.message
      f.saving = false
    }
    await refresh()
    if (!S.sheet) backFromSheet()
  }

  async function saveSheet() {
    const f = S.sheet
    const p0 = f.editing
    f.saving = true
    f.error = null
    render()
    try {
      // a path typed or browsed to is started once before it is saved: a typo is found here,
      // not at the next Play
      const javaWas = f.editing ? profileNamed(f.editing)?.java ?? null : null
      const typedJava = fieldText(f.java)
      if (f.javaOther && !typedJava) f.javaOther = false
      if (typedJava && typedJava !== 'mojang' && typedJava !== javaWas && !(S.javas?.javas ?? []).some((j) => j.path === typedJava)) {
        // asked again: the file may have appeared, or the last answer was the panel's trouble
        f.javaCheck = null
        const check = await checkJava(f)
        if (check && check.found === false) {
          f.adv = true
          throw new Error(`The Java was not saved: ${check.message}`)
        }
      }
      if (!f.editing) {
        const body = newProfileBody(f, profilesNow().map((q) => q.name))
        const made = await api('client/profiles', { method: 'POST', body })
        pickProfile(made?.name ?? body.name)
        S.flash = { tone: 'live', title: `Made ${setupTitle(made ?? f)}`, text: 'Press Play to start it. The first time downloads the game.' }
      } else {
        // a new name first: everything after it speaks to the setup by that name
        const wanted = fieldText(f.name)
        if (!wanted) throw new Error('A setup needs a name')
        const before = profileNamed(f.editing)
        const patch = profilePatch(before ?? {}, editedProfile(f))
        if (wanted !== f.editing) {
          const renamed = await api(`client/profiles/${enc(f.editing)}/rename`, { method: 'POST', body: { name: wanted } })
          movedName(f.editing, renamed?.name ?? wanted)
          f.editing = f.name = renamed?.name ?? wanted
        }
        let out = { warnings: [] }
        try {
          if (Object.keys(patch).length) out = await api(`client/profiles/${enc(f.editing)}`, { method: 'PATCH', body: patch })
        } catch (err) {
          // the name did change: say so, or the error reads as if nothing was saved
          if (f.editing !== p0 && !(err instanceof PanelDown)) err.message = `Renamed to ${f.editing}, but the other changes were not saved: ${err.message}`
          throw err
        }
        const label = setupTitle(out.profile ?? before ?? f)
        if (patch.mc !== undefined) delete S.refusals[f.editing]
        S.flash = out.warnings?.length
          ? { tone: 'warn', title: `Saved ${label}`, text: out.warnings.map(sentence).join(' ') }
          : Object.keys(patch).length || wanted !== (p0 ?? wanted) ? { tone: 'live', title: `Saved ${label}` } : null
      }
      S.sheet = null
    } catch (err) {
      if (err instanceof PanelDown) { S.down = true; S.downWhy = null }
      f.error = err.message
      f.saving = false
    }
    await refresh()
    if (!S.sheet) backFromSheet()
  }

  // Focus goes to "Keep it" when the strip opens, so Enter twice does not remove anything.
  function removeLabel(purge) {
    return purge ? 'Remove and delete worlds' : 'Remove setup'
  }

  async function removeProfile(p, purge) {
    try {
      await api(`client/profiles/${enc(p.name)}${purge ? '?purge=1' : ''}`, { method: 'DELETE' })
      S.flash = { tone: 'live', title: `Removed ${setupTitle(p)}`, text: purge ? 'Its folder was deleted too.' : 'Its folder was kept.' }
      if (S.pick === p.name) pickProfile(null)
      delete S.targets[p.name]
      saveTargets()
      S.sheet = null
    } catch (err) {
      S.sheet.error = err.message
      S.sheet.removing = false
    }
    await refresh()
    if (!S.sheet) backFromSheet()
  }

