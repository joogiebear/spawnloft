'use strict';
// ---------------------------------------------------------------- players ---

const PLAYER_FILTERS = [
  { key: 'all', label: 'Everyone', match: () => true },
  { key: 'operators', label: 'Operators', match: (p) => p.op },
  { key: 'banned', label: 'Banned', match: (p) => p.banned },
  { key: 'whitelisted', label: 'Whitelisted', match: (p) => p.whitelisted },
];

/** The line beside the whitelist switch: what its state means for who gets in. */
function whitelistWords(on, listed) {
  if (!on) return 'Off. Anyone can join' + (listed ? '; the ' + listed + ' on the list ' + (listed === 1 ? 'is' : 'are') + ' not checked.' : '.');
  // operators get in whether or not they are listed: the game counts them as on it
  if (!listed) return 'On, with nobody on the list: only operators can join. Add the people who should get in.';
  return 'On. Only the ' + (listed === 1 ? 'one player' : listed + ' players') + ' on the list, and operators, can join.';
}

/** What to ask before the whitelist goes on with nobody on it. */
function emptyWhitelistQuestion(data) {
  const connected = !data.running ? ''
    : data.whitelistEnforced ? ' People connected now who are not operators are removed from the server.'
      : ' People connected now stay until they leave.';
  return {
    title: 'Turn the whitelist on with nobody on it?',
    text: 'Only operators will be able to join until someone is added.' + connected,
    confirmLabel: 'Turn on',
  };
}

/** The Add a player dialog: a name, and what to do with them. */
function addPlayerQuestion(data) {
  return {
    title: 'Add a player',
    text: data.running
      ? 'For someone who has not joined yet. The server finds them by name.'
      : data.onlineMode === false
        ? 'For someone who has not joined yet. The name has to be exactly the one they will join with.'
        : 'For someone who has not joined yet. The name is looked up with Mojang, which needs the internet.',
    input: { label: 'Player name', value: '', placeholder: 'Steve', required: true },
    choices: [
      { value: 'whitelist', label: 'Put them on the whitelist', hint: data.whitelistOn ? 'They can join.' : 'Counts once the whitelist is turned on.' },
      { value: 'op', label: 'Make them an operator', hint: 'Operators can run every command on this server.' },
      { value: 'ban', label: 'Ban them', hint: 'They cannot join.' },
    ],
    confirmLabel: 'Add',
  };
}

/** What to say once someone was added by name. */
function addedWords(out) {
  const done = { whitelist: ' is on the whitelist.', op: ' is now an operator.', ban: ' is banned.' }[out.as] || ' was added.';
  return playerChangeWords(out, out.name + done);
}

/** Kept across renders so filtering, searching and the chosen player do not lose their place on a refresh. */
const playerView = { filter: 'all', search: '', selected: null };
let playersAsked = 0;

/**
 * Everyone this server knows about.
 *
 * <p>What each row can do depends on whether the server is running, and the tab says which is
 * happening rather than leaving it to be discovered: a live server is told through its console, a
 * stopped one has its files edited. Deleting someone's world data is the one thing that only works
 * stopped, because a running server would write it straight back.
 */
/**
 * What the update check found, said for what it actually covered. "Everything is the newest
 * build" was printed when nothing had been asked about at all: every jar added by hand, or the
 * one source that held them not answering.
 */
function updateCheckWords(out, noun) {
  const n = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
  const checked = out.checked || 0;
  const parts = [];
  if (out.updates.length) parts.push('Checked ' + checked + '. ' + n(out.updates.length, 'update') + ' ready.');
  else if (checked) parts.push('Checked ' + checked + ': ' + (checked === 1 ? 'it is already the newest build.' : 'all already the newest build.'));
  else parts.push('Nothing was checked.');
  if (out.unknown) parts.push(n(out.unknown, noun) + ' could not be matched to a listing, so nothing is known about ' + (out.unknown === 1 ? 'it.' : 'them.'));
  if (out.unreachable && out.unreachable.length) parts.push('No answer about ' + out.unreachable.join(', ') + ', so try again later.');
  if (out.byHand) parts.push(n(out.byHand, noun) + ' added by hand cannot be checked.');
  if (out.pack) parts.push(n(out.pack, noun) + ' from the modpack ' + (out.pack === 1 ? 'is' : 'are') + ' updated with the pack.');
  if (out.off) parts.push(n(out.off, noun) + ' turned off ' + (out.off === 1 ? 'was' : 'were') + ' skipped.');
  return parts.join(' ');
}

