'use strict';
// ------------------------------------------------------------ server tabs ---

/**
 * A row of the sidebar: the server's face, its name over its software, and its state as a dot.
 * The face is its own server-icon.png when it has one (asked for once, and swapped in only when it
 * loads, so a server without one never shows a broken picture), otherwise its initial on the colour
 * its id picks. A database has its kind's glyph instead.
 */
function buildTab(row) {
  const db = isDb(row);
  const face = Kit.tile({
    name: row.label || row.name, key: row.name, size: 'sm',
    icon: db ? (row.engineKind === 'redis' ? 'cache' : 'database') : null,
  });
  const el = Kit.h('button', { type: 'button', class: 'sl-nav-item sl-nav-item-rich', dataset: { name: row.name } },
    face,
    Kit.h('span', { class: 'sl-nav-text' }, Kit.h('span', { class: 'sl-nav-name' }), Kit.h('span', { class: 'sl-nav-meta' })),
    Kit.dot());
  if (db) el.dataset.kind = 'database';
  else withServerIcon(row.name, (src) => face.replaceChildren(iconImage(src)));
  el.onclick = () => openServer(el.dataset.name);
  return el;
}

/*
  A server's own icon, asked for once per server and shared by its sidebar row and its header: a
  server without one answers 404, and that should be one request, not one per switch. Change icon
  and Remove icon call refreshServerIcon, which asks again and redraws both.
*/
const serverIcons = new Map();
let iconAsk = 0;

function withServerIcon(name, use) {
  let known = serverIcons.get(name);
  if (!known) {
    known = { src: undefined, waiting: [] };
    serverIcons.set(name, known);
    const img = new Image();
    img.onload = () => { known.src = img.src; for (const fn of known.waiting.splice(0)) fn(known.src); };
    img.onerror = () => { known.src = null; known.waiting.length = 0; };
    // the number makes a new address after a change, so the browser cannot answer from memory
    img.src = '/api/instances/' + encodeURIComponent(name) + '/icon?v=' + iconAsk;
  }
  if (known.src) use(known.src);
  else if (known.src === undefined) known.waiting.push(use);
}

function iconImage(src) {
  const img = new Image();
  img.alt = '';
  img.src = src;
  return img;
}

function refreshServerIcon(name) {
  serverIcons.delete(name);
  iconAsk++;
  const row = rowOf(name);
  const el = $('#list [data-name="' + CSS.escape(name) + '"]');
  if (row && el) {
    const face = Kit.tile({ name: row.label || row.name, key: row.name, size: 'sm' });
    el.querySelector('.sl-tile').replaceWith(face);
    withServerIcon(name, (src) => face.replaceChildren(iconImage(src)));
  }
  const tile = $('#srvTile');
  if (row && tile.dataset.said && tile.dataset.said.startsWith(name + '|')) {
    delete tile.dataset.said;
    renderServerTile(row);
  }
}

/** The state of a row as a dot: its tone, whether it breathes, and hollow for stopped. */
function tabDot(row) {
  if (crashedNow(row)) return { tone: 'fault' };
  switch (row.status) {
    case 'running': case 'reachable': return { tone: 'live' };
    case 'stopping': case 'stale': return { tone: 'warn', busy: true };
    case 'orphaned': case 'unknown': case 'unreachable': return { tone: 'fault' };
    default: return { hollow: true };
  }
}

/** The line under a row's name: what it runs, or that it crashed, and who is on. */
function tabMeta(row) {
  if (isDb(row)) return (row.engineLabel || row.engine || 'Database') + (row.version ? ' ' + row.version : '');
  if (crashedNow(row)) return 'Crashed';
  const sw = softwareById[row.loader ?? 'paper'];
  const what = (sw ? sw.label : (row.loader || 'Paper')) + (row.mcVersion ? ' ' + row.mcVersion : '');
  const n = row.status === 'running' && row.latest ? row.latest.players : null;
  return n == null ? what : what + ' \u00b7 ' + n + ' online';
}

/** The small word beside a tab's name: who is on while it runs, and "crashed" after a crash. */
function tabNote(row) {
  if (isDb(row)) return null;
  if (row.status === 'running') {
    const n = row.latest && row.latest.players;
    if (n == null) return null;
    return { text: String(n), title: n === 1 ? '1 player online' : n + ' players online' };
  }
  if (crashedNow(row)) return { text: 'crashed', tone: 'fault', title: 'Crashed' };
  return null;
}

