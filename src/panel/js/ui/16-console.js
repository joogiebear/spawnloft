'use strict';
// -------------------------------------------------------------- console ----

/**
 * What level a console line is.
 *
 * Paper does not have one log format, it has four, and all of them turn up in a single session:
 *
 *   Starting org.bukkit.craftbukkit.Main                          (before logging is configured)
 *   2026-08-31T05:42:27.5Z ServerMain WARN Advanced terminal...   (log4j, pre-init, no brackets)
 *   [00:42:27 INFO]: [bootstrap] Running Java 25 ...              (normal Paper)
 *   [12:34:56] [Server thread/INFO]: ...                          (vanilla-style, some forks)
 *
 * Plus stack traces, which are the whole reason anyone opens a console and which carry no level of
 * their own. A trace inherits the level of the line that introduced it - otherwise "filter to
 * errors" shows the one-line summary and hides the twenty lines saying what actually broke.
 */
const LEVEL_RE = /\[(?:[^\]]*[\/ ])?(INFO|WARN|WARNING|ERROR|SEVERE|FATAL|DEBUG|TRACE)\]/i;
const BARE_LEVEL_RE = /^\S+\s+\S+\s+(INFO|WARN|WARNING|ERROR|SEVERE|FATAL)\s/;
const CONT_RE = /^(?:\s+|at\s|Caused by:|Suppressed:|\.\.\.\s*\d+\s+more)/;
const EXC_RE = /^[a-z][\w.$]*(?:\.[A-Z][\w$]*)+(?::|\s*$)/;
const MCCTL_RE = /^\[(?:spawnloft|mcctl)\]/; // consoles written before the rename say [mcctl]

function levelOf(text, previous) {
  if (MCCTL_RE.test(text)) return 'sys';
  const m = LEVEL_RE.exec(text) || BARE_LEVEL_RE.exec(text);
  if (m) {
    const lvl = m[1].toUpperCase();
    if (lvl === 'ERROR' || lvl === 'SEVERE' || lvl === 'FATAL') return 'error';
    if (lvl === 'WARN' || lvl === 'WARNING') return 'warn';
    return 'info';
  }
  if (CONT_RE.test(text) || EXC_RE.test(text)) return previous === 'sys' ? 'info' : (previous || 'info');
  return 'info';
}

// The repeated scaffolding - timestamp, level, thread - is dimmed so the message leads. It is
// still there; it just stops competing with what you are reading.
const PREFIX_RE = /^(\[[^\]]*\](?:\s*\[[^\]]*\])?:?\s*)/;

/*
  How a line is drawn. The level is a rail in the gutter and a wash behind the line, not the colour
  of the whole line: a rail scans as well at a glance, and every line keeps full contrast. #log
  carries data-nowrap and data-nums, and the lines read them through the group.
*/
const LINE_CLASS = 'ln block border-l-[length:var(--spine)] border-l-transparent pr-5 pl-4 whitespace-pre-wrap break-words '
  + 'hover:bg-hover group-data-nowrap/log:w-max group-data-nowrap/log:min-w-full group-data-nowrap/log:break-normal '
  + 'group-data-nowrap/log:whitespace-pre group-data-nums/log:grid group-data-nums/log:grid-cols-[max-content_minmax(0,1fr)]';
const LEVEL_CLASS = {
  info: '',
  warn: 'warn border-l-warn bg-warn-wash hover:bg-warn-wash',
  error: 'error border-l-fault bg-fault-wash hover:bg-fault-wash',
  sys: 'sys border-l-accent text-ink-2',
};
const PREFIX_CLASS = { info: 'text-ink-4', warn: 'text-warn-ink', error: 'text-fault-ink', sys: 'text-accent' };
const NUM_CLASS = 'num hidden min-w-[4ch] pr-3 text-right text-ink-3 select-none group-data-nums/log:block';
const MARK_CLASS = 'rounded-xs bg-warn-edge text-warn-ink';
// a line someone was sent to ("Show in console"), ringed for a moment
const LINE_FOUND = ['outline', 'outline-2', '-outline-offset-2', 'outline-accent'];

