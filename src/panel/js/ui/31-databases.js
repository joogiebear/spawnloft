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
  dl.className = 'creds';
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
  const card = reuse || document.createElement('div');
  card.textContent = '';
  const again = () => renderServerDatabases(row, body, into, card);
  card.className = 'section set-group';
  card.dataset.section = 'databases';
  // With the other sections, above the Save bar: it is one of them, not a footnote to them.
  const foot = into.querySelector(':scope > .pane-foot');
  const head = document.createElement('div');
  head.className = 'set-head';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.append(icon('server'));
  const h = document.createElement('h3');
  h.textContent = 'Databases';
  const blurb = document.createElement('p');
  blurb.textContent = 'Attach a database, then use Show credentials to configure your plugins manually. SpawnLoft does not edit plugin configs.';
  head.append(mark, h, blurb);
  card.append(head);
  if (!reuse) { if (foot) into.insertBefore(card, foot); else into.append(card); }

  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '10px';
  card.append(list);

  let mine = [];
  try {
    mine = await api('/instances/' + encodeURIComponent(row.name) + '/databases');
  } catch (e) {
    const bad = document.createElement('div');
    bad.className = 'bad';
    bad.textContent = e.message;
    list.append(bad);
  }
  if (body.dataset.for !== row.name) return;

  for (const a of mine) {
    const line = document.createElement('div');
    line.className = 'row';
    line.style.alignItems = 'center';
    const text = document.createElement('div');
    text.style.flex = '1';
    const b = document.createElement('b');
    b.textContent = a.label || a.service;
    const sub = document.createElement('div');
    sub.className = 'hint';
    sub.style.margin = '0';
    const dbRow = state.dbs.find((d) => d.name === a.service);
    sub.textContent = ((dbRow && dbRow.engineLabel) || a.engine) + ' ' + (a.version || '') + (a.external ? ' (elsewhere)' : '')
      + ' \u00b7 ' + (a.host || '127.0.0.1') + ':' + a.port
      + (a.database ? ' \u00b7 database ' + a.database + ' \u00b7 user ' + a.user : ' \u00b7 shared password');
    text.append(b, sub);
    const show = document.createElement('button');
    show.textContent = 'Show credentials';
    show.onclick = () => showCredentials(a.service, row.name);
    const detach = document.createElement('button');
    detach.className = 'ghost';
    detach.textContent = 'Detach';
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
    line.append(text, show, detach);
    list.append(line);
  }

  const attachedTo = new Set(mine.map((a) => a.service));
  const free = state.dbs.filter((d) => !attachedTo.has(d.name));

  // A database of this server's own, one click: MySQL 8.4 LTS on the port after
  // the game port, started and attached, credentials shown. The Add sheet stays for the cases with
  // choices in them - a version, an engine, a database several servers share.
  const createRow = document.createElement('div');
  createRow.className = 'row';
  createRow.style.alignItems = 'center';
  const create = document.createElement('button');
  create.className = mine.length ? 'ghost' : 'primary';
  create.textContent = 'Create a database';
  const createHint = document.createElement('span');
  createHint.className = 'hint';
  createHint.textContent = (panelPlatform === 'darwin' ? 'MySQL 8.4 LTS (macOS 15+), on port ' : 'MySQL 8.4 LTS, on port ') + (Number(row.port) + 1) + ' if it is free. Started and attached for you.';
  if (!managedDatabaseFeatures) {
    create.disabled = true;
    createHint.textContent = databasePreviewNote;
  } else if (!managedMysql) {
    create.disabled = true;
    createHint.textContent = 'Managed MySQL is not available for this machine (there is no small MySQL build for Linux on arm64). Add a server, then A database, offers Redis here, or connect to a MySQL you already run.';
  }
  create.onclick = async () => {
    create.disabled = true;
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
      create.disabled = false;
      createHint.textContent = e.message;
      toast(e.message, 'bad');
    }
  };
  createRow.append(create, createHint);
  list.append(createRow);

  const attachRow = document.createElement('div');
  attachRow.className = 'row';
  attachRow.style.alignItems = 'center';
  if (!state.dbs.length) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Or add one with choices in it: ';
    const add = document.createElement('button');
    add.className = 'ghost';
    add.textContent = 'Add a database\u2026';
    add.onclick = () => openAdd('db');
    attachRow.append(hint, add);
  } else if (free.length) {
    const sel = document.createElement('select');
    for (const d of free) {
      const o = document.createElement('option');
      o.value = d.name;
      o.textContent = (d.label || d.name) + ' \u2014 ' + (d.engineLabel || d.engine) + ' ' + (d.version || '')
        + (d.external ? ' at ' + d.host + ':' + d.port : '')
        + (d.status === 'running' || d.status === 'reachable' ? '' : d.status === 'unreachable' ? ' (unreachable)' : ' (stopped)');
      sel.append(o);
    }
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Attach';
    go.onclick = async () => {
      const target = sel.value;
      go.disabled = true;
      try {
        await post('/databases/' + encodeURIComponent(target) + '/attach', { server: row.name });
        toast('Attached ' + row.name + ' to ' + target + '.', 'good');
        await refresh();
        await again();
        showCredentials(target, row.name);
      } catch (e) {
        go.disabled = false;
        toast(e.message, 'bad');
      }
    };
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'The database has to be running to attach.';
    attachRow.append(sel, go, hint);
  } else if (mine.length) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'Attached to every database here.';
    attachRow.append(hint);
  }
  list.append(attachRow);
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

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const label = row.label || row.name;
  body.textContent = '';
  paneHead(body, 'archive', 'Backups',
    'Backups of this database, kept apart from the servers’ backups. Download one to keep a copy somewhere else.');

  if (!data.canDump) {
    body.append(emptyState('archive', (row.engineLabel || 'This engine') + ' keeps its own checkpoints on disk, so there is '
      + 'nothing here to dump. Back up the servers that use it instead.'));
    return;
  }

  // ---- take one now ---------------------------------------------------------
  const now = el('div', 'section');
  now.append(el('h3', null, 'Back up now'));
  const n = data.databases.length;
  now.append(el('p', 'hint', n
    ? 'Dumps ' + data.databases.join(', ') + ' — the database' + (n === 1 ? '' : 's') + ' your servers use here — into one .sql file.'
    : 'No server is attached to this database yet, so there is nothing of yours in it to dump.'));
  if (!data.running) now.append(el('p', 'hint', 'Start the database first: a dump is read from the running database.'));
  const takeRow = el('div', 'row');
  const tag = el('input');
  tag.placeholder = 'Label (optional)';
  tag.setAttribute('aria-label', 'Label for this backup');
  tag.maxLength = 40;
  tag.style.maxWidth = '240px';
  const take = el('button', 'primary', 'Back up now');
  take.type = 'button';
  take.disabled = !data.running || !n;
  takeRow.append(tag, take);
  now.append(takeRow);
  body.append(now);

  take.onclick = async () => {
    dbBackupBusy = true;
    take.disabled = true;
    take.textContent = 'Backing up…';
    try {
      const out = await post(base, { label: tag.value.trim() || 'manual' });
      toast('Backed up ' + label + ' to ' + out.taken.name + ' (' + out.taken.sizeHuman + ').', 'good');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      dbBackupBusy = false;
      await renderDatabaseBackups({ force: true });
    }
  };

  // ---- what is kept ---------------------------------------------------------
  const listTitle = el('h3', 'hist-title', 'Backups (' + data.backups.length + ')');
  const where = el('div', 'hint mono-path', 'Kept in ' + data.dir);
  body.append(listTitle, where);
  if (!data.backups.length) {
    body.append(emptyState('archive', 'No backups of this database yet. Back up now, before a plugin update or a migration, '
      + 'and there is a way back.'));
    return;
  }

  const list = el('div', 'snaps');
  const head = el('div', 'snaps-head');
  head.append(el('span', null, 'Backup'), el('span', null, 'Label'), el('span', 'h-why', 'Reason'), el('span', 'h-items', 'Databases'), el('span', null, 'Size'));
  list.append(head);
  for (const b of data.backups) {
    const line = el('div', 'snap');
    line.dataset.backupName = b.name;
    line.append(
      el('span', 'when', stamp(new Date(b.mtime).toISOString())),
      el('span', 'what', b.databases.length ? b.databases.join(', ') : b.name),
      el('span', 'tag', b.label || 'manual'),
      el('span', 'why', snapshotReason(b)),
      el('span', 'items', b.databases.length + (b.databases.length === 1 ? ' database' : ' databases')),
      el('span', 'size', b.sizeHuman),
    );
    line.querySelector('.what').title = b.name;
    const acts = el('span', 'snap-actions');
    const download = el('button', null, 'Download');
    download.type = 'button';
    download.setAttribute('aria-label', 'Download ' + b.name);
    const restore = el('button', null, 'Restore');
    restore.type = 'button';
    restore.disabled = !data.running;
    restore.title = data.running ? '' : 'Start the database to put a backup back into it';
    const drop = el('button', 'icon-btn');
    drop.type = 'button';
    drop.append(icon('trash'));
    drop.setAttribute('aria-label', 'Delete ' + b.name);
    drop.title = 'Delete';
    acts.append(download, restore, drop);
    line.append(acts);
    list.append(line);

    // A plain link to the file, clicked for the person: the browser, or the desktop app's own save
    // dialog, takes it from there.
    download.onclick = () => {
      const a = document.createElement('a');
      a.href = '/api' + base + '/download?file=' + encodeURIComponent(b.name);
      a.download = b.name;
      document.body.append(a);
      a.click();
      a.remove();
    };

    restore.onclick = async () => {
      const ok = await ask({
        title: 'Put ' + label + ' back as it was?',
        text: 'The tables in ' + b.name + ' replace the ones there now, and anything written since it was taken is '
          + 'lost from them. A backup of how things are now is taken first, so this can be undone from this list. '
          + 'Stop the servers that use it first if they are writing to it.',
        confirmLabel: 'Restore',
        danger: true,
        typeToConfirm: row.name,
      });
      if (!ok) return;
      dbBackupBusy = true;
      const note = toast('Putting back ' + b.name + '…');
      restoring.set(row.name, b.name);
      lockRestoring(body, row.name);
      try {
        const out = await post(base + '/restore', { file: b.name });
        note.remove();
        toast('Put back ' + out.restored + '.' + (out.safety ? ' How it was before is saved as ' + out.safety + '.' : ''), 'good');
      } catch (e) {
        note.remove();
        toast(e.message, 'bad');
      } finally {
        dbBackupBusy = false;
        restoring.delete(row.name);
        if (state.current === row.name) await renderDatabaseBackups({ force: true });
      }
    };

    drop.onclick = async () => {
      const ok = await ask({
        title: 'Delete this backup?',
        text: b.name + ', ' + b.sizeHuman + '. Download it first if you want to keep a copy.',
        confirmLabel: 'Delete backup',
        danger: true,
      });
      if (!ok) return;
      try {
        await post(base + '/delete', { file: b.name });
        toast('Deleted ' + b.name + '.', 'good');
      } catch (e) {
        toast(e.message, 'bad');
      }
      await renderDatabaseBackups({ force: true });
    };
  }
  body.append(list);
  lockRestoring(body, row.name);
}

