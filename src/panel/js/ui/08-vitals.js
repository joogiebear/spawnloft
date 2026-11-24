'use strict';
// ------------------------------------------------------------------ vitals ---

/*
  The four numbers under a running server's name. Players, TPS and memory come with the server
  list, from the newest reading the daemon took; the TPS sparkline wants ten minutes of history and
  the last backup wants the snapshot list, so those two are asked for here, for the one server on
  screen, at a pace that matches how fast they change.
*/
const vitalsView = { name: null, samples: [], backupAt: null, backupAsked: 0 };
let vitalsTimer = null;

function stopVitals() {
  clearInterval(vitalsTimer);
  vitalsTimer = null;
}

function startVitals(name) {
  stopVitals();
  vitalsView.name = name;
  vitalsView.samples = [];
  vitalsView.backupAt = undefined;
  vitalsView.backupAsked = 0;
  pollVitals(name);
  vitalsTimer = setInterval(() => pollVitals(name), 10000);
}

async function pollVitals(name) {
  if (document.hidden || state.current !== name || state.view !== 'server') return;
  const row = rowOf(name);
  if (!row || isDb(row)) return;
  const base = '/instances/' + encodeURIComponent(name);
  const asks = [];
  if (row.status === 'running') {
    asks.push(api(base + '/metrics?seconds=600').then((d) => {
      vitalsView.samples = (d && d.samples) || [];
    }, () => {}));
  }
  // A backup is minutes apart at the closest; once a minute is plenty.
  if (Date.now() - vitalsView.backupAsked > 60000) {
    vitalsView.backupAsked = Date.now();
    asks.push(api(base + '/backups/history').then((d) => {
      const newest = d && d.snapshots && d.snapshots[0];
      vitalsView.backupAt = newest ? new Date(newest.mtime).getTime() : null;
    }, () => {}));
  }
  await Promise.all(asks);
  if (state.current === name && state.view === 'server' && vitalsView.name === name) renderVitals(rowOf(name));
}

/**
 * "just now", "12m", "3h", "4d": how long ago, in the one unit that matters at that distance. It
 * changes unit where ago() does, so the header and the page beside it say the same thing: they
 * said "now" and "just now", and "30h" and "1 day ago", for one backup.
 */
function shortAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function vitalCell(key, label, title) {
  const wrap = document.createElement('div');
  // TPS is the one to go when the stage is narrow: it is also in Stats, with its history
  wrap.className = 'grid min-w-0 content-start gap-[5px] @max-[1024px]/stage:data-[v=tps]:hidden';
  wrap.dataset.v = key;
  if (title) wrap.title = title;
  const dt = document.createElement('dt');
  dt.className = 'text-1 leading-[1.3] font-strong tracking-[.08em] whitespace-nowrap text-ink-3 uppercase';
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.className = 'm-0 flex min-w-0 items-center gap-2 whitespace-nowrap';
  wrap.append(dt, dd);
  return { wrap, dd };
}

function bigNumber(dd, value, of) {
  const big = document.createElement('span');
  big.className = 'font-display text-5 leading-none font-strong tracking-[-.01em] text-ink';
  big.textContent = value;
  dd.append(big);
  if (of) {
    const small = document.createElement('span');
    small.className = 'text-2 leading-none text-ink-3';
    small.textContent = of;
    dd.append(small);
  }
}

