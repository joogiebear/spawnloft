'use strict';
// ------------------------------------------------------------ server tabs ---

function buildTab(row) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'stab';
  el.dataset.name = row.name;
  if (isDb(row)) el.dataset.kind = 'database';
  const glyph = document.createElement('span');
  glyph.className = 'stab-ico';
  const lamp = document.createElement('span');
  lamp.className = 'lamp';
  // A key-value store is not a table store, and the two need different things from the person
  // (no schema, no SQL dumps): the glyph says which before the name does.
  glyph.append(icon(!isDb(row) ? 'server' : row.engineKind === 'redis' ? 'cache' : 'database'), lamp);
  const nm = document.createElement('span');
  nm.className = 'nm';
  const note = document.createElement('span');
  note.className = 'note';
  el.append(glyph, nm, note);
  el.onclick = () => openServer(el.dataset.name);
  return el;
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
  el.querySelector('.nm').textContent = row.label || row.name;
  const note = tabNote(row);
  const noteEl = el.querySelector('.note');
  noteEl.textContent = note ? note.text : '';
  if (note && note.tone) noteEl.dataset.tone = note.tone;
  else delete noteEl.dataset.tone;
  const said = crashedNow(row) ? 'Crashed' : (STATE_TEXT[row.status] ?? row.status);
  el.title = (row.label || row.name) + ' — ' + said
    + (note && note.title && !note.tone ? ' — ' + note.title : '')
    + (row.onlineMode === false ? ' — offline mode' : '');
  // Read out as a sentence rather than the spans run together: "Survival, running, 2 players
  // online", not "Survival2".
  el.setAttribute('aria-label', [row.label || row.name, said.toLowerCase(), note && note.title && !note.tone ? note.title : '']
    .filter(Boolean).join(', '));
}

/**
 * Mark the open server, and hang its sections under it. The dock is one element that moves: it
 * sits under whichever row is current, and goes back to the sidebar, hidden, when none is.
 */
function markTabs() {
  // A sheet or the Play page covers the stage, so the server behind it is not where the person
  // is: lighting its row would say otherwise. The Add sheet and Play light their own buttons.
  const onSheet = SHEETS.has(state.view);
  $('#tabHome').setAttribute('aria-current', state.current || onSheet ? 'false' : 'page');
  $('#bNew').setAttribute('aria-current', state.view === 'add' ? 'page' : 'false');
  $('#bLauncher').setAttribute('aria-current', state.view === 'play' ? 'page' : 'false');
  const dock = $('#dock');
  let current = null;
  for (const el of $$('#list .stab[data-name]')) {
    const on = !onSheet && el.dataset.name === state.current;
    el.setAttribute('aria-current', on ? 'page' : 'false');
    if (on) current = el;
  }
  // Moved only when it is in the wrong place: taking a node out of the document blurs whatever
  // inside it had focus, and this runs on every four-second refresh.
  if (current && state.view === 'server') {
    if (current.nextElementSibling !== dock) current.after(dock);
    dock.hidden = false;
  } else {
    dock.hidden = true;
    if (dock.parentNode !== $('.srv-tabs')) $('.srv-tabs').append(dock);
  }
  syncRoving();
}

/*
  The sidebar is one Tab stop, not one per row: with a server open that was fifteen stops before
  the stage. Up and Down walk the rows and the open server's tools in the order they are drawn,
  Home and End jump to the ends, Right opens a server or steps into its tools, Left steps back out
  to the server. Enter and Space are the buttons' own.
*/
const sideItems = () => $$('#list button').filter((b) => !b.closest('[hidden]') && b.offsetParent !== null);

/** Leave the one Tab stop on the focused row, or else on the row that is open. */
function syncRoving() {
  const items = sideItems();
  const anchor = items.includes(document.activeElement) ? document.activeElement
    : items.find((b) => b.classList.contains('stab') && b.getAttribute('aria-current') === 'page') || items[0];
  for (const b of $$('#list button')) b.tabIndex = b === anchor ? 0 : -1;
}

$('#list').addEventListener('focusin', syncRoving);
$('#list').addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const items = sideItems();
  const at = document.activeElement;
  const i = items.indexOf(at);
  if (i < 0) return;
  const dock = $('#dock');
  let to = null;
  if (e.key === 'ArrowDown') to = items[Math.min(i + 1, items.length - 1)];
  else if (e.key === 'ArrowUp') to = items[Math.max(i - 1, 0)];
  else if (e.key === 'Home') to = items[0];
  else if (e.key === 'End') to = items[items.length - 1];
  else if (e.key === 'ArrowRight' && at.dataset.name) {
    if (at.getAttribute('aria-current') === 'page' && !dock.hidden) to = dock.querySelector('button');
    else at.click();
  } else if (e.key === 'ArrowLeft' && dock.contains(at)) to = dock.previousElementSibling;
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
  // The sections list rides under the open server's row and is not a server: the positions below
  // are counted without it, and it stays where it is, so a focused button in it keeps its focus.
  const tabs = () => Array.from(list.children).filter((el) => el.id !== 'dock');

  // Overview first, then the servers and the databases, each under its own heading.
  const seen = new Set();
  const order = [{ home: true }];
  if (rows.length) order.push({ heading: 'Servers' }, ...rows);
  if (dbs.length) order.push({ heading: 'Databases' }, ...dbs);
  order.forEach((row, i) => {
    let el;
    if (row.home) {
      el = $('#tabHome');
    } else if (row.heading) {
      el = list.querySelector('.tabs-head[data-group="' + row.heading + '"]');
      if (!el) {
        el = document.createElement('span');
        el.className = 'tabs-head';
        el.dataset.group = row.heading;
        el.textContent = row.heading;
      }
    } else {
      seen.add(row.name);
      el = list.querySelector('[data-name="' + CSS.escape(row.name) + '"]');
      if (!el) el = buildTab(row);
      updateTab(el, row);
    }
    const at = tabs();
    if (at[i] !== el) list.insertBefore(el, at[i] || null);
  });
  for (const el of tabs()) {
    if (el.dataset.name && !seen.has(el.dataset.name)) el.remove();
    if (el.classList.contains('tabs-head') && !order.some((o) => o.heading === el.dataset.group)) el.remove();
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

