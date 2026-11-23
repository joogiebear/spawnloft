'use strict';
// ---- the server cards ----------------------------------------------------------

function buildHomeCard(name) {
  const card = el('article', 'scard');
  card.dataset.name = name;

  const head = cardHead('server');
  // The verbs: the one that changes its state, and Restart beside Stop while it runs.
  const acts = el('div', 'sc-acts');
  const restart = el('button', 'sc-restart');
  restart.type = 'button';
  restart.onclick = () => cardAct(name, 'restart');
  const play = el('button', 'sc-play');
  play.type = 'button';
  play.textContent = 'Play';
  play.onclick = () => playClient(rowOf(name));
  const act = el('button', 'sc-act');
  act.type = 'button';
  act.onclick = () => cardAct(name);
  acts.append(restart, play, act);
  head.append(acts);

  const stats = el('dl', 'sc-stats');
  for (const [key, label] of [['players', 'Players'], ['tps', 'TPS'], ['memory', 'Memory']]) {
    const cell = el('div');
    cell.dataset.v = key;
    const dt = el('dt');
    dt.textContent = label;
    cell.append(dt, el('dd'));
    stats.append(cell);
  }
  const idle = el('p', 'sc-idle');

  const foot = el('div', 'sc-foot');
  const open = el('button', 'sc-open');
  open.type = 'button';
  open.textContent = 'Open →';
  open.onclick = () => select(name);
  foot.append(el('div', 'sc-note'), open);

  card.append(head, stats, idle, el('div', 'sc-links'), el('div', 'sc-dbs'), foot);
  return card;
}

/** What the card's main button does: stop a running server, start a stopped one. */
function cardVerb(row) {
  if (row.status === 'running' || row.status === 'stopping') return { what: 'stop', label: 'Stop', primary: false };
  return { what: 'start', label: crashedNow(row) ? 'Restart' : 'Start', primary: true };
}

async function cardAct(name, what) {
  const row = rowOf(name);
  if (!row || overview.acting[name]) return;
  const verb = what ? { what } : cardVerb(row);
  const question = stopQuestion(verb.what, row, state.rows);
  if (question && !(await ask(question))) return;
  if (overview.acting[name]) return;
  if (question && !stillUp(rowOf(name))) return toast((row.label || name) + ' is no longer running.');
  overview.acting[name] = verb.what;
  renderHomeCards();
  const note = toast(ACTION_ING[verb.what] + ' ' + name + '…');
  try {
    await post('/instances/' + encodeURIComponent(name) + '/' + verb.what);
    note.remove();
    toast(name + ' ' + ACTION_DONE[verb.what] + '.', 'good');
  } catch (e) {
    note.remove();
    toast(e.message, 'bad');
  } finally {
    delete overview.acting[name];
    await refresh();
  }
}

/**
 * The line at the foot of a card: how it is looked after. A server with no backup on disk says
 * so in the warning's colour and offers the way to set them up; "Never" only when it truly never
 * was.
 */
function cardNote(row) {
  const b = backupState(row);
  if (!b) return { text: overview.failed ? 'Backups unknown' : 'Checking backups…' };
  const schedule = b.auto ? 'backs up ' + describeSchedule(b.auto.schedule) : '';
  if (!b.none) {
    const old = !b.auto && Date.now() - b.lastAt >= 7 * DAY_MS;
    return {
      icon: 'archive', tone: old ? 'warn' : '',
      lead: 'Last backup', strong: ago(new Date(b.lastAt).toISOString()) || 'just now',
      text: schedule ? capital(schedule) : 'No schedule',
      link: b.auto ? null : 'Set up backups',
    };
  }
  if (b.auto) return { icon: 'archive', lead: 'No backup yet', text: 'First one ' + describeSchedule(b.auto.schedule) };
  if (row.origin && row.origin.clonedFrom && !b.gone) return { icon: 'archive', text: 'Test copy, backups off' };
  return { icon: 'alert', tone: 'warn', strong: b.gone ? 'No backups kept' : 'Never backed up', text: 'Backups off', link: 'Set up backups' };
}

