'use strict';
// ------------------------------------------------------------------ files ---

/**
 * The Files tool: the server's folder, browsed, and any text file in it edited.
 *
 * <p>Not a second Explorer. It is here so the file SpawnLoft has no form for - a plugin's config, a
 * datapack, a list a plugin keeps - can be changed without leaving the server, with the safety net
 * the rest of the panel has: an edit, a replaced file or a delete copies what it changes first,
 * and Backups can put back exactly that.
 *
 * <p>Where you were is kept per server, open file and unsaved text included, so closing the tool or
 * looking at another server loses nothing.
 */
const filesByServer = new Map();

function filesStateFor(name) {
  if (!filesByServer.has(name)) filesByServer.set(name, { dir: '', selected: new Set(), query: '', editing: null });
  return filesByServer.get(name);
}

/** The servers with a file open in the editor whose text is not what was last saved. */
function unsavedFiles(views) {
  const out = [];
  for (const [name, view] of views) {
    if (view.editing && view.editing.text !== view.editing.original) out.push(name);
  }
  return out;
}

// Unsaved text in the editor lives only in this page. Reloading or closing it asks first; the
// browser words the question itself.
window.addEventListener('beforeunload', (ev) => {
  if (!unsavedFiles(filesByServer).length && !settingsWaiting()) return;
  ev.preventDefault();
  ev.returnValue = '';
});

// A file dropped anywhere that does not take files would make the browser open it in place of the
// panel, and everything unsaved goes with the page. Whatever accepts a drop has already called
// preventDefault() by the time the event gets here; everything else is refused, and shown as
// refused by the pointer.
window.addEventListener('dragover', (ev) => {
  if (ev.defaultPrevented || !ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (ev) => {
  if (ev.defaultPrevented || !ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
  ev.preventDefault();
});

function fileSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
}

const ARCHIVE_RE = /\.(zip|mrpack|tar\.gz|tgz)$/i;

function downloadPath(row, p) {
  const a = document.createElement('a');
  a.href = '/api/instances/' + encodeURIComponent(row.name) + '/files/download?path=' + encodeURIComponent(p);
  a.download = p.split('/').pop();
  document.body.append(a);
  a.click();
  a.remove();
}

/** The Kind column: a folder, a link, or the file's extension as people say it. */
function fileKind(e) {
  if (e.type === 'dir') return 'Folder';
  if (e.type === 'link') return 'Link';
  if (e.type !== 'file') return 'Other';
  const m = /\.([a-z0-9]{1,8})$/i.exec(e.name || e.path || '');
  if (!m) return 'File';
  const ext = m[1].toLowerCase();
  const known = { jar: 'Jar', yml: 'YAML', yaml: 'YAML', json: 'JSON', toml: 'TOML', properties: 'Properties', log: 'Log', gz: 'Archive', zip: 'Archive', txt: 'Text', md: 'Markdown', sh: 'Script', bat: 'Script', dat: 'Data', mca: 'Region', png: 'Image', jpg: 'Image', lock: 'Lock' };
  return known[ext] || ext.toUpperCase();
}

/** The path a rename gives: the same folder, the new name. */
function renamedPath(path, name) {
  const at = path.lastIndexOf('/');
  return (at < 0 ? '' : path.slice(0, at + 1)) + name;
}

/** The path a move gives: the same name, in the folder typed ('' is the server folder). */
function movedPath(path, folder) {
  const dir = String(folder ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const name = path.split('/').pop();
  return dir ? dir + '/' + name : name;
}

/** Every path from one row to another, both included, in the order listed. Null when either is gone. */
function pathsBetween(entries, a, b) {
  const i = entries.findIndex((e) => e.path === a);
  const j = entries.findIndex((e) => e.path === b);
  if (i < 0 || j < 0) return null;
  return entries.slice(Math.min(i, j), Math.max(i, j) + 1).map((e) => e.path);
}

/**
 * What a row's menu offers, in order. Something the running server holds can be opened and
 * downloaded but not renamed, moved or deleted, and the menu says why.
 */
function fileRowActions(e) {
  const held = e.inUse ? 'In use by the running server' : '';
  const folder = e.type === 'dir';
  const acts = [];
  if (folder) acts.push({ id: 'open', label: 'Open' });
  else if (e.type === 'file') acts.push({ id: 'open', label: 'Open' });
  if (e.type !== 'file' && !folder) return acts;
  acts.push({ id: 'rename', label: 'Rename', hint: held, disabled: Boolean(e.inUse) });
  acts.push({ id: 'move', label: 'Move to\u2026', hint: held, disabled: Boolean(e.inUse) });
  acts.push({ id: 'download', label: folder ? 'Download as a zip' : 'Download' });
  if (!folder && ARCHIVE_RE.test(e.path)) acts.push({ id: 'unzip', label: 'Unzip here' });
  acts.push({ id: 'delete', label: 'Delete', hint: held, disabled: Boolean(e.inUse), danger: true });
  return acts;
}

/**
 * The one menu every row shares. It hangs from the page, not the list (which clips), beside the
 * button that opened it, and goes when something else is pressed, the page scrolls or resizes.
 */
const rowMenu = (() => {
  let menu = null;
  let owner = null;
  const close = (refocus) => {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (owner) {
      owner.setAttribute('aria-expanded', 'false');
      if (refocus && owner.isConnected) owner.focus();
    }
    owner = null;
  };
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target) && !(owner && owner.contains(e.target))) close(false);
  });
  document.addEventListener('scroll', (e) => { if (menu && !menu.contains(e.target)) close(false); }, true);
  window.addEventListener('resize', () => close(false));
  const open = (button, items, run) => {
    if (owner === button) { close(true); return; }
    close(false);
    owner = button;
    menu = document.createElement('div');
    menu.className = 'menu row-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', button.getAttribute('aria-label') || 'Actions');
    for (const item of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.disabled = Boolean(item.disabled);
      if (item.danger) b.dataset.tone = 'danger';
      const title = document.createElement('b');
      title.textContent = item.label;
      b.append(title);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.textContent = item.hint;
        b.append(hint);
      }
      b.onclick = () => { close(true); run(item.id); };
      menu.append(b);
    }
    menu.addEventListener('keydown', (e) => {
      const list = Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
      const at = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(true);
      else if (!list.length) return;
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    });
    document.body.append(menu);
    // under the button, its right edge on the button's; above it when there is no room below
    const at = button.getBoundingClientRect();
    const tall = menu.offsetHeight;
    // measured without the page's scrollbar, which innerWidth counts
    const page = document.documentElement;
    const below = at.bottom + 4 + tall <= page.clientHeight - 8;
    menu.style.top = Math.max(8, below ? at.bottom + 4 : at.top - 4 - tall) + 'px';
    menu.style.right = Math.max(8, page.clientWidth - at.right) + 'px';
    button.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('[role="menuitem"]:not(:disabled)');
    if (first) first.focus();
  };
  return { open, close };
})();

