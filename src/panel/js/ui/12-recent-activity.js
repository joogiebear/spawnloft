'use strict';
// ---- recent activity ------------------------------------------------------------

// Two of the same thing more than this far apart are two events, not one run.
const FEED_RUN_GAP_MS = 30 * 60 * 1000;

function actorKey(by) {
  return (by && by.kind ? by.kind : 'spawnloft') + '|' + (by && by.name ? by.name : '');
}

/**
 * Consecutive entries of the same thing - one server, one action, one actor, one outcome, each
 * within half an hour of the last - become one run. Entries are newest first and so are runs.
 */
function groupActivity(entries) {
  const runs = [];
  for (const e of entries) {
    const key = e.server + '\n' + e.action + '\n' + actorKey(e.by) + '\n' + (e.ok === false ? 'bad' : 'ok');
    const last = runs[runs.length - 1];
    const prev = last && last.entries[last.entries.length - 1];
    if (last && last.key === key && Math.abs(Date.parse(prev.at) - Date.parse(e.at)) <= FEED_RUN_GAP_MS) last.entries.push(e);
    else runs.push({ key, entries: [e] });
  }
  return runs;
}

// What a run of n says. Anything without a phrase here says its verb and a count.
const ACTIVITY_MANY = {
  backup: 'Made {n} backups', 'backup-delete': 'Deleted {n} backups', 'backup-prune': 'Cleared old backups {n} times',
  'backup-lock': 'Locked {n} backups', 'backup-unlock': 'Unlocked {n} backups', restore: 'Restored {n} backups',
  start: 'Started {n} times', stop: 'Stopped {n} times', kill: 'Forced to stop {n} times', crash: 'Crashed {n} times',
  command: 'Ran {n} commands', 'file-edit': 'Edited {n} files', 'file-create': 'Created {n} files', 'file-upload': 'Uploaded {n} files',
  'file-delete': 'Deleted {n} files', 'file-move': 'Moved {n} files', 'config-edit': 'Changed {n} config files',
  'plugin-install': 'Installed {n} plugins', 'plugin-update': 'Updated {n} plugins', 'plugin-remove': 'Removed {n} plugins',
  'plugin-enable': 'Turned on {n} plugins', 'plugin-disable': 'Turned off {n} plugins', settings: 'Changed settings {n} times',
  'player-op': 'Made {n} operators', 'player-ban': 'Banned {n} players', 'player-unban': 'Unbanned {n} players',
  'schedule-add': 'Scheduled {n} tasks', 'schedule-remove': 'Removed {n} schedules', 'schedule-run': 'Ran schedules {n} times',
};

// What a verb says when the entry did not record what it was done to: "Installed" alone reads as
// a sentence cut off.
const ACTIVITY_BARE = {
  restore: 'Restored a backup', 'backup-delete': 'Deleted a backup', 'backup-lock': 'Locked a backup', 'backup-unlock': 'Unlocked a backup', 'backup-note': 'Put a note on a backup',
  'plugin-install': 'Installed a plugin', 'plugin-update': 'Updated a plugin', 'plugin-remove': 'Removed a plugin',
  'plugin-enable': 'Turned on a plugin', 'plugin-disable': 'Turned off a plugin',
  'file-edit': 'Edited a file', 'file-create': 'Created a file', 'file-upload': 'Uploaded a file', 'file-replace': 'Replaced a file',
  'file-move': 'Moved a file', 'file-delete': 'Deleted a file', 'file-zip': 'Zipped files', 'file-unzip': 'Unzipped a file',
  'config-edit': 'Changed a config file', 'config-create': 'Created a config file', undo: 'Put back a change',
  command: 'Ran a command', settings: 'Changed settings', 'player-ban': 'Banned a player', 'player-unban': 'Unbanned a player',
  'schedule-add': 'Scheduled a task', rename: 'Renamed this server',
};

