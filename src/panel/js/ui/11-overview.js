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
const overview = { data: null, failed: false, asked: 0, attention: '', acting: {} };

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

/**
 * The line under the title: what is here, what runs, who is on, and the memory the servers may
 * take against what the machine has. Each is said only when it is known; "0 players online" from
 * servers that were not asked would be a claim about nobody.
 */
function overviewSummary(rows, dbs, machineMb) {
  const running = rows.filter((r) => r.status === 'running');
  const counted = running.filter((r) => r.latest && r.latest.players != null);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const parts = [plural(rows.length, 'server', 'servers'), running.length + ' running'];
  if (counted.length) {
    const n = counted.reduce((sum, r) => sum + r.latest.players, 0);
    parts.push(plural(n, 'player online', 'players online'));
  }
  if (dbs.length) parts.push(plural(dbs.length, 'database', 'databases'));
  const reservedMb = rows.reduce((n, r) => n + (memoryCeilingMb(r.memory) || 0), 0);
  // What the servers are allowed to take, added up, whether or not they run: "may use up to", not
  // "reserved", which reads as memory already set aside.
  const memory = !reservedMb ? ''
    : machineMb ? ' Servers may use up to ' + gbOf(reservedMb) + ' of this machine’s ' + Math.round(machineMb / 1024) + ' GB.'
      : ' Servers may use up to ' + gbOf(reservedMb) + ' GB.';
  return { text: parts.join(', ') + '.' + memory, over: Boolean(machineMb && reservedMb > machineMb) };
}

let homeLoadTimer = null;

function renderOverview() {
  const rows = state.rows;
  const dbs = state.dbs || [];
  const machineMb = overview.data && overview.data.machine && overview.data.machine.memoryMb;
  const said = overviewSummary(rows, dbs, machineMb);
  const box = $('#homeSummary');
  box.textContent = said.text;
  // The tone is in words too: a colour alone does not tell everyone the servers want more than the machine has.
  if (said.over) box.append(Kit.h('span', { class: 'text-warn-ink', text: ' That is more than it has.' }));

  // Said only when there is nothing older to show; a refresh that fails keeps the last answer.
  $('#homeFail').hidden = !(overview.failed && !overview.data);
  // Until the first /overview answers, the cards wait: Needs attention comes from it and lands
  // above them, and painting the cards first dropped them a card's height as it arrived. The words
  // only show if the wait is long enough to notice.
  const waiting = !overview.data && !overview.failed;
  $('#vHome').toggleAttribute('aria-busy', waiting);
  $('#homeBody').hidden = waiting;
  if (!waiting) {
    clearTimeout(homeLoadTimer);
    homeLoadTimer = null;
    $('#homeLoading').hidden = true;
  } else if (!homeLoadTimer) {
    homeLoadTimer = setTimeout(() => { $('#homeLoading').hidden = !($('#homeBody').hidden); }, 400);
  }
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
  const wide = new Set(Array.from($('#homeCards').children).filter((c) => c.dataset.live && c.clientWidth >= 720).map((c) => c.dataset.name));
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

// An address is a button because the only thing anyone does with it is paste it somewhere. Quiet
// until pointed at; the glyph turns to a tick for a moment once it is copied.
const ADDR_COPY = 'group/addr relative -mx-1.5 -my-0.5 inline-flex min-h-[26px] cursor-pointer items-center gap-[5px] rounded-xs border border-transparent bg-transparent px-1.5 py-0.5 font-mono text-2 leading-[1.4] text-ink-2 transition-colors hover:border-line hover:bg-hover hover:text-ink';
const ADDR_ICON = 'size-3 text-ink-3 group-hover/addr:text-ink group-data-copied/addr:text-live';

function addrButton(text, what = 'address', secret = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = ADDR_COPY;
  b.append(document.createTextNode(text), Kit.icon('copy', ADDR_ICON));
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
  // beside the address: words, so not in the address's typeface
  b.className = ADDR_COPY + ' font-ui underline underline-offset-2';
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
    list.className = 'm-0 [&>dt]:mt-4 [&>dt]:text-3 [&>dt]:leading-[1.3] [&>dt]:font-semibold [&>dt]:text-ink [&>dd]:m-0 [&>dd]:mt-0.5 [&>dd]:grid [&>dd]:justify-items-start [&>dd]:gap-0.5 [&_button]:my-0 [&_button]:text-3 [&_button]:text-ink';
    for (const way of joinWays(info)) {
      const dt = document.createElement('dt');
      dt.textContent = way.who;
      const dd = document.createElement('dd');
      for (const address of way.addresses) dd.append(addrButton(address));
      const note = document.createElement('p');
      note.className = 'sl-hint';
      note.textContent = way.note;
      dd.append(note);
      list.append(dt, dd);
    }
    await ask({ title: 'How friends join ' + (now.label || now.name), text: joinLead(info, now.status), detail: list, tellOnly: true, confirmLabel: 'Done' });
  };
  return b;
}
const dbEngine = (row) => (row.engineLabel || row.engine) + (row.version ? ' ' + row.version : '');

/**
 * The databases nobody owns alone, under the servers. Each is a row like a stopped server's: what
 * the database is, where it answers, and which servers use it.
 */
