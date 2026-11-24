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
 * The things that want someone to do something, each with the one thing to do. Nothing here is
 * shown for its own sake: a crash, updates somebody asked about, a server with no backups going
 * unprotected, or a Java that will stop servers starting. Each item names its `rows`; items that
 * share a `merge` key are said once for all of them (groupAttention).
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
      key: 'updates|' + r.name + '|' + n, tone: 'accent', icon: 'plug', merge: 'updates', row: r, count: n,
      title: n + (n === 1 ? ' plugin update' : ' plugin updates') + ' for ' + nameOf(r),
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
        merge: 'backup', row: r, never: b.none && !b.gone, offer, automatic: Boolean(data.automaticAvailable),
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
        + ' won’t start until it is installed.',
      actions: [{ label: 'Get Java', run: () => openOutside(state.health.javaDownload), primary: true }],
    });
  }
  return items;
}

/** "A, B and C": names for a sentence. */
function nameList(names) {
  return names.length < 2 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * One line for each kind of problem, not one for each server: "2 servers have never been backed
 * up" with one button for both, where the page used to say the same thing twice. Crashes and Java
 * stay as they are (each is its own server's, or already one line). The worst comes first, then
 * the order they were found in.
 */
function groupAttention(items) {
  const nameOf = (r) => r.label || r.name;
  const groups = new Map();
  const out = [];
  for (const item of items) {
    if (!item.merge) { out.push(item); continue; }
    if (!groups.has(item.merge)) {
      const slot = { many: [] };
      groups.set(item.merge, slot);
      out.push(slot);
    }
    groups.get(item.merge).many.push(item);
  }
  const merged = out.map((entry) => {
    if (!entry.many) return entry;
    const list = entry.many;
    if (list.length === 1) return list[0];
    const rows = list.map((i) => i.row);
    const names = rows.map(nameOf);
    // one way into each server's own page for the kind, as a menu under one button
    const review = (tool, label) => ({ label, items: rows.map((r) => ({ label: nameOf(r), onSelect: () => openServerTool(r.name, tool) })) });
    if (list[0].merge === 'updates') {
      return {
        key: 'updates|' + list.map((i) => i.key).join('+'), tone: 'accent', icon: 'plug',
        title: 'Plugin updates for ' + list.length + ' servers',
        text: list.map((i) => nameOf(i.row) + ' (' + i.count + ')').join(', '),
        actions: [review('plugins', 'Review')],
      };
    }
    const never = list.every((i) => i.never);
    const automatic = list[0].automatic;
    const both = list.length === 2 ? 'both' : 'all ' + list.length;
    return {
      key: 'backup|' + list.map((i) => i.key).join('+'), tone: 'warn', icon: 'archive',
      title: list.length + ' servers ' + (never ? 'have never been backed up' : 'have no recent backup'),
      text: nameList(names) + '. ' + list[0].offer,
      actions: automatic
        ? [{ label: 'Turn on for ' + both, run: () => turnOnBackups(rows), primary: true }, review('backups', 'Review')]
        : [{ ...review('backups', 'Open Backups'), primary: true }],
    };
  });
  const rank = { fault: 0, warn: 1, accent: 2 };
  // Array.sort is stable: within one tone the order they were found in stays
  return merged.sort((a, b) => (rank[a.tone] ?? 3) - (rank[b.tone] ?? 3));
}

/* A button that does one thing, or a menu that goes to each of several servers. */
function attentionAction(a) {
  if (a.items) return Kit.menu({ label: a.label, kind: a.primary ? 'primary' : 'secondary', items: a.items });
  const button = Kit.button({ label: a.label, kind: a.primary ? 'primary' : 'secondary', size: 'sm' });
  button.onclick = async () => {
    Kit.busy(button, true);
    try { await a.run(); } finally { Kit.busy(button, false); }
  };
  return button;
}

/*
  Rebuilt only when what it says changes, not on every poll - a banner rebuilt under someone's
  pointer loses the hover and, worse, the focus of the button they were about to press.
*/
function renderAttention() {
  const items = groupAttention(attentionItems());
  const box = $('#homeAttention');
  box.hidden = !items.length;
  // The text is left out of the key: it carries "6h ago", and a banner rebuilt each time that ticks
  // over loses the focus of the button someone was about to press. It is refreshed in place.
  const key = items.map((i) => i.key + '|' + i.title).join('\n');
  if (key === overview.attention) {
    items.forEach((item, i) => {
      const body = box.children[i + 1] && box.children[i + 1].querySelector('.sl-banner-body');
      if (body && body.textContent !== item.text) body.textContent = item.text;
    });
    return;
  }
  overview.attention = key;
  box.replaceChildren(box.querySelector('#attTitle'));
  for (const item of items) {
    const banner = Kit.banner({ tone: item.tone === 'accent' ? undefined : item.tone, icon: item.icon, title: item.title, text: item.text, actions: item.actions.map(attentionAction) });
    // Said in words as well as in colour: the glyph is decoration to a screen reader.
    const lead = item.tone === 'fault' ? 'Problem: ' : item.tone === 'warn' ? 'Warning: ' : '';
    if (lead) banner.querySelector('.sl-banner-title').prepend(Kit.h('span', { class: 'sl-sr', text: lead }));
    box.append(banner);
  }
}
$('#homeFailRetry').onclick = async (e) => {
  Kit.busy(e.currentTarget, true);
  await loadOverview(true);
  Kit.busy($('#homeFailRetry'), false);
};

/** "See why": that server, its console on screen. */
function openServerConsole(name) {
  select(name, { then: () => showPane('console') });
}

/** "Review", "Open Backups": that server, with the tool open. */
function openServerTool(name, tool) {
  select(name, { then: () => showPane(tool) });
}

/** The default the Backups tool offers: every night at 03:00, keeping seven. */
async function turnOnBackups(target) {
  const rows = [].concat(target);
  const nightly = AUTO_INTERVALS.find((o) => o.label === 'Daily at 03:00');
  const worked = [];
  const failed = [];
  let why = '';
  for (const row of rows) {
    try {
      await post('/instances/' + encodeURIComponent(row.name) + '/backups/auto', { enabled: true, schedule: nightly.schedule, keep: 7 });
      worked.push(row);
    } catch (e) {
      failed.push(row);
      why = e.message;
    }
  }
  const said = ', at ' + clockWords('03:00') + ', keeping the last 7.';
  if (worked.length === 1) toast('Nightly backups of ' + (worked[0].label || worked[0].name) + ' at ' + clockWords('03:00') + ', keeping the last 7.', 'good');
  else if (worked.length) toast('Nightly backups are on for ' + worked.length + ' servers' + said, 'good');
  if (failed.length) toast(failed.length === 1 && rows.length === 1 ? why : 'Could not turn on backups for ' + nameList(failed.map((r) => r.label || r.name)) + ': ' + why, 'bad');
  if (state.view === 'home') await loadOverview(true);
}
