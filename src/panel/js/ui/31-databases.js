'use strict';
// ------------------------------------------------------------ databases ----

async function manageDatabase(row) {
  // A database that runs elsewhere has one thing to manage, so it is asked directly.
  if (row.external) return forgetDatabase(row);
  const live = row.status === 'running';
  const res = await ask({
    title: 'Manage ' + row.name,
    text: live
      ? 'This database is running. Stop it first to delete it. Servers attach to it from their own Settings tab.'
      : 'Choose what to do with this database.',
    confirmLabel: 'Continue',
    choices: live
      ? [{ value: 'folder', label: 'Open its folder', hint: 'Shows the data folder in ' + FILE_MANAGER + '.' }]
      : [
          { value: 'folder', label: 'Open its folder', hint: 'Shows the data folder in ' + FILE_MANAGER + '.' },
          { value: 'delete', label: 'Delete this database', hint: 'Removes it from SpawnLoft, and optionally its data.' },
        ],
  });
  if (!res) return;
  if (res.choice === 'folder') return openFolder(row.name);
  if (res.choice === 'delete') return deleteDatabase(row);
}

/** What the dialog and the toast say when an external database is forgotten. Nothing is deleted. */
function forgetWords(name, attached) {
  return {
    title: 'Forget ' + name + '?',
    text: 'It keeps running where it is, with everything in it. SpawnLoft only forgets its address and sign-in.'
      + (attached.length ? ' Attached: ' + attached.join(', ') + '. Their plugin settings will still name this database.' : ''),
    done: 'Forgot ' + name + '. It is still running where it was, and nothing in it was touched.',
  };
}

async function forgetDatabase(row) {
  const words = forgetWords(row.label || row.name, Object.keys(row.attachments || {}));
  const ok = await ask({ title: words.title, text: words.text, confirmLabel: 'Forget it' });
  if (!ok) return;
  try {
    await post('/databases/' + encodeURIComponent(row.name) + '/delete', { purge: false });
    stopStream();
    state.current = null;
    clearLines();
    show('empty');
    await refresh();
    toast(words.done, 'good');
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function deleteDatabase(row) {
  if (row.external) return forgetDatabase(row);
  const attached = Object.keys(row.attachments || {});
  const res = await ask({
    title: 'Delete ' + row.name + '?',
    text: attached.length ? 'Attached: ' + attached.join(', ') + '. Their plugin configs will still name this database.' : '',
    confirmLabel: 'Delete database',
    danger: true,
    typeToConfirm: row.name,
    choices: [
      { value: 'keep', label: 'Remove from SpawnLoft, keep the data', hint: 'The folder stays where it is.' },
      { value: 'purge', label: 'Delete the data as well', hint: 'Every database and table on it goes. Back it up first if you may want it again.' },
    ],
  });
  if (!res) return;
  const note = toast('Deleting ' + row.name + '…');
  try {
    const out = await post('/databases/' + encodeURIComponent(row.name) + '/delete', { purge: res.choice === 'purge' });
    note.remove();
    stopStream();
    state.current = null;
    clearLines();
    show('empty');
    await refresh();
    toast(out.purged ? 'Deleted, data and all.' : 'Removed from SpawnLoft. The data is still in its folder.', 'good');
  } catch (e) {
    note.remove();
    toast(e.message, 'bad');
  }
}

/** A <dl> of connection details, monospace, for a dialog or a card. */
function credsList(c, { root } = {}) {
  const dl = document.createElement('dl');
  // `creds` is the hook the smoke tests find it by
  dl.className = 'creds m-0 grid gap-1 font-mono text-2 [&>div]:grid [&>div]:grid-cols-[90px_minmax(0,1fr)] [&>div]:gap-2.5 [&_dt]:text-ink-3 [&_dd]:m-0 [&_dd]:break-all [&_dd]:text-ink';
  const rows = [['Host', c.host], ['Port', String(c.port)]];
  if (!root && c.database) rows.push(['Database', c.database]);
  if (c.user) rows.push(['User', c.user]);
  rows.push(['Password', c.password]);
  if (c.jdbc) rows.push(['JDBC', c.jdbc]);
  if (c.url) rows.push(['URL', c.url]);
  if (c.keyPrefix) rows.push(['Key prefix', c.keyPrefix]);
  for (const r of rows) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = r[0];
    const dd = document.createElement('dd');
    dd.textContent = r[1];
    div.append(dt, dd);
    dl.append(div);
  }
  return dl;
}

function credsText(c, { root } = {}) {
  const lines = ['host: ' + c.host, 'port: ' + c.port];
  if (!root && c.database) lines.push('database: ' + c.database);
  if (c.user) lines.push('user: ' + c.user);
  lines.push('password: ' + c.password);
  if (c.jdbc) lines.push('jdbc: ' + c.jdbc);
  if (c.url) lines.push('url: ' + c.url);
  return lines.join('\n');
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ' + what + '.', 'good');
    return true;
  } catch {
    toast('The clipboard refused; select and copy by hand.', 'bad');
    return false;
  }
}