function makeLine(entry) {
  const div = document.createElement('div');
  div.className = LINE_CLASS + (LEVEL_CLASS[entry.level] ? ' ' + LEVEL_CLASS[entry.level] : '');
  div.dataset.n = entry.n;
  const num = document.createElement('span');
  num.className = NUM_CLASS;
  num.textContent = entry.n;
  div.append(num);
  const txt = document.createElement('span');
  txt.className = 'txt';
  const pm = PREFIX_RE.exec(entry.text);
  const prefix = pm ? pm[1] : '';
  if (prefix) {
    const s = document.createElement('span');
    s.className = PREFIX_CLASS[entry.level] || PREFIX_CLASS.info;
    s.textContent = prefix;
    txt.append(s);
  }
  appendSearched(txt, pm ? entry.text.slice(prefix.length) : entry.text);
  div.append(txt);
  return div;
}

// Highlighting is built from text nodes and <mark>, never from innerHTML. A server name, a plugin
// message or a jar filename is not markup and must never get the chance to become it.
function appendSearched(parent, text) {
  const needle = state.search.toLowerCase();
  if (!needle) { parent.append(document.createTextNode(text)); return; }
  const hay = text.toLowerCase();
  let at = 0;
  for (;;) {
    const hit = hay.indexOf(needle, at);
    if (hit === -1) break;
    if (hit > at) parent.append(document.createTextNode(text.slice(at, hit)));
    const mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    mark.textContent = text.slice(hit, hit + needle.length);
    parent.append(mark);
    at = hit + needle.length;
  }
  if (at < text.length) parent.append(document.createTextNode(text.slice(at)));
}

function visible(entry) {
  if (state.filter === 'error' && entry.level !== 'error') return false;
  if (state.filter === 'warn' && entry.level !== 'warn' && entry.level !== 'error') return false;
  if (state.search && !entry.text.toLowerCase().includes(state.search.toLowerCase())) return false;
  return true;
}

/** The lines the view may draw: while paused, only those that had arrived when it was paused. */
function drawableLines() {
  return state.paused ? state.lines.slice(0, state.pausedAt) : state.lines;
}

/*
  How many warnings and errors the console holds, beside the filters that would show them.
  Counted by the line that raises one, not by every line of its stack trace: "Errors 1" for a
  twenty-line exception is the answer to "how many things went wrong".
*/
const levelCounts = { warn: 0, error: 0 };
const raisesLevel = (entry) => (entry.level === 'warn' || entry.level === 'error') && !CONT_RE.test(entry.text) && !EXC_RE.test(entry.text);

function updateCount(shown) {
  $('#nWarn').textContent = String(levelCounts.warn);
  $('#nErr').textContent = String(levelCounts.error);
  const lines = drawableLines();
  const total = lines.length;
  const count = shown == null ? lines.filter(visible).length : shown;
  const filtered = state.filter !== 'all' || Boolean(state.search);
  $('#conCount').textContent = filtered ? count + ' of ' + total + ' lines' : total + (total === 1 ? ' line' : ' lines');
  paintConNote();
}

/**
 * The line over the log that says why it is not moving. Paused comes first: it is the reader's
 * own doing and the one they can undo. Otherwise a server that is not running says that the lines
 * are from before it stopped, so old lines are never read as live ones.
 */
