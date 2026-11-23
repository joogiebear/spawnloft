'use strict';
// ------------------------------------------------------ console controls ----

function setFilter(level) {
  state.filter = level;
  for (const b of $$('.seg [data-lvl]')) b.setAttribute('aria-pressed', String(b.dataset.lvl === level));
  renderLog();
}

for (const b of $$('.seg [data-lvl]')) b.onclick = () => setFilter(b.dataset.lvl);

let searchTimer = null;
$('#conSearch').oninput = (e) => {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = value.trim(); renderLog(); }, 120);
};

/** The pause button is an icon; its name and its glyph say which it will do next. */
function setPauseButton(paused) {
  const b = $('#bPause');
  const label = paused ? 'Resume' : 'Pause';
  b.setAttribute('aria-pressed', String(paused));
  b.setAttribute('aria-label', label);
  b.title = label;
  b.querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
}

$('#bPause').onclick = () => {
  state.paused = !state.paused;
  setPauseButton(state.paused);
  if (state.paused) {
    state.pausedAt = state.lines.length;
  } else {
    state.pausedAt = 0;
    state.atBottom = true;
    renderLog();
  }
  updateCount();
};

// Wrapped by default: unwrapped, the first line of every JVM start ran off the edge mid-flag.
// Remembered either way, like line numbers.
const WRAP_KEY = 'mcctl.wrap';
function setWrap(on, { remember = true } = {}) {
  state.wrap = on;
  $('#log').classList.toggle('nowrap', !on);
  $('#bWrap').setAttribute('aria-pressed', String(on));
  if (remember) try { localStorage.setItem(WRAP_KEY, on ? '1' : '0'); } catch {}
}
$('#bWrap').onclick = () => setWrap(!state.wrap);
let wrapSaved = null;
try { wrapSaved = localStorage.getItem(WRAP_KEY); } catch {}
setWrap(wrapSaved !== '0', { remember: false });

const NUMS_KEY = 'mcctl.nums';
function setNums(on, { remember = true } = {}) {
  state.nums = on;
  $('#log').classList.toggle('nums', on);
  $('#bNums').setAttribute('aria-checked', String(on));
  if (!remember) return;
  try { localStorage.setItem(NUMS_KEY, on ? '1' : '0'); } catch {}
}

$('#bNums').onclick = () => { setNums(!state.nums); shareMenu.close({ refocus: true }); };

try { setNums(localStorage.getItem(NUMS_KEY) === '1', { remember: false }); } catch {}

$('#bCopy').onclick = async () => {
  const shown = state.lines.filter(visible);
  if (!shown.length) { toast('Nothing to copy.', 'bad'); return; }
  const text = shown.map((l) => l.text).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied ' + shown.length + (shown.length === 1 ? ' line.' : ' lines.'), 'good');
  } catch {
    // Clipboard access can be refused; a hidden selection still gets the text out.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    toast(ok ? 'Copied.' : 'Could not reach the clipboard.', ok ? 'good' : 'bad');
  }
};

// Clears the VIEW, not the log on disk. Said out loud, because a Clear button next to a server
// console could reasonably be read as destructive.
$('#bClear').onclick = () => {
  shareMenu.close({ refocus: true });
  clearLines();
  state.pausedAt = 0;
  state.atBottom = true;
  renderLog();
  toast('Console view cleared. The log file on disk is untouched.');
};

/**
 * A button that opens a menu under it: Share log, and the "⋯" beside Start and Stop.
 *
 * <p>Keyboard first. The arrows move between items and open the menu from its button, Home and
 * End jump to the ends, Escape closes it and puts focus back on the button, and Tab leaves - a
 * menu that has to be dismissed before you can move on is a trap. `build` fills it at the moment
 * it opens, for a menu whose items depend on the server's state.
 */
function bindMenu(button, menu, { build } = {}) {
  const wrap = button.closest('.menu-wrap');
  let open = false;
  const items = () => Array.from(menu.querySelectorAll('[role^="menuitem"]')).filter((b) => !b.disabled);

  const close = ({ refocus = false } = {}) => {
    if (!open) return;
    open = false;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  const show = () => {
    if (open) return;
    if (build) build();
    open = true;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    const first = items()[0];
    if (first) first.focus();
  };

  button.onclick = () => (open ? close({ refocus: true }) : show());

  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      close({ refocus: true });
      return;
    }
    if (!open) {
      if (e.target === button && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); show(); }
      return;
    }
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1 + list.length) % list.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
    else if (e.key === 'Tab') close();
  });

  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) close();
  });

  document.addEventListener('pointerdown', (e) => {
    if (open && !wrap.contains(e.target)) close();
  });

  return { close };
}