/** Fetch one set of credentials and show them, with a Copy button. Never cached on the page. */
async function showCredentials(dbName, serverName) {
  let c;
  try {
    c = await api('/databases/' + encodeURIComponent(dbName) + '/credentials?server=' + encodeURIComponent(serverName));
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  const dlg = $('#dlg');
  clearDlgDetail();
  $('#dlgTitle').textContent = serverName + ' on ' + dbName;
  $('#dlgText').hidden = false;
  $('#dlgText').textContent = c.kind === 'redis'
    ? 'What a plugin config wants. ' + (c.note || '')
    : 'What a plugin config wants. Paste it into the plugin\'s storage section; the user can reach this one database and nothing else.';
  $('#dlgChoice').hidden = true;
  $('#dlgTypeWrap').hidden = true;
  const list = credsList(c);
  $('#dlgBody').append(list);
  const ok = $('#dlgOk');
  ok.textContent = 'Copy';
  ok.className = 'primary';
  ok.disabled = false;
  $('#dlgCancel').hidden = false;
  $('#dlgCancel').textContent = 'Close';

  // The same settle-once wiring as the edit dialog: 'cancel' is what Escape fires, 'close' is
  // the net, and a stale close from the dialog this one replaced is told apart by askSeq.
  const mine = ++askSeq;
  const copied = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      ok.onclick = null;
      $('#dlgCancel').onclick = null;
      $('#dlgCancel').textContent = 'Cancel';
      if (dlg.open) dlg.close();
      list.remove();
      resolve(v);
    };
    const onCancel = () => { if (mine === askSeq) done(false); };
    const onClose = () => { if (mine === askSeq && !dlg.open) done(false); };
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    ok.onclick = () => done(true);
    $('#dlgCancel').onclick = () => done(false);
    dlg.showModal();
    ok.focus();
  });
  if (copied) copyText(credsText(c), 'the connection details');
}

/**
 * The Databases card on a server's Settings tab: what it is attached to, with credentials one
 * click away, and a way to attach it to another.
 */
