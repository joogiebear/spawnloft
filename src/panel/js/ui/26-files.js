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
    menu = Kit.h('div', { class: 'sl-menu fixed z-60', role: 'menu', 'aria-label': button.getAttribute('aria-label') || 'Actions' });
    for (const item of items) {
      const b = Kit.h('button', {
        type: 'button', role: 'menuitem', class: 'sl-menu-item', tabindex: '-1',
        dataset: item.danger ? { tone: 'fault' } : null,
        'aria-disabled': item.disabled ? 'true' : null,
      }, Kit.h('span', { text: item.label }), item.hint ? Kit.h('small', { text: item.hint }) : null);
      b.disabled = Boolean(item.disabled);
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

/** The file SpawnLoft keeps in plugins/ (or mods/) to know what it installed and from where. */
const isPluginStore = (p) => /^(plugins|mods)\/\.mcctl-plugins\.json$/.test(p);

/** The order a listing is shown in: folders first, then by the column chosen. */
function sortEntries(entries, sort) {
  if (!sort || !sort.key) return entries;
  const dir = sort.dir === 'desc' ? -1 : 1;
  const value = (e) => (sort.key === 'size' ? (e.type === 'dir' ? -1 : e.size || 0)
    : sort.key === 'modified' ? new Date(e.modified).getTime() || 0
      : String(e.name || e.path).toLowerCase());
  return [...entries].sort((a, b) => {
    const fa = a.type === 'dir' ? 0 : 1;
    const fb = b.type === 'dir' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const va = value(a);
    const vb = value(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

/** The modifier key as this keyboard has it, for the words under the editor. */
const FILES_MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌘' : 'Ctrl+';

/*
  The Files page is drawn with Tailwind classes, read from this file (panel.css @source). The list
  stops at a width it reads at, so a file's name and its date are not a screen apart (U9).
*/
const FILES_PAGE = 'grid w-full min-w-0 max-w-[1240px] gap-3';
const FILES_CELL = 'border-b border-line-faint px-3 py-0 align-middle group-last/row:border-b-0';
/** A button drawn as its words only: the old stylesheet's border, fill and lift taken off. */
const FILES_BARE = 'min-h-0 rounded-sm border-0 bg-transparent px-0 shadow-none whitespace-normal hover:transform-none';
const FILES_HEAD = 'h-9 border-b border-line px-3 text-left align-middle type-label text-ink-3 whitespace-nowrap';

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
  // what the page was drawn for, so a start or a stop can redraw it (followRunState)
  body.dataset.running = running ? '1' : '';
  const entries = sortEntries(view.query ? data.results : data.entries, view.sort);
  for (const p of [...view.selected]) if (!entries.some((e) => e.path === p)) view.selected.delete(p);
  // the control that had the focus, found again on the redrawn page by what it is for
  const had = document.activeElement && body.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;

  rowMenu.close(false);
  body.textContent = '';
  paneHead(body, 'folder', 'Files',
    'Everything in this server’s folder. An edit, a replaced file or a delete keeps a copy first, which Backups or Activity can put back.');
  const page = Kit.h('div', { class: FILES_PAGE });
  body.append(page);
  const again = () => renderFiles({ force: true });
  const go = (dir) => { view.dir = dir; view.query = ''; view.selected.clear(); again(); };

  if (running) {
    page.append(Kit.h('p', {
      class: 'sl-hint',
      text: 'The server is running: files it holds open (the active world, its jar, the plugins it loaded) are marked In use and cannot be moved, replaced or deleted until it stops. '
        + 'They can still be read and edited; a changed config applies when the plugin reloads or the server restarts.',
    }));
  }

  // ---- where, and what to do here -----------------------------------------------
  const parts = view.dir ? view.dir.split('/') : [];
  const crumb = (label, dir, current) => {
    const b = Kit.h('button', {
      type: 'button',
      class: FILES_BARE + ' min-w-0 truncate px-1.5 py-1 font-mono text-3 leading-[1.4] hover:bg-hover hover:text-ink focus-visible:focus-ring ' + (current ? 'font-semibold text-ink' : 'font-normal text-ink-2'),
      text: label,
      onclick: () => go(dir),
    });
    if (current) b.setAttribute('aria-current', 'location');
    return b;
  };
  const crumbs = Kit.h('nav', { class: 'fm-crumbs flex min-w-0 flex-[1_1_260px] flex-wrap items-center gap-0.5', 'aria-label': 'Folder' });
  crumbs.append(crumb(row.label || row.name, '', !parts.length && !view.query));
  parts.forEach((p, i) => {
    // the slashes are drawn, not read: the crumbs are a list of places already
    crumbs.append(Kit.h('span', { class: 'text-ink-4', 'aria-hidden': 'true', text: '/' }), crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1 && !view.query));
  });

  const search = Kit.h('input', {
    class: 'sl-input fm-search', type: 'search', autocomplete: 'off', spellcheck: false,
    placeholder: view.dir ? 'Find in this folder' : 'Find a file',
  });
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

  // Upload is what this toolbar is for most; making things and the file manager are one press
  // further, in a menu, and each glyph means one thing.
  const upload = Kit.button({ label: 'Upload', icon: 'upload', kind: 'primary' });
  upload.title = 'Upload files into ' + (view.dir || 'the server folder');
  const picker = Kit.h('input', { type: 'file', multiple: true, hidden: true });
  const dirPicker = Kit.h('input', { type: 'file', hidden: true });
  dirPicker.webkitdirectory = true;
    const more = Kit.menu({
    label: 'New', icon: 'plus', kind: 'secondary',
    items: [
      { label: 'New file', note: 'An empty file, opened to write in.', onSelect: () => makeFile() },
      { label: 'New folder', onSelect: () => makeFolder() },
      'sep',
      { label: 'Upload a folder', note: 'A whole folder, with what is inside it.', onSelect: () => dirPicker.click() },
      { label: 'Open in ' + FILE_MANAGER, onSelect: () => revealHere() },
    ],
  });
  page.append(Kit.h('div', { class: 'fm-bar flex min-w-0 flex-wrap items-center gap-2' },
    crumbs,
    Kit.h('span', { class: 'sl-input-group min-w-36 flex-[0_1_240px]' }, Kit.h('span', { class: 'sl-input-lead', 'aria-hidden': 'true' }, Kit.icon('search')), search),
    more, upload, picker, dirPicker));

  const makeFile = async () => {
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
  const makeFolder = async () => {
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
  dirPicker.onchange = () => {
    // webkitRelativePath is "Folder/sub/file": the folder's own name is kept, as a drop keeps it.
    const picked = [...dirPicker.files].map((f) => ({ file: f, name: f.webkitRelativePath || f.name }));
    dirPicker.value = '';
    if (!picked.length) { toast('Nothing to upload: the folder is empty.', 'bad'); return; }
    uploadFiles(row, view, picked).then(again);
  };
  const revealHere = async () => {
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
    if (button) busy(button, true);
    const note = button ? null : toast('Unpacking ' + path.split('/').pop() + '…');
    try {
      const out = await post(base + '/extract', { path });
      note?.remove();
      toast('Unpacked into ' + out.path + '.', 'good');
      go(out.path);
    } catch (e) { note?.remove(); toast(e.message, 'bad'); if (button) busy(button, false); }
  };
  const heldWords = (e) => e.name + ' is in use by the running server, so it cannot be renamed, moved or deleted until the server stops.';

  // ---- what is selected -------------------------------------------------------
  // Always the same height, ticked or not, so the first tick does not push the list down under
  // the pointer that is about to tick the next row.
  const sel = [...view.selected];
  const selEntries = entries.filter((e) => view.selected.has(e.path));
  if (entries.length) {
    const acts = Kit.h('div', {
      class: 'fm-sel flex min-h-11 min-w-0 flex-wrap items-center gap-2 rounded-md border px-3 py-1 '
        + (sel.length ? 'border-accent-edge bg-accent-wash' : 'border-transparent'),
    });
    page.append(acts);
    if (!sel.length) {
      acts.append(Kit.h('span', { class: 'text-2 text-ink-3', text: 'Tick rows to act on several at once. On a row, F2 renames and Delete deletes; Shift and a click ticks a run of rows.' }));
    } else {
      const one = sel.length === 1;
      const dl = Kit.button({ label: 'Download', icon: 'download', size: 'sm' });
      const rename = Kit.button({ label: 'Rename', icon: 'pencil', size: 'sm' });
      const move = Kit.button({ label: 'Move', icon: 'folder', size: 'sm' });
      const zip = Kit.button({ label: 'Zip', icon: 'archive', size: 'sm' });
      const unzip = Kit.button({ label: 'Unzip', icon: 'folder', size: 'sm' });
      const del = Kit.button({ label: 'Delete', icon: 'trash', kind: 'danger', size: 'sm' });
      dl.hidden = rename.hidden = move.hidden = !one;
      unzip.hidden = !(one && selEntries[0] && selEntries[0].type === 'file' && ARCHIVE_RE.test(sel[0]));
      const clear = Kit.button({ label: 'Clear', kind: 'ghost', size: 'sm' });
      // said beside the buttons: a button that is off cannot take focus to show a tip
      const whyOff = Kit.h('span', { class: 'basis-full text-2 text-ink-3' });
      const held = selEntries.filter((e) => e.inUse);
      const folders = new Set(sel.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')));
      if (held.length) {
        del.disabled = rename.disabled = move.disabled = true;
        whyOff.textContent = heldWords(held[0]);
      } else if (folders.size > 1) {
        // a search ticks files from many folders; an archive is made of one folder's things
        zip.disabled = true;
        whyOff.textContent = 'Zip takes things from one folder at a time.';
      }
      whyOff.hidden = !whyOff.textContent;
      acts.append(Kit.h('b', { class: 'mr-1 text-2 font-semibold text-ink', text: sel.length + ' selected' }), dl, rename, move, zip, unzip, del, clear, whyOff);

      clear.onclick = () => { view.selected.clear(); again(); };
      dl.onclick = () => downloadPath(row, sel[0]);
      rename.onclick = () => renameOne(sel[0]);
      move.onclick = () => moveOne(sel[0]);
      zip.onclick = async () => {
        const first = sel[0].split('/').pop();
        const got = await ask({
          title: 'Zip ' + (one ? first : sel.length + ' items'),
          input: { label: 'Archive name', value: (one ? first.replace(/\.[^.]+$/, '') : 'archive') + '.zip', required: true },
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
  }

  // ---- the listing ------------------------------------------------------------
  if (view.query) {
    page.append(Kit.h('div', { class: 'flex min-w-0 flex-wrap items-center gap-2' },
      Kit.h('h3', { class: 'type-label m-0 text-ink-3', text: entries.length + (data.truncated ? '+' : '') + ' named like “' + view.query + '”' }),
      Kit.button({ label: 'Back to ' + (view.dir || row.label || row.name), kind: 'ghost', size: 'sm', onClick: () => { view.query = ''; view.selected.clear(); again(); } })));
  }
  if (!entries.length) {
    page.append(Kit.h('div', { class: 'sl-card' }, view.query
      ? Kit.empty({ icon: 'search', title: 'Nothing here is named like that', text: 'The search looks at names, in this folder and the ones inside it.' })
      : Kit.empty({
        icon: 'folder', title: 'This folder is empty', text: 'Drop files or whole folders here, or upload them.',
        actions: [Kit.button({ label: 'Upload', icon: 'upload', kind: 'primary', onClick: () => picker.click() }), view.dir ? Kit.button({ label: 'Up one folder', onClick: () => go(parts.slice(0, -1).join('/')) }) : null].filter(Boolean),
      })));
    bindDrop();
    return;
  }

  // A real table: a screen reader reads a row with its column names.
  const table = Kit.h('table', { class: 'fm-list w-full table-fixed border-collapse text-3' });
  table.append(Kit.h('caption', { class: 'sl-sr', text: 'Files in ' + (view.dir || 'the server folder') }));
  const all = Kit.h('input', { type: 'checkbox', class: 'sl-check m-0', 'aria-label': 'Select all' });
  all.checked = entries.every((e) => view.selected.has(e.path));
  all.indeterminate = !all.checked && entries.some((e) => view.selected.has(e.path));
  all.onchange = () => { if (all.checked) for (const e of entries) view.selected.add(e.path); else view.selected.clear(); again(); };
  // a column header sorts by itself; pressed again, the other way
  const sortHead = (key, label, extra) => {
    const on = view.sort && view.sort.key === key;
    const th = Kit.h('th', { scope: 'col', class: FILES_HEAD + ' ' + (extra || '') });
    if (on) th.setAttribute('aria-sort', view.sort.dir === 'desc' ? 'descending' : 'ascending');
    th.append(Kit.h('button', {
      type: 'button',
      class: FILES_BARE + ' inline-flex items-center gap-1 [font:inherit] uppercase tracking-[inherit] hover:bg-transparent hover:text-ink focus-visible:focus-ring ' + (on ? 'text-ink-2' : ''),
      onclick: () => { view.sort = { key, dir: on && view.sort.dir !== 'desc' ? 'desc' : 'asc' }; again(); },
    }, label, on ? Kit.h('span', { 'aria-hidden': 'true', text: view.sort.dir === 'desc' ? '↓' : '↑' }) : null));
    return th;
  };
  table.append(Kit.h('thead', null, Kit.h('tr', { class: 'fm-row fm-head' },
    Kit.h('th', { scope: 'col', class: FILES_HEAD + ' w-11 pl-3 pr-0' }, Kit.h('label', { class: 'grid size-8 cursor-pointer place-items-center' }, all)),
    sortHead('name', 'Name'),
    Kit.h('th', { scope: 'col', class: FILES_HEAD + ' hidden w-28 @min-[1100px]/pane:table-cell', text: 'Kind' }),
    sortHead('size', 'Size', 'w-24 text-right'),
    sortHead('modified', 'Modified', 'hidden w-40 text-right @min-[640px]/pane:table-cell @min-[1800px]/pane:w-56'),
    Kit.h('th', { scope: 'col', class: FILES_HEAD + ' w-12 px-0' }, Kit.h('span', { class: 'sl-sr', text: 'Actions' })))));
  const tbody = Kit.h('tbody');
  table.append(tbody);
  page.append(Kit.h('div', { class: 'fm-wrap min-w-0 overflow-hidden rounded-md border border-line bg-surface' }, table));

  const cell = (extra, ...kids) => Kit.h('td', { class: FILES_CELL + ' ' + (extra || '') }, ...kids);

  if (view.dir && !view.query) {
    const b = Kit.h('button', {
      type: 'button',
      class: FILES_BARE + ' fm-name fm-open flex min-w-0 items-center gap-2 py-2 font-normal leading-[1.4] hover:bg-transparent font-mono text-2 text-ink hover:text-accent-ink focus-visible:focus-ring',
      'aria-label': 'Up one folder',
      onclick: () => go(parts.slice(0, -1).join('/')),
      dataset: { focusKey: 'up' },
    }, Kit.icon('folder', 'text-ink-3'), '..');
    tbody.append(Kit.h('tr', { class: 'fm-row group/row hover:bg-hover' }, cell(), cell('', b), cell('hidden @min-[1100px]/pane:table-cell'), cell(), cell('hidden @min-[640px]/pane:table-cell'), cell()));
  }

  for (const e of entries) {
    const picked = view.selected.has(e.path);
    const line = Kit.h('tr', { class: 'fm-row group/row ' + (picked ? 'bg-accent-wash' : 'hover:bg-hover') });
    if (picked) line.dataset.selected = '';
    // The whole cell is the box's label, so the target is the row's height and not 16 pixels.
    const box = Kit.h('input', { type: 'checkbox', class: 'sl-check m-0', 'aria-label': 'Select ' + e.name, dataset: { focusKey: 'tick:' + e.path } });
    box.checked = picked;
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
    const opens = e.type === 'dir' || e.type === 'file';
    const open = Kit.h('button', {
      type: 'button',
      class: FILES_BARE + ' fm-name fm-open flex min-w-0 max-w-full items-center gap-2 py-2 font-normal leading-[1.4] hover:bg-transparent text-left font-mono text-2 focus-visible:focus-ring '
        + (opens ? 'text-ink hover:text-accent-ink' : 'cursor-default text-ink-3'),
      dataset: { focusKey: 'open:' + e.path },
    }, Kit.icon(e.type === 'dir' ? 'folder' : 'file', 'flex-none text-ink-3'), Kit.h('span', { class: 'truncate', text: view.query ? e.path : e.name }));
    // The row truncates a long name; the whole path is a pointer away.
    open.title = e.path;
    if (e.inUse) open.append(Kit.pill({ text: 'In use', tone: 'live' }));
    if (isPluginStore(e.path)) open.append(Kit.h('span', { class: 'flex-none font-ui text-1 text-ink-3', text: 'SpawnLoft’s list of what it installed' }));
    if (e.type === 'link') open.title = 'A link that leads outside the server folder';
    if (!opens) open.setAttribute('aria-disabled', 'true');
    // A folder's size would mean walking it on every listing; a dash says "not counted", where a
    // blank cell read as a missing value.
    const when = Kit.h('span', { class: 'whitespace-nowrap tabular-nums text-2 text-ink-3' },
      Kit.h('span', { class: '@min-[1800px]/pane:hidden', text: stamp(e.modified) }),
      Kit.h('span', { class: 'hidden @min-[1800px]/pane:inline', text: STAMP_YEAR.format(new Date(e.modified)) }));
    when.title = STAMP_YEAR.format(new Date(e.modified));
    line.append(
      cell('pl-3 pr-0', Kit.h('label', { class: 'grid size-8 cursor-pointer place-items-center' }, box)),
      cell('', open),
      cell('hidden truncate text-2 text-ink-3 @min-[1100px]/pane:table-cell', isPluginStore(e.path) ? 'SpawnLoft' : fileKind(e)),
      cell('fm-size text-right font-mono text-2 text-ink-2 whitespace-nowrap', e.type === 'dir' ? '—' : fileSize(e.size)),
      cell('hidden text-right @min-[640px]/pane:table-cell', when));
    tbody.append(line);

    const openIt = () => {
      if (e.type === 'dir') go(e.path);
      else if (e.type === 'file') openFile(row, view, e.path);
      // said, rather than a button that does nothing
      else toast(e.type === 'link' ? e.name + ' is a link to somewhere outside the server folder, so it is not opened here.' : e.name + ' is not a file or a folder, so there is nothing to open.');
    };
    open.onclick = openIt;
    const actions = fileRowActions(e);
    if (isPluginStore(e.path)) {
      // deleting it forgets where every plugin came from: each one becomes "added by hand"
      for (const a of actions) if (a.id === 'delete' && !a.disabled) a.hint = 'SpawnLoft would no longer know where its plugins came from.';
    }
    const act = (id) => {
      if (id === 'open') openIt();
      else if (id === 'rename') renameOne(e.path);
      else if (id === 'move') moveOne(e.path);
      else if (id === 'download') downloadPath(row, e.path);
      else if (id === 'unzip') unzipOne(e.path, null);
      else if (id === 'delete') deleteFiles(row, view, [e.path], entries).then(again);
    };
    const last = cell('pr-1.5 text-right');
    line.append(last);
    if (actions.length > 1) {
      const more = Kit.button({ icon: 'dots', kind: 'ghost', size: 'sm', title: e.inUse ? 'Actions' : 'Rename, move, download, delete' });
      more.classList.add('fm-more', 'opacity-60', 'group-hover/row:opacity-100', 'group-focus-within/row:opacity-100', 'aria-expanded:opacity-100');
      more.setAttribute('aria-label', 'Actions for ' + e.name);
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-expanded', 'false');
      more.dataset.focusKey = 'more:' + e.path;
      more.onclick = () => rowMenu.open(more, actions, act);
      last.append(more);
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

  page.append(Kit.h('p', { class: 'sl-hint', text: 'Drop files or whole folders onto this list to upload them here.' }));
  bindDrop();
  // focus back where it was before the redraw: a tick or an open does not drop it to the page
  if (had) body.querySelector('[data-focus-key="' + CSS.escape(had) + '"]')?.focus({ preventScroll: true });

  /** Files dragged in from the desktop land in the folder on screen. */
  function bindDrop() {
    const pane = body.closest('.pane');
    pane.ondragover = (ev) => {
      if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes('Files')) return;
      // With a file open in the editor there is no list to drop onto, and these handlers belong to
      // the server whose list was drawn last, which may not be the one on screen now. Either way the
      // page-wide guard refuses the drop.
      if (state.current !== row.name || filesStateFor(row.name).editing) return;
      ev.preventDefault();
      pane.setAttribute('data-drop', '');
      page.classList.add('outline-2', 'outline-dashed', 'outline-offset-4', 'outline-accent-edge', 'rounded-md');
    };
    const undrop = () => {
      pane.removeAttribute('data-drop');
      page.classList.remove('outline-2', 'outline-dashed', 'outline-offset-4', 'outline-accent-edge', 'rounded-md');
    };
    pane.ondragleave = (ev) => { if (!pane.contains(ev.relatedTarget)) undrop(); };
    pane.ondrop = async (ev) => {
      undrop();
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
}

/**
 * A tool page drawn while the server was running, or stopped, says the other once the state moves
 * on: "In use" marks and "takes effect the next time it starts" were left as they were (X1). The
 * one on screen is drawn again, unless someone is in the middle of something on it; one that is
 * not is drawn when it is next opened.
 */
function followRunState(row) {
  if (!row || row.name !== state.current) return;
  const up = row.status === 'running' || row.status === 'stopping' ? '1' : '';
  for (const [tool, id, render] of [['plugins', '#pluginsBody', renderPlugins], ['files', '#filesBody', renderFiles]]) {
    const body = $(id);
    if (body.dataset.for !== row.name || !('running' in body.dataset) || body.dataset.running === up) continue;
    body.dataset.running = up;
    const busyHere = body.querySelector('[data-holding], [aria-busy="true"]') || (tool === 'files' && filesStateFor(row.name).editing);
    if (toolView.tool === tool && !busyHere) render({ force: true });
    else if (toolView.tool !== tool) body.dataset.for = '';
  }
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
  // Said once at the end: a full disk under a folder of 300 files is one message, not 300.
  const failed = [];
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
      failed.push({ name: it.name, why: e.message });
    }
  }
  // One question for the lot, so a folder dropped over an older copy of itself is not a hundred prompts.
  if (exists.length && !cancelled) {
    const ok = await ask({
      title: exists.length === 1 ? 'Replace ' + exists[0].name + '?' : 'Replace ' + exists.length + ' files?',
      text: (exists.length === 1 ? exists[0].name + ' is already in ' + where
        : exists.slice(0, 5).map((it) => it.name).join(', ') + (exists.length > 5 ? ' and ' + (exists.length - 5) + ' more' : '') + ' are already in ' + where)
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
          failed.push({ name: it.name, why: e.message });
        }
      }
    }
  }
  note.remove();
  if (failed.length === 1) toast(failed[0].name + ': ' + failed[0].why, 'bad');
  else if (failed.length) {
    const why = [...new Set(failed.map((f) => f.why))];
    toast(failed.length + ' of ' + list.length + ' files were not uploaded, among them ' + failed.slice(0, 3).map((f) => f.name).join(', ')
      + '. ' + (why.length === 1 ? why[0] : 'The first reason: ' + why[0]), 'bad');
  }
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
  // A copy of a big folder takes a while: something on screen says what is happening meanwhile.
  const note = toast('Keeping a copy of ' + what + ', then deleting\u2026');
  try {
    const out = await post(base + '/delete', { paths: paths });
    note.remove();
    view.selected.clear();
    const done = toast('Deleted ' + what + '. A copy is in Backups.', 'good');
    // The quickest way back, and one that works while the server runs, which Restore does not.
    if (out && out.snapshot) {
      toastAction(done, 'Undo', async () => {
        done.remove();
        try {
          await post('/instances/' + encodeURIComponent(row.name) + '/activity/undo', { snapshot: out.snapshot });
          toast('Put back ' + what + '.', 'good');
          if ($('#filesBody').dataset.for === row.name && !filesStateFor(row.name).editing) renderFiles({ force: true });
        } catch (e) { toast(e.message, 'bad'); }
      });
    }
  } catch (e) {
    note.remove();
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

