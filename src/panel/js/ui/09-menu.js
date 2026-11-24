'use strict';
// -------------------------------------------------------------- the menu ---

/*
  "⋯": the rest of what can be done to a server, behind one button so Start and Stop stand alone.
  The items that need the server stopped say so rather than disappearing.
*/
function moreItems(row) {
  if (isDb(row)) {
    return [
      { label: 'Manage this database…', hint: 'Rename it, see its credentials, or delete it.', run: () => manageDatabase(row) },
    ];
  }
  const up = row.status === 'running' || row.status === 'stopping';
  const why = up ? 'Stop the server first.' : null;
  const play = playProfileFor(row);
  return [
    { label: 'Open folder', hint: 'Shows the server’s files in ' + FILE_MANAGER + '.', run: () => openFolder(row.name) },
    { label: 'Play', hint: !play ? 'Opens the Play page to make a setup for this server.' : play.running ? 'The setup \u201c' + play.name + '\u201d is running: opens it on the Play page.' : 'Starts the setup \u201c' + play.name + '\u201d on the Play page, pointed at this server.', run: () => playClient(row) },
    { label: 'Upgrade…', hint: 'A newer build, or a newer Minecraft version, under Server software.', run: () => openUpgrade() },
    'sep',
    // A running server offers to stop first rather than a dead item; stopping, it waits like the rest.
    row.status === 'running'
      ? { label: 'Stop and edit…', hint: 'Name, memory and port. Stops the server first.', run: () => stopThenEdit(row) }
      : { label: 'Rename, memory and port…', hint: why || 'Takes effect the next time it starts.', run: () => editServer(row), disabled: up },
    'sep',
    { label: 'Reset the world…', hint: why || 'Deletes worlds and generated state. A backup is taken first.', run: () => rebuildServer(row), disabled: up, danger: true },
    { label: 'Delete this server…', hint: why || 'Removes it from SpawnLoft, and optionally its files.', run: () => deleteServer(row), disabled: up, danger: true },
  ];
}

async function stopThenEdit(row) {
  const online = row.latest && row.latest.players;
  const ok = await ask({
    title: 'Stop ' + (row.label || row.name) + ' to edit it?',
    text: online ? (online === 1 ? 'One player is online and will be disconnected.' : online + ' players are online and will be disconnected.') : 'Nobody is online.',
    confirmLabel: 'Stop and edit',
  });
  if (!ok || state.current !== row.name) return;
  await act('stop', { sure: true })();
  const now = rowOf(row.name);
  if (now && now.status !== 'running' && now.status !== 'stopping') editServer(now);
}

function buildMoreMenu() {
  const menu = $('#moreMenu');
  menu.textContent = '';
  const row = rowOf(state.current);
  if (!row) return;
  for (const item of moreItems(row)) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'sl-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.append(sep);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sl-menu-item disabled:cursor-not-allowed disabled:opacity-50';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.disabled = Boolean(item.disabled);
    if (item.disabled) b.setAttribute('aria-disabled', 'true');
    const title = document.createElement('span');
    title.className = 'font-semibold' + (item.danger && !item.disabled ? ' text-fault-ink' : '');
    title.textContent = item.label;
    const hint = document.createElement('small');
    hint.textContent = item.hint;
    b.append(title, hint);
    b.onclick = () => { moreMenu.close({ refocus: true }); item.run(); };
    menu.append(b);
  }
}

/** Upgrading lives with the rest of the server's software, in Settings. */
async function openUpgrade() {
  setTool('settings');
  await renderServerSettings();
  $('#settingsBody [data-settings-nav] [data-section="software"]')?.click();
}