/** Asked before one click hands somebody the whole server. */
function operatorQuestion(label) {
  return {
    title: 'Make ' + label + ' an operator?',
    text: 'Operators can run every command on this server: stop it, ban and unban anyone, change the game for everyone, and make more operators.',
    confirmLabel: 'Make operator',
  };
}

/**
 * What to say after a change to a player. A running server answers in a sentence whether it did
 * the thing or refused, so the answer is not the result: `took` is, read back from the server's
 * own list. When the list does not show the change, the server's words are passed on as they are.
 */
function playerChangeWords(out, done) {
  if (out && out.took === false) {
    // Not called a refusal: a ban plugin keeps its own list, and the server's would not show its
    // ban either. The answer is given as the answer, and not dressed as a success.
    return { text: 'The server\u2019s own list does not show that change. ' + (out.reply ? 'It answered: ' + out.reply : 'It gave no answer.'), tone: '' };
  }
  return { text: done, tone: 'good' };
}

async function renderPlayers(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#playersBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (!force && body.dataset.for === row.name && body.childElementCount) return;
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;

  // The newest asking is the one that is drawn: an older answer that arrives late would put a
  // list from before a change back on screen.
  const asked = ++playersAsked;
  let data;
  try {
    data = await api('/instances/' + encodeURIComponent(row.name) + '/players');
  } catch (e) {
    if (asked !== playersAsked) return;
    paneError(body, e.message, () => renderPlayers({ force: true }));
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== row.name || asked !== playersAsked) return;
  followed.playersAt = Date.now();
  body.textContent = '';
  paneHead(body, 'user', 'Players',
    'Everyone this server knows about, and what it thinks of them.');

  const base = '/instances/' + encodeURIComponent(row.name) + '/players';
  const again = () => renderPlayers({ force: true });

  // ---- how a change will be made -------------------------------------------
  const how = document.createElement('div');
  how.className = 'hint';
  how.style.marginBottom = '12px';
  how.textContent = data.running
    ? 'Changes go through the running server\u2019s console, so they take effect at once. Deleting a player\u2019s data needs the server stopped.'
    : 'Changes are written to the server\u2019s files, and take effect the next time it starts.';
  body.append(how);

  // ---- the whitelist: its switch, here with the list it is about -----------
  const listedCount = data.players.filter((p) => p.whitelisted).length;
  const wl = document.createElement('div');
  wl.className = 'who-wl';
  const wlSwitch = document.createElement('input');
  wlSwitch.type = 'checkbox';
  wlSwitch.className = 'switch';
  wlSwitch.id = 'playersWhitelist';
  wlSwitch.checked = Boolean(data.whitelistOn);
  const wlName = document.createElement('label');
  wlName.htmlFor = wlSwitch.id;
  wlName.textContent = 'Whitelist';
  const wlSays = document.createElement('span');
  wlSays.className = 'hint';
  wlSays.id = 'playersWhitelistSays';
  wlSays.textContent = whitelistWords(Boolean(data.whitelistOn), listedCount);
  wlSwitch.setAttribute('aria-describedby', wlSays.id);
  wl.append(wlSwitch, wlName, wlSays);
  body.append(wl);
  wlSwitch.onchange = async () => {
    const on = wlSwitch.checked;
    // turned on with nobody on it, a running server lets nobody in from the next join on
    if (on && !listedCount && !(await ask(emptyWhitelistQuestion(data)))) { wlSwitch.checked = false; return; }
    wlSwitch.disabled = true;
    try {
      const out = await post(base + '/whitelist-mode', { on });
      const said = playerChangeWords(out, on ? 'The whitelist is on.' : 'The whitelist is off.');
      toast(said.text, said.tone);
      await again();
    } catch (e) {
      toast(e.message, 'bad');
      wlSwitch.checked = !on;
      wlSwitch.disabled = false;
    }
  };

  // ---- search and filter ---------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'who-bar';
  const addBtn = iconButton('plus', 'Add a player');
  addBtn.onclick = async () => {
    const got = await ask({
      ...addPlayerQuestion(data),
      // a running server that answers "That player does not exist" has added nobody: the dialog
      // stays, with the answer, so a typo is fixed where it was typed
      submit: async ({ text, choice }) => {
        const out = await post(base + '/add', { name: text, as: choice });
        if (out.took === false) throw new Error(addedWords(out).text);
        return out;
      },
    });
    if (!got || !got.out) return;
    const said = addedWords(got.out);
    toast(said.text, said.tone);
    if (got.out.as === 'whitelist') playerView.filter = 'whitelisted';
    await again();
  };
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search by name or id';
  search.setAttribute('aria-label', 'Search players by name or id');
  search.value = playerView.search;
  search.dataset.kept = '1';
  const filters = document.createElement('div');
  filters.className = 'filters';
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Which players to show');
  const counts = {
    all: data.players.length,
    operators: data.players.filter((p) => p.op).length,
    banned: data.players.filter((p) => p.banned).length,
    whitelisted: listedCount,
  };
  for (const f of PLAYER_FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    // the count apart from the name, which was read as "Everyone 12"
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(counts[f.key]);
    b.append(f.label + ' ', count);
    b.setAttribute('aria-label', f.label + ', ' + counts[f.key]);
    b.setAttribute('aria-pressed', String(playerView.filter === f.key));
    b.onclick = () => { playerView.filter = f.key; paint(); };
    filters.append(b);
  }
  bar.append(search, addBtn, filters);
  body.append(bar);

  // The list, and on an Ultra pane the chosen player's record beside it. The record is built for
  // every tier and the stylesheet shows it only when the pane has the room.
  const list = document.createElement('div');
  list.className = 'who-split';
  body.append(list);

  search.oninput = () => { playerView.search = search.value; paint(); };
  const select = (uuid) => { playerView.selected = uuid; paint(); };

  function paint() {
    for (const b of filters.children) {
      b.setAttribute('aria-pressed', String(b.textContent.startsWith(
        PLAYER_FILTERS.find((f) => f.key === playerView.filter).label)));
    }
    const term = playerView.search.trim().toLowerCase();
    const match = PLAYER_FILTERS.find((f) => f.key === playerView.filter).match;
    const shown = data.players.filter((p) => match(p)
      && (!term || (p.name || '').toLowerCase().includes(term) || p.uuid.includes(term)))
      // Whoever is on the server right now goes to the top. They are the ones you are most likely
      // to be here about.
      .sort((a, b) => Number(b.online) - Number(a.online));

    list.textContent = '';
    if (!data.players.length) {
      list.append(emptyState('user', 'Nobody has joined this server, and nobody is opped, banned '
        + 'or whitelisted. People appear here the first time they join, or when you add them by name.'));
      return;
    }
    if (!shown.length) {
      list.append(emptyState('search', 'Nobody here matches that.'));
      return;
    }
    // The chosen player, or whoever is at the top when the choice is gone or was never made.
    const chosen = shown.find((p) => p.uuid === playerView.selected) || shown[0];
    const people = document.createElement('div');
    people.className = 'people';
    for (const p of shown) {
      const line = playerRow(p, data, base, again, select);
      line.setAttribute('aria-selected', String(p === chosen));
      people.append(line);
    }
    list.append(people, playerDetail(chosen, data, base, again));
  }
  paint();
}