const shareMenu = bindMenu($('#bExport'), $('#exportMenu'));
const moreMenu = bindMenu($('#bManage'), $('#moreMenu'), { build: buildMoreMenu });

function consolePath(verb) {
  return '/instances/' + encodeURIComponent(state.current) + '/console/' + verb;
}

$('#miExportFile').onclick = async () => {
  shareMenu.close({ refocus: true });
  if (!state.current) { toast('Select a server first.', 'bad'); return; }
  const note = toast('Saving the console…');
  try {
    const out = await post(consolePath('export'));
    note.remove();
    toast('Exported ' + out.lines.toLocaleString() + (out.lines === 1 ? ' line' : ' lines')
      + ' to ' + out.file + ' (' + out.sizeHuman + ').', 'good');
  } catch (err) {
    note.remove();
    toast(err.message, 'bad');
  }
};

$('#bDiagZip').onclick = async () => {
  if (!state.current) { toast('Select a server first.', 'bad'); return; }
  const btn = $('#bDiagZip');
  btn.disabled = true;
  const note = toast('Writing the diagnostics zip…');
  try {
    const out = await post('/instances/' + encodeURIComponent(state.current) + '/diag');
    note.remove();
    const basename = out.file.split(/[\\/]/).pop();
    const el = toast('Diagnostics zip written (' + out.sizeHuman + '). ', 'good', { stay: true });
    const a = document.createElement('a');
    a.href = '/api/instances/' + encodeURIComponent(state.current) + '/diag/download?file=' + encodeURIComponent(basename);
    a.textContent = 'Download';
    a.download = '';
    el.querySelector('div').append(a);
    // The download starts without waiting for the link to be clicked; the link stays for a
    // second copy.
    a.click();
  } catch (err) {
    note.remove();
    toast(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
};

$('#miExportShare').onclick = async () => {
  shareMenu.close({ refocus: true });
  if (!state.current) { toast('Select a server first.', 'bad'); return; }
  const ok = await ask({
    title: 'Upload this console to mclo.gs?',
    // Only what is documented. mclo.gs's own policy promises IP removal, best effort, and
    // deletion 90 days after the log was last opened - nothing about player names or paths.
    // spawnloft takes the account name out of paths itself before sending; the rest goes as is.
    text: 'The log is published at a public link that anyone holding it can read. Before sending, '
      + 'SpawnLoft replaces your account name in file paths. mclo.gs removes IP addresses on its side, '
      + 'best effort, and deletes the log 90 days after it was last opened. Player names, plugin '
      + 'output and everything else stay in - read it over first. The delete token is kept in '
      + 'run/mclogs.json so the log can be taken down later.',
    confirmLabel: 'Upload and open',
  });
  if (!ok) return;
  const note = toast('Uploading to mclo.gs…');
  try {
    const out = await post(consolePath('share'));
    note.remove();
    openOutside(out.url);
    toast(out.trimmed
      ? 'Uploaded the last ' + out.lines.toLocaleString() + ' lines — ' + out.url
      : 'Uploaded — ' + out.url, 'good', { stay: true });
  } catch (err) {
    note.remove();
    toast(err.message, 'bad');
  }
};

/** The jump pill, with how many lines arrived below the fold since the reader scrolled up. */
function paintJump() {
  if (state.atBottom) state.unseen = 0;
  $('#bJump').hidden = state.atBottom;
  $('#jumpLabel').textContent = state.unseen
    ? 'Jump to latest · ' + state.unseen.toLocaleString() + ' new'
    : 'Jump to latest';
}

$('#log').addEventListener('scroll', () => {
  const log = $('#log');
  state.atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  paintJump();
});

$('#bJump').onclick = () => {
  const log = $('#log');
  state.atBottom = true;
  log.scrollTop = log.scrollHeight;
  paintJump();
};

