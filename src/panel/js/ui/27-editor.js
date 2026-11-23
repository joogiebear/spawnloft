'use strict';
// ------------------------------------------------------------ the editor ---

/**
 * A plain textarea over a highlighted copy of the same text.
 *
 * <p>No editor library: the panel is one file that works offline, and what configs need is modest -
 * keys picked out from values, comments dimmed, line numbers, spaces for Tab because YAML refuses
 * tabs. The textarea does the editing, so selection, undo, find and the clipboard are the
 * browser's own; the <pre> behind it only paints. Past a size the painting is skipped and it is a
 * plain textarea, since re-highlighting a large file on every keystroke is what makes typing lag.
 */
const HIGHLIGHT_MAX = 300 * 1024;

function langOf(p) {
  const ext = (p.match(/\.([a-z0-9]+)$/i) || [])[1];
  const e = ext ? ext.toLowerCase() : '';
  if (e === 'yml' || e === 'yaml') return 'yaml';
  if (e === 'json' || e === 'json5' || e === 'mcmeta') return 'json';
  if (['properties', 'toml', 'cfg', 'ini', 'conf', 'hocon', 'env'].includes(e)) return 'props';
  return 'plain';
}

const LANG_NAMES = { yaml: 'YAML', json: 'JSON', props: 'Key = value', plain: 'Plain text' };

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The colour of each kind of word, as Tailwind classes (read from this file: panel.css @source). */
const HL_CLASS = { key: 'text-accent-ink', str: 'text-live-ink', num: 'text-warn-ink', bool: 'text-warn-ink', com: 'text-ink-4 italic' };

const tok = (cls, s) => s ? '<span class="' + HL_CLASS[cls] + '">' + escHtml(s) + '</span>' : '';