function paintConNote() {
  const note = $('#conNote');
  const row = rowOf(state.current);
  const text = note.querySelector('[data-note-text]');
  const action = note.querySelector('[data-note-action]');
  const glyph = note.querySelector('[data-note-icon]');
  let words = null;
  let act = null;
  if (state.paused) {
    const held = state.lines.length - state.pausedAt;
    words = held > 0 ? 'Paused · ' + held.toLocaleString() + (held === 1 ? ' new line' : ' new lines') + ' waiting' : 'Paused · new lines wait until you resume';
    act = { label: 'Resume', run: () => setPaused(false) };
    glyph.setAttribute('href', '#i-pause');
  } else if (row && !isDb(row) && state.lines.length && ['stopped', 'crashed'].includes(consolePhase(row))) {
    const crashed = consolePhase(row) === 'crashed';
    words = crashed ? 'Crashed · these are the last lines it wrote' : 'Stopped · these lines are from its last run';
    glyph.setAttribute('href', crashed ? '#i-alert' : '#i-stop');
  }
  // drawn only when it changes: this runs for every console line
  const key = words + '|' + (act ? act.label : '');
  if (note.dataset.key === key) return;
  note.dataset.key = key;
  note.hidden = !words;
  text.textContent = words || '';
  action.hidden = !act;
  action.textContent = act ? act.label : '';
  action.onclick = act ? act.run : null;
}

/**
 * Where the selected server is, in the console's words. "starting" is the panel's own: the core
 * says running as soon as the process exists, so it is a Start this panel asked for and has not
 * heard back from yet, as describeState says it in the header.
 */
function consolePhase(row) {
  if (!row) return null;
  if (state.acting === 'start' || state.acting === 'restart') return 'starting';
  if (state.acting === 'stop' || row.status === 'stopping') return 'stopping';
  if (crashedNow(row)) return 'crashed';
  return row.status;
}

/**
 * Nothing to show, said once and in the middle of the log rather than as one grey line at its
 * top: why there is nothing, and the one thing to do about it.
 */
function logStateFor(row, counts) {
  const { hasLines, shown } = counts;
  const label = row ? row.label || row.name : '';
  if (shown) return null;
  // paused before anything was drawn: the line over the log says what is waiting
  if (state.paused && state.lines.length) return null;
  if (hasLines) {
    return { icon: 'search', title: 'Nothing matches', text: 'No line shown has that in it. The log keeps the rest.', action: 'show-all' };
  }
  if (!row) return null;
  if (isDb(row) && row.external) return { icon: 'database', title: 'This database runs elsewhere', text: 'Its log is on the machine it runs on, not here.' };
  const status = consolePhase(row);
  if (status === 'starting') return { icon: 'terminal', busy: true, title: 'Starting ' + label + '…', text: 'Its first lines appear here in a moment.' };
  if (status === 'stopping') return { icon: 'terminal', busy: true, title: 'Stopping ' + label + '…', text: 'It is saving the world and closing down.' };
  if (status === 'running') {
    return state.cleared
      ? { icon: 'terminal', title: 'Cleared', text: 'New lines appear here as ' + label + ' writes them. The log file on disk is untouched.' }
      : { icon: 'terminal', title: 'Nothing written yet', text: 'New lines appear here as ' + label + ' writes them.' };
  }
  if (isDb(row)) return { icon: 'database', title: label + ' is stopped', text: 'Start the database and its log appears here as it runs.', action: 'start' };
  if (status === 'crashed') return { icon: 'alert', title: label + ' crashed', text: 'Start it again and its console appears here. Crash reports are in Files, under crash-reports.', action: 'start' };
  return { icon: 'terminal', title: label + ' is stopped', text: 'Start it and its console appears here as it runs. Commands can be sent once it is up.', action: 'start' };
}