async function renderFiles(opts) {
  const force = Boolean(opts && opts.force);
  const row = rowOf(state.current);
  const body = $('#filesBody');
  if (!row) { body.textContent = ''; clearPaneHead(body); return; }
  if (!force && body.dataset.for === row.name && body.childElementCount) return;
  if (body.dataset.for !== row.name) paneLoading(body);
  // a menu left open belongs to the rows of the server it was opened on
  if (body.dataset.for !== row.name) rowMenu.close(false);
  body.dataset.for = row.name;
  const view = filesStateFor(row.name);
  if (view.editing) return renderFileEditor(row, view);

  const base = '/instances/' + encodeURIComponent(row.name) + '/files';
  let data;
  try {
    data = view.query
      ? await api(base + '/search?path=' + encodeURIComponent(view.dir) + '&q=' + encodeURIComponent(view.query))
      : await api(base + '?path=' + encodeURIComponent(view.dir));
  } catch (e) {
    // A folder that went away (renamed outside, deleted) takes you back to the top rather than
    // leaving you in front of an error with nowhere to go.
    if (view.dir && !view.query) { view.dir = ''; view.selected.clear(); return renderFiles({ force: true }); }
    paneError(body, e.message, () => renderFiles({ force: true }));
    body.dataset.for = '';
    return;
  }
  if (body.dataset.for !== row.name || view.editing) return;
  const running = data.running;
  const entries = view.query ? data.results : data.entries;
  for (const p of [...view.selected]) if (!entries.some((e) => e.path === p)) view.selected.delete(p);

  rowMenu.close(false);
  body.textContent = '';
  paneHead(body, 'folder', 'Files',
    'Everything in this server’s folder. An edit, a replaced file or a delete keeps a copy first, which Backups can put back.');
  const again = () => renderFiles({ force: true });
  const go = (dir) => { view.dir = dir; view.query = ''; view.selected.clear(); again(); };

  if (running) {
    const how = document.createElement('div');
    how.className = 'hint';
    how.textContent = 'The server is running: files it holds open (the active world, its jar, the plugins it loaded) are marked In use and cannot be moved, replaced or deleted until it stops. '
      + 'They can still be read and edited; a changed config applies when the plugin reloads or the server restarts.';
    body.append(how);
  }

  // ---- where, and what to do here -----------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'fm-bar';
  const crumbs = document.createElement('nav');
  crumbs.className = 'fm-crumbs';
  crumbs.setAttribute('aria-label', 'Folder');
  const parts = view.dir ? view.dir.split('/') : [];
  const crumb = (label, dir, current) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = label;
    if (current) b.setAttribute('aria-current', 'location');
    b.onclick = () => go(dir);
    return b;
  };
  crumbs.append(crumb(row.label || row.name, '', !parts.length && !view.query));
  parts.forEach((p, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    crumbs.append(sep, crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1 && !view.query));
  });

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'fm-search';
  search.placeholder = view.dir ? 'Find in this folder' : 'Find a file';
  search.setAttribute('aria-label', 'Find files by name');
  search.value = view.query;
  search.dataset.kept = '1';
  search.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = search.value.trim();
      if (q && q.length < 2) { toast('Search for at least two characters.', 'bad'); return; }
      view.query = q;
      view.selected.clear();
      again();
    }
  };
  search.onsearch = () => { if (!search.value && view.query) { view.query = ''; again(); } };

  // Upload is what this toolbar is for most; the rest are there when wanted, at a lower voice.
  const newFile = iconButton('file', 'New file', 'ghost');
  const newFolder = iconButton('folder', 'New folder', 'ghost');
  const upload = iconButton('upload', 'Upload files', 'primary');
  const uploadDir = iconButton('folder', 'Upload a folder');
  const reveal = iconButton('external', 'Open in ' + FILE_MANAGER, 'ghost');
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  const dirPicker = document.createElement('input');
  dirPicker.type = 'file';
  dirPicker.webkitdirectory = true;
  dirPicker.hidden = true;
  bar.append(crumbs, search, newFile, newFolder, upload, uploadDir, reveal, picker, dirPicker);
  body.append(bar);

  newFile.onclick = async () => {
    const got = await ask({
      title: 'New file in ' + (view.dir || 'the server folder'),
      input: { label: 'Name', placeholder: 'config.yml', required: true },
      confirmLabel: 'Create',
      submit: ({ text }) => post(base + '/write', { path: view.dir ? view.dir + '/' + text : text, text: '', create: true }),
    });
    if (!got) return;
    view.editing = { path: got.out.path, text: '', original: '', version: got.out.version };
    again();
  };
  newFolder.onclick = async () => {
    const got = await ask({
      title: 'New folder in ' + (view.dir || 'the server folder'),
      input: { label: 'Name', required: true },
      confirmLabel: 'Create',
      submit: ({ text }) => post(base + '/mkdir', { dir: view.dir, name: text }),
    });
    if (got) go(got.out.path);
  };
  upload.onclick = () => picker.click();
  picker.onchange = () => { uploadFiles(row, view, [...picker.files].map((f) => ({ file: f, name: f.name }))).then(again); picker.value = ''; };
  uploadDir.onclick = () => dirPicker.click();
  dirPicker.onchange = () => {
    // webkitRelativePath is "Folder/sub/file": the folder's own name is kept, as a drop keeps it.
    const picked = [...dirPicker.files].map((f) => ({ file: f, name: f.webkitRelativePath || f.name }));
    dirPicker.value = '';
    if (!picked.length) { toast('Nothing to upload: the folder is empty.', 'bad'); return; }
    uploadFiles(row, view, picked).then(again);
  };
  reveal.onclick = async () => {
    try { await post('/instances/' + encodeURIComponent(row.name) + '/reveal', { folder: view.dir }); }
    catch (e) { toast(e.message, 'bad'); }
  };

  // ---- one thing at a time -----------------------------------------------------
  const renameOne = async (path) => {
    const was = path.split('/').pop();
    const got = await ask({
      title: 'Rename ' + was,
      input: { label: 'New name', value: was, required: true },
      confirmLabel: 'Rename',
      submit: ({ text }) => {
        const name = text.trim();
        if (/[\\/]/.test(name)) throw new Error('A name has no slashes in it. Use Move to put it in another folder.');
        return name === was ? null : post(base + '/move', { from: path, to: renamedPath(path, name) });
      },
    });
    if (!got || !got.out) return;
    view.selected.clear();
    again();
  };
  const moveOne = async (path) => {
    const name = path.split('/').pop();
    const from = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const got = await ask({
      title: 'Move ' + name,
      text: 'The folder to put it in, as a path from the server folder: plugins/Old, for one. Leave it empty for the server folder itself.',
      input: { label: 'Folder', value: from, placeholder: 'the server folder' },
      confirmLabel: 'Move',
      submit: ({ text }) => {
        const to = movedPath(path, text);
        return to === path ? null : post(base + '/move', { from: path, to });
      },
    });
    if (!got || !got.out) return;
    toast('Moved ' + name + ' to ' + (got.out.path || movedPath(path, '')) + '.', 'good');
    view.selected.clear();
    again();
  };
  const unzipOne = async (path, button) => {
    if (button) button.disabled = true;
    try {
      const out = await post(base + '/extract', { path });
      toast('Unpacked into ' + out.path + '.', 'good');
      go(out.path);
    } catch (e) { toast(e.message, 'bad'); if (button) button.disabled = false; }
  };
  const heldWords = (e) => e.name + ' is in use by the running server, so it cannot be renamed, moved or deleted until the server stops.';

  // ---- what is selected -------------------------------------------------------
  const sel = [...view.selected];
  const selEntries = entries.filter((e) => view.selected.has(e.path));
  if (sel.length) {
    const acts = document.createElement('div');
    acts.className = 'fm-sel';
    const count = document.createElement('b');
    count.textContent = sel.length + ' selected';
    const dl = iconButton('download', 'Download');
    dl.hidden = sel.length !== 1;
    const rename = iconButton('pencil', 'Rename');
    rename.hidden = sel.length !== 1;
    const move = iconButton('folder', 'Move');
    move.hidden = sel.length !== 1;
    const zip = iconButton('archive', 'Zip');
    const unzip = iconButton('archive', 'Unzip');
    unzip.hidden = !(sel.length === 1 && selEntries[0] && selEntries[0].type === 'file' && ARCHIVE_RE.test(sel[0]));
    const del = iconButton('trash', 'Delete', 'danger');
    const busy = selEntries.filter((e) => e.inUse);
    // said beside the buttons: a button that is off cannot take focus to show a tip
    const whyOff = document.createElement('span');
    whyOff.className = 'hint';
    whyOff.hidden = !busy.length;
    if (busy.length) {
      del.disabled = true;
      rename.disabled = true;
      move.disabled = true;
      whyOff.textContent = heldWords(busy[0]);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ghost';
    clear.textContent = 'Clear';
    acts.append(count, dl, rename, move, zip, unzip, del, clear, whyOff);
    body.append(acts);

    clear.onclick = () => { view.selected.clear(); again(); };
    dl.onclick = () => downloadPath(row, sel[0]);
    rename.onclick = () => renameOne(sel[0]);
    move.onclick = () => moveOne(sel[0]);
    zip.onclick = async () => {
      const first = sel[0].split('/').pop();
      const got = await ask({
        title: 'Zip ' + (sel.length === 1 ? first : sel.length + ' items'),
        input: { label: 'Archive name', value: (sel.length === 1 ? first.replace(/\.[^.]+$/, '') : 'archive') + '.zip', required: true },
        confirmLabel: 'Zip',
        submit: ({ text }) => post(base + '/archive', { paths: sel, name: text }),
      });
      if (!got) return;
      toast('Made ' + got.out.path + ' (' + fileSize(got.out.size) + ').', 'good', { stay: true });
      view.selected.clear();
      again();
    };
    unzip.onclick = () => unzipOne(sel[0], unzip);
    del.onclick = () => deleteFiles(row, view, sel, entries).then(again);
  }

  // ---- the listing ------------------------------------------------------------
  if (view.query) {
    const t = document.createElement('h3');
    t.className = 'hist-title';
    t.textContent = entries.length + (data.truncated ? '+' : '') + ' named like “' + view.query + '”';
    body.append(t);
  }
  const list = document.createElement('div');
  list.className = 'fm-list';
  list.setAttribute('role', 'table');
  list.setAttribute('aria-label', 'Files');
  const head = document.createElement('div');
  head.className = 'fm-row fm-head';
  head.setAttribute('role', 'row');
  const all = document.createElement('input');
  all.type = 'checkbox';
  all.setAttribute('aria-label', 'Select all');
  all.checked = entries.length > 0 && entries.every((e) => view.selected.has(e.path));
  all.onchange = () => { if (all.checked) for (const e of entries) view.selected.add(e.path); else view.selected.clear(); again(); };
  for (const [cls, text] of [['fm-name', 'Name'], ['fm-kind', 'Kind'], ['fm-size', 'Size'], ['fm-when', 'Modified']]) {
    const c = document.createElement('span');
    c.className = cls;
    c.setAttribute('role', 'columnheader');
    c.textContent = text;
    head.append(c);
  }
  head.prepend(all);
  list.append(head);

  if (view.dir && !view.query) {
    const up = document.createElement('div');
    up.className = 'fm-row';
    up.setAttribute('role', 'row');
    const spacer = document.createElement('span');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fm-name fm-open';
    b.append(icon('folder'), document.createTextNode('..'));
    b.setAttribute('aria-label', 'Up one folder');
    b.onclick = () => go(parts.slice(0, -1).join('/'));
    up.append(spacer, b);
    list.append(up);
  }

  for (const e of entries) {
    const line = document.createElement('div');
    line.className = 'fm-row';
    line.setAttribute('role', 'row');
    if (view.selected.has(e.path)) line.setAttribute('data-selected', '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = view.selected.has(e.path);
    box.setAttribute('aria-label', 'Select ' + e.name);
    // Shift and a click ticks, or unticks, everything from the last box used to this one.
    // Shift and a click would also pick the page's text between the two rows
    line.addEventListener('mousedown', (ev) => { if (ev.shiftKey) ev.preventDefault(); });
    box.onclick = (ev) => {
      const range = ev.shiftKey && view.anchor ? pathsBetween(entries, view.anchor, e.path) : null;
      for (const p of range || [e.path]) {
        if (box.checked) view.selected.add(p); else view.selected.delete(p);
      }
      view.anchor = e.path;
      again();
    };
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'fm-name fm-open';
    open.append(icon(e.type === 'dir' ? 'folder' : 'file'));
    const nm = document.createElement('span');
    nm.textContent = view.query ? e.path : e.name;
    // The row truncates a long name; the whole path is a pointer away.
    open.title = e.path;
    open.append(nm);
    if (e.inUse) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.tone = 'on';
      pill.textContent = 'In use';
      pill.title = 'The running server holds this. Stop it to move, replace or delete it.';
      open.append(pill);
    }
    if (e.type === 'link') open.title = 'A link that leads outside the server folder';
    const kind = document.createElement('span');
    kind.className = 'fm-kind';
    kind.textContent = fileKind(e);
    const size = document.createElement('span');
    size.className = 'fm-size';
    // A folder's size would mean walking it on every listing; a dash says "not counted", where a
    // blank cell read as a missing value.
    size.textContent = e.type === 'dir' ? '—' : fileSize(e.size);
    const when = document.createElement('span');
    when.className = 'fm-when';
    const whenShort = document.createElement('span');
    whenShort.className = 'short';
    whenShort.textContent = stamp(e.modified);
    const whenLong = document.createElement('span');
    whenLong.className = 'long';
    whenLong.textContent = STAMP_YEAR.format(new Date(e.modified));
    when.append(whenShort, whenLong);
    when.title = whenLong.textContent;
    line.append(box, open, kind, size, when);
    list.append(line);

    const openIt = () => {
      if (e.type === 'dir') go(e.path);
      else if (e.type === 'file') openFile(row, view, e.path);
    };
    open.onclick = openIt;
    const actions = fileRowActions(e);
    const act = (id) => {
      if (id === 'open') openIt();
      else if (id === 'rename') renameOne(e.path);
      else if (id === 'move') moveOne(e.path);
      else if (id === 'download') downloadPath(row, e.path);
      else if (id === 'unzip') unzipOne(e.path, null);
      else if (id === 'delete') deleteFiles(row, view, [e.path], entries).then(again);
    };
    if (actions.length > 1) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'icon-btn fm-more';
      more.append(icon('dots'));
      more.setAttribute('aria-label', 'Actions for ' + e.name);
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.title = e.inUse ? 'Actions' : 'Rename, move, download, delete';
      more.onclick = () => rowMenu.open(more, actions, act);
      line.append(more);
      // F2 renames and Delete deletes the row that holds the focus, as a file manager does
      line.addEventListener('keydown', (ev) => {
        const key = rowKey(ev);
        if (!key) return;
        ev.preventDefault();
        // with this row among the ticked ones, Delete means all of them, as the bar's Delete does
        const ticked = [...view.selected];
        if (key === 'delete' && ticked.length > 1 && view.selected.has(e.path)) {
          const held = entries.find((x) => x.inUse && view.selected.has(x.path));
          if (held) { toast(heldWords(held), 'bad'); return; }
          deleteFiles(row, view, ticked, entries).then(again);
          return;
        }
        if (e.inUse) { toast(heldWords(e), 'bad'); return; }
        act(key);
      });
    }
  }
  if (!entries.length) {
    body.append(list);
    body.append(emptyState(view.query ? 'search' : 'folder', view.query
      ? 'Nothing here is named like that.'
      : 'This folder is empty. Drop files or folders here, or use Upload.'));
  } else {
    body.append(list);
  }

  const note = document.createElement('div');
  note.className = 'hint';
  note.textContent = 'Drop files or whole folders onto this list to upload them here. On a row, F2 renames and Delete deletes; Shift and a click ticks a run of rows.';
  body.append(note);

  // Files dragged in from the desktop land in the folder on screen.
  const pane = body.closest('.pane');
  pane.ondragover = (ev) => {
    if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
    // With a file open in the editor there is no list to drop onto, and these handlers belong to
    // the server whose list was drawn last, which may not be the one on screen now. Either way the
    // page-wide guard refuses the drop.
    if (state.current !== row.name || filesStateFor(row.name).editing) return;
    ev.preventDefault();
    pane.setAttribute('data-drop', '');
  };
  pane.ondragleave = (ev) => { if (!pane.contains(ev.relatedTarget)) pane.removeAttribute('data-drop'); };
  pane.ondrop = async (ev) => {
    pane.removeAttribute('data-drop');
    if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
    // before anything else: the browser's own answer to a dropped file is to open it over the panel
    ev.preventDefault();
    if (state.current !== row.name || filesStateFor(row.name).editing) return;
    // The entries must be taken before the first await: the browser empties the drop's item list
    // once the event handler has returned.
    const roots = [...ev.dataTransfer.items]
      .filter((it) => it.kind === 'file')
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null) || it.getAsFile());
    const fallback = [...ev.dataTransfer.files];
    const found = roots.some((r) => r) ? await collectDropped(roots) : fallback.map((f) => ({ file: f, name: f.name }));
    if (!found.length) {
      toast('Nothing to upload: the folder is empty.', 'bad');
      return;
    }
    await uploadFiles(row, view, found);
    again();
  };
}

