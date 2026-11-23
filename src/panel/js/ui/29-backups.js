'use strict';
// ---------------------------------------------------------------- backups ---

const STAMP = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const STAMP_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/**
 * Seconds are noise on something taken minutes apart at most; the age beside it carries the rest.
 * The year is said when it is not this one.
 */
function stamp(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return String(iso);
  return (at.getFullYear() === new Date().getFullYear() ? STAMP : STAMP_YEAR).format(at);
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  // A file dated in the future is a clock that moved, not a backup from tomorrow. Saying nothing
  // beats "in -3 hours", and the absolute timestamp beside it is still true.
  if (ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

const AUTO_INTERVALS = [
  { label: 'Every hour', schedule: { kind: 'hourly', every: 1 } },
  { label: 'Every 6 hours', schedule: { kind: 'hourly', every: 6 } },
  { label: 'Every 12 hours', schedule: { kind: 'hourly', every: 12 } },
  { label: 'Daily at 03:00', schedule: { kind: 'daily', at: '03:00' } },
  { label: 'Daily at 05:00', schedule: { kind: 'daily', at: '05:00' } },
  { label: 'Weekly, Sunday 03:00', schedule: { kind: 'weekly', day: 'SUN', at: '03:00' } },
];

/**
 * What a snapshot puts back, in a sentence someone will read.
 *
 * A full snapshot lists sixteen members, and spelling them all out filled the confirm dialog with
 * a wall of filenames - which is the opposite of what a dialog asking "are you sure" is for. The
 * first few name the things that matter; the count carries the rest.
 */
/**
 * The file a snapshot holds when it holds exactly one - a path inside the server folder with an
 * extension, such as plugins/EcoCrates/config.yml or server.properties - or null. The scoped
 * snapshots name folders (plugins, world, config), so a lone file with an extension is a snapshot
 * of just that file, and saying so is true whichever way it came about.
 */
/** The copies the Files tool takes, by the label it gives them. */
const FILES_SNAPSHOT = {
  'file-edit': { tag: 'before an edit', why: 'as it was before it was edited in Files' },
  'file-replace': { tag: 'before a replace', why: 'as it was before an upload replaced it' },
  'file-delete': { tag: 'deleted', why: 'as it was when it was deleted in Files' },
  'world-delete': { tag: 'deleted world', why: 'as it was when it was deleted in Worlds' },
};

/**
 * A backup as a person knows it: when it was taken, and its note if it has one. The archive's
 * file name is how the disk knows it, and stays in the list for anyone who goes looking there.
 */
function backupWords(snap, capital) {
  return (capital ? 'The' : 'the') + ' backup from ' + stamp(snap.mtime) + (snap.note ? ' (“' + snap.note + '”)' : '');
}

/** An archive's file name inside a sentence written by the core, said as when it was taken. */
function backupNamesToWords(text) {
  // [label_]scope_YYYY-MM-DD_HHMMSS[_n].tar.gz, standing by itself: a name with a folder in front
  // of it is somebody's file, and a bracket or a quote around it is kept
  return String(text).replace(/(?<![\w.\/\\-])(?:[\w.-]*_)?(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:_\d+)?\.tar\.gz/g, (all, y, mo, d, h, mi, sec) => {
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
    // 99:99:99 rolls over to a real date, which is not when anything was taken
    const real = at.getMonth() === Number(mo) - 1 && at.getDate() === Number(d) && at.getHours() === Number(h) && at.getMinutes() === Number(mi) && at.getSeconds() === Number(sec);
    return real ? 'the backup from ' + stamp(at) : all;
  });
}

/** The Reason column: what prompted a snapshot, from its label or the schedule that took it. */
function snapshotReason(snap) {
  const label = snap.label || '';
  const named = {
    'pre-restore': 'Before a restore', 'before-edit': 'Before an AI edit', 'pre-delete': 'Before a delete',
    'pre-rebuild': 'Before a reset', 'pre-upgrade': 'Before an upgrade', 'pre-pack-update': 'Before a pack update',
    'file-edit': 'Before an edit', 'file-replace': 'Before a replace', 'file-delete': 'On delete', 'world-delete': 'On delete',
    'pre-install': 'Before a plugin install', 'pre-update': 'Before a plugin update',
    manual: 'By hand', nightly: 'Nightly',
  };
  if (named[label]) return named[label];
  if (snap.taskId) return 'Schedule';
  if (!label) return 'By hand';
  return label.charAt(0).toUpperCase() + label.slice(1).replace(/-/g, ' ');
}

function singleFileOf(snap) {
  const members = snap.members || [];
  if (members.length !== 1 || (snap.databases && snap.databases.length)) return null;
  const only = String(members[0]).replace(/\\/g, '/');
  return /(^|\/)[^/]+\.[a-z0-9]+$/i.test(only) ? only : null;
}

function describeMembers(members) {
  if (!members || !members.length) return 'everything the backup holds';
  if (members.length <= 4) return members.join(', ');
  const rest = members.length - 3;
  return members.slice(0, 3).join(', ') + ' and ' + rest + ' other files and folders';
}

function sameSchedule(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  return (a.every ?? null) === (b.every ?? null)
    && (a.at ?? null) === (b.at ?? null)
    && (a.day ?? null) === (b.day ?? null);
}

/**
 * Move where future backups are written.
 *
 * Deliberately does NOT move what is already there. Snapshots run to gigabytes and live on drives
 * chosen for having room; copying them as a side effect of changing a preference is a long, silent,
 * failable operation nobody asked for. So the old ones stay put and the dialog says so - the
 * alternative is a history that looks like it lost everything.
 *
 * The path is resolved when spawnloft starts, for the reason spelled out in paths.mjs, so this takes
 * effect on the next launch rather than pretending to apply now.
 */
/** What changing the backups folder does and does not do, said before the choice and after it. */
function backupsMoveWords(from, to) {
  return {
    before: 'This is where every server writes its backups. The ones already taken are not moved: they stay in '
      + from + ', and the history here starts empty in the new folder. To bring them along, move the folders inside '
      + from + ' into the new folder yourself before you restart SpawnLoft.',
    after: 'New backups go to ' + to + ' once SpawnLoft has been closed and opened again. Until then they still go to '
      + from + '. The backups already taken stay in ' + from + '; nothing was moved or deleted. To bring them along, move the folders inside it into '
      + to + ' before you restart.',
    pending: 'Changes to ' + to + ' when SpawnLoft restarts. Backups already taken stay here.',
  };
}

async function changeBackupsLocation(current) {
  let chosen = null;
  let saved = null; // the answer, when the dialog itself did the saving
  if (desktop) {
    // said before the folder picker opens, not after the choice has been saved
    const go = await ask({
      title: 'Change where backups are kept?',
      text: backupsMoveWords(current, 'the new folder').before,
      confirmLabel: 'Choose a folder',
    });
    if (!go) return;
    chosen = await desktop.pickFolder('Where should SpawnLoft keep backups?');
    if (!chosen) return;
  } else {
    const answer = await ask({
      title: 'Where should backups be kept?',
      text: backupsMoveWords(current, 'the new folder').before,
      input: { label: 'Full path to a folder', value: '', placeholder: current, required: true },
      confirmLabel: 'Use this folder',
      submit: ({ text }) => post('/settings', { backupsDir: text }),
    });
    if (!answer) return;
    saved = answer.out;
  }

  try {
    const out = saved || await post('/settings', { backupsDir: chosen });
    await renderBackups({ force: true });
    if (!out.restartRequired) {
      toast('Backups are kept there already.', 'good');
      return;
    }
    await ask({
      title: 'Restart SpawnLoft to use the new folder',
      text: backupsMoveWords(current, out.backupsDir).after,
      confirmLabel: 'Got it',
      tellOnly: true,
    });
  } catch (e) {
    toast(e.message, 'bad');
  }
}

/**
 * Snapshots for the selected server.
 *
 * Restore is the one action here that can destroy something, so it is the one with friction:
 * refused outright while the server is running, and gated behind typing the server's name
 * otherwise. The core refuses too - a page that only disables a button is not a guard.
 *
 * The page is three parts, top to bottom: whether this server backs itself up (and a backup now),
 * where backups go and what they leave out, and the history. Each setting is a control on a row;
 * the sentences that used to explain them are the line under each.
 */
let backupRequest = 0;
let backupPending = null;

function refreshVisibleBackups() {
  if (!document.hidden && state.view === 'server' && state.pane === 'backups') renderBackupsTool();
}
setInterval(refreshVisibleBackups, 4000);
document.addEventListener('visibilitychange', refreshVisibleBackups);
window.addEventListener('focus', refreshVisibleBackups);

/**
 * A row of the options card: what it is, a line about it that may wrap, and its controls at the
 * end. `meta` may be text or elements.
 */
function optionRow({ title, meta, end, data }) {
  const { h } = Kit;
  return h('div', { class: 'sl-row flex-wrap', dataset: data || null },
    h('span', { class: 'sl-row-main basis-72' },
      h('span', { class: 'sl-row-title whitespace-normal', text: title }),
      meta ? h('span', { class: 'sl-row-meta whitespace-normal' }, meta) : null),
    end && end.length ? h('span', { class: 'sl-row-end flex-wrap' }, end) : null);
}

async function renderBackups(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#backupsBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  const history = body.dataset.for === row.name && body.querySelector('[data-backup-history]');
  // A slow request must not accumulate polls. A deliberate mutation can supersede one;
  // its older answer then cannot replace the result of the action that just finished.
  if (!force && backupPending && backupPending.name === row.name) return;
  const request = ++backupRequest;
  backupPending = { name: row.name, request: request };
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;

  let data;
  try {
    // The history answers at once; the schedule, which needs Windows Task Scheduler, is asked for
    // separately below so the tab never waits on it.
    data = await api('/instances/' + encodeURIComponent(row.name) + '/backups/history');
  } catch (e) {
    if (request !== backupRequest || state.current !== row.name || body.dataset.for !== row.name) return;
    if (history && history.isConnected) {
      const status = body.querySelector('[data-backup-status]');
      status.textContent = 'Backup history could not refresh: ' + e.message + '. Trying again shortly.';
      status.hidden = false;
      return;
    }
    paneError(body, e.message, () => renderBackups({ force: true }));
    // Cleared, so leaving the tab and coming back tries again. Leaving it set cached the failure
    // as if it were the drawn pane, and the error stayed until the server was reselected.
    body.dataset.for = '';
    return;
  } finally {
    if (backupPending && backupPending.request === request) backupPending = null;
  }
  // The selection can move while the request is in flight; the answer to the old question is not
  // an answer to the new one.
  if (request !== backupRequest || state.current !== row.name || body.dataset.for !== row.name) return;
  const signature = JSON.stringify([data.snapshots, data.running, data.dir, data.root, data.mirror, data.pendingRoot, data.cleanCopies, data.exclude]);
  if (!force && history && history.isConnected) {
    const status = body.querySelector('[data-backup-status]');
    status.textContent = '';
    status.hidden = true;
    // Only the options and the history change in the background. The scope, the schedule's
    // controls, focus and a backup under way belong to the person using the page and must
    // survive a backup taken from the command line.
    if (history.dataset.backupHistory !== signature) {
      // the options are left as they are while someone is on one of them
      const options = body.querySelector('[data-backup-options]');
      if (options && !options.contains(document.activeElement)) {
        const fresh = backupOptions(row, data);
        options.replaceWith(fresh);
        lockRestoring(fresh, row.name);
      }
      history.replaceWith(renderBackupHistory(row, data, signature));
      const standing = body.querySelector('[data-backup-standing]');
      if (standing) paintBackupStanding(standing, row, data, standing.automatic);
      const auto = body.querySelector('[data-auto-backup]');
      if (auto && auto.paintLine) auto.paintLine(data);
    }
    return;
  }
  // ticks are for this visit: coming back to the tab later starts with none
  if (!force) pickedBackups.delete(row.name);
  body.textContent = '';
  paneHead(body, 'archive', 'Backups',
    'Back up now, put a backup back, or leave it to a schedule.');
  const { h } = Kit;
  const page = h('div', { class: 'flex flex-col gap-6' });
  const refreshStatus = h('p', { class: 'sl-error m-0', role: 'status', hidden: true, dataset: { backupStatus: '' } });
  body.append(page);

  const base = '/instances/' + encodeURIComponent(row.name) + '/backups';

  // ---- where this server stands ---------------------------------------------
  // Said first, as a banner, only when it is a worry: never backed up, or not for a week.
  const standing = h('div', { hidden: true, dataset: { backupStanding: '' } });

  // ---- automatic, and one now ----------------------------------------------
  // Drawn in two steps. The schedule lives in Windows Task Scheduler, and asking means starting
  // PowerShell - seconds on a cold machine. Nothing else here needs that answer, so the card and
  // the history appear at once and the schedule's controls fill in when the scheduler replies.
  const auto = autoBackupSection(row, base, data, null);
  const now = backUpNowPart(row, base, data);
  const top = Kit.card({ label: 'Automatic backups' }, auto, now);
  page.append(refreshStatus, standing, top, backupOptions(row, data), renderBackupHistory(row, data, signature));
  paintBackupStanding(standing, row, data, null);
  lockRestoring(body, row.name);
  let automatic;
  try {
    automatic = await api(base + '/auto');
  } catch (e) {
    automatic = { error: e.message };
  }
  // Only this card's own place is checked, not backupRequest: the history poll bumps that every
  // few seconds, and would otherwise stop a slow schedule answer from ever being shown.
  if (!auto.isConnected || state.current !== row.name || body.dataset.for !== row.name) return;
  auto.replaceWith(autoBackupSection(row, base, data, automatic));
  paintBackupStanding(standing, row, data, automatic);
  lockRestoring(body, row.name);
}

const SCOPE_LABELS = { standard: 'Standard', full: 'Everything', worlds: 'Worlds only', config: 'Settings only', plugins: 'Plugins and mods only' };
const scopeLabel = (sc) => SCOPE_LABELS[sc] || sc.charAt(0).toUpperCase() + sc.slice(1);

/** What each choice of "Back up now" takes, said under it and changed with it. */
function scopeWords(scope, running) {
  const words = {
    standard: 'Plugins and mods, every world in the folder, the settings files, and this server’s databases if they are running.',
    full: 'Everything in the server folder except caches and logs, and this server’s databases if they are running.',
    worlds: 'Every world in the folder, and nothing else.',
    config: 'server.properties and the other files in the server folder itself, and the config folder. Not the plugins’ own settings.',
    plugins: 'The plugins and mods folders, with their settings.',
  }[scope] || '';
  // the one file a running server holds locked is the only thing a running backup cannot read
  return words + (running && words ? ' Safe while the server runs: the one file it holds locked is left out.' : '');
}

/** "Back up now": what to take, and the button. Part of the top card. */
function backUpNowPart(row, base, data) {
  const { h } = Kit;
  const scope = Kit.select({
    label: 'What to back up',
    options: data.scopes.map((sc) => ({ value: sc, label: scopeLabel(sc) })),
    value: 'standard',
  });
  const box = scope.querySelector('select');
  box.dataset.backupScope = '';
  const said = h('p', { class: 'sl-hint m-0', role: 'status', text: scopeWords('standard', data.running) });
  box.addEventListener('change', () => { said.textContent = scopeWords(box.value, data.running); });
  const go = Kit.button({ label: 'Back up now', icon: 'archive', kind: 'primary' });
  go.dataset.backupNow = '';
  go.onclick = async () => {
    Kit.busy(go, true);
    go.dataset.holding = '1';
    const was = said.textContent;
    said.textContent = 'Backing up. A large world takes a minute or two.';
    try {
      const out = await post(base, { scope: box.value });
      const problems = out.problems || [];
      toast('Backup saved' + (out.mirrored ? ', with a second copy' : '') + (problems.length ? ', with something missing.' : '.'), problems.length ? undefined : 'good');
      for (const p of problems) toast(p, 'bad');
      if (out.mirrorError) toast(out.mirrorError, 'bad');
      // said as what it is: the backup worked, and these were not in it
      if (out.skipped?.length) toast('Left out, because the running server holds them open: ' + out.skipped.join(', ') + '.', undefined, { stay: true });
      if (out.saveOnWarning) toast(out.saveOnWarning, 'bad');
      said.textContent = was;
      Kit.busy(go, false);
      delete go.dataset.holding;
      await renderBackups({ force: true });
    } catch (e) {
      toast(e.message, 'bad');
      Kit.busy(go, false);
      delete go.dataset.holding;
      said.textContent = was;
    }
  };
  return h('div', { class: 'sl-card-part flex flex-wrap items-end gap-4' },
    h('div', { class: 'flex-1 basis-72 min-w-0 flex flex-col gap-2' },
      h('div', { class: 'flex flex-wrap items-center gap-3' },
        h('span', { class: 'type-body text-ink font-strong', text: 'Back up now' }),
        h('span', { class: 'w-56 max-w-full' }, scope)),
      said),
    go);
}

/** A backup in the sense of "the server is backed up": not the one-file copy an edit takes. */
// A backup of the server, as against a copy of its plugins, its config or a few files taken before
// a change. Only the first kind answers "when was this server last backed up".
function isWholeBackup(snap) {
  return !singleFileOf(snap) && !['files', 'plugins', 'config'].includes(snap.scope);
}

/**
 * How much the history holds: backups of the server on one side, and on the other the small copies
 * SpawnLoft keeps before it changes something (the core marks those, snap.copy).
 */
function backupTotals(snapshots) {
  const out = { whole: { count: 0, size: 0 }, copies: { count: 0, size: 0 } };
  for (const snap of snapshots || []) {
    const side = snap.copy ? out.copies : out.whole;
    side.count += 1;
    side.size += Number(snap.size) || 0;
  }
  return out;
}

/** The line under History: how many there are and what they take, which no row says. */
function historyWords(totals) {
  const many = (n, one, more) => n + ' ' + (n === 1 ? one : more);
  const whole = totals.whole.count
    ? many(totals.whole.count, 'backup', 'backups') + ', ' + fileSize(totals.whole.size)
    : 'No backups';
  if (!totals.copies.count) return whole + '.';
  return whole + '. ' + many(totals.copies.count, 'small copy', 'small copies') + ' kept before changes, ' + fileSize(totals.copies.size) + '.';
}

/**
 * Small copies old enough for the clean-up: what turning it on removes at once. The copy of
 * something deleted in Files is never one of them, since nothing else holds what was deleted.
 */
function copiesDue(snapshots, days, now) {
  const before = (now ?? Date.now()) - days * 24 * 3600 * 1000;
  return (snapshots || []).filter((s) => s.copy && s.label !== 'file-delete' && !s.locked && !s.note && new Date(s.mtime).getTime() < before);
}

/** What is asked before the clean-up is turned on: what it removes, what it never does, what goes now. */
function cleanCopiesQuestion(snapshots, days, now) {
  const due = copiesDue(snapshots, days, now);
  const size = due.reduce((n, s) => n + (Number(s.size) || 0), 0);
  return {
    title: 'Remove small copies after ' + days + ' days?',
    text: 'A small copy is what SpawnLoft keeps before it changes something: the plugins folder before an install or an update, a file before an edit or a replace. '
      + 'With this on, each time a backup or a copy is taken for this server, the small copies older than ' + days + ' days are removed. Undo in Activity is no longer offered for a change once its copy has gone. '
      + 'Never removed by this: a backup, a copy that is locked or has a note, and the copy of anything deleted in Files.'
      + (due.length
        ? ' ' + due.length + (due.length === 1 ? ' copy is' : ' copies are') + ' already that old (' + fileSize(size) + ') and ' + (due.length === 1 ? 'goes' : 'go') + ' now.'
        : ' Nothing is that old yet, so nothing goes now.'),
    remove: due.map((s) => s.name),
    confirmLabel: due.length ? 'Turn on and remove ' + due.length : 'Turn on',
    danger: due.length > 0,
  };
}

/** Beside the tick boxes: how many are ticked and what deleting them frees. */
function pickedWords(chosen) {
  if (!chosen.length) return '';
  const size = chosen.reduce((n, s) => n + (Number(s.size) || 0), 0);
  return chosen.length + ' selected, ' + fileSize(size);
}

/**
 * What is asked before several are deleted. It says when backups of the server are among them,
 * and when deleting them leaves the server with none.
 */
function deleteManyQuestion(chosen, snapshots) {
  const size = chosen.reduce((n, s) => n + (Number(s.size) || 0), 0);
  const copies = chosen.filter((s) => s.copy).length;
  const names = new Set(chosen.map((s) => s.name));
  // "no backup of this server" is about the ones that hold its worlds, not a Config only one
  const whole = chosen.filter(isWholeBackup).length;
  const wholeLeft = (snapshots || []).filter((s) => isWholeBackup(s) && !names.has(s.name)).length;
  const things = chosen.length === 1 ? 'this backup' : 'these ' + chosen.length;
  let mix = '';
  if (copies && copies < chosen.length) mix = ' ' + copies + (copies === 1 ? ' is a small copy' : ' are small copies') + ' kept before a change; the rest are not.';
  else if (copies) mix = copies === 1 ? ' It is a small copy kept before a change.' : ' All are small copies kept before changes.';
  return {
    title: chosen.length === 1 ? 'Delete this backup?' : 'Delete ' + chosen.length + ' backups?',
    text: fileSize(size) + ' in all.' + mix + ' What ' + (chosen.length === 1 ? 'it holds goes with it' : 'they hold goes with them') + ', second copies included, and there is no way back.'
      + (whole && !wholeLeft ? ' Deleting ' + things + ' leaves no backup of this server.' : ''),
    confirmLabel: chosen.length === 1 ? 'Delete backup' : 'Delete ' + chosen.length + ' backups',
    danger: true,
  };
}

/** What the toast says after several were deleted, with the ones that stayed and why. */
function deletedManyWords(out) {
  const n = (out.removed || []).length;
  const skipped = out.skipped || [];
  const locked = skipped.filter((s) => s.reason === 'locked').length;
  const busy = skipped.filter((s) => s.reason === 'busy').length;
  const gone = skipped.length - locked - busy;
  const parts = [n ? 'Deleted ' + n + (n === 1 ? ' backup' : ' backups') + ', ' + fileSize(out.size || 0) + ' freed.' : 'Nothing was deleted.'];
  if (locked) parts.push(locked + (locked === 1 ? ' is locked and stays.' : ' are locked and stay.'));
  if (busy) parts.push(busy + (busy === 1 ? ' is open in another program, or still downloading, and stays.' : ' are open in another program, or still downloading, and stay.'));
  if (gone) parts.push(gone + (gone === 1 ? ' was already gone.' : ' were already gone.'));
  return parts.join(' ');
}

/** Whether the history lists the small copies too. Off until asked for; kept while the panel is open. */
let showSmallCopies = false;
/** The backups ticked for deleting, by server, so a redraw of the list does not untick them. */
const pickedBackups = new Map();

/** The second line of the Backups strip when a task from Schedule, not this page's switch, backs the server up. */
function scheduledBackupWords(tasks) {
  const first = tasks[0];
  const rest = tasks.length - 1;
  return '“' + first.name + '” runs ' + describeSchedule(first.schedule)
    + (rest > 0 ? ', and ' + rest + ' more' : '') + '. Change it in Schedule.';
}

/** When this server was last backed up (a whole backup, not a small copy), as a time, or 0. */
function lastWholeBackup(snapshots) {
  return (snapshots || []).filter(isWholeBackup)
    .reduce((at, snap) => Math.max(at, new Date(snap.mtime).getTime() || 0), 0);
}

/**
 * The banner over the page when this server's backups are a worry: never backed up, or not for a
 * week. Nothing when they are fine: the card under it says when the last one was.
 * `automatic` is null while the scheduler is still being asked.
 */
function paintBackupStanding(box, row, data, automatic) {
  box.automatic = automatic;
  const latest = lastWholeBackup(data.snapshots);
  const week = 7 * 24 * 3600 * 1000;
  const stale = !latest || Date.now() - latest > week;
  const known = automatic && !automatic.error;
  const on = known && automatic.auto && automatic.auto.enabled !== false;
  const said = stale ? (latest ? 'No backup in a week' : 'Never backed up') : '';
  // repainted only when what it says changes, so a screen reader hears it once
  if (box.dataset.said === said) return;
  box.dataset.said = said;
  box.replaceChildren();
  // an empty box would still take its place in the page's gaps
  box.hidden = !stale;
  if (!stale) return;
  box.append(Kit.banner({
    tone: 'warn',
    title: said,
    text: (latest ? 'The last whole backup was ' + ago(new Date(latest).toISOString()) + '. ' : 'Nothing of this server is kept anywhere yet. ')
      + (on ? 'Automatic backups are on and will take one at the next run.' : 'Back up now, or turn on automatic backups below.'),
  }));
}

const KEEP_SCHEDULE = '__as-it-is';

/** Why the "keeping" number cannot be saved, or null. The schedule keeps between 1 and 365. */
function keepProblem(value, emptyKeepsAll) {
  const text = String(value).trim();
  // left empty on a task that already keeps everything: it goes on keeping everything
  if (!text && emptyKeepsAll) return null;
  const n = Number(text);
  if (!text || !Number.isInteger(n) || n < 1 || n > 365) return 'Use a whole number from 1 to 365.';
  return null;
}

/** The line beside the switch: what happens now, and when the last backup was. */
function autoLine(data, automatic, latest) {
  const last = latest ? ' Last backup ' + ago(new Date(latest).toISOString()) + '.' : '';
  if (!automatic) return 'Checking whether this server backs itself up…';
  if (automatic.error) return 'Could not read the schedule: ' + automatic.error;
  if (automatic.automaticAvailable === false) return automatic.automaticUnavailableReason;
  const on = automatic.auto && automatic.auto.enabled !== false;
  if (on) {
    const next = whenNext(automatic.auto.nextRun);
    const ran = automatic.auto.lastResult ? ' Last run: ' + automatic.auto.lastResult + '.' : '';
    return 'On.' + (next ? ' Next ' + next + '.' : '') + last + ran;
  }
  if (automatic.scheduled && automatic.scheduled.length) return 'Backed up by Schedule: ' + scheduledBackupWords(automatic.scheduled) + last;
  return 'Off. Nothing backs this server up unless you do it by hand.' + last;
}

/**
 * The switch, how often and how many to keep: one row, each a control that saves itself. `automatic`
 * is null while Task Scheduler is being asked, and carries `error` if asking failed; either way
 * the controls are drawn but cannot be used.
 */
function autoBackupSection(row, base, data, automatic) {
  const { h } = Kit;
  const known = automatic && !automatic.error ? automatic : {};
  const settled = Boolean(automatic) && !automatic.error && automatic.automaticAvailable !== false;
  const on = Boolean(known.auto) && known.auto.enabled !== false;

  const sw = Kit.toggle({ label: 'Automatic backups', checked: on, disabled: !settled });
  const onOff = sw.querySelector('input');
  // the switch's words are the row's title; a screen reader still hears its name
  sw.querySelector('.sl-choice-text').classList.add('sl-sr');
  onOff.setAttribute('aria-label', 'Automatic backups');
  onOff.dataset.autoBackups = '';
  const line = h('span', { class: 'sl-row-meta whitespace-normal', role: 'status', text: autoLine(data, automatic, lastWholeBackup(data.snapshots)) });

  const every = Kit.select({
    label: 'How often',
    options: AUTO_INTERVALS.map((opt) => ({
      value: opt.label,
      // the label is the choice's key; what is shown says the time this computer's way
      label: opt.schedule.at ? opt.label.replace(opt.schedule.at, clockWords(opt.schedule.at)) : opt.label,
    })),
    value: known.auto ? (AUTO_INTERVALS.find((o) => sameSchedule(o.schedule, known.auto.schedule)) || {}).label : 'Daily at 03:00',
  });
  const everyBox = every.querySelector('select');
  // A schedule made elsewhere (daily at 04:30, say) matches none of the choices. Without a choice
  // of its own the list would show the first one, "Every hour", and a change would save that.
  if (known.auto && !AUTO_INTERVALS.some((opt) => sameSchedule(opt.schedule, known.auto.schedule))) {
    everyBox.prepend(h('option', { value: KEEP_SCHEDULE, text: capital(describeSchedule(known.auto.schedule)) + ' (as it is now)', selected: true }));
    everyBox.value = KEEP_SCHEDULE;
  }

  // A task that keeps everything (made elsewhere) shows as that, not as 7: a change would otherwise
  // start deleting its older backups for someone who only changed the time.
  const keepsAll = Boolean(known.auto) && known.auto.keep == null;
  const keep = Kit.input({ type: 'number', value: keepsAll ? '' : String((known.auto && known.auto.keep) || 7), placeholder: keepsAll ? 'all' : null });
  keep.min = '1';
  keep.max = '365';
  keep.classList.add('w-24');
  const keepField = Kit.field({ label: 'Keep the newest', control: keep, hint: 'Automatic ones only. Backups you make by hand are never removed.' });
  const everyField = Kit.field({ label: 'How often', control: every });
  for (const c of [everyBox, keep]) c.disabled = !settled;

  const head = h('div', { class: 'flex flex-wrap items-center gap-4' },
    sw,
    h('span', { class: 'sl-row-main flex-1 basis-72' },
      h('span', { class: 'sl-row-title type-card', text: 'Automatic backups' }), line),
    Kit.help({ label: 'automatic backups', text: ['They are held by ' + schedulerName + ', so they run with SpawnLoft closed.', schedulerHint] }));
  // Changing how often or how many waits for Save: a drop-down moved with the arrow keys
  // changes on every press, and each save redraws the page.
  const apply = Kit.button({ label: 'Save', size: 'sm', kind: 'primary' });
  apply.setAttribute('aria-label', 'Save how often and how many to keep');
  apply.hidden = true;
  const controls = h('div', { class: 'flex flex-wrap items-end gap-4' }, h('div', { class: 'w-64 max-w-full' }, everyField), h('div', { class: 'max-w-80' }, keepField), h('div', { class: 'pb-6' }, apply));
  // Off and nobody asked: the switch is the one control that matters, the rest wait for it.
  controls.hidden = !on;
  const part = h('div', { class: 'flex flex-col gap-4', dataset: { autoBackup: '' } }, head, controls);
  // a backup from elsewhere moves "last backup", without redrawing the controls
  part.paintLine = (fresh) => { if (!saving) line.textContent = autoLine(fresh, automatic, lastWholeBackup(fresh.snapshots)); };
  const lingering = lingerNotice(known.background, () => renderBackups({ force: true }));
  if (lingering) part.append(lingering);

  let saving = false;
  async function save(why) {
    // an empty or impossible number used to be saved as "keep everything", with a toast that said scheduled
    const problem = onOff.checked ? keepProblem(keep.value, keepsAll) : null;
    keepField.setError(problem);
    if (problem) { keep.focus(); return; }
    if (saving) return;
    saving = true;
    for (const c of [onOff, everyBox, keep, apply]) Kit.busy(c, true);
    line.textContent = onOff.checked ? 'Saving…' : 'Turning off…';
    try {
      const chosen = everyBox.value === KEEP_SCHEDULE ? { schedule: known.auto.schedule } : AUTO_INTERVALS.find((o) => o.label === everyBox.value);
      await post(base + '/auto', onOff.checked
        ? { enabled: true, schedule: chosen.schedule, keep: keep.value.trim() ? Number(keep.value) : null }
        : { enabled: false });
      toast(!onOff.checked ? 'Automatic backups turned off.' : why === 'switch' ? 'Automatic backups are on.' : 'Automatic backups changed.', 'good');
      await renderBackups({ force: true });
      // the redraw is a new page: the place someone was working stays where it was
      const back = $('#backupsBody [data-auto-backup] ' + (why === 'switch' ? '[data-auto-backups]' : 'select'));
      if (back) back.focus();
    } catch (e) {
      toast(e.message, 'bad');
      for (const c of [onOff, everyBox, keep, apply]) Kit.busy(c, false);
      onOff.checked = on;
      controls.hidden = !on;
      line.textContent = autoLine(data, automatic, lastWholeBackup(data.snapshots));
    } finally {
      saving = false;
    }
  }
  onOff.addEventListener('change', () => { controls.hidden = !onOff.checked; save('switch'); });
  everyBox.addEventListener('change', () => { apply.hidden = false; });
  keep.addEventListener('input', () => { apply.hidden = false; keepField.setError(keep.value.trim() ? keepProblem(keep.value, keepsAll) : null); });
  apply.onclick = () => save('every');
  keep.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save('every'); } });
  return part;
}

