'use strict';
// --------------------------------------------------------------- overview ---

/**
 * Where the Overview tab goes: every server at once once there are any, and the two doors in when
 * there are none - the doors are the whole point of the screen when there is nothing.
 */
function showHome() {
  // the console window: only a server that is really gone says so; one not yet selected waits
  if (consoleOnly) { if (!rowOf(consoleOnly)) consoleGone(); return; }
  const any = state.rows.length > 0;
  show(any ? 'home' : 'empty');
  if (!any) {
    $('#emptyTitle').textContent = 'No servers yet';
    $('#emptyLede').textContent = 'SpawnLoft runs Minecraft servers on this machine — start them, watch the console, send commands, and reset a world without going near a terminal.';
    $('#emptyDoors').hidden = false;
    return;
  }
  renderOverview();
  loadOverview();
}

/*
  What the server list does not carry: when each server was last backed up, whether it backs itself
  up, and how much memory the machine has. Asked for when the overview shows and then twice a
  minute at most - a backup is minutes apart at the closest - and after anything here changes it.
*/
const overview = { data: null, failed: false, asked: 0, showAll: false, attention: '', acting: {} };

// Activity is fetched this deep so that, once runs are folded into one line each, there is still
// more than a screenful to show.
const FEED_FETCH = 60;
const FEED_SHOWN = 8;

async function loadOverview(force) {
  if (!force && Date.now() - overview.asked < 30000) return;
  overview.asked = Date.now();
  try {
    // The history rides along: the same "what changed" the servers' Activity tools answer, across
    // all of them, newest first.
    // Deep enough that, with runs folded, there is more than the eight lines the feed shows.
    const [data, recent] = await Promise.all([api('/overview'), api('/activity?limit=' + FEED_FETCH).catch(() => null)]);
    overview.data = data;
    overview.activity = recent ? recent.entries : null;
    overview.failed = false;
  } catch {
    // Without it the cards still say everything but the backup ages, so show them.
    overview.failed = true;
    if (state.view === 'home') renderOverview();
    return;
  }
  if (state.view === 'home') renderOverview();
}

const gbOf = (mb) => Math.round((mb / 1024) * 10) / 10;

function renderOverview() {
  const rows = state.rows;
  const dbs = state.dbs || [];
  const running = rows.filter((r) => r.status === 'running');
  const reservedMb = rows.reduce((n, r) => n + (memoryCeilingMb(r.memory) || 0), 0);
  const machineMb = overview.data && overview.data.machine && overview.data.machine.memoryMb;
  const counted = running.filter((r) => r.latest && r.latest.players != null);
  const chips = [
    { n: rows.length, text: rows.length === 1 ? 'server' : 'servers', icon: 'server' },
    { n: running.length, text: 'running', lamp: running.length ? 'running' : 'stopped' },
  ];
  // Only a figure the servers actually gave; "0 players online" from servers that were not asked
  // would be a claim about nobody.
  if (counted.length) {
    const n = counted.reduce((sum, r) => sum + r.latest.players, 0);
    chips.push({ n, text: n === 1 ? 'player online' : 'players online', icon: 'user' });
  }
  if (dbs.length) chips.push({ n: dbs.length, text: dbs.length === 1 ? 'database' : 'databases', icon: 'database' });
  const box = $('#homeSummary');
  box.textContent = '';
  for (const c of chips) {
    const li = document.createElement('li');
    li.className = 'chip';
    if (c.lamp) {
      li.dataset.status = c.lamp;
      const lamp = document.createElement('span');
      lamp.className = 'lamp';
      li.append(lamp);
    } else li.append(icon(c.icon));
    const b = document.createElement('b');
    b.textContent = String(c.n);
    li.append(b, ' ' + c.text);
    box.append(li);
  }
  // Memory: what the servers are allowed to take, against what the machine has, as a bar.
  const mem = document.createElement('li');
  mem.className = 'chip chip-mem';
  mem.title = 'Reserved is what the servers are allowed to use, added up, whether or not they are running.';
  const words = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = String(gbOf(reservedMb));
  words.append(b, machineMb ? ' of ' + Math.round(machineMb / 1024) + ' GB reserved' : ' GB reserved');
  mem.append(icon('pulse'), words);
  if (machineMb) {
    const share = reservedMb / machineMb;
    if (share > 1) mem.dataset.tone = 'fault';
    else if (share > 0.8) mem.dataset.tone = 'warn';
    const meter = document.createElement('span');
    meter.className = 'meter';
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'Memory reserved');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(Math.round(machineMb / 1024)));
    meter.setAttribute('aria-valuenow', String(Math.min(gbOf(reservedMb), Math.round(machineMb / 1024))));
    meter.setAttribute('aria-valuetext', Math.round(share * 100) + '% of this machine' + (share > 1 ? ', more than it has' : ''));
    const fill = document.createElement('i');
    fill.style.width = Math.min(100, Math.max(share > 0 ? 2 : 0, share * 100)).toFixed(1) + '%';
    meter.append(fill);
    mem.append(meter);
  }
  box.append(mem);

  // Said only when there is nothing older to show; a refresh that fails keeps the last answer.
  $('#homeFail').hidden = !(overview.failed && !overview.data);
  if (!overview.data && !overview.failed) $('#vHome').setAttribute('aria-busy', 'true');
  else $('#vHome').removeAttribute('aria-busy');
  renderAttention();
  renderHomeCards();
  renderHomeDbs();
  renderHomeActivity();
  pollHomeMetrics();
}