function setStat(card, key, value, of, tone, spark) {
  const dd = card.querySelector('[data-v="' + key + '"] dd');
  dd.textContent = '';
  const big = document.createElement('span');
  big.className = 'big';
  big.textContent = value;
  if (tone) big.dataset.tone = tone;
  dd.append(big);
  if (of) {
    const small = document.createElement('span');
    small.className = 'of';
    small.textContent = of;
    dd.append(small);
  }
  // Drawn whenever there is history; the stylesheet shows it only on a card wide enough for it.
  if (spark && spark.values.length > 1) dd.append(sparkline(spark.values, spark.max));
}

/** A button's word, and whether it is the one doing something right now. */
function setVerb(button, label, busy, disabled, name) {
  button.textContent = busy ? ACTION_ING[busy] + '…' : label;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
  button.disabled = disabled;
  button.setAttribute('aria-label', (busy ? ACTION_ING[busy] : label) + ' ' + name);
}

function updateHomeCard(card, row) {
  const name = row.label || row.name;
  const acting = overview.acting[row.name];
  card.dataset.status = row.status;
  card.toggleAttribute('data-crashed', crashedNow(row));
  card.querySelector('.sc-name').textContent = name;
  setPill(card.querySelector('.spill'), row, acting);

  const sw = softwareById[row.loader ?? 'paper'];
  const soft = card.querySelector('.sc-soft');
  const addr = row.port ? 'localhost:' + row.port : '';
  const what = (sw ? sw.label : (row.loader || 'Paper')) + (row.mcVersion ? ' ' + row.mcVersion : '');
  // Rebuilt only when it changes, so the address button keeps its focus across polls.
  if (soft.dataset.said !== what + '|' + addr) {
    soft.dataset.said = what + '|' + addr;
    soft.textContent = '';
    soft.append(what + ' · ', addr ? addrButton(addr) : 'port not known yet');
  }

  const verb = cardVerb(row);
  const blocked = Boolean(acting) || row.status === 'stopping' || Boolean(state.busy && state.current === row.name);
  const act = card.querySelector('.sc-act');
  act.className = 'sc-act' + (verb.primary ? ' primary' : '');
  const busy = acting && acting !== 'restart' ? acting : row.status === 'stopping' ? 'stop' : null;
  setVerb(act, verb.label, busy, blocked, name);
  const restart = card.querySelector('.sc-restart');
  restart.hidden = !(row.status === 'running' || acting === 'restart');
  setVerb(restart, 'Restart', acting === 'restart' ? 'restart' : null, blocked, name);
  const play = card.querySelector('.sc-play');
  const pp = playProfileFor(row);
  play.textContent = pp && pp.running ? 'Playing' : 'Play';
  play.title = !pp ? 'Opens the Play page to make a setup for this server' : pp.running ? pp.name + ' is running: opens it on the Play page' : 'Starts ' + pp.name + ' on the Play page, pointed at this server';
  card.querySelector('.sc-foot .sc-open').setAttribute('aria-label', 'Open ' + name);

  // Live figures while it runs; one line saying why there are none while it does not.
  const live = row.status === 'running';
  const stats = card.querySelector('.sc-stats');
  const idle = card.querySelector('.sc-idle');
  stats.hidden = !live;
  idle.hidden = live;
  if (!live) {
    idle.textContent = '';
    delete idle.dataset.tone;
    if (javaShort(row)) {
      idle.dataset.tone = 'fault';
      idle.append(icon('alert'), 'Needs Java ' + row.javaNeeds + ' to start');
    } else if (crashedNow(row)) {
      idle.dataset.tone = 'fault';
      idle.append(icon('alert'), 'Crashed — open the console to see why, or start it again');
    } else if (acting === 'start' || acting === 'restart') {
      idle.append(icon('pulse'), 'Starting — live stats appear once it is up');
    } else {
      idle.append(icon('pulse'), 'Server is stopped — start it to see live stats');
    }
  } else {
    const latest = row.latest;
    if (latest && latest.players != null) setStat(card, 'players', String(latest.players), latest.maxPlayers != null ? '/ ' + latest.maxPlayers : '');
    else setStat(card, 'players', '…', 'starting');
    const samples = (latest && homeMetrics.samples[row.name]) || [];
    setStat(card, 'tps', latest && latest.tps != null ? latest.tps.toFixed(1) : '…', '', '',
      { values: samples.filter((s) => s.tps != null).map((s) => s.tps), max: 20 });
    const ceiling = memoryCeilingMb(row.memory);
    if (latest && Number.isFinite(latest.rss)) {
      const gb = latest.rss >= 1024;
      const allotted = ceiling ? '/ ' + gbOf(ceiling) + ' GB' : 'GB';
      const rss = samples.map((s) => s.rss).filter((v) => Number.isFinite(v));
      setStat(card, 'memory', gb ? (latest.rss / 1024).toFixed(1) : String(latest.rss), gb ? allotted : 'MB ' + allotted, '',
        { values: rss, max: Math.max(ceiling || 0, ...rss, 256) });
    } else setStat(card, 'memory', '…');
  }

  // The databases only this server uses, inside its card; the ones it shares, named.
  const links = card.querySelector('.sc-links');
  const owned = ownedDbs(row.name);
  const keep = new Set(owned.map((d) => d.name));
  for (const l of Array.from(links.children)) if (!keep.has(l.dataset.name)) l.remove();
  owned.forEach((db, i) => {
    let link = links.querySelector('.sc-link[data-name="' + CSS.escape(db.name) + '"]');
    if (!link) link = buildDbLink(db);
    updateDbLink(link, db);
    if (links.children[i] !== link) links.insertBefore(link, links.children[i] || null);
  });
  const shared = (state.dbs || []).filter((d) => d.attachments && d.attachments[row.name] && !keep.has(d.name));
  const dbLine = card.querySelector('.sc-dbs');
  dbLine.textContent = '';
  if (shared.length) {
    const b = document.createElement('b');
    b.textContent = shared.length === 1 ? 'Shared database ' : 'Shared databases ';
    dbLine.append(b, shared.map((d) => d.label || d.name).join(', '));
  }

  const note = cardNote(row);
  const noteEl = card.querySelector('.sc-note');
  // Keyed without the time, which is refreshed in place: a rebuild would take the focus off "Set up
  // backups" each time a minute ticks over.
  const said = JSON.stringify({ ...note, strong: note.lead === 'Last backup' ? '' : note.strong });
  if (noteEl.dataset.said === said && note.strong) {
    const b = noteEl.querySelector('b');
    if (b && b.textContent !== note.strong) b.textContent = note.strong;
  }
  if (noteEl.dataset.said !== said) {
    noteEl.dataset.said = said;
    noteEl.textContent = '';
    if (note.icon) noteEl.append(icon(note.icon));
    const words = document.createElement('span');
    if (note.lead) words.append(note.lead + (note.strong ? ' ' : ''));
    if (note.strong) {
      const b = document.createElement('b');
      b.textContent = note.strong;
      words.append(b);
    }
    if (note.text) words.append((note.lead || note.strong ? ' · ' : '') + note.text);
    noteEl.append(words);
    if (note.link) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'more-link';
      link.textContent = note.link;
      link.setAttribute('aria-label', note.link + ' for ' + name);
      link.onclick = () => openServerTool(row.name, 'backups');
      noteEl.append(link);
    }
  }
  if (note.tone) noteEl.dataset.tone = note.tone;
  else delete noteEl.dataset.tone;
}

