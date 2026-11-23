'use strict';
// ------------------------------------------------------------ add server ---

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
// The same shape registry.parseMemoryGb accepts. Checked here so a typo is caught while the field
// is in front of you - "*G" is what you get typing 8G with the shift a keystroke early, and it used
// to sail through create and only surface as a server that would not start.
const MEM_RE = /^\d+(?:\.\d+)?\s*[GgMm]$/;

/** The line under a field that says what is wrong with it, read out with the field. */
function fieldNote(input) {
  const note = el('div', 'bad field-note');
  note.id = input.id + '_note';
  note.setAttribute('aria-live', 'polite');
  input.setAttribute('aria-describedby', note.id);
  return note;
}

/** What is wrong with a link typed into a setting, or '' when it will do. Empty means none. */
function linkProblem(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(v) ? '' : 'Use a link that starts with http:// or https://, or leave it empty.';
}

/** Under a setting that this version of Minecraft keeps as a game rule. One sentence, so all of
 *  it shows. */
/** After a save that left settings out because the server's version keeps them as game rules. */
function ignoredWords(labels) {
  const list = labels.length > 1 ? labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1] : labels[0];
  return list + (labels.length > 1 ? ' were' : ' was') + ' not saved: in this server\u2019s version of Minecraft '
    + (labels.length > 1 ? 'they are game rules' : 'it is a game rule') + ', changed with /gamerule in the Console.';
}

function gameRuleWords() {
  return 'A game rule in this version of Minecraft, kept in the world: change it with /gamerule in the Console.';
}

function checkRange(input, out, min, max) {
  const value = input.value.trim();
  const ok = /^-?\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
  out.textContent = ok ? '' : 'Use a whole number from ' + min + ' to ' + max + '.';
  input.setAttribute('aria-invalid', String(!ok));
  return ok;
}

function checkMemory(input, out) {
  const value = input.value.trim();
  const bad = value && !MEM_RE.test(value);
  out.textContent = bad ? 'Use a number followed by G or M — for example 4G, or 6144M.' : '';
  input.setAttribute('aria-invalid', String(Boolean(bad)));
  return Boolean(value) && !bad;
}