/** Where backups go, a second copy, small copies, and what they leave out: one row each. */
function backupOptions(row, data) {
  const { h } = Kit;
  const base = '/instances/' + encodeURIComponent(row.name) + '/backups';
  const rows = [];

  // ---- where ----------------------------------------------------------------
  const change = Kit.button({ label: 'Change', size: 'sm' });
  change.setAttribute('aria-label', 'Change where backups are kept');
  change.onclick = () => changeBackupsLocation(data.root);
  const whereEnd = [change];
  const whereMeta = [h('span', { class: 'block font-mono text-1 text-ink-3 break-all', text: data.dir }), 'For every server.'];
  // A change that is saved but waiting for a restart is said here, with the way back.
  if (data.pendingRoot) {
    whereMeta.push(h('span', { class: 'block text-warn-ink', role: 'status', text: backupsMoveWords(data.root, data.pendingRoot).pending }));
    const undo = Kit.button({ label: 'Keep the current folder', size: 'sm' });
    undo.onclick = async () => {
      Kit.busy(undo, true);
      try {
        await post('/settings', { backupsDir: data.root });
        toast('Backups stay in ' + data.root + '.', 'good');
        await renderBackups({ force: true });
      } catch (e) { toast(e.message, 'bad'); Kit.busy(undo, false); }
    };
    whereEnd.push(undo);
  }
  rows.push(optionRow({ title: 'Where backups are kept', meta: whereMeta, end: whereEnd }));

  // ---- the mirror ---------------------------------------------------------------
  // A second drive every backup is copied to as it is taken. Its absence is stated as the risk it
  // is, because servers and backups on one disk fail together.
  const mset = Kit.button({ label: data.mirror ? 'Change' : 'Add a second copy', size: 'sm' });
  mset.setAttribute('aria-label', data.mirror ? 'Change where the second copy goes' : 'Add a second copy');
  const mirrorEnd = [mset];
  if (data.mirror) {
    const moff = Kit.button({ label: 'Turn off', size: 'sm', kind: 'ghost' });
    moff.setAttribute('aria-label', 'Turn off the second copy');
    moff.onclick = async () => {
      Kit.busy(moff, true);
      try {
        await post('/settings', { backupsMirrorDir: '' });
        toast('Second copies turned off. The ones already made stay where they are.', 'good');
        await renderBackups({ force: true });
      } catch (e) { toast(e.message, 'bad'); Kit.busy(moff, false); }
    };
    mirrorEnd.push(moff);
  }
  mset.onclick = async () => {
    let chosen = null;
    let saved = null; // the answer, when the dialog itself did the saving
    if (desktop) {
      chosen = await desktop.pickFolder('Where should the second copy of each backup go? Ideally another drive.');
      if (!chosen) return;
    } else {
      const answer = await ask({
        title: 'Copy backups to a second place',
        text: 'Every new backup, for every server, is copied there as it is taken - ideally on '
          + 'a different drive, so one disk failure cannot take the servers and their backups '
          + 'together. When old backups are cleared, their second copies go too.',
        input: { label: 'Full path to a folder', value: data.mirror || '', placeholder: examplePath(panelPlatform, 'backups'), required: true },
        confirmLabel: 'Use this folder',
        submit: ({ text }) => post('/settings', { backupsMirrorDir: text }),
      });
      if (!answer) return;
      saved = answer.out;
    }
    try {
      const out = saved || await post('/settings', { backupsMirrorDir: chosen });
      toast('New backups are now also copied to ' + out.backupsMirrorDir + '. Backups taken before now are not copied.', 'good');
      await renderBackups({ force: true });
    } catch (e) { toast(e.message, 'bad'); }
  };
  rows.push(optionRow({
    title: 'Second copy on another drive',
    meta: data.mirror
      ? [h('span', { class: 'block font-mono text-1 text-ink-3 break-all', text: data.mirror }), 'Every new backup, for every server, is copied there too.']
      : 'Off. Backups sit on the same drive as the servers, so one disk failure can take both.',
    end: mirrorEnd,
  }));

  // ---- small copies ---------------------------------------------------------------
  const keepCopies = Kit.select({
    label: 'Small safety copies',
    options: [{ value: 'keep', label: 'Keep until I delete them' }, { value: 'clean', label: 'Remove after ' + data.copyDays + ' days' }],
    value: data.cleanCopies ? 'clean' : 'keep',
  });
  const copiesBox = keepCopies.querySelector('select');
  copiesBox.dataset.cleanCopies = '';
  copiesBox.addEventListener('change', async () => {
    const back = () => { copiesBox.value = data.cleanCopies ? 'clean' : 'keep'; };
    if (copiesBox.value === 'keep') {
      Kit.busy(copiesBox, true);
      try {
        await post(base + '/clean-copies', { on: false });
        toast('Small copies are kept until you delete them.', 'good');
        await renderBackups({ force: true });
      } catch (e) { toast(e.message, 'bad'); Kit.busy(copiesBox, false); back(); }
      return;
    }
    const { remove, ...question } = cleanCopiesQuestion(data.snapshots, data.copyDays);
    const got = await ask({
      ...question,
      // only the ones this question counted go now; the server checks each again
      submit: () => post(base + '/clean-copies', { on: true, remove }),
    });
    if (!got) { back(); return; }
    const gone = (got.out && got.out.removed) || [];
    toast('Small copies older than ' + data.copyDays + ' days are now removed as new ones are taken.'
      + (gone.length ? ' ' + gone.length + ' went now, ' + fileSize(got.out.size || 0) + ' freed.' : '')
      + (gone.length < remove.length ? ' ' + (remove.length - gone.length) + ' could not be removed yet.' : ''), gone.length < remove.length ? 'bad' : 'good');
    await renderBackups({ force: true });
  });
  rows.push(optionRow({
    title: 'Small safety copies',
    meta: 'Made before a plugin install or update, and before a file is edited, replaced or deleted. Undo in Activity uses them.',
    end: [h('span', { class: 'w-56 max-w-full' }, keepCopies)],
  }));

  // ---- left out -------------------------------------------------------------------
  // What this server's backups skip: a map plugin's rendered tiles, logs a plugin keeps. Applies
  // to every backup - by hand, on a schedule, before an upgrade - and never to the copy a file
  // edit takes, which exists to hold exactly that file.
  const exclude = data.exclude || [];
  const edit = Kit.button({ label: 'Edit', size: 'sm' });
  edit.setAttribute('aria-label', 'Edit what backups leave out');
  edit.onclick = async () => {
    const text = Kit.textarea({ value: exclude.join('\n'), placeholder: 'plugins/dynmap/web\n*.log', mono: true, rows: 6 });
    text.spellcheck = false;
    const field = Kit.field({ label: 'Paths to leave out, one per line', control: text, hint: 'From the server folder. * matches anything. Big things that rebuild themselves are the usual ones, such as a web map’s tiles.' });
    const got = await ask({
      title: 'Leave out of backups',
      text: 'Every backup of this server skips these, automatic ones included. A restore cannot bring back what was left out.',
      detail: field,
      confirmLabel: 'Save',
      submit: () => post(base + '/exclude', { patterns: text.value }),
    });
    if (!got) return;
    const n = got.out.exclude.length;
    toast(n ? 'Backups will leave out ' + n + (n === 1 ? ' path.' : ' paths.') : 'Backups leave nothing out.', 'good');
    await renderBackups({ force: true });
  };
  rows.push(optionRow({
    title: 'Left out of backups',
    meta: exclude.length
      ? h('span', { class: 'font-mono text-1 break-all', text: exclude.join(', ') })
      : 'Nothing. Every backup takes all of what it covers.',
    end: [edit],
  }));

  return h('section', { class: 'flex flex-col gap-3', 'aria-label': 'Backup options', dataset: { backupOptions: '' } },
    h('h2', { class: 'm-0 type-section text-ink', text: 'Options' }),
    h('div', { class: 'sl-list' }, rows));
}

