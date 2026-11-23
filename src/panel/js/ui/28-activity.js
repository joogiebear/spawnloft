'use strict';
// --------------------------------------------------------------- activity ---

/**
 * The Activity tool: what was done to this server, when, and by whom.
 *
 * <p>Whom is what it is for. A server that was fine last night and is not this morning was changed
 * by somebody - you, a schedule, an AI assistant you gave it to, or SpawnLoft's own crash guard -
 * and this says which, in sentences. A change that kept an exact copy of what it changed (an edit,
 * a replaced file, a delete, an assistant's config change) has Undo beside it.
 */
const ACTIVITY_TEXT = {
  start: 'Started', stop: 'Stopped', kill: 'Forced to stop', command: 'Ran', crash: 'Crashed',
  backup: 'Backed up:', restore: 'Restored', 'backup-delete': 'Deleted', 'backup-prune': 'Cleared old backups:', 'backup-lock': 'Locked', 'backup-unlock': 'Unlocked', 'backup-note': 'Put a note on',
  'file-edit': 'Edited', 'file-create': 'Created', 'folder-create': 'Made a folder', 'file-upload': 'Uploaded',
  'file-replace': 'Replaced', 'file-move': 'Moved', 'file-delete': 'Deleted', 'file-zip': 'Zipped', 'file-unzip': 'Unzipped',
  'config-edit': 'Changed', 'config-create': 'Created', undo: 'Put back', settings: 'Changed settings:',
  'plugin-install': 'Installed', 'plugin-update': 'Updated', 'plugin-enable': 'Turned on', 'plugin-disable': 'Turned off', 'plugin-remove': 'Removed',
  upgrade: 'Changed the server software:', 'world-activate': 'Switched to the world', 'world-import': 'Imported the world', 'world-delete': 'Deleted the world',
  'player-op': 'Made an operator:', 'player-deop': 'Took operator from', 'player-ban': 'Banned', 'player-unban': 'Unbanned', 'player-forget': 'Forgot the player',
  'player-whitelist': 'Whitelisted', 'player-unwhitelist': 'Took off the whitelist:', 'whitelist-on': 'Turned the whitelist on', 'whitelist-off': 'Turned the whitelist off',
  'schedule-add': 'Scheduled', 'schedule-change': 'Changed the schedule', 'schedule-enable': 'Turned on the schedule', 'schedule-disable': 'Paused the schedule', 'schedule-remove': 'Removed the schedule',
  'schedule-run': 'Ran the schedule now:',
  create: 'Created this server', adopt: 'Added this server from', rename: 'Renamed', rebuild: 'Reset:', delete: 'Removed this server:',
};

/**
 * One entry as a sentence in two parts: what was done, and to what.
 *
 * A verb that ends in a colon keeps it when there is something after it ("Changed settings:
 * Difficulty: hard"); it was stripped everywhere, which left "Changed settings difficulty = hard".
 * A start that failed says so in its words, where "Started" under a Failed pill said the opposite.
 */
function activityWords(e) {
  if (e.action === 'crash' && e.detail) return { verb: e.detail.charAt(0).toUpperCase() + e.detail.slice(1), detail: '' };
  if (e.action === 'start' && e.ok === false) return { verb: e.detail ? 'Could not start:' : 'Could not start', detail: e.detail || '' };
  if (!e.detail && ACTIVITY_BARE[e.action]) return { verb: ACTIVITY_BARE[e.action], detail: '' };
  const verb = ACTIVITY_TEXT[e.action] || e.action;
  if (!e.detail) return { verb: verb.replace(/:$/, ''), detail: '' };
  // a file that happens to be named like an archive is still a file
  if (/^file-/.test(e.action)) return { verb, detail: e.detail };
  const gone = e.action === 'backup-note' && / \(note removed\)$/.test(e.detail);
  if (gone) return { verb: 'Took the note off', detail: backupNamesToWords(e.detail.replace(/ \(note removed\)$/, '')) };
  return { verb, detail: backupNamesToWords(e.detail) };
}
// Changes whose copy holds exactly what they changed. The server makes the same list; this one only
// decides where a button is drawn.
const ACTIVITY_UNDOABLE = new Set(['file-edit', 'file-replace', 'file-delete', 'config-edit', 'world-delete']);
// SpawnLoft's own entries - the crash guard, its restarts - are under All: nobody goes looking for
// them on their own, and a fifth button made the row of filters the loudest thing on the screen.
const ACTIVITY_FILTERS = [['', 'All'], ['you', 'You'], ['schedule', 'Schedule'], ['assistant', 'Assistant']];
const activityView = { by: '' };

function activityActor(by) {
  const k = by && by.kind;
  if (k === 'panel') return { text: 'You', tone: 'you' };
  if (k === 'cli') return { text: 'You, in a terminal', tone: 'you' };
  if (k === 'assistant') return { text: by.name || 'AI assistant', tone: 'ai', title: 'An AI assistant, through SpawnLoft’s MCP tools' };
  if (k === 'schedule') return { text: by.name ? 'Schedule: ' + by.name : 'A schedule', tone: 'sched' };
  return { text: 'SpawnLoft', tone: 'sl', title: 'SpawnLoft itself - crash guard, or something it did on its own' };
}

/** Who did it, as the chip both screens show. */
function activityChip(by) {
  const who = activityActor(by);
  const chip = document.createElement('span');
  chip.className = 'act-who';
  chip.dataset.tone = who.tone;
  chip.textContent = who.text;
  if (who.title) chip.title = who.title;
  return chip;
}

function activityDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

async function renderActivity(opts) {
  const row = rowOf(state.current);
  const body = $('#activityBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;
  const base = '/instances/' + encodeURIComponent(row.name) + '/activity';
  const q = (before) => '?limit=60' + (activityView.by ? '&by=' + activityView.by : '') + (before ? '&before=' + encodeURIComponent(before) : '');

  let data;
  try {
    data = await api(base + q());
  } catch (e) {
    paneError(body, e.message, () => renderActivity());
    return;
  }
  if (body.dataset.for !== row.name) return;
  body.textContent = '';
  paneHead(body, 'history', 'Activity',
    'What was done to this server and who did it: you, a schedule, an AI assistant, or SpawnLoft itself.');

  const seg = document.createElement('div');
  seg.className = 'seg act-filter';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Show');
  for (const [value, label] of ACTIVITY_FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(activityView.by === value));
    b.onclick = () => { activityView.by = value; renderActivity(); };
    seg.append(b);
  }
  body.append(seg);

  if (!data.entries.length) {
    body.append(emptyState('history', activityView.by
      ? 'Nothing from them yet.'
      : 'Nothing yet. Starts and stops, backups, edits and anything an assistant or a schedule does will show here.'));
    return;
  }

  const list = el('div', 'act-list');
  body.append(list);
  const all = [...data.entries];
  let more = data.more;

  const clock = (iso) => {
    const t = el('time', 'act-when');
    t.dateTime = iso;
    t.textContent = CLOCK.format(new Date(iso));
    t.title = new Date(iso).toLocaleString();
    return t;
  };

  // An undo names the copy it put back; the change that copy undid says so rather than offering
  // the same undo twice.
  let undone = new Set();
  const undoOf = (e) => {
    if (!ACTIVITY_UNDOABLE.has(e.action) || !e.snapshot) return null;
    if (e.snapshotGone && !undone.has(e.snapshot)) {
      // the copy this would put back was deleted in Backups, or cleaned up for being old
      const note = el('span', 'act-undone');
      note.textContent = 'Copy removed';
      note.title = 'The copy kept before this change is no longer in Backups, so it cannot be undone from here.';
      return note;
    }
    if (undone.has(e.snapshot)) {
      const note = el('span', 'act-undone');
      note.textContent = 'Undone';
      return note;
    }
    const undo = iconButton('restore', 'Undo', 'ghost sm');
    undo.classList.add('act-undo');
    undo.title = 'Put back what this changed, as it was just before';
    undo.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await ask({
        title: 'Undo this change?',
        text: 'Puts back ' + (e.detail || 'what it changed') + ' as it was just before. '
          + 'Anything changed there since is replaced. The undo is recorded here too.',
        confirmLabel: 'Undo',
      });
      if (!ok) return;
      busy(undo, true);
      try {
        await post(base + '/undo', { snapshot: e.snapshot });
        toast('Put back ' + (e.detail || 'the change') + '.', 'good');
        // What the Files tool has on screen may be the file that just changed.
        const fsView = filesByServer.get(row.name);
        if (fsView && !fsView.editing) $('#filesBody').dataset.for = '';
        renderActivity();
      } catch (err) {
        toast(err.message, 'bad');
        busy(undo, false);
      }
    };
    return undo;
  };

  /*
    A day at a time, each day's entries grouped the way the Overview groups them - a run of the
    same thing back to back is one line that opens - so the two screens read alike. Redrawn whole
    when older entries arrive, keeping open runs open.
  */
  const paint = () => {
    undone = new Set(all.filter((e) => e.action === 'undo' && e.snapshot).map((e) => e.snapshot));
    const open = new Set(Array.from(list.querySelectorAll('details[open]')).map((d) => d.dataset.key));
    list.textContent = '';
    list.toggleAttribute('data-undo', all.some((e) => ACTIVITY_UNDOABLE.has(e.action) && e.snapshot));
    const days = [];
    for (const e of all) {
      const day = activityDay(e.at);
      if (!days.length || days[days.length - 1].day !== day) days.push({ day, entries: [] });
      days[days.length - 1].entries.push(e);
    }
    for (const d of days) {
      const h = el('h3', 'act-day');
      h.textContent = d.day;
      const ol = el('ol', 'feed act-feed');
      for (const run of groupActivity(d.entries)) {
        ol.append(feedItem(run, { showServer: false, showWho: true, open, linked: false, when: clock, tail: undoOf }));
      }
      list.append(h, ol);
    }
    count.textContent = more ? 'Showing the latest ' + all.length : all.length + (all.length === 1 ? ' entry' : ' entries');
    loadMore.hidden = !more;
  };

  const foot = el('div', 'act-foot');
  const count = el('span', 'hint');
  const loadMore = el('button', 'act-more');
  loadMore.textContent = 'Load more';
  loadMore.type = 'button';
  foot.append(count, loadMore);
  body.append(foot);
  loadMore.onclick = async () => {
    busy(loadMore, true, 'Loading…');
    try {
      const next = await api(base + q(all[all.length - 1].at));
      if (body.dataset.for !== row.name) return;
      all.push(...next.entries);
      more = next.more && next.entries.length > 0;
      paint();
    } catch (err) { toast(err.message, 'bad'); }
    busy(loadMore, false);
  };
  paint();
}