function selectTab(tab) {
  for (const b of $$('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#addTitle').textContent = tab === 'db' ? 'Add a database' : 'Add a server';
  for (const id of ['#nName', '#aName', '#dName', '#pName']) paintSlug($(id));
  $('#formNew').hidden = tab !== 'new';
  $('#formPack').hidden = tab !== 'pack';
  $('#formAdopt').hidden = tab !== 'adopt';
  $('#formDb').hidden = tab !== 'db';
  if (tab === 'db') loadDbEngines().then(syncDbForm);
}

/**
 * The Add sheet's tabs, held still while a create runs: another tab hid the progress bar of a
 * download that cannot yet be stopped, and left nothing to say it was still going.
 */
function lockAddTabs(on) {
  for (const tab of document.querySelectorAll('.tabs[role="tablist"] [role="tab"]')) tab.disabled = on;
}

function openAdd(tab) {
  openSheet('add');
  // A create is running: its tab, with its progress, is the one to come back to.
  if ([...document.querySelectorAll('.tabs[role="tablist"] [role="tab"]')].some((t) => t.disabled)) return;
  selectTab(tab);
  setTimeout(() => $(tab === 'adopt' ? '#aDir' : tab === 'pack' ? '#pSearch' : tab === 'db' ? '#dName' : '#nName').focus(), 0);
}

let dbEnginesLoaded = false;
const ENGINE_HINT = { mysql: 'MySQL 8.4 LTS; Windows x64, macOS 15+ or Linux x64', garnet: 'Redis-compatible, by Microsoft' };
async function loadDbEngines() {
  if (dbEnginesLoaded) return;
  try {
    const list = await api('/databases/engines');
    const sel = $('#dEngine');
    sel.textContent = '';
    for (const e of list) {
      const option = new Option(e.label, e.id, e.default, e.default);
      option.dataset.managed = String(e.managed);
      sel.append(option);
    }
    dbEnginesLoaded = true;
  } catch { /* the one engine already in the select stands */ }
}

function dbMode() {
  return (document.querySelector('input[name="dbMode"]:checked') || {}).value || 'run';
}

/** Show the fields the chosen mode and engine need, and say what the port default is. */
function syncDbForm() {
  if (!managedDatabaseFeatures) {
    const run = $('input[name="dbMode"][value="run"]');
    run.disabled = true;
    run.checked = false;
    run.closest('label').querySelector('span').textContent = databasePreviewNote;
    $('input[name="dbMode"][value="connect"]').checked = true;
  }
  const connect = dbMode() === 'connect';
  const engineSelect = $('#dEngine');
  for (const option of engineSelect.options) option.disabled = !connect && option.dataset.managed === 'false';
  if (engineSelect.selectedOptions[0]?.disabled) {
    engineSelect.value = [...engineSelect.options].find(option => !option.disabled)?.value || '';
    dbVersionsFor = null;
  }
  const engine = engineSelect.value;
  const redis = engine === 'garnet';
  $('#dEngineHint').textContent = ENGINE_HINT[engine] || '';
  $('#dVersionWrap').hidden = connect;
  $('#dConnect').hidden = !connect;
  $('#dUserWrap').hidden = redis;
  $('#dToolsWrap').hidden = redis;
  $('#dPasswordHint').textContent = redis ? 'Its requirepass, if it has one' : 'Password for the database account';
  $('#dPortHint').textContent = connect
    ? 'Blank means ' + (redis ? '6379' : '3306')
    : 'Blank picks ' + (redis ? '6379' : '3306') + ' or the next free one';
  $('#bDbCreate').textContent = connect ? 'Connect' : 'Add database';
  $('#dbHint').textContent = connect
    ? 'It is asked to answer before it is saved, so a wrong address or password is refused now.'
    : 'The verified engine downloads once; databases using that version share the installation.';
  if (!connect) loadDbVersions();
}
for (const r of $$('input[name="dbMode"]')) r.onchange = syncDbForm;
$('#dEngine').onchange = () => { dbVersionsFor = null; syncDbForm(); };

let dbVersionsFor = null;
async function loadDbVersions() {
  const engine = $('#dEngine').value;
  if (dbVersionsFor === engine) return;
  dbVersionsFor = engine;
  const sel = $('#dVersion');
  sel.textContent = '';
  sel.append(new Option('Loading versions…', ''));
  try {
    const list = await api('/databases/versions?engine=' + encodeURIComponent(engine));
    if (dbVersionsFor !== engine) return;
    sel.textContent = '';
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.version;
      o.textContent = v.version + (v.support && /long/i.test(v.support) ? ' (LTS)' : '');
      sel.append(o);
    }
    if (!list.length) sel.append(new Option('No stable release listed', ''));
  } catch (e) {
    if (dbVersionsFor !== engine) return;
    sel.textContent = '';
    sel.append(new Option('Could not load versions', ''));
    $('#dVersionHint').textContent = e.message;
    dbVersionsFor = null;
  }
}

for (const b of $$('.tabs [data-tab]')) b.onclick = () => selectTab(b.dataset.tab);
$('#bNew').onclick = () => openAdd('new');
$('#bLauncher').onclick = () => showPlay();
$('#playFrame').addEventListener('load', () => {
  // a new page in the frame has no sheet open until it says so
  lockBehindPlay.on = false;
  lockBehindPlay();
  showTheme(document.documentElement.dataset.theme);
  if (state.view === 'play') focusPlay();
});
$('#dNew').onclick = () => openAdd('new');
$('#dAdopt').onclick = () => openAdd('adopt');
$('#bAddClose').onclick = back;