/*
  The lines beside TPS and memory on a wide card: the last ten minutes, asked for every ten seconds
  while the Overview is showing, only for running servers and only when a card is wide enough to
  draw them. A narrow card asks for nothing.
*/
const homeMetrics = { samples: {}, asked: 0, timer: null };

async function pollHomeMetrics() {
  if (state.view !== 'home' || document.hidden) return;
  if (!homeMetrics.timer) {
    homeMetrics.timer = setInterval(() => {
      if (state.view !== 'home') { clearInterval(homeMetrics.timer); homeMetrics.timer = null; return; }
      pollHomeMetrics();
    }, 10000);
  }
  if (Date.now() - homeMetrics.asked < 9000) return;
  homeMetrics.asked = Date.now();
  const wide = new Set(Array.from($('#homeCards').children).filter((c) => c.clientWidth >= 640).map((c) => c.dataset.name));
  const asks = state.rows.filter((r) => r.status === 'running' && wide.has(r.name)).map((r) =>
    api('/instances/' + encodeURIComponent(r.name) + '/metrics?seconds=600')
      .then((d) => { homeMetrics.samples[r.name] = (d && d.samples) || []; }, () => {}));
  if (!asks.length) return;
  await Promise.all(asks);
  if (state.view === 'home') renderHomeCards();
}

/**
 * Which databases belong inside a server's card: one attached to that server and no other. The
 * rest - shared, or not attached yet - are cards of their own in the Databases block.
 */
function ownedDbs(serverName) {
  return (state.dbs || []).filter((d) => {
    const users = Object.keys(d.attachments || {});
    return users.length === 1 && users[0] === serverName && rowOf(serverName);
  });
}
const nestedDb = (db) => {
  const users = Object.keys(db.attachments || {});
  return users.length === 1 && Boolean(state.rows.find((r) => r.name === users[0]));
};

/** An address as a button that copies it, with the glyph that says so. */
/**
 * The words around a copy button. An address is repeated in them, which is what makes "Copied
 * 127.0.0.1:25565" worth reading. A secret never is: the page masks a password so that it is not
 * left on screen, and a tooltip, a screen reader label or a toast that spells it out undoes that.
 */
function copyWords(text, what, secret) {
  return secret
    ? { title: 'Copy the ' + what, label: 'Copy the ' + what, said: 'the ' + what }
    : { title: 'Copy ' + text, label: 'Copy ' + what + ' ' + text, said: text };
}