function renderHomeDbs() {
  const section = $('#homeDbs');
  const grid = $('#dbsGrid');
  const dbs = (state.dbs || []).filter((d) => !nestedDb(d));
  section.hidden = !dbs.length;
  const seen = new Set();
  dbs.forEach((row, i) => {
    seen.add(row.name);
    let card = grid.querySelector('[data-name="' + CSS.escape(row.name) + '"]');
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

/** A database's face: its engine's glyph, a cache for Redis. */
const dbGlyph = (row) => (row.engineKind === 'redis' ? 'cache' : 'database');

function buildDbCard(name) {
  const nameButton = Kit.h('button', { type: 'button', class: 'sl-btn sl-btn-link block min-w-0 max-w-full truncate text-ink type-card', onclick: () => select(name) });
  const pill = statePill();
  const meta = Kit.h('div', { class: 'm-0 flex min-w-0 flex-wrap items-center gap-x-1.5 type-meta text-ink-3' });
  const used = Kit.h('div', { class: 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 type-meta text-ink-3' });
  const open = Kit.button({ label: 'Open', onClick: () => select(name) });
  const card = Kit.h('article', { class: 'sl-card sl-card-compact', dataset: { name } },
    Kit.h('span', { class: 'contents', 'data-face': '' }),
    Kit.h('div', { class: 'min-w-0 flex-[1_1_240px]' },
      Kit.h('div', { class: 'flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1' }, Kit.h('h3', { class: 'm-0 min-w-0 max-w-full' }, nameButton), pill),
      meta, used),
    open);
  card.parts = { nameButton, pill, meta, used, open, face: card.querySelector('[data-face]') };
  return card;
}

function updateDbCard(card, row) {
  const { nameButton, pill, meta, used, open, face } = card.parts;
  const name = row.label || row.name;
  card.dataset.status = row.status;
  nameButton.textContent = name;
  nameButton.setAttribute('aria-label', 'Open ' + name);
  open.setAttribute('aria-label', 'Open ' + name);
  pill.paint(row, null);
  if (face.dataset.said !== dbGlyph(row)) {
    face.dataset.said = dbGlyph(row);
    face.replaceChildren(Kit.tile({ name, key: row.name, icon: dbGlyph(row) }));
  }
  // Rebuilt only when it changes, so a focused button keeps its focus across polls.
  const what = dbEngine(row) + (row.external ? ' · runs elsewhere' : '');
  if (meta.dataset.said !== what + dbAddress(row)) {
    meta.dataset.said = what + dbAddress(row);
    meta.textContent = '';
    meta.append(what, Kit.h('span', { 'aria-hidden': 'true', text: '·' }), addrButton(dbAddress(row)));
  }
  const names = Object.keys(row.attachments || {});
  const usedKey = names.map((n) => n + '=' + ((rowOf(n) || {}).label || '') + (rowOf(n) ? '' : '!')).join(',');
  if (used.dataset.said === usedKey) return;
  used.dataset.said = usedKey;
  used.textContent = '';
  if (!names.length) {
    used.append('No server uses it yet');
    return;
  }
  used.append(names.length > 1 ? 'Shared by ' + names.length + ' servers:' : 'Used by');
  for (const n of names) {
    const srv = rowOf(n);
    const chip = Kit.button({ label: (srv && srv.label) || n, kind: 'link', onClick: () => select(n) });
    chip.title = srv ? 'Open ' + (srv.label || n) : n + ' is no longer on this machine';
    chip.disabled = !srv;
    used.append(chip);
  }
}

/** A database this server owns, drawn inside its card. */
function buildDbLink(db) {
  const link = Kit.h('div', { class: 'flex flex-wrap items-center gap-3 rounded-md border border-line-soft bg-recess px-3 py-2', dataset: { name: db.name } });
  const words = Kit.h('div', { class: 'min-w-0 flex-[1_1_200px]' }, Kit.h('div', { class: 'type-card' }), Kit.h('div', { class: 'type-meta text-ink-3' }));
  const pill = statePill();
  const open = Kit.button({ label: 'Open', size: 'sm', onClick: () => select(db.name) });
  link.append(Kit.h('span', { class: 'contents', 'data-face': '' }), words, pill, open);
  link.parts = { words, pill, open, face: link.querySelector('[data-face]') };
  return link;
}

function updateDbLink(link, db) {
  const { words, pill, open, face } = link.parts;
  const name = db.label || db.name;
  link.dataset.status = db.status;
  if (face.dataset.said !== dbGlyph(db)) {
    face.dataset.said = dbGlyph(db);
    face.replaceChildren(Kit.tile({ name, key: db.name, icon: dbGlyph(db), size: 'sm' }));
  }
  const [title, soft] = words.children;
  title.textContent = name + ' ';
  title.append(Kit.h('span', { class: 'sl-eyebrow', text: 'Database' }));
  if (soft.dataset.said !== dbEngine(db) + dbAddress(db)) {
    soft.dataset.said = dbEngine(db) + dbAddress(db);
    soft.textContent = '';
    soft.append(dbEngine(db) + ' · ', addrButton(dbAddress(db)));
  }
  pill.paint(db, null);
  open.setAttribute('aria-label', 'Open ' + name);
}