// A restore in progress, by server or database name, and the backup it is putting back. While
// one runs every button in its list is off and the row says so: a second restore, a delete or a
// new backup pressed on top of it is how a world is lost, and a toast that leaves after five
// seconds says nothing about a job that runs for minutes. The API refuses those as well; this is
// so nobody has to find that out.
const restoring = new Map();
function lockRestoring(scope, owner) {
  const which = restoring.get(owner);
  if (!which || !scope) return;
  for (const b of scope.querySelectorAll('button, select, input')) {
    b.disabled = true;
    b.title = 'Wait for the restore to finish';
  }
  for (const line of scope.querySelectorAll('[data-backup-name]')) {
    if (line.dataset.backupName !== which || line.hasAttribute('data-restoring')) continue;
    line.setAttribute('data-restoring', '');
    line.setAttribute('aria-busy', 'true');
    const when = line.querySelector('[data-when]');
    if (when) {
      when.setAttribute('role', 'status');
      when.textContent = 'Restoring this one… it can take a few minutes.';
    }
  }
}

/**
 * What the Restore dialog may promise about the copy kept first. The copy holds the files the
 * backup lists, as they are now. A backup that lists nothing (made by hand, or by an old version)
 * gets no copy, and the databases a backup carries are never in it: both are said, not implied.
 */