function addrButton(text, what = 'address', secret = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'addr-copy';
  b.append(document.createTextNode(text), icon('copy'));
  const words = copyWords(text, what, secret);
  b.title = words.title;
  b.setAttribute('aria-label', words.label);
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!(await copyText(text, words.said))) return;
    // The glyph turns to a tick where the eye already is; the toast is in a corner.
    b.dataset.copied = '';
    b.querySelector('use').setAttribute('href', '#i-check');
    clearTimeout(b.copiedTimer);
    b.copiedTimer = setTimeout(() => {
      delete b.dataset.copied;
      b.querySelector('use').setAttribute('href', '#i-copy');
    }, 1500);
  };
  return b;
}

const dbAddress = (row) => (row.host || '127.0.0.1') + ':' + (row.port || '?');

/**
 * The ways into a server: who each is for, the address they type when this computer knows it,
 * and what else has to be true. "localhost" is only ever right for the person at this keyboard.
 *
 * The internet row has an address only when this computer holds a public one itself. Behind a
 * home router it does not, and finding it would mean asking a website: that is left to the owner.
 */
function joinWays(info) {
  const port = info.port;
  // an IPv6 address needs its brackets, or its last group reads as the port
  const at = (hosts) => (port ? hosts.map((h) => (h.includes(':') ? '[' + h + ']' : h) + ':' + port) : []);
  const portWords = port ? 'port ' + port : 'the server\u2019s port';
  const firewall = ' If it will not connect, this computer\u2019s firewall may be blocking Java.';
  const unlock = info.bindFixed ? '' : ' Clearing server-ip in server.properties makes it listen everywhere.';
  if (info.loopbackOnly) {
    return [
      { who: 'On this computer', addresses: at(['localhost']), note: 'For playing on the computer the server runs on.' },
      { who: 'Anyone else', addresses: [], note: 'This server is set to listen on this computer only, so nobody else can reach it.' + unlock },
    ];
  }
  if (info.only) {
    // one address and no other: "localhost" does not answer either
    const note = {
      lan: 'For this computer and anyone on the same Wi-Fi or router.' + firewall,
      public: 'A public address, so friends anywhere can use it, as long as this computer\u2019s firewall lets ' + portWords + ' (TCP) through.',
      here: 'One of this computer\u2019s own addresses. Who can reach it depends on the network it belongs to.',
      unknown: 'This is not one of this computer\u2019s addresses right now, so the server may not start, or may not be reachable.',
    }[info.onlyKind] || '';
    return [{ who: 'This server listens on one address only', addresses: at([info.only]), note: note + unlock }];
  }
  const ways = [{
    who: 'On this computer',
    addresses: at([info.here || 'localhost']),
    note: 'For playing on the computer the server runs on.',
  }];
  const lan = info.lan || [];
  const open = info.public || [];
  // a machine with only a public address is not on anyone's Wi-Fi: no row telling it to join one
  if (lan.length || !open.length) {
    ways.push({
      who: 'On your home network',
      addresses: at(lan),
      note: lan.length
        ? 'For anyone on the same Wi-Fi or router as this computer.' + (lan.length > 1 ? ' This computer has more than one network address: if one does not work, try the next.' : '') + firewall
        : 'This computer has no home network address right now. Connect it to your Wi-Fi or router and look again.',
    });
  }
  ways.push({
    who: 'Over the internet',
    addresses: at(open),
    note: open.length
      ? 'This computer has a public address of its own, so friends anywhere can use it, as long as its firewall lets ' + portWords + ' (TCP) through.'
      : 'Friends elsewhere type your public address' + (port ? ', then :' + port : ' and the port') + '. Your router also has to pass ' + (port ? 'port ' + port : 'that port')
        + ' (TCP) on to this computer, which routers call port forwarding. Some internet providers share one public address between customers, and forwarding cannot work there.'
        + ' SpawnLoft does not look up your public address or change your router.',
  });
  return ways;
}

