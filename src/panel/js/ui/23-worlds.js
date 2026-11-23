'use strict';
// ----------------------------------------------------------------- worlds ---

/** A world's extra dimension as a person says it: "Nether", "The End". */
function dimensionWord(dim) {
  const d = String(dim).replace(/^_/, '');
  if (d === 'nether') return 'Nether';
  if (d === 'the_end') return 'The End';
  return capital(d.replace(/_/g, ' '));
}

/** "Nether and The End", for a sentence. */
function dimensionsWords(dims) {
  const words = (dims || []).map(dimensionWord);
  return words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words.join('');
}

/**
 * A world's name as the core takes it, checked as it is typed: the rule is the one the core
 * applies, said under the field rather than in a refusal that calls the world an "instance".
 */
function worldNameProblem(name) {
  const text = String(name).trim();
  if (!text) return 'Give it a name.';
  if (text.length > 32) return 'Up to 32 characters.';
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return 'Letters, numbers, - and _ only: no spaces.';
  return null;
}

/**
 * A path as pasted: Windows' "Copy as path" puts quotes around it. A relative path would be read
 * from wherever SpawnLoft runs, which is never what was meant.
 */
function importSource(raw) {
  let text = String(raw).trim();
  if (/^(["']).*\1$/.test(text)) text = text.slice(1, -1).trim();
  if (!text) return { problem: 'Paste the path to a zip, a tar.gz or a folder, or choose one.' };
  if (!/^(\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(text)) return { problem: 'Paste the full path, from the drive or / onwards.' };
  return { path: text };
}

/** A world name guessed from what was chosen: its file name, made into a name the core takes. */
function worldNameFrom(picked) {
  const last = String(picked).split(/[\\/]/).filter(Boolean).pop() || '';
  return last.replace(/\.(zip|tar\.gz|tgz)$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

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
    'Every world this server holds. Choose which one runs, export one to share, or import a downloaded map.');

  const base = '/instances/' + encodeURIComponent(row.name) + '/worlds';
  const again = () => renderWorlds({ force: true });
  const { h } = Kit;
  const page = h('div', { class: 'flex flex-col gap-6' });
  body.append(page);

  // What needs the server stopped, said once, before any button that is off because of it.
  if (data.running) {
    page.append(Kit.banner({
      icon: 'map',
      title: 'The server is running',
      text: 'Importing works now. Switching worlds, deleting one, and exporting the one in use need it stopped.',
    }));
  }

  // ---- the worlds ------------------------------------------------------------
  // The list comes first: on a server with one world, the import form above it filled the screen
  // before the world itself was seen.
  const listHead = h('div', { class: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
    h('h2', { class: 'm-0 type-section text-ink', text: 'Worlds' }),
    h('span', { class: 'type-meta text-ink-3', text: data.worlds.length ? String(data.worlds.length) : '' }),
    // said here because this is where a second world arrives
    h('span', { class: 'type-meta text-ink-3 basis-full', text: 'Backups cover every world listed here, not only the one in use.' }));
  page.append(h('section', { class: 'flex flex-col gap-3', 'aria-label': 'Worlds' }, listHead,
    data.worlds.length
      ? Kit.list(data.worlds.map(worldRow), 'Worlds')
      : Kit.empty({ icon: 'map', title: 'No worlds yet', text: 'The server makes one the first time it starts. Or import a downloaded map below.' })));

  function worldRow(w) {
    const mark = h('span', { class: 'sl-tile', 'aria-hidden': 'true', dataset: { tone: 'plain' } }, Kit.icon('map'));
    const title = h('span', { class: 'flex flex-wrap items-center gap-2' },
      h('span', { class: 'sl-row-title', text: w.name }),
      w.active ? Kit.pill({ text: 'In use', tone: 'live' }) : null,
      ...w.dimensions.map((d) => h('span', { class: 'sl-pill', text: dimensionWord(d) })));
    const meta = h('span', { class: 'sl-row-meta whitespace-normal' },
      w.sizeHuman + (w.active ? ' · The world the server loads. Make another one active to delete this one.' : ''));

    const buttons = [];
    let use = null;
    let drop = null;
    if (!w.active) {
      use = Kit.button({ label: 'Use this world', size: 'sm' });
      use.disabled = data.running;
      if (data.running) use.title = 'Stop the server first';
      use.setAttribute('aria-label', 'Use ' + w.name);
      buttons.push(use);
    }
    const exp = Kit.button({ label: 'Export', icon: 'download', size: 'sm' });
    exp.setAttribute('aria-label', 'Export ' + w.name);
    exp.disabled = w.active && data.running;
    if (exp.disabled) exp.title = 'The running server is saving into this world. Stop it first, or take a backup.';
    buttons.push(exp);
    if (!w.active) {
      drop = Kit.button({ icon: 'trash', kind: 'ghost', size: 'sm', title: 'Delete ' + w.name });
      drop.disabled = data.running;
      if (data.running) drop.title = 'Stop the server first';
      buttons.push(drop);
    }
    const el = h('div', { class: 'sl-row', dataset: { world: w.name } },
      mark, h('span', { class: 'sl-row-main' }, title, meta), h('span', { class: 'sl-row-end' }, buttons));

    // Kit.busy remembers what each button was before, so one that was off because the server runs
    // stays off when the request fails.
    const busy = (on, which) => { for (const b of buttons) Kit.busy(b, on); if (!on && which) which.focus(); };

    if (use) use.onclick = async () => {
      busy(true);
      try {
        await post(base + '/activate', { name: w.name });
        toast(w.name + ' is now the world in use. It loads the next time the server starts.', 'good');
        await refresh();
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false, use);
      }
    };

    exp.onclick = async () => {
      busy(true);
      try {
        const out = await post(base + '/export', { name: w.name });
        toast('Exported ' + w.name + ' to ' + out.file + ' (' + out.sizeHuman + ').', 'good', { stay: true });
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false, exp);
      }
    };

    if (drop) drop.onclick = async () => {
      const ok = await ask({
        title: 'Delete the world “' + w.name + '”?',
        text: (w.dimensions.length ? 'Its ' + dimensionsWords(w.dimensions) + ' go with it. ' : '')
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
            title: 'Delete “' + w.name + '” without a copy?',
            text: e.message + '. Deleted without one, the only way back is a backup that already holds it. Export it first if there is any doubt.',
            confirmLabel: 'Delete for good',
            danger: true,
            typeToConfirm: w.name,
          });
          if (!sure) { busy(false, drop); return; }
          out = await post(base + '/delete', { name: w.name, withoutCopy: true });
        }
        toast('Deleted ' + w.name + (w.dimensions.length ? ', with its ' + dimensionsWords(w.dimensions) : '') + '.'
          + (out.snapshot ? ' A copy is in Backups.' : ''), 'good');
        await again();
      } catch (e) {
        toast(e.message, 'bad');
        busy(false, drop);
      }
    };
    return el;
  }

  // ---- import ----------------------------------------------------------------
  const src = Kit.input({ mono: true, placeholder: examplePath(panelPlatform, 'map') });
  const pickers = [];
  if (desktop && desktop.pickFile) {
    const zip = Kit.button({ label: 'Choose a zip…', size: 'sm' });
    zip.onclick = async () => chosen(await desktop.pickFile('Choose a world archive (a zip or a tar.gz)'));
    pickers.push(zip);
  }
  if (desktop && desktop.pickFolder) {
    const folder = Kit.button({ label: 'Choose a folder…', size: 'sm' });
    folder.onclick = async () => chosen(await desktop.pickFolder('Choose a world folder (a singleplayer save works)'));
    pickers.push(folder);
  }
  const srcField = Kit.field({
    label: 'Where it is',
    control: pickers.length ? h('div', { class: 'flex flex-wrap items-center gap-2' }, h('span', { class: 'flex-1 basis-64 min-w-0' }, src), pickers) : src,
    hint: 'A zip, a tar.gz or a folder. The world inside is found wherever it is nested.',
  });
  const wname = Kit.input({ placeholder: 'season-2-map' });
  const nameField = Kit.field({ label: 'Name', control: wname, hint: 'Letters, numbers, - and _ only, up to 32.' });
  const makeActive = Kit.checkbox({
    label: 'Make it the world in use',
    note: data.running ? 'Stop the server first to switch worlds.' : 'It loads the next time the server starts.',
    disabled: data.running,
  });
  const go = Kit.button({ label: 'Import', icon: 'plus', kind: 'primary' });
  const importCard = Kit.card({ label: 'Import a world' },
    h('div', null,
      h('h2', { class: 'm-0 type-card text-ink', text: 'Import a world' }),
      h('p', { class: 'sl-hint mt-1', text: 'Never overwrites: it arrives as a new world here, and nothing changes until you make it the one in use.' })),
    srcField,
    h('div', { class: 'max-w-80' }, nameField),
    makeActive,
    h('div', null, go));
  page.append(importCard);

  function chosen(picked) {
    if (!picked) return;
    src.value = picked;
    srcField.setError(null);
    if (!wname.value.trim()) { wname.value = worldNameFrom(picked); nameField.setError(null); }
  }
  src.addEventListener('input', () => srcField.setError(null));
  wname.addEventListener('input', () => nameField.setError(wname.value.trim() ? worldNameProblem(wname.value) : null));

  go.onclick = async () => {
    const source = importSource(src.value);
    const nameProblem = worldNameProblem(wname.value);
    srcField.setError(source.problem || null);
    nameField.setError(nameProblem);
    if (source.problem) { src.focus(); return; }
    if (nameProblem) { wname.focus(); return; }
    const name = wname.value.trim();
    const activate = makeActive.querySelector('input').checked;
    Kit.busy(go, true);
    go.dataset.holding = '1'; // not redrawn mid-import: a fresh page would offer Import again
    try {
      const out = await post(base + '/import', { source: source.path, name });
      if (activate) await post(base + '/activate', { name: out.name });
      toast('Imported ' + out.name + ' (' + out.sizeHuman
        + (out.dimensions.length ? ', with ' + dimensionsWords(out.dimensions) : '') + ')'
        + (activate ? '. It loads the next time the server starts.' : '.'), 'good');
      src.value = '';
      wname.value = '';
      if (activate) await refresh();
      await again();
      // the new world, where the list put it
      const added = $('#worldsBody [data-world="' + CSS.escape(out.name) + '"] button');
      if (added) added.focus();
    } catch (e) {
      // a refusal about the name is said at the name, anything else at the path
      if (/name/i.test(e.message) && !/nothing at|level\.dat/i.test(e.message)) nameField.setError(e.message);
      else srcField.setError(e.message);
      Kit.busy(go, false);
      delete go.dataset.holding;
    }
  };
}