function paintLogState(shown) {
  const box = $('#logState');
  const row = rowOf(state.current);
  if (shown == null) shown = $('#log').childElementCount;
  const want = logStateFor(row, { hasLines: drawableLines().length > 0, shown });
  const key = want ? [want.title, want.text, want.action, state.busy].join('|') : '';
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.textContent = '';
  box.hidden = !want;
  if (!want) return;
  const actions = [];
  if (want.action === 'show-all') {
    actions.push(Kit.button({ label: 'Show everything', onClick: () => { clearConsoleFilters(); $('#conSearch').focus(); } }));
  } else if (want.action === 'start' && !(row && row.external)) {
    actions.push(Kit.button({ label: isDb(row) ? 'Start database' : 'Start server', icon: 'play', kind: 'primary', disabled: state.busy, onClick: () => $('#bStart').click() }));
  }
  const panel = Kit.empty({ icon: want.icon, title: want.title, text: want.text, actions });
  panel.classList.add('log-empty', 'max-w-[480px]', 'p-0');
  if (want.busy) {
    // the title already says it is working; the spinner is only the picture of it
    const spin = Kit.spinner();
    spin.removeAttribute('role');
    spin.removeAttribute('aria-label');
    spin.setAttribute('aria-hidden', 'true');
    spin.classList.add('mb-2');
    panel.querySelector('.sl-ico')?.replaceWith(spin);
  }
  box.append(panel);
}

/** The search and the level back to everything. */
function clearConsoleFilters() {
  clearTimeout(searchTimer);
  $('#conSearch').value = '';
  state.search = '';
  setFilter('all');
}

function renderLog() {
  const log = $('#log');
  log.textContent = '';
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const entry of drawableLines()) {
    if (!visible(entry)) continue;
    frag.append(makeLine(entry));
    shown++;
  }
  log.append(frag);
  paintLogState(shown);
  updateCount(shown);
  if (state.atBottom) log.scrollTop = log.scrollHeight;
}

// The panel is a log reader, not a terminal. Strip formatting before classifying, searching
// or copying so an escape inside WARN cannot hide a warning. Keep indentation and Unicode.
const ANSI_STRING_RE = /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_]|\x90|\x9e|\x9f)[^\x1b\x9c]*(?:\x1b\\|\x9c|$)/g;
const ANSI_CSI_RE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)/g;
const ANSI_ESCAPE_RE = /\x1b[ -/]*[0-~]/g;
const LOG_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
function cleanConsoleText(text) {
  return text.replace(ANSI_STRING_RE, '').replace(ANSI_CSI_RE, '')
    .replace(ANSI_ESCAPE_RE, '').replace(LOG_CONTROL_RE, '');
}

function pushLine(text) {
  text = cleanConsoleText(text);
  const prev = state.lines.length ? state.lines[state.lines.length - 1].level : null;
  const entry = { text: text, level: levelOf(text, prev), n: ++state.seq };
  state.lines.push(entry);
  if (raisesLevel(entry)) levelCounts[entry.level]++;
  updateConsoleBadge();
  state.cleared = false;

  // A busy server writes thousands of lines a minute. Without a ceiling the panel keeps a DOM node
  // per line until the window stops responding - a bug that only appears after someone has left it
  // open for an afternoon, which is exactly the session this tool is for.
  const log = $('#log');
  while (state.lines.length > MAX_LINES) {
    const gone = state.lines.shift();
    if (raisesLevel(gone)) {
      levelCounts[gone.level]--;
      if (gone.level === 'error' && state.errorsSeen > 0) state.errorsSeen--;
    }
    if (state.pausedAt > 0) state.pausedAt--;
    // Only drop a node if that line had one: with a filter on, most lines never reached the DOM.
    if (log.firstElementChild && log.firstElementChild.dataset.n === String(gone.n)) log.firstElementChild.remove();
  }

  if (state.paused || !visible(entry)) {
    // an empty view may now be empty for another reason: paused with lines waiting, or a filtered
    // view the cap has just emptied
    if (!log.childElementCount) paintLogState(0);
    updateCount();
    return;
  }

  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(makeLine(entry));
  if (!$('#logState').hidden) paintLogState();
  if (atBottom) log.scrollTop = log.scrollHeight;
  else { state.unseen++; paintJump(); }
  updateCount();
}

function clearLines() {
  state.lines = [];
  state.seq = 0;
  state.cleared = false;
  state.errorsSeen = 0;
  levelCounts.warn = 0;
  levelCounts.error = 0;
  updateConsoleBadge();
}