/** Keyed, like the tabs: a card is built once and its words changed in place on every poll. */
function renderHomeCards() {
  const box = $('#homeCards');
  const seen = new Set();
  state.rows.forEach((row, i) => {
    seen.add(row.name);
    let card = box.querySelector('.scard[data-name="' + CSS.escape(row.name) + '"]');
    if (!card) card = buildHomeCard(row.name);
    updateHomeCard(card, row);
    if (box.children[i] !== card) box.insertBefore(card, box.children[i] || null);
  });
  for (const card of Array.from(box.children)) if (!seen.has(card.dataset.name)) card.remove();
}

$('#homeNew').onclick = () => openAdd('new');

/**
 * How many polls in a row have failed. One is a blip. Three is the backend gone - the panel process
 * closed, or the desktop app's core wedged - and until this said so the page kept every card at
 * "Running" with Start and Stop enabled, and the only symptom was the console going blank.
 */
let missedPolls = 0;
let refreshing = false;

function lostContact(on) {
  const existing = $('#lostBanner');
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const bar = document.createElement('div');
  bar.id = 'lostBanner';
  bar.className = 'banner';
  bar.setAttribute('role', 'alert');
  const b = document.createElement('b');
  b.textContent = 'Lost contact with SpawnLoft.';
  const text = document.createElement('span');
  text.className = 'grow';
  text.textContent = ' The panel process has stopped or is not answering, so nothing shown here is current. '
    + 'Your servers are separate processes and keep running.';
  bar.append(b, text);
  $('#banner').prepend(bar);
}