/** What stands in the way of anyone joining at all, said before the addresses. */
function joinLead(info, status) {
  if (!info.port) return 'This server\u2019s port is not known yet, so there is no address to give out. Start it once and look again.';
  if (status !== 'running') return 'The server is not running. Nobody can join until it is started; these are the addresses it will have.';
  return 'What someone types into Minecraft under Multiplayer, Add Server, depends on where they are.';
}

/** The button beside a server's address that says how other people reach it. */
function joinButton(row) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'addr-copy join-how';
  b.textContent = 'How friends join';
  b.onclick = async (ev) => {
    ev.stopPropagation();
    let info;
    try {
      info = await api('/instances/' + encodeURIComponent(row.name) + '/join');
    } catch (e) {
      return toast(e.message, 'bad');
    }
    const now = rowOf(row.name) || row;
    const list = document.createElement('dl');
    list.className = 'join-ways';
    for (const way of joinWays(info)) {
      const dt = document.createElement('dt');
      dt.textContent = way.who;
      const dd = document.createElement('dd');
      for (const address of way.addresses) dd.append(addrButton(address));
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = way.note;
      dd.append(note);
      list.append(dt, dd);
    }
    await ask({ title: 'How friends join ' + (now.label || now.name), text: joinLead(info, now.status), detail: list, tellOnly: true, confirmLabel: 'Done' });
  };
  return b;
}
const dbEngine = (row) => (row.engineLabel || row.engine) + (row.version ? ' ' + row.version : '');

function setPill(pill, row, acting) {
  const said = describeState(row, acting);
  pill.textContent = said.text;
  if (said.tone) pill.dataset.tone = said.tone;
  else delete pill.dataset.tone;
  if (said.since) pill.dataset.since = String(said.since);
  else delete pill.dataset.since;
}

/**
 * The databases nobody owns alone, under the servers. Each card is keyed like a server card and
 * says what the database is, where it answers, how much memory it holds and which servers use it.
 */
function renderHomeDbs() {
  const section = $('#homeDbs');
  const grid = $('#dbsGrid');
  const dbs = (state.dbs || []).filter((d) => !nestedDb(d));
  section.hidden = !dbs.length;
  const seen = new Set();
  dbs.forEach((row, i) => {
    seen.add(row.name);
    let card = grid.querySelector('.dcard[data-name="' + CSS.escape(row.name) + '"]');
    if (!card) card = buildDbCard(row.name);
    updateDbCard(card, row);
    if (grid.children[i] !== card) grid.insertBefore(card, grid.children[i] || null);
  });
  for (const card of Array.from(grid.children)) if (!seen.has(card.dataset.name)) card.remove();
}

const el = (tag, cls) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

/** The head every card has: the kind's glyph, the name and its state, and a line under them. */
function cardHead(kind) {
  const head = el('div', 'sc-head');
  const glyph = el('span', 'sc-kind');
  glyph.append(icon(kind));
  const title = el('div', 'sc-title');
  const line = el('div', 'sc-line');
  line.append(el('h3', 'sc-name'), el('span', 'spill'));
  title.append(line, el('div', 'sc-soft'));
  head.append(glyph, title);
  return head;
}

function buildDbCard(name) {
  const card = el('article', 'scard dcard');
  card.dataset.name = name;
  const head = cardHead('database');
  const stats = el('dl', 'sc-stats');
  for (const [key, label] of [['memory', 'Memory'], ['attached', 'Used by']]) {
    const cell = el('div');
    cell.dataset.v = key;
    const dt = el('dt');
    dt.textContent = label;
    cell.append(dt, el('dd'));
    stats.append(cell);
  }
  stats.lastChild.style.gridColumn = 'span 2';
  const foot = el('div', 'sc-foot');
  const open = el('button', 'sc-open');
  open.type = 'button';
  open.textContent = 'Open →';
  open.onclick = () => select(name);
  foot.append(el('span', 'sc-note'), open);
  card.append(head, stats, foot);
  return card;
}