/** A database's Settings tab: how to reach it as root, and who is attached. */
async function renderDatabaseSettings(row) {
  const body = $('#settingsBody');
  if (body.dataset.for === row.name && body.childElementCount) return;
  body.dataset.for = row.name;
  body.textContent = '';
  paneHead(body, 'sliders', 'Database settings',
    'Its address, the admin login, and which servers have a database on it.');

  const glyph = row.engineKind === 'redis' ? 'cache' : 'database';
  const groupHead = (mark, title, text) => {
    const head = el('div', 'set-head');
    const m = el('span', 'mark');
    m.append(icon(mark));
    const h = el('h3');
    h.textContent = title;
    const p = el('p');
    p.textContent = text;
    head.append(m, h, p);
    return head;
  };
  const fact = (dl, term, ...value) => {
    const div = el('div');
    const dt = el('dt');
    dt.textContent = term;
    const dd = el('dd');
    dd.append(...value);
    div.append(dt, dd);
    dl.append(div);
    return dd;
  };

  body.append(el('div', 'db-reach'));
  paintDbReach(row);

  // ---- how to reach it: every value a plugin config asks for, each copyable ----------------
  const conn = el('div', 'section set-group db-conn');
  conn.append(groupHead(glyph, 'Connection', row.external
    ? 'SpawnLoft knows its address and admin login; it is started and stopped where it runs. Servers are attached to it from their own Settings tab.'
    : row.engineKind === 'redis'
      ? 'Only this computer can connect to it. Every attached server shares the one password and the one store, so each plugin puts its own prefix on what it keeps.'
      : 'Only this computer can connect to it. Each server gets its own login and its own database; the admin login below is for you.'));
  const dl = el('dl', 'db-facts');
  fact(dl, 'Engine', (row.engineLabel || row.engine) + ' ' + (row.version || '') + (row.external ? ' (runs elsewhere)' : ''));
  fact(dl, 'Host', addrButton(row.host || '127.0.0.1', 'host'));
  fact(dl, 'Port', addrButton(String(row.port), 'port'));
  if (!row.external && row.dir) {
    const dir = el('code', 'mono-path');
    dir.textContent = row.dir;
    dir.title = row.dir;
    fact(dl, 'Folder', dir);
  }

  /*
    The admin login, masked until asked for. Fetched each time it is shown and dropped when it is
    hidden, as the per-server credentials are: a password that sits in the page is one a stray
    screenshot or screen share carries. Copy fetches it without showing it.
  */
  const who = row.engineKind === 'redis' ? 'Password' : 'Admin login';
  const secret = fact(dl, who);
  secret.classList.add('db-secret');
  const masked = el('span', 'db-mask');
  masked.textContent = '•'.repeat(8);
  masked.setAttribute('aria-label', 'Hidden');
  const reveal = iconButton('eye', 'Show', 'sm');
  reveal.setAttribute('aria-expanded', 'false');
  const copyAll = iconButton('copy', 'Copy', 'sm ghost');
  const shown = el('div', 'db-shown');
  shown.hidden = true;
  secret.append(masked, reveal, copyAll, shown);
  const rootCreds = () => api('/databases/' + encodeURIComponent(row.name) + '/root');
  reveal.onclick = async () => {
    if (!shown.hidden) {
      shown.hidden = true;
      shown.textContent = '';
      masked.hidden = false;
      reveal.lastChild.textContent = 'Show';
      reveal.setAttribute('aria-expanded', 'false');
      return;
    }
    busy(reveal, true);
    try {
      const c = await rootCreds();
      // Host and port are already on the lines above; only what was hidden is shown, each copyable.
      const creds = el('dl', 'creds');
      // the URL carries the password inside it, so it is as much a secret as the password is
      for (const [term, value, what, secret] of [['User', c.user, 'user', false], ['Password', c.password, 'password', true], ['URL', c.url, 'URL', true]]) {
        if (!value) continue;
        const div = el('div');
        const dt = el('dt');
        dt.textContent = term;
        const dd = el('dd');
        dd.append(addrButton(String(value), what, secret));
        div.append(dt, dd);
        creds.append(div);
      }
      shown.append(creds);
      shown.hidden = false;
      masked.hidden = true;
      busy(reveal, false);
      reveal.lastChild.textContent = 'Hide';
      reveal.setAttribute('aria-expanded', 'true');
    } catch (e) {
      busy(reveal, false);
      toast(e.message, 'bad');
    }
  };
  copyAll.onclick = async () => {
    try {
      copyText(credsText(await rootCreds(), { root: true }), 'the ' + (row.engineKind === 'redis' ? 'connection details' : 'admin login'));
    } catch (e) { toast(e.message, 'bad'); }
  };
  conn.append(dl);
  if (row.external) conn.append(dbAddressEditor(row, dl));
  body.append(conn);

  // ---- who uses it: each attached server, a link to it, and its own login ------------------
  const att = el('div', 'section set-group');
  att.append(groupHead('server', 'Attached servers',
    'Each has a database and a user named after it. Attach a server from its own Settings tab.'));
  const names = Object.keys(row.attachments || {});
  if (!names.length) {
    att.append(emptyState('server', 'No server uses this database yet. Attach one from that server’s Settings.'));
  }
  const list = el('ul', 'db-attached');
  for (const name of names) {
    const a = row.attachments[name];
    const server = rowOf(name);
    const li = el('li');
    const text = el('div', 'db-att-text');
    const go = el(server ? 'button' : 'b', server ? 'ghost inline db-att-name' : 'db-att-name');
    if (server) {
      go.type = 'button';
      go.title = 'Open ' + (server.label || name);
      go.onclick = () => select(name);
    }
    go.append(icon('server'), document.createTextNode(server ? (server.label || name) : name + ' (removed)'));
    const sub = el('code', 'db-att-sub');
    sub.textContent = a.database ? 'database ' + a.database + ' · user ' + a.user : 'key prefix ' + name + ':';
    text.append(go, sub);
    const show = iconButton('eye', 'Show credentials', 'sm');
    show.onclick = () => showCredentials(row.name, name);
    li.append(text, show);
    list.append(li);
  }
  if (names.length) att.append(list);
  body.append(att);
}