/**
 * One player's whole record, for the companion column an Ultra pane has beside the list: the face
 * at a size that shows its pattern, every flag, the full id and the dates the list truncates, and
 * the same three actions the row offers.
 */
function playerDetail(p, data, base, again) {
  const box = document.createElement('div');
  box.className = 'who-detail section';
  const head = document.createElement('div');
  head.className = 'wd-head';
  head.append(playerFace(p.uuid, 72));
  const title = document.createElement('div');
  const h = document.createElement('h3');
  if (p.name) {
    h.textContent = p.name;
  } else {
    h.className = 'unknown';
    h.textContent = 'name unknown';
  }
  const pills = document.createElement('div');
  pills.className = 'wd-pills';
  const pill = (text, tone) => {
    const span = document.createElement('span');
    span.className = 'pill';
    if (tone) span.dataset.tone = tone;
    span.textContent = text;
    pills.append(span);
  };
  if (p.online) pill('Online', 'on');
  if (p.op) pill('Operator', 'op');
  if (p.banned) pill('Banned', 'ban');
  if (p.whitelisted) pill('Whitelisted');
  if (!pills.childElementCount) pill(p.joined ? 'Has joined' : 'Never joined');
  title.append(h, pills);
  head.append(title);

  const facts = document.createElement('dl');
  const fact = (label, value, mono) => {
    if (value == null || value === '') return;
    const d = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (mono) dd.className = 'mono';
    dd.textContent = value;
    d.append(dt, dd);
    facts.append(d);
  };
  fact('UUID', p.uuid, true);
  fact('Status', p.online ? 'Connected now' : data.running ? 'Not connected' : 'Server stopped');
  fact('Last seen', p.online ? 'Now' : p.lastSeen ? stamp(p.lastSeen) : p.joined ? 'Unknown' : 'Has never joined');
  fact('World data', p.joined ? 'Kept in this world' : 'None yet');
  fact('Operator', p.op ? 'Yes' + (p.opLevel != null ? ', level ' + p.opLevel : '') : 'No');
  if (p.banned) {
    fact('Ban reason', p.banReason || 'None given');
    fact('Banned by', p.banSource);
    fact('Ban expires', p.banExpires ? stamp(p.banExpires) : 'Never');
  }
  fact('Whitelist', p.whitelisted ? 'On the list' : 'Not on the list');

  // The row's own buttons, built the same way so they behave the same way.
  const acts = playerRow(p, data, base, again).querySelector('.w-acts');
  acts.className = 'wd-acts';
  box.append(head, facts, acts);
  return box;
}