function updateDbCard(card, row) {
  card.dataset.status = row.status;
  card.querySelector('.sc-name').textContent = row.label || row.name;
  setPill(card.querySelector('.spill'), row, null);
  const soft = card.querySelector('.sc-soft');
  const what = dbEngine(row) + (row.external ? ' · runs elsewhere' : '') + ' · ';
  // Rebuilt only when it changes, so a focused button keeps its focus across polls.
  if (soft.dataset.said !== what + dbAddress(row)) {
    soft.dataset.said = what + dbAddress(row);
    soft.textContent = '';
    soft.append(what, addrButton(dbAddress(row)));
  }
  const latest = row.status === 'running' ? row.latest : null;
  if (latest && Number.isFinite(latest.rss)) {
    const gb = latest.rss >= 1024;
    setStat(card, 'memory', gb ? (latest.rss / 1024).toFixed(1) : String(latest.rss), gb ? 'GB' : 'MB');
  } else {
    const dd = card.querySelector('[data-v="memory"] dd');
    dd.textContent = '';
    const t = el('span', 'txt');
    t.textContent = row.status === 'running' ? 'Not measured' : 'Not running';
    t.style.color = 'var(--ink-3)';
    dd.append(t);
  }
  const names = Object.keys(row.attachments || {});
  const used = card.querySelector('[data-v="attached"] dd');
  const usedKey = names.map((n) => n + '=' + ((rowOf(n) || {}).label || '') + (rowOf(n) ? '' : '!')).join(',');
  if (used.dataset.said === usedKey) {
    // unchanged; the chips keep their focus
  } else if (names.length) {
    used.dataset.said = usedKey;
    used.textContent = '';
    const chips = el('div', 'used-by');
    for (const n of names) {
      const srv = rowOf(n);
      const chip = el('button', 'srv-chip');
      chip.type = 'button';
      chip.append(icon('server'), (srv && srv.label) || n);
      chip.title = srv ? 'Open ' + (srv.label || n) : n + ' is no longer on this machine';
      chip.disabled = !srv;
      chip.onclick = () => select(n);
      chips.append(chip);
    }
    used.append(chips);
  } else {
    used.dataset.said = usedKey;
    used.textContent = '';
    const t = el('span', 'txt');
    t.textContent = 'Nothing yet';
    used.append(t);
  }
  card.querySelector('.sc-open').setAttribute('aria-label', 'Open ' + (row.label || row.name));
  const note = card.querySelector('.sc-note');
  note.textContent = names.length > 1 ? 'Shared by ' + names.length + ' servers' : names.length ? '1 server attached' : 'No server attached';
}

/** A database this server owns, drawn inside its card. */
function buildDbLink(db) {
  const link = el('div', 'sc-link');
  link.dataset.name = db.name;
  const glyph = el('span', 'sc-kind');
  glyph.append(icon('database'));
  const words = el('div', 'sc-link-words');
  words.append(el('b'), el('span', 'sc-soft'));
  const open = el('button', 'sc-open');
  open.type = 'button';
  open.textContent = 'Open →';
  open.onclick = () => select(db.name);
  link.append(glyph, words, el('span', 'spill'), open);
  return link;
}

function updateDbLink(link, db) {
  link.dataset.status = db.status;
  const b = link.querySelector('b');
  b.textContent = db.label || db.name;
  const tag = document.createElement('small');
  tag.textContent = 'Database';
  b.append(tag);
  const soft = link.querySelector('.sc-soft');
  if (soft.dataset.said !== dbEngine(db) + dbAddress(db)) {
    soft.dataset.said = dbEngine(db) + dbAddress(db);
    soft.textContent = '';
    soft.append(dbEngine(db) + ' · ', addrButton(dbAddress(db)));
  }
  setPill(link.querySelector('.spill'), db, null);
  link.querySelector('.sc-open').setAttribute('aria-label', 'Open ' + (db.label || db.name));
}

