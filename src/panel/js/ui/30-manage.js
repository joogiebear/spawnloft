'use strict';
// --------------------------------------------------------------- manage ----

// What "⋯" beside Start and Stop offers is built by moreItems(); these are the actions behind it.

async function openFolder(name) {
  try {
    await post('/instances/' + encodeURIComponent(name) + '/reveal');
  } catch (e) {
    toast(e.message, 'bad');
  }
}

/** What an Edit asks the core to do: a rename, a patch of the settings that changed, both or neither. */
function editPlan(row, typed) {
  const patch = {};
  if (typed.label !== (row.label || '')) patch.label = typed.label;
  if (typed.memory && typed.memory !== row.memory) patch.memory = typed.memory;
  if (typed.port && Number(typed.port) !== row.port) patch.port = typed.port;
  return {
    rename: typed.name && typed.name !== row.name ? typed.name : null,
    patch: Object.keys(patch).length ? patch : null,
  };
}

async function editServer(row) {
  const dlg = $('#dlg');
  clearDlgDetail();
  $('#dlgTitle').textContent = 'Edit ' + row.name;
  $('#dlgText').hidden = false;
  $('#dlgText').textContent = 'Changes apply the next time this server starts.';
  $('#dlgChoice').hidden = true;
  $('#dlgTypeWrap').hidden = true;

  const form = document.createElement('div');
  form.style.display = 'grid';
  form.style.gap = '12px';
  const fields = [
    ['Name', 'edLabel', row.label || '', 'text'],
    ['Folder and command name', 'edName', row.name, 'text'],
    ['Memory', 'edMem', row.memory || '4G', 'text'],
    ['Port', 'edPort', String(row.port || ''), 'number'],
  ];
  for (const f of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const l = document.createElement('label');
    l.setAttribute('for', f[1]);
    l.textContent = f[0];
    const i = document.createElement('input');
    i.id = f[1];
    i.type = f[3];
    i.className = 'mono';
    i.value = f[2];
    i.autocomplete = 'off';
    wrap.append(l, i);
    form.append(wrap);
  }
  $('#dlgBody').append(form);

  const ok = $('#dlgOk');
  ok.textContent = 'Save changes';
  ok.className = 'primary';
  ok.disabled = false;
  // The <dialog> is shared, so anything ask() may have hidden has to be put back.
  $('#dlgCancel').hidden = false;

  const mine = ++askSeq;
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onClose);
      ok.onclick = null;
      $('#dlgCancel').onclick = null;
      if (dlg.open) dlg.close();
      form.remove();
      resolve(v);
    };
    // 'cancel' first and 'close' as the net, for the reasons spelled out in ask().
    // Escape while a save runs would leave the rename going with nobody to hear how it went.
    let saving = false;
    const onCancel = (e) => {
      if (mine !== askSeq) return;
      if (saving) return e.preventDefault();
      done(null);
    };
    // A stale 'close' - queued by the dialog this one replaced, arriving after showModal() - finds
    // the dialog open again; a real close finds it shut. Only the real one is an answer.
    const onClose = () => {
      if (mine !== askSeq || dlg.open) return;
      if (saving) return dlg.showModal();
      done(null);
    };
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onClose);
    const errBox = $('#dlgError');
    errBox.hidden = true;
    // Saved while the dialog is open: a name that is taken or a port in use is said here, under
    // the fields, with what was typed still in them.
    let name = row.name;
    ok.onclick = async () => {
      const typed = {
        label: $('#edLabel').value.trim(),
        name: $('#edName').value.trim(),
        memory: $('#edMem').value.trim(),
        port: $('#edPort').value.trim(),
      };
      // After a rename that took and a save that did not, the list may not have caught up: the
      // server is planned from under its new name either way, so the rename is not asked twice.
      const now = rowOf(name) || { ...row, name };
      const plan = editPlan(now, typed);
      if (!plan.rename && !plan.patch) return done(name === row.name ? { changed: false } : { changed: true, name, renamed: true, patched: false });
      saving = true;
      ok.disabled = true;
      $('#dlgCancel').disabled = true;
      errBox.hidden = true;
      let renamed = false;
      try {
        // The name first: it is the change most often refused, and refused it leaves nothing
        // half saved.
        if (plan.rename) {
          await post('/instances/' + encodeURIComponent(name) + '/rename', { to: plan.rename });
          name = plan.rename;
          renamed = true;
        }
        if (plan.patch) await post('/instances/' + encodeURIComponent(name) + '/settings', plan.patch);
        saving = false;
        done({ changed: true, name, renamed: name !== row.name, patched: Boolean(plan.patch) });
      } catch (e) {
        saving = false;
        if (mine !== askSeq || settled) return;
        if (renamed) { state.current = null; await refresh(); select(name); }
        errBox.textContent = (renamed ? 'The folder name is now ' + name + ', but the rest was not saved. ' : '') + e.message;
        errBox.hidden = false;
        ok.disabled = false;
        $('#dlgCancel').disabled = false;
      }
    };
    $('#dlgCancel').onclick = () => done(name !== row.name ? { changed: true, name, renamed: true, patched: false } : null);
    dlg.showModal();
    $('#edLabel').focus();
  });
  $('#dlgCancel').disabled = false;
  if (!result || !result.changed) return;

  if (result.renamed) {
    if (state.current !== result.name) { state.current = null; await refresh(); select(result.name); }
    const named = rowOf(result.name);
    toast('Saved' + (named && named.label && named.label !== result.name ? ' ' + named.label : '') + '. Its folder name is now ' + result.name + '.', 'good');
    return;
  }
  await refresh();
  if (result.patched) toast('Saved. Takes effect on the next start.', 'good');
}