/** Every file under what was dropped, each with its path inside the dropped folder. */
async function collectDropped(roots) {
  const out = [];
  const readAll = (reader) => new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(all);
      else { all.push(...batch); next(); }
    }, reject);
    next();
  });
  const walk = async (entry, prefix) => {
    if (!entry) return;
    if (entry instanceof File) { out.push({ file: entry, name: prefix + entry.name }); return; }
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, name: prefix + entry.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + '/');
    }
  };
  for (const r of roots) {
    try { await walk(r, ''); } catch (e) { toast('Could not read ' + (r && r.name ? r.name : 'a dropped item') + ': ' + e.message, 'bad'); }
  }
  return out;
}

function uploadUrl(base, dir, name, overwrite) {
  return base + '?dir=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(name) + (overwrite ? '&overwrite=1' : '');
}

/** The line in the upload notice: which file of how many, and how much of the whole has gone. */
function uploadWords(at, count, sentBytes, totalBytes, where) {
  const share = totalBytes > 0 ? Math.min(100, Math.floor((sentBytes / totalBytes) * 100)) : null;
  return 'Uploading ' + (count === 1 ? '' : at + ' of ' + count + ' ') + 'to ' + where
    + (share === null ? '\u2026' : ' \u00b7 ' + share + '%');
}