function restoreWords(snap) {
  const files = (snap.members || []).some((m) => m !== 'databases');
  const dbs = (snap.databases || []).length > 0;
  return {
    copy: files
      ? 'A copy of the files as they are now is kept in this list first.'
      : 'This backup does not record what it holds, so no copy of how things are now can be kept.',
    note: dbs ? ' The databases are not part of the copy kept first: back them up from their own page if you may want them back.' : '',
  };
}

/** What a backup holds, in a word or two: "Standard", "one file", "Plugins and mods only". */
function backupKindWords(snap) {
  const onlyFile = singleFileOf(snap);
  const fromFiles = FILES_SNAPSHOT[snap.label] && snap.scope === 'files' ? FILES_SNAPSHOT[snap.label] : null;
  // An archive with no manifest (made by hand, or by an old version) reports its scope as "?".
  const unknown = !fromFiles && !onlyFile && (!snap.scope || snap.scope === '?');
  const kind = fromFiles ? capital(fromFiles.tag) : onlyFile ? 'One file' : unknown ? 'Contents not recorded' : scopeLabel(snap.scope);
  const dbs = (snap.databases || []).length;
  return kind + (dbs ? ' + ' + (dbs === 1 ? 'database' : dbs + ' databases') : '');
}

/**
 * One backup in a list, the server's or a database's: when, what and why, its size, Restore, and
 * the rest under a menu. `extra` adds lines under the title; `menu` is the menu's items.
 */
function backupRow({ snap, title, lines, kind, size, restore, menu, picker }) {
  const { h } = Kit;
  const opener = menu && menu.length ? Kit.menu({ icon: 'dots', kind: 'ghost', title: 'More for ' + title, items: menu }) : null;
  if (opener) opener.querySelector('button').classList.add('sl-btn-icon', 'sl-btn-sm');
  return h('div', { class: 'sl-row flex-wrap items-start @wide/pane:flex-nowrap', dataset: { backupName: snap.name } },
    picker || null,
    h('span', { class: 'sl-row-main basis-80' },
      h('span', { class: 'sl-row-title whitespace-normal', dataset: { when: '' }, text: title }),
      lines),
    h('span', { class: 'sl-row-end flex-wrap' },
      kind ? h('span', { class: 'sl-pill', text: kind }) : null,
      h('span', { class: 'w-20 text-right font-mono text-2 text-ink-2', text: size }),
      restore || null,
      opener));
}