function renderVitals(row) {
  const dl = $('#srvVitals');
  dl.textContent = '';
  const live = row.status === 'running';
  const latest = live ? row.latest : null;

  if (isDb(row)) {
    dl.hidden = false;
    dl.dataset.count = '2';
    const attached = Object.keys(row.attachments || {});
    const mem = vitalCell('memory', 'Memory', 'The whole database process');
    if (latest && Number.isFinite(latest.rss)) {
      const gb = latest.rss >= 1024;
      bigNumber(mem.dd, gb ? (latest.rss / 1024).toFixed(1) : String(latest.rss), gb ? 'GB' : 'MB');
    } else bigNumber(mem.dd, '—');
    const att = vitalCell('attached', 'Attached', attached.join(', '));
    const t = document.createElement('span');
    t.className = 'min-w-0 truncate font-mono text-3 leading-[1.3] text-ink';
    t.textContent = attached.length ? attached.join(', ') : 'nothing yet';
    att.dd.append(t);
    dl.append(mem.wrap, att.wrap);
    return;
  }
  delete dl.dataset.count;

  const backup = vitalCell('backup', 'Last backup');
  if (vitalsView.name !== row.name || vitalsView.backupAt === undefined) bigNumber(backup.dd, '…');
  else if (vitalsView.backupAt === null) bigNumber(backup.dd, 'Never');
  else {
    bigNumber(backup.dd, shortAgo(vitalsView.backupAt), shortAgo(vitalsView.backupAt) === 'just now' ? '' : 'ago');
    backup.wrap.title = stamp(new Date(vitalsView.backupAt).toISOString());
  }

  // Not running: no numbers at all. The state pill says stopped or crashed, the console says why,
  // and Start is the thing to do; dashes in the space the numbers take said nothing. Last backup
  // is on the Backups tab either way.
  dl.hidden = !live;
  if (!live) return;

  const players = vitalCell('players', 'Players',
    latest == null ? 'Waiting for the server to answer' : '');
  if (latest && latest.players != null) {
    bigNumber(players.dd, String(latest.players), latest.maxPlayers != null ? '/ ' + latest.maxPlayers : '');
    players.wrap.append(bar(latest.maxPlayers ? latest.players / latest.maxPlayers : 0));
  } else {
    bigNumber(players.dd, '—');
    players.wrap.append(bar(null));
  }

  const tps = vitalCell('tps', 'TPS', 'Ticks per second over the last minute; 20 is full speed');
  if (latest && latest.tps != null) {
    bigNumber(tps.dd, latest.tps.toFixed(1));
    // Under 18 a player starts to feel it; under 15 everyone does.
    tps.wrap.append(bar(latest.tps / 20, latest.tps < 15 ? 'fault' : latest.tps < 18 ? 'warn' : ''));
  } else {
    bigNumber(tps.dd, '—');
    tps.wrap.append(bar(null));
  }

  const ceiling = memoryCeilingMb(row.memory);
  const memory = vitalCell('memory', 'Memory',
    'Everything the server uses, Java itself included. It can sit above the ' + (row.memory ? row.memory + ' ' : '') + 'limit you set; that is normal.');
  if (latest && Number.isFinite(latest.rss)) {
    // Gigabytes once there is a gigabyte to count; "0.0 GB" for a server that is still warming up
    // says it uses nothing, which is not true.
    const gb = latest.rss >= 1024;
    const allotted = ceiling ? '/ ' + +(ceiling / 1024).toFixed(1) + ' GB' : 'GB';
    bigNumber(memory.dd, gb ? (latest.rss / 1024).toFixed(1) : String(latest.rss), gb ? allotted : 'MB ' + allotted);
    const share = ceiling ? latest.rss / ceiling : null;
    memory.wrap.append(bar(share, share > 0.9 ? 'warn' : ''));
  } else {
    bigNumber(memory.dd, '—');
    memory.wrap.append(bar(null));
  }

  dl.append(players.wrap, tps.wrap, memory.wrap, backup.wrap);
}

/**
 * A live bar under a vital's figure, the full width of its cell. Drawn even before there is a
 * number, empty, so the strip does not grow a row when the first answer arrives.
 */
function bar(share, tone) {
  const meter = document.createElement('span');
  meter.className = 'block h-1 w-full max-w-[120px] overflow-hidden rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--line)]';
  meter.setAttribute('aria-hidden', 'true');
  if (tone) meter.dataset.tone = tone;
  const fill = document.createElement('i');
  fill.className = 'block h-full rounded-full ' + (tone === 'fault' ? 'bg-fault' : tone === 'warn' ? 'bg-warn' : 'bg-accent');
  fill.style.width = share == null ? '0' : (Math.max(0, Math.min(1, share)) * 100).toFixed(1) + '%';
  meter.append(fill);
  return meter;
}

