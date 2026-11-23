'use strict';
// ---- needs attention ----------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const sameDay = (ms) => new Date(ms).toDateString() === new Date().toDateString();
const clockOf = (ms) => CLOCK.format(new Date(ms));

/**
 * Whether a server needs a newer Java than it will get. Its own Java where the panel knows which
 * that is, and otherwise the one SpawnLoft found; and "not known yet" is never read as "missing" -
 * until /health has answered, nobody is told to go and install anything.
 */
function javaShort(row) {
  if (!row.javaNeeds) return false;
  const own = javaMajorFor(row);
  if (own != null) return own < row.javaNeeds;
  const java = state.health && state.health.java;
  if (!java) return false;
  return !java.found || java.major < row.javaNeeds;
}

/**
 * Where a server stands on backups, said once for the card and the attention list alike. "Never"
 * only when the log agrees: a server whose backups were all deleted has none on disk, but it has
 * been backed up, and calling that "never" made the page contradict its own activity feed.
 */
function backupState(row) {
  const facts = overview.data && overview.data.servers[row.name];
  if (!facts) return null;
  const trail = facts.backupTrail || null;
  const none = facts.lastBackupAt == null;
  return {
    auto: facts.autoBackup && facts.autoBackup.enabled ? facts.autoBackup : null,
    lastAt: facts.lastBackupAt,
    none,
    gone: none && Boolean(trail && (trail.lastMadeAt || trail.deleted)),
    trail,
  };
}

/** What became of the backups a server no longer has, from its activity. */
function goneSentence(trail) {
  const when = (ms) => ago(new Date(ms).toISOString()) || 'earlier';
  const deleted = trail.deleted
    ? (trail.deleted === 1 ? '1 backup was' : trail.deleted + ' backups were') + ' deleted'
    : '';
  const off = trail.scheduleOffAt ? 'the backup schedule was removed' : '';
  if (deleted && off) {
    const a = when(trail.lastDeletedAt);
    const b = when(trail.scheduleOffAt);
    if (a === b) return 'Its ' + (trail.deleted === 1 ? 'backup was' : trail.deleted + ' backups were') + ' deleted and ' + off.replace('the ', 'its ') + ' ' + a + '.';
    return capital(deleted) + ' ' + a + ', and ' + off + ' ' + b + '.';
  }
  if (deleted) return capital(deleted) + ' ' + when(trail.lastDeletedAt) + '.';
  if (off) return capital(off) + ' ' + when(trail.scheduleOffAt) + ', and no backup is left on disk.';
  return 'The last backup, made ' + when(trail.lastMadeAt) + ', is no longer on disk.';
}
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The few things that want someone to do something, each with the one thing to do. Nothing here
 * is shown for its own sake: a card is a crash, updates somebody asked about, a server with no
 * backups going unprotected, or a Java that will stop servers starting.
 */
