'use strict';
// ------------------------------------------------------------- diagnosis ----

/**
 * The console's known failure shapes, said in words under the vitals.
 *
 * <p>Fetched only when something about the run changes - a poll that re-asked every four
 * seconds would be asking a question whose answer cannot have changed. Findings wear fault
 * red when the server is down (this is why) and warning amber when it is up (it survived
 * this, but you should know).
 */
let diagKey = '';

/*
  Notices a person has closed, keyed by the run they belonged to.

  A dismissed finding stays gone while nothing about the run changes, and comes back with the
  next run - the port that was taken may be taken again, and that is news. Kept for the life of
  the page rather than stored: a notice worth remembering across restarts is a bug to fix, not a
  preference to keep.
*/
const dismissed = new Set();

/**
 * One notice under the vitals: a bold title, a sentence, and its actions at the right.
 *
 * <p>Every notice can be dismissed. A finding also offers to show the line it was read from,
 * and the ones the panel can do something about carry that something as a button - "Change
 * port…" opens the same dialog Manage does, rather than a sentence telling you to go and find it.
 */
/**
 * Where a database that runs elsewhere is found, edited in place on its own page: the facts give
 * way to a form, and Cancel puts them back. The password field starts empty and empty keeps the
 * one saved, so the form never has to hold it.
 */
function dbAddressEditor(row, facts) {
  const wrap = el('div', 'db-edit-wrap');
  const open = iconButton('pencil', 'Edit address', 'sm');
  const form = el('form', 'db-edit');
  form.hidden = true;
  const field = (label, input, hint) => {
    const f = el('label', 'db-edit-field');
    const t = el('span', 'db-edit-label');
    t.textContent = label;
    f.append(t, input);
    if (hint) {
      const h = el('span', 'hint');
      h.textContent = hint;
      f.append(h);
    }
    form.append(f);
    return input;
  };
  const input = (value, attrs = {}) => {
    const i = el('input', 'mono');
    i.value = value;
    Object.assign(i, { spellcheck: false, autocomplete: 'off' }, attrs);
    return i;
  };
  const host = field('Host', input(row.host || '127.0.0.1', { required: true }));
  const port = field('Port', input(String(row.port), { type: 'number', min: 1, max: 65535, required: true }));
  const redis = row.engineKind === 'redis';
  const user = redis ? null : field('Admin user', input(''), 'Empty keeps the one saved.');
  const pass = field('Password', input('', { type: 'password', autocomplete: 'new-password' }), 'Empty keeps the one saved.');
  const acts = el('div', 'db-edit-acts');
  const save = el('button', 'primary');
  save.type = 'submit';
  save.textContent = 'Save';
  const cancel = el('button', 'ghost');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  acts.append(save, cancel);
  form.append(acts);
  wrap.append(open, form);

  const show = (editing) => {
    form.hidden = !editing;
    facts.hidden = editing;
    open.hidden = editing;
    if (editing) host.focus();
    else open.focus();
  };
  open.onclick = () => show(true);
  cancel.onclick = () => show(false);
  form.onsubmit = async (e) => {
    e.preventDefault();
    busy(save, true);
    try {
      const out = await post('/databases/' + encodeURIComponent(row.name) + '/address', {
        host: host.value.trim(), port: port.value, user: user ? user.value.trim() : undefined, password: pass.value || undefined,
      });
      toast(out.status === 'reachable'
        ? 'Saved. ' + (row.label || row.name) + ' answers at ' + out.host + ':' + out.port + '.'
        : 'Saved, but nothing answers at ' + out.host + ':' + out.port + ' yet.', out.status === 'reachable' ? 'good' : 'bad');
      $('#settingsBody').dataset.for = '';
      await refresh();
      const now = rowOf(row.name);
      if (now && state.current === row.name) renderDatabaseSettings(now);
    } catch (err) {
      busy(save, false);
      toast(err.message, 'bad');
    }
  };
  return wrap;
}

/** The unreachable notice on a database's own page, kept in step with each poll. */
function paintDbReach(row) {
  const box = $('#settingsBody .db-reach');
  if (!box || $('#settingsBody').dataset.for !== row.name) return;
  const down = row.status === 'unreachable';
  if (box.dataset.down === String(down)) return;
  box.dataset.down = String(down);
  box.textContent = '';
  if (!down) return;
  const again = { label: 'Check again', run: async (e) => {
    const b = e.currentTarget;
    busy(b, true);
    await refresh();
    if (b.isConnected) busy(b, false);
  } };
  const edit = { label: 'Edit address', run: () => $('#settingsBody .db-edit-wrap > button')?.click() };
  const notice = noticeBox({
    tone: 'fault',
    title: 'Not answering',
    text: 'Nothing replied at ' + (row.host || '127.0.0.1') + ':' + row.port + '. Start it where it runs, or correct the address, then check again.',
    actions: row.external ? [again, edit] : [again],
  });
  notice.setAttribute('role', 'status');
  box.append(notice);
}

/**
 * The way out for a server that is running with nothing looking after it. It was a sentence
 * telling the person to run "spawnloft kill" in a terminal.
 */
