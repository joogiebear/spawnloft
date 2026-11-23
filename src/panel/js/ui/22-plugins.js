'use strict';
// ---------------------------------------------------------------- plugins ---

/** Update results for the server on screen, so leaving the tool does not lose them. */
const pluginView = { updates: null, for: null };

/*
  What the last update check found, per server, kept in the browser. The dock's badge and the
  "updates ready" callout read it without asking Modrinth anything - only pressing Check for
  updates goes to the network. An entry goes when its jar does: updated, deleted, or replaced
  by hand since the check.
*/
const updatesKey = (name) => 'mcctl.updates.' + name;

function cachedUpdates(name) {
  try {
    const saved = JSON.parse(localStorage.getItem(updatesKey(name)) || 'null');
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function saveUpdates(name, map) {
  try {
    if (map && Object.keys(map).length) localStorage.setItem(updatesKey(name), JSON.stringify(map));
    else localStorage.removeItem(updatesKey(name));
  } catch { /* a badge that cannot remember is a badge that waits for the next check */ }
}

/** The count on the Plugins tab, and the same number in its name for a screen reader. */
function renderDockBadge() {
  const button = $('#tabPlugins');
  const badge = button.querySelector('[data-badge]');
  const map = state.current && !isDb(rowOf(state.current)) ? cachedUpdates(state.current) : null;
  const n = map ? Object.keys(map).length : 0;
  badge.hidden = !n;
  badge.textContent = n ? String(n) : '';
  if (n) button.setAttribute('aria-label', toolLabel('plugins') + ', ' + n + (n === 1 ? ' update' : ' updates') + ' ready');
  else button.removeAttribute('aria-label');
}

/**
 * What this server loads, and what Modrinth can add to it.
 *
 * <p>The installed list works with no network at all; search, install and the update check
 * reach Modrinth and fail with a message rather than an empty screen. Every change here is a
 * file rename or a download - the server picks them up at its next start, and the pane says
 * so once at the top instead of on every row.
 */
/** "A", "A and B", "A, B and C". */
function listWords(items) {
  return items.length > 1 ? items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1] : items.join('');
}

/**
 * What to ask before a build made for another Minecraft version goes in, or null when the build
 * lists this server's version. It used to install unasked, with a note that left after five seconds.
 */
function mismatchQuestion(title, plan, gameVersion) {
  if (!plan || plan.exactMatch) return null;
  const runs = gameVersion ? 'Minecraft ' + gameVersion : 'this server\u2019s Minecraft version';
  return {
    title: 'Made for a different Minecraft version',
    text: 'The newest build of ' + title + (plan.builtFor ? ' lists Minecraft ' + plan.builtFor + ', and this server runs ' + (gameVersion || 'another version') + '.' : ' does not list ' + runs + '.')
      + ' It may work anyway, but its author has not said so.',
    confirmLabel: 'Install anyway',
  };
}

/**
 * What to ask when something cannot load without other things that are not ready here, or null
 * when it needs nothing more. `word` is "plugin" or "mod".
 *
 * Three kinds of "not ready": ones SpawnLoft can fetch (offered), ones it cannot (named, with
 * where they live when that is known), and ones that are here but turned off (said, since
 * fetching a second copy would be worse than the gap).
 */
function dependencyQuestion(title, plan, word) {
  const needs = ((plan && plan.requires) || []).filter((d) => !d.installed);
  if (!needs.length) return null;
  const names = (items) => listWords(items.map((d) => d.title));
  const isAre = (items) => (items.length === 1 ? ' is' : ' are');
  const off = needs.filter((d) => d.off);
  const cannot = needs.filter((d) => !d.off && (d.external || d.unnamed || !d.id));
  const can = needs.filter((d) => !d.off && !cannot.includes(d));
  const more = [];
  if (off.length) more.push(names(off) + isAre(off) + ' here but turned off: turn ' + (off.length === 1 ? 'it' : 'them') + ' on in the list below.');
  for (const d of cannot) {
    more.push(d.external ? 'SpawnLoft cannot fetch ' + d.title + ': get it from ' + d.external + ' and add it under Files.'
      : 'It also needs ' + d.title + ', which has to be found and added by hand.');
  }
  const wrong = can.filter((d) => d.mismatch);
  for (const d of wrong) more.push('The newest build of ' + d.title + (d.builtFor ? ' lists Minecraft ' + d.builtFor + ', not this server\u2019s version.' : ' does not list this server\u2019s Minecraft version.'));
  const text = 'It will not load without ' + names(needs) + '.' + (more.length ? ' ' + more.join(' ') : '');
  if (!can.length) {
    return { title: title + ' needs something that is not ready', text, confirmLabel: 'Install ' + title + ' anyway', fetch: [] };
  }
  return {
    title: title + ' needs ' + (can.length === 1 ? 'another ' + word : can.length + ' other ' + word + 's'),
    text,
    choices: [
      { value: 'with', label: 'Install ' + (can.length === 1 ? can[0].title : 'them') + ' too', hint: can.length === 1 ? 'Both are downloaded.' : names(can) + '.' },
      { value: 'alone', label: 'Only ' + title, hint: 'It stays unloaded until what it needs is added.' },
    ],
    confirmLabel: 'Install',
    fetch: can,
  };
}

/** One line for what an install did: the thing asked for, what came with it, and what did not. */
function installedWords(main, extras, failed) {
  const and = extras.length ? ', with ' + listWords(extras.map((e) => e.title)) : '';
  const not = failed.length ? ' Could not install ' + failed.map((f) => f.title + ' (' + f.why + ')').join(', ') + '.' : '';
  return { text: 'Installed ' + main.installed + (main.version ? ' (' + main.version + ')' : '') + and + '.' + not, tone: failed.length ? '' : 'good' };
}

/** The note on an installed row whose build does not list the Minecraft version the server runs now. */
function builtForWords(listed, gameVersion) {
  if (!Array.isArray(listed) || !listed.length || !gameVersion || listed.includes(gameVersion)) return null;
  const newest = listed[listed.length - 1];
  return { text: 'Built for ' + newest, title: 'This build lists Minecraft ' + newest + (listed.length > 1 ? ' and older' : '') + '. This server runs ' + gameVersion + '.' };
}


/** When the last update check ran, per server, so the list can say how old its answer is. */
const checkedAtKey = (name) => 'spawnloft.updates-checked.' + name;

function updatesCheckedAt(name) {
  try { return Number(localStorage.getItem(checkedAtKey(name))) || 0; } catch { return 0; }
}

function saveUpdatesCheckedAt(name, at) {
  try { localStorage.setItem(checkedAtKey(name), String(at)); } catch { /* the age is not shown */ }
}

/** The page of a search result on the site it came from, or null when that is not known. */
function projectPage(hit, mods) {
  if (!hit || !hit.slug) return null;
  if (hit.source === 'hangar') return hit.author ? 'https://hangar.papermc.io/' + encodeURIComponent(hit.author) + '/' + encodeURIComponent(hit.slug) : null;
  return 'https://modrinth.com/' + (mods ? 'mod' : 'plugin') + '/' + encodeURIComponent(hit.slug);
}

/**
 * Whether a search result is already in the folder. By where it came from where SpawnLoft knows
 * that (the jar's name inside often differs from the listing's title: "Essentials" against
 * "EssentialsX"), and by name for a jar added by hand.
 */
function isInstalledHit(hit, plugins) {
  return plugins.some((p) => (p.managed && p.project && p.project === hit.id && (p.source || 'modrinth') === (hit.source || 'modrinth'))
    || String(p.name).toLowerCase() === String(hit.title).toLowerCase());
}

/*
  The Plugins page is drawn with Tailwind classes, read from this file (panel.css @source).
  Its lists stop at a width they read at: past it a name and its buttons drift apart (U9).
*/
const PLUG_PAGE = 'grid w-full min-w-0 max-w-[1120px] gap-5';
const PLUG_ROW = 'grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-3 py-2.5 @min-[760px]/pane:grid-cols-[32px_minmax(0,1fr)_minmax(7ch,max-content)_10ch_auto]';
const PLUG_META = 'truncate text-2 text-ink-3';
const PLUG_BADGE = 'inline-flex h-5 flex-none items-center rounded-full border border-line px-2 text-1 font-medium text-ink-3';

/** A link out of the panel: the desktop's own browser, or a new tab. */
function plugLink(label, url) {
  const b = Kit.button({ label, icon: 'external', kind: 'ghost', size: 'sm', onClick: () => openOutside(url) });
  b.title = url;
  return b;
}

async function renderPlugins(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#pluginsBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (!force && body.dataset.for === row.name && body.childElementCount) return;
  if (pluginView.for !== row.name) { pluginView.updates = cachedUpdates(row.name); pluginView.for = row.name; }
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;

  let data;
  try {
    data = await api('/instances/' + encodeURIComponent(row.name) + '/plugins');
  } catch (e) {
    paneError(body, e.message, () => renderPlugins({ force: true }));
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== row.name) return;
  body.textContent = '';
  const page = Kit.h('div', { class: PLUG_PAGE });
  body.append(page);
  // Vanilla loads nothing, and a tab that pretends otherwise would offer downloads that could
  // only ever sit in a folder the server never reads. The way out is a different server software.
  if (data.kind === 'none') {
    paneHead(body, 'plug', 'Plugins', (data.software || 'This server') + ' runs no plugins and no mods.');
    page.append(Kit.h('div', { class: 'sl-card' }, Kit.empty({
      icon: 'plug',
      title: 'Nothing to add to ' + (data.software || 'this server'),
      text: 'Mojang’s own server loads nothing beyond the game. Paper, Purpur or Spigot load plugins; Fabric or NeoForge load mods.',
      actions: [Kit.button({ label: 'Change server software', kind: 'primary', onClick: () => openUpgrade() })],
    })));
    return;
  }
  const mods = data.kind === 'mods';
  const sources = data.hangar ? 'Modrinth or Hangar' : 'Modrinth';
  const singular = mods ? 'mod' : 'plugin';
  const plural = mods ? 'mods' : 'plugins';
  paneHead(body, 'plug', mods ? 'Mods' : 'Plugins',
    'Install from ' + sources + ' and keep it updated. '
    + (mods ? 'Mods' : 'Plugins') + ' you added by hand are left alone.');

  const base = '/instances/' + encodeURIComponent(row.name) + '/plugins';
  const again = () => renderPlugins({ force: true });
  const label = row.label || row.name;

  // What the last check said about a jar that is no longer there is no longer true.
  if (pluginView.updates) {
    const files = new Set(data.plugins.map((p) => p.file));
    const stale = Object.keys(pluginView.updates).filter((file) => !files.has(file));
    for (const file of stale) delete pluginView.updates[file];
    if (stale.length) { saveUpdates(row.name, pluginView.updates); renderDockBadge(); }
  }

  page.append(Kit.h('p', {
    class: 'sl-hint',
    text: (data.running
      ? 'The server is running, so everything here takes effect the next time it starts.'
      : 'Applies the next time the server starts.')
      + (data.gameVersion ? ' Builds for ' + data.gameVersion + ' are preferred; anything else asks first.' : '')
      + (mods ? ' Players need the same mods in their own game to join.' : ''),
  }));

  // A server a pack built says so, because the answer to "how do my friends join" is the
  // matching client pack - the single most-asked question about a modded server.
  if (data.pack) {
    const link = 'https://modrinth.com/project/' + encodeURIComponent(data.pack.project);
    const packCheck = Kit.button({ label: 'Check for a newer release', icon: 'restart', size: 'sm' });
    const packOut = Kit.h('div', { class: 'flex min-w-0 flex-wrap items-center gap-2 text-2 text-ink-2', 'aria-live': 'polite' });
    page.append(Kit.h('section', { class: 'sl-card grid gap-3', 'aria-label': 'Modpack' },
      Kit.h('div', { class: 'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2' },
        Kit.h('div', { class: 'grid min-w-0 flex-[1_1_320px] gap-0.5' },
          Kit.h('span', { class: 'sl-eyebrow', text: 'Modpack' }),
          Kit.h('b', { class: 'truncate text-3 font-semibold text-ink', text: data.pack.name + (data.pack.version ? ' ' + data.pack.version : '') }),
          Kit.h('span', { class: 'text-2 text-ink-3', text: 'Players join with the same pack, installed in their own launcher.' })),
        plugLink('Open on Modrinth', link), packCheck),
      packOut));
    packOut.hidden = true;

    packCheck.onclick = async () => {
      busy(packCheck, true);
      packOut.hidden = false;
      packOut.textContent = 'Asking Modrinth…';
      let info;
      try {
        info = await api('/instances/' + encodeURIComponent(row.name) + '/pack');
      } catch (e) {
        packOut.hidden = true;
        toast(e.message, 'bad');
        busy(packCheck, false);
        return;
      }
      busy(packCheck, false);
      if (!info.updateAvailable) {
        packOut.textContent = 'This is the newest release of the pack.';
        return;
      }
      packOut.textContent = '';
      // The pack's own files change under a running server, so the core refuses then: the button
      // says so before it is pressed rather than after.
      const go = Kit.button({ label: 'Update pack to ' + info.latest.version, kind: 'primary', size: 'sm', disabled: data.running });
      packOut.append(Kit.h('span', { text: 'Release ' + info.latest.version + ' is out.' }), go);
      if (data.running) packOut.append(Kit.h('span', { class: 'text-ink-3', text: 'Stop the server to update it.' }));
      go.onclick = async () => {
        const ok = await ask({
          title: 'Update ' + data.pack.name + ' to ' + info.latest.version + '?',
          text: 'A backup is taken first. Only files the old release had and the new one does not are removed: '
            + 'the worlds and anything you added by hand stay. Players need the new release of the pack too.',
          confirmLabel: 'Update pack',
          danger: true,
        });
        if (!ok) return;
        busy(go, true);
        const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
        const jobs = new EventSource('/api/jobs/' + jobId + '/stream');
        const said = Kit.h('span', { class: 'text-ink-3' });
        packOut.append(said);
        jobs.onmessage = (ev) => {
          let job;
          try { job = JSON.parse(ev.data); } catch { return; }
          if (job.message) said.textContent = job.message;
        };
        try {
          const out = await post('/instances/' + encodeURIComponent(row.name) + '/pack', { jobId: jobId });
          jobs.close();
          toast(out.alreadyLatest
            ? 'Already on the newest release.'
            : 'Updated to ' + out.to + '. A backup was taken first, and ' + out.removed + ' file'
              + (out.removed === 1 ? '' : 's') + ' the new release no longer has ' + (out.removed === 1 ? 'was' : 'were') + ' removed.'
              + (out.mcChanged ? ' Minecraft is now ' + out.mc + ': the worlds are upgraded when it next starts.' : '')
              + ' Players need the new release too.', 'good', { stay: true });
          await refresh();
          await again();
        } catch (e) {
          jobs.close();
          said.textContent = '';
          toast(e.message, 'bad');
          busy(go, false);
        }
      };
    };
  }

  // ---- add from Modrinth or Hangar ---------------------------------------------
  // First, because finding something new is the thing this tool is opened for most; the list of
  // what is already there is below it, where a glance down finds it.
  const q = Kit.h('input', {
    class: 'sl-input', type: 'search', autocomplete: 'off', spellcheck: false,
    placeholder: mods ? 'Find mods on Modrinth' : 'Find plugins on ' + sources,
  });
  q.setAttribute('aria-label', q.placeholder);
  const go = Kit.button({ label: 'Search', icon: 'search' });
  // Results are said when they come: a list that fills silently is a list nobody hears arrive.
  const results = Kit.h('div', { class: 'grid min-w-0 gap-2', 'aria-live': 'polite' });
  const add = Kit.h('section', { class: 'grid min-w-0 gap-3', 'aria-label': 'Add ' + plural },
    Kit.h('div', { class: 'flex min-w-0 gap-2' },
      Kit.h('span', { class: 'sl-input-group min-w-0 flex-1' }, Kit.h('span', { class: 'sl-input-lead', 'aria-hidden': 'true' }, Kit.icon('search')), q),
      go),
    results);
  page.append(add);
  // A search and its results are not redrawn from under whoever is reading them.
  q.addEventListener('input', () => add.toggleAttribute('data-holding', Boolean(q.value.trim())));

  /** A search that could not be made: why, and the way to make it again. */
  const searchFailed = (reasons, again = true) => {
    const box = Kit.h('div', { class: 'grid justify-items-start gap-2' }, reasons.map((reason) => Kit.h('p', { class: 'sl-error', text: reason })));
    if (again) box.append(Kit.button({ label: 'Try again', size: 'sm', onClick: () => doSearch() }));
    return box;
  };

  const doSearch = async () => {
    const term = q.value.trim();
    if (!term) return;
    busy(go, true);
    results.replaceChildren(Kit.h('p', { class: 'sl-hint flex items-center gap-2' }, Kit.spinner(), 'Asking ' + (data.hangar ? 'Modrinth and Hangar…' : 'Modrinth…')));
    let found;
    try {
      found = await api(base + '/search?q=' + encodeURIComponent(term));
    } catch (e) {
      busy(go, false);
      results.replaceChildren(searchFailed([e.message]));
      return;
    }
    busy(go, false);
    results.textContent = '';
    const failed = (found.errors || []).map(plainMessage);
    // A source that was not reached found nothing because it was not asked, which is not the
    // same as there being nothing: no "nothing matches" under a failure.
    if (failed.length && !found.results.length) {
      // "Fabric runs no plugins or mods" is an answer, not a failure: no button that cannot help.
      results.append(searchFailed(failed, !failed.every((why) => /runs no plugins or mods/.test(why))));
      return;
    }
    for (const err of failed) results.append(Kit.h('p', { class: 'sl-error', text: err }));
    if (!found.results.length) {
      // The search is by name, not by version, so the version is not named as if it had been asked.
      results.append(Kit.h('div', { class: 'sl-card' }, Kit.empty({ icon: 'search', title: 'Nothing on ' + sources + ' is called that', text: 'Try a shorter name, or the name the author uses.' })));
      return;
    }
    results.append(Kit.h('p', { class: 'sl-hint', text: found.results.length + (found.results.length === 1 ? ' result' : ' results') + ' for “' + term + '”' }));
    const list = Kit.h('div', { class: 'sl-list', role: 'list', 'aria-label': 'Search results' });
    for (const hit of found.results) list.append(resultRow(hit, list));
    results.append(list);
  };
  go.onclick = doSearch;
  q.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

  /** One search result: its face, who made it, how many use it, its page, and Install. */
  const resultRow = (hit, list) => {
    const have = isInstalledHit(hit, data.plugins);
    const face = Kit.tile({ name: hit.title, key: hit.id || hit.title, image: hit.icon || null, size: 'sm' });
    const facts = [hit.author ? 'by ' + hit.author : '', hit.downloads ? hit.downloads.toLocaleString() + ' downloads' : ''].filter(Boolean).join('  ·  ');
    const install = Kit.button({ label: have ? 'Installed' : 'Install', icon: have ? 'check' : 'download', size: 'sm', disabled: have });
    install.dataset.title = hit.title;
    install.dataset.project = hit.id || '';
    install.setAttribute('aria-label', (have ? 'Installed: ' : 'Install ') + hit.title);
    const page = projectPage(hit, mods);
    const el = Kit.h('div', { class: 'flex min-h-[64px] min-w-0 items-center gap-3 py-2.5', role: 'listitem' },
      face,
      Kit.h('div', { class: 'grid min-w-0 flex-1 gap-0.5' },
        Kit.h('div', { class: 'flex min-w-0 items-center gap-2' },
          Kit.h('span', { class: 'truncate text-3 font-semibold text-ink', text: hit.title }),
          Kit.h('span', { class: PLUG_BADGE, text: hit.source === 'hangar' ? 'Hangar' : 'Modrinth' }),
          facts ? Kit.h('span', { class: 'hidden truncate text-2 text-ink-3 @min-[640px]/pane:inline', text: facts }) : null),
        hit.description ? Kit.h('span', { class: 'line-clamp-2 text-2 text-ink-2 @min-[1100px]/pane:line-clamp-1', text: hit.description }) : null),
      Kit.h('div', { class: 'flex flex-none items-center gap-1' },
        page ? Kit.button({ icon: 'external', kind: 'ghost', size: 'sm', title: 'Open its page on ' + (hit.source === 'hangar' ? 'Hangar' : 'Modrinth'), onClick: () => openOutside(page) }) : null,
        install));

    // back to how it was, with focus where it had been: a disabled button drops it
    const reset = () => { busy(install, false); install.focus(); };
    install.onclick = async () => {
      busy(install, true, 'Checking…');
      try {
        // asked first: what would be fetched, whether it is for this version, what it needs
        const plan = await api(base + '/plan?projectId=' + encodeURIComponent(hit.id) + '&source=' + encodeURIComponent(hit.source || 'modrinth'));
        const wrong = mismatchQuestion(hit.title, plan, data.gameVersion);
        if (wrong && !(await ask(wrong))) return reset();
        const needs = dependencyQuestion(hit.title, plan, singular);
        let also = [];
        if (needs) {
          const got = await ask(needs);
          if (!got) return reset();
          if (needs.choices && got.choice === 'with') also = needs.fetch;
        }
        install.lastChild.textContent = 'Downloading…';
        // one request, so one backup of the folder covers the lot
        const out = await post(base + '/install', { projectId: hit.id, source: hit.source, also: also.map((d) => ({ projectId: d.id, source: d.source })) });
        const titleOf = (id) => (also.find((d) => d.id === id) || { title: id }).title;
        const extras = (out.extras || []).map((e) => ({ title: titleOf(e.projectId), id: e.projectId }));
        const failed = (out.failed || []).map((f) => ({ title: titleOf(f.projectId), why: plainMessage(f.error) }));
        const said = installedWords(out, extras, failed);
        toast(said.text, said.tone);
        // The search stays as it was: three plugins from one search is one search. Only the
        // list of what is installed is fetched again, and the rows it now holds say so.
        const got = new Set([hit.id, ...extras.map((e) => e.id)]);
        for (const other of list.querySelectorAll('button[data-project]')) {
          if (!got.has(other.dataset.project)) continue;
          busy(other, false);
          other.replaceChildren(Kit.icon('check'), 'Installed');
          other.disabled = true;
          other.setAttribute('aria-label', 'Installed: ' + other.dataset.title);
        }
        q.focus();
        await refreshInstalled();
      } catch (e) {
        toast(e.message, 'bad');
        reset();
      }
    };
    return el;
  };

  // ---- updates ready -----------------------------------------------------------
  const callout = Kit.h('div', { class: 'sl-banner', 'data-tone': 'live', role: 'status' });
  callout.hidden = true;
  page.append(callout);

  // ---- what is installed -------------------------------------------------------
  // Everything in the folder, not only what SpawnLoft installed: a jar dropped in by hand is
  // listed rather than being a number in a footnote. Every row can be turned off and removed -
  // a broken jar added by hand is exactly the one someone needs to switch off - but only the ones
  // SpawnLoft put there get updates, since it knows where to fetch them from.
  const listTitle = Kit.h('h3', { class: 'type-label m-0 flex-1 text-ink-3' });
  const check = Kit.button({ label: 'Check for updates', icon: 'restart', kind: 'ghost', size: 'sm' });
  const checkNote = Kit.h('p', { class: 'sl-hint', 'aria-live': 'polite' });
  const listWrap = Kit.h('div', { class: 'min-w-0' });
  page.append(Kit.h('section', { class: 'grid min-w-0 gap-2', 'aria-label': 'Installed ' + plural },
    Kit.h('div', { class: 'flex min-w-0 items-center gap-2' }, listTitle, check), checkNote, listWrap));
  const paintTitle = () => { listTitle.textContent = 'Installed (' + data.plugins.length + ')'; };
  paintTitle();
  // How old the answer is, where there is one: an update found three weeks ago may be old news.
  const checkedAt = updatesCheckedAt(row.name);
  if (checkedAt) checkNote.textContent = 'Last checked ' + ago(checkedAt) + '.';
  checkNote.hidden = !checkedAt;

  // After an install: the list below and its count, and nothing above it.
  const refreshInstalled = async () => {
    try {
      const fresh = await api(base);
      if (body.dataset.for !== row.name) return;
      data.plugins = fresh.plugins;
      paintTitle();
      paint();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  const nameOf = (file) => (data.plugins.find((p) => p.file === file) || { name: file }).name;
  const knownUpdates = () => Object.values(pluginView.updates || {});
  const forget = (file) => {
    if (!pluginView.updates) return;
    delete pluginView.updates[file];
    saveUpdates(row.name, pluginView.updates);
    renderDockBadge();
  };

  check.onclick = async () => {
    busy(check, true);
    checkNote.hidden = false;
    checkNote.textContent = 'Asking ' + sources.replace(' or ', ' and ') + ' about everything SpawnLoft installed…';
    try {
      const out = await post(base + '/updates');
      pluginView.updates = {};
      for (const u of out.updates) pluginView.updates[u.file] = u;
      saveUpdates(row.name, pluginView.updates);
      saveUpdatesCheckedAt(row.name, Date.now());
      renderDockBadge();
      checkNote.textContent = updateCheckWords(out, singular);
      paint();
    } catch (e) {
      checkNote.textContent = '';
      checkNote.hidden = true;
      toast(e.message, 'bad');
    } finally {
      busy(check, false);
    }
  };

  /** Restart the server the updates were for, which may no longer be the one on screen. */
  const restartFor = async () => {
    if (state.current === row.name && !state.busy) { await act('restart', { sure: true })(); return; }
    try {
      await post('/instances/' + encodeURIComponent(row.name) + '/restart');
      toast('Restarted ' + label + '.', 'good');
    } catch (e) {
      toast('Updated, but ' + label + ' did not restart: ' + e.message, 'bad', { stay: true });
    }
  };

  /**
   * Every known update in one go. One backup of the folder first, then each in turn, then - on a
   * running server, if wanted now - the restart that loads them. Everything on the page waits
   * while the jars are swapped.
   */
  const updateAll = async (known, progress) => {
    const running = data.running;
    const what = known.length === 1 ? '1 ' + singular : known.length + ' ' + plural;
    const answer = await ask({
      title: 'Update ' + what + '?',
      text: 'A backup of the ' + data.kind + ' folder is taken first, then each is updated in turn.'
        + (running ? ' They load when ' + label + ' restarts; anyone online is disconnected for the restart.' : ' They load the next time the server starts.'),
      choices: running ? [
        { value: 'now', label: 'Restart when done', hint: 'The updates are in use a minute from now.' },
        { value: 'later', label: 'I’ll restart later', hint: 'Nobody is disconnected now.' },
      ] : undefined,
      confirmLabel: 'Update all',
    });
    if (!answer) return;
    const restart = running && answer.choice !== 'later';
    const locked = [...page.querySelectorAll('button:not(:disabled), input')];
    for (const b of locked) b.disabled = true;
    const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
    const jobs = new EventSource('/api/jobs/' + jobId + '/stream');
    jobs.onmessage = (ev) => {
      let job;
      try { job = JSON.parse(ev.data); } catch { return; }
      if (job.message) progress.textContent = job.message;
    };
    let out;
    try {
      out = await post(base + '/update-all', { files: known.map((u) => u.file), jobId: jobId });
    } catch (e) {
      jobs.close();
      toast(e.message, 'bad');
      progress.textContent = '';
      for (const b of locked) b.disabled = false;
      return;
    }
    jobs.close();
    for (const u of out.updated) forget(u.file);
    for (const f of out.failed) toast(nameOf(f.file) + ' was not updated: ' + f.error, 'bad');
    if (out.updated.length) {
      toast('Updated ' + listWords(out.updated.map((u) => nameOf(u.file)))
        + '. A backup of the ' + data.kind + ' folder was taken first.'
        + (running && !restart ? ' They load when ' + label + ' restarts.' : ''), 'good');
    }
    if (restart && out.updated.length) {
      progress.textContent = 'Restarting ' + label + '…';
      await restartFor();
    }
    if (body.dataset.for === row.name) await again();
  };

  const paintCallout = () => {
    const known = knownUpdates();
    callout.hidden = !known.length;
    callout.textContent = '';
    if (!known.length) return;
    const run = Kit.button({ label: data.running ? 'Update all…' : 'Update all', kind: 'primary', size: 'sm' });
    const progress = Kit.h('div', { class: 'basis-full text-2 text-ink-2 empty:hidden', 'aria-live': 'polite' });
    callout.append(
      Kit.icon('bolt'),
      Kit.h('div', { class: 'sl-banner-text' },
        Kit.h('div', { class: 'sl-banner-title', text: known.length + (known.length === 1 ? ' update ready' : ' updates ready') }),
        Kit.h('div', { class: 'sl-banner-body truncate', text: listWords(known.map((u) => nameOf(u.file) + ' ' + u.latestVersion)) })),
      Kit.h('div', { class: 'sl-banner-actions' }, run),
      progress);
    callout.classList.add('flex-wrap');
    run.onclick = () => updateAll(known, progress);
  };

  const paint = () => {
    paintCallout();
    listWrap.textContent = '';
    if (!data.plugins.length) {
      listWrap.append(Kit.h('div', { class: 'sl-card' }, Kit.empty({
        icon: 'plug',
        title: 'No ' + plural + ' yet',
        text: 'Search ' + sources + ' above and they land in this server’s ' + data.kind + ' folder. A .jar you have already can go in under Files.',
        actions: [
          Kit.button({ label: 'Find ' + plural, icon: 'search', kind: 'primary', onClick: () => q.focus() }),
          Kit.button({ label: 'Open the ' + data.kind + ' folder', icon: 'folder', onClick: () => openContentFolder() }),
        ],
      })));
      return;
    }
    const list = Kit.h('div', { class: 'sl-list', role: 'list', 'aria-label': 'Installed ' + plural });
    for (const p of data.plugins) list.append(pluginRow(p));
    listWrap.append(list);
  };

  /** Files, at the folder this page lists. */
  const openContentFolder = () => {
    const view = filesStateFor(row.name);
    if (!view.editing) { view.dir = data.kind; view.query = ''; view.selected.clear(); }
    $('#filesBody').dataset.for = '';
    showPane('files');
  };

  /** Two capitals from the name where it has them - "WE", "LP" - or its first letter. */
  function monogram(name) {
    const caps = String(name).match(/[A-Z]/g) || [];
    if (caps.length >= 2) return caps[0] + caps[1];
    const first = String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 1);
    return first ? first.toUpperCase() : '?';
  }

  function pluginRow(p) {
    const off = !p.enabled;
    const tile = Kit.tile({ name: p.name, key: p.name, size: 'sm' });
    tile.textContent = monogram(p.name);
    tile.classList.add('text-1');
    if (off) tile.classList.add('opacity-55');

    // Where it came from and the jar's own name, in mono, wherever the name above is not already
    // it - so "EssentialsX-2.20.1" is not read as a plugin called that.
    const from = !p.managed ? 'Added by hand'
      : p.source === 'hangar' ? 'Hangar' : p.source === 'modpack' ? 'Modpack' : 'Modrinth';
    const src = Kit.h('div', { class: PLUG_META }, from);
    if (p.name !== p.file.replace(/\.jar(\.disabled)?$/, '')) src.append(' · ', Kit.h('code', { class: 'font-mono text-1', text: p.file }));
    src.append(' · ' + fileSize(p.size));
    // The version moves into this line where there is no column for it.
    src.append(Kit.h('span', { class: '@min-[760px]/pane:hidden', text: ' · ' + (p.version || 'no version') }));
    // Said on the row for as long as it is true, where it used to be a toast that left.
    const builtFor = builtForWords(p.gameVersions, data.gameVersion);
    if (builtFor) src.append(' · ', Kit.h('span', { class: 'text-warn-ink', text: builtFor.text, title: builtFor.title }));
    // What it is and who made it, on the row rather than in a tooltip nobody can reach with keys.
    const about = [p.description, p.authors.length ? 'by ' + p.authors.join(', ') : ''].filter(Boolean).join('  ·  ');

    const main = Kit.h('div', { class: 'grid min-w-0 gap-0.5' },
      Kit.h('span', { class: 'truncate text-3 font-semibold ' + (off ? 'text-ink-3' : 'text-ink'), text: p.name }),
      src,
      about ? Kit.h('span', { class: 'hidden truncate text-2 text-ink-3 @min-[1000px]/pane:block', text: about }) : null);

    const ver = Kit.h('span', {
      class: 'hidden truncate text-right font-mono text-2 text-ink-2 @min-[760px]/pane:block',
      text: p.version || '—',
      title: p.version ? null : 'The jar does not say which version it is',
    });

    // On or off as a word with a dot, not only a dimmed row. Turned off on a running server, it is
    // still loaded until the restart, and the word says that too.
    const onOff = Kit.h('span', { class: 'hidden items-center gap-1.5 text-2 whitespace-nowrap @min-[760px]/pane:inline-flex ' + (off ? 'text-ink-3' : 'text-ink-2') },
      Kit.dot({ tone: off ? null : 'live', hollow: off }), off ? 'Disabled' : 'Enabled');

    const acts = Kit.h('div', { class: 'flex items-center justify-end gap-1' });
    const update = p.managed && pluginView.updates && pluginView.updates[p.file];
    const upBtn = update ? Kit.button({ label: 'Update to ' + update.latestVersion, size: 'sm' }) : null;
    if (upBtn) {
      upBtn.setAttribute('aria-label', 'Update ' + p.name + ' to ' + update.latestVersion);
      acts.append(upBtn);
    }
    const toggle = Kit.button({ label: off ? 'Enable' : 'Disable', kind: 'ghost', size: 'sm' });
    toggle.setAttribute('aria-label', (off ? 'Enable ' : 'Disable ') + p.name);
    const drop = Kit.button({ icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete ' + p.name });
    acts.append(toggle, drop);

    const el = Kit.h('div', { class: PLUG_ROW, role: 'listitem', dataset: { file: p.file } }, tile, main, ver, onOff, acts);
    if (off) el.dataset.off = '';

    const lock = (on) => { for (const b of acts.querySelectorAll('button')) b.disabled = on; };

    if (upBtn) {
      upBtn.onclick = async () => {
        lock(true);
        busy(upBtn, true, 'Updating…');
        try {
          const out = await post(base + '/update', { file: p.file });
          forget(p.file);
          toast(out.alreadyLatest
            ? p.name + ' is already the newest build.'
            : 'Updated ' + p.name + ' to ' + out.version + '. A backup of the ' + data.kind + ' folder was taken first.', 'good');
          if (out.versionNote) toast(out.versionNote);
          await again();
        } catch (e) {
          toast(e.message, 'bad');
          busy(upBtn, false);
          lock(false);
        }
      };
    }

    toggle.onclick = async () => {
      lock(true);
      try {
        await post(base + '/toggle', { file: p.file, enabled: off });
        toast(p.name + (off ? ' enabled.' : ' disabled.') + ' Takes effect on the next start.', 'good');
        await again();
        // back on the same row's button, which the redraw replaced
        $('#pluginsBody [data-file="' + CSS.escape(p.file.replace(/\.disabled$/, '') + (off ? '' : '.disabled')) + '"] button.sl-btn-ghost')?.focus();
      } catch (e) {
        toast(e.message, 'bad');
        lock(false);
      }
    };

    drop.onclick = async () => {
      const ok = await ask({
        title: 'Delete ' + p.name + '?',
        text: p.file + ' is removed from the ' + data.kind + ' folder. Its config folder stays, so '
          + 'installing it again picks up where it left off.'
          // Nothing to fetch it back from: SpawnLoft did not install it.
          + (p.managed ? '' : ' It was added by hand, so SpawnLoft cannot download it again; '
            + 'keep a copy if you might want it back, or Disable it instead.'),
        confirmLabel: 'Delete ' + singular,
        danger: true,
      });
      if (!ok) return;
      lock(true);
      try {
        await post(base + '/delete', { file: p.file });
        forget(p.file);
        toast('Deleted ' + p.name + '.', 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        lock(false);
      }
    };
    return el;
  }

  paint();
}