function stopStream() {
  if (state.stream) state.stream.close();
  state.stream = null;
  state.streamName = null;
}

/** What the question says before unsaved Settings changes are left behind for another server. */
function leaveSettingsWords(waiting, label) {
  const n = waiting.count;
  return {
    title: 'Leave ' + label + ' without saving?',
    text: (n === 1 ? '1 change' : n + ' changes') + ' in its Settings ' + (n === 1 ? 'has' : 'have') + ' not been saved, and will be lost.',
    confirmLabel: n === 1 ? 'Discard the change' : 'Discard the changes',
    danger: true,
  };
}

function select(name, { discard = false, then = null } = {}) {
  if (state.current === name && state.view === 'server' && state.streamName === name) { if (then) then(); return; }
  // Settings is one form per page, drawn for one server. Choosing another draws it again, so
  // whatever is typed and not saved is asked about first. The question is the only async step:
  // the choice is made again, for real, once it is answered.
  const waiting = settingsWaiting();
  if (waiting && waiting.name !== name && !discard) {
    const left = rowOf(waiting.name);
    // `then` is what the caller wanted done once the server is open, a tool to show for one. It
    // waits for the answer with the choice, and is dropped with it.
    ask(leaveSettingsWords(waiting, (left && left.label) || waiting.name)).then((ok) => { if (ok) select(name, { discard: true, then }); });
    return;
  }
  sheetStack.length = 0;
  state.current = name;
  clearLines();
  state.paused = false;
  state.pausedAt = 0;
  state.atBottom = true;
  state.errorsSeen = 0;
  if (!state.histories.has(name)) state.histories.set(name, []);
  state.history = state.histories.get(name);
  state.histAt = state.history.length;
  state.draft = '';
  state.unseen = 0;
  state.search = '';
  setPauseButton(false);
  $('#conSearch').value = '';
  $('#bJump').hidden = true;
  setFilter('all');

  stopStream();
  show('server');
  // The settings pane caches which server it drew, so a different one must not inherit it. Coming
  // back to the same server with changes waiting keeps the form those changes are in.
  if (!waiting || waiting.name !== name) $('#settingsBody').dataset.for = '';
  $('#backupsBody').dataset.for = '';
  $('#schedulerBody').dataset.for = '';
  $('#playersBody').dataset.for = '';
  $('#pluginsBody').dataset.for = '';
  $('#worldsBody').dataset.for = '';
  $('#performanceBody').dataset.for = '';
  $('#srvDiag').textContent = '';
  diagKey = '';
  const chosen = rowOf(name);
  renderServer(chosen);
  // From now, not from the next poll: a Start pressed in the seconds between is a change too.
  if (chosen) followFrom(chosen);
  const saved = recallTool(name);
  setTool(saved.tool);
  renderLog();
  renderList(state.rows, state.dbs);
  $('#list [data-name="' + CSS.escape(name) + '"]')?.scrollIntoView({ block: 'nearest' });
  startVitals(name);

  // Server-Sent Events rather than polling: the console is a stream by nature, and the browser
  // reconnects on its own if the panel is left open while a server restarts.
  const stream = new EventSource('/api/instances/' + encodeURIComponent(name) + '/stream');
  state.stream = stream;
  state.streamName = name;
  stream.onmessage = (e) => {
    if (state.streamName !== name) return;
    let line;
    try { line = JSON.parse(e.data); } catch { return; }
    pushLine(line);
  };
  // The server replays the last 200 lines on every connection, so a dropped stream would otherwise
  // paste them in a second time and make it look like the server repeated itself. Clearing on
  // reconnect keeps the console honest about what actually happened.
  stream.onerror = () => {
    if (state.streamName !== name || stream.readyState !== EventSource.CONNECTING) return;
    clearLines();
    state.pausedAt = 0;
    renderLog();
  };
  if (then) then();
  refresh();
}

