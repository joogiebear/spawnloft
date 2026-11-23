'use strict';
// ---- the server cards ----------------------------------------------------------

/*
  A server's card on the Overview. Running, it is the large one: who it is, the verbs, and four
  numbers. Stopped, it is one row: who it is, and Start. One element either way, built once and
  changed in place on every poll, so the button someone is about to press is the same button when
  the server's state flips under it.
*/
const CARD_LIVE = 'gap-4.5';

/** A state as the pill beside a name; paint() sets its words, tone and dot from a row. */
function statePill() {
  const dot = Kit.dot({});
  const words = Kit.h('span', { 'data-state-text': '' });
  const pill = Kit.h('span', { class: 'sl-pill' }, dot, words);
  pill.paint = (row, acting) => {
    const said = describeState(row, acting);
    words.textContent = said.text;
    for (const el of [pill, dot]) {
      if (said.tone) el.dataset.tone = said.tone;
      else delete el.dataset.tone;
    }
    dot.toggleAttribute('data-busy', said.tone === 'warn' && (Boolean(acting) || row.status === 'stopping'));
    dot.toggleAttribute('data-hollow', !said.tone && row.status === 'stopped');
    // The uptime ticker (15-server-tools.js) rewrites the words each second from this.
    if (said.since) words.dataset.since = String(said.since);
    else delete words.dataset.since;
  };
  return pill;
}