/** A run as words: the one entry's own sentence, or what n of them come to. */
function runText(run) {
  const n = run.entries.length;
  const e = run.entries[0];
  if (n === 1) return activityWords(e);
  const many = ACTIVITY_MANY[e.action];
  return { verb: many ? many.replace('{n}', n) : (ACTIVITY_TEXT[e.action] || e.action).replace(/:$/, '') + ' ×' + n, detail: '' };
}

const feed = { all: false };

/**
 * The last few things done anywhere, newest first, a run of the same thing as one line. A line
 * opens that server's Activity, where the rest of its history and any Undo are; a server since
 * deleted has nowhere to open, and says so. The server and the actor are said only where there is
 * more than one to tell apart: one server and one person is eighteen repeats of "Survival" and
 * "You" saying nothing.
 */
function renderHomeActivity() {
  const entries = overview.activity || [];
  const box = $('#homeActList');
  $('#homeActivity').hidden = !entries.length;
  const showServer = new Set(entries.map((e) => e.server)).size > 1;
  const showWho = new Set(entries.map((e) => actorKey(e.by))).size > 1;
  const runs = groupActivity(entries);
  const shown = feed.all ? runs : runs.slice(0, FEED_SHOWN);
  // Rebuilt only when what it says changes; the times are refreshed in place, so a line under
  // someone's focus survives the minute ticking over.
  const key = shown.map((r) => r.entries.map((e) => e.at).join(',')).join('|') + '|' + showServer + showWho;
  for (const t of box.querySelectorAll('time')) t.textContent = ago(t.dateTime) || stamp(t.dateTime);
  if (key !== feed.key) {
    feed.key = key;
    box.replaceChildren(Kit.list(shown.map((run) => homeFeedRow(run, { showServer, showWho })), 'Recent activity'));
  }
  const more = $('#homeActMore');
  const servers = new Set(entries.map((e) => e.server));
  const only = servers.size === 1 ? rowOf([...servers][0]) : null;
  if (only && !feed.all && runs.length > FEED_SHOWN) {
    more.hidden = false;
    more.textContent = 'All activity in ' + (only.label || only.name);
    more.onclick = () => openServerTool(only.name, 'activity');
  } else {
    more.hidden = runs.length <= FEED_SHOWN;
    more.textContent = feed.all ? 'Show fewer' : 'Show all ' + runs.length;
    more.onclick = () => { feed.all = !feed.all; renderHomeActivity(); };
  }
}

/** One line of the Overview's feed: what was done, who by and where, and when. */
function homeFeedRow(run, { showServer, showWho }) {
  const e = run.entries[0];
  const server = rowOf(e.server);
  const said = runText(run);
  const where = server ? (server.label || server.name) : e.server + ' (deleted)';
  const sentence = said.verb + (said.detail ? ' ' + said.detail : '');
  const meta = [e.ok === false ? (e.action === 'crash' ? 'Crash' : 'Failed') : '', showServer ? where : '', showWho ? activityActor(e.by).text : ''].filter(Boolean).join(' · ');
  const when = Kit.h('time', { dateTime: e.at, title: new Date(e.at).toLocaleString(), text: ago(e.at) || stamp(e.at) });
  const row = Kit.row({
    lead: Kit.icon(activityIcon(e.action)),
    title: sentence,
    meta,
    end: [when],
    onClick: server ? () => openServerTool(server.name, 'activity') : null,
  });
  row.querySelector('.sl-row-title').title = sentence;
  if (e.ok === false) row.querySelector('.sl-row-meta').classList.add('text-fault-ink');
  if (server) row.title = 'Open ' + where + '’s activity';
  return row;
}

function feedTime(iso) {
  const when = el('time', 'act-when');
  when.dateTime = iso;
  when.textContent = ago(iso) || stamp(iso);
  when.title = new Date(iso).toLocaleString();
  return when;
}

/**
 * One line of history, or a run that opens to its lines. The Overview's lines open the server's
 * Activity; the Activity tool's own are plain (`linked: false`), tell the time by the clock under a
 * day heading, and carry Undo in a last column (`tail`).
 */