// Polled with the servers, since a game closed from its own window changes nothing here; the
// cards and the menu are rebuilt only when a profile or its running state changed.
// One request at a time, so a late answer cannot overwrite a newer one.
let loadingProfiles = null;
function loadClientProfiles() {
  if (!loadingProfiles) loadingProfiles = fetchClientProfiles().finally(() => { loadingProfiles = null });
  return loadingProfiles;
}
async function fetchClientProfiles() {
  let next;
  try { next = await api('/client/profiles') } catch { next = [] }
  if (JSON.stringify(next) === JSON.stringify(state.clientProfiles)) return;
  state.clientProfiles = next;
  showPlayState();
  renderHomeCards();
  if (state.current) buildMoreMenu();
}
// A Fabric or NeoForge server wants a setup on its loader (Quilt loads Fabric's mods); with none
// of those, the launcher opens a new setup on that loader.
function playProfileFor(row, profiles = state.clientProfiles) {
  const needs = row.loader === 'fabric' || row.loader === 'neoforge' ? row.loader : null;
  const fits = profiles.filter((p) => (!row.mcVersion || p.mc === row.mcVersion) && (!needs || p.loader === needs || (needs === 'fabric' && p.loader === 'quilt')));
  return fits.find((p) => p.server === row.name) ?? fits[0] ?? null;
}
// The game launcher: the Play page, the /launcher document in a frame of the panel's own stage,
// in the desktop app and a browser alike. Loaded the first time Play is pressed and kept loaded
// after, so a launch under way keeps its progress while a server is open and coming back is
// instant. /launcher stays a page of its own for `spawnloft ui --launcher` and a browser.
function showPlay() {
  const frame = $('#playFrame');
  if (!frame.getAttribute('src')) frame.src = '/launcher';
  // a sheet left open on the way here is not somewhere to come back to
  sheetStack.length = 0;
  show('play');
  focusPlay();
}
// Focus lands on the card's Play button when the page is there, on the frame while it loads
// (same origin, so the page's document is ours to reach; anything else keeps the frame's focus).
function focusPlay() {
  const frame = $('#playFrame');
  try {
    const button = frame.contentDocument && frame.contentDocument.getElementById('play');
    if (button && !button.disabled) { button.focus(); return; }
  } catch { /* not loaded, or not ours */ }
  frame.focus();
}
// Every Play in the panel is the Play page's Play: a server card or the More menu hands the
// page a note ({ mc, server, profile, play }) and opens it, and the page picks the setup, points
// it at the server and starts the launch with its own progress, Cancel and errors. With no
// setup that fits, the page opens its New setup form filled in for the server. The note goes to
// this panel's own frame and nowhere else, as a message: at once when the page is loaded, and
// when it says it is ready otherwise. It is never stored, so it cannot start a game another day.
let playReady = false;
let playNote = null;
function sendPlayNote() {
  if (!playNote || !playReady) return;
  const note = playNote;
  playNote = null;
  try { $('#playFrame').contentWindow.postMessage({ type: 'spawnloft-play-note', note }, location.origin) } catch { /* the frame is gone: nothing to tell */ }
}
function openLauncherFor(row, profile = null) {
  playNote = { mc: row.mcVersion || null, server: row.name };
  if (profile) { playNote.profile = profile.name; playNote.play = !profile.running; }
  showPlay();
  sendPlayNote();
}
function playClient(row) {
  openLauncherFor(row, playProfileFor(row));
}
// What the Play page says about itself (launcher.html, tellPanel): a launch under way or a game
// running shows on the sidebar's Play button, whichever page is open.
let playState = { launching: null, running: [] };
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== $('#playFrame').contentWindow) return;
  const d = e.data;
  if (d && d.type === 'spawnloft-play-ready') { playReady = true; sendPlayNote(); return; }
  if (!d || d.type !== 'spawnloft-play-state') return;
  playState = { launching: typeof d.launching === 'string' ? d.launching : null, running: Array.isArray(d.running) ? d.running.filter((n) => typeof n === 'string') : [] };
  showPlayState();
  lockBehindPlay.on = d.modal === true;
  lockBehindPlay();
});
// The Play page's setup sheet is a dialog, but the page is a frame: what is around the frame
// (the top bar, the sidebar) would stay clickable and in the Tab order behind it. While the
// sheet is open the panel dims those and takes them out of reach; they come back when it closes.
function lockBehindPlay() {
  const locked = lockBehindPlay.on === true && $('#vPlay').offsetParent !== null;
  document.body.classList.toggle('play-modal', locked);
  for (const el of [document.querySelector('body > header'), $('#side')]) if (el) el.inert = locked;
}
function showPlayState() {
  // before the frame has loaded, the profiles poll is what is known
  const running = playState.running.length ? playState.running : state.clientProfiles.filter((p) => p.running).map((p) => p.name);
  const b = $('#bLauncher');
  const what = playState.launching ? 'launching' : running.length ? 'running' : '';
  if (what) b.dataset.state = what; else delete b.dataset.state;
  const words = playState.launching ? 'Play: starting ' + playState.launching : running.length ? 'Play: ' + running.join(', ') + (running.length === 1 ? ' is' : ' are') + ' running' : 'Play';
  b.title = words;
  b.setAttribute('aria-label', words);
}
async function refresh() {
  // One poll at a time. A stalled request otherwise piles up behind itself, and responses landing
  // out of order overwrite newer rows with older ones.
  if (refreshing) return;
  refreshing = true;
  let rows;
  let dbs;
  try {
    [rows, dbs] = await Promise.all([api('/instances'), api('/databases')]);
  } catch {
    if (++missedPolls === 3) lostContact(true);
    refreshing = false;
    return;
  }
  refreshing = false;
  if (missedPolls >= 3) lostContact(false);
  missedPolls = 0;
  state.rows = rows;
  state.dbs = dbs;

  if (state.current && !rowOf(state.current)) {
    // Removed underneath us, by this panel or another one.
    stopStream();
    stopVitals();
    state.current = null;
    if (state.view === 'server') showHome();
  }
  renderList(rows, dbs);
  renderJavaChip();
  loadClientProfiles();

  if (!state.current) {
    if (state.view === 'empty' || state.view === 'home') showHome();
    return;
  }
  if (state.view === 'server') {
    renderServer(rowOf(state.current));
    followServer(rowOf(state.current));
  }
}

