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
  // Vanilla loads nothing, and a tab that pretends otherwise would offer downloads that could
  // only ever sit in a folder the server never reads.
  if (data.kind === 'none') {
    paneHead(body, 'plug', 'Plugins', (data.software || 'This server') + ' runs no plugins and no mods.');
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'Mojang’s own server loads nothing beyond the game. For plugins, create a Paper, '
      + 'Purpur or Spigot server; for mods, a Fabric or NeoForge one.';
    body.append(none);
    return;
  }
  const mods = data.kind === 'mods';
  const sources = data.hangar ? 'Modrinth or Hangar' : 'Modrinth';
  paneHead(body, 'plug', mods ? 'Mods' : 'Plugins',
    'Install from ' + sources + ' and keep it updated. '
    + (mods ? 'Mods' : 'Plugins') + ' you added by hand are left alone.');

  const base = '/instances/' + encodeURIComponent(row.name) + '/plugins';
  const again = () => renderPlugins({ force: true });

  // What the last check said about a jar that is no longer there is no longer true.
  if (pluginView.updates) {
    const files = new Set(data.plugins.map((p) => p.file));
    const stale = Object.keys(pluginView.updates).filter((file) => !files.has(file));
    for (const file of stale) delete pluginView.updates[file];
    if (stale.length) { saveUpdates(row.name, pluginView.updates); renderDockBadge(); }
  }

  const how = document.createElement('div');
  how.className = 'hint';
  how.textContent = (data.running
    ? 'The server is running, so everything here takes effect the next time it starts.'
    : 'Applies the next time the server starts.')
    + (data.gameVersion
      ? ' Builds for ' + data.gameVersion + ' are preferred; anything else asks first.'
      : '');
  body.append(how);

  // A server a pack built says so, because the answer to "how do my friends join" is the
  // matching client pack - the single most-asked question about a modded server.
  if (data.pack) {
    const packBox = document.createElement('div');
    packBox.className = 'section';
    const packTitle = document.createElement('h3');
    packTitle.textContent = 'Modpack';
    const packLine = document.createElement('div');
    packLine.className = 'hint';
    const link = 'https://modrinth.com/project/' + encodeURIComponent(data.pack.project);
    packLine.textContent = data.pack.name + ' ' + (data.pack.version || '')
      + '. Players join with the matching client pack, installed in their own launcher: ';
    if (desktop) {
      const open = document.createElement('button');
      open.className = 'ghost inline';
      open.style.cssText = 'padding:2px 8px;font-size:12px';
      open.textContent = 'Open on Modrinth';
      open.onclick = () => desktop.openExternal(link);
      packLine.append(open);
    } else {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.style.color = 'inherit';
      a.textContent = link;
      packLine.append(a);
    }
    const packRow = document.createElement('div');
    packRow.className = 'row';
    const packCheck = iconButton('restore', 'Check for a newer release');
    packRow.append(packCheck);
    const packOut = document.createElement('div');
    packOut.className = 'hint';
    packBox.append(packTitle, packLine, packRow, packOut);
    body.append(packBox);

    packCheck.onclick = async () => {
      packCheck.disabled = true;
      packOut.textContent = 'Asking Modrinth…';
      let info;
      try {
        info = await api('/instances/' + encodeURIComponent(row.name) + '/pack');
      } catch (e) {
        packOut.textContent = '';
        toast(e.message, 'bad');
        packCheck.disabled = false;
        return;
      }
      packCheck.disabled = false;
      if (!info.updateAvailable) {
        packOut.textContent = 'This is the newest release of the pack.';
        return;
      }
      packOut.textContent = 'Release ' + info.latest.version + ' is out.';
      const go = document.createElement('button');
      go.className = 'primary';
      go.style.marginLeft = '8px';
      go.textContent = 'Update pack to ' + info.latest.version;
      packOut.append(go);
      go.onclick = async () => {
        const ok = await ask({
          title: 'Update ' + data.pack.name + ' to ' + info.latest.version + '?',
          text: 'The server must be stopped. A backup is taken first; only files the '
            + 'old pack owned and the new one dropped are removed - the worlds and anything you '
            + 'added by hand are never touched. Players will need the matching new client pack.',
          confirmLabel: 'Update pack',
          danger: true,
        });
        if (!ok) return;
        go.disabled = true;
        const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
        const jobs = new EventSource('/api/jobs/' + jobId + '/stream');
        jobs.onmessage = (ev) => {
          let job;
          try { job = JSON.parse(ev.data); } catch { return; }
          if (job.message) packOut.textContent = job.message;
        };
        try {
          const out = await post('/instances/' + encodeURIComponent(row.name) + '/pack', { jobId: jobId });
          jobs.close();
          toast(out.alreadyLatest
            ? 'Already on the newest release.'
            : 'Updated to ' + out.to + '. A backup was taken first; ' + out.removed + ' old pack file'
              + (out.removed === 1 ? '' : 's') + ' retired.'
              + (out.mcChanged ? ' Minecraft moved to ' + out.mc + ' - the worlds migrate on the next start.' : ''), 'good');
          await refresh();
          await again();
        } catch (e) {
          jobs.close();
          packOut.textContent = '';
          toast(e.message, 'bad');
          go.disabled = false;
        }
      };
    };
  }

  // ---- add from Modrinth or Hangar ---------------------------------------------
  // First, because finding something new is the thing this tool is opened for most; the list of
  // what is already there is below it, where a glance down finds it.
  const add = document.createElement('div');
  add.className = 'plug-add';
  const addRow = document.createElement('div');
  addRow.className = 'row';
  const q = document.createElement('input');
  q.type = 'search';
  q.placeholder = mods ? 'Add mods from Modrinth' : 'Add from ' + sources;
  q.setAttribute('aria-label', q.placeholder);
  q.style.flex = '1 1 200px';
  const go = iconButton('search', 'Search');
  addRow.append(q, go);
  const results = document.createElement('div');
  add.append(addRow, results);
  body.append(add);
  // A search and its results are not redrawn from under whoever is reading them.
  q.addEventListener('input', () => add.toggleAttribute('data-holding', Boolean(q.value.trim())));

  /** A search that could not be made: why, and the way to make it again. */
  const searchFailed = (reasons, again = true) => {
    const box = document.createElement('div');
    box.style.display = 'grid';
    box.style.gap = '8px';
    box.style.justifyItems = 'start';
    for (const reason of reasons) {
      const bad = document.createElement('div');
      bad.className = 'bad';
      bad.textContent = reason;
      box.append(bad);
    }
    if (!again) return box;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.onclick = () => doSearch();
    box.append(retry);
    return box;
  };

  const doSearch = async () => {
    const term = q.value.trim();
    if (!term) return;
    go.disabled = true;
    results.textContent = '';
    const looking = document.createElement('div');
    looking.className = 'hint';
    looking.textContent = 'Asking ' + (data.hangar ? 'Modrinth and Hangar…' : 'Modrinth…');
    results.append(looking);
    let found;
    try {
      found = await api(base + '/search?q=' + encodeURIComponent(term));
    } catch (e) {
      looking.remove();
      go.disabled = false;
      results.append(searchFailed([e.message]));
      return;
    }
    go.disabled = false;
    results.textContent = '';
    const failed = (found.errors || []).map(plainMessage);
    // A source that was not reached found nothing because it was not asked, which is not the
    // same as there being nothing: no "nothing matches" under a failure.
    if (failed.length && !found.results.length) {
      // "Fabric runs no plugins or mods" is an answer, not a failure: no button that cannot help.
      results.append(searchFailed(failed, !failed.every((why) => /runs no plugins or mods/.test(why))));
      return;
    }
    for (const err of failed) {
      const bad = document.createElement('div');
      bad.className = 'bad';
      bad.textContent = err;
      results.append(bad);
    }
    if (!found.results.length) {
      results.append(emptyState('search', 'Nothing on ' + sources + ' matches that'
        + (data.gameVersion ? ' for ' + data.gameVersion + '.' : '.')));
      return;
    }
    const list = document.createElement('div');
    list.className = 'people';
    const installedNames = new Set(data.plugins.map((p) => p.name.toLowerCase()));
    for (const hit of found.results) {
      const el = document.createElement('div');
      el.className = 'who';
      const mark = document.createElement('div');
      mark.className = 'face face-mark';
      mark.append(icon('plug'));
      const nm = document.createElement('div');
      nm.className = 'w-name';
      const title = document.createElement('span');
      title.textContent = hit.title;
      const src = document.createElement('span');
      src.className = 'pill';
      src.textContent = hit.source === 'hangar' ? 'Hangar' : 'Modrinth';
      nm.append(title, src);
      const meta = document.createElement('div');
      meta.className = 'w-meta';
      meta.textContent = (hit.downloads ? hit.downloads.toLocaleString() + ' downloads  ·  ' : '')
        + (hit.description || '');
      const acts = document.createElement('div');
      acts.className = 'w-acts';
      const install = document.createElement('button');
      const have = installedNames.has(hit.title.toLowerCase());
      install.textContent = have ? 'Installed' : 'Install';
      install.dataset.title = hit.title;
      install.setAttribute('aria-label', (have ? 'Installed: ' : 'Install ') + hit.title);
      install.disabled = have;
      if (!have) install.className = 'primary';
      acts.append(install);
      el.append(mark, nm, meta, acts);
      list.append(el);

      // back to how it was, with focus where it had been: a disabled button drops it
      const reset = () => { install.disabled = false; install.textContent = 'Install'; install.focus(); };
      install.onclick = async () => {
        install.disabled = true;
        install.textContent = 'Checking\u2026';
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
          install.textContent = 'Downloading\u2026';
          // one request, so one backup of the folder covers the lot
          const out = await post(base + '/install', { projectId: hit.id, source: hit.source, also: also.map((d) => ({ projectId: d.id, source: d.source })) });
          const titleOf = (id) => (also.find((d) => d.id === id) || { title: id }).title;
          const extras = (out.extras || []).map((e) => ({ title: titleOf(e.projectId) }));
          const failed = (out.failed || []).map((f) => ({ title: titleOf(f.projectId), why: plainMessage(f.error) }));
          const said = installedWords(out, extras, failed);
          toast(said.text, said.tone);
          // The search stays as it was: three plugins from one search is one search. Only the
          // list of what is installed is fetched again.
          for (const got of [hit, ...extras]) installedNames.add(got.title.toLowerCase());
          for (const other of list.querySelectorAll('.w-acts button')) {
            if (!installedNames.has((other.dataset.title || '').toLowerCase())) continue;
            other.textContent = 'Installed';
            other.disabled = true;
            other.className = '';
            other.setAttribute('aria-label', 'Installed: ' + other.dataset.title);
          }
          q.focus();
          await refreshInstalled();
        } catch (e) {
          toast(e.message, 'bad');
          reset();
        }
      };
    }
    results.append(list);
  };
  go.onclick = doSearch;
  q.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };

  // ---- updates ready -----------------------------------------------------------
  const callout = document.createElement('div');
  callout.className = 'callout';
  body.append(callout);

  // ---- what is installed -------------------------------------------------------
  // Everything in the folder, not only what SpawnLoft installed: a jar dropped in by hand is
  // listed rather than being a number in a footnote. Every row can be turned off and removed -
  // a broken jar added by hand is exactly the one someone needs to switch off - but only the ones
  // SpawnLoft put there get updates, since it knows where to fetch them from.
  const listHead = document.createElement('div');
  listHead.className = 'plug-head';
  const listTitle = document.createElement('h3');
  listTitle.className = 'hist-title';
  listTitle.textContent = 'Installed (' + data.plugins.length + ')';
  const check = iconButton('restore', 'Check for updates', 'ghost');
  listHead.append(listTitle, check);
  const checkNote = document.createElement('div');
  checkNote.className = 'hint';
  const listWrap = document.createElement('div');
  body.append(listHead, checkNote, listWrap);

  const singular = mods ? 'mod' : 'plugin';
  const plural = mods ? 'mods' : 'plugins';
  // After an install: the list below and its count, and nothing above it.
  const refreshInstalled = async () => {
    try {
      const fresh = await api(base);
      if (body.dataset.for !== row.name) return;
      data.plugins = fresh.plugins;
      listTitle.textContent = 'Installed (' + data.plugins.length + ')';
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
    check.disabled = true;
    checkNote.textContent = 'Asking ' + sources.replace(' or ', ' and ') + ' about everything SpawnLoft installed…';
    try {
      const out = await post(base + '/updates');
      pluginView.updates = {};
      for (const u of out.updates) pluginView.updates[u.file] = u;
      saveUpdates(row.name, pluginView.updates);
      renderDockBadge();
      checkNote.textContent = updateCheckWords(out, mods ? 'mod' : 'plugin');
      paint();
    } catch (e) {
      checkNote.textContent = '';
      toast(e.message, 'bad');
    } finally {
      check.disabled = false;
    }
  };

  /**
   * Every known update in one go. One snapshot of the folder first, then each in turn, then - on a
   * running server - the restart that loads them, so "update everything" is one decision rather
   * than one per plugin and a restart remembered afterwards.
   */
  const updateAll = async (known, button, progress) => {
    const restart = data.running;
    const what = known.length === 1 ? '1 ' + singular : known.length + ' ' + plural;
    const ok = await ask({
      title: (restart ? 'Update ' + what + ' and restart?' : 'Update ' + what + '?'),
      text: 'A backup of the ' + data.kind + ' folder is taken first, then each is updated in turn'
        + (restart
          ? ', and ' + (row.label || row.name) + ' restarts to load them. Anyone online is disconnected for the restart.'
          : '. They load the next time the server starts.'),
      confirmLabel: restart ? 'Update and restart' : 'Update all',
    });
    if (!ok) return;
    button.disabled = true;
    check.disabled = true;
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
      button.disabled = false;
      check.disabled = false;
      return;
    }
    jobs.close();
    for (const u of out.updated) forget(u.file);
    for (const f of out.failed) toast(nameOf(f.file) + ' was not updated: ' + f.error, 'bad');
    if (out.updated.length) {
      toast('Updated ' + (out.updated.length === 1 ? '1 ' + singular : out.updated.length + ' ' + plural)
        + '. A backup of the ' + data.kind + ' folder was taken first.', 'good');
    }
    if (restart && out.updated.length && state.current === row.name) {
      progress.textContent = 'Restarting ' + (row.label || row.name) + '…';
      await act('restart', { sure: true })();
    }
    await again();
  };

  const paintCallout = () => {
    callout.textContent = '';
    const known = knownUpdates();
    callout.hidden = !known.length;
    if (!known.length) return;
    const text = document.createElement('div');
    text.className = 'callout-text';
    const b = document.createElement('b');
    b.textContent = known.length + (known.length === 1 ? ' update ready' : ' updates ready');
    const list = document.createElement('span');
    list.textContent = known.map((u) => nameOf(u.file)).join(', ');
    text.append(b, list);
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'primary';
    run.textContent = data.running ? 'Update and restart' : 'Update all';
    const progress = document.createElement('div');
    progress.className = 'hint callout-progress';
    progress.setAttribute('aria-live', 'polite');
    callout.append(text, run, progress);
    run.onclick = () => updateAll(known, run, progress);
  };

  const paint = () => {
    paintCallout();
    listWrap.textContent = '';
    if (!data.plugins.length) {
      listWrap.append(emptyState('plug', 'No ' + data.kind + ' yet. Search ' + sources + ' above and they land in this server’s '
        + data.kind + ' folder.', { icon: 'search', label: 'Find ' + data.kind, onClick: () => q.focus() }));
      return;
    }
    const list = document.createElement('div');
    list.className = 'plist';
    for (const p of data.plugins) list.append(pluginRow(p));
    listWrap.append(list);
  };

  /** Two capitals from the name where it has them - "WE", "LP" - or its first letter. */
  function monogram(name) {
    const caps = String(name).match(/[A-Z]/g) || [];
    if (caps.length >= 2) return caps[0] + caps[1];
    const first = String(name).replace(/[^A-Za-z0-9]/g, '').slice(0, 1);
    return first ? first.toUpperCase() : '?';
  }

  function pluginRow(p) {
    const el = document.createElement('div');
    el.className = 'plug';
    if (!p.enabled) el.setAttribute('data-off', '');
    // The rest of what is known about it, a pointer away rather than a second line on every row.
    const facts = [];
    if (p.description) facts.push(p.description);
    facts.push(p.file + '  ·  ' + (p.size / 1024 / 1024).toFixed(1) + ' MB');
    if (p.authors.length) facts.push('by ' + p.authors.join(', '));
    el.title = facts.join('\n');

    const tile = document.createElement('span');
    tile.className = 'plug-tile';
    tile.setAttribute('aria-hidden', 'true');
    tile.textContent = monogram(p.name);

    const main = document.createElement('div');
    main.className = 'plug-main';
    const nm = document.createElement('div');
    nm.className = 'plug-name';
    nm.textContent = p.name;
    const src = document.createElement('div');
    src.className = 'plug-src';
    const from = !p.managed ? 'Added by hand'
      : p.source === 'hangar' ? 'Hangar' : p.source === 'modpack' ? 'Modpack' : 'Modrinth';
    src.append(document.createTextNode(from));
    // The jar's own name, in mono, wherever the name above is not already it - so
    // "EssentialsX-2.20.1" is not read as a plugin called that.
    if (p.name !== p.file.replace(/\.jar(\.disabled)?$/, '')) {
      const file = document.createElement('code');
      file.textContent = p.file;
      src.append(document.createTextNode(' · '), file);
    }
    // Said on the row for as long as it is true, where it used to be a toast that left.
    const builtFor = builtForWords(p.gameVersions, data.gameVersion);
    if (builtFor) {
      const built = document.createElement('span');
      built.className = 'plug-built';
      built.textContent = builtFor.text;
      built.title = builtFor.title;
      src.append(document.createTextNode(' · '), built);
    }
    main.append(nm, src);

    const ver = document.createElement('span');
    ver.className = 'plug-ver';
    ver.textContent = p.version || '—';
    if (!p.version) ver.title = 'The jar does not say which version it is';

    // On or off as a word with a dot, not only a dimmed row.
    const on = document.createElement('span');
    on.className = 'plug-state';
    on.dataset.on = String(p.enabled);
    on.textContent = p.enabled ? 'Enabled' : 'Disabled';

    const acts = document.createElement('div');
    acts.className = 'plug-acts';
    el.append(tile, main, ver, on, acts);

    const update = p.managed && pluginView.updates && pluginView.updates[p.file];
    const upBtn = update ? document.createElement('button') : null;
    if (upBtn) {
      upBtn.type = 'button';
      upBtn.className = 'primary';
      upBtn.textContent = '→ ' + update.latestVersion;
      upBtn.setAttribute('aria-label', 'Update ' + p.name + ' to ' + update.latestVersion);
      acts.append(upBtn);
    }
    const quiet = document.createElement('span');
    quiet.className = 'row-acts';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ghost';
    toggle.textContent = p.enabled ? 'Disable' : 'Enable';
    toggle.setAttribute('aria-label', (p.enabled ? 'Disable ' : 'Enable ') + p.name);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'icon-btn';
    drop.append(icon('trash'));
    drop.setAttribute('aria-label', 'Delete ' + p.name);
    drop.title = 'Delete';
    quiet.append(toggle, drop);
    acts.append(quiet);

    const busy = (on) => { for (const b of acts.querySelectorAll('button')) b.disabled = on; };

    if (upBtn) {
      upBtn.onclick = async () => {
        busy(true);
        upBtn.textContent = 'Updating…';
        try {
          const out = await post(base + '/update', { file: p.file });
          forget(p.file);
          toast(out.alreadyLatest
            ? p.name + ' is already the newest build.'
            : 'Updated ' + p.name + ' to ' + out.version + '. A backup of the plugins was taken first.', 'good');
          if (out.versionNote) toast(out.versionNote);
          await again();
        } catch (e) {
          toast(e.message, 'bad');
          busy(false);
          upBtn.textContent = '→ ' + update.latestVersion;
        }
      };
    }

    toggle.onclick = async () => {
      busy(true);
      try {
        await post(base + '/toggle', { file: p.file, enabled: !p.enabled });
        toast(p.name + (p.enabled ? ' disabled.' : ' enabled.') + ' Takes effect on the next start.', 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false);
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
      busy(true);
      try {
        await post(base + '/delete', { file: p.file });
        forget(p.file);
        toast('Deleted ' + p.file + '.', 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false);
      }
    };
    return el;
  }

  paint();
}