/**
 * One file sent with its progress reported, which fetch cannot do for a request body. Resolves
 * like the answer it replaces, { ok, status, out }; rejects when the panel did not answer or the
 * upload was called off. `hold` is handed the request so the caller can abort it.
 */
function sendFile(url, file, onProgress, hold) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      let out = {};
      try { out = JSON.parse(xhr.responseText) || {}; } catch { /* an answer with no body */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, out });
    };
    xhr.onerror = () => reject(new Error(plainFailure(0)));
    xhr.onabort = () => reject(new Error('Upload stopped.'));
    hold(xhr);
    xhr.send(file);
  });
}

/** `list` is [{ file, name }]: name is the path inside the upload folder, slashes for subfolders. */
async function uploadFiles(row, view, list) {
  list = list.map((it) => (it instanceof File ? { file: it, name: it.webkitRelativePath || it.name } : it));
  if (!list.length) return;
  const base = '/api/instances/' + encodeURIComponent(row.name) + '/files/upload';
  // Taken once: the upload belongs to the folder it was started in, and view.dir changes when
  // someone opens another folder while a large one is still going up.
  const dir = view.dir;
  const where = dir || 'the server folder';
  const top = new Set(list.map((it) => it.name.split('/')[0]));
  const label = list.length === 1 ? list[0].name : list.length + ' files';
  // One notice for the whole upload, there until it ends: how far along it is, and a way to stop
  // it. A world of two gigabytes used to show "Uploading…" for five seconds and then nothing.
  const note = toast('Uploading ' + label + ' to ' + where + '…');
  const noteText = note.querySelector('div');
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'sm';
  stop.textContent = 'Cancel';
  note.insertBefore(stop, note.querySelector('.x'));
  note.querySelector('.x').hidden = true;
  const total = list.reduce((n, it) => n + (it.file.size || 0), 0);
  let sent = 0;
  let at = 0;
  let cancelled = false;
  let current = null;
  stop.onclick = () => { cancelled = true; stop.disabled = true; if (current) current.abort(); };
  const paint = (loaded) => { noteText.textContent = uploadWords(at, list.length, sent + loaded, total, where); };
  const send = async (it, overwrite) => {
    paint(0);
    const res = await sendFile(uploadUrl(base, dir, it.name, overwrite), it.file, paint, (xhr) => { current = xhr; });
    current = null;
    return res;
  };
  let done = 0;
  const exists = [];
  for (const it of list) {
    if (cancelled) break;
    at++;
    try {
      const res = await send(it, false);
      if (!res.ok && res.out.code === 'exists') { exists.push(it); continue; }
      if (!res.ok) throw new Error(res.out.error ? plainMessage(res.out.error) : plainFailure(res.status));
      done++;
      sent += it.file.size || 0;
    } catch (e) {
      if (cancelled) break;
      toast(it.name + ': ' + e.message, 'bad');
    }
  }
  // One question for the lot, so a folder dropped over an older copy of itself is not a hundred prompts.
  if (exists.length && !cancelled) {
    const ok = await ask({
      title: exists.length === 1 ? 'Replace ' + exists[0].name + '?' : 'Replace ' + exists.length + ' files?',
      text: (exists.length === 1 ? exists[0].name + ' is' : exists.length + ' of the files are') + ' already in ' + where
        + '. What is there now is copied to Backups first.',
      confirmLabel: 'Replace',
      danger: true,
    });
    if (ok) {
      at -= exists.length;
      for (const it of exists) {
        if (cancelled) break;
        at++;
        try {
          const res = await send(it, true);
          if (!res.ok) throw new Error(res.out.error ? plainMessage(res.out.error) : plainFailure(res.status));
          done++;
          sent += it.file.size || 0;
        } catch (e) {
          if (cancelled) break;
          toast(it.name + ': ' + e.message, 'bad');
        }
      }
    }
  }
  note.remove();
  if (cancelled) {
    toast('Upload stopped. ' + (done ? (done === 1 ? '1 file is' : done + ' files are') + ' already in ' + where + '.' : 'Nothing was uploaded.'), done ? '' : 'good');
    return;
  }
  if (done) {
    const what = top.size === 1 && list.some((it) => it.name.includes('/')) ? [...top][0] + ' (' + (done === 1 ? '1 file' : done + ' files') + ')'
      : (done === 1 ? '1 file' : done + ' files');
    toast('Uploaded ' + what + ' to ' + where + '.', 'good');
  }
}

