'use strict';

const $ = (s) => document.querySelector(s);
const d = window.spawnloftDesktop;

let defaults = null;
// Once the servers box has been typed in by hand it stops following the data folder. Until then it
// tracks, so picking a new root does not silently leave the servers path on the old drive - which
// is the exact opposite of what the separate-drive option is for.
let serversEdited = false;

function fail(message) {
  const box = $('#err');
  box.hidden = false;
  box.textContent = message;
}

function clearError() {
  $('#err').hidden = true;
  $('#err').textContent = '';
}

/** The default servers folder under a data root - the same name the core actually uses. */
function serversUnder(root) {
  const trimmed = String(root || '').trim().replace(/[\\/]+$/, '');
  return trimmed ? trimmed + '\\instances' : '';
}

function syncServers() {
  if (!serversEdited) $('#servers').value = serversUnder($('#root').value);
}

async function init() {
  if (!d) {
    fail('This screen is part of the SpawnLoft desktop app and cannot run in a browser.');
    $('#go').disabled = true;
    return;
  }
  try {
    defaults = await d.getSetup();
  } catch (err) {
    // A wizard that renders empty boxes and no explanation is worse than one that says what broke.
    fail('SpawnLoft could not read its settings.\n\n' + (err && err.message ? err.message : String(err)));
    $('#go').disabled = true;
    return;
  }
  $('#root').value = defaults.defaultDataRoot;
  const problem = defaults.settingsProblem;
  if (problem && !problem.ok) {
    // Why this screen is here at all, when the person may have servers already: the file that says
    // where they are could not be read. Choosing a folder keeps that file beside the new one.
    fail(
      'SpawnLoft could not read its settings file, so it does not know where your servers are.\n\n' +
      problem.file + '\n(' + problem.error + ')\n\n' +
      'If you already have servers, close SpawnLoft and mend or delete that file, or choose the folder that holds them below. ' +
      'The damaged file is kept next to the new one.'
    );
  }
  // Seeded from the layout the core actually resolved, not from a guessed folder name.
  $('#servers').value =
    (defaults.current && defaults.current.instancesDir) || serversUnder(defaults.defaultDataRoot);
  checkJava();
}

$('#root').oninput = syncServers;
$('#servers').oninput = () => { serversEdited = true; };

$('#separate').onchange = (e) => {
  $('#serversBlock').hidden = !e.target.checked;
  if (e.target.checked) syncServers();
};

$('#pickRoot').onclick = async () => {
  const p = await d.pickFolder('Choose where SpawnLoft keeps its files');
  if (!p) return;
  $('#root').value = p;
  syncServers();
  clearError();
};

$('#pickServers').onclick = async () => {
  const p = await d.pickFolder('Choose where servers are stored');
  if (!p) return;
  $('#servers').value = p;
  serversEdited = true;
  clearError();
};

/**
 * What the Java row says for an answer from the check.
 *
 * Each answer gets its own title: "needs updating" was said of a Java that works, and "not
 * installed" of one that is there and would not run. Only an answer that stops servers from
 * starting says that they will not.
 */
function javaWords(res) {
  const finish = ' You can finish setting up either way.';
  // no answer, or one that is not about Java at all (this window's sign-in ran out)
  if (!res || typeof res.ok !== 'boolean') {
    return { state: 'warn', title: 'Could not check for Java', why: 'Carry on. SpawnLoft will say so again if a server fails to start.', get: false };
  }
  const get = Boolean(res.downloadUrl);
  if (res.reason === 'ok') return { state: 'ok', title: 'Java is installed', why: res.version || res.message, get: false };
  if (res.ok && res.reason === 'old') {
    return { state: 'warn', title: 'Java is installed, but an older one', why: res.message + ' Get a newer Java to run the latest versions.' + finish, get };
  }
  if (res.ok) return { state: 'ok', title: 'Java is installed', why: res.message, get: false };
  const stops = finish + ' Servers will not start until it is sorted.';
  // a Java was found somewhere, and it is too old: the message names it and where it is
  if (res.found) return { state: 'bad', title: 'Java needs updating', why: res.message + stops, get };
  if (res.reason === 'unusable') {
    return { state: 'bad', title: 'Java is installed, but did not run', why: 'A Java was found, but it would not start. Installing Java again usually mends this.' + stops, get };
  }
  return { state: 'bad', title: 'Java is not installed', why: 'Minecraft servers run on Java. Get it, install it, then press Check again.' + stops, get };
}

let javaAsked = 0;
async function checkJava() {
  const mine = ++javaAsked;
  const again = $('#javaAgain');
  again.disabled = true;
  let res = null;
  try {
    res = await d.checkJava();
  } catch { /* said as "could not check" */ }
  // a slower, older answer does not replace a newer one
  if (mine !== javaAsked) return;
  again.disabled = false;
  const words = javaWords(res);
  $('#javaCheck').dataset.state = words.state;
  $('#javaTitle').textContent = words.title;
  $('#javaWhy').textContent = words.why;
  const get = $('#javaGet');
  get.hidden = !words.get;
  get.onclick = words.get ? () => d.openExternal(res.downloadUrl) : null;
  // Nothing to check again once Java is fine.
  again.hidden = words.state === 'ok';
}
$('#javaAgain').onclick = checkJava;
// Back from installing Java: the row answers without being asked.
window.addEventListener('focus', () => { if ($('#javaCheck').dataset.state !== 'ok' && $('#javaCheck').dataset.state !== 'pending') checkJava(); });

// A form, so Enter submits. The old screen ignored Enter entirely, which reads as a stuck window.
$('#form').onsubmit = async (e) => {
  e.preventDefault();
  clearError();

  const separate = $('#separate').checked;
  // Trailing spaces survive a paste out of Explorer and make a folder nobody can find again.
  const dataRoot = $('#root').value.trim();
  const instancesDir = $('#servers').value.trim();
  if (!dataRoot || (separate && !instancesDir)) {
    fail('Both folders are needed before SpawnLoft can continue.');
    return;
  }

  const go = $('#go');
  go.disabled = true;
  // saveSetup relaunches the app on success, so the window vanishes for a second or two. Saying
  // what is about to happen is the difference between a restart and a glitch.
  $('#note').textContent = 'Setting up, then restarting into the panel…';

  let res;
  try {
    res = await d.saveSetup({ dataRoot, instancesDir, separate });
  } catch (err) {
    res = { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
  if (!res || !res.ok) {
    fail(res && res.error ? res.error : 'SpawnLoft could not save these locations.');
    go.disabled = false;
    $('#note').textContent = '';
  }
  // On success the app relaunches into the panel, so there is nothing left to do here.
};

init();