function feedItem(run, { showServer, showWho, open, linked = true, when = feedTime, tail = null }) {
  const li = el('li');
  const e = run.entries[0];
  const row = linked ? rowOf(e.server) : null;
  const tailOf = (entry) => (tail ? [tail(entry) || el('span')] : []);
  const said = runText(run);
  const where = rowOf(e.server) ? (rowOf(e.server).label || rowOf(e.server).name) : e.server + ' (deleted)';

  const what = el('span', 'feed-what');
  const text = el('span', 'feed-text');
  text.append(said.verb);
  if (said.detail) {
    const d = el(/^(file|folder|config|undo|command)/.test(e.action) ? 'code' : 'span', 'dim');
    d.textContent = ' ' + said.detail;
    text.append(d);
  }
  // The whole sentence, for the line it was cut short to fit.
  text.title = said.verb + (said.detail ? ' ' + said.detail : '');
  what.append(text);
  if (e.ok === false) {
    const pill = el('span', 'pill');
    pill.dataset.tone = 'ban';
    pill.textContent = e.action === 'crash' ? 'Crash' : 'Failed';
    what.append(pill);
  }
  const meta = el('span', 'feed-meta');
  if (showServer) {
    const s = el('b', 'act-server');
    s.textContent = where;
    meta.append(s);
  }
  if (showWho) meta.append(activityChip(e.by));

  if (run.entries.length === 1) {
    const line = el(row ? 'button' : 'div', 'feed-row');
    if (row) {
      line.type = 'button';
      line.title = 'Open ' + where + '\u2019s activity';
      line.onclick = () => openServerTool(row.name, 'activity');
    }
    if (e.ok === false) line.setAttribute('data-bad', '');
    line.append(icon(activityIcon(e.action)), what, meta, when(e.at), ...tailOf(e));
    li.append(line);
    return li;
  }

  // A run: one line that opens to the entries in it.
  const details = el('details');
  details.dataset.key = run.key + '|' + run.entries[run.entries.length - 1].at;
  details.open = open.has(details.dataset.key);
  const summary = el('summary', 'feed-row');
  if (e.ok === false) summary.setAttribute('data-bad', '');
  const last = run.entries[run.entries.length - 1];
  const span = ago(last.at) !== ago(e.at) ? ago(last.at) + ' to ' + ago(e.at) : ago(e.at);
  summary.title = text.title + ' \u00b7 ' + span;
  summary.append(icon('caret'), what, meta, when(e.at), ...(tail ? [el('span')] : []));
  const sub = el('ol', 'feed-sub');
  for (const one of run.entries) {
    const item = el('li');
    const line = el(row ? 'button' : 'div', 'feed-row');
    if (row) {
      line.type = 'button';
      line.title = 'Open ' + where + '\u2019s activity';
      line.onclick = () => openServerTool(row.name, 'activity');
    }
    const t = el('span', 'feed-text');
    t.textContent = one.detail || ACTIVITY_BARE[one.action] || (ACTIVITY_TEXT[one.action] || one.action);
    t.title = t.textContent;
    const w = el('span', 'feed-what');
    w.append(t);
    if (one.ok === false) line.setAttribute('data-bad', '');
    line.append(el('span'), w, el('span', 'feed-meta'), when(one.at), ...tailOf(one));
    item.append(line);
    sub.append(item);
  }
  details.append(summary, sub);
  li.append(details);
  return li;
}

/** The glyph a line of history leads with: what kind of thing was done. */
function activityIcon(action) {
  if (/^backup|^restore/.test(action)) return 'archive';
  if (/^schedule/.test(action)) return 'clock';
  if (/^plugin/.test(action)) return 'plug';
  if (/^(file|folder|config|undo)/.test(action)) return 'file';
  if (/^world/.test(action)) return 'map';
  if (/^(player|whitelist)/.test(action)) return 'user';
  if (action === 'command') return 'terminal';
  if (action === 'crash' || action === 'kill') return 'alert';
  if (action === 'start' || action === 'stop') return 'pulse';
  return 'history';
}