function renderBackupHistory(row, data, signature) {
  const { h } = Kit;
  const base = '/instances/' + encodeURIComponent(row.name) + '/backups';
  const hist = h('section', { class: 'flex flex-col gap-3', 'aria-label': 'History', dataset: { backupHistory: signature } });
  // how many and how much: the count alone said nothing about the disk they take
  const totals = backupTotals(data.snapshots);
  const redraw = () => { if (hist.isConnected) hist.replaceWith(renderBackupHistory(row, data, signature)); };
  // Small copies are out of the list until asked for: forty one-file copies hid the four backups.
  const shown = data.snapshots.filter((s) => showSmallCopies || !s.copy);
  if (!pickedBackups.has(row.name)) pickedBackups.set(row.name, new Set());
  const picked = pickedBackups.get(row.name);
  // a tick on something that is no longer listed, or is locked now, is not a tick
  for (const name of [...picked]) {
    if (!shown.some((s) => s.name === name && !s.locked)) picked.delete(name);
  }
  let toggle = null;
  if (totals.copies.count) {
    toggle = Kit.button({ label: (showSmallCopies ? 'Hide small copies (' : 'Show small copies (') + totals.copies.count + ')', size: 'sm', kind: 'ghost' });
    toggle.dataset.showCopies = '';
    toggle.setAttribute('aria-pressed', String(showSmallCopies));
    toggle.onclick = () => {
      showSmallCopies = !showSmallCopies;
      redraw();
      const again = $('#backupsBody [data-show-copies]');
      if (again) again.focus();
    };
  }
  hist.append(h('div', { class: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
    h('h2', { class: 'm-0 type-section text-ink', text: 'History' }),
    h('span', { class: 'flex-1 type-meta text-ink-3', text: data.snapshots.length ? historyWords(totals) : '' }),
    toggle));
  // Restore is off while the server runs, and only a tip on a button that cannot take focus said why
  if (data.running && data.snapshots.length) hist.append(h('p', { class: 'sl-hint m-0', text: 'Stop the server to restore a backup. Everything else here works while it runs.' }));

  if (!data.snapshots.length) {
    hist.append(Kit.empty({ icon: 'archive', title: 'No backups yet', text: 'Back up now, or turn on automatic backups. Reset and delete each take one by themselves before they run, so this also fills up on its own.' }));
    lockRestoring(hist, row.name);
    return hist;
  }
  if (!shown.length) {
    hist.append(Kit.empty({ icon: 'archive', title: 'No backups', text: 'What is here is small copies kept before changes. Show small copies lists them.' }));
    lockRestoring(hist, row.name);
    return hist;
  }

  // ---- several at once ------------------------------------------------------
  const allBox = Kit.checkbox({ label: 'Select all' });
  const all = allBox.querySelector('input');
  all.dataset.pickAll = '';
  const said = h('span', { class: 'flex-1 type-meta text-ink-3', role: 'status' });
  const dropMany = Kit.button({ label: 'Delete selected', kind: 'danger', size: 'sm' });
  dropMany.dataset.deleteMany = '';
  hist.append(h('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-2 min-h-8' }, allBox, said, dropMany));
  const free = shown.filter((s) => !s.locked);
  const chosenNow = () => shown.filter((s) => picked.has(s.name));
  const paintBar = () => {
    const chosen = chosenNow();
    said.textContent = pickedWords(chosen);
    dropMany.hidden = !chosen.length;
    all.disabled = !free.length;
    all.checked = free.length > 0 && chosen.length === free.length;
    all.indeterminate = chosen.length > 0 && chosen.length < free.length;
    allBox.title = free.length ? '' : 'Every backup here is locked';
  };
  all.onchange = () => {
    const on = all.checked;
    for (const s of free) {
      if (on) picked.add(s.name); else picked.delete(s.name);
    }
    for (const box of hist.querySelectorAll('[data-pick]:not(:disabled)')) box.checked = on;
    paintBar();
  };
  dropMany.onclick = async () => {
    const chosen = chosenNow();
    if (!chosen.length) return;
    const got = await ask({
      ...deleteManyQuestion(chosen, data.snapshots),
      submit: () => post(base + '/delete-many', { snapshots: chosen.map((s) => s.name) }),
    });
    if (!got) return;
    picked.clear();
    const out = got.out || {};
    toast(deletedManyWords(out), (out.removed || []).length && !(out.skipped || []).length ? 'good' : 'bad');
    await renderBackups({ force: true });
  };

  const rows = shown.map((snap) => {
    const which = backupWords(snap);
    const pick = h('input', { type: 'checkbox', class: 'sl-check mt-1', dataset: { pick: '' }, 'aria-label': 'Select ' + which });
    pick.disabled = Boolean(snap.locked);
    if (snap.locked) pick.title = 'Locked. Unlock it first.';
    pick.checked = picked.has(snap.name);
    pick.onchange = () => {
      if (pick.checked) picked.add(snap.name); else picked.delete(snap.name);
      paintBar();
    };

    const lines = [];
    if (snap.note) lines.push(h('span', { class: 'type-body text-ink font-strong whitespace-normal', text: '“' + snap.note + '”' }));
    // An AI assistant snapshots the one file it is about to change, and the Files tool what it is
    // about to edit, replace or delete. Each says which, so it does not read as a whole backup.
    const onlyFile = singleFileOf(snap);
    const fromFiles = FILES_SNAPSHOT[snap.label] && snap.scope === 'files' ? FILES_SNAPSHOT[snap.label] : null;
    const onlyWhat = onlyFile || (fromFiles ? describeMembers(snap.members) : null);
    if (onlyWhat) {
      lines.push(h('span', {
        class: 'sl-row-meta',
        text: 'Only ' + onlyWhat + (fromFiles ? ', ' + fromFiles.why : snap.label === 'before-edit' ? ', as it was before an AI assistant changed it' : ''),
      }));
    }
    const n = (snap.members || []).length;
    const age = ago(snap.mtime);
    lines.push(h('span', { class: 'sl-row-meta whitespace-normal' },
      [age, snapshotReason(snap), n && !onlyWhat ? n + (n === 1 ? ' item' : ' items') : null, snap.locked ? 'Locked' : null].filter(Boolean).join(' · '),
      h('span', { class: 'block font-mono text-1 text-ink-4 truncate', text: snap.name })));
    // A backup that is missing a database, or may hold a half-written world, says so on its row:
    // the moment that matters is the restore, long after the toast that reported it has gone.
    if (snap.problems && snap.problems.length) {
      lines.push(h('span', { class: 'flex items-start gap-2 type-meta text-warn-ink whitespace-normal' }, Kit.icon('alert', 'mt-0.5 shrink-0'), snap.problems.join(' ')));
    }

    const restore = Kit.button({ label: 'Restore', icon: 'restore', size: 'sm' });
    restore.setAttribute('aria-label', 'Restore ' + which);
    restore.disabled = data.running;
    restore.title = data.running ? 'Stop the server first' : 'Put this backup back over the server files';
    restore.onclick = () => restoreBackup(row, base, snap, hist);

    const menu = [
      { label: snap.locked ? 'Unlock' : 'Lock', note: snap.locked ? 'Delete and clean-up can remove it again.' : 'Nothing deletes it, by hand or automatically.', onSelect: () => lockBackup(base, snap) },
      { label: snap.note ? 'Change its note' : 'Add a note', onSelect: () => noteBackup(base, snap) },
      { label: 'Download', note: 'A .tar.gz file. 7-Zip, Finder or tar opens it.', onSelect: () => downloadFile('/api' + base + '/download?snapshot=' + encodeURIComponent(snap.name), snap.name) },
      'sep',
      { label: 'Delete', tone: 'fault', disabled: Boolean(snap.locked), note: snap.locked ? 'Locked. Unlock it first.' : null, onSelect: () => deleteBackup(base, snap) },
    ];
    return backupRow({ snap, title: stamp(snap.mtime), lines, kind: backupKindWords(snap), size: snap.sizeHuman, restore, menu, picker: pick });
  });
  hist.append(Kit.list(rows, 'Backups'));
  paintBar();
  lockRestoring(hist, row.name);
  return hist;
}