/**
 * A face for a player, drawn from their id.
 *
 * <p>The obvious way to do this is to fetch a skin head from one of the avatar services. spawnloft has
 * to work with no network at all - that is a stated constraint, not a preference - so instead the
 * UUID is treated as what it already is: thirty-two hex digits of stable, well-distributed noise.
 *
 * <p>Eight of them pick a hue, the rest fill a five-by-five grid mirrored down the middle. The same
 * player gets the same face on every machine forever, nothing is fetched, and a list of ids becomes
 * a list of people you can tell apart at a glance.
 */
function playerFace(uuid, size) {
  const hex = String(uuid).replace(/-/g, '');
  const px = size || 34;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'face');
  svg.setAttribute('viewBox', '0 0 5 5');
  svg.setAttribute('width', px);
  svg.setAttribute('height', px);
  svg.setAttribute('aria-hidden', 'true');

  const hue = parseInt(hex.slice(0, 8), 16) % 360;
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '5');
  bg.setAttribute('height', '5');
  bg.setAttribute('fill', `hsl(${hue} 34% 20%)`);
  svg.append(bg);

  // Mirrored, because a symmetrical block of colour reads as a face and an arbitrary one reads as
  // static. Three columns decide the pattern; the other two are their reflection.
  const ink = `hsl(${hue} 62% 62%)`;
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      const bit = parseInt(hex.charAt(8 + col * 5 + row), 16);
      if (Number.isNaN(bit) || bit < 8) continue;
      for (const x of col === 2 ? [2] : [col, 4 - col]) {
        const cell = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        cell.setAttribute('x', String(x));
        cell.setAttribute('y', String(row));
        cell.setAttribute('width', '1');
        cell.setAttribute('height', '1');
        cell.setAttribute('fill', ink);
        svg.append(cell);
      }
    }
  }
  return svg;
}