/*
  The name a person types is a label: anything they would call the server. The NAME the core
  uses - the folder, the registry key, the argument to every command - is derived from it and
  shown beside the field as it is typed, so nobody is refused for a space or a bracket and
  nobody is surprised by the folder either. Mirrors slugFor() and freeName() in the core; the
  page cannot import them, and the core derives it again on its own if the page sends none.
*/
function slugFor(label) {
  const slug = String(label ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
    .replace(/[-_]+$/g, '');
  return slug || 'server';
}
function freeSlug(base) {
  const taken = (n) => state.rows.concat(state.dbs).some((r) => r.name.toLowerCase() === n.toLowerCase());
  let name = base;
  for (let i = 2; taken(name); i++) {
    const suffix = '-' + i;
    name = base.slice(0, 32 - suffix.length).replace(/[-_]+$/g, '') + suffix;
  }
  return name;
}
/** The instance name a name field will create. */
function slugOf(input) { return freeSlug(slugFor(input.value.trim())); }

/**
 * The folder name beside a name field. Before anything is typed it shows what the placeholder
 * would make, dimmed - a bare dash read as something broken.
 */
function paintSlug(input) {
  const slugEl = $('#' + input.id + 'Slug');
  if (!slugEl) return;
  const value = input.value.trim();
  slugEl.textContent = value ? slugOf(input) : input.placeholder ? freeSlug(slugFor(input.placeholder)) : '—';
  slugEl.classList.toggle('slug-eg', !value);
}

function checkName(input, out) {
  const value = input.value.trim();
  paintSlug(input);
  let msg = '';
  if (value && state.rows.some((r) => (r.label || r.name).toLowerCase() === value.toLowerCase())) {
    msg = 'There is already a server called ' + value + '.';
  }
  out.textContent = msg;
  input.setAttribute('aria-invalid', String(Boolean(msg)));
  return !msg && Boolean(value);
}

$('#nName').oninput = () => checkName($('#nName'), $('#nNameBad'));
$('#dName').oninput = () => checkName($('#dName'), $('#dNameBad'));
$('#aName').oninput = () => checkName($('#aName'), $('#aNameBad'));
$('#pName').oninput = () => checkName($('#pName'), $('#pNameBad'));
$('#nMem').oninput = () => checkMemory($('#nMem'), $('#nMemBad'));
$('#nPort').oninput = () => checkPort($('#nPort'), $('#nPortBad'));

function checkPort(input, out) {
  const value = input.value.trim();
  const ok = !value || (/^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535);
  out.textContent = ok ? '' : 'Use a port from 1024 to 65535, or leave it blank.';
  input.setAttribute('aria-invalid', String(!ok));
  return ok;
}

/** What Create will make, in a line: the choices from the form above, read back. */
function paintNewSummary() {
  const box = $('#newSummary');
  const sw = softwareById[$('#nLoader').value] || softwareById.paper;
  const version = $('#nVersion').value;
  const port = $('#nPort').value.trim();
  const parts = [
    [sw.label + (version ? ' ' + version : ''), version ? '' : ' (no version yet)'],
    [$('#nMem').value.trim() || '4G', ' memory'],
    [port ? 'port ' + port : 'a free port', ''],
    [$('input[name="onlineMode"]:checked')?.value === 'offline' ? 'any name can join' : 'Minecraft account required', ''],
  ];
  box.textContent = '';
  box.append('Creates ');
  parts.forEach(([b, rest], i) => {
    if (i) { const sep = el('span', 'sep'); sep.textContent = '\u00b7'; box.append(sep); }
    const strong = el('b');
    strong.textContent = b;
    box.append(strong, rest);
  });
}
$('#formNew').addEventListener('input', paintNewSummary);
$('#formNew').addEventListener('change', paintNewSummary);
$('#aMem').oninput = () => checkMemory($('#aMem'), $('#aMemBad'));

$('#formDb').onsubmit = async (e) => {
  e.preventDefault();
  if (!checkName($('#dName'), $('#dNameBad'))) { $('#dName').focus(); return; }
  if (dbMode() === 'connect') {
    $('#bDbCreate').disabled = true;
    try {
      const db = await post('/databases/external', {
        label: $('#dName').value,
        name: slugOf($('#dName')),
        engine: $('#dEngine').value,
        host: $('#dHost').value.trim() || '127.0.0.1',
        port: $('#dPort').value || null,
        user: $('#dUser').value.trim() || 'root',
        password: $('#dPassword').value,
        tools: $('#dTools').value.trim() || null,
      });
      $('#bDbCreate').disabled = false;
      e.target.reset();
      syncDbForm();
      await refresh();
      select(db.name);
      toast('Connected to ' + db.name + ' at ' + db.host + ':' + db.port + '. Attach a server from its Settings tab.', 'good');
    } catch (err) {
      $('#bDbCreate').disabled = false;
      toast(err.message, 'bad');
    }
    return;
  }
  if (!$('#dVersion').value) { toast('Pick a version first.', 'bad'); return; }

  const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
  const bar = $('#dbBar');
  const msg = $('#dbMsg');
  $('#dbProg').hidden = false;
  bar.style.width = '0';
  bar.classList.add('indet');
  msg.textContent = 'Starting…';
  $('#bDbCreate').disabled = true;

  const jobs = new EventSource('/api/jobs/' + jobId + '/stream');
  jobs.onmessage = (ev) => {
    let job;
    try { job = JSON.parse(ev.data); } catch { return; }
    if (job.message) msg.textContent = job.message;
    if (typeof job.percent === 'number') {
      bar.classList.remove('indet');
      bar.style.width = job.percent + '%';
    } else {
      bar.classList.add('indet');
    }
  };
  try {
    const db = await post('/databases', {
      label: $('#dName').value,
      name: slugOf($('#dName')),
      engine: $('#dEngine').value,
      version: $('#dVersion').value,
      port: $('#dPort').value || null,
      jobId: jobId,
    });
    jobs.close();
    $('#dbProg').hidden = true;
    $('#bDbCreate').disabled = false;
    e.target.reset();
    dbVersionsFor = null;
    syncDbForm();
    await refresh();
    select(db.name);
    toast('Added ' + db.name + ' on port ' + db.port + '. Start it, then attach a server from its Settings tab.', 'good');
  } catch (err) {
    jobs.close();
    bar.classList.remove('indet');
    bar.style.width = '0';
    msg.textContent = err.message;
    $('#bDbCreate').disabled = false;
  }
};

/*
  While a create runs, its button is the way to stop it. The button is the form's submit button,
  so for that time it is made a plain one: pressed, it asks the panel to stop the job, and the
  create's own request then comes back saying it was cancelled. The function returned puts the
  button back as it was.
*/
function cancelButtonFor(button, jobId) {
  const was = { text: button.textContent, primary: button.classList.contains('primary') };
  button.type = 'button';
  button.dataset.job = jobId;
  button.classList.remove('primary');
  button.textContent = 'Cancel';
  button.disabled = false;
  // The press that started the create can have a second one right behind it (a double click, a
  // key held down), and that one would land on Cancel. For a moment the button takes none.
  const armed = Date.now() + 700;
  button.onclick = async () => {
    if (Date.now() < armed) return;
    button.disabled = true;
    button.textContent = 'Cancelling\u2026';
    try {
      const out = await post('/jobs/' + encodeURIComponent(jobId) + '/cancel', {});
      // nothing by that id is running: not started yet, or over in the moment before the press.
      // The button is a Cancel again; if the create is over, its own answer is about to put it back.
      if (!out.cancelling && button.dataset.job === jobId) { button.disabled = false; button.textContent = 'Cancel'; }
    } catch (err) {
      if (button.dataset.job !== jobId) return;
      button.disabled = false;
      button.textContent = 'Cancel';
      toast(err.message, 'bad');
    }
  };
  return () => {
    button.onclick = null;
    delete button.dataset.job;
    button.type = 'submit';
    button.classList.toggle('primary', was.primary);
    button.textContent = was.text;
    button.disabled = false;
  };
}

/** What the Add sheet says under the bar once a create was cancelled. */
function cancelledWords(err) {
  return err && err.code === 'cancelled' ? 'Cancelled. No server was created.' : '';
}

// Set for one submit after "Create anyway" on a Java refusal, then cleared.
let forceJava = false;
$('#formNew').onsubmit = async (e) => {
  e.preventDefault();
  // Enter in a field while a create is running is not a second create
  if ($('#bCreate').dataset.job) return;
  if (!checkName($('#nName'), $('#nNameBad'))) { $('#nName').focus(); return; }
  if (!checkMemory($('#nMem'), $('#nMemBad'))) { $('#nMem').focus(); return; }
  if (!checkPort($('#nPort'), $('#nPortBad'))) { $('#nPort').focus(); return; }

  const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
  const bar = $('#newBar');
  const msg = $('#newMsg');
  $('#newProg').hidden = false;
  bar.style.width = '0';
  bar.classList.add('indet');
  msg.textContent = 'Starting…';
  const restoreCreate = cancelButtonFor($('#bCreate'), jobId);
  lockAddTabs(true);
  $('#newHint').textContent = 'This can take a minute on a slow connection.';

  // Watching the job rather than guessing at it: the jar is tens of megabytes, and a spinner that
  // means nothing is worse than no spinner at all.
  const jobs = new EventSource('/api/jobs/' + jobId + '/stream');
  jobs.onmessage = (ev) => {
    let job;
    try { job = JSON.parse(ev.data); } catch { return; }
    if (job.message) msg.textContent = job.message;
    if (typeof job.percent === 'number') {
      bar.classList.remove('indet');
      bar.style.width = job.percent + '%';
    } else {
      bar.classList.add('indet');
    }
  };

  try {
    const form = new FormData(e.target);
    const loader = form.get('loader') || 'paper';
    const version = form.get('version') || null;
    const inst = await post('/instances', {
      label: form.get('name'),
      name: slugOf($('#nName')),
      loader: loader,
      version: version,
      neoforgeVersion: loader === 'neoforge' ? version : null,
      memory: form.get('memory') || '4G',
      port: form.get('port') || null,
      onlineMode: form.get('onlineMode') !== 'offline',
      jobId: jobId,
      force: forceJava,
    });
    forceJava = false;
    jobs.close();
    lockAddTabs(false);
    $('#newProg').hidden = true;
    restoreCreate();
    e.target.reset();
    $('#nMem').value = '4G';
    // reset() put the loader back to Paper but left the version list and hints from whichever
    // loader was chosen last, so a second create without touching the loader posted a Fabric
    // version string against loader:'paper'.
    loadVersions($('#nLoader').value);
    paintSlug($('#nName'));
    await refresh();
    select(inst.name);
    toast('Created ' + (inst.label || inst.name) + ' on port ' + inst.port + '.', 'good');
  } catch (err) {
    forceJava = false;
    jobs.close();
    lockAddTabs(false);
    bar.classList.remove('indet');
    bar.style.width = '0';
    msg.textContent = cancelledWords(err) || err.message;
    restoreCreate();
    $('#newHint').textContent = '';
    // stopped because it was asked to: said under the bar, where the progress was, and not as a fault
    if (cancelledWords(err)) { $('#bCreate').focus(); return; }
    if (err.code === 'java-too-old') {
      // The refusal is about a certainty - the class files will not load on that Java - but
      // the person may be about to install one, or know something this table does not.
      const go = await ask({
        title: 'No Java here can run this version',
        text: err.message + ' The server will not start until it has a Java that fits; you can choose one under Settings → Java.',
        confirmLabel: 'Create anyway',
      });
      if (go) { forceJava = true; e.target.requestSubmit(); }
      return;
    }
    toast(err.message, 'bad');
  }
};

$('#formAdopt').onsubmit = async (e) => {
  e.preventDefault();
  const dir = $('#aDir').value.trim();
  if (!dir) { $('#aDir').focus(); return; }
  if (!checkName($('#aName'), $('#aNameBad'))) { $('#aName').focus(); return; }
  if (!checkMemory($('#aMem'), $('#aMemBad'))) { $('#aMem').focus(); return; }
  $('#bAdopt').disabled = true;
  try {
    const inst = await post('/instances/adopt', {
      label: $('#aName').value.trim(),
      name: slugOf($('#aName')),
      dir: dir,
      memory: $('#aMem').value.trim() || '4G',
    });
    e.target.reset();
    $('#aMem').value = '4G';
    await refresh();
    select(inst.name);
    toast('Added ' + inst.name + ' on port ' + inst.port + '.', 'good');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#bAdopt').disabled = false;
  }
};