async function rebuildServer(row) {
  const res = await ask({
    title: 'Reset the world of ' + row.name + '?',
    text: 'Worlds, logs and cached state are deleted. A backup is taken first, so this can be undone.',
    confirmLabel: 'Reset world',
    danger: true,
    typeToConfirm: row.name,
    choices: [
      { value: 'keep', label: 'Keep plugins', hint: 'Plugin jars and their config survive. Usually what you want.' },
      { value: 'wipe', label: 'Remove plugins too', hint: 'Starts over completely, as if the server were new.' },
    ],
  });
  if (!res) return;
  const note = toast('Backing up, then resetting ' + row.name + '…');
  try {
    const out = await post('/instances/' + encodeURIComponent(row.name) + '/rebuild', {
      keepPlugins: res.choice === 'keep',
    });
    note.remove();
    toast('Reset. What was there is in Backups.', 'good');
    clearLines();
    renderLog();
    await refresh();
  } catch (e) {
    note.remove();
    toast(e.message, 'bad');
  }
}

async function deleteServer(row) {
  const res = await ask({
    title: 'Delete ' + row.name + '?',
    confirmLabel: 'Delete server',
    danger: true,
    typeToConfirm: row.name,
    choices: [
      { value: 'keep', label: 'Remove from SpawnLoft, keep the files', hint: 'The folder stays where it is. You can add it again later.' },
      { value: 'purge', label: 'Delete the files as well', hint: 'The whole server folder goes. A backup is taken first.' },
    ],
  });
  if (!res) return;
  const note = toast('Deleting ' + row.name + '…');
  try {
    const out = await post('/instances/' + encodeURIComponent(row.name) + '/delete', {
      purge: res.choice === 'purge',
    });
    note.remove();
    stopStream();
    state.current = null;
    clearLines();
    show('empty');
    await refresh();
    toast(out.purged
      ? 'Deleted. A backup of it was saved to ' + (out.snapshot || 'the backups folder') + '.'
      : 'Removed from SpawnLoft. The files are still in their folder.', 'good');
  } catch (e) {
    note.remove();
    toast(e.message, 'bad');
  }
}