/** A file from the panel, saved the way a link to it is: the browser's, or the app's, save dialog. */
function downloadFile(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

async function lockBackup(base, snap) {
  try {
    await post(base + '/lock', { snapshot: snap.name, locked: !snap.locked });
    toast(snap.locked ? 'Unlocked. Delete and clean-up can remove it again.' : 'Locked. Nothing deletes it until you unlock it.', 'good');
    await renderBackups({ force: true });
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function noteBackup(base, snap) {
  const got = await ask({
    title: 'A note for this backup',
    text: 'A few words saying what it is - "before the 1.21 upgrade". Empty removes it.',
    input: { label: 'Note', value: snap.note || '', placeholder: 'before the 1.21 upgrade' },
    confirmLabel: 'Save',
    submit: ({ text }) => post(base + '/note', { snapshot: snap.name, note: text }),
  });
  if (got) await renderBackups({ force: true });
}

async function deleteBackup(base, snap) {
  const ok = await ask({
    title: 'Delete this backup?',
    text: backupWords(snap, true) + ', ' + snap.sizeHuman + '. What it holds goes with it, its second copy too.',
    confirmLabel: 'Delete backup',
    danger: true,
  });
  if (!ok) return;
  try {
    await post(base + '/delete', { snapshot: snap.name });
    toast('Deleted ' + backupWords(snap) + '.', 'good');
    await renderBackups({ force: true });
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function restoreBackup(row, base, snap, hist) {
  const covers = describeMembers(snap.members);
  const dbs = snap.databases && snap.databases.length
    ? ' The database dump' + (snap.databases.length > 1 ? 's' : '') + ' it holds ('
      + snap.databases.map((d) => d.database + ' on ' + d.service).join(', ')
      + ') are imported too, which needs that database running.'
    : '';
  const left = snap.excluded && snap.excluded.length
    ? ' It was taken leaving out ' + snap.excluded.join(', ') + ', which it cannot bring back.'
    : '';
  const flawed = snap.problems && snap.problems.length ? ' Note: ' + snap.problems.join(' ') : '';
  const words = restoreWords(snap);
  const ok = await ask({
    title: 'Restore into ' + (row.label || row.name) + '?',
    text: 'This puts back ' + covers + ' from ' + backupWords(snap)
      + '. Anything changed since then is overwritten.' + left + dbs + flawed
      + words.note,
    choices: [
      { value: 'over', label: 'Put it back over what is there', hint: 'Anything added since - a new plugin, chunks explored since - stays. ' + words.copy },
      { value: 'clean', label: 'Clear first, so it ends up exactly as the backup was', hint: 'What it holds is removed, then put back. ' + words.copy },
    ],
    confirmLabel: 'Restore',
    danger: true,
    typeToConfirm: row.name,
  });
  if (!ok) return;
  const note = toast('Restoring ' + backupWords(snap) + '…');
  restoring.set(row.name, snap.name);
  lockRestoring($('#backupsBody').dataset.for === row.name ? $('#backupsBody') : hist, row.name);
  const send = (withoutCopy) => post(base + '/restore', { snapshot: snap.name, clean: ok.choice === 'clean', withoutCopy: withoutCopy });
  try {
    let out;
    try {
      out = await send(false);
    } catch (e) {
      // The copy could not be kept, usually a full disk. Nothing has changed; going ahead
      // without it is a second, separate yes.
      if (e.code !== 'no-copy') throw e;
      const sure = await ask({
        title: 'Restore without keeping a copy?',
        text: e.message + ' Restoring now overwrites what is there with no way back.',
        confirmLabel: 'Restore without a copy',
        danger: true,
        typeToConfirm: row.name,
      });
      if (!sure) { note.remove(); return; }
      out = await send(true);
    }
    if (out.safety) toast('How it was before is kept as ' + backupNamesToWords(out.safety) + ', in this list.', 'good');
    note.remove();
    const imported = (out.databases && out.databases.imported) || [];
    const skipped = (out.databases && out.databases.skipped) || [];
    toast('Restored ' + backupWords(snap) + (imported.length ? ', with ' + imported.length + ' database' + (imported.length > 1 ? 's' : '') + ' imported' : '') + '.', 'good');
    for (const d of skipped) toast('Database ' + d.database + ' not imported: ' + d.reason, 'bad');
  } catch (e) {
    note.remove();
    toast(e.message, 'bad');
  } finally {
    restoring.delete(row.name);
    // only when this server's Backups is still what is on screen; elsewhere the next visit draws it
    if (state.current === row.name) await renderBackups({ force: true });
  }
}

/**
 * The server's own settings: one form, its sections listed down the side.
 *
 * <p>These were a modal dialog until the panel grew tabs, then a wall of cards. A form reads top to
 * bottom and says, row by row, what is still Minecraft's default and what has been changed and not
 * saved - which the cards left to be remembered. The sections are listed beside it with a dot on
 * any that holds an unsaved change, so a long form does not hide what is waiting in it.
 *
 * <p>Fields come from what the API says is editable rather than from a list kept here, so the panel
 * and the core cannot drift about what exists or what a field will accept. The whole file is one
 * more entry in the list, for the keys the form does not cover.
 */
let settingsRender = null;
/** What Settings holds unsaved, as { name, count }, or null. Each drawing of the page replaces it. */
let settingsWaiting = () => null;

/** Whether any of these changed settings waits for the next start. Ones marked live do not. */
function needsRestart(changed) {
  return changed.some((e) => !e.live);
}

/** What the toast says after a save: a restart is asked for only when one would do something. */
function savedWords(count, opts) {
  const { running, needsRestart: needed, restarting, name } = opts;
  const saved = 'Saved ' + count + (count === 1 ? ' setting' : ' settings');
  if (!needed) return saved + '. In force now.';
  if (!running || restarting) return saved + '.';
  return saved + '. Restart ' + name + ' to apply.';
}

async function renderServerSettings() {
  const row = rowOf(state.current);
  const body = $('#settingsBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (isDb(row)) { body.classList.remove('set-screen'); return renderDatabaseSettings(row); }

  // Re-rendering under someone mid-edit would silently discard what they had typed. A caller that
  // arrives while the file is still being read gets the read in progress, so awaiting this means
  // the form is there.
  if (body.dataset.for === row.name && body.childElementCount) return settingsRender;
  settingsRender = buildServerSettings(row, body);
  return settingsRender;
}

/** The one ResizeObserver the settings form keeps on its pane; replaced when the form is rebuilt. */
let settingsPaneWatch = null;

async function buildServerSettings(row, body) {
  body.dataset.for = row.name;
  body.classList.add('set-screen');
  paneLoading(body);

  const base = '/instances/' + encodeURIComponent(row.name);
  let data;
  try {
    data = await api(base + '/props');
  } catch (e) {
    paneError(body, e.message, () => renderServerSettings());
    // Cleared, so leaving the tool and coming back tries again. Leaving it set cached the failure
    // as if it were the drawn form, and the error stayed until the server was reselected.
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== row.name) return; // switched servers while the fetch was in flight
  body.textContent = '';
  paneHead(body, 'sliders', 'Server settings', 'server.properties, and how SpawnLoft runs this server.');

  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };

  const nav = el('nav', 'set-nav');
  nav.setAttribute('aria-label', 'Settings sections');
  const form = el('div', 'set-form');
  const rawView = el('div', 'set-raw');
  rawView.hidden = true;
  body.append(nav, form, rawView);

  // ---- sections and the list of them ------------------------------------------

  const navButtons = new Map();
  const addNav = (key, title, target) => {
    const b = el('button');
    b.type = 'button';
    b.dataset.section = key;
    const word = el('span');
    word.textContent = title;
    const dot = el('span', 'dot');
    dot.hidden = true;
    dot.setAttribute('aria-hidden', 'true');
    b.append(word, dot);
    b.onclick = () => {
      showRaw(false);
      showSection(key);
    };
    nav.append(b);
    navButtons.set(key, { button: b, dot, title });
    return b;
  };
  const markNav = (key) => {
    for (const [k, n] of navButtons) n.button.setAttribute('aria-current', String(k === key));
  };

  const sections = new Map();
  let shown = null;
  /*
    One section at a time. The list is the navigation, not a map of a long page: picking a section
    replaces the one on screen, and the dot beside a name is how an unsaved change in a section
    that is not showing stays visible. Edits in hidden sections are kept - the rows are hidden,
    not rebuilt - and Save writes all of them.
  */
  const showSection = (key) => {
    shown = key;
    // Remembered on the body, so a rebuild after Save, Attach or Create brings the same section back.
    body.dataset.section = key;
    body.dataset.sectionFor = row.name;
    for (const [k, sec] of sections) sec.hidden = k !== key;
    markNav(key);
    const scroller = body.closest('.pane-scroll');
    if (scroller) scroller.scrollTop = 0;
  };
  const sectionFor = (key, meta) => {
    if (sections.has(key)) return sections.get(key);
    meta = meta || (data.groups || []).find((g) => g.key === key)
      || { title: 'Other settings', blurb: 'Everything not filed above.' };
    const sec = el('section', 'section set-group');
    sec.dataset.section = key;
    const head = el('div', 'set-head');
    const h = el('h3');
    h.textContent = meta.title;
    const blurb = el('p');
    blurb.textContent = meta.blurb;
    head.append(h, blurb);
    sec.append(head);
    sec.hidden = shown !== null && shown !== key;
    form.append(sec);
    sections.set(key, sec);
    addNav(key, meta.title, sec);
    return sec;
  };
  // Built in the order the API declares them, so the form does not reorder itself when a field
  // happens to be missing from a server that has never booted.
  for (const g of data.groups || []) sectionFor(g.key);

  // ---- one row per setting ------------------------------------------------------

  /*
    Help is its first sentence, with the rest a click away. Most notes are one sentence; the long
    ones explain a consequence, which is worth keeping and not worth reading every time the form
    is opened.
  */
  const helpInto = (parent, text) => {
    if (!text) return;
    const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(text);
    const first = el('p', 'hint');
    first.textContent = m ? m[1] : text;
    parent.append(first);
    if (!m) return;
    const more = el('details', 'more');
    const summary = el('summary');
    summary.textContent = 'More';
    const rest = el('p', 'hint');
    rest.textContent = m[2];
    more.append(summary, rest);
    parent.append(more);
  };

  const entries = [];
  const addRow = (section, { id, label, help, control, entry }) => {
    const line = el('div', 'set-row');
    const left = el('div', 'set-label');
    const title = el('div', 'set-title');
    const lab = el('label');
    lab.htmlFor = id;
    lab.textContent = label;
    const tags = el('span', 'set-tags');
    title.append(lab, tags);
    left.append(title);
    helpInto(left, help);
    const right = el('div', 'set-control');
    right.append(control);
    line.append(left, right);
    section.append(line);
    entries.push({ ...entry, line, tags, section: section.dataset.section });
    return { line, left, right };
  };

  const controls = new Map();
  const players = data.players;

  for (const f of data.fields) {
    // A setting this version of Minecraft keeps in the world as a game rule. The row stays, so
    // nobody goes looking for where PvP went, and it has nothing to change: a line in the file
    // would be written and ignored.
    if (f.gameRule) {
      // an output is something a label can name, so the row reads as one thing
      const where = el('output', 'hint');
      where.id = 'p_' + f.key;
      where.textContent = 'Set with /gamerule';
      addRow(sectionFor(f.group || 'other'), {
        id: where.id,
        label: f.label,
        // where it went first; what it does is still a click away
        help: gameRuleWords() + (f.note ? ' ' + f.note : ''),
        control: where,
        entry: { kind: 'prop', key: f.key, changed: () => false, tag: 'Game rule', reset: () => {} },
      });
      continue;
    }
    let input;
    if (f.type === 'bool' || f.type === 'enum') {
      input = el('select');
      const opts = f.type === 'bool' ? ['true', 'false'] : f.options;
      for (const v of opts) {
        const o = el('option');
        o.value = v;
        o.textContent = f.type === 'bool' ? (v === 'true' ? 'Yes' : 'No') : v;
        o.selected = String(f.value) === v;
        input.append(o);
      }
    } else {
      input = el('input');
      input.type = f.type === 'int' ? 'number' : f.type === 'url' ? 'url' : 'text';
      if (f.type === 'int') { input.min = String(f.min); input.max = String(f.max); }
      if (f.type === 'url') { input.placeholder = 'https://'; input.spellcheck = false; }
      input.value = f.value == null ? '' : String(f.value);
      input.autocomplete = 'off';
    }
    input.id = 'p_' + f.key;
    const c = { input, original: f.value == null ? '' : String(f.value), set: Boolean(f.set) };
    controls.set(f.key, c);
    // A number field's own min and max only stop the spinner; typed, 5000 players went through to
    // Save. The range is said under the field as it is typed, and Save waits for it.
    let control = input;
    let invalid;
    if (f.type === 'int') {
      const bad = fieldNote(input);
      control = el('div', 'set-stack');
      // what the number counts, beside it: "10" alone does not say chunks or blocks
      let field = input;
      if (f.unit) {
        field = el('div', 'set-unit');
        const unit = el('span', 'hint');
        unit.id = input.id + '_unit';
        unit.textContent = f.unit;
        input.setAttribute('aria-describedby', unit.id + ' ' + bad.id);
        field.append(input, unit);
      }
      control.append(field, bad);
      invalid = () => !checkRange(input, bad, f.min, f.max);
      input.addEventListener('input', invalid);
    } else if (f.type === 'url') {
      const bad = fieldNote(input);
      control = el('div', 'set-stack');
      control.append(input, bad);
      invalid = () => {
        const problem = linkProblem(input.value);
        bad.textContent = problem;
        input.setAttribute('aria-invalid', String(Boolean(problem)));
        return Boolean(problem);
      };
      input.addEventListener('input', invalid);
    }
    const { left } = addRow(sectionFor(f.group || 'other'), {
      id: input.id,
      label: f.label,
      help: f.note,
      control,
      entry: {
        kind: 'prop',
        key: f.key,
        changed: () => input.value.trim() !== c.original,
        invalid,
        // Minecraft's own default: a key the file does not have yet, which the server writes on
        // its first start. Shown as a tag rather than a sentence under every field.
        isDefault: () => !c.set,
        reset: () => { input.value = c.original; input.dispatchEvent(new Event('change')); if (invalid) invalid(); },
      },
    });

    // Changing who can join on a world that already has players is an identity change, not a
    // setting change. Said next to the control, while the decision is being made.
    if (f.key === 'online-mode' && players && players.count > 0) {
      const warn = el('div', 'inline-warn');
      warn.hidden = true;
      input.addEventListener('change', () => {
        const changed = input.value !== c.original;
        warn.hidden = !changed;
        if (!changed) return;
        const goingOnline = input.value === 'true';
        const affected = goingOnline ? players.offline : players.online;
        const kind = goingOnline ? 'offline' : 'real';
        warn.textContent =
          'This world already has data for ' + players.count +
          (players.count === 1 ? ' player' : ' players') +
          (affected > 0
            ? ', ' + affected + ' of them under ' + kind + ' UUIDs. Changing this gives ' +
              (affected === 1 ? 'that player' : 'those players') +
              ' a different UUID, so anything stored against them — permissions, homes, ' +
              'inventories, plugin data — will not follow, and they will join as new players.'
            : '. Changing this alters how UUIDs are issued, so stored per-player data may not follow.');
      });
      left.append(warn);
    }
  }

  // How the server looks in a player's multiplayer list: its icon, its name, the MOTD with its
  // colours. The MOTD box takes Minecraft's own codes (\u00A7c for red), and the swatches insert
  // them, so nobody has to know them - but the text stays the text the file holds.
  const motd = controls.get('motd');
  if (motd) motd.input.parentElement.append(serverListPreview(row, motd.input));

  // What SpawnLoft's own settings looked like when the form was drawn, so Save can tell a change
  // from a visit. Updated after each save so the next one is measured from there.
  const mine = {
    autoRestart: row.autoRestart === true, webhook: row.webhook || '', java: row.java || 'java', memory: row.memory || '4G',
    jvmFlags: Array.isArray(row.jvmFlags) && row.jvmFlags.length ? row.jvmFlags.join(' ') : '',
  };

  // ---- if it crashes: SpawnLoft's own settings, not server.properties -----------
  // Saved by the one Save with everything else. It goes through a different endpoint and takes
  // effect at the next java exit rather than the next start, but that is the panel's problem to
  // route, not a reason for a second button on the screen.
  const crash = sectionFor('crash', { title: 'If it crashes', blurb: 'What SpawnLoft does when the server dies without being asked to.' });
  const arSwitch = el('input', 'switch');
  arSwitch.type = 'checkbox';
  arSwitch.id = 's_autorestart';
  arSwitch.checked = mine.autoRestart;
  addRow(crash, {
    id: arSwitch.id,
    label: 'Restart it automatically',
    help: 'Comes back ten seconds after a crash. Three crashes in ten minutes and it stays down instead '
      + 'of grinding all night; stopping it yourself always sticks.',
    control: arSwitch,
    entry: {
      // Read again by the supervisor at every exit, so it is in force as soon as it is saved.
      kind: 'own', key: 'autoRestart', live: true,
      changed: () => arSwitch.checked !== mine.autoRestart,
      value: () => arSwitch.checked,
      reset: () => { arSwitch.checked = mine.autoRestart; },
    },
  });
  const whInput = el('input', 'mono');
  whInput.id = 's_webhook';
  whInput.autocomplete = 'off';
  whInput.spellcheck = false;
  whInput.placeholder = 'https://discord.com/api/webhooks/…';
  whInput.value = mine.webhook;
  // The same test the server applies, said before Save rather than as a toast after it.
  const whBad = fieldNote(whInput);
  const whWrap = el('div', 'set-stack');
  whWrap.append(whInput, whBad);
  const whCheck = () => {
    const v = whInput.value.trim();
    let ok = !v;
    try { ok = ok || /^https?:$/.test(new URL(v).protocol); } catch {}
    whBad.textContent = ok ? '' : 'Paste the whole link Discord gives you, starting with https://';
    whInput.setAttribute('aria-invalid', String(!ok));
    return ok;
  };
  whInput.addEventListener('input', whCheck);
  addRow(crash, {
    id: whInput.id,
    label: 'Discord webhook',
    help: 'Gets a message when the server crashes, recovers, gives up, or a scheduled task fails. '
      + 'Leave it empty for none; Discord makes one under Server, Integrations, Webhooks.',
    control: whWrap,
    entry: {
      kind: 'own', key: 'webhook', live: true,
      changed: () => whInput.value.trim() !== mine.webhook,
      value: () => whInput.value.trim(),
      invalid: () => !whCheck(),
      reset: () => { whInput.value = mine.webhook; whCheck(); },
    },
  });

  // ---- which Java runs it, and how much memory it gets --------------------------
  // Per server, not per machine. Someone testing a plugin against 1.20.4 and 26.1 side by side
  // needs 17 on one and 25 on the other, so the picker lists every Java found on the box and
  // takes a path for one it did not find. Each server keeps its own choice.
  const jv = sectionFor('java', { title: 'Java and memory', blurb: 'What the server runs on, and how much memory it may use. Both take effect at the next start.' });
  const jvWrap = el('div', 'set-stack');
  const jvSelect = el('select');
  jvSelect.id = 's_java';
  const jvCustom = el('input', 'mono');
  jvCustom.autocomplete = 'off';
  jvCustom.spellcheck = false;
  jvCustom.placeholder = examplePath(panelPlatform, 'java');
  jvCustom.setAttribute('aria-label', 'Path to java');
  jvCustom.hidden = true;
  jvWrap.append(jvSelect, jvCustom);
  // Until the list arrives the select is empty, and an empty select must not read as "clear the
  // Java" when Save compares it with what the server had.
  let javaReady = false;
  const chosenJava = () => (jvSelect.value === '__custom' ? jvCustom.value.trim() : jvSelect.value);
  const jvRow = addRow(jv, {
    id: jvSelect.id,
    label: 'Runs on',
    help: 'Looking for Java on this computer…',
    control: jvWrap,
    entry: {
      kind: 'own', key: 'java',
      changed: () => javaReady && chosenJava() !== mine.java,
      value: () => chosenJava(),
      reset: () => selectJava(mine.java),
    },
  });
  const jvHint = jvRow.left.querySelector('.hint');
  const selectJava = (bin) => {
    const option = Array.from(jvSelect.options).find((o) => o.value === bin);
    if (option) { jvSelect.value = bin; jvCustom.hidden = true; }
    else { jvSelect.value = '__custom'; jvCustom.hidden = false; jvCustom.value = bin; }
  };
  api('/java').then((found) => {
    if (body.dataset.for !== row.name) return;
    jvSelect.textContent = '';
    const addOpt = (value, text) => {
      const o = el('option');
      o.value = value;
      o.textContent = text;
      jvSelect.append(o);
    };
    const needs = row.javaNeeds;
    for (const f of found.found) addOpt(f.path, javaOptionWords(f, needs));
    if (!found.found.some((f) => f.path === 'java')) addOpt('java', 'This computer\u2019s default Java');
    addOpt('__custom', 'Choose another Java…');
    selectJava(mine.java);
    const needLine = needs ? 'This server needs Java ' + needs + ' or newer. ' : '';
    jvHint.textContent = found.found.length
      ? needLine + 'Found ' + found.found.length + (found.found.length === 1 ? ' copy' : ' copies') + ' of Java on this computer. '
        + 'For one installed somewhere else, pick the last option and paste the path to ' + JAVA_FILE + '.'
      : needLine + 'No Java was found on this computer. Install one, or paste the path to ' + JAVA_FILE + '. ';
    if (found.download && !found.found.length) {
      const get = el('button', 'ghost');
      get.type = 'button';
      get.textContent = 'Get Java';
      get.onclick = () => openOutside(found.download);
      jvHint.append(get);
    }
    // A Java marked too old could be chosen and saved with nothing said
    const jvOld = el('div', 'hint');
    jvOld.style.color = 'var(--warn-ink)';
    jvOld.setAttribute('aria-live', 'polite');
    jvRow.left.append(jvOld);
    const sayOld = () => {
      jvOld.textContent = javaTooOldWords(found.found, chosenJava(), needs);
      jvOld.hidden = !jvOld.textContent;
    };
    jvSelect.addEventListener('change', sayOld);
    jvCustom.addEventListener('input', sayOld);
    sayOld();
    javaReady = true;
    update();
  }).catch((e) => {
    jvHint.textContent = 'Could not look for Java: ' + e.message;
    jvSelect.textContent = '';
    const o = el('option');
    o.value = '__custom';
    o.textContent = 'Choose another Java…';
    jvSelect.append(o);
    jvCustom.hidden = false;
    jvCustom.value = mine.java;
    javaReady = true;
    update();
  });
  jvSelect.onchange = () => {
    jvCustom.hidden = jvSelect.value !== '__custom';
    if (!jvCustom.hidden) jvCustom.focus();
  };

  const memInput = el('input', 'mono');
  memInput.id = 's_memory';
  memInput.autocomplete = 'off';
  memInput.value = mine.memory;
  const memBad = fieldNote(memInput);
  memInput.addEventListener('input', () => checkMemory(memInput, memBad));
  const memWrap = el('div', 'set-stack');
  memWrap.append(memInput, memBad);
  addRow(jv, {
    id: memInput.id,
    label: 'Memory',
    help: 'The most the server may use, as 4G or 6144M. The whole process sits a little above it, which is normal.',
    control: memWrap,
    entry: {
      kind: 'own', key: 'memory',
      changed: () => memInput.value.trim() !== mine.memory,
      value: () => memInput.value.trim(),
      invalid: () => !checkMemory(memInput, memBad),
      reset: () => { memInput.value = mine.memory; checkMemory(memInput, memBad); },
    },
  });

  // ---- the Java arguments ------------------------------------------------------
  // SpawnLoft's recommended flags (Aikar's) unless the owner writes their own. The whole launch line
  // is shown under it, so what the checkbox and the box mean is visible rather than described.
  const flagsWrap = el('div', 'set-stack');
  const flagsOwn = el('label', 'check');
  const flagsBox = el('input');
  flagsBox.type = 'checkbox';
  flagsBox.checked = Boolean(mine.jvmFlags);
  flagsOwn.append(flagsBox, document.createTextNode(' Use my own Java arguments'));
  const flagsText = el('textarea', 'mono');
  flagsText.id = 's_jvmFlags';
  flagsText.rows = 3;
  flagsText.spellcheck = false;
  flagsText.value = mine.jvmFlags;
  flagsText.hidden = !flagsBox.checked;
  flagsText.setAttribute('aria-label', 'Java arguments');
  const flagsLine = el('code', 'launch-line');
  flagsWrap.append(flagsOwn, flagsText, flagsLine);
  const jarName = (row.jar || 'server.jar').split(/[\\/]/).pop();
  const showLaunch = () => {
    const mem = memInput.value.trim() || mine.memory;
    const flags = flagsBox.checked ? flagsText.value.trim().split(/\s+/).filter(Boolean) : (row.defaultJvmFlags || []);
    flagsLine.textContent = ['java', '-Xms' + mem, '-Xmx' + mem, ...flags, '-jar', jarName, '--nogui'].join(' ');
  };
  flagsBox.onchange = () => {
    flagsText.hidden = !flagsBox.checked;
    // Starting from the recommended set is easier than from nothing: most people want to add one.
    if (flagsBox.checked && !flagsText.value.trim()) flagsText.value = (row.defaultJvmFlags || []).join(' ');
    showLaunch();
    update();
  };
  flagsText.addEventListener('input', () => { showLaunch(); update(); });
  memInput.addEventListener('input', showLaunch);
  showLaunch();
  addRow(jv, {
    id: flagsText.id,
    label: 'Java arguments',
    help: 'How Java runs the server, beyond memory. The recommended set suits almost every server; your own replaces it. Memory stays with the setting above, and takes effect at the next start.',
    control: flagsWrap,
    entry: {
      kind: 'own', key: 'jvmFlags',
      // Compared as one space-separated line, and saved as one: Save copies the value into `mine`,
      // and the next comparison has to be against the same shape.
      changed: () => (flagsBox.checked ? flagsText.value.trim().split(/\s+/).filter(Boolean).join(' ') : '') !== (mine.jvmFlags || ''),
      value: () => (flagsBox.checked ? flagsText.value.trim().split(/\s+/).filter(Boolean).join(' ') || null : null),
      reset: () => { flagsBox.checked = Boolean(mine.jvmFlags); flagsText.value = mine.jvmFlags || ''; flagsText.hidden = !flagsBox.checked; showLaunch(); },
    },
  });

  // ---- the server software itself -------------------------------------------
  // Off the network until asked: the section shows what is installed from the registry alone, and
  // only the button talks to the software's own download API. It knows the software SpawnLoft can
  // update; on a Fabric or Spigot server it would have nothing true to say, so it is not there.
  const canUpdate = ['paper', 'purpur', 'folia', 'asp'].includes(row.loader ?? 'paper');
  if (canUpdate) {
    const soft = sectionFor('software', { title: 'Server software', blurb: 'The server build this server runs.' });
    const softNow = el('div', 'hint mono-path');
    softNow.textContent = row.jar || '—';
    const softRow = el('div', 'row');
    const softCheck = iconButton('restore', 'Check for updates');
    softRow.append(softCheck);
    const softOut = el('div');
    softOut.style.display = 'grid';
    softOut.style.gap = '8px';
    soft.append(softNow, softRow, softOut);

    // The whole page is drawn again after an upgrade, unless that would take unsaved changes in
    // the other sections with it: then only this section is brought up to date.
    const afterUpgrade = async () => {
      await refresh();
      if (!pending().count && !rawDirty) {
        body.dataset.for = '';
        return renderServerSettings();
      }
      softNow.textContent = (rowOf(row.name) || row).jar || '—';
      softCheck.onclick();
    };

    softCheck.onclick = async () => {
      softCheck.disabled = true;
      softOut.textContent = '';
      const asking = el('div', 'hint');
      asking.textContent = 'Checking for updates…';
      softOut.append(asking);
      let info;
      try {
        info = await api(base + '/upgrade');
      } catch (e) {
        asking.remove();
        const bad = el('div', 'bad');
        bad.textContent = e.message;
        softOut.append(bad);
        softCheck.disabled = false;
        return;
      }
      softCheck.disabled = false;
      softOut.textContent = '';

      const line = (text) => {
        const node = el('div', 'hint');
        node.textContent = text;
        softOut.append(node);
        return node;
      };

      if (!info.current) {
        line('SpawnLoft did not download this jar, so it cannot tell which build it is or offer updates for it.');
        return;
      }
      line('Runs ' + info.label + ' ' + info.current.version + ', build ' + info.current.build + '.');
      if (info.buildUpdate) {
        const channel = info.latestBuild.channel;
        line('Build ' + info.latestBuild.build + ' is available for ' + info.current.version
          + (channel && channel !== 'STABLE' ? ' (' + channel.toLowerCase() + ')' : '')
          + '. The jar it runs now stays in the folder as the way back.');
        const go = el('button', 'primary');
        go.textContent = 'Update to build ' + info.latestBuild.build;
        softOut.append(go);
        go.onclick = async () => {
          go.disabled = true;
          go.textContent = 'Downloading…';
          try {
            const out = await post(base + '/upgrade', {});
            toast('Now on ' + out.to + '.' + (out.running ? ' Restart to load it.' : ''), 'good');
            await afterUpgrade();
          } catch (e) {
            toast(e.message, 'bad');
            go.disabled = false;
            go.textContent = 'Update to build ' + info.latestBuild.build;
          }
        };
      } else {
        line('This is the newest build for ' + info.current.version + '.');
      }

      if (info.newerVersions.length) {
        const next = info.newerVersions[0];
        line('Minecraft ' + next + ' is out. Crossing versions migrates the worlds on the next '
          + 'start, and worlds do not migrate back.');
        const cross = el('button');
        cross.textContent = 'Upgrade to ' + next + '…';
        softOut.append(cross);
        cross.onclick = async () => {
          const ok = await ask({
            title: 'Upgrade ' + row.name + ' to Minecraft ' + next + '?',
            text: 'The first start migrates the worlds, and worlds do not migrate back. A standard '
              + 'backup is taken first, but check your plugins support ' + next + ' too - a plugin '
              + 'built for ' + info.current.version + ' may refuse to load.',
            confirmLabel: 'Upgrade',
            danger: true,
            typeToConfirm: row.name,
          });
          if (!ok) return;
          cross.disabled = true;
          cross.textContent = 'Downloading…';
          const note = toast('Backing up, then downloading ' + info.label + ' ' + next + '…');
          try {
            const out = await post(base + '/upgrade', { version: next });
            note.remove();
            toast('Now on ' + out.to + '. A backup was taken first.' + (out.running ? ' Restart to load it.' : ''), 'good');
            await afterUpgrade();
          } catch (e) {
            note.remove();
            toast(e.message, 'bad');
            cross.disabled = false;
            cross.textContent = 'Upgrade to ' + next + '…';
          }
        };
      }
    };
  }

  // ---- the save bar ---------------------------------------------------------------

  /*
    Stays in view at the bottom of the scroller, and says once what the old screen said under every
    heading: that nothing here reaches a running server until it starts again. Save and restart is
    offered only while the server is running; stopped, Save is the primary button.
  */
  const bar = el('div', 'pane-foot set-bar');
  const barDot = el('span', 'bar-dot');
  barDot.setAttribute('aria-hidden', 'true');
  const barCount = el('b', 'bar-count');
  const barWhen = el('span', 'hint');
  const applyWhen = 'Take effect when ' + (row.label || row.name) + ' next starts.';
  bar.hidden = true;
  const discard = el('button', 'ghost');
  discard.type = 'button';
  discard.textContent = 'Discard';
  const save = el('button');
  save.type = 'button';
  save.textContent = 'Save';
  const saveRestart = el('button', 'primary');
  saveRestart.type = 'button';
  saveRestart.textContent = 'Save and restart';
  const grow = el('span', 'grow');
  bar.append(barDot, barCount, barWhen, grow, discard, save, saveRestart);
  body.append(bar);

  /*
    What would be written if Save were pressed now. Two patches, because the properties and
    SpawnLoft's own settings live behind different endpoints - but one button, because the person
    changing them does not care which file a field lands in.

    Only what actually changed: a field left alone is never written, so server.properties keeps
    whatever the server itself put there.
  */
  const pending = () => {
    const props = {};
    const own = {};
    for (const e of entries) {
      if (!e.changed()) continue;
      if (e.kind === 'prop') props[e.key] = controls.get(e.key).input.value.trim();
      else own[e.key] = e.value();
    }
    return {
      props, own,
      count: Object.keys(props).length + Object.keys(own).length,
      needsRestart: needsRestart(entries.filter((e) => e.changed())),
    };
  };

  let saving = false;
  let rawDirty = false;
  settingsWaiting = () => {
    // Only for the server that is open and still exists: a form left behind by a server that was
    // renamed or removed has nowhere to be saved to, and must not hold anybody up.
    if (body.dataset.for !== row.name || state.current !== row.name || !rowOf(row.name)) return null;
    const count = pending().count + (rawDirty ? 1 : 0);
    return count ? { name: row.name, count } : null;
  };
  /** Every row's tags and edge, each section's dot, and the bar, from what is in the form now. */
  function update() {
    const changedSections = new Set();
    for (const e of entries) {
      const changed = e.changed();
      if (changed) changedSections.add(e.section);
      e.line.toggleAttribute('data-changed', changed);
      e.tags.textContent = '';
      const tag = changed ? 'Changed' : e.tag || (e.isDefault && e.isDefault() ? 'Default' : '');
      if (tag) {
        const t = el('span', 'set-tag');
        t.textContent = tag;
        if (changed) t.dataset.tone = 'changed';
        t.title = changed ? 'Different from what is saved' : e.tag ? 'Kept in the world, not in server.properties' : 'Not in server.properties yet: this is Minecraft\u2019s own default';
        e.tags.append(t);
      }
    }
    for (const [key, n] of navButtons) {
      n.dot.hidden = key === 'raw' ? !rawDirty : !changedSections.has(key);
      n.button.setAttribute('aria-label', n.title + (n.dot.hidden ? '' : ', unsaved changes'));
    }
    const waiting = pending();
    const n = waiting.count;
    const invalid = entries.some((e) => e.invalid && e.changed() && e.invalid());
    const running = (rowOf(row.name) || row).status === 'running';
    // The bar is there only while there is something to save: with nothing changed it was three
    // disabled buttons and a sentence saying so, on every visit.
    bar.hidden = !n && !saving;
    barCount.textContent = n + (n === 1 ? ' unsaved change' : ' unsaved changes');
    barWhen.textContent = invalid ? 'Fix the field marked in red to save.' : waiting.needsRestart ? applyWhen : 'In force as soon as it is saved.';
    discard.disabled = saving || !n;
    save.disabled = saving || !n || invalid;
    saveRestart.disabled = saving || !n || invalid;
    // Offered only when a restart would do something: asking people to be disconnected for a
    // change that is already in force is the one thing this bar must not do.
    saveRestart.hidden = !running || !waiting.needsRestart;
    save.className = saveRestart.hidden ? 'primary' : '';
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);

  discard.onclick = () => {
    for (const e of entries) if (e.changed()) e.reset();
    update();
  };

  const doSave = async ({ restart = false } = {}) => {
    const { props, own, count, needsRestart: restartNeeded } = pending();
    if (!count) return;
    if ('java' in own && !own.java) { toast('Pick a Java, or paste the path to one.', 'bad'); return; }
    saving = true;
    update();
    barCount.textContent = 'Saving…';
    try {
      if (Object.keys(props).length) {
        const out = await post(base + '/props', props);
        for (const f of out.fields) {
          const c = controls.get(f.key);
          if (c) { c.original = f.value == null ? '' : String(f.value); c.set = Boolean(f.set); }
        }
        // left out by the server: this form was drawn before the server's version changed
        for (const g of out.ignored || []) {
          const c = controls.get(g.key);
          if (c) c.input.value = c.original;
        }
        if (out.ignored && out.ignored.length) toast(ignoredWords(out.ignored.map((g) => g.label)), 'bad');
      }
      if (Object.keys(own).length) {
        await post(base + '/settings', own);
        Object.assign(mine, own);
      }
      const running = (rowOf(row.name) || row).status === 'running';
      toast(savedWords(count, { running, needsRestart: restartNeeded, restarting: restart, name: row.label || row.name }), 'good');
      saving = false;
      update();
      await refresh();
      if (restart && restartNeeded && state.current === row.name) await act('restart', { sure: true })();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      saving = false;
      update();
    }
  };
  save.onclick = () => doSave();
  // Asked before anything is saved, so "no" leaves the form exactly as it was.
  saveRestart.onclick = async () => {
    const question = stopQuestion('restart', rowOf(row.name), state.rows);
    if (question && !(await ask({ ...question, title: 'Save and restart ' + (row.label || row.name) + '?', confirmLabel: 'Save and restart' }))) return;
    doSave({ restart: true });
  };

  // ---- the whole file -------------------------------------------------------------

  /*
    server.properties as text, for the forty-odd keys the form does not cover. Shown the way the
    assistant's config tools show it - the RCON password hidden - and saved the same way: hidden
    values put back from the file, the ports and RCON SpawnLoft manages refused, and the file
    snapshotted on its own first. A save here does not go through the bar: it is one file, written
    at once, and the form's own changes are left as they are.
  */
  const rawHead = el('div', 'set-head');
  const rawTitle = el('h3', 'mono');
  rawTitle.textContent = 'server.properties';
  const rawBlurb = el('p');
  rawBlurb.textContent = 'The whole file. Values shown as [redacted] are hidden: leave those lines as they are. '
    + 'The ports and RCON are set by SpawnLoft at every start, so a change to them is refused.';
  rawHead.append(rawTitle, rawBlurb);
  const rawText = el('textarea', 'mono');
  rawText.spellcheck = false;
  rawText.setAttribute('aria-label', 'server.properties');
  rawText.rows = 24;
  const rawRow = el('div', 'row');
  const rawSave = el('button', 'primary');
  rawSave.type = 'button';
  rawSave.textContent = 'Save file';
  const rawReload = el('button', 'ghost');
  rawReload.type = 'button';
  rawReload.textContent = 'Reload';
  const rawNote = el('span', 'hint');
  rawRow.append(rawSave, rawReload, rawNote);
  rawView.append(rawHead, rawText, rawRow);
  let rawLoaded = null;

  const setRawDirty = () => {
    rawDirty = rawLoaded !== null && rawText.value !== rawLoaded;
    rawSave.disabled = !rawDirty;
    update();
  };
  rawText.addEventListener('input', setRawDirty);

  const loadRaw = async () => {
    rawNote.textContent = 'Reading server.properties…';
    try {
      const out = await api(base + '/props/raw');
      rawLoaded = out.text.replace(/\r\n/g, '\n');
      rawText.value = rawLoaded;
      rawNote.textContent = '';
    } catch (e) {
      rawNote.textContent = e.message;
    }
    setRawDirty();
  };

  /** The form's fields, brought up to date with a file changed underneath them. An untouched
   *  field takes the new value; one with an unsaved change keeps it, measured from the new one. */
  const reloadFields = async () => {
    let fresh;
    try { fresh = await api(base + '/props'); } catch { return; }
    for (const f of fresh.fields) {
      const c = controls.get(f.key);
      if (!c) continue;
      const value = f.value == null ? '' : String(f.value);
      if (c.input.value.trim() === c.original) c.input.value = value;
      c.original = value;
      c.set = Boolean(f.set);
    }
    update();
  };

  rawSave.onclick = async () => {
    rawSave.disabled = true;
    rawNote.textContent = 'Saving…';
    try {
      const out = await post(base + '/props/raw', { text: rawText.value });
      toast('Saved server.properties. A backup of it was taken first'
        + (out.appliesOnRestart ? '; restart ' + (row.label || row.name) + ' to apply.' : '.'), 'good');
      await loadRaw();
      await reloadFields();
    } catch (e) {
      rawNote.textContent = '';
      toast(e.message, 'bad');
      setRawDirty();
    }
  };
  rawReload.onclick = async () => {
    if (rawDirty) {
      const ok = await ask({ title: 'Discard your edits to server.properties?', text: 'Reloading reads the file again as it is on disk.', confirmLabel: 'Reload', danger: true });
      if (!ok) return;
    }
    await loadRaw();
  };

  /*
    The raw file takes the form's place on a pane that has room for one of them, and sits beside
    the form on an Ultra pane, where both stay showing and picking server.properties in the list
    only brings the file to the front. Measured in script because [hidden] is final in this sheet.
  */
  let rawOn = false;
  function showRaw(on) {
    rawOn = on;
    const beside = paneIsUltra(body);
    form.hidden = on && !beside;
    // The bar is update()'s alone to show or hide. Setting it here showed "0 unsaved changes" on
    // every change of section, and hid waiting changes behind the file.
    update();
    rawView.hidden = !on && !beside;
    if (!rawView.hidden && rawLoaded === null) loadRaw();
    if (on) markNav('raw');
  }
  // The pane crossing 2000px, either way, re-decides which of the two are showing.
  if (settingsPaneWatch) settingsPaneWatch.disconnect();
  settingsPaneWatch = new ResizeObserver(() => {
    if (!body.isConnected || body.dataset.for !== row.name) return settingsPaneWatch.disconnect();
    const beside = paneIsUltra(body);
    if (beside === (!rawView.hidden && !form.hidden)) return;
    showRaw(rawOn);
  });
  settingsPaneWatch.observe(body.closest('.pane-scroll'));

  const sep = el('div', 'set-nav-sep');
  sep.setAttribute('role', 'separator');
  nav.append(sep);
  const rawNav = addNav('raw', 'server.properties', rawView);
  rawNav.classList.add('mono');
  rawNav.onclick = () => { showRaw(true); rawText.focus(); };
  // On an Ultra pane the file is on screen from the start, so it is read from the start.
  showRaw(false);

  // The section that was showing before a rebuild of the same server's form comes back; otherwise
  // the first section is the one on screen until another is picked. Databases is built below, so a
  // form that is coming back to it waits for it.
  const keep = body.dataset.sectionFor === row.name ? body.dataset.section : null;
  if (keep && sections.has(keep)) showSection(keep);
  else if (sections.size && keep !== 'databases') showSection(sections.keys().next().value);

  // Last, after the file-backed sections: the databases this server is attached to. It is one of
  // the sections, so it goes in the list too.
  update();
  if (body.dataset.for === row.name) {
    await renderServerDatabases(row, body, form);
    const dbSection = form.querySelector('[data-section="databases"]');
    if (dbSection && !navButtons.has('databases')) {
      dbSection.hidden = shown !== null && shown !== 'databases';
      sections.set('databases', dbSection);
      addNav('databases', 'Databases', dbSection);
      nav.insertBefore(navButtons.get('databases').button, sep);
      if (shown === null) showSection('databases');
    }
  }
}