/** One person, and the three things you can do about them. */
function playerRow(p, data, base, again, select) {
  const el = document.createElement('div');
  el.className = 'who';
  if (p.online) el.setAttribute('data-online', '');
  el.append(playerFace(p.uuid));
  // A click anywhere but a button chooses this player for the detail column an Ultra pane shows.
  if (select) el.addEventListener('click', (e) => { if (!e.target.closest('button')) select(p.uuid); });

  const name = document.createElement('div');
  name.className = 'w-name';
  const who = document.createElement('span');
  if (p.name) {
    who.textContent = p.name;
  } else {
    who.className = 'unknown';
    who.textContent = 'name unknown';
    who.title = 'This server has only ever seen this id, never a name to go with it.';
  }
  name.append(who);
  // First, because it is the one piece of state that is true this second rather than on disk.
  if (p.online) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.dataset.tone = 'on';
    pill.textContent = 'Online';
    name.append(pill);
  }
  if (p.op) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.dataset.tone = 'op';
    pill.textContent = 'Operator';
    name.append(pill);
  }
  if (p.banned) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.dataset.tone = 'ban';
    pill.textContent = 'Banned';
    if (p.banReason) pill.title = p.banReason;
    name.append(pill);
  }
  if (p.whitelisted) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = 'Whitelisted';
    name.append(pill);
  }

  // The id and when they were last on are in the meta line on a regular pane and in their own
  // columns on a wide one; the spans marked w-dup are the ones the columns replace.
  const seenText = p.online ? 'Connected now' : p.lastSeen ? 'Last seen ' + stamp(p.lastSeen) : !p.joined ? 'Has never joined' : '';
  const meta = document.createElement('div');
  meta.className = 'w-meta';
  const bit = (text, dup) => {
    const span = document.createElement('span');
    if (dup) span.className = 'w-dup';
    span.textContent = text;
    return span;
  };
  meta.append(bit(p.uuid, true));
  if (seenText) meta.append(bit(seenText.charAt(0).toLowerCase() + seenText.slice(1), true));
  if (p.banned && p.banReason) meta.append(bit('banned: ' + p.banReason));
  const seen = document.createElement('div');
  seen.className = 'w-seen';
  seen.textContent = seenText;
  if (p.lastSeen && !p.online) seen.title = new Date(p.lastSeen).toLocaleString();
  const id = document.createElement('div');
  id.className = 'w-id';
  const idShort = document.createElement('span');
  idShort.className = 'short';
  idShort.textContent = p.uuid.slice(0, 8);
  const idLong = document.createElement('span');
  idLong.className = 'long';
  idLong.textContent = p.uuid;
  id.append(idShort, idLong);
  id.title = p.uuid;

  const acts = document.createElement('div');
  acts.className = 'w-acts';
  const opBtn = document.createElement('button');
  opBtn.textContent = p.op ? 'Remove operator' : 'Make operator';
  const banBtn = document.createElement('button');
  banBtn.className = p.banned ? '' : 'danger';
  banBtn.textContent = p.banned ? 'Unban' : 'Ban';
  const wlBtn = document.createElement('button');
  wlBtn.textContent = p.whitelisted ? 'Off whitelist' : 'Whitelist';
  const wipe = iconButton('trash', 'Delete data', 'danger');
  wipe.disabled = data.running || !p.joined;
  wipe.title = data.running
    ? 'Stop the server first - a running one writes this straight back'
    : p.joined ? 'Remove this player\u2019s inventory, position, stats and advancements'
      : 'This player has no world data to delete';
  acts.append(wlBtn, opBtn, banBtn, wipe);
  el.append(name, meta, seen, id, acts);

  const label = p.name || p.uuid.slice(0, 8);
  const busy = (on) => { for (const b of acts.children) b.disabled = on || (b === wipe && (data.running || !p.joined)); };

  const run = async (path, payload, done) => {
    busy(true);
    try {
      const out = await post(base + path, payload);
      const said = playerChangeWords(out, done);
      toast(said.text, said.tone);
      await again();
    } catch (e) {
      toast(e.message, 'bad');
      busy(false);
    }
  };

  wlBtn.setAttribute('aria-label', (p.whitelisted ? 'Take ' + label + ' off the whitelist' : 'Put ' + label + ' on the whitelist'));
  wlBtn.onclick = () => run('/whitelist', { uuid: p.uuid, on: !p.whitelisted },
    p.whitelisted ? label + ' is off the whitelist.' : label + ' is on the whitelist.' + (data.whitelistOn ? '' : ' The whitelist itself is off.'));

  opBtn.onclick = async () => {
    if (p.op) return run('/op', { uuid: p.uuid, on: false }, label + ' is no longer an operator.');
    if (!(await ask(operatorQuestion(label)))) return;
    return run('/op', { uuid: p.uuid, on: true }, label + ' is now an operator.');
  };

  banBtn.onclick = async () => {
    if (p.banned) return run('/ban', { uuid: p.uuid, on: false }, label + ' is unbanned.');
    const answer = await ask({
      title: 'Ban ' + label + '?',
      text: data.running
        ? 'They are disconnected straight away and cannot rejoin. The reason is shown to them when they try.'
        : 'They cannot join once the server starts. The reason is shown to them when they try.',
      input: { label: 'Why (optional)', value: '', placeholder: 'Griefing' },
      confirmLabel: 'Ban',
      danger: true,
    });
    if (!answer) return;
    return run('/ban', { uuid: p.uuid, on: true, reason: answer.text }, label + ' is banned.');
  };

  wipe.onclick = async () => {
    const ok = await ask({
      title: 'Delete ' + label + '\u2019s data?',
      text: 'Their inventory, position, health, stats and advancements are removed from this world. '
        + 'They can still join - they arrive as if for the first time. Being opped, banned or '
        + 'whitelisted is not affected, and this is not undoable without a backup.',
      confirmLabel: 'Delete data',
      danger: true,
      typeToConfirm: p.name || undefined,
    });
    if (!ok) return;
    return run('/forget', { uuid: p.uuid }, 'Deleted ' + label + '\u2019s world data.');
  };
  return el;
}