function attentionItems() {
  const items = [];
  const data = overview.data;
  const nameOf = (r) => r.label || r.name;

  for (const r of state.rows) {
    if (crashedNow(r)) {
      items.push({
        key: 'crash|' + r.name + '|' + (r.stoppedAt || ''), tone: 'fault', icon: 'alert',
        title: nameOf(r) + ' crashed',
        text: r.stoppedAt
          ? 'It stopped on its own ' + (sameDay(r.stoppedAt) ? 'at ' + clockOf(r.stoppedAt) : ago(new Date(r.stoppedAt).toISOString())) + '.'
          : 'It stopped without being asked to.',
        actions: [{ label: 'See why', run: () => openServerConsole(r.name), primary: true }],
      });
    } else if (r.status === 'running' && r.restarts > 0 && r.startedAt && sameDay(r.startedAt)) {
      // Each comeback is a fresh launch, so the start time is when the latest one happened.
      items.push({
        key: 'restart|' + r.name + '|' + r.restarts, tone: 'fault', icon: 'restart',
        title: nameOf(r) + ' restarted after a crash',
        text: r.restarts === 1
          ? 'Crash guard brought it back at ' + clockOf(r.startedAt) + '.'
          : 'Crash guard has brought it back ' + r.restarts + ' times, the last at ' + clockOf(r.startedAt) + '.',
        actions: [{ label: 'See why', run: () => openServerConsole(r.name), primary: true }],
      });
    }
  }

  // Only what a check someone ran has found - no network is asked from here.
  for (const r of state.rows) {
    const found = cachedUpdates(r.name);
    const n = found ? Object.keys(found).length : 0;
    if (!n) continue;
    const names = Object.values(found).map((u) => (u.name || u.file.replace(/\.jar$/, '')));
    items.push({
      key: 'updates|' + r.name + '|' + n, tone: 'accent', icon: 'plug',
      title: n + (n === 1 ? ' update' : ' updates') + ' for ' + nameOf(r),
      text: names.join(', '),
      actions: [{ label: 'Review', run: () => openServerTool(r.name, 'plugins') }],
    });
  }

  if (data) {
    for (const r of state.rows) {
      const b = backupState(r);
      if (!b || b.auto) continue;
      const days = b.none ? 0 : Math.floor((Date.now() - b.lastAt) / DAY_MS);
      if (!b.none && !(r.status === 'running' && days >= 7)) continue;
      const offer = data.automaticAvailable
        ? 'Turn on nightly backups at ' + clockWords('03:00') + ', keeping the last 7.'
        : 'Automatic backups are not available here; take one from Backups.';
      items.push({
        key: 'backup|' + r.name + '|' + (b.gone ? 'gone' : b.none ? 'never' : days), tone: 'warn', icon: 'archive',
        title: b.gone ? nameOf(r) + ' has no backups' : b.none ? nameOf(r) + ' has never been backed up' : 'No backup of ' + nameOf(r) + ' in ' + days + ' days',
        text: b.gone ? goneSentence(b.trail) + ' ' + offer : offer,
        actions: data.automaticAvailable
          ? [{ label: 'Turn on backups', run: () => turnOnBackups(r), primary: true }, { label: 'Open Backups', run: () => openServerTool(r.name, 'backups') }]
          : [{ label: 'Open Backups', run: () => openServerTool(r.name, 'backups'), primary: true }],
      });
    }
  }

  const short = state.rows.filter(javaShort);
  if (short.length && state.health) {
    const need = Math.max(...short.map((r) => r.javaNeeds));
    const names = short.map(nameOf);
    items.push({
      key: 'java|' + need + '|' + names.join(','), tone: 'warn', icon: 'alert',
      title: 'Java ' + need + ' needed',
      text: (names.length > 2 ? names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more' : names.join(' and '))
        + (names.length === 1 ? ' won’t start until it is installed.' : ' won’t start until it is installed.'),
      actions: [{ label: 'Get Java', run: () => openOutside(state.health.javaDownload), primary: true }],
    });
  }
  return items;
}

/*
  Three to a row, and "and N more" for the rest: a wall of warnings is read as none. Rebuilt only
  when what it says changes, not on every poll - a card rebuilt under someone's pointer loses the
  hover and, worse, the focus of the button they were about to press.
*/
function renderAttention() {
  const items = attentionItems();
  const box = $('#homeAttention');
  const shown = overview.showAll ? items : items.slice(0, 3);
  // The text is left out of the key: it carries "6h ago", and a card rebuilt each time that ticks
  // over loses the focus of the button someone was about to press. It is refreshed in place.
  const key = items.map((i) => i.key + '|' + i.title).join('\n') + '|' + overview.showAll;
  box.hidden = !items.length;
  if (key === overview.attention) {
    $$('#attGrid .att-words span').forEach((span, i) => { if (shown[i] && span.textContent !== shown[i].text) span.textContent = shown[i].text; });
    return;
  }
  overview.attention = key;

  const grid = $('#attGrid');
  grid.textContent = '';
  for (const item of shown) {
    const card = document.createElement('div');
    card.className = 'att';
    card.dataset.tone = item.tone;
    const tile = document.createElement('span');
    tile.className = 'att-tile';
    tile.append(icon(item.icon));
    // Said in words as well as in colour: the tile's glyph is decoration to a screen reader.
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', (item.tone === 'fault' ? 'Problem: ' : item.tone === 'warn' ? 'Warning: ' : '') + item.title);
    const words = document.createElement('div');
    words.className = 'att-words';
    const b = document.createElement('b');
    b.textContent = item.title;
    const p = document.createElement('span');
    p.textContent = item.text;
    words.append(b, p);
    const acts = document.createElement('div');
    acts.className = 'att-acts';
    for (const a of item.actions) {
      const act = document.createElement('button');
      act.type = 'button';
      act.textContent = a.label;
      if (a.primary) act.className = 'primary';
      act.onclick = a.run;
      acts.append(act);
    }
    card.append(tile, words, acts);
    grid.append(card);
  }
  const more = $('#attMore');
  const rest = items.length - 3;
  more.hidden = rest <= 0;
  more.textContent = overview.showAll ? 'Show fewer' : 'and ' + rest + ' more';
}
$('#homeFailRetry').onclick = async (e) => {
  busy(e.currentTarget, true);
  await loadOverview(true);
  busy($('#homeFailRetry'), false);
};
$('#attMore').onclick = () => { overview.showAll = !overview.showAll; renderAttention(); };

/** "See why": that server, its console on screen. */
function openServerConsole(name) {
  select(name, { then: () => showPane('console') });
}

/** "Review", "Open Backups": that server, with the tool open. */
function openServerTool(name, tool) {
  select(name, { then: () => showPane(tool) });
}

/** The default the Backups tool offers: every night at 03:00, keeping seven. */
async function turnOnBackups(row) {
  const nightly = AUTO_INTERVALS.find((o) => o.label === 'Daily at 03:00');
  try {
    await post('/instances/' + encodeURIComponent(row.name) + '/backups/auto', { enabled: true, schedule: nightly.schedule, keep: 7 });
    toast('Nightly backups of ' + (row.label || row.name) + ' at ' + clockWords('03:00') + ', keeping the last 7.', 'good');
  } catch (e) {
    toast(e.message, 'bad');
  }
  if (state.view === 'home') await loadOverview(true);
}