function hlValue(v) {
  // The comment first: a " #" outside quotes ends the value.
  let body = v;
  let comment = '';
  const quoted = /^\s*(["']).*\1/.exec(v);
  const hash = quoted ? v.indexOf(' #', quoted[0].length) : v.search(/(^|\s)#/);
  if (hash >= 0) { body = v.slice(0, hash); comment = v.slice(hash); }
  const t = body.trim();
  const lead = body.slice(0, body.indexOf(t.charAt(0)) < 0 ? body.length : body.indexOf(t.charAt(0)));
  const tail = body.slice(lead.length + t.length);
  let painted;
  if (!t) painted = '';
  else if (/^(["']).*\1$/.test(t)) painted = tok('str', t);
  else if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) painted = tok('num', t);
  else if (/^(true|false|yes|no|on|off|null|~)$/i.test(t)) painted = tok('bool', t);
  else painted = escHtml(t);
  return escHtml(lead) + painted + escHtml(tail) + tok('com', comment);
}

function highlightLine(line, lang) {
  if (lang === 'yaml') {
    if (/^\s*#/.test(line)) return tok('com', line);
    const m = /^(\s*(?:-\s+)?)((?:"[^"]*"|'[^']*'|[^\s#'"-][^:#]*?|-[^\s:#][^:#]*?))(\s*:)(?=\s|$)(.*)$/.exec(line);
    if (m) return escHtml(m[1]) + tok('key', m[2]) + escHtml(m[3]) + hlValue(m[4]);
    const item = /^(\s*-\s?)(.*)$/.exec(line);
    if (item) return escHtml(item[1]) + hlValue(item[2]);
    return hlValue(line);
  }
  if (lang === 'props') {
    if (/^\s*[#!;]/.test(line)) return tok('com', line);
    if (/^\s*\[.*\]\s*$/.test(line)) return tok('key', line);
    const m = /^(\s*)([^=:#!\s][^=:]*?)(\s*[=:])(.*)$/.exec(line);
    if (m) return escHtml(m[1]) + tok('key', m[2]) + escHtml(m[3]) + hlValue(m[4]);
    return escHtml(line);
  }
  if (lang === 'json') {
    let out = '';
    let at = 0;
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(\/\/.*$)/g;
    let m;
    while ((m = re.exec(line))) {
      out += escHtml(line.slice(at, m.index));
      if (m[1]) out += tok(m[2] ? 'key' : 'str', m[1]) + escHtml(m[2] || '');
      else if (m[3]) out += tok('num', m[3]);
      else if (m[4]) out += tok('bool', m[4]);
      else out += tok('com', m[5]);
      at = re.lastIndex;
    }
    return out + escHtml(line.slice(at));
  }
  return escHtml(line);
}

/** Find stops counting here; a file with more matches than this says "2000+". */
const FIND_CAP = 2000;

/** Where `needle` occurs in `text`, ignoring case, as start offsets, up to `cap` of them. */
function findAll(text, needle, cap) {
  const starts = [];
  if (!needle) return { starts, len: 0, capped: false };
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  let m;
  let capped = false;
  while ((m = re.exec(text))) {
    if (starts.length >= cap) { capped = true; break; }
    starts.push(m.index);
  }
  return { starts, len: needle.length, capped };
}

/** The text as HTML with every match in a <mark>, and the one Find stands on marked "now". */
function markMatches(text, starts, len, current) {
  let out = '';
  let from = 0;
  starts.forEach((s, i) => {
    out += escHtml(text.slice(from, s)) + '<mark' + (i === current ? ' class="now"' : '') + '>' + escHtml(text.slice(s, s + len)) + '</mark>';
    from = s + len;
  });
  return out + escHtml(text.slice(from));
}

/** Beside the Find box: which match this is, of how many. */
function findWords(needle, at, total, capped) {
  if (!needle) return '';
  if (!total) return 'No matches';
  return (at + 1) + ' of ' + total + (capped ? '+' : '');
}

const FILES_WRAP_KEY = 'spawnloft.files.wrap';
/** Whether the editor folds long lines. Remembered, where the browser allows. */
let filesWrap = false;
try { filesWrap = localStorage.getItem(FILES_WRAP_KEY) === '1'; } catch { /* stays off */ }

/*
  The editor's layers: a transparent textarea over a <pre> painted with the same text, and a third
  <pre> under both where Find marks its matches. All three must lay text out identically, so they
  share every font, padding and wrapping rule; wrapping and plain text are data attributes on the
  box that holds them.
*/
const ED_LAYER = 'absolute inset-0 m-0 rounded-none border-0 px-4 py-3 [font:inherit] [letter-spacing:0] [tab-size:2] whitespace-pre [overflow-wrap:normal] break-normal group-data-wrap/code:whitespace-pre-wrap group-data-wrap/code:[overflow-wrap:anywhere]';
// the match Find stands on is the one mark with a class (markMatches: class="now")
const ED_MARKS = 'text-transparent [&_mark]:rounded-[2px] [&_mark]:bg-[rgba(var(--accent-rgb),.28)] [&_mark]:text-transparent [&_mark[class]]:bg-[rgba(var(--accent-rgb),.6)] [&_mark[class]]:outline [&_mark[class]]:outline-1 [&_mark[class]]:outline-accent';
/** A small button in the editor's bars. */
const edButton = (label, kind, title) => {
  const b = Kit.button({ label, kind: kind || 'ghost', size: 'sm' });
  // a switch (Wrap lines) shows that it is on
  b.classList.add('aria-pressed:bg-accent-wash', 'aria-pressed:text-accent-ink');
  if (title) b.title = title;
  return b;
};

/** The row over a file: back to the list, the file's state, and what can be done with it. */
function editorBar(...end) {
  const back = Kit.button({ label: 'All files', icon: 'folder', kind: 'ghost', size: 'sm' });
  const bar = Kit.h('div', { class: 'fm-bar flex min-w-0 flex-wrap items-center gap-2' }, back, Kit.h('span', { class: 'flex-1' }), ...end);
  return { bar, back };
}

/** A picture, shown as it is: server-icon.png is the usual one. */
function renderFileImage(row, view) {
  const body = $('#filesBody');
  const ed = view.editing;
  const name = ed.path.split('/').pop();
  body.textContent = '';
  paneHead(body, 'file', name, ed.path);
  const dl = Kit.button({ label: 'Download', icon: 'download', size: 'sm' });
  const { bar, back } = editorBar(dl);
  const frame = Kit.h('div', { class: 'grid min-h-60 place-items-center overflow-auto rounded-sm border border-line bg-sunken p-5' });
  const img = Kit.h('img', { alt: name, class: 'h-auto max-w-full shadow-[0_0_0_1px_var(--line)] [image-rendering:pixelated]' });
  const said = Kit.h('p', { class: 'sl-hint', role: 'status' });
  img.onload = () => { said.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight + ' pixels'; };
  img.onerror = () => {
    frame.replaceChildren(Kit.empty({ icon: 'file', title: name + ' could not be shown', text: 'It is not a picture a browser can draw, or it is too big. Download it to look at it.' }));
  };
  img.src = '/api/instances/' + encodeURIComponent(row.name) + '/files/image?path=' + encodeURIComponent(ed.path);
  frame.append(img);
  body.append(Kit.h('div', { class: 'grid w-full min-w-0 max-w-[1240px] gap-3' }, bar, frame, said));
  back.onclick = () => { view.editing = null; renderFiles({ force: true }); };
  dl.onclick = () => downloadPath(row, ed.path);
  requestAnimationFrame(() => back.focus({ preventScroll: true }));
}

function renderFileEditor(row, view) {
  const body = $('#filesBody');
  const ed = view.editing;
  rowMenu.close(false);
  if (ed.image) return renderFileImage(row, view);
  const base = '/instances/' + encodeURIComponent(row.name) + '/files';
  // the end of a file too big to edit: read, searched and wrapped like any other, never saved
  const readOnly = Boolean(ed.tail);
  const lang = readOnly ? 'plain' : langOf(ed.path);
  const painted = lang !== 'plain' && ed.text.length <= HIGHLIGHT_MAX;
  body.textContent = '';
  paneHead(body, 'file', ed.path.split('/').pop(), ed.path);
  // the page holds the editor's parts at the width the file list has
  const page = Kit.h('div', { class: 'grid w-full min-w-0 max-w-[1240px] gap-2' });
  body.append(page);

  const dot = Kit.h('span', { class: 'flex items-center gap-1.5 text-2 text-ink-3' }, Kit.dot({ tone: 'accent' }), 'Not saved');
  const reload = edButton('Reload', 'ghost', 'Read the file again from disk');
  const dl = Kit.button({ label: 'Download', icon: 'download', kind: 'ghost', size: 'sm' });
  const save = Kit.button({ label: 'Save', kind: 'primary', size: 'sm' });
  const { bar, back } = editorBar(dot, reload, dl, save);
  save.hidden = readOnly;
  page.append(bar);
  if (readOnly) page.append(Kit.h('p', { class: 'sl-hint', text: tailWords(ed.tail) }));

  // ---- find, and wrap -----------------------------------------------------------
  const q = Kit.h('input', { class: 'sl-input', type: 'search', placeholder: 'Find in this file', autocomplete: 'off', spellcheck: false });
  q.setAttribute('aria-label', 'Find in this file');
  q.dataset.kept = '1';
  const found = Kit.h('span', { class: 'min-w-[6em] text-2 text-ink-3', role: 'status' });
  const prev = edButton('Previous');
  const next = edButton('Next');
  const wrapBtn = edButton('Wrap lines', 'ghost', 'Fold long lines at the edge, so nothing runs off to the right');
  const findRow = Kit.h('div', { class: 'fm-find flex min-w-0 flex-wrap items-center gap-2', role: 'search' },
    Kit.h('span', { class: 'sl-input-group min-w-36 flex-[0_1_260px]' }, Kit.h('span', { class: 'sl-input-lead', 'aria-hidden': 'true' }, Kit.icon('search')), q),
    prev, next, found, Kit.h('span', { class: 'flex-1' }), wrapBtn);
  page.append(findRow);

  const gutter = Kit.h('div', {
    class: 'fm-gutter min-w-[3.5em] overflow-hidden border-r border-line-soft py-3 pr-2 pl-3 text-right whitespace-pre text-ink-4 select-none group-data-nogutter/ed:hidden',
    'aria-hidden': 'true',
  });
  const code = Kit.h('div', { class: 'fm-code group/code relative min-w-0' });
  if (!painted) code.dataset.plain = '';
  const pre = Kit.h('pre', { class: ED_LAYER + ' pointer-events-none overflow-hidden text-ink group-data-plain/code:hidden', 'aria-hidden': 'true' });
  const marks = Kit.h('pre', { class: 'fm-marks pointer-events-none overflow-hidden ' + ED_LAYER + ' ' + ED_MARKS, 'aria-hidden': 'true' });
  const ta = Kit.h('textarea', {
    class: ED_LAYER + ' h-full min-h-0 w-full resize-none overflow-auto bg-transparent p-0 px-4 py-3 text-transparent caret-ink shadow-none outline-none selection:bg-[rgba(var(--accent-rgb),.3)] selection:text-transparent focus:bg-transparent focus:shadow-none focus:outline-none group-data-plain/code:text-ink group-data-plain/code:selection:text-ink group-data-wrap/code:overflow-x-hidden group-data-wrap/code:overflow-y-scroll',
  });
  ta.spellcheck = false;
  ta.wrap = 'off';
  ta.readOnly = readOnly;
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', ed.path + (readOnly ? ', read only' : ''));
  ta.value = ed.text;
  // matches first, so they are painted under the text
  code.append(marks, pre, ta);
  const box = Kit.h('div', {
    class: 'fm-editor group/ed grid h-[360px] grid-cols-[auto_minmax(0,1fr)] overflow-hidden rounded-sm border border-line bg-sunken [font:var(--t-3)/1.6_var(--mono)] shadow-[inset_0_1px_2px_rgba(0,0,0,.35)] focus-within:border-accent-edge focus-within:outline-[length:var(--ring-width)] focus-within:-outline-offset-1 focus-within:outline-[var(--ring-color)] focus-within:outline-solid data-nogutter:grid-cols-[minmax(0,1fr)]',
  }, gutter, code);
  page.append(box);

  const where = Kit.h('span');
  const how = Kit.h('span', {
    text: readOnly
      ? 'Read only  \u00b7  ' + FILES_MOD + 'F finds'
      : LANG_NAMES[lang] + '  \u00b7  ' + FILES_MOD + 'S saves  \u00b7  ' + FILES_MOD + 'F finds  \u00b7  Tab indents with spaces; Esc, then Tab, moves on',
  });
  const foot = Kit.h('div', { class: 'fm-foot flex flex-wrap justify-between gap-x-4 gap-y-2 text-2 text-ink-3' }, where, how);
  page.append(foot);

  let lines = -1;
  const paint = () => {
    const n = ta.value.split('\n').length;
    if (n !== lines) {
      lines = n;
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      gutter.textContent = s + ' ';
    }
    // A trailing space keeps the last empty line's height, so the two layers scroll the same.
    if (painted) pre.innerHTML = ta.value.split('\n').map((l) => highlightLine(l, lang)).join('\n') + '\n ';
    const dirty = ta.value !== ed.original;
    dot.hidden = !dirty;
    dot.setAttribute('aria-hidden', String(!dirty));
    save.disabled = !dirty;
  };
  const sync = () => {
    pre.scrollTop = marks.scrollTop = ta.scrollTop;
    pre.scrollLeft = marks.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  };
  const caret = () => {
    // the end of a file has no line numbers of its own: line 1 here is not line 1 of the file
    if (readOnly && !ed.tail.whole) { where.textContent = ''; return; }
    const before = ta.value.slice(0, ta.selectionStart);
    const ln = before.split('\n').length;
    where.textContent = 'Line ' + ln + ', column ' + (before.length - before.lastIndexOf('\n'));
  };

  // The layers under the textarea stop where its scrollbar starts, or wrapped lines would fold
  // at different places in each.
  const layout = () => {
    const bar = (ta.offsetWidth - ta.clientWidth) + 'px';
    pre.style.right = marks.style.right = bar;
  };
  const setWrap = (on) => {
    code.toggleAttribute('data-wrap', on);
    box.toggleAttribute('data-nogutter', on || (readOnly && !ed.tail.whole));
    ta.wrap = on ? 'soft' : 'off';
    wrapBtn.setAttribute('aria-pressed', String(on));
    layout();
    sync();
  };
  wrapBtn.onclick = () => {
    filesWrap = !filesWrap;
    try { localStorage.setItem(FILES_WRAP_KEY, filesWrap ? '1' : '0'); } catch { /* not remembered */ }
    setWrap(filesWrap);
    reveal();
  };

  // Find: every match is marked in the layer under the text, and the one it stands on is scrolled
  // to. The marks are laid out exactly as the text is, so where a mark sits is where its match is,
  // wrapped or not.
  let hits = { starts: [], len: 0, capped: false };
  let at = -1;
  const say = () => {
    found.textContent = findWords(q.value, at, hits.starts.length, hits.capped);
    prev.disabled = next.disabled = hits.starts.length < 1;
  };
  function reveal() {
    const cur = marks.querySelector('mark.now');
    if (!cur) return;
    const top = cur.offsetTop;
    const left = cur.offsetLeft;
    if (top < ta.scrollTop + 8 || top > ta.scrollTop + ta.clientHeight - 48) ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
    if (left < ta.scrollLeft + 8 || left > ta.scrollLeft + ta.clientWidth - 80) ta.scrollLeft = Math.max(0, left - ta.clientWidth / 2);
    sync();
  }
  // `move` is off when the text changed under a search already made: the marks are counted again
  // and the view stays where the typing is, not carried off to the next match.
  const runFind = (from, move = true) => {
    hits = findAll(ta.value, q.value, FIND_CAP);
    if (!hits.starts.length) {
      at = -1;
      marks.textContent = '';
    } else {
      // the first match at or after where the reading is, so Find goes on from there
      at = hits.starts.findIndex((s) => s >= from);
      if (at < 0) at = move ? 0 : hits.starts.length - 1;
      marks.innerHTML = markMatches(ta.value, hits.starts, hits.len, at) + '\n ';
    }
    say();
    if (move) reveal(); else sync();
  };
  const step = (by) => {
    const n = hits.starts.length;
    if (!n) return;
    const all = marks.querySelectorAll('mark');
    if (all[at]) all[at].classList.remove('now');
    at = (at + by + n) % n;
    if (all[at]) all[at].classList.add('now');
    say();
    reveal();
  };
  let findTimer = 0;
  let findWaiting = null;
  const findNow = () => {
    clearTimeout(findTimer);
    const waiting = findWaiting;
    findWaiting = null;
    if (waiting && ta.isConnected) runFind(waiting.from(), waiting.move);
  };
  const findSoon = (from, move = true) => {
    clearTimeout(findTimer);
    findWaiting = { from, move };
    findTimer = setTimeout(findNow, 140);
  };
  q.addEventListener('input', () => findSoon(() => (at >= 0 ? hits.starts[at] : ta.selectionStart)));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // a search still waiting to run is run, and that lands on a match: no step past it
      if (findWaiting) findNow();
      else step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      // back to the text, on the match Find stands on; the next Escape is the tool's
      e.preventDefault();
      e.stopPropagation();
      if (at >= 0) ta.setSelectionRange(hits.starts[at], hits.starts[at] + hits.len);
      ta.focus({ preventScroll: true });
      caret();
    }
  });
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  // Ctrl+F, from anywhere in the file's own controls, is this Find and not the browser's
  const findKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
    e.preventDefault();
    // what is picked in the text is what to look for; pressed in the Find box itself, the words
    // already typed there stay
    const picked = document.activeElement === ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    if (picked && picked.length <= 200 && !picked.includes('\n')) q.value = picked;
    q.focus();
    q.select();
    if (q.value) runFind(ta.selectionStart);
  };
  for (const part of [bar, findRow, box]) part.addEventListener('keydown', findKey);
  say();

  ta.addEventListener('input', () => {
    ed.text = ta.value;
    paint();
    caret();
    if (q.value) {
      const stood = at >= 0 ? hits.starts[at] : 0;
      findSoon(() => stood, false);
    }
  });
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keyup', caret);
  ta.addEventListener('click', caret);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !readOnly && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    } else if (e.key === 'Escape') {
      // Out of the text, not out of the tool: the next Escape, from the buttons, closes it, and
      // the text stays as it is for when it opens again.
      e.preventDefault();
      e.stopPropagation();
      save.disabled || readOnly ? back.focus() : save.focus();
    }
  });
  box.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!save.disabled && !readOnly) save.click(); }
  });
  paint();
  caret();
  // As tall as the pane allows, measured rather than guessed: the pane's height follows the window.
  const pane = body.closest('.pane');
  const fit = () => {
    if (!box.isConnected) { ro.disconnect(); return; }
    const top = box.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    const pad = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    let h = Math.max(320, pane.clientHeight - top - foot.offsetHeight - 8 - pad);
    box.style.height = h + 'px';
    // Whatever margin that arithmetic missed shows up as the pane scrolling; take it back off.
    const over = pane.scrollHeight - pane.clientHeight;
    if (over > 0 && h - over >= 320) box.style.height = (h - over) + 'px';
    layout();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(pane);
  setWrap(filesWrap);
  fit();
  requestAnimationFrame(() => {
    ta.focus({ preventScroll: true });
    // the end of a log is what was asked for: start there
    if (readOnly && !ed.tail.whole) { ta.scrollTop = ta.scrollHeight; sync(); }
  });

  const leave = async () => {
    if (ta.value !== ed.original) {
      const ok = await ask({ title: 'Leave without saving?', text: 'Your changes to ' + ed.path.split('/').pop() + ' are not saved.', confirmLabel: 'Discard changes', danger: true });
      if (!ok) return false;
    }
    return true;
  };
  back.onclick = async () => {
    if (!(await leave())) return;
    view.editing = null;
    renderFiles({ force: true });
  };
  reload.onclick = async () => {
    if (!(await leave())) return;
    await openFile(row, view, ed.path);
  };
  dl.onclick = () => downloadPath(row, ed.path);

  /** The caret to the start of a line, scrolled to: where a save's complaint points. */
  const goToLine = (n) => {
    const lines = ta.value.split('\n');
    if (!(n >= 1 && n <= lines.length)) return;
    const at = lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(at, at + lines[n - 1].length);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (n - 1) * lineHeight - ta.clientHeight / 2);
    sync();
    caret();
  };

  const write = async (force) => {
    // the end of a file, or a picture, is not the file: there is nothing here to save over it
    if (readOnly) return;
    busy(save, true, 'Saving\u2026');
    try {
      const out = await post(base + '/write', { path: ed.path, text: ta.value, version: ed.version, force: force });
      ed.version = out.version;
      ed.original = ta.value;
      ed.text = ta.value;
      toast('Saved ' + ed.path.split('/').pop() + (out.snapshot ? '. The previous version is in Backups, and Activity can undo the change' : '')
        + (out.appliesOnRestart ? '; reload the plugin or restart the server to use it.' : '.'), 'good');
    } catch (e) {
      if (e.code === 'format') {
        // the complaint names a line where it can: the caret goes there, and stays if not saved
        const line = Number((/\bline (\d+)/i.exec(e.message) || [])[1]);
        if (line) goToLine(line);
        const ok = await ask({ title: 'Save it with a mistake in it?', text: e.message + '. Whatever reads this file may refuse to load it.', confirmLabel: 'Save anyway', danger: true });
        if (ok) { busy(save, false); return write(true); }
        if (line) goToLine(line);
      } else if (e.code === 'changed') {
        // Two ways on, and neither loses anything without saying so: saving over it keeps a copy
        // of what is there now, as every save does.
        const got = await ask({
          title: ed.path.split('/').pop() + ' changed on disk',
          text: 'Something else changed it after it was opened here.',
          choices: [
            { value: 'mine', label: 'Save mine over it', hint: 'What is on disk now is copied to Backups first.' },
            { value: 'theirs', label: 'Reload it', hint: 'What you typed here is lost.' },
          ],
          confirmLabel: 'Go on',
        });
        if (got && got.choice === 'theirs') { await openFile(row, view, ed.path); return; }
        if (got && got.choice === 'mine') {
          try {
            const now = await api(base + '/read?path=' + encodeURIComponent(ed.path));
            if (now.version) { ed.version = now.version; busy(save, false); return write(force); }
            toast('It could not be read again to save over it: ' + (now.reason === 'large' ? 'it is now too big to edit here.' : 'it is no longer text.'), 'bad');
          } catch (e2) { toast(e2.message, 'bad'); }
        }
      } else {
        toast(e.message, 'bad');
      }
    }
    busy(save, false);
    paint();
  };
  save.onclick = () => write(false);
}