/**
 * What the Delete dialog in Files says for a selection.
 *
 * One file is named in the title. Several are named in the text, since "14 items" does not say
 * that the world and the server jar are among them. A selection that takes a world, the plugins,
 * the jar or server.properties from the top of the server's folder is the server itself going:
 * that one says which, and asks for the server's name, the way removing a server does.
 */
function deleteConfirm(serverName, paths, entries, levelName) {
  const nameOf = (p) => p.split('/').pop();
  const level = levelName || 'world';
  const byPath = new Map((entries || []).map((e) => [e.path, e]));
  // What the server is made of, at the top of its folder: its worlds, what it loads, its jar and
  // its settings. A folder of logs or crash reports is not, and is not asked about as if it were.
  const VITAL_FOLDERS = [level, level + '_nether', level + '_the_end', 'plugins', 'mods', 'config', 'libraries', 'versions'];
  const isVital = (p) => !p.includes('/') && ((byPath.get(p) || {}).type === 'dir'
    ? VITAL_FOLDERS.includes(p)
    : /\.jar$/i.test(p) || p === 'server.properties');
  const vital = paths.filter(isVital);
  const warn = vital.length ? 'The server cannot run as it is without ' + vital.map(nameOf).join(', ') + '. ' : '';
  if (paths.length === 1) {
    return { what: nameOf(paths[0]), text: warn + 'A copy is kept first, so Backups can put it back.', typeToConfirm: vital.length ? serverName : null };
  }
  const shown = paths.slice(0, 6).map(nameOf).join(', ');
  const rest = paths.length - 6;
  return {
    what: paths.length + ' items',
    text: 'This deletes ' + shown + (rest > 0 ? ' and ' + rest + ' more' : '') + '. ' + warn + 'A copy is kept first, so Backups can put them back.',
    typeToConfirm: vital.length ? serverName : null,
  };
}