async function forceStop(name, label) {
  const ok = await ask({
    title: 'Force stop ' + label + '?',
    text: 'It is ended at once, without saving. Whatever happened in the world since its last save is lost.',
    confirmLabel: 'Force stop',
    danger: true,
  });
  if (!ok) return false;
  let done = false;
  try {
    await post('/instances/' + encodeURIComponent(name) + '/kill');
    forceStopped.add(name);
    done = true;
    toast('Stopped ' + label + '.', 'good');
  } catch (e) {
    toast(e.message, 'bad');
  }
  await refresh();
  return done;
}
// The update's record still lists a server as out of reach after it has been force stopped here;
// its notice would stay, offering a stop that is refused.
const forceStopped = new Set();

function noticeBox({ tone, title, text, actions = [], dismiss }) {
  const box = document.createElement('div');
  box.className = 'notice ' + tone;
  const body = document.createElement('span');
  body.className = 'text';
  const b = document.createElement('b');
  b.textContent = title;
  body.append(b, ' ', text);
  const acts = document.createElement('span');
  acts.className = 'acts';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = a.primary ? '' : 'ghost';
    btn.textContent = a.label;
    btn.onclick = a.run;
    acts.append(btn);
  }
  if (dismiss) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ghost x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Dismiss: ' + title);
    x.title = 'Dismiss';
    x.onclick = () => { dismiss(); box.remove(); };
    acts.append(x);
  }
  box.append(body, acts);
  return box;
}

/** Switch to the console with the search set to the line a finding was read from. */
function showLineInConsole(line) {
  showPane('console');
  setFilter('all');
  const search = $('#conSearch');
  // The timestamp prefix is per line and the search is a substring, so the message is enough.
  search.value = line.replace(/^\[[^\]]*\]:?\s*/, '').trim().slice(0, 80);
  search.dispatchEvent(new Event('input'));
  search.focus();
}

/*
  What the panel can do about each finding, by the id the core gives it. The advice text still
  names the way out in words, for the terminal and for findings with no button here; this is the
  button for the ones that have somewhere to go in the panel.
*/
const FINDING_ACTIONS = {
  'port-in-use': (row) => [{ label: 'Change port…', run: () => editServer(row), primary: true }],
  'out-of-memory': (row) => [{ label: 'Raise memory…', run: () => editServer(row), primary: true }],
  'wrong-java': () => [{ label: 'Choose Java', run: () => showPane('settings'), primary: true }],
  'missing-jar': () => [{ label: 'Server software', run: () => showPane('settings'), primary: true }],
  'eula': (row) => [{ label: 'Open folder', run: () => openFolder(row.name), primary: true }],
  'missing-plugin-dependency': () => [{ label: 'Open Plugins', run: () => showPane('plugins'), primary: true }],
  'missing-mod-dependency': () => [{ label: 'Open Mods', run: () => showPane('plugins'), primary: true }],
  'duplicate-plugin': () => [{ label: 'Open Plugins', run: () => showPane('plugins'), primary: true }],
  'corrupt-world': () => [{ label: 'Open Backups', run: () => showPane('backups'), primary: true }],
  'ticking-crash': (row) => [{
    label: 'Crash reports',
    primary: true,
    run: () => post('/instances/' + encodeURIComponent(row.name) + '/reveal', { sub: 'crash-reports' })
      .catch((e) => toast(e.message, 'bad')),
  }],
};

async function loadDiagnosis(row) {
  const key = [row.name, row.status, row.exitCode ?? '', row.startedAt ?? ''].join('|');
  if (key === diagKey) return;
  diagKey = key;
  const box = $('#srvDiag');
  let data;
  try {
    data = await api('/instances/' + encodeURIComponent(row.name) + '/diagnose');
  } catch {
    box.textContent = '';
    diagKey = '';
    return;
  }
  if (state.current !== row.name) return;
  box.textContent = '';

  for (const f of data.findings.slice(0, 2)) {
    const fKey = key + '|' + f.id;
    if (dismissed.has(fKey)) continue;
    const actions = FINDING_ACTIONS[f.id] ? FINDING_ACTIONS[f.id](row) : [];
    if (f.line) actions.push({ label: 'Show in console', run: () => showLineInConsole(f.line) });
    box.append(noticeBox({
      tone: row.status === 'running' ? 'warn' : 'fault',
      title: f.title,
      text: f.advice,
      actions,
      dismiss: () => dismissed.add(fKey),
    }));
  }

  if (data.crashes.count) {
    const cKey = key + '|crashes|' + data.crashes.newest.file;
    if (dismissed.has(cKey)) return;
    box.append(noticeBox({
      tone: 'warn',
      title: data.crashes.count === 1 ? '1 crash report' : data.crashes.count + ' crash reports',
      text: (data.crashes.newest.description || data.crashes.newest.file) + '  ·  ' + ago(data.crashes.newest.mtime),
      actions: [
        {
          label: 'Open folder',
          run: () => post('/instances/' + encodeURIComponent(row.name) + '/reveal', { sub: 'crash-reports' })
            .catch((e) => toast(e.message, 'bad')),
        },
        // Most bug reports are born here, at the crash, and this is when someone is most willing
        // to send one. The report opens named for the crash and with the diagnosis attached.
        {
          label: 'Report',
          run: () => reportBug({ title: 'Crash: ' + (data.crashes.newest.description || 'server crashed').slice(0, 80) }),
        },
      ],
      dismiss: () => dismissed.add(cKey),
    }));
  }
}

