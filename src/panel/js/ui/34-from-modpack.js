'use strict';
// ------------------------------------------------------------ from a modpack -

/**
 * The pack decides everything but the name and the memory. Search happens first because a
 * pack is a choice, not a text field - and only server-installable Fabric packs are shown,
 * so everything offered actually works.
 */
const packView = { chosen: null };

async function packSearch() {
  const term = $('#pSearch').value.trim();
  if (!term) return;
  const results = $('#packResults');
  $('#bPackSearch').disabled = true;
  results.textContent = '';
  const looking = document.createElement('div');
  looking.className = 'hint';
  looking.textContent = 'Asking Modrinth…';
  results.append(looking);
  let found;
  try {
    found = await api('/modpacks/search?q=' + encodeURIComponent(term));
  } catch (e) {
    looking.remove();
    const bad = document.createElement('div');
    bad.className = 'bad';
    bad.textContent = e.message;
    results.append(bad);
    $('#bPackSearch').disabled = false;
    return;
  }
  $('#bPackSearch').disabled = false;
  results.textContent = '';
  if (!found.results.length) {
    const none = document.createElement('div');
    none.className = 'hint';
    none.textContent = 'No server-ready Fabric or NeoForge packs match that.';
    results.append(none);
    return;
  }
  const list = document.createElement('div');
  list.className = 'people';
  for (const hit of found.results) {
    const el = document.createElement('div');
    el.className = 'who';
    const mark = document.createElement('div');
    mark.className = 'face face-mark';
    mark.append(icon('archive'));
    const nm = document.createElement('div');
    nm.className = 'w-name';
    nm.textContent = hit.title;
    const meta = document.createElement('div');
    meta.className = 'w-meta';
    meta.textContent = (hit.downloads ? hit.downloads.toLocaleString() + ' downloads  ·  ' : '') + (hit.description || '');
    const acts = document.createElement('div');
    acts.className = 'w-acts';
    const use = document.createElement('button');
    use.className = 'primary';
    use.textContent = 'Use this pack';
    acts.append(use);
    el.append(mark, nm, meta, acts);
    list.append(el);
    use.onclick = () => {
      packView.chosen = hit;
      $('#packChosen').textContent = hit.title;
      $('#packChosenWrap').hidden = false;
      if (!$('#pName').value.trim()) {
        $('#pName').value = (hit.slug || hit.title).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
        checkName($('#pName'), $('#pNameBad'));
      }
      $('#pName').focus();
    };
  }
  results.append(list);
}
$('#bPackSearch').onclick = packSearch;
$('#pSearch').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); packSearch(); } };
$('#pName').oninput = () => checkName($('#pName'), $('#pNameBad'));
$('#pMem').oninput = () => checkMemory($('#pMem'), $('#pMemBad'));

$('#formPack').onsubmit = async (e) => {
  e.preventDefault();
  if (!packView.chosen) return;
  if ($('#bPackCreate').dataset.job) return;
  if (!checkName($('#pName'), $('#pNameBad'))) { $('#pName').focus(); return; }
  if (!checkMemory($('#pMem'), $('#pMemBad'))) { $('#pMem').focus(); return; }

  const jobId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'job-' + Date.now();
  const bar = $('#packBar');
  const msg = $('#packMsg');
  $('#packProg').hidden = false;
  bar.style.width = '0';
  bar.classList.add('indet');
  msg.textContent = 'Starting…';
  const restorePack = cancelButtonFor($('#bPackCreate'), jobId);
  lockAddTabs(true);

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
    const inst = await post('/instances', {
      label: $('#pName').value.trim(),
      name: slugOf($('#pName')),
      modpack: packView.chosen.id,
      memory: $('#pMem').value.trim() || '4G',
      jobId: jobId,
    });
    jobs.close();
    lockAddTabs(false);
    $('#packProg').hidden = true;
    restorePack();
    await refresh();
    select(inst.name);
    toast('Created ' + (inst.label || inst.name) + ' from ' + packView.chosen.title + '.', 'good');
  } catch (err) {
    jobs.close();
    lockAddTabs(false);
    bar.classList.remove('indet');
    bar.style.width = '0';
    msg.textContent = cancelledWords(err) || err.message;
    restorePack();
    if (cancelledWords(err)) { $('#bPackCreate').focus(); return; }
    toast(err.message, 'bad');
  }
};

// A folder is something you point at, not a path you type. Only the app can offer that, so only
// the app shows the button - the browser keeps the text field it always had.
if (desktop) {
  $('#bBrowse').hidden = false;
  $('#aDirHint').textContent = 'The folder holding the server jar and server.properties.';
  $('#bBrowse').onclick = async () => {
    const dir = await desktop.pickFolder('Choose the server folder');
    if (!dir) return;
    $('#aDir').value = dir;
    if (!$('#aName').value.trim()) {
      const guess = dir.split(/[\\/]/).filter(Boolean).pop() || '';
      $('#aName').value = guess.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
      checkName($('#aName'), $('#aNameBad'));
    }
  };
}