async function deleteFiles(row, view, paths, entries) {
  const base = '/instances/' + encodeURIComponent(row.name) + '/files';
  const confirm = deleteConfirm(row.name, paths, entries, row.levelName);
  const what = confirm.what;
  const ok = await ask({
    title: 'Delete ' + what + '?',
    text: confirm.text,
    confirmLabel: 'Delete',
    danger: true,
    typeToConfirm: confirm.typeToConfirm || undefined,
  });
  if (!ok) return;
  try {
    await post(base + '/delete', { paths: paths });
    view.selected.clear();
    toast('Deleted ' + what + '. A copy is in Backups.', 'good');
  } catch (e) {
    if (e.code !== 'large') { toast(e.message, 'bad'); return; }
    const sure = await ask({
      title: 'Delete ' + what + ' without a copy?',
      text: 'That is ' + e.message.replace(/^that is /, '') + '. Deleted without one, there is no way back. '
        + 'Take a full backup first if there is any doubt.',
      typeToConfirm: paths.length === 1 ? paths[0].split('/').pop() : 'delete',
      confirmLabel: 'Delete for good',
      danger: true,
    });
    if (!sure) return;
    try {
      await post(base + '/delete', { paths: paths, withoutCopy: true });
      view.selected.clear();
      toast('Deleted ' + what + '.', 'good');
    } catch (e2) { toast(e2.message, 'bad'); }
  }
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
/** A packed text file, most often an old log: logs/2026-11-13-1.log.gz. Not a .tar.gz, which is an archive. */
const PACKED_RE = /\.gz$/i;
const isPackedText = (p) => PACKED_RE.test(p) && !/\.tar\.gz$/i.test(p);

/** The line above a file that is shown to read and not to edit: how much of it this is. */
function tailWords(tail) {
  if (tail.whole) return tail.packed ? 'Unpacked to read it here. Read only.' : 'Read only.';
  return 'The last ' + fileSize(tail.shown) + ' of ' + fileSize(tail.of) + (tail.packed ? ' once unpacked' : '')
    + '. Read only: download it for the whole file.';
}

/** Why a file is not opened here, when it is not: what it is, and that a download is the way. */
/** What a key pressed on a file's row asks for: F2 renames; Delete deletes, and on a Mac, where
 *  that key is rare, Cmd+Backspace does, as in Finder. */
function rowKey(ev) {
  if (ev.altKey || ev.ctrlKey || ev.shiftKey) return null;
  if (ev.key === 'F2' && !ev.metaKey) return 'rename';
  if (ev.key === 'Delete' && !ev.metaKey) return 'delete';
  if (ev.key === 'Backspace' && ev.metaKey) return 'delete';
  return null;
}

function notShownWords(reason, size, packed) {
  if (reason === 'large' && packed) return 'It unpacks to more than can be read here. Download it and unpack it to read it.';
  if (packed) return 'It could not be unpacked: it is cut short, or is not the packed text its name says. Download it to open it elsewhere.';
  if (reason === 'large') return 'It is ' + fileSize(size) + ', too big to open here. Download it to open it elsewhere.';
  return 'It is not text - a jar, a world file or an archive. Download it to open it elsewhere.';
}

async function openFile(row, view, p) {
  const base = '/instances/' + encodeURIComponent(row.name) + '/files';
  const show = (editing) => { view.editing = editing; renderFiles({ force: true }); };
  // a picture is looked at, not read: nothing is fetched here but the picture itself
  if (IMAGE_RE.test(p)) { show({ path: p, text: '', original: '', image: true }); return; }
  const packed = isPackedText(p);
  let out;
  try {
    // a packed log is never offered to the editor: what is on disk is not its text
    out = packed ? { text: null, reason: 'large' } : await api(base + '/read?path=' + encodeURIComponent(p));
    if (out.text == null && out.reason === 'large') {
      // too big to edit, but a log's last lines are the ones wanted: read its end
      const tail = await api(base + '/tail?path=' + encodeURIComponent(p));
      if (tail.text != null) {
        const text = tail.text.replace(/\r\n/g, '\n');
        show({ path: tail.path, text, original: text, tail: { whole: tail.whole, shown: tail.shown, of: tail.of, packed: tail.packed } });
        return;
      }
      out = tail;
    }
  } catch (e) { toast(e.message, 'bad'); return; }
  if (out.text == null) {
    const ok = await ask({
      title: p.split('/').pop() + ' cannot be opened here',
      text: notShownWords(out.reason, out.size, packed),
      confirmLabel: 'Download',
    });
    if (ok) downloadPath(row, p);
    return;
  }
  show({ path: out.path, text: out.text.replace(/\r\n/g, '\n'), original: out.text.replace(/\r\n/g, '\n'), version: out.version });
}