function updateTab(el, row) {
  el.dataset.status = row.status;
  el.toggleAttribute('data-crashed', crashedNow(row));
  el.querySelector('.sl-nav-name').textContent = row.label || row.name;
  const meta = el.querySelector('.sl-nav-meta');
  meta.textContent = tabMeta(row);
  meta.toggleAttribute('data-fault', crashedNow(row));
  const dot = el.querySelector('.sl-dot');
  const st = tabDot(row);
  if (st.tone) dot.dataset.tone = st.tone;
  else delete dot.dataset.tone;
  dot.toggleAttribute('data-busy', Boolean(st.busy));
  dot.toggleAttribute('data-hollow', Boolean(st.hollow));
  const note = tabNote(row);
  const said = crashedNow(row) ? 'Crashed' : (STATE_TEXT[row.status] ?? row.status);
  el.title = (row.label || row.name) + ' \u2014 ' + said
    + (note && note.title && !note.tone ? ' \u2014 ' + note.title : '')
    + (row.onlineMode === false ? ' \u2014 offline mode' : '');
  // Read out as a sentence rather than the spans run together: "Survival, running, 2 players
  // online", not "SurvivalPaper 1.21".
  el.setAttribute('aria-label', [row.label || row.name, said.toLowerCase(), note && note.title && !note.tone ? note.title : '']
    .filter(Boolean).join(', '));
}

/** Light the row of what is on the stage: Overview, Play, the Add sheet's button, or a server. */
function markTabs() {
  // A sheet or the Play page covers the stage, so the server behind it is not where the person
  // is: lighting its row would say otherwise. The Add sheet and Play light their own buttons.
  const onSheet = SHEETS.has(state.view);
  $('#tabHome').setAttribute('aria-current', state.current || onSheet ? 'false' : 'page');
  $('#bNew').setAttribute('aria-current', state.view === 'add' ? 'page' : 'false');
  $('#bLauncher').setAttribute('aria-current', state.view === 'play' ? 'page' : 'false');
  for (const el of $$('#list [data-name]')) {
    el.setAttribute('aria-current', !onSheet && el.dataset.name === state.current ? 'page' : 'false');
  }
  syncRoving();
}

/*
  The sidebar is one Tab stop, not one per row: with a dozen servers that was a dozen stops before
  the stage. Up and Down walk the rows in the order they are drawn, Home and End jump to the ends.
  Enter and Space are the buttons' own.
*/
const sideItems = () => $$('#list button').filter((b) => !b.closest('[hidden]') && b.offsetParent !== null);

/** Leave the one Tab stop on the focused row, or else on the row that is open. */
function syncRoving() {
  const items = sideItems();
  const anchor = items.includes(document.activeElement) ? document.activeElement
    : items.find((b) => b.classList.contains('sl-nav-item') && b.getAttribute('aria-current') === 'page') || items[0];
  for (const b of $$('#list button')) b.tabIndex = b === anchor ? 0 : -1;
}

$('#list').addEventListener('focusin', syncRoving);
$('#list').addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const items = sideItems();
  const at = document.activeElement;
  const i = items.indexOf(at);
  if (i < 0) return;
  let to = null;
  if (e.key === 'ArrowDown') to = items[Math.min(i + 1, items.length - 1)];
  else if (e.key === 'ArrowUp') to = items[Math.max(i - 1, 0)];
  else if (e.key === 'Home') to = items[0];
  else if (e.key === 'End') to = items[items.length - 1];
  else return;
  e.preventDefault();
  if (to) to.focus();
});

/**
 * Reconcile the tabs against the DOM rather than rewriting them.
 *
 * The old panel rebuilt innerHTML every four seconds, which threw away focus, text selection and
 * scroll position on a timer. Keyed updates leave whatever is being touched alone.
 */
function renderList(rows, dbs) {
  dbs = dbs || [];
  const list = $('#list');
  document.body.classList.toggle('bare', rows.length === 0 && dbs.length === 0);
  const items = () => Array.from(list.children);

  // Overview and Play, the servers under their heading (which carries the + and so is always
  // there), then the databases under theirs.
  const seen = new Set();
  const order = [$('#tabHome'), $('#bLauncher'), $('#serversHead'), ...rows];
  if (dbs.length) order.push({ heading: 'Databases' }, ...dbs);
  order.forEach((row, i) => {
    let el;
    if (row instanceof Element) {
      el = row;
    } else if (row.heading) {
      el = list.querySelector('.sl-nav-head[data-group="' + row.heading + '"]');
      if (!el) {
        el = Kit.navHead(row.heading);
        el.dataset.group = row.heading;
      }
    } else {
      seen.add(row.name);
      el = list.querySelector('[data-name="' + CSS.escape(row.name) + '"]');
      if (!el) el = buildTab(row);
      updateTab(el, row);
    }
    const at = items();
    if (at[i] !== el) list.insertBefore(el, at[i] || null);
  });
  for (const el of items()) {
    const gone = (el.dataset.name && !seen.has(el.dataset.name)) || (el.dataset.group === 'Databases' && !dbs.length);
    if (gone) el.remove();
  }
  markTabs();
}

/** A tab was pressed. The server already open behind a sheet just comes back to the front. */
function openServer(name) {
  if (name === state.current && state.streamName === name) {
    sheetStack.length = 0;
    show('server');
    renderServer(rowOf(name));
    markTabs();
    return;
  }
  select(name);
}

/** The Overview tab. Until the Overview screen exists it is the "pick a server" screen. */
function goHome() {
  sheetStack.length = 0;
  stopStream();
  stopVitals();
  stopPerfPolling();
  state.current = null;
  showHome();
  markTabs();
}
$('#tabHome').onclick = goHome;

