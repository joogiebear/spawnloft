'use strict';
// ----------------------------------------------------------------- worlds ---

/**
 * What the instance holds, switched, imported, exported, deleted.
 *
 * <p>The gates live in the core: a running server cannot switch worlds, export the world
 * it is saving into, or delete anything - so the page states each refusal up front instead
 * of letting a click discover it.
 */
async function renderWorlds(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#worldsBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (!force && body.dataset.for === row.name && body.childElementCount) return;
  if (body.dataset.for !== row.name) paneLoading(body);
  body.dataset.for = row.name;

  let data;
  try {
    data = await api('/instances/' + encodeURIComponent(row.name) + '/worlds');
  } catch (e) {
    paneError(body, e.message, () => renderWorlds({ force: true }));
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== row.name) return;
  body.textContent = '';
  paneHead(body, 'map', 'Worlds',
    'Every world this server holds. Import a downloaded map, export one to share, choose which one runs.');

  const base = '/instances/' + encodeURIComponent(row.name) + '/worlds';
  const again = () => renderWorlds({ force: true });

  const how = document.createElement('div');
  how.className = 'hint';
  how.textContent = data.running
    ? 'The server is running: importing works now; switching, deleting and exporting the active world need it stopped.'
    : 'Switching worlds takes effect the next time the server starts.';
  body.append(how);
  // Said here because this is where a second world arrives: every one of them is backed up.
  const covered = document.createElement('div');
  covered.className = 'hint';
  covered.textContent = 'Standard, Worlds only and automatic backups cover every world listed here, not only the active one.';
  body.append(covered);

  // ---- import ----------------------------------------------------------------
  const add = document.createElement('div');
  add.className = 'section';
  const addTitle = document.createElement('h3');
  addTitle.textContent = 'Import a world';
  const srcRow = document.createElement('div');
  srcRow.className = 'row';
  const src = document.createElement('input');
  src.className = 'mono';
  src.spellcheck = false;
  src.autocomplete = 'off';
  src.placeholder = examplePath(panelPlatform, 'map') + ' — a zip, tar.gz, or a folder';
  src.setAttribute('aria-label', 'Where the world is: the path to a zip, a tar.gz or a folder');
  src.style.flex = '1 1 260px';
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.textContent = 'Browse…';
  browse.hidden = !desktop || !desktop.pickFile;
  srcRow.append(src, browse);
  const nameRow = document.createElement('div');
  nameRow.className = 'row';
  const wname = document.createElement('input');
  wname.placeholder = 'Name it — letters, numbers, dash, underscore';
  wname.setAttribute('aria-label', 'A name for the world: letters, numbers, dash, underscore');
  wname.autocomplete = 'off';
  wname.spellcheck = false;
  wname.style.maxWidth = '260px';
  const go = iconButton('plus', 'Import', 'primary');
  nameRow.append(wname, go);
  const addNote = document.createElement('div');
  addNote.className = 'hint';
  addNote.textContent = 'Never overwrites: the world arrives as a new entry here, and nothing changes '
    + 'until you make it the active one. The world inside the archive is found wherever it is nested.';
  add.append(addTitle, srcRow, nameRow, addNote);
  body.append(add);

  if (!browse.hidden) {
    browse.onclick = async () => {
      const picked = await desktop.pickFile('Choose a world archive or folder');
      if (!picked) return;
      src.value = picked;
      if (!wname.value.trim()) {
        const guess = picked.split(/[\\/]/).filter(Boolean).pop() || '';
        wname.value = guess.replace(/\.(zip|tar\.gz|tgz)$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32);
      }
    };
  }

  go.onclick = async () => {
    const source = src.value.trim();
    const name = wname.value.trim();
    if (!source || !name) { toast('A source and a name are both needed.', 'bad'); return; }
    go.disabled = true;
    go.dataset.holding = '1'; // not redrawn mid-import: a fresh page would offer Import again
    go.textContent = 'Importing…';
    try {
      const out = await post(base + '/import', { source: source, name: name });
      toast('Imported ' + out.name + ' (' + out.sizeHuman
        + (out.dimensions.length ? ', with ' + out.dimensions.join(' and ') : '') + ').', 'good');
      await again();
    } catch (e) {
      toast(e.message, 'bad');
      go.disabled = false;
      delete go.dataset.holding;
      go.textContent = 'Import';
    }
  };

  // ---- the worlds ------------------------------------------------------------
  const listTitle = document.createElement('h3');
  listTitle.className = 'hist-title';
  listTitle.textContent = 'Worlds (' + data.worlds.length + ')';
  body.append(listTitle);

  if (!data.worlds.length) {
    body.append(emptyState('map', 'No worlds yet. The server generates one on its first start, '
      + 'or import a downloaded map above.'));
    return;
  }
  const list = document.createElement('div');
  list.className = 'people';
  for (const w of data.worlds) list.append(worldRow(w));
  body.append(list);

  function worldRow(w) {
    const el = document.createElement('div');
    el.className = 'who';
    if (w.active) el.setAttribute('data-online', '');
    const mark = document.createElement('div');
    mark.className = 'face face-mark';
    mark.append(icon('map'));

    const nm = document.createElement('div');
    nm.className = 'w-name';
    const who = document.createElement('span');
    who.textContent = w.name;
    nm.append(who);
    if (w.active) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.tone = 'on';
      pill.textContent = 'Active';
      nm.append(pill);
    }
    for (const d of w.dimensions) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = d.replace('the_', 'the ');
      nm.append(pill);
    }

    const meta = document.createElement('div');
    meta.className = 'w-meta';
    meta.textContent = w.sizeHuman;

    const acts = document.createElement('div');
    acts.className = 'w-acts';
    const use = document.createElement('button');
    use.textContent = 'Set active';
    use.hidden = w.active;
    use.disabled = data.running;
    if (data.running) use.title = 'Stop the server first';
    const exp = iconButton('archive', 'Export');
    exp.disabled = w.active && data.running;
    if (exp.disabled) exp.title = 'The running server is saving into this world - stop it first, or take a backup';
    const drop = iconButton('trash', 'Delete', 'danger');
    drop.hidden = w.active;
    drop.disabled = data.running;
    if (data.running) drop.title = 'Stop the server first';
    acts.append(use, exp, drop);
    el.append(mark, nm, meta, acts);

    const busy = (on) => { for (const b of acts.children) b.disabled = on; };

    use.onclick = async () => {
      busy(true);
      try {
        await post(base + '/activate', { name: w.name });
        toast(w.name + ' is now the active world. Takes effect on the next start.', 'good');
        await refresh();
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false);
      }
    };

    exp.onclick = async () => {
      busy(true);
      exp.textContent = 'Exporting…';
      try {
        const out = await post(base + '/export', { name: w.name });
        toast('Exported to ' + out.file + ' (' + out.sizeHuman + ').', 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false);
        exp.textContent = 'Export';
      }
    };

    drop.onclick = async () => {
      const ok = await ask({
        title: 'Delete the world "' + w.name + '"?',
        text: (w.dimensions.length ? 'Its ' + w.dimensions.join(' and ') + ' go with it. ' : '')
          + 'A copy is kept first, so Backups can put it back.',
        confirmLabel: 'Delete world',
        danger: true,
        typeToConfirm: w.name,
      });
      if (!ok) return;
      busy(true);
      try {
        let out;
        try {
          out = await post(base + '/delete', { name: w.name });
        } catch (e) {
          if (e.code !== 'large') throw e;
          const sure = await ask({
            title: 'Delete "' + w.name + '" without a copy?',
            text: e.message + '. Deleted without one, the only way back is a backup that already holds it. Export it first if there is any doubt.',
            confirmLabel: 'Delete for good',
            danger: true,
            typeToConfirm: w.name,
          });
          if (!sure) { busy(false); return; }
          out = await post(base + '/delete', { name: w.name, withoutCopy: true });
        }
        toast('Deleted ' + out.removed.join(', ') + '.' + (out.snapshot ? ' A copy is in Backups.' : ''), 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false);
      }
    };
    return el;
  }
}