/** Live-number sparkline: the last ten minutes, drawn small beside a figure. */
function homeSpark(values, max) {
  const svg = svgNode('svg', { viewBox: '0 0 64 18', preserveAspectRatio: 'none', 'aria-hidden': 'true', class: 'ml-2 hidden h-4.5 w-16 flex-none overflow-visible align-middle @min-[720px]/card:inline-block' });
  if (values.length < 2) return svg;
  const step = 64 / (values.length - 1);
  const points = values.map((v, i) => (i * step).toFixed(1) + ',' + (17 - Math.min(1, Math.max(0, v / max)) * 16).toFixed(1));
  const line = svgNode('polyline', { points: points.join(' '), fill: 'none', 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' });
  line.style.stroke = 'var(--chart-cpu)';
  svg.append(line);
  return svg;
}
const svgNode = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** A number in a stat's place: its figure, its unit after it, and optionally a line beside. */
function paintStat(stat, value, unit, { tone, spark } = {}) {
  const v = stat.querySelector('.sl-stat-value');
  const kids = [String(value)];
  if (unit) kids.push(Kit.h('span', { class: 'sl-stat-unit', text: unit }));
  if (spark && spark.values.length > 1) kids.push(homeSpark(spark.values, spark.max));
  v.replaceChildren(...kids);
  v.classList.toggle('text-warn-ink', tone === 'warn');
}

function buildHomeCard(name) {
  const tileSlot = Kit.h('span', { class: 'contents' });
  const nameButton = Kit.h('button', { type: 'button', class: 'sl-btn sl-btn-link block min-w-0 max-w-full truncate text-ink', onclick: () => select(name) });
  const pill = statePill();
  const meta = Kit.h('div', { class: 'm-0 flex min-w-0 flex-wrap items-center gap-x-1.5 type-meta text-ink-3' });
  const act = Kit.button({ label: 'Start', onClick: () => cardAct(name) });
  const play = Kit.button({ label: 'Play', onClick: () => playClient(rowOf(name)) });
  const open = Kit.button({ label: 'Open', onClick: () => select(name) });
  const stats = Kit.h('div', { class: 'grid grid-cols-2 gap-3 border-t border-line-soft pt-4 @narrow/card:grid-cols-4' },
    ...['Players', 'TPS', 'Memory', 'Last backup'].map((label) => Kit.stat({ label })));
  const links = Kit.h('div', { class: 'flex flex-col gap-2 empty:hidden' });
  const card = Kit.h('article', { class: 'sl-card @container/card', dataset: { name } },
    Kit.h('div', { class: 'sl-card-head' },
      tileSlot,
      Kit.h('div', { class: 'min-w-0 flex-[1_1_240px]' },
        Kit.h('div', { class: 'flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1' }, Kit.h('h2', { class: 'm-0 min-w-0 max-w-full' }, nameButton), pill),
        meta),
      Kit.h('div', { class: 'flex flex-wrap gap-2' }, act, play, open)),
    stats, links);
  card.parts = { tileSlot, nameButton, pill, meta, act, play, open, stats, links };
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
 * How a server is looked after, for the one number a running card shows: when it was last backed
 * up. A server with no backup on disk says so in the warning's colour; "Never" only when it truly
 * never was. The page says what to do about it once, in Needs attention.
 */
function cardBackup(row) {
  const b = backupState(row);
  if (!b) return { value: '—', unit: overview.failed ? 'not known' : 'checking' };
  if (b.none) return { value: b.gone ? 'None kept' : 'Never', tone: 'warn' };
  const said = ago(new Date(b.lastAt).toISOString()) || 'just now';
  const old = !b.auto && Date.now() - b.lastAt >= 7 * DAY_MS;
  // "3h ago" is a figure and a unit; "just now" is neither
  const m = /^(\d+\w*)\s+(.+)$/.exec(said);
  return m ? { value: m[1], unit: m[2], tone: old ? 'warn' : '' } : { value: said, tone: old ? 'warn' : '' };
}

/** A button's word, and whether it is the one doing something right now. */
function setVerb(button, label, busy, disabled, name) {
  button.replaceChildren(busy ? ACTION_ING[busy] + '…' : label);
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  button.disabled = disabled;
  button.setAttribute('aria-label', (busy ? ACTION_ING[busy] : label) + ' ' + name);
}

function updateHomeCard(card, row) {
  const { tileSlot, nameButton, pill, meta, act, play, open, stats, links } = card.parts;
  const name = row.label || row.name;
  const acting = overview.acting[row.name];
  const live = row.status === 'running' || row.status === 'stopping';
  card.dataset.status = row.status;
  card.dataset.live = live ? '1' : '';
  card.toggleAttribute('data-crashed', crashedNow(row));
  // the large card runs; the stopped one is a row
  card.classList.toggle('py-3.5', !live);
  card.classList.toggle(CARD_LIVE, live);
  nameButton.classList.toggle('type-section', live);
  nameButton.classList.toggle('type-card', !live);
  nameButton.textContent = name;
  nameButton.setAttribute('aria-label', 'Open ' + name);
  pill.paint(row, acting);

  const faceKey = row.name + '|' + name + '|' + live + '|' + iconAsk;
  if (tileSlot.dataset.said !== faceKey) {
    tileSlot.dataset.said = faceKey;
    const face = Kit.tile({ name, key: row.name, size: live ? 'lg' : 'md' });
    tileSlot.replaceChildren(face);
    // its own icon when it has one, else the initial on its colour
    withServerIcon(row.name, (src) => { if (tileSlot.dataset.said === faceKey) face.replaceChildren(iconImage(src)); });
  }

  // Who it is: software and version, where it answers, and why it is not running when it is not.
  const sw = softwareById[row.loader ?? 'paper'];
  const addr = row.port ? 'localhost:' + row.port : '';
  const what = (sw ? sw.label : (row.loader || 'Paper')) + (row.mcVersion ? ' ' + row.mcVersion : '');
  const shared = (state.dbs || []).filter((d) => d.attachments && d.attachments[row.name] && !ownedDbs(row.name).includes(d));
  let note = null;
  if (!live) {
    if (javaShort(row)) note = { tone: 'fault', text: 'Needs Java ' + row.javaNeeds + ' to start' };
    else if (crashedNow(row)) note = { tone: 'fault', text: 'Crashed, open the console to see why' };
    else if (row.stoppedAt && !acting) note = { text: 'Stopped ' + (ago(new Date(row.stoppedAt).toISOString()) || 'just now') };
  }
  const metaKey = JSON.stringify([what, addr, shared.map((d) => d.name), note && note.text]);
  if (meta.dataset.said !== metaKey) {
    meta.dataset.said = metaKey;
    meta.textContent = '';
    meta.append(what, Kit.h('span', { 'aria-hidden': 'true', text: '·' }), addr ? addrButton(addr) : 'port not known yet');
    if (shared.length) meta.append(Kit.h('span', { 'aria-hidden': 'true', text: '·' }), (shared.length === 1 ? 'Shared database ' : 'Shared databases ') + shared.map((d) => d.label || d.name).join(', '));
    if (note) {
      meta.append(Kit.h('span', { 'aria-hidden': 'true', text: '·' }), Kit.h('span', { class: note.tone === 'fault' ? 'text-fault-ink' : '', text: note.text }));
    }
  }

  const verb = cardVerb(row);
  const blocked = Boolean(acting) || row.status === 'stopping' || Boolean(state.busy && state.current === row.name);
  act.classList.toggle('sl-btn-primary', verb.primary);
  const busy = acting && acting !== 'restart' ? acting : row.status === 'stopping' ? 'stop' : acting === 'restart' ? 'restart' : null;
  setVerb(act, verb.label, busy, blocked, name);
  // Play joins a running server; a stopped one is started from the Play page's own list
  play.hidden = !live;
  const pp = playProfileFor(row);
  play.textContent = pp && pp.running ? 'Playing' : 'Play';
  play.title = !pp ? 'Opens the Play page to make a setup for this server' : pp.running ? pp.name + ' is running: opens it on the Play page' : 'Starts ' + pp.name + ' on the Play page, pointed at this server';
  open.setAttribute('aria-label', 'Open ' + name);

  // Live figures only while it runs.
  stats.hidden = !live;
  if (live) {
    const latest = row.latest;
    const [players, tps, memory, backup] = Array.from(stats.children);
    if (latest && latest.players != null) paintStat(players, String(latest.players), latest.maxPlayers != null ? 'of ' + latest.maxPlayers : '');
    else paintStat(players, '—', 'no reply yet');
    const samples = (latest && homeMetrics.samples[row.name]) || [];
    paintStat(tps, latest && latest.tps != null ? latest.tps.toFixed(1) : '—', '', { spark: { values: samples.filter((s) => s.tps != null).map((s) => s.tps), max: 20 } });
    const ceiling = memoryCeilingMb(row.memory);
    if (latest && Number.isFinite(latest.rss)) {
      const gb = latest.rss >= 1024;
      const allotted = ceiling ? 'of ' + gbOf(ceiling) + ' GB' : 'GB';
      const rss = samples.map((s) => s.rss).filter((v) => Number.isFinite(v));
      paintStat(memory, gb ? (latest.rss / 1024).toFixed(1) : String(latest.rss), gb ? allotted : 'MB ' + allotted,
        { spark: { values: rss, max: Math.max(ceiling || 0, ...rss, 256) } });
    } else paintStat(memory, '—');
    const b = cardBackup(row);
    paintStat(backup, b.value, b.unit, { tone: b.tone });
  }

  // The databases only this server uses, inside its card.
  const owned = ownedDbs(row.name);
  const keep = new Set(owned.map((d) => d.name));
  for (const l of Array.from(links.children)) if (!keep.has(l.dataset.name)) l.remove();
  owned.forEach((db, i) => {
    let link = links.querySelector('[data-name="' + CSS.escape(db.name) + '"]');
    if (!link) link = buildDbLink(db);
    updateDbLink(link, db);
    if (links.children[i] !== link) links.insertBefore(link, links.children[i] || null);
  });
}

/** Keyed, like the tabs: a card is built once and its words changed in place on every poll. */
function renderHomeCards() {
  const box = $('#homeCards');
  const seen = new Set();
  // The ones that are running first: they are what is happening; the rest are a list to start from.
  const ordered = state.rows.map((row, i) => ({ row, i, rank: row.status === 'running' || row.status === 'stopping' ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.row);
  ordered.forEach((row, i) => {
    seen.add(row.name);
    let card = box.querySelector('[data-name="' + CSS.escape(row.name) + '"]');
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
  // a launch under way or a game running, seen from any page
  const dot = $('#playDot');
  dot.hidden = !what;
  dot.dataset.tone = what === 'launching' ? 'warn' : 'live';
  dot.toggleAttribute('data-busy', what === 'launching');
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

