'use strict';
// -------------------------------------------------------------- versions ---

// Nothing can be created until the version list arrives or fails, so the button says so instead of
// submitting an empty version and failing on the server.
$('#bCreate').disabled = true;

/**
 * The version dropdown follows the Software choice: Paper's versions from PaperMC, Fabric's
 * from its meta API. Each list is fetched once and kept, so flipping between the two is
 * instant after the first look.
 */
const versionLists = {};

/**
 * What can be created, from the server's one table. Until it answers the dropdown holds Paper,
 * so a slow or failed fetch degrades to the one choice that always existed.
 */
const softwareById = {
  paper: { id: 'paper', label: 'Paper', content: 'plugins', blurb: 'Downloads the newest stable Paper build.' },
};

async function loadSoftware() {
  let list;
  try {
    list = await api('/software');
  } catch {
    return;
  }
  const sel = $('#nLoader');
  const current = sel.value;
  sel.textContent = '';
  for (const s of list) {
    softwareById[s.id] = s;
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    if (s.id === current) o.selected = true;
    sel.append(o);
  }
}

/**
 * What Java each version needs, said in the dropdown and under it.
 *
 * Asked once per loader after the versions arrive. Each option gains "· Java 21"; when the
 * selected version needs more than the newest Java on this machine, the hint under the
 * dropdown says so with the download link, before anyone presses Create and waits on a
 * download only to be told at the end.
 */
const javaNeedsByLoader = {};
async function annotateJavaNeeds(loader) {
  const sel = $('#nVersion');
  const list = versionLists[loader];
  if (!list || !list.length) return;
  if (!javaNeedsByLoader[loader]) {
    try {
      javaNeedsByLoader[loader] = await api('/java/needs?versions=' + encodeURIComponent(list.join(',')));
    } catch {
      return;
    }
  }
  if ($('#nLoader').value !== loader) return;
  const info = javaNeedsByLoader[loader];
  for (const o of sel.options) {
    const n = info.needs[o.value];
    if (n && !/· Java/.test(o.textContent)) o.textContent += '  · Java ' + n;
  }
  const say = () => {
    const n = info.needs[sel.value];
    const warn = $('#nJavaWarn');
    if (!n || info.have == null || info.have >= n) { warn.hidden = true; return; }
    warn.hidden = false;
    warn.textContent = '';
    warn.append('Minecraft ' + sel.value + ' needs Java ' + n + '. The newest Java found on this machine is '
      + info.have + '. ');
    const a = document.createElement('a');
    a.href = info.download;
    a.textContent = 'Get Java ' + n;
    a.onclick = (e) => { e.preventDefault(); openOutside(info.download); };
    warn.append(a, document.createTextNode(' first, or create it anyway and point it at a Java of your own afterwards.'));
  };
  sel.onchange = say;
  say();
}

async function loadVersions(loader) {
  const sel = $('#nVersion');
  const sw = softwareById[loader] || softwareById.paper;
  $('#nVersionHint').textContent = sw.blurb;
  $('#nLoaderHint').textContent = sw.content === 'mods' ? 'Runs mods'
    : sw.content === 'none' ? 'No plugins or mods'
      : 'Runs plugins';
  const note = $('#nVersionBad');
  note.textContent = '';
  if (!versionLists[loader]) {
    sel.disabled = true;
    sel.textContent = '';
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Loading versions…';
    sel.append(o);
    paintNewSummary();
    try {
      versionLists[loader] = await api('/' + loader + '/versions');
    } catch {
      // The reason goes under the field, whole, with a way to try again; as the select's own text
      // it was cut off at "Could not reach the Paper dov".
      sel.textContent = '';
      const bad = document.createElement('option');
      bad.value = '';
      bad.textContent = 'Unavailable';
      sel.append(bad);
      note.append('Could not reach the ' + sw.label + ' download service. ');
      const retry = el('button', 'ghost inline');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.onclick = () => { if ($('#nLoader').value === loader) loadVersions(loader); };
      note.append(retry);
      paintNewSummary();
      // A dead end is not an empty dropdown. Creating needs the download; adding a server you
      // already have does not, and that is a real way forward rather than an instruction to
      // come back later.
      $('#newHint').textContent = 'Creating a server needs a connection, to download the server jar. '
        + 'A server you already have can still be added.';
      $('#bCreate').disabled = true;
      if (!$('#bJumpAdopt')) {
        const jump = document.createElement('button');
        jump.id = 'bJumpAdopt';
        jump.type = 'button';
        jump.textContent = 'Add an existing server instead';
        jump.onclick = () => selectTab('adopt');
        $('#bCreate').after(jump);
      }
      return;
    }
  }
  sel.textContent = '';
  versionLists[loader].forEach((v, i) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v + (i === 0 ? ' (newest)' : '');
    if (i === 0) o.selected = true;
    sel.append(o);
  });
  annotateJavaNeeds(loader);
  sel.disabled = false;
  $('#bCreate').disabled = false;
  $('#bJumpAdopt')?.remove();
  if (/^Creating a server needs a connection/.test($('#newHint').textContent)) {
    $('#newHint').textContent = 'Accepts the Minecraft EULA on your behalf, as the operator of this machine.';
  }
  paintNewSummary();
}

$('#nLoader').onchange = () => loadVersions($('#nLoader').value);
loadSoftware().then(() => loadVersions($('#nLoader').value));