function renderServer(row) {
  if (!row) return;
  const db = isDb(row);
  $('#vServer').dataset.status = row.status;
  $('#vServer').toggleAttribute('data-crashed', crashedNow(row));
  $('#srvName').textContent = row.label || row.name;
  // The name the commands and the folder use, shown only when it is not the same word.
  $('#srvId').textContent = row.name;
  $('#srvId').hidden = !row.label || row.label === row.name;
  // The same tool manages plugins/ on a Paper server and mods/ on a modded one; its name
  // follows, because "Plugins" on a server that cannot load any would be a small lie.
  // Named for what the software loads, from the same table the create form uses. Anything the
  // table does not know - a page loaded before it answered - reads as plugins, which is what
  // every server was before there were mod loaders.
  const content = (softwareById[row.loader ?? 'paper'] || softwareById.paper).content;
  $('#tabPlugins [data-label]').textContent = content === 'mods' ? 'Mods' : 'Plugins';
  renderServerTile(row);
  renderDockBadge();

  renderStatePill(row);
  renderMeta(row);
  renderVitals(row);

  // A database has two of the seven tools. The ones that do not apply are hidden rather than left
  // to open a blank panel.
  for (const b of $$('#dock [data-pane]')) b.hidden = db && !DB_TOOLS.has(b.dataset.pane);

  $('#srvOffline').hidden = row.onlineMode !== false;

  const notice = $('#srvNotice');
  notice.textContent = '';
  const note = STATE_NOTE[row.status];
  const noteKey = row.name + '|state|' + row.status;
  paintDbReach(row);
  // An unreachable database says so on its own page, beside the address it cannot reach, rather
  // than in a full-width red strip that repeats the pill above it.
  if (note && !dismissed.has(noteKey) && !(db && row.status === 'unreachable')) {
    notice.append(noticeBox({
      tone: row.status === 'stale' ? 'warn' : 'fault',
      title: note[0],
      text: note[1],
      actions: row.status === 'stale' ? [{ label: 'Start', run: () => $('#bStart').click() }]
        : row.status === 'orphaned' ? [{ label: 'Force stop', run: () => forceStop(row.name, row.label || row.name) }] : [],
      dismiss: () => dismissed.add(noteKey),
    }));
  }

  // The verbs follow the state: a running server offers Restart and Stop, a stopped one Start, so
  // there is only ever one primary button. A control that is going to be refused looks refused -
  // the core rejects these on a live server, so the panel says so before the round trip.
  const live = row.status === 'running';
  const up = live || row.status === 'stopping';
  const external = Boolean(row.external);
  // A database that runs elsewhere is started and stopped there, so there is no verb to offer
  // rather than a Start button that is always greyed out.
  $('#bStart').hidden = up || external;
  $('#bStop').hidden = !up || external;
  $('#bRestart').hidden = !up || external;
  $('#bStart').disabled = state.busy || external;
  $('#bStop').disabled = state.busy || !live || external;
  $('#bRestart').disabled = state.busy || !live || external;
  $('#bStart').title = external ? 'This database runs elsewhere; it is not started from here' : '';
  // The pressed verb spins until the core answers; the others are already disabled by busy.
  for (const [id, verb] of [['#bStart', 'start'], ['#bStop', 'stop'], ['#bRestart', 'restart']]) {
    if (state.acting === verb) $(id).setAttribute('aria-busy', 'true');
    else $(id).removeAttribute('aria-busy');
  }
  $('#bManage').disabled = state.busy;
  $('#cmd').disabled = !live || db;
  $('#bSend').disabled = !live || db;
  // A database takes no commands at all, so it gets no command row rather than a dead one.
  $('#cmdRow').hidden = db;
  // A stopped server's row offers the way to a live one, in place of a Send that cannot send.
  const startable = !db && !up && !external;
  $('#bSend').hidden = startable;
  $('#bCmdStart').hidden = !startable;
  $('#bCmdStart').disabled = state.busy;
  const phase = consolePhase(row);
  $('#cmd').placeholder = phase === 'stopping' ? 'Stopping…'
    : phase === 'starting' ? 'Starting… commands can be sent once it is up'
      : live ? 'Type a command — ↑ recalls' : 'Start the server to send commands';
  // The diagnostics zip and mclo.gs read a Minecraft server's folder; a database has neither.
  for (const el of $$('#exportMenu [data-mc]')) el.hidden = db;
  $('#log').setAttribute('aria-label', db ? 'Database log' : 'Server console');
  // the log says why it is empty, or that its lines are from before it stopped, as the state moves
  paintLogState();
  paintConNote();

  // The diagnoses are Minecraft's failure shapes; a database's console has its own.
  if (db) { $('#srvDiag').textContent = ''; diagKey = ''; } else loadDiagnosis(row);
}

