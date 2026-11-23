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

const tok = (cls, s) => s ? '<span class="hl-' + cls + '">' + escHtml(s) + '</span>' : '';

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

/** A picture, shown as it is: server-icon.png is the usual one. */
function renderFileImage(row, view) {
  const body = $('#filesBody');
  const ed = view.editing;
  const name = ed.path.split('/').pop();
  body.textContent = '';
  paneHead(body, 'file', name, ed.path);
  const bar = document.createElement('div');
  bar.className = 'fm-bar';
  const back = iconButton('folder', 'All files', 'ghost');
  const grow = document.createElement('span');
  grow.className = 'grow';
  const dl = iconButton('download', 'Download');
  bar.append(back, grow, dl);
  const frame = document.createElement('div');
  frame.className = 'fm-image';
  const img = document.createElement('img');
  img.alt = name;
  const said = document.createElement('div');
  said.className = 'fm-foot hint';
  said.setAttribute('role', 'status');
  img.onload = () => { said.textContent = img.naturalWidth + ' \u00d7 ' + img.naturalHeight + ' pixels'; };
  img.onerror = () => {
    frame.textContent = '';
    frame.append(emptyState('file', name + ' could not be shown: it is not a picture a browser can draw, or it is too big. Download it to look at it.'));
  };
  img.src = '/api/instances/' + encodeURIComponent(row.name) + '/files/image?path=' + encodeURIComponent(ed.path);
  frame.append(img);
  body.append(bar, frame, said);
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

  const bar = document.createElement('div');
  bar.className = 'fm-bar';
  const back = iconButton('folder', 'All files', 'ghost');
  const dot = document.createElement('span');
  dot.className = 'fm-dirty';
  dot.title = 'Unsaved changes';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'ghost';
  reload.textContent = 'Reload';
  const dl = iconButton('download', 'Download');
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = 'Save';
  bar.append(back, dot, grow, reload, dl, save);
  save.hidden = readOnly;
  body.append(bar);
  if (readOnly) {
    const partial = document.createElement('div');
    partial.className = 'hint';
    partial.style.marginBottom = 'var(--s-2)';
    partial.textContent = tailWords(ed.tail);
    body.append(partial);
  }

  // ---- find, and wrap -----------------------------------------------------------
  const findRow = document.createElement('div');
  findRow.className = 'fm-find';
  findRow.setAttribute('role', 'search');
  const q = document.createElement('input');
  q.type = 'search';
  q.placeholder = 'Find in this file';
  q.setAttribute('aria-label', 'Find in this file');
  q.dataset.kept = '1';
  const found = document.createElement('span');
  found.className = 'said';
  found.setAttribute('role', 'status');
  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'ghost';
  prev.textContent = 'Previous';
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'ghost';
  next.textContent = 'Next';
  const findGrow = document.createElement('span');
  findGrow.className = 'grow';
  const wrapBtn = document.createElement('button');
  wrapBtn.type = 'button';
  wrapBtn.className = 'ghost';
  wrapBtn.textContent = 'Wrap lines';
  wrapBtn.title = 'Fold long lines at the edge, so nothing runs off to the right';
  findRow.append(q, prev, next, found, findGrow, wrapBtn);
  body.append(findRow);

  const box = document.createElement('div');
  box.className = 'fm-editor';
  const gutter = document.createElement('div');
  gutter.className = 'fm-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  const code = document.createElement('div');
  code.className = 'fm-code' + (painted ? '' : ' plain');
  const pre = document.createElement('pre');
  pre.setAttribute('aria-hidden', 'true');
  const marks = document.createElement('pre');
  marks.className = 'fm-marks';
  marks.setAttribute('aria-hidden', 'true');
  const ta = document.createElement('textarea');
  ta.spellcheck = false;
  ta.wrap = 'off';
  ta.readOnly = readOnly;
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', ed.path + (readOnly ? ', read only' : ''));
  ta.value = ed.text;
  // matches first, so they are painted under the text
  code.append(marks, pre, ta);
  box.append(gutter, code);
  body.append(box);

  const foot = document.createElement('div');
  foot.className = 'fm-foot hint';
  const where = document.createElement('span');
  const how = document.createElement('span');
  how.textContent = readOnly
    ? 'Read only  ·  Ctrl+F finds'
    : LANG_NAMES[lang] + '  ·  Ctrl+S saves  ·  Ctrl+F finds  ·  Tab indents with spaces; Esc, then Tab, moves on';
  foot.append(where, how);
  body.append(foot);

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
    code.classList.toggle('wrap', on);
    box.classList.toggle('nogutter', on || (readOnly && !ed.tail.whole));
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

  const write = async (force) => {
    // the end of a file, or a picture, is not the file: there is nothing here to save over it
    if (readOnly) return;
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const out = await post(base + '/write', { path: ed.path, text: ta.value, version: ed.version, force: force });
      ed.version = out.version;
      ed.original = ta.value;
      ed.text = ta.value;
      toast('Saved ' + ed.path.split('/').pop() + (out.snapshot ? '. The previous version is in Backups' : '')
        + (out.appliesOnRestart ? '; reload the plugin or restart the server to use it.' : '.'), 'good');
    } catch (e) {
      if (e.code === 'format') {
        const ok = await ask({ title: 'Save it with a mistake in it?', text: e.message + '. Whatever reads this file may refuse to load it.', confirmLabel: 'Save anyway', danger: true });
        if (ok) { save.textContent = 'Save'; return write(true); }
      } else if (e.code === 'changed') {
        const ok = await ask({ title: ed.path.split('/').pop() + ' changed on disk', text: e.message + ' Reloading discards what you typed here; copy it first if you need it.', confirmLabel: 'Reload it', danger: true });
        if (ok) { await openFile(row, view, ed.path); return; }
      } else {
        toast(e.message, 'bad');
      }
    }
    save.textContent = 'Save';
    paint();
  };
  save.onclick = () => write(false);
}