async function renderServerDatabases(row, body, into = body, reuse = null) {
  // Drawn again in the card it already has after an attach or a detach, so the rest of Settings,
  // and whatever is unsaved in it, stays as it is.
  const { h } = Kit;
  const card = reuse || h('section');
  card.textContent = '';
  const again = () => renderServerDatabases(row, body, into, card);
  card.className = 'flex flex-col gap-4';
  card.dataset.section = 'databases';
  // With the other sections, above the Save bar: it is one of them, not a footnote to them.
  const foot = into.querySelector(':scope > .pane-foot');
  card.append(h('div', { class: 'flex flex-col gap-1 border-b border-line-soft pb-2' },
    h('h3', { class: 'm-0 type-section text-ink', text: 'Databases' }),
    h('p', { class: 'sl-hint m-0', text: 'Attach a database, then use Show credentials to configure your plugins manually. SpawnLoft does not edit plugin configs.' })));
  if (!reuse) { if (foot) into.insertBefore(card, foot); else into.append(card); }

  let mine = [];
  try {
    mine = await api('/instances/' + encodeURIComponent(row.name) + '/databases');
  } catch (e) {
    card.append(h('p', { class: 'sl-error m-0', role: 'alert', text: e.message }));
  }
  if (body.dataset.for !== row.name) return;

  const rows = [];
  for (const a of mine) {
    const dbRow = state.dbs.find((d) => d.name === a.service);
    const sub = ((dbRow && dbRow.engineLabel) || a.engine) + ' ' + (a.version || '') + (a.external ? ' (elsewhere)' : '')
      + ' \u00b7 ' + (a.host || '127.0.0.1') + ':' + a.port
      + (a.database ? ' \u00b7 database ' + a.database + ' \u00b7 user ' + a.user : ' \u00b7 shared password');
    const show = Kit.button({ label: 'Show credentials', icon: 'eye', size: 'sm' });
    show.onclick = () => showCredentials(a.service, row.name);
    const detach = Kit.button({ label: 'Detach', kind: 'ghost', size: 'sm' });
    detach.setAttribute('aria-label', 'Detach from ' + (a.label || a.service));
    detach.onclick = async () => {
      const res = await ask({
        title: 'Detach ' + row.name + ' from ' + (a.label || a.service) + '?',
        text: 'The user goes away. Whether the data goes with it is up to you.',
        confirmLabel: 'Detach',
        danger: true,
        choices: [
          { value: 'keep', label: 'Keep the data', hint: 'Attaching again later gives the same database back, with a new password.' },
          { value: 'drop', label: 'Drop the database too', hint: 'Every table this server had on it goes. The database must be running for this.' },
        ],
      });
      if (!res) return;
      try {
        await post('/databases/' + encodeURIComponent(a.service) + '/detach', { server: row.name, drop: res.choice === 'drop' });
        toast('Detached.', 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
    const line = Kit.row({ lead: Kit.tile({ icon: dbRow && dbRow.engineKind === 'redis' ? 'cache' : 'database', size: 'sm' }), title: a.label || a.service, meta: sub, end: [show, detach] });
    line.querySelector('.sl-row-meta').classList.add('font-mono', 'whitespace-normal');
    rows.push(line);
  }
  if (rows.length) card.append(Kit.list(rows, 'Attached databases'));

  const attachedTo = new Set(mine.map((a) => a.service));
  const free = state.dbs.filter((d) => !attachedTo.has(d.name));

  // A database of this server's own, one click: MySQL 8.4 LTS on the port after
  // the game port, started and attached, credentials shown. The Add sheet stays for the cases with
  // choices in them - a version, an engine, a database several servers share.
  const create = Kit.button({ label: 'Create a database', icon: 'plus', kind: mine.length ? 'secondary' : 'primary' });
  const createHint = h('span', { class: 'sl-hint m-0 flex-1 basis-64', role: 'status' });
  // the button and its words share a parent: the smoke test reads why it is off from there
  const createRow = h('div', { class: 'flex flex-wrap items-center gap-3' }, create, createHint);
  createHint.textContent = (panelPlatform === 'darwin' ? 'MySQL 8.4 LTS (macOS 15+), on port ' : 'MySQL 8.4 LTS, on port ') + (Number(row.port) + 1) + ' if it is free. Started and attached for you.';
  if (!managedDatabaseFeatures) {
    create.disabled = true;
    createHint.textContent = databasePreviewNote;
  } else if (!managedMysql) {
    create.disabled = true;
    createHint.textContent = 'Managed MySQL is not available for this machine (there is no small MySQL build for Linux on arm64). Add a server, then A database, offers Redis here, or connect to a MySQL you already run.';
  }
  create.onclick = async () => {
    Kit.busy(create, true);
    const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
    const jobs = new EventSource('/api/jobs/' + jobId + '/stream');
    jobs.onmessage = (ev) => {
      let job;
      try { job = JSON.parse(ev.data); } catch { return; }
      if (job.message) createHint.textContent = job.message + (typeof job.percent === 'number' && job.stage === 'download' ? ' ' + job.percent + '%' : '') + '\u2026';
    };
    try {
      const out = await post('/instances/' + encodeURIComponent(row.name) + '/databases/create', { jobId: jobId });
      jobs.close();
      toast('Created ' + out.database.name + ' on port ' + out.database.port + ' and attached ' + row.name + '.', 'good');
      await refresh();
      await again();
      showCredentials(out.database.name, row.name);
    } catch (e) {
      jobs.close();
      Kit.busy(create, false);
      createHint.textContent = e.message;
      toast(e.message, 'bad');
    }
  };
  card.append(createRow);

  const attachRow = h('div', { class: 'flex flex-wrap items-center gap-3' });
  if (!state.dbs.length) {
    const add = Kit.button({ label: 'Add a database\u2026', kind: 'ghost', size: 'sm', onClick: () => openAdd('db') });
    attachRow.append(h('span', { class: 'sl-hint m-0', text: 'Or add one with choices in it:' }), add);
  } else if (free.length) {
    const pick = Kit.select({
      label: 'Database to attach',
      options: free.map((d) => ({
        value: d.name,
        label: (d.label || d.name) + ' \u2014 ' + (d.engineLabel || d.engine) + ' ' + (d.version || '')
          + (d.external ? ' at ' + d.host + ':' + d.port : '')
          + (d.status === 'running' || d.status === 'reachable' ? '' : d.status === 'unreachable' ? ' (unreachable)' : ' (stopped)'),
      })),
    });
    pick.classList.add('w-80', 'max-w-full');
    const sel = pick.querySelector('select');
    const go = Kit.button({ label: 'Attach', kind: 'primary' });
    go.onclick = async () => {
      const target = sel.value;
      Kit.busy(go, true);
      try {
        await post('/databases/' + encodeURIComponent(target) + '/attach', { server: row.name });
        toast('Attached ' + row.name + ' to ' + target + '.', 'good');
        await refresh();
        await again();
        showCredentials(target, row.name);
      } catch (e) {
        Kit.busy(go, false);
        toast(e.message, 'bad');
      }
    };
    attachRow.append(pick, go, h('span', { class: 'sl-hint m-0', text: 'The database has to be running to attach.' }));
  } else if (mine.length) {
    attachRow.append(h('span', { class: 'sl-hint m-0', text: 'Attached to every database here.' }));
  }
  if (attachRow.childElementCount) card.append(attachRow);
}

/** Which Backups a row gets: a server's snapshots, or a database's own dumps. */
function renderBackupsTool(opts) {
  return isDb(rowOf(state.current)) ? renderDatabaseBackups(opts) : renderBackups(opts);
}

/*
  A database's own backups, the way a forum's admin panel keeps them: SQL dumps in a list, each one
  downloaded, put back or deleted from its row. A server's snapshot already carries a dump of the
  databases it uses - this is for the database itself, kept whether or not any one server is being
  backed up, and a download away from living somewhere other than this machine.
*/
let dbBackupPending = null;
let dbBackupBusy = false;

async function renderDatabaseBackups(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#backupsBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  // A poll must not redraw under a dump or a restore in progress, or pile up behind a slow one.
  if (!force && (dbBackupBusy || dbBackupPending === row.name)) return;
  dbBackupPending = row.name;
  if (body.dataset.for !== row.name) paneLoading(body);
  const base = '/databases/' + encodeURIComponent(row.name) + '/backups';
  let data;
  try {
    data = await api(base);
  } catch (e) {
    if (state.current !== row.name) return;
    paneError(body, e.message, () => renderDatabaseBackups({ force: true }));
    body.dataset.for = '';
    return;
  } finally {
    if (dbBackupPending === row.name) dbBackupPending = null;
  }
  if (state.current !== row.name) return;
  // Redrawn only when something changed: the label someone is typing survives the poll.
  const signature = JSON.stringify([data.backups, data.running, data.databases, data.canDump]);
  if (!force && body.dataset.for === row.name && body.dataset.signature === signature) return;
  body.dataset.for = row.name;
  body.dataset.signature = signature;

  const { h } = Kit;
  const label = row.label || row.name;
  body.textContent = '';
  paneHead(body, 'archive', 'Backups',
    'Backups of this database, kept apart from the servers’ backups. Download one to keep a copy somewhere else.');
  const page = h('div', { class: 'flex flex-col gap-6' });
  body.append(page);

  if (!data.canDump) {
    page.append(Kit.empty({
      icon: 'archive',
      title: 'Nothing here to back up',
      text: (row.engineLabel || 'This engine') + ' keeps its own checkpoints on disk, and a server’s backup does not take them either. '
        + 'To keep a copy, stop it and copy its data folder somewhere else.',
    }));
    return;
  }

  // ---- take one now ---------------------------------------------------------
  const n = data.databases.length;
  const tag = Kit.input({ placeholder: 'before the LuckPerms update' });
  tag.maxLength = 40;
  const tagField = Kit.field({ label: 'Note (optional)', control: tag });
  const take = Kit.button({ label: 'Back up now', icon: 'archive', kind: 'primary' });
  take.disabled = !data.running || !n;
  const why = !n
    ? 'No server uses this database yet, so there is nothing of yours in it to back up.'
    : !data.running
    ? 'Start the database first: a backup is read from the running database.'
    : 'Takes ' + data.databases.join(', ') + ', the database' + (n === 1 ? '' : 's') + ' your servers keep here, into one file.';
  page.append(Kit.card({ label: 'Back up now' },
    h('div', { class: 'flex flex-wrap items-end gap-4' },
      h('div', { class: 'flex-1 basis-72 min-w-0 flex flex-col gap-1' },
        h('h2', { class: 'm-0 type-card text-ink', text: 'Back up now' }),
        h('p', { class: 'sl-hint m-0', text: why })),
      h('div', { class: 'w-72 max-w-full' }, tagField),
      take)));

  take.onclick = async () => {
    dbBackupBusy = true;
    Kit.busy(take, true);
    try {
      const out = await post(base, { label: tag.value.trim() || 'manual' });
      toast('Backed up ' + label + ' (' + out.taken.sizeHuman + ').', 'good');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      dbBackupBusy = false;
      await renderDatabaseBackups({ force: true });
    }
  };

  // ---- what is kept ---------------------------------------------------------
  const hist = h('section', { class: 'flex flex-col gap-3', 'aria-label': 'History' },
    h('div', { class: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
      h('h2', { class: 'm-0 type-section text-ink', text: 'History' }),
      h('span', { class: 'type-meta text-ink-3', text: data.backups.length ? String(data.backups.length) : '' })),
    h('p', { class: 'sl-hint m-0' }, 'Kept in ', h('span', { class: 'font-mono text-1 break-all', text: data.dir })));
  page.append(hist);
  if (!data.backups.length) {
    hist.append(Kit.empty({ icon: 'archive', title: 'No backups yet', text: 'Back up now, before a plugin update or a move to a new version, and there is a way back.' }));
    return;
  }

  const rows = data.backups.map((b) => {
    const when = stamp(new Date(b.mtime).toISOString());
    const which = 'the backup from ' + when;
    const restore = Kit.button({ label: 'Restore', icon: 'restore', size: 'sm' });
    restore.setAttribute('aria-label', 'Restore ' + which);
    restore.disabled = !data.running;
    restore.title = data.running ? '' : 'Start the database to put a backup back into it';
    const note = b.label && !['manual', 'pre-restore'].includes(b.label) ? b.label : null;
    const lines = [
      note ? h('span', { class: 'type-body text-ink font-strong whitespace-normal', text: '“' + note.replace(/-/g, ' ') + '”' }) : null,
      h('span', { class: 'sl-row-meta whitespace-normal' },
        [ago(new Date(b.mtime).toISOString()), snapshotReason(b), b.databases.length ? b.databases.join(', ') : null].filter(Boolean).join(' · '),
        h('span', { class: 'block font-mono text-1 text-ink-4 truncate', text: b.name })),
    ];

    restore.onclick = async () => {
      const running = attachedRunning(row);
      const ok = await ask({
        title: 'Restore ' + label + ' from ' + when + '?',
        text: 'What it holds replaces what is there now, and anything written since ' + when + ' is lost from it. '
          + 'A backup of how things are now is taken first, so this can be undone from this list.'
          + (running.length ? ' ' + running.join(', ') + (running.length === 1 ? ' is' : ' are') + ' running and may be writing to it: stop ' + (running.length === 1 ? 'it' : 'them') + ' first.' : ''),
        confirmLabel: 'Restore',
        danger: true,
        typeToConfirm: row.name,
      });
      if (!ok) return;
      dbBackupBusy = true;
      const busyNote = toast('Restoring ' + which + '…');
      restoring.set(row.name, b.name);
      lockRestoring(body, row.name);
      try {
        const out = await post(base + '/restore', { file: b.name });
        busyNote.remove();
        toast('Restored ' + which + '.' + (out.safety ? ' How it was before is kept in this list.' : ''), 'good');
      } catch (e) {
        busyNote.remove();
        toast(e.message, 'bad');
      } finally {
        dbBackupBusy = false;
        restoring.delete(row.name);
        if (state.current === row.name) await renderDatabaseBackups({ force: true });
      }
    };

    const drop = async () => {
      const ok = await ask({
        title: 'Delete this backup?',
        text: 'The backup from ' + when + ', ' + b.sizeHuman + '. Download it first if you want to keep a copy.',
        confirmLabel: 'Delete backup',
        danger: true,
      });
      if (!ok) return;
      try {
        await post(base + '/delete', { file: b.name });
        toast('Deleted ' + which + '.', 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
      await renderDatabaseBackups({ force: true });
    };
    return backupRow({
      snap: b, title: when, lines, kind: null, size: b.sizeHuman, restore,
      menu: [
        { label: 'Download', note: 'A .sql file.', onSelect: () => downloadFile('/api' + base + '/download?file=' + encodeURIComponent(b.name), b.name) },
        'sep',
        { label: 'Delete', tone: 'fault', onSelect: drop },
      ],
    });
  });
  hist.append(Kit.list(rows, 'Backups'));
  lockRestoring(body, row.name);
}

/** The servers attached to a database that are running now, by the name people know them by. */
function attachedRunning(db) {
  return Object.keys(db.attachments || {})
    .map((name) => rowOf(name))
    .filter((r) => r && r.status === 'running')
    .map((r) => r.label || r.name);
}

/** A database's Settings tab: how to reach it as root, and who is attached. */
async function renderDatabaseSettings(row) {
  const body = $('#settingsBody');
  if (body.dataset.for === row.name && body.childElementCount) return;
  const { h } = Kit;
  body.dataset.for = row.name;
  body.textContent = '';
  paneHead(body, 'sliders', 'Database settings',
    'Its address, the admin login, and which servers have a database on it.');

  const glyph = row.engineKind === 'redis' ? 'cache' : 'database';
  const cardHead = (title, text) => h('div', { class: 'flex flex-col gap-1' },
    h('h2', { class: 'm-0 type-card text-ink', text: title }),
    h('p', { class: 'sl-hint m-0', text }));
  const facts = h('dl', { class: 'm-0 flex flex-col' });
  const fact = (term, ...value) => {
    const dd = h('dd', { class: 'm-0 flex min-w-0 flex-wrap items-center gap-2 type-body text-ink' }, ...value);
    facts.append(h('div', { class: 'grid min-h-11 grid-cols-[110px_minmax(0,1fr)] items-center gap-3 border-b border-line-faint py-1.5 last:border-b-0' },
      h('dt', { class: 'type-meta font-strong text-ink-3', text: term }), dd));
    return dd;
  };

  // the notice that it is not answering, kept in step with each poll (paintDbReach)
  const reach = h('div', { dataset: { dbReach: '' } });
  const page = h('div', { class: 'grid grid-cols-1 items-start gap-6 @wide/pane:grid-cols-2' });
  body.append(reach, page);
  paintDbReach(row);

  // ---- how to reach it: every value a plugin config asks for, each copyable ----------------
  fact('Engine', (row.engineLabel || row.engine) + ' ' + (row.version || '') + (row.external ? ' (runs elsewhere)' : ''));
  fact('Host', addrButton(row.host || '127.0.0.1', 'host'));
  fact('Port', addrButton(String(row.port), 'port'));
  if (!row.external && row.dir) fact('Folder', h('code', { class: 'min-w-0 break-all font-mono text-2 text-ink-2', text: row.dir }));

  /*
    The admin login, masked until asked for. Fetched each time it is shown and dropped when it is
    hidden, as the per-server credentials are: a password that sits in the page is one a stray
    screenshot or screen share carries. Copy fetches it without showing it.
  */
  const who = row.engineKind === 'redis' ? 'Password' : 'Admin login';
  const masked = h('span', { class: 'font-mono tracking-widest text-ink-3', text: '•'.repeat(8), 'aria-label': 'Hidden' });
  const reveal = Kit.button({ label: 'Show', icon: 'eye', size: 'sm' });
  reveal.setAttribute('aria-expanded', 'false');
  reveal.setAttribute('aria-label', 'Show the ' + who.toLowerCase());
  const copyAll = Kit.button({ label: 'Copy', icon: 'copy', size: 'sm', kind: 'ghost' });
  copyAll.setAttribute('aria-label', 'Copy the ' + who.toLowerCase());
  const shown = h('div', { class: 'basis-full rounded-sm border border-line-soft bg-sunken px-3 py-2', hidden: true });
  fact(who, masked, reveal, copyAll, shown);
  const rootCreds = () => api('/databases/' + encodeURIComponent(row.name) + '/root');
  const say = (b, text) => { b.lastChild.textContent = text; };
  reveal.onclick = async () => {
    if (!shown.hidden) {
      shown.hidden = true;
      shown.textContent = '';
      masked.hidden = false;
      say(reveal, 'Show');
      reveal.setAttribute('aria-label', 'Show the ' + who.toLowerCase());
      reveal.setAttribute('aria-expanded', 'false');
      return;
    }
    Kit.busy(reveal, true);
    try {
      const c = await rootCreds();
      // Host and port are already on the lines above; only what was hidden is shown, each copyable.
      const creds = h('dl', { class: 'm-0 grid gap-1' });
      // the URL carries the password inside it, so it is as much a secret as the password is
      for (const [term, value, what, secret] of [['User', c.user, 'user', false], ['Password', c.password, 'password', true], ['URL', c.url, 'URL', true]]) {
        if (!value) continue;
        creds.append(h('div', { class: 'grid grid-cols-[90px_minmax(0,1fr)] items-center gap-2.5' },
          h('dt', { class: 'font-mono text-2 text-ink-3', text: term }),
          h('dd', { class: 'm-0 min-w-0 break-all' }, addrButton(String(value), what, secret))));
      }
      shown.append(creds);
      shown.hidden = false;
      masked.hidden = true;
      Kit.busy(reveal, false);
      say(reveal, 'Hide');
      reveal.setAttribute('aria-label', 'Hide the ' + who.toLowerCase());
      reveal.setAttribute('aria-expanded', 'true');
    } catch (e) {
      Kit.busy(reveal, false);
      toast(e.message, 'bad');
    }
  };
  copyAll.onclick = async () => {
    try {
      copyText(credsText(await rootCreds(), { root: true }), 'the ' + (row.engineKind === 'redis' ? 'connection details' : 'admin login'));
    } catch (e) { toast(e.message, 'bad'); }
  };
  const conn = Kit.card({ label: 'Connection' },
    h('div', { class: 'flex items-start gap-3' }, Kit.tile({ icon: glyph, size: 'sm' }),
      cardHead('Connection', row.external
        ? 'SpawnLoft knows its address and admin login; it is started and stopped where it runs. Servers are attached to it from their own Settings tab.'
        : row.engineKind === 'redis'
          ? 'Only this computer can connect to it. Every attached server shares the one password and the one store, so each plugin puts its own prefix on what it keeps.'
          : 'Only this computer can connect to it. Each server gets its own login and its own database; the admin login below is for you.')),
    facts);
  if (row.external) conn.append(dbAddressEditor(row, facts));
  page.append(conn);

  // ---- who uses it: each attached server, a link to it, and its own login ------------------
  const names = Object.keys(row.attachments || {});
  const rows = names.map((name) => {
    const a = row.attachments[name];
    const server = rowOf(name);
    const show = Kit.button({ label: 'Show credentials', icon: 'eye', size: 'sm' });
    show.setAttribute('aria-label', 'Show credentials for ' + (server ? (server.label || name) : name));
    show.onclick = () => showCredentials(row.name, name);
    const open = server
      ? Kit.button({ label: 'Open', size: 'sm', kind: 'ghost', onClick: () => select(name) })
      : null;
    if (open) open.setAttribute('aria-label', 'Open ' + (server.label || name));
    const line = Kit.row({
      lead: server ? Kit.tile({ name: server.label || name, key: name, size: 'sm' }) : Kit.tile({ icon: 'server', size: 'sm' }),
      title: server ? (server.label || name) : name + ' (removed)',
      meta: a.database ? 'database ' + a.database + ' · user ' + a.user : 'key prefix ' + name + ':',
      end: [show, open],
    });
    line.querySelector('.sl-row-meta').classList.add('font-mono');
    return line;
  });
  const att = Kit.card({ label: 'Attached servers' },
    cardHead('Attached servers', 'Each has a database and a user named after it. Attach a server from its own Settings tab.'),
    rows.length
      ? Kit.list(rows, 'Attached servers')
      : Kit.empty({ icon: 'server', title: 'No server uses it yet', text: 'Attach one from that server’s Settings, under Databases.' }));
  page.append(att);
}
